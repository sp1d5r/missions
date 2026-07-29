"use client";

import { useState } from "react";

/** Copy text to the clipboard, and say so — a button that does nothing visible reads as broken. */
export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setDone(true);
					setTimeout(() => setDone(false), 1600);
				});
			}}
		>
			{done ? "copied" : label}
		</button>
	);
}
