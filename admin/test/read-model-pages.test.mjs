import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { consumersPublished, emptyRedis, quietQueue } from "./helpers/fleet-reader-fakes.mjs";
import { queueSwitchErrored, queueSwitchUnconfirmed } from "../src/read-model.mjs";
import { LOOKUP_TOLD_MAX, REFUSALS_TOP, RUN_FILE_UNREADABLE, RUN_MIRROR_UNREAD, RUNS_WINDOW_PROJECTS_MAX, RUNS_WINDOW_VALUES_MAX, SWITCH_PREVIEW_QUEUES_MAX, SWITCH_SCAN_INCOMPLETE, UNREAD_HOSTS_MAX, WAITING_DISCOVERY_TTL_MS, WAITING_QUEUES_MAX, createFleetReader, fleetQueuesOn, listRunsMerged, readHeldJobs, readHosts, readQueueState, readSchedulers, replyCodeOf, forgeLinkOf, makeLocalRunIndex, readFolderSkills, readParkedRuns, readRunById, readRunsPage, refusalsIn, revParseHead, secretProfileNames } from "../src/read-model.mjs";
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
  // A record's cron id at any length (every release before issue #761 took one); the filter's own value rule bounds a list.
  assert.equal(triggerValueOf(rec(`repeat:${"n".repeat(500)}:1760443200000`, AT, { triggerIndex: null })), "n".repeat(500));
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

// --- a host row Valkey answers with an error (issue #1036) -------------------------------------------------------------

/** A queue that answers every read with nothing and records, by queue name, who was asked for its active jobs. */
const askedQueue = (asked) => (_c, opts) => {
  const name = opts?.name ?? "pi-jobs";
  return { name, async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { asked.push(name); return []; }, async getFailed() { return []; }, async close() {} };
};
/**
 * A registered host's row under the client's prefix, as the beat of a worker that runs nothing writes it: its
 * consumers' health with it (`consumersPublished`), so a reader of the row asks Valkey how their queues stand, as it
 * does for every real worker's row.
 */
const seedHost = async (redis, name) => {
  await redis.sadd("host:live", name);
  await redis.hset(`host:h:${name}`, { name, routes: "true", beatAt: String(AT), jobs: "[]", ...consumersPublished(AT - 60 * MIN) });
};
/** The index lists `name` and its key is a string: Valkey answers the row's read with WRONGTYPE. */
const breakHost = async (redis, name) => {
  await redis.sadd("host:live", name);
  await redis.del(`host:h:${name}`);
  await redis.set(`host:h:${name}`, "not a hash");
};
const ROW_WORDS = "1 of 2 host rows not read, of which Valkey answered with an error: hostw (WRONGTYPE)";

test("createFleetReader on a real Valkey: a host whose row is not a hash is named in queue.unreadHosts with WRONGTYPE, the other hosts are read, and its queue's lists are floors until its row was read once (#1036, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { stateOf } = await import("../src/console/live.mjs");
  const { hostsForAgent } = await import("../src/tool-reads.mjs");
  const redis = await prefixed("row1036");
  const logsDir = tempDir("pd-1036-row-");
  const asked = [];
  try {
    await seedHost(redis, "hosta");
    await breakHost(redis, "hostw");
    // The real registry read, through the reader's own client; the queues are stand-ins that say who was asked.
    const reader = createFleetReader({ valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json") }, { makeQueueFn: askedQueue(asked), parseConnectionFn: () => ({}), redisFn: () => redis, discoverHostQueuesFn: async () => ({ names: [] }), nowFn: () => AT });
    const snap = await reader.snapshot();
    assert.deepEqual(snap.queue.unreadHosts, [{ name: "hostw", error: "WRONGTYPE" }]);
    assert.deepEqual([snap.queue.registryReadInPart, snap.queue.fleetError, snap.queue.fleetDegraded], [true, null, ROW_WORDS]);
    assert.deepEqual(snap.hostBudgets.map((h) => [h.name, h.notRead === true]), [["hosta", false]], "the row that answered is this read's; no row is made up for the other");
    assert.equal(snap.hostsReadAt, AT);
    // hostw was never read here, so its queue is in no set: what is read queue by queue is a floor.
    assert.deepEqual([asked.sort(), snap.schedulersReadInPart, snap.activeUnreachable], [["pi-jobs", "pi-jobs@hosta"], true, true]);
    assert.equal(await redis.sismember("host:live", "hostw"), 1, "never pruned, by a reader that prunes");
    assert.ok(!JSON.stringify(snap.queue).includes("Operation against"), "the reply's code alone");
    // The state API and `dispatch_hosts` over that snapshot.
    const state = stateOf(snap, "viewer", { now: AT });
    assert.deepEqual([state.fleetDegraded, state.registryReadInPart, state.fleetError, state.unreadHosts, state.unreadHostsMore, state.hosts.map((h) => h.name)], [true, true, null, [{ name: "hostw", error: "WRONGTYPE" }], 0, ["hosta"]]);
    const hosts = hostsForAgent(snap);
    assert.deepEqual([hosts.unavailable, hosts.readInPart, hosts.unreadHosts, hosts.hostErrors, hosts.hosts.map((h) => h.name)], [false, true, ["hostw"], { hostw: "WRONGTYPE" }, ["hosta"]]);

    // Its key repaired: read whole, nothing named, the lists whole.
    await redis.del("host:h:hostw");
    await seedHost(redis, "hostw");
    const whole = await reader.snapshot();
    assert.deepEqual([whole.queue.unreadHosts, whole.queue.registryReadInPart, whole.queue.fleetDegraded, whole.schedulersReadInPart, whole.activeUnreachable], [[], undefined, null, false, false]);
    assert.deepEqual(Object.keys(hostsForAgent(whole)).sort(), ["hosts", "readAt", "unavailable"], "a whole read has none of the part read's keys");

    // Broken again after it was read once: its last row is kept, so its queue is still asked and the lists are whole.
    await breakHost(redis, "hostw");
    asked.length = 0;
    const kept = await reader.snapshot();
    assert.deepEqual(kept.queue.unreadHosts, [{ name: "hostw", error: "WRONGTYPE" }]);
    assert.deepEqual(kept.hostBudgets.map((h) => [h.name, h.notRead === true]), [["hosta", false], ["hostw", true]]);
    assert.deepEqual([asked.includes("pi-jobs@hostw"), kept.schedulersReadInPart, kept.activeUnreachable], [true, false, false]);

    // The index itself a string: the registry could not be read, and the code says Valkey answered that with an error.
    await redis.del("host:live");
    await redis.set("host:live", "not a set");
    const index = await reader.snapshot();
    assert.deepEqual([index.queue.fleetError, index.queue.unreadHosts, index.queue.registryReadInPart, Boolean(index.queue.fleetDegraded)], ["WRONGTYPE", [], undefined, true]);
    assert.deepEqual([stateOf(index, "viewer", { now: AT }).fleetError, hostsForAgent(index).unavailable], ["WRONGTYPE", true]);
  } finally {
    await redis.cleanup();
  }
});

// Issue #1036: the reader wrote the marks of a registry read in part on both sides of an await, and a snapshot read
// them off the reader at its end. It took rows that publish `consumers`, as every worker's does: that await is the
// read of their queues, a round trip, and with rows that publish none it never yielded.
test("createFleetReader on a real Valkey: two snapshots that overlap each say what their own registry read saw, the host not read named and the lists floors, while the other is mid-read (#1036, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { parseConsumerHealth } = await import("../../worker/src/consumer-health.mjs");
  const redis = await prefixed("overlap1036");
  const logsDir = tempDir("pd-1036-overlap-");
  // Two gates, each open or held: the consumers' queues read (the reader's one EVAL), and a queue's paused read.
  const gate = () => {
    const g = { open: true, left: 0, release: null, held: Promise.resolve(), arrived: null, onArrive: null };
    // Closed, it holds the next `only` arrivals (every one by default) and lets the ones after them pass.
    g.close = ({ only = Infinity } = {}) => {
      g.open = false;
      g.left = only;
      g.held = new Promise((resolve) => { g.release = resolve; });
      g.arrived = new Promise((resolve) => { g.onArrive = resolve; });
    };
    g.pass = async () => {
      if (!g.open && g.left > 0) {
        g.left -= 1;
        g.onArrive();
        await g.held;
      }
    };
    g.reopen = () => {
      g.open = true;
      g.release();
    };
    return g;
  };
  const evalGate = gate();
  const queueGate = gate();
  // The reader's own client, which it ends when it is disposed: a duplicate of the prefixed one, so every key is this test's.
  const client = new Proxy(redis.duplicate(), { get: (target, key) => (key === "eval" ? async (...args) => { await evalGate.pass(); return target.eval(...args); } : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const make = askedQueue([]);
  const reader = createFleetReader({ valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json") }, {
    makeQueueFn: (c, opts) => {
      const q = make(c, opts);
      return { ...q, async isPaused() { await queueGate.pass(); return false; } };
    },
    parseConnectionFn: () => ({}), redisFn: () => client, discoverHostQueuesFn: async () => ({ names: [] }), nowFn: () => AT,
  });
  const marksOf = (s) => [s.queue.registryReadInPart, s.queue.unreadHosts, s.activeUnreachable, s.schedulersReadInPart, s.hostBudgets.map((h) => h.name)];
  const PART = [true, [{ name: "hostw", error: "WRONGTYPE" }], true, true, ["hosta"]];
  // Every snapshot started here, settled before the reader is disposed whatever an assertion does.
  const started = [];
  const snapshot = () => {
    const s = reader.snapshot();
    started.push(s.catch(() => {}));
    return s;
  };
  try {
    await seedHost(redis, "hosta");
    await breakHost(redis, "hostw");
    assert.notEqual(parseConsumerHealth(await redis.hgetall("host:h:hosta")), null, "the row publishes its consumers as a worker does");
    // The first snapshot reads the registry in part and waits on its queues.
    queueGate.close();
    const first = snapshot();
    await queueGate.arrived;
    // The second reads the registry too and is held in the read of the consumers' queues, its own marks half made.
    evalGate.close();
    const second = snapshot();
    await evalGate.arrived;
    // The first is assembled now, while the second is mid-read: it says what ITS read saw.
    queueGate.reopen();
    assert.deepEqual(marksOf(await first), PART, "the host that was not read is named, and the lists it could be in are floors");
    evalGate.reopen();
    assert.deepEqual(marksOf(await second), PART);

    // The other direction: a read that is WHOLE, in flight beside one in part, vouches for neither's marks but its own.
    queueGate.close();
    const part = snapshot();
    await queueGate.arrived;
    await redis.del("host:h:hostw");
    await seedHost(redis, "hostw");
    const whole = await (async () => {
      // This one's queues are not held: its registry read is whole and it finishes first.
      queueGate.open = true;
      const s = await snapshot();
      queueGate.open = false;
      return s;
    })();
    assert.deepEqual(marksOf(whole), [undefined, [], false, false, ["hosta", "hostw"]]);
    queueGate.reopen();
    assert.deepEqual(marksOf(await part), PART, "the snapshot whose queue set lacked hostw still says so, though a whole read came between");

    // A read in part held in its own consumers' read while a WHOLE read starts and ends: what it then writes and hands
    // on is all its own, never the registry's words and flag of the other read beside its own names. hostw has a last
    // row by now, so its queue is asked and the lists are whole; hosta publishes two consumers, so two reads are held.
    await breakHost(redis, "hostw");
    evalGate.close({ only: 2 });
    const held = snapshot();
    await evalGate.arrived;
    await redis.del("host:h:hostw");
    await seedHost(redis, "hostw");
    assert.deepEqual(marksOf(await snapshot()), [undefined, [], false, false, ["hosta", "hostw"]], "the whole read, made and ended meanwhile");
    evalGate.reopen();
    const mine = await held;
    assert.deepEqual(marksOf(mine), [true, [{ name: "hostw", error: "WRONGTYPE" }], false, false, ["hosta", "hostw"]]);
    assert.deepEqual([mine.queue.fleetDegraded, mine.hostBudgets.map((h) => h.notRead === true)], [ROW_WORDS, [false, true]], "its own words, and hostw's row marked as the last one read");
  } finally {
    queueGate.open = true;
    queueGate.release?.();
    evalGate.open = true;
    evalGate.release?.();
    await Promise.all(started);
    await reader.dispose();
    await redis.cleanup();
  }
});

// Issue #1036: the reader's own switch took "was the registry read" off the reader's variable after its flips, where
// it was whatever a snapshot beside the switch had read by then.
test("createFleetReader: a pause over a registry it could not read says so, though a snapshot reads the registry whole while its queues are being paused (#1036)", async () => {
  const logsDir = tempDir("pd-1036-switch-view-");
  let down = true;
  let scans = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const make = quietQueue();
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, {
    makeQueueFn: (c, opts) => ({ ...make(c, opts), async pause() { await held; }, async resume() {} }),
    parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), nowFn: () => AT,
    readLiveHostsFn: async () => (down ? { unreachable: "ECONNREFUSED 127.0.0.1" } : { hosts: [{ name: "hosta", routes: true }] }),
    discoverHostQueuesFn: async () => { scans += 1; return { names: [], incomplete: null }; },
  });
  try {
    const pausing = reader.pause();
    // The switch has read the registry (not read) and looked for queues, and now waits on its queues' pauses.
    while (scans === 0) await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // Meanwhile the registry answers, and a snapshot reads it whole.
    down = false;
    assert.equal((await reader.snapshot()).queue.fleetDegraded, null);
    release();
    const [{ res }] = (await pausing).results;
    assert.deepEqual([res.ok, res.blind], [true, "ECONNREFUSED 127.0.0.1"], "its own discovery read no registry, so its set of queues may be short");
    // A switch whose own discovery read the registry says nothing of the kind.
    assert.equal(Object.hasOwn((await reader.resume()).results[0].res, "blind"), false);
  } finally {
    release();
    await reader.dispose();
  }
});

test("on a real Valkey: the held money over a host row answered with an error is unknown, never $0 held, and readQueueState and readHosts name the row (#1036, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { readHeldForAgent } = await import("../src/tool-reads.mjs");
  const redis = await prefixed("held1036");
  const logsDir = tempDir("pd-1036-held-");
  try {
    await seedHost(redis, "hosta");
    await breakHost(redis, "hostw");
    // Each read builds and ends a client of its own: a duplicate of the prefixed one, so every key is this test's.
    const reads = { fleet: (paths, seams) => createFleetReader(paths, { ...seams, makeQueueFn: askedQueue([]), parseConnectionFn: () => ({}), redisFn: () => redis.duplicate(), discoverHostQueuesFn: async () => ({ names: [] }) }) };
    assert.deepEqual(await readHeldForAgent({ paths: { valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json") }, nowMs: AT, reads }), { heldMicros: null, heldJobs: null, unknown: true });

    const hosts = await readHosts({ url: URL_, redisFn: () => redis.duplicate() });
    assert.deepEqual([hosts.hosts.map((h) => h.name), hosts.incomplete, hosts.unreadHosts, hosts.hostErrors], [["hosta"], ROW_WORDS, ["hostw"], { hostw: "WRONGTYPE" }]);

    // The status read: the rows that were read still count the workers, and the three keys say what is missing.
    const state = await readQueueState({ url: URL_, makeQueueFn: askedQueue([]), parseConnectionFn: () => ({}), redisFn: () => redis.duplicate() });
    assert.deepEqual([state.queuesMayBeShort, state.registryReadInPart, state.hostErrors, state.workers, state.workerNames], [true, true, { hostw: "WRONGTYPE" }, 1, ["hosta"]]);
    // Read whole, none of the three keys is there.
    await redis.del("host:h:hostw");
    await seedHost(redis, "hostw");
    const whole = await readQueueState({ url: URL_, makeQueueFn: askedQueue([]), parseConnectionFn: () => ({}), redisFn: () => redis.duplicate() });
    assert.deepEqual([Object.hasOwn(whole, "queuesMayBeShort"), Object.hasOwn(whole, "registryReadInPart"), Object.hasOwn(whole, "hostErrors"), whole.workers], [false, false, false, 2]);
    assert.deepEqual(await readHeldForAgent({ paths: { valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "none.json") }, nowMs: AT, reads }), { heldMicros: 0, heldJobs: 0, unknownHosts: [] }, "and the true empty answer survives");
  } finally {
    await redis.cleanup();
  }
});

test("fleetQueuesOn: the registry's index or the look for queues answered with an error carries the reply's code, and a read that got no answer carries none (#1036)", async () => {
  const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
  // The real registry read and the real scan, over a client that answers each with an error reply.
  const refused = { smembers: () => Promise.reject(reply("WRONGTYPE Operation against a key holding the wrong kind of value")), scan: () => Promise.reject(reply("NOPERM this user has no permissions to run the 'scan' command")) };
  const got = await fleetQueuesOn(refused, { timeoutMs: 400 });
  assert.deepEqual([got.names, got.shortErrors, got.blindPartial, got.hosts], [["pi-jobs"], { registry: "WRONGTYPE", scan: "NOPERM" }, undefined, []]);
  assert.match(got.blind, /^WRONGTYPE /);
  // No answer at all (a connection that failed, a scan that never answers): the same degraded read, and no code.
  const silent = { smembers: () => Promise.reject(new Error("Connection is closed.")), scan: () => new Promise(() => {}) };
  const late = await fleetQueuesOn(silent, { timeoutMs: 200 });
  assert.deepEqual([late.blind, Object.hasOwn(late, "shortErrors"), Boolean(late.incomplete)], ["Connection is closed.", false, true]);
  // A row answered with an error beside a row that got no answer: both named, one coded.
  const rows = { smembers: async () => ["hosta", "hostv", "hostw"], hgetall: (key) => (key === "host:h:hostw" ? Promise.reject(reply("WRONGTYPE x")) : key === "host:h:hostv" ? new Promise(() => {}) : Promise.resolve({ name: "hosta", routes: "true", beatAt: String(AT) })), scan: async () => ["0", []] };
  const part = await fleetQueuesOn(rows, { timeoutMs: 400, prune: false });
  assert.deepEqual([part.names, part.blindPartial, part.unreadHosts, part.hostErrors, Object.hasOwn(part, "shortErrors")], [["pi-jobs", "pi-jobs@hosta"], true, ["hostv", "hostw"], { hostw: "WRONGTYPE" }, false]);
  // A code is one word of Valkey's; anything else a seam hands in is no code.
  assert.deepEqual(["WRONGTYPE", "error", "ERR", "two words", "<b>", "", null, 7, "A".repeat(33)].map(replyCodeOf), ["WRONGTYPE", "error", "ERR", null, null, null, null, null, null]);
});

// Issue #1036: six behaviours of the first change that no test held (each stayed green when it was taken away).
test("the registry's error keys, each held: readHosts' code beside unreachable, queuesMayBeShort from a scan that did not finish, the names a reader is handed, a code that is no code, and the bound with its count on every list (#1036)", async () => {
  const { stateOf } = await import("../src/console/live.mjs");
  const { hostsForAgent } = await import("../src/tool-reads.mjs");
  const reply = (message) => Promise.reject(Object.assign(new Error(message), { name: "ReplyError" }));
  const logsDir = tempDir("pd-1036-pins-");
  const quiet = (_c, opts) => ({ name: opts?.name ?? "pi-jobs", async isPaused() { return false; }, async getJobCounts() { return { waiting: 0 }; }, async getWorkers() { return []; }, async close() {} });
  // readHosts: the index answered with an error carries the reply's code beside the words; a failure that is no reply has none.
  const index = (smembers) => readHosts({ url: "redis://unused", redisFn: () => ({ on() {}, disconnect() {}, smembers }) });
  assert.deepEqual(await index(() => reply("WRONGTYPE Operation against a key holding the wrong kind of value")), { unreachable: "WRONGTYPE Operation against a key holding the wrong kind of value", error: "WRONGTYPE" });
  assert.deepEqual(Object.keys(await index(() => Promise.reject(new Error("Connection is closed.")))), ["unreachable"]);
  // readQueueState: a look for queues that did not finish makes the counts a floor too, with the registry read whole.
  const scanFails = { on() {}, disconnect() {}, async smembers() { return []; }, scan: () => Promise.reject(new Error("Command timed out")) };
  const short = await readQueueState({ url: "redis://unused", makeQueueFn: quiet, parseConnectionFn: () => ({}), redisFn: () => scanFails });
  assert.deepEqual([short.queuesMayBeShort, Object.hasOwn(short, "registryReadInPart"), short.unreachable], [true, false, undefined]);
  const scanWhole = { ...scanFails, async scan() { return ["0", []]; } };
  assert.equal(Object.hasOwn(await readQueueState({ url: "redis://unused", makeQueueFn: quiet, parseConnectionFn: () => ({}), redisFn: () => scanWhole }), "queuesMayBeShort"), false);
  // readQueueState: its hostErrors names at most the bound, and counts the rest.
  const many = Array.from({ length: UNREAD_HOSTS_MAX + 3 }, (_, i) => `bad${String(i).padStart(2, "0")}`);
  const broken = { ...scanWhole, async smembers() { return many; }, hgetall: () => reply("WRONGTYPE Operation against a key holding the wrong kind of value") };
  const capped = await readQueueState({ url: "redis://unused", makeQueueFn: quiet, parseConnectionFn: () => ({}), redisFn: () => broken });
  assert.deepEqual([Object.keys(capped.hostErrors), capped.hostErrorsMore, capped.registryReadInPart], [many.slice(0, UNREAD_HOSTS_MAX), 3, true]);
  // A reader handed a listing through its seam: a name that is no worker's is not named, and a code that is no code is none.
  let registry = async () => ({ hosts: [{ name: "hosta", routes: true }], incomplete: "4 of 5 host rows not read", unreadHosts: ["hostw", "not a name", "x".repeat(65), 7], hostErrors: { hostw: "WRONGTYPE", "not a name": "ERR" } });
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: () => registry(), discoverHostQueuesFn: async () => [], nowFn: () => AT });
  try {
    assert.deepEqual((await reader.snapshot()).queue.unreadHosts, [{ name: "hostw", error: "WRONGTYPE" }]);
    registry = async () => ({ unreachable: "the registry said something", error: "WRONGTYPE Operation against a key" });
    const sentence = await reader.snapshot();
    assert.deepEqual([sentence.queue.fleetError, stateOf(sentence, "viewer", { now: AT }).fleetError], [null, null], "the reply's words are no code");
    registry = async () => ({ unreachable: "the registry said something", error: "NOPERM" });
    const coded = await reader.snapshot();
    assert.deepEqual([coded.queue.fleetError, stateOf(coded, "viewer", { now: AT }).fleetError], ["NOPERM", "NOPERM"]);
    assert.equal(stateOf({ queue: { fleetError: "two words" } }, "viewer", { now: AT }).fleetError, null, "and the state API checks what it is handed");
    // dispatch_hosts: twenty named, the rest counted.
    registry = async () => ({ hosts: [{ name: "hosta", routes: true }], incomplete: `${many.length} of ${many.length + 1} host rows not read`, unreadHosts: many, hostErrors: Object.fromEntries(many.map((n) => [n, "WRONGTYPE"])) });
    const hosts = hostsForAgent(await reader.snapshot());
    assert.deepEqual([hosts.unreadHosts.length, hosts.unreadHostsMore, Object.keys(hosts.hostErrors).length], [UNREAD_HOSTS_MAX, 3, UNREAD_HOSTS_MAX]);
    registry = async () => ({ hosts: [{ name: "hosta", routes: true }], incomplete: "20 of 21 host rows not read", unreadHosts: many.slice(0, UNREAD_HOSTS_MAX) });
    assert.equal(Object.hasOwn(hostsForAgent(await reader.snapshot()), "unreadHostsMore"), false, "at the bound nothing is counted");
  } finally {
    await reader.dispose();
  }
});

test("createFleetReader: a registry read in part names every host it did not read up to the bound and counts the rest, and one with no last row makes the lists floors (#1036)", async () => {
  const logsDir = tempDir("pd-1036-many-");
  const names = Array.from({ length: UNREAD_HOSTS_MAX + 3 }, (_, i) => `late${String(i).padStart(2, "0")}`);
  let registry = async () => ({ hosts: [{ name: "hosta", routes: true }], incomplete: `${names.length} of ${names.length + 1} host rows not read`, unreadHosts: names, hostErrors: { late01: "WRONGTYPE", late02: "<script>" } });
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: () => registry(), discoverHostQueuesFn: async () => [], nowFn: () => AT });
  try {
    const snap = await reader.snapshot();
    assert.deepEqual([snap.queue.unreadHosts.length, snap.queue.unreadHostsMore, snap.queue.unreadHosts.slice(0, 3)], [UNREAD_HOSTS_MAX, 3, [{ name: "late00", error: null }, { name: "late01", error: "WRONGTYPE" }, { name: "late02", error: null }]], "a row not read in time has no code, and neither has one whose code is no code");
    assert.deepEqual([snap.schedulersReadInPart, snap.activeUnreachable], [true, true]);
    // A listing that says it is not whole without naming the rows: nothing to name, and the lists are floors all the same.
    registry = async () => ({ hosts: [{ name: "hosta", routes: true }], incomplete: "1 of 2 host rows not read" });
    const unnamed = await reader.snapshot();
    assert.deepEqual([unnamed.queue.unreadHosts, Object.hasOwn(unnamed.queue, "unreadHostsMore"), unnamed.schedulersReadInPart, unnamed.activeUnreachable], [[], false, true, true]);
    // Read whole again: nothing named, the lists whole.
    registry = async () => ({ hosts: [{ name: "hosta", routes: true }] });
    const whole = await reader.snapshot();
    assert.deepEqual([whole.queue.unreadHosts, whole.queue.fleetError, whole.schedulersReadInPart, whole.activeUnreachable], [[], null, false, false]);
  } finally {
    await reader.dispose();
  }
});

// --- a reader that writes nothing (issue #1036) -------------------------------------------------------------------------

test("createFleetReader hands every queue it builds metaWrite: false when it is read-only, and true when it is not: the shared queue, a host's, a sandbox request queue (#1036)", async () => {
  const logsDir = tempDir("pd-1036-meta-");
  for (const [readOnly, metaWrite] of [[true, false], [false, true], [undefined, true]]) {
    const handed = [];
    const sandbox = [];
    const mk = (_c, opts) => (handed.push(opts), quietQueue()(_c, opts));
    const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, {
      makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: async () => ({ hosts: [{ name: "hostb", routes: true }] }), discoverHostQueuesFn: async () => [], nowFn: () => AT,
      makeSandboxPrepareQueueFn: (_c, opts) => (sandbox.push(opts), { name: "sandbox", async close() {} }), readSandboxPreparationFn: async () => ({ state: "unknown" }),
      ...(readOnly === undefined ? {} : { readOnly }),
    });
    try {
      await reader.snapshot();
      await reader.sandboxPreparationStatus("hostb", "sb-1");
      assert.deepEqual(handed, [{ metaWrite }, { name: "pi-jobs@hostb", metaWrite }], `readOnly ${readOnly}`);
      assert.deepEqual(sandbox, [{ host: "hostb", metaWrite }], `readOnly ${readOnly}`);
    } finally {
      await reader.dispose();
    }
  }
});

test("createFleetReader on a real Valkey: a read-only reader reads two queues and writes no key, pauses and resumes one that has no meta key, and a reader that is not read-only still writes each queue's meta hash (#1036, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { makeQueue } = await import("@edgehero/pi-dispatch/queue");
  const { makeRedisClient, parseConnection } = await import("@edgehero/pi-dispatch/connection");
  const direct = makeRedisClient(URL_);
  direct.on("error", () => {});
  const logsDir = tempDir("pd-1036-pause-");
  writeFileSync(join(logsDir, "triggers.json"), '{ "triggers": [] }\n');
  // Every queue the reader names is one of this test's own (its name prefixed); what the reader hands is passed on.
  const readerOn = (prefix, seams) => createFleetReader({ valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "triggers.json") }, {
    makeQueueFn: (connection, opts) => {
      const name = opts?.name ?? "pi-jobs";
      const queue = makeQueue(connection, { ...opts, name: `${prefix}${name}` });
      return new Proxy(queue, { get: (target, key) => (key === "name" ? name : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
    },
    readLiveHostsFn: async () => ({ hosts: [{ name: "mini1", routes: true }] }), discoverHostQueuesFn: async () => ({ names: [] }), nowFn: () => AT, ...seams,
  });
  const quiet = `pd1036r-${process.pid}-${Date.now()}-`;
  const usual = `pd1036w-${process.pid}-${Date.now()}-`;
  const keys = async (prefix) => (await direct.keys(`bull:${prefix}*`)).map((k) => k.slice(`bull:${prefix}`.length)).sort();
  const reader = readerOn(quiet, { readOnly: true });
  const writer = readerOn(usual, {});
  try {
    const first = await reader.snapshot();
    assert.deepEqual(first.queueCounts.map((q) => [q.queue, q.paused]), [["pi-jobs", false], ["pi-jobs@mini1", false]]);
    assert.deepEqual(await keys(quiet), [], "two queues built and read, and no key written");
    // A pause of a queue with no meta key, through the queue the reader holds.
    assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@mini1", paused: true }), { ok: true, paused: true, queue: "pi-jobs@mini1" });
    assert.deepEqual([await direct.hgetall(`bull:${quiet}pi-jobs@mini1:meta`), await keys(quiet)], [{ paused: "1" }, ["pi-jobs@mini1:events", "pi-jobs@mini1:meta"]]);
    // A job added while it is paused waits in the paused list, and the snapshot reads it there.
    const producer = makeQueue(parseConnection(URL_), { name: `${quiet}pi-jobs@mini1`, metaWrite: false });
    try {
      await producer.add("t", { kind: "local" }, { jobId: "job-1036" });
    } finally {
      await producer.close();
    }
    const held = (await reader.snapshot()).queueCounts.find((q) => q.queue === "pi-jobs@mini1");
    assert.deepEqual([held.paused, held.counts.paused, held.counts.waiting], [true, 1, 0]);
    // The resume moves it back and takes the flag away; what is left in the hash is what the add's own script set.
    assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@mini1", paused: false }), { ok: true, paused: false, queue: "pi-jobs@mini1" });
    const running = (await reader.snapshot()).queueCounts.find((q) => q.queue === "pi-jobs@mini1");
    assert.deepEqual([running.paused, running.counts.paused, running.counts.waiting, await direct.hgetall(`bull:${quiet}pi-jobs@mini1:meta`)], [false, 0, 1, { "opts.maxLenEvents": "10000" }]);
    assert.equal(await direct.exists(`bull:${quiet}pi-jobs:meta`), 0, "the shared queue was read throughout and never written");
    // The panel's kind of reader builds its queues as before: each writes its meta hash.
    await writer.snapshot();
    assert.deepEqual(await keys(usual), ["pi-jobs:meta", "pi-jobs@mini1:meta"]);
  } finally {
    await reader.dispose();
    await writer.dispose();
    const left = [...(await direct.keys(`bull:${quiet}*`)), ...(await direct.keys(`bull:${usual}*`))];
    if (left.length > 0) await direct.del(...left);
    direct.disconnect();
  }
});

test("the one-shot readers write nothing when asked to: no meta write, no pruned member, and each default keeps pruning (#1036)", async () => {
  const logsDir = tempDir("pd-1036-oneshot-");
  // A Valkey client that records every command that writes, over a registry with one live host and one stale member,
  // a held index with one stale member, and a run mirror index with one id whose record is gone.
  const client = () => {
    const wrote = [];
    const live = { name: "hosta", routes: "true", beatAt: String(AT), jobs: "[]" };
    return {
      wrote,
      on() {}, disconnect() {},
      async smembers(key) { return key === "host:live" ? ["hosta", "gone"] : key === "wait:held" ? ["stale-held"] : []; },
      async hgetall(key) { return key === "host:h:hosta" ? live : {}; },
      async pttl() { return 60_000; },
      async srem(key, member) { wrote.push(`srem ${key} ${member}`); return 1; },
      async scan() { return ["0", []]; },
      async zrevrangebyscore() { return ["stale-run"]; },
      async mget(...keys) { return keys.flat().map(() => null); },
      async eval(_script, _n, key) { wrote.push(`eval ${key}`); return 1; },
      async get() { return null; },
    };
  };
  const queues = (handed) => (_c, opts) => (handed.push(opts), quietQueue()(_c, opts));
  const url = "redis://127.0.0.1:1";
  for (const [readOnly, opts, pruned] of [[true, { name: "pi-jobs", metaWrite: false }, []], [false, { name: "pi-jobs" }, ["srem host:live gone"]], [undefined, { name: "pi-jobs" }, ["srem host:live gone"]]]) {
    const flag = readOnly === undefined ? {} : { readOnly };
    let redis = client();
    let handed = [];
    const state = await readQueueState({ url, makeQueueFn: queues(handed), parseConnectionFn: () => ({}), redisFn: () => redis, ...flag });
    assert.deepEqual([state.unreachable, handed[0], handed[1], redis.wrote], [undefined, opts, { ...opts, name: "pi-jobs@hosta" }, pruned], `readQueueState, readOnly ${readOnly}`);
    redis = client();
    handed = [];
    const schedulers = await readSchedulers({ url, makeQueueFn: queues(handed), parseConnectionFn: () => ({}), redisFn: () => redis, now: () => AT, ...flag });
    assert.deepEqual([Array.isArray(schedulers), handed[0], handed[1], redis.wrote], [true, opts, { ...opts, name: "pi-jobs@hosta" }, pruned], `readSchedulers, readOnly ${readOnly}`);
  }
  for (const [prune, wrote] of [[false, []], [true, ["srem wait:held stale-held"]], [undefined, ["srem wait:held stale-held"]]]) {
    const redis = client();
    const held = await readHeldJobs({ url, redisFn: () => redis, ...(prune === undefined ? {} : { prune }) });
    assert.deepEqual([held.rows, redis.wrote], [[], wrote], `readHeldJobs, prune ${prune}`);
  }
  for (const [prune, wrote] of [[false, []], [true, ["eval runs:index"]], [undefined, ["eval runs:index"]]]) {
    const redis = client();
    const runs = await listRunsMerged({ logsDir, url, redisFn: () => redis, ...(prune === undefined ? {} : { prune }) });
    assert.deepEqual([runs.runs, redis.wrote], [[], wrote], `listRunsMerged, prune ${prune}`);
  }
  // readHosts hands the flag to the registry read; left out, the registry read's own default prunes.
  for (const [prune, wrote] of [[false, []], [undefined, ["srem host:live gone"]]]) {
    const redis = client();
    const hosts = await readHosts({ url, redisFn: () => redis, ...(prune === undefined ? {} : { prune }) });
    assert.deepEqual([hosts.hosts.map((h) => h.name), redis.wrote], [["hosta"], wrote], `readHosts, prune ${prune}`);
  }
});

test("readSchedulers read-only still says a registry read in part, so dispatch_status keeps schedulersReadInPart (#1036)", async () => {
  const redis = { on() {}, disconnect() {}, smembers: async () => ["hosta", "hostv"], hgetall: (key) => (key === "host:h:hostv" ? new Promise(() => {}) : Promise.resolve({ name: "hosta", routes: "true", beatAt: String(AT) })), pttl: async () => 60_000, srem: async () => assert.fail("a read-only read prunes nothing") };
  const list = await readSchedulers({ url: "redis://127.0.0.1:1", makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => redis, now: () => AT, timeoutMs: 600, readOnly: true });
  assert.deepEqual([Array.isArray(list), list.hostsReadInPart], [true, "1 of 2 host rows not read"]);
});

// --- the fleet reader: what it costs and what it writes ---------------------------------------------------------------

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

test("createFleetReader: the local run index holds the deployment's mirror cap (paths.runMirrorMaxRuns), the built-in one when paths name none (issue #761)", async () => {
  const logsDir = tempDir("pd-761-cap-");
  for (const [id, ago] of [["gh-c1", 3], ["gh-c2", 2], ["gh-c3", 1]]) writeLocal(logsDir, rec(id, AT - ago * MIN));
  const readerOf = (extra) => createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2, ...extra }, { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => emptyRedis(), readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT });
  const capped = await readerOf({ runMirrorMaxRuns: 2 }).runsPage({ limit: 10 });
  assert.deepEqual(capped.runs.map((r) => r.jobId), ["gh-c3", "gh-c2"], "the oldest file is past the cap, as it is past the mirror's");
  assert.deepEqual((await readerOf({}).runsPage({ limit: 10 })).runs.map((r) => r.jobId), ["gh-c3", "gh-c2", "gh-c1"], "no cap named: RUNS_INDEX_MAX, which three files are well inside");
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
  // The client could not be made, Valkey refused its SET, and, once the file could not be replaced, its put-back failed.
  const unmade = await write({ redisFn: fails });
  const unset = await write({ redisFn: client({ set: async () => { throw Object.assign(new Error(words), { name: "ReplyError" }); } }) });
  const unput = await write({ redisFn: client({ eval: async () => fails() }), fs: { ...nodeFs, writeFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
  for (const [what, res] of [["unmade", unmade], ["unset", unset], ["unput", unput]]) {
    assert.ok(typeof res.invalid === "string" && res.invalid.includes(`(${bounded})`), `${what}: ${res.invalid}`);
    assert.ok(!res.invalid.includes(words.slice(0, 40)) && !/[\u0000-\u001f]/.test(res.invalid), `${what}: no control byte, and cut`);
  }
  assert.match(unmade.invalid, /^could not reach Valkey to record the new envelope's digest in /);
  assert.match(unset.invalid, /^Valkey refused the record of the new envelope's digest in /);
  assert.match(unput.invalid, /could not be put back to absent \(/);
  // A SET that never left the client (issue #987) is thrown on as nothing sent, its words bounded the same way.
  const unsent = await write({ redisFn: client({ set: async () => fails() }) }).then(() => "wrote", (error) => error);
  assert.deepEqual([unsent?.valkeyNotSent, unsent?.message], [true, bounded]);
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

// Issue #1053: one queue's read that Valkey answered with an error failed the switch preview's snapshot for the fleet.
test("createFleetReader: a read names a queue whose read Valkey answered with an error, by the reply's code alone, and reads every other, on a switch preview and on the per-tick read; any other failure still fails it (#1053, #1064)", async () => {
  const redis = { on() {}, async get() { return null; }, async mget(...keys) { return keys.map(() => null); }, async smembers() { return []; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async exists() { return 0; }, disconnect() {} };
  const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
  let failing = { "pi-jobs@hostb": { paused: () => Promise.reject(reply("WRONGTYPE Operation against a key holding the wrong kind of value")) } };
  const queue = (_c, opts) => {
    const name = opts?.name ?? "pi-jobs";
    return {
      name,
      isPaused: () => (failing[name]?.paused ? failing[name].paused() : Promise.resolve(name === "pi-jobs@hosta")),
      getJobCounts: () => (failing[name]?.counts ? failing[name].counts() : Promise.resolve({ waiting: 1, paused: name === "pi-jobs@hosta" ? 2 : 0 })),
      async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {},
    };
  };
  const logsDir = tempDir("pd-1053-switch-errored-");
  let hosts = [];
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => ({ names: ["pi-jobs@hosta", "pi-jobs@hostb"], incomplete: null }), nowFn: () => AT });
  try {
    const s = await reader.snapshot({ switchQueues: true });
    assert.deepEqual(s.queueErrors, { "pi-jobs@hostb": "WRONGTYPE" });
    assert.equal(Object.hasOwn(s, "switchErrored"), false, "one name for it, the CLI's");
    assert.deepEqual(s.queueCounts.map((q) => [q.queue, q.paused, q.counts.waiting]), [["pi-jobs", false, 1], ["pi-jobs@hosta", true, 1]], "the errored queue is in no row and no sum");
    assert.deepEqual([s.queue.counts.waiting, s.switchTotal], [2, 3]);
    assert.ok(!JSON.stringify(s).includes("Operation against"), "the reply's code alone");
    // Its counts answered with the error instead: the same.
    failing = { "pi-jobs@hostb": { counts: () => Promise.reject(reply("ERR Error running script (call to f_x): @user_script:7: WRONGTYPE")) } };
    assert.deepEqual((await reader.snapshot({ switchQueues: true })).queueErrors, { "pi-jobs@hostb": "ERR" });
    // A whole read names none.
    failing = {};
    assert.deepEqual((await reader.snapshot({ switchQueues: true })).queueErrors, {});
    // A failure that is no reply still fails the snapshot, as before: the fleet was not read.
    failing = { "pi-jobs@hostb": { paused: () => Promise.reject(new Error("Connection is closed.")) } };
    await assert.rejects(reader.snapshot({ switchQueues: true }), /Connection is closed/);
    // The per-tick read, every page's, names it the same way (issue #1064): it failed whole, so every page of a
    // deployment with one such key said Valkey could not be read.
    hosts = [{ name: "hosta", routes: "true" }, { name: "hostb", routes: "true" }];
    failing = { "pi-jobs@hostb": { paused: () => Promise.reject(reply("WRONGTYPE Operation against a key holding the wrong kind of value")) } };
    const tick = await reader.snapshot();
    assert.deepEqual([tick.queueErrors, tick.queueCounts.map((q) => q.queue), tick.queue.queues, tick.queue.counts.waiting, Object.hasOwn(tick, "switchTotal")], [{ "pi-jobs@hostb": "WRONGTYPE" }, ["pi-jobs", "pi-jobs@hosta"], 3, 2, false]);
    assert.ok(!JSON.stringify(tick).includes("Operation against"), "the reply's code alone");
    failing = { "pi-jobs@hostb": { counts: () => Promise.reject(reply("NOPERM this user has no permissions to run the 'eval' command")) } };
    assert.deepEqual((await reader.snapshot()).queueErrors, { "pi-jobs@hostb": "NOPERM" }, "its counts answered with the error instead: the same");
    failing = {};
    assert.deepEqual((await reader.snapshot()).queueErrors, {}, "and a whole read carries an empty map");
    // A failure that is no reply is no answer about any queue: the per-tick read still fails on it, as before.
    failing = { "pi-jobs@hostb": { paused: () => Promise.reject(new Error("Connection is closed.")) } };
    await assert.rejects(reader.snapshot(), /Connection is closed/);
    failing = { "pi-jobs@hostb": { counts: () => Promise.reject(Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" })) } };
    await assert.rejects(reader.snapshot(), /Command timed out/);
  } finally {
    await reader.dispose();
  }
});

/**
 * A fleet of three queues for the reads of issue #1064, as both the admin's readers and `pi-dispatch status` build it:
 * `state` says what each queue's reads answer (true: paused, false: running, "errored": the paused read is answered
 * with WRONGTYPE, "uncounted": the counts are, "both": both are, "lost": the connection failed with no answer), looked up at each read, so
 * a reader that keeps its queues reads what `state` says now. `probe` is the client that names them: an empty registry
 * and a scan that finds the host queues.
 */
function fleetOf1064(state) {
  const reply = () => Promise.reject(Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" }));
  const lost = () => Promise.reject(new Error("Connection is closed."));
  const names = Object.keys(state);
  return {
    names,
    probe: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { return ["0", names.filter((n) => n !== "pi-jobs").map((n) => `bull:${n}:meta`)]; } }),
    queue: (_c, opts) => {
      const name = opts?.name ?? "pi-jobs";
      return {
        name, client: { async zrange() { return []; } },
        isPaused: () => (state[name] === "errored" || state[name] === "both" ? reply() : state[name] === "lost" ? lost() : Promise.resolve(state[name] === true)),
        getJobCounts: () => (state[name] === "uncounted" || state[name] === "both" ? reply() : state[name] === "lost" ? lost() : Promise.resolve({ waiting: 2, active: 1, paused: state[name] === true ? 3 : 0, delayed: 0, failed: 0 })),
        async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {},
      };
    },
  };
}

// Issue #1064: with a queue left out, "every queue that was read is paused" read as a fleet wholly paused.
test("createFleetReader: over a queue Valkey answered with an error the fleet is never wholly paused, and partly paused only when a queue that was read is (#1064)", async () => {
  const redis = { on() {}, async get() { return null; }, async mget(...keys) { return keys.map(() => null); }, async smembers() { return []; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async exists() { return 0; }, disconnect() {} };
  const logsDir = tempDir("pd-1064-paused-");
  const state = {};
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: fleetOf1064(state).queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [{ name: "hosta", routes: "true" }, { name: "hostb", routes: "true" }] }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), nowFn: () => AT });
  const read = async (next) => {
    Object.assign(state, next);
    const s = await reader.snapshot();
    return [s.queue.pausedState, s.queue.pausedPartial, s.queueCounts.map((q) => q.queue), s.queue.queues, s.queueErrors];
  };
  try {
    assert.deepEqual(await read({ "pi-jobs": true, "pi-jobs@hosta": true, "pi-jobs@hostb": "errored" }), [false, true, ["pi-jobs", "pi-jobs@hosta"], 3, { "pi-jobs@hostb": "WRONGTYPE" }], "every queue that was read is paused: partly, never wholly, since hostb may be running");
    assert.deepEqual(await read({ "pi-jobs": false, "pi-jobs@hosta": false, "pi-jobs@hostb": "uncounted" }), [false, false, ["pi-jobs", "pi-jobs@hosta"], 3, { "pi-jobs@hostb": "WRONGTYPE" }], "no queue that was read is paused: a queue nobody read is no evidence of a paused one");
    assert.deepEqual(await read({ "pi-jobs": true, "pi-jobs@hosta": false, "pi-jobs@hostb": "errored" }), [false, true, ["pi-jobs", "pi-jobs@hosta"], 3, { "pi-jobs@hostb": "WRONGTYPE" }]);
    assert.deepEqual(await read({ "pi-jobs": "errored", "pi-jobs@hosta": "errored", "pi-jobs@hostb": "uncounted" }), [false, false, [], 3, { "pi-jobs": "WRONGTYPE", "pi-jobs@hosta": "WRONGTYPE", "pi-jobs@hostb": "WRONGTYPE" }], "none was read: neither paused nor partly, and `queue.queues` still counts all three");
    assert.deepEqual(await read({ "pi-jobs": true, "pi-jobs@hosta": true, "pi-jobs@hostb": true }), [true, false, ["pi-jobs", "pi-jobs@hosta", "pi-jobs@hostb"], 3, {}], "the control: read whole and all paused is wholly paused");
  } finally {
    await reader.dispose();
  }
});

// Issue #1064: a fleet whose every queue that was read is paused reads "partly paused" beside a queue nobody read. The
// pages offered Resume for a paused or partly paused fleet, and must still offer it for this one.
test("a fleet whose every read queue is paused beside one Valkey answered with an error is still offered Resume on the overview and on Fleet (#1064)", async () => {
  const { pagePanels } = await import("../src/console/pages.mjs");
  const redis = { on() {}, async get() { return null; }, async mget(...keys) { return keys.map(() => null); }, async smembers() { return []; }, async hgetall() { return {}; }, async zrevrangebyscore() { return []; }, async exists() { return 0; }, disconnect() {} };
  const logsDir = tempDir("pd-1064-resume-");
  // A deployment with a trigger and hosts, so the overview draws its own panels and not the first run's checklist.
  const triggersPath = join(logsDir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } }] }));
  const state = { "pi-jobs": true, "pi-jobs@hosta": true, "pi-jobs@hostb": "errored" };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath, schedulerStallMax: 2 }, { makeQueueFn: fleetOf1064(state).queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [{ name: "hosta", routes: "true" }, { name: "hostb", routes: "true" }] }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), nowFn: () => AT });
  // Which fleet switches a page's panel offers an operator, by the action each form posts.
  const offered = async (page, id) => {
    const snapshot = await reader.snapshot();
    const panels = await pagePanels(page, { query: {}, session: { name: "ops", role: "operator" }, data: { page, now: AT, env: {}, snapshot }, readOnly: false });
    const markup = panels.find((p) => p.id === id).html;
    return ["fleet-pause", "fleet-resume"].filter((action) => markup.includes(action));
  };
  try {
    assert.deepEqual([(await reader.snapshot()).queue.pausedState, (await reader.snapshot()).queue.pausedPartial], [false, true]);
    assert.deepEqual(await offered("overview", "p-hosts"), ["fleet-pause", "fleet-resume"], "the overview: resume what is paused, and pause the queue nobody read");
    assert.ok((await offered("fleet", "p-fleetbar")).includes("fleet-resume"), "Fleet's bar");
    // The control: read whole and all paused, Resume alone, as before.
    state["pi-jobs@hostb"] = true;
    assert.deepEqual(await offered("overview", "p-hosts"), ["fleet-resume"]);
    assert.deepEqual(await offered("fleet", "p-fleetbar"), ["fleet-resume"]);
  } finally {
    await reader.dispose();
  }
});

// Issue #1064: the status read took one queue's error reply for the whole deployment's, as a Valkey not reached.
test("readQueueState settles each queue by itself: one answered with an error is named under the CLI's keys and left out of the counts, and only a read nothing answered is unreachable (#1064)", async () => {
  const read = (state) => {
    const fleet = fleetOf1064(state);
    return readQueueState({ url: "redis://unused", makeQueueFn: fleet.queue, parseConnectionFn: () => ({}), redisFn: fleet.probe });
  };
  // Its paused state answered with the error: named, by the reply's code alone, and in none of the sums.
  const one = await read({ "pi-jobs": false, "pi-jobs@hosta": true, "pi-jobs@hostb": "errored" });
  assert.deepEqual([one.unreachable, one.partial, one.unavailableQueues, one.queueErrors], [undefined, true, ["pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }]);
  assert.deepEqual([one.counts.waiting, one.counts.paused, one.queues, one.pausedState, one.pausedPartial], [4, 3, 3, false, true], "the other two are read and summed; `queues` counts all three");
  assert.ok(!JSON.stringify(one).includes("Operation against"), "the reply's code alone");
  // Its counts answered with it instead: the same queue, the same keys.
  const counts = await read({ "pi-jobs": true, "pi-jobs@hosta": true, "pi-jobs@hostb": "uncounted" });
  assert.deepEqual([counts.unavailableQueues, counts.queueErrors, counts.counts.waiting, counts.pausedState, counts.pausedPartial], [["pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }, 4, false, true], "every queue that was read is paused: partly, never wholly");
  // Every queue answered with an error: Valkey answered, so the read is partial, never unreachable.
  const all = await read({ "pi-jobs": "errored", "pi-jobs@hosta": "uncounted" });
  assert.deepEqual([all.unreachable, all.partial, all.unavailableQueues, all.queueErrors, all.counts, all.queues, all.pausedState, Object.hasOwn(all, "pausedPartial")], [undefined, true, ["pi-jobs", "pi-jobs@hosta"], { "pi-jobs": "WRONGTYPE", "pi-jobs@hosta": "WRONGTYPE" }, {}, 2, false, false]);
  // And so when no read gave a value at all: an error reply is an answer, so this is not a Valkey that could not be reached.
  const none = await read({ "pi-jobs": "both", "pi-jobs@hosta": "both" });
  assert.deepEqual([none.unreachable, none.partial, none.unavailableQueues, none.queueErrors, none.counts], [undefined, true, ["pi-jobs", "pi-jobs@hosta"], { "pi-jobs": "WRONGTYPE", "pi-jobs@hosta": "WRONGTYPE" }, {}]);
  // A failure that is no reply, beside a queue that answered: one more queue not read, with no code.
  const lost = await read({ "pi-jobs": false, "pi-jobs@hosta": "lost", "pi-jobs@hostb": "errored" });
  assert.deepEqual([lost.unreachable, lost.partial, lost.unavailableQueues, lost.queueErrors, lost.counts.waiting], [undefined, true, ["pi-jobs@hosta", "pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }, 2]);
  const lostAlone = await read({ "pi-jobs": false, "pi-jobs@hosta": "lost" });
  assert.deepEqual([lostAlone.partial, lostAlone.unavailableQueues, Object.hasOwn(lostAlone, "queueErrors")], [true, ["pi-jobs@hosta"], false], "no code where Valkey gave none");
  // Nothing answered at all: unreachable, in the failure's words, as before.
  assert.deepEqual(await read({ "pi-jobs": "lost", "pi-jobs@hosta": "lost" }), { unreachable: "Connection is closed." });
  // Read whole: none of the three keys.
  const whole = await read({ "pi-jobs": true, "pi-jobs@hosta": true });
  assert.deepEqual([whole.pausedState, Object.hasOwn(whole, "partial"), Object.hasOwn(whole, "unavailableQueues"), Object.hasOwn(whole, "queueErrors"), whole.queues], [true, false, false, false, 2]);
});

// Issue #1064: `/dispatch status`, `dispatch_status` and `pi-dispatch status` say one deployment state under one set
// of keys. Held equal here, over the same queues and the same client, so neither grows a second name for it.
test("readQueueState and `pi-dispatch status` name the queues they did not read under the same keys with the same values (#1064)", { timeout: 30_000 }, async () => {
  const { main } = await import("../../worker/src/cli.mjs");
  const SHARED = ["partial", "unavailableQueues", "queueErrors", "queuesMayBeShort", "hostErrors"];
  const cwd = tempDir("pd-1064-parity-");
  const both = async (state) => {
    const fleet = fleetOf1064(state);
    let out = "";
    const errs = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
    let code;
    try {
      code = await main(["status", "--valkey-url", "redis://valkey.invalid:1"], { VALKEY_URL: "redis://valkey.invalid:1" }, {
        now: () => new Date(AT), statusDeadlineMs: 2000, cwd, write: (text) => { out += text; }, writeErr: (text) => errs.push(String(text)),
        valkeyRefusal: async () => null, controlClients: { makeRedisClient: fleet.probe, makeQueue: fleet.queue },
      });
    } finally {
      process.stderr.write = origErr;
    }
    const cli = JSON.parse(out);
    const admin = await readQueueState({ url: "redis://valkey.invalid:1", makeQueueFn: fleet.queue, parseConnectionFn: () => ({}), redisFn: fleet.probe });
    const shared = (o) => Object.fromEntries(SHARED.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
    return { code, cli: shared(cli), admin: shared(admin) };
  };
  const errored = await both({ "pi-jobs": false, "pi-jobs@hosta": true, "pi-jobs@hostb": "errored" });
  assert.deepEqual(errored.admin, { partial: true, unavailableQueues: ["pi-jobs@hostb"], queueErrors: { "pi-jobs@hostb": "WRONGTYPE" } });
  assert.deepEqual([errored.cli, errored.code], [errored.admin, 1]);
  const uncounted = await both({ "pi-jobs": "uncounted", "pi-jobs@hosta": "errored" });
  assert.deepEqual(uncounted.admin, { partial: true, unavailableQueues: ["pi-jobs", "pi-jobs@hosta"], queueErrors: { "pi-jobs": "WRONGTYPE", "pi-jobs@hosta": "WRONGTYPE" } });
  assert.deepEqual(uncounted.cli, uncounted.admin);
  const lost = await both({ "pi-jobs": false, "pi-jobs@hosta": "lost", "pi-jobs@hostb": "errored" });
  assert.deepEqual(lost.admin, { partial: true, unavailableQueues: ["pi-jobs@hosta", "pi-jobs@hostb"], queueErrors: { "pi-jobs@hostb": "WRONGTYPE" } });
  assert.deepEqual(lost.cli, lost.admin);
  // No read gave a value and every one was answered with an error: both say so, neither says unreachable.
  const none = await both({ "pi-jobs": "both", "pi-jobs@hosta": "both" });
  assert.deepEqual(none.admin, { partial: true, unavailableQueues: ["pi-jobs", "pi-jobs@hosta"], queueErrors: { "pi-jobs": "WRONGTYPE", "pi-jobs@hosta": "WRONGTYPE" } });
  assert.deepEqual(none.cli, none.admin);
  const whole = await both({ "pi-jobs": false, "pi-jobs@hosta": true });
  assert.deepEqual([whole.cli, whole.admin, whole.code], [{}, {}, 0], "read whole, neither says any of them");
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
    assert.deepEqual(Object.keys(facts).sort(), ["target", "kind", "flow", "backend", "provider", "model", "maxTurns", "project", "host", "queue", "queuedAt", "startedAt", "triggerIndex"].sort());
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

// ---- A queue whose client ended is replaced (a Valkey restart under a running console) ---------------------------------

/** A `makeQueueFn` whose queues answer the snapshot's reads, each with a client this test can end. */
function endingQueues() {
  const built = [];
  const mk = (_conn, opts = {}) => {
    const name = opts.name ?? "pi-jobs";
    const listeners = {};
    const client = { status: "ready", once(event, fn) { listeners[event] = fn; } };
    const q = {
      name,
      client: Promise.resolve(client),
      closed: 0,
      workersAsked: 0,
      jobsAsked: 0,
      end() { client.status = "end"; listeners.end?.(); },
      async isPaused() { return false; },
      async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
      async getWorkers() { q.workersAsked += 1; return []; },
      async getJobSchedulers() { return []; },
      async getActive() { return []; },
      async getFailed() { return []; },
      async getJob() { q.jobsAsked += 1; return null; },
      async close() { q.closed += 1; },
    };
    built.push(q);
    return q;
  };
  return { built, mk };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const readyRedis = () => ({ status: "ready", on() {}, get: async () => null, mget: async () => [], hgetall: async () => ({}), smembers: async () => [], scan: async () => ["0", []], disconnect() {} });

function endingReader(mk, hosts = [], seams = {}) {
  const logsDir = tempDir("pd-ended-queue-");
  const triggersPath = join(logsDir, "triggers.json");
  writeFileSync(triggersPath, '{ "triggers": [] }\n');
  return createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath },
    { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: readyRedis, readLiveHostsFn: async () => ({ hosts: typeof hosts === "function" ? hosts() : hosts }), discoverHostQueuesFn: async () => [], nowFn: () => 1_800_000_000_000, readOnly: true, activeLimit: 2, ...seams },
  );
}

test("createFleetReader replaces a queue whose client ended, once, closes the old one, and keeps a live one", async () => {
  const { built, mk } = endingQueues();
  const reader = endingReader(mk, [{ name: "hostb", routes: true }]);
  await reader.snapshot();
  await settle();
  assert.deepEqual(built.map((q) => q.name), ["pi-jobs", "pi-jobs@hostb"]);
  await reader.snapshot();
  assert.equal(built.length, 2, "two reads on live clients build nothing");
  built[0].end();
  await reader.snapshot();
  await settle();
  assert.deepEqual(built.map((q) => q.name), ["pi-jobs", "pi-jobs@hostb", "pi-jobs"], "the ended one alone is replaced");
  assert.equal(built[0].closed, 1, "what it replaced is closed, not left open");
  assert.equal(built[1].closed, 0);
  await reader.snapshot();
  assert.equal(built.length, 3, "and the replacement is held, not rebuilt per read");
});

test("createFleetReader asks the replacement for the workers, not the shared queue it held from the start", async () => {
  const { built, mk } = endingQueues();
  const reader = endingReader(mk);
  await reader.snapshot();
  await settle();
  assert.equal(built[0].workersAsked, 1);
  built[0].end();
  await reader.snapshot();
  assert.equal(built[0].workersAsked, 1, "the ended queue is not asked again");
  assert.equal(built[1].workersAsked, 1);
});

test("createFleetReader: a job's lookup on a host that left the registry goes to a replacement too", async () => {
  const { built, mk } = endingQueues();
  let hosts = [{ name: "hostb", routes: true }];
  const reader = endingReader(mk, () => hosts);
  await reader.snapshot();
  await settle();
  const left = built.find((q) => q.name === "pi-jobs@hostb");
  hosts = [];
  await reader.snapshot();
  left.end();
  await reader.triggerSkew(0, { rows: [{ queue: "pi-jobs@hostb", jobId: "gh-1" }] });
  await settle();
  assert.equal(left.jobsAsked, 0, "the ended queue answers for nothing");
  assert.equal(left.closed, 1);
  const again = built.filter((q) => q.name === "pi-jobs@hostb");
  assert.equal(again.length, 2);
  assert.equal(again[1].jobsAsked, 1);
  await reader.triggerSkew(0, { rows: [{ queue: "pi-jobs@never-held", jobId: "gh-2" }] });
  assert.equal(built.some((q) => q.name === "pi-jobs@never-held"), false, "a lookup replaces what the pool holds, and builds nothing for a name a row carries");
});

test("createFleetReader replaces a sandbox request queue whose client ended, and closes the replacement at dispose", async () => {
  const { built, mk } = endingQueues();
  const reader = endingReader(() => ({ name: "pi-jobs" }), [], {
    makeSandboxPrepareQueueFn: (conn, { host }) => mk(conn, { name: `sandbox@${host}` }),
    readSandboxPreparationFn: async (q, id) => ({ id, queue: q }),
  });
  const first = await reader.sandboxPreparationStatus("mini1", "a");
  await settle();
  assert.equal((await reader.sandboxPreparationStatus("mini1", "b")).queue, first.queue, "a live one is held");
  built[0].end();
  const second = await reader.sandboxPreparationStatus("mini1", "c");
  await settle();
  assert.notEqual(second.queue, first.queue);
  assert.equal(built[0].closed, 1);
  await reader.dispose();
  assert.equal(built[1].closed, 1);
});

test("createFleetReader builds nothing once disposed: a read that follows finds the held queue, and a new name is refused", async () => {
  const { built, mk } = endingQueues();
  let hosts = [];
  const reader = endingReader(mk, () => hosts);
  await reader.snapshot();
  await settle();
  await reader.dispose();
  built[0].end();
  await reader.snapshot();
  assert.equal(built.length, 1, "an ended queue past dispose is not replaced: its live client would outlive the stop");
  hosts = [{ name: "hostb", routes: true }];
  await assert.rejects(reader.snapshot(), /this fleet reader has been disposed/);
  assert.equal(built.length, 1);
});

test("createFleetReader: a read in flight across dispose builds nothing when it comes back", async () => {
  const { built, mk } = endingQueues();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const logsDir = tempDir("pd-ended-queue-");
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") },
    { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: readyRedis, readLiveHostsFn: async () => { await held; return { hosts: [] }; }, discoverHostQueuesFn: async () => [], nowFn: () => 1_800_000_000_000, readOnly: true },
  );
  await settle();
  const reading = reader.snapshot().catch(() => {});
  await settle();
  built[0].end();
  await settle();
  await reader.dispose();
  release();
  await reading;
  assert.equal(built.length, 1);
});

test("createFleetReader replaces a queue whose connection never came up: its client promise rejected", async () => {
  const { built, mk } = endingQueues();
  const refusing = (conn, opts) => {
    const q = mk(conn, opts);
    if (built.length === 1) {
      q.client = Promise.reject(new Error("nothing answers VALKEY_URL"));
      q.isPaused = async () => { throw new Error("nothing answers VALKEY_URL"); };
    }
    return q;
  };
  const reader = endingReader(refusing);
  await settle();
  const healed = await reader.snapshot();
  assert.equal(built.length, 2, "the next read builds a queue again, so a Valkey that came up is seen");
  assert.equal(healed.queue.counts.waiting, 0);
});

test("createFleetReader: a client that had already ended when it was first looked at counts as ended", async () => {
  const { built, mk } = endingQueues();
  const ended = (conn, opts) => {
    const q = mk(conn, opts);
    if (built.length === 1) q.client = Promise.resolve({ status: "end", once() { assert.fail("an ended client emits nothing more"); } });
    return q;
  };
  const reader = endingReader(ended);
  await settle();
  await reader.snapshot();
  assert.equal(built.length, 2);
});

test("createFleetReader: a queue built with no client at all (a surface's own seam) is simply held", async () => {
  const q = { name: "pi-jobs", async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {} };
  let built = 0;
  const reader = endingReader(() => { built += 1; return q; });
  await settle();
  await reader.snapshot();
  await reader.snapshot();
  assert.equal(built, 1);
});

test("createFleetReader: the raw client is bounded and judged afresh, so a stale verdict cannot hang a page", async () => {
  let options = null;
  const logsDir = tempDir("pd-ended-queue-");
  const held = { on() {} };
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") },
    { makeQueueFn: () => ({ name: "pi-jobs" }), parseConnectionFn: () => ({}), redisFn: (_url, opts) => { options = opts; return held; }, readOnly: true },
  );
  assert.equal(options.freshContext, true);
  assert.equal(options.commandTimeoutMs, 5_000, "longer than the reads this reader bounds itself, and short enough to be read as a page's wait");
  // Issue #845: the database the held client was refused, for the console's restart banner; it never tries it again.
  const { DB_REFUSED } = await import("@edgehero/pi-dispatch/connection");
  assert.equal(reader.refusedDatabase(), null);
  held[DB_REFUSED] = new Error("refused");
  held.condition = { select: 16 };
  assert.deepEqual(reader.refusedDatabase(), { db: 16 });
  // And whether it holds back a changed password (`passwordDeclinedOf`, review of PR #878): a decline recorded by a
  // reconnect, while the .env as it is now still gives a password for a Valkey this client does not dial as it dials it.
  const { useValkeyContext } = await import("@edgehero/pi-dispatch/connection");
  assert.equal(reader.passwordDeclined(), false);
  const context = { envPath: "/d/.env", error: null, absent: false, password: { environment: null, file: "the-files-new-password" }, url: { environment: "redis://localhost:6379", file: "redis://127.0.0.1:6379" } };
  held.connector = { [Symbol.for("pi-dispatch.valkey-password-declined")]: true, options: { password: "the-held-password", piDispatchValkeyJudge: { url: "redis://localhost:6379", freshPassword: true, context } } };
  useValkeyContext(() => context);
  try {
    assert.equal(reader.passwordDeclined(), true);
    useValkeyContext(() => ({ ...context, password: { environment: null, file: "the-held-password" } }));
    assert.equal(reader.passwordDeclined(), false, "the file back to the held password");
  } finally {
    useValkeyContext(null);
  }
});

test("createFleetReader on a real raw client that cannot connect: a healthy queue's snapshot still ends, where a raw read used to hang it", { timeout: 15000 }, async () => {
  const { makeRedisClient } = await import("@edgehero/pi-dispatch/connection");
  const { mk } = endingQueues();
  const logsDir = tempDir("pd-ended-queue-");
  const reader = createFleetReader(
    { valkeyUrl: "redis://127.0.0.1:1", logsDir, triggersPath: join(logsDir, "none.json") },
    {
      makeQueueFn: mk,
      parseConnectionFn: () => ({}),
      redisFn: (url, opts) => makeRedisClient(url, { ...opts, commandTimeoutMs: 40, context: {}, judge: async () => { throw new Error("refused by a stale .env verdict"); } }),
      readLiveHostsFn: async () => ({ hosts: [] }),
      discoverHostQueuesFn: async () => [],
      nowFn: () => 1_800_000_000_000,
      readOnly: true,
    },
  );
  let wait;
  try {
    // A race and not a bare await: without the bound the read never ends, and neither would this file, on a client the
    // `finally` below never got to let go.
    const answer = await Promise.race([reader.snapshot().then(() => "answered", (err) => err.message), new Promise((resolve) => { wait = setTimeout(resolve, 5000, "no answer"); })]);
    assert.match(answer, /Command timed out/);
  } finally {
    clearTimeout(wait);
    await reader.dispose();
  }
});

test("createFleetReader's sandboxEnd leaves each command to its client's bound, with no shorter timer of its own (issue #843)", async () => {
  const logsDir = tempDir("pd-sandbox-end-");
  const asked = [];
  const redis = { on() {}, disconnect() {} };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, { makeQueueFn: () => ({ name: "pi-jobs", close: async () => {} }), parseConnectionFn: () => ({}), redisFn: () => redis, readOnly: true, requestSandboxEndFn: async (request) => { asked.push(request); return { ended: true }; } });
  try {
    assert.deepEqual(await reader.sandboxEnd({ host: "mini1", id: "gh-1", nonce: "a".repeat(32), containerId: "b".repeat(64) }), { ended: true });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].redis, redis, "on the bounded client, whose error says whether a command was sent");
    assert.equal(asked[0].timeoutMs, null, "a timer that fires first rejects with an error that cannot say");
  } finally {
    await reader.dispose();
  }
});

test("createFleetReader's cancelActive takes back a request whose answer was lost, in order, and leaves an answered one alone", async () => {
  const cancelling = (set, get) => {
    const sent = [];
    const logsDir = tempDir("pd-ended-queue-");
    const redis = { on() {}, disconnect() {}, async set(key) { sent.push(["set", key]); return set(); }, async get(key) { sent.push(["get", key]); return get(); }, async del(key) { sent.push(["del", key]); throw new Error("Command timed out"); } };
    const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, { makeQueueFn: () => ({ name: "pi-jobs", close: async () => {} }), parseConnectionFn: () => ({}), redisFn: () => redis, readOnly: true });
    return { sent, reader };
  };
  const timedOut = () => { throw new Error("Command timed out"); };
  const refused = cancelling(timedOut, () => null);
  await assert.rejects(refused.reader.cancelActive({ jobId: "gh-1" }), /Command timed out/);
  await settle();
  assert.deepEqual(refused.sent, [["set", "cancel:req:gh-1"], ["del", "cancel:req:gh-1"]]);
  const lost = cancelling(() => "OK", timedOut);
  await assert.rejects(lost.reader.cancelActive({ jobId: "gh-1", interventionOrigin: "agent" }), (err) => err.valkeyMayStillRun === true);
  await settle();
  assert.deepEqual(lost.sent, [["set", "cancel:agent:req:gh-1"], ["get", "cancel:agent:ack:gh-1"], ["del", "cancel:agent:req:gh-1"]]);
  const answered = cancelling(() => "OK", () => "mini1");
  assert.deepEqual(await answered.reader.cancelActive({ jobId: "gh-1" }), { ack: "mini1" });
  await settle();
  assert.deepEqual(answered.sent.map(([op]) => op), ["set", "get"], "an answered request is the worker's to consume");
});

test("createFleetReader: a replacement that cannot be built while the snapshot's reads start costs the worker list, and orphans none of them", async () => {
  const { built, mk } = endingQueues();
  let refuse = false;
  const reader = endingReader(mk, [], { parseConnectionFn: () => { if (refuse) throw new Error("the context could not be read"); return {}; } });
  await reader.snapshot();
  await settle();
  // The first read of the list ends the client, so the worker read, next in the list, finds it ended and has to replace it.
  built[0].isPaused = async () => false;
  const isPaused = built[0].isPaused;
  built[0].isPaused = () => { built[0].end(); refuse = true; return isPaused(); };
  const got = await reader.snapshot();
  assert.deepEqual(got.workers ?? [], []);
  assert.equal(built.length, 1, "nothing could be built, and the snapshot still ended");
});

test("createFleetReader: closing a replaced queue that refuses to close goes nowhere", async () => {
  const { built, mk } = endingQueues();
  const unhandled = [];
  const note = (err) => unhandled.push(err);
  process.on("unhandledRejection", note);
  try {
    const reader = endingReader(mk);
    await reader.snapshot();
    await settle();
    built[0].close = async () => { throw new Error("close refused"); };
    built[0].end();
    await reader.snapshot();
    await settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(built.length, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", note);
  }
});

test("createFleetReader: a queue only the keyspace names, as the kill switch reads it, is replaced too once its client ended", async () => {
  const { built, mk } = endingQueues();
  const reader = endingReader(mk, [], { discoverHostQueuesFn: async () => ["pi-jobs@stopped"] });
  await reader.snapshot({ switchQueues: true });
  await settle();
  const first = built.find((q) => q.name === "pi-jobs@stopped");
  assert.ok(first);
  first.end();
  await settle();
  await reader.snapshot({ switchQueues: true });
  await settle();
  assert.equal(built.filter((q) => q.name === "pi-jobs@stopped").length, 2);
  assert.equal(first.closed, 1);
});

// Issue #842: the reader's kill switch, its one-queue switch and its dispose on a Valkey that is connected and stopped
// answering. A queue here never answers, and each of the three ends by its own bound.
const never = () => new Promise(() => {});
const orHung = (promise, ms = 2000) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms, "hung")))]).finally(() => clearTimeout(timer));
};
/** `endingQueues` whose queues take a pause and a resume: `asked` lists them, `answer(name, verb)` decides each. */
function switchQueues(answer = () => Promise.resolve()) {
  const { built, mk } = endingQueues();
  const asked = [];
  const make = (conn, opts) => {
    const q = mk(conn, opts);
    q.dropped = 0;
    q.pause = () => (asked.push(`pause ${q.name}`), answer(q.name, "pause"));
    q.resume = () => (asked.push(`resume ${q.name}`), answer(q.name, "resume"));
    q.disconnect = () => { q.dropped += 1; };
    return q;
  };
  return { built, asked, mk: make };
}

test("createFleetReader: a fleet pause reaches every held queue at once and answers while discovery and one queue never do (#842)", async () => {
  let frozen = false;
  const { built, asked, mk } = switchQueues((name) => (frozen && name === "pi-jobs@hostb" ? never() : Promise.resolve()));
  const reader = endingReader(mk, [{ name: "hostb", routes: true }], {
    readLiveHostsFn: () => (frozen ? never() : Promise.resolve({ hosts: [{ name: "hostb", routes: true }] })),
    discoverHostQueuesFn: () => (frozen ? never() : Promise.resolve([])),
    switchStepTimeoutMs: 80,
    closeTimeoutMs: 30,
  });
  await reader.snapshot();
  await settle();
  frozen = true;
  const pending = reader.pause();
  await settle();
  assert.deepEqual(asked, ["pause pi-jobs", "pause pi-jobs@hostb"], "both pauses were sent before the registry or the scan answered");
  const res = await orHung(pending);
  assert.notEqual(res, "hung", "the kill switch answered");
  assert.deepEqual(res.results[0].res, {
    unreachable: "no answer within 0.08 seconds",
    partial: { done: ["pi-jobs"], failed: "pi-jobs@hostb", error: "no answer within 0.08 seconds", unconfirmed: ["pi-jobs@hostb"], refused: [], notTried: [] },
    incomplete: SWITCH_SCAN_INCOMPLETE,
  });
  assert.equal(built.length, 2, "through the held pool: no queue was built for the pause");
  assert.equal(built[1].closed, 0, "a pause that was not answered is left to land");
  frozen = false;
  await reader.dispose();
});

test("createFleetReader: a fleet pause also pauses what discovery names beyond the held queues, and a whole answer keeps its shape (#842)", async () => {
  const { asked, mk } = switchQueues();
  const reader = endingReader(mk, [], { discoverHostQueuesFn: async () => ["pi-jobs@stopped"] });
  const res = await reader.pause();
  assert.deepEqual(res.results[0].res, { ok: true, paused: true, queues: ["pi-jobs", "pi-jobs@stopped"] });
  assert.deepEqual(asked, ["pause pi-jobs", "pause pi-jobs@stopped"]);
  await reader.dispose();
});

// Issue #964: a console started while Valkey does not answer knows `pi-jobs` alone. Its kill switch also flips this
// host's own queue, which the surface hands it (`ownQueueNamesFn`, the deployment `.env`'s PI_WORKER_NAME), on the Valkey
// the kill switch's plan names as the deployment's and on no other.
test("createFleetReader: a fleet pause and resume on a Valkey that does not answer also reach this host's own queue, at once (#964)", async () => {
  const { asked, mk } = switchQueues();
  const frozenReader = (names, make = mk, seams = {}) => endingReader(make, [], { ownQueueNamesFn: () => names, readLiveHostsFn: never, discoverHostQueuesFn: never, switchStepTimeoutMs: 80, closeTimeoutMs: 30, ...seams });
  const reader = frozenReader(["pi-jobs@hosta"]);
  const pending = reader.pause();
  await settle();
  assert.deepEqual(asked, ["pause pi-jobs", "pause pi-jobs@hosta"], "the own queue is in the first set a pause flips, sent before discovery could answer");
  const paused = await orHung(pending);
  assert.deepEqual(paused.results[0].res, { ok: true, paused: true, queues: ["pi-jobs", "pi-jobs@hosta"], incomplete: SWITCH_SCAN_INCOMPLETE }, "and the set is said to be possibly short");
  asked.length = 0;
  const resumed = await orHung(reader.resume());
  assert.deepEqual(resumed.results[0].res, { ok: true, paused: false, queues: ["pi-jobs", "pi-jobs@hosta"], incomplete: SWITCH_SCAN_INCOMPLETE });
  assert.deepEqual(asked, ["resume pi-jobs", "resume pi-jobs@hosta"]);
  await reader.dispose();
  // A resume first, on a console that never paused, whose discovery does not answer: the own queue is left alone, since a
  // queue nobody found may not exist, has then nothing to resume, and a queue built to resume it writes its meta key.
  const fresh = switchQueues();
  const resumer = frozenReader(["pi-jobs@hosta"], fresh.mk);
  assert.deepEqual((await orHung(resumer.resume())).results[0].res.queues, ["pi-jobs"]);
  assert.deepEqual(fresh.asked, ["resume pi-jobs"]);
  assert.ok(!fresh.built.some((q) => q.name === "pi-jobs@hosta"), "no queue was built for it");
  await resumer.dispose();
  // Where discovery found it, a resume reaches it.
  const known = switchQueues();
  const awakeResumer = endingReader(known.mk, [], { ownQueueNamesFn: () => ["pi-jobs@hosta"], discoverHostQueuesFn: async () => ["pi-jobs@hosta"] });
  assert.deepEqual((await awakeResumer.resume()).results[0].res.queues, ["pi-jobs", "pi-jobs@hosta"]);
  await awakeResumer.dispose();
  // No own queue handed in, or a name that is not a host queue's, adds none.
  for (const names of [[], ["pi-jobs-other"], null]) {
    const other = switchQueues();
    const plain = frozenReader(names, other.mk);
    assert.deepEqual((await orHung(plain.pause())).results[0].res.queues, ["pi-jobs"], JSON.stringify(names));
    assert.deepEqual(other.asked, ["pause pi-jobs"]);
    await plain.dispose();
  }
  // The plan names another Valkey as the deployment's (this reader's is the shell's, on a disagreement): the own queue is
  // not flipped here, neither at once nor by the fallback.
  const shell = switchQueues();
  const onShell = frozenReader(["pi-jobs@hosta"], shell.mk, { killSwitchPlanFn: () => ({ urls: ["redis://unused"], deploymentUrl: "redis://the-env-one/0", disagreement: null, context: null }) });
  assert.deepEqual((await orHung(onShell.pause())).results[0].res.queues, ["pi-jobs"]);
  assert.deepEqual(shell.asked, ["pause pi-jobs"]);
  await onShell.dispose();
  // Nor by a discovery that answers: neither the switch's set, its preview, nor one queue's pause names it here.
  const answered = switchQueues();
  const awake = endingReader(answered.mk, [], { ownQueueNamesFn: () => ["pi-jobs@hosta"], killSwitchPlanFn: () => ({ urls: ["redis://unused"], deploymentUrl: "redis://the-env-one/0", disagreement: null, context: null }) });
  assert.deepEqual((await awake.snapshot({ switchQueues: true })).switchUnread, []);
  assert.deepEqual((await awake.pause()).results[0].res.queues, ["pi-jobs"]);
  assert.match((await awake.pauseQueue({ queue: "pi-jobs@hosta", paused: true })).invalid, /is not a queue this deployment drains/);
  assert.deepEqual(answered.asked, ["pause pi-jobs"]);
  await awake.dispose();
});

test("createFleetReader: this host's own queue is in the switch's set by name, never read where no discovery named it, and never in a plain snapshot (#964)", async () => {
  const { built, asked, mk } = switchQueues();
  const reader = endingReader(mk, [], { ownQueueNamesFn: () => ["pi-jobs@hosta"] });
  await reader.snapshot();
  await settle();
  assert.deepEqual(built.map((q) => q.name), ["pi-jobs"], "every snapshot reads `lastNames`, and the own queue is not one of them");
  const preview = await reader.snapshot({ switchQueues: true });
  // A queue built to read it would write its meta key: named, flipped, not read.
  assert.deepEqual([preview.queueCounts.map((q) => q.queue), preview.switchUnread, preview.switchTotal, preview.switchTruncated], [["pi-jobs"], ["pi-jobs@hosta"], 2, false]);
  assert.deepEqual(built.map((q) => q.name), ["pi-jobs"], "no queue was built for it");
  assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@hosta", paused: true }), { ok: true, paused: true, queue: "pi-jobs@hosta" }, "a press for it is a queue this deployment drains");
  assert.deepEqual(asked, ["pause pi-jobs@hosta"]);
  await reader.dispose();
  // Where discovery names it, it is read like any other.
  const named = switchQueues();
  const found = endingReader(named.mk, [], { ownQueueNamesFn: () => ["pi-jobs@hosta"], discoverHostQueuesFn: async () => ["pi-jobs@hosta"] });
  const read = await found.snapshot({ switchQueues: true });
  assert.deepEqual([read.queueCounts.map((q) => q.queue), read.switchUnread], [["pi-jobs", "pi-jobs@hosta"], []]);
  await found.dispose();
});

test("createFleetReader: a fleet resume stops at the first queue that does not answer, names the rest not tried, and closes a queue that was not connected in time (#842)", async () => {
  let frozen = false;
  const { built, asked, mk } = switchQueues((name) => (frozen && name === "pi-jobs@hostb" ? never() : Promise.resolve()));
  const reader = endingReader(mk, [{ name: "hostb", routes: true }], { discoverHostQueuesFn: async () => ["pi-jobs@stopped"], switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  await reader.snapshot({ switchQueues: true });
  await settle();
  frozen = true;
  const res = await orHung(reader.resume());
  assert.notEqual(res, "hung");
  assert.deepEqual(asked, ["resume pi-jobs", "resume pi-jobs@hostb"], "nothing is sent past the lost answer");
  assert.deepEqual(res.results[0].res.partial, { done: ["pi-jobs"], failed: "pi-jobs@hostb", error: "no answer within 0.08 seconds", unconfirmed: ["pi-jobs@hostb"], refused: [], notTried: ["pi-jobs@stopped"] });
  const hostb = built.find((q) => q.name === "pi-jobs@hostb");
  assert.equal(hostb.closed, 1, "closed, so its resume is not sent whenever its connection comes up");
  frozen = false;
  await reader.snapshot();
  await settle();
  assert.equal(built.filter((q) => q.name === "pi-jobs@hostb").length, 2, "and replaced at the next read");
  await reader.dispose();
});

test("createFleetReader: a fleet resume whose discovery does not answer names the queues it holds beyond the registry's as not tried (#842)", async () => {
  let frozen = false;
  const { asked, mk } = switchQueues(() => (frozen ? never() : Promise.resolve()));
  const reader = endingReader(mk, [], {
    readLiveHostsFn: () => (frozen ? never() : Promise.resolve({ hosts: [{ name: "hostb", routes: true }] })),
    discoverHostQueuesFn: () => (frozen ? never() : Promise.resolve(["pi-jobs@stopped"])),
    switchStepTimeoutMs: 80,
    closeTimeoutMs: 30,
  });
  await reader.snapshot({ switchQueues: true });
  await settle();
  frozen = true;
  const res = await orHung(reader.resume());
  assert.notEqual(res, "hung", "neither the registry, the scan nor the queue answered, and the resume still did");
  assert.deepEqual(asked, ["resume pi-jobs"]);
  assert.deepEqual({ ...res.results[0].res, unreachable: null }, {
    unreachable: null,
    partial: { done: [], failed: "pi-jobs", error: "no answer within 0.08 seconds", unconfirmed: ["pi-jobs"], refused: [], notTried: ["pi-jobs@hostb", "pi-jobs@stopped"] },
    incomplete: SWITCH_SCAN_INCOMPLETE,
  });
  frozen = false;
  await reader.dispose();
});

test("createFleetReader: one queue's pause goes through the held pool, and a lost answer says may or may not (#842)", async () => {
  let lost = null;
  const { built, asked, mk } = switchQueues(() => (lost ? lost() : Promise.resolve()));
  const reader = endingReader(mk, [{ name: "hostb", routes: true }], { discoverHostQueuesFn: async () => ["pi-jobs@stopped"], switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  await reader.snapshot();
  await settle();
  assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true }), { ok: true, paused: true, queue: "pi-jobs@hostb" });
  assert.equal(built.length, 2, "the queue the reader holds, not a one-shot built for the click");
  // A queue the pool does not hold yet is checked against the kill switch's set: a real one is flipped, a mistyped one refused.
  assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@stopped", paused: false }), { ok: true, paused: false, queue: "pi-jobs@stopped" });
  const ghost = await reader.pauseQueue({ queue: "pi-jobs@ghost", paused: true });
  assert.equal(ghost.invalid, '"pi-jobs@ghost" is not a queue this deployment drains (pi-jobs, pi-jobs@hostb, pi-jobs@stopped). Nothing was changed');
  assert.ok(!built.some((q) => q.name === "pi-jobs@ghost"), "and no queue is built for it");
  assert.deepEqual(asked, ["pause pi-jobs@hostb", "resume pi-jobs@stopped"]);
  for (const answer of [never, () => Promise.reject(Object.assign(new Error("Command timed out"), { valkeyMayStillRun: true }))]) {
    lost = answer;
    const res = await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true }));
    assert.deepEqual(res, { invalid: queueSwitchUnconfirmed("pi-jobs@hostb", true), partial: true });
  }
  lost = () => Promise.reject(new Error("refused before send"));
  assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true }), { unreachable: "refused before send" });
  assert.deepEqual([await reader.pauseQueue({ queue: "", paused: true }), await reader.pauseQueue({ queue: "pi-jobs", paused: "yes" })], [{ invalid: "a queue name is required" }, { invalid: "paused must be true or false" }]);
  lost = null;
  await reader.dispose();
});

test("createFleetReader: one queue's pause or resume Valkey answers with an error after its script may have run says what the queue reads now, never that nothing changed (#1014)", async () => {
  // A Lua script is not rolled back, and BullMQ's XADD to the events stream comes after the switch, so an error reply
  // there follows a switch that happened. Valkey's own words, measured; `reads` is what a read back of the queue answers.
  const inScript = "WRONGTYPE Operation against a key holding the wrong kind of value script: b4514f4b39660691beec2ab3023b9b46b093b439, on @user_script:57.";
  const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
  let error = inScript;
  let reads = true;
  const conns = [];
  const { built, mk } = switchQueues(() => Promise.reject(reply(error)));
  const make = (conn, opts) => Object.assign(mk(conn, opts), { isPaused: async () => reads });
  const reader = endingReader(make, [{ name: "hostb", routes: true }], { switchStepTimeoutMs: 80, closeTimeoutMs: 30, parseConnectionFn: (_url, options) => (conns.push(options), {}) });
  await reader.snapshot();
  await settle();
  assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true })), { invalid: queueSwitchErrored("pi-jobs@hostb", true, "paused"), partial: true });
  assert.equal(queueSwitchErrored("pi-jobs@hostb", true, "paused"), "Valkey answered the pause of pi-jobs@hostb with an error; it reads paused now. Look at the fleet");
  // The dangerous direction: a resume answered with an error that left the queue running.
  reads = false;
  assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: false })), { invalid: queueSwitchErrored("pi-jobs@hostb", false, "running"), partial: true });
  assert.equal(queueSwitchErrored("pi-jobs@hostb", true, "running"), "Valkey answered the pause of pi-jobs@hostb with an error; it reads running now, and part of the pause may have applied. Look at the fleet");
  // Refused before the script ran: the queue did not change, and the answer is the unreachable it always was.
  error = "NOPERM User op has no permissions to run the 'evalsha' command";
  assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true })), { unreachable: error });
  assert.ok(built.length >= 2 && conns.length === built.length && conns.every((c) => c.failFast === true && c.commandTimeoutMs === 5000), "the reader's queues are the console's bounded kind");
  assert.equal(queueSwitchUnconfirmed("pi-jobs@hostb", true), "the pause of pi-jobs@hostb may or may not have been made: Valkey did not answer it within the bound. Look at the fleet once Valkey answers");
  await reader.dispose();
});

test("createFleetReader: one queue's pause whose read back Valkey answers with an error too says it may have partly applied, and one whose read back gets no answer says not confirmed (#1041)", async () => {
  const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
  const inScript = "WRONGTYPE Operation against a key holding the wrong kind of value script: b4514f4b39660691beec2ab3023b9b46b093b439, on @user_script:57.";
  let read = async () => false;
  const { mk } = switchQueues(() => Promise.reject(reply(inScript)));
  const reader = endingReader((conn, opts) => Object.assign(mk(conn, opts), { isPaused: () => read() }), [{ name: "hostb", routes: true }], { switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  await reader.snapshot();
  await settle();
  // The pause's script fails after it moved the jobs, and the read back of the queue fails on the same key.
  read = () => Promise.reject(reply("WRONGTYPE Operation against a key holding the wrong kind of value"));
  for (const paused of [true, false]) assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused })), { invalid: queueSwitchErrored("pi-jobs@hostb", paused, "unknown"), partial: true });
  assert.equal(queueSwitchErrored("pi-jobs@hostb", true, "unknown"), "Valkey answered the pause of pi-jobs@hostb with an error; its state could not be read, so it may have partly applied. Look at the fleet");
  // A read back whose connection was lost got no answer: the pause may or may not have been made.
  read = () => Promise.reject(Object.assign(new Error("Connection is closed."), { valkeyMayStillRun: true }));
  assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true })), { invalid: queueSwitchUnconfirmed("pi-jobs@hostb", true), partial: true });
  await reader.dispose();
});

test("createFleetReader: one queue's switch over a registry it could not read refuses a name it does not find, saying the list may be short", async () => {
  const { built, mk } = switchQueues();
  const reader = endingReader(mk, [], { readLiveHostsFn: async () => ({ unreachable: "registry down" }) });
  await reader.snapshot();
  await settle();
  assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@gone", paused: true }), { invalid: "\"pi-jobs@gone\" is not a queue this deployment drains (pi-jobs); the host registry could not be read, so a host's queue may be missing from that list. Nothing was changed" });
  assert.ok(!built.some((q) => q.name === "pi-jobs@gone"), "and no queue is built for it");
  await reader.dispose();
});

test("createFleetReader on a real Valkey: one queue is paused and resumed alone, a name it does not drain is refused with no queue made, and a script that fails after the switch is said as Valkey holds it (#1014, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { makeQueue } = await import("@edgehero/pi-dispatch/queue");
  const { makeRedisClient } = await import("@edgehero/pi-dispatch/connection");
  // Every queue the reader names is one of this test's own (its name prefixed), so no other test's queue is paused.
  const prefix = `pd1014q-${process.pid}-${Date.now()}-`;
  const direct = makeRedisClient(URL_);
  direct.on("error", () => {});
  const logsDir = tempDir("pd-1014-queue-");
  writeFileSync(join(logsDir, "triggers.json"), '{ "triggers": [] }\n');
  const asked = (connection, opts) => {
    const name = opts?.name ?? "pi-jobs";
    const queue = makeQueue(connection, { name: `${prefix}${name}` });
    return new Proxy(queue, { get: (target, key) => (key === "name" ? name : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  };
  const reader = createFleetReader({ valkeyUrl: URL_, logsDir, triggersPath: join(logsDir, "triggers.json") }, {
    makeQueueFn: asked, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => ({ names: ["pi-jobs@mini1", "pi-jobs@mini2"] }), readOnly: true,
  });
  const paused = (name) => direct.hexists(`bull:${prefix}${name}:meta`, "paused");
  try {
    assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@mini1", paused: true }), { ok: true, paused: true, queue: "pi-jobs@mini1" });
    assert.deepEqual([await paused("pi-jobs@mini1"), await paused("pi-jobs")], [1, 0], "that queue alone");
    const ghost = await reader.pauseQueue({ queue: "pi-jobs@ghost", paused: true });
    assert.match(ghost.invalid, /"pi-jobs@ghost" is not a queue this deployment drains \(pi-jobs, pi-jobs@mini1, pi-jobs@mini2\)\. Nothing was changed/);
    assert.equal(await direct.exists(`bull:${prefix}pi-jobs@ghost:meta`), 0, "no phantom queue was made by the refusal");
    assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@mini1", paused: false }), { ok: true, paused: false, queue: "pi-jobs@mini1" });
    assert.equal(await paused("pi-jobs@mini1"), 0);
    // pause-7.lua moves the jobs and flips the flag, then XADDs to the events stream: a string there fails it after.
    await direct.set(`bull:${prefix}pi-jobs@mini2:events`, "not a stream");
    assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@mini2", paused: true }), { invalid: queueSwitchErrored("pi-jobs@mini2", true, "paused"), partial: true });
    assert.equal(await paused("pi-jobs@mini2"), 1, "paused, as said");
    assert.deepEqual(await reader.pauseQueue({ queue: "pi-jobs@mini2", paused: false }), { invalid: queueSwitchErrored("pi-jobs@mini2", false, "running"), partial: true });
    assert.equal(await paused("pi-jobs@mini2"), 0, "running again, as said: the dangerous direction");
  } finally {
    await reader.dispose();
    let cursor = "0";
    do {
      const [next, keys] = await direct.scan(cursor, "MATCH", `bull:${prefix}*`, "COUNT", 500);
      cursor = String(next);
      if (keys.length > 0) await direct.del(...keys);
    } while (cursor !== "0");
    direct.disconnect();
  }
});

// Issue #986: the real reader, BullMQ and ioredis over a proxy that holds the bytes both ways and passes them on a thaw, as
// `kill -STOP` and `kill -CONT` leave a Valkey. Each command's bound is shortened here (the console's is 5 s).
const FREEZE_BOUND_MS = 400;

/**
 * A fleet reader over the freezing proxy: real queues through `makeQueue`, each under a name of this test's own (the
 * reader sees the plain name), what every queue heard as an error, and a registry the test sets. `seed` puts one schedule
 * into a host's queue past the proxy; `cleanup` disposes the reader and deletes this test's queue keys.
 */
async function readerOverProxy(tag) {
  const { makeQueue } = await import("@edgehero/pi-dispatch/queue");
  const { makeRedisClient, parseConnection } = await import("@edgehero/pi-dispatch/connection");
  const { freezingProxy } = await import("../../worker/test/helpers/freezing-proxy.mjs");
  const prefix = `pd986${tag}-${process.pid}-${Date.now()}-`;
  const proxy = await freezingProxy(URL_);
  const direct = makeRedisClient(URL_);
  direct.on("error", () => {});
  const logsDir = tempDir(`pd-986-${tag}-`);
  writeFileSync(join(logsDir, "triggers.json"), '{ "triggers": [] }\n');
  const queues = new Map();
  const heard = [];
  const built = [];
  const asked = (connection, opts) => {
    const name = opts?.name ?? "pi-jobs";
    const queue = makeQueue(connection, { name: `${prefix}${name}` });
    queue.removeAllListeners("error");
    queue.on("error", (err) => heard.push(`${name}: ${err.message}`));
    queues.set(name, queue);
    built.push(name);
    return new Proxy(queue, { get: (target, key) => (key === "name" ? name : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  };
  const bounded = (options = {}) => ({ ...options, ...(options.commandTimeoutMs ? { commandTimeoutMs: FREEZE_BOUND_MS } : {}) });
  const fleet = { registry: async () => ({ hosts: [] }) };
  const reader = createFleetReader({ valkeyUrl: proxy.url, logsDir, triggersPath: join(logsDir, "triggers.json") }, {
    makeQueueFn: asked,
    parseConnectionFn: (url, options) => parseConnection(url, bounded(options)),
    redisFn: (url, options) => makeRedisClient(url, bounded(options)),
    readLiveHostsFn: () => fleet.registry(),
    discoverHostQueuesFn: async () => ({ names: [] }),
    nowFn: () => AT,
    readOnly: true,
  });
  const seed = async (host, id) => {
    const queue = makeQueue(parseConnection(URL_, { failFast: true }), { name: `${prefix}pi-jobs@${host}` });
    try {
      await queue.upsertJobScheduler(id, { pattern: "0 3 * * *" }, { name: "local", data: {} });
    } finally {
      await queue.close();
    }
  };
  const cleanup = async () => {
    proxy.thaw();
    await reader.dispose();
    let cursor = "0";
    do {
      const [next, keys] = await direct.scan(cursor, "MATCH", `bull:${prefix}*`, "COUNT", 500);
      cursor = String(next);
      if (keys.length > 0) await direct.del(...keys);
    } while (cursor !== "0");
    direct.disconnect();
    proxy.close();
  };
  return { reader, proxy, direct, prefix, queues, heard, built, fleet, seed, cleanup };
}

/** Resolves once `seen()` is true; a failure of its own after `ms`. */
async function soon(seen, ms = 5_000) {
  const until = Date.now() + ms;
  while (!seen()) {
    assert.ok(Date.now() < until, "not seen within the test's own limit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("createFleetReader on a real Valkey: a first snapshot that fell in a freeze rejects, and the next one answers once Valkey does, from the same queue (#986, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const r = await readerOverProxy("first");
  try {
    // A console started on a Valkey that answers, which has drawn no page yet: its queue is connected and has read nothing.
    await r.queues.get("pi-jobs").waitUntilReady();
    r.proxy.freeze();
    await assert.rejects(r.reader.snapshot(), /Command timed out/);
    // The scheduler child's own INFO ended at the bound too: what kept every later snapshot rejecting.
    await soon(() => r.heard.length > 0);
    assert.deepEqual(r.heard, ["pi-jobs: Command timed out"]);
    r.proxy.thaw();
    const snap = await r.reader.snapshot();
    assert.deepEqual([snap.schedulers, snap.schedulersReadInPart, snap.queueCounts.map((q) => q.queue)], [[], false, ["pi-jobs"]]);
    assert.deepEqual(r.built, ["pi-jobs"], "the queue the reader was built with: its client never ended, so nothing replaced it");
  } finally {
    await r.cleanup();
  }
});

test("createFleetReader on a real Valkey: a host queue first read in a freeze lists its schedules once Valkey answers, where it read as none until a restart (#986, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const r = await readerOverProxy("host");
  const host = `h986-${process.pid}-${Date.now().toString(36)}`;
  try {
    await r.seed(host, "nightly-986");
    // The shared queue has read its schedulers once, so its own child is past its INFO: only the host's queue is new.
    assert.deepEqual((await r.reader.snapshot()).schedulers, []);
    r.fleet.registry = async () => ({ hosts: [{ name: host, routes: true }] });
    // The host's queue is built and connected by a read that asks it for no schedule.
    await r.reader.waiting();
    await r.queues.get(`pi-jobs@${host}`).waitUntilReady();
    r.proxy.freeze();
    await assert.rejects(r.reader.snapshot(), /Command timed out/);
    await soon(() => r.heard.length > 0);
    assert.deepEqual(r.heard, [`pi-jobs@${host}: Command timed out`], "the host queue's scheduler child, and no other");
    r.proxy.thaw();
    const snap = await r.reader.snapshot();
    assert.deepEqual([snap.schedulers.map((s) => s.key), snap.schedulersReadInPart], [["nightly-986"], false]);
    assert.deepEqual(r.built, ["pi-jobs", `pi-jobs@${host}`]);
  } finally {
    await r.cleanup();
  }
});

test("createFleetReader on a real Valkey: schedulersReadInPart while a host queue's schedules cannot be read or the registry was never read, and not on a list that is whole (#986, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { stateOf } = await import("../src/console/live.mjs");
  const r = await readerOverProxy("short");
  const host = `h986-${process.pid}-${Date.now().toString(36)}`;
  const repeatKey = `bull:${r.prefix}pi-jobs@${host}:repeat`;
  const short = (snap) => [snap.schedulers.map((s) => s.key), snap.schedulersReadInPart, stateOf(snap, "viewer", { now: AT }).schedulersReadInPart];
  try {
    await r.seed(host, "nightly-986");
    // Never read: only the shared queue is known, so the host's schedule is not in the list and the list says so.
    r.fleet.registry = async () => { throw new Error("WRONGTYPE"); };
    const never = await r.reader.snapshot();
    assert.deepEqual([...short(never), never.hostsReadAt, Boolean(never.queue.fleetDegraded)], [[], true, true, null, true]);
    // Read: the host's queue is asked, and the list is whole.
    r.fleet.registry = async () => ({ hosts: [{ name: host, routes: true }] });
    assert.deepEqual(short(await r.reader.snapshot()), [["nightly-986"], false, false]);
    // The host queue's scheduler read alone fails (Valkey answers it with an error): the rest of the snapshot is read.
    await r.direct.rename(repeatKey, `${repeatKey}-aside`);
    await r.direct.set(repeatKey, "not a sorted set");
    const lost = await r.reader.snapshot();
    assert.deepEqual([...short(lost), lost.queueCounts.map((q) => q.queue)], [[], true, true, ["pi-jobs", `pi-jobs@${host}`]]);
    // And it answers again.
    await r.direct.rename(`${repeatKey}-aside`, repeatKey);
    assert.deepEqual(short(await r.reader.snapshot()), [["nightly-986"], false, false]);
    // Read before and not now: the queues last seen are still asked, so the list is the fleet's as last seen.
    r.fleet.registry = async () => { throw new Error("timeout"); };
    const seen = await r.reader.snapshot();
    assert.deepEqual([...short(seen), Boolean(seen.queue.fleetDegraded), seen.hostsReadAt], [["nightly-986"], false, false, true, AT]);
  } finally {
    await r.cleanup();
  }
});

test("createFleetReader on a real Valkey: the shared queue's scheduler read that fails fails the snapshot, never a list without its schedules (#986, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const r = await readerOverProxy("shared");
  const repeatKey = `bull:${r.prefix}pi-jobs:repeat`;
  try {
    assert.deepEqual((await r.reader.snapshot()).schedulers, []);
    // Valkey answers the shared queue's scheduler read with an error. A host queue's is kept as not read; this one is not.
    await r.direct.set(repeatKey, "not a sorted set");
    await assert.rejects(r.reader.snapshot(), /WRONGTYPE/);
    await r.direct.del(repeatKey);
    const snap = await r.reader.snapshot();
    assert.deepEqual([snap.schedulers, snap.schedulersReadInPart], [[], false]);
  } finally {
    await r.cleanup();
  }
});

test("createFleetReader: one queue's pause over a registry that could not be read says a host's queue may be missing, never the client's words (#965)", async () => {
  const words = "connect ECONNREFUSED 10.9.8.7:6379";
  const { built, asked, mk } = switchQueues();
  const reader = endingReader(mk, [], { readLiveHostsFn: async () => { throw new Error(words); } });
  const gone = await reader.pauseQueue({ queue: "pi-jobs@gone", paused: true });
  assert.deepEqual(gone, { invalid: "\"pi-jobs@gone\" is not a queue this deployment drains (pi-jobs); the host registry could not be read, so a host's queue may be missing from that list. Nothing was changed" });
  assert.ok(!gone.invalid.includes("10.9.8.7"), "the registry read's own error stays out of a page's sentence");
  assert.deepEqual([built.map((q) => q.name), asked], [["pi-jobs"], []], "no queue was built or flipped for it");
  await reader.dispose();
});

test("createFleetReader: a fleet pause names a held queue discovery no longer finds, and a resume whose registry read failed still reaches the queues it holds (#842)", async () => {
  let registry = () => Promise.resolve({ hosts: [{ name: "hostb", routes: true }] });
  let found = ["pi-jobs@stopped"];
  const { asked, mk } = switchQueues();
  const reader = endingReader(mk, [], { readLiveHostsFn: () => registry(), discoverHostQueuesFn: async () => found });
  await reader.snapshot({ switchQueues: true });
  await settle();
  // Now neither the registry nor the scan names the two host queues the reader holds: a pause still pauses them, and says so.
  registry = () => Promise.resolve({ hosts: [] });
  found = [];
  const paused = (await reader.pause()).results[0].res;
  assert.deepEqual(paused, { ok: true, paused: true, queues: ["pi-jobs", "pi-jobs@hostb", "pi-jobs@stopped"] }, "every queue that was paused is named");
  // A resume with the registry unreadable and a scan that names nothing: the held queues are resumed all the same.
  asked.length = 0;
  registry = () => Promise.resolve({ unreachable: "registry down" });
  const resumed = (await reader.resume()).results[0].res;
  assert.deepEqual(resumed, { ok: true, paused: false, queues: ["pi-jobs", "pi-jobs@hostb", "pi-jobs@stopped"], blind: "registry down" });
  assert.deepEqual(asked, ["resume pi-jobs", "resume pi-jobs@hostb", "resume pi-jobs@stopped"]);
  await reader.dispose();
});

test("createFleetReader: one queue's resume that was not connected in time closes that queue and replaces it; a name whose discovery does not answer is refused within the bound (#842)", async () => {
  let frozen = false;
  const { built, mk } = switchQueues(() => (frozen ? never() : Promise.resolve()));
  const reader = endingReader(mk, [{ name: "hostb", routes: true }], { discoverHostQueuesFn: () => (frozen ? never() : Promise.resolve([])), switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  await reader.snapshot();
  await settle();
  frozen = true;
  const hostb = built.find((q) => q.name === "pi-jobs@hostb");
  assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: false })), { invalid: queueSwitchUnconfirmed("pi-jobs@hostb", false), partial: true });
  await settle();
  assert.equal(hostb.closed, 1, "closed, so its resume is not sent whenever its connection comes up");
  // A queue the reader does not hold needs a discovery, which does not answer: refused within the bound, nothing built.
  const unread = await orHung(reader.pauseQueue({ queue: "pi-jobs@other", paused: true }));
  assert.deepEqual(unread, { unreachable: "the deployment's queues could not be read within the bound" });
  assert.ok(!built.some((q) => q.name === "pi-jobs@other"));
  frozen = false;
  await reader.snapshot();
  await settle();
  assert.equal(built.filter((q) => q.name === "pi-jobs@hostb").length, 2, "and the closed queue is replaced at the next read, not handed out again");
  // A pause that was late is left to land: its queue stays.
  frozen = true;
  const again = built.filter((q) => q.name === "pi-jobs@hostb").at(-1);
  assert.deepEqual(await orHung(reader.pauseQueue({ queue: "pi-jobs@hostb", paused: true })), { invalid: queueSwitchUnconfirmed("pi-jobs@hostb", true), partial: true });
  assert.equal(again.closed, 0);
  frozen = false;
  await reader.dispose();
});

test("createFleetReader: a second Valkey of the kill switch's plan takes the reader's step bound too (#842)", { timeout: 20_000 }, async () => {
  const { createServer } = await import("node:net");
  // A server that takes connections and answers nothing, as a Valkey that stopped answering does.
  const sockets = new Set();
  const silent = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const other = `redis://127.0.0.1:${silent.address().port}`;
  const { mk } = switchQueues();
  const reader = endingReader(mk, [], { killSwitchPlanFn: () => ({ urls: ["redis://unused", other], disagreement: "they disagree", context: null }), switchStepTimeoutMs: 300, closeTimeoutMs: 50 });
  try {
    const started = Date.now();
    const res = await orHung(reader.pause(), 8000);
    assert.notEqual(res, "hung");
    // The fleet read's 2.5 s, then one step of 0.3 s; with the default step it would be 6 s more.
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
    assert.equal(res.results[0].res.ok, true, "the reader's own Valkey was paused meanwhile");
    assert.deepEqual(res.results[1].res.partial, { done: [], failed: "pi-jobs", error: "no answer within 0.3 seconds", unconfirmed: ["pi-jobs"], refused: [], notTried: [] });
  } finally {
    await reader.dispose();
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

test("the fleet reader says of a sandbox request that was not confirmed whether anything but a read had been asked of Valkey, over the worker's own helper (#987)", async () => {
  const { enqueueSandboxPreparation, sandboxPrepareQueueName } = await import("@edgehero/pi-dispatch/sandbox-prepare-requests");
  const { queueWriteTracking } = await import("../src/read-model.mjs");
  const { mk } = switchQueues();
  const lost = () => Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", valkeyMayStillRun: true });
  const request = { op: "pin", id: `sb-${"a".repeat(32)}`, host: "hostb", by: "ops", runId: "gh-1", expect: { generation: "b".repeat(64), until: null, pin: false } };
  // The helper's own steps, in its order: the lookup, the slot's claim on the queue's client, the add, the read back.
  const asked = [];
  const reading = (queue) => {
    const reader = endingReader(mk, [{ name: "hostb", routes: true }], { makeSandboxPrepareQueueFn: () => queue, enqueueSandboxPreparationFn: enqueueSandboxPreparation });
    return reader.sandboxPrepare(request).finally(() => reader.dispose());
  };
  const queueOf = (over = {}) => {
    const jobs = new Map();
    return {
      name: sandboxPrepareQueueName("hostb"),
      getJob: async (id) => (asked.push("getJob"), jobs.get(id)),
      client: Promise.resolve({ set: async () => (asked.push("set"), "OK"), eval: async () => (asked.push("eval"), 1) }),
      add: async (_name, data, opts) => (asked.push("add"), jobs.set(opts.jobId, { id: opts.jobId, data, getState: async () => "waiting" })),
      close: async () => {},
      ...over,
    };
  };
  // Answered at every step: the request is pending, and nothing is said of what was asked.
  assert.deepEqual(await reading(queueOf()), { id: request.id, state: "pending" });
  assert.deepEqual(asked.splice(0), ["getJob", "set", "add", "getJob"]);
  const unknown = { id: request.id, state: "unknown", message: "the host request could not be confirmed; refresh its status before preparing again" };
  // The lookup got no answer: nothing but a read had been asked.
  assert.deepEqual(await reading(queueOf({ getJob: () => (asked.push("getJob"), Promise.reject(lost())) })), { ...unknown, asked: false });
  assert.deepEqual(asked.splice(0), ["getJob"]);
  // The slot's claim was asked for and lost, and so was the add: each may land when Valkey answers again.
  assert.deepEqual(await reading(queueOf({ client: Promise.resolve({ set: () => (asked.push("set"), Promise.reject(lost())) }) })), { ...unknown, asked: true });
  assert.deepEqual(asked.splice(0), ["getJob", "set"]);
  assert.deepEqual(await reading(queueOf({ add: () => (asked.push("add"), Promise.reject(lost())) })), { ...unknown, asked: true });
  assert.deepEqual(asked.splice(0), ["getJob", "set", "add"]);
  // The tracker alone: a queue's lookups change nothing; its add and its client's writes do, a read through that client does not.
  const plain = queueWriteTracking({ name: "q", getJob: async () => null, add: async () => "added", client: Promise.resolve({ get: async () => "v", set: async () => "OK" }) });
  assert.equal(plain.queue.name, "q");
  await plain.queue.getJob("x");
  assert.equal(await (await plain.queue.client).get("k"), "v");
  assert.equal(plain.wrote, false);
  assert.equal(await (await plain.queue.client).set("k", "v"), "OK");
  assert.equal(plain.wrote, true);
  const adding = queueWriteTracking({ add: async () => "added" });
  assert.equal(await adding.queue.add("n", {}), "added");
  assert.equal(adding.wrote, true);
  // It fails closed: only the named lookups change nothing. A call it does not know counts as a write, on the queue and
  // on a job a lookup handed back, so "only looked up", which is what lets a confirm say nothing was changed, is never
  // said of a remove, a pause, a bulk add, a job's update or a method BullMQ adds later.
  const job = () => ({ id: "j1", data: { a: 1 }, getState: async () => "waiting", update: async () => "updated", remove: async () => "removed" });
  const whole = () => ({ name: "q", getJob: async () => job(), getJobCounts: async () => ({ waiting: 1 }), isPaused: async () => false, remove: async () => 1, pause: async () => {}, addBulk: async () => [], upsertJobScheduler: async () => ({}), somethingNew: () => "sync" });
  const looked = queueWriteTracking(whole());
  const found = await looked.queue.getJob("j1");
  assert.deepEqual([found.id, found.data, await found.getState(), await looked.queue.getJobCounts(), await looked.queue.isPaused()], ["j1", { a: 1 }, "waiting", { waiting: 1 }, false]);
  assert.equal(looked.wrote, false, "the lookups, and a job's own");
  for (const method of ["remove", "pause", "addBulk", "upsertJobScheduler", "somethingNew"]) {
    const t = queueWriteTracking(whole());
    await t.queue[method]("x");
    assert.equal(t.wrote, true, `the queue's ${method}`);
  }
  for (const method of ["update", "remove"]) {
    const t = queueWriteTracking(whole());
    assert.equal(await (await t.queue.getJob("j1"))[method]({}), method === "update" ? "updated" : "removed");
    assert.equal(t.wrote, true, `a job's ${method}`);
  }
  // A job out of a LIST is tracked as one handed back alone, and a job's own `queue` is the tracked queue: each was a
  // way to a write that nothing counted.
  const listed = () => ({ ...whole(), getJobs: async () => [job(), job()] });
  const inList = queueWriteTracking(listed());
  const jobs = await inList.queue.getJobs(["waiting"]);
  assert.deepEqual([jobs.length, await jobs[1].getState(), inList.wrote], [2, "waiting", false]);
  assert.equal(await jobs[1].remove(), "removed");
  assert.equal(inList.wrote, true, "a job out of a list");
  const byQueue = queueWriteTracking(whole());
  const handed = await byQueue.queue.getJob("j1");
  assert.equal(handed.queue, byQueue.queue, "a job's queue is the tracked one");
  assert.equal(byQueue.wrote, false);
  assert.equal(await handed.queue.remove("j1"), 1);
  assert.equal(byQueue.wrote, true, "a job's own queue");
});

test("a tracked queue counts AT ITS CLIENT what any object asks of Valkey under its run: a job out of a list, a job's own queue, the connection itself; its lookups and another tracker's commands do not count (#987, VALKEY_TEST_URL)", { skip: live, timeout: 30_000 }, async () => {
  const { makeQueue } = await import("@edgehero/pi-dispatch/queue");
  const { parseConnection } = await import("@edgehero/pi-dispatch/connection");
  const { queueWriteTracking } = await import("../src/read-model.mjs");
  const name = `pd987q-${process.pid}-${Date.now()}`;
  const queue = makeQueue(parseConnection(URL_), { name });
  queue.on("error", () => {});
  const key = `bull:${name}:pd987-own`;
  const fleets = [];
  try {
    for (const id of ["j1", "j2", "j3", "j4"]) await queue.add("n", { id }, { jobId: id });
    // The rule no object path walks around, and FIRST, on a client no tracker has met: the connection the queue holds,
    // which no proxy of this tracker stands before. Its client is the one every path ends in, and `run` itself sees to
    // it that commands are counted there, whether or not the helper ever asks the tracked queue for its client.
    const direct = queueWriteTracking(queue);
    await direct.run(async () => {
      await (await direct.queue.connection.client).set(key, "1", "PX", 60_000);
    });
    assert.deepEqual([direct.wrote, await (await queue.client).get(key)], [true, "1"], "the connection itself");
    // Lookups alone count nothing: on the queue, on a job, on a job out of a list, and a read through the client.
    const looked = queueWriteTracking(queue);
    await looked.run(async () => {
      const one = await looked.queue.getJob("j1");
      const all = await looked.queue.getJobs(["waiting"]);
      assert.deepEqual([await one.getState(), all.length, await all[0].getState(), (await looked.queue.getJobCounts("waiting")).waiting], ["waiting", 4, "waiting", 4]);
      assert.equal(await (await looked.queue.client).exists(key), 1);
    });
    assert.equal(looked.wrote, false, "only looked up");
    // A job out of a list, removed: it was removed with nothing counted.
    const listed = queueWriteTracking(queue);
    await listed.run(async () => {
      const jobs = await listed.queue.getJobs(["waiting"]);
      await jobs.find((j) => j.id === "j1").remove();
    });
    assert.deepEqual([listed.wrote, await queue.getJob("j1")], [true, undefined], "a job out of a list");
    // A job's own queue, asked to remove: the same.
    const owned = queueWriteTracking(queue);
    await owned.run(async () => {
      const job = await owned.queue.getJob("j2");
      await job.queue.remove("j2");
    });
    assert.deepEqual([owned.wrote, await queue.getJob("j2")], [true, undefined], "a job's own queue");
    // A job this tracker did not hand out: the queue it was given, asked directly. Its remove is counted at the client
    // too, and so is its lookup, which the tracker cannot know for one: fail closed.
    const raw = queueWriteTracking(queue);
    await raw.run(async () => {
      await (await queue.getJob("j3")).remove();
    });
    assert.deepEqual([raw.wrote, await queue.getJob("j3")], [true, undefined], "a job of the queue itself");
    const rawLookup = queueWriteTracking(queue);
    await rawLookup.run(() => queue.getJob("j4"));
    assert.equal(rawLookup.wrote, true, "a lookup this tracker did not make is not known to be one");
    // Two trackers on one queue, at once: each counts what was asked under its own run, and a command asked under none
    // is nobody's.
    const reader = queueWriteTracking(queue);
    const writer = queueWriteTracking(queue);
    await Promise.all([
      reader.run(async () => {
        for (let i = 0; i < 5; i += 1) await reader.queue.getJob("j4");
      }),
      writer.run(async () => {
        await writer.queue.add("n", { id: "j5" }, { jobId: "j5" });
      }),
      queue.add("n", { id: "j6" }, { jobId: "j6" }),
    ]);
    assert.deepEqual([reader.wrote, writer.wrote], [false, true]);
    // The fleet reader calls its helper UNDER the tracker: a helper that reaches Valkey by a path no proxy stands
    // before is still answered for, and one that only looked up is not.
    const { mk } = switchQueues();
    const unknown = { id: "x", state: "unknown" };
    const prepare = (helper) => {
      fleets.push(endingReader(mk, [{ name: "hostb", routes: true }], { makeSandboxPrepareQueueFn: () => queue, enqueueSandboxPreparationFn: helper }));
      return fleets.at(-1).sandboxPrepare({ host: "hostb" });
    };
    assert.deepEqual(await prepare(async (q) => { await (await q.connection.client).set(key, "2", "PX", 60_000); return unknown; }), { ...unknown, asked: true });
    assert.deepEqual(await prepare(async (q) => { await q.getJob("j4"); return unknown; }), { ...unknown, asked: false });
  } finally {
    try {
      await (await queue.client).del(key);
      await queue.obliterate({ force: true });
    } finally {
      // Each reader closes the queues it holds, this one among them.
      for (const fleet of fleets) await fleet.dispose();
      await queue.close();
    }
  }
});

test("createFleetReader builds every queue it holds on the console's bounded connection: the shared one, a host's, a sandbox request's (#842)", async () => {
  const { mk } = switchQueues();
  const conns = [];
  const reader = endingReader(mk, [{ name: "hostb", routes: true }], {
    parseConnectionFn: (url, options) => (conns.push([url, options]), {}),
    makeSandboxPrepareQueueFn: (conn, opts) => mk(conn, { name: `sandbox@${opts.host}` }),
    enqueueSandboxPreparationFn: async () => ({ ok: true }),
  });
  await reader.snapshot();
  await reader.sandboxPrepare({ host: "hostb" });
  assert.deepEqual(conns, Array(3).fill(["redis://unused", { failFast: true, commandTimeoutMs: 5000 }]));
  // And no queue of the reader is built any other way: a second spelling would be a queue without the bound.
  const source = readFileSync(fileURLToPath(new URL("../src/read-model.mjs", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("export function createFleetReader("), source.indexOf("// The console's page readers (issue #641)"));
  assert.ok(body.length > 10_000);
  assert.equal(body.match(/consoleQueueConnection\(paths\.valkeyUrl, parseConnectionFn\)/g).length, 3);
  assert.equal(/parseConnectionFn\(/.test(body.replaceAll("consoleQueueConnection(paths.valkeyUrl, parseConnectionFn)", "")), false);
  await reader.dispose();
});

test("createFleetReader: dispose ends by its own bound when no queue's close is answered, every close started at once (#842)", async () => {
  const { built, mk } = switchQueues();
  let rawDropped = 0;
  const reader = endingReader(mk, [{ name: "hostb", routes: true }, { name: "hostc", routes: true }], { closeTimeoutMs: 60, redisFn: () => ({ ...readyRedis(), disconnect() { rawDropped += 1; } }) });
  await reader.snapshot();
  await settle();
  assert.equal(built.length, 3);
  for (const q of built) q.close = () => (q.closed += 1, never());
  const started = Date.now();
  const pending = reader.dispose();
  await settle();
  assert.deepEqual(built.map((q) => q.closed), [1, 1, 1], "every close was started before any was answered");
  assert.equal(rawDropped, 1, "and the raw client was dropped: its socket would otherwise hold the process past the stop");
  assert.notEqual(await orHung(pending), "hung", "dispose resolved though no close ever did");
  assert.ok(Date.now() - started < 1000, "at one close bound, not one per queue");
  assert.deepEqual(built.map((q) => q.dropped), [1, 1, 1], "each connection was dropped once its close had not been answered");
});

test("createFleetReader: the raw client's error is one line a minute under its own name, and a client seam may be absent", () => {
  const handlers = {};
  const logsDir = tempDir("pd-ended-queue-");
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (line, ...rest) => {
    if (String(line).includes("the raw client's fault")) {
      written.push(String(line));
      return true;
    }
    return write.call(process.stderr, line, ...rest);
  };
  try {
    createFleetReader(
      { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") },
      { makeQueueFn: () => ({ name: "pi-jobs" }), parseConnectionFn: () => ({}), redisFn: () => ({ on(event, fn) { handlers[event] = fn; } }), readOnly: true },
    );
    handlers.error(new Error("the raw client's fault"));
    handlers.error(new Error("the raw client's fault"));
    assert.deepEqual(written, ["[pi-dispatch] Valkey error (fleet reads): the raw client's fault\n"]);
  } finally {
    process.stderr.write = write;
  }
  assert.doesNotThrow(() => createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, { makeQueueFn: () => ({ name: "pi-jobs" }), parseConnectionFn: () => ({}), redisFn: () => null, readOnly: true }));
});

test("createFleetReader: the raw client says its error in one line, so an outage is not a stack trace per reconnect attempt", () => {
  const events = [];
  const logsDir = tempDir("pd-ended-queue-");
  createFleetReader(
    { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") },
    { makeQueueFn: () => ({ name: "pi-jobs" }), parseConnectionFn: () => ({}), redisFn: () => ({ on(event) { events.push(event); } }), readOnly: true },
  );
  assert.deepEqual(events, ["ready", "error"], "and its going ready lets a second outage be said");
});

test("createFleetReader on real BullMQ and ioredis: a refused judge fails the read, and the next read builds a new queue on a new judgement", { timeout: 15000 }, async () => {
  const { makeQueue } = await import("@edgehero/pi-dispatch/queue");
  const { parseConnection } = await import("@edgehero/pi-dispatch/connection");
  let opened = 0;
  const logsDir = tempDir("pd-ended-queue-");
  const reader = createFleetReader(
    { valkeyUrl: "redis://127.0.0.1:1", logsDir, triggersPath: join(logsDir, "none.json") },
    {
      makeQueueFn: (conn, opts) => { opened += 1; const q = makeQueue(conn, opts); q.removeAllListeners("error"); q.on("error", () => {}); return q; },
      parseConnectionFn: (url, opts) => parseConnection(url, { ...opts, context: {}, judge: async () => { throw new Error("nothing answers VALKEY_URL"); } }),
      redisFn: readyRedis,
      readLiveHostsFn: async () => ({ hosts: [] }),
      discoverHostQueuesFn: async () => [],
      nowFn: () => 1_800_000_000_000,
      readOnly: true,
    },
  );
  try {
    await assert.rejects(reader.snapshot(), /nothing answers VALKEY_URL/);
    await settle();
    assert.equal(opened, 1);
    await assert.rejects(reader.snapshot(), /nothing answers VALKEY_URL/);
    await settle();
    assert.equal(opened, 2, "the ended queue was replaced, not asked again");
  } finally {
    await reader.dispose();
  }
});

test("a switch preview's snapshot starts the run records' read before it waits for the queue discovery, so it pays one bound and not two (#961)", async () => {
  const { mk } = switchQueues();
  const order = [];
  // The run records' read is the mirror's index, the only sorted set this snapshot asks for.
  const redisFn = () => new Proxy(readyRedis(), { get: (target, key) => (typeof key === "string" && key.startsWith("z") ? async () => (order.push("runs asked"), []) : target[key]) });
  const reader = endingReader(mk, [], { redisFn, discoverHostQueuesFn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push("queues discovered");
    return [];
  } });
  try {
    const s = await reader.snapshot({ switchQueues: true });
    assert.ok(Array.isArray(s.queueCounts));
    assert.deepEqual(order.slice(0, 2), ["runs asked", "queues discovered"], "one after the other, a Valkey that stopped answering held the preview for both bounds");
  } finally {
    await reader.dispose();
  }
});
