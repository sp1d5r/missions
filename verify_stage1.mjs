// End-to-end check of the stage-1 worktree isolation work, against the real nadine repo.
// Creates a throwaway worktree, bootstraps it, then asserts on observable facts.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const M = "/Users/elijahahmad/missions/dist";
const { bootstrapWorktree, applyEnvOverrides } = await import(`${M}/bootstrap.js`);
const { commitAll } = await import(`${M}/git.js`);
const { resolveMissionEnv, parseEnvFile } = await import(`${M}/env.js`);
const { runCheck, REFUSED_EXIT_CODE } = await import(`${M}/validators/checks.js`);
const { discoverEnvFiles } = await import(`${M}/target/index.js`);
const { observeProduced } = await import(`${M}/setup.js`);
const { planTouchesSchema } = await import(`${M}/db-branch.js`);

const REPO = "/Users/elijahahmad/nadine";
const ID = "m-verify-stage1";
const WT = join(REPO, ".missions", "worktrees", ID);
const BRANCH = `missions/${ID}`;

const results = [];
const check = (name, pass, detail = "") => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function cleanup() {
	try {
		execFileSync("git", ["worktree", "remove", "--force", WT], { cwd: REPO, stdio: "ignore" });
	} catch {}
	try {
		execFileSync("git", ["branch", "-D", BRANCH], { cwd: REPO, stdio: "ignore" });
	} catch {}
	// node_modules is now a copy-on-write clone rather than a symlink, so teardown deletes a real
	// multi-thousand-file tree. Node's rimraf fails ENOTEMPTY partway through these on APFS even
	// with retries; `rm -rf` handles them natively, so use it rather than fight the runtime.
	try {
		execFileSync("rm", ["-rf", WT], { stdio: "ignore" });
	} catch {
		rmSync(WT, { recursive: true, force: true });
	}
}

cleanup();
const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf-8" }).trim();
execFileSync("git", ["worktree", "add", "-b", BRANCH, WT, base], { cwd: REPO, stdio: "ignore" });

try {
	// Env files are discovered now, not declared. Prove the discovery before using it.
	const discovered = discoverEnvFiles(REPO);
	check("env files are DISCOVERED, not declared", discovered.includes(".env") && discovered.includes("naomi-web/.env.local"), discovered.join(", "));
	check("secrets backups are excluded from discovery", !discovered.some((f) => /\.(backup|bak|example)$/.test(f)));

	// Baseline: a bare worktree is unrunnable. This is what workers used to get.
	check("bare worktree has no .env", !existsSync(join(WT, ".env")));
	check("bare worktree has no backend/.venv", !existsSync(join(WT, "backend/.venv")));

	const boot = bootstrapWorktree({ targetCwd: REPO, workCwd: WT });
	console.log(`\n  bootstrap notes:\n${boot.notes.map((n) => `    - ${n}`).join("\n")}\n`);

	// 1. Env files land as real copies.
	check("root .env copied in", existsSync(join(WT, ".env")));
	check(
		"root .env has the same key count as the source",
		Object.keys(parseEnvFile(join(WT, ".env"))).length === Object.keys(parseEnvFile(join(REPO, ".env"))).length,
		`${Object.keys(parseEnvFile(join(WT, ".env"))).length} keys`,
	);
	check("naomi-web/.env.local copied in (Next reads only its own dir)", existsSync(join(WT, "naomi-web/.env.local")));
	check("website/.env.local copied in", existsSync(join(WT, "website/.env.local")));

	// 2. Deps arrive as symlinks, not copies.
	// Dependencies are NOT inherited any more — setup installs them. A bare worktree having no
	// venv is now the correct state, not a bug.
	check("dependencies are NOT inherited from the main checkout", !existsSync(join(WT, "backend/.venv")));
	check("observeProduced finds nothing in an un-set-up tree", observeProduced(WT).binDirs.length === 0);
	const mainProduced = observeProduced(REPO);
	check("observeProduced reads source roots from .pth in a set-up tree", mainProduced.sourceRoots.length >= 4, `${mainProduced.sourceRoots.length} roots, ${mainProduced.binDirs.length} bin dirs`);
	check("discovered source roots include one the old hardcoded list missed", mainProduced.sourceRoots.some((r) => r.endsWith("queue_service/src")));

	// 3. Bootstrap must leave the tree clean. This flipped when dependency inheritance was
	//    removed: symlinked node_modules/pi-mono showed as untracked (a repo's directory-only
	//    ignore patterns do not match a symlink), so the harness needed its own exclusions.
	//    Now only env files are placed, and those are gitignored by definition — we discover
	//    them BY asking git whether they are ignored. So a dirty tree here would mean bootstrap
	//    put something where it does not belong.
	const unignored = execFileSync("git", ["status", "--porcelain"], { cwd: WT, encoding: "utf-8" })
		.trim()
		.split("\n")
		.filter(Boolean);
	check(
		"bootstrap leaves the worktree git-clean (nothing placed that git cannot ignore)",
		unignored.length === 0,
		unignored.map((l) => l.slice(3)).join(", "),
	);
	check(
		"an unchanged worktree produces no commit despite untracked symlinks",
		commitAll(WT, "should not happen", boot.gitExcludes) === null,
	);
	writeFileSync(join(WT, "MISSION_TOUCHED.md"), "worker output\n");
	const sha = commitAll(WT, "feat: worker change", boot.gitExcludes);
	const committed = execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd: WT, encoding: "utf-8" })
		.trim()
		.split("\n")
		.filter(Boolean);
	check("a real change still commits", committed.includes("MISSION_TOUCHED.md"));
	check(
		"the commit contains ONLY the worker's change — no linked deps or env files",
		committed.length === 1,
		committed.join(", "),
	);

	// 4. The crux: python must resolve inside the worktree, not via the venv's baked-in .pth.
	// Source roots come from observing the SET-UP main checkout, rewritten to point at the worktree —
	// which is what setup will produce once it has installed into the worktree itself.
	const roots = mainProduced.sourceRoots.map((r) => r.replace(REPO, WT)).filter((r) => existsSync(r));
	const env = resolveMissionEnv({ targetCwd: REPO, workCwd: WT, missionId: ID, sourceRoots: roots });
	check("package-manager caches are shared, not per-worktree", Boolean(env.PDM_CACHE_DIR && env.PNPM_STORE_DIR), env.PDM_CACHE_DIR ?? "");
	const py = join(REPO, "backend/.venv/bin/python");
	const probe = "import nadine_shared, app; print(nadine_shared.__file__); print(app.__file__)";
	const out = execFileSync(py, ["-c", probe], { cwd: WT, env, encoding: "utf-8" });
	const [sharedPath, appPath] = out.trim().split("\n").filter((l) => l.startsWith("/"));
	check("nadine_shared resolves inside the worktree", sharedPath?.startsWith(WT), sharedPath);
	check("app resolves inside the worktree", appPath?.startsWith(WT), appPath);

	// And confirm the leak is real without our PYTHONPATH — otherwise the fix proves nothing.
	const bare = { ...process.env };
	delete bare.PYTHONPATH;
	const leaked = execFileSync(py, ["-c", probe], { cwd: WT, env: bare, encoding: "utf-8" });
	const leakedApp = leaked.trim().split("\n").filter((l) => l.startsWith("/"))[1];
	check(
		"without PYTHONPATH it really does leak to the main checkout (fix is load-bearing)",
		Boolean(leakedApp) && !leakedApp.startsWith(WT),
		leakedApp,
	);

	// 5. Mission markers are visible to commands.
	const marker = runCheck({ cwd: WT, command: 'test "$MISSIONS_WORKTREE" = "' + WT + '"', env, foreignRoot: REPO });
	check("MISSIONS_WORKTREE reaches bash commands", marker.passed);

	// 6. The guard: the exact assertion shape that silently validated main before.
	const refused = runCheck({ cwd: WT, command: `cd ${REPO} && git log --oneline -1`, env, foreignRoot: REPO });
	check("assertion reaching into the main checkout is refused", refused.exitCode === REFUSED_EXIT_CODE);
	const allowed = runCheck({ cwd: WT, command: "git log --oneline -1", env, foreignRoot: REPO });
	check("relative assertion still runs", allowed.passed);
	const selfRef = runCheck({ cwd: WT, command: `ls ${WT}/backend >/dev/null`, env, foreignRoot: REPO });
	check("absolute path to the worktree itself is allowed", selfRef.passed);

	// 7. Login-shell removal: assertions get the mission env, not ~/.zshrc's.
	const noProfile = runCheck({
		cwd: WT,
		command: 'test -n "$MISSIONS_MISSION_ID"',
		env: resolveMissionEnv({ targetCwd: REPO, workCwd: WT, missionId: ID, sourceRoots: [] }),
		foreignRoot: REPO,
	});
	check("mission env survives into assertion shells", noProfile.passed);

	// 8. Overrides must win on disk, because dotenv loads with override=True.
	applyEnvOverrides({
		targetCwd: REPO,
		workCwd: WT,
		envFile: ".env",
		missionId: ID,
		overrides: { DB_HOST: "branch-host.example", DATABASE_URL: "postgresql://branch/db" },
	});
	const rewritten = parseEnvFile(join(WT, ".env"));
	check("override lands in the worktree .env on disk", rewritten.DB_HOST === "branch-host.example");
	check("non-overridden keys are preserved", Boolean(rewritten.R2_BUCKET_NAME));
	const seen = execFileSync(py, ["-c", "from nadine_shared.config import Config; print(Config.DB_HOST)"], {
		cwd: WT,
		env,
		encoding: "utf-8",
	})
		.trim()
		.split("\n")
		.at(-1);
	check("Config reads the override through dotenv override=True", seen === "branch-host.example", seen);

	// 9. Schema detection drives whether we branch at all.
	const ddl = { summary: "add a column", architectureNote: "", features: [{ title: "alembic revision", description: "run alembic upgrade head", procedures: [] }], contract: { assertions: [] } };
	const noDdl = { summary: "fix a caption bug", architectureNote: "", features: [{ title: "caption clamp", description: "adjust the safe zone", procedures: [] }], contract: { assertions: [] } };
	check("schema work is detected", planTouchesSchema(ddl) === true);
	check("non-schema work is not", planTouchesSchema(noDdl) === false);
} finally {
	cleanup();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
	console.log(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
	process.exit(1);
}
