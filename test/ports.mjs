/**
 * Tests for per-worktree port isolation.
 *
 * The failure being prevented is quiet, which is why it is worth testing carefully: two missions
 * in one repo both read the same `.env`, both bind port 3000, the second fails to bind, and the
 * worker's smoke check reaches the FIRST mission's server. Nothing errors. The mission reports
 * a passing validation against code it never wrote.
 *
 * So the properties here are about the guarantees, not the arithmetic: sibling worktrees never
 * share a block, a block handed out is one that can actually be bound, and overrides applied at
 * different stages of a mission compose instead of overwriting each other.
 */

import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { derivePortBase, allocatePortBlock, assignPorts, portVarNames, BLOCK_SPAN } = await import("../dist/ports.js");
const { applyEnvOverrides } = await import("../dist/bootstrap.js");
const { parseEnvFile } = await import("../dist/env.js");

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

const roots = [];
function tmp() {
	const d = mkdtempSync(join(tmpdir(), "missions-ports-"));
	roots.push(d);
	return d;
}

/** Hold a port open for the duration of a callback. */
async function occupying(port, fn) {
	const server = createServer();
	await new Promise((res, rej) => {
		server.once("error", rej);
		server.listen(port, "0.0.0.0", res);
	});
	try {
		return await fn();
	} finally {
		await new Promise((res) => server.close(res));
	}
}

// ── Derivation ──────────────────────────────────────────────────────────────────────

await check("derivation is stable across calls", () => {
	const p = "/Users/x/repo/.missions/worktrees/m-123";
	assert(derivePortBase(p) === derivePortBase(p), "same path gave two different bases");
});

await check("derivation stays in the chosen range and on a block boundary", () => {
	// Above the ports repos document (3000/5173/8080), below macOS ephemeral (49152).
	for (let i = 0; i < 500; i++) {
		const base = derivePortBase(`/Users/x/repo/.missions/worktrees/m-${i}`);
		assert(base >= 20000 && base < 40000, `base ${base} outside 20000..40000`);
		assert(base % BLOCK_SPAN === 0, `base ${base} is not on a block boundary`);
	}
});

await check("derivation spreads sibling worktrees across the range", () => {
	// A spread, NOT uniqueness. 200 paths over ~2000 blocks is a birthday problem: a perfectly
	// uniform hash is expected to yield ~190 distinct, and this set yields 187. Guaranteeing
	// separation is the allocator's job (below), not the hash's — a test demanding zero
	// collisions here would be asserting a promise the design deliberately does not make.
	// The floor is set ~3 standard deviations low, so it catches a genuinely broken hash
	// (one bucket, or an unshifted digest) without failing on ordinary luck.
	const bases = new Set();
	for (let i = 0; i < 200; i++) bases.add(derivePortBase(`/Users/x/repo/.missions/worktrees/m-${i}`));
	assert(bases.size >= 180, `200 sibling paths produced only ${bases.size} distinct blocks`);
});

// ── Allocation ──────────────────────────────────────────────────────────────────────

await check("an allocated block is genuinely bindable", async () => {
	const block = await allocatePortBlock("/Users/x/repo/.missions/worktrees/bindable");
	assert(block.span === BLOCK_SPAN, `span was ${block.span}`);
	for (let i = 0; i < block.span; i++) {
		await occupying(block.base + i, () => {});
	}
});

await check("allocation walks past a block someone else already holds", async () => {
	const path = "/Users/x/repo/.missions/worktrees/contested";
	const derived = derivePortBase(path);
	// Hold one port in the middle of the derived block — one is enough to spoil it.
	const moved = await occupying(derived + 3, () => allocatePortBlock(path));
	assert(moved.drift > 0, "allocation returned the derived block despite a port being held");
	assert(moved.base !== derived, `allocation returned the occupied base ${derived}`);
	// And the block it moved to is real, not merely different.
	for (let i = 0; i < moved.span; i++) await occupying(moved.base + i, () => {});
});

await check("a block claimed by a live mission is never handed out twice", async () => {
	// The property the whole feature rests on. Note the claim is honoured with NOTHING bound —
	// a mission between commands holds no port, and probing alone would hand its block away.
	const claimed = [];
	const bases = new Set();
	for (let i = 0; i < 40; i++) {
		const block = await allocatePortBlock(`/Users/x/repo/.missions/worktrees/live-${i}`, { claimed });
		assert(!bases.has(block.base), `block ${block.base} was handed out twice`);
		for (const prior of claimed) {
			assert(Math.abs(block.base - prior) >= BLOCK_SPAN, `block ${block.base} overlaps claimed ${prior}`);
		}
		bases.add(block.base);
		claimed.push(block.base);
	}
});

await check("a claim is honoured even when the claimant is idle", async () => {
	const path = "/Users/x/repo/.missions/worktrees/idle-neighbour";
	const derived = derivePortBase(path);
	const block = await allocatePortBlock(path, { claimed: [derived] });
	assert(block.base !== derived, "handed out a claimed block because nothing was listening on it");
	assert(block.drift > 0, `drift was ${block.drift} despite the derived block being claimed`);
});

await check("an uncontested allocation returns the derived block", async () => {
	const path = "/Users/x/repo/.missions/worktrees/quiet";
	const block = await allocatePortBlock(path);
	assert(block.base === derivePortBase(path), "derivation and allocation disagreed with nothing in the way");
	assert(block.drift === 0, `drifted ${block.drift} with nothing holding a port`);
});

// ── Assignment ──────────────────────────────────────────────────────────────────────

await check("variables are assigned in reported order, not sorted", () => {
	// Sorting would renumber WEB_PORT when API_PORT is later added to a repo, moving a service
	// a human had bookmarked.
	const vars = assignPorts(["WEB_PORT", "API_PORT"], { base: 20000, span: 10, drift: 0 });
	assert(vars.WEB_PORT === "20000", `WEB_PORT was ${vars.WEB_PORT}`);
	assert(vars.API_PORT === "20001", `API_PORT was ${vars.API_PORT}`);
});

await check("duplicates take one port, not two", () => {
	const vars = assignPorts(["PORT", "PORT", "API_PORT"], { base: 20000, span: 10, drift: 0 });
	assert(Object.keys(vars).length === 2, `assigned ${Object.keys(vars).length} vars`);
	assert(vars.API_PORT === "20001", `API_PORT was ${vars.API_PORT}`);
});

await check("assignment never runs past the end of the block", () => {
	const many = Array.from({ length: 40 }, (_, i) => `P${i}_PORT`);
	const vars = assignPorts(many, { base: 20000, span: 10, drift: 0 });
	assert(Object.keys(vars).length === 10, `assigned ${Object.keys(vars).length}, past the block`);
	for (const v of Object.values(vars)) assert(Number(v) < 20010, `assigned ${v}, outside the block`);
});

await check("a URL is not a port", () => {
	// A model asked for port variables will occasionally answer DATABASE_URL, which does contain
	// a port — inside a connection string that must not be replaced with "20003".
	const kept = portVarNames(["PORT", "API_PORT", "DATABASE_URL", "REDIS_PORT_URL", "PGHOST", "not a var", ""]);
	assert(kept.includes("PORT") && kept.includes("API_PORT"), `dropped a real port var: ${kept.join(",")}`);
	assert(!kept.includes("DATABASE_URL"), "kept DATABASE_URL");
	assert(!kept.includes("REDIS_PORT_URL"), "kept a URL that merely contains PORT");
	assert(!kept.includes("PGHOST"), "kept a host var");
	assert(!kept.some((k) => k.includes(" ")), "kept something that is not an identifier");
});

// ── Composition ─────────────────────────────────────────────────────────────────────

await check("a later override does not erase an earlier one", () => {
	// The regression: ports are assigned after setup and a branched database after planning.
	// Re-reading the main checkout on the second call dropped the ports, and the mission then
	// ran on the very ports this feature exists to avoid.
	const target = tmp();
	const work = tmp();
	writeFileSync(join(target, ".env"), "PORT=3000\nDATABASE_URL=postgres://local/app\nAPI_KEY=secret\n");

	applyEnvOverrides({ targetCwd: target, workCwd: work, envFile: ".env", missionId: "m1", overrides: { PORT: "20000" } });
	applyEnvOverrides({ targetCwd: target, workCwd: work, envFile: ".env", missionId: "m1", overrides: { DATABASE_URL: "postgres://local/app_m1" } });

	const vars = parseEnvFile(join(work, ".env"));
	assert(vars.PORT === "20000", `port override was lost — PORT is ${vars.PORT}`);
	assert(vars.DATABASE_URL === "postgres://local/app_m1", `db override missing — ${vars.DATABASE_URL}`);
	assert(vars.API_KEY === "secret", "an untouched value from the main checkout was dropped");
});

await check("the main checkout is never rewritten", () => {
	const target = tmp();
	const work = tmp();
	writeFileSync(join(target, ".env"), "PORT=3000\n");
	applyEnvOverrides({ targetCwd: target, workCwd: work, envFile: ".env", missionId: "m1", overrides: { PORT: "20000" } });
	assert(parseEnvFile(join(target, ".env")).PORT === "3000", "the operator's own .env was modified");
});

await check("a repo that keeps no .env still gets its ports", () => {
	// Otherwise a repo with no env file silently runs every worktree on the default port.
	const target = tmp();
	const work = tmp();
	const wrote = applyEnvOverrides({ targetCwd: target, workCwd: work, envFile: ".env", missionId: "m1", overrides: { PORT: "20000" } });
	assert(wrote, "reported nothing written");
	assert(existsSync(join(work, ".env")), "no .env was created");
	assert(parseEnvFile(join(work, ".env")).PORT === "20000", "created .env lacks the override");
});

await check("no overrides is a no-op, not an empty file", () => {
	const target = tmp();
	const work = tmp();
	const wrote = applyEnvOverrides({ targetCwd: target, workCwd: work, envFile: ".env", missionId: "m1", overrides: {} });
	assert(!wrote, "reported a write for zero overrides");
	assert(!existsSync(join(work, ".env")), "created an env file for zero overrides");
});

for (const r of roots) rmSync(r, { recursive: true, force: true });
if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ports tests passed");
