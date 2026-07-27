/**
 * The single seam between this harness and the pi packages.
 *
 * Three things changed between pi 0.68 and 0.82 that would otherwise be smeared
 * across every file that talks to a model:
 *
 * 1. `getModel` / `completeSimple` / `getEnvApiKey` / `stream` left the pi-ai
 *    root and now live behind `@earendil-works/pi-ai/compat`. That entrypoint is
 *    explicitly documented as temporary — it goes away with the coding-agent
 *    ModelManager migration — so it is imported HERE and nowhere else. When it
 *    is deleted, this file is the whole diff.
 *
 * 2. `AgentOptions.streamFn` became required. pi-agent-core no longer assumes a
 *    provider catalog, so the host supplies one.
 *
 * 3. `getModel` narrowed to a generated union of built-in providers, which no
 *    longer includes every `KnownProvider` (e.g. "radius"). Rather than spray
 *    `as KnownProvider` casts through the call sites, the cast lives here once,
 *    behind a signature shaped like what this harness actually has: a provider
 *    string and a model id, either of which may not resolve.
 */

import { Agent, setDefaultStreamFn, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, getEnvApiKey, getModel as getModelRaw, stream } from "@earendil-works/pi-ai/compat";

export type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
export type { AssistantMessage, KnownProvider } from "@earendil-works/pi-ai";
export { Agent, completeSimple, getEnvApiKey };
// Re-exported so tool schemas import typebox through the same seam as everything else
// (upstream moved @sinclair/typebox -> typebox between 0.68 and 0.82).
export { Type } from "typebox";

/**
 * The provider-backed stream function, as pi-agent-core wants it.
 *
 * The cast is real but narrow: `stream` takes the provider-level options bag and
 * `StreamFn` declares the simple one. Every field the agent loop actually passes
 * is accepted by `stream` — the incompatibility is that the provider type is an
 * open `Record<string, unknown>` and the simple one is not.
 */
export const streamFn = stream as unknown as StreamFn;

// Installed at module load, so an Agent constructed anywhere gets a working
// default even if a call site forgets to pass one.
setDefaultStreamFn(streamFn);

/**
 * Resolve a model from the built-in catalog.
 *
 * Takes plain strings because that is what a MissionConfig holds; an id the
 * catalog does not know returns undefined rather than throwing, so callers can
 * report which seat was misconfigured.
 */
export function getModel(provider: string, modelId: string): Model<Api> | undefined {
	return getModelRaw(provider as never, modelId as never) as Model<Api> | undefined;
}
