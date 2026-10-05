/**
 * Whether the runner's cost guard can bound a model's output (issue #507), asked from the worker side for doctor. The
 * rule is the runner's (`completionsOwnServer` and `callCostBound`, image/runner/src/usage-meter.mjs): on
 * openai-completions to a host outside the hosts below, only a cap sent as `max_tokens` bounds the output, so a
 * priced model whose composed `compat.maxTokensField` is not `"max_tokens"` is refused at its first call under a
 * dollar cap.
 *
 * COPIED, not imported: the job image ships `image/runner` alone and the worker package ships `src` alone, so neither
 * can import the other (the same reason `FIRST_CALL_OVERHEAD_TOKENS` is a copy in doctor.mjs).
 * `worker/test/output-cap.test.mjs` holds both lists equal to the runner's and the predicate to the runner's verdict.
 * Pure, and it never imports pi: the builtin catalog lookups are handed in.
 */

import { composedCost, endpointsForModel, isZeroCost, modelEntryOf } from "./model-endpoints.mjs";

/** The hosts pi's catalog serves openai-completions on: the runner's `COMPLETIONS_CATALOG_HOSTS`, generated the same way. */
export const COMPLETIONS_CATALOG_HOSTS = Object.freeze([
	"api.ant-ling.com",
	"api.cerebras.ai",
	"api.cloudflare.com",
	"api.deepseek.com",
	"api.fireworks.ai",
	"api.groq.com",
	"api.individual.githubcopilot.com",
	"api.moonshot.ai",
	"api.moonshot.cn",
	"api.together.ai",
	"api.xiaomimimo.com",
	"api.z.ai",
	"gateway.ai.cloudflare.com",
	"inference.baseten.co",
	"integrate.api.nvidia.com",
	"open.bigmodel.cn",
	"opencode.ai",
	"openrouter.ai",
	"router.huggingface.co",
	"token-plan-ams.xiaomimimo.com",
	"token-plan-cn.xiaomimimo.com",
	"token-plan-sgp.xiaomimimo.com",
	"token-plan.ap-southeast-1.maas.aliyuncs.com",
	"token-plan.cn-beijing.maas.aliyuncs.com",
]);

/** The runner's `COMPLETIONS_EXTRA_HOSTS`, copied: api.openai.com reads the field pi sends it. */
export const COMPLETIONS_EXTRA_HOSTS = Object.freeze(["api.openai.com"]);

/** The runner's `completionsOwnServer`, copied: `{ api, baseUrl }` on openai-completions to a host neither list names. */
export function completionsOwnServer(model) {
	if (model?.api !== "openai-completions") return false;
	try {
		const host = new URL(model.baseUrl).hostname;
		return !COMPLETIONS_CATALOG_HOSTS.includes(host) && !COMPLETIONS_EXTRA_HOSTS.includes(host);
	} catch {
		return true;
	}
}

/**
 * The parts of a model the rule reads, composed as the pinned pi's provider-composer.js composes them from the overlay
 * `models.json` (`models`, parsed, or null) and the builtin catalog (`builtinModel(provider, id)`, injected):
 *   - a model the overlay DEFINES: its own `api` and `baseUrl`, else its provider's, else those of pi's DEFAULTS
 *     model (`findModelDefaults`, mirrored in `definedDefaults`); its compat field from its `modelOverrides` entry,
 *     else its own, else its provider's (a defined model takes no builtin compat);
 *   - a BUILTIN model: its own `api`; the provider's `baseUrl` over its own; its compat field from the override, else
 *     the provider's, else the catalog's.
 * The cost is `composedCost`'s. Null when neither the overlay nor the catalog knows the model. `builtinChatModels`
 * (the provider's catalog chat models, injected) feeds the defaults.
 */
export function outputCapView({ models, provider, modelId, builtinModel = () => null, builtinChatModels = () => [] }) {
	const { entry, defined, override } = modelEntryOf(models, provider, modelId);
	const builtin = typeof builtinModel === "function" ? builtinModel(provider, modelId) : null;
	const field = (compat) => (compat !== null && typeof compat === "object" ? compat.maxTokensField : undefined);
	const cost = composedCost({ models, provider, modelId, builtinModel });
	if (defined) {
		const composed = definedDefaults(entry, modelId, typeof builtinChatModels === "function" ? builtinChatModels(provider) : []);
		return {
			api: composed?.api,
			baseUrl: composed?.baseUrl,
			maxTokensField: field(override?.compat) ?? field(defined.compat) ?? field(entry?.compat),
			cost,
		};
	}
	if (builtin && typeof builtin === "object") {
		return {
			api: str(builtin.api),
			baseUrl: str(entry?.baseUrl) ?? str(builtin.baseUrl),
			maxTokensField: field(override?.compat) ?? field(entry?.compat) ?? field(builtin.compat),
			cost,
		};
	}
	return null;
}

const str = (v) => (typeof v === "string" ? v : undefined);

/**
 * The `{ api, baseUrl }` the pinned pi composes for the overlay-defined model `modelId` (provider-composer.js
 * `applyModelsJson`): the provider's chat models start as the catalog's (each on the provider's `baseUrl` when it sets
 * one), and each definition in the file's order is composed and then replaces the model of its id or joins the list.
 * A definition's `api` is its own, else the provider's, else its DEFAULTS model's, and its `baseUrl` likewise, where the
 * defaults are `findModelDefaults` over the list so far: the model of the same id, else one of the definition's api,
 * else the first openai-completions model, else the first. Null when no definition has that id.
 */
function definedDefaults(entry, modelId, catalogChat) {
	const list = (Array.isArray(catalogChat) ? catalogChat : [])
		.filter((m) => m !== null && typeof m === "object" && typeof m.id === "string" && (m.type ?? "chat") === "chat")
		.map((m) => ({ id: m.id, api: str(m.api), baseUrl: str(entry?.baseUrl) ?? str(m.baseUrl) }));
	let found = null;
	for (const d of Array.isArray(entry?.models) ? entry.models : []) {
		if (d === null || typeof d !== "object" || typeof d.id !== "string") continue;
		const wanted = str(d.api) ?? str(entry.api);
		const defaults = list.find((m) => m.id === d.id) ?? (wanted ? list.find((m) => m.api === wanted) : undefined) ?? list.find((m) => m.api === "openai-completions") ?? list[0];
		const composed = { id: d.id, api: wanted ?? defaults?.api, baseUrl: str(d.baseUrl) ?? str(entry.baseUrl) ?? defaults?.baseUrl };
		const at = list.findIndex((m) => m.id === d.id);
		if (at >= 0) list[at] = composed;
		else list.push(composed);
		if (d.id === modelId) found = composed;
	}
	return found;
}

/**
 * Is every priced call on this model refused under a dollar cap for its output cap? True for a view on
 * openai-completions to an own server whose field is not `"max_tokens"`, unless its cost is all zeros (the runner
 * bounds a zero-rated model at 0 before it asks about output). A cost that cannot be told counts as priced.
 */
export function outputUnboundable(view) {
	if (!view || !completionsOwnServer(view)) return false;
	if (view.maxTokensField === "max_tokens") return false;
	return !(view.cost !== null && isZeroCost(view.cost));
}

/**
 * The priced models a declared endpoint serves whose output the runner cannot bound (`outputUnboundable`), as
 * `[{ provider, modelId }]` in the overlay's order: each model the overlay defines, then each builtin chat model of a
 * provider it names (`builtinChatModels`, injected), which takes the provider's `baseUrl`. Only models
 * `endpointsForModel` puts on a declared endpoint.
 */
export function ignoredOutputCapModels({ models, endpoints, builtinModel = () => null, builtinChatModels = () => [] }) {
	const providers = models?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers) || !Array.isArray(endpoints) || endpoints.length === 0) return [];
	const found = [];
	for (const provider of Object.keys(providers)) {
		const { entry } = modelEntryOf(models, provider, "");
		if (entry === null) continue;
		const defined = (Array.isArray(entry.models) ? entry.models : []).filter((m) => m !== null && typeof m === "object" && typeof m.id === "string");
		const listed = typeof builtinChatModels === "function" ? builtinChatModels(provider) : [];
		const builtins = (Array.isArray(listed) ? listed : []).filter((b) => b !== null && typeof b === "object" && typeof b.id === "string" && !defined.some((m) => m.id === b.id));
		for (const modelId of [...defined.map((m) => m.id), ...builtins.map((b) => b.id)]) {
			const lookup = (p, id) => (p === provider ? (builtins.find((b) => b.id === id) ?? (typeof builtinModel === "function" ? builtinModel(p, id) : null)) : null);
			if (!outputUnboundable(outputCapView({ models, provider, modelId, builtinModel: lookup, builtinChatModels }))) continue;
			if (endpointsForModel({ models, provider, modelId, endpoints }).length === 0) continue;
			found.push({ provider, modelId });
		}
	}
	return found;
}
