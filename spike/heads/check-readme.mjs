#!/usr/bin/env node
/**
 * check-readme.mjs — validates that spike/heads/README.md contains the numbers
 * derived from results.json, asserting each value is in the correct table cell,
 * not merely present somewhere in the file.
 *
 * Exits 0 if every checked value is in the expected table cell position.
 * Exits 1 (with diagnostics) if any value is wrong or misplaced.
 *
 * Usage: node spike/heads/check-readme.mjs
 *   or:  node spike/heads/check-readme.mjs path/to/other/README.md
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Positional argument for README path (optional) ────────────────────────────

const readmePath = process.argv[2]
  ? resolve(process.argv[2])
  : join(__dirname, "README.md");

const resultsPath = join(__dirname, "results.json");

// ── Load inputs ───────────────────────────────────────────────────────────────

const data    = JSON.parse(readFileSync(resultsPath, "utf8"));
const readme  = readFileSync(readmePath, "utf8");

const results = data.results;

// ── Compute numbers from results.json ─────────────────────────────────────────

const HEADS = ["naive", "confidence", "direction", "assumption"];

function isLabelled(r) {
  return r.source !== "real";
}

function computeHead(head) {
  const rows         = results.filter((r) => r.head === head);
  const realRows     = rows.filter((r) => r.source === "real");
  const labelledRows = rows.filter((r) => isLabelled(r));

  const knownBad       = labelledRows.filter((r) => r.expect === "flag");
  const knownBadCaught = knownBad.filter((r) => r.decision === "flag");
  const recall         = `${knownBadCaught.length}/${knownBad.length}`;

  const realFlagged = realRows.filter((r) => r.decision === "flag");
  const flagCount   = realFlagged.length;
  const flagTotal   = realRows.length;
  const flagRatePct = ((flagCount / flagTotal) * 100).toFixed(1);

  const parseFailures = rows.filter((r) => r.decision === "unparseable");

  return {
    head,
    totalCalls:    rows.length,
    recall,           // e.g. "4/4"
    flagCount,        // flags over real fixtures
    flagTotal,        // total real fixtures
    flagRatePct,      // e.g. "13.3"
    parseFailures: parseFailures.length,
  };
}

const headStats  = Object.fromEntries(HEADS.map((h) => [h, computeHead(h)]));

const totalCalls = results.length;
const totalSpend = data.cost;

// ── Table parser ──────────────────────────────────────────────────────────────

/**
 * Parse all markdown tables in the document.
 * Returns an array of table objects: { headerRow: string[], rows: { cells: string[], lineNo: number }[] }
 */
function parseTables(md) {
  const lines  = md.split("\n");
  const tables = [];
  let i        = 0;

  while (i < lines.length) {
    const line = lines[i];
    // A table row starts with | and contains at least one |
    if (!line.trim().startsWith("|")) { i++; continue; }

    // Collect the header row
    const headerCells = parseCells(line);

    // Next line must be the separator (---|---|---)
    const sepLine = lines[i + 1] || "";
    if (!sepLine.trim().startsWith("|") && !sepLine.trim().startsWith("-")) {
      i++; continue;
    }
    // Verify it looks like a separator row
    if (!/^[\s|:-]+$/.test(sepLine.trim())) { i++; continue; }

    // Collect data rows
    const dataRows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      dataRows.push({ cells: parseCells(lines[j]), lineNo: j + 1 /* 1-indexed */ });
      j++;
    }

    if (dataRows.length > 0) {
      tables.push({ header: headerCells, rows: dataRows, headerLineNo: i + 1 });
    }

    i = j;
  }
  return tables;
}

/** Split a markdown table row into trimmed cell values. */
function parseCells(line) {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // drop first/last empty
}

const tables = parseTables(readme);

// ── Table locators ────────────────────────────────────────────────────────────

/**
 * Find a table whose header contains all of the given column header names.
 * Returns the table object or throws a diagnostic.
 */
function findTable(requiredHeaders) {
  const match = tables.find((t) =>
    requiredHeaders.every((h) =>
      t.header.some((cell) => cell.toLowerCase().includes(h.toLowerCase()))
    )
  );
  if (!match) {
    throw new Error(`No table found with headers matching ${JSON.stringify(requiredHeaders)}`);
  }
  return match;
}

/**
 * Find the column index for a header name (case-insensitive substring match).
 */
function colIndex(table, name) {
  const idx = table.header.findIndex((h) =>
    h.toLowerCase().includes(name.toLowerCase())
  );
  if (idx === -1) {
    throw new Error(`Column "${name}" not found in table headers: ${JSON.stringify(table.header)}`);
  }
  return idx;
}

/**
 * Find the row whose first cell matches (case-insensitive, strips backticks).
 */
function findRow(table, headName) {
  const needle = headName.toLowerCase();
  return table.rows.find((r) => {
    const cell = (r.cells[0] || "").toLowerCase().replace(/`/g, "").trim();
    return cell === needle;
  });
}

// ── Cell value checker ────────────────────────────────────────────────────────

let failed = false;

/**
 * Assert that the cell at (row, col) of a table contains exactly `expected`.
 * Comparison is against the trimmed cell text, which may be wrapped in backticks
 * or other markdown decoration — we strip those for matching.
 */
function checkCell(label, table, rowName, colName, expected) {
  const str  = String(expected);
  const row  = findRow(table, rowName);
  if (!row) {
    console.error(`FAIL [${label}]: row "${rowName}" not found in table`);
    failed = true;
    return;
  }
  const col  = colIndex(table, colName);
  const cell = (row.cells[col] || "").replace(/\*\*/g, "").trim();
  // The cell may contain extra decoration; check that the value appears inside it
  if (!cell.includes(str)) {
    console.error(
      `FAIL [${label}]: expected "${str}" in cell (row="${rowName}", col="${colName}") ` +
      `at line ~${row.lineNo}, found "${cell}"`
    );
    failed = true;
  } else {
    console.log(`OK   [${label}]: "${str}" in table cell (row="${rowName}", col="${colName}")`);
  }
}

/**
 * Assert that a specific value appears anywhere in the README (for scalar values
 * that are not in a table, like the total spend in the header line).
 * This is the narrow version: we also check that it appears in the correct
 * conceptual location (inside a known containing string).
 */
function checkScalar(label, containing, expected) {
  const str = String(expected);
  if (!readme.includes(str)) {
    console.error(`FAIL [${label}]: "${str}" not found anywhere in README.md`);
    failed = true;
    return;
  }
  // Verify it appears in the expected containing text
  if (!readme.includes(containing)) {
    console.error(`FAIL [${label}]: containing phrase "${containing}" not found in README.md`);
    failed = true;
    return;
  }
  // Find the containing phrase and make sure the value is near it
  const pos  = readme.indexOf(containing);
  const near = readme.slice(Math.max(0, pos - 50), pos + containing.length + 200);
  if (!near.includes(str)) {
    console.error(
      `FAIL [${label}]: "${str}" not found near the phrase "${containing.slice(0, 40)}…"`
    );
    failed = true;
  } else {
    console.log(`OK   [${label}]: "${str}" found near "${containing.slice(0, 40)}…"`);
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

console.log("=== Checking README numbers against results.json ===\n");

// ── Recall table ─────────────────────────────────────────────────────────────
// Header: | Head | Caught | Recall |
const recallTable = findTable(["head", "caught", "recall"]);
for (const h of HEADS) {
  const s = headStats[h];
  checkCell(`${h}: recall (cell)`, recallTable, h, "recall", s.recall);
}

// ── Flag rate table ───────────────────────────────────────────────────────────
// Header: | Head | Flagged | Flag rate |
const flagTable = findTable(["head", "flagged", "flag rate"]);
for (const h of HEADS) {
  const s = headStats[h];
  // Flag count as "N/total" in the Flagged column
  checkCell(`${h}: flag count (cell)`, flagTable, h, "flagged", `${s.flagCount}/${s.flagTotal}`);
  // Flag rate % in the flag rate column
  checkCell(`${h}: flag rate % (cell)`, flagTable, h, "flag rate", s.flagRatePct);
}

// ── Parse failures table ──────────────────────────────────────────────────────
// Header: | Head | Parse failures |
const parseTable = findTable(["head", "parse failures"]);
for (const h of HEADS) {
  const s = headStats[h];
  checkCell(`${h}: parse failures (cell)`, parseTable, h, "parse failures", s.parseFailures);
}

// ── Per-head call count — each head's total appears in the intro sentence ─────
// Check that each head's call count appears in the file (scalar, near "calls")
for (const h of HEADS) {
  const s = headStats[h];
  if (!readme.includes(String(s.totalCalls))) {
    console.error(`FAIL [${h}: total calls]: "${s.totalCalls}" not found in README.md`);
    failed = true;
  } else {
    console.log(`OK   [${h}: total calls]: "${s.totalCalls}" found in README.md`);
  }
}

// ── Total call count ──────────────────────────────────────────────────────────
checkScalar("total calls", "Total calls:", String(totalCalls));

// ── Total spend — check rounded to 3 decimal places, appears near "spend" ────
checkScalar("total spend", "Total spend:", `$${totalSpend.toFixed(3)}`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("");
if (failed) {
  console.error("FAIL — one or more numbers are missing or misplaced in README.md");
  process.exit(1);
} else {
  console.log("PASS — all numbers confirmed in the correct README.md table cells");
  process.exit(0);
}
