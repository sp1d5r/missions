import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnvFile, serializeEnvFile } from "./env.js";
import type { WorktreeBootstrapSpec } from "./target/types.js";

const execFile = promisify(execFileCb);

export interface BootstrapResult {
	/** Env files copied in, repo-relative. */
	envFiles: string[];
	/** Dependency/sibling dirs symlinked in, repo-relative. */
	linkedDirs: string[];
	/** Dependency dirs cloned in (copy-on-write), repo-relative. Writable by the worker. */
	clonedDirs: string[];
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
export async function bootstrapWorktree(options: BootstrapWorktreeOptions): Promise<BootstrapResult> {
	const { targetCwd, workCwd, spec } = options;
	const result: BootstrapResult = { envFiles: [], linkedDirs: [], clonedDirs: [], sourceRoots: [], gitExcludes: [], notes: [] };

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

	// Cloned concurrently: these are independent `cp` invocations over separate trees,
	// and the walk is latency-bound rather than CPU-bound. Serially, nadine's five
	// node_modules cost ~115s of every mission's wall clock; together they cost roughly
	// the slowest one.
	const toClone = (spec.cloneDirs ?? []).filter((rel) => {
		const to = join(workCwd, rel);
		if (!existsSync(join(targetCwd, rel))) return false;
		// Same rule as linking: only ever replace our own symlink, never a worker's real dir.
		if (existsSync(to) || isSymlink(to)) {
			if (!isSymlink(to)) return false;
			unlinkSync(to);
		}
		mkdirSync(dirname(to), { recursive: true });
		return true;
	});
	const cloned = await Promise.all(toClone.map(async (rel) => ({ rel, how: await cloneDir(join(targetCwd, rel), join(workCwd, rel)) })));
	for (const { rel, how } of cloned) {
		if (how === "cloned") {
			result.clonedDirs.push(rel);
		} else if (how === "linked") {
			result.linkedDirs.push(rel);
			result.notes.push(`${rel}: filesystem cannot clone — symlinked instead, so DO NOT install into it`);
		} else {
			result.notes.push(`could not provide ${rel}`);
		}
	}
	if (result.clonedDirs.length) result.notes.push(`deps cloned (private to this worktree, safe to install into): ${result.clonedDirs.join(", ")}`);

	result.sourceRoots = spec.sourceRoots.map((rel) => resolve(workCwd, rel)).filter((p) => existsSync(p));
	if (result.sourceRoots.length) result.notes.push(`PYTHONPATH rooted in worktree (${result.sourceRoots.length} roots)`);

	result.gitExcludes = [...result.envFiles, ...result.linkedDirs, ...result.clonedDirs];
	return result;
}

/**
 * Copy a directory copy-on-write, so it costs the delta rather than the content.
 *
 * `cp -c` (macOS/APFS) and `cp --reflink` (btrfs/XFS) both share the underlying
 * blocks until something writes, which is exactly the shape of a dependency tree
 * a worker mostly reads and occasionally installs into. Both fail loudly on a
 * filesystem without the feature rather than silently falling back to a real
 * copy — which is why the fallback here is a symlink, not `cp -R`: a genuine
 * multi-gigabyte copy per mission is worse than sharing.
 */
async function cloneDir(from: string, to: string): Promise<"cloned" | "linked" | "failed"> {
	const attempts =
		process.platform === "darwin"
			? [["-Rc", from, to]]
			: [
					["-R", "--reflink=always", from, to],
					["-a", "--reflink=always", from, to],
				];
	for (const args of attempts) {
		try {
			await execFile("cp", args, { timeout: 10 * 60_000 });
			return "cloned";
		} catch {
			// Clean up a partial copy before trying the next strategy.
			try {
				rmSync(to, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
	try {
		symlinkSync(from, to, "dir");
		return "linked";
	} catch {
		return "failed";
	}
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
