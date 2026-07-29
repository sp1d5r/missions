#!/usr/bin/env node
/**
 * check-readme.mjs — validates that spike/heads/README.md contains the numbers
 * derived from results.json.
 *
 * Exits 0 if every checked number appears in the README.
 * Exits 1 (with diagnostics) if any number is missing.
 *
 * Usage: node spike/heads/check-readme.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load inputs ──────────────────────────────────────────────────────────────

const resultsPath = join(__dirname, "results.json");
const readmePath = join(__dirname, "README.md");

const data = JSON.parse(readFileSync(resultsPath, "utf8"));
const readme = readFileSync(readmePath, "utf8");

const results = data.results;

// ── Compute numbers from results.json ────────────────────────────────────────

const HEADS = ["naive", "confidence", "direction", "assumption"];

/** Fixtures whose source is not 'real' */
function isLabelled(r) {
  return r.source !== "real";
}

function computeHead(head) {
  const rows = results.filter((r) => r.head === head);
  const realRows = rows.filter((r) => r.source === "real");
  const labelledRows = rows.filter((r) => isLabelled(r));

  const knownBad = labelledRows.filter((r) => r.expect === "flag");
  const knownBadCaught = knownBad.filter((r) => r.decision === "flag");
  const recall = `${knownBadCaught.length}/${knownBad.length}`;

  const realFlagged = realRows.filter((r) => r.decision === "flag");
  const flagCount = realFlagged.length;
  const flagTotal = realRows.length;
  const flagRatePct = ((flagCount / flagTotal) * 100).toFixed(1);

  const parseFailures = rows.filter((r) => r.decision === "unparseable");

  return {
    head,
    totalCalls: rows.length,
    recall,           // e.g. "4/4"
    flagCount,        // flags over real fixtures
    flagTotal,        // total real fixtures
    flagRatePct,      // e.g. "13.3"
    parseFailures: parseFailures.length,
  };
}

const headStats = Object.fromEntries(HEADS.map((h) => [h, computeHead(h)]));

const totalCalls = results.length;
const totalSpend = data.cost;

// ── Helpers ───────────────────────────────────────────────────────────────────

function contains(text) {
  return readme.includes(text);
}

let failed = false;

function check(label, value) {
  const str = String(value);
  if (!contains(str)) {
    console.error(`FAIL [${label}]: "${str}" not found in README.md`);
    failed = true;
  } else {
    console.log(`OK   [${label}]: "${str}"`);
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

console.log("=== Checking README numbers against results.json ===\n");

// Total call count
check("total calls", totalCalls);

// Total spend — check the rounded dollar value to 3 significant decimal places
check("total spend", totalSpend.toFixed(3));

for (const h of HEADS) {
  const s = headStats[h];

  // Per-head call count
  check(`${h}: total calls`, s.totalCalls);

  // Recall on labelled known-bad
  check(`${h}: recall`, s.recall);

  // Flag count over real fixtures
  check(`${h}: flag count`, `${s.flagCount}/${s.flagTotal}`);

  // Flag rate percentage
  check(`${h}: flag rate %`, s.flagRatePct);

  // Parse failures
  check(`${h}: parse failures`, s.parseFailures);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("");
if (failed) {
  console.error("FAIL — one or more numbers are missing from README.md");
  process.exit(1);
} else {
  console.log("PASS — all numbers confirmed in README.md");
  process.exit(0);
}
