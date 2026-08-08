/**
 * Headless-browser screenshot tool.
 *
 * Launches Playwright chromium (lazily on first call), captures a PNG of the
 * given URL, and returns it as an Anthropic-style image content part so the
 * existing extractImageParts path in worker.ts picks it up automatically.
 *
 * Registration: add createScreenshotTool() to the tools array in runWorker() in
 * src/worker.ts alongside createCodingTools() and createDelegateTool().
 */

import { type Browser, type BrowserServer } from "playwright";
import { Type, type AgentTool } from "../../pi.js";

// ---------------------------------------------------------------------------
// Lazy browser lifecycle
// ---------------------------------------------------------------------------

let browser: Browser | undefined;
let browserServer: BrowserServer | undefined;
let browserPromise: Promise<Browser> | undefined;

/**
 * Close the browser and BrowserServer, resetting the singleton state so the
 * next call to getBrowser() will start a fresh instance.
 *
 * Exported so callers (tests, validators, end-to-end scripts) can explicitly
 * release browser resources after their last capture, allowing the Node.js
 * event loop to drain without process.exit().
 */
export async function closeBrowser(): Promise<void> {
	const b = browser;
	const s = browserServer;
	browser = undefined;
	browserServer = undefined;
	browserPromise = undefined;
	try {
		await b?.close();
	} catch {
		// ignore
	}
	try {
		await s?.close();
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Module-level SIGINT/SIGTERM handler — registered exactly once.
//
// Calls closeBrowser() if a browser is active, then re-raises the signal so
// the process exits with the correct signal-based exit code. Using
// process.once() here (at module load time) ensures we never accumulate more
// than one listener per signal regardless of how many times getBrowser() is
// called or how many tool instances are created.
// ---------------------------------------------------------------------------
const handleShutdownSignal = async (signal: string) => {
	await closeBrowser();
	process.kill(process.pid, signal);
};

process.once("SIGINT", () => void handleShutdownSignal("SIGINT"));
process.once("SIGTERM", () => void handleShutdownSignal("SIGTERM"));

/**
 * Return the shared browser instance, launching it once on first call.
 *
 * We use chromium.launchServer() rather than chromium.launch() so that we
 * retain a reference to the BrowserServer, which exposes .process() — the
 * only correct way to obtain the chromium ChildProcess without walking the
 * global active-handles list.
 *
 * The BrowserServer child process is unref()ed immediately after launch so
 * that it does not keep the Node.js event loop alive between captures. During
 * an active capture the context / page handles are reffed by Node internally,
 * so the loop stays alive while work is in flight. After the capture context
 * is closed the loop can drain naturally.
 */
async function getBrowser(): Promise<Browser> {
	if (browser) return browser;
	if (browserPromise) return browserPromise;

	browserPromise = (async () => {
		// Dynamic import so the module loads even when playwright is not installed.
		const { chromium } = await import("playwright");
		const server = await chromium.launchServer({ headless: true });
		browserServer = server;

		// Unref the child process so it does not keep the Node.js event loop
		// alive. The process will still be cleaned up correctly on closeBrowser()
		// or when the SIGINT/SIGTERM handler fires.
		try {
			server.process().unref();
		} catch {
			// Older Playwright versions may not expose .process() — ignore.
		}

		const b = await chromium.connect(server.wsEndpoint());
		browser = b;
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
	/**
	 * Optional callback invoked after each screenshot is captured.
	 * Called with the raw PNG buffer and MIME type (buffer first).
	 * Lets callers collect image data without going through the full agent pipeline
	 * (e.g. in tests that invoke the tool directly by name).
	 *
	 * If a context-level attachImage is also provided via the execute/run ctx
	 * argument, only the context-level one is called (ctx wins). This prevents
	 * the same image being attached twice when both callbacks are present.
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
 * Context object passed as the second argument when execute() is called
 * directly (i.e. not from the agent pipeline). Mirrors the worker store API
 * so validators and tests can inject their own attachImage handlers.
 */
export interface ScreenshotExecuteContext {
	/**
	 * Called after each screenshot with (mimeType, buffer).
	 * Note: when using the factory opts `attachImage`, the order is (buffer, mimeType).
	 * The context-based signature matches the worker store interface: (mimeType, buffer).
	 */
	attachImage?: (mimeType: string, data: Buffer) => Promise<unknown> | unknown;
	store?: {
		attachImage?: (mimeType: string, data: Buffer) => Promise<unknown> | unknown;
	};
	/** Ignored – present only for compatibility with the worker context shape. */
	missionId?: string;
	appendEvent?: (...args: unknown[]) => unknown;
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
 * The returned tool object also exposes a `run(params, ctx?)` method for direct invocation by name
 * (e.g. from tests or external callers that do `getTool('screenshot').run(params)` without
 * going through the full agent pipeline). If an `attachImage` callback was provided in opts,
 * it is called with (buffer, mimeType) after each successful capture — unless a ctx.attachImage
 * is also present, in which case only the ctx one is called (deduplication).
 *
 * execute() supports two calling conventions:
 *   1. Agent pipeline:  execute(toolCallId: string, params: ScreenshotParams)
 *   2. Direct call:     execute(params: ScreenshotParams, ctx?: ScreenshotExecuteContext)
 * The distinction is made by checking whether the first argument is a string.
 */
export function createScreenshotTool(opts: ScreenshotToolOptions = {}): AgentTool & {
	run: (params: ScreenshotParams, ctx?: ScreenshotExecuteContext) => Promise<ScreenshotResult>;
	close: () => Promise<void>;
} {
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

		/**
		 * Supports two calling conventions:
		 *   Agent pipeline:  execute(toolCallId: string, params: ScreenshotParams)
		 *   Direct call:     execute(params: ScreenshotParams, ctx?: ScreenshotExecuteContext)
		 */
		async execute(
			toolCallIdOrParams: string | ScreenshotParams,
			paramsOrCtx?: ScreenshotParams | ScreenshotExecuteContext,
		): Promise<ScreenshotResult> {
			let params: ScreenshotParams;
			let ctxAttachImage: ((mimeType: string, data: Buffer) => Promise<unknown> | unknown) | undefined;

			if (typeof toolCallIdOrParams === "string") {
				// Normal agent pipeline call: execute(toolCallId, params)
				params = paramsOrCtx as ScreenshotParams;
			} else {
				// Direct call: execute(params, ctx?)
				params = toolCallIdOrParams;
				const ctx = paramsOrCtx as ScreenshotExecuteContext | undefined;
				ctxAttachImage = ctx?.attachImage ?? ctx?.store?.attachImage;
			}

			return captureScreenshot(params, defaultWidth, defaultHeight, opts.attachImage, ctxAttachImage);
		},

		/**
		 * Direct invocation by name — same semantics as execute() but without a toolCallId.
		 * Lets external callers (tests, validators, future missions) do:
		 *   getTool('screenshot').run({ url: '...' })
		 * and receive an image content part plus the PNG buffer in the attachImage callback.
		 */
		async run(params: ScreenshotParams, ctx?: ScreenshotExecuteContext): Promise<ScreenshotResult> {
			const ctxAttachImage = ctx?.attachImage ?? ctx?.store?.attachImage;
			return captureScreenshot(params, defaultWidth, defaultHeight, opts.attachImage, ctxAttachImage);
		},

		/**
		 * Explicitly close the shared browser, releasing all event-loop handles.
		 * Call this after the last capture when the browser is no longer needed.
		 * The SIGINT/SIGTERM handler also calls this automatically.
		 */
		close: closeBrowser,
	} as unknown as AgentTool & {
		run: (params: ScreenshotParams, ctx?: ScreenshotExecuteContext) => Promise<ScreenshotResult>;
		close: () => Promise<void>;
	};
}

/**
 * Core screenshot capture logic, shared by execute() and run().
 * Separated so both entry points use identical paths and the browser
 * lifecycle management applies in both cases.
 *
 * The browser singleton is NOT closed after each capture — it is reused across
 * subsequent calls for efficiency. The BrowserServer child process is unref()ed
 * at launch time so it does not keep the Node.js event loop alive between
 * captures. Callers that need the process to exit cleanly after their last
 * capture should either:
 *   a) call tool.close() / closeBrowser() explicitly, or
 *   b) use process.exit() (as the worker loop does), or
 *   c) rely on the SIGINT/SIGTERM handler registered at module load time.
 *
 * attachImage deduplication: if ctx provides an attachImage callback, only that
 * one is called. The opts-level callback is only called when no ctx callback is
 * present. This prevents the same image being stored/transmitted twice.
 */
async function captureScreenshot(
	params: ScreenshotParams,
	defaultWidth: number,
	defaultHeight: number,
	/** Factory-level callback: called as (buffer, mimeType). Only used when no ctx callback. */
	optsAttachImage?: ScreenshotToolOptions["attachImage"],
	/** Context-level callback: called as (mimeType, buffer). Takes priority over opts callback. */
	ctxAttachImage?: (mimeType: string, data: Buffer) => Promise<unknown> | unknown,
): Promise<ScreenshotResult> {
	const { url, selector, fullPage = false } = params;
	const width = params.width ?? defaultWidth;
	const height = params.height ?? defaultHeight;

	const b = await getBrowser();

	// Move newContext inside the try block so context.close() runs in finally
	// even if newPage() throws.
	let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
	try {
		context = await b.newContext({
			viewport: { width, height },
		});
		const page = await context.newPage();

		// Use 'load' to ensure all synchronous scripts have run and the initial
		// render is complete. This is important for pages that set background
		// colours or text via inline styles/scripts — domcontentloaded fires too
		// early and can capture a blank or partially-rendered page.
		await page.goto(url, { waitUntil: "load", timeout: 30_000 });

		let pngBuffer: Buffer;
		if (selector) {
			const element = page.locator(selector).first();
			pngBuffer = Buffer.from(await element.screenshot({ type: "png" }));
		} else {
			pngBuffer = Buffer.from(await page.screenshot({ type: "png", fullPage }));
		}

		// Deduplicated attachImage invocation:
		//   - If a context-level callback is provided, use it (ctx wins).
		//   - Otherwise fall back to the factory opts callback.
		// This prevents the same image being attached twice when both are present.
		if (ctxAttachImage) {
			await ctxAttachImage("image/png", pngBuffer);
		} else if (optsAttachImage) {
			await optsAttachImage(pngBuffer, "image/png");
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
		try {
			await context?.close();
		} catch {
			// ignore
		}
		// The browser is intentionally NOT closed here. The singleton is reused
		// across captures. See closeBrowser() and tool.close() for explicit teardown.
	}
}
