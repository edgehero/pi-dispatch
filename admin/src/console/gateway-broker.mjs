/** Console-owned human authorization. No runtime socket or terminal bytes enter this process (#754). */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { makeGatewayStore } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { readSandboxSessions } from "@edgehero/pi-dispatch/sandbox-sessions";

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
});

export function makeGatewayBroker({ redis, sessions, readTokens, findToken, readRegistry, audit, readOnly = () => false, now = Date.now, random = randomBytes, store = null, readSessions = () => readSandboxSessions(redis), schedule = true } = {}) {
  const protocol = store ?? makeGatewayStore({ redis });
  const held = new Map();
  const pending = new Map();
  let running = false, closed = false;
  const refusal = (key) => ({ refused: key, error: GATEWAY_REFUSALS[key] ?? GATEWAY_REFUSALS.unavailable });
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
      if (!input(body, ["host", "id", "width"]) || !hostOk(body.host) || !idOk(body.id) || !Number.isInteger(body.width)) return refusal("target");
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
      const intentId = secret(), tabProof = secret(), handoff = secret(), owner = secret();
      // Reserve across the asynchronous store write; parallel launch requests must share the same finite cap.
      if (full(session.id)) return refusal("busy");
      pending.set(owner, session.id);
      const entry = { sessionId: session.id, proofHash: digest(tabProof), owner, registryDigest: read.digest, gatewayOrigin, consoleOrigin: read.config.consoleOrigin, target, createdAt: now(), authorized: false };
      try {
        if (closed || !registryFor(entry)) return refusal("configuration");
        try { record(actor, "sandbox-browser-launch", `${target.host}:${target.id}`); } catch { return refusal("audit"); }
        const out = await protocol.createIntent({ intentId, owner, handoffHash: digest(handoff), target, gatewayOrigin, consoleOrigin: entry.consoleOrigin, theme });
        if (!out?.ok) return refusal("unavailable");
        if (closed || !live(session) || !registryFor(entry)) { await protocol.revoke({ intentId, owner, reason: "session-ended" }); return refusal("changed"); }
        held.set(intentId, entry);
        return { ok: true, intentId, tabProof, launchUrl: `${gatewayOrigin}/s/${intentId}#handoff=${handoff}` };
      } catch { return refusal("unavailable"); }
      finally { pending.delete(owner); }
    },
    async context({ session, body, origin }) {
      const entry = input(body, ["intentId", "tabProof"]) && held.get(body.intentId);
      if (!entry || !SECRET.test(body.tabProof ?? "") || !same(entry.proofHash, digest(body.tabProof)) || entry.sessionId !== session?.id || !live(session) || entry.authorized || now() - entry.createdAt >= GATEWAY_BROKER_LIMITS.pendingMs) return refusal("changed");
      if (origin !== entry.consoleOrigin || !registryFor(entry)) return refusal("configuration");
      try {
        const remote = await protocol.readIntent(body.intentId);
        if (!remote || remote.state !== "bound" || !await registered(entry.target)) return refusal("changed");
        if (held.get(body.intentId) !== entry || entry.authorized || !live(session) || !registryFor(entry)) return refusal("changed");
        return { ok: true, host: entry.target.host, id: entry.target.id, by: session.name, gatewayOrigin: entry.gatewayOrigin };
      } catch { return refusal("unavailable"); }
    },
    async authorize({ session, body, origin, actor }) {
      if (!input(body, ["intentId", "tabProof", "token", "width"]) || !Number.isInteger(body.width) || body.width <= 760) return refusal("phone");
      if (!live(session) || !held.has(body.intentId)) return refusal("changed");
      let clock;
      try { clock = await protocol.observeTime(); } catch { return refusal("unavailable"); }
      if (!clock?.ok || !Number.isSafeInteger(clock.nowMs) || clock.nowMs < 0) return refusal("unavailable");
      const observedAt = clock.nowMs;
      const checked = await this.context({ session, body: { intentId: body.intentId, tabProof: body.tabProof }, origin });
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
        if (!result?.ok) return refusal("changed");
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
    tick,
    async close() {
      closed = true; clearInterval(timer);
      await Promise.allSettled([...held].map(([id, entry]) => revoke(id, entry, "session-ended")));
    },
  };
}
