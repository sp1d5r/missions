import { spawnSync } from "node:child_process";
import type { CheckResult } from "../types.js";

/** Run a shell command in the target repo and capture exit code + trimmed output. */
export function runCheck(cwd: string, command: string, expectedExitCode = 0): CheckResult {
	const res = spawnSync("bash", ["-lc", command], {
		cwd,
		encoding: "utf-8",
		timeout: 300_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	const exitCode = res.status ?? (res.error ? 127 : 1);
	const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-4000);
	return { command, exitCode, passed: exitCode === expectedExitCode, output };
}
