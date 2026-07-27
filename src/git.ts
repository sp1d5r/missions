import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function git(cwd: string, args: string[]): string {
	// stderr must be piped, not inherited: execFileSync's default sends the child's
	// stderr straight to ours, so an expected failure (a branch that is checked out,
	// a ref that does not exist) would print through the middle of a TUI frame.
	return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function gitSafe(cwd: string, args: string[]): { ok: boolean; out: string } {
	try {
		return { ok: true, out: git(cwd, args) };
	} catch (err) {
		const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
		return { ok: false, out: (e.stderr?.toString() ?? e.stdout?.toString() ?? e.message ?? "").trim() };
	}
}

export function isGitRepo(cwd: string): boolean {
	return gitSafe(cwd, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function currentBranch(cwd: string): string {
	return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export function headSha(cwd: string): string {
	return git(cwd, ["rev-parse", "HEAD"]).trim();
}

/** Create the work branch off current HEAD (or switch to it if it already exists). Never touches main directly. */
export function ensureBranch(cwd: string, branch: string): void {
	const exists = gitSafe(cwd, ["rev-parse", "--verify", branch]).ok;
	if (exists) git(cwd, ["checkout", branch]);
	else git(cwd, ["checkout", "-b", branch]);
}

export function hasUncommittedChanges(cwd: string): boolean {
	return git(cwd, ["status", "--porcelain"]).trim().length > 0;
}

/**
 * Stage everything and commit. Returns the new sha, or null if there was nothing to commit.
 *
 * `excludePaths` are the paths the harness itself placed in the worktree (linked dependency
 * dirs, copied env files). They must never be staged, and a repo's own .gitignore cannot be
 * relied on to hide them: directory-only patterns like `node_modules/` do NOT match a symlink,
 * so a bootstrapped worktree shows them as untracked and `git add -A` would happily commit
 * symlinks pointing back at the main checkout.
 */
export function commitAll(cwd: string, message: string, excludePaths: string[] = []): string | null {
	git(cwd, ["add", "-A"]);
	// Unstage rather than exclude via pathspec: `:(exclude)` on an already-ignored path makes
	// `git add` fail outright, whereas `reset` is quiet whether the path was staged or not.
	if (excludePaths.length) gitSafe(cwd, ["reset", "-q", "--", ...excludePaths]);
	// Ask whether anything is STAGED rather than whether the tree is dirty — the excluded
	// paths stay untracked on purpose, so a dirty tree is the normal state here.
	if (gitSafe(cwd, ["diff", "--cached", "--quiet"]).ok) return null;
	git(cwd, ["commit", "-m", message, "--no-verify"]);
	return headSha(cwd);
}

/** Create an isolated worktree on a fresh branch off baseRef, so missions run in parallel without collision. */
export function addWorktree(repoCwd: string, worktreePath: string, branch: string, baseRef: string): void {
	mkdirSync(dirname(worktreePath), { recursive: true });
	git(repoCwd, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
}

/** Remove a worktree (commits remain on its branch in the shared repo). */
export function removeWorktree(repoCwd: string, worktreePath: string): void {
	gitSafe(repoCwd, ["worktree", "remove", "--force", worktreePath]);
}

export interface WorktreeEntry {
	path: string;
	branch?: string;
	/** git has the bookkeeping but the directory is gone. */
	prunable: boolean;
}

/** Every worktree git knows about for this repo, including ones whose directory has vanished. */
export function listWorktrees(repoCwd: string): WorktreeEntry[] {
	const { ok, out } = gitSafe(repoCwd, ["worktree", "list", "--porcelain"]);
	if (!ok) return [];
	const entries: WorktreeEntry[] = [];
	let cur: WorktreeEntry | undefined;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (cur) entries.push(cur);
			cur = { path: line.slice("worktree ".length).trim(), prunable: false };
		} else if (cur && line.startsWith("branch ")) {
			cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		} else if (cur && line.startsWith("prunable")) {
			cur.prunable = true;
		}
	}
	if (cur) entries.push(cur);
	// The first entry is the main checkout, which is never a mission worktree.
	return entries.slice(1);
}

/** Drop git's bookkeeping for worktrees whose directories are already gone. */
export function pruneWorktrees(repoCwd: string): void {
	gitSafe(repoCwd, ["worktree", "prune"]);
}

/**
 * Whether a worktree holds anything that only exists there.
 *
 * Untracked files count. A worker that wrote a file and never committed it has
 * produced work that no branch is holding, and removing the tree destroys it —
 * so this is the gate every reclaim goes through.
 */
export function worktreeIsClean(worktreeCwd: string): boolean {
	const { ok, out } = gitSafe(worktreeCwd, ["status", "--porcelain"]);
	return ok && out.trim().length === 0;
}

/** Whether every commit on `branch` is already contained in `into`. */
export function isMerged(repoCwd: string, branch: string, into: string): boolean {
	const { ok, out } = gitSafe(repoCwd, ["branch", "--merged", into, "--format=%(refname:short)"]);
	if (!ok) return false;
	return out.split("\n").some((l) => l.trim() === branch);
}

/**
 * Delete a branch, refusing if it holds commits nothing else has.
 *
 * Deliberately `-d`, never `-D`: the branch is the only durable artifact of a
 * mission, so git's own merge check is the last thing standing between a
 * dismissed mission and lost work.
 */
export function deleteBranch(repoCwd: string, branch: string): { ok: boolean; out: string } {
	return gitSafe(repoCwd, ["branch", "-d", branch]);
}

/** Branch names matching a prefix, e.g. every `missions/…` branch. */
export function branchesWithPrefix(repoCwd: string, prefix: string): string[] {
	const { ok, out } = gitSafe(repoCwd, ["branch", "--list", `${prefix}*`, "--format=%(refname:short)"]);
	if (!ok) return [];
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** The repo's default branch name, for deciding what "already merged" means. */
export function defaultBranch(repoCwd: string): string {
	for (const name of ["main", "master"]) {
		if (gitSafe(repoCwd, ["rev-parse", "--verify", name]).ok) return name;
	}
	return currentBranch(repoCwd);
}

/** Merge a mission branch into the repo's currently checked-out branch. Non-throwing. */
export function mergeBranch(repoCwd: string, branch: string): { ok: boolean; out: string } {
	return gitSafe(repoCwd, ["merge", "--no-ff", branch, "-m", `merge ${branch} (via pi-missions)`]);
}

/** Unified diff of the given commit against its parent (what a worker changed). */
export function diffOfCommit(cwd: string, sha: string): string {
	return gitSafe(cwd, ["show", sha, "--no-color", "--format=%H%n%s%n"]).out;
}

/** Diff of working tree + staged changes against a base ref. */
export function diffAgainst(cwd: string, baseRef: string): string {
	return gitSafe(cwd, ["diff", "--no-color", baseRef, "--", ".", ":(exclude)*.lock", ":(exclude)*-lock.json"]).out;
}
