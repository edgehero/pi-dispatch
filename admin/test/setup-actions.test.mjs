import assert from "node:assert/strict";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { addToken, readTokensFile, rotateToken, revokeToken, endAllSessions } from "@edgehero/pi-dispatch/console-tokens";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeSetupActions, SETUP_ACTION_NAMES, isSetupKeyAction } from "../src/setup-actions.mjs";
import { PROVIDER_KEY_NAMES } from "../src/provider-key-names.mjs";
import { apiKeyVariable } from "@edgehero/pi-dispatch/provider-key";
import { actionNamed, previewAction, confirmAction, cancelAction, readSetupExposure } from "../src/console/actions.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { consumeLoginCode, invitationMatches, loginCodesDir, mintLoginCode } from "../src/console/login-codes.mjs";
import { makeSessionStore } from "../src/console/sessions.mjs";
import { SETUP_OPERATIONS } from "@edgehero/pi-dispatch/setup-contract";
import { acquireSetupLock } from "@edgehero/pi-dispatch/setup-lock";

const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const KEY = "setup-provider-private-canary-739c";
const keySlot = provider => apiKeyVariable(PROVIDER_KEY_NAMES[provider] ?? []);
const keyPlan = (provider, action = "setup-provider-key", extra = {}) => ({ digest: "d".repeat(64), component: "provider", host: "host1", account: "account", manager: "systemd", effects: ["write-provider-key"], provider, key: keySlot(provider), mode: action === "setup-provider-key-replace" ? "replace" : "add", aliases: Object.keys(PROVIDER_KEY_NAMES).filter(name => keySlot(name) === keySlot(provider)).sort(), source: action === "setup-provider-key-replace" ? "deployment-env" : "none", ...extra });
function delayedPlanner() {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const calls = [];
  return { calls, started: seen, release, broker: { async preview(action, input, { signal } = {}) {
    const call = { action, input: structuredClone(input), signal };
    calls.push(call);
    started(call);
    await gate;
    return { state: "planned", plan: keyPlan(input.provider, action) };
  } } };
}
function fixture(t, options = {}) {
  let at = T0, sweep;
  const now = () => at;
  const dir = tempDir("pd-setup-actions-");
  const path = join(dir, "tokens.json");
  const operator = addToken({ path, name: "operator", role: "operator", now });
  delete operator.token;
  const readTokens = () => readTokensFile({ path });
  const sessions = makeSessionStore({ now });
  const { id } = sessions.create({ name: "operator", role: "operator", tokenHash: operator.entry.sha256, generation: 0 });
  const session = sessions.peek(id, readTokens().file);
  const calls = [];
  const broker = {
    async preview(action, input) { calls.push(["plan", action, input]); return { state: "planned", plan: isSetupKeyAction(action) ? keyPlan(input.provider, action) : { digest: "d".repeat(64), component: "worker", host: "host1", account: "account", manager: "systemd", effects: [action === "setup-worker-stop" ? "stop-worker" : "start-worker"] } }; },
    async apply(action, entry) { calls.push(["apply", action, structuredClone(entry)]); if (isSetupKeyAction(action)) fs.writeFileSync(join(dir, ".env"), `${entry.input.key}=${entry.input.value}\n`, { mode: 0o600 }); return { state: "applied", reason: "ready" }; },
    ...options.broker,
  };
  const service = makeSetupActions({ broker, enabled: true, deployment: dir, tokensPath: path, provider: "anthropic", sessions, readTokens, now, interval: fn => { sweep = fn; return { unref() {} }; }, clearIntervalFn() {}, readExposure: async () => ({ complete: true, at: now(), lines: ["No queued jobs; zero cron triggers. Future arrivals remain possible."], identity: "known" }), ...options, broker });
  t.after(() => service.close());
  const audit = [], flash = [];
  const deps = { now, fs, tickets: makeConfirmTickets({ now }), sessions: { setFlash: (_id, change) => flash.push(structuredClone(change)) }, actionDeps: { setup: service }, audit: { append(row) { if (deps.failAudit) throw Object.assign(new Error("full"), { code: "ENOSPC" }); audit.push(structuredClone(row)); return { seq: audit.length }; } }, log() {} };
  function ctx(body, as = session) { return { body, session: as, deps, route: { path: "/api/act/setup-test" }, actor: () => ({ name: as.name, role: as.role, session: null }), record: row => audit.push(row), json: (status, body) => ({ status, body }) }; }
  return { service, now, path, dir, calls, session, sessions, readTokens, deps, audit, flash, advance: ms => { at += ms; }, tick: () => sweep(), ctx,
    preview: (name, body = {}, as = session) => previewAction(ctx(isSetupKeyAction(name) && !Object.hasOwn(body, "provider") ? { provider: typeof options.provider === "function" ? options.provider() : options.provider ?? "anthropic", ...body } : body, as), actionNamed(name)),
    confirm: (name, ticket, as = session) => confirmAction(ctx({ ticket }, as), actionNamed(name)),
  };
}

test("setup registrations and policy cover every worker operation plus the two private viewer operations", () => {
  assert.deepEqual(SETUP_ACTION_NAMES, [...SETUP_OPERATIONS, "setup-viewer-add", "setup-viewer-revoke"]);
  for (const name of SETUP_ACTION_NAMES) assert.equal(actionNamed(name).agent.mode, "person", name);
});

test("confirmed API key reaches only its host writer; ordinary tickets, previews, flash and audit hold neither value nor input digest", async t => {
  const f = fixture(t);
  const p = await f.preview("setup-provider-key", { value: KEY });
  assert.equal(p.status, 200);
  assert.equal(p.body.expiresAt, T0 + 60_000);
  assert.equal(f.service.privateSize(), 1);
  assert.equal(fs.existsSync(join(f.dir, ".env")), false, "preview never writes");
  assert.doesNotMatch(JSON.stringify(p), new RegExp(KEY));
  assert.ok(!JSON.stringify(p).includes("d".repeat(64)), "private expected input digest is not response metadata");
  const result = await f.confirm("setup-provider-key", p.body.ticket);
  assert.equal(result.status, 200);
  assert.equal(fs.readFileSync(join(f.dir, ".env"), "utf8"), `ANTHROPIC_API_KEY=${KEY}\n`);
  assert.equal(f.calls.filter(row => row[0] === "apply").length, 1);
  assert.equal(f.service.privateSize(), 0);
  assert.ok(!JSON.stringify([result, f.audit, f.flash]).includes(KEY));
  assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 409, "replay has no second effect");
});

test("redeeming a key drops the parent's submitted value before a delayed host apply returns", async t => {
  let input, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { broker: { async apply(_action, entry) {
    input = entry.input;
    assert.equal(input.value, KEY, "the transport receives the confirmed value before the parent drops it");
    entered();
    await gate;
    return { state: "applied", reason: "ready" };
  } } });
  t.after(release);
  const preview = await f.preview("setup-provider-key", { provider: "deepseek", value: KEY });
  assert.equal(preview.status, 200);
  const pending = f.confirm("setup-provider-key", preview.body.ticket);
  try {
    await started;
    assert.equal(input.value, undefined, "waiting on the child must not retain the plaintext in its parent input object");
    assert.equal(input.provider, "deepseek");
    assert.equal(input.key, "DEEPSEEK_API_KEY");
    assert.equal(f.service.privateSize(), 0, "redemption releases the private ticket before the child finishes");
    assert.doesNotMatch(JSON.stringify([f.audit, f.flash]), new RegExp(KEY));
  } finally { release(); }
  assert.equal((await pending).status, 200);
});

test("audit failure, cancellation, wrong-session redemption and proactive expiry all dispose the private key without applying", async t => {
  for (const mode of ["audit", "cancel", "foreign", "expiry", "revocation", "role", "shutdown"]) {
    const f = fixture(t);
    const p = await f.preview("setup-provider-key", { value: KEY });
    assert.equal(p.status, 200);
    if (mode === "audit") { f.deps.failAudit = true; assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 500); }
    if (mode === "cancel") assert.equal(cancelAction(f.ctx({ ticket: p.body.ticket }), actionNamed("setup-provider-key")).status, 200);
    if (mode === "foreign") assert.equal((await f.confirm("setup-provider-key", p.body.ticket, { ...f.session, id: "different" })).status, 409);
    if (mode === "expiry") { f.advance(60_000); f.tick(); }
    if (mode === "revocation") { endAllSessions({ path: f.path }); f.tick(); }
    if (mode === "role") { const file = f.readTokens().file; file.tokens[0].role = "viewer"; fs.writeFileSync(f.path, JSON.stringify(file)); f.tick(); }
    if (mode === "shutdown") f.service.close();
    assert.equal(f.service.privateSize(), 0, mode);
    assert.equal(f.calls.filter(row => row[0] === "apply").length, 0, mode);
    assert.equal(fs.existsSync(join(f.dir, ".env")), false, mode);
  }
});

test("key preview capacity never evicts another pending key, and unsupported input never reaches the host planner", async t => {
  const f = fixture(t, { maxPrivate: 1 });
  const first = await f.preview("setup-provider-key", { value: KEY });
  assert.equal(first.status, 200);
  assert.equal((await f.preview("setup-provider-key", { value: "another" })).status, 409);
  assert.equal(f.service.privateSize(), 1);
  for (const value of ["", "a b", "a\nsecret", "$(id)", "x".repeat(4097)]) assert.equal((await f.preview("setup-provider-key", { value })).status, 400);
  assert.equal(f.calls.filter(row => row[0] === "plan").length, 1, "capacity and malformed values refuse before another child is dispatched");
  assert.equal((await f.confirm("setup-provider-key", first.body.ticket)).status, 200, "the first preview survives capacity refusal");
});

test("a planning key already consumes the shared Add/Replace session and process limits before another child can start", async t => {
  const delayed = delayedPlanner();
  t.after(delayed.release);
  const f = fixture(t, { maxPrivate: 1, broker: delayed.broker });
  const body = { provider: "openai", value: KEY };
  const pending = previewAction(f.ctx(body), actionNamed("setup-provider-key"));
  const child = await delayed.started;
  assert.deepEqual(child.input, { provider: "openai" }, "the metadata planner never receives entered credentials");
  assert.equal(body.value, undefined, "the HTTP input no longer retains the value while planning");
  assert.equal(f.service.privateSize(), 1, "bounded private state begins at input receipt, not planner completion");
  assert.equal((await f.preview("setup-provider-key-replace", { provider: "deepseek", value: "second-private-value" })).status, 409);
  const file = f.readTokens().file;
  const second = f.sessions.create({ name: "operator", role: "operator", tokenHash: file.tokens[0].sha256, generation: file.generation });
  const otherSession = f.sessions.peek(second.id, file);
  assert.equal((await f.preview("setup-provider-key", { provider: "deepseek", value: "another-session-private-value" }, otherSession)).status, 429);
  assert.equal(delayed.calls.length, 1, "neither cross-action nor cross-session capacity refusal invokes the broker");
  delayed.release();
  const preview = await pending;
  assert.equal(preview.status, 200);
  assert.equal(f.service.privateSize(), 1, "a refused concurrent request cannot dispose the original entry");
  assert.equal((await f.confirm("setup-provider-key", preview.body.ticket)).status, 200);
  assert.equal(fs.readFileSync(join(f.dir, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
  assert.doesNotMatch(JSON.stringify([preview, f.audit, f.flash]), new RegExp(KEY));
});

test("planning time consumes the original private lifetime and never grants a fresh minute when the planner returns", async t => {
  const delayed = delayedPlanner();
  t.after(delayed.release);
  const f = fixture(t, { broker: delayed.broker });
  const pending = f.preview("setup-provider-key-replace", { provider: "deepseek", value: KEY });
  await delayed.started;
  f.advance(45_000);
  delayed.release();
  const preview = await pending;
  assert.equal(preview.status, 200);
  assert.equal(preview.body.expiresAt, T0 + 60_000, "expiresAt stays bound to first receipt");
  assert.match(preview.body.html, /data-expires="15000"/, "the displayed countdown uses only the remaining lifetime");
  f.advance(15_000);
  f.tick();
  assert.equal(f.service.privateSize(), 0);
  assert.equal((await f.confirm("setup-provider-key-replace", preview.body.ticket)).status, 409);
  assert.equal(f.calls.filter(call => call[0] === "apply").length, 0);
});

test("expiry, ended sessions, revocation, role loss and shutdown abort a planning key and cannot resurrect it from a late reply", async t => {
  for (const mode of ["expiry", "session-end", "generation", "revoke", "role", "shutdown"]) {
    const delayed = delayedPlanner();
    t.after(delayed.release);
    const f = fixture(t, { broker: delayed.broker });
    const body = { provider: "openrouter", value: KEY };
    const pending = previewAction(f.ctx(body), actionNamed("setup-provider-key"));
    const child = await delayed.started;
    assert.ok(child.signal instanceof AbortSignal, mode);
    assert.equal(child.signal.aborted, false, mode);
    assert.equal(body.value, undefined, mode);
    if (mode === "expiry") { f.advance(60_000); f.tick(); }
    if (mode === "session-end") f.service.endSession(f.session.id);
    if (mode === "generation") { endAllSessions({ path: f.path }); f.tick(); }
    if (mode === "revoke") { revokeToken({ path: f.path, name: "operator" }); f.tick(); }
    if (mode === "role") { const file = f.readTokens().file; file.tokens[0].role = "viewer"; fs.writeFileSync(f.path, JSON.stringify(file)); f.tick(); }
    if (mode === "shutdown") f.service.close();
    assert.equal(child.signal.aborted, true, mode);
    assert.equal(f.service.privateSize(), 0, mode);
    delayed.release();
    const refused = await pending;
    assert.ok(refused.status >= 400, mode);
    assert.equal(refused.body.ticket, undefined, mode);
    assert.equal(f.service.privateSize(), 0, mode);
    assert.equal(f.calls.filter(call => call[0] === "apply").length, 0, mode);
    assert.equal(fs.existsSync(join(f.dir, ".env")), false, mode);
    assert.doesNotMatch(JSON.stringify([refused, f.audit, f.flash, f.service.state("operator", {})]), new RegExp(KEY), mode);
  }
});

test("a disconnected preview response aborts and disposes its planning key before a late planner reply", async t => {
  const delayed = delayedPlanner();
  t.after(delayed.release);
  const f = fixture(t, { broker: delayed.broker });
  const res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const ctx = { ...f.ctx({ provider: "openai", value: KEY }), res };
  const pending = previewAction(ctx, actionNamed("setup-provider-key"));
  const child = await delayed.started;
  assert.equal(f.service.privateSize(), 1);
  res.destroyed = true;
  res.emit("close");
  assert.equal(child.signal.aborted, true, "response disconnect reaches the running metadata child");
  assert.equal(f.service.privateSize(), 0, "disconnected input is disposed without waiting for its planner");
  delayed.release();
  const response = await pending;
  assert.equal(response?.body?.ticket, undefined, "a late plan cannot create an undelivered private ticket");
  assert.equal(f.service.privateSize(), 0);
  assert.equal(f.calls.filter(call => call[0] === "apply").length, 0);
  assert.doesNotMatch(JSON.stringify([response, f.audit, f.flash]), new RegExp(KEY));
});

test("a completed preview response removes its close hook and keeps only the delivered single-use key ticket", async t => {
  const delayed = delayedPlanner();
  t.after(delayed.release);
  const f = fixture(t, { broker: delayed.broker });
  const res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const ctx = { ...f.ctx({ provider: "deepseek", value: KEY }), res, json(status, body) {
    res.writableFinished = true;
    res.emit("finish");
    return { status, body };
  } };
  const pending = previewAction(ctx, actionNamed("setup-provider-key"));
  await delayed.started;
  delayed.release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(res.listenerCount("close"), 0, "delivered responses retain no abandoned-preview listener");
  res.destroyed = true;
  res.emit("close");
  assert.equal(f.service.privateSize(), 1, "ordinary connection close after finish does not cancel a delivered ticket");
  assert.equal((await f.confirm("setup-provider-key", response.body.ticket)).status, 200);
  assert.equal(fs.readFileSync(join(f.dir, ".env"), "utf8"), `DEEPSEEK_API_KEY=${KEY}\n`);
  assert.equal(f.service.privateSize(), 0);
});

test("a failed, refused, unchanged or mismatched key plan releases its early reservation instead of blocking a later preview", async t => {
  for (const result of ["throw", "refused", "unchanged", "mismatch"]) {
    let attempt = 0;
    const f = fixture(t, { maxPrivate: 1, broker: { async preview(action, input) {
      if (++attempt === 1) {
        if (result === "throw") throw Object.assign(new Error("planner unavailable"), { code: "EPIPE" });
        if (result === "refused") return { state: "refused", reason: "provider-shadowed" };
        if (result === "unchanged") return { state: "unchanged", reason: "ready" };
        return { state: "planned", plan: keyPlan("anthropic", action) };
      }
      return { state: "planned", plan: keyPlan(input.provider, action) };
    } } });
    const first = await f.preview("setup-provider-key", { provider: "openai", value: KEY });
    assert.equal(first.body.ticket, undefined, result);
    assert.equal(f.service.privateSize(), 0, result);
    const next = await f.preview("setup-provider-key-replace", { provider: "deepseek", value: "next-private-value" });
    assert.equal(next.status, 200, result);
    assert.equal(f.service.privateSize(), 1, result);
    assert.equal(f.calls.filter(call => call[0] === "apply").length, 0, result);
    assert.doesNotMatch(JSON.stringify([first, next, f.audit, f.flash]), new RegExp(`${KEY}|next-private-value`), result);
  }
});

test("viewers and agents cannot preview a setup action or read its private dependencies", async t => {
  const f = fixture(t);
  for (const role of ["viewer", "agent"]) for (const name of SETUP_ACTION_NAMES) {
    const res = await f.preview(name, {}, { ...f.session, role });
    assert.equal(res.status, 403, `${role} ${name}`);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.privateSize(), 0);
  for (const role of ["viewer", "agent"]) {
    const view = f.service.state(role, {});
    assert.deepEqual(view.actions, []);
    assert.equal(view.providerKey, null);
    assert.ok(!JSON.stringify(view).includes("account"));
  }
});

test("viewer invitation is private, bound to its exact incarnation/generation, consumed once, and Undo cannot revoke a replacement", async t => {
  const f = fixture(t);
  const p = await f.preview("setup-viewer-add", { name: "observer" });
  assert.equal(p.status, 200);
  assert.equal(f.readTokens().file.tokens.length, 1);
  const result = await f.confirm("setup-viewer-add", p.body.ticket);
  assert.equal(result.status, 200);
  assert.match(result.body.invitation.href, /^\/login\/code#[A-Za-z0-9_-]{43}&next=\/setup$/);
  const code = result.body.invitation.href.split("#")[1].split("&")[0];
  assert.ok(!JSON.stringify([f.audit, f.flash, f.service.state("operator", {})]).includes(code));
  const taken = consumeLoginCode({ dir: loginCodesDir(f.path), code, now: f.now });
  const file = f.readTokens().file;
  const viewer = file.tokens.find(row => row.name === "observer");
  assert.equal(invitationMatches(taken.binding, viewer, file), true);
  assert.ok(consumeLoginCode({ dir: loginCodesDir(f.path), code, now: f.now }).refusal);
  for (const replacement of [{ ...viewer, role: "operator" }, { ...viewer, sha256: "a".repeat(64) }, { ...viewer, createdAt: new Date(T0 + 1).toISOString() }]) assert.equal(invitationMatches(taken.binding, replacement, file), false);
  assert.equal(invitationMatches(taken.binding, viewer, { ...file, generation: 1 }), false);
  const undo = await f.preview("setup-viewer-revoke", result.body.viewer);
  assert.equal(undo.status, 200);
  rotateToken({ path: f.path, name: "observer", now: f.now });
  assert.equal((await f.confirm("setup-viewer-revoke", undo.body.ticket)).status, 409);
  assert.equal(f.readTokens().file.tokens.some(row => row.name === "observer"), true);
});

test("failed code mint reports its retained viewer entry and recovery rather than hiding the token-file mutation", async t => {
  const f = fixture(t, { mintCode: () => ({ refusal: "unavailable" }) });
  const p = await f.preview("setup-viewer-add", { name: "observer" });
  const result = await f.confirm("setup-viewer-add", p.body.ticket);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /was saved.*no invitation.*link --name observer/);
  assert.doesNotMatch(result.body.html, /Nothing was changed/);
  assert.equal(f.readTokens().file.tokens.some(row => row.name === "observer"), true);
  assert.equal(f.audit.at(-1).outcome, "failed");
});

test("viewer creation refuses stale input and request role escalation before changing the file", async t => {
  const f = fixture(t);
  assert.equal((await f.preview("setup-viewer-add", { name: "observer", role: "operator" })).status, 400);
  const p = await f.preview("setup-viewer-add", { name: "observer" });
  addToken({ path: f.path, name: "another", role: "viewer", now: f.now });
  assert.equal((await f.confirm("setup-viewer-add", p.body.ticket)).status, 409);
  assert.equal(f.readTokens().file.tokens.some(row => row.name === "observer"), false);
});

test("worker start refuses incomplete or changed exposure, waits for real heartbeat, and stop preview acknowledges arrivals/interruption", async t => {
  let exposure = { complete: false };
  const f = fixture(t, { readExposure: async () => exposure });
  assert.equal((await f.preview("setup-worker-start")).status, 409);
  exposure = { complete: true, at: T0, lines: ["One queued manual job; two cron triggers."], identity: "first" };
  const p = await f.preview("setup-worker-start");
  assert.equal(p.status, 200);
  exposure = { ...exposure, identity: "new-arrival" };
  assert.equal((await f.confirm("setup-worker-start", p.body.ticket)).status, 409);
  assert.equal(f.calls.filter(row => row[0] === "apply").length, 0);
  const second = await f.preview("setup-worker-start");
  assert.equal((await f.confirm("setup-worker-start", second.body.ticket)).status, 200);
  assert.equal(f.service.state("operator", { hostBudgets: [] }).progress[0].state, "starting");
  assert.equal(f.service.state("operator", { hostBudgets: [{ name: "other", ttlAgeMs: 1 }] }).progress[0].state, "starting");
  const beforeStart = { hostsReadAt: T0 - 1, hostBudgets: [{ name: "host1", ttlAgeMs: 1 }] };
  assert.equal(f.service.state("operator", beforeStart).progress[0].state, "starting", "a pre-start beat is not readiness for this start");
  f.advance(2);
  assert.equal(f.service.state("operator", beforeStart).progress[0].state, "starting", "rendering a cached pre-start observation later cannot make it fresh");
  for (const snapshot of [
    { hostBudgets: [{ name: "host1", ttlAgeMs: 0 }] },
    { hostsReadAt: f.now() + 1, hostBudgets: [{ name: "host1", ttlAgeMs: 0 }] },
    { hostsReadAt: f.now(), hostBudgets: [{ name: "host1", ttlAgeMs: 5 }] },
    { hostsReadAt: f.now(), hostBudgets: [{ name: "host1", staleMs: 0 }] },
    { hostsReadAt: f.now(), queue: { fleetDegraded: "unreadable" }, hostBudgets: [{ name: "host1", ttlAgeMs: 0 }] },
  ]) assert.equal(f.service.state("operator", snapshot).progress[0].state, "starting", JSON.stringify(snapshot));
  assert.equal(f.service.state("operator", { hostsReadAt: f.now(), hostBudgets: [{ name: "host1", ttlAgeMs: 1 }] }).progress[0].state, "applied");
  const stop = await f.preview("setup-worker-stop");
  assert.match(stop.body.summary.join(" "), /SIGTERM.*interrupt.*admitted after.*cannot undo/);
});

test("readiness timeout, partial host outcomes and grant loss are never represented as successful readiness", async t => {
  const f = fixture(t);
  const p = await f.preview("setup-worker-start");
  await f.confirm("setup-worker-start", p.body.ticket);
  f.advance(90_000);
  assert.equal(f.service.state("operator", {}).progress[0].state, "timeout");
  const broken = fixture(t, { broker: { apply: async () => ({ state: "unknown", reason: "readback-unavailable" }) } });
  const x = await broken.preview("setup-worker-stop");
  const result = await broken.confirm("setup-worker-stop", x.body.ticket);
  assert.equal(result.status, 409);
  assert.doesNotMatch(result.body.html, /Nothing was changed/);
  assert.equal(broken.audit.at(-1).outcome, "failed");
});

test("complete exposure uses real trigger validation and reserve estimates; partial queues and unreadable job data refuse", async () => {
  const dir = tempDir("pd-setup-exposure-");
  const path = join(dir, "triggers.json");
  fs.writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 2 * * *" }, run: { kind: "local", flow: "tidy", folder: "/repo", task: "Tidy the repository", maxCostUsd: "2" } }] }));
  let snapshot = { queue: {}, queueCounts: [{ name: "pi-jobs", counts: { waiting: 1, paused: 0, delayed: 0, active: 0 } }], waiting: { rows: [{ jobId: "local-job", queue: "pi-jobs" }], scheduled: [], truncated: false } };
  const a = { fleet: { snapshot: async opts => { assert.equal(opts.switchQueues, true); assert.equal(opts.waiting, true); assert.equal(opts.freshWaiting, true); return snapshot; } }, paths: { triggersPath: path }, env: {}, rm: { estimateReserve }, readJobsData: async () => new Map([["local-job", { maxCostUsd: "3" }]]) };
  const ctx = { a, fs, now: () => T0 };
  const got = await readSetupExposure(ctx);
  assert.equal(got.complete, true);
  assert.match(got.lines.join(" "), /\$3\.00.*\$2\.00/);
  assert.match(got.lines.join(" "), /local-job.*nightly/);
  const whole = snapshot;
  snapshot = { ...snapshot, waiting: { ...snapshot.waiting, rows: [...snapshot.waiting.rows, { jobId: "local-job", queue: "pi-jobs@other" }] } };
  assert.equal((await readSetupExposure(ctx)).complete, false, "queue data keyed only by ID cannot safely price duplicate IDs across queues");
  snapshot = { ...whole, switchIncomplete: "unreadable" };
  assert.equal((await readSetupExposure(ctx)).complete, false);
  snapshot = { ...snapshot, switchIncomplete: null };
  a.readJobsData = async () => new Map();
  assert.equal((await readSetupExposure(ctx)).complete, false);
});

test("revocation aborts an in-flight child without inventing rollback, and concurrent confirms never submit a second operation", async t => {
  let pendingSignal, release;
  const f = fixture(t, { broker: { apply: async (_action, _entry, { signal }) => { pendingSignal = signal; return new Promise(resolve => { release = resolve; signal.addEventListener("abort", () => resolve({ state: "unknown", reason: "readback-unavailable" }), { once: true }); }); } } });
  const first = await f.preview("setup-worker-stop");
  const second = await f.preview("setup-doctor");
  const confirming = f.confirm("setup-worker-stop", first.body.ticket);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pendingSignal);
  const refused = await f.confirm("setup-doctor", second.body.ticket);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Another setup operation/);
  endAllSessions({ path: f.path });
  f.tick();
  assert.equal(pendingSignal.aborted, true);
  const result = await confirming;
  assert.equal(result.status, 409);
  assert.doesNotMatch(result.body.html, /Nothing was changed/);
  release({ state: "applied", reason: "ready" });
});

test("unsupported runtime operations are refused even by an operator before any local observation", async t => {
  const f = fixture(t, { operations: SETUP_ACTION_NAMES.filter(name => name !== "setup-egress-start") });
  assert.equal(f.service.state("operator", {}).actions.includes("setup-egress-start"), false);
  assert.equal((await f.preview("setup-egress-start")).status, 403);
  assert.deepEqual(f.calls, []);
});

test("canonical key slots follow the worker's pinned provider key selector, including non-API suffix names", async t => {
  for (const [provider, key] of [["huggingface", "HF_TOKEN"]]) {
    const f = fixture(t, { provider, broker: { async preview() { return { state: "planned", plan: keyPlan(provider) }; }, async apply(_action, entry) { assert.deepEqual(entry.input, { provider, key, value: KEY }); return { state: "applied", reason: "ready" }; } } });
    assert.equal(f.service.state("operator", {}).providerKey, key);
    assert.ok(f.service.state("operator", {}).actions.includes("setup-provider-key"));
    const p = await f.preview("setup-provider-key", { value: KEY });
    assert.equal(p.status, 200);
    assert.match(p.body.summary.join(" "), new RegExp(key));
    assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 200);
  }
});

test("readiness uses the configured worker heartbeat name rather than the physical host label", async t => {
  const f = fixture(t, { broker: { async preview() { return { state: "planned", plan: { digest: "a".repeat(64), component: "worker", host: "physical-host", workerName: "configured-worker", account: "account", manager: "systemd", effects: ["start-worker"] } }; } } });
  const p = await f.preview("setup-worker-start");
  assert.equal((await f.confirm("setup-worker-start", p.body.ticket)).status, 200);
  f.advance(20);
  assert.equal(f.service.state("operator", { hostsReadAt: f.now(), hostBudgets: [{ name: "physical-host", ttlAgeMs: 1 }] }).progress[0].state, "starting");
  assert.equal(f.service.state("operator", { hostsReadAt: f.now(), hostBudgets: [{ name: "configured-worker", ttlAgeMs: 1 }] }).progress[0].state, "applied");
});

test("a host-held deployment setup lock prevents viewer token and invitation writes, and release permits a fresh confirmation", async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.path, "utf8");
  const planned = await f.preview("setup-viewer-add", { name: "observer" });
  const lock = acquireSetupLock(f.dir);
  assert.equal(lock.refusal, undefined);
  try {
    const blocked = await f.confirm("setup-viewer-add", planned.body.ticket);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /deployment lock/);
    assert.equal(fs.readFileSync(f.path, "utf8"), before);
    assert.equal(fs.existsSync(loginCodesDir(f.path)), false);
    assert.equal(f.service.privateSize(), 0, "the blocked confirmation is still single-use and private state is disposed");
    assert.equal(f.audit.at(-1).outcome, "failed");
  } finally { lock.release(); }
  const next = await f.preview("setup-viewer-add", { name: "observer" });
  assert.equal((await f.confirm("setup-viewer-add", next.body.ticket)).status, 200);
  assert.ok(f.readTokens().file.tokens.some(entry => entry.name === "observer" && entry.role === "viewer"));
});

test("provider configuration changes refresh the default hint while each key preview binds its explicit provider", async t => {
  let provider = "anthropic";
  const f = fixture(t, { provider: () => provider, broker: {
    async preview(action, input) { assert.deepEqual(input, { provider: "openai" }); return { state: "planned", plan: keyPlan(input.provider) }; },
    async apply(_action, entry) { assert.deepEqual(entry.input, { provider: "openai", key: "OPENAI_API_KEY", value: KEY }); return { state: "applied", reason: "ready" }; },
  } });
  assert.equal(f.service.state("operator", {}).providerKey, "ANTHROPIC_API_KEY");
  provider = "openai";
  assert.equal(f.service.state("operator", {}).providerKey, "OPENAI_API_KEY");
  const p = await f.preview("setup-provider-key", { value: KEY });
  assert.equal(p.status, 200);
  assert.match(p.body.summary.join(" "), /Add OPENAI_API_KEY for openai/);
  provider = "deepseek";
  assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 200);
  for (provider of ["unsupported-provider", "constructor", "__proto__"]) {
    assert.equal(f.service.state("operator", {}).providerKey, null);
    assert.equal(f.service.state("operator", {}).actions.includes("setup-provider-key"), true, "an unsupported default must not hide management for other providers");
  }
});

test("an additional provider stays selected through default changes and key values never enter public metadata", async t => {
  let provider = "anthropic";
  const f = fixture(t, { provider: () => provider });
  const p = await f.preview("setup-provider-key", { provider: "openrouter", value: KEY });
  assert.equal(p.status, 200);
  assert.match(p.body.summary.join(" "), /Add OPENROUTER_API_KEY for openrouter/);
  assert.match(p.body.summary.join(" "), /Default provider, models, roles, routing, allowlists and budgets stay unchanged/);
  provider = "deepseek";
  assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 200);
  const applied = f.calls.find(call => call[0] === "apply");
  assert.deepEqual(applied[2].input, { provider: "openrouter", key: "OPENROUTER_API_KEY", value: KEY });
  assert.doesNotMatch(JSON.stringify([p, f.audit, f.flash, f.service.state("operator", {})]), new RegExp(KEY));
  assert.doesNotMatch(JSON.stringify(p.body), /"(?:digest|aliases|setupRef|value)":/);
});

test("Replace has a danger confirmation and names the shared slot without retaining the old key", async t => {
  const f = fixture(t);
  const old = "old-private-key-must-not-be-returned";
  fs.writeFileSync(join(f.dir, ".env"), `MOONSHOT_API_KEY=${old}\n`, { mode: 0o600 });
  const p = await f.preview("setup-provider-key-replace", { provider: "moonshotai-cn", value: KEY });
  assert.equal(p.status, 200);
  assert.equal(p.body.danger, true);
  assert.equal(p.body.confirmLabel, "Replace key");
  assert.match(p.body.summary.join(" "), /moonshotai, moonshotai-cn/);
  assert.match(p.body.summary.join(" "), /not retained for Undo/);
  assert.doesNotMatch(JSON.stringify(p), new RegExp(`${KEY}|${old}`));
  assert.equal((await f.confirm("setup-provider-key-replace", p.body.ticket)).status, 200);
  assert.equal(f.calls.find(call => call[0] === "apply")[2].input.provider, "moonshotai-cn");
  assert.doesNotMatch(JSON.stringify([f.audit, f.flash]), new RegExp(`${KEY}|${old}`));
});

test("Add and Replace share one private key slot per session, including cross-action redemption", async t => {
  const f = fixture(t);
  const p = await f.preview("setup-provider-key", { provider: "openai", value: KEY });
  assert.equal((await f.preview("setup-provider-key-replace", { provider: "anthropic", value: "replacement" })).status, 409);
  assert.equal((await f.confirm("setup-provider-key-replace", p.body.ticket)).status, 409);
  assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 409);
  assert.equal(f.calls.filter(call => call[0] === "apply").length, 0);
  const next = await f.preview("setup-provider-key-replace", { provider: "anthropic", value: "replacement" });
  assert.equal(next.status, 200, "a failed redemption disposes the previous private input");
});

test("a private plan cannot swap provider, mode, canonical slot, shared aliases or source", async t => {
  for (const change of [{ provider: "anthropic", key: "ANTHROPIC_API_KEY" }, { mode: "replace" }, { key: "OPENAI_AUTH_TOKEN" }, { aliases: ["openai", "anthropic"] }, { source: "browser-token" }, { source: "deployment-env" }]) {
    const f = fixture(t, { broker: { async preview() { return { state: "planned", plan: keyPlan("openai", "setup-provider-key", change) }; } } });
    const p = await f.preview("setup-provider-key", { provider: "openai", value: KEY });
    assert.equal(p.status, 409, JSON.stringify(change));
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(p), new RegExp(KEY));
  }
});

test("key management requires an explicit eligible provider even when the current default is valid", async t => {
  const f = fixture(t);
  for (const action of ["setup-provider-key", "setup-provider-key-replace"]) {
    for (const provider of [undefined, null, "amazon-bedrock", "github-copilot", "google-vertex", "openai-codex", "constructor", "__proto__"]) {
      const p = await previewAction(f.ctx({ provider, value: KEY }), actionNamed(action));
      assert.equal(p.status, 400, `${action} ${provider}`);
    }
    const missing = await previewAction(f.ctx({ value: KEY }), actionNamed(action));
    assert.equal(missing.status, 400, `${action}: no default-provider inference`);
  }
  assert.equal(f.calls.length, 0, "unsupported inputs never reach the private host broker");
});

test("pi API-key fallback source switching is explicit and does not request a queue scan", async t => {
  const f = fixture(t, { readExposure: () => { throw new Error("key management must not require queue access"); }, broker: { async preview() { return { state: "planned", plan: keyPlan("openai", "setup-provider-key", { source: "pi-api-key" }) }; } } });
  const p = await f.preview("setup-provider-key", { provider: "openai", value: KEY });
  assert.equal(p.status, 200);
  assert.match(p.body.summary.join(" "), /Use the deployment key.*pi API-key fallback/);
  assert.match(p.body.summary.join(" "), /pi credential file is not changed/);
  assert.equal(p.body.danger, false);
});

test("Replace private input expires, cancels and refuses foreign sessions without effects or leaked values", async t => {
  for (const mode of ["expiry", "cancel", "foreign", "audit", "revoke"]) {
    const f = fixture(t);
    const action = "setup-provider-key-replace";
    const p = await f.preview(action, { provider: "deepseek", value: KEY });
    assert.equal(p.status, 200, mode);
    if (mode === "expiry") f.advance(60_001);
    if (mode === "cancel") assert.equal(cancelAction(f.ctx({ ticket: p.body.ticket }), actionNamed(action)).status, 200);
    if (mode === "audit") f.deps.failAudit = true;
    if (mode === "revoke") revokeToken({ path: f.path, name: "operator" });
    const result = await f.confirm(action, p.body.ticket, mode === "foreign" ? { ...f.session, id: "foreign" } : f.session);
    assert.ok(result.status >= 400, mode);
    assert.equal(f.calls.filter(call => call[0] === "apply").length, 0, mode);
    assert.doesNotMatch(JSON.stringify([result, f.audit, f.flash]), new RegExp(KEY));
  }
});

test("a timed-out worker start can recover from later fresh evidence without dispatching another mutation", async t => {
  const f = fixture(t);
  const p = await f.preview("setup-worker-start");
  await f.confirm("setup-worker-start", p.body.ticket);
  f.advance(90_000);
  assert.equal(f.service.state("operator", {}).progress[0].state, "timeout");
  f.advance(10);
  const recovered = f.service.state("operator", { hostsReadAt: f.now(), hostBudgets: [{ name: "host1", ttlAgeMs: 1 }] }).progress[0];
  assert.equal(recovered.state, "applied");
  assert.equal(recovered.stage, "complete");
  assert.equal(recovered.reason, undefined);
  assert.equal(f.calls.filter(row => row[0] === "apply").length, 1);
});

test("viewer invitation expiry is bound to the actual mint time even when the filesystem write advances the clock", async t => {
  let f;
  f = fixture(t, { mintCode: opts => { const minted = mintLoginCode(opts); f.advance(1000); return minted; } });
  const p = await f.preview("setup-viewer-add", { name: "observer" });
  const result = await f.confirm("setup-viewer-add", p.body.ticket);
  assert.equal(result.status, 200);
  assert.equal(result.body.invitation.expiresAt, T0 + 60_000);
  const record = JSON.parse(fs.readFileSync(join(loginCodesDir(f.path), fs.readdirSync(loginCodesDir(f.path))[0]), "utf8"));
  assert.equal(Date.parse(record.expiresAt), result.body.invitation.expiresAt);
});

test("changed deployment exposure configuration refuses with console recovery rather than blaming Valkey", async t => {
  let exposure = { complete: false, reason: "configuration-drift" };
  const f = fixture(t, { readExposure: async () => exposure });
  const refused = await f.preview("setup-worker-start");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Review the shell\/deployment overrides and restart the console/);
  assert.doesNotMatch(refused.body.error, /check Valkey/);
  exposure = { complete: true, at: T0, lines: ["Current exposure read completely."], identity: "known" };
  const planned = await f.preview("setup-worker-start");
  exposure = { complete: false, reason: "configuration-drift" };
  const changed = await f.confirm("setup-worker-start", planned.body.ticket);
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /restart the console/);
  assert.match(changed.body.error, /Nothing was started/);
  assert.equal(f.calls.filter(row => row[0] === "apply").length, 0);
});

test("a replaced or retargeted deployment cannot reuse an existing viewer/key preview even with identical token bytes", async t => {
  for (const mode of ["replace-directory", "retarget-symlink", "alias-same-inode", "unsafe-mode"]) {
    const f = fixture(t);
    const key = await f.preview("setup-provider-key", { value: KEY });
    const viewer = await f.preview("setup-viewer-add", { name: "observer" });
    assert.equal(key.status, 200);
    assert.equal(viewer.status, 200);
    const bytes = fs.readFileSync(f.path, "utf8");
    const parking = tempDir("pd-setup-incarnation-");
    if (mode === "unsafe-mode") fs.chmodSync(f.dir, 0o777);
    else {
      const original = join(parking, "original");
      fs.renameSync(f.dir, original);
      if (mode === "alias-same-inode") fs.symlinkSync(original, f.dir, "dir");
      else {
        const replacement = mode === "retarget-symlink" ? join(parking, "replacement") : f.dir;
        fs.mkdirSync(replacement, { mode: 0o700 });
        fs.writeFileSync(join(replacement, "tokens.json"), bytes, { mode: 0o600 });
        if (mode === "retarget-symlink") fs.symlinkSync(replacement, f.dir, "dir");
      }
    }
    assert.equal((await f.confirm("setup-viewer-add", viewer.body.ticket)).status, 409, mode);
    assert.equal(f.service.privateSize(), 0, "loss of deployment authority disposes all pending private payloads");
    assert.equal((await f.confirm("setup-provider-key", key.body.ticket)).status, 409, mode);
    assert.equal(f.calls.filter(row => row[0] === "apply").length, 0, mode);
    assert.equal(fs.readFileSync(f.path, "utf8"), bytes, mode);
    assert.equal(fs.existsSync(loginCodesDir(f.path)), false, mode);
    assert.equal(f.service.state("operator", {}).enabled, false, mode);
    assert.equal((await f.preview("setup-viewer-add", { name: "later" })).status, 403, mode);
    if (mode === "unsafe-mode") fs.chmodSync(f.dir, 0o700);
  }
});

test("viewer apply rechecks the captured deployment incarnation after acquiring its shared lock", async t => {
  let moveOnLock = false, f;
  const parking = tempDir("pd-setup-lock-incarnation-");
  const io = { ...fs, writeFileSync(path, ...args) {
    const result = fs.writeFileSync(path, ...args);
    if (moveOnLock && String(path).endsWith("/.pi-dispatch-setup.lock")) {
      moveOnLock = false;
      const tokens = fs.readFileSync(f.path, "utf8");
      fs.renameSync(f.dir, join(parking, "original"));
      fs.mkdirSync(f.dir, { mode: 0o700 });
      fs.writeFileSync(f.path, tokens, { mode: 0o600 });
    }
    return result;
  } };
  f = fixture(t, { fs: io });
  const before = fs.readFileSync(f.path, "utf8");
  const p = await f.preview("setup-viewer-add", { name: "observer" });
  moveOnLock = true;
  const result = await f.confirm("setup-viewer-add", p.body.ticket);
  assert.equal(result.status, 409);
  assert.equal(fs.readFileSync(f.path, "utf8"), before);
  assert.equal(fs.existsSync(loginCodesDir(f.path)), false);
  assert.equal(f.service.privateSize(), 0);
});
