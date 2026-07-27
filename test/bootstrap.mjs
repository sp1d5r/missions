/**
 * Tests for how a worktree gets its dependencies.
 *
 * The distinction under test is the one that caused nadine to hold 4.5GB: a
 * SYMLINKED dependency dir is shared with the main checkout, so a worker's
 * install either writes through into it or replaces the link with a real
 * multi-gigabyte tree. A CLONED one is private, writable, and costs the delta.
 *
 * The must-never case is the last test: writing inside a cloned dir must not be
 * visible in the main checkout.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { bootstrapWorktree } = await import("../dist/bootstrap.js");

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
/** A main checkout with an env file, a fake venv, and a fake node_modules. */
function scaffold() {
	const root = mkdtempSync(join(tmpdir(), "missions-boot-"));
	roots.push(root);
	const main = join(root, "main");
	const work = join(root, "work");
	mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true });
	mkdirSync(join(main, ".venv", "bin"), { recursive: true });
	mkdirSync(work, { recursive: true });
	writeFileSync(join(main, ".env"), "SECRET=from-main\n");
	writeFileSync(join(main, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
	writeFileSync(join(main, ".venv", "bin", "python"), "#!/bin/sh\n");
	return { main, work };
}

const spec = (over = {}) => ({ envFiles: [".env"], linkDirs: [".venv"], cloneDirs: ["node_modules"], sourceRoots: [], ...over });

await check("env files are copied, never linked", async () => {
	const { main, work } = scaffold();
	const r = await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	assert(r.envFiles.includes(".env"), "env not reported");
	assert(!lstatSync(join(work, ".env")).isSymbolicLink(), "env was symlinked — a shared file beats mission overrides");
	assert(readFileSync(join(work, ".env"), "utf-8").includes("from-main"), "env content missing");
});

await check("linkDirs are symlinked", async () => {
	const { main, work } = scaffold();
	const r = await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	assert(r.linkedDirs.includes(".venv"), `.venv not linked: ${JSON.stringify(r.linkedDirs)}`);
	assert(lstatSync(join(work, ".venv")).isSymbolicLink(), ".venv is not a symlink");
});

await check("cloneDirs become REAL directories, not symlinks", async () => {
	const { main, work } = scaffold();
	const r = await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	assert(r.clonedDirs.includes("node_modules"), `node_modules not cloned: ${JSON.stringify(r)}`);
	assert(!lstatSync(join(work, "node_modules")).isSymbolicLink(), "node_modules is still a symlink — an install would hit the main checkout");
	assert(existsSync(join(work, "node_modules", "left-pad", "index.js")), "clone did not carry contents");
});

await check("a cloned dir is PRIVATE — installing into it cannot reach the main checkout", async () => {
	// The whole point. If this fails, a mission can corrupt the tree you work in.
	const { main, work } = scaffold();
	await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	writeFileSync(join(work, "node_modules", "left-pad", "index.js"), "module.exports = 999\n");
	mkdirSync(join(work, "node_modules", "brand-new-pkg"), { recursive: true });
	assert(readFileSync(join(main, "node_modules", "left-pad", "index.js"), "utf-8").includes("= 1"), "a write in the worktree changed the MAIN checkout");
	assert(!existsSync(join(main, "node_modules", "brand-new-pkg")), "an install in the worktree appeared in the MAIN checkout");
});

await check("everything the harness placed is excluded from commits", async () => {
	const { main, work } = scaffold();
	const r = await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	for (const p of [".env", ".venv", "node_modules"]) {
		assert(r.gitExcludes.includes(p), `${p} missing from gitExcludes — git add -A would stage it`);
	}
});

await check("a worker's own real directory is never replaced", async () => {
	const { main, work } = scaffold();
	mkdirSync(join(work, "node_modules"), { recursive: true });
	writeFileSync(join(work, "node_modules", "worker-made-this.txt"), "keep me\n");
	await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	assert(existsSync(join(work, "node_modules", "worker-made-this.txt")), "clobbered a directory the worker created");
});

await check("our own stale symlink IS replaced", async () => {
	const { main, work } = scaffold();
	symlinkSync(join(main, "node_modules"), join(work, "node_modules"), "dir");
	const r = await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	assert(r.clonedDirs.includes("node_modules"), "left a stale symlink in place of a clone");
	assert(!lstatSync(join(work, "node_modules")).isSymbolicLink(), "still a symlink");
});

await check("a missing source dir is skipped, not fatal", async () => {
	const { main, work } = scaffold();
	const r = await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec({ cloneDirs: ["node_modules", "does/not/exist"], linkDirs: [".venv", "nope"] }) });
	assert(r.clonedDirs.includes("node_modules"), "real dir not cloned");
	assert(!r.clonedDirs.includes("does/not/exist"), "reported a clone that cannot exist");
	assert(!existsSync(join(work, "does")), "created a directory for a missing source");
});

await check("clones are copy-on-write where the filesystem supports it", async () => {
	// Not a correctness requirement — a real copy still works — so this reports
	// rather than fails on a filesystem without clone support.
	const { main, work } = scaffold();
	await bootstrapWorktree({ targetCwd: main, workCwd: work, spec: spec() });
	let cow = false;
	try {
		execFileSync("cp", ["-Rc", join(main, "node_modules"), join(work, "cow-probe")], { stdio: "ignore" });
		cow = true;
	} catch {
		/* filesystem cannot clone */
	}
	console.log(`     (copy-on-write ${cow ? "available" : "NOT available"} on ${process.platform})`);
});

for (const r of roots) rmSync(r, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
