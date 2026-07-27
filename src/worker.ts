import { createCodingTools, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentSpec, createDelegateTool } from "./subagent.js";
import { Agent, getEnvApiKey, getModel, streamFn, type AgentEvent, type AgentMessage, type AssistantMessage } from "./pi.js";
import { parseJson } from "./llm.js";
import { registerWorker } from "./workers.js";
import type { Assertion, CommandRecord, Feature, Handoff, HandoffIssue, ModelSpec } from "./types.js";

const SYSTEM_PROMPT = `You are a CODING WORKER in an autonomous engineering org.
You have a clean context and full read/edit/write/bash tools scoped to the target repository.

Rules:
- Implement EXACTLY the one assigned feature. Do not scope-creep.
- Read the relevant files before editing. Make focused, minimal changes that match the surrounding code.
- Run any quick, cheap checks you can (typecheck, a targeted test) to sanity-check your change.
- Do NOT run git or commit — the harness handles commits.
- Run commands PLAINLY. Never append \`; echo $?\`, \`|| true\`, \`&& echo ok\` or similar. The harness records
  the real exit code of every command you run; masking it destroys the record the next agent depends on.
- You are in an ISOLATED WORKTREE and other workers are in their own worktrees in parallel. Every path you
  touch must be relative to your working directory. Never cd to an absolute path outside it and never edit or
  test files in another checkout — you would be changing, or measuring, someone else's tree.
- Your environment is already prepared: env files, dependencies and import paths are set up for this tree.
  If a command cannot find a module or a credential, that is a bug worth reporting as an issue, not something
  to fix by installing packages or writing env files.

HANDOFF — REQUIRED. Your final message must end with a fenced block tagged "handoff" containing ONLY JSON:

\`\`\`handoff
{
  "completed": "what you actually changed, 1-3 sentences, naming the files",
  "leftUndone": ["parts of THIS feature's spec you did not do, each with the reason"],
  "issues": [{ "summary": "<=10 words", "detail": "what you found and what decision it needs" }],
  "proceduresFollowed": true,
  "procedureNotes": "only if you deviated: which procedure, and why",
  "assertionsClaimed": ["a1"],
  "confidence": "high"
}
\`\`\`

How to fill it in:
- "leftUndone" is for YOUR unfinished work on this feature. Be honest — a worker that hides an
  unfinished edge case costs the org an entire milestone. An empty list is a strong claim; earn it.
- "issues" is for things OUTSIDE this feature you discovered: pre-existing bugs, a wrong assumption
  in the spec, a missing dependency, a test that was already failing. Each issue you report gets
  triaged by the orchestrator. Silence here is how a mission drifts.
- "assertionsClaimed": list an assertion id ONLY if you believe a hostile reviewer reading the diff
  would agree it holds. Independent validators check every claim — overclaiming is caught and costs
  a correction round.
- "confidence": "low" is a legitimate and useful answer. Say it when you are guessing.
- Do NOT list the commands you ran — the harness records those from your tool calls automatically.`;

export interface WorkerResult {
	/** Human-readable prose (handoff block stripped). */
	summary: string;
	handoff: Handoff;
	costUsd: number;
	stopReason: string;
	aborted: boolean;
	errorMessage?: string;
	turns: number;
	/** Socket-addressable id, for `missions ask/steer` while the milestone is still open. */
	workerId: string;
	/**
	 * Drop this worker from the live registry. The caller owns the lifetime: a worker stays
	 * reachable through validation and triage so a STALLED milestone can be steered by the agent
	 * that did the work, rather than losing its context at the moment help is needed.
	 */
	release: () => void;
}

export interface RunWorkerOptions {
	feature: Feature;
	assertions: Assertion[];
	milestone: number;
	cwd: string;
	model: ModelSpec;
	budgetUsd: number;
	/**
	 * The mission env every bash command runs under. Without this, commands inherit the
	 * daemon's ambient environment — whatever shell happened to start it — and Python
	 * resolves imports out of the main checkout via the venv's baked-in .pth entries.
	 */
	env?: NodeJS.ProcessEnv;
	/** Ground truth about the repo's environments, handed to the worker verbatim. */
	envDoctrine?: string;
	/** Mission this worker belongs to. Forms its addressable id, so it can be steered mid-run. */
	missionId?: string;
	/**
	 * Read-only scouts this worker may delegate investigation to. Omit to disable
	 * fan-out entirely — a worker with no scouts behaves exactly as it did before.
	 */
	scouts?: AgentSpec[];
	onProgress?: (e: { type: "tool"; toolName: string } | { type: "cost"; costUsd: number }) => void;
}

export async function runWorker(options: RunWorkerOptions): Promise<WorkerResult> {
	const { feature, assertions, milestone, cwd, model: spec, budgetUsd, env, envDoctrine, scouts, onProgress } = options;

	const model = getModel(spec.provider, spec.modelId);
	if (!model) throw new Error(`Worker model not found: ${spec.provider}/${spec.modelId}`);

	let costUsd = 0;
	// Registered before the first turn so it is reachable for its whole life, not just once it
	// has produced output. Recent assistant text is kept for `tail` so an overseer can see what
	// it is doing without replaying the transcript.
	const recent: string[] = [];
	const liveInfo = { id: "", missionId: "", featureId: "", title: "", startedAt: Date.now(), costUsd: 0, lastActivity: "starting", steers: [] as string[] };
	const workerId = `${options.missionId ?? "mission"}:${feature.id}`;
	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: "off",
			// The spawn hook is the seam that makes the environment explicit rather than ambient:
			// every bash command the worker runs gets the mission's env, not the daemon's.
			tools: [
				...createCodingTools(cwd, env ? { bash: { spawnHook: (ctx) => ({ ...ctx, env }) } } : undefined),
				// Read-only fan-out. Scout spend is charged straight to this worker's total,
				// so delegating is a budget decision the same as any other tool call.
				...(scouts?.length
					? [
							createDelegateTool({
								cwd,
								specs: scouts,
								model: spec,
								onCost: (usd) => {
									costUsd += usd;
									onProgress?.({ type: "cost", costUsd: usd });
								},
								onProgress: (msg) => onProgress?.({ type: "tool", toolName: msg }),
							}),
						]
					: []),
			],
		},
		streamFn,
		getApiKey: (provider) => getEnvApiKey(provider),
	});

	let aborted = false;
	let stopReason = "stop";
	let errorMessage: string | undefined;

	// Deterministic command log. We never ask the model what it ran — we watch.
	const commands: CommandRecord[] = [];
	const inFlight = new Map<string, string>();

	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			if (msg.usage?.cost?.total) {
				costUsd += msg.usage.cost.total;
				onProgress?.({ type: "cost", costUsd });
			}
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;
			// Keep the live view current: an overseer tailing this worker sees what it just said.
			const said = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
			if (said) {
				recent.push(said.slice(0, 1200));
				if (recent.length > 10) recent.shift();
			}
			if (costUsd >= budgetUsd && !aborted) {
				aborted = true;
				agent.abort();
			}
		} else if (event.type === "tool_execution_start") {
			onProgress?.({ type: "tool", toolName: event.toolName });
			liveInfo.lastActivity = event.toolName;
			liveInfo.costUsd = costUsd;
			if (event.toolName === "bash") {
				const cmd = (event.args as { command?: string } | undefined)?.command;
				if (cmd) inFlight.set(event.toolCallId, cmd);
			}
		} else if (event.type === "tool_execution_end") {
			const cmd = inFlight.get(event.toolCallId);
			if (cmd === undefined) return;
			inFlight.delete(event.toolCallId);
			commands.push({ command: cmd, exitCode: exitCodeOf(event.result, event.isError) });
		}
	});

	const assertionText = assertions.length
		? assertions.map((a) => `- (${a.id}) ${a.statement}`).join("\n")
		: "(no explicit assertions — use your judgement)";

	const procedureText = feature.procedures?.length
		? `\nPROCEDURES you must follow for this feature (report adherence in the handoff):\n${feature.procedures.map((p) => `- ${p}`).join("\n")}\n`
		: "";

	const addressesText = feature.addresses?.length
		? `\nThis is CORRECTIVE work. It exists to resolve:\n${feature.addresses.map((a) => `- ${a}`).join("\n")}\n`
		: "";

	const doctrineText = envDoctrine ? `\nENVIRONMENT — read this before running anything:\n${envDoctrine}\n` : "";
	const contextText = repoContext(cwd);

	const task = `Implement this feature.

YOUR WORKING DIRECTORY: ${cwd}
Everything you read, edit and run lives under that path. It is a git worktree of the target repo,
yours alone for this mission.
${doctrineText}${contextText}
FEATURE: ${feature.title}
${feature.description}
${addressesText}${procedureText}
VALIDATION ASSERTIONS this feature must satisfy:
${assertionText}

Make the change now, then emit your handoff block.`;

	const info = liveInfo;
	Object.assign(liveInfo, {
		id: workerId,
		missionId: options.missionId ?? "mission",
		featureId: feature.id,
		title: feature.title,
		startedAt: Date.now(),
		costUsd: 0,
		lastActivity: "starting",
		steers: liveInfo.steers,
	});
	const unregister = registerWorker({ info, agent, recent });

	try {
		await agent.prompt(task);
	} catch (err) {
		errorMessage = err instanceof Error ? err.message : String(err);
	}
	await agent.waitForIdle();
	// NOT unregistered here. This used to drop the worker the instant its turn ended — before
	// validation ran, before the orchestrator triaged, and so before the mission could possibly
	// know it needed help. The result was that a worker was addressable for its whole life
	// EXCEPT the one moment an operator would want to reach it: "milestone STALLED — needs you",
	// where by then the only thing left was its handoff text. The caller decides when it dies,
	// so a stalled milestone can still be steered by the agent that has the context.

	// Any command still in flight when we aborted: record it with an unknown exit code
	// rather than dropping it. A killed command is exactly the kind of thing the next
	// agent needs to know about.
	for (const [, cmd] of inFlight) commands.push({ command: cmd, exitCode: null });

	const finalText = extractFinal(agent.state.messages);
	const { prose, handoff } = parseHandoff(finalText);

	return {
		summary: prose,
		handoff: {
			featureId: feature.id,
			milestone,
			completed: handoff?.completed?.trim() || prose || "(worker produced no summary)",
			leftUndone: stringList(handoff?.leftUndone),
			commands,
			issues: issueList(handoff?.issues),
			proceduresFollowed: handoff?.proceduresFollowed !== false,
			procedureNotes: typeof handoff?.procedureNotes === "string" ? handoff.procedureNotes : undefined,
			assertionsClaimed: stringList(handoff?.assertionsClaimed).filter((id) => assertions.some((a) => a.id === id)),
			confidence: confidenceOf(handoff?.confidence),
			steers: liveInfo.steers.length ? [...liveInfo.steers] : undefined,
			degraded: handoff === null,
			stopReason,
			aborted,
			costUsd,
		},
		costUsd,
		stopReason,
		aborted,
		errorMessage,
		turns: agent.state.messages.filter((m) => m.role === "assistant").length,
		workerId,
		release: unregister,
	};
}

/**
 * The target repo's own instructions to agents, handed to the worker verbatim.
 *
 * Without this a worker opens on a large unfamiliar monorepo knowing only its one feature —
 * no conventions, no runtime doctrine, no idea which of two products it is in or which package
 * manager to use. It then guesses, and guesses cost a milestone. A repo that has written its
 * rules down should not have to rely on the model inferring them.
 *
 * Uses pi's own discovery so the file that governs a worker is the same file that governs an
 * interactive pi session in that directory: AGENTS.md / CLAUDE.md from the agent dir and every
 * ancestor of cwd. Note it does NOT walk downward — a per-directory AGENTS.md deeper in the tree
 * is invisible from the repo root, so root-level content is what actually reaches the worker.
 */
function repoContext(cwd: string): string {
	const agentDir = join(homedir(), ".pi");
	let files: Array<{ path: string; content: string }> = [];
	try {
		// Ancestor-walking is a problem here specifically because mission worktrees live INSIDE the
		// target repo, at <repo>/.missions/worktrees/<id>. The walk therefore also finds the PARENT
		// checkout's AGENTS.md — a different tree, at a different commit, possibly with uncommitted
		// edits. Handing a worker both copies means handing it two versions of the rules and letting
		// it pick. Keep only this tree's own files, plus the user's global ones.
		files = loadProjectContextFiles({ cwd, agentDir }).filter(
			(f) => f.path.startsWith(cwd) || f.path.startsWith(agentDir),
		);
	} catch {
		// Missing or unreadable context is not a reason to fail the mission — the worker just
		// starts less informed, which is the status quo this function exists to improve on.
		return "";
	}
	if (!files.length) return "";
	const blocks = files.map((f) => `<<< ${f.path} >>>\n${f.content.trim()}`).join("\n\n");
	return `
REPOSITORY INSTRUCTIONS — the target repo's own rules for agents. These are binding, and they
override your general habits where the two disagree.

${blocks}
`;
}

/** Shape of the raw JSON we ask the worker for — every field optional, nothing trusted. */
interface RawHandoff {
	completed?: string;
	leftUndone?: unknown;
	issues?: unknown;
	proceduresFollowed?: boolean;
	procedureNotes?: string;
	assertionsClaimed?: unknown;
	confidence?: unknown;
}

/** Split the worker's final message into human prose and the structured handoff. */
function parseHandoff(finalText: string): { prose: string; handoff: RawHandoff | null } {
	const fence = finalText.match(/```handoff\s*\n([\s\S]*?)```/);
	if (fence?.[1]) {
		const parsed = parseJson<RawHandoff>(fence[1]);
		const prose = finalText.replace(fence[0], "").trim();
		if (parsed) return { prose, handoff: parsed };
		return { prose, handoff: null };
	}
	// Fall back to any JSON object in the message — models sometimes drop the fence tag.
	const loose = parseJson<RawHandoff>(finalText);
	if (loose && (loose.completed !== undefined || loose.leftUndone !== undefined)) {
		return { prose: finalText.replace(/```[\s\S]*?```/g, "").trim(), handoff: loose };
	}
	return { prose: finalText.trim(), handoff: null };
}

/** Recover a bash exit code from a tool result. Non-zero exits surface as an error with a marker. */
function exitCodeOf(result: unknown, isError: boolean): number | null {
	if (!isError) return 0;
	const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
	const m = text.match(/Command exited with code (\d+)/);
	return m?.[1] ? Number(m[1]) : null;
}

function stringList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.map((x) => (typeof x === "string" ? x : String(x ?? ""))).filter((s) => s.trim().length > 0);
}

function issueList(v: unknown): HandoffIssue[] {
	if (!Array.isArray(v)) return [];
	const out: HandoffIssue[] = [];
	for (const raw of v) {
		if (typeof raw === "string") {
			if (raw.trim()) out.push({ summary: raw.trim() });
			continue;
		}
		const o = raw as { summary?: unknown; detail?: unknown };
		const summary = typeof o?.summary === "string" ? o.summary.trim() : "";
		if (!summary) continue;
		out.push({ summary, detail: typeof o.detail === "string" ? o.detail : undefined });
	}
	return out;
}

function confidenceOf(v: unknown): Handoff["confidence"] {
	return v === "high" || v === "medium" || v === "low" ? v : "medium";
}

function extractFinal(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "assistant") {
			const parts: string[] = [];
			for (const c of m.content) if (c.type === "text") parts.push(c.text);
			const joined = parts.join("\n").trim();
			if (joined) return joined;
		}
	}
	return "";
}
