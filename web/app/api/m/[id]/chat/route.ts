/**
 * Questions about one mission, answered by that mission's overseer.
 *
 * Before this, the mission composer sent your text to the CHIEF and told you the reply would
 * appear in #chief. So you asked a question on one page and the answer arrived on another, which
 * in practice meant you never saw it — and the chief only knows what the registry says anyway,
 * not what actually happened inside the run.
 *
 * The overseer is the right correspondent and already existed: a per-mission agent carrying the
 * mission's state, its recent log and its diff, with read-only tools on the worktree and live
 * tools onto any worker still running. It answers "why did a2 fail" by reading, not by guessing.
 *
 * A session is built per request and seeded from chat.jsonl, so a follow-up knows what "that"
 * referred to. Both sides persist to the same file the TUI reads, which makes this one
 * conversation about a mission rather than one per surface.
 *
 * The answer STREAMS. A turn takes ten to thirty seconds because the overseer is reading files
 * and sometimes questioning a live worker, and a spinner for half a minute is indistinguishable
 * from a hang — you cannot tell whether to wait or reload. Watching the reasoning arrive also
 * tells you what it is reading, which is often the useful part.
 */
import { createOverseerSession, loadChatHistory } from "@missions/overseer.js";
import { record } from "@/lib/data";
import { mayMutate, requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
// The overseer spawns an agent and reads the worktree — neither works on the edge.
export const runtime = "nodejs";
// An overseer turn reads files and may question a live worker. The default is far too short.
export const maxDuration = 300;

/** How much prior conversation the fresh session gets. Enough for follow-ups, not a transcript. */
const SEED_TURNS = 12;

async function outDirFor(id: string): Promise<{ outDir: string } | { deny: Response }> {
	const rec = record(id);
	if (!rec) return { deny: Response.json({ error: "unknown mission" }, { status: 404 }) };
	if (!rec.outDir) return { deny: Response.json({ error: "this mission has no run directory on disk" }, { status: 409 }) };
	return { outDir: rec.outDir };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	const { id } = await ctx.params;
	const found = await outDirFor(id);
	if ("deny" in found) return found.deny;
	return Response.json({ entries: loadChatHistory(found.outDir) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	// Asking costs a model call, so it is a write in the only sense this console cares about.
	if (!mayMutate(gate.op)) {
		return Response.json({ error: "writes disabled until MISSIONS_ALLOWED_USER_IDS pins this console" }, { status: 403 });
	}

	const { id } = await ctx.params;
	const found = await outDirFor(id);
	if ("deny" in found) return found.deny;

	let text: string;
	try {
		text = ((await req.json()) as { text?: string }).text?.trim() ?? "";
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}
	if (!text) return Response.json({ error: "nothing to ask" }, { status: 400 });

	const session = createOverseerSession(found.outDir, { seedHistory: SEED_TURNS });
	if (!session) {
		// Almost always a missing API key in this process — the daemon has one and the web server
		// is started separately, so say which failure it is instead of a generic 500.
		return Response.json(
			{ error: "could not start the overseer — check the model API key is set for the console process" },
			{ status: 503 },
		);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const send = (event: string, data: unknown) => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					open = false;
				}
			};

			/*
			 * The overseer's stream is written for a terminal: colour codes, and a bold "overseer"
			 * label the client renders itself.
			 *
			 * Cleaning each chunk in isolation would be wrong — an escape sequence can be split
			 * across two chunks, and the label arrives as its own chunk before any prose. So the
			 * raw text is accumulated, the WHOLE accumulation is cleaned, and only the growth is
			 * sent. That is correct however the chunks happen to fall.
			 */
			let raw = "";
			let sent = 0;
			const unsub = session.subscribe((chunk) => {
				raw += chunk;
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
				const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\s*overseer\s*/, "");
				if (clean.length > sent) {
					send("out", clean.slice(sent));
					sent = clean.length;
				}
			});

			try {
				const answer = await session.ask(text);
				send(answer ? "done" : "error", answer ? { answer, at: new Date().toISOString() } : { error: "the overseer returned nothing" });
			} catch (err) {
				send("error", { error: err instanceof Error ? err.message : String(err) });
			} finally {
				unsub();
				session.close();
				open = false;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			// Proxies and tunnels buffer by default, which turns a live stream into one batch at
			// the end — the exact thing this change exists to avoid.
			"x-accel-buffering": "no",
		},
	});
}
