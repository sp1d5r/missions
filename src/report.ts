import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractMapSvg, mermaidSource, missionFlowSvg } from "./diagram.js";
import { codename, esc, page, statStrip, tag, type Tone } from "./theme.js";
import type { BugFinding, CommitRecord, Handoff, MilestoneRecord, MilestoneVerdict, MissionState, Plan, ScoreCard, StrengthBreakdown } from "./types.js";
import { annotateVerdict } from "./validators/checks.js";

const SEV_TONE: Record<string, Tone> = {
	critical: "bad",
	high: "bad",
	medium: "warn",
	low: "quiet",
};

function bugsTable(bugs: BugFinding[]): string {
	if (!bugs.length) return `<p class="dim">Adversarial reviewer flagged nothing.</p>`;
	const rows = bugs
		.map(
			(b) => `<tr>
      <td>${tag(SEV_TONE[b.severity] ?? "quiet", b.severity)}</td>
      <td>${esc(b.summary)}<div class="dim">${esc(b.detail)}</div></td>
      <td class="dim mono">${esc(b.file ?? "")}${b.line ? `:${b.line}` : ""}</td>
    </tr>`,
		)
		.join("\n");
	return `<div class="scroll"><table><thead><tr><th>Sev</th><th>Finding</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function commitsList(commits: CommitRecord[]): string {
	if (!commits.length) return `<p class="dim">No commits this run.</p>`;
	return `<ul class="log">${commits
		.map((c) => `<li><span class="faint">${esc(c.sha.slice(0, 8))}</span>  ${esc(c.message)}</li>`)
		.join("")}</ul>`;
}

const VERDICT_TAG: Record<MilestoneVerdict, { tone: Tone; label: string }> = {
	passed: { tone: "ok", label: "passed" },
	"corrections-scoped": { tone: "live", label: "corrections scoped" },
	"budget-exhausted": { tone: "warn", label: "out of budget" },
	"max-milestones": { tone: "warn", label: "hit ceiling" },
	stalled: { tone: "bad", label: "stalled" },
};

/**
 * The handoff card. This is what you actually read: what a worker did, what it
 * admitted it did NOT do, what it really ran, and what it found on the way.
 */
function handoffCard(h: Handoff): string {
	const tags: string[] = [];
	if (h.degraded) tags.push(tag("bad", "no structured handoff"));
	if (!h.proceduresFollowed) tags.push(tag("bad", "procedures not followed"));
	if (h.aborted) tags.push(tag("warn", "budget-capped mid-flight"));
	tags.push(tag(h.confidence === "high" ? "quiet" : h.confidence === "low" ? "bad" : "warn", `confidence ${h.confidence}`));

	const undone = h.leftUndone.length
		? `<div class="label" style="margin-top:10px">left undone</div><ul class="log">${h.leftUndone.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
		: "";

	const issues = h.issues.length
		? `<div class="label" style="margin-top:10px">issues raised</div><ul class="log">${h.issues
				.map((i) => {
					// "addressed" is only meaningful with the correction that took it, so it is part of the tag.
					const label = i.disposition === "addressed" && i.addressedBy ? `addressed → ${i.addressedBy}` : i.disposition;
					const d = i.disposition ? tag(i.disposition === "addressed" ? "live" : "quiet", label ?? "") : tag("bad", "unruled");
					return `<li>${esc(i.summary)} ${d}${i.detail ? `<div class="dim">${esc(i.detail)}</div>` : ""}${
						i.dispositionNote ? `<div class="faint">→ ${esc(i.dispositionNote)}</div>` : ""
					}</li>`;
				})
				.join("")}</ul>`
		: "";

	const cmds = h.commands.length
		? `<div class="label" style="margin-top:10px">commands run</div><ul class="log">${h.commands
				.map((c) => {
					const ok = c.exitCode === 0;
					return `<li><span class="${ok ? "exit-ok" : "exit-bad"}">[${c.exitCode ?? "?"}]</span> ${esc(c.command)}</li>`;
				})
				.join("")}</ul>`
		: `<div class="dim" style="margin-top:10px">Ran no commands.</div>`;

	const claimed = h.assertionsClaimed.length ? h.assertionsClaimed.join(" ") : "none";

	return `<div class="panel">
    <div><span class="label">feature</span> <b>${esc(h.featureId)}</b>
      <span class="faint mono"> · m${h.milestone} · $${h.costUsd.toFixed(3)}${h.commitSha ? ` · ${esc(h.commitSha.slice(0, 8))}` : " · no commit"}</span></div>
    <div style="margin:6px 0">${tags.join("")}</div>
    <div>${esc(h.completed)}</div>
    <div class="faint" style="margin-top:6px">claimed: ${esc(claimed)}${h.procedureNotes ? ` · procedure note: ${esc(h.procedureNotes)}` : ""}</div>
    ${undone}
    ${issues}
    ${cmds}
  </div>`;
}

function milestonesSection(milestones: MilestoneRecord[]): string {
	if (!milestones.length) return `<p class="dim">No milestones completed.</p>`;
	return milestones
		.map((m) => {
			const v = VERDICT_TAG[m.verdict];
			const bdRows = m.scoreCard.strengthBreakdown
			? ([
					["behavioural", m.scoreCard.strengthBreakdown.behavioural],
					["existence", m.scoreCard.strengthBreakdown.existence],
					["review", m.scoreCard.strengthBreakdown.review],
					["unclassified", m.scoreCard.strengthBreakdown.unclassified],
				] as const)
				.filter(([, v]) => v.total > 0)
				.map(([label, v]) => `<span class="faint mono">${label} ${v.passed}/${v.total}</span>`)
				.join(" · ")
			: "";
		return `<div style="margin:18px 0">
      <h3>Milestone ${m.index} ${tag(v.tone, v.label)}
        <span class="faint mono">${m.scoreCard.assertionsPassed}/${m.scoreCard.assertionsTotal} assertions · ${m.scoreCard.bugs.length} bugs</span></h3>
      ${bdRows ? `<div class="faint" style="margin-bottom:4px">${bdRows}</div>` : ""}
      ${m.assessment ? `<blockquote>${esc(m.assessment)}</blockquote>` : ""}
      ${m.correctionIds.length ? `<div class="faint">scoped corrections: ${esc(m.correctionIds.join(" "))}</div>` : ""}
      ${m.handoffs.map(handoffCard).join("")}
    </div>`;
		})
		.join("");
}

/** Renders the per-strength assertion breakdown panel. */
function strengthBreakdownPanel(bd: StrengthBreakdown): string {
	const rows = ([
		["behavioural", bd.behavioural],
		["existence", bd.existence],
		["review", bd.review],
		["unclassified", bd.unclassified],
	] as const)
		.filter(([, v]) => v.total > 0)
		.map(([label, v]) => {
			const tone: "ok" | "warn" | "bad" | "quiet" =
				v.passed === v.total ? "ok" : v.passed === 0 ? "bad" : "warn";
			return `<tr><td>${tag(tone, label)}</td><td class="mono">${v.passed}/${v.total}</td></tr>`;
		})
		.join("");
	if (!rows) return "";
	return `<div class="panel" style="margin-top:10px">
	<div class="label">assertion strength breakdown</div>
	<table style="margin-top:6px"><tbody>${rows}</tbody></table>
</div>`;
}

/** Renders the glanceable review page. Review this, not the code. */
export function generateReport(args: {
	state: MissionState;
	plan?: Plan;
	scoreCard?: ScoreCard;
	outDir: string;
}): string {
	const { state, plan, scoreCard, outDir } = args;
	const assertions = plan?.contract.assertions ?? [];
	const milestones = state.milestones ?? [];
	const unruled = milestones.flatMap((m) => m.handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition)));
	const leftUndone = milestones.flatMap((m) => m.handoffs.flatMap((h) => h.leftUndone));
	const clean = state.outcome === "clean";
	const name = codename(state.id);

	const body = `
  <div class="label">mission ${esc(state.id)}</div>
  <h1>${esc(name)} — ${esc(state.goal)}</h1>
  <div class="faint mono">${esc(state.branch)} · ${esc(state.status)}</div>
  <div style="margin-top:8px">
    ${clean ? tag("ok", annotateVerdict("CLEAN", scoreCard)) : tag(state.status === "failed" ? "bad" : "warn", `needs you${state.finalVerdict ? ` · ${state.finalVerdict}` : ""}`)}
  </div>

  ${statStrip([
		{ value: scoreCard ? `${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal}` : "—", label: "assertions proven" },
		{ value: String(scoreCard?.bugs.length ?? 0), label: "bugs flagged", tone: scoreCard?.bugs.length ? "warn" : undefined },
		{ value: String(milestones.length), label: "milestones" },
		{ value: String(state.commits.length), label: "commits" },
		{ value: `$${state.costUsd.toFixed(2)}`, label: "spent" },
	])}

  ${state.debrief ? `<div class="panel" style="margin-top:10px"><div class="label">debrief</div><pre style="white-space:pre-wrap;margin-top:6px;font-size:0.92em">${esc(state.debrief)}</pre></div>` : ""}

  ${scoreCard?.strengthBreakdown ? strengthBreakdownPanel(scoreCard.strengthBreakdown) : ""}

  ${
		unruled.length || leftUndone.length
			? `<div class="alert">
    <div class="label">outstanding</div>
    ${unruled.length ? `<div class="dim" style="margin-top:6px">unruled — nobody decided what to do with these:</div><ul>${unruled.map((i) => `<li>${esc(i.summary)}</li>`).join("")}</ul>` : ""}
    ${leftUndone.length ? `<div class="dim" style="margin-top:6px">left undone by workers:</div><ul>${leftUndone.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : ""}
  </div>`
			: ""
	}

  <h2>Objective</h2>
  <div class="panel">${esc(plan?.summary ?? "(no plan)")}</div>
  ${plan?.architectureNote ? `<div class="faint">${esc(plan.architectureNote)}</div>` : ""}

  <h2>Execution · milestone by milestone</h2>
  <div class="scroll diagram">${missionFlowSvg(state)}</div>

  <h2>Contract coverage</h2>
  <div class="scroll diagram">${contractMapSvg(plan, state.features)}</div>
  <div class="scroll"><table><thead><tr><th>Id</th><th>Assertion</th><th>Evidence</th></tr></thead><tbody>
    ${assertions
			.map(
				(a) => `<tr><td class="mono">${esc(a.id)}</td><td>${esc(a.statement)}</td>
      <td class="${a.passed ? "dim" : "exit-bad"}">${esc(a.evidence ?? "—")}</td></tr>`,
			)
			.join("")}
  </tbody></table></div>

  <h2>Milestones &amp; handoffs</h2>
  ${milestonesSection(milestones)}

  <h2>Adversarial review</h2>
  ${bugsTable(scoreCard?.bugs ?? [])}

  <h2>What changed</h2>
  ${commitsList(state.commits)}

  <details style="margin-top:26px">
    <summary class="label" style="cursor:pointer">mermaid source</summary>
    <pre class="src">${esc(mermaidSource(state, plan))}</pre>
  </details>`;

	const html = page({ title: `${name} — ${state.id}`, body });
	const path = join(outDir, "report.html");
	writeFileSync(path, html);
	return path;
}
