#!/usr/bin/env node
/**
 * a17 — SIGINT/SIGTERM listener-count test.
 *
 * Asserts: importing the screenshot module does NOT register any SIGINT or
 * SIGTERM listeners at module load time (the module no longer installs
 * module-scope signal handlers). Signal handling is left to Playwright's own
 * cleanup plus the exported closeBrowser() that callers invoke on shutdown.
 *
 * Strategy:
 *   1. Record the SIGINT/SIGTERM listener counts before importing the module.
 *   2. Import the module — counts must NOT change.
 *   3. Import again (ESM cache) — counts still must not change.
 *   4. Create multiple tool instances — listener count must stay the same.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
// Capture baseline listener counts before importing the screenshot module
// ---------------------------------------------------------------------------
const sigintBefore = process.listenerCount("SIGINT");
const sigtermBefore = process.listenerCount("SIGTERM");

console.log(`Before import: SIGINT listeners = ${sigintBefore}, SIGTERM listeners = ${sigtermBefore}`);

// ---------------------------------------------------------------------------
// First import — must NOT register any signal listeners
// ---------------------------------------------------------------------------
const screenshotModule = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

const sigintAfterFirst = process.listenerCount("SIGINT");
const sigtermAfterFirst = process.listenerCount("SIGTERM");

console.log(`After 1st import: SIGINT listeners = ${sigintAfterFirst}, SIGTERM listeners = ${sigtermAfterFirst}`);

if (sigintAfterFirst === sigintBefore) {
  ok("SIGINT listener count did not change after first import (no module-scope handler)");
} else {
  fail(`SIGINT listener count changed by ${sigintAfterFirst - sigintBefore}, expected 0 (before=${sigintBefore}, after=${sigintAfterFirst})`);
}

if (sigtermAfterFirst === sigtermBefore) {
  ok("SIGTERM listener count did not change after first import (no module-scope handler)");
} else {
  fail(`SIGTERM listener count changed by ${sigtermAfterFirst - sigtermBefore}, expected 0 (before=${sigtermBefore}, after=${sigtermAfterFirst})`);
}

// ---------------------------------------------------------------------------
// Second import (ESM cache) — must NOT add any listeners
// ---------------------------------------------------------------------------
await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

const sigintAfterSecond = process.listenerCount("SIGINT");
const sigtermAfterSecond = process.listenerCount("SIGTERM");

console.log(`After 2nd import: SIGINT listeners = ${sigintAfterSecond}, SIGTERM listeners = ${sigtermAfterSecond}`);

if (sigintAfterSecond === sigintBefore) {
  ok("SIGINT listener count did not change on second import (no module-scope handler)");
} else {
  fail(`SIGINT listener count changed from ${sigintBefore} to ${sigintAfterSecond} on second import — unexpected handler registered`);
}

if (sigtermAfterSecond === sigtermBefore) {
  ok("SIGTERM listener count did not change on second import (no module-scope handler)");
} else {
  fail(`SIGTERM listener count changed from ${sigtermBefore} to ${sigtermAfterSecond} on second import — unexpected handler registered`);
}

// ---------------------------------------------------------------------------
// Create multiple tool instances — listener count must not increase
// ---------------------------------------------------------------------------
const { createScreenshotTool } = screenshotModule;

const sigintBeforeInstances = process.listenerCount("SIGINT");
const sigtermBeforeInstances = process.listenerCount("SIGTERM");

// Create three tool instances
const tool1 = createScreenshotTool({});
const tool2 = createScreenshotTool({ defaultWidth: 800 });
const tool3 = createScreenshotTool({ defaultHeight: 600 });

const sigintAfterInstances = process.listenerCount("SIGINT");
const sigtermAfterInstances = process.listenerCount("SIGTERM");

console.log(`After creating 3 tool instances: SIGINT listeners = ${sigintAfterInstances}, SIGTERM listeners = ${sigtermAfterInstances}`);

if (sigintAfterInstances === sigintBeforeInstances) {
  ok("SIGINT listener count did not increase when creating multiple tool instances");
} else {
  fail(`SIGINT listener count increased by ${sigintAfterInstances - sigintBeforeInstances} when creating tool instances — listeners leaking per instance`);
}

if (sigtermAfterInstances === sigtermBeforeInstances) {
  ok("SIGTERM listener count did not increase when creating multiple tool instances");
} else {
  fail(`SIGTERM listener count increased by ${sigtermAfterInstances - sigtermBeforeInstances} when creating tool instances — listeners leaking per instance`);
}

// Prevent unused variable warnings
void tool1; void tool2; void tool3;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na17 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na17 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
