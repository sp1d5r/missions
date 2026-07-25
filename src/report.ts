import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BugFinding, CommitRecord, MissionState, Plan, ScoreCard } from "./types.js";

const SEV_COLOR: Record<string, string> = {
	critical: "#b00020",
	high: "#d9480f",
	medium: "#b08900",
	low: "#5c6b73",
};

function esc(s: string): string {
	return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function mermaidSafe(s: string): string {
	return String(s ?? "").replace(/["\n]/g, " ").replace(/[[\](){}]/g, "").slice(0, 80);
}

function diagram(plan: Plan | undefined): string {
	const note = plan?.architectureNote ?? "current -> target";
	const [cur, tgt] = note.includes("->") ? note.split("->") : [note, "target"];
	const lines = [
		"graph LR",
		`  cur["${mermaidSafe(cur)}"] -->|mission| tgt["${mermaidSafe(tgt)}"]`,
	];
	for (const f of plan?.features ?? []) {
		const fid = f.id.replace(/[^a-zA-Z0-9]/g, "");
		lines.push(`  tgt --> ${fid}["${mermaidSafe(f.title)}"]`);
		for (const aid of f.assertionIds) {
			const aidc = aid.replace(/[^a-zA-Z0-9]/g, "");
			lines.push(`  ${fid} -.prove.-> ${aidc}(["${mermaidSafe(aid)}"])`);
		}
	}
	return lines.join("\n");
}

function chip(ok: boolean, label: string): string {
	const bg = ok ? "#e7f5ec" : "#fde8e8";
	const fg = ok ? "#1b7f4b" : "#b00020";
	return `<span class="chip" style="background:${bg};color:${fg}">${ok ? "✓" : "✗"} ${esc(label)}</span>`;
}

function bugsTable(bugs: BugFinding[]): string {
	if (!bugs.length) return `<p class="muted">No bugs flagged by the adversarial reviewer.</p>`;
	const rows = bugs
		.map(
			(b) => `<tr>
      <td><span class="sev" style="background:${SEV_COLOR[b.severity] ?? "#666"}">${esc(b.severity)}</span></td>
      <td>${esc(b.summary)}<div class="muted">${esc(b.detail)}</div></td>
      <td class="mono">${esc(b.file ?? "")}${b.line ? `:${b.line}` : ""}</td>
    </tr>`,
		)
		.join("\n");
	return `<table><thead><tr><th>Sev</th><th>Finding</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function commitsList(commits: CommitRecord[]): string {
	if (!commits.length) return `<p class="muted">No commits this run.</p>`;
	return `<ul>${commits.map((c) => `<li><span class="mono">${esc(c.sha.slice(0, 8))}</span> ${esc(c.message)}</li>`).join("")}</ul>`;
}

/** Renders the glanceable review page. Review this, not the code. */
export function generateReport(args: {
	state: MissionState;
	plan?: Plan;
	scoreCard?: ScoreCard;
	workerSummaries: string[];
	outDir: string;
}): string {
	const { state, plan, scoreCard, workerSummaries, outDir } = args;
	const assertions = plan?.contract.assertions ?? [];
	const passStr = scoreCard ? `${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal}` : "—";

	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Standup — ${esc(state.id)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; max-width: 900px; margin: 32px auto; padding: 0 20px; color:#1a1a1a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color:#5c6b73; margin: 28px 0 10px; }
  .muted { color:#5c6b73; font-size: 13px; }
  .mono { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12px; }
  .row { display:flex; gap:16px; flex-wrap:wrap; margin: 8px 0 4px; }
  .stat { background:#f4f6f8; border-radius:10px; padding:10px 14px; }
  .stat b { display:block; font-size:20px; }
  .chip { display:inline-block; padding:3px 9px; border-radius:999px; font-size:12px; margin:3px 4px 0 0; }
  .sev { color:#fff; padding:2px 8px; border-radius:6px; font-size:11px; text-transform:uppercase; }
  table { border-collapse: collapse; width:100%; font-size:13px; }
  th,td { text-align:left; padding:8px; border-bottom:1px solid #eceff1; vertical-align:top; }
  pre.mermaid { background:#f4f6f8; border-radius:10px; padding:14px; }
  .card { border:1px solid #eceff1; border-radius:12px; padding:16px; margin: 10px 0; }
  blockquote { margin:0; padding:8px 14px; border-left:3px solid #cfd8dc; color:#37474f; white-space:pre-wrap; }
</style></head>
<body>
  <h1>${esc(state.goal)}</h1>
  <div class="muted">${esc(state.id)} · branch <span class="mono">${esc(state.branch)}</span> · status ${esc(state.status)}</div>

  <div class="row">
    <div class="stat"><b>${passStr}</b>assertions passed</div>
    <div class="stat"><b>${scoreCard?.bugs.length ?? 0}</b>bugs flagged</div>
    <div class="stat"><b>${state.commits.length}</b>commits</div>
    <div class="stat"><b>$${state.costUsd.toFixed(2)}</b>spent</div>
  </div>

  <h2>Architecture (current → target)</h2>
  <pre class="mermaid">${esc(diagram(plan))}</pre>

  <h2>Summary</h2>
  <div class="card">${esc(plan?.summary ?? "(no plan)")}</div>
  ${workerSummaries.map((s) => `<blockquote>${esc(s)}</blockquote>`).join("")}

  <h2>Assertions</h2>
  <div>${assertions.map((a) => chip(Boolean(a.passed), `${a.id}: ${a.statement}`)).join("")}</div>
  ${assertions.some((a) => a.evidence) ? `<ul class="muted">${assertions.map((a) => (a.evidence ? `<li><b>${esc(a.id)}</b>: ${esc(a.evidence)}</li>` : "")).join("")}</ul>` : ""}

  <h2>Bugs flagged (review these)</h2>
  ${bugsTable(scoreCard?.bugs ?? [])}

  <h2>What changed</h2>
  ${commitsList(state.commits)}

  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "neutral" });
  </script>
</body></html>`;

	const path = join(outDir, "report.html");
	writeFileSync(path, html);
	return path;
}
