import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { drainFrames, encode, legacySocketPaths, orgPidPath, readOrgPid, removeSocket, writeOrgPid } from "./ipc.js";
import { createChiefSession, type ChiefSession } from "./chief.js";
import { renderRun, runRoutine } from "./routine-run.js";
import { dueRoutines } from "./routines.js";
import { createChiefRecorder } from "./chieflog.js";
import { isHarnessStale } from "./mission.js";
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

	// The daemon is the only writer: whatever it broadcasts is what gets
	// recorded, so a terminal and a phone can never disagree about what was said.
	const recorder = createChiefRecorder();

	// Broadcast every line of chief/mission output to all attached clients.
	session.subscribe((text) => {
		recorder.out(text);
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
				if (f.t === "input") {
					recorder.input(f.text);
					session.input(f.text);
				}
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

	// Stale-daemon check: if the build artefacts are newer than when this process started,
	// the binary has been updated and clients should restart the daemon.
	try {
		const daemonStartMs = Date.now();
		const thisFile = fileURLToPath(import.meta.url);
		const buildMtimeMs = statSync(thisFile).mtimeMs;
		if (isHarnessStale(daemonStartMs - 5_000, buildMtimeMs)) {
			// Note: daemon started AFTER the build, so this is a sign the build was done BEFORE
			// the daemon started. But if buildMtime is still in the future (race), warn.
			session.notify("[harness] ⚠ build artefacts are newer than daemon start — run `missions stop && missions` to restart with fresh code");
		}
	} catch {
		/* never block startup */
	}

	// Standing orders live here rather than in launchd or cron, for one practical
	// reason: this process already has the environment of the terminal that started
	// it, including the API key. A launchd job gets a bare environment and would
	// need the key copied somewhere on disk to work at all.
	const scheduler = startScheduler(session);
	process.on("exit", () => clearInterval(scheduler));

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

/** How often the org checks whether any standing order has come due. */
const TICK_MS = 5 * 60_000;

/**
 * Run due routines, one at a time, forever.
 *
 * Serialised deliberately. Routines are not urgent — being twenty minutes late
 * to a daily job costs nothing — and running several at once would put a
 * bugbash's four scouts in contention with a research job's transcript
 * downloads while a human is trying to get a mission planned.
 */
function startScheduler(session: ChiefSession): NodeJS.Timeout {
	let busy = false;
	const tick = async () => {
		if (busy) return;
		const due = dueRoutines();
		if (!due.length) return;
		busy = true;
		try {
			for (const r of due) {
				const run = await runRoutine(r, {
					onProgress: (m) => session.notify(`  ${m}`),
					// A routine at `dispatch` hands the goal to the chief, which owns the
					// mission cap — so standing orders and the human share one queue.
					dispatch: (repo, goal, rationale) => session.dispatchMission(repo, goal, rationale),
				});
				if (run.findings.length || run.dispatched.length) {
					session.notify(`[routine] ${renderRun(run).join("\n")}`);
				}
			}
		} catch (err) {
			session.notify(`[routine] scheduler error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			busy = false;
		}
	};
	// First tick soon after start, so a routine added while detached does not wait.
	setTimeout(() => void tick(), 30_000);
	return setInterval(() => void tick(), TICK_MS);
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
