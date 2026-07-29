import type { Assertion, CheckResult, ModelSpec, Plan, ScoreCard, StrengthBreakdown } from "../types.js";
import { spotBugs } from "./bug-spotter.js";
import { REFUSED_EXIT_CODE, applyStrengthClassification, runCheck } from "./checks.js";

export interface RunValidatorsOptions {
	cwd: string;
	plan: Plan;
	bugSpotterModel: ModelSpec;
	/** Working-tree diff of the worker's changes. */
	diff: string;
	/** Human intent (goal + rfc) used to ground the adversarial review. */
	intent: string;
	/** Optional extra scrutiny command from config / target default. */
	extraCheckCommand?: string;
	/** The mission env — checks must run under the same environment the worker did. */
	env?: NodeJS.ProcessEnv;
	/** The main checkout. Commands reaching back into it are refused, not run. */
	foreignRoot?: string;
	onProgress?: (msg: string) => void;
	/**
	 * Every feature id dispatched so far (plan + corrections, in dispatch order).
	 * Assertions whose owning feature is NOT in this set are classified as pending:
	 * excluded from the failing set, but still block a CLEAN verdict.
	 * When absent, all assertions are validated normally (existing behaviour).
	 */
	dispatchedFeatureIds?: string[];
}

export async function runValidators(options: RunValidatorsOptions): Promise<ScoreCard> {
	const { cwd, plan, bugSpotterModel, diff, intent, extraCheckCommand, env, foreignRoot, onProgress, dispatchedFeatureIds } = options;
	const checks: CheckResult[] = [];
	let costUsd = 0;

	// Build a map from assertion id → the feature that owns it (via feature.assertionIds).
	// An assertion with no owning feature in the plan is treated as always dispatched.
	const assertionOwner = new Map<string, string>(); // assertionId → featureId
	for (const f of plan.features) {
		for (const aid of f.assertionIds) {
			assertionOwner.set(aid, f.id);
		}
	}

	// Determine which assertions are pending (owner not yet dispatched).
	// Only active when dispatchedFeatureIds is provided. An assertion with no
	// registered owner (e.g. added at a boundary) is never pending.
	const dispatched = dispatchedFeatureIds ? new Set(dispatchedFeatureIds) : null;
	const isPending = (assertionId: string): boolean => {
		if (!dispatched) return false;
		const owner = assertionOwner.get(assertionId);
		// No owner → treat as dispatched (keep existing behaviour).
		if (owner === undefined) return false;
		return !dispatched.has(owner);
	};

	// 1. Adversarial bug-spotter over the whole diff (drives code-review assertions too).
	onProgress?.("bug-spotter reviewing diff");
	const { bugs, costUsd: bugCost } = await spotBugs(bugSpotterModel, intent, diff);
	costUsd += bugCost;
	const blocking = bugs.filter((b) => b.severity === "critical" || b.severity === "high").length;

	// 2. Extra scrutiny command (repo test/typecheck), if provided.
	if (extraCheckCommand) {
		onProgress?.(`check: ${extraCheckCommand}`);
		checks.push(runCheck({ cwd, command: extraCheckCommand, env, foreignRoot }));
	}

	// 3. Per-assertion validation.
	for (const a of plan.contract.assertions) {
		// If the owning feature has not been dispatched yet, mark as pending and skip.
		if (isPending(a.id)) {
			a.pending = true;
			a.passed = undefined; // not run — neither passed nor failed
			a.evidence = "PENDING — owning feature has not been dispatched in any milestone yet";
			onProgress?.(`assert ${a.id}: pending (feature not dispatched)`);
			continue;
		}
		// Clear any stale pending flag from a previous milestone.
		a.pending = undefined;
		if (a.method.type === "bash-command") {
			onProgress?.(`assert ${a.id}: ${a.method.command}`);
			const r = runCheck({
				cwd,
				command: a.method.command,
				expectedExitCode: a.method.expectedExitCode,
				env,
				foreignRoot,
			});
			// Apply strength classification for bash-command assertions.
			// Declared 'behavioural' may be downgraded to 'existence'; never upgraded.
			const effectiveStrength = applyStrengthClassification(r, a.strength);
			// Reflect effective strength back onto the assertion for downstream consumers.
			if (effectiveStrength !== undefined) a.strength = effectiveStrength;
			checks.push(r);
			// A refused command is reported as such, so the orchestrator scopes a correction to
			// rewrite the assertion rather than reading it as the code being broken.
			const evidence =
				r.exitCode === REFUSED_EXIT_CODE
					? "REFUSED — assertion reached outside the mission worktree"
					: `exit=${r.exitCode} (expected ${a.method.expectedExitCode})`;
			mark(a, r.passed, evidence);
		} else if (a.method.type === "behavioral") {
			onProgress?.(`assert ${a.id}: behavioral ${a.method.scenario}`);
			// Behavioral scenarios are mission-specific, not repo-specific: state the command in
			// the RFC and let it be a bash-command assertion. Recorded as NOT passed (skipped),
			// so it does not increment assertionsPassed or strengthBreakdown.behavioural.passed.
			mark(a, false, `SKIPPED — behavioral assertions are not run; express "${a.method.scenario}" as a bash-command assertion instead`);
			// Non-bash assertions keep their declared strength; behavioral method defaults to 'behavioural'.
			if (a.strength === undefined) a.strength = "behavioural";
		} else {
			// code-review: satisfied if the adversarial pass found no blocking bugs.
			mark(a, blocking === 0, blocking === 0 ? "no blocking bugs found" : `${blocking} blocking bug(s) found`);
			// review assertions default to 'review' strength.
			if (a.strength === undefined) a.strength = "review";
		}
	}

	// Pending assertions are excluded from the pass/fail totals so they do not
	// inflate assertionsTotal or artificially deflate assertionsPassed.
	const nonPendingAssertions = plan.contract.assertions.filter((a) => !a.pending);
	const assertionsTotal = nonPendingAssertions.length;
	const assertionsPassed = nonPendingAssertions.filter((a) => a.passed).length;

	// Build per-strength breakdown (pending excluded).
	const strengthBreakdown = buildStrengthBreakdown(nonPendingAssertions);

	const pendingIds = plan.contract.assertions.filter((a) => a.pending).map((a) => a.id);
	const pendingAssertionIds = pendingIds.length > 0 ? pendingIds : undefined;

	return { assertionsPassed, assertionsTotal, checks, bugs, costUsd, strengthBreakdown, pendingAssertionIds };
}

function mark(a: Assertion, passed: boolean, evidence: string): void {
	a.passed = passed;
	a.evidence = evidence;
}

/**
 * Build a per-strength breakdown from a list of assertions after validation.
 * Uses the effective strength (post-classifier) stored on each assertion.
 */
function buildStrengthBreakdown(assertions: Assertion[]): StrengthBreakdown {
	const breakdown: StrengthBreakdown = {
		behavioural: { passed: 0, total: 0 },
		existence: { passed: 0, total: 0 },
		review: { passed: 0, total: 0 },
		unclassified: { passed: 0, total: 0 },
	};
	for (const a of assertions) {
		const bucket = a.strength ?? undefined;
		const key: keyof StrengthBreakdown = bucket === "behavioural" ? "behavioural"
			: bucket === "existence" ? "existence"
			: bucket === "review" ? "review"
			: "unclassified";
		breakdown[key].total++;
		if (a.passed) breakdown[key].passed++;
	}
	return breakdown;
}
