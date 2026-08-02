/**
 * Standing orders: recurring work the org does without being asked.
 *
 * A mission takes a stated goal and produces a validated diff. The jobs a
 * founder actually does between missions are not that shape — reading what the
 * field is doing, working out what still stands between the repo and shipping,
 * hunting defects nobody has reported yet. Those produce KNOWLEDGE and
 * JUDGEMENT, and their output is a decision about what to build, not a branch.
 *
 * So a routine never edits code. It investigates, and it PROPOSES: findings land
 * in the same SUGGESTED queue the board already renders, where a keystroke turns
 * one into a mission. Autonomy is per-routine and opt-in — a routine set to
 * `dispatch` runs the missions itself, and lands them on branches it never
 * merges, because waking up to twelve merged branches is not delegation.
 *
 * THE LEDGER IS THE POINT. A daily job that re-reports the same three findings
 * every morning gets muted within a week, and a muted job is worse than no job
 * because it still costs money. Every finding is fingerprinted and recorded, and
 * a fingerprint already surfaced is never surfaced again. "Nothing new since
 * Tuesday" is the healthy steady state, not a failure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { missionsPath, missionsRoot } from "./paths.js";

export type RoutineKind = "research" | "plan" | "bugbash";
/** `propose` writes to the board and stops. `dispatch` also runs the missions. */
export type Autonomy = "propose" | "dispatch";

export interface Routine {
	id: string;
	kind: RoutineKind;
	repo: string;
	/** Minutes between runs. Coarse on purpose — these are daily-ish jobs, not pollers. */
	everyMinutes: number;
	autonomy: Autonomy;
	enabled: boolean;
	/** research: what to search for. Defaults to the briefing's own queries. */
	queries?: string[];
	/** bugbash: which part of the repo to hunt in, in plain words. */
	scope?: string;
	/**
	 * Ceiling for one run, or undefined for uncapped.
	 *
	 * Recorded but never read — nothing in routine-run enforces it. Left declared because a
	 * routine is the one thing here that spends without being asked, so the field is worth
	 * keeping honest rather than deleting; it should be wired up, not quietly dropped.
	 */
	maxUsd?: number;
	lastRunAt?: string;
	lastSummary?: string;
}

/** One thing a routine wants to tell you. */
export interface Finding {
	/** Stable across runs — this is what the ledger dedupes on. */
	fingerprint: string;
	title: string;
	detail: string;
	/** A mission goal, when this is something a worker could act on. */
	goal?: string;
	source: string;
}

export interface RoutineRun {
	routineId: string;
	kind: RoutineKind;
	repo: string;
	at: string;
	findings: Finding[];
	/** Findings suppressed because they were reported before. */
	repeats: number;
	dispatched: string[];
	costUsd: number;
	note?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const FILE = (): string => missionsPath("routines.json");
const LEDGER = (): string => missionsPath("routine-ledger.json");
const RUNS = (): string => missionsPath("routine-runs.json");

function readJson<T>(path: string, fallback: T): T {
	try {
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(missionsRoot(), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

export function listRoutines(): Routine[] {
	return readJson<Routine[]>(FILE(), []).filter((r) => typeof r?.id === "string");
}

export function saveRoutine(r: Routine): void {
	const all = listRoutines().filter((x) => x.id !== r.id);
	all.push(r);
	writeJson(FILE(), all);
}

export function removeRoutine(id: string): boolean {
	const all = listRoutines();
	const left = all.filter((r) => r.id !== id);
	if (left.length === all.length) return false;
	writeJson(FILE(), left);
	return true;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

interface LedgerEntry {
	firstSeen: string;
	lastSeen: string;
	routineId: string;
	title: string;
}

type Ledger = Record<string, LedgerEntry>;

/**
 * Fingerprint a finding by its wording, normalised.
 *
 * A model asked the same question twice never writes it identically, so hashing
 * raw text would defeat the ledger. Lowercasing, dropping punctuation and
 * filler, sorting the remaining words and reducing plurals and tenses collapses
 * the ordinary run-to-run variation.
 *
 * It does NOT collapse genuine paraphrase — "returns empty on failure" and
 * "fails silently and yields nothing" hash differently — and that asymmetry is
 * deliberate. The two ways this can be wrong are not equally bad: an escaped
 * duplicate is noise you can see and dismiss, whereas over-collapsing suppresses
 * a NEW finding as already-reported, and you never learn it existed. So the
 * normalisation stops well short of where it would start merging distinct
 * defects. Callers that have something stronger than prose — bugbash has
 * file:line — should fold it into the text they pass.
 */
export function fingerprint(repo: string, text: string): string {
	const norm = text
		.toLowerCase()
		.replace(/[^a-z0-9\s/.]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w))
		.map(stem)
		.filter((w) => !STOPWORDS.has(w))
		.sort()
		.join(" ");
	return createHash("sha1").update(`${basename(repo)}::${norm}`).digest("hex").slice(0, 16);
}

/**
 * Reduce a word to a crude stem: plurals and verb tense only.
 *
 * Deliberately not a real stemmer. Suffixes like -ure, -ment and -ion change
 * what a word MEANS often enough that stripping them merges distinct findings,
 * which is the expensive mistake here.
 */
function stem(w: string): string {
	for (const suffix of ["ing", "ed", "es", "s", "ly"]) {
		if (w.length - suffix.length >= 4 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
	}
	return w;
}

const STOPWORDS = new Set([
	"the", "and", "for", "that", "this", "with", "from", "into", "when", "then", "than", "there",
	"here", "have", "has", "was", "were", "are", "not", "but", "can", "could", "would", "should",
	"which", "what", "who", "how", "why", "its", "it's", "you", "your", "our", "their", "add",
	"use", "using", "make", "makes", "made", "does", "done", "may", "might", "will",
]);

/**
 * Split findings into those never reported before and the count that were.
 *
 * READ ONLY — nothing is recorded as seen here. Marking a finding seen is the
 * claim "you have been told this", and that only becomes true once it is on the
 * board. Doing both in one step means a failed board write silences the finding
 * permanently: it is marked seen, never delivered, and never surfaces again.
 * Call {@link commitSeen} once delivery has actually happened.
 */
export function partitionSeen(findings: Finding[]): { fresh: Finding[]; repeats: number } {
	const ledger = readJson<Ledger>(LEDGER(), {});
	const fresh: Finding[] = [];
	let repeats = 0;
	for (const f of findings) {
		if (ledger[f.fingerprint]) repeats++;
		else fresh.push(f);
	}
	return { fresh, repeats };
}

/** Record findings as delivered. Call only after they have reached the board. */
export function commitSeen(findings: Finding[], routineId: string): void {
	if (!findings.length) return;
	const ledger = readJson<Ledger>(LEDGER(), {});
	const now = new Date().toISOString();
	for (const f of findings) {
		const known = ledger[f.fingerprint];
		if (known) known.lastSeen = now;
		else ledger[f.fingerprint] = { firstSeen: now, lastSeen: now, routineId, title: f.title };
	}
	writeJson(LEDGER(), ledger);
}

/**
 * What this routine has already told you, most recent first.
 *
 * Fed back into the prompt that generates the next round. Hashing prose was
 * never going to be enough — two runs of the same prompt said "Investigate and
 * land or discard the two unmerged branches" and "Reconcile the two unmerged
 * mission branches", which are the same finding and share barely a word. The
 * model that writes the findings is the only thing here that can recognise its
 * own paraphrase, so it is shown its back catalogue and told not to repeat it.
 * The hash ledger stays as a cheap second net for near-identical wording.
 */
export function knownTitles(routineId: string, limit = 40): string[] {
	return Object.values(readJson<Ledger>(LEDGER(), {}))
		.filter((e) => e.routineId === routineId)
		.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
		.slice(0, limit)
		.map((e) => e.title);
}

export function ledgerSize(): number {
	return Object.keys(readJson<Ledger>(LEDGER(), {})).length;
}

/** Forget everything a routine has reported, so it may surface again. */
export function clearLedger(routineId?: string): number {
	const ledger = readJson<Ledger>(LEDGER(), {});
	const keep: Ledger = {};
	let dropped = 0;
	for (const [k, v] of Object.entries(ledger)) {
		if (!routineId || v.routineId === routineId) dropped++;
		else keep[k] = v;
	}
	writeJson(LEDGER(), keep);
	return dropped;
}

export function recentRuns(limit = 20): RoutineRun[] {
	return readJson<RoutineRun[]>(RUNS(), []).slice(-limit).reverse();
}

export function recordRun(run: RoutineRun): void {
	const all = readJson<RoutineRun[]>(RUNS(), []);
	all.push(run);
	writeJson(RUNS(), all.slice(-200));
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export function isDue(r: Routine, now = Date.now()): boolean {
	if (!r.enabled) return false;
	if (!r.lastRunAt) return true;
	const last = Date.parse(r.lastRunAt);
	if (!Number.isFinite(last)) return true;
	return now - last >= r.everyMinutes * 60_000;
}

export function dueRoutines(now = Date.now()): Routine[] {
	return listRoutines().filter((r) => isDue(r, now));
}
