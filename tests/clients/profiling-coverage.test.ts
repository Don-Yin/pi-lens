/**
 * Profiling coverage: what percent of the walk/profile hot path a
 * representative source-tree workload actually executes.
 *
 * Occupancy tests (`source-walk-occupancy.test.ts`) guard event-loop stalls.
 * This is the complementary reach metric — pyinstrument-style "did the
 * profiler even touch the production modules" — using V8 precise coverage
 * on the in-place compiled clients. Thresholds sit below a measured local
 * run so ambient fork-pool noise cannot flake them, but a workload that
 * stops calling the walkers will fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import { detectProjectLanguageProfileAsync } from "../../clients/language-profile.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";
import { countSourceFilesWithinLimitAsync } from "../../clients/startup-scan.js";
import { generateSourceTree } from "../support/perf-harness.js";
import {
	summarizePreciseCoverage,
	withPreciseCoverage,
} from "../support/v8-coverage.js";
import { removeTempDirSync } from "./test-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TREE_SIZE = 400;

/** Compiled in-place clients the walk/profile workload must reach. */
const HOT_PATH = [
	"clients/file-kinds.js",
	"clients/file-utils.js",
	"clients/generated-artifacts.js",
	"clients/language-profile.js",
	"clients/path-utils.js",
	"clients/source-filter.js",
	"clients/source-walker.js",
	"clients/startup-scan.js",
] as const;

// Floors from a local measured run of this fixture (function 95.3%, block 68.1%,
// all 8 files touched). Leave headroom for smaller hosts / cached header hits.
const MIN_FILES_TOUCHED = HOT_PATH.length;
const MIN_FUNCTION_PCT = 70;
const MIN_BLOCK_PCT = 45;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-profiling-coverage-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	removeTempDirSync(tmpDir);
});

beforeEach(() => {
	_resetGeneratedArtifactCaches();
});

describe(`profiling coverage of walk/profile hot path (~${TREE_SIZE} files)`, () => {
	it(
		"executes a minimum share of functions and blocks in the hot-path clients",
		{ timeout: 30_000 },
		async () => {
			const { result, scripts } = await withPreciseCoverage(async () => {
				const syncFiles = collectSourceFiles(tmpDir);
				const asyncFiles = await collectSourceFilesAsync(tmpDir);
				const profile = await detectProjectLanguageProfileAsync(tmpDir);
				const counted = await countSourceFilesWithinLimitAsync(tmpDir, 1_000_000);
				return { syncFiles, asyncFiles, profile, counted };
			});

			expect(result.syncFiles.length).toBeGreaterThan(0);
			expect(result.asyncFiles).toEqual(result.syncFiles);
			expect(result.counted).toBeGreaterThan(0);
			expect(result.profile).toBeTruthy();

			const summary = summarizePreciseCoverage(scripts, {
				root: repoRoot,
				include: HOT_PATH,
			});
			const missing = HOT_PATH.filter(
				(file) => !summary.files.some((entry) => entry.file === file && entry.functionsHit > 0),
			);

			expect(
				missing,
				`hot-path modules with zero executed functions: ${missing.join(", ") || "(none)"}`,
			).toEqual([]);
			expect(summary.filesTouched).toBeGreaterThanOrEqual(MIN_FILES_TOUCHED);
			expect(summary.functionPct).toBeGreaterThanOrEqual(MIN_FUNCTION_PCT);
			expect(summary.blockPct).toBeGreaterThanOrEqual(MIN_BLOCK_PCT);
		},
	);
});
