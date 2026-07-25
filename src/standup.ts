import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { DailyState } from "./types.js";

function dailyPath(targetCwd: string): string {
	return join(targetCwd, ".missions", "standup.json");
}

function loadYesterday(targetCwd: string): DailyState | null {
	const p = dailyPath(targetCwd);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as DailyState;
	} catch {
		return null;
	}
}

function saveDaily(targetCwd: string, state: DailyState): void {
	const p = dailyPath(targetCwd);
	mkdirSync(join(targetCwd, ".missions"), { recursive: true });
	writeFileSync(p, JSON.stringify(state, null, 2));
}

export interface StandupResult {
	goal: string;
	rfc: string;
	daily: DailyState;
}

/** The morning ritual: leftovers, priorities, mood, then scope one mission. */
export async function runStandup(targetCwd: string): Promise<StandupResult | null> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const yesterday = loadYesterday(targetCwd);
		process.stdout.write(`\n${chalk.bold("☀  Standup")} ${chalk.dim(targetCwd)}\n\n`);
		if (yesterday) {
			process.stdout.write(`${chalk.dim(`Yesterday (${yesterday.date}) — mood: ${yesterday.mood || "—"}`)}\n`);
			if (yesterday.priorities.length) {
				process.stdout.write(`${chalk.dim("Yesterday's priorities:")}\n`);
				for (const p of yesterday.priorities) process.stdout.write(`  ${chalk.dim(`• ${p}`)}\n`);
			}
			process.stdout.write("\n");
		}

		const mood = (await rl.question(chalk.bold("How are you feeling? "))).trim();
		const leftovers = yesterday?.priorities ?? [];
		const leftoverLine = leftovers.length
			? (await rl.question(chalk.bold(`Anything still open from yesterday? (comma-sep, or blank) `))).trim()
			: "";
		const priorities = (await rl.question(chalk.bold("Top priorities today? (comma-sep) "))).trim();

		process.stdout.write(`\n${chalk.bold("Scope one mission for an agent to run now.")}\n`);
		const goal = (await rl.question(chalk.bold("Goal (one line): "))).trim();
		if (!goal) {
			process.stdout.write(chalk.yellow("No goal given — skipping mission.\n"));
			return null;
		}
		process.stdout.write(chalk.bold("RFC — what's wrong / what you want. End with an empty line:\n"));
		const rfcLines: string[] = [];
		for (;;) {
			const line = await rl.question("");
			if (line.trim() === "") break;
			rfcLines.push(line);
		}

		const daily: DailyState = {
			date: new Date().toISOString().slice(0, 10),
			priorities: priorities ? priorities.split(",").map((s) => s.trim()).filter(Boolean) : [],
			leftovers: leftoverLine ? leftoverLine.split(",").map((s) => s.trim()).filter(Boolean) : [],
			mood,
			missionIds: [],
		};
		saveDaily(targetCwd, daily);

		return { goal, rfc: rfcLines.join("\n"), daily };
	} finally {
		rl.close();
	}
}

export function recordMissionInDaily(targetCwd: string, missionId: string): void {
	const daily = loadYesterday(targetCwd);
	if (!daily) return;
	daily.missionIds.push(missionId);
	saveDaily(targetCwd, daily);
}
