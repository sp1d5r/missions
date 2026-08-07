/**
 * Unit tests for src/stall.ts (compiled to dist/stall.js) and the
 * finalizeStall choke point in src/mission.ts (compiled to dist/mission.js).
 *
 * Follows the same convention as test/invariants.mjs:
 *   - import from dist/
 *   - hand-rolled check() / assert() helpers
 *   - exit 0 on all pass, exit 1 on any failure
 */

import { decideStallOrRetry } from "../dist/stall.js";
import { finalizeStall } from "../dist/mission.js";

let failures = 0;

function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}: ${err.message}`);
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg ?? "assertion failed");
}

// ---- helpers ----------------------------------------------------------------

/** A blocking violation with the given slug. */
const v = (invariant) => ({ invariant, detail: `detail for ${invariant}` });

// ---- Rule 1: scorecard.covers-contract — re-validate once, then stall ------

check("scorecard.covers-contract first attempt → re-validate", () => {
	const result = decideStallOrRetry({
		violations: [v("scorecard.covers-contract")],
		correctionsOffered: false,
		milestonesRemaining: 2,
		retriedThisMilestone: false,
	});
	assert(result.action === "re-validate", `expected re-validate, got ${result.action}`);
});

check("scorecard.covers-contract after retry → stall", () => {
	const result = decideStallOrRetry({
		violations: [v("scorecard.covers-contract")],
		correctionsOffered: false,
		milestonesRemaining: 2,
		retriedThisMilestone: true,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	// reason must be a full sentence — not a bare slug alone
	assert(result.reason !== "scorecard.covers-contract", "stall reason must not be a bare slug");
	assert(result.reason.includes(" "), "stall reason must be a sentence (contains spaces)");
	// invariants list should contain the slug
	assert(result.invariants.includes("scorecard.covers-contract"), "invariants should include the slug");
});

check("scorecard.covers-contract correctionsOffered=true first attempt still → re-validate", () => {
	const result = decideStallOrRetry({
		violations: [v("scorecard.covers-contract")],
		correctionsOffered: true,
		milestonesRemaining: 1,
		retriedThisMilestone: false,
	});
	assert(result.action === "re-validate", `expected re-validate, got ${result.action}`);
});

// ---- Rule 2: verdict.evidence-backed — scope-corrections or stall ----------

check("verdict.evidence-backed with corrections and budget → scope-corrections", () => {
	const result = decideStallOrRetry({
		violations: [v("verdict.evidence-backed")],
		correctionsOffered: true,
		milestonesRemaining: 1,
		retriedThisMilestone: false,
	});
	assert(result.action === "scope-corrections", `expected scope-corrections, got ${result.action}`);
});

check("verdict.evidence-backed with corrections and budget after retry → scope-corrections (retry flag irrelevant here)", () => {
	const result = decideStallOrRetry({
		violations: [v("verdict.evidence-backed")],
		correctionsOffered: true,
		milestonesRemaining: 2,
		retriedThisMilestone: true,
	});
	assert(result.action === "scope-corrections", `expected scope-corrections, got ${result.action}`);
});

check("verdict.evidence-backed with NO corrections → stall", () => {
	const result = decideStallOrRetry({
		violations: [v("verdict.evidence-backed")],
		correctionsOffered: false,
		milestonesRemaining: 2,
		retriedThisMilestone: false,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	assert(result.reason !== "verdict.evidence-backed", "stall reason must not be a bare slug");
	assert(result.reason.includes(" "), "stall reason must be a sentence");
});

check("verdict.evidence-backed with corrections but ZERO budget → stall with budget mention", () => {
	const result = decideStallOrRetry({
		violations: [v("verdict.evidence-backed")],
		correctionsOffered: true,
		milestonesRemaining: 0,
		retriedThisMilestone: false,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	// reason should mention budget
	assert(
		result.reason.toLowerCase().includes("budget") || result.reason.toLowerCase().includes("remaining"),
		`expected reason to mention budget, got: ${result.reason}`,
	);
});

// ---- Rule 3: unknown/multiple blockers fail closed to stall ----------------

check("unknown blocker → stall with non-empty sentence", () => {
	const result = decideStallOrRetry({
		violations: [v("ruling.addressed-names-correction")],
		correctionsOffered: true,
		milestonesRemaining: 2,
		retriedThisMilestone: false,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	assert(result.reason !== "ruling.addressed-names-correction", "stall reason must not be a bare slug");
	assert(result.reason.includes(" "), "stall reason must be a sentence");
});

check("multiple blockers → stall with non-empty sentence", () => {
	const result = decideStallOrRetry({
		violations: [v("scorecard.covers-contract"), v("verdict.evidence-backed")],
		correctionsOffered: true,
		milestonesRemaining: 2,
		retriedThisMilestone: false,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	// reason should not be a bare slug
	assert(
		result.reason !== "scorecard.covers-contract" && result.reason !== "verdict.evidence-backed",
		"stall reason must not be a bare slug",
	);
	assert(result.reason.includes(" "), "stall reason must be a sentence");
});

check("completely unknown blocker slug → fail closed to stall", () => {
	const result = decideStallOrRetry({
		violations: [v("some.completely.unknown.invariant")],
		correctionsOffered: true,
		milestonesRemaining: 5,
		retriedThisMilestone: false,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	assert(result.reason.includes(" "), "stall reason must be a sentence");
	// reason must not be ONLY the slug
	assert(result.reason !== "some.completely.unknown.invariant", "stall reason must not be a bare slug");
});

// ---- Rule 3, fast mode: retry instead of failing closed --------------------

check("fast mode: unknown blocker with budget remaining → scope-corrections, not stall", () => {
	const result = decideStallOrRetry({
		violations: [v("some.completely.unknown.invariant")],
		correctionsOffered: true,
		milestonesRemaining: 2,
		retriedThisMilestone: false,
		fastMode: true,
	});
	assert(result.action === "scope-corrections", `expected scope-corrections, got ${result.action}`);
});

check("fast mode: multiple blockers with budget remaining → scope-corrections, not stall", () => {
	const result = decideStallOrRetry({
		violations: [v("scorecard.covers-contract"), v("verdict.evidence-backed")],
		correctionsOffered: true,
		milestonesRemaining: 1,
		retriedThisMilestone: false,
		fastMode: true,
	});
	assert(result.action === "scope-corrections", `expected scope-corrections, got ${result.action}`);
});

check("fast mode: no budget remaining still stalls with non-empty sentence", () => {
	const result = decideStallOrRetry({
		violations: [v("some.completely.unknown.invariant")],
		correctionsOffered: true,
		milestonesRemaining: 0,
		retriedThisMilestone: false,
		fastMode: true,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
	assert(result.reason.length > 0, "stall reason must not be empty");
	assert(result.reason.includes(" "), "stall reason must be a sentence");
	assert(result.reason !== "some.completely.unknown.invariant", "stall reason must not be a bare slug");
});

check("rigorous (fastMode absent) still fails closed on unknown blocker with budget remaining", () => {
	const result = decideStallOrRetry({
		violations: [v("some.completely.unknown.invariant")],
		correctionsOffered: true,
		milestonesRemaining: 5,
		retriedThisMilestone: false,
	});
	assert(result.action === "stall", `expected stall, got ${result.action}`);
});

check("no violations → scope-corrections (zero-blocker boundary cleared)", () => {
	const result = decideStallOrRetry({
		violations: [],
		correctionsOffered: true,
		milestonesRemaining: 1,
		retriedThisMilestone: false,
	});
	assert(result.action === "scope-corrections", `expected scope-corrections, got ${result.action}`);
});

// ---- Invariant: every stall reason is a full sentence, never a bare slug ----

const allBlockers = [
	"scorecard.covers-contract",
	"verdict.evidence-backed",
	"ruling.addressed-names-correction",
	"ruling.addressed-is-dispatched",
	"correction.id-fresh",
	"correction.addresses-something",
	"contract.no-deletion",
	"contract.no-reword",
	"contract.no-remethod",
];

for (const slug of allBlockers) {
	check(`stall reason for '${slug}' is never a bare slug (retried=true, no corrections, no budget)`, () => {
		const result = decideStallOrRetry({
			violations: [v(slug)],
			correctionsOffered: false,
			milestonesRemaining: 0,
			retriedThisMilestone: true,
		});
		if (result.action === "stall") {
			assert(result.reason !== slug, `reason is bare slug for ${slug}`);
			assert(result.reason.trim().includes(" "), `reason is not a sentence for ${slug}`);
		}
		// re-validate is never returned for retriedThisMilestone=true
		assert(result.action !== "re-validate", `re-validate must not be returned when retriedThisMilestone=true`);
	});
}

// ---- finalizeStall: terminal-stall invariant (non-empty stallReason) -------
//
// These tests cover the single choke point in mission.ts that guarantees every
// terminal finalVerdict==='stalled' path produces a non-empty stallReason.

/** Minimal MissionState stub sufficient for finalizeStall. */
function makeState(stallReason) {
	return { stallReason };
}

// (a) An explicit stallReason survives unchanged.
check("finalizeStall: explicit reason is preserved", () => {
	const state = makeState("Something went wrong with the boundary check.");
	const result = finalizeStall(state, state.stallReason, 3, ["a1", "a2"]);
	assert(result === "Something went wrong with the boundary check.", `expected original reason, got: ${result}`);
	assert(state.stallReason === "Something went wrong with the boundary check.", "state.stallReason should match");
});

check("finalizeStall: explicit reason passed directly survives unchanged", () => {
	const state = makeState(undefined);
	const reason = "The orchestrator did not offer corrections. A human must decide.";
	const result = finalizeStall(state, reason, 2, ["a3"]);
	assert(result === reason, `expected reason unchanged, got: ${result}`);
	assert(state.stallReason === reason, "state.stallReason should be set to provided reason");
});

// (b) An unset stallReason gets the fallback.
check("finalizeStall: undefined reason gets fallback", () => {
	const state = makeState(undefined);
	const result = finalizeStall(state, undefined, 5, ["a1", "a3"]);
	// fallback must be non-empty
	assert(result.trim().length > 0, "fallback must be non-empty");
	assert(state.stallReason === result, "state.stallReason must be set to fallback");
});

check("finalizeStall: empty string reason gets fallback", () => {
	const state = makeState("");
	const result = finalizeStall(state, "", 2, ["a2"]);
	// fallback must be non-empty
	assert(result.trim().length > 0, "fallback must be non-empty when reason is empty string");
	assert(state.stallReason === result, "state.stallReason must be set to fallback");
});

check("finalizeStall: whitespace-only reason gets fallback", () => {
	const state = makeState("   ");
	const result = finalizeStall(state, "   ", 1, ["a5"]);
	assert(result.trim().length > 0, "fallback must be non-empty when reason is whitespace");
	assert(state.stallReason === result, "state.stallReason must be set to fallback");
});

// (c) The fallback is non-empty and contains milestone count and any known failing ids.
check("finalizeStall fallback: contains milestone count", () => {
	const state = makeState(undefined);
	const result = finalizeStall(state, undefined, 7, ["a1", "a3"]);
	// must mention the number of milestones
	assert(result.includes("7"), `fallback must contain milestone count (7), got: ${result}`);
});

check("finalizeStall fallback: contains failing assertion ids", () => {
	const state = makeState(undefined);
	const result = finalizeStall(state, undefined, 3, ["a1", "a3"]);
	assert(result.includes("a1"), `fallback must contain failing id 'a1', got: ${result}`);
	assert(result.includes("a3"), `fallback must contain failing id 'a3', got: ${result}`);
});

check("finalizeStall fallback: non-empty when no failing ids", () => {
	const state = makeState(undefined);
	const result = finalizeStall(state, undefined, 2, []);
	assert(result.trim().length > 0, "fallback must be non-empty even with empty failing ids");
	assert(result.includes("2"), `fallback must contain milestone count (2), got: ${result}`);
});

check("finalizeStall fallback: single milestone uses singular form or contains count", () => {
	const state = makeState(undefined);
	const result = finalizeStall(state, undefined, 1, ["a1"]);
	assert(result.trim().length > 0, "fallback must be non-empty");
	assert(result.includes("1"), `fallback must contain milestone count (1), got: ${result}`);
	assert(result.includes("a1"), `fallback must contain failing id 'a1', got: ${result}`);
});

check("finalizeStall: state.stallReason is always non-empty after call for every stall path", () => {
	// Simulate boundary-violation stall with a provided reason
	const state1 = makeState(undefined);
	finalizeStall(state1, "Boundary violated due to invariant scorecard.covers-contract.", 2, ["a1"]);
	assert(state1.stallReason && state1.stallReason.trim().length > 0, "stallReason must be non-empty after boundary stall");

	// Simulate no-corrections stall with a provided reason
	const state2 = makeState(undefined);
	finalizeStall(state2, "The orchestrator did not offer any corrections.", 1, ["a2", "a4"]);
	assert(state2.stallReason && state2.stallReason.trim().length > 0, "stallReason must be non-empty after no-corrections stall");

	// Simulate unexpected stall (empty queue, no reason provided)
	const state3 = makeState(undefined);
	finalizeStall(state3, undefined, 0, []);
	assert(state3.stallReason && state3.stallReason.trim().length > 0, "stallReason must be non-empty after unexpected stall");
});

// ---- Summary ----------------------------------------------------------------

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
