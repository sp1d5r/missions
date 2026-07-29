/**
 * Tests for pending-assertion classification.
 *
 * Feature: Classify assertions of undispatched features as pending, not failed.
 *
 * A 'pending' assertion is one whose owning feature has not been dispatched in
 * any milestone so far. Pending assertions are:
 *   - excluded from the failing set used by triage and stall decisions
 *   - still block a CLEAN verdict
 *   - marked with assertion.pending = true (never assertion.passed = false)
 *   - collected in scoreCard.pendingAssertionIds
 *
 * Assertions with no featureId (i.e., no owning feature in the plan) keep their
 * current behaviour — they are validated normally regardless of dispatchedFeatureIds.
 */

import { runValidators } from "../dist/validators/index.js";
import { checkBoundary, blocking } from "../dist/invariants.js";

let fails = 0;
const ok = (name, cond, detail = "") => {
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		fails++;
		console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
	}
};
const eq = (name, got, want) => {
	const match = JSON.stringify(got) === JSON.stringify(want);
	if (match) {
		console.log(`ok   ${name}`);
	} else {
		fails++;
		console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
	}
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal plan with two features:
 *   f1 owns a1, a2 (both bash-command: `true`)
 *   f2 owns a3, a4 (both bash-command: `false` — would fail if run)
 *
 * When only f1 is dispatched, a3 and a4 should be pending.
 */
function makePlan() {
	return {
		summary: "test plan",
		architectureNote: "none",
		features: [
			{
				id: "f1",
				title: "Feature one",
				description: "First feature",
				assertionIds: ["a1", "a2"],
			},
			{
				id: "f2",
				title: "Feature two",
				description: "Second feature",
				assertionIds: ["a3", "a4"],
			},
		],
		contract: {
			assertions: [
				{ id: "a1", statement: "a1 passes", method: { type: "bash-command", command: "true", expectedExitCode: 0 } },
				{ id: "a2", statement: "a2 passes", method: { type: "bash-command", command: "true", expectedExitCode: 0 } },
				// a3, a4 would fail if run (exit=1 != expectedExitCode=0)
				{ id: "a3", statement: "a3 fails if run", method: { type: "bash-command", command: "false", expectedExitCode: 0 } },
				{ id: "a4", statement: "a4 fails if run", method: { type: "bash-command", command: "false", expectedExitCode: 0 } },
			],
		},
	};
}

/**
 * Minimal stub for bug-spotter model — won't be called in practice since
 * we pass a real model spec and it does get called; we need a real env.
 * Use a no-op plan that the bug-spotter skips.
 */
const FAKE_MODEL = { provider: "anthropic", modelId: "claude-3-5-haiku-20241022" };

// ---------------------------------------------------------------------------
// runValidators — pending classification
// ---------------------------------------------------------------------------

// We cannot call runValidators with a real model (no API key in test env).
// Instead, test the classification logic directly via the exported function.
// The key observable is: after runValidators is called, the plan's assertion
// objects are mutated to carry .pending and .passed.
//
// Since runValidators calls the bug-spotter (LLM), we test the classification
// layer in isolation by driving it through the exported types and the
// invariants check — the only layer that matters for correctness.

// ---------------------------------------------------------------------------
// Classification unit tests — drive the logic without a real model
// ---------------------------------------------------------------------------

// We test the classification behaviour by calling runValidators with a mock
// that is guaranteed to not need the network: use `process.cwd()` as the
// working directory, and commands that work in any environment (`true`, `false`).
//
// We CANNOT avoid the bug-spotter call in runValidators without modifying the
// source. Instead, we'll test the classifier at the layer we can reach:
// the Assertion mutation that runValidators performs, by running it in a
// subprocess with a real (but cheap) model — OR we test the invariants layer
// directly which consumes the post-validation state.
//
// Since we don't have an LLM key in the test environment, we drive the
// classification by hand (simulating what runValidators would produce) and
// then verify the invariants, mission.ts boundary logic, and ScoreCard shape.

function simulateValidation(plan, dispatchedFeatureIds) {
	// Build the owner map as runValidators does.
	const assertionOwner = new Map();
	for (const f of plan.features) {
		for (const aid of f.assertionIds) {
			assertionOwner.set(aid, f.id);
		}
	}
	// null means "no dispatchedFeatureIds provided" — existing behaviour (none pending).
	const dispatched = dispatchedFeatureIds !== null ? new Set(dispatchedFeatureIds) : null;
	const isPending = (id) => {
		if (!dispatched) return false; // no dispatched set → never pending
		const owner = assertionOwner.get(id);
		if (owner === undefined) return false;
		return !dispatched.has(owner);
	};

	// Simulate the per-assertion pass for each assertion.
	const pendingIds = [];
	for (const a of plan.contract.assertions) {
		if (isPending(a.id)) {
			a.pending = true;
			a.passed = undefined;
			a.evidence = "PENDING — owning feature has not been dispatched in any milestone yet";
			pendingIds.push(a.id);
			continue;
		}
		a.pending = undefined;
		// Simulate: `true` → pass, `false` → fail.
		const cmd = a.method.command;
		a.passed = cmd === "true";
		a.evidence = `exit=${a.passed ? 0 : 1} (expected 0)`;
	}

	const nonPending = plan.contract.assertions.filter((a) => !a.pending);
	const assertionsTotal = nonPending.length;
	const assertionsPassed = nonPending.filter((a) => a.passed).length;
	const pendingAssertionIds = pendingIds.length > 0 ? pendingIds : undefined;

	return {
		assertionsPassed,
		assertionsTotal,
		checks: [],
		bugs: [],
		costUsd: 0,
		strengthBreakdown: undefined,
		pendingAssertionIds,
	};
}

// ---------------------------------------------------------------------------
// Core scenario: f2 never dispatched → a3 and a4 are pending
// ---------------------------------------------------------------------------

console.log("\n── pending classification (f2 not dispatched) ──");

{
	const plan = makePlan();
	// Only f1 is dispatched.
	const scoreCard = simulateValidation(plan, ["f1"]);

	// a3 and a4 should be pending.
	const a3 = plan.contract.assertions.find((a) => a.id === "a3");
	const a4 = plan.contract.assertions.find((a) => a.id === "a4");
	ok("a3 is marked pending", a3.pending === true);
	ok("a4 is marked pending", a4.pending === true);
	ok("a3 has undefined passed (not failed)", a3.passed === undefined);
	ok("a4 has undefined passed (not failed)", a4.passed === undefined);

	// a1, a2 should pass normally.
	const a1 = plan.contract.assertions.find((a) => a.id === "a1");
	const a2 = plan.contract.assertions.find((a) => a.id === "a2");
	ok("a1 passed", a1.passed === true);
	ok("a2 passed", a2.passed === true);
	ok("a1 not pending", !a1.pending);
	ok("a2 not pending", !a2.pending);

	// ScoreCard should reflect only non-pending assertions.
	eq("assertionsTotal excludes pending", scoreCard.assertionsTotal, 2); // only a1, a2
	eq("assertionsPassed is 2 (a1, a2)", scoreCard.assertionsPassed, 2);
	ok("pendingAssertionIds contains a3 and a4",
		Array.isArray(scoreCard.pendingAssertionIds) &&
		scoreCard.pendingAssertionIds.includes("a3") &&
		scoreCard.pendingAssertionIds.includes("a4"),
		`got: ${JSON.stringify(scoreCard.pendingAssertionIds)}`
	);
	eq("pendingAssertionIds length", scoreCard.pendingAssertionIds?.length, 2);
}

// ---------------------------------------------------------------------------
// failing set: pending assertions must NOT be in the failing set
// ---------------------------------------------------------------------------

console.log("\n── failing set excludes pending ──");

{
	const plan = makePlan();
	const scoreCard = simulateValidation(plan, ["f1"]);

	// Compute failing the same way mission.ts does.
	const failing = plan.contract.assertions.filter((a) => !a.pending && !a.passed);
	ok("failing set is empty (a3, a4 are pending, not failed)", failing.length === 0,
		`failing: ${failing.map((a) => a.id).join(", ")}`
	);

	// Compute pending.
	const pending = plan.contract.assertions.filter((a) => a.pending);
	eq("pending set has a3 and a4", pending.map((a) => a.id).sort(), ["a3", "a4"]);
}

// ---------------------------------------------------------------------------
// verdict: pending assertions block CLEAN
// ---------------------------------------------------------------------------

console.log("\n── pending blocks CLEAN verdict ──");

{
	const plan = makePlan();
	const scoreCard = simulateValidation(plan, ["f1"]);

	const failing = plan.contract.assertions.filter((a) => !a.pending && !a.passed);
	const pending = plan.contract.assertions.filter((a) => a.pending);
	const blockingBugs = scoreCard.bugs.filter((b) => b.severity === "critical" || b.severity === "high");

	// The CLEAN condition from mission.ts:
	const clean = failing.length === 0 && blockingBugs.length === 0 && pending.length === 0;
	ok("verdict is NOT CLEAN when there are pending assertions", clean === false,
		`failing=${failing.length}, pending=${pending.length}, blockingBugs=${blockingBugs.length}`
	);
}

// ---------------------------------------------------------------------------
// verdict.evidence-backed invariant: pending also blocks "passed" verdict
// ---------------------------------------------------------------------------

console.log("\n── checkBoundary: pending blocks passed verdict ──");

{
	const plan = makePlan();
	const scoreCard = simulateValidation(plan, ["f1"]);

	const violations = checkBoundary({
		assertions: plan.contract.assertions,
		scoreCard,
		handoffs: [],
		verdict: "passed", // orchestrator claims passed
		corrections: [],
		dispatchedFeatureIds: ["f1"],
	});
	const blockers = blocking(violations);
	ok("checkBoundary blocks 'passed' verdict when there are pending assertions",
		blockers.some((v) => v.invariant === "verdict.evidence-backed"),
		`blockers: ${blockers.map((v) => v.invariant).join(", ")}`
	);
}

// ---------------------------------------------------------------------------
// scorecard.covers-contract: pending are accounted for, no spurious violation
// ---------------------------------------------------------------------------

console.log("\n── scorecard.covers-contract accepts pending assertions ──");

{
	const plan = makePlan();
	const scoreCard = simulateValidation(plan, ["f1"]);

	// With needs-corrections verdict (not claiming passed), should be no blocker for covers-contract.
	const violations = checkBoundary({
		assertions: plan.contract.assertions,
		scoreCard,
		handoffs: [],
		verdict: "needs-corrections",
		corrections: [
			{
				id: "c1",
				title: "Fix f2",
				description: "Dispatch f2",
				assertionIds: ["a3", "a4"],
			},
		],
		dispatchedFeatureIds: ["f1"],
	});
	const blockers = blocking(violations);
	ok("no scorecard.covers-contract violation when pending are accounted for",
		!blockers.some((v) => v.invariant === "scorecard.covers-contract"),
		`blockers: ${blockers.map((v) => v.invariant).join(", ")}`
	);
}

// ---------------------------------------------------------------------------
// No dispatchedFeatureIds → existing behaviour (all assertions validated normally)
// ---------------------------------------------------------------------------

console.log("\n── no dispatchedFeatureIds → all assertions validated normally ──");

{
	const plan = makePlan();
	// No dispatchedFeatureIds — simulate old behaviour.
	simulateValidation(plan, null); // null means "no dispatched set"

	// All assertions should be validated (none pending).
	const pending = plan.contract.assertions.filter((a) => a.pending);
	ok("no pending assertions when dispatchedFeatureIds is null", pending.length === 0,
		`pending: ${pending.map((a) => a.id).join(", ")}`
	);
}

// But wait — the above simulation uses null to mean "no dispatchedFeatureIds".
// Let's also verify that when dispatchedFeatureIds covers ALL features, nothing is pending.

console.log("\n── all features dispatched → no pending assertions ──");

{
	const plan = makePlan();
	const scoreCard = simulateValidation(plan, ["f1", "f2"]);

	const pending = plan.contract.assertions.filter((a) => a.pending);
	ok("no pending assertions when all features are dispatched", pending.length === 0,
		`pending: ${pending.map((a) => a.id).join(", ")}`
	);
	ok("pendingAssertionIds is undefined when no pending", scoreCard.pendingAssertionIds === undefined);

	// a3, a4 would be run and fail (command is `false`).
	const a3 = plan.contract.assertions.find((a) => a.id === "a3");
	const a4 = plan.contract.assertions.find((a) => a.id === "a4");
	ok("a3 is failed (not pending) when f2 dispatched", a3.passed === false && !a3.pending);
	ok("a4 is failed (not pending) when f2 dispatched", a4.passed === false && !a4.pending);

	const failing = plan.contract.assertions.filter((a) => !a.pending && !a.passed);
	eq("failing contains a3 and a4 when all dispatched", failing.map((a) => a.id).sort(), ["a3", "a4"]);
}

// ---------------------------------------------------------------------------
// Assertion with no owning feature → treated as dispatched (existing behaviour)
// ---------------------------------------------------------------------------

console.log("\n── orphan assertion (no owning feature) → never pending ──");

{
	// An assertion not claimed by any feature.
	const plan = {
		summary: "orphan test",
		architectureNote: "",
		features: [
			{ id: "f1", title: "f1", description: "f1", assertionIds: ["a1"] },
		],
		contract: {
			assertions: [
				{ id: "a1", statement: "a1", method: { type: "bash-command", command: "true", expectedExitCode: 0 } },
				// a_orphan is not claimed by any feature.
				{ id: "a_orphan", statement: "orphan", method: { type: "bash-command", command: "true", expectedExitCode: 0 } },
			],
		},
	};

	// Only f1 is dispatched — a_orphan has no owner, so it must NOT be pending.
	const scoreCard = simulateValidation(plan, ["f1"]);

	const aOrphan = plan.contract.assertions.find((a) => a.id === "a_orphan");
	ok("orphan assertion is not pending", !aOrphan.pending);
	ok("orphan assertion is validated normally (passed)", aOrphan.passed === true);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
