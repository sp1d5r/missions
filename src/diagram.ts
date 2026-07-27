/**
 * Diagrams, drawn as inline SVG.
 *
 * These were mermaid blocks rendered by a CDN import, which meant they arrived as
 * raw source wherever the script was blocked — file previews, the cmux webview, an
 * offline SSH session. A report whose diagram silently degrades to a wall of graph
 * syntax is worse than no diagram.
 *
 * So the harness draws them. Layout here is trivial (a chain and a bipartite map),
 * the output is ~2KB of self-contained markup instead of a 3MB runtime, it renders
 * everywhere including offline, and it inherits the console palette exactly rather
 * than fighting a theme engine for it. The mermaid source is still emitted beside
 * each diagram for copy-paste into anything that wants it.
 */

import { esc, THEME } from "./theme.js";
import type { MilestoneRecord, MilestoneVerdict, MissionState, Plan } from "./types.js";

const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";
/** A mono glyph is 0.6em wide across this stack. Measured, not guessed. */
const CHAR_EM = 0.6;
/**
 * Diagrams lay out to a fixed canvas rather than to their content, then scale down to
 * whatever the page gives them. Sized to content, a two-milestone chain drew 400px wide
 * inside a 1070px panel and read as an afterthought — the diagram is the first thing you
 * look at, so it gets the width.
 */
const CANVAS = 1040;
const BODY = 12;
const LABEL = 10;

function fit(s: string, px: number, size = BODY): string {
	const max = Math.max(3, Math.floor(px / (size * CHAR_EM)));
	const t = String(s ?? "");
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Scale to the container, never past the canvas it was laid out for. */
function svg(width: number, height: number, label: string, body: string): string {
	return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;height:auto" role="img" aria-label="${label}">${body}</svg>`;
}

function textEl(x: number, y: number, s: string, opts: { fill?: string; size?: number; anchor?: string; weight?: number } = {}): string {
	const { fill = THEME.text, size = BODY, anchor = "start", weight = 400 } = opts;
	return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

function box(x: number, y: number, w: number, h: number, stroke: string, fill = THEME.panel): string {
	return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
}

/** Corner ticks — the console's framing device, at node scale. */
function ticks(x: number, y: number, w: number, h: number, stroke: string, len = 5): string {
	return [
		`<path d="M${x} ${y + len}V${y}H${x + len}" fill="none" stroke="${stroke}"/>`,
		`<path d="M${x + w - len} ${y + h}H${x + w}V${y + h - len}" fill="none" stroke="${stroke}"/>`,
	].join("");
}

const ARROW_DEF = `<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
<path d="M0 0 L8 4 L0 8 z" fill="${THEME.hairlineBright}"/></marker></defs>`;

function arrow(x1: number, y: number, x2: number): string {
	return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${THEME.hairlineBright}" stroke-width="1" marker-end="url(#a)"/>`;
}

const VERDICT_STROKE: Record<MilestoneVerdict, string> = {
	passed: THEME.ok,
	"corrections-scoped": THEME.live,
	"budget-exhausted": THEME.warn,
	"max-milestones": THEME.warn,
	stalled: THEME.bad,
};

const VERDICT_TEXT: Record<MilestoneVerdict, string> = {
	passed: "PASSED",
	"corrections-scoped": "CORRECTING",
	"budget-exhausted": "OUT OF BUDGET",
	"max-milestones": "HIT CEILING",
	stalled: "STALLED",
};

/**
 * Execution flow: what the org actually did, milestone by milestone. Each milestone
 * is a node listing the features it ran, followed by its validation result. The chain
 * is the corrective loop made visible — you can see where it went round again.
 */
export function missionFlowSvg(state: MissionState): string {
	const milestones = state.milestones ?? [];
	const PAD = 16;
	const TOP = 34;

	if (!milestones.length) {
		return svg(
			CANVAS,
			100,
			"mission flow",
			`${ARROW_DEF}${box(PAD, TOP, CANVAS - PAD * 2, 44, THEME.hairline)}
       ${textEl(PAD + 14, TOP + 18, "PLAN", { fill: THEME.textDim, size: LABEL })}
       ${textEl(PAD + 14, TOP + 34, "no milestones ran", { fill: THEME.textDim })}`,
		);
	}

	// Divide the canvas between the milestones rather than sizing each to its content,
	// so two milestones read as two big panels instead of two stamps in a wide box.
	const n = milestones.length;
	const GAP = n > 1 ? Math.max(48, Math.min(88, Math.round((CANVAS - PAD * 2) * 0.07))) : 0;
	const NW = Math.max(190, Math.floor((CANVAS - PAD * 2 - (n - 1) * GAP) / n));

	// Vertical rhythm, stated once so the divider cannot drift into the text above it
	// or leave a dead band below the score. All offsets are from the node's top edge.
	const LINE = 19;
	const LABEL_Y = 20; // "MILESTONE n"
	const FIRST_ROW_Y = 40; // first feature baseline
	const rows = (m: MilestoneRecord) => Math.max(1, m.featureIds.length);
	const dividerY = (r: number) => FIRST_ROW_Y + (r - 1) * LINE + 12;
	const scoreY = (r: number) => dividerY(r) + 17;
	const nodeH = (m: MilestoneRecord) => scoreY(rows(m)) + 12;
	const maxH = Math.max(...milestones.map(nodeH));
	const width = PAD * 2 + n * NW + (n - 1) * GAP;
	const height = TOP + maxH + 40;

	const parts: string[] = [ARROW_DEF];

	milestones.forEach((m, i) => {
		const x = PAD + i * (NW + GAP);
		const h = nodeH(m);
		const stroke = VERDICT_STROKE[m.verdict] ?? THEME.hairline;

		parts.push(box(x, TOP, NW, h, THEME.hairline));
		parts.push(ticks(x, TOP, NW, h, stroke, 8));
		parts.push(textEl(x + 14, TOP + LABEL_Y, `MILESTONE ${m.index}`, { fill: THEME.textDim, size: LABEL }));

		// Features that ran in this milestone.
		m.featureIds.forEach((fid, r) => {
			const h2 = m.handoffs.find((x2) => x2.featureId === fid);
			const done = h2?.completed ? h2.completed.replace(/\s+/g, " ") : "";
			const y = TOP + FIRST_ROW_Y + r * LINE;
			parts.push(textEl(x + 14, y, fid, { fill: THEME.text, weight: 600 }));
			if (done) {
				const off = 14 + (fid.length + 2) * BODY * CHAR_EM;
				parts.push(textEl(x + off, y, fit(done, NW - off - 14), { fill: THEME.textDim }));
			}
		});

		// Validation result — the only number that decides whether we loop.
		const dy = TOP + dividerY(rows(m));
		const vy = TOP + scoreY(rows(m));
		const sc = m.scoreCard;
		const allPassed = sc.assertionsPassed === sc.assertionsTotal;
		parts.push(`<line x1="${x}" y1="${dy}" x2="${x + NW}" y2="${dy}" stroke="${THEME.hairline}"/>`);
		parts.push(
			textEl(x + 14, vy, `${sc.assertionsPassed}/${sc.assertionsTotal} proven`, {
				fill: allPassed ? THEME.ok : THEME.bad,
			}),
		);
		if (sc.bugs.length) parts.push(textEl(x + NW - 14, vy, `${sc.bugs.length} bug${sc.bugs.length > 1 ? "s" : ""}`, { fill: THEME.warn, anchor: "end" }));

		// Verdict caption under the node.
		parts.push(textEl(x + 14, TOP + h + 22, VERDICT_TEXT[m.verdict] ?? m.verdict, { fill: stroke, size: LABEL }));

		if (i < milestones.length - 1) {
			const ay = TOP + h / 2;
			parts.push(arrow(x + NW + 8, ay, x + NW + GAP - 5));
			// Name what sent us round again.
			const via = m.correctionIds.length ? m.correctionIds.join(" ") : "retry";
			parts.push(textEl(x + NW + GAP / 2, ay - 10, fit(via, GAP, LABEL), { fill: THEME.textDim, size: LABEL, anchor: "middle" }));
		}
	});

	return svg(width, height, "mission execution flow", parts.join("\n"));
}

/**
 * Contract coverage: which feature is on the hook for which assertion, and whether
 * that assertion is proven. Written before any code existed, so this is the map the
 * whole mission was graded against.
 */
export function contractMapSvg(plan: Plan | undefined, features?: { id: string; title: string; origin?: string }[]): string {
	const assertions = plan?.contract.assertions ?? [];
	const feats = (features?.length ? features : plan?.features) ?? [];
	if (!assertions.length && !feats.length) return "";

	const PAD = 16;
	const TOP = 38;
	const MID = 120; // connector gutter — the curves need room to read as a mapping
	const FW = 300; // feature column width
	const AW = CANVAS - PAD * 2 - FW - MID; // assertions take the rest
	const ROW = 32;

	const rows = Math.max(feats.length, assertions.length);
	const width = CANVAS;
	const height = TOP + rows * ROW + 18;

	const parts: string[] = [];
	parts.push(textEl(PAD, 20, "FEATURES", { fill: THEME.textDim, size: LABEL }));
	parts.push(textEl(PAD + FW + MID, 20, "ASSERTIONS", { fill: THEME.textDim, size: LABEL }));

	const fy = (i: number) => TOP + i * ROW + ROW / 2;
	const ay = (i: number) => TOP + i * ROW + ROW / 2;

	// Connectors first so the boxes sit on top of them.
	feats.forEach((f, fi) => {
		const ids = plan?.features.find((p) => p.id === f.id)?.assertionIds ?? [];
		for (const aid of ids) {
			const aiIdx = assertions.findIndex((a) => a.id === aid);
			if (aiIdx < 0) continue;
			const x1 = PAD + FW;
			const x2 = PAD + FW + MID;
			const y1 = fy(fi);
			const y2 = ay(aiIdx);
			const proven = assertions[aiIdx]?.passed;
			parts.push(
				`<path d="M${x1} ${y1} C${x1 + MID / 2} ${y1}, ${x2 - MID / 2} ${y2}, ${x2} ${y2}" fill="none" stroke="${
					proven ? THEME.hairlineBright : THEME.bad
				}" stroke-width="1" ${proven ? "" : 'stroke-dasharray="3 2"'}/>`,
			);
		}
	});

	feats.forEach((f, i) => {
		const y = TOP + i * ROW + 3;
		const corrective = f.origin === "correction";
		parts.push(box(PAD, y, FW, ROW - 8, corrective ? THEME.live : THEME.hairline));
		parts.push(textEl(PAD + 11, y + 17, f.id, { fill: THEME.text, weight: 600 }));
		const off = 11 + (f.id.length + 2) * BODY * CHAR_EM;
		parts.push(textEl(PAD + off, y + 17, fit(f.title, FW - off - 11), { fill: THEME.textDim }));
	});

	assertions.forEach((a, i) => {
		const y = TOP + i * ROW + 3;
		const x = PAD + FW + MID;
		const stroke = a.passed ? THEME.hairline : THEME.bad;
		parts.push(box(x, y, AW, ROW - 8, stroke));
		parts.push(textEl(x + 11, y + 17, a.passed ? "✓" : "✗", { fill: a.passed ? THEME.ok : THEME.bad }));
		parts.push(textEl(x + 30, y + 17, a.id, { fill: THEME.textDim, weight: 600 }));
		parts.push(textEl(x + 30 + (a.id.length + 2) * BODY * CHAR_EM, y + 17, fit(a.statement, AW - 74), { fill: a.passed ? THEME.text : THEME.textDim }));
	});

	return svg(width, height, "contract coverage map", parts.join("\n"));
}

// ---------------------------------------------------------------------------
// Mermaid source, kept for copy-paste into anything that speaks it.
// ---------------------------------------------------------------------------

function mermaidSafe(s: string): string {
	return String(s ?? "")
		.replace(/["\n]/g, " ")
		.replace(/[[\](){}]/g, "")
		.slice(0, 80);
}

export function mermaidSource(state: MissionState, plan: Plan | undefined): string {
	const lines = ["flowchart LR"];
	const note = plan?.architectureNote ?? "current -> target";
	const [cur, tgt] = note.includes("->") ? note.split("->") : [note, "target"];
	lines.push(`  cur["${mermaidSafe(cur)}"] --> tgt["${mermaidSafe(tgt)}"]`);

	let prev = "tgt";
	// Corrections scoped at one boundary label the edge INTO the next milestone.
	let pendingLabel = "";
	for (const m of state.milestones ?? []) {
		const id = `m${m.index}`;
		const feats = m.featureIds.join(", ") || "no features";
		const edge = pendingLabel ? `-->|"${mermaidSafe(pendingLabel)}"|` : "-->";
		lines.push(`  ${prev} ${edge} ${id}["Milestone ${m.index}<br/>${mermaidSafe(feats)}"]`);
		const vid = `v${m.index}`;
		lines.push(`  ${id} --> ${vid}{"${m.scoreCard.assertionsPassed}/${m.scoreCard.assertionsTotal} proven"}`);
		pendingLabel = m.correctionIds.join(" ");
		prev = vid;
	}
	const last = state.finalVerdict ? VERDICT_TEXT[state.finalVerdict] ?? state.finalVerdict : "END";
	lines.push(`  ${prev} --> done(["${last}"])`);

	for (const f of plan?.features ?? []) {
		const fid = `f_${f.id.replace(/[^a-zA-Z0-9]/g, "")}`;
		lines.push(`  ${fid}["${mermaidSafe(f.title)}"]`);
		for (const aid of f.assertionIds) {
			const a = plan?.contract.assertions.find((x) => x.id === aid);
			const aidc = `a_${aid.replace(/[^a-zA-Z0-9]/g, "")}`;
			lines.push(`  ${fid} -.proves.-> ${aidc}(["${mermaidSafe(aid)}: ${a?.passed ? "proven" : "failed"}"])`);
		}
	}
	return lines.filter((l) => l.trim().length > 0).join("\n");
}
