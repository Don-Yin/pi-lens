/**
 * Shared runner utilities for pi-lens dispatch system
 *
 * Extracted common patterns from multiple runners to reduce duplication:
 * - Venv-aware command finders
 * - Availability checkers with caching
 * - Config file finders
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logSessionStart } from "../../../sessionstart-logger.js";
import { getGlobalPiLensDir } from "../../../file-utils.js";
import { PathKeyedMap } from "../../../path-keyed-map.js";
import {
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "../../../path-utils.js";
import {
	ensureTool,
	isSpawnableCommand,
	resetPathWalkMemo,
} from "../../../installer/index.js";
import {
	getServersForFileWithConfig,
	isServerDisabled,
} from "../../../lsp/config.js";
import { findGlobalBinary } from "../../../package-manager.js";
import { safeSpawnAsync } from "../../../safe-spawn.js";
import {
	getToolCommandSpec,
	shouldAutoInstallTool,
} from "../../../tool-policy.js";
import type { DispatchContext } from "../../types.js";

/**
 * True when the LSP runner will cover `ctx.filePath` via the given PRIMARY server
 * id. Used by CLI runners that duplicate a linter a warm LSP already wraps
 * (taplo↔`toml` LSP = `taplo lsp`; shellcheck↔`bash` LSP runs shellcheck
 * internally) so they SELF-SKIP and stop double-reporting the same findings (#233)
 * — the same dormant-when-LSP-covers pattern the ast-grep napi runner uses.
 *
 * Non-spawning and conservative: honors the `no-lsp` kill switch + per-server
 * disable/config, and only matches when this server is the SELECTED primary for
 * the file (first non-auxiliary candidate). The caller additionally gates on tool
 * availability, so coverage never regresses when the LSP is absent/disabled.
 */
export function lspPrimaryCoversFile(
	ctx: DispatchContext,
	serverId: string,
): boolean {
	if (ctx.pi?.getFlag?.("no-lsp")) return false;
	if (isServerDisabled(serverId, ctx.filePath)) return false;
	const primary = getServersForFileWithConfig(ctx.filePath).find(
		(s) => s.role !== "auxiliary",
	);
	return primary?.id === serverId;
}

/**
 * Walk up from startDir until we find a directory containing node_modules/.bin.
 * Returns all such roots found up to the filesystem root — not just the nearest —
 * so callers can search them all for a specific binary.
 */
function findNodeBinRoots(startDir: string): string[] {
	const roots: string[] = [];
	let current = startDir;
	const fsRoot = path.parse(current).root;
	while (current !== fsRoot) {
		if (fs.existsSync(path.join(current, "node_modules", ".bin"))) {
			roots.push(current);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

let _thisDir = path.dirname(fileURLToPath(import.meta.url));
if (typeof __dirname !== "undefined") {
	_thisDir = __dirname;
}

// Managed tools directory (~/.pi-lens/tools) — where ensureTool() installs binaries
const _managedToolsDir = path.join(getGlobalPiLensDir(), "tools");

// =============================================================================
// VENV-AWARE COMMAND FINDER
// =============================================================================

export interface VenvPathConfig {
	unixPaths: string[];
	windowsPaths: string[];
	quoteWindowsPaths?: boolean;
}

/**
 * Find a command in venv first, then fall back to global.
 * Checks common venv locations (.venv, venv) before trying global.
 */
export function createVenvFinder(
	command: string,
	windowsExt = "",
	quoteWindows = false,
): (cwd: string) => string {
	return (cwd: string): string => {
		const venvPaths = [
			`.venv/bin/${command}`,
			`venv/bin/${command}`,
			`.venv/Scripts/${command}${windowsExt}`,
			`venv/Scripts/${command}${windowsExt}`,
		];

		for (const venvPath of venvPaths) {
			const fullPath = path.join(cwd, venvPath);
			if (fs.existsSync(fullPath)) {
				return quoteWindows && windowsExt ? `"${fullPath}"` : fullPath;
			}
		}

		// Fall back to global
		return command;
	};
}

// =============================================================================
// AVAILABILITY CHECKER FACTORY
// =============================================================================

export type AvailabilityOutcome =
	| "success"
	| "missing"
	| "transient"
	| "non-installable";

export type ClientAvailabilityResult<T> =
	| { outcome: "success"; value: T }
	| { outcome: Exclude<AvailabilityOutcome, "success">; value?: undefined };

/** Typed client-facing install seam for ordered/custom candidate probes. */
export async function resolveManagedToolClient<T>(options: {
	toolId: string;
	cwd: string;
	probe: () => Promise<ClientAvailabilityResult<T>>;
	acceptInstalled: (path: string) => Promise<T | null> | T | null;
}): Promise<ClientAvailabilityResult<T>> {
	const probed = await options.probe();
	if (probed.outcome !== "missing") return probed;
	if (!shouldAutoInstallTool(options.toolId)) return probed;
	const state = installStateFor(options.cwd, options.toolId);
	if (state.suppressed) return probed;
	const installed = await ensureTool(options.toolId);
	if (!installed) {
		noteInstallFailure(options.toolId, options.cwd);
		return probed;
	}
	const value = await options.acceptInstalled(installed);
	if (value === null) {
		noteInstallFailure(options.toolId, options.cwd);
		return { outcome: "non-installable" };
	}
	noteInstallSuccess(options.toolId, options.cwd);
	return { outcome: "success", value };
}

type AvailabilityCache = {
	available: boolean | null;
	command: string | null;
	outcome: AvailabilityOutcome | null;
};

export interface AvailabilityCheckerOptions {
	probeTimeout?: number;
	fastPath?: () => string | null;
	/** Environment used by both the availability probe and later client spawns. */
	environment?: (cwd: string) => Promise<NodeJS.ProcessEnv>;
	/** Compatibility for legacy probes whose test doubles carry no failure kind. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
}

/**
 * Child environment for managed-installable tools. Keeping this beside the
 * probe/install seam makes managed npm shims visible to every standalone
 * client, rather than only to Knip (#1289).
 */
export async function getManagedToolEnvironment(
	_toolId: string,
	cwd?: string,
): Promise<NodeJS.ProcessEnv> {
	let env: NodeJS.ProcessEnv;
	try {
		const { getToolEnvironment } = await import("../../../installer/index.js");
		env = await getToolEnvironment();
	} catch {
		// Installer-isolated unit tests historically mock only ensureTool. The
		// ambient fallback preserves that isolation; production always exports it.
		env = { ...process.env };
	}
	if (!cwd) return env;
	const separator = process.platform === "win32" ? ";" : ":";
	const currentPath = env.PATH || env.Path || process.env.PATH || "";
	const localBin = path.join(cwd, "node_modules", ".bin");
	const augmentedPath = `${localBin}${separator}${currentPath}`;
	return {
		...env,
		PATH: augmentedPath,
		...(process.platform === "win32" ? { Path: augmentedPath } : {}),
	};
}

/** Read-only managed/PATH discovery for spawn-time resolution memos. */
export async function discoverManagedTool(toolId: string): Promise<string | null> {
	return (await ensureTool(toolId, { allowInstall: false })) ?? null;
}

type InstallAttemptState = {
	attempts: number;
	suppressed: boolean;
};

// This is session-scoped state, not a process-global tool/path cache. The cwd
// key is normalized by PathKeyedMap and is cleared at session_start. A failed
// install must not become an install attempt on every eligible file/turn.
const installAttemptsByCwd = new PathKeyedMap<Map<string, InstallAttemptState>>(
	normalizeMapKey,
);
const resolveInstallInFlightByCwd = new PathKeyedMap<
	Map<string, Promise<string | null>>
>(normalizeEphemeralMapKey);
// Checkers are created by runner modules and may also be created dynamically.
// Keep the session reset as a generation rather than retaining every checker
// reset closure forever.
let availabilityStateGeneration = 0;

function installStateFor(cwd: string, toolId: string): InstallAttemptState {
	let states = installAttemptsByCwd.get(cwd);
	if (!states) {
		states = new Map();
		installAttemptsByCwd.set(cwd, states);
	}
	let state = states.get(toolId);
	if (!state) {
		state = { attempts: 0, suppressed: false };
		states.set(toolId, state);
	}
	return state;
}

function noteInstallFailure(toolId: string, cwd: string): void {
	const state = installStateFor(cwd, toolId);
	state.attempts += 1;
	state.suppressed = true;
	logSessionStart(
		`dispatch availability ${toolId}: install attempt ${state.attempts} failed; suppressing retries until the next session or a successful install`,
	);
}

function noteInstallSuccess(toolId: string, cwd: string): void {
	const states = installAttemptsByCwd.get(cwd);
	states?.delete(toolId);
	if (states?.size === 0) installAttemptsByCwd.delete(cwd);
}

/** Reset availability/install suppression at the session boundary. */
export function resetDispatchAvailabilityState(): void {
	installAttemptsByCwd.clear();
	resolveInstallInFlightByCwd.clear();
	resetPathWalkMemo();
	availabilityStateGeneration += 1;
}

/**
 * Create a cached availability checker for a command.
 * The checker will look for the command in venv first, then global.
 *
 * `versionArgs` defaults to `["--version"]` but some tools reject that flag and
 * expose version under a subcommand instead (e.g. `zig version`, not
 * `zig --version`). Passing the wrong probe makes the runner silently skip on
 * every machine, so toolchains with a non-standard version command must override
 * this.
 */
export function createAvailabilityChecker(
	command: string,
	windowsExt = "",
	versionArgs: string[] = ["--version"],
	options: AvailabilityCheckerOptions = {},
): {
	isAvailableAsync: (cwd?: string) => Promise<boolean>;
	getCommand: (cwd?: string) => string | null;
	getOutcome: (cwd?: string) => AvailabilityOutcome | null;
	reset: () => void;
} {
	const cacheByCwd = new PathKeyedMap<AvailabilityCache>(
		normalizeEphemeralMapKey,
	);
	const inFlightByCwd = new PathKeyedMap<Promise<boolean>>(
		normalizeEphemeralMapKey,
	);
	let checkerGeneration = availabilityStateGeneration;

	const findCommand = createVenvFinder(command, windowsExt, true);

	function ensureCurrentGeneration(): void {
		if (checkerGeneration === availabilityStateGeneration) return;
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityStateGeneration;
	}

	const reset = (): void => {
		cacheByCwd.clear();
		inFlightByCwd.clear();
		checkerGeneration = availabilityStateGeneration;
	};

	function getCache(cwd: string): AvailabilityCache {
		ensureCurrentGeneration();
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const created: AvailabilityCache = {
			available: null,
			command: null,
			outcome: null,
		};
		cacheByCwd.set(key, created);
		return created;
	}

	async function isAvailableAsync(cwd?: string): Promise<boolean> {
		ensureCurrentGeneration();
		const resolvedCwd = cwd || process.cwd();
		const cache = getCache(resolvedCwd);
		if (cache.available === false) return false;
		if (cache.available === true && cache.command) {
			if (await isSpawnableCommand(cache.command)) return true;
			// Cached-positive spawn feedback: a removed absolute path or vanished
			// PATH command must fall through to a fresh probe immediately.
			cache.available = null;
			cache.command = null;
			cache.outcome = null;
		}

		const key = path.resolve(resolvedCwd);
		const existing = inFlightByCwd.get(key);
		if (existing) return existing;

		const promiseGeneration = checkerGeneration;
		let promise: Promise<boolean>;
		promise = (async () => {
			const fastPath = options.fastPath?.();
			if (fastPath) {
				cache.available = true;
				cache.outcome = "success";
				cache.command = fastPath;
				return true;
			}

			// A bad/removed workspace must not be mistaken for a missing tool and
			// trigger an install. This async probe stays off the synchronous dispatch
			// burst and makes the failure taxonomy explicit at the seam.
			try {
				const cwdStat = await fs.promises.stat(resolvedCwd);
				if (!cwdStat.isDirectory()) {
					cache.available = false;
					cache.outcome = "non-installable";
					return false;
				}
			} catch {
				cache.available = false;
				cache.outcome = "non-installable";
				return false;
			}

			const cmd = findCommand(resolvedCwd);
			const env = await options.environment?.(resolvedCwd);
			const result = await safeSpawnAsync(cmd, versionArgs, {
				timeout: options.probeTimeout ?? 5000,
				cwd: resolvedCwd,
				env,
			});

			if (!result.error && result.status === 0) {
				cache.available = true;
				cache.outcome = "success";
				cache.command = cmd;
				return true;
			}

			cache.available = false;
			if (result.failure === "tool-not-found") {
				resetPathWalkMemo();
				cache.outcome = "missing";
			} else if (
				result.failure === "timeout" ||
				result.failure === "aborted" ||
				result.failure === "signal" ||
				result.failure === "spawn-rejected"
			) {
				cache.outcome = "transient";
			} else {
				// A present command that rejects its version probe (or an EACCES/
				// EINVAL/UNKNOWN failure) is not repaired by reinstalling it.
				cache.outcome =
					options.unclassifiedFailureOutcome ?? "non-installable";
			}
			return false;
		})().finally(() => {
			// A session reset clears this map and a caller may immediately start a
			// replacement probe for the same cwd. The old promise must not delete
			// that newer-generation entry when it settles.
			if (
				checkerGeneration === promiseGeneration &&
				inFlightByCwd.get(key) === promise
			) {
				inFlightByCwd.delete(key);
			}
		});
		inFlightByCwd.set(key, promise);
		return promise;
	}

	function getCommand(cwd?: string): string | null {
		ensureCurrentGeneration();
		const cache = getCache(cwd || process.cwd());
		return cache.command;
	}

	function getOutcome(cwd?: string): AvailabilityOutcome | null {
		ensureCurrentGeneration();
		return getCache(cwd || process.cwd()).outcome;
	}

	return { isAvailableAsync, getCommand, getOutcome, reset };
}

/**
 * Per-cwd cached availability probe for spawn signatures that don't fit
 * `createAvailabilityChecker` — multi-arg subcommands like `npx biome
 * --version`, `cargo clippy --version`, `mix credo --version`, or a
 * dynamically-resolved `<cmd> --version`. Each cwd is probed at most once;
 * concurrent first-time callers share the in-flight promise.
 *
 * The cache stores the boolean outcome forever (same shape as
 * `createAvailabilityChecker`): once known unavailable for a cwd, the
 * runner stays skipped for that cwd until the process restarts. Pass a
 * fresh probe for retry-after-install flows.
 */
export function createCwdCachedProbe(
	probe: (cwd: string) => Promise<boolean>,
): (cwd: string) => Promise<boolean> {
	const cacheByCwd = new PathKeyedMap<Promise<boolean>>(
		normalizeEphemeralMapKey,
	);
	let probeGeneration = availabilityStateGeneration;
	return (cwd: string) => {
		if (probeGeneration !== availabilityStateGeneration) {
			cacheByCwd.clear();
			probeGeneration = availabilityStateGeneration;
		}
		const key = path.resolve(cwd || process.cwd());
		const existing = cacheByCwd.get(key);
		if (existing) return existing;
		const promise = probe(key).catch(() => false);
		cacheByCwd.set(key, promise);
		return promise;
	};
}

export function resolveNodeToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".cmd",
): string {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return local;
	return toolName;
}

export function resolveToolCommand(cwd: string, toolId: string): string | null {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveNodeToolCommand(cwd, spec.command, spec.windowsExt ?? ".cmd");
}

export function resolveVendorToolCommand(
	cwd: string,
	toolName: string,
	windowsExt = ".bat",
): string | null {
	const isWin = process.platform === "win32";
	const candidates = isWin
		? [
				path.join("vendor", "bin", `${toolName}${windowsExt}`),
				path.join("vendor", "bin", toolName),
			]
		: [path.join("vendor", "bin", toolName)];
	let dir = cwd;
	const root = path.parse(dir).root;
	while (true) {
		for (const candidate of candidates) {
			const full = path.join(dir, candidate);
			if (fs.existsSync(full)) return full;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export async function resolveToolCommandWithInstallFallback(
	cwd: string,
	toolId: string,
	timeout = 5000,
): Promise<string | null> {
	const spec = getToolCommandSpec(toolId);
	if (!spec) return null;
	return resolveCommandWithInstallFallback(
		resolveToolCommand(cwd, toolId) ?? spec.command,
		spec.managedToolId ?? toolId,
		cwd,
		spec.versionArgs ?? ["--version"],
		timeout,
	);
}

async function verifyOrInstallCommand(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<string | null> {
	// Skip the --version spawn when the command isn't even on disk — the ~μs
	// stat/PATH walk beats a guaranteed-to-fail spawn round-trip.
	const spawnable = await isSpawnableCommand(command);
	if (spawnable) {
		const versionCheck = await safeSpawnAsync(command, versionArgs, {
			timeout,
			cwd,
		});
		if (!versionCheck.error && versionCheck.status === 0) {
			return command;
		}
		// A command that was found but rejected its probe is not fixed by a
		// reinstall. This also covers permissions and malformed shims.
		return null;
	}
	if (!shouldAutoInstallTool(toolId)) return null;

	const state = installStateFor(cwd, toolId);
	if (state.suppressed) return null;
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		return installed;
	}
	noteInstallFailure(toolId, cwd);
	return null;
}

export async function resolveCommandArgsWithInstallFallback(
	command: { cmd: string; args: string[] },
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<{ cmd: string; args: string[] } | null> {
	const versionCheck = await safeSpawnAsync(
		command.cmd,
		[...command.args, ...versionArgs],
		{ timeout, cwd },
	);
	if (!versionCheck.error && versionCheck.status === 0) {
		return command;
	}
	const installed = await verifyOrInstallCommand(
		command.cmd,
		toolId,
		cwd,
		versionArgs,
		timeout,
	);
	if (!installed) {
		return null;
	}
	if (installed === command.cmd) {
		return command;
	}
	return { cmd: installed, args: [] };
}

export async function resolveCommandWithInstallFallback(
	command: string,
	toolId: string,
	cwd: string,
	versionArgs: string[] = ["--version"],
	timeout = 5000,
): Promise<string | null> {
	return verifyOrInstallCommand(command, toolId, cwd, versionArgs, timeout);
}

async function resolveAvailableOrInstallUnshared(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
		getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
		reset?: () => void;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const available = await checker.isAvailableAsync(cwd);
	if (available) {
		return checker.getCommand(cwd);
	}
	// Only a typed ENOENT/missing-command result is repairable by installing.
	// Probe failures caused by bad cwd, permissions, rejected flags, aborts, and
	// timeouts are unavailable/non-installable and must not enter an install loop.
	if (checker.getOutcome?.(cwd) !== "missing") return null;
	if (!shouldAutoInstallTool(toolId)) return null;

	const state = installStateFor(cwd, toolId);
	if (state.suppressed) {
		return null;
	}
	const installed = await ensureTool(toolId);
	if (installed) {
		noteInstallSuccess(toolId, cwd);
		checker.reset?.();
		return installed;
	}
	noteInstallFailure(toolId, cwd);
	return null;
}

/** Share the complete probe/install transaction for each cwd/tool pair. */
export function resolveAvailableOrInstall(
	checker: {
		isAvailableAsync: (cwd?: string) => Promise<boolean>;
		getCommand: (cwd?: string) => string | null;
		getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
		reset?: () => void;
	},
	toolId: string,
	cwd: string,
): Promise<string | null> {
	const key = normalizeEphemeralMapKey(cwd);
	let byTool = resolveInstallInFlightByCwd.get(key);
	if (!byTool) {
		byTool = new Map();
		resolveInstallInFlightByCwd.set(key, byTool);
	}
	const existing = byTool.get(toolId);
	if (existing) return existing;

	const generation = availabilityStateGeneration;
	const promise = resolveAvailableOrInstallUnshared(checker, toolId, cwd).finally(
		() => {
			if (generation !== availabilityStateGeneration) return;
			const current = resolveInstallInFlightByCwd.get(key);
			if (current?.get(toolId) === promise) {
				current.delete(toolId);
				if (current.size === 0) resolveInstallInFlightByCwd.delete(key);
			}
		},
	);
	byTool.set(toolId, promise);
	return promise;
}

// =============================================================================
// SHARED AST-GREP AVAILABILITY
// =============================================================================

// Shared ast-grep availability cache across all slop runners
let sgAvailable: boolean | null = null;
let sgCmd: string | null = null;
let sgCmdArgs: string[] = [];

function isAstGrepVersionOutput(output: string): boolean {
	return /\bast[- ]grep\b/i.test(output);
}

async function probeAstGrepCommandAsync(
	cmd: string,
	argsPrefix: string[] = [],
): Promise<boolean> {
	const check = await safeSpawnAsync(cmd, [...argsPrefix, "--version"], {
		timeout: 5000,
	});
	return (
		!check.error &&
		check.status === 0 &&
		isAstGrepVersionOutput(`${check.stdout}\n${check.stderr}`)
	);
}

/** Pre-filter local node_modules/.bin candidates that actually exist on disk. */
function buildSgLocalBins(): string[] {
	const isWin = process.platform === "win32";
	const hasBash = !!(
		process.env.MSYSTEM ||
		process.env.GIT_SHELL ||
		process.env.BASH
	);
	const extensions = isWin
		? hasBash
			? ["", ".exe", ".cmd"]
			: [".cmd", ".exe", ""]
		: [""];
	const binaryCandidates = ["ast-grep", "sg"].flatMap((base) =>
		extensions.map((ext) => `${base}${ext}`),
	);
	const binRoots = [
		...findNodeBinRoots(_thisDir),
		...findNodeBinRoots(process.cwd()),
		_managedToolsDir,
	];
	const bins: string[] = [];
	for (const root of binRoots) {
		for (const candidate of binaryCandidates) {
			const localBin = path.join(root, "node_modules", ".bin", candidate);
			if (fs.existsSync(localBin)) bins.push(localBin);
		}
	}
	return bins;
}

let sgAvailableInFlight: Promise<boolean> | null = null;
let sgAvailabilityGeneration = availabilityStateGeneration;

function ensureCurrentSgGeneration(): void {
	if (sgAvailabilityGeneration === availabilityStateGeneration) return;
	sgAvailable = null;
	sgCmd = null;
	sgCmdArgs = [];
	sgAvailableInFlight = null;
	sgAvailabilityGeneration = availabilityStateGeneration;
}

export async function isSgAvailableAsync(): Promise<boolean> {
	ensureCurrentSgGeneration();
	if (sgAvailable !== null) return sgAvailable;
	if (sgAvailableInFlight) return sgAvailableInFlight;

	sgAvailableInFlight = (async () => {
		// 1. Local node_modules/.bin
		for (const localBin of buildSgLocalBins()) {
			if (await probeAstGrepCommandAsync(localBin)) {
				sgCmd = localBin; sgCmdArgs = []; sgAvailable = true;
				return true;
			}
		}

		// 2. Global PATH
		for (const cmd of ["ast-grep", "sg"]) {
			if (await probeAstGrepCommandAsync(cmd)) {
				sgCmd = cmd; sgCmdArgs = []; sgAvailable = true;
				return true;
			}
		}

		// 2b. Any package manager's global bin dir (npm/pnpm/yarn/bun) — catches
		// `pnpm add -g @ast-grep/cli` installs whose bin dir is off PATH (#375).
		for (const name of ["ast-grep", "sg"]) {
			const globalBin = await findGlobalBinary(name);
			if (globalBin && (await probeAstGrepCommandAsync(globalBin))) {
				sgCmd = globalBin; sgCmdArgs = []; sgAvailable = true;
				return true;
			}
		}

		// 3. npx --no (cache-only, no silent download).
		if (await probeAstGrepCommandAsync("npx", ["--no", "--", "ast-grep"])) {
			sgCmd = "npx"; sgCmdArgs = ["--no", "--", "ast-grep"]; sgAvailable = true;
			return true;
		}

		sgAvailable = false;
		return false;
	})().finally(() => {
		sgAvailableInFlight = null;
	});

	return sgAvailableInFlight;
}

export function getSgCommand(): { cmd: string; args: string[] } {
	ensureCurrentSgGeneration();
	return {
		cmd: sgCmd ?? "npx",
		args: sgCmdArgs.length ? sgCmdArgs : ["--no", "--", "ast-grep"],
	};
}

// =============================================================================
// LOCAL-FIRST BINARY RESOLUTION
// =============================================================================

/**
 * Find a tool binary preferring local node_modules/.bin, then any installed
 * package manager's global bin dir (npm/pnpm/yarn/bun), then global PATH. Only
 * falls back to `npx --no` as a last resort — the universal cache-only exec
 * (npx ships with node and never silently downloads), so this stays
 * manager-agnostic without risking a surprise `dlx` fetch on pnpm/yarn/bun.
 *
 * Returns: { cmd, args } where args may include the `["--no", toolName]` npx
 * preamble.
 */
export async function resolveLocalFirstAsync(
	toolName: string,
	cwd: string,
	windowsExt = ".cmd",
): Promise<{ cmd: string; args: string[] }> {
	const isWin = process.platform === "win32";
	const binName = isWin ? `${toolName}${windowsExt}` : toolName;

	// 1. Local node_modules/.bin (project-installed)
	const local = path.join(cwd, "node_modules", ".bin", binName);
	if (fs.existsSync(local)) return { cmd: local, args: [] };

	// 2. Global bin dir of ANY installed manager (npm/pnpm/yarn/bun) — direct
	//    file lookup, so it finds tools installed via `pnpm add -g` / `bun add -g`
	//    (whose bin dirs are often off PATH) and survives PATH staleness after an
	//    `install -g`. No spawn.
	const globalBin = await findGlobalBinary(toolName, windowsExt);
	if (globalBin) return { cmd: globalBin, args: [] };

	// 3. Global PATH (already installed system-wide, on PATH)
	const globalCheck = await safeSpawnAsync(toolName, ["--version"], {
		timeout: 3000,
	});
	if (!globalCheck.error && globalCheck.status === 0) {
		return { cmd: toolName, args: [] };
	}

	// 4. npx --no fallback — universal cache-only exec (no silent download)
	return { cmd: "npx", args: ["--no", toolName] };
}

// =============================================================================
// PRE-BUILT CHECKERS FOR COMMON TOOLS
// =============================================================================

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");
export const sg = {
	isAvailableAsync: isSgAvailableAsync,
	getCommand: getSgCommand,
};
