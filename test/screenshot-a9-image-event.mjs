#!/usr/bin/env node
/**
 * a9 — Screenshot tool direct-invocation image event test.
 *
 * Asserts: the screenshot tool, invoked directly by name from the worker tool
 * registry, produces an image event (via the attachImage callback) without
 * being tied to the e2e script.
 *
 * Strategy:
 *   1. Look up the screenshot tool via getWorkerTool('screenshot').
 *   2. Create the tool with an attachImage callback that records calls.
 *   3. Call tool.run() and verify that attachImage was called with PNG data.
 *   4. The process must exit cleanly (no hang).
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

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
// Create tool with attachImage callback
// ---------------------------------------------------------------------------
const imageEvents = [];

const tool = getWorkerTool("screenshot", {
  attachImage: (data, mimeType) => {
    imageEvents.push({ data, mimeType });
  },
});

if (!tool) {
  fail("getWorkerTool('screenshot') returned undefined — tool not registered");
  process.exit(1);
}

ok("getWorkerTool('screenshot') returned a tool object");

const TARGET_URL = "data:text/html,<html><body style='background:%23fff'><h1>a9 test</h1></body></html>";

// ---------------------------------------------------------------------------
// Invoke the tool directly
// ---------------------------------------------------------------------------
let result;
try {
  result = await tool.run({ url: TARGET_URL, width: 640, height: 480 });
  ok("tool.run() resolved without throwing");
} catch (err) {
  fail(`tool.run() threw: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

if (imageEvents.length >= 1) {
  ok(`attachImage callback was called ${imageEvents.length} time(s) — image event produced`);
} else {
  fail("attachImage callback was never called — no image event produced");
}

const img = imageEvents[0];
if (img) {
  if (Buffer.isBuffer(img.data) && img.data.length >= 8) {
    ok(`attachImage received a Buffer of ${img.data.length} bytes`);
  } else {
    fail(`attachImage data is not a valid Buffer: type=${typeof img.data}, length=${img?.data?.length}`);
  }

  if (typeof img.mimeType === "string" && img.mimeType.startsWith("image/")) {
    ok(`attachImage received mimeType: ${img.mimeType}`);
  } else {
    fail(`attachImage mimeType is not a valid image type: ${JSON.stringify(img.mimeType)}`);
  }
}

// Verify result also has an image part
const imgPart = result?.content?.find((c) => c.type === "image");
if (imgPart?.source?.type === "base64" && typeof imgPart.source.data === "string") {
  ok("result.content contains a valid base64 image part");
} else {
  fail("result.content is missing a valid base64 image part");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na9 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na9 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
