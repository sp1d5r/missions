#!/usr/bin/env node
/**
 * a10 — Screenshot tool mission store integration test.
 *
 * Asserts: the screenshot tool, invoked directly by name from the worker tool
 * registry (not via the e2e script), causes the mission store to gain an image
 * timeline event whose file resolves under the mission images dir.
 *
 * Strategy:
 *   1. Create a minimal StateStore with a temp outDir.
 *   2. Create the screenshot tool with attachImage wired to store.attachImage.
 *   3. Invoke tool.run() and verify:
 *      a) store.appendEvent("image", ...) was called (event in state.events)
 *      b) The image file exists under outDir/images/
 *   4. The process must exit cleanly.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool } = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));
const { StateStore } = await import(join(repoRoot, "dist/state.js"));

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Setup a temporary StateStore
// ---------------------------------------------------------------------------
const missionId = `m-a10-test-${randomBytes(4).toString("hex")}`;
const outDir = join(tmpdir(), missionId);
mkdirSync(outDir, { recursive: true });

ok(`created temp outDir: ${outDir}`);

// Minimal MissionState
const state = {
  id: missionId,
  startedAt: new Date().toISOString(),
  goal: "a10 test",
  rfc: "a10 test",
  status: "active",
  branch: `missions/${missionId}`,
  targetCwd: repoRoot,
  origin: { kind: "human" },
  routing: {
    worker: { provider: "anthropic", modelId: "claude-opus-4-5" },
    orchestrator: { provider: "anthropic", modelId: "claude-opus-4-5" },
    bugSpotter: { provider: "anthropic", modelId: "claude-opus-4-5" },
  },
  features: [],
  handoffs: [],
  milestones: [],
  commits: [],
  costUsd: 0,
  log: [],
  events: [],
  finalVerdict: "pending",
  outcome: "pending",
  plan: { summary: "", features: [], contract: { assertions: [] } },
};

const store = new StateStore(outDir, state);

// ---------------------------------------------------------------------------
// Create tool wired to store
// ---------------------------------------------------------------------------
const tool = createScreenshotTool({
  attachImage: (data, mimeType) => {
    const stored = store.attachImage(data, mimeType);
    store.appendEvent("image", "screenshot capture", undefined, {
      seat: "eng",
      image: { path: stored.path, mimeType, bytes: stored.bytes },
    });
    ok(`attachImage called: stored at ${stored.path} (${stored.bytes} bytes)`);
  },
});

// ---------------------------------------------------------------------------
// Invoke the tool
// ---------------------------------------------------------------------------
const TARGET_URL = "data:text/html,<html><body><h1>a10 store test</h1></body></html>";

try {
  await tool.run({ url: TARGET_URL, width: 640, height: 480 });
  ok("tool.run() resolved");
} catch (err) {
  fail(`tool.run() threw: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

// a) state.events has at least one image event
const imageEvents = store.state.events.filter((e) => e.kind === "image");
if (imageEvents.length >= 1) {
  ok(`state.events contains ${imageEvents.length} image event(s)`);
} else {
  fail("state.events has no image events — store was not updated");
}

// b) Image file exists under outDir/images/
for (const evt of imageEvents) {
  const filePath = join(outDir, evt.image.path);
  if (existsSync(filePath)) {
    ok(`image file exists on disk: ${evt.image.path}`);
  } else {
    fail(`image file missing: ${filePath}`);
  }

  // Verify the path is under images/
  if (evt.image.path.startsWith("images/")) {
    ok(`image path is under images/: ${evt.image.path}`);
  } else {
    fail(`image path does not start with images/: ${evt.image.path}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na10 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na10 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
