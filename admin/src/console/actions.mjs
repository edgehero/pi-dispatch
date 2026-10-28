/**
 * The console's action table and its ONE preview/confirm pipeline (issue #642, DES-OPERATOR-CONSOLE,
 * REQ-OPERATOR-CONSOLE-ACTIONS). Every write the console can make is an entry in `ACTIONS`, and `server.mjs` generates
 * `POST /api/act/<name>/preview` and `POST /api/act/<name>/confirm` from it (`auth: "operator"`, `write: true`), so a
 * write cannot exist without the dispatcher's guards and the route tests derive their lists from the same table.
 *
 * AN ENTRY: `{ name, kind, paid, bulk, needs, fields, danger, atConfirm, preview(body, ctx), apply(entry, ctx),
 * undo(out, body, result), inverse(out, body, result), confirmLabel(out), done(out, body, result) }`.
 *   - `name` is the route segment and the ticket's action; `kind` is the audit row's `kind` (INT-CONSOLE-AUDIT-LOG),
 *     the panel's own word for the same write where one exists, so the TUI's rows and the console's read alike.
 *   - `fields` (issue #737) is every body key the preview reads, frozen; a body carrying any other key is refused by
 *     name before the preview runs (a key a form sent and no planner reads would be dropped in silence, the posture
 *     this repository refuses). `ticket` is never one: it belongs to the confirm.
 *   - `preview` builds the change through the SAME planner the tool or the TUI uses (`write-plans.mjs`, or
 *     `job-actions.mjs` through the read model), so a refusal is the tool's sentence, and returns `{ refusal }`,
 *     `{ unchanged }`, or `{ summary, diff, expect, payload, target, targets, reserve, beforeDigest, afterDigest }`,
 *     which may also carry `plan` and `beforeText` (the planner's plan, the file as it was) for the three below, and a
 *     fleet resume's `pausedBefore` for its Undo (`resumeBack`); those are never sent to the browser.
 *   - `apply` runs the read model's funnel with the ticket's stored `payload` and `expect`, and answers `{ ok, ... }`,
 *     `{ invalid }` (refused, nothing done: the file or the job changed since the preview, a dedup window, ...),
 *     `{ invalid, partial: true }` (refused after part of it was done: the kill switch reached some queues), or
 *     `{ unreachable }` (Valkey).
 *   - `danger` (a destructive act: a cancel, a removal, a pause, a delete) draws the red bar and button; never together
 *     with `paid`, which draws the yellow ones. `undo(out, body, result)` is the bar's and the banner's Undo sentence
 *     (one, or `{ bar, after }` when the bar's points at the preview); `inverse(out, body, result)` the write that undoes
 *     it, `{ action, body }` with a body that action's `fields` take, or null when none can (`UNDO_SENTENCES` then says
 *     what to do instead, after "No undo:"); `confirmLabel(out)` the confirm button's words; `done(out, body, result)`
 *     what the banner after the write says happened. All but a bulk act's `done` are decided at the preview, where the
 *     file as it was is known, and ride the ticket (`meta`); `result` is then undefined.
 *   - `atConfirm` (a single act only) says the write's way back names something only the write itself makes: a re-run's
 *     is a cancel of the NEW job, whose id the enqueue mints. Its `undo` and `inverse` are asked twice: at the preview
 *     with `result` undefined (the bar then says the banner will offer it, and counts as undoable), and again at the
 *     confirm with the apply's answer as `result`, which the banner's Undo uses.
 *
 * THE PIPELINE (lifted from #640's pause-windows reference write, now shared by every entry):
 *   1. preview: plan, compute the digests and the diff, and store EVERYTHING the write needs in a single-use ticket
 *      bound to the session and the action (`confirm.mjs`). The browser gets the ticket and the escaped,
 *      server-rendered confirm bar (`html`, `confirm-view.mjs`), never the payload, so it cannot swap what is written
 *      between the two requests. Every refusal carries its bar too, and keeps its `error` sentence byte for byte.
 *   2. confirm: redeem the ticket, then AUDIT, THEN WRITE (`auditedWrite`): the `ok` row first, with `kind`, the
 *      digests, `reserve` and the ticket's digest; a write whose row cannot be appended does not happen (500); a write
 *      that is refused or throws gets a compensating `failed` row with the same ticket. A bulk action writes one row
 *      per job (`count` = the list's size, all sharing the ticket digest), and a job refused at the apply gets its own
 *      `failed` row.
 *   3. after a write that landed: the session's flash (`setFlash`: what changed, its audit row, the Undo), which the
 *      next page the session draws shows once as a banner, and `hub.tick()`, so every open live tab redraws now
 *      rather than at the next tick.
 *
 * FILE WRITES ARE DRY-RUN AT THE PREVIEW. The planners judge a change; the funnel's own parser decides. So the preview
 * runs the funnel itself against `dryRunFs`, a file system that reads through to the real one and keeps every write in
 * memory, and takes the file it would have renamed into place: the after digest is the digest of the exact bytes the
 * confirm writes, and a change the funnel would refuse is refused at the preview with the funnel's words, before the
 * operator is asked. Nothing the dry run does reaches the disk (`dryRunFs` has no write path to the real one).
 *
 * WHAT A DIFF SHOWS (`confirm-view.mjs` `diffHtmlOf`). The file before and after, in a line diff, with every `secrets`
 * map's values replaced by a marker (a trigger's secret references are not a page's business, the configuration
 * panel's rule), every line escaped by the `html` template, and the file named by its basename alone. The answer to a parked run, and a message into a running job (issue #646), is shown to the
 * operator who typed it, and only there: its audit row carries the sha256 of the text (`afterDigest`), never the text.
 *
 * Valkey-backed reads and writes go through `ctx.a` (`actionDeps`, wired by `cli.mjs`): the read model (`rm`), the
 * planners (`plans`), the deployment's `paths` and `env`, the fleet reader (`fleet`, built with `killSwitchPlanFn`) and
 * the kill switch's decision itself. This module imports none of them, so the server's tests run on small fakes.
 */
import { createHash } from "node:crypto";
import { DEFER_BUCKET_WORDS, DEFER_DUE_SENTENCE, DEFER_WHY_RE, DEFER_WHYS } from "@edgehero/pi-dispatch/defer-reasons";
import { formatMicros } from "@edgehero/pi-dispatch/money";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
import { auditedWrite } from "../audited-write.mjs";
import { fieldNamed, NO_EXPLANATION, UNNAMED_FIELD } from "../words.mjs";
import { PREVIEW_AGAIN } from "./confirm.mjs";
import { bulkResultsHtml, diffHtmlOf, plural, previewBarHtml, REFUSAL_STATES, refusalHtml, textHtml, unchangedBarHtml } from "./confirm-view.mjs";
import { html } from "./html.mjs";
import { timeHtml, utcText } from "./panels/common.mjs";
import { FLASH_MAX_BYTES } from "./sessions.mjs";

/** The diff moved to the confirm view with the rest of the bar's markup (issue #737); re-exported where it always was. */
export { DIFF_LINES_MAX, diffHtmlOf, lineDiff, textHtml } from "./confirm-view.mjs";

/** The most jobs a bulk action names (`job-actions.mjs`' `BULK_MAX`, pinned equal by a test). */
export const BULK_MAX = 100;

/**
 * REQ-OPERATOR-JOB-CANCEL's named refusal for a cancel no worker acknowledged: the exact sentence the `/dispatch` TUI's
 * `cancelNote` shows (`dashboard.ts`), pinned equal to it by a test that reads that file, so the two surfaces say one
 * thing. (It stays a copy rather than a shared import because `dashboard.ts` is the pi extension's TypeScript and this
 * module is the pi-free console; the pin is the bolt.)
 */
export const CANCEL_TIMEOUT_SENTENCE = "no worker acknowledged: the job may have just finished, gone back to the queue (cancel it again to remove it), or its host is unreachable; nothing was changed";

/** A job id as the worker mints it (the read model's charset). */
export const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** What a confirm says when the audit log cannot take its row: nothing was changed. */
export const AUDIT_FAILED = "the audit log could not be written, so nothing was changed; check the console's log directory";

/** The one instruction a refused ticket ends with: `confirm.mjs`' own, imported so the two cannot drift. */
export { PREVIEW_AGAIN };

/** What a confirm says when Valkey could not be reached (the error's own text, which can name a host, goes to the log). */
export const VALKEY_UNREACHABLE = "the deployment's Valkey could not be reached, so nothing was changed; try again";

/** The deepest a request body may nest, and the most keys an object in it may carry. */
const BODY_DEPTH_MAX = 8;
const BODY_KEYS_MAX = 64;

/** The pause-windows file's own fields (`INT-PAUSE-WINDOWS-FILE-CONTRACT`), for the whole-list write. */
const PAUSE_WINDOW_KEYS = Object.freeze(["scope", "from", "to", "tz", "days", "dateFrom", "dateTo"]);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const digestOf = (text) => (text === null || text === undefined ? null : sha256(text));
const codeOf = (e) => (typeof e?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : "error");

/** The count rule every sentence here follows (`confirm-view.mjs` `plural`), re-exported where it always was. */
export { plural };

/**
 * A row of a Configuration list as the console names it until that page converts (issue #737): by the 0-based
 * index its table and its forms show, "trigger at index 2", never "#3". The planners name the console's rows by the same
 * words (`write-plans.mjs` `rowName(what, index, "console")`, which a test holds equal to this); the pi panel keeps its
 * 1-based "#3".
 */
export const atIndex = (what, index) => `${what} at index ${Number.isSafeInteger(index) && index >= 0 ? index : "?"}`;

/**
 * A planner's `[key, before, after]` pairs as the bar draws them: "maxTurns: <b>30</b> to <b>40</b>" (issue #737, the
 * Actions card), joined by commas. The words are `write-plans.mjs` `changeText`'s; only the bold is the bar's.
 */
function changesHtml(changes) {
  return (Array.isArray(changes) ? changes : []).map(([key, before, after], i) => html`${i > 0 ? ", " : null}${key}: <b>${before}</b> to <b>${after}</b>`);
}

/** A refusal raised while reading a body: answered 400 with its sentence. */
class BadRequest extends Error {}

// ---- the body ----------------------------------------------------------------------------------------------------------

/**
 * Whether a parsed body holds only plain JSON values, at most `BODY_DEPTH_MAX` deep and `BODY_KEYS_MAX` keys wide. The 64 KiB body bound keeps it small; this keeps it shallow, so no planner, spread or serializer later
 * spends a stack on a nested value an operator's form could never have sent.
 */
export function plainBody(value, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= BODY_DEPTH_MAX || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length <= 256 && value.every((v) => plainBody(v, depth + 1));
  const keys = Object.keys(value);
  if (keys.length > BODY_KEYS_MAX) return false;
  // A key named `__proto__` is an own data property after JSON.parse and stays one through a spread; it is left to the
  // planners, which refuse a field they do not take by name (`Object.assign`, which would follow it, is never used here).
  return keys.every((k) => plainBody(value[k], depth + 1));
}

/** `body[key]` as a trimmed string: `undefined` when absent or blank (unless required), a BadRequest when not a string. */
function str(body, key, { required = false, max = 512 } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequest(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new BadRequest(`${key} must be a string`);
  if (v.length > max) throw new BadRequest(`${key} is longer than ${max} characters`);
  return v;
}

/** `body[key]` as a whole number at least 0, required. */
function index(body, key = "index") {
  const v = body?.[key];
  const n = typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 0) throw new BadRequest(`${key} must be a whole number, 0 or more`);
  return n;
}

/** `body[key]` as a plain object (a JSON textarea's value). */
function obj(body, key) {
  const v = body?.[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BadRequest(`${key} must be a JSON object`);
  return v;
}

/** A job id from the body, in the worker's charset. */
function jobIdOf(body, key = "jobId") {
  const id = str(body, key, { required: true, max: 200 });
  if (!JOB_ID_RE.test(id)) throw new BadRequest(`${key} must be a job id (letters, digits and . _ : -, at most 200 characters)`);
  return id;
}

// ---- the dry run -------------------------------------------------------------------------------------------------------

/**
 * A file system that reads through to `real` and keeps every write in memory (`files`: path to text, or null for a
 * file the dry run removed). Exactly the methods the read model's file writers call: reads fall through to `real`
 * unless the dry run wrote the path; every write, rename, unlink, mkdir, chmod and chown stays here. There is no path
 * from this object to a real write: a method a writer calls that is not listed is simply absent, so it throws, and
 * the preview refuses rather than guess.
 */
export function dryRunFs(real) {
  const files = new Map();
  const dirs = new Set();
  const fds = new Map();
  let nextFd = 1_000_000;
  const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  const key = (p) => String(p);
  const held = (p) => files.has(key(p));
  const exists = (p) => (held(p) ? files.get(key(p)) !== null : dirs.has(key(p)) || real.existsSync(p));
  const asText = (data) => (typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  const statOf = (p, realStat) => {
    if (dirs.has(key(p)) && !held(p)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtimeMs: 0, size: 0 };
    if (!held(p)) return realStat(p);
    const v = files.get(key(p));
    if (v === null) throw err("ENOENT", p);
    return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o100644, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtimeMs: Date.now(), size: Buffer.byteLength(v) };
  };
  return {
    files,
    existsSync: (p) => exists(p),
    readFileSync(p, opts) {
      if (!held(p)) return real.readFileSync(p, opts);
      const v = files.get(key(p));
      if (v === null) throw err("ENOENT", p);
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      return enc ? v : Buffer.from(v);
    },
    readdirSync: (p, opts) => real.readdirSync(p, opts),
    statSync: (p, opts) => statOf(p, (q) => real.statSync(q, opts)),
    lstatSync: (p, opts) => statOf(p, (q) => real.lstatSync(q, opts)),
    writeFileSync(p, data, opts) {
      if (typeof p === "number") {
        const path = fds.get(p);
        if (path === undefined) throw err("EBADF", String(p));
        files.set(path, asText(data));
        return;
      }
      const flag = typeof opts === "object" && opts !== null ? opts.flag : undefined;
      if (flag === "wx" && exists(p)) throw err("EEXIST", p);
      files.set(key(p), asText(data));
    },
    openSync(p, flags) {
      if (String(flags).includes("x") && exists(p)) throw err("EEXIST", p);
      const fd = nextFd++;
      fds.set(fd, key(p));
      files.set(key(p), "");
      return fd;
    },
    closeSync(fd) {
      fds.delete(fd);
    },
    fsyncSync() {},
    renameSync(from, to) {
      if (!exists(from)) throw err("ENOENT", from);
      files.set(key(to), held(from) ? files.get(key(from)) : real.readFileSync(from, "utf8"));
      files.set(key(from), null);
    },
    unlinkSync(p) {
      if (!exists(p)) throw err("ENOENT", p);
      files.set(key(p), null);
    },
    mkdirSync(p) {
      if (!real.existsSync(p)) dirs.add(key(p));
    },
    chmodSync() {},
    chownSync() {},
  };
}

/** What a preview says when the change would write what the file already holds (the no-change bar's sentence). */
export const UNCHANGED = "the file already says this";

/** A file's text now: `{ text }` (null when absent) or `{ refusal }`. */
function readNow(fs, path) {
  try {
    return { text: fs.readFileSync(path, "utf8") };
  } catch (e) {
    if (e?.code === "ENOENT") return { text: null };
    return { refusal: `${path} cannot be read (${codeOf(e)}); nothing was changed`, status: 409 };
  }
}

// ---- the reserve -------------------------------------------------------------------------------------------------------

/** What a paid action will hold, in words (CONST-BUDGET-BEFORE-TOKENS: the worker reserves at pickup; this says what). */
export function reserveText(r) {
  if (!r) return null;
  if (r.bulk) {
    const known = r.slots - r.unknown;
    const dollars = r.dollarsMicros > 0 ? ` and $${formatMicros(r.dollarsMicros)}${r.unknown > 0 ? ` for the ${plural(known, "job whose reserve is", "jobs whose reserve is")} known` : ""} in each dollar window that applies` : "";
    // A list of one is "It holds", as a single act's sentence reads; "Together they" is for two or more.
    return `${r.slots === 1 ? "It holds" : "Together they hold"} ${plural(r.slots, "job slot")}${dollars}${r.unknown > 0 ? `; the reserve of ${plural(r.unknown, "job")} is unknown (${r.unknown === 1 ? "its" : "their"} data could not be read), so the total is at least this` : ""}.`;
  }
  if (r.unknown) return "Reserve unknown: the job's data could not be read, so what the worker will hold for it cannot be said.";
  if (r.invalid) return `The deployment's dollar setting does not parse (${r.invalid}), so the worker refuses every job until it is fixed.`;
  if (r.zeroRated) return "It holds 1 job slot and $0.00: every model it may call is zero-rated.";
  if (!Number.isSafeInteger(r.dollarsMicros)) return "It holds 1 job slot. No per-job dollar cap is set, so no dollar window can hold anything for it.";
  return `It holds 1 job slot and $${formatMicros(r.dollarsMicros)} (the per-job cap) in each dollar window that applies, until it settles.`;
}

/**
 * The reserve of each listed failed job (issue #642: a retry is paid, the worker reserves again at pickup): the
 * worker's own `estimateReserve` over the job's queue data (`readJobsData`), or `{ unknown: true }` when the data
 * cannot be read. Never 0 for unknown.
 */
async function retryReserves(ctx, jobs) {
  const { rm, paths, readJobsData } = ctx.a;
  const data = typeof readJobsData === "function" ? await readJobsData({ url: paths.valkeyUrl, jobs }) : new Map();
  const opts = reserveInputs(ctx);
  return new Map(jobs.map((j) => {
    const d = data.get(j.jobId);
    if (!d || typeof rm.estimateReserve !== "function") return [j.jobId, { unknown: true }];
    try {
      return [j.jobId, rm.estimateReserve(d, opts)];
    } catch {
      return [j.jobId, { unknown: true }];
    }
  }));
}

/**
 * What every reserve estimate is judged against, the worker's own inputs (issue #642): the settings overlay, the
 * deployment's env (PI_ALLOWED_MODELS, PI_PROVIDER, PI_MODEL and the dollar settings, as the worker reads them), and the
 * model-endpoint snapshot `{ endpoints, models }` the worker takes at each pickup (`ctx.a.modelEndpoints()`, read per
 * preview, as the worker reads it per pickup, so an edit to the declaration shows at once) with the builtin catalog's
 * cost lookup. Without the snapshot a job that can only call a free local model would show the full per-job cap while
 * the worker holds $0. A snapshot that cannot be read is null: judged not zero-rated, the larger figure, never a
 * smaller one than the worker holds.
 */
function reserveInputs(ctx) {
  let modelEndpoints = null;
  try {
    modelEndpoints = typeof ctx.a.modelEndpoints === "function" ? ctx.a.modelEndpoints() ?? null : null;
  } catch {
    modelEndpoints = null;
  }
  return { overlay: overlayOf(ctx), env: ctx.a.env ?? {}, modelEndpoints, ...(typeof ctx.a.builtinModel === "function" ? { builtinModel: ctx.a.builtinModel } : {}) };
}

/** A bulk list's reserves summed: slots, the known dollars, and how many are unknown. */
function bulkReserve(reserves) {
  let dollarsMicros = 0;
  let unknown = 0;
  for (const r of reserves) {
    if (!r || r.unknown || r.invalid) unknown += 1;
    else if (Number.isSafeInteger(r.dollarsMicros)) dollarsMicros += r.dollarsMicros;
  }
  return { bulk: true, slots: reserves.length, dollarsMicros, unknown };
}

/** One job's reserve as a summary line's tail. */
const reserveTail = (r) => (!r || r.unknown || r.invalid ? ", reserve unknown" : r.zeroRated ? ", reserve $0.00 (zero-rated)" : Number.isSafeInteger(r.dollarsMicros) ? `, reserve $${formatMicros(r.dollarsMicros)}` : ", reserve 1 slot (no dollar cap)");

/** The reserve's micro-dollars for the audit row, or null. */
function reserveMicros(r) {
  return Number.isSafeInteger(r?.dollarsMicros) && r.dollarsMicros >= 0 ? r.dollarsMicros : null;
}

// ---- shared steps ------------------------------------------------------------------------------------------------------

/**
 * A file change, previewed by dry-running its funnel: `run(fs, expect)` is the write (the funnel, its arguments bound),
 * called once here against `dryRunFs` and once at the confirm against the real fs. Returns the preview's shape with the
 * exact before and after digests of `target`, or `{ refusal }` with the funnel's words, or `{ unchanged }`.
 */
async function fileChange(ctx, { target, expect, summary, run, payload = {}, plan = null, unchanged = null, barLines = null }) {
  if (typeof target !== "string" || target === "") return { refusal: "this deployment does not name the file this change writes; set it in the deployment's .env", status: 409 };
  const now = readNow(ctx.fs, target);
  if (now.refusal) return now;
  const dry = dryRunFs(ctx.fs);
  let res;
  try {
    res = await run(dry, expect);
  } catch (e) {
    return { refusal: e instanceof BadRequest ? e.message : `the change could not be checked (${codeOf(e)}); nothing was changed` };
  }
  if (res?.invalid) return { refusal: `rejected: ${res.invalid}` };
  const after = dry.files.has(target) ? dry.files.get(target) : now.text;
  const beforeDigest = digestOf(now.text);
  const afterDigest = digestOf(after);
  // The bar's title already says "No change", so the sentence says why (issue #737), and what, where the action
  // knows it (`unchanged(plan)`: a setting's key and the value the file holds).
  if (beforeDigest === afterDigest) return { unchanged: UNCHANGED, ...(typeof unchanged === "function" && plan ? unchanged(plan) : {}) };
  // `beforeText` and `plan` stay on the server: the Undo and the confirm label read them (the trigger count before an
  // add, a setting's old value), and the ticket keeps only what those decide.
  return { target, expect, summary, ...(barLines ? { barLines } : {}), diff: diffHtmlOf(now.text, after, { file: target }), payload: { ...payload, run }, beforeDigest, afterDigest, beforeText: now.text, plan };
}

/** Apply a `fileChange`: the same write, on the real fs, with the preview's `expect`. */
async function applyFile(entry, ctx) {
  const res = await entry.payload.run(ctx.fs, entry.expect);
  if (res?.invalid) return { invalid: String(res.invalid) };
  return { ok: true, ...(res?.pending ? { pending: String(res.pending) } : {}), ...(res?.warning ? { warning: String(res.warning) } : {}) };
}

/** A planner's `{ refusal }` / `{ plan }` as a preview's refusal or the plan. */
function planned(result) {
  if (result?.refusal) return { refusal: String(result.refusal) };
  if (result?.unchanged) return { unchanged: String(result.unchanged) };
  if (!result?.plan) return { refusal: "the change could not be planned" };
  return { plan: result.plan };
}

/**
 * How long a preview waits for the fleet snapshot (issue #737). The snapshot's reads have no overall bound of their own,
 * and a Valkey that stops answering on an open socket would otherwise hold the preview, buttons disabled, for as long.
 * Not the cancel funnels' 2.5 s: the snapshot is a long chain (every registry row, every queue, the run records' walk),
 * which a slow but healthy deployment takes seconds over on its first read, so a short bound would refuse a fleet that
 * answers. Ten seconds is past that, and the refusal says what happened rather than guess why.
 */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/** The refusal when the snapshot did not answer within `SNAPSHOT_TIMEOUT_MS`: what happened, nothing more. */
export const SNAPSHOT_TIMEOUT_SENTENCE = "the fleet did not answer within 10 seconds, so this could not be previewed; nothing was changed";

/**
 * The snapshot a fleet or queue switch previews from (issue #737): its per-queue rows (`queueCounts`) over the queues the
 * kill switch flips, the registry's and every queue that exists (the reader's `switchQueues`), not the registry's alone.
 * Resume fleet resumes a stopped host's queue too, so a preview over the registry's queues hid that queue's jobs, and
 * its Undo left it running when it had been paused; and `setQueuePausedOne` takes any queue of that union, so a queue
 * preview over the registry's alone refused, as "not a queue this deployment drains", the one-queue Undo of a resume.
 */
const SWITCH_READ = Object.freeze({ switchQueues: true });

/** The refusal when the snapshot failed, or answered nothing: the read failed, which the timeout's words do not say. */
export const SNAPSHOT_UNREAD_SENTENCE = "the fleet could not be read (is Valkey reachable?); nothing was changed";

/** The bound's own answer in `snapshotOf`'s race, told apart from a snapshot that answers null. */
const SNAPSHOT_LATE = Symbol("snapshot-late");

/**
 * The fleet snapshot, or the refusal when it fails or does not answer within `SNAPSHOT_TIMEOUT_MS`. `opts` are the
 * snapshot's own (`createFleetReader`): a fleet or queue switch asks `SWITCH_READ`.
 *
 * The bound's refusal carries `timedOut: true` and `state: "timeout"` (issue #737): the caller that previews without
 * the snapshot says which of the two happened (a fleet resume's count line), and the slot's bar takes its title from
 * the state (`REFUSAL_STATES.timeout`, "The fleet did not answer in time"), where a bare 503 is titled for Valkey. The
 * bound is a sentinel of its own, so a reader that answers null is a read that failed, never a timeout.
 */
async function snapshotOf(ctx, opts = {}) {
  let timer;
  try {
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, SNAPSHOT_TIMEOUT_MS, SNAPSHOT_LATE);
      timer.unref?.();
    });
    // A snapshot that settles after the bound settles into the race, which has handled it: never an unhandled rejection.
    const s = await Promise.race([Promise.resolve().then(() => ctx.a.fleet.snapshot(opts)), late]);
    if (s === SNAPSHOT_LATE) return { refusal: SNAPSHOT_TIMEOUT_SENTENCE, status: 503, state: "timeout", timedOut: true };
    if (s) return { snapshot: s };
  } catch {
    // answered below
  } finally {
    clearTimeout(timer);
  }
  return { refusal: SNAPSHOT_UNREAD_SENTENCE, status: 503 };
}

/** A funnel's answer in the pipeline's three shapes. */
function funnelResult(res, okFields = {}) {
  if (res?.ok) return { ok: true, ...okFields };
  // A refusal that came after the write was sent (`partial`) keeps that mark, so the confirm never says nothing changed.
  if (typeof res?.invalid === "string") return res.partial === true ? { invalid: res.invalid, partial: true } : { invalid: res.invalid };
  if (typeof res?.refusal === "string") return { invalid: res.refusal };
  if (typeof res?.refused === "string") return { invalid: res.refused };
  if (res?.unreachable !== undefined) return { unreachable: true };
  return { invalid: "the write was refused" };
}

/** The deployment's settings overlay now (for a paid action's reserve), `{}` when it does not load. */
function overlayOf(ctx) {
  try {
    return ctx.a.rm.readSettingsView({ settingsFile: ctx.a.paths.settingsFile, fs: ctx.fs })?.overlay ?? {};
  } catch {
    return {};
  }
}

/** The allocation envelope as read now: `{ read }` with `read.envelope`, or `{ refusal }`. */
function envelopeNow(ctx) {
  const { rm, paths, env } = ctx.a;
  const maxCostMicros = rm.envelopeJobCap({ settingsFile: paths.settingsFile, env, fs: ctx.fs });
  const read = rm.readEnvelope({ envelopeFile: paths.envelopeFile, projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, maxCostMicros, fs: ctx.fs });
  if (read?.envelope) return { read };
  const why = typeof ctx.a.envelopeProblem === "function" ? ctx.a.envelopeProblem(read ?? {}) : "there is no allocation envelope to apply against (PI_ENVELOPE_FILE)";
  return { refusal: why, status: 409 };
}

/** The host name an allocation audit row of this console carries: the deployment's worker name, else the console's. */
function allocHost(ctx) {
  const name = ctx.a.env?.PI_WORKER_NAME;
  return typeof name === "string" && name !== "" ? name : String(ctx.a.host ?? "console");
}

// ---- the actions -------------------------------------------------------------------------------------------------------

const FILE_NEEDS = Object.freeze(["rm", "plans", "paths"]);
const JOB_NEEDS = Object.freeze(["rm", "paths"]);
const FLEET_NEEDS = Object.freeze(["fleet"]);

/** What the console's trigger add calls itself in a planner's refusal (`planTriggerAdd`'s `tool`). */
export const TRIGGER_FORM = "this form";

/**
 * A file action: `build(body, ctx)` returns a planner's result (`{ plan }` with `mutate`/`expect`/`title`/`summary`, or
 * `{ refusal }`), `target(ctx)` the file, and `write(plan, ctx, { fs, expect })` the funnel call. `bar(plan)`, when
 * given, is the bar's lines in place of the planner's (the same words, with markup: a change's values in bold), and
 * `unchanged(plan)` what the no-change bar says beyond `UNCHANGED` (`{ unchanged, unchangedHtml }`).
 */
function fileAction({ name, kind, build, target, write, bar = null, unchanged = null }) {
  return {
    name,
    kind,
    paid: false,
    bulk: false,
    needs: FILE_NEEDS,
    async preview(body, ctx) {
      const got = planned(await build(body, ctx));
      if (!got.plan) return got;
      const p = got.plan;
      const file = target(ctx);
      const expect = Array.isArray(p.expect) ? p.expect : ctx.a.rm.writeInputs({ paths: [file], fs: ctx.fs });
      return fileChange(ctx, { target: file, expect, summary: [p.title, ...(Array.isArray(p.summary) ? p.summary : [])], run: (fs, exp) => write(p, ctx, { fs, expect: exp }), plan: p, unchanged, barLines: typeof bar === "function" ? bar(p) : null });
    },
    apply: applyFile,
  };
}

/**
 * A setting's change as the bar draws it, `maxTurns: <b>30</b> to <b>40</b>`, then the rest of the planner's lines (a
 * dollar key's warning); and the no-change bar's words for it, the key as code and the value the file holds.
 */
const settingBar = (p) => [html`${changesHtml(p.changes)}`, ...(Array.isArray(p.summary) ? p.summary.slice(1) : [])];
function settingUnchanged(p) {
  const said = p.unset ? "is not set" : `is ${String(p.value)}`;
  return { unchanged: `${UNCHANGED}: ${p.key} ${said}`, unchangedHtml: html`The file already says this: <span class="code">${p.key}</span> ${said}.` };
}

/** The deployment's paths, with the pause-windows file the console's config names when the paths leave it out. */
const pausePath = (ctx) => ctx.a.paths?.pauseWindowsPath ?? ctx.config.pauseWindowsPath;
const shownDir = (ctx) => ({ deploymentDir: ctx.config?.dir ?? null });

/** The settings overlay's secret profiles now (names to resolver paths; never a reference or a value). */
function profilesOf(ctx) {
  const view = ctx.a.rm.readSettingsView({ settingsFile: ctx.a.paths.settingsFile, fs: ctx.fs });
  return { ...(view?.overlay?.secretProfiles ?? {}) };
}

/** The settings overlay's bundle resolvers now (issue #704; names to `{ path, format }`, never a reference or a value). */
function bundleProfilesOf(ctx) {
  return ctx.a.rm.overlayBundleProfiles(ctx.a.rm.readSettingsView({ settingsFile: ctx.a.paths.settingsFile, fs: ctx.fs }));
}

/** The triggers-file bundle ids that name bundle profile `name`, for the removal's confirm; null when unreadable. */
function bundlesNaming(ctx, name) {
  const t = typeof ctx.a.paths.triggersPath === "string" ? ctx.a.rm.readTriggers({ triggersPath: ctx.a.paths.triggersPath, fs: ctx.fs }) : { missing: true };
  if (t?.invalid) return null;
  return Array.isArray(t?.secretBundles) ? t.secretBundles.filter((b) => b.profile === name).map((b) => b.id) : [];
}

/**
 * The whole pause-windows list, #640's reference write, kept as an action: `POST /api/pause-windows/preview|confirm`
 * stay its aliases (DES-OPERATOR-CONSOLE). It validates through the loader's own parser and serializes exactly as
 * `writePauseWindows` does, so its after digest is the written file's; its responses keep `before` and `after`.
 */
const pauseWindowsWhole = {
  name: "pause-windows",
  kind: "pause-windows-set",
  paid: false,
  bulk: false,
  needs: [],
  async preview(body, ctx) {
    if (!Array.isArray(body.windows)) return { refusal: "send {\"windows\": [...]} with the whole new list of pause windows" };
    for (const [i, w] of body.windows.entries()) {
      // Issue #737: the window by the index the Configuration page's table and forms show, until that page
      // converts (PR 7a); the pi panel counts from 1.
      const at = atIndex("pause window", i);
      if (w === null || typeof w !== "object" || Array.isArray(w)) return { refusal: `${at} is not an object; nothing was changed` };
      for (const [k, value] of Object.entries(w)) {
        if (!PAUSE_WINDOW_KEYS.includes(k)) return { refusal: `${at} has a field this file does not take (${PAUSE_WINDOW_KEYS.join(", ")} only); nothing was changed` };
        const plain = typeof value === "string" || (k === "days" && Array.isArray(value) && value.every((d) => typeof d === "string"));
        if (!plain) return { refusal: `${at}: ${k} must be ${k === "days" ? "a list of weekday names" : "a string"}; nothing was changed` };
      }
    }
    const path = ctx.config.pauseWindowsPath;
    const snap = readNow(ctx.fs, path);
    if (snap.refusal) return snap;
    let before = [];
    try {
      const parsedFile = JSON.parse(snap.text ?? "null");
      if (Array.isArray(parsedFile?.windows)) before = parsedFile.windows;
    } catch {
      // An unparseable file reads as empty, as writePauseWindows reads it; the write repairs it.
    }
    const afterText = `${JSON.stringify({ windows: body.windows }, null, 2)}\n`;
    try {
      parsePauseWindows(afterText, path);
    } catch (e) {
      return { refusal: `${e?.message ?? "the pause windows are not valid"}; nothing was changed` };
    }
    const beforeDigest = digestOf(snap.text);
    const afterDigest = digestOf(afterText);
    if (beforeDigest === afterDigest) return { unchanged: UNCHANGED, extra: { before, after: body.windows } };
    return {
      target: path,
      payload: { windows: body.windows },
      expect: [{ path, text: snap.text }],
      summary: ["Replace the pause windows", `${plural(before.length, "window")} now, ${body.windows.length} after`],
      diff: diffHtmlOf(snap.text, afterText, { file: path }),
      beforeDigest,
      afterDigest,
      beforeText: snap.text,
      extra: { before, after: body.windows },
    };
  },
  apply(entry, ctx) {
    const res = ctx.deps.writePauseWindows({ pauseWindowsPath: entry.target, mutate: () => entry.payload.windows.map((w) => ({ ...w })), fs: ctx.fs, expect: entry.expect });
    return res?.ok ? { ok: true } : { invalid: String(res?.invalid ?? "the write was refused") };
  },
};

/** The pause-window fields a form sends, as the tool takes them. */
function pauseFields(body) {
  const f = {};
  for (const k of ["scope", "from", "to", "tz", "dateFrom", "dateTo"]) {
    const v = str(body, k, { max: 4096 });
    if (v !== undefined) f[k] = v;
  }
  if (body.days !== undefined && body.days !== null && body.days !== "") {
    if (typeof body.days === "string") f.days = body.days.split(/[\s,]+/).filter(Boolean);
    else if (Array.isArray(body.days) && body.days.every((d) => typeof d === "string")) f.days = body.days;
    else throw new BadRequest("days must be a list of weekday names");
  }
  return f;
}

const writePause = (p, ctx, { fs, expect }) => ctx.deps.writePauseWindows({ pauseWindowsPath: pausePath(ctx), mutate: p.mutate, fs, expect });
const writeTriggersOf = (p, ctx, { fs, expect }) => ctx.a.rm.writeTriggers({ triggersPath: ctx.a.paths.triggersPath, mutate: p.mutate, fs, expect });
const writeSettingsOf = (p, ctx, { fs, expect }) => ctx.a.rm.writeSettings({ settingsFile: ctx.a.paths.settingsFile, mutate: p.mutate, fs, expect, ...(p.writeArgs ?? {}) });
const writeLimitsOf = (p, ctx, { fs, expect }) => ctx.a.rm.writeScopedLimits({ ...p.writeArgs, fs, expect });
const writeProjectsOf = (p, ctx, { fs, expect }) => ctx.a.rm.writeProjects({ ...p.writeArgs, fs, expect });

/** The members a project form sends: a list, or one name per line or comma. */
function membersOf(body, required) {
  const v = body.members;
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequest("members is required: at least one repository or folder");
    return undefined;
  }
  if (typeof v === "string") return v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((m) => typeof m === "string")) return v;
  throw new BadRequest("members must be a list of repositories or folders");
}

const configActions = [
  pauseWindowsWhole,
  fileAction({
    name: "trigger-add",
    kind: "trigger-add",
    // The form's own word for itself (issue #737): a refusal the planner names its caller in ("... does not take
    // colour") says "this form" to a person on the console, never the pi tool's name.
    build: (body, ctx) => ctx.a.plans.planTriggerAdd({ params: { ...obj(body, "trigger") }, paths: ctx.a.paths, env: ctx.a.env, tool: TRIGGER_FORM, surface: "console", fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.triggersPath,
    write: writeTriggersOf,
  }),
  fileAction({
    name: "trigger-edit",
    kind: "trigger-edit",
    build: (body, ctx) => ctx.a.plans.planTriggerEdit({ params: { index: index(body), flow: str(body, "flow", { required: true }), backend: str(body, "backend"), provider: str(body, "provider"), model: str(body, "model") }, paths: ctx.a.paths, env: ctx.a.env, surface: "console", fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.triggersPath,
    write: writeTriggersOf,
    bar: (p) => [html`${p.row} (${p.type}) ${changesHtml(p.changes)}`, ...(Array.isArray(p.summary) ? p.summary.slice(1) : [])],
  }),
  fileAction({
    name: "trigger-delete",
    kind: "trigger-delete",
    build: (body, ctx) => ctx.a.plans.planTriggerDelete({ index: index(body), paths: ctx.a.paths, surface: "console", fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.triggersPath,
    write: writeTriggersOf,
  }),
  fileAction({
    name: "setting-set",
    kind: "setting-set",
    build: (body, ctx) => ctx.a.plans.planSettingSet({ key: str(body, "key", { required: true, max: 64 }), value: str(body, "value", { required: true }), paths: ctx.a.paths, env: ctx.a.env, shown: shownDir(ctx), fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
    bar: settingBar,
    unchanged: settingUnchanged,
  }),
  fileAction({
    name: "setting-unset",
    kind: "setting-unset",
    build: (body, ctx) => ctx.a.plans.planSettingUnset({ key: str(body, "key", { required: true, max: 64 }), paths: ctx.a.paths, env: ctx.a.env, shown: shownDir(ctx), fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
    bar: settingBar,
    unchanged: settingUnchanged,
  }),
  fileAction({
    name: "secret-profile-add",
    kind: "secret-profile-add",
    // Issue #712: the env-declared names and the resolver roots judged before the confirm, as `/dispatch secrets add` does.
    build: (body, ctx) => ctx.a.plans.planSecretProfileAdd({ name: str(body, "name", { required: true, max: 64 }), path: str(body, "path", { required: true, max: 4096 }), profiles: profilesOf(ctx), envProfiles: ctx.a.rm.envSecretProfiles?.(ctx.a.env?.PI_SECRET_PROFILES)?.profiles ?? {}, env: ctx.a.env ?? null, settingsFile: ctx.a.paths.settingsFile, ...(ctx.fs ? { fs: ctx.fs } : {}) }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
  }),
  fileAction({
    name: "secret-profile-remove",
    kind: "secret-profile-remove",
    build: (body, ctx) => ctx.a.plans.planSecretProfileRemove({ name: str(body, "name", { required: true, max: 64 }), profiles: profilesOf(ctx), settingsFile: ctx.a.paths.settingsFile }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
  }),
  // Issue #704: the bundle resolvers, the profiles' twin one step wider (a script printing a project's whole
  // environment), written to the overlay's `secretBundles` by an operator through this form, never by a tool.
  fileAction({
    name: "secret-bundle-add",
    kind: "secret-bundle-add",
    build: (body, ctx) => ctx.a.plans.planSecretBundleAdd({ name: str(body, "name", { required: true, max: 64 }), path: str(body, "path", { required: true, max: 4096 }), format: str(body, "format", { required: true, max: 16 }), bundles: bundleProfilesOf(ctx), envBundles: ctx.a.rm.envBundleProfiles(ctx.a.env?.PI_SECRET_BUNDLES).profiles, env: ctx.a.env ?? null, settingsFile: ctx.a.paths.settingsFile, ...(ctx.fs ? { fs: ctx.fs } : {}) }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
  }),
  fileAction({
    name: "secret-bundle-remove",
    kind: "secret-bundle-remove",
    build: (body, ctx) => {
      const name = str(body, "name", { required: true, max: 64 });
      return ctx.a.plans.planSecretBundleRemove({ name, bundles: bundleProfilesOf(ctx), bound: bundlesNaming(ctx, name), envBundles: ctx.a.rm.envBundleProfiles(ctx.a.env?.PI_SECRET_BUNDLES).profiles, settingsFile: ctx.a.paths.settingsFile });
    },
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
  }),
  fileAction({
    name: "pause-window-add",
    kind: "pause-window-add",
    build: (body, ctx) => ctx.a.plans.planPauseWindowAdd({ fields: pauseFields(body), paths: { ...ctx.a.paths, pauseWindowsPath: pausePath(ctx) }, fs: ctx.fs }),
    target: pausePath,
    write: writePause,
  }),
  fileAction({
    name: "pause-window-edit",
    kind: "pause-window-edit",
    build: (body, ctx) => ctx.a.plans.planPauseWindowEdit({ index: index(body), fields: pauseFields(body), paths: { ...ctx.a.paths, pauseWindowsPath: pausePath(ctx) }, surface: "console", fs: ctx.fs }),
    target: pausePath,
    write: writePause,
  }),
  fileAction({
    name: "pause-window-delete",
    kind: "pause-window-delete",
    build: (body, ctx) => ctx.a.plans.planPauseWindowDelete({ index: index(body), paths: { ...ctx.a.paths, pauseWindowsPath: pausePath(ctx) }, surface: "console", fs: ctx.fs }),
    target: pausePath,
    write: writePause,
  }),
  fileAction({
    name: "limit-add",
    kind: "limit-add",
    build: (body, ctx) => ctx.a.plans.planLimitAdd({ params: { ...obj(body, "limit") }, paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.scopedLimitsPath,
    write: writeLimitsOf,
  }),
  fileAction({
    name: "limit-edit",
    kind: "limit-edit",
    build: (body, ctx) => ctx.a.plans.planLimitEdit({ params: { ...obj(body, "limit"), index: index(body) }, paths: ctx.a.paths, env: ctx.a.env, surface: "console", fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.scopedLimitsPath,
    write: writeLimitsOf,
  }),
  fileAction({
    name: "limit-delete",
    kind: "limit-delete",
    build: (body, ctx) => ctx.a.plans.planLimitDelete({ index: index(body), paths: ctx.a.paths, env: ctx.a.env, surface: "console", fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.scopedLimitsPath,
    write: writeLimitsOf,
  }),
  fileAction({
    name: "project-add",
    kind: "project-add",
    build: (body, ctx) => ctx.a.plans.planProjectAdd({ params: { id: str(body, "id", { required: true, max: 64 }), name: str(body, "name"), members: membersOf(body, true) }, paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.projectsFile,
    write: writeProjectsOf,
  }),
  fileAction({
    name: "project-edit",
    kind: "project-edit",
    build: (body, ctx) => {
      // A sent empty name removes it (the tool's rule); an absent one keeps it.
      const name = body.name === "" ? "" : str(body, "name");
      return ctx.a.plans.planProjectEdit({ params: { id: str(body, "id", { required: true, max: 64 }), ...(name !== undefined ? { name } : {}), ...(membersOf(body, false) ? { members: membersOf(body, false) } : {}) }, paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs });
    },
    target: (ctx) => ctx.a.paths.projectsFile,
    write: writeProjectsOf,
  }),
  fileAction({
    name: "project-delete",
    kind: "project-delete",
    build: (body, ctx) => ctx.a.plans.planProjectDelete({ id: str(body, "id", { required: true, max: 64 }), paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.projectsFile,
    write: writeProjectsOf,
  }),
  {
    name: "envelope-set",
    kind: "envelope-set",
    paid: false,
    bulk: false,
    needs: FILE_NEEDS,
    async preview(body, ctx) {
      const got = planned(ctx.a.plans.planEnvelope({ params: { ...obj(body, "envelope") }, paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }));
      if (!got.plan) return got;
      const p = got.plan;
      return {
        target: p.target,
        expect: p.expect,
        payload: { files: p.files, change: p.change },
        summary: [p.title, ...(Array.isArray(p.summary) ? p.summary : [])],
        // The envelope's own digests (the parsed envelope's, the worker's comparison), as the tool's audit row has them.
        beforeDigest: p.beforeDigest ?? null,
        afterDigest: p.digest ?? null,
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.writeEnvelope({ ...entry.payload.files, change: entry.payload.change, expect: entry.expect, url: ctx.a.paths.valkeyUrl, fs: ctx.fs });
      if (res?.invalid) return { invalid: String(res.invalid) };
      return { ok: true };
    },
  },
  {
    name: "priorities-set",
    kind: "priorities-set",
    paid: false,
    bulk: false,
    needs: FILE_NEEDS,
    async preview(body, ctx) {
      if (!Array.isArray(body.projects) || body.projects.length === 0) throw new BadRequest("projects must be a list of {id, weight}");
      const validDays = body.validDays === undefined || body.validDays === null || body.validDays === "" ? undefined : index(body, "validDays");
      const env = envelopeNow(ctx);
      if (env.refusal) return env;
      const plan = ctx.a.plans.planPriorities({ projects: body.projects, validDays, now: new Date(ctx.now()) }).plan.plan;
      return {
        target: "allocation",
        expect: { envelopeDigest: env.read.digest },
        payload: { plan },
        summary: ["Set a priorities plan (writer operator-session; the worker's rules bound it, and a refusal changes nothing)", ...plan.projects.map(priorityLine), ...(plan.validUntil ? [`valid until ${plan.validUntil}`] : [])],
      };
    },
    async apply(entry, ctx) {
      const env = envelopeNow(ctx);
      if (env.refusal) return { invalid: env.refusal };
      if (env.read.digest !== entry.expect.envelopeDigest) return { invalid: "the allocation envelope changed since the preview; nothing was applied. Preview again" };
      const res = await ctx.a.rm.applyPriorities({ url: ctx.a.paths.valkeyUrl, envelope: env.read.envelope, digest: env.read.digest, projects: env.read.projects, plan: entry.payload.plan, keepOther: true, host: allocHost(ctx), logsDir: ctx.a.paths.logsDir, now: new Date(ctx.now()), fs: ctx.fs });
      if (res?.outcome === "applied" || res?.outcome === "duplicate") return { ok: true, outcome: res.outcome, planId: res.planId ?? null };
      // The worker's field and rule, as the TUI's `prioritiesOutcome` shows them (index.ts), so a refusal names what to fix.
      const field = res?.field ? ` (${String(res.field)}: ${String(res.rule ?? "-")})` : "";
      return { invalid: `${String(res?.outcome ?? "refused")}: ${String(res?.reason ?? "unknown")}${field}` };
    },
  },
  {
    name: "allocation-revert",
    kind: "allocation-revert",
    paid: false,
    bulk: false,
    needs: FILE_NEEDS,
    async preview(body, ctx) {
      const at = index(body);
      const env = envelopeNow(ctx);
      if (env.refusal) return env;
      const alloc = await ctx.a.rm.readAllocations({ url: ctx.a.paths.valkeyUrl, envelope: env.read.envelope, projects: env.read.projects, now: new Date(ctx.now()), withReasons: false, limit: 20 });
      if (alloc?.unreachable) return { refusal: "the allocation history could not be read (is Valkey reachable?); nothing was changed", status: 503 };
      const log = Array.isArray(alloc?.log) ? alloc.log : [];
      const row = log[at];
      // Issue #737: the row by the index the form asks for ("History row # (newest is 0)"), until the
      // Configuration page converts (PR 7a).
      if (!row) return { refusal: `no allocation ${atIndex("history row", at)} (have ${log.length})` };
      if (row.weights === null || typeof row.weights !== "object") return { refusal: `${atIndex("history row", at)} carries no split to go back to` };
      return {
        target: "allocation",
        expect: { envelopeDigest: env.read.digest },
        payload: { row, index: at },
        summary: [`Revert the allocation to ${atIndex("history row", at)} (writer operator-revert)`, `${String(row.at ?? "-")}: ${String(row.outcome ?? "-")}${row.planId ? `, plan ${String(row.planId)}` : ", the neutral split"}`, ...Object.entries(row.weights).map(([k, w]) => `${k}: weight ${String(w)}`)],
      };
    },
    async apply(entry, ctx) {
      const env = envelopeNow(ctx);
      if (env.refusal) return { invalid: env.refusal };
      if (env.read.digest !== entry.expect.envelopeDigest) return { invalid: "the allocation envelope changed since the preview; nothing was reverted. Preview again" };
      const res = await ctx.a.rm.revertAllocation({ url: ctx.a.paths.valkeyUrl, envelope: env.read.envelope, digest: env.read.digest, target: entry.payload.row, host: allocHost(ctx), logsDir: ctx.a.paths.logsDir, now: new Date(ctx.now()), fs: ctx.fs });
      if (res?.outcome === "reverted") return { ok: true, outcome: "reverted", planId: res.planId ?? null };
      return { invalid: `${String(res?.outcome ?? "refused")}: ${String(res?.reason ?? "unknown")}` };
    },
  },
];

/** A run field's value as one line of text: a list joined, an object by its keys, anything else as a string. */
function fieldText(v) {
  if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (v !== null && typeof v === "object") return Object.keys(v).join(", ");
  return String(v);
}

/**
 * A forge plan's run fields (`plan.runFields`, job-actions' `runFieldsSummary`: what the job will run with, taken from
 * the trigger as the file says NOW) as the preview's lines, so the operator sees what a re-run or an answer starts before
 * it spends. Names only: the secret profile by its name, never a secret or a reference. A model or cap the job leaves to
 * the deployment says so; the other fields appear only when set. Every value is escaped by the preview's template.
 */
export function runFieldsLines(f, lead) {
  if (f === null || typeof f !== "object") return [];
  const parts = [
    ...(f.flow !== null && f.flow !== undefined ? [`flow ${fieldText(f.flow)}`] : []),
    `model ${f.model !== null && f.model !== undefined ? fieldText(f.model) : "the deployment's default"}`,
    ...(f.models !== null && f.models !== undefined ? [`allowed models ${fieldText(f.models)}`] : []),
    ...(Array.isArray(f.fallbackModels) && f.fallbackModels.length > 0 ? [`fallbacks ${fieldText(f.fallbackModels)}`] : []),
    `per-job cap ${f.maxCostUsd !== null && f.maxCostUsd !== undefined ? `$${fieldText(f.maxCostUsd)}` : "the deployment's"}`,
    ...(f.secretsProfile !== null && f.secretsProfile !== undefined ? [`secret profile ${fieldText(f.secretsProfile)}`] : []),
    ...(f.image !== null && f.image !== undefined ? [`image ${fieldText(f.image)}`] : []),
    ...(f.backend !== null && f.backend !== undefined ? [`backend ${fieldText(f.backend)}`] : []),
    ...(f.packages !== null && f.packages !== undefined ? [`packages ${fieldText(f.packages)}`] : []),
    ...(f.mcp !== null && f.mcp !== undefined ? [`MCP ${fieldText(f.mcp)}`] : []),
  ];
  return [`${lead}: ${parts.join("; ")}`];
}

/** One project of a priorities plan as the preview lists it: its weight, and its repos and reason when it names them. */
function priorityLine(p) {
  const repos = Array.isArray(p.repos) ? p.repos.map(String).join(", ") : p.repos !== undefined ? String(p.repos) : "";
  return `${String(p.id)}: weight ${String(p.weight)}${repos !== "" ? `, repos ${repos}` : ""}${p.reason !== undefined ? `, reason: ${String(p.reason)}` : ""}`;
}

/** A failed job's row in a bulk list, as the preview shows and the ticket binds it. */
const failedLine = (j) => `${j.jobId} on ${j.queue}, ${plural(j.attemptsMade, "attempt")}${j.target ? `, ${j.target}` : ""}`;

/**
 * A bulk preview's last line when more match than one action takes: the text for the answer's `summary`, and the bar's
 * markup with "not in this action" in bold, as the ConfirmStates card draws it (lower case: the bold carries it).
 */
function notInThisAction(lead, tail = "") {
  return { text: `${lead} not in this action${tail}`, bar: html`${lead} <b>not in this action</b>${tail}` };
}

/** The failed job `jobId` as the bulk planner reads it now (optionally in `queue`), or the refusal. */
async function failedJob(ctx, jobId, queue) {
  const read = await ctx.a.rm.planFailedBulk({ url: ctx.a.paths.valkeyUrl, filter: queue ? { queue } : {}, limit: BULK_MAX });
  if (read?.invalid) return { refusal: String(read.invalid) };
  if (read?.unreachable) return { refusal: "the failed jobs could not be read (is Valkey reachable?); nothing was changed", status: 503 };
  const job = (read?.jobs ?? []).find((j) => j.jobId === jobId);
  if (!job) return { refusal: `job ${jobId} is not among the failed jobs as read now (the newest ${BULK_MAX}${queue ? ` of ${queue}` : ""}); nothing to do` };
  return { job };
}

function failedOne({ name, kind, verb, fn }) {
  return {
    name,
    kind,
    paid: verb === "Retry",
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const queue = str(body, "queue", { max: 200 });
      const got = await failedJob(ctx, jobId, queue);
      if (!got.job) return got;
      const j = got.job;
      const reserve = verb === "Retry" ? (await retryReserves(ctx, [j])).get(jobId) : null;
      return {
        target: jobId,
        expect: { attemptsMade: j.attemptsMade, finishedOn: j.finishedOn },
        payload: { jobId },
        reserve,
        summary: [`${verb} failed job ${failedLine(j)}`, verb === "Retry" ? "It goes back to waiting and runs again through every pre-spend gate, and the worker reserves for it again at pickup." : "The queue's copy goes; the run records its attempts wrote stay."],
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm[fn]({ url: ctx.a.paths.valkeyUrl, jobId: entry.payload.jobId, expect: entry.expect });
      return funnelResult(res, { jobId: entry.payload.jobId, queue: res?.queue ?? null });
    },
  };
}

function failedAll({ name, kind, verb, fn }) {
  return {
    name,
    kind,
    paid: verb === "Retry",
    bulk: true,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const queue = str(body, "queue", { max: 200 });
      const repo = str(body, "repo", { max: 512 });
      const read = await ctx.a.rm.planFailedBulk({ url: ctx.a.paths.valkeyUrl, filter: { ...(queue ? { queue } : {}), ...(repo ? { repo } : {}) }, limit: BULK_MAX });
      if (read?.invalid) return { refusal: String(read.invalid) };
      if (read?.unreachable) return { refusal: "the failed jobs could not be read (is Valkey reachable?); nothing was changed", status: 503 };
      const jobs = (read?.jobs ?? []).slice(0, BULK_MAX);
      if (jobs.length === 0) return { refusal: `no failed job matches${queue ? ` in ${queue}` : ""}${repo ? ` for ${repo}` : ""}; nothing to do` };
      const more = Number(read.more ?? 0);
      const reserves = verb === "Retry" ? await retryReserves(ctx, jobs) : null;
      const reserveOf = (j) => (reserves ? reserves.get(j.jobId) : null);
      const lines = jobs.map((j) => `${failedLine(j)}${reserves ? reserveTail(reserveOf(j)) : ""}`);
      const floor = read.examinedAll === false;
      // A count the scan stopped short of is a floor, "at least 3 more match and are", never "3 or more more".
      const past = more > 0 ? notInThisAction(`${floor ? "at least " : ""}${plural(more, "more matches and is", "more match and are")}`, ` (at most ${BULK_MAX} per action)`) : null;
      return {
        target: queue ?? repo ?? "failed",
        targets: jobs.map((j) => ({ jobId: j.jobId, queue: j.queue, attemptsMade: j.attemptsMade, finishedOn: j.finishedOn, ...(j.target ? { target: j.target } : {}), ...(reserves ? { reserve: reserveOf(j) } : {}) })),
        // The filter rides the ticket for the banner after the write (`WRITE_RULES` `done`); the apply never reads it.
        payload: { ...(queue ? { queue } : {}), ...(repo ? { repo } : {}) },
        reserve: reserves ? bulkReserve(jobs.map(reserveOf)) : null,
        summary: [`${verb} ${plural(jobs.length, "failed job")}${queue ? ` in ${queue}` : ""}${repo ? ` for ${repo}` : ""}; each is re-checked and acted on alone`, ...lines, ...(past ? [past.text] : [])],
        barLines: [...lines, ...(past ? [past.bar] : [])],
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm[fn]({ url: ctx.a.paths.valkeyUrl, jobs: entry.targets.map(({ jobId, attemptsMade, finishedOn }) => ({ jobId, attemptsMade, finishedOn })) });
      if (res?.invalid) return { invalid: String(res.invalid) };
      if (res?.unreachable !== undefined) return { unreachable: true };
      return { ok: true, results: (res?.results ?? []).map(resultRow) };
    },
  };
}

/** An instant a line can draw: a whole number of ms that `utcText` draws (0 to the leaf's `DEFER_TIME_MAX_MS`). */
const drawable = (ms) => Number.isSafeInteger(ms) && utcText(ms) !== "unknown";

/** A waiting row's placeholder named `key` as `{ text, bar }`, or null when the row does not hold it as its rule says. */
function waitingValue(row, key) {
  if (key === "until" || key === "due") {
    // `until`: the record's own instant, else the delayed set's due (the worker writes the one it moves the job to).
    // `due`: the delayed set's alone. An instant no date can show is missing, so the line says its bucket's title
    // rather than "at unknown".
    const at = key === "until" && drawable(row.untilAt) ? row.untilAt : drawable(row.dueAt) ? row.dueAt : null;
    return at === null ? null : { text: utcText(at), bar: timeHtml(at) };
  }
  if (key === "attempt" || key === "attempts") return Number.isSafeInteger(row[key]) && row[key] > 0 ? { text: String(row[key]), bar: String(row[key]) } : null;
  if (key === "host" || key === "holder" || key === "endpoint") return typeof row[key] === "string" && row[key] !== "" ? { text: row[key], bar: row[key] } : null;
  return null;
}

/** `sentence` with each `{placeholder}` filled from `row` (`waitingValue`), as `{ text, bar }`, or null when one is missing. */
function filledLine(sentence, row) {
  const parts = sentence.split(/\{([a-z]+)\}/);
  const values = parts.map((p, i) => (i % 2 === 1 ? waitingValue(row, p) : { text: p, bar: p }));
  return values.every((v) => v !== null) ? { text: values.map((v) => v.text).join(""), bar: html`${values.map((v) => v.bar)}` } : null;
}

/**
 * Why a queued job waits, as a preview line (`{ text, bar }`: the answer's summary and the bar's markup, every time a
 * `<time>` in the bar), from a `readWaiting`-shaped row: the worker's own sentence for the reason it recorded
 * (`DEFER_WHYS`, from the worker's leaf, so the two cannot drift), each `{placeholder}` filled from the row. A job the
 * reader found past its due (`due`) says so (`DEFER_DUE_SENTENCE`), whatever it recorded. A sentence whose placeholder
 * the row lacks (or holds an instant no date can show) says the bucket's title instead, which is true without it
 * ("Waiting for a free slot"), never a sentence with a hole. A reason this console has no words for (a newer worker's)
 * is said by its token with `NO_EXPLANATION`; a row with no reason at all says its bucket's title, "No reason was
 * recorded" among them. Null for no row: the preview then says nothing about why rather than guess.
 */
export function waitingLine(row) {
  if (row === null || typeof row !== "object") return null;
  const why = typeof row.why === "string" && DEFER_WHY_RE.test(row.why) ? row.why : null;
  if (row.bucket === "due") {
    const line = filledLine(DEFER_DUE_SENTENCE, row);
    if (line !== null) return line;
  } else if (why !== null && row.known === true && Object.hasOwn(DEFER_WHYS, why)) {
    const line = filledLine(DEFER_WHYS[why].sentence, row);
    if (line !== null) return line;
  } else if (why !== null && row.known === false) {
    return { text: `Recorded reason: ${why}, ${NO_EXPLANATION}`, bar: html`Recorded reason: <span class="code">${why}</span>, ${NO_EXPLANATION}` };
  }
  const title = DEFER_BUCKET_WORDS[Object.hasOwn(DEFER_BUCKET_WORDS, row.bucket) ? row.bucket : "none"].title;
  return { text: title, bar: title };
}

/** What a queued job's cancel does, the preview's last line. */
const CANCEL_QUEUED_LINE = "It is removed from its queue before it starts; the run records of other jobs are not touched.";

/**
 * One job's bulk result as the response and the audit carry it: the id, ok, and the refusal's sentence, with `partial`
 * kept where the funnel's answer had it (part of that job's change may have been made), so the bar never says "not
 * done" of a job whose hold may be gone.
 */
function resultRow(r) {
  if (r?.ok) return { jobId: String(r.jobId), ok: true, ...(r.queue ? { queue: String(r.queue) } : {}) };
  return { jobId: r?.jobId === null || r?.jobId === undefined ? null : String(r.jobId), ok: false, ...(r?.partial === true ? { partial: true } : {}), reason: r?.unreachable !== undefined ? "Valkey could not be reached for this job" : String(r?.invalid ?? "refused") };
}

const jobActions = [
  {
    name: "cancel-active",
    kind: "cancel-active",
    paid: false,
    bulk: false,
    needs: FLEET_NEEDS,
    async preview(body) {
      const jobId = jobIdOf(body);
      return { target: jobId, payload: { jobId }, summary: [`Cancel running job ${jobId}`, "The worker that owns it is asked to stop its container; it answers within 10 seconds or the cancel says so."] };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.fleet.cancelActive({ jobId: entry.payload.jobId });
      if (res?.ack !== undefined) return { ok: true, jobId: entry.payload.jobId, ack: res.ack === "" ? "the worker" : String(res.ack) };
      if (res?.timeout) return { invalid: CANCEL_TIMEOUT_SENTENCE };
      return { invalid: "the cancel was not acknowledged; check the worker log" };
    },
  },
  {
    name: "cancel-held",
    kind: "cancel-held",
    paid: false,
    bulk: false,
    needs: [...JOB_NEEDS, "fleet"],
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const s = await snapshotOf(ctx);
      if (!s.snapshot) return s;
      const row = (s.snapshot.held?.rows ?? []).find((r) => r?.jobId === jobId);
      if (!row) return { refusal: `job ${jobId} is not among the held jobs as read now; nothing to cancel` };
      return { target: jobId, payload: { jobId }, summary: [`Cancel held job ${jobId}${row.target ? ` (${row.target})` : ""}, waiting for ${row.label ?? "its wait"}`, "It is removed from its queue with its hold; it spent nothing while it waited."] };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.cancelHeldJob({ url: ctx.a.paths.valkeyUrl, jobId: entry.payload.jobId });
      return funnelResult(res, { jobId: entry.payload.jobId });
    },
  },
  {
    name: "cancel-all-held",
    kind: "held-cancel-all",
    paid: false,
    bulk: true,
    needs: [...JOB_NEEDS, "fleet"],
    async preview(body, ctx) {
      const s = await snapshotOf(ctx);
      if (!s.snapshot) return s;
      const h = s.snapshot.held;
      if (!h || h.unreachable) return { refusal: "the held jobs could not be read; nothing was changed", status: 503 };
      const rows = (Array.isArray(h.rows) ? h.rows : []).filter((r) => typeof r?.jobId === "string" && JOB_ID_RE.test(r.jobId)).slice(0, BULK_MAX);
      if (rows.length === 0) return { refusal: "no job is held; nothing to cancel" };
      const more = Number(h.more ?? 0);
      const lines = rows.map((r) => `${r.jobId}${r.target ? ` (${r.target})` : ""}, waiting for ${r.label ?? "its wait"}`);
      const past = more > 0 ? notInThisAction(plural(more, "more held is", "more held are")) : null;
      return {
        target: "held",
        targets: rows.map((r) => ({ jobId: r.jobId, ...(r.target ? { target: String(r.target) } : {}), ...(r.label ? { label: String(r.label) } : {}) })),
        payload: {},
        summary: [`Cancel ${plural(rows.length, "held job")}; each is re-checked (still held) and removed alone`, ...lines, ...(past ? [past.text] : [])],
        barLines: [...lines, ...(past ? [past.bar] : [])],
      };
    },
    async apply(entry, ctx) {
      const results = [];
      for (const t of entry.targets) {
        const res = await ctx.a.rm.cancelHeldJob({ url: ctx.a.paths.valkeyUrl, jobId: t.jobId });
        results.push(resultRow(res?.ok ? { ...res, jobId: t.jobId } : { jobId: t.jobId, invalid: res?.invalid ?? "refused", partial: res?.partial === true }));
      }
      return { ok: true, results };
    },
  },
  {
    // Issue #737: take a job that never started out of its queue (waiting, delayed, prioritized or paused, held or not),
    // by the planner's rules (`job-actions.mjs` `planCancelQueued`: no attempt made, never stalled back, no recovery it
    // owes a record, not a scheduler's next run). The preview says why the job waits, in the worker's words; the confirm
    // re-finds the job and refuses one that changed or started since (`cancelQueuedJob`, against `expect`).
    name: "cancel-queued",
    kind: "cancel-queued",
    paid: false,
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const queue = str(body, "queue", { max: 200 });
      const res = await ctx.a.rm.planCancelQueued({ url: ctx.a.paths.valkeyUrl, jobId, queue: queue ?? null });
      // The read's own error can name a host, so the answer says Valkey in fixed words (the log is not this preview's).
      if (res?.unreachable !== undefined) return { refusal: "the queued job could not be read (is Valkey reachable?); nothing was changed", status: 503 };
      if (typeof res?.refusal === "string") return { refusal: res.refusal, ...(Number.isSafeInteger(res.status) ? { status: res.status } : {}) };
      const p = res?.plan;
      if (!p || typeof p.queue !== "string") return { refusal: "the change could not be planned" };
      const why = waitingLine(p.waiting);
      return {
        target: jobId,
        payload: { jobId, queue: p.queue },
        // What the confirm holds the job to: where it was found, and that it has still made no attempt and never stalled.
        expect: { queue: p.queue, attemptsMade: p.attemptsMade, stalledCounter: p.stalledCounter },
        summary: [`Cancel queued job ${jobId}${p.target ? ` (${p.target})` : ""}`, ...(why ? [why.text] : []), CANCEL_QUEUED_LINE],
        barLines: [...(why ? [why.bar] : []), CANCEL_QUEUED_LINE],
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.cancelQueuedJob({ url: ctx.a.paths.valkeyUrl, jobId: entry.payload.jobId, expect: entry.expect });
      return funnelResult(res, { jobId: entry.payload.jobId, queue: typeof res?.queue === "string" ? res.queue : entry.payload.queue, held: res?.held === true });
    },
  },
  failedOne({ name: "retry-failed", kind: "failed-retry", verb: "Retry", fn: "retryFailedJob" }),
  failedOne({ name: "remove-failed", kind: "failed-remove", verb: "Remove", fn: "removeFailedJob" }),
  failedAll({ name: "retry-all-failed", kind: "failed-retry-all", verb: "Retry", fn: "retryFailedJobs" }),
  failedAll({ name: "remove-all-failed", kind: "failed-remove-all", verb: "Remove", fn: "removeFailedJobs" }),
  {
    name: "run-fork",
    kind: "run-fork",
    paid: true,
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const { rm, paths } = ctx.a;
      const { entry, position, point: selectedPoint, provider, model, thinking, message } = body;
      const point = typeof selectedPoint === "string" ? /^([A-Za-z0-9_-]{1,128}):(before|at)$/.exec(selectedPoint) : null;
      if (selectedPoint !== undefined && (!point || entry !== undefined || position !== undefined)) return { refusal: "fork-point-invalid" };
      const request = { jobId, entry: point ? point[1] : entry, position: point ? point[2] : position ?? "before", provider, model, thinking, message };
      const got = planned(await rm.planRunFork({ ...request, url: paths.valkeyUrl, logsDir: paths.logsDir, triggersPath: paths.triggersPath ?? null, ...reserveInputs(ctx), fs: ctx.fs, now: ctx.now }));
      if (!got.plan) return got;
      const p = got.plan;
      return { target: jobId, payload: { plan: p }, reserve: p.reserve ?? null,
        afterDigest: sha256(JSON.stringify(request)),
        summary: [`Fork ${jobId} ${p.job.fork.position} entry ${p.job.fork.fromEntry}`, `Branch ${p.branch}: a separate pull request on queue ${p.queue}; the original run is preserved`, ...(p.job.thinkingLevel ? [`Thinking level: ${p.job.thinkingLevel}`] : []), ...runFieldsLines(p.runFields, "It runs as its trigger says now")] };
    },
    async apply(entry, ctx) {
      const { rm, paths } = ctx.a;
      const res = await rm.enqueueRunFork(entry.payload.plan, { url: paths.valkeyUrl, logsDir: paths.logsDir, triggersPath: paths.triggersPath ?? null, ...reserveInputs(ctx), fs: ctx.fs, now: ctx.now });
      return funnelResult(res, { jobId: res?.jobId ?? null, queue: res?.queue ?? null });
    },
  },
  {
    name: "rerun",
    kind: "run-rerun",
    paid: true,
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const { rm, paths } = ctx.a;
      const got = planned(await rm.planRerun({ url: paths.valkeyUrl, logsDir: paths.logsDir, jobId, triggersPath: paths.triggersPath ?? null, ...reserveInputs(ctx), fs: ctx.fs }));
      if (!got.plan) return got;
      const p = got.plan;
      const what = p.kind === "forge" ? `${p.forge} run, rebuilt from its retained job data with a new delivery id` : p.kind === "cron" ? "cron run, fired once by hand from its trigger as the triggers file says now" : "local run, its folder, flow and task queued again";
      return {
        target: jobId,
        payload: { plan: p },
        reserve: p.reserve ?? null,
        summary: [`Re-run ${jobId}: a ${what}`, `On queue ${p.queue}${typeof p.job?.flow === "string" ? `, flow ${p.job.flow}` : ""}`, ...runFieldsLines(p.runFields, "It runs as its trigger says now")],
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.enqueueRerun(entry.payload.plan, { url: ctx.a.paths.valkeyUrl, now: ctx.now });
      return funnelResult(res, { jobId: res?.jobId ?? null, queue: res?.queue ?? null });
    },
  },
  {
    name: "parked-answer",
    kind: "parked-answer",
    paid: true,
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      if (body.decision !== undefined && !["approve", "decline"].includes(body.decision)) return { refusal: "approval decision must be approve or decline; nothing was queued" };
      const jobId = jobIdOf(body);
      const answerText = typeof body.text === "string" ? body.text : "";
      const text = body.decision === "approve" ? "/approve" : body.decision === "decline" ? `/decline${answerText.trim() ? ` ${answerText.trim()}` : ""}` : answerText;
      const { rm, paths } = ctx.a;
      // `by` is the session's token name, never anything the body says: the trail comment names who answered.
      const got = planned(await rm.planParkedAnswer({ url: paths.valkeyUrl, logsDir: paths.logsDir, jobId, text, by: ctx.session.name, triggersPath: paths.triggersPath ?? null, ...reserveInputs(ctx), fs: ctx.fs, now: ctx.now }));
      if (!got.plan) return got;
      const p = got.plan;
      const answer = String(p.job?.trigger?.comment?.body ?? "");
      return {
        target: jobId,
        payload: { plan: p },
        reserve: p.reserve ?? null,
        // The answer's digest, never its text: the audit row's afterDigest (INT-CONSOLE-AUDIT-LOG).
        afterDigest: sha256(answer),
        summary: [`${p.approval ? "Decide approval for" : "Answer parked run"} ${jobId} on ${p.forge}, as ${ctx.session.name}`, ...(p.approval ? [`Gate ${p.approval.action}, request ${p.approval.requestId}`, p.approval.action === "budget-raise" ? `Approval permits an absolute resumed-job cap of $${p.approval.cap}, within deployment and scoped budgets; decline or a question grants no increase.` : "This external action is advisory; approval does not grant a new worker permission."] : []), `It resumes the parked transcript on queue ${p.queue}; once the job passes every check and reserve, the worker posts one comment on the issue saying the operator console answered, quoting the answer.`, ...runFieldsLines(p.runFields, p.approval ? "It runs as the original trigger says now" : "It runs as the comment trigger says now")],
        diff: textHtml(answer),
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.enqueueParkedAnswer(entry.payload.plan, { url: ctx.a.paths.valkeyUrl });
      return funnelResult(res, { jobIds: Array.isArray(res?.jobIds) ? res.jobIds.map(String) : [], queue: res?.queue ?? null });
    },
  },
  {
    // Issue #646 (REQ-STEER-RUNNING-JOB): a message into a running, steer-armed job. PAID, because the run spends tokens
    // reading it and acting on it, but it takes NO NEW RESERVE: the run already holds its reservation, and its turn,
    // dollar and token caps bind the extra turns exactly as they bind the rest (so `reserve` is null and the summary says
    // where the money comes from). The text is shown to the operator who typed it, in the preview alone; the audit row
    // carries its sha256 (`afterDigest`), never the text.
    name: "steer",
    kind: "steer",
    paid: true,
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const mode = body.mode === undefined || body.mode === null || body.mode === "" ? "steer" : body.mode;
      if (mode !== "steer" && mode !== "followUp") throw new BadRequest("mode must be steer or followUp");
      const text = typeof body.text === "string" ? body.text : "";
      // `by` is the session's token name, never anything the body says: the run's framing names who sent it.
      const got = planned(await ctx.a.rm.planSteer({ url: ctx.a.paths.valkeyUrl, jobId, text, mode, by: ctx.session.name, source: "console", now: ctx.now }));
      if (!got.plan) return got;
      const p = got.plan;
      return {
        // The job and the message id (review F2), never the text: the row's digest is the text's only trace.
        target: ctx.a.rm.steerAuditTarget(p.jobId, p.id),
        payload: { plan: p },
        reserve: null,
        afterDigest: p.digest,
        summary: [
          // `p.jobId` is the job that takes it: the page's own, or the run's active recovery job (review F4).
          `Send a ${mode === "followUp" ? "follow-up" : "steer"} to running job ${p.jobId}, as ${ctx.session.name} (message ${p.id}, ${plural(p.bytes, "byte")})`,
          mode === "followUp" ? "The agent reads it once it would otherwise stop, and the run goes on from it." : "The agent reads it after its current tool calls, before its next model call.",
          "It spends from this run's existing reservation: no new reserve is taken, and the run's turn, dollar and token caps still bind.",
          "The audit log keeps the message's sha256, never its text.",
        ],
        diff: textHtml(p.text),
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.enqueueSteer(entry.payload.plan, { url: ctx.a.paths.valkeyUrl, now: ctx.now });
      return funnelResult(res, { jobId: entry.payload.plan.jobId, id: res?.id ?? null, mode: res?.mode ?? null, state: res?.state ?? null });
    },
  },
  {
    // Issue #646: take a message back. Free. The answer names the state the withdraw met: `queued` is guaranteed (the
    // run never sees it), `written` best effort (the agent may already have read the file), as the preview warned.
    name: "steer-withdraw",
    kind: "steer-withdraw",
    paid: false,
    bulk: false,
    needs: JOB_NEEDS,
    async preview(body, ctx) {
      const jobId = jobIdOf(body);
      const id = str(body, "id", { required: true, max: 64 });
      if (!/^[0-9a-f]{32}$/.test(id)) throw new BadRequest("id must be a message id (32 lowercase hex characters, as the inbox lists it)");
      const got = planned(await ctx.a.rm.planSteerWithdraw({ url: ctx.a.paths.valkeyUrl, jobId, id }));
      if (!got.plan) return got;
      const p = got.plan;
      return {
        target: ctx.a.rm.steerAuditTarget(p.jobId, p.id),
        payload: { plan: p },
        summary: [
          `Withdraw message ${p.id} from job ${p.jobId}`,
          p.prior === "queued"
            ? "It is queued: the worker has not written it into the run yet, so withdrawing it is guaranteed and the run never sees it."
            : "It is already written into the run's inbox, so withdrawing it is best effort: the agent may have read it before the worker removes it. The run's transcript says whether it did.",
        ],
      };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.rm.withdrawSteerMessage(entry.payload.plan, { url: ctx.a.paths.valkeyUrl });
      return funnelResult(res, { jobId: entry.payload.plan.jobId, id: entry.payload.plan.id, prior: res?.prior ?? null, guaranteed: res?.guaranteed === true, said: typeof res?.said === "string" ? res.said : null });
    },
  },
];

/** How many jobs wait to start in these queue rows: waiting, paused (a paused queue's waiting jobs) and delayed. */
function waitingIn(rows) {
  let n = 0;
  for (const r of rows) for (const k of ["waiting", "paused", "delayed"]) n += Number.isSafeInteger(r?.counts?.[k]) && r.counts[k] > 0 ? r.counts[k] : 0;
  return n;
}

/**
 * A resume's paid side, said before the confirm (issue #642, CONST-BUDGET-BEFORE-TOKENS): a resume reserves nothing by
 * itself, but every job it lets start reserves up to its own per-job cap at pickup, so the preview says how many wait
 * in the queues it resumes (the fleet reader's snapshot `queueCounts`). No single dollar figure applies, so none is
 * shown; the count rides the ticket and the audit row (`count`; INT-CONSOLE-AUDIT-LOG takes a positive count only, so
 * a resume with nothing waiting writes none). `{ count, line }`, count null when unreadable, and null for a `floor`
 * too (issue #737): a short read's number is at least that many, which its line says ("At least"), and the ticket and
 * the audit row carry only an exact count, so a floor is never written as one.
 */
function resumeWaiting(rows, what, { floor = false } = {}) {
  const n = waitingIn(rows);
  const names = queuesNamed(rows.map((r) => String(r?.queue ?? "-")));
  return { count: floor ? null : n, line: `${floor ? "At least " : ""}${plural(n, "job waits", "jobs wait")} to start in ${what}${names ? ` (${names})` : ""}: each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up, so no single reserve figure applies` };
}

/**
 * The most queues a switch's preview, refusal or Undo names in one sentence (issue #737); past it the sentence names
 * these and says how many more. A deployment whose keyspace held 2,000 queues made the resume's waiting line 134,000
 * characters long, a bar nobody reads and a ticket and a banner that carry it whole.
 */
export const SWITCH_QUEUES_NAMED = 20;

/** Queue names as one sentence says them: every one up to `SWITCH_QUEUES_NAMED`, else those and "and N more". */
function queuesNamed(names) {
  const shown = names.slice(0, SWITCH_QUEUES_NAMED).join(", ");
  return names.length > SWITCH_QUEUES_NAMED ? `${shown}, and ${names.length - SWITCH_QUEUES_NAMED} more` : shown;
}

/**
 * Why a switch preview's read of the queues the switch flips is short (issue #737), each a summary line the preview
 * adds: the keyspace scan for the queues did not finish (the reader's `switchIncomplete`, its reason never shown: it
 * can be a client's error naming a host), so a queue may be missing; or the fleet holds more queues than one preview
 * reads (`switchTruncated`; the reader reads a bounded number of them, while the switch itself still flips every one).
 * Either way the counts are floors and the queues read are not the set the switch flips, so no exact Undo is built.
 * `truncated` is the line where the snapshot does not say how many the switch flips (`switchTotal`); where it does, the
 * line names both numbers (`switchReadLine`).
 */
export const SWITCH_SHORT_LINES = Object.freeze({
  incomplete: "The look for the fleet's queues did not finish, so a queue may be missing here and these counts are floors; the switch flips every queue it finds",
  truncated: "The fleet holds more queues than one preview reads, so these counts are of the queues it read, and floors; the switch itself flips every queue",
});

/**
 * The truncated line with its numbers: how many queues this preview read (`queueCounts`) of how many the switch flips
 * (the reader's `switchTotal`), or `SWITCH_SHORT_LINES.truncated` when the two do not make a read of fewer than all.
 */
export function switchReadLine(read, total) {
  if (!Number.isSafeInteger(read) || !Number.isSafeInteger(total) || read < 0 || total <= read) return SWITCH_SHORT_LINES.truncated;
  return `This preview read ${read} of the ${total} queues the switch flips, so these counts are of those it read, and floors; the switch itself flips every queue`;
}

/** The keys of `SWITCH_SHORT_LINES` that hold for this switch snapshot, in that order; empty for a whole read. */
function switchShortOf(snapshot) {
  const truncated = snapshot?.switchTruncated === true || (Number.isSafeInteger(snapshot?.switchTruncated) && snapshot.switchTruncated > 0);
  return [...(typeof snapshot?.switchIncomplete === "string" && snapshot.switchIncomplete !== "" ? ["incomplete"] : []), ...(truncated ? ["truncated"] : [])];
}

/** The summary line of each `switchShortOf` key for this snapshot: the truncated one with its numbers. */
function switchShortLines(snapshot, keys) {
  const read = Array.isArray(snapshot?.queueCounts) ? snapshot.queueCounts.length : null;
  return keys.map((k) => (k === "truncated" ? switchReadLine(read, snapshot?.switchTotal) : SWITCH_SHORT_LINES[k]));
}

/**
 * A one-queue switch's refusal for a queue a short read (`switchShortOf`) did not see: it cannot say the queue does not
 * exist, so it says why it cannot tell.
 */
export const queueUnreadRefusal = (queue) => `${JSON.stringify(queue)} is not among the queues this preview read, and it did not read every queue, so whether this deployment drains it is not known here; nothing was changed`;

/**
 * A fleet resume's waiting line when the snapshot was not read (issue #737): the bound fired (`snapshotOf`'s
 * `timedOut`) or the read failed, two different things the line once told alike as "the fleet did not answer".
 */
export const RESUME_WAITING_UNKNOWN = Object.freeze({
  timeout: `How many jobs wait to start is not known: the fleet did not answer within ${SNAPSHOT_TIMEOUT_MS / 1000} seconds. Each reserves up to its own per-job dollar cap when a worker picks it up`,
  unread: "How many jobs wait to start is not known: the fleet could not be read. Each reserves up to its own per-job dollar cap when a worker picks it up",
});

/** The fleet's pause or resume: the kill switch's decision at the preview, the fleet reader's funnel at the confirm. */
function fleetSwitch({ name, kind, paused }) {
  return {
    name,
    kind,
    paid: !paused,
    bulk: false,
    needs: FLEET_NEEDS,
    async preview(_body, ctx) {
      const decide = ctx.a.killSwitchPlanFn;
      const plan = typeof decide === "function" ? decide({ paused }) : { urls: [ctx.a.paths?.valkeyUrl].filter(Boolean), disagreement: null };
      if (plan?.refused) return { refusal: String(plan.refused) };
      const shown = (plan?.urls ?? []).map((u) => (typeof ctx.a.urlShown === "function" ? ctx.a.urlShown(u) : "the deployment's Valkey"));
      let waiting = null;
      // A resume's Undo re-pauses what was paused before it (`resumeBack`): how many queues the switch flips and which of
      // them were paused (`SWITCH_READ`), or null when the snapshot could not be read. A read that was short
      // (`switchShortOf`) marks it `short`: its queues are not the set the switch flips, so it names no exact Undo.
      let pausedBefore = null;
      let short = [];
      let shortLines = [];
      if (!paused) {
        const s = await snapshotOf(ctx, SWITCH_READ);
        if (s.snapshot) {
          const all = Array.isArray(s.snapshot.queueCounts) ? s.snapshot.queueCounts : [];
          const rows = all.filter((q) => q?.paused);
          short = switchShortOf(s.snapshot);
          shortLines = switchShortLines(s.snapshot, short);
          waiting = resumeWaiting(rows, "the paused queues", { floor: short.length > 0 });
          pausedBefore = Array.isArray(s.snapshot.queueCounts) ? { queues: all.length, paused: rows.map((q) => String(q?.queue ?? "-")), ...(short.length > 0 ? { short: true } : {}) } : null;
        } else {
          waiting = { count: null, line: s.timedOut === true ? RESUME_WAITING_UNKNOWN.timeout : RESUME_WAITING_UNKNOWN.unread };
        }
      }
      return {
        target: "fleet",
        payload: {},
        ...(paused ? {} : { pausedBefore }),
        ...(waiting ? { count: waiting.count } : {}),
        summary: [paused ? "Pause every queue of the fleet (the kill switch): nothing new starts, running jobs finish" : "Resume every queue of the fleet: queued jobs start spending again", `Valkey: ${shown.join(", ") || "the deployment's"}`, ...(plan?.disagreement ? [`${plan.disagreement}: a pause reaches both`] : []), ...(waiting ? [waiting.line] : []), ...shortLines],
      };
    },
    async apply(_entry, ctx) {
      let res;
      try {
        res = paused ? await ctx.a.fleet.pause() : await ctx.a.fleet.resume();
      } catch (e) {
        // The switch walks the plan's Valkeys one after another (`killSwitchSet`), so a throw can come after one of them
        // took it: what it reached is unknown, never "nothing".
        return { invalid: `the kill switch stopped with an error (${codeOf(e)}) before it said which queues it reached. Look at the fleet and try again`, partial: true };
      }
      if (res?.refused) return { invalid: String(res.refused) };
      const results = (res?.results ?? []).map((r) => ({ valkey: String(r.shown ?? "-"), ok: r.res?.ok === true, ...(Array.isArray(r.res?.queues) ? { queues: r.res.queues.map(String) } : {}), ...(r.res?.partial ? { partial: { done: (r.res.partial.done ?? []).map(String), failed: String(r.res.partial.failed ?? "-") } } : {}) }));
      if (results.length > 0 && results.every((r) => r.ok)) return { ok: true, results };
      // Issue #737: a Valkey that took the switch, or a loop that stopped part-way (the queue it failed at may have
      // flipped too: the error came back, not the state), means part of the fleet DID change, so the refusal is
      // `partial` and the slot never says "Nothing was changed" over it. Only when no Valkey's loop started did nothing.
      const partial = results.some((r) => r.ok || r.partial);
      return { invalid: `the kill switch did not reach every queue: ${results.map((r) => `${r.valkey} ${r.ok ? "done" : r.partial ? `stopped after ${r.partial.done.join(", ") || "none"}, failed at ${r.partial.failed}` : "unreachable"}`).join("; ") || "no Valkey answered"}. Look at the fleet and try again`, ...(partial ? { partial: true } : {}) };
    },
  };
}

/** One queue's pause or resume. */
function queueSwitch({ name, kind, paused }) {
  return {
    name,
    kind,
    paid: !paused,
    bulk: false,
    needs: FLEET_NEEDS,
    async preview(body, ctx) {
      const queue = str(body, "queue", { required: true, max: 200 });
      // The reader reads the named queue whatever its bound, so a queue past the first it reads is still found.
      const s = await snapshotOf(ctx, { ...SWITCH_READ, queue });
      if (!s.snapshot) return s;
      const rows = Array.isArray(s.snapshot.queueCounts) ? s.snapshot.queueCounts : [];
      const row = rows.find((q) => q?.queue === queue);
      // A read that was short (`switchShortOf`) cannot say a queue it did not read does not exist: it says why instead.
      if (!row && switchShortOf(s.snapshot).length > 0) return { refusal: queueUnreadRefusal(queue) };
      if (!row) return { refusal: `${JSON.stringify(queue)} is not a queue this deployment drains (${queuesNamed(rows.map((q) => String(q?.queue ?? "-")))}); nothing was changed` };
      if (Boolean(row.paused) === paused) return { unchanged: `${queue} is already ${paused ? "paused" : "running"}` };
      const waiting = paused ? null : resumeWaiting([row], "it");
      return { target: queue, payload: { queue }, ...(waiting ? { count: waiting.count } : {}), summary: [paused ? `Pause queue ${queue}: nothing new starts there; the rest of the fleet keeps running` : `Resume queue ${queue}: its queued jobs start again`, ...(waiting ? [waiting.line] : [])] };
    },
    async apply(entry, ctx) {
      const res = await ctx.a.fleet.pauseQueue({ queue: entry.payload.queue, paused });
      return funnelResult(res, { queue: entry.payload.queue, paused });
    },
  };
}

const fleetActions = [
  fleetSwitch({ name: "fleet-pause", kind: "fleet-pause", paused: true }),
  fleetSwitch({ name: "fleet-resume", kind: "fleet-resume", paused: false }),
  queueSwitch({ name: "queue-pause", kind: "queue-pause", paused: true }),
  queueSwitch({ name: "queue-resume", kind: "queue-resume", paused: false }),
];

// ---- what each write takes, and how it is undone ------------------------------------------------------------------

/**
 * The Undo sentences of the writes the console cannot undo with another write (issue #737). Each is a ledger's
 * `absent` source or a `new` one, and each says what a person CAN do, never only that they cannot. The bar and the
 * banner draw one as "No undo: <sentence>", so none opens with "Cannot be undone" of its own.
 *
 * A RETRY HAS NO UNDO, A RE-RUN HAS ONE. The design's "Undo: Cancel the new run" is `cancel-queued`, which takes only a
 * job that never started. BullMQ's retry of a failed job keeps the attempts it made (`reprocessJob` drops `atm` only
 * when asked to reset them, and the console's retry does not), so a retried job is never one `cancel-queued` takes:
 * `retried` says so. A re-run queues a NEW job, which has made no attempt, so its Undo is that job's cancel, decided at
 * the confirm where its id is known (`atConfirm`); the bar says so beforehand (`rerunBefore`).
 *
 * TWO PLACES. The bar is drawn beside the preview, so its sentence may point at it ("copy them from this preview"). The
 * banner after the write is on the next page, where no preview is, so each sentence that points at one has a twin for
 * the banner (`...After`, issue #737) that says the console kept no copy instead. A rule's `undo` answers one
 * string (said in both places) or `{ bar, after }`.
 */
export const UNDO_SENTENCES = Object.freeze({
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

/** An Undo said in the bar, and in the banner after the write without pointing at the preview that is gone by then. */
const twice = (bar, after) => Object.freeze({ bar, after });
const DELETED = twice(UNDO_SENTENCES.delete, UNDO_SENTENCES.deleteAfter);

/**
 * A fleet resume's Undo when more queues were paused than one sentence names (`SWITCH_QUEUES_NAMED`): by hand, the bar
 * saying the preview names only the first of them and the banner after it that the console kept no list.
 */
export const resumeManyUndo = (n) => {
  const lead = `Pause the ${n} queues that were paused again by hand, one at a time: no single write pauses only those`;
  return twice(`${lead}, and this preview names only the first ${SWITCH_QUEUES_NAMED}.`, `${lead}, and the console kept no list of them.`);
};

/** A file's JSON as it was before the change (`beforeText`), or null when it was missing or does not parse. */
function jsonOf(text) {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The list a file holds under `key` before the change (`[]` when it holds none), as the planners read it. */
const listBefore = (out, key) => (Array.isArray(jsonOf(out.beforeText)?.[key]) ? jsonOf(out.beforeText)[key] : []);

/** A sentence for an edit that cannot be put back by another edit: the field it gave a value had none before. */
const byHand = (what, field) => `Edit ${what} back by hand: ${field} had no value before, and an edit cannot remove one.`;

/**
 * A paid single act's confirm words (the ConfirmStates card): the most the worker will hold for it, or why no figure
 * can be said. Never "$0" for a reserve that is not known, the `reserveText` rule; and a zero-rated act says so in
 * words (issue #737): "$0.00" on a button reads as a price, and the reserve sentence beside it says what it holds.
 */
function paidLabel(verb, r) {
  if (!r || r.unknown || r.invalid) return `${verb} (reserve unknown)`;
  if (r.zeroRated) return `${verb} (zero-rated)`;
  if (!Number.isSafeInteger(r.dollarsMicros)) return `${verb}, 1 job slot`;
  return `${verb} for up to $${formatMicros(r.dollarsMicros)}`;
}

/**
 * A paid bulk act's confirm words: the sum of the known reserves, "at least" when some are unknown (the total is then
 * a floor), "zero-rated" when every job is, and "no dollar reserve" when no job holds dollars (no per-job cap, or a cap
 * of $0): the slots alone would repeat the count ("Retry 3, 3 job slots"), and the reserve sentence says them.
 */
function bulkPaidLabel(verb, out) {
  const n = Array.isArray(out.targets) ? out.targets.length : 0;
  const r = out.reserve ?? {};
  const each = (out.targets ?? []).map((t) => t.reserve);
  if (r.unknown > 0) return r.dollarsMicros > 0 ? `${verb} ${n}, at least $${formatMicros(r.dollarsMicros)}` : `${verb} ${n} (reserve unknown)`;
  if (r.dollarsMicros > 0) return `${verb} ${n} for up to $${formatMicros(r.dollarsMicros)}`;
  if (each.length > 0 && each.every((x) => x?.zeroRated)) return `${verb} ${n} (zero-rated)`;
  return `${verb} ${n}, no dollar reserve`;
}

const say = (sentence) => () => sentence;
const none = () => null;
const confirmWord = () => "Confirm";

/** Whether a re-run's answer names the job it queued, and where: what its cancel needs (`WRITE_RULES` `rerun`). */
const rerunCancel = (result) => typeof result?.jobId === "string" && result.jobId !== "" && typeof result?.queue === "string" && result.queue !== "";

/**
 * A setting's way back: set it to the value it had, or unset it when it had none. A value this form cannot send back
 * as it was (not a string or a number, or an empty string) is put back by hand.
 */
function settingBack(out, key) {
  const before = jsonOf(out.beforeText) ?? {};
  if (!Object.hasOwn(before, key)) return { undo: `Unset ${key} again`, inverse: { action: "setting-unset", body: { key } } };
  const old = before[key];
  const sendable = (typeof old === "string" && old.trim() !== "") || (typeof old === "number" && Number.isFinite(old));
  if (!sendable) return { undo: `Set ${key} back by hand: its old value is not one this form can send.`, inverse: null };
  return { undo: `Set ${key} back to ${String(old)}`, inverse: { action: "setting-set", body: { key, value: String(old) } } };
}

/**
 * A fleet resume's way back (issue #737): pause again exactly what was paused before it, by the preview's read of the
 * fleet (`pausedBefore`: how many queues the resume flips, the snapshot's `queueCounts` read over `SWITCH_READ`, and
 * which were paused). The whole fleet is `fleet-pause` and one queue `queue-pause`; any other set is one no write
 * carries (`fleet-pause` takes no list), so it has no inverse and the sentence names the queues to pause by hand.
 * NEVER `fleet-pause` FOR A PART: Resume fleet is offered on a fleet partly paused, and an Undo that paused every queue
 * stopped the hosts the operator had left running, the opposite of a way back. An unread fleet names no set at all.
 *
 * NOR OVER A SHORT READ (issue #737): a preview whose scan for the queues did not finish, or that read only the first
 * of more queues than it reads (`pausedBefore.short`), saw a part of the set and cannot tell "every queue was paused"
 * or "only this one was" from what it saw; its Undo is the by-hand line. Past `SWITCH_QUEUES_NAMED` paused queues no
 * sentence names them all, so that Undo is by hand too, and says the console has no list of them.
 */
function resumeBack(out) {
  const b = out.pausedBefore;
  if (!b || !Number.isSafeInteger(b.queues) || !Array.isArray(b.paused)) return { undo: UNDO_SENTENCES.resumeUnread, inverse: null };
  if (b.short === true) return { undo: UNDO_SENTENCES.resumeShort, inverse: null };
  if (b.paused.length === 0) return { undo: "No queue of the fleet was paused, so there is nothing to pause again.", inverse: null };
  if (b.paused.length === b.queues) return { undo: "Pause the fleet again", inverse: { action: "fleet-pause", body: {} } };
  if (b.paused.length === 1) return { undo: `Pause queue ${b.paused[0]} again`, inverse: { action: "queue-pause", body: { queue: b.paused[0] } } };
  if (b.paused.length > SWITCH_QUEUES_NAMED) return { undo: resumeManyUndo(b.paused.length), inverse: null };
  return { undo: `Pause queues ${b.paused.join(", ")} again by hand, one at a time: no single write pauses only those.`, inverse: null };
}

/**
 * What a setting set did, in the past tense: "Changed maxTurns from 30 to 40", "Set dailyCap to 5" for a key the file
 * did not hold, and "Changed maxTurns to 40" when its old value is not one a sentence can say (an empty string, an
 * object: the Undo then goes by hand too).
 */
function settingDone(out) {
  const key = out.plan.key;
  const before = jsonOf(out.beforeText) ?? {};
  const value = String(out.plan.value);
  if (!Object.hasOwn(before, key)) return `Set ${key} to ${value}`;
  const old = before[key];
  const sayable = (typeof old === "string" && old.trim() !== "") || (typeof old === "number" && Number.isFinite(old));
  return sayable ? `Changed ${key} from ${String(old)} to ${value}` : `Changed ${key} to ${value}`;
}

/**
 * The whole pause-windows list's way back: the list as it was. A file that held no list it could read (not JSON, or no
 * `windows` array) read as empty, and an empty list is not what it said, so that one is put back by hand.
 */
function pauseListBack(out) {
  const unread = typeof out.beforeText === "string" && !Array.isArray(jsonOf(out.beforeText)?.windows);
  if (unread) return { undo: twice(UNDO_SENTENCES.tooBig, UNDO_SENTENCES.tooBigAfter), inverse: null };
  return { undo: "Put the previous pause windows back", inverse: { action: "pause-windows", body: { windows: out.extra.before } } };
}

/** A trigger edit's way back: the old flow, and the old value of each of backend, provider and model it set. */
function triggerEditBack(out) {
  const p = out.plan ?? {};
  const n = atIndex("trigger", p.index);
  const old = listBefore(out, "triggers")[p.index]?.run ?? {};
  const set = ["flow", ...(p.backend !== undefined ? ["backend"] : []), ...["provider", "model"].filter((k) => p.ref?.[k] !== undefined)];
  const missing = set.find((k) => typeof old[k] !== "string" || old[k] === "");
  if (missing !== undefined) return { undo: byHand(n, missing), inverse: null };
  return { undo: `Edit ${n} back to what it said`, inverse: { action: "trigger-edit", body: { index: p.index, ...Object.fromEntries(set.map((k) => [k, old[k]])) } } };
}

/**
 * A trigger delete's way back, by hand (no inverse can carry a secret reference): the removed lines from the preview,
 * and, for a trigger that names secrets (`run.secrets`, which the diff hides), its references from the operator's own
 * copy of the file (issue #737), since "copy them from this preview" would copy the marker the diff shows.
 */
function triggerDeleteBack(out) {
  const secrets = listBefore(out, "triggers")[out.plan?.index]?.run?.secrets;
  const named = secrets !== null && typeof secrets === "object" && Object.keys(secrets).length > 0;
  return named ? twice(UNDO_SENTENCES.deleteSecrets, UNDO_SENTENCES.deleteSecretsAfter) : DELETED;
}

/**
 * An entry edit's way back (a pause window, a scoped limit): the entry as the planner read it (`plan.before`, through
 * the same builder the edit runs, so a default the reader fills in, a pause window's `tz: "UTC"`, is on both sides),
 * unless the edit gave a field a value it had none for, which an edit cannot take away again.
 */
function entryEditBack(out, { action, what, wrap }) {
  const p = out.plan ?? {};
  const n = atIndex(what, p.index);
  const before = p.before;
  if (before === null || typeof before !== "object") return { undo: twice(`Edit ${n} back by hand: this preview's diff shows what it said.`, `Edit ${n} back by hand: the console kept no copy of what it said.`), inverse: null };
  const added = Object.keys(p.entry ?? {}).find((k) => before[k] === undefined && p.entry[k] !== undefined);
  if (added !== undefined) return { undo: byHand(n, added), inverse: null };
  return { undo: `Edit ${n} back to what it said`, inverse: { action, body: { index: p.index, ...wrap(before) } } };
}

/** A resolver add's way back: remove it again, unless it REPLACED one, whose path the console keeps no copy of. */
function resolverAddBack(out, { key, remove, what }) {
  const name = out.plan?.name;
  if (Object.hasOwn(jsonOf(out.beforeText)?.[key] ?? {}, name)) return { undo: twice(`Put ${what} ${name} back by hand: this preview's diff shows the resolver it replaced; the console keeps no copy.`, `Put ${what} ${name} back by hand: the console kept no copy of the resolver it replaced.`), inverse: null };
  return { undo: `Remove ${what} ${name}`, inverse: { action: remove, body: { name } } };
}

/** Whether a resolver add replaced one of the same name (its banner says "Replaced", not "Declared"). */
const replacedOne = (out, key) => Object.hasOwn(jsonOf(out.beforeText)?.[key] ?? {}, out.plan?.name);

/** A bulk filter as the banner says it: " in pi-jobs", " for acme/web", or nothing (the preview's filter, on the ticket). */
const whereOf = (payload) => `${typeof payload?.queue === "string" ? ` in ${payload.queue}` : ""}${typeof payload?.repo === "string" ? ` for ${payload.repo}` : ""}`;

/**
 * A bulk act's banner (issue #737): every job done is "Retried 3 failed jobs in pi-jobs"; some is
 * "Retried failed jobs in pi-jobs: 2 of 3 done" (the banner then in the attention tone); none leaves no banner at all.
 */
const bulkDone = (verb, noun) => (out, _body, { done, count }) => (done === count ? `${verb} ${plural(count, noun)}${whereOf(out.payload)}` : `${verb} ${noun}s${whereOf(out.payload)}: ${done} of ${count} done`);

/**
 * Each action's write rules, by name (issue #737): `fields`, `danger`, `undo`, `inverse`, `confirmLabel` (the entry's
 * header says what each is) and `done`, what the banner after the write says happened, in the past tense ("Paused the
 * fleet", "Changed maxTurns from 30 to 40"; the act's own summary, "Pause every queue of the fleet", stays the
 * preview's title). One table, so the rules of every write read together and a write cannot exist without them:
 * `ACTIONS` below throws at load on an action this table does not name, and the action test iterates `ACTIONS` so none
 * is missed.
 *
 * WHEN `done` IS ASKED. A single act's at the preview, `done(out, body)`, where the file as it was is known (a
 * setting's old value), and it rides the ticket with the Undo. A bulk act's at the confirm, `done(out, body, result)`
 * with the ticket's entry as `out` (its `targets` and `payload`) and `result` `{ done, count }`, since only the confirm
 * knows how many jobs landed. The Undo of a rule with `atConfirm: true` (optional, a single act's) is asked at both:
 * `undo(out, body)` and `inverse(out, body)` at the preview for the bar, then `undo(entry, null, result)` and
 * `inverse(entry, null, result)` at the confirm, with the apply's answer, for the banner.
 *
 * Indexes stay the 0-based values the forms send, and every sentence says them as the Configuration page does, "trigger
 * at index 2" (`atIndex`), until that page converts (PR 7a). An inverse never carries a secret reference or a
 * resolver path: the deletes and the secret removes, whose only way back would, have none.
 */
const PAUSE_FIELDS = Object.freeze(["scope", "from", "to", "tz", "days", "dateFrom", "dateTo"]);
const WRITE_RULES = {
  "cancel-active": { fields: ["jobId"], danger: true, undo: say(UNDO_SENTENCES.cancelled), inverse: none, confirmLabel: () => "Cancel the run", done: (out) => `Cancelled running job ${out.payload.jobId}` },
  "cancel-held": { fields: ["jobId"], danger: true, undo: say(UNDO_SENTENCES.held), inverse: none, confirmLabel: () => "Cancel the held job", done: (out) => `Cancelled held job ${out.payload.jobId}` },
  "cancel-all-held": { fields: [], danger: true, undo: say(UNDO_SENTENCES.held), inverse: none, confirmLabel: (out) => `Cancel ${plural(out.targets?.length ?? 0, "held job")}`, done: bulkDone("Cancelled", "held job") },
  "cancel-queued": { fields: ["jobId", "queue"], danger: true, undo: say(UNDO_SENTENCES.cancelledQueued), inverse: none, confirmLabel: () => "Cancel the queued job", done: (out) => `Cancelled queued job ${out.payload.jobId}` },
  "retry-failed": { fields: ["jobId", "queue"], danger: false, undo: say(UNDO_SENTENCES.retried), inverse: none, confirmLabel: (out) => paidLabel("Retry", out.reserve), done: (out) => `Retried failed job ${out.payload.jobId}` },
  "remove-failed": { fields: ["jobId", "queue"], danger: true, undo: say(UNDO_SENTENCES.removed), inverse: none, confirmLabel: () => "Remove the job", done: (out) => `Removed failed job ${out.payload.jobId}` },
  "retry-all-failed": { fields: ["queue", "repo"], danger: false, undo: say(UNDO_SENTENCES.retried), inverse: none, confirmLabel: (out) => bulkPaidLabel("Retry", out), done: bulkDone("Retried", "failed job") },
  "remove-all-failed": { fields: ["queue", "repo"], danger: true, undo: say(UNDO_SENTENCES.removed), inverse: none, confirmLabel: (out) => `Remove ${plural(out.targets?.length ?? 0, "job")}`, done: bulkDone("Removed", "failed job") },
  "run-fork": {
    fields: ["jobId", "entry", "position", "point", "provider", "model", "thinking", "message"],
    danger: false,
    atConfirm: true,
    undo: (out, body, result) => (result === undefined ? UNDO_SENTENCES.rerunBefore : rerunCancel(result) ? `Cancel ${result.jobId} before it starts` : UNDO_SENTENCES.rerunUnnamed),
    inverse: (out, body, result) => (rerunCancel(result) ? { action: "cancel-queued", body: { jobId: result.jobId, queue: result.queue } } : null),
    confirmLabel: (out) => paidLabel("Fork", out.reserve),
    done: (out) => `Queued a fork of ${out.target}`,
  },
  rerun: {
    fields: ["jobId"],
    danger: false,
    // The new job's cancel, decided at the confirm (`atConfirm`): the enqueue mints its id. At the preview (`result`
    // undefined) the bar says the banner will offer it. An answer without the job's id or queue (`enqueueRerun` answers
    // both whenever a job was queued) offers no cancel it could not name, and says so (`rerunUnnamed`).
    atConfirm: true,
    // The sentence and the button are judged alike, so a banner never says "No undo: Cancel <id> before it starts".
    undo: (out, body, result) => (result === undefined ? UNDO_SENTENCES.rerunBefore : rerunCancel(result) ? `Cancel ${result.jobId} before it starts` : UNDO_SENTENCES.rerunUnnamed),
    inverse: (out, body, result) => (rerunCancel(result) ? { action: "cancel-queued", body: { jobId: result.jobId, queue: result.queue } } : null),
    confirmLabel: (out) => paidLabel("Re-run", out.reserve),
    done: (out) => `Queued a re-run of ${out.target}`,
  },
  "parked-answer": { fields: ["jobId", "text", "decision"], danger: false, undo: say(UNDO_SENTENCES.answer), inverse: none, confirmLabel: (out) => paidLabel("Answer", out.reserve), done: (out) => `Answered parked run ${out.target}` },
  steer: {
    fields: ["jobId", "mode", "text"],
    danger: false,
    // The message's id and the job that takes it are the plan's (`payload.plan`): the run's active recovery job when
    // there is one, never the page's id taken on trust.
    undo: (out) => `Withdraw message ${out.payload.plan.id} before the agent reads it`,
    inverse: (out) => ({ action: "steer-withdraw", body: { jobId: out.payload.plan.jobId, id: out.payload.plan.id } }),
    confirmLabel: (out) => (out.payload?.plan?.mode === "followUp" ? "Send follow-up" : "Send"),
    done: (out) => `Sent a ${out.payload.plan.mode === "followUp" ? "follow-up" : "steer"} to running job ${out.payload.plan.jobId}`,
  },
  "steer-withdraw": { fields: ["jobId", "id"], danger: false, undo: say(UNDO_SENTENCES.withdrawn), inverse: none, confirmLabel: confirmWord, done: (out) => `Withdrew message ${out.payload.plan.id} from job ${out.payload.plan.jobId}` },
  "fleet-pause": { fields: [], danger: true, undo: say("Resume the fleet"), inverse: () => ({ action: "fleet-resume", body: {} }), confirmLabel: () => "Pause the fleet", done: say("Paused the fleet") },
  "fleet-resume": { fields: [], danger: false, undo: (out) => resumeBack(out).undo, inverse: (out) => resumeBack(out).inverse, confirmLabel: () => "Resume", done: say("Resumed the fleet") },
  "queue-pause": { fields: ["queue"], danger: true, undo: (out) => `Resume queue ${out.payload.queue}`, inverse: (out) => ({ action: "queue-resume", body: { queue: out.payload.queue } }), confirmLabel: (out) => `Pause queue ${out.payload.queue}`, done: (out) => `Paused queue ${out.payload.queue}` },
  "queue-resume": { fields: ["queue"], danger: false, undo: (out) => `Pause queue ${out.payload.queue} again`, inverse: (out) => ({ action: "queue-pause", body: { queue: out.payload.queue } }), confirmLabel: () => "Resume", done: (out) => `Resumed queue ${out.payload.queue}` },
  "pause-windows": { fields: ["windows"], danger: false, undo: (out) => pauseListBack(out).undo, inverse: (out) => pauseListBack(out).inverse, confirmLabel: confirmWord, done: say("Replaced the pause windows") },
  "trigger-add": { fields: ["trigger"], danger: false, undo: (out) => `Delete ${atIndex("trigger", listBefore(out, "triggers").length)}`, inverse: (out) => ({ action: "trigger-delete", body: { index: listBefore(out, "triggers").length } }), confirmLabel: confirmWord, done: (out) => `Added ${atIndex("trigger", listBefore(out, "triggers").length)} (${out.plan?.entry?.on?.type ?? "a trigger"})` },
  "trigger-edit": { fields: ["index", "flow", "backend", "provider", "model"], danger: false, undo: (out) => triggerEditBack(out).undo, inverse: (out) => triggerEditBack(out).inverse, confirmLabel: confirmWord, done: (out) => `Changed ${atIndex("trigger", out.plan.index)}: ${(out.plan.changes ?? []).map(([k, a, b]) => `${k} from ${a} to ${b}`).join(", ")}` },
  "trigger-delete": { fields: ["index"], danger: true, undo: triggerDeleteBack, inverse: none, confirmLabel: (out) => `Delete ${atIndex("trigger", out.plan?.index)}`, done: (out) => `Deleted ${atIndex("trigger", out.plan.index)}` },
  "setting-set": { fields: ["key", "value"], danger: false, undo: (out) => settingBack(out, out.plan.key).undo, inverse: (out) => settingBack(out, out.plan.key).inverse, confirmLabel: confirmWord, done: settingDone },
  "setting-unset": { fields: ["key"], danger: false, undo: (out) => settingBack(out, out.plan.key).undo, inverse: (out) => settingBack(out, out.plan.key).inverse, confirmLabel: confirmWord, done: (out) => `Unset ${out.plan.key}` },
  "secret-profile-add": { fields: ["name", "path"], danger: false, undo: (out) => resolverAddBack(out, { key: "secretProfiles", remove: "secret-profile-remove", what: "profile" }).undo, inverse: (out) => resolverAddBack(out, { key: "secretProfiles", remove: "secret-profile-remove", what: "profile" }).inverse, confirmLabel: confirmWord, done: (out) => (replacedOne(out, "secretProfiles") ? `Replaced the resolver of profile ${out.plan.name}` : `Declared profile ${out.plan.name}`) },
  "secret-profile-remove": { fields: ["name"], danger: true, undo: say(DELETED), inverse: none, confirmLabel: (out) => `Remove profile ${out.plan?.name}`, done: (out) => `Removed profile ${out.plan.name}` },
  "secret-bundle-add": { fields: ["name", "path", "format"], danger: false, undo: (out) => resolverAddBack(out, { key: "secretBundles", remove: "secret-bundle-remove", what: "bundle resolver" }).undo, inverse: (out) => resolverAddBack(out, { key: "secretBundles", remove: "secret-bundle-remove", what: "bundle resolver" }).inverse, confirmLabel: confirmWord, done: (out) => (replacedOne(out, "secretBundles") ? `Replaced bundle resolver ${out.plan.name}` : `Declared bundle resolver ${out.plan.name}`) },
  "secret-bundle-remove": { fields: ["name"], danger: true, undo: say(DELETED), inverse: none, confirmLabel: (out) => `Remove bundle resolver ${out.plan?.name}`, done: (out) => `Removed bundle resolver ${out.plan.name}` },
  "pause-window-add": { fields: PAUSE_FIELDS, danger: false, undo: (out) => `Delete ${atIndex("pause window", listBefore(out, "windows").length)}`, inverse: (out) => ({ action: "pause-window-delete", body: { index: listBefore(out, "windows").length } }), confirmLabel: confirmWord, done: (out) => `Added ${atIndex("pause window", listBefore(out, "windows").length)}` },
  "pause-window-edit": {
    fields: ["index", ...PAUSE_FIELDS],
    danger: false,
    undo: (out) => entryEditBack(out, PAUSE_EDIT).undo,
    inverse: (out) => entryEditBack(out, PAUSE_EDIT).inverse,
    confirmLabel: confirmWord,
    done: (out) => `Edited ${atIndex("pause window", out.plan.index)}`,
  },
  "pause-window-delete": { fields: ["index"], danger: true, undo: say(DELETED), inverse: none, confirmLabel: (out) => `Delete ${atIndex("pause window", out.plan?.index)}`, done: (out) => `Deleted ${atIndex("pause window", out.plan.index)}` },
  "limit-add": { fields: ["limit"], danger: false, undo: (out) => `Delete ${atIndex("scoped limit", listBefore(out, "limits").length)}`, inverse: (out) => ({ action: "limit-delete", body: { index: listBefore(out, "limits").length } }), confirmLabel: confirmWord, done: (out) => `Added ${atIndex("scoped limit", listBefore(out, "limits").length)}` },
  "limit-edit": { fields: ["index", "limit"], danger: false, undo: (out) => entryEditBack(out, LIMIT_EDIT).undo, inverse: (out) => entryEditBack(out, LIMIT_EDIT).inverse, confirmLabel: confirmWord, done: (out) => `Edited ${atIndex("scoped limit", out.plan.index)}` },
  "limit-delete": { fields: ["index"], danger: true, undo: say(DELETED), inverse: none, confirmLabel: (out) => `Delete ${atIndex("scoped limit", out.plan?.index)}`, done: (out) => `Deleted ${atIndex("scoped limit", out.plan.index)}` },
  "project-add": { fields: ["id", "name", "members"], danger: false, undo: (out) => `Delete project ${out.plan.added.id}`, inverse: (out) => ({ action: "project-delete", body: { id: out.plan.added.id } }), confirmLabel: confirmWord, done: (out) => `Added project ${out.plan.added.id}` },
  "project-edit": {
    fields: ["id", "name", "members"],
    danger: false,
    undo: (out) => `Edit project ${out.plan.before.id} back to what it said`,
    // An empty name is what removes one (the tool's rule), so a project that had none gets "" back, never its new name.
    inverse: (out) => ({ action: "project-edit", body: { id: out.plan.before.id, name: out.plan.before.name ?? "", members: [...out.plan.before.members] } }),
    confirmLabel: confirmWord,
    done: (out) => `Edited project ${out.plan.before.id}`,
  },
  "project-delete": { fields: ["id"], danger: true, undo: say(DELETED), inverse: none, confirmLabel: (out) => `Delete project ${out.plan?.deleted}`, done: (out) => `Deleted project ${out.plan.deleted}` },
  "envelope-set": { fields: ["envelope"], danger: false, undo: say(twice(UNDO_SENTENCES.envelope, UNDO_SENTENCES.envelopeAfter)), inverse: none, confirmLabel: confirmWord, done: say("Changed the allocation envelope") },
  "priorities-set": { fields: ["projects", "validDays"], danger: false, undo: say(UNDO_SENTENCES.allocation), inverse: none, confirmLabel: confirmWord, done: say("Applied a priorities plan") },
  "allocation-revert": { fields: ["index"], danger: false, undo: say(UNDO_SENTENCES.allocation), inverse: none, confirmLabel: confirmWord, done: (out) => `Reverted the allocation to ${atIndex("history row", out.payload.index)}` },
};

/** How an edit's way back reads its entry: the file's list, the row's word, and the body the edit takes the entry in. */
const PAUSE_EDIT = Object.freeze({ action: "pause-window-edit", what: "pause window", wrap: (w) => Object.fromEntries(PAUSE_FIELDS.filter((k) => w[k] !== undefined).map((k) => [k, w[k]])) });
const LIMIT_EDIT = Object.freeze({ action: "limit-edit", what: "scoped limit", wrap: (l) => ({ limit: { ...l } }) });

/** The rule functions every write carries. */
const RULE_FNS = Object.freeze(["undo", "inverse", "confirmLabel", "done"]);

/** An action with its write rules, or a throw at load: no write exists without its fields, its Undo, its confirm words and its banner. */
function withRules(a) {
  const r = Object.hasOwn(WRITE_RULES, a.name) ? WRITE_RULES[a.name] : null;
  if (r === null) throw new Error(`console action ${a.name} has no write rules (WRITE_RULES)`);
  if (!Array.isArray(r.fields) || typeof r.danger !== "boolean" || RULE_FNS.some((k) => typeof r[k] !== "function")) throw new Error(`console action ${a.name}'s write rules need fields, danger, ${RULE_FNS.join(", ")}`);
  if (r.danger && a.paid) throw new Error(`console action ${a.name} is paid and destructive; it is one or the other`);
  // `atConfirm` is carried as the rule says it, false when absent: the action test holds it a boolean and never on a
  // bulk act (a bulk confirm asks no rule for its Undo again, `confirmBulk`, so one would keep its preview's in silence).
  return Object.freeze({ ...a, fields: Object.freeze([...r.fields]), danger: r.danger, atConfirm: r.atConfirm ?? false, undo: r.undo, inverse: r.inverse, confirmLabel: r.confirmLabel, done: r.done });
}

/** Every action the console can take, by name. The routes, the pages' forms and the tests all read this table. */
export const ACTIONS = Object.freeze([...jobActions, ...fleetActions, ...configActions].map(withRules));

/** The action named `name`, or null. */
export function actionNamed(name) {
  return ACTIONS.find((a) => a.name === name) ?? null;
}

// ---- the pipeline ------------------------------------------------------------------------------------------------------

/** What the actions see: the server's deps, the action deps, the session, the clock and the file system. */
function actionCtx(ctx) {
  const d = ctx.deps;
  return { deps: d, a: d.actionDeps ?? {}, session: ctx.session, now: d.now, fs: d.fs, config: d.config ?? {}, log: d.log };
}

/** A funnel result's failure for its audit row: the refusal, a fixed word for Valkey, or null when it landed. */
function failureOf(result) {
  if (result === null || typeof result !== "object") return "the write was refused";
  if (typeof result.invalid === "string") return result.invalid;
  if (result.unreachable) return "Valkey could not be reached";
  return null;
}

/** The console's clock, or the wall clock for a caller that wired none. */
const clockOf = (deps) => (typeof deps.now === "function" ? deps.now() : Date.now());

/**
 * A refusal answer: the `error` sentence exactly as the planner, the ticket store or the funnel said it (the tool and
 * the console share it byte for byte), and the slot's bar (`refusalHtml`), which adds "Nothing was changed." in its
 * own markup when the sentence does not say so already, and never for a `partial` one (a write that may have done part
 * of its work). `state` names the bar's state when the status alone cannot; `sentenceHtml` is the bar's own markup of
 * the same words, for a sentence that names code (an action, a field).
 */
function refuse(ctx, where, status, error, state = null, sentenceHtml = null) {
  return ctx.json(status, { error, html: String(refusalHtml({ where, sentence: error, status, state, sentenceHtml })) });
}

/**
 * The refusal for a body key the action does not take (issue #737), or null: `{ text, html }`, the answer's `error` and
 * the bar's markup of the same words, the action and every field it names as code (a sentence opening with the action's
 * name would otherwise read "Setting-set takes ...", capitalised as a word). Named when it is a plain identifier,
 * otherwise "a field it was sent" (`fieldNamed`), and never its value; the list it does take is always said, so the
 * sentence names the fix.
 */
function unknownFieldRefusal(action, body) {
  const sent = Object.keys(body ?? {}).find((k) => body[k] !== undefined && !action.fields.includes(k));
  if (sent === undefined) return null;
  const named = fieldNamed(sent);
  const code = (s) => html`<span class="code">${s}</span>`;
  const namedHtml = named === UNNAMED_FIELD ? named : code(named);
  if (action.fields.length === 0) return { text: `${action.name} takes no fields; it refuses ${named}, so nothing was changed`, html: html`${code(action.name)} takes no fields; it refuses ${namedHtml}, so nothing was changed.` };
  return {
    text: `${action.name} takes ${action.fields.join(", ")} only; ${named} is not one of them, so nothing was changed`,
    html: html`${code(action.name)} takes ${action.fields.map((f, i) => html`${i > 0 ? ", " : null}${code(f)}`)} only; ${namedHtml} is not one of them, so nothing was changed.`,
  };
}

/**
 * An inverse write as the Undo form will send it, or a throw: one that names an action the table does not have, or
 * carries a key that action does not take, is a programming error, so an Undo button can never preview a refusal of
 * its own. Null (no inverse) passes.
 */
function checkInverse(action, inverse) {
  if (inverse === null) return;
  const target = actionNamed(inverse.action);
  if (!target) throw new Error(`the ${action.name} inverse names no action (${inverse.action})`);
  const extra = Object.keys(inverse.body ?? {}).find((k) => !target.fields.includes(k));
  if (extra !== undefined) throw new Error(`the ${action.name} inverse sends ${target.name} a field it does not take (${extra})`);
}

/** A rule's `undo` answer as the two places say it: one sentence twice, or `{ bar, after }`. */
const undoSaid = (undo) => (undo !== null && typeof undo === "object" ? { bar: String(undo.bar), after: String(undo.after) } : { bar: String(undo), after: String(undo) });

/**
 * What the banner after the write will say, decided now, where the file as it was is known: the title (the summary's
 * first line), the Undo sentence for the bar (`undo`) and for the banner (`undoAfter`, which never points at the
 * preview), the inverse write, whether the bar draws the Undo as an act (`undoable`: an inverse now, or one the confirm
 * decides, `atConfirm`), whether the act is destructive, and what the banner says happened (`done`; a bulk act's is
 * asked at the confirm instead, `WRITE_RULES`). A bad inverse throws (`checkInverse`): the preview then fails loudly
 * with the console's log line.
 */
function metaOf(action, out, body) {
  const summary = Array.isArray(out.summary) ? out.summary : [];
  const inverse = action.inverse(out, body) ?? null;
  checkInverse(action, inverse);
  const said = undoSaid(action.undo(out, body));
  return { title: String(summary[0] ?? action.name), undo: said.bar, undoAfter: said.after, inverse, undoable: inverse !== null || action.atConfirm === true, danger: Boolean(action.danger), done: action.bulk ? null : String(action.done(out, body)) };
}

/**
 * `POST /api/act/<name>/preview`: plan the change, issue the ticket, answer the escaped preview. Writes nothing, and is
 * not audited (only a confirm changes anything). In order: the action's dependencies, the body's shape, the body's
 * keys against the action's `fields`, then the action's own preview. Every answer carries `html`, the bar the slot shows.
 */
export async function previewAction(ctx, action) {
  const { deps, session } = ctx;
  const body = ctx.body ?? {};
  const actx = actionCtx(ctx);
  const missing = (action.needs ?? []).filter((k) => actx.a[k] === null || actx.a[k] === undefined);
  if (missing.length > 0) return refuse(ctx, "preview", 503, `this console was started without what the ${action.name} action needs (${missing.join(", ")}); see its log`, "setup");
  if (!plainBody(body)) return refuse(ctx, "preview", 400, `the request body is nested too deep or holds too much (at most ${BODY_DEPTH_MAX} levels, ${BODY_KEYS_MAX} keys per object and 256 items per list)`);
  const unknown = unknownFieldRefusal(action, body);
  if (unknown !== null) return refuse(ctx, "preview", 400, unknown.text, null, unknown.html);
  let out;
  let meta;
  try {
    out = await action.preview(body, actx);
    if (!out?.refusal && !out?.unchanged) meta = metaOf(action, out, body);
  } catch (e) {
    if (e instanceof BadRequest) return refuse(ctx, "preview", 400, `${e.message}; nothing was changed`);
    deps.log(`console: the ${action.name} preview failed (${codeOf(e)})`);
    return refuse(ctx, "preview", 500, "the preview failed; the console's log has the reason; nothing was changed");
  }
  // A refusal names its bar's state only where its status cannot (the snapshot's timeout, a 503 that is not Valkey's),
  // and only one of the slot's own states: a planner's answer may carry a field of that name for something else.
  if (out?.refusal) return refuse(ctx, "preview", out.status ?? 400, out.refusal, typeof out.state === "string" && Object.hasOwn(REFUSAL_STATES, out.state) ? out.state : null);
  if (out?.unchanged) {
    const summary = [String(out.unchanged)];
    return ctx.json(200, { unchanged: true, action: action.name, summary, ...(out.extra ?? {}), html: String(unchangedBarHtml({ summary, sentenceHtml: out.unchangedHtml ?? null })) });
  }
  const issued = deps.tickets.issue({
    sessionId: session.id,
    action: action.name,
    target: out.target ?? null,
    payload: out.payload ?? {},
    expect: out.expect ?? null,
    beforeDigest: out.beforeDigest ?? null,
    afterDigest: out.afterDigest ?? null,
    reserve: out.reserve ?? null,
    targets: out.targets ?? null,
    count: Number.isSafeInteger(out.count) ? out.count : null,
    meta,
  });
  const expiresAt = Number.isSafeInteger(issued?.expiresAt) ? issued.expiresAt : null;
  const summary = out.summary ?? [];
  const confirmLabel = String(action.confirmLabel(out));
  // The bar's lines: the action's own markup of them where it has one (`barLines`: a change's values in bold), else the
  // summary's. A blank line is a paragraph break in the TUI's dialog, which a list has no use for, so none is drawn.
  const lines = (Array.isArray(out.barLines) ? out.barLines : summary.slice(1)).filter((l) => !(typeof l === "string" && l.trim() === ""));
  return ctx.json(200, {
    ticket: issued.ticket,
    action: action.name,
    kind: action.kind,
    paid: Boolean(action.paid),
    summary,
    reserve: out.reserve ?? null,
    targets: out.targets ?? null,
    ...(Number.isSafeInteger(out.count) ? { count: out.count } : {}),
    beforeDigest: out.beforeDigest ?? null,
    afterDigest: out.afterDigest ?? null,
    ...(out.extra ?? {}),
    expiresAt,
    danger: meta.danger,
    confirmLabel,
    undo: meta.undo,
    html: String(previewBarHtml({ title: meta.title, lines, reserve: reserveText(out.reserve), diff: out.diff ?? null, undo: meta.undo, undoable: meta.undoable, confirmLabel, paid: Boolean(action.paid), danger: meta.danger, expiresAt, now: clockOf(deps) })),
  });
}

/**
 * An audit writer that remembers which rows it appended (issue #737): `append(row)` is the writer's own (its row
 * returned, its throw thrown), `first()` the `seq` of the first row an append returned, and `last()` the `seq` of the
 * latest. Wrapped around the writer OUTSIDE `auditedWrite` (which stays as it is), so the banner after a write can link
 * the exact rows this confirm wrote. `first()` is null when the first append returned no row (a writer that returns
 * nothing): the banner then says the log holds its row, with no link it cannot vouch for.
 */
export function capturingAudit(audit) {
  let first;
  let last = null;
  return {
    append(row) {
      const stored = audit.append(row);
      const seq = Number.isSafeInteger(stored?.seq) ? stored.seq : null;
      if (first === undefined) first = seq;
      if (seq !== null) last = seq;
      return stored;
    },
    first: () => first ?? null,
    last: () => last,
  };
}

/**
 * The change a write made, as the session's next page reports it (`setFlash`) and the confirm answers it: what happened
 * in the past tense (`summary`, the rule's `done`), who did it, the audit rows it wrote (`auditSeq` the first, `count`
 * how many), how many of them landed (`done`: a bulk act's banner is in the attention tone when fewer than `count` did),
 * and the banner's Undo (`undo`, the `undoAfter` sentence, and its `inverse`). Past the flash's bound (`FLASH_MAX_BYTES`,
 * a whole pause-windows list as an inverse can pass it) the inverse is dropped and the Undo says to put the list back by
 * hand: a banner without its Undo is honest, a flash the store refused says nothing.
 *
 * AN UNDO DECIDED AT THE CONFIRM (`atConfirm`, a re-run's cancel of the job it queued): its rule is asked again here,
 * with the apply's answer (`result`), in place of the ticket's. The write has landed and its row is in the log by now,
 * so a rule that throws, or an inverse `checkInverse` refuses, costs the banner its Undo button, never the answer: the
 * console logs it, and the banner says it could not name the run it queued (`rerunUnnamed`).
 */
function changeOf(ctx, entry, action, { auditSeq, auditLast = null, count, done = count, summary = null, result = undefined }) {
  const meta = entry.meta ?? {};
  let undo = String(meta.undoAfter ?? meta.undo ?? "");
  let inverse = meta.inverse ?? null;
  if (action.atConfirm === true && result !== undefined) {
    try {
      const decided = action.inverse(entry, null, result) ?? null;
      checkInverse(action, decided);
      undo = undoSaid(action.undo(entry, null, result)).after;
      inverse = decided;
    } catch (e) {
      ctx.deps.log(`console: the ${action.name} Undo could not be decided after the write (${codeOf(e)}); its banner offers none`);
      undo = UNDO_SENTENCES.rerunUnnamed;
      inverse = null;
    }
  }
  const change = { summary: summary ?? String(meta.done ?? meta.title ?? action.name), by: String(ctx.session?.name ?? ""), auditSeq, auditLast, count, done, undo, inverse, kind: action.kind, at: clockOf(ctx.deps) };
  if (Buffer.byteLength(JSON.stringify(change), "utf8") > FLASH_MAX_BYTES) {
    change.inverse = null;
    change.undo = UNDO_SENTENCES.tooBigAfter;
  }
  try {
    ctx.deps.sessions?.setFlash?.(ctx.session.id, change);
  } catch (e) {
    // The write landed and its row is in the log; a banner that does not show is the session store's own business.
    ctx.deps.log(`console: the ${action.name} banner could not be kept (${codeOf(e)})`);
  }
  return change;
}

/**
 * `POST /api/act/<name>/confirm`: redeem the ticket (single use, this session, this action), then audit, then write
 * (`auditedWrite` for one change; one row per job for a bulk action), then keep the session's flash and poke the live
 * hub. The answer is the funnel's, with the change (`change`, issue #737: not `done`, which a bulk confirm already
 * answers as a number) and, on a refusal, the slot's bar.
 */
export async function confirmAction(ctx, action) {
  const { deps, body, session } = ctx;
  const actx = actionCtx(ctx);
  const actor = ctx.actor();
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  const redeemed = ticket === "" ? { refusal: `no ticket was sent. ${PREVIEW_AGAIN}` } : deps.tickets.redeem({ sessionId: session.id, ticket, action: action.name });
  if (!redeemed.entry) {
    ctx.record({ actor, action: "write", kind: action.kind, target: ctx.route.path, outcome: "refused", reason: String(redeemed.refusal ?? "ticket refused") });
    // The refusal already says what to do (confirm.mjs ends each one with "Preview the change again and confirm the new
    // preview"), so it is sent as it is: one instruction, not two.
    return refuse(ctx, "confirm", 409, String(redeemed.refusal ?? `this confirmation is not valid. ${PREVIEW_AGAIN}`), "ticket");
  }
  const entry = redeemed.entry;
  const tag = sha256(ticket).slice(0, 12);
  const log = (line) => deps.log(String(line).replace(/^panel: /, "console: "));
  if (action.bulk) return confirmBulk(ctx, action, entry, { actor, tag, actx });
  const AUDIT = Symbol("audit");
  const audit = capturingAudit(deps.audit);
  let result;
  try {
    result = await auditedWrite(
      { audit, actor, kind: action.kind, target: entry.target, beforeDigest: entry.beforeDigest ?? null, afterDigest: entry.afterDigest ?? null, reserve: reserveMicros(entry.reserve), count: Number.isSafeInteger(entry.count) && entry.count >= 1 ? entry.count : null, ticket: tag, failure: failureOf, refusal: () => ({ [AUDIT]: true }), log },
      () => action.apply(entry, actx),
    );
  } catch (e) {
    deps.log(`console: the ${action.name} write threw (${codeOf(e)})`);
    return refuse(ctx, "confirm", 500, `the ${action.name} change could not be made; nothing was changed, and the console's log has the reason`, "failed");
  }
  if (result?.[AUDIT]) return refuse(ctx, "confirm", 500, AUDIT_FAILED, "audit");
  // A refusal the apply marks `partial` came after part of the write was made (the kill switch reached some queues), so
  // its bar says what may have changed and offers Look again; any other was refused before anything was written.
  if (typeof result?.invalid === "string") return refuse(ctx, "confirm", 409, result.invalid, result.partial === true ? "partial" : "changed");
  if (result?.unreachable || !result?.ok) return refuse(ctx, "confirm", 503, VALKEY_UNREACHABLE, "valkey");
  const change = changeOf(ctx, entry, action, { auditSeq: audit.first(), count: 1, result });
  tickHub(deps);
  return ctx.json(200, { ...result, ok: true, action: action.name, kind: action.kind, beforeDigest: entry.beforeDigest ?? null, afterDigest: entry.afterDigest ?? null, change });
}

/**
 * A bulk confirm: one `ok` row per job FIRST (`count` the list's size, every row the same ticket digest), and none of
 * the jobs is touched unless every row was written; then the apply, which re-checks and acts per job; then a `failed`
 * row for each job it refused. The response lists every job's result, `done` is how many landed (a number, as it has
 * always been), `html` is the results bar, and `change` the banner the next page shows: none when no job landed (the
 * bar's results already said so, and a banner over nothing done read as a success), else its rows and how many of
 * them landed.
 *
 * An apply that THROWS has been acting job by job, so jobs before the throw may have been acted on: its refusal is
 * `partial` (the bar says some of it may have been done and offers Look again), never "nothing was changed".
 */
async function confirmBulk(ctx, action, entry, { actor, tag, actx }) {
  const { deps } = ctx;
  const audit = capturingAudit(deps.audit);
  const targets = Array.isArray(entry.targets) ? entry.targets : [];
  const count = targets.length;
  const reserveBy = new Map(targets.map((t) => [t.jobId, reserveMicros(t.reserve)]));
  const rowOf = (jobId) => ({ actor, action: "write", kind: action.kind, target: jobId, count, reserve: reserveBy.get(jobId) ?? null, ticket: tag });
  const compensate = (jobId, reason) => {
    try {
      audit.append({ ...rowOf(jobId), outcome: "failed", reason: String(reason) });
    } catch (e) {
      deps.log(`console: audit append failed (${codeOf(e)}) after a ${action.kind} job did not land; the log's last row for ticket ${tag} says ok and is wrong`);
    }
  };
  const written = [];
  for (const t of targets) {
    try {
      audit.append({ ...rowOf(t.jobId), outcome: "ok" });
      written.push(t.jobId);
    } catch (e) {
      deps.log(`console: audit append failed (${codeOf(e)}), so the ${action.kind} action was refused`);
      for (const id of written) compensate(id, "the audit log could not take a row for every job, so none was acted on");
      return refuse(ctx, "confirm", 500, AUDIT_FAILED, "audit");
    }
  }
  // The rows this confirm wrote for its jobs, taken before any compensating row: the banner links exactly these.
  const auditSeq = audit.first();
  const auditLast = audit.last();
  let result;
  try {
    result = await action.apply(entry, actx);
  } catch (e) {
    for (const id of written) compensate(id, `the write threw (${codeOf(e)})`);
    deps.log(`console: the ${action.name} write threw (${codeOf(e)})`);
    return refuse(ctx, "confirm", 500, `the ${action.name} change failed before it finished; the console's log has the reason`, "partial");
  }
  // A list or a fleet the funnel refused whole: it answers so before it acts on any job (job-actions.mjs `failedBulk`).
  if (!result?.ok) {
    const why = failureOf(result) ?? "the write was refused";
    for (const id of written) compensate(id, why);
    return result?.unreachable ? refuse(ctx, "confirm", 503, VALKEY_UNREACHABLE, "valkey") : refuse(ctx, "confirm", 409, why, "changed");
  }
  const results = Array.isArray(result.results) ? result.results : [];
  for (const r of results) if (!r.ok) compensate(r.jobId ?? "-", r.reason ?? "refused");
  const done = results.filter((r) => r.ok).length;
  let change = null;
  if (done > 0) {
    change = changeOf(ctx, entry, action, { auditSeq, auditLast, count, done, summary: String(action.done(entry, null, { done, count })) });
    tickHub(deps);
  }
  return ctx.json(200, { ok: true, action: action.name, kind: action.kind, count, done, results, change, html: String(bulkResultsHtml({ kind: action.kind, results, count, done, auditSeq })) });
}

/** Ask the live hub for a tick now, so open tabs show the change; a hub that fails is the hub's own business. */
function tickHub(deps) {
  try {
    const t = deps.hub?.tick?.();
    if (t && typeof t.catch === "function") t.catch(() => {});
  } catch {
    // the next scheduled tick redraws anyway
  }
}
