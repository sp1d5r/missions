import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { missionsPath, missionsRoot } from "./paths.js";
import { complete, parseJson } from "./llm.js";
import { autoRouting } from "./models.js";
import { topLevelRecon } from "./target/generic.js";

export interface Suggestion {
	repo: string;
	repoName: string;
	goal: string;
	rationale?: string;
	source: string;
}

const CACHE = (): string => missionsPath("suggestions.json");
type Cache = Record<string, { at: string; items: Suggestion[] }>;

function readCache(): Cache {
	if (!existsSync(CACHE())) return {};
	try {
		return JSON.parse(readFileSync(CACHE(), "utf-8")) as Cache;
	} catch {
		return {};
	}
}

/** Every cached suggestion across all repos (sync — the board loads this instantly on open). */
export function loadSuggestions(): Suggestion[] {
	return Object.values(readCache()).flatMap((e) => e.items);
}

/**
 * Add suggestions without clobbering what is already queued for that repo.
 *
 * `generateSuggestions` replaces a repo's list wholesale, which is right when
 * you press `g` and want a fresh read. A routine firing overnight must not
 * silently delete the ideas you were about to action, so it merges instead —
 * matching on goal text, since the same finding re-proposed is the same row.
 */
export function addSuggestions(repo: string, items: Suggestion[]): number {
	if (!items.length) return 0;
	const cache = readCache();
	const existing = cache[repo]?.items ?? [];
	const have = new Set(existing.map((s) => s.goal.trim().toLowerCase()));
	const fresh = items.filter((s) => s.goal?.trim() && !have.has(s.goal.trim().toLowerCase()));
	if (!fresh.length) return 0;
	cache[repo] = { at: new Date().toISOString(), items: [...existing, ...fresh] };
	mkdirSync(missionsRoot(), { recursive: true });
	writeFileSync(CACHE(), JSON.stringify(cache, null, 2));
	return fresh.length;
}

/** Drop one suggestion (it became a mission, or you dismissed it). */
export function removeSuggestion(repo: string, goal: string): void {
	const cache = readCache();
	const entry = cache[repo];
	if (!entry) return;
	entry.items = entry.items.filter((s) => s.goal.trim().toLowerCase() !== goal.trim().toLowerCase());
	writeFileSync(CACHE(), JSON.stringify(cache, null, 2));
}

function gitLog(repo: string): string {
	try {
		return execFileSync("git", ["log", "-8", "--pretty=%s"], { cwd: repo, encoding: "utf-8", maxBuffer: 1 << 20 }).toString().trim();
	} catch {
		return "";
	}
}

function readme(repo: string): string {
	for (const name of ["README.md", "readme.md", "README", "docs/README.md"]) {
		const p = join(repo, name);
		if (existsSync(p)) {
			try {
				return readFileSync(p, "utf-8").slice(0, 1200);
			} catch {
				/* skip */
			}
		}
	}
	return "";
}

const SYSTEM = `You are the CHIEF OF STAFF for a solo founder-engineer, proposing the next missions for an org of coding agents on ONE repository.
Suggest concrete, HIGH-LEVERAGE pieces of work a fresh coding agent could implement AND validate in isolation, then commit.
Rules:
- Ground every suggestion in what the repo actually is (its structure, README, recent commits). No generic advice.
- Each goal is ONE crisp imperative line a worker can act on directly (e.g. "Add ret/timeout to the fetch client and a test", not "improve reliability").
- Favor: real gaps, latent bugs/risk, missing tests on critical paths, obvious next features implied by the trajectory, dev-experience wins.
- Skip anything vague, cosmetic, or that needs product decisions only the founder can make.
Output ONLY a JSON array, no prose:
[ { "goal": "one imperative line", "why": "≤12 words on the leverage" } ]
Return 4-6 items, ordered by leverage (best first).`;

/** Ask the orchestrator model for grounded, high-leverage missions for one repo. Caches the result. */
export async function generateSuggestions(repo: string): Promise<Suggestion[]> {
	const user = `TARGET REPO: ${repo}

RECON (top-level structure + manifest):
${topLevelRecon(repo)}

RECENT COMMITS:
${gitLog(repo) || "(none)"}

README (excerpt):
${readme(repo) || "(none)"}

Propose the next missions now.`;

	const { text } = await complete(autoRouting().orchestrator, SYSTEM, user);
	let parsed = parseJson<Array<{ goal?: string; why?: string }>>(text);
	if (!Array.isArray(parsed)) {
		// Model wrapped the array in prose — grab the outermost [...] and try again.
		const m = text.match(/\[[\s\S]*\]/);
		parsed = m ? parseJson<Array<{ goal?: string; why?: string }>>(m[0]) : null;
	}
	const items: Suggestion[] = (Array.isArray(parsed) ? parsed : [])
		.filter((s) => s?.goal)
		.slice(0, 6)
		.map((s) => ({ repo, repoName: basename(repo), goal: String(s.goal).trim(), rationale: s.why ? String(s.why).trim() : undefined, source: "chief" }));

	const cache = readCache();
	cache[repo] = { at: new Date().toISOString(), items };
	mkdirSync(missionsRoot(), { recursive: true });
	writeFileSync(CACHE(), JSON.stringify(cache, null, 2));
	return items;
}
