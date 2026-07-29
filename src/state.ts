import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Seat } from "./seats.js";
import type { MissionConfig, MissionEvent, MissionEventKind, MissionState } from "./types.js";

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
			// Recorded at creation so the changelog can attribute every commit to a seat
			// and say why the mission was attempted. Neither is recoverable from the diff.
			origin: config.origin ?? { kind: "human" },
			routing: config.routing,
			features: [],
			handoffs: [],
			milestones: [],
			commits: [],
			costUsd: 0,
			log: [],
			events: [],
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

	/**
	 * Append a structured event to the event log (used by the timeline pane).
	 *
	 * `seat` is who posted it and `thread` groups an event with its detail events. Both are
	 * optional so the dozens of existing call sites keep compiling, but a caller that knows the
	 * answer should say so — see seats.ts on why recorded attribution beats guessing.
	 */
	appendEvent(kind: MissionEventKind, label: string, detail?: string, opts?: { seat?: Seat; thread?: string }): void {
		const event: MissionEvent = { at: new Date().toISOString(), kind, label, detail, seat: opts?.seat, thread: opts?.thread };
		if (!this.state.events) this.state.events = [];
		this.state.events.push(event);
		this.save();
	}
}
