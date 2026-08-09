/**
 * mission-store.js — thin read-only helper for the e2e/validator path.
 *
 * This is a plain ESM module (no Next.js bundler required) so validator
 * commands can import it directly with:
 *   node --input-type=module -e "import('./web/lib/mission-store.js').then(..."
 *
 * It mirrors the subset of functionality that web/lib/data.ts provides at
 * runtime, but without requiring Next.js, Clerk or the TypeScript compiler.
 *
 * Exported API
 * ------------
 * loadMissionFromDir(dir?: string): Promise<MissionState>
 *   Read state.json from `dir` and return the parsed MissionState object
 *   (including the `events` array). When `dir` is absent or undefined the
 *   function falls back to reading `.mission-e2e/out-dir` from the current
 *   working directory, making it tolerant of the shell-variable / env-var
 *   mismatch that occurs in validator commands (MID= sets a shell variable,
 *   not process.env.MID).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Load a MissionState from the given output directory.
 *
 * @param {string | undefined} dir - Absolute (or relative to cwd) path to the
 *   mission's output directory, e.g. `.mission-e2e/m-screenshot-e2e-123/`.
 *   When undefined, the function reads the path from `.mission-e2e/out-dir`.
 * @returns {Promise<object>} The parsed state.json object (MissionState).
 */
export async function loadMissionFromDir(dir) {
  const cwd = process.cwd();

  // Resolve the directory, falling back to the out-dir pointer file.
  let outDir = dir;
  if (!outDir) {
    const ptrFile = join(cwd, ".mission-e2e", "out-dir");
    if (!existsSync(ptrFile)) {
      throw new Error(
        `loadMissionFromDir: no dir supplied and ${ptrFile} does not exist`
      );
    }
    outDir = readFileSync(ptrFile, "utf-8").trim();
  }

  const resolvedDir = resolve(cwd, outDir);
  const stateFile = join(resolvedDir, "state.json");

  if (!existsSync(stateFile)) {
    throw new Error(
      `loadMissionFromDir: state.json not found at ${stateFile}`
    );
  }

  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch (err) {
    throw new Error(
      `loadMissionFromDir: failed to parse ${stateFile}: ${err.message}`
    );
  }
}
