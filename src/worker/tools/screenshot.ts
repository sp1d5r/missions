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

/**
 * Unref the browser's underlying OS handles so the Node.js process can exit
 * naturally when there is no other work pending. Called after each context is
 * closed (i.e. after each screenshot capture). The browser itself stays alive
 * as a singleton — only the handles are released from the event-loop reference
 * count. On process exit the registered cleanup handler closes the browser.
 *
 * This is needed so that scripts that call tool.run() directly (e.g. validators
 * and tests) do not have to call process.exit() explicitly after the capture
 * finishes.
 */
function unrefBrowserHandles(): void {
	const getHandles = (process as NodeJS.Process & { _getActiveHandles?(): unknown[] })._getActiveHandles;
	if (typeof getHandles !== "function") return;
	for (const h of getHandles.call(process)) {
		const handle = h as { constructor: { name: string }; unref?: () => void; stdin?: { unref?: () => void }; stdout?: { unref?: () => void }; stderr?: { unref?: () => void } };
		if (handle.constructor.name === "ChildProcess" || handle.constructor.name === "Socket") {
			handle.unref?.();
			handle.stdin?.unref?.();
			handle.stdout?.unref?.();
			handle.stderr?.unref?.();
		}
	}
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface ScreenshotToolOptions {
	/** Default viewport width in pixels. Override per-call with the viewport arg. */
	defaultWidth?: number;
	/** Default viewport height in pixels. */
	defaultHeight?: number;
	/**
	 * Optional callback invoked after each screenshot is captured.
	 * Called with the raw PNG buffer and MIME type; return value is ignored.
	 * Lets callers collect image data without going through the full agent pipeline
	 * (e.g. in tests that invoke the tool directly by name).
	 */
	attachImage?: (data: Buffer, mimeType: string) => Promise<unknown> | unknown;
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

/** Parameters accepted by a single screenshot invocation. */
export interface ScreenshotParams {
	url: string;
	width?: number;
	height?: number;
	selector?: string;
	fullPage?: boolean;
}

/** Result produced by a single screenshot invocation. */
export interface ScreenshotResult {
	/** Content parts ready for the agent pipeline (Anthropic-style image part + text). */
	content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
	/** Metadata about the capture. */
	details: { url: string; width: number; height: number; selector?: string; fullPage: boolean; bytes: number };
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
 *
 * The returned tool object also exposes a `run(params)` method for direct invocation by name
 * (e.g. from tests or external callers that do `getTool('screenshot').run(params)` without
 * going through the full agent pipeline). If an `attachImage` callback was provided in opts,
 * it is called with the raw PNG buffer and MIME type after each successful capture.
 */
export function createScreenshotTool(opts: ScreenshotToolOptions = {}): AgentTool & { run: (params: ScreenshotParams) => Promise<ScreenshotResult> } {
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
			params: ScreenshotParams,
		): Promise<ScreenshotResult> {
			return captureScreenshot(params, defaultWidth, defaultHeight, opts.attachImage);
		},

		/**
		 * Direct invocation by name — same semantics as execute() but without a toolCallId.
		 * Lets external callers (tests, validators, future missions) do:
		 *   getTool('screenshot').run({ url: '...' })
		 * and receive an image content part plus the PNG buffer in the attachImage callback.
		 */
		async run(params: ScreenshotParams): Promise<ScreenshotResult> {
			return captureScreenshot(params, defaultWidth, defaultHeight, opts.attachImage);
		},
	} as unknown as AgentTool & { run: (params: ScreenshotParams) => Promise<ScreenshotResult> };
}

/**
 * Core screenshot capture logic, shared by execute() and run().
 * Separated so both entry points use identical paths and the browser
 * lifecycle management applies in both cases.
 */
async function captureScreenshot(
	params: ScreenshotParams,
	defaultWidth: number,
	defaultHeight: number,
	attachImage?: ScreenshotToolOptions["attachImage"],
): Promise<ScreenshotResult> {
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

		// Invoke the optional callback so direct callers (tests, validators) get the image
		// without going through the full agent pipeline.
		if (attachImage) {
			await attachImage(pngBuffer, "image/png");
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
		// Unref the browser's OS handles after the context is closed so that scripts
		// invoking the tool directly (validators, tests) exit naturally when done.
		unrefBrowserHandles();
	}
}
