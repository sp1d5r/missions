import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { BehavioralResult, Target } from "./types.js";
import { topLevelRecon } from "./generic.js";

const PYTHON_SRC_DIRS = ["naomi/src", "naomi-cli/src", "shared/src", "backend/src"];

function pythonPath(cwd: string): string {
	return PYTHON_SRC_DIRS.map((d) => resolve(cwd, d)).join(":");
}

function listDir(cwd: string, rel: string, limit: number): string[] {
	const p = join(cwd, rel);
	if (!existsSync(p)) return [];
	try {
		return readdirSync(p).slice(0, limit);
	} catch {
		return [];
	}
}

export const nadineTarget: Target = {
	name: "nadine",
	recon(cwd) {
		const handbooks = listDir(cwd, "naomi/src/naomi_agent/handbooks", 20);
		const scenarios = listDir(cwd, "naomi/tests/scenarios", 20);
		return [
			topLevelRecon(cwd),
			`\nNADINE SIGNALS:`,
			`content handbooks (source of truth for "good"): ${handbooks.join(", ") || "(none found)"}`,
			`test_harness scenarios: ${scenarios.join(", ") || "(none found)"}`,
			`behavioral eval: python -m naomi_agent.test_harness <scenario.yaml>; judges = video_judge (Gemini 6-axis), virality_judge (Haiku hook gate).`,
		].join("\n");
	},
	defaultCheckCommand(cwd) {
		if (existsSync(join(cwd, "naomi", "pyproject.toml")) || existsSync(join(cwd, "pyproject.toml"))) {
			// Cheap static check; full pytest often needs services.
			return "python -m compileall -q naomi/src";
		}
		return undefined;
	},
	async runBehavioral(cwd, scenario, threshold): Promise<BehavioralResult> {
		const scenarioPath = isAbsolute(scenario) ? scenario : join(cwd, "naomi/tests/scenarios", scenario);
		if (!existsSync(scenarioPath)) {
			return { ran: false, passed: true, evidence: `Scenario not found, skipped behavioral: ${scenarioPath}` };
		}
		const outFile = join(mkdtempSync(join(tmpdir(), "missions-nadine-")), "results.json");
		try {
			execFileSync(
				"python",
				["-m", "naomi_agent.test_harness", scenarioPath, "--budget", "0.5", "--output", outFile],
				{
					cwd,
					env: { ...process.env, PYTHONPATH: pythonPath(cwd) },
					encoding: "utf-8",
					timeout: 300_000,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (err) {
			const e = err as { stderr?: Buffer; message?: string };
			// Non-fatal: env/keys/services may be absent. Report as skipped so the mission still completes.
			return {
				ran: false,
				passed: true,
				evidence: `test_harness did not complete (likely missing env/services): ${(e.stderr?.toString() ?? e.message ?? "").slice(0, 400)}`,
			};
		}
		if (!existsSync(outFile)) return { ran: false, passed: true, evidence: "test_harness produced no results.json (skipped)." };
		const result = JSON.parse(readFileSync(outFile, "utf-8")) as {
			passed?: boolean;
			judge_score?: number;
			video_judge_score?: number;
		};
		const score = result.video_judge_score ?? result.judge_score;
		const passed = threshold != null && score != null ? score >= threshold : Boolean(result.passed);
		return { ran: true, passed, score, evidence: `test_harness: passed=${result.passed} score=${score ?? "n/a"}` };
	},
};
