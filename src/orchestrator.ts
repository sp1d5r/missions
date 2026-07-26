import { complete, parseJson } from "./llm.js";
import type { Assertion, Feature, Handoff, IssueDisposition, MissionConfig, Plan, ScoreCard } from "./types.js";

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
- Every feature maps to one or more assertion ids; every assertion is covered by at least one feature.
- "procedures" are per-feature working rules for the worker (what to run, what to leave alone, what to check
  before finishing). The worker reports whether it followed them. Use them where a feature has a sharp edge.
- Keep it tight. 1-3 features for a first pass unless the goal clearly needs more.

Output ONLY a JSON object, no prose, in exactly this shape:
{
  "summary": "one paragraph: what we will do and why",
  "architectureNote": "one line: current state -> target state",
  "features": [
    { "id": "f1", "title": "short", "description": "what to change and where", "assertionIds": ["a1"],
      "procedures": ["run the targeted test before finishing", "do not touch the public API"] }
  ],
  "contract": {
    "assertions": [
      { "id": "a1", "statement": "observable claim that must hold",
        "method": { "type": "bash-command", "command": "npm test", "expectedExitCode": 0 } }
      // or { "type": "code-review", "focus": "..." }
      // or { "type": "behavioral", "scenario": "scenario-name-or-path", "threshold": 0.5 }
    ]
  }
}`;

export async function planMission(config: MissionConfig, repoSummary: string): Promise<{ plan: Plan; costUsd: number }> {
	const userPrompt = `TARGET REPO: ${config.targetCwd}
GOAL:
${config.goal}

ENGINEER'S RFC:
${config.rfc || "(none provided)"}

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
		features: parsed.features.map((f, i) => ({
			id: f.id ?? `f${i + 1}`,
			title: f.title ?? `Feature ${i + 1}`,
			description: f.description ?? "",
			assertionIds: Array.isArray(f.assertionIds) ? f.assertionIds : [],
			procedures: Array.isArray(f.procedures) ? f.procedures.filter((p) => typeof p === "string") : undefined,
		})),
		contract: { assertions: Array.isArray(parsed.contract.assertions) ? parsed.contract.assertions : [] },
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
2. RULE ON EVERY OPEN ISSUE. Each issue a worker raised must get "addressed" (a correction picks it up) or
   "deferred" (with a reason it is safe to leave). You may not leave an issue unruled — the harness blocks
   the mission if you do.
3. SCOPE CORRECTIONS. Write corrective features for the next milestone, each small enough for one fresh
   worker with clean context. Target the failing assertions, the blocking bugs, and the issues you marked
   "addressed".

Rules for corrections:
- A correction must name what it resolves in "addresses" — the failing assertion ids, bug summaries, or issue text.
- Reuse the EXISTING assertion ids in "assertionIds". Do not invent new assertions; the contract is fixed.
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
    { "summary": "must match the issue summary verbatim", "disposition": "addressed" | "deferred", "note": "why" }
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
	note?: string;
}

export interface MilestoneReview {
	assessment: string;
	verdict: "passed" | "needs-corrections" | "stalled";
	issueRulings: CorrectionRuling[];
	corrections: Feature[];
	costUsd: number;
}

export interface ScopeCorrectionsOptions {
	config: MissionConfig;
	milestone: number;
	assertions: Assertion[];
	scoreCard: ScoreCard;
	handoffs: Handoff[];
	remainingUsd: number;
	milestonesLeft: number;
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
Budget remaining: $${remainingUsd.toFixed(2)}. Milestones remaining after this boundary: ${milestonesLeft}.

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
	}>(text);

	if (!parsed) {
		// A boundary we cannot read is a stall, not a pass. Never fail open.
		return {
			assessment: `Orchestrator returned an unreadable milestone review. Raw: ${text.slice(0, 500)}`,
			verdict: "stalled",
			issueRulings: [],
			corrections: [],
			costUsd,
		};
	}

	const validAssertionIds = new Set(assertions.map((a) => a.id));
	const rawCorrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
	const corrections: Feature[] = rawCorrections
		.map((raw, i) => {
			const f = raw as Partial<Feature>;
			return {
				id: typeof f.id === "string" && f.id.trim() ? f.id : `m${milestone + 1}c${i + 1}`,
				title: typeof f.title === "string" && f.title.trim() ? f.title : `Correction ${i + 1}`,
				description: typeof f.description === "string" ? f.description : "",
				assertionIds: Array.isArray(f.assertionIds) ? f.assertionIds.filter((id) => validAssertionIds.has(id)) : [],
				procedures: Array.isArray(f.procedures) ? f.procedures.filter((p) => typeof p === "string") : undefined,
				addresses: Array.isArray(f.addresses) ? f.addresses.filter((a) => typeof a === "string") : undefined,
				milestone: milestone + 1,
				origin: "correction" as const,
			};
		})
		.filter((f) => f.description.trim().length > 0);

	const rawRulings = Array.isArray(parsed.issueRulings) ? parsed.issueRulings : [];
	const issueRulings: CorrectionRuling[] = rawRulings
		.map((raw) => {
			const r = raw as { summary?: unknown; disposition?: unknown; note?: unknown };
			const summary = typeof r?.summary === "string" ? r.summary.trim() : "";
			const disposition: IssueDisposition = r?.disposition === "deferred" ? "deferred" : "addressed";
			return { summary, disposition, note: typeof r?.note === "string" ? r.note : undefined };
		})
		.filter((r) => r.summary.length > 0);

	const verdict = parsed.verdict === "passed" || parsed.verdict === "stalled" ? parsed.verdict : "needs-corrections";

	return {
		assessment: typeof parsed.assessment === "string" ? parsed.assessment : "",
		// A "needs-corrections" verdict with nothing to do is a stall by another name.
		verdict: verdict === "needs-corrections" && corrections.length === 0 ? "stalled" : verdict,
		issueRulings,
		corrections,
		costUsd,
	};
}
