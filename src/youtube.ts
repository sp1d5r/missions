/**
 * Video intelligence: find talks about how agent harnesses are being built, and
 * read what they actually said.
 *
 * This exists because the highest-value change to this harness so far came from
 * watching a conference talk and noticing the gap between what it described and
 * what the code did. That is a repeatable process, so it should be a job the org
 * runs rather than something Elijah does by hand on a Sunday.
 *
 * Deterministic on purpose — no model touches anything in this file. Discovery
 * and transcription are plumbing; the judgement happens later, in briefing.ts,
 * where every claim gets checked against the repo before anyone acts on it.
 *
 * Requires yt-dlp on PATH. No API key: `ytsearch` scrapes the same result page a
 * browser would, so there is no quota to run out of and no key to rotate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const YTDLP_CANDIDATES = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "yt-dlp"];

/** Transcripts are immutable once published, so they are worth keeping. */
const CACHE_DIR = join(homedir(), ".missions", "transcripts");

export interface VideoMeta {
	id: string;
	title: string;
	url: string;
	channel: string;
	/** Seconds. Absent when the search page did not report it. */
	duration?: number;
	viewCount?: number;
	/** YYYYMMDD, only populated once the video's full metadata is fetched. */
	uploadDate?: string;
}

export function ytDlpPath(): string | undefined {
	for (const p of YTDLP_CANDIDATES) {
		try {
			execFileSync(p, ["--version"], { stdio: "ignore", timeout: 15_000 });
			return p;
		} catch {
			/* try the next one */
		}
	}
	return undefined;
}

function run(bin: string, args: string[], timeoutMs: number): string {
	return execFileSync(bin, args, {
		encoding: "utf-8",
		timeout: timeoutMs,
		maxBuffer: 1 << 26,
		stdio: ["ignore", "pipe", "ignore"],
	}).toString();
}

/**
 * Search YouTube. `sort: "date"` asks for recent rather than popular — worth
 * running both, because they surface almost disjoint sets and the popular list
 * skews heavily to explainers of things we already know.
 */
export function searchVideos(query: string, opts: { limit?: number; sort?: "relevance" | "date" } = {}): VideoMeta[] {
	const bin = ytDlpPath();
	if (!bin) throw new Error("yt-dlp not found on PATH — install it with `brew install yt-dlp`");
	const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
	const prefix = opts.sort === "date" ? "ytsearchdate" : "ytsearch";

	let out: string;
	try {
		out = run(bin, [`${prefix}${limit}:${query}`, "--dump-json", "--flat-playlist", "--no-warnings"], 120_000);
	} catch {
		return [];
	}

	const videos: VideoMeta[] = [];
	for (const line of out.split("\n")) {
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line) as Record<string, unknown>;
			if (typeof o.id !== "string") continue;
			videos.push({
				id: o.id,
				title: String(o.title ?? ""),
				url: typeof o.url === "string" ? o.url : `https://www.youtube.com/watch?v=${o.id}`,
				channel: String(o.channel ?? o.uploader ?? ""),
				duration: typeof o.duration === "number" ? o.duration : undefined,
				viewCount: typeof o.view_count === "number" ? o.view_count : undefined,
			});
		} catch {
			/* skip an unparseable row rather than losing the whole page */
		}
	}
	return videos;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

const CUE_TIMING = /-->/;
const INLINE_TAG = /<[^>]*>/g;

/**
 * VTT to plain prose.
 *
 * Auto-captions are written as a rolling two-line window: every cue repeats the
 * previous cue's last line before adding a new one. Extracted naively that
 * doubles the token count and reads like a stutter, so consecutive duplicates
 * are dropped — which is exactly the right rule, because a genuine repeat in
 * speech still arrives with different surrounding lines.
 */
export function vttToText(vtt: string): string {
	const lines: string[] = [];
	let previous = "";
	for (const raw of vtt.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
		if (CUE_TIMING.test(line)) continue;
		if (/^\d+$/.test(line)) continue; // cue index
		const text = line.replace(INLINE_TAG, "").replace(/\s+/g, " ").trim();
		if (!text || text === previous) continue;
		lines.push(text);
		previous = text;
	}
	return lines.join("\n");
}

export interface Transcript {
	video: VideoMeta;
	text: string;
	/** Rough token estimate, so a caller can budget before sending it to a model. */
	approxTokens: number;
}

/**
 * Fetch one video's auto-captions. Cached on disk: transcripts never change, and
 * re-fetching is the slow part of every run.
 */
export function fetchTranscript(video: VideoMeta): Transcript | undefined {
	mkdirSync(CACHE_DIR, { recursive: true });
	const cached = join(CACHE_DIR, `${video.id}.txt`);
	if (existsSync(cached)) {
		const text = readFileSync(cached, "utf-8");
		return { video, text, approxTokens: Math.ceil(text.length / 4) };
	}

	const bin = ytDlpPath();
	if (!bin) return undefined;

	const work = join(tmpdir(), `missions-cap-${video.id}-${process.pid}`);
	mkdirSync(work, { recursive: true });
	try {
		run(
			bin,
			[
				"--skip-download",
				"--write-auto-sub",
				"--write-sub",
				"--sub-lang",
				"en.*",
				"--sub-format",
				"vtt",
				"--no-warnings",
				"--print-json",
				"-o",
				join(work, "cap.%(ext)s"),
				video.url,
			],
			180_000,
		);

		// Prefer the human-authored track (cap.en.vtt) over the ASR one (cap.en-orig.vtt)
		// when both exist — punctuation and speaker turns survive in the former.
		const files = readdirSync(work).filter((f) => f.endsWith(".vtt"));
		const chosen = files.find((f) => !f.includes("-orig")) ?? files[0];
		if (!chosen) return undefined;

		const text = vttToText(readFileSync(join(work, chosen), "utf-8"));
		if (!text.trim()) return undefined;
		writeFileSync(cached, text);
		return { video, text, approxTokens: Math.ceil(text.length / 4) };
	} catch {
		return undefined;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
