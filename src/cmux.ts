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
