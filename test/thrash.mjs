/**
 * Unit tests for src/thrash.ts (compiled to dist/thrash.js) — see harness-issues.md #2.
 * Follows the same convention as test/stall.mjs: import from dist/, hand-rolled check()/assert().
 */

import { detectFileThrash, THRASH_STALL_THRESHOLD, THRASH_WARN_THRESHOLD } from "../dist/thrash.js";

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
	if (!cond) throw new Error(msg ?? "assertion failed");
}

const feature = (id, origin) => ({ id, title: id, description: id, assertionIds: [], origin });
const commit = (featureId, sha) => ({ featureId, sha, message: featureId });

check("a file touched by only one correction is not thrash", () => {
	const commits = [commit("m2c1", "s1")];
	const features = [feature("m2c1", "correction")];
	const result = detectFileThrash(commits, features, () => ["src/foo.ts"]);
	assert(result.length === 0, `expected no thrash, got ${JSON.stringify(result)}`);
});

check("a file touched by 2+ distinct corrections is reported", () => {
	const commits = [commit("m2c1", "s1"), commit("m3c1", "s2")];
	const features = [feature("m2c1", "correction"), feature("m3c1", "correction")];
	const result = detectFileThrash(commits, features, () => ["src/foo.ts"]);
	assert(result.length === 1, `expected one thrashing file, got ${result.length}`);
	assert(result[0].file === "src/foo.ts", `wrong file: ${result[0].file}`);
	assert(result[0].correctionIds.length === 2, `expected 2 correction ids, got ${result[0].correctionIds.length}`);
});

check("the original plan feature's commit does not count toward thrash", () => {
	const commits = [commit("f1", "s0"), commit("m2c1", "s1"), commit("m3c1", "s2")];
	const features = [feature("f1", "plan"), feature("m2c1", "correction"), feature("m3c1", "correction")];
	const result = detectFileThrash(commits, features, () => ["src/foo.ts"]);
	assert(result[0].correctionIds.length === 2, `plan feature's commit should not count: got ${result[0].correctionIds.length}`);
});

check("the same correction committing twice (e.g. amended) counts once, not twice", () => {
	const commits = [commit("m2c1", "s1"), commit("m2c1", "s1b")];
	const features = [feature("m2c1", "correction")];
	const result = detectFileThrash(commits, features, () => ["src/foo.ts"]);
	assert(result.length === 0, `a single correction id touching a file twice is not thrash: ${JSON.stringify(result)}`);
});

check("results are sorted most-touched file first", () => {
	const commits = [commit("m2c1", "s1"), commit("m3c1", "s2"), commit("m4c1", "s3")];
	const features = [feature("m2c1", "correction"), feature("m3c1", "correction"), feature("m4c1", "correction")];
	const filesFor = (sha) => (sha === "s3" ? ["src/rare.ts"] : ["src/hot.ts", "src/rare.ts"]);
	const result = detectFileThrash(commits, features, filesFor);
	assert(result[0].file === "src/rare.ts", `expected src/rare.ts first (3 touches), got ${result[0].file}`);
	assert(result[0].correctionIds.length === 3, `src/rare.ts should have 3 touches`);
	assert(result[1].correctionIds.length === 2, `src/hot.ts should have 2 touches`);
});

check("thresholds are ordered: warn before stall", () => {
	assert(THRASH_WARN_THRESHOLD < THRASH_STALL_THRESHOLD, "warn threshold must be lower than the stall threshold");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
