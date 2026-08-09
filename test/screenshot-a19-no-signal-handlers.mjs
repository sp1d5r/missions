#!/usr/bin/env node
/**
 * a19 — No module-scope signal handlers test.
 *
 * Asserts: the screenshot module does NOT install any SIGINT or SIGTERM
 * handlers at import time. Signal cleanup is delegated to Playwright's own
 * teardown and the exported closeBrowser() that callers invoke.
 *
 * This is a corrective test following the reviewer's a5 feedback that
 * module-scope signal handlers block reusability (a module imported in a
 * larger host process should not silently hijack signal handling).
 *
 * Strategy:
 *   1. Record SIGINT/SIGTERM listener counts.
 *   2. Import dist/worker/tools/screenshot.js.
 *   3. Assert counts are unchanged.
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

const sigintBefore = process.listenerCount("SIGINT");
const sigtermBefore = process.listenerCount("SIGTERM");

console.log(`Before import: SIGINT=${sigintBefore}, SIGTERM=${sigtermBefore}`);

await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

const sigintAfter = process.listenerCount("SIGINT");
const sigtermAfter = process.listenerCount("SIGTERM");

console.log(`After import:  SIGINT=${sigintAfter}, SIGTERM=${sigtermAfter}`);

if (sigintAfter === sigintBefore) {
  ok("No SIGINT listener added at module import (no module-scope handler)");
} else {
  fail(
    `SIGINT listener count changed by ${sigintAfter - sigintBefore} at import ` +
    `(before=${sigintBefore}, after=${sigintAfter}) — module-scope handler must be removed`
  );
}

if (sigtermAfter === sigtermBefore) {
  ok("No SIGTERM listener added at module import (no module-scope handler)");
} else {
  fail(
    `SIGTERM listener count changed by ${sigtermAfter - sigtermBefore} at import ` +
    `(before=${sigtermBefore}, after=${sigtermAfter}) — module-scope handler must be removed`
  );
}

if (failures > 0) {
  console.error(`\na19 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na19 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
