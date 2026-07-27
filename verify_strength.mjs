/**
 * verify_strength.mjs — standalone verification for the strength-aware assertion feature.
 *
 * Imports the classifier and verdict-annotation helpers from the built dist/ and verifies:
 *   (a) declared-behavioural + filesystem-only command -> downgraded to existence, strengthCorrected: true
 *   (b) declared-behavioural + real executing command -> stays behavioural
 *   (c) verdict with only existence/review passes -> annotated "existence-only"
 *   (d) verdict with a behavioural pass -> unannotated
 *   (e) assertion with no strength field -> no crash
 *
 * Prints PASS or FAIL for each check and an overall PASS/FAIL at the end.
 * Exit code 0 = all pass, 1 = any fail.
 */

import { classifyCommandStrength, applyStrengthClassification, annotateVerdict } from "./dist/validators/checks.js";

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    const result = fn();
    if (result) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.log(`  FAIL  ${label}`);
      failed++;
    }
  } catch (err) {
    console.log(`  FAIL  ${label} — threw: ${err.message}`);
    failed++;
  }
}

console.log("\n── Strength classifier ──\n");

// (a) Declared behavioural + filesystem-only command → downgraded to existence
check("(a1) test -f x  is classified as existence", () => {
  return classifyCommandStrength("test -f x") === "existence";
});

check("(a2) grep -q pattern file  is classified as existence", () => {
  return classifyCommandStrength("grep -q pattern file") === "existence";
});

check("(a3) test -f x && grep -q y z  is classified as existence", () => {
  return classifyCommandStrength("test -f x && grep -q y z") === "existence";
});

check("(a4) ls -la src/  is classified as existence", () => {
  return classifyCommandStrength("ls -la src/") === "existence";
});

check("(a5) stat foo.ts  is classified as existence", () => {
  return classifyCommandStrength("stat foo.ts") === "existence";
});

check("(a6) find . -name '*.ts'  is classified as existence", () => {
  return classifyCommandStrength("find . -name '*.ts'") === "existence";
});

check("(a7) wc -l src/index.ts  is classified as existence", () => {
  return classifyCommandStrength("wc -l src/index.ts") === "existence";
});

// (b) Declared behavioural + real executing command → stays behavioural
check("(b1) node verify_stage1.mjs  is classified as behavioural", () => {
  return classifyCommandStrength("node verify_stage1.mjs") === "behavioural";
});

check("(b2) npm test  is classified as behavioural", () => {
  return classifyCommandStrength("npm test") === "behavioural";
});

check("(b3) npx tsc --noEmit  is classified as behavioural", () => {
  return classifyCommandStrength("npx tsc --noEmit") === "behavioural";
});

check("(b4) node dist/cli.js view x | jq -e length  is classified as behavioural", () => {
  // jq is not in the filesystem-only set, so this should be behavioural
  return classifyCommandStrength("node dist/cli.js view x | jq -e length") === "behavioural";
});

console.log("\n── applyStrengthClassification ──\n");

// (a) Declared behavioural + filesystem command → downgraded to existence, strengthCorrected: true
check("(a8) declared behavioural + 'test -f x' → downgraded, strengthCorrected:true", () => {
  const result = { command: "test -f x", exitCode: 0, passed: true, output: "" };
  const eff = applyStrengthClassification(result, "behavioural");
  return eff === "existence"
    && result.effectiveStrength === "existence"
    && result.declaredStrength === "behavioural"
    && result.strengthCorrected === true;
});

// (b) Declared behavioural + real executing command → stays behavioural
check("(b5) declared behavioural + 'npm test' → stays behavioural, no correction", () => {
  const result = { command: "npm test", exitCode: 0, passed: true, output: "" };
  const eff = applyStrengthClassification(result, "behavioural");
  return eff === "behavioural"
    && result.effectiveStrength === "behavioural"
    && result.declaredStrength === "behavioural"
    && result.strengthCorrected !== true;
});

// Declared existence stays existence (no upgrade)
check("declared existence + 'npm test' → stays existence (no upgrade)", () => {
  const result = { command: "npm test", exitCode: 0, passed: true, output: "" };
  const eff = applyStrengthClassification(result, "existence");
  return eff === "existence"
    && result.effectiveStrength === "existence"
    && result.strengthCorrected !== true;
});

// Declared review stays review
check("declared review + any command → stays review", () => {
  const result = { command: "test -f x", exitCode: 0, passed: true, output: "" };
  const eff = applyStrengthClassification(result, "review");
  return eff === "review"
    && result.effectiveStrength === "review";
});

// (e) No strength field → no crash, returns undefined
check("(e) undefined strength → no crash, returns undefined", () => {
  const result = { command: "npm test", exitCode: 0, passed: true, output: "" };
  const eff = applyStrengthClassification(result, undefined);
  return eff === undefined
    && result.declaredStrength === undefined
    && result.effectiveStrength === undefined
    && result.strengthCorrected === undefined;
});

console.log("\n── annotateVerdict ──\n");

// (c) Run with only existence/review passes → annotated
check("(c1) CLEAN with no behavioural passed → annotated with existence-only", () => {
  const scoreCard = { strengthBreakdown: { behavioural: { passed: 0, total: 2 } } };
  const v = annotateVerdict("CLEAN", scoreCard);
  return v.includes("existence-only") && v.includes("no assertion executed the feature");
});

check("(c2) CLEAN with no strengthBreakdown → annotated (conservative)", () => {
  const v = annotateVerdict("CLEAN", undefined);
  return v.includes("existence-only");
});

check("(c3) CLEAN with empty scoreCard → annotated", () => {
  const v = annotateVerdict("CLEAN", {});
  return v.includes("existence-only");
});

// (d) Run with a behavioural pass → unannotated
check("(d1) CLEAN with 1 behavioural passed → unannotated", () => {
  const scoreCard = { strengthBreakdown: { behavioural: { passed: 1, total: 1 } } };
  const v = annotateVerdict("CLEAN", scoreCard);
  return v === "CLEAN";
});

check("(d2) CLEAN with multiple behavioural passed → unannotated", () => {
  const scoreCard = { strengthBreakdown: { behavioural: { passed: 3, total: 3 } } };
  const v = annotateVerdict("CLEAN", scoreCard);
  return v === "CLEAN";
});

// Non-CLEAN verdicts are never annotated
check("NEEDS YOU verdict → never annotated", () => {
  const scoreCard = { strengthBreakdown: { behavioural: { passed: 0, total: 0 } } };
  const v = annotateVerdict("NEEDS YOU (stalled)", scoreCard);
  return v === "NEEDS YOU (stalled)";
});

// (e) assertion with no strength field does not crash in applyStrengthClassification
check("(e2) applyStrengthClassification with missing strength → no crash, no side effects", () => {
  const result = { command: "test -f src/types.ts", exitCode: 0, passed: true, output: "" };
  let threw = false;
  try {
    applyStrengthClassification(result, undefined);
  } catch {
    threw = true;
  }
  return !threw && result.strengthCorrected === undefined;
});

console.log("\n── Skipped-behavioural regression ──\n");

// A plan with one 'behavioral'-method (skipped) assertion and only existence/review passing
// assertions must still produce the existence-only annotated CLEAN, not a plain CLEAN.
// This is the regression for the bug where mark(a, true, 'SKIPPED') incremented
// strengthBreakdown.behavioural.passed and suppressed the existence-only annotation.
check("(f1) skipped behavioural (passed=0) + existence/review passes → annotated CLEAN", () => {
  // Simulate: one behavioural assertion that was skipped (passed=0), two existence that passed.
  const scoreCard = {
    strengthBreakdown: {
      behavioural: { passed: 0, total: 1 },  // skipped = not passed
      existence:   { passed: 2, total: 2 },
      review:      { passed: 1, total: 1 },
    },
  };
  const v = annotateVerdict("CLEAN", scoreCard);
  return v.includes("existence-only") && v.includes("no assertion executed the feature");
});

check("(f2) skipped behavioural must NOT produce plain CLEAN (no suppression of annotation)", () => {
  const scoreCard = {
    strengthBreakdown: {
      behavioural: { passed: 0, total: 1 },  // skipped = not passed
      existence:   { passed: 1, total: 1 },
    },
  };
  const v = annotateVerdict("CLEAN", scoreCard);
  // plain CLEAN would mean the annotation was wrongly suppressed
  return v !== "CLEAN";
});

console.log("\n── Summary ──\n");
const total = passed + failed;
const allPass = failed === 0;
console.log(`${allPass ? "PASS" : "FAIL"} — ${passed}/${total} checks passed\n`);
process.exit(allPass ? 0 : 1);
