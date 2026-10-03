/**
 * Does this model exist (issue #502)? The worker's answer, asked among the free gates before any token mint,
 * clone or reservation, so a typo in a model id costs nothing instead of a paid container that exits 2.
 *
 * Two sources, the two pi itself reads at the 0.99.1 pin:
 *   - the builtin catalog, every provider's chat, image and classifier models (`getAllBuiltinModels`), so a
 *     classifier or image model on an allowed-model list is found too. `getPricedModel` (pricing.mjs) answers
 *     chat models only, which is why this module does not reuse it;
 *   - the overlay `models.json` (`readOverlayModels`, model-endpoints.mjs), whose `providers.<name>.models[].id`
 *     declares a custom model, under a custom provider or a builtin one (an Ollama model under `openai`).
 *
 * Imports only `@earendil-works/pi-ai/providers/all`, which pi-ai's package.json declares side-effect-free. Never
 * the root or `compat`: a lookup must not register providers as a side effect of being asked a question.
 *
 * Matching is EXACT and case-sensitive on both the provider and the id, because that is how pi resolves a model;
 * an id differing only in case is a model pi would not find, and saying "known" would let the job spend a
 * container to learn that.
 *
 * What this cannot see, by design and named in REQ-MODEL-POLICY: a provider an extension registers
 * (`pi.registerProvider`) and a virtual model (`pi.registerVirtualModel`) exist only inside the job. A flow that
 * needs one declares the physical models it routes to in the overlay `models.json`, which this module reads.
 */

import { getAllBuiltinModels, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

let builtinIndex = null;

/**
 * Two `provider -> Set(id)` maps over the builtin catalog, built ONCE per process: `any` (chat, image and classifier
 * models, `getAllBuiltinModels`) and `chat` (`getBuiltinModels`). The catalog is generated data inside the pinned
 * package, so it cannot change while the worker runs; walking ~1,600 ids per job would be work with no answer it
 * could change. `Map`s of own entries, so `__proto__` or `constructor` is never a provider.
 */
function builtins() {
	if (builtinIndex !== null) return builtinIndex;
	const any = new Map();
	const chat = new Map();
	for (const provider of getBuiltinProviders()) {
		any.set(provider, new Set(getAllBuiltinModels(provider).map((m) => m?.id).filter((id) => typeof id === "string")));
		chat.set(provider, new Set(getBuiltinModels(provider).map((m) => m?.id).filter((id) => typeof id === "string")));
	}
	builtinIndex = { any, chat };
	return builtinIndex;
}

/**
 * Is `provider`/`id` a builtin model at the pin? `chatOnly` for a job's MAIN model (PR #536's review): the runner
 * resolves it with `modelRuntime.getModel`, which answers chat models only, so an image or classifier model as the
 * main model passes a catalog-wide check and then exits 2 in a paid container. A LIST entry may be any kind, since a
 * flow may call a classifier or an image model through the registry.
 */
export function isBuiltinModel(provider, id, { chatOnly = false } = {}) {
	if (typeof provider !== "string" || typeof id !== "string") return false;
	return builtins()[chatOnly ? "chat" : "any"].get(provider)?.has(id) === true;
}

/**
 * The builtin catalog's model object for `provider`/`id` (chat, image or classifier), or null (issue #503 part 7). The
 * zero-rated check (`zeroRatedVerdict`, model-endpoints.mjs) reads its `cost` and `type` for a model the overlay does
 * not redefine; that module never imports pi, so this is handed to it. Own entries only, exact match, like the rest.
 */
export function builtinModel(provider, id) {
	if (typeof provider !== "string" || typeof id !== "string") return null;
	if (!getBuiltinProviders().includes(provider)) return null;
	return getAllBuiltinModels(provider).find((m) => m?.id === id) ?? null;
}

/** Does the overlay `models.json` (already parsed, or null) declare `provider`/`id`? Own keys only. */
export function isOverlayModel(overlay, provider, id) {
	return overlayDeclares(overlay, provider, id) && overlayProviderProblem(overlay.providers[provider], provider) === null;
}

/** Does the overlay's entry for `provider` list `id`, whether or not pi would compose it? */
function overlayDeclares(overlay, provider, id) {
	const providers = overlay?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return false;
	if (!Object.hasOwn(providers, provider)) return false;
	const models = providers[provider]?.models;
	return Array.isArray(models) && models.some((m) => m !== null && typeof m === "object" && m.id === id);
}

/**
 * Would pi COMPOSE this overlay provider (PR #536's review)? A file that passes pi's schema can still lose a provider
 * at the next step: pi 0.99.1's `applyModelsJson` and `modelFromJson` (`pi-coding-agent/dist/core/provider-composer.js`)
 * throw for `oauth` with no `baseUrl`, and per model no resolvable `api` or
 * `baseUrl`, or a `contextWindow` or `maxTokens` at or below zero. pi then keeps the provider's BUILTIN models
 * (`ModelRuntime.composeProvider` falls back to the base) and drops every model the overlay added, so such a model
 * does not exist in the job. Mirrored here, the defaults search included: a model's missing `api` or `baseUrl` comes
 * from a chat model already in the provider's list (the same id, else the same api, else an `openai-completions`
 * one, else the first), which starts as the builtin chat models and grows with each overlay model in order. A null
 * return is "composes"; a string names the first rule broken. Held to pi by the differential test in
 * `models-json.test.mjs`, which asks pi's own `ModelRuntime` for every model in its corpus.
 */
export function overlayProviderProblem(config, providerId) {
	if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
	if (config.oauth && !config.baseUrl) return "oauth-without-baseUrl";
	// NOT mirrored: pi's "must specify baseUrl, headers, compat, modelOverrides or models" throw. An entry that sets none
	// of those carries nothing pi could drop (no model, no endpoint, no header), so the provider pi falls back to is the
	// one the entry describes, and refusing its builtin models would be a false refusal. Mirroring it changed no verdict
	// while only overlay models counted (PR #536's review, round 3, mutant H6), and would now refuse wrongly.
	// With `oauth` set, pi's defaults search sees no base models at the pin (measured: a `radius` entry with `oauth` and
	// no `api` loses its custom models to "no api specified" though radius has builtin chat models). Mirrored. Radius
	// itself, pi's OAuth gateway, is otherwise not modelled: its models need an OAuth login, which a job never has.
	const builtinChat = !config.oauth && getBuiltinProviders().includes(providerId) ? getBuiltinModels(providerId) : [];
	// pi keeps a builtin model's own baseUrl under `oauth: "radius"`; that branch is not mirrored, because with `oauth`
	// set the list above is empty (mutant H5 found it dead).
	const models = builtinChat.map((m) => ({ id: m.id, api: m.api, baseUrl: config.baseUrl ?? m.baseUrl }));
	for (const def of config.models ?? []) {
		// Kept for fidelity to pi's defaults search, though at the pin it cannot change a verdict (mutant H8): every
		// builtin chat model has an api and a baseUrl, so whichever default is found supplies both, and only WHICH
		// default is found depends on `wantApi`. It decides once pi gains a builtin model lacking one of them.
		const wantApi = def.api ?? config.api;
		const defaults = models.find((m) => m.id === def.id) ?? (wantApi ? models.find((m) => m.api === wantApi) : undefined) ?? models.find((m) => m.api === "openai-completions") ?? models[0];
		const api = def.api ?? config.api ?? defaults?.api;
		if (!api) return "no-api";
		const baseUrl = def.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
		if (!baseUrl) return "no-baseUrl";
		if (def.contextWindow !== undefined && def.contextWindow <= 0) return "contextWindow";
		if (def.maxTokens !== undefined && def.maxTokens <= 0) return "maxTokens";
		const composed = { id: def.id, api, baseUrl };
		const at = models.findIndex((m) => m.id === def.id);
		if (at >= 0) models[at] = composed;
		else models.push(composed);
	}
	return null;
}

/**
 * Is this model in the catalog or the overlay? `overlay` is the parsed overlay `models.json` or null. (The job gate,
 * `checkModelsKnown`, also refuses a builtin model whose provider entry pi would not compose.)
 */
export function knownModel({ provider, id, overlay = null, chatOnly = false }) {
	return isBuiltinModel(provider, id, { chatOnly }) || isOverlayModel(overlay, provider, id);
}

/**
 * The errnos a read of the overlay `models.json` may fail with and then succeed a moment later (issue #552): a disk or
 * network filesystem error (EIO), a busy resource (EAGAIN), and the process or system out of file handles (EMFILE,
 * ENFILE). An ALLOW-LIST, the other way round from `transient.mjs`: here the harmful direction is the false
 * transient. An errno `readOverlayModels` does not read as absence and this list does not name is a file the operator
 * wrote that pi in the job loads none of (the existence check in image/runner/run-job.mjs, or pi's own
 * read, fails), and a builtin provider the file routes would then go to its public endpoint. So the model gate
 * refuses every job on it.
 */
export const OVERLAY_TRANSIENT_READ_CODES = new Set(["EIO", "EAGAIN", "EMFILE", "ENFILE"]);

/** True when a failed read of the overlay `models.json` with this errno may succeed if asked again. */
export function isTransientOverlayRead(code) {
	return OVERLAY_TRANSIENT_READ_CODES.has(code);
}

/**
 * The gate's question for one job (issue #502): are its main model and every model on its list known? `refs` is
 * `[{ provider, id, main? }]`, main first. `readOverlay` is called AT MOST ONCE per job.
 *
 * A BUILTIN model is judged by the overlay too (PR #536's review, round 3): when its provider has an overlay entry pi
 * would not compose (`overlayProviderProblem`), pi drops that WHOLE entry, its `baseUrl`, `headers`, `apiKey` and
 * `compat` included, and the builtin model then runs against the provider's public endpoint while the operator's
 * file reads as though it routed it. Refused as `overlay-provider-invalid`.
 *
 * A file pi drops WHOLE refuses EVERY job (issue #539, PR #546's review, the simpler rule after its third round). pi
 * drops an overlay that exists and fails to load for any reason (a schema error under one provider, a block comment,
 * a truncated write, a UTF-16 save, an empty file, a directory: all measured against pi 0.99.1's `ModelConfig.load`),
 * and every provider entry goes with it, so `openai: { baseUrl: <proxy> }` stops applying and `openai/gpt-4o` runs
 * against `api.openai.com`. Which providers the broken file meant to route cannot be read from a file that does not
 * load, and three rounds of reading it anyway kept finding cases, so the gate does not try: every main and listed
 * ref, builtin or overlay, is refused (`overlay-unparseable`, or `overlay-is-a-directory`) until the operator fixes
 * the file. Louder than needed for a job whose provider the file never mentions, and safe in direction. An absent
 * file is no overlay, as for pi.
 *
 * A file the worker cannot READ is judged by its errno (issue #552). The job reads it through the same read-only
 * mount, as the worker's own uid on native Linux, and pi in the job loads none of the file (the runner's existence
 * check in image/runner/run-job.mjs, or pi's own read, fails). `readOverlayModels` reads what the job reads as no
 * file as absence (ENOENT, and ELOOP, ENOTDIR or ENAMETOOLONG on the folder's path: no content is lost). Any other errno (EACCES or
 * EPERM on the file or its folder, and any errno nobody listed) is a file the operator wrote and the job loses, so
 * every job is refused (`overlay-unreadable`) until the worker's user can read it. Only the errnos
 * `isTransientOverlayRead` names are retried, and then for EVERY job, builtin ones included: whether the file routes
 * the job's provider cannot be known without reading it. A retried job gets the queue's second attempt, then fails.
 *
 * A `models.json` that is a link of any kind, dangling included (PR #553's review), refuses every job (`overlay-link`):
 * the job's read-only mount does not resolve a link the way the host does, so the host may read the routing while the
 * job runs with no overlay. The file itself is read; the overlay folder may be a link.
 *
 * Returns one of:
 *   - `{ ok: true }`;
 *   - `{ unknown: { provider, id }, why }`: the first unknown ref. `why` is `"not-in-catalog"`,
 *     `"overlay-unparseable"` for every ref when pi would not load the overlay, `"overlay-is-a-directory"` for every
 *     ref when it is a directory (pi fails the same way), `"overlay-unreadable"` for every ref when it cannot be read
 *     for a reason no retry changes, `"overlay-link"` for every ref when `models.json` is a link, or `"overlay-provider-invalid"` when the ref's provider has an overlay entry pi
 *     would not compose, so the operator learns the file is the problem rather than the id;
 *   - `{ fallbackUnlisted: { provider, id }, why: "fallback-unlisted" }`: the job has a list, every ref is known, and
 *     a listed model declares a server-side fallback (`declaredFallbacks`) that is not on the list under its provider;
 *   - `{ unavailable: code }`: the overlay could not be READ for a transient reason (`isTransientOverlayRead`). The
 *     caller retries rather than refusing, because a refusal is permanent and public and the next attempt may read
 *     the file.
 */
export function checkModelsKnown(refs, { readOverlay = () => null } = {}) {
	let overlay = null;
	let overlayRead = false;
	let unavailable = null; // the errno of a transient read, else null
	let unparseable = null; // the `why` when the overlay could not be used, else null
	const load = () => {
		if (overlayRead) return;
		overlayRead = true;
		try {
			overlay = readOverlay();
		} catch (err) {
			// A configError (pi would not load the text, or `models.json` is a link) is the file itself, which no
			// retry changes. An errno is judged by what the job then loads (issue #552): EISDIR is named as a directory
			// (PR #536's review), the few errnos a moment can clear are retried, and every other one, EACCES and any
			// errno nobody listed, is a file the job loads none of, so every job is refused. Fail closed: an unknown
			// errno never lets a job run.
			if (err?.overlayLink === true) unparseable = "overlay-link";
			else if (err?.code === "EISDIR") unparseable = "overlay-is-a-directory";
			else if (isTransientOverlayRead(err?.code)) unavailable = err.code;
			else if (typeof err?.code === "string") unparseable = "overlay-unreadable";
			else if (err?.piDispatchConfig !== true) throw err; // a defect, not a state: never a permanent refusal
			else unparseable = "overlay-unparseable";
			overlay = null;
		}
	};
	for (const ref of refs) {
		load();
		// pi drops the whole file, every provider entry with it: no job runs until it is fixed (see above).
		if (unparseable !== null) return { unknown: { provider: ref.provider, id: ref.id }, why: unparseable };
		// A transient read retries every job (issue #552): the file may route this ref's provider, builtin or not.
		if (unavailable !== null) return { unavailable };
		// The provider's overlay entry, when the file was read and has one: pi drops all of it if it cannot compose it.
		const providers = overlay?.providers;
		const entry = providers !== null && typeof providers === "object" && Object.hasOwn(providers, ref.provider) ? providers[ref.provider] : undefined;
		if (entry !== undefined && overlayProviderProblem(entry, ref.provider) !== null) return { unknown: { provider: ref.provider, id: ref.id }, why: "overlay-provider-invalid" };
		// `main: true` marks the job's main model, which must be a CHAT model (see `isBuiltinModel`). The overlay's
		// models are chat models: pi registers every models.json entry as one.
		if (isBuiltinModel(ref.provider, ref.id, { chatOnly: ref.main === true })) continue;
		if (!isOverlayModel(overlay, ref.provider, ref.id)) return { unknown: { provider: ref.provider, id: ref.id }, why: "not-in-catalog" };
	}
	// A job WITH a list (any ref beyond the main one): every listed model's server-side fallbacks must be listed too.
	const listed = refs.filter((ref) => ref.main !== true);
	if (listed.length > 0) {
		const allowed = new Set(listed.map((ref) => `${ref.provider}\u0000${ref.id}`));
		for (const ref of listed) {
			for (const fallback of declaredFallbacks(ref.provider, ref.id, overlay)) {
				if (!allowed.has(`${ref.provider}\u0000${fallback}`)) return { fallbackUnlisted: { provider: ref.provider, id: ref.id }, why: "fallback-unlisted" };
			}
		}
	}
	return { ok: true };
}

/**
 * The server-side fallback ids a model declares (`compat.allowedFallbackModels`), as pi 0.99.1 composes them
 * (provider-composer.js): the builtin model's own compat, then the overlay provider entry's `compat`, then an
 * overlay model definition's (which replaces the builtin model of that id, with the provider's compat beneath it),
 * then `modelOverrides[id].compat`; each later layer that sets the key replaces it (`mergeCompat` is shallow for it).
 *
 * Why the worker asks (issue #502, PR #538's review): pi sends these ids with EVERY call on the model
 * (anthropic-messages `params.fallbacks`) and the provider may answer with any of them, so the runner's model guard
 * refuses a listed model whose fallbacks are not listed under its provider. In pi's builtin catalog exactly one model
 * declares any, anthropic/claude-fable-5 (claude-opus-4-8 and claude-opus-5). A list naming it alone would pass every
 * free gate and then have every call refused inside a paid container; refused here instead, before any spend. Read
 * for every api, which is stricter than the runner: only anthropic-messages sends fallbacks, and the runner judges them
 * there only. Accepted (PR #538's review, round 3): a list is the operator saying which models may be named, and the
 * refusal says only that the model declares fallbacks not on the list, which is true on every api.
 */
export function declaredFallbacks(provider, id, overlay = null) {
	const fallbackIds = (compat) => (Array.isArray(compat?.allowedFallbackModels) ? compat.allowedFallbackModels.map((entry) => entry?.model) : undefined);
	const has = (compat) => compat !== null && typeof compat === "object" && Object.hasOwn(compat, "allowedFallbackModels");
	let found;
	if (getBuiltinProviders().includes(provider)) {
		const model = getAllBuiltinModels(provider).find((m) => m?.id === id);
		if (model) found = fallbackIds(model.compat);
	}
	const providers = overlay?.providers;
	const entry = providers !== null && typeof providers === "object" && !Array.isArray(providers) && Object.hasOwn(providers, provider) ? providers[provider] : null;
	if (entry !== null && typeof entry === "object") {
		if (has(entry.compat)) found = fallbackIds(entry.compat);
		const definition = Array.isArray(entry.models) ? entry.models.find((m) => m !== null && typeof m === "object" && m.id === id) : undefined;
		if (definition !== undefined) found = has(definition.compat) ? fallbackIds(definition.compat) : has(entry.compat) ? fallbackIds(entry.compat) : undefined;
		const override = entry.modelOverrides !== null && typeof entry.modelOverrides === "object" && Object.hasOwn(entry.modelOverrides, id) ? entry.modelOverrides[id] : null;
		if (has(override?.compat)) found = fallbackIds(override.compat);
	}
	return found ?? [];
}
