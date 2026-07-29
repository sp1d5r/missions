/**
 * One operator, enforced twice.
 *
 * Clerk answers "is this a real GitHub account we know". It does not answer
 * "is this ELIJAH", and on a public tunnel those are very different questions —
 * a dev instance with public sign-up will happily mint an account for anyone
 * who finds the URL. So every entry point asks this module, and this module
 * checks the Clerk user id against an explicit allowlist.
 *
 * UNPINNED is the dangerous state and is therefore the loud one. Until
 * MISSIONS_ALLOWED_USER_IDS is set there is no second factor at all, so the
 * console says so on every page rather than failing open in silence.
 */
import { auth, currentUser } from "@clerk/nextjs/server";

export interface Operator {
	userId: string;
	label: string;
	/** False when MISSIONS_ALLOWED_USER_IDS is unset — Clerk is the only gate. */
	pinned: boolean;
}

function allowlist(): string[] {
	return (process.env.MISSIONS_ALLOWED_USER_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Why someone is not getting in — the distinction that stops a redirect loop.
 *
 * "Not signed in" and "signed in as the wrong account" both used to collapse to
 * null, and every page answered null by redirecting to /sign-in. Clerk sees a
 * live session there, bounces straight back to /, and the two redirects chase
 * each other forever. Anonymous visitors get sent to sign-in; a signed-in
 * stranger has to be told, on a page that renders.
 */
export type Session =
	| { state: "anonymous" }
	| { state: "denied"; userId: string; label: string }
	| { state: "ok"; op: Operator };

export async function session(): Promise<Session> {
	const { userId } = await auth();
	if (!userId) return { state: "anonymous" };

	const user = await currentUser();
	const label = user?.username ?? user?.emailAddresses[0]?.emailAddress ?? userId;

	const allowed = allowlist();
	if (allowed.length > 0 && !allowed.includes(userId)) {
		return { state: "denied", userId, label };
	}
	return { state: "ok", op: { userId, label, pinned: allowed.length > 0 } };
}

/** The operator, or null. Route handlers use this; pages want `session()`. */
export async function operator(): Promise<Operator | null> {
	const s = await session();
	return s.state === "ok" ? s.op : null;
}

/** Route-handler guard: the operator, or a 401 you should return as-is. */
export async function requireOperator(): Promise<{ op: Operator } | { deny: Response }> {
	const op = await operator();
	if (!op) return { deny: Response.json({ error: "unauthorized" }, { status: 401 }) };
	return { op };
}

/**
 * Mutations are gated a second time.
 *
 * Reading a board over a tunnel is a small mistake; dispatching a mission that
 * spends real money, or steering a worker mid-flight, is not. Writes stay off
 * until the operator is pinned to a specific user id — being merely signed in
 * is not enough to spend money.
 */
export function mayMutate(op: Operator): boolean {
	return op.pinned;
}
