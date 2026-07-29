/**
 * Tests for isHarnessStale(daemonStartMs, buildMtimeMs).
 *
 * Pure function of two timestamps:
 *  - newer build (buildMtimeMs > daemonStartMs) → warns (returns true)
 *  - equal build (buildMtimeMs === daemonStartMs) → does not warn (returns false)
 *  - older build (buildMtimeMs < daemonStartMs) → does not warn (returns false)
 *
 * Follows the same convention as other test files:
 *  - import from dist/
 *  - hand-rolled check() / assert() helpers
 *  - exit 0 on all pass, exit 1 on any failure
 */

import { isHarnessStale } from "../dist/mission.js";

let failures = 0;

function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}: ${err.message}`);
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg ?? "assertion failed");
}

// ---------------------------------------------------------------------------
// Newer build → warns (true)
// ---------------------------------------------------------------------------

check("newer build (buildMtimeMs > daemonStartMs) → true", () => {
	const daemonStartMs = 1_000_000;
	const buildMtimeMs = 1_000_001;  // 1ms newer
	assert(isHarnessStale(daemonStartMs, buildMtimeMs) === true,
		"should return true when build is newer than daemon start");
});

check("much newer build → true", () => {
	const daemonStartMs = 1_000_000;
	const buildMtimeMs = 2_000_000;  // 1000s newer
	assert(isHarnessStale(daemonStartMs, buildMtimeMs) === true,
		"should return true for a much newer build");
});

check("build just 1ms newer → true", () => {
	const now = Date.now();
	assert(isHarnessStale(now - 1, now) === true,
		"build 1ms after daemon start should be considered stale");
});

// ---------------------------------------------------------------------------
// Equal timestamps → does not warn (false)
// ---------------------------------------------------------------------------

check("equal timestamps → false", () => {
	const ts = 1_500_000;
	assert(isHarnessStale(ts, ts) === false,
		"equal timestamps should not be considered stale");
});

check("equal large timestamps → false", () => {
	const ts = Date.now();
	assert(isHarnessStale(ts, ts) === false,
		"equal current timestamps should not be stale");
});

// ---------------------------------------------------------------------------
// Older build → does not warn (false)
// ---------------------------------------------------------------------------

check("older build (buildMtimeMs < daemonStartMs) → false", () => {
	const daemonStartMs = 1_000_001;
	const buildMtimeMs = 1_000_000;  // 1ms older
	assert(isHarnessStale(daemonStartMs, buildMtimeMs) === false,
		"should return false when build is older than daemon start");
});

check("much older build → false", () => {
	const daemonStartMs = 2_000_000;
	const buildMtimeMs = 1_000_000;  // 1000s older
	assert(isHarnessStale(daemonStartMs, buildMtimeMs) === false,
		"should return false for a much older build");
});

check("build from before epoch (0) with daemon at 1 → false", () => {
	assert(isHarnessStale(1, 0) === false,
		"build at 0ms with daemon at 1ms should not be stale");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

check("both zero → false", () => {
	assert(isHarnessStale(0, 0) === false,
		"both zero should not be stale");
});

check("both at max safe integer → false", () => {
	const max = Number.MAX_SAFE_INTEGER;
	assert(isHarnessStale(max, max) === false,
		"equal max integers should not be stale");
});

check("returns boolean (not truthy/falsy object)", () => {
	const newer = isHarnessStale(1000, 2000);
	const older = isHarnessStale(2000, 1000);
	assert(typeof newer === "boolean", `newer case should return boolean, got ${typeof newer}`);
	assert(typeof older === "boolean", `older case should return boolean, got ${typeof older}`);
});

check("is a pure function — same inputs always same output", () => {
	const d = 1_234_567;
	const b = 2_345_678;
	const r1 = isHarnessStale(d, b);
	const r2 = isHarnessStale(d, b);
	const r3 = isHarnessStale(d, b);
	assert(r1 === r2 && r2 === r3, "pure function must return the same value for same inputs");
	assert(r1 === true, "newer build should still be true");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
