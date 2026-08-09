#!/usr/bin/env node
/**
 * a14 — Screenshot tool distinct content test.
 *
 * Asserts: the screenshot tool captures a PNG whose dimensions/content reflect
 * the target URL (not a fixed placeholder). Capturing two distinct HTML pages
 * produces two PNGs with different content hashes.
 *
 * Strategy:
 *   1. Create two visually distinct HTML pages (different background color,
 *      different text).
 *   2. Take a screenshot of each.
 *   3. Compute SHA-256 of each PNG buffer.
 *   4. Assert the hashes differ — proving the captured content reflects the URL.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool } = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

// ---------------------------------------------------------------------------
// Two visually distinct pages
// ---------------------------------------------------------------------------
const URL_A = "data:text/html,<html><body style='background:%23ff0000;color:%23000000'><h1 style='font-size:80px'>PAGE A</h1></body></html>";
const URL_B = "data:text/html,<html><body style='background:%230000ff;color:%23ffffff'><h1 style='font-size:80px'>PAGE B</h1></body></html>";

const buffers = [];

const tool = createScreenshotTool({
  attachImage: (data, mimeType) => {
    buffers.push({ data, mimeType });
  },
});

// ---------------------------------------------------------------------------
// Capture page A
// ---------------------------------------------------------------------------
try {
  await tool.run({ url: URL_A, width: 800, height: 600 });
  ok("Screenshot of page A captured");
} catch (err) {
  fail(`tool.run() for page A threw: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Capture page B
// ---------------------------------------------------------------------------
try {
  await tool.run({ url: URL_B, width: 800, height: 600 });
  ok("Screenshot of page B captured");
} catch (err) {
  fail(`tool.run() for page B threw: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

if (buffers.length === 2) {
  ok("Two attachImage calls received (one per page)");
} else {
  fail(`Expected 2 attachImage calls, got ${buffers.length}`);
  process.exit(1);
}

const [bufA, bufB] = buffers;

// Both should be valid PNG buffers
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const [label, buf] of [["A", bufA], ["B", bufB]]) {
  if (Buffer.isBuffer(buf.data) && buf.data.length >= 8) {
    ok(`Page ${label}: buffer is a valid Buffer of ${buf.data.length} bytes`);
  } else {
    fail(`Page ${label}: buffer is invalid — type=${typeof buf.data}, length=${buf.data?.length}`);
  }

  if (buf.data.slice(0, 8).equals(PNG_MAGIC)) {
    ok(`Page ${label}: buffer starts with PNG magic`);
  } else {
    fail(`Page ${label}: buffer does not start with PNG magic`);
  }
}

// Content hashes must differ
const hashA = createHash("sha256").update(bufA.data).digest("hex");
const hashB = createHash("sha256").update(bufB.data).digest("hex");

ok(`Hash of page A: ${hashA.slice(0, 16)}...`);
ok(`Hash of page B: ${hashB.slice(0, 16)}...`);

if (hashA !== hashB) {
  ok("Page A and page B produce different content hashes — screenshots reflect actual URL content");
} else {
  fail("Page A and page B produced IDENTICAL content hashes — screenshot tool returned a fixed placeholder instead of real content");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na14 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na14 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
