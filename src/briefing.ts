/**
 * Video briefings: keep the harness current without letting it chase fashion.
 *
 * The premise is narrow and worth stating, because the obvious version of this
 * feature is bad. Watching popular videos and acting on them would pipe
 * conference-talk consensus straight into the codebase, and popularity is
 * anti-correlated with novelty here — the most-viewed results are explainers of
 * things we already do.
 *
 * What actually produced value the one time this worked by hand: a talk
 * described a practice, the practice was compared against the code, and the gap
 * between them turned out to be real. The talk supplied a NAME and a PLACE for
 * something the code was already doing badly. The idea alone was worth nothing.
 *
 * So the pipeline is deliberately shaped as: extract claims → ground every claim
 * against this repo → keep only what survives. A claim that cannot be tied to a
 * specific file is dropped, not softened. The output is a briefing a human
 * triages, never a mission that dispatches itself.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { complete, parseJson } from "./llm.js";
import { autoRouting } from "./models.js";
import { topLevelRecon } from "./target/generic.js";
import { fetchTranscript, searchVideos, type Transcript, type VideoMeta } from "./youtube.js";

export type Verdict = "gap" | "already-have" | "not-applicable";

export interface BriefingItem {
	claim: string;
	/** Why it matters, in the video's own terms. */
	rationale: string;
	verdict: Verdict;
	/** Where in the repo this lands — required for every verdict. Unsourced claims are dropped. */
	evidence: string;
	/** For gaps only: a mission goal a worker could act on directly. */
	goal?: string;
	video: { id: string; title: string; channel: string; url: string };
}

export interface Briefing {
	at: string;
	repo: string;
	queries: string[];
	watched: VideoMeta[];
	skipped: { video: VideoMeta; reason: string }[];
	items: BriefingItem[];
	costUsd: number;
}

// ---------------------------------------------------------------------------
// Repo digest — what the harness already does, compactly.
// ---------------------------------------------------------------------------

/**
 * A capability map built from each module's header comment.
 *
 * This codebase explains itself at the top of every file, which makes those
 * comments the highest-signal-per-token description of what it already does —
 * far better grounding than a file tree, and far cheaper than the source.
 */
/** A doc comment's body: `/** ... *\/` with no nested terminator, so it cannot run past its own close. */
const DOC_BLOCK = /\/\*\*((?:\*(?!\/)|[^*])*)\*\//g;

/**
 * One-line description of a module: its header comment, or failing that the doc
 * comment on its first export. Trimmed to two sentences — this is a map, and a
 * map that reproduces the territory is not a map.
 */
function describe(src: string): string {
	const clean = (body: string): string =>
		body
			.split("\n")
			.map((l) => l.replace(/^\s*\*\s?/, "").trim())
			.filter(Boolean)
			.join(" ")
			.split(/(?<=\.)\s+/)
			.slice(0, 2)
			.join(" ")
			.slice(0, 300);

	// A header comment is one that starts the file.
	const header = src.match(/^\s*\/\*\*((?:\*(?!\/)|[^*])*)\*\//);
	if (header?.[1]) return clean(header[1]);

	for (const m of src.matchAll(DOC_BLOCK)) {
		const after = src.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
		if (/^\s*export\s/.test(after) && m[1]) return clean(m[1]);
	}
	return "";
}

export function repoDigest(repo: string): string {
	const srcDir = join(repo, "src");
	if (!existsSync(srcDir)) return topLevelRecon(repo);

	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(p, `${prefix}${entry.name}/`);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const src = readFileSync(p, "utf-8");
			const doc = describe(src);
			const exports = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((x) => x[1]).slice(0, 6);
			out.push(`${prefix}${entry.name}${doc ? ` — ${doc}` : ""}${exports.length ? `\n    exports: ${exports.join(", ")}` : ""}`);
		}
	};
	walk(srcDir, "src/");
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Stage 1 — claims out of a transcript.
// ---------------------------------------------------------------------------

const EXTRACT_PROMPT = `You are reading a transcript of a talk or video about building AI coding-agent systems, on behalf of an
engineer who maintains his own long-running coding-agent harness. Your job is to extract only what could CHANGE HOW A
HARNESS IS BUILT.

Extract a claim only if it is a specific, implementable practice or mechanism. Good: "workers should return a structured
handoff listing what they did NOT do". Bad: "agents are the future", "context engineering matters", "you should use
evals". If the video is an explainer, a product demo, or a tutorial with no design content, return an empty array —
that is the correct and expected answer most of the time.

Be harsh. Ten vague claims are worse than zero. Most videos yield nothing.

Output ONLY a JSON array, no prose:
[ { "claim": "one sentence, specific and implementable", "rationale": "≤20 words on why it matters, in the video's terms" } ]
Return at most 5, best first.`;

// ---------------------------------------------------------------------------
// Stage 2 — grounding, which is where the value actually is.
// ---------------------------------------------------------------------------

const GROUND_PROMPT = `You are the ORCHESTRATOR of a coding-agent harness, assessing ideas taken from external talks against the
harness's OWN codebase. You are given a capability map of the repo (one line per module, from its header comment) and a
list of claims extracted from videos.

For each claim, decide what it means FOR THIS REPO:
- "already-have": the repo does this. Name the module that does it. This is the most common answer and a good one —
  say so plainly rather than inventing a refinement.
- "gap": the repo genuinely does not do this AND it would be worth doing. Name the module it would live in or beside.
- "not-applicable": real practice, wrong shape for this repo (different architecture, different scale, needs a service
  we do not run).

Rules:
- EVERY verdict needs "evidence" naming a specific module from the capability map. A claim you cannot tie to a module
  is "not-applicable" with evidence explaining why it does not land anywhere.
- Be conservative with "gap". A gap means you are asking a human to spend money on a mission. If the repo half-does it,
  that is "already-have" with a note, not a gap.
- For a "gap", write "goal" as ONE imperative line a fresh coding agent could implement and validate in isolation.
  No goal for the other verdicts.

Output ONLY a JSON array, no prose, one entry per claim IN THE ORDER GIVEN:
[ { "verdict": "gap" | "already-have" | "not-applicable", "evidence": "module + one clause", "goal": "imperative line, gaps only" } ]`;

export interface BriefingOptions {
	repo: string;
	queries: string[];
	/** Transcripts to actually read. Each costs roughly 4-6k tokens on the cheap seat. */
	maxVideos?: number;
	/** Videos longer than this are skipped — multi-hour streams are almost never worth it. */
	maxDurationSec?: number;
	onProgress?: (msg: string) => void;
}

const DEFAULT_QUERIES = [
	"coding agent harness architecture",
	"multi agent orchestration engineering",
	"AI agent validation eval harness",
];

export async function generateBriefing(options: BriefingOptions): Promise<Briefing> {
	const { repo, onProgress } = options;
	const queries = options.queries.length ? options.queries : DEFAULT_QUERIES;
	const maxVideos = Math.max(1, Math.min(options.maxVideos ?? 4, 12));
	const maxDuration = options.maxDurationSec ?? 90 * 60;
	const routing = autoRouting();
	let costUsd = 0;

	// Both orderings, deduped. They overlap far less than you would expect, and
	// "recent" is where anything genuinely new shows up.
	const seen = new Set<string>();
	const candidates: VideoMeta[] = [];
	for (const q of queries) {
		for (const sort of ["date", "relevance"] as const) {
			for (const v of searchVideos(q, { limit: 8, sort })) {
				if (seen.has(v.id)) continue;
				seen.add(v.id);
				candidates.push(v);
			}
		}
	}
	onProgress?.(`found ${candidates.length} candidate video(s) across ${queries.length} quer(ies)`);

	const skipped: { video: VideoMeta; reason: string }[] = [];
	const transcripts: Transcript[] = [];
	for (const v of candidates) {
		if (transcripts.length >= maxVideos) break;
		if (v.duration && v.duration > maxDuration) {
			skipped.push({ video: v, reason: `${Math.round(v.duration / 60)}min — over the ${Math.round(maxDuration / 60)}min cap` });
			continue;
		}
		const t = fetchTranscript(v);
		if (!t) {
			skipped.push({ video: v, reason: "no captions available" });
			continue;
		}
		transcripts.push(t);
		onProgress?.(`transcript: ${v.title.slice(0, 60)} (~${t.approxTokens} tok)`);
	}

	// Stage 1: claims, one call per transcript on the cheap seat.
	const claims: { claim: string; rationale: string; video: VideoMeta }[] = [];
	for (const t of transcripts) {
		const { text, costUsd: c } = await complete(
			routing.worker,
			EXTRACT_PROMPT,
			`VIDEO: ${t.video.title}\nCHANNEL: ${t.video.channel}\n\nTRANSCRIPT:\n${t.text.slice(0, 60_000)}`,
		);
		costUsd += c;
		const parsed = parseJson<Array<{ claim?: string; rationale?: string }>>(text);
		const rows = (Array.isArray(parsed) ? parsed : []).filter((r) => r?.claim);
		for (const r of rows.slice(0, 5)) {
			claims.push({ claim: String(r.claim).trim(), rationale: String(r.rationale ?? "").trim(), video: t.video });
		}
		onProgress?.(`${t.video.title.slice(0, 46)}: ${rows.length} claim(s)`);
	}

	// Stage 2: ground them all in one pass, so the model sees them side by side
	// and cannot call three overlapping claims three separate gaps.
	const items: BriefingItem[] = [];
	if (claims.length) {
		const numbered = claims.map((c, i) => `${i + 1}. ${c.claim}\n   (why: ${c.rationale || "not stated"})`).join("\n");
		const { text, costUsd: c } = await complete(
			routing.orchestrator,
			GROUND_PROMPT,
			`REPO: ${repo}\n\nCAPABILITY MAP:\n${repoDigest(repo)}\n\nCLAIMS TO ASSESS (${claims.length}):\n${numbered}\n\nAssess every claim now, in order.`,
		);
		costUsd += c;
		const parsed = parseJson<Array<{ verdict?: string; evidence?: string; goal?: string }>>(text);
		const rows = Array.isArray(parsed) ? parsed : [];
		claims.forEach((cl, i) => {
			const r = rows[i];
			// No ruling, or a ruling with no evidence, means it was not grounded. Drop it
			// rather than defaulting to a verdict nobody actually reached.
			const evidence = typeof r?.evidence === "string" ? r.evidence.trim() : "";
			if (!r || !evidence) return;
			const verdict: Verdict = r.verdict === "gap" ? "gap" : r.verdict === "not-applicable" ? "not-applicable" : "already-have";
			items.push({
				claim: cl.claim,
				rationale: cl.rationale,
				verdict,
				evidence,
				goal: verdict === "gap" && typeof r.goal === "string" && r.goal.trim() ? r.goal.trim() : undefined,
				video: { id: cl.video.id, title: cl.video.title, channel: cl.video.channel, url: cl.video.url },
			});
		});
		// A "gap" with no actionable goal is an opinion, not a finding.
		for (const it of items) if (it.verdict === "gap" && !it.goal) it.verdict = "not-applicable";
	}

	const briefing: Briefing = {
		at: new Date().toISOString(),
		repo,
		queries,
		watched: transcripts.map((t) => t.video),
		skipped,
		items,
		costUsd,
	};
	saveBriefing(briefing);
	return briefing;
}

// ---------------------------------------------------------------------------
// Persistence + rendering
// ---------------------------------------------------------------------------

const BRIEF_DIR = join(homedir(), ".missions", "briefings");

export function saveBriefing(b: Briefing): string {
	mkdirSync(BRIEF_DIR, { recursive: true });
	const path = join(BRIEF_DIR, `${b.at.replace(/[:.]/g, "-")}-${basename(b.repo)}.json`);
	writeFileSync(path, JSON.stringify(b, null, 2));
	return path;
}

export function latestBriefing(repo?: string): Briefing | undefined {
	if (!existsSync(BRIEF_DIR)) return undefined;
	const files = readdirSync(BRIEF_DIR)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.reverse();
	for (const f of files) {
		try {
			const b = JSON.parse(readFileSync(join(BRIEF_DIR, f), "utf-8")) as Briefing;
			if (!repo || b.repo === repo) return b;
		} catch {
			/* skip a corrupt file */
		}
	}
	return undefined;
}

/** Gaps only, as mission goals the board can pick up. */
export function briefingGoals(b: Briefing): { goal: string; rationale: string; source: string }[] {
	return b.items
		.filter((i) => i.verdict === "gap" && i.goal)
		.map((i) => ({ goal: i.goal as string, rationale: i.evidence, source: `video:${i.video.id}` }));
}
