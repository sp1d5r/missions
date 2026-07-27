import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missionsRoot } from "./paths.js";

const ROOT = (): string => missionsRoot();

/**
 * One socket for the whole org, not one per repo.
 *
 * The daemon was originally keyed by sha1(cwd), which meant the chief could only
 * ever dispatch into the directory you happened to launch from — while the board
 * beside it showed every repo. One org process, many workspaces: the repo you
 * attached from becomes the chief's focus, and it can reach the rest by name.
 */
export function orgSocketPath(): string {
	mkdirSync(ROOT(), { recursive: true });
	return join(ROOT(), "org.sock");
}

export function orgPidPath(): string {
	mkdirSync(ROOT(), { recursive: true });
	return join(ROOT(), "org.pid");
}

export function writeOrgPid(pid: number): void {
	writeFileSync(orgPidPath(), String(pid));
}

export function readOrgPid(): number | undefined {
	try {
		const n = Number.parseInt(readFileSync(orgPidPath(), "utf-8").trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

/** Sockets from the per-repo daemon scheme, so `missions stop` can clean up after an upgrade. */
export function legacySocketPaths(): string[] {
	const dir = join(ROOT(), "daemons");
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((n) => n.endsWith(".sock"))
			.map((n) => join(dir, n));
	} catch {
		return [];
	}
}

/** Retained so an upgraded client can still find (and retire) a pre-existing per-repo daemon. */
export function socketPathFor(targetCwd: string): string {
	const dir = join(ROOT(), "daemons");
	mkdirSync(dir, { recursive: true });
	const hash = createHash("sha1").update(targetCwd).digest("hex").slice(0, 16);
	return join(dir, `${hash}.sock`);
}

export function daemonExists(socketPath: string): boolean {
	return existsSync(socketPath);
}

export function removeSocket(socketPath: string): void {
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {
		/* ignore */
	}
}

/**
 * One newline-delimited JSON frame.
 *
 * `hello` carries the client's cwd. It is the only way the daemon learns which
 * repo a terminal is sitting in, since a shared org process has no cwd of its own.
 */
export interface Frame {
	t: "input" | "out" | "hello";
	text: string;
}

export function encode(frame: Frame): string {
	return `${JSON.stringify(frame)}\n`;
}

/** Split a growing buffer into complete JSON frames; returns [frames, remainder]. */
export function drainFrames(buffer: string): { frames: Frame[]; rest: string } {
	const frames: Frame[] = [];
	let rest = buffer;
	for (;;) {
		const i = rest.indexOf("\n");
		if (i < 0) break;
		const line = rest.slice(0, i);
		rest = rest.slice(i + 1);
		if (!line.trim()) continue;
		try {
			frames.push(JSON.parse(line) as Frame);
		} catch {
			/* ignore malformed */
		}
	}
	return { frames, rest };
}
