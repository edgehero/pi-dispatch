/**
 * The console's action table and its ONE preview/confirm pipeline (issue #642, DES-OPERATOR-CONSOLE,
 * REQ-OPERATOR-CONSOLE-ACTIONS). Every write the console can make is an entry in `ACTIONS`, and `server.mjs` generates
 * `POST /api/act/<name>/preview` and `POST /api/act/<name>/confirm` from it (`auth: "operator"`, `write: true`), so a
 * write cannot exist without the dispatcher's guards and the route tests derive their lists from the same table.
 *
 * AN ENTRY: `{ name, kind, paid, bulk, needs, preview(body, ctx), apply(entry, ctx) }`.
 *   - `name` is the route segment and the ticket's action; `kind` is the audit row's `kind` (INT-CONSOLE-AUDIT-LOG),
 *     the panel's own word for the same write where one exists, so the TUI's rows and the console's read alike.
 *   - `preview` builds the change through the SAME planner the tool or the TUI uses (`write-plans.mjs`, or
 *     `job-actions.mjs` through the read model), so a refusal is the tool's sentence, and returns `{ refusal }`,
 *     `{ unchanged }`, or `{ summary, diff, expect, payload, target, targets, reserve, beforeDigest, afterDigest }`.
 *   - `apply` runs the read model's funnel with the ticket's stored `payload` and `expect`, and answers `{ ok, ... }`,
 *     `{ invalid }` (refused, nothing done: the file or the job changed since the preview, a dedup window, ...) or
 *     `{ unreachable }` (Valkey).
 *
 * THE PIPELINE (lifted from #640's pause-windows reference write, now shared by every entry):
 *   1. preview: plan, compute the digests and the diff, and store EVERYTHING the write needs in a single-use ticket
 *      bound to the session and the action (`confirm.mjs`). The browser gets the ticket and an escaped, server-rendered
 *      `diffHtml`, never the payload, so it cannot swap what is written between the two requests.
 *   2. confirm: redeem the ticket, then AUDIT, THEN WRITE (`auditedWrite`): the `ok` row first, with `kind`, the
 *      digests, `reserve` and the ticket's digest; a write whose row cannot be appended does not happen (500); a write
 *      that is refused or throws gets a compensating `failed` row with the same ticket. A bulk action writes one row
 *      per job (`count` = the list's size, all sharing the ticket digest), and a job refused at the apply gets its own
 *      `failed` row.
 *   3. after a write that landed: `hub.tick()`, so every open live tab redraws now rather than at the next tick.
 *
 * FILE WRITES ARE DRY-RUN AT THE PREVIEW. The planners judge a change; the funnel's own parser decides. So the preview
 * runs the funnel itself against `dryRunFs`, a file system that reads through to the real one and keeps every write in
 * memory, and takes the file it would have renamed into place: the after digest is the digest of the exact bytes the
 * confirm writes, and a change the funnel would refuse is refused at the preview with the funnel's words, before the
 * operator is asked. Nothing the dry run does reaches the disk (`dryRunFs` has no write path to the real one).
 *
 * WHAT A DIFF SHOWS. The file before and after, in a line diff, with every `secrets` map's values replaced by a marker
 * (a trigger's secret references are not a page's business, the configuration panel's rule) and every line escaped by
 * the `html` template. The answer to a parked run, and a message into a running job (issue #646), is shown to the
 * operator who typed it, and only there: its audit row carries the sha256 of the text (`afterDigest`), never the text.
 *
 * Valkey-backed reads and writes go through `ctx.a` (`actionDeps`, wired by `cli.mjs`): the read model (`rm`), the
 * planners (`plans`), the deployment's `paths` and `env`, the fleet reader (`fleet`, built with `killSwitchPlanFn`) and
 * the kill switch's decision itself. This module imports none of them, so the server's tests run on small fakes.
 */
import { createHash } from "node:crypto";
import { formatMicros } from "@edgehero/pi-dispatch/money";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
import { auditedWrite } from "../audited-write.mjs";
import { PREVIEW_AGAIN } from "./confirm.mjs";
import { html } from "./html.mjs";

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

/** A file's text now: `{ text }` (null when absent) or `{ refusal }`. */
function readNow(fs, path) {
  try {
    return { text: fs.readFileSync(path, "utf8") };
  } catch (e) {
    if (e?.code === "ENOENT") return { text: null };
    return { refusal: `${path} cannot be read (${codeOf(e)}); nothing was changed`, status: 409 };
  }
}

// ---- the diff ----------------------------------------------------------------------------------------------------------

/** A JSON value with every `secrets` map's values replaced by a marker: the diff shows that one changed, not what. */
function redacted(value, keyName = null) {
  if (Array.isArray(value)) return value.map((v) => redacted(v));
  if (value === null || typeof value !== "object") return value;
  if (keyName === "secrets") return Object.fromEntries(Object.keys(value).map((k) => [k, "(a secret reference, not shown)"]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v, k)]));
}

/** A file's text as the diff shows it: parsed, redacted and re-indented when it is JSON, else its lines as they are. */
function displayLines(text) {
  if (text === null || text === undefined) return [];
  try {
    return JSON.stringify(redacted(JSON.parse(text)), null, 2).split("\n");
  } catch {
    return String(text).replace(/\n$/, "").split("\n");
  }
}

/**
 * The largest diff table the preview computes (changed lines before times changed lines after, once the common prefix
 * and suffix are cut); past it, the changed middle is shown as removed then added.
 */
const DIFF_CELLS_MAX = 4_000_000;
/** Unchanged lines kept around each change. */
const DIFF_CONTEXT = 2;
/** The most diff lines a preview renders; past it, the count of the lines left out. */
export const DIFF_LINES_MAX = 2000;

/**
 * A line diff of `a` to `b`: `[{ t: " " | "-" | "+" | "gap", line }]`, unchanged runs cut to `DIFF_CONTEXT` lines.
 *
 * The common prefix and suffix are cut FIRST (linear, and the usual edit touches one entry of a long file), so only the
 * changed middle meets the quadratic table: a one-entry change to a 150-trigger file is a small table and a small
 * preview, where diffing the whole file passed `DIFF_CELLS_MAX` and showed both files whole (159 KB).
 */
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const same = (line) => ({ t: " ", line });
  const ops = [...a.slice(0, pre).map(same), ...middleDiff(midA, midB), ...a.slice(a.length - suf).map(same)];
  const changed = ops.map((op) => op.t !== " ");
  const out = [];
  let last = -Infinity;
  // The index of the next change at or after k, so "near a change" is one look each way rather than a slice per line.
  const nextChange = new Array(ops.length + 1).fill(Infinity);
  for (let k = ops.length - 1; k >= 0; k -= 1) nextChange[k] = changed[k] ? k : nextChange[k + 1];
  for (let k = 0; k < ops.length; k += 1) {
    if (changed[k]) last = k;
    if (changed[k] || k - last <= DIFF_CONTEXT || nextChange[k] - k <= DIFF_CONTEXT) out.push(ops[k]);
    else if (out.at(-1)?.t !== "gap") out.push({ t: "gap", line: "" });
  }
  return out;
}

/** The diff of the changed middle: a longest common subsequence, or removed then added past `DIFF_CELLS_MAX`. */
function middleDiff(a, b) {
  if (a.length * b.length > DIFF_CELLS_MAX) return [...a.map((line) => ({ t: "-", line })), ...b.map((line) => ({ t: "+", line }))];
  // Longest common subsequence, from the end, so the walk below reads forward.
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) {
      // A removal before an addition, so a changed line reads as the old one then the new one.
      ops.push({ t: "-", line: a[i] });
      i += 1;
    } else {
      ops.push({ t: "+", line: b[j] });
      j += 1;
    }
  }
  return ops;
}

/** The diff of two file texts as escaped HTML: a `<pre>` with one element per line, at most `DIFF_LINES_MAX` of them. */
export function diffHtmlOf(beforeText, afterText) {
  const ops = lineDiff(displayLines(beforeText), displayLines(afterText));
  const shown = ops.slice(0, DIFF_LINES_MAX);
  const more = ops.length - shown.length;
  return html`<pre class="diff">${shown.map((o) => {
    if (o.t === "+") return html`<ins>+ ${o.line}</ins>\n`;
    if (o.t === "-") return html`<del>- ${o.line}</del>\n`;
    if (o.t === "gap") return html`<span class="gap">...</span>\n`;
    return html`<span>  ${o.line}</span>\n`;
  })}${more > 0 ? html`<span class="gap">... and ${more} more diff line(s), not shown</span>\n` : null}</pre>`;
}

/** A text shown as it is, one element per line (the answer to a parked run, exactly as it will be posted). */
function textHtml(text) {
  return html`<pre class="answer">${String(text).split("\n").map((line) => html`<span>${line}</span>\n`)}</pre>`;
}

// ---- the reserve -------------------------------------------------------------------------------------------------------

/** What a paid action will hold, in words (CONST-BUDGET-BEFORE-TOKENS: the worker reserves at pickup; this says what). */
export function reserveText(r) {
  if (!r) return null;
  if (r.bulk) {
    const dollars = r.dollarsMicros > 0 ? ` and $${formatMicros(r.dollarsMicros)}${r.unknown > 0 ? " for the jobs whose reserve is known" : ""} in each dollar window that applies` : "";
    return `Together they hold ${r.slots} job slot(s)${dollars}${r.unknown > 0 ? `; the reserve of ${r.unknown} job(s) is unknown (their data could not be read), so the total is at least this` : ""}.`;
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

/** The preview's HTML: the summary lines, the reserve, then the diff. Every value escaped. */
function previewHtml(out) {
  const lines = Array.isArray(out.summary) ? out.summary : [];
  const reserve = reserveText(out.reserve);
  return html`<div class="preview"><ul class="summary">${lines.map((l) => html`<li>${l}</li>`)}</ul>${reserve ? html`<p class="reserve"><strong>Reserve:</strong> ${reserve}</p>` : null}${out.diff ?? null}</div>`;
}

// ---- shared steps ------------------------------------------------------------------------------------------------------

/**
 * A file change, previewed by dry-running its funnel: `run(fs, expect)` is the write (the funnel, its arguments bound),
 * called once here against `dryRunFs` and once at the confirm against the real fs. Returns the preview's shape with the
 * exact before and after digests of `target`, or `{ refusal }` with the funnel's words, or `{ unchanged }`.
 */
async function fileChange(ctx, { target, expect, summary, run, payload = {} }) {
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
  if (beforeDigest === afterDigest) return { unchanged: "no change: the file already says this" };
  return { target, expect, summary, diff: diffHtmlOf(now.text, after), payload: { ...payload, run }, beforeDigest, afterDigest };
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

/** The fleet snapshot, or the refusal when it cannot be read. */
async function snapshotOf(ctx) {
  try {
    const s = await ctx.a.fleet.snapshot();
    if (s) return { snapshot: s };
  } catch {
    // answered below
  }
  return { refusal: "the fleet could not be read (is Valkey reachable?); nothing was changed", status: 503 };
}

/** A funnel's answer in the pipeline's three shapes. */
function funnelResult(res, okFields = {}) {
  if (res?.ok) return { ok: true, ...okFields };
  if (typeof res?.invalid === "string") return { invalid: res.invalid };
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

/**
 * A file action: `build(body, ctx)` returns a planner's result (`{ plan }` with `mutate`/`expect`/`title`/`summary`, or
 * `{ refusal }`), `target(ctx)` the file, and `write(plan, ctx, { fs, expect })` the funnel call.
 */
function fileAction({ name, kind, build, target, write }) {
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
      return fileChange(ctx, { target: file, expect, summary: [p.title, ...(Array.isArray(p.summary) ? p.summary : [])], run: (fs, exp) => write(p, ctx, { fs, expect: exp }) });
    },
    apply: applyFile,
  };
}

/** The deployment's paths, with the pause-windows file the console's config names when the paths leave it out. */
const pausePath = (ctx) => ctx.a.paths?.pauseWindowsPath ?? ctx.config.pauseWindowsPath;
const shownDir = (ctx) => ({ deploymentDir: ctx.config?.dir ?? null });

/** The settings overlay's secret profiles now (names to resolver paths; never a reference or a value). */
function profilesOf(ctx) {
  const view = ctx.a.rm.readSettingsView({ settingsFile: ctx.a.paths.settingsFile, fs: ctx.fs });
  return { ...(view?.overlay?.secretProfiles ?? {}) };
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
      if (w === null || typeof w !== "object" || Array.isArray(w)) return { refusal: `pause window at index ${i} is not an object; nothing was changed` };
      for (const [k, value] of Object.entries(w)) {
        if (!PAUSE_WINDOW_KEYS.includes(k)) return { refusal: `pause window at index ${i} has a field this file does not take (${PAUSE_WINDOW_KEYS.join(", ")} only); nothing was changed` };
        const plain = typeof value === "string" || (k === "days" && Array.isArray(value) && value.every((d) => typeof d === "string"));
        if (!plain) return { refusal: `pause window at index ${i}: ${k} must be ${k === "days" ? "a list of weekday names" : "a string"}; nothing was changed` };
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
    if (beforeDigest === afterDigest) return { unchanged: "no change: the file already says this", extra: { before, after: body.windows } };
    return {
      target: path,
      payload: { windows: body.windows },
      expect: [{ path, text: snap.text }],
      summary: ["Replace the pause windows", `${before.length} window(s) now, ${body.windows.length} after`],
      diff: diffHtmlOf(snap.text, afterText),
      beforeDigest,
      afterDigest,
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
    build: (body, ctx) => ctx.a.plans.planTriggerAdd({ params: { ...obj(body, "trigger") }, paths: ctx.a.paths, env: ctx.a.env, surface: "console", fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.triggersPath,
    write: writeTriggersOf,
  }),
  fileAction({
    name: "trigger-edit",
    kind: "trigger-edit",
    build: (body, ctx) => ctx.a.plans.planTriggerEdit({ params: { index: index(body), flow: str(body, "flow", { required: true }), backend: str(body, "backend"), provider: str(body, "provider"), model: str(body, "model") }, paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.triggersPath,
    write: writeTriggersOf,
  }),
  fileAction({
    name: "trigger-delete",
    kind: "trigger-delete",
    build: (body, ctx) => ctx.a.plans.planTriggerDelete({ index: index(body), paths: ctx.a.paths, fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.triggersPath,
    write: writeTriggersOf,
  }),
  fileAction({
    name: "setting-set",
    kind: "setting-set",
    build: (body, ctx) => ctx.a.plans.planSettingSet({ key: str(body, "key", { required: true, max: 64 }), value: str(body, "value", { required: true }), paths: ctx.a.paths, env: ctx.a.env, shown: shownDir(ctx), fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
  }),
  fileAction({
    name: "setting-unset",
    kind: "setting-unset",
    build: (body, ctx) => ctx.a.plans.planSettingUnset({ key: str(body, "key", { required: true, max: 64 }), paths: ctx.a.paths, env: ctx.a.env, shown: shownDir(ctx), fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.settingsFile,
    write: writeSettingsOf,
  }),
  fileAction({
    name: "secret-profile-add",
    kind: "secret-profile-add",
    build: (body, ctx) => ctx.a.plans.planSecretProfileAdd({ name: str(body, "name", { required: true, max: 64 }), path: str(body, "path", { required: true, max: 4096 }), profiles: profilesOf(ctx), settingsFile: ctx.a.paths.settingsFile }),
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
    build: (body, ctx) => ctx.a.plans.planPauseWindowEdit({ index: index(body), fields: pauseFields(body), paths: { ...ctx.a.paths, pauseWindowsPath: pausePath(ctx) }, fs: ctx.fs }),
    target: pausePath,
    write: writePause,
  }),
  fileAction({
    name: "pause-window-delete",
    kind: "pause-window-delete",
    build: (body, ctx) => ctx.a.plans.planPauseWindowDelete({ index: index(body), paths: { ...ctx.a.paths, pauseWindowsPath: pausePath(ctx) }, fs: ctx.fs }),
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
    build: (body, ctx) => ctx.a.plans.planLimitEdit({ params: { ...obj(body, "limit"), index: index(body) }, paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }),
    target: (ctx) => ctx.a.paths.scopedLimitsPath,
    write: writeLimitsOf,
  }),
  fileAction({
    name: "limit-delete",
    kind: "limit-delete",
    build: (body, ctx) => ctx.a.plans.planLimitDelete({ index: index(body), paths: ctx.a.paths, env: ctx.a.env, fs: ctx.fs }),
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
      if (!row) return { refusal: `no allocation history row at index ${at} (have ${log.length})` };
      if (row.weights === null || typeof row.weights !== "object") return { refusal: `history row #${at} carries no split to go back to` };
      return {
        target: "allocation",
        expect: { envelopeDigest: env.read.digest },
        payload: { row },
        summary: [`Revert the allocation to history row #${at} (writer operator-revert)`, `${String(row.at ?? "-")}: ${String(row.outcome ?? "-")}${row.planId ? `, plan ${String(row.planId)}` : ", the neutral split"}`, ...Object.entries(row.weights).map(([k, w]) => `${k}: weight ${String(w)}`)],
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
const failedLine = (j) => `${j.jobId} on ${j.queue}, ${j.attemptsMade} attempt(s)${j.target ? `, ${j.target}` : ""}`;

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
      return {
        target: queue ?? repo ?? "failed",
        targets: jobs.map((j) => ({ jobId: j.jobId, queue: j.queue, attemptsMade: j.attemptsMade, finishedOn: j.finishedOn, ...(j.target ? { target: j.target } : {}), ...(reserves ? { reserve: reserveOf(j) } : {}) })),
        payload: {},
        reserve: reserves ? bulkReserve(jobs.map(reserveOf)) : null,
        summary: [
          `${verb} ${jobs.length} failed job(s)${queue ? ` in ${queue}` : ""}${repo ? ` for ${repo}` : ""}; each is re-checked and acted on alone`,
          ...jobs.map((j) => `${failedLine(j)}${reserves ? reserveTail(reserveOf(j)) : ""}`),
          ...(more > 0 ? [`${more}${read.examinedAll === false ? " or more" : ""} more match and are NOT in this action (at most ${BULK_MAX} per action)`] : []),
        ],
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

/** One job's bulk result as the response and the audit carry it: the id, ok, and the refusal's sentence. */
function resultRow(r) {
  if (r?.ok) return { jobId: String(r.jobId), ok: true, ...(r.queue ? { queue: String(r.queue) } : {}) };
  return { jobId: r?.jobId === null || r?.jobId === undefined ? null : String(r.jobId), ok: false, reason: r?.unreachable !== undefined ? "Valkey could not be reached for this job" : String(r?.invalid ?? "refused") };
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
      return {
        target: "held",
        targets: rows.map((r) => ({ jobId: r.jobId, ...(r.target ? { target: String(r.target) } : {}), ...(r.label ? { label: String(r.label) } : {}) })),
        payload: {},
        summary: [`Cancel ${rows.length} held job(s); each is re-checked (still held) and removed alone`, ...rows.map((r) => `${r.jobId}${r.target ? ` (${r.target})` : ""}, waiting for ${r.label ?? "its wait"}`), ...(more > 0 ? [`${more} more held are NOT in this action`] : [])],
      };
    },
    async apply(entry, ctx) {
      const results = [];
      for (const t of entry.targets) {
        const res = await ctx.a.rm.cancelHeldJob({ url: ctx.a.paths.valkeyUrl, jobId: t.jobId });
        results.push(resultRow(res?.ok ? { ...res, jobId: t.jobId } : { jobId: t.jobId, invalid: res?.invalid ?? "refused" }));
      }
      return { ok: true, results };
    },
  },
  failedOne({ name: "retry-failed", kind: "failed-retry", verb: "Retry", fn: "retryFailedJob" }),
  failedOne({ name: "remove-failed", kind: "failed-remove", verb: "Remove", fn: "removeFailedJob" }),
  failedAll({ name: "retry-all-failed", kind: "failed-retry-all", verb: "Retry", fn: "retryFailedJobs" }),
  failedAll({ name: "remove-all-failed", kind: "failed-remove-all", verb: "Remove", fn: "removeFailedJobs" }),
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
      const jobId = jobIdOf(body);
      const text = typeof body.text === "string" ? body.text : "";
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
        summary: [`Answer parked run ${jobId} on ${p.forge}, as ${ctx.session.name}`, `It resumes the parked transcript on queue ${p.queue}; once the job passes every check and reserve, the worker posts one comment on the issue saying the operator console answered, quoting the answer.`, ...runFieldsLines(p.runFields, "It runs as the comment trigger says now")],
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
          `Send a ${mode === "followUp" ? "follow-up" : "steer"} to running job ${p.jobId}, as ${ctx.session.name} (message ${p.id}, ${p.bytes} bytes)`,
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
 * a resume with nothing waiting writes none). `{ count, line }`, count null when unreadable.
 */
function resumeWaiting(rows, what) {
  const n = waitingIn(rows);
  const names = rows.map((r) => String(r?.queue ?? "-")).join(", ");
  return { count: n, line: `${n} job(s) wait to start in ${what}${names ? ` (${names})` : ""}: each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up, so no single reserve figure applies` };
}

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
      if (!paused) {
        const s = await snapshotOf(ctx);
        if (s.snapshot) {
          const rows = (Array.isArray(s.snapshot.queueCounts) ? s.snapshot.queueCounts : []).filter((q) => q?.paused);
          waiting = resumeWaiting(rows, "the paused queues");
        } else {
          waiting = { count: null, line: "How many jobs wait to start could not be read (the fleet did not answer); each reserves up to its own per-job dollar cap when a worker picks it up" };
        }
      }
      return {
        target: "fleet",
        payload: {},
        ...(waiting ? { count: waiting.count } : {}),
        summary: [paused ? "Pause every queue of the fleet (the kill switch): nothing new starts, running jobs finish" : "Resume every queue of the fleet: queued jobs start spending again", `Valkey: ${shown.join(", ") || "the deployment's"}`, ...(plan?.disagreement ? [`${plan.disagreement}: a pause reaches both`] : []), ...(waiting ? [waiting.line] : [])],
      };
    },
    async apply(_entry, ctx) {
      const res = paused ? await ctx.a.fleet.pause() : await ctx.a.fleet.resume();
      if (res?.refused) return { invalid: String(res.refused) };
      const results = (res?.results ?? []).map((r) => ({ valkey: String(r.shown ?? "-"), ok: r.res?.ok === true, ...(Array.isArray(r.res?.queues) ? { queues: r.res.queues.map(String) } : {}), ...(r.res?.partial ? { partial: { done: (r.res.partial.done ?? []).map(String), failed: String(r.res.partial.failed ?? "-") } } : {}) }));
      if (results.length > 0 && results.every((r) => r.ok)) return { ok: true, results };
      return { invalid: `the kill switch did not reach every queue: ${results.map((r) => `${r.valkey} ${r.ok ? "done" : r.partial ? `stopped after ${r.partial.done.join(", ") || "none"}, failed at ${r.partial.failed}` : "unreachable"}`).join("; ") || "no Valkey answered"}. Look at the fleet and try again` };
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
      const s = await snapshotOf(ctx);
      if (!s.snapshot) return s;
      const rows = Array.isArray(s.snapshot.queueCounts) ? s.snapshot.queueCounts : [];
      const row = rows.find((q) => q?.queue === queue);
      if (!row) return { refusal: `${JSON.stringify(queue)} is not a queue this deployment drains (${rows.map((q) => q?.queue).join(", ")}); nothing was changed` };
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

/** Every action the console can take, by name. The routes, the pages' forms and the tests all read this table. */
export const ACTIONS = Object.freeze([...jobActions, ...fleetActions, ...configActions].map((a) => Object.freeze(a)));

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

/**
 * `POST /api/act/<name>/preview`: plan the change, issue the ticket, answer the escaped preview. Writes nothing, and is
 * not audited (only a confirm changes anything).
 */
export async function previewAction(ctx, action) {
  const { deps, body, session } = ctx;
  const actx = actionCtx(ctx);
  const missing = (action.needs ?? []).filter((k) => actx.a[k] === null || actx.a[k] === undefined);
  if (missing.length > 0) return ctx.json(503, { error: `this console was started without what the ${action.name} action needs (${missing.join(", ")}); see its log` });
  if (!plainBody(body)) return ctx.json(400, { error: `the request body is nested too deep or holds too much (at most ${BODY_DEPTH_MAX} levels, ${BODY_KEYS_MAX} keys per object and 256 items per list)` });
  let out;
  try {
    out = await action.preview(body, actx);
  } catch (e) {
    if (e instanceof BadRequest) return ctx.json(400, { error: `${e.message}; nothing was changed` });
    deps.log(`console: the ${action.name} preview failed (${codeOf(e)})`);
    return ctx.json(500, { error: "the preview failed; the console's log has the reason" });
  }
  if (out?.refusal) return ctx.json(out.status ?? 400, { error: out.refusal });
  if (out?.unchanged) return ctx.json(200, { unchanged: true, action: action.name, summary: [String(out.unchanged)], ...(out.extra ?? {}) });
  const { ticket } = deps.tickets.issue({
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
  });
  return ctx.json(200, {
    ticket,
    action: action.name,
    kind: action.kind,
    paid: Boolean(action.paid),
    summary: out.summary ?? [],
    diffHtml: String(previewHtml(out)),
    reserve: out.reserve ?? null,
    targets: out.targets ?? null,
    ...(Number.isSafeInteger(out.count) ? { count: out.count } : {}),
    beforeDigest: out.beforeDigest ?? null,
    afterDigest: out.afterDigest ?? null,
    ...(out.extra ?? {}),
  });
}

/**
 * `POST /api/act/<name>/confirm`: redeem the ticket (single use, this session, this action), then audit, then write
 * (`auditedWrite` for one change; one row per job for a bulk action), then poke the live hub.
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
    return ctx.json(409, { error: String(redeemed.refusal ?? `this confirmation is not valid. ${PREVIEW_AGAIN}`) });
  }
  const entry = redeemed.entry;
  const tag = sha256(ticket).slice(0, 12);
  const log = (line) => deps.log(String(line).replace(/^panel: /, "console: "));
  if (action.bulk) return confirmBulk(ctx, action, entry, { actor, tag, actx });
  const AUDIT = Symbol("audit");
  let result;
  try {
    result = await auditedWrite(
      { audit: deps.audit, actor, kind: action.kind, target: entry.target, beforeDigest: entry.beforeDigest ?? null, afterDigest: entry.afterDigest ?? null, reserve: reserveMicros(entry.reserve), count: Number.isSafeInteger(entry.count) && entry.count >= 1 ? entry.count : null, ticket: tag, failure: failureOf, refusal: () => ({ [AUDIT]: true }), log },
      () => action.apply(entry, actx),
    );
  } catch (e) {
    deps.log(`console: the ${action.name} write threw (${codeOf(e)})`);
    return ctx.json(500, { error: `the ${action.name} change could not be made; nothing was changed, and the console's log has the reason` });
  }
  if (result?.[AUDIT]) return ctx.json(500, { error: AUDIT_FAILED });
  if (typeof result?.invalid === "string") return ctx.json(409, { error: result.invalid });
  if (result?.unreachable || !result?.ok) return ctx.json(503, { error: VALKEY_UNREACHABLE });
  tickHub(deps);
  return ctx.json(200, { ...result, ok: true, action: action.name, kind: action.kind, beforeDigest: entry.beforeDigest ?? null, afterDigest: entry.afterDigest ?? null });
}

/**
 * A bulk confirm: one `ok` row per job FIRST (`count` the list's size, every row the same ticket digest), and none of
 * the jobs is touched unless every row was written; then the apply, which re-checks and acts per job; then a `failed`
 * row for each job it refused. The response lists every job's result.
 */
async function confirmBulk(ctx, action, entry, { actor, tag, actx }) {
  const { deps } = ctx;
  const targets = Array.isArray(entry.targets) ? entry.targets : [];
  const count = targets.length;
  const reserveBy = new Map(targets.map((t) => [t.jobId, reserveMicros(t.reserve)]));
  const rowOf = (jobId) => ({ actor, action: "write", kind: action.kind, target: jobId, count, reserve: reserveBy.get(jobId) ?? null, ticket: tag });
  const compensate = (jobId, reason) => {
    try {
      deps.audit.append({ ...rowOf(jobId), outcome: "failed", reason: String(reason) });
    } catch (e) {
      deps.log(`console: audit append failed (${codeOf(e)}) after a ${action.kind} job did not land; the log's last row for ticket ${tag} says ok and is wrong`);
    }
  };
  const written = [];
  for (const t of targets) {
    try {
      deps.audit.append({ ...rowOf(t.jobId), outcome: "ok" });
      written.push(t.jobId);
    } catch (e) {
      deps.log(`console: audit append failed (${codeOf(e)}), so the ${action.kind} action was refused`);
      for (const id of written) compensate(id, "the audit log could not take a row for every job, so none was acted on");
      return ctx.json(500, { error: AUDIT_FAILED });
    }
  }
  let result;
  try {
    result = await action.apply(entry, actx);
  } catch (e) {
    for (const id of written) compensate(id, `the write threw (${codeOf(e)})`);
    deps.log(`console: the ${action.name} write threw (${codeOf(e)})`);
    return ctx.json(500, { error: `the ${action.name} change could not be made; the console's log has the reason` });
  }
  if (!result?.ok) {
    const why = failureOf(result) ?? "the write was refused";
    for (const id of written) compensate(id, why);
    return ctx.json(result?.unreachable ? 503 : 409, { error: result?.unreachable ? VALKEY_UNREACHABLE : why });
  }
  const results = Array.isArray(result.results) ? result.results : [];
  for (const r of results) if (!r.ok) compensate(r.jobId ?? "-", r.reason ?? "refused");
  tickHub(deps);
  return ctx.json(200, { ok: true, action: action.name, kind: action.kind, count, done: results.filter((r) => r.ok).length, results });
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
