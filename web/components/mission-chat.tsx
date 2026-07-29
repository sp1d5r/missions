"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Ask the mission's overseer about it, in the mission's own thread.
 *
 * The old composer posted to the chief and said "sent — the chief replies in #chief". You asked
 * here and the answer landed somewhere else, so in practice nobody ever read it. Worse, the chief
 * only knows what the registry says; it was never the thing that could tell you why an assertion
 * failed.
 *
 * This talks to the overseer for THIS mission — it has the state, the log, the diff and read-only
 * access to the worktree — and renders the reply where you asked. History comes from the same
 * chat.jsonl the TUI writes, so a question asked in the terminal is here when you open the page.
 *
 * The reply streams in. The request is a POST, so EventSource is out — it only does GET — and the
 * response body is read directly instead. Same SSE framing on the wire, parsed by hand, which is
 * a few lines and avoids putting the question in a URL.
 */

interface Entry {
	role: "user" | "overseer";
	text: string;
	at: string;
}

function clock(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MissionChat({
	id,
	name,
	done,
	cleared,
	canMutate,
}: {
	id: string;
	name: string;
	done: boolean;
	cleared: boolean;
	canMutate: boolean;
}) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [draft, setDraft] = useState("");
	const [asking, setAsking] = useState(false);
	/** The answer as it arrives, before the turn completes and it becomes a real entry. */
	const [live, setLive] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	/** clear / merge — the two things that act on a mission rather than ask about it. */
	const [acting, setActing] = useState<"clear" | "merge" | null>(null);
	const [wasCleared, setWasCleared] = useState(cleared);
	const [note, setNote] = useState<string | null>(null);
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		fetch(`/api/m/${id}/chat`)
			.then((r) => (r.ok ? r.json() : { entries: [] }))
			.then((j: { entries?: Entry[] }) => {
				if (alive) {
					setEntries(j.entries ?? []);
					setLoaded(true);
				}
			})
			.catch(() => alive && setLoaded(true));
		return () => {
			alive = false;
		};
	}, [id]);

	// Only scroll for messages that arrive after the first load — yanking the page down to a
	// months-old conversation the moment it opens is worse than not scrolling at all.
	useEffect(() => {
		if (loaded && entries.length) endRef.current?.scrollIntoView({ block: "nearest" });
	}, [entries.length, loaded]);

	const ask = useCallback(async () => {
		const text = draft.trim();
		if (!text || asking) return;
		setAsking(true);
		setError(null);
		setLive("");
		// Optimistic, so the question is on screen while the answer is being written.
		setEntries((prev) => [...prev, { role: "user", text, at: new Date().toISOString() }]);
		setDraft("");
		const fail = (msg: string) => {
			setError(msg);
			// Put it back in the box: losing what you typed because a request failed is the one
			// thing a chat box must never do.
			setDraft(text);
			setEntries((prev) => prev.slice(0, -1));
		};
		try {
			const res = await fetch(`/api/m/${id}/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
			// A guard rejection is still plain JSON — only a turn that actually started streams.
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
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				// SSE frames are separated by a blank line; anything after the last one is a
				// partial frame and stays in the buffer.
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
			// The streamed text and the persisted answer are the same string; swap to the
			// recorded one so a reload shows exactly what is on screen now.
			setEntries((prev) => [...prev, { role: "overseer", text: answer, at }]);
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
				} else setNote("merge sent to the chief");
			} catch (err) {
				setNote(err instanceof Error ? err.message : String(err));
			} finally {
				setActing(null);
			}
		},
		[id, name],
	);

	return (
		<>
			<div className="msg-sep">
				<span>ask the overseer</span>
			</div>

			{entries.length === 0 && loaded && (
				<div className="faint" style={{ padding: "4px 0 8px" }}>
					Nothing asked yet. It has read the plan, the log, the diff and the worktree — ask it why
					something failed, not just what did.
				</div>
			)}

			<div className="chat">
				{entries.map((e, i) => {
					const prev = entries[i - 1];
					const cont =
						prev !== undefined &&
						prev.role === e.role &&
						Math.abs(new Date(e.at).getTime() - new Date(prev.at).getTime()) < 5 * 60_000;
					return (
						<div key={`${e.at}-${i}`} className={`cmsg${cont ? " is-cont" : ""}`}>
							{!cont && (
								<div className="cmsg-head">
									<span className="cmsg-who" data-role={e.role === "user" ? "you" : "overseer"}>
										{e.role === "user" ? "you" : "overseer"}
									</span>
									<span className="cmsg-when">{clock(e.at)}</span>
								</div>
							)}
							<div className="cmsg-text">{e.text}</div>
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
						{/*
						 * Before the first token there is genuinely nothing to show, and the
						 * overseer's first act is reading — so say that rather than render an
						 * empty bubble that reads as a stall.
						 */}
						<div className={`cmsg-text${live ? "" : " faint"}`}>
							{live || "reading the mission…"}
							{live && <span className="caret" />}
						</div>
					</div>
				)}
				<div ref={endRef} />
			</div>

			{error && <div className="alert" style={{ margin: "8px 0" }}>{error}</div>}

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
						placeholder={`Ask about ${name} — why it stalled, what a2 proves, what to do next…`}
						disabled={asking}
					/>
					{/*
					 * Acting on the left, asking on the right. They are different kinds of verb —
					 * clear and merge change the world and cannot be undone from here, ask only
					 * reads — so they get opposite ends of the bar rather than sitting adjacent
					 * where a mis-tap merges a branch you meant to ask about.
					 */}
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
