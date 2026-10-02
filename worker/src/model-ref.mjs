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
