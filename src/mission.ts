import { join } from "node:path";
import { applyEnvOverrides, bootstrapWorktree } from "./bootstrap.js";
import { provisionDbBranch } from "./db-branch.js";
import { resolveMissionEnv } from "./env.js";
import { allocatePortBlock, assignPorts } from "./ports.js";
import { addWorktree, commitAll, diffAgainst, ensureBranch, headSha, isGitRepo } from "./git.js";
import { blocking, checkBoundary, checkContractRatchet, checkPlan, formatViolations, warnings } from "./invariants.js";
import { decideStallOrRetry } from "./stall.js";
import { humanBytes, reclaimWorktree } from "./lifecycle.js";
import { type CorrectionRuling, planMission, scopeCorrections } from "./orchestrator.js";
import { readActive, writeActive, repoName } from "./registry.js";
import { generateReport } from "./report.js";
import { StateStore } from "./state.js";
import { topLevelRecon } from "./target/index.js";
import { runSetup } from "./setup.js";
import type { Feature, Handoff, MilestoneRecord, MilestoneVerdict, MissionConfig, MissionState, ScoreCard } from "./types.js";
import { loadAgentSpecs } from "./subagent.js";
import { annotateVerdict } from "./validators/checks.js";
import { runValidators } from "./validators/index.js";
import { runWorker } from "./worker.js";
import { awaitOperatorSteer, listWorkers, resumeWorker, serveWorkers } from "./workers.js";

export type MissionEvent =
	| { type: "status"; status: MissionState["status"] }
	| { type: "log"; message: string };

/** Fraction of the total budget we refuse to start a fresh milestone on. */
const MILESTONE_BUDGET_FLOOR = 0.15;

export async function runMission(config: MissionConfig, onEvent?: (e: MissionEvent) => void): Promise<MissionState> {
	const store = StateStore.create(config.outDir, config);
	const intent = `GOAL: ${config.goal}\n\nRFC: ${config.rfc}`;
	const maxMilestones = Math.max(1, config.maxMilestones ?? 3);
	/** Set when a branched database was provisioned for this mission's schema work. */
	// Serve this mission's live workers so another process — the overseer, the CLI — can list,
	// question and steer them while they run. An affordance, never a requirement: if the socket
	// cannot be opened the mission is unaffected, you just cannot talk to it.
	const stopServing = serveWorkers(store.state.id);
	let dbTeardown: (() => Promise<void>) | undefined;
	/** Set when the plan involves schema work we could NOT isolate. Workers must be told. */
	let schemaWarning: string | undefined;

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
			portBase: store.state.portBase,
			costUsd: store.state.costUsd,
			done: store.state.status === "succeeded" || store.state.status === "failed",
			milestone: store.state.milestones.length,
			maxMilestones,
			verdict: store.state.finalVerdict,
			outcome: store.state.outcome,
			// The sentence the board shows instead of making the reader open the mission to
			// discover whether there is a decision to make.
			needs: store.state.stallReason,
			outDir: config.outDir,
		});
	};
	const emit = (message: string) => {
		lastActivity = message;
		store.log(message);
		publish();
		onEvent?.({ type: "log", message });
	};
	/**
	 * Record activity that is too frequent to write on every occurrence.
	 *
	 * A worker fires tool events several times a second; publishing each one would rewrite the
	 * registry file that often for no gain. Throttling keeps the board honest about liveness —
	 * which is all it needs — without making the mission an IO source.
	 */
	let lastTouch = 0;
	const TOUCH_INTERVAL_MS = 3_000;
	const touch = (message: string) => {
		lastActivity = message;
		const now = Date.now();
		if (now - lastTouch < TOUCH_INTERVAL_MS) return;
		lastTouch = now;
		publish();
	};
	const setStatus = (status: MissionState["status"]) => {
		store.state.status = status;
		store.appendEvent("status_transition", `status → ${status}`, undefined, { seat: "system" });
		publish();
		onEvent?.({ type: "status", status });
	};

	try {
		store.appendEvent("lifecycle", `mission started`, `goal: ${config.goal.slice(0, 120)}`, { seat: "system" });
		if (!isGitRepo(config.targetCwd)) throw new Error(`Target is not a git repo: ${config.targetCwd}`);
		const baseSha = headSha(config.targetCwd);
		store.state.baseSha = baseSha;
		// Unique branch per mission so parallel worktrees never collide.
		const useWorktree = config.useWorktree !== false;
		const branch = useWorktree ? `missions/${store.state.id}` : config.branch;
		store.state.branch = branch;

		let workCwd = config.targetCwd;
		let sourceRoots: string[] = [];
		// Dependency bin dirs for PATH — without these a bare `python` is the machine's, not this tree's.
		let binDirs: string[] = [];
		// Paths the harness put here. Kept out of every commit — see commitAll.
		let gitExcludes: string[] = [];
		if (useWorktree) {
			workCwd = join(config.targetCwd, ".missions", "worktrees", store.state.id);
			addWorktree(config.targetCwd, workCwd, branch, baseSha);
			store.state.worktreePath = workCwd;
			emit(`worktree ${branch} @ ${baseSha.slice(0, 8)} → ${workCwd}`);

			// `git worktree add` carries tracked files and nothing else. Secrets are the one thing
			// no install can recreate, so they are copied; dependencies are the setup stage's job.
			const boot = bootstrapWorktree({ targetCwd: config.targetCwd, workCwd });
			gitExcludes = boot.gitExcludes;
			for (const note of boot.notes) emit(`  bootstrap: ${note}`);
		} else {
			ensureBranch(config.targetCwd, branch);
			bootstrapWorktree({ targetCwd: config.targetCwd, workCwd });
			emit(`branch ${branch} @ ${baseSha.slice(0, 8)} in ${config.targetCwd}`);
		}
		store.save();

		// Stage 0 — install the tree properly rather than inheriting an install, and let the repo's
		// own setup doc get corrected when it turns out to be wrong. Replay makes the common case
		// deterministic and free; the agent only wakes on a first run, changed lockfiles, or a
		// failed replay. PATH and PYTHONPATH then come from what setup actually produced.
		setStatus("planning");
		const setup = await runSetup({
			targetCwd: config.targetCwd,
			workCwd,
			model: config.routing.worker,
			env: resolveMissionEnv({ targetCwd: config.targetCwd, workCwd, missionId: store.state.id, sourceRoots: [] }),
			// So setup can install this mission's projects rather than the whole monorepo.
			brief: `${config.goal}\n\n${config.rfc ?? ""}`,
			onProgress: (m) => emit(`  setup: ${m}`),
		});
		sourceRoots = setup.sourceRoots;
		binDirs = setup.binDirs;
		store.state.costUsd += setup.costUsd;
		emit(`setup ${setup.ok ? "ok" : "INCOMPLETE"} (${setup.mode}) — ${setup.steps.length} step(s), ${binDirs.length} bin dir(s), ${sourceRoots.length} source root(s)`);
		if (setup.docUpdated) emit(`  setup: corrected the repo's setup doc → ${setup.docUpdated}`);
		for (const n of setup.notes) emit(`  setup: ${n}`);
		if (!setup.ok) emit("  ⚠ setup did not fully succeed — commands needing dependencies may fail");
		store.save();

		// Ports — one contiguous block per worktree, so two missions in this repo cannot bind the
		// same number. Without this every other kind of isolation the harness does is undone by a
		// shared `PORT=3000`: the second service fails to bind, the worker's smoke check reaches
		// the FIRST mission's server, and validation passes against code this mission never wrote.
		//
		// Only with a worktree. Without one there is a single tree, nothing to collide with, and
		// rewriting the env file would be editing the operator's own checkout.
		let portOverrides: Record<string, string> = {};
		if (useWorktree && setup.ports.length) {
			// Blocks other live missions already own, across every repo — this machine is the
			// shared resource, not the repo. A bind probe alone cannot see a mission that is
			// simply between commands.
			const claimed = readActive()
				.filter((r) => !r.done && r.id !== store.state.id && typeof r.portBase === "number")
				.map((r) => r.portBase as number);
			const block = await allocatePortBlock(workCwd, { claimed });
			portOverrides = assignPorts(setup.ports, block);
			store.state.portBase = block.base;
			// Published before the ports are used, so a mission starting alongside this one sees
			// the claim. Two missions allocating in the same instant can still both take a block;
			// the window is one file write, and a lock is not worth what it would cost here.
			publish();
			// On disk, not just injected: dotenv loads with override=True, so a file value wins.
			if (applyEnvOverrides({ targetCwd: config.targetCwd, workCwd, envFile: ".env", missionId: store.state.id, overrides: portOverrides })) {
				// applyEnvOverrides creates .env when the repo keeps none, and a file the harness
				// placed here must never reach a commit.
				if (!gitExcludes.includes(".env")) gitExcludes.push(".env");
			}
			emit(`ports: ${Object.entries(portOverrides).map(([k, v]) => `${k}=${v}`).join(" ")}${block.drift ? ` (derived block taken — moved ${block.drift})` : ""}`);
		} else if (useWorktree) {
			emit("⚠ ports: setup named no port env vars — a parallel mission in this repo may collide");
		}

		// The env every worker command and every assertion check runs under. Explicit, so that
		// which tree a command reads is a decision here rather than an accident of the daemon's
		// ambient environment or a venv's baked-in absolute paths.
		let missionEnv = resolveMissionEnv({
			targetCwd: config.targetCwd,
			workCwd,
			missionId: store.state.id,
			sourceRoots,
			binDirs,
			overrides: portOverrides,
		});

		// 1. Plan — the validation contract is written here, before any code exists.
		setStatus("planning");
		emit("orchestrator planning…");
		const { plan, costUsd: planCost } = await planMission(config, topLevelRecon(workCwd), {
			workCwd,
			// Doctrine now comes from the repo's own AGENTS.md, which workers load directly.
			envDoctrine: undefined,
		});
		store.state.plan = plan;
		store.state.costUsd += planCost;
		store.save();
		emit(`plan: ${plan.features.length} feature(s), ${plan.contract.assertions.length} assertion(s) — $${planCost.toFixed(3)}`);
		store.appendEvent("lifecycle", `plan ready: ${plan.features.length} feature(s), ${plan.contract.assertions.length} assertion(s)`, `cost $${planCost.toFixed(3)}`, { seat: "lead" });

		// Gate the plan before a single worker is paid for. A contract that coerced away to
		// nothing would otherwise score 0/0, and 0/0 has no failures, and no failures reads
		// as CLEAN — the harness reporting success for a mission that proved nothing.
		const planViolations = checkPlan(plan);
		for (const w of warnings(planViolations)) emit(`  ⚠ [${w.invariant}] ${w.detail}`);
		const planBlockers = blocking(planViolations);
		if (planBlockers.length) {
			throw new Error(`Plan violates ${planBlockers.length} harness invariant(s):\n${formatViolations(planBlockers)}`);
		}

		// Schema work is the one action a parallel worker can take that breaks every other tree
		// at once, so it is the only thing we isolate. Everything else runs against the live
		// environment on purpose. Decided here because only the plan knows if DDL is coming.
		const dbOutcome = await provisionDbBranch({ plan, missionId: store.state.id });
		if (dbOutcome.status === "branched") {
			// Written into the worktree's .env, not just injected: dotenv loads with override=True,
			// so a file value would otherwise beat anything we pass down.
			applyEnvOverrides({
				targetCwd: config.targetCwd,
				workCwd,
				envFile: ".env",
				missionId: store.state.id,
				overrides: dbOutcome.branch.overrides,
			});
			missionEnv = resolveMissionEnv({
				targetCwd: config.targetCwd,
				workCwd,
				missionId: store.state.id,
				sourceRoots,
				binDirs,
				// Both, and in this order: the database override is the later decision, but the
				// ports must survive it. Dropping them here was the shape of the original bug.
				overrides: { ...portOverrides, ...dbOutcome.branch.overrides },
			});
			dbTeardown = dbOutcome.branch.teardown;
			emit(`database: ${dbOutcome.branch.note}`);
		} else if (dbOutcome.status === "unavailable") {
			schemaWarning = dbOutcome.note;
			emit(`⚠ database: ${dbOutcome.note}`);
		} else {
			emit(`database: ${dbOutcome.note}`);
		}

		// 2. Milestones. Each is: work the queue serially → validate the WHOLE contract →
		//    orchestrator rules the boundary → corrections become the next queue.
		//    Validation failing on the first pass is the normal case, not the error case.
		let queue: Feature[] = plan.features.slice(0, config.maxFeatures).map((f) => ({ ...f, milestone: 1, origin: "plan" as const }));
		store.state.features = [...queue];
		store.save();

		// Read-only scouts, loaded once from the TARGET repo rather than the worktree, so a
		// mission cannot rewrite the specs of the agents helping it partway through its own run.
		const scouts = loadAgentSpecs(config.targetCwd);

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
			store.appendEvent("milestone_verdict", `milestone ${m} started`, `${queue.length} feature(s) queued`, { seat: "lead" });
			const handoffs: Handoff[] = [];
			const liveThisMilestone: { workerId: string; release: () => void }[] = [];

			for (const feature of queue) {
				const remaining = config.budgetUsd - store.state.costUsd;
				if (remaining <= 0) {
					emit("budget exhausted — stopping before next feature");
					break;
				}
				emit(`worker → ${feature.id}: ${feature.title}`);
				store.appendEvent("tool_call", `worker: ${feature.id}`, feature.title, { seat: "eng" });
				const assertions = plan.contract.assertions.filter((a) => feature.assertionIds.includes(a.id));
				const result = await runWorker({
					feature,
					assertions,
					milestone: m,
					cwd: workCwd,
					model: config.routing.worker,
					budgetUsd: Math.min(remaining, config.budgetUsd * 0.6),
					env: missionEnv,
					scouts,
					envDoctrine: schemaWarning ? `HARNESS WARNING: ${schemaWarning}` : undefined,
					onProgress: (e) => {
						if (e.type === "tool") {
							// Publish, not just stream. Tool events used to go straight to onEvent, so the
							// registry record went untouched for the whole working phase — the longest one
							// — and the board showed a live mission as frozen at its last status change.
							// Measured: 57 consecutive tool events with zero registry writes. It also
							// silently trips isStalled(), which judges liveness by updatedAt against a
							// one-hour threshold, so any long working phase reads as stalled while running.
							touch(`  ${feature.id} → ${e.toolName}`);
							onEvent?.({ type: "log", message: `  ${feature.id} → ${e.toolName}` });
						} else if (e.type === "image") {
							// Store the image on disk (content-addressed, idempotent) then append a
							// structured event so the timeline and web UI can render it.
							try {
								const stored = store.attachImage(e.data, e.mimeType);
								store.appendEvent(
									"image",
									`image from ${e.toolName}`,
									undefined,
									{
										seat: "eng",
										image: { path: stored.path, mimeType: e.mimeType, bytes: stored.bytes },
									},
								);
							} catch {
								// Storage failure is non-fatal — the mission continues.
							}
						}
					},
				});
				store.state.costUsd += result.costUsd;

				const sha = commitAll(
					workCwd,
					`feat(${feature.id}): ${feature.title}\n\nvia pi-missions ${store.state.id}`,
					gitExcludes,
				);
				if (sha) {
					store.state.commits.push({ featureId: feature.id, sha, message: feature.title });
					result.handoff.commitSha = sha;
					emit(`  committed ${sha.slice(0, 8)} (${result.aborted ? "budget-capped" : result.stopReason}) — $${result.costUsd.toFixed(3)}`);
					store.appendEvent("lifecycle", `committed ${feature.id}`, `${sha.slice(0, 8)} — $${result.costUsd.toFixed(3)}`, { seat: "system" });
				} else {
					emit(`  no changes committed for ${feature.id} (${result.stopReason})`);
					store.appendEvent("lifecycle", `no commit for ${feature.id}`, result.stopReason, { seat: "system" });
				}

				handoffs.push(result.handoff);
				store.state.handoffs.push(result.handoff);
				// Held, not released: the worker stays socket-addressable through validation and
				// triage so a stalled milestone can be steered by the agent that has the context.
				liveThisMilestone.push(result);
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
				bugSpotterModel: config.routing.bugSpotter,
				diff,
				intent,
				// The repo's own verify step, discovered by setup, is a better default than a guess.
				extraCheckCommand: config.checkCommand ?? setup.verifyCommand,
				env: missionEnv,
				// Assertions that reach back into the main checkout are refused rather than run,
				// so a mission can no longer score itself against a tree it never touched.
				foreignRoot: config.targetCwd,
				onProgress: (msg) => emit(`  validator: ${msg}`),
				// Pending classification: assertions whose owning feature has not yet been
				// dispatched are excluded from the failing set but still block CLEAN.
				dispatchedFeatureIds: store.state.features.map((f) => f.id),
			});
			store.state.scoreCard = scoreCard;
			store.state.costUsd += scoreCard.costUsd;
			store.save();
			const pendingCount = scoreCard.pendingAssertionIds?.length ?? 0;
			emit(`validated: ${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal} assertions${pendingCount > 0 ? `, ${pendingCount} pending` : ""}, ${scoreCard.bugs.length} bug(s)`);
			// The summary and its per-assertion results share a thread, so the timeline shows one
			// line with "12 replies" rather than thirteen lines of equal weight. A mission with
			// forty assertions was otherwise a wall of ✓ that buried the verdict above it.
			const vThread = `validation-m${m}`;
			store.appendEvent(
				"validation_result",
				`validated: ${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal} assertions passed${pendingCount > 0 ? `, ${pendingCount} pending` : ""}`,
				scoreCard.bugs.length > 0 ? `${scoreCard.bugs.length} bug(s) found` : "no bugs found",
				{ seat: "qa", thread: vThread },
			);
			// Emit per-assertion pass/fail events
			for (const a of plan.contract.assertions) {
				const label = a.pending ? "⏳" : a.passed ? "✓" : "✗";
				store.appendEvent(
					"validation_result",
					`${label} ${a.id}: ${a.statement.slice(0, 80)}`,
					a.evidence ?? undefined,
					{ seat: "qa", thread: vThread },
				);
			}

			// --- Boundary.
			// Pending assertions (owning feature not yet dispatched) are excluded from the
			// failing set used by triage and stall decisions, but still block a CLEAN verdict.
			const failing = plan.contract.assertions.filter((a) => !a.pending && !a.passed);
			const pendingAssertions = plan.contract.assertions.filter((a) => a.pending);
			const blockingBugs = scoreCard.bugs.filter((b) => b.severity === "critical" || b.severity === "high");
			const openIssues = handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition));
			// CLEAN requires: no failures, no blocking bugs, AND no pending assertions
			// (pending means the contract has not been fully evaluated yet).
			const clean = failing.length === 0 && blockingBugs.length === 0 && pendingAssertions.length === 0;

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
				store.appendEvent("milestone_verdict", `milestone ${m}: PASSED`, "contract satisfied, no open issues", { seat: "lead" });
				break;
			}

			if (m === maxMilestones) {
				verdict = "max-milestones";
				record.verdict = verdict;
				record.assessment = `Hit the ${maxMilestones}-milestone ceiling with ${failing.length} failing assertion(s)${pendingAssertions.length > 0 ? `, ${pendingAssertions.length} pending` : ""}, ${blockingBugs.length} blocking bug(s), ${openIssues.length} open issue(s).`;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: hit milestone ceiling — needs you`);
				store.appendEvent("milestone_verdict", `milestone ${m}: max-milestones ceiling hit`, record.assessment, { seat: "lead" });
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
				store.appendEvent("milestone_verdict", `milestone ${m}: budget exhausted`, `$${remainingUsd.toFixed(2)} remaining`, { seat: "lead" });
				break;
			}

			emit(`milestone ${m}: ${failing.length} failing${pendingAssertions.length > 0 ? `, ${pendingAssertions.length} pending` : ""}, ${blockingBugs.length} blocking bug(s), ${openIssues.length} open issue(s) — orchestrator triaging…`);
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

			// Strengthen the contract. This is only possible now: at plan time there was no
			// interface to assert against, so the contract could only claim a file would exist.
			// The code is here, so the boundary can add assertions that actually execute it — and
			// they are validated from the NEXT milestone on, against work that must then satisfy
			// them. The ratchet check runs first: adding is free, removing or rewording is not.
			if (review.newAssertions.length) {
				const before = plan.contract.assertions.map((a) => ({ ...a }));
				const after = [...plan.contract.assertions, ...review.newAssertions];
				const ratchet = blocking(checkContractRatchet(before, after));
				if (ratchet.length) {
					emit(`  ⚠ contract additions REJECTED — ${formatViolations(ratchet)}`);
				} else {
					plan.contract.assertions = after;
					store.state.plan = plan;
					for (const a of review.newAssertions) {
						emit(`  + assertion ${a.id} [${a.strength ?? "unclassified"}] ${a.statement.slice(0, 90)}`);
						if (a.justification) emit(`      because: ${a.justification.slice(0, 110)}`);
					}
					store.save();
				}
			}

			// Cap BEFORE checking, so the invariants see what will actually be dispatched rather
			// than what was proposed. Corrections past the cap are dropped, and any issue that was
			// ruled "addressed" by a dropped correction goes back to open — nothing is fixing it,
			// so calling it addressed would close it on a promise the harness just cancelled.
			const corrections = review.corrections.slice(0, config.maxFeatures);
			const dropped = review.corrections.slice(config.maxFeatures);
			if (dropped.length) {
				const reopened = reopenIssuesFor(handoffs, dropped.map((c) => c.id));
				emit(
					`  ⚠ ${dropped.length} correction(s) over --max-features=${config.maxFeatures} dropped: ${dropped.map((c) => c.id).join(", ")}` +
						(reopened ? ` — ${reopened} issue(s) reopened` : ""),
				);
			}

			// --- Stall/retry decision: at most one re-validate attempt per milestone.
			let retriedThisMilestone = false;

			// Re-validation loop: runs at most twice (initial + one re-validate).
			// On re-validate the inner code re-runs the validators and boundary check,
			// then falls back into this same decision with retriedThisMilestone=true.
			boundaryLoop: for (;;) {
				const violations = checkBoundary({
					assertions: plan.contract.assertions,
					scoreCard,
					handoffs,
					verdict: review.verdict,
					corrections,
					dispatchedFeatureIds: store.state.features.map((f) => f.id),
				});
				for (const w of warnings(violations)) emit(`  ⚠ [${w.invariant}] ${w.detail}`);
				const blockers = blocking(violations);

				if (blockers.length) {
					const decision = decideStallOrRetry({
						violations: blockers,
						correctionsOffered: corrections.length > 0,
						milestonesRemaining: maxMilestones - m,
						retriedThisMilestone: retriedThisMilestone,
					});

					if (decision.action === "re-validate") {
						// Re-run the validators once and retry the boundary check.
						retriedThisMilestone = true;
						emit(`  ↺ [scorecard.covers-contract] re-running validation to re-check assertion count`);
						store.appendEvent("milestone_verdict", `milestone ${m}: re-validating`, "scorecard.covers-contract retry", { seat: "lead" });
						const diff2 = diffAgainst(workCwd, baseSha);
						scoreCard = await runValidators({
							cwd: workCwd,
							plan,
							bugSpotterModel: config.routing.bugSpotter,
							diff: diff2,
							intent,
							extraCheckCommand: config.checkCommand ?? setup.verifyCommand,
							env: missionEnv,
							foreignRoot: config.targetCwd,
							onProgress: (msg) => emit(`  validator: ${msg}`),
							dispatchedFeatureIds: store.state.features.map((f) => f.id),
						});
						store.state.scoreCard = scoreCard;
						store.state.costUsd += scoreCard.costUsd;
						record.scoreCard = scoreCard;
						store.save();
						continue boundaryLoop; // re-check with retriedThisMilestone=true
					}

					if (decision.action === "scope-corrections") {
						// verdict.evidence-backed cleared by routing — fall through to corrections.
						break boundaryLoop;
					}

					// decision.action === "stall"
					const stalledBy = decision.invariants.join(", ") || "boundary violation";
					const whatWasTried = retriedThisMilestone ? " Re-validation was attempted once." : "";
					const rawReason = `${decision.reason}${whatWasTried}` +
						(decision.invariants.length > 0 ? ` (${decision.invariants.join(", ")})` : "");
					const fullReason = finalizeStall(
						store.state,
						rawReason,
						m,
						failing.map((a) => a.id),
					);
					verdict = "stalled";
					record.verdict = verdict;
					record.assessment = `${review.assessment}\n\n[harness] Boundary blocked by ${blockers.length} invariant violation(s):\n${formatViolations(blockers)}`;
					store.state.milestones.push(record);
					store.save();
					emit(`milestone ${m}: STALLED — ${stalledBy} — needs you: ${fullReason}`);
					store.appendEvent("milestone_verdict", `milestone ${m}: STALLED`, fullReason, { seat: "lead" });
					await offerRescue(liveThisMilestone, workCwd, gitExcludes, store, emit, config.rescueWaitMs);
					break;
				}

				// No blockers (or cleared after re-validate): proceed to pass/corrections checks.
				break boundaryLoop;
			} // end boundaryLoop

			// If we broke out of the loop due to a stall, the milestone already saved and broke
			// the outer loop. If we are here, boundary is clear (possibly after re-validate).
			// We must re-check whether the outer loop was broken by the stall above.
			if (verdict === "stalled") break;

			const stillOpen = handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition));

			// Evidence is green, every issue has been ruled, and the orchestrator is not asking for
			// more work: that is a pass. Decided on the evidence — a milestone cannot pass on the
			// orchestrator's say-so alone; verdict.evidence-backed above is what enforces that.
			if (clean && stillOpen.length === 0 && review.verdict !== "needs-corrections") {
				verdict = "passed";
				record.verdict = verdict;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: PASSED — contract satisfied, all issues ruled`);
				store.appendEvent("milestone_verdict", `milestone ${m}: PASSED`, "contract satisfied, all issues ruled", { seat: "lead" });
				break;
			}

			if (review.verdict !== "needs-corrections" || corrections.length === 0) {
				// Build a full plain-language sentence for the stall reason (never a bare slug).
				const rawNoCorReason =
					corrections.length === 0
						? "The orchestrator did not offer any corrections to address the failing assertions. A human needs to review the situation and decide what to do next."
						: `The orchestrator's verdict was not 'needs-corrections' (got '${review.verdict}'), so corrections cannot be scoped. A human needs to review the orchestrator's assessment and resolve the discrepancy.`;
				const noCorReason = finalizeStall(
					store.state,
					rawNoCorReason,
					m,
					failing.map((a) => a.id),
				);
				verdict = "stalled";
				record.verdict = verdict;
				store.state.milestones.push(record);
				store.save();
				emit(`milestone ${m}: STALLED — needs you: ${noCorReason}`);
				store.appendEvent("milestone_verdict", `milestone ${m}: STALLED`, noCorReason, { seat: "lead" });
				await offerRescue(liveThisMilestone, workCwd, gitExcludes, store, emit, config.rescueWaitMs);
				break;
			}

			record.verdict = "corrections-scoped";
			record.correctionIds = corrections.map((c) => c.id);
			verdict = "corrections-scoped";
			store.state.milestones.push(record);
			store.state.features.push(...corrections);
			store.save();
			emit(`milestone ${m}: scoped ${corrections.length} correction(s) → ${corrections.map((c) => c.id).join(", ")}`);
			store.appendEvent("milestone_verdict", `milestone ${m}: corrections scoped`, corrections.map((c) => c.id).join(", "), { seat: "lead" });
			queue = corrections;
		}

		store.state.finalVerdict = verdict;
		// Choke point: guarantee stallReason is non-empty for every terminal stall.
		// The two explicit stall paths call finalizeStall directly, but an unexpected
		// loop exit (e.g. empty queue on first iteration) could produce a stalled
		// verdict with no reason — this catches that edge case.
		if (verdict === "stalled") {
			finalizeStall(
				store.state,
				store.state.stallReason,
				store.state.milestones.length,
				plan.contract.assertions.filter((a) => !a.passed).map((a) => a.id),
			);
		}
		store.state.outcome = verdict === "passed" ? "clean" : "needs-review";
		store.state.debrief = buildDebrief(store.state, scoreCard);
		store.save();

		// 3. Report.
		setStatus("reporting");
		const reportPath = generateReport({ state: store.state, plan, scoreCard, outDir: config.outDir });
		store.state.reportPath = reportPath;
		store.save();
		emit(`report → ${reportPath}`);

		setStatus("succeeded");
		const baseVerdict = verdict === "passed" ? "CLEAN" : `NEEDS YOU (${verdict})`;
		const annotated = annotateVerdict(baseVerdict, scoreCard);
		const finalMsg = `mission ${annotated} — $${store.state.costUsd.toFixed(2)} over ${store.state.milestones.length} milestone(s)`;
		emit(finalMsg);
		if (store.state.stallReason) {
			emit(`stall reason: ${store.state.stallReason}`);
		}
		store.appendEvent("lifecycle", finalMsg, store.state.stallReason, { seat: "system" });
	} catch (err) {
		const errMsg = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
		emit(errMsg);
		store.appendEvent("error", errMsg, undefined, { seat: "system" });
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
	} finally {
		stopServing();
		if (dbTeardown) {
			await dbTeardown();
			emit("database: mission branch removed");
		}
		// A run that produced no commit has nothing on its branch, so its worktree is
		// pure cost — and a crashed mission is exactly the case nobody comes back to
		// action. Anything committed, or anything left uncommitted, is kept.
		const wt = store.state.worktreePath;
		if (wt && store.state.status === "failed" && !store.state.commits?.length) {
			const got = reclaimWorktree(config.targetCwd, wt, "no-commits");
			if (got.skipped) emit(`worktree kept: ${got.skipped}`);
			else emit(`worktree reclaimed (${humanBytes(got.bytes)}) — no commits to preserve`);
		}
	}

	return store.state;
}

/**
 * Single choke point for every terminal finalVerdict==='stalled' path.
 *
 * Guarantees that state.stallReason is a non-empty sentence before the caller
 * persists or emits. If the provided reason is already non-empty it is used
 * unchanged. Otherwise a concrete fallback is synthesised from what is known:
 * the number of milestones completed and the failing assertion ids.
 *
 * @param state          The live mission state (mutated: stallReason is set).
 * @param providedReason The reason string produced by the stall path (may be
 *                       empty or undefined if the path did not generate one).
 * @param milestoneIndex The 1-based milestone number that triggered the stall.
 * @param failingIds     Assertion ids that were failing at stall time.
 * @returns              The non-empty stallReason that was stored.
 */
export function finalizeStall(
	state: MissionState,
	providedReason: string | undefined,
	milestoneIndex: number,
	failingIds: string[],
): string {
	if (providedReason && providedReason.trim().length > 0) {
		state.stallReason = providedReason.trim();
		return state.stallReason;
	}
	// Synthesise a concrete fallback that mentions what is known.
	const idList = failingIds.length > 0 ? failingIds.join(", ") : "none";
	const fallback = `Stalled after ${milestoneIndex} milestone${milestoneIndex === 1 ? "" : "s"}; failing assertions: ${idList}.`;
	state.stallReason = fallback;
	return fallback;
}

/**
 * Assemble a deterministic, grounded debrief from data already in state.
 * Must not use unqualified success language when the strength breakdown is existence-only.
 */
function buildDebrief(state: MissionState, scoreCard: ScoreCard | undefined): string {
	const milestones = state.milestones ?? [];
	const handoffs = state.handoffs ?? [];
	const commits = state.commits ?? [];
	const bd = scoreCard?.strengthBreakdown;

	const behaviouralPassed = bd?.behavioural?.passed ?? 0;
	const behaviouralTotal = bd?.behavioural?.total ?? 0;
	const existenceOnly = behaviouralPassed === 0;

	const lines: string[] = [];

	// --- verdict line ---
	const baseVerdict = state.outcome === "clean" ? "CLEAN" : `NEEDS YOU (${state.finalVerdict ?? "unknown"})`;
	const annotated = annotateVerdict(baseVerdict, scoreCard);
	lines.push(`Verdict: ${annotated}`);

	// --- score summary ---
	if (scoreCard) {
		const strengthNote = existenceOnly
			? "assertion strength: existence-only (no behavioural assertion executed the feature)"
			: behaviouralPassed < behaviouralTotal
				? `assertion strength: ${behaviouralPassed} of ${behaviouralTotal} behavioural assertions passed`
				: `assertion strength: all ${behaviouralTotal} behavioural assertion(s) passed`;
		lines.push(`Assertions: ${scoreCard.assertionsPassed}/${scoreCard.assertionsTotal} passed · ${scoreCard.bugs.length} bug(s) flagged · ${strengthNote}`);
	}

	// --- milestones and commits ---
	lines.push(`Milestones: ${milestones.length} · Commits: ${commits.length} · Cost: $${state.costUsd.toFixed(2)}`);

	if (commits.length) {
		lines.push(`Commits: ${commits.map((c) => `${c.sha.slice(0, 8)} ${c.message}`).join("; ")}`);
	}

	// --- handoff summary ---
	const leftUndone = handoffs.flatMap((h) => h.leftUndone);
	if (leftUndone.length) {
		lines.push(`Left undone: ${leftUndone.join("; ")}`);
	}

	const issues = handoffs.flatMap((h) => h.issues);
	const unruled = issues.filter((i) => !i.disposition);
	const ruled = issues.filter((i) => i.disposition);
	if (unruled.length) {
		lines.push(`Unruled issues (${unruled.length}): ${unruled.map((i) => i.summary).join("; ")}`);
	}
	if (ruled.length) {
		lines.push(`Ruled issues: ${ruled.map((i) => `${i.summary} [${i.disposition}]`).join("; ")}`);
	}

	return lines.join("\n");
}

/** Stamp the orchestrator's dispositions onto the issues they refer to. Matches on summary. */
function applyRulings(handoffs: Handoff[], rulings: CorrectionRuling[]): void {
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
				issue.addressedBy = hit.disposition === "addressed" ? hit.correctionId : undefined;
				issue.deferredEvidence = hit.disposition === "deferred" ? hit.evidenceAssertionId : undefined;
				issue.deferredOutOfScope = hit.disposition === "deferred" ? hit.outOfScope === true : undefined;
			}
		}
	}
}

/**
 * Re-open issues whose nominated correction is not being dispatched. Returns how many.
 * An open issue blocks the pass, which is exactly right: the work is still outstanding.
 */
function reopenIssuesFor(handoffs: Handoff[], droppedIds: string[]): number {
	const gone = new Set(droppedIds);
	let count = 0;
	for (const h of handoffs) {
		for (const issue of h.issues) {
			if (issue.disposition === "addressed" && issue.addressedBy && gone.has(issue.addressedBy)) {
				issue.disposition = undefined;
				issue.dispositionNote = undefined;
				issue.addressedBy = undefined;
				count++;
			}
		}
	}
	return count;
}

/**
 * Hold a STALLED milestone open so its worker can be steered, instead of exiting on it.
 *
 * The failure this closes: a worker used to be unregistered the instant its own turn ended, which
 * is before validation runs and long before the orchestrator decides the milestone stalled. So a
 * worker was reachable for its entire life EXCEPT the one moment an operator wanted it — the
 * "needs you" moment — and all that survived was a paragraph of handoff text. Meanwhile the agent
 * itself still held the files it had read and the reasoning behind its choices, which is the
 * expensive part and the part a fresh worker has to buy again.
 *
 * So on a stall, if anyone is listening, the mission says how to reach the worker and waits. A
 * steer resumes that same agent with its context, and whatever it changes is committed onto the
 * mission's branch.
 *
 * Deliberately does NOT re-run the validators afterwards — the milestone verdict stays STALLED and
 * the operator re-checks. Auto-revalidating a rescue means restructuring the milestone loop, and a
 * committed fix plus an honest STALLED is worth more than a green verdict this cannot yet earn.
 */
async function offerRescue(
	live: { workerId: string; release: () => void }[],
	workCwd: string,
	gitExcludes: string[],
	store: StateStore,
	emit: (message: string) => void,
	waitMs = 0,
): Promise<void> {
	if (waitMs <= 0 || !live.length || !listWorkers().length) {
		for (const w of live) w.release();
		return;
	}

	const mins = Math.round(waitMs / 60_000);
	emit(`  ⏸ holding ${live.length} worker(s) open for ${mins}m — steer one and it will fix this with its context intact:`);
	for (const w of live) emit(`      missions steer ${w.workerId} "<what to change>"`);

	const steered = await awaitOperatorSteer(waitMs);
	if (!steered) {
		emit("  ⏹ nobody steered — releasing the workers and ending the mission");
		for (const w of live) w.release();
		return;
	}

	emit(`  ▶ ${steered} resumed by operator`);
	// The steer text is already in the worker's queue; resume acts on it. Pull the latest so the
	// resume prompt restates it — a worker that has gone idle will not otherwise read it.
	const info = listWorkers().find((w) => w.id === steered);
	const instruction = info?.steers.slice(-1)[0] ?? "Fix the reason this milestone stalled.";
	const reply = await resumeWorker(steered, instruction);
	if (reply) emit(`  ${steered}: ${reply.slice(0, 300)}`);

	const sha = commitAll(workCwd, `fix(${steered}): operator rescue\n\nvia pi-missions ${store.state.id}`, gitExcludes);
	if (sha) {
		store.state.commits.push({ featureId: steered, sha, message: "operator rescue" });
		store.save();
		emit(`  committed ${sha.slice(0, 8)} (operator rescue) — re-run your check to confirm`);
	} else {
		emit("  rescue produced no file changes — nothing committed");
	}
	for (const w of live) w.release();
}
