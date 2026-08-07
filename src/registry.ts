import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { missionsPath } from "./paths.js";
import { encode, orgSocketPath } from "./ipc.js";
import { createConnection } from "node:net";

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
 * A running mission republishes on every log line, so silence is strong evidence. The window
 * still covers the one legitimately quiet stretch — a setup step like a cold `pdm install` can
 * run twenty minutes and emits progress only when it finishes — but a full hour meant a process
 * that died could sit on the board reading "live" for up to 60 minutes before anyone noticed.
 * That defeats the point of a heartbeat: it should read as dead not long after it actually is.
 * 30 minutes is the floor a cold install still needs (see the registry test for that contract).
 */
export const STALE_AFTER_MS = 30 * 60_000;

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

/**
 * Emit a lifecycle frame to the daemon socket, if it is up.
 * Silently no-ops when the socket is absent (CLI standalone path).
 */
function emitLifecycle(frame: Parameters<typeof encode>[0] & { t: "mission" }): void {
	try {
		if (!existsSync(orgSocketPath())) return;
		const sock = createConnection(orgSocketPath());
		sock.on("connect", () => {
			try {
				sock.write(encode(frame), () => sock.destroy());
			} catch {
				sock.destroy();
			}
		});
		sock.on("error", () => { /* no-op */ });
	} catch {
		/* never crash the caller */
	}
}

export function writeActive(rec: ActiveRecord): void {
	mkdirSync(ACTIVE_DIR(), { recursive: true });
	const p = join(ACTIVE_DIR(), `${rec.id}.json`);
	// Read the prior on-disk record before overwriting — this makes the
	// dedup guard restart-safe: a fresh process re-writing an unchanged
	// record sees the real previous state rather than treating every first
	// write as a brand-new mission.
	let prevStatus: string | undefined;
	let prevDone: boolean | undefined;
	try {
		const prior = JSON.parse(readFileSync(p, "utf-8")) as ActiveRecord;
		prevStatus = prior.status;
		prevDone = prior.done;
	} catch {
		/* file absent on first write — prevStatus stays undefined */
	}
	writeFileSync(p, JSON.stringify(rec, null, 2));
	// Emit a lifecycle frame only when the status or done flag actually changes.
	const nextStatus = rec.status;
	const nextDone = rec.done;
	if (prevStatus === nextStatus) {
		// Status unchanged — but if done just flipped false→true emit 'finished'.
		if (prevDone === false && nextDone === true) {
			emitLifecycle({ t: "mission", event: "finished", id: rec.id, at: Date.now(), status: nextStatus });
		}
		return;
	}
	const event = prevStatus === undefined ? "started" : nextDone ? "finished" : "status";
	emitLifecycle({ t: "mission", event, id: rec.id, at: Date.now(), status: nextStatus });
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
	emitLifecycle({ t: "mission", event: "removed", id, at: Date.now() });
}

export function readActive(): ActiveRecord[] {
	const dir = ACTIVE_DIR();
	if (!existsSync(dir)) return [];
	const out: ActiveRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(dir, name), "utf-8")) as ActiveRecord;
			// A record missing `repo` cannot be a real mission — every writer sets it before the
			// first save. Skip it here, at the source, rather than trusting every downstream
			// consumer (board, web console, workspaces) to each re-derive the same guard.
			if (typeof rec.repo !== "string" || !rec.repo) continue;
			out.push(rec);
		} catch {
			/* skip */
		}
	}
	return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function repoName(cwd: string): string {
	return basename(cwd) || cwd;
}
