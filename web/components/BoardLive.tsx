"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Drives router.refresh() whenever a mission lifecycle event arrives over the
 * board SSE stream (/api/board/stream).
 *
 * Design choices:
 *
 * DEBOUNCED REFRESH — multiple mission events that arrive in a burst (e.g.
 * a mission transitioning through several states in quick succession) collapse
 * into a single router.refresh() call, capped at one per 400ms.
 *
 * EXPONENTIAL BACKOFF RECONNECT — when EventSource loses its connection it
 * waits 1, 2, 4, then 10 seconds before each retry attempt. This prevents
 * hammering the server while still recovering quickly from transient drops.
 *
 * FALLBACK — <AutoRefresh> remains mounted alongside this component, so the
 * board still updates on a fixed cadence even if SSE is unavailable.
 *
 * Returns null: purely behavioural, no rendered output.
 */
export function BoardLive() {
	const router = useRouter();
	// Use a ref for the debounce timer to avoid stale closures.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Track the EventSource and retry state across renders.
	const esRef = useRef<EventSource | null>(null);
	const retryRef = useRef(0);
	const BACKOFF = [1000, 2000, 4000, 10000] as const;

	useEffect(() => {
		let cancelled = false;

		const scheduleRefresh = () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				router.refresh();
			}, 400);
		};

		const connect = () => {
			if (cancelled) return;
			const es = new EventSource("/api/board/stream");
			esRef.current = es;

			es.addEventListener("hello", () => {
				// Board snapshot on first connect — trigger a refresh to sync server components.
				retryRef.current = 0;
				scheduleRefresh();
			});

			es.addEventListener("mission", () => {
				scheduleRefresh();
			});

			es.addEventListener("down", () => {
				// Daemon is not reachable; nothing to do — server will retry.
			});

			es.onerror = () => {
				es.close();
				esRef.current = null;
				if (cancelled) return;
				const delay = BACKOFF[Math.min(retryRef.current, BACKOFF.length - 1)];
				retryRef.current++;
				setTimeout(connect, delay);
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			if (esRef.current) {
				esRef.current.close();
				esRef.current = null;
			}
		};
	}, [router]);

	return null;
}
