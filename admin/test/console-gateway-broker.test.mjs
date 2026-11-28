import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { makeGatewayBroker } from "../src/console/gateway-broker.mjs";
import { makeSessionStore, sessionDigest } from "../src/console/sessions.mjs";
import { findToken } from "../../worker/src/console-tokens.mjs";
import { GATEWAY_AUTH_MS, gatewayHash } from "../../worker/src/sandbox-gateway-protocol.mjs";

const AT = Date.UTC(2026, 10, 2, 12);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const TOKEN = "pdc_" + "x".repeat(43), OTHER = "pdc_" + "y".repeat(43);
const RECEIPT = "r".repeat(43);
function fixture({ readRun = async () => null, idleMs = 1000 } = {}) {
  let at = AT, readOnly = false, tokenRead = true, tokenThrows = false, tokenReads = 0;
  const file = { version: 1, generation: 0, tokens: [{ name: "ops", role: "operator", sha256: sha(TOKEN) }, { name: "other", role: "operator", sha256: sha(OTHER) }] };
  const sessions = makeSessionStore({ now: () => at, idleMs, maxMs: 3600000 });
  const create = (entry = file.tokens[0]) => {
    const { id } = sessions.create({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation });
    return sessions.peek(id, file);
  };
  const session = create(), actor = { name: session.name, role: session.role, session: sessionDigest(session.id) };
  const target = { host: "mini1", id: "gh-42", venue: "local", nonce: "a".repeat(32), containerId: "b".repeat(64), by: "terminal", since: AT - 1000, at: AT };
  let registrations = { sessions: [target] };
  // The fleet read the broker awaits. `slowFleet` holds the next one open until released, as a loaded runner would.
  let fleet = async () => registrations;
  const slowFleet = () => {
    let release, entered;
    const reading = new Promise((resolve) => { entered = resolve; });
    fleet = () => { fleet = async () => registrations; entered(); return new Promise((resolve) => { release = () => resolve(registrations); }); };
    return { entered: reading, release: () => release?.() };
  };
  const registry = { config: { consoleOrigin: "http://localhost:4790", hosts: { mini1: { origin: "http://127.0.0.1:4791" } } }, digest: "r1" };
  const values = new Map(), audit = [], renews = [], revokes = [], revokedAt = [];
  const store = {
    async readRoom() { return null; },
    async observeTime() { return { ok: true, nowMs: at }; },
    async createIntent(input) { values.set(input.intentId, { ...structuredClone(input), state: "pending" }); return { ok: true }; },
    async readIntent(id) { return values.get(id) ?? null; },
    async authorizeIntent({ intentId, actor }) { const value = values.get(intentId); if (value.state !== "bound") return { refused: "changed" }; value.state = "authorized"; value.actor = actor; return { ok: true }; },
    async renewAuthorization(input) { renews.push(input); return { ok: true }; },
    async revoke(input) { revokes.push(input); revokedAt.push(at); values.get(input.intentId).state = "revoked"; return { ok: true }; },
  };
  const broker = makeGatewayBroker({ store, sessions, readTokens: () => { tokenReads++; if (tokenThrows) throw new Error("EIO"); return tokenRead ? { file } : { refusal: "unreadable" }; }, findToken, readRegistry: () => registry, readSessions: () => fleet(), readRun, readOnly: () => readOnly, audit: { append: (row) => audit.push(row) }, now: () => at, schedule: false });
  const origin = registry.config.consoleOrigin;
  const launch = (body = { host: target.host, id: target.id, width: 1440 }, as = session) => broker.launch({ session: as, body, origin, actor });
  const bind = (out) => { Object.assign(values.get(out.intentId), { state: "bound", receiptHash: gatewayHash(RECEIPT) }); };
  const context = (out, as = session, proof = out.tabProof, receipt = RECEIPT) => broker.context({ session: as, origin, body: { intentId: out.intentId, tabProof: proof, receipt } });
  const authorize = (out, token = TOKEN, as = session, receipt = RECEIPT) => broker.authorize({ session: as, origin, actor, body: { intentId: out.intentId, tabProof: out.tabProof, receipt, token, width: 1440 } });
  return { broker, store, session, sessions, file, registry, values, actor, target, audit, renews, revokes, revokedAt, slowFleet, launch, bind, context, authorize, create,
    advance: (ms) => at += ms, readonly: () => readOnly = true, unreadable: () => tokenRead = false, throwing: (value) => tokenThrows = value, tokenReads: () => tokenReads, registrations: (next) => registrations = next };
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

// Two operators hold authorized terminals, so a tick still has a fleet read to wait on after one of them is revoked.
async function twoDrivers(f) {
  const out = await f.launch(); f.bind(out); assert.equal((await f.authorize(out)).ok, true);
  const other = f.create(f.file.tokens[1]), theirs = await f.launch(undefined, other); f.bind(theirs);
  assert.equal((await f.authorize(theirs, OTHER, other)).ok, true);
  return { out, theirs };
}
const renewed = (f, id) => f.renews.filter((r) => r.intentId === id);
test("a removed token is revoked before a slow fleet read answers, inside the lease it last renewed (issues #1039, #1048)", async () => {
  // Revoked after that lease, the gateway's own deadline comes first and the browser reads "could not confirm its
  // authority" instead of "Operator session ended".
  const f = fixture({ idleMs: 3600000 }), { out, theirs } = await twoDrivers(f);
  f.advance(1000); await f.broker.tick();
  const lease = renewed(f, out.intentId).at(-1).observedAt + GATEWAY_AUTH_MS;
  f.file.tokens.splice(0, 1);
  const slow = f.slowFleet();
  f.advance(1000); const ticking = f.broker.tick(); await slow.entered;
  assert.deepEqual(f.revokes.map((r) => r.intentId), [out.intentId], "revoked before the fleet read answers");
  f.advance(GATEWAY_AUTH_MS + 1000); slow.release(); await ticking;
  assert.equal(f.revokes.length, 1);
  assert.ok(f.revokedAt[0] < lease, `revoked at +${f.revokedAt[0] - AT} ms, after the lease it last renewed ran out at +${lease - AT} ms`);
  // The renewal that tick still makes carries the clock it read before its fleet read, never a later one.
  assert.deepEqual(renewed(f, theirs.intentId).map((r) => r.observedAt - AT), [1000, 2000]);
  await f.broker.close();
});
test("a tick still in flight does not hold back a removed token's revoke, and its own renewals rest on a judgment made after its clock read (issues #1039, #1048)", async () => {
  const f = fixture({ idleMs: 3600000 }), { out } = await twoDrivers(f), before = renewed(f, out.intentId).length, slow = f.slowFleet();
  f.advance(1000); const first = f.broker.tick(); await slow.entered;
  f.file.tokens.splice(0, 1);
  f.advance(1000); await f.broker.tick();
  assert.deepEqual(f.revokes.map((r) => r.intentId), [out.intentId], "the next tick revokes it at once instead of skipping while the first one runs");
  assert.equal(f.revokedAt[0], AT + 2000);
  slow.release(); await first;
  assert.equal(renewed(f, out.intentId).length, before, "the tick in flight renews nothing it no longer holds");
  assert.equal(f.revokes.length, 1, "and does not revoke it twice");
  await f.broker.close();
  // With no later tick, the one in flight judges again after its fleet read: a token removed after its clock read gets no renewal.
  const g = fixture({ idleMs: 3600000 }), mine = await twoDrivers(g), held = renewed(g, mine.out.intentId).length, wait = g.slowFleet();
  g.advance(1000); const only = g.broker.tick(); await wait.entered;
  g.file.tokens.splice(0, 1); wait.release(); await only;
  assert.deepEqual(g.revokes.map((r) => r.intentId), [mine.out.intentId]); assert.equal(renewed(g, mine.out.intentId).length, held);
  assert.equal(renewed(g, mine.theirs.intentId).length, 1, "while the operator whose token stays is renewed");
  await g.broker.close();
});
test("the early pass also revokes on a changed enrollment or an ended sign-in, before the tick awaits anything, and leaves a read that throws to the full judgment (issues #1039, #1048)", async () => {
  for (const [why, change] of [["enrollment", (f) => f.registry.digest = "changed"], ["sign-in", (f) => f.sessions.destroy(f.session.id)]]) {
    const f = fixture({ idleMs: 3600000 }), out = await f.launch(); f.bind(out); assert.equal((await f.authorize(out)).ok, true);
    const slow = f.slowFleet(), renewals = f.renews.length;
    change(f); f.advance(1000);
    const ticking = f.broker.tick();
    assert.deepEqual(f.revokes.map((r) => r.intentId), [out.intentId], `${why}: revoked before the clock or fleet read is even asked`);
    slow.release(); await ticking;
    assert.equal(f.revokes.length, 1); assert.equal(f.renews.length, renewals, `${why}: and nothing renewed`);
    await f.broker.close();
  }
  // A token file whose read throws is no judgment of anyone: the early pass skips it, and the full one drops the
  // attachment unrenewed, as it always has, so its short lease expires without a revocation anybody decided.
  const f = fixture({ idleMs: 3600000 }); await twoDrivers(f);
  const renewals = f.renews.length;
  f.throwing(true); f.advance(1000); await f.broker.tick();
  assert.deepEqual([f.revokes.length, f.renews.length], [0, renewals]);
  f.throwing(false); f.advance(1000); await f.broker.tick();
  assert.equal(f.renews.length, renewals, "dropped, so a later readable tick renews neither");
  // One read of the token file serves the whole early pass, however many attachments it judges.
  const g = fixture({ idleMs: 3600000 }); await twoDrivers(g);
  const before = g.tokenReads(); g.advance(1000); const counted = g.broker.tick();
  assert.equal(g.tokenReads() - before, 1, "the early pass reads the token file once");
  await counted;
  await f.broker.close(); await g.broker.close();
});

function watchingRoom() {
  return { driverIntentId: randomBytes(32).toString("base64url"), driverConnectionId: randomBytes(32).toString("base64url"), driverActor: { name: "lee", role: "operator", session: "d".repeat(12) }, enabled: true, epoch: randomBytes(32).toString("base64url"), watchers: {} };
}

test("v2 intent session binding is stable for one sign-in, different after same-name login, and never a browser credential", async () => {
  const f = fixture(), first = await f.launch(), second = await f.launch();
  const a = f.values.get(first.intentId), b = f.values.get(second.intentId);
  assert.equal(a.kind, "drive"); assert.equal(a.runFacts, null); assert.equal(Object.hasOwn(a, "driver"), false);
  assert.equal(a.sessionKey, sha("sandbox-workbench-session\0" + f.session.id)); assert.equal(a.sessionKey, b.sessionKey);
  const other = await f.launch(undefined, f.create());
  assert.notEqual(f.values.get(other.intentId).sessionKey, a.sessionKey);
  for (const value of [first, second, f.audit]) assert.equal(JSON.stringify(value).includes(a.sessionKey), false);
  await f.broker.close();
});

test("broker puts only exact six record facts into its private intent; lookup failure never invents context", async () => {
  const f = fixture({ readRun: async (id) => ({ record: { jobId: id, host: "mini1", outcome: "completed", reason: "awaiting-input", project: "web", target: "acme/web#42", flow: "fix", endedAt: new Date(AT).toISOString(), question: "PRIVATE_QUESTION", token: TOKEN } }) });
  const opened = await f.launch(), facts = f.values.get(opened.intentId).runFacts;
  assert.deepEqual(facts, { id: "gh-42", outcome: "awaiting-input", project: "web", target: "acme/web#42", flow: "fix", endedAt: new Date(AT).toISOString() });
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|token|question/);
  assert.equal(JSON.stringify(opened).includes("acme/web"), false);
  await f.broker.close();
  const failed = fixture({ readRun: async () => { throw new Error("PRIVATE"); } });
  const fallback = await failed.launch(); assert.equal(fallback.ok, true); assert.equal(failed.values.get(fallback.intentId).runFacts, null); await failed.broker.close();
});

test("watch launch derives exact driver/consent from trusted room and still requires its own tab/session/token", async () => {
  const f = fixture(), room = watchingRoom();
  assert.equal((await f.launch({ host: "mini1", id: "gh-42", kind: "watch", width: 1440 })).refused, "watch");
  f.store.readRoom = async (target) => { assert.equal(target.containerId, f.target.containerId); return room; };
  assert.equal((await f.launch({ host: "mini1", id: "gh-42", kind: "watch", width: 1440, driver: room })).refused, "target");
  const out = await f.launch({ host: "mini1", id: "gh-42", kind: "watch", width: 1440 });
  const stored = f.values.get(out.intentId);
  assert.equal(stored.kind, "watch"); assert.deepEqual(stored.driver, { intentId: room.driverIntentId, connectionId: room.driverConnectionId, epoch: room.epoch });
  f.bind(out);
  assert.equal((await f.context(out)).driverName, "lee"); assert.equal((await f.context(out)).kind, "watch");
  assert.equal((await f.context(out, f.create())).refused, "changed");
  assert.equal((await f.authorize(out, OTHER)).refused, "token");
  assert.equal((await f.authorize(out)).ok, true);
  assert.equal(f.sessions.peek(f.session.id, f.file).id, f.session.id);
  await f.broker.close();
});

test("watch consent/driver changes and full slots return their own actionable refusal without consuming a bound opening", async () => {
  for (const why of ["watch-limit", "watch-disabled", "watch-removed", "driver-ended", "self-watch"]) {
    const f = fixture(), room = watchingRoom(); f.store.readRoom = async () => room;
    const out = await f.launch({ host: "mini1", id: "gh-42", kind: "watch", width: 1440 }); f.bind(out);
    f.store.authorizeIntent = async () => ({ refused: why });
    const result = await f.authorize(out);
    assert.equal(result.refused, why); assert.doesNotMatch(result.error, /another tab or sign-in/); assert.equal(f.values.get(out.intentId).state, "bound");
    if (why === "watch-limit") assert.match(result.error, /Three watch slots/);
    await f.broker.close();
  }
  for (const change of [(room) => room.enabled = false, (room) => room.epoch = randomBytes(32).toString("base64url"), (room) => room.driverConnectionId = randomBytes(32).toString("base64url")]) {
    const f = fixture(), room = watchingRoom(); f.store.readRoom = async () => room;
    const out = await f.launch({ host: "mini1", id: "gh-42", kind: "watch", width: 1440 }); f.bind(out); change(room);
    assert.ok(["watch-disabled", "driver-ended"].includes((await f.context(out)).refused)); await f.broker.close();
  }
});

test("self-watch refuses the exact driving sign-in before minting, while same-name distinct sign-in may watch", async () => {
  const f = fixture(), room = watchingRoom(); room.driverActor.name = f.session.name; room.sessionKey = sha("sandbox-workbench-session\0" + f.session.id);
  f.store.readRoom = async () => room;
  const body = { host: "mini1", id: "gh-42", kind: "watch", width: 1440 };
  const denied = await f.launch(body);
  assert.equal(denied.refused, "self-watch"); assert.match(denied.error, /existing workspace/);
  assert.equal(f.values.size, 0); assert.equal(f.audit.length, 0);
  const other = f.create(); assert.equal(other.name, f.session.name); assert.notEqual(other.id, f.session.id);
  const opening = await f.launch(body, other); assert.equal(opening.ok, true); f.bind(opening);
  assert.equal((await f.context(opening, other)).kind, "watch");
  const result = await f.broker.authorize({ session: other, origin: f.registry.config.consoleOrigin, actor: { name: other.name, role: other.role, session: sessionDigest(other.id) }, body: { intentId: opening.intentId, tabProof: opening.tabProof, receipt: RECEIPT, token: TOKEN, width: 1440 } });
  assert.equal(result.ok, true); await f.broker.close();
});

test("operator presentation separates native opener from driver and strips room secrets; unavailable is never empty", async () => {
  const f = fixture(), room = watchingRoom(); room.watchers.one = { actor: { name: "sam", role: "operator", session: "e".repeat(12) }, state: "pending", connectionId: randomBytes(32).toString("base64url") };
  f.store.readRoom = async () => room;
  const first = await f.broker.view();
  assert.equal(first.sessions[0].by, "terminal"); assert.equal(first.drivers[0].by, "lee"); assert.deepEqual(first.drivers[0].watchers, [{ name: "sam", state: "pending" }]);
  for (const value of [room.driverIntentId, room.driverConnectionId, room.epoch, room.driverActor.session, room.watchers.one.connectionId, f.session.id]) assert.equal(JSON.stringify(first).includes(value), false);
  f.advance(1001); f.store.readRoom = async () => { throw new Error("PRIVATE"); };
  const unavailable = await f.broker.view(); assert.equal(unavailable.partial, true); assert.equal(unavailable.drivers.length, 0);
  // Which way the view is partial (issue #988): a room that did not answer is a read that failed; the first view, whole,
  // is neither partial nor unread.
  assert.deepEqual([first.partial, first.unread, first.more, first.unreadable, unavailable.unread], [false, false, 0, 0, true]);
  await f.broker.close();
});

test("a view that is partial says which way: a read that did not answer, a list cut at its cap, or registrations that do not parse (issue #988)", async () => {
  const view = async (shells) => {
    const f = fixture();
    const broker = makeGatewayBroker({ sessions: f.sessions ?? { peek: () => null }, readTokens: () => ({ refusal: "unreadable" }), findToken: () => null, readRegistry: () => f.registry, readSessions: shells, readRun: async () => null, readOnly: () => false, store: { readRoom: async () => null }, now: () => 1 });
    try { return await broker.view(); } finally { await broker.close(); await f.broker.close(); }
  };
  const whole = await view(async () => ({ sessions: [], more: 0, unreadable: 0 }));
  assert.deepEqual([whole.partial, whole.unread, whole.more, whole.unreadable], [false, false, 0, 0]);
  const cut = await view(async () => ({ sessions: [], more: 1, unreadable: 0 }));
  assert.deepEqual([cut.partial, cut.unread, cut.more, cut.unreadable], [true, false, 1, 0]);
  const rows = await view(async () => ({ sessions: [], more: 0, unreadable: 2 }));
  assert.deepEqual([rows.partial, rows.unread, rows.more, rows.unreadable], [true, false, 0, 2]);
  for (const shells of [async () => ({ sessions: [], unreachable: true }), async () => { throw new Error("Command timed out"); }]) {
    const unread = await view(shells);
    assert.deepEqual([unread.partial, unread.unread, unread.more, unread.unreadable], [true, true, 0, 0]);
  }
});

test("a step-up from a tab that never followed its own link arms nobody", async () => {
  // The attack: an operator keeps the launch's tab proof, sends its link to someone else, whose browser binds the intent, then steps
  // up from their own tab. That browser would hold a shell in the operator's name. Only the browser that bound it has the receipt.
  const f = fixture(), out = await f.launch(); f.bind(out);
  let authorized = 0; const real = f.store.authorizeIntent; f.store.authorizeIntent = async (...values) => { authorized++; return real(...values); };
  for (const receipt of ["x".repeat(43), "", undefined]) {
    assert.equal((await f.context(out, f.session, out.tabProof, receipt ?? null)).ok, undefined, "the context is refused");
    assert.equal((await f.authorize(out, TOKEN, f.session, receipt ?? null)).ok, undefined, "and so is the step-up");
  }
  assert.equal(authorized, 0);
  assert.equal((await f.authorize(out)).ok, true, "the browser that holds it goes on");
  assert.equal(authorized, 1);
});
