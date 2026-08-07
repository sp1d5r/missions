/**
 * A cheap, honest liveness check for the org daemon.
 *
 * Exists so the console can show its own pulse instead of the operator
 * having to SSH in and grep `ps` — see `daemonUp()` for why this dials the
 * socket rather than trusting the file on disk.
 */
import { daemonUp } from "@/lib/daemon";
import { requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;

	const up = await daemonUp();
	return Response.json({ up, checkedAt: new Date().toISOString() });
}
