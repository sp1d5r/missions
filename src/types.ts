// Core types for the missions harness — your engineering org.
// Kept deliberately lean for Phase 0; extended in later phases.

export type Provider = "anthropic" | "openai" | "google";

export interface ModelSpec {
	provider: Provider;
	modelId: string;
}

/** The "right model in each seat" routing. */
export interface ModelRouting {
	/** Careful planner. */
	orchestrator: ModelSpec;
	/** Fast code-fluent implementer. */
	worker: ModelSpec;
	/** Adversarial reviewer — ideally a different provider to avoid shared-bias. */
	bugSpotter: ModelSpec;
}

/** How a single assertion gets proven. Behavioral methods are handled by a Target adapter. */
export type ValidationMethod =
	| { type: "bash-command"; command: string; expectedExitCode: number }
	| { type: "behavioral"; scenario: string; threshold?: number }
	| { type: "code-review"; focus: string };

export interface Assertion {
	id: string;
	statement: string;
	method: ValidationMethod;
	/** Filled in by validators. */
	passed?: boolean;
	evidence?: string;
}

export interface ValidationContract {
	assertions: Assertion[];
}

export interface Feature {
	id: string;
	title: string;
	description: string;
	/** Which contract assertions this feature is responsible for satisfying. */
	assertionIds: string[];
}

/** Orchestrator output: what to build and how we'll prove it. */
export interface Plan {
	summary: string;
	/** One-line current→target architecture note, rendered in the report diagram. */
	architectureNote: string;
	features: Feature[];
	contract: ValidationContract;
}

export type BugSeverity = "critical" | "high" | "medium" | "low";

export interface BugFinding {
	severity: BugSeverity;
	file?: string;
	line?: number;
	summary: string;
	detail: string;
}

export interface CheckResult {
	command: string;
	exitCode: number;
	passed: boolean;
	output: string;
}

export interface ScoreCard {
	assertionsPassed: number;
	assertionsTotal: number;
	checks: CheckResult[];
	bugs: BugFinding[];
	costUsd: number;
}

export interface CommitRecord {
	featureId: string;
	sha: string;
	message: string;
}

export type MissionStatus = "planning" | "working" | "validating" | "reporting" | "succeeded" | "failed";

export interface MissionConfig {
	goal: string;
	/** The user's "here's what's wrong" RFC / feedback. Free text. */
	rfc: string;
	/** Absolute path to the target repo (Nadine = tenant #1). */
	targetCwd: string;
	/** Work branch created in the target repo; never commit to main directly. */
	branch: string;
	budgetUsd: number;
	/** Where mission artifacts (state.json, report.html, log) are written. */
	outDir: string;
	routing: ModelRouting;
	/** Phase 0 executes at most this many features per run. */
	maxFeatures: number;
	/** Optional repo check command run by the scrutiny validator (e.g. "npm test"). */
	checkCommand?: string;
	/** Which target adapter to use for behavioral validation. */
	target: "generic" | "nadine";
	/** Run in an isolated git worktree (enables true parallel missions). Default true. */
	useWorktree?: boolean;
}

export interface MissionState {
	id: string;
	startedAt: string;
	goal: string;
	rfc: string;
	status: MissionStatus;
	branch: string;
	targetCwd: string;
	/** HEAD of the target repo when the work branch was created (diff base). */
	baseSha?: string;
	/** Isolated worktree dir the worker operated in (present when useWorktree). */
	worktreePath?: string;
	plan?: Plan;
	commits: CommitRecord[];
	scoreCard?: ScoreCard;
	costUsd: number;
	reportPath?: string;
	log: string[];
}

/** Standup carries intent across days. */
export interface DailyState {
	date: string;
	priorities: string[];
	leftovers: string[];
	mood: string;
	/** Mission ids kicked off today. */
	missionIds: string[];
}
