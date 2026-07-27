/**
 * Tests for reaching a worker while a milestone is still open.
 *
 * A worker used to be dropped from the registry the instant its own turn ended — before the
 * validators ran, and long before the orchestrator decided the milestone had stalled. So it was
 * addressable for its whole life except the one moment an operator wanted it: "STALLED — needs
 * you". By then the agent was gone and all that survived was a paragraph of handoff text, while
 * the agent itself still held the files it had read and why it chose what it chose.
 *
 * These cover the waiting half of the fix. The unattended path matters most: a stall that blocks
 * forever would hold a worktree and an API budget hostage waiting for someone who is asleep.
 */

const { registerWorker, listWorkers, steerWorker, awaitOperatorSteer } = await import("../dist/workers.js");

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

/** Enough of pi's Agent for the registry paths: steer() records, subscribe() is a no-op. */
function fakeAgent() {
	const seen = [];
	return { seen, steer: (m) => seen.push(m), subscribe: () => () => {}, prompt: async () => {}, waitForIdle: async () => {} };
}

function addWorker(id) {
	const agent = fakeAgent();
	const release = registerWorker({
		info: { id, missionId: "m", featureId: "f1", title: "t", startedAt: Date.now(), costUsd: 0, lastActivity: "", steers: [] },
		agent,
		recent: [],
	});
	return { agent, release };
}

await check("with nothing registered, the wait returns immediately", async () => {
	// The unattended case. A cron run with no live worker must not sit on a timeout.
	const started = Date.now();
	const got = await awaitOperatorSteer(60_000);
	assert(got === null, `expected null, got ${got}`);
	assert(Date.now() - started < 1_000, "waited on a timeout despite having nobody to steer");
});

await check("a steer that arrives is reported, with the worker's id", async () => {
	const w = addWorker("m:f1");
	const waiting = awaitOperatorSteer(10_000);
	const r = steerWorker("m:f1", "you missed the empty-input case");
	assert(r.ok, `steer rejected: ${r.detail}`);
	assert((await waiting) === "m:f1", "the wait did not observe the steer");
	w.release();
});

await check("the instruction reaches the agent", async () => {
	const w = addWorker("m:f2");
	steerWorker("m:f2", "handle the empty transcript");
	const text = JSON.stringify(w.agent.seen);
	assert(text.includes("handle the empty transcript"), "the steer never reached the agent");
	assert(/OPERATOR/i.test(text), "steer was not marked as coming from the operator — reads as a suggestion and gets ignored");
	w.release();
});

await check("the wait gives up rather than blocking forever", async () => {
	// A stalled mission holds a worktree and a budget. Waiting is bounded on purpose.
	const w = addWorker("m:f3");
	const started = Date.now();
	assert((await awaitOperatorSteer(700)) === null, "returned a steer nobody sent");
	assert(Date.now() - started >= 600, "did not actually wait");
	w.release();
});

await check("steering an unknown worker fails instead of pretending", async () => {
	const r = steerWorker("m:nope", "do something");
	assert(!r.ok, "reported success for a worker that does not exist");
});

await check("a released worker is no longer reachable", async () => {
	const w = addWorker("m:f4");
	w.release();
	assert(!listWorkers().some((x) => x.id === "m:f4"), "released worker still listed");
	assert(!steerWorker("m:f4", "x").ok, "steered a released worker");
});

await check("a steer from a PREVIOUS wait does not satisfy the next one", async () => {
	// The wait must observe a NEW steer, not a worker that happens to carry an old one. Otherwise
	// the second stall in a mission resolves instantly on stale history and skips the human.
	const w = addWorker("m:f5");
	steerWorker("m:f5", "first instruction");
	const started = Date.now();
	assert((await awaitOperatorSteer(700)) === null, "an earlier steer satisfied a later wait");
	assert(Date.now() - started >= 600, "returned early on stale steer history");
	w.release();
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
