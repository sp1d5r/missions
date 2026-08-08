"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The shared scoping document: markdown the user and the mission's agent both edit, with
 * annotation threads anchored to specific lines. See src/scoping.ts for the storage model and
 * web/app/api/m/[id]/scoping/route.ts for the read/write API this talks to.
 *
 * Ported from the prototype (see conversation — three annotation-style mockups compared, this one
 * won: real freeform prose, selection-level annotation rather than whole-paragraph, comments kept
 * out of the way behind a toggle instead of a permanent rail). This is the first real slice: doc +
 * threads persist and round-trip through the API. What's NOT here yet — the agent's own side of a
 * thread landing automatically (see the route's doc comment), and pulling live diagrams/contract/
 * bugs content into the doc body. Both are real follow-up work, not stubbed here.
 */

interface ScopingAnchor {
	line: number;
	snippet: string;
}
interface ScopingMessage {
	role: "user" | "agent";
	text: string;
	at: string;
}
interface ScopingThread {
	id: string;
	anchor: ScopingAnchor;
	resolved: boolean;
	messages: ScopingMessage[];
}
interface ScopingResponse {
	doc: string;
	exists: boolean;
	threads: ScopingThread[];
}

export function ScopingDoc({ missionId }: { missionId: string }) {
	const [data, setData] = useState<ScopingResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [railOpen, setRailOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const docRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		fetch(`/api/m/${missionId}/scoping`)
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				return r.json() as Promise<ScopingResponse>;
			})
			.then((d) => {
				if (alive) setData(d);
			})
			.catch((e) => {
				if (alive) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			alive = false;
		};
	}, [missionId]);

	if (error) {
		return <div className="faint" style={{ padding: "10px 0", fontSize: 11.5 }}>scoping doc unavailable — {error}</div>;
	}
	if (!data) {
		return <div className="faint" style={{ padding: "10px 0", fontSize: 11.5 }}>loading scoping doc…</div>;
	}
	if (!data.exists) {
		return (
			<div className="faint" style={{ padding: "10px 0", fontSize: 11.5 }}>
				No scoping doc for this mission yet — the agent writes one during planning.
			</div>
		);
	}

	const lines = data.doc.split("\n");
	const threadsByLine = new Map<number, ScopingThread[]>();
	for (const t of data.threads) {
		const arr = threadsByLine.get(t.anchor.line) ?? [];
		arr.push(t);
		threadsByLine.set(t.anchor.line, arr);
	}
	const openCount = data.threads.filter((t) => !t.resolved).length;

	async function openThread(line: number, snippet: string, text: string) {
		setBusy(true);
		try {
			const res = await fetch(`/api/m/${missionId}/scoping`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "open", line, snippet, text }),
			});
			if (!res.ok) throw new Error(`${res.status}`);
			const { threadId } = (await res.json()) as { threadId: string };
			setData((prev) =>
				prev
					? {
							...prev,
							threads: [...prev.threads, { id: threadId, anchor: { line, snippet }, resolved: false, messages: [{ role: "user", text, at: new Date().toISOString() }] }],
						}
					: prev,
			);
			setRailOpen(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	async function toggleResolve(threadId: string, resolved: boolean) {
		setData((prev) => (prev ? { ...prev, threads: prev.threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)) } : prev));
		await fetch(`/api/m/${missionId}/scoping`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "resolve", threadId, resolved }),
		}).catch(() => {});
	}

	return (
		<div className="scoping-doc">
			<div className="scoping-toolbar">
				<span className="label">scoping doc</span>
				<button type="button" className="comments-fab" onClick={() => setRailOpen((v) => !v)} disabled={busy}>
					<span className={`dot${openCount === 0 ? " empty" : ""}`} />
					comments
					<span className="count">{openCount}</span>
				</button>
			</div>

			<div className="scoping-body" ref={docRef}>
				{lines.map((text, i) => {
					const lineNo = i + 1;
					const threadsHere = threadsByLine.get(lineNo) ?? [];
					if (!text.trim()) return <div key={lineNo} style={{ height: 8 }} />;
					const isHeading = /^#{1,3}\s/.test(text);
					return (
						<ScopingLine
							key={lineNo}
							lineNo={lineNo}
							text={text.replace(/^#{1,3}\s/, "")}
							heading={isHeading}
							threads={threadsHere}
							onOpenThread={openThread}
							onJump={() => setRailOpen(true)}
						/>
					);
				})}
			</div>

			{railOpen && (
				<>
					<div className="scoping-rail-backdrop" onClick={() => setRailOpen(false)} />
					<div className="scoping-rail">
						<div className="scoping-rail-head">
							<span>comments</span>
							<button type="button" className="rail-close" onClick={() => setRailOpen(false)}>
								×
							</button>
						</div>
						{data.threads.length === 0 && <div className="faint" style={{ fontSize: 11 }}>Select any line in the doc to start a thread.</div>}
						{data.threads.map((t) => (
							<div key={t.id} className={`scoping-thread${t.resolved ? " resolved" : ""}`}>
								<div className="scoping-thread-anchor">{t.anchor.snippet}</div>
								{t.messages.map((m, mi) => (
									<div key={mi} className={`scoping-msg ${m.role}`}>
										<div className="who">{m.role === "user" ? "you" : "agent"}</div>
										{m.text}
									</div>
								))}
								<div className="scoping-thread-actions">
									<button type="button" onClick={() => toggleResolve(t.id, !t.resolved)}>
										{t.resolved ? "reopen" : "resolve"}
									</button>
								</div>
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function ScopingLine({
	lineNo,
	text,
	heading,
	threads,
	onOpenThread,
	onJump,
}: {
	lineNo: number;
	text: string;
	heading: boolean;
	threads: ScopingThread[];
	onOpenThread: (line: number, snippet: string, text: string) => void;
	onJump: () => void;
}) {
	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState("");
	const [selection, setSelection] = useState<string | null>(null);

	function onMouseUp() {
		const sel = window.getSelection();
		const s = sel?.toString().trim();
		if (s && s.length > 1) {
			setSelection(s);
			setComposing(true);
		}
	}

	function commit() {
		const val = draft.trim();
		if (!val) return;
		onOpenThread(lineNo, selection ?? text, val);
		setComposing(false);
		setDraft("");
		setSelection(null);
	}

	const hasThread = threads.length > 0;
	const unresolved = threads.some((t) => !t.resolved);

	return (
		<div className={`scoping-line${hasThread ? " has-thread" : ""}${hasThread && !unresolved ? " resolved" : ""}`}>
			{heading ? <div className="scoping-heading">{text}</div> : <span onMouseUp={onMouseUp}>{text}</span>}
			{hasThread && (
				<button type="button" className="scoping-marker" onClick={onJump} title={`${threads.length} thread(s)`}>
					{threads.length}
				</button>
			)}
			{composing && (
				<div className="scoping-composer">
					<div className="anchor-preview">annotate: "{(selection ?? text).slice(0, 48)}"</div>
					<div className="row">
						{/* biome-ignore lint/a11y/noAutofocus: opens directly from a user gesture (mouseup) */}
						<input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit()} placeholder="type a comment…" />
						<button type="button" onClick={commit}>
							send
						</button>
						<button type="button" onClick={() => setComposing(false)}>
							cancel
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
