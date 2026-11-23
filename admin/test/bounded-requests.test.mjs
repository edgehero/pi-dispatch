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
import { DISPATCH_RUN_ALLOWANCE_LOST, QUEUE_CLOSE_TIMEOUT_MS, applyPriorities, checkDispatchRun, enqueueDispatchRun, enqueueParkedAnswer, enqueueRerun, envelopeDigestUnconfirmed, planEnvelopeWrite, planParkedAnswer, planRerun, readAllocations, readEnvelope, revertAllocation, writeEnvelope, writeTracking } from "../src/read-model.mjs";
import { ALREADY_CUT, ALREADY_MATCH, ALREADY_PER_STATE, ALREADY_UNCHECKED, APPROVAL_NOT_PENDING, APPROVAL_UNREAD, CONNECT_ENDED, LOOK_FIRST, CONFIRM_READ_TIMEOUT_MS, PAID_PLAN_TIMEOUT_MS, alreadyQueuedLine, connectedQueue, dispatchRunAlready, enqueueUnconfirmed, enqueueUnread, queuedAlready } from "../src/job-actions.mjs";
import { approvalTargetKey } from "@edgehero/pi-dispatch/approval-state";
import { ALLOC_EXPECTED_KEY, ALLOC_LOCK_KEY, ALLOC_LOG_KEY, ALLOC_PLAN_KEY, CAS_SCRIPT, SEED_SCRIPT, STATE_CHANGE_OUTCOMES, makeAllocationState } from "@edgehero/pi-dispatch/allocation";
import { envelopeDigest, parseEnvelope } from "@edgehero/pi-dispatch/envelope";
import { fakeAllocRedis } from "./helpers/fake-alloc-redis.mjs";
import { HISTORY_SETTLE_MS, expectedOther, expectedOtherText, historyBehind, historyBehindText } from "../src/render.mjs";
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

// Issue #987: what a paid enqueue says is what it sent. A queue whose client settled ENDED never connected, and a forge
// enqueue's own checks come before its add (its builder, its read of a durable approval, the connect of the queue an
// approval is routed to), so each of them is "nothing was queued" with its own reason, never "may or may not". The
// helper is the real one (`enqueueForgeJob`, with the real approval store) over a fake client.

for (const [name, , , enqueue] of ENQUEUES) {
  test(`${name} whose queue's client settled ended answers unreachable, and its add is never sent (#987)`, async () => {
    // BullMQ's wait for a ready client resolves, with the client, when it ended with no error event.
    const q = fakeQueue({ client: Promise.resolve({ status: "end" }) });
    const got = await timed(enqueue(q.seams));
    assert.deepEqual(got.res, { unreachable: "the queue's connection closed before it was ready; nothing was queued" });
    assert.equal(got.res.unreachable, CONNECT_ENDED);
    assert.equal(q.calls.add, 0, "nothing was sent, so nothing was queued is true");
    await sleep(20);
    assert.equal(q.calls.close, 1, "and the queue is closed");
    // Any other status is a client to send on: a reconnecting one still takes the add, and says what it threw.
    const dropped = fakeQueue({ client: Promise.resolve({ status: "reconnecting" }), add: () => Promise.reject(new Error("Connection is closed.")) });
    assert.equal((await enqueue(dropped.seams)).partial, true);
    assert.equal(dropped.calls.add, 1);
  });
}

/** The durable approval a parked run waits on, as the approval store keeps it, and the answer the console planned for it. */
const APPROVAL = { version: 1, requestId: "a".repeat(64), runId: "gh-parked", kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, action: "deploy:staging", toolCallId: "call-1", configDigest: "digest", sessionKey: "session-key", host: "host-1", createdAt: 123456, state: "pending" };
const APPROVAL_PLAN = { ...PARKED_PLAN, job: { ...PARKED_PLAN.job, parkedReply: false, approvalRequestId: APPROVAL.requestId } };
/** A forge re-run of a gated comment job: the helper reads the item's approval for it too, and binds a pending one. */
const GATED_RERUN = { kind: "forge", forge: "github", jobId: "gh-gated", deliveryId: "console-0123456789abcdef", queue: "pi-jobs", job: { repo: "o/r", target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "fix", gates: ["deploy:staging"], trigger: { event: "issue_comment", action: "created", deliveryId: "console-0123456789abcdef", sender: { id: 1 }, comment: { body: "/pi fix" } } } };
/** A queue client the approval store reads through: the item's active request is `request` (null for none). */
const approvalClient = (request) => ({
  eval() {
    throw new Error("an enqueue only reads the approval");
  },
  get: async (key) => (key === approvalTargetKey(APPROVAL) ? (request?.requestId ?? null) : request ? JSON.stringify(request) : null),
});
const FORGE_ENQUEUES = [
  ["a parked answer", "the answer to gh-parked", (seams, plan = APPROVAL_PLAN) => enqueueParkedAnswer(plan, { url: "redis://x", ...seams, connectTimeoutMs: BOUND })],
  ["a forge re-run", "the re-run of gh-gated", (seams, plan = GATED_RERUN) => enqueueRerun(plan, { url: "redis://x", ...seams, connectTimeoutMs: BOUND })],
];

test("a parked answer whose approval is no longer the pending one, or could not be read, is refused in the preview's words with nothing sent (#987)", async () => {
  assert.deepEqual([APPROVAL_NOT_PENDING, APPROVAL_UNREAD], ["the approval request is no longer pending for this run; nothing was queued", "the durable approval request could not be read; nothing was queued, try again"]);
  // Stale: the item has no active request any more, or another one.
  for (const active of [null, { ...APPROVAL, requestId: "b".repeat(64) }]) {
    const q = fakeQueue({ client: Promise.resolve(approvalClient(active)) });
    assert.deepEqual(await enqueueParkedAnswer(APPROVAL_PLAN, { url: "redis://x", ...q.seams, connectTimeoutMs: BOUND }), { refusal: APPROVAL_NOT_PENDING });
    assert.equal(q.calls.add, 0);
    await sleep(10);
    assert.equal(q.calls.close, 1);
  }
  // Unread: the read threw, with the mark of a command Valkey took and never answered. A read's error carries that
  // mark as a write's does, and it says nothing of an add that was never started.
  for (const [, , enqueue] of FORGE_ENQUEUES) {
    const lost = fakeQueue({ client: Promise.resolve({ eval() {}, get: () => Promise.reject(lostAnswer()) }) });
    assert.deepEqual(await enqueue(lost.seams), { refusal: APPROVAL_UNREAD });
    assert.equal(lost.calls.add, 0);
  }
  // The same request, still the item's active one: queued, on the plan's queue.
  const q = fakeQueue({ client: Promise.resolve(approvalClient(APPROVAL)) });
  assert.deepEqual(await enqueueParkedAnswer(APPROVAL_PLAN, { url: "redis://x", ...q.seams, connectTimeoutMs: BOUND }), { ok: true, jobIds: ["gh-console-0123456789abcdef"], queue: "pi-jobs" });
  assert.equal(q.calls.add, 1);
});

test("a forge enqueue whose builder refuses the job is a refusal that names what it threw, never Valkey unreachable and never may or may not (#987)", async () => {
  const unsigned = { ...PARKED_PLAN, job: { ...PARKED_PLAN.job, console: { by: "Not A Token" } } };
  const merging = { ...GATED_RERUN, job: { ...GATED_RERUN.job, gates: undefined, mayMerge: "yes" } };
  for (const [enqueue, plan, words] of [[FORGE_ENQUEUES[0][2], unsigned, /^the job could not be built \(enqueueForgeJob: console\.by must be a console token name .*\); nothing was queued$/], [FORGE_ENQUEUES[1][2], merging, /^the job could not be built \(merge-policy-invalid\); nothing was queued$/]]) {
    const q = fakeQueue({ client: Promise.resolve({}) });
    const res = await enqueue(q.seams, plan);
    assert.deepEqual(Object.keys(res), ["refusal"], JSON.stringify(res));
    assert.match(res.refusal, words);
    assert.equal(q.calls.add, 0);
    await sleep(10);
    assert.equal(q.calls.close, 1);
  }
});

/** Two queues by name, as an approval routed to its owner host's queue needs: the plan's own and the routed one. */
function routedQueues({ routedClient = Promise.resolve({}), routedAdd } = {}) {
  const request = { ...APPROVAL, hostQueue: "pi-jobs@host-1" };
  const first = fakeQueue({ client: Promise.resolve(approvalClient(request)) });
  const routed = fakeQueue({ client: routedClient, add: routedAdd });
  routed.queue.name = request.hostQueue;
  const built = [];
  const queueFn = (_connection, options) => (built.push(options.name), options.name === request.hostQueue ? routed.queue : first.queue);
  return { first, routed, built, seams: { queueFn, parseConnectionFn: first.seams.parseConnectionFn } };
}

for (const [name, what, enqueue] of FORGE_ENQUEUES) {
  test(`${name} routed to another host's queue connects that queue under the connect bound too, and says nothing was queued when it does not (#987)`, async () => {
    // It never connects: the bound ends it, nothing was asked of either queue, and both are closed without a wait.
    const never = routedQueues({ routedClient: neverAnswers() });
    never.routed.queue.close = () => ((never.routed.calls.close += 1), neverAnswers());
    const late = await timed(enqueue(never.seams));
    assert.deepEqual(late.res, { unreachable: "the queue did not connect within 0.06 seconds; nothing was queued" });
    assert.ok(late.ms < 1500, `${late.ms} ms`);
    assert.deepEqual(never.built, ["pi-jobs", "pi-jobs@host-1"]);
    assert.deepEqual(never.first.calls.conns, [{ failFast: true, commandTimeoutMs: 5000 }, { failFast: true, commandTimeoutMs: 5000 }], "both are the console's bounded kind");
    assert.deepEqual([never.first.calls.add, never.routed.calls.add], [0, 0]);
    await sleep(20);
    assert.deepEqual([never.first.calls.close, never.routed.calls.close], [1, 1]);
    // It ended before it was ready, or its connect failed: the same, each with its own words.
    const ended = routedQueues({ routedClient: Promise.resolve({ status: "end" }) });
    assert.deepEqual(await enqueue(ended.seams), { unreachable: CONNECT_ENDED });
    const failing = Promise.reject(new Error("connect ECONNREFUSED"));
    failing.catch(() => {});
    const refused = routedQueues({ routedClient: failing });
    assert.deepEqual(await enqueue(refused.seams), { unreachable: "connect ECONNREFUSED; nothing was queued" });
    assert.deepEqual([ended.routed.calls.add, refused.routed.calls.add, ended.first.calls.add, refused.first.calls.add], [0, 0, 0, 0]);
  });

  test(`${name} routed to another host's queue adds there alone, waits for no close of it, and says may or may not once that add was started and lost (#987)`, async () => {
    const landed = routedQueues();
    // The routed queue's close never answers, as a QUIT to a Valkey that stopped answering.
    landed.routed.queue.close = () => ((landed.routed.calls.close += 1), neverAnswers());
    const ok = await timed(enqueue(landed.seams), 1500);
    assert.equal(ok.res.ok, true, JSON.stringify(ok.res));
    assert.equal(ok.res.queue, "pi-jobs@host-1", "the answer names the queue the job is on, which is where its cancel looks");
    assert.deepEqual([landed.first.calls.add, landed.routed.calls.add], [0, 1], "the plan's own queue never receives the job");
    assert.ok(ok.ms < QUEUE_CLOSE_TIMEOUT_MS / 2, `the answer did not wait for the routed queue's close (${ok.ms} ms)`);
    await sleep(20);
    assert.deepEqual([landed.first.calls.close, landed.routed.calls.close], [1, 1], "each closed once, by the console");
    // The add was started and its answer lost: not known. Valkey's own refusal of it: nothing was queued.
    const lost = routedQueues({ routedAdd: () => Promise.reject(lostAnswer()) });
    assert.deepEqual(await enqueue(lost.seams), enqueueUnconfirmed(what));
    const refusing = routedQueues({ routedAdd: () => Promise.reject(refusal()) });
    assert.deepEqual(await enqueue(refusing.seams), { unreachable: "READONLY You can't write against a read only replica.; nothing was queued" });
  });
}

test("the routed queue's close is started and never waited for, and a close that is not answered ends in a dropped connection at the close bound (#987)", async () => {
  // Both forge enqueues at once, each with a routed queue whose close never answers: one wait covers the close bound.
  const cases = FORGE_ENQUEUES.map(([name, , enqueue]) => {
    const q = routedQueues();
    q.routed.queue.close = () => ((q.routed.calls.close += 1), neverAnswers());
    return { name, q, answer: timed(enqueue(q.seams), QUEUE_CLOSE_TIMEOUT_MS * 3) };
  });
  for (const { name, q, answer } of cases) {
    const got = await answer;
    assert.equal(got.res.ok, true, `${name}: ${JSON.stringify(got.res)}`);
    assert.ok(got.ms < QUEUE_CLOSE_TIMEOUT_MS / 2, `${name}: answered before the close bound, not at it (${got.ms} ms)`);
    assert.equal(q.routed.calls.disconnect, 0, `${name}: the close has its bound still`);
  }
  await sleep(QUEUE_CLOSE_TIMEOUT_MS + 200);
  for (const { name, q } of cases) {
    // A bare close would leave the socket of a Valkey that never answers its QUIT open for as long as that lasts.
    assert.deepEqual([q.routed.calls.close, q.routed.calls.disconnect], [1, 1], `${name}: closed once, and dropped when the close was not answered`);
    assert.deepEqual([q.first.calls.close, q.first.calls.disconnect], [1, 0], `${name}: the plan's own queue closed and was left alone`);
  }
});

test("a forge re-run refused before any add takes its touch intent back before it answers, and waits for no abort where Valkey did not answer (#987)", async () => {
  const tracked = { ...GATED_RERUN, touchSource: { runId: "gh-gated", cause: "rerun", scopeId: "a".repeat(64) } };
  // An abort that takes a while and says when it is done, and one that never answers.
  const tracker = (abort) => {
    const seen = [];
    return { seen, touchOutbox: { begin: async (event) => (seen.push("begin"), { event }), applied: async () => (seen.push("applied"), { ok: true }), abort: () => (seen.push("abort"), abort(seen)) } };
  };
  const slowly = async (seen) => (await sleep(40), seen.push("aborted"));
  // Refused with Valkey answering: the builder's refusal. The intent is gone when "nothing was queued" is said.
  const refused = tracker(slowly);
  const built = fakeQueue({ client: Promise.resolve({}) });
  const res = await enqueueRerun({ ...tracked, job: { ...tracked.job, gates: undefined, mayMerge: "yes" } }, { url: "redis://x", ...built.seams, connectTimeoutMs: BOUND, touchOutbox: refused.touchOutbox });
  assert.match(res.refusal, /^the job could not be built \(merge-policy-invalid\); nothing was queued$/);
  assert.deepEqual(refused.seen, ["begin", "abort", "aborted"], "no tracker is left begun behind a refusal");
  assert.equal(built.calls.add, 0);
  // Valkey did not answer the approval's read, or the routed queue's connect: the abort is started, and an abort that
  // never answers does not hold the answer.
  const unread = tracker(neverAnswers);
  const lost = fakeQueue({ client: Promise.resolve({ eval() {}, get: () => Promise.reject(lostAnswer()) }) });
  const first = await timed(enqueueRerun(tracked, { url: "redis://x", ...lost.seams, connectTimeoutMs: BOUND, touchOutbox: unread.touchOutbox }), 1500);
  assert.deepEqual(first.res, { refusal: APPROVAL_UNREAD });
  const unreached = tracker(neverAnswers);
  const never = routedQueues({ routedClient: neverAnswers() });
  const second = await timed(enqueueRerun(tracked, { url: "redis://x", ...never.seams, connectTimeoutMs: BOUND, touchOutbox: unreached.touchOutbox }), 1500);
  assert.deepEqual(second.res, { unreachable: "the queue did not connect within 0.06 seconds; nothing was queued" });
  await sleep(10);
  assert.deepEqual([unread.seen, unreached.seen], [["begin", "abort"], ["begin", "abort"]]);
  // Queued: the intent is applied, never aborted.
  const queued = tracker(slowly);
  const landed = routedQueues();
  const done = await enqueueRerun(tracked, { url: "redis://x", ...landed.seams, connectTimeoutMs: BOUND, touchOutbox: queued.touchOutbox });
  assert.deepEqual([done.ok, done.queue, queued.seen], [true, "pi-jobs@host-1", ["begin", "applied"]], JSON.stringify(done));
});

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

test("an envelope write whose digest was sent and not answered says what to do first and writes no file; one that never left, or never connected, throws the not-sent mark, and Valkey's own refusal is said as one (#961, #965, #987)", async () => {
  const files = allocationFiles("pd-961-envelope-");
  const before = readFileSync(files.envelope, "utf8");
  const common = { envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000, change: { totalUsd: "90" }, url: "redis://127.0.0.1:1", connectTimeoutMs: BOUND };
  const plan = planEnvelopeWrite(common);
  assert.equal(plan.invalid, undefined, JSON.stringify(plan.invalid));
  const made = [];
  const lost = await writeEnvelope({ ...common, redisFn: writeFake(made, { set: () => Promise.reject(lostAnswer()) }) });
  assert.deepEqual(lost, { invalid: envelopeDigestUnconfirmed("alloc:envelope:expected", plan.digest), partial: true });
  // The instruction first, and the whole sentence inside what an audit row keeps of a reason: it was cut before
  // "set it back by hand". Built with the real key and the real digest of this envelope.
  assert.match(plan.digest, /^[0-9a-f]{16}$/);
  assert.equal(lost.invalid, `If ${ALLOC_EXPECTED_KEY} holds ${plan.digest}, set it back by hand to the digest doctor prints (docs/allocation.md): Valkey did not confirm that write, and the envelope file was not written`);
  assert.ok([...lost.invalid].length <= CONSOLE_AUDIT_FIELD_MAX, `${[...lost.invalid].length} code points`);
  assert.doesNotMatch(lost.invalid, /envelope-mismatch|refuse/, "the hosts keep running with only the key moved, so no refusal is promised");
  assert.deepEqual(made[0], { failFast: true, lazyConnect: true, commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }, "the write's client has the command bound");
  assert.equal(readFileSync(files.envelope, "utf8"), before);
  // Never written (the bounded client marks what reached a socket, so no mark and no reply is a command that did not
  // leave): the key cannot hold the new digest, which the answer it had said it might. Thrown with the not-sent mark.
  const unsent = await writeEnvelope({ ...common, redisFn: writeFake([], { set: () => Promise.reject(Object.assign(new Error("Stream isn't writeable"), { code: "ENOTWRITABLE" })) }) }).then(() => "wrote", (error) => error);
  assert.deepEqual([unsent?.message, unsent?.valkeyNotSent, unsent?.valkeyMayStillRun, unsent?.code], ["Stream isn't writeable", true, undefined, "ENOTWRITABLE"]);
  assert.equal(readFileSync(files.envelope, "utf8"), before);
  // Valkey's own reply: it took the SET and refused it, so nothing was changed, and Valkey was reached.
  const refused = await writeEnvelope({ ...common, redisFn: writeFake([], { set: () => Promise.reject(refusal()) }) });
  assert.deepEqual(refused, { invalid: "Valkey refused the record of the new envelope's digest in alloc:envelope:expected (READONLY You can't write against a read only replica.), so the file was not written; nothing was changed" });
  assert.equal(readFileSync(files.envelope, "utf8"), before);
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

test("a priorities plan or a revert whose client never connects throws no mark within the bound; one stopped at a read says nothing was sent, and one whose write was lost throws its mark on (#961, #987)", async () => {
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
    // Stopped at its first read (every command of this client is lost, and the first one is the plan's GET): a read's
    // error carries the mark as a write's does, and nothing was changed by a read. It said may or may not.
    const lose = losingClient();
    const atRead = await write((_url) => Object.assign(Object.create(lose), { status: "wait", on() {}, connect: async () => {}, disconnect() {} })).then(() => "wrote", (error) => error);
    assert.deepEqual([atRead?.valkeyNotSent, atRead?.valkeyMayStillRun, atRead?.message, atRead?.code], [true, undefined, "Command timed out", "ETIMEDOUT"], `${name}: ${String(atRead?.message ?? atRead)}`);
    // A write that was sent and lost (the reads answer, the seed does not): the client's own error reaches the confirm,
    // which says may or may not.
    const atWrite = await write(writeFake([], { get: async () => null, eval: () => Promise.reject(lostAnswer()) })).then(() => "wrote", (error) => error);
    assert.equal(atWrite?.valkeyMayStillRun, true, `${name}: ${String(atWrite?.message ?? atWrite)}`);
    assert.equal(atWrite.valkeyNotSent, undefined, `${name}: a lost write was sent`);
  }
});

// ---- issue #987: a budget write says what it sent, and a lost one stays visible ----------------------------------------

/**
 * The allocation fake with every command that reaches it named in `sent`. `lose(name, nth)` loses that one's answer;
 * `refuse(name, nth)` rejects it as a client does a command it never wrote to a socket (no mark).
 */
function recordingAlloc() {
  const fake = fakeAllocRedis();
  const sent = [];
  const failing = [];
  const client = new Proxy(fake, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function" || ["on", "disconnect"].includes(name)) return value;
      return (...args) => {
        sent.push(name);
        const seen = sent.filter((n) => n === name).length;
        const hit = failing.find(([n, nth]) => n === name && nth === seen);
        if (hit) return Promise.reject(hit[2]());
        return value.apply(target, args);
      };
    },
  });
  return { fake, sent, client, lose: (name, nth = 1) => failing.push([name, nth, lostAnswer]), refuse: (name, nth = 1) => failing.push([name, nth, neverWritten]) };
}
/** What ioredis rejects a command with when its connection is gone and it has no offline queue: it never left. */
const neverWritten = () => new Error("Stream isn't writeable and enableOfflineQueue options is false");

const ALLOC_PROJECTS = [{ id: "shop", name: null, members: ["github:acme/web"] }, { id: "platform", name: null, members: ["github:acme/infra"] }];
const allocEnvelope = (over = {}) => parseEnvelope(JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 }, ...over }), "/e/envelope.json", { projects: ALLOC_PROJECTS, limits: [], maxCostMicros: 2_000_000 });
const memoryAudit = () => ({ rows: [], append(row) { this.rows.push(row); } });
const planText = (weights, basis = null, top = {}) => JSON.stringify({ version: 1, basis, projects: Object.entries(weights).map(([id, weight]) => ({ id, weight })), ...top });

test("the tracking write client: a read leaves wrote false, every other command sets it before it leaves, and the state's commands are the seven its comment names (#987)", async () => {
  // Each read alone, then each write alone, on a client of its own: the flag is up when the command reaches the client.
  for (const name of ["get", "exists", "lrange"]) {
    const t = writeTracking({ [name]: async () => t.wrote });
    assert.equal(await t.redis[name]("k"), false, `${name} is a read`);
    assert.equal(t.wrote, false);
  }
  for (const name of ["set", "eval", "lpush", "ltrim", "del", "hset", "GET2"]) {
    const t = writeTracking({ [name]: async () => t.wrote });
    assert.equal(await t.redis[name]("k"), true, `${name} counts as a write before it is sent: a command this list does not know is one`);
  }
  // The real allocation state through it, over every path the console runs: what it sends is those seven and no other.
  const envelope = allocEnvelope();
  const digest = envelopeDigest(envelope);
  const r = recordingAlloc();
  const t = writeTracking(r.client);
  const state = makeAllocationState({ redis: t.redis, host: "h1", audit: memoryAudit(), token: () => "t" });
  await state.reconcile({ envelope, digest, now: NOW });
  const applied = await state.applyPlan({ envelope, digest, projects: ALLOC_PROJECTS, text: planText({ shop: 3, platform: 1, _other: 0 }), writer: { kind: "operator-session" }, now: NOW });
  assert.equal(applied.outcome, "applied");
  assert.equal((await state.revert({ envelope, digest, target: { planId: null, weights: { shop: 1, platform: 1, _other: 0 } }, now: NOW + 60_000 })).outcome, "reverted");
  await state.fleetGoverned();
  await state.lastAttempt({ triggerId: "none" });
  r.fake.store.delete(ALLOC_EXPECTED_KEY);
  await state.reconcile({ envelope, digest, now: NOW + 120_000 });
  assert.deepEqual([...new Set(r.sent)].sort(), ["eval", "exists", "get", "lpush", "lrange", "ltrim", "set"]);
  assert.equal(t.wrote, true);
});

test("a priorities plan stopped at a read says nothing was sent, and after a lost answer nothing more is asked of Valkey: one bound, and an applied plan stays applied (#987)", async () => {
  const files = allocationFiles("pd-987-tracking-");
  const read = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const common = { url: "redis://127.0.0.1:1", envelope: read.envelope, digest: read.digest, projects: read.projects, host: "h1", logsDir: files.logs, now: new Date(NOW), connectTimeoutMs: BOUND };
  const plan = { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] };
  const over = (r) => () => Object.assign(r.client, { status: "ready" });
  const seeded = async () => {
    const r = recordingAlloc();
    await makeAllocationState({ redis: r.fake, host: "h1", audit: memoryAudit() }).reconcile({ envelope: read.envelope, digest: read.digest, now: NOW - 60_000 });
    return r;
  };
  const thrown = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
  // The plan's first GET: only a read was sent, so nothing was changed, and Valkey is what did not answer.
  const atRead = await seeded();
  atRead.lose("get", 1);
  const none = await thrown(applyPriorities({ ...common, plan, keepOther: true, redisFn: over(atRead) }));
  assert.deepEqual([none.error?.valkeyNotSent, none.error?.valkeyMayStillRun, none.error?.code], [true, undefined, "ETIMEDOUT"]);
  assert.deepEqual(atRead.sent, ["get"], "and nothing was asked after it");
  assert.deepEqual([atRead.fake.store.has(ALLOC_LOCK_KEY), atRead.fake.ops.length], [false, 1], "no lock, no write: only the seed made before");
  // Valkey's own reply to that read is an answer: thrown on as it is, never as Valkey unreachable.
  const replied = await seeded();
  replied.fake.get = () => Promise.reject(refusal());
  const answered = await thrown(applyPriorities({ ...common, plan, keepOther: true, redisFn: over(replied) }));
  assert.deepEqual([answered.error?.name, answered.error?.valkeyNotSent], ["ReplyError", undefined]);
  // An error that is not the client's (the audit file refuses a refusal's row) is no word about Valkey either.
  const denied = await seeded();
  const off = allocEnvelope({ delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } });
  denied.fake.store.set(ALLOC_PLAN_KEY, JSON.stringify({ ...JSON.parse(denied.fake.store.get(ALLOC_PLAN_KEY)), envelopeDigest: envelopeDigest(off) }));
  denied.fake.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(off));
  const fs = { mkdirSync() {}, appendFileSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  const file = await thrown(applyPriorities({ ...common, envelope: off, digest: envelopeDigest(off), plan, keepOther: true, redisFn: over(denied), fs }));
  assert.deepEqual([file.error?.code, file.error?.valkeyNotSent, denied.sent.every((name) => name === "get")], ["EACCES", undefined, true], String(file.error?.message ?? JSON.stringify(file.value)));
  // The lock's SET, sent and lost: a write, so the mark stays, and nothing follows it.
  const atLock = await seeded();
  atLock.lose("set", 1);
  const locked = await thrown(applyPriorities({ ...common, plan, keepOther: true, redisFn: over(atLock) }));
  assert.deepEqual([locked.error?.valkeyMayStillRun, locked.error?.valkeyNotSent, atLock.sent.at(-1)], [true, undefined, "set"]);
  // The compare-and-set, sent and lost: the lock's release in the state's `finally` is refused without reaching the
  // client, where it waited out a second bound on the Valkey that had just not answered.
  for (const [name, write] of [["a plan", (redisFn) => applyPriorities({ ...common, plan, keepOther: true, redisFn })], ["a revert", (redisFn) => revertAllocation({ ...common, target: { planId: null, weights: { shop: 1, platform: 1, _other: 0 } }, redisFn })]]) {
    const atCas = await seeded();
    atCas.lose("eval", 1);
    const lost = await thrown(write(over(atCas)));
    assert.deepEqual([lost.error?.valkeyMayStillRun, lost.error?.valkeyNotSent], [true, undefined], name);
    assert.deepEqual(atCas.sent.slice(-2), ["set", "eval"], `${name}: the lock, the lost compare-and-set, and no release after it`);
  }
  // An applied plan whose lock release was lost: the plan is applied, its answer says so, and the split read back for
  // the amounts is left out, since nothing more is asked of a Valkey that just did not answer.
  const atRelease = await seeded();
  atRelease.lose("eval", 2);
  const done = await thrown(applyPriorities({ ...common, plan, keepOther: true, redisFn: over(atRelease) }));
  assert.deepEqual([done.value?.outcome, done.value?.after, done.error], ["applied", null, undefined]);
  assert.equal(JSON.parse(atRelease.fake.store.get(ALLOC_PLAN_KEY)).planId, done.value.planId);
  assert.equal(atRelease.sent.at(-1), "eval", "the read back never reached the client");
});

test("the tracking write client stops asking Valkey only after a lost answer: Valkey's own error reply, and a command that never left, leave it open (#987)", async () => {
  const sent = [];
  const errors = { 0: refusal(), 1: neverWritten(), 2: lostAnswer() };
  const t = writeTracking({
    async get(key) {
      sent.push(`get ${key}`);
      return null;
    },
    eval(n) {
      sent.push(`eval ${n}`);
      return Object.hasOwn(errors, n) ? Promise.reject(errors[n]) : Promise.resolve(1);
    },
  });
  // Valkey answered, with an error: nothing was lost, so the next command is asked.
  await assert.rejects(t.redis.eval(0), (error) => error === errors[0]);
  assert.equal(await t.redis.get("a"), null);
  // Refused before it reached a socket: nothing was lost either.
  await assert.rejects(t.redis.eval(1), (error) => error === errors[1]);
  assert.equal(await t.redis.get("b"), null);
  // Sent, and its answer lost: every later command is refused with that same error and never reaches the client.
  await assert.rejects(t.redis.eval(2), (error) => error === errors[2]);
  await assert.rejects(t.redis.get("c"), (error) => error === errors[2]);
  await assert.rejects(t.redis.eval(3), (error) => error === errors[2]);
  assert.deepEqual(sent, ["eval 0", "get a", "eval 1", "get b", "eval 2"]);
});

test("a budget write refused before it left says nothing was changed only when no other write of the call had left: after a seed or a lock it says may or may not (#987)", async () => {
  const files = allocationFiles("pd-987-unsent-");
  const read = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const common = { url: "redis://127.0.0.1:1", envelope: read.envelope, digest: read.digest, projects: read.projects, host: "h1", logsDir: files.logs, now: new Date(NOW), connectTimeoutMs: BOUND };
  const plan = { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] };
  const over = (r) => () => Object.assign(r.client, { status: "ready" });
  const thrown = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
  const seeded = async () => {
    const r = recordingAlloc();
    await makeAllocationState({ redis: r.fake, host: "h1", audit: memoryAudit() }).reconcile({ envelope: read.envelope, digest: read.digest, now: NOW - 60_000 });
    return r;
  };
  const marks = (got) => [got.error?.valkeyNotSent, got.error?.valkeyMayStillRun, got.error?.message];
  const words = "Stream isn't writeable and enableOfflineQueue options is false";
  // The call's FIRST write, the lock, refused before it left (the connection died between the reads and it): nothing
  // of the call was written. It was thrown on with no mark, which the confirm answered as a write that threw.
  for (const [name, write] of [["a plan", (redisFn) => applyPriorities({ ...common, plan, keepOther: true, redisFn })], ["a revert", (redisFn) => revertAllocation({ ...common, target: { planId: null, weights: { shop: 1, platform: 1, _other: 0 } }, redisFn })]]) {
    const atLock = await seeded();
    const before = atLock.fake.ops.length;
    atLock.refuse("set", 1);
    assert.deepEqual(marks(await thrown(write(over(atLock)))), [true, undefined, words], name);
    assert.deepEqual([atLock.fake.store.has(ALLOC_LOCK_KEY), atLock.fake.ops.length], [false, before], `${name}: nothing was written`);
    // The compare-and-set refused that way AFTER the lock was answered: a write of this call landed, so "nothing was
    // changed" is not known to be true, and the confirm has to say may or may not.
    const atCas = await seeded();
    const applied = atCas.fake.store.get(ALLOC_PLAN_KEY);
    atCas.refuse("eval", 1);
    assert.deepEqual(marks(await thrown(write(over(atCas)))), [undefined, true, words], name);
    assert.equal(atCas.fake.store.get(ALLOC_PLAN_KEY), applied, `${name}: the split itself is as it was`);
    assert.ok(atCas.sent.indexOf("set") < atCas.sent.indexOf("eval"), `${name}: the lock had left`);
  }
  // A split that does not exist yet: the reconcile seeds it, and a read refused after that seed leaves the seed there.
  const fresh = recordingAlloc();
  fresh.refuse("get", 2);
  const afterSeed = await thrown(applyPriorities({ ...common, plan, keepOther: true, redisFn: over(fresh) }));
  assert.deepEqual(marks(afterSeed), [undefined, true, words]);
  assert.ok(fresh.fake.store.has(ALLOC_PLAN_KEY), "the seed landed, so something was changed");
  assert.deepEqual(fresh.sent.slice(0, 2), ["get", "eval"], "the plan's read, then the seed");
  // Valkey's own reply to a write is an answer, and is thrown on as it is.
  const replied = await seeded();
  replied.fake.set = () => Promise.reject(refusal());
  const answered = await thrown(applyPriorities({ ...common, plan, keepOther: true, redisFn: over(replied) }));
  assert.deepEqual([answered.error?.name, answered.error?.valkeyNotSent, answered.error?.valkeyMayStillRun], ["ReplyError", undefined, undefined]);
});

test("the split's reader asked to fail fast connects first on the budget writes' client: a refused connection answers at once, and the connect and the reads share the one bound (#987)", async () => {
  // As the `envelope-set` preview asks it. The plain client keeps an offline queue, and the reads waited there for the
  // whole bound on a Valkey that refused the connection.
  const made = [];
  const answering = writeFake(made, { get: async () => null, lrange: async () => [] });
  assert.deepEqual(await readAllocations({ url: "redis://127.0.0.1:1", redisFn: answering, limit: 1, failFast: true }), { state: null, expected: null, log: [] });
  assert.deepEqual(made[0], { failFast: true, lazyConnect: true, commandTimeoutMs: 5000, disconnectTimeoutMs: 0 });
  assert.equal(made.dropped, 1);
  // Every other caller keeps the client it had.
  const plain = [];
  await readAllocations({ url: "redis://127.0.0.1:1", redisFn: (_url, options) => (plain.push(options), { on() {}, get: async () => null, lrange: async () => [], disconnect() {} }), limit: 1 });
  assert.deepEqual(plain, [undefined]);
  // A connect that fails is the read's unreachable, with no read asked.
  let asked = 0;
  const refused = await timed(readAllocations({ url: "redis://127.0.0.1:1", redisFn: writeFake([], { connect: () => Promise.reject(new Error("Connection is closed.")), get: async () => ((asked += 1), null) }), limit: 1, failFast: true, timeoutMs: 2500 }));
  assert.deepEqual(refused.res, { unreachable: "Connection is closed." });
  assert.ok(refused.ms < 500, `${refused.ms} ms`);
  assert.equal(asked, 0);
  // One bound for the connect and the reads: a connect that never answers ends there, and so do reads that never
  // answer after a connect that used part of it.
  const stuck = await timed(readAllocations({ url: "redis://127.0.0.1:1", redisFn: writeFake([], { connect: neverAnswers }), limit: 1, failFast: true, timeoutMs: 200 }));
  assert.deepEqual(stuck.res, { unreachable: "Valkey did not connect within 0.2 seconds" });
  assert.ok(stuck.ms < 600, `${stuck.ms} ms`);
  const slow = await timed(readAllocations({ url: "redis://127.0.0.1:1", redisFn: writeFake([], { connect: () => sleep(250), get: neverAnswers, lrange: neverAnswers }), limit: 1, failFast: true, timeoutMs: 400 }));
  assert.deepEqual(slow.res, { unreachable: "timed out reaching the queue" });
  assert.ok(slow.ms >= 350 && slow.ms < 600, `${slow.ms} ms: the reads had what the connect left of 400, never 400 more`);
});

test("the envelope's stray digest: with only the key moved every host keeps running, and a file that has that digest re-bases the fleet with no confirm (#987)", async () => {
  // What the sentence must not promise, and what the notice does say, by the worker's own reconcile.
  const envelope = allocEnvelope();
  const digest = envelopeDigest(envelope);
  const next = allocEnvelope({ totalUsd: "90" });
  const fake = fakeAllocRedis();
  const state = makeAllocationState({ redis: fake, host: "h1", audit: memoryAudit() });
  await state.reconcile({ envelope, digest, now: NOW });
  // An envelope write's record landed and its file was never written.
  fake.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(next));
  const still = await state.reconcile({ envelope, digest, now: NOW + 1000 });
  assert.deepEqual([still.mismatch, still.state.envelopeDigest], [false, digest], "a host whose file is the split's does not go by the key");
  assert.deepEqual(expectedOther({ expected: envelopeDigest(next), fileDigest: digest, splitDigest: digest }), { expected: envelopeDigest(next).slice(0, 8), file: digest.slice(0, 8) });
  // A host that has a file with that digest: the fleet is re-based onto it, by a compare-and-set nobody confirmed.
  const moved = await makeAllocationState({ redis: fake, host: "h2", audit: memoryAudit() }).reconcile({ envelope: next, digest: envelopeDigest(next), now: NOW + 2000 });
  assert.deepEqual([moved.mismatch, moved.state.envelopeDigest, moved.state.writer], [false, envelopeDigest(next), "envelope-change"]);
  // The notice is said of that and of nothing else.
  assert.equal(expectedOtherText({ expected: "0123abcd", file: "89abcdef" }), "alloc:envelope:expected names envelope 0123abcd, not this host's (89abcdef): an envelope write that did not finish, or one made on another host. A file with that digest re-bases the fleet. If no write is under way, set the key back by hand (docs/allocation.md).");
  for (const [said, facts] of [
    ["the key holds this host's digest", { expected: digest, fileDigest: digest, splitDigest: digest }],
    ["no key", { expected: null, fileDigest: digest, splitDigest: digest }],
    ["no split yet: the next host to look seeds one and sets the key to its own digest", { expected: envelopeDigest(next), fileDigest: digest, splitDigest: undefined }],
    ["a split made for another envelope than this host's: the mismatch line is the true one", { expected: envelopeDigest(next), fileDigest: digest, splitDigest: envelopeDigest(next) }],
    ["no envelope digest", { expected: envelopeDigest(next), fileDigest: null, splitDigest: null }],
  ]) assert.equal(expectedOther(facts), null, said);
  assert.deepEqual(expectedOther({ expected: "not a digest", fileDigest: digest, splitDigest: digest }), { expected: "?", file: digest.slice(0, 8) });
});

test("the applied split has its row in the history after each of the five changes, and a row that never got there is said once the split is 15 seconds old (#987)", async () => {
  const envelope = allocEnvelope();
  const digest = envelopeDigest(envelope);
  const fake = fakeAllocRedis();
  const state = makeAllocationState({ redis: fake, host: "h1", audit: memoryAudit(), token: () => "t" });
  const DAY = 86_400_000;
  // The split and its history as the page reads them, a minute after the change.
  const read = async (at) => {
    const alloc = await readAllocations({ url: "redis://127.0.0.1:1", redisFn: () => fake, limit: 20 });
    return { alloc, behind: historyBehind(alloc.state, alloc.log, { limit: 20, nowMs: at + 60_000 }) };
  };
  const seen = [];
  const after = async (at, outcome, writer) => {
    const { alloc, behind } = await read(at);
    assert.equal(behind, null, `${outcome}: the split's row is there`);
    assert.deepEqual([alloc.log[0].outcome, alloc.log[0].at, alloc.log[0].writer], [outcome, alloc.state.appliedAt, alloc.state.writer], outcome);
    assert.equal(alloc.state.writer, writer, outcome);
    seen.push(outcome);
  };
  // The seed (neutral), a plan (applied), its expiry (expired), an operator's revert (reverted), a changed envelope
  // (rebased), and delegation turned off (neutral again): every writer keeps its row's `at` equal to the state's.
  await state.reconcile({ envelope, digest, now: NOW });
  await after(NOW, "neutral", "default");
  const p = await state.applyPlan({ envelope, digest, projects: ALLOC_PROJECTS, text: planText({ shop: 3, platform: 1, _other: 0 }, null, { validUntil: new Date(NOW + 2 * DAY).toISOString() }), writer: { kind: "operator-session" }, now: NOW + 1000 });
  assert.equal(p.outcome, "applied", JSON.stringify(p));
  await after(NOW + 1000, "applied", "operator-session");
  const target = JSON.parse(fake.lists.get(ALLOC_LOG_KEY)[0]);
  await state.reconcile({ envelope, digest, now: NOW + 3 * DAY });
  await after(NOW + 3 * DAY, "expired", "expiry");
  assert.equal((await state.revert({ envelope, digest, target, now: NOW + 4 * DAY })).outcome, "reverted");
  await after(NOW + 4 * DAY, "reverted", "operator-revert");
  const smaller = allocEnvelope({ totalUsd: "90" });
  fake.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(smaller));
  await state.reconcile({ envelope: smaller, digest: envelopeDigest(smaller), now: NOW + 5 * DAY });
  await after(NOW + 5 * DAY, "rebased", "envelope-change");
  const off = allocEnvelope({ totalUsd: "90", delegation: { enabled: false } });
  fake.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(off));
  await state.reconcile({ envelope: off, digest: envelopeDigest(off), now: NOW + 6 * DAY });
  await after(NOW + 6 * DAY, "rebased", "envelope-change");
  assert.deepEqual([...new Set(seen)].sort(), [...STATE_CHANGE_OUTCOMES].sort(), "each of the worker's five change outcomes was written here");

  // A change whose row never reached the history: the compare-and-set landed and the push after it did not.
  const { alloc } = await read(NOW + 6 * DAY);
  const st = alloc.state;
  const at = Date.parse(st.appliedAt);
  const older = alloc.log.slice(1);
  assert.deepEqual(historyBehind(st, older, { limit: 20, nowMs: at + HISTORY_SETTLE_MS }), { writer: "envelope-change", at: "01-21 08:00" });
  assert.equal(historyBehindText({ writer: "envelope-change", at: "01-21 08:00" }), "the applied split (written by envelope-change at 01-21 08:00) has no row in this history: a write whose answer was lost landed, or its row could not be pushed. The allocations file of the host that wrote it may hold the row.");
  // Not said of a split younger than that (the push follows the write by milliseconds), nor without a clock.
  assert.equal(historyBehind(st, older, { limit: 20, nowMs: at + HISTORY_SETTLE_MS - 1 }), null);
  assert.equal(historyBehind(st, older, { limit: 20 }), null);
  assert.equal(HISTORY_SETTLE_MS, 15_000);
  // Its row anywhere among those read is its row: two hosts that change the split in one moment can push in the other order.
  assert.equal(historyBehind(st, [older[0], alloc.log[0], ...older.slice(1)], { limit: 20, nowMs: at + 60_000 }), null);
  // No change row at all among those read says nothing unless the whole history was read.
  const refusals = Array.from({ length: 20 }, (_, i) => ({ at: new Date(at + i).toISOString(), writer: "operator-session", outcome: "refused", reason: "plan-too-soon" }));
  assert.equal(historyBehind(st, refusals, { limit: 20, nowMs: at + 60_000 }), null, "the split's row may lie further back than was read");
  assert.deepEqual(historyBehind(st, refusals.slice(0, 19), { limit: 20, nowMs: at + 60_000 }), { writer: "envelope-change", at: "01-21 08:00" }, "the whole history was read, and it holds no change");
  assert.deepEqual(historyBehind(st, [], { limit: 20, nowMs: at + 60_000 }), { writer: "envelope-change", at: "01-21 08:00" });
  // A row with the right instant by another writer, or the right writer at another instant, is not the split's.
  assert.notEqual(historyBehind(st, [{ ...alloc.log[0], writer: "expiry" }], { limit: 20, nowMs: at + 60_000 }), null);
  assert.notEqual(historyBehind(st, [{ ...alloc.log[0], at: new Date(at + 1).toISOString() }], { limit: 20, nowMs: at + 60_000 }), null);
  // No split, or one with no instant, has nothing to be behind.
  assert.equal(historyBehind(null, older, { limit: 20, nowMs: at + 60_000 }), null);
  assert.equal(historyBehind({ ...st, appliedAt: "soon" }, older, { limit: 20, nowMs: at + 60_000 }), null);
});

test("two plans racing on one basis: the loser's rows are no change of the split, and the winner's split has its row in the history whichever was pushed last (#987)", async () => {
  const envelope = allocEnvelope();
  const digest = envelopeDigest(envelope);
  const fake = fakeAllocRedis();
  // One audit for both hosts, in the order the rows were written: what a host's allocations file holds.
  const file = memoryAudit();
  const winning = makeAllocationState({ redis: fake, host: "h1", audit: file, token: () => "a" });
  // The losing host reads the split before the winner's write and takes the lock after the winner released it: its
  // lock waits at a gate, and says when it got there.
  let open;
  let arrived;
  const gate = new Promise((resolve) => (open = resolve));
  const atLock = new Promise((resolve) => (arrived = resolve));
  const held = new Proxy(fake, { get: (target, name) => (name === "set" ? async (...args) => (arrived(), await gate, target.set(...args)) : typeof target[name] === "function" ? target[name].bind(target) : target[name]) });
  const losing = makeAllocationState({ redis: held, host: "h2", audit: file, token: () => "b" });
  await winning.reconcile({ envelope, digest, now: NOW });
  // The same writer at the same instant: nothing but the plan tells the two attempts' rows apart.
  const attempt = (state, weights) => state.applyPlan({ envelope, digest, projects: ALLOC_PROJECTS, text: planText(weights), writer: { kind: "operator-session" }, now: NOW + 1000 });
  const second = attempt(losing, { shop: 1, platform: 3, _other: 0 });
  await atLock;
  const won = await attempt(winning, { shop: 3, platform: 1, _other: 0 });
  open();
  const lost = await second;
  assert.deepEqual([won.outcome, lost.outcome, lost.reason], ["applied", "apply-failed", "plan-stale"]);
  // The file holds the documented shape of a write that did not happen: the loser's `applied` row, written before its
  // compare-and-set, newer than the winner's and followed by its `apply-failed`.
  assert.deepEqual(file.rows.map((row) => [row.outcome, row.planId]), [["neutral", null], ["applied", won.planId], ["applied", lost.planId], ["apply-failed", lost.planId]]);
  // The history the notice reads is `alloc:log`, which never held the loser's `applied` row.
  const alloc = await readAllocations({ url: "redis://127.0.0.1:1", redisFn: () => fake, limit: 20 });
  assert.deepEqual(alloc.log.map((row) => [row.outcome, row.planId]), [["apply-failed", lost.planId], ["applied", won.planId], ["neutral", null]]);
  assert.equal(alloc.state.planId, won.planId);
  assert.equal(historyBehind(alloc.state, alloc.log, { limit: 20, nowMs: NOW + 61_000 }), null, "the winner's split has its row, under the loser's newer one");
  // The loser's row is not taken for the split's: with the winner's own row gone, the split is behind its history.
  assert.deepEqual(historyBehind(alloc.state, alloc.log.filter((row) => row.outcome !== "applied"), { limit: 20, nowMs: NOW + 61_000 }), { writer: "operator-session", at: "01-15 08:00" });
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
