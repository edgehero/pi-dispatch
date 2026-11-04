/**
 * The trigger edit's one body (issue #800), for the two planners that write a trigger's fields: `planTriggerEdit`
 * (`write-plans.mjs`), which every tool reaches, and the person's `trigger-environment-plans.mjs`, which no tool reaches.
 *
 * THIS MODULE IS IN EVERY TOOL'S IMPORT GRAPH, so it holds nothing a tool could use to reach a field it may not set. It takes
 * no person-only field: `planTriggerEditCore` reads only the flow, the venue, the model reference and the flags, and `baseRun` can
 * only change what the merged model reference is JUDGED against, never what is written. `write-plans.mjs` re-exports the
 * small helpers and not `planTriggerEditCore`, because `tool-actions.mjs` hands a tool `{ ...writePlans }`.
 *
 * PI-FREE, `write-plans.mjs`' rule, and held by the same walk: the console is a separate process that never loads pi.
 */
import * as nodeFs from "node:fs";
import { parseBackendList } from "@edgehero/pi-dispatch/backends";
import { recoverVenueProblem, validateModelRef, validateProgressFlags, validateRecoverFlag, validateSteerFlag } from "@edgehero/pi-dispatch/triggers";
import { readTriggers, triggerVenue, writeInputs } from "./read-model.mjs";

/** A trimmed non-empty string, or undefined (so a blank optional field drops out of the written JSON). */
export function optStr(x) {
  const s = String(x ?? "").trim();
  return s === "" ? undefined : s;
}

/** A plan's confirm: the title, the message, and the message as lines. */
export function confirmOf(title, message) {
  return { title, message, summary: message.split("\n") };
}

/** Human console rows count from one; tool indexes remain zero-based machine values. */
export function rowName(what, index, surface = "tool") {
  return surface === "console" ? `${what} row ${index + 1}` : `${what} #${index + 1}`;
}

/**
 * A change as a confirm says it, `key: before to after` (issue #737: words, not an arrow), each pair joined by a
 * comma. The console draws the same pairs with the two values in bold (`plan.changes`), so the words are this one rule.
 */
export function changeText(changes) {
  return changes.map(([key, before, after]) => `${key}: ${before} to ${after}`).join(", ");
}

/** A validator that throws, as a refusal: its own message, so the tool that re-throws it says the same words. */
export function refusalOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

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
export function progressRun(f) {
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
export function progressRefusal(params, onType, at, path, command = undefined) {
  return (
    refusalOf(() => validateProgressFlags({ progress: params.progress, statusComment: params.statusComment }, at, path, { onType })) ??
    refusalOf(() => validateRecoverFlag({ recover: params.recover, ...(command !== undefined ? { command } : {}) }, at, path, { onType })) ??
    refusalOf(() => validateSteerFlag({ steer: params.steer, ...(command !== undefined ? { command } : {}) }, at, path))
  );
}

/** The current triggers as a display list (empty on a missing/invalid file), for index resolution + confirm text. */
export function triggerList(paths, fs = nodeFs) {
  const t = readTriggers({ triggersPath: paths.triggersPath, fs });
  return Array.isArray(t?.triggers) ? t.triggers : [];
}

/**
 * The trigger edit's body: which flow trigger `index` runs, and optionally its `backend`, `provider` and `model`, each merged
 * only when sent so an edit of the flow leaves every other key byte-identical. The model reference is judged alone and then
 * MERGED with the entry's own `run` (PR #536's review), before the confirm. `progress` and `statusComment` (issue #644) merge
 * the same way, and so does `recover` (issue #645), judged against the entry's own `run.command` as well as its type.
 * `surface` names the row (`rowName`). `baseRun`, when given, is what the rest of the same edit makes of the entry's `run`, so
 * the merged judgement sees the list or the key that edit replaces, not the one it leaves behind. `{ plan: { index, flow,
 * backend, ref, flags, row, type, changes, mutate, target, expect, title, message, summary } }` or `{ refusal }`, where
 * `changes` is the message's `[key, before, after]` pairs (`changeText`).
 */
export function planTriggerEditCore({ params, paths, env, surface, fs = nodeFs, baseRun = null }) {
  const expect = writeInputs({ paths: [paths.triggersPath], fs });
  const list = triggerList(paths, fs);
  const cur = list[params.index];
  if (!cur) return { refusal: surface === "console" ? `no trigger at row ${params.index + 1} (have ${list.length})` : `no trigger at index ${params.index} (have ${list.length})` };
  const row = rowName("trigger", params.index, surface);
  const flow = params.flow === undefined ? undefined : String(params.flow).trim();
  if (flow === "") return { refusal: "flow must be non-empty" };
  // #227, the same allowlist the add applies and for the same reason: the picker bounds what an operator
  // can choose, and the worker bounds what actually runs (DES-PER-TRIGGER-SECRET-PROFILE -- the overlay
  // is not the reviewed artifact).
  const backend = optStr(params.backend);
  if (backend !== undefined) {
    const venue = backendRefusal(backend, env);
    if (venue !== null) return { refusal: venue };
  }
  // #502. Blank means "not sent", optStr's rule for backend above. A sent value goes through the
  // worker's validator, the one parseTriggers runs at the write, so a malformed id is refused here
  // with the loader's own message instead of after the operator approved it.
  let ref;
  const alone = refusalOf(() => {
    ref = validateModelRef({ provider: optStr(params.provider), model: optStr(params.model), ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}) }, row, paths.triggersPath);
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
  const merged = refusalOf(() => validateModelRef({ ...(baseRun === null ? rawRun : baseRun(rawRun)), ...ref }, row, paths.triggersPath));
  if (merged !== null) return { refusal: merged };
  // #644. Merged only when sent, like backend; judged against the entry's own on.type (no status comment on cron).
  const progressFault = progressRefusal(params, cur.type, row, paths.triggersPath, rawRun.command);
  if (progressFault !== null) return { refusal: progressFault };
  // Issue #712: judged only when this edit sends `recover` or a venue, against the entry as it would be after it, so an
  // edit of the flow alone is not refused over a pairing the operator did not touch (the processor refuses that one per
  // delivery, by name, as before).
  if (typeof params.recover === "boolean" || backend !== undefined) {
    const recoverVenue = recoverVenueRefusal({ recover: typeof params.recover === "boolean" ? params.recover : rawRun.recover, backend: backend ?? rawRun.backend, env });
    if (recoverVenue !== null) return { refusal: recoverVenue };
  }
  const flags = progressRun(params);
  const index = params.index;
  // What the edit changes, each as `[key, before, after]` in the order the message has always listed them: the flow,
  // then the venue, the provider and the model it was sent, then the flags. The console bolds the two values.
  const changes = [
    ...(flow === undefined ? [] : [["flow", String(cur.flow ?? "-"), flow]]),
    ...(backend === undefined ? [] : [["backend", String(cur.backend ?? "-"), backend]]),
    ...["provider", "model", "maxTurns"].filter((k) => ref[k] !== undefined).map((k) => [k, String(rawRun[k] ?? "-"), String(ref[k])]),
    ...Object.keys(flags).map((k) => [k, String(rawRun[k] ?? "-"), String(flags[k])]),
  ];
  if (changes.length === 0) return { refusal: "send at least one trigger field to edit" };
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
      row,
      type: cur.type,
      changes,
      mutate: (raw) => raw.map((tr, i) => (i === index ? { ...tr, run: { ...tr.run, ...(flow !== undefined && { flow }), ...(backend !== undefined && { backend }), ...ref, ...flags } } : tr)),
      target: paths.triggersPath,
      expect,
      ...confirmOf(`Edit ${row}`, `${row} (${cur.type}) ${changeText(changes)}`),
    },
  };
}
