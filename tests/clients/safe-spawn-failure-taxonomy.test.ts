import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

let spawnError: NodeJS.ErrnoException;
const spawnMock = vi.fn(() => {
	throw spawnError;
});

vi.mock("node:child_process", () => ({
	spawn: () => spawnMock(),
	spawnSync: () => ({ stdout: "", stderr: "", status: 0 }),
}));
vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: () => ({ stop: () => null }),
}));
vi.mock("../../clients/latency-logger.js", () => ({ logLatency: () => {} }));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
const validCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-spawn-kind-"));
const missingCwd = path.join(validCwd, "missing");

afterAll(() => removeTempDirSync(validCwd));

describe("safe-spawn failure taxonomy (#1214)", () => {
	it.each([
		["tool-not-found", "ENOENT", validCwd],
		["cwd-unresolvable", "ENOENT", missingCwd],
		["permission-denied", "EACCES", validCwd],
		["spawn-rejected", "EAGAIN", validCwd],
		["spawn-failed", "EINVAL", validCwd],
	] as const)("classifies a mocked spawn rejection as %s", async (kind, code, cwd) => {
		spawnError = Object.assign(new Error(`spawn ${code}`), {
			code,
			syscall: "spawn",
		});

		const result = await safeSpawnAsync(process.execPath, ["--version"], { cwd });

		expect(result.failure).toBe(kind);
		expect((result.error as NodeJS.ErrnoException).code).toBe(code);
	});
});
