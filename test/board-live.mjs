/**
 * Tests for lifecycle frame round-trip through the daemon socket and
 * single-emission-per-transition guarantees on writeActive.
 *
 * Covers:
 * 1. The IPC frame union includes the 'mission' variant.
 * 2. writeActive emits exactly one frame when the status first appears.
 * 3. writeActive emits again only when the status actually changes.
 * 4. writeActive does NOT emit when called with the same status a second time.
 * 5. removeActive emits a 'removed' lifecycle frame.
 * 6. A lifecycle frame round-trips through the daemon socket: a client that
 *    connects receives the frame that another connection sent.
 *
 * Socket tests start a minimal in-process Unix socket server (not the full
 * daemon) to avoid depending on a running org.
 */

import { createServer, createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Redirect MISSIONS_HOME so live board is never touched.
const HOME = mkdtempSync(join(tmpdir(), "missions-bl-home-"));
process.env.MISSIONS_HOME = HOME;

const { encode, drainFrames } = await import("../dist/ipc.js");
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

// ---------------------------------------------------------------------------
// 1. IPC frame union includes the 'mission' variant
// ---------------------------------------------------------------------------

check("encode round-trips a mission lifecycle frame", () => {
	const frame = { t: "mission", event: "started", id: "m-test", at: 1000, status: "planning" };
	const encoded = encode(frame);
	const { frames } = drainFrames(encoded);
	assert(frames.length === 1, "expected one frame");
	const f = frames[0];
	assertEqual(f.t, "mission", "t");
	assertEqual(f.event, "started", "event");
	assertEqual(f.id, "m-test", "id");
	assertEqual(f.at, 1000, "at");
	assertEqual(f.status, "planning", "status");
});

check("encode round-trips a 'removed' mission frame (no status field)", () => {
	const frame = { t: "mission", event: "removed", id: "m-rm", at: 2000 };
	const encoded = encode(frame);
	const { frames } = drainFrames(encoded);
	assert(frames.length === 1, "expected one frame");
	const f = frames[0];
	assertEqual(f.t, "mission", "t");
	assertEqual(f.event, "removed", "event");
});

check("drainFrames handles multiple frames in one buffer", () => {
	const buf = [
		encode({ t: "mission", event: "started", id: "m-1", at: 1 }),
		encode({ t: "mission", event: "status", id: "m-1", at: 2, status: "working" }),
		encode({ t: "out", text: "hello" }),
	].join("");
	const { frames, rest } = drainFrames(buf);
	assertEqual(frames.length, 3, "expected 3 frames");
	assertEqual(frames[0].t, "mission");
	assertEqual(frames[1].t, "mission");
	assertEqual(frames[2].t, "out");
	assertEqual(rest, "", "no remainder");
});

// ---------------------------------------------------------------------------
// 2–5. writeActive emission semantics
//
// writeActive calls emitLifecycle which tries to connect to orgSocketPath().
// When the socket file is absent it silently no-ops. We test the count by
// tracking how many times a test socket receives a 'mission' frame.
// ---------------------------------------------------------------------------

/** Build a minimal record. */
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

/**
 * Start a small Unix socket server that collects all 'mission' frames it
 * receives, then resolves once `count` have arrived or `timeoutMs` elapses.
 * Returns { frames, close }.
 */
function startCollector(socketPath, count, timeoutMs = 1500) {
	const received = [];
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
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
		promise: promise.then(() => {
			clearTimeout(timer);
			return received;
		}),
		close: () =>
			new Promise((res) => {
				server.close(() => res());
			}),
	};
}

// Use the missions socket path that registry.ts reads.
import { orgSocketPath } from "../dist/ipc.js";
const SOCK = orgSocketPath();

// Helper: remove the socket if present so tests start clean.
import { unlinkSync, existsSync } from "node:fs";
function cleanSock() {
	try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
}

await checkAsync("writeActive emits exactly one frame on first status write", async () => {
	cleanSock();
	const col = startCollector(SOCK, 1);
	// Give the server a moment to listen before registry tries to connect.
	await new Promise((r) => setTimeout(r, 30));
	writeActive(rec("bl-1", "planning"));
	const frames = await col.promise;
	await col.close();
	assertEqual(frames.length, 1, `expected 1 frame, got ${frames.length}`);
	assertEqual(frames[0].event, "started", "first write → started");
	assertEqual(frames[0].id, "bl-1");
	assertEqual(frames[0].status, "planning");
});

await checkAsync("writeActive does NOT emit when status is unchanged", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2, 400); // only expect 1, wait 400ms for any extras
	await new Promise((r) => setTimeout(r, 30));
	writeActive(rec("bl-2", "planning")); // first write → should emit
	writeActive(rec("bl-2", "planning")); // same status → must NOT emit
	const frames = await col.promise;
	await col.close();
	assertEqual(frames.length, 1, `same-status rewrite emitted ${frames.length} frames (expected 1)`);
});

await checkAsync("writeActive emits again when status changes", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2);
	await new Promise((r) => setTimeout(r, 30));
	writeActive(rec("bl-3", "planning"));       // started
	writeActive(rec("bl-3", "working"));        // status change → emit
	const frames = await col.promise;
	await col.close();
	assertEqual(frames.length, 2, `expected 2 frames, got ${frames.length}`);
	assertEqual(frames[0].event, "started");
	assertEqual(frames[1].event, "status");
	assertEqual(frames[1].status, "working");
});

await checkAsync("writeActive emits 'finished' when done=true", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2);
	await new Promise((r) => setTimeout(r, 30));
	writeActive(rec("bl-4", "working", false));         // started
	writeActive(rec("bl-4", "succeeded", true));        // finished
	const frames = await col.promise;
	await col.close();
	assertEqual(frames.length, 2, `expected 2 frames, got ${frames.length}`);
	assertEqual(frames[1].event, "finished");
});

await checkAsync("removeActive emits a 'removed' frame", async () => {
	cleanSock();
	const col = startCollector(SOCK, 2);
	await new Promise((r) => setTimeout(r, 30));
	writeActive(rec("bl-5", "planning"));
	removeActive("bl-5");
	const frames = await col.promise;
	await col.close();
	assertEqual(frames.length, 2, `expected 2 frames, got ${frames.length}`);
	assertEqual(frames[1].event, "removed");
	assertEqual(frames[1].id, "bl-5");
});

await checkAsync("writeActive silently no-ops when daemon socket is absent", async () => {
	cleanSock(); // ensure socket file is gone
	// Should not throw even though the socket is missing.
	let threw = false;
	try {
		writeActive(rec("bl-nocrash", "planning"));
	} catch (err) {
		threw = true;
	}
	assert(!threw, "writeActive threw when socket was absent");
});

// ---------------------------------------------------------------------------
// 6. Frame round-trip through a minimal in-process daemon socket
// ---------------------------------------------------------------------------

await checkAsync("lifecycle frame round-trips through daemon socket to a second client", async () => {
	cleanSock();

	// Minimal daemon: receives frames, re-broadcasts 'mission' frames to other clients.
	const clients = new Set();
	const server = createServer((sock) => {
		sock.setEncoding("utf-8");
		clients.add(sock);
		let buf = "";
		sock.on("data", (d) => {
			buf += d;
			const { frames, rest } = drainFrames(buf);
			buf = rest;
			for (const f of frames) {
				if (f.t === "mission") {
					// broadcast to OTHER clients
					for (const c of clients) {
						if (c !== sock) {
							try { c.write(encode(f)); } catch {}
						}
					}
				}
			}
		});
		const drop = () => clients.delete(sock);
		sock.on("close", drop);
		sock.on("error", drop);
	});
	await new Promise((res) => server.listen(SOCK, res));

	// Subscriber: listens for mission frames.
	const received = [];
	const sub = await new Promise((res, rej) => {
		const s = createConnection(SOCK);
		s.setEncoding("utf-8");
		s.once("connect", () => res(s));
		s.once("error", rej);
	});

	let subBuf = "";
	const gotFrame = new Promise((res) => {
		sub.on("data", (d) => {
			subBuf += d;
			const { frames, rest } = drainFrames(subBuf);
			subBuf = rest;
			for (const f of frames) {
				if (f.t === "mission") {
					received.push(f);
					res();
				}
			}
		});
	});

	// Emitter: sends a lifecycle frame.
	const emitter = await new Promise((res, rej) => {
		const s = createConnection(SOCK);
		s.setEncoding("utf-8");
		s.once("connect", () => res(s));
		s.once("error", rej);
	});
	const testFrame = { t: "mission", event: "started", id: "m-rt", at: Date.now(), status: "planning" };
	emitter.write(encode(testFrame));

	await Promise.race([gotFrame, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);

	emitter.destroy();
	sub.destroy();
	await new Promise((res) => server.close(res));
	cleanSock();

	assertEqual(received.length, 1, `expected 1 frame, got ${received.length}`);
	assertEqual(received[0].t, "mission");
	assertEqual(received[0].event, "started");
	assertEqual(received[0].id, "m-rt");
	assertEqual(received[0].status, "planning");
});

// Cleanup
rmSync(HOME, { recursive: true, force: true });
cleanSock();

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall board-live tests passed");
