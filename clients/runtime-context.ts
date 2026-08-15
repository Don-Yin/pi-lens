import type { CacheManager } from "./cache-manager.js";
import type { TurnEndFindingsCache } from "./git-guard.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	provenanceStamp,
	validateAdvisoryProvenance,
	type AdvisoryProvenance,
} from "./advisory-provenance.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";

// Exported so the Stop-hook bin strips exactly what these bridges prepend.
export const AUTOMATION_FRAMING =
	"[pi-lens automated check — not a user request] ";

type ContextResult = { messages: Array<{ role: "user"; content: string }> };

export interface DiagnosticModelCapacity {
	provider?: unknown;
	modelId?: unknown;
	contextWindow?: unknown;
	maxOutputTokens?: unknown;
	contextTokens?: unknown;
}

function boundedLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const label = value.trim();
	return label.length > 0 ? label.slice(0, 160) : undefined;
}

function positiveTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

function nonNegativeTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

function formatTokenCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function formatDiagnosticModelCapacity(
	capacity: DiagnosticModelCapacity | undefined,
): string | undefined {
	if (!capacity) return undefined;
	const provider = boundedLabel(capacity.provider);
	const modelId = boundedLabel(capacity.modelId);
	const contextWindow = positiveTokenCount(capacity.contextWindow);
	const maxOutputTokens = positiveTokenCount(capacity.maxOutputTokens);
	const contextTokens = nonNegativeTokenCount(capacity.contextTokens);
	if (!contextWindow && !maxOutputTokens) return undefined;
	const parts: string[] = [];
	if (provider && modelId) parts.push(`${provider}/${modelId}`);
	else if (modelId) parts.push(modelId);
	else if (provider) parts.push(provider);
	if (contextWindow) {
		parts.push(`context window ${formatTokenCount(contextWindow)} tokens`);
	}
	if (maxOutputTokens) {
		parts.push(`max output ${formatTokenCount(maxOutputTokens)} tokens`);
	}
	if (contextWindow && contextTokens !== undefined) {
		const percentage = Math.round((contextTokens / contextWindow) * 100);
		parts.push(
			`current context ${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)} tokens (${percentage}%)`,
		);
	}
	return [
		`Model capacity: ${parts.join(", ")}.`,
		"Capacity changes batching only. For required fixes, fix root causes; do not suppress, defer, or mark findings resolved merely to fit this turn.",
		"If the backlog does not fit, use lens_diagnostics with paths and resolve it in bounded batches while keeping unresolved findings live.",
	].join("\n");
}

function historicalPrefix(provenance: AdvisoryProvenance | undefined): string {
	return `Historical finding; workspace changed since capture; re-run to confirm. (${provenanceStamp(provenance)})`;
}

function historicalTestContent(content: string, provenance?: AdvisoryProvenance): string {
	return content.startsWith("[from a prior turn")
		? content
		: `${historicalPrefix(provenance)}\n\n${content}`;
}

function turnEndMessage(
	content: string,
	current: boolean,
	provenance?: AdvisoryProvenance,
	capacity?: DiagnosticModelCapacity,
): { role: "user"; content: string } {
	if (!current) {
		return {
			role: "user",
			content: `${AUTOMATION_FRAMING}${historicalPrefix(provenance)}\n\n${content}`,
		};
	}
	const capacityGuidance = formatDiagnosticModelCapacity(capacity);
	return {
		role: "user",
		content: `${AUTOMATION_FRAMING}Address 🔴 blockers before continuing; ℹ️ advisories are informational only.${capacityGuidance ? `\n${capacityGuidance}` : ""}\n\n${content}`,
	};
}

/** Read a turn-end finding without changing its durable delivery state. */
export function peekTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
	capacity?: DiagnosticModelCapacity,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	if (validation.allFilesDeleted) return;
	return {
		messages: [turnEndMessage(
			findings.data.content,
			validation.status === "current",
			findings.data.provenance,
			capacity,
		)],
	};
}

export function consumeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
	capacity?: DiagnosticModelCapacity,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);

	// A blocker record is also the opt-in commit gate's durable state. Mark the
	// context message consumed without deleting the record; clean/advisory-only
	// records retain the historical consume-and-clear behavior.
	if (
		findings.data.hasBlockers === true &&
		typeof findings.data.sessionId === "string"
	) {
		cacheManager.writeCache(
			"turn-end-findings",
			{ ...findings.data, consumed: true },
			cwd,
		);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}
	if (validation.allFilesDeleted) return;
	return {
		messages: [turnEndMessage(
			findings.data.content,
			validation.status === "current",
			findings.data.provenance,
			capacity,
		)],
	};
}

/** Read test findings without consuming them; used by acknowledged IPC delivery. */
export function peekTestFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	);
	if (!findings?.data?.content) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	if (validation.allFilesDeleted) return;
	const current = validation.status === "current";
	return {
		messages: [
			{
				role: "user",
				content: current
					? `${AUTOMATION_FRAMING}Test failures detected last turn — fix before continuing:\n\n${findings.data.content}`
					: `${AUTOMATION_FRAMING}${historicalTestContent(findings.data.content, findings.data.provenance)}`,
			},
		],
	};
}

export function consumeTestFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = peekTestFindings(cacheManager, cwd, runtime);
	if (!findings) return;
	// Retire the content but PRESERVE the generation high-water mark: nulling
	// the whole slot would let a still-in-flight OLDER batch see `undefined`,
	// pass the strictly-greater suppression check, and resurrect a consumed
	// one-shot advisory with stale results. An empty-content record peeks as
	// undelivered while keeping late-generation ordering intact.
	const priorGeneration = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	)?.data?.testRunGeneration;
	cacheManager.writeCache(
		"test-runner-findings",
		{ content: "", testRunGeneration: priorGeneration } as TestRunnerFindingsCache,
		cwd,
	);
	return findings;
}

/** Complete an acknowledged MCP delivery without re-validating or re-rendering it. */
export function acknowledgeTurnEndFindings(cacheManager: CacheManager, cwd: string): void {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>("turn-end-findings", cwd);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	if (findings.data.hasBlockers === true && typeof findings.data.sessionId === "string") {
		cacheManager.writeCache("turn-end-findings", { ...findings.data, consumed: true }, cwd);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}
}

export function acknowledgeTestFindings(cacheManager: CacheManager, cwd: string): void {
	const findings = cacheManager.readCache<TestRunnerFindingsCache>("test-runner-findings", cwd);
	if (!findings?.data?.content) return;
	// Same high-water-mark preservation as consumeTestFindings.
	cacheManager.writeCache(
		"test-runner-findings",
		{
			content: "",
			testRunGeneration: findings.data.testRunGeneration,
		} as TestRunnerFindingsCache,
		cwd,
	);
}

export function consumeSessionStartGuidance(
	cacheManager: CacheManager,
	cwd: string,
): ContextResult | undefined {
	const guidance = cacheManager.readCache<{ content: string }>(
		"session-start-guidance",
		cwd,
	);
	if (!guidance?.data?.content) return;

	cacheManager.writeCache(
		"session-start-guidance",
		null as unknown as { content: string },
		cwd,
	);

	return {
		messages: [
			{
				role: "user",
				content: `[pi-lens automated context — not a user request]\n\n${guidance.data.content}`,
			},
		],
	};
}
