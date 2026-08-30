/**
 * The deployment POINTER (INT-DEPLOYMENT-POINTER-CONTRACT, issue #92): the one file that lets the admin's
 * `/dispatch` find a deployment the setup wizard built somewhere else. `resolvePaths` (read-model.mjs) is
 * env-only BY CONTRACT and stays untouched -- a wizard-built deployment in `~/pi-dispatch` is invisible from
 * any other cwd -- so this module layers the pointer's entries into `process.env` ONCE at extension load.
 * Env always wins, key by key; with the layering in place, every `resolvePaths(process.env)` call site
 * (every command and every LLM tool) is covered with zero signature changes.
 *
 * The contract in one line: **the pointer resolves paths only, never credentials, never capability
 * grants.** The read side enforces that with an allowlist (`POINTER_ENV_ALLOWLIST`) rather than a
 * blocklist: anything else in `env` is DROPPED silently (the operator-file unknown-fields-dropped
 * policy) -- most pointedly `PI_DISPATCH_RUN_ROOTS`, because a pointer that could widen the AI-run
 * folder allowlist would be a second, unreviewed door to a capability the panel deliberately gates
 * behind the operator's own env; and any credential-shaped key, because secrets travel through the
 * operator's env and the token broker, never through a file the wizard writes world-readable.
 *
 * Failure doctrine: a broken pointer must leave `/dispatch` exactly as functional as before the pointer
 * existed (env then cwd defaults). So `readPointer` NEVER throws -- unparseable JSON, a non-object, a
 * missing/invalid version, a newer version all come back as `{ ignored: reason }` -- and the apply path
 * retains a one-line notice for the next `/dispatch` to surface (the REBUILT_NOTICE idiom: a surfaced
 * warning, never a throw). This is deliberately weaker than the subscriptions file's loud refusal; the
 * reconciliation is recorded in the spec: the pointer is an availability aid, not a data file.
 *
 * Staleness is the wizard's problem, not the reader's: `readPointer` never stats `deploymentDir` or any
 * env value. The reader is pure over the file text plus one `fs.readFileSync`, so it cannot slow a
 * session down or invent a second existence check that disagrees with the wizard's.
 */

import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** The pointer schema version this build understands. A NEWER file is ignored with a notice, never guessed at. */
export const POINTER_VERSION = 1;

/**
 * The only env keys a pointer may set -- the path/URL variables `resolvePaths` reads to find a deployment's
 * files. An allowlist, not a blocklist: a new resolvePaths variable gets pointer coverage only by being
 * added HERE, on review. `PI_DISPATCH_RUN_ROOTS` is absent on purpose (a capability grant, not a path),
 * as is every credential-shaped key (the pointer never carries secrets).
 */
export const POINTER_ENV_ALLOWLIST = Object.freeze([
  "VALKEY_URL",
  "PI_LOGS_DIR",
  "PI_SETTINGS_FILE",
  "PI_TRIGGERS_FILE",
  "PI_PAUSE_WINDOWS_FILE",
  "PI_SCOPED_LIMITS_FILE",
  "PI_SUBSCRIPTIONS_FILE",
]);

const POINTER_BASENAME = "pi-dispatch-deployment.json";

// ---- module state: the once-per-process memo, the retained notice, and the owned-key ledger ----

// Whether the process-wide layering has happened. applyDeploymentPointer is called from the extension
// factory, which pi may in principle evaluate more than once; the memo makes every call after the first
// a no-op so the layering result cannot depend on load order or count.
let appliedOnce = false;

// The retained one-line notice from an ignored pointer, surfaced once by the next /dispatch. A single
// slot, latest-wins: there is one pointer file, so there is at most one thing to say about it.
let notice;

// The keys THIS MODULE wrote into the env, and therefore the only keys a re-apply may update. A var the
// operator exported is never in here, so it can never be overwritten -- not even by the wizard's own
// re-apply after it rewrites the pointer.
const ownedKeys = new Set();

/**
 * Where the pointer lives: `PI_DISPATCH_DEPLOYMENT_FILE`, defaulting to pi's own agent dir
 * (`PI_CODING_AGENT_DIR` or `~/.pi/agent` -- the repo's one established home-dir pattern, resolved the
 * way worker/src/import-pi.mjs does). `||` on both reads so an EMPTY string falls back like an unset one,
 * matching resolvePaths' own defaulting idiom.
 */
export function pointerPath(env = process.env) {
  return (
    env.PI_DISPATCH_DEPLOYMENT_FILE ||
    join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), POINTER_BASENAME)
  );
}

/**
 * Validate + filter one raw parsed pointer into the canonical `{ version, deploymentDir, env }` shape.
 * The single normalizer for BOTH sides: `readPointer` runs every file through it, and `writePointer`
 * runs every candidate through it before writing -- so a pointer that would be ignored on read is never
 * written, and a disallowed env key can neither be applied NOR persisted through this API.
 *
 * Returns `{ pointer }` or `{ ignored: reason }`. Never throws.
 */
function normalizePointer(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ignored: "not a JSON object" };
  }
  // version is the one field that cannot be retrofitted: required, integer >= 1. A NEWER version means a
  // future wizard wrote a shape this build does not understand -- ignore the whole file (degrading to the
  // pre-pointer behavior) rather than half-read it, and name both versions so the operator knows which
  // side to upgrade.
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return { ignored: "missing or invalid version (integer >= 1 required)" };
  }
  if (raw.version > POINTER_VERSION) {
    return { ignored: `version ${raw.version} is newer than the supported version ${POINTER_VERSION}` };
  }
  if (typeof raw.deploymentDir !== "string" || !isAbsolute(raw.deploymentDir)) {
    return { ignored: "deploymentDir must be an absolute path" };
  }
  // An absent env map reads as {} (a pointer may name only the deployment dir); a PRESENT non-object env
  // is a malformed file and ignored whole -- silently "fixing" it would mask a hand-edit gone wrong.
  const rawEnv = raw.env === undefined ? {} : raw.env;
  if (rawEnv === null || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return { ignored: "env must be an object" };
  }
  const env = {};
  // Iterating the ALLOWLIST (not the file's keys) is what makes every unknown key -- run roots,
  // credentials, typos -- vanish without a branch to forget. Values must be non-empty strings; and every
  // path value must be ABSOLUTE, because a relative path would resolve against whichever session's cwd
  // happens to read it -- silently wrong in exactly the cross-directory case the pointer exists to fix.
  // VALKEY_URL is a URL, not a filesystem path, so it is exempt from the absoluteness gate only.
  for (const key of POINTER_ENV_ALLOWLIST) {
    const value = rawEnv[key];
    if (typeof value !== "string" || value === "") continue;
    if (key !== "VALKEY_URL" && !isAbsolute(value)) continue;
    env[key] = value;
  }
  // Unknown TOP-LEVEL fields drop here too: only the three canonical fields are ever kept or re-written.
  return { pointer: { version: raw.version, deploymentDir: raw.deploymentDir, env } };
}

/**
 * Read and normalize the pointer file. Returns exactly one of:
 *   `{ pointer }`          -- a valid pointer, env already allowlist-filtered
 *   `{ ignored: reason }`  -- a file that exists but cannot be honored (never a throw)
 *   `{ absent: true }`     -- no file: the normal pre-wizard state, not an error
 *
 * Pure over the file text + `fs.readFileSync`: no stat of `deploymentDir`, no module-state mutation
 * (notices are retained by the APPLY path, not here) -- stale-deployment detection is the wizard's job.
 */
export function readPointer({ path = pointerPath(), fs = nodeFs } = {}) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { absent: true };
    // Any other read failure (permissions, EISDIR, ...) degrades like a malformed file: ignored, named.
    return { ignored: `unreadable: ${err?.message ?? err}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ignored: `unparseable JSON: ${err.message}` };
  }
  return normalizePointer(raw);
}

/**
 * The shared layering step for apply/re-apply. A key is written only when the pointer may govern it:
 * either nobody set it (`undefined` -- and note that an operator's EMPTY export counts as set, because
 * exporting `PI_LOGS_DIR=""` is still operator intent this module must not second-guess), or this module
 * itself set it on an earlier pass (`ownedKeys`). An ignored pointer retains the one-line notice and
 * applies nothing.
 */
function layerPointer(env, fs) {
  const path = pointerPath(env);
  const res = readPointer({ path, fs });
  if (res.ignored) {
    notice = `deployment pointer ignored: ${res.ignored} (${path})`;
    return { applied: [] };
  }
  if (res.absent) return { applied: [] };
  const applied = [];
  for (const [key, value] of Object.entries(res.pointer.env)) {
    if (env[key] !== undefined && !ownedKeys.has(key)) continue; // the operator's export always wins
    env[key] = value;
    ownedKeys.add(key);
    applied.push(key);
  }
  return { applied };
}

/**
 * Layer the pointer's allowed, absolute env entries into `env` (default `process.env`), once per process.
 * Returns `{ applied: [keys] }` (informational; empty on memo hit / absent / ignored).
 *
 * Called at the TOP of the extension factory on purpose: `resolvePaths(process.env)` runs per-command AND
 * per LLM tool call, so factory-time layering is in place before any resolve -- including for an operator
 * who never types `/dispatch` and only lets the model call `dispatch_status`. Memoized so a second factory
 * evaluation cannot re-read the file mid-session; the ONLY refresh path is `reapplyDeploymentPointer`,
 * which the wizard calls deliberately after rewriting the file.
 */
export function applyDeploymentPointer(env = process.env, { fs = nodeFs } = {}) {
  if (appliedOnce) return { applied: [] };
  appliedOnce = true;
  return layerPointer(env, fs);
}

/**
 * Re-read the pointer and refresh the layering -- the wizard's post-write hook, so a just-built deployment
 * takes effect in the SAME pi session without a restart. Same signature and return as apply, but it skips
 * the memo. Safety is unchanged: it may set a still-unset key or update a key THIS MODULE set earlier,
 * and never one the operator exported (even one exported after the first apply). A key the module owns
 * that a rewritten pointer no longer carries keeps its last applied value until process restart -- the
 * re-apply updates, it never unsets, so a half-typed pointer edit cannot yank paths out from under a
 * live panel.
 */
export function reapplyDeploymentPointer(env = process.env, { fs = nodeFs } = {}) {
  appliedOnce = true; // a later plain apply stays a no-op; this call IS the refresh
  return layerPointer(env, fs);
}

/**
 * Return the retained one-line notice once, then clear it -- undefined when there is nothing to say.
 * The `/dispatch` handler drains this into `notify(..., "warning")`, which is the pointer's entire error
 * surface: one line, once, never a throw.
 */
export function takePointerNotice() {
  const n = notice;
  notice = undefined;
  return n;
}

/**
 * Write a pointer for the wizard: validated through the SAME normalizer as the read side (a pointer that
 * would be ignored on read is refused here with `{ invalid: reason }` and the file is untouched), then
 * written atomically (tmp + rename, the repo's write idiom) as 2-space JSON with a trailing newline --
 * hand-editable thereafter. Note it persists the NORMALIZED shape: disallowed env keys and relative path
 * values are dropped before the bytes exist, so this API cannot be used to smuggle a credential or a
 * capability grant into the file. Returns `{ ok: true }` on success.
 */
export function writePointer({ path = pointerPath(), pointer, fs = nodeFs } = {}) {
  const res = normalizePointer(pointer);
  if (res.ignored) return { invalid: res.ignored };
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(res.pointer, null, 2)}\n`);
  fs.renameSync(tmp, path);
  return { ok: true };
}

/**
 * TEST-ONLY: clear the process-wide memo, the retained notice, and the owned-key ledger, so each test
 * case starts from the fresh-process state. Named to make any production call site an obvious review
 * failure; production code has no reason to reset -- the memo being process-wide is the point.
 */
export function resetForTests() {
  appliedOnce = false;
  notice = undefined;
  ownedKeys.clear();
}
