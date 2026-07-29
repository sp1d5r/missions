import { checkPlan, checkBoundary, blocking, warnings, formatViolations } from "../dist/invariants.js";

let fails = 0;
const t = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
	else console.log(`ok   ${name}`);
};
const names = (vs) => vs.map((v) => v.invariant).sort();

const a = (id, extra = {}) => ({ id, statement: `s-${id}`, method: { type: "bash-command", command: "true", expectedExitCode: 0 }, ...extra });
const f = (id, assertionIds) => ({ id, title: `t-${id}`, description: `d-${id}`, assertionIds });
// A plan the harness considers complete draws the part of the system it touches. Kept in one
// place so a case that cares about something else does not have to restate it.
const ARCH = 'flowchart LR\n  A["src/a.ts"] --> B["src/b.ts"]:::touched\n  classDef touched stroke:#d08b28';

// ---- checkPlan --------------------------------------------------------------

// THE BUG: an empty contract used to score 0/0 and report CLEAN.
t("empty contract blocks",
	names(blocking(checkPlan({ summary: "", architectureNote: "", features: [f("f1", [])], contract: { assertions: [] } }))),
	["contract.non-empty"]);

t("healthy plan is silent",
	checkPlan({ summary: "", architectureNote: "", architecture: ARCH, features: [f("f1", ["a1"])], contract: { assertions: [a("a1")] } }),
	[]);

// A plan that draws nothing is worse but still runnable, so it warns rather than blocks.
t("plan with no diagram warns, never blocks",
	names(checkPlan({ summary: "", architectureNote: "", features: [f("f1", ["a1"])], contract: { assertions: [a("a1")] } })),
	["plan.architecture"]);

t("a missing diagram never blocks the run",
	names(blocking(checkPlan({ summary: "", architectureNote: "", features: [f("f1", ["a1"])], contract: { assertions: [a("a1")] } }))),
	[]);

t("hallucinated method type blocks",
	names(blocking(checkPlan({ summary: "", architectureNote: "", features: [f("f1", ["a1"])],
		contract: { assertions: [{ id: "a1", statement: "s", method: { type: "unit-test" } }] } }))),
	["assertion.method-valid"]);

t("missing method blocks (would also crash the validator)",
	names(blocking(checkPlan({ summary: "", architectureNote: "", features: [f("f1", ["a1"])],
		contract: { assertions: [{ id: "a1", statement: "s" }] } }))),
	["assertion.method-valid"]);

t("feature claiming a nonexistent assertion blocks",
	names(blocking(checkPlan({ summary: "", architectureNote: "", features: [f("f1", ["a9"])], contract: { assertions: [a("a1")] } }))),
	["feature.assertions-exist"]);

t("duplicate assertion ids block",
	names(blocking(checkPlan({ summary: "", architectureNote: "", features: [f("f1", ["a1"])], contract: { assertions: [a("a1"), a("a1")] } }))),
	["assertion.id-unique"]);

t("unowned assertion only warns (--max-features truncates legitimately)",
	names(warnings(checkPlan({ summary: "", architectureNote: "", architecture: ARCH, features: [f("f1", ["a1"])], contract: { assertions: [a("a1"), a("a2")] } }))),
	["assertion.owned"]);

// ---- checkBoundary ----------------------------------------------------------

const sc = (bugs = []) => ({ assertionsPassed: 1, assertionsTotal: 1, checks: [], bugs, costUsd: 0 });
const handoff = (issues) => ({ featureId: "f1", milestone: 1, completed: "", leftUndone: [], commands: [],
	issues, proceduresFollowed: true, assertionsClaimed: [], confidence: "high", stopReason: "", aborted: false, costUsd: 0 });

t("clean pass is silent",
	checkBoundary({ assertions: [a("a1", { passed: true })], scoreCard: sc(), handoffs: [handoff([])],
		verdict: "passed", corrections: [], dispatchedFeatureIds: ["f1"] }),
	[]);

t("orchestrator declaring victory over a failing assertion blocks",
	names(blocking(checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(), handoffs: [handoff([])],
		verdict: "passed", corrections: [], dispatchedFeatureIds: ["f1"] }))),
	["verdict.evidence-backed"]);

t("issue ruled addressed with no correction named blocks",
	names(blocking(checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(),
		handoffs: [handoff([{ summary: "legacy var usage", disposition: "addressed" }])],
		verdict: "needs-corrections", corrections: [{ id: "m2c1", title: "x", description: "y", assertionIds: ["a1"] }],
		dispatchedFeatureIds: ["f1"] }))),
	["ruling.addressed-names-correction"]);

t("issue addressed by a correction that is not dispatched blocks",
	names(blocking(checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(),
		handoffs: [handoff([{ summary: "x", disposition: "addressed", addressedBy: "m2c2" }])],
		verdict: "needs-corrections", corrections: [{ id: "m2c1", title: "x", description: "y", assertionIds: ["a1"] }],
		dispatchedFeatureIds: ["f1"] }))),
	["ruling.addressed-is-dispatched"]);

t("issue addressed by a dispatched correction is fine",
	checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(),
		handoffs: [handoff([{ summary: "x", disposition: "addressed", addressedBy: "m2c1" }])],
		verdict: "needs-corrections", corrections: [{ id: "m2c1", title: "x", description: "y", assertionIds: ["a1"] }],
		dispatchedFeatureIds: ["f1"] }),
	[]);

t("correction reusing a dispatched id blocks",
	names(blocking(checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(), handoffs: [handoff([])],
		verdict: "needs-corrections", corrections: [{ id: "f1", title: "x", description: "y", assertionIds: ["a1"] }],
		dispatchedFeatureIds: ["f1"] }))),
	["correction.id-fresh"]);

t("correction resolving nothing blocks",
	names(blocking(checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(), handoffs: [handoff([])],
		verdict: "needs-corrections", corrections: [{ id: "m2c1", title: "x", description: "y", assertionIds: [] }],
		dispatchedFeatureIds: ["f1"] }))),
	["correction.addresses-something"]);

t("scorecard counting a different contract blocks",
	names(blocking(checkBoundary({ assertions: [a("a1", { passed: true }), a("a2", { passed: true })], scoreCard: sc(),
		handoffs: [handoff([])], verdict: "passed", corrections: [], dispatchedFeatureIds: ["f1"] }))),
	["scorecard.covers-contract"]);

t("unruled issue warns and carries forward",
	names(warnings(checkBoundary({ assertions: [a("a1", { passed: false })], scoreCard: sc(),
		handoffs: [handoff([{ summary: "unruled thing" }])],
		verdict: "needs-corrections", corrections: [{ id: "m2c1", title: "x", description: "y", assertionIds: ["a1"] }],
		dispatchedFeatureIds: ["f1"] }))),
	["issue.ruled"]);

t("correction redoing passing work warns",
	names(warnings(checkBoundary({ assertions: [a("a1", { passed: true }), a("a2", { passed: false })],
		scoreCard: { assertionsPassed: 1, assertionsTotal: 2, checks: [], bugs: [], costUsd: 0 }, handoffs: [handoff([])],
		verdict: "needs-corrections", corrections: [{ id: "m2c1", title: "x", description: "y", assertionIds: ["a1"] }],
		dispatchedFeatureIds: ["f1"] }))),
	["correction.targets-failure"]);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
