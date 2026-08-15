import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	advisoryPathKey,
	snapshotAdvisoryProvenance,
	validateAdvisoryProvenance,
} from "../../clients/advisory-provenance.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	consumeTestFindings,
	peekTestFindings,
	consumeTurnEndFindings,
	peekTurnEndFindings,
} from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("advisory provenance at context delivery (#1413)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

	function setup() {
		const env = setupTestEnvironment("pi-lens-advisory-");
		cleanups.push(env.cleanup);
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-a" });
		const cache = new CacheManager(false);
		const file = path.join(env.tmpDir, "src", "file.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const value = 1;\n");
		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 7,
			files: [{ path: file, role: "affected" }],
		});
		return { env, runtime, cache, file, provenance };
	}

	it("uses the guard normalizer for Windows and POSIX separators", () => {
		expect(advisoryPathKey("C:\\repo\\src\\file.ts", "C:\\repo"))
			.toBe(advisoryPathKey("C:/repo/src/file.ts", "C:/repo"));
	});

	it("keeps exact-hash findings blocking and peek classifies like consume", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		const peeked = peekTurnEndFindings(cache, env.tmpDir, runtime);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(peeked).toEqual(consumed);
		expect(consumed?.messages[0]?.content).toContain("Address 🔴 blockers");
		expect(consumed?.messages[0]?.content).not.toContain("Historical finding");
	});

	it("keeps no-metadata delivery byte-compatible", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		const baseline = peekTurnEndFindings(cache, env.tmpDir, runtime);
		const emptyCapacity = peekTurnEndFindings(cache, env.tmpDir, runtime, {});
		expect(emptyCapacity).toEqual(baseline);
	});

	it("adds exact model capacity without suppressing root-cause remediation", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		const capacity = {
			provider: "anthropic",
			modelId: "claude-opus",
			contextWindow: 200_000,
			maxOutputTokens: 32_000,
			contextTokens: 120_000,
		};
		const peeked = peekTurnEndFindings(cache, env.tmpDir, runtime, capacity);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime, capacity);
		expect(peeked).toEqual(consumed);
		const content = consumed?.messages[0]?.content ?? "";
		expect(content).toContain("Model capacity: anthropic/claude-opus");
		expect(content).toContain("context window 200,000 tokens");
		expect(content).toContain("max output 32,000 tokens");
		expect(content).toContain("current context 120,000/200,000 tokens (60%)");
		expect(content).toContain("fix root causes");
		expect(content).toContain("do not suppress, defer, or mark findings resolved");
		expect(content).toContain("lens_diagnostics with paths");
	});

	it("renders only validated fields for partial capacity metadata", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		const content = consumeTurnEndFindings(cache, env.tmpDir, runtime, {
			modelId: "small-model",
			maxOutputTokens: 4_096,
		})?.messages[0]?.content ?? "";
		expect(content).toContain("Model capacity: small-model, max output 4,096 tokens");
		expect(content).not.toContain("context window");
		expect(content).not.toContain("current context");
	});

	it("omits malformed capacity fields and leaves historical framing unchanged", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		const current = consumeTurnEndFindings(cache, env.tmpDir, runtime, {
			provider: "anthropic",
			modelId: "claude-opus",
			contextWindow: Number.NaN,
			maxOutputTokens: -1,
			contextTokens: 100,
		})?.messages[0]?.content ?? "";
		expect(current).not.toContain("Model capacity");
		expect(current).not.toContain("context window");
		expect(current).not.toContain("max output");
		expect(current).not.toContain("current context");

		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		runtime.setTelemetryIdentity({ sessionId: "session-b" });
		const historical = consumeTurnEndFindings(cache, env.tmpDir, runtime, {
			provider: "anthropic",
			modelId: "claude-opus",
			contextWindow: 200_000,
		})?.messages[0]?.content ?? "";
		expect(historical).toContain("Historical finding");
		expect(historical).not.toContain("Model capacity");
	});

	it("keeps unchanged blockers live across beginTurn and project sequence drift", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		runtime.beginTurn();
		runtime.bumpFileSeq(file);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(consumed?.messages[0]?.content).toContain("Address ");
		expect(consumed?.messages[0]?.content).not.toContain("Historical finding");
	});

	it("demotes an edit made after persistence", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		fs.writeFileSync(file, "export const value = 2;\n");
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("Historical finding; workspace changed since capture; re-run to confirm.");
	});

	it("hash-detects same-size same-mtime rewrites", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "finding", provenance }, env.tmpDir);
		fs.writeFileSync(file, "export const value = 2;\n");
		fs.utimesSync(file, provenance.files[0]!.mtimeMs / 1000, provenance.files[0]!.mtimeMs / 1000);
		expect(fs.statSync(file).size).toBe(provenance.files[0]!.size);
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("Historical finding");
	});

	it("treats legacy records and session mismatches as historical", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "legacy" }, env.tmpDir);
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("generation unknown");
		cache.writeCache("turn-end-findings", { content: "mismatch", provenance }, env.tmpDir);
		runtime.setTelemetryIdentity({ sessionId: "session-b" });
		expect(consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content)
			.toContain("Historical finding");
	});

	it("treats missing-to-missing as unchanged and validation read failures as unknown", () => {
		const { env, runtime, file } = setup();
		const absent = path.join(env.tmpDir, "never-created.ts");
		const missingProvenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 1,
			files: [{ path: absent, role: "affected" }],
		});
		expect(validateAdvisoryProvenance({ provenance: missingProvenance }, env.tmpDir, runtime))
			.toMatchObject({ status: "current", reasons: [] });

		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 2,
			files: [{ path: file, role: "affected" }],
		});
		fs.unlinkSync(file);
		fs.mkdirSync(file);
		expect(validateAdvisoryProvenance({ provenance }, env.tmpDir, runtime).status).toBe("unknown");
	});

	it("does not duplicate the historical preamble on prior-turn test content", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("test-runner-findings", {
			content: "[from a prior turn — already superseded]\n\nfailure",
			provenance,
		}, env.tmpDir);
		runtime.setTelemetryIdentity({ sessionId: "other-session" });
		const content = peekTestFindings(cache, env.tmpDir, runtime)?.messages[0]?.content ?? "";
		expect(content).toContain("[from a prior turn");
		expect(content).not.toContain("Historical finding");
	});

	it("preserves the test-run generation high-water mark across consumption", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("test-runner-findings", {
			content: "failure from batch B",
			testRunGeneration: 2,
			provenance,
		}, env.tmpDir);
		const delivered = consumeTestFindings(cache, env.tmpDir, runtime);
		expect(delivered).toBeDefined();
		// One-shot: nothing left to deliver...
		expect(peekTestFindings(cache, env.tmpDir, runtime)).toBeUndefined();
		// ...but the generation survives, so a still-in-flight OLDER batch (gen 1)
		// comparing against the persisted slot is suppressed instead of seeing
		// undefined and resurrecting a consumed advisory with stale results.
		const persisted = cache.readCache<Record<string, unknown>>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted).toMatchObject({ content: "", testRunGeneration: 2 });
	});

	it("preserves structured commit-gate state when consumed", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", {
			content: "blocker",
			hasBlockers: true,
			sessionId: "session-a",
			blockerContent: "structured blocker",
			provenance,
		}, env.tmpDir);
		consumeTurnEndFindings(cache, env.tmpDir, runtime);
		const persisted = cache.readCache<Record<string, unknown>>("turn-end-findings", env.tmpDir)?.data;
		expect(persisted).toMatchObject({ consumed: true, blockerContent: "structured blocker" });
	});
});
