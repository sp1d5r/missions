"use client";

import { useEffect, useState } from "react";

/**
 * Wraps a pre-rendered SVG diagram so clicking it opens a full-screen modal copy.
 *
 * The inline canvas is sized to fit half the mission page now (see .mission-overview), and the
 * flow/contract diagrams pack a lot into that width — squinting at seven milestones' worth of
 * detail in a half-width column is not reading it. Escape or a backdrop click closes the modal.
 */
export function ZoomableSvg({ html, label }: { html: string; label: string }) {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);

	return (
		<>
			<div
				className="diagram-zoom-trigger"
				role="button"
				tabIndex={0}
				onClick={() => setOpen(true)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(true);
					}
				}}
				aria-label={`Open ${label} diagram full size`}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG, every text node escaped by esc()
				dangerouslySetInnerHTML={{ __html: html }}
			/>
			{open && (
				<div className="diagram-modal-backdrop" onClick={() => setOpen(false)}>
					<div className="diagram-modal" onClick={(e) => e.stopPropagation()}>
						<button type="button" className="diagram-modal-close" onClick={() => setOpen(false)} aria-label="Close">
							×
						</button>
						<div
							className="diagram-modal-canvas"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG, every text node escaped by esc()
							dangerouslySetInnerHTML={{ __html: html }}
						/>
					</div>
				</div>
			)}
		</>
	);
}
