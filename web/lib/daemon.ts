/**
 * The console attaches to the org daemon as just another client.
 *
 * `src/daemon.ts` keeps a Set of sockets and broadcasts every line of chief
 * output to all of them, so the phone and the TUI watch one conversation rather
 * than two. That is the whole reason this is a socket client and not a second
 * chief: two chiefs would be two orgs.
 *
 * ONE RULE, AND IT MATTERS: never send `hello` casually. The daemon treats it
 * as `registerWorkspace(cwd)` + `session.setFocus(cwd)`, and focus is global.
 * A web client that says hello on connect would silently repoint the focus of
 * whatever terminal you had open. So `attach()` is read-only by construction,
 * and focus only moves when the operator asks for it in `setFocus()`.
 */
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { drainFrames, encode, orgSocketPath, type Frame } from "@missions/ipc.js";

export function socketPath(): string {
	return orgSocketPath();
}

export function daemonUp(): boolean {
	return existsSync(orgSocketPath());
}

function connect(): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const sock = createConnection(orgSocketPath());
		sock.setEncoding("utf-8");
		sock.once("connect", () => resolve(sock));
		sock.once("error", reject);
	});
}

/**
 * Attach and yield chief output as it arrives. Read-only: sends no frames at
 * all, so attaching from a phone cannot disturb a terminal.
 */
export async function* attach(signal: AbortSignal): AsyncGenerator<string> {
	const sock = await connect();
	signal.addEventListener("abort", () => sock.destroy(), { once: true });

	let buffer = "";
	const pending: string[] = [];
	let wake: (() => void) | null = null;
	let closed = false;

	sock.on("data", (chunk: string) => {
		buffer += chunk;
		const { frames, rest } = drainFrames(buffer);
		buffer = rest;
		for (const f of frames) if (f.t === "out") pending.push(f.text);
		wake?.();
	});
	const end = () => {
		closed = true;
		wake?.();
	};
	sock.on("close", end);
	sock.on("error", end);

	try {
		while (!closed && !signal.aborted) {
			if (pending.length === 0) {
				await new Promise<void>((r) => {
					wake = r;
				});
				wake = null;
				continue;
			}
			const next = pending.shift();
			if (next !== undefined) yield next;
		}
	} finally {
		sock.destroy();
	}
}

/** Send one frame and hang up. Output comes back on every attached stream. */
async function send(frame: Frame): Promise<void> {
	const sock = await connect();
	await new Promise<void>((resolve, reject) => {
		sock.write(encode(frame), (err) => (err ? reject(err) : resolve()));
	});
	sock.end();
}

/** Type at the chief, exactly as the TUI does. */
export async function sendInput(text: string): Promise<void> {
	await send({ t: "input", text });
}

/**
 * Move the org's focus to a repo. Deliberately explicit and deliberately rare:
 * this is the one call that reaches out and changes what an attached terminal
 * is pointed at.
 */
export async function setFocus(repoPath: string): Promise<void> {
	await send({ t: "hello", text: repoPath });
}
