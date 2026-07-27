import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { basename } from "node:path";
import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import { cmuxOpenBrowser, cmuxOpenWorkspace, hasCmuxPassword, insideCmux } from "./cmux.js";
import { mergeBranch, removeWorktree } from "./git.js";
import { daemonExists, drainFrames, encode, socketPathFor } from "./ipc.js";
import { type ActiveRecord, readActive, updateActive } from "./registry.js";
import { generateSuggestions, loadSuggestions, type Suggestion } from "./suggest.js";
import { buildItems, type Item, milestoneLabel, money, outcomeColor, outcomeKind, outcomeSymbol, verdictLabel } from "./tui.js";

const ESC = "\x1b";
const ANSI = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";

function visLen(s: string): number {
	return s.replace(ANSI, "").length;
}

/** Truncate to a visible width, preserving ANSI codes and adding an ellipsis. */
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

/** Split off the first `w` visible columns, carrying ANSI codes through. */
function splitVis(s: string, w: number): [string, string] {
	let head = "";
	let vis = 0;
	let i = 0;
	while (i < s.length && vis < w) {
		if (s[i] === ESC) {
			const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m) {
				head += m[0];
				i += m[0].length;
				continue;
			}
		}
		head += s[i];
		vis++;
		i++;
	}
	return [head, s.slice(i)];
}

/**
 * Word-wrap a line to a visible width, passing ANSI codes through untouched.
 * Breaking mid-word ("should do i / t.") makes the chief's replies read as
 * garbled, which is the pane you spend the most time actually reading.
 */
function wrapAnsi(line: string, width: number): string[] {
	const w = width < 4 ? 4 : width;
	if (visLen(line) <= w) return [line];
	const out: string[] = [];
	let cur = "";
	for (const word of line.split(" ")) {
		const candidate = cur ? `${cur} ${word}` : word;
		if (visLen(candidate) <= w) {
			cur = candidate;
			continue;
		}
		if (cur) out.push(cur);
		// A single word wider than the pane still has to break somewhere.
		let rest = word;
		while (visLen(rest) > w) {
			const [head, tail] = splitVis(rest, w);
			out.push(head);
			rest = tail;
		}
		cur = rest;
	}
	if (cur || out.length === 0) out.push(cur);
	return out;
}

/** Render the right-hand board pane. */
function boardPane(items: Item[], selected: number, focused: boolean, w: number, now: number): string[] {
	const lines: string[] = [];
	let lastKind: string | null = null;
	items.forEach((item, i) => {
		if (item.kind !== lastKind) {
			lastKind = item.kind;
			const n = items.filter((x) => x.kind === item.kind).length;
			const title = item.kind === "review" ? "NEEDS YOU" : item.kind === "running" ? "RUNNING" : "SUGGESTED";
			lines.push(chalk.bold.dim(`${title} (${n})`));
		}
		const sel = focused && i === selected;
		let text: string;
		let meta = "";
		if (item.kind === "suggest") {
			text = `${chalk.dim("•")} ${item.sug.goal}`;
		} else {
			const r = item.rec;
			const parts = [milestoneLabel(r), money(r.costUsd)].filter(Boolean);
			if (item.kind === "running") {
				parts.push(`${Math.max(0, Math.round((now - Date.parse(r.updatedAt)) / 1000))}s`);
			} else {
				// Lead with WHY it wants you — "stalled" and "clean" are both succeeded runs.
				parts.unshift(verdictLabel(r));
			}
			meta = chalk.dim(parts.join(" · "));
			text = `${outcomeColor(r)(outcomeSymbol(r))} ${r.goal}`;
		}
		// Right-align the metadata so the column scans vertically.
		const room = w - 2;
		const metaLen = visLen(meta);
		const body = sel
			? chalk.inverse(padVis(`${text.replace(ANSI, "")}${meta ? `  ${meta.replace(ANSI, "")}` : ""}`, room))
			: metaLen && visLen(text) + metaLen + 2 <= room
				? `${padVis(truncVis(text, room - metaLen - 1), room - metaLen)}${meta}`
				: truncVis(text, room);
		lines.push(`${sel ? chalk.cyan("▌") : " "} ${body}`);
		if (sel) {
			const hint =
				item.kind === "review"
					? outcomeKind(item.rec) === "failed"
						? "⏎ report · r retry · d dismiss"
						: outcomeKind(item.rec) === "review"
							? `⏎ report · ${chalk.yellow("a merge anyway")} · r retry · d dismiss`
							: "⏎ report · a merge · w tree · d dismiss"
					: item.kind === "running"
						? "⏎ worktree · o report"
						: "⏎ dispatch";
			lines.push(chalk.dim(`   ${hint}`));
		}
	});
	if (!items.length) lines.push(chalk.dim("nothing yet — ask the chief for work"));
	return lines;
}

/** Bottom-anchored chat transcript, wrapped to `height` lines of visible width `w`. */
function chatPane(transcript: string, w: number, height: number): string[] {
	const wrapped: string[] = [];
	for (const raw of transcript.split("\n")) {
		for (const seg of wrapAnsi(raw, w)) wrapped.push(seg);
	}
	const tail = wrapped.slice(-height);
	while (tail.length < height) tail.unshift("");
	return tail;
}

export interface ControlFrameState {
	width: number;
	height: number;
	transcript: string;
	items: Item[];
	selected: number;
	mode: "chat" | "board";
	buffer: string;
	toast: string;
	/** Non-empty while the chief is working — replaces the status line. */
	busy: string;
	spin: number;
	targetCwd: string;
	now: number;
}

/**
 * Compose the framed console. Pure — testable without a TTY or a daemon.
 *
 * The frame is not decoration. Two panes divided by whitespace read as text
 * spilling down the screen; the same two panes inside a fixed border read as
 * regions you are working inside, and the boundary itself carries which one has
 * focus and where typing lands. Titles live in the top edge and the status line
 * in the bottom edge, so the whole frame costs two rows — one fewer than the
 * header/status/input stack it replaces.
 *
 * Column map for a body row:  │ ‹Lw› │ ‹Rw› │   →   width = Lw + Rw + 7
 */
export function composeControlFrame(s: ControlFrameState): { rows: string[]; cursorRow: number; cursorCol: number } {
	const inner = Math.max(46, s.width - 7);
	const Lw = Math.max(24, Math.floor(inner * 0.56));
	const Rw = Math.max(18, inner - Lw);
	const bodyH = Math.max(4, s.height - 2); // top edge + bottom edge
	const chatH = bodyH - 1; // last body row is the composer

	const left = chatPane(s.transcript, Lw, chatH);
	const right = boardPane(s.items, s.selected, s.mode === "board", Rw, s.now);

	const needs = s.items.filter((i) => i.kind === "review").length;
	const run = s.items.filter((i) => i.kind === "running").length;
	const unresolved = s.items.filter((i) => i.kind === "review" && outcomeKind(i.rec) === "review").length;
	const spend = s.items.reduce((n, i) => (i.kind === "suggest" ? n : n + (i.rec.costUsd ?? 0)), 0);

	const D = chalk.dim;
	/** A titled edge segment of exact visible width, padded out with box rule. */
	const seg = (label: string, w: number): string => {
		const l = label ? ` ${label} ` : "";
		const shown = truncVis(l, w);
		return shown + D("─".repeat(Math.max(0, w - visLen(shown))));
	};

	// Focus is carried by the frame itself: the active pane's title is lit.
	const chatTitle = s.mode === "chat" ? chalk.bold("CHIEF") : D("chief");
	const boardTitle = s.mode === "board" ? chalk.bold("BOARD") : D("board");
	const boardMeta = D(`${run} running · ${needs} need you${unresolved ? ` · ${unresolved} unresolved` : ""} · ${money(spend)}`);

	// Edge segments span the pane PLUS its two padding columns, so the corners land
	// on the same columns as the "│" separators in the body rows.
	const rows: string[] = [];
	rows.push(D("┌─") + seg(`${chalk.bold("☀")} ${chatTitle} ${D(basename(s.targetCwd))}`, Lw + 1) + D("┬─") + seg(`${boardTitle} ${boardMeta}`, Rw + 1) + D("┐"));

	for (let y = 0; y < chatH; y++) {
		rows.push(`${D("│")} ${padVis(left[y] ?? "", Lw)} ${D("│")} ${padVis(right[y] ?? "", Rw)} ${D("│")}`);
	}

	// The composer sits inside the left pane, so the frame makes it obvious where typing lands.
	const composer = s.mode === "chat" ? `${chalk.bold("›")} ${s.buffer}` : D("[Tab to type to the chief]");
	rows.push(`${D("│")} ${padVis(composer, Lw)} ${D("│")} ${padVis(right[chatH] ?? "", Rw)} ${D("│")}`);

	const spinner = s.busy ? `${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[s.spin % 10]} ` : "";
	const status = s.busy
		? chalk.cyan(`${spinner}${s.busy}`)
		: s.toast || D(s.mode === "chat" ? "Enter sends · Tab → board · Ctrl-C detaches" : "↑↓ move · ⏎ act · a merge · r retry · d dismiss · g ideas");
	const hint = D(s.mode === "chat" ? "Tab → board" : "Tab → chat · q quit");
	rows.push(D("└─") + seg(status, Lw + 1) + D("┴─") + seg(hint, Rw + 1) + D("┘"));

	// Composer is the last body row; its content starts 4 columns in ("│ › ").
	return { rows, cursorRow: bodyH + 1, cursorCol: 5 };
}

function tryConnect(socketPath: string): Promise<Socket | null> {
	return new Promise((res) => {
		const sock = connect(socketPath);
		const onErr = () => {
			sock.destroy();
			res(null);
		};
		sock.once("error", onErr);
		sock.once("connect", () => {
			sock.removeListener("error", onErr);
			res(sock);
		});
	});
}

function spawnDaemon(targetCwd: string, socketPath: string): void {
	const child = spawn(process.execPath, [process.argv[1] as string, "__daemon", "--target", targetCwd, "--socket", socketPath], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
}

async function ensureConnected(targetCwd: string, socketPath: string): Promise<Socket> {
	let sock = await tryConnect(socketPath);
	if (sock) return sock;
	if (!daemonExists(socketPath)) {
		process.stdout.write(chalk.dim("starting the org (daemon)…\n"));
		spawnDaemon(targetCwd, socketPath);
	}
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 150));
		sock = await tryConnect(socketPath);
		if (sock) return sock;
		if (i === 6 && !daemonExists(socketPath)) spawnDaemon(targetCwd, socketPath);
	}
	throw new Error(`Could not reach the missions daemon at ${socketPath}`);
}

/**
 * Mission control: talk to the chief (left) while the live board runs beside it (right).
 * The chief is the primary agent — you message it and it spawns the missions; the board reflects them.
 * Tab switches focus between chat and board; board keys action the queue directly.
 */
export async function runControl(targetCwd: string): Promise<void> {
	const socketPath = socketPathFor(targetCwd);
	const sock = await ensureConnected(targetCwd, socketPath);
	const out = process.stdout;

	let transcript = "";
	let suggestions: Suggestion[] = loadSuggestions();
	let mode: "chat" | "board" = "chat";
	let selected = 0;
	/** Mission id awaiting a second `a` press to confirm merging unresolved work. */
	let pendingMerge: string | null = null;
	let buffer = "";
	let toast = "";
	let awaiting = false;
	let thinking = false;
	let spin = 0;
	let alive = true;

	const append = (text: string): void => {
		transcript += text;
		if (transcript.length > 80000) transcript = transcript.slice(-60000);
		if (/\bchief\b/.test(text)) awaiting = false;
	};

	const items = (): Item[] => buildItems(readActive(), suggestions);

	const draw = (): void => {
		const its = items();
		if (selected >= its.length) selected = Math.max(0, its.length - 1);
		const { rows, cursorRow, cursorCol } = composeControlFrame({
			width: out.columns ?? 100,
			height: out.rows ?? 30,
			transcript,
			items: its,
			selected,
			mode,
			buffer,
			toast,
			busy: awaiting || thinking ? (thinking ? "chief drafting ideas…" : "chief is thinking…") : "",
			spin,
			targetCwd,
			now: Date.now(),
		});

		out.write("\x1b[H");
		out.write(rows.map((l) => l + "\x1b[K").join("\r\n"));
		out.write("\x1b[J");

		if (mode === "chat") out.write(`\x1b[${cursorRow};${cursorCol + buffer.length}H\x1b[?25h`);
		else out.write("\x1b[?25l");
	};

	const send = (text: string): void => {
		append(`\n${chalk.bold("you ›")} ${text}\n`);
		sock.write(encode({ t: "input", text }));
		awaiting = true;
	};

	const askChief = (): void => {
		if (thinking) return;
		const cur = items()[selected];
		const repo = cur?.kind === "suggest" ? cur.sug.repo : cur ? cur.rec.repo : (readActive()[0]?.repo ?? targetCwd);
		thinking = true;
		toast = "";
		generateSuggestions(repo)
			.then((got) => {
				suggestions = [...suggestions.filter((s) => s.repo !== repo), ...got];
				toast = chalk.dim(`chief proposed ${got.length} mission(s) for ${basename(repo)}`);
			})
			.catch((e: unknown) => {
				toast = chalk.red(`ideas failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 50)}`);
			})
			.finally(() => {
				thinking = false;
				draw();
			});
	};

	const dispatch = (repo: string, goal: string): void => {
		spawn(process.execPath, [process.argv[1] as string, "run", "--target", repo, "--goal", goal], { detached: true, stdio: "ignore" }).unref();
	};

	const acceptMerge = (r: ActiveRecord): void => {
		if (r.status !== "succeeded") return void (toast = chalk.yellow("only succeeded missions can merge"));
		if (!r.worktreePath) return void (toast = chalk.yellow("no worktree to merge"));
		// Unresolved = failing assertions, blocking bugs, or issues nobody ruled on.
		// Landing that is a decision, so it costs a second keystroke.
		if (outcomeKind(r) === "review" && pendingMerge !== r.id) {
			pendingMerge = r.id;
			return void (toast = chalk.yellow(`⚠ ${verdictLabel(r)} — read the report first. Press a again to merge anyway.`));
		}
		pendingMerge = null;
		const res = mergeBranch(r.repo, `missions/${r.id}`);
		if (res.ok) {
			removeWorktree(r.repo, r.worktreePath);
			updateActive(r.id, { cleared: true, status: "merged" });
			toast = chalk.green(`✓ merged missions/${r.id.slice(0, 8)} → ${r.repoName}`);
		} else {
			toast = chalk.red(`merge failed: ${res.out.split("\n")[0]?.slice(0, 60)}`);
		}
	};

	const boardKey = (name: string): void => {
		// Any key other than a second `a` cancels a pending merge confirmation.
		if (name !== "a") pendingMerge = null;
		const its = items();
		const item = its[selected];
		if (name === "up") selected = Math.max(0, selected - 1);
		else if (name === "down") selected = Math.min(its.length - 1, selected + 1);
		else if (name === "g") askChief();
		else if (!item) return;
		else if (name === "return") {
			if (item.kind === "suggest") {
				dispatch(item.sug.repo, item.sug.goal);
				toast = chalk.green(`▶ dispatched: ${item.sug.goal.slice(0, 50)}`);
			} else if (item.kind === "running" && item.rec.worktreePath) {
				if (insideCmux()) cmuxOpenWorkspace(item.rec.worktreePath);
				else toast = chalk.dim(`worktree: ${item.rec.worktreePath}`);
			} else if (item.kind === "review" && item.rec.reportPath) {
				if (insideCmux() && hasCmuxPassword()) cmuxOpenBrowser(item.rec.reportPath);
				else toast = chalk.dim(`report: ${item.rec.reportPath}`);
			}
		} else if (name === "a" && item.kind === "review") acceptMerge(item.rec);
		else if (name === "r" && item.kind === "review") {
			dispatch(item.rec.repo, item.rec.goal);
			updateActive(item.rec.id, { cleared: true });
			toast = chalk.green(`▶ re-dispatched: ${item.rec.goal.slice(0, 45)}`);
		} else if (name === "d" && item.kind === "review") {
			updateActive(item.rec.id, { cleared: true });
			toast = chalk.dim("dismissed");
		} else if (name === "o" && item.kind !== "suggest" && item.rec.reportPath) {
			if (insideCmux() && hasCmuxPassword()) cmuxOpenBrowser(item.rec.reportPath);
			else toast = chalk.dim(`report: ${item.rec.reportPath}`);
		} else if (name === "w" && item.kind !== "suggest" && item.rec.worktreePath) {
			if (insideCmux()) cmuxOpenWorkspace(item.rec.worktreePath);
			else toast = chalk.dim(`worktree: ${item.rec.worktreePath}`);
		}
	};

	const cleanup = (): void => {
		if (!alive) return;
		alive = false;
		clearInterval(timer);
		process.stdin.removeListener("keypress", onKey);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		out.write("\x1b[?25h\x1b[?1049l");
		sock.end();
		out.write(chalk.dim("detached — the org keeps running. Reattach any time with `missions`.\n"));
	};

	const onKey = (str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
		if (!key) return;
		if (key.ctrl && key.name === "c") return cleanup();
		if (key.name === "tab") {
			mode = mode === "chat" ? "board" : "chat";
			toast = "";
			return draw();
		}
		if (mode === "chat") {
			if (key.name === "return") {
				const v = buffer.trim();
				buffer = "";
				if (v) send(v);
			} else if (key.name === "backspace") buffer = buffer.slice(0, -1);
			else if (str && !key.ctrl && str.length === 1 && str >= " ") buffer += str;
		} else {
			if (key.name === "escape") {
				mode = "chat";
				return draw();
			}
			if (key.name === "q") return cleanup();
			boardKey(key.name ?? "");
		}
		draw();
	};

	let buf = "";
	sock.on("data", (d) => {
		buf += d.toString();
		const { frames, rest } = drainFrames(buf);
		buf = rest;
		let touched = false;
		for (const f of frames) {
			if (f.t === "out") {
				append(f.text);
				touched = true;
			}
		}
		if (touched) draw();
	});
	sock.on("close", () => {
		if (alive) {
			append(chalk.red("\n(daemon connection closed)\n"));
			draw();
		}
	});

	out.write("\x1b[?1049h");
	emitKeypressEvents(process.stdin);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("keypress", onKey);
	const timer = setInterval(() => {
		spin++;
		draw();
	}, 500);
	draw();

	await new Promise<void>((res) => {
		const check = setInterval(() => {
			if (!alive) {
				clearInterval(check);
				res();
			}
		}, 100);
	});
}
