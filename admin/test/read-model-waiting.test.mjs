import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createFleetReader, readWaiting, readWaitingRow, RUN_ID_RE, WAITING_DISCOVERY_TTL_MS, WAITING_DUE_GRACE_MS, WAITING_PER_LIST_MAX, WAITING_QUEUES_MAX, WAITING_STATES, WAITING_TTL_MS } from "../src/read-model.mjs";
import { stateOf } from "../src/console/live.mjs";
import { DEFER_BUCKETS, DEFER_ID_RE, DEFER_TIME_MAX_MS, deferHsetArgs, deferKey } from "@edgehero/pi-dispatch/defer-reasons";

/**
 * Issue #737: the waiting jobs and why each waits, read from the worker's own records and BullMQ's ids and scores alone.
 * The property that matters most is what is NOT read: a waiting forge job's `data` holds the issue's title and body, so
 * the fake below records every command, and the job hashes carry a secret in every field the reader must never ask for.
 * The score decoding against a real Valkey is read-model-waiting.valkey.test.mjs's.
 */

const AT = Date.parse("2026-10-14T12:00:00.000Z");
const SECRET = "SECRET ISSUE BODY";

/**
 * An in-memory Valkey of zsets, lists, hashes and sets, every command logged; `pipeline()` logs each exec. `hexists`
 * adds that command, which a client without it (the default here) lacks.
 */
function fakeValkey({ hexists = false } = {}) {
  const zsets = new Map();
  const lists = new Map();
  const hashes = new Map();
  const sets = new Map();
  const log = [];
  const execs = [];
  const run = {
    zrange(key, start, stop, withScores) {
      const z = [...(zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
      const slice = z.slice(start, stop + 1);
      return withScores === "WITHSCORES" ? slice.flatMap(([m, s]) => [m, String(s)]) : slice.map(([m]) => m);
    },
    lrange(key, start, stop) {
      const l = lists.get(key) ?? [];
      const n = l.length;
      const a = start < 0 ? Math.max(0, n + start) : start;
      const b = stop < 0 ? n + stop : Math.min(stop, n - 1);
      return l.slice(a, b + 1);
    },
    hget(key, field) {
      const h = hashes.get(key);
      return h && Object.hasOwn(h, field) ? h[field] : null;
    },
    hmget(key, ...fields) {
      const h = hashes.get(key);
      return fields.map((f) => (h && Object.hasOwn(h, f) ? h[f] : null));
    },
    hgetall(key) {
      return { ...(hashes.get(key) ?? {}) };
    },
    smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    zscore(key, member) {
      const hit = (zsets.get(key) ?? []).find(([m]) => m === member);
      return hit ? String(hit[1]) : null;
    },
  };
  if (hexists) {
    run.hexists = (key, field) => {
      const h = hashes.get(key);
      return h && Object.hasOwn(h, field) ? 1 : 0;
    };
  }
  const redis = {
    log,
    execs,
    direct: 0,
    pipeline() {
      const queued = [];
      const p = {};
      for (const cmd of Object.keys(run)) {
        p[cmd] = (...args) => {
          queued.push([cmd, args]);
          return p;
        };
      }
      p.exec = async () => {
        execs.push(queued.length);
        return queued.map(([cmd, args]) => {
          log.push([cmd, ...args]);
          try {
            return [null, run[cmd](...args)];
          } catch (err) {
            return [err, null];
          }
        });
      };
      return p;
    },
  };
  for (const cmd of Object.keys(run)) {
    redis[cmd] = async (...args) => {
      redis.direct += 1;
      log.push([cmd, ...args]);
      return run[cmd](...args);
    };
  }
  return {
    redis,
    zadd: (key, member, score) => zsets.set(key, [...(zsets.get(key) ?? []).filter(([m]) => m !== member), [member, score]]),
    lpush: (key, ...ids) => lists.set(key, [...ids.reverse(), ...(lists.get(key) ?? [])]),
    hset: (key, obj) => hashes.set(key, { ...(hashes.get(key) ?? {}), ...obj }),
    sadd: (key, ...ids) => sets.set(key, new Set([...(sets.get(key) ?? []), ...ids])),
  };
}

/** A queue as the reader takes one: a name and BullMQ's key function. Any job read through it is recorded. */
function fakeQueue(name, asked = []) {
  return {
    name,
    toKey: (type) => `bull:${name}:${type}`,
    async getJob(id) {
      asked.push(["getJob", id]);
      return null;
    },
    async getJobs(...args) {
      asked.push(["getJobs", ...args]);
      return [];
    },
  };
}

/** A job's hash as BullMQ writes one, with a secret in every field the reader must never read. */
function jobHash(fields = {}) {
  return { name: "github", data: JSON.stringify({ title: SECRET, body: SECRET }), opts: JSON.stringify({ attempts: 3, note: SECRET }), stacktrace: `["${SECRET}"]`, returnvalue: SECRET, timestamp: String(AT - 60_000), atm: "0", ...fields };
}

/** Put a job in a state: its hash, and its id in the delayed set (by due), the prioritized set, or a list. */
function addJob(v, queue, jobId, { state = "delayed", dueAt = AT + 60_000, fields = {}, record = null } = {}) {
  v.hset(`bull:${queue}:${jobId}`, jobHash(fields));
  if (state === "delayed") v.zadd(`bull:${queue}:delayed`, jobId, dueAt * 4096 + 1);
  else if (state === "prioritized") v.zadd(`bull:${queue}:prioritized`, jobId, 1);
  else v.lpush(`bull:${queue}:${state === "waiting" ? "wait" : "paused"}`, jobId);
  if (record) {
    // The worker hands BullMQ the record's own `until`, so a current record's `until` is the job's due instant.
    const args = deferHsetArgs({ until: dueAt, ...record });
    const h = {};
    for (let i = 0; i < args.length; i += 2) h[args[i]] = args[i + 1];
    v.hset(deferKey(jobId), h);
  }
}

const rec = (why, extra = {}) => ({ why, at: AT - 1000, project: null, host: "build3", n: "0123456789abcdef", ...extra });

test("readWaiting reads no job's data: every command is a pipelined id, score, short field or the worker's own hash", async () => {
  const v = fakeValkey();
  const asked = [];
  addJob(v, "pi-jobs", "gh-1", { record: rec("host-slot") });
  addJob(v, "pi-jobs", "gh-2", { state: "waiting", fields: { deid: "acme/web#2:triage" } });
  addJob(v, "pi-jobs", "gh-3", { state: "prioritized" });
  addJob(v, "pi-jobs@mini1", "gh-4", { state: "paused" });
  v.hset("wait:job:gh-1", { since: String(AT - 5000), label: "jira", target: SECRET });
  v.sadd("wait:held", "gh-1");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs", asked), fakeQueue("pi-jobs@mini1", asked)], now: () => AT });
  assert.equal(got.rows.length, 4);
  const banned = new Set(["data", "opts", "stacktrace", "returnvalue"]);
  for (const [cmd, key, ...rest] of v.redis.log) {
    assert.ok(!["scan", "keys", "get"].includes(cmd), `no ${cmd}`);
    if (cmd === "hgetall") assert.ok(!String(key).startsWith("bull:"), `no HGETALL of a job hash: ${key}`);
    if (cmd === "hget" || cmd === "hmget") for (const f of rest) assert.ok(!banned.has(f), `${cmd} ${key} asks for ${f}`);
  }
  assert.deepEqual(asked, [], "no getJob or getJobs: each hydrates the data");
  assert.equal(v.redis.direct, 0, "every command went through a pipeline");
  assert.ok(v.redis.execs.length <= 3, `three rounds at most (${v.redis.execs.length})`);
  assert.ok(!JSON.stringify(got).includes("SECRET"), "nothing secret in the result");
  // The rounds asked exactly the bounded reads the docblock names: one past the bound marks truncation.
  const first = v.redis.log.filter(([cmd]) => cmd === "zrange" || cmd === "lrange");
  assert.deepEqual(first.slice(0, 4), [
    ["zrange", "bull:pi-jobs:delayed", 0, WAITING_PER_LIST_MAX, "WITHSCORES"],
    ["zrange", "bull:pi-jobs:prioritized", 0, WAITING_PER_LIST_MAX],
    ["lrange", "bull:pi-jobs:wait", -(WAITING_PER_LIST_MAX + 1), -1],
    ["lrange", "bull:pi-jobs:paused", -(WAITING_PER_LIST_MAX + 1), -1],
  ]);
  assert.deepEqual(Object.keys(got.rows[0]), ["jobId", "queue", "state", "bucket", "why", "known", "dueAt", "queuedAt", "recordedAt", "untilAt", "project", "projectFrom", "host", "holder", "endpoint", "budgetWhy", "trigger", "attempt", "attempts", "attemptsMade", "stalled", "kind", "recovery", "schedulerNext", "held"], "the row is a closed set of keys");
  assert.deepEqual(Object.keys(got).sort(), ["at", "byBucket", "byQueue", "queuesCut", "rows", "scheduled", "truncated"]);
  assert.deepEqual([...WAITING_STATES], ["delayed", "waiting", "prioritized", "paused"]);
});

test("readWaiting: each bucket from the worker's record, a hold with no record, no record at all, the lists, and a reason this console does not know", async () => {
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-slot", { dueAt: AT + 1000, record: rec("host-slot") });
  addJob(v, "pi-jobs", "gh-run", { dueAt: AT + 2000, record: rec("chained", { holder: "gh-parent" }) });
  addJob(v, "pi-jobs", "gh-check", { dueAt: AT + 3000, record: rec("wait-hold") });
  addJob(v, "pi-jobs", "gh-retry", { dueAt: AT + 4000, fields: { atm: "1" }, record: rec("retry", { attempt: 2, attempts: 3 }) });
  addJob(v, "pi-jobs", "gh-pause", { dueAt: AT + 5000, record: rec("pause-window") });
  addJob(v, "pi-jobs", "gh-ready", { dueAt: AT + 6000, record: rec("podman-restart") });
  addJob(v, "pi-jobs", "gh-held", { dueAt: AT + 7000 });
  addJob(v, "pi-jobs", "gh-none", { dueAt: AT + 8000 });
  addJob(v, "pi-jobs", "gh-new", { dueAt: AT + 9000 });
  v.hset(deferKey("gh-new"), { why: "newer-reason", at: String(AT), until: String(AT + 9000) });
  addJob(v, "pi-jobs", "gh-wait", { state: "waiting" });
  addJob(v, "pi-jobs", "gh-prio", { state: "prioritized" });
  addJob(v, "pi-jobs", "gh-paused", { state: "paused" });
  v.hset("wait:job:gh-held", { since: String(AT - 10_000), label: "jira + after 2026-10-15T09:00:00Z", checks: "3", after: String(AT + 3_600_000), "a:jira": `hold:${AT - 60_000}` });
  // A member whose hash is gone is no hold (and is not pruned: this reader writes nothing).
  v.sadd("wait:held", "gh-held", "gh-none");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  const by = Object.fromEntries(got.rows.map((r) => [r.jobId, r]));
  assert.deepEqual(
    Object.fromEntries(got.rows.map((r) => [r.jobId, [r.bucket, r.why, r.known]])),
    {
      "gh-slot": ["slot", "host-slot", true],
      "gh-run": ["run", "chained", true],
      "gh-check": ["check", "wait-hold", true],
      "gh-retry": ["retry", "retry", true],
      "gh-pause": ["pause", "pause-window", true],
      "gh-ready": ["ready", "podman-restart", true],
      "gh-held": ["check", null, false],
      "gh-none": ["none", null, false],
      // A reason a newer worker recorded and this console has no words for: its own bucket, never "no reason recorded".
      "gh-new": ["unknown", "newer-reason", false],
      "gh-wait": ["slot", null, false],
      "gh-prio": ["slot", null, false],
      "gh-paused": ["paused", null, false],
    },
  );
  assert.equal(by["gh-run"].holder, "gh-parent");
  assert.deepEqual([by["gh-retry"].attempt, by["gh-retry"].attempts, by["gh-retry"].attemptsMade], [2, 3, 1]);
  assert.deepEqual([by["gh-slot"].host, by["gh-slot"].untilAt, by["gh-slot"].recordedAt, by["gh-slot"].dueAt], ["build3", AT + 1000, AT - 1000, AT + 1000]);
  assert.deepEqual(by["gh-held"].held, { since: AT - 10_000, label: "jira + after 2026-10-15T09:00:00Z", checks: 3, after: AT + 3_600_000, answers: [{ profile: "jira", answer: "hold", at: AT - 60_000 }] });
  assert.equal(by["gh-none"].held, null, "a stale member is no hold");
  assert.equal(by["gh-wait"].dueAt, null, "only a delayed job has a due instant");
  assert.equal(v.redis.log.filter(([cmd]) => cmd === "srem").length, 0);
  const counts = Object.fromEntries(DEFER_BUCKETS.map((b) => [b, got.rows.filter((r) => r.bucket === b).length]));
  assert.deepEqual(got.byBucket, counts);
  assert.deepEqual(got.byBucket, { slot: 3, run: 1, check: 2, retry: 1, pause: 1, ready: 1, paused: 1, due: 0, unknown: 1, none: 1 }, "the unknown reason is counted apart from none");
  assert.deepEqual(got.byQueue, [{ queue: "pi-jobs", inLine: 12, scheduled: 0, truncated: false }]);
});

test("readWaiting: a scheduler's next run is scheduled, not in line; a repeat: job a gate deferred after the next was minted is in line, waiting since its slot", async () => {
  const v = fakeValkey();
  const next = AT + 3_600_000;
  const slot = AT - 600_000;
  v.zadd("bull:pi-jobs:repeat", "nightly", next);
  addJob(v, "pi-jobs", `repeat:nightly:${next}`, { dueAt: next, fields: { name: "local", rjk: "nightly", timestamp: String(AT - 3_000_000) } });
  addJob(v, "pi-jobs", `repeat:nightly:${slot}`, { dueAt: AT + 30_000, fields: { name: "local", rjk: "nightly", timestamp: String(slot - 3_600_000) }, record: rec("host-slot") });
  // The scheduler's next run that its slot reached while no worker was free: in the wait list, and BullMQ's next still.
  v.zadd("bull:pi-jobs:repeat", "hourly", AT - 1000);
  addJob(v, "pi-jobs", `repeat:hourly:${AT - 1000}`, { state: "waiting", fields: { name: "local", rjk: "hourly", timestamp: String(AT - 3_601_000) } });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.scheduled, [{ jobId: `repeat:nightly:${next}`, queue: "pi-jobs", schedulerId: "nightly", dueAt: next }]);
  const deferred = got.rows.find((r) => r.jobId === `repeat:nightly:${slot}`);
  assert.equal(deferred.bucket, "slot");
  assert.equal(deferred.schedulerNext, false);
  assert.equal(deferred.queuedAt, slot, "queued since its slot, not since the run before minted it");
  const due = got.rows.find((r) => r.jobId === `repeat:hourly:${AT - 1000}`);
  assert.equal(due.schedulerNext, true, "in line, and still the one BullMQ refuses to remove");
  assert.deepEqual(got.byQueue, [{ queue: "pi-jobs", inLine: 2, scheduled: 1, truncated: false }]);
  assert.equal(got.byBucket.slot, 2, "the scheduled run is not counted in line");
});

test("readWaiting: a paused queue's lists and its prioritized set wait on the pause; a running queue's prioritized jobs wait for a slot", async () => {
  const v = fakeValkey();
  addJob(v, "pi-jobs@mini1", "gh-p1", { state: "paused" });
  addJob(v, "pi-jobs@mini1", "gh-p2", { state: "prioritized" });
  v.hset("bull:pi-jobs@mini1:meta", { paused: "1" });
  addJob(v, "pi-jobs", "gh-r1", { state: "prioritized" });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs"), fakeQueue("pi-jobs@mini1")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => [r.jobId, r.state, r.bucket]).sort(), [["gh-p1", "paused", "paused"], ["gh-p2", "prioritized", "paused"], ["gh-r1", "prioritized", "slot"]]);
});

test("readWaiting: the project from the record, a forge job's dedup id, a cron trigger's folder, or not known", async () => {
  const v = fakeValkey();
  const projects = [{ id: "shop", members: ["github:acme/web"] }, { id: "ops", members: ["/srv/ops"] }];
  const triggers = [{ type: "cron", id: "nightly", folder: "/srv/ops" }, { type: "label", id: null }];
  addJob(v, "pi-jobs", "gh-rec", { record: rec("host-slot", { project: "billing" }), fields: { deid: "acme/web#1:triage" } });
  addJob(v, "pi-jobs", "gh-deid", { state: "waiting", fields: { deid: "acme/web#12:triage" } });
  addJob(v, "pi-jobs", "gh-other-forge", { state: "waiting", fields: { name: "gitlab", deid: "acme/web!3:triage" } });
  addJob(v, "pi-jobs", "manual:nightly:1760443200000", { state: "waiting", fields: { name: "local" } });
  addJob(v, "pi-jobs", "local-ab12", { state: "waiting", fields: { name: "local" } });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT, projects, triggers: { triggers } });
  const by = Object.fromEntries(got.rows.map((r) => [r.jobId, [r.project, r.projectFrom]]));
  assert.deepEqual(by, {
    "gh-rec": ["billing", "record"],
    "gh-deid": ["shop", "deid"],
    "gh-other-forge": [null, null],
    "manual:nightly:1760443200000": ["ops", "trigger"],
    "local-ab12": [null, null],
  });
  const none = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(none.rows.map((r) => r.projectFrom).sort(), ["record", null, null, null, null].sort(), "without the projects, only the record names one");
});

test("readWaiting: a record whose span disagrees with the job's due instant is an earlier episode's, read as no reason recorded", async () => {
  const v = fakeValkey();
  const due = AT + 60_000;
  // A deferral: BullMQ was handed the record's own `until`.
  addJob(v, "pi-jobs", "gh-exact", { dueAt: due, record: rec("host-slot", { until: due }) });
  // A retry: BullMQ's own clock, a little after the record's `until`.
  addJob(v, "pi-jobs", "gh-retry", { dueAt: due, record: rec("retry", { until: due - 2_000, attempt: 2, attempts: 3 }) });
  // A past instant the move clamped to its own clock: the due is just after the record was written.
  addJob(v, "pi-jobs", "gh-clamped", { dueAt: AT + 1_500, record: rec("pause-window", { at: AT, until: AT - 30_000 }) });
  // An earlier episode's record, still alive inside its slack, beside a due that is not its own: either way out.
  addJob(v, "pi-jobs", "gh-stale-early", { dueAt: due, record: rec("host-slot", { until: due - 5_001 }) });
  addJob(v, "pi-jobs", "gh-stale-late", { dueAt: due, record: rec("chained", { at: due - 70_000, until: due - 60_000, holder: "gh-parent" }) });
  addJob(v, "pi-jobs", "gh-stale-ahead", { dueAt: due, record: rec("host-slot", { at: AT, until: due + 5_001 }) });
  // A stale record on a held job: the hold still says why.
  addJob(v, "pi-jobs", "gh-stale-held", { dueAt: due, record: rec("host-slot", { until: due - 600_000, at: due - 660_000 }) });
  v.hset("wait:job:gh-stale-held", { since: String(AT - 1000) });
  v.sadd("wait:held", "gh-stale-held");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  const by = Object.fromEntries(got.rows.map((r) => [r.jobId, [r.bucket, r.why, r.untilAt, r.holder]]));
  assert.deepEqual(by, {
    "gh-exact": ["slot", "host-slot", due, null],
    "gh-retry": ["retry", "retry", due - 2_000, null],
    "gh-clamped": ["pause", "pause-window", AT - 30_000, null],
    "gh-stale-early": ["none", null, null, null],
    "gh-stale-late": ["none", null, null, null],
    "gh-stale-ahead": ["none", null, null, null],
    "gh-stale-held": ["check", null, null, null],
  });
});

test("readWaiting: hostile values in the record, the job hash, the hold and the lists are dropped, never shown", async () => {
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-bad", { dueAt: AT + 1, fields: { name: "<script>", atm: "x", stc: "-1", timestamp: "1e12" } });
  v.hset(deferKey("gh-bad"), { why: "host-slot", at: "12abc", until: String(AT + 1), project: "Shop!", host: "<b>bad</b>", holder: "a b", endpoint: "UPPER", budgetWhy: "Not A Token", trigger: "10000", attempt: "0", attempts: "1001" });
  addJob(v, "pi-jobs", "gh-badwhy", {});
  v.hset(deferKey("gh-badwhy"), { why: "Host Slot\u001b[2J", until: String(AT) });
  v.hset("wait:job:gh-bad", { since: String(AT - 1), label: `jira\u0007`, checks: "many", after: "soon", "a:jira": `go:${AT}`, "a:bad field": `go:${AT}`, "a:x": "maybe:1", "a:y": "hold:abc", "a:z": `fault:${AT - 5}`, "a:a1": `refuse:${AT}`, "a:b2": `unclear:${AT}`, "a:c3": `go:${AT}` });
  v.sadd("wait:held", "gh-bad");
  v.zadd("bull:pi-jobs:delayed", "bad id with spaces", AT * 4096);
  v.lpush("bull:pi-jobs:wait", "x".repeat(201));
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => r.jobId).sort(), ["gh-bad", "gh-badwhy"], "an id outside the job-id charset is no row");
  assert.equal(got.truncated, true, "and the read that met one is a floor");
  const bad = got.rows.find((r) => r.jobId === "gh-bad");
  assert.deepEqual(
    [bad.kind, bad.attemptsMade, bad.stalled, bad.queuedAt, bad.recordedAt, bad.untilAt, bad.project, bad.host, bad.holder, bad.endpoint, bad.budgetWhy, bad.trigger, bad.attempt, bad.attempts],
    [null, null, null, null, null, AT + 1, null, null, null, null, null, null, null, null],
  );
  assert.equal(bad.bucket, "slot", "the reason itself was good");
  assert.deepEqual(bad.held, {
    since: AT - 1,
    label: null,
    checks: 0,
    after: null,
    // At most four, sorted by profile, each with an answer the worker writes and a decimal instant.
    answers: [{ profile: "a1", answer: "refuse", at: AT }, { profile: "b2", answer: "unclear", at: AT }, { profile: "c3", answer: "go", at: AT }, { profile: "jira", answer: "go", at: AT }],
  });
  const badwhy = got.rows.find((r) => r.jobId === "gh-badwhy");
  assert.deepEqual([badwhy.why, badwhy.known, badwhy.bucket], [null, false, "none"], "a reason outside the charset is none at all");
  assert.ok(RUN_ID_RE.source === DEFER_ID_RE.source, "the leaf's id rule is the reader's");
});

test("readWaiting: each list is read to its bound, one more marks the queue truncated, and the rows kept are the soonest due and the oldest", async () => {
  const v = fakeValkey();
  for (let i = 0; i <= WAITING_PER_LIST_MAX; i += 1) {
    addJob(v, "pi-jobs", `gh-d${i}`, { dueAt: AT + i * 1000, fields: { timestamp: String(AT - 10_000_000 + i) } });
    // Pushed oldest first, as BullMQ adds them: the oldest ends at the list's right.
    addJob(v, "pi-jobs", `gh-w${i}`, { state: "waiting", fields: { timestamp: String(AT - 5_000_000 + i) } });
  }
  addJob(v, "pi-jobs@mini1", "gh-small", { state: "waiting" });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs"), fakeQueue("pi-jobs@mini1")], now: () => AT });
  const ids = new Set(got.rows.map((r) => r.jobId));
  assert.equal(got.rows.filter((r) => r.queue === "pi-jobs").length, 2 * WAITING_PER_LIST_MAX);
  assert.ok(ids.has("gh-d0") && !ids.has(`gh-d${WAITING_PER_LIST_MAX}`), "the delayed set keeps its soonest due");
  assert.ok(ids.has("gh-w0") && !ids.has(`gh-w${WAITING_PER_LIST_MAX}`), "the wait list keeps its oldest");
  assert.equal(got.truncated, true);
  assert.deepEqual(got.byQueue.map((q) => [q.queue, q.truncated]), [["pi-jobs", true], ["pi-jobs@mini1", false]]);
  assert.equal(got.rows[0].jobId, "gh-d0", "oldest queued first");
  const exact = fakeValkey();
  for (let i = 0; i < WAITING_PER_LIST_MAX; i += 1) addJob(exact, "pi-jobs", `gh-e${i}`, { state: "prioritized" });
  const full = await readWaiting(exact.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.equal(full.rows.length, WAITING_PER_LIST_MAX);
  assert.equal(full.truncated, false, "exactly the bound is whole");
});

test("readWaiting: a member that is no run id is no row, and makes its queue's read a floor, never a whole count that misses it", async () => {
  // A cron trigger's run id is repeat:<id>:<ms>, so a legal 190-character id mints a 211-character one; anything with the
  // Valkey's URL can push a member of its own. Each of the four lists, one queue each, beside a queue read whole.
  const v = fakeValkey();
  const queues = ["pi-jobs", "pi-jobs@a", "pi-jobs@b", "pi-jobs@c", "pi-jobs@whole"];
  for (const q of queues) addJob(v, q, `gh-ok-${q.length}`, { state: "waiting" });
  v.zadd("bull:pi-jobs:delayed", `repeat:report-${"m".repeat(176)}-weekly:1791460800000`, (AT - 60_000) * 4096);
  v.zadd("bull:pi-jobs@a:prioritized", "bad key!", 1);
  v.lpush("bull:pi-jobs@b:wait", "x".repeat(3000));
  v.lpush("bull:pi-jobs@c:paused", "<b>x</b>");
  const got = await readWaiting(v.redis, { queues: queues.map((q) => fakeQueue(q)), now: () => AT });
  assert.equal(got.rows.length, queues.length, "only the run ids are rows");
  assert.deepEqual(got.byQueue.map((q) => [q.queue, q.truncated]), [["pi-jobs", true], ["pi-jobs@a", true], ["pi-jobs@b", true], ["pi-jobs@c", true], ["pi-jobs@whole", false]]);
  assert.equal(got.truncated, true);
  assert.equal(got.queuesCut, 0, "no queue was cut: the floor is the refused members'");
  const whole = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs@whole")], now: () => AT });
  assert.equal(whole.truncated, false, "a queue whose every member is a run id is read whole");
});

test("readWaiting never throws: an exec that fails or hangs is unreachable, a client without a pipeline is asked direct, no queues read nothing", async () => {
  const failing = { pipeline: () => ({ zrange() {}, lrange() {}, hget() {}, smembers() {}, async exec() { throw new Error("ECONNREFUSED"); } }) };
  assert.deepEqual(await readWaiting(failing, { queues: [fakeQueue("pi-jobs")], now: () => AT }), { unreachable: true });
  const hung = { pipeline: () => ({ zrange() {}, lrange() {}, hget() {}, smembers() {}, exec: () => new Promise(() => {}) }) };
  // The bound's timer is unref'd (a reader's socket keeps a real process alive); here nothing else would, so hold it.
  const alive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await readWaiting(hung, { queues: [fakeQueue("pi-jobs")], now: () => AT, timeoutMs: 20 }), { unreachable: true });
  } finally {
    clearInterval(alive);
  }
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-1", { record: rec("host-slot") });
  const direct = { ...v.redis, pipeline: undefined };
  const got = await readWaiting(direct, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => [r.jobId, r.bucket]), [["gh-1", "slot"]]);
  const empty = await readWaiting(v.redis, { queues: null, now: () => AT });
  assert.deepEqual(empty, { at: AT, rows: [], scheduled: [], byBucket: Object.fromEntries(DEFER_BUCKETS.map((b) => [b, 0])), byQueue: [], truncated: false, queuesCut: 0 });
});

test("readWaitingRow: one job's row by readWaiting's rules, its hold read whatever wait:held says; a scheduler's next and a gone job say so", async () => {
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-1", { dueAt: AT + 5000, record: rec("endpoint", { endpoint: "gpu-a" }) });
  v.hset("wait:job:gh-1", { since: String(AT - 1000), label: "jira" });
  const q = fakeQueue("pi-jobs");
  const { row } = await readWaitingRow(v.redis, { q, jobId: "gh-1", state: "delayed", now: () => AT });
  assert.deepEqual([row.bucket, row.why, row.endpoint, row.dueAt, row.held?.label], ["slot", "endpoint", "gpu-a", AT + 5000, "jira"]);
  const all = await readWaiting(v.redis, { queues: [q], now: () => AT });
  assert.equal(all.rows[0].held, null, "the fleet read asks only wait:held's members");
  v.zadd("bull:pi-jobs:repeat", "nightly", AT + 9000);
  addJob(v, "pi-jobs", `repeat:nightly:${AT + 9000}`, { dueAt: AT + 9000, fields: { rjk: "nightly" } });
  assert.deepEqual(await readWaitingRow(v.redis, { q, jobId: `repeat:nightly:${AT + 9000}`, state: "delayed", now: () => AT }), { scheduled: { jobId: `repeat:nightly:${AT + 9000}`, queue: "pi-jobs", schedulerId: "nightly", dueAt: AT + 9000 } });
  assert.deepEqual(await readWaitingRow(v.redis, { q, jobId: "gh-gone", state: "waiting" }), { gone: true });
  assert.deepEqual(await readWaitingRow(v.redis, { q, jobId: "gh-1", state: "active" }), { gone: true }, "a job that is not waiting has no waiting row");
});

test("readWaiting: a delayed job past its due by more than the grace is due, whatever its record says; at the grace it is not", async () => {
  const v = fakeValkey();
  const edge = AT - WAITING_DUE_GRACE_MS;
  // At the grace exactly: still its record's reason (a free worker takes a due job within about a second).
  addJob(v, "pi-jobs", "gh-edge", { dueAt: edge, record: rec("host-slot", { at: edge - 1000 }) });
  // One millisecond past it: due, its record and its hold notwithstanding.
  addJob(v, "pi-jobs", "gh-late", { dueAt: edge - 1, record: rec("host-slot", { at: edge - 2000 }) });
  addJob(v, "pi-jobs", "gh-late-held", { dueAt: edge - 60_000 });
  v.hset("wait:job:gh-late-held", { since: String(AT - 600_000), label: "jira" });
  v.sadd("wait:held", "gh-late-held");
  addJob(v, "pi-jobs", "gh-late-none", { dueAt: AT - 3_600_000 });
  // A scheduler's next run whose fire time passed with no worker taking it is in line too, never "scheduled".
  const slot = AT - 120_000;
  v.zadd("bull:pi-jobs:repeat", "nightly", slot);
  addJob(v, "pi-jobs", `repeat:nightly:${slot}`, { dueAt: slot, fields: { name: "local", rjk: "nightly", timestamp: String(slot - 3_600_000) } });
  // In the future, or in a list: never due.
  addJob(v, "pi-jobs", "gh-soon", { dueAt: AT + 1000, record: rec("host-slot") });
  addJob(v, "pi-jobs", "gh-wait", { state: "waiting", fields: { timestamp: String(AT - 3_600_000) } });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  const by = Object.fromEntries(got.rows.map((r) => [r.jobId, [r.bucket, r.why]]));
  assert.deepEqual(by, {
    "gh-edge": ["slot", "host-slot"],
    "gh-late": ["due", "host-slot"],
    "gh-late-held": ["due", null],
    "gh-late-none": ["due", null],
    [`repeat:nightly:${slot}`]: ["due", null],
    "gh-soon": ["slot", "host-slot"],
    "gh-wait": ["slot", null],
  });
  assert.equal(got.rows.find((r) => r.jobId === `repeat:nightly:${slot}`).schedulerNext, true, "still the run BullMQ refuses to remove");
  assert.deepEqual(got.scheduled, []);
  assert.equal(got.byBucket.due, 4);
  assert.equal(WAITING_DUE_GRACE_MS, 10_000);
  // The one row's read judges by the clock it is given.
  const q = fakeQueue("pi-jobs");
  assert.equal((await readWaitingRow(v.redis, { q, jobId: "gh-late", state: "delayed", now: () => AT })).row.bucket, "due");
  assert.equal((await readWaitingRow(v.redis, { q, jobId: "gh-late", state: "delayed", now: () => edge - 1 })).row.bucket, "slot");
});

test("readWaiting: a queue's paused field is BullMQ's presence test, so 0 and the empty string are paused too", async () => {
  for (const [flag, want] of [["1", "paused"], ["0", "paused"], ["", "paused"], [null, "slot"]]) {
    const v = fakeValkey();
    addJob(v, "pi-jobs", "gh-1", { state: "waiting" });
    addJob(v, "pi-jobs", "gh-2", { state: "prioritized" });
    if (flag !== null) v.hset("bull:pi-jobs:meta", { paused: flag });
    const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
    assert.deepEqual(got.rows.map((r) => r.bucket), [want, want], JSON.stringify(flag));
    // The one row's read for the cancel's preview says the same: a waiting job in a paused queue waits on the pause.
    assert.equal((await readWaitingRow(v.redis, { q: fakeQueue("pi-jobs"), jobId: "gh-1", state: "waiting", now: () => AT })).row.bucket, want, JSON.stringify(flag));
  }
});

test("readWaiting: a record whose reason fails the charset is no record, so a held job with one waits on its check", async () => {
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-held-bad", { dueAt: AT + 60_000 });
  v.hset(deferKey("gh-held-bad"), { why: "Host Slot", at: String(AT), until: String(AT + 60_000), host: "build3" });
  v.hset("wait:job:gh-held-bad", { since: String(AT - 1000), label: "jira" });
  v.sadd("wait:held", "gh-held-bad");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => [r.bucket, r.why, r.known, r.host, r.untilAt]), [["check", null, false, null, null]], "nothing of that hash is read as the worker's");
});

test("readWaiting: a job in a list keeps no reason a record still holds, and its record is not even asked for", async () => {
  const v = fakeValkey();
  // A record left from the deferral before the job was promoted: the job waits for a slot now, not for that.
  addJob(v, "pi-jobs", "gh-promoted", { state: "waiting", record: rec("pause-window") });
  addJob(v, "pi-jobs", "gh-prio", { state: "prioritized", record: rec("chained", { holder: "gh-parent" }) });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => [r.jobId, r.bucket, r.why, r.untilAt, r.holder]).sort(), [["gh-prio", "slot", null, null, null], ["gh-promoted", "slot", null, null, null]]);
  assert.deepEqual(v.redis.log.filter(([cmd, key]) => cmd === "hmget" && String(key).startsWith("defer:")), [], "no defer HMGET for a job not in the delayed set");
});

test("readWaiting: rows oldest queued first and scheduled runs soonest due first, whatever order the lists hold them in", async () => {
  const v = fakeValkey();
  // The delayed set is ordered by due, the opposite of the queued order here.
  addJob(v, "pi-jobs", "gh-a", { dueAt: AT + 1000, fields: { timestamp: String(AT - 1000) }, record: rec("host-slot") });
  addJob(v, "pi-jobs", "gh-b", { dueAt: AT + 2000, fields: { timestamp: String(AT - 3000) }, record: rec("host-slot") });
  addJob(v, "pi-jobs", "gh-c", { dueAt: AT + 3000, fields: { timestamp: String(AT - 2000) }, record: rec("host-slot") });
  // Two schedulers whose next runs sit in the delayed set in an order their ids would not sort them in.
  v.zadd("bull:pi-jobs:repeat", "zeta", AT + 10_000);
  v.zadd("bull:pi-jobs:repeat", "alpha", AT + 20_000);
  addJob(v, "pi-jobs", `repeat:alpha:${AT + 20_000}`, { dueAt: AT + 20_000, fields: { rjk: "alpha" } });
  addJob(v, "pi-jobs", `repeat:zeta:${AT + 10_000}`, { dueAt: AT + 10_000, fields: { rjk: "zeta" } });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => r.jobId), ["gh-b", "gh-c", "gh-a"]);
  assert.deepEqual(got.scheduled.map((x) => x.schedulerId), ["zeta", "alpha"]);
  // Equal due instants order by id, so two reads agree.
  const tie = fakeValkey();
  tie.zadd("bull:pi-jobs:repeat", "b", AT + 5000);
  tie.zadd("bull:pi-jobs:repeat", "a", AT + 5000);
  addJob(tie, "pi-jobs", `repeat:b:${AT + 5000}`, { dueAt: AT + 5000, fields: { rjk: "b" } });
  addJob(tie, "pi-jobs", `repeat:a:${AT + 5000}`, { dueAt: AT + 5000, fields: { rjk: "a" } });
  tie.zadd("bull:pi-jobs:delayed", `repeat:b:${AT + 5000}`, (AT + 5000) * 4096);
  tie.zadd("bull:pi-jobs:delayed", `repeat:a:${AT + 5000}`, (AT + 5000) * 4096 + 7);
  assert.deepEqual((await readWaiting(tie.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT })).scheduled.map((x) => x.jobId), [`repeat:a:${AT + 5000}`, `repeat:b:${AT + 5000}`]);
});

test("readWaiting: the row's own facts, each by its rule: a recovery's id, BullMQ's older attempts field, a record with no until, one id in two lists", async () => {
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-run.r1", { state: "waiting" });
  addJob(v, "pi-jobs", "gh-plain", { state: "waiting" });
  // An older BullMQ wrote `attemptsMade`, which its own reader takes before `atm`.
  addJob(v, "pi-jobs", "gh-legacy", { state: "waiting", fields: { attemptsMade: "2", atm: "0" } });
  addJob(v, "pi-jobs", "gh-legacy-atm", { state: "waiting", fields: { atm: "3" } });
  // A record whose until fails its rule has nothing to judge the due by, so it stands.
  addJob(v, "pi-jobs", "gh-no-until", { dueAt: AT + 60_000 });
  v.hset(deferKey("gh-no-until"), { why: "chained", at: String(AT - 1000), until: "soon", holder: "gh-parent" });
  // A job seen in two lists as it moved between them while they were read is one row.
  addJob(v, "pi-jobs", "gh-moving", { dueAt: AT + 5000 });
  v.lpush("bull:pi-jobs:wait", "gh-moving");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  const by = Object.fromEntries(got.rows.map((r) => [r.jobId, r]));
  assert.deepEqual([by["gh-run.r1"].recovery, by["gh-plain"].recovery], [true, false]);
  assert.deepEqual([by["gh-legacy"].attemptsMade, by["gh-legacy-atm"].attemptsMade], [2, 3]);
  assert.deepEqual([by["gh-no-until"].bucket, by["gh-no-until"].why, by["gh-no-until"].holder, by["gh-no-until"].untilAt], ["run", "chained", "gh-parent", null]);
  assert.equal(got.rows.filter((r) => r.jobId === "gh-moving").length, 1);
  assert.equal(by["gh-moving"].state, "delayed", "the first list read is the one it is shown in");
});

test("readWaiting: hostile ids with a job hash, hostile hold counters, a field that only looks like an answer, and a bound above the most are judged", async () => {
  const v = fakeValkey();
  // An id outside the job-id charset is no row, even with a hash under it.
  addJob(v, "pi-jobs", "<b>x</b>", { state: "waiting" });
  addJob(v, "pi-jobs", "gh-ok", { state: "waiting" });
  // Counters a decimal rule refuses and `Number` would take.
  addJob(v, "pi-jobs", "gh-held", { dueAt: AT + 60_000 });
  v.hset("wait:job:gh-held", { since: String(AT - 1000), checks: "1e3", after: "0x10", "a:jira": `hold:${AT}`, note: `go:${AT}` });
  v.sadd("wait:held", "gh-held");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  assert.deepEqual(got.rows.map((r) => r.jobId).sort(), ["gh-held", "gh-ok"]);
  const held = got.rows.find((r) => r.jobId === "gh-held").held;
  assert.deepEqual([held.checks, held.after], [0, null]);
  assert.deepEqual(held.answers, [{ profile: "jira", answer: "hold", at: AT }], "only an a: field is a profile's answer");
  for (const [checks, after] of [["16", "1e12"], [" 3", "12abc"]]) {
    v.hset("wait:job:gh-held", { checks, after });
    const again = (await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT })).rows.find((r) => r.jobId === "gh-held").held;
    assert.deepEqual([again.checks, again.after], [checks === "16" ? 16 : 0, null], `${checks} ${after}`);
  }
  // A bound above the most is the most, never a longer read.
  const big = fakeValkey();
  await readWaiting(big.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT, perList: WAITING_PER_LIST_MAX * 5 });
  assert.deepEqual(big.redis.log.find(([cmd]) => cmd === "zrange"), ["zrange", "bull:pi-jobs:delayed", 0, WAITING_PER_LIST_MAX, "WITHSCORES"]);
  const small = fakeValkey();
  await readWaiting(small.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT, perList: 3 });
  assert.deepEqual(small.redis.log.find(([cmd]) => cmd === "zrange"), ["zrange", "bull:pi-jobs:delayed", 0, 3, "WITHSCORES"]);
});

test("readWaiting: a cron trigger's folder names the project, never another trigger type's that shares its id", async () => {
  const v = fakeValkey();
  const projects = [{ id: "shop", members: ["/srv/shop"] }, { id: "ops", members: ["/srv/ops"] }];
  const triggers = [{ type: "label", id: "nightly", folder: "/srv/shop" }, { type: "cron", id: "nightly", folder: "/srv/ops" }];
  addJob(v, "pi-jobs", "manual:nightly:1760443200000", { state: "waiting", fields: { name: "local" } });
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT, projects, triggers });
  assert.deepEqual(got.rows.map((r) => [r.project, r.projectFrom]), [["ops", "trigger"]]);
});

test("readWaiting and readWaitingRow say unreachable as a boolean: a client's words, markup and all, never reach the answer", async () => {
  const words = 'connect ECONNREFUSED 10.9.8.7:6379 <img src=x onerror="alert(1)">';
  const failing = { pipeline: () => ({ zrange() {}, lrange() {}, hget() {}, hmget() {}, hgetall() {}, zscore() {}, smembers() {}, async exec() { throw new Error(words); } }) };
  assert.deepEqual(await readWaiting(failing, { queues: [fakeQueue("pi-jobs")], now: () => AT }), { unreachable: true });
  assert.deepEqual(await readWaitingRow(failing, { q: fakeQueue("pi-jobs"), jobId: "gh-1", state: "delayed", now: () => AT }), { unreachable: true });
});

// --- the fleet reader's `waiting` -------------------------------------------------------------------------------------

/** A queue that answers every other read of the snapshot with nothing. */
const quietQueue = (_c, opts) => {
  const name = opts?.name ?? "pi-jobs";
  return {
    name,
    toKey: (type) => `bull:${name}:${type}`,
    async isPaused() { return false; },
    async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
    async getWorkers() { return []; },
    async getJobSchedulers() { return []; },
    async getActive() { return []; },
    async getFailed() { return []; },
    async close() {},
  };
};

/** The fake Valkey above with what the rest of the snapshot reads, all answering nothing. */
function snapshotValkey(v) {
  return Object.assign(v.redis, {
    on() {},
    async get() { return null; },
    async mget(...keys) { return keys.map(() => null); },
    async zrevrangebyscore() { return []; },
    async exists() { return 0; },
    disconnect() {},
  });
}

const readerOf = (logsDir, redis, { now, hosts = [] } = {}) =>
  createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    { makeQueueFn: quietQueue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => [], nowFn: now },
  );

/** What the overview's load asks the snapshot for (`pages.mjs` `PAGE_READS`): the waiting jobs too. */
const ASK = Object.freeze({ waiting: true });

test("snapshot({ waiting: true }): the waiting jobs once per 5 s for the same queues, on the reader's clock; a call that does not ask reads none", async () => {
  const logsDir = tempDir("pd-737-waiting-cache-");
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-1", { record: rec("host-slot") });
  const redis = snapshotValkey(v);
  let t = AT;
  const reader = readerOf(logsDir, redis, { now: () => t });
  const reads = () => v.redis.log.filter(([cmd, key]) => cmd === "zrange" && key === "bull:pi-jobs:delayed").length;
  const first = await reader.snapshot(ASK);
  assert.deepEqual(first.waiting.rows.map((r) => r.jobId), ["gh-1"]);
  assert.equal(reads(), 1);
  t += WAITING_TTL_MS - 1;
  assert.equal((await reader.snapshot(ASK)).waiting, first.waiting, "inside the window: the same read");
  assert.equal(reads(), 1);
  t += 1;
  await reader.snapshot(ASK);
  assert.equal(reads(), 2, "the window passed: read again");
  // A different set of queues is a different read, inside the window.
  const fleet = readerOf(logsDir, redis, { now: () => t, hosts: [{ name: "mini1", routes: "true" }] });
  const both = await fleet.snapshot(ASK);
  assert.deepEqual(both.waiting.byQueue.map((q) => q.queue), ["pi-jobs", "pi-jobs@mini1"]);
  // A call that does not ask (every screen but the overview, /api/state, the TUI) has no waiting field and pays no read
  // for one, on the same reader, inside the window and past it; asking with anything but true is not asking.
  const ranges = () => v.redis.log.filter(([cmd]) => cmd === "zrange" || cmd === "lrange").length;
  const before = ranges();
  for (const opts of [undefined, null, {}, { waiting: false }, { waiting: "true" }, { waiting: 1 }]) {
    assert.equal(Object.hasOwn(await fleet.snapshot(opts), "waiting"), false, `asked ${JSON.stringify(opts)}: no waiting field`);
  }
  assert.equal(ranges(), before, "and no read for them");
  assert.equal((await fleet.snapshot(ASK)).waiting, both.waiting, "a call that asks inside the window still shares the one read");
  t += WAITING_TTL_MS;
  assert.equal(Object.hasOwn(await fleet.snapshot(), "waiting"), false);
  assert.equal(ranges(), before, "past the window a call that does not ask reads none either");
});

test("snapshot({ waiting: true }): an unreachable read is kept for the window like a good one, so a Valkey that times out is not sent the whole pipeline on every snapshot", async () => {
  const logsDir = tempDir("pd-737-waiting-down-");
  const v = fakeValkey();
  const redis = snapshotValkey(v);
  let down = true;
  let sent = 0;
  const real = redis.pipeline;
  redis.pipeline = () => {
    const p = real();
    const exec = p.exec;
    p.exec = async () => {
      sent += 1;
      if (down) throw new Error("ECONNREFUSED");
      return exec();
    };
    return p;
  };
  let t = AT;
  const reader = readerOf(logsDir, redis, { now: () => t });
  assert.deepEqual((await reader.snapshot(ASK)).waiting, { unreachable: true });
  assert.equal(sent, 1);
  down = false;
  addJob(v, "pi-jobs", "gh-1", { state: "waiting" });
  t += WAITING_TTL_MS - 1;
  assert.deepEqual((await reader.snapshot(ASK)).waiting, { unreachable: true }, "inside the window: the same answer");
  assert.equal(sent, 1, "and no pipeline sent for it");
  t += 1;
  assert.deepEqual((await reader.snapshot(ASK)).waiting.rows.map((r) => r.jobId), ["gh-1"], "the window passed: asked again");
  assert.equal(sent, 3, "the queues' round and the jobs' round");
});

test("snapshot({ waiting: true }): a client error, markup and all, is unreachable: true in the snapshot and its words are nowhere in it", async () => {
  const logsDir = tempDir("pd-737-waiting-words-");
  const v = fakeValkey();
  const redis = snapshotValkey(v);
  const words = 'ECONNREFUSED 10.9.8.7:6379 <script>alert("x")</script>';
  const real = redis.pipeline;
  redis.pipeline = () => {
    const p = real();
    p.exec = async () => {
      throw new Error(words);
    };
    return p;
  };
  const snap = await readerOf(logsDir, redis, { now: () => AT }).snapshot(ASK);
  assert.deepEqual(snap.waiting, { unreachable: true });
  const text = JSON.stringify(snap);
  for (const part of ["10.9.8.7", "<script>", "ECONNREFUSED"]) assert.ok(!text.includes(part), `${part} is not in the snapshot`);
});

test("snapshot({ waiting: true }): a queue no registry row names is read too, by the keyspace discovery, kept for a minute", async () => {
  const logsDir = tempDir("pd-737-waiting-stopped-");
  const v = fakeValkey();
  // A host that stopped: no registry row, and its queue still holds a job.
  addJob(v, "pi-jobs@stopped", "gh-left", { state: "waiting" });
  addJob(v, "pi-jobs", "gh-shared", { state: "waiting" });
  const redis = snapshotValkey(v);
  let t = AT;
  const scans = [];
  let answer = { names: ["pi-jobs@stopped"], incomplete: null };
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    {
      makeQueueFn: quietQueue,
      parseConnectionFn: () => ({}),
      redisFn: () => redis,
      readLiveHostsFn: async () => ({ hosts: [] }),
      discoverHostQueuesFn: async (_r, opts) => (scans.push(opts), typeof answer === "function" ? answer() : answer),
      nowFn: () => t,
    },
  );
  const first = await reader.snapshot(ASK);
  assert.deepEqual(first.waiting.rows.map((r) => [r.jobId, r.queue]).sort(), [["gh-left", "pi-jobs@stopped"], ["gh-shared", "pi-jobs"]]);
  assert.deepEqual(first.waiting.byQueue.map((q) => q.queue), ["pi-jobs", "pi-jobs@stopped"]);
  assert.deepEqual(first.queueCounts.map((c) => c.queue), ["pi-jobs"], "the per-tick reads stay the registry's");
  assert.equal(scans.length, 1);
  // Inside the minute the discovery is not asked again, though the waiting read is.
  t += WAITING_TTL_MS;
  await reader.snapshot(ASK);
  t += WAITING_DISCOVERY_TTL_MS - WAITING_TTL_MS - 1;
  await reader.snapshot(ASK);
  assert.equal(scans.length, 1, "one keyspace scan per minute, never one per tick");
  assert.equal(WAITING_DISCOVERY_TTL_MS, 60_000);
  // Past it, asked again: the snapshot that starts the scan is handed the last set, the next one the scan's. A scan
  // that did not finish adds what it read and drops nothing it found before.
  const queuesOf = async () => (await reader.snapshot(ASK)).waiting.byQueue.map((q) => q.queue);
  t += 1;
  answer = { names: ["pi-jobs@other"], incomplete: "the queue scan ran out of time" };
  assert.deepEqual(await queuesOf(), ["pi-jobs", "pi-jobs@stopped"], "the last set while the scan runs");
  assert.equal(scans.length, 2);
  assert.deepEqual(await queuesOf(), ["pi-jobs", "pi-jobs@other", "pi-jobs@stopped"]);
  assert.equal(scans.length, 2, "and that scan's set is kept for the minute");
  t += WAITING_DISCOVERY_TTL_MS;
  answer = () => {
    throw new Error("down");
  };
  await queuesOf();
  assert.deepEqual(await queuesOf(), ["pi-jobs", "pi-jobs@other", "pi-jobs@stopped"], "a scan that failed keeps the last set");
  // A whole scan is the set: a queue it no longer finds is not read.
  t += WAITING_DISCOVERY_TTL_MS;
  answer = ["pi-jobs@stopped"];
  await queuesOf();
  assert.deepEqual(await queuesOf(), ["pi-jobs", "pi-jobs@stopped"]);
  assert.equal(scans.length, 4);
});

test("snapshot({ waiting: true }): the cached read is the same queues' only, on a clock that moves forward", async () => {
  const logsDir = tempDir("pd-737-waiting-key-");
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-1", { state: "waiting" });
  const redis = snapshotValkey(v);
  let t = AT;
  let hosts = [];
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    { makeQueueFn: quietQueue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => [], nowFn: () => t },
  );
  const reads = () => v.redis.log.filter(([cmd, key]) => cmd === "zrange" && key === "bull:pi-jobs:delayed").length;
  await reader.snapshot(ASK);
  assert.equal(reads(), 1);
  // A host joined inside the window: another set of queues, read now, in the same reader.
  hosts = [{ name: "mini1", routes: "true" }];
  t += 1;
  const joined = await reader.snapshot(ASK);
  assert.equal(reads(), 2);
  assert.deepEqual(joined.waiting.byQueue.map((q) => q.queue), ["pi-jobs", "pi-jobs@mini1"]);
  // A clock that went back is no proof the read is fresh: read again.
  t -= 2;
  await reader.snapshot(ASK);
  assert.equal(reads(), 3);
});

test("readWaiting reads at most WAITING_QUEUES_MAX queues, the first it is given, counts the rest, and calls its rows a floor", async () => {
  const v = fakeValkey();
  const names = Array.from({ length: WAITING_QUEUES_MAX + 6 }, (_, i) => `pi-jobs@h${String(i).padStart(3, "0")}`);
  for (const name of names) addJob(v, name, `gh-${name.slice(8)}`, { state: "waiting" });
  const got = await readWaiting(v.redis, { queues: names.map((n) => fakeQueue(n)), now: () => AT });
  assert.equal(WAITING_QUEUES_MAX, 64);
  assert.deepEqual(got.byQueue.map((q) => q.queue), names.slice(0, WAITING_QUEUES_MAX));
  assert.deepEqual([got.queuesCut, got.truncated, got.rows.length], [6, true, WAITING_QUEUES_MAX]);
  assert.equal(new Set(v.redis.log.filter(([cmd]) => cmd === "zrange" || cmd === "lrange").map(([, key]) => key.split(":")[1])).size, WAITING_QUEUES_MAX, "a queue past the bound is asked nothing");
  // Exactly the bound is whole.
  const exact = await readWaiting(v.redis, { queues: names.slice(0, WAITING_QUEUES_MAX).map((n) => fakeQueue(n)), now: () => AT });
  assert.deepEqual([exact.queuesCut, exact.truncated], [0, false]);
});

test("snapshot({ waiting: true }): the registry's queues first, then the discovered ones in name order, so a live host's queue is never the one cut", async () => {
  const logsDir = tempDir("pd-737-waiting-many-");
  const v = fakeValkey();
  addJob(v, "pi-jobs@zz", "gh-live", { state: "waiting" });
  const found = Array.from({ length: WAITING_QUEUES_MAX + 4 }, (_, i) => `pi-jobs@a${String(i).padStart(3, "0")}`);
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    { makeQueueFn: quietQueue, parseConnectionFn: () => ({}), redisFn: () => snapshotValkey(v), readLiveHostsFn: async () => ({ hosts: [{ name: "zz", routes: "true" }] }), discoverHostQueuesFn: async () => ["pi-jobs@zz", ...[...found].reverse()], nowFn: () => AT },
  );
  const { waiting } = await reader.snapshot(ASK);
  assert.deepEqual(waiting.byQueue.map((q) => q.queue), ["pi-jobs", "pi-jobs@zz", ...found.slice(0, WAITING_QUEUES_MAX - 2)]);
  assert.deepEqual(waiting.rows.map((r) => r.jobId), ["gh-live"], "the live host's job is read");
  assert.deepEqual([waiting.queuesCut, waiting.truncated], [6, true]);
  await reader.dispose();
});

test("snapshot({ waiting: true }): a snapshot that has a set of queues never waits for the keyspace scan; it is handed the last set while the next one runs", async () => {
  const logsDir = tempDir("pd-737-waiting-slow-scan-");
  const v = fakeValkey();
  addJob(v, "pi-jobs@a", "gh-a", { state: "waiting" });
  addJob(v, "pi-jobs@b", "gh-b", { state: "waiting" });
  let t = AT;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const scans = [];
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    {
      makeQueueFn: quietQueue,
      parseConnectionFn: () => ({}),
      redisFn: () => snapshotValkey(v),
      readLiveHostsFn: async () => ({ hosts: [] }),
      // The first scan answers at once; the next takes longer than any bound, until the test lets it go.
      discoverHostQueuesFn: async () => (scans.push(t), scans.length === 1 ? ["pi-jobs@a"] : (await gate, ["pi-jobs@a", "pi-jobs@b"])),
      nowFn: () => t,
    },
  );
  const queuesOf = (snap) => snap.waiting.byQueue.map((q) => q.queue);
  assert.deepEqual(queuesOf(await reader.snapshot(ASK)), ["pi-jobs", "pi-jobs@a"], "the first read waits for its set");
  t += WAITING_DISCOVERY_TTL_MS;
  const alive = setInterval(() => {}, 1000);
  let timer;
  try {
    const snap = await Promise.race([reader.snapshot(ASK), new Promise((resolve) => (timer = setTimeout(() => resolve("hung"), 2_000)))]);
    assert.notEqual(snap, "hung", "the scan in flight held the snapshot");
    assert.deepEqual(queuesOf(snap), ["pi-jobs", "pi-jobs@a"], "the last set");
    assert.equal(scans.length, 2, "while the next scan runs");
    t += WAITING_TTL_MS;
    assert.deepEqual(queuesOf(await reader.snapshot(ASK)), ["pi-jobs", "pi-jobs@a"]);
    assert.equal(scans.length, 2, "one scan at a time");
  } finally {
    clearTimeout(timer);
    clearInterval(alive);
  }
  release();
  await gate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queuesOf(await reader.snapshot(ASK)), ["pi-jobs", "pi-jobs@a", "pi-jobs@b"], "the scan's set once it settles");
  await reader.dispose();
});

test("snapshot({ waiting: true }): a clock that went back asks the keyspace again, and two snapshots in the same instant share one scan", async () => {
  const logsDir = tempDir("pd-737-waiting-scan-clock-");
  const v = fakeValkey();
  let t = AT;
  const scans = [];
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    { makeQueueFn: quietQueue, parseConnectionFn: () => ({}), redisFn: () => snapshotValkey(v), readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => (scans.push(t), await new Promise((resolve) => setTimeout(resolve, 30)), []), nowFn: () => t },
  );
  await Promise.all([reader.snapshot(ASK), reader.snapshot(ASK)]);
  assert.equal(scans.length, 1, "the second snapshot shared the first one's scan");
  t -= 60 * 60 * 1000;
  await reader.snapshot(ASK);
  assert.equal(scans.length, 2, "a step back an hour is not an hour of a fresh set");
  await reader.dispose();
});

test("readWaiting and readWaitingRow ask a queue's paused flag by its presence (HEXISTS) where the client has it, never its value", async () => {
  const big = "x".repeat(1_000_000);
  for (const [flag, want] of [["1", "paused"], ["0", "paused"], ["", "paused"], [big, "paused"], [null, "slot"]]) {
    const v = fakeValkey({ hexists: true });
    addJob(v, "pi-jobs", "gh-1", { state: "waiting" });
    if (flag !== null) v.hset("bull:pi-jobs:meta", { paused: flag });
    const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
    const row = await readWaitingRow(v.redis, { q: fakeQueue("pi-jobs"), jobId: "gh-1", state: "waiting", now: () => AT });
    const label = flag === big ? "a megabyte" : JSON.stringify(flag);
    assert.deepEqual([got.rows[0].bucket, row.row.bucket], [want, want], label);
    const meta = v.redis.log.filter(([, key]) => key === "bull:pi-jobs:meta");
    assert.deepEqual(meta, [["hexists", "bull:pi-jobs:meta", "paused"], ["hexists", "bull:pi-jobs:meta", "paused"]], label);
  }
});

test("readWaiting: every instant it hands on is one a page can draw, at most DEFER_TIME_MAX_MS: an enqueue instant, a slot, a hold's clock, its after and an answer's instant", async () => {
  const v = fakeValkey();
  const past = String(DEFER_TIME_MAX_MS + 1);
  addJob(v, "pi-jobs", "gh-edge", { state: "waiting", fields: { timestamp: String(DEFER_TIME_MAX_MS) } });
  addJob(v, "pi-jobs", "gh-past", { state: "waiting", fields: { timestamp: past } });
  // A deferred `repeat:` run whose slot is past the last drawable instant: queued since its hash's instant, not the slot.
  addJob(v, "pi-jobs", `repeat:nightly:${past}`, { dueAt: AT + 60_000, fields: { name: "local", rjk: "nightly", timestamp: String(AT - 1000) } });
  addJob(v, "pi-jobs", "gh-held", { dueAt: AT + 60_000 });
  v.hset("wait:job:gh-held", { since: past, after: past, label: "jira", "a:jira": `hold:${past}`, "a:ci": `go:${DEFER_TIME_MAX_MS}` });
  v.sadd("wait:held", "gh-held");
  const got = await readWaiting(v.redis, { queues: [fakeQueue("pi-jobs")], now: () => AT });
  const by = Object.fromEntries(got.rows.map((r) => [r.jobId, r]));
  assert.deepEqual([by["gh-edge"].queuedAt, by["gh-past"].queuedAt, by[`repeat:nightly:${past}`].queuedAt], [DEFER_TIME_MAX_MS, null, AT - 1000]);
  assert.deepEqual([by["gh-held"].held.since, by["gh-held"].held.after, by["gh-held"].held.answers], [null, null, [{ profile: "ci", answer: "go", at: DEFER_TIME_MAX_MS }]]);
});

test("/api/state is unchanged by the waiting jobs: the state document names none of them", async () => {
  const logsDir = tempDir("pd-737-waiting-state-");
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-waiting-secret-id", { record: rec("host-slot", { project: "shop" }) });
  const withWaiting = await readerOf(logsDir, snapshotValkey(v), { now: () => AT }).snapshot(ASK);
  assert.equal(withWaiting.waiting.rows.length, 1);
  const without = { ...withWaiting };
  delete without.waiting;
  for (const role of ["operator", "viewer"]) {
    const doc = stateOf(withWaiting, role, { now: AT });
    assert.deepEqual(doc, stateOf(without, role, { now: AT }), `${role}: byte for byte the document without them`);
    assert.equal(Object.hasOwn(doc, "waiting"), false);
    assert.ok(!JSON.stringify(doc).includes("gh-waiting-secret-id"));
  }
});

test("overview, Fleet and host share a cached waiting read; parked and config read no waiting jobs", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const logsDir = tempDir("pd-737-waiting-pages-");
  const v = fakeValkey();
  addJob(v, "pi-jobs", "gh-1", { state: "waiting" });
  let t = AT;
  // One reader for every screen, as serve holds it.
  const deps = { fleet: readerOf(logsDir, snapshotValkey(v), { now: () => t }), now: () => t, env: {} };
  const reads = () => v.redis.log.filter(([cmd]) => cmd === "zrange" || cmd === "lrange").length;
  const others = async () => {
    for (const name of ["parked", "config"]) {
      const data = await loadPageData(name, {}, deps);
      assert.equal(Object.hasOwn(data.snapshot, "waiting"), false, `${name}: no waiting jobs in its data`);
    }
  };
  await others();
  assert.equal(reads(), 0, "the other screens' loads read no waiting job");
  const first = await loadPageData("overview", {}, deps);
  assert.deepEqual(first.snapshot.waiting.rows.map((r) => r.jobId), ["gh-1"], "the overview's load reads them");
  const once = reads();
  assert.ok(once > 0);
  for (const name of ["fleet", "host"]) {
    const data = await loadPageData(name, name === "host" ? { name: "build3" } : {}, deps);
    assert.equal(data.snapshot.waiting, first.snapshot.waiting, `${name}: reuses the overview's waiting read`);
  }
  assert.equal(reads(), once, "Fleet and host do not repeat the bounded queue read inside its window");
  await others();
  t += WAITING_TTL_MS - 1;
  const second = await loadPageData("overview", {}, deps);
  assert.equal(second.snapshot.waiting, first.snapshot.waiting, "a second overview inside the window: the same read");
  assert.equal(reads(), once, "and nothing more read for it, nor for the other screens between");
  t += 1;
  await loadPageData("overview", {}, deps);
  assert.ok(reads() > once, "past the window the overview's load reads again");
});

test("the switch's queues come from the registry read at the time: a host registered since the last read is in the preview's counts and in the pause", async () => {
  const NOW = Date.UTC(2026, 9, 26, 12, 0);
  const redis = { on() {}, async get() { return null; }, async mget(...keys) { return keys.map(() => null); }, async smembers() { return []; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async exists() { return 0; }, async del() { return 1; }, disconnect() {} };
  const paused = [];
  const queue = (_c, opts) => ({ name: opts?.name ?? "pi-jobs", async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async pause() { paused.push(opts?.name ?? "pi-jobs"); }, async resume() {}, async close() {} });
  let hosts = [];
  const logsDir = tempDir("pd-737-switch-");
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), nowFn: () => NOW });
  try {
    assert.deepEqual((await reader.snapshot()).queueCounts.map((q) => q.queue), ["pi-jobs"]);
    // gamma registers before its worker has made its queue, so the keyspace does not name it yet.
    hosts = [{ name: "gamma", routes: "true", t: String(NOW) }];
    assert.deepEqual((await reader.snapshot({ switchQueues: true })).queueCounts.map((q) => q.queue), ["pi-jobs", "pi-jobs@gamma"], "the preview's set");
    hosts = [{ name: "gamma", routes: "true", t: String(NOW) }, { name: "delta", routes: "true", t: String(NOW) }];
    await reader.pause();
    assert.deepEqual(paused.sort(), ["pi-jobs", "pi-jobs@delta", "pi-jobs@gamma"], "the pause's set");
  } finally {
    await reader.dispose();
  }
});
