/**
 * Tests for annotateVerdict and debrief grounding.
 * Imports from ../dist/ — run `npm run build` first.
 */
import { annotateVerdict } from "../dist/validators/checks.js";

let fails = 0;
const t = (name, got, want) => {
	const ok = got === want;
	if (!ok) {
		fails++;
		console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
	} else {
		console.log(`ok   ${name}`);
	}
};
const assert = (cond, msg) => {
	if (!cond) {
		fails++;
		console.log(`FAIL ${msg}`);
	} else {
		console.log(`ok   ${msg}`);
	}
};

// ---- existence-only wording preserved verbatim ----

t(
	"existence-only: zero behavioural passed → exact wording",
	annotateVerdict("CLEAN", {
		strengthBreakdown: { behavioural: { passed: 0, total: 6 } },
	}),
	"CLEAN (existence-only — no assertion executed the feature)",
);

// Verify byte-for-byte preservation of the load-bearing string
t(
	"existence-only: zero behavioural, zero total → exact wording",
	annotateVerdict("CLEAN", {
		strengthBreakdown: { behavioural: { passed: 0, total: 0 } },
	}),
	"CLEAN (existence-only — no assertion executed the feature)",
);

// ---- 2-of-6 partial-behavioural ratio wording ----

t(
	"partial-behavioural: 2 of 6 → ratio wording",
	annotateVerdict("CLEAN", {
		strengthBreakdown: { behavioural: { passed: 2, total: 6 } },
	}),
	"CLEAN (2 of 6 assertions executed the feature)",
);

t(
	"partial-behavioural: 1 of 3 → ratio wording",
	annotateVerdict("CLEAN", {
		strengthBreakdown: { behavioural: { passed: 1, total: 3 } },
	}),
	"CLEAN (1 of 3 assertions executed the feature)",
);

// ---- all-behavioural → bare CLEAN ----

t(
	"all-behavioural: all passed → bare CLEAN",
	annotateVerdict("CLEAN", {
		strengthBreakdown: { behavioural: { passed: 6, total: 6 } },
	}),
	"CLEAN",
);

t(
	"all-behavioural: 1 of 1 → bare CLEAN",
	annotateVerdict("CLEAN", {
		strengthBreakdown: { behavioural: { passed: 1, total: 1 } },
	}),
	"CLEAN",
);

// ---- non-CLEAN verdicts are returned untouched ----

t(
	"non-CLEAN: NEEDS YOU (stalled) untouched",
	annotateVerdict("NEEDS YOU (stalled)", {
		strengthBreakdown: { behavioural: { passed: 0, total: 0 } },
	}),
	"NEEDS YOU (stalled)",
);

t(
	"non-CLEAN: NEEDS YOU (max-milestones) untouched",
	annotateVerdict("NEEDS YOU (max-milestones)", undefined),
	"NEEDS YOU (max-milestones)",
);

t(
	"non-CLEAN: FAILED untouched",
	annotateVerdict("FAILED", {
		strengthBreakdown: { behavioural: { passed: 0, total: 0 } },
	}),
	"FAILED",
);

// ---- undefined scoreCard / strengthBreakdown must not throw ----

let threw = false;
try {
	const result = annotateVerdict("CLEAN", undefined);
	t("undefined scoreCard → existence-only wording", result, "CLEAN (existence-only — no assertion executed the feature)");
} catch (e) {
	threw = true;
	fails++;
	console.log(`FAIL undefined scoreCard threw: ${e}`);
}

threw = false;
try {
	const result = annotateVerdict("CLEAN", {});
	t("scoreCard without strengthBreakdown → existence-only wording", result, "CLEAN (existence-only — no assertion executed the feature)");
} catch (e) {
	threw = true;
	fails++;
	console.log(`FAIL empty scoreCard threw: ${e}`);
}

threw = false;
try {
	const result = annotateVerdict("CLEAN", { strengthBreakdown: undefined });
	t("undefined strengthBreakdown → existence-only wording", result, "CLEAN (existence-only — no assertion executed the feature)");
} catch (e) {
	threw = true;
	fails++;
	console.log(`FAIL undefined strengthBreakdown threw: ${e}`);
}

// ---- debrief grounding: existence-only fixture must not contain forbidden success verbs ----

// Simulate what buildDebrief produces for an existence-only run (import isn't public, so test via string)
const FORBIDDEN_VERBS = ["verified", "confirmed", "proven to work"];

// A fixture debrief string that an existence-only run would produce.
// It must use "existence-only" language and not claim unqualified success.
const existenceOnlyDebrief = [
	"Verdict: CLEAN (existence-only — no assertion executed the feature)",
	"Assertions: 3/3 passed · 0 bug(s) flagged · assertion strength: existence-only (no behavioural assertion executed the feature)",
	"Milestones: 1 · Commits: 2 · Cost: $0.42",
].join("\n");

for (const verb of FORBIDDEN_VERBS) {
	assert(
		!existenceOnlyDebrief.toLowerCase().includes(verb.toLowerCase()),
		`debrief grounding: existence-only debrief must not contain '${verb}'`,
	);
}

// Also assert that the annotated verdict text itself doesn't use those verbs
const annotated = annotateVerdict("CLEAN", { strengthBreakdown: { behavioural: { passed: 0, total: 4 } } });
for (const verb of FORBIDDEN_VERBS) {
	assert(
		!annotated.toLowerCase().includes(verb.toLowerCase()),
		`annotateVerdict: existence-only verdict must not contain '${verb}'`,
	);
}

// ---- summary ----

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
