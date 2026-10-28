import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { after, test } from "node:test";
import { CHAT_REFUSALS } from "@edgehero/pi-dispatch/chat-mode";
import { makeConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { makeConsoleClient, parseConsoleAddress } from "@edgehero/pi-dispatch/console-client";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { makeLiveHub, stateOf } from "../src/console/live.mjs";
import * as realPages from "../src/console/pages.mjs";
import { parkedQuestions, runChat, runInbox } from "../src/console/panels.mjs";
import { PARKED_ANSWERING } from "../src/console/panels/parked.mjs";
import { createConsoleServer } from "../src/console/server.mjs";
import * as sessionsModule from "../src/console/sessions.mjs";
import * as RM from "../src/read-model.mjs";

// The terminal chat's console side (issue #647): the run page's Chat panel for each role and mode, and an end to end
// with the REAL console server in process (real session store, cookies, confirm tickets, audit log, live hub and pages)
// driven the way `pi-dispatch chat` drives it: a token sign-in for the cookie, `/api/run`, the JSON transcript stream with
// a Last-Event-ID resume, and a steer through the preview and confirm pipeline, all WITHOUT Sec-Fetch-Site and with
// `Origin: http://<Host>`, the non-browser client path through guards.mjs. The steer's planner and enqueue are fakes
// (the Valkey path is console-actions.test.mjs's); every clock is injected.

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const ESC = String.fromCharCode(27);

// ---- the Chat panel ----------------------------------------------------------------------------------------------------

const RECORD = { jobId: "gh-1", kind: "github", target: "acme/web#12", triggerType: "issues", outcome: "completed", reason: "done", session: { resumed: false, reason: "fresh" }, startedAt: iso(T0 - 600_000), endedAt: iso(T0 - 300_000) };
const OPEN_BOX = { found: true, steer: true, state: "active", open: true, entries: [], closed: false };

function view(role, data, { readOnly = false, id = "gh-1" } = {}) {
  return { page: "run", role, readOnly, query: { id }, env: {}, now: T0, data: { now: T0, ...data } };
}
const chat = (state, mode, extra = {}) => ({ found: true, jobState: null, activeJobId: null, newer: { known: true, jobId: null }, state, mode, says: null, ...extra });
const count = (text, re) => (String(text).match(re) ?? []).length;

test("Chat panel: nothing without a job-state reader, a warning when the queue is unreadable, a refusal's sentence for both roles", () => {
  assert.equal(String(runChat(view("operator", {}))), "", "an older fleet reader's page reads as it did");
  assert.match(String(runChat(view("viewer", { chat: { unreachable: true } }))), /queue could not be read/);
  for (const [state, says] of [["queued", CHAT_REFUSALS.queued], ["answered", CHAT_REFUSALS.answered], ["unknown", CHAT_REFUSALS.unknown]]) {
    for (const role of ["operator", "viewer"]) {
      // Issue #710: with no record, a queued or unknown job is the outcome banner's to say, so the panel draws nothing.
      if (state === "unknown") assert.match(String(runChat(view(role, { chat: chat(state, null, { says }) }))), /chat state is unknown while its record could not be read/);
      else if (state !== "answered") assert.ok(String(runChat(view(role, { chat: chat(state, null, { says }) }))).includes(role === "viewer" ? "Chat is for operators" : says.replace(/'/g, "&#39;")), `${state} ${role}: its no-chat state is named`);
      const out = String(runChat(view(role, { chat: chat(state, null, { says }), run: { record: RECORD } })));
      assert.match(out, /<h2>Chat<\/h2>/);
      assert.ok(out.includes(role === "viewer" ? "Chat is for operators" : says.replace(/'/g, "&#39;")), `${state} ${role}: the sentence`);
      assert.ok(!out.includes("data-action") && !out.includes("pi-dispatch chat"), `${state} ${role}: no form, no command`);
    }
  }
});

test("Chat panel, live: the steer and follow-up forms MOVE here from the Inbox panel (never on the page twice), the transcript is linked, the terminal command shown", () => {
  const data = { chat: chat("active", "live", { activeJobId: "gh-1" }), inbox: OPEN_BOX, transcript: { exists: true } };
  const op = String(runChat(view("operator", data)));
  assert.match(op, /This run is running\./);
  assert.match(op, /<a href="#transcript">below<\/a>/);
  assert.equal(count(op, /data-action="steer"/g), 2, "a steer form and a follow-up form");
  assert.match(op, /name="mode" value="followUp"/);
  assert.doesNotMatch(op, /data-copy/, "terminal copy command is its own p-terminal panel");
  const inbox = String(runInbox(view("operator", data)));
  assert.match(inbox, /<h2>Inbox<\/h2>/, "the inbox still lists");
  assert.equal(count(inbox, /data-action="steer"/g), 0, "and draws no message form while the Chat panel does");
  // Without the chat facts (an older reader), the Inbox panel keeps its forms: the page never loses the action.
  assert.equal(count(runInbox(view("operator", { inbox: OPEN_BOX })), /data-action="steer"/g), 2);
  // A run that goes on as its recovery: the panel names that job; the forms still post this page's id (the planner sends
  // through the active job, as the Inbox panel's always have).
  const cont = String(runChat(view("operator", { ...data, chat: chat("active", "live", { activeJobId: "gh-1.r1" }), inbox: { ...OPEN_BOX, state: "failed", continuesAs: "gh-1.r1" } })));
  assert.match(cont, /goes on as <a class="mono" href="\/run\?id=gh-1.r1">gh-1.r1<\/a>/);
  assert.match(cont, /name="jobId" value="gh-1"/);
  // Not steer-armed, or not open now: no form, a sentence; a viewer and a read-only console: no form at all.
  assert.match(String(runChat(view("operator", { ...data, inbox: { found: true, steer: false } }))), /not steer-armed/);
  assert.match(String(runChat(view("operator", { ...data, inbox: { ...OPEN_BOX, open: false } }))), /takes no message right now/);
  const ro = String(runChat(view("operator", data, { readOnly: true })));
  assert.ok(!ro.includes("data-action") && ro.includes("read-only"));
  assert.equal(count(runInbox(view("operator", data, { readOnly: true })), /data-action="steer"/g), 0);
  const viewer = String(runChat(view("viewer", data)));
  assert.match(viewer, /This run is running\./);
  assert.match(viewer, /a viewer sees the run's status only/);
  assert.ok(!viewer.includes("data-action") && !viewer.includes("pi-dispatch chat") && !viewer.includes("#transcript"), "status only");
});

test("Chat panel, reply: the answer form the Parked page draws too (one action, the same fields) for an operator, status only for a viewer", () => {
  const record = { ...RECORD, reason: "awaiting-input" };
  const data = { chat: chat("parked", "reply"), run: { record } };
  const op = String(runChat(view("operator", data)));
  assert.match(op, /asks<\/b>/);
  assert.match(op, /href="https:\/\/github.com\/acme\/web\/issues\/12"/);
  const form = /<form class="act qform" data-action="parked-answer"[\s\S]*?<\/form>/.exec(op)?.[0];
  assert.ok(form, "the answer form");
  const parkedPage = String(parkedQuestions({ role: "operator", readOnly: false, env: {}, now: T0, data: { snapshot: { parked: [{ target: "acme/web#12", kind: "github", jobId: "gh-1", parkedAt: T0, ageMs: 0, chainCount: 1, pendingScan: { jobId: null } }] }, parkedChecks: { "gh-1": { ok: true } } } }));
  const parkedForm = /<form class="act qform" data-action="parked-answer"[\s\S]*?<\/form>/.exec(parkedPage)?.[0];
  assert.ok(parkedForm, "the Parked page's answer form");
  // Issue #737: the Parked page draws the kit's answer form, the run page its own until it converts; both post the one
  // action with the same named fields, so the script and the planner read either alike.
  const named = (f) => [...f.matchAll(/<(input|textarea)\b[^>]*\sname="([^"]+)"[^>]*>/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(named(parkedForm), named(form));
  assert.deepEqual(named(form), ["input jobId", "textarea text"]);
  for (const f of [form, parkedForm]) assert.ok(f.includes('name="jobId" value="gh-1"') && /maxlength="8192"/.test(f) && /\srequired/.test(f), f);
  assert.match(op, /name="jobId" value="gh-1"/);
  const viewer = String(runChat(view("viewer", data)));
  assert.ok(!viewer.includes("data-action") && !viewer.includes("<textarea"));
  assert.ok(!String(runChat(view("operator", data, { readOnly: true }))).includes("data-action"));
});

test("Chat panel, live: an inbox that could not be read says so, never \"not steer-armed\" (review L12)", () => {
  const data = { chat: chat("active", "live", { activeJobId: "gh-1" }), transcript: { exists: true } };
  for (const inbox of [{ unreachable: true }, null, { invalid: true }]) {
    const out = String(runChat(view("operator", { ...data, inbox })));
    assert.match(out, /inbox could not be read/, JSON.stringify(inbox));
    assert.ok(!out.includes("not steer-armed"), `${JSON.stringify(inbox)}: no guess`);
    assert.ok(!out.includes("data-action"), "no form on an unread inbox");
  }
});

test("Chat panel, reply: the planner's refusal replaces the form (a pull request's park, no reply route, expired data); an unread check says so (review L15)", () => {
  const record = { ...RECORD, reason: "awaiting-input" };
  const refusal = "gh-1 parked on a pull request, whose reply must carry the trigger phrase (the receiver's rule: its key needs the head branch); answer on the forge";
  const op = String(runChat(view("operator", { chat: chat("parked", "reply"), run: { record }, chatAnswer: { refusal } })));
  assert.ok(op.includes(refusal.replace(/'/g, "&#39;")), "the planner's own sentence");
  assert.ok(!op.includes("data-action") && !op.includes("pi-dispatch chat"), "no form and no command the server would refuse");
  const ok = String(runChat(view("operator", { chat: chat("parked", "reply"), run: { record }, chatAnswer: { ok: true } })));
  assert.match(ok, /data-action="parked-answer"/);
  const unread = String(runChat(view("operator", { chat: chat("parked", "reply"), run: { record }, chatAnswer: { unreachable: true } })));
  assert.match(unread, /could not be read; the preview checks again/);
  assert.match(unread, /data-action="parked-answer"/, "fail open, said: the planner checks again before anything is queued");
});

test("Chat panel and /parked: a park whose answer is queued or running is being answered, with no reply form (review L6)", () => {
  const record = { ...RECORD, reason: "awaiting-input" };
  const op = String(runChat(view("operator", { chat: chat("answered", null, { says: CHAT_REFUSALS.answering, answeringJobId: "gh-77" }), run: { record } })));
  assert.match(op, /This run is being answered\./);
  assert.ok(op.includes(CHAT_REFUSALS.answering.replace(/'/g, "&#39;")));
  assert.match(op, /href="\/run\?id=gh-77"/);
  assert.ok(!op.includes("data-action"));
  const queued = String(runChat(view("operator", { chat: chat("queued", null, { says: CHAT_REFUSALS.recoveryQueued, queuedJobId: "gh-1.r1" }) })));
  assert.match(queued, /queued recovery job is <a class="mono" href="\/run\?id=gh-1.r1">/);
  const rows = [
    { target: "acme/web#12", kind: "github", jobId: "gh-1", parkedAt: T0, ageMs: 0, chainCount: 1, answering: "gh-77", pendingScan: { jobId: "gh-77" } },
    { target: "acme/web#13", kind: "github", jobId: "gh-2", parkedAt: T0, ageMs: 0, chainCount: 1, answering: false, pendingScan: { jobId: null } },
    { target: "acme/web#14", kind: "github", jobId: "gh-3", parkedAt: T0, ageMs: 0, chainCount: 1, answering: null, pendingScan: { unknown: true, tooMany: false } },
    { target: "acme/web#15", kind: "github", jobId: "gh-4", parkedAt: T0, ageMs: 0, chainCount: 1, answering: null, pendingScan: { unknown: true, tooMany: true } },
  ];
  const page = String(parkedQuestions({ role: "operator", readOnly: false, env: {}, now: T0, data: { snapshot: { parked: rows }, parkedChecks: Object.fromEntries(rows.map((r) => [r.jobId, { ok: true }])) } }));
  assert.ok(page.includes(`${PARKED_ANSWERING} <a class="link code" href="/run?id=gh-77">gh-77</a>.`), page);
  assert.ok(page.includes(CHAT_REFUSALS.parkedUnknown.replace(/'/g, "&#39;")), "a scan that could not read the queue whole");
  assert.equal(page.split(CHAT_REFUSALS.parkedTooMany).length - 1, 1, "the honest sentence, on the one card it is true of");
  // Review round 2: a scan that could not tell draws no form, as the Chat panel draws none (the shared verdict).
  assert.equal(count(page, /data-action="parked-answer"/g), 1, "a form for the waiting park alone");
  assert.ok(page.includes('name="jobId" value="gh-2"'), "the waiting park's");
  for (const id of ["gh-1", "gh-3", "gh-4"]) assert.ok(!page.includes(`name="jobId" value="${id}"`), `none for ${id}`);
});

test("Chat panel, fork: the exact pi-dispatch chat command, or why the record names no session the fork can find", () => {
  const op = String(runChat(view("operator", { chat: chat("finished", "fork"), run: { record: RECORD } })));
  assert.match(op, /<div class="cmd"><code><span>pi-dispatch<\/span> <span>chat<\/span> <span>gh-1<\/span><\/code>/);
  assert.match(op, /PI_SESSIONS_DIR/);
  assert.match(op, /not redacted/);
  const pr = String(runChat(view("operator", { chat: chat("finished", "fork"), run: { record: { ...RECORD, triggerType: "pull_request" } } })));
  assert.match(pr, /cannot be found from its record/);
  assert.ok(!pr.includes("pi-dispatch chat"), "no command that would refuse");
  const mr = String(runChat(view("operator", { chat: chat("finished", "fork"), run: { record: { ...RECORD, kind: "gitlab", target: "g/p!3" } } })));
  assert.match(mr, /cannot be found from its record/);
  const none = String(runChat(view("operator", { chat: chat("finished", "fork"), run: { record: { ...RECORD, session: undefined } } })));
  assert.match(none, /keeps no session/);
  const viewer = String(runChat(view("viewer", { chat: chat("finished", "fork"), run: { record: RECORD } })));
  assert.ok(!viewer.includes("pi-dispatch chat"));
  // An id outside the run-id charset could not be typed back as one argument: status only, whatever the role.
  const odd = String(runChat(view("operator", { chat: chat("finished", "fork"), run: { record: RECORD } }, { id: "gh 1;rm" })));
  assert.ok(!odd.includes("pi-dispatch chat") && !odd.includes("rm"));
  for (const text of [op, pr, mr, none]) assert.doesNotMatch(text, /[\u2013\u2014]/);
});

// ---- end to end --------------------------------------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;
const STEER_TEXT = "check the migrations first, chat-canary-41b7";

function fakeTimers() {
  return { setInterval: () => ({}), clearInterval: () => {} };
}

/** A fleet reader with one running, steer-armed job (`gh-live`) and its transcript as an in-memory stream. */
function liveFleet() {
  const entries = [];
  let n = 0;
  const add = (fields) => {
    const id = `${T0 + (n += 1)}-0`;
    entries.push({ id, kind: "assistant", ts: T0, text: null, tool: null, error: false, truncated: false, outcome: null, ...fields });
    return id;
  };
  const since = async (jobId, after, { count = 200 } = {}) => {
    const rows = jobId === "gh-live" ? entries : [];
    const page = rows.filter((r) => after === null || RM.compareTranscriptIds(r.id, after) > 0).slice(0, count);
    const next = page.length > 0 ? page.at(-1).id : after;
    const last = rows.at(-1) ?? null;
    const ended = last !== null && last.kind === "end" && next !== null && RM.compareTranscriptIds(next, last.id) >= 0;
    return { entries: page, next, ended, outcome: ended ? last.outcome : null };
  };
  return {
    add,
    snapshot: async () => ({ queue: { counts: { active: 1 } }, active: [{ jobId: "gh-live", queue: "pi-jobs", startedAt: T0, host: "mini1" }] }),
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    runById: async () => ({ missing: true }),
    jobStatus: async (id) => (id === "gh-live" ? { found: true, state: "active", continuesAs: null } : { found: false, state: null, continuesAs: null }),
    transcriptSince: since,
    transcriptMeta: async (id) => (id === "gh-live" && entries.length > 0 ? { exists: true, ended: false, outcome: null, length: entries.length } : { exists: false, ended: false, outcome: null, length: 0 }),
    inbox: async (id) => (id === "gh-live" ? OPEN_BOX : { found: false }),
    progressOfRun: async () => ({ progress: { absent: true }, continues: false, continuesAs: null }),
  };
}

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
});

async function chatConsole() {
  let t = T0;
  const now = () => t;
  const fleet = liveFleet();
  const logsDir = tempDir("console-chat-");
  const realAudit = makeConsoleAudit({ logsDir, now });
  const rows = [];
  const audit = { append: (row) => (rows.push(realAudit.append(row)), rows.at(-1)) };
  const file = {
    version: 1,
    generation: 0,
    tokens: [
      { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
      { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
    ],
  };
  const readTokens = () => ({ file });
  const sessions = sessionsModule.makeSessionStore({ now });
  const pageDeps = { fleet, insights: async () => null, audit: async () => ({ rows: [], next: null }), subscriptions: async () => [], env: {}, now };
  const hub = makeLiveHub({
    loadPageData: (p, q) => realPages.loadPageData(p, q, pageDeps),
    pagePanels: realPages.pagePanels,
    queryKeyOf: realPages.pageQueryString,
    peekSession: (id, f) => sessions.peek(id, f),
    // Wired as cli.mjs wires it: the reason a stream ends is the store's pure verdict.
    endedReason: (id, f) => sessions.verdict(id, f).ended ?? null,
    readTokens,
    transcriptSince: (jobId, a, opts) => fleet.transcriptSince(jobId, a, opts),
    now,
    timers: fakeTimers(),
  });
  // The steer's planner and enqueue, faked at the read model's seam: what they were asked is recorded, never logged.
  const planned = [];
  const pushed = [];
  const rm = {
    ...RM,
    planSteer: async (args) => {
      planned.push(args);
      const text = args.text;
      return { plan: { kind: "steer", jobId: args.jobId, queue: "pi-jobs", runId: args.jobId, id: "c".repeat(32), mode: args.mode, source: args.source, by: args.by, text, bytes: Buffer.byteLength(text), digest: sha256(text) } };
    },
    enqueueSteer: async (plan) => {
      pushed.push(plan);
      return { ok: true, jobId: plan.jobId, id: plan.id, mode: plan.mode, state: "queued" };
    },
  };
  const logs = [];
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly: false, maxMs: 12 * 3600_000 },
    now,
    audit,
    sessions,
    cookies: sessionsModule,
    tickets: makeConfirmTickets({ now }),
    log: (line) => logs.push(line),
    readTokens,
    findToken: (f, presented) => f.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: () => ({ ok: true }),
    actionDeps: { rm, paths: { valkeyUrl: "redis://127.0.0.1:1/0" }, env: {}, fleet, host: "console-test" },
    pageDeps,
    hub,
    stateOf,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  // The terminal client's headers: Host and Origin as the guards expect, a JSON body, and NEVER Sec-Fetch-Site.
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
  const post = (path, obj, cookie, extra = {}) => send({ method: "POST", path, headers: { origin: `http://${host}`, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(obj) });
  function stream(cookie, path, headers = {}) {
    return new Promise((resolve, reject) => {
      const s = { text: "", status: null, waiters: [] };
      const req = request({ host: "127.0.0.1", port, path, headers: { host, cookie, ...headers }, setHost: false }, (res) => {
        s.status = res.statusCode;
        s.done = new Promise((done) => {
          res.on("end", done);
          res.on("close", done);
        });
        res.on("data", (c) => {
          s.text += c;
          for (const w of [...s.waiters]) if (w.re.test(s.text)) (s.waiters.splice(s.waiters.indexOf(w), 1), w.resolve());
        });
        resolve(s);
      });
      s.waitFor = (re) => (re.test(s.text) ? Promise.resolve() : new Promise((r) => s.waiters.push({ re, resolve: r })));
      s.destroy = () => req.destroy();
      req.on("error", (e) => (s.status === null ? reject(e) : null));
      req.end();
    });
  }
  const settle = async (k) => {
    for (let i = 0; i < 200 && hub.size().streams !== k; i += 1) await new Promise((r) => setTimeout(r, 5));
  };
  return { fleet, hub, file, rows, logs, planned, pushed, send, post, stream, settle, host, advance: (ms) => (t += ms) };
}

const entriesIn = (text) => [...text.matchAll(/id: (\S+)\nevent: entry\ndata: (.+)\n\n/g)].map(([, id, data]) => ({ sse: id, ...JSON.parse(data) }));

test("end to end: token sign-in, /api/run, the JSON transcript with a Last-Event-ID resume, and a steer previewed and confirmed with an audit row, as a non-browser client", { timeout: 30_000 }, async () => {
  const c = await chatConsole();
  const ids = [c.fleet.add({ kind: "user", text: "fix the flaky test" }), c.fleet.add({ text: `on it ${ESC}[31mred${ESC}[0m` })];

  // Sign-in: the cookie, with no Sec-Fetch-Site. A foreign Origin is refused, as a browser on another site would be.
  const foreign = await c.post("/login", { token: OP_TOKEN }, null, { origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
  const login = await c.post("/login", { token: OP_TOKEN });
  assert.equal(login.status, 200, login.text);
  assert.deepEqual(login.json(), { ok: true, name: "alice", role: "operator" });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  assert.match(cookie, /^pdc_session=/);

  // The mode.
  const run = await c.send({ path: "/api/run?id=gh-live", headers: { cookie } });
  assert.equal(run.status, 200, run.text);
  const doc = run.json();
  assert.deepEqual([doc.state, doc.mode, doc.activeJobId], ["active", "live", "gh-live"]);
  assert.deepEqual(doc.steer, { armed: true, open: true });
  assert.deepEqual(doc.transcript, { exists: true, ended: false, outcome: null });

  // The JSON transcript, then a reconnect from the last id it saw.
  const s1 = await c.stream(cookie, "/api/transcript?id=gh-live&format=json");
  assert.equal(s1.status, 200);
  await s1.waitFor(new RegExp(`id: ${ids[1]}\\n`));
  const first = entriesIn(s1.text);
  assert.deepEqual(first.map((e) => e.id), ids);
  assert.equal(first[1].text, `on it ${ESC}[31mred${ESC}[0m`, "the text is a JSON string; the terminal scrubs it before it reaches a screen");
  assert.ok(!s1.text.includes(ESC), "and no raw ESC is on the wire");
  s1.destroy();
  await s1.done;
  await c.settle(0);
  const third = c.fleet.add({ text: "tests pass now" });
  const s2 = await c.stream(cookie, "/api/transcript?id=gh-live&format=json", { "last-event-id": first.at(-1).sse });
  await s2.waitFor(new RegExp(`id: ${third}\\n`));
  assert.deepEqual(entriesIn(s2.text).map((e) => e.id), [third], "resumed after the last entry seen, nothing repeated");

  // The steer: preview (summary, no reserve), then confirm with the ticket; one audit row with the digest, never the text.
  const preview = await c.post("/api/act/steer/preview", { jobId: "gh-live", text: STEER_TEXT, mode: "steer" }, cookie);
  assert.equal(preview.status, 200, `${preview.text} (log: ${c.logs.join(" | ")})`);
  const p = preview.json();
  assert.equal(typeof p.ticket, "string");
  assert.ok(p.summary.some((line) => /Send a steer to running job gh-live, as alice/.test(line)), p.summary.join(" | "));
  assert.deepEqual(c.planned.map((a) => [a.jobId, a.mode, a.by, a.source]), [["gh-live", "steer", "alice", "console"]], "the sender is the session's token name, the source the console");
  const confirm = await c.post("/api/act/steer/confirm", { ticket: p.ticket }, cookie);
  assert.equal(confirm.status, 200, confirm.text);
  assert.equal(confirm.json().ok, true);
  assert.equal(c.pushed.length, 1);
  const row = c.rows.find((r) => r.action === "write" && r.kind === "steer");
  assert.ok(row, "an audit row for the write");
  assert.equal(row.outcome, "ok");
  assert.equal(row.actor.name, "alice");
  assert.equal(row.afterDigest, sha256(STEER_TEXT));
  assert.equal(row.target, `gh-live#${"c".repeat(32)}`);
  const everything = JSON.stringify(c.rows) + c.logs.join("\n");
  assert.ok(!everything.includes("chat-canary") && !everything.includes(OP_TOKEN), "no message text and no token in the audit log or the console's log");
  // A replayed ticket is refused: a second confirm cannot send the message twice.
  assert.equal((await c.post("/api/act/steer/confirm", { ticket: p.ticket }, cookie)).status, 409);
  assert.equal(c.pushed.length, 1);
  s2.destroy();
  await s2.done;

  // The viewer variant: the run's status, no transcript, no steer.
  const vlogin = await c.post("/login", { token: VIEW_TOKEN });
  const vcookie = vlogin.headers["set-cookie"][0].split(";")[0];
  const vrun = await c.send({ path: "/api/run?id=gh-live", headers: { cookie: vcookie } });
  assert.equal(vrun.status, 200);
  assert.deepEqual(vrun.json(), (await c.send({ path: "/api/run?id=gh-live", headers: { cookie } })).json(), "the same document for a viewer");
  const vt = await c.stream(vcookie, "/api/transcript?id=gh-live&format=json");
  assert.equal(vt.status, 403);
  await vt.done;
  assert.ok(!vt.text.includes("flaky"));
  assert.equal((await c.post("/api/act/steer/preview", { jobId: "gh-live", text: "x" }, vcookie)).status, 403);
  // The run page draws the Chat panel for both, with the forms for the operator alone.
  const opPage = await c.send({ path: "/run?id=gh-live", headers: { cookie } });
  assert.match(opPage.text, /<section id="p-chat" data-panel><div class="card"><div class="card__head"><h2>Chat<\/h2>/);
  assert.equal(count(opPage.text, /data-action="steer"/g), 2, "one steer form per mode on the whole page");
  const vPage = await c.send({ path: "/run?id=gh-live", headers: { cookie: vcookie } });
  assert.match(vPage.text, /a viewer sees the run's status only/);
  assert.ok(!vPage.text.includes('data-action="steer"'));
});

test("the terminal client on the real console: the console stopping is waited out with the sign-in kept; a session that ended is signed in again (issue #737)", { timeout: 30_000 }, async () => {
  // `pi-dispatch chat`'s own client (worker/src/console-client.mjs) against this console's hub, so the word the hub
  // writes on close and the word the client waits on are the same one, end to end.
  const follow = async (c, onFirstEntry) => {
    const states = [];
    const waits = [];
    // Each wait is refused (false), so the stream detaches at the first one and the test reads what led to it.
    const client = makeConsoleClient({ address: parseConsoleAddress(c.host), token: OP_TOKEN, sleep: async (ms) => (waits.push(ms), false), random: () => 1 });
    let fired = false;
    const end = await client.stream("/api/transcript?id=gh-live&format=json", {
      onState: (st) => states.push(st),
      onEvent: (ev) => {
        if (ev.event !== "entry" || fired) return;
        fired = true;
        void onFirstEntry();
      },
    });
    return { end, states, waits, logins: c.rows.filter((r) => r.action === "login").length };
  };

  const stopping = await chatConsole();
  stopping.fleet.add({ text: "working" });
  const shut = await follow(stopping, () => stopping.hub.close());
  assert.deepEqual(shut.end, { detached: true });
  assert.deepEqual(shut.states.map((st) => Object.keys(st)[0]), ["shutdown", "waiting"], "a dropped connection: said, then backed off");
  assert.equal(shut.logins, 1, "and the sign-in kept, not spent on a re-login");

  const ended = await chatConsole();
  ended.fleet.add({ text: "working" });
  const out = await follow(ended, async () => {
    ended.file.generation = 1;
    await ended.hub.tick();
  });
  assert.deepEqual(out.end, { detached: true });
  assert.deepEqual(out.states, [{ relogin: true }], "an operator ended every session: the client signs in again, it does not wait it out");
});
