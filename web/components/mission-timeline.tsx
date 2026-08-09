"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SEATS, type Seat, seatOf } from "@missions/seats.js";
import type { MissionEvent } from "@missions/types.js";
import { Tag, type Tone } from "@/components/chrome";
import { Markdown } from "@/lib/markdown";
import type { MilestoneDiff } from "@/lib/milestone-diff";

/**
 * A mission read as one conversation: what the org did, what each milestone's diff was, and what
 * you asked the overseer about it — in the order it actually happened.
 *
 * This replaces two components that used to sit stacked on top of each other: MissionThread (the
 * event feed, milestones invisible except as a raw verdict line) above MissionChat (the Q&A,
 * scrolled separately in spirit even when the DOM let them share a scrollbar). Splitting attempts
 * from the conversation about those attempts was the actual complaint — you read the run, then
 * re-oriented yourself to read the questions about the run you just read, in a second vocabulary.
 * One timeline, one `cmsg` grammar, sorted by `at`.
 *
 * `milestone_verdict` and `validation_result` events are deliberately excluded from the raw feed
 * below — they are the same facts a `MilestoneAttempt` card already shows, as a diff instead of a
 * flat re-statement of the current contract. Every other event kind (tool_call, lifecycle,
 * status_transition, error, image) renders exactly as it always has.
 */

interface ChatEntry {
	role: "user" | "overseer";
	text: string;
	at: string;
}

type Item =
	| { kind: "event"; at: string; e: MissionEvent }
	| { kind: "milestone"; at: string; diff: MilestoneDiff }
	| { kind: "chat"; at: string; entry: ChatEntry };

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

const VERDICT_TONE: Record<string, Tone> = {
	passed: "ok",
	"corrections-scoped": "warn",
	"budget-exhausted": "bad",
	"max-milestones": "bad",
	stalled: "warn",
};

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

/** A closer at the bottom of a long `<details>`, so collapsing it doesn't mean scrolling back up
 *  to find the summary line you opened. */
function Closeable({
	className,
	summary,
	children,
	flagged,
}: {
	className: string;
	summary: React.ReactNode;
	children: React.ReactNode;
	flagged?: boolean;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	return (
		<details className={`${className}${flagged ? " is-flagged" : ""}`} ref={ref}>
			<summary>{summary}</summary>
			{children}
			<button
				type="button"
				className="closer"
				onClick={() => {
					if (!ref.current) return;
					ref.current.open = false;
					ref.current.scrollIntoView({ block: "nearest" });
				}}
			>
				close
			</button>
		</details>
	);
}

function diffSummary(diff: MilestoneDiff): React.ReactNode {
	const parts: React.ReactNode[] = [];
	if (diff.fixed.length) {
		parts.push(
			<span className="fx" key="fx">
				{diff.fixed.map((a) => a.id).join(", ")} fixed
			</span>,
		);
	}
	if (diff.newlyFailing.length) {
		parts.push(
			<span className="nw" key="nw">
				{diff.newlyFailing.map((a) => a.id).join(", ")} newly failing
			</span>,
		);
	}
	if (diff.stillFailing.length) {
		parts.push(
			<span className="st" key="st">
				{diff.stillFailing.length} still stuck
			</span>,
		);
	}
	if (parts.length === 0) {
		return <span className="fx">{diff.total ? `${diff.passed}/${diff.total} — no change` : "no assertions yet"}</span>;
	}
	const joined: React.ReactNode[] = [];
	parts.forEach((p, i) => {
		if (i > 0) joined.push(" — ");
		joined.push(p);
	});
	return joined;
}

function MilestoneAttempt({ diff }: { diff: MilestoneDiff }) {
	const m = diff.milestone;
	const tone = VERDICT_TONE[m.verdict] ?? "quiet";
	const flagged = diff.flips.length > 0 || (diff.stillFailing.length >= 3 && diff.fixed.length === 0);
	const timeRange = diff.startedAt && diff.endedAt ? `${clock(diff.startedAt)} → ${clock(diff.endedAt)}` : (diff.endedAt ?? diff.startedAt ? clock((diff.endedAt ?? diff.startedAt) as string) : "");

	return (
		<Closeable
			className="attempt"
			flagged={flagged}
			summary={
				<>
					<span className="attempt-verdict">m{m.index}</span>
					<span className="attempt-diff">{diffSummary(diff)}</span>
					{timeRange && <span className="attempt-meta">{timeRange}</span>}
					<Tag tone={tone}>{m.verdict}</Tag>
				</>
			}
		>
			<div className="attempt-body">
				{diff.newlyFailing.map((a) => (
					<div className="diff-line newfail" key={a.id}>
						<span className="mark">✗</span>
						<span className="id">{a.id}</span>
						<span className="stmt">{a.statement}</span>
					</div>
				))}
				{diff.stillFailing.map((a) => (
					<div className="diff-line stillfail" key={a.id}>
						<span className="mark">●</span>
						<span className="id">{a.id}</span>
						<span className="stmt">{a.statement}</span>
					</div>
				))}
				{diff.flips.map((a) => (
					<div className="diff-line flip" key={`flip-${a.id}`}>
						<span className="mark">⚠</span>
						<span className="id">{a.id}</span>
						<span className="stmt">flip-flopped across milestones — not a clean pass or a clean fail, most likely a non-deterministic check. {a.statement}</span>
					</div>
				))}
				{m.assessment && (
					<p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, maxWidth: "60ch" }}>{m.assessment}</p>
				)}
				{diff.checklist.length > 0 && (
					<Closeable className="full-checklist" summary={`full checklist (${diff.checklist.length})`}>
						{diff.checklist.map((c) => (
							<div className={`cl-row ${c.flipped ? "flipped" : c.passed ? "pass" : "fail"}`} key={c.id}>
								<span className="mk">{c.flipped ? "⚠" : c.passed ? "✓" : "✗"}</span>
								<span className="id">{c.id}</span>
								<span className="stmt">{c.statement}</span>
							</div>
						))}
					</Closeable>
				)}
			</div>
		</Closeable>
	);
}

/** Text past this length gets a visible lead-in plus a collapsed rest, instead of one long scroll
 *  — the same reason milestones collapse. A short answer is never split. */
const LONG_MESSAGE_CHARS = 1200;

function splitLongMessage(text: string): { lead: string; rest: string | null } {
	if (text.length < LONG_MESSAGE_CHARS) return { lead: text, rest: null };
	const paras = text.split(/\n\s*\n/);
	let leadEnd = 0;
	let leadChars = 0;
	while (leadEnd < paras.length && leadChars < 500) {
		leadChars += paras[leadEnd].length;
		leadEnd++;
	}
	const rest = paras.slice(leadEnd).join("\n\n").trim();
	if (rest.length < 300) return { lead: text, rest: null };
	return { lead: paras.slice(0, leadEnd).join("\n\n"), rest };
}

function ChatText({ text }: { text: string }) {
	const { lead, rest } = splitLongMessage(text);
	return (
		<div className="cmsg-text">
			<Markdown text={lead} />
			{rest && (
				<Closeable className="trace-toggle" summary="show the rest of this message">
					<div className="trace-body">
						<Markdown text={rest} />
					</div>
				</Closeable>
			)}
		</div>
	);
}

export function MissionTimeline({
	id,
	name,
	done,
	cleared,
	canMutate,
	events,
	milestoneDiffs,
}: {
	id: string;
	name: string;
	done: boolean;
	cleared: boolean;
	canMutate: boolean;
	events: MissionEvent[];
	milestoneDiffs: MilestoneDiff[];
}) {
	const router = useRouter();
	const [chatEntries, setChatEntries] = useState<ChatEntry[]>([]);
	const [draft, setDraft] = useState("");
	const [asking, setAsking] = useState(false);
	const [live, setLive] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [acting, setActing] = useState<"clear" | "merge" | null>(null);
	const [wasCleared, setWasCleared] = useState(cleared);
	const [note, setNote] = useState<string | null>(null);
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		fetch(`/api/m/${id}/chat`)
			.then((r) => (r.ok ? r.json() : { entries: [] }))
			.then((j: { entries?: ChatEntry[] }) => {
				if (alive) {
					setChatEntries(j.entries ?? []);
					setLoaded(true);
				}
			})
			.catch(() => alive && setLoaded(true));
		return () => {
			alive = false;
		};
	}, [id]);

	const merged = useMemo<Item[]>(() => {
		const filteredEvents = events.filter((e) => e.kind !== "milestone_verdict" && e.kind !== "validation_result");
		const items: Item[] = [
			...filteredEvents.map((e): Item => ({ kind: "event", at: e.at, e })),
			...milestoneDiffs.map((diff): Item => ({ kind: "milestone", at: diff.endedAt ?? diff.startedAt ?? "", diff })),
			...chatEntries.map((entry): Item => ({ kind: "chat", at: entry.at, entry })),
		];
		items.sort((a, b) => a.at.localeCompare(b.at));
		return items;
	}, [events, milestoneDiffs, chatEntries]);

	// Every message, milestone attempt and reply, in the order it happened — including on first
	// open. A page that lands on the oldest thing that ever occurred on a months-long mission is
	// not "safe", it's a page you have to scroll past everything to find out what's current.
	useEffect(() => {
		if (loaded) endRef.current?.scrollIntoView({ block: "end" });
	}, [merged.length, loaded]);

	const ask = useCallback(async () => {
		const text = draft.trim();
		if (!text || asking) return;
		setAsking(true);
		setError(null);
		setLive("");
		setChatEntries((prev) => [...prev, { role: "user", text, at: new Date().toISOString() }]);
		setDraft("");
		const fail = (msg: string) => {
			setError(msg);
			setDraft(text);
			setChatEntries((prev) => prev.slice(0, -1));
		};
		try {
			const res = await fetch(`/api/m/${id}/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
			if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("event-stream")) {
				const json = (await res.json().catch(() => ({}))) as { error?: string };
				fail(json.error ?? res.statusText);
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let answer = "";
			let at = new Date().toISOString();
			let failed: string | null = null;
			for (;;) {
				const { done: streamDone, value } = await reader.read();
				if (streamDone) break;
				buf += decoder.decode(value, { stream: true });
				const frames = buf.split("\n\n");
				buf = frames.pop() ?? "";
				for (const frame of frames) {
					const ev = /^event: (.+)$/m.exec(frame)?.[1];
					const raw = /^data: (.*)$/m.exec(frame)?.[1];
					if (!ev || raw === undefined) continue;
					let data: unknown;
					try {
						data = JSON.parse(raw);
					} catch {
						continue;
					}
					if (ev === "out") setLive((p) => p + (data as string));
					else if (ev === "done") {
						const d = data as { answer: string; at?: string };
						answer = d.answer;
						at = d.at ?? at;
					} else if (ev === "error") failed = (data as { error: string }).error;
				}
			}
			if (failed || !answer) {
				fail(failed ?? "the overseer returned nothing");
				return;
			}
			setChatEntries((prev) => [...prev, { role: "overseer", text: answer, at }]);
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		} finally {
			setAsking(false);
			setLive("");
		}
	}, [draft, asking, id]);

	const act = useCallback(
		async (action: "clear" | "merge") => {
			setActing(action);
			setNote(null);
			try {
				const res = await fetch("/api/actions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action, id, name }),
				});
				const json = (await res.json().catch(() => ({}))) as { error?: string };
				if (!res.ok) setNote(json.error ?? res.statusText);
				else if (action === "clear") {
					setWasCleared(true);
					setNote("cleared");
					router.refresh();
				} else {
					setNote("merge sent to the chief");
					router.refresh();
				}
			} catch (err) {
				setNote(err instanceof Error ? err.message : String(err));
			} finally {
				setActing(null);
			}
		},
		[id, name, router],
	);

	let lastDay = "";
	let lastWho: string | null = null;

	return (
		<>
			<div className="msg-sep">
				<span>the mission, as it happened</span>
			</div>

			{merged.length === 0 && loaded && <div className="empty">Nothing recorded for this mission yet.</div>}

			<div className="chat">
				{merged.map((item, i) => {
					const d = day(item.at);
					const newDay = d !== lastDay;
					if (newDay) lastWho = null;
					lastDay = d;

					if (item.kind === "milestone") {
						lastWho = null;
						return (
							<div key={`m-${item.diff.milestone.index}`}>
								{newDay && (
									<div className="msg-sep">
										<span>{d}</span>
									</div>
								)}
								<MilestoneAttempt diff={item.diff} />
							</div>
						);
					}

					const who = item.kind === "event" ? seatOf(item.e) : item.entry.role === "user" ? "you" : "overseer";
					const isError = item.kind === "event" && item.e.kind === "error";
					const cont = !newDay && lastWho === who && !isError;
					lastWho = who;
					const title = item.kind === "event" ? SEATS[who as Seat]?.role : undefined;

					return (
						<div key={`${item.kind}-${item.at}-${i}`}>
							{newDay && (
								<div className="msg-sep">
									<span>{d}</span>
								</div>
							)}
							<div className={`cmsg${cont ? " is-cont" : ""}${isError ? " is-system" : ""}`}>
								{!cont && (
									<div className="cmsg-head">
										<span className="cmsg-who" data-role={who} title={title}>
											{who}
										</span>
										<span className="cmsg-when">{clock(item.at)}</span>
									</div>
								)}
								{item.kind === "chat" ? (
									<ChatText text={item.entry.text} />
								) : (
									<div className="cmsg-text">
										<Markdown text={item.e.label} />
										{item.e.detail && <div className="msg-detail">{item.e.detail}</div>}
										{item.e.image && <MissionImage id={id} event={item.e} />}
									</div>
								)}
							</div>
						</div>
					);
				})}
				{asking && (
					<div className="cmsg">
						<div className="cmsg-head">
							<span className="cmsg-who" data-role="overseer">
								overseer
							</span>
						</div>
						<div className={`cmsg-text${live ? "" : " faint"}`}>
							{live || "reading the mission…"}
							{live && <span className="caret" />}
						</div>
					</div>
				)}
				<div ref={endRef} />
			</div>

			{error && (
				<div className="alert" style={{ margin: "8px 0" }}>
					{error}
				</div>
			)}

			{canMutate && (
				<div className="chat-composer">
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void ask();
							}
						}}
						placeholder={`Ask about ${name} — why it stalled, what a milestone proves, what to do next…`}
						disabled={asking}
					/>
					<div className="composer-bar">
						<div className="row">
							<button type="button" onClick={() => void act("clear")} disabled={acting !== null || wasCleared}>
								{wasCleared ? "cleared" : acting === "clear" ? "clearing…" : "clear"}
							</button>
							<button
								type="button"
								onClick={() => {
									if (confirm(`Merge ${name} into its repo's checked-out branch?`)) void act("merge");
								}}
								disabled={acting !== null || !done}
								title={done ? undefined : "Mission is still running"}
							>
								{acting === "merge" ? "merging…" : "merge"}
							</button>
							{note && <span className="faint">{note}</span>}
						</div>
						<button type="button" className="primary" onClick={() => void ask()} disabled={asking || !draft.trim()}>
							{asking ? "asking…" : "ask"}
						</button>
					</div>
				</div>
			)}
		</>
	);
}
