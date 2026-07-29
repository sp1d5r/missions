import { createHash } from "node:crypto";
import { createServer } from "node:net";

/**
 * Ports, one block per worktree.
 *
 * The gap this closes: two missions in the same repo get separate worktrees, separate branches
 * and separate installs — and then both run `npm run dev`, which reads the same `.env`, binds
 * the same port, and the second one dies with EADDRINUSE. Or worse, does not die: the second
 * service fails to bind while the first is still up, the worker's smoke check hits the FIRST
 * mission's server, and the validation passes against code the mission never wrote. Every other
 * kind of isolation this harness does is undone by that one shared number.
 *
 * Four decisions:
 *
 * 1. DERIVED FROM THE PATH, NOT ALLOCATED FROM A COUNTER. A counter needs a registry, and a
 *    registry needs to survive crashes and stay honest about trees that were deleted behind its
 *    back. Hashing the worktree path needs none of that, and it is stable: a mission resumed
 *    tomorrow binds the same port it printed in yesterday's log, and a URL in a report still
 *    works. Same input, same answer, no state.
 *
 * 2. BLOCKS, NOT SINGLE PORTS. A repo usually binds several — api, web, a worker, a debugger.
 *    Handing each variable an independently hashed port would interleave two trees' ports and
 *    make "which tree is 24019?" unanswerable by eye. One contiguous block per tree means the
 *    base tells you the tree and the offset tells you the service.
 *
 * 3. THE RANGE IS CHOSEN, NOT ARBITRARY. 20000–39990 sits above the ports repos actually
 *    document (3000, 5173, 8000, 8080, 5432, 6379) so a worktree never collides with the main
 *    checkout a human is running, and below macOS's ephemeral range (49152–65535) so the kernel
 *    never hands our port to some unrelated outbound socket first.
 *
 * 4. DERIVATION IS A GUESS; THE CLAIM AND THE BIND ARE THE PROOF. A hash over ~2000 blocks
 *    collides more often than intuition suggests — measured, two of 200 sibling worktree paths
 *    landed on the same block. So the derived base is a starting point and we walk forward.
 *
 *    Walking needs TWO tests, and probing alone is the tempting wrong answer. A bind test only
 *    sees ports held at that instant, and a mission between commands holds nothing — so two idle
 *    worktrees would both probe clean and both claim the same block, which is the exact failure
 *    this file exists to prevent, merely made rarer and harder to reproduce. Live missions
 *    therefore RECORD the block they own, and an allocation skips a recorded block whether or
 *    not anything is currently listening on it. The bind test stays for everything outside this
 *    harness, which records nothing.
 */

/** Ports per worktree. Enough for api + web + worker + db proxy + headroom. */
export const BLOCK_SPAN = 10;

const RANGE_START = 20_000;
/** Exclusive. Stops short of macOS's ephemeral range (49152) with room to spare. */
const RANGE_END = 40_000;
const BLOCKS = (RANGE_END - RANGE_START) / BLOCK_SPAN;

/**
 * The block this worktree would like, absent any conflict.
 *
 * Exported because it is worth being able to answer "what port should this tree be on" without
 * binding anything — a log line, a report, a human debugging from a different machine.
 */
export function derivePortBase(worktreePath: string): number {
	const digest = createHash("sha256").update(worktreePath).digest();
	// 32 bits is plenty and stays inside a safe integer.
	const n = digest.readUInt32BE(0);
	return RANGE_START + (n % BLOCKS) * BLOCK_SPAN;
}

/** True when nothing on any interface holds this port. */
async function free(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		// Deliberately NOT reusing the address: we are asking whether the port is available,
		// and SO_REUSEADDR would answer "yes" for a port in TIME_WAIT that a service is about
		// to reclaim.
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		// 0.0.0.0 rather than 127.0.0.1 — a service bound to all interfaces conflicts with a
		// loopback-only bind, so the stricter question is the correct one.
		server.listen(port, "0.0.0.0");
	});
}

async function blockFree(base: number, span: number): Promise<boolean> {
	for (let i = 0; i < span; i++) if (!(await free(base + i))) return false;
	return true;
}

export interface PortBlock {
	base: number;
	span: number;
	/** How many blocks past the derived one we had to walk. 0 is the ordinary case. */
	drift: number;
}

export interface AllocateOptions {
	span?: number;
	/**
	 * Block bases already owned by live missions. Skipped regardless of whether anything is
	 * currently listening — see decision 4. The caller supplies these (from the registry) rather
	 * than this module reading it, so allocation stays a pure function of its inputs and can be
	 * tested without a real ~/.missions.
	 */
	claimed?: Iterable<number>;
	/** Bounds the walk. Hitting it means the machine is saturated; failing loudly is correct. */
	tries?: number;
}

/**
 * A block this worktree can own: unclaimed by any live mission, and bindable right now.
 *
 * Walks forward from the derived base, wrapping at the top of the range.
 */
export async function allocatePortBlock(worktreePath: string, options: AllocateOptions = {}): Promise<PortBlock> {
	const { span = BLOCK_SPAN, tries = 64 } = options;
	const taken = new Set<number>();
	for (const base of options.claimed ?? []) {
		// A claim covers its whole block, and a claimed base need not be aligned to OUR span if
		// the span ever changes, so mark every port the claim spans.
		for (let i = 0; i < BLOCK_SPAN; i++) taken.add(base + i);
	}
	const overlapsClaim = (base: number) => {
		for (let i = 0; i < span; i++) if (taken.has(base + i)) return true;
		return false;
	};

	const start = derivePortBase(worktreePath);
	for (let drift = 0; drift < tries; drift++) {
		const base = RANGE_START + ((start - RANGE_START + drift * span) % (BLOCKS * BLOCK_SPAN));
		if (overlapsClaim(base)) continue;
		if (await blockFree(base, span)) return { base, span, drift };
	}
	throw new Error(`no free ${span}-port block near ${start} after ${tries} tries — too many live missions, or something is binding thousands of ports`);
}

/**
 * Assign a port to each variable the repo binds.
 *
 * ORDER IS THE REPORTED ORDER, not sorted. The names come from the setup record, which preserves
 * the order the setup agent found them in the repo's own docs. Sorting would look tidier and be
 * worse: adding `API_PORT` to a repo that already had `WEB_PORT` would renumber the existing
 * variable, silently moving a service a human had bookmarked.
 */
export function assignPorts(vars: string[], block: PortBlock): Record<string, string> {
	const out: Record<string, string> = {};
	const seen = new Set<string>();
	let offset = 0;
	for (const raw of vars) {
		const name = raw.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		if (offset >= block.span) break;
		out[name] = String(block.base + offset);
		offset++;
	}
	return out;
}

/**
 * Keep only names that plausibly carry a port.
 *
 * The setup agent is asked for port variables and mostly obliges, but a model that answers
 * `DATABASE_URL` — which does contain a port, inside a URL — would have us overwrite a whole
 * connection string with "20003". Names only; a URL is not a port.
 */
export function portVarNames(candidates: string[]): string[] {
	return candidates
		.map((c) => c.trim())
		.filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
		.filter((c) => /PORT/i.test(c))
		.filter((c) => !/URL|URI|DSN|HOST|ADDR/i.test(c));
}
