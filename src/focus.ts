/**
 * Which repo the chief is currently pointed at, published as a file.
 *
 * Focus lives in the daemon process, and the IPC protocol has three frames —
 * `hello`, `input`, `out`. None of them answers "where are you?". So the web
 * console could MOVE the focus (`hello`) but had no way to show what it was,
 * which makes a repo picker impossible to render honestly: it would either show
 * nothing selected, or guess.
 *
 * Publishing to a file rather than adding a query frame is deliberate. A Next.js
 * server component can read it with no socket round-trip and no daemon running,
 * and a stale file is self-evidently stale (the daemon rewrites on every change
 * and at startup). A query frame would have needed request/response plumbing in
 * a protocol that is currently one-way broadcast.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { missionsPath, missionsRoot } from "./paths.js";

const FILE = (): string => missionsPath("focus");

/** Record where the chief is pointed. Called by the daemon's session on every change. */
export function publishFocus(repoPath: string): void {
	try {
		mkdirSync(missionsRoot(), { recursive: true });
		writeFileSync(FILE(), repoPath);
	} catch {
		// Publishing focus is a convenience for other readers, never a reason to
		// fail the thing that actually moved it.
	}
}

/**
 * Where the chief is pointed, or undefined if nothing has published it yet.
 *
 * Undefined is a real answer — a daemon that predates this file, or one that has
 * never been started. Callers should say "unknown" rather than invent a repo.
 */
export function readFocus(): string | undefined {
	try {
		if (!existsSync(FILE())) return undefined;
		const raw = readFileSync(FILE(), "utf-8").trim();
		return raw.length ? raw : undefined;
	} catch {
		return undefined;
	}
}
