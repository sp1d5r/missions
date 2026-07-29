import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * The console is a client of the org, not a copy of it.
 *
 * Every fact it renders comes from `../dist` — the same readers the TUI and the
 * report already use — so there is exactly one implementation of "what is a
 * mission". That requires Turbopack's root to be the repo rather than `web/`,
 * or imports that climb out of this directory are refused.
 */
const nextConfig: NextConfig = {
	turbopack: { root: join(process.cwd(), "..") },
	// The org modules touch node:net, node:fs and the daemon socket. They run as
	// plain Node on the server and must never be bundled for the browser.
	serverExternalPackages: ["@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"],
};

export default nextConfig;
