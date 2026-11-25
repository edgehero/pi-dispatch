/** The failover price verdict shared with operator displays. Looking never reserves or calls a provider. */
import { builtinChatModels, builtinModel, checkModelsKnown } from "./model-catalog.mjs";
import { modelEntryOf } from "./model-endpoints.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { outputCapView, outputUnboundable } from "./output-cap.mjs";

// This copy is pinned to the runner's PRICED_APIS by model-failover.test.mjs. The published worker cannot import
// the image workspace, and a new runner API must not silently become eligible before its free bound is verified.
export const FAILOVER_PRICED_APIS = Object.freeze(["anthropic-messages", "azure-openai-responses", "bedrock-converse-stream", "cloudflare-workers-ai-system-one", "google-generative-ai", "google-vertex", "mistral-conversations", "openai-codex-responses", "openai-completions", "openai-decisions", "openai-responses", "typesafe-system-one"]);
/**
 * Whether the runner's cost bound prices an api, read through the pinned copy above. Every decision feature (a watch
 * rule's `decide`, an answer rule's decision model, the question grouping model) runs under a dollar cap, and inside the
 * container a capped call on any other api is refused as unboundable. So the worker refuses such a decision model
 * before a container starts, where it already resolves the model. pi 1.6.1's `pi-decision` (Radius's decision models)
 * is the first classifier api the bound does not price.
 */
export const runnerPricesApi = (api) => typeof api === "string" && FAILOVER_PRICED_APIS.includes(api);

/** Catalog/overlay composition is shared with the existing output-cap gate, rather than guessed from a URL or id. */
export function failoverModelView(ref, { models = null, lookup = builtinModel } = {}) {
	const split = splitModelEntry(ref);
	if (!split) return null;
	const { provider, model } = split;
	const view = outputCapView({ models, provider, modelId: model, builtinModel: lookup, builtinChatModels });
	const { defined, override } = modelEntryOf(models, provider, model);
	// pi provider-composer.js modelFromJson defaults, held to the pinned artifact by the test.
	const base = defined ? { ...defined, contextWindow: defined.contextWindow ?? 128000, maxTokens: defined.maxTokens ?? 16384 } : lookup(provider, model);
	return view ? { ...view, contextWindow: override?.contextWindow ?? base?.contextWindow, maxTokens: override?.maxTokens ?? base?.maxTokens } : null;
}

export function failoverPriceEligible(view) {
	return Boolean(view && FAILOVER_PRICED_APIS.includes(view.api) && !outputUnboundable(view) && Number.isFinite(view.maxTokens) && view.maxTokens > 0 && ["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(view.cost?.[key]) && view.cost[key] >= 0));
}

export function failoverModelStatus(ref, { models = null, lookup = builtinModel } = {}) {
	const split = splitModelEntry(ref);
	if (!split) return { known: false, priced: false, reason: "model-unknown", api: null };
	const refs = [{ provider: split.provider, id: split.model, main: true }, { provider: split.provider, id: split.model }];
	const known = checkModelsKnown(refs, { readOverlay: () => models });
	const view = failoverModelView(ref, { models, lookup });
	const reason = known.unknown || known.unavailable ? "model-unknown" : known.fallbackUnlisted ? "model-not-allowed" : !failoverPriceEligible(view) ? "model-unpriced" : null;
	return { known: !known.unknown && !known.unavailable, priced: reason === null, reason, api: typeof view?.api === "string" ? view.api : null };
}
