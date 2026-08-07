/**
 * Regression test for parseIssueRulings — the "deferred" evidence fields.
 *
 * The type declares `evidenceAssertionId`/`outOfScope` on CorrectionRuling, and
 * applyRulings() in mission.ts reads them straight off it — but for a while nothing in
 * between ever copied them off the model's raw JSON. Every "deferred" ruling silently
 * lost its evidence no matter what the model said, so ruling.deferred-cites-evidence
 * blocked the milestone unconditionally. Both fields are optional on the type, so an
 * object literal that simply omits them type-checks fine — only a test that round-trips
 * real JSON through the parser and checks the field survived catches this.
 */

const { parseIssueRulings } = await import("../dist/orchestrator.js");

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

check("a deferred ruling's evidenceAssertionId survives parsing", () => {
	const raw = [{ summary: "issue", disposition: "deferred", evidenceAssertionId: "a3", note: "a3 covers it" }];
	const [ruling] = parseIssueRulings(raw, new Map());
	assert(ruling.evidenceAssertionId === "a3", `evidenceAssertionId was ${JSON.stringify(ruling.evidenceAssertionId)}, not "a3"`);
});

check("a deferred ruling's outOfScope survives parsing", () => {
	const raw = [{ summary: "issue", disposition: "deferred", outOfScope: true, note: "not asked for" }];
	const [ruling] = parseIssueRulings(raw, new Map());
	assert(ruling.outOfScope === true, `outOfScope was ${JSON.stringify(ruling.outOfScope)}, not true`);
});

check("a deferred ruling with neither evidence nor out-of-scope has neither set", () => {
	const raw = [{ summary: "issue", disposition: "deferred", note: "trust me" }];
	const [ruling] = parseIssueRulings(raw, new Map());
	assert(ruling.evidenceAssertionId === undefined, "evidenceAssertionId should be undefined when the model gave none");
	assert(ruling.outOfScope === false, "outOfScope should be false, not true, when the model gave none");
});

check("an addressed ruling maps correctionId through idMap", () => {
	const raw = [{ summary: "issue", disposition: "addressed", correctionId: "c1" }];
	const [ruling] = parseIssueRulings(raw, new Map([["c1", "m2c1"]]));
	assert(ruling.correctionId === "m2c1", `correctionId was ${JSON.stringify(ruling.correctionId)}, not "m2c1"`);
});

check("a ruling missing summary or disposition is dropped", () => {
	const raw = [{ disposition: "deferred", evidenceAssertionId: "a1" }, { summary: "no disposition" }];
	assert(parseIssueRulings(raw, new Map()).length === 0, "malformed rulings should be dropped, not guessed at");
});

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall orchestrator tests passed");
