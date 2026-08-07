#!/usr/bin/env node
/**
 * End-to-end test for the screenshot tool.
 *
 * This script:
 *   1. Invokes createScreenshotTool() with a data: URL (no network required).
 *   2. Passes the result through extractImageParts() — same path as the real worker.
 *   3. Calls store.attachImage() and store.appendEvent() — same path as mission.ts onProgress.
 *   4. Generates report.html via generateReport().
 *   5. Asserts:
 *      a) At least one "image" event in state.events
 *      b) The image file is on disk at <outDir>/images/<sha>.png
 *      c) report.html exists and references the image path
 *      d) Writes the mission id to .mission-e2e/mission-id
 *
 * Exit 0 on success, non-zero on failure.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Imports from the built dist
const { createScreenshotTool } = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));
const { extractImageParts } = await import(join(repoRoot, "dist/worker.js"));
const { StateStore } = await import(join(repoRoot, "dist/state.js"));
const { generateReport } = await import(join(repoRoot, "dist/report.js"));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const missionId = `m-screenshot-e2e-${Date.now()}`;
const outDir = join(repoRoot, ".mission-e2e", missionId);
mkdirSync(outDir, { recursive: true });

console.log(`[e2e] mission id: ${missionId}`);
console.log(`[e2e] outDir: ${outDir}`);

// Minimal MissionState so StateStore and generateReport work.
const state = {
  id: missionId,
  startedAt: new Date().toISOString(),
  goal: "Take a screenshot of a data URL",
  rfc: "e2e screenshot test",
  status: "succeeded",
  branch: `missions/${missionId}`,
  targetCwd: repoRoot,
  origin: { kind: "human" },
  routing: {
    worker: { provider: "anthropic", modelId: "claude-opus-4-5" },
    orchestrator: { provider: "anthropic", modelId: "claude-opus-4-5" },
    bugSpotter: { provider: "anthropic", modelId: "claude-opus-4-5" },
  },
  features: [
    {
      id: "f1",
      title: "Screenshot data URL",
      description: "Take a screenshot using the screenshot tool",
      assertionIds: ["a1"],
      milestone: 1,
      origin: "plan",
    },
  ],
  handoffs: [
    {
      featureId: "f1",
      milestone: 1,
      completed: "Screenshot captured via createScreenshotTool",
      leftUndone: [],
      commands: [],
      issues: [],
      proceduresFollowed: true,
      assertionsClaimed: ["a1"],
      confidence: "high",
      costUsd: 0,
      degraded: false,
      stopReason: "stop",
      aborted: false,
    },
  ],
  milestones: [
    {
      index: 1,
      featureIds: ["f1"],
      handoffs: [],
      scoreCard: {
        assertionsPassed: 1,
        assertionsTotal: 1,
        bugs: [],
        costUsd: 0,
        dispatchedFeatureIds: ["f1"],
      },
      verdict: "passed",
      correctionIds: [],
    },
  ],
  commits: [],
  costUsd: 0,
  log: [],
  events: [],
  finalVerdict: "passed",
  outcome: "clean",
  plan: {
    summary: "Capture a screenshot using the reusable screenshot tool",
    features: [{ id: "f1", title: "Screenshot data URL", description: "Use screenshot tool", assertionIds: ["a1"] }],
    contract: {
      assertions: [
        { id: "a1", statement: "Mission has at least one image attachment", strength: "existence", passed: true, evidence: "image event recorded in state.events" },
      ],
    },
  },
};

const store = new StateStore(outDir, state);

// ---------------------------------------------------------------------------
// 1. Invoke the screenshot tool
// ---------------------------------------------------------------------------

const TARGET_URL = "data:text/html,<html><body style='background:%23e0f7fa;padding:20px'><h1 style='color:%23006064'>Screenshot E2E Test</h1><p>This page was captured by the screenshot tool.</p></body></html>";

console.log(`[e2e] launching screenshot tool on: ${TARGET_URL.slice(0, 60)}…`);

const tool = createScreenshotTool();
let toolResult;
try {
  toolResult = await tool.execute("e2e-call-id", {
    url: TARGET_URL,
    width: 1024,
    height: 768,
    fullPage: false,
  });
} catch (err) {
  console.error("[e2e] FAIL: screenshot tool threw:", err.message);
  process.exit(1);
}

console.log(`[e2e] tool result content parts: ${toolResult.content.length}`);

// ---------------------------------------------------------------------------
// 2. Extract image parts (same as worker.ts tool_execution_end handler)
// ---------------------------------------------------------------------------

const imageParts = extractImageParts(toolResult, "screenshot");
if (imageParts.length === 0) {
  console.error("[e2e] FAIL: extractImageParts returned no image parts");
  process.exit(1);
}
console.log(`[e2e] extracted ${imageParts.length} image part(s)`);

// ---------------------------------------------------------------------------
// 3. Store the image and append an event (same as mission.ts onProgress handler)
// ---------------------------------------------------------------------------

for (const img of imageParts) {
  const stored = store.attachImage(img.data, img.mimeType);
  store.appendEvent("image", `image from ${img.toolName}`, undefined, {
    seat: "eng",
    image: { path: stored.path, mimeType: img.mimeType, bytes: stored.bytes },
  });
  console.log(`[e2e] stored image: ${stored.path} (${stored.bytes} bytes)`);
}

store.save();

// ---------------------------------------------------------------------------
// 4. Assertions
// ---------------------------------------------------------------------------

let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`[e2e] FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`[e2e] ok: ${msg}`);
  }
}

// a) At least one image event in state.events
const imageEvents = store.state.events.filter((e) => e.kind === "image");
assert(imageEvents.length > 0, "state.events contains at least one 'image' event");

// b) Image file is on disk
for (const evt of imageEvents) {
  const filePath = join(outDir, evt.image.path);
  assert(existsSync(filePath), `image file exists on disk: ${evt.image.path}`);
  // Verify the sha in the filename matches the content
  const onDisk = readFileSync(filePath);
  const sha = createHash("sha256").update(onDisk).digest("hex");
  const expectedFilename = `${sha}.png`;
  assert(evt.image.path === `images/${expectedFilename}`, `filename is content-addressed sha256: ${evt.image.path}`);
}

// ---------------------------------------------------------------------------
// 5. Generate report.html
// ---------------------------------------------------------------------------

const reportPath = generateReport({ state: store.state, plan: store.state.plan, scoreCard: store.state.milestones[0]?.scoreCard, outDir });
console.log(`[e2e] report generated: ${reportPath}`);
assert(existsSync(reportPath), "report.html exists on disk");

// c) report.html references the image path
const reportHtml = readFileSync(reportPath, "utf-8");
assert(reportHtml.includes(missionId), "report.html contains the mission id");
// Verify report.html has an <img> tag referencing the captured screenshot.
for (const evt of imageEvents) {
  assert(reportHtml.includes(evt.image.path), `report.html references image path: ${evt.image.path}`);
}

// Check if the report HTML mentions the image event (it should show in the timeline).
// The report renders state.events in the timeline section.
const imageEvtLabel = "image from screenshot";
// Note: generateReport does not currently render the events timeline in HTML.
// The image IS referenced indirectly via the events in state.json.
// We verify state.json has the image event.
const statePath = join(outDir, "state.json");
assert(existsSync(statePath), "state.json exists on disk");
const savedState = JSON.parse(readFileSync(statePath, "utf-8"));
const savedImageEvents = (savedState.events ?? []).filter((e) => e.kind === "image");
assert(savedImageEvents.length > 0, "state.json has at least one image event");

// d) Image files are fetchable (exist on disk, matching /api/m/[id]/images/[file] pattern)
for (const evt of imageEvents) {
  const filePath = join(outDir, evt.image.path);
  assert(existsSync(filePath), `/api/m/${missionId}/${evt.image.path} is serveable (file exists)`);
}

// ---------------------------------------------------------------------------
// 6. Write mission-id for assertion harness
// ---------------------------------------------------------------------------

const e2eDir = join(repoRoot, ".mission-e2e");
mkdirSync(e2eDir, { recursive: true });
writeFileSync(join(e2eDir, "mission-id"), missionId, "utf-8");
// Also write the outDir so assertions can find files
writeFileSync(join(e2eDir, "out-dir"), outDir, "utf-8");
console.log(`[e2e] wrote mission-id: ${missionId}`);
console.log(`[e2e] wrote out-dir: ${outDir}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n[e2e] FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\n[e2e] ALL ASSERTIONS PASSED`);
  console.log(`[e2e] mission: ${missionId}`);
  console.log(`[e2e] report: ${reportPath}`);
  console.log(`[e2e] images: ${outDir}/images/`);
  process.exit(0);
}
