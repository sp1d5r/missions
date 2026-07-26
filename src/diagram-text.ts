/**
 * The report's diagrams, for the terminal.
 *
 * Same facts as the SVG in report.html — the corrective loop, the contract, what
 * is still outstanding — rendered as text so they survive the place you most often
 * actually are: a terminal over SSH, with no browser to open the report in.
 *
 * Deliberately not boxed. A working terminal is short, and every row spent on
 * border characters is a row not spent on a handoff. The console register comes
 * from the rules, the uppercase micro-labels and the palette, not from drawing
 * frames around things.
 */

import chalk from "chalk";
import { codename } from "./theme.js";
import type { MilestoneRecord, MilestoneVerdict, MissionState } from "./types.js";

type Paint = (s: string) => string;

const VERDICT: Record<MilestoneVerdict, { label: string; paint: Paint }> = {
	passed: { label: "PASSED", paint: chalk.green },
	"corrections-scoped": { label: "CORRECTING", paint: chalk.cyan },
	"budget-exhausted": { label: "OUT OF BUDGET", paint: chalk.yellow },
	"max-milestones": { label: "HIT CEILING", paint: chalk.yellow },
	stalled: { label: "STALLED", paint: chalk.red },
};

const ANSI = /\x1b\[[0-9;]*m/g;
/** Visible length — colour codes occupy no columns, so they must not count toward one. */
const vlen = (s: string): number => s.replace(ANSI, "").length;

function fit(s: string, w: number): string {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > w ? `${t.slice(0, Math.max(1, w - 1))}…` : t;
}

/** `LABEL ─────────────────── right` — the console's section rule. */
function rule(label: string, right: string, width: number): string {
	const fill = Math.max(2, width - vlen(label) - 1 - (right ? vlen(right) + 1 : 0));
	return chalk.bold(label) + chalk.dim(` ${"─".repeat(fill)}`) + (right ? ` ${right}` : "");
}

/**
 * Execution flow: milestone by milestone, what ran and what it proved. The gap
 * between milestones names the corrections that sent it round again — that edge
 * is the whole point of the loop, so it gets its own line.
 */
export function missionFlowLines(state: MissionState, width: number): string[] {
	const milestones = state.milestones ?? [];
	const out: string[] = [];
	if (!milestones.length) {
		out.push(chalk.dim("  no milestones ran"));
		return out;
	}

	milestones.forEach((m: MilestoneRecord, i) => {
		const v = VERDICT[m.verdict] ?? { label: m.verdict, paint: chalk.dim };
		const sc = m.scoreCard;
		const allPassed = sc.assertionsPassed === sc.assertionsTotal;
		const proven = `${sc.assertionsPassed}/${sc.assertionsTotal} proven`;
		const bugs = sc.bugs.length ? ` · ${sc.bugs.length} bug${sc.bugs.length > 1 ? "s" : ""}` : "";
		const right = `${allPassed ? chalk.green(proven) : chalk.red(proven)}${bugs ? chalk.yellow(bugs) : ""}  ${v.paint(v.label)}`;
		out.push(`  ${rule(`MILESTONE ${m.index}`, right, width - 2)}`);

		for (const h of m.handoffs) {
			const flag = h.degraded || !h.proceduresFollowed ? chalk.red("!") : h.confidence === "low" ? chalk.yellow("?") : chalk.dim("·");
			out.push(`    ${flag} ${chalk.bold(h.featureId)}  ${fit(h.completed, width - 12)}`);
			for (const u of h.leftUndone) out.push(`        ${chalk.yellow("↯")} ${chalk.yellow(fit(`left undone: ${u}`, width - 12))}`);
			for (const issue of h.issues) {
				const d = issue.disposition ? chalk.dim(`[${issue.disposition}]`) : chalk.red("[unruled]");
				out.push(`        ${chalk.yellow("⚑")} ${fit(issue.summary, width - 24)} ${d}`);
			}
			const failed = h.commands.filter((c) => c.exitCode !== 0);
			if (failed.length) {
				out.push(`        ${chalk.dim(`ran ${h.commands.length} command(s),`)} ${chalk.red(`${failed.length} non-zero`)}`);
			}
		}

		if (m.correctionIds.length) out.push(`    ${chalk.dim("└─ scoped")} ${chalk.cyan(m.correctionIds.join(" "))}`);
		if (i < milestones.length - 1) out.push(chalk.dim("       │"));
	});

	return out;
}

/** Contract coverage: every assertion, whether it is proven, and who was on the hook. */
export function contractLines(state: MissionState, width: number): string[] {
	const assertions = state.plan?.contract.assertions ?? [];
	if (!assertions.length) return [chalk.dim("  no contract")];

	const owner = (aid: string): string => {
		const f = (state.features ?? []).filter((x) => x.assertionIds?.includes(aid));
		return f.map((x) => x.id).join(",") || "—";
	};

	const ownerW = Math.max(4, ...assertions.map((a) => owner(a.id).length));
	const idW = Math.max(3, ...assertions.map((a) => a.id.length));
	// Pad the statement to a fixed column so the owner column lines up vertically.
	const bodyW = Math.max(20, width - 12 - idW - ownerW);
	return assertions.map((a) => {
		const mark = a.passed ? chalk.green("✓") : chalk.red("✗");
		const id = chalk.dim(a.id.padEnd(idW));
		const who = chalk.dim(owner(a.id).padStart(ownerW));
		const body = fit(a.statement, bodyW).padEnd(bodyW);
		return `    ${mark} ${id}  ${a.passed ? body : chalk.red(body)}  ${who}`;
	});
}

/**
 * The full terminal debrief — the report you read when there is no browser.
 * Leads with the verdict, because that is the decision you are here to make.
 */
export function missionDebrief(state: MissionState, width = 92): string[] {
	const w = Math.max(60, Math.min(width, 120));
	const name = codename(state.id);
	const clean = state.outcome === "clean";
	const crashed = state.status === "failed";
	const sc = state.scoreCard;

	const headline = crashed
		? chalk.red("CRASHED")
		: clean
			? chalk.green("CLEAN · safe to merge")
			: chalk.yellow(`NEEDS YOU${state.finalVerdict ? ` · ${state.finalVerdict}` : ""}`);

	const out: string[] = [];
	out.push("");
	out.push(`  ${chalk.bold(name)}  ${fit(state.goal, w - name.length - 6)}`);
	out.push(`  ${headline}`);
	out.push(
		chalk.dim(
			`  ${sc ? `${sc.assertionsPassed}/${sc.assertionsTotal} proven` : "not validated"} · ${sc?.bugs.length ?? 0} bug(s) · ` +
				`${(state.milestones ?? []).length} milestone(s) · ${state.commits.length} commit(s) · $${state.costUsd.toFixed(2)}`,
		),
	);

	// Outstanding first. If something is unresolved it outranks everything below it.
	const unruled = (state.milestones ?? []).flatMap((m) => m.handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition)));
	const undone = (state.milestones ?? []).flatMap((m) => m.handoffs.flatMap((h) => h.leftUndone));
	if (unruled.length || undone.length) {
		out.push("");
		out.push(`  ${rule(chalk.yellow("OUTSTANDING"), "", w - 2)}`);
		for (const i of unruled) out.push(`    ${chalk.red("⚑")} ${chalk.yellow("unruled:")} ${fit(i.summary, w - 16)}`);
		for (const u of undone) out.push(`    ${chalk.yellow("↯")} ${chalk.yellow("left undone:")} ${fit(u, w - 20)}`);
	}

	out.push("");
	out.push(`  ${rule("EXECUTION", "", w - 2)}`);
	out.push(...missionFlowLines(state, w));

	out.push("");
	out.push(`  ${rule("CONTRACT", "", w - 2)}`);
	out.push(...contractLines(state, w));

	const bugs = sc?.bugs ?? [];
	if (bugs.length) {
		out.push("");
		out.push(`  ${rule(chalk.yellow("ADVERSARIAL REVIEW"), "", w - 2)}`);
		for (const b of bugs) {
			const paint = b.severity === "critical" || b.severity === "high" ? chalk.red : b.severity === "medium" ? chalk.yellow : chalk.dim;
			out.push(`    ${paint(b.severity.toUpperCase().padEnd(8))} ${fit(b.summary, w - 16)}`);
			if (b.file) out.push(`             ${chalk.dim(`${b.file}${b.line ? `:${b.line}` : ""}`)}`);
		}
	}

	out.push("");
	return out;
}
