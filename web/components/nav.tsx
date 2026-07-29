"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
	{ href: "/", label: "Board" },
	{ href: "/chief", label: "Chief" },
	{ href: "/dispatch", label: "Dispatch" },
] as const;

/**
 * Client-side so the current tab can actually be marked.
 *
 * The CSS had a `[data-active]` rule from the start and nothing ever set it, so
 * all three tabs rendered identically and the console never told you where you
 * were.
 */
export function Nav() {
	const path = usePathname();
	return (
		<nav className="nav">
			{TABS.map((t) => {
				// A mission page belongs to the board it came from.
				const active = t.href === "/" ? path === "/" || path.startsWith("/m/") : path.startsWith(t.href);
				return (
					<Link key={t.href} href={t.href} data-active={active}>
						{t.label}
					</Link>
				);
			})}
		</nav>
	);
}
