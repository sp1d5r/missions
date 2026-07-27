import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the org keeps its cross-repo state: live mission records, the workspace
 * registry, the daemon socket.
 *
 * Read through a function rather than a module constant so a test can point the
 * whole org at a scratch directory. Without that, exercising anything that spans
 * repos means writing into the real ~/.missions and corrupting a live board.
 */
export function missionsRoot(): string {
	return process.env.MISSIONS_HOME || join(homedir(), ".missions");
}

export function missionsPath(...parts: string[]): string {
	return join(missionsRoot(), ...parts);
}
