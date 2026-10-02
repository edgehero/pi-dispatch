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
 * Validate the optional `run.provider`, `run.model`, `run.maxTurns` and `run.models` of one trigger (issue #502) and return
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
	// `run.models` (issue #502): the models this trigger's job may call. Null is absent, the rule above.
	if (run?.models != null) {
		const problem = modelListProblem(run.models);
		if (problem !== null) throw configError(`${at}: run.models ${problem}: ${path}`);
		// The main model must be on its own list, refused HERE when the trigger names all three, because the
		// file alone answers it. When the provider or the model comes from the deployment default instead,
		// the worker answers it at job start (`model-not-allowed`, pre-spend).
		if (out.provider !== undefined && out.model !== undefined && !modelOnList(run.models, out.provider, out.model)) {
			throw configError(`${at}: run.models does not list this trigger's own run.provider/run.model, so every job it starts would be refused: ${path}`);
		}
		out.models = [...run.models];
	}
	return out;
}

/** The most entries an allowed-model list may carry (issue #502). Past this a list is a catalog, not a policy. */
export const MAX_ALLOWED_MODELS = 16;

/**
 * One allowed-model entry, `provider/model`, split at the FIRST `/` (issue #502): a provider id carries no `/`
 * while a model id may (`openrouter`'s `vendor/model`, cloudflare's `@cf/vendor/model`). The runner splits the
 * same way (`image/runner/src/config.mjs`). Each half passes the same rule `run.provider` and `run.model` do,
 * ASCII checked before lowercasing for the reason `validateModelRef` gives. Returns `{ provider, model }` in
 * the ORIGINAL case, or `null` when the entry is malformed.
 */
export function splitModelEntry(entry) {
	if (typeof entry !== "string" || !/^[\x21-\x7E]+$/.test(entry)) return null;
	const slash = entry.indexOf("/");
	if (slash <= 0) return null;
	const provider = entry.slice(0, slash);
	const model = entry.slice(slash + 1);
	if (!PROVIDER_REF_PATTERN.test(provider.toLowerCase()) || !MODEL_REF_PATTERN.test(model.toLowerCase())) return null;
	return { provider, model };
}

/**
 * An allowed-model list (issue #502), from a trigger's `run.models` or the deployment's `PI_ALLOWED_MODELS`:
 * the problem as a sentence, or null when the list is good. ONE rule for both sources, so a list an operator
 * moves from a trigger into the env (or back) means the same thing in both places.
 *   - 1 to 16 entries. EMPTY is refused, never read as "unrestricted" or as "nothing allowed": the first fails
 *     open, the second refuses every call of a job whose operator meant something else, and an empty list in a
 *     reviewed file is more likely a template bug than either. Absent (or null) is how a list says "none".
 *   - every entry `provider/model`, see `splitModelEntry`.
 *   - no duplicates, compared CASE-INSENSITIVELY. Matching at the runner is exact, so `openai/GPT-x` beside
 *     `openai/gpt-x` is at best a dead entry and at worst the one that was meant; either way it is a typo the
 *     file should not keep, and the run record's ledger lowercases ids, where the two would be one row.
 * The entry text is never echoed: the position is, and the console renders this message to a model.
 */
export function modelListProblem(list) {
	if (!Array.isArray(list)) return "must be an array of provider/model strings";
	if (list.length === 0) return "must not be empty (leave it out for no restriction)";
	if (list.length > MAX_ALLOWED_MODELS) return `must have at most ${MAX_ALLOWED_MODELS} entries`;
	const seen = new Set();
	for (let i = 0; i < list.length; i++) {
		if (splitModelEntry(list[i]) === null) return `entry ${i + 1} must be provider/model: a provider id, a slash, then a model id (each 1 to 64 characters, no spaces)`;
		const key = list[i].toLowerCase();
		if (seen.has(key)) return `entry ${i + 1} repeats an earlier entry (compared ignoring case)`;
		seen.add(key);
	}
	return null;
}

/**
 * Is `provider/model` on the list? EXACT and case-sensitive, the runner guard's rule, because pi resolves model
 * ids case-sensitively: an entry differing only in case names a model pi would not pick. Both halves are
 * compared, so a list naming `openai/x` does not admit `azure-openai-responses/x`.
 */
export function modelOnList(list, provider, model) {
	if (!Array.isArray(list)) return true;
	return list.some((entry) => {
		const ref = splitModelEntry(entry);
		return ref !== null && ref.provider === provider && ref.model === model;
	});
}
