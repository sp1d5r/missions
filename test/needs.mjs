/**
 * Tests for the pure NEEDS YOU row formatter exported from tui.ts.
 *
 * The formatter is pure — no TTY, no chalk — so it runs without any terminal.
 * We build against ../dist/ (same as all other test modules in this suite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the registry from the live home dir.
const HOME = mkdtempSync(join(tmpdir(), "missions-test-needs-"));
process.env.MISSIONS_HOME = HOME;

const { formatNeedsRow } = await import("../dist/tui.js");

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

// ---------------------------------------------------------------------------
// formatNeedsRow — sentence present
// ---------------------------------------------------------------------------

check("returns the sentence when it fits within width", () => {
	const sentence = "Please review the test failures before merging.";
	const result = formatNeedsRow(sentence, 80);
	assert(result === sentence, `expected "${sentence}", got "${result}"`);
});

check("truncates with ellipsis when sentence exceeds width", () => {
	const sentence = "This is a very long needs sentence that should definitely be truncated because it exceeds the available column width on the board.";
	const result = formatNeedsRow(sentence, 40);
	assert(result.length === 40, `expected length 40, got ${result.length}`);
	assert(result.endsWith("…"), `expected trailing ellipsis, got "${result.slice(-3)}"`);
	// The start of the original sentence must survive.
	assert(result.startsWith("This"), `expected sentence start to survive, got "${result.slice(0, 6)}"`);
});

check("includes the full sentence when width exactly fits", () => {
	const sentence = "Exactly fits.";
	const result = formatNeedsRow(sentence, sentence.length);
	assert(result === sentence, `exact-fit failed: "${result}"`);
});

check("applies a minimum width of 20 so very small widths don't panic", () => {
	const sentence = "short";
	const result = formatNeedsRow(sentence, 0);
	// Width is clamped to at least 20; short sentence fits fine.
	assert(result === sentence, `expected "${sentence}", got "${result}"`);
});

check("a sentence of exactly minWidth survives a tiny-width call", () => {
	// minWidth is 20; a 20-char sentence with width=1 should not be truncated more than needed.
	const sentence = "12345678901234567890"; // 20 chars
	const result = formatNeedsRow(sentence, 1);
	// Width clamped to 20; sentence exactly fits.
	assert(result === sentence, `expected "${sentence}", got "${result}"`);
});

// ---------------------------------------------------------------------------
// formatNeedsRow — absent / undefined field (older records)
// ---------------------------------------------------------------------------

check("returns empty string when needs is undefined", () => {
	const result = formatNeedsRow(undefined, 80);
	assert(result === "", `expected empty string for undefined, got "${result}"`);
});

check("returns empty string when needs is empty string", () => {
	const result = formatNeedsRow("", 80);
	assert(result === "", `expected empty string for empty needs, got "${result}"`);
});

check("no placeholder text appears when needs is absent", () => {
	const result = formatNeedsRow(undefined, 80);
	// Must be truly empty — no "—" or "(none)" or similar placeholder.
	assert(result.length === 0, `expected zero-length result, got "${result}"`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

rmSync(HOME, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
