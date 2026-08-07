"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The three glanceable states the activity indicator can be in.
 *
 * - live    — mission is working/validating; updatedAt is recent (< LIVE_THRESHOLD_MS)
 * - stalled — mission is in-progress but has gone quiet (> STALLED_THRESHOLD_MS since update)
 * - done    — mission is finished (done === true)
 *
 * CSS and data-attributes reference these strings verbatim:
 *   data-activity="live|stalled|done"
 */
export type ActivityStatus = "live" | "stalled" | "done";

export interface MissionLivePayload {
  id: string;
  status: string;
  done: boolean;
  updatedAt: string;
  lastActivity: string;
  live: boolean;
  stalled: boolean;
  verdict?: string;
  outcome?: string;
  recentLog: string[];
}

export interface MissionLiveState {
  /** Current glanceable activity status derived client-side. */
  activityStatus: ActivityStatus;
  /** Seconds since the last update (used for the "quiet for Ns" stalled label). */
  quietForSeconds: number;
  /** Last LOG_TAIL log lines, newest-first. */
  recentLog: string[];
  /** Raw polled payload. null before first fetch. */
  payload: MissionLivePayload | null;
}

/** updatedAt is < 15 s old → we treat the mission as actively live. */
const LIVE_THRESHOLD_MS = 15_000;

/** Polling interval — 3 s is a comfortable balance between freshness and noise. */
const POLL_MS = 3_000;

function deriveStatus(payload: MissionLivePayload): {
  activityStatus: ActivityStatus;
  quietForSeconds: number;
} {
  if (payload.done) {
    return { activityStatus: "done", quietForSeconds: 0 };
  }

  const updatedMs = Date.parse(payload.updatedAt);
  const ageMs = Number.isNaN(updatedMs) ? Infinity : Date.now() - updatedMs;

  if (ageMs < LIVE_THRESHOLD_MS) {
    return { activityStatus: "live", quietForSeconds: 0 };
  }

  // Not done, not recently updated → stalled (process gone quiet)
  return {
    activityStatus: "stalled",
    quietForSeconds: Math.floor(ageMs / 1000),
  };
}

/**
 * useMissionLive — polls /api/m/[id]/state every POLL_MS while the tab is
 * visible and the mission is not done. Stops immediately on unmount.
 *
 * Pause rules:
 * - document.hidden → no requests
 * - mission.done    → no more requests needed (terminal state)
 */
export function useMissionLive(
  id: string,
  /** Initial `done` value from the server render — skip polling from the start if already done. */
  initialDone: boolean,
): MissionLiveState {
  const [state, setState] = useState<MissionLiveState>({
    activityStatus: initialDone ? "done" : "live",
    quietForSeconds: 0,
    recentLog: [],
    payload: null,
  });

  // Keep a ref to the current payload so we can derive status in the interval
  // without capturing a stale closure.
  const payloadRef = useRef<MissionLivePayload | null>(null);
  const doneRef = useRef(initialDone);

  useEffect(() => {
    if (doneRef.current) return; // Already in terminal state — no polling needed.

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      if (cancelled || document.hidden) return;
      try {
        const res = await fetch(`/api/m/${id}/state`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as MissionLivePayload;
        if (cancelled) return;

        payloadRef.current = payload;
        doneRef.current = payload.done;

        const { activityStatus, quietForSeconds } = deriveStatus(payload);

        // Reverse the log array so newest entries are first.
        const recentLog = [...payload.recentLog].reverse();

        setState({ activityStatus, quietForSeconds, recentLog, payload });

        // Stop polling once the mission reaches a terminal state.
        if (payload.done && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        // Network errors are silent — the last known state stays.
      }
    }

    function start() {
      if (timer || doneRef.current) return;
      poll(); // immediate first fetch
      timer = setInterval(poll, POLL_MS);
    }

    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    }

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id]); // id is stable; intentionally not re-running on every render

  return state;
}
