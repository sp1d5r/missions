import { contractMapSvg, mermaidSource, missionFlowSvg } from "@missions/diagram.js";
import type { MissionState } from "@missions/types.js";
import { ArchDiagram } from "@/components/arch-diagram";
import { CopyButton } from "@/components/copy-button";

/**
 * The mission as a picture, sticky above everything else.
 *
 * Three views, and only the first is architecture:
 *   SYSTEM — what talks to what, and which of those this mission changes. Drawn from mermaid the
 *   planner wrote (orchestrator.ts), because only the planner has read the repo and decided.
 *   FLOW — how the mission moved: milestones, verdicts, where it stopped.
 *   CONTRACT — what was claimed and what proved it. A coverage matrix. Useful, and deliberately
 *   NOT presented as architecture, which is what it was doing before.
 *
 * Sticky and collapsible because it is the frame you read everything else against — scrolling the
 * timeline should not scroll away the thing that gives it meaning. Collapsed state lives in
 * localStorage: a panel that reopens on every navigation is a panel you close every time.
 */

/** The console palette, handed to mermaid so the drawing belongs to the page. */
const MERMAID_THEME: Record<string, string> = {
	background: "#101214",
	primaryColor: "#15181a",
	primaryTextColor: "#d7dbde",
	primaryBorderColor: "#3a4046",
	secondaryColor: "#101214",
	tertiaryColor: "#101214",
	lineColor: "#5b6168",
	textColor: "#d7dbde",
	fontSize: "13px",
};

export function MissionDiagrams({ state }: { state: MissionState }) {
	const arch = state.plan?.architecture;
	const flow = missionFlowSvg(state);
	const contract = contractMapSvg(state.plan, state.features);
	const mermaid = mermaidSource(state, state.plan);
	if (!arch && !flow && !contract) return null;

	return (
		<details className="diagrams" open>
			<summary>
				<span className="label">diagrams</span>
				<span className="faint">
					{arch ? "system · flow · contract" : "flow · contract — no system diagram in this plan"}
				</span>
			</summary>

			<div className="diagrams-body">
				{arch ? (
					<figure className="diagram">
						<figcaption className="label">system — amber is what this mission changes</figcaption>
						<div className="canvas">
							<ArchDiagram source={arch} theme={MERMAID_THEME} />
						</div>
					</figure>
				) : (
					// State the fact, not a guess at its cause. This used to say the mission was
					// planned before the harness asked for a diagram — something the console cannot
					// know, and plainly false for any mission whose planner simply skipped the
					// field. It told the reader to expect better next time when the real answer was
					// that this plan was worse than it should have been. `plan.architecture` in
					// invariants.ts now warns at plan time, so the gap is reported where it happens.
					<div className="faint" style={{ padding: "2px 0 10px" }}>
						No system diagram — this mission's planner did not draw one.
					</div>
				)}

				{flow && (
					<figure className="diagram">
						<figcaption className="label">flow</figcaption>
						{/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG, every text node escaped by esc() */}
						<div className="canvas" dangerouslySetInnerHTML={{ __html: flow }} />
					</figure>
				)}

				{contract && (
					<figure className="diagram">
						<figcaption className="label">contract — what proved what</figcaption>
						{/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG, every text node escaped by esc() */}
						<div className="canvas" dangerouslySetInnerHTML={{ __html: contract }} />
					</figure>
				)}

				{(arch || mermaid) && (
					// The drawing is what you read; the source is what you take somewhere else.
					<details className="mermaid-src">
						<summary className="label">mermaid source</summary>
						<pre className="src">{arch ?? mermaid}</pre>
						<CopyButton text={arch ?? mermaid} label="copy mermaid" />
					</details>
				)}
			</div>
		</details>
	);
}
