/**
 * The spend screen's what-if estimate (REQ-COST-ANALYTICS): "what would this flow cost per run on model X?", asked with
 * a GET form on `/insights` (`?whatif=<provider>/<model>&flow=<flow>`). It replaced `/dispatch insights whatif`, whose
 * text answer it keeps word for word (`renderWhatIf`): a READ, for every signed-in role, so it is a query and never an
 * action (an action is a write behind a ticket; this changes nothing).
 *
 * PURE. The scan, the pricing façade and the clock are handed in; the console's CLI binds them (`cli.mjs`), and the
 * tests hand fakes. The estimate itself is `costs.mjs`'s `whatIfFlow`, the fold the old command called, so the console
 * cannot answer a different number for the same records.
 *
 * BOUNDED, because a viewer chooses the key. The record scan is `scanRunRecords` at its own 92-day ceiling (no display
 * window: the estimate wants every ledgered run of the flow it can see, the old command's rule), read once per
 * `WHATIF_LIMITS.ttlMs` for EVERY key, so asking fifty models costs one walk of the logs directory, not fifty. An
 * unknown model is answered from the catalog alone (the closest priced ids) and never scans. Answers are kept per
 * (model, flow, scan window) for the same time, at most `WHATIF_LIMITS.answers` of them, the oldest dropped first, so a
 * client walking the catalog cannot grow the console's memory.
 */
import { whatIfFlow } from "../costs.mjs";
import { RUN_MODEL_RE } from "../run-filter.mjs";

export const WHATIF_LIMITS = Object.freeze({ ttlMs: 30_000, answers: 64, near: 3, models: 4000 });

/** The scan window the estimate reads, named so the cache key says it (the scan's own ceiling, `scanRunRecords`). */
export const WHATIF_SCAN_WINDOW = "92d";

/**
 * A what-if target as the form takes it: `<provider>/<model>`, split on the FIRST `/` (a model id can hold one, an
 * OpenRouter id does; a provider never does). The provider is a catalog provider name, the model id the runs filter's
 * model rule (`RUN_MODEL_RE`, built in here so the two cannot drift, issue #668), which admits one leading `@` or `~`:
 * the priced catalog holds both (Cloudflare's `@cf/meta/...`, OpenRouter's `~anthropic/...-latest` aliases), and a rule
 * that refused them would offer ids in the datalist that the same form then answers 400 for. Every id the pinned
 * catalog prices passes, a test walks it. Neither character means anything in HTML, and the form's links carry the
 * target through URLSearchParams.
 */
export const WHATIF_MODEL_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\/${RUN_MODEL_RE.source.slice(1)}`);

/** `"provider/id"` as `{ provider, id }`, or null for a string that is not one. */
export function splitTarget(text) {
  if (typeof text !== "string" || !WHATIF_MODEL_RE.test(text)) return null;
  const at = text.indexOf("/");
  return { provider: text.slice(0, at), id: text.slice(at + 1) };
}

/** The priced catalog as sorted, distinct `provider/id` strings, at most `WHATIF_LIMITS.models` (the form's datalist). */
export function pricedModelIds(pricing) {
  let list;
  try {
    list = pricing?.listPricedModels?.();
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const m of list) {
    const text = typeof m?.provider === "string" && typeof m?.id === "string" ? `${m.provider}/${m.id}` : null;
    if (text !== null && WHATIF_MODEL_RE.test(text)) out.add(text);
  }
  return [...out].sort().slice(0, WHATIF_LIMITS.models);
}

/**
 * The closest priced ids to an unknown target: the old command's cheap contains filter over the catalog (either id
 * holds the other, case-insensitive), the first `WHATIF_LIMITS.near`, as `provider/id` strings. That answer IS the
 * long-tail model picker: no interactive filter exists.
 */
export function closestPricedIds(pricing, id) {
  let list;
  try {
    list = pricing?.listPricedModels?.();
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const needle = String(id).toLowerCase();
  return list
    .filter((m) => typeof m?.id === "string" && typeof m?.provider === "string")
    .filter((m) => m.id.toLowerCase().includes(needle) || needle.includes(m.id.toLowerCase()))
    .slice(0, WHATIF_LIMITS.near)
    .map((m) => `${m.provider}/${m.id}`)
    .filter((t) => WHATIF_MODEL_RE.test(t));
}

/**
 * One answer for `{ model, flow }` (already checked by `parsePageQuery`) over `records` (a scan's array, or its
 * `{ unreachable }`): `{ model, flow, unknown: true, near }` for a model the tables cannot price, `{ model, flow,
 * unreachable }` for a scan that failed, else `{ model, flow, result }` (`whatIfFlow`'s estimate or seeded band).
 * `records` may be a function, called only for a priced model, so an unknown one never scans.
 */
export function whatIfAnswer({ model, flow, pricing, records }) {
  const target = splitTarget(model);
  if (target === null) return { model, flow, invalid: true };
  if (pricing.getPricedModel(target.provider, target.id) === null) return { model, flow, unknown: true, near: closestPricedIds(pricing, target.id) };
  const got = typeof records === "function" ? records() : records;
  if (!Array.isArray(got)) return { model, flow, unreachable: typeof got?.unreachable === "string" ? got.unreachable : "the run records could not be read" };
  return { model, flow, result: whatIfFlow({ records: got, flow, target, pricing }) };
}

/**
 * The console's what-if reader: `({ model, flow }) => Promise<answer>`, cached per (model, flow, scan window) for
 * `ttlMs` on `now`, at most `max` answers, over ONE record scan per `ttlMs` shared by every key. `scan()` returns
 * `scanRunRecords`' result. A scan that fails is not kept, so the next question tries again.
 */
export function makeWhatIfReader({ pricing, scan, now = () => Date.now(), ttlMs = WHATIF_LIMITS.ttlMs, max = WHATIF_LIMITS.answers }) {
  let held = null;
  const records = () => {
    const t = now();
    if (held && t >= held.at && t - held.at < ttlMs) return held.value;
    const value = scan();
    held = Array.isArray(value) ? { at: t, value } : null;
    return value;
  };
  const answers = new Map();
  return async ({ model, flow }) => {
    const key = `${model}\n${flow}\n${WHATIF_SCAN_WINDOW}`;
    const t = now();
    const hit = answers.get(key);
    if (hit && t >= hit.at && t - hit.at < ttlMs) return hit.value;
    answers.delete(key);
    const value = whatIfAnswer({ model, flow, pricing, records });
    if (value.unreachable === undefined) {
      answers.set(key, { at: t, value });
      // A Map iterates in insertion order, and a re-asked key was deleted above, so the first key is the oldest.
      while (answers.size > max) answers.delete(answers.keys().next().value);
    }
    return value;
  };
}
