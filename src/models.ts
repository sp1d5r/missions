import { getEnvApiKey, type KnownProvider } from "./pi.js";
import type { ModelRouting, ModelSpec, Provider } from "./types.js";

/**
 * Right model in each seat. Model ids validated against this repo (see packages/council/src/cli.ts):
 * - orchestrator: slow, careful reasoning (Opus)
 * - worker: fast code fluency (Sonnet)
 * - bugSpotter: precise. Ideally a different provider from the worker to avoid shared
 *   blind-spots — but a bug-spotter that can't run at all is strictly worse than one that
 *   shares a provider. Default is all-Anthropic; opt into the cross-provider version by
 *   setting NADINE_CROSS_PROVIDER_BUGSPOTTER=1 and having working OpenAI credits.
 */
export const DEFAULT_ROUTING: ModelRouting = {
	orchestrator: { provider: "anthropic", modelId: "claude-opus-4-7" },
	worker: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
	bugSpotter: { provider: "anthropic", modelId: "claude-opus-4-7" },
};

/** Cross-provider variant: OpenAI reviews Anthropic's diff. Only used when explicitly opted in. */
export const CROSS_PROVIDER_ROUTING: ModelRouting = {
	orchestrator: { provider: "anthropic", modelId: "claude-opus-4-7" },
	worker: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
	bugSpotter: { provider: "openai", modelId: "gpt-5.4" },
};

/** Back-compat alias — the old name for the all-Anthropic routing. */
export const ANTHROPIC_ONLY_ROUTING: ModelRouting = DEFAULT_ROUTING;

export function hasKey(provider: Provider): boolean {
	return Boolean(getEnvApiKey(provider as KnownProvider));
}

/**
 * Pick routing based on which provider keys are actually present AND opted-in. The
 * cross-provider bug-spotter is off by default because a credit-less OpenAI key crashes
 * the whole mission at the validator step — an env var being set does not prove it works.
 */
export function autoRouting(): ModelRouting {
	if (process.env.NADINE_CROSS_PROVIDER_BUGSPOTTER === "1" && hasKey("openai")) return CROSS_PROVIDER_ROUTING;
	return DEFAULT_ROUTING;
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
