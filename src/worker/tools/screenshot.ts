/**
 * Headless-browser screenshot tool.
 *
 * Launches Playwright chromium (lazily on first call), captures a PNG of the
 * given URL, and returns it as an Anthropic-style image content part so the
 * existing extractImageParts path in worker.ts picks it up automatically.
 *
 * Registration: add createScreenshotTool() to the tools array in runWorker() in
 * src/worker.ts alongside createCodingTools() and createDelegateTool().
 *
 * Design invariants (all must hold simultaneously):
 *
 * a5  — ref leak prevention: captureScreenshot acquires a per-capture internal
 *       ref via acquireBrowserRef() ONLY after a successful getBrowser() call,
 *       and always releases it via _releaseInternalRef() in a try/finally block.
 *       _releaseInternalRef() decrements the count but does NOT trigger
 *       closeBrowser(), preserving browser singleton reuse for sequential
 *       captures (a21). If getBrowser() rejects, no ref is acquired and the
 *       finally block skips the release.
 *
 * a5  — spawn reentrance: spawnPatchCount is a counter (not a boolean).
 *       It is incremented before chromium.launch() and decremented in the
 *       finally that follows, regardless of success or failure. The original
 *       spawn is stored once (at count 0→1) and restored only when count
 *       reaches 0 again. This is safe under concurrent launches because the
 *       shared browserPromise means only ONE launch() call ever runs at a time,
 *       but the counter is robust even if that invariant ever relaxes.
 *
 * a22 — single image event: the tool result ALWAYS contains the image part;
 *       worker.ts uses extractImageParts on tool_execution_end as the SOLE
 *       delivery path. opts.attachImage / ctx.attachImage is called only when
 *       the caller explicitly asks for it (e.g. in direct/test invocations),
 *       and runWorker does NOT wire opts.attachImage so there is no duplication.
 *
 * a25 — closeBrowser does NOT touch browserRefCount at all; it only closes
 *       the browser instance. Externally-held refs (acquireBrowserRef) survive
 *       a closeBrowser call unchanged. Per-capture internal refs are always
 *       released by _releaseInternalRef() in captureScreenshot's finally block,
 *       not inside closeBrowser(). After N acquireBrowserRef() + N
 *       releaseBrowserRef() calls, count reaches 0 and the browser closes with
 *       no hidden internal refs remaining.
 *
 * a28 — lazy acquisition: captureScreenshot acquires a ref only inside the
 *       try block that wraps getBrowser(). Workers that never call the
 *       screenshot tool never affect the ref count.
 *
 * a29 — test hook: _testSetLaunchOverride(fn|null) swaps chromium.launch for a
 *       supplied function so tests can simulate launch failures without touching
 *       Playwright internals. Returns the previous override (or null).
 */

import { type Browser } from "playwright";
import { createRequire } from "module";
import { Type, type AgentTool } from "../../pi.js";

// ---------------------------------------------------------------------------
// Lazy browser lifecycle
// ---------------------------------------------------------------------------

let browser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;
let browserLaunchCount = 0;

/** Reference count for concurrent workers sharing the browser singleton. */
let browserRefCount = 0;

/**
 * Counter of concurrent launch() invocations currently holding the spawn patch.
 *
 * Increment before chromium.launch() runs, decrement in the finally block.
 * The original spawn is saved once (when the counter goes 0 → 1) and restored
 * only when the counter returns to 0. This keeps the patch active for the full
 * duration of any overlapping launches without ever saving an already-wrapped
 * spawn as "original".
 *
 * Because getBrowser() sets browserPromise before calling launch(), only one
 * launch() ever executes concurrently in practice — but the counter approach
 * is correct under any concurrency level.
 */
let spawnPatchCount = 0;

/**
 * The original child_process.spawn function saved before patching.
 * Set once when spawnPatchCount goes 0 → 1.
 * Cleared only when spawnPatchCount returns to 0 (all launches finished).
 */
let _savedOriginalSpawn: typeof import("child_process").spawn | undefined;

/**
 * Optional override for chromium.launch injected by tests via
 * _testSetLaunchOverride(). When non-null, this function is called instead of
 * chromium.launch() so tests can simulate launch failures or return a fake
 * browser without touching Playwright internals.
 */
type LaunchOverrideFn = (opts?: { headless?: boolean }) => Promise<Browser>;
let _launchOverride: LaunchOverrideFn | null = null;

/**
 * Install (or remove) a test-only override for chromium.launch().
 *
 * Pass a function to replace chromium.launch; pass null to restore the real
 * Playwright launcher. Returns the previous override (or null if none was set),
 * making the hook idempotent and composable.
 *
 * Example — simulate launch failure:
 *   const prev = _testSetLaunchOverride(() => Promise.reject(new Error("forced fail")));
 *   // … run test …
 *   _testSetLaunchOverride(prev); // restore
 */
export function _testSetLaunchOverride(fn: LaunchOverrideFn | null): LaunchOverrideFn | null {
	const prev = _launchOverride;
	_launchOverride = fn;
	return prev;
}

/**
 * The spawned Playwright browser child process.
 * Tracked so we can unref/ref its handles to let the Node event loop drain
 * naturally when no captures are in-flight, without calling browser.close().
 */
let browserChildProcess: import("child_process").ChildProcess | undefined;

/**
 * Number of screenshot captures currently in-flight.
 * When this drops to 0 we unref the browser process so the event loop can
 * drain; when it rises above 0 we ref it back so the capture can complete.
 */
let captureInFlight = 0;

/**
 * Internal-only ref release: decrements browserRefCount but does NOT trigger
 * closeBrowser(). Used by per-capture try/finally blocks so that captures that
 * complete without external refs still leave the browser open for reuse (the
 * browser only closes when an external releaseBrowserRef() drives count to 0,
 * or when closeBrowser() is called explicitly).
 *
 * This prevents the a21 regression where sequential captures with no external
 * refs would close and relaunch the browser on every call.
 */
function _releaseInternalRef(): void {
	browserRefCount = Math.max(0, browserRefCount - 1);
}

/** Unref the browser child process so Node can exit without b.close(). */
function unrefBrowserChildProcess(): void {
	const proc = browserChildProcess;
	if (!proc || proc.exitCode !== null) return;
	try {
		proc.unref();
	} catch { /* ignore */ }
	for (const stream of (proc.stdio ?? [])) {
		if (!stream) continue;
		try { (stream as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
		try {
			// Socket._handle.unref() is what actually releases the libuv handle.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(stream as any)._handle?.unref?.();
		} catch { /* ignore */ }
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(proc as any)._handle?.unref?.();
	} catch { /* ignore */ }
}

/** Re-ref the browser child process so an in-flight capture keeps Node alive. */
function refBrowserChildProcess(): void {
	const proc = browserChildProcess;
	if (!proc || proc.exitCode !== null) return;
	try {
		proc.ref();
	} catch { /* ignore */ }
	for (const stream of (proc.stdio ?? [])) {
		if (!stream) continue;
		try { (stream as unknown as { ref?: () => void }).ref?.(); } catch { /* ignore */ }
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(stream as any)._handle?.ref?.();
		} catch { /* ignore */ }
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(proc as any)._handle?.ref?.();
	} catch { /* ignore */ }
}

/**
 * Returns how many times the browser was launched in this process.
 * Exposed for testing (a21) to verify browser singleton reuse.
 */
export function getBrowserInstanceCountForTest(): number {
	return browserLaunchCount;
}

/**
 * Returns the current browser reference count.
 * Exposed for testing (a25) to verify the ref-count is not stomped by closeBrowser().
 */
export function getBrowserRefCountForTest(): number {
	return browserRefCount;
}

/**
 * Increment the browser reference count.
 * Call this when a worker starts so the browser is not torn down while
 * sibling workers are still using it.
 *
 * Pair each acquireBrowserRef() with a releaseBrowserRef() in a finally block.
 */
export function acquireBrowserRef(): void {
	browserRefCount++;
}

/**
 * Decrement the browser reference count and close the browser when it reaches 0.
 *
 * This is the concurrent-safe replacement for unconditionally calling
 * closeBrowser() in every worker's finally block. When multiple workers run in
 * parallel they share the same browser singleton; only the last one to finish
 * actually closes the browser.
 *
 * @returns A promise that resolves once the browser has been closed (if this
 *          was the last reference) or immediately (if other workers are still
 *          running).
 */
export async function releaseBrowserRef(): Promise<void> {
	browserRefCount = Math.max(0, browserRefCount - 1);
	if (browserRefCount === 0) {
		await closeBrowser();
	}
}

/**
 * Close the browser, resetting the singleton state so the next call to
 * getBrowser() will start a fresh instance.
 *
 * Exported so callers (tests, validators, end-to-end scripts) can explicitly
 * release browser resources after their last capture, allowing the Node.js
 * event loop to drain without process.exit().
 *
 * IMPORTANT: closeBrowser() does NOT modify browserRefCount at all. It only
 * closes and nulls the browser instance. This preserves the ref counts of
 * concurrent workers that are still in-flight and did not call closeBrowser()
 * themselves. Per-capture refs are managed entirely within captureScreenshot()
 * via acquireBrowserRef() + _releaseInternalRef() in a try/finally.
 */
export async function closeBrowser(): Promise<void> {
	const b = browser;
	browser = undefined;
	browserPromise = undefined;
	// Do NOT touch browserRefCount — per-capture internal refs are released by
	// _releaseInternalRef() in captureScreenshot's finally block, not here.
	try {
		await b?.close();
	} catch {
		// ignore
	}
}

/**
 * Return the shared browser instance, launching it once on first call.
 *
 * Uses chromium.launch() directly (rather than launchServer + connect) so
 * there are no WebSocket server/client handles to track — only the CDP pipes
 * and the browser child process.
 *
 * No module-scope signal handlers are registered. Callers are responsible for
 * calling closeBrowser() during their own shutdown paths.
 *
 * On rejection, browserPromise is cleared so a retry will re-launch.
 *
 * Spawn-patch mechanism:
 *   spawnPatchCount is incremented before chromium.launch() and decremented
 *   in the finally block. The original spawn is saved once (at count 0→1) and
 *   restored only when count returns to 0. This is reentrant-safe: multiple
 *   concurrent launch() calls (should they ever occur) share one patch install,
 *   and the restore happens only when all are done.
 */
async function getBrowser(): Promise<Browser> {
	if (browser) return browser;
	if (browserPromise) return browserPromise;

	const launch = async (): Promise<Browser> => {
		// Dynamic import so the module loads even when playwright is not installed.
		const { chromium } = await import("playwright");

		const _require = createRequire(import.meta.url);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const childProcess = _require("child_process") as typeof import("child_process");

		// Install the spawn patch if this is the first concurrent launch.
		// Save the original spawn exactly once (when count goes 0 → 1) to prevent
		// an already-wrapped spawn from being recorded as "original".
		if (spawnPatchCount === 0) {
			_savedOriginalSpawn = childProcess.spawn;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(childProcess as any).spawn = function (cmd: string, args?: readonly string[], opts?: import("child_process").SpawnOptions) {
				const proc = _savedOriginalSpawn!.call(childProcess, cmd, args as string[], opts ?? {});
				if (typeof cmd === "string" && cmd.includes("chrom")) {
					browserChildProcess = proc;
				}
				return proc;
			};
		}
		// Increment AFTER installing patch (or after confirming patch already active)
		// so the counter accurately reflects in-flight launches.
		spawnPatchCount++;

		let b: Browser;
		try {
			// Use the test override if one is installed, otherwise use real chromium.launch.
			if (_launchOverride !== null) {
				b = await _launchOverride({ headless: true });
			} else {
				b = await chromium.launch({ headless: true });
			}
		} finally {
			// Decrement the in-flight counter. Restore spawn only when it reaches 0
			// (all concurrent launches — if any — have finished). This ensures we
			// never restore spawn while another launch is still in flight.
			spawnPatchCount--;
			if (spawnPatchCount === 0 && _savedOriginalSpawn !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(childProcess as any).spawn = _savedOriginalSpawn;
				_savedOriginalSpawn = undefined;
			}
		}

		// Only set module-level state AFTER a successful launch (b is defined here
		// because we reached past the try/catch in the finally — if launch threw,
		// we never reach this line).
		browser = b;
		browserLaunchCount++;
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
	 *
	 * NOTE: runWorker does NOT wire opts.attachImage — it relies solely on
	 * extractImageParts scanning the tool result on tool_execution_end. This
	 * is the ONE delivery path for the agent pipeline (a22).
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
	 * Called after each screenshot with (data, mimeType) — data (Buffer) first,
	 * mimeType (string) second. This matches the worker store interface:
	 * StateStore.attachImage(data: Buffer, mimeType: string).
	 * Both the ctx and opts signatures use the same order to prevent confusion.
	 */
	attachImage?: (data: Buffer, mimeType: string) => Promise<unknown> | unknown;
	store?: {
		attachImage?: (data: Buffer, mimeType: string) => Promise<unknown> | unknown;
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
		 */
		async execute(
			toolCallIdOrParams: string | ScreenshotParams,
			paramsOrCtx?: ScreenshotParams | ScreenshotExecuteContext,
		): Promise<ScreenshotResult> {
			let params: ScreenshotParams;
			let ctxAttachImage: ((data: Buffer, mimeType: string) => Promise<unknown> | unknown) | undefined;

			if (typeof toolCallIdOrParams === "string") {
				// Agent pipeline call: execute(toolCallId, params)
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
				// Agent pipeline: DO NOT wire ctxAttachImage.
				// The image part in the returned result is the sole delivery path;
				// extractImageParts in worker.ts handles it on tool_execution_end.
				ctxAttachImage = undefined;
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
		 */
		async run(params: ScreenshotParams, ctx?: ScreenshotExecuteContext): Promise<ScreenshotResult> {
			const ctxAttachImage = ctx?.attachImage ?? ctx?.store?.attachImage;
			return captureScreenshot(params, defaultWidth, defaultHeight, opts.attachImage, ctxAttachImage);
		},

		/**
		 * Explicitly close the shared browser, releasing all event-loop handles.
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
 * Browser ref acquisition (a5 strict discipline):
 *   The session ref is acquired INSIDE the try block, AFTER a successful
 *   getBrowser() call. This ensures that if getBrowser() rejects, no ref
 *   is held and the finally block does not need to release anything.
 *   A local flag `sessionRefAcquiredThisCall` tracks whether THIS invocation
 *   was the one that set captureSessionRefHeld, so the finally block can
 *   handle the edge case where getBrowser throws before the ref is acquired.
 *
 * Image delivery (a22):
 *   The tool result ALWAYS contains the image part (base64 in the content
 *   array). This is the primary delivery path when called from the agent
 *   pipeline — worker.ts's extractImageParts picks it up on tool_execution_end.
 *   opts.attachImage / ctxAttachImage are supplementary callbacks for direct
 *   invocations (tests, validators). runWorker does not set opts.attachImage.
 *
 * attachImage deduplication (a18):
 *   If ctxAttachImage is provided, it wins over opts.attachImage. Only one
 *   callback is invoked per capture.
 */
async function captureScreenshot(
	params: ScreenshotParams,
	defaultWidth: number,
	defaultHeight: number,
	/** Factory-level callback: called as (data, mimeType). Only used when no ctx callback. */
	optsAttachImage?: ScreenshotToolOptions["attachImage"],
	/** Context-level callback: called as (data, mimeType). Takes priority over opts callback. */
	ctxAttachImage?: (data: Buffer, mimeType: string) => Promise<unknown> | unknown,
): Promise<ScreenshotResult> {
	const { url, selector, fullPage = false } = params;
	const width = params.width ?? defaultWidth;
	const height = params.height ?? defaultHeight;

	// Track whether this call acquired an internal ref. Set to true ONLY after
	// a successful getBrowser() call. If getBrowser() rejects, this stays false
	// and the finally block skips releasing a ref (since none was acquired).
	let internalRefAcquiredThisCapture = false;

	// Re-ref the browser child process before starting the capture so the event
	// loop stays alive for the duration of the async operation.
	captureInFlight++;
	refBrowserChildProcess(); // no-op if browserChildProcess not yet set

	let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
	let result: ScreenshotResult;
	try {
		const b = await getBrowser();

		// getBrowser() succeeded. Acquire an internal per-capture ref so this
		// capture keeps the browser alive for its duration. This ref is released
		// in the finally block via _releaseInternalRef() (which does NOT trigger
		// auto-close, preserving singleton reuse for sequential captures).
		acquireBrowserRef();
		internalRefAcquiredThisCapture = true;

		// Re-ref after getBrowser() in case the browser was just launched and
		// browserChildProcess was set for the first time during this call.
		refBrowserChildProcess();

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
			await ctxAttachImage(pngBuffer, "image/png");
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

		result = {
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

		// Release the internal per-capture ref if one was acquired. This uses
		// _releaseInternalRef() (not releaseBrowserRef()) so it does NOT trigger
		// closeBrowser() when count hits 0 — preserving singleton reuse for
		// sequential captures (a21) and letting external refs control lifetime.
		// If getBrowser() threw before we reached acquireBrowserRef(), this flag
		// is still false and we skip the release (no ref was acquired).
		if (internalRefAcquiredThisCapture) {
			_releaseInternalRef();
		}

		// Decrement the in-flight count. When it reaches 0, unref the browser
		// child process so the Node.js event loop can drain naturally.
		captureInFlight = Math.max(0, captureInFlight - 1);
		if (captureInFlight === 0) {
			unrefBrowserChildProcess();
		}
	}

	// Suppress TS "used before assigned" — result is always set if we reach here
	// (the only exit without setting result is a throw, which bypasses this line).
	return result!;
}
