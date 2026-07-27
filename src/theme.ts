/**
 * Ops-console theme for the HTML surfaces (report + board).
 *
 * Register: an intelligence-desk console. Near-black ground, monospace
 * everything, hairline rules, corner brackets, uppercase micro-labels,
 * big numbers with tiny captions.
 *
 * Three rules keep it a working instrument rather than a costume:
 *
 * 1. COLOUR IS SEMANTIC, NEVER DECORATIVE. The reference art uses red as an
 *    accent. Here red means something broke, amber means something wants a
 *    decision, and everything healthy stays bone-monochrome. A screen with no
 *    colour on it is good news you can read at a glance — which only works if
 *    colour is never spent on chrome.
 *
 * 2. CONTRAST IS LIFTED off the reference. #1c1c1c hairlines on #0a0a0a look
 *    superb in a screenshot on an OLED phone and are invisible on a laptop in
 *    daylight. Hairlines and body text here are raised to stay legible in a
 *    bright room, which costs a little of the moodiness and buys the surface
 *    actually getting used.
 *
 * 3. NO DECORATIVE DATA. No wireframe globes, no sparklines that plot nothing.
 *    Every mark on the page is a fact about the mission. The moment a panel
 *    contains invented texture, you stop trusting the panels that don't.
 */

export const THEME = {
	bg: "#0b0c0d",
	panel: "#101214",
	panelRaised: "#15181a",
	hairline: "#282c30",
	hairlineBright: "#3a4046",
	text: "#d7dbde",
	textDim: "#868d94",
	textFaint: "#5b6168",
	/** Healthy. Deliberately not green — quiet bone means "nothing to see". */
	ok: "#d7dbde",
	/** Wants a decision from you. */
	warn: "#d08b28",
	/** Broke. */
	bad: "#e5484d",
	/** Landed / archived. */
	done: "#7d6cc4",
	/** In flight. */
	live: "#5aa9d6",
} as const;

export const THEME_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 26px 22px 40px;
    background: ${THEME.bg};
    color: ${THEME.text};
    font: 13px/1.6 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1100px; margin: 0 auto; position: relative; }

  /* Corner brackets: the console frame. Drawn, not imagery. */
  .framed { position: relative; padding: 18px; }
  .framed::before, .framed::after {
    content: ""; position: absolute; width: 14px; height: 14px; pointer-events: none;
  }
  .framed::before { top: 0; left: 0; border-top: 1px solid ${THEME.hairlineBright}; border-left: 1px solid ${THEME.hairlineBright}; }
  .framed::after { bottom: 0; right: 0; border-bottom: 1px solid ${THEME.hairlineBright}; border-right: 1px solid ${THEME.hairlineBright}; }

  h1 { font-size: 15px; font-weight: 500; letter-spacing: .02em; margin: 0 0 3px; }
  h2 {
    font-size: 10px; text-transform: uppercase; letter-spacing: .16em;
    color: ${THEME.textDim}; font-weight: 400;
    margin: 30px 0 10px; padding-bottom: 6px;
    border-bottom: 1px solid ${THEME.hairline};
  }
  h3 { font-size: 12px; font-weight: 500; margin: 20px 0 6px; letter-spacing: .02em; }
  a { color: ${THEME.live}; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: .14em; color: ${THEME.textDim}; }
  .dim { color: ${THEME.textDim}; }
  .faint { color: ${THEME.textFaint}; }
  .mono { font-variant-numeric: tabular-nums; }

  /* Stat strip: big number, tiny caption underneath. */
  .stats { display: flex; flex-wrap: wrap; border: 1px solid ${THEME.hairline}; margin: 16px 0 4px; }
  .stat { flex: 1 1 110px; padding: 12px 14px; border-right: 1px solid ${THEME.hairline}; }
  .stat:last-child { border-right: 0; }
  .stat b { display: block; font-size: 24px; font-weight: 400; letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .stat span { font-size: 9.5px; text-transform: uppercase; letter-spacing: .13em; color: ${THEME.textDim}; }

  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th {
    text-align: left; padding: 8px 10px;
    font-size: 9.5px; text-transform: uppercase; letter-spacing: .13em; font-weight: 400;
    color: ${THEME.textDim}; border-bottom: 1px solid ${THEME.hairline};
  }
  td { text-align: left; padding: 9px 10px; border-bottom: 1px solid ${THEME.hairline}; vertical-align: top; }
  tbody tr:hover { background: ${THEME.panelRaised}; }

  .panel { border: 1px solid ${THEME.hairline}; background: ${THEME.panel}; padding: 14px 16px; margin: 10px 0; }
  blockquote {
    margin: 8px 0; padding: 10px 14px; background: ${THEME.panel};
    border-left: 2px solid ${THEME.hairlineBright}; color: ${THEME.text}; white-space: pre-wrap;
  }

  /* Status tags. Uppercase, bracketed, colour only when it means something. */
  .tag {
    display: inline-block; padding: 2px 7px; margin: 2px 4px 2px 0;
    font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
    border: 1px solid currentColor; white-space: nowrap;
  }
  .t-ok { color: ${THEME.ok}; }
  .t-warn { color: ${THEME.warn}; }
  .t-bad { color: ${THEME.bad}; }
  .t-done { color: ${THEME.done}; }
  .t-live { color: ${THEME.live}; }
  .t-quiet { color: ${THEME.textDim}; }

  .dot { display: inline-block; width: 6px; height: 6px; margin-right: 8px; vertical-align: middle; }

  /* Alert band: only rendered when there is genuinely something outstanding. */
  .alert { border: 1px solid ${THEME.warn}; padding: 12px 14px; margin: 16px 0; }
  .alert .label { color: ${THEME.warn}; }
  .alert ul { margin: 6px 0 0; padding-left: 18px; }
  .alert li { margin: 2px 0; }

  /* Command log: exit codes are the point, so they get the colour. */
  ul.log { list-style: none; margin: 6px 0 0; padding: 0; font-size: 11.5px; }
  ul.log li { padding: 2px 0; }
  .exit-ok { color: ${THEME.textDim}; }
  .exit-bad { color: ${THEME.bad}; }

  /* Diagrams are inline SVG laid out to a fixed canvas: full width up to that canvas,
     scaling down below it rather than squashing or overflowing. */
  .diagram { border: 1px solid ${THEME.hairline}; background: ${THEME.panel}; padding: 14px; }
  .diagram svg { display: block; margin: 0 auto; }
  pre.src {
    background: ${THEME.panel}; border: 1px solid ${THEME.hairline};
    padding: 12px 14px; margin: 8px 0 0; overflow-x: auto;
    font-size: 11px; color: ${THEME.textDim}; white-space: pre;
  }
  summary::marker { color: ${THEME.textDim}; }
  .scroll { overflow-x: auto; }
`;

export function esc(s: unknown): string {
	return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export type Tone = "ok" | "warn" | "bad" | "done" | "live" | "quiet";

export const TONE_HEX: Record<Tone, string> = {
	ok: THEME.ok,
	warn: THEME.warn,
	bad: THEME.bad,
	done: THEME.done,
	live: THEME.live,
	quiet: THEME.textDim,
};

export function tag(tone: Tone, text: string): string {
	return `<span class="tag t-${tone}">${esc(text)}</span>`;
}

export function statStrip(cells: { value: string; label: string; tone?: Tone }[]): string {
	return `<div class="stats">${cells
		.map((c) => `<div class="stat"><b${c.tone ? ` style="color:${TONE_HEX[c.tone]}"` : ""}>${esc(c.value)}</b><span>${esc(c.label)}</span></div>`)
		.join("")}</div>`;
}

export function page(args: { title: string; head?: string; body: string }): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(args.title)}</title>
${args.head ?? ""}
<style>${THEME_CSS}</style></head>
<body><div class="wrap framed">
${args.body}
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Mission codenames.
//
// A mission id is `m-2026-07-26T18-08-48-356Z`: unreadable, and impossible to
// say out loud to the chief. A codename is derived from the id so it is stable
// and needs no storage, and gives every mission a handle you can actually use
// in a sentence: "kill IRONWING".
// ---------------------------------------------------------------------------

const ADJECTIVES = [
	"IRON", "GLASS", "SILENT", "AMBER", "HOLLOW", "NORTH", "PALE", "SHARP",
	"QUIET", "BRASS", "COLD", "LONG", "FIRST", "BLIND", "SALT", "DUSK",
];

const NOUNS = [
	"WING", "HARBOUR", "LANTERN", "FERRY", "MERIDIAN", "COMPASS", "ANVIL", "TIDE",
	"BEACON", "ORCHARD", "SIGNAL", "THRESHOLD", "PLUMB", "KESTREL", "MARGIN", "LEDGER",
];

/** Deterministic, pronounceable handle for a mission id. Same id → same name, always. */
export function codename(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	h = Math.abs(h);
	return `${ADJECTIVES[h % ADJECTIVES.length]}${NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]}`;
}
