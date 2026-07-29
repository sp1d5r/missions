/**
 * Serves stored images for a mission.
 *
 * Security model (matches page.tsx session gating):
 *   - Requires an authenticated operator session — anonymous callers get 401.
 *   - The filename is validated against a strict regex before any disk access,
 *     preventing path traversal. The regex matches only content-addressed names
 *     produced by StateStore.attachImage: <sha256hex>.<alphanumext>.
 *   - '..', absolute paths, and any non-matching name are rejected with 400.
 *
 * Content-Type is derived from the file extension using the same mime map as
 * StateStore. Falls back to application/octet-stream for unknown extensions.
 */

import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { record } from "@/lib/data";
import { requireOperator } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Only content-addressed filenames: <sha256hex>.<alphanumext> */
const SAFE_FILENAME = /^[a-f0-9]+\.[a-z0-9]+$/;

const EXT_TO_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	bin: "application/octet-stream",
};

function contentType(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
	const gate = await requireOperator();
	if ("deny" in gate) return gate.deny;

	const { id, file } = await ctx.params;

	// Validate filename before touching disk.
	if (!SAFE_FILENAME.test(file)) {
		return Response.json({ error: "invalid filename" }, { status: 400 });
	}

	const rec = record(id);
	if (!rec) return Response.json({ error: "unknown mission" }, { status: 404 });
	if (!rec.outDir) {
		return Response.json({ error: "this mission has no run directory on disk" }, { status: 409 });
	}

	const filePath = join(rec.outDir, "images", file);

	// Extra paranoia: ensure the resolved path is inside the expected directory.
	// The regex already prevents '..', but defence in depth costs nothing here.
	const expectedDir = join(rec.outDir, "images");
	if (!filePath.startsWith(expectedDir + "/") && filePath !== expectedDir) {
		return Response.json({ error: "invalid filename" }, { status: 400 });
	}

	if (!existsSync(filePath)) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	const nodeStream = createReadStream(filePath);
	const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

	return new Response(webStream, {
		headers: {
			"content-type": contentType(file),
			"cache-control": "public, max-age=31536000, immutable",
		},
	});
}
