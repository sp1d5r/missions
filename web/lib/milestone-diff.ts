import type { MilestoneRecord, MissionEvent, MissionState } from "@missions/types.js";

/**
 * What changed at a milestone boundary, per assertion — fixed, newly failing, still stuck.
 *
 * The board already answers "is this mission done" (behavioural/assertions/bugs). It never
 * answered "what happened between milestone 2 and milestone 3" — you had to read forty ✓/✗ rows
 * twice and diff them by eye. A milestone that burns 14 re-checks stuck on one assertion (real,
 * observed) looked exactly like 14 identical rows; the one thing worth reading was the one thing
 * hardest to find.
 *
 * `CheckResult` has no assertion id of its own — only a `command`. The join back to `plan.contract
 * .assertions` is positional: `scoreCard.checks[j]` is assertion `assertions[j]`, because the
 * validator iterates the contract in order to build both. That holds even when an assertion's
 * command gets hand-patched mid-mission (observed: a broken command fixed directly in state.json)
 * — the patch changes the string, never the position. It would NOT hold if assertions were ever
 * reordered or removed after being added; they are not (ids are assigned a1, a2, ... and only
 * appended), so this is safe for every mission on disk.
 */

export interface AssertionRef {
	id: string;
	statement: string;
}

export interface MilestoneDiff {
	milestone: MilestoneRecord;
	/** From the `milestone_verdict` events, which are the only place a milestone's boundary is timestamped. */
	startedAt?: string;
	endedAt?: string;
	fixed: AssertionRef[];
	newlyFailing: AssertionRef[];
	stillFailing: AssertionRef[];
	/** Passed then failed then passed (or worse) across the mission so far, as of this milestone. */
	flips: AssertionRef[];
	passed: number;
	total: number;
	checklist: { id: string; statement: string; passed: boolean; flipped: boolean }[];
}

function milestoneTimestamps(events: MissionEvent[]): { starts: Map<number, string>; ends: Map<number, string> } {
	const starts = new Map<number, string>();
	const ends = new Map<number, string>();
	for (const e of events) {
		if (e.kind !== "milestone_verdict") continue;
		const started = /^milestone (\d+) started$/.exec(e.label);
		if (started) {
			starts.set(Number(started[1]), e.at);
			continue;
		}
		const verdict = /^milestone (\d+): /.exec(e.label);
		// Milestones can re-validate more than once (a resume re-checks the same boundary); the
		// last verdict event for an index is the one that actually closed it, so later wins.
		if (verdict) ends.set(Number(verdict[1]), e.at);
	}
	return { starts, ends };
}

export function computeMilestoneDiffs(state: MissionState): MilestoneDiff[] {
	const assertions = state.plan?.contract?.assertions ?? [];
	const { starts, ends } = milestoneTimestamps(state.events ?? []);
	const history = new Map<string, boolean[]>();
	let prev: Map<string, boolean> | null = null;
	const diffs: MilestoneDiff[] = [];

	for (const m of state.milestones ?? []) {
		const checks = m.scoreCard?.checks ?? [];
		const results = new Map<string, boolean>();
		const checklist: MilestoneDiff["checklist"] = [];

		// A checks array longer than the final contract means the positional join above cannot
		// hold — skip diffing rather than mislabel assertions.
		if (checks.length <= assertions.length) {
			checks.forEach((c, j) => {
				const a = assertions[j];
				if (!a) return;
				results.set(a.id, c.passed);
				const h = history.get(a.id) ?? [];
				h.push(c.passed);
				history.set(a.id, h);
			});
		}

		const fixed: AssertionRef[] = [];
		const newlyFailing: AssertionRef[] = [];
		const stillFailing: AssertionRef[] = [];
		const flips: AssertionRef[] = [];

		for (const [id, passed] of results) {
			const a = assertions.find((x) => x.id === id);
			if (!a) continue;
			const ref = { id, statement: a.statement };
			const was = prev?.get(id);
			if (was === undefined) {
				if (!passed) stillFailing.push(ref);
			} else if (!was && passed) fixed.push(ref);
			else if (was && !passed) newlyFailing.push(ref);
			else if (!was && !passed) stillFailing.push(ref);

			const h = history.get(id) ?? [];
			let flipCount = 0;
			for (let k = 1; k < h.length; k++) if (h[k] !== h[k - 1]) flipCount++;
			const flipped = flipCount >= 2;
			if (flipped) flips.push(ref);
			checklist.push({ id, statement: a.statement, passed, flipped });
		}

		diffs.push({
			milestone: m,
			startedAt: starts.get(m.index),
			endedAt: ends.get(m.index),
			fixed,
			newlyFailing,
			stillFailing,
			flips,
			passed: m.scoreCard?.assertionsPassed ?? 0,
			total: m.scoreCard?.assertionsTotal ?? 0,
			checklist,
		});

		prev = results;
	}

	return diffs;
}
