/**
 * What a finished mission leaves behind, and which of it is safe to delete.
 *
 * Three artifacts with three different lifetimes, and conflating them is how a
 * repo ends up holding gigabytes of nothing:
 *
 *   worktree  — a CACHE. Rebuildable from its branch plus a bootstrap. Costs the
 *               most by far: dependency trees a worker installed rather than the
 *               tracked files, which are comparatively tiny. Reclaim eagerly.
 *   branch    — the WORK. The only durable artifact of what a mission actually
 *               did. Deleted only once its commits are contained in the default
 *               branch, and always through `git branch -d` so git gets the last
 *               word. Never force-deleted.
 *   run dir   — the RECORD (state.json + report.html). Load-bearing: changelog.ts
 *               builds CHANGELOG.md by scanning them. Kilobytes. Kept.
 *
 * The gate on every reclaim is `worktreeIsClean`, which counts untracked files.
 * A worker that wrote a file and never committed it produced work no branch is
 * holding; removing that tree destroys it outright.
 *
 * A mission that is done but NOT cleared is work you have not looked at yet.
 * The sweep leaves those alone — reclaiming them would delete the tree out from
 * under the review it is waiting for.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { branchesWithPrefix, defaultBranch, deleteBranch, isMerged, listWorktrees, pruneWorktrees, removeWorktree, worktreeIsClean } from "./git.js";
import { type ActiveRecord, readActive, removeActive } from "./registry.js";
import { listWorkspaces } from "./workspaces.js";

/** Where a mission's worktree lives, relative to the repo it targets. */
export const WORKTREE_DIR = join(".missions", "worktrees");
export const BRANCH_PREFIX = "missions/";

export type ReclaimReason = "merged" | "dismissed" | "retried" | "no-commits" | "orphan" | "cleared";

export interface Reclaimed {
	repo: string;
	worktreePath?: string;
	branch?: string;
	reason: ReclaimReason;
	bytes: number;
	/** Set when the artifact was left alone, and why. */
	skipped?: string;
}

/** Disk used by a directory. Best-effort — a failure here must never block a reclaim. */
export function dirBytes(path: string): number {
	try {
		const out = execFileSync("du", ["-sk", path], { encoding: "utf-8", timeout: 30_000 }).toString();
		return (Number.parseInt(out.trim().split(/\s+/)[0] ?? "0", 10) || 0) * 1024;
	} catch {
		return 0;
	}
}

export function humanBytes(n: number): string {
	if (n <= 0) return "0B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	const v = n / 1024 ** i;
	return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/**
 * Only ever operate on paths the harness itself created.
 *
 * Compared through realpath: git reports a worktree by its canonical path, so on
 * macOS a repo under /tmp or a tmpdir comes back as /private/tmp/… while the
 * configured path says /tmp/…. A plain string compare silently classifies every
 * one of those as "not ours" and the sweep quietly does nothing.
 */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isMissionWorktree(repo: string, path: string): boolean {
	const root = real(resolve(repo, WORKTREE_DIR)) + sep;
	return real(path).startsWith(root);
}

/**
 * Remove one mission worktree, unless it is holding uncommitted work.
 *
 * `dryRun` reports what would happen and touches nothing.
 */
export function reclaimWorktree(repo: string, worktreePath: string, reason: ReclaimReason, dryRun = false): Reclaimed {
	const out: Reclaimed = { repo, worktreePath, reason, bytes: 0 };
	if (!isMissionWorktree(repo, worktreePath)) {
		out.skipped = "not a mission worktree";
		return out;
	}
	if (!existsSync(worktreePath)) {
		// Directory already gone; let git drop its bookkeeping.
		if (!dryRun) pruneWorktrees(repo);
		out.skipped = "already gone";
		return out;
	}
	if (!worktreeIsClean(worktreePath)) {
		out.skipped = "uncommitted changes — left in place";
		return out;
	}
	out.bytes = dirBytes(worktreePath);
	if (!dryRun) {
		removeWorktree(repo, worktreePath);
		pruneWorktrees(repo);
	}
	return out;
}

/**
 * Delete a mission branch once its commits are safely in the default branch.
 *
 * Returns undefined when there is nothing to report — an unmerged branch is the
 * expected case for dismissed work, not a problem worth printing.
 */
export function reclaimBranch(repo: string, branch: string, dryRun = false): Reclaimed | undefined {
	if (!branch.startsWith(BRANCH_PREFIX)) return undefined;
	const base = defaultBranch(repo);
	if (!isMerged(repo, branch, base)) return undefined;
	if (!dryRun) {
		const res = deleteBranch(repo, branch);
		if (!res.ok) return { repo, branch, reason: "merged", bytes: 0, skipped: res.out.split("\n")[0] };
	}
	return { repo, branch, reason: "merged", bytes: 0 };
}

export interface SweepOptions {
	/** Repos to sweep. Defaults to every registered workspace. */
	repos?: string[];
	dryRun?: boolean;
	/** Also reclaim worktrees for missions that finished but have not been actioned. Off by design. */
	includeUnreviewed?: boolean;
}

export interface SweepResult {
	reclaimed: Reclaimed[];
	/** Live records dropped because their repo no longer exists on disk. */
	droppedRecords: number;
	bytes: number;
}

/** Mission id encoded in a worktree path, i.e. the directory name. */
function idFromPath(path: string): string {
	return basename(path);
}

/**
 * Reconcile what is on disk against what the registry believes, and reclaim the
 * difference. This is the backstop for everything the interactive paths miss:
 * crashes, kill -9, a terminal closed mid-run, missions from before any of this
 * existed.
 */
export function sweep(options: SweepOptions = {}): SweepResult {
	const dryRun = options.dryRun ?? false;
	const repos = options.repos ?? listWorkspaces().map((w) => w.path);
	const records = readActive();
	const byId = new Map<string, ActiveRecord>(records.map((r) => [r.id, r]));
	const result: SweepResult = { reclaimed: [], droppedRecords: 0, bytes: 0 };

	for (const repo of repos) {
		if (!existsSync(join(repo, ".git"))) continue;

		for (const wt of listWorktrees(repo)) {
			if (!isMissionWorktree(repo, wt.path)) continue;
			const rec = byId.get(idFromPath(wt.path));

			// A running mission owns its tree. An unreviewed one is the review itself.
			if (rec && !rec.done) continue;
			if (rec?.done && !rec.cleared && !options.includeUnreviewed) continue;

			const reason: ReclaimReason = !rec ? "orphan" : "cleared";
			const got = reclaimWorktree(repo, wt.path, reason, dryRun);
			result.reclaimed.push(got);
			result.bytes += got.bytes;
		}

		// Bookkeeping for directories deleted by hand.
		if (!dryRun) pruneWorktrees(repo);

		// A branch still checked out somewhere cannot be deleted, and asking git to
		// try just produces noise. Re-read the list: reclaims above changed it.
		const held = new Set(listWorktrees(repo).map((w) => w.branch).filter(Boolean));
		for (const branch of branchesWithPrefix(repo, BRANCH_PREFIX)) {
			if (held.has(branch)) continue;
			const got = reclaimBranch(repo, branch, dryRun);
			if (got) result.reclaimed.push(got);
		}
	}

	// Records whose repo is gone describe missions that can never be acted on.
	for (const rec of records) {
		if (existsSync(rec.repo)) continue;
		if (!dryRun) removeActive(rec.id);
		result.droppedRecords++;
	}

	return result;
}

/** One-line summary per action, for the CLI. */
export function renderSweep(result: SweepResult, dryRun: boolean): string[] {
	const lines: string[] = [];
	for (const r of result.reclaimed) {
		const what = r.worktreePath ? `worktree ${basename(r.worktreePath)}` : `branch ${r.branch}`;
		const where = basename(r.repo);
		if (r.skipped) lines.push(`  · ${where}  ${what} — ${r.skipped}`);
		else lines.push(`  ${dryRun ? "would remove" : "removed"} ${where}  ${what}${r.bytes ? ` (${humanBytes(r.bytes)})` : ""} [${r.reason}]`);
	}
	if (result.droppedRecords) lines.push(`  ${dryRun ? "would drop" : "dropped"} ${result.droppedRecords} record(s) for repos that no longer exist`);
	if (!lines.length) lines.push("  nothing to reclaim");
	else lines.push(`  ${dryRun ? "would reclaim" : "reclaimed"} ${humanBytes(result.bytes)}`);
	return lines;
}

/** Age of a path in days, for reporting. */
export function ageDays(path: string): number {
	try {
		return (Date.now() - statSync(path).mtimeMs) / 86_400_000;
	} catch {
		return 0;
	}
}
