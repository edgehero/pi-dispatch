import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createFleetReader, forgeLinkOf, makeLocalRunIndex, readFolderSkills, readParkedRuns, readRunById, readRunsPage, revParseHead, secretProfileNames } from "../src/read-model.mjs";
import { spawnSync } from "node:child_process";
import { parseRunFilter, runMatches, RUN_FILTER_FIELDS } from "../src/run-filter.mjs";
import { makeRunMirror } from "@edgehero/pi-dispatch/run-mirror";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { sessionKeyFor } from "@edgehero/pi-dispatch/session-key";

/**
 * The console's page readers (issue #641) and the fleet reader's additive fields. Every reader that talks to Valkey is
 * driven against a LIVE one (VALKEY_TEST_URL) through a key-prefixed client, so `runs:*` here never meets a
 * deployment's or another test's, and the mirror is seeded by the worker's own writer (`makeRunMirror`). Every clock
 * is injected: the writer trims its index by age against its own clock, so a default clock would delete these
 * fixtures once the wall clock passed their window.
 */
const URL_ = process.env.VALKEY_TEST_URL;
const live = URL_ ? false : "needs VALKEY_TEST_URL";
const AT = Date.parse("2026-10-14T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { targetUrl } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

/** A key-prefixed live client; `cleanup` deletes every key under its prefix and quits. */
async function prefixed(tag) {
  const { Redis } = await import("ioredis");
  const prefix = `pi-test-641-${tag}-${Math.random().toString(36).slice(2, 10)}:`;
  const redis = new Redis(URL_, { keyPrefix: prefix, maxRetriesPerRequest: 1 });
  redis.cleanup = async () => {
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left.map((k) => k.slice(prefix.length)));
    await redis.quit();
  };
  return redis;
}

const rec = (jobId, ms, extra = {}) => ({ jobId, kind: "github", target: "acme/web#1", flow: null, startedAt: iso(ms - MIN), endedAt: iso(ms), outcome: "completed", reason: null, host: "hosta", ...extra });
const writeLocal = (logsDir, r) => writeFileSync(join(logsDir, `${sanitizeJobId(r.jobId)}.json`), JSON.stringify(r));
const mirrorOf = (redis) => makeRunMirror({ redis, retentionDays: 30, now: () => AT });

// --- run-filter ------------------------------------------------------------------------------------------------------

test("parseRunFilter: every field parses from a query string; empty is unset; the result is frozen", () => {
  const { filter } = parseRunFilter(new URLSearchParams("repo=acme/web&kind=github&flow=triage&trigger=3&project=shop&host=mini-1&outcome=failed&reason=budget-exceeded&model=anthropic/claude-x&q=web%2312&before=5"));
  assert.deepEqual(filter, { repo: "acme/web", kind: "github", flow: "triage", trigger: "3", project: "shop", host: "mini-1", outcome: "failed", reason: "budget-exceeded", model: "anthropic/claude-x", q: "web#12" });
  assert.ok(Object.isFrozen(filter));
  assert.deepEqual(parseRunFilter(new URLSearchParams("repo=&q=")).filter, {});
  assert.deepEqual(parseRunFilter({ kind: "local", trigger: "nightly.build" }).filter, { kind: "local", trigger: "nightly.build" });
  assert.deepEqual([...RUN_FILTER_FIELDS], ["repo", "kind", "flow", "trigger", "project", "host", "backend", "outcome", "reason", "model", "q"]);
});

test("the backend filter (#712): any venue-shaped name, the table's and a newer worker's; other shapes refused; a record that names none is a local run", async () => {
  const { BACKEND_NAMES } = await import("@edgehero/pi-dispatch/backends");
  for (const name of BACKEND_NAMES) {
    const { filter } = parseRunFilter({ backend: name });
    assert.deepEqual(filter, { backend: name });
    assert.equal(runMatches(rec("gh-1", AT, { backend: name }), filter), true, name);
    assert.equal(runMatches(rec("gh-1", AT, { backend: BACKEND_NAMES.find((n) => n !== name) }), filter), false, `${name}: another venue's run`);
    assert.equal(runMatches(rec("gh-1", AT), filter), name === "local", `${name}: a run from before venues were recorded`);
  }
  // A venue a newer worker blesses (named by the Venues view) is a filter too, matched exactly; other shapes are refused.
  const { filter } = parseRunFilter({ backend: "far-venue" });
  assert.deepEqual(filter, { backend: "far-venue" });
  assert.equal(runMatches(rec("gh-1", AT, { backend: "far-venue" }), filter), true);
  assert.equal(runMatches(rec("gh-1", AT), filter), false, "a record naming no venue is local, not far-venue");
  for (const value of ["Local", "local,podman", "toString", "-x", "a".repeat(33), "far venue"]) assert.match(parseRunFilter({ backend: value }).refusal, /^backend must be a venue name/, value);
});

test("parseRunFilter refuses a hostile value in every field, and never echoes it back", () => {
  const hostile = ["a\u001b[2Jb", "x\u0000", "‮evil", "<script>", "a\"b", "'", "x".repeat(300), " acme/web", "acme/web ", "a\nb", "a\u0085b"];
  for (const field of RUN_FILTER_FIELDS) {
    for (const value of hostile) {
      const res = parseRunFilter({ [field]: value });
      assert.ok(res.refusal, `${field} refuses ${JSON.stringify(value)}`);
      assert.equal(res.filter, undefined);
      if (value.length > 1) assert.ok(!res.refusal.includes(value), `${field}: the refusal does not echo the value`);
      assert.match(res.refusal, new RegExp(`^${field} must be`));
    }
  }
  assert.match(parseRunFilter(new URLSearchParams("kind=github&kind=gitlab")).refusal, /^kind is given more than once/);
  assert.match(parseRunFilter({ kind: "svn" }).refusal, /^kind must be one of local, github/);
  assert.match(parseRunFilter({ project: "Shop" }).refusal, /^project must be/);
  assert.deepEqual(parseRunFilter({ trigger: ["a"] }).filter, { trigger: "a" }, "a one-element list is a value");
  assert.match(parseRunFilter({ host: 5 }).refusal, /^host must be text/);
});

test("runMatches: each field, positive and negative", () => {
  // `anthropic/claude-x` is a BARE model id, the shape of openrouter's `anthropic/claude-haiku-4.5`: a record's `model`
  // never carries a provider prefix (INT-RUN-HISTORY-FILE-CONTRACT), so the slash here is part of the id.
  const r = rec("repeat:nightly:1760443200000", AT, { kind: "local", target: "local:site", flow: "triage", triggerIndex: null, project: "shop", host: "mini-1", outcome: "failed", reason: "budget-exceeded", model: "anthropic/claude-x" });
  const gh = rec("gh-1", AT, { target: "acme/web#12", triggerIndex: 4 });
  const cases = [
    ["repo", "acme/web", gh, r],
    ["kind", "local", r, gh],
    ["flow", "triage", r, gh],
    ["trigger", "4", gh, r],
    ["trigger", "nightly", r, gh],
    ["project", "shop", r, gh],
    ["host", "mini-1", r, gh],
    ["backend", "podman", { ...r, backend: "podman" }, gh],
    ["outcome", "failed", r, gh],
    ["reason", "budget-exceeded", r, gh],
    ["model", "anthropic/claude-x", r, gh],
    ["q", "WEB#1", gh, r],
  ];
  for (const [field, value, yes, no] of cases) {
    const { filter } = parseRunFilter({ [field]: value });
    assert.equal(runMatches(yes, filter), true, `${field}=${value} matches`);
    assert.equal(runMatches(no, filter), false, `${field}=${value} does not match the other`);
  }
  assert.equal(runMatches(gh, parseRunFilter({ repo: "acme/web", kind: "gitlab" }).filter), false, "every set field must hold");
  assert.equal(runMatches(gh, null), true);
  assert.equal(runMatches(gh, {}), true);
  assert.equal(runMatches(null, {}), false);
  assert.equal(runMatches(rec("manual:nightly:1", AT), parseRunFilter({ trigger: "nightly" }).filter), true, "a manual fire of the scheduler too");
});

test("parseRunFilter: every priced bare model id is a filter that finds its run, a leading @ or ~ included; the hostile shapes stay refused (#668)", async () => {
  const { listPricedModels } = await import("@edgehero/pi-dispatch/pricing");
  const ids = [...new Set(listPricedModels().map((m) => m.id))];
  assert.ok(ids.some((id) => id.startsWith("@")), "the catalog has an @ id, so the walk proves something");
  assert.ok(ids.some((id) => id.startsWith("~")), "and a ~ id");
  const other = rec("gh-other", AT, { model: "not-this-model" });
  for (const id of ids) {
    const res = parseRunFilter({ model: id });
    assert.deepEqual(res.filter, { model: id }, `model ${id} parses`);
    assert.equal(runMatches(rec("gh-1", AT, { model: id }), res.filter), true, `model ${id} finds its run`);
    assert.equal(runMatches(other, res.filter), false, `model ${id} finds no other run`);
  }
  // `+` is in the class (a quantization or variant suffix), so an id holding one is a filter.
  assert.deepEqual(parseRunFilter({ model: "a+b" }).filter, { model: "a+b" }, "a + is kept");
  // Matching is exact and case-sensitive: an operator copies the id, and two ids differing in case are two models.
  const upper = rec("gh-upper", AT, { model: "Claude-X" });
  assert.equal(runMatches(upper, parseRunFilter({ model: "claude-x" }).filter), false, "case differs: no match");
  assert.equal(runMatches(upper, parseRunFilter({ model: "Claude-X" }).filter), true, "same case: a match");
  const SAYS = "model must be a model id (an optional leading @ or ~, then letters, digits and . _ : / @ + -, at most 128 characters)";
  for (const value of ["b~c", "@", "~", "@~a", "~@a", ".x", "/x", ":x", "a b", "a\"b", "a'b", "a\nb", "a".repeat(129), "@" + "a".repeat(128)]) {
    const res = parseRunFilter({ model: value });
    assert.equal(res.refusal, SAYS, `refuses ${JSON.stringify(value)}`);
    assert.equal(res.filter, undefined);
    if (value.length > 1) assert.ok(!res.refusal.includes(value), "the refusal does not echo the value");
  }
});

test("runMatches: q ignores case on the record's side too; a trigger index is at most four digits; a scheduler id needs its millis", () => {
  assert.equal(runMatches(rec("gh-1", AT, { target: "ACME/Web#12" }), parseRunFilter({ q: "web#12" }).filter), true, "an upper-case record target");
  // `12345` is a valid scheduler id, never an index: a forge run at triggers position 12345 does not match it.
  assert.equal(runMatches(rec("gh-1", AT, { triggerIndex: 12345 }), parseRunFilter({ trigger: "12345" }).filter), false);
  assert.equal(runMatches(rec("gh-1", AT, { triggerIndex: 1234 }), parseRunFilter({ trigger: "1234" }).filter), true);
  // The cron job id's last part is the fire's millis: a job id without them names no scheduler.
  for (const jobId of ["repeat:nightly:abc", "repeat:nightly:", "manual:nightly:12x", "other:nightly:1"]) {
    assert.equal(runMatches(rec(jobId, AT, { kind: "local" }), parseRunFilter({ trigger: "nightly" }).filter), false, jobId);
  }
});

test("parseRunFilter: each field takes a value at its length bound and refuses one character more", () => {
  const bounds = { repo: 200, flow: 64, trigger: 128, project: 32, host: 64, outcome: 32, reason: 64, model: 128, q: 100 };
  for (const [field, n] of Object.entries(bounds)) {
    assert.deepEqual(parseRunFilter({ [field]: "a".repeat(n) }).filter, { [field]: "a".repeat(n) }, `${field} at ${n}`);
    assert.match(parseRunFilter({ [field]: "a".repeat(n + 1) }).refusal ?? "", new RegExp(`^${field} must be`), `${field} at ${n + 1}`);
  }
});

// --- readRunsPage -----------------------------------------------------------------------------------------------------

test("readRunsPage: local and mirror merged newest first; paging by a score cursor is stable while runs land mid-paging (#641)", { skip: live, timeout: 30_000 }, async () => {
  const redis = await prefixed("page");
  const logsDir = tempDir("pd-641-page-");
  try {
    // Twelve runs a minute apart: the even ones on this host's disk, the odd ones mirrored by another host, and one
    // (r04) on both, the same record, which the merge shows once.
    const all = Array.from({ length: 12 }, (_, i) => rec(`r${String(i).padStart(2, "0")}`, AT - (12 - i) * MIN, { host: i % 2 ? "hostb" : "hosta" }));
    for (const [i, r] of all.entries()) {
      if (i % 2 === 0) writeLocal(logsDir, r);
      if (i % 2 === 1 || i === 4) await mirrorOf(redis).mirror(r, sanitizeJobId(r.jobId));
    }
    const want = all.map((r) => r.jobId).reverse();
    const p1 = await readRunsPage(redis, { logsDir, limit: 5, now: () => AT });
    assert.deepEqual(p1.runs.map((r) => r.jobId), want.slice(0, 5));
    assert.equal(p1.mirror, "ok");
    assert.equal(p1.next, Date.parse(p1.runs[4].endedAt));
    // A run lands on each side while the operator reads page one.
    const lateMirror = rec("late-m", AT, { host: "hostb" });
    const lateLocal = rec("late-l", AT + 1, { host: "hosta" });
    await mirrorOf(redis).mirror(lateMirror, "late-m");
    writeLocal(logsDir, lateLocal);
    const p2 = await readRunsPage(redis, { logsDir, limit: 5, before: p1.next, now: () => AT });
    const p3 = await readRunsPage(redis, { logsDir, limit: 5, before: p2.next, now: () => AT });
    assert.deepEqual([...p1.runs, ...p2.runs, ...p3.runs].map((r) => r.jobId), want, "every run once, in order, none of the new ones");
    assert.equal(p3.next, null, "the last page says so");
    assert.equal(p3.truncated, false);
    const fresh = await readRunsPage(redis, { logsDir, limit: 2, now: () => AT });
    assert.deepEqual(fresh.runs.map((r) => r.jobId), ["late-l", "late-m"], "a fresh first page has them");
  } finally {
    await redis.cleanup();
  }
});

test("readRunsPage never ends a page inside a group of runs sharing one instant", { skip: live, timeout: 30_000 }, async () => {
  const redis = await prefixed("ties");
  const logsDir = tempDir("pd-641-ties-");
  try {
    const t = AT - 10 * MIN;
    for (const id of ["a", "b", "c"]) await mirrorOf(redis).mirror(rec(id, t), id);
    writeLocal(logsDir, rec("d", t));
    writeLocal(logsDir, rec("newer", AT - MIN));
    writeLocal(logsDir, rec("older", AT - 20 * MIN));
    const p1 = await readRunsPage(redis, { logsDir, limit: 2, now: () => AT });
    assert.deepEqual(p1.runs.map((r) => r.jobId), ["newer", "a", "b", "c", "d"], "the whole group, past the limit");
    const p2 = await readRunsPage(redis, { logsDir, limit: 2, before: p1.next, now: () => AT });
    assert.deepEqual(p2.runs.map((r) => r.jobId), ["older"]);
  } finally {
    await redis.cleanup();
  }
});

test("readRunsPage filters after fetching, in batches, and stops at the examination cap saying where to resume", { skip: live, timeout: 60_000 }, async () => {
  const redis = await prefixed("filter");
  const logsDir = tempDir("pd-641-filter-");
  try {
    // 300 mirrored runs and 300 local ones; the only failures are the oldest two, one per side.
    for (let i = 0; i < 300; i++) {
      const old = i === 0;
      await mirrorOf(redis).mirror(rec(`m${i}`, AT - (600 - 2 * i) * MIN, old ? { outcome: "failed", reason: "budget-exceeded" } : {}), `m${i}`);
      writeLocal(logsDir, rec(`l${i}`, AT - (599 - 2 * i) * MIN, old ? { outcome: "failed", reason: "budget-exceeded" } : {}));
    }
    const { filter } = parseRunFilter({ outcome: "failed" });
    const whole = await readRunsPage(redis, { logsDir, filter, limit: 10, now: () => AT });
    assert.deepEqual(whole.runs.map((r) => r.jobId), ["l0", "m0"]);
    assert.equal(whole.truncated, false);
    assert.equal(whole.next, null);
    assert.ok(whole.examined >= 600 && whole.examined <= 800, `examined ${whole.examined}`);

    const capped = await readRunsPage(redis, { logsDir, filter, limit: 10, examineMax: 300, now: () => AT });
    assert.deepEqual(capped.runs, [], "nothing matched in the first 300 examined");
    assert.equal(capped.truncated, true);
    assert.ok(Number.isSafeInteger(capped.next));
    let next = capped.next;
    const found = [];
    for (let i = 0; i < 10 && next !== null; i++) {
      const page = await readRunsPage(redis, { logsDir, filter, limit: 10, examineMax: 300, before: next, now: () => AT });
      found.push(...page.runs.map((r) => r.jobId));
      next = page.next;
    }
    assert.deepEqual(found, ["l0", "m0"], "resuming from each cursor finds exactly the matches, once");
  } finally {
    await redis.cleanup();
  }
});

test("readRunsPage: refusals, an index that does not exist is off, an unreachable mirror leaves this host's runs", async () => {
  const logsDir = tempDir("pd-641-edges-");
  writeLocal(logsDir, rec("only", AT - MIN));
  for (const bad of [0, 101, 1.5, "5", null]) assert.match((await readRunsPage(null, { logsDir, limit: bad })).refusal, /^limit must be/);
  for (const bad of [-1, 1.5, "x", Number.MAX_VALUE]) assert.match((await readRunsPage(null, { logsDir, before: bad })).refusal, /^before must be/);
  const offline = await readRunsPage(null, { logsDir, now: () => AT });
  assert.deepEqual([offline.runs.map((r) => r.jobId), offline.mirror, offline.next], [["only"], "off", null]);
  const dead = { zrevrangebyscore: async () => { throw new Error("ECONNREFUSED"); }, mget: async () => [], exists: async () => 1 };
  const down = await readRunsPage(dead, { logsDir, now: () => AT });
  assert.deepEqual(down.runs.map((r) => r.jobId), ["only"]);
  assert.match(down.mirror, /^unreachable \(ECONNREFUSED\)/);
  const blind = await readRunsPage(null, { logsDir: join(logsDir, "only.json"), now: () => AT });
  assert.match(blind.unreachable, /^logs dir unreadable/);
});

test("readRunsPage: a mirror that exists but holds nothing older than the cursor is ok, a missing index is off", { skip: live, timeout: 30_000 }, async () => {
  const redis = await prefixed("off");
  const logsDir = tempDir("pd-641-off-");
  try {
    assert.equal((await readRunsPage(redis, { logsDir, now: () => AT })).mirror, "off");
    await mirrorOf(redis).mirror(rec("x", AT - MIN), "x");
    assert.equal((await readRunsPage(redis, { logsDir, before: AT - 2 * MIN, now: () => AT })).mirror, "ok");
  } finally {
    await redis.cleanup();
  }
});

test("makeLocalRunIndex reads the directory once per TTL, on its injected clock", () => {
  const logsDir = tempDir("pd-641-index-");
  writeLocal(logsDir, rec("a", AT - 2 * MIN));
  writeLocal(logsDir, rec("b", AT - MIN));
  let reads = 0;
  const fs = { ...nodeFs, readdirSync: (...a) => { reads++; return nodeFs.readdirSync(...a); } };
  let now = AT;
  const index = makeLocalRunIndex({ logsDir, fs, now: () => now, ttlMs: 15_000 });
  assert.deepEqual(index.records().records.map((r) => r.jobId), ["b", "a"]);
  writeLocal(logsDir, rec("c", AT));
  now += 14_999;
  assert.equal(index.records().records.length, 2, "cached");
  now += 1;
  assert.deepEqual(index.records().records.map((r) => r.jobId), ["c", "b", "a"]);
  assert.equal(reads, 2);
  const capped = makeLocalRunIndex({ logsDir, now: () => AT, max: 2 }).records();
  assert.deepEqual([capped.records.map((r) => r.jobId), capped.capped], [["c", "b"], true]);
});

/**
 * A mirror for `readRunsPage` without a Valkey: the two reads `readMirroredPage` makes (the index range WITHSCORES and
 * one MGET), over `records`, in the index's own order (score descending, then member descending). `failFrom` makes the
 * range read throw from that call on (1-based), for a mirror that drops part-way through a page.
 */
function fakeMirror(records, { failFrom = Infinity } = {}) {
  const at = (r) => Date.parse(r.endedAt);
  const sorted = [...records].sort((a, b) => at(b) - at(a) || (a.jobId < b.jobId ? 1 : -1));
  const bodies = new Map(records.map((r) => [`runs:rec:${sanitizeJobId(r.jobId)}`, JSON.stringify(r)]));
  let calls = 0;
  return {
    async zrevrangebyscore(_key, max, _min, _withScores, _limit, offset, count) {
      calls += 1;
      if (calls >= failFrom) throw new Error("ECONNRESET");
      const below = max === "+inf" ? Infinity : Number(String(max).slice(1));
      return sorted.filter((r) => at(r) < below).slice(offset, offset + count).flatMap((r) => [sanitizeJobId(r.jobId), String(at(r))]);
    },
    async mget(...keys) { return keys.map((k) => bodies.get(k) ?? null); },
    async exists() { return 1; },
  };
}
const ids = (page) => page.runs.map((r) => r.jobId);

test("readRunsPage: stopped by the examination cap, it resumes AT the floor, so a match exactly there is shown once, on the next page", async () => {
  const logsDir = tempDir("pd-641-floor-");
  // 250 local runs a minute apart; the only match is the 200th newest, which is where the first batch ends.
  for (let i = 0; i < 250; i++) writeLocal(logsDir, rec(`l${String(i).padStart(3, "0")}`, AT - (i + 1) * MIN, i === 199 ? { outcome: "failed" } : {}));
  const { filter } = parseRunFilter({ outcome: "failed" });
  const p1 = await readRunsPage(null, { logsDir, filter, limit: 10, examineMax: 100, now: () => AT });
  assert.deepEqual([ids(p1), p1.truncated, p1.next], [[], true, AT - 200 * MIN + 1], "the run AT the floor is not final yet, and the cursor keeps it");
  const p2 = await readRunsPage(null, { logsDir, filter, limit: 10, examineMax: 100, before: p1.next, now: () => AT });
  assert.deepEqual([ids(p2), p2.next], [["l199"], null]);
});

test("readRunsPage: a run is final only once BOTH sources are read past it (the floor is the higher frontier)", async () => {
  const logsDir = tempDir("pd-641-merge-floor-");
  // The mirror is dense (a run a minute, 400 of them) and this host sparse (one every three minutes, 300): after one
  // batch from each, the mirror has reached 200 minutes back and this host 600. A local match 300 minutes back must
  // wait, because the mirror's own match at 250 minutes is newer and not fetched yet.
  const mirrored = Array.from({ length: 400 }, (_, i) => rec(`m${i + 1}`, AT - (i + 1) * MIN, { host: "hostb", ...(i + 1 === 250 && { outcome: "failed" }) }));
  for (let i = 1; i <= 300; i++) writeLocal(logsDir, rec(`l${i}`, AT - 3 * i * MIN + 30_000, i === 100 ? { outcome: "failed" } : {}));
  const { filter } = parseRunFilter({ outcome: "failed" });
  const seen = [];
  let before = null;
  for (let i = 0; i < 20; i++) {
    const page = await readRunsPage(fakeMirror(mirrored), { logsDir, filter, limit: 10, examineMax: 400, before, now: () => AT });
    seen.push(...ids(page));
    if (page.next === null) break;
    before = page.next;
  }
  assert.deepEqual(seen, ["m250", "l100"], "both matches, newest first, each once");
});

test("readRunsPage: a mirror that drops part-way through a page shows this host's runs alone, never the half it fetched", async () => {
  const logsDir = tempDir("pd-641-drop-");
  for (let i = 0; i < 5; i++) writeLocal(logsDir, rec(`l${i}`, AT - (i + 1) * MIN));
  // 300 mirrored runs: the first batch of 200 arrives (one of them this host's name), the second read fails.
  const mirrored = Array.from({ length: 300 }, (_, i) => rec(`m${i}`, AT - (i + 1) * MIN - 1000, { host: i === 3 ? "hosta" : "hostb" }));
  const { filter } = parseRunFilter({ host: "hosta" });
  const page = await readRunsPage(fakeMirror(mirrored, { failFrom: 2 }), { logsDir, filter, limit: 50, now: () => AT });
  assert.deepEqual(ids(page), ["l0", "l1", "l2", "l3", "l4"], "m3 was fetched in the first batch and is dropped with it");
  assert.match(page.mirror, /^unreachable \(ECONNRESET\)/);
  const whole = await readRunsPage(fakeMirror(mirrored), { logsDir, filter, limit: 50, now: () => AT });
  assert.ok(ids(whole).includes("m3"), "and a mirror that answers shows it");
});

test("readRunsPage: a model filter on an @cf/... id finds its mirrored and local runs (#668)", async () => {
  const logsDir = tempDir("pd-668-model-");
  const CF = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  writeLocal(logsDir, rec("l1", AT - MIN, { model: CF }));
  writeLocal(logsDir, rec("l2", AT - 2 * MIN, { model: "claude-sonnet-5-5" }));
  const mirrored = [rec("m1", AT - 3 * MIN, { host: "hostb", model: CF }), rec("m2", AT - 4 * MIN, { host: "hostb", model: "~anthropic/claude-opus-latest" })];
  const { filter } = parseRunFilter({ model: CF });
  assert.deepEqual(ids(await readRunsPage(fakeMirror(mirrored), { logsDir, filter, limit: 10, now: () => AT })), ["l1", "m1"]);
  const tilde = parseRunFilter({ model: "~anthropic/claude-opus-latest" }).filter;
  assert.deepEqual(ids(await readRunsPage(fakeMirror(mirrored), { logsDir, filter: tilde, limit: 10, now: () => AT })), ["m2"]);
});

// --- readRunById ------------------------------------------------------------------------------------------------------

test("readRunById: this host's file first, then the mirror; an id outside the charset is refused before any read", { skip: live, timeout: 30_000 }, async () => {
  const redis = await prefixed("byid");
  const logsDir = tempDir("pd-641-byid-");
  try {
    const mine = rec("repeat:nightly:1760443200000", AT - MIN, { host: "hosta" });
    writeLocal(logsDir, mine);
    await mirrorOf(redis).mirror({ ...mine, host: "stale-copy" }, sanitizeJobId(mine.jobId));
    await mirrorOf(redis).mirror(rec("gh-77", AT - MIN, { host: "hostb" }), "gh-77");
    const local = await readRunById(redis, { logsDir, jobId: mine.jobId });
    assert.deepEqual([local.source, local.record.host], ["local", "hosta"], "the file is the record");
    const far = await readRunById(redis, { logsDir, jobId: "gh-77" });
    assert.deepEqual([far.source, far.record.host], ["mirror", "hostb"]);
    assert.deepEqual(await readRunById(redis, { logsDir, jobId: "gh-404" }), { missing: true });
    await redis.set("runs:rec:gh-junk", "not json");
    assert.deepEqual(await readRunById(redis, { logsDir, jobId: "gh-junk" }), { missing: true }, "a value that is not a record is not shown");
    let reads = 0;
    const fs = { ...nodeFs, readFileSync: (...a) => { reads++; return nodeFs.readFileSync(...a); } };
    for (const bad of ["../etc/passwd", "a/b", "x\u001b[2J", "", "x".repeat(201), "a b", null, 7]) {
      assert.match((await readRunById(redis, { logsDir, jobId: bad, fs })).invalid, /^a run id is/, JSON.stringify(bad));
    }
    assert.equal(reads, 0, "nothing was read for a refused id");
  } finally {
    await redis.cleanup();
  }
});

// --- readParkedRuns ---------------------------------------------------------------------------------------------------

test("readParkedRuns: a later run on the same kind + target answers a parked one; the chain count is the store's, or unknown", () => {
  const sessionsDir = tempDir("pd-641-sessions-");
  const parked = (jobId, ms, extra) => rec(jobId, ms, { outcome: "completed", reason: "awaiting-input", ...extra });
  const runs = [
    parked("gh-7", AT - 60 * MIN, { target: "acme/web#7" }),
    rec("gh-7b", AT - 30 * MIN, { target: "acme/web#7" }), // the answer
    parked("gh-8", AT - 50 * MIN, { target: "acme/web#8" }),
    rec("gl-8", AT - 10 * MIN, { kind: "gitlab", target: "acme/web#8" }), // another forge's #8 answers nothing
    parked("gh-9", AT - 40 * MIN, { target: "acme/web#9" }),
    parked("gh-10", AT - 20 * MIN, { target: "acme/web#10", triggerType: "pull_request" }),
    parked("repeat:nightly:1760443200000", AT - 5 * MIN, { kind: "local", target: "local:site" }),
    rec("gh-11", AT - 70 * MIN, { target: "acme/web#11" }), // an earlier run answers nothing
    parked("gh-11b", AT - 65 * MIN, { target: "acme/web#11" }),
  ];
  const key = (kind, repo, n) => sessionKeyFor({ kind, repo, target: { type: "issue", number: n } });
  mkdirSync(join(sessionsDir, key("github", "acme/web", 8)));
  writeFileSync(join(sessionsDir, key("github", "acme/web", 8), "resume-chain"), "3\n");
  mkdirSync(join(sessionsDir, key("github", "acme/web", 9))); // a key with no counter yet: a chain of zero
  const cronKey = sessionKeyFor({ kind: "local", trigger: { id: "nightly" } });
  mkdirSync(join(sessionsDir, cronKey));
  writeFileSync(join(sessionsDir, cronKey, "resume-chain"), "2");
  mkdirSync(join(sessionsDir, key("github", "acme/web", 11)));
  writeFileSync(join(sessionsDir, key("github", "acme/web", 11), "resume-chain"), "3.5");

  const out = readParkedRuns({ runs, now: AT, sessionsDir });
  const by = Object.fromEntries(out.map((p) => [p.jobId, p]));
  assert.deepEqual(out.map((p) => p.jobId), ["repeat:nightly:1760443200000", "gh-10", "gh-9", "gh-8", "gh-7", "gh-11b"], "newest first");
  assert.deepEqual(by["gh-7"], { target: "acme/web#7", kind: "github", jobId: "gh-7", parkedAt: AT - 60 * MIN, ageMs: 60 * MIN, answered: true, chainCount: null });
  assert.equal(by["gh-8"].answered, false, "a run on another forge's #8 is not an answer");
  assert.equal(by["gh-8"].chainCount, 3);
  assert.equal(by["gh-9"].chainCount, 0, "a key directory without a counter");
  assert.equal(by["gh-10"].chainCount, null, "a pull request's key needs its head ref: unknown");
  assert.equal(by["repeat:nightly:1760443200000"].chainCount, 2, "a cron run's key is its scheduler id");
  assert.equal(by["gh-11b"].answered, false, "an EARLIER run is not an answer");
  assert.equal(by["gh-11b"].chainCount, null, "a corrupt counter is unknown, never a guess");
  assert.ok(readParkedRuns({ runs, now: AT }).every((p) => p.chainCount === null), "no sessions dir on this host: unknown");
  assert.deepEqual(readParkedRuns({ runs: null, now: AT }), []);
  assert.equal(readParkedRuns({ runs, now: () => AT })[0].ageMs, 5 * MIN, "a clock function too");
});

test("readParkedRuns follows no link planted at the counter's name", { skip: process.platform === "win32" }, () => {
  const sessionsDir = tempDir("pd-641-link-");
  const elsewhere = join(sessionsDir, "secret");
  writeFileSync(elsewhere, "9");
  const k = sessionKeyFor({ kind: "github", repo: "acme/web", target: { type: "issue", number: 5 } });
  mkdirSync(join(sessionsDir, k));
  symlinkSync(elsewhere, join(sessionsDir, k, "resume-chain"));
  const [p] = readParkedRuns({ runs: [rec("gh-5", AT, { target: "acme/web#5", reason: "awaiting-input" })], now: AT, sessionsDir });
  assert.equal(p.chainCount, null);
});

test("readParkedRuns: a pull request's chain is unknown even when a directory exists under the issue key its number would give", () => {
  const sessionsDir = tempDir("pd-641-pr-");
  const k = sessionKeyFor({ kind: "github", repo: "acme/web", target: { type: "issue", number: 10 } });
  mkdirSync(join(sessionsDir, k));
  writeFileSync(join(sessionsDir, k, "resume-chain"), "4");
  const parked = (extra) => rec("gh-10", AT - MIN, { target: "acme/web#10", reason: "awaiting-input", ...extra });
  assert.equal(readParkedRuns({ runs: [parked({ triggerType: "pull_request" })], now: AT, sessionsDir })[0].chainCount, null);
  assert.equal(readParkedRuns({ runs: [parked({ triggerType: "issues" })], now: AT, sessionsDir })[0].chainCount, 4, "the issue's own run reads it");
});

test("readParkedRuns: unansweredOnly drops the answered runs before the counter is read, so they cost no fs call", () => {
  const sessionsDir = tempDir("pd-641-answered-");
  const runs = [rec("gh-1", AT - 60 * MIN, { target: "acme/web#1", reason: "awaiting-input" }), rec("gh-1b", AT - 30 * MIN, { target: "acme/web#1" }), rec("gh-2", AT - 20 * MIN, { target: "acme/web#2", reason: "awaiting-input" })];
  const looked = [];
  const fs = { ...nodeFs, lstatSync: (p, ...a) => (looked.push(String(p)), nodeFs.lstatSync(p, ...a)) };
  const out = readParkedRuns({ runs, now: AT, sessionsDir, fs, unansweredOnly: true });
  assert.deepEqual(out.map((p) => [p.jobId, p.answered]), [["gh-2", false]]);
  const answeredKey = sessionKeyFor({ kind: "github", repo: "acme/web", target: { type: "issue", number: 1 } });
  assert.equal(looked.filter((p) => p.includes(answeredKey)).length, 0, "no stat for the answered run's key");
  assert.equal(looked.length, 1, "one stat, for the waiting run's key directory");
  assert.deepEqual(readParkedRuns({ runs, now: AT, sessionsDir }).map((p) => p.jobId), ["gh-2", "gh-1"], "the default still lists both");
});

test("the chain counter's file name is the session store's own (a pinned copy)", () => {
  const store = readFileSync(fileURLToPath(new URL("../../worker/src/session-store.mjs", import.meta.url)), "utf8");
  assert.match(store, /\nconst RESUME_CHAIN_FILE = "resume-chain";\n/);
  assert.match(store, /\nconst SIDECAR_MAX_BYTES = 4096;\n/);
  const mine = readFileSync(fileURLToPath(new URL("../src/read-model.mjs", import.meta.url)), "utf8");
  assert.match(mine, /\nconst RESUME_CHAIN_FILE = "resume-chain";\nconst SIDECAR_MAX_BYTES = 4096;\n/);
});

// --- names and links --------------------------------------------------------------------------------------------------

test("secretProfileNames: names only, sorted, never a path; anything else is no names", () => {
  assert.deepEqual(secretProfileNames({ overlay: { secretProfiles: { prod: "/opt/r/prod.sh", "ci.x": "/opt/r/ci.sh", "bad name": "/x", "\u001b": "/y" } } }), ["ci.x", "prod"]);
  for (const v of [null, {}, { overlay: {} }, { overlay: { secretProfiles: ["a"] } }, { invalid: "x" }]) assert.deepEqual(secretProfileNames(v), []);
});

test("forgeLinkOf: GitHub as targetUrl builds it; GitLab, Forgejo and Azure from the deployment's own host", () => {
  const env = { GITLAB_URL: "https://git.example.com/", FORGEJO_URL: "https://forge.example.org/sub", AZURE_ORG_URL: "https://dev.azure.com/acme" };
  const link = (kind, target, e = env) => forgeLinkOf({ kind, target }, e);
  for (const target of ["acme/web#12", "a.b/c-d_e#1"]) assert.equal(link("github", target), targetUrl({ kind: "github", target }), target);
  assert.equal(link("github", "acme/web#12", {}), "https://github.com/acme/web/issues/12", "GitHub needs no variable");
  assert.equal(link("gitlab", "grp/sub/proj#3"), "https://git.example.com/grp/sub/proj/-/issues/3");
  assert.equal(link("gitlab", "grp/proj!4"), "https://git.example.com/grp/proj/-/merge_requests/4");
  assert.equal(link("forgejo", "o/r#5"), "https://forge.example.org/sub/o/r/issues/5");
  assert.equal(link("azure", "Proj/repo#6"), "https://dev.azure.com/acme/Proj/_workitems/edit/6");
  assert.equal(link("azure", "Proj/repo!7"), "https://dev.azure.com/acme/Proj/_git/repo/pullrequest/7");
  // The job-container names the worker derives from the deployment's, as a fallback.
  assert.equal(link("gitlab", "g/p#1", { GITLAB_HOST: "http://gl.lan" }), "http://gl.lan/g/p/-/issues/1");
  assert.equal(link("forgejo", "o/r#1", { GITEA_INSTANCE_URL: "https://tea.lan" }), "https://tea.lan/o/r/issues/1");
  assert.equal(link("azure", "p/r#1", { AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/o" }), "https://dev.azure.com/o/p/_workitems/edit/1");
});

test("forgeLinkOf refuses a hostile repo, a missing host, a non-http scheme, credentials, and an unknown shape", () => {
  const env = { GITLAB_URL: "https://git.example.com", FORGEJO_URL: "https://forge.example.org", AZURE_ORG_URL: "https://dev.azure.com/acme" };
  const none = (kind, target, e = env) => assert.equal(forgeLinkOf({ kind, target }, e), null, `${kind} ${JSON.stringify(target)} ${JSON.stringify(e)}`);
  for (const kind of ["github", "gitlab", "forgejo", "azure"]) {
    for (const target of ["acme/we\u001bb#1", "acme/web\u0007#1", "acme/w eb#1", "acme/<x>#1", "acme/web\"#1", "acme/../x#1", "../web#1", "acme/web#", "acme/web#x", "acme#1", "acme/web#1#2", "javascript:alert(1)#1"]) none(kind, target);
  }
  none("github", "acme/web!3", {}); // a separator GitHub never writes
  none("forgejo", "o/r!3");
  none("gitlab", "g/p#1", {}); // no host: no link, never gitlab.com
  none("forgejo", "o/r#1", {});
  none("azure", "p/r#1", {});
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc", "ftp://h", "https://u:p@git.example.com", "https://git.example.com/?q=1", "https://git.example.com/#x", "https://git.\u001bexample.com", "not a url", " https://git.example.com"]) {
    none("gitlab", "g/p#1", { GITLAB_URL: bad });
  }
  none("local", "local:site");
  none("svn", "a/b#1");
  none("github", null);
  assert.equal(forgeLinkOf(null, env), null);
});

test("forgeLinkOf: a target of 300 characters links, one of 301 does not; a GitHub repo has exactly one slash", () => {
  const env = { GITLAB_URL: "https://git.example.com" };
  // GitLab is the one forge whose repo charset reaches 300 characters (subgroups), so it is where the cap shows.
  const target = (n) => `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(n)}#1`;
  assert.equal(target(96).length, 300);
  assert.equal(forgeLinkOf({ kind: "gitlab", target: target(96) }, env), `https://git.example.com/${target(96).slice(0, -2)}/-/issues/1`);
  assert.equal(forgeLinkOf({ kind: "gitlab", target: target(97) }, env), null);
  for (const t of ["acme/sub/web#1", "acme/web/x#2"]) assert.equal(forgeLinkOf({ kind: "github", target: t }, {}), null, t);
  assert.equal(forgeLinkOf({ kind: "forgejo", target: "o/sub/r#1" }, { FORGEJO_URL: "https://f.example" }), null);
});

// --- the fleet reader's additive fields -------------------------------------------------------------------------------

test("createFleetReader: every active job (never .data), per-queue counts, unanswered parked runs and the day's failures", { skip: live, timeout: 30_000 }, async () => {
  const redis = await prefixed("fleet");
  const logsDir = tempDir("pd-641-fleet-");
  try {
    await mirrorOf(redis).mirror(rec("gh-p", AT - 3 * 60 * MIN, { target: "acme/web#2", reason: "awaiting-input", host: "hostb" }), "gh-p");
    await mirrorOf(redis).mirror(rec("gh-f1", AT - 2 * 60 * MIN, { outcome: "failed", host: "hostb" }), "gh-f1");
    writeLocal(logsDir, rec("gh-f2", AT - 30 * 60 * MIN, { outcome: "failed" })); // outside the day
    writeLocal(logsDir, rec("gh-f3", AT - 10 * MIN, { outcome: "failed" }));
    writeLocal(logsDir, rec("gh-q", AT - 50 * MIN, { target: "acme/web#3", reason: "awaiting-input" }));
    writeLocal(logsDir, rec("gh-q2", AT - 40 * MIN, { target: "acme/web#3" })); // answers gh-q
    const poison = { title: "SECRET TITLE", body: "SECRET BODY" };
    const lists = { "pi-jobs": [{ id: "gh-a1", processedOn: AT - MIN, data: poison }], "pi-jobs@hostb": [{ id: "gh-a2", processedOn: AT - 2 * MIN, data: poison }, { id: "gh-a3", data: poison }] };
    const asked = [];
    const mk = (_c, opts) => {
      const name = opts?.name ?? "pi-jobs";
      return {
        name,
        async isPaused() { return name !== "pi-jobs"; },
        async getJobCounts() { return name === "pi-jobs" ? { waiting: 1, active: 1, paused: 0, delayed: 0, failed: 0 } : { waiting: 2, active: 2, paused: 0, delayed: 1, failed: 0 }; },
        async getWorkers() { return []; },
        async getJobSchedulers() { return []; },
        async getActive(a, b) { asked.push([name, a, b]); return lists[name]; },
        async getFailed() { return []; },
        async close() {},
      };
    };
    const hosts = [{ name: "hostb", routes: true, jobs: JSON.stringify([{ id: "gh-a2", p: null, at: AT - 2 * MIN }]) }];
    const reader = createFleetReader(
      { valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
      { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => [], nowFn: () => AT, activeLimit: 50 },
    );
    const snap = await reader.snapshot();
    assert.deepEqual(asked.map((a) => a.slice(1)), [[0, 49], [0, 49]], "bounded per queue");
    assert.deepEqual(snap.active, [
      { jobId: "gh-a1", queue: "pi-jobs", startedAt: AT - MIN, host: null, progress: null },
      { jobId: "gh-a2", queue: "pi-jobs@hostb", startedAt: AT - 2 * MIN, host: "hostb", progress: null },
      { jobId: "gh-a3", queue: "pi-jobs@hostb", startedAt: null, host: null, progress: null },
    ]);
    assert.equal(snap.activeJobId, "gh-a1", "the TUI's field is still there");
    assert.ok(!JSON.stringify(snap).includes("SECRET"), "no Job .data anywhere in the snapshot");
    assert.deepEqual(snap.queueCounts, [
      { queue: "pi-jobs", paused: false, counts: { waiting: 1, active: 1, paused: 0, delayed: 0, failed: 0 } },
      { queue: "pi-jobs@hostb", paused: true, counts: { waiting: 2, active: 2, paused: 0, delayed: 1, failed: 0 } },
    ]);
    assert.equal(snap.queue.counts.waiting, 3, "the summed counts are unchanged");
    assert.deepEqual(snap.parked.map((p) => [p.jobId, p.answered, p.chainCount]), [["gh-p", false, null]], "the unanswered one only");
    assert.equal(snap.failures24h, 2);
    assert.equal(snap.failures24hFloor, false);
    assert.equal(snap.parkedUnreachable, null, "both sides read, so the parked list is known");
    const page = await reader.runsPage({ limit: 3 });
    assert.deepEqual(page.runs.map((r) => r.jobId), ["gh-f3", "gh-q2", "gh-q"]);
    assert.equal((await reader.runById("gh-p")).source, "mirror");
  } finally {
    await redis.cleanup();
  }
});

test("createFleetReader: a logs dir it cannot read makes the parked list unknown, never a short list said to be whole", { skip: live, timeout: 30_000 }, async () => {
  const redis = await prefixed("fleet-partial");
  const logsDir = tempDir("pd-641-partial-");
  try {
    const nodeFs = await import("node:fs");
    const denied = { ...nodeFs, readdirSync: (p, ...rest) => (p === logsDir ? (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })() : nodeFs.readdirSync(p, ...rest)) };
    const mk = (_c, opts) => ({
      name: opts?.name ?? "pi-jobs",
      async isPaused() { return false; },
      async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
      async getWorkers() { return []; },
      async getJobSchedulers() { return []; },
      async getActive() { return []; },
      async getFailed() { return []; },
      async close() {},
    });
    const reader = createFleetReader(
      { valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
      { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT, fs: denied },
    );
    const snap = await reader.snapshot();
    assert.deepEqual(snap.parked, []);
    assert.match(snap.parkedUnreachable, /logs dir unreadable \(EACCES\)/);
  } finally {
    await redis.cleanup();
  }
});

// --- the fleet reader: what it costs and what it writes ---------------------------------------------------------------

/** A queue that answers every read the snapshot makes with nothing, recording what `getActive` was asked. */
const quietQueue = (asked = []) => (_c, opts) => {
  const name = opts?.name ?? "pi-jobs";
  return {
    name,
    async isPaused() { return false; },
    async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
    async getWorkers() { return []; },
    async getJobSchedulers() { return []; },
    async getActive(a, b) { asked.push([a, b]); return []; },
    async getFailed() { return []; },
    async close() {},
  };
};

/** A Valkey that holds nothing, recording each range read on the run index; `mirrorDown` makes those reads throw. */
function emptyRedis({ mirrorDown = false } = {}) {
  const ranges = [];
  return {
    ranges,
    on() {},
    async smembers() { return []; },
    async hgetall() { return {}; },
    async get() { return null; },
    async mget(...keys) { return keys.map(() => null); },
    async zrevrangebyscore(...args) {
      ranges.push(args);
      if (mirrorDown) throw new Error("ECONNREFUSED");
      return [];
    },
    async exists() { return 0; },
    disconnect() {},
  };
}

const fleetOf = (logsDir, redis, extra = {}) =>
  createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    { makeQueueFn: quietQueue(extra.asked), parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT, ...extra.seams },
  );

test("createFleetReader: activeLimit asks each queue for one active job by default (the TUI's cost), the console's bound when given", async () => {
  const logsDir = tempDir("pd-641-active-");
  for (const [limit, want] of [[undefined, [0, 0]], [50, [0, 49]], [500, [0, 49]], [0, [0, 0]], [2.5, [0, 0]]]) {
    const asked = [];
    await fleetOf(logsDir, emptyRedis(), { asked, seams: limit === undefined ? {} : { activeLimit: limit } }).snapshot();
    assert.deepEqual(asked, [want], `activeLimit ${limit}`);
  }
});

test("createFleetReader: an unreachable run mirror makes the parked list unknown, never an empty list said to be whole", async () => {
  const logsDir = tempDir("pd-641-mirror-down-");
  writeLocal(logsDir, rec("gh-p", AT - MIN, { target: "acme/web#2", reason: "awaiting-input" }));
  const snap = await fleetOf(logsDir, emptyRedis({ mirrorDown: true })).snapshot();
  assert.deepEqual(snap.parked.map((p) => p.jobId), ["gh-p"], "this host's parked run is still listed");
  assert.equal(snap.parkedUnreachable, "the run mirror could not be read");
  const up = await fleetOf(logsDir, emptyRedis()).snapshot();
  assert.equal(up.parkedUnreachable, null);
});

test("createFleetReader: a park whose answer is queued or running is marked answering (the shared scan), listed at most once per 15 s; an unlistable queue is unknown (issue #647)", async () => {
  const logsDir = tempDir("pd-647-answering-");
  writeLocal(logsDir, rec("gh-p", AT - MIN, { target: "acme/web#2", reason: "awaiting-input" }));
  writeLocal(logsDir, rec("gh-r", AT - 2 * MIN, { target: "acme/web#3", reason: "awaiting-input" }));
  const listed = [];
  const listing = (_c, opts) => ({
    ...quietQueue()(_c, opts),
    async getJobs([state]) {
      listed.push(state);
      return state === "waiting" ? [{ id: "gh-ans", data: { kind: "github", repo: "Acme/Web", target: { type: "issue", number: 2 }, title: "SECRET TITLE" } }] : [];
    },
  });
  let t = AT;
  const reader = fleetOf(logsDir, emptyRedis(), { seams: { makeQueueFn: listing, nowFn: () => t } });
  const snap = await reader.snapshot();
  assert.deepEqual(snap.parked.map((p) => [p.jobId, p.answering]), [["gh-p", "gh-ans"], ["gh-r", false]]);
  // Review round 2: each row carries the scan's own answer, the input of the verdict the inbox shares with the Chat panel.
  assert.deepEqual(snap.parked.map((p) => p.pendingScan), [{ jobId: "gh-ans" }, { jobId: null }]);
  assert.ok(!JSON.stringify(snap).includes("SECRET"), "no Job .data in the snapshot");
  const once = listed.length;
  await reader.snapshot();
  assert.equal(listed.length, once, "the same parks within 15 s: no second listing");
  t += 15_000;
  await reader.snapshot();
  assert.equal(listed.length, 2 * once, "listed again once the window passed");
  const blind = await fleetOf(logsDir, emptyRedis()).snapshot();
  assert.deepEqual(blind.parked.map((p) => p.answering), [null, null], "a queue that cannot list: unknown, never false");
  assert.deepEqual(blind.parked.map((p) => p.pendingScan), [{ unknown: true, tooMany: false }, { unknown: true, tooMany: false }]);
  const none = tempDir("pd-647-answering-none-");
  writeLocal(none, rec("gh-x", AT - MIN, { target: "acme/web#9" }));
  const quiet = [];
  await fleetOf(none, emptyRedis(), { seams: { makeQueueFn: (_c, o) => ({ ...listing(_c, o), async getJobs() { quiet.push(1); return []; } }) } }).snapshot();
  assert.equal(quiet.length, 0, "nothing parked: the queues are not listed");
});

test("createFleetReader: the day's failures skip a run dated in the future, and are a floor when the wide window ends inside the day", async () => {
  // 999 runs a minute apart (ten of them failed) and one failed run ten minutes AHEAD of the clock: a full window of
  // 1000 whose oldest run is under 17 hours old, so more failures may lie beyond it.
  const full = tempDir("pd-641-floor-full-");
  for (let i = 1; i <= 999; i++) writeLocal(full, rec(`r${i}`, AT - i * MIN, i % 100 === 50 ? { outcome: "failed" } : {}));
  writeLocal(full, rec("future", AT + 10 * MIN, { outcome: "failed" }));
  const snap = await fleetOf(full, emptyRedis()).snapshot();
  assert.deepEqual([snap.failures24h, snap.failures24hFloor], [10, true]);
  // A full window that reaches back past the day holds the whole day: an exact count.
  const deep = tempDir("pd-641-floor-deep-");
  for (let i = 1; i <= 1000; i++) writeLocal(deep, rec(`r${i}`, AT - 2 * i * MIN, i === 3 ? { outcome: "failed" } : {}));
  const exact = await fleetOf(deep, emptyRedis()).snapshot();
  assert.deepEqual([exact.failures24h, exact.failures24hFloor], [1, false]);
});

test("createFleetReader: an answered parked run costs the snapshot no session-store read", async () => {
  const logsDir = tempDir("pd-641-answered-fleet-");
  const sessionsDir = tempDir("pd-641-answered-sessions-");
  writeLocal(logsDir, rec("gh-1", AT - 60 * MIN, { target: "acme/web#1", reason: "awaiting-input" }));
  writeLocal(logsDir, rec("gh-1b", AT - 30 * MIN, { target: "acme/web#1" }));
  const looked = [];
  const fs = { ...nodeFs, lstatSync: (p, ...a) => (looked.push(String(p)), nodeFs.lstatSync(p, ...a)) };
  const snap = await createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, sessionsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
    { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT, fs },
  ).snapshot();
  assert.deepEqual(snap.parked, []);
  assert.deepEqual(looked.filter((p) => p.startsWith(sessionsDir)), []);
});

test("createFleetReader: the wide window is read once per 15 s, on the reader's clock", async () => {
  const logsDir = tempDir("pd-641-wide-cache-");
  writeLocal(logsDir, rec("gh-1", AT - MIN));
  const redis = emptyRedis();
  let now = AT;
  const reader = fleetOf(logsDir, redis, { seams: { nowFn: () => now } });
  const wideReads = () => redis.ranges.filter((a) => a[a.length - 1] === 1000).length;
  await reader.snapshot();
  assert.equal(wideReads(), 1);
  now += 14_999;
  await reader.snapshot();
  assert.equal(wideReads(), 1, "cached");
  now += 1;
  await reader.snapshot();
  assert.equal(wideReads(), 2);
});

test("createFleetReader: a readOnly snapshot issues no Valkey write, where the TUI's still prunes what it finds stale", { skip: live, timeout: 30_000 }, async () => {
  const { exists: isCommand, hasFlag } = await import("@ioredis/commands");
  const redis = await prefixed("readonly");
  const logsDir = tempDir("pd-641-readonly-");
  try {
    // One stale entry for each reader that prunes as it goes: a registry member with no row, a held id with no hash,
    // and a mirrored id whose body has expired.
    await redis.sadd("host:live", "ghost");
    await redis.sadd("wait:held", "gh-gone");
    await mirrorOf(redis).mirror(rec("gh-ok", AT - MIN), "gh-ok");
    await redis.zadd("runs:index", AT - 2 * MIN, "gh-expired");
    const recording = () => {
      const calls = [];
      const proxy = new Proxy(redis, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== "function") return v;
          if (typeof prop === "string" && isCommand(prop.toLowerCase())) return (...a) => (calls.push(prop.toLowerCase()), v.apply(target, a));
          return v.bind(target);
        },
      });
      return { calls, proxy };
    };
    const reader = (proxy, seams) =>
      createFleetReader(
        { valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 },
        { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => proxy, discoverHostQueuesFn: async () => [], nowFn: () => AT, ...seams },
      );
    const ro = recording();
    const snap = await reader(ro.proxy, { readOnly: true }).snapshot();
    assert.deepEqual(snap.runs.map((r) => r.jobId), ["gh-ok"]);
    assert.ok(ro.calls.length > 0);
    assert.deepEqual(ro.calls.filter((c) => !hasFlag(c, "readonly")), [], `only read-only commands: ${[...new Set(ro.calls)].join(", ")}`);
    assert.equal(await redis.sismember("host:live", "ghost"), 1);
    assert.equal(await redis.sismember("wait:held", "gh-gone"), 1);
    assert.notEqual(await redis.zscore("runs:index", "gh-expired"), null);
    assert.equal(await redis.exists("runs:horizon"), 0);

    const rw = recording();
    await reader(rw.proxy, {}).snapshot();
    assert.ok(rw.calls.includes("srem") && rw.calls.includes("eval"), `the default reader prunes: ${[...new Set(rw.calls)].join(", ")}`);
    assert.equal(await redis.sismember("host:live", "ghost"), 0);
    assert.equal(await redis.sismember("wait:held", "gh-gone"), 0);
    assert.equal(await redis.zscore("runs:index", "gh-expired"), null);
  } finally {
    await redis.cleanup();
  }
});

// --- git reads keep git's words to themselves ------------------------------------------------------------------------

test("every git read captures stderr: stdin closed, stdout and stderr piped, never inherited", () => {
  const seen = [];
  const exec = (cmd, args, opts) => {
    seen.push([args.find((a) => ["rev-parse", "ls-tree", "cat-file"].includes(a)), opts?.stdio]);
    if (args.includes("rev-parse")) return "abc123\n";
    if (args.includes("ls-tree")) return `100644 blob ${"1".repeat(40)}      40\t.pi/skills/triage/SKILL.md\0`;
    return Buffer.from("---\nname: triage\ndescription: x\n---\n");
  };
  assert.equal(revParseHead("/x", { exec }), "abc123");
  readFolderSkills({ folder: "/x", exec });
  assert.deepEqual(seen.map((c) => c[0]), ["rev-parse", "rev-parse", "ls-tree", "cat-file"], "every git call the read makes was seen");
  for (const [what, stdio] of seen) assert.deepEqual(stdio, ["ignore", "pipe", "pipe"], what);
});

test("a folder that is not a repository prints nothing on the caller's stderr", () => {
  const folder = tempDir("pd-641-nogit-");
  const script = `const m = await import(${JSON.stringify(new URL("../src/read-model.mjs", import.meta.url).href)}); process.stdout.write(JSON.stringify([m.revParseHead(${JSON.stringify(folder)}), m.readFolderSkills({ folder: ${JSON.stringify(folder)} }).unreachable]));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: folder } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [null, "not-a-git-repo"]);
  assert.equal(child.stderr, "", "git's fatal line stayed with the read");
});
