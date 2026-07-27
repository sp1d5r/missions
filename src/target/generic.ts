import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BehavioralResult, Target, WorktreeBootstrapSpec } from "./types.js";

/** Gitignored things almost every repo has and no worktree inherits. Missing entries are skipped. */
const COMMON_ENV_FILES = [".env", ".env.local"];
// Venvs bake absolute paths into their scripts, so they are shared read-only.
const COMMON_LINK_DIRS = [".venv", "venv"];
// node_modules is what a worker installs into — cloned so an install stays in this worktree.
const COMMON_CLONE_DIRS = ["node_modules"];

export function topLevelRecon(cwd: string): string {
	const entries = readdirSync(cwd, { withFileTypes: true })
		.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		.sort()
		.slice(0, 60);
	const lines = [`entries: ${entries.join(", ")}`];
	for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
		const p = join(cwd, manifest);
		if (existsSync(p)) lines.push(`\n${manifest}:\n${readFileSync(p, "utf-8").slice(0, 800)}`);
	}
	return lines.join("\n");
}

export const genericTarget: Target = {
	name: "generic",
	recon: topLevelRecon,
	defaultCheckCommand(cwd) {
		if (existsSync(join(cwd, "package.json"))) {
			try {
				const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
				if (pkg.scripts?.test) return "npm test";
				if (pkg.scripts?.typecheck) return "npm run typecheck";
			} catch {
				/* ignore */
			}
		}
		return undefined;
	},
	bootstrapSpec(cwd): WorktreeBootstrapSpec {
		// Only top level, and only what is actually there — a generic repo gets no guesses
		// about its layout, just the env and dependency dirs a worktree provably lacks.
		return {
			envFiles: COMMON_ENV_FILES.filter((f) => existsSync(join(cwd, f))),
			linkDirs: COMMON_LINK_DIRS.filter((d) => existsSync(join(cwd, d))),
			cloneDirs: COMMON_CLONE_DIRS.filter((d) => existsSync(join(cwd, d))),
			sourceRoots: [],
		};
	},
	async runBehavioral(): Promise<BehavioralResult> {
		return { ran: false, passed: true, evidence: "No behavioral adapter for generic target (skipped)." };
	},
};
