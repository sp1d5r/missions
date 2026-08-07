"use client";

import { useEffect, useState } from "react";

/**
 * The org's pulse, visible from every page — not just the chief thread.
 *
 * Polls `/api/health`, which actually dials the daemon socket (see
 * `lib/daemon.ts`), so this can't repeat the mistake that let a dead daemon
 * go unnoticed for hours: a stale socket file on disk reading as "up".
 */
const POLL_MS = 5000;

export function Heartbeat() {
	const [up, setUp] = useState<boolean | null>(null);

	useEffect(() => {
		let cancelled = false;
		const check = async () => {
			try {
				const res = await fetch("/api/health", { cache: "no-store" });
				const body = (await res.json()) as { up: boolean };
				if (!cancelled) setUp(body.up);
			} catch {
				if (!cancelled) setUp(false);
			}
		};
		check();
		const id = setInterval(check, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	const label = up === null ? "checking daemon…" : up ? "daemon up" : "daemon down";
	return (
		<div className="heartbeat" title={label} aria-label={label}>
			<span className={`heartbeat-dot ${up === null ? "hb-unknown" : up ? "hb-up" : "hb-down"}`} />
			<span className="heartbeat-label">{up === null ? "…" : up ? "up" : "down"}</span>
		</div>
	);
}
