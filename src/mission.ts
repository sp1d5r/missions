import { join } from "node:path";
import { addWorktree, commitAll, diffAgainst, ensureBranch, headSha, isGitRepo } from "./git.js";
import { planMission, scopeCorrections } from "./orchestrator.js";
import { writeActive, repoName } from "./registry.js";
import { generateReport } from "./report.js";
import { StateStore } from "./state.js";
import { getTarget } from "./target/index.js";
import type { Feature, Handoff, MilestoneRecord, MilestoneVerdict, MissionConfig, MissionState, ScoreCard } from "./types.js";
import { runValidators } from "./validators/index.js";
import { runWorker } from "./worker.js";

export type MissionEvent =
	| { type: "status"; status: MissionState["status"] }
	| { type: "log"; message: string };

/** Fraction of the total budget we refuse to start a fresh milestone on. */
const MILESTONE_BUDGET_FLOOR = 0.15;

export async function runMission(config: MissionConfig, onEvent?: (e: MissionEvent) => void): Promise<MissionState> {
	const store = StateStore.create(config.outDir, config);
	const target = getTarget(config.target);
	const intent = `GOAL: ${config.goal}\n\nRFC: ${config.rfc}`;
	const maxMilestones = Math.max(1, config.maxMilestones ?? 3);

	let lastActivity = "";
	const publish = () => {
		writeActive({
			id: store.state.id,
			repo: config.targetCwd,
			repoName: repoName(config.targetCwd),
			goal: store.state.goal,
			status: store.state.status,
			startedAt: store.state.startedAt,
			updatedAt: new Date().toISOString(),
			lastActivity,
			reportPath: store.state.reportPath,
			worktreePath: store.state.worktreePath,
			costUsd: store.state.costUsd,
			done: store.state.status === "succeeded" || store.state.status === "failed",
			milestone: store.state.milestones.length,
			maxMilestones,
			verdict: store.state.finalVerdict,
			outcome: store.state.outcome,
		});
	};
	const emit = (message: string) => {
		lastActivity = message;
		store.log(message);
		publish();
		onEvent?.({ type: "log", message });
	};
	const setStatus = (status: MissionState["status"]) => {
		store.state.status = status;
		store.save();
		publish();
		onEvent?.({ type: "status", status });
	};

	try {
		if (!isGitRepo(config.targetCwd)) throw new Error(`Target is not a git repo: ${config.targetCwd}`);
		const baseSha = headSha(config.targetCwd);
		store.state.baseSha = baseSha;
		// Unique branch per mission so parallel worktrees never collide.
		const useWorktree = config.useWorktree !== false;
		const branch = useWorktree ? `missions/${store.state.id}` : config.branch;
		store.state.branch = branch;

		let workCwd = config.targetCwd;
		if (useWorktree) {
			workCwd = join(config.targetCwd, ".missions", "worktrees", store.state.id);
			addWorktree(config.targetCwd, workCwd, branch, baseSha);
			store.state.worktreePath = workCwd;
			emit(`worktree ${branch} @ ${baseSha.slice(0, 8)} → ${workCwd}`);
		} else {
			ensureBranch(config.targetCwd, branch);
			emit(`branch ${branch} @ ${baseSha.slice(0, 8)} in ${config.targetCwd}`);
		}
		store.save();

		// 1. Plan — the validation contract is written here, before any code exists.
		setStatus("planning");
		emit("orchestrator planning…");
		const { plan, costUsd: planCost } = await planMission(config, target.recon(config.targetCwd));
		store.state.plan = plan;
		store.state.costUsd += planCost;
		store.save();
		emit(`plan: ${plan.features.length} feature(s), ${plan.contract.assertions.length} assertion(s) — $${planCost.toFixed(3)}`);

		// 2. Milestones. Each is: work the queue serially → validate the WHOLE contract →
		//    orchestrator rules the boundary → corrections become the next queue.
		//    Validation failing on the first pass is the normal case, not the error case.
		let queue: Feature[] = plan.features.slice(0, config.maxFeatures).map((f) => ({ ...f, milestone: 1, origin: "plan" as const }));
		store.state.features = [...queue];
		store.save();

		let scoreCard: ScoreCard | undefined;
		let verdict: MilestoneVerdict = "stalled";

		for (let m = 1; m <= maxMilestones; m++) {
			if (!queue.length) {
				emit(`milestone ${m}: nothing queued — stopping`);
				break;
			}

			// --- Work: strictly serial. One worker at a time, clean context each, commit between.
			setStatus("working");
			emit(`── milestone ${m}/${maxMilestones}: ${queue.length} feature(s)`);
			const handoffs: Handoff[] = [];

			for (const feature of queue) {
				const remaining = config.budgetUsd - store.state.costUsd;
				if (remaining <= 0) {
					emit("budget exhausted — stopping before next feature");
					break;
				}
				emit(`worker → ${feature.id}: ${feature.title}`);
				const assertions = plan.contract.assertions.filter((a) => feature.assertionIds.includes(a.id));
				const result = await runWorker({
					feature,
					assertions,
					milestone: m,
					cwd: workCwd,
					model: config.routing.worker,
					budgetUsd: Math.min(remaining, config.budgetUsd * 0.6),
					onProgress: (e) => {
						if (e.type === "tool") onEvent?.({ type: "log", message: `  ${feature.id} → ${e.toolName}` });
					},
				});
				store.state.costUsd += result.costUsd;

				const sha = commitAll(workCwd, `feat(${feature.id}): ${feature.title}\n\nvia pi-missions ${store.state.id}`);
				if (sha) {
					store.state.commits.push({ featureId: feature.id, sha, message: feature.title });
					result.handoff.commitSha = sha;
					emit(`  committed ${sha.slice(0, 8)} (${result.aborted ? "budget-capped" : result.stopReason}) — $${result.costUsd.toFixed(3)}`);
				} else {
					emit(`  no changes committed for ${feature.id} (${result.stopReason})`);
				}

				handoffs.push(result.handoff);
				store.state.handoffs.push(result.handoff);
				store.save();

				// Surface the parts of the handoff a human would want to hear immediately.
				if (result.handoff.degraded) emit(`  ⚠ ${feature.id}: no structured handoff — fell back to prose`);
				if (!result.handoff.proceduresFollowed) emit(`  ⚠ ${feature.id}: procedures NOT followed — ${result.handoff.procedureNotes ?? "no reason given"}`);
				for (const u of result.handoff.leftUndone) emit(`  ↯ ${feature.id} left undone: ${u}`);
				for (const i of result.handoff.issues) emit(`  ⚑ ${feature.id} issue: ${i.summary}`);
			}

			// --- Validate the whole contract, every milestone. Corrections can regress earlier work.
			setStatus("validating");
			const diff = diffAgainst(workCwd, baseSha);
			scoreCard = await runValidators({
				cwd: workCwd,
				plan,
				target,
				bugSpotterModel: config.routing.bugSpotter,
				diff,
				intent,
				extraCheckCommand: config.checkCommand ?? target.defaultCheckCommand(workCwd),
				onProgress: (msg) => emit(`  validator: ${msg}`),
			});
			store.state.scoreCard = scoreCard;
			store.state.costUsd += scoreCard.costUsd;
			store.save();
			emit(`validated: ${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal} assertions, ${scoreCard.bugs.length} bug(s)`);

			// --- Boundary.
			const failing = plan.contract.assertions.filter((a) => !a.passed);
			const blockingBugs = scoreCard.bugs.filter((b) => b.severity === "critical" || b.severity === "high");
			const openIssues = handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition));
			const clean = failing.length === 0 && blockingBugs.length === 0;

			const record: MilestoneRecord = {
				index: m,
				featureIds: queue.map((f) => f.id),
				handoffs,
				scoreCard,
				verdict: "passed",
				correctionIds: [],
			};

			// Clean AND nothing outstanding: done. Note that an unruled issue blocks a pass even
			// when every assertion is green — that is the point of recording them.
			if (clean && openIssues.length === 0) {
				verdict = "passed";
				record.verdict = verdict;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: PASSED — contract satisfied, no open issues`);
				break;
			}

			if (m === maxMilestones) {
				verdict = "max-milestones";
				record.verdict = verdict;
				record.assessment = `Hit the ${maxMilestones}-milestone ceiling with ${failing.length} failing assertion(s), ${blockingBugs.length} blocking bug(s), ${openIssues.length} open issue(s).`;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: hit milestone ceiling — needs you`);
				break;
			}

			const remainingUsd = config.budgetUsd - store.state.costUsd;
			if (remainingUsd < config.budgetUsd * MILESTONE_BUDGET_FLOOR) {
				verdict = "budget-exhausted";
				record.verdict = verdict;
				record.assessment = `Stopped at the budget floor with $${remainingUsd.toFixed(2)} left of $${config.budgetUsd.toFixed(2)}.`;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: budget floor reached ($${remainingUsd.toFixed(2)} left) — needs you`);
				break;
			}

			emit(`milestone ${m}: ${failing.length} failing, ${blockingBugs.length} blocking bug(s), ${openIssues.length} open issue(s) — orchestrator triaging…`);
			const review = await scopeCorrections({
				config,
				milestone: m,
				assertions: plan.contract.assertions,
				scoreCard,
				handoffs,
				remainingUsd,
				milestonesLeft: maxMilestones - m,
			});
			store.state.costUsd += review.costUsd;
			record.assessment = review.assessment;
			if (review.assessment) emit(`  orchestrator: ${review.assessment}`);

			// Apply the rulings back onto the issues so the report shows what happened to each.
			applyRulings(handoffs, review.issueRulings);
			const stillOpen = handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition));
			for (const i of stillOpen) emit(`  ⚑ UNRULED issue carried forward: ${i.summary}`);

			// Evidence is green, every issue has been ruled, and the orchestrator is not asking for
			// more work: that is a pass. Note this is decided on the evidence — a milestone cannot
			// pass on the orchestrator's say-so alone (see the disagreement check below).
			if (clean && stillOpen.length === 0 && review.verdict !== "needs-corrections") {
				verdict = "passed";
				record.verdict = verdict;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: PASSED — contract satisfied, all issues ruled`);
				break;
			}

			// The orchestrator says done, but validators or unruled issues disagree: the harness wins.
			if (review.verdict === "passed" && (!clean || stillOpen.length > 0)) {
				verdict = "stalled";
				record.verdict = verdict;
				record.assessment = `${review.assessment}\n\n[harness] Orchestrator declared "passed" but ${failing.length} assertion(s) still fail, ${blockingBugs.length} blocking bug(s) remain, and ${stillOpen.length} issue(s) are unruled. Blocked for a human.`;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: orchestrator claimed done, evidence says otherwise — needs you`);
				break;
			}

			if (review.verdict !== "needs-corrections" || review.corrections.length === 0) {
				verdict = "stalled";
				record.verdict = verdict;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: STALLED — no corrections offered, needs you`);
				break;
			}

			const corrections = review.corrections.slice(0, config.maxFeatures);
			record.verdict = "corrections-scoped";
			record.correctionIds = corrections.map((c) => c.id);
			verdict = "corrections-scoped";
			store.state.milestones.push(record);
			store.state.features.push(...corrections);
			store.save();
			emit(`milestone ${m}: scoped ${corrections.length} correction(s) → ${corrections.map((c) => c.id).join(", ")}`);
			queue = corrections;
		}

		store.state.finalVerdict = verdict;
		store.state.outcome = verdict === "passed" ? "clean" : "needs-review";
		store.save();

		// 3. Report.
		setStatus("reporting");
		const reportPath = generateReport({ state: store.state, plan, scoreCard, outDir: config.outDir });
		store.state.reportPath = reportPath;
		store.save();
		emit(`report → ${reportPath}`);

		setStatus("succeeded");
		emit(`mission ${verdict === "passed" ? "CLEAN" : `NEEDS YOU (${verdict})`} — $${store.state.costUsd.toFixed(2)} over ${store.state.milestones.length} milestone(s)`);
	} catch (err) {
		emit(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
		store.state.outcome = "needs-review";
		setStatus("failed");
		// Still emit a report so the failure is glanceable.
		try {
			const reportPath = generateReport({
				state: store.state,
				plan: store.state.plan,
				scoreCard: store.state.scoreCard,
				outDir: config.outDir,
			});
			store.state.reportPath = reportPath;
			store.save();
		} catch {
			/* ignore secondary failure */
		}
	}

	return store.state;
}

/** Stamp the orchestrator's dispositions onto the issues they refer to. Matches on summary. */
function applyRulings(handoffs: Handoff[], rulings: { summary: string; disposition: "addressed" | "deferred"; note?: string }[]): void {
	if (!rulings.length) return;
	const norm = (s: string) => s.trim().toLowerCase();
	for (const h of handoffs) {
		for (const issue of h.issues) {
			if (issue.disposition) continue;
			const hit =
				rulings.find((r) => norm(r.summary) === norm(issue.summary)) ??
				rulings.find((r) => norm(issue.summary).includes(norm(r.summary)) || norm(r.summary).includes(norm(issue.summary)));
			if (hit) {
				issue.disposition = hit.disposition;
				issue.dispositionNote = hit.note;
			}
		}
	}
}
