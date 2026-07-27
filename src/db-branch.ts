import type { Plan } from "./types.js";

// Database isolation, scoped to where it actually matters.
//
// The working doctrine for Nadine today: local is one machine, production is the only
// other environment, and almost everything legitimately touches production because there
// are no customers yet. Reads and row writes against prod are accepted cost. A SCHEMA
// change is not — it is the one action a parallel agent can take that breaks the main
// checkout, every other in-flight mission, and the deployed services at once.
//
// So: no blanket sandbox. Branch the database only when a mission's plan involves
// migrations, and when it does and we cannot branch, say so loudly rather than letting a
// worker run `alembic upgrade head` against prod believing it was sandboxed.

const MIGRATION_SIGNALS =
	/\balembic\b|\bmigrations?\b|\bmigrate\b|upgrade head|downgrade|\bDDL\b|ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN|schema change/i;

/** Does this plan involve a schema change? Scans everything the orchestrator wrote. */
export function planTouchesSchema(plan: Plan): boolean {
	const haystack = [
		plan.summary,
		plan.architectureNote,
		...plan.features.flatMap((f) => [f.title, f.description, ...(f.procedures ?? [])]),
		...plan.contract.assertions.flatMap((a) => [
			a.statement,
			a.method.type === "bash-command" ? a.method.command : "",
		]),
	].join("\n");
	return MIGRATION_SIGNALS.test(haystack);
}

export interface DbBranch {
	/** Env vars to override so every command in the mission talks to the branch. */
	overrides: Record<string, string>;
	/** Called at mission end. Never throws. */
	teardown: () => Promise<void>;
	note: string;
}

export type DbBranchOutcome =
	/** Branched — the mission's schema work is isolated. */
	| { status: "branched"; branch: DbBranch }
	/** No schema work in the plan, so prod is the intended target. */
	| { status: "not-needed"; note: string }
	/** Schema work IS planned but we cannot isolate it. The mission must be told. */
	| { status: "unavailable"; note: string };

const NEON_API = "https://console.neon.tech/api/v2";

// Cost controls. Measured rates on the nadeen project (Launch plan, 2026-07-27):
// storage $0.35/GB-month, compute $0.106/CU-hour.
//
// Storage is a non-issue: a branch is copy-on-write, so it starts at 0 bytes against a 15GB
// parent and only the post-branch delta is billed — a 2GB migration delta held for an hour is
// about $0.001. Compute is the whole cost, and an orphan is the whole risk:
//
//   torn down after 30 min at 0.25 CU   ~$0.013   (noise)
//   orphan, autosuspend working          ~$0.70/month  (storage delta only)
//   orphan, 0.25 CU never suspending    ~$19/month
//   orphan, 2 CU never suspending      ~$155/month     <- the one to prevent
//
// So: pin the ceiling low, make the idle timeout explicit rather than inherited, and sweep
// orphans on the way in because teardown cannot be relied on to run.
const MISSION_MIN_CU = 0.25;
const MISSION_MAX_CU = 1;
// 300s is the floor on the Launch plan — anything shorter is rejected with
// `412 suspend interval is too short for your plan`. Costs ~$0.002 of trailing idle compute
// per mission at the pinned min CU, which is not worth optimising further.
const MISSION_SUSPEND_SECONDS = 300;
/** Mission branches older than this are assumed orphaned by a crashed run and removed. */
const ORPHAN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Delete `missions/*` branches left behind by earlier runs.
 *
 * Skips the current mission's own branch name, and anything younger than ORPHAN_MAX_AGE_MS so a
 * genuinely concurrent mission is never cut out from under itself. Non-throwing: a failed sweep
 * must not stop the mission that is trying to start.
 */
async function sweepOrphanBranches(apiKey: string, projectId: string, missionId: string): Promise<string[]> {
	const keep = `missions/${missionId}`;
	const removed: string[] = [];
	try {
		const res = await fetch(`${NEON_API}/projects/${projectId}/branches`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!res.ok) return removed;
		const { branches = [] } = (await res.json()) as {
			branches?: Array<{ id?: string; name?: string; created_at?: string; default?: boolean }>;
		};
		for (const b of branches) {
			if (!b.id || !b.name || b.default) continue;
			if (!b.name.startsWith("missions/") || b.name === keep) continue;
			const age = b.created_at ? Date.now() - Date.parse(b.created_at) : 0;
			if (age < ORPHAN_MAX_AGE_MS) continue;
			const del = await fetch(`${NEON_API}/projects/${projectId}/branches/${b.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${apiKey}` },
			});
			if (del.ok) removed.push(b.name);
		}
	} catch {
		/* a sweep that fails must never block the mission */
	}
	return removed;
}

/**
 * Provision a Neon branch for a mission that plans schema work.
 *
 * Requires NEON_API_KEY + NEON_PROJECT_ID in the harness env. Neither is currently
 * configured anywhere in Nadine (not in .env, not in SSM under /nadine), so today this
 * returns "unavailable" — which is the point: the mission carries an explicit warning
 * instead of a false sense of isolation.
 */
export async function provisionDbBranch(options: {
	plan: Plan;
	missionId: string;
	env?: NodeJS.ProcessEnv;
}): Promise<DbBranchOutcome> {
	const { plan, missionId, env = process.env } = options;
	if (!planTouchesSchema(plan)) {
		return { status: "not-needed", note: "no schema work planned — running against the live database, as intended" };
	}

	const apiKey = env.NEON_API_KEY;
	const projectId = env.NEON_PROJECT_ID;
	if (!apiKey || !projectId) {
		return {
			status: "unavailable",
			note: "plan involves a schema change but NEON_API_KEY / NEON_PROJECT_ID are not set — cannot branch the database. Migrations must NOT be applied in this mission.",
		};
	}

	// Sweep first. `finally` cannot run if the daemon is killed, the machine sleeps, or the
	// process dies outside the try — and an orphaned branch whose compute never suspends is
	// the only genuinely expensive failure mode here (see the cost note at the top of this file).
	const swept = await sweepOrphanBranches(apiKey, projectId, missionId);
	if (swept.length) console.log(`[db-branch] swept ${swept.length} orphaned mission branch(es): ${swept.join(", ")}`);

	const branchName = `missions/${missionId}`;
	try {
		const res = await fetch(`${NEON_API}/projects/${projectId}/branches`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				branch: { name: branchName },
				endpoints: [
					{
						type: "read_write",
						// Both of these are cost controls, and both must be explicit. Left unset, the
						// endpoint inherits the project defaults — measured as 0.25-2 CU with an implicit
						// suspend timeout, i.e. up to 8x the compute ceiling a migration needs and no
						// stated idle behaviour.
						autoscaling_limit_min_cu: MISSION_MIN_CU,
						autoscaling_limit_max_cu: MISSION_MAX_CU,
						suspend_timeout_seconds: MISSION_SUSPEND_SECONDS,
					},
				],
			}),
		});
		if (!res.ok) {
			return {
				status: "unavailable",
				note: `Neon branch create failed (${res.status}): ${(await res.text()).slice(0, 300)} — migrations must NOT be applied in this mission.`,
			};
		}
		const body = (await res.json()) as {
			branch?: { id?: string };
			connection_uris?: Array<{ connection_uri?: string }>;
		};
		const branchId = body.branch?.id;
		const uri = body.connection_uris?.[0]?.connection_uri;
		if (!branchId || !uri) {
			return {
				status: "unavailable",
				note: "Neon returned no connection URI for the new branch — migrations must NOT be applied in this mission.",
			};
		}

		const overrides: Record<string, string> = { DATABASE_URL: uri };
		try {
			overrides.DB_HOST = new URL(uri).hostname;
		} catch {
			/* leave DB_HOST alone if the URI does not parse */
		}

		return {
			status: "branched",
			branch: {
				overrides,
				note: `Neon branch ${branchName} (${branchId}) — schema changes are isolated from production`,
				teardown: async () => {
					try {
						await fetch(`${NEON_API}/projects/${projectId}/branches/${branchId}`, {
							method: "DELETE",
							headers: { Authorization: `Bearer ${apiKey}` },
						});
					} catch {
						/* a leaked branch is cheap; a crashed teardown that fails the mission is not */
					}
				},
			},
		};
	} catch (err) {
		return {
			status: "unavailable",
			note: `Neon branch create errored (${err instanceof Error ? err.message : String(err)}) — migrations must NOT be applied in this mission.`,
		};
	}
}
