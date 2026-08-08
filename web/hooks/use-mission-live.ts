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

/** Local ticker interval — 1 s so quietForSeconds advances between polls. */
const TICK_MS = 1_000;

function deriveStatus(
  payload: MissionLivePayload,
  now?: number,
): {
  activityStatus: ActivityStatus;
  quietForSeconds: number;
} {
  if (payload.done) {
    return { activityStatus: "done", quietForSeconds: 0 };
  }

  const updatedMs = Date.parse(payload.updatedAt);
  const ageMs = Number.isNaN(updatedMs)
    ? Infinity
    : (now ?? Date.now()) - updatedMs;

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
 *
 * Additional features vs the original implementation:
 * - A 1 s local ticker advances quietForSeconds between polls so stalled
 *   missions show time advancing even when the server returns the same updatedAt.
 * - When `id` changes the internal done flag is reset so a new in-progress
 *   mission is polled even if the previous mission was done.
 * - The visibilitychange listener is registered before any early-return on
 *   initialDone so a stale SSR "done" can recover on tab focus.
 * - An inFlightRef guards against stacking duplicate fetches on rapid
 *   visibility toggles.
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

  // Keep a ref to the current payload so we can derive status in the ticker
  // interval without capturing a stale closure.
  const payloadRef = useRef<MissionLivePayload | null>(null);
  // doneRef tracks the current mission's done state (reset on id change).
  const doneRef = useRef(initialDone);
  // Guard against stacking simultaneous in-flight fetches.
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Reset done state for the new id so a previously-done mission doesn't
    // suppress polling for a newly-selected in-progress mission.
    doneRef.current = initialDone;
    payloadRef.current = null;

    // If already done according to the current initialDone, show done state
    // immediately but still register the visibility listener so the hook can
    // recover if this was a stale SSR value.
    if (initialDone) {
      setState({
        activityStatus: "done",
        quietForSeconds: 0,
        recentLog: [],
        payload: null,
      });
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let tickTimer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      if (cancelled || document.hidden || doneRef.current) return;
      if (inFlightRef.current) return; // don't stack fetches
      inFlightRef.current = true;
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
        if (payload.done) {
          stopPoll();
          stopTick();
        }
      } catch {
        // Network errors are silent — the last known state stays.
      } finally {
        inFlightRef.current = false;
      }
    }

    /**
     * Tick once per second to advance quietForSeconds between polls.
     * This means the stalled counter updates on screen every second even
     * when the server keeps returning the same updatedAt.
     */
    function tick() {
      if (cancelled || doneRef.current) return;
      const payload = payloadRef.current;
      if (!payload) return;
      const { activityStatus, quietForSeconds } = deriveStatus(payload);
      setState((prev) => ({
        ...prev,
        activityStatus,
        quietForSeconds,
      }));
    }

    function startPoll() {
      if (pollTimer || doneRef.current) return;
      poll(); // immediate first fetch
      pollTimer = setInterval(poll, POLL_MS);
    }

    function stopPoll() {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    function startTick() {
      if (tickTimer || doneRef.current) return;
      tickTimer = setInterval(tick, TICK_MS);
    }

    function stopTick() {
      if (!tickTimer) return;
      clearInterval(tickTimer);
      tickTimer = null;
    }

    function start() {
      startPoll();
      startTick();
    }

    function stop() {
      stopPoll();
      stopTick();
    }

    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        // On tab-show: if doneRef is still true from a stale SSR pass,
        // we respect it (server confirmed done). If it was reset by an id
        // change, start() will begin polling normally.
        start();
      }
    }

    // Register visibility listener BEFORE any early-return so a stale SSR
    // "done" can recover when the user focuses the tab.
    document.addEventListener("visibilitychange", onVisibility);

    // Only start polling/ticking if not already done and tab is visible.
    if (!doneRef.current && !document.hidden) {
      start();
    }

    return () => {
      cancelled = true;
      inFlightRef.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, initialDone]); // Re-run when id OR initialDone changes

  return state;
}
