import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per-repo daemon socket. Short path under ~/.missions/daemons to stay under the OS sun_path limit. */
export function socketPathFor(targetCwd: string): string {
	const dir = join(homedir(), ".missions", "daemons");
	mkdirSync(dir, { recursive: true });
	const hash = createHash("sha1").update(targetCwd).digest("hex").slice(0, 16);
	return join(dir, `${hash}.sock`);
}

export function daemonExists(socketPath: string): boolean {
	return existsSync(socketPath);
}

/** One newline-delimited JSON frame. */
export interface Frame {
	t: "input" | "out";
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
