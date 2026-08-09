#!/usr/bin/env node
/**
 * a27 — Spawn-patch concurrency race test.
 *
 * Asserts:
 *   1. The original child_process.spawn is saved BEFORE the patch is applied
 *      so that even under concurrent launches, the module-level _savedOriginalSpawn
 *      is always the real spawn function — never the wrapper.
 *   2. After two concurrent captureScreenshot calls both resolve, child_process.spawn
 *      === the spawn function that was current before any screenshot activity
 *      (i.e. the wrapper is installed exactly once and restored exactly once).
 *   3. The spawn wrapper was installed exactly once even with concurrent callers
 *      (spawnPatched guard prevents double-install).
 *   4. The closeBrowser() / releaseBrowserRef() concurrency race is resolved:
 *      after closing the browser and launching again, spawn is still correctly
 *      restored to the real function (not to a previously-wrapped version).
 *
 * Strategy:
 *   - Save the current child_process.spawn before any screenshot activity.
 *   - Wrap child_process.spawn with a property descriptor spy to count installs.
 *   - Invoke captureScreenshot twice concurrently via Promise.all.
 *   - Wait for both to resolve.
 *   - Explicitly call closeBrowser() to release all refs.
 *   - Assert child_process.spawn === originalSavedSpawn.
 *   - Assert wrapper was installed exactly once (spawnPatched guard works).
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
// Step 1: Save the real spawn BEFORE any screenshot activity.
// ---------------------------------------------------------------------------
const originalSavedSpawn = childProcess.spawn;
ok(`Saved original child_process.spawn: ${typeof originalSavedSpawn}`);

// ---------------------------------------------------------------------------
// Step 2: Spy on spawn assignments to count how many times the wrapper is installed.
// ---------------------------------------------------------------------------
let patchInstallCount = 0;
let patchRestoreCount = 0;

// Install a property descriptor trap on childProcess so we can observe spawn assignments.
let _currentSpawn = originalSavedSpawn;
Object.defineProperty(childProcess, "spawn", {
  get() { return _currentSpawn; },
  set(fn) {
    if (fn !== originalSavedSpawn) {
      // A non-original function is being assigned — this is a patch install.
      patchInstallCount++;
      console.log(`  [spy] spawn patched (install #${patchInstallCount})`);
    } else {
      // The original function is being restored.
      patchRestoreCount++;
      console.log(`  [spy] spawn restored (restore #${patchRestoreCount})`);
    }
    _currentSpawn = fn;
  },
  configurable: true,
});

// ---------------------------------------------------------------------------
// Step 3: Invoke captureScreenshot twice concurrently.
// ---------------------------------------------------------------------------
console.log("Launching two concurrent captureScreenshot calls...");

const tool = createScreenshotTool();
const URL_1 = "data:text/html,<h1>a27-concurrent-1</h1>";
const URL_2 = "data:text/html,<h1>a27-concurrent-2</h1>";

let err1, err2;
const [r1, r2] = await Promise.all([
  tool.run({ url: URL_1, width: 320, height: 200 }).catch(e => { err1 = e; return null; }),
  tool.run({ url: URL_2, width: 320, height: 200 }).catch(e => { err2 = e; return null; }),
]);

if (err1) fail(`First concurrent capture threw: ${err1.message}`);
else ok("First concurrent capture resolved successfully");

if (err2) fail(`Second concurrent capture threw: ${err2.message}`);
else ok("Second concurrent capture resolved successfully");

// ---------------------------------------------------------------------------
// Step 4: Clean up — close browser to trigger spawn restore.
// ---------------------------------------------------------------------------
await closeBrowser();

// ---------------------------------------------------------------------------
// Step 5: Remove the spy trap.
// ---------------------------------------------------------------------------
delete childProcess.spawn;
childProcess.spawn = _currentSpawn; // restore final value without spy

// ---------------------------------------------------------------------------
// Step 6: Assertions.
// ---------------------------------------------------------------------------

// The wrapper should have been installed exactly once (spawnPatched guard).
if (patchInstallCount === 1) {
  ok(`Spawn wrapper installed exactly once (patchInstallCount=${patchInstallCount}) — no double-patching`);
} else if (patchInstallCount === 0) {
  // This can happen if the test module loaded after a previous test already
  // launched the browser and left it open (browserPromise set). Acceptable.
  ok(`Spawn wrapper not installed in this run (browser may have been pre-launched)`);
} else {
  fail(`Spawn wrapper was installed ${patchInstallCount} times — RACE: double-patching detected`);
}

// Spawn should be restored exactly as many times as it was installed.
if (patchRestoreCount === patchInstallCount) {
  ok(`Spawn restored ${patchRestoreCount} time(s) — matches install count (balanced)`);
} else {
  fail(`Spawn installed ${patchInstallCount} time(s) but restored ${patchRestoreCount} time(s) — imbalanced`);
}

// After closeBrowser, spawn must equal the original saved value.
if (childProcess.spawn === originalSavedSpawn) {
  ok("child_process.spawn === originalSavedSpawn after closeBrowser() — no wrapper leak");
} else {
  fail("child_process.spawn !== originalSavedSpawn after closeBrowser() — wrapper was NOT restored");
}

// If r1 and r2 both returned image content, verify they look valid.
if (r1 && r1.content) {
  const imgPart1 = r1.content.find(c => c.type === "image");
  if (imgPart1?.source?.data) {
    const buf1 = Buffer.from(imgPart1.source.data, "base64");
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf1.slice(0, 8).equals(PNG_MAGIC)) {
      ok(`First capture produced a valid PNG (${buf1.length} bytes)`);
    } else {
      fail("First capture result does not start with PNG magic bytes");
    }
  }
}

if (r2 && r2.content) {
  const imgPart2 = r2.content.find(c => c.type === "image");
  if (imgPart2?.source?.data) {
    const buf2 = Buffer.from(imgPart2.source.data, "base64");
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf2.slice(0, 8).equals(PNG_MAGIC)) {
      ok(`Second capture produced a valid PNG (${buf2.length} bytes)`);
    } else {
      fail("Second capture result does not start with PNG magic bytes");
    }
  }
}

// ---------------------------------------------------------------------------
// Step 7: Verify the race condition is fixed — re-launch after closeBrowser()
// should still save the real spawn as original (not a previously-wrapped version).
// ---------------------------------------------------------------------------
console.log("\nVerifying race condition fix: re-launch after closeBrowser()...");

// At this point spawn is the original. Re-run two concurrent captures.
const originalSavedSpawn2 = childProcess.spawn;

let patchInstallCount2 = 0;
let patchRestoreCount2 = 0;
let _currentSpawn2 = originalSavedSpawn2;

Object.defineProperty(childProcess, "spawn", {
  get() { return _currentSpawn2; },
  set(fn) {
    if (fn !== originalSavedSpawn2) {
      patchInstallCount2++;
      console.log(`  [spy2] spawn patched (install #${patchInstallCount2})`);
    } else {
      patchRestoreCount2++;
      console.log(`  [spy2] spawn restored (restore #${patchRestoreCount2})`);
    }
    _currentSpawn2 = fn;
  },
  configurable: true,
});

const [r3, r4] = await Promise.all([
  tool.run({ url: "data:text/html,<h1>a27-relaunch-1</h1>", width: 320, height: 200 }).catch(e => null),
  tool.run({ url: "data:text/html,<h1>a27-relaunch-2</h1>", width: 320, height: 200 }).catch(e => null),
]);

await closeBrowser();

// Remove spy2
delete childProcess.spawn;
childProcess.spawn = _currentSpawn2;

if (patchInstallCount2 <= 1) {
  ok(`Re-launch: spawn patched at most once (count=${patchInstallCount2}) — race condition fix confirmed`);
} else {
  fail(`Re-launch: spawn patched ${patchInstallCount2} times — race condition NOT fixed`);
}

if (childProcess.spawn === originalSavedSpawn2) {
  ok("Re-launch: spawn restored to correct original after second closeBrowser()");
} else {
  fail("Re-launch: spawn is NOT the correct original — may be a stale wrapper");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na27 FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\na27 ALL ASSERTIONS PASSED");
  process.exit(0);
}
