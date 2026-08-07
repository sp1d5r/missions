/**
 * Headless-browser screenshot tool.
 *
 * Launches Playwright chromium (lazily — the browser is started on first call and kept
 * alive across calls, then closed at process exit), captures a PNG of the given URL,
 * and returns it as an Anthropic-style image content part so the existing extractImageParts
 * path in worker.ts picks it up automatically.
 *
 * Registration: add createScreenshotTool() to the tools array in runWorker() in
 * src/worker.ts alongside createCodingTools() and createDelegateTool().
 */

import { type Browser } from "playwright";
import { Type, type AgentTool } from "../../pi.js";

// ---------------------------------------------------------------------------
// Lazy browser lifecycle
// ---------------------------------------------------------------------------

let browser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;

/**
 * Return the shared browser instance, launching it once on first call.
 * The process-exit handler ensures it is closed cleanly.
 */
async function getBrowser(): Promise<Browser> {
	if (browser) return browser;
	if (browserPromise) return browserPromise;

	browserPromise = (async () => {
		// Dynamic import so the module loads even when playwright is not installed.
		const { chromium } = await import("playwright");
		const b = await chromium.launch({ headless: true });
		browser = b;
		// Clean up on any exit so the browser process does not become a zombie.
		const cleanup = () => { b.close().catch(() => {}); };
		process.once("exit", cleanup);
		process.once("SIGINT", cleanup);
		process.once("SIGTERM", cleanup);
		return b;
	})();

	return browserPromise;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface ScreenshotToolOptions {
	/** Default viewport width in pixels. Override per-call with the viewport arg. */
	defaultWidth?: number;
	/** Default viewport height in pixels. */
	defaultHeight?: number;
}

/** Shape returned in the tool result content array (Anthropic image part). */
interface ImageContentPart {
	type: "image";
	source: {
		type: "base64";
		media_type: "image/png";
		data: string;
	};
}

/**
 * Create a reusable screenshot tool that can be registered in the worker tool surface.
 *
 * The tool accepts:
 *   - url       (required) — any URL the browser can load; use data: or about:blank for offline runs
 *   - width     (optional) — viewport width in pixels (default 1280)
 *   - height    (optional) — viewport height in pixels (default 800)
 *   - selector  (optional) — CSS selector; if provided, only that element is captured
 *   - fullPage  (optional) — capture the full scrollable page (default false)
 *
 * The result content array contains one `{ type: "image", source: { type: "base64", … } }` part.
 * The existing extractImageParts() in worker.ts decodes this automatically on tool_execution_end,
 * so the image flows through onProgress → store.attachImage → state.events without any extra wiring.
 */
export function createScreenshotTool(opts: ScreenshotToolOptions = {}): AgentTool {
	const defaultWidth = opts.defaultWidth ?? 1280;
	const defaultHeight = opts.defaultHeight ?? 800;

	return {
		name: "screenshot",
		label: "screenshot",
		description:
			"Capture a PNG screenshot of a URL using a headless Chromium browser. " +
			"Pass a data: URL or about:blank for offline use. " +
			"Returns the image so the mission timeline records it as an attachment. " +
			"Args: url (required), width (px, default 1280), height (px, default 800), " +
			"selector (CSS selector to capture a specific element, optional), " +
			"fullPage (capture entire scrollable page, default false).",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to before taking the screenshot." }),
			width: Type.Optional(Type.Number({ description: "Viewport width in pixels (default 1280)." })),
			height: Type.Optional(Type.Number({ description: "Viewport height in pixels (default 800)." })),
			selector: Type.Optional(Type.String({ description: "CSS selector of the element to screenshot. If omitted, the full viewport (or full page) is captured." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page height (default false)." })),
		}),

		async execute(
			_toolCallId: string,
			params: {
				url: string;
				width?: number;
				height?: number;
				selector?: string;
				fullPage?: boolean;
			},
		) {
			const { url, selector, fullPage = false } = params;
			const width = params.width ?? defaultWidth;
			const height = params.height ?? defaultHeight;

			const b = await getBrowser();
			const context = await b.newContext({
				viewport: { width, height },
			});
			const page = await context.newPage();

			try {
				// Use domcontentloaded for speed on data: URLs which have no network requests.
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

				let pngBuffer: Buffer;
				if (selector) {
					const element = page.locator(selector).first();
					pngBuffer = Buffer.from(await element.screenshot({ type: "png" }));
				} else {
					pngBuffer = Buffer.from(await page.screenshot({ type: "png", fullPage }));
				}

				const base64Data = pngBuffer.toString("base64");
				const imagePart: ImageContentPart = {
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: base64Data,
					},
				};

				return {
					content: [
						{ type: "text" as const, text: `Screenshot captured: ${url} (${width}×${height}px, ${pngBuffer.length} bytes)` },
						imagePart,
					],
					details: {
						url,
						width,
						height,
						selector,
						fullPage,
						bytes: pngBuffer.length,
					},
				};
			} finally {
				await context.close();
			}
		},
	} as unknown as AgentTool;
}
