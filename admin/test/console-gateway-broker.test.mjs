import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { makeGatewayBroker } from "../src/console/gateway-broker.mjs";
import { makeSessionStore, sessionDigest } from "../src/console/sessions.mjs";
import { findToken } from "../../worker/src/console-tokens.mjs";

const AT = Date.UTC(2026, 10, 2, 12);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const TOKEN = "pdc_" + "x".repeat(43), OTHER = "pdc_" + "y".repeat(43);
function fixture() {
  let at = AT, readOnly = false, tokenRead = true;
  const file = { version: 1, generation: 0, tokens: [{ name: "ops", role: "operator", sha256: sha(TOKEN) }, { name: "other", role: "operator", sha256: sha(OTHER) }] };
  const sessions = makeSessionStore({ now: () => at, idleMs: 1000, maxMs: 3600000 });
  const create = (entry = file.tokens[0]) => {
    const { id } = sessions.create({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation });
    return sessions.peek(id, file);
  };
  const session = create(), actor = { name: session.name, role: session.role, session: sessionDigest(session.id) };
  const target = { host: "mini1", id: "gh-42", venue: "local", nonce: "a".repeat(32), containerId: "b".repeat(64), by: "terminal", since: AT - 1000, at: AT };
  let registrations = { sessions: [target] };
  const registry = { config: { consoleOrigin: "http://localhost:4790", hosts: { mini1: { origin: "http://127.0.0.1:4791" } } }, digest: "r1" };
  const values = new Map(), audit = [], renews = [], revokes = [];
  const store = {
    async observeTime() { return { ok: true, nowMs: at }; },
    async createIntent(input) { values.set(input.intentId, { ...structuredClone(input), state: "pending" }); return { ok: true }; },
    async readIntent(id) { return values.get(id) ?? null; },
    async authorizeIntent({ intentId, actor }) { const value = values.get(intentId); if (value.state !== "bound") return { refused: "changed" }; value.state = "authorized"; value.actor = actor; return { ok: true }; },
    async renewAuthorization(input) { renews.push(input); return { ok: true }; },
    async revoke(input) { revokes.push(input); values.get(input.intentId).state = "revoked"; return { ok: true }; },
  };
  const broker = makeGatewayBroker({ store, sessions, readTokens: () => tokenRead ? { file } : { refusal: "unreadable" }, findToken, readRegistry: () => registry, readSessions: async () => registrations, readOnly: () => readOnly, audit: { append: (row) => audit.push(row) }, now: () => at, schedule: false });
  const origin = registry.config.consoleOrigin;
  const launch = (body = { host: target.host, id: target.id, width: 1440 }, as = session) => broker.launch({ session: as, body, origin, actor });
  const bind = (out) => { values.get(out.intentId).state = "bound"; };
  const context = (out, as = session, proof = out.tabProof) => broker.context({ session: as, origin, body: { intentId: out.intentId, tabProof: proof } });
  const authorize = (out, token = TOKEN, as = session) => broker.authorize({ session: as, origin, actor, body: { intentId: out.intentId, tabProof: out.tabProof, token, width: 1440 } });
  return { broker, store, session, sessions, file, registry, values, actor, target, audit, renews, revokes, launch, bind, context, authorize, create,
    advance: (ms) => at += ms, readonly: () => readOnly = true, unreadable: () => tokenRead = false, registrations: (next) => registrations = next };
}
test("launch is secret-free outside its explicit handoff and requires an existing enrolled shell", async () => {
  const f = fixture(), out = await f.launch();
  assert.equal(out.ok, true); assert.match(out.intentId, /^[A-Za-z0-9_-]{43}$/);
  const url = new URL(out.launchUrl);
  assert.equal(url.origin, "http://127.0.0.1:4791"); assert.equal(url.pathname, `/s/${out.intentId}`); assert.equal(url.search, "");
  const handoff = new URLSearchParams(url.hash.slice(1)).get("handoff");
  assert.match(handoff, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(handoff, out.tabProof);
  const stored = f.values.get(out.intentId);
  assert.equal(stored.handoffHash, sha(handoff)); assert.deepEqual(Object.keys(stored.target).sort(), ["containerId", "host", "id", "nonce", "venue"]);
  for (const secret of [TOKEN, f.session.id, handoff, out.tabProof]) assert.ok(!JSON.stringify([...f.values.values(), f.audit]).includes(secret));
  assert.equal((await f.launch({ host: "unknown", id: "gh-42", width: 1440 })).refused, "disabled");
  assert.equal((await f.launch({ host: "mini1", id: "sb-unopened", width: 1440 })).refused, "target");
  assert.equal((await f.launch({ host: "mini1", id: "gh-42", width: 760 })).refused, "phone");
  assert.equal((await f.launch({ host: "mini1", id: "gh-42", width: 1440, command: "bash" })).refused, "target");
  await f.broker.close();
});
test("step-up requires bound bootstrap, original tab, original session and freshly matching token", async () => {
  const f = fixture(), out = await f.launch();
  assert.equal((await f.context(out)).refused, "changed");
  f.bind(out);
  assert.equal((await f.context(out, f.session, randomBytes(32).toString("base64url"))).refused, "changed");
  assert.equal((await f.context(out, f.create())).refused, "changed");
  assert.equal((await f.authorize(out, OTHER)).refused, "token");
  assert.equal(f.values.get(out.intentId).state, "bound");
  assert.equal((await f.context(out)).host, "mini1");
  assert.deepEqual(await f.authorize(out), { ok: true, returnUrl: `http://127.0.0.1:4791/s/${out.intentId}` });
  assert.equal((await f.authorize(out)).refused, "changed");
  assert.equal(f.sessions.peek(f.session.id, f.file).id, f.session.id, "step-up never replaces the original session");
  await f.broker.close();
});
test("background authority renews without extending console idle and revokes even with no next request", async () => {
  const f = fixture(), out = await f.launch(); f.bind(out); assert.equal((await f.authorize(out)).ok, true);
  f.advance(900); await f.broker.tick(); assert.equal(f.renews.length, 1);
  f.advance(101); await f.broker.tick(); assert.equal(f.revokes.length, 1);
  assert.equal(f.sessions.peek(f.session.id, f.file), null);
  await f.broker.close();
});
for (const [name, mutate] of [
  ["token rotation", (f) => f.file.tokens.splice(0, 1)],
  ["role change", (f) => f.file.tokens[0].role = "viewer"],
  ["sessions end-all", (f) => f.file.generation++],
  ["read-only", (f) => f.readonly()],
  ["unreadable token file", (f) => f.unreadable()],
  ["enrollment change", (f) => f.registry.digest = "changed"],
  ["replaced container", (f) => f.registrations({ sessions: [{ ...f.target, containerId: "c".repeat(64) }] })],
  ["unknown tracking", (f) => f.registrations({ unreachable: true })],
]) test(`${name} revokes original browser authority`, async () => {
  const f = fixture(), out = await f.launch(); f.bind(out); assert.equal((await f.authorize(out)).ok, true);
  mutate(f); await f.broker.tick(); assert.equal(f.revokes.length, 1); assert.equal(f.renews.length, 0); await f.broker.close();
});
test("viewer, agent and read-only refuse before private dependencies and opening audit failure mints nothing", async () => {
  let calls = 0;
  const f = fixture();
  for (const role of ["viewer", "agent"]) assert.equal((await f.launch(undefined, { ...f.session, role })).refused, "changed");
  f.readonly(); assert.equal((await f.launch()).refused, "changed");
  const g = fixture();
  const broker = makeGatewayBroker({ sessions: g.sessions, readTokens: () => ({ file: g.file }), findToken, readRegistry: () => g.registry, readSessions: async () => ({ sessions: [g.target] }), audit: { append() { throw new Error("disk"); } }, store: { createIntent() { calls++; } }, now: () => AT, schedule: false });
  assert.equal((await broker.launch({ session: g.session, actor: g.actor, origin: g.registry.config.consoleOrigin, body: { host: "mini1", id: "gh-42", width: 1440 } })).refused, "audit");
  assert.equal(calls, 0); await broker.close(); await f.broker.close(); await g.broker.close();
});
test("a grant write finishing after read-only or session revocation is immediately revoked", async () => {
  for (const change of [(f) => f.readonly(), (f) => f.file.tokens.splice(0, 1), (f) => f.registry.digest = "changed"]) {
    const f = fixture(), out = await f.launch(); f.bind(out);
    const authorize = f.store.authorizeIntent;
    let release, started;
    const ready = new Promise((resolve) => started = resolve);
    f.store.authorizeIntent = (input) => new Promise((resolve) => { release = async () => resolve(await authorize(input)); started(); });
    const waiting = f.authorize(out); await ready; change(f); await release();
    assert.equal((await waiting).refused, "changed");
    assert.equal(f.values.get(out.intentId).state, "revoked");
    assert.equal(f.revokes.length, 1); await f.broker.close();
  }
});
test("context cannot authorize a stale snapshot after its owner closes during a control read", async () => {
  const f = fixture(), out = await f.launch(); f.bind(out);
  const snapshot = structuredClone(f.values.get(out.intentId));
  let release, started;
  const ready = new Promise((resolve) => started = resolve);
  f.store.readIntent = () => new Promise((resolve) => { release = () => resolve(snapshot); started(); });
  const waiting = f.context(out); await ready; await f.broker.close(); release();
  assert.equal((await waiting).refused, "changed");
});
test("parallel launches reserve the per-session bound before asynchronous control writes", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.launch()));
  assert.equal(results.filter((r) => r.ok).length, 4);
  assert.equal(results.filter((r) => r.refused === "busy").length, 8);
  await f.broker.close();
});
test("step-up carries its own pre-judgment Redis observation despite overlapping observations", async () => {
  const f = fixture(), out = await f.launch(); f.bind(out);
  let release, entered, observedAt;
  const ready = new Promise(resolve => { entered = resolve; }), originalRead = f.store.readIntent, originalAuthorize = f.store.authorizeIntent;
  f.store.readIntent = async id => { entered(); await new Promise(resolve => { release = resolve; }); return originalRead(id); };
  f.store.authorizeIntent = async input => { observedAt = input.observedAt; return originalAuthorize(input); };
  const waiting = f.authorize(out); await ready;
  f.advance(100); assert.equal((await f.store.observeTime()).nowMs, AT + 100);
  release(); assert.equal((await waiting).ok, true); assert.equal(observedAt, AT, "a concurrent read must not move this judgment's deadline forward");
  await f.broker.close();
});
test("an unreadable or invalid Redis clock cannot mint or refresh authority", async () => {
  for (const value of [{ refused: "control-unavailable" }, { ok: true, nowMs: Infinity }]) {
    const f = fixture(), out = await f.launch(); f.bind(out); f.store.observeTime = async () => value;
    assert.equal((await f.authorize(out)).refused, "unavailable"); assert.equal(f.values.get(out.intentId).state, "bound"); await f.broker.close();
    const active = fixture(), opened = await active.launch(); active.bind(opened); assert.equal((await active.authorize(opened)).ok, true);
    active.store.observeTime = async () => value; await active.broker.tick(); assert.equal(active.renews.length, 0); await active.broker.close();
  }
});
