/**
 * Tests for how much of a monorepo a mission installs.
 *
 * Setup used to install every project in the target repo, because "what does this repo need to
 * run" has no single answer in a monorepo and the setup agent was never told what the mission
 * was for. On nadine — eleven projects, six Python and five JavaScript — that was ~5GB per
 * worktree; three live worktrees filled the disk and killed a mission mid-bootstrap.
 *
 * Scoping is therefore a cost control, and its failure modes are asymmetric. Over-installing
 * wastes disk. UNDER-installing fails deep inside a worker with a missing import, long after
 * setup reported success — so every case where intent is unclear must widen to "install
 * everything", never narrow to a guess.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { missionScope, inputsHash } = await import("../dist/setup.js");

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const roots = [];

/** A monorepo shaped like nadine: Python services, JS apps, and a plain directory. */
function scaffold() {
	const root = mkdtempSync(join(tmpdir(), "missions-scope-"));
	roots.push(root);
	for (const d of ["shared", "backend", "queue_service"]) {
		mkdirSync(join(root, d), { recursive: true });
		writeFileSync(join(root, d, "pyproject.toml"), "[project]\nname='x'\n");
	}
	for (const d of ["naomi-web", "website"]) {
		mkdirSync(join(root, d), { recursive: true });
		writeFileSync(join(root, d, "package.json"), "{}\n");
	}
	// A directory that is NOT a project — no manifest, so nothing to install.
	mkdirSync(join(root, "docs"), { recursive: true });
	writeFileSync(join(root, "docs", "notes.md"), "# notes\n");
	return root;
}

check("picks only the projects the brief names", () => {
	const root = scaffold();
	const got = missionScope(root, "Fix the gate in shared/src/gates.py, checked against naomi-web/ fixtures");
	assert(same(got, ["shared", "naomi-web"]), `expected shared+naomi-web, got ${JSON.stringify(got)}`);
});

check("a brief naming nothing installable widens to everything", () => {
	// [] means "no scope determined" — the caller installs the whole repo. A confident subset
	// here would be the dangerous answer.
	const root = scaffold();
	assert(missionScope(root, "make the thing faster").length === 0, "guessed a subset from a brief with no paths");
});

check("an empty brief widens to everything", () => {
	const root = scaffold();
	assert(missionScope(root, "").length === 0, "invented a scope from nothing");
});

check("a plain directory is not a project", () => {
	// docs/ has no manifest — naming it must not add an install step.
	const root = scaffold();
	assert(!missionScope(root, "update docs/naomi_provider_routing.md").includes("docs"), "scoped to a directory with nothing to install");
});

check("a bare mention without a path separator does not scope", () => {
	// "the backend is slow" is prose about a system, not a path into it. Requiring the slash
	// keeps English out of the install plan.
	const root = scaffold();
	assert(missionScope(root, "the backend is slow and website copy is stale").length === 0, "scoped off prose rather than paths");
});

check("substring project names do not collide", () => {
	const root = scaffold();
	const got = missionScope(root, "restyle naomi-web/app/page.tsx");
	assert(!got.includes("website"), `"website" matched inside another path: ${JSON.stringify(got)}`);
	assert(same(got, ["naomi-web"]), `expected naomi-web only, got ${JSON.stringify(got)}`);
});

check("a narrower scope does not reuse a wider mission's setup record", () => {
	// The safety property behind the whole feature. A record produced by a shared-only mission
	// must NOT be replayed for a backend mission: replay would report success having installed
	// nothing backend needs, and the worker would then fail on a missing import with nothing in
	// its log to explain why.
	const root = scaffold();
	const shared = inputsHash(root, null, missionScope(root, "edit shared/src/x.py"));
	const backend = inputsHash(root, null, missionScope(root, "edit backend/src/y.py"));
	assert(shared !== backend, "two different scopes hashed identically — one would replay the other's install");
});

check("the same scope in a different order hits the same record", () => {
	// Otherwise the cache misses on wording alone and every mission pays a full install.
	const root = scaffold();
	const a = inputsHash(root, null, ["shared", "backend"]);
	const b = inputsHash(root, null, ["backend", "shared"]);
	assert(a === b, "scope order changed the cache key");
});

check("an unscoped record is distinct from a scoped one", () => {
	// [] means "installed everything". That is a genuinely different tree from a two-project
	// install, so it must not share a key with one.
	const root = scaffold();
	assert(inputsHash(root, null, []) !== inputsHash(root, null, ["shared"]), "full install shares a key with a partial one");
});

for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3 });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
