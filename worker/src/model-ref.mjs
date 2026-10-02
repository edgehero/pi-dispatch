/**
 * The one spelling of "what a model or provider id may look like" in a record (issues #501, #502).
 *
 * PURE and import-free, on purpose: `triggers.mjs` is the shared validator the receiver loads and the admin
 * bundle inlines, and the model-reference checks that land on top of this (a trigger's `run.provider` and
 * `run.model`, an allowed-model list) must be importable there without dragging anything in.
 *
 * Applied AFTER lowercasing, as the run record's ledger always has (`parseExitUsage`), so the pattern never
 * has to admit uppercase.
 *
 * WHY IT WIDENED. The ledger's old pattern, `^[a-z0-9][a-z0-9._:/-]{0,63}$`, refused real catalog ids, and
 * one refused row nulls the whole `usage` block, so a job on such a model recorded no ledger at all. Measured
 * on 2026-10-02 against pi-ai 0.99.1's builtin catalog (`getAllBuiltinModels` over all 42 providers, chat,
 * image and classifier models, 1,589 ids): the old pattern refused 55. Two shapes:
 *   - 37 contain an `@` or start with `~`: `cloudflare-ai-gateway`'s `workers-ai/@cf/...` and openrouter's
 *     `~vendor/model` aliases;
 *   - 18 START with `@`: `cloudflare-workers-ai`'s own `@cf/vendor/model` ids.
 * Ollama tags (`qwen2.5:0.5b-instruct-q4_K_M`) carry `_`, which it refused too. This pattern admits all 1,589
 * builtin ids and every provider id. The longest builtin id is 56 characters, inside the 64 cap.
 *
 * What it still refuses, and why that is kept: a first character (after one optional `~` or `@`) that is
 * not a letter or digit, so `.hidden`, `../etc`, `/abs` and `:x` fail at character one, as before; any
 * character outside the class (space, quote, backslash, control bytes); and anything over 64 characters.
 */
export const MODEL_REF_PATTERN = /^(?=.{1,64}$)[~@]?[a-z0-9][a-z0-9._:/@_-]*$/;

/**
 * A trigger's provider id (issue #502). Narrower than a model id: no `/`, `:` or `@` and no leading `~`.
 * Those characters exist in MODEL ids (`@cf/...`, `openrouter/~...`, Ollama `name:tag`), never in a provider
 * id, and an allowed-model entry (`provider/model`) splits at the first `/`, so a provider carrying one could
 * never be listed. Applied after lowercasing, like `MODEL_REF_PATTERN`.
 */
export const PROVIDER_REF_PATTERN = /^(?=.{1,64}$)[a-z0-9][a-z0-9._-]*$/;
/**
 * Validate the optional `run.provider`, `run.model` and `run.maxTurns` of one trigger (issue #502) and return
 * the fields that were present, so a normalizer can spread them and an absent field stays absent. Shared by
 * the trigger loader and the console, so both refuse with the same words.
 *
 * A model is checked against `MODEL_REF_PATTERN`, the ledger's own pattern, so any model a trigger can name
 * is one whose usage row the host keeps. The original case is what the job runs with, because pi matches
 * model ids case-sensitively; only the CHECK lowercases.
 *
 * Errors name the trigger and the key and never echo the value: an operator-typed id is not secret, but the
 * console renders this message to a model, and a key name is all an operator needs to find the line.
 */
export function validateModelRef(run, at, path) {
	// `configError`'s exact shape (config.mjs), built here rather than imported so this module stays
	// import-free: run-history.mjs imports it too, and must not drag config.mjs's fs and os in with it.
	const configError = (message) => Object.assign(new Error(message), { piDispatchConfig: true });
	const out = {};
	// ASCII is checked on the ORIGINAL before lowercasing, because lowercasing is not closed over ASCII:
	// the Kelvin sign (U+212A) lowercases to a plain `k`, so a lowercase-then-match check alone would pass
	// a homoglyph that then reaches the job verbatim and names a model nobody listed.
	const ascii = (value) => /^[\x21-\x7E]+$/.test(value);
	// NULL IS ABSENT, for all three. Before #502 a hand-written cron entry's `"model": null` loaded and
	// meant the deployment default (the worker fills `job.data ?? overlay ?? env`, and `??` passes over
	// null), so refusing it now would turn a working file into one that refuses to load for no gain.
	if (run?.provider != null) {
		const provider = run.provider;
		if (typeof provider !== "string" || !ascii(provider) || !PROVIDER_REF_PATTERN.test(provider.toLowerCase())) {
			throw configError(`${at}: run.provider must be a provider id of 1 to 64 characters: letters, digits, dot, dash and underscore, starting with a letter or digit: ${path}`);
		}
		out.provider = provider;
	}
	if (run?.model != null) {
		const model = run.model;
		if (typeof model !== "string" || !ascii(model) || !MODEL_REF_PATTERN.test(model.toLowerCase())) {
			throw configError(`${at}: run.model must be a model id of 1 to 64 characters: letters, digits and . _ - : / @, starting with a letter or digit (or ~ or @ then one): ${path}`);
		}
		out.model = model;
	}
	if (run?.maxTurns != null) {
		if (!Number.isSafeInteger(run.maxTurns) || run.maxTurns < 1) {
			throw configError(`${at}: run.maxTurns must be a positive integer: ${path}`);
		}
		out.maxTurns = run.maxTurns;
	}
	return out;
}
