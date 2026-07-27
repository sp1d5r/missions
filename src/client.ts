import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { ensureConnected } from "./control.js";
import { drainFrames, encode, orgSocketPath } from "./ipc.js";
import { registerWorkspace } from "./workspaces.js";

/** Attach this terminal to the persistent org, focused on this repo. Detaching (Ctrl-D) leaves it running. */
export async function runClient(targetCwd: string): Promise<void> {
	registerWorkspace(targetCwd);
	const socketPath = orgSocketPath();
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
