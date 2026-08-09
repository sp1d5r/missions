/**
 * The idea backlog, org-wide. GET lists everything; POST creates one new idea in "backlog".
 * See src/ideas.ts for the storage model.
 */
import { createIdea, readIdeas } from "@missions/ideas.js";
import { mayMutate, requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	return Response.json({ ideas: readIdeas() });
}

export async function POST(req: Request) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;
	if (!mayMutate(gate.op)) {
		return Response.json({ error: "writes disabled until MISSIONS_ALLOWED_USER_IDS pins this console" }, { status: 403 });
	}

	let body: { title?: string; description?: string };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}

	const title = body.title?.trim();
	if (!title) return Response.json({ error: "title required" }, { status: 400 });
	const idea = createIdea(title, body.description?.trim() ?? "");
	return Response.json({ idea });
}
