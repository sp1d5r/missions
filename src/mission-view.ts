/**
 * Mission-view TUI: a three-pane terminal UI for a single mission.
 *
 * Pane layout (left to right):
 *   1. Timeline  — structured events from MissionState.events (a6)
 *   2. Log tail  — live tail of <outDir>/mission.log with scrollback + auto-follow
 *   3. Chat      — mission-scoped overseer agent (a5)
 *
 * Keyboard bindings:
 *   Tab / Shift-Tab  — cycle focus between panes
 *   ↑ / ↓           — scroll log pane (when log pane focused, disables auto-follow)
 *   f                — re-enable auto-follow in log pane
 *   Enter            — send chat message (when chat pane active)
 *   Backspace        — delete last char (chat pane)
 *   Esc / q          — return to the board (no process churn)
 */

import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import { StateStore } from "./state.js";
import { createOverseerSession, type OverseerSession } from "./overseer.js";
import { readActive } from "./registry.js";
import type { MissionEvent, MissionState } from "./types.js";

// ---------------------------------------------------------------------------
// ANSI helpers (duplicated from control.ts to keep this module self-contained)
// ---------------------------------------------------------------------------

const ESC = "\x1b";
const ANSI = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";

function visLen(s: string): number {
	return s.replace(ANSI, "").length;
}

function truncVis(s: string, w: number): string {
	if (w <= 0) return "";
	let out = "";
	let vis = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === ESC) {
			const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		if (vis >= w - 1) return `${out}…${RESET}`;
		out += s[i];
		vis++;
		i++;
	}
	return out;
}

function padVis(s: string, w: number): string {
	const v = visLen(s);
	if (v > w) return truncVis(s, w);
	return s + " ".repeat(w - v) + (s.includes(ESC) ? RESET : "");
}

function wrapLines(text: string, w: number): string[] {
	if (!text) return [];
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		if (visLen(raw) <= w) {
			out.push(raw);
		} else {
			// Simple word-wrap
			let cur = "";
			for (const word of raw.split(" ")) {
				const candidate = cur ? `${cur} ${word}` : word;
				if (visLen(candidate) <= w) {
					cur = candidate;
				} else {
					if (cur) out.push(cur);
					cur = word.length > w ? word.slice(0, w - 1) + "…" : word;
				}
			}
			if (cur || out.length === 0) out.push(cur);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Prefix-resolve runId from known active records and out-dirs
// ---------------------------------------------------------------------------

/** Resolve a partial runId prefix to a full outDir path. Returns null if ambiguous/missing. */
export function resolveRunId(prefix: string): { outDir: string; id: string } | null {
	const active = readActive();

	// Helper: given an active record, resolve its outDir.
	// Prefers the stored outDir field if present; otherwise falls back to the conventional path.
	function resolveRecordOutDir(rec: { id: string; repo: string; outDir?: string }): string | null {
		// If the record has an outDir stored, trust it first.
		if (rec.outDir && existsSync(join(rec.outDir, "state.json"))) {
			return rec.outDir;
		}
		// Fall back to the conventional path: <repo>/.missions/runs/<id>
		const conventional = join(rec.repo, ".missions", "runs", rec.id);
		if (existsSync(join(conventional, "state.json"))) {
			return conventional;
		}
		return null;
	}

	// Exact match first
	const exactActive = active.filter((r) => r.id === prefix);
	if (exactActive.length === 1 && exactActive[0]) {
		const outDir = resolveRecordOutDir(exactActive[0]);
		if (outDir) return { outDir, id: exactActive[0].id };
	}

	// Prefix match
	const prefixActive = active.filter((r) => r.id.startsWith(prefix));
	if (prefixActive.length === 1 && prefixActive[0]) {
		const outDir = resolveRecordOutDir(prefixActive[0]);
		if (outDir) return { outDir, id: prefixActive[0].id };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Timeline pane
// ---------------------------------------------------------------------------

const EVENT_COLOR: Record<string, (s: string) => string> = {
	status_transition: chalk.cyan,
	tool_call: chalk.dim,
	validation_result: chalk.yellow,
	milestone_verdict: chalk.magenta,
	lifecycle: chalk.green,
	error: chalk.red,
	image: chalk.blue,
};

const EVENT_SYMBOL: Record<string, string> = {
	status_transition: "→",
	tool_call: "·",
	validation_result: "✓",
	milestone_verdict: "◉",
	lifecycle: "▸",
	error: "✗",
	image: "🖼",
};

function renderTimeline(events: MissionEvent[], state: MissionState, w: number, h: number): string[] {
	const lines: string[] = [];

	// Header
	const goal = truncVis(state.goal, w - 4);
	lines.push(chalk.bold.cyan(`  ${goal}`));
	lines.push(chalk.dim(`  ${state.status}${state.outcome ? ` · ${state.outcome}` : ""}${state.reportPath ? " · report available" : ""}`));
	if (state.reportPath) {
		lines.push(chalk.dim(`  ${state.reportPath}`));
	}
	// Debrief — shown above the scorecard/timeline when populated
	if (state.debrief) {
		lines.push(chalk.dim("  " + "─".repeat(Math.max(0, w - 4))));
		for (const dl of state.debrief.split("\n")) {
			lines.push(`  ${truncVis(dl, w - 4)}`);
		}
	}
	lines.push(chalk.dim("  " + "─".repeat(Math.max(0, w - 4))));

	if (!events || !events.length) {
		lines.push(chalk.dim("  (no events yet)"));
	} else {
		// Show most recent events at the bottom, all if they fit, else tail
		const maxEvents = Math.max(1, h - lines.length - 1);
		const tail = events.slice(-maxEvents);
		for (const ev of tail) {
			const color = EVENT_COLOR[ev.kind] ?? chalk.white;
			const sym = EVENT_SYMBOL[ev.kind] ?? "·";
			const time = ev.at.slice(11, 19); // HH:MM:SS
			// Image events get a bracketed prefix as a terminal fallback (no inline rendering).
			const rawLabel = ev.kind === "image" ? `[image] ${ev.label}` : ev.label;
			const label = truncVis(rawLabel, w - 14);
			const row = color(`  ${sym} ${chalk.dim(time)} ${label}`);
			lines.push(row);
			if (ev.detail) {
				const detail = truncVis(ev.detail, w - 6);
				lines.push(chalk.dim(`      ${detail}`));
			}
		}
	}

	return lines;
}

// ---------------------------------------------------------------------------
// Log tail pane
// ---------------------------------------------------------------------------

function renderLogPane(logLines: string[], scrollOffset: number, autoFollow: boolean, w: number, h: number): string[] {
	const available = h - 2; // header + footer
	const visible = logLines.slice(-(available + scrollOffset), scrollOffset > 0 ? -scrollOffset : undefined);
	const tail = visible.slice(-available);

	const lines: string[] = [];
	lines.push(chalk.dim(`  mission.log${autoFollow ? "" : ` [+${scrollOffset} scroll]`}`));
	for (let i = 0; i < available; i++) {
		const raw = tail[i] ?? "";
		lines.push("  " + truncVis(raw, w - 4));
	}
	lines.push(autoFollow ? chalk.dim("  [auto-follow] f=pin") : chalk.dim("  [pinned] f=follow"));
	return lines;
}

// ---------------------------------------------------------------------------
// Chat pane
// ---------------------------------------------------------------------------

function renderChatPane(transcript: string, buffer: string, focused: boolean, w: number, h: number): string[] {
	const composer = focused
		? `${chalk.bold("›")} ${buffer}${chalk.inverse(" ")}`
		: chalk.dim("[Tab for chat]");
	const composerLines = wrapLines(composer, w - 4);
	const composerH = Math.min(composerLines.length, 3);
	const transcriptH = h - composerH - 2;

	const allLines = wrapLines(transcript, w - 4);
	const tail = allLines.slice(-transcriptH);

	const lines: string[] = [];
	lines.push(chalk.dim("  overseer chat"));
	for (let i = 0; i < transcriptH; i++) {
		lines.push("  " + padVis(tail[i] ?? "", w - 4));
	}
	for (let i = 0; i < composerH; i++) {
		lines.push("  " + padVis(composerLines[i] ?? "", w - 4));
	}
	lines.push(focused ? chalk.dim("  Enter send · Esc back") : chalk.dim("  Tab to focus"));
	return lines;
}

// ---------------------------------------------------------------------------
// Full frame render
// ---------------------------------------------------------------------------

type PaneFocus = "timeline" | "log" | "chat";

interface ViewState {
	width: number;
	height: number;
	events: MissionEvent[];
	missionState: MissionState;
	logLines: string[];
	scrollOffset: number;
	autoFollow: boolean;
	transcript: string;
	buffer: string;
	focus: PaneFocus;
	toast: string;
}

function renderView(s: ViewState): string {
	const { width: W, height: H } = s;
	const D = chalk.dim;

	// Divide into three panes
	const timelineW = Math.max(24, Math.floor(W * 0.28));
	const logW = Math.max(24, Math.floor(W * 0.36));
	const chatW = Math.max(20, W - timelineW - logW - 8); // 8 = separators

	const innerH = Math.max(4, H - 2); // top edge + bottom status

	const timelineLines = renderTimeline(s.events, s.missionState, timelineW, innerH);
	const logLines = renderLogPane(s.logLines, s.scrollOffset, s.autoFollow, logW, innerH);
	const chatLines = renderChatPane(s.transcript, s.buffer, s.focus === "chat", chatW, innerH);

	// Pad to innerH
	while (timelineLines.length < innerH) timelineLines.push("");
	while (logLines.length < innerH) logLines.push("");
	while (chatLines.length < innerH) chatLines.push("");

	const focusLabel = (pane: PaneFocus, title: string): string =>
		s.focus === pane ? chalk.bold(title) : D(title);

	const seg = (label: string, w: number): string => {
		const l = label ? ` ${label} ` : "";
		const shown = truncVis(l, w);
		return shown + D("─".repeat(Math.max(0, w - visLen(shown))));
	};

	const rows: string[] = [];
	// Top edge
	rows.push(
		D("┌─") + seg(focusLabel("timeline", "TIMELINE"), timelineW + 1) +
		D("┬─") + seg(focusLabel("log", "LOG"), logW + 1) +
		D("┬─") + seg(focusLabel("chat", "CHAT"), chatW + 1) +
		D("┐"),
	);

	for (let y = 0; y < innerH; y++) {
		rows.push(
			`${D("│")} ${padVis(timelineLines[y] ?? "", timelineW)} ${D("│")} ${padVis(logLines[y] ?? "", logW)} ${D("│")} ${padVis(chatLines[y] ?? "", chatW)} ${D("│")}`,
		);
	}

	// Bottom edge
	const status = s.toast || D("Tab cycle panes · ↑↓ scroll log · f follow · q/Esc back to board");
	rows.push(D("└─") + seg(status, timelineW + logW + chatW + 7) + D("┘"));

	return rows.join("\r\n");
}

// ---------------------------------------------------------------------------
// Load log file
// ---------------------------------------------------------------------------

function loadLogFile(outDir: string): string[] {
	const p = join(outDir, "mission.log");
	if (!existsSync(p)) return [];
	try {
		return readFileSync(p, "utf-8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the mission-view TUI for a given outDir.
 * Resolves when the user presses Esc or q (returns to the board).
 */
export async function runMissionView(outDir: string): Promise<void> {
	const store = StateStore.load(outDir);
	if (!store) {
		process.stderr.write(chalk.red(`No state.json in ${outDir}\n`));
		return;
	}

	return new Promise((resolve) => {
		const out = process.stdout;

		if (!process.stdin.isTTY) {
			// Non-interactive: just print the timeline
			const events = store.state.events ?? [];
			const lines = renderTimeline(events, store.state, out.columns ?? 80, 40);
			out.write(lines.join("\n") + "\n");
			resolve();
			return;
		}

		let missionState = store.state;
		let events: MissionEvent[] = missionState.events ?? [];
		let logLines = loadLogFile(outDir);
		let scrollOffset = 0;
		let autoFollow = true;
		let transcript = "";
		let buffer = "";
		let focus: PaneFocus = "timeline";
		let toast = "";
		let overseer: OverseerSession | null = null;
		let alive = true;
		let logMtime = 0;

		// Load overseer session (may return null if no API key or state)
		try {
			overseer = createOverseerSession(outDir);
		} catch {
			// Overseer creation failed; chat pane shows a hint
		}
		if (overseer) {
			// Pre-populate transcript with history
			transcript = overseer.historyTranscript();
			overseer.subscribe((text: string) => {
				transcript += text;
				if (transcript.length > 80000) transcript = transcript.slice(-60000);
				scheduleDraw();
			});
		} else {
			transcript = chalk.dim("(overseer unavailable — ANTHROPIC_API_KEY required)");
		}

		const draw = (): void => {
			if (!alive) return;
			out.write("\x1b[H");
			out.write(
				renderView({
					width: out.columns ?? 100,
					height: out.rows ?? 30,
					events,
					missionState,
					logLines,
					scrollOffset,
					autoFollow,
					transcript,
					buffer,
					focus,
					toast,
				}),
			);
			out.write("\x1b[J");
		};

		let pending: NodeJS.Timeout | undefined;
		const scheduleDraw = (): void => {
			if (pending) return;
			pending = setTimeout(() => {
				pending = undefined;
				if (alive) draw();
			}, 32);
		};

		const cleanup = (): void => {
			if (!alive) return;
			alive = false;
			clearInterval(refreshTimer);
			clearInterval(logWatchTimer);
			if (pending) clearTimeout(pending);
			process.stdin.removeListener("keypress", onKey);
			process.stdout.removeListener("resize", onResize);
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
			out.write("\x1b[?25h\x1b[?1049l");
			overseer?.close();
			resolve();
		};

		const onResize = (): void => {
			out.write("\x1b[2J");
			draw();
		};

		const onKey = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): void => {
			if (!key) return;
			if (key.ctrl && key.name === "c") return cleanup();

			// Chat input mode
			if (focus === "chat") {
				if (key.name === "escape") {
					focus = "timeline";
					toast = "";
					return draw();
				}
				if (key.name === "return") {
					const v = buffer.trim();
					buffer = "";
					if (v && overseer) {
						transcript += `\n${chalk.bold("you ›")} ${v}`;
						overseer.input(v);
						toast = chalk.dim("…waiting for overseer…");
					}
					return draw();
				}
				if (key.name === "backspace") {
					buffer = buffer.slice(0, -1);
					return draw();
				}
				if (str && !key.ctrl && !key.meta && str.length >= 1 && str >= " ") {
					buffer += str;
					return draw();
				}
				return;
			}

			// Global navigation
			if (key.name === "q" || key.name === "escape") return cleanup();

			if (key.name === "tab") {
				// Cycle focus: timeline → log → chat → timeline
				const order: PaneFocus[] = ["timeline", "log", "chat"];
				const idx = order.indexOf(focus);
				focus = order[(idx + 1) % order.length] as PaneFocus;
				toast = "";
				return draw();
			}

			// Log pane scroll (works regardless of pane focus for convenience)
			if (key.name === "up") {
				if (focus === "log") {
					scrollOffset = Math.min(scrollOffset + 3, Math.max(0, logLines.length - 5));
					autoFollow = scrollOffset === 0 ? true : false;
				}
				return draw();
			}
			if (key.name === "down") {
				if (focus === "log") {
					scrollOffset = Math.max(0, scrollOffset - 3);
					if (scrollOffset === 0) autoFollow = true;
				}
				return draw();
			}

			if (key.name === "f") {
				// Re-enable auto-follow
				scrollOffset = 0;
				autoFollow = true;
				toast = chalk.dim("auto-follow enabled");
				return draw();
			}

			draw();
		};

		// Periodically reload state + log
		const refreshTimer = setInterval(() => {
			const reloaded = StateStore.load(outDir);
			if (reloaded) {
				missionState = reloaded.state;
				events = missionState.events ?? [];
			}
			if (autoFollow) {
				logLines = loadLogFile(outDir);
			}
			if (alive) draw();
		}, 2000);

		// Watch log file for changes (lighter-weight than full reload interval)
		const logPath = join(outDir, "mission.log");
		const logWatchTimer = setInterval(() => {
			try {
				if (existsSync(logPath)) {
					const { mtimeMs } = statSync(logPath);
					if (mtimeMs !== logMtime) {
						logMtime = mtimeMs;
						logLines = loadLogFile(outDir);
						if (autoFollow) scheduleDraw();
					}
				}
			} catch {
				/* ignore */
			}
		}, 500);

		out.write("\x1b[?1049h\x1b[?25l");
		emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("keypress", onKey);
		process.stdout.on("resize", onResize);

		draw();
	});
}
