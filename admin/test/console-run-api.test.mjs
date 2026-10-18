import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { after, test } from "node:test";
import { CHAT_REFUSALS, parkedVerdictOf, QUEUED_STATES } from "@edgehero/pi-dispatch/chat-mode";
import { recoveryJobId } from "@edgehero/pi-dispatch/recovery-queue";
import { CANDIDATES_MAX, chatFactsOf, NEWER_CACHE_MS, PARK_CHECK_CACHE_MS, parkedAnswerCheckOf, parseRunQuery, RUN_UNREADABLE, safeRunOf, TARGET_RUNS_MAX } from "../src/console/run-api.mjs";
import { parkedInbox, runChat } from "../src/console/panels.mjs";
import { createConsoleServer } from "../src/console/server.mjs";
import * as sessionsModule from "../src/console/sessions.mjs";
import { FORGE_URL_MAX, forgeLinkOf, forgeTargetOf, PENDING_STATES, readJobStatus, readPendingAnswer, targetKeyOf } from "../src/read-model.mjs";

// `GET /api/run` (issue #647): the run lookup the terminal chat asks which mode to open. `forgeTargetOf` held to
// `forgeLinkOf` by a round trip per forge, the query rules, `readJobStatus` on fake queues, and the route over a real
// node:http server with the real session store and a fake fleet reader: every state and mode, both roles, the
// 400/404/409/503 answers, and no free text in any answer. No Valkey, no clock beyond an injected one.

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const ENV = { GITLAB_URL: "https://gitlab.example.com/sub", FORGEJO_URL: "https://code.example.org", AZURE_ORG_URL: "https://dev.azure.com/acme" };

// ---- forgeTargetOf -----------------------------------------------------------------------------------------------------

test("forgeTargetOf is forgeLinkOf's inverse on every forge: the link the console draws reads back to the same target", () => {
  const records = [
    { kind: "github", target: "acme/web#12" },
    { kind: "github", target: "acme/web.js#7", triggerType: "pull_request" },
    { kind: "gitlab", target: "group/sub/project#3" },
    { kind: "gitlab", target: "group/project!44" },
    { kind: "forgejo", target: "owner/repo#5" },
    { kind: "forgejo", target: "owner/repo#6", triggerType: "pull_request" },
    { kind: "azure", target: "proj/repo!9" },
  ];
  for (const r of records) {
    const link = forgeLinkOf(r, ENV);
    assert.equal(typeof link, "string", `${r.kind} ${r.target}: a link`);
    assert.deepEqual(forgeTargetOf(link, ENV), { kind: r.kind, target: r.target }, `${link} reads back`);
  }
  // An Azure work item's link names the project and never the repository: the inverse says so instead of guessing.
  const wi = forgeLinkOf({ kind: "azure", target: "proj/repo#31" }, ENV);
  assert.equal(wi, "https://dev.azure.com/acme/proj/_workitems/edit/31");
  assert.deepEqual(forgeTargetOf(wi, ENV), { kind: "azure", project: "proj", number: "31", ambiguous: true });
});

test("forgeTargetOf also reads the request URLs a person copies, ignores a query and a fragment, and refuses everything else", () => {
  assert.deepEqual(forgeTargetOf("https://github.com/acme/web/pull/12", ENV), { kind: "github", target: "acme/web#12" });
  assert.deepEqual(forgeTargetOf("https://github.com/acme/web/issues/12/?x=1#issuecomment-9", ENV), { kind: "github", target: "acme/web#12" });
  assert.deepEqual(forgeTargetOf("https://code.example.org/owner/repo/pulls/6", ENV), { kind: "forgejo", target: "owner/repo#6" });
  assert.deepEqual(forgeTargetOf("https://GITLAB.example.com/sub/g/p/-/issues/2", ENV), { kind: "gitlab", target: "g/p#2" }, "the host's case is the URL's, normalized");
  // GitHub needs no variable; every other forge only on the deployment's own instance.
  assert.equal(forgeTargetOf("https://code.example.org/owner/repo/issues/1", {}), null);
  for (const bad of [
    "https://evil.example/acme/web/issues/1",
    "http://github.com/acme/web/issues/1",
    "https://user:pw@github.com/acme/web/issues/1",
    "https://github.com/acme/web/issues/1\n",
    "https://github.com/acme/web/issues/ 1",
    "https://github.com/acme/web/issues/%E0%A4%A",
    "https://github.com/acme/../issues/1",
    "https://github.com/acme/web/commits/1",
    "https://github.com/acme/web/issues/",
    "https://github.com/acme/web/issues/x1",
    "https://github.com/acme/web/issues/1234567890123",
    "https://github.com/acme/w%2Feb/issues/1",
    "https://github.com/acme/web/extra/issues/1",
    "https://gitlab.example.com/sub/g/p/issues/2",
    "https://gitlab.example.com/sub/p/-/issues/2",
    "https://gitlab.example.com/subx/g/p/-/issues/2",
    "https://dev.azure.com/acme/proj/_git/repo/pullrequests/9",
    "javascript:alert(1)",
    `https://github.com/acme/${"w".repeat(FORGE_URL_MAX)}/issues/1`,
    "",
    null,
    7,
  ]) {
    assert.equal(forgeTargetOf(bad, ENV), null, JSON.stringify(bad));
  }
  // Two instances sharing a prefix: the longer base wins.
  assert.deepEqual(forgeTargetOf("https://h.example/gl/g/p/-/merge_requests/1", { FORGEJO_URL: "https://h.example", GITLAB_URL: "https://h.example/gl" }), { kind: "gitlab", target: "g/p!1" });
});

// ---- the query ---------------------------------------------------------------------------------------------------------

test("parseRunQuery: exactly one of id or url, once, nothing else, and a refusal never echoes the value", () => {
  const q = (s) => parseRunQuery(new URLSearchParams(s));
  assert.deepEqual(q("id=gh-1"), { id: "gh-1" });
  assert.deepEqual(q("url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fissues%2F1"), { url: "https://github.com/a/b/issues/1" });
  for (const bad of ["", "id=gh-1&url=x", "id=a&id=b", "url=a&url=b", "id=a%20b", "id=", "url=", "id=a&page=x", "x=1", `id=${"a".repeat(201)}`, `url=${"a".repeat(FORGE_URL_MAX + 1)}`, "id=%3Cscript%3E"]) {
    const got = q(bad);
    assert.equal(typeof got.refusal, "string", bad);
    assert.ok(!got.refusal.includes("<script") && !got.refusal.includes("aaaaaaaaaa"), `${bad}: no echo`);
  }
});

// ---- readJobStatus -----------------------------------------------------------------------------------------------------

/** Fake BullMQ queues: `jobs` maps id -> { state, data }. */
function queuesOf(jobs, { throws = false } = {}) {
  return [
    { name: "pi-jobs", getJob: async () => null },
    {
      name: "pi-jobs@mini1",
      getJob: async (id) => {
        if (throws) throw new Error("ECONNREFUSED 10.0.0.1:6379");
        const j = jobs[id];
        return j ? { id, data: j.data ?? {}, getState: async () => j.state } : null;
      },
    },
  ];
}

test("readJobStatus: any job's state (steer-armed or not), its active recovery, and the refusals", async () => {
  const r1 = recoveryJobId("gh-9", 1);
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-1": { state: "active" } }), jobId: "gh-1" }), { found: true, state: "active", continuesAs: null, queuedAs: null });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-9": { state: "failed" }, [r1]: { state: "active", data: { recoveryOf: "gh-9" } } }), jobId: "gh-9" }), { found: true, state: "failed", continuesAs: r1, queuedAs: null });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ [r1]: { state: "active", data: { recoveryOf: "gh-9" } } }), jobId: "gh-9" }), { found: false, state: null, continuesAs: r1, queuedAs: null }, "a base the queue dropped, whose recovery runs");
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-2": { state: "waiting" } }), jobId: "gh-2" }), { found: true, state: "waiting", continuesAs: null, queuedAs: null });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-3": { state: "Not A State!" } }), jobId: "gh-3" }), { found: true, state: "unknown", continuesAs: null, queuedAs: null });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({}), jobId: "gh-4" }), { found: false, state: null, continuesAs: null, queuedAs: null });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({}), jobId: "bad id" }), { invalid: true });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({}, { throws: true }), jobId: "gh-5" }), { unreachable: true }, "never the error's text");
  // A read that answers after the bound (a held timer, so the test process waits for it rather than ending early).
  const slow = [{ name: "q", getJob: () => new Promise((resolve) => setTimeout(() => resolve(null), 200)) }];
  assert.deepEqual(await readJobStatus({ queues: slow, jobId: "gh-6", timeoutMs: 20 }), { unreachable: true });
});

// ---- the route ---------------------------------------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;
const CANARY = "FREE-TEXT-CANARY-5c1e";

/** A record as the worker writes one, plus the free text `/api/run` must never carry. */
function record(jobId, fields = {}) {
  return {
    jobId,
    kind: "github",
    target: "acme/web#12",
    triggerType: "issues",
    triggerIndex: 0,
    flow: "triage",
    outcome: "completed",
    reason: "done",
    why: `${CANARY} the model said something`,
    startedAt: iso(T0 - 600_000),
    endedAt: iso(T0 - 300_000),
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    host: "mini1",
    backend: "docker",
    attempt: 1,
    exitCode: 0,
    turns: 9,
    session: { resumed: false, reason: "fresh", key: `${CANARY}-key` },
    progress: { turns: 9, steps: 20, failed: 1 },
    data: { body: CANARY },
    ...fields,
  };
}

/**
 * A fake fleet reader. `records` id -> record; `jobs` id -> readJobStatus answer (absent: not found); `runs` the history
 * newest first for `runsPage`; `transcript`, `inbox`, `progress` id -> the reader's answer.
 */
function fakeFleet({ records = {}, jobs = {}, runs = null, transcript = {}, inbox = {}, progress = {}, runsPageThrows = false, statusUnreachable = false, pending = undefined, page = {} } = {}) {
  const calls = { runsPage: [], transcriptMeta: [], inbox: [], jobStatus: [] };
  const history = runs ?? Object.values(records);
  return {
    calls,
    snapshot: async () => ({}),
    runById: async (id) => (records[id] ? { record: records[id], source: "local" } : { missing: true }),
    jobStatus: async (id) => {
      calls.jobStatus.push(id);
      if (statusUnreachable) return { unreachable: true };
      return jobs[id] ?? { found: false, state: null, continuesAs: null };
    },
    runsPage: async (opts) => {
      calls.runsPage.push(opts);
      if (runsPageThrows) throw new Error("ECONNREFUSED");
      // As the real reader does: the filter, then the caller's predicate, THEN the limit.
      const f = opts.filter ?? {};
      const hits = history.filter((r) => (!f.kind || r.kind === f.kind) && (!f.q || String(r.target).toLowerCase().includes(f.q.toLowerCase())) && (typeof opts.match !== "function" || opts.match(r)));
      return { runs: hits.slice(0, opts.limit ?? 100), next: null, mirror: "ok", ...page };
    },
    ...(pending !== undefined ? { pendingAnswer: async (args) => (calls.pending = [...(calls.pending ?? []), args], typeof pending === "function" ? pending(args) : pending) } : {}),
    transcriptMeta: async (id) => {
      calls.transcriptMeta.push(id);
      return transcript[id] ?? { exists: false, ended: false, outcome: null, length: 0, firstId: null, lastId: null };
    },
    inbox: async (id) => {
      calls.inbox.push(id);
      return inbox[id] ?? { found: false };
    },
    progressOfRun: async (id) => progress[id] ?? { progress: { absent: true }, continues: false, continuesAs: null },
  };
}

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
});

async function runConsole(fleet, { env = ENV } = {}) {
  const now = () => T0;
  const file = {
    version: 1,
    generation: 0,
    tokens: [
      { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
      { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
    ],
  };
  const readTokens = () => ({ file });
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly: false, maxMs: 12 * 3600_000 },
    now,
    audit: { append: (row) => row },
    sessions: sessionsModule.makeSessionStore({ now }),
    cookies: sessionsModule,
    tickets: { issue: () => ({ ticket: "t" }), redeem: () => ({ refusal: "no" }) },
    readTokens,
    findToken: (f, presented) => f.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: () => ({ ok: true }),
    pageDeps: { fleet, env, now },
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  const send = ({ method = "GET", path, headers = {}, body = null }) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers }, setHost: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body ?? undefined);
    });
  const login = async (token) => {
    const res = await send({ method: "POST", path: "/login", headers: { origin: `http://${host}`, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200, res.text);
    return res.headers["set-cookie"][0].split(";")[0];
  };
  const op = await login(OP_TOKEN);
  const viewer = await login(VIEW_TOKEN);
  const get = (path, cookie = op) => send({ path, headers: { cookie } });
  return { send, get, op, viewer };
}

const TOP_KEYS = ["activeJobId", "forgeLink", "mode", "newerRunOnTarget", "pendingRunOnTarget", "progress", "run", "says", "state", "steer", "transcript", "version"];
const RUN_KEYS = ["attempt", "backend", "exitCode", "finishedAt", "flow", "host", "id", "jobId", "kind", "model", "outcome", "parentJobId", "project", "provider", "reason", "recoveryOf", "repo", "session", "startedAt", "target", "triggerIndex", "triggerType", "turns"];

test("/api/run: the keys, a finished run's fork, and no free text, job data or session key for either role", { timeout: 20_000 }, async () => {
  const fleet = fakeFleet({ records: { "gh-1": record("gh-1") } });
  const c = await runConsole(fleet);
  const res = await c.get("/api/run?id=gh-1");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.ok(res.headers["content-security-policy"], "the security headers");
  const doc = res.json();
  assert.deepEqual(Object.keys(doc).sort(), TOP_KEYS);
  assert.deepEqual(Object.keys(doc.run).sort(), RUN_KEYS);
  assert.deepEqual(doc.run, {
    id: "gh-1",
    jobId: "gh-1",
    kind: "github",
    repo: "acme/web",
    target: "acme/web#12",
    triggerType: "issues",
    triggerIndex: 0,
    flow: "triage",
    outcome: "completed",
    reason: "done",
    startedAt: iso(T0 - 600_000),
    finishedAt: iso(T0 - 300_000),
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    host: "mini1",
    backend: "docker",
    project: null,
    attempt: 1,
    exitCode: 0,
    turns: 9,
    parentJobId: null,
    recoveryOf: null,
    session: { kept: true, resumed: false },
  });
  assert.equal(doc.version, 1);
  assert.equal(doc.state, "finished");
  assert.equal(doc.mode, "fork");
  assert.equal(doc.says, null);
  assert.equal(doc.activeJobId, null);
  assert.deepEqual(doc.steer, { armed: false, open: false });
  assert.deepEqual(doc.transcript, { exists: false, ended: false, outcome: null });
  assert.deepEqual(doc.progress, { live: false, turns: 9, steps: 20, failed: 1, interrupted: 0, phase: null, ended: true, updatedAt: null });
  assert.equal(doc.forgeLink, "https://github.com/acme/web/issues/12");
  assert.equal(doc.newerRunOnTarget, null);
  assert.ok(!res.text.includes(CANARY), "no record free text, no job data, no session key");
  assert.doesNotMatch(res.text, /[0-9a-f]{32}/, "nothing shaped like a session key");
  // A viewer gets the same document: there is nothing in it to withhold.
  const v = await c.get("/api/run?id=gh-1", c.viewer);
  assert.equal(v.status, 200);
  assert.deepEqual(v.json(), doc);
  const anon = await c.get("/api/run?id=gh-1", "pdc_session=none");
  assert.equal(anon.status, 401);
  assert.ok(!anon.text.includes("acme"));
});

test("/api/run: every state and mode, from the queue, the record and the history", { timeout: 20_000 }, async () => {
  const r1 = recoveryJobId("gh-base", 1);
  const parked = record("gh-park", { reason: "awaiting-input", target: "acme/web#20" });
  const answeredRun = record("gh-ans", { reason: "awaiting-input", target: "acme/web#21", endedAt: iso(T0 - 300_000) });
  const later = record("gh-later", { target: "acme/web#21", startedAt: iso(T0 - 200_000), endedAt: iso(T0 - 100_000) });
  const snapshot = { v: 1, turn: 4, steps: 7, failed: 0, interrupted: 1, running: [{ tool: "bash", since: T0 - 1000 }], recent: [], phase: { index: 1, done: 2, total: 5 }, phases: ["survey", `${CANARY} phase`], note: `${CANARY} note`, prior: null, startedAt: T0 - 60_000, updatedAt: T0 - 1000, ended: false, outcome: null };
  const fleet = fakeFleet({
    records: { "gh-park": parked, "gh-ans": answeredRun, "gh-later": later, "gh-base": record("gh-base", { outcome: "failed", reason: "recovery-enqueued", target: "acme/web#30" }), "gh-done": record("gh-done", { target: "acme/web#40" }) },
    jobs: {
      "gh-act": { found: true, state: "active", continuesAs: null },
      "gh-base": { found: true, state: "failed", continuesAs: r1 },
      "gh-wait": { found: true, state: "waiting", continuesAs: null },
      "gh-gone": { found: true, state: "completed", continuesAs: null },
    },
    transcript: { "gh-act": { exists: true, ended: false, outcome: null, length: 3 }, [r1]: { exists: true, ended: false, outcome: null, length: 9 } },
    inbox: { "gh-act": { found: true, steer: true, state: "active", open: true, entries: [{ id: "a".repeat(32), text: CANARY }], closed: false }, [r1]: { found: true, steer: true, state: "active", open: null } },
    progress: { "gh-act": { progress: snapshot, continues: false, continuesAs: null } },
  });
  const c = await runConsole(fleet);
  const doc = async (id) => {
    const res = await c.get(`/api/run?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200, `${id}: ${res.text}`);
    assert.ok(!res.text.includes(CANARY), `${id}: no text`);
    return res.json();
  };

  const act = await doc("gh-act");
  assert.deepEqual([act.state, act.mode, act.says, act.activeJobId], ["active", "live", null, "gh-act"]);
  assert.deepEqual(act.steer, { armed: true, open: true });
  assert.deepEqual(act.transcript, { exists: true, ended: false, outcome: null });
  assert.deepEqual(act.progress, { live: true, turns: 4, steps: 7, failed: 0, interrupted: 1, phase: { index: 1, count: 2, done: 2, total: 5 }, ended: false, updatedAt: T0 - 1000 });
  assert.equal(act.run.jobId, null, "no record yet: the run's fields are null, its id is the one asked");
  assert.equal(act.forgeLink, null);

  const base = await doc("gh-base");
  assert.deepEqual([base.state, base.mode, base.activeJobId], ["active", "live", r1], "a run that goes on as its recovery is live, through that job");
  assert.deepEqual(base.steer, { armed: true, open: null }, "open unread is null, never a guess");
  assert.deepEqual(base.transcript, { exists: true, ended: false, outcome: null });
  assert.ok(fleet.calls.transcriptMeta.includes(r1) && fleet.calls.inbox.includes(r1), "the transcript and inbox read are the active job's");

  const park = await doc("gh-park");
  assert.deepEqual([park.state, park.mode, park.says, park.newerRunOnTarget], ["parked", "reply", null, null]);

  const ans = await doc("gh-ans");
  assert.deepEqual([ans.state, ans.mode, ans.says, ans.newerRunOnTarget], ["answered", null, CHAT_REFUSALS.answered, "gh-later"]);

  const done = await doc("gh-done");
  assert.deepEqual([done.state, done.mode], ["finished", "fork"]);

  const wait = await doc("gh-wait");
  assert.deepEqual([wait.state, wait.mode, wait.says], ["queued", null, CHAT_REFUSALS.queued]);

  const gone = await doc("gh-gone");
  assert.deepEqual([gone.state, gone.mode, gone.says], ["unknown", null, CHAT_REFUSALS.endedNoRecord]);

  const missing = await c.get("/api/run?id=gh-nobody");
  assert.equal(missing.status, 404);
  assert.match(missing.json().error, /no run with that id/);
});

test("/api/run: a parked run whose history cannot be searched is unknown with a sentence; a queue that cannot be read is 503", { timeout: 20_000 }, async () => {
  const parked = record("gh-park", { reason: "awaiting-input" });
  const c = await runConsole(fakeFleet({ records: { "gh-park": parked }, runsPageThrows: true }));
  const d = (await c.get("/api/run?id=gh-park")).json();
  assert.deepEqual([d.state, d.mode, d.says, d.newerRunOnTarget], ["unknown", null, CHAT_REFUSALS.parkedUnknown, null]);
  const down = await runConsole(fakeFleet({ records: { "gh-park": parked }, statusUnreachable: true }));
  const res = await down.get("/api/run?id=gh-park");
  assert.equal(res.status, 503);
  assert.deepEqual(res.json(), { error: RUN_UNREADABLE });
  const none = await runConsole(null);
  assert.equal((await none.get("/api/run?id=gh-1")).status, 503, "no fleet reader");
});

test("/api/run?url=: the newest run on the target, an Azure work item in two repositories is 409 with candidates, 400 and 404", { timeout: 20_000 }, async () => {
  const older = record("gh-old", { endedAt: iso(T0 - 900_000), startedAt: iso(T0 - 950_000) });
  const newer = record("gh-new");
  const other = record("gh-70", { target: "acme/web#120" });
  const azA = record("az-a", { kind: "azure", target: "proj/repo-a#31" });
  const azB = record("az-b", { kind: "azure", target: "proj/repo-b#31", endedAt: iso(T0 - 100_000) });
  const azOnly = record("az-c", { kind: "azure", target: "proj/repo-a#32" });
  const runs = [azB, newer, other, azA, azOnly, older];
  const fleet = fakeFleet({ records: Object.fromEntries(runs.map((r) => [r.jobId, r])), runs });
  const c = await runConsole(fleet);
  const url = (u) => `/api/run?url=${encodeURIComponent(u)}`;

  const gh = await c.get(url("https://github.com/acme/web/pull/12"));
  assert.equal(gh.status, 200, gh.text);
  assert.equal(gh.json().run.id, "gh-new", "the newest run on exactly that target (#12, never #120)");
  assert.equal(gh.json().newerRunOnTarget, null);
  assert.equal((await c.get("/api/run?id=gh-old")).json().newerRunOnTarget, "gh-new");

  const az = await c.get(url("https://dev.azure.com/acme/proj/_workitems/edit/31"));
  assert.equal(az.status, 409);
  assert.deepEqual(az.json().candidates, [{ target: "proj/repo-b#31", jobId: "az-b" }, { target: "proj/repo-a#31", jobId: "az-a" }]);
  assert.ok(CANDIDATES_MAX >= 2);
  const one = await c.get(url("https://dev.azure.com/acme/proj/_workitems/edit/32"));
  assert.equal(one.status, 200);
  assert.equal(one.json().run.id, "az-c");

  const nothing = await c.get(url("https://github.com/acme/web/issues/99"));
  assert.equal(nothing.status, 404);
  assert.match(nothing.json().error, /give its run id instead/);
  for (const bad of ["https://evil.example/acme/web/issues/1", "not a url", "https://github.com/acme/web/issues/1\u0007"]) {
    const r = await c.get(url(bad));
    assert.equal(r.status, 400, bad);
    assert.ok(!r.text.includes("evil.example"), "no echo");
  }
  for (const path of ["/api/run", "/api/run?id=a&url=b", "/api/run?id=a&id=b", "/api/run?id=a%0A", "/api/run?id=a&format=json"]) assert.equal((await c.get(path)).status, 400, path);
  const head = await c.send({ method: "HEAD", path: "/api/run?id=gh-new", headers: { cookie: c.op } });
  assert.equal(head.status, 200, "a plain read: HEAD is served like every GET page");
});

test("safeRunOf rebuilds every field by its shape: hostile strings are null, never scrubbed into something that passes", () => {
  const run = safeRunOf("gh-1", record("gh-1", { target: "acme/web#1\u001b[2J", model: "m odel", flow: "Triage!", outcome: "Completed", reason: `${CANARY}`, host: "-bad", startedAt: "yesterday", exitCode: "0", turns: -1, parentJobId: "a b" }));
  assert.equal(run.target, null);
  assert.equal(run.repo, null);
  assert.equal(run.model, null);
  assert.equal(run.flow, null);
  assert.equal(run.outcome, null);
  assert.equal(run.reason, null);
  assert.equal(run.host, null);
  assert.equal(run.startedAt, null);
  assert.equal(run.exitCode, null);
  assert.equal(run.turns, null);
  assert.equal(run.parentJobId, null);
  assert.deepEqual(safeRunOf("x", null).session, { kept: false, resumed: false });
});

// ---- review round 1 ----------------------------------------------------------------------------------------------------

test("forgeTargetOf: two instances sharing a prefix in EITHER order (the longer base wins), %2F is never a subgroup, zeros dropped", () => {
  assert.deepEqual(forgeTargetOf("https://h.example/fj/o/r/issues/1", { GITLAB_URL: "https://h.example", FORGEJO_URL: "https://h.example/fj" }), { kind: "forgejo", target: "o/r#1" }, "the longer base is the second kind looked at");
  assert.deepEqual(forgeTargetOf("https://h.example/gl/g/p/-/issues/1", { FORGEJO_URL: "https://h.example", GITLAB_URL: "https://h.example/gl" }), { kind: "gitlab", target: "g/p#1" });
  assert.equal(forgeTargetOf("https://gitlab.example.com/sub/g%2Fx/p/-/issues/2", ENV), null, "a decoded / would read as a subgroup the URL never named");
  assert.equal(forgeTargetOf("https://gitlab.example.com/sub/g/p%2F-/-/issues/2", ENV), null);
  assert.deepEqual(forgeTargetOf("https://github.com/acme/web/issues/007", ENV), { kind: "github", target: "acme/web#7" });
  assert.deepEqual(forgeTargetOf("https://github.com/acme/web/issues/0", ENV), { kind: "github", target: "acme/web#0" });
  assert.deepEqual(forgeTargetOf("https://dev.azure.com/acme/proj/_workitems/edit/031", ENV), { kind: "azure", project: "proj", number: "31", ambiguous: true });
});

test("targetKeyOf: one forge target whatever the repository's case or the number's zeros; a local target exactly", () => {
  assert.equal(targetKeyOf("github", "Acme/Web#012"), targetKeyOf("github", "acme/web#12"));
  assert.equal(targetKeyOf("gitlab", "G/Sub/P!3"), targetKeyOf("gitlab", "g/sub/p!3"));
  assert.notEqual(targetKeyOf("gitlab", "g/p!3"), targetKeyOf("gitlab", "g/p#3"), "an issue is not a merge request");
  assert.notEqual(targetKeyOf("github", "acme/web#12"), targetKeyOf("forgejo", "acme/web#12"));
  assert.notEqual(targetKeyOf("github", "acme/web#12"), targetKeyOf("github", "acme/web#120"));
  assert.notEqual(targetKeyOf("local", "local:Repo"), targetKeyOf("local", "local:repo"));
  assert.equal(targetKeyOf("github", null), null);
});

test("readJobStatus: a run whose #645 recovery is waiting, delayed or prioritized is queued (queuedAs); an active recovery wins (review L5)", async () => {
  const r1 = recoveryJobId("gh-9", 1);
  const r2 = recoveryJobId("gh-9", 2);
  for (const state of ["waiting", "delayed", "prioritized"]) {
    assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-9": { state: "failed" }, [r1]: { state, data: { recoveryOf: "gh-9" } } }), jobId: "gh-9" }), { found: true, state: "failed", continuesAs: null, queuedAs: r1 }, state);
  }
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-9": { state: "failed" }, [r1]: { state: "waiting" }, [r2]: { state: "active" } }), jobId: "gh-9" }), { found: true, state: "failed", continuesAs: r2, queuedAs: null });
  assert.deepEqual(await readJobStatus({ queues: queuesOf({ "gh-9": { state: "failed" }, [r1]: { state: "completed" } }), jobId: "gh-9" }), { found: true, state: "failed", continuesAs: null, queuedAs: null }, "a finished recovery is neither");
});

test("/api/run: a base whose recovery is queued is queued, never a fork; a run known only through a recovery, a transcript or progress is not 404 (review L5, a12)", { timeout: 20_000 }, async () => {
  const r1 = recoveryJobId("gh-base", 1);
  const snapshot = { v: 1, turn: 1, steps: 1, failed: 0, interrupted: 0, running: [], recent: [], phase: null, phases: [], note: null, prior: null, startedAt: T0 - 60_000, updatedAt: T0 - 1000, ended: false, outcome: null };
  const fleet = fakeFleet({
    records: { "gh-base": record("gh-base", { outcome: "failed", reason: "recovery-enqueued" }) },
    jobs: {
      "gh-base": { found: true, state: "failed", continuesAs: null, queuedAs: r1 },
      "gh-dropped": { found: false, state: null, continuesAs: null, queuedAs: "gh-dropped.r1" },
      "gh-runs-on": { found: false, state: null, continuesAs: "gh-runs-on.r1", queuedAs: null },
    },
    transcript: { "gh-talk": { exists: true, ended: false, outcome: null, length: 2 } },
    progress: { "gh-prog": { progress: snapshot, continues: false, continuesAs: null } },
  });
  const c = await runConsole(fleet);
  const base = (await c.get("/api/run?id=gh-base")).json();
  assert.deepEqual([base.state, base.mode, base.says, base.activeJobId], ["queued", null, CHAT_REFUSALS.recoveryQueued, null]);
  for (const id of ["gh-dropped", "gh-runs-on", "gh-talk", "gh-prog"]) {
    const res = await c.get(`/api/run?id=${id}`);
    assert.equal(res.status, 200, `${id}: ${res.text}`);
  }
  assert.equal((await c.get("/api/run?id=gh-dropped")).json().state, "queued");
  assert.equal((await c.get("/api/run?id=gh-runs-on")).json().mode, "live");
  assert.equal((await c.get("/api/run?id=gh-nobody")).status, 404, "and nothing at all is still 404");
});

test("/api/run: a park whose answer is queued or running is answered (pendingRunOnTarget); a queue scan that cannot tell is unknown (review L6)", { timeout: 20_000 }, async () => {
  const parked = record("gh-park", { reason: "awaiting-input", target: "acme/web#20" });
  const at = async (pending) => {
    const fleet = fakeFleet({ records: { "gh-park": parked }, pending });
    const c = await runConsole(fleet);
    return { doc: (await c.get("/api/run?id=gh-park")).json(), fleet };
  };
  const { doc: busy, fleet } = await at({ jobId: "gh-answer" });
  assert.deepEqual([busy.state, busy.mode, busy.says, busy.pendingRunOnTarget, busy.newerRunOnTarget], ["answered", null, CHAT_REFUSALS.answering, "gh-answer", null]);
  assert.deepEqual(fleet.calls.pending, [{ kind: "github", target: "acme/web#20", runId: "gh-park" }]);
  const free = (await at({ jobId: null })).doc;
  assert.deepEqual([free.state, free.mode, free.pendingRunOnTarget], ["parked", "reply", null]);
  for (const pending of [{ unknown: true }, { unknown: true, tooMany: false }, { unreachable: true }, () => Promise.reject(new Error("boom"))]) {
    const d = (await at(pending)).doc;
    assert.deepEqual([d.state, d.mode, d.says], ["unknown", null, CHAT_REFUSALS.parkedUnknown], JSON.stringify(pending));
  }
  // A queue too deep to check fails loudly with its own sentence (review round 2), never "try again" about the history.
  const deep = (await at({ unknown: true, tooMany: true })).doc;
  assert.deepEqual([deep.state, deep.mode, deep.says, deep.pendingRunOnTarget], ["unknown", null, CHAT_REFUSALS.parkedTooMany, null]);
  assert.match(deep.says, /too many jobs to check whether an answer is already on its way; answer it on the forge/);
});

/** Fake queues that list jobs by state (`getJobs`), as BullMQ does, for the pending-answer scan. */
function listingQueues(byState, { throws = false, noList = false } = {}) {
  return [
    {
      name: "pi-jobs",
      getJob: async () => null,
      ...(noList
        ? {}
        : {
            getJobs: async ([state], start, end) => {
              if (throws) throw new Error("ECONNREFUSED 10.0.0.1:6379");
              return (byState[state] ?? []).slice(start, end + 1);
            },
          }),
    },
  ];
}
const forgeJob = (id, repo, number, extra = {}) => ({ id, data: { kind: "github", repo, target: { type: "issue", number }, ...extra } });

test("readPendingAnswer: a job queued or running on the park's target (case and zeros as targetKeyOf), never the park's own; a partial or failed scan says so", async () => {
  const q = listingQueues({ active: [forgeJob("gh-other", "acme/web", 120)], waiting: [forgeJob("gh-answer", "Acme/Web", 12)] });
  assert.deepEqual(await readPendingAnswer({ queues: q, kind: "github", target: "acme/web#12", runId: "gh-park" }), { jobId: "gh-answer" });
  assert.deepEqual(await readPendingAnswer({ queues: q, kind: "github", target: "acme/web#13", runId: "gh-park" }), { jobId: null });
  assert.deepEqual(await readPendingAnswer({ queues: q, kind: "forgejo", target: "acme/web#12", runId: "gh-park" }), { jobId: null }, "another forge's issue 12 is not this one");
  const own = listingQueues({ waiting: [forgeJob("gh-park", "acme/web", 12), forgeJob("gh-park.r1", "acme/web", 12, { recoveryOf: "gh-park" })] });
  assert.deepEqual(await readPendingAnswer({ queues: own, kind: "github", target: "acme/web#12", runId: "gh-park" }), { jobId: null }, "the park's own job and recovery are not its answer");
  const full = listingQueues({ waiting: Array.from({ length: 3 }, (_, i) => forgeJob(`gh-${i}`, "acme/web", 500 + i)) });
  assert.deepEqual(await readPendingAnswer({ queues: full, kind: "github", target: "acme/web#12", runId: "gh-park", budget: 3 }), { jobId: null }, "exactly the budget is a complete look (review round 2: the off-by-one)");
  assert.deepEqual(await readPendingAnswer({ queues: full, kind: "github", target: "acme/web#12", runId: "gh-park", budget: 2 }), { unknown: true, tooMany: true }, "past the budget the scan says the queue is too deep");
  assert.deepEqual(await readPendingAnswer({ queues: listingQueues({}, { noList: true }), kind: "github", target: "acme/web#12" }), { unknown: true, tooMany: false }, "a queue it cannot list is unknown, not too deep");
  assert.deepEqual(await readPendingAnswer({ queues: listingQueues({}, { throws: true }), kind: "github", target: "acme/web#12" }), { unreachable: true }, "never the error's text");
  assert.deepEqual(await readPendingAnswer({ queues: listingQueues({ waiting: [{ id: "x", data: { kind: "local" } }, { id: "y", data: null }] }), kind: "github", target: "acme/web#12" }), { jobId: null }, "an entry with no target is skipped, not thrown on");
});

test("readPendingOnTargets pages every state under ONE budget: a busy state no longer makes the whole look partial, and it stops once every target is found (review round 2)", async () => {
  const many = (n, at = 0) => Array.from({ length: n }, (_, i) => forgeJob(`gh-w${at + i}`, "acme/web", 1000 + at + i));
  // 450 waiting and 300 delayed: a cap of 200 per state called this partial; pages of 100 under a budget of 1,000 do not.
  const busy = listingQueues({ waiting: [...many(449), forgeJob("gh-deep", "acme/web", 12)], delayed: many(300, 500) });
  assert.deepEqual(await readPendingAnswer({ queues: busy, kind: "github", target: "acme/web#12", runId: "gh-park", page: 100, budget: 1000 }), { jobId: "gh-deep" }, "the answer past four pages is found");
  assert.deepEqual(await readPendingAnswer({ queues: busy, kind: "github", target: "acme/web#13", runId: "gh-park", page: 100, budget: 1000 }), { jobId: null }, "and a target with none is known to have none");
  assert.deepEqual(await readPendingAnswer({ queues: busy, kind: "github", target: "acme/web#13", runId: "gh-park", page: 100, budget: 750 }), { jobId: null }, "750 jobs under a budget of 750: complete");
  assert.deepEqual(await readPendingAnswer({ queues: busy, kind: "github", target: "acme/web#13", runId: "gh-park", page: 100, budget: 749 }), { unknown: true, tooMany: true });
  // Every state is read, in the order a job moves through them, and the look ends once each target is matched.
  const seen = [];
  const spy = [{ name: "pi-jobs", getJobs: async ([state], start, end) => (seen.push(state), state === "waiting" ? [forgeJob("gh-a", "acme/web", 12)].slice(start, end + 1) : []) }];
  assert.deepEqual(await readPendingAnswer({ queues: spy, kind: "github", target: "acme/web#12" }), { jobId: "gh-a" });
  assert.deepEqual(seen, ["waiting-children", "delayed", "prioritized", "paused", "waiting"], "active is never read once the answer is found");
  assert.deepEqual([...PENDING_STATES].sort(), ["active", ...QUEUED_STATES].sort(), "the scan's states are chat-mode's queued words and active, no more");
});

test("/api/run: an inbox that could not be read is armed null, never a guessed false (review L12)", { timeout: 20_000 }, async () => {
  const fleet = fakeFleet({ jobs: { "gh-act": { found: true, state: "active", continuesAs: null } }, transcript: { "gh-act": { exists: true, ended: false, outcome: null, length: 1 } }, inbox: { "gh-act": { unreachable: true } } });
  const c = await runConsole(fleet);
  assert.deepEqual((await c.get("/api/run?id=gh-act")).json().steer, { armed: null, open: null });
  const plain = fakeFleet({ jobs: { "gh-act": { found: true, state: "active", continuesAs: null } }, inbox: { "gh-act": { found: true, steer: false } } });
  assert.deepEqual((await (await runConsole(plain)).get("/api/run?id=gh-act")).json().steer, { armed: false, open: false });
});

test("chatFactsOf: the run page loop reuses a parked record's newer-run search for NEWER_CACHE_MS per run id, and searches again on a new record (review L13)", async () => {
  const parked = record("gh-park", { reason: "awaiting-input", target: "acme/web#20" });
  const fleet = fakeFleet({ records: { "gh-park": parked }, jobs: { "gh-park": { found: true, state: "completed", continuesAs: null } } });
  let t = T0;
  const now = () => t;
  for (let i = 0; i < 3; i += 1) assert.equal((await chatFactsOf(fleet, "gh-park", parked, { searchNewer: "parked", now })).mode, "reply");
  assert.equal(fleet.calls.runsPage.length, 1, "one search for three refreshes");
  t += NEWER_CACHE_MS;
  await chatFactsOf(fleet, "gh-park", parked, { searchNewer: "parked", now });
  assert.equal(fleet.calls.runsPage.length, 2, "searched again once the window passed");
  await chatFactsOf(fleet, "gh-park", { ...parked, endedAt: iso(T0 - 1000) }, { searchNewer: "parked", now });
  assert.equal(fleet.calls.runsPage.length, 3, "a different record is searched afresh");
  await chatFactsOf(fleet, "gh-park", parked, { now });
  assert.equal(fleet.calls.runsPage.length, 4, "/api/run's search is never cached");
});

test("chatFactsOf and parkedAnswerCheckOf: the run page loop reuses a park's pending scan and planner check for PARK_CHECK_CACHE_MS per run id, reads again on a new record, and never keeps an unreadable one (review round 2)", async () => {
  const parked = record("gh-park2", { reason: "awaiting-input", target: "acme/web#21" });
  let pending = { jobId: null };
  const fleet = fakeFleet({ records: { "gh-park2": parked }, jobs: { "gh-park2": { found: true, state: "completed", continuesAs: null } }, pending: () => pending });
  let checks = 0;
  let check = { ok: true };
  fleet.parkedAnswerCheck = async () => ((checks += 1), check);
  let t = T0;
  const now = () => t;
  const tick = async (rec = parked) => {
    const facts = await chatFactsOf(fleet, "gh-park2", rec, { searchNewer: "parked", now });
    return { facts, check: await parkedAnswerCheckOf(fleet, "gh-park2", rec, { now }) };
  };
  for (let i = 0; i < 5; i += 1) {
    const got = await tick();
    assert.equal(got.facts.mode, "reply");
    assert.deepEqual(got.check, { ok: true });
    t += 2_000; // the run page's own refresh
  }
  assert.equal(fleet.calls.pending.length, 1, "one queue scan for five ticks");
  assert.equal(checks, 1, "one planner check for five ticks");
  t = T0 + PARK_CHECK_CACHE_MS;
  await tick();
  assert.equal(fleet.calls.pending.length, 2, "scanned again once the window passed");
  assert.equal(checks, 2);
  await tick({ ...parked, endedAt: iso(T0 - 1000) });
  assert.equal(fleet.calls.pending.length, 3, "a different record reads afresh");
  assert.equal(checks, 3);
  // An unreadable scan or check is read again on the next tick, never reused.
  t += PARK_CHECK_CACHE_MS;
  pending = { unreachable: true };
  check = { unreachable: true };
  await tick();
  await tick();
  assert.equal(fleet.calls.pending.length, 5);
  assert.equal(checks, 5);
  // `/api/run` scans afresh every time.
  await chatFactsOf(fleet, "gh-park2", parked, { now });
  await chatFactsOf(fleet, "gh-park2", parked, { now });
  assert.equal(fleet.calls.pending.length, 7);
});

test("the run page's loader reads a park's planner check through the cache: five 2 s refreshes read it once (review round 2)", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const parked = record("gh-park6", { reason: "awaiting-input", target: "acme/web#24" });
  const fleet = fakeFleet({ records: { "gh-park6": parked }, jobs: { "gh-park6": { found: true, state: "completed", continuesAs: null } }, pending: { jobId: null } });
  let checks = 0;
  fleet.parkedAnswerCheck = async () => ((checks += 1), { ok: true });
  for (let i = 0; i < 5; i += 1) {
    const data = await loadPageData("run", { id: "gh-park6" }, { fleet, now: T0 + i * 2_000 });
    assert.equal(data.chat.mode, "reply");
    assert.deepEqual(data.chatAnswer, { ok: true });
  }
  assert.equal(checks, 1, "one planner check");
  assert.equal(fleet.calls.pending.length, 1, "one queue scan");
});

test("chatFactsOf: once the answer seen running is gone, the cached newer-run search is made again, so an answered park is never offered a reply for the rest of NEWER_CACHE_MS (review round 2)", async () => {
  const parked = record("gh-park3", { reason: "awaiting-input", target: "acme/web#22", endedAt: iso(T0 - 300_000) });
  const history = [parked];
  let pending = { jobId: "gh-ans3" };
  const fleet = fakeFleet({ records: { "gh-park3": parked }, runs: history, jobs: { "gh-park3": { found: true, state: "completed", continuesAs: null } }, pending: () => pending });
  let t = T0;
  const now = () => t;
  const first = await chatFactsOf(fleet, "gh-park3", parked, { searchNewer: "parked", now });
  assert.deepEqual([first.state, first.mode, first.answeringJobId], ["answered", null, "gh-ans3"]);
  assert.equal(fleet.calls.runsPage.length, 1);
  // The answer run ends: its record is written and the job leaves the queue, inside the newer-run search's window.
  history.unshift(record("gh-ans3", { target: "acme/web#22", endedAt: iso(T0 + 5_000) }));
  pending = { jobId: null };
  t = T0 + PARK_CHECK_CACHE_MS;
  assert.ok(t - T0 < NEWER_CACHE_MS, "still inside the cached newer-run answer's window");
  const after = await chatFactsOf(fleet, "gh-park3", parked, { searchNewer: "parked", now });
  assert.deepEqual([after.state, after.mode, after.says, after.newer.jobId], ["answered", null, CHAT_REFUSALS.answered, "gh-ans3"]);
  assert.equal(fleet.calls.runsPage.length, 2, "the newer-run search was made again");
  // A park that never saw an answer keeps its cached search: nothing is re-read without cause.
  const quiet = record("gh-park4", { reason: "awaiting-input", target: "acme/web#23" });
  const calm = fakeFleet({ records: { "gh-park4": quiet }, jobs: { "gh-park4": { found: true, state: "completed", continuesAs: null } }, pending: { jobId: null } });
  t = T0;
  await chatFactsOf(calm, "gh-park4", quiet, { searchNewer: "parked", now });
  t = T0 + PARK_CHECK_CACHE_MS;
  assert.equal((await chatFactsOf(calm, "gh-park4", quiet, { searchNewer: "parked", now })).mode, "reply");
  assert.equal(calm.calls.runsPage.length, 1);
});

test("the Chat panel and the parked inbox draw an answer form for exactly the same pending scans, and say the same sentence when they refuse (review round 2)", async () => {
  const parked = record("gh-park5", { reason: "awaiting-input", target: "acme/web#12" });
  const scans = [{ jobId: "gh-77" }, { jobId: null }, { unknown: true, tooMany: false }, { unknown: true, tooMany: true }, { unreachable: true }];
  for (const scan of scans) {
    const fleet = fakeFleet({ records: { "gh-park5": parked }, jobs: { "gh-park5": { found: true, state: "completed", continuesAs: null } }, pending: scan });
    const chat = await chatFactsOf(fleet, "gh-park5", parked, { now: () => T0 });
    const panel = String(runChat({ role: "operator", readOnly: false, env: {}, now: T0, query: { id: "gh-park5" }, data: { chat, run: { record: parked }, chatAnswer: { ok: true } } }));
    const inbox = String(parkedInbox({ role: "operator", readOnly: false, env: {}, now: T0, data: { snapshot: { parked: [{ target: "acme/web#12", kind: "github", jobId: "gh-park5", parkedAt: T0, ageMs: 0, chainCount: 1, pendingScan: scan }] } } }));
    const form = (html) => html.includes('data-action="parked-answer"');
    assert.equal(form(panel), form(inbox), `${JSON.stringify(scan)}: both screens draw the form, or neither`);
    assert.equal(form(panel), scan.jobId === null, `${JSON.stringify(scan)}: only a complete look that found no answer offers one`);
    if (chat.mode === null && chat.answeringJobId === null) assert.ok(inbox.includes(chat.says.replace(/'/g, "&#39;")), `${JSON.stringify(scan)}: the inbox says the panel's sentence`);
    assert.deepEqual(parkedVerdictOf(scan).says, chat.says, "one verdict");
  }
});

test("/api/run?url=: an exact-target scan, so #12 is found past a page of #120s, a long target is not the kind's newest 100, case and zeros are one target (review L14)", { timeout: 20_000 }, async () => {
  const crowd = Array.from({ length: TARGET_RUNS_MAX + 20 }, (_, i) => record(`gh-c${i}`, { target: `acme/web#12${i}`, endedAt: iso(T0 - i * 1000) }));
  const mine = record("gh-mine", { target: "acme/web#12", endedAt: iso(T0 - 9_000_000) });
  const azCrowd = Array.from({ length: TARGET_RUNS_MAX + 5 }, (_, i) => record(`az-c${i}`, { kind: "azure", target: `proj/repo#12${i}`, endedAt: iso(T0 - i * 1000) }));
  const az = record("az-mine", { kind: "azure", target: "Proj/repo#12", endedAt: iso(T0 - 9_000_000) });
  const longRepo = `g/${"s".repeat(40)}/${"t".repeat(40)}/${"u".repeat(40)}/p`; // past the q filter's 100 characters
  const gl = record("gl-long", { kind: "gitlab", target: `${longRepo}#3`, endedAt: iso(T0 - 9_000_000) });
  const glCrowd = Array.from({ length: TARGET_RUNS_MAX + 5 }, (_, i) => record(`gl-c${i}`, { kind: "gitlab", target: `g/p#${i}`, endedAt: iso(T0 - i * 1000) }));
  const runs = [...crowd, ...azCrowd, ...glCrowd, mine, az, gl];
  const fleet = fakeFleet({ records: Object.fromEntries(runs.map((r) => [r.jobId, r])), runs });
  const c = await runConsole(fleet);
  const url = (u) => `/api/run?url=${encodeURIComponent(u)}`;
  assert.equal((await c.get(url("https://github.com/acme/web/issues/12"))).json().run.id, "gh-mine");
  assert.equal((await c.get(url("https://github.com/ACME/Web/issues/012"))).json().run.id, "gh-mine", "a repository's case and a number's zeros");
  assert.equal((await c.get(url("https://dev.azure.com/acme/proj/_workitems/edit/12"))).json().run.id, "az-mine", "#12 is not crowded out by #120...");
  const long = await c.get(url(`https://gitlab.example.com/sub/${longRepo}/-/issues/3`));
  assert.equal(long.status, 200, long.text);
  assert.equal(long.json().run.id, "gl-long");
  for (const call of fleet.calls.runsPage) assert.equal(call.filter.q, undefined, "never the substring filter");
  // A scan that stopped at its bound without a match says how far it looked.
  const bounded = fakeFleet({ runs: [], page: { truncated: true, next: T0 - 1 } });
  const nb = await (await runConsole(bounded)).get(url("https://github.com/acme/web/issues/5"));
  assert.equal(nb.status, 404);
  assert.match(nb.json().error, /among the newest \d+ runs this lookup searches/);
  // A history whose mirror or logs could not be read is a 503, not "no run".
  for (const page of [{ unreachable: "the logs directory could not be read" }, { mirror: "unreachable: timed out" }]) {
    const res = await (await runConsole(fakeFleet({ runs: [mine], page }))).get(url("https://github.com/acme/web/issues/12"));
    assert.equal(res.status, 503, JSON.stringify(page));
  }
});

test("/api/run: a parked record's newer-run search that stopped before the record's own instant is unknown, never \"no later run\" (review L14)", { timeout: 20_000 }, async () => {
  const parked = record("gh-park", { reason: "awaiting-input", target: "acme/web#20", endedAt: iso(T0 - 9_000_000) });
  const c = await runConsole(fakeFleet({ records: { "gh-park": parked }, runs: [], page: { truncated: true, next: T0 - 1000 } }));
  const d = (await c.get("/api/run?id=gh-park")).json();
  assert.deepEqual([d.state, d.mode, d.says], ["unknown", null, CHAT_REFUSALS.parkedUnknown]);
  const reached = await runConsole(fakeFleet({ records: { "gh-park": parked }, runs: [], page: { truncated: true, next: T0 - 10_000_000 } }));
  assert.equal((await reached.get("/api/run?id=gh-park")).json().mode, "reply", "a scan that reached past the record saw every later run");
});
