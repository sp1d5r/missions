import { complete, parseJson } from "./llm.js";
import type { Assertion, AssertionStrength, Feature, Handoff, IssueDisposition, MissionConfig, Plan, ScoreCard } from "./types.js";

const SYSTEM_PROMPT = `You are the ORCHESTRATOR of an autonomous engineering org working on a target code repository.
A human engineer hands you a GOAL and an RFC (their "here is what is wrong / what I want" notes). You do NOT write code.
You produce a lean plan AND a validation contract that defines "done" BEFORE any code is written.

Principles:
- Features are single, demonstrable changes a fresh worker can implement in isolation and commit. Small and concrete.
- The validation contract is how we PROVE the work — write assertions first, independent of implementation.
- Prefer assertions that can be checked cheaply and offline:
  - "bash-command": a shell command in the repo whose exit code proves the assertion (tests, typecheck, a grep).
  - "code-review": a focused thing an adversarial reviewer must confirm by reading the diff.
  - "behavioral": only when a concrete end-to-end scenario clearly applies (the target adapter runs it).
- Every "bash-command" assertion runs with its working directory set to the MISSION WORKTREE — an isolated
  checkout that is not the path the repo normally lives at. So: use RELATIVE paths only, and never \`cd\` to an
  absolute path. A command that reaches outside the worktree is refused by the harness and the assertion fails,
  because it would prove something about a different checkout than the one the work happened in.
- Every feature maps to one or more assertion ids; every assertion is covered by at least one feature.
- "procedures" are per-feature working rules for the worker (what to run, what to leave alone, what to check
  before finishing). The worker reports whether it followed them. Use them where a feature has a sharp edge.
- Keep it tight. 1-3 features for a first pass unless the goal clearly needs more.

Every assertion MUST carry a "strength" field — this is required for the verdict to be honest.
The three allowed values and their exact semantics:
- "behavioural": the command actually EXECUTES the feature (calls the code, runs the binary, exercises real
  logic). Only a passing behavioural assertion suppresses the existence-only warning in the final verdict.
  Example: node dist/cli.js view "$RUN_ID" --json | jq -e '.timeline | length > 0'
- "existence": the command only inspects the filesystem without executing the feature (file present, symbol
  exported, pattern grep'd). Does NOT suppress the existence-only warning on its own.
  Example: test -f src/mission-view.ts && grep -q 'export' src/mission-view.ts
- "review": a human or LLM reads the diff and judges it. Always use this for code-review method assertions.
  Does NOT suppress the existence-only warning on its own.

Aim for at least one "behavioural" assertion per feature where a testable surface exists. An existence-only run
prints a warning in the final verdict. The harness auto-corrects declared "behavioural" to "existence" if the
command is purely filesystem-inspection (test, ls, stat, find, grep, cat, head, wc, etc.) — so declare honestly.
Note: "behavioral" method assertions (end-to-end scenarios) are SKIPPED by the harness and counted as NOT
passed — they never satisfy the behavioural strength requirement. Use bash-command with strength "behavioural"
for executable checks.

ARCHITECTURE. Draw the part of the system this mission touches, as mermaid flowchart source in
the "architecture" field. Rules that make it worth reading:
- Components as they exist in THIS repo — real module, service or file names, not generic boxes.
- Edges are real relationships: calls, reads, writes, publishes to. Label them.
- Mark every node this mission CHANGES with :::touched, and end with the line
  classDef touched stroke:#d08b28,stroke-width:2px
  That contrast — what exists versus what you are about to move — is the point of the diagram.
- Six to twelve nodes. A diagram of everything is a diagram of nothing.
- Quote every label ("like this") so punctuation cannot break the parse, and use <br/> for line
  breaks. Do not use parentheses or angle brackets inside a label.
Example shape:
  flowchart LR
    A["relay.ts"] -->|"publishes"| B["pubsub.ts"]
    B --> C["db.ts"]:::touched
    classDef touched stroke:#d08b28,stroke-width:2px

Output ONLY a JSON object, no prose, in exactly this shape:
{
  "summary": "one paragraph: what we will do and why",
  "architectureNote": "one line: current state -> target state",
  "architecture": "mermaid flowchart source — see ARCHITECTURE below",
  "features": [
    { "id": "f1", "title": "short", "description": "what to change and where", "assertionIds": ["a1"],
      "procedures": ["run the targeted test before finishing", "do not touch the public API"] }
  ],
  "contract": {
    "assertions": [
      { "id": "a1", "statement": "observable claim that must hold", "strength": "behavioural",
        "method": { "type": "bash-command", "command": "npm test", "expectedExitCode": 0 } },
      { "id": "a2", "statement": "file exists and is importable", "strength": "existence",
        "method": { "type": "bash-command", "command": "test -f src/foo.ts", "expectedExitCode": 0 } },
      { "id": "a3", "statement": "reviewer confirms the design", "strength": "review",
        "method": { "type": "code-review", "focus": "..." } },
      { "id": "a4", "statement": "scenario passes", "strength": "behavioural",
        "method": { "type": "behavioral", "scenario": "scenario-name-or-path", "threshold": 0.5 } }
    ]
  }
}`;

export interface PlanContext {
	/** Where workers and assertions actually run. Planning against targetCwd is what produced
	 *  assertions that cd'd into the main checkout and validated the wrong tree. */
	workCwd: string;
	/** Repo environment ground truth, so the plan does not casually propose spending money or DDL. */
	envDoctrine?: string;
}

/**
 * Read the planner's `architecture` field into usable mermaid source, or nothing.
 *
 * Tolerant about packaging, strict about content. A model asked for "mermaid flowchart source"
 * will sometimes hand back a ```mermaid fence or a `---\ntitle: …\n---` header, and dropping a
 * perfectly good diagram over its wrapper is how the console ends up claiming a mission is too
 * old to have one. What it will not accept is prose: that renders as a mermaid parse error, which
 * is worse than an honest absence.
 */
export function parseArchitecture(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	let s = raw.trim();
	const fence = s.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
	if (fence?.[1]) s = fence[1].trim();
	// Mermaid's own frontmatter block, which legitimately precedes the graph declaration.
	const fm = s.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	if (fm?.[1]) s = fm[1].trim();
	return /^(flowchart|graph)\b/.test(s) ? s : undefined;
}

export async function planMission(
	config: MissionConfig,
	repoSummary: string,
	context: PlanContext,
): Promise<{ plan: Plan; costUsd: number }> {
	const doctrineText = context.envDoctrine ? `\nENVIRONMENT GROUND TRUTH:\n${context.envDoctrine}\n` : "";
	const userPrompt = `MISSION WORKTREE (workers and assertion commands run here): ${context.workCwd}
GOAL:
${config.goal}

ENGINEER'S RFC:
${config.rfc || "(none provided)"}
${doctrineText}
REPO RECON (top-level structure + signals):
${repoSummary}

Produce the plan + validation contract now. At most ${config.maxFeatures} feature(s) will be executed per milestone, so order them by leverage.`;

	const { text, costUsd } = await complete(config.routing.orchestrator, SYSTEM_PROMPT, userPrompt);
	const parsed = parseJson<Plan>(text);

	if (!parsed || !Array.isArray(parsed.features) || !parsed.contract) {
		throw new Error(`Orchestrator did not return a usable plan. Raw:\n${text.slice(0, 2000)}`);
	}
	// Coerce/guard.
	const plan: Plan = {
		summary: parsed.summary ?? "",
		architectureNote: parsed.architectureNote ?? "",
		// Only keep something that is actually a flowchart — a model that answered in prose here
		// would otherwise render as a mermaid parse error in the console.
		architecture: parseArchitecture(parsed.architecture),
		features: parsed.features.map((f, i) => ({
			id: f.id ?? `f${i + 1}`,
			title: f.title ?? `Feature ${i + 1}`,
			description: f.description ?? "",
			assertionIds: Array.isArray(f.assertionIds) ? f.assertionIds : [],
			procedures: Array.isArray(f.procedures) ? f.procedures.filter((p) => typeof p === "string") : undefined,
		})),
		contract: {
			assertions: Array.isArray(parsed.contract.assertions)
				? parsed.contract.assertions.map((raw) => {
						const a = raw as Partial<Assertion> & { method?: unknown };
						const validStrengths: AssertionStrength[] = ["behavioural", "existence", "review"];
						const strength: AssertionStrength | undefined =
							typeof a.strength === "string" && validStrengths.includes(a.strength as AssertionStrength)
								? (a.strength as AssertionStrength)
								: undefined; // missing or invalid = undefined, not a crash
						return {
							id: typeof a.id === "string" ? a.id : "",
							statement: typeof a.statement === "string" ? a.statement : "",
							method: a.method as Assertion["method"],
							...(strength !== undefined ? { strength } : {}),
						};
					})
				: [],
		},
	};
	return { plan, costUsd };
}

// ---------------------------------------------------------------------------
// Milestone boundary — the corrective loop.
//
// Validation failing on the first pass is the NORMAL case, not the error case.
// At each boundary the orchestrator reads the handoffs and the score card, rules
// on every open issue, and scopes corrective features for the next milestone.
// ---------------------------------------------------------------------------

const CORRECTION_PROMPT = `You are the ORCHESTRATOR of an autonomous engineering org, standing at a MILESTONE BOUNDARY.
Workers have implemented features and independent validators have scored them against the validation contract
written before any code existed. You do NOT write code. You decide what happens next.

You are given: the contract and its per-assertion results, the adversarial reviewer's bug findings, and each
worker's structured handoff (what it completed, what it left undone, what it actually ran with exit codes,
and what issues it discovered).

Your job:
1. ASSESS. What is the real state of the work? Where a worker CLAIMED an assertion the validators failed,
   say so plainly — that gap is the most important signal you have.
2. RULE ON EVERY OPEN ISSUE. Each issue a worker raised must get exactly one disposition:
   - "addressed": a correction IN THIS RESPONSE fixes it. You MUST name that correction in "correctionId".
   - "deferred": nothing this mission will fix it. You MUST justify it in a checkable way, with ONE of:
       "evidenceAssertionId": the id of an assertion that PASSED and already covers this concern, or
       "outOfScope": true, when the RFC did not ask for it.
     A note alone is not a justification. Prose is not checkable, and the harness rejects a deferral
     that cites neither. Do NOT claim validators confirmed something unless a passing assertion
     actually executed the code — the harness checks that too, and blocks the milestone if it did not.
   You may not leave an issue unruled, and you may not rule one "addressed" without naming the correction that
   picks it up. The harness blocks the mission on both, because an issue nobody is dispatched to fix has not
   been addressed, it has been dropped.
3. SCOPE CORRECTIONS. Write corrective features for the next milestone, each small enough for one fresh
   worker with clean context. Target the failing assertions, the blocking bugs, and the issues you marked
   "addressed".

4. STRENGTHEN THE CONTRACT. This is the step that matters most, and it is only possible now.

   The contract was written before any code existed, so it could only assert things that were
   knowable then — that a file would exist, that a flag would be accepted. Now the code IS here.
   You can read the diff, see the real interface, and write assertions that actually execute it.

   Look at what the work CLAIMS to do and ask: if this were subtly broken, which of these
   assertions would still pass? Every one that would is not protecting anything. Then write the
   assertion that would catch it — a command that runs the new code and observes an outcome.

   Rules for new assertions:
   - Only ADD. You may never delete, weaken, or reword an existing assertion, and you may never
     lower a strength. The contract ratchets in one direction.
   - Each must be BEHAVIOURAL where the interface now permits it: run the entry point, call the
     function, execute the command. A test -f, an ls or a grep proves authorship, not behaviour.
   - Each must be justified by the GOAL or the RFC. Do not invent new requirements — you are
     making the existing ones checkable, not expanding scope.
   - Each must be able to FAIL. If you cannot describe an input that would make it fail, it is
     decoration.
   - At most 3 per boundary. A contract that grows without limit never finishes.
   - If the work is genuinely unprovable by command at this point, say so in "assessment" rather
     than padding with weak assertions.

   You MUST add at least one behavioural assertion when all of these hold: code was committed this
   milestone, no behavioural assertion has passed yet, and an interface now exists to call. In that
   situation the contract has proven nothing about behaviour, and saying "passed" would be a guess.

Rules for corrections:
- A correction must name what it resolves in "addresses" — the failing assertion ids, bug summaries, or issue text.
- Reuse the EXISTING assertion ids in "assertionIds" when a correction targets one.
- Do not re-do work that passed. Only fix what is broken.
- If the work is genuinely done — every assertion passed, no blocking bugs, every issue ruled — return an
  empty "corrections" array and verdict "passed".
- If it is NOT done but you have no useful correction to offer (the failure needs a human decision, the spec
  is wrong, or the same fix already failed), return verdict "stalled" with an empty "corrections" array.
  Stalling honestly is better than burning a milestone on a guess.

Output ONLY a JSON object, no prose:
{
  "assessment": "2-4 sentences: the real state, and any claimed-but-failed assertions",
  "verdict": "passed" | "needs-corrections" | "stalled",
  "issueRulings": [
    { "summary": "must match the issue summary verbatim", "disposition": "addressed", "correctionId": "c1", "note": "why" },
    { "summary": "...", "disposition": "deferred", "evidenceAssertionId": "a3", "note": "a3 exercises this path end to end" },
    { "summary": "...", "disposition": "deferred", "outOfScope": true, "note": "the RFC explicitly excludes this" },
    { "summary": "must match the issue summary verbatim", "disposition": "deferred", "note": "why it is safe to leave" }
  ],
  "newAssertions": [
    { "id": "a7", "statement": "observable claim that must hold", "strength": "behavioural",
      "justification": "which part of the goal/RFC this makes checkable",
      "method": { "type": "bash-command", "command": "node dist/cli.js view $ID --json | jq -e '.timeline|length>0'", "expectedExitCode": 0 } }
  ],
  "corrections": [
    { "id": "c1", "title": "short", "description": "what to change and where, precisely",
      "assertionIds": ["a1"], "addresses": ["a1 failed: exit=1"],
      "procedures": ["re-run the failing command before finishing"] }
  ]
}`;

export interface CorrectionRuling {
	summary: string;
	disposition: IssueDisposition;
	/** For "addressed": which correction picks it up. Checked by the boundary invariants. */
	correctionId?: string;
	/** For "deferred": id of a PASSING assertion that already covers it. Checked by the invariants. */
	evidenceAssertionId?: string;
	/** For "deferred": the concern is outside what the RFC asked for. */
	outOfScope?: boolean;
	note?: string;
}

export interface MilestoneReview {
	assessment: string;
	verdict: "passed" | "needs-corrections" | "stalled";
	issueRulings: CorrectionRuling[];
	corrections: Feature[];
	/** Assertions added at this boundary, now that an interface exists to assert against. */
	newAssertions: Assertion[];
	costUsd: number;
}

export interface ScopeCorrectionsOptions {
	config: MissionConfig;
	milestone: number;
	assertions: Assertion[];
	scoreCard: ScoreCard;
	handoffs: Handoff[];
	/** Remaining spend under the cap, or Infinity when the mission is uncapped (the default). */
	remainingUsd: number;
	milestonesLeft: number;
}

/**
 * How the budget line reads to the orchestrator.
 *
 * Uncapped is the normal case, and "$Infinity" is both ugly and an invitation. What actually
 * constrains the orchestrator is the milestone count, so an uncapped mission says nothing about
 * money and lets the ceiling do the talking.
 */
export function budgetLine(remainingUsd: number): string {
	return Number.isFinite(remainingUsd) ? `Budget remaining: $${remainingUsd.toFixed(2)}. ` : "";
}

export async function scopeCorrections(options: ScopeCorrectionsOptions): Promise<MilestoneReview> {
	const { config, milestone, assertions, scoreCard, handoffs, remainingUsd, milestonesLeft } = options;

	const assertionLines = assertions
		.map((a) => `- (${a.id}) [${a.passed ? "PASS" : "FAIL"}] ${a.statement}${a.evidence ? `\n    evidence: ${a.evidence}` : ""}`)
		.join("\n");

	const bugLines = scoreCard.bugs.length
		? scoreCard.bugs.map((b) => `- [${b.severity}] ${b.summary}${b.file ? ` (${b.file}${b.line ? `:${b.line}` : ""})` : ""}\n    ${b.detail}`).join("\n")
		: "(none)";

	const handoffLines = handoffs
		.map((h) => {
			const claimed = h.assertionsClaimed.length ? h.assertionsClaimed.join(", ") : "(none)";
			const undone = h.leftUndone.length ? h.leftUndone.map((u) => `\n    - ${u}`).join("") : " (none reported)";
			const issues = h.issues.length ? h.issues.map((i) => `\n    - ${i.summary}${i.detail ? `: ${i.detail}` : ""}`).join("") : " (none reported)";
			const cmds = h.commands.length
				? h.commands.map((c) => `\n    - [exit ${c.exitCode ?? "?"}] ${c.command}`).join("")
				: " (ran nothing)";
			return `FEATURE ${h.featureId} — confidence ${h.confidence}${h.degraded ? " (HANDOFF DEGRADED: worker did not emit a structured handoff)" : ""}
  completed: ${h.completed}
  assertions claimed: ${claimed}
  procedures followed: ${h.proceduresFollowed}${h.procedureNotes ? ` — ${h.procedureNotes}` : ""}
  stopped because: ${h.stopReason}${h.aborted ? " (BUDGET-CAPPED mid-flight)" : ""}
  left undone:${undone}
  issues raised:${issues}
  commands run:${cmds}`;
		})
		.join("\n\n");

	const openIssues = handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition));
	const openIssueLines = openIssues.length ? openIssues.map((i) => `- ${i.summary}`).join("\n") : "(none)";

	const userPrompt = `GOAL:
${config.goal}

ENGINEER'S RFC:
${config.rfc || "(none provided)"}

MILESTONE ${milestone} JUST COMPLETED.
${budgetLine(remainingUsd)}Milestones remaining after this boundary: ${milestonesLeft}.

VALIDATION CONTRACT RESULTS (${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal} passed):
${assertionLines}

ADVERSARIAL REVIEWER FINDINGS:
${bugLines}

WORKER HANDOFFS:
${handoffLines}

OPEN ISSUES YOU MUST RULE ON (every one needs a disposition):
${openIssueLines}

Assess, rule on the issues, and scope corrections now. At most ${config.maxFeatures} correction(s) will be executed next milestone, so order them by leverage.`;

	const { text, costUsd } = await complete(config.routing.orchestrator, CORRECTION_PROMPT, userPrompt);
	const parsed = parseJson<{
		assessment?: string;
		verdict?: string;
		issueRulings?: unknown;
		corrections?: unknown;
		newAssertions?: unknown;
	}>(text);

	if (!parsed) {
		// A boundary we cannot read is a stall, not a pass. Never fail open.
		return {
			assessment: `Orchestrator returned an unreadable milestone review. Raw: ${text.slice(0, 500)}`,
			verdict: "stalled",
			issueRulings: [],
			corrections: [],
			newAssertions: [],
			costUsd,
		};
	}

	const validAssertionIds = new Set(assertions.map((a) => a.id));
	const rawCorrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
	// The orchestrator restarts its own numbering at every boundary, so a bare "c1" from
	// milestone 3 would collide with milestone 2's "c1" in state.features. Namespacing is a
	// clerical fix, not a judgement call, so the harness does it rather than stalling over it.
	const prefix = `m${milestone + 1}`;
	const idMap = new Map<string, string>();
	const corrections: Feature[] = rawCorrections
		.map((raw, i) => {
			const f = raw as Partial<Feature>;
			const givenId = typeof f.id === "string" && f.id.trim() ? f.id.trim() : `c${i + 1}`;
			const id = givenId.startsWith(prefix) ? givenId : `${prefix}${givenId}`;
			idMap.set(givenId, id);
			return {
				id,
				title: typeof f.title === "string" && f.title.trim() ? f.title : `Correction ${i + 1}`,
				description: typeof f.description === "string" ? f.description : "",
				assertionIds: Array.isArray(f.assertionIds) ? f.assertionIds.filter((aid) => validAssertionIds.has(aid)) : [],
				procedures: Array.isArray(f.procedures) ? f.procedures.filter((p) => typeof p === "string") : undefined,
				addresses: Array.isArray(f.addresses) ? f.addresses.filter((a) => typeof a === "string") : undefined,
				milestone: milestone + 1,
				origin: "correction" as const,
			};
		})
		.filter((f) => f.description.trim().length > 0);

	const rawRulings = Array.isArray(parsed.issueRulings) ? parsed.issueRulings : [];
	const issueRulings: CorrectionRuling[] = rawRulings.flatMap((raw): CorrectionRuling[] => {
		const r = raw as { summary?: unknown; disposition?: unknown; correctionId?: unknown; note?: unknown };
		const summary = typeof r?.summary === "string" ? r.summary.trim() : "";
		// Closed value set. Anything else is dropped rather than guessed at: an unrecognised
		// disposition coerced to "addressed" would close an issue nobody ruled on. Dropping
		// leaves it open, which blocks the pass — the safe direction to fail in.
		const disposition: IssueDisposition | undefined =
			r?.disposition === "addressed" || r?.disposition === "deferred" ? r.disposition : undefined;
		if (!summary || !disposition) return [];
		const given = typeof r?.correctionId === "string" ? r.correctionId.trim() : "";
		return [
			{
				summary,
				disposition,
				correctionId: given ? (idMap.get(given) ?? given) : undefined,
				note: typeof r?.note === "string" ? r.note : undefined,
			},
		];
	});

	// New assertions are capped and coerced. An id that collides with an existing one is dropped
	// rather than allowed to overwrite it — the ratchet must not be defeated by reusing an id.
	const existingIds = new Set(assertions.map((a) => a.id));
	const rawNew = Array.isArray(parsed.newAssertions) ? parsed.newAssertions : [];
	const newAssertions: Assertion[] = rawNew
		.map((raw) => raw as Partial<Assertion> & { justification?: string })
		.filter((a) => typeof a.id === "string" && a.id.trim() && !existingIds.has(a.id))
		.filter((a) => a.method && typeof a.statement === "string" && a.statement.trim())
		.slice(0, 3)
		.map((a) => ({
			id: a.id as string,
			statement: a.statement as string,
			method: a.method as Assertion["method"],
			strength: a.strength,
			addedAtMilestone: milestone + 1,
			justification: typeof a.justification === "string" ? a.justification : undefined,
		}));

	const verdict = parsed.verdict === "passed" || parsed.verdict === "stalled" ? parsed.verdict : "needs-corrections";

	return {
		assessment: typeof parsed.assessment === "string" ? parsed.assessment : "",
		// A "needs-corrections" verdict with nothing to do is a stall by another name.
		verdict: verdict === "needs-corrections" && corrections.length === 0 ? "stalled" : verdict,
		issueRulings,
		corrections,
		newAssertions,
		costUsd,
	};
}
