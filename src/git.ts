import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).toString();
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
