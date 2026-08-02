// A model call that fails must say so, not return an empty string.
//
// complete() filtered result.content for text parts and joined them. A failed call has no text
// parts, so it returned "" and dropped result.errorMessage on the floor. The orchestrator then
// threw its own symptom against that empty string:
//
//   FAILED: Orchestrator did not return a usable plan. Raw:
//
// which reads as "the model wrote something unparseable" when in fact it never answered. A whole
// mission was then diagnosed as too-large-a-scope on the strength of that empty Raw, and the
// proposed remedy — split into four smaller missions — would have hit the same wall four times.
//
// Same class as the worker dropping errorMessage: the one field that says what happened is the one
// field not on the happy path.

import { readFileSync } from "node:fs";

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

// complete() calls the provider, so it cannot be exercised without a live model or a mock of the
// pi SDK. The property that regressed is structural and checkable at the source: the empty-text
// path must consult errorMessage/stopReason and throw rather than returning silently.
const src = readFileSync(new URL("../dist/llm.js", import.meta.url), "utf-8");

check("empty text consults errorMessage", () => {
	assert(src.includes("errorMessage"), "complete() must read result.errorMessage on the empty-text path");
});

check("empty text consults stopReason", () => {
	// errorMessage alone is not enough: a call can end on a non-stop stopReason (aborted, length,
	// a provider refusal) with neither text nor an error string.
	assert(src.includes("stopReason"), "complete() must read result.stopReason on the empty-text path");
});

check("empty text throws rather than returning silently", () => {
	// The guard has to precede the return, or the reason is computed and discarded.
	const guard = src.indexOf("returned no text");
	const ret = src.lastIndexOf("costUsd: result.usage.cost.total");
	assert(guard !== -1, "complete() must throw a 'returned no text' error");
	assert(guard < ret, "the throw must come before the successful return");
});

check("a non-empty response is never blocked by the guard", () => {
	// The guard must be conditional on emptiness. If it fired unconditionally every orchestrator
	// call would die, which is a far worse bug than the one being fixed.
	assert(/if \(!text\)/.test(src), "the guard must be gated on empty text");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
