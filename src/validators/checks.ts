import { spawnSync } from "node:child_process";
import type { CheckResult } from "../types.js";

/** Exit code we report for a command the harness refused to run. Distinct from any real failure. */
export const REFUSED_EXIT_CODE = 126;

export interface RunCheckOptions {
	/** Where the command runs — the mission's worktree. */
	cwd: string;
	command: string;
	expectedExitCode?: number;
	/** The mission env (worktree-rooted PYTHONPATH, mission markers, any overrides). */
	env?: NodeJS.ProcessEnv;
	/**
	 * Absolute path of the MAIN checkout. When cwd is a worktree, any command that reaches
	 * back into it is refused rather than run.
	 */
	foreignRoot?: string;
}

/**
 * Run one assertion command in the mission's worktree.
 *
 * The guard exists because this already bit us. The orchestrator was handed the main repo path
 * and wrote assertions like `cd /Users/elijahahmad/nadine && gh run list …`; those ran happily
 * and validated the MAIN checkout, so a mission scored itself against code its worker had never
 * touched. A refused assertion is a visible failure; a silently misdirected one is worse than
 * having no assertion at all.
 */
export function runCheck(options: RunCheckOptions): CheckResult {
	const { cwd, command, expectedExitCode = 0, env, foreignRoot } = options;

	const escape = detectForeignPath(command, cwd, foreignRoot);
	if (escape) {
		return {
			command,
			exitCode: REFUSED_EXIT_CODE,
			passed: false,
			output: `REFUSED by the harness: this command reaches outside the mission worktree (${escape}).\nIt would validate the main checkout instead of this mission's work. Assertions must use paths relative to the worktree.`,
		};
	}

	// Deliberately `-c`, not `-lc`: a login shell sources the user's profile, so an assertion's
	// environment would differ from the worker's and drift with whatever is in ~/.zshrc.
	const res = spawnSync("bash", ["-c", command], {
		cwd,
		env: env ?? process.env,
		encoding: "utf-8",
		timeout: 300_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	const exitCode = res.status ?? (res.error ? 127 : 1);
	const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-4000);
	return { command, exitCode, passed: exitCode === expectedExitCode, output };
}

/**
 * Does this command reference the main checkout rather than the worktree?
 *
 * The worktree path contains the repo path as a prefix (<repo>/.missions/worktrees/<id>), so
 * mentions of the worktree are removed first — what remains is a genuine reach into the main tree.
 */
function detectForeignPath(command: string, cwd: string, foreignRoot?: string): string | null {
	if (!foreignRoot || cwd === foreignRoot) return null;
	const withoutWorktree = command.split(cwd).join("");
	return withoutWorktree.includes(foreignRoot) ? foreignRoot : null;
}
