#!/usr/bin/env node
/**
 * a20 — No _getActiveHandles usage; child-process unref path test.
 *
 * Asserts:
 *   1. The built screenshot module source does NOT reference _getActiveHandles
 *      (the private Node.js API that was flagged as a blocking issue).
 *   2. After a real browser launch and screenshot capture, the Node.js process
 *      exits naturally (the child process was successfully unref-ed) — we
 *      verify this by confirming the tool returns a valid result AND the process
 *      is not being kept alive by a ref-ed browser child process post-capture.
 *
 * Strategy for (1): Read the compiled dist file and assert the string
 *   "_getActiveHandles" is absent.
 *
 * Strategy for (2): Perform a real capture, call closeBrowser(), then verify
 *   the event loop has no more active handles from the browser by checking
 *   that the process exits naturally from this script (no process.exit() call
 *   needed — the test passes if it reaches the end and the process terminates).
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Assertion 1: No _getActiveHandles in the compiled output
// ---------------------------------------------------------------------------
const distPath = join(repoRoot, "dist/worker/tools/screenshot.js");
let distSource;
try {
  distSource = readFileSync(distPath, "utf8");
} catch (err) {
  fail(`Could not read ${distPath}: ${err.message}`);
  process.exit(1);
}

if (distSource.includes("_getActiveHandles")) {
  fail("dist/worker/tools/screenshot.js still contains '_getActiveHandles' — private API must be removed");
} else {
  ok("dist/worker/tools/screenshot.js does not reference _getActiveHandles (private API removed)");
}

// ---------------------------------------------------------------------------
// Assertion 2: No module-scope SIGINT/SIGTERM in the compiled output
// ---------------------------------------------------------------------------
if (distSource.includes('process.once("SIGINT"') || distSource.includes("process.once('SIGINT'")) {
  fail("dist/worker/tools/screenshot.js still contains module-scope SIGINT handler — must be removed");
} else {
  ok("dist/worker/tools/screenshot.js has no module-scope SIGINT handler");
}

if (distSource.includes('process.once("SIGTERM"') || distSource.includes("process.once('SIGTERM'")) {
  fail("dist/worker/tools/screenshot.js still contains module-scope SIGTERM handler — must be removed");
} else {
  ok("dist/worker/tools/screenshot.js has no module-scope SIGTERM handler");
}

// ---------------------------------------------------------------------------
// Assertion 3: Capture works and process exits naturally after closeBrowser()
// ---------------------------------------------------------------------------
const { createScreenshotTool, closeBrowser } = await import(distPath);

const tool = createScreenshotTool({});
const TARGET_URL = "data:text/html,<html><body style='background:%23f0f'><h1>a20</h1></body></html>";

let captureOk = false;
try {
  const result = await tool.run({ url: TARGET_URL, width: 320, height: 240 });
  if (
    Array.isArray(result.content) &&
    result.content.some((c) => c.type === "image")
  ) {
    captureOk = true;
    ok("tool.run() returned a result containing an image part");
  } else {
    fail("tool.run() result did not contain an image part");
  }
} catch (err) {
  fail(`tool.run() threw: ${err.message}`);
}

// Release browser handles — process should exit naturally after this.
await closeBrowser();
ok("closeBrowser() completed; process should now exit naturally");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na20 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na20 ALL ASSERTIONS PASSED`);
  // No explicit process.exit(0) — the process exits naturally if the
  // browser child process was successfully unref-ed and closed.
}
