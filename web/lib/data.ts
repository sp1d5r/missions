/**
 * Reads. Every one of them delegates to `../dist` — the modules the TUI and the
 * report already use.
 *
 * Nothing here reimplements a fact about a mission. That rule exists because
 * this repo has already been bitten by a validator that reimplemented the logic
 * it claimed to be checking and passed either way; a console that reimplements
 * "what does succeeded mean" is the same mistake wearing a nicer font.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isLive, isStalled, readActive } from "@missions/registry.js";
import type { ActiveRecord } from "@missions/registry.js";
import { codename } from "@missions/theme.js";
import type { MissionState } from "@missions/types.js";
import { listWorkspaces } from "@missions/workspaces.js";
import type { Workspace } from "@missions/workspaces.js";

export type { ActiveRecord, MissionState, Workspace };

export interface BoardRow extends ActiveRecord {
	/** Stable, pronounceable handle — the thing you can say to the chief. */
	name: string;
	/** Finished, not clean, and nobody has actioned it yet. */
	needsYou: boolean;
	/** Genuinely in flight — see isLive. Not the same as `!done`. */
	live: boolean;
	/** Unfinished but silent for an hour: its process is gone and it is holding a worktree. */
	stalled: boolean;
}

function decorate(rec: ActiveRecord): BoardRow {
	return {
		...rec,
		name: codename(rec.id),
		needsYou: Boolean(rec.done && !rec.cleared && rec.outcome !== "clean"),
		live: isLive(rec),
		stalled: isStalled(rec),
	};
}

export function board(): BoardRow[] {
	return readActive().map(decorate);
}

export function workspaces(): Workspace[] {
	return listWorkspaces();
}

export function record(id: string): BoardRow | null {
	return board().find((r) => r.id === id) ?? null;
}

/**
 * The full mission record.
 *
 * `outDir` is authoritative when present; older records predate it, so fall
 * back to the conventional path rather than showing an empty mission for work
 * that plainly exists on the board.
 */
export function mission(id: string): MissionState | null {
	const rec = record(id);
	if (!rec) return null;
	const dir = rec.outDir ?? join(rec.repo, ".missions", "runs", id);
	const file = join(dir, "state.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as MissionState;
	} catch {
		return null;
	}
}

/** The report the mission wrote, inlined so the phone never opens a file:// URL. */
export function reportHtml(id: string): string | null {
	const rec = record(id);
	if (!rec?.reportPath || !existsSync(rec.reportPath)) return null;
	try {
		return readFileSync(rec.reportPath, "utf-8");
	} catch {
		return null;
	}
}

export interface Summary {
	running: number;
	needsYou: number;
	/** Unfinished, but its process is gone. Counted separately: these were previously invisible. */
	stalled: number;
	done: number;
	spendUsd: number;
	repos: number;
}

export function summary(rows: BoardRow[]): Summary {
	return {
		// `!done` counted zombies as in flight — a mission killed mid-run never writes a terminal
		// status, so the board claimed three were running when all three had been dead for over a
		// day. See isLive in registry.ts.
		running: rows.filter((r) => r.live).length,
		stalled: rows.filter((r) => r.stalled).length,
		needsYou: rows.filter((r) => r.needsYou).length,
		done: rows.filter((r) => r.done).length,
		spendUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0),
		repos: new Set(rows.map((r) => r.repo)).size,
	};
}
