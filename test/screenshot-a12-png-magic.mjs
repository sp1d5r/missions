#!/usr/bin/env node
/**
 * a12 — Screenshot tool PNG magic bytes test.
 *
 * Asserts: invoking the screenshot tool by name from the worker tool registry
 * against a live HTTP URL produces a PNG buffer (>=8 bytes with PNG magic)
 * passed to attachImage.
 *
 * PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
 * (i.e. "\x89PNG\r\n\x1a\n")
 *
 * Strategy:
 *   1. Start a tiny HTTP server on localhost serving a minimal HTML page.
 *   2. Invoke the screenshot tool against http://localhost:<port>.
 *   3. Verify the buffer passed to attachImage starts with PNG magic.
 *   4. Shut down the server and let the process exit.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

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

// PNG magic bytes
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Start a local HTTP server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body><h1>a12 HTTP test</h1><p>Screenshot from live HTTP URL</p></body></html>");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const { port } = server.address();
const targetUrl = `http://127.0.0.1:${port}/`;
ok(`local HTTP server listening on ${targetUrl}`);

// ---------------------------------------------------------------------------
// Invoke the screenshot tool against the live HTTP URL
// ---------------------------------------------------------------------------
let capturedData = null;
let capturedMimeType = null;

const tool = createScreenshotTool({
  attachImage: (data, mimeType) => {
    capturedData = data;
    capturedMimeType = mimeType;
  },
});

try {
  await tool.run({ url: targetUrl, width: 640, height: 480 });
  ok("tool.run() against live HTTP URL resolved without throwing");
} catch (err) {
  fail(`tool.run() threw: ${err.message}`);
  server.close();
  process.exit(1);
}

// Shut down the server before assertions
server.close();

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

if (capturedData !== null) {
  ok("attachImage was called with data");
} else {
  fail("attachImage was never called — no PNG buffer received");
}

if (capturedData !== null) {
  if (Buffer.isBuffer(capturedData)) {
    ok("attachImage data is a Buffer");
  } else {
    fail(`attachImage data is not a Buffer: ${typeof capturedData}`);
  }

  if (capturedData.length >= 8) {
    ok(`buffer is >= 8 bytes: ${capturedData.length} bytes`);
  } else {
    fail(`buffer is too small: ${capturedData.length} bytes (need at least 8 for PNG magic)`);
  }

  // Check PNG magic bytes
  const magic = capturedData.slice(0, 8);
  if (magic.equals(PNG_MAGIC)) {
    ok("buffer starts with PNG magic bytes (\\x89PNG\\r\\n\\x1a\\n)");
  } else {
    fail(`buffer does not start with PNG magic — got: ${magic.toString("hex")} expected: ${PNG_MAGIC.toString("hex")}`);
  }
}

if (capturedMimeType === "image/png") {
  ok("attachImage mimeType is 'image/png'");
} else {
  fail(`attachImage mimeType is '${capturedMimeType}', expected 'image/png'`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na12 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na12 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
