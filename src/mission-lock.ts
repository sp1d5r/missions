/**
 * Cross-process advisory lock, one per mission outDir.
 *
 * resumeMission() reloads a fresh StateStore from disk on every call. Two concurrent calls
 * against the same outDir (a manual resume racing the mission's own auto-dispatched overseer,
 * or a stray double-click) each load their own snapshot, each do a milestone's worth of work
 * against it, and whichever finishes `store.save()` last wins — silently discarding the other's
 * milestone record. The mission never appears to fail; it just stops advancing, forever
 * re-dispatching the same already-satisfied feature because the milestone that would have
 * retired it kept losing the race. This lock turns that into a loud, immediate refusal instead.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function lockPath(outDir: string): string {
	return join(outDir, ".resume.lock");
}

/** Is the process that holds this PID still alive? kill(pid, 0) is the standard liveness probe. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class MissionLockedError extends Error {
	constructor(outDir: string, holderPid: number) {
		super(`Mission at ${outDir} is already being resumed (pid ${holderPid}). Refusing a concurrent resume — wait for it to finish.`);
		this.name = "MissionLockedError";
	}
}

/**
 * Acquire the lock for this outDir or throw MissionLockedError. Stale locks (holder process no
 * longer alive — a crash, a kill -9, a machine restart) are reclaimed automatically rather than
 * requiring manual cleanup.
 */
export function acquireMissionLock(outDir: string): () => void {
	mkdirSync(outDir, { recursive: true });
	const p = lockPath(outDir);
	if (existsSync(p)) {
		const holderPid = Number.parseInt(readFileSync(p, "utf-8").trim(), 10);
		if (Number.isFinite(holderPid) && pidAlive(holderPid)) {
			throw new MissionLockedError(outDir, holderPid);
		}
		// Stale — the holder is gone. Reclaim it.
	}
	writeFileSync(p, String(process.pid));
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			// Only remove it if we still own it — a crashed holder's stale lock could otherwise
			// have already been reclaimed by someone else by the time this runs.
			if (existsSync(p) && readFileSync(p, "utf-8").trim() === String(process.pid)) {
				rmSync(p);
			}
		} catch {
			/* best-effort cleanup — a leftover lock file is reclaimed by the next attempt anyway */
		}
	};
}
