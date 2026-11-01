import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addToken, readTokensFile, rotateToken, endAllSessions } from "@edgehero/pi-dispatch/console-tokens";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeSetupActions, SETUP_ACTION_NAMES } from "../src/setup-actions.mjs";
import { actionNamed, previewAction, confirmAction, cancelAction, readSetupExposure } from "../src/console/actions.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { consumeLoginCode, invitationMatches, loginCodesDir, mintLoginCode } from "../src/console/login-codes.mjs";
import { makeSessionStore } from "../src/console/sessions.mjs";
import { SETUP_OPERATIONS } from "@edgehero/pi-dispatch/setup-contract";
import { acquireSetupLock } from "@edgehero/pi-dispatch/setup-lock";

const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const KEY = "setup-provider-private-canary-739c";
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
    async preview(action) { calls.push(["plan", action]); return { state: "planned", plan: { digest: "d".repeat(64), component: "worker", host: "host1", account: "account", manager: "systemd", effects: [action === "setup-provider-key" ? "write-provider-key" : action === "setup-worker-stop" ? "stop-worker" : "start-worker"], provider: "anthropic", key: "ANTHROPIC_API_KEY" } }; },
    async apply(action, entry) { calls.push(["apply", action, structuredClone(entry)]); if (action === "setup-provider-key") fs.writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${entry.input.value}\n`, { mode: 0o600 }); return { state: "applied", reason: "ready" }; },
    ...options.broker,
  };
  const service = makeSetupActions({ broker, enabled: true, deployment: dir, tokensPath: path, provider: "anthropic", sessions, readTokens, now, interval: fn => { sweep = fn; return { unref() {} }; }, clearIntervalFn() {}, readExposure: async () => ({ complete: true, at: now(), lines: ["No queued jobs; zero cron triggers. Future arrivals remain possible."], identity: "known" }), ...options, broker });
  t.after(() => service.close());
  const audit = [], flash = [];
  const deps = { now, fs, tickets: makeConfirmTickets({ now }), sessions: { setFlash: (_id, change) => flash.push(structuredClone(change)) }, actionDeps: { setup: service }, audit: { append(row) { if (deps.failAudit) throw Object.assign(new Error("full"), { code: "ENOSPC" }); audit.push(structuredClone(row)); return { seq: audit.length }; } }, log() {} };
  function ctx(body, as = session) { return { body, session: as, deps, route: { path: "/api/act/setup-test" }, actor: () => ({ name: as.name, role: as.role, session: null }), record: row => audit.push(row), json: (status, body) => ({ status, body }) }; }
  return { service, now, path, dir, calls, session, sessions, readTokens, deps, audit, flash, advance: ms => { at += ms; }, tick: () => sweep(), ctx,
    preview: (name, body = {}, as = session) => previewAction(ctx(body, as), actionNamed(name)),
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
  assert.equal(f.calls.filter(row => row[0] === "plan").length, 2, "capacity is judged after non-mutating planning; malformed values are refused before any plan");
  assert.equal((await f.confirm("setup-provider-key", first.body.ticket)).status, 200, "the first preview survives capacity refusal");
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
  for (const [provider, key] of [["huggingface", "HF_TOKEN"], ["github-copilot", "COPILOT_GITHUB_TOKEN"]]) {
    const f = fixture(t, { provider, broker: { async preview() { return { state: "planned", plan: { digest: "a".repeat(64), component: "provider", host: "host1", account: "account", manager: "systemd", effects: ["write-provider-key"], provider, key } }; }, async apply(_action, entry) { assert.deepEqual(entry.input, { provider, key, value: KEY }); return { state: "applied", reason: "ready" }; } } });
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

test("provider configuration changes refresh the canonical form slot and the child receives no stale provider hint", async t => {
  let provider = "anthropic";
  const f = fixture(t, { provider: () => provider, broker: {
    async preview(action, input) { assert.deepEqual(input, {}); return { state: "planned", plan: { digest: "b".repeat(64), component: "provider", host: "host1", account: "account", manager: "systemd", effects: ["write-provider-key"], provider, key: provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY" } }; },
    async apply(_action, entry) { assert.deepEqual(entry.input, { provider: "openai", key: "OPENAI_API_KEY", value: KEY }); return { state: "applied", reason: "ready" }; },
  } });
  assert.equal(f.service.state("operator", {}).providerKey, "ANTHROPIC_API_KEY");
  provider = "openai";
  assert.equal(f.service.state("operator", {}).providerKey, "OPENAI_API_KEY");
  const p = await f.preview("setup-provider-key", { value: KEY });
  assert.equal(p.status, 200);
  assert.match(p.body.summary.join(" "), /Write OPENAI_API_KEY once/);
  assert.equal((await f.confirm("setup-provider-key", p.body.ticket)).status, 200);
  for (provider of ["unsupported-provider", "constructor", "__proto__"]) {
    assert.equal(f.service.state("operator", {}).providerKey, null);
    assert.equal(f.service.state("operator", {}).actions.includes("setup-provider-key"), false);
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
