import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { createChiefSession } from "./chief.js";
import { drainFrames, encode } from "./ipc.js";

/**
 * The persistent org: one chief + its running sub-agents, hosted in a background process.
 * Clients attach/detach over a Unix socket; work keeps running while nobody is attached.
 */
export async function runDaemon(targetCwd: string, socketPath: string): Promise<void> {
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			/* ignore */
		}
	}

	const session = createChiefSession(targetCwd);
	const clients = new Set<Socket>();

	// Broadcast every line of chief/mission output to all attached clients.
	session.subscribe((text) => {
		for (const c of clients) {
			try {
				c.write(encode({ t: "out", text }));
			} catch {
				/* drop */
			}
		}
	});

	const server = createServer((sock) => {
		clients.add(sock);
		sock.setNoDelay(true);
		sock.write(encode({ t: "out", text: session.greeting() }));
		const n = session.activeMissions();
		if (n > 0) sock.write(encode({ t: "out", text: `  (${n} mission(s) currently running)\n` }));

		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString();
			const { frames, rest } = drainFrames(buf);
			buf = rest;
			for (const f of frames) if (f.t === "input") session.input(f.text);
		});
		const drop = () => clients.delete(sock);
		sock.on("close", drop);
		sock.on("error", drop);
	});

	server.on("error", (err) => {
		process.stderr.write(`daemon server error: ${err.message}\n`);
		process.exit(1);
	});

	await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));

	const shutdown = () => {
		try {
			server.close();
			if (existsSync(socketPath)) unlinkSync(socketPath);
		} catch {
			/* ignore */
		}
		session.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// Keep the process alive indefinitely (the org runs until explicitly stopped).
	await new Promise<never>(() => {});
}
