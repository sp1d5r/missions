import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Seat } from "./seats.js";
import type { MissionConfig, MissionEvent, MissionEventKind, MissionState } from "./types.js";

/** Persists MissionState to <outDir>/state.json and a tail-able <outDir>/mission.log. */
export class StateStore {
	private readonly statePath: string;
	private readonly logPath: string;
	readonly outDir: string;
	state: MissionState;

	constructor(outDir: string, state?: MissionState) {
		mkdirSync(outDir, { recursive: true });
		this.outDir = outDir;
		this.statePath = join(outDir, "state.json");
		this.logPath = join(outDir, "mission.log");
		// State is optional so external tools can exercise storage helpers
		// (attachImage in particular) without constructing a full MissionState.
		// A minimal placeholder is fine — save() overwrites state.json on demand.
		this.state = state ?? ({
			id: "",
			startedAt: new Date().toISOString(),
			goal: "",
			rfc: "",
			status: "planning",
			branch: "",
			targetCwd: outDir,
			origin: { kind: "human" },
			features: [],
			handoffs: [],
			milestones: [],
			commits: [],
			costUsd: 0,
			log: [],
			events: [],
		} as MissionState);
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
	appendEvent(
		kind: MissionEventKind,
		label: string,
		detail?: string,
		opts?: { seat?: Seat; thread?: string; image?: MissionEvent["image"] },
	): void {
		const event: MissionEvent = { at: new Date().toISOString(), kind, label, detail, seat: opts?.seat, thread: opts?.thread, image: opts?.image };
		if (!this.state.events) this.state.events = [];
		this.state.events.push(event);
		this.save();
	}

	/**
	 * Content-address an image to <outDir>/images/<sha256>.<ext>.
	 *
	 * Idempotent: if the file is already on disk (same sha256), returns the existing path
	 * without rewriting. Returns the path and byte count.
	 */
	attachImage(data: Buffer, mimeType: string): { path: string; bytes: number } {
		const sha = createHash("sha256").update(data).digest("hex");
		const ext = mimeTypeToExt(mimeType);
		const imagesDir = join(this.outDir, "images");
		mkdirSync(imagesDir, { recursive: true });
		const filePath = join(imagesDir, `${sha}.${ext}`);
		if (!existsSync(filePath)) {
			writeFileSync(filePath, data);
		}
		// Return a path relative to outDir so callers can build URLs directly
		// (e.g. images/<sha>.<ext>) and external verifiers can locate the file
		// with join(outDir, result.path). Callers reading the file should also
		// resolve against outDir; this keeps stored event.image.path portable.
		return { path: `images/${sha}.${ext}`, bytes: data.length };
	}
}

/** Map a mime type to a safe file extension for storage. */
function mimeTypeToExt(mimeType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/svg+xml": "svg",
		"image/bmp": "bmp",
		"image/tiff": "tiff",
	};
	return map[mimeType.toLowerCase()] ?? "bin";
}
