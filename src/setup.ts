import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { Agent, getEnvApiKey, getModel, streamFn, type AgentEvent, type AgentMessage, type AssistantMessage, type KnownProvider } from "./pi.js";
import type { ModelSpec } from "./types.js";

const execFile = promisify(execFileCb);

/**
 * Stage 0 — make a fresh worktree actually runnable, and improve the repo's own instructions
 * when they turn out to be wrong.
 *
 * The previous approach declared each repo's dependency layout in a TypeScript adapter
 * (`target/nadine.ts`). That was wrong three ways: it only described one repo, a human had to
 * keep it accurate, and it INHERITED state from the main checkout — symlinked venvs and copied
 * node_modules — so a mission that changed a lockfile could never test its own change.
 *
 * Here the repo explains how to set itself up, in a doc that ships with the code. Two paths:
 *
 *   REPLAY (the common case, no LLM). If the setup doc and the lockfiles hash to the same value
 *   as a previously recorded success, re-run exactly the commands that worked. Fast and boring.
 *
 *   AGENT (first run, changed inputs, or a failed replay). An agent reads the doc, runs the
 *   setup, verifies it, and — when the doc is wrong or incomplete — FIXES THE DOC. That
 *   correction is the durable output: the next worktree, and the next engineer, get it right.
 *   A cache would have kept that knowledge invisible and unversioned; a doc in the repo is
 *   diffable, reviewable and travels with the code.
 *
 * What the agent decides and what the harness observes are deliberately separate. The agent
 * chooses and runs COMMANDS, which needs comprehension. The harness then inspects the
 * filesystem for what those commands produced — bin dirs, source roots — which is deterministic
 * and not worth asking a model about.
 */

/** Where a repo may explain how to set itself up, in order of preference. */
const SETUP_DOC_CANDIDATES = ["SETUP.md", "docs/SETUP.md", ".missions/SETUP.md", "AGENTS.md", "CONTRIBUTING.md", "README.md"];

/** Lockfiles whose contents invalidate a recorded setup. */
const LOCKFILE_NAMES = ["pdm.lock", "poetry.lock", "uv.lock", "requirements.txt", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.sum"];

const RECORD_ROOT = join(homedir(), ".missions", "setup");

export interface SetupStep {
	/** Repo-relative directory the command runs in. "." for the repo root. */
	dir: string;
	cmd: string;
	seconds?: number;
}

export interface SetupRecord {
	repo: string;
	/** Hash of the setup doc + every lockfile + platform. Changes invalidate the replay. */
	inputsHash: string;
	docPath: string;
	recordedAt: string;
	steps: SetupStep[];
	verify?: SetupStep;
	/** Observed by the harness after setup, not reported by the agent. */
	produced: { binDirs: string[]; sourceRoots: string[] };
}

export interface SetupResult {
	ok: boolean;
	/** How this run was satisfied — useful in the log, and in deciding whether to trust it. */
	mode: "replay" | "agent" | "skipped";
	steps: SetupStep[];
	binDirs: string[];
	sourceRoots: string[];
	/** Set when the agent edited the repo's setup doc. Worth surfacing: it is a real contribution. */
	docUpdated?: string;
	/** The repo's own smoke check, as reported by setup. A better default than the harness guessing. */
	verifyCommand?: string;
	notes: string[];
	costUsd: number;
	error?: string;
}

export function findSetupDoc(repoCwd: string): string | null {
	for (const rel of SETUP_DOC_CANDIDATES) {
		if (existsSync(join(repoCwd, rel))) return rel;
	}
	return null;
}

/**
 * Hash everything that would make a recorded setup wrong: the instructions themselves, every
 * lockfile, and the platform. Deliberately NOT the whole tree — source changes do not
 * invalidate an install, and hashing them would defeat the cache on every mission.
 */
function inputsHash(repoCwd: string, docRel: string | null): string {
	const h = createHash("sha256");
	h.update(process.platform);
	if (docRel && existsSync(join(repoCwd, docRel))) h.update(readFileSync(join(repoCwd, docRel)));
	for (const lock of findLockfiles(repoCwd)) h.update(lock).update(readFileSync(join(repoCwd, lock)));
	return h.digest("hex").slice(0, 16);
}

/** Lockfiles at the root or one level down — deep enough for a service-per-directory monorepo. */
function findLockfiles(repoCwd: string): string[] {
	const out: string[] = [];
	const consider = (rel: string) => {
		if (existsSync(join(repoCwd, rel))) out.push(rel);
	};
	for (const name of LOCKFILE_NAMES) consider(name);
	let entries: string[] = [];
	try {
		entries = readdirSync(repoCwd, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
			.map((e) => e.name);
	} catch {
		return out.sort();
	}
	for (const dir of entries) for (const name of LOCKFILE_NAMES) consider(join(dir, name));
	return out.sort();
}

const recordPath = (repoCwd: string) => join(RECORD_ROOT, `${createHash("sha1").update(repoCwd).digest("hex").slice(0, 16)}.json`);

function readRecord(repoCwd: string): SetupRecord | null {
	try {
		return JSON.parse(readFileSync(recordPath(repoCwd), "utf-8")) as SetupRecord;
	} catch {
		return null;
	}
}

function writeRecord(rec: SetupRecord): void {
	mkdirSync(dirname(recordPath(rec.repo)), { recursive: true });
	writeFileSync(recordPath(rec.repo), `${JSON.stringify(rec, null, 2)}\n`);
}

/**
 * What setup produced, observed rather than declared.
 *
 * `bin` / `.bin` become PATH so a bare `python` is this tree's. The `.pth` files a venv writes
 * into site-packages name the project's own source roots — the repo telling us where its code
 * lives — which is a better answer than any hand-maintained list.
 */
export function observeProduced(workCwd: string): { binDirs: string[]; sourceRoots: string[] } {
	const binDirs: string[] = [];
	const sourceRoots: string[] = [];
	const seenRoot = new Set<string>();

	const scanDir = (dirRel: string) => {
		for (const name of [".venv", "venv", "node_modules"]) {
			const base = join(workCwd, dirRel, name);
			if (!existsSync(base)) continue;
			for (const b of ["bin", ".bin"]) {
				const p = join(base, b);
				if (existsSync(p) && !binDirs.includes(p)) binDirs.push(p);
			}
			for (const pth of findPthFiles(base)) {
				for (const line of readFileSync(pth, "utf-8").split("\n")) {
					const t = line.trim();
					// A .pth line is either an import hook or a path; only absolute paths inside
					// this worktree are source roots we care about.
					if (!t || t.startsWith("import ") || !t.startsWith("/")) continue;
					const rooted = resolve(t);
					if (rooted.startsWith(workCwd) && existsSync(rooted) && !seenRoot.has(rooted)) {
						seenRoot.add(rooted);
						sourceRoots.push(rooted);
					}
				}
			}
		}
	};

	scanDir(".");
	try {
		for (const e of readdirSync(workCwd, { withFileTypes: true })) {
			if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") scanDir(e.name);
		}
	} catch {
		/* unreadable tree — return what we have */
	}
	return { binDirs, sourceRoots };
}

function findPthFiles(venvDir: string): string[] {
	const out: string[] = [];
	const lib = join(venvDir, "lib");
	if (!existsSync(lib)) return out;
	try {
		for (const py of readdirSync(lib)) {
			const sp = join(lib, py, "site-packages");
			if (!existsSync(sp)) continue;
			for (const f of readdirSync(sp)) if (f.endsWith(".pth")) out.push(join(sp, f));
		}
	} catch {
		/* ignore */
	}
	return out;
}

async function runStep(step: SetupStep, workCwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; out: string; seconds: number }> {
	const started = Date.now();
	try {
		const { stdout, stderr } = await execFile("bash", ["-c", step.cmd], {
			cwd: join(workCwd, step.dir === "." ? "" : step.dir),
			env,
			timeout: timeoutMs,
			maxBuffer: 32 * 1024 * 1024,
		});
		return { ok: true, out: `${stdout}${stderr}`.slice(-2000), seconds: (Date.now() - started) / 1000 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`.slice(-2000), seconds: (Date.now() - started) / 1000 };
	}
}

const SETUP_SYSTEM_PROMPT = `You are the SETUP agent for an autonomous engineering org.

A fresh git worktree of a repository has been created for you. It contains the tracked files and
NOTHING else: no installed dependencies, no virtualenvs, no node_modules. Your job is to make it
runnable, and then to leave the repository's setup instructions better than you found them.

Do this:
1. READ the repo's setup instructions first (the doc path is given below). Follow what it says.
   Prefer the repo's documented commands over your own habits — it knows things you do not.
2. RUN the setup. Install dependencies with whatever the repo uses. Work in the worktree you were
   given; never touch any other checkout.
3. VERIFY it worked, using the repo's own smoke check if it documents one, otherwise the cheapest
   command that proves the code can actually run or build.
4. FIX THE DOC when reality disagrees with it — a missing step, a stale command, a service that
   needs an extra flag, an undocumented prerequisite. This correction is the most valuable thing
   you produce: it is what stops the next worktree rediscovering the same problem. Edit the doc
   file directly. If the repo has no setup doc, create SETUP.md with what you actually did.

Rules:
- Install only what the repo genuinely needs to run and be checked. Do not install every optional
  extra "to be safe" — a slow setup is paid on every future mission.
- Never edit source code. You are setting up, not developing. The only file you may write is the
  setup doc.
- Do NOT run git commands. The harness handles commits.
- If a step fails and you cannot fix it, say so plainly rather than pretending it succeeded. A
  known-broken setup that is documented is worth more than a green report that is false.

End your final message with a fenced block tagged "setup" containing ONLY JSON:

\`\`\`setup
{
  "ok": true,
  "steps": [{ "dir": ".", "cmd": "the exact command you ran, in order" }],
  "verify": { "dir": ".", "cmd": "the command that proves setup worked" },
  "docUpdated": "path/to/SETUP.md or null if you changed nothing",
  "notes": ["anything a human should know — especially what you could not make work"]
}
\`\`\`

"steps" must be replayable verbatim on a clean worktree: the harness re-runs exactly these,
in order, without you, for every future setup where nothing has changed.`;

export interface RunSetupOptions {
	targetCwd: string;
	workCwd: string;
	model: ModelSpec;
	env: NodeJS.ProcessEnv;
	budgetUsd?: number;
	stepTimeoutMs?: number;
	onProgress?: (msg: string) => void;
}

export async function runSetup(options: RunSetupOptions): Promise<SetupResult> {
	const { targetCwd, workCwd, model: spec, env, budgetUsd = 2, stepTimeoutMs = 20 * 60_000, onProgress } = options;
	const notes: string[] = [];
	const docRel = findSetupDoc(workCwd);
	const hash = inputsHash(workCwd, docRel);
	const record = readRecord(targetCwd);

	// ── Replay: the fast, deterministic, no-LLM path ────────────────────────────────────
	if (record && record.inputsHash === hash && record.steps.length) {
		onProgress?.(`replaying ${record.steps.length} recorded step(s) — setup doc and lockfiles unchanged`);
		let allOk = true;
		const steps: SetupStep[] = [];
		for (const step of record.steps) {
			const r = await runStep(step, workCwd, env, stepTimeoutMs);
			steps.push({ ...step, seconds: Math.round(r.seconds) });
			onProgress?.(`  ${r.ok ? "ok" : "FAILED"} (${Math.round(r.seconds)}s) ${step.dir}: ${step.cmd}`);
			if (!r.ok) {
				allOk = false;
				notes.push(`replay failed at "${step.cmd}": ${r.out.slice(-300)}`);
				break;
			}
		}
		if (allOk) {
			const produced = observeProduced(workCwd);
			return { ok: true, mode: "replay", steps, ...produced, verifyCommand: verifyOf(record.verify), notes, costUsd: 0 };
		}
		// Fall through to the agent — a failed replay means the world moved and the doc,
		// or our record of it, needs repairing.
		onProgress?.("replay failed — waking the setup agent to diagnose and repair");
	}

	// ── Agent: first run, changed inputs, or a broken replay ────────────────────────────
	const resolved = getModel(spec.provider as KnownProvider, spec.modelId);
	if (!resolved) return { ok: false, mode: "agent", steps: [], binDirs: [], sourceRoots: [], notes, costUsd: 0, error: `setup model not found: ${spec.provider}/${spec.modelId}` };

	const agent = new Agent({
		initialState: {
			systemPrompt: SETUP_SYSTEM_PROMPT,
			model: resolved,
			thinkingLevel: "off",
			tools: createCodingTools(workCwd, { bash: { spawnHook: (ctx) => ({ ...ctx, env }) } }),
		},
		streamFn,
		getApiKey: (provider: string) => getEnvApiKey(provider),
	});

	let costUsd = 0;
	let aborted = false;
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			if (msg.usage?.cost?.total) costUsd += msg.usage.cost.total;
			if (costUsd >= budgetUsd && !aborted) {
				aborted = true;
				agent.abort();
			}
		} else if (event.type === "tool_execution_start" && event.toolName === "bash") {
			const cmd = (event.args as { command?: string } | undefined)?.command;
			if (cmd) onProgress?.(`  $ ${cmd.slice(0, 110)}`);
		}
	});

	const docNote = docRel
		? `The repo's setup instructions are at: ${docRel}\nRead it first and follow it.`
		: `This repo has NO setup doc. Work out how to set it up from its manifests and lockfiles, then CREATE SETUP.md describing exactly what you did.`;

	onProgress?.(`setup agent working${docRel ? ` from ${docRel}` : " (no setup doc — will create one)"}`);
	try {
		await agent.prompt(`Set up this worktree so a coding agent can build, run and test it.

WORKTREE: ${workCwd}
${docNote}

Set it up, verify it, correct the doc if it was wrong, then emit your setup block.`);
	} catch (err) {
		notes.push(`setup agent errored: ${err instanceof Error ? err.message : String(err)}`);
	}
	await agent.waitForIdle();

	const parsed = parseSetupBlock(finalAssistantText(agent.state.messages));
	if (!parsed) {
		const produced = observeProduced(workCwd);
		notes.push("setup agent emitted no parseable setup block — recording nothing, so the next run re-runs the agent");
		return { ok: produced.binDirs.length > 0, mode: "agent", steps: [], ...produced, notes, costUsd, error: "no setup block" };
	}

	const produced = observeProduced(workCwd);
	notes.push(...(parsed.notes ?? []));
	if (aborted) notes.push(`setup agent hit its $${budgetUsd} budget and was stopped`);

	// Only record a replayable setup when the agent says it worked AND we can see evidence of it.
	// Recording a failed setup would make every future worktree replay a broken install.
	if (parsed.ok && parsed.steps?.length) {
		writeRecord({
			repo: targetCwd,
			inputsHash: inputsHash(workCwd, findSetupDoc(workCwd)),
			docPath: findSetupDoc(workCwd) ?? "",
			recordedAt: new Date().toISOString(),
			steps: parsed.steps,
			verify: parsed.verify ?? undefined,
			produced,
		});
		onProgress?.(`recorded ${parsed.steps.length} step(s) for replay`);
	}

	return {
		ok: Boolean(parsed.ok),
		mode: "agent",
		steps: parsed.steps ?? [],
		verifyCommand: verifyOf(parsed.verify ?? undefined),
		...produced,
		docUpdated: parsed.docUpdated ?? undefined,
		notes,
		costUsd,
	};
}

/** A verify step becomes a shell command the validator can run from the worktree root. */
function verifyOf(step?: SetupStep | null): string | undefined {
	if (!step?.cmd) return undefined;
	return step.dir && step.dir !== "." ? `cd ${step.dir} && ${step.cmd}` : step.cmd;
}

interface RawSetup {
	ok?: boolean;
	steps?: SetupStep[];
	verify?: SetupStep | null;
	docUpdated?: string | null;
	notes?: string[];
}

function parseSetupBlock(text: string): RawSetup | null {
	const fence = text.match(/```setup\s*\n([\s\S]*?)```/);
	const body = fence?.[1] ?? text;
	try {
		const parsed = JSON.parse(body) as RawSetup;
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		const loose = body.match(/\{[\s\S]*\}/);
		if (!loose) return null;
		try {
			return JSON.parse(loose[0]) as RawSetup;
		} catch {
			return null;
		}
	}
}

function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const parts: string[] = [];
		for (const c of (m as AssistantMessage).content) if (c.type === "text") parts.push(c.text);
		const text = parts.join("\n").trim();
		if (text) return text;
	}
	return "";
}
