/**
 * Tests for "is this mission actually running?"
 *
 * `!done` was the answer everywhere — the chief's greeting, the web board, the sidebar tally —
 * and it is wrong in the one case that matters. A mission whose process dies (Ctrl-C, a crashed
 * daemon, a closed laptop) never writes a terminal status, so its record sits at `working`
 * forever. Measured on a live org: three of three "running" missions had been dead for 27 to 40
 * hours, and every surface reported them as in flight while they held worktrees and branches.
 *
 * The nastier half is that a zombie is neither done nor live, so it also fell out of the "needs
 * you" queue. It was counted as healthy and was unreachable at the same time.
 */

const { isLive, isStalled, STALE_AFTER_MS } = await import("../dist/registry.js");

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

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const rec = (over = {}) => ({
	id: "m-1",
	status: "working",
	done: false,
	updatedAt: new Date(NOW - 60_000).toISOString(),
	costUsd: 0,
	...over,
});

check("a mission that just published is live", () => {
	assert(isLive(rec(), NOW), "a mission updated a minute ago was not live");
	assert(!isStalled(rec(), NOW), "a live mission was also reported stalled");
});

check("a finished mission is never live", () => {
	assert(!isLive(rec({ done: true }), NOW), "a done mission was live");
	assert(!isStalled(rec({ done: true }), NOW), "a done mission was stalled");
});

check("a mission silent for a day is stalled, not running", () => {
	// The measured case: status still says "working", nothing has touched it since yesterday.
	const zombie = rec({ updatedAt: new Date(NOW - 27 * 3600_000).toISOString() });
	assert(!isLive(zombie, NOW), "a 27-hour-old record was still counted as running");
	assert(isStalled(zombie, NOW), "a dead mission was not surfaced as stalled");
});

check("a long quiet setup step is not mistaken for death", () => {
	// A cold install can run twenty minutes and emits progress only when it finishes. Calling a
	// live mission dead is the worse error, so the window has real slack in it.
	const installing = rec({ updatedAt: new Date(NOW - 25 * 60_000).toISOString() });
	assert(isLive(installing, NOW), "a mission mid-install was declared stalled");
	assert(STALE_AFTER_MS >= 30 * 60_000, `the staleness window is only ${STALE_AFTER_MS}ms — too tight for a cold install`);
});

check("every unfinished mission is exactly one of live or stalled", () => {
	// The property that makes the counts add up: nothing may fall through both, which is how
	// zombies became invisible in the first place.
	for (const mins of [0, 5, 59, 61, 600, 5000]) {
		const r = rec({ updatedAt: new Date(NOW - mins * 60_000).toISOString() });
		assert(isLive(r, NOW) !== isStalled(r, NOW), `a record ${mins}m old was neither or both`);
	}
});

check("an unparseable timestamp is stalled, not live", () => {
	// Records are on disk and hand-editable; NaN comparisons are false, so the naive version of
	// this would have quietly reported "not live AND not stalled" and lost the mission entirely.
	const junk = rec({ updatedAt: "whenever" });
	assert(!isLive(junk, NOW), "a record with a junk timestamp was live");
	assert(isStalled(junk, NOW), "a record with a junk timestamp vanished from both counts");
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall registry tests passed");
