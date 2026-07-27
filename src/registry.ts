import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { missionsPath } from "./paths.js";

const ACTIVE_DIR = (): string => missionsPath("active");

/** A cross-repo, live snapshot of one mission (written on every step). */
export interface ActiveRecord {
	id: string;
	repo: string;
	repoName: string;
	goal: string;
	status: string;
	startedAt: string;
	updatedAt: string;
	lastActivity: string;
	reportPath?: string;
	worktreePath?: string;
	costUsd: number;
	done: boolean;
	/** Milestones completed so far, and the ceiling — "2/3" on the board. */
	milestone?: number;
	maxMilestones?: number;
	/** Why the mission stopped (passed / stalled / budget-exhausted / max-milestones). */
	verdict?: string;
	/** "clean" = contract satisfied and nothing outstanding; "needs-review" = wants a human. */
	outcome?: string;
	/** Set once the human has actioned it (merged/retried/dismissed) — drops it from the "needs you" queue. */
	cleared?: boolean;
}

export function writeActive(rec: ActiveRecord): void {
	mkdirSync(ACTIVE_DIR(), { recursive: true });
	writeFileSync(join(ACTIVE_DIR(), `${rec.id}.json`), JSON.stringify(rec, null, 2));
}

/** Patch a record in place (e.g. mark it cleared/merged from the board). No-op if it's gone. */
export function updateActive(id: string, patch: Partial<ActiveRecord>): void {
	const p = join(ACTIVE_DIR(), `${id}.json`);
	if (!existsSync(p)) return;
	try {
		const rec = JSON.parse(readFileSync(p, "utf-8")) as ActiveRecord;
		writeFileSync(p, JSON.stringify({ ...rec, ...patch }, null, 2));
	} catch {
		/* skip */
	}
}

export function readActive(): ActiveRecord[] {
	const dir = ACTIVE_DIR();
	if (!existsSync(dir)) return [];
	const out: ActiveRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as ActiveRecord);
		} catch {
			/* skip */
		}
	}
	return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function repoName(cwd: string): string {
	return basename(cwd) || cwd;
}
