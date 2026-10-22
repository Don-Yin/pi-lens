// Temporary measurement probe; not part of the proposed patch.
import { performance } from "node:perf_hooks";
import { it } from "vitest";
import { runTurnScenario } from "../support/turn-harness.js";

it("measures confirmed-clean turn-end delivery", async () => {
	for (const fileCount of [1, 10]) {
		for (let repeat = 0; repeat < 6; repeat += 1) {
			await runTurnScenario({
				id: `provenance-measurement-${fileCount}-${repeat}`,
				incident: "Confirmed-clean resolution received a historical label",
				issue: "#4617",
				async run(h) {
					const files = Array.from({ length: fileCount }, (_, index) => {
						const relative = `src/value-${index}.ts`;
						return {
							relative,
							absolute: h.write(relative, "export const value = 1;\n"),
						};
					});
					h.runtime.beginTurn();
					for (const file of files) {
						h.blocker(file.relative, "L1: type mismatch");
						h.runtime.retireInlineBlockerOnConfirmedClean(
							file.absolute,
							h.runtime.nextWriteOrderToken(),
							["lsp"],
						);
					}
					const started = performance.now();
					const view = await h.turnEnd();
					const elapsedMs = performance.now() - started;
					process.stdout.write(
						"PROVENANCE_MEASUREMENT " + JSON.stringify({
							condition: process.env.PROVENANCE_CONDITION,
							fileCount,
							repeat,
							elapsedMs,
							text: view.text,
						}) + "\n",
					);
				},
			});
		}
	}
});
