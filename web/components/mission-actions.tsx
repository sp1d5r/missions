"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "clear" | "merge" | "steer";

/**
 * The composer, pinned to the bottom of the thread.
 *
 * Enter sends and Shift+Enter breaks the line, matching both the TUI and every
 * chat app anyone has muscle memory for. The textarea is 16px because anything
 * smaller makes iOS Safari zoom the whole page on focus, and the wrapper
 * carries the safe-area inset so the send button clears the home indicator.
 */
export function MissionComposer({
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
	const router = useRouter();
	const [busy, setBusy] = useState<Action | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [text, setText] = useState("");

	async function run(action: Action, body?: string) {
		setBusy(action);
		setNote(null);
		try {
			const res = await fetch("/api/actions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, id, name, text: body }),
			});
			const json = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setNote(json.error ?? res.statusText);
			} else {
				setNote(action === "clear" ? "cleared" : "sent — the chief replies in #chief");
				if (action === "steer") setText("");
				router.refresh();
			}
		} catch (err) {
			setNote(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	if (!canMutate) {
		return (
			<div className="composer">
				<span className="faint">Writes are disabled until this console is pinned to your user id.</span>
			</div>
		);
	}

	return (
		<div className="composer">
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						if (text.trim()) void run("steer", text);
					}
				}}
				placeholder={done ? `Ask the chief about ${name}…` : `Steer ${name} while it runs…`}
			/>
			<div className="row" style={{ marginTop: 8 }}>
				<button
					type="button"
					className="primary"
					onClick={() => void run("steer", text)}
					disabled={busy !== null || !text.trim()}
				>
					{busy === "steer" ? "sending…" : "send"}
				</button>
				<button type="button" onClick={() => void run("clear")} disabled={busy !== null || cleared}>
					{cleared ? "cleared" : "clear"}
				</button>
				<button
					type="button"
					onClick={() => {
						if (confirm(`Merge ${name} into its repo's checked-out branch?`)) void run("merge");
					}}
					disabled={busy !== null || !done}
					title={done ? undefined : "Mission is still running"}
				>
					merge
				</button>
				{note && <span className="faint grow">{note}</span>}
			</div>
		</div>
	);
}
