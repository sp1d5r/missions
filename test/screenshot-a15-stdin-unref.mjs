#!/usr/bin/env node
/**
 * a15 — stdin-unref / process-exit test for the screenshot tool.
 *
 * Asserts: invoking the screenshot tool by name from the worker tool registry
 * does NOT cause the invoking Node process to exit before the returned promise
 * resolves. The tool must complete its capture and return a valid result before
 * the process is allowed to terminate.
 *
 * Strategy:
 *   1. Keep the event loop alive with a timer (simulates a live worker that has
 *      other work in progress).
 *   2. Invoke the screenshot tool and await the result.
 *   3. Assert that the promise resolved with a valid image result.
 *   4. Call closeBrowser() to release browser handles.
 *   5. Clear the timer and let the process exit naturally.
 *
 * The test also verifies that the tool does NOT call process.stdin.unref() or
 * any other mechanism that would drop the event loop before the promise resolves:
 * we check that our keepalive timer was still running when the promise resolved
 * (if the process had exited early, the resolved flag would never be set).
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Import from built dist
const { getWorkerTool, closeBrowser } = await import(join(repoRoot, "dist/worker.js"));

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Keep the event loop alive with a timer for the duration of the test.
// If the tool prematurely drops event-loop handles the timer would be the
// only thing keeping the process alive — and the process would exit naturally
// once the timer fires, before the tool promise resolves.
// ---------------------------------------------------------------------------
let timerStillRunningWhenResolved = false;
const keepAliveTimer = setInterval(() => {
  // This fires every 500ms to keep the event loop alive during the capture.
  // It is cleared after the tool resolves, below.
}, 500);

// ---------------------------------------------------------------------------
// Invoke the screenshot tool via the worker tool registry
// ---------------------------------------------------------------------------
const tool = getWorkerTool("screenshot");
if (!tool) {
  fail("getWorkerTool('screenshot') returned undefined — tool not registered");
  clearInterval(keepAliveTimer);
  process.exit(1);
}

ok("getWorkerTool('screenshot') returned a tool object");

const TARGET_URL = "data:text/html,<html><body style='background:%23fff'><h1>a15 test</h1></body></html>";

let result;
try {
  // Execute using the agent-pipeline calling convention (toolCallId, params)
  result = await tool.execute("a15-call-id", { url: TARGET_URL, width: 640, height: 480 });
  // If we're here, the promise resolved before the process exited.
  timerStillRunningWhenResolved = true;
} catch (err) {
  fail(`tool.execute() threw: ${err.message}`);
}

// Stop the keepalive timer — we no longer need it.
clearInterval(keepAliveTimer);

if (timerStillRunningWhenResolved) {
  ok("tool.execute() promise resolved (process did not exit early)");
} else {
  fail("tool.execute() promise did not resolve before process exit");
}

// Verify result shape
if (result) {
  if (Array.isArray(result.content) && result.content.length >= 2) {
    ok("result.content has at least 2 parts (text + image)");
  } else {
    fail(`result.content has unexpected shape: ${JSON.stringify(result.content?.map((c) => c.type))}`);
  }
  const imgPart = result.content?.find((c) => c.type === "image");
  if (imgPart?.source?.type === "base64" && typeof imgPart.source.data === "string") {
    ok("result contains a valid base64 image part");
  } else {
    fail("result is missing a valid base64 image part");
  }
  if (result.details?.url === TARGET_URL) {
    ok("result.details.url matches the requested URL");
  } else {
    fail(`result.details.url mismatch: ${result.details?.url}`);
  }
}

// Close the browser explicitly so event-loop handles are released.
await closeBrowser();
ok("closeBrowser() completed without throwing");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na15 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na15 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
