import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { after, test } from "node:test";
import { FORGE_KINDS, FORGES } from "@edgehero/pi-dispatch/forges";
import { errorPage, RUN_PATH_SENTENCES } from "../src/console/error-pages.mjs";
import { returnPathOf } from "../src/console/pages.mjs";
import { resolveRunPath, RUN_PATH_STATES } from "../src/console/run-api.mjs";
import { parseRunPath, RUN_PATH_PREFIX, RUN_PATH_QUERY_REFUSAL, RUN_PATH_REFUSAL, RUN_PATH_SEGMENTS_MAX, runPathLink, runPathOf } from "../src/console/run-path.mjs";
import { createConsoleServer, lookupRoute, ROUTES } from "../src/console/server.mjs";
import * as sessionsModule from "../src/console/sessions.mjs";
import { PENDING_STATES, readPendingOnTargets, RUNS_PAGE_EXAMINE_MAX, targetKeyOf } from "../src/read-model.mjs";

// A run's short link (issue #882, part 3): `/run/<repository>/<number>`, `!` before the number for a merge request,
// which opens the newest run on that issue or request. The link's shape both ways (`parseRunPath`, `runPathOf`, held to
// each other and to `targetKeyOf`), the resolution over a fake fleet (`resolveRunPath`), the scan's state order, the
// route over a real node:http server with the real session store, the sign-in return, and the run page's goldens. No
// Valkey, no clock beyond an injected one.

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
/** The pathname a browser's address bar hands the server for `s`, as the dispatcher reads it. */
const pathOf = (s) => new URL(s, "http://console.invalid").pathname;

// ---- the link's shape ---------------------------------------------------------------------------------------------------

test("parseRunPath reads a repository path of two or more segments and a number, `!` before it for a merge request", () => {
  const ok = [
    ["/run/acme/web/12", "acme/web#12"],
    ["/run/acme/web/12/", "acme/web#12"],
    // Dots, dashes and underscores, and the case as typed (targetKeyOf compares without it).
    ["/run/Acme.Org/my-repo_2.js/7", "Acme.Org/my-repo_2.js#7"],
    // A number's leading zeros are dropped, as the forges and targetKeyOf drop them.
    ["/run/acme/web/007", "acme/web#7"],
    ["/run/acme/web/0", "acme/web#0"],
    // GitLab subgroups, and a merge request.
    ["/run/group/sub/deeper/project/!44", "group/sub/deeper/project!44"],
    ["/run/group/project/%2144", "group/project!44"],
    // An Azure project's inner space travels as %20.
    ["/run/My%20Project/repo/9", "My Project/repo#9"],
    ["/run/" + Array.from({ length: RUN_PATH_SEGMENTS_MAX }, (_, i) => `g${i}`).join("/") + "/1", `${Array.from({ length: RUN_PATH_SEGMENTS_MAX }, (_, i) => `g${i}`).join("/")}#1`],
  ];
  for (const [path, target] of ok) assert.equal(parseRunPath(pathOf(path)).target, target, path);
  assert.deepEqual(parseRunPath("/run/group/project/!0044"), { target: "group/project!44", repo: "group/project", sep: "!", number: "44" });
  const refused = [
    "/run/", "/run/acme", "/run/acme/12", "/run/acme/web", "/run/acme/web/", "/run/acme/web/x12", "/run/acme/web/12x", "/run/acme/web/-1",
    "/run/acme/web/!!1", "/run/acme/web/1!", "/run/acme/web/#12", "/run/acme/web/%2312", "/run/acme//web/1", "/run/a%2Fb/web/1",
    "/run/acme/%2E%2E/1", "/run/acme/w%E0%A4%A/1", "/run/acme/w%00b/1", "/run/acme/w%0Ab/1", "/run/acme/%20web/1", "/run/acme/web%20/1",
    "/run/acme/w<b/1", "/run/acme/w:b/1", "/run/acme/web/1234567890123456789012345678901", `/run/${"a".repeat(101)}/web/1`,
    "/run/" + Array.from({ length: RUN_PATH_SEGMENTS_MAX + 1 }, (_, i) => `g${i}`).join("/") + "/1",
    "/runs/acme/web/1", "/run", null, 7,
  ];
  for (const path of refused) {
    const got = parseRunPath(typeof path === "string" ? pathOf(path) : path);
    assert.deepEqual(got, { refusal: RUN_PATH_REFUSAL }, String(path));
  }
  // A target past the run target's own bound (300) is refused whole, never cut.
  assert.deepEqual(parseRunPath(`/run/${Array.from({ length: 4 }, () => "a".repeat(80)).join("/")}/1`), { refusal: RUN_PATH_REFUSAL });
  // The refusal names the shape and never the value: the 400 page puts it in a sentence.
  assert.ok(!RUN_PATH_REFUSAL.includes("acme") && RUN_PATH_REFUSAL.startsWith("a short run link is /run/"));
});

test("runPathOf: a forge run's target as its short link, and none for anything else", () => {
  assert.equal(runPathOf("github", "acme/web#12"), "/run/acme/web/12");
  assert.equal(runPathOf("github", "Acme/Web#012"), "/run/Acme/Web/12", "the record's case, the number without zeros");
  assert.equal(runPathOf("gitlab", "group/sub/project!44"), "/run/group/sub/project/!44");
  assert.equal(runPathOf("gitlab", "group/project#3"), "/run/group/project/3");
  assert.equal(runPathOf("forgejo", "owner/repo#5"), "/run/owner/repo/5");
  assert.equal(runPathOf("azure", "My Project/repo!9"), "/run/My%20Project/repo/!9");
  assert.equal(runPathOf("azure", "proj/repo#31"), "/run/proj/repo/31");
  for (const [kind, target] of [
    ["local", "local:web"], ["watch", "watch:shop-5xx"], ["github", "local:web"], ["github", "acme/web!7"], ["forgejo", "owner/repo!7"],
    ["github", "web#12"], ["github", "acme/web"], ["github", "acme/web#"], ["github", "acme//web#1"], ["github", "acme/../web#1"],
    ["github", "acme/w<b>#1"], ["github", `acme/web"><script>#1`], ["github", "/workspace/repo"], ["nope", "acme/web#1"],
    ["github", null], [null, "acme/web#1"], ["github", `${"a/".repeat(160)}x#1`],
  ]) {
    assert.equal(runPathOf(kind, target), null, `${kind} ${target}`);
  }
});

test("every short link the run page draws reads back to its run's target: parseRunPath is runPathOf's inverse, as targetKeyOf compares", () => {
  const targets = ["acme/web#12", "Acme/Web.js#0007", "group/sub/project!44", "group/project#3", "owner/repo#5", "My Project/repo!9", "proj/repo#31", "a-b_c.d/e.f-g_h#99999"];
  let n = 0;
  for (const kind of FORGE_KINDS) {
    for (const target of targets) {
      const path = runPathOf(kind, target);
      if (path === null) {
        // Only a separator the forge never writes, or a repository depth the forge does not have, draws none.
        assert.ok(target.includes("!") && FORGES[kind].pullRequestSep !== "!", `${kind} ${target}`);
        continue;
      }
      n += 1;
      const back = parseRunPath(pathOf(path));
      assert.equal(targetKeyOf(kind, back.target), targetKeyOf(kind, target), `${kind} ${target} -> ${path}`);
      assert.equal(pathOf(path), path, `${path} is already as a browser sends it`);
    }
  }
  assert.ok(n >= 20, `${n} round trips`);
});

test("runPathLink: a link and its title, every value escaped; none for a run with no short link", () => {
  assert.equal(String(runPathLink({ kind: "github", target: "acme/web#12" })), '<a class="run-path" href="/run/acme/web/12" title="Opens the newest run on acme/web#12">/run/acme/web/12</a>');
  assert.equal(String(runPathLink({ kind: "gitlab", target: "g/p!7" })), '<a class="run-path" href="/run/g/p/!7" title="Opens the newest run on g/p!7">/run/g/p/!7</a>');
  for (const run of [null, {}, { kind: "local", target: "local:x" }, { kind: "github", target: `acme/web"><img src=x onerror=alert(1)>#1` }]) assert.equal(runPathLink(run), null, JSON.stringify(run));
});

// ---- the resolution -----------------------------------------------------------------------------------------------------

/** A record on `target`, ending `agoMs` before T0. */
const rec = (jobId, target, agoMs, fields = {}) => ({ jobId, kind: "github", target, outcome: "completed", reason: "done", startedAt: iso(T0 - agoMs - 60_000), endedAt: iso(T0 - agoMs), ...fields });

/**
 * A fake fleet: `runs` the history (any order: the reader sorts nothing here, the resolution does), the runs page as the
 * real reader answers it (the filter, then the caller's predicate, then the limit); `queue` what `pendingOnTargets`
 * answers, or a function of its arguments; `page` extra fields for the runs page's answer.
 */
function fleetOf({ runs = [], queue = { byKey: new Map(), complete: true, tooMany: false }, page = {}, runsPageThrows = false, noQueue = false } = {}) {
  const calls = { runsPage: [], pending: [] };
  return {
    calls,
    runsPage: async (opts) => {
      calls.runsPage.push(opts);
      if (runsPageThrows) throw new Error("ECONNREFUSED 10.0.0.1:6379");
      const f = opts.filter ?? {};
      const hits = runs.filter((r) => (!f.kind || r.kind === f.kind) && (typeof opts.match !== "function" || opts.match(r)));
      return { runs: hits.slice(0, opts.limit ?? 100), next: null, mirror: "ok", ...page };
    },
    ...(noQueue ? {} : { pendingOnTargets: async (targets, opts) => (calls.pending.push({ targets, opts }), typeof queue === "function" ? queue(targets, opts) : queue) }),
  };
}

/** A whole queue scan holding `jobs`: `[kind, target, jobId]`. */
const queueOf = (jobs) => ({ byKey: new Map(jobs.map(([kind, target, id]) => [targetKeyOf(kind, target), id])), complete: true, tooMany: false });

test("resolveRunPath: the newest record on exactly that target, on any forge, its case and zeros as targetKeyOf compares them", async () => {
  const runs = [rec("gh-old", "acme/web#12", 9_000), rec("gh-new", "Acme/Web#012", 1_000), rec("gh-120", "acme/web#120", 10), rec("gh-other", "acme/api#12", 5), rec("gh-draft", "acme/web#12", 1, { purpose: "answer-draft" })];
  const fleet = fleetOf({ runs });
  assert.deepEqual(await resolveRunPath(fleet, "acme/web#12"), { id: "gh-new" }, "#120 never answers #12, and an answer draft is no run");
  // Every forge's runs in one runs page: no kind filter, the record's own kind handed to the match.
  assert.equal(fleet.calls.runsPage.at(-1).filter, null);
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: [rec("gl-1", "group/sub/p!7", 100, { kind: "gitlab" })] }), "group/sub/p!7"), { id: "gl-1" });
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: [rec("gl-1", "group/sub/p!7", 100, { kind: "gitlab" })] }), "group/sub/p#7"), { absent: true, truncated: false }, "a merge request is not the issue of the same number");
  // A record whose id the run page would refuse is no answer.
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: [rec("bad id", "acme/web#12", 10), rec("gh-ok", "acme/web#12", 20)] }), "acme/web#12"), { id: "gh-ok" });
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: [rec("local-1", "local:web", 10, { kind: "local" })] }), "local:web#1"), { absent: true, truncated: false });
});

test("resolveRunPath: a job queued or running on the target is the newest run, before any record; the scan reads active first, on every forge at once", async () => {
  const runs = [rec("gh-ended", "acme/web#12", 1_000)];
  const fleet = fleetOf({ runs, queue: queueOf([["github", "acme/web#12", "gh-live"]]) });
  assert.deepEqual(await resolveRunPath(fleet, "acme/web#12"), { id: "gh-live" });
  const asked = fleet.calls.pending.at(-1);
  assert.deepEqual(asked.targets, FORGE_KINDS.map((kind) => ({ kind, target: "acme/web#12", runId: null })));
  assert.deepEqual(asked.opts, { states: RUN_PATH_STATES });
  // An issue's first run, still running, has no record: today's /api/run says 404, the short link opens it.
  assert.deepEqual(await resolveRunPath(fleetOf({ queue: queueOf([["github", "acme/web#12", "gh-first"]]) }), "acme/web#12"), { id: "gh-first" });
  // A queue that could not be read does not stop a record from opening (the run page reads the queue itself and says so).
  for (const queue of [{ unreachable: true }, { byKey: new Map(), complete: false, tooMany: true }]) {
    assert.deepEqual(await resolveRunPath(fleetOf({ runs, queue }), "acme/web#12"), { id: "gh-ended" }, JSON.stringify(queue));
  }
  assert.deepEqual(await resolveRunPath(fleetOf({ runs, queue: () => { throw new Error("x"); } }), "acme/web#12"), { id: "gh-ended" });
  // A queue job whose id the run page would refuse is no answer.
  assert.deepEqual(await resolveRunPath(fleetOf({ runs, queue: queueOf([["github", "acme/web#12", "bad id"]]) }), "acme/web#12"), { id: "gh-ended" });
});

test("resolveRunPath: runs on two forges for one path are the person's to pick, never a guess", async () => {
  const both = [rec("gh-1", "acme/web#12", 100), rec("fj-1", "acme/web#12", 50, { kind: "forgejo" })];
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: both }), "acme/web#12"), { several: true });
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: [both[0]], queue: queueOf([["forgejo", "acme/web#12", "fj-live"]]) }), "acme/web#12"), { several: true }, "a record on one and a live job on the other");
  assert.deepEqual(await resolveRunPath(fleetOf({ runs: [both[0]], queue: queueOf([["github", "acme/web#12", "gh-live"]]) }), "acme/web#12"), { id: "gh-live" }, "one forge, a record and a live job");
});

test("resolveRunPath: none found is absent only when every place was read; otherwise it cannot be told", async () => {
  assert.deepEqual(await resolveRunPath(fleetOf(), "acme/web#12"), { absent: true, truncated: false });
  assert.deepEqual(await resolveRunPath(fleetOf({ page: { truncated: true, next: T0 - 5_000 } }), "acme/web#12"), { absent: true, truncated: true }, "the search stopped at its bound: still absent, the page says how far it looked");
  for (const [what, fleet] of [
    ["a queue it could not read", fleetOf({ queue: { unreachable: true } })],
    ["a queue deeper than its budget", fleetOf({ queue: { byKey: new Map(), complete: false, tooMany: true } })],
    ["a queue it could not list", fleetOf({ queue: { byKey: new Map(), complete: false, tooMany: false } })],
    ["no queue reader", fleetOf({ noQueue: true })],
    ["a history that threw", fleetOf({ runsPageThrows: true })],
    ["this host's history unreadable", fleetOf({ page: { unreachable: true } })],
    ["the run mirror unreachable", fleetOf({ page: { mirror: "unreachable: timeout" } })],
    ["no reader at all", {}],
  ]) {
    assert.deepEqual(await resolveRunPath(fleet, "acme/web#12"), { untold: true }, what);
  }
});

test("readPendingOnTargets reads the states in the order it is given: a running job before a waiting one, and a job that moves is still met", async () => {
  const job = (id, repo, number, kind = "github") => ({ id, data: { kind, repo, target: { type: "issue", number } } });
  const queues = (byState, seen = []) => [{ name: "pi-jobs", getJob: async () => null, getJobs: async ([state], start, end) => (seen.push(state), (byState[state] ?? []).slice(start, end + 1)) }];
  const both = { waiting: [job("gh-follow-up", "acme/web", 12)], active: [job("gh-running", "acme/web", 12)] };
  const key = targetKeyOf("github", "acme/web#12");
  assert.equal((await readPendingOnTargets({ queues: queues(both), targets: [{ kind: "github", target: "acme/web#12" }] })).byKey.get(key), "gh-follow-up", "the default order meets a waiting job first");
  const seen = [];
  const got = await readPendingOnTargets({ queues: queues(both, seen), targets: [{ kind: "github", target: "acme/web#12" }], states: RUN_PATH_STATES });
  assert.equal(got.byKey.get(key), "gh-running");
  assert.deepEqual(seen, ["active"], "the look ends once every target is matched");
  assert.deepEqual([...RUN_PATH_STATES], ["active", ...PENDING_STATES], "active first, then every state in the scan's own order, active again among them");
  // A job that moves from waiting to active between the first read of active and the read of waiting is met in the
  // second read of active, never lost between two.
  let reads = 0;
  const moving = [{ name: "pi-jobs", getJob: async () => null, getJobs: async ([state], start, end) => {
    reads += 1;
    const now = state === "active" && reads > 1 ? [job("gh-moved", "acme/web", 12)] : [];
    return now.slice(start, end + 1);
  } }];
  assert.equal((await readPendingOnTargets({ queues: moving, targets: [{ kind: "github", target: "acme/web#12" }], states: RUN_PATH_STATES })).byKey.get(key), "gh-moved");
  // Every forge kind's target in one scan: each matched by its own kind.
  const mixed = { waiting: [job("gl-7", "group/p", 7, "gitlab"), job("gh-7", "group/p", 7)] };
  const all = await readPendingOnTargets({ queues: queues(mixed), targets: FORGE_KINDS.map((kind) => ({ kind, target: "group/p#7" })), states: RUN_PATH_STATES });
  assert.equal(all.byKey.get(targetKeyOf("gitlab", "group/p#7")), "gl-7");
  assert.equal(all.byKey.get(targetKeyOf("github", "group/p#7")), "gh-7");
  assert.equal(all.byKey.has(targetKeyOf("forgejo", "group/p#7")), false);
  assert.equal(all.complete, true);
});

// ---- the not-found page -------------------------------------------------------------------------------------------------

test("the short link's not-found page: the run page's own card in the link's words, the target in its search, 404 or 503", () => {
  for (const [status, said] of [[404, RUN_PATH_SENTENCES.absent], [503, RUN_PATH_SENTENCES.untold]]) {
    const out = errorPage({ kind: "no-run", status, target: "acme/web#12", session: { name: "ops", role: "operator" } });
    const page = String(out.html);
    assert.equal(out.status, status);
    assert.ok(page.includes(`<h1>${said.title}</h1>`) && page.includes(`<h2 class="er-h">${said.heading}</h2>`), `${status}: its title and heading`);
    assert.ok(page.includes(`<p class="er-s">${said.sentence.replaceAll("'", "&#39;")}</p>`), `${status}: its sentence`);
    assert.ok(page.includes('name="q" value="acme/web#12"'), `${status}: the search holds the target`);
    assert.equal(page.split("acme/web#12").length - 1, 1, `${status}: the target once, as the search field's value`);
    assert.ok(page.includes(">Go to Runs</a>") && page.includes(">Go to Overview</a>"));
    assert.deepEqual([...page.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((m) => m[1]), ["/runs"], "Runs current, as the run page's");
  }
  assert.ok(RUN_PATH_SENTENCES.absent.sentence.includes(`newest ${RUNS_PAGE_EXAMINE_MAX.toLocaleString("en-US")} runs`), "the search's bound, from the reader's own constant");
  // The run id's 404 says what it said.
  assert.ok(String(errorPage({ kind: "no-run", runId: "gh-1" }).html).includes("No run with this id"));
  // A target the runs search would not take leaves the field empty.
  assert.ok(String(errorPage({ kind: "no-run", target: `${"a".repeat(200)}/b#1` }).html).includes('id="q" type="search" name="q" placeholder'));
});

// ---- the route ----------------------------------------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;
const AGENT_TOKEN = `pdc_${"a".repeat(43)}`;
const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
});

async function runConsole(fleet) {
  const now = () => T0;
  const file = {
    version: 1,
    generation: 0,
    tokens: [
      { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
      { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
      { name: "automation", role: "agent", sha256: sha256(AGENT_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
    ],
  };
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly: false, maxMs: 12 * 3600_000 },
    now,
    audit: { append: (row) => row },
    sessions: sessionsModule.makeSessionStore({ now }),
    cookies: sessionsModule,
    tickets: { issue: () => ({ ticket: "t" }), redeem: () => ({ refusal: "no" }) },
    readTokens: () => ({ file }),
    findToken: (f, presented) => f.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: () => ({ ok: true }),
    pageDeps: fleet === null ? null : { fleet, env: {}, now },
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  const send = ({ method = "GET", path, headers = {} }) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers }, setHost: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end();
    });
  const login = async (token) => {
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/login", headers: { host, origin: `http://${host}`, "content-type": "application/json" }, setHost: false }, (r) => {
        let text = "";
        r.on("data", (c) => (text += c));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, text }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ token }));
    });
    assert.equal(res.status, 200, res.text);
    return res.headers["set-cookie"][0].split(";")[0];
  };
  return { send, op: await login(OP_TOKEN), viewer: await login(VIEW_TOKEN), agent: await login(AGENT_TOKEN) };
}

test("the route table has one prefix route, the short link's, a viewer's GET; /run itself stays the run page's exact route", () => {
  assert.deepEqual(ROUTES.filter((r) => r.prefix).map((r) => [r.method, r.path, r.auth, r.write]), [["GET", RUN_PATH_PREFIX, "viewer", false]]);
  assert.equal(lookupRoute("GET", "/run").route.page, "run");
  assert.equal(lookupRoute("GET", "/run/acme/web/12").route.path, RUN_PATH_PREFIX);
  assert.equal(lookupRoute("HEAD", "/run/acme/web/12").route.path, RUN_PATH_PREFIX);
  assert.deepEqual(lookupRoute("POST", "/run/acme/web/12"), { allow: ["GET", "HEAD"] });
  assert.equal(lookupRoute("GET", "/runs").route.page, "runs");
  assert.equal(lookupRoute("GET", "/runs/sandboxes").route.page, "sandboxes");
  assert.equal(lookupRoute("GET", "/runx/acme/web/1"), null);
  assert.equal(lookupRoute("GET", "/runs/acme/web/1"), null, "a prefix of a page's path is no short link");
});

test("GET /run/<repository>/<number>: a 303 to the newest run's page, for every role that may read runs, and HEAD the same", async () => {
  const fleet = fleetOf({ runs: [rec("gh-older", "acme/web#12", 9_000), rec("gh-newest", "acme/web#12", 1_000)] });
  const c = await runConsole(fleet);
  for (const cookie of [c.op, c.viewer, c.agent]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await c.send({ method, path: "/run/acme/web/12", headers: { cookie, ...HTML } });
      assert.equal(res.status, 303, `${method} ${cookie.slice(0, 16)}`);
      assert.equal(res.headers.location, "/run?id=gh-newest");
      assert.equal(res.headers["cache-control"], "no-store", "the newest run moves, so no browser keeps the answer");
      assert.equal(res.text, "");
    }
  }
  // Case and zeros as the forges read them; a merge request's `!`, as typed or escaped.
  assert.equal((await c.send({ path: "/run/ACME/web/0012", headers: { cookie: c.op } })).headers.location, "/run?id=gh-newest");
  const gl = await runConsole(fleetOf({ runs: [rec("gl-7", "group/sub/p!7", 100, { kind: "gitlab" })] }));
  for (const path of ["/run/group/sub/p/!7", "/run/group/sub/p/%217"]) assert.equal((await gl.send({ path, headers: { cookie: gl.op } })).headers.location, "/run?id=gl-7", path);
  // A run id with characters a query encodes travels encoded.
  const cron = await runConsole(fleetOf({ queue: queueOf([["github", "acme/web#12", "gh:a.b_c-1"]]) }));
  assert.equal((await cron.send({ path: "/run/acme/web/12", headers: { cookie: cron.op } })).headers.location, "/run?id=gh%3Aa.b_c-1");
  // Runs on two forges: the runs search for the target, never a guess.
  const two = await runConsole(fleetOf({ runs: [rec("gh-1", "acme/web#12", 100), rec("fj-1", "acme/web#12", 50, { kind: "forgejo" })] }));
  assert.equal((await two.send({ path: "/run/acme/web/12", headers: { cookie: two.op } })).headers.location, "/runs?q=acme%2Fweb%2312");
});

test("GET /run/<repository>/<number> with no run: the run page's not-found card, 404, or 503 when a place could not be read; JSON for a script", async () => {
  const c = await runConsole(fleetOf());
  const page = await c.send({ path: "/run/acme/web/12", headers: { cookie: c.viewer, ...HTML } });
  assert.equal(page.status, 404);
  assert.ok(page.text.includes(RUN_PATH_SENTENCES.absent.heading) && page.text.includes('name="q" value="acme/web#12"'));
  assert.ok(page.text.includes('class="pillnav"'), "the navigation stays");
  const json = await c.send({ path: "/run/acme/web/12", headers: { cookie: c.viewer } });
  assert.equal(json.status, 404);
  assert.deepEqual(json.json(), { error: RUN_PATH_SENTENCES.absent.sentence });
  const untold = await runConsole(fleetOf({ queue: { unreachable: true } }));
  const p503 = await untold.send({ path: "/run/acme/web/12", headers: { cookie: untold.op, ...HTML } });
  assert.equal(p503.status, 503);
  assert.ok(p503.text.includes(RUN_PATH_SENTENCES.untold.heading));
  assert.deepEqual((await untold.send({ path: "/run/acme/web/12", headers: { cookie: untold.op } })).json(), { error: RUN_PATH_SENTENCES.untold.sentence });
  // A console with no fleet reader cannot tell either.
  const none = await runConsole(null);
  assert.equal((await none.send({ path: "/run/acme/web/12", headers: { cookie: none.op } })).status, 503);
});

test("GET /run/... that is not a short link, or carries a query: the run page's 400, naming the shape and never the value", async () => {
  const fleet = fleetOf({ runs: [rec("gh-1", "acme/web#12", 100)] });
  const c = await runConsole(fleet);
  for (const [path, refusal] of [["/run/", RUN_PATH_REFUSAL], ["/run/acme/12", RUN_PATH_REFUSAL], ["/run/acme/web/x%3Cscript%3E", RUN_PATH_REFUSAL], ["/run/acme/web/12?id=gh-1", RUN_PATH_QUERY_REFUSAL]]) {
    const json = await c.send({ path, headers: { cookie: c.op } });
    assert.equal(json.status, 400, path);
    assert.deepEqual(json.json(), { error: refusal }, path);
    const page = await c.send({ path, headers: { cookie: c.op, ...HTML } });
    assert.equal(page.status, 400, path);
    assert.ok(page.text.includes("Address not understood") && page.text.includes(">Go to Runs</a>"), `${path}: the run page's 400, Runs the way back`);
    assert.ok(!page.text.includes("x%3Cscript") && !page.text.includes("x<script") && !page.text.includes("x&lt;script") && !page.text.includes("gh-1"), `${path}: no value of the path on the page`);
  }
  // An empty query is no query.
  assert.equal((await c.send({ path: "/run/acme/web/12?", headers: { cookie: c.op } })).status, 303);
  // The history was not read for a refused link.
  const before = fleet.calls.runsPage.length;
  await c.send({ path: "/run/acme/12", headers: { cookie: c.op } });
  assert.equal(fleet.calls.runsPage.length, before);
  // A write method is 405, as for every GET route.
  assert.equal((await c.send({ method: "DELETE", path: "/run/acme/web/12", headers: { cookie: c.op } })).status, 405);
});

test("signed out, a short link goes to sign-in and comes back to itself; the run page's ?id= is unchanged", async () => {
  const c = await runConsole(fleetOf({ runs: [rec("gh-1", "acme/web#12", 100)] }));
  const res = await c.send({ path: "/run/acme/web/12", headers: HTML });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/login?${new URLSearchParams({ next: "/run/acme/web/12" })}`);
  assert.equal(returnPathOf("/run/acme/web/12"), "/run/acme/web/12");
  assert.equal(returnPathOf("/run/group/p/!7"), "/run/group/p/!7");
  assert.equal(returnPathOf("/run/My%20Project/repo/9"), "/run/My%20Project/repo/9");
  for (const bad of ["/run/acme/web/12?x=1", "/run/acme/12", "/run/", "//run/acme/web/12", "/run/acme/web/12#x", "/run/acme/web/\\12", "/runs/acme/web/12"]) assert.equal(returnPathOf(bad), null, bad);
  assert.equal(returnPathOf("/run?id=gh-1"), "/run?id=gh-1");
  assert.equal(returnPathOf("/run"), null, "the run page still needs its id");
});

// ---- the run page -------------------------------------------------------------------------------------------------------

test("the run page's goldens: the short link beside the id for a forge run, a running job's too; none for a scheduled run or a newer release's record", () => {
  const golden = (key) => readFileSync(new URL(`./fixtures/console/${key}.html`, import.meta.url), "utf8");
  const head = (doc) => /<div class="titlebar__lead">([\s\S]*?)<div class="titlebar__sub">/.exec(doc)?.[1] ?? "";
  assert.equal(head(golden("run.operator")), '<a class="back" href="/runs"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-chev-l"></use></svg>Runs</a><div class="titlebar__head"><h1>gh-2f6a</h1><a class="run-path" href="/run/acme/api/131" title="Opens the newest run on acme/api#131">/run/acme/api/131</a></div>');
  assert.ok(head(golden("run.viewer")).includes('href="/run/acme/api/131"'), "a viewer's too");
  assert.ok(head(golden("panels/run-live-armed.operator")).includes('<a class="run-path" href="/run/acme/billing/259"'), "a running job's, from its live facts");
  assert.ok(head(golden("panels/run-loaded-left-out-overlay.operator")).includes('href="/run/acme/billing-ui/!403"'), "a merge request's");
  for (const key of ["panels/run-long-cron.operator", "panels/run-newer-record.operator"]) {
    const doc = golden(key);
    assert.ok(!doc.includes("run-path") && !doc.includes("titlebar__head"), `${key}: no short link, and the title bar as before`);
  }
});
