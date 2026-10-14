/**
 * The console's HTTP server: the route table and the one dispatcher every request goes through (issue #640,
 * DES-OPERATOR-CONSOLE, REQ-CONSOLE-SECURITY).
 *
 * THE GUARDS COME FROM THE TABLE. Each route declares `auth` ("none" | "viewer" | "operator") and `write`; the
 * dispatcher applies, in this order and for every route alike:
 *
 *   1. the security headers (`headers.mjs`), first, so a 404, 405, 413, 421 or 500 carries them too;
 *   2. the Host check (421), before the route lookup, so a rebound name learns nothing about which paths exist;
 *   3. the route lookup (404, or 405 with `Allow`; OPTIONS is a 405 like any unrouted method and gets no CORS);
 *   4. for a write: Origin and Sec-Fetch-Site, JSON content type, the read-only switch (403 each, audited);
 *   5. auth (401 JSON for /api/* and writes, 303 to /login for a page), then the role (403, audited for a write);
 *   6. for a write: the body, 64 KiB at most (413), parsed as a JSON object (400);
 *   7. the handler.
 *
 * A new route cannot skip a guard because no route applies its own; the header test iterates THIS table rather than
 * a hand list. The role is judged after auth because a role belongs to a session, and an unauthenticated write is
 * answered 401 (and audited) before anyone asks which role it lacks.
 *
 * EVERY COLLABORATOR IS INJECTED: the token reader, the session store and its cookie helpers, the confirm tickets, the
 * login-code consumer, the audit log and the pause-windows writer. This module imports none of them, so its tests run
 * on small fakes and `cli.mjs` is the one place the real ones are wired.
 *
 * NOTHING SECRET IS LOGGED OR ECHOED. The request log is `METHOD /path status`: the path only (the one-time code rides
 * in the fragment, which never reaches a request line), never a query, a header value, a cookie or a body. Audit rows
 * carry names, roles, a session digest and file digests, never a token, a code or a payload.
 */
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { createServer } from "node:http";
import { readRawBody } from "@edgehero/pi-dispatch/http-body";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
import { contentTypeRefusal, hostRefusal, makeLoginLimiter, originRefusal, readOnlyRefusal, roleRefusal } from "./guards.mjs";
import { applySecurityHeaders } from "./headers.mjs";
import { loginCodePage, loginPage } from "./html.mjs";
import { STATE_VERSION, stateOf as defaultStateOf } from "./live.mjs";
import * as realPages from "./pages.mjs";
import { CONSOLE_SCRIPT } from "./script.mjs";
import { CONSOLE_CSS } from "./style.mjs";

/** The largest request body a write may send. A pause-windows file is a few hundred bytes; 64 KiB is generous. */
export const BODY_LIMIT = 64 * 1024;

/** node:http limits: slow-header and slow-body clients are cut off, and connections are capped. */
export const SERVER_LIMITS = Object.freeze({ headersTimeout: 10_000, requestTimeout: 30_000, maxConnections: 64, connectionsCheckingInterval: 1_000 });

/**
 * The live event streams the whole console holds at once (issue #641), whatever the per-session cap: half of
 * `maxConnections`, so open tabs can never take every connection and lock everyone out of signing in.
 */
export const STREAMS_TOTAL_MAX = 32;

/**
 * Of `STREAMS_TOTAL_MAX`, the slots only an operator's stream may take: viewer streams stop at the rest (24), so viewer
 * tokens, however many sign-ins they make, can never leave an operator without a live page.
 */
export const STREAMS_OPERATOR_RESERVE = 8;

/** How long a refused stream is asked to wait before the browser's EventSource tries again. */
const STREAM_RETRY_AFTER_SEC = 5;

// A Last-Event-ID the hub could have written (`<epoch>-<n>`); anything else is no id at all.
const EVENT_ID_RE = /^[0-9a-f]{1,16}-[0-9]{1,15}$/;

/** Unauthenticated refusals written one row each, per minute (burst twice that); the rest are counted. */
export const REFUSAL_ROWS_PER_MINUTE = 60;

/** The fields a pause window may carry (`INT-PAUSE-WINDOWS-FILE-CONTRACT`); a preview refuses any other. */
const PAUSE_WINDOW_KEYS = Object.freeze(["scope", "from", "to", "tz", "days", "dateFrom", "dateTo"]);

/** The confirm-ticket action name of the one reference write in #640. */
export const PAUSE_WINDOWS_ACTION = "pause-windows";

const ANONYMOUS = Object.freeze({ name: "anonymous", role: "none", session: null });
// One-time codes are base64url(32 bytes), 43 characters; anything far off that is refused before it is hashed.
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const digestOf = (text) => (text === null ? null : sha256(text));

// ---- responses ----

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, sentence, headers = {}) {
  sendJson(res, status, { error: sentence }, headers);
}

function sendHtml(res, status, fragment) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(String(fragment));
}

function redirect(res, location, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(303, { ...headers, location, "content-length": "0" });
  res.end();
}

// ---- handlers ----

/** Who an audit row names: the session's person, or `anonymous` before sign-in. */
function actorOf(ctx) {
  const s = ctx.session;
  return s ? { name: s.name, role: s.role, session: ctx.deps.cookies.sessionDigest(s.id) } : ANONYMOUS;
}

/**
 * Create a session for `entry` (a tokens-file entry), with a NEW id whatever cookie came in (no fixation: a cookie
 * planted before sign-in is destroyed, never promoted), and audit it. An audit failure refuses the sign-in.
 */
function startSession(ctx, entry, file, action) {
  const { deps, res } = ctx;
  const presented = deps.cookies.readSessionCookie(ctx.req.headers.cookie);
  if (presented) deps.sessions.destroy(presented);
  const { id } = deps.sessions.create({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation });
  try {
    deps.audit.append({ actor: { name: entry.name, role: entry.role, session: deps.cookies.sessionDigest(id) }, action, outcome: "ok" });
  } catch (e) {
    deps.sessions.destroy(id);
    deps.log(`console: audit append failed (${e?.code ?? "error"}), so the sign-in was refused`);
    return sendError(res, 500, "the audit log could not be written, so the sign-in was refused; check the console's log directory");
  }
  const cookie = deps.cookies.sessionCookie(id, { maxAgeSec: Math.floor(deps.config.maxMs / 1000) });
  return sendJson(res, 200, { ok: true, name: entry.name, role: entry.role }, { "set-cookie": cookie });
}

/** The tokens file, or null after answering 503 (a file that went bad while the console ran: nobody signs in). */
function tokensOr503(ctx) {
  const read = ctx.deps.readTokens();
  if (read.file) return read.file;
  ctx.deps.log("console: the tokens file cannot be used; run pi-dispatch doctor");
  sendError(ctx.res, 503, "the console's tokens file cannot be used right now; the operator should run pi-dispatch doctor");
  return null;
}

function rateLimited(ctx, target) {
  if (ctx.deps.limiter.take()) return false;
  ctx.record({ actor: ANONYMOUS, action: "refused", target, outcome: "refused", reason: "sign-in rate limit" });
  sendError(ctx.res, 429, "too many sign-in attempts; wait a minute and try again", { "retry-after": String(ctx.deps.limiter.retryAfterSec()) });
  return true;
}

async function postLogin(ctx) {
  if (rateLimited(ctx, "/login")) return;
  const token = typeof ctx.body.token === "string" ? ctx.body.token : "";
  const file = tokensOr503(ctx);
  if (!file) return;
  const entry = token === "" ? null : ctx.deps.findToken(file, token);
  if (!entry) {
    // The row says that a sign-in failed and nothing about what was presented.
    ctx.record({ actor: ANONYMOUS, action: "login-failed", target: "/login", outcome: "refused", reason: "no token matched" });
    return sendError(ctx.res, 401, "that token is not valid for this console");
  }
  return startSession(ctx, entry, file, "login");
}

async function postLoginCode(ctx) {
  if (rateLimited(ctx, "/login/code")) return;
  const code = typeof ctx.body.code === "string" ? ctx.body.code : "";
  const consumed = CODE_RE.test(code) ? ctx.deps.consumeLoginCode(code) : { refusal: "malformed" };
  const refuse = (reason) => {
    ctx.record({ actor: ANONYMOUS, action: "login-code", target: "/login/code", outcome: "refused", reason });
    return sendError(ctx.res, 401, "this sign-in link is used, expired or unknown; ask for a new one with pi-dispatch-console link");
  };
  if (!consumed || consumed.refusal) return refuse("code refused");
  const file = tokensOr503(ctx);
  if (!file) return;
  const entry = file.tokens.find((t) => t.name === consumed.name);
  if (!entry) return refuse("the link named a token that no longer exists");
  return startSession(ctx, entry, file, "login-code");
}

async function postLogout(ctx) {
  const { deps, res, session } = ctx;
  const actor = actorOf(ctx);
  deps.sessions.destroy(session.id);
  // The session's open streams end now, not at the hub's next tick.
  deps.hub?.endSession(session.id);
  // Signing out is never refused: a failed audit append is logged, and the session is gone either way.
  ctx.record({ actor, action: "logout", outcome: "ok" });
  return sendJson(res, 200, { ok: true }, { "set-cookie": deps.cookies.clearSessionCookie() });
}

/** The pause-windows file as it is now: `{text}` (null when absent) or `{refusal}`. */
function readSnapshot(fs, path) {
  try {
    return { text: fs.readFileSync(path, "utf8") };
  } catch (e) {
    if (e?.code === "ENOENT") return { text: null };
    return { refusal: `${path} cannot be read (${typeof e?.code === "string" ? e.code : "error"}); nothing was changed` };
  }
}

/**
 * Preview a pause-windows change: validate it through the loader's own parser, compute both digests, and bind the
 * result to a single-use ticket carrying the file AS READ NOW (`expect`). Nothing is written here.
 *
 * `afterText` is built exactly as `writePauseWindows` serializes (`JSON.stringify({windows}, null, 2)` plus a newline),
 * which is what makes `afterDigest` the digest of the file the confirm writes; a test holds the two equal against the
 * real writer, so a change to its serialization fails there rather than drifting the audit's digests.
 */
async function postPausePreview(ctx) {
  const { deps, body, res, session } = ctx;
  if (!Array.isArray(body.windows)) return sendError(res, 400, "send {\"windows\": [...]} with the whole new list of pause windows");
  // Only the file's own fields, each a plain value, before anything serializes the list: an unknown key would be kept
  // in the file for some later reader to trust, and a deeply nested value would cost a stack on the way to the parser.
  for (const [i, w] of body.windows.entries()) {
    if (w === null || typeof w !== "object" || Array.isArray(w)) return sendError(res, 400, `pause window at index ${i} is not an object; nothing was changed`);
    for (const [key, value] of Object.entries(w)) {
      if (!PAUSE_WINDOW_KEYS.includes(key)) return sendError(res, 400, `pause window at index ${i} has a field this file does not take (${PAUSE_WINDOW_KEYS.join(", ")} only); nothing was changed`);
      const plain = typeof value === "string" || (key === "days" && Array.isArray(value) && value.every((d) => typeof d === "string"));
      if (!plain) return sendError(res, 400, `pause window at index ${i}: ${key} must be ${key === "days" ? "a list of weekday names" : "a string"}; nothing was changed`);
    }
  }
  const path = deps.config.pauseWindowsPath;
  const snap = readSnapshot(deps.fs, path);
  if (snap.refusal) return sendError(res, 409, snap.refusal);
  let before = [];
  try {
    const raw = JSON.parse(snap.text ?? "null");
    if (Array.isArray(raw?.windows)) before = raw.windows;
  } catch {
    // An unparseable file reads as empty, as writePauseWindows reads it; the write below repairs it.
  }
  const afterText = `${JSON.stringify({ windows: body.windows }, null, 2)}\n`;
  try {
    parsePauseWindows(afterText, path);
  } catch (e) {
    return sendError(res, 400, `${e?.message ?? "the pause windows are not valid"}; nothing was changed`);
  }
  const beforeDigest = digestOf(snap.text);
  const afterDigest = digestOf(afterText);
  if (beforeDigest === afterDigest) return sendJson(res, 200, { unchanged: true, before, after: body.windows });
  const { ticket } = deps.tickets.issue({
    sessionId: session.id,
    action: PAUSE_WINDOWS_ACTION,
    target: path,
    payload: { windows: body.windows },
    expect: [{ path, text: snap.text }],
    beforeDigest,
    afterDigest,
  });
  return sendJson(res, 200, { ticket, before, after: body.windows, beforeDigest, afterDigest });
}

/**
 * Confirm a previewed pause-windows change. AUDIT, THEN WRITE, so no write can land unaudited:
 *
 *   - The audit append is synchronous and throws on failure; it runs BEFORE `writePauseWindows`, and a throw answers
 *     500 with nothing written. Appending after the rename was rejected: a crash or a full disk between the rename
 *     and the append would leave a change on disk that the log never saw, which is the one outcome the log exists
 *     to rule out.
 *   - The cost of that order: the `ok` row is written before the outcome is known. When the writer then refuses (the
 *     file changed after the preview, so `expect` no longer matches) or throws, a compensating `failed` row with the
 *     same `ticket` digest follows. A reader of the log takes the LAST row for a ticket as its outcome. If that second
 *     append also fails, the log line says so (the residual: an `ok` row for a write that did not land, the safe
 *     direction to be wrong in).
 *
 * The ticket is single use and bound to this session (`confirm.mjs`); `expect` makes the write refuse when the file is
 * not what the preview showed.
 */
async function postPauseConfirm(ctx) {
  const { deps, body, res, session } = ctx;
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  const actor = actorOf(ctx);
  const redeemed = ticket === "" ? { refusal: "no ticket was sent" } : deps.tickets.redeem({ sessionId: session.id, ticket, action: PAUSE_WINDOWS_ACTION });
  if (!redeemed.entry) {
    ctx.record({ actor, action: "write", target: deps.config.pauseWindowsPath, outcome: "refused", reason: String(redeemed.refusal ?? "ticket refused") });
    return sendError(res, 409, `${redeemed.refusal ?? "that confirmation is not valid"}; preview the change again`);
  }
  const entry = redeemed.entry;
  const row = { actor, action: "write", target: entry.target, beforeDigest: entry.beforeDigest, afterDigest: entry.afterDigest, ticket: sha256(ticket).slice(0, 12) };
  try {
    deps.audit.append({ ...row, outcome: "ok" });
  } catch (e) {
    deps.log(`console: audit append failed (${e?.code ?? "error"}), so the pause-windows write was refused`);
    return sendError(res, 500, "the audit log could not be written, so nothing was changed; check the console's log directory");
  }
  const compensate = (reason) => {
    try {
      deps.audit.append({ ...row, outcome: "failed", reason });
    } catch (e) {
      deps.log(`console: audit append failed (${e?.code ?? "error"}) after a pause-windows write did not land; the log's last row for ticket ${row.ticket} says ok and is wrong`);
    }
  };
  let result;
  try {
    result = deps.writePauseWindows({ pauseWindowsPath: entry.target, mutate: () => entry.payload.windows.map((w) => ({ ...w })), fs: deps.fs, expect: entry.expect });
  } catch (e) {
    compensate(`the write threw (${e?.code ?? "error"})`);
    deps.log(`console: pause-windows write threw (${e?.code ?? "error"})`);
    return sendError(res, 500, "the pause-windows file could not be written; nothing was changed");
  }
  if (!result?.ok) {
    const why = String(result?.invalid ?? "the write was refused");
    compensate(why);
    return sendError(res, 409, why);
  }
  return sendJson(res, 200, { ok: true, beforeDigest: entry.beforeDigest, afterDigest: entry.afterDigest });
}

// ---- pages, state and the live stream (issue #641) ----

/** `{query}` for page `name` from the request's query string, or null after answering 400. */
function pageQueryOr400(ctx, name, searchParams) {
  const parsed = ctx.deps.pages.parsePageQuery(name, searchParams);
  if (parsed?.refusal || !parsed || !("query" in parsed)) {
    sendError(ctx.res, 400, `${parsed?.refusal ?? "this page's query is not valid"}`);
    return null;
  }
  return parsed;
}

/** One screen: read its data, render it whole. HEAD runs the same and node sends no body. */
function pageHandler(name) {
  return async (ctx) => {
    const parsed = pageQueryOr400(ctx, name, ctx.searchParams);
    if (!parsed) return;
    const { pages, pageDeps, config } = ctx.deps;
    const data = await pages.loadPageData(name, parsed.query, pageDeps);
    const out = await pages.renderPage(name, { query: parsed.query, session: { name: ctx.session.name, role: ctx.session.role }, data, readOnly: Boolean(config.readOnly) });
    return sendHtml(ctx.res, out?.status ?? 200, out?.html ?? "");
  };
}

/** What `/api/state` answers, 503, when the snapshot cannot be read at all: a fixed sentence, never the error's text. */
export const STATE_UNREADABLE = "the fleet could not be read (is Valkey reachable?); try again";

/**
 * The snapshot as JSON, projected by `stateOf` for the session's role. A snapshot that rejects (Valkey down) is 503
 * `{version, error}` with `STATE_UNREADABLE`: a script tells "the fleet is unreadable" from "the console failed", and
 * the caught error (which can name a host and port) goes to the console's log by its code alone.
 */
async function getState(ctx) {
  const { deps, res, session } = ctx;
  const fleet = deps.pageDeps?.fleet;
  if (!fleet) return sendError(res, 503, "this console has no fleet reader; see its log");
  let snapshot;
  try {
    snapshot = await fleet.snapshot();
  } catch (e) {
    deps.log(`console: /api/state could not read the fleet (${typeof e?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : "error"})`);
    return sendJson(res, 503, { version: STATE_VERSION, error: STATE_UNREADABLE });
  }
  return sendJson(res, 200, deps.stateOf(snapshot, session.role, { now: deps.now() }));
}

/**
 * The live stream for one page (`/api/events?page=<name>&<that page's query>`). Refused before any header is sent:
 * an unknown or non-live page or a bad query (400), a page above the session's role (403), and a stream over the
 * token's cap (`PI_CONSOLE_MAX_STREAMS`, shared by every sign-in of the token), the console's (`STREAMS_TOTAL_MAX`)
 * or, for a viewer, the console's less the operators' reserve (`STREAMS_OPERATOR_RESERVE`) (429 with Retry-After). Once open,
 * the hub writes it; `close` gives both slots back, however the stream ended.
 */
async function getEvents(ctx) {
  const { deps, req, res, session } = ctx;
  const { PAGES } = deps.pages;
  // One `page`, as every other parameter is one: a second would open a stream for a page the URL also names otherwise.
  if (ctx.searchParams.getAll("page").length > 1) return sendError(res, 400, "page is given more than once");
  const name = ctx.searchParams.get("page") ?? "";
  const spec = Object.hasOwn(PAGES, name) ? PAGES[name] : null;
  if (!spec || !spec.live) return sendError(res, 400, "page must name a live page of this console");
  const role = roleRefusal(session, spec.auth);
  if (role) return sendError(res, 403, role);
  const rest = new URLSearchParams(ctx.searchParams);
  rest.delete("page");
  const parsed = pageQueryOr400(ctx, name, rest);
  if (!parsed) return;
  if (!deps.hub) return sendError(res, 503, "this console has no live updates; see its log");
  const busy = (sentence) => sendError(res, 429, sentence, { "retry-after": String(STREAM_RETRY_AFTER_SEC) });
  if (deps.streams.open >= deps.limits.streamsTotal) return busy("the console holds as many live streams as it allows; close a tab and try again");
  if (session.role !== "operator" && deps.streams.open >= deps.limits.streamsTotal - deps.limits.streamsOperatorReserve) {
    return busy("the console holds as many viewer streams as it allows (the rest are kept for operators); close a tab and try again");
  }
  if (!deps.sessions.streamAcquire(session.id)) return busy("this token's sign-ins hold as many live streams as it allows; close a tab and try again");
  deps.streams.open += 1;
  let released = false;
  let unsubscribe = () => {};
  const release = () => {
    if (released) return;
    released = true;
    unsubscribe();
    deps.sessions.streamRelease(session.id);
    deps.streams.open -= 1;
  };
  res.on("close", release);
  // The security headers are already set (the dispatcher's first step); these are the stream's own.
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  // The first bytes, so the browser sees the stream open before the first panel is rendered.
  res.write("retry: 2000\n\n");
  const presented = req.headers["last-event-id"];
  const lastEventId = typeof presented === "string" && EVENT_ID_RE.test(presented) ? presented : null;
  if (!released) unsubscribe = deps.hub.subscribe({ res, sessionId: session.id, session: { name: session.name, role: session.role }, page: name, query: parsed.query, lastEventId });
  if (released) unsubscribe();
}

/** One GET route per screen, from the pages' own table, so a screen cannot exist without its auth. */
function pageRoutes(PAGES) {
  return Object.entries(PAGES).map(([name, spec]) => ({ method: "GET", path: spec.path, auth: spec.auth, write: false, page: name, handler: pageHandler(name) }));
}

/**
 * The route table. `write: true` means: Origin and Sec-Fetch-Site checked, JSON only, body read and bounded, refusals
 * audited. `readOnlyExempt` is for signing in and out only: a read-only console still has to let people in.
 */
export const ROUTES = Object.freeze([
  { method: "GET", path: "/healthz", auth: "none", write: false, handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    ctx.res.end("ok");
  } },
  { method: "GET", path: "/login", auth: "none", write: false, handler: (ctx) => sendHtml(ctx.res, 200, loginPage()) },
  { method: "POST", path: "/login", auth: "none", write: true, readOnlyExempt: true, handler: postLogin },
  { method: "GET", path: "/login/code", auth: "none", write: false, handler: (ctx) => sendHtml(ctx.res, 200, loginCodePage()) },
  { method: "POST", path: "/login/code", auth: "none", write: true, readOnlyExempt: true, handler: postLoginCode },
  { method: "POST", path: "/logout", auth: "viewer", write: true, readOnlyExempt: true, handler: postLogout },
  ...pageRoutes(realPages.PAGES),
  { method: "GET", path: "/api/whoami", auth: "viewer", write: false, handler: (ctx) => sendJson(ctx.res, 200, { name: ctx.session.name, role: ctx.session.role, readOnly: Boolean(ctx.deps.config.readOnly) }) },
  { method: "GET", path: "/static/console.js", auth: "none", write: false, handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    ctx.res.end(CONSOLE_SCRIPT);
  } },
  { method: "GET", path: "/static/console.css", auth: "none", write: false, handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    ctx.res.end(CONSOLE_CSS);
  } },
  { method: "GET", path: "/api/state", auth: "viewer", write: false, handler: getState },
  // `noHead`: a HEAD would take a stream slot and hold it with no body ever sent, so it is 405 before anything runs.
  { method: "GET", path: "/api/events", auth: "viewer", write: false, noHead: true, handler: getEvents },
  { method: "POST", path: "/api/pause-windows/preview", auth: "operator", write: true, handler: postPausePreview },
  { method: "POST", path: "/api/pause-windows/confirm", auth: "operator", write: true, handler: postPauseConfirm },
].map((route) => Object.freeze(route)));

/**
 * `{route}`, `{allow}` (the path exists under other methods) or null. HEAD is served by the GET route, except a route
 * marked `noHead` (the event stream), which answers HEAD with 405 and `Allow: GET`.
 */
export function lookupRoute(method, pathname) {
  const want = method === "HEAD" ? "GET" : method;
  const onPath = ROUTES.filter((r) => r.path === pathname);
  if (onPath.length === 0) return null;
  const route = onPath.find((r) => r.method === want && !(method === "HEAD" && r.noHead));
  return route ? { route } : { allow: [...new Set(onPath.flatMap((r) => (r.method === "GET" ? (r.noHead ? ["GET"] : ["GET", "HEAD"]) : [r.method])))] };
}

/** The session behind the request's cookie, or null. Reads the tokens file each time, so a rotate or revoke bites at once. */
function resolveSession(deps, req) {
  const id = deps.cookies.readSessionCookie(req.headers.cookie);
  if (!id) return null;
  const read = deps.readTokens();
  if (!read.file) return null;
  return deps.sessions.get(id, read.file) ?? null;
}

/** Read and parse a write's body: `{body}`, or `{status, sentence}` for 413 or 400. */
async function readBody(req) {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  const tooLarge = { status: 413, sentence: `the request body is larger than ${BODY_LIMIT} bytes` };
  if (Number.isInteger(declared) && declared > BODY_LIMIT) return tooLarge;
  let raw;
  try {
    raw = await readRawBody(req, BODY_LIMIT);
  } catch (e) {
    if (e?.code === "E_PAYLOAD_TOO_LARGE") return tooLarge;
    throw e;
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return { status: 400, sentence: "the request body is not valid JSON" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { status: 400, sentence: "the request body must be a JSON object" };
  return { body };
}

async function dispatch(req, res, deps) {
  applySecurityHeaders(res);
  const method = req.method ?? "GET";
  let pathname;
  let searchParams;
  // Origin-form only (`/path`): an absolute-form target (`http://other/…`) or a scheme-relative one (`//other/…`) names
  // an authority the Host check never judges, so it is refused rather than resolved.
  const target = req.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) return sendError(res, 400, "the request line is not a path on this console");
  try {
    const url = new URL(target, "http://console.invalid");
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch {
    return sendError(res, 400, "the request line is not a valid path");
  }
  res.on("finish", () => deps.log(`console: ${method} ${pathname.slice(0, 200)} ${res.statusCode}`));
  // Best-effort audit for refusals and sign-outs: the request is already refused, so a failed append is logged.
  const write = (row) => {
    try {
      deps.audit.append(row);
    } catch (e) {
      deps.log(`console: audit append failed (${e?.code ?? "error"}) for a ${row.action} row`);
    }
  };
  // A refusal of a request that carried no session is written one row each only up to `REFUSAL_ROWS_PER_MINUTE`:
  // anyone who can reach the port can send those, and one chained row per request would let them grow the log
  // without bound. Past the limit they are counted, and the count is written as one row with the next one allowed.
  // A refusal of a signed-in request, every sign-in and every write is always its own row.
  const record = (row) => {
    if (row.actor === ANONYMOUS) {
      if (!deps.refusalRows.take()) {
        deps.quieted.count += 1;
        return;
      }
      if (deps.quieted.count > 0) {
        const n = deps.quieted.count;
        deps.quieted.count = 0;
        write({ actor: ANONYMOUS, action: "refused", target: "(rate limited)", outcome: "refused", reason: `${n} more ${n === 1 ? "refusal" : "refusals"} without a session went unwritten one by one (limit ${REFUSAL_ROWS_PER_MINUTE} a minute)` });
      }
    }
    write(row);
  };
  const isWriteMethod = method !== "GET" && method !== "HEAD";

  const host = hostRefusal(req.headers.host, deps.config.allowedHosts);
  if (host) {
    if (isWriteMethod) record({ actor: ANONYMOUS, action: "refused", target: pathname.slice(0, 200), outcome: "refused", reason: `host: ${host}` });
    return sendError(res, 421, host);
  }

  const found = lookupRoute(method, pathname);
  if (!found) return sendError(res, 404, "there is no such page on this console");
  if (found.allow) return sendError(res, 405, `${method} is not accepted here; use ${found.allow.join(" or ")}`, { allow: found.allow.join(", ") });
  const route = found.route;
  const ctx = { req, res, deps, route, session: null, body: null, record, searchParams };

  if (route.write) {
    const checks = [
      ["origin", originRefusal(req.headers)],
      ["content-type", contentTypeRefusal(req.headers)],
      ["read-only", route.readOnlyExempt ? null : readOnlyRefusal(deps.config)],
    ];
    for (const [guard, refusal] of checks) {
      if (refusal) {
        record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: `${guard}: ${refusal}` });
        return sendError(res, 403, refusal);
      }
    }
  }

  if (route.auth !== "none") {
    ctx.session = resolveSession(deps, req);
    if (!ctx.session) {
      if (route.write) record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: "auth: not signed in" });
      if (route.write || route.path.startsWith("/api/")) return sendError(res, 401, "sign in first", { "set-cookie": deps.cookies.clearSessionCookie() });
      return redirect(res, "/login");
    }
    const role = roleRefusal(ctx.session, route.auth);
    if (role) {
      if (route.write) record({ actor: actorOf(ctx), action: "refused", target: route.path, outcome: "refused", reason: `role: ${role}` });
      return sendError(res, 403, role);
    }
  }

  if (route.write) {
    const read = await readBody(req);
    if (!read.body) return sendError(res, read.status, read.sentence, read.status === 413 ? { connection: "close" } : {});
    ctx.body = read.body;
  }
  return route.handler(ctx);
}

/**
 * Build the console server (not yet listening; `listen.mjs` binds it). Collaborators, all injected:
 *
 *   - `config`: `consoleConfig`'s result (`allowedHosts`, `readOnly`, `maxMs`, `pauseWindowsPath`).
 *   - `readTokens()` -> `{file}` | `{refusal}`; `findToken(file, presented)` -> entry | null.
 *   - `sessions`: `create`, `get(id, file)`, `destroy(id)`.
 *   - `cookies`: `sessionCookie(id, {maxAgeSec})`, `clearSessionCookie()`, `readSessionCookie(header)`, `sessionDigest(id)`.
 *   - `consumeLoginCode(code)` -> `{name}` | `{refusal}` (the CLI binds the codes directory, fs and clock).
 *   - `tickets`: `issue({...})` -> `{ticket}`, `redeem({sessionId, ticket, action})` -> `{entry}` | `{refusal}`.
 *   - `audit.append(row)`: synchronous, throws on failure.
 *   - `writePauseWindows({pauseWindowsPath, mutate, fs, expect})` -> `{ok}` | `{invalid}`.
 *   - `limiter` (default: `makeLoginLimiter({now})`), `log(line)`, `fs`, `now`.
 *   - issue #641: `pages` (default: `pages.mjs`; its `PAGES` builds the routes, the rest renders), `pageDeps` (what
 *     `loadPageData` reads with: `{fleet, insights, audit, env, now}`), `hub` (`live.mjs`'s `makeLiveHub`), and
 *     `stateOf` (default: `live.mjs`'s).
 *   - `limits`: TESTS ONLY, overrides `SERVER_LIMITS`, `streamsTotal` (default `STREAMS_TOTAL_MAX`) and
 *     `streamsOperatorReserve` (default `STREAMS_OPERATOR_RESERVE`).
 */
export function createConsoleServer({
  config,
  fs = nodeFs,
  now = () => Date.now(),
  random = undefined,
  audit,
  sessions,
  cookies,
  tickets,
  limiter = makeLoginLimiter({ now }),
  log = () => {},
  readTokens,
  findToken,
  consumeLoginCode,
  writePauseWindows,
  pages = realPages,
  pageDeps = null,
  hub = null,
  stateOf = defaultStateOf,
  limits: limitsOverride = {},
}) {
  const limits = { ...SERVER_LIMITS, streamsTotal: STREAMS_TOTAL_MAX, streamsOperatorReserve: STREAMS_OPERATOR_RESERVE, ...limitsOverride };
  const refusalRows = makeLoginLimiter({ now, perMinute: REFUSAL_ROWS_PER_MINUTE, burst: 2 * REFUSAL_ROWS_PER_MINUTE });
  const deps = { config, fs, now, random, audit, sessions, cookies, tickets, limiter, log, readTokens, findToken, consumeLoginCode, writePauseWindows, refusalRows, quieted: { count: 0 }, pages, pageDeps, hub, stateOf, limits, streams: { open: 0 } };
  // `connectionsCheckingInterval` makes the two timeouts bite within a second of expiring rather than within node's
  // default 30: a client holding connections open without sending holds a slot of `maxConnections` only that long.
  const server = createServer({ headersTimeout: limits.headersTimeout, requestTimeout: limits.requestTimeout, connectionsCheckingInterval: limits.connectionsCheckingInterval }, (req, res) => {
    dispatch(req, res, deps).catch((e) => {
      log(`console: internal error (${e?.code ?? e?.name ?? "error"})`);
      if (!res.headersSent) sendError(res, 500, "the console failed on this request; see its log");
      else res.destroy();
    });
  });
  server.maxConnections = limits.maxConnections;
  return server;
}
