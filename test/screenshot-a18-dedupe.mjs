#!/usr/bin/env node
/**
 * a18 — attachImage deduplication test.
 *
 * Asserts: when both opts.attachImage and ctx.attachImage are provided, only
 * ONE of them is called (ctx wins). When only one is provided, that one is
 * called. The same image must never be passed to both callbacks.
 *
 * Exit 0 on success, 1 on failure.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { createScreenshotTool, closeBrowser } = await import(join(repoRoot, "dist/worker/tools/screenshot.js"));

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function ok(msg) {
  console.log(`ok:   ${msg}`);
}

const TARGET_URL = "data:text/html,<html><body style='background:%23eee'><h1>a18 dedupe</h1></body></html>";

// ---------------------------------------------------------------------------
// Test 1: Both opts.attachImage AND ctx.attachImage provided — only ctx called
// ---------------------------------------------------------------------------
{
  let optsCalls = 0;
  let ctxCalls = 0;

  const tool = createScreenshotTool({
    attachImage: (_data, _mimeType) => {
      optsCalls++;
    },
  });

  await tool.run({ url: TARGET_URL, width: 320, height: 240 }, {
    attachImage: (_mimeType, _data) => {
      ctxCalls++;
    },
  });

  if (ctxCalls === 1) {
    ok("Test 1: ctx.attachImage was called exactly once");
  } else {
    fail(`Test 1: ctx.attachImage was called ${ctxCalls} times, expected 1`);
  }

  if (optsCalls === 0) {
    ok("Test 1: opts.attachImage was NOT called when ctx.attachImage is present (deduplicated)");
  } else {
    fail(`Test 1: opts.attachImage was called ${optsCalls} times, expected 0 (should be deduplicated)`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: Only opts.attachImage provided — it IS called
// ---------------------------------------------------------------------------
{
  let optsCalls = 0;

  const tool = createScreenshotTool({
    attachImage: (_data, _mimeType) => {
      optsCalls++;
    },
  });

  await tool.run({ url: TARGET_URL, width: 320, height: 240 });

  if (optsCalls === 1) {
    ok("Test 2: opts.attachImage was called exactly once when no ctx callback");
  } else {
    fail(`Test 2: opts.attachImage was called ${optsCalls} times, expected 1`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Only ctx.attachImage provided — it IS called
// ---------------------------------------------------------------------------
{
  let ctxCalls = 0;

  const tool = createScreenshotTool({});

  await tool.run({ url: TARGET_URL, width: 320, height: 240 }, {
    attachImage: (_mimeType, _data) => {
      ctxCalls++;
    },
  });

  if (ctxCalls === 1) {
    ok("Test 3: ctx.attachImage was called exactly once when no opts callback");
  } else {
    fail(`Test 3: ctx.attachImage was called ${ctxCalls} times, expected 1`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Neither callback — no error thrown, image still returned
// ---------------------------------------------------------------------------
{
  const tool = createScreenshotTool({});

  let result;
  try {
    result = await tool.run({ url: TARGET_URL, width: 320, height: 240 });
    ok("Test 4: No callback, no error — tool ran successfully");
  } catch (err) {
    fail(`Test 4: tool.run() threw unexpectedly: ${err.message}`);
  }

  const imgPart = result?.content?.find((c) => c.type === "image");
  if (imgPart?.source?.data) {
    ok("Test 4: image part returned in result content");
  } else {
    fail("Test 4: no image part in result content");
  }
}

// ---------------------------------------------------------------------------
// Test 5: ctx callback receives correct argument order: (data, mimeType)
// Both ctx and opts now use the same unified (data: Buffer, mimeType: string) signature.
// ---------------------------------------------------------------------------
{
  let receivedArgs;

  const tool = createScreenshotTool({});

  await tool.run({ url: TARGET_URL, width: 320, height: 240 }, {
    attachImage: (data, mimeType) => {
      receivedArgs = { data, mimeType };
    },
  });

  if (Buffer.isBuffer(receivedArgs?.data) && receivedArgs.data.length > 0) {
    ok("Test 5: ctx.attachImage first arg is a non-empty Buffer (unified data-first signature)");
  } else {
    fail(`Test 5: ctx.attachImage first arg is not a Buffer: ${typeof receivedArgs?.data}`);
  }

  if (typeof receivedArgs?.mimeType === "string" && receivedArgs.mimeType.startsWith("image/")) {
    ok("Test 5: ctx.attachImage second arg is mimeType string (unified data-first signature)");
  } else {
    fail(`Test 5: ctx.attachImage second arg is not a mimeType string: ${JSON.stringify(receivedArgs?.mimeType)}`);
  }
}

// ---------------------------------------------------------------------------
// Test 6: opts callback receives correct argument order: (buffer, mimeType)
// ---------------------------------------------------------------------------
{
  let receivedArgs;

  const tool = createScreenshotTool({
    attachImage: (data, mimeType) => {
      receivedArgs = { data, mimeType };
    },
  });

  await tool.run({ url: TARGET_URL, width: 320, height: 240 });

  if (Buffer.isBuffer(receivedArgs?.data) && receivedArgs.data.length > 0) {
    ok("Test 6: opts.attachImage first arg is a non-empty Buffer");
  } else {
    fail(`Test 6: opts.attachImage first arg is not a Buffer: ${typeof receivedArgs?.data}`);
  }

  if (typeof receivedArgs?.mimeType === "string" && receivedArgs.mimeType.startsWith("image/")) {
    ok("Test 6: opts.attachImage second arg is mimeType string");
  } else {
    fail(`Test 6: opts.attachImage second arg is not a mimeType string: ${JSON.stringify(receivedArgs?.mimeType)}`);
  }
}

// ---------------------------------------------------------------------------
// Close browser to release handles
// ---------------------------------------------------------------------------
await closeBrowser();
ok("closeBrowser() completed");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\na18 FAILED with ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log(`\na18 ALL ASSERTIONS PASSED`);
  process.exit(0);
}
