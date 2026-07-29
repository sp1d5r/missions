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
	//
	// pi-ai belongs here for a second, sharper reason. It loads node:fs/os/path via
	// `import(specifier)` with a runtime variable — deliberately, and commented "NEVER convert
	// to top-level imports - breaks browser/Vite builds" — so that it also works in a browser.
	// A bundler cannot resolve a variable specifier, so Turbopack compiles those calls into a
	// throw, and because they are eager and fire-and-forget with no .catch(), every request that
	// touched the agent stack logged three unhandled rejections. Nothing was actually broken:
	// the imports only feed a Vertex ADC credentials probe we never use, and our key comes from
	// the environment. But the noise is indistinguishable from a real fault, and leaving the
	// server to shout MODULE_NOT_FOUND on every page load is how a genuine one gets ignored.
	// Marking it external means Node loads it normally and the dynamic import just works.
	serverExternalPackages: ["@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
};

export default nextConfig;
