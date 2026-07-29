"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "clear" | "merge" | "steer";

/**
 * The mission's action bar, pinned to the bottom.
 *
 * It used to carry a text box too, which posted to the CHIEF and then told you the reply would
 * turn up in #chief — a question asked on one page answered on another, which in practice meant
 * nobody read it. Questions now go to the mission's own overseer, in the thread, via MissionChat.
 * What is left here is the two things that genuinely act on a mission rather than talk about it.
 *
 * `steer` survives for a RUNNING mission, where redirecting the work is a real instruction with a
 * real recipient rather than a question, and it still goes through the chief because the chief is
 * what owns dispatch.
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
				setNote(action === "clear" ? "cleared" : "sent to the chief");
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
			{!done && (
				<>
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								if (text.trim()) void run("steer", text);
							}
						}}
						placeholder={`Steer ${name} while it runs…`}
					/>
					<div className="row" style={{ marginTop: 8 }}>
						<button
							type="button"
							className="primary"
							onClick={() => void run("steer", text)}
							disabled={busy !== null || !text.trim()}
						>
							{busy === "steer" ? "sending…" : "steer"}
						</button>
					</div>
				</>
			)}
			<div className="row" style={{ marginTop: 8 }}>
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
