import { completeSimple, getEnvApiKey, getModel, type KnownProvider } from "@mariozechner/pi-ai";
import type { ModelSpec } from "./types.js";

/** Single tool-less completion. Mirrors council's completeToolless. */
export async function complete(spec: ModelSpec, systemPrompt: string, userPrompt: string): Promise<{ text: string; costUsd: number }> {
	const model = getModel(spec.provider as KnownProvider, spec.modelId as never);
	if (!model) throw new Error(`Model not found: ${spec.provider}/${spec.modelId}. Check packages/ai/src/models.generated.ts.`);

	const apiKey = getEnvApiKey(spec.provider as KnownProvider);
	const result = await completeSimple(
		model,
		{ systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
		apiKey ? { apiKey } : undefined,
	);

	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("\n")
		.trim();

	return { text, costUsd: result.usage.cost.total };
}

/** Extract a JSON value from a model response (handles ``` fences and surrounding prose). */
export function parseJson<T>(raw: string): T | null {
	let s = raw.trim();
	const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	if (fence?.[1]) s = fence[1].trim();
	// Prefer object, fall back to array.
	const objFirst = s.indexOf("{");
	const objLast = s.lastIndexOf("}");
	const arrFirst = s.indexOf("[");
	const arrLast = s.lastIndexOf("]");
	if (objFirst !== -1 && objLast > objFirst && (arrFirst === -1 || objFirst < arrFirst)) {
		s = s.slice(objFirst, objLast + 1);
	} else if (arrFirst !== -1 && arrLast > arrFirst) {
		s = s.slice(arrFirst, arrLast + 1);
	}
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}
