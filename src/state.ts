import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionConfig, MissionState } from "./types.js";

/** Persists MissionState to <outDir>/state.json and a tail-able <outDir>/mission.log. */
export class StateStore {
	private readonly statePath: string;
	private readonly logPath: string;
	state: MissionState;

	constructor(outDir: string, state: MissionState) {
		mkdirSync(outDir, { recursive: true });
		this.statePath = join(outDir, "state.json");
		this.logPath = join(outDir, "mission.log");
		this.state = state;
	}

	static create(outDir: string, config: MissionConfig): StateStore {
		const id = `m-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		const state: MissionState = {
			id,
			startedAt: new Date().toISOString(),
			goal: config.goal,
			rfc: config.rfc,
			status: "planning",
			branch: config.branch,
			targetCwd: config.targetCwd,
			features: [],
			handoffs: [],
			milestones: [],
			commits: [],
			costUsd: 0,
			log: [],
		};
		return new StateStore(outDir, state);
	}

	static load(outDir: string): StateStore | null {
		const p = join(outDir, "state.json");
		if (!existsSync(p)) return null;
		const state = JSON.parse(readFileSync(p, "utf-8")) as MissionState;
		return new StateStore(outDir, state);
	}

	save(): void {
		writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
	}

	/** Log to state + append to the tail-able file, and echo to stdout. */
	log(message: string): void {
		const line = `[${new Date().toISOString()}] ${message}`;
		this.state.log.push(line);
		appendFileSync(this.logPath, `${line}\n`);
		this.save();
	}
}
