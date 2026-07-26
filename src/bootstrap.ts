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
	/** Human-readable lines for the mission log. */
	notes: string[];
}

export interface BootstrapWorktreeOptions {
	targetCwd: string;
	workCwd: string;
	spec: WorktreeBootstrapSpec;
	missionId: string;
	/**
	 * Vars written into the worktree's ROOT env file, beating the value copied from the
	 * main checkout. This is the only way a mission override survives: python-dotenv
	 * loads the root .env with override=True, so it wins over injected process env.
	 */
	envOverrides?: Record<string, string>;
}

/**
 * Make a fresh worktree actually runnable.
 *
 * Without this, `git worktree add` leaves a tree with no env files, no venvs and no
 * node_modules — so a worker either spends its budget on `pdm install` or, silently,
 * resolves imports and credentials out of the main checkout instead of its own.
 */
export function bootstrapWorktree(options: BootstrapWorktreeOptions): BootstrapResult {
	const { targetCwd, workCwd, spec, missionId, envOverrides } = options;
	const result: BootstrapResult = { envFiles: [], linkedDirs: [], sourceRoots: [], notes: [] };
	const rootEnvFile = spec.envFiles.find((f) => f === ".env");

	for (const rel of spec.envFiles) {
		const from = join(targetCwd, rel);
		const to = join(workCwd, rel);
		if (!existsSync(from)) continue;
		mkdirSync(dirname(to), { recursive: true });
		const overridesApply = rel === rootEnvFile && envOverrides && Object.keys(envOverrides).length > 0;
		if (overridesApply) {
			// Rewrite rather than copy, so the override is the value on disk — visible to a
			// human reading the file and immune to override=True dotenv loading.
			const vars = { ...parseEnvFile(from), ...envOverrides };
			writeFileSync(
				to,
				serializeEnvFile(vars, [
					`Snapshot of ${rel} taken for mission ${missionId}.`,
					`Overridden by the harness: ${Object.keys(envOverrides).join(", ")}`,
				]),
			);
			result.notes.push(`env ${rel} (snapshot + overrides: ${Object.keys(envOverrides).join(", ")})`);
		} else {
			copyFileSync(from, to);
		}
		result.envFiles.push(rel);
	}

	if (result.envFiles.length) {
		const plain = result.envFiles.filter((f) => !result.notes.some((n) => n.startsWith(`env ${f} `)));
		if (plain.length) result.notes.push(`env copied: ${plain.join(", ")}`);
	} else {
		result.notes.push("no env files found to copy — commands needing credentials will fail");
	}

	for (const rel of spec.linkDirs) {
		const from = join(targetCwd, rel);
		const to = join(workCwd, rel);
		if (!existsSync(from)) continue;
		mkdirSync(dirname(to), { recursive: true });
		// A worker may have created a real dir here on a retry; replace only symlinks.
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

	return result;
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
