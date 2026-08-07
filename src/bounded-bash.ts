/**
 * A bash tool that cannot hang forever.
 *
 * `createBashTool`'s `timeout` is a field the MODEL can set per call — it never
 * has to, and twice in one afternoon the chief ran a bare `find ~ ...` that
 * hit a macOS Full Disk Access prompt with nobody there to answer it. Nothing
 * times out on its own, so the command sat forever and blocked the chief's
 * whole turn (and every message queued behind it) until a human noticed and
 * killed the process by hand.
 *
 * This wraps the local exec backend and fills in a default timeout whenever
 * the model didn't ask for one, so "stuck" turns into "reported as stuck."
 */
import { createBashTool, createLocalBashOperations, type BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "./pi.js";

// The underlying exec's `timeout` is in SECONDS (it gets multiplied by 1000
// internally) — passing milliseconds here was the bug that let this go
// unnoticed: 120_000 was read as 120,000 seconds (~33 hours), well under the
// library's cap, so it silently accepted the value and never actually fired.
const DEFAULT_TIMEOUT_SECONDS = 120;

// biome-ignore lint/suspicious/noExplicitAny: the bash tool's schema type isn't portable across this package boundary
export function createBoundedBashTool(cwd: string, options: BashToolOptions = {}): AgentTool<any> {
	const base = options.operations ?? createLocalBashOperations();
	return createBashTool(cwd, {
		...options,
		operations: {
			...base,
			exec: (command, execCwd, execOptions) =>
				base.exec(command, execCwd, { ...execOptions, timeout: execOptions.timeout ?? DEFAULT_TIMEOUT_SECONDS }),
		},
	});
}
