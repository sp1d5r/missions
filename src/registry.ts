import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
	/**
	 * First port of the block this mission owns (ports.ts). Published here, not just in the
	 * mission's own state, because the next mission to start has to see it: a bind probe cannot
	 * detect a live mission that happens not to be listening at that moment.
	 */
	portBase?: number;
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
	/**
	 * What this mission wants from a human, in a sentence.
	 *
	 * A board row that says "NEEDS YOU" and nothing else makes the reader open the mission to
	 * find out whether there is a decision to make or the harness merely gave up. The mission
	 * already writes this sentence to `state.stallReason`; carrying it here is what lets the
	 * board, the web console and the chief answer "what does it need?" without opening anything.
	 */
	needs?: string;
	/** Full path to the run output directory (state.json lives here). */
	outDir?: string;
}

/**
 * How long a record may go untouched before we stop calling it alive.
 *
 * A running mission republishes on every log line, so silence is strong evidence. The window is
 * generous because the one legitimately quiet stretch is a setup step — a cold `pdm install` can
 * run twenty minutes and emits progress only when it finishes — and calling a live mission dead
 * is the worse error of the two.
 */
export const STALE_AFTER_MS = 60 * 60_000;

/**
 * Is this mission actually running?
 *
 * `!done` is NOT the same question, and treating it as such was a real bug: a mission whose
 * process is killed — Ctrl-C, a crashed daemon, a closed laptop — never gets to write a terminal
 * status, so its record sits at `working` forever. Measured on a live org, three of three
 * "running" missions had been dead for 27 to 40 hours, and both the chief's greeting and the
 * web board reported them as in flight.
 *
 * That failure is worse than it looks. Zombies are not `done`, so they are also excluded from the
 * "needs you" queue — they were counted as healthy and were unreachable at the same time. Call
 * these stalled and they become something you can act on.
 */
export function isLive(rec: ActiveRecord, now = Date.now()): boolean {
	if (rec.done) return false;
	const touched = Date.parse(rec.updatedAt);
	if (Number.isNaN(touched)) return false;
	return now - touched < STALE_AFTER_MS;
}

/** Unfinished, but silent long enough that its process is presumed gone. */
export function isStalled(rec: ActiveRecord, now = Date.now()): boolean {
	return !rec.done && !isLive(rec, now);
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

/** Drop a live record entirely. The run dir keeps the durable history. */
export function removeActive(id: string): void {
	try {
		const p = join(ACTIVE_DIR(), `${id}.json`);
		if (existsSync(p)) unlinkSync(p);
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
