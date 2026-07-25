import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getEnvApiKey, getModel, type KnownProvider } from "@mariozechner/pi-ai";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import type { Assertion, Feature, ModelSpec } from "./types.js";

const SYSTEM_PROMPT = `You are a CODING WORKER in an autonomous engineering org.
You have a clean context and full read/edit/write/bash tools scoped to the target repository.

Rules:
- Implement EXACTLY the one assigned feature. Do not scope-creep.
- Read the relevant files before editing. Make focused, minimal changes that match the surrounding code.
- Run any quick, cheap checks you can (typecheck, a targeted test) to sanity-check your change.
- Do NOT run git or commit — the harness handles commits.
- When finished, end your final message with a tight 3-5 line summary: what you changed, which files, and why it satisfies the validation assertions.`;

export interface WorkerResult {
	summary: string;
	costUsd: number;
	stopReason: string;
	aborted: boolean;
	errorMessage?: string;
	turns: number;
}

export interface RunWorkerOptions {
	feature: Feature;
	assertions: Assertion[];
	cwd: string;
	model: ModelSpec;
	budgetUsd: number;
	onProgress?: (e: { type: "tool"; toolName: string } | { type: "cost"; costUsd: number }) => void;
}

export async function runWorker(options: RunWorkerOptions): Promise<WorkerResult> {
	const { feature, assertions, cwd, model: spec, budgetUsd, onProgress } = options;

	const model = getModel(spec.provider as KnownProvider, spec.modelId as never);
	if (!model) throw new Error(`Worker model not found: ${spec.provider}/${spec.modelId}`);

	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: "off",
			tools: createCodingTools(cwd),
		},
		getApiKey: (provider) => getEnvApiKey(provider),
	});

	let costUsd = 0;
	let aborted = false;
	let stopReason = "stop";
	let errorMessage: string | undefined;

	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			if (msg.usage?.cost?.total) {
				costUsd += msg.usage.cost.total;
				onProgress?.({ type: "cost", costUsd });
			}
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;
			if (costUsd >= budgetUsd && !aborted) {
				aborted = true;
				agent.abort();
			}
		} else if (event.type === "tool_execution_start") {
			onProgress?.({ type: "tool", toolName: event.toolName });
		}
	});

	const assertionText = assertions.length
		? assertions.map((a) => `- (${a.id}) ${a.statement}`).join("\n")
		: "(no explicit assertions — use your judgement)";

	const task = `Implement this feature.

FEATURE: ${feature.title}
${feature.description}

VALIDATION ASSERTIONS this feature must satisfy:
${assertionText}

Make the change now, then summarize.`;

	try {
		await agent.prompt(task);
	} catch (err) {
		errorMessage = err instanceof Error ? err.message : String(err);
	}
	await agent.waitForIdle();

	return {
		summary: extractFinal(agent.state.messages),
		costUsd,
		stopReason,
		aborted,
		errorMessage,
		turns: agent.state.messages.filter((m) => m.role === "assistant").length,
	};
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
