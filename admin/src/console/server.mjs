/**
 * The console's HTTP server: the route table and the one dispatcher every request goes through (issue #640,
 * DES-OPERATOR-CONSOLE, REQ-CONSOLE-SECURITY).
 *
 * THE GUARDS COME FROM THE TABLE. Each route declares `auth` ("none" | "viewer" | "operator") and `write`; the
 * dispatcher applies, in this order and for every route alike:
 *
 *   1. the security headers (`headers.mjs`), first, so a 404, 405, 413, 421 or 500 carries them too;
 *   2. the Host check (421), before the route lookup, so a rebound name learns nothing about which paths exist. The
 *      one exception is the routes marked `anyHost` (the script, the stylesheet and the favicon, GET and HEAD only):
 *      public bytes that need no session and carry no data, and exactly what the 421 page itself loads, so a refused
 *      name gets a styled page rather than one whose files were refused 421 in their turn. (Its tunnel command has a
 *      Copy button only where the page is a secure context, and a name other than localhost over plain http is not
 *      one: there the script leaves the button hidden, and the command is text to select.);
 *   3. the route lookup (404, or 405 with `Allow`; OPTIONS is a 405 like any unrouted method and gets no CORS);
 *   4. for a write: Origin and Sec-Fetch-Site, JSON content type, the read-only switch (403 each, audited);
 *   5. auth (503 while the tokens file cannot be used; 401 JSON, with `ended` and no Set-Cookie, for /api/* and
 *      writes; 303 to /login, with `?ended=` and the cookie cleared, for a page), then the person (below: 401 with
 *      `ended: "switched"` for a stream, 409 otherwise, audited for a write), then the role (403, audited for a write);
 *   6. for a write: the body, 64 KiB at most (413), parsed as a JSON object (400);
 *   7. the handler.
 *
 * A new route cannot skip a guard because no route applies its own; the header test iterates THIS table rather than
 * a hand list. The role is judged after auth because a role belongs to a session, and an unauthenticated write is
 * answered 401 (and audited) before anyone asks which role it lacks.
 *
 * EVERY COLLABORATOR IS INJECTED: the token reader, the session store and its cookie helpers, the confirm tickets, the
 * login-code consumer, the audit log, the pause-windows writer and (issue #642) the action deps. This module imports none of them, so its tests run
 * on small fakes and `cli.mjs` is the one place the real ones are wired.
 *
 * THE WRITES ARE A TABLE (issue #642). Every change the console can make is an entry of `ACTIONS` (`actions.mjs`), and
 * `actionRoutes` makes its two routes; one preview/confirm pipeline there holds the ticket, `expect`, audit-first and
 * compensating-row logic for all of them. After a write lands it pokes the live hub, so open tabs update at once.
 *
 * NOTHING SECRET IS LOGGED OR ECHOED. The request log is `METHOD /path status`: the path only (the one-time code rides
 * in the fragment, which never reaches a request line), never a query, a header value, a cookie or a body. Audit rows
 * carry names, roles, a session digest and file digests, never a token, a code or a payload.
 *
 * THE THEME COOKIE IS READ, NEVER WRITTEN (issue #737). Every page and both sign-in pages are drawn in the theme the
 * request's `pd_theme` cookie chose (`themeOf`, a closed set, so the cookie's own bytes never reach a page); the browser
 * script's theme button is the only writer of that cookie, and no response here sets it.
 *
 * A REFUSAL IS A PAGE FOR A PERSON AND JSON FOR A PROGRAM (issue #737, the ErrorPage card). `sendFailure` answers an
 * error page (`error-pages.mjs`) only to a GET or HEAD outside `/api/` and `/static/` whose Accept names `text/html`,
 * which is what a browser's own navigation sends; a script's fetch, the terminal client and every write get the same
 * `{error}` JSON as before, byte for byte, so no program learns a new shape. The page is drawn from a closed kind and
 * fixed sentences: the path is never echoed, a refused Host only escaped and cut, and a 421, 500 or 503 carries no
 * navigation (a 421's links would hit the same refused name; the other two cannot vouch for the session behind them).
 * Every page and every JSON answer carries the security headers, set by the dispatcher's first step.
 *
 * WHY A SESSION ENDED reaches the browser two ways (issues #737 and #711): a page request with a cookie the store no
 * longer honours is sent to `/login?ended=<reason>` (only a member of `ENDED_REASONS`, which the sign-in page maps to its
 * own sentence), and an API or write refusal's 401 body carries `ended`. An unreadable tokens file is 503 everywhere,
 * with no Set-Cookie and nothing ended: it judges no session, so it ends none (a write's 503 also carries the confirm
 * bar's refusal, `TOKENS_UNUSABLE` in the setup state with Close: `tokensUnusableBar`). Signing out is the exception
 * that needs no tokens file at all
 * (`postLogout`): it ends the session the browser holds, and judges nothing.
 *
 * A PAGE ACTS ONLY AS THE PERSON IT WAS DRAWN FOR (issue #737). The browser's cookie is whoever
 * signed in last in ANY of its tabs, and a one-time link (anyone's, sent to this browser) signs it in as that link's
 * person; a page drawn for one person that went on acting with the cookie would preview and confirm as another while
 * its bar still named the first, and a stream reconnecting by itself would draw the other person's panels under it. So
 * every request a page's script makes on its session's behalf says the person the page was drawn for (`<name>.<role>`,
 * from the bar's `.who`): its event streams in the `as` query parameter (`PERSON_PARAM`, which no page's own query takes,
 * so it is taken off before the page's query is parsed: an EventSource can send no header), its previews and confirms
 * in the `x-console-as` header (`PERSON_HEADER`). The dispatcher holds every value it is given to the session's own
 * person, byte for byte: a stream that says another is refused 401 with `PERSON_CHANGED_STREAM` and `ended:
 * "switched"`, anything else 409 with `PERSON_CHANGED` and the same `ended` (and, for a write, the confirm bar's
 * refusal, whose Look again the script sends to `/login?ended=switched`, never a reload into the other person's
 * console), before the role or the body is judged and before any slot or ticket is touched. Only a stream's query is
 * read for the person: on any other route `as` is a query parameter like any other. A request that says no person (the
 * terminal chat, curl) is not checked: the cookie is all it ever had.
 *
 * THE 401 OF AN API OR A WRITE CLEARS NO COOKIE (issue #737). A page learns that its session ended from a stream the
 * browser closed, and then asks `/api/whoami` with the same cookie for the reason; a stream 401 that cleared the cookie
 * left that probe with nothing to be judged by, so the reason was lost (plain `/login`). And when the browser had just
 * signed in again in another tab, an old-cookie probe's clearing 401 arrived after the new cookie and wiped it, signing
 * the browser out everywhere. The page's 303 (a navigation, which shows the sign-in page next) and `/logout` clear it.
 */
import * as nodeFs from "node:fs";
import { createServer } from "node:http";
import { readRawBody } from "@edgehero/pi-dispatch/http-body";
import { TRANSCRIPT_ID_RE } from "../read-model.mjs";
import { ACTIONS, actionNamed, confirmAction, plural, previewAction } from "./actions.mjs";
import { refusalHtml } from "./confirm-view.mjs";
import { errorPage as realErrorPage } from "./error-pages.mjs";
import { contentTypeRefusal, hostnameOf, hostRefusal, makeLoginLimiter, originRefusal, readOnlyRefusal, roleRefusal } from "./guards.mjs";
import { applySecurityHeaders } from "./headers.mjs";
import * as ui from "./kit.mjs";
import { isLoopbackAddress } from "./listen.mjs";
import { STATE_VERSION, stateOf as defaultStateOf } from "./live.mjs";
import { RUN_ID_RE } from "./panels.mjs";
import { getRun } from "./run-api.mjs";
import { getForkPoints } from "./fork-api.mjs";
import * as realPages from "./pages.mjs";
import { CONSOLE_SCRIPT } from "./script.mjs";
import { endedReasonOf, PERSON_HEADER, PERSON_PARAM } from "./session-ends.mjs";
import { loginCodePage, loginPage } from "./shell.mjs";
import { CONSOLE_CSS } from "./style.mjs";
import { themeOf } from "./theme.mjs";
import { TRANSCRIPT_FORMATS } from "./transcript.mjs";

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

/** The confirm-ticket action name of #640's reference write, now the `pause-windows` entry of `ACTIONS`. */
export const PAUSE_WINDOWS_ACTION = "pause-windows";

const ANONYMOUS = Object.freeze({ name: "anonymous", role: "none", session: null });
// One-time codes are base64url(32 bytes), 43 characters; anything far off that is refused before it is hashed.
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * What every request answers while the tokens file cannot be used (a sign-in, and since issue #737 any request with a
 * session cookie): 503 with this sentence, no Set-Cookie and no session ended, so a chmod mistake signs nobody out.
 */
export const TOKENS_UNUSABLE = "the console's tokens file cannot be used right now; the operator should run pi-dispatch doctor";

/**
 * The confirm bar a write's 503 carries for that tokens file (issue #737): `TOKENS_UNUSABLE`'s words exactly, its command
 * in the code face (`kit.mjs` `withCode`, whose code span the bundle keeps on one line, so it never breaks after the dash
 * of "pi-"), in the setup state: nothing on the page can fix the file, and a reload would only meet the same 503, so the
 * bar's one step is Close (it was Look again). The `error` beside it stays the sentence as it always was.
 */
function tokensUnusableBar(route) {
  const sentence = `${TOKENS_UNUSABLE.charAt(0).toUpperCase()}${TOKENS_UNUSABLE.slice(1).replace(/pi-dispatch doctor$/, "`pi-dispatch doctor`")}.`;
  const where = route.path.endsWith("/confirm") ? "confirm" : "preview";
  return String(refusalHtml({ where, status: 503, state: "setup", sentence: TOKENS_UNUSABLE, sentenceHtml: ui.withCode(sentence) }));
}

/** The 401 sentence of an API or write request with no session behind it (the body also carries `ended`). */
export const SIGN_IN_FIRST = "sign in first";

/** What a request that says another person than the browser's session is answered (see the header): fixed. */
export const PERSON_CHANGED = "this browser is now signed in as someone else, so nothing was changed; sign in again";

/** The same refusal for an event stream, which changes nothing either way: its 401 says what it refused. */
export const PERSON_CHANGED_STREAM = "this browser is now signed in as someone else, so this page's live updates were refused";

/**
 * A session's person as a request says it: `<name>.<role>`. A role is `operator` or `viewer` and holds no dot, so two
 * sessions with different names or roles never read the same, whatever dots a token name holds.
 */
const personOf = (session) => `${session.name}.${session.role}`;

/** The 500 sentence: fixed, so a caught error's own text (which can name a path or a host) never leaves the process. */
const CONSOLE_FAILED = "the console failed on this request; see its log";

// ---- responses ----

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, sentence, headers = {}) {
  sendJson(res, status, { error: sentence }, headers);
}

function sendHtml(res, status, fragment, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...headers, "content-type": "text/html; charset=utf-8" });
  res.end(String(fragment));
}

/** The path of a request's target, or null for one that is not an origin-form path (`dispatch` refuses those first). */
function pathnameOf(req) {
  const target = typeof req?.url === "string" ? req.url : "";
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  try {
    return new URL(target, "http://console.invalid").pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a failure is answered with a page (issue #737): a GET or HEAD, for a path outside `/api/` and `/static/`,
 * whose Accept names `text/html` in any case. A browser navigating sends exactly that; a script's `fetch`, an
 * `EventSource`, `curl` and the terminal client do not, so each keeps the JSON it parses. `/static/` is excluded because
 * a stylesheet or script request that failed must not be handed a page in place of the file it asked for.
 */
export function wantsHtml(req, pathname = pathnameOf(req)) {
  const method = req?.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  if (typeof pathname !== "string" || pathname.startsWith("/api/") || pathname.startsWith("/static/")) return false;
  const accept = req?.headers?.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/html");
}

/**
 * Who a navigation-only error page (a 404 or 405, answered before auth) names in its bar: the cookie's session as
 * `peek` sees it (no `lastSeen` move, no tombstone, nothing ended), `{name, role}` only, or null. A file that cannot be
 * read, or a reader that throws, is no session: the page is drawn signed out rather than not at all.
 */
function peekForNav(deps, req) {
  try {
    const id = deps.cookies.readSessionCookie(req.headers.cookie);
    if (!id) return null;
    const read = deps.readTokens();
    if (!read?.file) return null;
    const s = deps.sessions.peek(id, read.file);
    return s ? { name: s.name, role: s.role } : null;
  } catch {
    return null;
  }
}

/**
 * Answer a refusal or a failure (issue #737): `{error: sentence}` as JSON, the shape every program reads, unless the
 * request `wantsHtml`, then the error page of `page.kind` (`error-pages.mjs`) with the same status. `ctx` is the
 * dispatcher's (or `{req, res, deps}` before it has one); its `session` is the person the page's bar names, and with
 * `ctx.peek` (the 404 and 405, answered before auth) the bar's person is read by `peekForNav` instead. The 421, 503 and
 * 500 call sites pass neither, so no session is read for them, and `errorPage` draws no bar for those kinds whatever
 * it is given. `headers` (an `allow`, a `retry-after`) go on either answer; the security headers are already set (the
 * dispatcher's first step). A page that fails to draw falls back to the JSON, so a failure path never becomes a second
 * failure.
 */
function sendFailure(ctx, status, sentence, { headers = {}, page = null } = {}) {
  const { req, res, deps } = ctx;
  if (res.headersSent) return;
  if (!wantsHtml(req, ctx.pathname ?? pathnameOf(req))) return sendError(res, status, sentence, headers);
  const kind = page?.kind ?? "failed";
  const session = ctx.session ? { name: ctx.session.name, role: ctx.session.role } : ctx.peek ? peekForNav(deps, req) : null;
  let out;
  try {
    out = deps.errorPage({ ...page, kind, status, sentence, theme: themeOf(req.headers.cookie), session, readOnly: Boolean(deps.config?.readOnly) });
  } catch (e) {
    deps.log?.(`console: the ${kind} error page could not be drawn (${e?.name ?? "error"}), so the refusal went as JSON`);
    return sendError(res, status, sentence, headers);
  }
  return sendHtml(res, status, out.html, headers);
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
 * planted before sign-in is never promoted, and is destroyed once the sign-in succeeds), and audit it. An audit
 * failure refuses the sign-in.
 *
 * The session this request made and then refused for its audit row ends with no reason: it never reached a browser.
 * Its audit row is the sign-in, so it is written first, and only a sign-in that succeeded ends what the browser held: a
 * refused one leaves the old session, its streams and its other tabs as they were (they are still signed in).
 *
 * Once it succeeded, the session the browser held until now ends as `elsewhere` (issue #737): this browser signed in
 * again, so its other tabs' open streams end with that reason, and each probes, finds the new cookie, and reloads. A
 * planted or unknown cookie ends nothing and leaves no tombstone (`destroy` writes one only for a session it holds).
 *
 * THOSE STREAMS END ONCE THIS ANSWER HAS GONE OUT (the response's `finish`), not before it is written: an end sent
 * first had the other tabs probing with the old cookie while this answer and its new cookie were still on the way, so
 * they read `elsewhere` and left a browser that had just signed in. (The script also waits `RETRY_MS` before that
 * probe, for the browser to store the cookie; and should this answer never finish, the hub's next tick ends them, the
 * old session being gone already.)
 */
function startSession(ctx, entry, file, action, extra = {}) {
  const { deps, res } = ctx;
  const presented = deps.cookies.readSessionCookie(ctx.req.headers.cookie);
  const { id } = deps.sessions.create({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation });
  try {
    deps.audit.append({ actor: { name: entry.name, role: entry.role, session: deps.cookies.sessionDigest(id) }, action, outcome: "ok" });
  } catch (e) {
    deps.sessions.destroy(id, null);
    deps.log(`console: audit append failed (${e?.code ?? "error"}), so the sign-in was refused`);
    return sendError(res, 500, "the audit log could not be written, so the sign-in was refused; check the console's log directory");
  }
  if (presented) {
    deps.sessions.destroy(presented, "elsewhere");
    res.once("finish", () => deps.hub?.endSession(presented, "elsewhere"));
  }
  const cookie = deps.cookies.sessionCookie(id, { maxAgeSec: Math.floor(deps.config.maxMs / 1000) });
  return sendJson(res, 200, { ok: true, name: entry.name, role: entry.role, ...extra }, { "set-cookie": cookie });
}

/** The tokens file, or null after answering 503 (a file that went bad while the console ran: nobody signs in). */
function tokensOr503(ctx) {
  const read = ctx.deps.readTokens();
  if (read.file) return read.file;
  ctx.deps.log("console: the tokens file cannot be used; run pi-dispatch doctor");
  sendError(ctx.res, 503, TOKENS_UNUSABLE);
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
  // Issue #708: the page the link returns to, judged HERE by the page parser (`returnPathOf`), so the browser is only
  // ever sent to one of this console's own pages; anything else, or nothing, lands on the overview. The script checks
  // the answer's shape again before it navigates.
  return startSession(ctx, entry, file, "login-code", { next: realPages.returnPathOf(ctx.body.next) ?? "/" });
}

/**
 * Sign out (issue #737): EVERY session the browser presents ends, each the store holds (`readSessionCookies`: a cookie
 * planted beside the real one, `Path=/logout` from another loopback port's page, must not turn the sign-out into a no-op
 * answered 200), and the answer is 200 with the clearing Set-Cookie ALWAYS, also when no session was held (the
 * browser is signed out either way). It judges nothing, so it needs no tokens file: the route is `auth: "none"`, and
 * the store names who it ended (`destroy`). Behind the session auth it had before, an unreadable tokens file answered
 * sign-out 503 and kept the session, while the page went to sign-in as though it had signed out. The write guards
 * (Origin, JSON) still run first, so no other site can sign a browser out.
 */
async function postLogout(ctx) {
  const { deps, res } = ctx;
  let held = 0;
  for (const id of deps.cookies.readSessionCookies(ctx.req.headers.cookie)) {
    // `elsewhere`: the tab that signed out ignores its own stream's end (the script knows it is signing out), and every
    // other tab of this session is told the browser signed out elsewhere.
    const ended = deps.sessions.destroy(id, "elsewhere");
    // The session's open streams end now, not at the hub's next tick.
    deps.hub?.endSession(id, "elsewhere");
    // Signing out is never refused: a failed audit append is logged, and the session is gone either way. Each row names
    // a session the store held.
    if (ended) {
      held += 1;
      ctx.record({ actor: { name: ended.name, role: ended.role, session: deps.cookies.sessionDigest(id) }, action: "logout", outcome: "ok" });
    }
  }
  // Nothing held: the anonymous kind of row, rate limited like the others.
  if (held === 0) ctx.record({ actor: ANONYMOUS, action: "logout", target: "/logout", outcome: "ok", reason: "no session was held, so only the cookie was cleared" });
  return sendJson(res, 200, { ok: true }, { "set-cookie": deps.cookies.clearSessionCookie() });
}

// ---- pages, state and the live stream (issue #641) ----

/**
 * `{query}` for page `name` from the request's query string, or null after answering 400: as JSON, or (issue #737)
 * for a browser's navigation as the error page, which says the refusal (the parser's sentence names a parameter and
 * its rule, never a value) and links to the page without its query.
 */
function pageQueryOr400(ctx, name, searchParams) {
  const parsed = ctx.deps.pages.parsePageQuery(name, searchParams);
  if (parsed?.refusal || !parsed || !("query" in parsed)) {
    const refusal = `${parsed?.refusal ?? "this page's query is not valid"}`;
    sendFailure(ctx, 400, refusal, { page: { kind: "bad-query", sentence: refusal, page: name } });
    return null;
  }
  return parsed;
}

/**
 * One screen: read its data, render it whole, in the request's theme. HEAD runs the same and node sends no body.
 *
 * The flash (issue #737, the after-write banner) is taken by a GET alone, and only once the page's data has been read,
 * so a HEAD, a refused query or a failed read leaves it for the page that will show it. A failed read is a load that
 * threw, and also one whose primary read failed: `loadPageData` swallows that throw and marks `data.readFailed`, and
 * the page it draws says "could not be read", so the banner waits for the next page that reads. A page that throws
 * while it is drawn has taken it: the banner is a courtesy, and the audit log keeps the change either way.
 */
function pageHandler(name) {
  return async (ctx) => {
    const parsed = pageQueryOr400(ctx, name, ctx.searchParams);
    if (!parsed) return;
    const { pages, pageDeps, config } = ctx.deps;
    const data = await pages.loadPageData(name, parsed.query, pageDeps, { role: ctx.session.role, readOnly: Boolean(config.readOnly) });
    ctx.flash = ctx.req.method === "GET" && data?.readFailed !== true ? ctx.deps.sessions.takeFlash?.(ctx.session.id) ?? null : null;
    const out = await pages.renderPage(name, {
      query: parsed.query,
      session: { name: ctx.session.name, role: ctx.session.role },
      data,
      readOnly: Boolean(config.readOnly),
      theme: themeOf(ctx.req.headers.cookie),
      flash: ctx.flash,
      maxStreams: config.maxStreams,
    });
    return sendHtml(ctx.res, out?.status ?? 200, out?.html ?? "");
  };
}

/**
 * The sign-in page (issue #737). `?ended=` selects the notice for why the last session ended, only when it is given once
 * and is exactly a member of `ENDED_REASONS`; anything else (two of them, another word, another parameter) is no
 * notice, and no byte of the query reaches the page. The limits are this console's own, so the idle and longest-life
 * sentences state what it runs with; the footer follows how it listens (see `listenWord`).
 */
function getLogin(ctx) {
  const { config } = ctx.deps;
  const notice = loginNoticeOf(ctx.searchParams);
  const idleMinutes = Number.isSafeInteger(config.idleMs) ? Math.floor(config.idleMs / 60000) : undefined;
  const maxHours = Number.isSafeInteger(config.maxMs) ? Math.floor(config.maxMs / 3600000) : undefined;
  return sendHtml(ctx.res, 200, loginPage({ theme: themeOf(ctx.req.headers.cookie), notice, limits: { idleMinutes, maxHours }, listen: listenWord(config) }));
}

/** The sign-in page's `ended` notice from its query: exactly one `ended`, a member of `ENDED_REASONS`, else null. */
export function loginNoticeOf(searchParams) {
  const given = searchParams instanceof URLSearchParams ? searchParams.getAll("ended") : [];
  return given.length === 1 ? endedReasonOf(given[0]) : null;
}

/**
 * How the console listens, as the sign-in footer words it: `unix` for a unix socket, `tcp` for a loopback
 * address, and `public` for an address that is not loopback (PI_CONSOLE_BIND_PUBLIC=1), where saying "loopback only"
 * would be untrue. The loopback test is the listener's own (`isLoopbackAddress`; `parseListen` refuses a hostname, so
 * the host is always a literal), so the footer and the bind cannot disagree about what loopback is.
 */
function listenWord(config) {
  const listen = config?.listen;
  if (listen?.kind === "unix") return "unix";
  if (listen?.kind === "tcp" && typeof listen.host === "string" && !isLoopbackAddress(listen.host)) return "public";
  return "tcp";
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
  const presented = req.headers["last-event-id"];
  const lastEventId = typeof presented === "string" && (name === "run" ? TRANSCRIPT_ID_RE : EVENT_ID_RE).test(presented) ? presented : null;
  return openStream(ctx, () => deps.hub.subscribe({ res, sessionId: session.id, session: { name: session.name, role: session.role }, page: name, query: parsed.query, lastEventId }));
}

/**
 * The admission and lifecycle every event stream shares (`/api/events` and `/api/transcript`): the hub must exist
 * (503), then the console's cap, the viewers' share of it short of the operators' reserve, and the token's cap (429
 * with Retry-After each), all counted together whichever kind of stream holds the slot. Then the headers, the first
 * bytes, and `subscribe()` (which returns the hub's unsubscribe); `close` gives both slots back, however it ended.
 */
function openStream(ctx, subscribe) {
  const { deps, res, session } = ctx;
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
  if (!released) unsubscribe = subscribe();
  if (released) unsubscribe();
}

/**
 * One run's live transcript (issue #643, `/api/transcript?id=<jobId>`), operator only (the route table refuses a viewer
 * 403 before this runs): `id`, exactly once, in the run-id charset, and (issue #647) `format`, at most once, `html` (the
 * default, the run page's) or `json` (the structured entry, for the terminal chat); no other parameter (400).
 * `Last-Event-ID` is honoured only in the stream's own shape (`TRANSCRIPT_ID_RE`, `<ms>-<seq>`); anything else, a panel
 * stream's id included, is no id at all, and the stream starts from the beginning. The slots are `/api/events`'s,
 * shared, whichever format a stream asked for.
 */
async function getTranscript(ctx) {
  const { deps, req, res, session } = ctx;
  for (const key of new Set(ctx.searchParams.keys())) if (key !== "id" && key !== "format") return sendError(res, 400, "the transcript stream takes only id and format");
  const ids = ctx.searchParams.getAll("id");
  if (ids.length !== 1) return sendError(res, 400, ids.length === 0 ? "the transcript stream needs ?id= with a run's job id" : "id is given more than once");
  const jobId = ids[0];
  if (!RUN_ID_RE.test(jobId)) return sendError(res, 400, "id must be a run id (letters, digits and . _ : -, at most 200 characters)");
  const formats = ctx.searchParams.getAll("format");
  if (formats.length > 1) return sendError(res, 400, "format is given more than once");
  // The refusal names the rule, never the value, as every query refusal here does.
  if (formats.length === 1 && !TRANSCRIPT_FORMATS.includes(formats[0])) return sendError(res, 400, `format must be ${TRANSCRIPT_FORMATS.join(" or ")}`);
  const format = formats[0] ?? "html";
  const presented = req.headers["last-event-id"];
  const lastEventId = typeof presented === "string" && TRANSCRIPT_ID_RE.test(presented) ? presented : null;
  return openStream(ctx, () => deps.hub.subscribeTranscript({ res, sessionId: session.id, session: { name: session.name, role: session.role }, jobId, lastEventId, format }));
}

/** One GET route per screen, from the pages' own table, so a screen cannot exist without its auth. */
function pageRoutes(PAGES) {
  return Object.entries(PAGES).map(([name, spec]) => ({ method: "GET", path: spec.path, auth: spec.auth, write: false, page: name, handler: pageHandler(name) }));
}

/**
 * Two POST routes per console action (issue #642), from the action table itself, so an action cannot exist without
 * its auth and its write guards, and the route tests that iterate `ROUTES` reach every one: `/api/act/<name>/preview`
 * and `/api/act/<name>/confirm`, operator only, writes.
 */
function actionRoutes(actions) {
  return actions.flatMap((a) => [
    { method: "POST", path: `/api/act/${a.name}/preview`, auth: "operator", write: true, action: a.name, handler: (ctx) => previewAction(ctx, a) },
    { method: "POST", path: `/api/act/${a.name}/confirm`, auth: "operator", write: true, action: a.name, handler: (ctx) => confirmAction(ctx, a) },
  ]);
}

/**
 * The route table. `write: true` means: Origin and Sec-Fetch-Site checked, JSON only, body read and bounded, refusals
 * audited. `readOnlyExempt` is for signing in and out only: a read-only console still has to let people in. `anyHost`
 * (issue #737) is for the public files alone, the script, the stylesheet and the favicon: they answer before the Host
 * check (see the header), since they hold nothing a session or a rebound name could use, and the 421 page needs them.
 */
export const ROUTES = Object.freeze([
  { method: "GET", path: "/healthz", auth: "none", write: false, handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    ctx.res.end("ok");
  } },
  { method: "GET", path: "/login", auth: "none", write: false, handler: getLogin },
  { method: "POST", path: "/login", auth: "none", write: true, readOnlyExempt: true, handler: postLogin },
  { method: "GET", path: "/login/code", auth: "none", write: false, handler: (ctx) => sendHtml(ctx.res, 200, loginCodePage({ theme: themeOf(ctx.req.headers.cookie) })) },
  { method: "POST", path: "/login/code", auth: "none", write: true, readOnlyExempt: true, handler: postLoginCode },
  // `auth: "none"` (issue #737): a sign-out judges no session, it ends the one the cookie names (`postLogout`), so an
  // unreadable tokens file cannot keep a browser signed in that asked to sign out.
  { method: "POST", path: "/logout", auth: "none", write: true, readOnlyExempt: true, handler: postLogout },
  ...pageRoutes(realPages.PAGES),
  { method: "GET", path: "/api/whoami", auth: "viewer", write: false, handler: (ctx) => sendJson(ctx.res, 200, { name: ctx.session.name, role: ctx.session.role, readOnly: Boolean(ctx.deps.config.readOnly) }) },
  { method: "GET", path: "/static/console.js", auth: "none", write: false, anyHost: true, handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    ctx.res.end(CONSOLE_SCRIPT);
  } },
  { method: "GET", path: "/static/console.css", auth: "none", write: false, anyHost: true, handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    ctx.res.end(CONSOLE_CSS);
  } },
  // Issue #737: a browser asks for /favicon.ico when a page names no icon (no console page does), and the 404 it got
  // on a first visit was logged as an error in the browser's console. No content and no auth: the answer holds nothing,
  // and like every route it carries the security headers.
  { method: "GET", path: "/favicon.ico", auth: "none", write: false, anyHost: true, handler: (ctx) => {
    ctx.res.writeHead(204);
    ctx.res.end();
  } },
  { method: "GET", path: "/api/state", auth: "viewer", write: false, handler: getState },
  // Issue #647: one run and the chat it can have (`run-api.mjs`); a viewer's, since the answer carries no text at all.
  { method: "GET", path: "/api/fork-points", auth: "operator", write: false, handler: getForkPoints },
  { method: "GET", path: "/api/run", auth: "viewer", write: false, handler: getRun },
  // `noHead`: a HEAD would take a stream slot and hold it with no body ever sent, so it is 405 before anything runs.
  // `stream`: an event stream, which says its page's person in the query (`PERSON_PARAM`, see the header).
  { method: "GET", path: "/api/events", auth: "viewer", write: false, noHead: true, stream: true, handler: getEvents },
  // Issue #643: one run's live transcript, an operator's only (agent-written text); a stream, so no HEAD either.
  { method: "GET", path: "/api/transcript", auth: "operator", write: false, noHead: true, stream: true, handler: getTranscript },
  // #640's reference write keeps its paths, as aliases of the `pause-windows` action (DES-OPERATOR-CONSOLE): the same
  // handler, the same ticket action, so a ticket from either path redeems on either.
  { method: "POST", path: "/api/pause-windows/preview", auth: "operator", write: true, action: PAUSE_WINDOWS_ACTION, handler: (ctx) => previewAction(ctx, actionNamed(PAUSE_WINDOWS_ACTION)) },
  { method: "POST", path: "/api/pause-windows/confirm", auth: "operator", write: true, action: PAUSE_WINDOWS_ACTION, handler: (ctx) => confirmAction(ctx, actionNamed(PAUSE_WINDOWS_ACTION)) },
  ...actionRoutes(ACTIONS),
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

/**
 * The session behind the request's cookie. Reads the tokens file each time, so a rotate or revoke bites at once.
 *
 *   - `{session}`: a live one (its `lastSeen` moved, by `get`).
 *   - `{session: null, presented, ended}`: none. `presented` says a well-formed cookie came in (so there is one to
 *     clear); `ended` is why that id no longer signs in (`endedOf`, asked after `get` refused it, so a session `get`
 *     just ended reads its own reason), held to `ENDED_REASONS`, else null. No cookie reads no file: there is nothing
 *     to judge, and the sign-in page it is sent to answers for the file itself.
 *   - `{unavailable: true}`: a cookie came in and the tokens file cannot be used, so nothing can be judged and nothing
 *     is ended (no `get`, no tombstone, the session kept for when the file reads again).
 */
function resolveSession(deps, req) {
  const id = deps.cookies.readSessionCookie(req.headers.cookie);
  if (!id) return { session: null, presented: false, ended: null };
  const read = deps.readTokens();
  if (!read?.file) return { unavailable: true };
  const session = deps.sessions.get(id, read.file) ?? null;
  if (session) return { session };
  return { session: null, presented: true, ended: endedReasonOf(deps.sessions.endedOf?.(id) ?? null) };
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
        // Rows, not refusals: a sign-out with no session held is one of them too.
        write({ actor: ANONYMOUS, action: "refused", target: "(rate limited)", outcome: "refused", reason: `${plural(n, "more row")} without a session (refusals and sign-outs) went unwritten one by one (limit ${REFUSAL_ROWS_PER_MINUTE} a minute)` });
      }
    }
    write(row);
  };
  const isWriteMethod = method !== "GET" && method !== "HEAD";

  // The public files answer on any Host (see the header): looked up first for that alone, so every other path, one
  // that exists or not, a write to a public path included (a POST there is no route, so no `anyHost`), still meets the
  // Host check before anything about it is said.
  const found = lookupRoute(method, pathname);
  const host = found?.route?.anyHost === true ? null : hostRefusal(req.headers.host, deps.config.allowedHosts);
  if (host) {
    if (isWriteMethod) record({ actor: ANONYMOUS, action: "refused", target: pathname.slice(0, 200), outcome: "refused", reason: `host: ${host}` });
    // The page names the refused name (escaped and cut there) and the address and port this connection reached, for the
    // tunnel command; never a session (no bar, nothing read for one) and nothing else of how the console listens.
    return sendFailure({ req, res, deps, pathname }, 421, host, { page: { kind: "host", host: hostnameOf(req.headers.host), port: req.socket?.localPort ?? null, address: req.socket?.localAddress ?? null } });
  }

  // Before auth, so the page's bar is read with `peek`: a 404 or 405 neither extends nor ends a session.
  if (!found) return sendFailure({ req, res, deps, pathname, peek: true }, 404, "there is no such page on this console", { page: { kind: "no-page" } });
  if (found.allow) {
    return sendFailure({ req, res, deps, pathname, peek: true }, 405, `${method} is not accepted here; use ${found.allow.join(" or ")}`, { headers: { allow: found.allow.join(", ") }, page: { kind: "method" } });
  }
  const route = found.route;
  // The persons the request says it is made for (see the header): a stream's in its query, which is then taken off so
  // the page's own query is parsed without it, and anyone's in the header.
  const header = req.headers[PERSON_HEADER];
  const said = [...(route.stream ? searchParams.getAll(PERSON_PARAM) : []), ...(typeof header === "string" ? [header] : [])];
  if (route.stream && searchParams.has(PERSON_PARAM)) {
    searchParams = new URLSearchParams(searchParams);
    searchParams.delete(PERSON_PARAM);
  }
  const ctx = { req, res, deps, route, pathname, session: null, body: null, record, searchParams, json: (status, body, headers) => sendJson(res, status, body, headers), actor: () => actorOf(ctx) };

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
    const resolved = resolveSession(deps, req);
    if (resolved.unavailable) {
      // Nothing was judged, so nothing ends: no Set-Cookie (the browser keeps its cookie for when the file reads
      // again), no tombstone, the session untouched. The script reads this 503 on a stream or a probe as "not reachable,
      // retrying"; a write's carries the confirm bar's refusal (fixed, with Close: `tokensUnusableBar`), so the slot says
      // why.
      if (route.write) record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: "auth: the tokens file cannot be used" });
      deps.log("console: the tokens file cannot be used; run pi-dispatch doctor");
      if (route.write) return sendJson(res, 503, { error: TOKENS_UNUSABLE, html: tokensUnusableBar(route) });
      return sendFailure(ctx, 503, TOKENS_UNUSABLE, { page: { kind: "unavailable" } });
    }
    ctx.session = resolved.session;
    if (!ctx.session) {
      const { presented, ended } = resolved;
      if (route.write) record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: "auth: not signed in" });
      // No Set-Cookie (see the header): the probe that follows a closed stream must still carry this cookie to read why,
      // and must never clear a newer one another tab's sign-in set meanwhile.
      if (route.write || route.path.startsWith("/api/")) return sendJson(res, 401, { error: SIGN_IN_FIRST, ended });
      // `ended` is a member of `ENDED_REASONS` or null (resolveSession held it to the list), so the location is one of
      // eight fixed strings (and never `?ended=switched`, which no tombstone holds). A request with no cookie has
      // nothing to clear, so its answer is exactly what it was.
      return redirect(res, ended ? `/login?ended=${ended}` : "/login", presented ? { "set-cookie": deps.cookies.clearSessionCookie() } : {});
    }
    // The person (see the header), before the role: a page drawn for someone else learns that, not what the other one
    // may not do.
    if (said.some((person) => person !== personOf(ctx.session))) {
      if (route.write) record({ actor: actorOf(ctx), action: "refused", target: route.path, outcome: "refused", reason: "person: the page was drawn for another sign-in" });
      if (route.stream) return sendJson(res, 401, { error: PERSON_CHANGED_STREAM, ended: "switched" });
      // `ended` names why, as the stream's 401 does: the bar's Look again goes to sign-in saying so (the script), never
      // a reload into the other person's console.
      return sendJson(res, 409, { error: PERSON_CHANGED, ended: "switched", ...(route.write && { html: String(refusalHtml({ sentence: PERSON_CHANGED, status: 409, state: "changed" })) }) });
    }
    const role = roleRefusal(ctx.session, route.auth);
    if (role) {
      if (route.write) record({ actor: actorOf(ctx), action: "refused", target: route.path, outcome: "refused", reason: `role: ${role}` });
      return sendFailure(ctx, 403, role, { page: { kind: "operators-only" } });
    }
  }

  if (route.write) {
    const read = await readBody(req);
    if (!read.body) {
      // Audited like every other refusal of a write: the signed-in session's own row (a valid session is needed, so no
      // anonymous flood), or a rate-limited anonymous one for a sign-in. The row names the fixed sentence, never a byte
      // of the body.
      record({ actor: actorOf(ctx), action: "refused", target: route.path, outcome: "refused", reason: `body: ${read.sentence}` });
      return sendError(res, read.status, read.sentence, read.status === 413 ? { connection: "close" } : {});
    }
    ctx.body = read.body;
  }
  return route.handler(ctx);
}

/**
 * Build the console server (not yet listening; `listen.mjs` binds it). Collaborators, all injected:
 *
 *   - `config`: `consoleConfig`'s result (`allowedHosts`, `readOnly`, `idleMs`, `maxMs`, `maxStreams`, `listen`,
 *     `pauseWindowsPath`).
 *   - `readTokens()` -> `{file}` | `{refusal}`; `findToken(file, presented)` -> entry | null.
 *   - `sessions`: `create`, `get(id, file)`, `peek(id, file)` (the 404 and 405 pages' bar), `destroy(id, reason)`
 *     (`elsewhere` or null; it answers who it ended, `{name, role}`, or null, which the sign-out's audit row names),
 *     `endedOf(id)` (why a refused cookie's session ended), and the flash, `setFlash(id,
 *     change)` (the action table's) and `takeFlash(id)` (a page GET's); `verdict(id, file)` is the hub's, read through
 *     the CLI; `streamAcquire(id)` and `streamRelease(id)` the streams'.
 *   - `cookies`: `sessionCookie(id, {maxAgeSec})`, `clearSessionCookie()`, `readSessionCookie(header)` (the one session a
 *     request runs as), `readSessionCookies(header)` (every one a sign-out ends), `sessionDigest(id)`.
 *   - `consumeLoginCode(code)` -> `{name}` | `{refusal}` (the CLI binds the codes directory, fs and clock).
 *   - `tickets`: `issue({...})` -> `{ticket}`, `redeem({sessionId, ticket, action})` -> `{entry}` | `{refusal}`.
 *   - `audit.append(row)`: synchronous, throws on failure.
 *   - `writePauseWindows({pauseWindowsPath, mutate, fs, expect})` -> `{ok}` | `{invalid}`.
 *   - issue #642: `actionDeps`, what the action table's entries read and write with (`actions.mjs`): `{rm, plans,
 *     paths, env, fleet, killSwitchPlanFn, urlShown, envelopeProblem, host}`. An action whose needs are missing answers
 *     503 at its preview; the pause-windows write needs none of it.
 *   - `limiter` (default: `makeLoginLimiter({now})`), `log(line)`, `fs`, `now`.
 *   - issue #641: `pages` (default: `pages.mjs`; its `PAGES` builds the routes, the rest renders), `pageDeps` (what
 *     `loadPageData` reads with: `{fleet, insights, audit, env, now}`), `hub` (`live.mjs`'s `makeLiveHub`), and
 *     `stateOf` (default: `live.mjs`'s).
 *   - issue #737: `errorPage` (default: `error-pages.mjs`'s), what a refusal is drawn with for a browser's navigation.
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
  actionDeps = null,
  pages = realPages,
  pageDeps = null,
  hub = null,
  stateOf = defaultStateOf,
  errorPage = realErrorPage,
  limits: limitsOverride = {},
}) {
  const limits = { ...SERVER_LIMITS, streamsTotal: STREAMS_TOTAL_MAX, streamsOperatorReserve: STREAMS_OPERATOR_RESERVE, ...limitsOverride };
  const refusalRows = makeLoginLimiter({ now, perMinute: REFUSAL_ROWS_PER_MINUTE, burst: 2 * REFUSAL_ROWS_PER_MINUTE });
  const deps = { config, fs, now, random, audit, sessions, cookies, tickets, limiter, log, readTokens, findToken, consumeLoginCode, writePauseWindows, actionDeps, refusalRows, quieted: { count: 0 }, pages, pageDeps, hub, stateOf, errorPage, limits, streams: { open: 0 } };
  // `connectionsCheckingInterval` makes the two timeouts bite within a second of expiring rather than within node's
  // default 30: a client holding connections open without sending holds a slot of `maxConnections` only that long.
  const server = createServer({ headersTimeout: limits.headersTimeout, requestTimeout: limits.requestTimeout, connectionsCheckingInterval: limits.connectionsCheckingInterval }, (req, res) => {
    dispatch(req, res, deps).catch((e) => {
      log(`console: internal error (${e?.code ?? e?.name ?? "error"})`);
      if (res.headersSent) return res.destroy();
      // A page for a browser's navigation, JSON otherwise; the security headers were set before anything could throw,
      // and `sendFailure` falls back to the JSON when the page cannot be drawn, so the 500 always goes out.
      sendFailure({ req, res, deps }, 500, CONSOLE_FAILED, { page: { kind: "failed" } });
    });
  });
  server.maxConnections = limits.maxConnections;
  return server;
}
