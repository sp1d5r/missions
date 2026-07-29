import { redirect } from "next/navigation";
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

	return (
		<Shell op={op} pane="main">
			<ThreadHead title="chief" sub="one session — your terminal sees this too" />
			<ChiefConsole canMutate={mayMutate(op)} />
		</Shell>
	);
}
