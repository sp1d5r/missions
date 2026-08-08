#!/usr/bin/env node
/**
 * a25 — closeBrowser refcount stomp prevention test.
 *
 * Asserts: closeBrowser() does NOT reset browserRefCount to zero mid-flight.
 * When concurrent workers hold refs (browserRefCount > 0) and closeBrowser()
 * is called explicitly (e.g. by a force-teardown path), the ref count must
 * remain unchanged so subsequent acquireBrowserRef/releaseBrowserRef calls
 * remain consistent.
 *
 * Also verifies that getBrowserRefCountForTest() is exported and reflects
 * the actual ref count.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const {
  acquireBrowserRef,
  releaseBrowserRef,
  closeBrowser,
  getBrowserRefCountForTest,
  getBrowserInstanceCountForTest,
} = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Verify getBrowserRefCountForTest is exported and starts at 0
// ---------------------------------------------------------------------------
if (typeof getBrowserRefCountForTest === "function") {
  ok("getBrowserRefCountForTest is exported as a function");
} else {
  fail(`getBrowserRefCountForTest is not a function: ${typeof getBrowserRefCountForTest}`);
  process.exit(1);
}

const initialCount = getBrowserRefCountForTest();
console.log(`Initial ref count: ${initialCount}`);
// We can't assert it's exactly 0 here in case tests ran before us and didn't clean up,
// but it should be a non-negative integer.
if (Number.isInteger(initialCount) && initialCount >= 0) {
  ok(`Initial ref count is a non-negative integer: ${initialCount}`);
} else {
  fail(`Initial ref count is invalid: ${initialCount}`);
}

// ---------------------------------------------------------------------------
// Test 1: acquireBrowserRef increments the count
// ---------------------------------------------------------------------------
acquireBrowserRef();
const countAfterAcquire1 = getBrowserRefCountForTest();
console.log(`After acquireBrowserRef(): ${countAfterAcquire1}`);
if (countAfterAcquire1 === initialCount + 1) {
  ok(`acquireBrowserRef() incremented ref count from ${initialCount} to ${countAfterAcquire1}`);
} else {
  fail(`Expected ref count ${initialCount + 1} after acquireBrowserRef(), got ${countAfterAcquire1}`);
}

// Acquire a second ref (simulating a second worker)
acquireBrowserRef();
const countAfterAcquire2 = getBrowserRefCountForTest();
console.log(`After second acquireBrowserRef(): ${countAfterAcquire2}`);
if (countAfterAcquire2 === initialCount + 2) {
  ok(`Two refs acquired: count is ${countAfterAcquire2}`);
} else {
  fail(`Expected ref count ${initialCount + 2}, got ${countAfterAcquire2}`);
}

// ---------------------------------------------------------------------------
// Test 2: closeBrowser() does NOT reset the ref count
// This is the key assertion: closeBrowser() force-closes the browser instance
// but must NOT stomp the ref count (which concurrent workers depend on).
// ---------------------------------------------------------------------------
await closeBrowser();
const countAfterClose = getBrowserRefCountForTest();
console.log(`After closeBrowser() with 2 active refs: ${countAfterClose}`);
if (countAfterClose === countAfterAcquire2) {
  ok(`closeBrowser() did NOT reset ref count (count still ${countAfterClose}) — stomp prevented`);
} else {
  fail(
    `closeBrowser() STOMPED the ref count: ` +
    `was ${countAfterAcquire2} before close, now ${countAfterClose}. ` +
    `This is the bug: concurrent workers lose their ref count.`
  );
}

// ---------------------------------------------------------------------------
// Test 3: releaseBrowserRef decrements correctly after closeBrowser was called
// ---------------------------------------------------------------------------
await releaseBrowserRef();
const countAfterRelease1 = getBrowserRefCountForTest();
console.log(`After first releaseBrowserRef(): ${countAfterRelease1}`);
if (countAfterRelease1 === countAfterClose - 1) {
  ok(`releaseBrowserRef() decremented ref count from ${countAfterClose} to ${countAfterRelease1}`);
} else {
  fail(`Expected ref count ${countAfterClose - 1} after releaseBrowserRef(), got ${countAfterRelease1}`);
}

await releaseBrowserRef();
const countAfterRelease2 = getBrowserRefCountForTest();
console.log(`After second releaseBrowserRef(): ${countAfterRelease2}`);
if (countAfterRelease2 === initialCount) {
  ok(`Both refs released: count returned to ${countAfterRelease2} (initial: ${initialCount})`);
} else {
  fail(`Expected ref count ${initialCount} after releasing all refs, got ${countAfterRelease2}`);
}

// ---------------------------------------------------------------------------
// Test 4: releaseBrowserRef does not go below 0
// ---------------------------------------------------------------------------
await releaseBrowserRef(); // extra release — should clamp at 0
const countAfterExtraRelease = getBrowserRefCountForTest();
console.log(`After extra releaseBrowserRef() below 0: ${countAfterExtraRelease}`);
if (countAfterExtraRelease >= 0) {
  ok(`ref count does not go below 0: ${countAfterExtraRelease}`);
} else {
  fail(`ref count went below 0: ${countAfterExtraRelease}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na25 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na25 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
