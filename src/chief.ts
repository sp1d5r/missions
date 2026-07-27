import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Agent, getEnvApiKey, getModel, streamFn, type AgentEvent, type AgentMessage, type AgentTool, type AssistantMessage } from "./pi.js";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Type } from "typebox";
import chalk from "chalk";
import { cmuxOpenBrowser, cmuxOpenDiff, hasCmuxPassword, insideCmux } from "./cmux.js";
import { loadMissions } from "./dashboard.js";
import { runMission } from "./mission.js";
import { autoRouting } from "./models.js";
import type { MissionConfig } from "./types.js";

const SYSTEM_PROMPT = `You are the CHIEF OF STAFF for a solo founder-engineer. You run an org of coding agents against the current repository.
The user talks to you casually — never interrogate them with a form or a list of questions.

How to behave:
- Infer intent. Propose a crisp plan in 1-2 lines. When the ask is clear, call run_mission to dispatch a worker — it runs in the BACKGROUND, so say you've kicked it off and keep talking.
- Missions run in PARALLEL, each in its own git worktree (a few at once). You can dispatch several different pieces of work concurrently (e.g. script-gen, video-gen, captions).
- Ask a clarifying question ONLY when you truly cannot proceed. One question, never a checklist.
- You can read the repo (read-only tools) to ground yourself and answer "what should I work on".
- Keep every reply short and skimmable. No walls of text.
- When a mission finishes you'll get a "[mission-complete]" note — relay the result to the user in 2-3 lines and remind them the review opened in cmux.
- Use open_dashboard when they want to see everything at once.

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

/** Parallel background mission runner: each mission runs in its own worktree; keeps the chat responsive. */
class MissionRunner {
	private queue: Array<{ goal: string; rfc: string; maxFeatures: number }> = [];
	private active = 0;
	private readonly cap = 3;
	private readonly cwd: string;
	private readonly notify: (text: string) => void;
	private readonly log: (text: string) => void;
	constructor(cwd: string, notify: (text: string) => void, log: (text: string) => void) {
		this.cwd = cwd;
		this.notify = notify;
		this.log = log;
	}

	get activeCount(): number {
		return this.active;
	}

	enqueue(job: { goal: string; rfc: string; maxFeatures: number }): { startedNow: boolean; active: number } {
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

	private async runOne(job: { goal: string; rfc: string; maxFeatures: number }): Promise<void> {
		const config = configFor(this.cwd, job.goal, job.rfc, job.maxFeatures);
		const tag = job.goal.length > 24 ? `${job.goal.slice(0, 24)}…` : job.goal;
		this.log(chalk.dim(`\n  ▶ mission started: ${job.goal}\n`));
		try {
			const state = await runMission(config, (e) => {
				if (e.type === "status") this.log(chalk.dim(`  ▸ [${tag}] ${e.status}\n`));
				else if (e.type === "log" && /committed|validated|report →|worktree |budget|FAILED/.test(e.message))
					this.log(chalk.dim(`  · [${tag}] ${e.message}\n`));
			});
			const sc = state.scoreCard;
			const review = reviewInCmux(state.worktreePath ?? this.cwd, state.reportPath, state.baseSha);
			this.notify(
				`[mission-complete] "${job.goal}" → ${state.status}; ` +
					`${sc ? `${sc.assertionsPassed}/${sc.assertionsTotal} assertions, ${sc.bugs.length} bug(s)` : "no scorecard"}; ` +
					`$${state.costUsd.toFixed(3)}.${review}`,
			);
		} catch (err) {
			this.notify(`[mission-complete] "${job.goal}" FAILED: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

function buildTools(targetCwd: string, runner: () => MissionRunner): AgentTool[] {
	const runMissionTool = {
		name: "run_mission",
		label: "run mission",
		description: "Dispatch a coding worker (runs in the background, in its own worktree) to make + validate a change. Use once the goal is clear.",
		parameters: Type.Object({
			goal: Type.String({ description: "One-line goal." }),
			rfc: Type.Optional(Type.String({ description: "Optional detail: what's wrong / what you want." })),
			maxFeatures: Type.Optional(Type.Number({ description: "Features this run (default 1)." })),
		}),
		async execute(_id: string, params: { goal: string; rfc?: string; maxFeatures?: number }) {
			const { startedNow, active } = runner().enqueue({ goal: params.goal, rfc: params.rfc ?? "", maxFeatures: params.maxFeatures ?? 1 });
			const text = startedNow
				? `Started "${params.goal}" in its own worktree (${active} running). I'll report when it's done — keep talking or dispatch more.`
				: `Queued "${params.goal}" — ${active} already running (cap 3); it'll start as a slot frees.`;
			return { content: [{ type: "text", text }] };
		},
	} as unknown as AgentTool;

	const listTool = {
		name: "list_missions",
		label: "list missions",
		description: "List recent missions and their status in this repo.",
		parameters: Type.Object({}),
		async execute() {
			const missions = loadMissions(targetCwd).slice(0, 10);
			if (!missions.length) return { content: [{ type: "text", text: "No missions yet." }] };
			const text = missions
				.map((m) => `- [${m.status}] ${m.goal} (${m.scoreCard ? `${m.scoreCard.assertionsPassed}/${m.scoreCard.assertionsTotal}` : "—"}, $${m.costUsd.toFixed(2)})`)
				.join("\n");
			return { content: [{ type: "text", text }] };
		},
	} as unknown as AgentTool;

	const boardTool = {
		name: "board_hint",
		label: "board",
		description: "Tell the user how to open the live mission-control board. Use when they ask to 'see the board' or a live view.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "Run `missions board` in a terminal tab for the live TUI — every running mission, what it's doing now, ↑↓ to select, ⏎ to jump into its worktree." }] };
		},
	} as unknown as AgentTool;

	return [...createReadOnlyTools(targetCwd), runMissionTool, listTool, boardTool];
}

export interface ChiefSession {
	/** Feed a user line to the chief. */
	input(text: string): void;
	/** Register an output listener (raw text incl. ANSI). Returns an unsubscribe fn. */
	subscribe(cb: (text: string) => void): () => void;
	/** The intro banner. */
	greeting(): string;
	/** Number of missions currently running. */
	activeMissions(): number;
	close(): void;
}

/** Create the chief-of-staff brain, decoupled from any specific terminal. The daemon and the local REPL both drive this. */
export function createChiefSession(targetCwd: string): ChiefSession {
	const spec = autoRouting().orchestrator;
	const model = getModel(spec.provider, spec.modelId);
	if (!model) throw new Error(`Chief model not found: ${spec.provider}/${spec.modelId}`);

	const listeners = new Set<(text: string) => void>();
	const emit = (text: string): void => {
		for (const l of listeners) l(text);
	};

	let runnerRef: MissionRunner;
	const agent = new Agent({
		initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "off", tools: buildTools(targetCwd, () => runnerRef) },
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
		if (busy || agent.state.isStreaming) {
			agent.followUp(userMsg(text));
			emit(chalk.dim("  (queued — chief is working)\n"));
		} else {
			void runTurn(userMsg(text));
		}
	}
	runnerRef = new MissionRunner(targetCwd, send, emit);

	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			const parts = msg.content as Array<{ type: string; text?: string }>;
			const text = parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
			if (text) emit(`\n${chalk.bold.cyan("chief")} ${text}\n`);
		} else if (event.type === "tool_execution_start") {
			emit(chalk.dim(`  · ${event.toolName}\n`));
		}
	});

	return {
		input(text: string) {
			const t = text.trim();
			if (t) send(t);
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		greeting() {
			return (
				`${chalk.bold("☀  missions")} — chief of staff for ${chalk.dim(targetCwd)}\n` +
				chalk.dim(`Talk to me. Missions run in the background (persist across tabs). "dashboard" · "what's going on?" · Ctrl-D detaches.\n`)
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
