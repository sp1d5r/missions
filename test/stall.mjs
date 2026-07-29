/**
 * Unit tests for src/stall.ts (compiled to dist/stall.js).
 *
 * Follows the same convention as test/invariants.mjs:
 *   - import from dist/
 *   - hand-rolled check() / assert() helpers
 *   - exit 0 on all pass, exit 1 on any failure
 */

import { decideStallOrRetry } from "../dist/stall.js";

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

// ---- Summary ----------------------------------------------------------------

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
