/**
 * Tests for standing orders, concentrated on the ledger.
 *
 * The ledger is what stops a daily job from re-reporting its back catalogue
 * every morning, so it has exactly two ways to fail and both are silent:
 * reporting the same thing twice (you stop reading), or marking something
 * reported that never reached you (you never hear it, ever).
 *
 * The second is the one a bugbash routine found in this very file's runner —
 * the ledger was committed before the board write — so it is tested first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "missions-routines-"));
process.env.MISSIONS_HOME = HOME;

const { partitionSeen, commitSeen, clearLedger, ledgerSize, fingerprint, isDue, saveRoutine, listRoutines, removeRoutine } = await import("../dist/routines.js");

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

const finding = (title, goal) => ({ fingerprint: fingerprint("/tmp/repo", title), title, detail: "d", goal: goal ?? title, source: "test" });

// ---------------------------------------------------------------------------
// The read/commit split
// ---------------------------------------------------------------------------

check("partitioning does NOT mark anything seen", () => {
	// The bug this replaced: a finding recorded as delivered before it was.
	// If the board write then failed, it was silenced permanently.
	const before = ledgerSize();
	partitionSeen([finding("a defect in foo.ts")]);
	assert(ledgerSize() === before, "partitionSeen wrote to the ledger");
});

check("a finding is suppressed only after it is committed", () => {
	const f = finding("bar.ts leaks a listener");
	assert(partitionSeen([f]).fresh.length === 1, "fresh finding was suppressed before delivery");
	commitSeen([f], "r1");
	assert(partitionSeen([f]).fresh.length === 0, "committed finding surfaced again");
	assert(partitionSeen([f]).repeats === 1, "not counted as a repeat");
});

check("an interrupted run leaves the finding reportable", () => {
	// Simulates: partition succeeded, the board write threw, the process died.
	const f = finding("baz.ts swallows an error");
	partitionSeen([f]);
	// no commitSeen — delivery failed
	assert(partitionSeen([f]).fresh.length === 1, "finding was lost — this is the silent-forever bug");
});

check("committing twice is harmless", () => {
	const f = finding("qux.ts races on a file");
	commitSeen([f], "r1");
	const size = ledgerSize();
	commitSeen([f], "r1");
	assert(ledgerSize() === size, "duplicate commit grew the ledger");
});

// ---------------------------------------------------------------------------
// Fingerprinting — the same defect worded differently must collapse
// ---------------------------------------------------------------------------

check("ordinary run-to-run variation collapses", () => {
	// A model asked twice never writes it the same way. Word order, filler and
	// plural/tense are what actually vary between two runs of the same prompt.
	const a = fingerprint("/tmp/repo", "The parser silently returns an empty array when it fails");
	const b = fingerprint("/tmp/repo", "parser silently return empty arrays and it failed");
	assert(a === b, `same defect reworded produced different fingerprints`);
});

check("normalisation stops short of merging distinct findings", () => {
	// The asymmetry is on purpose: an escaped duplicate is visible noise, but
	// over-collapsing suppresses a NEW finding forever and you never learn it existed.
	const a = fingerprint("/tmp/repo", "worker writes state before the commit succeeds");
	const b = fingerprint("/tmp/repo", "worker writes state after the commit fails");
	assert(a !== b, "two different defects collapsed to one fingerprint");
});

check("genuinely different findings stay different", () => {
	const a = fingerprint("/tmp/repo", "parser returns empty array on failure");
	const b = fingerprint("/tmp/repo", "worktree removal follows symlinks into the main checkout");
	assert(a !== b, "unrelated findings collided");
});

check("the same wording in a different repo is a different finding", () => {
	assert(fingerprint("/a/alpha", "unhandled rejection in the runner") !== fingerprint("/b/beta", "unhandled rejection in the runner"), "fingerprints collided across repos");
});

check("forgetting a routine's findings lets them resurface", () => {
	const f = finding("something worth re-raising");
	commitSeen([f], "r-forget");
	assert(partitionSeen([f]).fresh.length === 0, "not suppressed to begin with");
	clearLedger("r-forget");
	assert(partitionSeen([f]).fresh.length === 1, "clearLedger did not release the finding");
});

check("forgetting one routine leaves the others alone", () => {
	const mine = finding("belongs to r-keep");
	commitSeen([mine], "r-keep");
	commitSeen([finding("belongs to r-drop")], "r-drop");
	clearLedger("r-drop");
	assert(partitionSeen([mine]).fresh.length === 0, "cleared a routine that was not named");
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const routine = (over = {}) => ({ id: "r", kind: "plan", repo: "/tmp/repo", everyMinutes: 60, autonomy: "propose", enabled: true, maxUsd: 1, ...over });

check("a routine that has never run is due", () => {
	assert(isDue(routine()), "never-run routine was not due");
});

check("a disabled routine is never due", () => {
	assert(!isDue(routine({ enabled: false })), "disabled routine was due");
	assert(!isDue(routine({ enabled: false, lastRunAt: undefined })), "disabled never-run routine was due");
});

check("a routine is not due again until its interval has passed", () => {
	const now = Date.now();
	const justRan = routine({ lastRunAt: new Date(now - 5 * 60_000).toISOString() });
	assert(!isDue(justRan, now), "ran 5 minutes ago on a 60-minute interval, still due");
	assert(isDue(routine({ lastRunAt: new Date(now - 61 * 60_000).toISOString() }), now), "past its interval and not due");
});

check("a corrupt lastRunAt does not wedge a routine forever", () => {
	assert(isDue(routine({ lastRunAt: "not a date" })), "unparseable timestamp made the routine permanently not-due");
});

check("routines round-trip through storage", () => {
	saveRoutine(routine({ id: "rt-1" }));
	saveRoutine(routine({ id: "rt-2", kind: "bugbash" }));
	assert(listRoutines().filter((r) => r.id.startsWith("rt-")).length === 2, "did not store both");
	saveRoutine(routine({ id: "rt-1", everyMinutes: 999 }));
	assert(listRoutines().filter((r) => r.id === "rt-1").length === 1, "saving an existing id duplicated it");
	assert(listRoutines().find((r) => r.id === "rt-1").everyMinutes === 999, "update did not take");
	assert(removeRoutine("rt-2"), "remove reported nothing removed");
	assert(!removeRoutine("rt-nope"), "removing a missing routine claimed success");
});

rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
