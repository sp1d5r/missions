/**
 * a9 — Restart-safe 'started' emission.
 *
 * When a daemon process restarts and calls writeActive() for a mission whose
 * record is already on disk with the same status, it must NOT emit 'started'
 * again.  The fix is to read the prior on-disk record before writing so that
 * the dedup guard sees the real previous state even across process restarts.
 *
 * Strategy: write a record to disk directly (bypassing registry so no frame is
 * emitted), then call writeActive() with the same status and assert that zero
 * frames arrive.
 */

import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "missions-blr-home-"));
process.env.MISSIONS_HOME = HOME;

const { drainFrames, orgSocketPath } = await import("../dist/ipc.js");
const { writeActive, removeActive } = await import("../dist/registry.js");

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
async function checkAsync(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg ?? "assertion failed");
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

function startCollector(socketPath, count, timeoutMs = 600) {
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
// a9 — Restart-safe: re-writing same status must NOT emit 'started'
// ---------------------------------------------------------------------------

await checkAsync("re-writing same status on a fresh process does NOT emit started", async () => {
	cleanSock();

	// Simulate a pre-existing on-disk record (written by a prior process run).
	// We write it directly to the active dir WITHOUT going through writeActive,
	// so no in-memory cache is populated and no frame is emitted.
	const activeDir = join(HOME, "active");
	mkdirSync(activeDir, { recursive: true });
	const existingRecord = rec("restart-1", "working", false);
	writeFileSync(join(activeDir, "restart-1.json"), JSON.stringify(existingRecord, null, 2));

	// Now start a socket collector — simulating the daemon restarting.
	// A re-started process has an empty _lastStatus cache.
	const col = startCollector(SOCK, 1, 600); // only expect 0 frames; will timeout
	await new Promise((r) => setTimeout(r, 30)); // give server time to bind

	// A "restarted daemon" calls writeActive with the SAME status that's already on disk.
	writeActive(rec("restart-1", "working", false));

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 0, `expected 0 frames (no change), got ${frames.length}: ${JSON.stringify(frames)}`);
});

await checkAsync("re-writing different status on a fresh process DOES emit status", async () => {
	cleanSock();

	// Pre-existing on-disk record at status "planning".
	const activeDir = join(HOME, "active");
	mkdirSync(activeDir, { recursive: true });
	const existingRecord = rec("restart-2", "planning", false);
	writeFileSync(join(activeDir, "restart-2.json"), JSON.stringify(existingRecord, null, 2));

	// Now the restarted process writes with a DIFFERENT status.
	const col = startCollector(SOCK, 1);
	await new Promise((r) => setTimeout(r, 30));

	writeActive(rec("restart-2", "working", false));

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 1, `expected 1 frame, got ${frames.length}`);
	// It's a status change, not a fresh start, so event must be 'status' not 'started'.
	assertEqual(frames[0].event, "status", `expected 'status', got '${frames[0].event}'`);
	assertEqual(frames[0].status, "working");
});

await checkAsync("first-ever writeActive (no prior file) still emits started", async () => {
	cleanSock();

	const col = startCollector(SOCK, 1);
	await new Promise((r) => setTimeout(r, 30));

	writeActive(rec("restart-3", "planning", false));

	const frames = await col.promise;
	await col.close();

	assertEqual(frames.length, 1, `expected 1 frame, got ${frames.length}`);
	assertEqual(frames[0].event, "started", `expected 'started', got '${frames[0].event}'`);
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
console.log("\nall board-live-restart tests passed");
