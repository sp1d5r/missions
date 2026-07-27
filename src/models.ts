import { getEnvApiKey, type KnownProvider } from "./pi.js";
import type { ModelRouting, ModelSpec, Provider } from "./types.js";

/**
 * Right model in each seat. Model ids validated against this repo (see packages/council/src/cli.ts):
 * - orchestrator: slow, careful reasoning (Opus)
 * - worker: fast code fluency (Sonnet)
 * - bugSpotter: precise, and a DIFFERENT provider so it isn't blind to the same failure modes.
 */
export const DEFAULT_ROUTING: ModelRouting = {
	orchestrator: { provider: "anthropic", modelId: "claude-opus-4-7" },
	worker: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
	bugSpotter: { provider: "openai", modelId: "gpt-5.4" },
};

/** All-Anthropic fallback when only ANTHROPIC_API_KEY is available. */
export const ANTHROPIC_ONLY_ROUTING: ModelRouting = {
	orchestrator: { provider: "anthropic", modelId: "claude-opus-4-7" },
	worker: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
	bugSpotter: { provider: "anthropic", modelId: "claude-opus-4-7" },
};

export function hasKey(provider: Provider): boolean {
	return Boolean(getEnvApiKey(provider as KnownProvider));
}

/** Pick routing based on which provider keys are actually present. */
export function autoRouting(): ModelRouting {
	if (hasKey("openai")) return DEFAULT_ROUTING;
	return ANTHROPIC_ONLY_ROUTING;
}

export function parseModelSpec(raw: string): ModelSpec {
	const [provider, ...rest] = raw.split(":");
	const modelId = rest.join(":");
	if (!provider || !modelId) throw new Error(`Model must be "provider:modelId", got: ${raw}`);
	if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
		throw new Error(`provider must be anthropic|openai|google, got: ${provider}`);
	}
	return { provider, modelId };
}
