/**
 * What each kind of standing order actually does.
 *
 * All three end in the same currency — a list of findings, each optionally
 * carrying a mission goal — so the board, the ledger and the autonomy setting
 * need to know nothing about which job produced them.
 *
 * Every prompt here is written to make SILENCE cheap. A routine that reports
 * something every run trains you to skim it, and a skimmed report is the same as
 * no report at a recurring cost. Each one is told explicitly that finding
 * nothing is a valid, common outcome.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { branchesWithPrefix, defaultBranch, isMerged } from "./git.js";
import { briefingGoals, generateBriefing, repoDigest } from "./briefing.js";
import { complete, parseJson } from "./llm.js";
import { autoRouting } from "./models.js";
import { readActive } from "./registry.js";
import { fingerprint, knownTitles, type Finding, type Routine } from "./routines.js";
import { dispatchScouts, loadAgentSpecs } from "./subagent.js";

/**
 * Everything this routine has already reported, as a prompt block.
 *
 * Empty for a first run. Injected into every generating prompt because string
 * hashing cannot see paraphrase: two runs produced "Investigate and land or
 * discard the two unmerged branches" and "Reconcile the two unmerged mission
 * branches" — the same finding, barely a shared word.
 */
function alreadyReported(r: Routine): string {
	const known = knownTitles(r.id);
	if (!known.length) return "";
	const list = known.map((t) => `- ${t}`).join("\n");
	return `\n\nALREADY REPORTED — you have raised each of these before. Do NOT raise any of them again, in any wording.\nA reworded repeat is still a repeat, and it is the single fastest way to make this report worthless.\nIf everything you would say is already on this list, return an empty array — that is the correct answer.\n${list}`;
}

export interface JobResult {
	findings: Finding[];
	costUsd: number;
	note?: string;
}

function git(repo: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: repo, encoding: "utf-8", maxBuffer: 1 << 22, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
	} catch {
		return "";
	}
}

function readIfPresent(repo: string, names: string[], cap = 2000): string {
	for (const n of names) {
		const p = join(repo, n);
		if (!existsSync(p)) continue;
		try {
			return readFileSync(p, "utf-8").slice(0, cap);
		} catch {
			/* skip */
		}
	}
	return "";
}

/** Strip a fenced JSON block or surrounding prose before parsing. */
function parseArray<T>(text: string): T[] {
	const direct = parseJson<T[]>(text);
	if (Array.isArray(direct)) return direct;
	const m = text.match(/\[[\s\S]*\]/);
	const salvaged = m ? parseJson<T[]>(m[0]) : null;
	return Array.isArray(salvaged) ? salvaged : [];
}

// ---------------------------------------------------------------------------
// research — what the field is doing that this repo has not caught up with
// ---------------------------------------------------------------------------

export async function runResearch(r: Routine): Promise<JobResult> {
	const brief = await generateBriefing({ repo: r.repo, queries: r.queries ?? [], maxVideos: 4 });
	const findings = briefingGoals(brief).map((g): Finding => ({
		fingerprint: fingerprint(r.repo, g.goal),
		title: g.goal,
		detail: g.rationale,
		goal: g.goal,
		source: g.source,
	}));
	const watched = brief.watched.length;
	const kept = brief.items.filter((i) => i.verdict === "gap").length;
	return {
		findings,
		costUsd: brief.costUsd,
		note: `watched ${watched} video(s), ${brief.skipped.length} skipped; ${kept} gap(s) survived grounding`,
	};
}

// ---------------------------------------------------------------------------
// plan — what still stands between this repo and shipping
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = `You are the head of engineering for a solo founder, doing the thinking they would do on a Sunday evening:
what actually stands between this repository and being finished.

You are given the repo's capability map, its recent commits, its README, and the state of its own
automated missions — including which ones STALLED or still need review, and which branches were never merged.

Rules:
- Ground every item in the evidence you were given. Name the module, commit, branch or mission. An item
  you cannot source is an item you invent, and invented work is worse than none.
- Prioritise UNFINISHED work over new work. A stalled mission, an unmerged branch, or a half-migrated
  module is a debt already taken on; propose paying it before opening a new front.
- Look for the gap between what the README PROMISES and what the capability map shows EXISTS.
- Skip anything cosmetic, anything needing a product decision only the founder can make, and anything
  already visibly in progress.
- Returning an EMPTY list is a correct and common answer. A repo between milestones genuinely has
  nothing urgent, and saying so is more useful than filling the page.

Output ONLY a JSON array, no prose:
[ { "title": "short imperative", "why": "<=20 words, cites the evidence", "goal": "one line a coding agent could act on, or omit if this needs a human decision" } ]
At most 5, hardest-blocking first.`;

export async function runPlan(r: Routine): Promise<JobResult> {
	const records = readActive().filter((x) => x.repo === r.repo);
	const stalled = records.filter((x) => x.done && !x.cleared);
	const base = defaultBranch(r.repo);
	const unmerged = branchesWithPrefix(r.repo, "missions/").filter((b) => !isMerged(r.repo, b, base));

	const user = `REPO: ${r.repo}

CAPABILITY MAP (what each module actually does):
${repoDigest(r.repo)}

RECENT COMMITS:
${git(r.repo, ["log", "-20", "--pretty=%h %s"]) || "(none)"}

README / ROADMAP (excerpt):
${readIfPresent(r.repo, ["README.md", "readme.md", "ROADMAP.md", "docs/README.md"]) || "(none)"}

ITS OWN MISSIONS — work already started here:
${stalled.length ? stalled.map((x) => `- [${x.verdict ?? x.status}] ${x.goal}`).join("\n") : "(none awaiting review)"}

BRANCHES NEVER MERGED (work done and then dropped):
${unmerged.length ? unmerged.join("\n") : "(none)"}

What stands between this repo and being finished?${alreadyReported(r)}`;

	const { text, costUsd } = await complete(autoRouting().orchestrator, PLAN_SYSTEM, user);
	const parsed = parseArray<{ title?: string; why?: string; goal?: string }>(text);
	const findings = parsed
		.filter((p) => p?.title)
		.slice(0, 5)
		.map((p): Finding => ({
			fingerprint: fingerprint(r.repo, String(p.title)),
			title: String(p.title).trim(),
			detail: String(p.why ?? "").trim(),
			goal: p.goal ? String(p.goal).trim() : undefined,
			source: "plan",
		}));
	return {
		findings,
		costUsd,
		note: `${stalled.length} mission(s) awaiting review, ${unmerged.length} unmerged branch(es) considered`,
	};
}

// ---------------------------------------------------------------------------
// bugbash — hunt for defects nobody has reported
// ---------------------------------------------------------------------------

/**
 * Distinct lenses rather than one repeated question.
 *
 * Scouts run concurrently and cannot see each other, so asking four of them the
 * same thing buys four correlated answers. Each lens below fails in a way the
 * others are blind to — which is the only reason to pay for four.
 */
const LENSES = [
	{
		name: "fail-open",
		q: "Find places where an error is caught and the code then proceeds as if it had succeeded — a swallowed exception, a default returned on parse failure, a lenient coercion that turns malformed input into empty-but-valid output. For each, name the file and line and say what a caller would wrongly believe.",
	},
	{
		name: "ordering",
		q: "Find places where state is written, committed or reported BEFORE the operation that justifies it has actually succeeded, or where cleanup is skipped on an error path. Name file and line and describe the resulting inconsistent state.",
	},
	{
		name: "async",
		q: "Find promises that are not awaited, async work whose rejection nobody handles, or concurrent operations that race on the same file or variable. Name file and line and describe the observable symptom.",
	},
	{
		name: "boundary",
		q: "Find input the code assumes is well-formed but is not guaranteed to be: unchecked array indexing, an assumed non-empty collection, a regex that can run away, an unvalidated external response. Name file and line and give an input that breaks it.",
	},
];

const TRIAGE_SYSTEM = `You are triaging raw defect reports from independent read-only scouts into a short list a founder can act on.

The scouts were thorough but uncalibrated. Your job is to be the sceptic:
- DROP anything the report cannot source to a specific file and line.
- DROP style, naming, "consider extracting", missing JSDoc, and anything whose only cost is taste.
- DROP anything where the "bug" requires a caller that does not exist in this codebase.
- MERGE reports from different scouts that describe the same underlying defect.
- KEEP only defects where you can state a concrete failure: given this input or state, this wrong thing happens.

Returning an EMPTY list is a correct and common answer for a codebase in good shape. Do not pad.

Output ONLY a JSON array, no prose:
[ { "title": "short defect name", "file": "path:line", "failure": "given X, Y happens", "goal": "one line a coding agent could act on to fix it" } ]
At most 5, most severe first.`;

export async function runBugbash(r: Routine): Promise<JobResult> {
	const scope = r.scope?.trim() || "the whole project's own source directory";
	const specs = loadAgentSpecs(r.repo);
	const results = await dispatchScouts({
		cwd: r.repo,
		specs,
		tasks: LENSES.map((l) => ({ agent: "scout", task: `Hunt for defects in ${scope}.\n\n${l.q}\n\nIf you find nothing of this kind, say so plainly — that is a useful answer.` })),
	});

	const scoutCost = results.reduce((n, x) => n + x.costUsd, 0);
	const raw = results
		.filter((x) => x.ok && x.output.trim())
		.map((x, i) => `## scout ${LENSES[i]?.name ?? i}\n${x.output}`)
		.join("\n\n");
	if (!raw.trim()) return { findings: [], costUsd: scoutCost, note: "scouts returned nothing" };

	const { text, costUsd } = await complete(autoRouting().orchestrator, TRIAGE_SYSTEM, `REPO: ${r.repo}\nSCOPE: ${scope}${alreadyReported(r)}\n\nRAW SCOUT REPORTS:\n${raw}`);
	const parsed = parseArray<{ title?: string; file?: string; failure?: string; goal?: string }>(text);
	const findings = parsed
		.filter((p) => p?.title && p?.file)
		.slice(0, 5)
		.map((p): Finding => ({
			// Fingerprinted on title + file so the same defect at the same place is one finding,
			// however differently a later run words it.
			fingerprint: fingerprint(r.repo, `${p.title} ${p.file}`),
			title: `${String(p.title).trim()} (${String(p.file).trim()})`,
			detail: String(p.failure ?? "").trim(),
			goal: p.goal ? String(p.goal).trim() : undefined,
			source: "bugbash",
		}));
	return {
		findings,
		costUsd: scoutCost + costUsd,
		note: `${LENSES.length} lenses, ${results.filter((x) => x.ok).length} returned; ${parsed.length} raw → ${findings.length} kept`,
	};
}

export function jobFor(kind: Routine["kind"]): (r: Routine) => Promise<JobResult> {
	if (kind === "research") return runResearch;
	if (kind === "plan") return runPlan;
	return runBugbash;
}

export const REPO_LABEL = (repo: string): string => basename(repo) || repo;
