import { complete, parseJson } from "./llm.js";
import type { MissionConfig, Plan } from "./types.js";

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
- Keep it tight. 1-3 features for a first pass unless the goal clearly needs more.

Output ONLY a JSON object, no prose, in exactly this shape:
{
  "summary": "one paragraph: what we will do and why",
  "architectureNote": "one line: current state -> target state",
  "features": [
    { "id": "f1", "title": "short", "description": "what to change and where", "assertionIds": ["a1"] }
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

Produce the plan + validation contract now. At most ${config.maxFeatures} feature(s) will be executed this run, so order them by leverage.`;

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
		})),
		contract: { assertions: Array.isArray(parsed.contract.assertions) ? parsed.contract.assertions : [] },
	};
	return { plan, costUsd };
}
