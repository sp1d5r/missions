#!/usr/bin/env node
/**
 * a23 — Concurrent worker browser teardown test.
 *
 * Asserts: two overlapping screenshot captures (simulating concurrent workers)
 * both return valid PNG buffers with no 'Target closed' / 'Browser has been
 * closed' errors. The browser singleton is NOT torn down by the first worker
 * finishing while the second is still in-flight.
 *
 * This test validates the acquireBrowserRef/releaseBrowserRef ref-counting fix
 * introduced in src/worker.ts and src/worker/tools/screenshot.ts.
 *
 * Strategy:
 *   1. Import acquireBrowserRef / releaseBrowserRef from dist/worker.js.
 *   2. Simulate two concurrent workers:
 *      a. Worker A: acquireBrowserRef() → start capture (slow URL via data:) → releaseBrowserRef()
 *      b. Worker B: acquireBrowserRef() → start capture (different URL) → releaseBrowserRef()
 *      The two captures are started concurrently via Promise.all so they overlap.
 *   3. Assert both captures returned valid PNG buffers (>= 8 bytes, PNG magic).
 *   4. Assert no 'Target closed' / 'Browser has been closed' errors were thrown.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const {
  createScreenshotTool,
  closeBrowser,
  acquireBrowserRef,
  releaseBrowserRef,
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

// PNG magic bytes: \x89PNG\r\n\x1a\n
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Simulate one worker: acquire ref, take screenshot, release ref.
 * Returns the PNG buffer or throws on error.
 */
async function simulateWorker(id, url) {
  acquireBrowserRef();
  try {
    const tool = createScreenshotTool();
    const result = await tool.execute(`worker-${id}`, { url, width: 640, height: 480 });

    // Extract the PNG buffer from the result content
    const imgPart = result?.content?.find((c) => c.type === "image");
    if (!imgPart?.source?.data) {
      throw new Error(`Worker ${id}: no image part in result`);
    }
    const buf = Buffer.from(imgPart.source.data, "base64");
    return buf;
  } finally {
    await releaseBrowserRef();
  }
}

// ---------------------------------------------------------------------------
// Two distinct URLs to capture
// ---------------------------------------------------------------------------
const URL_A = "data:text/html,<html><body style='background:%2300ff00;padding:20px'><h1 style='font-size:60px'>WORKER A</h1></body></html>";
const URL_B = "data:text/html,<html><body style='background:%23ff0000;padding:20px'><h1 style='font-size:60px;color:white'>WORKER B</h1></body></html>";

// ---------------------------------------------------------------------------
// Run the two workers concurrently
// ---------------------------------------------------------------------------
console.log("Starting two concurrent simulated workers...");

const launchCountBefore = getBrowserInstanceCountForTest();

let bufA, bufB, errorA, errorB;

try {
  [bufA, bufB] = await Promise.all([
    simulateWorker("A", URL_A).catch((err) => { errorA = err; return null; }),
    simulateWorker("B", URL_B).catch((err) => { errorB = err; return null; }),
  ]);
} catch (err) {
  fail(`Promise.all threw unexpectedly: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

// Worker A
if (errorA) {
  fail(`Worker A threw an error: ${errorA.message}`);
  if (/Target closed|Browser has been closed|browser.*closed|target.*closed/i.test(errorA.message)) {
    fail(`Worker A error contains 'Target closed'/'Browser has been closed' — ref-counting bug`);
  }
} else {
  ok("Worker A completed without throwing");

  if (Buffer.isBuffer(bufA) && bufA.length >= 8) {
    ok(`Worker A returned a Buffer of ${bufA.length} bytes`);
  } else {
    fail(`Worker A: invalid buffer — type=${typeof bufA}, length=${bufA?.length}`);
  }

  if (Buffer.isBuffer(bufA) && bufA.slice(0, 8).equals(PNG_MAGIC)) {
    ok("Worker A: buffer starts with PNG magic bytes");
  } else {
    fail("Worker A: buffer does not start with PNG magic bytes");
  }
}

// Worker B
if (errorB) {
  fail(`Worker B threw an error: ${errorB.message}`);
  if (/Target closed|Browser has been closed|browser.*closed|target.*closed/i.test(errorB.message)) {
    fail(`Worker B error contains 'Target closed'/'Browser has been closed' — ref-counting bug`);
  }
} else {
  ok("Worker B completed without throwing");

  if (Buffer.isBuffer(bufB) && bufB.length >= 8) {
    ok(`Worker B returned a Buffer of ${bufB.length} bytes`);
  } else {
    fail(`Worker B: invalid buffer — type=${typeof bufB}, length=${bufB?.length}`);
  }

  if (Buffer.isBuffer(bufB) && bufB.slice(0, 8).equals(PNG_MAGIC)) {
    ok("Worker B: buffer starts with PNG magic bytes");
  } else {
    fail("Worker B: buffer does not start with PNG magic bytes");
  }
}

// Browser launched only once (shared singleton)
const launchCountAfter = getBrowserInstanceCountForTest();
console.log(`Browser launch count: before=${launchCountBefore}, after=${launchCountAfter}`);
if (launchCountAfter === launchCountBefore + 1) {
  ok("Browser was launched exactly once for both concurrent workers (singleton shared)");
} else if (launchCountAfter === launchCountBefore) {
  // Could happen if there was a pre-existing browser instance
  ok("Browser was not relaunched (pre-existing singleton reused)");
} else {
  fail(`Unexpected browser launch count: before=${launchCountBefore}, after=${launchCountAfter}`);
}

// After both workers finish, releaseBrowserRef should have closed the browser.
// Since we explicitly called it via the workers, the ref count should be 0.
// We can verify by confirming closeBrowser() is safe to call again (idempotent).
try {
  await closeBrowser();
  ok("closeBrowser() after both workers: no error (idempotent)");
} catch (err) {
  fail(`closeBrowser() threw after workers finished: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na23 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na23 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
