/**
 * Tests for who posted what, and what hangs under it.
 *
 * The timeline is the mission's readable surface, so the properties worth pinning are about
 * legibility rather than data shape: a mission recorded before attribution existed must still
 * render sensibly, a run of forty passing assertions must not outweigh the verdict above it, and
 * an error must never be swallowed into someone else's run of messages.
 */

const { seatOf, groupTimeline, SEATS, SEAT_ORDER } = await import("../dist/seats.js");

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

const ev = (kind, label, extra = {}) => ({ at: "2026-07-29T10:00:00.000Z", kind, label, ...extra });

// ── Attribution ─────────────────────────────────────────────────────────────────────

check("a recorded seat wins over inference", () => {
	// The whole point of recording it: the emitter knows, the guess does not.
	assert(seatOf(ev("validation_result", "x", { seat: "lead" })) === "lead", "inference overrode a recorded seat");
});

check("events written before the field still get a seat", () => {
	assert(seatOf(ev("tool_call", "worker: F1")) === "eng", "tool_call was not attributed to eng");
	assert(seatOf(ev("validation_result", "validated")) === "qa", "validation_result was not attributed to qa");
	assert(seatOf(ev("milestone_verdict", "milestone 1")) === "lead", "milestone_verdict was not attributed to lead");
});

check("an unknown kind falls back to the harness, not to a guess", () => {
	assert(seatOf(ev("lifecycle", "committed")) === "system", "lifecycle was not attributed to system");
	assert(seatOf(ev("error", "boom")) === "system", "error was not attributed to system");
});

check("a bogus recorded seat does not leak through", () => {
	// State files are on disk and hand-editable; an unknown seat would index SEATS as undefined
	// and take the whole page down.
	const seat = seatOf(ev("tool_call", "x", { seat: "wizard" }));
	assert(seat in SEATS, `returned ${seat}, which has no entry in SEATS`);
});

check("every seat in the order has an entry, and vice versa", () => {
	for (const s of SEAT_ORDER) assert(SEATS[s], `${s} is ordered but has no entry`);
	for (const s of Object.keys(SEATS)) assert(SEAT_ORDER.includes(s), `${s} has an entry but no place in the order`);
});

// ── Threading ───────────────────────────────────────────────────────────────────────

check("a recorded thread hangs its details off the first event", () => {
	const groups = groupTimeline([
		ev("validation_result", "validated: 1/2 assertions passed", { thread: "v1" }),
		ev("validation_result", "✓ A1", { thread: "v1" }),
		ev("validation_result", "✗ A2", { thread: "v1" }),
	]);
	assert(groups.length === 1, `expected one group, got ${groups.length}`);
	assert(groups[0].parent.label.startsWith("validated:"), "the summary was not the parent");
	assert(groups[0].children.length === 2, `expected 2 replies, got ${groups[0].children.length}`);
});

check("two milestones' validations are separate threads", () => {
	const groups = groupTimeline([
		ev("validation_result", "validated m1", { thread: "validation-m1" }),
		ev("validation_result", "✓ A1", { thread: "validation-m1" }),
		ev("milestone_verdict", "milestone 1: STALLED"),
		ev("validation_result", "validated m2", { thread: "validation-m2" }),
		ev("validation_result", "✓ A1", { thread: "validation-m2" }),
	]);
	assert(groups.length === 3, `expected 3 groups, got ${groups.length}`);
	assert(groups[1].parent.kind === "milestone_verdict", "the verdict was absorbed into a thread");
});

check("a mission recorded before threading still collapses", () => {
	// The regression that motivated the inference: without it, every mission already on disk
	// keeps the wall of ✓ this feature exists to remove.
	const groups = groupTimeline([
		ev("validation_result", "validated: 40/40 assertions passed"),
		...Array.from({ length: 40 }, (_, i) => ev("validation_result", `✓ A${i}`)),
		ev("milestone_verdict", "milestone 1: PASSED"),
	]);
	assert(groups.length === 2, `expected 2 groups, got ${groups.length}`);
	assert(groups[0].children.length === 40, `expected 40 replies, got ${groups[0].children.length}`);
});

check("inference does not reach across an intervening event", () => {
	const groups = groupTimeline([
		ev("validation_result", "validated m1"),
		ev("lifecycle", "committed F1"),
		ev("validation_result", "validated m2"),
	]);
	assert(groups.length === 3, `expected 3 groups, got ${groups.length}`);
});

check("only validation results are inferred into threads", () => {
	// Widening this to every kind would swallow consecutive events that merely share a kind —
	// two features worked in a row would become one line with a reply.
	const groups = groupTimeline([ev("tool_call", "worker: F1"), ev("tool_call", "worker: F2")]);
	assert(groups.length === 2, `two features collapsed into ${groups.length} group(s)`);
});

check("an error is never swallowed into a thread", () => {
	// An error hidden behind "41 replies" is the one failure mode that matters here.
	const groups = groupTimeline([
		ev("validation_result", "validated"),
		ev("validation_result", "✓ A1"),
		ev("error", "worker crashed"),
	]);
	assert(groups[groups.length - 1].parent.kind === "error", "the error was folded into the thread above it");
});

check("a recorded thread is not extended by an unthreaded neighbour", () => {
	const groups = groupTimeline([
		ev("validation_result", "validated", { thread: "v1" }),
		ev("validation_result", "✓ A1", { thread: "v1" }),
		ev("validation_result", "a later unthreaded result"),
	]);
	assert(groups.length === 2, `expected 2 groups, got ${groups.length}`);
	assert(groups[0].children.length === 1, "an unthreaded event joined a recorded thread");
});

check("an empty timeline is an empty list, not a crash", () => {
	assert(groupTimeline([]).length === 0, "empty input produced groups");
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall seat tests passed");
