import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionState } from "./types.js";

const STATUS_COLOR: Record<string, string> = {
	succeeded: "#1b7f4b",
	failed: "#b00020",
	working: "#1a56db",
	planning: "#1a56db",
	validating: "#1a56db",
	reporting: "#1a56db",
};

function esc(s: unknown): string {
	return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Read every mission's state.json under <cwd>/.missions/runs. */
export function loadMissions(cwd: string): MissionState[] {
	const runs = join(cwd, ".missions", "runs");
	if (!existsSync(runs)) return [];
	const out: MissionState[] = [];
	for (const name of readdirSync(runs)) {
		const p = join(runs, name, "state.json");
		if (!existsSync(p)) continue;
		try {
			out.push(JSON.parse(readFileSync(p, "utf-8")) as MissionState);
		} catch {
			/* skip corrupt */
		}
	}
	return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Render a glanceable mission-control dashboard and return its path. Auto-refreshes every 4s. */
export function generateDashboard(cwd: string): string {
	const missions = loadMissions(cwd);
	const rows = missions.length
		? missions
				.map((m) => {
					const sc = m.scoreCard;
					const color = STATUS_COLOR[m.status] ?? "#5c6b73";
					const assertions = sc ? `${sc.assertionsPassed}/${sc.assertionsTotal}` : "—";
					const bugs = sc ? sc.bugs.length : 0;
					const bugTag = bugs ? `<b style="color:#b00020">${bugs}</b>` : "0";
					return `<tr>
      <td><span style="color:${color};font-weight:600">●</span> ${esc(m.status)}</td>
      <td>${esc(m.goal)}<div class="muted mono">${esc(m.branch)}</div></td>
      <td>${assertions}</td>
      <td>${bugTag}</td>
      <td>$${(m.costUsd ?? 0).toFixed(2)}</td>
      <td class="muted">${esc(m.startedAt.replace("T", " ").slice(0, 16))}</td>
    </tr>`;
				})
				.join("\n")
		: `<tr><td colspan="6" class="muted">No missions yet. Say "run a mission to …" in the chief terminal.</td></tr>`;

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="4"/>
<title>missions — control</title>
<style>
  body { font: 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; max-width: 960px; margin: 28px auto; padding: 0 20px; color:#1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .muted { color:#5c6b73; font-size: 12px; }
  .mono { font-family: ui-monospace,Menlo,monospace; }
  table { border-collapse: collapse; width:100%; font-size:14px; margin-top:14px; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid #eceff1; vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#5c6b73; }
</style></head><body>
  <h1>mission control · ${esc(cwd)}</h1>
  <div class="muted">${missions.length} mission(s) · auto-refreshes every 4s</div>
  <table>
    <thead><tr><th>Status</th><th>Goal</th><th>Assert</th><th>Bugs</th><th>Cost</th><th>Started</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
	const path = join(cwd, ".missions", "dashboard.html");
	writeFileSync(path, html);
	return path;
}
