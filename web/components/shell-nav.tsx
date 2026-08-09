"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { Tone } from "@/components/chrome";

export interface ChanItem {
	id: string;
	name: string;
	goal: string;
	repoName: string;
	tone: Tone;
	meta: string;
	needsYou: boolean;
}

const TONE_VAR: Record<Tone, string> = {
	ok: "var(--ok)",
	warn: "var(--warn)",
	bad: "var(--bad)",
	done: "var(--done)",
	live: "var(--live)",
	quiet: "var(--text-faint)",
};

/** The rail: the org, then one square per repo. Slack's workspace switcher. */
export function Rail({ repos }: { repos: { name: string; path: string }[] }) {
	const path = usePathname();
	const params = useSearchParams();
	const active = params.get("repo");

	return (
		<div className="rail">
			<Link href="/" data-active={path === "/" && !active} title="All missions">
				ORG
			</Link>
			<div className="rail-sep" />
			{repos.map((r) => (
				<Link
					key={r.path}
					href={`/?repo=${encodeURIComponent(r.name)}`}
					data-active={active === r.name}
					title={r.path}
				>
					{/* Two letters is all a 38px square holds legibly. */}
					{r.name.slice(0, 2).toUpperCase()}
				</Link>
			))}
		</div>
	);
}

/** The sidebar list. A mission is a channel; the chief and dispatch sit above them. */
export function ChanList({ items }: { items: ChanItem[] }) {
	const path = usePathname();
	const needsYou = items.filter((i) => i.needsYou);
	const running = items.filter((i) => !i.needsYou && i.tone === "live");
	const rest = items.filter((i) => !i.needsYou && i.tone !== "live");

	return (
		<div className="side-scroll">
			<div className="side-group">Org</div>
			<Link className="chan" href="/chief" data-active={path === "/chief"}>
				<span className="chan-dot" style={{ color: "var(--text-faint)" }} />
				<span className="chan-name">chief</span>
				<span className="chan-meta" />
				<span className="chan-goal">the shared session</span>
			</Link>
			<Link className="chan" href="/dispatch" data-active={path === "/dispatch"}>
				<span className="chan-dot" style={{ color: "var(--text-faint)" }} />
				<span className="chan-name">dispatch</span>
				<span className="chan-meta" />
				<span className="chan-goal">start a mission</span>
			</Link>

			<Section title={`Needs you (${needsYou.length})`} items={needsYou} path={path} />
			<Section title={`Running (${running.length})`} items={running} path={path} />
			<Section title="Recent" items={rest} path={path} />
		</div>
	);
}

function Section({ title, items, path }: { title: string; items: ChanItem[]; path: string }) {
	if (items.length === 0) return null;
	return (
		<>
			<div className="side-group">{title}</div>
			{items.map((i) => (
				<Link
					key={i.id}
					className="chan"
					href={`/m/${i.id}`}
					data-active={path === `/m/${i.id}`}
					title={i.goal}
				>
					<span className="chan-dot" style={{ color: TONE_VAR[i.tone] }} />
					<span className="chan-name">{i.name}</span>
					<span className="chan-meta">{i.meta}</span>
					<span className="chan-goal">
						{i.repoName} · {i.goal}
					</span>
				</Link>
			))}
		</>
	);
}
