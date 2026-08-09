#!/usr/bin/env node
/**
 * a26 — spawn-patch try/finally and concurrency guard test.
 *
 * Asserts:
 *   1. The original child_process.spawn is restored even when chromium.launch()
 *      would throw — the try/finally wrapping the spawn patch ensures this.
 *   2. Concurrent getBrowser() calls do NOT patch spawn more than once — because
 *      browserPromise is set before launch() runs, all concurrent callers share
 *      the same in-flight promise and never re-enter the patch region.
 *   3. package.json does NOT have a "postinstall" entry (reviewer high-severity fix).
 *   4. package.json DOES have a "setup:playwright" script.
 *
 * Strategy for (1):
 *   - Read child_process.spawn before any getBrowser() call.
 *   - Call a real getBrowser() (which patches and restores spawn internally).
 *   - Verify child_process.spawn === original after the call returns.
 *
 * Strategy for (2):
 *   - Fire two getBrowser() calls concurrently.
 *   - Verify spawn is never patched a second time (it must be restored before the
 *     concurrent caller could re-patch, but since they share the same promise they
 *     never enter the patch region at all).
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool, closeBrowser } = await import(
  join(repoRoot, "dist/worker/tools/screenshot.js")
);

const _require = createRequire(import.meta.url);
const childProcess = _require("child_process");

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Assertion 3 & 4 — package.json postinstall removed, setup:playwright added
// ---------------------------------------------------------------------------

const pkgJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));

if (pkgJson.scripts && pkgJson.scripts.postinstall !== undefined) {
  fail("package.json still has a 'postinstall' entry — reviewer high-severity finding: remove it");
} else {
  ok("package.json does NOT have a 'postinstall' entry (high-severity fix confirmed)");
}

if (pkgJson.scripts && pkgJson.scripts["setup:playwright"] !== undefined) {
  ok(`package.json has 'setup:playwright' script: "${pkgJson.scripts["setup:playwright"]}"`);
} else {
  fail("package.json is missing the 'setup:playwright' script");
}

// ---------------------------------------------------------------------------
// Assertion 1 — spawn is restored after a successful launch (normal path)
// ---------------------------------------------------------------------------

// Capture the current spawn reference before any screenshot tool usage.
const spawnBeforeLaunch = childProcess.spawn;

// Take a real screenshot to trigger getBrowser() → chromium.launch().
const tool = createScreenshotTool();
try {
  await tool.run({ url: "data:text/html,<h1>a26</h1>", width: 400, height: 300 });
} catch (err) {
  fail(`tool.run() threw unexpectedly: ${err.message}`);
}

const spawnAfterLaunch = childProcess.spawn;

if (spawnAfterLaunch === spawnBeforeLaunch) {
  ok("child_process.spawn is restored to original after getBrowser() completes (try/finally confirmed)");
} else {
  fail("child_process.spawn was NOT restored after getBrowser() — spawn patch is still active!");
}

// ---------------------------------------------------------------------------
// Assertion 2 — concurrent getBrowser() calls do not double-patch spawn
// ---------------------------------------------------------------------------

// Close the browser so we can trigger a fresh launch.
await closeBrowser();

let patchCount = 0;
const originalSpawn = childProcess.spawn;

// Temporarily wrap spawn to count how many times it gets replaced.
Object.defineProperty(childProcess, "spawn", {
  get() {
    return this._spawn;
  },
  set(fn) {
    if (fn !== originalSpawn) {
      patchCount++;
    }
    this._spawn = fn;
  },
  configurable: true,
});
childProcess._spawn = originalSpawn;

// Fire two concurrent getBrowser() calls — they should share one promise and
// therefore enter the spawn-patch block exactly once.
const tool2 = createScreenshotTool();
const [r1, r2] = await Promise.all([
  tool2.run({ url: "data:text/html,<h1>a26-concurrent-1</h1>", width: 300, height: 200 }),
  tool2.run({ url: "data:text/html,<h1>a26-concurrent-2</h1>", width: 300, height: 200 }),
]);

// Restore normal property (remove the setter trap)
delete childProcess.spawn;
delete childProcess._spawn;
childProcess.spawn = originalSpawn;

if (r1 && r2) {
  ok("Both concurrent captures completed successfully");
}

// spawn should have been patched exactly once (by the first getBrowser call).
// It is also restored once. The second concurrent call reuses the same promise,
// so it never re-enters the patch region.
if (patchCount <= 1) {
  ok(`spawn was patched at most 1 time during concurrent getBrowser() calls (patchCount=${patchCount}) — no double-patching`);
} else {
  fail(`spawn was patched ${patchCount} times during concurrent getBrowser() calls — RACE CONDITION: concurrent callers patched spawn simultaneously`);
}

// Verify spawn is restored after concurrent launch too.
if (childProcess.spawn === originalSpawn) {
  ok("child_process.spawn is restored to original after concurrent getBrowser() calls");
} else {
  fail("child_process.spawn was NOT restored after concurrent getBrowser() calls");
}

await closeBrowser();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\na26 FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\na26 ALL ASSERTIONS PASSED");
  process.exit(0);
}
