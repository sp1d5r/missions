/**
 * a10 — Done-transition 'finished' emission.
 *
 * When writeActive() is called with done=true but the same status string as
 * the prior write (the mission stopped without changing its status field),
 * the dedup guard must NOT swallow the event — it must emit 'finished'.
 *
 * This covers the common pattern where a mission stays in e.g. "working" and
 * then marks itself done without going through a distinct terminal status.
 */

import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "missions-blf-home-"));
process.env.MISSIONS_HOME = HOME;

const { drainFrames, orgSocketPath } = await import("../dist/ipc.js");
const { writeActive, removeActive } = await import("../dist/registry.js");

let failures = 0;
async function checkAsync(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assertEqual(a, b, msg) {
	if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function rec(id, status, done = false) {
	return {
		id,
		repo: "/tmp/r",
		repoName: "r",
		goal: "g",
		status,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastActivity: "",
		costUsd: 0,
		done,
	};
}

const SOCK = orgSocketPath();

function cleanSock() {
	try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
}

function startCollector(socketPath, count, timeoutMs = 1500) {
	const received = [];
	let resolve;
	const promise = new Promise((res) => { resolve = res; });
	const server = createServer((sock) => {
		sock.setEncoding("utf-8");
		let buf = "";
		sock.on("data", (d) => {
			buf += d;
			const { frames, rest } = drainFrames(buf);
			buf = rest;
			for (const f of frames) {
				if (f.t === "mission") {
					received.push(f);
					if (received.length >= count) resolve();
				}
			}
		});
		sock.on("error", () => {});
	});
	server.listen(socketPath);
	const timer = setTimeout(() => resolve(), timeoutMs);
	server.on("error", () => resolve());
	return {
		promise: promise.then(() => { clearTimeout(timer); return received; }),
		close: () => new Promise((res) => { server.close(() => res()); }),
	};
}

// ---------------------------------------------------------------------------
// a10 — done flips false→true with SAME status → must emit 'finished'
// ---------------------------------------------------------------------------

await checkAsync("done flip false→true with same status emits finished", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2);
	await new Promise((r) => setTimeout(r, 30));

	writeActive(rec("finish-1", "working", false)); // → started
	writeActive(rec("finish-1", "working", true));  // same status, done flipped → finished

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 2, `expected 2 frames, got ${frames.length}: ${JSON.stringify(frames)}`);
	assertEqual(frames[0].event, "started", `first frame should be 'started'`);
	assertEqual(frames[1].event, "finished", `second frame should be 'finished', got '${frames[1].event}'`);
	assertEqual(frames[1].status, "working", `status should be 'working'`);
});

await checkAsync("status change to done-true emits finished (status also changes)", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2);
	await new Promise((r) => setTimeout(r, 30));

	writeActive(rec("finish-2", "working", false));      // → started
	writeActive(rec("finish-2", "succeeded", true));     // status changed + done → finished

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 2, `expected 2 frames, got ${frames.length}`);
	assertEqual(frames[0].event, "started");
	assertEqual(frames[1].event, "finished");
	assertEqual(frames[1].status, "succeeded");
});

await checkAsync("done flip true→true (already done) does NOT emit a second finished", async () => {
	cleanSock();
	// Collect for up to 800ms, expecting only 2 frames.
	const col = startCollector(SOCK, 3, 800);
	await new Promise((r) => setTimeout(r, 30));

	writeActive(rec("finish-3", "working", false));  // started
	writeActive(rec("finish-3", "working", true));   // finished
	writeActive(rec("finish-3", "working", true));   // same done=true, should be no-op

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 2, `expected exactly 2 frames, got ${frames.length}: ${JSON.stringify(frames.map(f => f.event))}`);
	assertEqual(frames[0].event, "started");
	assertEqual(frames[1].event, "finished");
});

await checkAsync("removeActive still emits removed regardless of done state", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2);
	await new Promise((r) => setTimeout(r, 30));

	writeActive(rec("finish-4", "working", true)); // started (done=true, no prior file)
	removeActive("finish-4");                       // → removed

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 2, `expected 2 frames, got ${frames.length}`);
	assertEqual(frames[1].event, "removed");
	assertEqual(frames[1].id, "finish-4");
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
cleanSock();
rmSync(HOME, { recursive: true, force: true });

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall board-live-finish tests passed");
