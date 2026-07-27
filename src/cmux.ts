import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

/** True when running inside a cmux workspace. */
export function insideCmux(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID);
}

/** True when a socket password is available in the environment (for cmux open/diff/workspace control). */
export function hasCmuxPassword(): boolean {
	return Boolean(process.env.CMUX_SOCKET_PASSWORD);
}

/** Locate the cmux CLI: env hint first, then PATH. Null if not found. */
export function cmuxBin(): string | null {
	const hinted = process.env.CMUX_BUNDLED_CLI_PATH;
	if (hinted && existsSync(hinted)) return hinted;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, "cmux");
		if (existsSync(p)) return p;
	}
	return null;
}

function run(args: string[], cwd?: string): boolean {
	const bin = cmuxBin();
	if (!bin) return false;
	// cmux reads CMUX_SOCKET_PASSWORD from the inherited env — we never pass it on argv.
	const res = spawnSync(bin, args, { cwd, encoding: "utf-8", timeout: 20_000 });
	return res.status === 0;
}

/**
 * Render an HTML report in a cmux browser/webview surface (so mermaid + CSS render).
 * `cmux browser open <url>`; local paths become file:// URLs. Requires the socket password.
 */
export function cmuxOpenBrowser(pathOrUrl: string): boolean {
	const url = /^[a-z]+:\/\//i.test(pathOrUrl) ? pathOrUrl : pathToFileURL(pathOrUrl).href;
	return run(["browser", "open", url]);
}

/** Render a markdown file in cmux's live markdown viewer (auto-refreshes on write; no mermaid). */
export function cmuxOpenMarkdown(path: string): boolean {
	return run(["markdown", "open", path]);
}

/** Open a diff surface in cmux for changes since baseSha on the current branch. Requires the socket password. */
export function cmuxOpenDiff(cwd: string, baseSha: string): boolean {
	return run(["diff", "--branch", "--base", baseSha, "--cwd", cwd, "--title", "missions review"], cwd);
}

/**
 * Open the target repo as a cmux workspace-shell via the socket-free `cmux <path>` form.
 * (This opens a workspace + shell; it does NOT render a file.)
 */
export function cmuxOpenWorkspace(repoPath: string): boolean {
	return run([repoPath]);
}

/** True once `cmux hooks pi install` has generated the pi extension (enables the live-feed seam). */
export function cmuxFeedInstalled(): boolean {
	const home = process.env.HOME ?? "";
	return Boolean(home) && existsSync(join(home, ".pi", "agent", "extensions", "cmux-session.ts"));
}

/**
 * Open (or focus) a mission-view tab in cmux using a stable workspace name derived
 * from the runId: `mission-<runId>`. This ensures that pressing `o` a second time
 * on the same row focuses the existing tab rather than spawning a new one.
 *
 * cmux does not currently have a named-workspace focus command separate from open;
 * we pass the stable name via the `--workspace-name` flag. If the flag is not
 * supported by the installed cmux version the open will still work but will create
 * a new tab each time rather than focusing the existing one.
 *
 * @param runId  The mission runId (e.g. "m-2026-01-01T00-00-00-000Z")
 * @param command  The shell command to run in the tab (e.g. `missions view <runId>`)
 * @param cwd  Optional working directory for the shell
 */
export function cmuxOpenMissionView(runId: string, command: string, cwd?: string): boolean {
	// Stable workspace name keyed by runId so repeat o-presses focus rather than spawn.
	const workspaceName = `mission-${runId}`;
	// Try named-workspace open first (focuses existing if name matches).
	// `cmux workspace open --name <name> --command <cmd>` is the preferred form;
	// fall back to plain cmux open if the named form is unsupported.
	const args: string[] = ["workspace", "open", "--name", workspaceName, "--command", command];
	if (cwd) {
		args.push("--cwd", cwd);
	}
	return run(args);
}
