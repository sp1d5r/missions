import { UserButton } from "@clerk/nextjs";
import { Suspense } from "react";
import { ago, toneFor } from "@/components/chrome";
import { ChanList, Rail, type ChanItem } from "@/components/shell-nav";
import { board, summary, workspaces } from "@/lib/data";
import type { Operator } from "@/lib/guard";

/**
 * The app shell: rail, mission list, thread.
 *
 * `pane` decides which side wins on a phone, where only one can be shown. The
 * route already knows the answer — the board is the list, a mission or the
 * chief is the thread — so nothing here needs client state to work out which
 * half of the app you are looking at.
 */
export function Shell({
	op,
	pane,
	repoFilter,
	children,
}: {
	op: Operator;
	pane: "side" | "main";
	repoFilter?: string;
	children: React.ReactNode;
}) {
	const all = board();
	const rows = repoFilter ? all.filter((r) => r.repoName === repoFilter) : all;
	const tally = summary(rows);

	const items: ChanItem[] = rows.map((r) => ({
		id: r.id,
		name: r.name,
		goal: r.goal,
		repoName: r.repoName,
		tone: toneFor(r),
		meta: ago(r.updatedAt),
		needsYou: r.needsYou,
	}));

	return (
		<div className="app" data-pane={pane}>
			<Suspense fallback={<div className="rail" />}>
				<Rail repos={workspaces().map((w) => ({ name: w.name, path: w.path }))} />
			</Suspense>

			<div className="side">
				<div className="side-head">
					<div className="row" style={{ justifyContent: "space-between" }}>
						<div className="grow">
							<h1>{repoFilter ?? "THE ORG"}</h1>
							<div className="label">
								{tally.running} running · {tally.needsYou} need you
									{tally.stalled > 0 && <span className="tally-bad"> · {tally.stalled} stalled</span>} · ${tally.spendUsd.toFixed(2)}
							</div>
						</div>
						<UserButton />
					</div>
					{!op.pinned && (
						<div className="banner" style={{ margin: "10px 0 0" }}>
							UNPINNED — writes disabled. Set MISSIONS_ALLOWED_USER_IDS={op.userId}
						</div>
					)}
				</div>
				<ChanList items={items} />
			</div>

			<div className="main">{children}</div>
		</div>
	);
}

/** The sticky header every thread pane gets, with the phone's way back to the list. */
export function ThreadHead({
	title,
	sub,
	children,
}: {
	title: string;
	sub?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="main-head">
			<a className="back" href="/" aria-label="Back to missions">
				←
			</a>
			<div className="grow">
				<h1>{title}</h1>
				{sub && <div className="head-sub">{sub}</div>}
			</div>
			{children}
		</div>
	);
}
