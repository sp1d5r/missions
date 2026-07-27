import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Per-mission environment resolution.
//
// Two measured facts drive this file. Both were silent cross-tree leaks before:
//
// 1. Nadine's Config calls find_dotenv(usecwd=True) then load_dotenv(override=True).
//    find_dotenv walks UP the tree, so a worktree at <repo>/.missions/worktrees/<id>
//    picks up the PARENT repo's .env by accident — and because override=True, that
//    file beats anything the harness injects. Env files are therefore COPIED into
//    the worktree with overrides applied to the copy, never symlinked (see
//    bootstrap.ts). Injecting a var and hoping it wins does not work here.
//
// 2. Service venvs carry absolute .pth entries pointing back into the main checkout
//    (backend/.venv/.../nadine_backend.pth -> /Users/…/nadine/backend/src) plus stale
//    copies of nadine_shared / naomi_agent in site-packages. PYTHONPATH is resolved
//    BEFORE .pth entries, so an explicit PYTHONPATH rooted in the worktree is the only
//    thing that keeps a worker reading the source it just edited.

/** Parse a KEY=VALUE env file. No interpolation — values are taken literally. */
export function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		let key = line.slice(0, eq).trim();
		if (key.startsWith("export ")) key = key.slice(7).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/** Render a KEY=VALUE env file, quoting anything that needs it. */
export function serializeEnvFile(vars: Record<string, string>, header: string[] = []): string {
	const lines = header.map((h) => `# ${h}`);
	if (lines.length) lines.push("");
	for (const [key, value] of Object.entries(vars)) {
		const needsQuotes = /[\s#"']/.test(value);
		lines.push(`${key}=${needsQuotes ? JSON.stringify(value) : value}`);
	}
	return `${lines.join("\n")}\n`;
}

export interface ResolveMissionEnvOptions {
	/** Absolute path to the target repo (the main checkout). */
	targetCwd: string;
	/** Absolute path the worker actually operates in (worktree, or targetCwd when not using one). */
	workCwd: string;
	missionId: string;
	/** Source roots that must beat installed packages. Joined into PYTHONPATH, worktree-rooted. */
	sourceRoots: string[];
	/**
	 * Absolute `bin` dirs from the tree's own dependencies, prepended to PATH.
	 *
	 * PYTHONPATH alone is not enough: it says where to find modules, not which interpreter
	 * runs. Measured on the first real mission — `which python` in a worktree resolved to
	 * /opt/anaconda3/bin/python, an unrelated interpreter with none of the repo's deps, so two
	 * validator assertions failed for reasons that had nothing to do with the work under test.
	 * The worker survived only because it happened to reach for `pdm run`.
	 */
	binDirs?: string[];
	/** Env vars the mission overrides (e.g. a branched database). Win over the repo's env files. */
	overrides?: Record<string, string>;
	/** Base env to build on. Defaults to the daemon's process.env. */
	base?: NodeJS.ProcessEnv;
}

/**
 * The env every worker command and every assertion check runs under.
 *
 * Deliberately explicit: the daemon's ambient env is the base, but everything that
 * decides WHICH tree the command reads is set here rather than inherited.
 */
export function resolveMissionEnv(options: ResolveMissionEnvOptions): NodeJS.ProcessEnv {
	const { targetCwd, workCwd, missionId, sourceRoots, binDirs, overrides, base } = options;
	const env: NodeJS.ProcessEnv = { ...(base ?? process.env) };

	if (sourceRoots.length) {
		// Prepend, so the worktree wins over both site-packages and any ambient PYTHONPATH.
		env.PYTHONPATH = [...sourceRoots, env.PYTHONPATH].filter(Boolean).join(":");
	}

	// Point every package manager at a shared, immutable cache.
	//
	// Setting a worktree up properly means a real install per mission, which is only affordable
	// because package managers are built to resolve from a global store: pnpm hardlinks from a
	// content-addressed store, and pip/pdm/uv skip the download entirely on a cache hit. Without
	// this, six parallel missions each re-download the world. The cache is shared but append-only
	// by nature, so it does not reintroduce the shared MUTABLE state that inheriting deps had.
	const cacheRoot = join(homedir(), ".missions", "pkg-cache");
	for (const [key, sub] of [
		["PDM_CACHE_DIR", "pdm"],
		["UV_CACHE_DIR", "uv"],
		["PIP_CACHE_DIR", "pip"],
		["PNPM_STORE_DIR", "pnpm"],
		["npm_config_cache", "npm"],
		["YARN_CACHE_FOLDER", "yarn"],
	] as const) {
		if (!env[key]) env[key] = join(cacheRoot, sub);
	}

	if (binDirs?.length) {
		// Prepend for the same reason as PYTHONPATH: a bare `python`, `pytest` or `ruff` must be
		// the tree's own, not whatever the daemon's shell happened to have first on PATH.
		const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
		env[pathKey] = [...binDirs, env[pathKey]].filter(Boolean).join(":");
	}

	// Markers, so a command (or a human reading a log) can tell which tree it is in.
	env.MISSIONS_MISSION_ID = missionId;
	env.MISSIONS_WORKTREE = workCwd;
	env.MISSIONS_TARGET_REPO = targetCwd;

	for (const [key, value] of Object.entries(overrides ?? {})) env[key] = value;
	return env;
}
