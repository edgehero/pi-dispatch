// Issue #961: the paid enqueues, their previews, the package facts and the budget writes on a Valkey that is connected
// and stopped answering, on fakes. A paid enqueue has two phases. The connect is timed, and past its bound nothing was
// sent. The add is not: its client's command bound decides alone, and what it throws once it was started is never
// worded as "nothing was queued", unless Valkey itself refused it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { DISPATCH_RUN_ALLOWANCE_LOST, applyPriorities, checkDispatchRun, enqueueDispatchRun, enqueueParkedAnswer, enqueueRerun, envelopeDigestUnconfirmed, planEnvelopeWrite, planParkedAnswer, planRerun, readEnvelope, revertAllocation, writeEnvelope } from "../src/read-model.mjs";
import { ALREADY_CUT, ALREADY_MATCH, ALREADY_PER_STATE, ALREADY_UNCHECKED, LOOK_FIRST, CONFIRM_READ_TIMEOUT_MS, PAID_PLAN_TIMEOUT_MS, alreadyQueuedLine, connectedQueue, dispatchRunAlready, enqueueUnconfirmed, enqueueUnread, queuedAlready } from "../src/job-actions.mjs";
import { enqueueTriggerFire, FIRE_UNCONFIRMED, planTriggerFire } from "../src/trigger-fire.mjs";
import { CONSOLE_AUDIT_FIELD_MAX } from "@edgehero/pi-dispatch/console-audit";
import { GROUP_STATUS_UNANSWERED, GROUP_UNCONFIRMED } from "../src/zero-touch-data.mjs";
import { readUpdates } from "../src/updates-view.mjs";
import { loadPageData, pagePanels, parsePageQuery } from "../src/console/pages.mjs";
import { makeAnswererService } from "../src/answerer-data.mjs";
import { makeZeroTouchService } from "../src/zero-touch-data.mjs";
import { makeTouchOutbox } from "@edgehero/pi-dispatch/touch-outbox";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { updatesAppliedKey, updatesCanaryKey, updatesLookKey, UPDATES_DESIRED, UPDATES_HOSTS } from "@edgehero/pi-dispatch/updates";

const neverAnswers = () => new Promise(() => {});
const lostAnswer = () => Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", valkeyMayStillRun: true });
const refusal = () => Object.assign(new Error("READONLY You can't write against a read only replica."), { name: "ReplyError" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A client every command of which Valkey took and never answered (a rejection nobody awaits is not this test's failure). */
const losingClient = () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : () => {
  const lost = Promise.reject(lostAnswer());
  lost.catch(() => {});
  return lost;
}) });
/** `promise`'s answer and how long it took, or "hung" after `ms`. */
const timed = async (promise, ms = 3000) => {
  const t0 = Date.now();
  let timer;
  const res = await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms, "hung")))]);
  clearTimeout(timer);
  return { res, ms: Date.now() - t0 };
};

/** A queue as an enqueue sees it: `client` (left out for a queue with no connection to wait for), `add`, `getJob`. */
function fakeQueue({ client, add, getJob } = {}) {
  const calls = { add: 0, close: 0, disconnect: 0, conns: [], options: [] };
  const queue = {
    name: "pi-jobs",
    ...(client !== undefined ? { client } : {}),
    async add(name, data, opts) {
      calls.add += 1;
      return add ? add(name, data, opts) : { id: opts?.jobId };
    },
    getJob: getJob ?? (async () => undefined),
    async close() {
      calls.close += 1;
    },
    disconnect() {
      calls.disconnect += 1;
    },
  };
  const seams = { queueFn: (_c, options) => (calls.options.push(options), queue), parseConnectionFn: (_url, options) => (calls.conns.push(options), {}) };
  return { queue, calls, seams };
}

const BOUND = 60;
const LOCAL_PLAN = { kind: "local", jobId: "local-1", queue: "pi-jobs", job: { folder: "/f", flow: "fix", task: "t" } };
const PARKED_PLAN = {
  kind: "parked-answer", jobId: "gh-parked", forge: "github", queue: "pi-jobs",
  job: { repo: "o/r", target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "fix", resume: true, parkedReply: true, console: { by: "rob" }, trigger: { event: "issue_comment", action: "created", deliveryId: "console-0123456789abcdef", sender: { id: null }, matched: { index: 0, type: "comment", phrase: "/pi" }, comment: { body: "yes" } } },
};

/** The three paid enqueues that take a plan or fields, each as `(queue seams) => answer`, and how each names its run. */
const ENQUEUES = [
  ["a re-run", "the re-run of local-1", true, (seams) => enqueueRerun(LOCAL_PLAN, { url: "redis://x", ...seams, localRepoProblemFn: () => null, gitDirtyFn: () => false, connectTimeoutMs: BOUND })],
  ["a parked answer", "the answer to gh-parked", false, (seams) => enqueueParkedAnswer(PARKED_PLAN, { url: "redis://x", ...seams, connectTimeoutMs: BOUND })],
  ["a dispatch run", "the run", true, ({ queueFn, parseConnectionFn }) => enqueueDispatchRun({ folder: "/f", flow: "fix", task: "t", aiInvoked: false, env: { VALKEY_URL: "redis://x" }, makeQueueFn: queueFn, parseConnectionFn, gitDirtyFn: () => false, localRepoProblemFn: () => null, connectTimeoutMs: BOUND })],
];

for (const [name, what, readsBack, enqueue] of ENQUEUES) {
  test(`${name} whose queue never connects answers unreachable within the connect bound, and its add is never sent (#961)`, async () => {
    const q = fakeQueue({ client: neverAnswers() });
    const got = await timed(enqueue(q.seams));
    assert.deepEqual(got.res, { unreachable: "the queue did not connect within 0.06 seconds; nothing was queued" });
    assert.ok(got.ms < 1500, `${got.ms} ms`);
    assert.equal(q.calls.add, 0, "nothing was sent, so nothing was queued is true");
    assert.deepEqual(q.calls.conns, [{ failFast: true, commandTimeoutMs: 5000 }], "the console's bounded kind");
    await sleep(20);
    assert.equal(q.calls.close, 1, "and the queue is closed, so nothing is sent when a connection comes up");
    // A connection that fails outright is the same answer.
    const failing = Promise.reject(new Error("connect ECONNREFUSED"));
    failing.catch(() => {});
    const refused = fakeQueue({ client: failing });
    assert.deepEqual(await enqueue(refused.seams), { unreachable: "connect ECONNREFUSED; nothing was queued" });
    assert.equal(refused.calls.add, 0);
  });

  test(`${name} whose add was started and threw says may or may not have been queued, and nothing was queued only of Valkey's own refusal (#961)`, async () => {
    // The mark of a command Valkey took, an error without it, and a connection that died: once the add was started
    // none of them says nothing was queued.
    for (const error of [lostAnswer(), new Error("Connection is closed."), new Error("anything else")]) {
      const q = fakeQueue({ client: Promise.resolve({}), add: () => Promise.reject(error) });
      const res = await enqueue(q.seams);
      assert.deepEqual(res, enqueueUnconfirmed(what), error.message);
      assert.equal(res.invalid, `${what} may or may not have been queued: the queue did not confirm it. Preview it again first: the preview says when one is already queued or running`);
      assert.equal(res.partial, true);
    }
    const q = fakeQueue({ client: Promise.resolve({}), add: () => Promise.reject(refusal()) });
    const res = await enqueue(q.seams);
    assert.equal(res.unreachable, "READONLY You can't write against a read only replica.; nothing was queued");
    assert.equal(res.partial, undefined);
  });

  test(`${name}'s add has no timer of its own: one answered after the connect bound is still its answer, and one that ends at its client's bound is not known (#961)`, async () => {
    const slow = fakeQueue({ client: Promise.resolve({}), add: async (_n, _d, opts) => (await sleep(BOUND * 3), { id: opts?.jobId }) });
    // Its close never answers, as a QUIT to a Valkey that stopped answering: the enqueue's answer does not wait for it.
    slow.queue.close = () => ((slow.calls.close += 1), neverAnswers());
    const ok = (await timed(enqueue(slow.seams), 1500)).res;
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(slow.calls.close, 1);
    // The client's own bound: the fake rejects as the bounded client does, after longer than the connect bound.
    const bounded = fakeQueue({ client: Promise.resolve({}), add: async () => (await sleep(BOUND * 3), Promise.reject(lostAnswer())) });
    const got = await timed(enqueue(bounded.seams));
    assert.deepEqual(got.res, enqueueUnconfirmed(what));
    assert.ok(got.ms >= BOUND * 3 - 20, `the answer waited for the add's own end (${got.ms} ms)`);
    await sleep(20);
    assert.equal(bounded.calls.close, 1, "its close was started");
  });

  if (readsBack) test(`${name} whose add was answered and whose read back was lost is partial with the job's id, never ok (#961)`, async () => {
    const q = fakeQueue({ client: Promise.resolve({}), getJob: () => Promise.reject(lostAnswer()) });
    const res = await enqueue(q.seams);
    assert.equal(q.calls.add, 1);
    assert.equal(res.ok, undefined);
    assert.equal(res.partial, true);
    assert.match(res.jobId, /^local-[a-f0-9]+$/);
    assert.deepEqual(res, enqueueUnread(what, res.jobId));
    assert.equal(res.invalid, `${what} was taken as ${res.jobId}; whether it is new or an identical one from this minute was not read back. Preview it again first: the preview says when one is already queued or running`);
    assert.ok(res.invalid.indexOf(res.jobId) < 200, "the job's id comes before an audit row's cut");
  });
}

test("connectedQueue waits for a queue's connection and for nothing else, and a queue with none to wait for is handed back at once (#961)", async () => {
  const client = { id: "client" };
  const q = fakeQueue({ client: Promise.resolve(client) });
  const got = await connectedQueue({ url: "redis://x", options: { name: "pi-jobs@h" }, ...q.seams });
  assert.equal(got.queue, q.queue);
  assert.equal(got.client, client);
  assert.deepEqual(q.calls.options, [{ name: "pi-jobs@h" }]);
  const bare = fakeQueue();
  assert.deepEqual(await connectedQueue({ url: "redis://x", ...bare.seams }), { queue: bare.queue, client: null });
  assert.deepEqual([CONFIRM_READ_TIMEOUT_MS, PAID_PLAN_TIMEOUT_MS], [6000, 6000], "past the client's 5 s command bound, which a sent command ends at by itself");
});

test("a re-run after a lost answer waits for no further Valkey command: its tracker's abort is started and never awaited (#961)", async () => {
  const plan = { ...LOCAL_PLAN, touchSource: { runId: "local-1", cause: "rerun", scopeId: "a".repeat(64) } };
  const opts = { url: "redis://x", localRepoProblemFn: () => null, gitDirtyFn: () => false, connectTimeoutMs: BOUND };
  const tracker = () => {
    const seen = [];
    return { seen, touchOutbox: { begin: async (event) => (seen.push("begin"), { event }), applied: async () => (seen.push("applied"), { ok: true }), abort: () => (seen.push("abort"), neverAnswers()) } };
  };
  const lost = tracker();
  const q = fakeQueue({ client: Promise.resolve({}), add: () => Promise.reject(lostAnswer()) });
  const got = await timed(enqueueRerun(plan, { ...opts, ...q.seams, touchOutbox: lost.touchOutbox }), 1500);
  assert.deepEqual(got.res, enqueueUnconfirmed("the re-run of local-1"), "an abort that never answers does not hold the answer");
  await sleep(10);
  assert.deepEqual(lost.seen, ["begin", "abort"]);
  // The read back lost: the same.
  const unread = tracker();
  const r = fakeQueue({ client: Promise.resolve({}), getJob: () => Promise.reject(lostAnswer()) });
  const back = await timed(enqueueRerun(plan, { ...opts, ...r.seams, touchOutbox: unread.touchOutbox }), 1500);
  assert.equal(back.res.partial, true, JSON.stringify(back.res));
  await sleep(10);
  assert.deepEqual(unread.seen, ["begin", "abort"]);
  // A run that WAS queued and whose accounting then failed is queued, with a warning: never "may or may not".
  const failing = tracker();
  failing.touchOutbox.applied = () => Promise.reject(lostAnswer());
  const okQ = fakeQueue({ client: Promise.resolve({}) });
  const done = await enqueueRerun(plan, { ...opts, ...okQ.seams, touchOutbox: failing.touchOutbox });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.touchWarning, "touch-tracking-incomplete");
});

test("the touch outbox drops an aborted action's file whatever its store answers (#961)", async () => {
  const dir = tempDir("pd-961-outbox-");
  assert.match(dir, /pd-961-outbox-/);
  const files = async () => readdirSync(dir);
  const outbox = makeTouchOutbox({ dir, store: { begin: async () => ({ ok: true }), abort: () => Promise.reject(lostAnswer()) } });
  const intent = await outbox.begin({ runId: "local-1", cause: "rerun", at: 1_800_000_000_000, scopeId: "a".repeat(64), nonce: "n" });
  assert.equal((await files()).length, 1, JSON.stringify(intent));
  await assert.rejects(outbox.abort(intent), /Command timed out/);
  assert.deepEqual(await files(), [], "left behind, it was begun again on every read of the page");
});

test("a configuration fix on a Valkey that answers none of its accounting ends on the bounded client, says nothing was changed and never runs its change (#961)", async () => {
  const dir = tempDir("pd-961-track-");
  const made = [];
  // Every command is one Valkey took and never answered: the mark of a write, on what is only bookkeeping here.
  const lose = losingClient();
  const redisFn = (_url, options) => (made.push(options), Object.assign(Object.create(lose), { on() {}, disconnect() {} }));
  const service = makeZeroTouchService({ paths: { valkeyUrl: "redis://x", triggersPath: join(dir, "triggers.json"), logsDir: dir }, redisFn, now: () => 1_800_000_000_000 });
  let applied = 0;
  const entry = { ticketDigest: "b".repeat(64), afterDigest: "c".repeat(64), payload: { touchContext: { runId: "gh-refused", scopeId: "a".repeat(64), project: "web", reason: "secret-unresolved", groupId: null, triggerIndex: 0 } } };
  const got = await timed(service.trackConfiguration(entry, async () => ((applied += 1), { ok: true })).then((value) => value, (error) => ({ thrown: error })));
  assert.deepEqual(got.res, { invalid: "Fix accounting could not be prepared. Nothing was changed; try again when Valkey is available." });
  assert.equal(applied, 0);
  assert.deepEqual(made, [{ commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }], "on the bounded client, with no timer of the service's own over a path that writes");
  assert.deepEqual(readdirSync(dir).filter((name) => name === "touch-outbox").flatMap((name) => readdirSync(join(dir, name))), [], "and no pending file is left to be begun again");
});

// ---- the allowance counter ---------------------------------------------------------------------------------------------

function admitted(tag) {
  const root = realpathSync(tempDir(tag));
  const folder = join(root, "repo");
  mkdirSync(folder);
  return { folder, flow: "fix", env: { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" }, gitDirtyFn: () => false, localRepoProblemFn: () => null, revParseHeadFn: () => "deadbeef", readFlowGateFn: async () => ({ gate: "allow" }), now: () => Date.UTC(2026, 6, 22, 10, 30, 0) };
}

test("a count against the hour that was sent and not answered says one start may have been used, and queues nothing (#961)", async () => {
  const deps = admitted("pd-961-counter-");
  const counter = (error) => () => ({ eval: () => Promise.reject(error), get: () => Promise.reject(error), disconnect() {} });
  const lost = await checkDispatchRun({ ...deps, redisFn: counter(lostAnswer()) });
  assert.deepEqual(lost, { unreachable: "Command timed out", allowanceMayBeUsed: true });
  // Never sent (a timeout in the offline queue carries no mark), or a read: nothing can have been used.
  assert.deepEqual(await checkDispatchRun({ ...deps, redisFn: counter(Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" })) }), { unreachable: "Command timed out" });
  assert.deepEqual(await checkDispatchRun({ ...deps, consumeRate: false, redisFn: counter(lostAnswer()) }), { unreachable: "Command timed out" });
  const q = fakeQueue({ client: Promise.resolve({}) });
  const res = await enqueueDispatchRun({ ...deps, task: "t", aiInvoked: true, makeQueueFn: q.seams.queueFn, parseConnectionFn: q.seams.parseConnectionFn, redisFn: counter(lostAnswer()) });
  assert.deepEqual(res, { invalid: DISPATCH_RUN_ALLOWANCE_LOST, partial: true });
  assert.equal(DISPATCH_RUN_ALLOWANCE_LOST, "Nothing was queued. The dispatch_run hourly allowance was sent this start and did not answer, so one start of this hour may have been used");
  assert.deepEqual([q.calls.options.length, q.calls.add], [0, 0], "no queue is built after a lost count");
  // A queue that cannot be reached AFTER the count says the count is gone: nothing is given back.
  const down = fakeQueue({ client: neverAnswers() });
  // (`timed` holds the event loop: the bound's own timer does not.)
  const after = await timed(enqueueDispatchRun({ ...deps, task: "t", aiInvoked: true, makeQueueFn: down.seams.queueFn, parseConnectionFn: down.seams.parseConnectionFn, redisFn: () => ({ eval: async () => 1, disconnect() {} }), connectTimeoutMs: BOUND }));
  assert.deepEqual(after.res, { invalid: "Nothing was queued and one start of this hour's dispatch_run allowance was used: the queue did not connect within 0.06 seconds", partial: true }, "never unreachable, which every surface words as nothing changed: the count did");
});

// ---- the previews --------------------------------------------------------------------------------------------------------

test("the previews of a re-run, a parked answer and Fire now end at their bound when the queue never connects, each with its own sentence (#961)", async () => {
  const logsDir = tempDir("pd-961-plans-");
  const dir = tempDir("pd-961-plans-triggers-");
  const folder = join(dir, "repo");
  mkdirSync(folder);
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder, flow: "fix", task: "t" } }] }));
  const closes = [];
  const conns = [];
  const made = [];
  let dropped = 0;
  const queueFn = (_c, { name }) => ({ name, getJob: neverAnswers, getJobScheduler: neverAnswers, getJobs: neverAnswers, close: () => (closes.push(name), neverAnswers()), disconnect() {} });
  const parseConnectionFn = (_url, options) => (conns.push(options), {});
  // The record read and the fleet discovery answer; what does not is the queue.
  const record = JSON.stringify({ jobId: "gh-1", kind: "github", target: "o/r#7", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
  const redisFn = (_url, options) => (made.push(options ?? null), { on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, async get() { return record; }, async hget() { return record; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async zrevrange() { return []; }, async zrange() { return []; }, async mget(...keys) { return keys.flat().map(() => null); }, disconnect() { dropped += 1; } });
  const at = () => Date.parse("2026-10-15T11:00:00.000Z");
  const common = { url: "redis://x", logsDir, redisFn, queueFn, parseConnectionFn, planTimeoutMs: BOUND };
  const rerun = await timed(planRerun({ ...common, jobId: "gh-1", now: at }));
  assert.deepEqual(rerun.res, { refusal: "could not read the run or its job (no answer within 0.06 seconds); nothing was queued", unread: true });
  const parked = await timed(planParkedAnswer({ ...common, jobId: "gh-1", text: "yes", by: "rob", triggersPath, runsFn: async () => [], now: at }));
  assert.deepEqual(parked.res, { refusal: "could not read the parked run or its job (no answer within 0.06 seconds); nothing was queued" });
  const fire = await timed(planTriggerFire({ index: 0, triggersPath, url: "redis://x", env: {}, grantsEnv: {}, queueFn, parseConnectionFn, admissionFn: async () => ({}), planTimeoutMs: BOUND, now: at }));
  assert.deepEqual(fire.res, { unreachable: "The deployment's queue could not be read. Nothing was queued." });
  for (const { ms } of [rerun, parked, fire]) assert.ok(ms < 1500, `${ms} ms`);
  await sleep(20);
  assert.deepEqual(closes, ["pi-jobs", "pi-jobs", "pi-jobs"], "each queue's close was started, and none was waited for");
  assert.deepEqual(conns, Array(3).fill({ failFast: true, commandTimeoutMs: 5000 }), "every queue is the console's bounded kind");
  assert.ok(made.filter((o) => o?.commandTimeoutMs === 5000 && o?.disconnectTimeoutMs === 0).length >= 2, "and the record's client is the bounded one");
  assert.ok(dropped >= 2, "dropped, never left to a read that does not answer");
});

// ---- the package facts ---------------------------------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const lookOf = (host, packages) => JSON.stringify({ v: 1, host, at: NOW - 1000, everyHours: 24, pi: {}, hostPi: {}, packages });
const STAGED = { packages: ["pi-a", "pi-b", "pi-c"].map((name) => ({ name, version: "1.0.0", dir: `${name}--1.0.0--aaaaaaaa`, from: "pi-packages" })) };

/** A Valkey as `readUpdates` asks it, each read answered by `answer(what, key)`: a value, or a promise that never settles. */
function updatesValkey(answer) {
  const asked = [];
  const ask = (what, key, fallback) => {
    asked.push(`${what} ${key}`);
    const got = answer(what, key);
    return got === undefined ? Promise.resolve(fallback) : got;
  };
  return {
    asked,
    redis: {
      smembers: (key) => ask("smembers", key, key === UPDATES_HOSTS ? ["h1"] : []),
      mget: (...keys) => ask("mget", keys.flat().join(","), [lookOf("h1", STAGED.packages.map((p) => ({ name: p.name, version: p.version, newest: "1.1.0", read: "ok" })))]),
      hgetall: (key) => ask("hgetall", key, {}),
      get: (key) => ask("get", key, null),
      pttl: (key) => ask("pttl", key, 1000),
    },
  };
}

test("readUpdates on a Valkey that answers nothing ends in one bound, asks nothing more, and still lists every staged package in order (#961)", async () => {
  const v = updatesValkey(() => neverAnswers());
  const got = await timed(readUpdates({ redis: v.redis, staged: STAGED, now: NOW }), 9000);
  assert.notEqual(got.res, "hung");
  assert.ok(got.ms < 4500, `one 3 s bound, not one per read (${got.ms} ms)`);
  assert.deepEqual(got.res.packages.map((p) => p.name), ["pi-a", "pi-b", "pi-c"]);
  assert.deepEqual([got.res.state, got.res.desiredUnreadable], ["unknown", true]);
  assert.deepEqual(v.asked.sort(), [`hgetall ${UPDATES_DESIRED}`, `smembers ${UPDATES_HOSTS}`], "the first wave alone: the hosts' looks and the desired rows, at once");
});

test("readUpdates keeps the stage manifest's order whatever order its reads are answered in, and says which facts were not read (#961)", async () => {
  // The canary facts answer in reverse, and one of them never does.
  const delays = { "pi-a": 60, "pi-b": 30, "pi-c": 0 };
  const facts = (name) => JSON.stringify({ v: 1, host: "h1", at: NOW - 500, digest: "d".repeat(64), excerpt: `notes of ${name}` });
  const v = updatesValkey((what, key) => {
    if (what !== "get") return undefined;
    const name = ["pi-a", "pi-b", "pi-c"].find((n) => key === updatesCanaryKey(n, "1.1.0"));
    return name ? sleep(delays[name]).then(() => facts(name)) : undefined;
  });
  const read = await readUpdates({ redis: v.redis, staged: STAGED, now: NOW });
  assert.deepEqual(read.packages.map((p) => [p.name, p.facts?.excerpt]), [["pi-a", "notes of pi-a"], ["pi-b", "notes of pi-b"], ["pi-c", "notes of pi-c"]]);
  assert.equal(read.factsUnread, false);
  // A canary's facts that Valkey rejects, and a host's applied rows: each is "not read", never "none".
  const lostFacts = updatesValkey((what, key) => (what === "get" && key === updatesCanaryKey("pi-b", "1.1.0") ? Promise.reject(lostAnswer()) : undefined));
  const one = await readUpdates({ redis: lostFacts.redis, staged: STAGED, now: NOW });
  assert.equal(one.factsUnread, true);
  assert.deepEqual(one.packages.map((p) => p.name), ["pi-a", "pi-b", "pi-c"]);
  const lostApplied = updatesValkey((what, key) => (what === "hgetall" && key === updatesAppliedKey("h1") ? Promise.reject(lostAnswer()) : undefined));
  assert.equal((await readUpdates({ redis: lostApplied.redis, staged: STAGED, now: NOW })).factsUnread, true);
  assert.ok(updatesLookKey("h1"));
});

// ---- the trigger page ----------------------------------------------------------------------------------------------------

test("the trigger page asks its Fire now check beside its snapshot, and says so and draws no form when the check was not answered (#961)", async () => {
  const dir = tempDir("pd-961-trigger-page-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder: "/f", flow: "fix", task: "t" } }] }));
  const order = [];
  const snapshot = { readAt: NOW, triggers: { triggers: [{ type: "cron", id: "daily", pattern: "0 6 * * *", kind: "local", flow: "fix" }] }, runs: [], waiting: { rows: [] }, hostBudgets: [], schedulers: [], parked: { rows: [] } };
  const deps = {
    now: () => NOW, env: {}, paths: { triggersPath }, hostLoads: async () => null, triggerEditor: () => ({}),
    fleet: { snapshot: async () => (await sleep(60), order.push("snapshot read"), snapshot), parkedCount: async () => 0 },
    triggerFireCheck: async () => (order.push("check asked"), { unreachable: "The deployment's queue could not be read. Nothing was queued." }),
  };
  const { query } = parsePageQuery("trigger", "index=0");
  const loaded = await loadPageData("trigger", query, deps, { role: "operator", readOnly: false });
  assert.deepEqual(order, ["check asked", "snapshot read"], "one after the other, the page waited for both bounds");
  const drawn = await pagePanels("trigger", { query, session: { name: "ops", role: "operator" }, data: loaded });
  const kinds = drawn.find((p) => p.id === "p-trigger-kinds").html;
  assert.match(kinds, /Fire now could not be checked: the deployment&#39;s queue did not answer\. Reload the page to check again\./);
  assert.doesNotMatch(kinds, /data-action="trigger-fire"/, "no form is drawn for a check that was not answered");
  // A viewer's page draws no form and asks no check.
  order.length = 0;
  await loadPageData("trigger", query, deps, { role: "viewer", readOnly: false });
  assert.deepEqual(order, ["snapshot read"]);
});

// ---- the answerer service ------------------------------------------------------------------------------------------------

test("the answerer's reads end at their bound on a bounded client and throw no mark of a write; its writes are left to the client's bound (#961)", async () => {
  const dir = tempDir("pd-961-answerer-");
  const made = [];
  let dropped = 0;
  const redisFn = (_url, options) => (made.push(options), { on() {}, disconnect() { dropped += 1; } });
  const service = (store) => makeAnswererService({ paths: { valkeyUrl: "redis://x", triggersPath: join(dir, "none.json") }, redisFn, storeFn: () => store, readTimeoutMs: BOUND });
  const never = service({ publicSnapshot: neverAnswers, privateDraft: neverAnswers });
  for (const reading of [() => never.read({ role: "viewer" }), () => never.privateDraft("gh-1"), () => never.preview("answer-draft-drop", { runId: "gh-1" })]) {
    const got = await timed(reading().then((value) => ({ value }), (error) => ({ error })));
    assert.equal(got.res.error?.message, "Valkey did not answer within 0.06 seconds", JSON.stringify(got.res));
    assert.ok(got.ms < 1500);
  }
  assert.deepEqual(made, Array(3).fill({ commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }));
  assert.equal(dropped, 3, "each client is dropped at the bound");
  // A read's error carries the mark as a write's does; the service hands it on without, so no confirm reads it as a change.
  const marked = service({ privateDraft: () => Promise.reject(lostAnswer()) });
  const thrown = await marked.privateDraft("gh-1").catch((error) => error);
  assert.equal(thrown.message, "Command timed out");
  assert.equal(thrown.valkeyMayStillRun, undefined);
  // The drop: its read is timed and answers unreachable; the drop itself, once sent, throws its client's own error.
  const unread = service({ privateDraft: neverAnswers, drop: async () => assert.fail("no drop after an unread draft") });
  assert.deepEqual((await timed(unread.apply("answer-draft-drop", { payload: { params: { runId: "gh-1" } } }))).res, { unreachable: true });
});

// ---- the budget writes ---------------------------------------------------------------------------------------------------

function allocationFiles(tag) {
  const dir = tempDir(tag);
  const files = { projects: join(dir, "projects.json"), envelope: join(dir, "envelope.json"), logs: join(dir, "logs") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  return files;
}
/** A write client as `writeClient` builds it: not connected yet, `connect` and each command as `over` says. */
const writeFake = (made, over) => (_url, options) => (made.push(options), { status: "wait", on() {}, connect: async () => {}, disconnect() { made.dropped = (made.dropped ?? 0) + 1; }, ...over });

test("an envelope write whose digest was sent and not answered says may or may not and writes no file; one that was not sent keeps its sentence, and one that never connected throws the not-sent mark (#961, #965)", async () => {
  const files = allocationFiles("pd-961-envelope-");
  const before = readFileSync(files.envelope, "utf8");
  const common = { envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000, change: { totalUsd: "90" }, url: "redis://127.0.0.1:1", connectTimeoutMs: BOUND };
  const plan = planEnvelopeWrite(common);
  assert.equal(plan.invalid, undefined, JSON.stringify(plan.invalid));
  const made = [];
  const lost = await writeEnvelope({ ...common, redisFn: writeFake(made, { set: () => Promise.reject(lostAnswer()) }) });
  assert.deepEqual(lost, { invalid: envelopeDigestUnconfirmed("alloc:envelope:expected", plan.digest), partial: true });
  assert.match(lost.invalid, /^the record of the new envelope's digest in alloc:envelope:expected may or may not have been made: Valkey took it and did not answer within the bound\. The envelope file was not written\./);
  assert.deepEqual(made[0], { failFast: true, lazyConnect: true, commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }, "the write's client has the command bound");
  assert.equal(readFileSync(files.envelope, "utf8"), before);
  // Not sent: the sentence it had, and no mark.
  const unsent = await writeEnvelope({ ...common, redisFn: writeFake([], { set: () => Promise.reject(new Error("Stream isn't writeable")) }) });
  assert.equal(unsent.partial, undefined);
  assert.match(unsent.invalid, /^could not record the new envelope's digest/);
  // A client that never connects: nothing was sent, said within the bound, and the client is dropped. Its error is thrown
  // on with `valkeyNotSent` (issue #965), as a priorities plan's is, so the confirm says Valkey could not be reached.
  const never = [];
  const late = await timed(writeEnvelope({ ...common, redisFn: writeFake(never, { connect: neverAnswers }) }).then(() => "wrote", (error) => error));
  assert.deepEqual([late.res?.message, late.res?.valkeyNotSent, late.res?.valkeyMayStillRun], ["Valkey did not connect within 0.06 seconds", true, undefined]);
  assert.ok(late.ms < 1500, `${late.ms} ms`);
  assert.equal(never.dropped, 1);
  assert.equal(readFileSync(files.envelope, "utf8"), before);
  // The real client on an address that refuses the connect: ioredis says "Connection is closed.", as it does of a wrong
  // password or a database Valkey does not have, so it carries the mark too.
  const closed = await writeEnvelope({ ...common, connectTimeoutMs: 5_000, redisFn: makeRedisClient }).then(() => "wrote", (error) => error);
  assert.deepEqual([closed?.message, closed?.valkeyNotSent, closed?.valkeyMayStillRun], ["Connection is closed.", true, undefined]);
  assert.equal(readFileSync(files.envelope, "utf8"), before);
});

test("a priorities plan or a revert whose client never connects throws no mark within the bound, and one whose command was lost throws its mark on (#961)", async () => {
  const files = allocationFiles("pd-961-alloc-");
  const r = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const common = { url: "redis://127.0.0.1:1", envelope: r.envelope, digest: r.digest, projects: r.projects, host: "h1", logsDir: files.logs, now: new Date(NOW), connectTimeoutMs: BOUND };
  const writes = [
    ["a priorities plan", (redisFn) => applyPriorities({ ...common, plan: { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, keepOther: true, redisFn })],
    ["a revert", (redisFn) => revertAllocation({ ...common, target: { weights: { shop: 1, platform: 1, _other: 0 }, planId: null }, redisFn })],
  ];
  for (const [name, write] of writes) {
    const made = [];
    const late = await timed(write(writeFake(made, { connect: neverAnswers })).then(() => "wrote", (error) => error));
    assert.equal(late.res?.message, "Valkey did not connect within 0.06 seconds", name);
    assert.equal(late.res.valkeyMayStillRun, undefined, "nothing was sent, so the confirm says nothing was changed");
    assert.equal(late.res.valkeyNotSent, true, "and that Valkey could not be reached (issue #965)");
    assert.ok(late.ms < 1500, `${late.ms} ms`);
    assert.equal(made.dropped, 1, "and the client is dropped, so nothing is sent later");
    assert.deepEqual(made[0], { failFast: true, lazyConnect: true, commandTimeoutMs: 5000, disconnectTimeoutMs: 0 });
    // A connect that failed sent nothing either, whatever its error carries.
    const refused = await write(writeFake([], { connect: () => Promise.reject(lostAnswer()) })).then(() => "wrote", (error) => error);
    assert.equal(refused.valkeyMayStillRun, undefined, name);
    assert.equal(refused.valkeyNotSent, true, name);
    // A command that was sent and lost: the client's own error reaches the confirm, which says may or may not.
    const lose = losingClient();
    const lost = await write((_url) => Object.assign(Object.create(lose), { status: "wait", on() {}, connect: async () => {}, disconnect() {} })).then(() => "wrote", (error) => error);
    assert.equal(lost?.valkeyMayStillRun, true, `${name}: ${String(lost?.message ?? lost)}`);
    assert.equal(lost.valkeyNotSent, undefined, `${name}: a lost command was sent`);
  }
});

// ---- the zero touch service and the agent's start ---------------------------------------------------------------------

test("the zero touch service times the paths that only read and never the ones that carry a write (#961)", async () => {
  const dir = tempDir("pd-961-zero-touch-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [], zeroTouch: { capture: true, model: "classifier/small", maxCostUsd: "0.01", names: {} } }));
  const made = [];
  let dropped = 0;
  // A Valkey that takes every command and answers none, on a fake that keeps no bound of its own.
  const never = new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : () => neverAnswers()) });
  const redisFn = (_url, options) => (made.push(options), Object.assign(Object.create(never), { on() {}, disconnect() { dropped += 1; } }));
  const service = makeZeroTouchService({ paths: { valkeyUrl: "redis://x", triggersPath, logsDir: dir }, redisFn, now: () => 1_800_000_000_000, readTimeoutMs: BOUND, stepTimeoutMs: BOUND });
  for (const reading of [() => service.read({}), () => service.runs({}), () => service.preview("zero-touch-group", { runId: "gh-1" }), () => service.configurationContext("gh-1")]) {
    const got = await timed(reading().then((value) => ({ value }), (error) => ({ error })));
    assert.equal(got.res.error?.message, "Valkey did not answer within 0.06 seconds", JSON.stringify(got.res));
    assert.ok(got.ms < 1500, `${got.ms} ms`);
  }
  assert.deepEqual(made, Array(4).fill({ commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }), "each on the console's bounded client");
  assert.equal(dropped, 4, "dropped at the bound, so nothing more is sent");
  // The writers' path: what it runs outlives every bound of the service and is still its answer.
  const written = await service.withWriters(async ({ touchStore, touchOutbox }) => {
    assert.ok(touchStore && touchOutbox);
    await sleep(BOUND * 3);
    return { ok: true, wrote: "after the read bound" };
  });
  assert.deepEqual(written, { ok: true, wrote: "after the read bound" });
  assert.deepEqual(made.at(-1), { commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }, "on the bounded client all the same");
});

test("an agent's re-run whose count against the hour was sent and not answered is a partial refusal that says one start may have been used (#961)", async () => {
  const { checkAgentRerun } = await import("../src/agent-starts.mjs");
  const plan = { kind: "local", job: { folder: "/f", flow: "fix" } };
  const grantsEnv = { PI_DISPATCH_RUN_ROOTS: "/f", PI_DISPATCH_RUN_PER_HOUR: "3" };
  const lost = await checkAgentRerun(plan, { rm: { checkDispatchRun: async () => ({ unreachable: "Command timed out", allowanceMayBeUsed: true }) }, env: {}, grantsEnv, consumeRate: true });
  assert.deepEqual(lost, { refusal: "Nothing was queued. The paid-start allowance was sent this start and did not answer, so one start of this hour may have been used.", partial: true });
  const unread = await checkAgentRerun(plan, { rm: { checkDispatchRun: async () => ({ unreachable: "Command timed out" }) }, env: {}, grantsEnv, consumeRate: true });
  assert.deepEqual(unread, { refusal: "The paid-start admission could not read its shared allowance." });
});

// ---- a run like this one that is already queued or running ------------------------------------------------------------

const hhmm = (ms) => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;

test("the look for a run that is already queued matches by what a job's data or id says, takes the newest, and says so when it could not look (#961)", async () => {
  const byState = {
    waiting: [
      { id: "local-aaaa", timestamp: NOW - 120_000, data: { kind: "local", folder: "/srv/a", flow: "fix", task: "one" } },
      { id: "local-bbbb", timestamp: NOW - 60_000, data: { kind: "local", folder: "/srv/a", flow: "fix", task: "another task" } },
      { id: "local-cccc", timestamp: NOW, data: { kind: "local", folder: "/srv/a", flow: "review" } },
      { id: "manual:daily:1799999940000", timestamp: NOW - 30_000, data: { kind: "local", folder: "/srv/b", flow: "fix", trigger: { id: "daily" } } },
      null,
    ],
    // A cron trigger's next tick, waiting for its time: every such trigger always has one.
    delayed: [{ id: "repeat:daily:1800000000000", timestamp: NOW, data: { kind: "local", folder: "/srv/b", flow: "fix", trigger: { id: "daily" } } }],
    active: [{ id: "gh-1", timestamp: NOW, data: { kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 7 } } }],
  };
  const asked = [];
  const queue = { getJobs: async (states, start, end) => (asked.push([states, start, end]), byState[states[0]] ?? []) };
  // A local run: this flow in this folder, whatever its task; the newest of them.
  assert.deepEqual(await queuedAlready([queue], ALREADY_MATCH.local({ folder: "/srv/a", flow: "fix" })), { jobId: "local-bbbb", queuedAt: NOW - 60_000 });
  assert.deepEqual(asked.slice(0, 5), ["active", "waiting", "prioritized", "delayed", "paused"].map((state) => [[state], 0, 200]), "each state by itself, one more than the bound");
  assert.equal(await queuedAlready([queue], ALREADY_MATCH.local({ folder: "/srv/a", flow: "triage" })), null);
  assert.equal(await queuedAlready([queue], ALREADY_MATCH.local({ folder: "/srv/z", flow: "fix" })), null);
  // The scheduler's tick that is still delayed is no run "already queued": only the hand fire in the same folder is.
  assert.deepEqual(await queuedAlready([queue], ALREADY_MATCH.local({ folder: "/srv/b", flow: "fix" })), { jobId: "manual:daily:1799999940000", queuedAt: NOW - 30_000 });
  const tickOnly = { getJobs: async ([state]) => (state === "delayed" ? byState.delayed : []) };
  assert.equal(await queuedAlready([tickOnly], ALREADY_MATCH.local({ folder: "/srv/b", flow: "fix" })), null, "a cron trigger on this folder and flow does not make the warning permanent");
  // A tick whose time has come waits or runs like any other run.
  const due = { getJobs: async ([state]) => (state === "active" ? byState.delayed : []) };
  assert.equal((await queuedAlready([due], ALREADY_MATCH.local({ folder: "/srv/b", flow: "fix" })))?.jobId, "repeat:daily:1800000000000");
  // A hand fire of a cron trigger, by its id's prefix: never the scheduler's own next tick.
  assert.deepEqual(await queuedAlready([queue], ALREADY_MATCH.manual("daily")), { jobId: "manual:daily:1799999940000", queuedAt: NOW - 30_000 });
  assert.equal(await queuedAlready([queue], ALREADY_MATCH.manual("dail")), null, "another trigger's id is no prefix of this one's");
  // A forge run: this flow on this item.
  assert.deepEqual(await queuedAlready([queue], ALREADY_MATCH.forge({ kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 7 } })), { jobId: "gh-1", queuedAt: NOW });
  assert.equal(await queuedAlready([queue], ALREADY_MATCH.forge({ kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 8 } })), null);
  // Could not look: a read that failed, or a queue with no list to ask.
  assert.equal(await queuedAlready([{ getJobs: () => Promise.reject(lostAnswer()) }], () => true), ALREADY_UNCHECKED);
  assert.equal(await queuedAlready([{}], () => true), ALREADY_UNCHECKED);
  // The cut is judged per state: 199 waiting, 1 active and 2 delayed were all read, 201 of one state were not.
  const filled = (counts) => ({ getJobs: async ([state]) => Array.from({ length: Math.min(counts[state] ?? 0, 201) }, (_, i) => ({ id: `${state}-${i}`, data: {} })) });
  assert.equal(ALREADY_PER_STATE, 200);
  assert.equal(await queuedAlready([filled({ waiting: 199, active: 1, delayed: 2 })], () => false), null, "a queue that was read whole is never said to be cut");
  assert.equal(await queuedAlready([filled({ waiting: 200 })], () => false), null);
  assert.equal(await queuedAlready([filled({ waiting: 201 })], () => false), ALREADY_CUT);
  assert.equal((await queuedAlready([filled({ waiting: 201 })], (job) => job.id === "waiting-3"))?.jobId, "waiting-3", "a match among those read is still said");
  // The lines a preview adds.
  const ASKS = "Confirming asks for another: the queue refuses it while it takes it as a duplicate, and queues a second run after that.";
  assert.equal(alreadyQueuedLine("a run of flow fix for this folder", null), null);
  assert.equal(alreadyQueuedLine("a run of flow fix for this folder", { jobId: "local-bbbb", queuedAt: NOW }), `A run of flow fix for this folder is already queued or running (local-bbbb, queued at ${hhmm(NOW)}). ${ASKS}`);
  assert.equal(alreadyQueuedLine("a hand-fired run of this cron trigger", { jobId: "manual:daily:1", queuedAt: null }, { counts: true }), `A hand-fired run of this cron trigger is already queued or running (manual:daily:1). ${ASKS} A refused one still uses a start of this hour.`);
  assert.equal(alreadyQueuedLine("a run of flow fix for this folder", ALREADY_UNCHECKED), "Whether a run of flow fix for this folder is already queued or running could not be checked: its queue could not be read. Preview again before confirming.");
  assert.equal(alreadyQueuedLine("a run of flow fix for this folder", ALREADY_CUT), "Whether a run of flow fix for this folder is already queued or running could not be checked: its queue holds more than 200 jobs of one state, and none of those read was one.");
  // The sentences an audit row keeps whole, or whose facts come before its cut.
  for (const sentence of [GROUP_UNCONFIRMED, GROUP_STATUS_UNANSWERED]) assert.ok(sentence.length <= CONSOLE_AUDIT_FIELD_MAX, sentence);
});

test("a re-run's preview says a run like it is already queued or running, by its kind's own match, and nothing when none is (#961)", async () => {
  const logsDir = tempDir("pd-961-already-");
  const at = Date.parse("2026-10-15T10:00:00.000Z");
  writeFileSync(join(logsDir, "local-src.json"), JSON.stringify({ jobId: "local-src", kind: "local", outcome: "failed", reason: "agent-error", startedAt: new Date(at - 60_000).toISOString(), endedAt: new Date(at).toISOString() }));
  let queued = [];
  const clock = () => at + 60_000;
  const source = { id: "local-src", data: { kind: "local", folder: "/srv/a", flow: "fix", task: "t" } };
  const seams = {
    url: "redis://x", logsDir, jobId: "local-src", parseConnectionFn: () => ({}), localRepoProblemFn: () => null, gitDirtyFn: () => false,
    redisFn: () => ({ on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, disconnect() {} }),
    queueFn: (_c, { name }) => ({ name, getJob: async (id) => (id === "local-src" ? source : null), getJobs: async ([state]) => ((lists += 1), state === "waiting" ? queued : []), close: async () => {} }),
  };
  let lists = 0;
  const none = await planRerun({ ...seams, now: clock });
  assert.equal(none.plan?.kind, "local", JSON.stringify(none));
  assert.equal(none.already, null, "nothing is queued, so the preview says nothing");
  queued = [{ id: "local-other", timestamp: at, data: { kind: "local", folder: "/srv/elsewhere", flow: "fix" } }, { id: "local-9f", timestamp: at + 30_000, data: { kind: "local", folder: "/srv/a", flow: "fix", task: "t" } }];
  const again = await planRerun({ ...seams, now: clock });
  assert.deepEqual(again.already, { jobId: "local-9f", queuedAt: at + 30_000 });
  assert.equal(JSON.stringify(again.plan), JSON.stringify(none.plan), "beside the plan, never in it: the ticket binds the same plan either way");
  // A confirm's re-plan asks for no list: it has no use for the answer, and its reads have a bound to keep.
  lists = 0;
  const replan = await planRerun({ ...seams, now: clock, lookAlready: false });
  assert.deepEqual([replan.already, lists, JSON.stringify(replan.plan) === JSON.stringify(none.plan)], [null, 0, true]);
  // A cron run's re-run matches a hand fire of ITS trigger, never a local run that only shares its folder and flow.
  writeFileSync(join(logsDir, `${sanitizeJobId("manual:daily:1760522400000")}.json`), JSON.stringify({ jobId: "manual:daily:1760522400000", kind: "local", outcome: "failed", reason: "agent-error", startedAt: new Date(at - 60_000).toISOString(), endedAt: new Date(at).toISOString() }));
  const cronSeams = {
    ...seams, jobId: "manual:daily:1760522400000", triggersPath: join(logsDir, "triggers.json"), now: clock,
    loadSchedulesFn: () => [{ schedulerId: "daily", name: "local", data: { kind: "local", folder: "/srv/a", flow: "fix", task: "t", trigger: { id: "daily" } }, opts: {} }],
    queueFn: (_c, { name }) => ({ name, getJob: async () => ({ id: "manual:daily:1760522400000", data: { kind: "local", folder: "/srv/a", flow: "fix", trigger: { id: "daily" } } }), getJobs: async ([state]) => (state === "waiting" ? queued : []), close: async () => {} }),
  };
  const cron = await planRerun(cronSeams);
  assert.equal(cron.plan?.kind, "cron", JSON.stringify(cron));
  assert.equal(cron.already, null, "the local run in that folder is no hand fire of this trigger");
  queued = [...queued, { id: "manual:daily:1760522460000", timestamp: at + 40_000, data: { kind: "local", folder: "/srv/a", flow: "fix", trigger: { id: "daily" } } }];
  assert.deepEqual((await planRerun(cronSeams)).already, { jobId: "manual:daily:1760522460000", queuedAt: at + 40_000 });
  // A queue whose list could not be read: said as not checked, and the run is still planned.
  const unread = await planRerun({ ...seams, now: clock, queueFn: (_c, { name }) => ({ name, getJob: async () => source, getJobs: () => Promise.reject(lostAnswer()), close: async () => {} }) });
  assert.ok(unread.plan);
  assert.equal(unread.already, ALREADY_UNCHECKED);
});

test("a dispatch run's look asks this host's queue on the bounded connection, ends at its bound and waits for no close (#961)", async () => {
  const conns = [], names = [];
  let closes = 0;
  const queueFn = (jobs) => (_c, { name }) => (names.push(name), { name, getJobs: jobs, close: () => ((closes += 1), neverAnswers()), disconnect() {} });
  const common = { url: "redis://x", folder: "/srv/a", flow: "fix", env: { PI_WORKER_NAME: "mini1" }, parseConnectionFn: (_url, options) => (conns.push(options), {}), timeoutMs: BOUND };
  const found = await timed(dispatchRunAlready({ ...common, queueFn: queueFn(async () => [{ id: "local-1", timestamp: NOW, data: { kind: "local", folder: "/srv/a", flow: "fix" } }]) }), 1500);
  assert.deepEqual(found.res, { jobId: "local-1", queuedAt: NOW });
  assert.deepEqual([names, conns], [["pi-jobs@mini1"], [{ failFast: true, commandTimeoutMs: 5000 }]]);
  assert.equal((await timed(dispatchRunAlready({ ...common, queueFn: queueFn(async () => []) }), 1500)).res, null);
  const late = await timed(dispatchRunAlready({ ...common, queueFn: queueFn(neverAnswers) }), 1500);
  assert.equal(late.res, ALREADY_UNCHECKED);
  await sleep(10);
  assert.equal(closes, 3, "each close was started");
});

test("a re-plan whose reads went unanswered is marked unread, which a changed run never is (#961)", async () => {
  const logsDir = tempDir("pd-961-unread-");
  const at = Date.parse("2026-10-15T10:00:00.000Z");
  writeFileSync(join(logsDir, "local-src.json"), JSON.stringify({ jobId: "local-src", kind: "local", outcome: "failed", reason: "agent-error", startedAt: new Date(at - 60_000).toISOString(), endedAt: new Date(at).toISOString() }));
  const base = { url: "redis://x", logsDir, parseConnectionFn: () => ({}), localRepoProblemFn: () => null, gitDirtyFn: () => false };
  const clock = () => at + 60_000;
  const queueFn = (_c, { name }) => ({ name, getJob: async () => null, getJobs: async () => [], close: async () => {} });
  // The registry could not be read, so the job was not looked for in every queue: not "its data expired".
  const blind = await planRerun({ ...base, now: clock, jobId: "local-src", queueFn, redisFn: () => ({ on() {}, smembers: () => Promise.reject(lostAnswer()), async scan() { return ["0", []]; }, disconnect() {} }) });
  assert.equal(blind.unread, true, JSON.stringify(blind));
  assert.match(blind.refusal, /^the deployment's queues could not all be read, so local-src's job was not looked for in every queue; nothing was queued, try again$/);
  // Read whole and not there: a fact about the run, and no mark.
  const gone = await planRerun({ ...base, now: clock, jobId: "local-src", queueFn, redisFn: () => ({ on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, disconnect() {} }) });
  assert.equal(gone.unread, undefined, JSON.stringify(gone));
  assert.equal(typeof gone.refusal, "string");
  // No record anywhere is a fact too.
  const missing = await planRerun({ ...base, now: clock, jobId: "local-none", queueFn, redisFn: () => ({ on() {}, async get() { return null; }, async hget() { return null; }, async smembers() { return []; }, async scan() { return ["0", []]; }, disconnect() {} }) });
  assert.equal(missing.unread, undefined, JSON.stringify(missing));
});

test("Fire now says the hour's count was used in every answer after it: a file that changed since, a duplicate, a lost add (#961)", async () => {
  const dir = tempDir("pd-961-used-");
  const folder = join(dir, "repo");
  mkdirSync(folder);
  const triggersPath = join(dir, "triggers.json");
  const doc = (turns) => JSON.stringify({ triggers: [{ on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder, flow: "fix", task: "t", maxTurns: turns } }] });
  writeFileSync(triggersPath, doc(7));
  const at = () => Date.UTC(2026, 0, 2, 12, 0, 10);
  let latched = false;
  const stored = new Map();
  const queue = { getJobScheduler: async () => ({ key: "daily" }), getJobs: async () => [], close: () => neverAnswers(), disconnect() {}, add: async (_n, data, opts) => { if (!stored.has(opts.jobId)) stored.set(opts.jobId, { data, timestamp: at(), getState: async () => "waiting" }); }, getJob: async (id) => stored.get(id) };
  const options = { index: 0, triggersPath, url: "redis://x", env: {}, grantsEnv: {}, now: at, queueFn: () => queue, parseConnectionFn: () => ({}), admissionFn: async () => ({}), redisFn: () => ({ async set() { if (latched) return null; latched = true; return "OK"; }, disconnect() {} }) };
  const { plan, already } = await planTriggerFire({ ...options, lookAlready: true });
  assert.equal(already, null);
  // The file changes after the count: refused, and the count is gone.
  const changed = await timed(enqueueTriggerFire(plan, { ...options, admissionFn: async ({ consumeRate }) => { if (consumeRate) writeFileSync(triggersPath, doc(8)); return {}; } }), 1500);
  assert.equal(changed.res.refusal, "The triggers file changed since the preview. Preview Fire now again. Nothing was queued. One start of this hour's dispatch_run allowance was used.");
  writeFileSync(triggersPath, doc(7));
  // A fire that queues answers though its queue's close never does.
  const fired = await timed(enqueueTriggerFire(plan, options), 1500);
  assert.equal(fired.res.ok, true, JSON.stringify(fired.res));
  // The minute is taken: nothing queued, the count used.
  const dup = await timed(enqueueTriggerFire(plan, options), 1500);
  assert.equal(dup.res.refusal, "This cron trigger was already fired this minute. Nothing was queued. One start of this hour's dispatch_run allowance was used.");
  // A lost add, in a minute of its own.
  latched = false;
  const lost = await timed(enqueueTriggerFire(plan, { ...options, queueFn: (c, o) => (o?.name && queue.getJobScheduler ? { ...queue, add: () => Promise.reject(lostAnswer()) } : queue) }), 1500);
  assert.equal(lost.res.invalid, FIRE_UNCONFIRMED);
  assert.equal(FIRE_UNCONFIRMED, "A run may have been queued and one start of this hour was used: Fire now got no queue acknowledgement. Preview it again first: the preview says when one is already queued or running");
  assert.ok(FIRE_UNCONFIRMED.endsWith(LOOK_FIRST), "the same pointer as every other paid start's");
  assert.ok(FIRE_UNCONFIRMED.length <= CONSOLE_AUDIT_FIELD_MAX, "an audit row keeps the whole sentence, the start it used included");
  // And the plan says a hand fire is queued, by its id.
  let lists = 0;
  const holding = () => ({ ...queue, getJobs: async ([state]) => ((lists += 1), state === "delayed" ? [{ id: "repeat:daily:1", timestamp: at(), data: {} }] : state === "waiting" ? [{ id: "manual:daily:1767355200000", timestamp: at(), data: {} }] : []) });
  const queued = await planTriggerFire({ ...options, lookAlready: true, queueFn: holding });
  assert.deepEqual(queued.already, { jobId: "manual:daily:1767355200000", queuedAt: at() });
  // Only a preview asks: the trigger page's check and a confirm's re-plan read no job list at all.
  lists = 0;
  assert.equal((await planTriggerFire({ ...options, queueFn: holding })).already, null);
  latched = false;
  assert.equal((await timed(enqueueTriggerFire(plan, { ...options, now: () => at() + 180_000, queueFn: holding }), 1500)).res.ok, true);
  assert.equal(lists, 0);
});

test("the answerer's sent mark times its read and answers false, and the envelope's restore that was not answered is partial (#961)", async () => {
  const dir = tempDir("pd-961-sent-");
  const service = makeAnswererService({ paths: { valkeyUrl: "redis://x", triggersPath: join(dir, "none.json") }, redisFn: () => ({ on() {}, disconnect() {} }), storeFn: () => ({ privateDraft: neverAnswers, markSent: async () => assert.fail("no mark after an unread draft") }), readTimeoutMs: BOUND });
  const sent = await timed(service.sent({ runId: "gh-1", draftRunId: "d", digest: "x", text: "t", by: "ops" }), 1500);
  assert.equal(sent.res, false);
  assert.ok(sent.ms < 1000, `${sent.ms} ms`);
  // The envelope: the digest was set, the file could not be replaced, and the put-back was not answered.
  const files = allocationFiles("pd-961-restore-");
  const common = { envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000, change: { totalUsd: "90" }, url: "redis://127.0.0.1:1" };
  const res = await writeEnvelope({ ...common, expect: [{ path: files.envelope, text: "not what is on disk" }], redisFn: writeFake([], { set: async () => null, eval: () => Promise.reject(lostAnswer()) }) });
  assert.equal(res.partial, true, JSON.stringify(res));
  assert.match(res.invalid, /could not be put back to absent \(Command timed out\): it may hold [a-f0-9]{16,64}, a digest no file has/);
});

test("readUpdates does not wait on the doctor index's host list: it has a bound of its own (#961)", async () => {
  const { DOCTOR_HOSTS } = await import("@edgehero/pi-dispatch/doctor-results");
  const v = updatesValkey((what, key) => (what === "smembers" && key === DOCTOR_HOSTS ? neverAnswers() : undefined));
  const got = await timed(readUpdates({ redis: v.redis, staged: STAGED, now: NOW, hostsTimeoutMs: BOUND }), 2500);
  assert.notEqual(got.res, "hung");
  assert.deepEqual(got.res.packages.map((p) => p.name), ["pi-a", "pi-b", "pi-c"]);
  assert.equal(got.res.state, "looking");
});

test("a zero touch confirm whose re-plan was not answered says Valkey could not be reached, never a change that may have been made (#961)", async () => {
  const dir = tempDir("pd-961-replan-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [], zeroTouch: { capture: true, model: "classifier/small", maxCostUsd: "0.01", names: {} } }));
  const redisFn = () => Object.assign(Object.create(losingClient()), { on() {}, disconnect() {} });
  const service = makeZeroTouchService({ paths: { valkeyUrl: "redis://x", triggersPath, logsDir: dir }, redisFn, queueFn: () => assert.fail("no queue after an unread plan"), now: () => 1_800_000_000_000 });
  const got = await service.apply("zero-touch-group", { payload: { params: { runId: "gh-1" } }, ticketDigest: "b".repeat(64) }).then((value) => value, (error) => ({ thrown: error }));
  assert.deepEqual(got, { unreachable: true });
});
