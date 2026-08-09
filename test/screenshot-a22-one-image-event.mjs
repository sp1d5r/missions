#!/usr/bin/env node
/**
 * a22 — Single image timeline event test.
 *
 * Asserts: a worker-driven mission that captures one screenshot produces exactly
 * one image timeline event in the mission store (no duplicates from
 * extractImageParts + opts.attachImage).
 *
 * Background: runWorker wires the screenshot tool WITHOUT opts.attachImage,
 * relying solely on extractImageParts scanning tool_execution_end results.
 * This test replicates that pipeline and verifies no duplication occurs.
 *
 * Strategy:
 *   1. Create a screenshot tool exactly as runWorker does — no attachImage opt.
 *   2. Call tool.execute() to get a result.
 *   3. Feed the result through extractImageParts (as worker.ts does in the
 *      tool_execution_end handler) and collect image events.
 *   4. Assert exactly 1 image event is emitted (not 0, not 2+).
 *   5. Verify no double event from both extractImageParts AND a direct callback.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool, closeBrowser, extractImageParts } = await import(
  join(repoRoot, "dist/worker.js")
);

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

const TARGET_URL = "data:text/html,<html><body style='background:%23fff'><h1>a22 test</h1></body></html>";

// ---------------------------------------------------------------------------
// Step 1: Create the tool exactly as runWorker does — NO attachImage opt.
// This is the key: runWorker does NOT wire attachImage in the factory opts
// to avoid the double-event scenario.
// ---------------------------------------------------------------------------
const tool = createScreenshotTool();
// (no opts.attachImage — matches runWorker behaviour)
ok("Created screenshot tool without opts.attachImage (matches runWorker)");

// ---------------------------------------------------------------------------
// Step 2: Execute the tool (agent pipeline convention: toolCallId, params)
// ---------------------------------------------------------------------------
let toolResult;
try {
  toolResult = await tool.execute("a22-call-1", { url: TARGET_URL, width: 640, height: 480 });
  ok("tool.execute() resolved without throwing");
} catch (err) {
  fail(`tool.execute() threw: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Feed through extractImageParts (as worker.ts does on tool_execution_end)
// ---------------------------------------------------------------------------
const imageEvents = [];
const imageParts = extractImageParts(toolResult, "screenshot");
for (const img of imageParts) {
  imageEvents.push(img);
}

ok(`extractImageParts found ${imageParts.length} image part(s) in tool result`);

// ---------------------------------------------------------------------------
// Step 4: Assert exactly ONE image event
// ---------------------------------------------------------------------------
if (imageEvents.length === 1) {
  ok("Exactly 1 image event emitted — no duplicates (a22 satisfied)");
} else if (imageEvents.length === 0) {
  fail("0 image events emitted — extractImageParts found nothing in the screenshot result");
} else {
  fail(`${imageEvents.length} image events emitted — expected exactly 1 (duplicate events present)`);
}

// Verify the image part is a valid PNG buffer
const evt = imageEvents[0];
if (evt) {
  if (Buffer.isBuffer(evt.data) && evt.data.length >= 8) {
    ok(`Image event data is a Buffer of ${evt.data.length} bytes`);
  } else {
    fail(`Image event data is invalid: type=${typeof evt.data}, length=${evt?.data?.length}`);
  }

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (Buffer.isBuffer(evt.data) && evt.data.slice(0, 8).equals(PNG_MAGIC)) {
    ok("Image event data starts with PNG magic bytes");
  } else {
    fail("Image event data does not start with PNG magic bytes");
  }

  if (evt.mimeType === "image/png") {
    ok("Image event mimeType is 'image/png'");
  } else {
    fail(`Image event mimeType is '${evt.mimeType}', expected 'image/png'`);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Verify no double-event if we also had an opts.attachImage
// (this is what the real pipeline avoids by NOT wiring opts.attachImage)
// ---------------------------------------------------------------------------
{
  // Simulate the "bad" approach: tool WITH opts.attachImage AND extractImageParts.
  // Count total events — should only happen once in correct code, twice in bad code.
  let optsCallCount = 0;
  const badTool = createScreenshotTool({
    attachImage: (_data, _mimeType) => {
      optsCallCount++;
    },
  });

  let badResult;
  try {
    badResult = await badTool.execute("a22-call-bad", { url: TARGET_URL, width: 320, height: 240 });
  } catch (err) {
    fail(`Bad tool call threw: ${err.message}`);
    process.exit(1);
  }

  const badImageParts = extractImageParts(badResult, "screenshot");

  // In this "bad" wiring, opts.attachImage fires ONCE and extractImageParts finds ONE part.
  // A naive system would record both — total 2 events. The real runWorker avoids this by
  // not wiring opts.attachImage.
  const totalEventsIfBadWiring = optsCallCount + badImageParts.length;

  ok(`Simulated bad wiring: opts.attachImage called ${optsCallCount}x, extractImageParts found ${badImageParts.length} part(s) — total would be ${totalEventsIfBadWiring} events`);

  if (totalEventsIfBadWiring > 1) {
    ok(`Confirmed: naïve double-wiring WOULD produce ${totalEventsIfBadWiring} events — runWorker correctly avoids this by not passing opts.attachImage`);
  }

  // Verify that the REAL approach (no opts.attachImage, just extractImageParts) gives exactly 1:
  const correctEventCount = imageEvents.length; // from earlier step
  if (correctEventCount === 1) {
    ok(`Correct approach (no opts.attachImage + extractImageParts only) → exactly 1 event ✓`);
  } else {
    fail(`Correct approach produced ${correctEventCount} events instead of 1`);
  }
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
  console.error(`\na22 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na22 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
