import type { Assertion, CheckResult, ModelSpec, Plan, ScoreCard } from "../types.js";
import type { Target } from "../target/index.js";
import { spotBugs } from "./bug-spotter.js";
import { runCheck } from "./checks.js";

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
	onProgress?: (msg: string) => void;
}

export async function runValidators(options: RunValidatorsOptions): Promise<ScoreCard> {
	const { cwd, plan, target, bugSpotterModel, diff, intent, extraCheckCommand, onProgress } = options;
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
		checks.push(runCheck(cwd, extraCheckCommand));
	}

	// 3. Per-assertion validation.
	for (const a of plan.contract.assertions) {
		if (a.method.type === "bash-command") {
			onProgress?.(`assert ${a.id}: ${a.method.command}`);
			const r = runCheck(cwd, a.method.command, a.method.expectedExitCode);
			checks.push(r);
			mark(a, r.passed, `exit=${r.exitCode} (expected ${a.method.expectedExitCode})`);
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
