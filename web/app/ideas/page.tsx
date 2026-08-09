import { redirect } from "next/navigation";
import { Denied } from "@/components/chrome";
import { IdeasBoard } from "@/components/ideas-board";
import { Shell, ThreadHead } from "@/components/shell";
import { mayMutate, session } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function IdeasPage() {
	const s = await session();
	if (s.state === "anonymous") redirect("/sign-in");
	if (s.state === "denied") return <Denied userId={s.userId} label={s.label} />;
	const op = s.op;

	return (
		<Shell op={op} pane="main">
			<ThreadHead title="ideas" sub="everything not yet a mission" />
			<IdeasBoard canMutate={mayMutate(op)} />
		</Shell>
	);
}
