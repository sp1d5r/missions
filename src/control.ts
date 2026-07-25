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
import { buildItems, type Item } from "./tui.js";

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

/** Char-wrap a single line to a visible width, passing ANSI codes through untouched. */
function wrapAnsi(line: string, width: number): string[] {
	const w = width < 4 ? 4 : width;
	const out: string[] = [];
	let cur = "";
	let vis = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === ESC) {
			const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m) {
				cur += m[0];
				i += m[0].length;
				continue;
			}
		}
		cur += line[i];
		vis++;
		i++;
		if (vis >= w) {
			out.push(cur);
			cur = "";
			vis = 0;
		}
	}
	if (cur || out.length === 0) out.push(cur);
	return out;
}

const SYM: Record<string, string> = { succeeded: "✓", failed: "✗", merged: "✓" };

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
		if (item.kind === "suggest") {
			text = `${chalk.dim("•")} ${item.sug.goal}`;
		} else if (item.kind === "running") {
			const secs = Math.max(0, Math.round((now - Date.parse(item.rec.updatedAt)) / 1000));
			text = `${chalk.cyan("▸")} ${item.rec.goal}  ${chalk.dim(`${secs}s`)}`;
		} else {
			const r = item.rec;
			const sym = SYM[r.status] ?? "•";
			const color = r.status === "failed" ? chalk.red : chalk.green;
			text = `${color(sym)} ${r.goal}`;
		}
		const body = sel ? chalk.inverse(padVis(text.replace(ANSI, ""), w - 2)) : truncVis(text, w - 2);
		lines.push(`${sel ? chalk.cyan("▌") : " "} ${body}`);
		if (sel) {
			const hint =
				item.kind === "review"
					? item.rec.status === "failed"
						? "⏎ report · r retry · d dismiss"
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
		const W = out.columns ?? 100;
		const H = out.rows ?? 30;
		const sep = chalk.dim(" │ ");
		const Lw = Math.max(24, Math.floor((W - 3) * 0.56));
		const Rw = Math.max(20, W - 3 - Lw);
		const bodyH = Math.max(3, H - 3);

		const its = items();
		if (selected >= its.length) selected = Math.max(0, its.length - 1);

		const left = chatPane(transcript, Lw, bodyH);
		const rightRaw = boardPane(its, selected, mode === "board", Rw, Date.now());

		const needs = its.filter((i) => i.kind === "review").length;
		const run = its.filter((i) => i.kind === "running").length;
		const header =
			padVis(`  ${chalk.bold("☀ mission control")}  ${chalk.dim(`${basename(targetCwd)} · ${run} running · ${needs} need you`)}`, W - 13) +
			chalk.dim(mode === "chat" ? "[Tab] board " : "[Tab] chat  ");

		const rows: string[] = [header];
		for (let y = 0; y < bodyH; y++) {
			rows.push(`${padVis(left[y] ?? "", Lw)}${sep}${padVis(rightRaw[y] ?? "", Rw)}`);
		}

		const spinner = awaiting || thinking ? `${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[spin % 10]} ` : "";
		const status =
			awaiting || thinking
				? chalk.cyan(`  ${spinner}${thinking ? "chief drafting ideas…" : "chief is thinking…"}`)
				: toast
					? `  ${toast}`
					: chalk.dim(
							mode === "chat"
								? "  type to the chief · Enter sends · Tab → board · Ctrl-C detaches (org keeps running)"
								: "  ↑↓ move · ⏎ act · a merge · r retry · d dismiss · g ask chief for ideas · Tab → chat · q quit",
						);
		rows.push(padVis(status, W));

		const input = mode === "chat" ? `${chalk.bold(" › ")}${buffer}` : chalk.dim(" [board focus — Tab to type to the chief]");
		rows.push(padVis(input, W));

		out.write("\x1b[H");
		out.write(rows.map((l) => l + "\x1b[K").join("\r\n"));
		out.write("\x1b[J");

		if (mode === "chat") out.write(`\x1b[${H};${4 + buffer.length}H\x1b[?25h`);
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
