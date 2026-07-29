/**
 * The chief's conversation, on disk.
 *
 * Until now the chief session was ephemeral: the daemon broadcast to whoever
 * was attached and kept nothing. Detach and the conversation was gone, which is
 * survivable in a terminal you are sitting at and useless on a phone you picked
 * up an hour later.
 *
 * Three decisions keep this from becoming a landfill:
 *
 * 1. ONE ENTRY PER TURN, NOT PER TOKEN. The session emits token chunks — a
 *    frame can be "N" and the next "ice". Writing those verbatim would produce
 *    a line per token and a file two orders of magnitude larger than the
 *    conversation it records. Chunks are buffered here and flushed as one entry
 *    when the turn settles.
 *
 * 2. DAILY SEGMENTS. `<root>/chief/YYYY-MM-DD.jsonl`. Replay reads today (and
 *    yesterday if today is thin) instead of scanning history, retention is
 *    `rm` on old files rather than a rewrite, and "what did we say on Tuesday"
 *    is answerable with `cat`.
 *
 * 3. TAIL READS SEEK. Replay reads the last N bytes and starts at the first
 *    complete line, so opening the page costs the same whether the file holds
 *    one day or one megabyte.
 *
 * JSONL rather than SQLite deliberately: `overseer.ts` already persists
 * per-mission chat as append-only JSONL, and a second storage engine for the
 * same kind of data is exactly the drift this repo keeps writing documents
 * about. Append-only also survives a crash mid-write, which a database file
 * held open by two processes does not do for free.
 */

import { existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, statSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { missionsPath } from "./paths.js";

/** Who said it. Extends to the seat roster (worker, bugSpotter, overseer) later. */
export type ChiefRole = "you" | "chief" | "system";

export interface ChiefEntry {
	/** ISO timestamp — the message gutter reads this. */
	at: string;
	role: ChiefRole;
	text: string;
	/**
	 * Groups one exchange: the line you typed and everything said in reply share
	 * a turn id. This is the thread primitive — a reply attaches to a turn — and
	 * it costs one short string per entry.
	 */
	turn: string;
}

function dir(): string {
	const d = missionsPath("chief");
	mkdirSync(d, { recursive: true });
	return d;
}

function dayFile(when: Date): string {
	return join(dir(), `${when.toISOString().slice(0, 10)}.jsonl`);
}

/** Append one settled entry. Never rewrites, so a crash costs at most a line. */
export function appendChief(entry: ChiefEntry): void {
	try {
		appendFileSync(dayFile(new Date(entry.at)), `${JSON.stringify(entry)}\n`);
	} catch {
		/* the console losing history must never take the daemon down */
	}
}

/** Segment files, oldest first. */
function segments(): string[] {
	try {
		return readdirSync(dir())
			.filter((n) => n.endsWith(".jsonl"))
			.sort()
			.map((n) => join(dir(), n));
	} catch {
		return [];
	}
}

/**
 * Read the last complete lines of a file without loading it.
 *
 * Seeks to the final `bytes` and drops whatever precedes the first newline, so
 * a partial line at the seek point is discarded rather than failing to parse.
 */
function tailLines(file: string, bytes: number): string[] {
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - bytes);
		const len = size - start;
		if (len <= 0) return [];
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, start);
			const text = buf.toString("utf-8");
			const body = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
			return body.split("\n").filter((l) => l.trim().length > 0);
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

/**
 * The tail of the conversation, oldest first.
 *
 * Walks segments backwards until it has enough, so a quiet today still shows
 * yesterday rather than an empty pane.
 */
export function readChiefTail(limit = 200, maxBytesPerFile = 256 * 1024): ChiefEntry[] {
	const out: ChiefEntry[] = [];
	const files = segments().reverse();
	for (const f of files) {
		const lines = tailLines(f, maxBytesPerFile);
		const parsed: ChiefEntry[] = [];
		for (const l of lines) {
			try {
				const e = JSON.parse(l) as ChiefEntry;
				if (e?.text && e.at) parsed.push(e);
			} catch {
				/* skip a torn line */
			}
		}
		out.unshift(...parsed);
		if (out.length >= limit) break;
	}
	return out.slice(-limit);
}

/** Drop segments older than `days`. Called by `missions gc`. */
export function pruneChief(days = 30): { removed: number; bytes: number } {
	const cutoff = Date.now() - days * 86_400_000;
	let removed = 0;
	let bytes = 0;
	for (const f of segments()) {
		try {
			const st = statSync(f);
			if (st.mtimeMs >= cutoff) continue;
			bytes += st.size;
			unlinkSync(f);
			removed++;
		} catch {
			/* ignore */
		}
	}
	return { removed, bytes };
}

/**
 * Buffers streamed chunks and emits one entry per settled turn.
 *
 * `settleMs` is the silence that ends a turn. Too short and one reply splits
 * across entries; too long and a fast follow-up merges into the previous one.
 */
export function createChiefRecorder(settleMs = 900) {
	let pending = "";
	let turn = newTurn();
	let timer: ReturnType<typeof setTimeout> | null = null;

	function newTurn(): string {
		return `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
	}

	function flush(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const text = pending.replace(/\s+$/, "");
		pending = "";
		if (text.length === 0) return;
		appendChief({ at: new Date().toISOString(), role: "chief", text, turn });
	}

	return {
		/** A chunk of chief output. */
		out(chunk: string): void {
			pending += chunk;
			if (timer) clearTimeout(timer);
			timer = setTimeout(flush, settleMs);
		},
		/** A line the operator typed: closes the previous turn and opens a new one. */
		input(text: string): void {
			flush();
			turn = newTurn();
			appendChief({ at: new Date().toISOString(), role: "you", text, turn });
		},
		/** Flush on shutdown so the last reply is not lost. */
		close(): void {
			flush();
		},
	};
}
