// What a REAL console answers and records when Valkey refuses its connections or stops answering at one named command
// (issue #987; VALKEY_TEST_URL, required in CI): a paid start, an agent's write, an answer draft's drop and the previews
// that read Valkey first. The unit tests hand each funnel an error; only here do the console's own clients, bounds and
// wiring decide what the error is, which is where an outage was said as "the preview failed" or as nothing changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect as netConnect, createServer } from "node:net";
import { join } from "node:path";
import { answerConfigDigest, answerRuleConfigDigest, makeAnswerDraftStore } from "@edgehero/pi-dispatch/answerer";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { readConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { hostQueueName, makeQueue } from "@edgehero/pi-dispatch/queue";
import { buildRecord, makeRecordWriter } from "@edgehero/pi-dispatch/run-history";
import { makeSandboxInventory, sandboxInventoryKey, SANDBOX_INVENTORY_HOSTS } from "@edgehero/pi-dispatch/sandbox-inventory";
import { sandboxPrepareQueueName, sandboxPrepareSlotKey } from "@edgehero/pi-dispatch/sandbox-prepare-requests";
import { TOUCH_PENDING } from "@edgehero/pi-dispatch/touch-state";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { VALKEY_UNREACHABLE } from "../src/console/actions.mjs";
import { DRAFT_DROP_UNCONFIRMED } from "../src/answerer-data.mjs";
import { runCli } from "../src/console/cli.mjs";
import { ALLOWANCE_UNREAD } from "../src/read-model.mjs";
import { SANDBOX_REQUEST_UNCONFIRMED } from "../src/sandbox-data.mjs";
import { FIX_STAGE_UNCONFIRMED } from "../src/zero-touch-data.mjs";
import { CANARY_UNCONFIRMED } from "../src/trigger-fire.mjs";
import { answererFixture } from "./helpers/answerer-goldens.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { commandOn } from "./helpers/tripping-proxy.mjs";

const VALKEY = process.env.VALKEY_TEST_URL;
// CI sets this, which turns a missing URL into a failure rather than a quiet skip.
if (!VALKEY && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS) throw new Error("outage-wired.test REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS is set");
const live = { skip: VALKEY ? false : "needs VALKEY_TEST_URL (CI sets it)", timeout: 120_000 };

// Database 6, which no test flushes and other wired files share (sandbox-end-wired's reason). So every key a test here
// reads or asserts on is this file's own and is deleted again: a host name, an hour and run ids no other test has, and
// the queue of that host. The two keys a console writes by serving at all (`CONSOLE_KEYS`) are deleted too, as the other
// wired files delete them: no test reads either.
const databaseUrl = () => {
  const url = new URL(VALKEY);
  url.pathname = "/6";
  return url.href;
};
const CONSOLE_KEYS = ["console:audit", "bull:pi-jobs:*"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clocked = async (promise) => {
  const started = performance.now();
  const res = await promise;
  return { res, ms: performance.now() - started };
};

/**
 * The real Valkey as a console of this file sees it: a pass-through on a port of its own that can REFUSE connections
 * (it stops listening, and listens again) and can stop answering at one named command (`freezeAt`), a `kill -STOP` as
 * that command leaves. What a client wrote before it gave up is passed on at the thaw even when that client has closed
 * its connection by then, as a stopped Valkey still has it in its socket: the worker tests' freezing proxy drops such
 * bytes, and a console's one-shot clients have all closed by the time a test thaws. The port is taken below the range
 * the system hands out by itself, so nothing else is given it while it refuses.
 */
async function valkeyFront(target) {
  const to = new URL(target);
  const open = new Set();
  const held = [];
  const left = [];
  let frozen = false;
  let trip = null;
  const server = createServer((client) => {
    const upstream = netConnect({ host: to.hostname, port: Number(to.port) });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => open.delete(socket));
    }
    client.on("data", (data) => {
      if (trip && trip.pattern.test(data.toString("latin1"))) {
        const { seen } = trip;
        trip = null;
        frozen = true;
        seen();
      }
      if (frozen) held.push([upstream, data]);
      else upstream.write(data);
    });
    upstream.on("data", (data) => (frozen ? held.push([client, data]) : client.write(data)));
    client.on("close", () => (frozen ? left.push(upstream) : upstream.destroy()));
    upstream.on("close", () => client.destroy());
  });
  const listen = (port) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  let port = null;
  for (let attempt = 0; attempt < 20 && port === null; attempt += 1) {
    const candidate = 20_000 + Math.floor(Math.random() * 9_000);
    try {
      await listen(candidate);
      port = candidate;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  assert.ok(port !== null, "a port for the front");
  let listening = true;
  const via = new URL(target);
  via.hostname = "127.0.0.1";
  via.port = String(port);
  const thaw = () => {
    frozen = false;
    trip = null;
    for (const [socket, data] of held.splice(0)) if (!socket.destroyed) socket.write(data);
    for (const upstream of left.splice(0)) upstream.end();
  };
  const refuse = async () => {
    if (!listening) return;
    listening = false;
    for (const socket of open) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return {
    url: via.toString(),
    refuse,
    async accept() {
      if (listening) return;
      // The port is this front's own, but for a moment something else can hold it: tried again rather than failed.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await listen(port);
          break;
        } catch (error) {
          if (error?.code !== "EADDRINUSE" || attempt >= 40) throw error;
          await sleep(50);
        }
      }
      listening = true;
    },
    freeze: () => (frozen = true),
    /** Stops answering the moment a client sends bytes that match, those bytes included; resolves when it has. */
    freezeAt: (pattern) => new Promise((seen) => { trip = { pattern, seen }; }),
    thaw,
    async close() {
      thaw();
      await refuse();
    },
  };
}

function httpTo(port) {
  return (path, { body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const headers = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-length": Buffer.byteLength(data) };
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON: `text` says what it was */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** A repository with one commit and a flow an agent may start (`ai-trigger: allow`, committed), clean. */
function repository(prefix) {
  const folder = realpathSync(tempDir(prefix));
  const git = (...args) => execFileSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(folder, ".pi", "skills", "fix"), { recursive: true });
  writeFileSync(join(folder, ".pi", "skills", "fix", "SKILL.md"), "---\nname: fix\ndescription: test\nai-trigger: allow\n---\nFix the fixture.\n");
  git("add", ".pi");
  git("commit", "-q", "-m", "flow");
  return folder;
}

/**
 * One console of this test's own, served by the real command line over a front of its own before the real Valkey
 * (`valkeyFront`), with an operator and an agent signed in. `fn` gets what it needs to act and to look; everything that holds a
 * socket is opened inside the try, so a failure anywhere leaves none open and the file ends. `files(dir)` writes what the
 * deployment needs and answers extra environment.
 */
async function withConsole(fn, { files = () => ({}) } = {}) {
  let direct = null, front = null, running = null;
  let stop = () => {};
  const cleanup = [];
  const tag = randomBytes(5).toString("hex");
  const host = `ow${tag}`;
  // An hour of this console's own, far from any other test's clock: the hourly allowance's key is named by it.
  const now = Date.UTC(2041 + Math.floor(Math.random() * 30), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27), Math.floor(Math.random() * 24), 20);
  const hourKey = `dispatch-run:${new Date(now).toISOString().slice(0, 13).replace("T", "-")}`;
  try {
    direct = makeRedisClient(databaseUrl(), {});
    front = await valkeyFront(databaseUrl());
    const dir = tempDir("outage-wired-");
    mkdirSync(join(dir, "logs"), { recursive: true });
    const folder = repository("outage-wired-repo-");
    const env = {
      PATH: process.env.PATH, HOME: dir, VALKEY_URL: front.url, PI_LOGS_DIR: join(dir, "logs"), PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_PROJECTS_FILE: join(dir, "projects.json"),
      PI_CONSOLE_LISTEN: "127.0.0.1:0", PI_WORKER_NAME: host, PI_DISPATCH_DEPLOYMENT_FILE: join(dir, "no-pointer.json"), PI_DISPATCH_RUN_ROOTS: folder, PI_DISPATCH_RUN_PER_HOUR: "9",
    };
    writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [] }));
    Object.assign(env, files({ dir, folder, host, env }) ?? {});
    const err = [];
    const io = { env, now: () => now, uid: process.geteuid?.(), err: (line) => err.push(line) };
    const tokenFor = async (name, role) => {
      const printed = [];
      assert.equal(await runCli(["token", "add", "--name", name, "--role", role, "--deployment", dir], { ...io, out: (line) => printed.push(line) }), 0, err.join("\n"));
      const token = printed.join("\n").match(/pdc_[A-Za-z0-9_-]+/)?.[0];
      assert.ok(token, `the ${role} token is printed once`);
      return token;
    };
    const tokens = { operator: await tokenFor("ops", "operator"), agent: await tokenFor("bot", "agent") };
    const until = new Promise((resolve) => (stop = resolve));
    let listening;
    const up = new Promise((resolve) => (listening = resolve));
    running = runCli(["serve", "--deployment", dir], { ...io, out: () => {}, until, onListening: listening });
    const call = httpTo((await up).address().port);
    const signIn = async (token) => {
      const login = await call("/login", { body: { token } });
      assert.equal(login.status, 200, login.text.slice(0, 200));
      return [].concat(login.headers["set-cookie"]).map((c) => c.split(";")[0]).join("; ");
    };
    const cookies = { operator: await signIn(tokens.operator), agent: await signIn(tokens.agent) };
    const queueName = hostQueueName(host);
    cleanup.push(async () => {
      for (const pattern of [`bull:${queueName}:*`, hourKey, `trigger-fire:${queueName}:*`, ...CONSOLE_KEYS]) {
        const keys = await direct.keys(pattern);
        if (keys.length > 0) await direct.del(...keys);
      }
    });
    await fn({
      dir, folder, host, env, err, now, hourKey, queueName, direct, front, cookies, cleanup,
      act: (name, step, body, who = "operator") => call(`/api/act/${name}/${step}`, { cookie: cookies[who], body }),
      /** The audit rows of the console's log, newest last. */
      rows: () => readConsoleAudit({ logsDir: env.PI_LOGS_DIR, limit: 50 }).rows.slice().reverse(),
      /** How many jobs this console's own queue holds, read on a connection the front is not on. */
      async jobs() {
        const queue = makeQueue(parseConnection(databaseUrl(), { failFast: true }), { name: queueName });
        try {
          return Object.values(await queue.getJobCounts()).reduce((n, c) => n + c, 0);
        } finally {
          await queue.close().catch(() => {});
        }
      },
      /** What was held while Valkey did not answer is passed on now, in order, as after a `kill -CONT`, and has been read. */
      async thawed() {
        front.thaw();
        const through = makeRedisClient(front.url, {});
        try { await through.ping(); } finally { through.disconnect(); }
        await sleep(300);
      },
    });
    assert.deepEqual(err.filter((line) => /unexpected failure|TypeError/.test(line)), []);
  } finally {
    front?.thaw();
    await front?.accept().catch(() => {});
    stop();
    await running?.catch(() => {});
    if (direct) {
      for (const clean of cleanup.reverse()) await Promise.resolve().then(clean).catch(() => {});
      direct.disconnect();
    }
    await front?.close().catch(() => {});
  }
}

/** The bar of a refusal that is Valkey's: its title and Try again. */
const valkeyBar = (html) => html.includes("The deployment&#39;s Valkey could not be reached") && /data-again[^>]*>\s*Try again/.test(html);
// BullMQ's add as it leaves: an EVAL of its add script, whose text fills the first chunks (the job's own arguments come
// in a later one), so the stop is at the script's first bytes and the whole command is held.
const THE_ADD = /\r\n\$4\r\neval\r\n\$\d+\r\n--\[\[\s+Adds a (?:\w+ )?job/i;

test("a started run on a real console: Valkey refusing the connection at the confirm is said at once with nothing counted, and an add that is not answered says the start of the hour was used", live, async () => {
  await withConsole(async (c) => {
    const input = { folder: c.folder, flow: "fix", task: "run the fixture" };
    // Valkey refuses the connection between the preview and the confirm.
    const first = await c.act("run-enqueue", "preview", input);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    await c.front.refuse();
    const refused = await clocked(c.act("run-enqueue", "confirm", { ticket: first.json.ticket }));
    assert.equal(refused.res.status, 503, refused.res.text.slice(0, 300));
    assert.equal(refused.res.json.error, VALKEY_UNREACHABLE);
    assert.ok(valkeyBar(refused.res.json.html), refused.res.json.html);
    // The hour's count waited out its client's whole command bound here, 5 seconds, before it said so.
    assert.ok(refused.ms < 1500, `${Math.round(refused.ms)} ms`);
    // The preview says it of the allowance it could not read, in Fire now's sentence, and writes no audit row.
    const rowsBefore = c.rows().length;
    const unread = await clocked(c.act("run-enqueue", "preview", input));
    assert.equal(unread.res.status, 503, unread.res.text.slice(0, 300));
    assert.equal(unread.res.json.error, ALLOWANCE_UNREAD);
    assert.ok(valkeyBar(unread.res.json.html), unread.res.json.html);
    assert.ok(unread.ms < 1500, `${Math.round(unread.ms)} ms`);
    assert.equal(c.rows().length, rowsBefore);
    await c.front.accept();
    assert.equal(await c.direct.get(c.hourKey), null, "no start was counted against the hour");
    assert.equal(await c.jobs(), 0, "and no run was queued");
    assert.deepEqual(c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]), [["run-enqueue", "ok", null], ["run-enqueue", "failed", "Valkey could not be reached"]]);

    // Valkey stops answering at the add: the start was counted before it, and the sentence says so.
    const second = await c.act("run-enqueue", "preview", input);
    assert.equal(second.status, 200, second.text.slice(0, 300));
    const frozen = c.front.freezeAt(THE_ADD);
    const lost = await clocked(c.act("run-enqueue", "confirm", { ticket: second.json.ticket }));
    assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the add");
    const counted = "the run may or may not have been queued and one start of this hour was used: the queue did not confirm it. Preview it again first: the preview says when one is already queued or running";
    assert.equal(lost.res.status, 409, lost.res.text.slice(0, 300));
    assert.equal(lost.res.json.error, counted);
    assert.ok(lost.res.json.html.includes("The change did not finish"), lost.res.json.html);
    assert.ok(lost.ms > 4000 && lost.ms < 9000, `the queue's own bound decided (${Math.round(lost.ms)} ms)`);
    assert.deepEqual(c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]), [["run-enqueue", "ok", null], ["run-enqueue", "failed", counted]]);
    assert.equal(await c.direct.get(c.hourKey), "1", "one start of the hour was counted");
    assert.equal(await c.jobs(), 0, "nothing reached Valkey while it did not answer");
    await c.thawed();
    assert.equal(await c.jobs(), 1, "the add landed when Valkey woke, as the sentence said it might");
    assert.equal(await c.direct.get(c.hourKey), "1");
  });
});

test("an agent session's write on a real console is answered and recorded by one closed word: action-unconfirmed for an add that was not answered, action-refused for one refused before it was sent or with Valkey out of reach", live, async () => {
  await withConsole(async (c) => {
    const input = { folder: c.folder, flow: "fix", task: "run the fixture" };
    const preview = async () => {
      const p = await c.act("run-enqueue", "preview", input, "agent");
      assert.equal(p.status, 200, p.text.slice(0, 300));
      return p.json.ticket;
    };
    const lastTwo = () => c.rows().slice(-2).map((r) => [r.actor?.role, r.kind, r.outcome, r.reason ?? null]);
    // What an agent is told is the action, where it stopped and one word for how: never the funnel's sentence, which
    // names a folder, a job or what was counted.
    const told = (how) => `run-enqueue confirm refused (${how}); an operator can inspect the deployment and preview it for the detailed diagnosis`;
    const recorded = (word) => [["agent", "run-enqueue", "ok", null], ["agent", "run-enqueue", "failed", word]];

    // Refused before anything was sent: the folder has an uncommitted file by the confirm.
    let ticket = await preview();
    writeFileSync(join(c.folder, "stray"), "x\n");
    const refused = await c.act("run-enqueue", "confirm", { ticket }, "agent");
    rmSync(join(c.folder, "stray"));
    assert.deepEqual([refused.status, refused.json.error], [409, told("changed")]);
    assert.deepEqual(lastTwo(), recorded("action-refused"));
    assert.equal(await c.direct.get(c.hourKey), null, "a refusal before the count uses no start");

    // Valkey out of reach by the confirm: the console's agent rows say it as a refusal too (the tools' word for it,
    // action-unavailable, is not one a console session gets), and the answer names Valkey as where it stopped.
    ticket = await preview();
    await c.front.refuse();
    const down = await clocked(c.act("run-enqueue", "confirm", { ticket }, "agent"));
    await c.front.accept();
    assert.deepEqual([down.res.status, down.res.json.error], [503, told("valkey")]);
    assert.ok(valkeyBar(down.res.json.html), down.res.json.html);
    assert.ok(down.ms < 1500, `${Math.round(down.ms)} ms`);
    assert.deepEqual(lastTwo(), recorded("action-refused"));
    assert.equal(await c.direct.get(c.hourKey), null);

    // The add was sent and not answered: the one word that says it may have been made, in the row and, as the bar's
    // state, in the answer. The sentence a person gets (the run may be queued, a start of the hour was used) is not said.
    ticket = await preview();
    const frozen = c.front.freezeAt(THE_ADD);
    const lost = await c.act("run-enqueue", "confirm", { ticket }, "agent");
    assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the add");
    assert.deepEqual([lost.status, lost.json.error], [409, told("partial")]);
    assert.ok(lost.json.html.includes("The change did not finish") && !/nothing was changed/i.test(lost.json.html), lost.json.html);
    assert.deepEqual(lastTwo(), recorded("action-unconfirmed"));
    for (const answer of [refused, down.res, lost]) assert.doesNotMatch(answer.text, /may or may not|start of this hour|outage-wired-repo/);
    assert.equal(await c.direct.get(c.hourKey), "1", "its start was counted all the same");
    await c.thawed();
    assert.equal(await c.jobs(), 1, "and its run was queued when Valkey woke");
  });
});

test("the previews that read Valkey first say Valkey could not be reached on a real console, with Try again and no audit row, on a port that refuses and on a Valkey that stops answering", live, async () => {
  await withConsole(async (c) => {
    const previews = [
      ["zero-touch-group", { runId: `gh-${c.host}` }],
      ["zero-touch-undo", { fixId: "f".repeat(32) }],
      ["answer-draft-drop", { runId: `gh-${c.host}`, draftRunId: `gh-${c.host}-draft`, digest: "b".repeat(64) }],
      ["sandbox-end", { host: c.host, id: `sb-${c.host}`, nonce: "1".repeat(32), containerId: "2".repeat(64) }],
    ];
    // All at once, as a person with four tabs: each has its own client and its own bound.
    const all = async (label) => {
      const rows = c.rows().length;
      const answers = await clocked(Promise.all(previews.map(([name, body]) => c.act(name, "preview", body))));
      for (const [i, res] of answers.res.entries()) {
        const what = `${previews[i][0]}, ${label}`;
        assert.equal(res.status, 503, `${what}: ${res.text.slice(0, 300)}`);
        // It said "the preview failed; the console's log has the reason; nothing was changed", a 500 with Close.
        assert.equal(res.json.error, VALKEY_UNREACHABLE, what);
        assert.ok(valkeyBar(res.json.html), `${what}: ${res.json.html}`);
        assert.equal(res.json.ticket, undefined, what);
      }
      assert.equal(c.rows().length, rows, `${label}: a preview writes no audit row`);
      return answers.ms;
    };
    await c.front.refuse();
    const refused = await all("a port that refuses");
    await c.front.accept();
    // Each read ends at its store's or the fleet's own bound, well inside the client's 5 seconds.
    assert.ok(refused < 4500, `${Math.round(refused)} ms`);
    // The console reads again once Valkey answers: a preview of a question nobody captured is a refusal of its own.
    const back = await c.act("zero-touch-group", "preview", previews[0][1]);
    assert.equal(back.status, 400, back.text.slice(0, 300));
    c.front.freeze();
    const frozen = await all("a Valkey that stops answering");
    assert.ok(frozen < 6500, `${Math.round(frozen)} ms`);
    await c.thawed();
  }, {
    files: ({ env }) => {
      writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [], zeroTouch: { capture: true, model: "classifier/small", maxCostUsd: "0.01", names: {} } }));
    },
  });
});

// The draft store's drop as it leaves: the compare-and-set of the row, which keeps the row's own expiry.
const THE_DROP = /\r\n\$4\r\neval\r\n\$\d+\r\nif redis\.call\("GET",KEYS\[1\]\)~=ARGV\[1\] then return 0 end; redis\.call\("SET",KEYS\[1\],ARGV\[2\],"KEEPTTL"\)/;

test("an answer draft's drop on a real console: stopped at its read nothing was changed, and stopped at the drop itself it says may or may not, which is so, since the drop lands when Valkey wakes", live, async () => {
  await withConsole(async (c) => {
    // A draft as the worker leaves one, through the store's own writes: captured, queued, drafted.
    const fixture = answererFixture(c.now);
    const { question, draft, sources, digest, meta } = fixture.privateDraft;
    const runId = `gh-${c.host}`;
    const draftRunId = `gh-${c.host}-draft`;
    const store = makeAnswerDraftStore({ redis: c.direct, now: () => c.now });
    const doc = parseTriggersDocument(readFileSync(c.env.PI_TRIGGERS_FILE, "utf8"), c.env.PI_TRIGGERS_FILE);
    const rule = doc.answerRules[0];
    const key = (part) => `answerer:${part}:${answerConfigDigest(runId)}`;
    c.cleanup.push(async () => {
      await c.direct.del(key("meta"), key("input"), key("private"));
      await c.direct.zrem("answerer:index", runId);
    });
    const input = { runId, ruleId: rule.id, configDigest: answerRuleConfigDigest(doc, rule), project: "web", source: { kind: "github", repo: "acme/web", apiUrl: "https://api.github.com", target: { type: "issue", number: 512 } } };
    assert.equal(await store.capture(input, { v: 1, runId, ruleId: rule.id, draftRunId: null, at: c.now - 120_000, status: "pending", draftExists: false, sources: [] }), true);
    assert.equal(await store.update(runId, { status: "queued", draftRunId, category: meta.category, confidence: meta.confidence, answerableConfidence: meta.answerableConfidence, probabilities: meta.probabilities }), true);
    assert.equal(await store.saveDraft(runId, { question, draft, sources, digest }), true);
    const held = async () => [JSON.parse(await c.direct.get(key("meta"))).status, await c.direct.exists(key("private"))];
    const lastTwo = () => c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]);
    const dropWith = async (pattern) => {
      const preview = await c.act("answer-draft-drop", "preview", { runId, draftRunId, digest });
      assert.equal(preview.status, 200, preview.text.slice(0, 300));
      const frozen = c.front.freezeAt(pattern);
      const confirm = await clocked(c.act("answer-draft-drop", "confirm", { ticket: preview.json.ticket }));
      assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the named command");
      const out = { status: confirm.res.status, said: confirm.res.json.error, bar: confirm.res.json.html, ms: confirm.ms, rows: lastTwo(), before: await held() };
      await c.thawed();
      return { ...out, after: await held() };
    };

    // At the confirm's read of the draft: nothing had been asked to change, and Valkey is what did not answer.
    const atRead = await dropWith(commandOn("get", "answerer:meta:"));
    assert.deepEqual([atRead.status, atRead.said], [503, VALKEY_UNREACHABLE]);
    assert.ok(valkeyBar(atRead.bar), atRead.bar);
    assert.deepEqual(atRead.rows, [["answer-draft-drop", "ok", null], ["answer-draft-drop", "failed", "Valkey could not be reached"]]);
    assert.deepEqual([atRead.before, atRead.after], [["drafted", 1], ["drafted", 1]], "the draft is there, then and after the wake");

    // At the drop itself. The store's own timer gives up on it after 2 seconds, with an error that cannot say whether it
    // was sent, and the confirm said "the answer-draft-drop change could not be made; nothing was changed, and the
    // console's log has the reason". It was sent: the row reads dropped once Valkey wakes.
    const atDrop = await dropWith(THE_DROP);
    assert.deepEqual([atDrop.status, atDrop.said], [409, DRAFT_DROP_UNCONFIRMED]);
    assert.equal(atDrop.said, "The draft may or may not have been dropped: the drop was asked for and Valkey did not answer. Reload its run page once Valkey answers before trying again.");
    assert.ok(atDrop.bar.includes("The change did not finish") && !/nothing was changed/i.test(atDrop.bar), atDrop.bar);
    assert.deepEqual(atDrop.rows, [["answer-draft-drop", "ok", null], ["answer-draft-drop", "failed", DRAFT_DROP_UNCONFIRMED]]);
    assert.ok(atDrop.ms > 1500 && atDrop.ms < 4500, `the store's own bound decided (${Math.round(atDrop.ms)} ms)`);
    // The drop's row landed at the wake. Its draft's body is still there: the store deletes it after the row, and gave up
    // before that; it is never offered again, and goes when it expires.
    assert.deepEqual([atDrop.before, atDrop.after], [["drafted", 1], ["dropped", 1]]);
    const gone = await c.act("answer-draft-drop", "preview", { runId, draftRunId, digest });
    assert.equal(gone.status, 400, gone.text.slice(0, 300));
  }, {
    files: ({ dir, env }) => {
      const fixture = answererFixture(0);
      writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [], answerRules: fixture.rules, standingAnswers: fixture.standing.map(({ used, ...answer }) => answer) }));
      writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
    },
  });
});

test("a canary on a real console whose Valkey stops answering at its add says so in the canary's words, with one start of the hour counted", live, async () => {
  const pkg = { name: "pi-fmt", staged: "2.0.0", candidate: "2.0.1" };
  await withConsole(async (c) => {
    // The trigger's schedule as its worker would have put it in this host's queue: a canary is a fire of a served trigger.
    const schedulerId = `nightly-${c.host}`;
    const queue = makeQueue(parseConnection(databaseUrl(), { failFast: true }), { name: c.queueName });
    try {
      await queue.upsertJobScheduler(schedulerId, { pattern: "0 6 * * *" }, { name: "local", data: { kind: "local", folder: c.folder, flow: "fix" } });
    } finally {
      await queue.close().catch(() => {});
    }
    const waiting = await c.jobs();
    const preview = await c.act("package-canary", "preview", { index: 0, name: pkg.name, version: pkg.candidate });
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    const frozen = c.front.freezeAt(THE_ADD);
    const lost = await clocked(c.act("package-canary", "confirm", { ticket: preview.json.ticket }));
    assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the add");
    assert.equal(lost.res.status, 409, lost.res.text.slice(0, 300));
    // It said "Fire now got no queue acknowledgement", of an action whose person never pressed Fire now.
    assert.equal(lost.res.json.error, CANARY_UNCONFIRMED);
    assert.equal(lost.res.json.error, "A run may have been queued and one start of this hour was used: the canary got no queue acknowledgement. Preview it again first: the preview says when one is already queued or running");
    assert.doesNotMatch(lost.res.text, /Fire now/);
    assert.ok(lost.res.json.html.includes("The change did not finish"), lost.res.json.html);
    assert.deepEqual(c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]), [["package-canary", "ok", null], ["package-canary", "failed", CANARY_UNCONFIRMED]]);
    assert.equal(await c.direct.get(c.hourKey), "1", "one start of the hour was counted");
    assert.equal(await c.jobs(), waiting, "nothing reached Valkey while it did not answer");
    await c.thawed();
    assert.equal(await c.jobs(), waiting + 1, "the canary's run landed when Valkey woke");
    assert.equal(await c.direct.get(c.hourKey), "1");
  }, {
    files: ({ dir, folder, host, env }) => {
      mkdirSync(join(dir, "pi-global", "packages"), { recursive: true });
      writeFileSync(join(dir, "pi-global", "packages", "packages.json"), JSON.stringify({ stagedAt: "2026-10-01T00:00:00.000Z", packages: [{ name: pkg.name, version: pkg.staged, dir: `${pkg.name}--${pkg.staged}--aaaaaaaa`, from: "pi-packages" }] }));
      writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [{ on: { type: "cron", id: `nightly-${host}`, pattern: "0 6 * * *" }, run: { kind: "local", folder, flow: "fix", task: "t", maxCostUsd: "1" } }] }));
      return { PI_GLOBAL_PI_DIR: join(dir, "pi-global"), PI_MAX_COST_USD: "2" };
    },
  });
});

test("a configuration fix on a real console whose Valkey stops answering at its accounting's stage changes no file and says the accounting may or may not have been staged, which is so: the row lands when Valkey wakes", live, async () => {
  await withConsole(async (c) => {
    // A refusal a configuration change is made because of, as its worker recorded it on this host.
    const runId = `gh-${c.host}-refusal`;
    const record = buildRecord({ job: { id: runId, data: { kind: "github", repo: "acme/web", target: { type: "issue", number: 42 }, trigger: { matched: { index: 0, type: "label" } } } }, result: { outcome: "policy", reason: "secret-unresolved" }, startedAt: new Date(c.now - 2000).toISOString(), endedAt: new Date(c.now - 1000).toISOString() });
    record.touchScopeId = "a".repeat(64);
    makeRecordWriter({ logsDir: c.env.PI_LOGS_DIR })(record);
    // The fix rows of this run, whichever ids the store gave them, and their deletion.
    const mine = async () => {
      const out = [];
      for (const id of await c.direct.zrange("zero-touch:fixes:index", 0, -1)) {
        const row = JSON.parse((await c.direct.get(`zero-touch:fixes:meta:${id}`)) ?? "null");
        if (row?.runId === runId) out.push(row);
      }
      return out;
    };
    c.cleanup.push(async () => {
      for (const row of await mine()) {
        await c.direct.del(`zero-touch:fixes:meta:${row.id}`, `zero-touch:fixes:private:${row.id}`);
        await c.direct.zrem("zero-touch:fixes:index", row.id);
      }
    });
    const preview = await c.act("setting-set", "preview", { key: "maxTurns", value: "35", becauseRun: runId });
    assert.equal(preview.status, 200, preview.text.slice(0, 300));
    const frozen = c.front.freezeAt(commandOn("set", "zero-touch:fixes:meta:"));
    const confirm = await clocked(c.act("setting-set", "confirm", { ticket: preview.json.ticket }));
    assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the stage");
    // It said "Fix accounting could not be prepared. Nothing was changed; try again when Valkey is available."
    assert.deepEqual([confirm.res.status, confirm.res.json.error], [409, FIX_STAGE_UNCONFIRMED]);
    assert.ok(confirm.res.json.html.includes("The change did not finish") && !/nothing was changed/i.test(confirm.res.json.html), confirm.res.json.html);
    assert.deepEqual(c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]), [["setting-set", "ok", null], ["setting-set", "failed", FIX_STAGE_UNCONFIRMED]]);
    assert.ok(confirm.ms > 1500 && confirm.ms < 7000, `the store's own bounds decided (${Math.round(confirm.ms)} ms)`);
    assert.equal(JSON.parse(readFileSync(c.env.PI_SETTINGS_FILE, "utf8")).maxTurns, 30, "the settings file was not written");
    assert.deepEqual(await mine(), [], "nothing reached Valkey while it did not answer");
    await c.thawed();
    // The stage landed at the wake, for a change that was never made: it stays pending, and the page's fixes read partial.
    assert.deepEqual((await mine()).map((row) => [row.kind, row.state]), [["config", "pending"]]);
    assert.equal(JSON.parse(readFileSync(c.env.PI_SETTINGS_FILE, "utf8")).maxTurns, 30);
  }, {
    files: ({ dir }) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ maxTurns: 30, maxCostUsd: "2" }));
      return { PI_SETTINGS_FILE: join(dir, "settings.json") };
    },
  });
});

test("a configuration fix on a real console that its file refuses, with Valkey stopping at the refusal of its staged row, answers with the change's own refusal and takes its touch intent back; and a write to Valkey takes no becauseRun", live, async () => {
  await withConsole(async (c) => {
    const runId = `gh-${c.host}-refusal`;
    const record = buildRecord({ job: { id: runId, data: { kind: "github", repo: "acme/web", target: { type: "issue", number: 42 }, trigger: { matched: { index: 0, type: "label" } } } }, result: { outcome: "policy", reason: "secret-unresolved" }, startedAt: new Date(c.now - 2000).toISOString(), endedAt: new Date(c.now - 1000).toISOString() });
    record.touchScopeId = "a".repeat(64);
    makeRecordWriter({ logsDir: c.env.PI_LOGS_DIR })(record);
    const mine = async () => {
      const out = [];
      for (const id of await c.direct.zrange("zero-touch:fixes:index", 0, -1)) {
        const row = JSON.parse((await c.direct.get(`zero-touch:fixes:meta:${id}`)) ?? "null");
        if (row?.runId === runId) out.push(row);
      }
      return out;
    };
    c.cleanup.push(async () => {
      for (const row of await mine()) {
        await c.direct.del(`zero-touch:fixes:meta:${row.id}`, `zero-touch:fixes:private:${row.id}`);
        await c.direct.zrem("zero-touch:fixes:index", row.id);
      }
    });
    // The split's plan, its revert and the envelope write Valkey: none takes the field, refused by name before any read.
    for (const [name, body] of [["envelope-set", { envelope: { totalUsd: "80" } }], ["priorities-set", { projects: [{ id: "web", weight: 2 }] }], ["allocation-revert", { index: 0 }]]) {
      const res = await c.act(name, "preview", { ...body, becauseRun: runId });
      assert.equal(res.status, 400, `${name}: ${res.text.slice(0, 300)}`);
      assert.match(res.json.error, new RegExp(`^${name} takes .* only; becauseRun is not one of them, so nothing was changed$`), name);
    }
    // The touch intents this console began and Valkey still holds: an entry carries its console's clock, which no other
    // console has. Whatever this case finds, none is left behind in a hash the other files' consoles share by name.
    const begun = async () => Object.entries(await c.direct.hgetall(TOUCH_PENDING)).filter(([, at]) => Number(at) === c.now).map(([id]) => id);
    c.cleanup.push(async () => {
      const left = await begun();
      if (left.length) await c.direct.hdel(TOUCH_PENDING, ...left);
    });
    // A file action takes it. Its file changes between the preview and the confirm, so the change is refused, and Valkey
    // stops answering at the read that the refusal of its staged row begins with.
    const preview = await c.act("setting-set", "preview", { key: "maxTurns", value: "35", becauseRun: runId });
    assert.equal(preview.status, 200, preview.text.slice(0, 300));
    writeFileSync(c.env.PI_SETTINGS_FILE, JSON.stringify({ maxTurns: 31, maxCostUsd: "2" }));
    const frozen = c.front.freezeAt(commandOn("get", "zero-touch:fixes:meta:"));
    const confirm = await clocked(c.act("setting-set", "confirm", { ticket: preview.json.ticket }));
    assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the staged row's refusal");
    // It answered 500, "the setting-set change could not be made; nothing was changed, and the console's log has the
    // reason", with the row "the write threw (error)": the fix store's error in place of the change's own answer.
    assert.equal(confirm.res.status, 409, confirm.res.text.slice(0, 300));
    assert.match(confirm.res.json.error, /changed/, confirm.res.text.slice(0, 300));
    assert.doesNotMatch(confirm.res.text, /could not be made|console&#39;s log/);
    assert.deepEqual(c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]), [["setting-set", "ok", null], ["setting-set", "failed", confirm.res.json.error]]);
    assert.ok(confirm.ms > 1500 && confirm.ms < 8000, `the store's own bounds decided (${Math.round(confirm.ms)} ms)`);
    assert.equal(JSON.parse(readFileSync(c.env.PI_SETTINGS_FILE, "utf8")).maxTurns, 31, "the file is as the other writer left it");
    // The touch intent was taken back all the same: its file is gone at once, and its entry in Valkey when Valkey wakes.
    const outbox = join(c.env.PI_LOGS_DIR, "touch-outbox");
    assert.deepEqual(existsSync(outbox) ? readdirSync(outbox) : [], [], "no intent is left for a later read of the page to begin again");
    assert.equal((await begun()).length, 1, "the intent this confirm began is still Valkey's while it does not answer");
    await c.thawed();
    assert.deepEqual(await begun(), [], "its abort landed when Valkey woke");
    // What stays: the staged row, whose refusal was never sent. It reads pending until its record expires, unless its
    // file comes to show it, and the console's log says why, by the event and its cause: the line read "Zero touch
    // accounting needs repair" and nothing else, of this as of a fault of the code.
    assert.deepEqual((await mine()).map((row) => [row.kind, row.state]), [["config", "pending"]]);
    assert.ok(c.err.some((line) => line.includes("Zero touch accounting needs repair (zero_touch_fix_reject_pending: Error: fix-store-timeout)")), c.err.join("\n"));
  }, {
    files: ({ dir }) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ maxTurns: 30, maxCostUsd: "2" }));
      return { PI_SETTINGS_FILE: join(dir, "settings.json") };
    },
  });
});

test("a sandbox pin on a real console whose Valkey stops answering: at the request's lookup nothing was asked and Valkey is what is said, and at its add the request may or may not have been made, never done", live, async () => {
  await withConsole(async (c) => {
    // A kept workspace as its host publishes it, on this console's own host name.
    const kept = { id: `gh-${c.host}`, v: "local", until: c.now + 23 * 3_600_000, pin: false, generation: "a".repeat(64), kind: "github", image: "pi-job:4.3.1", canOpen: true };
    const settings = { image: "pi-job:4.3.1", defaultBackend: "local", backends: ["local"], egress: true, egressProxy: "pi-dispatch-egress-proxy", sandboxRetentionHours: 24, sandboxPinDays: 7 };
    const requests = sandboxPrepareQueueName(c.host);
    c.cleanup.push(async () => {
      await c.direct.srem(SANDBOX_INVENTORY_HOSTS, c.host);
      for (const pattern of [sandboxInventoryKey(c.host), `${sandboxPrepareSlotKey(c.host, 0).slice(0, -1)}*`, `bull:${requests}:*`]) {
        const keys = await c.direct.keys(pattern);
        if (keys.length > 0) await c.direct.del(...keys);
      }
    });
    assert.deepEqual(await makeSandboxInventory({ redis: c.direct, host: c.host, read: async () => ({ sandboxes: [kept], sandboxRetentionHours: 24 }), settings, now: () => c.now }).publish(), { published: true });
    /** What Valkey holds of the request: its slot claims and its queue's jobs. */
    const held = async () => {
      const queue = makeQueue(parseConnection(databaseUrl(), { failFast: true }), { name: requests });
      try {
        return [(await c.direct.keys(`${sandboxPrepareSlotKey(c.host, 0).slice(0, -1)}*`)).length, Object.values(await queue.getJobCounts()).reduce((n, count) => n + count, 0)];
      } finally {
        await queue.close().catch(() => {});
      }
    };
    const pinWith = async (pattern) => {
      const preview = await c.act("sandbox-pin", "preview", { host: c.host, id: kept.id });
      assert.equal(preview.status, 200, preview.text.slice(0, 300));
      const frozen = c.front.freezeAt(pattern);
      const confirm = await clocked(c.act("sandbox-pin", "confirm", { ticket: preview.json.ticket }));
      assert.equal(await Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]), "stopped", "Valkey stopped answering at the named command");
      const out = { status: confirm.res.status, said: confirm.res.json.error, bar: confirm.res.json.html, ms: confirm.ms, rows: c.rows().slice(-2).map((r) => [r.kind, r.outcome, r.reason ?? null]) };
      await c.thawed();
      return { ...out, after: await held() };
    };
    // Each answered 200, "done", with a note that zero touch accounting was incomplete and that the action had succeeded.
    // At the lookup of the request, before anything was asked to change.
    const atLookup = await pinWith(commandOn("hgetall", `bull:${requests}:`));
    assert.deepEqual([atLookup.status, atLookup.said], [503, VALKEY_UNREACHABLE]);
    assert.ok(valkeyBar(atLookup.bar), atLookup.bar);
    assert.deepEqual(atLookup.rows, [["sandbox-pin", "ok", null], ["sandbox-pin", "failed", "Valkey could not be reached"]]);
    assert.deepEqual(atLookup.after, [0, 0], "no slot was claimed and no request made, then or at the wake");
    // At the request's add: its slot was claimed, and the request lands when Valkey wakes.
    const atAdd = await pinWith(THE_ADD);
    assert.deepEqual([atAdd.status, atAdd.said], [409, SANDBOX_REQUEST_UNCONFIRMED]);
    assert.equal(atAdd.said, "The sandbox request may or may not have been made: it was asked for and Valkey did not answer. Reload the Sandboxes page once Valkey answers before asking again.");
    assert.ok(atAdd.bar.includes("The change did not finish") && !/nothing was changed|succeeded/i.test(atAdd.bar), atAdd.bar);
    assert.deepEqual(atAdd.rows, [["sandbox-pin", "ok", null], ["sandbox-pin", "failed", SANDBOX_REQUEST_UNCONFIRMED]]);
    assert.ok(atAdd.ms > 2000 && atAdd.ms < 7000, `the helper's own bound decided (${Math.round(atAdd.ms)} ms)`);
    assert.deepEqual(atAdd.after, [1, 1], "the slot is held and the request was made at the wake");
  });
});
