/**
 * Server-sent events carrying the chief's conversation.
 *
 * Two rules:
 *
 * HISTORY FIRST. The daemon broadcasts only what happens while you are
 * attached, so a reload used to show an empty pane. The recorded tail is
 * replayed before the live stream starts.
 *
 * THE STREAM NEVER HARD-FAILS. Returning 503 when the daemon was down meant
 * EventSource saw a non-2xx, treated it as fatal, and refused to reconnect —
 * so starting the daemon did nothing until you manually reloaded. Now the
 * response always opens, says `down`, and keeps looking.
 *
 * Attaching stays read-only (see lib/daemon.ts): it sends no frames at all, so
 * a phone can never disturb the focus of a terminal.
 */
import { readChiefTail } from "@missions/chieflog.js";
import { attach, daemonUp } from "@/lib/daemon";
import { requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
// node:net is not available on the edge, and the daemon speaks over a Unix socket.
export const runtime = "nodejs";

const RETRY_MS = 3000;

/**
 * How long one connection lives before it is closed so the client reconnects.
 *
 * Measured through a Cloudflare quick tunnel: a response is buffered in full and delivered only
 * when it ENDS — eight chunks emitted two seconds apart all arrived together at +16.1s, and no
 * padding, compression or HTTP-version change moved it. A stream that never ends therefore
 * delivers nothing at all, so this pane was permanently blank on a phone while working perfectly
 * on localhost.
 *
 * Ending the response on a timer turns "never" into "every segment": each close flushes whatever
 * the proxy was holding, and EventSource reconnects on its own. Locally it costs one reconnect
 * and a history replay every 25s, which is invisible because the replay is the same content.
 */
const SEGMENT_MS = 25_000;

export async function GET(req: Request) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;

	const encoder = new TextEncoder();
	const abort = new AbortController();
	req.signal.addEventListener("abort", () => abort.abort(), { once: true });

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

			send("history", readChiefTail(200));

			// A tunnel or a phone radio drops an idle connection long before the
			// chief says anything, so keep the pipe warm.
			const keepalive = setInterval(() => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					open = false;
				}
			}, 15000);

			let announcedDown = false;
			// The daemon greets on every connect. That is welcome the first time
			// and noise on every reconnect, where it lands mid-conversation.
			let firstAttach = true;
			try {
				while (!abort.signal.aborted && open) {
					if (!daemonUp()) {
						if (!announcedDown) {
							send("down", { at: new Date().toISOString() });
							announcedDown = true;
						}
						await new Promise((r) => setTimeout(r, RETRY_MS));
						continue;
					}
					announcedDown = false;
					const wasFirst = firstAttach;
					firstAttach = false;
					send("open", { at: new Date().toISOString(), first: wasFirst });
					try {
						// The daemon's first frame after any attach is its greeting.
						// It gets its own event so the client can never merge it into
						// whatever message happened to be open, and it is dropped
						// entirely on a reconnect, where it is just noise mid-thread.
						let greeting = true;
						for await (const line of attach(abort.signal)) {
							if (greeting) {
								greeting = false;
								if (wasFirst) send("greet", line);
								continue;
							}
							send("out", line);
						}
					} catch {
						/* socket died — the loop re-checks and waits for it to come back */
					}
					if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, RETRY_MS));
				}
			} finally {
				clearInterval(keepalive);
				open = false;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		},
		cancel() {
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Proxies and tunnels buffer by default, which turns a live stream into
			// a batch delivered at the end. This asks them not to.
			"x-accel-buffering": "no",
		},
	});
}
