import { execFileSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { drainFrames, encode, legacySocketPaths, orgPidPath, readOrgPid, removeSocket, writeOrgPid } from "./ipc.js";
import { createChiefSession } from "./chief.js";
import { registerWorkspace } from "./workspaces.js";

/**
 * The persistent org: one chief + its running sub-agents, hosted in a background process.
 * Clients attach/detach over a Unix socket; work keeps running while nobody is attached.
 *
 * There is exactly one of these per machine, not one per repo. A client announces
 * the directory it was launched from and the chief focuses there; missions it
 * dispatches can target any registered workspace.
 */
export async function runDaemon(homeCwd: string, socketPath: string): Promise<void> {
	removeSocket(socketPath);

	const session = createChiefSession(homeCwd);
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
			for (const f of frames) {
				if (f.t === "input") session.input(f.text);
				else if (f.t === "hello" && f.text) {
					registerWorkspace(f.text);
					session.setFocus(f.text);
				}
			}
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
	writeOrgPid(process.pid);

	const shutdown = () => {
		try {
			server.close();
			removeSocket(socketPath);
			removeSocket(orgPidPath());
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

function daemonPids(): number[] {
	// Sweeps the per-repo daemons from the old scheme too — they hold no pidfile,
	// and leaving them running means a second chief answering on a stale socket.
	try {
		const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf-8", maxBuffer: 1 << 22 });
		return out
			.split("\n")
			.filter((l) => l.includes("__daemon") && l.includes("missions"))
			.map((l) => Number.parseInt(l.trim().split(/\s+/)[0] ?? "", 10))
			.filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
	} catch {
		return [];
	}
}

/** Stop the org. Returns how many processes were signalled. */
export function stopOrg(): number {
	const pids = new Set<number>(daemonPids());
	const recorded = readOrgPid();
	if (recorded) pids.add(recorded);
	let killed = 0;
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
			killed++;
		} catch {
			/* already gone */
		}
	}
	for (const p of legacySocketPaths()) removeSocket(p);
	removeSocket(orgPidPath());
	return killed;
}
