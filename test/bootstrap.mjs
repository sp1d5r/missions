/**
 * Tests for what a worktree is given before any work starts.
 *
 * This file used to test dependency inheritance — symlinked venvs and cloned node_modules.
 * That mechanism is gone: dependencies are installed by the setup stage (setup.ts) rather than
 * copied from the main checkout, because inheriting an install meant a mission that changed a
 * lockfile could never test its own change.
 *
 * What bootstrap still owns is the one thing no install can recreate: secrets. So these cover
 * env-file discovery and copying, plus the properties that must hold around them — discovery
 * must not pick up templates or credential backups, a copy must be independent of the main
 * checkout, and nothing placed here may reach a commit.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { bootstrapWorktree } = await import("../dist/bootstrap.js");
const { discoverEnvFiles } = await import("../dist/target/generic.js");

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

const roots = [];

/**
 * A git repo standing in for a main checkout: a root env file, a nested one, a template, a
 * credentials backup, and a .gitignore covering the real ones. Discovery asks git what is
 * ignored, so this has to be a real repo rather than a bare directory.
 */
function scaffold() {
	const root = mkdtempSync(join(tmpdir(), "missions-boot-"));
	roots.push(root);
	const main = join(root, "main");
	const work = join(root, "work");
	mkdirSync(join(main, "webapp"), { recursive: true });
	mkdirSync(work, { recursive: true });

	writeFileSync(join(main, ".gitignore"), ".env\n.env.*\nwebapp/.env.local\n");
	writeFileSync(join(main, ".env"), "SECRET=from-main\n");
	writeFileSync(join(main, "webapp", ".env.local"), "VITE_KEY=abc\n");
	writeFileSync(join(main, ".env.example"), "SECRET=replace-me\n");
	writeFileSync(join(main, ".env.backup"), "SECRET=old-live-key\n");
	writeFileSync(join(main, "README.md"), "# fixture\n");

	execFileSync("git", ["init", "-q"], { cwd: main });
	execFileSync("git", ["add", "-A"], { cwd: main });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: main });
	return { main, work };
}

await check("discovery finds gitignored env files, root and nested", async () => {
	const { main } = scaffold();
	const found = discoverEnvFiles(main);
	assert(found.includes(".env"), `.env missing: ${JSON.stringify(found)}`);
	assert(found.includes("webapp/.env.local"), `nested env missing: ${JSON.stringify(found)}`);
});

await check("discovery skips templates — tracked, and nothing secret in them", async () => {
	const { main } = scaffold();
	assert(!discoverEnvFiles(main).includes(".env.example"), "would have copied a template");
});

await check("discovery skips credential BACKUPS", async () => {
	// Regression: the declared list this replaced copied backend/.env.naomi-e2e.backup into every
	// worktree — live credentials nobody asked for, sitting where a worker could read them.
	const { main } = scaffold();
	assert(!discoverEnvFiles(main).includes(".env.backup"), "would have copied a credentials backup");
});

await check("env files are COPIED into the worktree", async () => {
	const { main, work } = scaffold();
	const r = bootstrapWorktree({ targetCwd: main, workCwd: work });
	assert(r.envFiles.includes(".env"), `.env not copied: ${JSON.stringify(r.envFiles)}`);
	assert(existsSync(join(work, ".env")), ".env absent from the worktree");
	assert(readFileSync(join(work, ".env"), "utf-8").includes("from-main"), "copied the wrong contents");
});

await check("nested env files land at the right path", async () => {
	const { main, work } = scaffold();
	bootstrapWorktree({ targetCwd: main, workCwd: work });
	assert(existsSync(join(work, "webapp", ".env.local")), "nested env not placed — Vite/Next read only their own dir");
});

await check("a copy is independent of the main checkout", async () => {
	// Copied, never symlinked: Config loads .env with override=True, so a shared file would beat
	// any value the harness injects — a mission's database override must be the value on disk.
	const { main, work } = scaffold();
	bootstrapWorktree({ targetCwd: main, workCwd: work });
	writeFileSync(join(work, ".env"), "SECRET=mission-override\n");
	assert(readFileSync(join(main, ".env"), "utf-8").includes("from-main"), "writing the worktree's env changed the main checkout");
});

await check("everything bootstrap placed is excluded from commits", async () => {
	const { main, work } = scaffold();
	const r = bootstrapWorktree({ targetCwd: main, workCwd: work });
	for (const f of r.envFiles) {
		assert(r.gitExcludes.includes(f), `${f} missing from gitExcludes — git add -A could stage it`);
	}
});

await check("a repo with no env files is not an error", async () => {
	const root = mkdtempSync(join(tmpdir(), "missions-boot-bare-"));
	roots.push(root);
	const main = join(root, "main");
	const work = join(root, "work");
	mkdirSync(main, { recursive: true });
	mkdirSync(work, { recursive: true });
	writeFileSync(join(main, "README.md"), "# no secrets here\n");
	execFileSync("git", ["init", "-q"], { cwd: main });
	execFileSync("git", ["add", "-A"], { cwd: main });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: main });

	const r = bootstrapWorktree({ targetCwd: main, workCwd: work });
	assert(r.envFiles.length === 0, `invented env files: ${JSON.stringify(r.envFiles)}`);
	assert(r.notes.some((n) => n.includes("no gitignored env files")), "said nothing about having found none");
});

await check("dependencies are NOT inherited — that is the setup stage's job", async () => {
	const { main, work } = scaffold();
	mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true });
	writeFileSync(join(main, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
	bootstrapWorktree({ targetCwd: main, workCwd: work });
	assert(!existsSync(join(work, "node_modules")), "bootstrap copied or linked node_modules — setup installs those now");
});

for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3 });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
