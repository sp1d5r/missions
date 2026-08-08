import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { record } from "@/lib/data";

export const dynamic = "force-dynamic";

const LOG_TAIL = 10;

/**
 * GET /api/m/[id]/state
 *
 * Lightweight poll target for the live-activity indicator and recent-activity
 * feed. Returns a subset of the mission record plus the last LOG_TAIL lines of
 * the mission log. Does NOT change the shape of existing fields — only adds
 * `recentLog`.
 *
 * Auth: same operator session as the page. If the record is not found we return
 * 404 rather than leaking that it exists.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rec = record(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Read the last LOG_TAIL lines from state.json's log array.
  // We read state.json directly so we can tail the log without shipping the
  // entire state over the wire every 2-5 s.
  let recentLog: string[] = [];
  try {
    const dir = rec.outDir ?? join(rec.repo, ".missions", "runs", id);
    const file = join(dir, "state.json");
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as {
        log?: string[];
        status?: string;
      };
      const log = raw.log ?? [];
      recentLog = log.slice(-LOG_TAIL);
    }
  } catch {
    // Non-fatal: if we can't read logs, we still return the record.
  }

  return NextResponse.json({
    id: rec.id,
    status: rec.status,
    done: rec.done,
    updatedAt: rec.updatedAt,
    lastActivity: rec.lastActivity,
    live: rec.live,
    stalled: rec.stalled,
    verdict: rec.verdict,
    outcome: rec.outcome,
    recentLog,
  });
}
