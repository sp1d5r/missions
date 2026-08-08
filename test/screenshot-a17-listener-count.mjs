#!/usr/bin/env node
/**
 * a17 — SIGINT/SIGTERM listener-count test.
 *
 * Asserts: the SIGINT and SIGTERM handlers are registered exactly once at
 * module load time (not once per getBrowser() call or per tool instance),
 * so that importing the screenshot module does not accumulate duplicate signal
 * listeners across multiple imports or tool invocations.
 *
 * Strategy:
 *   1. Record the SIGINT/SIGTERM listener counts before importing the module.
 *   2. Import the module (which registers exactly one handler per signal at
 *      module top-level using process.once()).
 *   3. Assert the counts increased by exactly 1 each.
 *   4. Import again (should be a no-op due to ESM module caching).
 *   5. Assert the counts did NOT increase further.
 *   6. Create multiple tool instances — listener count must stay the same.
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
// First import — should register exactly one listener per signal
// ---------------------------------------------------------------------------
const screenshotModule = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

const sigintAfterFirst = process.listenerCount("SIGINT");
const sigtermAfterFirst = process.listenerCount("SIGTERM");

console.log(`After 1st import: SIGINT listeners = ${sigintAfterFirst}, SIGTERM listeners = ${sigtermAfterFirst}`);

if (sigintAfterFirst === sigintBefore + 1) {
  ok("SIGINT listener count increased by exactly 1 after first import");
} else {
  fail(`SIGINT listener count changed by ${sigintAfterFirst - sigintBefore}, expected 1 (before=${sigintBefore}, after=${sigintAfterFirst})`);
}

if (sigtermAfterFirst === sigtermBefore + 1) {
  ok("SIGTERM listener count increased by exactly 1 after first import");
} else {
  fail(`SIGTERM listener count changed by ${sigtermAfterFirst - sigtermBefore}, expected 1 (before=${sigtermBefore}, after=${sigtermAfterFirst})`);
}

// ---------------------------------------------------------------------------
// Second import (ESM cache) — must NOT add more listeners
// ---------------------------------------------------------------------------
await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

const sigintAfterSecond = process.listenerCount("SIGINT");
const sigtermAfterSecond = process.listenerCount("SIGTERM");

console.log(`After 2nd import: SIGINT listeners = ${sigintAfterSecond}, SIGTERM listeners = ${sigtermAfterSecond}`);

if (sigintAfterSecond === sigintAfterFirst) {
  ok("SIGINT listener count did not increase on second import (ESM cache, registered once)");
} else {
  fail(`SIGINT listener count increased from ${sigintAfterFirst} to ${sigintAfterSecond} on second import — handler registered multiple times`);
}

if (sigtermAfterSecond === sigtermAfterFirst) {
  ok("SIGTERM listener count did not increase on second import (ESM cache, registered once)");
} else {
  fail(`SIGTERM listener count increased from ${sigtermAfterFirst} to ${sigtermAfterSecond} on second import — handler registered multiple times`);
}

// ---------------------------------------------------------------------------
// Create multiple tool instances — listener count must not increase further
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
