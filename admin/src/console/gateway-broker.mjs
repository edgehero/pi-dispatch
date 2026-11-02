/** Console-owned human authorization. No runtime socket or terminal bytes enter this process (#754). */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { makeGatewayStore, gatewaySessionKey } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { readSandboxSessions } from "@edgehero/pi-dispatch/sandbox-sessions";
import { gatewayRunFacts } from "./gateway-run-facts.mjs";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const digest = (v) => createHash("sha256").update(v).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const hostOk = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
const tuple = (v) => JSON.stringify([v?.host, v?.id, v?.venue, v?.containerId, v?.nonce]);
const input = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k));
export const GATEWAY_BROKER_LIMITS = Object.freeze({ pending: 256, perSession: 4, pendingMs: 300000, tickMs: 1000 });
export const GATEWAY_REFUSALS = Object.freeze({
  disabled: "Browser terminals are not enabled for this host. Use Open in Terminal or copy its command.",
  configuration: "Gateway enrollment changed or could not be read. Restart from Sandboxes after checking the console host.",
  origin: "Open the console at the exact origin recorded in gateway enrollment, then restart from Sandboxes.",
  phone: "Browser terminals require a window wider than 760 pixels. Copy the sandbox command on this screen.",
  target: "This exact sandbox shell is no longer registered. Open it in your terminal first, then reload Sandboxes.",
  changed: "This launch belongs to another tab or sign-in, or has expired. Restart from Sandboxes.",
  token: "The token did not match this session's current operator. Enter that operator's token again.",
  busy: "This sign-in has too many pending terminal launches. Finish or restart an existing launch.",
  unavailable: "Browser-terminal authorization could not be read. No attachment was authorized; retry from Sandboxes.",
  audit: "The authorization audit could not be written. No terminal was authorized; inspect the console audit directory.",
  watch: "No browser driver currently permits watching this exact shell. Reload its run page or Sandboxes.",
  "watch-limit": "Three watch slots, including pending openings, are already in use. Wait until a watch stops, then verify again.",
  "watch-disabled": "The driver turned watching off or renewed consent. Reload the run page or Sandboxes before opening a fresh watch.",
  "watch-removed": "This watch was removed. Reload the run page or Sandboxes before requesting a fresh watch.",
  "driver-ended": "The browser driver disconnected or changed. Reload the run page or Sandboxes; a native-only shell cannot be watched.",
  "self-watch": "This sign-in already drives this sandbox. Use its existing workspace. Watching requires a separate operator sign-in.",
});

export function makeGatewayBroker({ redis, sessions, readTokens, findToken, readRegistry, audit, readOnly = () => false, now = Date.now, random = randomBytes, store = null, readSessions = () => readSandboxSessions(redis), readRun = async () => null, schedule = true } = {}) {
  const protocol = store ?? makeGatewayStore({ redis });
  const held = new Map();
  const pending = new Map();
  let running = false, closed = false, viewCache = null;
  const refusal = (key) => ({ refused: key, error: GATEWAY_REFUSALS[key] ?? GATEWAY_REFUSALS.unavailable });
  const protocolRefusal = (result) => refusal(["watch-limit", "watch-disabled", "watch-removed", "driver-ended", "self-watch"].includes(result?.refused) ? result.refused : "changed");
  const secret = () => random(32).toString("base64url");
  const full = (sessionId) => held.size + pending.size >= GATEWAY_BROKER_LIMITS.pending || [...held.values()].filter((e) => e.sessionId === sessionId).length + [...pending.values()].filter((id) => id === sessionId).length >= GATEWAY_BROKER_LIMITS.perSession;
  const live = (session) => {
    if (closed || readOnly() || !session || session.role !== "operator") return null;
    const file = readTokens()?.file;
    const current = file && sessions.peek(session.id, file);
    return current?.role === "operator" ? current : null;
  };
  const registryFor = (entry) => {
    const read = readRegistry();
    return read.config && read.digest === entry.registryDigest && read.config.consoleOrigin === entry.consoleOrigin && read.config.hosts[entry.target.host]?.origin === entry.gatewayOrigin;
  };
  async function registered(target) {
    const result = await readSessions();
    if (result?.unreachable) return false;
    return result?.sessions?.some((s) => tuple(s) === tuple(target)) === true;
  }
  function record(actor, kind, target, outcome = "ok", reason) {
    audit.append({ actor, action: "write", kind, target, outcome, ...(reason ? { reason } : {}) });
  }
  async function revoke(id, entry, reason) {
    held.delete(id);
    await protocol.revoke({ intentId: id, owner: entry.owner, reason });
  }
  async function tick() {
    if (running || closed || held.size === 0) return;
    running = true;
    try {
      // Capture Redis's instant BEFORE the current identity/registration judgment. Carry this
      // immutable observation into every lease write; a delayed command cannot buy five new seconds.
      let clock;
      try { clock = await protocol.observeTime(); } catch { clock = null; }
      const observedAt = clock?.ok && Number.isSafeInteger(clock.nowMs) && clock.nowMs >= 0 ? clock.nowMs : null;
      // One bounded fleet read serves every intent. Serial reads per attachment could outlive the authority lease.
      let snapshot;
      try { snapshot = await readSessions(); } catch { snapshot = { unreachable: true }; }
      await Promise.all([...held].map(async ([id, entry]) => {
        try {
          const current = !snapshot?.unreachable && snapshot?.sessions?.some((s) => tuple(s) === tuple(entry.target));
          if (!current || !live({ id: entry.sessionId, role: "operator" }) || !registryFor(entry)) { await revoke(id, entry, "session-ended"); return; }
          if (!entry.authorized && now() - entry.createdAt >= GATEWAY_BROKER_LIMITS.pendingMs) { await revoke(id, entry, "session-ended"); return; }
          if (entry.authorized) {
            if (observedAt === null) { held.delete(id); return; }
            const result = await protocol.renewAuthorization({ intentId: id, owner: entry.owner, observedAt });
            if (!result?.ok) held.delete(id);
          }
        } catch { held.delete(id); /* No renewal: its short lease expires even when the control store cannot answer. */ }
      }));
    } finally { running = false; }
  }
  const timer = schedule ? setInterval(tick, GATEWAY_BROKER_LIMITS.tickMs) : null;
  timer?.unref();
  return {
    async launch({ session, body, origin, theme = null, actor }) {
      if (!live(session)) return refusal("changed");
      if (!input(body, ["host", "id", "width", "kind"]) || !hostOk(body.host) || !idOk(body.id) || !Number.isInteger(body.width) || ![undefined, "drive", "watch"].includes(body.kind)) return refusal("target");
      const kind = body.kind ?? "drive";
      const sessionKey = gatewaySessionKey(session.id);
      if (body.width <= 760) return refusal("phone");
      const read = readRegistry();
      if (read.refusal) return refusal("configuration");
      const gatewayOrigin = read.config?.hosts[body.host]?.origin;
      if (!gatewayOrigin) return refusal("disabled");
      if (origin !== read.config.consoleOrigin) return refusal("origin");
      await tick();
      if (full(session.id)) return refusal("busy");
      let registrations;
      try { registrations = await readSessions(); } catch { return refusal("unavailable"); }
      const found = registrations?.sessions?.find((s) => s.host === body.host && s.id === body.id);
      if (registrations?.unreachable || !found || !["local", "podman"].includes(found.venue) || !live(session)) return refusal("target");
      const target = Object.fromEntries(["host", "id", "nonce", "containerId", "venue"].map((k) => [k, found[k]]));
      let room = null;
      if (kind === "watch") {
        try { room = await protocol.readRoom(target); } catch { return refusal("unavailable"); }
        if (!room?.enabled || !room.epoch) return refusal("watch");
        if (room.sessionKey === sessionKey) return refusal("self-watch");
      }
      const intentId = secret(), tabProof = secret(), handoff = secret(), owner = secret();
      // Reserve across the asynchronous store write; parallel launch requests must share the same finite cap.
      if (full(session.id)) return refusal("busy");
      pending.set(owner, session.id);
      const driver = kind === "watch" ? { intentId: room.driverIntentId, connectionId: room.driverConnectionId, epoch: room.epoch } : null;
      const entry = { sessionId: session.id, proofHash: digest(tabProof), owner, registryDigest: read.digest, gatewayOrigin, consoleOrigin: read.config.consoleOrigin, target, createdAt: now(), authorized: false, kind, sessionKey, ...(driver ? { driver, driverName: room.driverActor.name } : {}) };
      try {
        if (closed || !registryFor(entry)) return refusal("configuration");
        try { record(actor, "sandbox-browser-launch", `${target.host}:${target.id}`); } catch { return refusal("audit"); }
        let runFacts = null;
        try { const got = await readRun(target.id); runFacts = gatewayRunFacts(target, got?.record ?? got); } catch { /* Run context is optional; it never substitutes for shell authority. */ }
        const out = await protocol.createIntent({ intentId, owner, handoffHash: digest(handoff), target, gatewayOrigin, consoleOrigin: entry.consoleOrigin, theme, kind, sessionKey, runFacts, ...(driver ? { driver } : {}) });
        if (!out?.ok) return refusal("unavailable");
        if (closed || !live(session) || !registryFor(entry)) { await protocol.revoke({ intentId, owner, reason: "session-ended" }); return refusal("changed"); }
        held.set(intentId, entry);
        return { ok: true, intentId, tabProof, launchUrl: `${gatewayOrigin}/s/${intentId}#handoff=${handoff}` };
      } catch { return refusal("unavailable"); }
      finally { pending.delete(owner); }
    },
    async context({ session, body, origin }) {
      const entry = input(body, ["intentId", "tabProof", "receipt"]) && held.get(body.intentId);
      if (!entry || !SECRET.test(body.tabProof ?? "") || !SECRET.test(body.receipt ?? "") || !same(entry.proofHash, digest(body.tabProof)) || entry.sessionId !== session?.id || !live(session) || entry.authorized || now() - entry.createdAt >= GATEWAY_BROKER_LIMITS.pendingMs) return refusal("changed");
      if (origin !== entry.consoleOrigin || !registryFor(entry)) return refusal("configuration");
      try {
        const remote = await protocol.readIntent(body.intentId);
        // Only the browser that ran the bootstrap has this. A tab with the launch's proof but not its receipt did not
        // follow its own link, so that step-up would arm whoever did.
        if (!remote || remote.state !== "bound" || typeof remote.receiptHash !== "string" || !same(remote.receiptHash, digest(body.receipt)) || !await registered(entry.target)) return refusal("changed");
        if (entry.kind === "watch") {
          const room = await protocol.readRoom(entry.target);
          if (!room || room.driverIntentId !== entry.driver.intentId || room.driverConnectionId !== entry.driver.connectionId) return refusal("driver-ended");
          if (!room.enabled || room.epoch !== entry.driver.epoch) return refusal("watch-disabled");
          if (room.sessionKey === entry.sessionKey) return refusal("self-watch");
        }
        if (held.get(body.intentId) !== entry || entry.authorized || !live(session) || !registryFor(entry)) return refusal("changed");
        return { ok: true, host: entry.target.host, id: entry.target.id, by: session.name, gatewayOrigin: entry.gatewayOrigin, kind: entry.kind, ...(entry.kind === "watch" ? { driverName: entry.driverName } : {}) };
      } catch { return refusal("unavailable"); }
    },
    async authorize({ session, body, origin, actor }) {
      if (!input(body, ["intentId", "tabProof", "receipt", "token", "width"]) || !Number.isInteger(body.width) || body.width <= 760) return refusal("phone");
      if (!live(session) || !held.has(body.intentId)) return refusal("changed");
      let clock;
      try { clock = await protocol.observeTime(); } catch { return refusal("unavailable"); }
      if (!clock?.ok || !Number.isSafeInteger(clock.nowMs) || clock.nowMs < 0) return refusal("unavailable");
      const observedAt = clock.nowMs;
      const checked = await this.context({ session, body: { intentId: body.intentId, tabProof: body.tabProof, receipt: body.receipt }, origin });
      if (!checked.ok) return checked;
      const entry = held.get(body.intentId);
      if (!entry || entry.authorized) return refusal("changed");
      const file = readTokens()?.file;
      const token = typeof body.token === "string" && body.token.length <= 512 ? body.token : "";
      const matched = file && token ? findToken(file, token) : null;
      // Authenticate the original identity, never promote a different operator's token or replace the session.
      if (!matched || matched.role !== "operator" || matched.sha256 !== session.tokenHash || matched.name !== session.name || !live(session)) {
        try { record(actor, "sandbox-browser-step-up", `${entry.target.host}:${entry.target.id}`, "refused", "token-mismatch"); } catch { return refusal("audit"); }
        return refusal("token");
      }
      if (!registryFor(entry)) return refusal("configuration");
      try { record(actor, "sandbox-browser-step-up", `${entry.target.host}:${entry.target.id}`); } catch { return refusal("audit"); }
      try {
        const result = await protocol.authorizeIntent({ intentId: body.intentId, owner: entry.owner, actor, observedAt });
        if (!result?.ok) return protocolRefusal(result);
        // The store write may have waited while the operator signed out or this host changed. Its success is
        // not current authority until the live session, enrollment and immutable registration pass again.
        if (held.get(body.intentId) !== entry || !live(session) || !registryFor(entry) || !await registered(entry.target) || !live(session) || !registryFor(entry)) {
          await revoke(body.intentId, entry, "session-ended");
          return refusal("changed");
        }
        entry.authorized = true;
        entry.proofHash = null;
        return { ok: true, returnUrl: `${entry.gatewayOrigin}/s/${body.intentId}` };
      } catch { return refusal("unavailable"); }
    },
    async view() {
      // A cache is presentation only. Launch and step-up always read current room authority again.
      const at = now();
      if (viewCache && at >= viewCache.at && at - viewCache.at < 1000) return viewCache.promise;
      const promise = (async () => {
        const read = readRegistry();
        if (!read.config) return { enabledHosts: [], sessions: [], drivers: [], ...(read.refusal ? { problem: read.refusal } : {}) };
        let shells;
        try { shells = await readSessions(); } catch { shells = { unreachable: true }; }
        const sessions = (shells?.sessions ?? []).slice(0, 256);
        let partial = Boolean(shells?.unreachable || shells?.more || shells?.unreadable || (shells?.sessions?.length ?? 0) > 256);
        const drivers = (await Promise.all(sessions.filter((s) => read.config.hosts[s.host]).map(async (s) => {
          try {
            const room = await protocol.readRoom(s);
            if (!room) return null;
            return { host: s.host, id: s.id, containerId: s.containerId, nonce: s.nonce, by: room.driverActor.name, ownerKey: digest(room.driverConnectionId), watching: room.enabled, watchers: Object.values(room.watchers).map((watcher) => ({ name: watcher.actor.name, state: watcher.state })) };
          } catch { partial = true; return null; }
        }))).filter(Boolean);
        return { enabledHosts: Object.keys(read.config.hosts), sessions, drivers, partial };
      })();
      viewCache = { at, promise };
      try { return await promise; } catch { if (viewCache?.promise === promise) viewCache = null; return { enabledHosts: [], sessions: [], drivers: [], partial: true, problem: GATEWAY_REFUSALS.unavailable }; }
    },
    tick,
    async close() {
      closed = true; clearInterval(timer);
      await Promise.allSettled([...held].map(([id, entry]) => revoke(id, entry, "session-ended")));
    },
  };
}
