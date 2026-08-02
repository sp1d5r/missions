// Focus is the chief's answer to "where am I?", and until now nothing could ask it.
//
// The IPC protocol is one-way broadcast — `hello`, `input`, `out`. The web console could MOVE the
// focus but had no way to READ it, which makes a repo picker impossible to render honestly: it
// would show nothing selected, or guess. So the daemon publishes it to a file.
//
// The property that matters: an unpublished focus reads as undefined, NOT as a plausible-looking
// default. A picker that invents a selection is worse than one that admits it doesn't know.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "missions-focus-"));
process.env.MISSIONS_HOME = home;

const { publishFocus, readFocus } = await import("../dist/focus.js");

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

check("nothing published yet → undefined, not a guess", () => {
	assert(readFocus() === undefined, `expected undefined, got ${JSON.stringify(readFocus())}`);
});

check("publish then read round-trips the path", () => {
	publishFocus("/Users/someone/nadine");
	assert(readFocus() === "/Users/someone/nadine", `got ${JSON.stringify(readFocus())}`);
});

check("republishing replaces rather than appends", () => {
	publishFocus("/Users/someone/missions");
	assert(readFocus() === "/Users/someone/missions", `got ${JSON.stringify(readFocus())}`);
});

check("an empty file reads as undefined", () => {
	// A truncated or half-written file must not present as a workspace whose path is "".
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "focus"), "   \n");
	assert(readFocus() === undefined, `expected undefined, got ${JSON.stringify(readFocus())}`);
});

check("trailing newline from a shell redirect is tolerated", () => {
	writeFileSync(join(home, "focus"), "/Users/someone/buzz\n");
	assert(readFocus() === "/Users/someone/buzz", `got ${JSON.stringify(readFocus())}`);
});

check("publishing never throws, even at an unwritable root", () => {
	const saved = process.env.MISSIONS_HOME;
	process.env.MISSIONS_HOME = "/proc/nonexistent-and-unwritable/missions";
	try {
		publishFocus("/whatever"); // must swallow — focus is a convenience, never a hard failure
	} finally {
		process.env.MISSIONS_HOME = saved;
	}
});

rmSync(home, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
