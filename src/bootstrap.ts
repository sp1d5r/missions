import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnvFile, serializeEnvFile } from "./env.js";
import type { WorktreeBootstrapSpec } from "./target/types.js";

export interface BootstrapResult {
	/** Env files copied in, repo-relative. */
	envFiles: string[];
	/** Dependency/sibling dirs symlinked in, repo-relative. */
	linkedDirs: string[];
	/** Absolute, worktree-rooted source roots for PYTHONPATH. */
	sourceRoots: string[];
	/**
	 * Everything the harness placed here, repo-relative, to be kept out of commits.
	 * A repo's .gitignore is not enough: directory-only patterns (`node_modules/`) do not
	 * match a symlink, so these would otherwise be staged by `git add -A`.
	 */
	gitExcludes: string[];
	/** Human-readable lines for the mission log. */
	notes: string[];
}

export interface BootstrapWorktreeOptions {
	targetCwd: string;
	workCwd: string;
	spec: WorktreeBootstrapSpec;
}

/**
 * Make a fresh worktree actually runnable.
 *
 * Without this, `git worktree add` leaves a tree with no env files, no venvs and no
 * node_modules — so a worker either spends its budget on `pdm install` or, silently,
 * resolves imports and credentials out of the main checkout instead of its own.
 */
export function bootstrapWorktree(options: BootstrapWorktreeOptions): BootstrapResult {
	const { targetCwd, workCwd, spec } = options;
	const result: BootstrapResult = { envFiles: [], linkedDirs: [], sourceRoots: [], gitExcludes: [], notes: [] };

	for (const rel of spec.envFiles) {
		const from = join(targetCwd, rel);
		const to = join(workCwd, rel);
		if (!existsSync(from)) continue;
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
		result.envFiles.push(rel);
	}
	if (result.envFiles.length) result.notes.push(`env copied: ${result.envFiles.join(", ")}`);
	else result.notes.push("no env files found to copy — commands needing credentials will fail");

	for (const rel of spec.linkDirs) {
		const from = join(targetCwd, rel);
		const to = join(workCwd, rel);
		if (!existsSync(from)) continue;
		mkdirSync(dirname(to), { recursive: true });
		// A worker may have created a real dir here on a retry; only ever replace our own symlink.
		if (existsSync(to) || isSymlink(to)) {
			if (!isSymlink(to)) continue;
			unlinkSync(to);
		}
		try {
			symlinkSync(from, to, "dir");
			result.linkedDirs.push(rel);
		} catch (err) {
			result.notes.push(`could not link ${rel}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (result.linkedDirs.length) result.notes.push(`deps linked (shared, read-only): ${result.linkedDirs.join(", ")}`);

	result.sourceRoots = spec.sourceRoots.map((rel) => resolve(workCwd, rel)).filter((p) => existsSync(p));
	if (result.sourceRoots.length) result.notes.push(`PYTHONPATH rooted in worktree (${result.sourceRoots.length} roots)`);

	result.gitExcludes = [...result.envFiles, ...result.linkedDirs];
	return result;
}

/**
 * Rewrite an env file already copied into the worktree so the mission's overrides are the
 * values ON DISK.
 *
 * Injecting them into the process env is not enough: Nadine's Config calls
 * load_dotenv(override=True), so whatever is in the file beats whatever we pass down. The
 * override has to live in the file to survive.
 *
 * Called after planning, because whether a mission needs (say) a branched database is
 * something only the plan can tell us.
 */
export function applyEnvOverrides(options: {
	targetCwd: string;
	workCwd: string;
	/** Repo-relative env file to rewrite, e.g. ".env". */
	envFile: string;
	missionId: string;
	overrides: Record<string, string>;
}): boolean {
	const { targetCwd, workCwd, envFile, missionId, overrides } = options;
	const keys = Object.keys(overrides);
	if (!keys.length) return false;
	const from = join(targetCwd, envFile);
	const to = join(workCwd, envFile);
	if (!existsSync(from)) return false;
	const vars = { ...parseEnvFile(from), ...overrides };
	mkdirSync(dirname(to), { recursive: true });
	writeFileSync(
		to,
		serializeEnvFile(vars, [
			`Snapshot of ${envFile} taken for mission ${missionId}.`,
			`Overridden by the harness: ${keys.join(", ")}`,
		]),
	);
	return true;
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
