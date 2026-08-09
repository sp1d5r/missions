// An assertion's pass/fail must be about the code under test, not about which env var name an
// LLM happened to guess for the worktree path. Two real failure modes, both observed on one
// mission that ground through 18 milestones over 3 days:
//
//   1. `cd $WORKTREE && ...` (unquoted) — nothing ever set $WORKTREE, so the empty expansion
//      vanishes as a token and bash's `cd` runs with zero arguments, landing in $HOME. Everything
//      after `&&` then runs against the wrong tree and passes or fails by luck.
//   2. Different assertions invented different names ($WORKTREE, $MISSION_WORKTREE, $REPO) for
//      the same worktree path, and the harness only ever guaranteed one of them existed.
//
// resolveMissionEnv now aliases the common guesses to the real value; detectUnsafeCdVar is the
// defense-in-depth catch for any other name an LLM might invent.

import { detectUnsafeCdVar, runCheck } from "../dist/validators/checks.js";
import { resolveMissionEnv } from "../dist/env.js";

let fails = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		fails++;
		console.log(`FAIL ${name}: ${e.message}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		fails++;
		console.log(`FAIL ${name}: ${e.message}`);
	}
};
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};

// ---- detectUnsafeCdVar -------------------------------------------------------

check("unquoted cd to an unset-looking var is flagged", () => {
	assert(detectUnsafeCdVar('cd $WORKTREE_TYPO && node dist/cli.js') === "WORKTREE_TYPO", "should have flagged WORKTREE_TYPO");
});

check("quoted cd to an unknown var is still flagged — it fails loudly, but it's still broken", () => {
	assert(detectUnsafeCdVar('cd "$SOME_MADE_UP_VAR" && npm test') === "SOME_MADE_UP_VAR");
});

check("the aliased worktree names are all safe", () => {
	for (const name of ["WORKTREE", "MISSION_WORKTREE", "REPO", "MISSION_ID"]) {
		assert(detectUnsafeCdVar(`cd "$${name}" && npm test`) === null, `$${name} should be considered safe`);
		assert(detectUnsafeCdVar(`cd $${name} && npm test`) === null, `unquoted $${name} should be considered safe`);
	}
});

check("the underlying MISSIONS_* markers are safe too", () => {
	assert(detectUnsafeCdVar('cd $MISSIONS_WORKTREE && npm test') === null);
});

check("braced form is recognised", () => {
	assert(detectUnsafeCdVar('cd "${WORKTREE}/web" && npm test') === null, "braced+subpath should still resolve to WORKTREE");
	assert(detectUnsafeCdVar('cd ${BOGUS}/web && npm test') === "BOGUS");
});

check("a literal relative or absolute cd is not this failure mode", () => {
	assert(detectUnsafeCdVar('cd src/worker/tools && ls') === null, "no $ reference — not flagged");
	assert(detectUnsafeCdVar('cd /Users/elijahahmad/missions && ls') === null, "no $ reference — detectForeignPath's job, not this one");
});

check("a $VAR elsewhere in the command (not immediately after cd) is not flagged", () => {
	assert(detectUnsafeCdVar('grep -q "$WORKTREE" file.txt') === null);
	assert(detectUnsafeCdVar('echo $BOGUS') === null);
});

check("multi-segment command: only the cd segment matters", () => {
	assert(detectUnsafeCdVar('npm run build && cd $BOGUS && npm test') === "BOGUS");
	assert(detectUnsafeCdVar('cd $WORKTREE && node -e "process.env.BOGUS"') === null);
});

// ---- resolveMissionEnv aliases ------------------------------------------------

check("resolveMissionEnv sets the aliases assertions actually reference", () => {
	const env = resolveMissionEnv({
		targetCwd: "/repo/main",
		workCwd: "/repo/.missions/worktrees/m1",
		missionId: "m-123",
		sourceRoots: [],
		base: {},
	});
	assert(env.WORKTREE === "/repo/.missions/worktrees/m1", `WORKTREE: ${env.WORKTREE}`);
	assert(env.MISSION_WORKTREE === "/repo/.missions/worktrees/m1", `MISSION_WORKTREE: ${env.MISSION_WORKTREE}`);
	assert(env.REPO === "/repo/.missions/worktrees/m1", `REPO: ${env.REPO}`);
	assert(env.MISSION_ID === "m-123", `MISSION_ID: ${env.MISSION_ID}`);
	assert(env.MISSIONS_WORKTREE === env.WORKTREE, "alias must match the original marker");
});

// ---- runCheck end to end -------------------------------------------------------

await checkAsync("runCheck refuses an unsafe cd instead of running it", async () => {
	const r = await runCheck({ cwd: "/tmp", command: "cd $NOT_A_REAL_VAR && echo should-not-run" });
	assert(r.exitCode === 126, `expected REFUSED_EXIT_CODE, got ${r.exitCode}`);
	assert(r.passed === false, "a refused command must not read as passed");
	assert(r.output.includes("NOT_A_REAL_VAR"), "refusal message should name the offending var");
});

await checkAsync("runCheck runs normally once the var is aliased in", async () => {
	const env = resolveMissionEnv({ targetCwd: "/repo", workCwd: "/tmp", missionId: "m-1", sourceRoots: [], base: {} });
	const r = await runCheck({ cwd: "/tmp", command: 'cd "$WORKTREE" && pwd', env });
	assert(r.exitCode === 0, `expected the command to actually run, got exit ${r.exitCode}: ${r.output}`);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
