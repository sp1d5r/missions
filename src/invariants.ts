/**
 * Harness invariants — the rules the models are not trusted to keep.
 *
 * Everywhere else in this codebase we parse model output leniently: a missing
 * field becomes `""`, a malformed list becomes `[]`. That is the right instinct
 * for prose and the wrong one for structure, because a coerced-away contract is
 * indistinguishable from a satisfied one. An empty assertion list scores 0/0,
 * 0/0 has no failures, and no failures reads as CLEAN. The harness would then
 * report success for a mission that proved nothing.
 *
 * So the coercions stay — they keep the run alive — and the semantic checks live
 * here, in one list, run at the two moments where a lie becomes load-bearing:
 *
 *   checkPlan      — at the door, before a single worker is paid for.
 *   checkBoundary  — at the ledger, before a milestone verdict is believed.
 *
 * Each invariant has a stable name. When one fires, that name goes into the
 * mission log and the report, so "why did this stall" is answered by a string
 * you can grep for rather than by re-reading the loop.
 *
 * Two severities, and the difference matters:
 *   block — the state is incoherent. Stop; a human decides.
 *   warn  — legal but suspicious. Say it loudly and keep going.
 */

import type { Assertion, Feature, Handoff, Plan, ScoreCard } from "./types.js";

export type Severity = "block" | "warn";

export interface Violation {
	/** Stable, greppable name — e.g. "contract.non-empty". */
	invariant: string;
	severity: Severity;
	detail: string;
}

export function formatViolations(violations: Violation[]): string {
	return violations.map((v) => `  [${v.invariant}] ${v.detail}`).join("\n");
}

export const blocking = (violations: Violation[]): Violation[] => violations.filter((v) => v.severity === "block");
export const warnings = (violations: Violation[]): Violation[] => violations.filter((v) => v.severity === "warn");

function duplicates(ids: string[]): string[] {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) dupes.add(id);
		seen.add(id);
	}
	return [...dupes];
}

const snip = (s: string, n = 70): string => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------------------------------------------------------------------
// At the door: the plan.
// ---------------------------------------------------------------------------

const METHOD_TYPES = new Set(["bash-command", "behavioral", "code-review"]);

/**
 * The validator's method dispatch ends in an `else` that treats anything it does
 * not recognise as a code-review assertion — which passes whenever the bug
 * spotter is quiet. An invented method type would therefore prove itself.
 */
function methodProblem(a: Assertion): string | undefined {
	const m = a.method as { type?: unknown; command?: unknown; scenario?: unknown } | undefined;
	if (!m || typeof m !== "object" || typeof m.type !== "string") return "has no validation method";
	if (!METHOD_TYPES.has(m.type)) return `unknown method type "${m.type}" — validators would silently score it as a code-review`;
	if (m.type === "bash-command" && !String(m.command ?? "").trim()) return "is a bash-command assertion with no command";
	if (m.type === "behavioral" && !String(m.scenario ?? "").trim()) return "is a behavioral assertion with no scenario";
	return undefined;
}

/** Is this plan coherent enough to spend money on? */
export function checkPlan(plan: Plan): Violation[] {
	const v: Violation[] = [];
	const push = (invariant: string, severity: Severity, detail: string) => v.push({ invariant, severity, detail });

	const assertions = plan.contract?.assertions ?? [];
	const features = plan.features ?? [];

	// The one that started this: an empty contract makes every milestone pass 0/0.
	if (!assertions.length) {
		push("contract.non-empty", "block", "the validation contract has no assertions — every milestone would pass 0/0 and report CLEAN");
	}
	if (!features.length) push("plan.has-features", "block", "the plan has no features, so no work would be dispatched");

	for (const id of duplicates(assertions.map((a) => a.id))) {
		push("assertion.id-unique", "block", `assertion id "${id}" is used more than once — results would overwrite each other`);
	}
	for (const id of duplicates(features.map((f) => f.id))) {
		push("feature.id-unique", "block", `feature id "${id}" is used more than once`);
	}

	for (const a of assertions) {
		if (!String(a.statement ?? "").trim()) push("assertion.statement-non-empty", "block", `${a.id} has no statement — nothing to prove`);
		const problem = methodProblem(a);
		if (problem) push("assertion.method-valid", "block", `${a.id} ${problem}`);
	}

	const contractIds = new Set(assertions.map((a) => a.id));
	const owned = new Set<string>();
	for (const f of features) {
		for (const id of f.assertionIds ?? []) {
			if (contractIds.has(id)) owned.add(id);
			else push("feature.assertions-exist", "block", `${f.id} claims assertion "${id}", which is not in the contract`);
		}
		if (!String(f.description ?? "").trim()) push("feature.description-non-empty", "warn", `${f.id} has an empty description — the worker gets a title and nothing else`);
	}

	// Not fatal: --max-features truncates the queue, so a plan legitimately carries
	// assertions no dispatched feature owns. Worth saying out loud all the same.
	for (const a of assertions) {
		if (!owned.has(a.id)) push("assertion.owned", "warn", `${a.id} is claimed by no feature — nobody is on the hook for it`);
	}

	return v;
}

// ---------------------------------------------------------------------------
// At the ledger: the milestone boundary.
// ---------------------------------------------------------------------------

export interface BoundaryFacts {
	/** The full contract, after validators have marked it. */
	assertions: Assertion[];
	scoreCard: ScoreCard;
	/** This milestone's handoffs, AFTER rulings have been stamped onto their issues. */
	handoffs: Handoff[];
	/** The orchestrator's verdict for this boundary. */
	verdict: "passed" | "needs-corrections" | "stalled";
	/** Corrections that will ACTUALLY be dispatched — post-cap, not what was proposed. */
	corrections: Feature[];
	/** Every feature id dispatched so far this mission, including this milestone's. */
	dispatchedFeatureIds: string[];
}

/** Is this boundary's verdict backed by what actually happened? */
export function checkBoundary(facts: BoundaryFacts): Violation[] {
	const v: Violation[] = [];
	const push = (invariant: string, severity: Severity, detail: string) => v.push({ invariant, severity, detail });

	const { assertions, scoreCard, handoffs, verdict, corrections, dispatchedFeatureIds } = facts;
	const failing = assertions.filter((a) => !a.passed);
	const blockingBugs = scoreCard.bugs.filter((b) => b.severity === "critical" || b.severity === "high");
	const issues = handoffs.flatMap((h) => h.issues);
	const unruled = issues.filter((i) => !i.disposition);

	// The score card must be scoring THIS contract. A mismatch means assertions were
	// added, dropped, or silently skipped between planning and validation.
	if (scoreCard.assertionsTotal !== assertions.length) {
		push(
			"scorecard.covers-contract",
			"block",
			`score card counted ${scoreCard.assertionsTotal} assertion(s) but the contract has ${assertions.length}`,
		);
	}

	// The orchestrator does not get to declare victory over the evidence.
	if (verdict === "passed" && (failing.length || blockingBugs.length || unruled.length)) {
		push(
			"verdict.evidence-backed",
			"block",
			`orchestrator returned "passed" with ${failing.length} failing assertion(s), ${blockingBugs.length} blocking bug(s), ${unruled.length} unruled issue(s)`,
		);
	}

	for (const i of unruled) {
		push("issue.ruled", "warn", `issue left unruled, carried forward: ${snip(i.summary)}`);
	}

	// "addressed" means a correction in this round picks it up. If none does, the
	// disposition has quietly closed an issue that nobody is going to fix — the
	// exact silent-drop the handoff record exists to prevent.
	const correctionIds = new Set(corrections.map((c) => c.id));
	for (const i of issues.filter((x) => x.disposition === "addressed")) {
		if (!i.addressedBy) {
			push("ruling.addressed-names-correction", "block", `issue ruled "addressed" but no correction was named: ${snip(i.summary)}`);
		} else if (!correctionIds.has(i.addressedBy)) {
			push(
				"ruling.addressed-is-dispatched",
				"block",
				`issue ruled "addressed" by "${i.addressedBy}", which is not being dispatched: ${snip(i.summary)}`,
			);
		}
	}

	const contractIds = new Set(assertions.map((a) => a.id));
	const failingIds = new Set(failing.map((a) => a.id));
	const alreadyDispatched = new Set(dispatchedFeatureIds);
	for (const c of corrections) {
		// A correction that resolves nothing burns a milestone for free.
		if (!(c.addresses?.length || c.assertionIds?.length)) {
			push("correction.addresses-something", "block", `${c.id} names neither an assertion nor anything it resolves`);
		}
		for (const id of c.assertionIds ?? []) {
			if (!contractIds.has(id)) push("correction.assertions-exist", "block", `${c.id} targets assertion "${id}", which is not in the contract`);
		}
		if (alreadyDispatched.has(c.id)) {
			push("correction.id-fresh", "block", `${c.id} reuses the id of a feature already dispatched this mission`);
		}
		const targets = (c.assertionIds ?? []).filter((id) => failingIds.has(id));
		if ((c.assertionIds?.length ?? 0) > 0 && targets.length === 0) {
			push("correction.targets-failure", "warn", `${c.id} only targets assertions that already pass — it may be redoing finished work`);
		}
	}

	return v;
}
