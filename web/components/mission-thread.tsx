"use client";

import { useState } from "react";
import { groupTimeline, SEATS, seatOf, type Seat } from "@missions/seats.js";
import type { MissionEvent } from "@missions/types.js";

/**
 * A mission's timeline, read as a conversation.
 *
 * It used to render one row per event, each stamped with its harness kind — `tool_call`,
 * `validation_result`, `milestone_verdict`. That is the data model, not the org: reading it meant
 * translating machine vocabulary into "the engineer did this, then QA disagreed" in your head,
 * every time. Now each event is posted BY someone, and consecutive posts from the same seat group
 * the way a chat client groups them.
 *
 * Threads matter more here than they look. A mission with forty assertions emitted forty ✓ rows
 * of exactly the same visual weight as the verdict above them, so the one line worth reading was
 * buried in the one thing nobody needs to read line by line. Detail events now collapse under
 * their parent behind a reply count — present, one click away, not in the way.
 */

function clock(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? "—"
		: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function day(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toDateString();
}

function Replies({ items }: { items: MissionEvent[] }) {
	const [open, setOpen] = useState(false);
	if (!items.length) return null;
	// Failures are the reason anyone opens this, so say how many rather than making someone
	// expand a passing run to find out it was passing.
	const bad = items.filter((c) => c.label.startsWith("✗")).length;
	return (
		<div className="replies">
			<button type="button" className="replies-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
				{open ? "hide" : `${items.length} ${items.length === 1 ? "reply" : "replies"}`}
				{bad > 0 && <span className="replies-bad"> · {bad} failing</span>}
			</button>
			{open && (
				<div className="replies-body">
					{items.map((c, i) => (
						// A failing assertion is the reason anyone opened this, so it must not read
						// the same as the twenty passes around it.
						<div className={`reply${c.label.startsWith("\u2717") ? " is-bad" : ""}`} key={`${c.at}-${i}`}>
							<div className="reply-label">{c.label}</div>
							{c.detail && <div className="msg-detail">{c.detail}</div>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function MissionImage({ id, event }: { id: string; event: MissionEvent }) {
	if (!event.image) return null;
	const basename = event.image.path.split("/").pop() ?? "";
	const src = `/api/m/${id}/images/${basename}`;
	const alt = event.image.alt ?? event.label;
	return (
		<div className="cmsg-image">
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={src} alt={alt} />
		</div>
	);
}

export function MissionThread({ events, id }: { events: MissionEvent[]; id: string }) {
	if (events.length === 0) return <div className="empty">No timeline recorded for this mission.</div>;

	const groups = groupTimeline(events);
	let lastDay = "";
	let lastSeat: Seat | null = null;

	return (
		<div className="chat">
			{groups.map((g, i) => {
				const e = g.parent;
				const seat = seatOf(e);
				const d = day(e.at);
				const newDay = d !== lastDay;
				if (newDay) lastSeat = null;
				lastDay = d;
				// Same seat as the post above, no day break: a continuation, so drop the header.
				// Errors always keep theirs — an error hidden inside someone else's run of
				// messages is the one thing that must not read as more of the same.
				const cont = !newDay && lastSeat === seat && e.kind !== "error";
				lastSeat = seat;
				return (
					<div key={`${e.at}-${i}`}>
						{newDay && (
							<div className="msg-sep">
								<span>{d}</span>
							</div>
						)}
						<div className={`cmsg${cont ? " is-cont" : ""}${e.kind === "error" ? " is-system" : ""}`}>
							{!cont && (
								<div className="cmsg-head">
									<span className="cmsg-who" data-role={seat} title={SEATS[seat].role}>
										{seat}
									</span>
									<span className="cmsg-when">{clock(e.at)}</span>
								</div>
							)}
							<div className="cmsg-text">{e.label}</div>
							{e.detail && <div className="msg-detail">{e.detail}</div>}
							{e.image && <MissionImage id={id} event={e} />}
							<Replies items={g.children} />
						</div>
					</div>
				);
			})}
		</div>
	);
}
