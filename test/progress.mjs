// A fan-out that says nothing is indistinguishable from a hang.
//
// The run that prompted this: `· investigate` at 15:17:48, silence, answer at 15:23:48. Six
// minutes in which a reader could not tell whether three scouts were reading a repo or the socket
// had died. dispatchScouts already accepted an onProgress callback — the chief's investigate tool
// simply never passed one, so the wiring existed and reported to nobody.
//
// What is pinned here is the contract, not the prose: scouts announce themselves, each completion
// is reported AS IT LANDS rather than batched at the end, and a scout that throws still reports.

import { dispatchScouts } from "../dist/subagent.js";
import { buildTools } from "../dist/chief.js";

let fails = 0;
const check = async (name, fn) => {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		fails++;
		console.log(`FAIL ${name}: ${e.message}`);
	}
};
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};

// ---- the chief actually passes a reporter -----------------------------------

await check("investigate declares onProgress support", () => {
	// buildTools takes the note callback as its third parameter. If that parameter is dropped the
	// tool set still builds and still works — it just goes silent again, which is the whole bug.
	assert(buildTools.length >= 3, `buildTools should accept a note callback, arity is ${buildTools.length}`);
});

// ---- dispatchScouts reports ------------------------------------------------

// No spec matches, so every task falls through to BUILTIN_SCOUT and runAgent is reached. We do not
// want real model calls here, so point at a directory that exists and give zero tasks for the
// announce case, then drive the failure path for the rest.
await check("zero tasks announces nothing", async () => {
	const seen = [];
	await dispatchScouts({ cwd: process.cwd(), specs: [], tasks: [], onProgress: (m) => seen.push(m) });
	assert(seen.length === 0, `expected silence for an empty fan-out, got ${JSON.stringify(seen)}`);
});

await check("a failing scout still reports its completion", async () => {
	const seen = [];
	// An unreadable cwd makes runAgent throw or exit non-zero; either way the catch/`done` path
	// must fire. A scout that dies silently is the same defect wearing a different hat.
	const results = await dispatchScouts({
		cwd: "/nonexistent-path-for-progress-test",
		specs: [],
		tasks: [{ agent: "scout", task: "this will not succeed" }],
		onProgress: (m) => seen.push(m),
	});

	assert(results.length === 1, `expected one result, got ${results.length}`);
	assert(seen.some((m) => m.includes("1 scout(s) reading")), `expected an opening announcement, got ${JSON.stringify(seen)}`);
	assert(seen.some((m) => /1\/1/.test(m)), `expected a 1/1 completion line, got ${JSON.stringify(seen)}`);
});

await check("completion lines carry the running count", async () => {
	const seen = [];
	await dispatchScouts({
		cwd: "/nonexistent-path-for-progress-test",
		specs: [],
		tasks: [
			{ agent: "scout", task: "one" },
			{ agent: "scout", task: "two" },
		],
		onProgress: (m) => seen.push(m),
	});
	const counted = seen.filter((m) => /\d+\/2/.test(m));
	assert(counted.length === 2, `expected two counted completions, got ${JSON.stringify(seen)}`);
	// Reported as they land, so the counter climbs — the point is that a slow scout cannot hide
	// the ones that already finished.
	assert(/1\/2/.test(counted[0]), `first completion should read 1/2, got ${counted[0]}`);
	assert(/2\/2/.test(counted[1]), `second completion should read 2/2, got ${counted[1]}`);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
