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
import { DEFER_BUCKET_WORDS, DEFER_TIME_MAX_MS, DEFER_WHYS } from "@edgehero/pi-dispatch/defer-reasons";
import { enqueueForgeJob, forgeDeliveryJobId, makeQueue } from "@edgehero/pi-dispatch/queue";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { closeInbox, markState, readInbox, registerLive } from "@edgehero/pi-dispatch/steer-inbox";
import { ACTIONS, atIndex, AUDIT_FAILED, BULK_MAX, CANCEL_TIMEOUT_SENTENCE, capturingAudit, confirmAction, DIFF_LINES_MAX, diffHtmlOf, dryRunFs, lineDiff, PREVIEW_AGAIN, previewAction, reserveText, queueUnreadRefusal, RESUME_WAITING_UNKNOWN, resumeManyUndo, SNAPSHOT_TIMEOUT_MS, SNAPSHOT_TIMEOUT_SENTENCE, SNAPSHOT_UNREAD_SENTENCE, SWITCH_QUEUES_NAMED, SWITCH_SHORT_LINES, switchReadLine, textHtml, TRIGGER_FORM, UNDO_SENTENCES, VALKEY_UNREACHABLE, waitingLine } from "../src/console/actions.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { CONFIRM_SLOT_ID, doneBannerHtml, PARTIAL_NOTE } from "../src/console/confirm-view.mjs";
import { html } from "../src/console/html.mjs";
import { fieldNamed, UNNAMED_FIELD } from "../src/words.mjs";
import { FLASH_MAX_BYTES } from "../src/console/sessions.mjs";
import { makeLoginLimiter } from "../src/console/guards.mjs";
import { readJobsData } from "../src/console/job-data.mjs";
import { fleetActive, fleetFailed, fleetHeld, fleetQueues, configTriggers, parkedQuestions, runSummary, runActionsPanel } from "../src/console/panels.mjs";
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
// The message the steer test sends into a running job (issue #646): the same rule, it reaches the inbox and nothing else.
const STEER_TEXT = "stop and run the migrations first, steer-canary-2d9a";

const BASE = process.env.VALKEY_TEST_URL;
const URL13 = BASE
  ? (() => {
      const u = new URL(BASE);
      u.pathname = "/13";
      return u.toString();
    })()
  : null;
const live = { skip: URL13 ? false : "needs VALKEY_TEST_URL", timeout: 60_000 };

const seen = { logs: [], audit: [], bodies: [], previewed: new Set() };

/**
 * An arrow, ASCII or Unicode, as text or as the page's escape of it (issue #737): a bar's lines and a confirm's
 * words say a change or a mapping in words ("maxTurns: 30 to 40", "dev: /opt/d.sh"), never an arrow. The Unicode ranges
 * are the Arrows block, the dingbat arrows, Supplemental Arrows A and B and the arrows of Miscellaneous Symbols and Arrows.
 */
const ARROW_RE = /-(?:>|&gt;)|(?:<|&lt;)-|=(?:>|&gt;)|[\u2190-\u21ff\u2794-\u27bf\u27f0-\u27ff\u2900-\u297f\u2b00-\u2bff]/;

/**
 * The copy rules every preview answer a test here gets is held to, whatever the test asserts besides (issue #737): the
 * words it says (its `summary`, its `error`, and its bar outside the diff, which shows the file's own bytes and so is
 * not the console's words) hold no arrow, and the bar draws no empty list item (a blank planner line is a
 * paragraph break in the pi panel's dialog, never a bullet in a list). The action is counted, so the last test can
 * hold that every action's preview met these rules at least once.
 */
function heldToCopyRules(name, res) {
  let j;
  try {
    j = res.json();
  } catch {
    return;
  }
  seen.previewed.add(name);
  const bar = typeof j.html === "string" ? j.html.replace(/<div class="diff">[^]*?<\/div><\/div>/g, "") : "";
  const said = [...(Array.isArray(j.summary) ? j.summary : []), String(j.error ?? ""), bar].map(String);
  if (Object.hasOwn(ARROW_PENDING, name) && res.status === 200) assert.ok(said.some((t) => ARROW_RE.test(t)), `${name} draws no arrow any more: take it out of ARROW_PENDING`);
  else for (const text of said) assert.doesNotMatch(text, ARROW_RE, `${name}: words, never an arrow: ${text}`);
  assert.doesNotMatch(bar, /<li>\s*<\/li>/, `${name}: no empty list item: ${bar}`);
}

/**
 * The actions whose bar still draws an arrow, and why, a ratchet that only shrinks (`write-plans.test.mjs` holds the
 * planner's twin): a preview of one must still show one, so the entry goes once it is fixed.
 */
const ARROW_PENDING = Object.freeze({});
const logsDirs = [];

let sessionCount = 0;
/**
 * The session store's surface as the server and the actions call it (issue #737 added `verdict`, `endedOf`,
 * `destroy(id, reason)` and the flash), on a Map. `flashes` records every `setFlash` in order, so a test can hold what a
 * write left for the session's next page; `setFlash` copies through JSON and refuses past `FLASH_MAX_BYTES`, as the
 * real store does.
 */
function fakeSessions() {
  const liveSessions = new Map();
  const flash = new Map();
  const flashes = [];
  return {
    flashes,
    create({ name, role, tokenHash }) {
      sessionCount += 1;
      const id = `s${String(sessionCount).padStart(42, "0")}`;
      liveSessions.set(id, { id, name, role, tokenHash });
      return { id };
    },
    get: (id) => (liveSessions.has(id) ? { ...liveSessions.get(id) } : null),
    peek: (id) => (liveSessions.has(id) ? { ...liveSessions.get(id) } : null),
    verdict: (id) => (liveSessions.has(id) ? { session: { ...liveSessions.get(id) } } : { ended: null }),
    endedOf: () => null,
    destroy: (id) => {
      flash.delete(id);
      return liveSessions.delete(id);
    },
    setFlash(id, change) {
      const text = JSON.stringify(change);
      if (!liveSessions.has(id) || Buffer.byteLength(text, "utf8") > FLASH_MAX_BYTES) return false;
      flashes.push({ id, change: JSON.parse(text) });
      flash.set(id, JSON.parse(text));
      return true;
    },
    takeFlash(id) {
      const f = flash.get(id) ?? null;
      flash.delete(id);
      return f;
    },
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
  const sessions = fakeSessions();
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly, maxMs: 12 * 3600000, pauseWindowsPath: paths.pauseWindowsPath, dir: null },
    now,
    audit,
    sessions,
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
    heldToCopyRules(name, preview);
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
  return { server, audit, sessions, post, op, cookieFor, act, confirm, both, advance: (ms) => (t += ms), writeHeaders, send };
}

const read = (p) => readFileSync(p, "utf8");
const lastWrite = (c) => c.audit.rows.filter((r) => r.action === "write").at(-1);
/** A sentence as the page's markup escapes it (the console's own `html`). */
const esc = (s) => String(html`${s}`);

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
    "cancel-queued": "cancel-queued",
    "retry-failed": "failed-retry",
    "remove-failed": "failed-remove",
    "retry-all-failed": "failed-retry-all",
    "remove-all-failed": "failed-remove-all",
    "run-fork": "run-fork",
    rerun: "run-rerun",
    "parked-answer": "parked-answer",
    steer: "steer",
    "steer-withdraw": "steer-withdraw",
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
    "secret-bundle-add": "secret-bundle-add",
    "secret-bundle-remove": "secret-bundle-remove",
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
  assert.deepEqual(ACTIONS.filter((a) => a.paid).map((a) => a.name).sort(), ["fleet-resume", "parked-answer", "queue-resume", "rerun", "retry-all-failed", "retry-failed", "run-fork", "steer"]);
  assert.deepEqual(ACTIONS.filter((a) => a.bulk).map((a) => a.name).sort(), ["cancel-all-held", "remove-all-failed", "retry-all-failed"]);
  assert.equal(BULK_MAX, RM.BULK_MAX, "the console's bulk bound is job-actions' own");
});

// Issue #737: every write carries the rules its bar and its banner read. Iterated over ACTIONS, so a new action that
// lacks one fails here before any page offers it.
test("every action has frozen fields, a danger flag never beside paid, and its undo, inverse and confirm label", () => {
  const pause = ["scope", "from", "to", "tz", "days", "dateFrom", "dateTo"];
  const FIELDS = {
    "cancel-active": ["jobId"], "cancel-held": ["jobId"], "cancel-all-held": [], "cancel-queued": ["jobId", "queue"],
    "retry-failed": ["jobId", "queue"], "remove-failed": ["jobId", "queue"], "retry-all-failed": ["queue", "repo"], "remove-all-failed": ["queue", "repo"],
    "run-fork": ["jobId", "entry", "position", "point", "provider", "model", "thinking", "message"],
    rerun: ["jobId"], "parked-answer": ["jobId", "text"], steer: ["jobId", "mode", "text"], "steer-withdraw": ["jobId", "id"],
    "fleet-pause": [], "fleet-resume": [], "queue-pause": ["queue"], "queue-resume": ["queue"],
    "pause-windows": ["windows"], "trigger-add": ["trigger"], "trigger-edit": ["index", "flow", "backend", "provider", "model"], "trigger-delete": ["index"],
    "setting-set": ["key", "value"], "setting-unset": ["key"],
    "secret-profile-add": ["name", "path"], "secret-profile-remove": ["name"], "secret-bundle-add": ["name", "path", "format"], "secret-bundle-remove": ["name"],
    "pause-window-add": pause, "pause-window-edit": ["index", ...pause], "pause-window-delete": ["index"],
    "limit-add": ["limit"], "limit-edit": ["index", "limit"], "limit-delete": ["index"],
    "project-add": ["id", "name", "members"], "project-edit": ["id", "name", "members"], "project-delete": ["id"],
    "envelope-set": ["envelope"], "priorities-set": ["projects", "validDays"], "allocation-revert": ["index"],
  };
  assert.equal(ACTIONS.length, 39);
  assert.deepEqual(Object.keys(FIELDS).sort(), ACTIONS.map((a) => a.name).sort());
  for (const a of ACTIONS) {
    assert.ok(Object.isFrozen(a.fields) && a.fields.every((f) => typeof f === "string"), `${a.name}: fields is a frozen list of names`);
    assert.deepEqual([...a.fields], FIELDS[a.name], `${a.name}: fields`);
    assert.ok(!a.fields.includes("ticket"), `${a.name}: the ticket is the confirm's, never a preview field`);
    assert.equal(typeof a.danger, "boolean", `${a.name}: danger`);
    assert.ok(!(a.danger && a.paid), `${a.name}: paid or destructive, never both`);
    // Issue #737: every one of the 38 says what it did, for the banner after the write.
    for (const fn of ["undo", "inverse", "confirmLabel", "done"]) assert.equal(typeof a[fn], "function", `${a.name}: ${fn}`);
  }
  assert.deepEqual(ACTIONS.filter((a) => a.danger).map((a) => a.name).sort(), ["cancel-active", "cancel-all-held", "cancel-held", "cancel-queued", "fleet-pause", "limit-delete", "pause-window-delete", "project-delete", "queue-pause", "remove-all-failed", "remove-failed", "secret-bundle-remove", "secret-profile-remove", "trigger-delete"]);
  assert.ok(Object.isFrozen(UNDO_SENTENCES));
  for (const [k, v] of Object.entries(UNDO_SENTENCES)) assert.match(v, /^[A-Z][^]*\.$/, `${k}: a sentence`);
});

// Issue #737: every action's rules over the preview's own shapes, each sentence and label as a
// literal, so a reworded Undo, a dropped inverse or a label that says "$0.00" fails here by name. `undo` is `[bar,
// banner]` (one sentence twice where the bar's does not point at the preview); `done` is the banner's title.
test("each action's Undo, inverse, confirm label and banner title, as literals over the preview's own shapes", () => {
  // The Undo sentences themselves, word for word: a ledger's absent row reads one of these as what a person sees.
  assert.deepEqual({ ...UNDO_SENTENCES }, {
    delete: "Add the removed lines back: copy them from this preview; the console keeps no copy.",
    deleteAfter: "Add the removed lines back by hand: the console kept no copy of them.",
    deleteSecrets: "Add the removed trigger back: copy it from this preview and its secret references from your own copy of the file, since the preview does not show them; the console keeps no copy.",
    deleteSecretsAfter: "Add the removed trigger back by hand, with its secret references, from your own copy of the file: the console kept no copy of it.",
    retried: "A retried job keeps the attempts it made, so the console does not remove it from its queue; once it runs, Cancel stops it.",
    rerunBefore: "Cancel the new run before it starts: the banner after it is queued offers it.",
    rerunUnnamed: "The console could not name the run it queued, so this banner offers no Undo.",
    cancelled: "A cancelled run stays cancelled; re-run it from its run page (a re-run is paid).",
    held: "The job leaves its queue; a redelivery of the same event queues it again.",
    cancelledQueued: "The job leaves its queue before it starts; a redelivery of the same event, or its trigger's next fire, queues it again.",
    removed: "The queue's copy is gone; the run records its attempts wrote stay.",
    answer: "The answer is queued, and the worker posts it once the job passes its checks.",
    withdrawn: "Send the message again if you still mean it.",
    allocation: "Revert it from the allocation history, which keeps the split before it.",
    envelope: "Set it back with the envelope form: this preview's diff shows the old values; the console keeps no copy.",
    envelopeAfter: "Set it back with the envelope form: the console kept no copy of the old values.",
    tooBig: "Put the previous list back by hand: this preview showed it; the console keeps no copy.",
    tooBigAfter: "Put the previous list back by hand: the console kept no copy of it.",
    resumeUnread: "Pause the queues that were paused again by hand: the fleet was not read before the resume, so which they were is not known.",
    resumeShort: "Pause the queues that were paused again by hand: not every queue was read before the resume, so which they were is not fully known.",
  });
  for (const [k, v] of Object.entries(UNDO_SENTENCES)) assert.ok(!/^Cannot be undone/.test(v), `${k}: the bar says "No undo:" before it`);
  const U = UNDO_SENTENCES;
  const twice = (s) => [s, s];
  const DEL = [U.delete, U.deleteAfter];
  const id = "a".repeat(32);
  const json = (v) => JSON.stringify(v);
  const r = (dollars) => ({ slots: 1, dollarsMicros: dollars, capMicros: dollars, zeroRated: false });
  const zero = { slots: 1, dollarsMicros: 0, capMicros: 1_500_000, zeroRated: true };
  const uncapped = { slots: 1, dollarsMicros: null, zeroRated: false };
  const bulk = (reserves, payload = {}) => ({ targets: reserves.map((reserve, i) => ({ jobId: `gh-${i}`, reserve })), reserve: { bulk: true, slots: reserves.length, dollarsMicros: reserves.reduce((n, x) => n + (Number.isSafeInteger(x?.dollarsMicros) && !x.unknown ? x.dollarsMicros : 0), 0), unknown: reserves.filter((x) => !x || x.unknown).length }, payload });
  const windows = { scope: "*", from: "01:00", to: "02:00", tz: "UTC" };
  // [action, out, undo, inverse (or null), label, done, done's result for a bulk act]
  const rows = [
    ["run-fork", { target: "gh-f", reserve: r(2_000_000) }, twice(U.rerunBefore), null, "Fork for up to $2.00", "Queued a fork of gh-f"],
    ["cancel-active", { payload: { jobId: "gh-1" } }, twice(U.cancelled), null, "Cancel the run", "Cancelled running job gh-1"],
    ["cancel-held", { payload: { jobId: "gh-2" } }, twice(U.held), null, "Cancel the held job", "Cancelled held job gh-2"],
    ["cancel-all-held", bulk([null, null]), twice(U.held), null, "Cancel 2 held jobs", "Cancelled 2 held jobs", { done: 2, count: 2 }],
    ["cancel-all-held", bulk([null, null]), twice(U.held), null, "Cancel 2 held jobs", "Cancelled held jobs: 1 of 2 done", { done: 1, count: 2 }],
    ["cancel-all-held", bulk([null]), twice(U.held), null, "Cancel 1 held job", "Cancelled 1 held job", { done: 1, count: 1 }],
    ["retry-failed", { payload: { jobId: "gh-5d10" }, reserve: r(1_500_000) }, twice(U.retried), null, "Retry for up to $1.50", "Retried failed job gh-5d10"],
    ["retry-failed", { payload: { jobId: "gh-5d10" }, reserve: zero }, twice(U.retried), null, "Retry (zero-rated)", "Retried failed job gh-5d10"],
    ["retry-failed", { payload: { jobId: "gh-5d10" }, reserve: { unknown: true } }, twice(U.retried), null, "Retry (reserve unknown)", "Retried failed job gh-5d10"],
    ["retry-failed", { payload: { jobId: "gh-5d10" }, reserve: uncapped }, twice(U.retried), null, "Retry, 1 job slot", "Retried failed job gh-5d10"],
    ["cancel-queued", { payload: { jobId: "gh-q1", queue: "pi-jobs" } }, twice(U.cancelledQueued), null, "Cancel the queued job", "Cancelled queued job gh-q1"],
    ["remove-failed", { payload: { jobId: "gh-5d10" } }, twice(U.removed), null, "Remove the job", "Removed failed job gh-5d10"],
    ["retry-all-failed", bulk([r(1_500_000), r(1_500_000)], { queue: "pi-jobs" }), twice(U.retried), null, "Retry 2 for up to $3.00", "Retried 2 failed jobs in pi-jobs", { done: 2, count: 2 }],
    ["retry-all-failed", bulk([r(1_500_000), { unknown: true }], { repo: "acme/web" }), twice(U.retried), null, "Retry 2, at least $1.50", "Retried failed jobs for acme/web: 1 of 2 done", { done: 1, count: 2 }],
    ["retry-all-failed", bulk([{ unknown: true }, { unknown: true }]), twice(U.retried), null, "Retry 2 (reserve unknown)", "Retried 2 failed jobs", { done: 2, count: 2 }],
    // A zero-rated or uncapped list holds no dollars: words, never "$0.00", and never the count twice ("3, 3 job slots").
    ["retry-all-failed", bulk([zero, zero, zero]), twice(U.retried), null, "Retry 3 (zero-rated)", "Retried 3 failed jobs", { done: 3, count: 3 }],
    ["retry-all-failed", bulk([uncapped, uncapped, uncapped]), twice(U.retried), null, "Retry 3, no dollar reserve", "Retried 3 failed jobs", { done: 3, count: 3 }],
    ["retry-all-failed", bulk([zero, uncapped, r(0)]), twice(U.retried), null, "Retry 3, no dollar reserve", "Retried 3 failed jobs", { done: 3, count: 3 }],
    ["remove-all-failed", bulk([null, null], { queue: "pi-jobs" }), twice(U.removed), null, "Remove 2 jobs", "Removed failed jobs in pi-jobs: 1 of 2 done", { done: 1, count: 2 }],
    ["remove-all-failed", bulk([null]), twice(U.removed), null, "Remove 1 job", "Removed 1 failed job", { done: 1, count: 1 }],
    ["rerun", { target: "gh-r", reserve: r(2_000_000) }, twice(U.rerunBefore), null, "Re-run for up to $2.00", "Queued a re-run of gh-r"],
    ["rerun", { target: "gh-r", reserve: zero }, twice(U.rerunBefore), null, "Re-run (zero-rated)", "Queued a re-run of gh-r"],
    ["parked-answer", { target: "gh-p", reserve: r(2_000_000) }, twice(U.answer), null, "Answer for up to $2.00", "Answered parked run gh-p"],
    ["steer", { payload: { plan: { id, jobId: "gh-s", mode: "steer" } } }, twice(`Withdraw message ${id} before the agent reads it`), { action: "steer-withdraw", body: { jobId: "gh-s", id } }, "Send", "Sent a steer to running job gh-s"],
    ["steer", { payload: { plan: { id, jobId: "gh-s", mode: "followUp" } } }, twice(`Withdraw message ${id} before the agent reads it`), { action: "steer-withdraw", body: { jobId: "gh-s", id } }, "Send follow-up", "Sent a follow-up to running job gh-s"],
    ["steer-withdraw", { payload: { plan: { id, jobId: "gh-s" } } }, twice(U.withdrawn), null, "Confirm", `Withdrew message ${id} from job gh-s`],
    ["fleet-pause", { payload: {} }, twice("Resume the fleet"), { action: "fleet-resume", body: {} }, "Pause the fleet", "Paused the fleet"],
    // A resume's way back is exactly what was paused before it: the whole fleet, one queue, or a set no write carries.
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 3, paused: ["pi-jobs", "pi-jobs@alpha", "pi-jobs@beta"] } }, twice("Pause the fleet again"), { action: "fleet-pause", body: {} }, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 3, paused: ["pi-jobs@beta"] } }, twice("Pause queue pi-jobs@beta again"), { action: "queue-pause", body: { queue: "pi-jobs@beta" } }, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 7, paused: ["pi-jobs@alpha", "pi-jobs@beta"] } }, twice("Pause queues pi-jobs@alpha, pi-jobs@beta again by hand, one at a time: no single write pauses only those."), null, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 3, paused: [] } }, twice("No queue of the fleet was paused, so there is nothing to pause again."), null, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {}, pausedBefore: null }, twice(U.resumeUnread), null, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {} }, twice(U.resumeUnread), null, "Resume", "Resumed the fleet"],
    // A short read (the queue scan did not finish, or more queues than a preview reads) saw part of the set: by hand,
    // even where every queue it read was paused, or only one.
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 3, paused: ["pi-jobs", "pi-jobs@alpha", "pi-jobs@beta"], short: true } }, twice(U.resumeShort), null, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 3, paused: ["pi-jobs@beta"], short: true } }, twice(U.resumeShort), null, "Resume", "Resumed the fleet"],
    // Past SWITCH_QUEUES_NAMED paused queues no sentence names them all: by hand, and the banner says no list was kept.
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 40, paused: Array.from({ length: 21 }, (_, i) => `pi-jobs@h${i}`) } }, ["Pause the 21 queues that were paused again by hand, one at a time: no single write pauses only those, and this preview names only the first 20.", "Pause the 21 queues that were paused again by hand, one at a time: no single write pauses only those, and the console kept no list of them."], null, "Resume", "Resumed the fleet"],
    ["fleet-resume", { payload: {}, pausedBefore: { queues: 40, paused: Array.from({ length: 20 }, (_, i) => `pi-jobs@h${i}`) } }, twice(`Pause queues ${Array.from({ length: 20 }, (_, i) => `pi-jobs@h${i}`).join(", ")} again by hand, one at a time: no single write pauses only those.`), null, "Resume", "Resumed the fleet"],
    ["queue-pause", { payload: { queue: "pi-jobs" } }, twice("Resume queue pi-jobs"), { action: "queue-resume", body: { queue: "pi-jobs" } }, "Pause queue pi-jobs", "Paused queue pi-jobs"],
    ["queue-resume", { payload: { queue: "pi-jobs" } }, twice("Pause queue pi-jobs again"), { action: "queue-pause", body: { queue: "pi-jobs" } }, "Resume", "Resumed queue pi-jobs"],
    ["pause-windows", { beforeText: json({ windows: [windows] }), extra: { before: [windows] } }, twice("Put the previous pause windows back"), { action: "pause-windows", body: { windows: [windows] } }, "Confirm", "Replaced the pause windows"],
    ["pause-windows", { beforeText: "not json", extra: { before: [] } }, [U.tooBig, U.tooBigAfter], null, "Confirm", "Replaced the pause windows"],
    ["trigger-add", { beforeText: json({ triggers: [{}, {}] }), plan: { entry: { on: { type: "label" } } } }, twice("Delete trigger at index 2"), { action: "trigger-delete", body: { index: 2 } }, "Confirm", "Added trigger at index 2 (label)"],
    ["trigger-edit", { beforeText: json({ triggers: [{ run: { flow: "triage" } }] }), plan: { index: 0, ref: {}, changes: [["flow", "triage", "review"]] } }, twice("Edit trigger at index 0 back to what it said"), { action: "trigger-edit", body: { index: 0, flow: "triage" } }, "Confirm", "Changed trigger at index 0: flow from triage to review"],
    ["trigger-edit", { beforeText: json({ triggers: [{ run: { flow: "triage" } }] }), plan: { index: 0, ref: { model: "m1" }, changes: [["flow", "triage", "triage"], ["model", "-", "m1"]] } }, twice("Edit trigger at index 0 back by hand: model had no value before, and an edit cannot remove one."), null, "Confirm", "Changed trigger at index 0: flow from triage to triage, model from - to m1"],
    ["trigger-delete", { beforeText: json({ triggers: [{ run: { flow: "triage" } }] }), plan: { index: 0 } }, DEL, null, "Delete trigger at index 0", "Deleted trigger at index 0"],
    // A trigger that names secret references, which the preview's diff hides, is put back from the operator's copy.
    ["trigger-delete", { beforeText: json({ triggers: [{ run: { flow: "triage" } }, { run: { flow: "fix", secrets: { T: "op://v/r" } } }] }), plan: { index: 1 } }, [U.deleteSecrets, U.deleteSecretsAfter], null, "Delete trigger at index 1", "Deleted trigger at index 1"],
    // An empty `run.secrets {}` names no reference, so the diff hides nothing and the plain delete sentence holds.
    ["trigger-delete", { beforeText: json({ triggers: [{ run: { flow: "triage", secrets: {} } }] }), plan: { index: 0 } }, DEL, null, "Delete trigger at index 0", "Deleted trigger at index 0"],
    ["setting-set", { beforeText: json({ maxTurns: 30 }), plan: { key: "maxTurns", value: 40 } }, twice("Set maxTurns back to 30"), { action: "setting-set", body: { key: "maxTurns", value: "30" } }, "Confirm", "Changed maxTurns from 30 to 40"],
    ["setting-set", { beforeText: json({}), plan: { key: "dailyCap", value: 5 } }, twice("Unset dailyCap again"), { action: "setting-unset", body: { key: "dailyCap" } }, "Confirm", "Set dailyCap to 5"],
    // An old value this form cannot send back (an empty string, an object): no inverse, so no Undo that refuses itself.
    ["setting-set", { beforeText: json({ model: "" }), plan: { key: "model", value: "m2" } }, twice("Set model back by hand: its old value is not one this form can send."), null, "Confirm", "Changed model to m2"],
    ["setting-set", { beforeText: json({ maxTurns: { n: 1 } }), plan: { key: "maxTurns", value: 40 } }, twice("Set maxTurns back by hand: its old value is not one this form can send."), null, "Confirm", "Changed maxTurns to 40"],
    ["setting-unset", { beforeText: json({ maxTurns: 30 }), plan: { key: "maxTurns" } }, twice("Set maxTurns back to 30"), { action: "setting-set", body: { key: "maxTurns", value: "30" } }, "Confirm", "Unset maxTurns"],
    ["setting-unset", { beforeText: json({ maxTurns: "" }), plan: { key: "maxTurns" } }, twice("Set maxTurns back by hand: its old value is not one this form can send."), null, "Confirm", "Unset maxTurns"],
    ["secret-profile-add", { beforeText: json({}), plan: { name: "dev" } }, twice("Remove profile dev"), { action: "secret-profile-remove", body: { name: "dev" } }, "Confirm", "Declared profile dev"],
    ["secret-profile-add", { beforeText: json({ secretProfiles: { dev: "/opt/old" } }), plan: { name: "dev" } }, ["Put profile dev back by hand: this preview's diff shows the resolver it replaced; the console keeps no copy.", "Put profile dev back by hand: the console kept no copy of the resolver it replaced."], null, "Confirm", "Replaced the resolver of profile dev"],
    ["secret-profile-remove", { plan: { name: "dev" } }, DEL, null, "Remove profile dev", "Removed profile dev"],
    ["secret-bundle-add", { beforeText: json({}), plan: { name: "op" } }, twice("Remove bundle resolver op"), { action: "secret-bundle-remove", body: { name: "op" } }, "Confirm", "Declared bundle resolver op"],
    ["secret-bundle-add", { beforeText: json({ secretBundles: { op: { path: "/b", format: "json" } } }), plan: { name: "op" } }, ["Put bundle resolver op back by hand: this preview's diff shows the resolver it replaced; the console keeps no copy.", "Put bundle resolver op back by hand: the console kept no copy of the resolver it replaced."], null, "Confirm", "Replaced bundle resolver op"],
    ["secret-bundle-remove", { plan: { name: "op" } }, DEL, null, "Remove bundle resolver op", "Removed bundle resolver op"],
    ["pause-window-add", { beforeText: json({ windows: [windows] }) }, twice("Delete pause window at index 1"), { action: "pause-window-delete", body: { index: 1 } }, "Confirm", "Added pause window at index 1"],
    ["pause-window-edit", { plan: { index: 0, before: windows, entry: { ...windows, to: "03:00" } } }, twice("Edit pause window at index 0 back to what it said"), { action: "pause-window-edit", body: { index: 0, ...windows } }, "Confirm", "Edited pause window at index 0"],
    ["pause-window-edit", { plan: { index: 0, before: null, entry: windows } }, ["Edit pause window at index 0 back by hand: this preview's diff shows what it said.", "Edit pause window at index 0 back by hand: the console kept no copy of what it said."], null, "Confirm", "Edited pause window at index 0"],
    ["pause-window-delete", { plan: { index: 0 } }, DEL, null, "Delete pause window at index 0", "Deleted pause window at index 0"],
    ["limit-add", { beforeText: json({ limits: [{ scope: "a" }] }) }, twice("Delete scoped limit at index 1"), { action: "limit-delete", body: { index: 1 } }, "Confirm", "Added scoped limit at index 1"],
    ["limit-edit", { plan: { index: 0, before: { scope: "a", day: 1 }, entry: { scope: "a", day: 2 } } }, twice("Edit scoped limit at index 0 back to what it said"), { action: "limit-edit", body: { index: 0, limit: { scope: "a", day: 1 } } }, "Confirm", "Edited scoped limit at index 0"],
    ["limit-delete", { plan: { index: 0 } }, DEL, null, "Delete scoped limit at index 0", "Deleted scoped limit at index 0"],
    ["project-add", { plan: { added: { id: "api" } } }, twice("Delete project api"), { action: "project-delete", body: { id: "api" } }, "Confirm", "Added project api"],
    ["project-edit", { plan: { before: { id: "web", members: ["github:acme/web"] } } }, twice("Edit project web back to what it said"), { action: "project-edit", body: { id: "web", name: "", members: ["github:acme/web"] } }, "Confirm", "Edited project web"],
    ["project-delete", { plan: { deleted: "web" } }, DEL, null, "Delete project web", "Deleted project web"],
    ["envelope-set", {}, [U.envelope, U.envelopeAfter], null, "Confirm", "Changed the allocation envelope"],
    ["priorities-set", {}, twice(U.allocation), null, "Confirm", "Applied a priorities plan"],
    ["allocation-revert", { payload: { index: 1 } }, twice(U.allocation), null, "Confirm", "Reverted the allocation to history row at index 1"],
  ];
  assert.deepEqual([...new Set(rows.map(([name]) => name))].sort(), ACTIONS.map((a) => a.name).sort(), "every action has a row");
  for (const [name, out, undo, inverse, label, done, result] of rows) {
    const a = ACTIONS.find((x) => x.name === name);
    const said = a.undo(out, {});
    assert.deepEqual(typeof said === "string" ? [said, said] : [said.bar, said.after], undo, `${name}: undo`);
    assert.deepEqual(a.inverse(out, {}), inverse, `${name}: inverse`);
    assert.equal(a.confirmLabel(out), label, `${name}: confirm label`);
    assert.equal(a.done(out, {}, result), done, `${name}: done`);
    assert.ok(!/\$0\.00/.test(label), `${name}: no "$0.00" on a button`);
    assert.ok(!(typeof said === "string" ? said : said.after).includes("preview"), `${name}: the banner's Undo never points at a preview`);
  }
  // A re-run's way back is the cancel of the job it queued, asked again at the confirm with the apply's answer
  // (`atConfirm`); no other rule is, and no bulk one can be (a bulk confirm asks no rule again).
  assert.deepEqual(ACTIONS.filter((a) => a.atConfirm).map((a) => a.name), ["run-fork", "rerun"]);
  assert.ok(ACTIONS.every((a) => typeof a.atConfirm === "boolean" && !(a.atConfirm && a.bulk)), "atConfirm is a single act's, and a boolean on every action");
  const rerun = ACTIONS.find((a) => a.name === "rerun");
  const landed = { ok: true, jobId: "cron:t0:1760000000000", queue: "pi-jobs@build3" };
  assert.equal(rerun.undo({}, null, landed), "Cancel cron:t0:1760000000000 before it starts");
  assert.deepEqual(rerun.inverse({}, null, landed), { action: "cancel-queued", body: { jobId: "cron:t0:1760000000000", queue: "pi-jobs@build3" } });
  // An answer that does not name both offers no button, and so no sentence that reads as one.
  for (const result of [{ ok: true }, { ok: true, jobId: "gh-n" }, { ok: true, queue: "pi-jobs" }, { ok: true, jobId: "", queue: "pi-jobs" }, { ok: true, jobId: 7, queue: "pi-jobs" }, null]) {
    assert.equal(rerun.undo({}, null, result), U.rerunUnnamed, JSON.stringify(result));
    assert.equal(rerun.inverse({}, null, result), null, JSON.stringify(result));
  }
  // The inverse is a write the table has, with only the fields it takes.
  const cancel = ACTIONS.find((a) => a.name === "cancel-queued");
  assert.deepEqual(Object.keys(rerun.inverse({}, null, landed).body).filter((k) => !cancel.fields.includes(k)), []);
  // The console's row words are the planners' (one rule, two modules): `atIndex` and `rowName(..., "console")`.
  for (const [what, i] of [["trigger", 0], ["pause window", 3], ["scoped limit", 12], ["history row", 1]]) assert.equal(atIndex(what, i), WP.rowName(what, i, "console"));
  assert.equal(WP.rowName("trigger", 0), "trigger #1", "the pi tools keep counting from 1");
});

/** A value for each body key the preview may read, so a preview reads on past it (an index a number, an id its charset). */
const SAMPLE_BODY = { index: 0, validDays: 1, jobId: "gh-1", id: "a".repeat(32), mode: "steer", text: "x", windows: [], trigger: {}, limit: {}, envelope: {}, projects: [{ id: "p", weight: 1 }], members: ["m"], days: ["mon"] };
/** A dependency that is anything: every property and every call is another one, so a preview runs until it needs a real value. */
function anything() {
  return new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : anything()), apply: () => anything() });
}

test("every action's fields are exactly the body keys its preview reads, through a recording Proxy (derived, both ways)", async () => {
  for (const a of ACTIONS) {
    const reads = new Set();
    const body = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? (reads.add(k), SAMPLE_BODY[k] ?? "x") : undefined) });
    const ctx = { deps: anything(), a: anything(), session: { id: "s", name: "alice" }, now: () => T0, fs: anything(), config: anything(), log: () => {} };
    try {
      await a.preview(body, ctx);
    } catch {
      // A preview stops where it needs a real dependency; the body keys it read before that are what is counted.
    }
    assert.deepEqual([...reads].sort(), [...a.fields].sort(), `${a.name}: the preview reads exactly its fields`);
  }
});

/** Every page and panel golden: the forms an operator submits, each with the control names it sends. */
function goldenForms() {
  const root = fileURLToPath(new URL("./fixtures/console/", import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith(".html"));
  const forms = [];
  for (const f of files) {
    const text = readFileSync(join(root, String(f)), "utf8");
    for (const m of text.matchAll(/<form\b[^>]*\sdata-action="([^"]+)"[^>]*>([^]*?)<\/form>/g)) {
      forms.push({ file: String(f), action: m[1], names: [...m[2].matchAll(/<(?:input|select|textarea|button)\b[^>]*\sname="([^"]+)"/g)].map((n) => n[1]) });
    }
  }
  return forms;
}

test("every form a golden draws names a known action and sends only fields that action takes", () => {
  const forms = goldenForms();
  assert.ok(forms.length >= 20, `the goldens hold the console's forms (${forms.length})`);
  for (const { file, action, names } of forms) {
    const a = ACTIONS.find((x) => x.name === action);
    assert.ok(a, `${file}: form[data-action="${action}"] is an action`);
    for (const n of names) assert.ok(a.fields.includes(n), `${file}: ${action} sends ${n}, which it does not take`);
  }
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
  assert.match(out, /<span class="d-del">\s+&quot;a&quot;: 1,<\/span><span class="d-add">\s+&quot;a&quot;: 2,<\/span>/, "the old line, then the new");
  assert.match(out, /^<div class="diff"><div class="diff__b"><span class="d-ctx">\{<\/span>/, "no head without a file, and the lines in the body");
  // With a file: its name alone in the head, never the directory it sits in (a path of this host).
  const named = String(diffHtmlOf(before, after, { file: "/Users/someone/deploy/triggers.json" }));
  assert.match(named, /^<div class="diff"><div class="diff__h"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-config"><\/use><\/svg>triggers\.json<\/div><div class="diff__b">/);
  assert.ok(!named.includes("/Users/"), "no host path");
  assert.equal(String(textHtml("one\n<two>")), '<div class="diff"><div class="diff__b"><span class="d-ctx">one</span><span class="d-ctx">&lt;two&gt;</span></div></div>');
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
  ["secret-bundle-add", { name: "op-shop", path: "/opt/bundle-shop", format: "json" }, "settingsFile", (j) => j.secretBundles["op-shop"].path === "/opt/bundle-shop" && j.secretBundles["op-shop"].format === "json"],
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

/** A file's JSON with every null and empty-object value dropped: an Undo's write may leave `"name": null` or `{}` behind. */
function settled(value) {
  if (Array.isArray(value)) return value.map(settled);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)).map(([k, v]) => [k, settled(v)]));
}

/** The machine's own paths a page must never name (`console-pages-harness.mjs` `HOST_PATH_RE`). */
const HOST_PATH_RE = /\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\//;

for (const [name, body, field, holds] of FILE_CASES) {
  test(`${name}: preview writes nothing, confirm writes exactly the previewed bytes, the row carries kind and both digests, and its Undo puts the file back`, async () => {
    const { paths } = deployment();
    const c = await start({ paths });
    const file = paths[field];
    const before = read(file);
    // What the file says, as its reader takes it: a pause window's reader fills in the default time zone, which an
    // edit then writes, so the pause-windows file is compared as read and every other one as its JSON.
    const said = () => (field === "pauseWindowsPath" ? RM.readPauseWindows({ pauseWindowsPath: file, fs: nodeFs }).windows : settled(JSON.parse(read(file))));
    const saidBefore = said();
    const p = await c.act(name, body);
    assert.equal(p.status, 200, p.text);
    const pj = p.json();
    assert.equal(read(file), before, "the preview wrote nothing");
    assert.equal(pj.beforeDigest, sha256(before));
    const action = ACTIONS.find((a) => a.name === name);
    assert.equal(pj.kind, action.kind);
    assert.ok(pj.html.includes('<div class="diff">'), "a diff is shown");
    const head = /<div class="diff__h">([^]*?)<\/div>/.exec(pj.html)?.[1] ?? "";
    assert.ok(head.endsWith(`>${file.split("/").at(-1)}`) && !HOST_PATH_RE.test(head), `the diff names the file by its name alone, never this host's path: ${head}`);
    assert.ok(!pj.html.includes("op://") && !p.text.includes("op://"), "a secret reference never reaches the preview");
    assert.equal(pj.danger, action.danger);
    // Issue #737: one inline run after the icon, "Undo: <b>the act</b>", or "No undo: <sentence>" with nothing bold.
    const undoLine = /<p class="confirm__undo"><svg[^>]*><use href="#i-rerun"><\/use><\/svg><span>((?:Undo: <b>|No undo: )[^]*?)<\/span><\/p>/.exec(pj.html)?.[1] ?? "";
    assert.ok(undoLine !== "", `the bar says how to undo it: ${pj.html}`);
    const res = await c.confirm(name, pj.ticket);
    assert.equal(res.status, 200, res.text);
    const after = read(file);
    assert.equal(sha256(after), pj.afterDigest, "the preview's after digest is the digest of what was written");
    assert.ok(holds(JSON.parse(after)), after);
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.outcome, row.target, row.beforeDigest, row.afterDigest], [pj.kind, "ok", file, pj.beforeDigest, pj.afterDigest]);
    assert.equal(row.actor.name, "alice");
    // The change: its audit row, who made it, the preview's own Undo; the flash holds the same for the next page.
    const { change } = res.json();
    assert.deepEqual([change.auditSeq, change.by, change.kind, change.count, change.done], [row.seq, "alice", pj.kind, 1, 1]);
    assert.deepEqual(c.sessions.flashes.at(-1).change, change, "the session's next page gets the same change");
    const banner = String(doneBannerHtml(change));
    assert.ok(!banner.includes("op://") && !HOST_PATH_RE.test(banner) && !JSON.stringify(change).includes("op://"), "the banner and the flash name no reference and no host path");
    assert.ok(banner.startsWith('<div class="banner tone-ok"'), "one write that landed: the ok tone");
    if (change.inverse === null) {
      // A delete keeps no copy, so no inverse: the bar says "No undo:" and how to put it back from the preview, and the
      // banner, on a page where no preview is, that the console kept no copy. The deployment's one trigger names a
      // secret reference, which the preview never shows, so its delete says where those come from instead.
      const secrets = name === "trigger-delete";
      assert.equal(pj.undo, secrets ? UNDO_SENTENCES.deleteSecrets : UNDO_SENTENCES.delete, `${name}: the bar's sentence`);
      assert.equal(undoLine, `No undo: ${esc(pj.undo)}`, `${name}: muted, nothing bold`);
      assert.equal(change.undo, secrets ? UNDO_SENTENCES.deleteSecretsAfter : UNDO_SENTENCES.deleteAfter, `${name}: the banner's sentence`);
      assert.ok(banner.includes(` No undo: ${esc(change.undo)}</p>`) && !banner.includes("this preview") && !banner.includes("<b>Undo:"), banner);
      return;
    }
    assert.equal(change.undo, pj.undo, "an act with an inverse says one Undo in the bar and the banner");
    assert.equal(undoLine, `Undo: <b>${esc(pj.undo)}</b>`, "the act alone in bold");
    assert.ok(banner.includes(` <b>Undo:</b> ${esc(change.undo)}.</p>`), banner);
    // Undo is a preview of the inverse like any write: previewed, confirmed, and the file says what it said.
    const back = await c.both(change.inverse.action, change.inverse.body);
    assert.equal(back.confirm.status, 200, `${name} undo: ${back.confirm.text}`);
    assert.deepEqual(said(), saidBefore, `${name}: Undo put the file back`);
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

// Issue #704: the bundle resolvers through the console's form, the profiles' twin, and a bundled project's members.
test("secret-bundle-remove goes through the pipeline and names the bundles it strands; a name PI_SECRET_BUNDLES holds is refused at the preview (#704)", async () => {
  const { paths } = deployment();
  writeFileSync(paths.settingsFile, `${JSON.stringify({ secretBundles: { "op-shop": { path: "/opt/b", format: "dotenv" }, other: { path: "/opt/o", format: "json" } } }, null, 2)}\n`);
  writeFileSync(paths.triggersPath, `${JSON.stringify({ triggers: [], secretBundles: { shop: { profile: "op-shop", ref: "env-ref-canary", project: "web" } } }, null, 2)}\n`);
  const c = await start({ paths });
  const p = await c.act("secret-bundle-remove", { name: "op-shop" });
  assert.equal(p.status, 200, p.text);
  assert.ok(p.json().summary.join("\n").includes("The jobs of bundle shop are refused pre-spend after this (secret-bundle-profile-unknown), or on a multi-host worker's shared queue held"), p.text);
  assert.ok(!p.text.includes("env-ref-canary"), "a bundle's reference never reaches the preview");
  const res = await c.confirm("secret-bundle-remove", p.json().ticket);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(JSON.parse(read(paths.settingsFile)).secretBundles, { other: { path: "/opt/o", format: "json" } });
  assert.equal(lastWrite(c).kind, "secret-bundle-remove");
  const held = await start({ paths, a: { env: { PI_SECRET_BUNDLES: "op-shop:/opt/env-b:json" } } });
  const refused = await held.act("secret-bundle-add", { name: "op-shop", path: "/opt/b", format: "json" });
  assert.equal(refused.status, 400);
  assert.match(refused.json().error, /^PI_SECRET_BUNDLES already declares op-shop on this deployment/);
  assert.equal((await held.act("secret-bundle-add", { name: "x", path: "/opt/b", format: "yaml" })).json().error, "the format is dotenv or json: what the resolver prints, declared, because the worker never guesses it from the output");
});

test("project-edit on a project a secret bundle names is refused at the preview with the planner's sentence, nothing written (#704)", async () => {
  const { paths } = deployment();
  writeFileSync(paths.triggersPath, `${JSON.stringify({ triggers: [], secretBundles: { shop: { profile: "op-shop", ref: "r", project: "web" } } }, null, 2)}\n`);
  const before = read(paths.projectsFile);
  const c = await start({ paths });
  const got = await c.act("project-edit", { id: "web", members: "github:acme/web\ngithub:acme/api" });
  assert.equal(got.status, 400, got.text);
  assert.equal(got.json().error, WP.planProjectEdit({ params: { id: "web", members: ["github:acme/web", "github:acme/api"] }, paths, env: {} }).refusal);
  assert.match(got.json().error, /secretBundles "shop" \(project web\) in .* names this project.*change the bundle in triggers\.json first\. Nothing was written/);
  assert.equal(read(paths.projectsFile), before);
});

test("a refusal is the tool's own sentence, before any ticket: a tool-proof trigger field, an unknown key, a bad index", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const proof = await c.act("trigger-add", { trigger: { kind: "label", labels: ["x"], flow: "f", run: { maxCostUsd: "9" } } });
  assert.equal(proof.status, 400);
  // The planner's own sentence, with the form's own word for itself where the tool says its name (issue #737).
  assert.equal(proof.json().error, WP.planTriggerAdd({ params: { kind: "label", labels: ["x"], flow: "f", run: { maxCostUsd: "9" } }, paths, env: {}, tool: TRIGGER_FORM }).refusal);
  assert.match(proof.json().error, /^this form cannot set run\.maxCostUsd/);
  const colour = (await c.act("trigger-add", { trigger: { kind: "label", labels: ["x"], flow: "f", colour: "red" } })).json();
  assert.match(colour.error, /^this form does not take colour for a label trigger; it takes kind, flow, /);
  assert.ok(colour.html.includes("This form does not take colour for a label trigger") && !colour.html.includes("dispatch_trigger_add") && !proof.json().html.includes("dispatch_trigger_add"), "a person on the console is never told a pi tool's name");
  // The kind it was sent is never echoed (a caller's bytes never reach the sentence); the kinds it takes are named.
  const kind = (await c.act("trigger-add", { trigger: { kind: "<img>kind-canary", flow: "f" } })).json();
  assert.equal(kind.error, "unknown trigger kind: kind must be one of cron, label, comment, pull_request, issue");
  assert.ok(!kind.html.includes("kind-canary") && !kind.html.includes("<img"), kind.html);
  assert.match((await c.act("setting-set", { key: "nope", value: "1" })).json().error, /^unknown key 'nope'/);
  assert.match((await c.act("pause-window-delete", { index: 7 })).json().error, /no pause window at index 7 \(have 1\)/);
  // A value the funnel's own parser refuses is refused at the preview (the dry run), with the parser's words.
  const bad = await c.act("pause-window-add", { scope: "*", from: "25:00", to: "02:00" });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /^rejected: /);
  assert.equal(c.audit.rows.filter((r) => r.action === "write").length, 0, "no preview writes a row");
  // Issue #737: each refusal also carries the slot's bar, refused, with the sentence (its first letter capitalised)
  // and "Nothing was changed." added once, only where the sentence does not already say so.
  const bar = proof.json().html;
  assert.match(bar, /^<div class="banner banner--sm tone-refused" role="status">/);
  assert.ok(bar.includes("<p class=\"banner__t\">The change was refused</p>") && bar.includes("data-close"), bar);
  assert.ok(bar.includes(" Nothing was changed.</p>"), "the planner's sentence lacks it, so the bar adds it");
  const said = (await c.act("pause-window-delete", { index: 7 })).json().html;
  assert.ok(said.includes("No pause window at index 7 (have 1). Nothing was changed.</p>"), said);
  const already = (await c.act("pause-window-delete", { index: -1 })).json();
  assert.match(already.error, /; nothing was changed$/);
  assert.equal(already.html.match(/nothing was changed/gi).length, 1, "never said twice");
});

// Issue #737: until the Configuration page converts (PR 7a), the console names its rows by the 0-based index
// its tables and forms show; the pi tools keep their 1-based "#1". A change reads "key: <b>before</b> to <b>after</b>".
test("the console's Configuration sentences name a row by its index, the change in words with its values in bold; the pi tools still count from 1", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const edit = (await c.act("trigger-edit", { index: 0, flow: "review" })).json();
  assert.deepEqual(edit.summary, ["Edit trigger at index 0", "trigger at index 0 (label) flow: triage to review"]);
  assert.ok(edit.html.includes("<p class=\"confirm__h\"><svg class=\"ic\" aria-hidden=\"true\"><use href=\"#i-done\"></use></svg>Edit trigger at index 0</p><ul class=\"confirm__list\"><li>trigger at index 0 (label) flow: <b>triage</b> to <b>review</b></li></ul>"), edit.html);
  const venue = (await c.act("trigger-edit", { index: 0, flow: "review", model: "m1" })).json();
  assert.equal(venue.summary[1], "trigger at index 0 (label) flow: triage to review, model: - to m1");
  assert.ok(venue.html.includes("<li>trigger at index 0 (label) flow: <b>triage</b> to <b>review</b>, model: <b>-</b> to <b>m1</b></li>"), venue.html);
  // The bar's line is the planner's words exactly, with only the bold added.
  const barLine = /<ul class="confirm__list"><li>([^]*?)<\/li>/.exec(venue.html)[1].replace(/<\/?b>/g, "");
  assert.equal(barLine, venue.summary[1]);
  assert.match((await c.act("trigger-edit", { index: 0, flow: "x", model: "a b" })).json().error, /trigger at index 0/, "the loader's sentence names the row the same way");
  assert.deepEqual((await c.act("trigger-delete", { index: 0 })).json().summary, ["Delete trigger at index 0", "Remove trigger at index 0 (label) flow: triage"]);
  const pw = (await c.act("pause-window-edit", { index: 0, to: "03:00" })).json().summary;
  assert.deepEqual(pw.slice(0, 2), ["Edit pause window at index 0", "pause window at index 0:"]);
  assert.match(pw[3], /^to \{"scope":"\*","from":"01:00","to":"03:00"/, "words, never an arrow");
  assert.equal((await c.act("pause-window-delete", { index: 0 })).json().summary[0], "Delete pause window at index 0");
  assert.equal((await c.act("limit-edit", { index: 0, limit: { day: 20 } })).json().summary[0], "Edit scoped limit at index 0");
  assert.equal((await c.act("limit-delete", { index: 0 })).json().summary[0], "Delete scoped limit at index 0");
  // The pi tools' own planners, unchanged: the number a person counts by.
  assert.equal(WP.planTriggerDelete({ index: 0, paths }).plan.title, "Delete trigger #1");
  assert.equal(WP.planPauseWindowDelete({ index: 0, paths }).plan.title, "Delete pause window #1");
  assert.equal(WP.planLimitDelete({ index: 0, paths, env: {} }).plan.title, "Delete scoped limit #1");
});

// Issue #737: what a planner says beyond its first pair reaches the bar: an edit's venue, and a dollar
// key's warning lines, each a line of the bar as the planner wrote it, with nothing blank drawn between.
test("the bar shows every change and line the planner says: a trigger edit's backend pair, a dollar setting's warning", async () => {
  const { paths } = deployment();
  const c = await start({ paths, a: { env: { PI_BACKENDS: "local" } } });
  const edit = (await c.act("trigger-edit", { index: 0, flow: "review", backend: "local" })).json();
  assert.deepEqual(edit.summary, ["Edit trigger at index 0", "trigger at index 0 (label) flow: triage to review, backend: - to local"]);
  assert.ok(edit.html.includes("<ul class=\"confirm__list\"><li>trigger at index 0 (label) flow: <b>triage</b> to <b>review</b>, backend: <b>-</b> to <b>local</b></li></ul>"), edit.html);
  // No per-job cap anywhere, so a daily dollar cap leaves its window unbounded: the planner warns, never refuses.
  writeFileSync(paths.settingsFile, `${JSON.stringify({ maxTurns: 30 }, null, 2)}\n`);
  const s = (await c.act("setting-set", { key: "dailyCostUsd", value: "5" })).json();
  const planned = WP.planSettingSet({ key: "dailyCostUsd", value: "5", paths, env: { PI_BACKENDS: "local" } }).plan;
  assert.ok(planned.warning, "the fixture is one the planner warns about");
  assert.deepEqual(s.summary, ["Set dailyCostUsd", ...planned.summary], "the answer's summary is the planner's, blank line and all");
  const list = /<ul class="confirm__list">([^]*?)<\/ul>/.exec(s.html)?.[1] ?? "";
  assert.deepEqual(list.split("</li>").filter(Boolean).map((li) => li.replace(/^<li>/, "")), [
    String(html`dailyCostUsd: <b>${planned.changes[0][1]}</b> to <b>5</b>`),
    esc(`Warning: ${planned.warning}`),
  ], "the pair in bold, then the warning, and no empty item for the planner's blank line");
});

// Issue #737: every count a bar says goes through the one plural rule, its noun and its verb with
// it: "0 windows", "1 job waits", "1 more matches and is", "1 more held is", "1 byte", and a list of one is "It holds".
test("every count in a bar agrees with its words, singular, plural and zero alike", async () => {
  const { paths } = deployment();
  writeFileSync(paths.pauseWindowsPath, `${JSON.stringify({ windows: [] }, null, 2)}\n`);
  let queueCounts = [];
  let held = { rows: [], more: 0 };
  const fleet = { snapshot: async () => ({ queueCounts, held }) };
  let failed = { jobs: [], more: 0, examinedAll: true };
  const id = "a".repeat(32);
  const rm = {
    ...RM,
    planFailedBulk: async () => failed,
    planSteer: async ({ text }) => ({ plan: { jobId: "gh-s", id, mode: "steer", text, bytes: Buffer.byteLength(text), digest: sha256(text) } }),
  };
  const c = await start({ paths, a: { fleet, rm, readJobsData: async () => new Map(), killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  assert.deepEqual((await c.act("pause-windows", { windows: [{ scope: "*", from: "05:00", to: "06:00" }] })).json().summary, ["Replace the pause windows", "0 windows now, 1 after"]);
  const waiting = async (n) => {
    queueCounts = [{ queue: "pi-jobs", paused: true, counts: { waiting: n } }];
    return (await c.act("queue-resume", { queue: "pi-jobs" })).json().summary[1];
  };
  assert.match(await waiting(0), /^0 jobs wait to start in it \(pi-jobs\): /);
  assert.match(await waiting(1), /^1 job waits to start in it \(pi-jobs\): /);
  assert.match(await waiting(2), /^2 jobs wait to start in it \(pi-jobs\): /);
  const past = async (more, examinedAll) => {
    failed = { jobs: [{ jobId: "gh-a", queue: "pi-jobs", attemptsMade: 1, finishedOn: 1 }], more, examinedAll };
    return (await c.act("remove-all-failed", {})).json().summary.at(-1);
  };
  assert.equal(await past(1, true), "1 more matches and is not in this action (at most 100 per action)");
  assert.equal(await past(2, true), "2 more match and are not in this action (at most 100 per action)");
  // A scan that stopped short counts a floor: "at least", never "1 or more more".
  assert.equal(await past(1, false), "at least 1 more matches and is not in this action (at most 100 per action)");
  assert.equal(await past(3, false), "at least 3 more match and are not in this action (at most 100 per action)");
  assert.equal((await c.act("remove-failed", { jobId: "gh-a" })).json().summary[0], "Remove failed job gh-a on pi-jobs, 1 attempt");
  const heldMore = async (more) => {
    held = { rows: [{ jobId: "gh-h1", label: "jira" }], more };
    return (await c.act("cancel-all-held", {})).json();
  };
  const one = await heldMore(1);
  assert.equal(one.summary.at(-1), "1 more held is not in this action");
  assert.ok(one.html.includes("<li>1 more held is <b>not in this action</b></li>"), one.html);
  assert.equal((await heldMore(2)).summary.at(-1), "2 more held are not in this action");
  assert.match((await c.act("steer", { jobId: "gh-s", text: "x" })).json().summary[0], /\(message a{32}, 1 byte\)$/);
  assert.match((await c.act("steer", { jobId: "gh-s", text: "xy" })).json().summary[0], /\(message a{32}, 2 bytes\)$/);
  // A bulk list of one holds what one job holds, said as a single act's reserve is; its known half counts too.
  assert.equal(reserveText({ bulk: true, slots: 1, dollarsMicros: 1_500_000, unknown: 0 }), "It holds 1 job slot and $1.50 in each dollar window that applies.");
  assert.equal(reserveText({ bulk: true, slots: 3, dollarsMicros: 3_000_000, unknown: 1 }), "Together they hold 3 job slots and $3.00 for the 2 jobs whose reserve is known in each dollar window that applies; the reserve of 1 job is unknown (its data could not be read), so the total is at least this.");
  assert.equal(reserveText({ bulk: true, slots: 2, dollarsMicros: 1_500_000, unknown: 1 }), "Together they hold 2 job slots and $1.50 for the 1 job whose reserve is known in each dollar window that applies; the reserve of 1 job is unknown (its data could not be read), so the total is at least this.");
});

// Issue #737: a resolver's add over one of the same name and its removal name it in words, "dev: /opt/d.sh",
// where an arrow stood; the bar draws the planner's lines, each one item, the blank one between them none.
test("a resolver's replace and removal are said in words in the bar, never an arrow, one item per line", async () => {
  const { paths } = deployment();
  writeFileSync(paths.settingsFile, `${JSON.stringify({ secretProfiles: { prod: "/opt/r" }, secretBundles: { "op-shop": { path: "/opt/b", format: "dotenv" } } }, null, 2)}\n`);
  const c = await start({ paths });
  const items = (j) => (/<ul class="confirm__list">([^]*?)<\/ul>/.exec(j.html)?.[1] ?? "").split("</li>").filter(Boolean).map((li) => li.replace(/^<li>/, ""));
  const removed = (await c.act("secret-profile-remove", { name: "prod" })).json();
  assert.deepEqual(items(removed), ["prod: /opt/r", "Every trigger naming it refuses pre-spend after this, rather than running without its secrets."]);
  const bundleGone = (await c.act("secret-bundle-remove", { name: "op-shop" })).json();
  assert.deepEqual(items(bundleGone), ["op-shop: /opt/b (dotenv)", "No bundle in triggers.json names it, so no project&#39;s jobs depend on it."]);
  const replaced = (await c.act("secret-profile-add", { name: "prod", path: "/opt/r2" })).json();
  assert.ok(items(replaced).includes("This replaces the current resolver, prod: /opt/r"), items(replaced).join("\n"));
  const bundleReplaced = (await c.act("secret-bundle-add", { name: "op-shop", path: "/opt/b2", format: "json" })).json();
  assert.ok(items(bundleReplaced).includes("This replaces the current resolver, op-shop: /opt/b (dotenv)"), items(bundleReplaced).join("\n"));
  for (const j of [removed, bundleGone, replaced, bundleReplaced]) assert.ok(!items(j).includes(""), "a blank planner line is no item");
});

// Issue #737: a body key no preview reads is refused by name, before any planner runs or any ticket is issued.
test("a body key the action does not take is refused 400 by name, with the fields it does take, and never its value", async () => {
  const { paths } = deployment();
  const c = await start({ paths, a: { fleet: { snapshot: async () => ({}) } } });
  const before = read(paths.triggersPath);
  const named = await c.act("trigger-delete", { index: 0, colour: "red-canary" });
  assert.equal(named.status, 400);
  assert.equal(named.json().error, "trigger-delete takes index only; colour is not one of them, so nothing was changed");
  assert.equal((await c.act("pause-window-add", { scope: "*", from: "01:00", to: "02:00", tz: "UTC", weekday: "mon" })).json().error, "pause-window-add takes scope, from, to, tz, days, dateFrom, dateTo only; weekday is not one of them, so nothing was changed");
  assert.equal((await c.act("fleet-pause", { all: true })).json().error, "fleet-pause takes no fields; it refuses all, so nothing was changed");
  assert.equal((await c.act("trigger-delete", { index: 0, ticket: "t" })).json().error, "trigger-delete takes index only; ticket is not one of them, so nothing was changed", "a ticket belongs to the confirm");
  for (const key of ["a b", "x".repeat(41), "__proto__", "c\u202eolour", "<img src=x>", "<b>", "a<b", "x>"]) {
    const res = await c.post("/api/act/trigger-delete/preview", JSON.parse(`{"index":0,${JSON.stringify(key)}:"value-canary"}`), { cookie: c.op });
    assert.equal(res.status, 400, JSON.stringify(key));
    assert.equal(res.json().error, "trigger-delete takes index only; a field it was sent is not one of them, so nothing was changed", JSON.stringify(key));
    assert.ok(!res.text.includes("value-canary") && !res.text.includes("<img") && !res.text.includes("<b>") && !res.text.includes("&lt;"), "neither the key nor its value is echoed");
  }
  // A key holding a markup character is never a name, whatever else it holds.
  for (const key of ["<b>", "a<b", "x>", "a>b", "<"]) assert.equal(fieldNamed(key), UNNAMED_FIELD, JSON.stringify(key));
  assert.equal(fieldNamed("colour"), "colour");
  assert.ok(!named.text.includes("red-canary"));
  assert.match(named.json().html, /tone-refused/);
  // The bar names the action and the fields as code (issue #737), so its first word is never "Trigger-delete" or
  // "Setting-set": the JSON's sentence starts with the action's own name, and capitalising that names no action.
  assert.ok(named.json().html.includes('<p class="banner__s"><span class="code">trigger-delete</span> takes <span class="code">index</span> only; <span class="code">colour</span> is not one of them, so nothing was changed.</p>'), named.json().html);
  const setting = (await c.act("setting-set", { key: "maxTurns", value: "40", colour: "red" })).json();
  assert.equal(setting.error, "setting-set takes key, value only; colour is not one of them, so nothing was changed");
  assert.ok(setting.html.includes('<span class="code">setting-set</span> takes <span class="code">key</span>, <span class="code">value</span> only;') && !setting.html.includes("Setting-set"), setting.html);
  assert.ok((await c.act("fleet-pause", { all: true })).json().html.includes('<span class="code">fleet-pause</span> takes no fields; it refuses <span class="code">all</span>, so nothing was changed.</p>'));
  const unnamed = (await c.post("/api/act/trigger-delete/preview", { index: 0, "a b": 1 }, { cookie: c.op })).json();
  assert.ok(unnamed.html.includes("only; a field it was sent is not one of them, so nothing was changed.</p>"), "an unnamed field is plain words, not code");
  assert.equal(read(paths.triggersPath), before, "nothing was written");
  assert.equal(c.audit.rows.filter((r) => r.action === "write").length, 0, "no row: a preview is not audited");
});

// Issue #673: the console's setting-set refuses a model or provider outside the id shape at the preview (the dry run
// through the worker's writeOverlay), with the shape's sentence, never the value, and writes nothing.
test("setting-set: a model or provider outside the id shape is refused at the preview with the shape's sentence, nothing written (#673)", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const before = readFileSync(paths.settingsFile, "utf8");
  for (const [key, bad, says] of [
    ["model", "Claude Sonnet", "model must be a model id of 1 to 64 characters: letters, digits and . _ - : / @, starting with a letter or digit (or ~ or @ then one)"],
    ["model", "a~b", "model must be a model id of 1 to 64 characters: letters, digits and . _ - : / @, starting with a letter or digit (or ~ or @ then one)"],
    ["provider", "a/b", "provider must be a provider id of 1 to 64 characters: letters, digits, dot, dash and underscore, starting with a letter or digit"],
  ]) {
    const res = await c.act("setting-set", { key, value: bad });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json().error, `rejected: ${says}`, `${key} ${bad}`);
  }
  assert.equal(readFileSync(paths.settingsFile, "utf8"), before, "nothing written");
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
  // The slot's bar for a ticket refusal: attention, Preview again (a new preview is a new ticket), nothing changed.
  for (const r of [stolen, wrongAction]) {
    const bar = r.json().html;
    assert.match(bar, /tone-attention/);
    assert.ok(bar.includes("This confirmation cannot be used") && bar.includes(`data-again>`) && bar.includes(">Preview again</button>"), bar);
    assert.ok(bar.includes("Preview the change again and confirm the new preview. Nothing was changed.</p>"), bar);
  }
  assert.equal(c.sessions.flashes.length, 0, "a refused confirm leaves no banner");
});

test("an audit append failure refuses the confirm 500 and the file is untouched", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const before = read(paths.triggersPath);
  const p = (await c.act("trigger-delete", { index: 0 })).json();
  c.audit.failNext = 1;
  const res = await c.confirm("trigger-delete", p.ticket);
  assert.equal(res.status, 500);
  assert.equal(res.json().error, AUDIT_FAILED);
  assert.equal(read(paths.triggersPath), before);
  // Failed, and Close alone: nothing in the page fixes a log directory, but a bar with no button kept the slot open, and
  // the panel it held still, until a reload.
  const bar = res.json().html;
  assert.match(bar, /tone-failed/);
  assert.ok(bar.includes("<p class=\"banner__t\">The audit log could not be written</p>"), bar);
  assert.deepEqual(bar.match(/<button[^>]*>[^<]*<\/button>/g), ['<button class="btn btn--sm" type="button" data-close>Close</button>'], "Close, and nothing that retries");
  assert.equal(bar.match(/nothing was changed/gi).length, 1, "the sentence says it, so the bar adds nothing");
  assert.equal(c.sessions.flashes.length, 0);
});

test("a write that throws at the confirm refuses 500 with Close, the slot's one way out, as every refusal bar has", async () => {
  const { paths } = deployment();
  const fleet = { snapshot: async () => ({}), cancelActive: async () => { throw Object.assign(new Error("boom"), { code: "EBOOM" }); } };
  const c = await start({ paths, a: { fleet } });
  const threw = await c.both("cancel-active", { jobId: "gh-1" });
  assert.equal(threw.confirm.status, 500);
  // The answer's own sentence, its tail pinned (one act, one call: it threw before it did anything).
  assert.equal(threw.confirm.json().error, "the cancel-active change could not be made; nothing was changed, and the console's log has the reason");
  const bar = threw.confirm.json().html;
  assert.ok(bar.includes("tone-failed") && bar.includes("<p class=\"banner__t\">The change could not be made</p>"), bar);
  assert.deepEqual(bar.match(/<button[^>]*>[^<]*<\/button>/g), ['<button class="btn btn--sm" type="button" data-close>Close</button>'], bar);
  // Every refusal state the slot can show offers exactly one step, so no refusal leaves the slot open with nothing to
  // press (the script closes the slot on Close and Cancel, previews again on Preview again and Try again, reloads on
  // Look again).
  const { REFUSAL_STATES, refusalHtml } = await import("../src/console/confirm-view.mjs");
  for (const state of Object.keys(REFUSAL_STATES)) {
    const drawn = String(refusalHtml({ where: "confirm", sentence: "s", status: 409, state }));
    assert.equal(drawn.match(/<button /g)?.length ?? 0, 1, `${state}: one button`);
    assert.match(drawn, / data-(?:close|again|reload)>/, `${state}: one the script wires`);
  }
});

// A planner's answer may carry a field named `state` for something else (a job's BullMQ state): the bar's state comes
// from the slot's own set alone, so such a refusal is drawn as refused, never as a bar the slot has no state for.
test("a planner refusal whose state field is no slot state still draws the refused bar, never a thrown preview", async () => {
  const action = { name: "probe", kind: "probe", fields: [], needs: [], async preview() { return { refusal: "the job is active, so it cannot be removed", state: "active" }; } };
  const ctx = { deps: { log() {}, actionDeps: {} }, session: { id: "s", name: "ops", role: "operator" }, body: {}, json: (status, obj) => ({ status, obj }) };
  const got = await previewAction(ctx, action);
  assert.equal(got.status, 400);
  assert.match(got.obj.html, /The change was refused/);
});

// Issue #737: "Nothing was changed." only where it is true. A refusal that can come after part of the write
// was made is the action's own `partial`, never a reading of its words, and its bar offers Look again.
test("a refusal that can follow a write never says nothing was changed: the kill switch's partial pause, a switch that throws, and bulk applies that throw part-way offer Look again", async () => {
  const { paths } = deployment();
  let answer = null;
  const cancelled = [];
  const held = [{ jobId: "gh-h1", label: "jira" }, { jobId: "gh-h2", label: "jira" }, { jobId: "gh-h3", label: "jira" }];
  const fleet = {
    snapshot: async () => ({ held: { rows: held } }),
    pause: async () => {
      if (answer === "throw") throw Object.assign(new Error("lost"), { code: "ECONNRESET" });
      return answer;
    },
  };
  const rm = {
    ...RM,
    cancelHeldJob: async ({ jobId }) => {
      if (jobId === "gh-h2") throw Object.assign(new Error("down"), { code: "ECONNRESET" });
      cancelled.push(jobId);
      return { ok: true };
    },
  };
  const c = await start({ paths, a: { fleet, rm, killSwitchPlanFn: () => ({ urls: ["redis://a/0", "redis://b/0"], disagreement: null }) } });
  const mayHave = (bar) => {
    assert.ok(!/nothing was changed/i.test(bar), `never "nothing was changed": ${bar}`);
    assert.ok(bar.includes(` ${PARTIAL_NOTE}</p>`) && bar.includes('<p class="banner__t">The change did not finish</p>') && bar.includes('data-reload>Look again</button>'), bar);
    assert.match(bar, /^<div class="banner banner--sm tone-attention" role="status">/);
  };
  // One Valkey took the pause, the other stopped part-way: part of the fleet IS paused.
  answer = { results: [{ shown: "redis://a/0", res: { ok: true, queues: ["pi-jobs"] } }, { shown: "redis://b/0", res: { unreachable: "down", partial: { done: ["pi-jobs@m1"], failed: "pi-jobs@m2" } } }] };
  const part = await c.both("fleet-pause", {});
  assert.equal(part.confirm.status, 409);
  assert.equal(part.confirm.json().error, "the kill switch did not reach every queue: redis://a/0 done; redis://b/0 stopped after pi-jobs@m1, failed at pi-jobs@m2. Look at the fleet and try again");
  mayHave(part.confirm.json().html);
  // One Valkey took the pause and the other never answered: part of the fleet IS paused, with no loop
  // stopped part-way to say so, so the Valkey that answered ok alone makes it partial.
  answer = { results: [{ shown: "redis://a/0", res: { ok: true, queues: ["pi-jobs"] } }, { shown: "redis://b/0", res: { unreachable: "down" } }] };
  const half = (await c.both("fleet-pause", {})).confirm;
  assert.equal(half.status, 409);
  assert.equal(half.json().error, "the kill switch did not reach every queue: redis://a/0 done; redis://b/0 unreachable. Look at the fleet and try again");
  mayHave(half.json().html);
  // A loop that failed at its first queue: that queue's state is unknown (the error came back, not the state).
  answer = { results: [{ shown: "redis://a/0", res: { unreachable: "down", partial: { done: [], failed: "pi-jobs" } } }] };
  mayHave((await c.both("fleet-pause", {})).confirm.json().html);
  // The switch itself threw: what it reached is unknown.
  answer = "throw";
  const lost = (await c.both("fleet-pause", {})).confirm;
  assert.equal(lost.status, 409);
  assert.equal(lost.json().error, "the kill switch stopped with an error (ECONNRESET) before it said which queues it reached. Look at the fleet and try again");
  mayHave(lost.json().html);
  // No Valkey's loop started (every one unreachable before it): nothing changed, and the bar says so.
  answer = { results: [{ shown: "redis://a/0", res: { unreachable: "down" } }] };
  const untouched = (await c.both("fleet-pause", {})).confirm.json().html;
  assert.ok(untouched.includes("The change did not go through") && untouched.includes(" Nothing was changed.</p>") && untouched.includes("data-reload>"), untouched);
  // A bulk apply that throws at its second job: the first was cancelled.
  const bulk = (await c.both("cancel-all-held", {})).confirm;
  assert.equal(bulk.status, 500);
  assert.deepEqual(cancelled, ["gh-h1"], "the job before the throw was acted on");
  assert.equal(bulk.json().error, "the cancel-all-held change failed before it finished; the console's log has the reason");
  mayHave(bulk.json().html);
  // The same for a read-model funnel that throws part-way through a retry list.
  const jobs = ["gh-a", "gh-b"].map((jobId, i) => ({ jobId, queue: "pi-jobs", attemptsMade: 1, finishedOn: i + 1 }));
  const r = await start({ paths, a: { rm: { ...RM, planFailedBulk: async () => ({ jobs, more: 0 }), retryFailedJobs: async () => { throw Object.assign(new Error("closed"), { code: "ECONNRESET" }); } }, readJobsData: async () => new Map() } });
  const retry = (await r.both("retry-all-failed", {})).confirm;
  assert.equal(retry.status, 500);
  mayHave(retry.json().html);
  assert.equal(c.sessions.flashes.length + r.sessions.flashes.length, 0, "no banner over a write that did not finish");
});

// Issue #737: a preview that reads the fleet snapshot answers within its bound whatever Valkey does, and says what happened.
test("a preview that reads the fleet snapshot answers within its bound when the snapshot never settles: cancel-held, cancel-all-held, queue-resume and fleet-resume", async () => {
  const { paths } = deployment();
  const fleet = { snapshot: () => new Promise(() => {}) };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  const timed = async (name, body) => {
    const t0 = Date.now();
    let timer;
    const res = await Promise.race([c.act(name, body), new Promise((resolve) => (timer = setTimeout(() => resolve("hung"), SNAPSHOT_TIMEOUT_MS + 3_000)))]);
    clearTimeout(timer);
    return { name, res, ms: Date.now() - t0 };
  };
  const answers = await Promise.all([timed("cancel-held", { jobId: "gh-h1" }), timed("cancel-all-held", {}), timed("queue-resume", { queue: "pi-jobs" }), timed("fleet-resume", {})]);
  for (const { name, res, ms } of answers) {
    assert.notEqual(res, "hung", `${name}: the preview answered`);
    assert.ok(ms >= SNAPSHOT_TIMEOUT_MS - 50 && ms < SNAPSHOT_TIMEOUT_MS + 2_000, `${name}: ${ms} ms`);
  }
  const [held, allHeld, queue, resume] = answers.map((a) => a.res);
  const title = (r) => /<p class="banner__t">([^<]*)<\/p>/.exec(r.json().html)?.[1];
  for (const r of [held, allHeld, queue]) {
    assert.deepEqual([r.status, r.json().error], [503, SNAPSHOT_TIMEOUT_SENTENCE]);
    // Issue #737: its own bar, chosen by the refusal's state: a timeout blames no cause, so the title names no Valkey.
    assert.equal(title(r), "The fleet did not answer in time", r.text);
    assert.match(r.json().html, /^<div class="banner banner--sm tone-attention" role="status">/);
    assert.match(r.json().html, /<button class="btn btn--sm" type="button" data-again>Try again<\/button>/);
    assert.doesNotMatch(r.json().html, /Valkey/);
  }
  // The fleet's resume previews without its count, and says why: the bound fired, in its own words.
  assert.equal(resume.status, 200, resume.text);
  assert.ok(resume.json().summary.includes(RESUME_WAITING_UNKNOWN.timeout), resume.text);
  assert.equal(RESUME_WAITING_UNKNOWN.timeout, "How many jobs wait to start is not known: the fleet did not answer within 10 seconds. Each reserves up to its own per-job dollar cap when a worker picks it up");
  assert.equal(resume.json().undo, UNDO_SENTENCES.resumeUnread);
  // The Undo beside it is true of a bound that fired as of a read that failed: it says the fleet was not read, never why.
  assert.doesNotMatch(UNDO_SENTENCES.resumeUnread, /could not|did not answer/);
  // Past a slow but healthy deployment's first snapshot, and said in the refusal's own words.
  assert.equal(SNAPSHOT_TIMEOUT_MS, 10_000);
  assert.equal(SNAPSHOT_TIMEOUT_SENTENCE, "the fleet did not answer within 10 seconds, so this could not be previewed; nothing was changed");
  // A snapshot that fails at once keeps its own sentence and the Valkey bar: the read failed, which the timeout's words
  // do not say. A snapshot that answers nothing is such a read too, never a timeout.
  assert.equal(SNAPSHOT_UNREAD_SENTENCE, "the fleet could not be read (is Valkey reachable?); nothing was changed");
  assert.equal(RESUME_WAITING_UNKNOWN.unread, "How many jobs wait to start is not known: the fleet could not be read. Each reserves up to its own per-job dollar cap when a worker picks it up");
  for (const snapshot of [async () => { throw new Error("down"); }, async () => null]) {
    const failing = await start({ paths, a: { fleet: { snapshot }, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
    const failed = await failing.act("cancel-held", { jobId: "gh-h1" });
    assert.deepEqual([failed.status, failed.json().error], [503, SNAPSHOT_UNREAD_SENTENCE]);
    assert.equal(title(failed), "The deployment&#39;s Valkey could not be reached");
    const unread = await failing.act("fleet-resume", {});
    assert.ok(unread.json().summary.includes(RESUME_WAITING_UNKNOWN.unread), unread.text);
    assert.ok(!unread.json().summary.includes(RESUME_WAITING_UNKNOWN.timeout), "a failed read is not said to have timed out");
  }
});

// Issue #737: a bulk cancel's row whose answer is partial keeps the mark, and its line says it did not finish.
test("cancel-all-held keeps each row's partial mark: its line says it did not finish, never not done, and its audit row says why", async () => {
  const { paths } = deployment();
  const held = [{ jobId: "gh-h1", label: "jira" }, { jobId: "gh-h2", label: "jira" }, { jobId: "gh-h3", label: "jira" }];
  const unanswered = "the job or its hold may or may not be gone: their removal was asked for and not answered within the bound; look at the fleet (job gh-h2)";
  const answers = { "gh-h1": { ok: true, jobId: "gh-h1", attemptsMade: 0 }, "gh-h2": { invalid: unanswered, partial: true }, "gh-h3": { invalid: "job gh-h3 is not waiting on a condition" } };
  const rm = { ...RM, cancelHeldJob: async ({ jobId }) => answers[jobId] };
  const c = await start({ paths, a: { fleet: { snapshot: async () => ({ held: { rows: held } }) }, rm } });
  const res = (await c.both("cancel-all-held", {})).confirm;
  assert.equal(res.status, 200, res.text);
  const j = res.json();
  assert.deepEqual(j.results, [
    { jobId: "gh-h1", ok: true },
    { jobId: "gh-h2", ok: false, partial: true, reason: unanswered },
    { jobId: "gh-h3", ok: false, reason: "job gh-h3 is not waiting on a condition" },
  ]);
  assert.ok(j.html.includes(`<span class="code">gh-h2</span>: did not finish, ${esc(unanswered)}</span>`), j.html);
  assert.ok(j.html.includes(`<span class="code">gh-h3</span>: not done, job gh-h3 is not waiting on a condition</span>`), j.html);
  assert.deepEqual(c.audit.rows.filter((r) => r.kind === "held-cancel-all" && r.outcome === "failed").map((r) => [r.target, r.reason]), [["gh-h2", unanswered], ["gh-h3", "job gh-h3 is not waiting on a condition"]]);
});

// A preview that throws says so, once, with the console's log as where the reason is.
test("a preview that throws answers 500 with its own sentence and nothing was changed said once", async () => {
  const { paths } = deployment();
  const c = await start({ paths, a: { rm: { ...RM, planFailedBulk: async () => { throw new Error("boom"); } } } });
  const res = await c.act("retry-failed", { jobId: "gh-z" });
  assert.equal(res.status, 500);
  assert.equal(res.json().error, "the preview failed; the console's log has the reason; nothing was changed");
  assert.ok(res.json().html.includes('<p class="banner__t">The preview failed</p>') && res.json().html.includes("The preview failed; the console&#39;s log has the reason; nothing was changed.</p>"), res.json().html);
  assert.equal(res.json().html.match(/nothing was changed/gi).length, 1);
});

test("the previewing skeleton's message state draws its own icon: the hourglass only while busy, the attention mark once the script says why", async () => {
  const { confirmSlotHtml } = await import("../src/console/confirm-view.mjs");
  const { SHELL_CSS } = await import("../src/console/page-css.mjs");
  const slot = String(confirmSlotHtml());
  // Both icons in the head, each marked, before the title the script fills.
  assert.ok(slot.includes('<p class="confirm__h"><span data-slot-icon="busy"><svg class="ic" aria-hidden="true"><use href="#i-hourglass"></use></svg></span><span data-slot-icon="said"><svg class="ic" aria-hidden="true"><use href="#i-attention"></use></svg></span><span data-slot-title>Previewing</span></p>'), slot);
  assert.match(slot, /^<div id="confirm-slot" class="cslot" [^>]*hidden><div class="confirm confirm--busy" aria-busy="true">/, "drawn busy");
  // Which one shows is the busy class's alone, the one thing the script takes off when it says a message (slotSays):
  // busy hides the attention mark, not busy hides the hourglass. Neither rule names the slot, so the preview bars, which
  // carry neither mark, are untouched.
  assert.ok(SHELL_CSS.includes('\n.confirm--busy [data-slot-icon="said"],.confirm:not(.confirm--busy) [data-slot-icon="busy"]{display:none}\n'), "one icon per state");
  assert.ok(SHELL_CSS.includes("\n.confirm__h>[data-slot-icon]{display:inline-flex}\n"), "the wrapper lays out as the icon does");
});

test("the confirm's refusal bars: a write the funnel refused offers Look again, Valkey Try again", async () => {
  const { paths } = deployment();
  let answer = { timeout: true };
  const fleet = { snapshot: async () => ({}), cancelActive: async () => answer };
  const c = await start({ paths, a: { fleet } });
  const late = await c.both("cancel-active", { jobId: "gh-1" });
  assert.equal(late.confirm.status, 409);
  const bar = late.confirm.json().html;
  assert.ok(bar.includes("tone-attention") && bar.includes("The change did not go through") && bar.includes("data-reload>") && bar.includes(">Look again</button>"), bar);
  assert.ok(bar.includes("No worker acknowledged: the job may have just finished"), "the funnel's own sentence, capitalised");
  const rm = { ...RM, retryFailedJob: async () => ({ unreachable: "down" }), planFailedBulk: async () => ({ jobs: [{ jobId: "gh-z", queue: "pi-jobs", attemptsMade: 1, finishedOn: 1 }], more: 0 }) };
  const v = await start({ paths, a: { rm, readJobsData: async () => new Map() } });
  const down = await v.both("retry-failed", { jobId: "gh-z" });
  assert.equal(down.confirm.status, 503);
  assert.equal(down.confirm.json().error, VALKEY_UNREACHABLE);
  assert.ok(down.confirm.json().html.includes("tone-failed") && down.confirm.json().html.includes(">Try again</button>") && down.confirm.json().html.includes("data-again>"));
});

test("the whole-list pause-windows refusals name a window by the index the Configuration page shows, and the list's Undo puts the old list back", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const say = async (windows) => (await c.act("pause-windows", { windows })).json().error;
  assert.equal(await say(["x"]), "pause window at index 0 is not an object; nothing was changed");
  assert.equal(await say([{ scope: "*", from: "01:00", to: "02:00" }, { scope: "*", from: "03:00", to: "04:00", colour: "red" }]), "pause window at index 1 has a field this file does not take (scope, from, to, tz, days, dateFrom, dateTo only); nothing was changed");
  assert.equal(await say([{ scope: "*", from: 1, to: "02:00" }]), "pause window at index 0: from must be a string; nothing was changed");
  const p = (await c.act("pause-windows", { windows: [{ scope: "*", from: "05:00", to: "06:00" }, { scope: "*", from: "07:00", to: "08:00" }] })).json();
  assert.equal(p.undo, "Put the previous pause windows back");
  assert.deepEqual(p.summary, ["Replace the pause windows", "1 window now, 2 after"], "a real plural");
  const done = (await c.confirm("pause-windows", p.ticket)).json();
  assert.deepEqual(done.change.inverse, { action: "pause-windows", body: { windows: [{ scope: "*", from: "01:00", to: "02:00" }] } });
  assert.equal(done.change.summary, "Replaced the pause windows", "the banner says what happened");
  // A file whose list could not be read reads as empty, which is not what it said: that one goes back by hand. The bar
  // points at the preview, which showed it; the banner, on a page with no preview, says the console kept no copy.
  writeFileSync(paths.pauseWindowsPath, "not json\n");
  const unread = await c.both("pause-windows", { windows: [{ scope: "*", from: "05:00", to: "06:00" }] });
  assert.equal(unread.preview.undo, UNDO_SENTENCES.tooBig);
  assert.deepEqual([unread.confirm.json().change.inverse, unread.confirm.json().change.undo], [null, UNDO_SENTENCES.tooBigAfter]);
});

test("a change too big for the session's flash keeps its banner and drops its inverse, saying to put the list back by hand", async () => {
  const { paths } = deployment();
  // A list of windows whose JSON is past FLASH_MAX_BYTES: its inverse (the whole old list) cannot ride the flash.
  const big = Array.from({ length: 400 }, (_, i) => ({ scope: `github:acme/repo-with-a-long-name-${i}`, from: "01:00", to: "02:00", tz: "Europe/Amsterdam", days: ["mon", "tue", "wed"] }));
  writeFileSync(paths.pauseWindowsPath, `${JSON.stringify({ windows: big }, null, 2)}\n`);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > FLASH_MAX_BYTES);
  const c = await start({ paths });
  const { confirm } = await c.both("pause-windows", { windows: [] });
  const { change } = confirm.json();
  // The banner's own sentence: no preview is on the page that shows it.
  assert.deepEqual([change.inverse, change.undo], [null, UNDO_SENTENCES.tooBigAfter]);
  assert.deepEqual(c.sessions.flashes.at(-1).change, change, "the flash was kept, without the inverse");
  assert.ok(Buffer.byteLength(JSON.stringify(change)) <= FLASH_MAX_BYTES);
});

test("the confirm button says what it does: a paid act's most, a destructive act's words, and the bar's ring and fill follow", async () => {
  const { paths } = deployment();
  const job = { jobId: "gh-z", queue: "pi-jobs", attemptsMade: 1, finishedOn: 1 };
  let data = { kind: "github", maxCostUsd: "1.5" };
  const rm = { ...RM, planFailedBulk: async () => ({ jobs: [job], more: 0 }) };
  const fleet = { snapshot: async () => ({ queueCounts: [{ queue: "pi-jobs", paused: false, counts: {} }], held: { rows: [{ jobId: "gh-h1", label: "jira" }, { jobId: "gh-h2", label: "jira" }] } }), cancelActive: async () => ({ ack: "" }) };
  const c = await start({ paths, a: { rm, fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }), readJobsData: async () => new Map([["gh-z", data]]) } });
  const label = async (name, body = {}) => (await c.act(name, body)).json();
  const paid = await label("retry-failed", { jobId: "gh-z" });
  assert.deepEqual([paid.confirmLabel, paid.danger, paid.paid], ["Retry for up to $1.50", false, true]);
  assert.match(paid.html, /^<div class="confirm confirm--paid"><p class="confirm__h"><svg class="ic" aria-hidden="true"><use href="#i-spend"><\/use><\/svg>Retry failed job gh-z on pi-jobs, 1 attempt<\/p>/, "a real plural");
  assert.match(paid.html, /<button class="btn btn--confirm-paid" type="button" data-confirm>Retry for up to \$1\.50<\/button><button class="btn btn--ghost" type="button" data-cancel>Cancel<\/button><span class="ticket">Preview expires in <b data-expires="300000">5:00<\/b><\/span><\/div><\/div>$/, "the expiry is the time left, which the script counts down");
  assert.equal(paid.expiresAt, T0 + 300000);
  // No inverse: "No undo:" and the sentence, in one run after the icon, nothing bold.
  assert.ok(paid.html.includes(`<p class="confirm__undo"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-rerun"></use></svg><span>No undo: ${esc(UNDO_SENTENCES.retried)}</span></p>`), paid.html);
  data = null;
  assert.equal((await label("retry-failed", { jobId: "gh-z" })).confirmLabel, "Retry (reserve unknown)", "never $0 for an unknown reserve");
  data = { kind: "github" };
  writeFileSync(paths.settingsFile, `${JSON.stringify({ maxTurns: 30 }, null, 2)}\n`);
  assert.equal((await label("retry-failed", { jobId: "gh-z" })).confirmLabel, "Retry, 1 job slot", "no per-job cap: the slot is what it holds");
  writeFileSync(paths.settingsFile, `${JSON.stringify({ maxTurns: 30, maxCostUsd: "2" }, null, 2)}\n`);
  const danger = await label("fleet-pause");
  assert.deepEqual([danger.confirmLabel, danger.danger, danger.undo], ["Pause the fleet", true, "Resume the fleet"]);
  assert.match(danger.html, /^<div class="confirm confirm--danger"><p class="confirm__h"><svg class="ic" aria-hidden="true"><use href="#i-attention">/);
  assert.match(danger.html, /<button class="btn btn--confirm-danger" type="button" data-confirm>Pause the fleet<\/button>/);
  assert.ok(danger.html.includes("<use href=\"#i-rerun\"></use></svg><span>Undo: <b>Resume the fleet</b></span></p>"), "the act alone in bold, in one run with \"Undo:\"");
  assert.equal((await label("queue-pause", { queue: "pi-jobs" })).confirmLabel, "Pause queue pi-jobs");
  assert.equal((await label("cancel-active", { jobId: "gh-1" })).confirmLabel, "Cancel the run");
  assert.equal((await label("cancel-all-held")).confirmLabel, "Cancel 2 held jobs");
  assert.equal((await label("remove-all-failed")).confirmLabel, "Remove 1 job");
  // The Configuration page's rows by the index its table and forms show, until it converts (PR 7a).
  assert.equal((await label("trigger-delete", { index: 0 })).confirmLabel, "Delete trigger at index 0");
  assert.equal((await label("pause-window-delete", { index: 0 })).confirmLabel, "Delete pause window at index 0");
  assert.equal((await label("limit-delete", { index: 0 })).confirmLabel, "Delete scoped limit at index 0");
  assert.equal((await label("project-delete", { id: "web" })).confirmLabel, "Delete project web");
  const plain = await label("setting-set", { key: "maxTurns", value: "40" });
  assert.deepEqual([plain.confirmLabel, plain.danger, plain.undo], ["Confirm", false, "Set maxTurns back to 30"]);
  assert.match(plain.html, /^<div class="confirm"><p class="confirm__h"><svg class="ic" aria-hidden="true"><use href="#i-done"><\/use><\/svg>Set maxTurns<\/p>/);
  assert.match(plain.html, /<button class="btn btn--confirm" type="button" data-confirm>Confirm<\/button>/);
  // The change in words, its values in bold (the Actions card): the planner says "maxTurns: 30 to 40".
  assert.ok(plain.html.includes('<ul class="confirm__list"><li>maxTurns: <b>30</b> to <b>40</b></li></ul>'), plain.html);
  assert.deepEqual(plain.summary, ["Set maxTurns", "maxTurns: 30 to 40"]);
  // Resume is paid (every job it lets start reserves), and its button says only what it does.
  const resume = await label("fleet-resume");
  assert.deepEqual([resume.confirmLabel, resume.paid, resume.danger], ["Resume", true, false]);
  // No change: Close only.
  writeFileSync(paths.settingsFile, `${JSON.stringify({ maxTurns: 40, maxCostUsd: "2" }, null, 2)}\n`);
  const same = await label("setting-set", { key: "maxTurns", value: "40" });
  assert.equal(same.unchanged, true);
  // What the file already says, by key and value, the key as code; the answer's summary says it in words.
  assert.equal(same.html, '<div class="confirm confirm--none"><p class="confirm__h"><svg class="ic" aria-hidden="true"><use href="#i-done"></use></svg>No change</p><p class="confirm__note">The file already says this: <span class="code">maxTurns</span> is 40.</p><div class="confirm__act"><button class="btn" type="button" data-close>Close</button></div></div>');
  assert.deepEqual(same.summary, ["the file already says this: maxTurns is 40"]);
  const unsetSame = await label("setting-unset", { key: "dailyCap" });
  assert.deepEqual([unsetSame.unchanged, unsetSame.summary], [true, ["the file already says this: dailyCap is not set"]]);
  assert.ok(unsetSame.html.includes('<p class="confirm__note">The file already says this: <span class="code">dailyCap</span> is not set.</p>'), unsetSame.html);
  // Any other file says the general sentence, capitalised with its full stop under the title that says "No change".
  const pausedSame = await label("pause-windows", { windows: [{ scope: "*", from: "01:00", to: "02:00" }] });
  assert.ok(pausedSame.html.includes('<p class="confirm__note">The file already says this.</p>'), pausedSame.html);
});

test("an Undo is the way back as it was: a key that had no value is unset again, a field an edit gave a value is put back by hand, a replaced resolver keeps no copy", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const undoOf = async (name, body) => {
    const p = (await c.act(name, body)).json();
    assert.equal(typeof p.ticket, "string", `${name}: ${JSON.stringify(p)}`);
    const done = (await c.confirm(name, p.ticket)).json();
    assert.equal(done.change.undo, p.undo, "the bar and the banner say one Undo");
    return done.change;
  };
  // A key the overlay did not hold: its way back is an unset; a key it held: the value it had.
  const first = await undoOf("setting-set", { key: "dailyCap", value: "5" });
  assert.deepEqual([first.undo, first.inverse], ["Unset dailyCap again", { action: "setting-unset", body: { key: "dailyCap" } }]);
  const second = await undoOf("setting-set", { key: "dailyCap", value: "6" });
  assert.deepEqual([second.undo, second.inverse], ["Set dailyCap back to 5", { action: "setting-set", body: { key: "dailyCap", value: "5" } }]);
  const unset = await undoOf("setting-unset", { key: "maxCostUsd" });
  assert.deepEqual([unset.undo, unset.inverse], ["Set maxCostUsd back to 2", { action: "setting-set", body: { key: "maxCostUsd", value: "2" } }], "a dollar key's text as it was written");
  const fresh = deployment().paths;
  const f = await start({ paths: fresh });
  // A model a trigger did not name: an edit cannot remove it, so the way back is by hand.
  const edit = (await f.both("trigger-edit", { index: 0, flow: "review", model: "m1" })).confirm.json().change;
  assert.deepEqual([edit.undo, edit.inverse], ["Edit trigger at index 0 back by hand: model had no value before, and an edit cannot remove one.", null]);
  // Weekdays a pause window did not have: the same. (Its time zone it did have: the reader's default, UTC.)
  const pw = (await f.both("pause-window-edit", { index: 0, days: ["sat"] })).confirm.json().change;
  assert.deepEqual([pw.undo, pw.inverse], ["Edit pause window at index 0 back by hand: days had no value before, and an edit cannot remove one.", null]);
  // A resolver that REPLACED another: the console keeps no copy of the old path, so no inverse carries one.
  writeFileSync(fresh.settingsFile, `${JSON.stringify({ secretProfiles: { prod: "/opt/old-resolver" } }, null, 2)}\n`);
  const replaced = (await f.both("secret-profile-add", { name: "prod", path: "/opt/new-resolver" })).confirm.json().change;
  assert.equal(replaced.inverse, null);
  assert.equal(replaced.undo, "Put profile prod back by hand: the console kept no copy of the resolver it replaced.", "the banner's sentence points at no preview");
  assert.equal(replaced.summary, "Replaced the resolver of profile prod");
  assert.ok(!JSON.stringify(replaced).includes("/opt/"), "no resolver path in the change");
  const added = (await f.both("secret-profile-add", { name: "dev", path: "/opt/dev-resolver" })).confirm.json().change;
  assert.deepEqual([added.undo, added.inverse], ["Remove profile dev", { action: "secret-profile-remove", body: { name: "dev" } }]);
  // A pause of one queue: its way back resumes that queue.
  const fleet = { snapshot: async () => ({ queueCounts: [{ queue: "pi-jobs", paused: false, counts: {} }] }), pauseQueue: async () => ({ ok: true }) };
  const q = await start({ paths: fresh, a: { fleet } });
  const paused = (await q.both("queue-pause", { queue: "pi-jobs" })).confirm.json().change;
  assert.deepEqual([paused.undo, paused.inverse], ["Resume queue pi-jobs", { action: "queue-resume", body: { queue: "pi-jobs" } }]);
});

/** The browser script's own `bodyOf`, cut out of the bundle, so a test reads a form exactly as the page will. */
function scriptBodyOf() {
  const at = CONSOLE_SCRIPT.indexOf("function bodyOf(form) {");
  assert.ok(at >= 0, "the script reads a form with bodyOf");
  const end = CONSOLE_SCRIPT.indexOf("\n  }\n", at);
  return new Function(`${CONSOLE_SCRIPT.slice(at, end + 4)}; return bodyOf;`)();
}
const unescaped = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The Undo form of a done banner as the DOM would hold it: its hidden inputs, each with its name, value and data-type. */
function undoFormOf(banner) {
  const form = /<form data-action="([^"]+)" class="undo" autocomplete="off">([^]*?)<\/form>/.exec(banner);
  assert.ok(form, banner);
  const elements = [...form[2].matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)"(?: data-type="([a-z]+)")?>/g)].map((m) => ({ name: unescaped(m[1]), value: unescaped(m[2]), type: "hidden", disabled: false, getAttribute: (a) => (a === "data-type" ? m[3] ?? null : null) }));
  return { action: form[1], form: { elements } };
}

test("an Undo form reads back, through the script's own bodyOf, exactly the inverse body: an empty name, a list, an object, a number", () => {
  const bodyOf = scriptBodyOf();
  for (const inverse of [
    { action: "project-edit", body: { id: "web", name: "", members: ["github:acme/web", "folder:/srv/a b"] } },
    { action: "setting-set", body: { key: "maxTurns", value: "30" } },
    { action: "pause-window-edit", body: { index: 2, scope: "*", from: "01:00", to: "02:00", tz: "UTC", days: ["sat", "sun"] } },
    { action: "pause-windows", body: { windows: [{ scope: "acme/<web>", from: "01:00", to: "02:00" }] } },
    { action: "limit-edit", body: { index: 0, limit: { scope: "acme/web", day: 10, dayUsd: "2.50" } } },
    { action: "steer-withdraw", body: { jobId: "gh-1", id: "a".repeat(32) } },
    { action: "fleet-resume", body: {} },
  ]) {
    const { action, form } = undoFormOf(String(doneBannerHtml({ summary: "x", by: "alice", auditSeq: 1, undo: "u", inverse })));
    assert.equal(action, inverse.action);
    assert.deepEqual(bodyOf(form), inverse.body, JSON.stringify(inverse));
  }
});

test("capturingAudit remembers the first and the latest row an append returned, passes every row and throw through, and says null for a writer that returns none", () => {
  let seq = 40;
  const rows = [];
  const writer = { append: (row) => (rows.push(row), { ...row, seq: ++seq }) };
  const cap = capturingAudit(writer);
  assert.deepEqual([cap.first(), cap.last()], [null, null]);
  assert.equal(cap.append({ outcome: "ok" }).seq, 41);
  cap.append({ outcome: "ok" });
  cap.append({ outcome: "failed" });
  assert.deepEqual([cap.first(), cap.last(), rows.length], [41, 43, 3]);
  const silent = capturingAudit({ append: () => undefined });
  silent.append({});
  assert.deepEqual([silent.first(), silent.last()], [null, null]);
  const full = capturingAudit({ append: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } });
  assert.throws(() => full.append({}), { code: "ENOSPC" });
  assert.equal(full.first(), null, "a refused append is no row");
  // The banner with no seq says the log holds its row, with no link it cannot vouch for.
  const banner = String(doneBannerHtml({ summary: "Changed maxTurns from 30 to 40", by: "alice", auditSeq: null, count: 1, undo: "Set maxTurns back to 30", inverse: { action: "setting-set", body: { key: "maxTurns", value: "30" } } }));
  assert.ok(banner.includes("Changed by alice. The audit log holds its row. <b>Undo:</b> Set maxTurns back to 30.</p>") && !banner.includes("<a "), banner);
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

// ---- cancel-queued, and the re-run's Undo it makes (issue #737) ---------------------------------------------------------
//
// The planner and the funnel (`planCancelQueued`, `cancelQueuedJob`, job-actions.mjs) are faked here, by the shapes
// their contract names: these tests hold what the console does with each answer. The funnel's own rules against real
// BullMQ are `cancel-queued.test.mjs`'s.

const UNTIL = T0 + 12 * 60_000;
/** A `readWaiting`-shaped row for job `jobId`, with `over` laid on top. */
const waitingRow = (jobId, over = {}) => ({ jobId, queue: "pi-jobs@build3", state: "delayed", bucket: "slot", why: "host-slot", known: true, dueAt: UNTIL, queuedAt: T0 - 60_000, recordedAt: T0 - 1000, untilAt: UNTIL, project: "web", projectFrom: "record", host: "build3", holder: null, endpoint: null, budgetWhy: null, trigger: 0, attempt: null, attempts: null, attemptsMade: 0, stalled: 0, kind: "github", held: null, ...over });
/** `planCancelQueued`'s plan for job `jobId`, its waiting row `waiting`. */
const queuedPlan = (jobId, waiting = waitingRow(jobId), over = {}) => ({ plan: { jobId, queue: "pi-jobs@build3", state: "delayed", held: false, attemptsMade: 0, stalledCounter: 0, kind: "github", target: "acme/web#4", waiting, ...over } });
const CANCEL_LINE = "It is removed from its queue before it starts; the run records of other jobs are not touched.";

test("a waiting job's line is the worker's own sentence filled from its row: times as <time>, a missing value says the bucket, an unknown reason its token", () => {
  const said = (over) => {
    const line = waitingLine(waitingRow("gh-w", over));
    return [line.text, String(html`${line.bar}`)];
  };
  assert.deepEqual(said({}), ["build3 has no free job slot", "build3 has no free job slot"]);
  assert.deepEqual(said({ why: "host-budget" }), ["build3's budget has no room for it yet", "build3&#39;s budget has no room for it yet"], "escaped in the bar, as typed in the text");
  assert.deepEqual(said({ why: "pause-window", bucket: "pause" }), ["In a pause window until 2026-10-15 12:12 UTC", 'In a pause window until <time datetime="2026-10-15T12:12:00.000Z">2026-10-15 12:12 UTC</time>']);
  // The record's own instant first; the delayed set's due when the record holds none.
  assert.equal(said({ why: "wait-after", bucket: "check", untilAt: UNTIL + 60_000 })[0], "Held until 2026-10-15 12:13 UTC");
  assert.equal(said({ why: "wait-after", bucket: "check", untilAt: null })[0], "Held until 2026-10-15 12:12 UTC");
  assert.deepEqual(said({ why: "retry", bucket: "retry", attempt: 2, attempts: 3 }), ["Attempt 2 of 3 at 2026-10-15 12:12 UTC", 'Attempt 2 of 3 at <time datetime="2026-10-15T12:12:00.000Z">2026-10-15 12:12 UTC</time>']);
  assert.equal(said({ why: "chained", bucket: "run", holder: "gh-parent" })[0], "Chained after gh-parent; starts when its folder is free");
  assert.equal(said({ why: "endpoint", endpoint: "local-gpu" })[0], "Every slot of model endpoint local-gpu is taken");
  assert.equal(said({ why: "scope-folder", host: null })[0], "Its folder is busy with another run", "a sentence with no placeholder needs no value");
  // A value the sentence needs and the row lacks: the bucket's title, which is true without it, never a hole.
  assert.equal(said({ host: null })[0], "Waiting for a free slot");
  assert.equal(said({ why: "chained", bucket: "run", holder: null })[0], "Waiting for another run to finish");
  assert.equal(said({ why: "wait-hold", bucket: "check", untilAt: null, dueAt: null })[0], "Waiting on a time or a check");
  assert.equal(said({ why: "retry", bucket: "retry", attempt: 2, attempts: null })[0], "Retry backoff");
  // A reason a newer worker wrote that this console has no words for: its token, and that there is no explanation yet.
  assert.deepEqual(said({ why: "frobnicate", known: false, bucket: "none" }), ["Recorded reason: frobnicate, no explanation yet", 'Recorded reason: <span class="code">frobnicate</span>, no explanation yet']);
  // The reader puts such a row in its own bucket, `unknown`; the line is the token's all the same, never a bucket title.
  assert.deepEqual(said({ why: "frobnicate", known: false, bucket: "unknown" }), said({ why: "frobnicate", known: false, bucket: "none" }));
  // No reason, or none a reason's charset admits: the bucket's title, "No reason was recorded" among them.
  assert.equal(said({ why: null, known: false, bucket: "none" })[0], "No reason was recorded");
  assert.equal(said({ why: "<b>x</b>", known: false, bucket: "none" })[0], "No reason was recorded");
  assert.equal(said({ why: null, known: false, bucket: "paused", state: "paused" })[0], "In a paused queue");
  assert.equal(said({ why: null, known: false, bucket: "slot", state: "waiting" })[0], "Waiting for a free slot");
  assert.equal(said({ why: null, known: false, bucket: "toString" })[0], "No reason was recorded", "a bucket outside the table is none");
  // A value is escaped wherever it comes from.
  assert.equal(said({ host: "<b>h</b>" })[1], "&lt;b&gt;h&lt;/b&gt; has no free job slot");
  assert.equal(waitingLine(null), null);
  // Past its due with no worker taking it: the due line, whatever the record said; without a due, the bucket's title.
  assert.deepEqual(said({ bucket: "due" }), ["Due since 2026-10-15 12:12 UTC; no worker has taken it", 'Due since <time datetime="2026-10-15T12:12:00.000Z">2026-10-15 12:12 UTC</time>; no worker has taken it']);
  assert.equal(said({ bucket: "due", why: null, known: false, untilAt: null })[0], "Due since 2026-10-15 12:12 UTC; no worker has taken it");
  assert.equal(said({ bucket: "due", dueAt: null })[0], DEFER_BUCKET_WORDS.due.title);
  // An instant no date can show is missing: never "at unknown", the record's own falls back to the due, then the title.
  assert.equal(said({ why: "retry", bucket: "retry", attempt: 5, attempts: 6, untilAt: 9e15 })[0], "Attempt 5 of 6 at 2026-10-15 12:12 UTC");
  assert.equal(said({ why: "retry", bucket: "retry", attempt: 5, attempts: 6, untilAt: 9e15, dueAt: -9e15 })[0], "Retry backoff");
  assert.equal(said({ why: "pause-window", bucket: "pause", untilAt: null, dueAt: 2.44e296 })[0], "In a pause window");
  assert.equal(said({ bucket: "due", dueAt: 8.64e15 + 1 })[0], DEFER_BUCKET_WORDS.due.title);
  // The last instant the leaf passes on is drawn with its four-digit year; past it is missing, though a Date holds it,
  // since the year 275760 cut to sixteen characters is a date that is not the instant's.
  assert.equal(said({ bucket: "due", dueAt: DEFER_TIME_MAX_MS })[0], "Due since 9999-12-31 23:59 UTC; no worker has taken it");
  assert.equal(said({ bucket: "due", dueAt: DEFER_TIME_MAX_MS + 1 })[0], DEFER_BUCKET_WORDS.due.title);
  assert.equal(said({ bucket: "due", dueAt: 8.64e15 })[0], DEFER_BUCKET_WORDS.due.title);
  // And before the epoch: an instant below 0 is missing too, never drawn as a date in 1969.
  assert.equal(said({ bucket: "due", dueAt: -1 })[0], DEFER_BUCKET_WORDS.due.title);
  assert.equal(said({ why: "pause-window", bucket: "pause", untilAt: 8.64e15, dueAt: null })[0], "In a pause window");
  for (const odd of [9e15, -9e15, 2.44e296, 8.64e15 + 1]) assert.ok(!said({ untilAt: odd, dueAt: odd, why: "wait-after", bucket: "check" })[0].includes("unknown"), String(odd));
  // Every reason the worker can record reads as its own sentence from a full row, with no placeholder left in it.
  const full = { untilAt: UNTIL, host: "build3", holder: "gh-parent", endpoint: "local-gpu", attempt: 2, attempts: 3 };
  for (const [why, { bucket, sentence }] of Object.entries(DEFER_WHYS)) {
    const [text, bar] = said({ ...full, why, bucket });
    assert.ok(!/[{}]/.test(text) && !/[{}]/.test(bar), `${why}: ${text}`);
    assert.notEqual(text, DEFER_BUCKET_WORDS[bucket].title, `${why}: its own sentence`);
    assert.equal(text.split(/build3|gh-parent|local-gpu|2026-10-15 12:12 UTC|\b[23]\b/).join("{}"), sentence.replace(/\{[a-z]+\}/g, "{}"), `${why}: the worker's words`);
  }
});

test("cancel-queued: the preview says why the job waits, red with no undo; the confirm holds the job to the preview and writes one cancel-queued row", async () => {
  const { paths } = deployment();
  const plans = [];
  const removals = [];
  let plan = queuedPlan("gh-q1", waitingRow("gh-q1"), { target: "acme/web#4<b>" });
  let removed = { ok: true, jobId: "gh-q1", queue: "pi-jobs@build3", held: false };
  const rm = { ...RM, planCancelQueued: async (args) => (plans.push(args), plan), cancelQueuedJob: async (args) => (removals.push(args), removed) };
  const c = await start({ paths, a: { rm } });
  const p = await c.act("cancel-queued", { jobId: "gh-q1" });
  assert.equal(p.status, 200, p.text);
  const pj = p.json();
  assert.deepEqual(plans, [{ url: paths.valkeyUrl, jobId: "gh-q1", queue: null }], "the planner asked by id, the queue left to it");
  assert.deepEqual([pj.kind, pj.paid, pj.danger, pj.confirmLabel, pj.undo], ["cancel-queued", false, true, "Cancel the queued job", UNDO_SENTENCES.cancelledQueued]);
  assert.deepEqual(pj.summary, ["Cancel queued job gh-q1 (acme/web#4<b>)", "build3 has no free job slot", CANCEL_LINE]);
  assert.match(pj.html, /^<div class="confirm confirm--danger"><p class="confirm__h"><svg class="ic" aria-hidden="true"><use href="#i-attention"><\/use><\/svg>Cancel queued job gh-q1 \(acme\/web#4&lt;b&gt;\)<\/p>/);
  assert.ok(pj.html.includes(`<ul class="confirm__list"><li>build3 has no free job slot</li><li>${CANCEL_LINE}</li></ul>`), pj.html);
  assert.ok(pj.html.includes(`<span>No undo: ${esc(UNDO_SENTENCES.cancelledQueued)}</span>`), "no inverse: muted, nothing bold");
  assert.ok(pj.html.includes('<button class="btn btn--confirm-danger" type="button" data-confirm>Cancel the queued job</button>'));
  // A time in the reason is a <time> in the bar, and UTC text in the answer's words.
  plan = queuedPlan("gh-q1", waitingRow("gh-q1", { why: "pause-window", bucket: "pause" }));
  const timed = (await c.act("cancel-queued", { jobId: "gh-q1", queue: "pi-jobs@build3" })).json();
  assert.equal(plans.at(-1).queue, "pi-jobs@build3", "a queue the form names goes to the planner");
  assert.equal(timed.summary[1], "In a pause window until 2026-10-15 12:12 UTC");
  assert.ok(timed.html.includes('<li>In a pause window until <time datetime="2026-10-15T12:12:00.000Z">2026-10-15 12:12 UTC</time></li>'), timed.html);
  // A plan whose waiting row could not be read says nothing about why, rather than guess.
  plan = queuedPlan("gh-q1", null);
  assert.deepEqual((await c.act("cancel-queued", { jobId: "gh-q1" })).json().summary, ["Cancel queued job gh-q1 (acme/web#4)", CANCEL_LINE]);
  // The confirm: the funnel gets the preview's expect, the job's row is written, the banner has no Undo button.
  plan = queuedPlan("gh-q1");
  const ok = await c.both("cancel-queued", { jobId: "gh-q1" });
  assert.equal(ok.confirm.status, 200, ok.confirm.text);
  assert.deepEqual(removals.at(-1), { url: paths.valkeyUrl, jobId: "gh-q1", expect: { queue: "pi-jobs@build3", attemptsMade: 0, stalledCounter: 0 } });
  const done = ok.confirm.json();
  assert.deepEqual([done.ok, done.jobId, done.queue, done.held], [true, "gh-q1", "pi-jobs@build3", false]);
  assert.deepEqual([done.change.summary, done.change.undo, done.change.inverse, done.change.kind], ["Cancelled queued job gh-q1", UNDO_SENTENCES.cancelledQueued, null, "cancel-queued"]);
  const row = lastWrite(c);
  assert.deepEqual([row.kind, row.target, row.outcome], ["cancel-queued", "gh-q1", "ok"]);
  // A held job's removal says so.
  removed = { ok: true, jobId: "gh-q1", queue: "pi-jobs@build3", held: true };
  assert.equal((await c.both("cancel-queued", { jobId: "gh-q1" })).confirm.json().held, true);
});

test("cancel-queued refusals: the planner's sentence as it is, a Valkey that did not answer in fixed words, and a job that started since the preview refused at the confirm with a failed row", async () => {
  const { paths } = deployment();
  let plan = { refusal: "job gh-q2 has made 1 attempt and waits to retry: a retry keeps its run's steer and held replies open for the next attempt, so the console cancels only a job that never started; once it runs, Cancel on its run page stops it; nothing was changed" };
  let removed = { invalid: "job gh-q2 started since the preview; nothing was changed" };
  const rm = { ...RM, planCancelQueued: async () => plan, cancelQueuedJob: async () => removed };
  const c = await start({ paths, a: { rm } });
  const retried = await c.act("cancel-queued", { jobId: "gh-q2" });
  assert.equal(retried.status, 400);
  assert.equal(retried.json().error, plan.refusal, "the planner's words, byte for byte");
  assert.equal(retried.json().ticket, undefined, "no ticket for a refusal");
  assert.match(retried.json().html, /The change was refused/);
  plan = { refusal: "job gh-q2 is active, not waiting to start; nothing was changed", status: 409 };
  assert.equal((await c.act("cancel-queued", { jobId: "gh-q2" })).status, 409, "the planner's status is kept");
  plan = { unreachable: "connect ECONNREFUSED 10.9.8.7:6379" };
  const down = await c.act("cancel-queued", { jobId: "gh-q2" });
  assert.deepEqual([down.status, down.json().error], [503, "the queued job could not be read (is Valkey reachable?); nothing was changed"]);
  assert.ok(!down.text.includes("10.9.8.7"), "the read's own error, which names a host, is not the page's");
  assert.match(down.json().html, /data-again>Try again<\/button>/);
  plan = { plan: { jobId: "gh-q2" } };
  assert.equal((await c.act("cancel-queued", { jobId: "gh-q2" })).json().error, "the change could not be planned", "a plan that names no queue is none");
  assert.equal((await c.act("cancel-queued", { jobId: "<b>" })).status, 400, "a job id outside the charset is refused");
  // The job started between the preview and the confirm: the funnel's sentence, 409, the ok row then a failed one.
  plan = queuedPlan("gh-q2");
  const started = await c.both("cancel-queued", { jobId: "gh-q2" });
  assert.equal(started.confirm.status, 409);
  assert.equal(started.confirm.json().error, removed.invalid);
  assert.match(started.confirm.json().html, /The change did not go through/);
  assert.deepEqual(c.audit.rows.filter((r) => r.kind === "cancel-queued").map((r) => [r.target, r.outcome, r.reason ?? null]), [["gh-q2", "ok", null], ["gh-q2", "failed", removed.invalid]]);
  removed = { unreachable: "connect ECONNREFUSED 10.9.8.7:6379" };
  const lost = await c.both("cancel-queued", { jobId: "gh-q2" });
  assert.deepEqual([lost.confirm.status, lost.confirm.json().error], [503, VALKEY_UNREACHABLE]);
  // The removal was sent and Valkey did not answer: it may have landed, so the bar says the change did not finish and
  // never that nothing was changed.
  removed = { invalid: "the job may or may not have been removed: its removal was asked for and not answered within the bound; look at the fleet (job gh-q2)", partial: true };
  const unsure = await c.both("cancel-queued", { jobId: "gh-q2" });
  assert.equal(unsure.confirm.status, 409);
  assert.match(unsure.confirm.json().html, /The change did not finish/);
  assert.ok(!unsure.confirm.json().html.includes("Nothing was changed"), unsure.confirm.json().html);
});

test("managed forks use single-use paid confirmation, preserve point binding and redact the message from audit", async () => {
  const { paths } = deployment();
  const message = "fork-message-canary-secret";
  let applied = 0;
  const rm = { ...RM,
    planRunFork: async (args) => {
      assert.deepEqual([args.jobId, args.entry, args.position, args.message], ["gh-source", "abc123", "before", message]);
      return { plan: { queue: "pi-jobs", branch: "pi/issue-7-fork-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", job: { fork: { id: "a".repeat(32), fromEntry: args.entry, position: args.position } }, reserve: { slots: 1, dollarsMicros: 2_000_000 }, request: args } };
    },
    enqueueRunFork: async (plan) => {
      applied++;
      assert.equal(plan.request.message, message);
      return { ok: true, jobId: "gh-fork", queue: "pi-jobs" };
    },
  };
  const c = await start({ paths, a: { rm } });
  const viewer = await c.cookieFor(VIEW_TOKEN);
  assert.equal((await c.act("run-fork", { jobId: "gh-source", point: "abc123:before", message }, viewer)).status, 403);
  const p = await c.act("run-fork", { jobId: "gh-source", point: "abc123:before", message });
  assert.equal(p.status, 200, p.text);
  assert.match(p.json().summary.join("\n"), /Branch pi\/issue-7-fork-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(applied, 0);
  const ticket = p.json().ticket;
  const done = await c.confirm("run-fork", ticket);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json().change.inverse, { action: "cancel-queued", body: { jobId: "gh-fork", queue: "pi-jobs" } });
  assert.equal((await c.confirm("run-fork", ticket)).status, 409);
  assert.equal(applied, 1);
  assert.doesNotMatch(JSON.stringify(c.audit.rows), new RegExp(message));
});

test("a re-run's Undo is decided at the confirm: the bar says the banner will offer it, and the banner's Undo is a cancel-queued form for the job it queued", async () => {
  const { paths } = deployment();
  const queued = { ok: true, jobId: "cron:t0:1760530000000", queue: "pi-jobs" };
  const plans = [];
  const rm = {
    ...RM,
    planRerun: async () => ({ plan: { kind: "cron", jobId: "cron:t0:1760520000000", queue: "pi-jobs", schedule: {}, job: { flow: "nightly" }, runFields: null, reserve: { slots: 1, dollarsMicros: 2_000_000, capMicros: 2_000_000, zeroRated: false } } }),
    enqueueRerun: async () => queued,
    planCancelQueued: async (args) => (plans.push(args), queuedPlan(args.jobId, waitingRow(args.jobId, { queue: "pi-jobs", why: null, known: false, bucket: "slot", state: "waiting" }), { queue: "pi-jobs", state: "waiting" })),
  };
  const c = await start({ paths, a: { rm } });
  const p = (await c.act("rerun", { jobId: "cron:t0:1760520000000" })).json();
  // Undoable at the preview although no inverse exists yet: the act in bold, never "No undo:".
  assert.equal(p.undo, UNDO_SENTENCES.rerunBefore);
  assert.ok(p.html.includes(`<span>Undo: <b>${esc(UNDO_SENTENCES.rerunBefore)}</b></span>`), p.html);
  const res = await c.confirm("rerun", p.ticket);
  assert.equal(res.status, 200, res.text);
  const { change } = res.json();
  assert.equal(change.undo, "Cancel cron:t0:1760530000000 before it starts");
  assert.deepEqual(change.inverse, { action: "cancel-queued", body: { jobId: "cron:t0:1760530000000", queue: "pi-jobs" } });
  assert.deepEqual(c.sessions.flashes.at(-1).change, change, "the banner the next page shows carries it");
  // The banner draws it as a form for that cancel, which the script reads back to exactly that body.
  const banner = String(doneBannerHtml(change));
  assert.ok(banner.includes("<b>Undo:</b> Cancel cron:t0:1760530000000 before it starts.</p>"), banner);
  const { action, form } = undoFormOf(banner);
  const body = scriptBodyOf()(form);
  assert.deepEqual([action, body], ["cancel-queued", change.inverse.body]);
  // Pressing it previews that cancel like any other write: a new ticket, the new job by id and queue.
  const undo = await c.act(action, body);
  assert.equal(undo.status, 200, undo.text);
  assert.deepEqual(plans, [{ url: paths.valkeyUrl, jobId: "cron:t0:1760530000000", queue: "pi-jobs" }]);
  assert.deepEqual(undo.json().summary, ["Cancel queued job cron:t0:1760530000000 (acme/web#4)", "Waiting for a free slot", CANCEL_LINE]);
});

test("an Undo decided at the confirm that cannot be offered costs the banner its button, never the answer: 200, a sentence that says so and a log line", async () => {
  const { paths } = deployment();
  const logs = [];
  const rows = [];
  let enqueued = 0;
  let t = T0;
  const deps = {
    now: () => t,
    log: (line) => logs.push(line),
    fs: nodeFs,
    config: {},
    tickets: makeConfirmTickets({ now: () => t }),
    audit: { append: (row) => (rows.push(row), { ...row, seq: rows.length }) },
    sessions: { setFlash: () => true },
    hub: null,
    actionDeps: { rm: { ...RM, planRerun: async () => ({ plan: { kind: "cron", queue: "pi-jobs", schedule: {}, job: {}, runFields: null, reserve: null } }), enqueueRerun: async () => ((enqueued += 1), { ok: true, jobId: "cron:t0:1", queue: "pi-jobs" }) }, paths, env: {} },
  };
  const ctxOf = (step, body) => ({ deps, session: { id: "s1", name: "alice", role: "operator" }, body, route: { path: `/api/act/rerun/${step}` }, record: () => {}, json: (status, b) => ({ status, body: b }), actor: () => ({ name: "alice", role: "operator", session: "a1b2c3d4e5f6" }) });
  const rerun = ACTIONS.find((a) => a.name === "rerun");
  // The rule at the confirm, broken two ways: an inverse naming no action, and an Undo sentence that throws.
  const broken = [
    { ...rerun, inverse: (out, body, result) => (result === undefined ? null : { action: "no-such-action", body: {} }) },
    { ...rerun, undo: (out, body, result) => { if (result !== undefined) throw new TypeError("no words"); return UNDO_SENTENCES.rerunBefore; } },
  ];
  for (const action of broken) {
    const p = await previewAction(ctxOf("preview", { jobId: "cron:t0:0" }), action);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const c = await confirmAction(ctxOf("confirm", { ticket: p.body.ticket }), action);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual([c.body.ok, c.body.jobId, c.body.change.inverse, c.body.change.undo], [true, "cron:t0:1", null, UNDO_SENTENCES.rerunUnnamed]);
    assert.equal(logs.at(-1), "console: the rerun Undo could not be decided after the write (error); its banner offers none");
  }
  assert.equal(enqueued, 2, "each write landed once");
  assert.deepEqual(rows.map((r) => [r.kind, r.outcome]), [["run-rerun", "ok"], ["run-rerun", "ok"]], "one ok row each, no failed row: the write landed");
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

test("a fleet resume's Undo pauses again exactly what was paused before it, never every queue: the fleet, one queue, or the queues named to pause by hand", async () => {
  // From a fleet partly paused (one host's queue), Resume fleet and then its Undo paused all seven queues: the hosts
  // the operator had left running stopped too.
  const { paths } = deployment();
  const names = ["pi-jobs", "pi-jobs@alpha", "pi-jobs@beta", "pi-jobs@gamma", "pi-jobs@delta", "pi-jobs@eps", "pi-jobs@zeta"];
  let pausedNow = new Set(["pi-jobs@beta"]);
  let answers = true;
  const acted = [];
  const fleet = {
    snapshot: async () => (answers ? { queueCounts: names.map((queue) => ({ queue, paused: pausedNow.has(queue), counts: { waiting: 1 } })) } : null),
    resume: async () => (acted.push(["resume"]), (pausedNow = new Set()), { results: [{ shown: "redis://h/0", res: { ok: true, queues: names } }] }),
    pause: async () => (acted.push(["pause"]), (pausedNow = new Set(names)), { results: [{ shown: "redis://h/0", res: { ok: true, queues: names } }] }),
    pauseQueue: async ({ queue, paused }) => (acted.push([paused ? "pause" : "resume", queue]), paused ? pausedNow.add(queue) : pausedNow.delete(queue), { ok: true }),
  };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  // One queue paused: the Undo is that queue's pause, and previewing then confirming it pauses that queue alone.
  const one = await c.both("fleet-resume", {});
  assert.match(one.preview.html, /Undo: <b>Pause queue pi-jobs@beta again<\/b>/);
  const change = one.confirm.json().change;
  assert.deepEqual([change.undo, change.inverse], ["Pause queue pi-jobs@beta again", { action: "queue-pause", body: { queue: "pi-jobs@beta" } }]);
  await c.both(change.inverse.action, change.inverse.body);
  assert.deepEqual(acted, [["resume"], ["pause", "pi-jobs@beta"]], "the Undo paused the one queue that was paused, never the fleet");
  assert.deepEqual([...pausedNow], ["pi-jobs@beta"]);
  // Two of seven: no one write carries the set, so there is no inverse, and the sentence names them.
  pausedNow = new Set(["pi-jobs@alpha", "pi-jobs@gamma"]);
  const two = await c.both("fleet-resume", {});
  assert.match(two.preview.html, /No undo: Pause queues pi-jobs@alpha, pi-jobs@gamma again by hand, one at a time: no single write pauses only those\./);
  assert.deepEqual([two.confirm.json().change.inverse, two.confirm.json().change.undo], [null, "Pause queues pi-jobs@alpha, pi-jobs@gamma again by hand, one at a time: no single write pauses only those."]);
  // The whole fleet: the fleet's pause, as before.
  pausedNow = new Set(names);
  const all = await c.both("fleet-resume", {});
  assert.deepEqual(all.confirm.json().change.inverse, { action: "fleet-pause", body: {} });
  // A fleet that did not answer names no set: no inverse, never every queue.
  answers = false;
  const blind = await c.both("fleet-resume", {});
  assert.deepEqual([blind.confirm.json().change.inverse, blind.confirm.json().change.undo], [null, UNDO_SENTENCES.resumeUnread]);
  assert.ok(!acted.slice(2).some(([what]) => what === "pause"), "no Undo paused anything by itself");
});

test("a queue's own switch asks the reader for that queue, so one past the queues a preview reads is still found and switched", async () => {
  // The reader reads a bounded number of the switch's queues and always the one a preview names (`opts.queue`).
  const { paths } = deployment();
  const asked = [];
  const acted = [];
  const fleet = {
    snapshot: async (opts) => {
      asked.push(opts ?? null);
      const named = typeof opts?.queue === "string" ? [{ queue: opts.queue, paused: false, counts: { waiting: 0, paused: 0 } }] : [];
      return { queueCounts: [{ queue: "pi-jobs", paused: false, counts: { waiting: 0, paused: 0 } }, ...named], switchTotal: 250, switchTruncated: true, switchIncomplete: null };
    },
    pauseQueue: async ({ queue, paused }) => (acted.push([paused ? "pause" : "resume", queue]), { ok: true }),
  };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  const r = await c.both("queue-pause", { queue: "pi-jobs@far" });
  assert.equal(r.confirm.status, 200, r.confirm.text);
  assert.deepEqual(acted, [["pause", "pi-jobs@far"]]);
  assert.ok(asked.length > 0 && asked.every((o) => o?.switchQueues === true && o?.queue === "pi-jobs@far"), JSON.stringify(asked));
});

test("a fleet or queue switch previews over the queues the switch flips: a stopped host's paused queue is named, counted, and paused again by the Undo", async () => {
  // The registry names alpha and beta; zeta's host left it, while its queue, its paused flag and its two jobs stay. The
  // resume flips zeta too, so a preview over the registry's queues hid zeta's jobs and its Undo left zeta running.
  const { paths } = deployment();
  const registry = ["pi-jobs", "pi-jobs@alpha", "pi-jobs@beta"];
  const flipped = [...registry, "pi-jobs@zeta"];
  let pausedNow = new Set(["pi-jobs@beta", "pi-jobs@zeta"]);
  const asked = [];
  const acted = [];
  const rows = (names) => names.map((queue) => ({ queue, paused: pausedNow.has(queue), counts: { paused: queue === "pi-jobs@zeta" && pausedNow.has(queue) ? 2 : 0, waiting: 0 } }));
  const fleet = {
    snapshot: async (opts) => (asked.push(opts?.switchQueues === true), { queueCounts: rows(opts?.switchQueues === true ? flipped : registry) }),
    resume: async () => (acted.push(["resume"]), (pausedNow = new Set()), { results: [{ shown: "redis://h/0", res: { ok: true, queues: flipped } }] }),
    pauseQueue: async ({ queue, paused }) => (acted.push([paused ? "pause" : "resume", queue]), paused ? pausedNow.add(queue) : pausedNow.delete(queue), { ok: true }),
  };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  const two = await c.both("fleet-resume", {});
  assert.equal(two.preview.count, 2, "zeta's jobs are counted: the resume lets them start");
  assert.match(two.preview.html, /2 jobs wait to start in the paused queues \(pi-jobs@beta, pi-jobs@zeta\)/, "the preview names what it resumes");
  assert.deepEqual([two.confirm.json().change.inverse, two.confirm.json().change.undo], [null, "Pause queues pi-jobs@beta, pi-jobs@zeta again by hand, one at a time: no single write pauses only those."]);
  // Zeta alone: its queue's pause is the Undo, and that queue's own preview takes it (the write does: setQueuePausedOne).
  pausedNow = new Set(["pi-jobs@zeta"]);
  const one = await c.both("fleet-resume", {});
  const change = one.confirm.json().change;
  assert.deepEqual([change.undo, change.inverse], ["Pause queue pi-jobs@zeta again", { action: "queue-pause", body: { queue: "pi-jobs@zeta" } }]);
  const undo = await c.both(change.inverse.action, change.inverse.body);
  assert.equal(undo.confirm.status, 200, undo.confirm.text);
  assert.deepEqual([...pausedNow], ["pi-jobs@zeta"], "the Undo paused zeta again, and nothing else");
  assert.deepEqual(acted, [["resume"], ["resume"], ["pause", "pi-jobs@zeta"]]);
  assert.ok(asked.length > 0 && asked.every(Boolean), "every switch preview read the switch's queues");
  // The fleet's pause only when every queue the switch flips was paused: the registry's three of four is a set no write
  // carries, since Pause fleet would stop zeta, which was running.
  pausedNow = new Set(registry);
  assert.equal((await c.both("fleet-resume", {})).confirm.json().change.inverse, null);
  pausedNow = new Set(flipped);
  assert.deepEqual((await c.both("fleet-resume", {})).confirm.json().change.inverse, { action: "fleet-pause", body: {} });
});

// Issue #737: the switch's queues as one preview read them can be short: a keyspace scan that did not finish
// (`switchIncomplete`), or a fleet of more queues than a preview reads (`switchTruncated`).
test("a short switch read never claims an exact Undo: paused before is not known, the waiting count is a floor, and a queue it did not read is not called foreign", async () => {
  const { paths } = deployment();
  const names = ["pi-jobs", "pi-jobs@alpha", "pi-jobs@beta"];
  let shape = {};
  const fleet = {
    snapshot: async () => ({ queueCounts: names.map((queue) => ({ queue, paused: true, counts: { waiting: 2 } })), ...shape }),
    resume: async () => ({ results: [{ shown: "redis://h/0", res: { ok: true, queues: names } }] }),
    pauseQueue: async () => ({ ok: true }),
  };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  // A whole read: every queue was paused, so the fleet's pause is the exact way back.
  const whole = await c.both("fleet-resume", {});
  assert.deepEqual(whole.confirm.json().change.inverse, { action: "fleet-pause", body: {} });
  assert.ok(whole.preview.summary.includes("6 jobs wait to start in the paused queues (pi-jobs, pi-jobs@alpha, pi-jobs@beta): each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up, so no single reserve figure applies"), JSON.stringify(whole.preview.summary));
  assert.equal(whole.preview.count, 6, "a whole read's count is exact");
  assert.deepEqual([lastWrite(c).kind, lastWrite(c).count], ["fleet-resume", 6], "and rides the audit row");
  const read3 = "This preview read 3 of the 2003 queues the switch flips, so these counts are of those it read, and floors; the switch itself flips every queue";
  for (const [over, line] of [[{ switchIncomplete: "the queue scan stopped at 10.9.8.7" }, SWITCH_SHORT_LINES.incomplete], [{ switchTruncated: true }, SWITCH_SHORT_LINES.truncated], [{ switchTruncated: true, switchTotal: 2003 }, read3]]) {
    shape = over;
    const p = await c.both("fleet-resume", {});
    const said = JSON.stringify(over);
    assert.deepEqual([p.confirm.json().change.inverse, p.confirm.json().change.undo], [null, UNDO_SENTENCES.resumeShort], `${said}: no exact inverse over part of the set`);
    assert.ok(p.preview.summary.includes("At least 6 jobs wait to start in the paused queues (pi-jobs, pi-jobs@alpha, pi-jobs@beta): each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up, so no single reserve figure applies"), `${said}: a floor`);
    assert.ok(p.preview.summary.includes(line), `${said}: why it is a floor`);
    // A floor is said in the line ("At least"), never carried as a count: the ticket and the audit row take exact ones.
    assert.equal(p.preview.count, undefined, `${said}: a floor is no count`);
    assert.equal(p.confirm.status, 200, p.confirm.text);
    assert.deepEqual([lastWrite(c).kind, lastWrite(c).count ?? null], ["fleet-resume", null], `${said}: the audit row carries no count`);
    assert.ok(!JSON.stringify(p.preview).includes("10.9.8.7"), `${said}: the scan's own reason is never shown`);
    // A queue the short read did not see may exist: never "not a queue this deployment drains".
    const q = await c.act("queue-resume", { queue: "pi-jobs@zeta" });
    assert.equal(q.status, 400, q.text);
    assert.equal(q.json().error, queueUnreadRefusal("pi-jobs@zeta"));
  }
  assert.equal(queueUnreadRefusal("pi-jobs@zeta"), "\"pi-jobs@zeta\" is not among the queues this preview read, and it did not read every queue, so whether this deployment drains it is not known here; nothing was changed");
  // The read's numbers only where they say a read of fewer than all; else the line without them.
  assert.equal(switchReadLine(3, 2003), read3);
  for (const [n, total] of [[3, null], [3, 3], [3, 2], [null, 2003], [-1, 2003]]) assert.equal(switchReadLine(n, total), SWITCH_SHORT_LINES.truncated, `${n} of ${total}`);
  shape = { switchIncomplete: "x", switchTruncated: true };
  const both = await c.both("fleet-resume", {});
  assert.deepEqual(both.preview.summary.slice(-2), [SWITCH_SHORT_LINES.incomplete, SWITCH_SHORT_LINES.truncated], "both, in that order");
  // No reason and no flag: a whole read again.
  shape = { switchIncomplete: null, switchTruncated: false };
  assert.deepEqual((await c.both("fleet-resume", {})).confirm.json().change.inverse, { action: "fleet-pause", body: {} });
});

test("a cut fleet resume preview names how many queues it read, running ones included, of how many the switch flips", async () => {
  // Three queues read of ten, two of them paused: the line counts the queues the preview read, not the paused ones.
  const snap = {
    queueCounts: [
      { queue: "pi-jobs", paused: true, counts: { waiting: 1 } },
      { queue: "pi-jobs@a", paused: false, counts: { waiting: 0 } },
      { queue: "pi-jobs@b", paused: true, counts: { waiting: 2 } },
    ],
    switchTruncated: true,
    switchTotal: 10,
  };
  const ctx = { a: { fleet: { snapshot: async () => snap }, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }), urlShown: () => "redis://h/0" } };
  const p = await ACTIONS.find((a) => a.name === "fleet-resume").preview({}, ctx);
  assert.equal(switchReadLine(3, 10), "This preview read 3 of the 10 queues the switch flips, so these counts are of those it read, and floors; the switch itself flips every queue");
  assert.ok(p.summary.includes(switchReadLine(3, 10)), JSON.stringify(p.summary));
});

test("a switch preview names at most SWITCH_QUEUES_NAMED queues, then how many more; past that many paused queues its Undo is by hand", async () => {
  const { paths } = deployment();
  // Two thousand queues, the shape that once made a 134,000-character line: the registry's three running, the rest paused.
  const names = ["pi-jobs", "pi-jobs@alpha", "pi-jobs@beta", ...Array.from({ length: 2000 }, (_, i) => `pi-jobs@planted-${String(i).padStart(4, "0")}`)];
  const fleet = {
    snapshot: async () => ({ queueCounts: names.map((queue, i) => ({ queue, paused: i >= 3, counts: { waiting: i >= 3 ? 1 : 0 } })) }),
    resume: async () => ({ results: [{ shown: "redis://h/0", res: { ok: true, queues: names } }] }),
  };
  const c = await start({ paths, a: { fleet, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  assert.equal(SWITCH_QUEUES_NAMED, 20);
  const p = await c.both("fleet-resume", {});
  const first = names.slice(3, 23).join(", ");
  const line = p.preview.summary.find((l) => l.includes("to start in the paused queues"));
  assert.equal(line, `2000 jobs wait to start in the paused queues (${first}, and 1980 more): each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up, so no single reserve figure applies`);
  assert.ok(!line.includes("planted-0020"), "the 21st is not named");
  assert.ok(JSON.stringify(p.preview).length < 20_000, `${JSON.stringify(p.preview).length} characters`);
  assert.deepEqual([p.confirm.json().change.inverse, p.confirm.json().change.undo], [null, "Pause the 2000 queues that were paused again by hand, one at a time: no single write pauses only those, and the console kept no list of them."]);
  assert.equal(p.preview.undo, "Pause the 2000 queues that were paused again by hand, one at a time: no single write pauses only those, and this preview names only the first 20.");
  assert.deepEqual(resumeManyUndo(2000), { bar: p.preview.undo, after: p.confirm.json().change.undo }, "the two sentences are resumeManyUndo's");
  // A queue's refusal names at most as many of them.
  const q = await c.act("queue-resume", { queue: "pi-jobs@ghost" });
  assert.equal(q.json().error, `"pi-jobs@ghost" is not a queue this deployment drains (${names.slice(0, 20).join(", ")}, and 1983 more); nothing was changed`);
  // Twenty are all named, and the Undo still names them; one queue named is that queue.
  const twenty = names.slice(0, 23);
  const small = await start({ paths, a: { fleet: { ...fleet, snapshot: async () => ({ queueCounts: twenty.map((queue, i) => ({ queue, paused: i >= 3, counts: { waiting: 0 } })) }) }, killSwitchPlanFn: () => ({ urls: ["redis://h/0"], disagreement: null }) } });
  const s = await small.both("fleet-resume", {});
  assert.ok(s.preview.summary.some((l) => l.includes(`(${twenty.slice(3).join(", ")}):`)), JSON.stringify(s.preview.summary));
  assert.equal(s.confirm.json().change.undo, `Pause queues ${twenty.slice(3).join(", ")} again by hand, one at a time: no single write pauses only those.`);
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
  assert.match(p.html, /<li>gh-a on pi-jobs, 1 attempt, reserve \$1\.50<\/li>/);
  assert.match(p.html, /<li>gh-b on pi-jobs, 2 attempts, reserve unknown<\/li>/);
  // Real plurals, and "not" lower case, in bold where it carries the meaning (the ConfirmStates card's line).
  assert.match(p.html, /<li>3 more match and are <b>not in this action<\/b> \(at most 100 per action\)<\/li>/);
  assert.deepEqual([p.summary[0], p.summary.at(-1)], ["Retry 2 failed jobs; each is re-checked and acted on alone", "3 more match and are not in this action (at most 100 per action)"]);
  assert.match(p.html, /Together they hold 2 job slots and \$1\.50 for the 1 job whose reserve is known in each dollar window that applies; the reserve of 1 job is unknown \(its data could not be read\), so the total is at least this\./);
  assert.equal(p.targets[1].reserve.unknown, true);
  const res = await c.confirm("retry-all-failed", p.ticket);
  assert.equal(res.status, 200, res.text);
  const r = res.json();
  assert.deepEqual([r.count, r.done], [2, 1]);
  assert.deepEqual(acted[0], [{ jobId: "gh-a", attemptsMade: 1, finishedOn: 5 }, { jobId: "gh-b", attemptsMade: 2, finishedOn: 6 }], "the funnel got exactly the previewed list and fingerprints");
  const rows = c.audit.rows.filter((x) => x.kind === "failed-retry-all");
  assert.deepEqual(rows.map((x) => [x.target, x.outcome, x.count, x.reserve ?? null]), [["gh-a", "ok", 2, 1_500_000], ["gh-b", "ok", 2, null], ["gh-b", "failed", 2, null]]);
  assert.equal(new Set(rows.map((x) => x.ticket)).size, 1, "one ticket digest shared by every job's rows");
  // Issue #737: the bar said what Confirm does, with a floor where a reserve is unknown; the answer links the rows.
  assert.deepEqual([p.confirmLabel, p.danger, p.undo], ["Retry 2, at least $1.50", false, UNDO_SENTENCES.retried]);
  assert.match(p.html, /<button class="btn btn--confirm-paid" type="button" data-confirm>Retry 2, at least \$1\.50<\/button>/);
  assert.match(p.html, /^<div class="confirm confirm--paid">/);
  assert.deepEqual([r.change.auditSeq, r.change.auditLast, r.change.count, r.change.inverse], [rows[0].seq, rows[1].seq, 2, null], "the first and the last ok row, never a compensating one");
  // What happened, how many of how many, in the attention tone, since one job was not done.
  assert.deepEqual([r.change.summary, r.change.done, r.change.count], ["Retried failed jobs: 1 of 2 done", 1, 2]);
  assert.ok(String(doneBannerHtml(r.change)).startsWith('<div class="banner tone-attention" role="status">'), "a banner over part of a bulk act is not a success");
  assert.match(r.html, /^<div class="banner tone-attention" role="status">/, "a refused job makes it attention");
  assert.ok(r.html.includes("<p class=\"banner__t\">1 of 2 retried</p>"), r.html);
  // How many rows, from the first, linked to it; never "rows A to B", which another writer's row can sit inside.
  assert.ok(r.html.includes(`<a class="link" href="/audit?seq=${rows[0].seq}#seq-${rows[0].seq}">2 audit rows, from row ${rows[0].seq}</a>.`), r.html);
  assert.ok(String(doneBannerHtml(r.change)).includes(`>2 audit rows, from row ${rows[0].seq}</a>.`));
  assert.ok(r.html.includes("<span class=\"code\">gh-b</span>: not done, job gh-b failed again since the preview (it changed since the preview)</span>"), r.html);
  assert.ok(r.html.includes(">Reload</button>") && r.html.includes("data-reload>"), "Reload is the step forward");
});

// Issue #737: a bulk act's banner says how many of its jobs landed, and only all of them is a success.
test("a bulk confirm where no job landed leaves no banner; part of the list is attention and says how many; all of it is ok; a one-job list's row is one row", async () => {
  const { paths } = deployment();
  const jobs = ["gh-a", "gh-b", "gh-c"].map((jobId, i) => ({ jobId, queue: "pi-jobs", attemptsMade: 1, finishedOn: i + 1 }));
  let landed = [];
  let list = jobs;
  let ticks = 0;
  const rm = { ...RM, planFailedBulk: async () => ({ jobs: list, more: 0 }), removeFailedJobs: async ({ jobs: sent }) => ({ results: sent.map((j) => (landed.includes(j.jobId) ? { jobId: j.jobId, ok: true } : { jobId: j.jobId, invalid: "it changed since the preview" })) }) };
  const c = await start({ paths, a: { rm }, hub: { tick: () => (ticks += 1), endSession() {} } });
  // None landed: the results bar says so, and no banner follows the reload.
  const none = (await c.both("remove-all-failed", { queue: "pi-jobs" })).confirm.json();
  assert.deepEqual([none.done, none.count, none.change], [0, 3, null]);
  assert.equal(c.sessions.flashes.length, 0, "no flash: a banner over nothing done read as a success");
  assert.equal(ticks, 0, "nothing changed, so no open tab is told to redraw");
  assert.ok(none.html.includes('<p class="banner__t">0 of 3 removed</p>'), none.html);
  // Part of it: the attention tone, and how many of how many.
  landed = ["gh-a"];
  const some = (await c.both("remove-all-failed", { queue: "pi-jobs" })).confirm.json();
  assert.deepEqual([some.change.summary, some.change.done, some.change.count], ["Removed failed jobs in pi-jobs: 1 of 3 done", 1, 3]);
  const someBanner = String(doneBannerHtml(c.sessions.flashes.at(-1).change));
  assert.match(someBanner, /^<div class="banner tone-attention" role="status">/);
  assert.ok(someBanner.includes('<p class="banner__t">Removed failed jobs in pi-jobs: 1 of 3 done</p>'), someBanner);
  // All of it: the ok tone, what happened in the past tense, and the rows it wrote counted from the first.
  landed = ["gh-a", "gh-b", "gh-c"];
  const all = (await c.both("remove-all-failed", { queue: "pi-jobs" })).confirm.json();
  assert.equal(all.change.summary, "Removed 3 failed jobs in pi-jobs");
  const allBanner = String(doneBannerHtml(all.change));
  assert.match(allBanner, /^<div class="banner tone-ok" role="status">/);
  assert.ok(allBanner.includes(`>3 audit rows, from row ${all.change.auditSeq}</a>.`), allBanner);
  assert.equal(ticks, 2);
  // A one-job list wrote one row, and both the bar and the banner say "Audit row N", never a range of one.
  list = [jobs[0]];
  const one = (await c.both("remove-all-failed", { queue: "pi-jobs" })).confirm.json();
  assert.equal(one.change.summary, "Removed 1 failed job in pi-jobs");
  assert.ok(String(doneBannerHtml(one.change)).includes(`>Audit row ${one.change.auditSeq}</a>.`) && one.html.includes(`>Audit row ${one.change.auditSeq}</a>.`), one.html);
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
  assert.match(p.html, /web: weight 3, repos acme\/web, acme\/api, reason: launch &lt;week&gt;/, "repos and reason, escaped");
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
  // Issue #737: the row by the index the form asks for ("History row # (newest is 0)"), until PR 7a.
  assert.equal(none.json().error, "history row at index 1 carries no split to go back to");
  assert.equal((await c.act("allocation-revert", { index: 5 })).json().error, "no allocation history row at index 5 (have 2)");
  const p = (await c.act("allocation-revert", { index: 0 })).json();
  assert.match(p.summary[0], /^Revert the allocation to history row at index 0 \(writer operator-revert\)$/);
  assert.deepEqual([p.undo, p.confirmLabel], [UNDO_SENTENCES.allocation, "Confirm"]);
  state.digest = "d2";
  const stale = await c.confirm("allocation-revert", p.ticket);
  assert.equal(stale.status, 409);
  assert.match(stale.json().error, /allocation envelope changed since the preview; nothing was reverted/);
  assert.equal(state.reverted.length, 0);
  // A revert previewed and confirmed for real, so the banner's index is the one the preview's ticket carries
  // (never "index ?", which a ticket without it would say).
  const back = await c.both("allocation-revert", { index: 0 });
  assert.equal(back.confirm.status, 200, back.confirm.text);
  assert.deepEqual(state.reverted.map((r) => r.target), [{ at: "2026-10-15T00:00:00Z", outcome: "applied", planId: "p1", weights: { web: 2 } }]);
  const { change } = back.confirm.json();
  assert.equal(change.summary, "Reverted the allocation to history row at index 0");
  assert.ok(String(doneBannerHtml(change)).includes('<p class="banner__t">Reverted the allocation to history row at index 0</p>'), "the banner names the row");
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
  assert.match(p.html, /3 jobs wait to start in the paused queues \(pi-jobs\): each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up/);
  assert.equal(p.reserve, null, "no single reserve figure applies");
  assert.equal((await c.confirm("fleet-resume", p.ticket)).status, 200);
  const row = lastWrite(c);
  assert.deepEqual([row.kind, row.count, row.reserve], ["fleet-resume", 3, undefined]);
  const q = (await c.act("queue-resume", { queue: "pi-jobs" })).json();
  assert.equal(q.count, 3);
  assert.match(q.html, /3 jobs wait to start in it \(pi-jobs\)/);
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
  assert.match(free.html, /<p class="confirm__note">It holds 1 job slot and \$0\.00: every model it may call is zero-rated\.<\/p>/);
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
  assert.ok(re.html.includes(`<li>It runs as its trigger says now: ${fields}</li>`), re.html);
  const pa = (await c.act("parked-answer", { jobId: "gh-r", text: "hi" })).json();
  assert.ok(pa.html.includes(`<li>It runs as the comment trigger says now: ${fields}</li>`), pa.html);
  for (const out of [re, pa]) assert.ok(!JSON.stringify(out).includes("op://"), "never a secret reference");
  // A model and cap the job leaves to the deployment say so.
  runFields.model = null;
  runFields.maxCostUsd = null;
  assert.match((await c.act("rerun", { jobId: "gh-r" })).json().html, /model the deployment&#39;s default; allowed models a\/b, c\/d; per-job cap the deployment&#39;s;/);
});

// ---- the large diff ------------------------------------------------------------------------------------------------

test("a one-line change in a 3000-line file previews small and shows the change; a diff past the cap is cut with a count", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  // Near the start (only the suffix is common), the middle, and near the end (only the prefix is common).
  for (const at of [5, 1500, 2990]) {
    const after = before.replace(`line ${at}\n`, `line ${at} changed\n`);
    const out = String(diffHtmlOf(before, after));
    assert.ok(out.length < 1000, `${at}: small, ${out.length} bytes`);
    assert.ok(out.includes(`<span class="d-del">line ${at}</span><span class="d-add">line ${at} changed</span>`), `${at}: the change`);
    assert.ok(out.includes(`<span class="d-ctx">line ${at - 2}</span>`), `${at}: with a little context`);
    assert.ok(!out.includes(`line ${at - 100}<`) && !out.includes(`line ${(at + 100) % 3000}<`), `${at}: and not the rest`);
  }
  const everyLine = Array.from({ length: 3000 }, (_, i) => `other ${i}`).join("\n");
  const big = String(diffHtmlOf(before, everyLine));
  assert.equal((big.match(/<span class="d-/g) ?? []).length, DIFF_LINES_MAX + 1, "the cap, then one line saying how many more");
  assert.match(big, /<span class="d-gap">\u2026 and 4000 more diff lines, not shown<\/span><\/div><\/div>$/);
  const one = String(diffHtmlOf(Array.from({ length: 2000 }, (_, i) => `a${i}`).join("\n"), ""));
  assert.match(one, /\u2026 and 1 more diff line, not shown<\/span>/, "a real plural");
});

// ---- the browser script ----------------------------------------------------------------------------------------------

test("the script writes markup in exactly three places: the confirm slot, the panel swap behind data-panel, and the transcript append into [data-transcript]", () => {
  // Issue #737: the preview's bar goes into the page's ONE confirm slot (the answer's `html`, and the skeleton it
  // restores), never into the form or its section; a panel swap stays behind data-panel; the transcript append as before.
  const writes = CONSOLE_SCRIPT.match(/[\w.]+\.(?:innerHTML|outerHTML)\s*=|[\w.]*insertAdjacentHTML|document\.write/g) ?? [];
  assert.deepEqual([...new Set(writes.map((w) => w.replace(/\s+/g, "")))].sort(), ["el.innerHTML=", "slot.innerHTML=", "tbox.insertAdjacentHTML"]);
  // Issue #643: `tbox` is bound once, to the page's [data-transcript] element, and the append writes the entry's
  // server-rendered html (a string, checked) at its end and nowhere else.
  assert.deepEqual(CONSOLE_SCRIPT.match(/\btbox\s*=(?!=)/g), ["tbox ="]);
  assert.match(CONSOLE_SCRIPT, /var tbox = document\.querySelector\("\[data-transcript\]"\);/);
  assert.match(CONSOLE_SCRIPT, /if \(!msg \|\| typeof msg\.html !== "string"\) return;\n[^]*?tbox\.insertAdjacentHTML\("beforeend", msg\.html\);/);
  assert.equal((CONSOLE_SCRIPT.match(/new EventSource\(/g) ?? []).length, 1, "the transcript uses the page's only connection");
  assert.doesNotMatch(CONSOLE_SCRIPT, /new EventSource\("\/api\/transcript/, "terminal-only endpoint is not opened by the browser");
  assert.match(CONSOLE_SCRIPT, /es\.addEventListener\("tdone"/, "transcript completion leaves the page stream open");
  assert.ok(!/form\.innerHTML|area\.innerHTML|diffHtml/.test(CONSOLE_SCRIPT), "never the form, never a per-form preview area, never the old answer field");
  // `slot` is bound once, to the element the server drew with the slot's id (embedded as JSON from confirm-view.mjs).
  assert.deepEqual(CONSOLE_SCRIPT.match(/\bslot\s*=(?!=)/g), ["slot ="]);
  assert.ok(CONSOLE_SCRIPT.includes(JSON.stringify(CONFIRM_SLOT_ID)), "the slot's id comes from confirm-view.mjs");
  assert.match(CONSOLE_SCRIPT, /var slot = document\.getElementById\(/);
  assert.match(CONSOLE_SCRIPT, /var form = ev\.target;\n\s+if \(!form \|\| !form\.matches \|\| !form\.matches\("form\[data-action\]"\)\) return;/);
  // The panel swap: only an element the server marked data-panel.
  assert.match(CONSOLE_SCRIPT, /if \(!el \|\| !el\.hasAttribute\("data-panel"\)\) return;/);
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
    parked: [{ jobId: "gh-4", kind: "github", target: "o/r#2", parkedAt: 1, ageMs: 1, pendingScan: { jobId: null } }],
    triggers: { triggers: [] },
  };
  const panels = [fleetQueues, fleetActive, fleetHeld, fleetFailed, parkedQuestions, configTriggers];
  // The parked answer form follows the planner's check the page read for the row (issue #737), as the page hands it.
  const view = (role, readOnly = false) => ({ data: { snapshot, now: 10, parkedChecks: { "gh-4": { ok: true } } }, role, readOnly, env: {}, now: 10, query: {} });
  for (const render of panels) {
    assert.match(String(render(view("operator"))), /data-action="/, `${render.name || "panel"} has controls for an operator`);
    assert.ok(!String(render(view("viewer"))).includes("data-action"), "none for a viewer");
    assert.ok(!String(render(view("operator", true))).includes("data-action"), "none on a read-only console");
  }
  const run = (jobId, role = "operator", readOnly = false) => String(runActionsPanel({ data: { run: { record: { jobId, startedAt: null } } }, role, readOnly, env: {}, now: 0, query: {} })).replace(/<\/?span[^>]*>/g, "");
  assert.match(run("repeat:nightly:1760500000000"), /<code>pi-dispatch sandbox repeat:nightly:1760500000000<\/code>/);
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
    assert.match(p.html, /\$1\.50 \(the per-job cap\)/);
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

test("fleet-resume on Valkey, through the real fleet reader: a paused queue whose host left the registry is named, counted, resumed and paused again by the Undo", live, async () => {
  const v = await freshValkey();
  const { paths } = deployment(URL13);
  // The registry names beta alone; zeta's host is gone, its queue and its jobs are not.
  const fleet = RM.createFleetReader(paths, { readOnly: true, readLiveHostsFn: async () => ({ hosts: [{ name: "beta", routes: "true" }] }) });
  try {
    await v.q("pi-jobs");
    const beta = await v.q("pi-jobs@beta");
    const zeta = await v.q("pi-jobs@zeta");
    for (const id of ["gh-z1", "gh-z2"]) await zeta.add("github", { kind: "github" }, { jobId: id });
    await beta.pause();
    await zeta.pause();
    const c = await start({ paths, a: { fleet } });
    const both = await c.both("fleet-resume", {});
    assert.equal(both.preview.count, 2, both.preview.html);
    assert.match(both.preview.html, /2 jobs wait to start in the paused queues \(pi-jobs@beta, pi-jobs@zeta\)/);
    assert.equal(both.confirm.status, 200, both.confirm.text);
    assert.deepEqual([await beta.isPaused(), await zeta.isPaused()], [false, false], "the resume reached zeta");
    assert.deepEqual([both.confirm.json().change.inverse, both.confirm.json().change.undo], [null, "Pause queues pi-jobs@beta, pi-jobs@zeta again by hand, one at a time: no single write pauses only those."]);
    await zeta.pause();
    const one = await c.both("fleet-resume", {});
    const change = one.confirm.json().change;
    assert.deepEqual(change.inverse, { action: "queue-pause", body: { queue: "pi-jobs@zeta" } });
    const undo = await c.both(change.inverse.action, change.inverse.body);
    assert.equal(undo.confirm.status, 200, undo.confirm.text);
    assert.deepEqual([await beta.isPaused(), await zeta.isPaused()], [false, true], "the Undo paused zeta again, and beta stays running");
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
    assert.match(p.html, /<p class="confirm__note">It holds 1 job slot and \$1\.25 \(the per-job cap\)/);
    assert.match(p.html, /It runs as its trigger says now: flow fix; model the deployment&#39;s default; per-job cap \$1\.25/, "the run fields the plan took from the trigger, not the retained job's $9");
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
    // A body naming its own author is refused by name (issue #737): `by` is the session's, never the body's.
    const claimed = await c.act("parked-answer", { jobId, text: `${ANSWER}\n<b>bold</b>`, by: "mallory" });
    assert.equal(claimed.status, 400);
    assert.equal(claimed.json().error, "parked-answer takes jobId, text only; by is not one of them, so nothing was changed");
    const p = await c.act("parked-answer", { jobId, text: `${ANSWER}\n<b>bold</b>` });
    assert.equal(p.status, 200, p.text);
    const pj = p.json();
    assert.equal(pj.reserve.dollarsMicros, 1_250_000, "a paid action shows its reserve");
    assert.ok(pj.html.includes("<span class=\"d-ctx\">&lt;b&gt;bold&lt;/b&gt;</span>"), "the answer is shown escaped, one line per line");
    assert.equal(pj.afterDigest, sha256(`${ANSWER}\n<b>bold</b>`));
    // A plan built the same way BEFORE the answer is queued (once it is, the planner refuses: issue #647, being answered).
    const again = await RM.planParkedAnswer({ url: URL13, logsDir: paths.logsDir, jobId, text: `${ANSWER}\n<b>bold</b>`, by: "alice", triggersPath: paths.triggersPath, runsFn: async () => [] });
    const res = await c.confirm("parked-answer", pj.ticket);
    assert.equal(res.status, 200, res.text);
    const [queuedId] = res.json().jobIds;
    assert.equal(queuedId, forgeDeliveryJobId("github", (await shared.getJob(queuedId)).data.trigger.deliveryId));
    const job = (await shared.getJob(queuedId)).data;
    assert.deepEqual(job.console, { by: "alice" }, "by is the session's token name, whatever the body said");
    assert.equal(job.trigger.comment.body, `${ANSWER}\n<b>bold</b>`);
    // The queued job is the plan's: a plan built the same way differs only in its fresh delivery id.
    // `kind` is the producer's (enqueueForgeJob stamps it on the queued data), not the plan's.
    const strip = ({ kind: _k, ...d }) => ({ ...d, trigger: { ...d.trigger, deliveryId: null } });
    assert.deepEqual(strip(job), strip(again.plan.job));
    // And now that the answer is queued, a second one is refused by name, before any job is built (issue #647).
    const third = await RM.planParkedAnswer({ url: URL13, logsDir: paths.logsDir, jobId, text: "again", by: "alice", triggersPath: paths.triggersPath, runsFn: async () => [] });
    assert.equal(third.refusal, `${jobId} is being answered: ${queuedId} is queued or running on org/repo#7`);
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.target, row.afterDigest, row.reserve], ["parked-answer", jobId, sha256(`${ANSWER}\n<b>bold</b>`), 1_250_000]);
  } finally {
    await v.done();
  }
});

test("steer and steer-withdraw refuse by the planner's own words before any ticket: a bad mode, an empty or oversize message, a bad message id; a viewer is refused 403", async () => {
  const { paths } = deployment();
  const c = await start({ paths });
  const bad = await c.act("steer", { jobId: "gh-1", text: "x", mode: "later" });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /mode must be steer or followUp; nothing was changed/);
  const empty = await c.act("steer", { jobId: "gh-1", text: " \u0007 " });
  assert.equal(empty.status, 400);
  assert.match(empty.json().error, /the message is empty/);
  const big = await c.act("steer", { jobId: "gh-1", text: "x".repeat(8193) });
  assert.match(big.json().error, /above the 8192-byte limit; shorten it\. Nothing was sent/);
  assert.match((await c.act("steer-withdraw", { jobId: "gh-1", id: "nope" })).json().error, /id must be a message id/);
  for (const id of ["A".repeat(32), "a".repeat(31), "a".repeat(33), `x${"a".repeat(32)}`, `${"a".repeat(32)}\n`]) assert.equal((await c.act("steer-withdraw", { jobId: "gh-1", id })).status, 400, `the message id rule is exact: ${JSON.stringify(id)}`);
  const viewer = await c.cookieFor(VIEW_TOKEN);
  for (const name of ["steer", "steer-withdraw"]) {
    const v = await c.post(`/api/act/${name}/preview`, { jobId: "gh-1", text: STEER_TEXT, id: "a".repeat(32) }, { cookie: viewer });
    assert.equal(v.status, 403, `${name}: a viewer is refused`);
  }
  assert.equal(c.audit.rows.filter((r) => r.action === "write" && r.outcome === "ok").length, 0, "nothing was written");
});

test("steer on Valkey: the preview shows the text escaped, no new reserve and the sha256; the confirm pushes it as the session's message; only the digest is audited; withdraw says guaranteed or best effort", live, async () => {
  const v = await freshValkey();
  const { Worker } = await import("bullmq");
  let release;
  const held = new Promise((r) => (release = r));
  let worker = null;
  try {
    const { paths } = deployment(URL13);
    const shared = await v.q("pi-jobs");
    await shared.add("github", { kind: "github", repo: "o/r", steer: true, target: { type: "issue", number: 4 } }, { jobId: "gh-st1" });
    worker = new Worker("pi-jobs", () => held, { connection: parseConnection(URL13) });
    await until(async () => (await (await shared.getJob("gh-st1"))?.getState()) === "active");
    const c = await start({ paths });
    // Active and armed, but the relay has not opened the run: refused at the preview with the CLI's sentence.
    const shut = await c.act("steer", { jobId: "gh-st1", text: STEER_TEXT });
    assert.equal(shut.status, 400);
    assert.match(shut.json().error, /the run is not accepting messages/);
    await registerLive({ redis: v.redis, runId: "gh-st1", host: "h1" });
    const typed = `${STEER_TEXT}\n<b>bold</b>`;
    const claimed = await c.act("steer", { jobId: "gh-st1", text: typed, mode: "followUp", by: "mallory" });
    assert.equal(claimed.json().error, "steer takes jobId, mode, text only; by is not one of them, so nothing was changed", "the author is the session's, never the body's");
    const p = await c.act("steer", { jobId: "gh-st1", text: typed, mode: "followUp" });
    assert.equal(p.status, 200, p.text);
    const pj = p.json();
    assert.equal(pj.paid, true);
    assert.equal(pj.reserve, null, "no new reserve");
    assert.equal(pj.afterDigest, sha256(typed));
    assert.ok(pj.html.includes("&lt;b&gt;bold&lt;/b&gt;") && !pj.html.includes("<b>bold"), "the text is shown escaped");
    assert.match(pj.html, /spends from this run&#39;s existing reservation: no new reserve is taken/);
    assert.match(pj.html, /<p class="confirm__h"><svg class="ic" aria-hidden="true"><use href="#i-spend"><\/use><\/svg>Send a follow-up to running job gh-st1, as alice/, "the summary's first line is the bar's title, with the paid icon");
    assert.match(pj.html, /<li>The agent reads it once it would otherwise stop, and the run goes on from it\.<\/li>/);
    assert.match(pj.html, /<li>The audit log keeps the message&#39;s sha256, never its text\.<\/li>/);
    assert.match(pj.html, /<div class="diff"><div class="diff__b"><span class="d-ctx">stop and run the migrations first, steer-canary-2d9a<\/span><span class="d-ctx">&lt;b&gt;bold&lt;\/b&gt;<\/span><\/div><\/div>/, "the text, one line per element, escaped");
    const res = await c.confirm("steer", pj.ticket);
    assert.equal(res.status, 200, res.text);
    const rj = res.json();
    const change = { summary: "Sent a follow-up to running job gh-st1", by: "alice", auditSeq: lastWrite(c).seq, auditLast: null, count: 1, done: 1, undo: `Withdraw message ${rj.id} before the agent reads it`, inverse: { action: "steer-withdraw", body: { jobId: "gh-st1", id: rj.id } }, kind: "steer", at: T0 };
    assert.deepEqual(rj, { ok: true, jobId: "gh-st1", id: rj.id, mode: "followUp", state: "queued", action: "steer", kind: "steer", beforeDigest: null, afterDigest: sha256(typed), change }, "the answer's whole shape: ids and states, never the text");
    assert.match(rj.id, /^[0-9a-f]{32}$/);
    assert.deepEqual([pj.confirmLabel, pj.danger, pj.undo], ["Send follow-up", false, change.undo]);
    assert.ok(!JSON.stringify(c.sessions.flashes).includes("steer-canary"), "the banner names the message by its id, never its text");
    const stored = (await readInbox({ redis: v.redis, runId: "gh-st1" })).entries;
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].id, stored[0].source, stored[0].author, stored[0].text, stored[0].mode], [rj.id, "console", { kind: "operator", by: "alice" }, typed, "followUp"], "by is the session's token name, whatever the body said");
    const row = lastWrite(c);
    assert.deepEqual([row.kind, row.target, row.afterDigest, row.reserve ?? null], ["steer", `gh-st1#${rj.id}`, sha256(typed), null], "the row names the job and the message id, never the text, and no reserve");
    assert.ok(!JSON.stringify(c.audit.rows).includes("steer-canary"), "the audit rows carry the digest, never the text");
    // Withdraw: queued is guaranteed.
    const w1 = await c.act("steer-withdraw", { jobId: "gh-st1", id: rj.id });
    assert.equal(w1.status, 200, w1.text);
    assert.match(w1.json().html, /It is queued: the worker has not written it into the run yet, so withdrawing it is guaranteed/);
    const done1 = await c.confirm("steer-withdraw", w1.json().ticket);
    assert.equal(done1.status, 200, done1.text);
    assert.deepEqual([done1.json().prior, done1.json().guaranteed], ["queued", true]);
    assert.match(done1.json().said, /\(guaranteed\)/);
    assert.deepEqual([lastWrite(c).kind, lastWrite(c).target, lastWrite(c).outcome], ["steer-withdraw", `gh-st1#${rj.id}`, "ok"]);
    // The default mode is steer, and its summary says when the agent reads it.
    const dflt = (await c.act("steer", { jobId: "gh-st1", text: "default mode" })).json();
    assert.match(dflt.html, /Send a steer to running job gh-st1, as alice \(message [0-9a-f]{32}, 12 bytes\)<\/p><ul class="confirm__list"><li>The agent reads it after its current tool calls, before its next model call\.<\/li>/);
    const dj = (await c.confirm("steer", dflt.ticket)).json();
    assert.equal(dj.mode, "steer");
    assert.equal((await readInbox({ redis: v.redis, runId: "gh-st1" })).entries.at(-1).mode, "steer");
    // A withdraw previewed queued whose message the relay writes before the confirm: the answer is the script's state.
    const wm = await c.act("steer-withdraw", { jobId: "gh-st1", id: dj.id });
    assert.match(wm.json().html, /It is queued/);
    await markState({ redis: v.redis, runId: "gh-st1", id: dj.id, from: ["queued"], to: "written" });
    const moved = (await c.confirm("steer-withdraw", wm.json().ticket)).json();
    assert.deepEqual([moved.prior, moved.guaranteed], ["written", false], "the prior named is the one the withdraw met, not the preview's");
    // Withdraw: written is best effort, in the preview and the answer.
    const p2 = (await c.both("steer", { jobId: "gh-st1", text: "second" })).confirm.json();
    await markState({ redis: v.redis, runId: "gh-st1", id: p2.id, from: ["queued"], to: "written" });
    const w2 = await c.act("steer-withdraw", { jobId: "gh-st1", id: p2.id });
    assert.match(w2.json().html, /already written into the run&#39;s inbox, so withdrawing it is best effort/);
    const done2 = (await c.confirm("steer-withdraw", w2.json().ticket)).json();
    assert.deepEqual([done2.prior, done2.guaranteed], ["written", false]);
    assert.match(done2.said, /best effort/);
    // A message delivered between the preview and the confirm: 409, nothing changed, a failed row.
    const p3 = (await c.both("steer", { jobId: "gh-st1", text: "third" })).confirm.json();
    const w3 = await c.act("steer-withdraw", { jobId: "gh-st1", id: p3.id });
    await markState({ redis: v.redis, runId: "gh-st1", id: p3.id, from: ["queued"], to: "delivered" });
    const late = await c.confirm("steer-withdraw", w3.json().ticket);
    assert.equal(late.status, 409);
    assert.match(late.json().error, /already delivered/);
    assert.equal(c.audit.rows.at(-1).outcome, "failed");
    // The run closes after a preview: the confirm is refused, never accepted and silently unseen.
    const p4 = await c.act("steer", { jobId: "gh-st1", text: "fourth" });
    await closeInbox({ redis: v.redis, runId: "gh-st1" });
    const closed = await c.confirm("steer", p4.json().ticket);
    assert.equal(closed.status, 409);
    assert.match(closed.json().error, /the run has finished and its inbox is closed/);
  } finally {
    release();
    await worker?.close();
    await v.done();
  }
});

test("envelope-set: the preview lists each field it changes, through the worker's parser, and writes nothing", async () => {
  const { dir, paths } = deployment();
  paths.envelopeFile = join(dir, "envelope.json");
  const envelope = `${JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { web: "10", _other: "0" }, defaultWeights: { web: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }, null, 2)}\n`;
  writeFileSync(paths.envelopeFile, envelope);
  const c = await start({ paths });
  const p = (await c.act("envelope-set", { envelope: { minIntervalHours: 0 } })).json();
  assert.equal(p.summary[0], "Change the allocation envelope");
  assert.ok(p.summary.some((l) => l.startsWith("minIntervalHours: 24")), JSON.stringify(p.summary));
  assert.deepEqual([p.undo, p.confirmLabel, typeof p.ticket], [UNDO_SENTENCES.envelope, "Confirm", "string"]);
  assert.equal(read(paths.envelopeFile), envelope, "the preview wrote nothing");
});

// Issue #737: the copy rules `heldToCopyRules` holds each preview to reached every action's preview at
// least once, so "no bar says an arrow or draws an empty item" covers the whole table, not the actions a test happened to
// name. Several actions are previewed only against Valkey, so the claim is made where those tests run.
test("every action's preview was held to the copy rules: no arrow, no empty item", live, () => {
  assert.deepEqual(ACTIONS.map((a) => a.name).filter((n) => !seen.previewed.has(n)), [], "every action previewed through act()");
});

// ---- the canary, last ----------------------------------------------------------------------------------------------

test("leak canary: no audit row or log line carries a token, the answer text or a secret reference; every audit chain verifies", () => {
  assert.ok(seen.audit.length > 20 && seen.logs.length > 20, "the canary saw real traffic");
  for (const [kind, list] of Object.entries({ audit: seen.audit, logs: seen.logs })) {
    for (const text of list) for (const needle of [OP_TOKEN, VIEW_TOKEN, "pdc_", "answer-canary", "steer-canary", "secret-ref-canary", "secret-pass"]) assert.ok(!text.includes(needle), `${kind} carries ${needle.slice(0, 6)}: ${text.slice(0, 120)}`);
  }
  for (const body of seen.bodies) for (const needle of [OP_TOKEN, VIEW_TOKEN, "secret-ref-canary", "secret-pass"]) assert.ok(!body.includes(needle), `a response carries ${needle.slice(0, 6)}`);
  for (const dir of logsDirs) {
    const v = verifyConsoleAudit({ logsDir: dir });
    assert.ok(v.ok, `${dir}: ${JSON.stringify(v.broken ?? {})}`);
  }
});
