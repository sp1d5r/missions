import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Denied, StatStrip } from "@/components/chrome";
import { Shell, ThreadHead } from "@/components/shell";
import { board, summary } from "@/lib/data";
import { session } from "@/lib/guard";

// The board is a live instrument. Nothing here may be cached.
export const dynamic = "force-dynamic";

export default async function Board({
	searchParams,
}: {
	searchParams: Promise<{ repo?: string }>;
}) {
	const s = await session();
	if (s.state === "anonymous") redirect("/sign-in");
	if (s.state === "denied") return <Denied userId={s.userId} label={s.label} />;
	const op = s.op;

	const { repo } = await searchParams;
	const all = board();
	const rows = repo ? all.filter((r) => r.repoName === repo) : all;
	const tally = summary(rows);
	const needsYou = rows.filter((r) => r.needsYou);

	return (
		<Shell op={op} pane="side" repoFilter={repo}>
			<AutoRefresh seconds={10} />
			<ThreadHead title="ACTIVITY" sub={repo ?? `${tally.repos} repos`} />
			<div className="thread">
				<StatStrip
					cells={[
						{ value: String(tally.running), label: "running", tone: tally.running ? "live" : "quiet" },
						{
							value: String(tally.needsYou),
							label: "needs you",
							tone: tally.needsYou ? "warn" : "quiet",
						},
						{ value: String(tally.done), label: "done", tone: "quiet" },
						{ value: `$${tally.spendUsd.toFixed(2)}`, label: "spend", tone: "quiet" },
					]}
				/>

				{needsYou.length > 0 ? (
					<div className="alert">
						<div className="label">Wants a decision</div>
						<ul>
							{needsYou.map((r) => (
								<li key={r.id}>
									<Link href={`/m/${r.id}`}>{r.name}</Link>{" "}
									<span className="dim">
										— {r.repoName}: {r.goal}
									</span>
								</li>
							))}
						</ul>
					</div>
				) : (
					<div className="empty">Nothing is waiting on you.</div>
				)}

				<h2>Running</h2>
				{rows.filter((r) => !r.done).length === 0 ? (
					<div className="empty">Nothing in flight.</div>
				) : (
					<ul className="log">
						{rows
							.filter((r) => !r.done)
							.map((r) => (
								<li key={r.id}>
									<Link href={`/m/${r.id}`}>{r.name}</Link>{" "}
									<span className="dim">
										{r.status} · {r.milestone ?? 0}/{r.maxMilestones ?? "?"} · $
										{(r.costUsd ?? 0).toFixed(2)}
									</span>
								</li>
							))}
					</ul>
				)}
			</div>
		</Shell>
	);
}
