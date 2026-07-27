import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo-shaped facts that are cheaper to observe than to declare.
 *
 * There used to be a per-repo adapter here holding hand-written lists of env files, venvs,
 * node_modules and source roots. It described exactly one repo, went stale (its source-root list
 * was missing `queue_service/src` and nobody noticed), and it inherited dependency state from the
 * main checkout instead of setting the worktree up properly.
 *
 * Dependencies are now the setup stage's job (see setup.ts). What remains here is the one thing
 * setup cannot produce: secrets. Env files are gitignored, so a worktree never inherits them and
 * no install can recreate them — they have to be copied from the main checkout.
 */

/** Env files a worktree needs. Discovered: gitignored, present, and named like an env file. */
export function discoverEnvFiles(repoCwd: string): string[] {
	const candidates: string[] = [];
	// `.env`, `.env.local`, `.env.production` — but not templates (nothing secret in them, and
	// they are usually tracked) and not backups. A stale `.env.naomi-e2e.backup` copied into a
	// worktree is live credentials nobody asked for, sitting where a worker might read them.
	const looksLikeEnv = (name: string) =>
		/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|bak|backup|old|orig)$/.test(name);

	const scan = (dirRel: string) => {
		const abs = dirRel ? join(repoCwd, dirRel) : repoCwd;
		let entries: import("node:fs").Dirent[] = [];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isFile() && looksLikeEnv(e.name)) candidates.push(dirRel ? join(dirRel, e.name) : e.name);
		}
	};

	scan("");
	try {
		for (const e of readdirSync(repoCwd, { withFileTypes: true })) {
			if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") scan(e.name);
		}
	} catch {
		/* unreadable tree */
	}
	if (!candidates.length) return [];

	// Only gitignored ones. A committed .env is already in the worktree, and copying a tracked
	// file over itself would show up as a spurious diff.
	try {
		const res = execFileSync("git", ["check-ignore", "--stdin"], {
			cwd: repoCwd,
			input: candidates.join("\n"),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		});
		return res.split("\n").map((l) => l.trim()).filter(Boolean).sort();
	} catch (err) {
		// git check-ignore exits 1 when nothing matched — that is an answer, not a failure.
		const out = (err as { stdout?: string }).stdout;
		return typeof out === "string" ? out.split("\n").map((l) => l.trim()).filter(Boolean).sort() : [];
	}
}

/** A short top-level summary of the repo, handed to the orchestrator so it can plan. */
export function topLevelRecon(cwd: string): string {
	const entries = readdirSync(cwd, { withFileTypes: true })
		.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		.sort()
		.slice(0, 60);
	const lines = [`entries: ${entries.join(", ")}`];
	for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
		const p = join(cwd, manifest);
		if (existsSync(p)) lines.push(`\n${manifest}:\n${readFileSync(p, "utf-8").slice(0, 800)}`);
	}
	return lines.join("\n");
}
