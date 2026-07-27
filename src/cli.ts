#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import chalk from "chalk";
import { runClient } from "./client.js";
import { cmuxOpenBrowser, cmuxOpenDiff, hasCmuxPassword, insideCmux } from "./cmux.js";
import { runControl } from "./control.js";
import { generateBriefing } from "./briefing.js";
import { generateChangelog } from "./changelog.js";
import { missionDebrief, renderBriefing } from "./diagram-text.js";
import { runDaemon } from "./daemon.js";
import { runMission } from "./mission.js";
import { autoRouting } from "./models.js";
import { StateStore } from "./state.js";
import { runBoardTui } from "./tui.js";
import type { MissionConfig } from "./types.js";
import { ytDlpPath } from "./youtube.js";

interface Flags {
	cmd: string;
	target: string;
	goal: string;
	rfc: string;
	budget: number;
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
	socket?: string;
}

function parseArgs(argv: string[]): Flags {
	const f: Flags = {
		cmd: argv[0] && !argv[0].startsWith("-") ? argv[0] : "chat",
		target: process.cwd(),
		goal: "",
		rfc: "",
		budget: 8,
		maxFeatures: 1,
		maxMilestones: 3,
		queries: [],
		maxVideos: 4,
		open: false,
		help: false,
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
		else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
	}
	return f;
}

function help(): void {
	process.stdout.write(`missions — your engineering org

Usage:
  missions [--target <repo>]                     Mission control: chat with the chief (left) + live board (right). Tab switches focus.
  missions peek [--target <repo>]                Read-only board TUI, no chief attached (quick glance)
  missions attach [--target <repo>]              Text-only chief chat, no board pane (dumb terminals)
  missions run --target <repo> --goal "..." [--rfc @file|text] [flags]   Non-interactive single mission
  missions status --out <mission-out-dir>
  missions changelog [--target <repo>]            Regenerate CHANGELOG.md from every mission's state.json
  missions brief [--target <repo>] [--query "..."] [--max-videos <n>]   Watch recent talks, ground every claim against this repo

Flags:
  --target <path>     Target repo to work on (default: cwd)
  --goal "<text>"     Mission goal (run)
  --rfc <@file|text>  What's wrong / what you want (@file to read a file)
  --budget <usd>      Total USD budget (default: 8)
  --max-features <n>  Features executed per milestone (default: 1)
  --max-milestones <n> Corrective rounds before stopping for a human (default: 3)
  --query "<text>"    Briefing search query (repeatable; defaults to harness-design queries)
  --max-videos <n>    Transcripts to read per briefing (default: 4)
  --check "<cmd>"     Extra scrutiny command (e.g. "npm test")
  --nadine|--generic  Force target adapter (default: auto-detect)
  --out <path>        Where to write state.json/report.html (default: <target>/.missions/runs/<id>)
  --branch <name>     Work branch (default: missions/<date>)
  --open              Open report.html when done
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

function openFile(path: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	spawn(opener, [path], { detached: true, stdio: "ignore" }).unref();
}

async function runOne(config: MissionConfig, open: boolean): Promise<void> {
	process.stdout.write(
		`${chalk.bold("mission")} → ${chalk.dim(config.targetCwd)} [${config.target}] budget $${config.budgetUsd} · ${config.routing.worker.provider}:${config.routing.worker.modelId}\n\n`,
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
