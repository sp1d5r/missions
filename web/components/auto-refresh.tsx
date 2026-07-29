"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-fetch the server components on an interval.
 *
 * Pauses while the tab is hidden. This runs on a phone that may sit in a pocket
 * for an hour, and a board that keeps polling in the background is just a way
 * to flatten a battery for facts nobody is reading.
 */
export function AutoRefresh({ seconds }: { seconds: number }) {
	const router = useRouter();

	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null;

		const start = () => {
			if (timer) return;
			timer = setInterval(() => router.refresh(), seconds * 1000);
		};
		const stop = () => {
			if (!timer) return;
			clearInterval(timer);
			timer = null;
		};
		const onVisibility = () => {
			if (document.hidden) {
				stop();
			} else {
				router.refresh(); // catch up on whatever happened while away
				start();
			}
		};

		if (!document.hidden) start();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [router, seconds]);

	return null;
}
