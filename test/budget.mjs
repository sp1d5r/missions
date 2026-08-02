// Budget is recorded, not rationed.
//
// A cap never made a mission cheaper. It fired mid-turn, aborted the worker, and committed a
// half-written feature that then failed its own assertions — the money was spent AND the work was
// unusable. Then it set finalVerdict to `budget-exhausted`, which reads on the board as "this
// needs you" when nothing was wrong with the work at all.
//
// So: uncapped by default, spend recorded everywhere, and an explicit cap still honoured for
// anyone who genuinely wants a run to stop dead at a number.

import { budgetLine } from "../dist/orchestrator.js";
import { decideResume } from "../dist/mission.js";

let fails = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		fails++;
		console.log(`FAIL ${name}: ${e.message}`);
	}
};
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};

// ---- the orchestrator prompt ------------------------------------------------

// Infinity.toFixed(2) is the string "Infinity". Shipping "Budget remaining: $Infinity." into a
// prompt is both nonsense and an invitation — what actually bounds the orchestrator is the
// milestone ceiling, so an uncapped mission says nothing about money.
check("uncapped mission mentions no budget at all", () => {
	const line = budgetLine(Number.POSITIVE_INFINITY);
	assert(line === "", `expected empty string, got ${JSON.stringify(line)}`);
	assert(!line.includes("Infinity"), "must never render Infinity into a prompt");
});

check("capped mission still states what is left", () => {
	const line = budgetLine(4.5);
	assert(line.includes("4.50"), `expected the figure, got ${JSON.stringify(line)}`);
	assert(line.includes("Budget remaining"), `expected the label, got ${JSON.stringify(line)}`);
});

check("a spent-out cap reads as zero, not as absent", () => {
	assert(budgetLine(0).includes("0.00"), "a real cap at zero must still be stated");
});

// ---- resume never refuses over money ---------------------------------------

const state = (over = {}) => ({ costUsd: 0, milestones: [], finalVerdict: undefined, ...over });
const probes = (over = {}) => ({
	worktreeExists: true,
	missionRunning: false,
	stateReadable: true,
	spentUsd: 0,
	milestoneCount: 0,
	finalVerdict: undefined,
	...over,
});

check("no dollar figure refuses a resume", () => {
	for (const spent of [0, 10, 100, 10_000]) {
		const r = decideResume(state({ costUsd: spent }), {}, probes({ spentUsd: spent }));
		assert(r.ok === true, `$${spent} spent should still resume, got ${JSON.stringify(r)}`);
	}
});

check("the milestone ceiling is still a real refusal", () => {
	// Removing the budget guard must not have removed the one bound that genuinely stops a
	// runaway loop. maxMilestones is what makes uncapped safe.
	const r = decideResume(state({ finalVerdict: "max-milestones" }), {}, probes({ finalVerdict: "max-milestones" }));
	assert(r.ok === false, "max-milestones must still refuse without an explicit raise");
	assert(r.remedy.includes("max-milestones"), `remedy should name the flag, got ${r.remedy}`);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
