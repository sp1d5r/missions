import { redirect } from "next/navigation";
import { Denied } from "@/components/chrome";
import { DispatchForm } from "@/components/dispatch-form";
import { Shell, ThreadHead } from "@/components/shell";
import { workspaces } from "@/lib/data";
import { mayMutate, session } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function Dispatch() {
	const s = await session();
	if (s.state === "anonymous") redirect("/sign-in");
	if (s.state === "denied") return <Denied userId={s.userId} label={s.label} />;
	const op = s.op;

	const repos = workspaces().map((w) => ({ path: w.path, name: w.name }));

	return (
		<Shell op={op} pane="main">
			<ThreadHead title="dispatch" sub={`${repos.length} workspace${repos.length === 1 ? "" : "s"}`} />
			<div className="thread">
				{repos.length === 0 ? (
					<div className="empty">
						No workspaces yet. Run <code>missions</code> in a repo on the host once.
					</div>
				) : (
					<DispatchForm repos={repos} canMutate={mayMutate(op)} />
				)}
			</div>
		</Shell>
	);
}
