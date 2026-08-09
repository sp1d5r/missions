/**
 * openStore — programmatic access to a mission's event timeline.
 *
 * Designed to be called from validator commands that verify the e2e screenshot
 * pipeline produces a mission with at least one image event in the store.
 *
 * Usage (validator command pattern):
 *   const s = await openStore(missionId);  // or openStore() to auto-detect
 *   const tl = await s.getTimeline();
 *   const hasImg = tl.some(e => e.kind === 'image');
 *
 * When called with no argument (or undefined), the function reads the mission id
 * from the `.mission-e2e/mission-id` file in the current working directory, then
 * resolves the outDir from `.mission-e2e/<id>/`.
 *
 * When called with a mission id that matches a record in the active registry
 * (written by writeActive during a real mission or the e2e script), the outDir
 * from that record is used instead.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readActive } from "./registry.js";
import type { MissionEvent } from "./types.js";

export interface MissionStoreHandle {
	/** Mission id this handle was opened for. */
	id: string;
	/** Absolute path to the mission's output directory. */
	outDir: string;
	/** Return all events from state.json (never throws — returns [] on missing/corrupt file). */
	getTimeline(): Promise<MissionEvent[]>;
}

/**
 * Open a read-only handle to a mission's event store.
 *
 * Resolution order for outDir:
 *   1. Active registry record matching the id (written by writeActive).
 *   2. `.mission-e2e/<id>/` relative to cwd (written by e2e-screenshot.mjs).
 *
 * If no id is supplied, it is read from `.mission-e2e/mission-id` in cwd.
 */
export async function openStore(id?: string): Promise<MissionStoreHandle> {
	const cwd = process.cwd();

	// Resolve mission id
	let missionId = id;
	if (!missionId) {
		const idFile = join(cwd, ".mission-e2e", "mission-id");
		if (!existsSync(idFile)) {
			throw new Error(`openStore: no mission id supplied and ${idFile} does not exist`);
		}
		missionId = readFileSync(idFile, "utf-8").trim();
	}

	// Resolve outDir: active registry first, then .mission-e2e/<id>/
	let outDir: string | undefined;

	// 1. Check active registry
	try {
		const records = readActive();
		const rec = records.find((r) => r.id === missionId);
		if (rec?.outDir) {
			outDir = rec.outDir;
		}
	} catch {
		/* registry may not be initialised in test environments */
	}

	// 2. Fall back to .mission-e2e/<id>/
	if (!outDir) {
		const candidate = join(cwd, ".mission-e2e", missionId);
		if (existsSync(candidate)) {
			outDir = candidate;
		}
	}

	// 3. Also try the out-dir file written by the e2e script
	if (!outDir) {
		const outDirFile = join(cwd, ".mission-e2e", "out-dir");
		if (existsSync(outDirFile)) {
			const candidate = readFileSync(outDirFile, "utf-8").trim();
			if (existsSync(candidate)) {
				outDir = candidate;
			}
		}
	}

	if (!outDir) {
		throw new Error(`openStore: cannot resolve outDir for mission ${missionId}`);
	}

	const resolvedOutDir = resolve(outDir);

	return {
		id: missionId,
		outDir: resolvedOutDir,

		async getTimeline(): Promise<MissionEvent[]> {
			const stateFile = join(resolvedOutDir, "state.json");
			if (!existsSync(stateFile)) return [];
			try {
				const state = JSON.parse(readFileSync(stateFile, "utf-8"));
				return (state.events ?? []) as MissionEvent[];
			} catch {
				return [];
			}
		},
	};
}
