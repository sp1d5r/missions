/**
 * Tests for the code that deletes things.
 *
 * Every case here is a way to destroy work that no branch is holding: an
 * uncommitted edit, an untracked file, an unmerged branch, a worktree belonging
 * to a mission the human has not reviewed yet. The reclaim gate is the only
 * thing standing between a routine sweep and lost work, so it is tested from
 * both sides — that it removes what it should, and refuses what it must.
 *
 * Runs against a real git repo in a temp dir. MISSIONS_HOME is redirected so the
 * live board is never touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "missions-lc-home-"));
process.env.MISSIONS_HOME = HOME;

const { reclaimWorktree, reclaimBranch, sweep } = await import("../dist/lifecycle.js");
const { writeActive } = await import("../dist/registry.js");
const { registerWorkspace } = await import("../dist/workspaces.js");

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8" }).toString().trim();

/** A fresh repo with one commit on main. */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), "missions-lc-repo-"));
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t.co");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	return repo;
}

/** A mission worktree at the path the harness would use. */
function makeWorktree(repo, id, { commit = false } = {}) {
	const path = join(repo, ".missions", "worktrees", id);
	mkdirSync(join(repo, ".missions", "worktrees"), { recursive: true });
	git(repo, "worktree", "add", "-q", "-b", `missions/${id}`, path, "main");
	if (commit) {
		writeFileSync(join(path, "b.txt"), "work\n");
		git(path, "add", "-A");
		git(path, "commit", "-qm", "mission work");
	}
	return path;
}

const record = (repo, id, patch = {}) => ({
	id,
	repo,
	repoName: "repo",
	goal: "g",
	status: "succeeded",
	startedAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
	lastActivity: "",
	costUsd: 0,
	done: true,
	worktreePath: join(repo, ".missions", "worktrees", id),
	...patch,
});

const repos = [];
function repo() {
	const r = makeRepo();
	repos.push(r);
	registerWorkspace(r);
	return r;
}

// ---------------------------------------------------------------------------
// The reclaim gate
// ---------------------------------------------------------------------------

check("a clean worktree is removed", () => {
	const r = repo();
	const wt = makeWorktree(r, "clean", { commit: true });
	const got = reclaimWorktree(r, wt, "merged");
	assert(!got.skipped, `refused: ${got.skipped}`);
	assert(!existsSync(wt), "directory still there");
});

check("a worktree with an uncommitted edit is refused", () => {
	const r = repo();
	const wt = makeWorktree(r, "dirty");
	writeFileSync(join(wt, "a.txt"), "edited\n");
	const got = reclaimWorktree(r, wt, "dismissed");
	assert(got.skipped?.includes("uncommitted"), `expected refusal, got ${JSON.stringify(got)}`);
	assert(existsSync(wt), "removed a worktree holding uncommitted work");
});

check("a worktree with only an UNTRACKED file is still refused", () => {
	// The dangerous case: git status is otherwise clean, but that file exists nowhere else.
	const r = repo();
	const wt = makeWorktree(r, "untracked");
	writeFileSync(join(wt, "scratch.txt"), "the only copy\n");
	const got = reclaimWorktree(r, wt, "dismissed");
	assert(got.skipped?.includes("uncommitted"), `expected refusal, got ${JSON.stringify(got)}`);
	assert(existsSync(join(wt, "scratch.txt")), "destroyed the only copy of an untracked file");
});

check("a path outside .missions/worktrees is refused", () => {
	const r = repo();
	const outside = join(r, ".claude", "worktrees", "someone-elses");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "keep.txt"), "not ours\n");
	const got = reclaimWorktree(r, outside, "orphan");
	assert(got.skipped === "not a mission worktree", `expected refusal, got ${JSON.stringify(got)}`);
	assert(existsSync(outside), "touched another tool's worktree");
});

check("dry run reports without deleting", () => {
	const r = repo();
	const wt = makeWorktree(r, "dry", { commit: true });
	const got = reclaimWorktree(r, wt, "merged", true);
	assert(!got.skipped, `refused: ${got.skipped}`);
	assert(existsSync(wt), "dry run deleted the worktree");
});

// ---------------------------------------------------------------------------
// Branches — the only durable artifact
// ---------------------------------------------------------------------------

check("an unmerged branch is never deleted", () => {
	const r = repo();
	const wt = makeWorktree(r, "unmerged", { commit: true });
	reclaimWorktree(r, wt, "dismissed");
	const got = reclaimBranch(r, "missions/unmerged");
	assert(got === undefined, "reported action on an unmerged branch");
	assert(git(r, "branch", "--list", "missions/unmerged").length > 0, "deleted a branch holding unmerged commits");
});

check("a merged branch is deleted", () => {
	const r = repo();
	const wt = makeWorktree(r, "merged", { commit: true });
	git(r, "merge", "--no-ff", "missions/merged", "-m", "merge");
	reclaimWorktree(r, wt, "merged");
	const got = reclaimBranch(r, "missions/merged");
	assert(got && !got.skipped, `expected deletion, got ${JSON.stringify(got)}`);
	assert(git(r, "branch", "--list", "missions/merged").length === 0, "branch survived");
});

check("branches outside the missions/ prefix are ignored", () => {
	const r = repo();
	git(r, "branch", "feature/mine");
	assert(reclaimBranch(r, "feature/mine") === undefined, "considered a non-mission branch");
	assert(git(r, "branch", "--list", "feature/mine").length > 0, "deleted a branch that is not ours");
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

check("sweep leaves a RUNNING mission alone", () => {
	const r = repo();
	const wt = makeWorktree(r, "running", { commit: true });
	writeActive(record(r, "running", { done: false, status: "working" }));
	sweep({ repos: [r] });
	assert(existsSync(wt), "reclaimed a worktree out from under a running mission");
});

check("sweep leaves a finished-but-UNREVIEWED mission alone", () => {
	const r = repo();
	const wt = makeWorktree(r, "unreviewed", { commit: true });
	writeActive(record(r, "unreviewed", { done: true, cleared: false }));
	sweep({ repos: [r] });
	assert(existsSync(wt), "reclaimed the worktree of a mission awaiting review");
});

check("sweep reclaims a cleared mission", () => {
	const r = repo();
	const wt = makeWorktree(r, "cleared", { commit: true });
	writeActive(record(r, "cleared", { done: true, cleared: true }));
	const res = sweep({ repos: [r] });
	assert(!existsSync(wt), "left a cleared mission's worktree behind");
	assert(res.reclaimed.some((x) => x.reason === "cleared"), "did not report the reclaim");
});

check("sweep reclaims an orphan with no record at all", () => {
	// The nadine case: worktrees predating the registry, or a record deleted by hand.
	const r = repo();
	const wt = makeWorktree(r, "orphan", { commit: true });
	const res = sweep({ repos: [r] });
	assert(!existsSync(wt), "left an orphaned worktree behind");
	assert(res.reclaimed.some((x) => x.reason === "orphan"), "did not report it as an orphan");
});

check("sweep never removes an orphan holding uncommitted work", () => {
	const r = repo();
	const wt = makeWorktree(r, "orphan-dirty");
	writeFileSync(join(wt, "only-copy.txt"), "unsaved\n");
	sweep({ repos: [r] });
	assert(existsSync(join(wt, "only-copy.txt")), "swept away unsaved work");
});

check("sweep drops records whose repo is gone", () => {
	writeActive(record("/tmp/definitely-not-a-repo-xyz", "ghost", { cleared: true }));
	const res = sweep({ repos: [] });
	assert(res.droppedRecords >= 1, "kept a record for a repo that no longer exists");
});

check("dry-run sweep changes nothing", () => {
	const r = repo();
	const wt = makeWorktree(r, "dry-sweep", { commit: true });
	writeActive(record(r, "dry-sweep", { cleared: true }));
	const res = sweep({ repos: [r], dryRun: true });
	assert(existsSync(wt), "dry-run sweep deleted a worktree");
	assert(res.reclaimed.length > 0, "dry run reported nothing");
});

for (const r of repos) rmSync(r, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
