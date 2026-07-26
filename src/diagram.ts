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
/** Width of one character at font-size 10.5 in the mono stack. Measured, not guessed. */
const CHAR_W = 6.3;

function fit(s: string, px: number): string {
	const max = Math.max(3, Math.floor(px / CHAR_W));
	const t = String(s ?? "");
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function textEl(x: number, y: number, s: string, opts: { fill?: string; size?: number; anchor?: string; weight?: number } = {}): string {
	const { fill = THEME.text, size = 10.5, anchor = "start", weight = 400 } = opts;
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
	const NW = 156; // node width
	const GAP = 40; // arrow gap
	const PAD = 12;
	const TOP = 26;

	if (!milestones.length) {
		const w = NW + PAD * 2;
		return `<svg viewBox="0 0 ${w} 90" width="100%" height="90" role="img" aria-label="mission flow">${ARROW_DEF}
      ${box(PAD, TOP, NW, 40, THEME.hairline)}
      ${textEl(PAD + 10, TOP + 17, "PLAN", { fill: THEME.textDim, size: 9.5 })}
      ${textEl(PAD + 10, TOP + 31, "no milestones ran", { fill: THEME.textDim })}
    </svg>`;
	}

	// Node height grows with the number of features listed inside it.
	const rows = (m: MilestoneRecord) => Math.max(1, m.featureIds.length);
	const nodeH = (m: MilestoneRecord) => 46 + rows(m) * 14;
	const maxH = Math.max(...milestones.map(nodeH));
	const width = PAD * 2 + milestones.length * NW + (milestones.length - 1) * GAP;
	const height = TOP + maxH + 34;

	const parts: string[] = [ARROW_DEF];

	milestones.forEach((m, i) => {
		const x = PAD + i * (NW + GAP);
		const h = nodeH(m);
		const stroke = VERDICT_STROKE[m.verdict] ?? THEME.hairline;

		parts.push(box(x, TOP, NW, h, THEME.hairline));
		parts.push(ticks(x, TOP, NW, h, stroke));
		parts.push(textEl(x + 10, TOP + 16, `MILESTONE ${m.index}`, { fill: THEME.textDim, size: 9 }));

		// Features that ran in this milestone.
		m.featureIds.forEach((fid, r) => {
			const h2 = m.handoffs.find((x2) => x2.featureId === fid);
			const label = h2?.completed ? `${fid} ${h2.completed.replace(/\s+/g, " ")}` : fid;
			parts.push(textEl(x + 10, TOP + 32 + r * 14, fit(label, NW - 20), { fill: THEME.text }));
		});

		// Validation result — the only number that decides whether we loop.
		const vy = TOP + h - 16;
		const sc = m.scoreCard;
		const allPassed = sc.assertionsPassed === sc.assertionsTotal;
		parts.push(`<line x1="${x}" y1="${vy - 12}" x2="${x + NW}" y2="${vy - 12}" stroke="${THEME.hairline}"/>`);
		parts.push(
			textEl(x + 10, vy + 1, `${sc.assertionsPassed}/${sc.assertionsTotal} proven`, {
				fill: allPassed ? THEME.ok : THEME.bad,
			}),
		);
		if (sc.bugs.length) parts.push(textEl(x + NW - 10, vy + 1, `${sc.bugs.length} bug${sc.bugs.length > 1 ? "s" : ""}`, { fill: THEME.warn, anchor: "end" }));

		// Verdict caption under the node.
		parts.push(textEl(x + 10, TOP + h + 18, VERDICT_TEXT[m.verdict] ?? m.verdict, { fill: stroke, size: 9 }));

		if (i < milestones.length - 1) {
			const ay = TOP + h / 2;
			parts.push(arrow(x + NW + 6, ay, x + NW + GAP - 4));
			// Name what sent us round again.
			const via = m.correctionIds.length ? m.correctionIds.join(" ") : "retry";
			parts.push(textEl(x + NW + GAP / 2, ay - 8, fit(via, GAP), { fill: THEME.textDim, size: 8.5, anchor: "middle" }));
		}
	});

	return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="mission execution flow">${parts.join("\n")}</svg>`;
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

	const FW = 210; // feature column width
	const AW = 300; // assertion column width
	const MID = 70; // connector gutter
	const ROW = 26;
	const PAD = 12;
	const TOP = 30;

	const rows = Math.max(feats.length, assertions.length);
	const width = PAD * 2 + FW + MID + AW;
	const height = TOP + rows * ROW + 16;

	const parts: string[] = [];
	parts.push(textEl(PAD, 16, "FEATURES", { fill: THEME.textDim, size: 9 }));
	parts.push(textEl(PAD + FW + MID, 16, "ASSERTIONS", { fill: THEME.textDim, size: 9 }));

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
		parts.push(box(PAD, y, FW, ROW - 6, corrective ? THEME.live : THEME.hairline));
		parts.push(textEl(PAD + 8, y + 14, fit(`${f.id}  ${f.title}`, FW - 16), { fill: THEME.text }));
	});

	assertions.forEach((a, i) => {
		const y = TOP + i * ROW + 3;
		const x = PAD + FW + MID;
		const stroke = a.passed ? THEME.hairline : THEME.bad;
		parts.push(box(x, y, AW, ROW - 6, stroke));
		parts.push(textEl(x + 8, y + 14, a.passed ? "✓" : "✗", { fill: a.passed ? THEME.ok : THEME.bad }));
		parts.push(textEl(x + 24, y + 14, fit(`${a.id}  ${a.statement}`, AW - 34), { fill: a.passed ? THEME.text : THEME.textDim }));
	});

	return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="contract coverage map">${parts.join("\n")}</svg>`;
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
