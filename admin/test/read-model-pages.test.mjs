import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { LOOKUP_TOLD_MAX, REFUSALS_TOP, RUN_FILE_UNREADABLE, RUN_MIRROR_UNREAD, RUNS_WINDOW_PROJECTS_MAX, RUNS_WINDOW_VALUES_MAX, SWITCH_PREVIEW_QUEUES_MAX, SWITCH_SCAN_INCOMPLETE, WAITING_DISCOVERY_TTL_MS, WAITING_QUEUES_MAX, createFleetReader, forgeLinkOf, makeLocalRunIndex, readFolderSkills, readParkedRuns, readRunById, readRunsPage, refusalsIn, revParseHead, secretProfileNames } from "../src/read-model.mjs";
import { spawnSync } from "node:child_process";
import { parseRunFilter, runMatches, RUN_FILTER_FIELDS, RUN_OUTCOME_VALUES, runVenueOf, triggerValueOf } from "../src/run-filter.mjs";
import { OUTCOME_KEYS } from "../src/words.mjs";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
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
  assert.deepEqual([...RUN_FILTER_FIELDS], ["repo", "kind", "flow", "trigger", "project", "host", "backend", "outcome", "reason", "model", "q", "problems"]);
  assert.deepEqual(parseRunFilter(new URLSearchParams("problems=1&outcome=awaiting-input")).filter, { outcome: "awaiting-input", problems: "1" });
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

test("the outcome filter takes the five words a row says and the record's policy, and refuses anything else naming the six (#737)", () => {
  assert.deepEqual([...RUN_OUTCOME_VALUES], [...OUTCOME_KEYS, "policy"]);
  for (const o of RUN_OUTCOME_VALUES) assert.deepEqual(parseRunFilter({ outcome: o }).filter, { outcome: o });
  for (const value of ["vapour", "__proto__", "constructor", "Completed", "awaiting input", "awaiting_input", "operator-cancel", "toString"]) {
    assert.equal(parseRunFilter({ outcome: value }).refusal, "outcome must be one of completed, refused, failed, awaiting-input, awaiting-approval, cancelled (or policy, the record's value for refused, cancelled and recovery failures)", value);
  }
  // problems takes 1 alone.
  for (const value of ["0", "true", "yes", "11", "1 "]) assert.equal(parseRunFilter({ problems: value }).refusal, "problems must be 1 (only problems)", value);
});

test("runMatches: an outcome key is what the row says (a recovery end is failed, awaiting input is not completed); policy is the record's value (#737)", () => {
  const runs = {
    done: rec("gh-done", AT),
    asked: rec("gh-asked", AT, { reason: "awaiting-input" }),
    refused: rec("gh-ref", AT, { outcome: "policy", reason: "scope-cap" }),
    nameless: rec("gh-noreason", AT, { outcome: "policy", reason: null }),
    cancelled: rec("gh-cx", AT, { outcome: "policy", reason: "operator-cancel" }),
    capped: rec("gh-cap", AT, { outcome: "policy", reason: "recovery-cap" }),
    absent: rec("gh-absent", AT, { outcome: "policy", reason: "recovery-checkpoint-absent" }),
    unsafe: rec("gh-unsafe", AT, { outcome: "policy", reason: "recovery-unsafe-extensions" }),
    failed: rec("gh-fail", AT, { outcome: "failed", reason: "container-lost" }),
    infra: rec("gh-infra", AT, { outcome: "failed", reason: "infra failure, container exit 1" }),
    odd: rec("gh-odd", AT, { outcome: "vapour" }),
  };
  const found = (query) => Object.entries(runs).filter(([, r]) => runMatches(r, parseRunFilter(query).filter)).map(([k]) => k);
  assert.deepEqual(found({ outcome: "completed" }), ["done"], "a run awaiting input is not completed");
  assert.deepEqual(found({ outcome: "awaiting-input" }), ["asked"]);
  assert.deepEqual(found({ outcome: "refused" }), ["refused", "nameless"], "neither a cancel nor a recovery end is a refusal");
  assert.deepEqual(found({ outcome: "cancelled" }), ["cancelled"]);
  assert.deepEqual(found({ outcome: "failed" }), ["capped", "absent", "unsafe", "failed", "infra"], "the recovery ends recorded as policy are failures");
  assert.deepEqual(found({ outcome: "policy" }), ["refused", "nameless", "cancelled", "capped", "absent", "unsafe"], "policy keeps the record's own meaning, so an old link keeps its rows");
  assert.deepEqual(found({ outcome: "failed", reason: "recovery-cap" }), ["capped"], "the row's reason link finds its run");
  // Only problems: every run that did not complete, an outcome this release does not know included.
  assert.deepEqual(found({ problems: "1" }), ["asked", "refused", "nameless", "cancelled", "capped", "absent", "unsafe", "failed", "infra", "odd"]);
  assert.deepEqual(found({ problems: "1", outcome: "failed", reason: "container-lost" }), ["failed"], "and with the other fields, each must hold");
});

test("runMatches: the search finds a run by a fragment of its target or its job id, either case, and nothing else (#737)", () => {
  const a = rec("gh-2f6a", AT, { target: "acme/api#131" });
  const b = rec("repeat:nightly:1760443200000", AT, { kind: "local", target: "local:site" });
  const c = rec("gl-9a2c", AT, { kind: "gitlab", target: "acme/billing-ui#405" });
  const found = (q) => [a, b, c].filter((r) => runMatches(r, parseRunFilter({ q }).filter)).map((r) => r.jobId);
  assert.deepEqual(found("gh-2f6a"), ["gh-2f6a"], "a whole job id");
  assert.deepEqual(found("2F6"), ["gh-2f6a"], "a job id fragment, any case");
  assert.deepEqual(found("nightly"), ["repeat:nightly:1760443200000"], "a scheduler run by its id's middle");
  assert.deepEqual(found("repeat:nightly:"), ["repeat:nightly:1760443200000"], "a colon is in the charset");
  assert.deepEqual(found("acme/"), ["gh-2f6a", "gl-9a2c"], "a repository is a target's fragment");
  assert.deepEqual(found("#405"), ["gl-9a2c"]);
  assert.deepEqual(found("zzz"), []);
  // A record whose id or target is not a string is matched by the other alone, never thrown on.
  assert.equal(runMatches({ jobId: 7, target: "acme/api#1" }, parseRunFilter({ q: "api" }).filter), true);
  assert.equal(runMatches({ jobId: "gh-api", target: null }, parseRunFilter({ q: "api" }).filter), true);
  assert.equal(runMatches({ jobId: null, target: null }, parseRunFilter({ q: "api" }).filter), false);
});

test("runVenueOf and triggerValueOf read a record as the filter matches it (#737)", () => {
  assert.equal(runVenueOf(rec("gh-1", AT)), "local", "no venue recorded: a local run");
  assert.equal(runVenueOf(rec("gh-1", AT, { backend: "" })), "local");
  assert.equal(runVenueOf(rec("gh-1", AT, { backend: "podman" })), "podman");
  assert.equal(runVenueOf(null), "local");
  assert.equal(triggerValueOf(rec("gh-1", AT, { triggerIndex: 0 })), "0");
  assert.equal(triggerValueOf(rec("gh-1", AT, { triggerIndex: 12 })), "12");
  assert.equal(triggerValueOf(rec("repeat:nightly:1760443200000", AT, { triggerIndex: null })), "nightly");
  assert.equal(triggerValueOf(rec("manual:nightly:1", AT)), "nightly");
  for (const odd of [rec("gh-1", AT, { triggerIndex: -1 }), rec("gh-1", AT, { triggerIndex: 1.5 }), rec("gh-1", AT, { triggerIndex: "3" }), rec("gh-1", AT), null]) assert.equal(triggerValueOf(odd), null);
  // Each value it gives is one the filter matches back to the record.
  for (const r of [rec("gh-1", AT, { triggerIndex: 4 }), rec("repeat:nightly:1760443200000", AT)]) assert.equal(runMatches(r, parseRunFilter({ trigger: triggerValueOf(r) }).filter), true);
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
  // `outcome` is the record's closed enum, not a bounded shape (#710 round 2): its own test above holds it.
  // `q` takes every id the run page takes (RUN_ID_RE, 200 characters), so the run-not-found page's search holds one.
  const bounds = { repo: 200, flow: 64, trigger: 128, project: 32, host: 64, reason: 64, model: 128, q: 200 };
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

test("readRunById: missing only when this host's file and the fleet's mirror both said none; a record either side could not read is unreadable (#737)", async () => {
  const logsDir = tempDir("pd-737-byid-unread-");
  const answers = (value) => ({ async get() { return typeof value === "function" ? value() : value; } });
  // Both sides read, neither holds one: the one answer that is an absence.
  assert.deepEqual(await readRunById(answers(null), { logsDir, jobId: "gh-9" }), { missing: true });
  // The mirror GET timed out, failed, or holds a value that is not a record: nothing was read there.
  const slow = { async get() { await new Promise((r) => setTimeout(r, 200)); return JSON.stringify(rec("gh-9", AT)); } };
  assert.deepEqual(await readRunById(slow, { logsDir, jobId: "gh-9", timeoutMs: 20 }), { unreadable: RUN_MIRROR_UNREAD }, "a mirror that does not answer in time");
  assert.deepEqual(await readRunById(answers(() => Promise.reject(new Error("ECONNRESET"))), { logsDir, jobId: "gh-9" }), { unreadable: RUN_MIRROR_UNREAD }, "a mirror that cannot be reached");
  for (const junk of ["{nope", "[1]", "null", ""]) assert.deepEqual(await readRunById(answers(junk), { logsDir, jobId: "gh-9" }), { unreadable: RUN_MIRROR_UNREAD }, JSON.stringify(junk));
  assert.deepEqual(await readRunById(null, { logsDir, jobId: "gh-9" }), { unreadable: RUN_MIRROR_UNREAD }, "no client to ask the mirror with");
  // This host's file is there and is not a record: unreadable, whatever the mirror says of its absence...
  writeFileSync(join(logsDir, "gh-bad.json"), "{ half a reco");
  assert.deepEqual(await readRunById(answers(null), { logsDir, jobId: "gh-bad" }), { unreadable: RUN_FILE_UNREADABLE });
  const denied = { ...nodeFs, readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  assert.deepEqual(await readRunById(answers(null), { logsDir, jobId: "gh-9", fs: denied }), { unreadable: RUN_FILE_UNREADABLE }, "a file this process may not read");
  // ...and the mirror's copy is the answer when it has one.
  const copy = rec("gh-bad", AT, { host: "hostb" });
  assert.deepEqual(await readRunById(answers(JSON.stringify(copy)), { logsDir, jobId: "gh-bad" }), { record: copy, source: "mirror" });
});


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
    assert.deepEqual(await readRunById(redis, { logsDir, jobId: "gh-junk" }), { unreadable: RUN_MIRROR_UNREAD }, "a value that is not a record is not shown, and is no absence");
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
  assert.deepEqual(by["gh-7"], { target: "acme/web#7", kind: "github", jobId: "gh-7", project: null, parkedAt: AT - 60 * MIN, ageMs: 60 * MIN, answered: true, chainCount: null });
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
      { jobId: "gh-a1", queue: "pi-jobs", startedAt: AT - MIN, host: null, project: null, size: null, progress: null },
      { jobId: "gh-a2", queue: "pi-jobs@hostb", startedAt: AT - 2 * MIN, host: "hostb", project: null, size: null, progress: null },
      { jobId: "gh-a3", queue: "pi-jobs@hostb", startedAt: null, host: null, project: null, size: null, progress: null },
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

test("createFleetReader: parkedCount is the snapshot's unanswered parked runs, off the same cached window, with no chain read; unknown is null (issue #737)", async () => {
  const logsDir = tempDir("pd-737-parked-count-");
  writeLocal(logsDir, rec("gh-p1", AT - 3 * MIN, { target: "acme/web#2", reason: "awaiting-input" }));
  writeLocal(logsDir, rec("gh-p2", AT - 2 * MIN, { target: "acme/web#3", reason: "awaiting-input" }));
  writeLocal(logsDir, rec("gh-q", AT - 5 * MIN, { target: "acme/web#4", reason: "awaiting-input" }));
  writeLocal(logsDir, rec("gh-q2", AT - 4 * MIN, { target: "acme/web#4" })); // answers gh-q
  const sessionsDir = tempDir("pd-737-parked-count-sessions-");
  const nodeFs = await import("node:fs");
  const looked = [];
  const fs = { ...nodeFs, lstatSync: (p, ...rest) => (looked.push(String(p)), nodeFs.lstatSync(p, ...rest)) };
  const redis = emptyRedis();
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2, sessionsDir },
    { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT, fs },
  );
  assert.equal(await reader.parkedCount(), 2, "the two unanswered parks");
  assert.ok(!looked.some((p) => p.startsWith(sessionsDir)), "no session-store read: a count needs no chain counter");
  const reads = redis.ranges.length;
  assert.equal(reads, 1, "one read of the mirror's wide window");
  assert.equal(await reader.parkedCount(), 2);
  assert.equal(redis.ranges.length, reads, "a second count inside the cache window reads nothing");
  const snap = await reader.snapshot();
  assert.deepEqual(snap.parked.map((p) => p.jobId), ["gh-p2", "gh-p1"], "the snapshot lists the same runs");
  const afterSnapshot = redis.ranges.length;
  assert.equal(await reader.parkedCount(), snap.parked.length);
  assert.equal(redis.ranges.length, afterSnapshot, "and a count after a snapshot shares its window");
  // A partial window (the mirror unread) is not a count, and neither is one that throws.
  assert.equal(await fleetOf(logsDir, emptyRedis({ mirrorDown: true })).parkedCount(), null);
  const denied = { ...nodeFs, readdirSync: (p, ...rest) => (p === logsDir ? (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })() : nodeFs.readdirSync(p, ...rest)) };
  assert.equal(await fleetOf(logsDir, emptyRedis(), { seams: { fs: denied } }).parkedCount(), null, "an unreadable logs dir");
  const throwing = { ...emptyRedis(), async zrevrangebyscore() { throw new Error("boom"); } };
  assert.equal(await fleetOf(logsDir, throwing).parkedCount(), null);
  assert.equal(await fleetOf(tempDir("pd-737-parked-none-"), emptyRedis()).parkedCount(), 0, "nothing parked is a known zero");
});

test("createFleetReader: concurrent counts and snapshots share ONE wide-window read, at first and when the cache runs out; a read that fails is not handed out again (issue #737)", async () => {
  const logsDir = tempDir("pd-737-wide-shared-");
  writeLocal(logsDir, rec("gh-p1", AT - 3 * MIN, { target: "acme/web#2", reason: "awaiting-input" }));
  writeLocal(logsDir, rec("gh-p2", AT - 2 * MIN, { target: "acme/web#3", reason: "awaiting-input" }));
  // The mirror's wide-window read (the one asking for 1000 ids) waits on a gate, so every caller arrives while it runs.
  let gate = null;
  const wideReads = [];
  const base = emptyRedis();
  const redis = {
    ...base,
    async zrevrangebyscore(...args) {
      if (args.at(-1) === 1000) {
        wideReads.push(args);
        await gate;
      }
      return [];
    },
  };
  let t = AT;
  // While set, every walk of the logs dir throws (a burst may start more than one read, and each must fail).
  let failing = false;
  const fs = { ...nodeFs, readdirSync: (p, ...rest) => {
    if (p === logsDir && failing) {
      // Not an fs error (those make the window partial, a value): a throw out of the read itself.
      return { [Symbol.iterator]() { throw new Error("index walk failed"); } };
    }
    return nodeFs.readdirSync(p, ...rest);
  } };
  const reader = fleetOf(logsDir, redis, { seams: { nowFn: () => t, fs } });
  const burst = async () => {
    let open;
    gate = new Promise((r) => (open = r));
    const asked = [reader.parkedCount(), reader.parkedCount(), reader.snapshot().then((s) => s.parked.length), reader.parkedCount()];
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    const during = wideReads.length;
    open();
    return { got: await Promise.all(asked), during };
  };
  const first = await burst();
  assert.deepEqual(first.got, [2, 2, 2, 2]);
  assert.equal(first.during, 1, "four callers at an empty cache: one read, in flight while they all waited");
  assert.equal(wideReads.length, 1);
  assert.equal(await reader.parkedCount(), 2);
  assert.equal(wideReads.length, 1, "inside the cache window: no read");
  // The cache runs out: the next burst makes one read again.
  t += 60_000;
  const second = await burst();
  assert.deepEqual(second.got, [2, 2, 2, 2]);
  assert.equal(wideReads.length, 2, "a burst at expiry: one more read, not four");
  // A read that throws answers each waiting caller with its failure, as a failure: the count says null, and the
  // snapshot (review round 2, R04: a failed read handed on as a value would have made its fold throw) still answers,
  // with no parked runs and the reason they are not known, never an empty list alone.
  t += 60_000;
  failing = true;
  gate = Promise.resolve();
  const [countA, countB, snap] = await Promise.all([reader.parkedCount(), reader.parkedCount(), reader.snapshot()]);
  failing = false;
  assert.deepEqual([countA, countB], [null, null]);
  assert.deepEqual(snap.parked, []);
  assert.match(snap.parkedUnreachable ?? "", /index walk failed/, "the snapshot names why its parked list is not known");
  // And the next caller makes a fresh read instead of being handed the failed one.
  assert.equal(await reader.parkedCount(), 2, "the next caller reads again, and the read succeeds");
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
  // The day's first instant is inside it, as `refusalsIn` counts it (review round 1): a failed run at exactly AT - 24 h
  // counts, one a millisecond older does not, and so do the refusals beside them, from the same window.
  const edge = tempDir("pd-710-day-edge-");
  writeLocal(edge, rec("f-edge", AT - 24 * 60 * MIN, { outcome: "failed" }));
  writeLocal(edge, rec("f-past", AT - 24 * 60 * MIN - 1, { outcome: "failed" }));
  writeLocal(edge, rec("p-edge", AT - 24 * 60 * MIN, { outcome: "policy", reason: "scope-cap" }));
  writeLocal(edge, rec("p-past", AT - 24 * 60 * MIN - 1, { outcome: "policy", reason: "scope-cap" }));
  const day = await fleetOf(edge, emptyRedis()).snapshot();
  assert.deepEqual([day.failures24h, day.refusals24h], [1, { count: 1, top: [{ reason: "scope-cap", count: 1 }] }]);
});

test("refusalsIn: the day's refused runs by the console's word (an operator's cancel is not one), the top reasons by count then token", () => {
  const runs = [
    rec("p1", AT - MIN, { outcome: "policy", reason: "scope-cap" }),
    rec("p2", AT - 2 * MIN, { outcome: "policy", reason: "scope-cap" }),
    rec("p3", AT - 3 * MIN, { outcome: "policy", reason: "over-budget" }),
    rec("p4", AT - 4 * MIN, { outcome: "policy", reason: "operator-cancel" }), // "cancelled": not a refusal
    rec("p5", AT - 5 * MIN, { outcome: "policy", reason: null }), // counted, never listed
    rec("p6", AT - 6 * MIN, { outcome: "policy", reason: "<img src=x>" }), // outside the charset: counted, never listed
    rec("p7", AT - 25 * 60 * MIN, { outcome: "policy", reason: "scope-cap" }), // outside the day
    rec("p9", AT - 24 * 60 * MIN, { outcome: "policy", reason: "edge-cap" }), // exactly a day old: the window's first instant, counted
    rec("p10", AT - 24 * 60 * MIN - 1, { outcome: "policy", reason: "edge-cap" }), // a millisecond older: outside
    rec("p8", AT + MIN, { outcome: "policy", reason: "scope-cap" }), // dated ahead of the clock
    rec("f1", AT - MIN, { outcome: "failed", reason: "container-lost" }),
    rec("c1", AT - MIN, { outcome: "completed", reason: "operator-cancel" }), // the token under another outcome: not a refusal either
    ...["a-1", "b-1", "c-1", "d-1", "e-1"].map((r, i) => rec(`t${i}`, AT - (10 + i) * MIN, { outcome: "policy", reason: r })),
  ];
  const got = refusalsIn(runs, AT);
  assert.equal(got.count, 11);
  assert.equal(REFUSALS_TOP, 5);
  assert.deepEqual(got.top, [{ reason: "scope-cap", count: 2 }, { reason: "a-1", count: 1 }, { reason: "b-1", count: 1 }, { reason: "c-1", count: 1 }, { reason: "d-1", count: 1 }]);
  // The boundary alone (review round 1): `>=` keeps the record at exactly AT - DAY_MS, a `>` would drop it.
  assert.deepEqual(refusalsIn([runs.find((r) => r.jobId === "p9")], AT), { count: 1, top: [{ reason: "edge-cap", count: 1 }] });
  assert.deepEqual(refusalsIn([runs.find((r) => r.jobId === "p10")], AT), { count: 0, top: [] });
  assert.deepEqual(refusalsIn([], AT), { count: 0, top: [] });
  assert.deepEqual(refusalsIn(null, AT), { count: 0, top: [] });
});

test("createFleetReader: the day's refusals beside its failures, and each failed job's record reason, the closed enum only (#710)", async () => {
  const logsDir = tempDir("pd-710-refusals-");
  writeLocal(logsDir, rec("gh-r1", AT - 10 * MIN, { outcome: "policy", reason: "scope-cap" }));
  writeLocal(logsDir, rec("gh-r2", AT - 20 * MIN, { outcome: "policy", reason: "operator-cancel" }));
  writeLocal(logsDir, rec("gh-dead", AT - 30 * MIN, { outcome: "failed", reason: "container-lost" }));
  writeLocal(logsDir, rec("gh-odd", AT - 40 * MIN, { outcome: "failed", reason: "NOT A TOKEN <b>" }));
  const failedJobs = [{ id: "gh-dead", attemptsMade: 3, failedReason: "FREE TEXT", finishedOn: AT - 30 * MIN }, { id: "gh-odd", attemptsMade: 1, failedReason: "x", finishedOn: AT - 40 * MIN }, { id: "gh-none", attemptsMade: 1, failedReason: "y", finishedOn: AT - 50 * MIN }];
  const queue = (_c, opts) => ({ ...quietQueue()(_c, opts), async getFailed() { return opts?.name ? [] : failedJobs; } });
  const snap = await fleetOf(logsDir, emptyRedis(), { seams: { makeQueueFn: queue } }).snapshot();
  assert.deepEqual(snap.refusals24h, { count: 1, top: [{ reason: "scope-cap", count: 1 }] });
  assert.equal(snap.failures24h, 2);
  assert.deepEqual(snap.failed.rows.map((r) => [r.jobId, r.reason]), [["gh-dead", "container-lost"], ["gh-odd", null], ["gh-none", null]], "the record's token, null for one outside the charset or with no record");
  assert.deepEqual(snap.failed.rows.map((r) => [r.jobId, r.hasRecord]), [["gh-dead", true], ["gh-odd", true], ["gh-none", false]], "a retained record whose reason is absent stays distinct from no record");
  assert.equal(snap.failed.rows[0].target, "acme/web#1");
  assert.equal(snap.failed.rows[0].outcome, "failed");
  assert.equal(snap.failed.rows[2].target, null);
  assert.equal(snap.failed.rows[0].failedReason, "FREE TEXT", "BullMQ's text is still the operator's, beside it");
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

// --- the overview's day and the registry's clock fields (issue #737) ---------------------------------------------------

test("createFleetReader: the day's runs, today's settled spend per UTC hour and today's soft-hold refusals, off the wide window, each value re-checked (#737)", async () => {
  const logsDir = tempDir("pd-737-day-");
  const HOUR = 60 * MIN;
  const dollars = (settledMicros) => ({ reservedMicros: settledMicros, settledMicros, basis: "metered", modelBasis: null });
  writeLocal(logsDir, rec("gh-r1", AT - 30 * MIN, { project: "shop", dollars: dollars(1_500_000) }));
  writeLocal(logsDir, rec("gh-r2", AT - 90 * MIN, { outcome: "failed", reason: "container-lost", dollars: dollars(250_000), parentJobId: "gh-r0" }));
  writeLocal(logsDir, rec("gh-r3", AT - 10 * MIN, { outcome: "policy", reason: "soft-hold", dollars: null }));
  writeLocal(logsDir, rec("gh-r4", AT - 13 * HOUR, { dollars: dollars(9_999) })); // yesterday 23:00 UTC: in the last 24 h, not today
  writeLocal(logsDir, rec("gh-r5", AT - 25 * HOUR, { dollars: dollars(7) })); // outside the day
  writeLocal(logsDir, rec("gh-r6", AT + 5 * MIN, { dollars: dollars(5) })); // dated ahead of the clock
  writeLocal(logsDir, rec("gh-r7", AT - 13 * HOUR, { outcome: "policy", reason: "soft-hold" })); // yesterday's soft hold
  writeLocal(logsDir, rec("gh-r8", AT - 2 * HOUR, { kind: "<b>", target: "acme/web#1\u001b[2J", project: "Shop", host: "bad host", outcome: "weird", reason: "NOT A TOKEN", parentJobId: "a b" }));
  writeLocal(logsDir, rec("gh-r9", AT - 3 * HOUR, { dollars: { reservedMicros: 1, settledMicros: -5, basis: "metered" } }));
  writeLocal(logsDir, rec("gh-r10", AT + 6 * MIN, { outcome: "policy", reason: "soft-hold", dollars: null })); // a soft hold dated ahead of the clock
  const snap = await fleetOf(logsDir, emptyRedis()).snapshot();
  assert.deepEqual(snap.runsDay.runs.map((r) => r.jobId), ["gh-r3", "gh-r1", "gh-r2", "gh-r8", "gh-r9", "gh-r4", "gh-r7"], "the last 24 hours, newest first");
  assert.deepEqual(snap.runsDay.runs.find((r) => r.jobId === "gh-r2"), { jobId: "gh-r2", kind: "github", target: "acme/web#1", project: null, host: "hosta", outcome: "failed", reason: "container-lost", startedAt: AT - 91 * MIN, endedAt: AT - 90 * MIN, parentJobId: "gh-r0" });
  assert.equal(snap.runsDay.runs.find((r) => r.jobId === "gh-r1").project, "shop");
  const bad = snap.runsDay.runs.find((r) => r.jobId === "gh-r8");
  assert.deepEqual([bad.kind, bad.target, bad.project, bad.host, bad.outcome, bad.reason, bad.parentJobId], [null, null, null, null, null, null, null], "another host's text is judged on the way out");
  assert.deepEqual([snap.runsDay.floor, snap.runsDay.partial], [false, false]);
  const hours = Array.from({ length: 24 }, (_, i) => (i > 12 ? null : 0));
  hours[11] = 1_500_000;
  hours[10] = 250_000;
  assert.deepEqual(snap.spendByHour, { hours, unpriced: 3, floor: false, partial: false }, "hour 12 is now (0 so far), the hours after it null; three of today's runs carry no settled amount");
  assert.deepEqual(snap.softHoldToday, { count: 1, floor: false, partial: false }, "today's soft hold up to now, not yesterday's, nor one dated ahead of the clock");
  // A wide window that cannot be read is not an empty day.
  const fs = { ...nodeFs, readdirSync: (p, ...rest) => (p === logsDir ? { [Symbol.iterator]() { throw new Error("index walk failed"); } } : nodeFs.readdirSync(p, ...rest)) };
  const down = await fleetOf(logsDir, emptyRedis(), { seams: { fs } }).snapshot();
  assert.deepEqual([down.runsDay, down.spendByHour, down.softHoldToday], [null, null, null]);
  const blind = await fleetOf(logsDir, emptyRedis({ mirrorDown: true })).snapshot();
  assert.deepEqual([blind.runsDay.partial, blind.spendByHour.partial, blind.softHoldToday.partial], [true, true, true], "the mirror unread: partial");
});

test("createFleetReader: a full wide window that ends inside a span makes that span's fold a floor (#737)", async () => {
  // 1000 runs a minute apart up to the clock: they reach back about 16.7 hours, inside the last 24 hours (a floor) but
  // past today's 00:00 UTC (12 hours back), so today's folds are whole.
  const logsDir = tempDir("pd-737-day-floor-");
  for (let i = 0; i < 1000; i += 1) writeLocal(logsDir, rec(`r${i}`, AT - i * MIN));
  const snap = await fleetOf(logsDir, emptyRedis()).snapshot();
  assert.equal(snap.runsDay.runs.length, 1000);
  assert.deepEqual([snap.runsDay.floor, snap.spendByHour.floor, snap.softHoldToday.floor], [true, false, false]);
  const today = tempDir("pd-737-day-floor-today-");
  for (let i = 0; i < 1000; i += 1) writeLocal(today, rec(`t${i}`, AT - i * 30_000));
  const full = await fleetOf(today, emptyRedis()).snapshot();
  assert.deepEqual([full.runsDay.floor, full.spendByHour.floor, full.softHoldToday.floor], [true, true, true], "all 1000 inside today: every fold a floor");
});

test("createFleetReader: each host row carries the registry's ttlAgeMs, skewMs and noExpiry, re-checked; hostsReadAt is the last good read (#737)", async () => {
  const logsDir = tempDir("pd-737-hosts-clock-");
  let t = AT;
  let hosts = [
    { name: "mini1", routes: "true", ttlAgeMs: 1200, skewMs: -5000, noExpiry: false },
    { name: "mini2", routes: "true", ttlAgeMs: -1, skewMs: 1.5, noExpiry: "yes" },
    { name: "mini3", routes: "true", ttlAgeMs: null, skewMs: 108_000, noExpiry: true },
    { name: "mini4", routes: "true" },
  ];
  let up = false;
  const reader = fleetOf(logsDir, emptyRedis(), { seams: { nowFn: () => t, readLiveHostsFn: async () => (up ? { hosts } : { unreachable: "ECONNREFUSED" }) } });
  const before = await reader.snapshot();
  assert.equal(before.hostsReadAt, null, "no registry read yet");
  up = true;
  const snap = await reader.snapshot();
  assert.deepEqual(snap.hostBudgets.map((h) => [h.name, h.ttlAgeMs, h.skewMs, h.noExpiry]), [
    ["mini1", 1200, -5000, false],
    ["mini2", null, null, null],
    ["mini3", null, 108_000, true],
    ["mini4", null, null, null],
  ]);
  assert.equal(snap.hostsReadAt, AT);
  up = false;
  t += 30_000;
  const later = await reader.snapshot();
  assert.equal(later.hostsReadAt, AT, "the rows kept from the last good read say when that was");
  assert.deepEqual(later.hostBudgets.map((h) => h.name), ["mini1", "mini2", "mini3", "mini4"]);
});

test("createFleetReader: a registry member no worker could be named is no host: a 3,000-character name reaches no part of the snapshot a page draws from (#737)", async () => {
  const logsDir = tempDir("pd-737-hosts-names-");
  const long = `h${"x".repeat(3000)}`;
  const rows = { mini1: { name: "mini1", routes: "true", beatAt: String(AT) }, [long]: { name: long, routes: "true", beatAt: String(AT) }, mini2: { name: `mini2${"y".repeat(80)}`, routes: "true", beatAt: String(AT) } };
  const redis = { ...emptyRedis(), async smembers(key) { return key === "host:live" ? Object.keys(rows) : []; }, async hgetall(key) { return rows[key.replace(/^host:h:/, "")] ?? {}; } };
  // The worker's own registry reader, as serve's reader uses it: only the seam that names the queues is a fake.
  const snap = await fleetOf(logsDir, redis, { seams: { readLiveHostsFn: readLiveHosts } }).snapshot();
  assert.deepEqual(snap.hostBudgets.map((h) => h.name), ["mini1"]);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("xxxxxxxx") && !text.includes("yyyyyyyy"), "neither name is anywhere in the snapshot");
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

test("writeEnvelope carries a Valkey client's words only bounded: control bytes made spaces, at most 200 characters", async () => {
  const { writeEnvelope } = await import("../src/read-model.mjs");
  const dir = tempDir("pd-737-envelope-words-");
  const projectsPath = join(dir, "projects.json");
  const envelopeFile = join(dir, "envelope.json");
  writeFileSync(projectsPath, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  writeFileSync(envelopeFile, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  const words = `connect ECONNREFUSED 10.9.8.7:6379 \u001b]52;c;${"A".repeat(300)}\u0007`;
  const bounded = `connect ECONNREFUSED 10.9.8.7:6379  ]52;c;${"A".repeat(300)} `.slice(0, 200);
  const write = (over) => writeEnvelope({ envelopeFile, projectsPath, maxCostMicros: 2_000_000, change: { totalUsd: "90" }, url: "redis://127.0.0.1:1", ...over });
  const fails = () => {
    throw new Error(words);
  };
  const client = (over) => () => ({ on() {}, status: "ready", set: async () => null, eval: async () => 1, disconnect() {}, ...over });
  // The client could not be made, its SET failed, and, once the file could not be replaced, its put-back failed.
  const unmade = await write({ redisFn: fails });
  const unset = await write({ redisFn: client({ set: async () => fails() }) });
  const unput = await write({ redisFn: client({ eval: async () => fails() }), fs: { ...nodeFs, writeFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
  for (const [what, res] of [["unmade", unmade], ["unset", unset], ["unput", unput]]) {
    assert.ok(typeof res.invalid === "string" && res.invalid.includes(`(${bounded})`), `${what}: ${res.invalid}`);
    assert.ok(!res.invalid.includes(words.slice(0, 40)) && !/[\u0000-\u001f]/.test(res.invalid), `${what}: no control byte, and cut`);
  }
  assert.match(unmade.invalid, /^could not reach Valkey to record the new envelope's digest in /);
  assert.match(unset.invalid, /^could not record the new envelope's digest in /);
  assert.match(unput.invalid, /could not be put back to absent \(/);
});

// --- the runs page's window, parked projects and the switch preview (issue #737) -----------------------------------------

test("createFleetReader: runsWindow counts the last 24 hours by outcome key, project and reason, lists each field's values, and sums the settled spend (#737)", async () => {
  const logsDir = tempDir("pd-737-window-");
  const dollars = (settledMicros) => ({ reservedMicros: settledMicros, settledMicros, basis: "metered", modelBasis: null });
  writeLocal(logsDir, rec("gh-c1", AT - 10 * MIN, { project: "web", flow: "fix", model: "m1", triggerIndex: 0, dollars: dollars(1_000_000) }));
  writeLocal(logsDir, rec("gh-c2", AT - 20 * MIN, { project: "web", flow: "fix", model: "m1", triggerIndex: 9, backend: "podman", dollars: dollars(500_000) }));
  writeLocal(logsDir, rec("gh-a1", AT - 30 * MIN, { project: "web", reason: "awaiting-input", triggerIndex: 1 }));
  writeLocal(logsDir, rec("gh-r1", AT - 40 * MIN, { project: "api", outcome: "policy", reason: "scope-cap", host: "hostb" }));
  writeLocal(logsDir, rec("gh-x1", AT - 50 * MIN, { outcome: "policy", reason: "operator-cancel" }));
  writeLocal(logsDir, rec("gh-rc", AT - 60 * MIN, { project: "api", outcome: "policy", reason: "recovery-cap", host: "hostb", dollars: dollars(250_000) }));
  writeLocal(logsDir, rec("gh-f1", AT - 70 * MIN, { outcome: "failed", reason: "container-lost", model: "m2" }));
  writeLocal(logsDir, rec("gh-f2", AT - 80 * MIN, { outcome: "failed", reason: "infra failure, container exit 1" }));
  writeLocal(logsDir, rec("gh-u1", AT - 90 * MIN, { outcome: "vapour", project: "Not A Project" }));
  writeLocal(logsDir, rec("repeat:nightly:1760443200000", AT - 100 * MIN, { kind: "local", target: "local:site", host: "bad host", model: "a b" }));
  writeLocal(logsDir, rec("gh-old", AT - 25 * 60 * MIN, { project: "old", host: "hostold", outcome: "failed", reason: "too-old" })); // outside the day
  writeLocal(logsDir, rec("gh-ahead", AT + 5 * MIN, { project: "ahead", outcome: "failed", reason: "ahead" })); // dated ahead of the clock
  const redis = emptyRedis();
  const reader = fleetOf(logsDir, redis);
  const w = await reader.runsWindow();
  assert.equal(w.at, AT);
  assert.deepEqual([w.floor, w.partial], [false, false]);
  assert.deepEqual(w.byOutcome, { completed: 3, refused: 1, failed: 3, "awaiting-input": 1, "awaiting-approval": 0, cancelled: 1, other: 1 }, "a recovery end is failed, a run awaiting input is not completed");
  assert.deepEqual(w.byProject.map((p) => [p.project, p.count]), [[null, 5], ["web", 3], ["api", 2]], "by count, the records with no project id (or one that is no id) under null");
  assert.deepEqual(w.byProject.find((p) => p.project === "api").byOutcome, { completed: 0, refused: 1, failed: 1, "awaiting-input": 0, "awaiting-approval": 0, cancelled: 0, other: 0 }, "a project's own outcome counts: its recovery end is a failure");
  assert.deepEqual(w.byProject.map((p) => [p.project, p.spentMicros, p.unpriced]), [[null, 0, 5], ["web", 1_500_000, 1], ["api", 250_000, 1]], "and its own settled spend");
  assert.equal(w.projectsMore, 0);
  assert.deepEqual(w.byReason, { "awaiting-input": 1, "container-lost": 1, "operator-cancel": 1, "recovery-cap": 1, "scope-cap": 1 }, "tokens only, sorted: a free-text reason is counted nowhere");
  assert.deepEqual(w.values, {
    kind: ["github", "local"],
    flow: ["fix"],
    trigger: ["0", "1", "9", "nightly"],
    host: ["hosta", "hostb"],
    backend: ["local", "podman"],
    model: ["m1", "m2"],
    reason: ["awaiting-input", "container-lost", "operator-cancel", "recovery-cap", "scope-cap"],
  }, "each value the filter takes as it is; a host or model it refuses is not offered, nor a reason that is no token");
  for (const [field, list] of Object.entries(w.values)) for (const v of list) assert.equal(parseRunFilter({ [field]: v }).filter?.[field], v, `${field}=${v}`);
  assert.equal(w.spentMicros, 1_750_000);
  assert.equal(w.unpriced, 7, "the day's runs whose record carries no settled amount");
  assert.ok(Object.isFrozen(w) && Object.isFrozen(w.byOutcome) && Object.isFrozen(w.values.host));
  // Off the same cached wide window: a second count inside 15 s reads nothing.
  const reads = redis.ranges.length;
  await reader.runsWindow();
  await reader.parkedCount();
  assert.equal(redis.ranges.length, reads, "no read of its own");
});

test("createFleetReader: runsWindow runs on the reader's clock: the window moves with it, and a record leaves it at 24 hours (#737)", async () => {
  const logsDir = tempDir("pd-737-window-clock-");
  writeLocal(logsDir, rec("gh-1", AT - 60 * MIN, { outcome: "failed", reason: "container-lost" }));
  writeLocal(logsDir, rec("gh-2", AT - 10 * MIN));
  let now = AT;
  const reader = fleetOf(logsDir, emptyRedis(), { seams: { nowFn: () => now } });
  assert.deepEqual((await reader.runsWindow()).byOutcome, { completed: 1, refused: 0, failed: 1, "awaiting-input": 0, "awaiting-approval": 0, cancelled: 0, other: 0 });
  now = AT - 60 * MIN + 24 * 60 * MIN; // exactly a day after gh-1: the window's first instant, still in
  assert.equal((await reader.runsWindow()).byOutcome.failed, 1);
  now += 1;
  const w = await reader.runsWindow();
  assert.deepEqual([w.at, w.byOutcome.failed, w.byOutcome.completed], [now, 0, 1], "a millisecond later it has left");
});

test("createFleetReader: runsWindow is a floor when the wide window ends inside the day, partial when a side was not read, and null when it cannot be read (#737)", async () => {
  const full = tempDir("pd-737-window-floor-");
  for (let i = 0; i < 1000; i += 1) writeLocal(full, rec(`r${i}`, AT - i * MIN));
  const w = await fleetOf(full, emptyRedis()).runsWindow();
  assert.deepEqual([w.floor, w.byOutcome.completed], [true, 1000]);
  const one = tempDir("pd-737-window-partial-");
  writeLocal(one, rec("gh-1", AT - MIN));
  const blind = await fleetOf(one, emptyRedis({ mirrorDown: true })).runsWindow();
  assert.deepEqual([blind.partial, blind.byOutcome.completed], [true, 1], "this host's runs are still counted, marked partial");
  const fs = { ...nodeFs, readdirSync: (p, ...rest) => (p === one ? { [Symbol.iterator]() { throw new Error("index walk failed"); } } : nodeFs.readdirSync(p, ...rest)) };
  assert.equal(await fleetOf(one, emptyRedis(), { seams: { fs } }).runsWindow(), null, "not an empty day");
});

test("createFleetReader: runsWindow names at most 24 projects and 50 values per list, the most runs first, and counts the projects left out (#737)", async () => {
  const logsDir = tempDir("pd-737-window-bounds-");
  // 30 projects, p00 with 30 runs down to p29 with 1, each on hosta; then 60 runs with no project: 55 that each carry a
  // value of their own in every listed field but the kind (host h00 to h54, reason r00 to r54, and so on), and five
  // that carry zz-busy (trigger 9000), which sorts last and runs most of them.
  const two = (n) => String(n).padStart(2, "0");
  const runs = [];
  for (let p = 0; p < 30; p += 1) for (let k = 0; k < 30 - p; k += 1) runs.push({ project: `p${two(p)}` });
  for (let i = 0; i < 55; i += 1) runs.push({ host: `h${two(i)}`, outcome: "failed", reason: `r${two(i)}`, flow: `f${two(i)}`, triggerIndex: i, backend: `b${two(i)}`, model: `m${two(i)}` });
  for (let k = 0; k < 5; k += 1) runs.push({ host: "zz-busy", outcome: "failed", reason: "zz-busy", flow: "zz-busy", triggerIndex: 9000, backend: "zz-busy", model: "zz-busy" });
  runs.forEach((extra, i) => writeLocal(logsDir, rec(`gh-${i}`, AT - 1000 - i, extra)));
  const w = await fleetOf(logsDir, emptyRedis()).runsWindow();
  assert.equal(RUNS_WINDOW_PROJECTS_MAX, 24);
  assert.equal(RUNS_WINDOW_VALUES_MAX, 50);
  assert.deepEqual(w.byProject.map((p) => p.project), [null, ...Array.from({ length: 23 }, (_, i) => `p${two(i)}`)], "the most runs first: the 60 with none, then p00 to p22");
  assert.equal(w.projectsMore, 7, "p23 to p29, counted");
  assert.deepEqual(w.values.host, [...Array.from({ length: 48 }, (_, i) => `h${two(i)}`), "hosta", "zz-busy"], "the most frequent kept (hosta, then zz-busy), the rest by name, shown in order");
  // EVERY list is bounded the same way, the reason included: 56 values offered, 50 listed, the busiest kept.
  assert.deepEqual(Object.keys(w.values).sort(), ["backend", "flow", "host", "kind", "model", "reason", "trigger"]);
  for (const [field, list] of Object.entries(w.values)) {
    assert.ok(list.length <= RUNS_WINDOW_VALUES_MAX, `${field}: ${list.length} values`);
    if (field === "kind") continue;
    assert.equal(list.length, RUNS_WINDOW_VALUES_MAX, `${field}: cut at the bound`);
    assert.ok(list.includes(field === "trigger" ? "9000" : "zz-busy"), `${field}: the busiest value is kept`);
  }
  assert.deepEqual(w.values.reason, [...Array.from({ length: 49 }, (_, i) => `r${two(i)}`), "zz-busy"], "the reason list too: the busiest, then by name");
  assert.equal(Object.keys(w.byReason).length, 56, "byReason still counts every token");
});

test("createFleetReader: runsWindow puts the runs with no project after every named project among equal counts (#737)", async () => {
  const logsDir = tempDir("pd-737-window-ties-");
  for (const r of [rec("gh-1", AT - 1000), rec("gh-2", AT - 2000), rec("gh-3", AT - 3000, { project: "web" }), rec("gh-4", AT - 4000, { project: "web" })]) writeLocal(logsDir, r);
  assert.deepEqual((await fleetOf(logsDir, emptyRedis()).runsWindow()).byProject.map((p) => p.project), ["web", null]);
});

test("createFleetReader: runsWindow counts a negative settled amount as no amount, and a sum past a safe whole number as null (#737)", async () => {
  const dollars = (settledMicros) => ({ reservedMicros: 1, settledMicros, basis: "metered", modelBasis: null });
  const windowOf = async (records) => {
    const logsDir = tempDir("pd-737-window-spend-");
    for (const r of records) writeLocal(logsDir, r);
    return fleetOf(logsDir, emptyRedis()).runsWindow();
  };
  const neg = await windowOf([rec("gh-1", AT - 1000, { dollars: dollars(-5) }), rec("gh-2", AT - 2000, { dollars: dollars(7) })]);
  assert.deepEqual([neg.spentMicros, neg.unpriced], [7, 1]);
  const big = await windowOf([rec("gh-1", AT - 1000, { dollars: dollars(Number.MAX_SAFE_INTEGER) }), rec("gh-2", AT - 2000, { dollars: dollars(Number.MAX_SAFE_INTEGER) })]);
  assert.equal(big.spentMicros, null);
});

test("createFleetReader: runsWindow lists the trigger positions by number (row 2 before row 10), then the scheduler ids (#737)", async () => {
  const logsDir = tempDir("pd-737-window-trigger-");
  for (const r of [rec("gh-1", AT - 1000, { triggerIndex: 10 }), rec("gh-2", AT - 2000, { triggerIndex: 2 }), rec("repeat:nightly:1760443200000", AT - 3000, { kind: "local", target: "local:x" })]) writeLocal(logsDir, r);
  assert.deepEqual((await fleetOf(logsDir, emptyRedis()).runsWindow()).values.trigger, ["2", "10", "nightly"]);
});

test("the parked rows carry the record's project, a project id only; failures24h counts a recovery end as the failure it reads as (#737)", async () => {
  const logsDir = tempDir("pd-737-parked-project-");
  writeLocal(logsDir, rec("gh-p1", AT - 3 * MIN, { target: "acme/web#2", reason: "awaiting-input", project: "web" }));
  writeLocal(logsDir, rec("gh-p2", AT - 2 * MIN, { target: "acme/web#3", reason: "awaiting-input", project: "Web Shop" }));
  writeLocal(logsDir, rec("gh-rc", AT - 10 * MIN, { outcome: "policy", reason: "recovery-cap" }));
  writeLocal(logsDir, rec("gh-ru", AT - 11 * MIN, { outcome: "policy", reason: "recovery-unsafe-extensions" }));
  writeLocal(logsDir, rec("gh-f", AT - 12 * MIN, { outcome: "failed", reason: "container-lost" }));
  writeLocal(logsDir, rec("gh-r", AT - 13 * MIN, { outcome: "policy", reason: "scope-cap" }));
  const snap = await fleetOf(logsDir, emptyRedis()).snapshot();
  assert.deepEqual(snap.parked.map((p) => [p.jobId, p.project]), [["gh-p2", null], ["gh-p1", "web"]]);
  assert.equal(snap.failures24h, 3, "two recovery ends and a failure");
  assert.deepEqual(snap.refusals24h, { count: 1, top: [{ reason: "scope-cap", count: 1 }] }, "a recovery end is no refusal");
});

test("createFleetReader: a cut switch preview reads the shared queue and the registry's queues first, then the scanned ones, drawn in the switch's order (#737)", async () => {
  const NOW = Date.UTC(2026, 9, 26, 12, 0);
  const redis = { on() {}, async get() { return null; }, async mget(...keys) { return keys.map(() => null); }, async smembers() { return []; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async exists() { return 0; }, disconnect() {} };
  const queue = (_c, opts) => ({ name: opts?.name ?? "pi-jobs", async isPaused() { return false; }, async getJobCounts() { return { waiting: 0 }; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {} });
  // 250 queues only a keyspace scan names, and two live hosts whose names sort after every one of them.
  const planted = Array.from({ length: 250 }, (_, i) => `pi-jobs@h${String(i).padStart(3, "0")}`);
  const logsDir = tempDir("pd-737-switch-order-");
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [{ name: "zz-live", routes: true }, { name: "zz-also", routes: "true" }] }), discoverHostQueuesFn: async () => ({ names: planted, incomplete: null }), nowFn: () => NOW });
  try {
    const s = await reader.snapshot({ switchQueues: true });
    const read = s.queueCounts.map((q) => q.queue);
    assert.equal(read.length, SWITCH_PREVIEW_QUEUES_MAX);
    assert.deepEqual([s.switchTotal, s.switchTruncated], [253, true]);
    assert.ok(read.includes("pi-jobs") && read.includes("pi-jobs@zz-live") && read.includes("pi-jobs@zz-also"), "the live queues are read");
    assert.deepEqual(read.slice(-3), ["pi-jobs@h196", "pi-jobs@zz-also", "pi-jobs@zz-live"], "then the scanned ones up to the bound, all drawn in the switch's order");
  } finally {
    await reader.dispose();
  }
});

/**
 * A fleet reader over queues that each hold the jobs `held` names for them (`{ [queue]: { [jobId]: state } }`).
 * `hosts` is the registry's rows or a function that reads them now, `now` the reader's clock, `redis` what the Valkey
 * double answers beyond holding nothing. `counts.scan` counts the keyspace scans, `counts.byId` each id's job reads.
 */
function lookupFleet({ held = {}, hosts = [], scan = { names: [], incomplete: null }, registryDown = false, counts = null, now = () => AT, redis = {} } = {}) {
  const logsDir = tempDir("pd-737-lookup-");
  const queue = (_c, opts) => {
    const name = opts?.name ?? "pi-jobs";
    const jobs = held[name] ?? {};
    return {
      name,
      async getJob(id) {
        if (counts) {
          counts.getJob = (counts.getJob ?? 0) + 1;
          counts.byId = { ...counts.byId, [id]: (counts.byId?.[id] ?? 0) + 1 };
        }
        return Object.hasOwn(jobs, id) ? { id, name: "github", data: { kind: "github" }, opts: {}, async getState() { return jobs[id]; } } : null;
      },
      async isPaused() { return false; },
      async getJobCounts() { return { waiting: Object.keys(jobs).length }; },
      async getWorkers() { return []; },
      async getJobSchedulers() { return []; },
      async getActive() { return []; },
      async getFailed() { return []; },
      async getJobs() { return []; },
      async close() {},
    };
  };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, {
    makeQueueFn: queue,
    parseConnectionFn: () => ({}),
    // A Valkey that holds nothing, the live transcript's stream reads included.
    redisFn: () => ({ ...emptyRedis(), async xlen() { return 0; }, async xrange() { return []; }, async xrevrange() { return []; }, ...redis }),
    readLiveHostsFn: async () => {
      if (counts) counts.registry = (counts.registry ?? 0) + 1;
      if (registryDown) throw new Error("ECONNREFUSED");
      return { hosts: typeof hosts === "function" ? hosts() : hosts };
    },
    discoverHostQueuesFn: async () => {
      if (counts) counts.scan = (counts.scan ?? 0) + 1;
      return typeof scan === "function" ? scan() : scan;
    },
    nowFn: now,
  });
  return { reader, logsDir };
}

test("createFleetReader: the by-id job lookup asks every queue the kill switch flips, so a job waiting on a stopped host's queue is found, and a lookup that is not whole is no absence (#737)", async () => {
  // The registry no longer names the host; its queue, and the job waiting in it, are still there.
  const gone = lookupFleet({ held: { "pi-jobs@gone": { "gh-wait": "waiting" } }, scan: { names: ["pi-jobs@gone"], incomplete: null } });
  try {
    const s = await gone.reader.snapshot({ switchQueues: true });
    assert.ok(s.queueCounts.some((q) => q.queue === "pi-jobs@gone" && q.counts?.waiting === 1), "a fleet resume would start it");
    const found = await gone.reader.jobStatus("gh-wait");
    assert.deepEqual([found.found, found.state], [true, "waiting"], "and the run page's lookup sees it");
    assert.equal((await gone.reader.jobStatus("gh-none")).found, false, "every queue asked, none holds it: an absence");
  } finally {
    await gone.reader.dispose();
  }
  // A scan that did not read the whole keyspace, a registry that could not be read, a set past the bound: not whole.
  for (const [what, opts] of [
    ["a scan that did not finish", { scan: { names: [], incomplete: "the queue scan ran out of time" } }],
    ["a scan that failed", { scan: () => { throw new Error("ECONNRESET"); } }],
    ["a registry that could not be read", { registryDown: true }],
    ["more queues than one lookup asks", { scan: { names: Array.from({ length: 80 }, (_, i) => `pi-jobs@h${String(i).padStart(2, "0")}`), incomplete: null } }],
  ]) {
    const f = lookupFleet(opts);
    try {
      assert.equal((await f.reader.jobStatus("gh-none")).found, null, what);
    } finally {
      await f.reader.dispose();
    }
  }
});

test("a job waiting on a host queue the registry no longer names keeps its run page, never the run-not-found page (#737)", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const { reader } = lookupFleet({ held: { "pi-jobs@gone": { "gh-wait": "waiting" } }, scan: { names: ["pi-jobs@gone"], incomplete: null } });
  try {
    const data = await loadPageData("run", { id: "gh-wait" }, { fleet: reader }, { role: "operator" });
    const got = await renderPage("run", { query: { id: "gh-wait" }, session: { name: "ops", role: "operator" }, data, readOnly: false, theme: null });
    assert.ok(String(got.html).includes('<body data-page="run"'));
    assert.ok(!String(got.html).includes("No run with this id"), "a stopped host's queue holds it");
    assert.match(String(got.html), /This job is queued and has not started yet/);
    // And an id no place holds, with every place read, is the run-not-found page.
    const none = await loadPageData("run", { id: "gh-none" }, { fleet: reader }, { role: "operator" });
    assert.match(String((await renderPage("run", { query: { id: "gh-none" }, session: { name: "ops", role: "operator" }, data: none, readOnly: false, theme: null })).html), /No run with this id/);
  } finally {
    await reader.dispose();
  }
});

test("createFleetReader: a page's planner checks share one queue discovery and one registry read, and the discovery is kept for its window (#737)", async () => {
  const counts = {};
  const held = { "pi-jobs@gone": Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`gh-p${i}`, "completed"])) };
  const { reader } = lookupFleet({ held, counts, scan: { names: ["pi-jobs@gone"], incomplete: null } });
  try {
    const ids = Array.from({ length: 20 }, (_, i) => `gh-p${i}`);
    const got = await Promise.all(ids.map((id) => reader.parkedAnswerCheck(id)));
    assert.equal(got.length, 20);
    assert.deepEqual([counts.scan, counts.registry], [1, 1], "twenty rows, one discovery and one registry read");
    await Promise.all(ids.map((id) => reader.parkedAnswerCheck(id)));
    assert.deepEqual([counts.scan, counts.registry], [1, 2], "the next load reads the registry again and reuses the discovery");
  } finally {
    await reader.dispose();
  }
});

test("a job on a queue made after the kept discovery is found, never called absent: a miss is asked again over a scan started after the question (#737)", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const { runDocument } = await import("../src/console/run-api.mjs");
  const clock = { now: AT };
  const counts = {};
  const held = { "pi-jobs": {} };
  let hosts = [];
  const { reader } = lookupFleet({ held, counts, hosts: () => hosts, scan: () => ({ names: Object.keys(held).filter((n) => n !== "pi-jobs"), incomplete: null }), now: () => clock.now });
  const page = async (id) => {
    const data = await loadPageData("run", { id }, { fleet: reader, now: clock.now }, { role: "operator", readOnly: false });
    return renderPage("run", { query: { id }, session: { name: "ops", role: "operator" }, data, readOnly: false, theme: null });
  };
  try {
    // The console reads the fleet once: the discovery is taken before host h9 exists.
    assert.equal((await reader.jobStatus("gh-other")).found, false, "the first scan was made for this question: an absence");
    assert.equal(counts.scan, 1);
    // Ten seconds on, h9 starts and a job is queued on its own queue; ten more and it stops, its registry row gone at
    // once, its queue and the job kept. The discovery is still inside its window.
    clock.now = AT + 10_000;
    hosts = [{ name: "h9", routes: true }];
    held["pi-jobs@h9"] = { "gh-local-1": "waiting" };
    assert.equal((await reader.jobStatus("gh-local-1")).found, true, "the registry names h9's queue");
    clock.now = AT + 20_000;
    hosts = [];
    const after = await reader.jobStatus("gh-local-1");
    assert.deepEqual([after.found, after.state], [true, "waiting"], "the miss over the kept set was asked again over a new scan");
    assert.equal(counts.scan, 2);
    const got = await page("gh-local-1");
    assert.equal(got.status, 200, "a queued job's page");
    assert.match(String(got.html), /This job is queued and has not started yet/);
    assert.equal((await runDocument(reader, "gh-local-1")).doc?.state, "queued", "and /api/run");
    const check = await reader.parkedAnswerCheck("gh-local-1");
    assert.ok(!check.unreachable && !/no longer holds/.test(check.refusal ?? ""), JSON.stringify(check));
    assert.equal(counts.scan, 2, "a hit over the kept set scans nothing");
    // Hours later, with nobody watching, a host takes a local job onto its queue and stops: the first load finds it.
    clock.now = AT + 3 * 60 * MIN;
    held["pi-jobs@night1"] = { "gh-night-1": "waiting" };
    assert.equal((await runDocument(reader, "gh-night-1")).doc?.state, "queued", "the first /api/run after the idle hours");
    const night = await reader.rerunCheck("gh-night-1", { jobId: "gh-night-1", kind: "local", endedAt: iso(clock.now - MIN) });
    assert.ok(!night.unreachable, "and the planner checks read the job");
    assert.equal((await page("gh-night-1")).status, 200);
    // An id no queue holds is an absence only from a scan made after the question; questions that overlap share it.
    const before = counts.scan;
    const many = await Promise.all(["gh-n1", "gh-n2", "gh-n3"].map((id) => reader.jobStatus(id)));
    assert.deepEqual(many.map((s) => s.found), [false, false, false]);
    assert.equal(counts.scan, before + 1, "one scan for the three misses");
    assert.equal((await reader.parkedAnswerCheck("gh-n1")).refusal?.includes("no longer holds"), true, "the planner check's absence, from that scan's set");
    // A caller that does not need an absence is answered not whole, and nothing is scanned for it.
    const quiet = counts.scan;
    assert.equal((await reader.jobStatus("gh-n1", { tellAbsent: false })).found, null);
    assert.equal(counts.scan, quiet);
  } finally {
    await reader.dispose();
  }
});

test("a run page's live loop scans nothing: past the checks' 15 s window, its loads of an ended run whose job the queue no longer holds keep what the page's request was told (#737)", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const counts = {};
  const clock = { now: AT };
  const { reader, logsDir } = lookupFleet({ counts, now: () => clock.now });
  writeFileSync(join(logsDir, "gh-old.json"), JSON.stringify({ jobId: "gh-old", kind: "github", target: "acme/web#1", outcome: "completed", reason: null, startedAt: iso(AT - 10 * MIN), endedAt: iso(AT - 5 * MIN) }));
  const load = (who) => loadPageData("run", { id: "gh-old" }, { fleet: reader, now: clock.now }, { role: "operator", ...who });
  try {
    await reader.jobStatus("gh-warm");
    const before = counts.scan;
    const first = await load({});
    assert.equal(first.run.record?.jobId, "gh-old");
    assert.equal(first.chat.found, null, "a run with a record asks its chat lookup for no absence");
    assert.match(first.rerunCheck?.refusal ?? "", /no longer holds/, "the re-run check's absence");
    assert.equal(counts.scan, before + 1, "the request's one scan, made after its question");
    const after = counts.scan;
    for (let i = 1; i <= 20; i += 1) {
      clock.now = AT + i * 2000;
      const got = await load({ live: true });
      assert.deepEqual(got.rerunCheck, first.rerunCheck, `${i * 2} s: what the request was told`);
    }
    assert.equal(counts.scan, after, "no live load scanned the keyspace");
  } finally {
    await reader.dispose();
  }
});

test("a scan already running when the question is asked is no answer to it: the lookup waits for that scan, then asks one of its own (#737)", async () => {
  const clock = { now: AT };
  const held = { "pi-jobs": { "gh-hit": "waiting" } };
  // Each scan names the queues there when it STARTS, as a SCAN can miss a key made after it began; one is held open
  // until the test lets it settle.
  let gate = null;
  const { reader } = lookupFleet({
    held,
    now: () => clock.now,
    scan: async () => {
      const names = Object.keys(held).filter((n) => n !== "pi-jobs");
      if (gate !== null) await gate.promise;
      return { names, incomplete: null };
    },
  });
  try {
    assert.equal((await reader.jobStatus("gh-none")).found, false);
    // Past the discovery's window a hit starts the next scan, which runs on while it answers.
    clock.now = AT + WAITING_DISCOVERY_TTL_MS + 1;
    let release;
    gate = { promise: new Promise((r) => (release = r)) };
    assert.equal((await reader.jobStatus("gh-hit")).found, true);
    gate = null;
    // A host's queue and its job appear while that scan runs; then the question is asked.
    held["pi-jobs@late"] = { "gh-late": "waiting" };
    const asked = reader.jobStatus("gh-late");
    // That scan settles only after the question has met it in flight.
    setTimeout(release, 50);
    assert.equal((await asked).found, true, "the scan that began before the queue did not see it; the lookup's own did");
  } finally {
    await reader.dispose();
  }
});

test("a by-id lookup whose new scan does not settle in time, or does not read the whole keyspace, is no absence (#737)", { timeout: 30_000 }, async () => {
  // The first scan answers; the next ones never do, as a SCAN past its bound. The reader's bounds keep no process alive
  // (their timers are unref'd), so this one is held open for longer than they take, and no longer: a lookup that waits
  // past them fails the test rather than hang it.
  let hang = false;
  const { reader } = lookupFleet({ scan: () => (hang ? new Promise(() => {}) : { names: [], incomplete: null }) });
  const alive = setTimeout(() => {}, 20_000);
  try {
    assert.equal((await reader.jobStatus("gh-none")).found, false);
    hang = true;
    const [status, check] = await Promise.all([reader.jobStatus("gh-late"), reader.parkedAnswerCheck("gh-late")]);
    assert.equal(status.found, null, "a set read before the question, with no newer one in time");
    assert.equal(check.unreachable, true, "a planner check over it is unreadable, not a refusal");
  } finally {
    clearTimeout(alive);
    await reader.dispose();
  }
  // A scan that did not read the whole keyspace, or failed, leaves every lookup not whole, the first and the next.
  for (const scan of [() => ({ names: [], incomplete: "the queue scan ran out of time" }), () => { throw new Error("ECONNRESET"); }]) {
    const f = lookupFleet({ scan });
    try {
      assert.equal((await f.reader.jobStatus("gh-none")).found, null, "the lookup the scan settled for");
      assert.equal((await f.reader.jobStatus("gh-none")).found, null, "and the next one");
      assert.equal((await f.reader.parkedAnswerCheck("gh-none")).unreachable, true, "a planner check too");
    } finally {
      await f.reader.dispose();
    }
  }
});

test("the by-id lookup never cuts the registry's queues, and asks the scanned ones beside them, in name order, only while the two fit in WAITING_QUEUES_MAX, the shared queue counted; a set cut there is no absence (#737)", async () => {
  const hostName = (i) => `h${String(i).padStart(2, "0")}`;
  const readerOf = ({ hosts = [], scanned, refuse = null }) => {
    const asked = new Set();
    const logsDir = tempDir("pd-737-lookup-bound-");
    const queue = (_c, opts) => {
      const name = opts?.name ?? "pi-jobs";
      if (name === refuse) throw new Error("bad queue name");
      return { name, async getJob(id) { asked.add(name); return name === "pi-jobs@h00" && id === "gh-w" ? { id, name: "github", data: { kind: "github" }, opts: {}, async getState() { return "waiting"; } } : null; }, async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async getJobs() { return []; }, async close() {} };
    };
    const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => ({ names: scanned, incomplete: null }), nowFn: () => AT });
    return { reader, asked };
  };
  // Exactly WAITING_QUEUES_MAX queues only the scan names, in reverse name order, beside the shared queue: one more than
  // the bound in all.
  const scanned = Array.from({ length: WAITING_QUEUES_MAX }, (_, i) => `pi-jobs@${hostName(i)}`);
  const cut = readerOf({ scanned: [...scanned].reverse() });
  try {
    const none = await cut.reader.jobStatus("gh-none");
    assert.equal(cut.asked.size, WAITING_QUEUES_MAX, `asked ${cut.asked.size} queues`);
    assert.ok(cut.asked.has("pi-jobs"), "the registry's shared queue is never the one cut");
    assert.equal(none.found, null, "a set cut at the bound is no proof the job is in no queue");
    assert.equal((await cut.reader.jobStatus("gh-w")).found, true, "the first scanned queue by name is among those asked");
  } finally {
    await cut.reader.dispose();
  }
  // A registry that names more live hosts than the bound has every one of its queues asked, and no scanned one beside.
  const hosts = Array.from({ length: WAITING_QUEUES_MAX + 4 }, (_, i) => ({ name: hostName(i), routes: true }));
  const wide = readerOf({ hosts, scanned: ["pi-jobs@zz-gone"] });
  try {
    assert.equal((await wide.reader.jobStatus("gh-none")).found, null, "the scanned queue left out: no absence");
    assert.equal(wide.asked.size, WAITING_QUEUES_MAX + 5, "the shared queue and every live host's");
    assert.ok(!wide.asked.has("pi-jobs@zz-gone"));
  } finally {
    await wide.reader.dispose();
  }
  // A lookup whose set could not be built (a queue name the client refuses) is no absence either.
  const unbuilt = readerOf({ scanned: ["pi-jobs@bad"], refuse: "pi-jobs@bad" });
  try {
    assert.equal((await unbuilt.reader.jobStatus("gh-none")).found, null);
  } finally {
    await unbuilt.reader.dispose();
  }
});

test("the scanned queues that exactly fill the by-id lookup's room beside the shared queue make a whole set, so a job none holds is absent; one more is a cut set, no absence (#737)", async () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `pi-jobs@h${String(i).padStart(2, "0")}`);
  for (const [n, want] of [[WAITING_QUEUES_MAX - 1, false], [WAITING_QUEUES_MAX, null]]) {
    const { reader } = lookupFleet({ scan: { names: names(n), incomplete: null } });
    try {
      assert.equal((await reader.jobStatus("gh-none")).found, want, `${n} scanned beside the shared queue`);
    } finally {
      await reader.dispose();
    }
  }
});

test("a miss over the kept discovery waits for a new scan that takes most of its own budget, and answers from it: a job on a queue made since is found, and an id no queue holds is absent (#737)", { timeout: 30_000 }, async () => {
  const clock = { now: AT };
  const held = {};
  let names = [];
  let slowMs = 0;
  const { reader } = lookupFleet({
    held,
    now: () => clock.now,
    scan: async () => {
      const got = [...names];
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      return { names: got, incomplete: null };
    },
  });
  try {
    assert.equal((await reader.jobStatus("gh-warm")).found, false);
    // Inside the kept set's window, a host queue and its job appear, and the next scan takes 1.2 s of its 2 s.
    clock.now = AT + WAITING_DISCOVERY_TTL_MS / 2;
    names = ["pi-jobs@late"];
    held["pi-jobs@late"] = { "gh-late": "waiting" };
    slowMs = 1200;
    assert.equal((await reader.jobStatus("gh-late")).found, true, "the slow scan's set finds the job");
    assert.equal((await reader.jobStatus("gh-none")).found, false, "and calls an id none holds absent");
  } finally {
    await reader.dispose();
  }
});

test("a parked answer check and a re-run check over a queue whose job read never answers are unreadable within twice the read timeout, never held open with the load (#737)", { timeout: 20_000 }, async () => {
  const logsDir = tempDir("pd-737-retained-bound-");
  const queue = (_c, opts) => ({ name: opts?.name ?? "pi-jobs", getJob: () => new Promise(() => {}), async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async getJobs() { return []; }, async close() {} });
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), nowFn: () => AT });
  // The reader's bounds keep no process alive (their timers are unref'd), so this one holds it open while they run.
  const alive = setInterval(() => {}, 1000);
  try {
    const t0 = Date.now();
    const timed = (check) => Promise.race([check.then((got) => ({ got, ms: Date.now() - t0 })), new Promise((r) => setTimeout(() => r({ got: "held open", ms: Date.now() - t0 }), 8_000))]);
    const got = await Promise.all([timed(reader.parkedAnswerCheck("gh-1")), timed(reader.rerunCheck("gh-1", { jobId: "gh-1", kind: "github" }))]);
    for (const { got: answer, ms } of got) {
      assert.deepEqual(answer, { unreachable: true });
      assert.ok(ms < 5_000, `${ms} ms`);
    }
  } finally {
    clearInterval(alive);
    await reader.dispose();
  }
});

test("a live load's lookup scans nothing and makes no absence of its own: it keeps the absence a request was told, for at most LOOKUP_TOLD_MAX ids, and finds a job a queue in its set holds (#737)", async () => {
  const clock = { now: AT };
  const counts = {};
  const held = { "pi-jobs": {} };
  const { reader } = lookupFleet({ held, counts, now: () => clock.now, scan: () => ({ names: Object.keys(held).filter((n) => n !== "pi-jobs"), incomplete: null }) });
  const live = { live: true };
  try {
    assert.equal((await reader.jobStatus("gh-a")).found, false, "a request's absence, from a scan made for it");
    const scans = counts.scan;
    clock.now = AT + 10_000;
    assert.equal((await reader.jobStatus("gh-a", live)).found, false, "a live lookup keeps what the request was told");
    assert.match((await reader.parkedAnswerCheck("gh-a", live)).refusal ?? "", /no longer holds/, "so does a planner check");
    assert.equal((await reader.jobStatus("gh-b", live)).found, null, "an id no request was told of is no absence");
    assert.equal((await reader.parkedAnswerCheck("gh-b", live)).unreachable, true, "a planner check over it is unreadable, not a refusal");
    // A job on a queue made after the kept discovery: a live lookup cannot see it and calls it no absence; a request's
    // lookup scans for it and finds it, and the live loop then finds it in the set that scan settled into.
    held["pi-jobs@late"] = { "gh-late": "waiting" };
    assert.equal((await reader.jobStatus("gh-late", live)).found, null);
    assert.equal(counts.scan, scans, "no live lookup scanned");
    assert.equal((await reader.jobStatus("gh-late", reader.lookupQuestion())).found, true, "a request's lookup scans after its question");
    assert.equal(counts.scan, scans + 1);
    assert.equal((await reader.jobStatus("gh-late", live)).found, true, "and the live lookup finds it there");
    // A job a request found is no longer told absent: once it is gone, a live lookup says only that it did not see it.
    held["pi-jobs@late"]["gh-a"] = "waiting";
    assert.equal((await reader.jobStatus("gh-a")).found, true);
    delete held["pi-jobs@late"]["gh-a"];
    assert.equal((await reader.jobStatus("gh-a", live)).found, null);
    // Made-up ids push out only the oldest: LOOKUP_TOLD_MAX absences after gh-n0's, gh-n0 is no longer kept.
    const ids = Array.from({ length: LOOKUP_TOLD_MAX + 1 }, (_, i) => `gh-n${i}`);
    for (const id of ids) assert.equal((await reader.jobStatus(id)).found, false, id);
    assert.equal((await reader.jobStatus("gh-n0", live)).found, null, "the oldest absence is pushed out");
    assert.equal((await reader.jobStatus("gh-n1", live)).found, false, "the newest LOOKUP_TOLD_MAX are kept");
    assert.equal((await reader.jobStatus(ids.at(-1), live)).found, false);
  } finally {
    await reader.dispose();
  }
});

test("one request load of a parked run's page whose job is gone asks one question: its chat, answer and re-run lookups run together and wait for one keyspace scan in all (#737)", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const counts = {};
  let release = null;
  const { reader, logsDir } = lookupFleet({
    counts,
    scan: async () => {
      if (release !== null) await new Promise((r) => (release = r));
      return { names: [], incomplete: null };
    },
  });
  writeFileSync(join(logsDir, "gh-p.json"), JSON.stringify({ jobId: "gh-p", kind: "github", target: "acme/web#1", outcome: "completed", reason: "awaiting-input", startedAt: iso(AT - 10 * MIN), endedAt: iso(AT - 5 * MIN) }));
  // The load's two checks, seen as they start.
  const started = new Set();
  const fleet = {
    ...reader,
    parkedAnswerCheck: (...args) => (started.add("answer"), reader.parkedAnswerCheck(...args)),
    rerunCheck: (...args) => (started.add("rerun"), reader.rerunCheck(...args)),
  };
  const keep = setInterval(() => {}, 1000);
  try {
    await reader.jobStatus("gh-warm");
    const before = counts.scan;
    release = () => {};
    const loading = loadPageData("run", { id: "gh-p" }, { fleet, now: AT }, { role: "operator", readOnly: false });
    // The scan the load's first miss started is held open, and both checks start while it runs: they run together, not
    // one after the other.
    const until = Date.now() + 5_000;
    while ((counts.scan === before || started.size < 2) && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([counts.scan, [...started].sort()], [before + 1, ["answer", "rerun"]], "both checks started while the one scan ran");
    release();
    release = null;
    const data = await loading;
    assert.equal(data.chat?.mode, "reply");
    assert.match(data.chatAnswer?.refusal ?? "", /no longer holds/);
    assert.match(data.rerunCheck?.refusal ?? "", /no longer holds/);
    assert.equal(counts.scan, before + 1, "one scan for the load");
  } finally {
    clearInterval(keep);
    release?.();
    await reader.dispose();
  }
});

test("a page's live stream scans nothing for a job no queue holds: the hub's loads of a kept page, an id no place holds, a parked run's page and the Parked page keep what their request was told (#737)", async () => {
  const pages = await import("../src/console/pages.mjs");
  const { makeLiveHub } = await import("../src/console/live.mjs");
  const said = (d) => ({ found: d?.chat?.found, mode: d?.chat?.mode, rerun: d?.rerunCheck, answer: d?.chatAnswer, parked: d?.parkedChecks });
  const down = async () => { throw new Error("ECONNRESET"); };
  for (const [what, page, query, role, setup, redis] of [
    ["a kept page: no record, the live transcript unreadable", "run", { id: "gh-kept" }, "viewer", () => {}, { xlen: down }],
    ["an id no place holds", "run", { id: "gh-typo" }, "viewer", () => {}, {}],
    ["a parked run's page", "run", { id: "gh-park" }, "operator", (dir) => writeFileSync(join(dir, "gh-park.json"), JSON.stringify({ jobId: "gh-park", kind: "github", target: "acme/web#1", outcome: "completed", reason: "awaiting-input", startedAt: iso(AT - 10 * MIN), endedAt: iso(AT - 5 * MIN) })), {}],
    ["the Parked page", "parked", {}, "operator", (dir) => { for (let i = 0; i < 3; i += 1) writeFileSync(join(dir, `gh-pk${i}.json`), JSON.stringify({ jobId: `gh-pk${i}`, kind: "github", target: `acme/web#${i + 2}`, outcome: "completed", reason: "awaiting-input", startedAt: iso(AT - 10 * MIN), endedAt: iso(AT - (5 + i) * MIN) })); }, {}],
  ]) {
    const counts = {};
    const clock = { now: AT };
    const { reader, logsDir } = lookupFleet({ counts, now: () => clock.now, redis });
    setup(logsDir);
    const deps = { fleet: reader, env: {}, now: () => clock.now };
    let last = null;
    const hub = makeLiveHub({
      loadPageData: async (p, q, who) => (last = await pages.loadPageData(p, q, deps, who)),
      pagePanels: (p, ctx) => pages.pagePanels(p, ctx),
      queryKeyOf: (p, q) => pages.pageQueryString(p, q),
      dataQueryOf: (p, q) => pages.dataQueryOf(p, q),
      peekSession: (id) => ({ id }),
      readTokens: () => ({ file: { version: 1, generation: 0, tokens: [] } }),
      now: () => clock.now,
      timers: { setInterval: () => ({}), clearInterval: () => {} },
    });
    try {
      await reader.jobStatus("gh-warm");
      const before = counts.scan;
      const got = await pages.loadPageData(page, query, deps, { role, readOnly: false });
      assert.ok(counts.scan <= before + 1, `${what}: the request scans at most once`);
      const after = counts.scan;
      hub.subscribe({ res: { writableLength: 0, write: () => true, end() {}, destroy() {} }, sessionId: "s1", session: { name: "x", role }, page, query });
      for (let i = 0; i < 40; i += 1) {
        clock.now += 1000;
        await hub.tick();
      }
      assert.equal(counts.scan, after, `${what}: 40 s of live loads scanned nothing`);
      assert.ok(last !== null, what);
      const told = said(got);
      const kept = said(last);
      if (told.found !== null) assert.equal(kept.found, told.found, `${what}: the lookup's answer`);
      assert.deepEqual([kept.mode, kept.rerun, kept.answer, kept.parked], [told.mode, told.rerun, told.answer, told.parked], `${what}: the checks' answers`);
    } finally {
      hub.close();
      await reader.dispose();
    }
  }
});

test("createFleetReader: a switch preview reads at most 200 of the queues the switch flips and says how many it flips; the switch flips them all (#737)", async () => {
  const NOW = Date.UTC(2026, 9, 26, 12, 0);
  const redis = { on() {}, async get() { return null; }, async mget(...keys) { return keys.map(() => null); }, async smembers() { return []; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async exists() { return 0; }, async del() { return 1; }, disconnect() {} };
  const built = [];
  const flipped = [];
  const queue = (_c, opts) => {
    const name = opts?.name ?? "pi-jobs";
    built.push(name);
    return { name, async isPaused() { return name.endsWith("7"); }, async getJobCounts() { return { waiting: 1 }; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async pause() { flipped.push(name); }, async resume() { flipped.push(name); }, async close() {} };
  };
  const planted = Array.from({ length: 250 }, (_, i) => `pi-jobs@h${String(i).padStart(3, "0")}`);
  let scan = { names: planted, incomplete: null };
  const logsDir = tempDir("pd-737-switch-bound-");
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => scan, nowFn: () => NOW });
  try {
    assert.equal(SWITCH_PREVIEW_QUEUES_MAX, 200);
    const plain = await reader.snapshot();
    assert.deepEqual([Object.hasOwn(plain, "switchTotal"), Object.hasOwn(plain, "switchTruncated"), Object.hasOwn(plain, "switchIncomplete")], [false, false, false], "a snapshot that did not ask says nothing of the switch");
    const before = built.length;
    const s = await reader.snapshot({ switchQueues: true });
    assert.equal(s.queueCounts.length, SWITCH_PREVIEW_QUEUES_MAX);
    assert.deepEqual(s.queueCounts.slice(0, 2).map((q) => q.queue), ["pi-jobs", "pi-jobs@h000"], "in the switch's order: the shared queue first");
    assert.deepEqual([s.switchTotal, s.switchTruncated, s.switchIncomplete], [251, true, null]);
    assert.equal(s.queue.queues, SWITCH_PREVIEW_QUEUES_MAX);
    assert.ok(built.length - before <= SWITCH_PREVIEW_QUEUES_MAX, `no queue (no connection) is built for a name the preview does not read: ${built.length - before}`);
    // A one-queue preview of a queue past the bound still reads it.
    const one = await reader.snapshot({ switchQueues: true, queue: "pi-jobs@h249" });
    assert.equal(one.queueCounts.length, SWITCH_PREVIEW_QUEUES_MAX + 1);
    assert.equal(one.queueCounts.at(-1).queue, "pi-jobs@h249");
    assert.equal((await reader.snapshot({ switchQueues: true, queue: "pi-jobs@nowhere" })).queueCounts.length, SWITCH_PREVIEW_QUEUES_MAX, "a name the switch does not flip is not read");
    // The switch itself flips every queue.
    await reader.pause();
    assert.equal(new Set(flipped).size, 251);
    // A set that fits is whole; a scan that did not finish says so, and so does one that failed.
    scan = { names: planted.slice(0, 3), incomplete: null };
    const small = await reader.snapshot({ switchQueues: true });
    assert.deepEqual([small.queueCounts.length, small.switchTotal, small.switchTruncated, small.switchIncomplete], [4, 4, false, null]);
    scan = { names: planted.slice(0, 3), incomplete: "the queue scan ran out of time" };
    assert.equal((await reader.snapshot({ switchQueues: true })).switchIncomplete, SWITCH_SCAN_INCOMPLETE);
    scan = { names: [], incomplete: "ECONNRESET" };
    assert.equal((await reader.snapshot({ switchQueues: true })).switchIncomplete, SWITCH_SCAN_INCOMPLETE, "no error text: the fixed clause");
    scan = planted.slice(0, 2);
    assert.equal((await reader.snapshot({ switchQueues: true })).switchIncomplete, null, "a bare list (the kill switch's seam shape) reads as whole");
  } finally {
    await reader.dispose();
  }
});

test("a later unclear lookup clears a remembered absence, and live loads never start the discovery rescan (#747)", async () => {
  let incomplete = false;
  let at = AT;
  const counts = {};
  const { reader } = lookupFleet({ counts, now: () => at, scan: () => ({ names: [], incomplete: incomplete ? "scan incomplete" : null }) });
  try {
    assert.equal((await reader.jobStatus("gh-unclear")).found, false);
    incomplete = true;
    assert.equal((await reader.jobStatus("gh-unclear")).found, null);
    const scanned = counts.scan;
    at += WAITING_DISCOVERY_TTL_MS * 3;
    assert.equal((await reader.jobStatus("gh-unclear", { live: true })).found, null, "an old absence is not retained after an unclear request");
    await reader.parkedAnswerCheck("gh-unclear", { live: true });
    assert.equal(counts.scan, scanned, "neither live lookup starts even an expired discovery window's rescan");
  } finally {
    await reader.dispose();
  }
});

test("the live run facts allowlist excludes queue payload text, validates fields and resolves the host's venue (#747)", async () => {
  const logsDir = tempDir("pd-747-live-facts-");
  const settingsFile = join(logsDir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ maxTurns: 40, provider: "anthropic", model: "claude" }));
  const projectsPath = join(logsDir, "projects.json");
  writeFileSync(projectsPath, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  const job = { id: "gh-live", name: "github", queueName: "pi-jobs@mini", data: { kind: "github", repo: "acme/web", target: { number: 8 }, flow: "fix", body: "PRIVATE COMMENT", maxTurns: 12, provider: "bad provider", extra: { text: "PRIVATE COMMENT" } }, timestamp: AT - 2000, processedOn: AT, opts: {} };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, settingsFile, projectsPath }, {
    makeQueueFn: () => ({ name: "pi-jobs", getJob: async () => job, close: async () => {} }), parseConnectionFn: () => ({}),
    redisFn: () => emptyRedis(), readLiveHostsFn: async () => ({ hosts: [{ name: "mini", jobs: [{ id: "gh-live", p: null, at: AT }], backends: "blessed=podman,local" }] }), discoverHostQueuesFn: async () => [], nowFn: () => AT,
  });
  try {
    const facts = await reader.runLiveFacts("gh-live", { live: true });
    assert.equal(facts.target, "acme/web#8");
    assert.equal(facts.backend, "podman");
    assert.equal(facts.maxTurns, 12);
    assert.equal(facts.provider, null, "invalid job override does not silently use the overlay");
    assert.equal(facts.model, "claude");
    assert.equal(facts.project, "shop");
    assert.equal(facts.host, "mini");
    assert.equal(facts.startedAt, new Date(AT).toISOString());
    assert.equal(facts.queuedAt, new Date(AT - 2000).toISOString());
    assert.equal(facts.queue, "pi-jobs@mini");
    assert.deepEqual(Object.keys(facts).sort(), ["target", "kind", "flow", "backend", "provider", "model", "maxTurns", "project", "host", "queue", "queuedAt", "startedAt"].sort());
    assert.ok(!JSON.stringify(facts).includes("PRIVATE"));
    delete job.data.maxTurns;
    assert.equal((await reader.runLiveFacts("gh-live", { live: true })).maxTurns, 40);
  } finally {
    await reader.dispose();
  }
});

test("run context reads only the matching trigger's attribution and bounded safe dollar holds (#747)", async () => {
  const logsDir = tempDir("pd-747-context-");
  const triggersPath = join(logsDir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "/fix" }, run: { flow: "fix", resume: true, recover: true, mcp: ["forge", "bad name"], instructions: "PRIVATE INSTRUCTIONS", secrets: { TOKEN: "PRIVATE REFERENCE" } } }] }));
  const asked = [];
  const { runBudgetKeyFor } = await import("@edgehero/pi-dispatch/run-budget-ledger");
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath }, {
    makeQueueFn: () => ({ name: "pi-jobs", close: async () => {} }), parseConnectionFn: () => ({}), readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT,
    redisFn: () => ({ ...emptyRedis(), hgetall: async (key) => (asked.push(key), { seq: "2", slot: "held", s1: "settled", h1: JSON.stringify({ amountMicros: 50, keys: ["PRIVATE KEY"] }), s2: "held", h2: JSON.stringify({ amountMicros: 70 }), s3: "PRIVATE TEXT", h3: JSON.stringify({ amountMicros: 90 }) }) }),
  });
  try {
    assert.deepEqual(await reader.runTrigger(0, "comment"), { index: 0, type: "comment", phrase: "/fix", label: null, pattern: null, mcp: ["forge"], resume: true, recover: true });
    assert.equal(await reader.runTrigger(0, "cron"), null, "a changed row's kind cannot be attributed to an older run");
    assert.equal(await reader.runTrigger(-1, "comment"), null);
    const holds = await reader.runHolds("gh-base.r1", { recoveryOf: "gh-base" });
    assert.deepEqual(holds, [{ seq: 1, state: "settled", amountMicros: 50 }, { seq: 2, state: "held", amountMicros: 70 }]);
    assert.deepEqual(asked, [runBudgetKeyFor("gh-base")]);
    assert.ok(!JSON.stringify(holds).includes("PRIVATE"));
  } finally {
    await reader.dispose();
  }
});

test("live watch facts report a validated watch rule and discard private finding payloads", async () => {
  const logsDir = tempDir("pd-watch-live-facts-");
  const job = { id: "watch-job", name: "watch", data: { kind: "watch", watch: { ruleId: "shop-5xx", findingId: "f1" }, samples: ["PRIVATE WATCH SAMPLE"] }, timestamp: AT, opts: {} };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir }, {
    makeQueueFn: () => ({ name: "pi-jobs", getJob: async () => job, close: async () => {} }), parseConnectionFn: () => ({}), redisFn: () => emptyRedis(),
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT,
  });
  try {
    const facts = await reader.runLiveFacts("watch-job", { live: true });
    assert.equal(facts.kind, "watch");
    assert.equal(facts.target, "watch:shop-5xx");
    assert.ok(!JSON.stringify(facts).includes("PRIVATE"));
    job.data.watch.ruleId = "bad rule";
    const invalid = await reader.runLiveFacts("watch-job", { live: true });
    assert.equal(invalid.kind, null);
    assert.equal(invalid.target, null);
  } finally { await reader.dispose(); }
});
