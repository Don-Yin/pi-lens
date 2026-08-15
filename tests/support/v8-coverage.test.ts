import { describe, expect, it } from "vitest";
import {
	fileFromScriptUrl,
	summarizePreciseCoverage,
} from "./v8-coverage.js";

const root = "/repo";

describe("summarizePreciseCoverage", () => {
	it("maps file URLs under root and ignores outsiders", () => {
		expect(fileFromScriptUrl("file:///repo/clients/source-filter.js", root)).toBe(
			"clients/source-filter.js",
		);
		expect(fileFromScriptUrl("file:///elsewhere/x.js", root)).toBeUndefined();
		expect(fileFromScriptUrl("node:internal/process", root)).toBeUndefined();
	});

	it("reports per-file and aggregate function/block percentages", () => {
		const summary = summarizePreciseCoverage(
			[
				{
					url: "file:///repo/clients/hot.js",
					functions: [
						{ functionName: "a", ranges: [{ count: 2 }, { count: 0 }] },
						{ functionName: "b", ranges: [{ count: 0 }] },
					],
				},
				{
					url: "file:///repo/clients/cold.js",
					functions: [{ functionName: "c", ranges: [{ count: 0 }] }],
				},
				{
					url: "file:///repo/tests/ignore.js",
					functions: [{ functionName: "noise", ranges: [{ count: 9 }] }],
				},
			],
			{ root, include: ["clients/hot.js", "clients/cold.js", "clients/missing.js"] },
		);

		expect(summary.filesTotal).toBe(3);
		expect(summary.filesTouched).toBe(1);
		expect(summary.functionPct).toBeCloseTo((1 / 3) * 100);
		expect(summary.blockPct).toBeCloseTo((1 / 4) * 100);
		expect(summary.files.map((file) => file.file)).toEqual([
			"clients/cold.js",
			"clients/hot.js",
			"clients/missing.js",
		]);
		expect(summary.files.find((file) => file.file === "clients/missing.js")).toEqual({
			file: "clients/missing.js",
			functionCount: 0,
			functionsHit: 0,
			blockCount: 0,
			blocksHit: 0,
			functionPct: 0,
			blockPct: 0,
		});
	});
});
