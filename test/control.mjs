/**
 * Tests for the two pure surfaces the control TUI regressed on: composing a
 * frame (where a long message used to be silently truncated) and resolving a
 * repo name to a path (where guessing wrong dispatches a mission into the
 * wrong tree).
 *
 * MISSIONS_HOME is set before any import so the workspace registry writes into
 * a scratch directory instead of the live one.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "missions-test-"));
const REPOS = mkdtempSync(join(tmpdir(), "missions-repos-"));
process.env.MISSIONS_HOME = HOME;

const { composeControlFrame } = await import("../dist/control.js");
const { registerWorkspace, resolveWorkspace, listWorkspaces } = await import("../dist/workspaces.js");

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// Frame composition
// ---------------------------------------------------------------------------

const BASE = {
	width: 80,
	height: 14,
	transcript: "chief hi",
	items: [],
	selected: 0,
	mode: "chat",
	buffer: "",
	toast: "",
	busy: "",
	spin: 0,
	targetCwd: "/tmp/repo",
	now: 0,
	showRepo: false,
};

const LONG = "please look at the missions repo and tell me why the board filter is dropping cleared records, then fix it";

check("every row is the same visible width", () => {
	for (const buffer of ["", "hi", LONG]) {
		const { rows } = composeControlFrame({ ...BASE, buffer });
		const widths = new Set(rows.map((r) => plain(r).length));
		assert(widths.size === 1, `ragged frame for buffer len ${buffer.length}: widths ${[...widths]}`);
	}
});

check("a long message wraps instead of being truncated", () => {
	const { rows } = composeControlFrame({ ...BASE, buffer: LONG });
	const body = rows.map((r) => plain(r)).join("\n");
	// Every word must survive somewhere in the frame.
	for (const word of ["please", "dropping", "cleared", "records,", "fix", "it"]) {
		assert(body.includes(word), `lost "${word}" — composer truncated`);
	}
});

check("the cursor lands after the last character typed", () => {
	const { cursorRow, cursorCol, rows } = composeControlFrame({ ...BASE, buffer: LONG });
	// Body rows start at terminal row 2; the composer's last line is the last body row.
	const lastBody = plain(rows[cursorRow - 1] ?? "");
	assert(cursorRow === rows.length - 1, `cursor row ${cursorRow} is not the last body row of ${rows.length}`);
	// Column is 1-based; the character before the cursor is the last one typed.
	assert(lastBody[cursorCol - 2] === LONG.at(-1), `expected "${LONG.at(-1)}" before the cursor, got "${lastBody[cursorCol - 2]}"`);
});

check("the cursor never runs past the frame", () => {
	for (const buffer of ["", "x".repeat(500)]) {
		const { rows, cursorCol } = composeControlFrame({ ...BASE, buffer });
		assert(cursorCol <= plain(rows[0]).length, `cursor at ${cursorCol} exceeds width ${plain(rows[0]).length}`);
	}
});

check("the composer stops growing before it eats the chat pane", () => {
	const { rows } = composeControlFrame({ ...BASE, buffer: "x ".repeat(2000) });
	assert(rows.length === 14, `frame grew to ${rows.length} rows for a 4000-char buffer`);
});

check("board rows carry the repo once more than one is in play", () => {
	const rec = (id, repoName, goal) => ({
		kind: "review",
		rec: { id, repo: `/tmp/${repoName}`, repoName, goal, status: "succeeded", done: true, costUsd: 0.1, startedAt: "", updatedAt: "", lastActivity: "", outcome: "clean" },
	});
	const items = [rec("a", "nadine", "fix captions"), rec("b", "missions", "fix board filter")];
	const off = plain(composeControlFrame({ ...BASE, width: 120, items, showRepo: false }).rows.join("\n"));
	const on = plain(composeControlFrame({ ...BASE, width: 120, items, showRepo: true }).rows.join("\n"));
	assert(!off.includes("nadine"), "repo tagged when showRepo is false");
	assert(on.includes("nadine") && on.includes("missions"), "repo missing when showRepo is true");
});

// ---------------------------------------------------------------------------
// Workspace resolution — a wrong answer here dispatches into the wrong repo
// ---------------------------------------------------------------------------

for (const name of ["nadine", "missions", "naomi-site"]) mkdirSync(join(REPOS, name), { recursive: true });
const path = (n) => join(REPOS, n);
for (const name of ["nadine", "missions", "naomi-site"]) registerWorkspace(path(name));

check("registration is idempotent", () => {
	registerWorkspace(path("nadine"));
	const hits = listWorkspaces().filter((w) => w.name === "nadine");
	assert(hits.length === 1, `nadine registered ${hits.length} times`);
});

check("an omitted repo falls back to the caller's focus", () => {
	assert(resolveWorkspace(undefined, path("missions"))?.path === path("missions"), "fallback ignored");
	assert(resolveWorkspace("  ", path("missions"))?.path === path("missions"), "blank ref did not fall back");
});

check("an exact name resolves", () => {
	assert(resolveWorkspace("nadine", path("missions"))?.path === path("nadine"), "exact name missed");
	assert(resolveWorkspace("NADINE", path("missions"))?.path === path("nadine"), "name match is case-sensitive");
});

check("a unique fragment resolves", () => {
	assert(resolveWorkspace("naomi", path("missions"))?.path === path("naomi-site"), "unique fragment missed");
});

check("an ambiguous fragment refuses rather than guessing", () => {
	// "na" matches both nadine and naomi-site.
	assert(resolveWorkspace("na", path("missions")) === undefined, "ambiguous fragment resolved anyway");
});

check("an unregistered real path is adopted", () => {
	mkdirSync(join(REPOS, "fresh"), { recursive: true });
	const got = resolveWorkspace(path("fresh"), path("missions"));
	assert(got?.path === path("fresh"), "real path not adopted");
	assert(listWorkspaces().some((w) => w.name === "fresh"), "adopted path was not registered");
});

check("a path that does not exist resolves to nothing", () => {
	assert(resolveWorkspace(join(REPOS, "no-such-repo"), path("missions")) === undefined, "invented a workspace");
});

rmSync(HOME, { recursive: true, force: true });
rmSync(REPOS, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
