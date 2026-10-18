/**
 * The bolt between the worker's model-id rule and the console's run-model rule (issue #673).
 *
 * Every source of a run's model is held by the worker to one rule, `modelIdProblem` (`MODEL_REF_PATTERN` on the
 * lowercased value, worker/src/model-ref.mjs): a trigger's `run.model`, `PI_MODEL`, the settings overlay's `model` and
 * `pi-dispatch run --model`. The run record writes whichever won, in its ORIGINAL case. The console's runs filter and
 * `/api/run` judge that field with `RUN_MODEL_RE` (admin/src/run-filter.mjs), and a refusal there hides a run that
 * exists. So every id the worker rule accepts, in the case the worker keeps, must pass `RUN_MODEL_RE`. These tests
 * hold that over the pinned catalog and over ids GENERATED from the worker rule itself, so a change to either side
 * that breaks the relation fails here rather than in an operator's filter.
 *
 * The relation is containment, not equality, on purpose: `RUN_MODEL_RE` also admits `+` and ids up to 128
 * characters, which no worker source can write any more. A mutant that loosens the worker rule INSIDE that margin
 * (allowing `+`) is therefore one this bolt rightly leaves green.
 *
 * The run record's `provider` is bolted the same way (review round 1): every source of it (a trigger's run.provider,
 * `PI_PROVIDER`, the overlay's `provider`) is held to `providerIdProblem`, and `/api/run` judges the field with
 * `RUN_PROVIDER_RE`, so every provider id the worker accepts must pass it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_MODEL_RE, RUN_PROVIDER_RE } from "../src/run-filter.mjs";
import { MODEL_REF_PATTERN, PROVIDER_REF_PATTERN, modelIdProblem, providerIdProblem } from "../../worker/src/model-ref.mjs";

test("every pinned catalog id passes the worker's model rule in its original case, and RUN_MODEL_RE in both cases (#673)", async () => {
  const { listPricedModels } = await import("@edgehero/pi-dispatch/pricing");
  const ids = [...new Set(listPricedModels().map((m) => m.id))];
  assert.ok(ids.length > 1000, `the walk reads the catalog (${ids.length} ids)`);
  assert.ok(ids.some((id) => id !== id.toLowerCase()), "the catalog holds uppercase ids, so the original case is walked");
  assert.ok(ids.some((id) => id.startsWith("@")) && ids.some((id) => id.startsWith("~")), "and the leading @ and ~ ids");
  for (const id of ids) {
    assert.equal(modelIdProblem(id), null, `the worker accepts ${id} as written`);
    assert.ok(MODEL_REF_PATTERN.test(id.toLowerCase()), `MODEL_REF_PATTERN accepts ${id} lowercased`);
    assert.ok(RUN_MODEL_RE.test(id), `RUN_MODEL_RE accepts ${id}`);
    assert.ok(RUN_MODEL_RE.test(id.toLowerCase()), `RUN_MODEL_RE accepts ${id} lowercased`);
  }
});

/**
 * Candidate ids built around every ASCII character and a few non-ASCII ones, at the first position (bare and after
 * a leading `~` or `@`), inside, and at the end, plus lengths at and past both caps. The worker rule decides which
 * are ids; the test asserts only that each one it accepts passes `RUN_MODEL_RE`.
 */
function candidates() {
  const chars = [];
  for (let c = 0; c < 128; c++) chars.push(String.fromCharCode(c));
  chars.push("\u00e9", "\u212a", "\u0130", "\u00a0", "\uff0b");
  const out = [];
  for (const ch of chars) {
    for (const prefix of ["", "~", "@"]) out.push(`${prefix}${ch}b`, `${prefix}a${ch}b`, `${prefix}a${ch}`, `${prefix}${ch}`);
    out.push(`A${ch}Z`, `qwen2.5${ch}0.5B`);
  }
  for (const len of [1, 63, 64, 65, 128, 129, 200]) {
    for (const prefix of ["", "~", "@"]) out.push(`${prefix}${"x".repeat(Math.max(1, len - prefix.length))}`, `${prefix}${"Ab:/._-@9".repeat(30)}`.slice(0, len));
  }
  out.push("@cf/Meta/Llama-3.1-8B-Instruct", "~anthropic/Claude-Sonnet", "workers-ai/@cf/a/b", "Qwen2.5:0.5b-Instruct-q4_K_M");
  return out;
}

test("every id the worker's model rule accepts, generated from that rule, passes RUN_MODEL_RE in the case it is written (#673)", () => {
  const accepted = candidates().filter((id) => modelIdProblem(id) === null);
  // The walk must reach the shapes the relation is about, or a green run proves nothing.
  for (const [what, ok] of [
    ["a 64-character id", accepted.some((id) => id.length === 64)],
    ["a leading @", accepted.some((id) => id.startsWith("@"))],
    ["a leading ~", accepted.some((id) => id.startsWith("~"))],
    ["an uppercase letter", accepted.some((id) => /[A-Z]/.test(id))],
    ...[":", "/", ".", "_", "-", "@"].map((ch) => [`an inner ${ch}`, accepted.some((id) => id.slice(1).includes(ch))]),
  ]) {
    assert.ok(ok, `the generated walk accepts ${what}`);
  }
  for (const id of accepted) assert.ok(RUN_MODEL_RE.test(id), `RUN_MODEL_RE accepts ${JSON.stringify(id)}, which the worker writes`);
  // The bare pattern too, without modelIdProblem's ASCII pre-check: the ledger and an allowed-model entry apply it, and
  // a loosening there must not slip past this bolt behind the pre-check.
  const patterned = candidates().filter((id) => MODEL_REF_PATTERN.test(id));
  assert.ok(patterned.length > 100, `the bare pattern accepts ${patterned.length} candidates`);
  for (const id of patterned) assert.ok(RUN_MODEL_RE.test(id), `RUN_MODEL_RE accepts ${JSON.stringify(id)}, which MODEL_REF_PATTERN accepts`);
});

test("every pinned catalog provider, and every provider id the worker's rule accepts, generated from that rule, passes RUN_PROVIDER_RE (#673)", async () => {
  const { listPricedModels } = await import("@edgehero/pi-dispatch/pricing");
  const catalog = [...new Set(listPricedModels().map((m) => m.provider))];
  assert.ok(catalog.length > 20, `the walk reads the catalog's providers (${catalog.length})`);
  for (const provider of catalog) {
    for (const id of [provider, provider.toLowerCase(), provider.toUpperCase()]) {
      assert.equal(providerIdProblem(id), null, `the worker accepts ${id} as written`);
      assert.ok(PROVIDER_REF_PATTERN.test(id.toLowerCase()), `PROVIDER_REF_PATTERN accepts ${id} lowercased`);
      assert.ok(RUN_PROVIDER_RE.test(id), `RUN_PROVIDER_RE accepts ${id}`);
    }
  }
  const accepted = candidates().filter((id) => providerIdProblem(id) === null);
  for (const [what, ok] of [
    ["a 64-character id", accepted.some((id) => id.length === 64)],
    ["a 1-character id", accepted.some((id) => id.length === 1)],
    ["an uppercase letter", accepted.some((id) => /[A-Z]/.test(id))],
    ["a leading digit", accepted.some((id) => /^[0-9]/.test(id))],
    ...[".", "_", "-"].map((ch) => [`an inner ${ch}`, accepted.some((id) => id.slice(1).includes(ch))]),
    ...[".", "_", "-"].map((ch) => [`a trailing ${ch}`, accepted.some((id) => id.length > 1 && id.endsWith(ch))]),
  ]) {
    assert.ok(ok, `the generated walk accepts ${what}`);
  }
  for (const id of accepted) assert.ok(RUN_PROVIDER_RE.test(id), `RUN_PROVIDER_RE accepts ${JSON.stringify(id)}, which the worker writes`);
  const patterned = candidates().filter((id) => PROVIDER_REF_PATTERN.test(id));
  assert.ok(patterned.length > 50, `the bare pattern accepts ${patterned.length} candidates`);
  for (const id of patterned) assert.ok(RUN_PROVIDER_RE.test(id), `RUN_PROVIDER_RE accepts ${JSON.stringify(id)}, which PROVIDER_REF_PATTERN accepts`);
});
