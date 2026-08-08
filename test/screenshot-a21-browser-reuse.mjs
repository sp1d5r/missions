#!/usr/bin/env node
/**
 * a21 — Browser singleton reuse test.
 *
 * Asserts: two back-to-back screenshot captures in one process reuse a single
 * browser instance (no relaunch between calls).
 *
 * Strategy:
 *   1. Import the screenshot module and read the initial launch count.
 *   2. Take capture 1, read the launch count — must be 1.
 *   3. Take capture 2, read the launch count — must still be 1 (reused).
 *   4. closeBrowser() to release handles.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool, closeBrowser, getBrowserInstanceCountForTest } = await import(
  join(repoRoot, "dist/worker/tools/screenshot.js")
);

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
const countBefore = getBrowserInstanceCountForTest();
console.log(`Launch count before any capture: ${countBefore}`);

const tool = createScreenshotTool();
const URL_A = "data:text/html,<html><body style='background:%23ccffcc'><h1>Capture 1</h1></body></html>";
const URL_B = "data:text/html,<html><body style='background:%23ffcccc'><h1>Capture 2</h1></body></html>";

// ---------------------------------------------------------------------------
// First capture
// ---------------------------------------------------------------------------
try {
  await tool.execute("a21-call-1", { url: URL_A, width: 320, height: 240 });
  ok("First capture completed without throwing");
} catch (err) {
  fail(`First capture threw: ${err.message}`);
  process.exit(1);
}

const countAfterFirst = getBrowserInstanceCountForTest();
console.log(`Launch count after capture 1: ${countAfterFirst}`);

if (countAfterFirst === countBefore + 1) {
  ok(`Browser launched exactly once for the first capture (count=${countAfterFirst})`);
} else {
  fail(`Expected browser launch count to be ${countBefore + 1} after first capture, got ${countAfterFirst}`);
}

// ---------------------------------------------------------------------------
// Second capture (must reuse the same browser)
// ---------------------------------------------------------------------------
try {
  await tool.execute("a21-call-2", { url: URL_B, width: 320, height: 240 });
  ok("Second capture completed without throwing");
} catch (err) {
  fail(`Second capture threw: ${err.message}`);
  process.exit(1);
}

const countAfterSecond = getBrowserInstanceCountForTest();
console.log(`Launch count after capture 2: ${countAfterSecond}`);

if (countAfterSecond === countAfterFirst) {
  ok(`Browser was NOT relaunched between captures — singleton reused (count still ${countAfterSecond})`);
} else {
  fail(
    `Browser was relaunched between captures — ` +
    `count went from ${countAfterFirst} to ${countAfterSecond}, expected no change`
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await closeBrowser();
ok("closeBrowser() completed");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na21 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na21 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
