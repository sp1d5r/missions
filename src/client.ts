import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { daemonExists, drainFrames, encode, socketPathFor } from "./ipc.js";

function tryConnect(socketPath: string): Promise<Socket | null> {
	return new Promise((resolvePromise) => {
		const sock = connect(socketPath);
		const onErr = () => {
			sock.destroy();
			resolvePromise(null);
		};
		sock.once("error", onErr);
		sock.once("connect", () => {
			sock.removeListener("error", onErr);
			resolvePromise(sock);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Spawn the detached daemon that hosts the org for this repo. */
function spawnDaemon(targetCwd: string, socketPath: string): void {
	const child = spawn(process.execPath, [process.argv[1] as string, "__daemon", "--target", targetCwd, "--socket", socketPath], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
}

async function ensureConnected(targetCwd: string, socketPath: string): Promise<Socket> {
	let sock = await tryConnect(socketPath);
	if (sock) return sock;
	if (!daemonExists(socketPath)) {
		process.stdout.write(chalk.dim("starting the org (daemon)…\n"));
		spawnDaemon(targetCwd, socketPath);
	}
	// Wait for it to come up (handles both fresh spawn and a stale socket file).
	for (let i = 0; i < 40; i++) {
		await sleep(150);
		sock = await tryConnect(socketPath);
		if (sock) return sock;
		if (i === 6 && !daemonExists(socketPath)) spawnDaemon(targetCwd, socketPath);
	}
	throw new Error(`Could not reach the missions daemon at ${socketPath}`);
}

/** Attach this terminal to the repo's persistent org. Detaching (Ctrl-D) leaves the org running. */
export async function runClient(targetCwd: string): Promise<void> {
	const socketPath = socketPathFor(targetCwd);
	const sock = await ensureConnected(targetCwd, socketPath);

	let buf = "";
	sock.on("data", (d) => {
		buf += d.toString();
		const { frames, rest } = drainFrames(buf);
		buf = rest;
		for (const f of frames) if (f.t === "out") process.stdout.write(f.text);
	});

	let serverGone = false;
	sock.on("close", () => {
		serverGone = true;
		process.stdout.write(chalk.dim("\n(daemon connection closed)\n"));
	});

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	try {
		for (;;) {
			if (closed || serverGone) break;
			let line: string;
			try {
				line = (await rl.question(`\n${chalk.bold("you ›")} `)).trim();
			} catch {
				break; // Ctrl-D → detach
			}
			if (["exit", "quit", ":q", "detach"].includes(line.toLowerCase())) break;
			if (!line) continue;
			sock.write(encode({ t: "input", text: line }));
		}
	} finally {
		rl.close();
		sock.end();
		process.stdout.write(chalk.dim("\ndetached — the org keeps running. Reattach any time with `missions`.\n"));
	}
}
