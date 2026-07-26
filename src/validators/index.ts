import type { Assertion, CheckResult, ModelSpec, Plan, ScoreCard } from "../types.js";
import type { Target } from "../target/index.js";
import { spotBugs } from "./bug-spotter.js";
import { REFUSED_EXIT_CODE, runCheck } from "./checks.js";

export interface RunValidatorsOptions {
	cwd: string;
	plan: Plan;
	target: Target;
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
	const { cwd, plan, target, bugSpotterModel, diff, intent, extraCheckCommand, env, foreignRoot, onProgress } = options;
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
			const r = await target.runBehavioral(cwd, a.method.scenario, a.method.threshold);
			mark(a, r.passed, r.ran ? r.evidence : `SKIPPED — ${r.evidence}`);
		} else {
			// code-review: satisfied if the adversarial pass found no blocking bugs.
			mark(a, blocking === 0, blocking === 0 ? "no blocking bugs found" : `${blocking} blocking bug(s) found`);
		}
	}

	const assertionsTotal = plan.contract.assertions.length;
	const assertionsPassed = plan.contract.assertions.filter((a) => a.passed).length;

	return { assertionsPassed, assertionsTotal, checks, bugs, costUsd };
}

function mark(a: Assertion, passed: boolean, evidence: string): void {
	a.passed = passed;
	a.evidence = evidence;
}
