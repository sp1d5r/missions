/**
 * One idea: PATCH edits title/description/status (this is how a card moves columns —
 * the board drags a card then PATCHes its status), DELETE removes it outright.
 */
import { deleteIdea, IDEA_STATUSES, type IdeaStatus, updateIdea } from "@missions/ideas.js";
import { mayMutate, requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	if (!mayMutate(gate.op)) {
		return Response.json({ error: "writes disabled until MISSIONS_ALLOWED_USER_IDS pins this console" }, { status: 403 });
	}

	const { id } = await ctx.params;
	let body: { title?: string; description?: string; status?: string };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}
	if (body.status !== undefined && !IDEA_STATUSES.includes(body.status as IdeaStatus)) {
		return Response.json({ error: "bad status" }, { status: 400 });
	}

	const idea = updateIdea(id, {
		...(body.title !== undefined ? { title: body.title.trim() } : {}),
		...(body.description !== undefined ? { description: body.description.trim() } : {}),
		...(body.status !== undefined ? { status: body.status as IdeaStatus } : {}),
	});
	if (!idea) return Response.json({ error: "not found" }, { status: 404 });
	return Response.json({ idea });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	if (!mayMutate(gate.op)) {
		return Response.json({ error: "writes disabled until MISSIONS_ALLOWED_USER_IDS pins this console" }, { status: 403 });
	}

	const { id } = await ctx.params;
	const ok = deleteIdea(id);
	if (!ok) return Response.json({ error: "not found" }, { status: 404 });
	return Response.json({ ok: true });
}
