/**
 * Single "project scale" knob deriving pi-lens's five independent
 * project-size budgets (#776).
 *
 * Before this module, five subsystems each hardcoded their own file/entry
 * ceiling and degraded independently as a repo grew:
 *
 *   - project-diagnostics scanner: 500 files  (clients/project-diagnostics/scanner.ts)
 *   - review graph:               1,000 files (clients/runtime-config.ts)
 *   - startup scan:               2,000 source files (clients/startup-scan.ts)
 *   - jscpd:                      6,000 dir entries (clients/jscpd-client.ts)
 *   - word index:                 6,000 files (clients/word-index.ts)
 *
 * A large-but-healthy (monorepo-scale) repo would trip these one at a time,
 * silently, with no single lever to say "this repo is big; believe in it".
 *
 * This module centralizes the base value (`maxProjectFiles`, default 2,000 —
 * chosen so every ratio below reproduces today's five defaults exactly) and
 * exposes one `deriveBudget(ratio, cwd)` helper subsystems call instead of
 * declaring their own local constant. Raising `maxProjectFiles` in one place
 * scales all five budgets coherently; this refactor changes no default value.
 *
 * Ratio table (documents today's five defaults at the default base of 2,000):
 *
 *   | Subsystem                    | Ratio | Derived @ base 2,000 | Today  |
 *   |-------------------------------|-------|----------------------|--------|
 *   | project-diagnostics scanner   | 0.25× | 500                  | 500    |
 *   | review graph                  | 0.5×  | 1,000                | 1,000  |
 *   | startup scan (source files)   | 1×    | 2,000                | 2,000  |
 *   | jscpd (dir entries)           | 3×    | 6,000                | 6,000  |
 *   | word index (files)            | 3×    | 6,000                | 6,000  |
 *
 * `maxProjectFiles` resolution order (highest priority first) — NOTE this is
 * the base-value chain only; each subsystem's own PRE-EXISTING per-subsystem
 * env override (e.g. `PI_LENS_REVIEW_GRAPH_MAX_FILES`,
 * `PI_LENS_STARTUP_SCAN_MAX_ENTRIES`) is still checked at the call site
 * BEFORE falling back to this module's derived value, so it always wins:
 *
 *   1. `maxProjectFiles` in the project's `.pi-lens.json` (per-project — see
 *      `clients/project-lens-config.ts`). Requires a `cwd`; a call site with
 *      no cwd in hand skips straight to (2).
 *   2. `PI_LENS_MAX_PROJECT_FILES` environment variable.
 *   3. Default: {@link DEFAULT_PROJECT_SCALE_BASE} (2,000).
 *
 * Two entry-UNIT budgets were deliberately left OUT of this derivation:
 * `startup-scan.ts`'s `MAX_STARTUP_SCAN_ENTRIES` (50,000 directory entries)
 * and `source-filter.ts`'s `DEFAULT_MAX_SCAN_ENTRIES` (200,000 directory
 * entries). Both bound directory entries VISITED (a raw tree-walk safety
 * valve, #758/#760), not source files KEPT — a very different quantity whose
 * healthy ratio to file count varies wildly by project shape (a repo with a
 * huge non-source data/asset tree needs a much larger entries budget than its
 * source-file count would suggest). Coupling them to `maxProjectFiles` would
 * risk silently changing behavior on exactly the pathological-tree shapes
 * these ceilings exist to protect, for no behavior-neutral gain; they already
 * have their own env overrides for callers who need to retune them. Left
 * standalone per the issue's "derive or standalone, justify" instruction.
 */

import { lazyEnvNumber, toPositiveFinite } from "./env-utils.js";
import { loadPiLensProjectConfig } from "./project-lens-config.js";

/**
 * Default base value: chosen so every ratio in the table above reproduces
 * today's five hardcoded defaults exactly. Do not change without re-deriving
 * every subsystem's default (that re-tuning is explicitly out of scope here —
 * see #775).
 */
export const DEFAULT_PROJECT_SCALE_BASE = 2_000;

const _envBase = lazyEnvNumber(
	"PI_LENS_MAX_PROJECT_FILES",
	DEFAULT_PROJECT_SCALE_BASE,
);

/** Test-only: clears the memoized `PI_LENS_MAX_PROJECT_FILES` read so a
 * subsequent call re-reads the env var (matching the `_resetForTests`
 * convention used across `env-utils.ts` consumers). */
export function _resetProjectScaleBaseForTests(): void {
	_envBase._resetForTests();
}

/**
 * Resolve the base `maxProjectFiles` value.
 *
 * Pass the caller's project root as `cwd` whenever one is available — that's
 * what lets a per-project `.pi-lens.json` override win. Call sites that only
 * have a bare module-level constant today (no cwd in hand) may omit it; they
 * fall back to the `PI_LENS_MAX_PROJECT_FILES` env var / default chain only
 * (documented per-call-site in each subsystem's own comment).
 */
export function getProjectScaleBase(cwd?: string): number {
	if (cwd) {
		const config = loadPiLensProjectConfig(cwd);
		const configBase = toPositiveFinite(config.maxProjectFiles);
		if (configBase > 0) return Math.floor(configBase);
	}
	return _envBase.get();
}

/**
 * Ratios calibrated to reproduce today's five hardcoded defaults exactly at
 * {@link DEFAULT_PROJECT_SCALE_BASE}. The unit each budget is expressed in
 * stays subsystem-appropriate (files vs. directory entries); this table is
 * the single place that encodes the relationship between them.
 *
 * NOTE: the review-graph ratio (0.5×) is the starting point for the adaptive
 * taper scheme — {@link getReviewGraphMaxFilesDerived} applies the actual
 * budget using the constants below, NOT this raw ratio directly. The ratio
 * is preserved here so {@link deriveBudget} still works consistently if any
 * caller passes `PROJECT_SCALE_RATIOS.reviewGraph` to it.
 */
export const PROJECT_SCALE_RATIOS = {
	/** project-diagnostics scanner: files kept. 0.25 * 2,000 = 500. */
	projectDiagnosticsScanner: 0.25,
	/** review graph: files kept. 0.5 * 2,000 = 1,000 (base of taper). */
	reviewGraph: 0.5,
	/** startup scan: source files counted. 1 * 2,000 = 2,000. */
	startupScan: 1,
	/** jscpd: directory entries visited (its own gate, not source-filter's). 3 * 2,000 = 6,000. */
	jscpd: 3,
	/** word index: files indexed. 3 * 2,000 = 6,000. */
	wordIndex: 3,
} as const;

/**
 * Adaptive review-graph budget constants (#775).
 *
 * The review-graph builder's per-file cost profile (tree-sitter parse +
 * symbol extraction + edge resolution) scales linearly with file count.
 * At small-to-medium project scales (maxProjectFiles ≤ 3,000, yielding up
 * to 1,500 graph-relevant files) the original 0.5× ratio applies directly.
 *
 * Beyond that the ratio tapers linearly toward a hard ceiling of 5,000
 * files, grounded by the builder's actual per-file cost characteristics:
 *
 *   - Each file requires one tree-sitter parse (~2–10ms depending on
 *     language and file size), one symbol extraction pass through
 *     tree-sitter queries, and one edge-resolution pass over imports,
 *     references, and call sites.
 *   - At 5K files the serialized graph elements (file nodes + symbol
 *     nodes + cross-file edges) stay well under ~150K for even
 *     symbol-dense repos, leaving generous headroom below the 200K
 *     {@link GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT} persist cap.
 *   - Beyond 5K files the element count would risk hitting the persist
 *     cap and the multi-second JSON.stringify OOM hazards documented
 *     in builder.ts (the persist circuit-breaker at line ~1260).
 *
 * The linear taper prevents a hard cutoff — a repo that modestly exceeds
 * the threshold still gets a useful fraction of its graph built, rather
 * than dropping from a usable budget to a skip verdict at a cliff edge.
 *
 * Taper formula (applied when base > TAPER_THRESHOLD):
 *
 *   budget = TAPER_BASE_BUDGET + (base - TAPER_THRESHOLD) * TAPER_SLOPE
 *   clamped to [1, HARD_CEILING]
 *
 * Defaults at key points:
 *   base      | 0.5× flat | tapered | ceiling-clamped
 *   ----------|-----------|---------|----------------
 *   2,000     | 1,000     | 1,000   | 1,000
 *   3,000     | 1,500     | 1,500   | 1,500
 *   5,000     | 2,500     | 1,900   | 1,900
 *   10,000    | 5,000     | 2,900   | 2,900
 *   20,000    | 10,000    | 4,900   | 4,900
 *   22,000    | 11,000    | 5,300   | 5,000
 *
 * The 0.5× flat budget is shown for reference — the tapered budget is
 * what the review graph actually uses at each scale.
 */
export const REVIEW_GRAPH_TAPER_THRESHOLD = 3_000 satisfies number;
export const REVIEW_GRAPH_TAPER_BASE_BUDGET = 1_500 satisfies number;
export const REVIEW_GRAPH_TAPER_SLOPE = 0.2 satisfies number;
export const REVIEW_GRAPH_HARD_CEILING = 5_000 satisfies number;



/**
 * Scale a ratio from {@link PROJECT_SCALE_RATIOS} by the resolved base,
 * rounding to the nearest integer and flooring at 1 (a budget of 0 would
 * degrade every scan to "nothing scanned", never the intent of a large-repo
 * knob).
 */
export function deriveBudget(ratio: number, cwd?: string): number {
	return Math.max(1, Math.round(getProjectScaleBase(cwd) * ratio));
}

/** Derived project-diagnostics scanner budget (files). See {@link deriveBudget}. */
export function getProjectDiagnosticsScannerMaxFiles(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner, cwd);
}

/**
 * Adaptive review-graph budget (files), replacing the flat 0.5× ratio (#775).
 *
 * At or below {@link REVIEW_GRAPH_TAPER_THRESHOLD} the original 0.5× ratio
 * applies unchanged. Above it the ratio tapers linearly toward
 * {@link REVIEW_GRAPH_HARD_CEILING} — see the REVIEW_GRAPH_TAPER_* constants
 * for the formula and rationale.
 */
export function getReviewGraphMaxFilesDerived(cwd?: string): number {
	const base = getProjectScaleBase(cwd);
	const flatBudget = Math.max(1, Math.round(base * PROJECT_SCALE_RATIOS.reviewGraph));
	if (base <= REVIEW_GRAPH_TAPER_THRESHOLD) {
		return flatBudget;
	}
	const taperBudget =
		REVIEW_GRAPH_TAPER_BASE_BUDGET +
		Math.round((base - REVIEW_GRAPH_TAPER_THRESHOLD) * REVIEW_GRAPH_TAPER_SLOPE);
	return Math.min(taperBudget, REVIEW_GRAPH_HARD_CEILING);
}

/** Derived startup-scan budget (source files). See {@link deriveBudget}. */
export function getStartupScanMaxSourceFilesDerived(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.startupScan, cwd);
}

/** Derived jscpd budget (directory entries). See {@link deriveBudget}. */
export function getJscpdMaxEntriesDerived(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.jscpd, cwd);
}

/** Derived word-index budget (files). See {@link deriveBudget}. */
export function getWordIndexMaxFilesDerived(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.wordIndex, cwd);
}
