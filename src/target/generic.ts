import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BehavioralResult, Target } from "./types.js";

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
	async runBehavioral(): Promise<BehavioralResult> {
		return { ran: false, passed: true, evidence: "No behavioral adapter for generic target (skipped)." };
	},
};
