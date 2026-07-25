import { complete, parseJson } from "../llm.js";
import type { BugFinding, ModelSpec } from "../types.js";

const SYSTEM_PROMPT = `You are an ADVERSARIAL code reviewer with fresh eyes and no attachment to the code.
You are shown a unified git diff. Your job is to catch the obvious bugs a busy engineer would miss while context-switching:
off-by-one, null/undefined, wrong variable, inverted conditions, swapped args, missing await, resource leaks,
broken error handling, security footguns, and changes that plainly contradict the stated intent.

Be precise and skeptical, but do NOT invent problems. Only report defects you can point to in the diff.
Prefer few high-signal findings over many weak ones. If the diff looks clean, return an empty array.

Output ONLY a JSON array (no prose):
[ { "severity": "critical|high|medium|low", "file": "path", "line": 123, "summary": "<=10 words", "detail": "why it is a bug and the failing scenario" } ]`;

export async function spotBugs(model: ModelSpec, intent: string, diff: string): Promise<{ bugs: BugFinding[]; costUsd: number }> {
	if (!diff.trim()) return { bugs: [], costUsd: 0 };
	const userPrompt = `INTENT of this change (what it is supposed to do):
${intent}

UNIFIED DIFF:
${diff.slice(0, 60_000)}

Review it. Report only real defects.`;
	const { text, costUsd } = await complete(model, SYSTEM_PROMPT, userPrompt);
	const parsed = parseJson<BugFinding[]>(text);
	const bugs = Array.isArray(parsed) ? parsed.filter((b) => b && b.summary) : [];
	return { bugs, costUsd };
}
