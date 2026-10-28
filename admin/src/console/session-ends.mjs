/**
 * Why a session ended, and what the sign-in page says about it (issues #737 and #711). One closed list, read by the
 * server (the `/login?ended=` redirect and the 401 bodies), the live hub (the stream's `end` event) and the browser
 * script (which navigates to `/login?ended=` only with a reason it finds here), so the three can never disagree.
 *
 * A REASON IS NEVER ECHOED. `endedReasonOf` and `streamEndOf` answer a member of their list or null, compared byte for
 * byte (no trim, no case fold), so a query string or an event's data can select one of these sentences and nothing
 * else: a link someone crafts can only pick from the console's own words.
 *
 * `restart` is a possibility, never a claim: the server reaches it only for a well-formed session id it does not know,
 * while it has been up for less than a session's longest life and has forgotten no tombstone, and the sentence says
 * "may have". A stream never ends with it (this process opened every stream it ends), so `STREAM_ENDS` holds
 * `shutdown` in its place: the console stopping, which the page treats as a connection to wait for, not a sign-out.
 *
 * `switched` is the page's own (issue #737): a page acts only as the person it was drawn for, and
 * one that finds this browser signed in as someone else (its probe's answer names another person, or the server
 * refused a request the page made as its own person) goes to `/login?ended=switched` rather than act for them. No
 * session ENDED for it, so the server never writes it as a tombstone (`sessions.mjs` `destroy` takes `elsewhere` or
 * nothing) and a stream never ends with it. (Not `other`, the obvious word: that is a sign-in
 * refusal's kind below, and the two lists share no name, so `signin.mjs` can take either kind of notice as one word.)
 *
 * A pure leaf: it imports nothing, so the server, the hub and the script's build can all take it. The statuses are
 * `words.mjs`'s `STATUS_KINDS` and the icons the sprite's names; a test holds both.
 */

/** Why a session ended, as the server and the sign-in page know it, and `switched`, which only the page says (see the header). */
export const ENDED_REASONS = Object.freeze(["idle", "max", "revoked", "role", "all", "elsewhere", "restart", "switched"]);

/** The stream's word for the console stopping: the page keeps itself and waits, it is not signed out. */
export const STREAM_SHUTDOWN = "shutdown";

/** What a stream's `end` event may carry: the reasons a live session can end for, and the console stopping. */
export const STREAM_ENDS = Object.freeze(["idle", "max", "revoked", "role", "all", "elsewhere", "shutdown"]);

/**
 * How a page's requests say the person it was drawn for (`<name>.<role>`, see `switched` above and `server.mjs`): its
 * event streams in this query parameter (an EventSource can send no header), which no page's own query takes, and its
 * previews and confirms in this header. Here, beside `switched`, so the server that judges them and the script that sends
 * them take the one spelling.
 */
export const PERSON_PARAM = "as";
export const PERSON_HEADER = "x-console-as";

/** `v` when it is exactly one of `ENDED_REASONS`, else null. Never the input's own bytes otherwise. */
export function endedReasonOf(v) {
  return typeof v === "string" && ENDED_REASONS.includes(v) ? v : null;
}

/** `v` when it is exactly one of `STREAM_ENDS`, else null. */
export function streamEndOf(v) {
  return typeof v === "string" && STREAM_ENDS.includes(v) ? v : null;
}

/** A frozen notice: the status it is drawn in, its icon, a title and a sentence of what to do. */
const notice = (status, icon, title, body) => Object.freeze({ status, icon, title, body });

/**
 * The sign-in page's sentence for each reason, built for this console's own limits (`idleMinutes`, `maxHours`), so
 * the page states the limits it runs with rather than the defaults.
 */
export function endedNotices({ idleMinutes = 60, maxHours = 12 } = {}) {
  return Object.freeze({
    idle: notice("idle", "clock", `You were signed out after ${idleMinutes} minutes without a request`, "An open live tab does not count. Sign in again to carry on."),
    max: notice("idle", "hourglass", `You were signed out after ${maxHours} hours`, "That is the longest a session lasts. Sign in again."),
    revoked: notice("attention", "slot-held", "Your token was revoked or rotated", "Ask an operator for a new token, or make a link from pi."),
    role: notice("idle", "shield", "Your role changed, so you were signed out", "Sign in again to carry on with your new role."),
    all: notice("idle", "logout", "An operator ended every session", "Sign in again. Your token still works."),
    elsewhere: notice("idle", "logout", "This browser signed out in another tab", "Sign in again to carry on here."),
    restart: notice("idle", "rerun", "This console no longer knows this sign-in; it may have restarted", "Sign in again."),
    switched: notice("attention", "key", "This browser is now signed in as someone else", "Another tab signed this browser in with a different token, so this page stopped rather than act for that sign-in. Sign in again to carry on as yourself."),
  });
}

/**
 * Why a sign-in was refused, or could not be tried. `other` carries the server's own `error` sentence as its body,
 * set by the script through `textContent`. A command or a name in a body is written in backticks, which the page draws
 * in the code face (`kit.mjs` `withCode`); the `other` body is text the script sets, and never passes through that.
 *
 * NO NOTICE FOR A USED LINK. A link's own refusal (the 401 of `/login/code`) is said by the link page's `used` state,
 * whole ("This sign-in link is used, expired or unknown", with the commands for a new one), and `/login` never answers a
 * link (its 401 is `wrong`), so a `link` notice was drawn on the sign-in page and never shown. `NOTICE_OF_STATUS` maps that 401 to no notice instead.
 */
export const SIGN_IN_NOTICES = Object.freeze({
  wrong: notice("failed", "failed", "That token is not valid for this console", "Check that you copied all of it, or make a new one."),
  rate: notice("attention", "clock", "Too many sign-in attempts", "Wait a minute and try again."),
  tokens: notice("failed", "config", "The console's tokens file cannot be used right now", "An operator should run `pi-dispatch doctor` on the host."),
  audit: notice("failed", "audit", "The audit log could not be written, so the sign-in was refused", "Check the console's log directory. Nothing else changed."),
  unreachable: notice("attention", "beat", "Console not reachable, retrying", "This page stays as it is. Retrying every 2 seconds."),
  other: notice("failed", "failed", "The console refused the sign-in", ""),
});

/**
 * Which sign-in notice an HTTP status from each sign-in route selects, or null for none: the link page's 401 is its
 * `used` state alone (see `SIGN_IN_NOTICES`). The script hides every notice for a null, and shows `other` with the
 * server's sentence for a status that is not listed.
 */
export const NOTICE_OF_STATUS = Object.freeze({
  "/login": Object.freeze({ 401: "wrong", 429: "rate", 503: "tokens", 500: "audit" }),
  "/login/code": Object.freeze({ 401: null, 429: "rate", 503: "tokens", 500: "audit" }),
});
