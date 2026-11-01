/** Person-only browser setup. Private plans and keys never enter generic tickets, flash, or live snapshots (#774). */
import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { SETUP_OPERATIONS, SETUP_REASONS, SETUP_LIMITS } from "@edgehero/pi-dispatch/setup-contract";
import { addToken, revokeToken, readTokensSnapshot, TOKEN_NAME_RE } from "@edgehero/pi-dispatch/console-tokens";
import { loginCodesDir, mintLoginCode } from "./console/login-codes.mjs";
import { apiKeyVariable, nonApiKeyKind } from "@edgehero/pi-dispatch/provider-key";
import { acquireSetupLock } from "@edgehero/pi-dispatch/setup-lock";
import { PROVIDER_KEY_NAMES } from "./provider-key-names.mjs";

export const SETUP_ACTION_NAMES = Object.freeze([...SETUP_OPERATIONS, "setup-viewer-add", "setup-viewer-revoke"]);
export const SETUP_PRIVATE_TTL_MS = 60_000;
export const SETUP_PRIVATE_MAX = 32;
const STARTS_WORKER = new Set(["setup-worker-install", "setup-worker-start", "setup-worker-restart"]);
const KEY_SLOT = name => typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name) && nonApiKeyKind(name) === null;
const canonicalKey = provider => apiKeyVariable(typeof provider === "string" && Object.hasOwn(PROVIDER_KEY_NAMES, provider) ? PROVIDER_KEY_NAMES[provider] : []);
const EFFECT_WORDS = Object.freeze({ "write-worker-unit": "Write the worker user service", "write-receiver-unit": "Write the receiver user service", "start-worker": "Start the worker", "start-receiver": "Start the receiver", "stop-worker": "Stop the worker", "stop-receiver": "Stop the receiver", "restart-worker": "Restart the worker", "restart-receiver": "Restart the receiver", "write-stack-files": "Write the deployment's runtime stack files", "start-valkey": "Start the deployment's Valkey", "start-proxy": "Start the deployment's egress proxy", "start-keeper": "Start the rootless network keeper", "write-provider-key": "Write the provider API key once", "publish-doctor": "Run non-live doctor and publish its sanitized checks" });
export const SETUP_REASON_WORDS = Object.freeze(Object.fromEntries(SETUP_REASONS.map(reason => [reason, {
  "setup-busy": "Another setup operation holds the deployment lock. Wait for it. After a crash, inspect its PID and external effects on the host; remove .pi-dispatch-setup.lock only when no setup operation remains.",
  "provider-shadowed": "Another credential source takes precedence; use the host's terminal to review it.",
  "provider-managed": "This provider uses a managed subscription. Review its connection on Connections.",
  "key-present": "The provider key is already set; setup does not replace an existing credential.",
  "remote-runtime": "The runtime is not proven local to this console; use the worker host's terminal.",
  "proxy-refresh-required": "The proxy needs a replacement or rules refresh; use pi-dispatch up in the terminal.",
  "missing-receiver": "Install the receiver package on this host before starting its service.",
  "process-timeout": "The host operation timed out. Some effects may have landed; inspect the host before retrying.",
  "plan-stale": "The deployment changed since preview. Preview it again.",
}[reason] ?? `Host setup reports ${reason}. Inspect the deployment with pi-dispatch doctor or use its terminal command.`])));
const problem = (refusal, status = 409) => ({ refusal, status });
const invalid = (text, partial = false) => ({ invalid: text, ...(partial ? { partial: true } : {}) });
const configurationDrift = exposure => exposure?.reason === "configuration-drift" ? "The deployment configuration changed or conflicts with this console environment. Review the shell/deployment overrides and restart the console before previewing again. Nothing was started." : null;
const stepOf = action => action.startsWith("setup-worker-") ? "worker" : action.startsWith("setup-receiver-") ? "forge" : action === "setup-egress-start" ? "egress" : action === "setup-provider-key" ? "provider" : action === "setup-doctor" ? "doctor" : "token";
const safeId = value => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** All dependencies are explicit; production supplies the fixed worker child and the real session/token readers. */
export function makeSetupActions({ broker, enabled = false, reason = null, operations = SETUP_ACTION_NAMES, deployment, tokensPath, provider = null, readExposure = async () => ({ complete: false }), sessions, readTokens, isAuthorized, now = Date.now, fs = nodeFs, random = randomBytes, mintCode = mintLoginCode, interval = setInterval, clearIntervalFn = clearInterval, ttlMs = SETUP_PRIVATE_TTL_MS, maxPrivate = SETUP_PRIVATE_MAX } = {}) {
  const held = new Map();
  const receipts = new Map();
  const progress = new Map();
  const active = new Map();
  let closed = false;
  function currentProviderKey() {
    let selected;
    try { selected = typeof provider === "function" ? provider() : provider; } catch { return null; }
    const key = canonicalKey(selected);
    return KEY_SLOT(key) ? key : null;
  }
  const granted = () => enabled === true && !closed;
  function authorized(session) {
    if (!granted() || session?.role !== "operator" || typeof session.id !== "string") return false;
    try {
      if (typeof isAuthorized === "function") return isAuthorized(session) === true;
      const file = readTokens?.()?.file;
      const current = file && sessions?.peek?.(session.id, file);
      return current?.role === "operator" && current.name === session.name;
    } catch { return false; }
  }
  function discard(ref) {
    const entry = held.get(ref);
    if (!entry) return;
    entry.value?.fill(0);
    entry.value = null;
    held.delete(ref);
  }
  function endSession(id) {
    for (const [ref, entry] of held) if (entry.session.id === id) discard(ref);
    for (const entry of active.values()) if (entry.session.id === id) entry.controller.abort();
  }
  function sweep() {
    const at = now();
    for (const [ref, entry] of held) if (entry.expiresAt <= at || !authorized(entry.session)) discard(ref);
    for (const [id, receipt] of receipts) if (receipt.expiresAt <= at) receipts.delete(id);
    for (const entry of active.values()) if (!authorized(entry.session)) entry.controller.abort();
  }
  const timer = interval(sweep, 250);
  timer?.unref?.();
  function hold(action, session, data, value) {
    sweep();
    if (action === "setup-provider-key" && [...held.values()].some(e => e.action === action && e.session.id === session.id)) return problem("A private key preview is already pending. Cancel it before entering another key.");
    if (held.size >= maxPrivate) return problem("Setup has reached its private preview limit. Confirm or cancel an existing preview before retrying.", 429);
    const ref = random(16).toString("hex");
    const expiresAt = now() + Math.min(ttlMs, SETUP_PRIVATE_TTL_MS);
    held.set(ref, { action, session: { ...session }, ...data, value: value ? Buffer.from(value, "utf8") : null, expiresAt });
    return { target: action === "setup-viewer-add" || action === "setup-viewer-revoke" ? data.name : stepOf(action), payload: { setupRef: ref }, ttlMs: expiresAt - now(), expiresAt, onDiscard: () => discard(ref) };
  }
  function tokenSnapshot() {
    const got = readTokensSnapshot({ path: tokensPath, fs });
    return got.file ? got : null;
  }
  async function preview(action, body, { session } = {}) {
    if (!authorized(session)) return problem(reason ?? "Local host setup is unavailable for this sign-in. Use the terminal commands.", 403);
    if (!SETUP_ACTION_NAMES.includes(action)) return problem("Unknown setup action.", 400);
    if (!operations.includes(action)) return problem("This operation is unavailable for the local deployment. Use its applicable terminal instructions.", 403);
    if (action === "setup-viewer-add" || action === "setup-viewer-revoke") {
      const name = body.name;
      if (typeof name !== "string" || !TOKEN_NAME_RE.test(name)) return problem("A viewer name uses 1 to 32 lowercase letters, digits, dots, underscores or hyphens.", 400);
      const before = tokenSnapshot();
      if (!before) return problem("The protected tokens file could not be read. Run pi-dispatch doctor on the host.");
      if (action === "setup-viewer-add" && before.file.tokens.some(t => t.name === name)) return problem("That token name already exists. Choose a new viewer name.");
      let identity = null;
      if (action === "setup-viewer-revoke") {
        const receipt = safeId(body.identity) ? receipts.get(body.identity) : null;
        identity = receipt?.name === name ? receipt.entry : null;
        if (!identity || !before.file.tokens.some(t => t.name === name && t.role === "viewer" && t.sha256 === identity.sha256 && t.createdAt === identity.createdAt)) return problem("The created viewer entry is no longer available for this Undo. Use the host token commands to review it.");
      }
      return { ...hold(action, session, { name, before, identity }), summary: [action === "setup-viewer-add" ? `Add viewer ${name}` : `Revoke viewer ${name}`, action === "setup-viewer-add" ? "Create a viewer entry and a one-use link valid for 60 seconds. It grants a session, not a retained token; another person needs a tunnel to this console. The host can issue another link later." : "End this viewer's sessions on their next request. A replaced entry will never be revoked by this Undo."] };
    }
    let value;
    if (action === "setup-provider-key") {
      value = body.value;
      if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > SETUP_LIMITS.keyBytes || /[\u0000-\u0020\u007f]|\$|`/.test(value)) return problem("Enter an API key of at most 4 KiB without whitespace, controls or command references. Nothing was saved.", 400);
    }
    let exposure = null;
    if (STARTS_WORKER.has(action)) {
      try { exposure = await readExposure(); } catch { exposure = null; }
      if (exposure?.complete !== true || !Number.isSafeInteger(exposure.at) || !Array.isArray(exposure.lines)) return problem(configurationDrift(exposure) ?? "Current queue and cron exposure could not be read completely. Nothing was started; check Valkey and preview again.");
    }
    let got;
    try { got = await broker?.preview(action, {}, {}); } catch { return problem("The local setup planner could not be reached. Use its terminal command.", 503); }
    if (!got || got.state === "refused" || !got.plan && got.state !== "unchanged") return problem(SETUP_REASON_WORDS[got?.reason] ?? "The local setup planner could not return a valid plan.");
    if (got.state === "unchanged") return { unchanged: SETUP_REASON_WORDS[got.reason] ?? "No host change is needed." };
    if (action === "setup-provider-key") {
      const canonical = canonicalKey(got.plan.provider);
      if (!KEY_SLOT(got.plan.key) || got.plan.key !== canonical) return problem("This provider has no supported create-only API key slot.");
    }
    const stored = hold(action, session, { plan: got.plan, exposure }, value);
    if (stored.refusal) return stored;
    const effects = got.plan.effects.map(effect => EFFECT_WORDS[effect]).filter(Boolean);
    const summary = [effects[0] ?? "Confirm host setup", `On ${got.plan.host}, as account ${got.plan.account}, through ${got.plan.manager}.`, ...effects.slice(1), ...(exposure?.lines ?? []), ...(action.endsWith("-stop") || action.endsWith("-restart") ? ["SIGTERM can interrupt in-flight work, including a job admitted after this preview. Stopping cannot undo money already spent."] : []), ...(action === "setup-provider-key" ? [`Write ${got.plan.key} once; the value is never shown. A running worker needs a separately confirmed restart to load it.`] : [])];
    return { ...stored, summary };
  }
  async function apply(action, entry, { session } = {}) {
    const ref = entry.payload?.setupRef;
    const privateEntry = held.get(ref);
    // Redemption burns private input even when the caller/action is wrong.
    held.delete(ref);
    if (!privateEntry) return invalid("The private setup preview expired or was cancelled. Enter its inputs and preview again.");
    const controller = new AbortController();
    let viewerLock;
    try {
      if (active.size > 0) return invalid("Another setup operation is still running. Wait for its result before previewing again.");
      if (privateEntry.session.id !== session?.id || privateEntry.action !== action || privateEntry.expiresAt <= now() || !authorized(session)) return invalid("The setup sign-in, action or private preview changed. Preview again.");
      active.set(ref, { session: privateEntry.session, controller });
      if (action.startsWith("setup-viewer-")) {
        viewerLock = acquireSetupLock(deployment, { fs, random });
        if (viewerLock.refusal) return invalid("Another host setup operation holds this deployment lock, or the deployment cannot be verified. Inspect the host and preview again after it finishes.");
        if (!authorized(session)) return invalid("The setup sign-in ended before the viewer write. Nothing was changed.");
        if (action === "setup-viewer-revoke") {
          const result = revokeToken({ path: tokensPath, name: privateEntry.name, identity: privateEntry.identity, expect: privateEntry.before.text, fs, random });
          return result.invalid ? invalid("The viewer entry or tokens file changed; nothing was revoked.") : { ok: true, state: "applied" };
        }
        const result = addToken({ path: tokensPath, name: privateEntry.name, role: "viewer", expect: privateEntry.before.text, fs, random, now });
        if (!result.entry) return invalid("The tokens file changed or the viewer could not be saved. Review it on the host before retrying.");
        delete result.token;
        const identity = random(16).toString("hex");
        receipts.set(identity, { name: privateEntry.name, entry: result.entry, expiresAt: now() + 300_000 });
        const binding = { sha256: result.entry.sha256, createdAt: result.entry.createdAt, role: "viewer", generation: privateEntry.before.file.generation };
        const mintAt = now();
        const minted = mintCode({ dir: loginCodesDir(tokensPath), name: privateEntry.name, binding, fs, random, now: () => mintAt });
        if (!minted.code) return invalid(`Viewer ${privateEntry.name} was saved, but no invitation could be made. On the host, run pi-dispatch-console link --name ${privateEntry.name}; use token revoke to remove it. Do not add it again.`, true);
        return { ok: true, state: "applied", invitation: { href: `/login/code#${minted.code}&next=/setup`, expiresAt: mintAt + 60_000, name: privateEntry.name }, viewer: { name: privateEntry.name, identity } };
      }
      if (STARTS_WORKER.has(action)) {
        let exposure;
        try { exposure = await readExposure(); } catch { exposure = null; }
        if (exposure?.complete !== true) return invalid(configurationDrift(exposure) ?? "Current queue and cron exposure could not be rechecked. Nothing was started.");
        if (privateEntry.exposure?.identity && exposure.identity !== privateEntry.exposure.identity) return invalid("Queue or cron exposure changed after preview. Nothing was started; preview it again.");
      }
      if (!authorized(session)) return invalid("The setup sign-in ended before dispatch. Nothing was started.");
      const input = action === "setup-provider-key" ? { provider: privateEntry.plan.provider, key: privateEntry.plan.key, value: privateEntry.value.toString("utf8") } : {};
      const step = stepOf(action);
      const update = (state, stage, reason = null) => progress.set(step, { id: ref, step, state, stage, atMs: now(), ...(reason ? { reason } : {}), host: privateEntry.plan.workerName ?? privateEntry.plan.host });
      update("starting", "dispatched");
      let result;
      try { result = await broker.apply(action, { expected: privateEntry.plan.digest, input }, { signal: controller.signal, isAuthorized: () => authorized(session) }); }
      catch { result = { state: "unknown", reason: "readback-unavailable" }; }
      input.value = undefined;
      const state = result?.state;
      const why = SETUP_REASON_WORDS[result?.reason] ?? "The host operation has an unknown outcome. Inspect the host before retrying.";
      if (state === "applied" || state === "unchanged") {
        update(STARTS_WORKER.has(action) ? "starting" : "applied", STARTS_WORKER.has(action) ? "waiting-heartbeat" : "complete");
        return { ok: true, state, setup: { step, stage: STARTS_WORKER.has(action) ? "waiting-heartbeat" : "complete", reason: result.reason } };
      }
      update(state === "partial" || state === "unknown" ? state : "refused", "complete", result?.reason);
      return invalid(why, state === "partial" || state === "unknown");
    } finally {
      viewerLock?.release?.();
      privateEntry.value?.fill(0);
      privateEntry.value = null;
      active.delete(ref);
    }
  }
  function state(role, snapshot) {
    for (const [step, entry] of progress) {
      if (entry.stage !== "waiting-heartbeat" && !(entry.step === "worker" && entry.state === "timeout")) continue;
      const hosts = snapshot?.hostBudgets;
      const readAt = snapshot?.hostsReadAt;
      // Age belongs to the registry observation, not the time this cached snapshot is rendered.
      // Valkey's expiry age avoids promoting a worker timestamp from a skewed host clock.
      const observed = Number.isSafeInteger(readAt) && readAt > entry.atMs && readAt <= now() && !snapshot?.queue?.fleetDegraded;
      const hit = observed && Array.isArray(hosts) && hosts.some(h => h.name === entry.host && Number.isSafeInteger(h.ttlAgeMs) && h.ttlAgeMs >= 0 && h.ttlAgeMs <= 60_000 && readAt - h.ttlAgeMs > entry.atMs);
      if (hit) { const { reason: _reason, ...ready } = entry; progress.set(step, { ...ready, state: "applied", stage: "complete" }); }
      else if (now() - entry.atMs >= SETUP_LIMITS.readinessMs) progress.set(step, { ...entry, state: "timeout", stage: "complete", reason: "readback-unavailable" });
    }
    const providerKey = currentProviderKey();
    return { enabled: granted(), reason: granted() ? null : reason ?? "Host setup is not enabled on this console; use the terminal commands.", actions: granted() && role === "operator" ? SETUP_ACTION_NAMES.filter(name => operations.includes(name) && (name !== "setup-provider-key" || providerKey !== null)) : [], providerKey: role === "operator" ? providerKey : null, progress: [...progress.values()].map(({ host, ...safe }) => safe), allowlistCount: null };
  }
  return { preview, apply, state, discard, endSession,
    cancel({ sessionId, ref }) { const entry = held.get(ref); if (entry?.session.id === sessionId) discard(ref); },
    close() { closed = true; clearIntervalFn(timer); for (const ref of held.keys()) discard(ref); for (const entry of active.values()) entry.controller.abort(); receipts.clear(); },
    privateSize: () => held.size,
  };
}
