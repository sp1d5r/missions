/**
 * Pure, side-effect-free stall/retry decision logic.
 *
 * Extracted so it can be unit-tested in isolation without importing mission.ts
 * or any module that performs I/O.
 */

export interface StallInput {
	/** Blocking violations from checkBoundary — each has an `invariant` slug and `detail`. */
	violations: Array<{ invariant: string; detail: string }>;
	/** True when the orchestrator offered at least one correction to dispatch. */
	correctionsOffered: boolean;
	/** How many additional milestones can still be started after this one. */
	milestonesRemaining: number;
	/** True if a re-validate retry was already attempted for this milestone. */
	retriedThisMilestone: boolean;
}

export type StallDecision =
	| { action: "re-validate" }
	| { action: "scope-corrections" }
	| { action: "stall"; reason: string; invariants: string[] };

/**
 * Decide what to do when a milestone hits blockers or cannot continue.
 *
 * Rules (in priority order):
 *
 * 1. `scorecard.covers-contract` with no prior retry this milestone → re-validate.
 *    The scorecard mismatch is often a timing artefact; a single re-run resolves it.
 *    On a second occurrence (retriedThisMilestone=true) → stall (cannot loop forever).
 *
 * 2. `verdict.evidence-backed` when the orchestrator offered corrections AND there is
 *    budget for another milestone → scope-corrections (fall through to existing path).
 *
 * 3. Everything else (unknown blockers, multiple blockers, repeat retry, no corrections,
 *    zero remaining budget) → stall with a plain-language sentence and the invariant
 *    slugs listed as supporting detail.
 *
 * The function fails closed: any unrecognised blocker combination produces a stall.
 * The reason is always a full sentence; the invariant slug may appear only as detail,
 * never as the sole content.
 */
export function decideStallOrRetry(input: StallInput): StallDecision {
	const { violations, correctionsOffered, milestonesRemaining, retriedThisMilestone } = input;

	const slugs = violations.map((v) => v.invariant);

	// No blockers at all: the normal corrections path should handle this, but if called
	// with an empty list we fall through to scope-corrections (zero invariants, no stall).
	if (violations.length === 0) {
		return { action: "scope-corrections" };
	}

	// Rule 1: scorecard.covers-contract — exactly this one blocker, and first attempt.
	if (slugs.length === 1 && slugs[0] === "scorecard.covers-contract") {
		if (!retriedThisMilestone) {
			return { action: "re-validate" };
		}
		// Retry was already attempted — fail closed to stall.
		return {
			action: "stall",
			reason:
				"The scorecard still does not cover the full contract after a re-validation retry. " +
				"A human needs to inspect why the assertion count is mismatched.",
			invariants: slugs,
		};
	}

	// Rule 2: verdict.evidence-backed — exactly this one blocker, corrections available, budget left.
	if (slugs.length === 1 && slugs[0] === "verdict.evidence-backed") {
		if (correctionsOffered && milestonesRemaining > 0) {
			return { action: "scope-corrections" };
		}
		if (!correctionsOffered) {
			return {
				action: "stall",
				reason:
					"The orchestrator's verdict was not backed by the evidence, and no corrections were offered to address the failures. " +
					"A human needs to review the failing assertions and determine next steps.",
				invariants: slugs,
			};
		}
		// milestonesRemaining === 0
		return {
			action: "stall",
			reason:
				"The orchestrator's verdict was not backed by the evidence, but there is no milestone budget remaining to run corrections. " +
				"A human needs to review the failing assertions and extend the budget if appropriate.",
			invariants: slugs,
		};
	}

	// Rule 3 (fail closed): multiple blockers, unknown blocker, or any other combination.
	const slugList = slugs.join(", ");
	return {
		action: "stall",
		reason:
			`The milestone was blocked by ${violations.length} invariant violation(s) (${slugList}) that cannot be automatically resolved. ` +
			"A human needs to inspect the boundary violations and intervene.",
		invariants: slugs,
	};
}
