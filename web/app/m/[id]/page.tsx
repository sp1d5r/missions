import { notFound, redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Denied, Ident, Tag, toneFor, type Tone } from "@/components/chrome";
import { MissionComposer } from "@/components/mission-actions";
import { MissionThread } from "@/components/mission-thread";
import { Shell, ThreadHead } from "@/components/shell";
import { mission, record } from "@/lib/data";
import { mayMutate, session } from "@/lib/guard";

export const dynamic = "force-dynamic";

const STRENGTH_TONE: Record<string, Tone> = {
	behavioural: "ok",
	existence: "warn",
	review: "warn",
	unclassified: "quiet",
};


export default async function Mission({ params }: { params: Promise<{ id: string }> }) {
	const s = await session();
	if (s.state === "anonymous") redirect("/sign-in");
	if (s.state === "denied") return <Denied userId={s.userId} label={s.label} />;
	const op = s.op;

	const { id } = await params;
	const rec = record(id);
	if (!rec) notFound();
	const st = mission(id);
	const sc = st?.scoreCard;
	const sb = sc?.strengthBreakdown;
	const behavioural = sb?.behavioural;
	const downgraded = (sc?.checks ?? []).filter((c) => c.strengthCorrected);
	const events = st?.events ?? [];

	return (
		<Shell op={op} pane="main">
			{!rec.done && <AutoRefresh seconds={8} />}
			<ThreadHead title={rec.name} sub={`${rec.repoName} · ${rec.goal}`}>
				<div style={{ textAlign: "right" }}>
					<Tag tone={toneFor(rec)}>{rec.done ? (rec.verdict ?? rec.status) : rec.stalled ? "stalled" : rec.status}</Tag>
					{rec.needsYou && <Tag tone="warn">needs you</Tag>}
				</div>
			</ThreadHead>

			<div className="thread">
				{/*
				 * The honest headline is behavioural, not "5/5".
				 * CONTRACTS.md exists because a mission reported 6/6 and CLEAN while
				 * none of the six executed the feature.
				 */}
				<div className="row" style={{ gap: 14, marginBottom: 10 }}>
					<span>
						<span className="label">behavioural </span>
						<b>{behavioural ? `${behavioural.passed}/${behavioural.total}` : "—"}</b>
					</span>
					<span className="dim">
						<span className="label">assertions </span>
						{sc ? `${sc.assertionsPassed}/${sc.assertionsTotal}` : "—"}
					</span>
					<span className={sc?.bugs.length ? "exit-bad" : "dim"}>
						<span className="label">bugs </span>
						{sc?.bugs.length ?? 0}
					</span>
					<span className="dim">
						<span className="label">cost </span>${(rec.costUsd ?? 0).toFixed(2)}
					</span>
					{st?.branch && <Ident>{st.branch}</Ident>}
				</div>

				{behavioural?.total === 0 && sc && sc.assertionsTotal > 0 && (
					<div className="alert">
						<div className="label">Nothing here executed the feature</div>
						<p style={{ margin: "6px 0 0" }}>
							{sc.assertionsTotal} assertion{sc.assertionsTotal === 1 ? "" : "s"} passed, none
							behavioural. This says the code exists and reads correctly — not that it works.
						</p>
					</div>
				)}

				{downgraded.length > 0 && (
					<div className="alert">
						<div className="label">Downgraded by the classifier</div>
						<ul>
							{downgraded.map((c) => (
								<li key={c.command}>
									<span className="dim">
										{c.declaredStrength} → {c.effectiveStrength}:
									</span>{" "}
									<code>{c.command.slice(0, 110)}</code>
								</li>
							))}
						</ul>
					</div>
				)}

				{sb && (
					<div className="row" style={{ gap: 6, marginBottom: 8 }}>
						{(["behavioural", "existence", "review", "unclassified"] as const).map((k) => {
							const cell = sb[k];
							if (!cell || cell.total === 0) return null;
							return (
								<Tag key={k} tone={STRENGTH_TONE[k]}>
									{k} {cell.passed}/{cell.total}
								</Tag>
							);
						})}
					</div>
				)}

				{sc && sc.bugs.length > 0 && (
					<div className="panel">
						<div className="label">Bugs</div>
						{sc.bugs.map((b) => (
							<div key={`${b.file ?? ""}:${b.summary}`} style={{ marginTop: 6 }}>
								<Tag tone={b.severity === "critical" || b.severity === "high" ? "bad" : "warn"}>
									{b.severity}
								</Tag>
								{b.summary}
								{b.file && <span className="faint"> — {b.file}{b.line ? `:${b.line}` : ""}</span>}
							</div>
						))}
					</div>
				)}

				{/* ── the thread proper ─────────────────────────────────────────── */}
				{/* A client component: replies expand in place, which is the whole point of them. */}
				<MissionThread events={events} />

				{st?.commits && st.commits.length > 0 && (
					<>
						<div className="msg-sep">
							<span>commits</span>
						</div>
						{st.commits.map((c, i) => (
							<div className="msg" key={c.sha ?? i}>
								<div className="msg-when faint">{(c.sha ?? "").slice(0, 7)}</div>
								<div className="msg-body">{c.message}</div>
							</div>
						))}
					</>
				)}
			</div>

			<MissionComposer
				id={rec.id}
				name={rec.name}
				done={rec.done}
				cleared={Boolean(rec.cleared)}
				canMutate={mayMutate(op)}
			/>
		</Shell>
	);
}
