/**
 * The set of repos this org works on.
 *
 * The board has always been cross-repo — `readActive()` reads one directory of
 * live records regardless of which repo produced them. The chief was the part
 * that was nailed down: bound to the cwd it was launched in, so a board opened
 * in one repo could show you work in another and offer no way to act on it.
 *
 * A workspace is just a path the org has seen. Nothing here is authoritative
 * about what exists on disk — it is a lookup table so a human (and the chief)
 * can say "nadine" instead of "/Users/…/nadine", and so `list_workspaces`
 * answers "what can I work on" without walking the filesystem.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { missionsPath, missionsRoot } from "./paths.js";
import { readActive } from "./registry.js";

const FILE = (): string => missionsPath("workspaces.json");

export interface Workspace {
	path: string;
	name: string;
	addedAt: string;
	lastSeenAt: string;
}

interface Registry {
	workspaces: Workspace[];
	/** Paths explicitly dropped. Kept, or recovery from mission records would resurrect them. */
	forgotten: string[];
}

function readFile(): Registry {
	if (!existsSync(FILE())) return { workspaces: [], forgotten: [] };
	try {
		const parsed = JSON.parse(readFileSync(FILE(), "utf-8")) as unknown;
		// The first version of this file was a bare array.
		const list = Array.isArray(parsed) ? parsed : ((parsed as Registry)?.workspaces ?? []);
		const forgotten = Array.isArray(parsed) ? [] : ((parsed as Registry)?.forgotten ?? []);
		return {
			workspaces: list.filter((w): w is Workspace => typeof (w as Workspace)?.path === "string"),
			forgotten: forgotten.filter((p): p is string => typeof p === "string"),
		};
	} catch {
		return { workspaces: [], forgotten: [] };
	}
}

function write(reg: Registry): void {
	mkdirSync(missionsRoot(), { recursive: true });
	writeFileSync(FILE(), JSON.stringify(reg, null, 2));
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Every repo the org knows, most recently seen first.
 *
 * Repos that ran a mission before this registry existed are recovered from the
 * live records, so upgrading does not present an empty list to someone with a
 * board full of work.
 */
export function listWorkspaces(): Workspace[] {
	const reg = readFile();
	const dropped = new Set(reg.forgotten);
	const byPath = new Map<string, Workspace>();
	for (const w of reg.workspaces) byPath.set(w.path, w);
	for (const rec of readActive()) {
		if (byPath.has(rec.repo) || dropped.has(rec.repo)) continue;
		byPath.set(rec.repo, { path: rec.repo, name: rec.repoName || basename(rec.repo), addedAt: rec.startedAt, lastSeenAt: rec.updatedAt });
	}
	// A repo that is no longer on disk is not a workspace — throwaway sandboxes age out on their own.
	return [...byPath.values()].filter((w) => !dropped.has(w.path) && isDir(w.path)).sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
}

/** Record a repo as part of the org and bump its recency. Idempotent. Un-forgets it. */
export function registerWorkspace(path: string): Workspace {
	const full = resolve(path);
	const now = new Date().toISOString();
	const reg = readFile();
	reg.forgotten = reg.forgotten.filter((p) => p !== full);
	const existing = reg.workspaces.find((w) => w.path === full);
	if (existing) {
		existing.lastSeenAt = now;
		existing.name = existing.name || basename(full);
		write(reg);
		return existing;
	}
	const created: Workspace = { path: full, name: basename(full) || full, addedAt: now, lastSeenAt: now };
	reg.workspaces.push(created);
	write(reg);
	return created;
}

/** Drop a repo from the org. Returns the workspace removed, if it was there. */
export function forgetWorkspace(ref: string): Workspace | undefined {
	const target = listWorkspaces().find((w) => w.name === ref || w.path === resolve(ref)) ?? resolveWorkspace(ref, "");
	if (!target?.path) return undefined;
	const reg = readFile();
	reg.workspaces = reg.workspaces.filter((w) => w.path !== target.path);
	if (!reg.forgotten.includes(target.path)) reg.forgotten.push(target.path);
	write(reg);
	return target;
}

/**
 * Turn whatever a human or the chief typed into a repo path.
 *
 * Accepts a registered name ("nadine"), a unique fragment of one ("nad"), or a
 * path. Returns undefined rather than guessing when a fragment is ambiguous —
 * dispatching a mission into the wrong repo is expensive to undo, and the
 * caller can list the candidates.
 */
export function resolveWorkspace(ref: string | undefined, fallback: string): Workspace | undefined {
	if (!ref?.trim()) return { path: fallback, name: basename(fallback) || fallback, addedAt: "", lastSeenAt: "" };
	const raw = ref.trim();
	const list = listWorkspaces();

	const byPath = list.find((w) => w.path === resolve(raw));
	if (byPath) return byPath;

	const lower = raw.toLowerCase();
	const exactName = list.filter((w) => w.name.toLowerCase() === lower);
	if (exactName.length === 1) return exactName[0];

	const partial = list.filter((w) => w.name.toLowerCase().includes(lower) || w.path.toLowerCase().includes(lower));
	if (partial.length === 1) return partial[0];
	if (partial.length > 1) return undefined; // ambiguous — the caller must ask

	// An unregistered path is fine, as long as it is really there.
	const asPath = resolve(raw);
	if (isDir(asPath)) return registerWorkspace(asPath);
	return undefined;
}

/** Human-readable candidate list, for the "I could not resolve that" reply. */
export function workspaceNames(): string {
	const list = listWorkspaces();
	return list.length ? list.map((w) => w.name).join(", ") : "(none registered yet)";
}
