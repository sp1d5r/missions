"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The chief, live and remembered.
 *
 * The daemon keeps one session and broadcasts to every attached client, so what
 * you type here lands in the same conversation your terminal is watching. It is
 * one thread, not a second org.
 *
 * Messages are BLOCKS, not frames. The session emits token chunks — a frame can
 * be "N" and the next "ice" — so rendering one element per frame put hard line
 * breaks inside words. Consecutive chief output extends the open block instead.
 */

type Role = "you" | "chief" | "system";

interface Block {
	role: Role;
	text: string;
	/** ISO. Recorded entries carry their real time; live blocks stamp on arrival. */
	at: string;
}

/**
 * The daemon prefixes a reply with its own speaker label ("chief\n"), which we
 * already render as the message author — leaving it in the body printed the
 * name twice. Stripped only at the very start, and only for that role.
 */
function clean(b: Block): string {
	const t = b.text.replace(/^\n+/, "");
	return b.role === "chief" ? t.replace(/^chief[ \t]*\n?/, "") : t;
}

function clock(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface WorkspaceOption {
	name: string;
	path: string;
}

export function ChiefConsole({
	canMutate,
	workspaces = [],
	focus,
}: {
	canMutate: boolean;
	workspaces?: WorkspaceOption[];
	/** Absolute path the chief is pointed at, or undefined if nothing has published it. */
	focus?: string;
}) {
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [status, setStatus] = useState<"connecting" | "live" | "down">("connecting");
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	// Optimistic, so the picker reflects the click immediately. The server value is authoritative
	// on the next load — a failed move reverts to it.
	const [here, setHere] = useState<string | undefined>(focus);
	const [moving, setMoving] = useState(false);
	const logRef = useRef<HTMLDivElement>(null);
	const pinnedToBottom = useRef(true);
	/*
	 * Replayed history is sealed.
	 *
	 * On (re)connect the daemon greets, and that greeting arrives as an `out`
	 * chunk. Without this the coalescer glued it onto the last recorded message
	 * ("persistence check ok\u263c missions — chief of staff"). The first live
	 * chunk after a replay always opens a new block.
	 */
	const sealed = useRef(false);

	useEffect(() => {
		const es = new EventSource("/api/chief/stream");

		es.addEventListener("history", (e) => {
			const rows = JSON.parse((e as MessageEvent).data) as Partial<Block>[];
			const next = rows
				.filter((r): r is Block => typeof r.text === "string" && typeof r.at === "string")
				.map((r) => ({ role: (r.role ?? "chief") as Role, text: r.text, at: r.at }));
			// Replayed on every reconnect, which now happens on a timer. Replacing an identical
			// list would re-render the pane and lose the scroll position for no reason.
			setBlocks((prev) =>
				prev.length === next.length && prev.every((b, i) => b.text === next[i]?.text && b.at === next[i]?.at)
					? prev
					: next,
			);
			pinnedToBottom.current = true;
			sealed.current = true;
		});
		es.addEventListener("open", () => setStatus("live"));
		es.addEventListener("greet", (e) => {
			const text = JSON.parse((e as MessageEvent).data) as string;
			setBlocks((prev) => {
				// The connection is now closed and reopened on a timer (see the stream route on
				// why), and each reopen greets. Shown once, on an empty pane — otherwise the
				// banner would land mid-conversation every segment.
				if (prev.length) return prev;
				return [...prev, { role: "chief" as const, text, at: new Date().toISOString() }];
			});
			// Sealed so the first real reply opens its own message rather than
			// extending the banner.
			sealed.current = true;
		});
		es.addEventListener("down", () => setStatus("down"));
		es.addEventListener("out", (e) => {
			const chunk = JSON.parse((e as MessageEvent).data) as string;
			setBlocks((prev) => {
				const last = sealed.current ? undefined : prev[prev.length - 1];
				sealed.current = false;
				if (last && last.role === "chief") {
					const next = prev.slice(0, -1);
					next.push({ ...last, text: last.text + chunk });
					return next.slice(-400);
				}
				return [...prev, { role: "chief" as const, text: chunk, at: new Date().toISOString() }].slice(-400);
			});
		});
		// The route no longer returns a non-2xx when the daemon is down, so an
		// error here is a genuine transport failure; EventSource retries on its own.
		es.onerror = () => setStatus("down");

		return () => es.close();
	}, []);

	// Only auto-scroll when already at the bottom — yanking the view while
	// someone is reading back through output is worse than no scroll at all.
	useEffect(() => {
		const el = logRef.current;
		if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
	}, [blocks]);

	const onScroll = useCallback(() => {
		const el = logRef.current;
		if (!el) return;
		pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}, []);

	const send = useCallback(async () => {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		// Optimistic: the recorder will also persist it, and history on the next
		// load is the source of truth.
		setBlocks((prev) => [...prev, { role: "you" as const, text, at: new Date().toISOString() }]);
		pinnedToBottom.current = true;
		try {
			const res = await fetch("/api/actions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "steer", text }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setBlocks((prev) => [
					...prev,
					{ role: "system" as const, text: body.error ?? res.statusText, at: new Date().toISOString() },
				]);
			} else {
				setDraft("");
			}
		} catch (err) {
			setBlocks((prev) => [
				...prev,
				{
					role: "system" as const,
					text: err instanceof Error ? err.message : String(err),
					at: new Date().toISOString(),
				},
			]);
		} finally {
			setSending(false);
		}
	}, [draft, sending]);

	const moveFocus = useCallback(
		async (path: string) => {
			if (!canMutate || moving || path === here) return;
			const previous = here;
			setMoving(true);
			setHere(path);
			try {
				const res = await fetch("/api/actions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "focus", repo: path }),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setHere(previous);
					setBlocks((prev) => [
						...prev,
						{ role: "system" as const, text: body.error ?? res.statusText, at: new Date().toISOString() },
					]);
				}
			} catch (err) {
				setHere(previous);
				setBlocks((prev) => [
					...prev,
					{
						role: "system" as const,
						text: err instanceof Error ? err.message : String(err),
						at: new Date().toISOString(),
					},
				]);
			} finally {
				setMoving(false);
			}
		},
		[canMutate, here, moving],
	);

	let lastDay = "";

	return (
		<>
			<div className="thread" ref={logRef} onScroll={onScroll}>
				<div className="row" style={{ marginBottom: 10 }}>
					<span
						className={`tag ${status === "live" ? "t-live" : status === "down" ? "t-bad" : "t-quiet"}`}
					>
						{status === "live" ? "attached" : status === "down" ? "daemon down" : "connecting"}
					</span>
					{status === "down" && (
						<span className="faint grow">
							Waiting for the org — start it on the host with `missions chat`.
						</span>
					)}
				</div>

				{/*
				 * Where the chief is pointed, and how to move it.
				 *
				 * Focus is global — this repoints an attached terminal too — so it is shown as
				 * state you can see rather than a hidden default. The chief can reach any repo by
				 * name or absolute path regardless; this only sets what "here" means when you
				 * don't say.
				 */}
				{workspaces.length > 0 && (
					<div className="row focus-bar" style={{ marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
						<span className="faint">focus</span>
						{workspaces.map((w) => {
							const active = w.path === here;
							return (
								// Deliberately NOT disabled when active: `button:disabled` fades to .4
								// opacity, which would make the repo you are actually in the dimmest
								// thing in the row. moveFocus already no-ops on a re-click.
								<button
									key={w.path}
									type="button"
									className={`tag focus-pick ${active ? "t-live" : "t-quiet"}`}
									title={w.path}
									aria-pressed={active}
									disabled={!canMutate || moving}
									onClick={() => void moveFocus(w.path)}
								>
									{w.name}
								</button>
							);
						})}
						{here === undefined && (
							<span className="faint">unknown — start the org to publish it</span>
						)}
					</div>
				)}

				{blocks.length === 0 ? (
					<span className="faint">
						Nothing yet. The chief speaks when it has something to say — or ask it something.
					</span>
				) : (
					<div className="chat">
						{blocks.map((b, i) => {
							const prev = blocks[i - 1];
							const d = new Date(b.at).toDateString();
							const newDay = d !== lastDay && d !== "Invalid Date";
							lastDay = d;
							// Same speaker, within five minutes, no day break: a continuation.
							const cont =
								!newDay &&
								prev !== undefined &&
								prev.role === b.role &&
								Math.abs(new Date(b.at).getTime() - new Date(prev.at).getTime()) < 5 * 60_000;
							return (
								// Position is the identity: blocks are not uniquely identifiable.
								<div key={`${i}-${b.at}`}>
									{newDay && (
										<div className="msg-sep">
											<span>{d}</span>
										</div>
									)}
									<div
										className={`cmsg${cont ? " is-cont" : ""}${b.role === "system" ? " is-system" : ""}`}
									>
										{!cont && (
											<div className="cmsg-head">
												<span className="cmsg-who" data-role={b.role}>
													{b.role}
												</span>
												<span className="cmsg-when">{clock(b.at)}</span>
											</div>
										)}
										<div className="cmsg-text">{clean(b)}</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			<div className="composer">
				<textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						// Enter sends; Shift+Enter is a newline. Matches the TUI.
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={canMutate ? "Message the chief…" : "Writes disabled until pinned"}
					disabled={!canMutate}
				/>
				<div className="row" style={{ marginTop: 8 }}>
					<button
						type="button"
						className="primary"
						onClick={() => void send()}
						disabled={!canMutate || sending || !draft.trim()}
					>
						{sending ? "sending…" : "send"}
					</button>
				</div>
			</div>
		</>
	);
}
