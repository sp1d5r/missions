/**
 * Point a head at one real mission and see what it says.
 *
 * The spike scores heads against a corpus. This is the other direction: take a single run —
 * including one that just finished — and ask the heads whether its claims were earned. It is the
 * shape a real head would have if it ran live, minus the cache replay: same prompt, same model,
 * same input (the worker's claim, the commands it actually ran, what it left undone, and the
 * orchestrator's rulings).
 *
 * Usage: node spike/heads/judge-run.mjs <outDir> [--heads confidence,assumption]
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { complete, parseJson } = await import("../../dist/llm.js");
const { autoRouting } = await import("../../dist/models.js");

const argv = process.argv.slice(2);
const outDir = argv.find((a) => !a.startsWith("--"));
const headsArg = argv.indexOf("--heads");
const HEAD_NAMES = String(headsArg === -1 ? "confidence,direction,assumption" : argv[headsArg + 1]).split(",");

if (!outDir) {
	console.error("usage: node spike/heads/judge-run.mjs <outDir> [--heads a,b]");
	process.exit(1);
}
const statePath = join(outDir, "state.json");
if (!existsSync(statePath)) {
	console.error(`no state.json at ${statePath}`);
	process.exit(1);
}

function loadHead(name) {
	const raw = readFileSync(join(HERE, "heads", `${name}.md`), "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	return { name, system: (m?.[2] ?? raw).trim() };
}
const clip = (s, n) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

const s = JSON.parse(readFileSync(statePath, "utf8"));
const heads = HEAD_NAMES.map(loadHead);
const model = autoRouting().worker;

// The contract is on the plan, not the feature. Reading `feature.assertions` yields nothing and
// silently strips the contract out of the prompt — which is the difference between a head that
// catches a bad disposition and one that never sees the evidence it is supposed to weigh.
const assertions = (s.plan?.contract?.assertions || []).map((a) => ({
	status: a.passed === true ? "passed" : a.passed === false ? "FAILED" : "not run",
	strength: a.strength ?? "?",
	what: a.method?.command || a.statement || a.id,
}));

const turns = [];
for (const h of s.handoffs || []) {
	const f = (s.features || []).find((x) => x.id === h.featureId);
	turns.push({
		id: `${h.featureId}-m${h.milestone}`,
		kind: "handoff",
		prompt: [
			`MISSION GOAL:\n${clip(s.goal, 600)}`,
			s.rfc ? `RFC (excerpt):\n${clip(s.rfc, 900)}` : null,
			`THIS WORKER'S FEATURE:\n${clip(f ? `${f.title || f.id}: ${f.description || ""}` : h.featureId, 500)}`,
			`\nTHE TURN — what the worker reports it completed:\n${clip(h.completed, 1800)}`,
			`\nCOMMANDS THE WORKER ACTUALLY RAN:\n${(h.commands || []).map((c) => `  [exit ${c.exitCode}] ${clip(c.command, 220)}`).join("\n") || "  (none)"}`,
			`\nWHAT THE WORKER SAYS IT LEFT UNDONE:\n${(h.leftUndone || []).map((u) => `  - ${clip(u, 200)}`).join("\n") || "  (nothing)"}`,
			(h.issues || []).length
				? `\nISSUES THE WORKER RAISED:\n${h.issues.map((i) => `  - ${clip(i.summary, 160)}: ${clip(i.detail, 300)}`).join("\n")}`
				: "",
		]
			.filter(Boolean)
			.join("\n"),
	});
	for (const [n, i] of (h.issues || []).entries()) {
		if (!i.disposition) continue;
		turns.push({
			id: `${h.featureId}-issue${n + 1}`,
			kind: "disposition",
			prompt: [
				`MISSION GOAL:\n${clip(s.goal, 600)}`,
				`\nAN ISSUE THE WORKER RAISED:\n  ${clip(i.summary, 200)}\n  ${clip(i.detail, 700)}`,
				`\nTHE ORCHESTRATOR'S RULING: ${i.disposition}`,
				`ITS STATED REASON:\n  ${clip(i.dispositionNote, 700)}`,
				assertions.length
					? `\nWHAT THE VALIDATION CONTRACT ACTUALLY RAN:\n${assertions.map((a) => `  - [${a.status}] ${clip(a.what, 220)}`).join("\n")}`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		});
	}
}

console.log(`judging ${s.id ?? outDir}`);
console.log(`  verdict   ${s.finalVerdict?.status ?? s.status}  ·  $${(s.costUsd ?? 0).toFixed(2)}`);
console.log(`  contract  ${assertions.filter((a) => a.status === "passed").length}/${assertions.length} assertions passed`);
console.log(`  turns     ${turns.length}  ·  heads ${heads.map((h) => h.name).join(", ")}\n`);

let cost = 0;
for (const t of turns) {
	for (const h of heads) {
		let decision = "error";
		let why = "";
		try {
			const { text, costUsd } = await complete(model, h.system, t.prompt);
			cost += costUsd;
			const p = parseJson(text);
			decision = String(p?.decision ?? "unparseable").toLowerCase();
			why = String(p?.why ?? (text ? `RAW: ${text.slice(0, 160)}` : "EMPTY REPLY")).trim();
		} catch (err) {
			why = err instanceof Error ? err.message : String(err);
		}
		if (decision === "noop") continue; // silence is the expected output; print only what spoke
		const mark = decision === "flag" ? "⚑" : decision === "note" ? "·" : "?";
		console.log(`${mark} [${h.name}] ${t.id} (${t.kind}) → ${decision}`);
		console.log(`    ${why}\n`);
	}
}
console.log(`(heads stayed silent on everything not listed)  spend $${cost.toFixed(3)}`);
