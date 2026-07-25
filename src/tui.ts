import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import { cmuxOpenBrowser, cmuxOpenWorkspace, hasCmuxPassword, insideCmux } from "./cmux.js";
import { mergeBranch, removeWorktree } from "./git.js";
import { type ActiveRecord, readActive, updateActive } from "./registry.js";
import { generateSuggestions, loadSuggestions, type Suggestion } from "./suggest.js";

const RUNNING = new Set(["planning", "working", "validating", "reporting"]);

export type Item =
	| { kind: "review"; rec: ActiveRecord }
	| { kind: "running"; rec: ActiveRecord }
	| { kind: "suggest"; sug: Suggestion };

export const RUNNING_STATUSES = RUNNING;

function statusColor(status: string): (s: string) => string {
	if (status === "succeeded") return chalk.green;
	if (status === "failed") return chalk.red;
	if (status === "merged") return chalk.magenta;
	if (RUNNING.has(status)) return chalk.cyan;
	return chalk.dim;
}

function pad(s: string, w: number): string {
	const t = s.length > w ? `${s.slice(0, w - 1)}…` : s;
	return t.padEnd(w);
}

function age(iso: string, now: number): string {
	const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
	return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

/** Build the flat, ordered work queue: things needing you, then running, then suggested. */
export function buildItems(records: ActiveRecord[], suggestions: Suggestion[]): Item[] {
	const needsYou = records.filter((r) => r.done && !r.cleared);
	const running = records.filter((r) => !r.done && RUNNING.has(r.status));
	return [
		...needsYou.map((rec): Item => ({ kind: "review", rec })),
		...running.map((rec): Item => ({ kind: "running", rec })),
		...suggestions.map((sug): Item => ({ kind: "suggest", sug })),
	];
}

function actionsFor(item: Item): string {
	if (item.kind === "review") {
		return item.rec.status === "failed"
			? "⏎ report · r retry · d dismiss"
			: "⏎ report · a accept+merge · w worktree · d dismiss";
	}
	if (item.kind === "running") return "⏎ worktree · o report";
	return `⏎ dispatch · e edit${item.sug.rationale ? chalk.dim(` — ${item.sug.rationale}`) : ""}`;
}

interface RenderState {
	items: Item[];
	selected: number;
	width: number;
	now: number;
	toast: string;
	input: { active: boolean; label: string; buffer: string } | null;
}

/** Pure render — testable without a TTY. */
export function renderFrame(s: RenderState): string {
	const { items, selected, now } = s;
	const W = Math.max(80, s.width);
	const cStatus = 11;
	const cRepo = 15;
	const cAge = 6;
	const cGoal = Math.max(20, W - (cStatus + cRepo + cAge + 8));

	const needs = items.filter((i) => i.kind === "review").length;
	const run = items.filter((i) => i.kind === "running").length;
	const sug = items.filter((i) => i.kind === "suggest").length;

	const lines: string[] = [];
	lines.push(
		chalk.bold("  ☀  mission control") +
			chalk.dim(`   ${needs} need you · ${run} running · ${sug} suggested`),
	);
	lines.push(chalk.dim("  ↑↓ move · ⏎ act · a merge · r retry · d dismiss · n new · g ideas · q quit"));
	lines.push("");

	if (!items.length) {
		lines.push(chalk.dim("  Empty. Press n to dispatch a mission, or g to scan repos for work."));
		lines.push("");
	}

	let lastKind: string | null = null;
	items.forEach((item, i) => {
		if (item.kind !== lastKind) {
			lastKind = item.kind;
			const title = item.kind === "review" ? "NEEDS YOU" : item.kind === "running" ? "RUNNING" : "SUGGESTED";
			lines.push(chalk.bold.dim(`  ${title}`));
		}
		const sel = i === selected;
		const marker = sel ? chalk.cyan("▶ ") : "  ";

		if (item.kind === "suggest") {
			const g = pad(item.sug.goal, cGoal + cAge + 2);
			const cells = `${pad("idea", cStatus)}  ${pad(item.sug.repoName, cRepo)}  ${g}`;
			lines.push(marker + (sel ? chalk.inverse(cells) : chalk.dim(cells)));
		} else {
			const r = item.rec;
			const doing = item.kind === "running" ? (r.lastActivity || "").replace(/\s+/g, " ").trim() : r.goal;
			const goalCell = item.kind === "running" ? `${pad(r.goal, Math.floor(cGoal / 2))} ${chalk.dim(pad(doing, cGoal - Math.floor(cGoal / 2) - 1))}` : pad(doing, cGoal);
			const status = pad(r.status, cStatus);
			const cells = `${status}  ${pad(r.repoName, cRepo)}  ${goalCell}  ${pad(age(r.updatedAt, now), cAge)}`;
			lines.push(marker + (sel ? chalk.inverse(cells) : statusColor(r.status)(cells.slice(0, cStatus)) + cells.slice(cStatus)));
		}

		if (sel) lines.push(chalk.dim(`      ${actionsFor(item)}`));
	});

	lines.push("");
	if (s.input?.active) {
		lines.push(chalk.yellow(`  ${s.input.label} `) + s.input.buffer + chalk.inverse(" "));
	} else if (s.toast) {
		lines.push(`  ${s.toast}`);
	}
	return lines.join("\r\n");
}

/** Spawn a background mission via the CLI — it publishes to the registry and shows up under RUNNING. */
function dispatch(repo: string, goal: string): void {
	const child = spawn(process.execPath, [process.argv[1] as string, "run", "--target", repo, "--goal", goal], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

/** Interactive terminal command center. Runs in any TTY, incl. over SSH. Resolves when the user quits. */
export function runBoardTui(): Promise<void> {
	return new Promise((resolvePromise) => {
		const out = process.stdout;
		let suggestions: Suggestion[] = loadSuggestions();
		let thinking = false;

		if (!process.stdin.isTTY) {
			const items = buildItems(readActive(), suggestions);
			out.write(`${renderFrame({ items, selected: -1, width: out.columns ?? 100, now: Date.now(), toast: "", input: null })}\n`);
			resolvePromise();
			return;
		}

		let selected = 0;
		let toast = "";
		let input: { active: boolean; label: string; buffer: string; onSubmit: (v: string) => void } | null = null;

		const currentItems = (): Item[] => buildItems(readActive(), suggestions);

		// Ask the chief (orchestrator model) for grounded missions on the focus repo. Async — draws when it lands.
		const askChief = (): void => {
			if (thinking) return;
			const repo = repoForNew(currentItems());
			if (!repo) {
				toast = chalk.yellow("no repo known yet — run one mission first");
				return;
			}
			thinking = true;
			toast = chalk.cyan(`chief is thinking about ${repo.split("/").pop()}…`);
			generateSuggestions(repo)
				.then((items) => {
					suggestions = [...suggestions.filter((s) => s.repo !== repo), ...items];
					toast = chalk.dim(`chief proposed ${items.length} mission(s) for ${repo.split("/").pop()}`);
				})
				.catch((e: unknown) => {
					toast = chalk.red(`ideas failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
				})
				.finally(() => {
					thinking = false;
					draw();
				});
		};

		const draw = (): void => {
			const items = currentItems();
			if (selected >= items.length) selected = Math.max(0, items.length - 1);
			out.write("\x1b[2J\x1b[3J\x1b[H");
			out.write(renderFrame({ items, selected, width: out.columns ?? 100, now: Date.now(), toast, input }));
		};

		const cleanup = (): void => {
			clearInterval(timer);
			process.stdin.removeListener("keypress", onKey);
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
			out.write("\x1b[?25h\x1b[?1049l");
			resolvePromise();
		};

		const repoForNew = (items: Item[]): string | undefined => {
			const cur = items[selected];
			if (cur?.kind === "review" || cur?.kind === "running") return cur.rec.repo;
			if (cur?.kind === "suggest") return cur.sug.repo;
			const active = readActive();
			return active[0]?.repo;
		};

		const act = (item: Item): void => {
			if (item.kind === "review") {
				const r = item.rec;
				if (r.reportPath) {
					if (insideCmux() && hasCmuxPassword()) cmuxOpenBrowser(r.reportPath);
					else toast = chalk.dim(`report: ${r.reportPath}`);
				} else toast = chalk.dim("no report yet");
			} else if (item.kind === "running") {
				if (item.rec.worktreePath) {
					if (insideCmux()) cmuxOpenWorkspace(item.rec.worktreePath);
					else toast = chalk.dim(`worktree: ${item.rec.worktreePath}`);
				}
			} else {
				dispatch(item.sug.repo, item.sug.goal);
				toast = chalk.green(`▶ dispatched: ${item.sug.goal.slice(0, 60)}`);
			}
		};

		const acceptMerge = (r: ActiveRecord): void => {
			if (r.status !== "succeeded") {
				toast = chalk.yellow("only succeeded missions can be merged");
				return;
			}
			if (!r.worktreePath) {
				toast = chalk.yellow("no worktree to merge");
				return;
			}
			const res = mergeBranch(r.repo, `missions/${r.id}`);
			if (res.ok) {
				removeWorktree(r.repo, r.worktreePath);
				updateActive(r.id, { cleared: true, status: "merged" });
				toast = chalk.green(`✓ merged missions/${r.id.slice(0, 8)} into ${r.repoName}`);
			} else {
				toast = chalk.red(`merge failed: ${res.out.split("\n")[0]?.slice(0, 70)}`);
			}
		};

		const onKey = (str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
			if (!key) return;

			// Inline input mode (new / edit mission goal).
			if (input?.active) {
				if (key.name === "escape") {
					input = null;
					toast = chalk.dim("cancelled");
				} else if (key.name === "return") {
					const v = input.buffer.trim();
					const submit = input.onSubmit;
					input = null;
					if (v) submit(v);
				} else if (key.name === "backspace") {
					input.buffer = input.buffer.slice(0, -1);
				} else if (str && !key.ctrl && str.length === 1 && str >= " ") {
					input.buffer += str;
				}
				draw();
				return;
			}

			const items = currentItems();
			if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) return cleanup();

			if (key.name === "up") selected = Math.max(0, selected - 1);
			else if (key.name === "down") selected = Math.min(items.length - 1, selected + 1);
			else if (key.name === "g") askChief();
			else if (key.name === "n") {
				const repo = repoForNew(items);
				if (!repo) toast = chalk.yellow("no repo known yet — run one mission first");
				else
					input = {
						active: true,
						label: `new mission in ${repo.split("/").pop()} ›`,
						buffer: "",
						onSubmit: (v) => {
							dispatch(repo, v);
							toast = chalk.green(`▶ dispatched: ${v.slice(0, 60)}`);
						},
					};
			} else if (key.name === "return") {
				const item = items[selected];
				if (item) act(item);
			} else if (key.name === "o") {
				const item = items[selected];
				const rec = item && item.kind !== "suggest" ? item.rec : undefined;
				if (rec?.reportPath) {
					if (insideCmux() && hasCmuxPassword()) cmuxOpenBrowser(rec.reportPath);
					else toast = chalk.dim(`report: ${rec.reportPath}`);
				}
			} else if (key.name === "w") {
				const item = items[selected];
				const rec = item && item.kind !== "suggest" ? item.rec : undefined;
				if (rec?.worktreePath) {
					if (insideCmux()) cmuxOpenWorkspace(rec.worktreePath);
					else toast = chalk.dim(`worktree: ${rec.worktreePath}`);
				}
			} else if (key.name === "a") {
				const item = items[selected];
				if (item?.kind === "review") acceptMerge(item.rec);
			} else if (key.name === "r") {
				const item = items[selected];
				if (item?.kind === "review") {
					dispatch(item.rec.repo, item.rec.goal);
					updateActive(item.rec.id, { cleared: true });
					toast = chalk.green(`▶ re-dispatched: ${item.rec.goal.slice(0, 55)}`);
				}
			} else if (key.name === "e") {
				const item = items[selected];
				if (item?.kind === "suggest") {
					const sug = item.sug;
					input = {
						active: true,
						label: `edit & dispatch ›`,
						buffer: sug.goal,
						onSubmit: (v) => {
							dispatch(sug.repo, v);
							toast = chalk.green(`▶ dispatched: ${v.slice(0, 55)}`);
						},
					};
				}
			} else if (key.name === "d") {
				const item = items[selected];
				if (item?.kind === "review") {
					updateActive(item.rec.id, { cleared: true });
					toast = chalk.dim("dismissed");
				}
			}
			draw();
		};

		out.write("\x1b[?1049h\x1b[?25l");
		emitKeypressEvents(process.stdin);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("keypress", onKey);
		if (!suggestions.length) toast = chalk.dim("press g for chief-generated mission ideas");
		const timer = setInterval(draw, 1500);
		draw();
	});
}
