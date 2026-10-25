/**
 * The pre-confirm half of every write the `/dispatch` panel and the pi extension's tools make (issue #642): build the
 * change, judge it with the worker's own validators, and say what the confirm will show. Nothing here writes.
 *
 * PI-FREE ON PURPOSE. The operator console (`admin/src/console/`) is a separate process that never loads pi, and it must
 * refuse with the SAME words the tools and the commands use, or an operator sees two rules for one file. These lived in
 * `index.ts`, which imports pi and typebox, so the console could not reach them; a copy in the console would have been
 * the hand-written restatement this repository refuses (AGENTS.md, "derived or pinned, never trusted"). So they moved
 * here, `index.ts` imports them back, and `admin/test/write-plans.test.mjs` walks this module's imports to keep pi and
 * typebox out of it.
 *
 * THE SHAPE. Each `plan*` function returns one of:
 *   - `{ refusal }`: the exact sentence the tool throws (or, for `surface: "command"`, the exact line `/dispatch` shows),
 *     with nothing asked and nothing written;
 *   - `{ unchanged }` (the envelope only): the change is already what the file says;
 *   - `{ plan }`: `{ title, message, summary, ... }`, where `title` and `message` are the confirm dialog's (byte for byte
 *     what the tool shows), `summary` is `message` split into lines, and the rest is what the write takes: `mutate` for
 *     the read-model funnel, `target` (the file), and `expect` (the files as the plan was built from them, the
 *     `writeInputs` snapshot the funnel re-checks before its rename).
 *
 * A caller runs the plan, shows `title`/`message`, and on approval calls the read-model funnel with `mutate` and
 * `expect`. The funnel's own parser still decides: a plan that passes here can still be refused at the write when the
 * file changed in between.
 */
import * as nodeFs from "node:fs";
import { parseBackendList } from "@edgehero/pi-dispatch/backends";
import { delimitedList } from "@edgehero/pi-dispatch/config";
import { withinRoots } from "@edgehero/pi-dispatch/secret-profiles";
import { ISSUE_ACTIONS, isMcpNearMiss, recoverVenueProblem, runModelFieldNearMiss, validateModelRef, validateProgressFlags, validateRecoverFlag, validateSteerFlag } from "@edgehero/pi-dispatch/triggers";
import { DOLLAR_SETTING_KEYS, formatMicros, parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { modelIdProblem, providerIdProblem } from "@edgehero/pi-dispatch/model-ref";
import { SIZE_LIMIT_FIELDS, USD_LIMIT_FIELDS } from "@edgehero/pi-dispatch/scoped-limits";
import { formatCpus, formatMemory, parseCpus, parseMemory } from "@edgehero/pi-dispatch/job-size";
import {
  BUNDLE_FORMATS,
  KNOWN_KEYS,
  blankSettingsFile,
  envelopeJobCap,
  envelopeRefusal,
  mergedDollarProblem,
  overlayInvalidRefusal,
  planEnvelopeWrite,
  planProjectsWrite,
  readPauseWindows,
  readProjects,
  readScopedLimits,
  readSettingsView,
  readTriggers,
  realPathOrNull,
  renderBundleProfiles,
  resolverRootsStatus,
  settingShown,
  triggerVenue,
  writeInputs,
  writeScopedLimits,
} from "./read-model.mjs";
import { escapeInterpreted } from "./panel.mjs";
import { sizeBits } from "./render.mjs";

// ---- small field readers, shared by the dialogs and the tools ----

/** Split a space-separated dialog answer into trimmed, non-empty words (label/action lists). */
export function splitWords(s) {
  return String(s ?? "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** Normalise a labels/action field to a trimmed non-empty string list, accepting an array or a string. */
export function asWords(x) {
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean);
  return splitWords(x);
}

/** A trimmed non-empty string, or undefined (so a blank optional field drops out of the written JSON). */
export function optStr(x) {
  const s = String(x ?? "").trim();
  return s === "" ? undefined : s;
}

/** A finite number from a string/number, or undefined when blank/absent/non-numeric. */
export function optInt(x) {
  if (x === undefined || x === null || String(x).trim() === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/** A plan's confirm: the title, the message, and the message as lines. */
function confirmOf(title, message) {
  return { title, message, summary: message.split("\n") };
}

/** A validator that throws, as a refusal: its own message, so the tool that re-throws it says the same words. */
function refusalOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

// ---- triggers ----

// The per-forge issue close word (issue #231), the tool's default `action` for kind "issue": the
// shared validator's ISSUE_ACTIONS accepts exactly one word per forge today, so defaulting to it
// makes the kind authorable without knowing three forges' spellings. No azure entry on purpose --
// the validator refuses the whole type there with its own message (a work item's close is a state
// transition the projected payload subset cannot see), and a default here would only reword it.
export const ISSUE_CLOSE_WORD = Object.fromEntries(
  Object.entries(ISSUE_ACTIONS).map(([forge, actions]) => [forge, [...actions][0]]),
);

/**
 * Which backends this deployment blessed, answered by the WORKER'S OWN parser.
 *
 * An earlier version reimplemented the comma split here and justified it by saying `backends.mjs` was not
 * in this bundle. It already is: `index.ts` imports `read-model.mjs`, which reaches `triggers.mjs`, which
 * imports `backends.mjs` -- and the built `dist/index.mjs` contains `BACKENDS_TABLE`. So the duplicate
 * bought nothing and cost the two things a duplicate always costs. It did not dedupe, and it returned `[]`
 * for an unset variable while the worker returns `["local"]`, so on the DEFAULT deployment the picker told
 * an operator "this deployment blesses no backends" about a deployment that blesses one and would have run
 * the trigger fine.
 *
 * Falls back to `[]` only when the value cannot be parsed at all. `parseBackendList` throws on an unknown
 * name, which is the worker refusing to boot -- the panel is not the place to relitigate that, and an empty
 * list makes the picker refuse every name, which is the safe direction while the deployment is broken.
 */
export function blessedBackends(env) {
  try {
    return parseBackendList(env.PI_BACKENDS);
  } catch {
    return [];
  }
}

/**
 * Why `backend` cannot be named on a trigger here, or null (#227). REFUSED UNDER AN EMPTY SET rather than passed
 * through: a deployment that blesses nothing has no venue to name, so a picker that accepted a name here would author a
 * trigger the worker refuses pre-spend on every delivery -- a file that reads as chosen and never runs. Checked per call
 * rather than as a schema enum because a schema is frozen at registration while PI_BACKENDS is read per call.
 */
export function backendRefusal(backend, env) {
  const blessed = blessedBackends(env);
  if (blessed.length === 0) return "this deployment blesses no backends, so run.backend cannot be set (see PI_BACKENDS)";
  if (!blessed.includes(backend)) return `backend '${backend}' is not blessed by this deployment (PI_BACKENDS: ${blessed.join(", ")})`;
  return null;
}

/**
 * Why `run.recover` cannot be armed on a trigger whose jobs run in `backend` (its explicit `run.backend`), or, naming
 * none, in the deployment default `PI_BACKENDS[0]` read from `env`; or null (issue #712). The worker's own sentence
 * (`recoverVenueProblem`). The loader refuses the explicit pairing at the write too; the default one only the processor
 * can (the file does not know PI_BACKENDS), before spend on every delivery, so it is refused here, before the confirm.
 */
export function recoverVenueRefusal({ recover, backend, env }) {
  if (recover !== true) return null;
  const venue = triggerVenue(backend, env);
  return venue === null ? null : recoverVenueProblem(venue);
}

/** The #644 flags, #645's `recover` and #646's `steer` a tool call carries, each only when it is a boolean (see buildTriggerEntry). */
function progressRun(f) {
  return {
    ...(typeof f.progress === "boolean" ? { progress: f.progress } : {}),
    ...(typeof f.statusComment === "boolean" ? { statusComment: f.statusComment } : {}),
    ...(typeof f.recover === "boolean" ? { recover: f.recover } : {}),
    ...(typeof f.steer === "boolean" ? { steer: f.steer } : {}),
  };
}

/**
 * The loader's own refusal of the #644 flags, #645's `recover` and #646's `steer` as sent (a non-boolean, a status
 * comment or a recovery on cron, a recovery or steering beside a command), or null. `command` is the entry's own: the
 * add tool writes none, and the edit tool passes the trigger's, so a recovery or steering armed onto a command trigger
 * is refused before the confirm.
 */
function progressRefusal(params, onType, at, path, command = undefined) {
  return (
    refusalOf(() => validateProgressFlags({ progress: params.progress, statusComment: params.statusComment }, at, path, { onType })) ??
    refusalOf(() => validateRecoverFlag({ recover: params.recover, ...(command !== undefined ? { command } : {}) }, at, path, { onType })) ??
    refusalOf(() => validateSteerFlag({ steer: params.steer, ...(command !== undefined ? { command } : {}) }, at, path))
  );
}

/**
 * Build one `{ on, run }` trigger entry from a kind + fields. The single source of truth for the on x run
 * matrix (cron -> local, every webhook kind -> a forge): the impossible combination is absent by
 * construction, mirroring the worker's load-time matrix. Shared by the add-trigger dialog and the
 * `dispatch_trigger_add` tool, so both produce identical shapes. `labels`/`action` accept either an array
 * (tool params) or a space-separated string (dialog input) via `asWords`. Returns null for an unknown kind.
 *
 * `f.forge` selects which forge a webhook trigger listens to, defaulting to github so every existing call
 * site -- and every existing entry this rewrites -- is unchanged. It is offered on BOTH paths, unlike
 * `run.image`, and the difference is deliberate: an image is a capability the model would gain (choose the
 * container and you choose the pi version, the guardrail floor and the loader posture), whereas a forge is
 * one it already has -- a model that can add a github trigger can already arm a paid run, and naming
 * gitlab instead does not widen that. Both remain gated by the same operator confirm.
 *
 * An unrecognised forge is passed through rather than corrected, so `parseTriggers` refuses it fail-loud at
 * the write. Silently rewriting a typo to github would arm a trigger on a forge the operator did not name.
 *
 * `run.resume` is deliberately on NEITHER path, following `run.image` rather than `f.forge`, and the test
 * is the one that separates those two: is it a capability the model would GAIN? A forge is not -- a model
 * that can add a github trigger can already arm a paid run, and naming gitlab does not widen that. Resume
 * is. Arming it creates a channel in which the agent's own output persists to host disk and is replayed
 * into a later job on the same branch, so a model able to set it could arrange for its own reasoning to
 * reach a future run. That is a self-influence channel, and it is not one an operator confirm on a single
 * dialog meaningfully bounds -- the confirm approves one entry, the channel outlives it.
 * Enabling it stays an edit to the reviewed `triggers.json` (`docs/sessions.md`), which is the same answer
 * `run.image` gets and for a stricter version of the same reason. The panel still DISPLAYS it, because
 * reading a disclosure and being able to arm one are different things.
 *
 * `run.progress` and `run.statusComment` (issue #644) ARE on both paths, and pass the same test the other way. Neither
 * is a capability the model would gain: progress offers the job a tool that records a phase name in the transcript and
 * does nothing else, and the status comment is fixed worker text (ids and integers, never model text) on the item the
 * trigger already acts on. Each is carried only when it is a boolean, `once`'s rule, so an entry that names neither is
 * byte-identical; `statusComment` on cron is passed through for the shared validator to refuse.
 *
 * `run.recover` (issue #645) is on both paths too, and the resume test is the one it passes the other way. Resume is
 * refused here because the agent's output is replayed into a LATER run, a channel that outlives the entry the operator
 * approved. A recovery replays a run's checkpoint only into that same run's own continuation, after the worker lost it:
 * the run that wrote the checkpoint is the one that reads it, and nothing reaches the next delivery. Carried only when
 * it is a boolean, the rule above; `true` on cron is passed through for the shared validator to refuse.
 *
 * `run.steer` (issue #646) is on both paths, cron included, and passes the resume test the same way. What it arms is a
 * channel INTO one running job, from an operator of this deployment (and, once comment routing lands, from a person the
 * trigger phrase already lets start that job), framed as data; nothing the agent writes travels through it, and it
 * closes with the run. Carried only when it is a boolean; `true` beside a command is refused by the shared validator.
 */
export function buildTriggerEntry(kind, f) {
  if (kind === "cron") {
    // Optional per-entry provider/model/maxTurns pass through to job.data (highest precedence); omitted when
    // blank so the value still resolves against the settings overlay/env at job start. Since #502 every
    // kind carries them (`modelRun` below); this arm keeps its own spelling so the cron entry's key order
    // is byte-identical to what it always wrote.
    const run = { kind: "local", folder: f.folder, flow: f.flow, task: f.task };
    const model = optStr(f.model);
    const provider = optStr(f.provider);
    const maxTurns = optInt(f.maxTurns);
    if (model) run.model = model;
    if (provider) run.provider = provider;
    if (maxTurns !== undefined) run.maxTurns = maxTurns;
    // #227, carried only when set so every pre-#227 call site writes a byte-identical entry.
    const backend = optStr(f.backend);
    if (backend) run.backend = backend;
    Object.assign(run, progressRun(f));
    return { on: { type: "cron", id: f.id, pattern: f.pattern }, run };
  }
  const forge = optStr(f.forge) ?? "github";
  // `run.repository` is required on an azure label/comment trigger and REFUSED on every other forge's, so
  // it is carried only when set and `parseTriggers` decides whether it belongs. Passing it through rather
  // than validating here keeps one validator, exactly as an unrecognised forge is passed through to be
  // refused fail-loud at the write instead of silently rewritten to github.
  const repository = optStr(f.repository);
  const backend = optStr(f.backend);
  // #502. The tool's schema has always offered model/provider/maxTurns on every kind, and before #502 a
  // webhook arm dropped them in silence: the operator approved an entry without the model they asked for.
  // Carried only when set, so an entry that names none is byte-identical; parseTriggers validates them.
  const model = optStr(f.model);
  const provider = optStr(f.provider);
  const maxTurns = optInt(f.maxTurns);
  const modelRun = { ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}), ...progressRun(f) };
  const forgeRun = (rest) => ({ kind: forge, ...rest, ...(repository ? { repository } : {}), ...(backend ? { backend } : {}), ...modelRun });
  if (kind === "label") return { on: { type: "label", any: asWords(f.labels ?? f.any) }, run: forgeRun({ flow: f.flow }) };
  if (kind === "comment") return { on: { type: "comment", phrase: f.phrase }, run: forgeRun({ flow: f.flow }) };
  if (kind === "pull_request") {
    const on = { type: "pull_request", action: asWords(f.action) };
    const any = asWords(f.labels ?? f.any);
    if (any.length > 0) on.any = any;
    // The close-trigger narrowings (issue #231), carried only when set so every pre-#231 call site
    // writes byte-identical entries. Passed through rather than gated on the action word: the shared
    // validator refuses number/once on a non-close rule with a message naming why, and pre-judging
    // that here would be the silent-rewrite posture this function already rejects for `forge`.
    const prNumber = optInt(f.number);
    if (prNumber !== undefined) on.number = prNumber;
    if (typeof f.once === "boolean") on.once = f.once;
    // `forgeRun` is not used on this arm (it builds `on` itself), so the venue is carried explicitly.
    // Without this the picker VALIDATED a name and then discarded it, and the confirm dialog rendered
    // an entry with no `backend` for the operator to approve -- a pick accepted and dropped in silence.
    return { on, run: { kind: forge, flow: f.flow, ...(backend ? { backend } : {}), ...modelRun } };
  }
  if (kind === "issue") {
    // The close-trigger kind (issue #231). `action` DEFAULTS to this forge's close word -- the only
    // word the shared validator accepts today -- so the kind is authorable without knowing three
    // forges' spellings; an explicit word still passes through verbatim to be refused fail-loud if
    // wrong. `number`/`once` ride only when set, mirroring the loader's absent-not-undefined shape;
    // every constraint between them (once requires number, once excludes replicas, azure has no
    // close trigger at all) lives in the one validator the write goes through.
    const action = asWords(f.action);
    const on = { type: "issue", action: action.length > 0 ? action : [ISSUE_CLOSE_WORD[forge] ?? "closed"] };
    const number = optInt(f.number);
    if (number !== undefined) on.number = number;
    if (typeof f.once === "boolean") on.once = f.once;
    // `forgeRun` is not used on this arm (it builds `on` itself), so the venue is carried explicitly.
    // Without this the picker VALIDATED a name and then discarded it, and the confirm dialog rendered
    // an entry with no `backend` for the operator to approve -- a pick accepted and dropped in silence.
    return { on, run: { kind: forge, flow: f.flow, ...(backend ? { backend } : {}), ...modelRun } };
  }
  return null;
}

/**
 * The trigger fields NO tool may set (issue #501, part 7): `run.maxCostUsd` (a trigger's per-job dollar cap),
 * `run.models` (the models its jobs may call) and `run.mcp` (the MCP servers they connect, below). Each one decides
 * what a trigger's jobs can spend or reach, and removing or widening it is a widening, so it is written by hand in the
 * reviewed triggers file and never by a model's call, even behind a confirm. Neither tool's schema names them, and
 * that alone is not the guard: a schema does not refuse extra keys, and a field silently dropped would let the model
 * report a narrowing that never landed. So a call that carries one is REFUSED, loudly, before any confirm, and so is
 * a NEAR MISS of any of them (`MaxCostUsd`, `max_cost_usd`, `allowedModels`, a homoglyph), at the top level and
 * under a `run` or `on` object the model may have nested: the loader's own sweeps (`runModelFieldNearMiss`, and
 * `mcpFieldNearMiss` below), so the console and the loader agree on what a near miss is. An existing value is never
 * touched: the add tool builds entries without these keys and the edit tool spreads the entry's own `run` under the
 * fields it sets.
 */
const TOOL_PROOF_FIELDS = new Set(["run.maxCostUsd", "run.models", "run.mcp"]);
/**
 * `run.mcp` (REQ-MCP-OPERATOR-SERVERS) is tool-proof for the same reason: which outside systems a trigger's jobs act
 * on, with which credentials, is the operator's to write. Its near misses are the loader's own (`isMcpNearMiss`: the
 * ASCII spellings, and a key outside plain ASCII with no plain letter but the field's), and the field itself counts
 * here too, since this sweep refuses the field and its spellings alike.
 */
function mcpFieldNearMiss(key) {
  return key === "mcp" || isMcpNearMiss(key) ? "run.mcp" : null;
}

/** The refusal for a call that carries a tool-proof field or a near miss of one (see `TOOL_PROOF_FIELDS`), or null. */
export function wideningFieldRefusal(params, tool) {
  const bundle = secretBundleFieldRefusal(params, tool);
  if (bundle !== null) return bundle;
  const objects = [["", params], ["run.", params?.run], ["on.", params?.on]];
  for (const [label, source] of objects) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of Object.keys(source)) {
      const meant = runModelFieldNearMiss(key) ?? mcpFieldNearMiss(key);
      if (meant === null || !TOOL_PROOF_FIELDS.has(meant)) continue;
      const what =
        meant === "run.models" ? "allowed-model list" : meant === "run.mcp" ? "list of MCP servers" : "per-job dollar cap";
      return `${tool} cannot set ${meant} (sent as ${label}${key}): a trigger's ${what} is set by hand in the triggers file, never by a tool`;
    }
  }
  return null;
}

/**
 * `run.secretBundle` (issue #704) is tool-proof in BOTH directions. Its `false` is the only thing that keeps a trigger's
 * jobs out of their project's secret bundle, so a model that could remove it, or set `true` beside a `false` someone
 * wrote, would hand a model-written task every variable of the project. So no tool call may carry it at all, under any
 * spelling the sweep below folds (case, `_`, `-`, a trailing `s`), at the top level or under `run`/`on`; the add tool
 * writes `false` itself (`planTriggerAdd`), and the edit tool spreads the entry's own `run`, so an existing value
 * survives every edit untouched.
 */
function secretBundleFieldRefusal(params, tool) {
  for (const [label, source] of [["", params], ["run.", params?.run], ["on.", params?.on]]) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of Object.keys(source)) {
      if (!/^secretbundles?$/.test(key.toLowerCase().replace(/[_\-. ]/g, ""))) continue;
      return `${tool} cannot set run.secretBundle (sent as ${label}${key}): whether a trigger's jobs hold their project's secret bundle is set by hand in the triggers file, never by a tool. A trigger a tool adds always carries "secretBundle": false`;
    }
  }
  return null;
}

/** `wideningFieldRefusal` as a throw, for a caller that refuses by throwing. */
export function refuseWideningFields(params, tool) {
  const refusal = wideningFieldRefusal(params, tool);
  if (refusal !== null) throw new Error(refusal);
}

/** The current triggers as a display list (empty on a missing/invalid file), for index resolution + confirm text. */
export function triggerList(paths, fs = nodeFs) {
  const t = readTriggers({ triggersPath: paths.triggersPath, fs });
  return Array.isArray(t?.triggers) ? t.triggers : [];
}

/**
 * Plan a trigger add (`dispatch_trigger_add`): the widening fields, the blessed backend, the model reference (the
 * loader's own `validateModelRef`), then the entry from `buildTriggerEntry`. `env` is where PI_BACKENDS is read.
 * `{ plan: { entry, mutate, target, expect, title, message, summary } }` or `{ refusal }`.
 */
export function planTriggerAdd({ params, paths, env, tool = "dispatch_trigger_add", surface = "tool", fs = nodeFs }) {
  const widening = wideningFieldRefusal(params, tool);
  if (widening !== null) return { refusal: widening };
  if (params.backend !== undefined) {
    const venue = backendRefusal(params.backend, env);
    if (venue !== null) return { refusal: venue };
  }
  // #502, the edit tool's rule: a malformed provider, model or turn limit is refused with the loader's own
  // message BEFORE the operator is asked, rather than after they approved an entry the write then refuses.
  const model = refusalOf(() => validateModelRef({ provider: optStr(params.provider), model: optStr(params.model), maxTurns: params.maxTurns }, "the new trigger", paths.triggersPath));
  if (model !== null) return { refusal: model };
  // #644, the same rule: a non-boolean flag, or a status comment on a cron trigger, is refused with the loader's message.
  // #645's `recover` rides the same check (refused on cron), and so does #646's `steer` (legal on cron); the add tool
  // writes no `command`, so none is passed.
  const progress = progressRefusal(params, params.kind, "the new trigger", paths.triggersPath);
  if (progress !== null) return { refusal: progress };
  const recoverVenue = recoverVenueRefusal({ recover: params.recover, backend: optStr(params.backend), env });
  if (recoverVenue !== null) return { refusal: recoverVenue };
  const built = buildTriggerEntry(params.kind, params);
  if (!built) return { refusal: `unknown trigger kind '${params.kind}' (cron|label|comment|pull_request|issue)` };
  // Issue #704: a trigger a MODEL-CALLABLE tool writes is kept out of its project's secret bundle. Its task text (cron)
  // or its flow is the model's choice, and a bundle is the project's whole environment, granted to the triggers the
  // operator reviewed; an operator confirm on one entry does not review what that entry's jobs would hold. The
  // operator removes the flag by hand in triggers.json when they mean it (docs/secrets.md). `surface: "console"` is
  // the operator-typed console form, a person writing the entry, which keeps the entry as built, as the dialogs do.
  const entry = surface === "tool" ? { ...built, run: { ...built.run, secretBundle: false } } : built;
  return {
    plan: {
      entry,
      mutate: (list) => [...list, entry],
      target: paths.triggersPath,
      expect: writeInputs({ paths: [paths.triggersPath], fs }),
      ...confirmOf(`Add ${params.kind} trigger`, `Add to triggers.json:\n${JSON.stringify(entry)}`),
    },
  };
}

/**
 * Plan a trigger edit (`dispatch_trigger_edit`): which flow trigger `index` runs, and optionally its `backend`,
 * `provider` and `model`, each merged only when sent so an edit of the flow leaves every other key byte-identical.
 * The model reference is judged alone and then MERGED with the entry's own `run` (PR #536's review), before the
 * confirm. `progress` and `statusComment` (issue #644) merge the same way, and so does `recover` (issue #645), judged
 * against the entry's own `run.command` as well as its type. `{ plan: { index, flow, backend, ref, flags, mutate, target, expect, title, message, summary } }` or `{ refusal }`.
 */
export function planTriggerEdit({ params, paths, env, tool = "dispatch_trigger_edit", fs = nodeFs }) {
  const widening = wideningFieldRefusal(params, tool);
  if (widening !== null) return { refusal: widening };
  const expect = writeInputs({ paths: [paths.triggersPath], fs });
  const list = triggerList(paths, fs);
  const cur = list[params.index];
  if (!cur) return { refusal: `no trigger at index ${params.index} (have ${list.length})` };
  const flow = String(params.flow ?? "").trim();
  if (!flow) return { refusal: "flow must be non-empty" };
  // #227, the same allowlist the add applies and for the same reason: the picker bounds what an operator
  // can choose, and the worker bounds what actually runs (DES-PER-TRIGGER-SECRET-PROFILE -- the overlay
  // is not the reviewed artifact).
  const backend = optStr(params.backend);
  if (backend !== undefined) {
    const venue = backendRefusal(backend, env);
    if (venue !== null) return { refusal: venue };
  }
  const venue = backend === undefined ? "" : `, backend: ${cur.backend ?? "-"} -> ${backend}`;
  // #502. Blank means "not sent", optStr's rule for backend above. A sent value goes through the
  // worker's validator, the one parseTriggers runs at the write, so a malformed id is refused here
  // with the loader's own message instead of after the operator approved it.
  let ref;
  const alone = refusalOf(() => {
    ref = validateModelRef({ provider: optStr(params.provider), model: optStr(params.model) }, `trigger #${params.index + 1}`, paths.triggersPath);
  });
  if (alone !== null) return { refusal: alone };
  // The display record carries no provider for a forge trigger, so the before half reads the raw
  // entry; a file that cannot be read shows "-" and the write itself decides.
  const rawRun = (() => {
    try {
      return JSON.parse(String(fs.readFileSync(paths.triggersPath, "utf8")))?.triggers?.[params.index]?.run ?? {};
    } catch {
      return {};
    }
  })();
  // #502 (PR #536's review): the MERGED run, before the confirm. A new provider or model checked alone passes, and
  // only the write's parse would then find it off the trigger's own `run.models`, after the operator approved it.
  const merged = refusalOf(() => validateModelRef({ ...rawRun, ...ref }, `trigger #${params.index + 1}`, paths.triggersPath));
  if (merged !== null) return { refusal: merged };
  const modelLine = ["provider", "model"].filter((k) => ref[k] !== undefined).map((k) => `, ${k}: ${rawRun[k] ?? "-"} -> ${ref[k]}`).join("");
  // #644. Merged only when sent, like backend; judged against the entry's own on.type (no status comment on cron).
  const progressFault = progressRefusal(params, cur.type, `trigger #${params.index + 1}`, paths.triggersPath, rawRun.command);
  if (progressFault !== null) return { refusal: progressFault };
  // Issue #712: judged only when this edit sends `recover` or a venue, against the entry as it would be after it, so an
  // edit of the flow alone is not refused over a pairing the operator did not touch (the processor refuses that one per
  // delivery, by name, as before).
  if (typeof params.recover === "boolean" || backend !== undefined) {
    const recoverVenue = recoverVenueRefusal({ recover: typeof params.recover === "boolean" ? params.recover : rawRun.recover, backend: backend ?? rawRun.backend, env });
    if (recoverVenue !== null) return { refusal: recoverVenue };
  }
  const flags = progressRun(params);
  const flagLine = Object.keys(flags).map((k) => `, ${k}: ${rawRun[k] ?? "-"} -> ${flags[k]}`).join("");
  const index = params.index;
  return {
    plan: {
      index,
      flow,
      backend,
      ref,
      // `backend`, `provider` and `model` are merged only when the caller sent them, so an edit that
      // changes just the flow leaves the entry byte-identical in every other key -- including a venue
      // or a model it already had.
      flags,
      mutate: (raw) => raw.map((tr, i) => (i === index ? { ...tr, run: { ...tr.run, flow, ...(backend !== undefined && { backend }), ...ref, ...flags } } : tr)),
      target: paths.triggersPath,
      expect,
      ...confirmOf(`Edit trigger #${index + 1}`, `trigger #${index + 1} (${cur.type}) flow: ${cur.flow ?? "-"} -> ${flow}${venue}${modelLine}${flagLine}`),
    },
  };
}

/** Plan a trigger delete (`dispatch_trigger_delete`) by index. `{ plan: { index, mutate, ... } }` or `{ refusal }`. */
export function planTriggerDelete({ index, paths, fs = nodeFs }) {
  const expect = writeInputs({ paths: [paths.triggersPath], fs });
  const list = triggerList(paths, fs);
  const cur = list[index];
  if (!cur) return { refusal: `no trigger at index ${index} (have ${list.length})` };
  return {
    plan: {
      index,
      mutate: (raw) => raw.filter((_, i) => i !== index),
      target: paths.triggersPath,
      expect,
      ...confirmOf(`Delete trigger #${index + 1}`, `Remove trigger #${index + 1}: ${cur.type} -> ${cur.flow ?? "-"}`),
    },
  };
}

// ---- settings ----

/**
 * Coerce a raw token to the settings value its key expects: `model`, `provider` and the four dollar keys keep
 * the raw string; every other overlay key is numeric and parses via `Number` (a non-numeric token becomes `NaN`, which
 * `writeOverlay` then rejects with a key-only reason). Keying off the string exceptions rather than an
 * enumerated numeric list keeps this in lockstep with `KNOWN_KEYS` -- a new numeric knob (weekly/monthly
 * caps, the token caps) is coerced without a second edit here. Bounds and integer-ness stay in
 * `writeOverlay`, the single validator.
 */
export function coerceSettingValue(key, raw) {
  if (key === "model" || key === "provider") return raw;
  // Issue #501: a dollar key keeps the operator's text, because the overlay stores it AS WRITTEN and
  // `Number` would quietly widen the money grammar (`1e3` and `0x10` become plain dollars, `2.50` loses its
  // zero). `writeOverlay`'s `parseUsdMicros` is then the one judge of the exact string that was typed. The
  // worker's own list, never a guess from the name.
  if (DOLLAR_SETTING_KEYS.includes(key)) return raw;
  return Number(raw);
}

/**
 * A settings write of `key` that would leave the allocation envelope invalid (the per-job cap removed, or set to
 * something the worker cannot read), or null. Only `maxCostUsd` can: it is the one setting the envelope is judged by.
 */
export function settingsEnvelopeRefusal(key, beforeOverlay, afterOverlay, paths, env) {
  if (key !== "maxCostUsd" || !paths.envelopeFile) return null;
  return envelopeRefusal({
    envelopeFile: paths.envelopeFile,
    projectsPath: paths.projectsFile,
    scopedLimitsPath: paths.scopedLimitsPath,
    maxCostMicros: envelopeJobCap({ settingsFile: paths.settingsFile, env, overlay: beforeOverlay }),
    next: { maxCostMicros: envelopeJobCap({ settingsFile: paths.settingsFile, env, overlay: afterOverlay }) },
  });
}

/**
 * A `model` or `provider` value the worker's `writeOverlay` would refuse, as the sentence it refuses with (`model must
 * be a model id of ...`), else null (issue #673, review round 1). The worker's own rule (`modelIdProblem`,
 * `providerIdProblem`, worker/src/model-ref.mjs), asked BEFORE the confirm, the dollar keys' rule: the operator is never
 * asked to approve a value the write would then refuse. The same words `validateOverlay` builds, so a refusal reads
 * the same at plan time as it would at the write. Never the value.
 */
function idSettingProblem(key, value) {
  if (key === "model") {
    const problem = modelIdProblem(value);
    return problem === null ? null : `${key} ${problem}`;
  }
  if (key === "provider") {
    const problem = providerIdProblem(value);
    return problem === null ? null : `${key} ${problem}`;
  }
  return null;
}

/**
 * The tool's settings plan (`dispatch_set`): a `value` that is absent or blank unsets `key`. Refused BEFORE the confirm
 * over an invalid file (issue #501; a BLANK file, issue #540, reads as a missing one, `writeSettings`' rule), over a
 * dollar value the worker's parser refuses, over a model or provider id outside the worker's shape (issue #673), and over a change that would break the allocation envelope (issue #504 part
 * C). A dollar change that leaves a window uncapped is WARNED in the confirm, never refused (`mergedDollarProblem`).
 */
function planSettingTool({ key, value, paths, env, shown, fs }) {
  if (!KNOWN_KEYS.includes(key)) return { refusal: `unknown key '${key}'. valid keys: ${KNOWN_KEYS.join(", ")}` };
  const view = readSettingsView({ settingsFile: paths.settingsFile, fs });
  if (view?.invalid && !blankSettingsFile(paths.settingsFile, fs)) return { refusal: `rejected: ${overlayInvalidRefusal(view.invalid)}` };
  const unset = value === undefined || value === null || String(value).trim() === "";
  const newVal = unset ? undefined : coerceSettingValue(key, String(value).trim());
  const isDollarKey = DOLLAR_SETTING_KEYS.includes(key);
  // Issue #501, part 7: a dollar value is judged by the worker's own parser BEFORE the confirm, so the operator is
  // never asked to approve a value the write would then refuse (the edit tools' rule). The message names the key.
  if (!unset && isDollarKey) {
    const dollar = refusalOf(() => parseUsdMicros(newVal, key));
    if (dollar !== null) return { refusal: dollar };
  }
  // Issue #673, review round 1: a model or provider id by the worker's own rule, before the confirm, for the same reason.
  const idProblem = unset ? null : idSettingProblem(key, newVal);
  if (idProblem !== null) return { refusal: `rejected: ${idProblem}` };
  // The AFTER side of an unset is what the key falls back to, by the same rule as the before side.
  const afterOverlay = unset ? Object.fromEntries(Object.entries(view?.overlay ?? {}).filter(([k]) => k !== key)) : { ...(view?.overlay ?? {}), [key]: newVal };
  const after = unset ? settingShown(key, afterOverlay, env, shown) : String(newVal);
  const problem = isDollarKey ? mergedDollarProblem(afterOverlay, env, shown) : null;
  const broken = settingsEnvelopeRefusal(key, view?.overlay ?? {}, afterOverlay, paths, env);
  if (broken) return { refusal: `rejected: ${escapeInterpreted(broken)}` };
  return {
    plan: {
      key,
      unset,
      value: unset ? null : newVal,
      mutate: unset ? (o) => { delete o[key]; return o; } : (o) => ({ ...o, [key]: newVal }),
      writeArgs: {},
      warning: problem?.warning ?? null,
      target: paths.settingsFile,
      expect: writeInputs({ paths: [paths.settingsFile], fs }),
      ...confirmOf(unset ? `Unset ${key}` : `Set ${key}`, `${key}: ${settingShown(key, view?.overlay, env, shown)} -> ${after}${problem?.warning ? `\n\nWarning: ${problem.warning}` : ""}`),
    },
  };
}

/**
 * The operator-typed command's settings plan (`/dispatch set|unset`): the key must be known (checked BEFORE the write,
 * since `writeOverlay` silently drops unknown keys and would report ok on a no-op), a set takes exactly one value
 * token (model ids carry no spaces), a model or provider id outside the worker's shape is refused (issue #673), and a
 * change that would break the allocation envelope is refused. Every refusal
 * is the line the command shows, prefixed with its verb. A dollar key's write carries the deployment's env so
 * `writeSettings` returns a WARNING beside the write, never a refusal (issue #501, PR #542's review).
 */
function planSettingCommand({ verb, key, valueTokens, paths, env, shown, fs }) {
  if (!KNOWN_KEYS.includes(key)) return { refusal: `${verb}: unknown key '${key}'. valid keys: ${KNOWN_KEYS.join(", ")}` };
  let value;
  let mutate;
  if (verb === "set") {
    if (!Array.isArray(valueTokens) || valueTokens.length !== 1) return { refusal: `set: ${key} takes exactly one value` };
    value = coerceSettingValue(key, valueTokens[0]);
    // Issue #673, review round 1: a model or provider id by the worker's own rule, before anything is written (the
    // panel dialog comes through here too), in the words the write would refuse with.
    const idProblem = idSettingProblem(key, value);
    if (idProblem !== null) return { refusal: `set: ${idProblem}` };
    mutate = (o) => ({ ...o, [key]: value });
  } else {
    mutate = (o) => {
      delete o[key];
      return o;
    };
  }
  if (key === "maxCostUsd") {
    const before = readSettingsView({ settingsFile: paths.settingsFile, fs })?.overlay ?? {};
    const broken = settingsEnvelopeRefusal(key, before, mutate({ ...before }), paths, env);
    if (broken) return { refusal: `${verb}: ${broken}` };
  }
  const writeArgs = DOLLAR_SETTING_KEYS.includes(key) ? { dollarEnv: env, deploymentDir: shown?.deploymentDir ?? null } : {};
  return {
    plan: {
      key,
      unset: verb === "unset",
      value: verb === "set" ? value : null,
      mutate,
      writeArgs,
      warning: null,
      target: paths.settingsFile,
      expect: writeInputs({ paths: [paths.settingsFile], fs }),
      ...confirmOf(verb === "set" ? `Set ${key}` : `Unset ${key}`, verb === "set" ? `set ${key} = ${value}` : `unset ${key}`),
    },
  };
}

/**
 * Plan setting `key` to `value`. `surface: "tool"` (the default, and the console's) is `dispatch_set`'s plan, with its
 * confirm showing the before and after; `surface: "command"` is `/dispatch set`'s, with `valueTokens` the typed value
 * tokens. `paths` is the deployment's (`settingsFile`, `envelopeFile`, `projectsFile`, `scopedLimitsPath`), `env` its
 * environment (the dollar settings' source), `shown` `{ deploymentDir }`. The write is `writeSettings({ settingsFile,
 * mutate, ...writeArgs })`. `{ plan }` or `{ refusal }`.
 */
export function planSettingSet({ key, value, valueTokens, paths, env, shown = { deploymentDir: null }, surface = "tool", fs = nodeFs }) {
  if (surface === "command") return planSettingCommand({ verb: "set", key, valueTokens: valueTokens ?? (value === undefined ? [] : [value]), paths, env, shown, fs });
  if (value === undefined || value === null || String(value).trim() === "") return { refusal: "a value is needed to set a key; unset it instead" };
  return planSettingTool({ key, value, paths, env, shown, fs });
}

/** Plan unsetting `key` back to its default; the surfaces as `planSettingSet`. `{ plan }` or `{ refusal }`. */
export function planSettingUnset({ key, paths, env, shown = { deploymentDir: null }, surface = "tool", fs = nodeFs }) {
  if (surface === "command") return planSettingCommand({ verb: "unset", key, paths, env, shown, fs });
  return planSettingTool({ key, value: undefined, paths, env, shown, fs });
}

/** `dispatch_set`'s own plan, where a blank `value` means unset (the tool's one-call shape). */
export function planSettingChange({ key, value, paths, env, shown = { deploymentDir: null }, fs = nodeFs }) {
  return planSettingTool({ key, value, paths, env, shown, fs });
}

// ---- pause windows ----

/**
 * Build one pause-window entry from a kind-less field bag (shared by the `dispatch_pause_add` tool and the
 * operator dialog). Required scope/from/to; optional tz/days/dateFrom/dateTo included only when non-blank so
 * an omitted field drops out of the JSON. `days` accepts an array (tool) or a space-separated string (dialog).
 * All value validation (time format, IANA tz, weekday names, date format) lives in the shared
 * `parsePauseWindows`, which the write goes through -- a bad value is rejected there, never written.
 */
export function buildPauseWindow(f) {
  const w = { scope: String(f.scope ?? "").trim(), from: String(f.from ?? "").trim(), to: String(f.to ?? "").trim() };
  const tz = optStr(f.tz);
  const days = asWords(f.days);
  const dateFrom = optStr(f.dateFrom);
  const dateTo = optStr(f.dateTo);
  if (tz) w.tz = tz;
  if (days.length > 0) w.days = days;
  if (dateFrom) w.dateFrom = dateFrom;
  if (dateTo) w.dateTo = dateTo;
  return w;
}

/** The pause windows as read, and the one at `index`, or the refusal naming how many there are. */
function pauseWindowAt(paths, index, fs) {
  const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, fs });
  const list = Array.isArray(p?.windows) ? p.windows : [];
  const cur = list[index];
  return cur ? { cur } : { refusal: `no pause window at index ${index} (have ${list.length})` };
}

/** Plan a pause-window add (`dispatch_pause_add`). The parser judges it at the write. `{ plan: { entry, mutate, ... } }`. */
export function planPauseWindowAdd({ fields, paths, fs = nodeFs }) {
  const w = buildPauseWindow(fields);
  return {
    plan: {
      entry: w,
      mutate: (list) => [...list, w],
      target: paths?.pauseWindowsPath,
      expect: paths?.pauseWindowsPath ? writeInputs({ paths: [paths.pauseWindowsPath], fs }) : [],
      ...confirmOf("Add pause window", `Add to pause-windows.json:\n${JSON.stringify(w)}`),
    },
  };
}

/**
 * Plan a pause-window edit (`dispatch_pause_edit`): a provided field replaces, an omitted one keeps the current value,
 * and the result is rebuilt through the shared builder so it is judged like an add. `{ plan }` or `{ refusal }`.
 */
export function planPauseWindowEdit({ index, fields, paths, fs = nodeFs }) {
  const expect = writeInputs({ paths: [paths.pauseWindowsPath], fs });
  const at = pauseWindowAt(paths, index, fs);
  if (at.refusal) return { refusal: at.refusal };
  const cur = at.cur;
  const before = buildPauseWindow(cur);
  const merged = buildPauseWindow({
    scope: fields.scope ?? cur.scope,
    from: fields.from ?? cur.from,
    to: fields.to ?? cur.to,
    tz: fields.tz ?? cur.tz,
    days: fields.days ?? cur.days,
    dateFrom: fields.dateFrom ?? cur.dateFrom,
    dateTo: fields.dateTo ?? cur.dateTo,
  });
  return {
    plan: {
      index,
      entry: merged,
      mutate: (l) => l.map((w, i) => (i === index ? merged : w)),
      target: paths.pauseWindowsPath,
      expect,
      ...confirmOf(`Edit pause window #${index + 1}`, `pause window #${index + 1}:\n${JSON.stringify(before)}\n→ ${JSON.stringify(merged)}`),
    },
  };
}

/** Plan a pause-window delete (`dispatch_pause_delete`) by index. `{ plan }` or `{ refusal }`. */
export function planPauseWindowDelete({ index, paths, fs = nodeFs }) {
  const expect = writeInputs({ paths: [paths.pauseWindowsPath], fs });
  const at = pauseWindowAt(paths, index, fs);
  if (at.refusal) return { refusal: at.refusal };
  const cur = at.cur;
  return {
    plan: {
      index,
      mutate: (l) => l.filter((_, i) => i !== index),
      target: paths.pauseWindowsPath,
      expect,
      ...confirmOf(`Delete pause window #${index + 1}`, `Remove pause window #${index + 1}: ${cur.scope} ${cur.from}-${cur.to} ${cur.tz}`),
    },
  };
}

// ---- scoped limits ----

/**
 * Build one scoped-limit entry from a field bag (shared by dispatch_limit_add/_edit and the operator
 * dialogs). Required scope; day/week/month/concurrent ride only when an integer-shaped value parses, so a
 * blank dialog answer or omitted tool param drops out of the JSON. All value validation (positive safe
 * integers, at-least-one-limit, non-empty scope, no globs) lives in the shared parseScopedLimits, which
 * the write goes through -- a bad value is rejected there, never written.
 */
export function buildScopedLimit(f) {
  const l = { scope: String(f.scope ?? "").trim() };
  for (const k of ["day", "week", "month", "concurrent"]) {
    const v = optInt(f[k]);
    if (v !== undefined) l[k] = v;
  }
  // Version 2's dollar windows ride through as the parser's own decimal strings; the shared parser validates them.
  for (const k of ["dayUsd", "weekUsd", "monthUsd"]) {
    if (typeof f[k] === "string" && f[k].trim() !== "") l[k] = f[k].trim();
  }
  // Version 3's size fields (issue #596) ride through as given; the shared parser validates them, and refuses them on
  // any row that is not a project row.
  for (const k of SIZE_LIMIT_FIELDS) {
    const v = SIZE_FIELD_RIDES[k](f[k]);
    if (v !== undefined) l[k] = v;
  }
  return l;
}

/** How each size field rides into a built row: its value, or undefined to leave it out. Keyed as `SIZE_LIMIT_FIELDS`, and pinned. */
export const SIZE_FIELD_RIDES = {
  memory: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  cpus: (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  hostShare: (v) => optInt(v),
  minJobs: (v) => optInt(v),
};

/** Every size field, in `SIZE_LIMIT_FIELDS` order, with the value `pick` gives it: a merge or a carry in one line. */
export function sizeFieldsFrom(pick) {
  return Object.fromEntries(SIZE_LIMIT_FIELDS.map((k) => [k, pick(k)]));
}

/**
 * The size fields a scoped-limit tool was SENT (issue #596), in the one spelling the parser stores: `memory` through
 * the worker's own `parseMemory`/`formatMemory` ("1024m" becomes "1g"), `cpus` through `parseCpus`/`formatCpus` as a
 * number, `hostShare` and `minJobs` as given (the schema holds them to integers; the parser judges the rest). A blank
 * or absent field is not sent. A malformed size throws with the parser's own words before any confirm is shown.
 */
export function sizeFieldsOf(f) {
  const out = {};
  const sent = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
  if (sent(f?.memory)) {
    try {
      out.memory = formatMemory(parseMemory(typeof f.memory === "string" ? f.memory.trim() : f.memory));
    } catch (e) {
      throw new Error(`memory: ${e?.message ?? e}`);
    }
  }
  if (sent(f?.cpus)) {
    try {
      out.cpus = Number(formatCpus(parseCpus(typeof f.cpus === "string" ? f.cpus.trim() : f.cpus)));
    } catch (e) {
      throw new Error(`cpus: ${e?.message ?? e}`);
    }
  }
  for (const k of SIZE_LIMIT_FIELDS) {
    if (k !== "memory" && k !== "cpus" && sent(f?.[k])) out[k] = f[k];
  }
  return out;
}

/**
 * The dollar fields a scoped-limit tool was SENT (issue #501, part 7), each judged by the worker's own
 * `parseUsdMicros` and returned in its canonical form (`formatMicros`: "2.5" becomes "2.50"), the form the parser
 * stores, so a confirm shows exactly what the file will hold. A blank or absent field is not sent. A malformed one
 * throws with the parser's message (the key named, never the value) before any confirm is shown.
 */
export function dollarFieldsOf(f) {
  const out = {};
  for (const k of USD_LIMIT_FIELDS) {
    const raw = f?.[k];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
    // A JSON number cannot be refused here: pi's own argument validation (`validateToolArguments`, `Value.Convert`)
    // turns it into a string before `execute` runs, and no schema keeps a string-typed field a number there (PR
    // #550's review measured `Type.String`, `Type.Unsafe`, `allOf`, `anyOf` and `not`; only a schema with no `type`
    // refused one, and a tool schema without a type is one some providers reject). So a number is read by its VALUE,
    // the overlay's documented rule (`INT-CONFIG-OVERLAY-CONTRACT`): `2.5` is $2.50 and `1e-7` is refused.
    out[k] = formatMicros(parseUsdMicros(typeof raw === "string" ? raw.trim() : raw, k));
  }
  return out;
}

/** One scoped limit as a display summary: `day 10 · week 40 · ≤1 at once` (set fields only). */
export function limitSummary(l) {
  const bits = [];
  if (Number.isInteger(l?.day)) bits.push(`day ${l.day}`);
  if (Number.isInteger(l?.week)) bits.push(`week ${l.week}`);
  if (Number.isInteger(l?.month)) bits.push(`month ${l.month}`);
  if (Number.isInteger(l?.concurrent)) bits.push(`≤${l.concurrent} at once`);
  // Version 2's dollar windows (issues #501, #502), so a model or dollar-only row never summarizes as nothing.
  if (typeof l?.dayUsd === "string") bits.push(`day $${l.dayUsd}`);
  if (typeof l?.weekUsd === "string") bits.push(`week $${l.weekUsd}`);
  if (typeof l?.monthUsd === "string") bits.push(`month $${l.monthUsd}`);
  // Version 3's size (issue #596), with hostShare and minJobs, which each worker's host budget enforces since phase 2.
  bits.push(...sizeBits(l));
  return bits.join(" · ");
}

/**
 * "live" for a scoped-limits write the worker takes on its next reload. With `pending` (issue #499 part B: a
 * `project:<id>` row names a project the projects file on disk lacks), only what the admin can know: written, and the
 * worker applies it once its live projects define the id.
 */
export function liveOr(res) {
  return res?.pending ? `written; ${res.pending}` : "live";
}

/**
 * The line an edit's confirm adds when it changes a row's scope (issue #498): every counter is keyed by the row's
 * scope, so a new scope (a bare "acme/web" rewritten to "github:acme/web", or any rename) starts a new count, and the
 * old key simply expires on its own TTL. Empty when the scope is unchanged.
 */
export function scopeChangeNote(before, after) {
  if (before?.scope === after?.scope) return "";
  return "\nThe scope changes, so this row starts a NEW count under a new key: the used runs and dollars of the old scope do not carry over. Jobs already running keep their slot under the old scope until they finish, and the new row counts from zero, so with `concurrent: N` up to 2N jobs can run until then.";
}

/** The envelope cross-check context the scoped-limits and projects writers take (`envelopeRefusal`). */
export function envelopeGuard(paths, env, fs = nodeFs) {
  return paths.envelopeFile ? { file: paths.envelopeFile, maxCostMicros: envelopeJobCap({ settingsFile: paths.settingsFile, env, fs }) } : null;
}

/** A scoped-limits change judged in full without writing (`dryRun`): the refusal, or null. */
function limitsWriteRefusal(args) {
  const res = writeScopedLimits({ ...args, dryRun: true });
  return res.invalid ? `rejected: ${escapeInterpreted(res.invalid)}` : null;
}

/** The scoped limits as read, and the one at `index`, or the refusal naming how many there are. */
function limitAt(paths, index, fs) {
  const p = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath, fs });
  const list = Array.isArray(p?.limits) ? p.limits : [];
  const cur = list[index];
  return cur ? { cur } : { refusal: `no scoped limit at index ${index} (have ${list.length})` };
}

/** The plan's limits fields: the write's arguments and the confirm. */
function limitPlan({ paths, expect, envelope, mutate, title, message, extra }) {
  return {
    plan: {
      ...extra,
      mutate,
      envelope,
      target: paths.scopedLimitsPath,
      expect,
      writeArgs: { scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, expect, envelope, mutate },
      ...confirmOf(title, message),
    },
  };
}

/**
 * Plan a scoped-limit add (`dispatch_limit_add`): the dollar and size fields judged by the worker's parsers, then the
 * whole change judged without writing (the parser, the project pair and the allocation envelope, issue #504 part C), so
 * the operator is never asked to approve a row the write would refuse. `expect` is the files as the change is built
 * from them (PR #569's second review). The write is `writeScopedLimits(plan.writeArgs)`. `{ plan }` or `{ refusal }`.
 */
export function planLimitAdd({ params, paths, env, fs = nodeFs }) {
  const expect = writeInputs({ paths: [paths.scopedLimitsPath, paths.projectsFile], fs });
  let l;
  const fields = refusalOf(() => {
    l = buildScopedLimit({ ...params, ...dollarFieldsOf(params), ...sizeFieldsOf(params) });
  });
  if (fields !== null) return { refusal: fields };
  const envelope = envelopeGuard(paths, env, fs);
  const mutate = (list) => [...list, l];
  const refused = limitsWriteRefusal({ scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, mutate, envelope, fs });
  if (refused !== null) return { refusal: refused };
  return limitPlan({ paths, expect, envelope, mutate, title: "Add scoped limit", message: `Add to scoped-limits.json:\n${JSON.stringify(l)}`, extra: { entry: l } });
}

/**
 * Plan a scoped-limit edit (`dispatch_limit_edit`): a provided field replaces, an omitted one keeps the current value
 * (the dollar windows and the size fields are CARRIED, never dropped), rebuilt through the shared builder and judged
 * like an add. `sizingNoteFn(scope)`, when given, adds the project's size evidence to the confirm when a size field
 * changes (index.ts's `sizingNote`). `{ plan }` or `{ refusal }`.
 */
export function planLimitEdit({ params, paths, env, sizingNoteFn = null, fs = nodeFs }) {
  const index = params.index;
  const expect = writeInputs({ paths: [paths.scopedLimitsPath, paths.projectsFile], fs });
  const at = limitAt(paths, index, fs);
  if (at.refusal) return { refusal: at.refusal };
  const cur = at.cur;
  let usd;
  let size;
  const fields = refusalOf(() => {
    // Issue #501, part 7: a dollar field is judged BEFORE the confirm; issue #596: the size fields the same way.
    usd = dollarFieldsOf(params);
    size = sizeFieldsOf(params);
  });
  if (fields !== null) return { refusal: fields };
  const before = buildScopedLimit(cur);
  const merged = buildScopedLimit({
    scope: params.scope ?? cur.scope,
    day: params.day ?? cur.day,
    week: params.week ?? cur.week,
    month: params.month ?? cur.month,
    concurrent: params.concurrent ?? cur.concurrent,
    // The dollar windows (version 2): a sent one replaces, an omitted one is CARRIED, never dropped, so an edit of
    // a count field cannot silently remove a dollar cap.
    dayUsd: usd.dayUsd ?? cur.dayUsd,
    weekUsd: usd.weekUsd ?? cur.weekUsd,
    monthUsd: usd.monthUsd ?? cur.monthUsd,
    // The size fields (version 3) the same way: a sent one replaces, an omitted one is carried.
    ...sizeFieldsFrom((k) => size[k] ?? cur[k]),
  });
  const envelope = envelopeGuard(paths, env, fs);
  const mutate = (l) => l.map((w, i) => (i === index ? merged : w));
  const refused = limitsWriteRefusal({ scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, mutate, envelope, fs });
  if (refused !== null) return { refusal: refused };
  const sizing = Object.keys(size).length > 0 && typeof sizingNoteFn === "function" ? sizingNoteFn(merged.scope) : "";
  return limitPlan({
    paths,
    expect,
    envelope,
    mutate,
    title: `Edit scoped limit #${index + 1}`,
    message: `scoped limit #${index + 1}:\n${JSON.stringify(before)}\n→ ${JSON.stringify(merged)}${scopeChangeNote(before, merged)}${sizing}`,
    extra: { index, entry: merged },
  });
}

/** Plan a scoped-limit delete (`dispatch_limit_delete`) by index, judged like an add. `{ plan }` or `{ refusal }`. */
export function planLimitDelete({ index, paths, env, fs = nodeFs }) {
  const expect = writeInputs({ paths: [paths.scopedLimitsPath, paths.projectsFile], fs });
  const at = limitAt(paths, index, fs);
  if (at.refusal) return { refusal: at.refusal };
  const cur = at.cur;
  const envelope = envelopeGuard(paths, env, fs);
  const mutate = (l) => l.filter((_, i) => i !== index);
  const refused = limitsWriteRefusal({ scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, mutate, envelope, fs });
  if (refused !== null) return { refusal: refused };
  return limitPlan({ paths, expect, envelope, mutate, title: `Delete scoped limit #${index + 1}`, message: `Remove scoped limit #${index + 1}: ${cur.scope} ${limitSummary(cur)}`, extra: { index } });
}

// ---- projects ----

/**
 * A project as a tool shows it (issue #499 part C): the `name` and every member ESCAPED, so a bidi override or an
 * invisible character in either is visible text in a confirm dialog and a tool result, never a reordering. The id is
 * charset-checked by the parser and shown as stored.
 */
export function projectShown(p) {
  return {
    id: p?.id,
    name: p?.name === null || p?.name === undefined ? null : escapeInterpreted(p.name),
    // Members too (PR #569's review): a folder member may hold a C1 or bidi character the parser admits.
    members: Array.isArray(p?.members) ? p.members.map((m) => escapeInterpreted(String(m))) : p?.members,
  };
}

/** The project `id` names in the file the worker reads, `{ cur }`, or `{ refusal }` saying why there is none. */
export function projectAt(paths, id, fs = nodeFs) {
  const p = readProjects({ projectsPath: paths.projectsFile, fs });
  if (p?.unset) return { refusal: "PI_PROJECTS_FILE is unset, so the worker reads no projects; set it in the deployment's .env (pi-dispatch up does) and restart the worker" };
  if (p?.invalid) return { refusal: `the projects file does not load: ${escapeInterpreted(p.invalid)}` };
  if (p?.unreadable) return { refusal: `the projects file ${escapeInterpreted(String(paths.projectsFile))} could not be read (${p.unreadable})` };
  const list = Array.isArray(p?.projects) ? p.projects : [];
  const cur = list.find((x) => x.id === id);
  if (!cur) return { refusal: `no project with id ${JSON.stringify(String(id)).slice(0, 40)} (dispatch_projects lists them)` };
  return { cur };
}

/** `projectAt` as a throw, for a caller that refuses by throwing. */
export function currentProject(paths, id, fs = nodeFs) {
  const at = projectAt(paths, id, fs);
  if (at.refusal) throw new Error(at.refusal);
  return at.cur;
}

/** The plan's projects fields: the write's arguments (`writeProjects(plan.writeArgs)`) and the confirm. */
function projectPlan({ paths, env, mutate, planned, title, message, extra, fs }) {
  return {
    plan: {
      ...extra,
      mutate,
      target: paths.projectsFile,
      expect: planned.inputs,
      writeArgs: { projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, triggersPath: paths.triggersPath ?? null, mutate, expect: planned.inputs, envelope: envelopeGuard(paths, env, fs) },
      ...confirmOf(title, message),
    },
  };
}

/** `planProjectsWrite` for a projects change, judged before the confirm: the plan, or the refusal. */
function projectsPlanned(paths, env, mutate, fs) {
  const planned = planProjectsWrite({ projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, triggersPath: paths.triggersPath ?? null, mutate, envelope: envelopeGuard(paths, env, fs), fs });
  return planned.invalid ? { refusal: `rejected: ${escapeInterpreted(planned.invalid)}` } : { planned };
}

/** Plan a project add (`dispatch_project_add`): `params` `{ id, name?, members }`. `{ plan: { added, ... } }` or `{ refusal }`. */
export function planProjectAdd({ params, paths, env, fs = nodeFs }) {
  const entry = { id: params.id, name: params.name ?? null, members: params.members };
  const mutate = (list) => [...list, entry];
  const judged = projectsPlanned(paths, env, mutate, fs);
  if (judged.refusal) return judged;
  const added = judged.planned.projects.find((p) => p.id === params.id);
  return projectPlan({
    paths,
    env,
    mutate,
    planned: judged.planned,
    title: "Add project",
    message: `Add to projects.json:\n${JSON.stringify(projectShown(added))}\nRuns of these members record project ${added.id} from their next pickup.`,
    extra: { added },
    fs,
  });
}

/**
 * Plan a project edit (`dispatch_project_edit`): `name` replaces (an empty string removes it), `members` replaces the
 * whole list. A member leaving a capped project is named in the confirm, because it WIDENS what it may spend.
 * `{ plan: { after, ... } }` or `{ refusal }`.
 */
export function planProjectEdit({ params, paths, env, fs = nodeFs }) {
  const at = projectAt(paths, params.id, fs);
  if (at.refusal) return { refusal: at.refusal };
  const cur = at.cur;
  const merged = {
    id: cur.id,
    name: params.name === undefined ? cur.name : params.name === "" ? null : params.name,
    members: params.members ?? cur.members,
  };
  const mutate = (list) => list.map((p) => (p.id === cur.id ? merged : p));
  const judged = projectsPlanned(paths, env, mutate, fs);
  if (judged.refusal) return judged;
  const after = judged.planned.projects.find((p) => p.id === cur.id);
  const leaving = cur.members.filter((m) => !after.members.includes(m));
  const note = leaving.length > 0 ? `\n${leaving.map((m) => escapeInterpreted(m)).join(", ")} leave${leaving.length === 1 ? "s" : ""} the project: a project:${cur.id} row no longer counts ${leaving.length === 1 ? "it" : "them"}, which widens what ${leaving.length === 1 ? "it" : "they"} may spend.` : "";
  return projectPlan({
    paths,
    env,
    mutate,
    planned: judged.planned,
    title: `Edit project ${cur.id}`,
    message: `project ${cur.id}:\n${JSON.stringify(projectShown(cur))}\n→ ${JSON.stringify(projectShown(after))}${note}`,
    extra: { before: cur, after },
    fs,
  });
}

/**
 * Plan a project delete (`dispatch_project_delete`). Judged BEFORE the confirm: a scoped-limits row naming the project
 * refuses here, so the operator is never asked to approve it. `{ plan: { deleted, ... } }` or `{ refusal }`.
 */
export function planProjectDelete({ id, paths, env, fs = nodeFs }) {
  const at = projectAt(paths, id, fs);
  if (at.refusal) return { refusal: at.refusal };
  const cur = at.cur;
  const mutate = (list) => list.filter((p) => p.id !== cur.id);
  const judged = projectsPlanned(paths, env, mutate, fs);
  if (judged.refusal) return judged;
  return projectPlan({
    paths,
    env,
    mutate,
    planned: judged.planned,
    title: `Delete project ${cur.id}`,
    message: `Remove project ${cur.id} (${cur.members.length} member${cur.members.length === 1 ? "" : "s"}). Its members' runs record no project from their next pickup; records already written keep the id.`,
    extra: { deleted: cur.id },
    fs,
  });
}

// ---- the allocation envelope and priorities (issue #504 part C) ----

/** The tool's envelope fields as `planEnvelopeWrite`'s change: only the fields that were sent. */
export function envelopeChangeOf(p) {
  const change = {};
  if (p.window !== undefined) change.window = p.window;
  if (p.totalUsd !== undefined) change.totalUsd = p.totalUsd;
  if (p.floorsUsd !== undefined) change.floorsUsd = p.floorsUsd;
  if (p.defaultWeights !== undefined) change.defaultWeights = p.defaultWeights;
  const delegation = {};
  for (const f of ["enabled", "writers", "maxStepPct", "minIntervalHours", "maxPlanDays"]) if (p[f] !== undefined) delegation[f] = p[f];
  if (Object.keys(delegation).length > 0) change.delegation = delegation;
  return change;
}

/**
 * Plan an envelope change (`dispatch_envelope_set`), judged by the worker's own parser BEFORE the confirm, so the
 * operator is never asked to approve an envelope the worker would refuse. `params` are the tool's fields. The per-job
 * cap the worker judges the envelope with is read from the deployment's settings and `env`. The write is
 * `writeEnvelope({ ...plan.files, change: plan.change, expect: plan.expect, url })`. `{ plan }`, `{ unchanged }` or
 * `{ refusal }`.
 */
export function planEnvelope({ params, paths, env, fs = nodeFs }) {
  const change = envelopeChangeOf(params);
  if (Object.keys(change).length === 0) return { refusal: "nothing to change: name at least one of window, totalUsd, floorsUsd, defaultWeights, enabled, writers, maxStepPct, minIntervalHours, maxPlanDays" };
  const maxCostMicros = envelopeJobCap({ settingsFile: paths.settingsFile, env, fs });
  const files = { envelopeFile: paths.envelopeFile, projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, maxCostMicros };
  const planned = planEnvelopeWrite({ ...files, change, fs });
  if (planned.invalid) return { refusal: `rejected: ${escapeInterpreted(planned.invalid)}` };
  if (planned.digest === planned.beforeDigest) return { unchanged: "no change: the envelope already says this" };
  return {
    plan: {
      change,
      files,
      lines: planned.lines,
      digest: planned.digest,
      beforeDigest: planned.beforeDigest,
      target: paths.envelopeFile,
      expect: planned.inputs,
      ...confirmOf("Change the allocation envelope", `${planned.lines.join("\n")}\n\nEvery host re-bases the split onto it with no step; a host whose copy differs refuses its jobs until it has it.`),
    },
  };
}

/**
 * A priorities plan as `applyPriorities` takes it, from what was given: each project's id and weight, its reason and
 * repos when sent, and `validUntil` `validDays` after `now` when sent. Every rule is the worker's (`applyPlan`); the
 * basis is filled in by `applyPriorities` from the applied state. `{ plan: { plan } }`.
 */
export function planPriorities({ projects, validDays, now }) {
  return {
    plan: {
      plan: {
        ...(validDays !== undefined ? { validUntil: new Date(now.getTime() + validDays * 86400000).toISOString() } : {}),
        projects: (Array.isArray(projects) ? projects : []).map((p) => ({
          id: p?.id,
          weight: p?.weight,
          ...(p?.reason !== undefined ? { reason: p.reason } : {}),
          ...(p?.repos !== undefined ? { repos: p.repos } : {}),
        })),
      },
    },
  };
}

// ---- secret-resolver profiles (REQ-TRIGGER-SECRETS) ----

/** A profile name's shape: PI_SECRET_PROFILES is a comma-separated list of name:path pairs, so neither may appear. */
export const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The declared tables, rendered for a human on their own host: names and paths, never a reference. `env` is
 * `envSecretProfiles(PI_SECRET_PROFILES)` (issue #712), or null when the caller has none: the worker merges both sources,
 * so a list of the overlay's alone said "none declared" on a deployment whose profiles all live in `.env`.
 */
export function renderProfiles(profiles, env = null) {
  const names = Object.keys(profiles).sort();
  const overlay = names.length === 0 ? "No resolver profiles are declared in the settings overlay." : ["Resolver profiles (settings overlay):", ...names.map((n) => `  ${n} -> ${profiles[n]}`)].join("\n");
  if (env === null || typeof env !== "object") return overlay;
  if (env.malformed) return `${overlay}\nPI_SECRET_PROFILES does not parse, so the worker refuses to boot until it is fixed.`;
  const fromEnv = Object.keys(env.profiles ?? {}).sort();
  // None in the env (or the env not visible here): the overlay's sentence alone, which names its source, as before.
  if (fromEnv.length === 0) return overlay;
  // A name in both is the worker's ambiguity: it then refuses every secrets job (secret-profiles.mjs `mergeSecretProfiles`).
  const both = fromEnv.filter((n) => Object.hasOwn(profiles, n));
  return [overlay, "Resolver profiles (PI_SECRET_PROFILES):", ...fromEnv.map((n) => `  ${n} -> ${env.profiles[n]}${both.includes(n) ? " (AMBIGUOUS: also in the settings overlay, so the worker refuses every secrets job)" : ""}`)].join("\n");
}

/**
 * What PI_SECRET_RESOLVER_ROOTS says about an overlay resolver at `path`, judged BEFORE the confirm (issue #712), so an
 * operator does not approve a write the worker then refuses on every job: `{ refusal }`, `{ warning }` (a line the
 * confirm adds), or `{}`. The worker compares the resolver's REALPATH with the roots AS WRITTEN (secrets.mjs and
 * secret-bundles.mjs: `realExecutablePath`, then `withinRoots`; the roots are never resolved), so this does exactly
 * that, on THIS host: a lexical comparison would be wrong both ways (a path inside the roots that is a symlink to one
 * outside is refused by the worker, one outside that resolves inside is admitted), and resolving the roots too would
 * admit what the worker refuses (macOS writes `/tmp` as `/private/tmp`, so a root spelled `/tmp/pi` holds no real
 * path). When a resolved root WOULD have held it, the refusal says to write the root as its real path.
 *
 * A path this host cannot resolve (an error with a `code`: not there yet, or on another machine) is NOT refused, even
 * when it is outside the roots as written, deliberately: its real path is unknown here and may land inside them, so the
 * confirm says the worker checks it where it runs (`doctor --secrets` is the check that it does). Any other error is a
 * fault, not an answer, and is rethrown. Judged on the PANEL's host, which may not be the worker's.
 * Judged only when the panel can see the variable (`env` holds the key): unset in what the panel reads is not proof
 * the worker's host has no roots. Set and empty IS proof: the worker fails closed and refuses every overlay resolver.
 */
export function resolverRootsJudgement(path, env, fs = nodeFs) {
  // Issue #712: the status is `resolverRootsStatus` (read-model.mjs), the one rule the profiles view reads too.
  const { status, roots, real } = resolverRootsStatus(path, env, fs);
  if (status === "unseen" || status === "inside") return {};
  if (status === "empty") return { refusal: "PI_SECRET_RESOLVER_ROOTS is set and empty on this deployment, so the worker refuses every resolver the settings overlay declares; set it to the directory your resolvers live in first" };
  if (status === "unresolved") return { warning: `${path} cannot be resolved on this host, so whether its real path sits inside PI_SECRET_RESOLVER_ROOTS (${roots.join(", ")}) is checked only by the worker, where it runs (pi-dispatch doctor --secrets shows it)` };
  // A root the worker would hold this path under if it were written as its own real path.
  const realRoot = roots.map((root) => ({ root, real: realPathOrNull(root, fs) })).find((r) => r.real !== null && r.real !== r.root && withinRoots(real, [r.real]));
  return { refusal: resolverRootsRefusal(path, env, real, realRoot?.real ?? null) };
}

/**
 * The refusal sentence for a resolver whose real path `real` is outside the roots as written (`resolverRootsJudgement`
 * decides it); `realRoot` is a root's real path that would hold it. Kept a function of its own so the refusal table's
 * scan finds the sentence.
 */
export function resolverRootsRefusal(path, env, real = path, realRoot = null) {
  const roots = delimitedList(env?.PI_SECRET_RESOLVER_ROOTS);
  const via = real !== path ? ` (it resolves to ${real})` : "";
  const sentence = `${path}${via} is outside PI_SECRET_RESOLVER_ROOTS (${roots.join(", ")}), so the worker would refuse it on every job; put the resolver inside one of them, or add its directory to PI_SECRET_RESOLVER_ROOTS`;
  return realRoot !== null ? `${sentence}, or write the root as its real path (${realRoot})` : sentence;
}

/** Why `name` cannot name a profile, or null. */
export function secretProfileNameRefusal(name) {
  return PROFILE_NAME.test(name) ? null : "a profile name may use letters, digits, dot, dash and underscore only \u2014 PI_SECRET_PROFILES is a comma-separated list of name:path pairs";
}

/**
 * Why `path` cannot be a resolver, or null. Absolute for `resolveEnvSetup`'s reason, restated because an operator meets
 * it here rather than there: a service manager's working directory is not a login shell's, so a relative path is a
 * different file on every host.
 */
export function secretResolverPathRefusal(path) {
  return path.startsWith("/") || /^([A-Za-z]:[\\/]|\\\\)/.test(path) ? null : "the resolver needs an ABSOLUTE path: a service manager's working directory is not your shell's";
}

/**
 * Plan declaring profile `name` -> resolver `path` over the declared `profiles` (`/dispatch secrets add`). The confirm
 * shows the EXACT bytes to be written (the pointer wizard's discipline: this file redirects what the worker executes,
 * so the operator approves the thing itself). Never a reference or a value: a profile is a name and a path.
 * `{ plan: { name, path, profiles, mutate, ... } }` or `{ refusal }`.
 */
export function planSecretProfileAdd({ name, path, profiles, envProfiles = {}, env = null, settingsFile, fs = nodeFs }) {
  const badName = secretProfileNameRefusal(name);
  if (badName !== null) return { refusal: badName };
  const badPath = secretResolverPathRefusal(path);
  if (badPath !== null) return { refusal: badPath };
  // Issue #712, planSecretBundleAdd's rule for its reason: a name PI_SECRET_PROFILES already declares would make the
  // worker read it as AMBIGUOUS, which refuses every secrets job of every trigger, not just this profile's.
  if (Object.hasOwn(envProfiles ?? {}, name)) return { refusal: `PI_SECRET_PROFILES already declares ${name} on this deployment; the worker reads a name declared in both places as ambiguous and refuses every secrets job, so pick another name or change the .env` };
  const roots = resolverRootsJudgement(path, env, fs);
  if (roots.refusal) return { refusal: roots.refusal };
  const rootsNote = roots.warning ? `\n\nNote: ${roots.warning}.` : "";
  const next = { ...profiles, [name]: path };
  const replacing = profiles[name] ? `\n\nThis REPLACES the current ${name} -> ${profiles[name]}` : "";
  return {
    plan: {
      name,
      path,
      profiles: next,
      mutate: (o) => ({ ...o, secretProfiles: next }),
      target: settingsFile,
      ...confirmOf(
        "Declare a secret resolver",
        `${settingsFile} gets:\n${JSON.stringify({ secretProfiles: next }, null, 2)}${replacing}\n\nThe worker EXECUTES this script, as the account it runs as, once per reference. It must also sit inside PI_SECRET_RESOLVER_ROOTS or the worker will refuse it.${rootsNote}`,
      ),
    },
  };
}

/** Plan removing profile `name` (`/dispatch secrets remove`). `{ plan: { name, profiles, mutate, ... } }` or `{ refusal }`. */
export function planSecretProfileRemove({ name, profiles, settingsFile }) {
  if (!name || !Object.hasOwn(profiles, name)) return { refusal: `no such profile. ${renderProfiles(profiles)}` };
  const next = { ...profiles };
  delete next[name];
  return {
    plan: {
      name,
      profiles: next,
      mutate: (o) => ({ ...o, secretProfiles: next }),
      target: settingsFile,
      ...confirmOf("Remove a secret resolver", `${name} -> ${profiles[name]}\n\nEvery trigger naming it refuses PRE-SPEND after this, rather than running without its secrets.`),
    },
  };
}

// ---- bundle resolver profiles (issue #704, DES-PROJECT-SECRET-BUNDLES) ----

/** Why `name` cannot name a bundle profile, or null: the profile charset, for PI_SECRET_BUNDLES' list grammar. */
export function secretBundleNameRefusal(name) {
  return PROFILE_NAME.test(name) ? null : "a bundle profile name may use letters, digits, dot, dash and underscore only \u2014 PI_SECRET_BUNDLES is a comma-separated list of name:path:format entries";
}

/** Why `format` cannot be a bundle resolver's declared format, or null. Declared, never guessed: the worker never sniffs. */
export function secretBundleFormatRefusal(format) {
  return BUNDLE_FORMATS.includes(format) ? null : `the format is ${BUNDLE_FORMATS.join(" or ")}: what the resolver prints, declared, because the worker never guesses it from the output`;
}

/**
 * Plan declaring bundle profile `name` -> resolver `path` printing `format` over the overlay's `bundles`
 * (`/dispatch secrets add --bundle`, the console's `secret-bundle-add`). `secretProfiles`' rules (the name and the
 * absolute path), the format required, and one of its own: a name `PI_SECRET_BUNDLES` already declares on this
 * deployment (`envBundles`) is refused, because the worker reads a name in both sources as AMBIGUOUS and then refuses
 * every bundled job of every project, not just this one's. The confirm shows the EXACT bytes to be written, the shape
 * runtime-settings.mjs's validator takes (`{ name: { path, format } }`). Never a reference or a value: a bundle profile
 * is a name, a path and a format, and binding it to a project stays an edit to triggers.json's `secretBundles`.
 * `{ plan: { name, path, format, bundles, mutate, ... } }` or `{ refusal }`.
 */
export function planSecretBundleAdd({ name, path, format, bundles, envBundles = {}, env = null, settingsFile, fs = nodeFs }) {
  const badName = secretBundleNameRefusal(name);
  if (badName !== null) return { refusal: badName };
  const badPath = secretResolverPathRefusal(path);
  if (badPath !== null) return { refusal: badPath };
  const badFormat = secretBundleFormatRefusal(format);
  if (badFormat !== null) return { refusal: badFormat };
  if (Object.hasOwn(envBundles, name)) return { refusal: `PI_SECRET_BUNDLES already declares ${name} on this deployment; the worker reads a name declared in both places as ambiguous and refuses every bundled job, so pick another name or change the .env` };
  // Issue #712: the profiles' roots rule, for the same resolver check the worker makes on both kinds.
  const roots = resolverRootsJudgement(path, env, fs);
  if (roots.refusal) return { refusal: roots.refusal };
  const rootsNote = roots.warning ? `\n\nNote: ${roots.warning}.` : "";
  const next = { ...bundles, [name]: { path, format } };
  const replacing = bundles[name] ? `\n\nThis REPLACES the current ${name} -> ${bundles[name].path} (${bundles[name].format ?? "no format"})` : "";
  return {
    plan: {
      name,
      path,
      format,
      bundles: next,
      mutate: (o) => ({ ...o, secretBundles: next }),
      target: settingsFile,
      ...confirmOf(
        "Declare a secret bundle resolver",
        `${settingsFile} gets:\n${JSON.stringify({ secretBundles: next }, null, 2)}${replacing}\n\nThe worker EXECUTES this script, as the account it runs as, once per job start of every project a bundle in triggers.json binds to it, and hands that job EVERY variable it prints (${format}). It must also sit inside PI_SECRET_RESOLVER_ROOTS or the worker will refuse it.${rootsNote}`,
      ),
    },
  };
}

/**
 * Plan removing bundle profile `name` (`/dispatch secrets remove --bundle`, the console's `secret-bundle-remove`).
 * `bound` is the triggers-file bundle ids that name it (`[]` for a file that names none or does not exist), or null
 * when the file could not be read, and `envBundles` the `PI_SECRET_BUNDLES` profiles this deployment declares. The
 * confirm says what the removal does to them: nothing when no bundle names it; resolves the ambiguity when
 * PI_SECRET_BUNDLES holds the same name (the worker refused every bundled job while both did); otherwise names the
 * bundles whose jobs are refused before they spend (or, on a multi-host worker's shared queue, held for a host that
 * declares it). `{ plan: { name, bundles, mutate, ... } }` or `{ refusal }`.
 */
export function planSecretBundleRemove({ name, bundles, bound = null, envBundles = {}, settingsFile }) {
  if (!name || !Object.hasOwn(bundles, name)) return { refusal: `no such bundle resolver. ${renderBundleProfiles(bundles)}` };
  const next = { ...bundles };
  delete next[name];
  // The worker's `mergeSecretProfiles` makes EVERY bundle ambiguous while ANY name is in both sources, so the other
  // colliding names decide whether this removal resolves anything (final review).
  const others = Object.keys(next).filter((n) => Object.hasOwn(envBundles, n)).sort();
  const still = others.length > 0 ? ` Still ambiguous after this: ${others.join(", ")} also ${others.length === 1 ? "collides" : "collide"} with PI_SECRET_BUNDLES, and the worker refuses every bundled job until no name is in both.` : "";
  let effect;
  if (Object.hasOwn(envBundles, name)) {
    effect = others.length > 0
      ? `PI_SECRET_BUNDLES also declares ${name}, so this removes one collision.${still}`
      : `PI_SECRET_BUNDLES also declares ${name}, so removing it here resolves the ambiguity: while both did, the worker refused every bundled job, and after this it runs PI_SECRET_BUNDLES' resolver.`;
  } else if (others.length > 0) {
    effect = `Every bundled job is refused already while a name is in both places, and removing ${name} does not change that.${still}`;
  } else if (Array.isArray(bound) && bound.length === 0) {
    effect = "No bundle in triggers.json names it, so no project's jobs depend on it.";
  } else {
    const who = Array.isArray(bound) ? `The jobs of bundle${bound.length === 1 ? "" : "s"} ${bound.join(", ")}` : "The triggers file could not be read, so the jobs of any bundle naming it";
    effect = `${who} are refused PRE-SPEND after this (secret-bundle-profile-unknown), or on a multi-host worker's shared queue held for a host that declares it, rather than running without their environment.`;
  }
  return {
    plan: {
      name,
      bundles: next,
      mutate: (o) => ({ ...o, secretBundles: next }),
      target: settingsFile,
      ...confirmOf("Remove a secret bundle resolver", `${name} -> ${bundles[name].path} (${bundles[name].format ?? "no format"})\n\n${effect}`),
    },
  };
}
