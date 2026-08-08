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

import { type Browser } from "playwright";
import { Type, type AgentTool } from "../../pi.js";

// ---------------------------------------------------------------------------
// Lazy browser lifecycle
// ---------------------------------------------------------------------------

let browser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;

/**
 * Handles (Sockets, Servers, etc.) added to the Node.js event loop by the
 * browser launch. We track them so we can unref them after each capture
 * (allowing the process to exit naturally when the caller is done) and ref
 * them again before the next capture (ensuring I/O completes correctly).
 */
let browserHandles: Array<{ ref?: () => void; unref?: () => void }> = [];

/** Ref all browser handles so the event loop stays alive during I/O. */
function refBrowserHandles(): void {
	for (const h of browserHandles) {
		try { h.ref?.(); } catch { /* ignore */ }
	}
}

/** Unref all browser handles so they do not keep the process alive when idle. */
function unrefBrowserHandles(): void {
	for (const h of browserHandles) {
		try { h.unref?.(); } catch { /* ignore */ }
	}
}

/**
 * Close the browser, resetting the singleton state so the next call to
 * getBrowser() will start a fresh instance.
 *
 * Exported so callers (tests, validators, end-to-end scripts) can explicitly
 * release browser resources after their last capture, allowing the Node.js
 * event loop to drain without process.exit().
 */
export async function closeBrowser(): Promise<void> {
	const b = browser;
	browser = undefined;
	browserPromise = undefined;
	browserHandles = [];
	try {
		await b?.close();
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Module-level SIGINT/SIGTERM handler — registered exactly once at import.
//
// Calls closeBrowser() if a browser is active, then re-raises the signal so
// the process exits with the correct signal-based exit code. Using
// process.once() here (at module load time) ensures we never accumulate more
// than one listener per signal regardless of how many times getBrowser() is
// called or how many tool instances are created.
//
// Signal handlers do NOT keep the event loop alive, so registering them at
// module load does not block process exit.
// ---------------------------------------------------------------------------
const handleShutdownSignal = async (signal: string): Promise<void> => {
	await closeBrowser();
	process.kill(process.pid, signal);
};

process.once("SIGINT", () => void handleShutdownSignal("SIGINT"));
process.once("SIGTERM", () => void handleShutdownSignal("SIGTERM"));

/**
 * Return the shared browser instance, launching it once on first call.
 *
 * Uses chromium.launch() directly (rather than launchServer + connect) so
 * there are no WebSocket server/client handles to track — only the CDP pipes
 * and the browser child process.
 *
 * After launch, all new event-loop handles created by the browser are
 * immediately unref()ed so that the Node.js process can exit naturally after
 * the last capture completes. Inside captureScreenshot(), the handles are
 * temporarily ref()ed for the duration of the I/O and then unref()ed again.
 *
 * On rejection, browserPromise is cleared so a retry will re-launch.
 */
async function getBrowser(): Promise<Browser> {
	if (browser) return browser;
	if (browserPromise) return browserPromise;

	const launch = async (): Promise<Browser> => {
		// Dynamic import so the module loads even when playwright is not installed.
		const { chromium } = await import("playwright");

		// Snapshot handles before launch so we can identify the new ones.
		const handlesBefore: unknown[] = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
			._getActiveHandles?.() ?? [];

		const b = await chromium.launch({ headless: true });
		browser = b;

		// Track handles added by the browser launch and immediately unref them.
		// The handles remain functional — they will be re-ref()ed during captures.
		const handlesAfter: Array<{ ref?: () => void; unref?: () => void }> =
			((process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
				._getActiveHandles?.() ?? []) as Array<{ ref?: () => void; unref?: () => void }>;

		browserHandles = handlesAfter.filter(
			(h) => !(handlesBefore as unknown[]).includes(h),
		);
		unrefBrowserHandles();

		return b;
	};

	browserPromise = launch();

	// Clear the promise reference on failure so a retry can re-launch.
	browserPromise.catch(() => {
		browserPromise = undefined;
	});

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
 * The distinction is made by checking whether the first argument is a string AND the second
 * argument is an object with a url field (agent pipeline) vs the first arg being a params object.
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
		 *
		 * When the first argument is a string, it is treated as a toolCallId and the
		 * second argument must be an object with at least a `url` field (ScreenshotParams).
		 * If the second argument is not a valid params object, a clear error is thrown to
		 * prevent silent misrouting (e.g. if someone accidentally passes a URL string as
		 * the first argument).
		 */
		async execute(
			toolCallIdOrParams: string | ScreenshotParams,
			paramsOrCtx?: ScreenshotParams | ScreenshotExecuteContext,
		): Promise<ScreenshotResult> {
			let params: ScreenshotParams;
			let ctxAttachImage: ((mimeType: string, data: Buffer) => Promise<unknown> | unknown) | undefined;

			if (typeof toolCallIdOrParams === "string") {
				// Agent pipeline call: execute(toolCallId, params)
				// Validate that the second argument is a valid ScreenshotParams object.
				if (
					typeof paramsOrCtx !== "object" ||
					paramsOrCtx === null ||
					typeof (paramsOrCtx as ScreenshotParams).url !== "string"
				) {
					throw new TypeError(
						`screenshot tool execute(): when the first argument is a string (toolCallId="${toolCallIdOrParams}"), ` +
						`the second argument must be a ScreenshotParams object with a "url" field. ` +
						`Got: ${JSON.stringify(paramsOrCtx)}`,
					);
				}
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
 *
 * Event-loop lifecycle:
 *   Before any I/O: ref all browser handles so the event loop stays alive.
 *   After context.close() in finally: unref all browser handles so the process
 *   can exit naturally when the caller has no more work to do.
 *
 * This means: if the caller does NOT call closeBrowser() after their last
 * capture, the process will still exit cleanly (the unref-ed handles do not
 * prevent exit). If the caller DOES call closeBrowser(), the browser is
 * terminated and all handles are released immediately.
 *
 * For sequential captures (multiple awaited tool.run() calls), the handles are
 * ref()ed at the start of each capture and unref()ed after. Because the next
 * capture's ref() call happens synchronously in the microtask continuation
 * (before any macrotask can run), the event loop never drains between captures.
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

	// Ref browser handles AFTER getBrowser() returns so they are populated and
	// the I/O for this capture keeps the event loop alive.
	refBrowserHandles();

	let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
	try {
		context = await b.newContext({
			viewport: { width, height },
		});
		const page = await context.newPage();

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
		// Unref browser handles after the capture so they do not prevent the
		// Node.js process from exiting when the caller has no more work to do.
		// The next call to captureScreenshot() will ref them again before I/O.
		unrefBrowserHandles();
	}
}
