import { spawn } from "node:child_process";
import type { AssertionStrength, CheckResult } from "../types.js";

const CHECK_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

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
export function runCheck(options: RunCheckOptions): Promise<CheckResult> {
	const { cwd, command, expectedExitCode = 0, env, foreignRoot } = options;

	const escape = detectForeignPath(command, cwd, foreignRoot);
	if (escape) {
		return Promise.resolve({
			command,
			exitCode: REFUSED_EXIT_CODE,
			passed: false,
			output: `REFUSED by the harness: this command reaches outside the mission worktree (${escape}).\nIt would validate the main checkout instead of this mission's work. Assertions must use paths relative to the worktree.`,
		});
	}

	return new Promise((resolve) => {
		// Deliberately `-c`, not `-lc`: a login shell sources the user's profile, so an assertion's
		// environment would differ from the worker's and drift with whatever is in ~/.zshrc.
		//
		// `detached: true` makes bash the leader of its own process group instead of sharing ours.
		// That's what makes the timeout below actually work: assertions that launch a browser
		// (Playwright/Chromium) can leave orphaned utility/gpu/renderer helper processes behind
		// that inherit bash's stdout/stderr pipes and keep them open even after bash exits. A plain
		// `spawnSync(..., {timeout})` only ever signals the immediate bash pid — those orphans keep
		// the pipe alive and the synchronous read blocks forever, so the stated timeout never fires.
		// Killing the whole *group* (`-child.pid`) reaps the orphans along with bash, which is what
		// actually closes the pipe.
		const child = spawn("bash", ["-c", command], {
			cwd,
			env: env ?? process.env,
			detached: true,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* group already gone */
				}
			}
			settle(null, true);
		}, CHECK_TIMEOUT_MS);

		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString("utf-8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString("utf-8");
		});

		function settle(status: number | null, timedOut: boolean): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const exitCode = timedOut ? 124 : (status ?? 1);
			const output = `${stdout}${stderr}`.trim().slice(-4000);
			resolve({ command, exitCode, passed: exitCode === expectedExitCode, output });
		}

		child.on("exit", (code) => settle(code, false));
		child.on("error", () => settle(127, false));
	});
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

/**
 * Pure filesystem-inspection commands: these only READ the filesystem without executing the
 * feature under test. A bash-command assertion whose entire command string is composed only of
 * these tools can only prove existence, not behaviour.
 */
const FILESYSTEM_ONLY_COMMANDS = new Set([
	"test", "ls", "stat", "find", "grep", "cat", "head", "tail", "wc", "[",
	"echo", "printf", "true", "false", ":",
]);

/**
 * Tokenise a shell command string into individual program invocations.
 *
 * Splits on shell operators (&&, ||, |, ;, &&) and parentheses, then extracts the
 * first token (the command name) of each pipeline segment.
 * This is heuristic and intentionally conservative: if any token looks like it might
 * execute something, we return false.
 */
function commandTokens(command: string): string[] {
	// Collapse backslash-newline line continuations before any other processing
	const continued = command.replace(/\\\n/g, " ");
	// Strip quoted strings (they're arguments, not commands)
	const stripped = continued.replace(/'[^']*'|"[^"]*"/g, "''");
	// Split on shell control operators
	const segments = stripped.split(/[;&|(){}\n]+/);
	return segments
		.map((seg) => seg.trim())
		.filter((seg) => seg.length > 0)
		.map((seg) => {
			// Handle `env VAR=val cmd`, bare `env`, and `! cmd` negation
			const tokens = seg.split(/\s+/);
			let idx = 0;
			while (idx < tokens.length) {
				const t = tokens[idx];
				if (!t || t === "!") { idx++; continue; }
				// Skip a leading `env` token, then consume any following VAR=value assignments
				if (t === "env") { idx++; continue; }
				// Skip `VAR=value` assignments
				if (/^[A-Z_][A-Z0-9_]*=/.test(t)) { idx++; continue; }
				return t;
			}
			return "";
		})
		.filter((t) => t.length > 0);
}

/**
 * Classify the strength of a bash-command assertion's command string.
 *
 * Rules:
 * - If every invocation in the command is a pure filesystem-inspection tool
 *   (test, ls, stat, find, grep, cat, head, wc, `[`, etc.), returns 'existence'.
 * - Otherwise returns 'behavioural'.
 *
 * This function is used to downgrade declared 'behavioural' assertions; it never upgrades.
 * Non-bash assertions should not be passed here (they keep their declared strength).
 */
export function classifyCommandStrength(command: string): AssertionStrength {
	const tokens = commandTokens(command);
	if (tokens.length === 0) return "existence";
	const allFilesystem = tokens.every((t) => {
		// Strip path prefix (e.g. /usr/bin/test -> test)
		const base = t.includes("/") ? t.split("/").pop() ?? t : t;
		return FILESYSTEM_ONLY_COMMANDS.has(base);
	});
	return allFilesystem ? "existence" : "behavioural";
}

/**
 * Annotate a CLEAN verdict with an existence-only warning when no behavioural assertions passed.
 *
 * Rules:
 * - If the verdict is not CLEAN (i.e. not "passed"), return it unchanged.
 * - If at least one 'behavioural' assertion passed, return "CLEAN" unchanged.
 * - If every passed assertion was existence/review/unclassified, append the annotation.
 *
 * @param verdictStr - The raw verdict string (e.g. "CLEAN" or "NEEDS YOU (stalled)").
 * @param scoreCard - The ScoreCard with strengthBreakdown.
 * @returns The verdict string, possibly annotated.
 */
export function annotateVerdict(
	verdictStr: string,
	scoreCard: { strengthBreakdown?: { behavioural?: { passed: number; total: number }; existence?: { passed: number; total: number }; review?: { passed: number; total: number }; unclassified?: { passed: number; total: number } } } | undefined,
): string {
	if (!verdictStr.startsWith("CLEAN")) return verdictStr;
	const breakdown = scoreCard?.strengthBreakdown;
	const behaviouralPassed = breakdown?.behavioural?.passed ?? 0;
	// Sum total across every strength bucket to get the contract total
	const contractTotal =
		(breakdown?.behavioural?.total ?? 0) +
		(breakdown?.existence?.total ?? 0) +
		(breakdown?.review?.total ?? 0) +
		(breakdown?.unclassified?.total ?? 0);
	if (behaviouralPassed === 0) {
		return `${verdictStr} (existence-only — no assertion executed the feature)`;
	}
	if (behaviouralPassed < contractTotal) {
		return `${verdictStr} (${behaviouralPassed} of ${contractTotal} assertions executed the feature)`;
	}
	return verdictStr;
}

/**
 * Apply strength classification to a check result.
 *
 * Given the declared strength of an assertion and the command that was run, determines the
 * effective strength and records a correction if needed. Never upgrades strength.
 *
 * @param result - The CheckResult to annotate in-place.
 * @param declaredStrength - The strength declared in the assertion schema (may be undefined).
 * @returns The effective strength.
 */
export function applyStrengthClassification(
	result: CheckResult,
	declaredStrength: AssertionStrength | undefined,
): AssertionStrength | undefined {
	if (declaredStrength === undefined) return undefined;

	// code-review and non-bash assertions keep their declared strength
	// (caller is responsible for not passing these for bash commands)
	if (declaredStrength !== "behavioural") {
		result.declaredStrength = declaredStrength;
		result.effectiveStrength = declaredStrength;
		return declaredStrength;
	}

	// For declared 'behavioural': check whether the command is filesystem-only
	const classified = classifyCommandStrength(result.command);
	result.declaredStrength = "behavioural";
	if (classified === "existence") {
		// Downgrade
		result.effectiveStrength = "existence";
		result.strengthCorrected = true;
	} else {
		// Stays behavioural
		result.effectiveStrength = "behavioural";
	}
	return result.effectiveStrength;
}
