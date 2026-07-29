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

/**
 * Strength of an assertion — how strongly it proves the feature works.
 *
 * - "behavioural": the command actually EXECUTES the feature (calls the code, runs the binary).
 * - "existence": the command only inspects the filesystem (test -f, ls, stat, find, grep, cat, etc.).
 * - "review": a human or LLM reads the diff and judges it (code-review method).
 *
 * Optional — missing means unclassified. Harness will auto-correct declared 'behavioural'
 * assertions whose command is purely filesystem-inspection to 'existence'.
 */
export type AssertionStrength = "behavioural" | "existence" | "review";

export interface Assertion {
	id: string;
	statement: string;
	method: ValidationMethod;
	/**
	 * How strongly this assertion proves the feature. Optional — plans without it still parse and run.
	 * See AssertionStrength for semantics.
	 */
	strength?: AssertionStrength;
	/** Milestone this assertion was added at. Absent = written at plan time, before code existed. */
	addedAtMilestone?: number;
	/** For boundary-added assertions: which part of the goal/RFC this makes checkable. */
	justification?: string;
	/** Filled in by validators. */
	passed?: boolean;
	evidence?: string;
	/**
	 * Set by the validator when the assertion's owning feature has not been dispatched yet.
	 * Pending assertions are excluded from the failing set but still block a CLEAN verdict.
	 */
	pending?: boolean;
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
	/**
	 * A real system-architecture diagram, as mermaid `flowchart` source.
	 *
	 * `architectureNote` is one line ("current -> target"), which is a caption, not a diagram —
	 * the console could only ever draw the contract map from it, and a feature-to-assertion
	 * mapping is not architecture. Reviewing a change at the level of "what talks to what, and
	 * which of those does this mission touch" needs the planner to actually say so, and the
	 * planner is the only thing in the system that has read the repo and decided.
	 *
	 * Optional: plans written before this existed still parse and run.
	 */
	architecture?: string;
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
	/**
	 * Set by the strength classifier when a declared 'behavioural' assertion is downgraded
	 * because its command is purely filesystem-inspection. Never set on upgrades (there are none).
	 */
	strengthCorrected?: boolean;
	/** The strength declared in the assertion schema, before any classifier correction. */
	declaredStrength?: AssertionStrength;
	/** The effective strength after classifier correction. */
	effectiveStrength?: AssertionStrength;
}

/** Per-strength breakdown of assertion counts. */
export interface StrengthBreakdown {
	behavioural: { passed: number; total: number };
	existence: { passed: number; total: number };
	review: { passed: number; total: number };
	unclassified: { passed: number; total: number };
}

export interface ScoreCard {
	assertionsPassed: number;
	assertionsTotal: number;
	checks: CheckResult[];
	bugs: BugFinding[];
	costUsd: number;
	/** Per-strength breakdown of assertions. Present when the plan has strength annotations. */
	strengthBreakdown?: StrengthBreakdown;
	/**
	 * Assertion ids whose owning feature has not been dispatched in any milestone so far.
	 * Excluded from the failing set used by triage and stall decisions; still block a CLEAN verdict.
	 * Absent when there are no pending assertions.
	 */
	pendingAssertionIds?: string[];
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
	/**
	 * For "deferred": the id of a PASSING assertion that already covers this concern.
	 *
	 * Deferring used to accept free prose, and prose is not checkable. A real run closed an
	 * issue reading "end-to-end mission run not verified" with the note "validators
	 * independently confirmed the code behavior" — while every assertion was a `test -f` or a
	 * grep, and nothing had executed the feature. The mission then reported CLEAN. Naming an
	 * assertion makes the claim falsifiable.
	 */
	deferredEvidence?: string;
	/** For "deferred": the concern is outside what the RFC asked for. The alternative to citing evidence. */
	deferredOutOfScope?: boolean;
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
	/** Operator steers injected mid-run. Recorded so "what did this worker decide" stays answerable. */
	steers?: string[];
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
	/**
	 * How long a STALLED milestone stays open for an operator to steer its worker, in ms.
	 *
	 * A stall is the moment the mission most needs a human, and its workers still hold everything
	 * expensive — the files they read, why they chose what they chose. Exiting immediately throws
	 * that away. 0 disables the wait (right for cron and CI, where nobody is watching).
	 * Default 0, so unattended runs behave exactly as before.
	 */
	rescueWaitMs?: number;
	/** Which target adapter to use for behavioral validation. */
	target: "generic" | "nadine";
	/** Run in an isolated git worktree (enables true parallel missions). Default true. */
	useWorktree?: boolean;
	/** Provenance, carried into MissionState and the changelog. Defaults to "human". */
	origin?: MissionOrigin;
}

// ---------------------------------------------------------------------------
// Structured event log — appended alongside the free-text mission.log so the
// mission-view timeline pane can render typed events without parsing log strings.
// ---------------------------------------------------------------------------

export type MissionEventKind =
	| "status_transition"
	| "tool_call"
	| "validation_result"
	| "milestone_verdict"
	| "lifecycle"
	| "error"
	| "image";

export interface MissionEvent {
	/** ISO timestamp. */
	at: string;
	kind: MissionEventKind;
	/** Short human-readable label shown in the timeline. */
	label: string;
	/** Optional extra detail (tool args, assertion id, verdict reason, etc.). */
	detail?: string;
	/**
	 * Which seat posted this — see seats.ts. Optional because missions written before this field
	 * existed are still on disk and still have to render; `seatOf` guesses from the kind for those.
	 */
	seat?: import("./seats.js").Seat;
	/**
	 * Groups an event with the detail events that belong to it: a validation summary and the
	 * per-assertion results underneath it share a thread id, so the timeline can show one line
	 * with "5 replies" instead of six lines of equal weight.
	 *
	 * The FIRST event carrying a given id is the parent. That ordering rule is what makes this a
	 * single string rather than a parent pointer plus an id on every event — the emitter already
	 * writes them in order, and inventing ids for events nothing ever references is cost with no
	 * reader.
	 */
	thread?: string;
	/** Populated for kind="image" events: the stored image on disk. */
	image?: {
		path: string;
		mimeType: string;
		bytes: number;
		alt?: string;
	};
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
	/**
	 * First port of the block this worktree owns (ports.ts). Recorded so a human reading a report
	 * knows where the mission's services were, without re-deriving the hash.
	 */
	portBase?: number;
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
	/**
	 * Plain-language explanation of why the mission stalled, surfaced wherever
	 * "NEEDS YOU" is printed. Includes a full sentence, optional invariant slugs
	 * as detail, and a note on what the harness tried before giving up.
	 */
	stallReason?: string;
	costUsd: number;
	reportPath?: string;
	log: string[];
	/** Structured event log for the timeline pane; appended alongside mission.log. */
	events?: MissionEvent[];
	/**
	 * Human-readable debrief assembled from state at end-of-run: summarises commits, handoffs,
	 * leftUndone, issues/dispositions, and scoreCard strength. Must not use unqualified success
	 * language when the strength breakdown is existence-only.
	 */
	debrief?: string;
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
