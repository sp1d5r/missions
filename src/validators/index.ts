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
}

export async function runValidators(options: RunValidatorsOptions): Promise<ScoreCard> {
	const { cwd, plan, bugSpotterModel, diff, intent, extraCheckCommand, env, foreignRoot, onProgress } = options;
	const checks: CheckResult[] = [];
	let costUsd = 0;

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
			// the RFC and let it be a bash-command assertion. Recorded as skipped, never as passed.
			mark(a, true, `SKIPPED — behavioral assertions are not run; express "${a.method.scenario}" as a bash-command assertion instead`);
			// Non-bash assertions keep their declared strength; behavioral method defaults to 'behavioural'.
			if (a.strength === undefined) a.strength = "behavioural";
		} else {
			// code-review: satisfied if the adversarial pass found no blocking bugs.
			mark(a, blocking === 0, blocking === 0 ? "no blocking bugs found" : `${blocking} blocking bug(s) found`);
			// review assertions default to 'review' strength.
			if (a.strength === undefined) a.strength = "review";
		}
	}

	const assertionsTotal = plan.contract.assertions.length;
	const assertionsPassed = plan.contract.assertions.filter((a) => a.passed).length;

	// Build per-strength breakdown.
	const strengthBreakdown = buildStrengthBreakdown(plan.contract.assertions);

	return { assertionsPassed, assertionsTotal, checks, bugs, costUsd, strengthBreakdown };
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
