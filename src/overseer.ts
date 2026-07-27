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
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

	return `You are an OVERSEER for a single coding mission. Your job is to answer questions about this specific mission, explain what happened, and help the human decide what to do next.

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

Guidelines:
- Answer questions about this mission only; do not dispatch new missions or modify anything.
- Be concise and direct; the human can see the board and timeline alongside this chat.
- If asked what to do next, summarise the key findings and give a clear recommendation.
- Reference specific assertion ids, feature ids, or milestone verdicts when relevant.`;
}

export interface OverseerSession {
	/** Send a user message and get a streamed response. */
	input(text: string): void;
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
function workerTools(missionId: string): AgentTool[] {
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

	return [listTool, tailTool, askTool, steerTool];
}

/** Create a per-mission overseer agent, reusing chief agent machinery. */
export function createOverseerSession(outDir: string): OverseerSession | null {
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

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools: workerTools(state.id),
		},
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
