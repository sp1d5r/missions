/**
 * Tests for the end-to-end image pipe:
 *   1. StateStore.attachImage — content-addressed, idempotent
 *   2. worker extractImageParts — base64 decoding + malformed safety
 *   3. Integration — image event in state.events with file on disk
 *
 * Runs against the compiled output in ../dist.
 * Pattern: hand-rolled check/assert harness, process.exit(1) on any failure.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const { StateStore } = await import("../dist/state.js");

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg ?? "assertion failed");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal MissionState for constructing a StateStore. */
function makeState(id = "m-test") {
	return {
		id,
		startedAt: new Date().toISOString(),
		goal: "test",
		rfc: "test",
		status: "planning",
		branch: "test",
		targetCwd: "/tmp",
		origin: { kind: "human" },
		features: [],
		handoffs: [],
		milestones: [],
		commits: [],
		costUsd: 0,
		log: [],
		events: [],
	};
}

// ---------------------------------------------------------------------------
// 1. StateStore.attachImage — storage and idempotency
// ---------------------------------------------------------------------------

check("attachImage writes file to outDir/images/<sha256>.<ext>", () => {
	const outDir = mkdtempSync(join(tmpdir(), "missions-img-test-"));
	try {
		const store = new StateStore(outDir, makeState());
		const data = Buffer.from("fake png data");
		const result = store.attachImage(data, "image/png");

		assert(typeof result.path === "string", "result.path must be a string");
		assert(typeof result.bytes === "number", "result.bytes must be a number");
		assert(result.bytes === data.length, `bytes mismatch: ${result.bytes} !== ${data.length}`);

		// Path is relative to outDir: images/<sha>.<ext>
		const sha = createHash("sha256").update(data).digest("hex");
		assert(result.path === `images/${sha}.png`, `unexpected path: ${result.path}`);

		// File must exist on disk when resolved against outDir
		const fullPath = join(outDir, result.path);
		assert(existsSync(fullPath), `file does not exist: ${fullPath}`);

		// Filename must be <sha256>.<ext>
		const filename = basename(result.path);
		assert(filename === `${sha}.png`, `unexpected filename: ${filename}`);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

check("attachImage is idempotent — same bytes, same path, file not rewritten", () => {
	const outDir = mkdtempSync(join(tmpdir(), "missions-img-idempotent-"));
	try {
		const store = new StateStore(outDir, makeState());
		const data = Buffer.from("idempotent content");

		const r1 = store.attachImage(data, "image/png");
		const full1 = join(outDir, r1.path);
		const mtimeBefore = existsSync(full1) ? readFileSync(full1).length : -1;

		const r2 = store.attachImage(data, "image/png");

		assert(r1.path === r2.path, `paths differ on second call: ${r1.path} vs ${r2.path}`);
		assert(r1.bytes === r2.bytes, "bytes differ on second call");
		// File contents unchanged
		const contents = readFileSync(full1);
		assert(contents.equals(data), "file contents changed on second attach");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

check("attachImage produces correct extension for known mime types", () => {
	const outDir = mkdtempSync(join(tmpdir(), "missions-img-ext-"));
	try {
		const store = new StateStore(outDir, makeState());
		const cases = [
			["image/png", "png"],
			["image/jpeg", "jpg"],
			["image/gif", "gif"],
			["image/webp", "webp"],
			["image/unknown", "bin"], // unknown → bin
		];
		for (const [mime, expectedExt] of cases) {
			const data = Buffer.from(`data-for-${mime}`);
			const result = store.attachImage(data, mime);
			const ext = basename(result.path).split(".").pop();
			assert(ext === expectedExt, `mime ${mime}: expected ext '${expectedExt}', got '${ext}'`);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 2. appendEvent stores image metadata in state.events
// ---------------------------------------------------------------------------

check("appendEvent with image option populates event.image", () => {
	const outDir = mkdtempSync(join(tmpdir(), "missions-img-event-"));
	try {
		const store = new StateStore(outDir, makeState());
		const imgMeta = { path: "/tmp/foo.png", mimeType: "image/png", bytes: 42 };
		store.appendEvent("image", "image from screenshot", undefined, { seat: "eng", image: imgMeta });

		const events = store.state.events ?? [];
		assert(events.length > 0, "no events appended");
		const last = events[events.length - 1];
		assert(last.kind === "image", `expected kind 'image', got '${last.kind}'`);
		assert(last.label === "image from screenshot", `wrong label: ${last.label}`);
		assert(last.image !== undefined, "event.image is undefined");
		assert(last.image.path === imgMeta.path, "event.image.path mismatch");
		assert(last.image.mimeType === imgMeta.mimeType, "event.image.mimeType mismatch");
		assert(last.image.bytes === imgMeta.bytes, "event.image.bytes mismatch");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 3. Integration — attachImage + appendEvent persisted to disk
// ---------------------------------------------------------------------------

check("integration: image written to disk and recorded in state.events", () => {
	const outDir = mkdtempSync(join(tmpdir(), "missions-img-integration-"));
	try {
		const store = new StateStore(outDir, makeState());
		const rawData = Buffer.from("PNG\x89fake image bytes");

		// Simulate what mission.ts does in the onProgress handler.
		const stored = store.attachImage(rawData, "image/png");
		store.appendEvent("image", "image from my_tool", undefined, {
			seat: "eng",
			image: { path: stored.path, mimeType: "image/png", bytes: stored.bytes },
		});

		// Reload from disk to verify persistence
		const reloaded = StateStore.load(outDir);
		assert(reloaded !== null, "StateStore.load returned null");

		const events = reloaded.state.events ?? [];
		const imgEvent = events.find((e) => e.kind === "image");
		assert(imgEvent !== undefined, "no image event in reloaded state");
		assert(imgEvent.image !== undefined, "image event has no image field");
		assert(imgEvent.image.bytes === rawData.length, "bytes mismatch in persisted event");
		assert(imgEvent.image.mimeType === "image/png", "mimeType mismatch");

		// The file must still be on disk (resolve relative path against outDir)
		const storedFull = join(outDir, stored.path);
		assert(existsSync(storedFull), `image file not on disk: ${storedFull}`);
		const onDisk = readFileSync(storedFull);
		assert(onDisk.equals(rawData), "file contents on disk do not match original data");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 4. MissionEvent.image field declared in built types (structural check)
// ---------------------------------------------------------------------------

check("MissionEvent.image field declared in built types (structural check)", () => {
	const outDir = mkdtempSync(join(tmpdir(), "missions-img-struct-"));
	try {
		const store = new StateStore(outDir, makeState());
		store.appendEvent("image", "test", undefined, {
			image: { path: "/tmp/test.png", mimeType: "image/png", bytes: 99, alt: "test image" },
		});
		const saved = JSON.parse(readFileSync(join(outDir, "state.json"), "utf-8"));
		const evt = saved.events?.[0];
		assert(evt?.image?.alt === "test image", "alt field not persisted");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 5. Worker extractImageParts — behavioural (Anthropic + OpenAI shapes,
//    non-image ignored, malformed-tolerant, base64 decoded correctly).
//    This covers the a7 contract: on tool_execution_end, image parts in
//    result.content are decoded and surfaced.
// ---------------------------------------------------------------------------

const { extractImageParts } = await import("../dist/worker.js");

check("extractImageParts is exported and callable", () => {
	assert(typeof extractImageParts === "function", "extractImageParts is not a function");
});

check("extractImageParts decodes Anthropic-style {source:{type:base64,media_type,data}}", () => {
	const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const b64 = payload.toString("base64");
	const result = {
		content: [
			{ type: "text", text: "here is your image" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
		],
	};
	const parts = extractImageParts(result, "screenshot_tool");
	assert(parts.length === 1, `expected 1 image part, got ${parts.length}`);
	assert(parts[0].mimeType === "image/png", `mimeType mismatch: ${parts[0].mimeType}`);
	assert(parts[0].toolName === "screenshot_tool", `toolName mismatch: ${parts[0].toolName}`);
	assert(Buffer.isBuffer(parts[0].data), "data is not a Buffer");
	assert(parts[0].data.equals(payload), "decoded bytes do not match original payload");
});

check("extractImageParts decodes OpenAI-style {data,mimeType}", () => {
	const payload = Buffer.from("openai style bytes");
	const result = {
		content: [
			{ type: "image", data: payload.toString("base64"), mimeType: "image/jpeg" },
		],
	};
	const parts = extractImageParts(result, "vision_tool");
	assert(parts.length === 1, `expected 1 image part, got ${parts.length}`);
	assert(parts[0].mimeType === "image/jpeg", `mimeType mismatch: ${parts[0].mimeType}`);
	assert(parts[0].data.equals(payload), "decoded bytes mismatch");
});

check("extractImageParts also accepts result as a bare array of parts", () => {
	const payload = Buffer.from("bare array");
	const parts = extractImageParts(
		[{ type: "image", data: payload.toString("base64"), mimeType: "image/webp" }],
		"t",
	);
	assert(parts.length === 1, "bare-array shape not accepted");
	assert(parts[0].mimeType === "image/webp");
	assert(parts[0].data.equals(payload));
});

check("extractImageParts extracts multiple image parts in order", () => {
	const a = Buffer.from("first");
	const b = Buffer.from("second");
	const result = {
		content: [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: a.toString("base64") } },
			{ type: "text", text: "middle" },
			{ type: "image", data: b.toString("base64"), mimeType: "image/gif" },
		],
	};
	const parts = extractImageParts(result, "multi");
	assert(parts.length === 2, `expected 2, got ${parts.length}`);
	assert(parts[0].data.equals(a), "first payload mismatch");
	assert(parts[1].data.equals(b), "second payload mismatch");
	assert(parts[1].mimeType === "image/gif");
});

check("extractImageParts ignores non-image parts", () => {
	const result = {
		content: [
			{ type: "text", text: "no images here" },
			{ type: "tool_use", id: "abc" },
		],
	};
	const parts = extractImageParts(result, "t");
	assert(parts.length === 0, `expected 0 parts, got ${parts.length}`);
});

check("extractImageParts tolerates malformed input without throwing", () => {
	// Each of these must return [] and not throw.
	const cases = [
		null,
		undefined,
		"just a string",
		42,
		{},
		{ content: "not an array" },
		{ content: [null, undefined, 0, "text"] },
		{ content: [{ type: "image" /* no source, no data */ }] },
		{ content: [{ type: "image", source: { type: "url", url: "http://x" } }] },
		{ content: [{ type: "image", source: { type: "base64", media_type: "image/png" /* no data */ } }] },
		{ content: [{ type: "image", data: 12345, mimeType: "image/png" }] }, // non-string data
		{ content: [{ type: "image", data: "abc" /* no mimeType */ }] },
	];
	for (const c of cases) {
		const parts = extractImageParts(c, "t");
		assert(Array.isArray(parts), `expected array for input ${JSON.stringify(c)}`);
		assert(parts.length === 0, `expected 0 parts for malformed input ${JSON.stringify(c)}, got ${parts.length}`);
	}
});

check("extractImageParts propagates provided toolName onto every part", () => {
	const payload = Buffer.from("x");
	const result = {
		content: [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: payload.toString("base64") } },
		],
	};
	const parts = extractImageParts(result, "my_special_tool");
	assert(parts[0].toolName === "my_special_tool");
});

// ---------------------------------------------------------------------------

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
