import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [baseRoot, fixedRoot, output] = process.argv.slice(2);
if (!baseRoot || !fixedRoot || !output) {
	throw new Error("usage: node collect-smoke-verdicts.mjs BASE FIXED OUTPUT");
}

const kinds = [
	"timeout",
	"exception",
	"server_error",
	"parser_error",
	"unconfirmed_output",
	"output_limit",
	"tool_not_found",
	"future_fault_kind",
	undefined,
];
const variants = [];
for (const [name, root] of [["Base", baseRoot], ["Fixed", fixedRoot]]) {
	const { classify } = await import(pathToFileURL(path.join(root, "scripts/smoke-tools.mjs")));
	const rows = [];
	for (const kind of kinds) {
		for (const diagnostics of [[], [{ message: "synthetic runner fault" }]]) {
			const input = {
				result: {
					status: "failed",
					...(kind === undefined ? {} : { failureKind: kind }),
					failureMessage: "could not evaluate output",
					diagnostics,
				},
			};
			rows.push({ input, verdict: classify(input) });
		}
	}
	variants.push({ name, rows });
}

const report = {
	repository: "https://github.com/apmantza/pi-lens",
	baseSha: "e804c35fc011cee50b54a9859acc91e076df576a",
	source: "scripts/smoke-tools.mjs:classify",
	method: "Call the exported smoke classifier with nine failed runner kinds, with and without a synthetic diagnostic.",
	variants,
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
for (const { name, rows } of variants) {
	const falsePasses = rows.filter(({ verdict }) => verdict.state === "pass");
	console.log(`${name}: ${falsePasses.length}/${rows.length} fault scenarios counted as pass`);
}
