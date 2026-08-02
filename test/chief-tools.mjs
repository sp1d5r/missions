// The chief runs the org from the user's own machine, as the user. It needs hands: the setup work
// that precedes any mission — mkdir, git init, scaffold, install, first commit — is deterministic
// and belongs to the chief, not to a dispatched worker. It was read-only, so it answered "I can't
// do that" to exactly the requests a chief of staff exists to absorb.
//
// These assertions pin the grant. A regression to read-only is indistinguishable, from the outside,
// from the model simply refusing — so it has to fail here instead.

import { buildTools } from "../dist/chief.js";

let fails = 0;
const t = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) {
		fails++;
		console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
	} else console.log(`ok   ${name}`);
};

const tools = buildTools(
	() => process.cwd(),
	() => ({}),
);
const names = tools.map((x) => x.name);
const has = (n) => names.includes(n);

// ---- the hands -------------------------------------------------------------

t("chief can read", has("read"), true);
t("chief can grep", has("grep"), true);
t("chief can run commands", has("bash"), true);
t("chief can create files", has("write"), true);
t("chief can modify files", has("edit"), true);

// ---- the org tools still there ---------------------------------------------

for (const n of ["run_mission", "accept_mission", "list_missions", "list_workspaces", "investigate", "reclaim_disk"]) {
	t(`${n} survives the tool-set change`, has(n), true);
}

// ---- no duplicates ---------------------------------------------------------

// createReadOnlyTools and createCodingTools BOTH include `read`. Composing them naively ships two
// tools with the same name, and which one the provider binds is undefined.
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
t("no tool name is registered twice", dupes, []);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
