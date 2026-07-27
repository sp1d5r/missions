import { createServer, type Server, type Socket } from "node:net";
import { connect } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { drainFrames, encode } from "./ipc.js";
import type { Agent, AgentMessage } from "./pi.js";

/**
 * Live workers, addressable while they run.
 *
 * Until now a worker was a function call: `agent.prompt(task)` then `waitForIdle()`. You could
 * watch its log and nothing else. When one went wrong — and one did today, spending a milestone
 * trying to fix a harness bug inside the target repo — the only feedback path was to let it
 * finish, let validators fail, and let the orchestrator scope a correction. Slow, expensive, and
 * it arrives after the mistake is complete.
 *
 * pi's Agent already supports being spoken to mid-run:
 *   steer(msg)    injected after the current assistant turn finishes
 *   followUp(msg) injected when the agent would otherwise stop
 *
 * So a worker does not need to be aborted to be redirected. What was missing is a way to REACH
 * one from another process — `missions view` is a separate invocation from the mission runner.
 * This module is that: the mission process serves its live workers on a unix socket, and anything
 * that can open the socket (the overseer, the CLI, another agent) can list them, ask them a
 * question, or steer them.
 *
 * Deliberately not an abort-and-restart: aborting throws away the worker's in-context reasoning,
 * which is the expensive part. Steering keeps it.
 */

export interface WorkerInfo {
	id: string;
	missionId: string;
	featureId: string;
	title: string;
	startedAt: number;
	costUsd: number;
	lastActivity: string;
	/** Steers accepted so far. Surfaced so a handoff can record that it was redirected. */
	steers: string[];
}

export interface WorkerHandle {
	info: WorkerInfo;
	agent: Agent;
	/** Last few assistant text fragments, for a tail without replaying the whole transcript. */
	recent: string[];
}

const workers = new Map<string, WorkerHandle>();

export function workerSocketPath(missionId: string): string {
	return join(homedir(), ".missions", "workers", `${missionId}.sock`);
}

const userMsg = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as AgentMessage;

export function registerWorker(handle: WorkerHandle): () => void {
	workers.set(handle.info.id, handle);
	return () => workers.delete(handle.info.id);
}

export function listWorkers(): WorkerInfo[] {
	return [...workers.values()].map((w) => w.info);
}

/**
 * Inject an instruction into a running worker.
 *
 * Framed as coming from the operator and marked as overriding the current approach, because a
 * steer that reads like a suggestion gets acknowledged and ignored.
 */
export function steerWorker(id: string, instruction: string): { ok: boolean; detail: string } {
	const w = workers.get(id);
	if (!w) return { ok: false, detail: `no live worker "${id}"` };
	w.info.steers.push(instruction);
	w.agent.steer(
		userMsg(
			`OPERATOR STEER — this supersedes your current approach. Adjust now rather than finishing what you were doing and reconciling afterwards.\n\n${instruction}\n\nAcknowledge in one line what you are changing, then continue.`,
		),
	);
	return { ok: true, detail: `steered ${id}` };
}

/**
 * Ask a running worker a question and wait for its answer.
 *
 * `steer` is fire-and-forget, so the question carries a correlation tag and we watch the event
 * stream for an assistant message that echoes it. Times out rather than hanging, because a worker
 * deep in a long tool call may not reach a turn boundary for a while.
 */
export function askWorker(id: string, question: string, timeoutMs = 120_000): Promise<{ ok: boolean; detail: string }> {
	const w = workers.get(id);
	if (!w) return Promise.resolve({ ok: false, detail: `no live worker "${id}"` });

	const tag = `q${Math.floor(performance.now() * 1000) % 100000}`;
	return new Promise((resolve) => {
		let done = false;
		const finish = (ok: boolean, detail: string) => {
			if (done) return;
			done = true;
			unsubscribe();
			clearTimeout(timer);
			resolve({ ok, detail });
		};
		const timer = setTimeout(
			() => finish(false, `worker ${id} did not answer within ${Math.round(timeoutMs / 1000)}s — it may be mid tool call`),
			timeoutMs,
		);
		const unsubscribe = w.agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const text = (event.message.content as { type: string; text?: string }[])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n");
			if (text.includes(`[${tag}]`)) finish(true, text.slice(0, 4000));
		});
		w.agent.steer(
			userMsg(
				`OPERATOR QUESTION (${tag}). Answer it in your very next message, prefixed with [${tag}], then carry on with what you were doing. Do not change course unless the question implies you should.\n\n${question}`,
			),
		);
	});
}

/**
 * Put an idle worker back to work, keeping its context.
 *
 * `steer` is for a worker mid-run — it lands at the next turn boundary. A worker whose milestone
 * has stalled is already idle, so a steer would sit in its queue unread; it needs a new prompt on
 * the same agent, which continues the existing conversation rather than starting a fresh one. That
 * distinction is the whole value: the agent still holds the files it read and the reasoning it did.
 *
 * Returns its reply text, or null if there is no such worker.
 */
export async function resumeWorker(id: string, instruction: string): Promise<string | null> {
	const w = workers.get(id);
	if (!w) return null;
	w.info.lastActivity = "resumed by operator";
	try {
		await w.agent.prompt(
			`OPERATOR — your milestone did not pass and you are being resumed to fix it. You keep everything from before; do not start over.\n\n${instruction}\n\nMake the change, then state in one or two lines what you changed and how it can be verified.`,
		);
	} catch {
		// A resume that errors is reported as "no reply" rather than taking the mission down.
	}
	await w.agent.waitForIdle();
	return w.recent.slice(-1)[0] ?? "";
}

/**
 * Hold a stalled milestone open, waiting for an operator to steer one of its workers.
 *
 * A mission that says "STALLED — needs you" and then exits is telling you it needs you at the
 * exact moment it has stopped being able to hear you. Its workers still hold everything expensive
 * — the files they read, the reasoning they did, why they chose what they chose — and throwing
 * that away means the next attempt rediscovers it from a handoff paragraph.
 *
 * So the process stays up, serving its socket, until one of three things happens:
 *   - an operator steers a worker      → resolves with that worker's id, and the milestone retries
 *   - the wait times out               → resolves null, and the mission ends as it does today
 *   - nothing is alive to steer        → resolves null immediately
 *
 * The timeout matters: missions run unattended, and a stall that blocks forever would hold a
 * worktree and an API budget hostage waiting for someone who is asleep.
 */
export function awaitOperatorSteer(timeoutMs: number, onWaiting?: (secondsLeft: number) => void): Promise<string | null> {
	if (!workers.size) return Promise.resolve(null);
	const before = new Map([...workers].map(([id, w]) => [id, w.info.steers.length]));

	return new Promise((resolve) => {
		let done = false;
		const finish = (v: string | null) => {
			if (done) return;
			done = true;
			clearInterval(poll);
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		onWaiting?.(Math.round(timeoutMs / 1000));
		// Polled rather than event-driven: a steer can arrive through the socket handler, the CLI,
		// or the overseer, and all three land in the same place — one more entry in info.steers.
		const poll = setInterval(() => {
			for (const [id, w] of workers) {
				if (w.info.steers.length > (before.get(id) ?? 0)) return finish(id);
			}
		}, 500);
	});
}

// ── Serving them to other processes ───────────────────────────────────────────────────────────

interface Req {
	op: "list" | "ask" | "steer" | "tail";
	id?: string;
	text?: string;
}

/** Serve this process's live workers. Returns a stop function. */
export function serveWorkers(missionId: string): () => void {
	const path = workerSocketPath(missionId);
	mkdirSync(dirname(path), { recursive: true });
	rmSync(path, { force: true });

	const handle = async (req: Req): Promise<unknown> => {
		switch (req.op) {
			case "list":
				return listWorkers();
			case "steer":
				return steerWorker(req.id ?? "", req.text ?? "");
			case "ask":
				return await askWorker(req.id ?? "", req.text ?? "");
			case "tail": {
				const w = workers.get(req.id ?? "");
				return w ? w.recent.slice(-5) : [];
			}
			default:
				return { ok: false, detail: `unknown op` };
		}
	};

	let server: Server | undefined;
	try {
		server = createServer((sock: Socket) => {
			let buf = "";
			sock.on("data", async (chunk) => {
				buf += chunk.toString();
				const { frames, rest } = drainFrames(buf);
				buf = rest;
				for (const f of frames) {
					if (f.t !== "input") continue;
					let out: unknown;
					try {
						out = await handle(JSON.parse(f.text) as Req);
					} catch (err) {
						out = { ok: false, detail: err instanceof Error ? err.message : String(err) };
					}
					sock.write(encode({ t: "out", text: JSON.stringify(out) }));
				}
			});
			// A client that vanishes mid-question must not take the mission down with it.
			sock.on("error", () => {});
		});
		server.on("error", () => {});
		server.listen(path);
	} catch {
		// Serving workers is an affordance, never a requirement. A mission that cannot open a
		// socket still runs; you just cannot talk to it.
	}

	return () => {
		try {
			server?.close();
		} catch {
			/* ignore */
		}
		rmSync(path, { force: true });
	};
}

/** Call into a mission process's live workers from anywhere. */
export function workerClient(missionId: string) {
	const path = workerSocketPath(missionId);
	const call = (req: Req, timeoutMs = 130_000): Promise<unknown> =>
		new Promise((resolve) => {
			const sock = connect(path);
			let buf = "";
			const done = (v: unknown) => {
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
				resolve(v);
			};
			const timer = setTimeout(() => done({ ok: false, detail: "timed out talking to the mission process" }), timeoutMs);
			sock.on("connect", () => sock.write(encode({ t: "input", text: JSON.stringify(req) })));
			sock.on("data", (chunk) => {
				buf += chunk.toString();
				const { frames, rest } = drainFrames(buf);
				buf = rest;
				const out = frames.find((f) => f.t === "out");
				if (out) {
					clearTimeout(timer);
					try {
						done(JSON.parse(out.text));
					} catch {
						done({ ok: false, detail: "unreadable reply" });
					}
				}
			});
			sock.on("error", () => {
				clearTimeout(timer);
				done({ ok: false, detail: "no live mission process for that id (it may have finished)" });
			});
		});

	return {
		list: () => call({ op: "list" }, 5_000) as Promise<WorkerInfo[] | { ok: false; detail: string }>,
		tail: (id: string) => call({ op: "tail", id }, 5_000) as Promise<string[]>,
		steer: (id: string, text: string) => call({ op: "steer", id, text }, 10_000) as Promise<{ ok: boolean; detail: string }>,
		ask: (id: string, text: string) => call({ op: "ask", id, text }) as Promise<{ ok: boolean; detail: string }>,
	};
}
