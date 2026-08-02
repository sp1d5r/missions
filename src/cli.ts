#!/usr/bin/env node
import { getEnvApiKey } from "./pi.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { runClient } from "./client.js";
import { cmuxOpenBrowser, cmuxOpenDiff, hasCmuxPassword, insideCmux } from "./cmux.js";
import { runControl } from "./control.js";
import { generateBriefing } from "./briefing.js";
import { generateChangelog } from "./changelog.js";
import { missionDebrief, renderBriefing } from "./diagram-text.js";
import { runDaemon, stopOrg } from "./daemon.js";
import { runMission, resumeMission, isHarnessStale } from "./mission.js";
import { forgetWorkspace, listWorkspaces, registerWorkspace } from "./workspaces.js";
import { deepClean, humanBytes, renderSweep, sweep } from "./lifecycle.js";
import { renderRun, runRoutine } from "./routine-run.js";
import { clearLedger, dueRoutines, isDue, ledgerSize, listRoutines, recentRuns, removeRoutine, saveRoutine, type Routine, type RoutineKind } from "./routines.js";
import { autoRouting } from "./models.js";
import { StateStore } from "./state.js";
import { runBoardTui } from "./tui.js";
import { runMissionView } from "./mission-view.js";
import type { MissionConfig } from "./types.js";
import { ytDlpPath } from "./youtube.js";

interface Flags {
	cmd: string;
	target: string;
	goal: string;
	rfc: string;
	/** Hard spending cap. undefined = uncapped, which is the default. */
	budget: number | undefined;
	maxFeatures: number;
	maxMilestones: number;
	queries: string[];
	maxVideos: number;
	out?: string;
	branch?: string;
	check?: string;
	targetKind?: "generic" | "nadine";
	open: boolean;
	help: boolean;
	/** gc only: also prune shared package-manager caches (machine-wide). */
	deep: boolean;
	/** routine add: minutes between runs. */
	every?: number;
	/** routine add: let it start missions itself. */
	dispatchAuto: boolean;
	/** gc only: report what would be removed and touch nothing. */
	dryRun: boolean;
	socket?: string;
	/** Non-flag arguments after the command, e.g. `missions forget nadine`. */
	args: string[];
}

function parseArgs(argv: string[]): Flags {
	const f: Flags = {
		cmd: argv[0] && !argv[0].startsWith("-") ? argv[0] : "chat",
		target: process.cwd(),
		goal: "",
		rfc: "",
		budget: undefined,
		maxFeatures: 1,
		maxMilestones: 3,
		queries: [],
		maxVideos: 4,
		open: false,
		help: false,
		deep: false,
		dispatchAuto: false,
		dryRun: false,
		args: [],
	};
	const rest = f.cmd === argv[0] ? argv.slice(1) : argv;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (!a) continue;
		const next = () => {
			const v = rest[++i];
			if (v == null) throw new Error(`${a} requires a value`);
			return v;
		};
		if (a === "-h" || a === "--help") f.help = true;
		else if (a === "--target") f.target = resolve(next());
		else if (a === "--goal") f.goal = next();
		else if (a === "--rfc") f.rfc = next();
		else if (a === "--budget") f.budget = Number.parseFloat(next());
		else if (a === "--max-features") f.maxFeatures = Number.parseInt(next(), 10);
		else if (a === "--max-milestones") f.maxMilestones = Number.parseInt(next(), 10);
		else if (a === "--query") f.queries.push(next());
		else if (a === "--max-videos") f.maxVideos = Number.parseInt(next(), 10);
		else if (a === "--out") f.out = resolve(next());
		else if (a === "--branch") f.branch = next();
		else if (a === "--check") f.check = next();
		else if (a === "--socket") f.socket = next();
		else if (a === "--nadine") f.targetKind = "nadine";
		else if (a === "--generic") f.targetKind = "generic";
		else if (a === "--open") f.open = true;
		else if (a === "--dry-run") f.dryRun = true;
		else if (a === "--deep") f.deep = true;
		else if (a === "--every") f.every = Number.parseInt(next(), 10);
		else if (a === "--dispatch") f.dispatchAuto = true;
		else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
		else f.args.push(a);
	}
	return f;
}

function help(): void {
	process.stdout.write(`missions — your engineering org

Usage:
  missions [--target <repo>]                     Mission control: chat with the chief (left) + live board (right). Tab switches focus.
  missions repos                                 List every repo the org knows about
  missions forget <name>                         Drop a repo from the org (e.g. a throwaway sandbox)
  missions stop                                  Stop the org (running missions are abandoned)
  missions gc [--target <repo>] [--dry-run] [--deep]  Reclaim worktrees from finished missions; delete merged branches
  missions peek [--target <repo>]                Read-only board TUI, no chief attached (quick glance)
  missions resume <runId> [--budget <usd>] [--max-milestones <n>] [--out <dir>]   Resume a stalled/exhausted/ceiling mission
  missions view <runId> [--out <dir>]            Per-mission TUI: timeline · log tail · overseer chat
  missions attach [--target <repo>]              Text-only chief chat, no board pane (dumb terminals)
  missions run --target <repo> --goal "..." [--rfc @file|text] [flags]   Non-interactive single mission
  missions status --out <mission-out-dir>
  missions changelog [--target <repo>]            Regenerate CHANGELOG.md from every mission's state.json
  missions brief [--target <repo>] [--query "..."] [--max-videos <n>]   Watch recent talks, ground every claim against this repo

Standing orders — recurring work the org does without being asked (research / plan / bugbash):
  missions routine list                          What is scheduled, when it last ran, what it found
  missions routine add <kind> [id] [--target <repo>] [--every <min>] [--goal "scope"] [--dispatch]
  missions routine run [id] [--dry-run]          Run now (no id = everything due)
  missions routine log                           Recent runs
  missions routine forget [id]                   Clear the "already told you" ledger so findings resurface
  missions routine rm <id>

Flags:
  --target <path>     Target repo to work on (default: cwd)
  --goal "<text>"     Mission goal (run)
  --rfc <@file|text>  What's wrong / what you want (@file to read a file)
  --budget <usd>      Hard spending cap (default: none — spend is recorded, not capped)
  --max-features <n>  Features executed per milestone (default: 1)
  --max-milestones <n> Corrective rounds before stopping for a human (default: 3)
  --query "<text>"    Briefing search query (repeatable; defaults to harness-design queries)
  --max-videos <n>    Transcripts to read per briefing (default: 4)
  --check "<cmd>"     Extra scrutiny command (e.g. "npm test")
  --nadine|--generic  Force target adapter (default: auto-detect)
  --out <path>        Where to write state.json/report.html (default: <target>/.missions/runs/<id>)
  --branch <name>     Work branch (default: missions/<date>)
  --open              Open report.html when done
  --dry-run           gc: show what would be reclaimed, delete nothing
  --deep              gc: ALSO prune shared pnpm/npm/uv caches (machine-wide, affects all your checkouts)
  -h, --help          This help

Env: ANTHROPIC_API_KEY required. OPENAI_API_KEY enables cross-provider bug-spotter. GEMINI_API_KEY for Nadine judges.
`);
}

function resolveRfc(raw: string): string {
	if (raw.startsWith("@")) {
		const p = resolve(raw.slice(1));
		if (existsSync(p)) return readFileSync(p, "utf-8");
		throw new Error(`RFC file not found: ${p}`);
	}
	return raw;
}

function buildConfig(f: Flags, goal: string, rfc: string): MissionConfig {
	const targetKind = f.targetKind ?? (/nadine|naomi/i.test(basename(f.target)) ? "nadine" : "generic");
	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	return {
		goal,
		rfc,
		targetCwd: f.target,
		branch: f.branch ?? `missions/${new Date().toISOString().slice(0, 10)}`,
		budgetUsd: f.budget,
		outDir: f.out ?? resolve(f.target, ".missions", "runs", runId),
		routing: autoRouting(),
		maxFeatures: f.maxFeatures,
		maxMilestones: f.maxMilestones,
		checkCommand: f.check,
		target: targetKind,
	};
}

/**
 * Standing orders. Sub-commands rather than flags because these are nouns you
 * manage over time, not one-shot options.
 */
async function routineCommand(f: Flags): Promise<void> {
	const sub = f.args[0] ?? "list";
	const out = process.stdout;

	if (sub === "list") {
		const all = listRoutines();
		if (!all.length) {
			out.write(chalk.dim("no standing orders yet\n\n"));
			out.write(`  ${chalk.bold("missions routine add")} <research|plan|bugbash> [--target <repo>] [--every <minutes>] [--scope "..."] [--dispatch]\n`);
			return;
		}
		for (const r of all) {
			const when = r.lastRunAt ? `last ${new Date(r.lastRunAt).toLocaleString()}` : "never run";
			const due = isDue(r) ? chalk.cyan(" · due") : "";
			out.write(
				`${r.enabled ? chalk.bold("●") : chalk.dim("○")} ${chalk.bold(r.id.padEnd(22))} ${r.kind.padEnd(9)} ${chalk.dim(basename(r.repo).padEnd(14))} ` +
					`${chalk.dim(`every ${r.everyMinutes}m · ${r.autonomy}`)}${due}\n`,
			);
			out.write(chalk.dim(`  ${when}${r.lastSummary ? ` — ${r.lastSummary}` : ""}\n`));
		}
		out.write(chalk.dim(`\n  ledger holds ${ledgerSize()} finding(s) already reported\n`));
		return;
	}

	if (sub === "add") {
		const kind = f.args[1] as RoutineKind | undefined;
		if (!kind || !["research", "plan", "bugbash"].includes(kind)) {
			throw new Error("routine add requires a kind: research | plan | bugbash");
		}
		const repo = resolve(f.target);
		registerWorkspace(repo);
		const id = f.args[2] ?? `${kind}-${basename(repo)}`;
		const r: Routine = {
			id,
			kind,
			repo,
			// Daily by default. These are jobs you would do on a Sunday, not a poller.
			everyMinutes: f.every ?? 24 * 60,
			autonomy: f.dispatchAuto ? "dispatch" : "propose",
			enabled: true,
			queries: f.queries.length ? f.queries : undefined,
			scope: f.goal || undefined,
			maxUsd: f.budget,
		};
		saveRoutine(r);
		out.write(`${chalk.bold("added")} ${r.id} — ${r.kind} on ${basename(repo)}, every ${r.everyMinutes}m, ${chalk.bold(r.autonomy)}\n`);
		if (r.autonomy === "dispatch") out.write(chalk.yellow("  it will START missions on its own. They land on branches and are never merged.\n"));
		return;
	}

	if (sub === "rm") {
		const id = f.args[1];
		if (!id) throw new Error("routine rm requires an id");
		out.write(removeRoutine(id) ? `removed ${id}\n` : chalk.yellow(`no routine "${id}"\n`));
		return;
	}

	if (sub === "run") {
		const id = f.args[1];
		const all = listRoutines();
		const chosen = id ? all.filter((r) => r.id === id) : dueRoutines();
		if (!chosen.length) {
			out.write(chalk.dim(id ? `no routine "${id}"\n` : "nothing due\n"));
			return;
		}
		for (const r of chosen) {
			const run = await runRoutine(r, { dryRun: f.dryRun, onProgress: (m) => out.write(chalk.dim(`  ${m}\n`)) });
			out.write(`\n${renderRun(run).join("\n")}\n`);
		}
		return;
	}

	if (sub === "forget") {
		const n = clearLedger(f.args[1]);
		out.write(`forgot ${n} recorded finding(s)${f.args[1] ? ` for ${f.args[1]}` : ""} — they may surface again\n`);
		return;
	}

	if (sub === "log") {
		const runs = recentRuns(15);
		if (!runs.length) return void out.write(chalk.dim("no runs yet\n"));
		for (const r of runs) {
			out.write(`${chalk.dim(new Date(r.at).toLocaleString())} ${chalk.bold(r.routineId)} ${chalk.dim(`$${r.costUsd.toFixed(3)}`)}\n`);
			out.write(`  ${r.findings.length} new${r.repeats ? `, ${r.repeats} suppressed` : ""}${r.note ? ` — ${r.note}` : ""}\n`);
		}
		return;
	}

	throw new Error(`unknown: missions routine ${sub}. Try list | add | rm | run | forget | log`);
}

function openFile(path: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	spawn(opener, [path], { detached: true, stdio: "ignore" }).unref();
}

async function runOne(config: MissionConfig, open: boolean): Promise<void> {
	registerWorkspace(config.targetCwd);
	process.stdout.write(
		`${chalk.bold("mission")} → ${chalk.dim(config.targetCwd)} [${config.target}] ${config.budgetUsd === undefined ? "uncapped" : `cap $${config.budgetUsd}`} · ${config.routing.worker.provider}:${config.routing.worker.modelId}\n\n`,
	);
	const state = await runMission(config, (e) => {
		if (e.type === "status") process.stdout.write(`${chalk.cyan("▶")} ${chalk.bold(e.status)}\n`);
		else process.stdout.write(`  ${chalk.dim(e.message)}\n`);
	});
	// The debrief IS the summary — same facts as report.html, for when there is no browser.
	process.stdout.write(`${missionDebrief(state, process.stdout.columns ?? 92).join("\n")}\n`);
	if (state.reportPath) {
		process.stdout.write(`  ${chalk.bold("report:")} ${state.reportPath}\n`);
		presentReview(state.reportPath, config.targetCwd, state.baseSha, open);
	}
}

/** Review in cmux when we can (rendered report + diff surface); otherwise the browser if --open. */
function presentReview(reportPath: string, cwd: string, baseSha: string | undefined, open: boolean): void {
	if (insideCmux() && hasCmuxPassword()) {
		const okReport = cmuxOpenBrowser(reportPath);
		const okDiff = baseSha ? cmuxOpenDiff(cwd, baseSha) : false;
		if (okReport || okDiff) {
			process.stdout.write(`  ${chalk.cyan("→ cmux")}: ${okReport ? "report" : ""}${okReport && okDiff ? " + " : ""}${okDiff ? "diff surface" : ""}\n`);
			return;
		}
		process.stdout.write(`  ${chalk.yellow("cmux open failed")} (check CMUX_SOCKET_PASSWORD) — falling back\n`);
	} else if (insideCmux() && !hasCmuxPassword()) {
		process.stdout.write(`  ${chalk.dim("tip: export CMUX_SOCKET_PASSWORD to review the report + diff inside cmux")}\n`);
	}
	if (open) openFile(reportPath);
}

async function main(): Promise<void> {
	let f: Flags;
	try {
		f = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${chalk.red((err as Error).message)}\n\n`);
		help();
		process.exit(2);
	}
	if (f.help) {
		help();
		return;
	}

	// Internal: the persistent org process. Spawned detached by the client.
	if (f.cmd === "__daemon") {
		if (!f.socket) throw new Error("__daemon requires --socket");
		await runDaemon(f.target, f.socket);
		return;
	}

	if (f.cmd === "changelog") {
		const { path, entries } = generateChangelog(f.target, basename(f.target));
		process.stdout.write(`${chalk.bold("changelog")} → ${path} ${chalk.dim(`(${entries} mission(s))`)}\n`);
		return;
	}

	if (f.cmd === "brief") {
		if (!getEnvApiKey("anthropic")) {
			process.stderr.write(`${chalk.red("Missing ANTHROPIC_API_KEY")}\n`);
			process.exit(1);
		}
		if (!ytDlpPath()) {
			process.stderr.write(`${chalk.red("yt-dlp not found")} — install it with ${chalk.bold("brew install yt-dlp")}\n`);
			process.exit(1);
		}
		const b = await generateBriefing({
			repo: f.target,
			queries: f.queries,
			maxVideos: f.maxVideos,
			onProgress: (m) => process.stdout.write(`  ${chalk.dim(m)}\n`),
		});
		process.stdout.write(`${renderBriefing(b).join("\n")}\n`);
		return;
	}

	if (f.cmd === "repos") {
		// Registering here means `missions repos` in a new checkout also adopts it.
		registerWorkspace(f.target);
		for (const w of listWorkspaces()) {
			process.stdout.write(`${w.path === resolve(f.target) ? chalk.bold("▸") : " "} ${chalk.bold(w.name.padEnd(18))} ${chalk.dim(w.path)}\n`);
		}
		return;
	}

	if (f.cmd === "forget") {
		const ref = f.args[0] ?? f.goal;
		if (!ref) throw new Error("forget requires a repo: missions forget <name-or-path>");
		const gone = forgetWorkspace(ref);
		process.stdout.write(gone ? `${chalk.bold("forgot")} ${gone.name} ${chalk.dim(gone.path)}\n` : chalk.yellow(`no workspace matches "${ref}"\n`));
		return;
	}

	if (f.cmd === "gc") {
		// Default to every registered repo: a leak you have to remember to look for
		// in each workspace is a leak. `--target` narrows it to one.
		const repos = f.args.includes("--here") || f.target !== process.cwd() ? [resolve(f.target)] : undefined;
		const dry = f.dryRun;
		process.stdout.write(`${chalk.bold("gc")} ${chalk.dim(dry ? "(dry run — nothing will be deleted)" : "")}\n`);
		const result = sweep({ repos, dryRun: dry });
		process.stdout.write(`${renderSweep(result, dry).join("\n")}\n`);
		if (f.args.includes("--deep") || f.deep) {
			process.stdout.write(chalk.dim("\n  shared package caches (machine-wide — also used by your normal checkouts):\n"));
			for (const s of deepClean(dry)) {
				const detail = s.note ?? (s.freedBytes ? `freed ${humanBytes(s.freedBytes)}` : "nothing to prune");
				process.stdout.write(`  ${s.ran ? "ran" : chalk.dim("skipped")} ${s.command} ${chalk.dim(`— ${detail}`)}\n`);
			}
		}
		if (dry && (result.reclaimed.some((r) => !r.skipped) || result.droppedRecords)) {
			process.stdout.write(chalk.dim("\n  run without --dry-run to apply\n"));
		}
		return;
	}

	if (f.cmd === "routine") {
		await routineCommand(f);
		return;
	}

	if (f.cmd === "stop") {
		const n = stopOrg();
		process.stdout.write(n ? `${chalk.bold("stopped")} ${n} org process(es)\n` : chalk.dim("no org running\n"));
		return;
	}

	if (f.cmd === "peek") {
		// No-chat, read-only board (handy for a quick glance without attaching the chief).
		await runBoardTui();
		return;
	}

	if (f.cmd === "status") {
		if (!f.out) throw new Error("status requires --out <mission-out-dir>");
		const store = StateStore.load(f.out);
		if (!store) throw new Error(`No state.json in ${f.out}`);
		const s = store.state;
		process.stdout.write(`${missionDebrief(s, process.stdout.columns ?? 92).join("\n")}\n`);
		process.stdout.write(chalk.dim(`  ${s.id} · ${s.status}\n`));
		if (s.reportPath) process.stdout.write(chalk.dim(`  report: ${s.reportPath}\n\n`));
		// Stale daemon check.
		try {
			const thisFile = fileURLToPath(import.meta.url);
			const buildMtime = statSync(thisFile).mtimeMs;
			const { readOrgPid } = await import("./ipc.js");
			const pid = readOrgPid();
			if (pid) {
				// Approximate daemon start as current build time (conservative check).
				if (isHarnessStale(buildMtime - 60_000, buildMtime)) {
					process.stdout.write(chalk.yellow("  ⚠ daemon may be running stale code — run `missions stop && missions` to restart\n"));
				}
			}
		} catch {
			/* stale check is advisory, never fatal */
		}
		return;
	}

	if (f.cmd === "resume") {
		const runIdArg = f.args[0] ?? f.out;
		if (!runIdArg) throw new Error("resume requires a runId or --out <mission-out-dir>");

		// Resolve runId to outDir (same logic as view).
		let outDir: string | undefined;
		if (existsSync(resolve(runIdArg, "state.json"))) {
			outDir = resolve(runIdArg);
		} else {
			const { resolveRunId } = await import("./mission-view.js");
			const resolved = resolveRunId(runIdArg);
			if (resolved) outDir = resolved.outDir;
		}
		if (!outDir) {
			process.stderr.write(chalk.red(`Cannot resolve run "${runIdArg}" — pass a full outDir or a unique runId prefix.\n`));
			process.exit(1);
		}

		if (!getEnvApiKey("anthropic")) {
			process.stderr.write(`${chalk.red("Missing ANTHROPIC_API_KEY")}\n`);
			process.exit(1);
		}

		const opts: import("./mission.js").ResumeMissionOpts = {};
		if (f.budget !== undefined) opts.budget = f.budget; // uncapped unless explicitly asked for
		if (f.maxMilestones !== 3) opts.maxMilestones = f.maxMilestones; // only set if explicitly passed

		process.stdout.write(`${chalk.bold("resume")} → ${chalk.dim(outDir)}\n\n`);
		const state = await resumeMission(outDir, opts, (e) => {
			if (e.type === "status") process.stdout.write(`${chalk.cyan("▶")} ${chalk.bold(e.status)}\n`);
			else process.stdout.write(`  ${chalk.dim(e.message)}\n`);
		});
		process.stdout.write(`${missionDebrief(state, process.stdout.columns ?? 92).join("\n")}\n`);
		if (state.reportPath) {
			process.stdout.write(`  ${chalk.bold("report:")} ${state.reportPath}\n`);
			presentReview(state.reportPath, state.targetCwd, state.baseSha, f.open);
		}
		return;
	}

	if (f.cmd === "view") {
		// Accept either a full outDir (--out) or a runId positional arg (prefix-resolved).
		const runIdArg = f.args[0] ?? f.out;
		if (!runIdArg) throw new Error("view requires a runId or --out <mission-out-dir>");
		// If it looks like a path with state.json, use it directly.
		let outDir: string | undefined;
		if (existsSync(resolve(runIdArg, "state.json"))) {
			outDir = resolve(runIdArg);
		} else {
			// Try to resolve as a runId prefix against active records.
			const { resolveRunId } = await import("./mission-view.js");
			const resolved = resolveRunId(runIdArg);
			if (resolved) outDir = resolved.outDir;
		}
		if (!outDir) {
			process.stderr.write(chalk.red(`Cannot resolve run "${runIdArg}" — pass a full outDir or a unique runId prefix.\n`));
			process.exit(1);
		}
		await runMissionView(outDir);
		return;
	}

	if (!getEnvApiKey("anthropic")) {
		process.stderr.write(`${chalk.red("Missing ANTHROPIC_API_KEY")}\n`);
		process.exit(1);
	}

	if (f.cmd === "chat" || f.cmd === "standup" || f.cmd === "board") {
		await runControl(f.target);
		return;
	}

	if (f.cmd === "attach") {
		// Lightweight text-only attach (no board pane) — fallback for dumb terminals.
		await runClient(f.target);
		return;
	}

	if (f.cmd === "run") {
		if (!f.goal) throw new Error("run requires --goal");
		await runOne(buildConfig(f, f.goal, resolveRfc(f.rfc)), f.open);
		return;
	}

	help();
}

main().catch((err) => {
	process.stderr.write(`${chalk.red("Fatal:")} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
