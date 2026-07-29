/**
 * Who said it.
 *
 * A mission's timeline was a flat list of kinds — `tool_call`, `validation_result`,
 * `milestone_verdict` — which describes the HARNESS's data model rather than the org's. Reading
 * it meant translating machine vocabulary back into "the engineer did this, then QA disagreed",
 * every time, in your head.
 *
 * These are the seats that actually exist. Deliberately not an invented org chart: there is no
 * "design" seat because nothing in this harness designs, and a label with no agent behind it is
 * a lie that looks like a feature.
 *
 * ATTRIBUTION IS RECORDED, NOT INFERRED — going forward. Every appendEvent call names its seat,
 * because the code emitting the event knows the answer for certain and a string-matching guess
 * over labels does not. `seatOf` exists only for missions already on disk, written before the
 * field did; it reads the kind and falls back to the harness itself, which is the honest answer
 * when we genuinely do not know.
 */

import type { MissionEvent } from "./types.js";

export type Seat = "chief" | "lead" | "eng" | "qa" | "setup" | "system";

export interface SeatInfo {
	/** Shown in the message gutter. Lowercase: this is a handle, not a title. */
	name: Seat;
	/** One line, for a tooltip or a roster view. */
	role: string;
	/** Which model spec in ModelRouting pays for this seat, when one does. */
	routing?: "orchestrator" | "worker" | "bugSpotter";
}

export const SEATS: Record<Seat, SeatInfo> = {
	chief: { name: "chief", role: "Chief of staff — runs the org, dispatches and merges missions." },
	lead: { name: "lead", role: "Plans the mission, writes the contract, rules each milestone boundary.", routing: "orchestrator" },
	eng: { name: "eng", role: "Implements features against the contract.", routing: "worker" },
	qa: { name: "qa", role: "Proves or disproves the contract, adversarially.", routing: "bugSpotter" },
	setup: { name: "setup", role: "Makes a fresh worktree runnable and corrects the repo's setup doc." },
	system: { name: "system", role: "The harness itself — status, commits, errors." },
};

export const SEAT_ORDER: Seat[] = ["chief", "lead", "eng", "qa", "setup", "system"];

/**
 * Best guess for an event that predates recorded attribution.
 *
 * Kind only. Matching on label text was tried and rejected: labels are human prose that changes
 * whenever someone improves a log line, so an attribution built on them silently rots into
 * mislabelling — worse than the honest `system` fallback, because it looks certain.
 */
export interface EventGroup {
	parent: MissionEvent;
	/** Detail events belonging to the parent. Empty for an ordinary standalone event. */
	children: MissionEvent[];
}

/**
 * Fold a timeline into parents and their replies.
 *
 * Two sources of structure, in order of trust:
 *
 * RECORDED. The first event carrying a `thread` id is the parent and the rest are its replies.
 * Ordering is the entire rule, which is why no event needs an id of its own — the emitter writes
 * the summary before its detail, always.
 *
 * INFERRED, for missions already on disk. Every mission recorded before `thread` existed has the
 * exact problem this solves — forty per-assertion ✓ rows at the same visual weight as the verdict
 * above them — and would have gone on having it, since the field is only written going forward.
 * So a run of consecutive `validation_result` events with no thread id collapses under the first.
 *
 * That inference is structural, not textual: it relies on the emitter writing a summary followed
 * immediately by its details, which is a property of the code, rather than on matching label
 * prose, which is a property of whoever last improved a log line. Narrow on purpose — only
 * validation_result is emitted in that shape, and widening it to every kind would swallow
 * unrelated consecutive events that merely happen to share a kind.
 */
export function groupTimeline(events: MissionEvent[]): EventGroup[] {
	const out: EventGroup[] = [];
	const byThread = new Map<string, EventGroup>();
	for (const e of events) {
		if (e.thread) {
			const open = byThread.get(e.thread);
			if (open) {
				open.children.push(e);
			} else {
				const g: EventGroup = { parent: e, children: [] };
				byThread.set(e.thread, g);
				out.push(g);
			}
			continue;
		}
		const last = out[out.length - 1];
		if (e.kind === "validation_result" && last && !last.parent.thread && last.parent.kind === "validation_result") {
			last.children.push(e);
			continue;
		}
		out.push({ parent: e, children: [] });
	}
	return out;
}

export function seatOf(event: Pick<MissionEvent, "kind" | "seat">): Seat {
	if (event.seat && event.seat in SEATS) return event.seat;
	switch (event.kind) {
		case "tool_call":
			return "eng";
		case "validation_result":
			return "qa";
		case "milestone_verdict":
			return "lead";
		default:
			return "system";
	}
}
