import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ActiveRecord, readActive } from "./registry.js";

const RUNNING = new Set(["planning", "working", "validating", "reporting"]);
const STATUS_COLOR: Record<string, string> = {
	succeeded: "#1b7f4b",
	failed: "#b00020",
	working: "#1a56db",
	planning: "#1a56db",
	validating: "#8a5cf6",
	reporting: "#1a56db",
};

function esc(s: unknown): string {
	return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function row(r: ActiveRecord): string {
	const color = STATUS_COLOR[r.status] ?? "#5c6b73";
	const report = r.reportPath ? `<a href="${esc(pathToFileURL(r.reportPath).href)}">report</a>` : "";
	const activity = r.lastActivity.replace(/\n/g, " ").slice(0, 90);
	return `<tr>
    <td><span class="dot" style="background:${color}"></span>${esc(r.status)}</td>
    <td><b>${esc(r.repoName)}</b></td>
    <td>${esc(r.goal)}<div class="muted mono">${esc(r.worktreePath ?? "")}</div></td>
    <td class="muted">${esc(activity)}</td>
    <td>$${(r.costUsd ?? 0).toFixed(2)}</td>
    <td class="muted mono">${esc(r.updatedAt.replace("T", " ").slice(11, 19))}</td>
    <td>${report}</td>
  </tr>`;
}

function section(title: string, records: ActiveRecord[]): string {
	if (!records.length) return "";
	return `<h2>${esc(title)} <span class="muted">(${records.length})</span></h2>
  <table><thead><tr><th>Status</th><th>Repo</th><th>Mission</th><th>Doing now</th><th>Cost</th><th>Updated</th><th></th></tr></thead>
  <tbody>${records.map(row).join("\n")}</tbody></table>`;
}

/** Render the global mission-control board (all repos, live) and return its path. */
export function generateBoard(): string {
	const all = readActive();
	const running = all.filter((r) => !r.done && RUNNING.has(r.status));
	const recent = all.filter((r) => r.done || !RUNNING.has(r.status)).slice(0, 25);

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="3"/>
<title>missions — control board</title>
<style>
  body { font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; max-width: 1040px; margin: 26px auto; padding: 0 20px; color:#1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color:#37474f; margin: 24px 0 8px; }
  .muted { color:#5c6b73; font-size: 12px; }
  .mono { font-family: ui-monospace,Menlo,monospace; }
  table { border-collapse: collapse; width:100%; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid #eceff1; vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#5c6b73; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:999px; margin-right:7px; vertical-align:middle; }
  a { color:#1a56db; text-decoration:none; } a:hover { text-decoration:underline; }
</style></head><body>
  <h1>mission control</h1>
  <div class="muted">${running.length} running · auto-refreshes every 3s</div>
  ${section("Running now", running) || '<h2>Running now <span class="muted">(0)</span></h2><p class="muted">Nothing in flight.</p>'}
  ${section("Recent", recent)}
</body></html>`;

	const path = join(homedir(), ".missions", "board.html");
	writeFileSync(path, html);
	return path;
}
