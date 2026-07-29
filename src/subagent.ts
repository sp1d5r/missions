/**
 * Sub-agents: read-only fan-out for a worker.
 *
 * A worker's expensive, serial resource is its own context. Reading five files
 * to answer "where is this convention set?" burns that context on material it
 * will never need again, and the answer arrives buried in tool output rather
 * than stated. Delegating the question to a scout returns the ANSWER and throws
 * the reading away.
 *
 * SCOUTS NEVER WRITE. The tool set is forced to read/grep/find/ls here,
 * regardless of what an agent spec asks for. This is not a safety railing, it is
 * the execution model: the harness serialises writes so that one agent owns the
 * tree at a time and every change lands in an attributable commit. Parallel
 * writers would break the handoff record and the changelog with it. Parallel
 * READERS cost nothing but money.
 *
 * The execution engine is @chaotic1988/pi-subagent's runner, loaded through jiti
 * because that package ships uncompiled TypeScript for pi's extension loader.
 * We use its runner and skip its extension wrapper, which is a tool surface for
 * the interactive pi agent and has no meaning inside a mission.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { Type, type AgentTool } from "./pi.js";
import type { ModelSpec } from "./types.js";

/**
 * What a scout can do by default.
 *
 * `bash` is here deliberately. A scout without it can read source and guess, but cannot answer
 * the questions a worker most wants delegated — does this test pass, what does this command
 * print, is this binary on PATH, does this import resolve. Those answers come from running
 * something, and a scout that can only read hands back a plausible reading of the code instead
 * of the fact. That is the failure mode this whole harness exists to avoid.
 *
 * The cost is real and worth stating: bash can write, scouts run up to MAX_SCOUTS at a time, and
 * they share the worker's tree. So the serialized-writer invariant is no longer enforced by tool
 * grant — it is enforced by the scout prompt and by the worker owning every commit. A scout that
 * edits is a bug, not a permitted move.
 */
export const SCOUT_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** Concurrency cap for one delegate call. Scouts are cheap but not free. */
const MAX_SCOUTS = 4;

/**
 * Read a `tools:` frontmatter value into a tool list.
 *
 * Accepts a YAML list or a comma/space separated string, because a spec author will write
 * whichever feels natural and a silently ignored declaration is worse than a rejected one.
 * Returns undefined when nothing usable was declared, so the caller can apply its default.
 */
export function parseToolList(raw: unknown): string[] | undefined {
	const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
	const names = items.map((t) => String(t).trim()).filter(Boolean);
	return names.length ? names : undefined;
}

export interface AgentSpec {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface ScoutResult {
	agent: string;
	task: string;
	ok: boolean;
	output: string;
	costUsd: number;
	turns: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Lazy engine load. jiti compiles on first use, so it is deferred until a
// worker actually delegates — a mission that never fans out pays nothing.
// ---------------------------------------------------------------------------

type RunAgentFn = (
	agent: AgentSpec,
	task: string,
	cwd: string,
	registry: ModelRegistry,
	signal?: AbortSignal,
	onUpdate?: (partial: unknown) => void,
) => Promise<{
	exitCode: number;
	messages: { role: string; content: { type: string; text?: string }[] }[];
	usage: { cost: number; turns: number };
	stopReason?: string;
	errorMessage?: string;
}>;

let engine: { runAgent: RunAgentFn } | undefined;
let registry: ModelRegistry | undefined;

async function loadEngine(): Promise<{ runAgent: RunAgentFn; registry: ModelRegistry }> {
	if (!engine) {
		const jiti = createJiti(import.meta.url);
		engine = (await jiti.import("@chaotic1988/pi-subagent/runner.ts")) as { runAgent: RunAgentFn };
	}
	if (!registry) {
		registry = new ModelRegistry(await ModelRuntime.create());
		await registry.refresh();
	}
	return { runAgent: engine.runAgent, registry };
}

// ---------------------------------------------------------------------------
// Agent specs
// ---------------------------------------------------------------------------

const DEFAULT_SCOUT_PROMPT = `You are a SCOUT. A coding worker has delegated one question to you so it does not have to
spend its own context finding the answer.

You can read AND run commands. Investigate, then answer the question and nothing else.

RUN THINGS. If the question can be settled by executing something — does this test pass, what does this
command print, is this binary on PATH, does this import resolve, what is this file's actual size — then
run it and report what happened. A command's output is evidence; your reading of the source is an
inference. When the two disagree, the command is right. Quote the exact command and its exit code.

YOU DO NOT WRITE. The worker owns this tree and every commit in it, and other scouts are running beside
you right now. Never edit, create, move or delete a file; never git add, commit, checkout, stash or
reset; never install, upgrade or remove a package; never start a long-lived server or background process.
If answering seems to require changing something, that is the worker's decision — report what you found
and why you stopped. A scout that mutates the tree corrupts work it cannot see.

SEARCH THE PROJECT'S OWN CODE FIRST — its source directory (src/, lib/, app/), its tests, its top-level
docs. Questions are almost always about the project, not its dependencies. NEVER search node_modules,
vendor, dist, build, .venv or site-packages unless the question names a dependency outright: those trees
are enormous, they will dominate any grep, and answering from them is how a scout concludes something is
absent when it is sitting in src/. If a search returns mostly dependency paths, you searched too wide —
narrow it to the source directory and search again before concluding anything.

- Lead with the answer, not with what you did. The worker wants a conclusion, not a narration.
- Cite specific paths and line numbers. An unsourced claim is worse than "I could not find it".
- Before answering "not found", say which directories you actually searched. If src/ is not among them,
  you are not finished.
- If the answer is genuinely not in this repo, say so plainly and stop. Do not speculate — the worker
  will act on what you say, and a confident guess costs more than an admission.
- Be terse. Everything you write lands in someone else's context window.`;

export const BUILTIN_SCOUT: AgentSpec = {
	name: "scout",
	description: "Read-only investigator. Answers one question about the repo with citations.",
	tools: [...SCOUT_TOOLS],
	systemPrompt: DEFAULT_SCOUT_PROMPT,
	source: "project",
	filePath: "(builtin)",
};

/**
 * Load agent specs from `.missions/agents/*.md` — YAML frontmatter plus a system
 * prompt body, the same shape pi uses, so a spec can be moved between the two.
 */
export function loadAgentSpecs(repo: string): AgentSpec[] {
	const specs: AgentSpec[] = [BUILTIN_SCOUT];
	const dir = join(repo, ".missions", "agents");
	if (!existsSync(dir)) return specs;

	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".md")) continue;
		const filePath = join(dir, name);
		let raw: string;
		try {
			raw = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		if (!m?.[1]) continue;
		const fm: Record<string, string> = {};
		for (const line of m[1].split("\n")) {
			const kv = line.match(/^(\w+):\s*(.*)$/);
			if (kv?.[1]) fm[kv[1]] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
		}
		if (!fm.name || !fm.description) continue;
		specs.push({
			name: fm.name,
			description: fm.description,
			// A repo that declares tools in frontmatter gets them. This used to be parsed and then
			// thrown away, so a spec asking for anything was silently overridden. Frontmatter is
			// untyped text, so "read, bash" and a YAML list both have to land as string[].
			tools: parseToolList(fm.tools) ?? [...SCOUT_TOOLS],
			model: fm.model,
			systemPrompt: m[2]?.trim() || DEFAULT_SCOUT_PROMPT,
			source: "project",
			filePath,
		});
	}
	return specs;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function finalText(messages: { role: string; content: { type: string; text?: string }[] }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const text = m.content
			.filter((c) => c.type === "text" && c.text)
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export interface DispatchOptions {
	cwd: string;
	specs: AgentSpec[];
	tasks: { agent: string; task: string }[];
	/** Seat the scouts run on. Falls back to the spec's own model, then the SDK default. */
	model?: ModelSpec;
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
}

/** Run scouts concurrently and return one result each, in the order asked. */
export async function dispatchScouts(options: DispatchOptions): Promise<ScoutResult[]> {
	const { cwd, specs, model, signal, onProgress } = options;
	const tasks = options.tasks.slice(0, MAX_SCOUTS);
	const { runAgent, registry: reg } = await loadEngine();

	return Promise.all(
		tasks.map(async (t): Promise<ScoutResult> => {
			const spec = specs.find((s) => s.name === t.agent) ?? BUILTIN_SCOUT;
			const resolved: AgentSpec = {
				...spec,
				tools: spec.tools?.length ? spec.tools : [...SCOUT_TOOLS],
				model: spec.model ?? (model ? `${model.provider}/${model.modelId}` : undefined),
			};
			onProgress?.(`scout ${spec.name}: ${t.task.slice(0, 60)}`);
			try {
				const r = await runAgent(resolved, t.task, cwd, reg, signal);
				const ok = r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
				return {
					agent: spec.name,
					task: t.task,
					ok,
					output: finalText(r.messages) || "(no output)",
					costUsd: r.usage?.cost ?? 0,
					turns: r.usage?.turns ?? 0,
					error: ok ? undefined : (r.errorMessage ?? r.stopReason),
				};
			} catch (err) {
				return {
					agent: spec.name,
					task: t.task,
					ok: false,
					output: "",
					costUsd: 0,
					turns: 0,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);
}

// ---------------------------------------------------------------------------
// The tool a worker actually sees
// ---------------------------------------------------------------------------

export interface DelegateToolOptions {
	cwd: string;
	specs: AgentSpec[];
	model?: ModelSpec;
	/** Scout spend is mission spend — it must reach the budget, or fan-out is free money. */
	onCost: (usd: number) => void;
	onProgress?: (msg: string) => void;
}

export function createDelegateTool(options: DelegateToolOptions): AgentTool {
	const { cwd, specs, model, onCost, onProgress } = options;
	const roster = specs.map((s) => `${s.name}: ${s.description}`).join("; ");

	return {
		name: "delegate",
		label: "delegate",
		description:
			`Ask up to ${MAX_SCOUTS} READ-ONLY scouts a question each, in parallel, and get their answers back. ` +
			"Use this for investigation you would otherwise do yourself — 'where is X configured', 'what calls Y', " +
			"'what is the test convention here'. Each scout has its own context, so their reading does not consume " +
			"yours; you get only the answers. Scouts CANNOT edit, write, or run commands — do the work yourself. " +
			`Available: ${roster}`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.Optional(Type.String({ description: "Scout name. Defaults to the general 'scout'." })),
					task: Type.String({ description: "One self-contained question. The scout sees no other context." }),
				}),
				{ description: `1-${MAX_SCOUTS} independent questions, answered concurrently.` },
			),
		}),
		async execute(_id: string, params: { tasks: { agent?: string; task: string }[] }) {
			const tasks = (params.tasks ?? []).filter((t) => t?.task?.trim()).map((t) => ({ agent: t.agent ?? "scout", task: t.task }));
			if (!tasks.length) {
				return { content: [{ type: "text", text: "No tasks given. Provide at least one question." }], details: {} };
			}

			const results = await dispatchScouts({ cwd, specs, tasks, model, onProgress });
			for (const r of results) onCost(r.costUsd);

			const text = results
				.map((r) => (r.ok ? `## ${r.agent}: ${r.task}\n${r.output}` : `## ${r.agent}: ${r.task}\nFAILED — ${r.error ?? "unknown"}`))
				.join("\n\n");
			const spent = results.reduce((n, r) => n + r.costUsd, 0);
			return {
				content: [{ type: "text", text: `${text}\n\n_(${results.length} scout(s), $${spent.toFixed(4)})_` }],
				details: { results },
			};
		},
	} as unknown as AgentTool;
}
