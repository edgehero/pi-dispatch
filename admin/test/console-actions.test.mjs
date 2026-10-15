import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { enqueueForgeJob, forgeDeliveryJobId, makeQueue } from "@edgehero/pi-dispatch/queue";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { ACTIONS, BULK_MAX, CANCEL_TIMEOUT_SENTENCE, DIFF_LINES_MAX, diffHtmlOf, dryRunFs, lineDiff, PREVIEW_AGAIN, reserveText } from "../src/console/actions.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { makeLoginLimiter } from "../src/console/guards.mjs";
import { readJobsData } from "../src/console/job-data.mjs";
import { fleetActive, fleetFailed, fleetHeld, fleetQueues, configTriggers, parkedInbox, runSummary } from "../src/console/panels.mjs";
import { createConsoleServer } from "../src/console/server.mjs";
import * as RM from "../src/read-model.mjs";
import * as WP from "../src/write-plans.mjs";

// The console's action table over HTTP (issue #642, REQ-OPERATOR-CONSOLE-ACTIONS): every action through its GENERATED
// route, preview then confirm, against the read model's real funnels and the tools' real planners. File actions run on
// a deployment in a temp directory; the BullMQ-backed ones on database 13 of VALKEY_TEST_URL, flushed before each test
// (the queue names are fixed, so a database of its own is the isolation). The auth pieces are small fakes; the tickets
// and the audit log are the real ones, and the audit chain is verified at the end.

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;
const FILE = {
  version: 1,
  generation: 0,
  tokens: [
    { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
    { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
  ],
};
// The answer text the parked test types: it must reach the job and never an audit row, a log line or a session id.
const ANSWER = "use the staging db, answer-canary-7f3e";

const BASE = process.env.VALKEY_TEST_URL;
const URL13 = BASE
  ? (() => {
      const u = new URL(BASE);
      u.pathname = "/13";
      return u.toString();
    })()
  : null;
const live = { skip: URL13 ? false : "needs VALKEY_TEST_URL", timeout: 60_000 };

const seen = { logs: [], audit: [], bodies: [] };
const logsDirs = [];

let sessionCount = 0;
function fakeSessions() {
  const liveSessions = new Map();
  return {
    create({ name, role, tokenHash }) {
      sessionCount += 1;
      const id = `s${String(sessionCount).padStart(42, "0")}`;
      liveSessions.set(id, { id, name, role, tokenHash });
      return { id };
    },
    get: (id) => (liveSessions.has(id) ? { ...liveSessions.get(id) } : null),
    peek: (id) => (liveSessions.has(id) ? { ...liveSessions.get(id) } : null),
    destroy: (id) => liveSessions.delete(id),
    streamAcquire: () => true,
    streamRelease() {},
  };
}
const fakeCookies = {
  sessionCookie: (id) => `pdc_session=${id}; HttpOnly; SameSite=Strict; Path=/`,
  clearSessionCookie: () => "pdc_session=; Max-Age=0",
  readSessionCookie: (header) => /(?:^|;\s*)pdc_session=([A-Za-z0-9_-]{43})/.exec(header ?? "")?.[1] ?? null,
  sessionDigest: (id) => sha256(id).slice(0, 12),
};

/** A deployment's config files in a temp dir, and its paths as `resolvePaths` names them. */
function deployment(valkeyUrl = "redis://127.0.0.1:1/0") {
  const dir = tempDir("console-actions-");
  const paths = {
    triggersPath: join(dir, "triggers.json"),
    settingsFile: join(dir, "settings.json"),
    pauseWindowsPath: join(dir, "pause-windows.json"),
    scopedLimitsPath: join(dir, "scoped-limits.json"),
    projectsFile: join(dir, "projects.json"),
    envelopeFile: null,
    logsDir: join(dir, "logs"),
    valkeyUrl,
  };
  mkdirSync(paths.logsDir, { recursive: true });
  const json = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
  json(paths.triggersPath, { triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage", secrets: { TOKEN: "op://vault/secret-ref-canary" } } }] });
  json(paths.settingsFile, { maxTurns: 30, maxCostUsd: "2" });
  json(paths.pauseWindowsPath, { windows: [{ scope: "*", from: "01:00", to: "02:00" }] });
  json(paths.scopedLimitsPath, { version: 1, limits: [{ scope: "acme/web", day: 10 }] });
  json(paths.projectsFile, { version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] });
  return { dir, paths };
}

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

/** A running console over `paths` with the real tickets and audit log; `actionDeps` overrides go in `a`. */
async function start({ paths, a = {}, readOnly = false, hub = null } = {}) {
  let t = T0;
  const now = () => t;
  const logsDir = paths.logsDir;
  logsDirs.push(logsDir);
  const real = makeConsoleAudit({ logsDir, now });
  const audit = {
    failNext: 0,
    // When a number: that many more appends land, then the next one fails (once); the Nth-append failure.
    failAfter: null,
    rows: [],
    append(row) {
      if (audit.failAfter !== null) {
        if (audit.failAfter === 0) {
          audit.failAfter = null;
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        audit.failAfter -= 1;
      }
      if (audit.failNext > 0) {
        audit.failNext -= 1;
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      const stored = real.append(row);
      audit.rows.push(stored);
      seen.audit.push(JSON.stringify(stored));
      return stored;
    },
  };
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly, maxMs: 12 * 3600000, pauseWindowsPath: paths.pauseWindowsPath, dir: null },
    now,
    audit,
    sessions: fakeSessions(),
    cookies: fakeCookies,
    tickets: makeConfirmTickets({ now }),
    limiter: makeLoginLimiter({ now }),
    log: (line) => seen.logs.push(line),
    readTokens: () => ({ file: FILE }),
    findToken: (file, presented) => file.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: RM.writePauseWindows,
    actionDeps: { rm: RM, plans: WP, paths, env: {}, urlShown: (u) => u.replace(/\/\/[^@]*@/, "//"), readJobsData, host: "console-test", ...a },
    pageDeps: { fleet: a.fleet ?? { snapshot: async () => ({}) } },
    hub,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  function send({ path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
      const length = body !== null ? { "content-length": String(Buffer.byteLength(body)) } : {};
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host, ...length, ...headers }, setHost: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          seen.bodies.push(text);
          resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
        });
      });
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
  }
  const writeHeaders = (extra = {}) => ({ origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
  const post = (path, obj, extra = {}) => send({ path, headers: writeHeaders(extra), body: JSON.stringify(obj) });
  async function cookieFor(token = OP_TOKEN) {
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ token });
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/login", headers: { host, ...writeHeaders(), "content-length": String(Buffer.byteLength(body)) }, setHost: false }, resolve);
      req.on("error", reject);
      req.end(body);
    });
    res.resume();
    return res.headers["set-cookie"][0].split(";")[0];
  }
  const op = await cookieFor(OP_TOKEN);
  const act = async (name, body, cookie = op) => {
    const preview = await post(`/api/act/${name}/preview`, body, { cookie });
    return preview;
  };
  const confirm = (name, ticket, cookie = op) => post(`/api/act/${name}/confirm`, { ticket }, { cookie });
  /** Preview then confirm; asserts the preview issued a ticket. */
  async function both(name, body) {
    const p = await act(name, body);
    assert.equal(p.status, 200, `${name} preview: ${p.text}`);
    const pj = p.json();
    assert.equal(typeof pj.ticket, "string", `${name} preview issued a ticket: ${p.text}`);
    const c = await confirm(name, pj.ticket);
    return { preview: pj, confirm: c };
  }
  return { server, audit, post, op, cookieFor, act, confirm, both, advance: (ms) => (t += ms), writeHeaders, send };
}

const read = (p) => readFileSync(p, "utf8");
const lastWrite = (c) => c.audit.rows.filter((r) => r.action === "write").at(-1);

// ---- the table -------------------------------------------------------------------------------------------------------

test("the action table: unique names, the audit kind charset, two generated routes each, and the job-actions bound", async () => {
  const names = ACTIONS.map((a) => a.name);
  assert.equal(new Set(names).size, names.length);
  for (const a of ACTIONS) {
    assert.match(a.name, /^[a-z0-9-]{1,40}$/);
    assert.match(a.kind, /^[a-z0-9-]{1,40}$/, `${a.name}: kind fits INT-CONSOLE-AUDIT-LOG's charset`);
    assert.equal(typeof a.preview, "function");
    assert.equal(typeof a.apply, "function");
  }
  // The kinds the contract names, held to the table so a spec and the code cannot drift apart.
  assert.deepEqual(Object.fromEntries(ACTIONS.map((a) => [a.name, a.kind])), {
    "cancel-active": "cancel-active",
    "cancel-held": "cancel-held",
    "cancel-all-held": "held-cancel-all",
    "retry-failed": "failed-retry",
    "remove-failed": "failed-remove",
    "retry-all-failed": "failed-retry-all",
    "remove-all-failed": "failed-remove-all",
    rerun: "run-rerun",
    "parked-answer": "parked-answer",
    "fleet-pause": "fleet-pause",
    "fleet-resume": "fleet-resume",
    "queue-pause": "queue-pause",
    "queue-resume": "queue-resume",
    "pause-windows": "pause-windows-set",
    "trigger-add": "trigger-add",
    "trigger-edit": "trigger-edit",
    "trigger-delete": "trigger-delete",
    "setting-set": "setting-set",
    "setting-unset": "setting-unset",
    "secret-profile-add": "secret-profile-add",
    "secret-profile-remove": "secret-profile-remove",
    "pause-window-add": "pause-window-add",
    "pause-window-edit": "pause-window-edit",
    "pause-window-delete": "pause-window-delete",
    "limit-add": "limit-add",
    "limit-edit": "limit-edit",
    "limit-delete": "limit-delete",
    "project-add": "project-add",
    "project-edit": "project-edit",
    "project-delete": "project-delete",
    "envelope-set": "envelope-set",
    "priorities-set": "priorities-set",
    "allocation-revert": "allocation-revert",
  });
  assert.deepEqual(ACTIONS.filter((a) => a.paid).map((a) => a.name).sort(), ["fleet-resume", "parked-answer", "queue-resume", "rerun", "retry-all-failed", "retry-failed"]);
  assert.deepEqual(ACTIONS.filter((a) => a.bulk).map((a) => a.name).sort(), ["cancel-all-held", "remove-all-failed", "retry-all-failed"]);
  assert.equal(BULK_MAX, RM.BULK_MAX, "the console's bulk bound is job-actions' own");
});

test("the cancel-timeout refusal is the TUI's sentence, byte for byte (REQ-OPERATOR-JOB-CANCEL)", () => {
  const dashboard = readFileSync(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)), "utf8");
  assert.ok(dashboard.includes(`if (res?.timeout) return ${JSON.stringify(CANCEL_TIMEOUT_SENTENCE)};`), "dashboard.ts cancelNote says the same sentence");
});

// ---- the dry run and the diff ------------------------------------------------------------------------------------------

test("dryRunFs keeps every write in memory: the real file and its directory are untouched", () => {
  const dir = tempDir("console-dry-");
  const p = join(dir, "f.json");
  writeFileSync(p, "old\n");
  const fs = dryRunFs(nodeFs);
  const fd = fs.openSync(`${p}.lock`, "wx");
  assert.throws(() => fs.openSync(`${p}.lock`, "wx"), { code: "EEXIST" });
  fs.closeSync(fd);
  fs.writeFileSync(`${p}.tmp`, "new\n", { flag: "wx" });
  fs.renameSync(`${p}.tmp`, p);
  fs.unlinkSync(`${p}.lock`);
  fs.mkdirSync(join(dir, "sub"), { recursive: true });
  fs.chmodSync(p, 0o600);
  assert.equal(fs.readFileSync(p, "utf8"), "new\n");
  assert.equal(fs.existsSync(`${p}.tmp`), false);
  assert.equal(read(p), "old\n", "the real file is as it was");
  assert.deepEqual(readdirSync(dir), ["f.json"], "nothing else appeared");
});

test("the diff is escaped, hides secret references, and cuts unchanged runs", () => {
  const before = JSON.stringify({ a: 1, b: "<script>", run: { secrets: { T: "op://v/ref" } }, c: [1, 2, 3, 4, 5, 6] }, null, 2);
  const after = JSON.stringify({ a: 2, b: "<script>", run: { secrets: { T: "op://v/other" } }, c: [1, 2, 3, 4, 5, 6] }, null, 2);
  const out = String(diffHtmlOf(before, after));
  assert.ok(!out.includes("<script>"), "escaped");
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(!out.includes("op://"), "no secret reference");
  assert.match(out, /<del>-\s+&quot;a&quot;: 1,<\/del>\n<ins>\+\s+&quot;a&quot;: 2,<\/ins>/, "the old line, then the new");
  assert.ok(lineDiff(["x", "1", "2", "3", "4", "5", "6", "y"], ["x", "1", "2", "3", "4", "5", "6", "z"]).some((o) => o.t === "gap"), "a long unchanged run is cut");
});

test("reserveText never says $0 for a reserve it does not know", () => {
  assert.match(reserveText({ unknown: true }), /Reserve unknown/);
  assert.match(reserveText({ slots: 1, dollarsMicros: 1_500_000, capMicros: 1_500_000, zeroRated: false }), /\$1\.50/);
  assert.match(reserveText({ slots: 1, dollarsMicros: 0, zeroRated: true }), /zero-rated/);
  const bulk = reserveText({ bulk: true, slots: 2, dollarsMicros: 0, unknown: 2 });
  assert.ok(!bulk.includes("$0"), bulk);
  assert.match(bulk, /unknown/);
});

// ---- file actions over HTTP: preview, confirm, the file, the row --------------------------------------------------

/** Each file action: its body, the file it writes, and what the file must say after. */
const FILE_CASES = [
  ["trigger-add", { trigger: { kind: "comment", phrase: "@pi", flow: "fix" } }, "triggersPath", (j) => j.triggers.length === 2 && j.triggers[1].on.phrase === "@pi"],
  ["trigger-edit", { index: 0, flow: "review" }, "triggersPath", (j) => j.triggers[0].run.flow === "review" && j.triggers[0].run.secrets.TOKEN.startsWith("op://")],
  ["trigger-delete", { index: 0 }, "triggersPath", (j) => j.triggers.length === 0],
  ["setting-set", { key: "maxTurns", value: "40" }, "settingsFile", (j) => j.maxTurns === 40],
  ["setting-unset", { key: "maxTurns" }, "settingsFile", (j) => !("maxTurns" in j)],
  ["secret-profile-add", { name: "prod", path: "/opt/resolve-prod" }, "settingsFile", (j) => j.secretProfiles.prod === "/opt/resolve-prod"],
  ["pause-window-add", { scope: "acme/web", from: "22:00", to: "23:00", days: ["sat"] }, "pauseWindowsPath", (j) => j.windows.length === 2 && j.windows[1].days[0] === "sat"],
  ["pause-window-edit", { index: 0, to: "03:00" }, "pauseWindowsPath", (j) => j.windows[0].to === "03:00" && j.windows[0].from === "01:00"],
  ["pause-window-delete", { index: 0 }, "pauseWindowsPath", (j) => j.windows.length === 0],
  ["limit-add", { limit: { scope: "acme/api", day: 5 } }, "scopedLimitsPath", (j) => j.limits.length === 2 && j.limits[1].day === 5],
  ["limit-edit", { index: 0, limit: { day: 20 } }, "scopedLimitsPath", (j) => j.limits[0].day === 20],
  ["limit-delete", { index: 0 }, "scopedLimitsPath", (j) => j.limits.length === 0],
  ["project-add", { id: "api", members: "github:acme/api" }, "projectsFile", (j) => j.projects.some((p) => p.id === "api")],
  ["project-edit", { id: "web", name: "Web shop" }, "projectsFile", (j) => j.projects[0].name === "Web shop"],
  ["project-delete", { id: "web" }, "projectsFile", (j) => j.projects.length === 0],
];

for (const [name, body, field, holds] of FILE_CASES) {
  test(`${name}: preview writes nothing, confirm writes exactly the previewed bytes, and the row carries kind and both digests`, async () => {
    const { paths } = deployment();
    const c = await start({ paths });
    const file = paths[field];
    const before = read(file);
    const p = await c.act(name, body);
    assert.equal(p.status, 200, p.text);
    const pj = p.json();
    assert.equal(read(file), before, "the preview wrote nothing");
    assert.equal(pj.beforeDigest, sha256(before));
    assert.equal(pj.kind, ACTIONS.find((a) => a.name === name).kind);
    assert.ok(pj.diffHtml.includes('<pre class="diff">'), "a diff is shown");
    assert.ok(!pj.diffHtml.includes("op://"), "a secret reference never reaches the preview");
    const res = await c.confirm(name, pj.ticket);
    assert.equal(res.status, 200, res.text);
    const after = read(file);
    assert.equal(sha256(after), pj.afterDigest, "the preview's after digest is the digest of what was written");
    assert.ok(holds(JSON.parse(after)), after);
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.outcome, row.target, row.beforeDigest, row.afterDigest], [pj.kind, "ok", file, pj.beforeDigest, pj.afterDigest]);
    assert.equal(row.actor.name, "alice");
  });
}

test("secret-profile-remove and the whole-list pause-windows write go through the same pipeline", async () => {
  const { paths } = deployment();
  writeFileSync(paths.settingsFile, `${JSON.stringify({ secretProfiles: { prod: "/opt/r" } }, null, 2)}\n`);
  const c = await start({ paths });
  const { confirm } = await c.both("secret-profile-remove", { name: "prod" });
  assert.equal(confirm.status, 200, confirm.text);
  assert.deepEqual(JSON.parse(read(paths.settingsFile)).secretProfiles, {});
  const whole = await c.both("pause-windows", { windows: [{ scope: "*", from: "05:00", to: "06:00" }] });
  assert.equal(whole.confirm.status, 200);
  assert.equal(lastWrite(c).kind, "pause-windows-set");
});

test("a refusal is the tool's own sentence, before any ticket: a tool-proof trigger field, an unknown key, a bad index", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const proof = await c.act("trigger-add", { trigger: { kind: "label", labels: ["x"], flow: "f", run: { maxCostUsd: "9" } } });
  assert.equal(proof.status, 400);
  assert.equal(proof.json().error, WP.planTriggerAdd({ params: { kind: "label", labels: ["x"], flow: "f", run: { maxCostUsd: "9" } }, paths, env: {} }).refusal);
  assert.match((await c.act("setting-set", { key: "nope", value: "1" })).json().error, /^unknown key 'nope'/);
  assert.match((await c.act("pause-window-delete", { index: 7 })).json().error, /no pause window at index 7 \(have 1\)/);
  // A value the funnel's own parser refuses is refused at the preview (the dry run), with the parser's words.
  const bad = await c.act("pause-window-add", { scope: "*", from: "25:00", to: "02:00" });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /^rejected: /);
  assert.equal(c.audit.rows.filter((r) => r.action === "write").length, 0, "no preview writes a row");
});

test("a stale ticket (the file changed after the preview) is refused 409, the file keeps the other writer's bytes, rows ok then failed", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const p = (await c.act("setting-set", { key: "maxTurns", value: "41" })).json();
  const theirs = `${JSON.stringify({ maxTurns: 99 }, null, 2)}\n`;
  writeFileSync(paths.settingsFile, theirs);
  const res = await c.confirm("setting-set", p.ticket);
  assert.equal(res.status, 409, res.text);
  assert.equal(read(paths.settingsFile), theirs);
  const [ok, failed] = c.audit.rows.slice(-2);
  assert.deepEqual([ok.outcome, failed.outcome, failed.ticket], ["ok", "failed", ok.ticket]);
  assert.equal(failed.kind, "setting-set");
});

test("a ticket is single use, bound to its session and its action", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const other = await c.cookieFor(OP_TOKEN);
  const p = (await c.act("trigger-delete", { index: 0 })).json();
  const stolen = await c.confirm("trigger-delete", p.ticket, other);
  assert.equal(stolen.status, 409);
  assert.match(stolen.json().error, /another sign-in/);
  const p2 = (await c.act("trigger-delete", { index: 0 })).json();
  const wrongAction = await c.confirm("limit-delete", p2.ticket);
  assert.equal(wrongAction.status, 409);
  assert.match(wrongAction.json().error, /another action/);
  assert.equal(JSON.parse(read(paths.triggersPath)).triggers.length, 1, "nothing was deleted");
  assert.equal(c.audit.rows.at(-1).outcome, "refused");
});

test("an audit append failure refuses the confirm 500 and the file is untouched", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const before = read(paths.triggersPath);
  const p = (await c.act("trigger-delete", { index: 0 })).json();
  c.audit.failNext = 1;
  const res = await c.confirm("trigger-delete", p.ticket);
  assert.equal(res.status, 500);
  assert.match(res.json().error, /audit log/);
  assert.equal(read(paths.triggersPath), before);
});

test("after a write lands the live hub is asked for a tick; a refused one asks for none", async () => {
  const { paths } = deployment();
  let ticks = 0;
  const c = await start({ paths, hub: { tick: () => (ticks += 1), endSession() {} } });
  await c.both("pause-window-delete", { index: 0 });
  assert.equal(ticks, 1);
  await c.act("pause-window-delete", { index: 0 });
  assert.equal(ticks, 1, "a preview does not tick");
});

test("an action without its deps answers 503 at the preview, naming what is missing", async () => {
  const { paths } = deployment();
  const c = await start({ paths, a: { rm: null } });
  const res = await c.act("trigger-delete", { index: 0 });
  assert.equal(res.status, 503);
  assert.match(res.json().error, /without what the trigger-delete action needs \(rm\)/);
});

test("priorities-set and allocation-revert refuse by the envelope read's own words when there is no envelope; nothing is written", async () => {
  const { paths } = deployment();
  const { envelopeProblem } = await import("../src/insights-assembly.mjs");
  const c = await start({ paths, a: { envelopeProblem } });
  const p = await c.act("priorities-set", { projects: [{ id: "web", weight: 3 }] });
  assert.equal(p.status, 409);
  assert.equal(p.json().error, envelopeProblem({ unset: true }));
  assert.equal((await c.act("allocation-revert", { index: 0 })).json().error, envelopeProblem({ unset: true }));
  assert.equal((await c.act("priorities-set", { projects: "web=3" })).status, 400);
  assert.equal(c.audit.rows.filter((r) => r.action === "write").length, 0);
});

// ---- fleet and job actions on fakes ------------------------------------------------------------------------------------

test("cancel-active: an ack is 200; no ack is 409 with REQ-OPERATOR-JOB-CANCEL's sentence and a failed row", async () => {
  const { paths } = deployment();
  let answer = { ack: "mini1" };
  const fleet = { snapshot: async () => ({}), cancelActive: async ({ jobId }) => (jobId === "gh-1" ? answer : null) };
  const c = await start({ paths, a: { fleet } });
  const ok = await c.both("cancel-active", { jobId: "gh-1" });
  assert.equal(ok.confirm.status, 200);
  assert.equal(ok.confirm.json().ack, "mini1");
  answer = { timeout: true };
  const late = await c.both("cancel-active", { jobId: "gh-1" });
  assert.equal(late.confirm.status, 409);
  assert.equal(late.confirm.json().error, CANCEL_TIMEOUT_SENTENCE);
  assert.equal(c.audit.rows.at(-1).reason, CANCEL_TIMEOUT_SENTENCE);
  assert.equal((await c.act("cancel-active", { jobId: "<b>" })).status, 400, "a job id outside the charset is refused");
});

test("fleet-pause and fleet-resume: the kill switch's decision refuses a resume at the preview; the reader's funnel at the confirm", async () => {
  const { paths } = deployment();
  const calls = [];
  const fleet = {
    snapshot: async () => ({}),
    pause: async () => (calls.push("pause"), { results: [{ shown: "redis://h/0", res: { ok: true, queues: ["pi-jobs"] } }] }),
    resume: async () => (calls.push("resume"), { results: [{ shown: "redis://h/0", res: { unreachable: "down", partial: { done: ["pi-jobs"], failed: "pi-jobs@m" } } }] }),
  };
  let refuseResume = true;
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: ({ paused }) => (!paused && refuseResume ? { refused: "VALKEY_URL disagrees: it resumes neither" } : { urls: ["redis://user:secret-pass@h/0"], disagreement: null }) } });
  const p = await c.act("fleet-pause", {});
  assert.ok(!p.text.includes("secret-pass"), "a Valkey password is never shown");
  const done = await c.confirm("fleet-pause", p.json().ticket);
  assert.equal(done.status, 200);
  assert.deepEqual(done.json().results, [{ valkey: "redis://h/0", ok: true, queues: ["pi-jobs"] }]);
  const refused = await c.act("fleet-resume", {});
  assert.equal(refused.status, 400);
  assert.match(refused.json().error, /resumes neither/);
  refuseResume = false;
  const partial = await c.both("fleet-resume", {});
  assert.equal(partial.confirm.status, 409);
  assert.match(partial.confirm.json().error, /did not reach every queue: redis:\/\/h\/0 stopped after pi-jobs, failed at pi-jobs@m/);
  assert.deepEqual(calls, ["pause", "resume"]);
  assert.equal(c.audit.rows.at(-1).outcome, "failed");
});

test("retry-all-failed shows each job's reserve and the sum; a job whose data cannot be read is 'reserve unknown', never $0", async () => {
  const { paths } = deployment();
  const acted = [];
  const rm = {
    ...RM,
    planFailedBulk: async () => ({ jobs: [{ jobId: "gh-a", queue: "pi-jobs", attemptsMade: 1, finishedOn: 5 }, { jobId: "gh-b", queue: "pi-jobs", attemptsMade: 2, finishedOn: 6 }], more: 3, examinedAll: true }),
    retryFailedJobs: async ({ jobs }) => (acted.push(jobs), { results: [{ jobId: "gh-a", ok: true, queue: "pi-jobs" }, { jobId: "gh-b", invalid: "job gh-b failed again since the preview (it changed since the preview)" }] }),
  };
  const readData = async ({ jobs }) => new Map(jobs.map((j) => [j.jobId, j.jobId === "gh-a" ? { kind: "github", maxCostUsd: "1.5" } : null]));
  const c = await start({ paths, a: { rm, readJobsData: readData } });
  const p = (await c.act("retry-all-failed", {})).json();
  assert.deepEqual(p.reserve, { bulk: true, slots: 2, dollarsMicros: 1_500_000, unknown: 1 });
  assert.match(p.diffHtml, /gh-a on pi-jobs, 1 attempt\(s\), reserve \$1\.50/);
  assert.match(p.diffHtml, /gh-b on pi-jobs, 2 attempt\(s\), reserve unknown/);
  assert.match(p.diffHtml, /3 more match and are NOT in this action/);
  assert.equal(p.targets[1].reserve.unknown, true);
  const res = await c.confirm("retry-all-failed", p.ticket);
  assert.equal(res.status, 200, res.text);
  const r = res.json();
  assert.deepEqual([r.count, r.done], [2, 1]);
  assert.deepEqual(acted[0], [{ jobId: "gh-a", attemptsMade: 1, finishedOn: 5 }, { jobId: "gh-b", attemptsMade: 2, finishedOn: 6 }], "the funnel got exactly the previewed list and fingerprints");
  const rows = c.audit.rows.filter((x) => x.kind === "failed-retry-all");
  assert.deepEqual(rows.map((x) => [x.target, x.outcome, x.count, x.reserve ?? null]), [["gh-a", "ok", 2, 1_500_000], ["gh-b", "ok", 2, null], ["gh-b", "failed", 2, null]]);
  assert.equal(new Set(rows.map((x) => x.ticket)).size, 1, "one ticket digest shared by every job's rows");
});

test("a bulk confirm whose audit fails on the Nth row acts on NO job: every ok row first, then the apply; 500 and a compensating row for each written", async () => {
  const { paths } = deployment();
  const acted = [];
  const jobs = ["gh-a", "gh-b", "gh-c"].map((jobId, i) => ({ jobId, queue: "pi-jobs", attemptsMade: 1, finishedOn: i + 1 }));
  const rm = { ...RM, planFailedBulk: async () => ({ jobs, more: 0 }), removeFailedJobs: async (args) => (acted.push(args), { results: jobs.map((j) => ({ jobId: j.jobId, ok: true })) }) };
  const c = await start({ paths, a: { rm } });
  const p = (await c.act("remove-all-failed", {})).json();
  c.audit.failAfter = 1;
  const res = await c.confirm("remove-all-failed", p.ticket);
  assert.equal(res.status, 500, res.text);
  assert.match(res.json().error, /audit log could not be written/);
  assert.deepEqual(acted, [], "no job was touched");
  const rows = c.audit.rows.filter((r) => r.kind === "failed-remove-all");
  assert.deepEqual(rows.map((r) => [r.target, r.outcome]), [["gh-a", "ok"], ["gh-a", "failed"]], "the one written row is compensated, and no later job has a row");
});

/** An allocation read model on fakes: a mutable envelope digest, and the two apply funnels recorded. */
function allocationRm({ log = [], answer = { outcome: "applied", planId: "p1" } } = {}) {
  const state = { digest: "d1", applied: [], reverted: [], answer };
  const rm = {
    ...RM,
    envelopeJobCap: () => null,
    readEnvelope: () => ({ envelope: { version: 1 }, digest: state.digest, projects: [] }),
    readAllocations: async () => ({ log }),
    applyPriorities: async (args) => (state.applied.push(args), state.answer),
    revertAllocation: async (args) => (state.reverted.push(args), { outcome: "reverted", planId: "r1" }),
  };
  return { rm, state };
}

test("priorities-set: the preview lists repos and reason; an envelope changed after the preview is refused at the confirm, nothing applied; a worker refusal names its field and rule", async () => {
  const { paths } = deployment();
  const { rm, state } = allocationRm();
  const c = await start({ paths, a: { rm } });
  const p = (await c.act("priorities-set", { projects: [{ id: "web", weight: 3, repos: ["acme/web", "acme/api"], reason: "launch <week>" }] })).json();
  assert.match(p.diffHtml, /web: weight 3, repos acme\/web, acme\/api, reason: launch &lt;week&gt;/, "repos and reason, escaped");
  state.digest = "d2";
  const stale = await c.confirm("priorities-set", p.ticket);
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.json().error, /allocation envelope changed since the preview; nothing was applied/);
  assert.equal(state.applied.length, 0, "nothing applied");
  state.answer = { outcome: "refused", reason: "the plan moves too far", field: "projects[0].weight", rule: "step" };
  const p2 = (await c.act("priorities-set", { projects: [{ id: "web", weight: 9 }] })).json();
  const refused = await c.confirm("priorities-set", p2.ticket);
  assert.equal(refused.status, 409);
  assert.equal(refused.json().error, "refused: the plan moves too far (projects[0].weight: step)");
});

test("allocation-revert: a row with no split is refused at the preview; an envelope changed after the preview is refused at the confirm, nothing reverted", async () => {
  const { paths } = deployment();
  const { rm, state } = allocationRm({ log: [{ at: "2026-10-15T00:00:00Z", outcome: "applied", planId: "p1", weights: { web: 2 } }, { at: "2026-10-14T00:00:00Z", outcome: "refused", weights: null }] });
  const c = await start({ paths, a: { rm } });
  const none = await c.act("allocation-revert", { index: 1 });
  assert.equal(none.status, 400);
  assert.equal(none.json().error, "history row #1 carries no split to go back to");
  const p = (await c.act("allocation-revert", { index: 0 })).json();
  state.digest = "d2";
  const stale = await c.confirm("allocation-revert", p.ticket);
  assert.equal(stale.status, 409);
  assert.match(stale.json().error, /allocation envelope changed since the preview; nothing was reverted/);
  assert.equal(state.reverted.length, 0);
});

test("secret-profile-add and -remove: a settings file changed after the preview is refused 409 and keeps the other writer's bytes", async () => {
  for (const [name, body, start0] of [["secret-profile-add", { name: "prod", path: "/opt/r" }, {}], ["secret-profile-remove", { name: "prod" }, { secretProfiles: { prod: "/opt/r" } }]]) {
    const { paths } = deployment();
    writeFileSync(paths.settingsFile, `${JSON.stringify(start0, null, 2)}\n`);
    const c = await start({ paths });
    const p = (await c.act(name, body)).json();
    assert.equal(typeof p.ticket, "string", JSON.stringify(p));
    const theirs = `${JSON.stringify({ ...start0, maxTurns: 77 }, null, 2)}\n`;
    writeFileSync(paths.settingsFile, theirs);
    const res = await c.confirm(name, p.ticket);
    assert.equal(res.status, 409, `${name}: ${res.text}`);
    assert.equal(read(paths.settingsFile), theirs, `${name}: the other writer's bytes stay`);
  }
});

test("small refusals: a body nested too deep (400), cancel-held of a job not held, and the fleet-pause preview names a Valkey disagreement", async () => {
  const { paths } = deployment();
  const fleet = { snapshot: async () => ({ held: { rows: [{ jobId: "gh-2", label: "jira" }] } }), cancelActive: async () => ({ ack: "" }) };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0", "redis://h/1"], disagreement: "VALKEY_URL and the deployment pointer name two Valkeys" }) } });
  let deep = "leaf";
  for (let i = 0; i < 10; i += 1) deep = { d: deep };
  const nested = await c.act("cancel-active", { jobId: "gh-1", deep });
  assert.equal(nested.status, 400);
  assert.match(nested.json().error, /nested too deep or holds too much/);
  const notHeld = await c.act("cancel-held", { jobId: "gh-9" });
  assert.equal(notHeld.status, 400);
  assert.equal(notHeld.json().error, "job gh-9 is not among the held jobs as read now; nothing to cancel");
  const pause = (await c.act("fleet-pause", {})).json();
  assert.ok(pause.summary.includes("VALKEY_URL and the deployment pointer name two Valkeys: a pause reaches both"), JSON.stringify(pause.summary));
});

test("fleet-resume and queue-resume are paid: the preview counts the jobs waiting to start and says each reserves its own cap; the ticket and the row carry the count, no reserve", async () => {
  const { paths } = deployment();
  const queueCounts = [{ queue: "pi-jobs", paused: true, counts: { waiting: 0, paused: 2, delayed: 1, active: 4, failed: 9 } }, { queue: "pi-jobs@mini", paused: false, counts: { waiting: 5 } }];
  const fleet = {
    snapshot: async () => ({ queueCounts }),
    resume: async () => ({ results: [{ shown: "redis://h/0", res: { ok: true, queues: ["pi-jobs"] } }] }),
    pauseQueue: async () => ({ ok: true }),
  };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  const p = (await c.act("fleet-resume", {})).json();
  assert.equal(p.count, 3, "waiting, paused and delayed in the paused queues; active, failed and the running queue are not counted");
  assert.match(p.diffHtml, /3 job\(s\) wait to start in the paused queues \(pi-jobs\): each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up/);
  assert.equal(p.reserve, null, "no single reserve figure applies");
  assert.equal((await c.confirm("fleet-resume", p.ticket)).status, 200);
  const row = lastWrite(c);
  assert.deepEqual([row.kind, row.count, row.reserve], ["fleet-resume", 3, undefined]);
  const q = (await c.act("queue-resume", { queue: "pi-jobs" })).json();
  assert.equal(q.count, 3);
  assert.match(q.diffHtml, /3 job\(s\) wait to start in it \(pi-jobs\)/);
  assert.equal((await c.confirm("queue-resume", q.ticket)).status, 200);
  assert.deepEqual([lastWrite(c).kind, lastWrite(c).count], ["queue-resume", 3]);
  // A pause lets nothing start, so it counts nothing.
  queueCounts[0].paused = false;
  const qp = (await c.act("queue-pause", { queue: "pi-jobs" })).json();
  assert.equal(qp.count, undefined);
});

test("a refused ticket says ONE instruction: the ticket store's sentence, as it is", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const p = (await c.act("pause-window-delete", { index: 0 })).json();
  assert.equal((await c.confirm("pause-window-delete", p.ticket)).status, 200);
  const again = await c.confirm("pause-window-delete", p.ticket);
  assert.equal(again.status, 409);
  assert.equal(again.json().error, `this confirmation is not valid: it was already used, has expired, or was never issued. ${PREVIEW_AGAIN}`);
  const none = await c.post("/api/act/pause-window-delete/confirm", {}, { cookie: c.op });
  assert.equal(none.json().error, `no ticket was sent. ${PREVIEW_AGAIN}`);
});

test("every reserve estimate gets the worker's zero-rated inputs: a job that can only call a declared free local model previews $0, the full cap when the snapshot does not declare it", async () => {
  const { paths } = deployment();
  const job = { kind: "github", provider: "ollama", model: "qwen3", maxCostUsd: "1.5" };
  const local = { endpoints: [{ id: "ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: false }], models: { providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", models: [{ id: "qwen3" }] } } } };
  let snapshot = local;
  const seenArgs = [];
  const rm = {
    ...RM,
    planFailedBulk: async () => ({ jobs: [{ jobId: "gh-z", queue: "pi-jobs", attemptsMade: 1, finishedOn: 1 }], more: 0 }),
    planRerun: async (args) => (seenArgs.push(["rerun", args]), { refusal: "stop here" }),
    planParkedAnswer: async (args) => (seenArgs.push(["parked", args]), { refusal: "stop here" }),
  };
  const env = { PI_ALLOWED_MODELS: "ollama/qwen3" };
  const c = await start({ paths, a: { rm, env, modelEndpoints: () => snapshot, readJobsData: async ({ jobs }) => new Map(jobs.map((j) => [j.jobId, job])) } });
  const free = (await c.act("retry-failed", { jobId: "gh-z" })).json();
  assert.deepEqual(free.reserve, { slots: 1, dollarsMicros: 0, capMicros: 1_500_000, zeroRated: true });
  assert.match(free.diffHtml, /\$0\.00: every model it may call is zero-rated/);
  snapshot = { endpoints: [], models: null };
  assert.equal((await c.act("retry-failed", { jobId: "gh-z" })).json().reserve.dollarsMicros, 1_500_000, "not declared local: the full cap");
  snapshot = local;
  await c.act("rerun", { jobId: "gh-z" });
  await c.act("parked-answer", { jobId: "gh-z", text: "x" });
  for (const [which, args] of seenArgs) {
    assert.deepEqual(args.modelEndpoints, local, `${which} gets the endpoint snapshot`);
    assert.deepEqual(args.env, env, `${which} gets the deployment env`);
    assert.deepEqual(args.overlay, { maxTurns: 30, maxCostUsd: "2" }, `${which} gets the overlay`);
  }
  assert.equal(seenArgs.length, 2);
});

test("rerun and parked-answer previews show the forge run fields the plan takes from the trigger now, escaped, the secret profile by name only", async () => {
  const { paths } = deployment();
  const runFields = { flow: "fix", model: "anthropic/claude-x", models: ["a/b", "c/d"], maxCostUsd: "1.25", secretsProfile: "prod<b>", image: "ghcr.io/acme/img:1", backend: "docker" };
  const plan = (kind) => ({ plan: { kind, forge: "github", jobId: "gh-r", queue: "pi-jobs", replicas: 1, job: { flow: "fix", secrets: { T: "op://vault/secret-ref-canary" }, trigger: { comment: { body: "hi" } } }, runFields, reserve: { slots: 1, dollarsMicros: 1_250_000, capMicros: 1_250_000, zeroRated: false } } });
  const rm = { ...RM, planRerun: async () => plan("forge"), planParkedAnswer: async () => plan("parked-answer") };
  const c = await start({ paths, a: { rm } });
  const fields = "flow fix; model anthropic/claude-x; allowed models a/b, c/d; per-job cap $1.25; secret profile prod&lt;b&gt;; image ghcr.io/acme/img:1; backend docker";
  const re = (await c.act("rerun", { jobId: "gh-r" })).json();
  assert.ok(re.diffHtml.includes(`<li>It runs as its trigger says now: ${fields}</li>`), re.diffHtml);
  const pa = (await c.act("parked-answer", { jobId: "gh-r", text: "hi" })).json();
  assert.ok(pa.diffHtml.includes(`<li>It runs as the comment trigger says now: ${fields}</li>`), pa.diffHtml);
  for (const out of [re, pa]) assert.ok(!JSON.stringify(out).includes("op://"), "never a secret reference");
  // A model and cap the job leaves to the deployment say so.
  runFields.model = null;
  runFields.maxCostUsd = null;
  assert.match((await c.act("rerun", { jobId: "gh-r" })).json().diffHtml, /model the deployment&#39;s default; allowed models a\/b, c\/d; per-job cap the deployment&#39;s;/);
});

// ---- the large diff ------------------------------------------------------------------------------------------------

test("a one-line change in a 3000-line file previews small and shows the change; a diff past the cap is cut with a count", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  // Near the start (only the suffix is common), the middle, and near the end (only the prefix is common).
  for (const at of [5, 1500, 2990]) {
    const after = before.replace(`line ${at}\n`, `line ${at} changed\n`);
    const out = String(diffHtmlOf(before, after));
    assert.ok(out.length < 1000, `${at}: small, ${out.length} bytes`);
    assert.ok(out.includes(`<del>- line ${at}</del>\n<ins>+ line ${at} changed</ins>`), `${at}: the change`);
    assert.ok(out.includes(`<span>  line ${at - 2}</span>`), `${at}: with a little context`);
    assert.ok(!out.includes(`line ${at - 100}<`) && !out.includes(`line ${(at + 100) % 3000}<`), `${at}: and not the rest`);
  }
  const everyLine = Array.from({ length: 3000 }, (_, i) => `other ${i}`).join("\n");
  const big = String(diffHtmlOf(before, everyLine));
  assert.equal((big.match(/\n/g) ?? []).length, DIFF_LINES_MAX + 1, "the cap, then one line saying how many more");
  assert.match(big, /\.\.\. and 4000 more diff line\(s\), not shown/);
});

// ---- the browser script ----------------------------------------------------------------------------------------------

test("the script writes markup in exactly two places: the panel swap behind data-panel, and the preview into the form's OWN [data-preview]", () => {
  const writes = CONSOLE_SCRIPT.match(/[\w.]+\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/g) ?? [];
  assert.deepEqual(writes.map((w) => w.replace(/\s+/g, "")), ["area.innerHTML=", "el.innerHTML="]);
  assert.ok(!/form\.innerHTML/.test(CONSOLE_SCRIPT), "never the form itself");
  // `area` is bound once, to the submitted form's own preview element, and never reassigned.
  assert.deepEqual(CONSOLE_SCRIPT.match(/\barea\s*=(?!=)/g), ["area ="]);
  assert.match(CONSOLE_SCRIPT, /var area = form\.querySelector\("\[data-preview\]"\);\n\s+if \(!\/\^\[a-z0-9-\]\{1,40\}\$\/\.test\(action\) \|\| !area\) return;/);
  assert.match(CONSOLE_SCRIPT, /var form = ev\.target;\n\s+if \(!form \|\| !form\.matches \|\| !form\.matches\("form\[data-action\]"\)\) return;/);
  // The panel swap: only an element the server marked data-panel, and not while a form in it is in use.
  assert.match(CONSOLE_SCRIPT, /if \(!el \|\| !el\.hasAttribute\("data-panel"\)\) return;\n\s+if \(inUse\(el\)\) return;\n\s+el\.innerHTML = msg\.html;/);
});

// ---- the route guards over every action ------------------------------------------------------------------------------

test("every action route refuses a viewer 403, a read-only console 403, and a cross-site or form-encoded write 403, writing nothing", async () => {
  const { paths } = deployment();
  const before = Object.fromEntries(Object.entries(paths).filter(([, p]) => typeof p === "string" && existsSync(p) && !p.endsWith("logs")).map(([k, p]) => [k, read(p)]));
  const c = await start({ paths });
  const viewer = await c.cookieFor(VIEW_TOKEN);
  const ro = await start({ paths, readOnly: true });
  for (const a of ACTIONS) {
    for (const step of ["preview", "confirm"]) {
      const path = `/api/act/${a.name}/${step}`;
      const v = await c.post(path, { ticket: "x", index: 0 }, { cookie: viewer });
      assert.equal(v.status, 403, `${path} viewer`);
      assert.match(c.audit.rows.at(-1).reason, /^role: /);
      const r = await ro.post(path, { index: 0 }, { cookie: ro.op });
      assert.equal(r.status, 403, `${path} read-only`);
      const x = await c.post(path, { index: 0 }, { cookie: c.op, "sec-fetch-site": "cross-site" });
      assert.equal(x.status, 403, `${path} cross-site`);
      const f = await c.send({ path, headers: c.writeHeaders({ cookie: c.op, "content-type": "application/x-www-form-urlencoded" }), body: "index=0" });
      assert.equal(f.status, 403, `${path} form-encoded`);
    }
  }
  for (const [k, text] of Object.entries(before)) assert.equal(read(paths[k]), text, `${k} untouched`);
});

// ---- the pages' controls ----------------------------------------------------------------------------------------------

test("the controls: drawn for an operator, never for a viewer or on a read-only console; the sandbox command escaped or absent", () => {
  const snapshot = {
    queue: { pausedState: false },
    queueCounts: [{ queue: "pi-jobs", paused: false, counts: {} }],
    active: [{ jobId: "gh-1", queue: "pi-jobs", startedAt: 1 }],
    held: { rows: [{ jobId: "gh-2", target: "o/r#1", label: "jira", waitedMs: 5 }] },
    failed: { rows: [{ jobId: "gh-3", queue: "pi-jobs", attemptsMade: 1, endedAt: 1 }] },
    parked: [{ jobId: "gh-4", kind: "github", target: "o/r#2", parkedAt: 1, ageMs: 1 }],
    triggers: { triggers: [] },
  };
  const panels = [fleetQueues, fleetActive, fleetHeld, fleetFailed, parkedInbox, configTriggers];
  const view = (role, readOnly = false) => ({ data: { snapshot, now: 10 }, role, readOnly, env: {}, now: 10, query: {} });
  for (const render of panels) {
    assert.match(String(render(view("operator"))), /data-action="/, `${render.name || "panel"} has controls for an operator`);
    assert.ok(!String(render(view("viewer"))).includes("data-action"), "none for a viewer");
    assert.ok(!String(render(view("operator", true))).includes("data-action"), "none on a read-only console");
  }
  const run = (jobId, role = "operator", readOnly = false) => String(runSummary({ data: { run: { record: { jobId, startedAt: null } } }, role, readOnly, env: {}, now: 0, query: {} }));
  assert.match(run("repeat:nightly:1760500000000"), /<code class="mono">pi-dispatch sandbox repeat:nightly:1760500000000<\/code>/);
  assert.match(run("gh-1"), /data-action="rerun"/);
  const hostile = run(`gh-<script>"x`);
  assert.ok(!hostile.includes("pi-dispatch sandbox") && !hostile.includes("data-action"), "an id outside the charset gets neither");
  assert.ok(!hostile.includes("<script>"));
  assert.ok(!run("gh-1", "viewer").includes("sandbox"), "a viewer sees no sandbox command");
  const ro = run("gh-1", "operator", true);
  assert.ok(ro.includes("pi-dispatch sandbox gh-1") && !ro.includes("data-action"), "read-only: the command to copy, no re-run control");
});

// ---- BullMQ-backed actions on database 13 ------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(25);
  }
}
async function freshValkey() {
  const redis = makeRedisClient(URL13);
  await redis.flushdb();
  const opened = [];
  const q = async (name) => {
    const queue = makeQueue(parseConnection(URL13, { failFast: true }), { name });
    opened.push(queue);
    await until(async () => (await redis.exists(`bull:${name}:meta`)) === 1);
    return queue;
  };
  return {
    redis,
    q,
    async done() {
      for (const queue of opened) await queue.close().catch(() => {});
      await redis.flushdb().catch(() => {});
      redis.disconnect();
    },
  };
}
async function makeFailed(v, name, jobs) {
  const { Worker } = await import("bullmq");
  const queue = await v.q(name);
  for (const j of jobs) await queue.add(j.data.kind ?? "x", j.data, { jobId: j.id, attempts: 1 });
  const worker = new Worker(name, async () => {
    throw new Error("boom");
  }, { connection: parseConnection(URL13) });
  await until(async () => (await queue.getJobCounts("failed")).failed === jobs.length);
  await worker.close();
  return queue;
}
function writeRecord(logsDir, record) {
  writeFileSync(join(logsDir, `${sanitizeJobId(record.jobId)}.json`), JSON.stringify(record));
}

test("retry-failed on Valkey: the preview shows the worker's reserve from the job's data; the confirm retries it and the row holds the reserve", live, async () => {
  const v = await freshValkey();
  try {
    const shared = await makeFailed(v, "pi-jobs", [{ id: "gh-f1", data: { kind: "github", repo: "o/r", maxCostUsd: "1.5", target: { type: "issue", number: 1 } } }]);
    const { paths } = deployment(URL13);
    const c = await start({ paths });
    const p = (await c.act("retry-failed", { jobId: "gh-f1", queue: "pi-jobs" })).json();
    assert.deepEqual(p.reserve, RM.estimateReserve({ kind: "github", repo: "o/r", maxCostUsd: "1.5", target: { type: "issue", number: 1 } }, { overlay: { maxTurns: 30, maxCostUsd: "2" }, env: {} }));
    assert.equal(p.reserve.dollarsMicros, 1_500_000);
    assert.match(p.diffHtml, /\$1\.50 \(the per-job cap\)/);
    const res = await c.confirm("retry-failed", p.ticket);
    assert.equal(res.status, 200, res.text);
    assert.equal(await (await shared.getJob("gh-f1")).getState(), "waiting");
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.target, row.reserve], ["failed-retry", "gh-f1", 1_500_000]);
  } finally {
    await v.done();
  }
});

test("remove-all-failed on Valkey: a job that changed between preview and confirm is reported and audited per job; the rest go", live, async () => {
  const v = await freshValkey();
  try {
    const shared = await makeFailed(v, "pi-jobs", [{ id: "gh-a", data: { kind: "github", repo: "o/a" } }, { id: "gh-b", data: { kind: "github", repo: "o/b" } }]);
    const { paths } = deployment(URL13);
    const c = await start({ paths });
    const p = (await c.act("remove-all-failed", {})).json();
    assert.deepEqual(p.targets.map((t) => t.jobId).sort(), ["gh-a", "gh-b"]);
    await (await shared.getJob("gh-b")).retry("failed");
    const res = await c.confirm("remove-all-failed", p.ticket);
    assert.equal(res.status, 200, res.text);
    const byId = Object.fromEntries(res.json().results.map((r) => [r.jobId, r]));
    assert.equal(byId["gh-a"].ok, true);
    assert.equal(byId["gh-b"].ok, false);
    assert.match(byId["gh-b"].reason, /changed since the preview/);
    assert.equal(await shared.getJob("gh-a"), undefined);
    assert.equal(await (await shared.getJob("gh-b")).getState(), "waiting", "the changed one is left as the other hand made it");
    const rows = c.audit.rows.filter((r) => r.kind === "failed-remove-all");
    assert.deepEqual(rows.map((r) => [r.target, r.outcome, r.count]).sort(), [["gh-a", "ok", 2], ["gh-b", "failed", 2], ["gh-b", "ok", 2]]);
  } finally {
    await v.done();
  }
});

test("queue-pause, cancel-held and cancel-all-held on Valkey, through the real fleet reader", live, async () => {
  const v = await freshValkey();
  const { paths } = deployment(URL13);
  const fleet = RM.createFleetReader(paths, { readOnly: true, activeLimit: 50 });
  try {
    const shared = await v.q("pi-jobs");
    for (const id of ["gh-h1", "gh-h2"]) {
      await shared.add("github", { kind: "github" }, { jobId: id, delay: 3_600_000 });
      await v.redis.hset(`wait:job:${id}`, { since: String(Date.now()), target: "o/r#1", label: "jira" });
      await v.redis.sadd("wait:held", id);
    }
    const c = await start({ paths, a: { fleet } });
    const pause = await c.both("queue-pause", { queue: "pi-jobs" });
    assert.equal(pause.confirm.status, 200, pause.confirm.text);
    assert.equal(await shared.isPaused(), true);
    assert.match((await c.act("queue-pause", { queue: "pi-jobs" })).json().summary[0], /already paused/);
    assert.match((await c.act("queue-resume", { queue: "pi-jobs@ghost" })).json().error, /not a queue this deployment drains/);
    const one = await c.both("cancel-held", { jobId: "gh-h1" });
    assert.equal(one.confirm.status, 200, one.confirm.text);
    assert.equal(await shared.getJob("gh-h1"), undefined);
    const all = (await c.act("cancel-all-held", {})).json();
    assert.deepEqual(all.targets.map((t) => t.jobId), ["gh-h2"]);
    const res = await c.confirm("cancel-all-held", all.ticket);
    assert.equal(res.json().done, 1);
    assert.equal(await shared.getJob("gh-h2"), undefined);
  } finally {
    await fleet.dispose();
    await v.done();
  }
});

test("rerun on Valkey: the preview shows the reserve; the confirm queues the rebuilt job; the semantic window answers 409", live, async () => {
  const v = await freshValkey();
  try {
    const { paths } = deployment(URL13);
    // A forge re-run takes WHAT RUNS from the trigger as the file says now (job-actions' planRerun), so the trigger that
    // matched must still be there and still run this flow; its cap is the re-run's.
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", maxCostUsd: "1.25" } }] }));
    const shared = await v.q("pi-jobs");
    const original = { repo: "org/repo", target: { type: "issue", number: 7, title: "T", body: "B" }, flow: "fix", maxCostUsd: "9", trigger: { event: "issues", action: "labeled", deliveryId: "orig-1", sender: { id: 9 }, matched: { index: 0, type: "label", label: "pi" } } };
    const { jobId } = await enqueueForgeJob(shared, "github", original);
    writeRecord(paths.logsDir, { jobId, kind: "github", target: "org/repo#7", outcome: "failed", reason: "exit-1" });
    const c = await start({ paths });
    const p = (await c.act("rerun", { jobId })).json();
    assert.equal(p.reserve.dollarsMicros, 1_250_000);
    assert.match(p.diffHtml, /Reserve:<\/strong> It holds 1 job slot and \$1\.25/);
    assert.match(p.diffHtml, /It runs as its trigger says now: flow fix; model the deployment&#39;s default; per-job cap \$1\.25/, "the run fields the plan took from the trigger, not the retained job's $9");
    const swallowed = await c.confirm("rerun", p.ticket);
    assert.equal(swallowed.status, 409);
    assert.match(swallowed.json().error, /semantic window/);
    await shared.removeDeduplicationKey("org/repo#7:fix");
    const p2 = (await c.act("rerun", { jobId })).json();
    const ok = await c.confirm("rerun", p2.ticket);
    assert.equal(ok.status, 200, ok.text);
    const queued = await shared.getJob(ok.json().jobId);
    assert.equal(queued.data.flow, "fix");
    assert.match(queued.data.trigger.deliveryId, /^console-[0-9a-f]{16}$/);
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.target, row.reserve, row.outcome], ["run-rerun", jobId, 1_250_000, "ok"]);
  } finally {
    await v.done();
  }
});

test("parked-answer on Valkey: the queued job is the plan's, by the session's token name; the row holds the answer's sha256, never its text", live, async () => {
  const v = await freshValkey();
  try {
    const { paths } = deployment(URL13);
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", resume: true, awaitInput: true } }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", resume: true, awaitInput: true, maxCostUsd: "1.25" } }] }));
    const shared = await v.q("pi-jobs");
    const parked = { repo: "org/repo", target: { type: "issue", number: 7, title: "Flaky", body: "B" }, flow: "fix", resume: true, awaitInput: true, trigger: { event: "issues", action: "labeled", deliveryId: "p-1", sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi" } } };
    const { jobId } = await enqueueForgeJob(shared, "github", parked);
    await shared.removeDeduplicationKey("org/repo#7:fix");
    writeRecord(paths.logsDir, { jobId, kind: "github", target: "org/repo#7", outcome: "completed", reason: "awaiting-input", endedAt: new Date(T0 - 3_600_000).toISOString() });
    const c = await start({ paths });
    const p = await c.act("parked-answer", { jobId, text: `${ANSWER}\n<b>bold</b>`, by: "mallory" });
    assert.equal(p.status, 200, p.text);
    const pj = p.json();
    assert.equal(pj.reserve.dollarsMicros, 1_250_000, "a paid action shows its reserve");
    assert.ok(pj.diffHtml.includes("&lt;b&gt;bold&lt;/b&gt;"), "the answer is shown escaped");
    assert.equal(pj.afterDigest, sha256(`${ANSWER}\n<b>bold</b>`));
    const res = await c.confirm("parked-answer", pj.ticket);
    assert.equal(res.status, 200, res.text);
    const [queuedId] = res.json().jobIds;
    assert.equal(queuedId, forgeDeliveryJobId("github", (await shared.getJob(queuedId)).data.trigger.deliveryId));
    const job = (await shared.getJob(queuedId)).data;
    assert.deepEqual(job.console, { by: "alice" }, "by is the session's token name, whatever the body said");
    assert.equal(job.trigger.comment.body, `${ANSWER}\n<b>bold</b>`);
    // The queued job is the plan's: a plan built the same way now differs only in its fresh delivery id.
    const again = await RM.planParkedAnswer({ url: URL13, logsDir: paths.logsDir, jobId, text: `${ANSWER}\n<b>bold</b>`, by: "alice", triggersPath: paths.triggersPath, runsFn: async () => [] });
    // `kind` is the producer's (enqueueForgeJob stamps it on the queued data), not the plan's.
    const strip = ({ kind: _k, ...d }) => ({ ...d, trigger: { ...d.trigger, deliveryId: null } });
    assert.deepEqual(strip(job), strip(again.plan.job));
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.target, row.afterDigest, row.reserve], ["parked-answer", jobId, sha256(`${ANSWER}\n<b>bold</b>`), 1_250_000]);
  } finally {
    await v.done();
  }
});

// ---- the canary, last ----------------------------------------------------------------------------------------------

test("leak canary: no audit row or log line carries a token, the answer text or a secret reference; every audit chain verifies", () => {
  assert.ok(seen.audit.length > 20 && seen.logs.length > 20, "the canary saw real traffic");
  for (const [kind, list] of Object.entries({ audit: seen.audit, logs: seen.logs })) {
    for (const text of list) for (const needle of [OP_TOKEN, VIEW_TOKEN, "pdc_", "answer-canary", "secret-ref-canary", "secret-pass"]) assert.ok(!text.includes(needle), `${kind} carries ${needle.slice(0, 6)}: ${text.slice(0, 120)}`);
  }
  for (const body of seen.bodies) for (const needle of [OP_TOKEN, VIEW_TOKEN, "secret-ref-canary", "secret-pass"]) assert.ok(!body.includes(needle), `a response carries ${needle.slice(0, 6)}`);
  for (const dir of logsDirs) {
    const v = verifyConsoleAudit({ logsDir: dir });
    assert.ok(v.ok, `${dir}: ${JSON.stringify(v.broken ?? {})}`);
  }
});
