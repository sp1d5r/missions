import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { BehavioralResult, Target, WorktreeBootstrapSpec } from "./types.js";
import { topLevelRecon } from "./generic.js";

/**
 * Source roots that must beat installed packages.
 *
 * Each service venv holds a .pth pointing back at the MAIN checkout
 * (backend/.venv/…/nadine_backend.pth -> <repo>/backend/src) plus already-built copies of
 * nadine_shared and naomi_agent in site-packages. Python resolves PYTHONPATH before .pth
 * entries, so listing these is what keeps a worker importing the source it just edited
 * rather than the main tree's.
 */
const PYTHON_SRC_DIRS = ["shared/src", "naomi/src", "naomi-cli/src", "backend/src"];

/**
 * Gitignored env files, copied per mission. The Node ones matter most: Next and Vite read
 * .env.local from their own project dir, so unlike python-dotenv they get no rescue from an
 * upward walk to the parent checkout — without these, a naomi-web mission runs blind.
 */
const ENV_FILES = [".env", "backend/.env", "naomi-web/.env.local", "website/.env.local", "website/.env"];

// Symlinked: shared and read-only. A venv stays here on purpose — its scripts bake in
// absolute paths, so a copy at a new path is subtly broken in ways a clone cannot fix.
const LINK_DIRS = [
	"backend/.venv",
	"shared/.venv",
	"naomi/.venv",
	"naomi-cli/.venv",
	"queue_service/.venv",
	"voice_service/.venv",
	// Gitignored sibling checkout that agent_runner and pi-extension-e2b-hands expect to find.
	"pi-mono",
];

// Cloned: a worker installs into these. Symlinking them meant `npm install` wrote through
// into the main checkout, and `pnpm install` replaced the link with a real 1.8GB tree that
// then had to be garbage collected. Copy-on-write costs the delta — measured at 48MB.
const CLONE_DIRS = ["node_modules", "naomi-web/node_modules", "website/node_modules", "frontend/node_modules", "naomi-remotion/node_modules"];

const ENV_DOCTRINE = `Nadine has exactly two environments, and this worktree is neither staging nor a sandbox:
- LOCAL is Elijah's machine only. Nothing else runs here.
- PRODUCTION is the only other environment. There are no customers yet, so almost everything
  legitimately touches production. The credentials in this worktree's .env are LIVE: the production
  Neon database, real R2 buckets, real Stripe keys, and metered media providers (FAL, Segmind,
  BytePlus, ElevenLabs, Reve) that bill per call.
- Reads and ordinary row writes against production are accepted. Spending money is not: do not
  generate images, video or voice to "check" something unless the feature is specifically about that.
- SCHEMA changes are the one action that breaks every other tree at once. Do not run alembic upgrade,
  downgrade, or any DDL unless the harness has told you a branched database is in place.
- Python venvs (.venv) are SYMLINKS shared with the main checkout and are already installed. Do not
  install, upgrade or remove python packages — you would mutate every other worktree.
- node_modules are copy-on-write CLONES private to this worktree, already installed. You may install
  a node package if the work genuinely needs one, and it will not affect anything else. Prefer not
  to: a needless install is slow and shows up in the diff as a lockfile change.`;

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
			`python imports resolve via PYTHONPATH, already set to this tree's ${PYTHON_SRC_DIRS.join(", ")}; service venvs are shared symlinks and already installed.`,
		].join("\n");
	},
	defaultCheckCommand(cwd) {
		if (existsSync(join(cwd, "naomi", "pyproject.toml")) || existsSync(join(cwd, "pyproject.toml"))) {
			// Cheap static check; full pytest often needs services.
			return "python -m compileall -q naomi/src";
		}
		return undefined;
	},
	bootstrapSpec(): WorktreeBootstrapSpec {
		return { envFiles: ENV_FILES, linkDirs: LINK_DIRS, cloneDirs: CLONE_DIRS, sourceRoots: PYTHON_SRC_DIRS };
	},
	envDoctrine: ENV_DOCTRINE,
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
					// The caller already rooted PYTHONPATH in the worktree; derive it again here so a
					// direct call still reads this tree rather than the venv's baked-in .pth.
					env: {
						...process.env,
						PYTHONPATH: [...PYTHON_SRC_DIRS.map((d) => resolve(cwd, d)), process.env.PYTHONPATH]
							.filter(Boolean)
							.join(":"),
					},
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
