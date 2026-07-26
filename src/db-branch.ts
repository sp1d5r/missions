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

	const branchName = `missions/${missionId}`;
	try {
		const res = await fetch(`${NEON_API}/projects/${projectId}/branches`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ branch: { name: branchName }, endpoints: [{ type: "read_write" }] }),
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
