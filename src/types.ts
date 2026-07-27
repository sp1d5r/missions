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
	/** Orchestrator-defined per-feature procedure the worker must follow and report adherence to. */
	procedures?: string[];
	/** 1-based milestone this feature was dispatched in. */
	milestone?: number;
	/** Where it came from: the original plan, or a milestone-boundary correction. */
	origin?: "plan" | "correction";
	/** For corrections: the failing assertions / bugs / issues this feature is meant to resolve. */
	addresses?: string[];
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

// ---------------------------------------------------------------------------
// Handoffs — the connective tissue between agents.
//
// A worker never just says "done". It writes down what it did, what it did NOT
// do, what it ran, and what it found. Context survives because it is recorded,
// not because the next agent is trusted to remember.
// ---------------------------------------------------------------------------

/** One command the worker actually ran. Captured from tool events, NOT self-reported. */
export interface CommandRecord {
	command: string;
	/** null = killed, aborted, or exit code not recoverable from the tool result. */
	exitCode: number | null;
}

export type IssueDisposition = "addressed" | "deferred";

/** Something the worker discovered that a human or the orchestrator must decide about. */
export interface HandoffIssue {
	summary: string;
	detail?: string;
	/** Assigned by the orchestrator at a milestone boundary. Undefined = still open, and blocks the milestone. */
	disposition?: IssueDisposition;
	/** Why it was addressed or why it is safe to defer. */
	dispositionNote?: string;
	/** Id of the correction that picks it up. Required for "addressed" — an issue nothing
	 *  is dispatched to fix has not been addressed, it has been dropped. */
	addressedBy?: string;
}

/** Structured worker handoff. Free prose alone is not accepted. */
export interface Handoff {
	featureId: string;
	milestone: number;
	/** What was actually changed. */
	completed: string;
	/** Anything in the feature spec that was NOT done, and why. */
	leftUndone: string[];
	/** Deterministic record of every bash command and its exit code. */
	commands: CommandRecord[];
	/** Discoveries outside the feature's scope that need a decision. */
	issues: HandoffIssue[];
	/** Did the worker follow the orchestrator's procedures for this feature? */
	proceduresFollowed: boolean;
	procedureNotes?: string;
	/** Assertion ids the worker CLAIMS to have satisfied. Validators decide independently. */
	assertionsClaimed: string[];
	confidence: "high" | "medium" | "low";
	/** True when the worker failed to emit a parseable handoff and we fell back to its prose. */
	degraded?: boolean;
	/** Harness-side facts about the run. */
	stopReason: string;
	aborted: boolean;
	costUsd: number;
	commitSha?: string;
}

export type MilestoneVerdict =
	/** Contract satisfied, no blocking bugs, no open issues. */
	| "passed"
	/** Orchestrator scoped corrective features; another milestone follows. */
	| "corrections-scoped"
	/** Ran out of money before the contract was satisfied. */
	| "budget-exhausted"
	/** Hit maxMilestones with work still outstanding. */
	| "max-milestones"
	/** Not clean, but the orchestrator had no corrections to offer. Needs a human. */
	| "stalled";

export interface MilestoneRecord {
	index: number;
	featureIds: string[];
	handoffs: Handoff[];
	scoreCard: ScoreCard;
	verdict: MilestoneVerdict;
	/** Orchestrator's read of the boundary — why it did what it did. */
	assessment?: string;
	/** Ids of corrective features scoped off the back of this milestone. */
	correctionIds: string[];
}

export type MissionStatus = "planning" | "working" | "validating" | "reporting" | "succeeded" | "failed";

/** Did the mission end clean, or does it want a human? Independent of run success/crash. */
export type MissionOutcome = "clean" | "needs-review";

/**
 * Where a mission came from. Recorded so the changelog can say not just what an
 * agent changed but why it was attempted — the one fact you cannot recover from
 * the diff when the change turns out to be wrong.
 */
export interface MissionOrigin {
	kind: "human" | "chief" | "suggestion" | "briefing";
	/** Free text: the suggestion's rationale, or the claim a briefing grounded. */
	note?: string;
	/** For briefings: the video the claim came from. */
	sourceUrl?: string;
}

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
	/** Max features executed per milestone. */
	maxFeatures: number;
	/** Max milestones (initial pass + corrective rounds) before we stop and ask for a human. Default 3. */
	maxMilestones?: number;
	/** Optional repo check command run by the scrutiny validator (e.g. "npm test"). */
	checkCommand?: string;
	/** Which target adapter to use for behavioral validation. */
	target: "generic" | "nadine";
	/** Run in an isolated git worktree (enables true parallel missions). Default true. */
	useWorktree?: boolean;
	/** Provenance, carried into MissionState and the changelog. Defaults to "human". */
	origin?: MissionOrigin;
}

export interface MissionState {
	id: string;
	startedAt: string;
	goal: string;
	rfc: string;
	status: MissionStatus;
	branch: string;
	targetCwd: string;
	/** Who or what prompted this mission. */
	origin?: MissionOrigin;
	/** Model per seat, kept so the changelog can attribute each commit. */
	routing?: ModelRouting;
	/** HEAD of the target repo when the work branch was created (diff base). */
	baseSha?: string;
	/** Isolated worktree dir the worker operated in (present when useWorktree). */
	worktreePath?: string;
	plan?: Plan;
	/** Every feature dispatched, plan + corrections, in dispatch order. */
	features: Feature[];
	/** Every handoff, flat, in order. */
	handoffs: Handoff[];
	/** One record per completed milestone. */
	milestones: MilestoneRecord[];
	commits: CommitRecord[];
	/** Score card from the FINAL milestone. */
	scoreCard?: ScoreCard;
	/** Verdict of the final milestone — why the mission stopped. */
	finalVerdict?: MilestoneVerdict;
	outcome?: MissionOutcome;
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
