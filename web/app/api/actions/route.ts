/**
 * Writes.
 *
 * Two kinds, split on purpose:
 *
 *   DIRECT — `clear` is one boolean on one registry record. There is no judgment
 *   in it, so it runs here against the same `updateActive` the TUI calls.
 *
 *   VIA THE CHIEF — dispatch, merge and steer are multi-step and already
 *   implemented as chief tools (`run_mission`, `merge_mission`), complete with
 *   worktree reclaim, branch deletion and conflict reporting. Reimplementing
 *   that sequence here would give the org two merge procedures that drift apart,
 *   which is the failure this repo keeps writing documents about. Missions are
 *   addressed by ID — the chief has never heard of codenames.
 *
 * Every write requires a PINNED operator. Being merely signed in is not enough
 * to spend money — see lib/guard.ts.
 */
import { updateActive } from "@missions/registry.js";
import { record } from "@/lib/data";
import { daemonUp, sendInput } from "@/lib/daemon";
import { mayMutate, requireOperator } from "@/lib/guard";

interface Body {
	action: "clear" | "steer" | "merge" | "dispatch";
	id?: string;
	name?: string;
	repo?: string;
	text?: string;
}

export async function POST(req: Request) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	if (!mayMutate(gate.op)) {
		return Response.json(
			{ error: "writes disabled until MISSIONS_ALLOWED_USER_IDS pins this console" },
			{ status: 403 },
		);
	}

	let body: Body;
	try {
		body = (await req.json()) as Body;
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}

	if (body.action === "clear") {
		if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
		updateActive(body.id, { cleared: true });
		return Response.json({ ok: true, said: "cleared" });
	}

	if (!daemonUp()) {
		return Response.json(
			{ error: "no daemon — start the org with `missions chat` on the host" },
			{ status: 503 },
		);
	}

	// Everything below is a sentence typed at the chief, exactly as the TUI does
	// it. The reply arrives on /api/chief/stream, which every attached client —
	// this phone and your terminal — is already watching.
	/*
	 * Address missions by ID, never by codename.
	 *
	 * `codename()` lives in theme.ts and is invented by the presentation layer
	 * from the mission id — the chief has never heard of it, and answers
	 * "I have no idea what BRASSANVIL is". Its merge_mission tool takes a
	 * missionId (or an unambiguous prefix), so that is what gets sent; the
	 * codename rides along only as context for the human reading the transcript.
	 */
	const rec = body.id ? record(body.id) : null;
	const label = rec ? `${rec.id} (${rec.name}, ${rec.repoName})` : (body.id ?? body.name ?? "");

	let text: string;
	switch (body.action) {
		case "merge":
			if (!rec) return Response.json({ error: "unknown mission" }, { status: 400 });
			text = `Merge mission ${rec.id} — that is ${rec.name} in ${rec.repoName}.`;
			break;
		case "steer":
			if (!body.text?.trim()) return Response.json({ error: "text required" }, { status: 400 });
			text = rec ? `Regarding mission ${label}: ${body.text.trim()}` : body.text.trim();
			break;
		case "dispatch": {
			const goal = body.text?.trim();
			if (!goal) return Response.json({ error: "goal required" }, { status: 400 });
			text = body.repo
				? `Run a mission in ${body.repo}: ${goal}`
				: `Run a mission: ${goal}`;
			break;
		}
		default:
			return Response.json({ error: "unknown action" }, { status: 400 });
	}

	await sendInput(text);
	return Response.json({ ok: true, said: text });
}
