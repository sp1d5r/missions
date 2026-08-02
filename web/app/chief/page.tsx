import { redirect } from "next/navigation";
import { readFocus } from "@missions/focus.js";
import { listWorkspaces } from "@missions/workspaces.js";
import { ChiefConsole } from "@/components/chief-console";
import { Denied } from "@/components/chrome";
import { Shell, ThreadHead } from "@/components/shell";
import { mayMutate, session } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function Chief() {
	const s = await session();
	if (s.state === "anonymous") redirect("/sign-in");
	if (s.state === "denied") return <Denied userId={s.userId} label={s.label} />;
	const op = s.op;

	// Read on the server: both are files under ~/.missions, so this costs no socket round-trip
	// and still works with the daemon down (you can see where it was pointed, just not move it).
	const workspaces = listWorkspaces().map((w) => ({ name: w.name, path: w.path }));
	const focus = readFocus();

	return (
		<Shell op={op} pane="main">
			<ThreadHead title="chief" sub="one session — your terminal sees this too" />
			<ChiefConsole canMutate={mayMutate(op)} workspaces={workspaces} focus={focus} />
		</Shell>
	);
}
