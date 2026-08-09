"use client";

import { useEffect, useState } from "react";

/**
 * A Linear-style status board for ideas that aren't missions yet — a fast triage dumping
 * ground, not a project-management tool. Four fixed columns, drag a card to move it, no
 * cycles/labels/sub-issues. See src/ideas.ts for the storage model this talks to.
 */

type IdeaStatus = "backlog" | "now" | "later" | "done";

interface Idea {
	id: string;
	title: string;
	description: string;
	status: IdeaStatus;
	createdAt: string;
	updatedAt: string;
}

const COLUMNS: { status: IdeaStatus; title: string }[] = [
	{ status: "backlog", title: "Backlog" },
	{ status: "now", title: "Now" },
	{ status: "later", title: "Later" },
	{ status: "done", title: "Done" },
];

export function IdeasBoard({ canMutate }: { canMutate: boolean }) {
	const [ideas, setIdeas] = useState<Idea[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	const [overStatus, setOverStatus] = useState<IdeaStatus | null>(null);

	useEffect(() => {
		let alive = true;
		fetch("/api/ideas")
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				return r.json() as Promise<{ ideas: Idea[] }>;
			})
			.then((d) => {
				if (alive) setIdeas(d.ideas);
			})
			.catch((e) => {
				if (alive) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			alive = false;
		};
	}, []);

	async function addIdea(title: string, description: string) {
		const res = await fetch("/api/ideas", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title, description }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? res.statusText);
			return;
		}
		const { idea } = (await res.json()) as { idea: Idea };
		setIdeas((prev) => (prev ? [idea, ...prev] : [idea]));
	}

	async function moveIdea(id: string, status: IdeaStatus) {
		setIdeas((prev) => (prev ? prev.map((i) => (i.id === id ? { ...i, status } : i)) : prev));
		const res = await fetch(`/api/ideas/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status }),
		}).catch(() => null);
		if (!res?.ok) {
			// Best-effort UI move; a failed write just gets corrected on next reload.
			setError("move didn't save — refresh to check");
		}
	}

	async function removeIdea(id: string) {
		setIdeas((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
		await fetch(`/api/ideas/${id}`, { method: "DELETE" }).catch(() => {});
	}

	if (error) return <div className="faint" style={{ padding: "10px 0" }}>ideas board unavailable — {error}</div>;
	if (!ideas) return <div className="faint" style={{ padding: "10px 0" }}>loading ideas…</div>;

	return (
		<div className="ideas-board">
			{canMutate ? (
				<IdeaComposer onAdd={addIdea} />
			) : (
				<div className="faint" style={{ padding: "10px 0" }}>
					Adding ideas is disabled until this console is pinned.
				</div>
			)}
			<div className="ideas-columns">
				{COLUMNS.map((col) => {
					const items = ideas.filter((i) => i.status === col.status);
					return (
						<div
							key={col.status}
							className={`ideas-column${overStatus === col.status ? " drag-over" : ""}`}
							onDragOver={(e) => {
								if (!canMutate) return;
								e.preventDefault();
								setOverStatus(col.status);
							}}
							onDragLeave={() => setOverStatus((s) => (s === col.status ? null : s))}
							onDrop={(e) => {
								e.preventDefault();
								setOverStatus(null);
								if (!canMutate || !dragId) return;
								void moveIdea(dragId, col.status);
								setDragId(null);
							}}
						>
							<div className="ideas-column-head">
								<span>{col.title}</span>
								<span className="faint">{items.length}</span>
							</div>
							<div className="ideas-column-body">
								{items.length === 0 && <div className="faint ideas-empty">nothing here</div>}
								{items.map((idea) => (
									<div
										key={idea.id}
										className="idea-card"
										draggable={canMutate}
										onDragStart={() => setDragId(idea.id)}
										onDragEnd={() => setDragId(null)}
									>
										<div className="idea-title">{idea.title}</div>
										{idea.description && <div className="idea-desc">{idea.description}</div>}
										{canMutate && (
											<button type="button" className="idea-remove" title="delete" onClick={() => void removeIdea(idea.id)}>
												×
											</button>
										)}
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function IdeaComposer({ onAdd }: { onAdd: (title: string, description: string) => Promise<void> }) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit() {
		const t = title.trim();
		if (!t || busy) return;
		setBusy(true);
		try {
			await onAdd(t, description.trim());
			setTitle("");
			setDescription("");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="row ideas-composer">
			<input
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && void submit()}
				placeholder="New idea…"
				className="grow"
			/>
			<input
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && void submit()}
				placeholder="short description (optional)"
				className="grow"
			/>
			<button type="button" className="primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
				add
			</button>
		</div>
	);
}
