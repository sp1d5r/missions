/**
 * Server-sent events for the board — mission lifecycle events.
 *
 * Clients open this stream to learn about mission state transitions in real
 * time instead of polling. Each connection receives:
 *
 *   hello  — the current board snapshot as JSON, sent immediately on connect
 *   mission — a lifecycle frame whenever a mission transitions
 *   down   — when the daemon is not reachable
 *   keepalive comment — every 15s, so proxies and tunnels don't drop the pipe
 *
 * The response is segmented every 25s (SEGMENT_MS) by design: Cloudflare and
 * similar tunnels buffer the entire response and deliver it only when it ends.
 * Closing on a timer forces a flush; EventSource reconnects automatically.
 *
 * The stream never hard-fails: it always opens and emits `down` if the daemon
 * is absent, rather than returning 5xx which EventSource treats as fatal.
 */
import { board } from "@/lib/data";
import { daemonUp, subscribeLifecycle } from "@/lib/daemon";
import { requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
// node:net is not available on the edge; the daemon speaks over a Unix socket.
export const runtime = "nodejs";

const SEGMENT_MS = 25_000;
const KEEPALIVE_MS = 15_000;
const RETRY_MS = 3_000;

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
					controller.enqueue(
						encoder.encode(`retry: ${SEGMENT_MS}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					);
				} catch {
					open = false;
				}
			};

			// Immediately send the current board snapshot so the client has fresh
			// data even before any lifecycle event arrives.
			send("hello", board());

			// Keep the pipe alive through idle periods.
			const keepalive = setInterval(() => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					open = false;
				}
			}, KEEPALIVE_MS);

			// Segment timer: close the stream so proxies flush their buffers.
			const segment = setTimeout(() => {
				open = false;
				abort.abort();
			}, SEGMENT_MS);

			let announcedDown = false;
			try {
				while (!abort.signal.aborted && open) {
					if (!daemonUp()) {
						if (!announcedDown) {
							send("down", { at: Date.now() });
							announcedDown = true;
						}
						await new Promise((r) => setTimeout(r, RETRY_MS));
						continue;
					}
					announcedDown = false;
					try {
						for await (const frame of subscribeLifecycle(abort.signal)) {
							send("mission", frame);
						}
					} catch {
						/* socket died — loop re-checks */
					}
					if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, RETRY_MS));
				}
			} finally {
				clearInterval(keepalive);
				clearTimeout(segment);
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
			"x-accel-buffering": "no",
		},
	});
}
