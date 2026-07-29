/**
 * Per-mission overseer agent: a chief-agent instance scoped to a single mission.
 *
 * Reuses the chief agent construction path (createChiefSession) but injects
 * mission state + recent log + diff summary as context, and persists chat
 * history to <outDir>/chat.jsonl (append-only, one JSON object per line).
 *
 * History is loaded when the view opens so the conversation is resumed across
 * multiple view sessions.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createBashTool, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { basename } from "node:path";
import chalk from "chalk";
import { Agent, getEnvApiKey, getModel, streamFn, Type, type AgentEvent, type AgentMessage, type AgentTool } from "./pi.js";
import { autoRouting } from "./models.js";
import { StateStore } from "./state.js";
import type { MissionState } from "./types.js";
import { workerClient } from "./workers.js";

// ---------------------------------------------------------------------------
// Chat history persistence
// ---------------------------------------------------------------------------

export interface ChatHistoryEntry {
	role: "user" | "overseer";
	text: string;
	at: string;
}

/** Path to the chat history file for a given outDir. */
export function chatHistoryPath(outDir: string): string {
	return join(outDir, "chat.jsonl");
}

/** Load existing chat history from <outDir>/chat.jsonl. Returns [] if file absent or corrupt. */
export function loadChatHistory(outDir: string): ChatHistoryEntry[] {
	const p = chatHistoryPath(outDir);
	if (!existsSync(p)) return [];
	const entries: ChatHistoryEntry[] = [];
	for (const line of readFileSync(p, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as ChatHistoryEntry);
		} catch {
			/* skip malformed lines */
		}
	}
	return entries;
}

/** Append one chat entry to <outDir>/chat.jsonl (never rewrites the file). */
export function appendChatEntry(outDir: string, entry: ChatHistoryEntry): void {
	appendFileSync(chatHistoryPath(outDir), `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Overseer agent construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(state: MissionState, recentLog: string[]): string {
	const logSnippet = recentLog.slice(-30).join("\n");
	const features = state.features.map((f) => `  - [${f.id}] ${f.title}`).join("\n") || "  (none yet)";
	const milestones = state.milestones
		.map((m) => `  Milestone ${m.index}: ${m.verdict} — ${m.scoreCard.assertionsPassed}/${m.scoreCard.assertionsTotal} assertions`)
		.join("\n") || "  (none yet)";

	return `You are the OVERSEER of a single coding mission. You watch the workers doing the work, and
you can reach them while they run: question them, and redirect them.

The state below is a SNAPSHOT from when this session opened. The mission moves on without you, so
call mission_status before answering anything that depends on where things stand — a confident
answer from stale state is worse than saying you will check.

MISSION: ${state.goal}
STATUS: ${state.status}${state.outcome ? ` / ${state.outcome}` : ""}
STARTED: ${state.startedAt}
BRANCH: ${state.branch}
REPO: ${state.targetCwd}
${state.reportPath ? `REPORT: ${state.reportPath}` : ""}

FEATURES DISPATCHED:
${features}

MILESTONES:
${milestones}

COST SO FAR: $${state.costUsd.toFixed(3)}

RECENT LOG (last 30 lines):
${logSnippet || "(empty)"}

HOW TO WORK

Look before you judge. A worker mid-task usually understands its task better than you do — you are
seeing a slice. Before forming a view: mission_status for where things stand, worker_tail for what
it just said, worker_diff for what it has actually written. What a worker SAYS and what it has DONE
diverge, and the diff is the honest one.

Ask before you steer. ask_worker reaches a running worker without redirecting it — it answers at its
next turn and carries on. Most of the time "why are you doing it that way?" resolves the concern, and
you have cost nothing.

STEER SPARINGLY. steer_worker overrides a worker's current approach. It is the right call when:
- it is solving the wrong problem — the bug is somewhere it is not looking, or it is fixing the
  harness rather than the repo it was given
- it is about to do something expensive or destructive: a schema change, a paid API in a loop, an
  install that mutates a shared tree
- it is stuck repeating an approach that has already failed
- it is missing something you can see and it cannot, from the diff or the mission state

Do NOT steer because you would have done it differently, because it is slower than you expected, or
because its style differs from yours. An unnecessary steer costs a turn, breaks its train of thought,
and lands in the permanent record of the mission. When you are unsure, ask instead — or say nothing.

Every steer is written into the worker's handoff. Make each one specific enough that someone reading
that record later understands what changed and why.

ANSWERING
- Be concise and direct. The human can see the board and timeline alongside this chat.
- Cite specifics: assertion ids, feature ids, milestone verdicts, file paths.
- If asked what to do next, give a recommendation rather than a menu.
- Say plainly when something is unknown or unproven. A green assertion that only greps for a string
  has proven nothing, and it is your job to notice that rather than repeat the score.`;
}

export interface OverseerSession {
	/** Send a user message and get a streamed response. */
	input(text: string): void;
	/**
	 * Ask one question and wait for the whole answer.
	 *
	 * `input` is built for a terminal that is already watching the stream. An HTTP request is
	 * not: it needs to know when the turn is over and what was said. Both persist to the same
	 * chat.jsonl, so a question asked from the console shows up in the TUI and vice versa —
	 * one conversation about a mission, not one per surface.
	 */
	ask(text: string): Promise<string>;
	/** Subscribe to streamed output text. Returns unsubscribe fn. */
	subscribe(cb: (text: string) => void): () => void;
	/** Load previous history as a rendered transcript string. */
	historyTranscript(): string;
	close(): void;
}

/**
 * Tools that let the overseer reach the mission's LIVE workers.
 *
 * Without these the overseer is a commentator: it reads state and log and talks about them. With
 * them it can question a worker that is mid-task and redirect one that is going wrong — which is
 * the difference between watching a factory and running one. Everything goes over the mission
 * process's socket, because the view is a separate process from the runner.
 */
function workerTools(missionId: string, outDir: string): AgentTool[] {
	const client = workerClient(missionId);
	const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });

	const listTool = {
		name: "list_workers",
		label: "workers",
		description:
			"List the workers running RIGHT NOW in this mission: id, what they were given, how long they have been going, spend, and their last action. " +
			"Empty means nothing is in flight — the mission is planning, validating, or finished.",
		parameters: Type.Object({}),
		async execute() {
			const live = await client.list();
			if (Array.isArray(live) && live.length === 0) return text("No workers are running right now.");
			return text(live);
		},
	} as unknown as AgentTool;

	const tailTool = {
		name: "worker_tail",
		label: "tail",
		description: "The last few things a running worker said. Use it to see what one is actually doing before judging it.",
		parameters: Type.Object({ id: Type.String({ description: "Worker id from list_workers." }) }),
		async execute(_id: string, p: { id: string }) {
			return text(await client.tail(p.id));
		},
	} as unknown as AgentTool;

	const askTool = {
		name: "ask_worker",
		label: "ask",
		description:
			"Ask a RUNNING worker a question and wait for its answer. It replies at its next turn boundary and then carries on — this does not interrupt or redirect it. " +
			"Use it to find out why it is doing something before deciding whether to steer it. May take a minute if it is mid tool call.",
		parameters: Type.Object({
			id: Type.String({ description: "Worker id from list_workers." }),
			question: Type.String({ description: "One specific question." }),
		}),
		async execute(_id: string, p: { id: string; question: string }) {
			const r = await client.ask(p.id, p.question);
			return text(r.detail);
		},
	} as unknown as AgentTool;

	const steerTool = {
		name: "steer_worker",
		label: "steer",
		description:
			"Redirect a RUNNING worker. The instruction is injected at its next turn boundary and explicitly supersedes its current approach; it is not aborted, so it keeps everything it has worked out so far. " +
			"Use this when a worker is going the wrong way — the alternative is letting it finish, letting validators fail, and paying for a correction round. " +
			"Steers are recorded in the worker's handoff, so be specific enough that the record makes sense later.",
		parameters: Type.Object({
			id: Type.String({ description: "Worker id from list_workers." }),
			instruction: Type.String({ description: "What to do differently, and briefly why." }),
		}),
		async execute(_id: string, p: { id: string; instruction: string }) {
			const r = await client.steer(p.id, p.instruction);
			return text(r.detail);
		},
	} as unknown as AgentTool;

	const statusTool = {
		name: "mission_status",
		label: "status",
		description:
			"Read the mission's state fresh from disk: status, milestone, cost, every assertion with its current verdict and evidence, bugs, and the recent log. " +
			"Your system prompt is a snapshot from when this session opened — use this whenever the answer depends on where things actually stand now.",
		parameters: Type.Object({}),
		async execute() {
			const store = StateStore.load(outDir);
			if (!store) return text("mission state is unreadable");
			const st = store.state;
			const sc = st.scoreCard;
			return text({
				status: st.status,
				outcome: st.outcome ?? null,
				verdict: st.finalVerdict ?? null,
				milestone: st.milestones.length,
				costUsd: Number(st.costUsd.toFixed(3)),
				commits: st.commits.map((c) => `${c.sha.slice(0, 8)} ${c.message}`),
				assertions: (st.plan?.contract.assertions ?? []).map((a) => ({
					id: a.id,
					passed: a.passed ?? null,
					strength: a.strength ?? null,
					addedAtMilestone: a.addedAtMilestone ?? null,
					statement: a.statement.slice(0, 140),
					evidence: (a.evidence ?? "").slice(0, 160),
				})),
				bugs: (sc?.bugs ?? []).map((b) => `[${b.severity}] ${b.summary}`),
				openIssues: st.handoffs.flatMap((h) => h.issues.filter((i) => !i.disposition).map((i) => i.summary)),
				recentLog: st.log.slice(-25),
			});
		},
	} as unknown as AgentTool;

	const diffTool = {
		name: "worker_diff",
		label: "diff",
		description:
			"What the mission has actually written in its worktree, including uncommitted work in progress. " +
			"This is the ground truth — what a worker SAYS it is doing and what the diff shows often differ, and the diff is the honest one.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Limit to a path, e.g. src/validators. Omit for everything." })),
			statOnly: Type.Optional(Type.Boolean({ description: "Just the file list and line counts. Start here on a big change." })),
		}),
		async execute(_id: string, p: { path?: string; statOnly?: boolean }) {
			const store = StateStore.load(outDir);
			const wt = store?.state.worktreePath;
			if (!wt || !existsSync(wt)) return text("no worktree — the mission may have finished and been reclaimed");
			const args = ["diff", store.state.baseSha ?? "HEAD", ...(p.statOnly ? ["--stat"] : []), "--", p.path ?? "."];
			try {
				const out = execFileSync("git", args, { cwd: wt, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
				return text(out.slice(0, 12000) || "(no changes yet)");
			} catch (err) {
				return text(`could not read the diff: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	} as unknown as AgentTool;

	return [statusTool, listTool, tailTool, diffTool, askTool, steerTool];
}

export interface OverseerOptions {
	/**
	 * Replay prior chat.jsonl turns into the agent before the first message.
	 *
	 * A long-lived TUI session keeps its own context, so it does not need this. An HTTP handler
	 * builds a session per request and would otherwise answer "and why is that?" with no idea
	 * what "that" was. Capped, because the whole point of a per-request session is that it stays
	 * cheap.
	 */
	seedHistory?: number;
}

/** Create a per-mission overseer agent, reusing chief agent machinery. */
export function createOverseerSession(outDir: string, options: OverseerOptions = {}): OverseerSession | null {
	const store = StateStore.load(outDir);
	if (!store) return null;
	const { state } = store;

	const spec = autoRouting().orchestrator;
	const model = getModel(spec.provider, spec.modelId);
	if (!model) return null;

	const recentLog = state.log.slice(-30);
	const systemPrompt = buildSystemPrompt(state, recentLog);

	const listeners = new Set<(text: string) => void>();
	const emit = (text: string): void => {
		for (const l of listeners) l(text);
	};

	/**
	 * Read and run, in the worktree if it is still there and the target repo once it is not.
	 *
	 * Returns nothing at all only when neither path exists, which means there is genuinely no
	 * tree to look at — better to have no tool than one pointed at a directory that is gone.
	 */
	function repoTools(worktreePath: string | undefined, targetCwd: string) {
		const cwd = worktreePath && existsSync(worktreePath) ? worktreePath : targetCwd;
		if (!cwd || !existsSync(cwd)) return [];
		return [...createReadOnlyTools(cwd), createBashTool(cwd)];
	}

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			// Repo tools too: judging whether a worker's approach is sane needs the codebase, not
			// just the mission's own paperwork.
			//
			// bash, specifically. Without it the overseer could read source and infer, but could
			// not answer the questions actually asked of it — has this moved on, does the test
			// pass now, what does git log say, did that fix land. Asked any of those it replied
			// that it could not, which is the correct answer for a thing with no way to run
			// anything and a useless one to receive. A command's output is evidence; a reading of
			// the source is an inference.
			//
			// Read and run, never edit or write: the worker owns the tree and every commit in it,
			// and the overseer's job is to observe and — through ask_worker / steer_worker — to
			// ask. An overseer that edits is a second writer on a tree it does not own.
			//
			// Falls back to the target repo once the worktree is reclaimed. A finished mission is
			// exactly when someone opens the overseer to ask what happened, and pointing it at
			// nothing made it blind at that moment.
			tools: [...workerTools(state.id, outDir), ...repoTools(state.worktreePath, state.targetCwd)],
		},
		streamFn,
		getApiKey: (provider) => getEnvApiKey(provider),
	});

	// Replay prior turns so a per-request session is not amnesiac. Done by assigning messages
	// directly rather than re-prompting: re-prompting would pay for the model to answer every
	// historical question again.
	if (options.seedHistory && options.seedHistory > 0) {
		const prior = loadChatHistory(outDir).slice(-options.seedHistory);
		if (prior.length) {
			agent.state.messages = prior.map(
				(e) =>
					({
						role: e.role === "user" ? "user" : "assistant",
						content: [{ type: "text", text: e.text }],
						timestamp: Date.parse(e.at) || Date.now(),
					}) as AgentMessage,
			);
		}
	}

	let busy = false;

	async function runTurn(msg: AgentMessage): Promise<void> {
		busy = true;
		try {
			await agent.prompt(msg);
			await agent.waitForIdle();
		} catch (err) {
			emit(chalk.red(`\n  overseer error: ${err instanceof Error ? err.message : String(err)}\n`));
		} finally {
			busy = false;
		}
	}

	// Stream output live as it is generated
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
				emit(`\n${chalk.bold.yellow("overseer")} `);
				midLine = true;
			} else if (ev.type === "text_delta" && ev.delta) {
				emit(ev.delta);
				midLine = true;
			} else if (ev.type === "text_end") {
				endLine();
			}
		} else if (event.type === "message_end") {
			endLine();
		}
	});

	return {
		input(text: string) {
			const t = text.trim();
			if (!t) return;
			// Persist user message
			appendChatEntry(outDir, { role: "user", text: t, at: new Date().toISOString() });
			// Wrap response so we can capture it for persistence
			const responseChunks: string[] = [];
			const captureSub = (): (() => void) => {
				const cb = (chunk: string): void => {
					responseChunks.push(chunk);
				};
				listeners.add(cb);
				return () => listeners.delete(cb);
			};
			const unsub = captureSub();
			const msg: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: t }],
				timestamp: Date.now(),
			} as AgentMessage;
			if (busy || agent.state.isStreaming) {
				agent.followUp(msg);
				emit(chalk.dim("  (queued — overseer is working)\n"));
			} else {
				void runTurn(msg).then(() => {
					unsub();
					// Persist overseer response
					const full = responseChunks.join("");
					// Strip ANSI codes for persistence
					const clean = full.replace(/\x1b\[[0-9;]*m/g, "").trim();
					if (clean) {
						appendChatEntry(outDir, { role: "overseer", text: clean, at: new Date().toISOString() });
					}
				});
			}
		},
		async ask(text: string): Promise<string> {
			const t = text.trim();
			if (!t) return "";
			appendChatEntry(outDir, { role: "user", text: t, at: new Date().toISOString() });
			const chunks: string[] = [];
			const cb = (chunk: string): void => {
				chunks.push(chunk);
			};
			listeners.add(cb);
			try {
				await runTurn({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() } as AgentMessage);
			} finally {
				listeners.delete(cb);
			}
			// The stream is written for a terminal, so it carries colour codes and the speaker
			// label the caller already renders itself.
			const answer = chunks
				.join("")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/^\s*overseer\s*/, "")
				.trim();
			if (answer) appendChatEntry(outDir, { role: "overseer", text: answer, at: new Date().toISOString() });
			return answer;
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		historyTranscript() {
			const history = loadChatHistory(outDir);
			if (!history.length) return "";
			return history
				.map((e) => {
					const who = e.role === "user" ? chalk.bold("you ›") : chalk.bold.yellow("overseer");
					return `\n${who} ${e.text}`;
				})
				.join("\n");
		},
		close() {
			agent.abort();
			listeners.clear();
		},
	};
}
