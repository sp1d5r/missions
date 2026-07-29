"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DispatchForm({
	repos,
	canMutate,
}: {
	repos: { path: string; name: string }[];
	canMutate: boolean;
}) {
	const router = useRouter();
	const [repo, setRepo] = useState(repos[0]?.name ?? "");
	const [goal, setGoal] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	async function dispatch() {
		if (!goal.trim() || busy) return;
		setBusy(true);
		setNote(null);
		try {
			const res = await fetch("/api/actions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "dispatch", repo, text: goal.trim() }),
			});
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setNote(body.error ?? res.statusText);
			} else {
				setNote("dispatched — the chief will confirm on Chief, and it'll appear on the board");
				setGoal("");
				router.refresh();
			}
		} catch (err) {
			setNote(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	if (!canMutate) {
		return (
			<div className="faint">
				Dispatch is disabled until this console is pinned. A mission spends real money, so being
				signed in is not enough.
			</div>
		);
	}

	return (
		<div className="stack">
			<div>
				<div className="label">Repo</div>
				<select value={repo} onChange={(e) => setRepo(e.target.value)}>
					{repos.map((r) => (
						<option key={r.path} value={r.name}>
							{r.name}
						</option>
					))}
				</select>
			</div>
			<div>
				<div className="label">Goal</div>
				<textarea
					value={goal}
					onChange={(e) => setGoal(e.target.value)}
					placeholder="One line. The chief will plan it and dispatch a worker into its own worktree."
				/>
			</div>
			<div className="row">
				<button type="button" className="primary" onClick={() => void dispatch()} disabled={busy || !goal.trim()}>
					{busy ? "dispatching…" : "dispatch"}
				</button>
				{note && <span className="faint grow">{note}</span>}
			</div>
		</div>
	);
}
