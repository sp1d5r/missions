#!/usr/bin/env node
/**
 * Two-capture test: verifies that the browser singleton is reused across
 * multiple captures in the same process (getBrowserInstanceCountForTest() === 1).
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool, closeBrowser, getBrowserInstanceCountForTest } = await import(
  join(repoRoot, "dist/worker/tools/screenshot.js")
);

let failures = 0;
function fail(msg) { console.error(`FAIL: ${msg}`); failures++; }
function ok(msg) { console.log(`ok:   ${msg}`); }

const tool = createScreenshotTool();

const url = "data:text/html,<h1>test1</h1>";

console.log("Capture 1...");
await tool.execute("call-1", { url });
console.log("Capture 2...");
await tool.execute("call-2", { url });

const count = getBrowserInstanceCountForTest();
console.log(`Browser launch count: ${count}`);

if (count === 1) {
  ok("getBrowserInstanceCountForTest() === 1 (browser reused across two captures)");
} else {
  fail(`getBrowserInstanceCountForTest() === ${count}, expected 1 (browser should be reused)`);
}

await closeBrowser();

if (failures > 0) {
  console.error(`\nFAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\nALL ASSERTIONS PASSED`);
  process.exit(0);
}
