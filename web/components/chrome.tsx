import { SignOutButton, UserButton } from "@clerk/nextjs";
import type { Operator } from "@/lib/guard";
import { Nav } from "@/components/nav";

/**
 * Signed in, but not the operator.
 *
 * This page exists so that case never redirects. It also solves the
 * chicken-and-egg in pinning: you cannot know your Clerk user id until you have
 * signed in, and once you have signed in an allowlist you are not on would
 * normally just bounce you. So the id you need is printed right here.
 */
export function Denied({ userId, label }: { userId: string; label: string }) {
	return (
		<>
			<h1>NOT THIS ACCOUNT</h1>
			<div className="label">{label}</div>

			<div className="alert" style={{ marginTop: 18 }}>
				<div className="label">Signed in, not authorised</div>
				<p style={{ margin: "6px 0 0" }}>
					This console is pinned to a specific operator and you are not on the list. Nothing here is
					readable until your id is added.
				</p>
			</div>

			<h2>Your Clerk user id</h2>
			<pre className="src" style={{ whiteSpace: "pre-wrap", color: "var(--text)" }}>
				{userId}
			</pre>
			<p className="dim">
				Add it to <code>web/.env.local</code>, then restart the server:
			</p>
			<pre className="src">{`MISSIONS_ALLOWED_USER_IDS=${userId}`}</pre>
			<p className="faint">Comma-separate to allow more than one.</p>

			<div className="row" style={{ marginTop: 18 }}>
				<SignOutButton>
					<button type="button">sign out</button>
				</SignOutButton>
			</div>
		</>
	);
}

export type Tone = "ok" | "warn" | "bad" | "done" | "live" | "quiet";

export function Tag({ tone, children }: { tone: Tone; children: React.ReactNode }) {
	return <span className={`tag t-${tone}`}>{children}</span>;
}

/**
 * Tone by OUTCOME, not status — "succeeded" covers both clean work and stalled work.
 *
 * Clean work is BONE, not purple. Rule 1 of the theme is that a screen with no
 * colour on it is good news you can read at a glance, and that only works if
 * the healthy majority spends no colour at all. Ten purple PASSED tags made the
 * four amber ones that actually wanted a decision compete for attention.
 */
export function toneFor(row: { done: boolean; outcome?: string; status: string; stalled?: boolean }): Tone {
	// A stalled mission is not live, whatever its status field still says. It stopped writing an
	// hour ago and its process is gone; painting it blue told you to wait for something that was
	// never coming back.
	if (row.stalled) return "warn";
	if (!row.done) return "live";
	if (row.status === "failed") return "bad";
	if (row.outcome === "clean") return "ok";
	return "warn";
}

/**
 * An identifier, printed exactly as it is.
 *
 * `.tag` and `.label` both uppercase their contents, which is fine for a status
 * word and wrong for a branch name or a mission id — those are case-sensitive
 * strings you might retype. Rule 3 says every mark is a fact; a fact you have
 * mangled is not one.
 */
export function Ident({ children }: { children: React.ReactNode }) {
	return (
		<span className="tag t-quiet" style={{ textTransform: "none", letterSpacing: 0 }}>
			{children}
		</span>
	);
}

export function StatStrip({ cells }: { cells: { value: string; label: string; tone?: Tone }[] }) {
	const hex: Record<Tone, string> = {
		ok: "var(--ok)",
		warn: "var(--warn)",
		bad: "var(--bad)",
		done: "var(--done)",
		live: "var(--live)",
		quiet: "var(--text-dim)",
	};
	return (
		<div className="stats">
			{cells.map((c) => (
				<div className="stat" key={c.label}>
					<b style={c.tone ? { color: hex[c.tone] } : undefined}>{c.value}</b>
					<span>{c.label}</span>
				</div>
			))}
		</div>
	);
}

export function Header({ op, title, sub }: { op: Operator; title: string; sub?: string }) {
	return (
		<>
			{!op.pinned && (
				<div className="banner">
					UNPINNED — anyone who can sign in with GitHub reaches this console, and writes are
					disabled until you pin it. Set MISSIONS_ALLOWED_USER_IDS={op.userId} in web/.env.local
					and restart.
				</div>
			)}
			<div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
				<div className="grow">
					<h1>{title}</h1>
					{sub && <div className="label">{sub}</div>}
				</div>
				<UserButton />
			</div>
			<Nav />
		</>
	);
}


/** Relative time, because "3m ago" is the only form worth reading on a board. */
export function ago(iso: string): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "—";
	const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}
