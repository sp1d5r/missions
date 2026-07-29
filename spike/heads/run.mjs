/**
 * Phase 1 spike — does a head say anything worth reading?
 *
 * The RFC's original phase 1 measured the cache-hit rate. That answers "can we afford heads?"
 * before anything has established heads are worth affording, and it cannot run until the replay
 * plumbing exists. This measures the thing that decides whether to build at all, and it runs
 * today against runs already on disk.
 *
 * Two numbers per head:
 *
 *   RECALL — of the labelled known-bad cases (verbatim from CONTRACTS.md), how many does it catch?
 *            A head that misses Run B's "validators independently confirmed the code behavior" has
 *            failed at the one job it exists to do.
 *
 *   FLAG RATE — over every real handoff and disposition on this machine, how often does it fire?
 *            This is the number a human pays. The RFC's own stated risk is "a confidence head that
 *            flags every hedge is worse than nothing"; this is that risk, measured.
 *
 * A `naive` control head runs alongside — an undisciplined prompt over the same fixtures. If the
 * disciplined heads score the same as the control, the head *prompt* is doing nothing and we are
 * just measuring the model.
 *
 * Heads run on the WORKER model, deliberately. In production a head cache-reads the worker's
 * prefix, and Anthropic caches are keyed per model — so a head on a cheaper model is a different
 * experiment from the one we would ship.
 *
 * Usage: node spike/heads/run.mjs [--heads confidence,direction] [--limit N] [--concurrency N]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { labelledFixtures, realFixtures } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { complete, parseJson } = await import("../../dist/llm.js");
const { autoRouting } = await import("../../dist/models.js");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};

const HEAD_NAMES = String(arg("heads", "confidence,direction,assumption,naive")).split(",");
const LIMIT = Number(arg("limit", Infinity));
const CONCURRENCY = Number(arg("concurrency", 6));

/** Strip frontmatter — the body is the system prompt, same shape as .missions/agents/*.md. */
function loadHead(name) {
	const raw = readFileSync(join(HERE, "heads", `${name}.md`), "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	return { name, system: (m?.[2] ?? raw).trim() };
}

/** Run `fn` over `items` with a fixed number in flight. */
async function pool(items, n, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

const heads = HEAD_NAMES.map(loadHead);
const model = autoRouting().worker;
const fixtures = [...labelledFixtures(), ...realFixtures()].slice(0, LIMIT);

const real = fixtures.filter((f) => f.source !== "contracts" && f.expect === null);
const labelled = fixtures.filter((f) => f.expect !== null);

console.log(`head-quality spike`);
console.log(`  model      ${model.provider}:${model.modelId}  (worker seat — the one heads must share)`);
console.log(`  heads      ${heads.map((h) => h.name).join(", ")}`);
console.log(`  fixtures   ${labelled.length} labelled, ${real.length} real  →  ${fixtures.length * heads.length} calls`);
console.log("");

const jobs = heads.flatMap((h) => fixtures.map((f) => ({ head: h, fixture: f })));
let done = 0;
let cost = 0;

const results = await pool(jobs, CONCURRENCY, async ({ head, fixture }) => {
	let decision = "error";
	let why = "";
	let evidence = "";
	try {
		const { text, costUsd } = await complete(model, head.system, fixture.prompt);
		cost += costUsd;
		const parsed = parseJson(text);
		decision = String(parsed?.decision ?? "unparseable").toLowerCase();
		// Keep the raw reply when it did not parse — a silent "unparseable" hides auth failures
		// and empty completions, which is how a spike ends up measuring nothing.
		why = String(parsed?.why ?? (text ? `RAW: ${text.slice(0, 200)}` : "EMPTY REPLY")).trim();
		evidence = String(parsed?.evidence ?? "").trim();
	} catch (err) {
		why = err instanceof Error ? err.message : String(err);
	}
	done++;
	process.stdout.write(`\r  ${done}/${jobs.length} calls  $${cost.toFixed(3)}   `);
	return { head: head.name, fixture: fixture.id, source: fixture.source, kind: fixture.kind, expect: fixture.expect, expectHead: fixture.head, decision, why, evidence };
});
console.log("\n");

// ---- scoring -------------------------------------------------------------

const byHead = new Map(heads.map((h) => [h.name, results.filter((r) => r.head === h.name)]));
const pct = (a, b) => (b === 0 ? "  — " : `${String(Math.round((100 * a) / b)).padStart(3)}%`);

console.log("RECALL — labelled cases, scored only against the head that owns them");
console.log("  case                          expect  " + heads.map((h) => h.name.slice(0, 10).padEnd(11)).join(""));
for (const f of labelled) {
	const row = heads
		.map((h) => {
			const r = results.find((x) => x.head === h.name && x.fixture === f.id);
			const owns = f.head === h.name;
			const hit = f.expect === "flag" ? r.decision === "flag" : r.decision === "noop";
			const mark = hit ? "✓" : r.decision === "note" ? "~" : "✗";
			return `${owns ? mark : "·"} ${r.decision}`.padEnd(11);
		})
		.join("");
	console.log(`  ${f.id.replace("labelled/", "").padEnd(29)} ${String(f.expect).padEnd(7)} ${row}`);
}
console.log("  (· = not this head's case; ~ = note, a half-credit answer)\n");

console.log("FLAG RATE — the real corpus, i.e. what a human would have to read");
console.log("  head          flag   note   noop   err   flag-rate");
for (const h of heads) {
	const rs = byHead.get(h.name).filter((r) => r.expect === null);
	const n = (d) => rs.filter((r) => r.decision === d).length;
	const bad = rs.filter((r) => r.decision !== "flag" && r.decision !== "note" && r.decision !== "noop").length;
	console.log(
		`  ${h.name.padEnd(12)} ${String(n("flag")).padStart(4)}  ${String(n("note")).padStart(5)}  ${String(n("noop")).padStart(5)}  ${String(bad).padStart(4)}   ${pct(n("flag"), rs.length)}`,
	);
}
console.log("");

const owned = labelled.filter((f) => f.expect === "flag");
const goodCases = labelled.filter((f) => f.expect === "noop");
console.log("VERDICT PER HEAD");
for (const h of heads) {
	const rs = byHead.get(h.name);
	const mine = owned.filter((f) => f.head === h.name);
	const caught = mine.filter((f) => rs.find((r) => r.fixture === f.id)?.decision === "flag").length;
	const quiet = goodCases
		.filter((f) => f.head === h.name)
		.filter((f) => rs.find((r) => r.fixture === f.id)?.decision === "noop").length;
	const myGood = goodCases.filter((f) => f.head === h.name).length;
	const realRs = rs.filter((r) => r.expect === null);
	const rate = realRs.length ? (100 * realRs.filter((r) => r.decision === "flag").length) / realRs.length : 0;
	console.log(
		`  ${h.name.padEnd(12)} caught ${caught}/${mine.length} known-bad · stayed quiet on ${quiet}/${myGood} known-good · fires on ${rate.toFixed(0)}% of real turns`,
	);
}
console.log("");

console.log("EVERY FLAG RAISED ON THE REAL CORPUS — adjudicate these by hand");
const flags = results.filter((r) => r.expect === null && r.decision === "flag");
if (!flags.length) console.log("  (none)");
for (const r of flags) {
	console.log(`  [${r.head}] ${r.fixture}`);
	console.log(`     why:      ${r.why}`);
	console.log(`     evidence: ${r.evidence}`);
}
console.log("");

const out = join(HERE, "results.json");
writeFileSync(out, JSON.stringify({ model, cost, results }, null, "\t"));
console.log(`spend $${cost.toFixed(3)} · full results → ${out}`);
