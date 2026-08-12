import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAvailabilityChecker,
	getSgCommand,
	isSgAvailableAsync,
	lspPrimaryCoversFile,
	resolveCommandArgsWithInstallFallback,
	resolveCommandWithInstallFallback,
	resolveAvailableOrInstall,
	resolveLocalFirstAsync,
	resolveNodeToolCommand,
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
	resetDispatchAvailabilityState,
	resolveVendorToolCommand,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.ts";
import type { DispatchContext } from "../../../../clients/dispatch/types.ts";
import { findGlobalBinary } from "../../../../clients/package-manager.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { logSessionStartSpy } = vi.hoisted(() => ({
	logSessionStartSpy: vi.fn(),
}));

vi.mock("../../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: logSessionStartSpy,
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => null),
	// Pass the on-disk pre-check so these tests keep exercising the --version
	// probe path through the mocked safeSpawnAsync.
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
}));

vi.mock("../../../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/package-manager.js")
	>()),
	findGlobalBinary: vi.fn(async () => undefined),
}));

describe("runner-helpers availability checker", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
		vi.mocked(findGlobalBinary).mockReset();
		vi.mocked(findGlobalBinary).mockResolvedValue(undefined);
		logSessionStartSpy.mockReset();
		resetDispatchAvailabilityState();
	});

	it("resolves local node_modules/.bin commands before global fallback", () => {
		const env = setupTestEnvironment("pi-lens-node-bin-");
		try {
			const localUnix = path.join(env.tmpDir, "node_modules", ".bin", "eslint");
			const localWin = path.join(
				env.tmpDir,
				"node_modules",
				".bin",
				"eslint.cmd",
			);
			fs.mkdirSync(path.dirname(localUnix), { recursive: true });
			fs.writeFileSync(localUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(localWin, "@echo off\n");

			const resolved = resolveNodeToolCommand(env.tmpDir, "eslint");
			expect(resolved).toContain(path.join("node_modules", ".bin"));
		} finally {
			env.cleanup();
		}
	});

	it("falls back to global command when no local node_modules binary exists", () => {
		const env = setupTestEnvironment("pi-lens-node-bin-global-");
		try {
			expect(resolveNodeToolCommand(env.tmpDir, "eslint")).toBe("eslint");
			expect(resolveToolCommand(env.tmpDir, "eslint")).toBe("eslint");
		} finally {
			env.cleanup();
		}
	});

	it("resolves vendor/bin commands by walking up the directory tree", () => {
		const env = setupTestEnvironment("pi-lens-vendor-bin-");
		try {
			const nested = path.join(env.tmpDir, "src", "Controllers");
			const vendorUnix = path.join(env.tmpDir, "vendor", "bin", "phpstan");
			const vendorWin = path.join(env.tmpDir, "vendor", "bin", "phpstan.bat");
			fs.mkdirSync(path.dirname(vendorUnix), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(vendorUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(vendorWin, "@echo off\n");

			const resolved = resolveVendorToolCommand(nested, "phpstan", ".bat");
			expect(resolved).toContain(path.join("vendor", "bin"));
		} finally {
			env.cleanup();
		}
	});

	it("resolves installed command after version check fallback", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValueOnce(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue("stylelint");

		const resolved = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			process.cwd(),
		);

		expect(installerMod.ensureTool).toHaveBeenCalledWith("stylelint");
		expect(resolved).toBe("stylelint");
	});

	it("preserves existing command args when project command verifies", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "rubocop 1.0.0",
			stderr: "",
			status: 0,
		});

		const resolved = await resolveCommandArgsWithInstallFallback(
			{ cmd: "bundle", args: ["exec", "rubocop"] },
			"rubocop",
			process.cwd(),
			["--version"],
			10000,
		);

		expect(resolved).toEqual({ cmd: "bundle", args: ["exec", "rubocop"] });
	});

	it("does not auto-install config-first tools", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "",
			stderr: "not found",
			status: 1,
		});

		const resolved = await resolveCommandWithInstallFallback(
			"eslint",
			"eslint",
			process.cwd(),
		);
		const resolvedByToolId = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"eslint",
		);

		expect(installerMod.ensureTool).not.toHaveBeenCalled();
		expect(resolved).toBeNull();
		expect(resolvedByToolId).toBeNull();
	});

	it("dedupes concurrent missing-tool probe and install transactions", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "not found",
			status: 1,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "tool-not-found",
		});
		vi.mocked(installerMod.ensureTool).mockResolvedValue("ruff");
		const checker = createAvailabilityChecker("ruff");

		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				resolveAvailableOrInstall(checker, "ruff", process.cwd()),
			),
		);

		expect(results).toEqual(Array(8).fill("ruff"));
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(1);
		// Mutation verification: removing the shared resolve/install in-flight map
		// makes this same test observe 8 ensureTool calls; the dedupe extension was
		// temporarily reverted and the test was rerun before restoring the fix.
	});

	it("probes with custom versionArgs (e.g. `zig version`, not `--version`)", async () => {
		// Regression guard for #209: zig rejects `--version` (its version
		// subcommand is `zig version`), so the default probe made zig-check skip on
		// every machine. The checker must forward the override to the spawn.
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let probedArgs: string[] | undefined;
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
			async (_cmd, args) => {
				probedArgs = args as string[];
				return { stdout: "0.16.0", stderr: "", status: 0 };
			},
		);

		const checker = createAvailabilityChecker("zig", ".exe", ["version"]);
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(probedArgs).toEqual(["version"]);
	});

	it("does not let an old in-flight probe delete a newer generation", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let releaseOld!: (value: unknown) => void;
		let releaseNew!: (value: unknown) => void;
		const oldProbe = new Promise((resolve) => {
			releaseOld = resolve;
		});
		const newProbe = new Promise((resolve) => {
			releaseNew = resolve;
		});
		vi.mocked(safeSpawnMod.safeSpawnAsync)
			.mockReturnValueOnce(oldProbe as never)
			.mockReturnValueOnce(newProbe as never);

		const checker = createAvailabilityChecker("generation-tool");
		const oldResult = checker.isAvailableAsync(process.cwd());
		await vi.waitFor(() =>
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1),
		);

		resetDispatchAvailabilityState();
		const newResult = checker.isAvailableAsync(process.cwd());
		await vi.waitFor(() =>
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2),
		);
		releaseOld({ stdout: "", stderr: "", status: 1 });
		await oldResult;

		// If the old finally deleted the new entry, this call would start a third
		// probe instead of sharing the replacement-generation promise.
		void checker.isAvailableAsync(process.cwd());
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2);
		releaseNew({ stdout: "1.0.0", stderr: "", status: 0 });
		await newResult;
	});

	it("defaults versionArgs to --version when not overridden", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let probedArgs: string[] | undefined;
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
			async (_cmd, args) => {
				probedArgs = args as string[];
				return { stdout: "1.0.0", stderr: "", status: 0 };
			},
		);

		const checker = createAvailabilityChecker("sometool");
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(probedArgs).toEqual(["--version"]);
	});

	it("re-probes a cached positive when its resolved command disappears", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync)
			.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", status: 0 })
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "missing",
				status: null,
				error: Object.assign(new Error("missing"), { code: "ENOENT" }),
				failure: "tool-not-found",
			});
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValueOnce(false);
		// Scoped count: earlier tests in this file legitimately trigger the
		// session-reset path, which also calls resetPathWalkMemo.
		vi.mocked(installerMod.resetPathWalkMemo).mockClear();
		const checker = createAvailabilityChecker("deleted-tool");
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2);
		expect(installerMod.resetPathWalkMemo).toHaveBeenCalledOnce();
	});

	it("resets the shared ast-grep availability memo at session start", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "missing",
			status: 1,
		});
		expect(await isSgAvailableAsync()).toBe(false);
		vi.mocked(installerMod.resetPathWalkMemo).mockClear();
		resetDispatchAvailabilityState();
		expect(installerMod.resetPathWalkMemo).toHaveBeenCalledOnce();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "ast-grep 0.40.0",
			stderr: "",
			status: 0,
		});
		expect(await isSgAvailableAsync()).toBe(true);
		expect(getSgCommand().cmd).toContain("ast-grep");
	});

	it("bounds missing-tool installs to one attempt and records the failure", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
			failure: "tool-not-found",
		});
		vi.mocked(installerMod.ensureTool).mockResolvedValue(undefined);

		const checker = createAvailabilityChecker("missing-tool");
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await expect(
				resolveAvailableOrInstall(checker, "ruff", process.cwd()),
			).resolves.toBeNull();
		}

		// The first failed install suppresses same-session re-entry, so the
		// effective retry cap is one attempt per tool and cwd.
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(1);
		expect(logSessionStartSpy).toHaveBeenCalledTimes(1);
		expect(logSessionStartSpy).toHaveBeenCalledWith(
			"dispatch availability ruff: install attempt 1 failed; suppressing retries until the next session or a successful install",
		);

		resetDispatchAvailabilityState();
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBeNull();
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(2);
		expect(logSessionStartSpy).toHaveBeenCalledTimes(2);
		expect(logSessionStartSpy).toHaveBeenLastCalledWith(
			"dispatch availability ruff: install attempt 1 failed; suppressing retries until the next session or a successful install",
		);
	});

	it("allows a later retry after a successful install clears the failure state", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
			failure: "tool-not-found",
		});
		const checker = createAvailabilityChecker("missing-tool-success");

		vi.mocked(installerMod.ensureTool).mockResolvedValueOnce(undefined);
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBeNull();

		// The session reset permits the successful install attempt; the assertion
		// below verifies that noteInstallSuccess removes the prior tool state.
		resetDispatchAvailabilityState();
		vi.mocked(installerMod.ensureTool).mockResolvedValueOnce("/managed/ruff");
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBe("/managed/ruff");

		vi.mocked(installerMod.ensureTool).mockResolvedValueOnce(undefined);
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBeNull();
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(3);
		expect(logSessionStartSpy).toHaveBeenLastCalledWith(
			"dispatch availability ruff: install attempt 1 failed; suppressing retries until the next session or a successful install",
		);
	});

	it("lspPrimaryCoversFile: true when the named server is the file's primary (#233)", () => {
		const ctx = {
			filePath: "/proj/config.toml",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		// the `toml` LSP server (taplo lsp) is the sole primary for .toml
		expect(lspPrimaryCoversFile(ctx, "toml")).toBe(true);
		const sh = {
			filePath: "/proj/deploy.sh",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(sh, "bash")).toBe(true);
	});

	it("lspPrimaryCoversFile: false when no-lsp kills the runner (#233)", () => {
		const ctx = {
			filePath: "/proj/config.toml",
			pi: { getFlag: (f: string) => f === "no-lsp" },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "toml")).toBe(false);
	});

	it("lspPrimaryCoversFile: false when the server is not this file's primary (#233)", () => {
		// a .py file's primary is the python server, not toml — so the taplo CLI
		// must NOT self-skip on it.
		const ctx = {
			filePath: "/proj/main.py",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "toml")).toBe(false);
	});

	it("resolveLocalFirstAsync: local node_modules/.bin wins without any probe", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const env = setupTestEnvironment("pi-lens-local-first-");
		try {
			const isWin = process.platform === "win32";
			const binName = isWin ? "prisma.cmd" : "prisma";
			const local = path.join(env.tmpDir, "node_modules", ".bin", binName);
			fs.mkdirSync(path.dirname(local), { recursive: true });
			fs.writeFileSync(local, isWin ? "@echo off\n" : "#!/bin/sh\n");

			const resolved = await resolveLocalFirstAsync("prisma", env.tmpDir);
			expect(resolved).toEqual({ cmd: local, args: [] });
			// Local hit short-circuits — no global-bin lookup, no PATH spawn.
			expect(findGlobalBinary).not.toHaveBeenCalled();
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("resolveLocalFirstAsync: falls to a manager's global bin dir before PATH", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const env = setupTestEnvironment("pi-lens-global-bin-");
		try {
			const globalPath = path.join("/opt/pnpm/bin", "prisma");
			vi.mocked(findGlobalBinary).mockResolvedValueOnce(globalPath);

			const resolved = await resolveLocalFirstAsync("prisma", env.tmpDir);
			expect(resolved).toEqual({ cmd: globalPath, args: [] });
			expect(findGlobalBinary).toHaveBeenCalledWith("prisma", ".cmd");
			// Found via direct file lookup — the PATH `--version` spawn is skipped.
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("resolveLocalFirstAsync: PATH probe when no local/global bin, else npx --no", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const env = setupTestEnvironment("pi-lens-path-probe-");
		try {
			vi.mocked(findGlobalBinary).mockResolvedValue(undefined);

			// On PATH: `<tool> --version` exits 0 → run it bare.
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				stdout: "5.0.0",
				stderr: "",
				status: 0,
			});
			expect(await resolveLocalFirstAsync("prisma", env.tmpDir)).toEqual({
				cmd: "prisma",
				args: [],
			});

			// Not on PATH → universal cache-only `npx --no` fallback (no dlx fetch).
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				stdout: "",
				stderr: "not found",
				status: 1,
			});
			expect(await resolveLocalFirstAsync("prisma", env.tmpDir)).toEqual({
				cmd: "npx",
				args: ["--no", "prisma"],
			});
		} finally {
			env.cleanup();
		}
	});

	it("caches availability per cwd (does not leak false across projects)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const dirA = setupTestEnvironment("pi-lens-a-");
		const dirB = setupTestEnvironment("pi-lens-b-");
		try {
			const ruffBUnix = path.join(dirB.tmpDir, ".venv", "bin", "ruff");
			const ruffBWin = path.join(dirB.tmpDir, ".venv", "Scripts", "ruff.exe");
			fs.mkdirSync(path.dirname(ruffBUnix), { recursive: true });
			fs.mkdirSync(path.dirname(ruffBWin), { recursive: true });
			fs.writeFileSync(ruffBUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(ruffBWin, "@echo off\n");

			const checker = createAvailabilityChecker("ruff", ".exe");

			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(async (cmd) => {
				const text = String(cmd);
				if (text.includes(dirB.tmpDir)) {
					return { stdout: "ruff 1.0.0", stderr: "", status: 0 };
				}
				return { stdout: "", stderr: "not found", status: 1 };
			});

			expect(await checker.isAvailableAsync(dirA.tmpDir)).toBe(false);
			expect(await checker.isAvailableAsync(dirB.tmpDir)).toBe(true);
			expect(checker.getCommand(dirA.tmpDir)).toBeNull();
			expect(checker.getCommand(dirB.tmpDir)).toContain(dirB.tmpDir);
		} finally {
			dirA.cleanup();
			dirB.cleanup();
		}
	});
});
