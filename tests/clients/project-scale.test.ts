import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PROJECT_SCALE_BASE,
	PROJECT_SCALE_RATIOS,
	REVIEW_GRAPH_HARD_CEILING,
	REVIEW_GRAPH_TAPER_BASE_BUDGET,
	REVIEW_GRAPH_TAPER_SLOPE,
	REVIEW_GRAPH_TAPER_THRESHOLD,
	_resetProjectScaleBaseForTests,
	deriveBudget,
	getJscpdMaxEntriesDerived,
	getProjectDiagnosticsScannerMaxFiles,
	getProjectScaleBase,
	getReviewGraphMaxFilesDerived,
	getStartupScanMaxSourceFilesDerived,
	getWordIndexMaxFilesDerived,
} from "../../clients/project-scale.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

const ENV_NAME = "PI_LENS_MAX_PROJECT_FILES";

let tmpDir: string;
let previousEnv: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-scale-"));
	previousEnv = process.env[ENV_NAME];
	delete process.env[ENV_NAME];
	_resetProjectScaleBaseForTests();
	resetProjectLensConfigCache();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	if (previousEnv === undefined) delete process.env[ENV_NAME];
	else process.env[ENV_NAME] = previousEnv;
	_resetProjectScaleBaseForTests();
	resetProjectLensConfigCache();
});

describe("getProjectScaleBase", () => {
	it("defaults to DEFAULT_PROJECT_SCALE_BASE when nothing is configured", () => {
		expect(getProjectScaleBase()).toBe(DEFAULT_PROJECT_SCALE_BASE);
		expect(getProjectScaleBase(tmpDir)).toBe(DEFAULT_PROJECT_SCALE_BASE);
	});

	it("honours PI_LENS_MAX_PROJECT_FILES when no cwd/config is given", () => {
		process.env[ENV_NAME] = "9000";
		expect(getProjectScaleBase()).toBe(9000);
	});

	it("honours PI_LENS_MAX_PROJECT_FILES when a cwd has no .pi-lens.json", () => {
		process.env[ENV_NAME] = "9000";
		expect(getProjectScaleBase(tmpDir)).toBe(9000);
	});

	it("a .pi-lens.json maxProjectFiles override beats PI_LENS_MAX_PROJECT_FILES", () => {
		process.env[ENV_NAME] = "9000";
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 5000 }),
		);
		expect(getProjectScaleBase(tmpDir)).toBe(5000);
	});

	it("falls back to the env/default chain when maxProjectFiles is invalid", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: -5 }),
		);
		expect(getProjectScaleBase(tmpDir)).toBe(DEFAULT_PROJECT_SCALE_BASE);
	});
});

describe("deriveBudget / ratio table reproduces today's five defaults", () => {
	it("project-diagnostics scanner: 0.25x2000 = 500", () => {
		expect(
			deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner),
		).toBe(500);
		expect(getProjectDiagnosticsScannerMaxFiles()).toBe(500);
	});

	it("review graph: 0.5x2000 = 1000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.reviewGraph)).toBe(1000);
		expect(getReviewGraphMaxFilesDerived()).toBe(1000);
	});

	it("startup scan: 1x2000 = 2000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.startupScan)).toBe(2000);
		expect(getStartupScanMaxSourceFilesDerived()).toBe(2000);
	});

	it("jscpd: 3x2000 = 6000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.jscpd)).toBe(6000);
		expect(getJscpdMaxEntriesDerived()).toBe(6000);
	});

	it("word index: 3x2000 = 6000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.wordIndex)).toBe(6000);
		expect(getWordIndexMaxFilesDerived()).toBe(6000);
	});
});

describe("a .pi-lens.json maxProjectFiles override scales all five derived budgets", () => {
	beforeEach(() => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 4000 }),
		);
	});

	it("scales every subsystem's derived budget proportionally", () => {
		expect(getProjectDiagnosticsScannerMaxFiles(tmpDir)).toBe(1000);
		// Review graph uses adaptive taper — at base 4000: 1500 + 0.2*(4000-3000) = 1700 (#775)
		expect(getReviewGraphMaxFilesDerived(tmpDir)).toBe(1700);
		expect(getStartupScanMaxSourceFilesDerived(tmpDir)).toBe(4000);
		expect(getJscpdMaxEntriesDerived(tmpDir)).toBe(12000);
		expect(getWordIndexMaxFilesDerived(tmpDir)).toBe(12000);
	});

	it("does not affect callers that pass no cwd", () => {
		expect(getProjectDiagnosticsScannerMaxFiles()).toBe(500);
	});
});	describe("getReviewGraphMaxFilesDerived — adaptive taper (#775)", () => {
		it("at default base (2000): 0.5× yields 1000, unchanged from current default", () => {
			expect(getReviewGraphMaxFilesDerived()).toBe(1000);
		});

		it("at base=1000: flat 0.5× yields 500", () => {
			process.env[ENV_NAME] = "1000";
			_resetProjectScaleBaseForTests();
			expect(getReviewGraphMaxFilesDerived()).toBe(500);
		});

		it("at base=2000: flat 0.5× yields 1000", () => {
			process.env[ENV_NAME] = "2000";
			_resetProjectScaleBaseForTests();
			expect(getReviewGraphMaxFilesDerived()).toBe(1000);
		});

		it("at base=3000 (TAPER_THRESHOLD): flat 0.5× yields 1500", () => {
			process.env[ENV_NAME] = "3000";
			_resetProjectScaleBaseForTests();
			expect(getReviewGraphMaxFilesDerived()).toBe(1500);
		});

		it("at base=4000: above threshold, tapers to 1700", () => {
			process.env[ENV_NAME] = "4000";
			_resetProjectScaleBaseForTests();
			// 1500 + 0.2 * (4000 - 3000) = 1500 + 200 = 1700
			expect(getReviewGraphMaxFilesDerived()).toBe(1700);
		});

		it("at base=10000: taper yields 2900, well below ceiling", () => {
			process.env[ENV_NAME] = "10000";
			_resetProjectScaleBaseForTests();
			// 1500 + 0.2 * (10000 - 3000) = 1500 + 1400 = 2900
			expect(getReviewGraphMaxFilesDerived()).toBe(2900);
		});

		it("hard ceiling: never exceeds REVIEW_GRAPH_HARD_CEILING", () => {
			process.env[ENV_NAME] = "50000";
			_resetProjectScaleBaseForTests();
			// Taper would give: 1500 + 0.2 * (50000 - 3000) = 1500 + 9400 = 10900
			// But hard ceiling is 5000
			expect(getReviewGraphMaxFilesDerived()).toBe(REVIEW_GRAPH_HARD_CEILING);
		});

		it("ceiling at base=22000: clamped to 5000", () => {
			process.env[ENV_NAME] = "22000";
			_resetProjectScaleBaseForTests();
			// 1500 + 0.2 * (22000 - 3000) = 1500 + 3800 = 5300 → clamped to 5000
			expect(getReviewGraphMaxFilesDerived()).toBe(5000);
		});

		it("at base=5000: 1500 + 0.2 * 2000 = 1900", () => {
			process.env[ENV_NAME] = "5000";
			_resetProjectScaleBaseForTests();
			expect(getReviewGraphMaxFilesDerived()).toBe(1900);
		});

		it("at base=20000: 1500 + 0.2 * 17000 = 4900", () => {
			process.env[ENV_NAME] = "20000";
			_resetProjectScaleBaseForTests();
			expect(getReviewGraphMaxFilesDerived()).toBe(4900);
		});

		it("uses .pi-lens.json maxProjectFiles as the base for taper", () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({ maxProjectFiles: 8000 }),
			);
			// 1500 + 0.2 * (8000 - 3000) = 1500 + 1000 = 2500
			expect(getReviewGraphMaxFilesDerived(tmpDir)).toBe(2500);
		});

		it("at base=1 (tiny): floors to 1", () => {
			process.env[ENV_NAME] = "1";
			_resetProjectScaleBaseForTests();
			expect(getReviewGraphMaxFilesDerived()).toBe(1);
		});
	});

describe("deriveBudget floors", () => {
	it("never returns less than 1, even at a tiny base", () => {
		process.env[ENV_NAME] = "1";
		expect(deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner)).toBe(
			1,
		);
	});
});
