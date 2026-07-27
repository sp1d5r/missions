/**
 * Running a standing order, and what happens to what it finds.
 *
 * The pipeline is deliberately narrow: investigate → drop what has already been
 * said → put the rest on the board → optionally act. Each stage can end the run,
 * and ending early is the normal case for a healthy repo.
 *
 * Nothing here edits code. Even at `dispatch`, a routine only starts missions,
 * and a mission lands on its own branch and is never merged without a human —
 * that boundary is the whole reason this is safe to leave running overnight.
 */

import { basename } from "node:path";
import { jobFor } from "./routine-jobs.js";
import { commitSeen, partitionSeen, recordRun, saveRoutine, type Finding, type Routine, type RoutineRun } from "./routines.js";
import { addSuggestions } from "./suggest.js";

export interface RunOptions {
	/** Investigate and report, but write nothing and remember nothing. */
	dryRun?: boolean;
	onProgress?: (msg: string) => void;
	/** How a `dispatch` routine actually starts a mission. Injected so the daemon owns concurrency. */
	dispatch?: (repo: string, goal: string, rationale: string) => void;
}

/** Most a single `dispatch` routine will start in one run. Beyond this it is not delegation. */
const MAX_AUTO_DISPATCH = 2;

export async function runRoutine(r: Routine, options: RunOptions = {}): Promise<RoutineRun> {
	const { dryRun = false, onProgress, dispatch } = options;
	const say = (m: string) => onProgress?.(m);
	const at = new Date().toISOString();
	const run: RoutineRun = { routineId: r.id, kind: r.kind, repo: r.repo, at, findings: [], repeats: 0, dispatched: [], costUsd: 0 };

	say(`${r.id}: ${r.kind} on ${basename(r.repo)}`);
	let found: Finding[] = [];
	try {
		const result = await jobFor(r.kind)(r);
		found = result.findings;
		run.costUsd = result.costUsd;
		run.note = result.note;
		say(`  ${found.length} raw finding(s) · $${result.costUsd.toFixed(3)}${result.note ? ` · ${result.note}` : ""}`);
	} catch (err) {
		run.note = `failed: ${err instanceof Error ? err.message : String(err)}`;
		say(`  ${run.note}`);
		if (!dryRun) stamp(r, run);
		return run;
	}

	// The ledger. Without this a daily routine re-reports its own back catalogue
	// every morning until you stop reading it.
	//
	// Read here, committed only once the findings are actually on the board — a
	// finding marked seen but never delivered is silenced forever.
	const { fresh, repeats } = partitionSeen(found);
	run.findings = dryRun ? found : fresh;
	run.repeats = dryRun ? 0 : repeats;
	if (repeats && !dryRun) say(`  ${repeats} already reported — suppressed`);

	if (!run.findings.length) {
		run.note = [run.note, "nothing new"].filter(Boolean).join("; ");
		say("  nothing new");
		if (!dryRun) stamp(r, run);
		return run;
	}

	if (!dryRun) {
		const actionable = run.findings.filter((f) => f.goal);
		const added = addSuggestions(
			r.repo,
			actionable.map((f) => ({
				repo: r.repo,
				repoName: basename(r.repo),
				goal: f.goal as string,
				rationale: f.detail || undefined,
				source: `routine:${r.id}`,
			})),
		);
		say(`  ${added} suggestion(s) on the board`);
		// Delivered — only now is "you have been told this" true.
		commitSeen(run.findings, r.id);

		// Autonomy stops here unless explicitly raised, and even then it is capped:
		// a routine that can start unlimited work is a way to wake up to a mess.
		if (r.autonomy === "dispatch" && dispatch) {
			for (const f of actionable.slice(0, MAX_AUTO_DISPATCH)) {
				dispatch(r.repo, f.goal as string, f.detail);
				run.dispatched.push(f.goal as string);
			}
			if (run.dispatched.length) say(`  dispatched ${run.dispatched.length} mission(s) — they land on branches, nothing is merged`);
		}
		stamp(r, run);
	}

	return run;
}

function stamp(r: Routine, run: RoutineRun): void {
	saveRoutine({
		...r,
		lastRunAt: run.at,
		lastSummary: run.findings.length ? `${run.findings.length} new${run.dispatched.length ? `, ${run.dispatched.length} dispatched` : ""}` : (run.note ?? "nothing new"),
	});
	recordRun(run);
}

/** Human-readable summary of one run, for the CLI and the chief. */
export function renderRun(run: RoutineRun): string[] {
	const lines: string[] = [];
	const head = `${run.routineId} · ${run.kind} · ${basename(run.repo)} · $${run.costUsd.toFixed(3)}`;
	lines.push(head);
	if (run.note) lines.push(`  ${run.note}`);
	if (run.repeats) lines.push(`  ${run.repeats} previously reported, suppressed`);
	for (const f of run.findings) {
		lines.push(`  • ${f.title}`);
		if (f.detail) lines.push(`      ${f.detail}`);
		if (f.goal) lines.push(`      → ${f.goal}`);
	}
	if (!run.findings.length) lines.push("  nothing new");
	if (run.dispatched.length) lines.push(`  dispatched: ${run.dispatched.join("; ")}`);
	return lines;
}
