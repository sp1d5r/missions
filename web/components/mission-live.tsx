"use client";

import { useMissionLive, type ActivityStatus } from "@/hooks/use-mission-live";

/* ─── ActivityIndicator ──────────────────────────────────────────────────── */

/**
 * A glanceable dot/icon that signals whether the mission is actively working,
 * has gone quiet, or has finished.
 *
 * The outer element always carries data-activity="live|stalled|done" so tests
 * and reviewers can grep for the three states without inspecting CSS classes.
 */
function ActivityIndicator({
  status,
  quietForSeconds,
}: {
  status: ActivityStatus;
  quietForSeconds: number;
}) {
  if (status === "live") {
    return (
      <span
        className="activity-indicator activity-live"
        data-activity="live"
        aria-label="Mission active"
        title="Active — polling for updates"
      >
        <span className="activity-dot activity-dot-live" />
        <span className="activity-label">live</span>
      </span>
    );
  }

  if (status === "stalled") {
    const label =
      quietForSeconds >= 60
        ? `quiet for ${Math.floor(quietForSeconds / 60)}m`
        : `quiet for ${quietForSeconds}s`;
    return (
      <span
        className="activity-indicator activity-stalled"
        data-activity="stalled"
        aria-label={`Mission stalled — ${label}`}
        title={label}
      >
        <span className="activity-dot activity-dot-stalled" />
        <span className="activity-label">{label}</span>
      </span>
    );
  }

  // done
  return (
    <span
      className="activity-indicator activity-done"
      data-activity="done"
      aria-label="Mission finished"
      title="Finished"
    >
      <span className="activity-mark">✓</span>
      <span className="activity-label">done</span>
    </span>
  );
}

/* ─── RecentActivityFeed ─────────────────────────────────────────────────── */

/**
 * Shows the last ~10 log lines from the mission, newest-first. Each line is a
 * plain string from state.json's `log` array, typically prefixed with an ISO
 * timestamp: "[2026-08-07T22:42:49.613Z] …"
 *
 * We strip the bracketed timestamp into a separate gutter column so the body
 * reads cleanly, matching the `.msg` style already in globals.css.
 */
function LogLine({ line }: { line: string }) {
  // Lines look like: "[2026-08-07T22:42:49.613Z] some text"
  const match = line.match(/^\[([^\]]+)\]\s*([\s\S]*)/);
  if (match) {
    const rawTs = match[1];
    const body = match[2];
    // Show only HH:MM:SS for brevity.
    const time = rawTs.slice(11, 19);
    return (
      <div className="msg activity-log-line">
        <div className="msg-when faint">{time}</div>
        <div className="msg-body activity-log-body">{body}</div>
      </div>
    );
  }
  // Fallback: no timestamp prefix
  return (
    <div className="msg activity-log-line">
      <div className="msg-when faint" />
      <div className="msg-body activity-log-body">{line}</div>
    </div>
  );
}

function RecentActivityFeed({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return (
      <div className="activity-feed">
        <div className="label" style={{ marginBottom: 8 }}>
          recent activity
        </div>
        <div className="empty" style={{ padding: "12px 0" }}>
          no log lines yet
        </div>
      </div>
    );
  }

  return (
    <div className="activity-feed">
      <div className="label" style={{ marginBottom: 8 }}>
        recent activity
      </div>
      {lines.map((line, i) => (
        // Log lines don't have a guaranteed unique key; timestamp+index is safe enough.
        <LogLine key={i} line={line} />
      ))}
    </div>
  );
}

/* ─── MissionLive (combined entry point) ────────────────────────────────── */

/**
 * Client-side live panel. Rendered for EVERY mission kind — screenshot,
 * video-capture, planning, coding, whatever — so do not gate on `rec.status`
 * or `rec.kind` here.
 *
 * Props mirror what the server already knows at render time so the first paint
 * is correct before the first poll completes.
 */
export function MissionLive({
  id,
  initialDone,
}: {
  id: string;
  initialDone: boolean;
}) {
  const { activityStatus, quietForSeconds, recentLog } = useMissionLive(
    id,
    initialDone,
  );

  return (
    <div className="mission-live">
      <ActivityIndicator
        status={activityStatus}
        quietForSeconds={quietForSeconds}
      />
      <RecentActivityFeed lines={recentLog} />
    </div>
  );
}
