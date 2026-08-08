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
 * Return the shared browser instance, launching it once on first call.
 *
 * We use chromium.launchServer() rather than chromium.launch() so that we
 * retain a reference to the BrowserServer, which exposes .process() — the
 * only correct way to obtain the chromium ChildProcess without walking the
 * global active-handles list.
 */
async function getBrowser(): Promise<Browser> {
	if (browser) return browser;
	if (browserPromise) return browserPromise;

	browserPromise = (async () => {
		// Dynamic import so the module loads even when playwright is not installed.
		const { chromium } = await import("playwright");
		const server = await chromium.launchServer({ headless: true });
		browserServer = server;
		const b = await chromium.connect(server.wsEndpoint());
		browser = b;

		// On SIGINT/SIGTERM: await clean close before exiting so the chromium
		// subprocess is not left as a zombie.
		const handleSignal = async (signal: string) => {
			try {
				await b.close();
			} catch {
				// ignore
			}
			try {
				await server.close();
			} catch {
				// ignore
			}
			browser = undefined;
			browserServer = undefined;
			browserPromise = undefined;
			process.kill(process.pid, signal);
		};
		process.once("SIGINT", () => void handleSignal("SIGINT"));
		process.once("SIGTERM", () => void handleSignal("SIGTERM"));

		return b;
	})();

	return browserPromise;
}

/**
 * Close the browser and BrowserServer, resetting the singleton state so the
 * next call to getBrowser() will start a fresh instance.
 *
 * Closing all handles allows the Node.js event loop to drain naturally after
 * direct tool invocations (tests, validators) without requiring process.exit().
 */
async function closeBrowser(): Promise<void> {
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
 * it is called with (buffer, mimeType) after each successful capture.
 *
 * execute() supports two calling conventions:
 *   1. Agent pipeline:  execute(toolCallId: string, params: ScreenshotParams)
 *   2. Direct call:     execute(params: ScreenshotParams, ctx?: ScreenshotExecuteContext)
 * The distinction is made by checking whether the first argument is a string.
 */
export function createScreenshotTool(opts: ScreenshotToolOptions = {}): AgentTool & {
	run: (params: ScreenshotParams, ctx?: ScreenshotExecuteContext) => Promise<ScreenshotResult>;
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
	} as unknown as AgentTool & {
		run: (params: ScreenshotParams, ctx?: ScreenshotExecuteContext) => Promise<ScreenshotResult>;
	};
}

/**
 * Core screenshot capture logic, shared by execute() and run().
 * Separated so both entry points use identical paths and the browser
 * lifecycle management applies in both cases.
 *
 * After every capture the browser and BrowserServer are closed so that the
 * Node.js event loop can drain naturally when the tool is called directly
 * (tests, validators). The browser is re-launched lazily on the next call.
 * This is safe in the agent worker loop because the process exits via
 * process.exit() when the loop finishes anyway.
 */
async function captureScreenshot(
	params: ScreenshotParams,
	defaultWidth: number,
	defaultHeight: number,
	/** Factory-level callback: called as (buffer, mimeType). */
	optsAttachImage?: ScreenshotToolOptions["attachImage"],
	/** Context-level callback: called as (mimeType, buffer). */
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

		// Invoke the optional callbacks so direct callers (tests, validators) get
		// the image without going through the full agent pipeline.
		if (optsAttachImage) {
			await optsAttachImage(pngBuffer, "image/png");
		}
		if (ctxAttachImage) {
			await ctxAttachImage("image/png", pngBuffer);
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
		// Close the browser after every capture so the Node.js event loop can drain
		// naturally when the tool is invoked directly (tests, validators). The browser
		// is re-launched lazily on the next call. We do NOT call unrefBrowserHandles()
		// here — unreffing the chromium subprocess but not the WebSocket sockets is
		// insufficient to release all event-loop handles, and unreffing stdin/other
		// caller-owned handles would cause premature process exit (see a15).
		await closeBrowser();
	}
}
