import { createBashTool, createEditTool, createReadOnlyTools, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Agent, getEnvApiKey, getModel, streamFn, type AgentEvent, type AgentMessage, type AgentTool } from "./pi.js";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Type } from "typebox";
import chalk from "chalk";
import { cmuxOpenBrowser, cmuxOpenDiff, hasCmuxPassword, insideCmux } from "./cmux.js";
import { publishFocus } from "./focus.js";
import { mergeBranch } from "./git.js";
import { reclaimBranch, reclaimWorktree } from "./lifecycle.js";
import { resumeMission, runMission } from "./mission.js";
import { autoRouting } from "./models.js";
import { isLive, isStalled, readActive, updateActive } from "./registry.js";
import { renderSweep, sweep } from "./lifecycle.js";
import { dispatchScouts, loadAgentSpecs } from "./subagent.js";
import { listWorkspaces, registerWorkspace, resolveWorkspace, workspaceNames } from "./workspaces.js";
import type { MissionConfig } from "./types.js";

const SYSTEM_PROMPT = `You are the CHIEF OF STAFF for a solo founder-engineer. You run an org of coding agents across ALL of their repositories.
The user talks to you casually — never interrogate them with a form or a list of questions.

Workspaces — FIND YOUR OWN WAY, do not ask for directions:
- You are NOT limited to one repo. Every tool takes an optional "repo" (a short name like "nadine", or an absolute path). Omit it to use the repo currently in focus.
- When the user names something you cannot immediately place, GO LOOK. In order: list_workspaces, then \`ls\` the obvious parents (their home, ~/code, ~/src, ~/projects, wherever the other repos live), then \`find\` if you still have not found it. You have a shell and the whole filesystem — a repo you cannot name is a search you have not run yet.
- Same for any question about a repo: read it, grep it, run its tests, check its git log. Do not answer "I'd need to look at X" — look at X, then answer.
- Ask the user which repo ONLY when you have actually searched and found two or more plausible matches. Name the candidates in the question. "Where is that?" is not an acceptable question; "nadine or nadine-old?" is.
- Missions in different repos run concurrently and land on their own branches, so "fix X in nadine and Y in missions" is one exchange, not two sessions.

Your own hands (read, grep, find, ls, bash, write, edit):
- These run on the user's machine as the user, with the WHOLE filesystem in reach. Relative paths resolve against the repo they are attached from; absolute paths go anywhere. You never need to say you are unable to look at, run, or change something.
- Use them for SETUP and for anything deterministic: create a directory, git init, scaffold a project, npm/pnpm install, run a build or a test, read a log, make a commit, check whether something actually works.
- Do NOT use them to build the product. Writing a feature by hand is one agent doing serial work with no plan, no contract, and no validation. Dispatch a mission for that — the whole point of the org is that features arrive with assertions proving they run.
- The line: you get the repo to the point where a mission CAN run, then dispatch. Roughly — scaffold and commit by hand, features by mission.
- Starting a new project, in order: create the directory, git init, write the minimum skeleton (package.json/README/.gitignore, whatever the stack needs), install and verify the toolchain runs, then \`git add -A && git commit\`. THEN dispatch missions with repo set to the new directory's absolute path — it registers itself on first use.
- A repo with ZERO commits cannot host a mission. Missions run in git worktrees branched off a ref, and an empty repo has no ref. The first commit is yours, always.
- Destructive commands are yours to get right: no rm -rf outside a directory you created, no force-push, no touching anything under the user's home you were not asked about. When a command would delete or overwrite something you did not make, say what you are about to do and let them answer first.

How to behave:
- Infer intent. Propose a crisp plan in 1-2 lines. When the ask is clear, call run_mission to dispatch a worker — it runs in the BACKGROUND, so say you've kicked it off and keep talking.
- Missions run in PARALLEL, each in its own git worktree (a few at once). Dispatch several pieces of work concurrently.
- run_mission is for WRITING CODE. Never dispatch one for a deterministic local operation — merging, cleaning up,
  listing. Those have their own tools (accept_mission, reclaim_disk, list_missions). A worker cannot run git at all,
  so a mission asked to merge will produce a document describing a merge instead of doing one.
- Ask a clarifying question ONLY when you truly cannot proceed AND looking would not answer it. One question, never a checklist. Anything you could establish by reading a file or running a command is not a question — it is a tool call you have not made.
- For reading a repo OTHER than the one in front of you at any depth, prefer investigate — it sends read-only scouts and returns their answers without filling your context.
- Keep every reply short and skimmable. No walls of text.
- When a mission finishes you'll get a "[mission-complete]" note — relay the result in 2-3 lines and say which repo it was. Report ONLY what the note says: if it does not say a review opened, do not claim one did.

Be a fast, direct teammate. Default to action.`;

function userMsg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function configFor(targetCwd: string, goal: string, rfc: string, maxFeatures: number): MissionConfig {
	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	return {
		goal,
		rfc,
		targetCwd,
		branch: `missions/${new Date().toISOString().slice(0, 10)}`,
		outDir: resolve(targetCwd, ".missions", "runs", runId),
		routing: autoRouting(),
		maxFeatures,
		maxMilestones: 3,
		target: /nadine|naomi/i.test(targetCwd) ? "nadine" : "generic",
		useWorktree: true,
	};
}

function reviewInCmux(cwd: string, reportPath?: string, baseSha?: string): string {
	if (!reportPath || !insideCmux() || !hasCmuxPassword()) return "";
	const okReport = cmuxOpenBrowser(reportPath);
	const okDiff = baseSha ? cmuxOpenDiff(cwd, baseSha) : false;
	return okReport || okDiff ? " Review opened in cmux (report + diff)." : "";
}

interface Job {
	repo: string;
	goal: string;
	rfc: string;
	maxFeatures: number;
}

/** Parallel background mission runner: each mission runs in its own worktree, in whichever repo it targets. */
class MissionRunner {
	private queue: Job[] = [];
	private active = 0;
	private readonly cap = 3;
	private readonly notify: (text: string) => void;
	private readonly log: (text: string) => void;
	constructor(notify: (text: string) => void, log: (text: string) => void) {
		this.notify = notify;
		this.log = log;
	}

	get activeCount(): number {
		return this.active;
	}

	enqueue(job: Job): { startedNow: boolean; active: number } {
		const startedNow = this.active < this.cap;
		this.queue.push(job);
		this.pump();
		return { startedNow, active: this.active };
	}

	private pump(): void {
		while (this.active < this.cap && this.queue.length) {
			const job = this.queue.shift();
			if (!job) break;
			this.active++;
			void this.runOne(job).finally(() => {
				this.active--;
				this.pump();
			});
		}
	}

	private async runOne(job: Job): Promise<void> {
		const config = configFor(job.repo, job.goal, job.rfc, job.maxFeatures);
		const repoName = basename(job.repo);
		const tag = `${repoName}:${job.goal.length > 20 ? `${job.goal.slice(0, 20)}…` : job.goal}`;
		this.log(chalk.dim(`\n  ▶ mission started in ${repoName}: ${job.goal}\n`));
		try {
			const state = await runMission(config, (e) => {
				if (e.type === "status") this.log(chalk.dim(`  ▸ [${tag}] ${e.status}\n`));
				else if (e.type === "log" && /committed|validated|report →|worktree |budget|FAILED/.test(e.message))
					this.log(chalk.dim(`  · [${tag}] ${e.message}\n`));
			});
			const sc = state.scoreCard;
			const review = reviewInCmux(state.worktreePath ?? job.repo, state.reportPath, state.baseSha);
			this.notify(
				`[mission-complete] ${repoName}: "${job.goal}" → ${state.status}; ` +
					`${sc ? `${sc.assertionsPassed}/${sc.assertionsTotal} assertions, ${sc.bugs.length} bug(s)` : "no scorecard"}; ` +
					`$${state.costUsd.toFixed(3)}.${review}`,
			);
		} catch (err) {
			this.notify(`[mission-complete] ${repoName}: "${job.goal}" FAILED: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

const REPO_PARAM = Type.Optional(Type.String({ description: "Repo name (e.g. 'nadine') or path. Omit for the repo the user is attached from." }));

/** "I don't know that repo" — same answer everywhere, so the chief never guesses. */
function unknownRepo(ref: string): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text: `No workspace matches "${ref}" (or it is ambiguous). Known: ${workspaceNames()}. Ask the user which one, or pass a full path.` }] };
}

/**
 * The chief's tool set. Exported so a test can assert what the chief can actually do — the grants
 * here are the difference between a colleague and a narrator, and a silent regression to read-only
 * looks exactly like the model being unhelpful.
 */
export function buildTools(focus: () => string, runner: () => MissionRunner): AgentTool[] {
	const runMissionTool = {
		name: "run_mission",
		label: "run mission",
		description: "Dispatch a coding worker (runs in the background, in its own worktree) to make + validate a change in any repo. Use once the goal is clear.",
		parameters: Type.Object({
			goal: Type.String({ description: "One-line goal." }),
			rfc: Type.Optional(Type.String({ description: "Optional detail: what's wrong / what you want." })),
			maxFeatures: Type.Optional(Type.Number({ description: "Features this run (default 1)." })),
			repo: REPO_PARAM,
		}),
		async execute(_id: string, params: { goal: string; rfc?: string; maxFeatures?: number; repo?: string }) {
			const ws = resolveWorkspace(params.repo, focus());
			if (!ws) return unknownRepo(params.repo ?? "");
			registerWorkspace(ws.path);
			const { startedNow, active } = runner().enqueue({ repo: ws.path, goal: params.goal, rfc: params.rfc ?? "", maxFeatures: params.maxFeatures ?? 1 });
			const text = startedNow
				? `Started "${params.goal}" in ${ws.name} (own worktree; ${active} running). I'll report when it's done — keep talking or dispatch more.`
				: `Queued "${params.goal}" for ${ws.name} — ${active} already running (cap 3); it'll start as a slot frees.`;
			return { content: [{ type: "text", text }] };
		},
	} as unknown as AgentTool;

	const listTool = {
		name: "list_missions",
		label: "list missions",
		description: "List recent missions and their status. Covers every repo unless you name one.",
		parameters: Type.Object({ repo: REPO_PARAM }),
		async execute(_id: string, params: { repo?: string }) {
			let records = readActive();
			if (params.repo) {
				const ws = resolveWorkspace(params.repo, focus());
				if (!ws) return unknownRepo(params.repo);
				records = records.filter((r) => r.repo === ws.path);
			}
			if (!records.length) return { content: [{ type: "text", text: params.repo ? `No missions in ${params.repo} yet.` : "No missions yet." }] };
			const text = records
				.slice(0, 20)
				.map((r) => `- [${r.repoName}] [${r.status}${r.verdict ? `/${r.verdict}` : ""}] ${r.goal} ($${(r.costUsd ?? 0).toFixed(2)}${r.cleared ? ", cleared" : ""})`)
				.join("\n");
			return { content: [{ type: "text", text }] };
		},
	} as unknown as AgentTool;

	const workspacesTool = {
		name: "list_workspaces",
		label: "list workspaces",
		description: "List every repo this org knows about, with how much is running or waiting in each. Use before dispatching into a repo you cannot place.",
		parameters: Type.Object({}),
		async execute() {
			const records = readActive();
			const list = listWorkspaces();
			if (!list.length) return { content: [{ type: "text", text: "No workspaces registered yet — only the repo the user is attached from." }] };
			const here = focus();
			const text = list
				.map((w) => {
					const mine = records.filter((r) => r.repo === w.path);
					const running = mine.filter((r) => !r.done).length;
					const waiting = mine.filter((r) => r.done && !r.cleared).length;
					const bits = [running ? `${running} running` : "", waiting ? `${waiting} need review` : ""].filter(Boolean).join(", ");
					return `- ${w.name}${w.path === here ? " (current)" : ""} — ${w.path}${bits ? ` — ${bits}` : ""}`;
				})
				.join("\n");
			return { content: [{ type: "text", text }] };
		},
	} as unknown as AgentTool;

	const investigateTool = {
		name: "investigate",
		label: "investigate",
		description:
			"Send read-only scouts into any repo and get their answers back. Each scout has its own context, so their reading does not consume yours. " +
			"This is how you look inside a repo other than the one the user is attached from. Scouts CANNOT edit or run commands — dispatch a mission for that.",
		parameters: Type.Object({
			questions: Type.Array(Type.String({ description: "One self-contained question. The scout sees no other context." }), { description: "1-4 independent questions, answered concurrently." }),
			repo: REPO_PARAM,
		}),
		async execute(_id: string, params: { questions: string[]; repo?: string }) {
			const ws = resolveWorkspace(params.repo, focus());
			if (!ws) return unknownRepo(params.repo ?? "");
			const questions = (params.questions ?? []).filter((q) => q?.trim());
			if (!questions.length) return { content: [{ type: "text", text: "No questions given." }] };
			const results = await dispatchScouts({
				cwd: ws.path,
				specs: loadAgentSpecs(ws.path),
				tasks: questions.map((task) => ({ agent: "scout", task })),
			});
			const text = results.map((r) => (r.ok ? `## ${r.task}\n${r.output}` : `## ${r.task}\nFAILED — ${r.error ?? "unknown"}`)).join("\n\n");
			const spent = results.reduce((n, r) => n + r.costUsd, 0);
			return { content: [{ type: "text", text: `${text}\n\n_(${ws.name}, ${results.length} scout(s), $${spent.toFixed(4)})_` }] };
		},
	} as unknown as AgentTool;

	const gcTool = {
		name: "reclaim_disk",
		label: "reclaim disk",
		description:
			"Reclaim disk from finished missions: remove their worktrees and delete branches already merged into main. " +
			"Worktrees holding uncommitted work, missions still running, and missions you have not reviewed yet are all left alone. " +
			"Use when asked to clean up or free space. Report what it says, including anything it refused.",
		parameters: Type.Object({
			repo: REPO_PARAM,
			dryRun: Type.Optional(Type.Boolean({ description: "Report what would be removed without deleting. Prefer this first if the user seems unsure." })),
		}),
		async execute(_id: string, params: { repo?: string; dryRun?: boolean }) {
			const scoped = params.repo ? resolveWorkspace(params.repo, focus()) : undefined;
			if (params.repo && !scoped) return unknownRepo(params.repo);
			const dry = params.dryRun ?? false;
			const result = sweep({ repos: scoped ? [scoped.path] : undefined, dryRun: dry });
			return { content: [{ type: "text", text: renderSweep(result, dry).join("\n") }] };
		},
	} as unknown as AgentTool;

	const acceptTool = {
		name: "accept_mission",
		label: "accept",
		description:
			"Merge a finished mission's branch into its repo's checked-out branch, then reclaim the worktree and delete the branch. " +
			"This is the same action the board's 'a' key performs. Use it whenever the user asks to merge, accept, land or ship a mission. " +
			"NEVER dispatch a mission to do a merge — merging is a deterministic git operation, and a worker cannot run git anyway.",
		parameters: Type.Object({
			missionId: Type.String({ description: "The mission id, or enough of its prefix to be unambiguous." }),
		}),
		async execute(_id: string, params: { missionId: string }) {
			const matches = readActive().filter((r) => r.id === params.missionId || r.id.startsWith(params.missionId));
			if (!matches.length) return { content: [{ type: "text", text: `No mission matching "${params.missionId}". Use list_missions to see ids.` }] };
			if (matches.length > 1) {
				return { content: [{ type: "text", text: `"${params.missionId}" matches ${matches.length} missions: ${matches.map((m) => m.id).join(", ")}. Be more specific.` }] };
			}
			const r = matches[0];
			if (!r) return { content: [{ type: "text", text: `No mission matching "${params.missionId}".` }] };
			if (!r.done) return { content: [{ type: "text", text: `Mission ${r.id} is still ${r.status}. Wait for it to finish before merging.` }] };

			const branch = `missions/${r.id}`;
			const res = mergeBranch(r.repo, branch);
			if (!res.ok) {
				// Report git's own words. The usual cause is uncommitted local changes to a file the
				// branch also touched, which the user must resolve — not something to dispatch an agent at.
				return { content: [{ type: "text", text: `Merge of ${branch} into ${r.repoName} FAILED.\n\n${res.out.slice(0, 600)}\n\nNothing was changed. Resolve this in the repo, then ask me again.` }] };
			}
			const wt = r.worktreePath ? reclaimWorktree(r.repo, r.worktreePath, "merged") : { bytes: 0 };
			reclaimBranch(r.repo, branch);
			updateActive(r.id, { cleared: true, status: "merged" });
			return { content: [{ type: "text", text: `Merged ${branch} → ${r.repoName}${wt.bytes ? ` (${Math.round(wt.bytes / 1e6)}MB reclaimed)` : ""}. Worktree removed, branch deleted.` }] };
		},
	} as unknown as AgentTool;

	const resumeTool = {
		name: "resume_mission",
		label: "resume",
		description:
			"Re-validate a finished mission in its existing worktree and continue it. Use when a mission stalled or hit its milestone ceiling and the blocking condition has since been resolved — " +
			"you fixed and committed something on its branch, or the operator answered the question it was stuck on. " +
			"Do NOT call it on a mission nothing has changed about: re-validating an unchanged tree costs money and returns the same red. " +
			"Returns the scorecard before and after, and the new verdict.",
		parameters: Type.Object({
			missionId: Type.String({ description: "The mission id, or enough of its prefix to be unambiguous." }),
			maxMilestones: Type.Optional(Type.Number({ description: "Raise the milestone ceiling. Defaults to current + 3." })),
		}),
		async execute(_id: string, params: { missionId: string; maxMilestones?: number }) {
			const matches = readActive().filter((r) => r.id === params.missionId || r.id.startsWith(params.missionId));
			if (!matches.length) return { content: [{ type: "text", text: `No mission matching "${params.missionId}". Use list_missions to see ids.` }] };
			if (matches.length > 1) {
				return { content: [{ type: "text", text: `"${params.missionId}" matches ${matches.length} missions: ${matches.map((m) => m.id).join(", ")}. Be more specific.` }] };
			}
			const r = matches[0];
			if (!r?.outDir) return { content: [{ type: "text", text: `Mission ${r?.id ?? params.missionId} has no recorded output directory, so there is nothing to resume from.` }] };
			if (!r.done) return { content: [{ type: "text", text: `Mission ${r.id} is still ${r.status}. Resuming a live mission is refused — wait for it to finish.` }] };

			const before = r.costUsd ? `$${r.costUsd.toFixed(2)} spent` : "no spend recorded";
			try {
				// No budget passed: uncapped, and recorded. The ceiling is milestones, not dollars.
				const state = await resumeMission(r.outDir, { maxMilestones: params.maxMilestones });
				const sc = state.scoreCard;
				const after = sc ? `${sc.assertionsPassed}/${sc.assertionsTotal} assertions, ${sc.bugs.length} bug(s)` : "no scorecard";
				return {
					content: [
						{
							type: "text",
							text: `Resumed ${r.id} (${r.repoName}). Before: ${before}. After: ${after}, verdict ${state.finalVerdict ?? "unknown"}, $${(state.costUsd ?? 0).toFixed(2)} total.`,
						},
					],
				};
			} catch (err) {
				// A refusal is a real answer — report it verbatim rather than a hopeful summary.
				return { content: [{ type: "text", text: `Could not resume ${r.id}: ${err instanceof Error ? err.message : String(err)}` }] };
			}
		},
	} as unknown as AgentTool;

	const boardTool = {
		name: "board_hint",
		label: "board",
		description: "Tell the user how to open the live mission-control board. Use when they ask to 'see the board' or a live view.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "The board is the right-hand pane — Tab to focus it. It shows every repo: ↑↓ to select, ⏎ to open the report, a to merge." }] };
		},
	} as unknown as AgentTool;

	// Direct filesystem tools follow the focus repo; everything else takes a repo argument.
	//
	// bash/write/edit, not just read. The chief was read-only, which made it unable to do the
	// setup work that has to happen BEFORE there is anything to dispatch a mission at: create a
	// directory, `git init`, scaffold, install dependencies, make the first commit. It would
	// correctly explain that it could not, which is not what a chief of staff is for.
	//
	// `cwd` here is the base for RELATIVE paths only — it is not a jail. Absolute paths resolve
	// anywhere, and bash can cd. That is deliberate: the reach is the whole disk, as the user's
	// own account. Treat every one of these as the user typing it into their own terminal.
	const cwd = focus();
	return [
		...createReadOnlyTools(cwd),
		createBashTool(cwd),
		createWriteTool(cwd),
		createEditTool(cwd),
		runMissionTool,
		acceptTool,
		resumeTool,
		listTool,
		workspacesTool,
		investigateTool,
		gcTool,
		boardTool,
	];
}

export interface ChiefSession {
	/** Feed a user line to the chief. */
	input(text: string): void;
	/** Point the chief at the repo a terminal is attached from. */
	setFocus(cwd: string): void;
	/**
	 * Show something to whoever is attached, without asking the chief to reply.
	 *
	 * A standing order's report is not a turn of conversation — it should appear
	 * on your screen and cost nothing. Routing it through `input` would make the
	 * chief answer its own scheduler.
	 */
	notify(text: string): void;
	/** Start a mission the way the chief would, so the cap is shared with human-dispatched work. */
	dispatchMission(repo: string, goal: string, rfc?: string): void;
	/** Register an output listener (raw text incl. ANSI). Returns an unsubscribe fn. */
	subscribe(cb: (text: string) => void): () => void;
	/** The intro banner. */
	greeting(): string;
	/** Number of missions currently running. */
	activeMissions(): number;
	close(): void;
}

/** Create the chief-of-staff brain, decoupled from any specific terminal. The daemon and the local REPL both drive this. */
export function createChiefSession(homeCwd: string): ChiefSession {
	const spec = autoRouting().orchestrator;
	const model = getModel(spec.provider, spec.modelId);
	if (!model) throw new Error(`Chief model not found: ${spec.provider}/${spec.modelId}`);

	registerWorkspace(homeCwd);
	let focus = homeCwd;
	// Published at startup as well as on every move: a console that has never seen a focus
	// change still needs to know where the chief is pointed.
	publishFocus(focus);
	/** Set when focus moved since the last thing the user said, so the chief is told exactly once. */
	let focusAnnounced = true;

	const listeners = new Set<(text: string) => void>();
	const emit = (text: string): void => {
		for (const l of listeners) l(text);
	};

	let runnerRef: MissionRunner;
	const agent = new Agent({
		// Thinking on. The chief now scaffolds repos, runs builds and reads failures — the work a
		// pi session does, which a pi session does with thinking available. "off" was right when it
		// only routed requests to other agents.
		initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "medium", tools: buildTools(() => focus, () => runnerRef) },
		streamFn,
		getApiKey: (provider) => getEnvApiKey(provider),
	});

	let busy = false;
	async function runTurn(msg: AgentMessage): Promise<void> {
		busy = true;
		try {
			await agent.prompt(msg);
			await agent.waitForIdle();
		} catch (err) {
			emit(chalk.red(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`));
		} finally {
			busy = false;
		}
	}
	function send(text: string): void {
		// A focus change is context, not a turn of its own — it rides along with the
		// next thing the user actually says, where it is read rather than answered.
		const body = focusAnnounced ? text : `[context] The user is now attached from the repo "${basename(focus)}" (${focus}). Default to it unless they name another.\n\n${text}`;
		focusAnnounced = true;
		if (busy || agent.state.isStreaming) {
			agent.followUp(userMsg(body));
			emit(chalk.dim("  (queued — chief is working)\n"));
		} else {
			void runTurn(userMsg(body));
		}
	}
	runnerRef = new MissionRunner(send, emit);

	// Stream the reply as it is generated. Waiting for message_end meant a reply
	// landed as one block after several seconds of a still screen, which reads as
	// a hang — the one thing a chat pane must never do.
	let midLine = false;
	const endLine = (): void => {
		if (midLine) {
			emit("\n");
			midLine = false;
		}
	};
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_update") {
			const ev = event.assistantMessageEvent as { type: string; delta?: string };
			if (ev.type === "text_start") {
				emit(`\n${chalk.bold.cyan("chief")} `);
				midLine = true;
			} else if (ev.type === "text_delta" && ev.delta) {
				emit(ev.delta);
				midLine = true;
			} else if (ev.type === "text_end") {
				endLine();
			}
		} else if (event.type === "tool_execution_start") {
			endLine();
			emit(chalk.dim(`  · ${event.toolName}\n`));
		} else if (event.type === "message_end") {
			// Belt and braces: an aborted stream never emits text_end.
			endLine();
		}
	});

	return {
		input(text: string) {
			const t = text.trim();
			if (t) send(t);
		},
		setFocus(cwd: string) {
			const full = resolve(cwd);
			if (full === focus) return;
			focus = full;
			focusAnnounced = false;
			registerWorkspace(full);
			publishFocus(full);
			// Read tools are bound to a cwd at construction, so they are rebuilt to follow.
			agent.state.tools = buildTools(() => focus, () => runnerRef);
			emit(chalk.dim(`  · focus → ${basename(full)}\n`));
		},
		notify(text: string) {
			emit(`\n${chalk.dim(text.replace(/\n?$/, "\n"))}`);
		},
		dispatchMission(repo: string, goal: string, rfc?: string) {
			registerWorkspace(repo);
			runnerRef.enqueue({ repo, goal, rfc: rfc ?? "", maxFeatures: 1 });
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		/**
		 * Printed on every attach — so it answers rather than instructs.
		 *
		 * The second line used to read "Talk to me. Name any repo and I'll work there. Missions
		 * run in the background. 'what's going on?' · Ctrl-C detaches." That is a tutorial, shown
		 * every time to the person who wrote the thing, and it teaches nothing after the first
		 * day. Worse, it invited a question — "what's going on?" — whose answer we already have
		 * in hand, so it spent two lines asking you to ask for something it could simply say.
		 * The detach hint was redundant on top of that: the status bar carries it permanently.
		 *
		 * The hint survives in the one situation where it is not noise — an empty org, which is
		 * both the state with nothing to report and, necessarily, the state a new user is in.
		 */
		greeting() {
			const others = listWorkspaces().filter((w) => w.path !== focus).length;
			const head =
				`${chalk.bold("☀  missions")} — chief of staff, focused on ${chalk.dim(basename(focus))}` +
				(others ? chalk.dim(` (+${others} other repo${others === 1 ? "" : "s"})`) : "");

			const all = readActive();
			// Genuinely in flight — see isLive. `!done` is a different and much weaker claim: a
			// mission killed mid-run never writes a terminal status and would be counted as
			// running forever.
			const running = all.filter((r) => isLive(r)).length;
			const stalled = all.filter((r) => isStalled(r)).length;
			// Finished, not yet actioned, and did not come back clean: the only queue that is
			// actually waiting on a human.
			const needsYou = all.filter((r) => r.done && !r.cleared && r.outcome !== "clean").length;
			const today = new Date().toISOString().slice(0, 10);
			const spend = all.filter((r) => (r.updatedAt ?? "").startsWith(today)).reduce((n, r) => n + (r.costUsd ?? 0), 0);

			if (!all.length) {
				return `${head}\n${chalk.dim("Nothing running. Name a repo and a goal, and I'll start a mission there.\n")}`;
			}

			const parts = [
				running ? `${running} running` : null,
				// Amber: the two parts of this line that want a decision from you. A stalled
				// mission is not merely absent from the board, it is holding a worktree and a
				// branch, so it is worth naming rather than quietly not counting.
				needsYou ? chalk.yellow(`${needsYou} need${needsYou === 1 ? "s" : ""} you`) : null,
				stalled ? chalk.yellow(`${stalled} stalled`) : null,
				spend > 0.005 ? `$${spend.toFixed(2)} today` : null,
			].filter(Boolean);
			// Everything on the board is finished and actioned — say so rather than printing an
			// empty line, which reads as a bug.
			return `${head}\n${chalk.dim(parts.length ? parts.join(" · ") : "All quiet — nothing running, nothing waiting on you.")}\n`;
		},
		activeMissions() {
			return runnerRef.activeCount;
		},
		close() {
			agent.abort();
			listeners.clear();
		},
	};
}

/** Local (no-daemon) REPL — wires a session straight to this terminal. Kept as a fallback. */
export async function runChief(targetCwd: string): Promise<void> {
	const session = createChiefSession(targetCwd);
	const unsub = session.subscribe((t) => process.stdout.write(t));
	process.stdout.write(session.greeting());
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	try {
		for (;;) {
			if (closed) break;
			let line: string;
			try {
				line = (await rl.question(`\n${chalk.bold("you ›")} `)).trim();
			} catch {
				break;
			}
			if (!line) continue;
			if (["exit", "quit", ":q"].includes(line.toLowerCase())) break;
			session.input(line);
		}
	} finally {
		unsub();
		session.close();
		rl.close();
	}
}
