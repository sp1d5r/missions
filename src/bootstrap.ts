import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnvFile, serializeEnvFile } from "./env.js";
import { discoverEnvFiles } from "./target/generic.js";

/**
 * Put into a fresh worktree the one thing that cannot be installed: secrets.
 *
 * This used to link and clone dependency trees from the main checkout. That is now the setup
 * stage's job (setup.ts), and doing it properly matters — inheriting an install meant a mission
 * that changed a lockfile could never test its own change, and shared mutable venvs forced a
 * doctrine rule ("never install into these") that only existed to paper over the shortcut.
 *
 * Env files are different. They are gitignored, so `git worktree add` never carries them, and no
 * install can recreate them. Copying, not symlinking, is deliberate: Nadine's Config loads .env
 * with `override=True`, so a shared file would beat any value the harness injects — a mission's
 * database override has to be the value ON DISK to survive.
 */

export interface BootstrapResult {
	/** Env files copied in, repo-relative. */
	envFiles: string[];
	/**
	 * Paths the harness placed here, to be kept out of commits. A repo's .gitignore is not
	 * enough on its own: directory-only patterns (`node_modules/`) do not match a symlink, and
	 * an env file copied in is not necessarily ignored in every repo.
	 */
	gitExcludes: string[];
	/** Human-readable lines for the mission log. */
	notes: string[];
}

export interface BootstrapWorktreeOptions {
	targetCwd: string;
	workCwd: string;
	/** Override the discovered set. Omit to discover gitignored `.env*` files. */
	envFiles?: string[];
}

export function bootstrapWorktree(options: BootstrapWorktreeOptions): BootstrapResult {
	const { targetCwd, workCwd } = options;
	const result: BootstrapResult = { envFiles: [], gitExcludes: [], notes: [] };
	const wanted = options.envFiles ?? discoverEnvFiles(targetCwd);

	for (const rel of wanted) {
		const from = join(targetCwd, rel);
		const to = join(workCwd, rel);
		if (!existsSync(from)) continue;
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
		result.envFiles.push(rel);
	}

	if (result.envFiles.length) result.notes.push(`env copied: ${result.envFiles.join(", ")}`);
	else result.notes.push("no gitignored env files found — commands needing credentials will fail");

	result.gitExcludes = [...result.envFiles];
	return result;
}

/**
 * Rewrite an env file already copied into the worktree so the mission's overrides are the values
 * ON DISK.
 *
 * Injecting them into the process env is not enough: Nadine's Config calls
 * load_dotenv(override=True), so whatever is in the file beats whatever we pass down. The
 * override has to live in the file to survive.
 *
 * Called after planning, because whether a mission needs (say) a branched database is something
 * only the plan can tell us.
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
