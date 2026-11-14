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
 * on small fakes and `cli.mjs` is the one place the real ones are wired. `keptTokens` defaults to the tokens module's
 * own (issue #761): it is no collaborator but a pure read of the file `readTokens` answered, with no disk and no state.
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
import { keptTokens as realKeptTokens } from "@edgehero/pi-dispatch/console-tokens";
import { TRANSCRIPT_ID_RE } from "../read-model.mjs";
import { ACTIONS, actionNamed, cancelAction, confirmAction, plural, previewAction } from "./actions.mjs";
import { refusalHtml } from "./confirm-view.mjs";
import { codeKindOf, invitationMatches } from "./login-codes.mjs";
import { renderTriggerCheckResult } from "./panels/triggers.mjs";
import { errorPage as realErrorPage } from "./error-pages.mjs";
import { LOOPBACK_HOSTS, contentTypeRefusal, hostnameOf, hostRefusal, makeLoginLimiter, originRefusal, readOnlyRefusal, roleRefusal } from "./guards.mjs";
import { applySecurityHeaders } from "./headers.mjs";
import * as ui from "./kit.mjs";
import { isLocalhostAddress, isLoopbackAddress } from "./listen.mjs";
import { STATE_VERSION, stateOf as defaultStateOf } from "./live.mjs";
import { RUN_ID_RE } from "./panels.mjs";
import { getWatchTrace } from "./watch.mjs";
import { getRun } from "./run-api.mjs";
import { getForkPoints } from "./fork-api.mjs";
import * as realPages from "./pages.mjs";
import { CONSOLE_SCRIPT } from "./script.mjs";
import { endedReasonOf, PERSON_HEADER, PERSON_PARAM } from "./session-ends.mjs";
import { loginCodePage, loginPage } from "./shell.mjs";
import { CONSOLE_CSS } from "./style.mjs";
import { themeOf } from "./theme.mjs";
import { TRANSCRIPT_FORMATS } from "./transcript.mjs";
import { gatewayApi, gatewayLanding } from "./gateway.mjs";
import { ENDED_OF_DEVICE_REASON, REMEMBER_FRESH_MS, bindingFailure } from "./device-trust.mjs";
import { APPROVAL_WAIT_MS } from "./approve-dialog.mjs";
import { streamEndOf } from "./session-ends.mjs";
import { MAX_DEVICES_PER_NAME, REMEMBER_ROLES, deviceIdOf, deviceLabelOf } from "@edgehero/pi-dispatch/console-devices";
import { DEVICE_COOKIE_MAX_AGE_SEC } from "./sessions.mjs";

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
    const read = deps.readTokens();
    if (!read?.file) return null;
    // A read-only look at a remembered device: this draws a bar, so it signs nobody in and writes no row.
    const secret = deps.devices ? deps.cookies.readDeviceCookie(deps.devices.cookieName, req.headers.cookie) : null;
    if (secret) {
      const hash = deps.devices.hashOf(secret);
      const device = deps.devices.read(hash);
      if (device.record && !device.record.ended && bindingFailure(device.record, read.file) === null) return { name: device.record.name, role: device.record.role, remembered: deviceIdOf(hash) };
    }
    if (!id) return null;
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
  // `remembered` too (issue #849): the bar says so on every page a remembered browser is shown, a refusal's included.
  const session = ctx.session ? { name: ctx.session.name, role: ctx.session.role, ...(ctx.session.deviceHash ? { remembered: deviceIdOf(ctx.session.deviceHash) } : {}) } : ctx.peek ? peekForNav(deps, req) : null;
  let out;
  try {
    out = deps.errorPage({ ...page, kind, status, sentence, theme: themeOf(req.headers.cookie), session, readOnly: Boolean(deps.config?.readOnly), restart: session ? restartNoticeOf(deps) : null });
  } catch (e) {
    deps.log?.(`console: the ${kind} error page could not be drawn (${e?.name ?? "error"}), so the refusal went as JSON`);
    return sendError(res, status, sentence, headers);
  }
  return sendHtml(res, status, out.html, headers);
}

/**
 * Whether this console needs a restart, and why (issue #845, `restart-notice.mjs`), for the banner a signed-in page draws:
 * the notice, or null. A watch that fails costs the banner, never the page.
 */
function restartNoticeOf(deps) {
  try {
    return deps.restartNotice?.() ?? null;
  } catch {
    return null;
  }
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
 * Whether a browser on this request may be remembered: a console reached over loopback, a unix socket's tunnel or an enrolled HTTPS origin, never plain HTTP
 * across a network. Judged by the bind and by the origin the write guard already read for this request (`ctx.consoleOrigin`), never a second read. Under a
 * public bind the Host header decides nothing, since a non-browser client can set it to anything; under a loopback bind or a unix socket a name that is not
 * loopback is refused, which is the plain-HTTP proxy case. A proxy that instead sends a loopback Host upstream (nginx's default) still passes
 * the browser's own Origin, which the write guard refuses against that Host, so remembering, a write, fails there too. Only a proxy that rewrites
 * both headers to loopback names looks like a local browser, and it makes every write look local; this rule does not claim to catch that.
 */
function rememberTransportOk(ctx) {
  const https = typeof ctx.consoleOrigin === "string" && ctx.consoleOrigin.startsWith("https://");
  if (https) return true;
  if (listenWord(ctx.deps.config) === "public") return false;
  // A loopback bind can still be reached across a network through a plain-HTTP proxy under a `PI_CONSOLE_ALLOWED_HOSTS` name. The write guard has
  // already tied a browser's Origin to this Host, so a loopback name here means the browser itself is on this host or through a tunnel to it.
  // A unix socket too: the documented `ssh -L` to it arrives as `localhost`, and a proxy to the socket under another name is the case refused here.
  return LOOPBACK_HOSTS.includes(hostnameOf(ctx.req.headers.host));
}

/**
 * Whether this sign-in may become a remembered device without a box to tick (issue #882): a role a device may be remembered for, never a viewer
 * invitation, a device store that works on this host, and the transport `rememberTransportOk` asks for. The one rule for both of its uses, so they
 * cannot drift: a sign-in with a credential the host made (a one-time link or code) is remembered at once where it holds, and a token sign-in that
 * left the box unticked is offered it once where it holds. A sign-in where it does not hold stays an ordinary session, as it always was there.
 */
export function rememberAllowed(ctx, role, invited) {
  const { deps } = ctx;
  return !invited && REMEMBER_ROLES.includes(role) && Boolean(deps.devices) && deps.devices.unavailable() === null && rememberTransportOk(ctx);
}

/** Whether this origin is an enrolled HTTPS one, for a cookie's `Secure` on a GET, which has no `ctx.consoleOrigin`. Null when it cannot be told. A write uses the one its guard read. */
function secureOrigin(deps) {
  try {
    const origin = deps.consoleOrigin?.() ?? null;
    return origin === false ? null : typeof origin === "string" && origin.startsWith("https://");
  } catch {
    return null;
  }
}

/**
 * Whether this browser could be remembered here, for a page that offers it (issue #849): a device store that works on this host (never on Windows) and
 * the transport `rememberTransportOk` asks for, judged on a GET by `secureOrigin` in place of the write guard's origin. A page that offers it may still
 * be refused by the route, which judges again; one that does not offer it never shows a choice the console would then refuse.
 */
function rememberableHere(deps, req) {
  return rememberRefusalHere(deps, req) === null;
}

/** Why `rememberableHere` is false, for a page that says so in its own words: `store`, `windows`, `transport`, or null when it is not. */
function rememberRefusalHere(deps, req) {
  if (!deps.devices) return "store";
  const kind = typeof deps.devices.unavailableKind === "function" ? deps.devices.unavailableKind() : deps.devices.unavailable() !== null ? "store" : null;
  if (kind !== null) return kind;
  if (secureOrigin(deps) === true) return null;
  return listenWord(deps.config) !== "public" && LOOPBACK_HOSTS.includes(hostnameOf(req.headers.host)) ? null : "transport";
}

/**
 * The `Secure` for re-setting a device cookie on this read, or null to leave the cookie as it is. With no enrolled HTTPS origin now, only where remembering
 * would be allowed without one (a loopback Host on a bind that is not public): a cookie made under an enrollment that has since been removed must never be
 * re-set without `Secure` on a name a network carries, which would send it in the clear from then on. It simply ages, and the browser signs in again.
 */
function renewSecureOf(ctx) {
  const secure = secureOrigin(ctx.deps);
  if (secure !== false) return secure;
  return listenWord(ctx.deps.config) !== "public" && LOOPBACK_HOSTS.includes(hostnameOf(ctx.req.headers.host)) ? false : null;
}

/**
 * Create a session for `entry` (a tokens-file entry), with a NEW id whatever cookie came in (no fixation: a cookie
 * planted before sign-in is never promoted, and is destroyed once the sign-in succeeds), and audit it. An audit
 * failure refuses the sign-in.
 *
 * The one exception is a browser that already remembers this same person under a record that still holds (issue #849):
 * it keeps its device and that device's one session, since a second session for the same device would be a second
 * credential, and the sign-in is still on the record. A record of someone else, or one whose binding has stopped
 * holding, is ended once this sign-in's own row is written, with the true reason, and its cookie cleared.
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
 *
 * REMEMBERED BY DEFAULT (issue #882): `hostMade` is a sign-in with a credential the host made, a one-time link or code. It
 * remembers the browser at once wherever `rememberAllowed` holds, as a ticked box would, because the person who ran the
 * command on the host has already vouched for this browser, and asking again was the step people missed. `remember` is
 * the token form's box, which asks and is refused when it cannot be honoured (`postLogin`). A third host-approved way in
 * passes `hostMade` too, and gets the same rule. `audit` is extra fields for the sign-in's own row (a code's `kind`), and
 * `note` a notice for the first page (a token whose role no browser may remember, signed in all the same).
 */
function startSession(ctx, entry, file, action, extra = {}, { remember = false, invited = false, hostMade = false, audit = {}, note = null } = {}) {
  const { deps, res } = ctx;
  const presented = deps.cookies.readSessionCookie(ctx.req.headers.cookie);
  // The write guard already judged this request against the protected canonical origin. Reuse that exact
  // declaration, never a forwarding header or a second file read that could change while the body arrived.
  const secure = typeof ctx.consoleOrigin === "string" && ctx.consoleOrigin.startsWith("https://");
  const cookies = [];
  let deviceEnded = false;
  const secret = deps.devices ? deps.cookies.readDeviceCookie(deps.devices.cookieName, ctx.req.headers.cookie) : null;
  let replacing = null;
  let unreadable = null;
  // What this sign-in's first page should say about the browser (issue #849), gathered into one flash below. `note` is the caller's (issue #882).
  const notices = note ? [note] : [];
  if (secret) {
    const hash = deps.devices.hashOf(secret);
    const read = deps.devices.read(hash);
    if (read.record && !read.record.ended && read.record.name === entry.name && read.record.tokenHash === entry.sha256 && bindingFailure(read.record, file) === null && deps.now() - read.mtimeMs <= DEVICE_COOKIE_MAX_AGE_SEC * 1000) {
      // The same person signing in on a browser that already remembers them: nothing about the browser changes, and the sign-in is still on the record.
      const made = deps.sessions.ensureDevice({ deviceHash: hash, name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation });
      try {
        deps.audit.append({ actor: { name: entry.name, role: entry.role, session: deps.cookies.sessionDigest(made.id) }, action, ...audit, outcome: "ok" });
      } catch (e) {
        // A session made just now with no row would be restored later with none.
        if (made.created) deps.sessions.destroy(made.id, null);
        deps.log(`console: audit append failed (${e?.code ?? "error"}), so the sign-in was refused`);
        return sendError(res, 500, "the audit log could not be written, so the sign-in was refused; check the console's log directory");
      }
      return sendJson(res, 200, { ok: true, name: entry.name, role: entry.role, remembered: true, ...extra });
    }
    // Someone else, or the same person under a binding that no longer holds. Ended only once this sign-in is on the record, below: a refused sign-in must
    // not sign the browser's previous person out. Left in place it would outrank the new sign-in, and a later sign-out would land on the wrong console.
    if (read.record && !read.record.ended) {
      const sameName = read.record.name === entry.name;
      const reason = !sameName ? "replaced" : bindingFailure(read.record, file) ?? (read.record.tokenHash === entry.sha256 ? "removed" : "replaced");
      replacing = { hash, record: read.record, reason };
    } else if (read.unjudged) {
      // A record that cannot be read could be anyone's, so its cookie is cleared all the same (kept, it could switch this browser back to another person once
      // the record reads again). The record itself is left, so it gets a row with its id, below, for an operator to revoke once doctor passes.
      unreadable = hash;
    }
    cookies.push(deps.cookies.clearDeviceCookie(deps.devices.cookieName));
  }
  const { id } = deps.sessions.create({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation, invited });
  try {
    deps.audit.append({ actor: { name: entry.name, role: entry.role, session: deps.cookies.sessionDigest(id) }, action, ...audit, outcome: "ok" });
  } catch (e) {
    deps.sessions.destroy(id, null);
    deps.log(`console: audit append failed (${e?.code ?? "error"}), so the sign-in was refused`);
    return sendError(res, 500, "the audit log could not be written, so the sign-in was refused; check the console's log directory");
  }
  if (replacing) {
    const done = deps.devices.end(replacing.hash, replacing.reason);
    ctx.record({ actor: { name: replacing.record.name, role: replacing.record.role, session: null }, action: "device-ended", target: deviceIdOf(replacing.hash), outcome: done.unerased ? "failed" : "ok", reason: replacing.record.name !== entry.name ? "another person signed in on this browser" : replacing.reason === "removed" ? "unused for longer than any browser keeps the cookie" : "the same person signed in again after the device's token changed" });
    deviceEnded = true;
    dropDeviceSession(deps, replacing.hash, "elsewhere", res);
    // Said on the new session's first page, so the person signing in sees that the browser stopped remembering someone else, or may not have.
    if (replacing.record.name !== entry.name) {
      const who = replacing.record.name;
      notices.push(done.unerased
        ? { status: "attention", summary: `This browser may still remember ${who}`, body: `Its record could not be ended. An operator should run pi-dispatch doctor on the host, then remove it on Remembered browsers or with pi-dispatch-console device revoke.` }
        : { status: "idle", summary: `This browser no longer remembers ${who}`, body: `${who} can sign in here again and ask to be remembered.` });
    }
  }
  if (unreadable) {
    // A session of it held here proves the record real in this process: refused in memory, as a sign-out over one is.
    if (deps.sessions.sessionOfDevice?.(unreadable)) {
      deps.devices.end(unreadable, "replaced");
      dropDeviceSession(deps, unreadable, "elsewhere", res);
    }
    ctx.record({ actor: { name: entry.name, role: entry.role, session: deps.cookies.sessionDigest(id) }, action: "device-ended", target: deviceIdOf(unreadable), outcome: "failed", reason: "signed in again while the record could not be read: its cookie was cleared and the record left; revoke it once doctor passes" });
    // The record names nobody the console can read, so the notice cannot say whose: only that a copy of the cookie may still work. A store that is
    // unusable as a whole makes every cookie read so, its owner's own included, and names no record: that is the folder's problem, said as such.
    notices.push(deps.devices.unavailableKind?.() === "store"
      ? { status: "attention", summary: "This browser's remembered sign-in could not be checked", body: "The console cannot use its store of remembered browsers, so this browser may still be remembered. An operator should run pi-dispatch doctor on the host." }
      : { status: "attention", summary: "This browser may still remember someone else", body: `Its remembered sign-in could not be read, so it was left. An operator should run pi-dispatch doctor on the host, then remove it with pi-dispatch-console device revoke --id ${deviceIdOf(unreadable)}.` });
  }
  if (presented) {
    deps.sessions.destroy(presented, "elsewhere");
    deps.actionDeps?.setup?.endSession?.(presented);
    deps.tickets?.endSession?.(presented);
    res.once("finish", () => deps.hub?.endSession(presented, "elsewhere"));
  }
  // Judged once here: the box asked for it (already found allowed by `postLogin`), or a host-made credential where remembering is allowed.
  const remembering = remember || (hostMade && rememberAllowed(ctx, entry.role, invited));
  let remembered = false;
  if (remembering) {
    const made = rememberOnto(ctx, id, entry, file, secure, { makeRoom: hostMade && !remember });
    if (made.cookie) {
      cookies.push(made.cookie);
      // One credential: an ordinary cookie that came in goes, since its session has just ended above.
      if (presented) cookies.push(deps.cookies.clearSessionCookie());
      remembered = true;
    } else {
      // Asked and not done: said on the first page, so nobody walks away believing this browser stays signed in.
      notices.push({ status: "attention", summary: "This browser was not remembered", body: notRemembered(made.refusal, entry.role, Boolean(deps.config.readOnly)) });
    }
  }
  // One flash holds what this sign-in has to say, so a second notice never replaces a warning the first one gave (both come with a full disk).
  if (notices.length > 0) deps.sessions.setFlash?.(id, { notice: true, status: notices.some((n) => n.status === "attention") ? "attention" : "idle", summary: notices.map((n, i) => (i === 0 ? n.summary : n.summary.charAt(0).toLowerCase() + n.summary.slice(1))).join(", and "), body: notices.map((n) => n.body).join(" ") });
  if (!remembered) cookies.push(deps.cookies.sessionCookie(id, { maxAgeSec: Math.floor(deps.config.maxMs / 1000), secure }));
  // Offered once, on the next page, to a token sign-in that could be remembered and left the box unticked (issue #849), where Not now is the answer
  // and nothing follows from ignoring it. A host-made credential is remembered above instead (issue #882), so it is never offered.
  if (!remembering && !hostMade && rememberAllowed(ctx, entry.role, invited)) deps.sessions.setOffer?.(id);
  return sendJson(res, 200, { ok: true, name: entry.name, role: entry.role, ...extra, ...(remembering ? { remembered } : {}), ...(deviceEnded ? { deviceEnded: true } : {}) }, { "set-cookie": cookies.length === 1 ? cookies[0] : cookies });
}

/**
 * Make session `id` a remembered device (with `makeRoom`, for a host-made credential, at the cap the least recently used browser of this person is
 * forgotten in its place, issue #882): `{cookie}`, or `{refusal}` having said why in the log, `full` when this sign-in already has the most remembered browsers one may
 * have (a person can remove one), `failed` for anything else (the operator's to fix). The audit row comes first, as for every mint; a store that refuses leaves an
 * ordinary session, which the person is told.
 */
function rememberOnto(ctx, id, entry, file, secure, { makeRoom = false } = {}) {
  const { deps } = ctx;
  const actor = { name: entry.name, role: entry.role, session: deps.cookies.sessionDigest(id) };
  try {
    deps.audit.append({ actor, action: "device-remembered", outcome: "ok" });
  } catch (e) {
    deps.log(`console: audit append failed (${e?.code ?? "error"}), so this device was not remembered`);
    return { refusal: "failed" };
  }
  const made = deps.devices.remember({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: file.generation, tokenCreatedAt: entry.createdAt, label: deviceLabelOf(ctx.req.headers["user-agent"]), ...(makeRoom ? { makeRoom: true } : {}) });
  if (made.replaced) {
    // Issue #882: the oldest of this person's remembered browsers gave up its place. On the record with why, and its session here ends now.
    ctx.record({ actor: { name: made.replaced.record.name, role: made.replaced.record.role, session: null }, action: "device-ended", target: deviceIdOf(made.replaced.hash), outcome: "ok", reason: `the least recently used of the ${MAX_DEVICES_PER_NAME} browsers one sign-in may remember, forgotten to remember a new one` });
    dropDeviceSession(deps, made.replaced.hash, "device", ctx.res);
  }
  if (!made.hash) {
    ctx.record({ actor, action: "device-remembered", outcome: "failed", reason: "the store refused" });
    deps.log(`console: this device could not be remembered: ${made.refusal}`);
    return { refusal: made.full ? "full" : "failed" };
  }
  // Two tabs pressing Remember together: the second finds the session already adopted, and its record must not stay behind, live and unclaimed.
  if (!deps.sessions.adoptDevice(id, made.hash)) {
    deps.devices.end(made.hash, "replaced");
    return { refusal: "failed" };
  }
  deps.devices.reap();
  return { cookie: deps.cookies.deviceCookie(deps.devices.cookieName, made.secret, { secure }) };
}

/**
 * What a person is told when a browser they asked to remember, or one a host-made link or code would have remembered (issue #882), was not (issue #849):
 * never left believing it is. A viewer has no Remove, so is told what she can do. "Sign in again" names no box: a link, a code and the token form's box,
 * which starts ticked, each remember a browser.
 */
export const NOT_REMEMBERED = Object.freeze({
  full: `This sign-in already has ${MAX_DEVICES_PER_NAME} remembered browsers, the most it may have. Remove one on Remembered browsers, then sign out and sign in again here. You are signed in for this session only.`,
  fullViewer: `This sign-in already has ${MAX_DEVICES_PER_NAME} remembered browsers, the most it may have. Sign out on one you no longer use, or ask an operator to remove one, then sign out and sign in again here. You are signed in for this session only.`,
  fullReadOnly: `This sign-in already has ${MAX_DEVICES_PER_NAME} remembered browsers, the most it may have. This console is read-only, so sign out on one you no longer use, or remove one with pi-dispatch-console device revoke on the host, then sign out and sign in again here. You are signed in for this session only.`,
  failed: "You are signed in for this session only. The console's log says why, and an operator should run pi-dispatch doctor on the host.",
});
/** Which of `NOT_REMEMBERED` a person gets: Remove is offered only to an operator on a console that takes changes. */
const notRemembered = (refusal, role, readOnly) => (refusal !== "full" ? NOT_REMEMBERED.failed : readOnly ? NOT_REMEMBERED.fullReadOnly : role === "operator" ? NOT_REMEMBERED.full : NOT_REMEMBERED.fullViewer);

/**
 * How long a live session must have left for a same-person link to keep it rather than make a new one (issue #849): an hour, or a quarter of the
 * console's longest session life when that is shorter, so a console set to `PI_CONSOLE_MAX_HOURS=1` keeps a fresh session too.
 */
export const KEEP_SESSION_MIN_LEFT_MS = 3600000;
export const keepSessionMinLeftMs = (maxMs) => Math.min(KEEP_SESSION_MIN_LEFT_MS, Math.floor(maxMs / 4));

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
  // Only when the page asked, so the answer to a plain sign-in is what it always was. The page parser judges it, as for a link.
  const asked = ctx.body.remember === true;
  // Issue #882 (review): the box starts ticked, so an `agent` token, which no browser may remember, arrives asking. It signs in as an ordinary
  // session and its first page says it was not remembered; refusing it, as #849 did when the box was a choice, locked agent tokens out of the form.
  const roleNotRemembered = asked && !REMEMBER_ROLES.includes(entry.role);
  const remember = asked && !roleNotRemembered;
  if (remember) {
    // Refused rather than ignored: someone who asked to be remembered must not walk away believing they are. The page draws the box only where
    // neither holds (`rememberableHere`), so these are a script's or a console changed since the page was drawn.
    const why = !ctx.deps.devices ? "remembering a device is not available on this console" : !rememberTransportOk(ctx) ? "this console is reached over plain HTTP, where a remembered sign-in would cross the network" : null;
    if (why) {
      ctx.record({ actor: { name: entry.name, role: entry.role, session: null }, action: "login-failed", target: "/login", outcome: "refused", reason: why });
      return sendError(ctx.res, 403, why);
    }
  }
  const note = roleNotRemembered ? { status: "attention", summary: "This browser was not remembered", body: `An ${entry.role} token is never remembered on a browser, so you are signed in for this session only.` } : null;
  return startSession(ctx, entry, file, "login", ctx.body.next === undefined ? {} : { next: realPages.returnPathOf(ctx.body.next) ?? "/" }, { remember, note });
}

/**
 * Sign in with a one-time code the host made (issue #640), either kind (issue #882): the link page posts a link's code
 * to `/login/code`, and the sign-in page's Sign-in code field posts what was typed to `/login/typed-code`. ONE HANDLER:
 * the two routes differ only in which page's notices a refusal selects (`NOTICE_OF_STATUS`), so each code is judged the
 * same way whichever page sent it. CODE_RE's 43 characters are widened DELIBERATELY to the two shapes `codeKindOf`
 * names, a link's 43 characters or a typed short code, and anything else is refused before it is hashed or read. The
 * audit rows say which kind (`kind`, `link` or `short-code`), never the code.
 */
async function postLoginCode(ctx) {
  const route = ctx.route.path;
  if (rateLimited(ctx, route)) return;
  const code = typeof ctx.body.code === "string" ? ctx.body.code : "";
  const kind = codeKindOf(code);
  const consumed = kind !== null ? ctx.deps.consumeLoginCode(code) : { refusal: "malformed" };
  const refuse = (reason) => {
    ctx.record({ actor: ANONYMOUS, action: "login-code", ...(kind === null ? {} : { kind }), target: route, outcome: "refused", reason });
    // `link` picks the link page's state. Only what the code alone shows is told apart: a used code and one never made look the same to the server.
    return sendJson(ctx.res, 401, { error: kind === "short-code" ? "that sign-in code is used, expired or unknown; make a new one with pi-dispatch-console link" : "this sign-in link is used, expired or unknown; ask for a new one with ./pi-dispatch console", link: consumed?.kind === "expired" ? "expired" : "used" });
  };
  if (!consumed || consumed.refusal) return refuse("code refused");
  const file = tokensOr503(ctx);
  if (!file) return;
  const entry = file.tokens.find((t) => t.name === consumed.name);
  if (!entry) {
    // Issue #761: a name the file still holds, for a role this console does not know (`keptTokens`), is no missing
    // token, and the row says which; it signs in nowhere here all the same.
    const kept = ctx.deps.keptTokens(file).some((t) => t.name === consumed.name);
    return refuse(kept ? "the link named a token whose role this console does not know" : "the link named a token that no longer exists");
  }
  if (consumed.binding !== undefined && !invitationMatches(consumed.binding, entry, file)) return refuse("the viewer invitation entry or generation changed");
  // Issue #849: a link for the person this browser is already signed in as keeps that session, rather than replacing it. `/dispatch console`
  // makes a link by default, and a replaced session would end what it was doing: a /setup operation, a preview, other tabs' streams. The code
  // is spent and the sign-in is on the record all the same; an invitation's sign-in is never this (it binds a session of its own kind).
  const held = consumed.binding === undefined ? ctx.deps.sessions.get(ctx.deps.cookies.readSessionCookie(ctx.req.headers.cookie), file) : null;
  // Only with an hour or more left of its longest life: a link is a fresh sign-in, and one kept near its end would sign the person out minutes later.
  const timeLeft = held ? held.createdAt + ctx.deps.config.maxMs - ctx.deps.now() : 0;
  if (held && timeLeft >= keepSessionMinLeftMs(ctx.deps.config.maxMs) && !held.deviceHash && !held.invited && held.name === entry.name && held.role === entry.role && held.tokenHash === entry.sha256 && held.generation === file.generation) {
    try {
      ctx.deps.audit.append({ actor: { name: entry.name, role: entry.role, session: ctx.deps.cookies.sessionDigest(held.id) }, action: "login-code", kind, outcome: "ok", reason: "the browser was already signed in as this person, so its session was kept" });
    } catch (e) {
      ctx.deps.log(`console: audit append failed (${e?.code ?? "error"}), so the sign-in was refused`);
      return sendError(ctx.res, 500, "the audit log could not be written, so the sign-in was refused; check the console's log directory");
    }
    // Issue #882: the kept session is remembered too, as a fresh one would be: the host has just vouched for this browser. It is the remember route's
    // own step (`rememberOnto`, then the device cookie in place of `pdc_session`), so the session, its streams and its tickets carry on as they were.
    const kept = { ok: true, name: entry.name, role: entry.role, next: realPages.returnPathOf(ctx.body.next) ?? "/", kept: true };
    if (!rememberAllowed(ctx, entry.role, false)) return sendJson(ctx.res, 200, kept);
    const made = rememberOnto(ctx, held.id, entry, file, typeof ctx.consoleOrigin === "string" && ctx.consoleOrigin.startsWith("https://"), { makeRoom: true });
    if (made.cookie) return sendJson(ctx.res, 200, { ...kept, remembered: true }, { "set-cookie": [made.cookie, ctx.deps.cookies.clearSessionCookie()] });
    ctx.deps.sessions.setFlash?.(held.id, { notice: true, status: "attention", summary: "This browser was not remembered", body: notRemembered(made.refusal, entry.role, Boolean(ctx.deps.config.readOnly)) });
    return sendJson(ctx.res, 200, { ...kept, remembered: false });
  }
  // Issue #708: the page the link returns to, judged HERE by the page parser (`returnPathOf`), so the browser is only
  // ever sent to one of this console's own pages; anything else, or nothing, lands on the overview. The script checks
  // the answer's shape again before it navigates. Issue #882: a code the host made remembers the browser where it may.
  return startSession(ctx, entry, file, "login-code", { next: realPages.returnPathOf(ctx.body.next) ?? "/" }, { invited: consumed.binding !== undefined, hostMade: consumed.binding === undefined, audit: { kind } });
}

/**
 * Where an approval request came from, as the host's dialog names it: "this computer" for a loopback peer, else the
 * peer's address. Only ever the socket's own address, never a forwarding header a request could write.
 */
function requesterWord(req) {
  const addr = String(req.socket?.remoteAddress ?? "");
  const bare = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  if (bare === "") return "an unknown address";
  return isLoopbackAddress(bare) ? "this computer" : bare;
}

/**
 * Ask the host's desktop to let this browser in (issue #882; approve-dialog.mjs has the why). One request at a time,
 * each spending the sign-in limiter, for the operator tokens only (a viewer is invited, an agent never signs in this
 * way). The answer carries the request's id, a 256-bit secret this browser alone holds and waits on, and the match code
 * the dialog shows too. An unanswered, denied or failed dialog is recorded when it lands (`approvalSettled`).
 */
async function postLoginApprove(ctx) {
  if (rateLimited(ctx, "/login/approve")) return;
  const approvals = ctx.deps.approvals;
  if (!approvals?.available) return sendJson(ctx.res, 404, { error: "this computer cannot show a sign-in dialog; use the code from pi-dispatch-console link, or run pi-dispatch console on the host" });
  const file = tokensOr503(ctx);
  if (!file) return;
  const names = file.tokens.filter((t) => t.role === "operator").map((t) => t.name);
  // 422, not a status the page has a notice for: its own sentence is shown, in the page's "other" notice.
  if (names.length === 0) return sendJson(ctx.res, 422, { error: "this console has no operator token to sign in as; make one with pi-dispatch-console token add" });
  const started = approvals.start({ names, from: requesterWord(ctx.req) });
  if (started.refusal === "busy") {
    ctx.record({ actor: ANONYMOUS, action: "login-approval", target: "/login/approve", outcome: "refused", reason: "a sign-in request was already waiting for an answer" });
    return sendJson(ctx.res, 409, { error: "a sign-in request is already waiting for an answer on this computer; answer or close it, then try again", approve: "busy" });
  }
  if (started.refusal) return sendJson(ctx.res, 404, { error: "this computer cannot show a sign-in dialog right now" });
  return sendJson(ctx.res, 202, { request: started.id, match: started.match, waitSec: Math.round(APPROVAL_WAIT_MS / 1000) });
}

/**
 * Wait for the host's answer: 202 while it is pending, 401 once it is denied, unanswered or failed (or the request is
 * unknown), and an allowed request signs in THIS browser, once, as the operator the dialog named. A host-made
 * credential, so the browser is remembered where a host-made sign-in may be (`hostMade`).
 */
async function postLoginApproveWait(ctx) {
  const approvals = ctx.deps.approvals;
  const id = typeof ctx.body.request === "string" ? ctx.body.request : "";
  const status = approvals ? approvals.status(id) : null;
  if (!status) return sendJson(ctx.res, 401, { error: "that sign-in request is unknown or no longer waiting; ask again", state: "unknown" });
  if (status.state === "pending") return sendJson(ctx.res, 202, { state: "pending" });
  if (status.state !== "allow") {
    const said = { deny: "this computer denied the sign-in", timeout: "no one answered the sign-in on this computer in time", error: "this computer could not show the sign-in dialog" }[status.state] ?? "the sign-in was not allowed";
    return sendJson(ctx.res, 401, { error: said, state: status.state });
  }
  const file = tokensOr503(ctx);
  if (!file) return;
  const taken = approvals.take(id);
  const entry = taken ? file.tokens.find((t) => t.name === taken.name && t.role === "operator") : null;
  if (!entry) {
    ctx.record({ actor: ANONYMOUS, action: "login-approval", target: "/login/approve", outcome: "refused", reason: "the allowed operator token no longer exists" });
    return sendJson(ctx.res, 401, { error: "the operator the dialog allowed is no longer in the tokens file; ask again", state: "unknown" });
  }
  return startSession(ctx, entry, file, "login-approval", { next: realPages.returnPathOf(ctx.body.next) ?? "/" }, { hostMade: true });
}

/**
 * The audit row for an approval that did not sign anyone in (a deny, a dialog left unanswered, one that could not be
 * shown), written when it lands, whether or not the page is still waiting. An allowed one is recorded by `startSession`
 * when its browser collects it. The CLI wires this as the store's `onSettle`.
 */
export function approvalSettled(audit, log) {
  return (request) => {
    if (request.state === "allow") return;
    const reason = { deny: "the host denied the sign-in", timeout: "no one answered the dialog in time", error: "the dialog could not be shown" }[request.state] ?? "not allowed";
    try {
      audit.append({ actor: ANONYMOUS, action: "login-approval", target: "/login/approve", outcome: request.state === "error" ? "failed" : "refused", reason });
    } catch (e) {
      log(`console: audit append failed (${e?.code ?? "error"}) for a sign-in approval that was ${request.state}`);
    }
  };
}

/**
 * Sign out (issue #737): EVERY session the browser presents ends, each the store holds (`readSessionCookies`: a cookie
 * planted beside the real one, `Path=/logout` from another loopback port's page, must not turn the sign-out into a no-op
 * answered 200), and the answer is 200 with the clearing Set-Cookie ALWAYS, also when no session was held (the
 * browser is signed out either way). Since issue #849 that holds for `pdc_session` unless the browser signs out by this
 * console's device cookie and presented no `pdc_session` this console held (see the clearing at the end). It judges nothing, so it needs no tokens file: the route is `auth: "none"`, and
 * the store names who it ended (`destroy`). Behind the session auth it had before, an unreadable tokens file answered
 * sign-out 503 and kept the session, while the page went to sign-in as though it had signed out. The write guards
 * (Origin, JSON) still run first, so no other site can sign a browser out.
 */
async function postLogout(ctx) {
  const { deps, res } = ctx;
  let held = 0;
  const ids = new Set(deps.cookies.readSessionCookies(ctx.req.headers.cookie));
  const cookieIds = new Set(ids);
  // Whether a `pdc_session` this console held came in: see the clearing below.
  let heldCookie = false;
  // Devices this sign-out has already ended through their cookie, so destroying their sessions below does not end them, and write their row, a second time.
  const handled = new Set();
  // Unreadable records whose session this process holds: their failed row is written below, as the person `destroy` names. An anonymous row is rate limited,
  // so a flood of anonymous sign-outs could otherwise keep this one out of the log.
  const unreadableHeld = new Set();
  const deniedHeld = new Map();
  const secrets = deps.devices ? deps.cookies.readDeviceCookies(deps.devices.cookieName, ctx.req.headers.cookie) : [];
  let unerased = false;
  for (const secret of secrets) {
    const hash = deps.devices.hashOf(secret);
    handled.add(hash);
    const read = deps.devices.read(hash);
    // Only a record that exists, and only its true owner's row. A secret nothing holds is treated as no device at all.
    const session = deps.sessions.sessionOfDevice?.(hash);
    if (read.record && !read.record.ended) {
      const done = deps.devices.end(hash, "signed-out");
      if (done.unerased) unerased = true;
      ctx.record({ actor: { name: read.record.name, role: read.record.role, session: null }, action: "device-ended", target: deviceIdOf(hash), outcome: done.unerased ? "failed" : "ok", reason: done.unerased ? unerasedReason(done, "the store could not be written") : "signed out" });
      // After a restart the device has no session here yet, and this is still that person signing out.
      if (!session) {
        held += 1;
        ctx.record({ actor: { name: read.record.name, role: read.record.role, session: null }, action: "logout", outcome: "ok" });
      }
    } else if (read.unjudged) {
      // A record that cannot be read signs nobody in while it stays so, but would let a copy back in once it reads again. A session of this device held here
      // proves the record was real in this process, so that one is refused in memory until it can be ended (`end` denies what it cannot write). A planted
      // secret never has one, so cookies alone cannot grow the deny-list. Said, as a failure, since this sign-out could not be written down.
      unerased = true;
      if (session) {
        deniedHeld.set(hash, deps.devices.end(hash, "signed-out"));
        unreadableHeld.add(hash);
      } else {
        ctx.record({ actor: ANONYMOUS, action: "device-ended", target: deviceIdOf(hash), outcome: "failed", reason: "the record could not be read" });
      }
    }
    if (session) ids.add(session);
  }
  for (const id of ids) {
    // `elsewhere`: the tab that signed out ignores its own stream's end (the script knows it is signing out), and every
    // other tab of this session is told the browser signed out elsewhere.
    const ended = deps.sessions.destroy(id, "elsewhere");
    // A session that was remembered after it signed in: whoever signs out with its old cookie ends the device too, since a browser that remembered it
    // was answered without that cookie.
    if (ended?.deviceHash && unreadableHeld.has(ended.deviceHash)) {
      ctx.record({ actor: { name: ended.name, role: ended.role, session: deps.cookies.sessionDigest(id) }, action: "device-ended", target: deviceIdOf(ended.deviceHash), outcome: "failed", reason: unerasedReason(deniedHeld.get(ended.deviceHash) ?? {}, "the record could not be read") });
    } else if (ended?.deviceHash && deps.devices && !handled.has(ended.deviceHash)) {
      const done = deps.devices.end(ended.deviceHash, "signed-out");
      if (done.unerased) unerased = true;
      // Its record may be unreadable or unwritable: this sign-out came with no device cookie to read it by, so the reason names neither.
      ctx.record({ actor: { name: ended.name, role: ended.role, session: deps.cookies.sessionDigest(id) }, action: "device-ended", target: deviceIdOf(ended.deviceHash), outcome: done.unerased ? "failed" : "ok", reason: done.unerased ? unerasedReason(done, "the record could not be ended") : "signed out" });
    }
    deps.actionDeps?.setup?.endSession?.(id);
    deps.tickets?.endSession?.(id);
    // The session's open streams end now, not at the hub's next tick.
    deps.hub?.endSession(id, "elsewhere");
    // Signing out is never refused: a failed audit append is logged, and the session is gone either way. Each row names
    // a session the store held.
    if (ended) {
      held += 1;
      if (cookieIds.has(id)) heldCookie = true;
      ctx.record({ actor: { name: ended.name, role: ended.role, session: deps.cookies.sessionDigest(id) }, action: "logout", outcome: "ok" });
    }
  }
  // Nothing held: the anonymous kind of row, rate limited like the others.
  if (held === 0) ctx.record({ actor: ANONYMOUS, action: "logout", target: "/logout", outcome: "ok", reason: "no session was held, so only the cookie was cleared" });
  // `pdc_session` is one name for every console on this host, since cookies ignore ports. A browser signing out of this console by its own device cookie,
  // with no `pdc_session` this console held, may carry another loopback console's ordinary session under that name, which this sign-out must not end
  // (issue #849). Without a device cookie it is cleared as it always was.
  const clearSession = secrets.length === 0 || heldCookie;
  const clears = [...(clearSession ? [deps.cookies.clearSessionCookie()] : []), ...(deps.devices ? [deps.cookies.clearDeviceCookie(deps.devices.cookieName)] : [])];
  return sendJson(res, 200, { ok: true, ...(unerased ? { device: "unerased" } : {}) }, { "set-cookie": clears.length === 1 ? clears[0] : clears });
}

/**
 * Remember this browser, after signing in (issue #849). A one-time link posts itself with no moment to tick a box, so this is how such a sign-in is remembered. Only soon
 * after a credential was presented: a stolen ordinary cookie must not be able to make itself permanent later. Converts the live session in place, so its tickets and streams carry on.
 */
async function postRememberDevice(ctx) {
  const { deps, session } = ctx;
  const refuse = (status, why) => {
    ctx.record({ actor: ctx.actor(), action: "refused", target: ctx.route.path, outcome: "refused", reason: why });
    return sendError(ctx.res, status, why);
  };
  if (!deps.devices) return refuse(403, "remembering a device is not available on this console");
  if (!rememberTransportOk(ctx)) return refuse(403, "this console is reached over plain HTTP, where a remembered sign-in would cross the network");
  const read = deps.readTokens();
  if (!read?.file) return sendJson(ctx.res, 503, { error: TOKENS_UNUSABLE });
  // Judged again now the body has arrived: the session was judged before it was read, and a slow body must not outlast a sign-out or `sessions end-all`.
  const live = deps.sessions.get(session.id, read.file);
  if (!live) return refuse(401, "this sign-in has ended; sign in again");
  if (!REMEMBER_ROLES.includes(live.role)) return refuse(403, "this token cannot be remembered on a device");
  if (live.deviceHash) return sendJson(ctx.res, 200, { ok: true, remembered: true });
  if (live.invited) return refuse(403, "a sign-in from an invitation cannot be remembered; ask for a token of your own");
  if (deps.now() - live.createdAt > REMEMBER_FRESH_MS) return refuse(403, "this sign-in is too old to be remembered; sign in again and remember it then");
  const entry = read.file.tokens.find((t) => t.sha256 === live.tokenHash && t.role === live.role);
  if (!entry) return refuse(403, "this sign-in's token has changed; sign in again");
  const made = rememberOnto(ctx, session.id, entry, read.file, typeof ctx.consoleOrigin === "string" && ctx.consoleOrigin.startsWith("https://"));
  if (made.refusal === "full") return sendError(ctx.res, 409, deps.config.readOnly ? `this sign-in already has ${MAX_DEVICES_PER_NAME} remembered browsers, the most it may have; this console is read-only, so sign out on one you no longer use, or remove one with pi-dispatch-console device revoke on the host` : live.role === "operator" ? `this sign-in already has ${MAX_DEVICES_PER_NAME} remembered browsers, the most it may have; remove one on Remembered browsers first` : `this sign-in already has ${MAX_DEVICES_PER_NAME} remembered browsers, the most it may have; sign out on one you no longer use, or ask an operator to remove one`);
  if (!made.cookie) return sendError(ctx.res, 503, "this device could not be remembered; you stay signed in as before");
  return sendJson(ctx.res, 200, { ok: true, remembered: true }, { "set-cookie": [made.cookie, deps.cookies.clearSessionCookie()] });
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
    // Saved flow estimates must keep answering after Spend and Breakdown became separate pages.
    if (name === "insights" && parsed.query.whatif && parsed.query.flow) {
      return redirect(ctx.res, `/insights/breakdown?${ctx.searchParams.toString()}`);
    }
    const { pages, pageDeps, config } = ctx.deps;
    const data = await pages.loadPageData(name, parsed.query, pageDeps, { role: ctx.session.role, readOnly: Boolean(config.readOnly) });
    ctx.flash = ctx.req.method === "GET" && data?.readFailed !== true ? ctx.deps.sessions.takeFlash?.(ctx.session.id) ?? null : null;
    // Issue #849: the offer is taken by a page drawn for a person (never a HEAD) on a transport where remembering would be allowed.
    const offer = ctx.req.method === "GET" && ctx.deps.sessions.takeOffer?.(ctx.session.id, REMEMBER_FRESH_MS) === true && rememberableHere(ctx.deps, ctx.req);
    const out = await pages.renderPage(name, {
      query: parsed.query,
      // `remembered` is the device's short id, never its hash: the bar says the browser is remembered and the devices page marks it. `invited`: an
      // invitation's sign-in, which can never be remembered, so the devices page says that rather than how.
      session: { name: ctx.session.name, role: ctx.session.role, remembered: ctx.session.deviceHash ? deviceIdOf(ctx.session.deviceHash) : null, ...(ctx.session.invited ? { invited: true } : {}) },
      offer,
      // Whether this browser could be remembered from here, so a page never tells a person to tick a box the sign-in page does not draw.
      rememberable: rememberRefusalHere(ctx.deps, ctx.req) ?? true,
      data,
      readOnly: Boolean(config.readOnly),
      restart: restartNoticeOf(ctx.deps),
      theme: themeOf(ctx.req.headers.cookie),
      flash: ctx.flash,
      maxStreams: config.maxStreams,
    });
    return sendHtml(ctx.res, out?.status ?? 200, out?.html ?? "");
  };
}

/**
 * The sign-in page's address for a person who asked for a page and is not signed in (issue #849): why they are here, and where they were
 * going, so signing in with a token on that page returns them there. Only what the page parser accepts is ever a `next`, and `/` is left out because it is where
 * a sign-in lands anyway.
 */
export function loginHref(ended, next) {
  const query = new URLSearchParams();
  if (ended) query.set("ended", ended);
  if (next && next !== "/") query.set("next", next);
  const text = query.toString();
  return text === "" ? "/login" : `/login?${text}`;
}

/**
 * The sign-in page (issue #737). `?ended=` selects the notice for why the last session ended, only when it is given once
 * and is exactly a member of `ENDED_REASONS`; anything else (two of them, another word, another parameter) is no
 * notice. `?next=` is the one other parameter read, and it reaches the page only once the page parser accepts it. The limits are this console's own, so the idle and longest-life
 * sentences state what it runs with; the footer follows how it listens (see `listenWord`).
 */
function getLogin(ctx) {
  const { config } = ctx.deps;
  const notice = loginNoticeOf(ctx.searchParams);
  const next = realPages.returnPathOf(ctx.searchParams.get("next")) ?? undefined;
  // `SameSite=Strict` withholds the cookie on a navigation that starts on another site (a link in GitHub or a mail), so a signed-in browser
  // arrives here looking signed out. The page's own same-origin fetch does carry the cookie, so the script asks. Exactly `cross-site`, the one
  // arrival that lost its cookie: a person who came here on purpose (to use a token, or as someone else) must see the form, a bookmark (`none`) sent
  // the cookie anyway, browsers send no header at all to a plain-HTTP name, and an `ended` notice must stay on screen. REJECTED: `SameSite=Lax`,
  // which would give up what `Strict` protects for every other request.
  const arrival = notice === null && ctx.req.headers["sec-fetch-site"] === "cross-site";
  const idleMinutes = Number.isSafeInteger(config.idleMs) ? Math.floor(config.idleMs / 60000) : undefined;
  const maxHours = Number.isSafeInteger(config.maxMs) ? Math.floor(config.maxMs / 3600000) : undefined;
  return sendHtml(ctx.res, 200, loginPage({ theme: themeOf(ctx.req.headers.cookie), notice, limits: { idleMinutes, maxHours }, listen: listenWord(config), next, arrival, remember: rememberableHere(ctx.deps, ctx.req), approve: Boolean(ctx.deps.approvals?.available) }));
}

/** The sign-in page's `ended` notice from its query: exactly one `ended`, a member of `ENDED_REASONS`, else null. */
export function loginNoticeOf(searchParams) {
  const given = searchParams instanceof URLSearchParams ? searchParams.getAll("ended") : [];
  return given.length === 1 ? endedReasonOf(given[0]) : null;
}

/**
 * How the console listens, as the sign-in footer words it: `unix` for a unix socket, `localhost` for 127.0.0.1 or ::1
 * (issue #882: the address every command prints as `localhost`), `tcp` for another loopback address, and `public` for
 * an address that is not loopback (PI_CONSOLE_BIND_PUBLIC=1), where saying "loopback only" would be untrue. The
 * loopback test is the listener's own (`isLoopbackAddress`; `parseListen` refuses a hostname, so the host is always a
 * literal), so the footer and the bind cannot disagree about what loopback is. Every rule but the footer's reads only
 * whether this is `public`.
 */
function listenWord(config) {
  const listen = config?.listen;
  if (listen?.kind === "unix") return "unix";
  if (listen?.kind === "tcp" && typeof listen.host === "string" && !isLoopbackAddress(listen.host)) return "public";
  if (listen?.kind === "tcp" && typeof listen.host === "string" && isLocalhostAddress(listen.host)) return "localhost";
  return "tcp";
}

/** What a request gets when its remembered device cannot be judged. Nothing was signed out. */
export const DEVICE_STORE_UNUSABLE = "this browser's remembered sign-in could not be checked; sign in with a link or a token";

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
    ...(a.name.startsWith("setup-") ? [{ method: "POST", path: `/api/act/${a.name}/cancel`, auth: "operator", write: true, action: a.name, handler: ctx => cancelAction(ctx, a) }] : []),
  ]);
}

/** A hypothetical delivery is a read. POST keeps comment text out of URLs and browser history; it still meets the
 * same origin, JSON, size and session-person guards as a write, without creating a ticket or an audit row. */
async function postTriggerCheck(ctx) {
  if ([...ctx.searchParams].length) return sendError(ctx.res, 400, "the trigger check takes no query parameters");
  if (typeof ctx.deps.pageDeps?.triggerCheck !== "function") return sendError(ctx.res, 503, "the trigger check is not available in this console");
  let result;
  try {
    result = await ctx.deps.pageDeps.triggerCheck(ctx.body);
  } catch {
    return sendError(ctx.res, 503, "the trigger check could not read its inputs; reload and try again");
  }
  return sendJson(ctx.res, result?.refusal ? 400 : 200, { html: String(renderTriggerCheckResult(result)) });
}

/**
 * The route table. `write: true` means: Origin and Sec-Fetch-Site checked, JSON only, body read and bounded, refusals
 * audited. `readOnlyExempt` is for signing in and out only: a read-only console still has to let people in.
 * `readJson: true` is the event check: a viewer read sent as JSON, with the same Origin and body guards but no write,
 * ticket or audit side effect. It remains usable on a read-only console. `anyHost` (issue #737) is for the public
 * files alone, the script, the stylesheet and the favicon: they answer before the Host
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
  // Issue #882: the sign-in page's Sign-in code field. The same handler as the link page's; its own path picks the sign-in page's notices.
  { method: "POST", path: "/login/typed-code", auth: "none", write: true, readOnlyExempt: true, handler: postLoginCode },
  { method: "POST", path: "/login/approve", auth: "none", write: true, readOnlyExempt: true, handler: postLoginApprove },
  { method: "POST", path: "/login/approve/wait", auth: "none", write: true, readOnlyExempt: true, handler: postLoginApproveWait },
  // `auth: "none"` (issue #737): a sign-out judges no session, it ends the one the cookie names (`postLogout`), so an
  // unreadable tokens file cannot keep a browser signed in that asked to sign out.
  { method: "POST", path: "/logout", auth: "none", write: true, readOnlyExempt: true, handler: postLogout },
  // Issue #849: for the same reason a sign-in is exempt. It changes only this browser's credential, and a read-only console must still let someone stay signed in.
  { method: "POST", path: "/api/device/remember", auth: "viewer", write: true, readOnlyExempt: true, handler: postRememberDevice },
  // Public generic shells recover the Strict cookie with a same-origin request, without replacing the sign-in.
  ...["launch", "authorize", "return", "select"].map((mode) => ({ method: "GET", path: `/sandbox/gateway/${mode}`, auth: "none", write: false, handler: (ctx) => sendHtml(ctx.res, 200, gatewayLanding({ mode, theme: themeOf(ctx.req.headers.cookie), gesture: ctx.req.headers["sec-fetch-site"] !== "same-origin" })) })),
  ...["launch", "context", "authorize"].map((method) => ({ method: "POST", path: `/api/sandbox-gateway/${method}`, auth: "operator", write: true, handler: (ctx) => { ctx.gatewayTheme = themeOf(ctx.req.headers.cookie); return gatewayApi(ctx, method); } })),
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
  { method: "GET", path: "/api/sandbox-hosts", auth: "operator", write: false, handler: (ctx) => {
    const result = ctx.deps.pageDeps?.sandboxes?.hosts();
    if (!result?.config) return sendError(ctx.res, 503, result?.refusal ?? "The terminal host configuration could not be read.");
    return sendJson(ctx.res, 200, result.config, { "content-disposition": 'attachment; filename="sandbox-hosts.json"' });
  } },
  { method: "GET", path: "/api/state", auth: "viewer", write: false, handler: getState },
  { method: "POST", path: "/api/trigger-check", auth: "viewer", write: false, readJson: true, handler: postTriggerCheck },
  // Issue #647: one run and the chat it can have (`run-api.mjs`); a viewer's, since the answer carries no text at all.
  { method: "GET", path: "/api/fork-points", auth: "operator", write: false, handler: getForkPoints },
  { method: "GET", path: "/api/watch-trace", auth: "operator", write: false, handler: getWatchTrace },
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
 * A request's remembered device (issue #849), judged. SYNCHRONOUS, all of it: the read, the judgement, the one-session-per-device lookup and the audit row, so tabs
 * arriving together after a restart share one session without a lock (`device-trust.mjs`).
 *
 * `{session}` for a live one, `{unjudged}` when the store cannot say, `{auditRefused}` when the row could not be written, `{dead, ended}` otherwise. A record that has
 * stopped matching the tokens file is ended durably here, with the true reason.
 */
function resolveDevice(deps, secret, file, { read: readRoute = true } = {}) {
  const trust = deps.devices;
  const hash = trust.hashOf(secret);
  const read = trust.read(hash);
  if (read.unjudged) {
    // An unreadable record must not hide what the tokens file already proves: a session of this device still in memory is judged by it first.
    const held = deps.sessions.sessionOfDevice?.(hash);
    const verdict = held ? deps.sessions.verdict(held, file) : null;
    if (verdict?.ended && ["all", "role", "revoked"].includes(verdict.ended)) {
      dropDeviceSession(deps, hash, verdict.ended);
      return { dead: true, ended: verdict.ended, hash };
    }
    return { unjudged: true };
  }
  const dead = (ended) => {
    dropDeviceSession(deps, hash, ended);
    return { dead: true, ended, hash };
  };
  if (read.denied || read.absent) return dead("device");
  const { record, mtimeMs } = read;
  if (record.ended) return dead(ENDED_OF_DEVICE_REASON[record.ended.reason] ?? "device");
  // No browser keeps the cookie this long, and an active one moves last-use daily, so what is presented now is a copy.
  if (deps.now() - mtimeMs > DEVICE_COOKIE_MAX_AGE_SEC * 1000) {
    endAtUse(deps, hash, record, "removed", "unused for longer than any browser keeps the cookie");
    return dead("device");
  }
  const failure = bindingFailure(record, file);
  if (failure) {
    endAtUse(deps, hash, record, failure, "its token entry no longer matches");
    return dead(ENDED_OF_DEVICE_REASON[failure]);
  }
  const made = deps.sessions.ensureDevice({ deviceHash: hash, name: record.name, role: record.role, tokenHash: record.tokenHash, generation: record.generation });
  if (made.created) {
    try {
      deps.audit.append({ actor: { name: record.name, role: record.role, session: deps.cookies.sessionDigest(made.id) }, action: "login-device", outcome: "ok" });
    } catch (e) {
      deps.sessions.destroy(made.id, null);
      deps.log(`console: audit append failed (${e?.code ?? "error"}), so the remembered sign-in was refused`);
      return { auditRefused: true };
    }
  }
  const session = deps.sessions.get(made.id, file);
  if (!session) return { unjudged: true };
  // Last use moves at most daily, and only on a request whose answer can carry the re-set cookie: a stream or a write that moved it would spend the day's
  // re-set, and a dashboard whose stream reconnects first every morning would never have its cookie renewed.
  return { session, ...(readRoute && trust.touch(hash, mtimeMs) ? { renew: secret } : {}) };
}

/**
 * A device found dead loses the session it had in this process, with the same clean-up a session that ends gets: setup, tickets and its open streams. Given
 * `res`, a sign-in's answer, the streams end once it has gone out, as `startSession` ends the browser's ordinary session's: ended first, the other tabs
 * would probe before the new cookie arrived.
 */
function dropDeviceSession(deps, hash, ended, res = null) {
  const id = deps.sessions.sessionOfDevice?.(hash);
  if (!id) return;
  deps.sessions.destroy(id, null);
  deps.actionDeps?.setup?.endSession?.(id);
  deps.tickets?.endSession?.(id);
  const word = streamEndOf(ended) ?? "device";
  if (res) res.once("finish", () => deps.hub?.endSession(id, word));
  else deps.hub?.endSession(id, word);
}

/** An unerased end's audit reason: what failed, and whether this process holds the refusal (`end` says `held`: the in-memory list is bounded). */
function unerasedReason(done, failed) {
  return `${failed}; ${done.held === false ? "this console could not hold it either, so revoke it" : "refused in memory until this console stops"}`;
}

/** End a device met at its next use, with a row saying why, so the audit log explains every end. A row that cannot be written is logged, never a refusal: the end is what protects. */
function endAtUse(deps, hash, record, reason, why) {
  const done = deps.devices.end(hash, reason);
  try {
    deps.audit.append({ actor: { name: record.name, role: record.role, session: null }, action: "device-ended", target: deviceIdOf(hash), outcome: done.unerased ? "failed" : "ok", reason: why });
  } catch (e) {
    deps.log(`console: a device ended at its next use, but its audit row could not be written (${e?.code ?? "error"})`);
  }
}

/**
 * The session behind the request's cookie. Reads the tokens file each time, so a rotate or revoke bites at once. A
 * remembered device's cookie is judged first (`resolveDevice`), and a dead or unjudged device yields to a live ordinary
 * session, so a browser that signed in again is not bounced back to sign-in.
 *
 *   - `{session}`: a live one (its `lastSeen` moved, by `get`).
 *   - `{session: null, presented, ended}`: none. `presented` says a well-formed cookie came in (so there is one to
 *     clear); `ended` is why that id no longer signs in (`endedOf`, asked after `get` refused it, so a session `get`
 *     just ended reads its own reason), held to `ENDED_REASONS`, else null. No cookie reads no file: there is nothing
 *     to judge, and the sign-in page it is sent to answers for the file itself.
 *   - `{unavailable: true}`: a cookie came in and the tokens file cannot be used, so nothing can be judged and nothing
 *     is ended (no `get`, no tombstone, the session kept for when the file reads again).
 *   - `{deviceStore: true}`: only a device cookie, whose record cannot be read: nothing is ended, the cookie is kept.
 *   - `{auditRefused: true}`: a device restore whose sign-in row could not be written.
 */
function resolveSession(deps, req, { read: readRoute = true } = {}) {
  const id = deps.cookies.readSessionCookie(req.headers.cookie);
  const secret = deps.devices ? deps.cookies.readDeviceCookie(deps.devices.cookieName, req.headers.cookie) : null;
  if (!id && !secret) return { session: null, presented: false, ended: null };
  const read = deps.readTokens();
  if (!read?.file) return { unavailable: true };
  if (secret) {
    const device = resolveDevice(deps, secret, read.file, { read: readRoute });
    if (device.session || device.auditRefused) return device;
    // A live ordinary session outranks a device that is dead or cannot be judged: that browser signed in again and must not be bounced back to sign-in.
    const session = id ? deps.sessions.get(id, read.file) ?? null : null;
    // Never a device's own session by its old `pdc_session`, whatever device cookie came with it.
    if (session && !session.deviceHash) return { session };
    if (device.unjudged) return { deviceStore: true };
    return { session: null, presented: true, clearDevice: true, ended: endedReasonOf(device.ended) };
  }
  const session = deps.sessions.get(id, read.file) ?? null;
  // A remembered device's session is reached by its device cookie and never by a `pdc_session`: the id it had before it was remembered would otherwise
  // be a copy that no longer times out (issue #849).
  if (session?.deviceHash) return { session: null, presented: true, ended: null };
  if (session) return { session };
  // A device's session whose record cannot be read is still held (`get` ended nothing), so its tickets and setup state stay with it: refused here, as above.
  if (deps.sessions.verdict?.(id, read.file)?.unjudged === true) return { session: null, presented: true, ended: null };
  deps.actionDeps?.setup?.endSession?.(id);
  deps.tickets?.endSession?.(id);
  return { session: null, presented: true, ended: endedReasonOf(deps.sessions.endedOf?.(id) ?? null) };
}

/** Read and parse a guarded JSON body: `{body}`, or `{status, sentence}` for 413 or 400. */
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

  if (route.write || route.readJson) {
    ctx.consoleOrigin = deps.consoleOrigin?.() ?? null;
    const checks = [
      ["origin", originRefusal(req.headers, { expectedOrigin: ctx.consoleOrigin })],
      ["content-type", contentTypeRefusal(req.headers)],
      ["read-only", !route.write || route.readOnlyExempt ? null : readOnlyRefusal(deps.config)],
    ];
    for (const [guard, refusal] of checks) {
      if (refusal) {
        if (route.write) record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: `${guard}: ${refusal}` });
        return sendError(res, 403, refusal);
      }
    }
  }

  if (route.auth !== "none") {
    const resolved = resolveSession(deps, req, { read: !route.write && !route.stream });
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
    if (resolved.auditRefused) return sendError(res, 500, "the audit log could not be written, so the sign-in was refused; check the console's log directory");
    if (resolved.deviceStore) {
      // Nothing was judged, so nothing ends, and the cookie stays for when the store reads again.
      if (route.write) record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: "auth: the remembered-device store cannot be used" });
      if (route.write || route.path.startsWith("/api/")) return sendJson(res, 503, { error: DEVICE_STORE_UNUSABLE, ended: "device-store" });
      return redirect(res, loginHref("device-store", realPages.returnPathOf(req.url)));
    }
    ctx.session = resolved.session;
    if (resolved.renew && !route.write && !route.stream) {
      // At most daily, and never in a way that could drop `Secure` from a cookie that has it (`renewSecureOf`).
      const secure = renewSecureOf(ctx);
      if (secure !== null) res.setHeader("set-cookie", deps.cookies.deviceCookie(deps.devices.cookieName, resolved.renew, { secure }));
    }
    if (!ctx.session) {
      const { presented, ended, clearDevice } = resolved;
      if (route.write) record({ actor: ANONYMOUS, action: "refused", target: route.path, outcome: "refused", reason: "auth: not signed in" });
      // No Set-Cookie (see the header): the probe that follows a closed stream must still carry this cookie to read why,
      // and must never clear a newer one another tab's sign-in set meanwhile.
      if (route.write || route.path.startsWith("/api/")) return sendJson(res, 401, { error: SIGN_IN_FIRST, ended });
      // `ended` is a member of `ENDED_REASONS` or null (resolveSession held it to the list), and never `switched`, which no tombstone
      // holds. A request with no cookie has nothing to clear. The page asked for goes along as `next` once the page parser accepts it.
      const clears = [...(presented && deps.cookies.readSessionCookie(req.headers.cookie) ? [deps.cookies.clearSessionCookie()] : []), ...(clearDevice ? [deps.cookies.clearDeviceCookie(deps.devices.cookieName)] : [])];
      return redirect(res, loginHref(ended, realPages.returnPathOf(req.url)), clears.length === 0 ? {} : { "set-cookie": clears.length === 1 ? clears[0] : clears });
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
    // An agent reaches only the action policy, never an operator-only read route. The policy checks
    // the exact planned delta and rechecks it when the session-bound ticket is redeemed.
    const role = ctx.session.role === "agent" && route.action ? null : roleRefusal(ctx.session, route.auth);
    if (role) {
      if (route.write) record({ actor: actorOf(ctx), action: "refused", target: route.path, outcome: "refused", reason: `role: ${role}` });
      return sendFailure(ctx, 403, role, { page: { kind: "operators-only" } });
    }
  }

  if (route.write || route.readJson) {
    const read = await readBody(req);
    if (!read.body) {
      // Audited like every other refusal of a write: the signed-in session's own row (a valid session is needed, so no
      // anonymous flood), or a rate-limited anonymous one for a sign-in. The row names the fixed sentence, never a byte
      // of the body.
      if (route.write) record({ actor: actorOf(ctx), action: "refused", target: route.path, outcome: "refused", reason: `body: ${read.sentence}` });
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
 *   - `readTokens()` -> `{file}` | `{refusal}`; `findToken(file, presented)` -> entry | null; `keptTokens(file)` -> the
 *     entries the file keeps for a role this console does not know (issue #761), which a login code's refusal names
 *     (default: the tokens module's own, a pure read of the file it is handed, so a caller that leaves it out still
 *     answers a kept name's code 401 with its row, never a 500).
 *   - `sessions`: `create`, `get(id, file)`, `peek(id, file)` (the 404 and 405 pages' bar), `destroy(id, reason)`
 *     (`elsewhere` or null; it answers who it ended, `{name, role}`, or null, which the sign-out's audit row names),
 *     `endedOf(id)` (why a refused cookie's session ended), and the flash, `setFlash(id,
 *     change)` (the action table's) and `takeFlash(id)` (a page GET's); `verdict(id, file)` is the hub's, read through
 *     the CLI; `streamAcquire(id)` and `streamRelease(id)` the streams'.
 *   - `cookies`: `sessionCookie(id, {maxAgeSec, secure})`, `clearSessionCookie()`, `readSessionCookie(header)` (the one session a
 *     request runs as), `readSessionCookies(header)` (every one a sign-out ends), `sessionDigest(id)`.
 *   - `consumeLoginCode(code)` -> `{name}` | `{refusal, kind?}`, `kind` being `expired` when the code alone shows that (the CLI binds the codes directory, fs and clock).
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
 *   - issue #845: `restartNotice()` (default: none), whether this console needs a restart (`restart-notice.mjs`'s watch's
 *     `current`), drawn as a banner on every page and every error page drawn with the navigation bar.
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
  keptTokens = realKeptTokens,
  consumeLoginCode,
  writePauseWindows,
  actionDeps = null,
  pages = realPages,
  pageDeps = null,
  hub = null,
  stateOf = defaultStateOf,
  errorPage = realErrorPage,
  limits: limitsOverride = {},
  gateway = null,
  consoleOrigin = null,
  devices = null,
  restartNotice = null,
  approvals = null,
}) {
  const limits = { ...SERVER_LIMITS, streamsTotal: STREAMS_TOTAL_MAX, streamsOperatorReserve: STREAMS_OPERATOR_RESERVE, ...limitsOverride };
  const refusalRows = makeLoginLimiter({ now, perMinute: REFUSAL_ROWS_PER_MINUTE, burst: 2 * REFUSAL_ROWS_PER_MINUTE });
  const deps = { devices, config, fs, now, random, audit, sessions, cookies, tickets, limiter, log, readTokens, findToken, keptTokens, consumeLoginCode, writePauseWindows, actionDeps, refusalRows, quieted: { count: 0 }, pages, pageDeps, hub, stateOf, errorPage, limits, streams: { open: 0 }, gateway, consoleOrigin, restartNotice, approvals };
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
  server.once("close", () => { actionDeps?.setup?.close?.(); tickets?.close?.(); gateway?.close?.(); });
  server.maxConnections = limits.maxConnections;
  return server;
}
