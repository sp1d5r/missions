/**
 * The scoping document: one piece of prose, shared by the user and the mission's agent, that
 * exists before dispatch (to negotiate scope and architecture) and stays alive through the run.
 *
 * Deliberately not JSON-structured content — it's markdown, a plain file the agent edits with the
 * same write tool it uses on any other file in the worktree. What IS structured is the annotation
 * layer on top: a thread anchors to a line of that markdown (by 1-based line number, with the
 * anchor's own text snippet so a thread survives a nearby edit shifting line numbers by a line or
 * two — see `resolveAnchor`). Persisted the same way chat.jsonl is (see overseer.ts): one
 * append-only JSONL file per mission, both sides write to it, nobody rewrites history.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionState } from "./types.js";

export const SCOPING_DOC_FILENAME = "scoping.md";
export const SCOPING_THREADS_FILENAME = "scoping-threads.jsonl";

export function scopingDocPath(outDir: string): string {
	return join(outDir, SCOPING_DOC_FILENAME);
}

function scopingThreadsPath(outDir: string): string {
	return join(outDir, SCOPING_THREADS_FILENAME);
}

/** Read the scoping doc's markdown source. Empty string if none has been written yet. */
export function readScopingDoc(outDir: string): string {
	const p = scopingDocPath(outDir);
	if (!existsSync(p)) return "";
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return "";
	}
}

/** Overwrite the scoping doc. Whole-file replace, same as any other worktree edit — no diffing. */
export function writeScopingDoc(outDir: string, markdown: string): void {
	writeFileSync(scopingDocPath(outDir), markdown);
}

/**
 * Backfill a scoping doc from a mission's existing state, for missions that predate this feature
 * and so never had one written. Not what a freshly-planned mission gets going forward — that
 * should be the planner's own prose — this is specifically for giving already-running or already-
 * finished missions something real to annotate rather than the panel's empty state.
 */
export function generateScopingDocFromState(state: MissionState): string {
	const lines: string[] = [];
	const plan = state.plan;
	lines.push(`# ${plan?.architectureNote?.split("->")[1]?.trim() || plan?.summary?.slice(0, 60) || "Mission scope"}`);
	lines.push("");
	if (plan?.summary) {
		lines.push(plan.summary);
		lines.push("");
	}
	if (plan?.architectureNote) {
		lines.push("## Architecture");
		lines.push(plan.architectureNote);
		lines.push("");
	}
	if (plan?.features?.length) {
		lines.push("## Scope");
		for (const f of plan.features) {
			lines.push(`- ${f.title} — ${f.description}`);
		}
		lines.push("");
	}
	if (plan?.contract?.assertions?.length) {
		lines.push("## Contract");
		for (const a of plan.contract.assertions) {
			const status = a.pending ? "pending" : a.passed === true ? "pass" : a.passed === false ? "fail" : "pending";
			lines.push(`- ${a.id}: ${a.statement} (${status})`);
		}
		lines.push("");
	}
	const bugs = state.scoreCard?.bugs ?? [];
	if (bugs.length) {
		lines.push("## Known issues");
		for (const b of bugs) {
			lines.push(`- [${b.severity}] ${b.summary}${b.file ? ` — ${b.file}${b.line ? `:${b.line}` : ""}` : ""}`);
		}
		lines.push("");
	}
	if (state.commits?.length) {
		lines.push("## Commits");
		for (const c of state.commits) {
			lines.push(`- ${(c.sha ?? "").slice(0, 7)} ${c.message}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

export interface ScopingAnchor {
	/** 1-based line number in the markdown at the moment this thread was opened. */
	line: number;
	/** The exact selected/anchored text, so the UI can re-find it if the line has since shifted. */
	snippet: string;
}

export interface ScopingMessage {
	role: "user" | "agent";
	text: string;
	at: string;
}

export interface ScopingThread {
	id: string;
	anchor: ScopingAnchor;
	resolved: boolean;
	messages: ScopingMessage[];
}

/**
 * One line per event, not one line per thread — appending a reply must never require reading and
 * rewriting the whole file (the same reason chat.jsonl and mission.log are append-only). Each line
 * is either an "open" event (creates a thread) or a "reply" event (appends to one); threads are
 * reassembled by replaying the log in order.
 */
type ThreadLogLine =
	| { type: "open"; id: string; anchor: ScopingAnchor; message: ScopingMessage }
	| { type: "reply"; id: string; message: ScopingMessage }
	| { type: "resolve"; id: string; resolved: boolean };

export function appendScopingThreadOpen(outDir: string, id: string, anchor: ScopingAnchor, message: ScopingMessage): void {
	appendLine(outDir, { type: "open", id, anchor, message });
}

export function appendScopingThreadReply(outDir: string, id: string, message: ScopingMessage): void {
	appendLine(outDir, { type: "reply", id, message });
}

export function setScopingThreadResolved(outDir: string, id: string, resolved: boolean): void {
	appendLine(outDir, { type: "resolve", id, resolved });
}

function appendLine(outDir: string, line: ThreadLogLine): void {
	appendFileSync(scopingThreadsPath(outDir), `${JSON.stringify(line)}\n`);
}

/** Replays the append-only log into the current set of threads. Malformed lines are skipped. */
export function loadScopingThreads(outDir: string): ScopingThread[] {
	const p = scopingThreadsPath(outDir);
	if (!existsSync(p)) return [];
	const byId = new Map<string, ScopingThread>();
	const order: string[] = [];
	for (const raw of readFileSync(p, "utf-8").split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		let line: ThreadLogLine;
		try {
			line = JSON.parse(trimmed) as ThreadLogLine;
		} catch {
			continue;
		}
		if (line.type === "open") {
			if (!byId.has(line.id)) order.push(line.id);
			byId.set(line.id, { id: line.id, anchor: line.anchor, resolved: false, messages: [line.message] });
		} else if (line.type === "reply") {
			byId.get(line.id)?.messages.push(line.message);
		} else if (line.type === "resolve") {
			const t = byId.get(line.id);
			if (t) t.resolved = line.resolved;
		}
	}
	return order.map((id) => byId.get(id)).filter((t): t is ScopingThread => t !== undefined);
}
