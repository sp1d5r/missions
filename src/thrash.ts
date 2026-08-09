/**
 * Corrections that keep landing on the same file are a component that needs a redesign, not
 * another patch — see harness-issues.md #2. m5-m16 of a real mission all edited the same file,
 * each round fixing one thing and re-breaking another, with nothing in the harness noticing.
 */

import type { CommitRecord, Feature } from "./types.js";

export interface FileThrash {
	file: string;
	correctionIds: string[];
}

/** Below this, ordinary iteration. At/above it, warn the orchestrator in the boundary prompt. */
export const THRASH_WARN_THRESHOLD = 3;
/**
 * At/above it, tell the orchestrator this is no longer optional: consolidate into one redesign
 * correction or stall itself. Not a harness-enforced stop — maxMilestones/budget already are the
 * enforced ceiling (see MissionConfig.budgetUsd's own reasoning), and a second, per-file hard cap
 * would just be that same mistake again, one level down.
 */
export const THRASH_CRITICAL_THRESHOLD = 6;

/**
 * Files touched by 2+ distinct correction commits, most-touched first.
 *
 * `filesTouched` is injected (rather than calling git directly) so this stays a pure function
 * over `commits`/`features` and is unit-testable without a real repo.
 */
export function detectFileThrash(commits: CommitRecord[], features: Feature[], filesTouched: (sha: string) => string[]): FileThrash[] {
	const correctionIds = new Set(features.filter((f) => f.origin === "correction").map((f) => f.id));
	const byFile = new Map<string, Set<string>>();
	for (const c of commits) {
		if (!correctionIds.has(c.featureId)) continue;
		for (const file of filesTouched(c.sha)) {
			if (!byFile.has(file)) byFile.set(file, new Set());
			byFile.get(file)?.add(c.featureId);
		}
	}
	return [...byFile.entries()]
		.map(([file, ids]) => ({ file, correctionIds: [...ids] }))
		.filter((t) => t.correctionIds.length >= 2)
		.sort((a, b) => b.correctionIds.length - a.correctionIds.length);
}
