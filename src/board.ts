import { statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ActiveRecord, readActive } from "./registry.js";
import { isHarnessStale } from "./mission.js";
import { readOrgPid } from "./ipc.js";
import { codename, esc, page, statStrip, tag, TONE_HEX, type Tone } from "./theme.js";

const RUNNING = new Set(["planning", "working", "validating", "reporting"]);

/** Tone by OUTCOME, not status: "succeeded" covers both clean work and stalled work. */
function toneOf(r: ActiveRecord): Tone {
	if (r.status === "failed") return "bad";
	if (r.status === "merged") return "done";
	if (RUNNING.has(r.status)) return "live";
	return r.outcome === "clean" ? "ok" : "warn";
}

const VERDICT_LABEL: Record<string, string> = {
	passed: "clean",
	stalled: "stalled",
	"max-milestones": "hit ceiling",
	"budget-exhausted": "out of budget",
	"corrections-scoped": "correcting",
};

function verdictLabel(r: ActiveRecord): string {
	if (r.status === "merged") return "merged";
	if (r.status === "failed") return "crashed";
	if (r.verdict) return VERDICT_LABEL[r.verdict] ?? r.verdict;
	if (RUNNING.has(r.status)) return r.status;
	return r.outcome === "clean" ? "clean" : "needs review";
}

function row(r: ActiveRecord): string {
	const tone = toneOf(r);
	const report = r.reportPath ? `<a href="${esc(pathToFileURL(r.reportPath).href)}">open</a>` : `<span class="faint">—</span>`;
	const activity = r.lastActivity.replace(/\n/g, " ").slice(0, 88);
	const milestone = r.maxMilestones ? `${r.milestone ?? 0}/${r.maxMilestones}` : "—";
	return `<tr>
    <td><span class="dot" style="background:${TONE_HEX[tone]}"></span><span style="color:${TONE_HEX[tone]}">${esc(verdictLabel(r))}</span></td>
    <td class="mono">${esc(codename(r.id))}</td>
    <td>${esc(r.repoName)}</td>
    <td>${esc(r.goal)}<div class="faint">${esc(activity)}</div></td>
    <td class="mono">${esc(milestone)}</td>
    <td class="mono">$${(r.costUsd ?? 0).toFixed(2)}</td>
    <td class="faint mono">${esc(r.updatedAt.replace("T", " ").slice(11, 19))}</td>
    <td>${report}</td>
  </tr>`;
}

function section(title: string, records: ActiveRecord[]): string {
	if (!records.length) return "";
	return `<h2>${esc(title)} · ${records.length}</h2>
  <div class="scroll"><table><thead><tr>
    <th>Verdict</th><th>Codename</th><th>Repo</th><th>Mission</th><th>Milestone</th><th>Cost</th><th>Updated</th><th>Report</th>
  </tr></thead><tbody>${records.map(row).join("\n")}</tbody></table></div>`;
}

/** Check whether built artefacts are newer than when the daemon started (best-effort). */
function staleBanner(): string {
	try {
		const pid = readOrgPid();
		if (!pid) return "";
		const thisFile = fileURLToPath(import.meta.url);
		const buildMtimeMs = statSync(thisFile).mtimeMs;
		// Heuristic: compare build mtime to now. If the build is less than 60s old
		// and a daemon is running, it is likely stale.
		const daemonApproxStartMs = Date.now() - 60_000;
		if (isHarnessStale(daemonApproxStartMs, buildMtimeMs)) {
			return `<div class="alert"><div class="label">⚠ stale daemon: build artefacts are newer than the running org process</div><div class="dim" style="margin-top:4px">Run <code>missions stop &amp;&amp; missions</code> to restart with fresh code.</div></div>`;
		}
	} catch {
		/* best-effort */
	}
	return "";
}

/** Render the global mission-control board (all repos, live) and return its path. */
export function generateBoard(): string {
	const all = readActive();
	const running = all.filter((r) => !r.done && RUNNING.has(r.status));
	const recent = all.filter((r) => r.done || !RUNNING.has(r.status)).slice(0, 25);
	const queue = all.filter((r) => r.done && !r.cleared && r.status !== "merged");
	const unresolved = queue.filter((r) => r.outcome !== "clean").length;
	const spend = all.reduce((n, r) => n + (r.costUsd ?? 0), 0);

	const body = `
  <div class="label">mission control</div>
  <h1>THE ORG</h1>
  <div class="faint mono">auto-refresh 3s · ${new Date().toISOString().replace("T", " ").slice(0, 19)}</div>

  ${statStrip([
		{ value: String(running.length), label: "in flight", tone: running.length ? "live" : undefined },
		{ value: String(queue.length), label: "awaiting you" },
		{ value: String(unresolved), label: "unresolved", tone: unresolved ? "warn" : undefined },
		{ value: `$${spend.toFixed(2)}`, label: "total spend" },
	])}

  ${staleBanner()}
  ${unresolved ? `<div class="alert"><div class="label">${unresolved} mission(s) stopped without satisfying their contract</div><div class="dim" style="margin-top:4px">Read the report before merging — failing assertions, blocking bugs, or issues nobody ruled on.</div></div>` : ""}

  ${section("In flight", running) || `<h2>In flight · 0</h2><p class="dim">Nothing running.</p>`}
  ${section("Recent", recent)}

  <div style="margin-top:28px">${tag("quiet", "pi-missions")}</div>`;

	const html = page({ title: "missions — control board", head: `<meta http-equiv="refresh" content="3"/>`, body });
	const path = join(homedir(), ".missions", "board.html");
	writeFileSync(path, html);
	return path;
}
