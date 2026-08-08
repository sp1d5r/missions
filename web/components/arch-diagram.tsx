"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The mission's system architecture, rendered from the planner's mermaid.
 *
 * The console used to show a contract map here — features on the left, assertions on the right —
 * and call it the diagram. That is a coverage matrix, not architecture: it says what proved what,
 * and nothing at all about what talks to what or where the change lands. The planner is the only
 * thing in the system that has read the repo and decided, so it now emits real flowchart source
 * (see orchestrator.ts) and this draws it.
 *
 * Rendered client-side and lazily. Mermaid is ~1MB; a mission page must not pay for it before
 * anyone opens the panel, and nothing here is needed for the page to be useful.
 */
export function ArchDiagram({ source, theme }: { source: string; theme: Record<string, string> }) {
	const ref = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const mermaid = (await import("mermaid")).default;
				mermaid.initialize({
					startOnLoad: false,
					// The console's palette, so the diagram belongs to the page rather than
					// arriving as a foreign object with its own opinions about colour.
					theme: "base",
					themeVariables: theme,
					fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
					flowchart: { curve: "basis", useMaxWidth: true },
					securityLevel: "strict",
				});
				// A unique id per render: mermaid caches by id and would otherwise reuse a stale
				// drawing when the plan changes.
				const id = `arch-${Math.random().toString(36).slice(2)}`;
				const { svg } = await mermaid.render(id, source);
				if (alive && ref.current) {
					ref.current.innerHTML = svg;
					// Kept for the zoomed modal copy — mermaid renders once into the DOM, but the
					// modal needs a second, larger instance of the same markup rather than a live
					// re-render (mermaid ids are one-shot; rendering `source` twice would collide).
					setSvgMarkup(svg);
				}
			} catch (err) {
				// A model wrote this source. It will occasionally be unparseable, and a broken
				// diagram must not take the mission page down with it.
				if (alive) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			alive = false;
		};
	}, [source, theme]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);

	if (error) {
		return (
			<div>
				<div className="faint" style={{ marginBottom: 6 }}>
					The planner's diagram did not parse — its source is below.
				</div>
				<pre className="src">{source}</pre>
			</div>
		);
	}
	return (
		<>
			<div
				className="arch diagram-zoom-trigger"
				ref={ref}
				role={svgMarkup ? "button" : undefined}
				tabIndex={svgMarkup ? 0 : undefined}
				onClick={() => svgMarkup && setOpen(true)}
				onKeyDown={(e) => {
					if (svgMarkup && (e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						setOpen(true);
					}
				}}
				aria-label={svgMarkup ? "Open system diagram full size" : undefined}
			/>
			{open && svgMarkup && (
				<div className="diagram-modal-backdrop" onClick={() => setOpen(false)}>
					<div className="diagram-modal" onClick={(e) => e.stopPropagation()}>
						<button type="button" className="diagram-modal-close" onClick={() => setOpen(false)} aria-label="Close">
							×
						</button>
						{/* biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's own render output */}
						<div className="diagram-modal-canvas" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
					</div>
				</div>
			)}
		</>
	);
}
