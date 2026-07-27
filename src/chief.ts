import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Agent, getEnvApiKey, getModel, streamFn, type AgentEvent, type AgentMessage, type AgentTool } from "./pi.js";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Type } from "typebox";
import chalk from "chalk";
import { cmuxOpenBrowser, cmuxOpenDiff, hasCmuxPassword, insideCmux } from "./cmux.js";
import { mergeBranch } from "./git.js";
import { reclaimBranch, reclaimWorktree } from "./lifecycle.js";
import { runMission } from "./mission.js";
import { autoRouting } from "./models.js";
import { readActive, updateActive } from "./registry.js";
import { renderSweep, sweep } from "./lifecycle.js";
import { dispatchScouts, loadAgentSpecs } from "./subagent.js";
import { listWorkspaces, registerWorkspace, resolveWorkspace, workspaceNames } from "./workspaces.js";
import type { MissionConfig } from "./types.js";

const SYSTEM_PROMPT = `You are the CHIEF OF STAFF for a solo founder-engineer. You run an org of coding agents across ALL of their repositories.
The user talks to you casually — never interrogate them with a form or a list of questions.

Workspaces:
- You are NOT limited to one repo. Every tool takes an optional "repo" (a short name like "nadine", or a path). Omit it to use the repo the user is currently attached from.
- Call list_workspaces when you need to know what exists, or when the user names a repo you cannot place.
- Missions in different repos run concurrently and land on their own branches, so "fix X in nadine and Y in missions" is one exchange, not two sessions.

How to behave:
- Infer intent. Propose a crisp plan in 1-2 lines. When the ask is clear, call run_mission to dispatch a worker — it runs in the BACKGROUND, so say you've kicked it off and keep talking.
- Missions run in PARALLEL, each in its own git worktree (a few at once). Dispatch several pieces of work concurrently.
- run_mission is for WRITING CODE. Never dispatch one for a deterministic local operation — merging, cleaning up,
  listing. Those have their own tools (accept_mission, reclaim_disk, list_missions). A worker cannot run git at all,
  so a mission asked to merge will produce a document describing a merge instead of doing one.
- Ask a clarifying question ONLY when you truly cannot proceed. One question, never a checklist. The exception: if you cannot tell WHICH repo the user means, ask — dispatching into the wrong repo is expensive to undo.
- You can read the current repo directly (read/grep/find/ls). For any OTHER repo, use investigate — it sends read-only scouts and returns their answers without filling your context.
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
		budgetUsd: 8,
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

function buildTools(focus: () => string, runner: () => MissionRunner): AgentTool[] {
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

	const boardTool = {
		name: "board_hint",
		label: "board",
		description: "Tell the user how to open the live mission-control board. Use when they ask to 'see the board' or a live view.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "The board is the right-hand pane — Tab to focus it. It shows every repo: ↑↓ to select, ⏎ to open the report, a to merge." }] };
		},
	} as unknown as AgentTool;

	// Direct read tools follow the focus repo; everything else takes a repo argument.
	return [...createReadOnlyTools(focus()), runMissionTool, acceptTool, listTool, workspacesTool, investigateTool, gcTool, boardTool];
}

export interface ChiefSession {
	/** Feed a user line to the chief. */
	input(text: string): void;
	/** Point the chief at the repo a terminal is attached from. */
	setFocus(cwd: string): void;
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
	/** Set when focus moved since the last thing the user said, so the chief is told exactly once. */
	let focusAnnounced = true;

	const listeners = new Set<(text: string) => void>();
	const emit = (text: string): void => {
		for (const l of listeners) l(text);
	};

	let runnerRef: MissionRunner;
	const agent = new Agent({
		initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "off", tools: buildTools(() => focus, () => runnerRef) },
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
			// Read tools are bound to a cwd at construction, so they are rebuilt to follow.
			agent.state.tools = buildTools(() => focus, () => runnerRef);
			emit(chalk.dim(`  · focus → ${basename(full)}\n`));
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		greeting() {
			const others = listWorkspaces().filter((w) => w.path !== focus).length;
			return (
				`${chalk.bold("☀  missions")} — chief of staff, focused on ${chalk.dim(basename(focus))}` +
				(others ? chalk.dim(` (+${others} other repo${others === 1 ? "" : "s"})`) : "") +
				"\n" +
				chalk.dim(`Talk to me. Name any repo and I'll work there. Missions run in the background. "what's going on?" · Ctrl-C detaches.\n`)
			);
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
