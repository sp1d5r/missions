import { join } from "node:path";
import { addWorktree, commitAll, diffAgainst, ensureBranch, headSha, isGitRepo } from "./git.js";
import { planMission } from "./orchestrator.js";
import { writeActive, repoName } from "./registry.js";
import { generateReport } from "./report.js";
import { StateStore } from "./state.js";
import { getTarget } from "./target/index.js";
import type { MissionConfig, MissionState } from "./types.js";
import { runValidators } from "./validators/index.js";
import { runWorker } from "./worker.js";

export type MissionEvent =
	| { type: "status"; status: MissionState["status"] }
	| { type: "log"; message: string };

export async function runMission(config: MissionConfig, onEvent?: (e: MissionEvent) => void): Promise<MissionState> {
	const store = StateStore.create(config.outDir, config);
	const target = getTarget(config.target);
	const intent = `GOAL: ${config.goal}\n\nRFC: ${config.rfc}`;
	const workerSummaries: string[] = [];

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

		// 1. Plan.
		setStatus("planning");
		emit("orchestrator planning…");
		const { plan, costUsd: planCost } = await planMission(config, target.recon(config.targetCwd));
		store.state.plan = plan;
		store.state.costUsd += planCost;
		store.save();
		emit(`plan: ${plan.features.length} feature(s), ${plan.contract.assertions.length} assertion(s) — $${planCost.toFixed(3)}`);

		// 2. Work — serial, capped at maxFeatures for Phase 0.
		setStatus("working");
		const features = plan.features.slice(0, config.maxFeatures);
		for (const feature of features) {
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
				cwd: workCwd,
				model: config.routing.worker,
				budgetUsd: Math.min(remaining, config.budgetUsd * 0.6),
				onProgress: (e) => {
					if (e.type === "tool") onEvent?.({ type: "log", message: `  ${feature.id} → ${e.toolName}` });
				},
			});
			store.state.costUsd += result.costUsd;
			workerSummaries.push(`[${feature.id}] ${result.summary}`);
			const sha = commitAll(workCwd, `feat(${feature.id}): ${feature.title}\n\nvia pi-missions ${store.state.id}`);
			if (sha) {
				store.state.commits.push({ featureId: feature.id, sha, message: feature.title });
				emit(`  committed ${sha.slice(0, 8)} (${result.aborted ? "budget-capped" : result.stopReason}) — $${result.costUsd.toFixed(3)}`);
			} else {
				emit(`  no changes committed for ${feature.id} (${result.stopReason})`);
			}
			store.save();
		}

		// 3. Validate.
		setStatus("validating");
		const diff = diffAgainst(workCwd, baseSha);
		const scoreCard = await runValidators({
			cwd: workCwd,
			plan,
			target,
			bugSpotterModel: config.routing.bugSpotter,
			diff,
			intent,
			extraCheckCommand: config.checkCommand ?? target.defaultCheckCommand(workCwd),
			onProgress: (m) => emit(`  validator: ${m}`),
		});
		store.state.scoreCard = scoreCard;
		store.state.costUsd += scoreCard.costUsd;
		store.save();
		emit(`validated: ${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal} assertions, ${scoreCard.bugs.length} bug(s)`);

		// 4. Report.
		setStatus("reporting");
		const reportPath = generateReport({ state: store.state, plan, scoreCard, workerSummaries, outDir: config.outDir });
		store.state.reportPath = reportPath;
		store.save();
		emit(`report → ${reportPath}`);

		setStatus("succeeded");
	} catch (err) {
		emit(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
		setStatus("failed");
		// Still emit a report so the failure is glanceable.
		try {
			const reportPath = generateReport({
				state: store.state,
				plan: store.state.plan,
				scoreCard: store.state.scoreCard,
				workerSummaries,
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
