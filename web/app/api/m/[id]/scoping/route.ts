/**
 * The scoping document and its annotation threads for one mission.
 *
 * GET returns the current markdown plus every thread, reassembled from the append-only
 * scoping-threads.jsonl log — same durability shape as chat.jsonl (see overseer.ts).
 *
 * POST persists ONE user-authored write: open a new thread, reply to one, or toggle resolved.
 * It does not itself produce an agent reply — unlike /chat, there is no live overseer session to
 * ask here (a scoping doc exists before a mission's worker does, and stays around after). Getting
 * the agent's side of the thread onto the page is real follow-up work: either a mission-side tool
 * that calls appendScopingThreadReply directly (the same function this route calls), or a
 * dedicated scoping-session agent modeled on createOverseerSession. This route only does the
 * user-write half so the UI has something real to persist against while that gets built.
 */
import { existsSync } from "node:fs";
import {
	appendScopingThreadOpen,
	appendScopingThreadReply,
	loadScopingThreads,
	readScopingDoc,
	scopingDocPath,
	setScopingThreadResolved,
} from "@missions/scoping.js";
import { record } from "@/lib/data";
import { mayMutate, requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function outDirFor(id: string): Promise<{ outDir: string } | { deny: Response }> {
	const rec = record(id);
	if (!rec) return { deny: Response.json({ error: "unknown mission" }, { status: 404 }) };
	if (!rec.outDir) return { deny: Response.json({ error: "this mission has no run directory on disk" }, { status: 409 }) };
	return { outDir: rec.outDir };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	const { id } = await ctx.params;
	const found = await outDirFor(id);
	if ("deny" in found) return found.deny;
	return Response.json({
		doc: readScopingDoc(found.outDir),
		exists: existsSync(scopingDocPath(found.outDir)),
		threads: loadScopingThreads(found.outDir),
	});
}

type Body =
	| { kind: "open"; line: number; snippet: string; text: string }
	| { kind: "reply"; threadId: string; text: string }
	| { kind: "resolve"; threadId: string; resolved: boolean };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	if (!mayMutate(gate.op)) {
		return Response.json({ error: "writes disabled until MISSIONS_ALLOWED_USER_IDS pins this console" }, { status: 403 });
	}

	const { id } = await ctx.params;
	const found = await outDirFor(id);
	if ("deny" in found) return found.deny;

	let body: Body;
	try {
		body = (await req.json()) as Body;
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}

	const at = new Date().toISOString();
	if (body.kind === "open") {
		const text = body.text?.trim();
		if (!text) return Response.json({ error: "nothing to say" }, { status: 400 });
		const threadId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		appendScopingThreadOpen(found.outDir, threadId, { line: body.line, snippet: body.snippet }, { role: "user", text, at });
		return Response.json({ threadId });
	}
	if (body.kind === "reply") {
		const text = body.text?.trim();
		if (!text) return Response.json({ error: "nothing to say" }, { status: 400 });
		appendScopingThreadReply(found.outDir, body.threadId, { role: "user", text, at });
		return Response.json({ ok: true });
	}
	if (body.kind === "resolve") {
		setScopingThreadResolved(found.outDir, body.threadId, body.resolved);
		return Response.json({ ok: true });
	}
	return Response.json({ error: "unknown write kind" }, { status: 400 });
}
