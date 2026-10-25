/**
 * The console's one browser script, served from `/static/console.js` (issue #640). A string module rather than a file
 * beside the bundle: `dist/console.mjs` ships as one file, and a script read from disk at runtime would need a second
 * artifact the bundle could lose. The CSP's `script-src 'self'` accepts it because it arrives from a URL on this
 * origin; nothing here is ever inlined into a page.
 *
 * EVERY STATE IS THE SERVER'S MARKUP (issue #737). Each sign-in notice, link-page state, live note, the
 * confirm slot's previewing skeleton and the kept-still note is drawn by the server, hidden but the one it chose; the
 * preview, no-change, refusal and bulk-result bars come as `html` in the JSON answer. This script only says which shows
 * (`hidden`), writes text through `textContent`, sets attributes, and moves the one confirm slot. So every state can be
 * pinned as a golden and measured by the width check, and `console-client-states.test.mjs` holds that the script shows
 * the right one. The closed lists it switches on are written in as JSON from their one source (`session-ends.mjs`,
 * `confirm-view.mjs`, `shell.mjs` `LIVE_NOTES`), never copied. Three sentences are this script's own, exported from
 * this module and written in the same way (issue #737): the sign-in's `gaveup` notice (a copy of the
 * server's `unreachable` notice with `SIGN_IN_GAVE_UP` as its text), the sign-out that was not confirmed
 * (`SIGN_OUT_UNCONFIRMED`, a small banner built with `createElement` and `textContent`, its tile holding a copy of the
 * sign-out button's own icon, as every server banner has its tile) and the stale note's tokens-file sentence
 * (`STALE_TOKENS_BODY`, its command in the code face as `kit.mjs` `withCode` draws a backticked run, built as nodes).
 * Each is text through `textContent` or `createTextNode`, never markup.
 *
 * A PAGE ACTS ONLY AS THE PERSON IT WAS DRAWN FOR (issue #737): the top bar's `.who` carries the session's `data-name`
 * and `data-role`, and every request this script makes on the session's behalf says that person (`<name>.<role>`): both
 * event streams in the `as` query parameter, every preview and confirm in the `x-console-as` header (`session-ends.mjs`
 * `PERSON_PARAM`, `PERSON_HEADER`). The server refuses a request whose person is not the cookie's session (a stream
 * 401, a write 409 with the bar's own refusal), so a browser that signed in as someone else in another tab can neither
 * stream that person's panels into this page nor preview or confirm as them under this page's bar; and a probe whose
 * answer names anyone else goes to `/login?ended=switched`, as the 409 bar's Look again does. A page that does not say
 * who it is sends no person, and is never reloaded into one.
 *
 * AN ANSWER THAT IS NOT A WRITE'S OWN IS NEVER ITS SENTENCE IN THE SLOT. A 401 from a preview or a confirm, or a stream
 * the browser closed (the page's or the transcript's), is a session that ended or a browser that is someone else's
 * now, whatever the request was: each goes through the one probe (below) and its `toLogin`. A write's 401 first puts
 * `CONFIRM_SIGNED_OUT` (`confirm-view.mjs`: nothing was changed, and the console is being asked) in the slot that asked,
 * never the answer's own text, so a slot whose probe waits on a stream's question never stays on its skeleton. A write's
 * 503 for a tokens file the console cannot use comes with the bar the server draws for it, as every refusal of a write
 * does.
 *
 * What it does, per page (`data-page` on the body):
 *   - both sign-in pages, first: every `[data-reveal]` element loses `hidden` (issue #737). The server draws what works
 *     only with this script (the token form, the link page's states) hidden with `data-reveal`, so a browser without
 *     script shows the noscript sentence alone.
 *   - `login`: submits the token as JSON (a form-encoded POST is refused by the server) and clears the field at once;
 *     the token is held in this closure only, for the retries. The answer's status picks one notice
 *     (`NOTICE_OF_STATUS`; any other refusal is `other`, with the server's sentence through `textContent`), shown alone
 *     in `#notice`. A post that reaches nothing shows `unreachable` and is posted again every `RETRY_MS`, so the page
 *     stays instead of turning into the browser's error page, until any answer comes or the attempt has made
 *     `SIGN_IN_TRIES_MAX` posts or run `SIGN_IN_RETRY_FOR_MS` (whichever is first; judged before each post goes out, so
 *     the last one leaves inside the 60 s): then the token is dropped, the field cleared, and the `gaveup` notice
 *     (`SIGN_IN_GAVE_UP`, the script's sentences in a copy of the server's `unreachable` notice) asks for another press.
 *     A new submit stops the loop, and an older attempt's answer does nothing.
 *   - `login-code`: reads the one-time code from `location.hash`, drops the fragment from history with
 *     `history.replaceState` BEFORE posting it (so the back button and a session restore cannot replay it), then posts
 *     it. The code travels in the fragment because a fragment never reaches the server's request line, a log or a
 *     Referer. A fragment `#<code>&next=<path>` (issue #708) also names the page to land on: it is posted beside the
 *     code, the server answers the page it accepts (`returnPathOf`, one of this console's own pages, else `/`), and
 *     the script navigates there only if the answer is also one of `PAGES`' paths (`ownPage`), never anywhere else.
 *     The card's states (`[data-link-state]`): the state the server drew (`wait`; a panel golden draws the others) is
 *     the one `data-reveal` shows, and the script moves off it only for a reason: `nocode` for a fragment with no code,
 *     `used` for a refusal that spent or refused the code (a 401 is the link's own; a 503 or 500 comes after the
 *     server took it, so a new link is the way on, and the notice above says why). A 429 is the sign-in limiter's,
 *     answered before the code is read: the link was not tried, so the state stays and the `rate` notice says to wait.
 *     A post that reaches nothing keeps the state as it is, shows `unreachable` and posts the same code again every
 *     `RETRY_MS`, under the token's cap; past it the page shows `used` (the link has expired by then) and the `gaveup`
 *     notice, and holds the code no more. A new link pasted into the same tab (only its fragment changes, so no page
 *     loads: `hashchange`) loads the page again, which reads and posts the new code.
 *   - every signed-in page: the sign-out button (`#logout`), which marks this tab as signing out first, so the
 *     `elsewhere` end its own sign-out sends its streams is not mistaken for another tab's. Only the console's 200 goes
 *     to `/login`; any other answer, none, or none within `SIGN_OUT_TIMEOUT_MS`, keeps the page and says the sign-out
 *     was not confirmed (`SIGN_OUT_UNCONFIRMED`, a banner this script adds after the title bar, as an alert, once
 *     however often Sign out is pressed). A 200 that comes after that still goes to `/login`: it is the sign-out. Each
 *     press clears the one before it (its timer, and what its answer would say), so an earlier press can never end the
 *     signing out of a later one still waiting for its own answer.
 *   - the SHELL (issue #737, `shell.mjs`): the theme button (`[data-theme-toggle]`, drawn hidden) is shown where the
 *     page can be re-themed and cycles the system's theme, light and dark: it sets or removes `data-theme` on `<html>`
 *     and the `color-scheme` meta's content, and writes the `pd_theme` cookie (`theme.mjs`) the server draws the next
 *     page from. It reads the current choice from `<html data-theme>` (what the server drew), never from
 *     `document.cookie`; the sign-in pages carry the button too. The navigation's More menu (`details.more`) closes on
 *     Escape, a click elsewhere or focus leaving it; on a phone, where the navigation scrolls sideways inside itself,
 *     the script also scrolls its button whole into view whenever it opens, places its list under the button and
 *     closes it when a later scroll takes the button wholly out of view, and scrolls the current screen's pill (or
 *     More's button, for a screen inside More) into view once on load and a focused pill fully into view. The theme
 *     button keeps its space while hidden (`SHELL_CSS`), so showing it moves nothing. A command box's Copy button
 *     (`[data-copy]`, drawn hidden) is shown, on load and in each swapped panel, only where the clipboard can be
 *     written (`navigator.clipboard` in a secure context), and copies the text of its box's `<code>`.
 *   - a LIVE page (issue #641; `data-live` on the body): opens `/api/events?page=<data-live>&<data-query>` with
 *     `EventSource`. An `event: panel` carries `{id, html}`, and its html replaces the inner HTML of the element with
 *     that id ONLY when that element carries `data-panel`: the server renders and escapes the fragment (the same
 *     renderer as the page load), and the guard keeps a message from aiming at any other element. The live pill
 *     (`#live-status`) says Live, Reconnecting, Not live or Signed out (`shell.mjs` `LIVE_STATES`: its classes, which
 *     pick the dot or the state's glyph the server drew, its word in `[data-live-word]` through `textContent`, and the
 *     sentence in its title, removed where a state has none), and `#live-note` shows one of the server's notes
 *     (`LIVE_NOTES`: retry, limit, out, stale). `EventSource` reconnects a dropped stream by itself and resends
 *     `Last-Event-ID`; the pill says Reconnecting meanwhile. A stream the browser CLOSED (a 429 over the stream limit,
 *     a 401, a 503) is never retried by it, and the three need different words, so the script asks `/api/whoami`
 *     (`probe`): a 200 that names another person than the page's is this browser signed in as someone else
 *     (`/login?ended=switched`: the server refuses this page's stream as its own, see above), a 200 that names the page's
 *     is the stream limit (Not live, the limit note), a 401 is a session that ended (sign-in, with the answer's `ended`
 *     reason), and a 503 or no answer keeps the page and asks again every `RETRY_MS` (the retry note), reloading once
 *     the console answers. One question is out at a time, and its answer settles every caller that asked meanwhile (the
 *     page's stream, the transcript's, a write's 401): a 200 for the page's person that is the stream limit is said on
 *     every stream the browser has closed, so two streams closed together both say it, whichever asked first.
 *     `event: end` carries `{ended}` (`STREAM_ENDS`), read by one handler for the page and the transcript streams: `shutdown` (the console stopped) keeps the page and probes after a wait, a 401
 *     then meaning the console no longer knows the sign-in (`restart`); `elsewhere` (this browser signed out, or signed
 *     in again, in another tab) probes too after the same wait, since the browser may be storing a newer cookie; any
 *     other reason, or none, goes to `/login?ended=<reason>` (`toLogin`, a member of `ENDED_REASONS` only, else plain
 *     `/login`). A probe's 200 reloads only when it names the person the page was drawn for (`.who`'s `data-name` and
 *     `data-role`), else it goes to `/login?ended=switched`. The tab that is signing out ignores every end.
 *     `event: stale` (the hub could not read the deployment's data, or with `what: "tokens"` its tokens file, and kept
 *     the panels as they were) dims `<main>` (`main.stale`) under the stale note with the time last seen (`<time
 *     data-since>`, local as below; a stale with no time, as a lone tab's reconnect gets, keeps the time an earlier
 *     stale gave), its sentence the server's or, for the tokens file, `STALE_TOKENS_BODY`; `event: fresh` undoes both,
 *     and nothing else does: the hub tells every page stream its state first (`live.mjs`), so a stream that opens again
 *     says whether its page is current before it sends a panel, and opening is no sign either way (issue #737). The
 *     script only takes back what it showed, so a state the server drew (a panel golden's) stays as drawn.
 *   - the SPEND SCREEN (`insights`): what the offline insights page's own script did, under this CSP. The insights
 *     renderers mark each bar with `data-tip="<n>"` and the page lists the texts in `#insights-tips` (escaped by the
 *     server); hovering a bar shows its text in the topology's `#tip` box through `textContent`. The topology pans
 *     (drag), zooms (wheel), shows each chip's tooltip, selects a chip with its neighbours and wires (click; Escape
 *     clears), and keeps the view in the fragment; a breakdown row (`data-node`, a minted `n<k>`) replays a click at its
 *     chip. The chips' data comes from `#graph-nodes`, a hidden list the server escaped, never from an inline script.
 *     `FIT_JS` (graph-html.mjs, the one label fitter) shortens a drawn label that runs past its box and adds a `<title>`
 *     through the DOM. All of it runs on the spend screen only.
 *   - the ACTION FORMS (issue #642; `form[data-action]`, drawn for an operator only): one handler, delegated from the
 *     document so a form a live panel swapped in works too. Submit reads the form's named controls into JSON (`data-type`
 *     says how: `int`, `json`, `list`, a checkbox is `true`; a blank control is left out) and posts it to
 *     `/api/act/<data-action>/preview`. THE CONFIRM SLOT (`#confirm-slot`, `confirm-view.mjs`): one per page, drawn
 *     by the server after the content, hidden, holding the previewing skeleton (read once, `skeleton`). A submit moves
 *     it after the card that asked (`slotAnchor`: the form's panel, else its banner, lifted out of the panel's
 *     `.legacy` wrapper so the Pulse bar never sits under the legacy rules), never inside a panel or a table cell,
 *     titles it "Previewing: <the button's words>" with Confirm disabled, and shows it. The answer's `html`
 *     (server-rendered and escaped, like a panel: the preview, no-change or refusal bar) is put in the slot and nowhere
 *     else. Its buttons are one delegated listener: `[data-confirm]` posts the ticket (held in this closure only) to
 *     `/api/act/<name>/confirm`; `[data-cancel]` and `[data-close]` put the skeleton back and hide the slot;
 *     `[data-again]` previews the same form again; `[data-reload]` reloads, except under a bar whose answer names
 *     `ended` (the person refusal's `switched`), where it goes to `/login?ended=<it>`. `[data-expires]` counts down the
 *     ticket's life (its value in ms, from when the bar arrived), and at 0 Confirm is disabled. An answer with no `html`
 *     (a proxy's error page, no answer at all) shows a sentence in the skeleton's `[data-slot-message]` through
 *     `textContent`, and so does a 401, with `CONFIRM_SIGNED_OUT` as it is asked about (see above); a confirm that got
 *     no answer says `CONFIRM_NO_ANSWER` and is never sent again, since a ticket is single use and the change may have
 *     been made. A confirm with jobs refused shows the bulk results bar; any other success reloads the page, whose
 *     banner then names the change.
 *   - while a form is in use (the slot open for its panel, a field typed into or focused, its editor open), a live panel
 *     holding it is NOT swapped, so an update cannot wipe a half-made change. The newest html waits (`pending`), the
 *     panel gets the server's kept-still note once (a copy of `<template id="held-note">`, as its first child), and the
 *     update is applied when the hold ends: Cancel or Close, or focus leaving a field (a tick later, once focus has
 *     landed).
 *   - the run page's LIVE TRANSCRIPT (issue #643; `[data-transcript]`, drawn for an operator only): opens
 *     `/api/transcript?id=<data-job>` with `EventSource`. Each `event: entry` carries `{html}`, server-rendered and
 *     escaped, which is APPENDED to that one element (`insertAdjacentHTML("beforeend")`) and nowhere else. The view
 *     follows the bottom unless the operator has scrolled up. `[data-transcript-status]` says "live", "reconnecting",
 *     "ended (<outcome>)", "not live" or "signed out", through `textContent`. `event: done` (the run is over) closes the
 *     stream, so it is not reopened; `event: end` is the page stream's handler (above). A dropped stream reconnects by
 *     itself and resends the last entry's id as `Last-Event-ID`, so nothing is appended twice. One the browser closed
 *     (a 401, a 429, a 503) is asked about with the page stream's probe, saying "reconnecting" on its own line while it
 *     asks: a 401 or another person goes to sign-in, and only a 200 for the page's person is the stream limit, "not
 *     live" on that line alone.
 *   - every page's TIMES (issue #710): each `<time datetime>` the server drew (its text the UTC instant) is rewritten to
 *     the reader's local time with its UTC offset, its `title` set to the UTC text, on load and inside each panel a
 *     live update swaps in. Without the script a page reads UTC, as it always did.
 * Server text is shown with `textContent`, never as markup. The markup writes are exactly three, all of server-escaped
 * fragments into elements the server marked for them: the slot's (`fillSlot`: an answer's `html`, or the skeleton put
 * back), the panel swap (`swapPanel`, behind `data-panel`) and the transcript append.
 *
 * Every browser global past the DOM is checked before it is used (`fetch`, the timers, `requestAnimationFrame`), and
 * nothing calls `fetch` while the page loads: the tests run this script under stubs, where a global they did not stub
 * would be Node's own (its `fetch` reaches the network).
 */
import { FIT_JS } from "../graph-html.mjs";
import { CONFIRM_NO_ANSWER, CONFIRM_SIGNED_OUT, CONFIRM_SLOT_ID } from "./confirm-view.mjs";
import { PAGES } from "./pages.mjs";
import { ENDED_REASONS, NOTICE_OF_STATUS, PERSON_HEADER, PERSON_PARAM, STREAM_ENDS, STREAM_SHUTDOWN } from "./session-ends.mjs";
import { LIVE_NOTES, LIVE_STATES } from "./shell.mjs";
import { SYSTEM_SCHEME, THEME_COOKIE, THEME_COOKIE_MAX_AGE_SEC, THEME_COOKIE_SAME_SITE, THEME_LABELS, THEMES } from "./theme.mjs";
import { OUTCOME_WORD_OF } from "../words.mjs";

/**
 * How long the page waits before it asks again, when the console did not answer (a sign-in post, a one-time link's
 * post, the probe after a stream closed). The live stream's own `retry:` (`server.mjs`) and the sentences that promise
 * it (`LIVE_STATES.retry`, `SIGN_IN_NOTICES.unreachable`) say the same 2 seconds; a test holds the four together.
 */
export const RETRY_MS = 2000;

/**
 * How long one sign-in attempt (a token's, or a one-time link's) keeps posting while nothing answers (issue #737), in
 * posts (the first and its retries, `RETRY_MS` apart) and in ms from its first post, whichever comes first. Past it
 * the page drops what it held for the retries, says so (`SIGN_IN_GAVE_UP`), and sends nothing more: posting a token
 * every 2 s forever, to whatever answers on the port when it comes back, is worse than asking for one press more. A
 * link has expired by then anyway (it lasts 60 s).
 */
export const SIGN_IN_TRIES_MAX = 30;
export const SIGN_IN_RETRY_FOR_MS = 60_000;

/**
 * The notice a sign-in page shows once an attempt stops (`SIGN_IN_TRIES_MAX`): the script's own sentences, set by
 * `textContent` into a copy of the server's `unreachable` notice (its tone and icon), with `data-notice="gaveup"`.
 */
export const SIGN_IN_GAVE_UP = Object.freeze({
  title: "Console not reachable",
  login: "Nothing more is sent, and this page no longer holds the token. Paste it and press Sign in again once the console is back.",
  link: "Nothing more is sent, and a link lasts 60 seconds, so this one has expired. Ask for a new one once the console is back.",
});

/**
 * How long a sign-out waits for the console's answer before it says it was not confirmed (a console that took the post
 * and never answered left the page with no word at all). The post is not taken back: a 200
 * that comes later still goes to sign-in.
 */
export const SIGN_OUT_TIMEOUT_MS = 10_000;

/**
 * What a page says when its sign-out was not confirmed (any answer but 200, none, or none within `SIGN_OUT_TIMEOUT_MS`):
 * it stays, since the session may still be live, and says so in a small failed banner the script adds after the title
 * bar, as an alert.
 */
export const SIGN_OUT_UNCONFIRMED = Object.freeze({
  title: "Sign-out not confirmed",
  body: "The console did not confirm it, so this browser may still be signed in. Press Sign out again.",
});

/**
 * The stale note's sentence when what the hub could not read is the console's tokens file (`event: stale` with
 * `what: "tokens"`, issue #737); for the deployment's data the server's own sentence (`LIVE_NOTES.stale.body`) stands.
 * The backticked command is drawn in the code face, as `kit.mjs` `withCode` draws the server's (a plain one broke as
 * "pi-/dispatch" at 375 px).
 */
export const STALE_TOKENS_BODY = "The console could not read its tokens file, so it shows nothing newer; this is the page as it was last seen. An operator should run `pi-dispatch doctor`.";

export const CONSOLE_SCRIPT = `"use strict";
(function () {
  var page = document.body ? document.body.getAttribute("data-page") : null;
  var PAGE_PATHS = ${JSON.stringify(Object.values(PAGES).map((p) => p.path))};
  // The console's outcome words (words.mjs, issue #710), written in from the one table: a stream's end says "refused",
  // never the record's "policy". An outcome not in it shows as itself.
  var OUTCOME_WORD = ${JSON.stringify(OUTCOME_WORD_OF)};
  // The closed lists this script switches on, written in from their one source each (issue #737): why a session ended
  // (session-ends.mjs; the only reasons /login?ended= is ever given), what a stream's end may carry, which sign-in notice
  // a status selects, the confirm slot's id and its no-answer and signed-out sentences (confirm-view.mjs), and the live
  // notes the server draws (shell.mjs LIVE_NOTES).
  var ENDED_REASONS = ${JSON.stringify(ENDED_REASONS)};
  var STREAM_ENDS = ${JSON.stringify(STREAM_ENDS)};
  var STREAM_SHUTDOWN = ${JSON.stringify(STREAM_SHUTDOWN)};
  var PERSON_PARAM = ${JSON.stringify(PERSON_PARAM)};
  var PERSON_HEADER = ${JSON.stringify(PERSON_HEADER)};
  var NOTICE_OF_STATUS = ${JSON.stringify(NOTICE_OF_STATUS)};
  var CONFIRM_SLOT_ID = ${JSON.stringify(CONFIRM_SLOT_ID)};
  var CONFIRM_NO_ANSWER = ${JSON.stringify(CONFIRM_NO_ANSWER)};
  var CONFIRM_SIGNED_OUT = ${JSON.stringify(CONFIRM_SIGNED_OUT)};
  var LIVE_NOTE_KEYS = ${JSON.stringify(Object.keys(LIVE_NOTES))};
  var RETRY_MS = ${JSON.stringify(RETRY_MS)};
  var SIGN_IN_TRIES_MAX = ${JSON.stringify(SIGN_IN_TRIES_MAX)};
  var SIGN_IN_RETRY_FOR_MS = ${JSON.stringify(SIGN_IN_RETRY_FOR_MS)};
  var SIGN_IN_GAVE_UP = ${JSON.stringify(SIGN_IN_GAVE_UP)};
  var SIGN_OUT_TIMEOUT_MS = ${JSON.stringify(SIGN_OUT_TIMEOUT_MS)};
  var SIGN_OUT_UNCONFIRMED = ${JSON.stringify(SIGN_OUT_UNCONFIRMED)};
  var STALE_TOKENS_BODY = ${JSON.stringify(STALE_TOKENS_BODY)};
  function own(obj, key) {
    return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
  }
  function isReason(r) {
    return typeof r === "string" && ENDED_REASONS.indexOf(r) >= 0;
  }
  // Sign-in, saying why only with one of the console's own reasons: whatever an answer or an event carried, nothing
  // else reaches the query string.
  function toLogin(r) {
    location.assign(isReason(r) ? "/login?ended=" + r : "/login");
  }
  function later(fn, ms) {
    return typeof setTimeout === "function" ? setTimeout(fn, ms) : null;
  }
  // The person this page was drawn for (see the header): the top bar's .who, "<name>.<role>", or null on a page that
  // does not say (the sign-in pages), which then sends none.
  var whoEl = typeof document.querySelector === "function" ? document.querySelector(".who") : null;
  var pageName = whoEl && typeof whoEl.getAttribute === "function" ? whoEl.getAttribute("data-name") : null;
  var pageRole = whoEl && typeof whoEl.getAttribute === "function" ? whoEl.getAttribute("data-role") : null;
  var pagePerson = typeof pageName === "string" && typeof pageRole === "string" ? pageName + "." + pageRole : null;
  // What an event stream's URL ends with to say the page's person (an EventSource can send no header), or nothing.
  var personQuery = pagePerson === null ? "" : "&" + PERSON_PARAM + "=" + encodeURIComponent(pagePerson);
  // A JSON post; \`mine\` sends the page's person with it (a preview or a confirm, made on the session's behalf).
  function post(path, body, mine) {
    if (typeof fetch !== "function") return Promise.reject(new Error("this browser cannot send a request"));
    var headers = { "content-type": "application/json" };
    if (mine && pagePerson !== null) headers[PERSON_HEADER] = pagePerson;
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { ok: res.ok, status: res.status, body: json };
      });
    });
  }
  function errorOf(r) {
    return (r.body && typeof r.body.error === "string") ? r.body.error : "The console refused the request (" + r.status + ").";
  }
  // ---- the sign-in pages (issue #737: the SignIn and AccessStates cards) ----
  // One notice at a time in #notice: each [data-notice] is the server's, drawn hidden but its choice, and this shows
  // exactly the one named (none, for a name it does not draw). The "other" notice's sentence is the server's own error,
  // set as text.
  function showOnly(kind, text) {
    var box = document.getElementById("notice");
    if (!box || typeof box.querySelectorAll !== "function") return;
    var all = box.querySelectorAll("[data-notice]");
    for (var i = 0; i < all.length; i++) {
      var mine = all[i].getAttribute("data-notice") === kind;
      all[i].hidden = !mine;
      var t = mine && typeof text === "string" ? all[i].querySelector("[data-notice-text]") : null;
      if (t) t.textContent = text;
    }
  }
  // The notice a refused sign-in shows: by its status, from the server's table for that route, else "other".
  function refusedSignIn(path, r) {
    var table = NOTICE_OF_STATUS[path];
    var kind = own(table, String(r.status)) ? table[String(r.status)] : "other";
    showOnly(kind, kind === "other" ? errorOf(r) : null);
  }
  function nowMs() {
    return typeof Date === "function" && typeof Date.now === "function" ? Date.now() : null;
  }
  // Whether an attempt that has made \`tries\` posts, none answered, the first at \`from\` (ms), may make another at \`at\`:
  // fewer than 30 posts, and less than 60 s after the first (SIGN_IN_TRIES_MAX, SIGN_IN_RETRY_FOR_MS). Asked when a post
  // fails, for the one it would schedule (so the stop is said at once), and again as that one is about to go out, since
  // a timer can run late (a tab asleep): the last post never leaves past the 60 s.
  function mayPost(tries, from, at) {
    return tries < SIGN_IN_TRIES_MAX && (from === null || at === null || at - from < SIGN_IN_RETRY_FOR_MS);
  }
  function nextAt() {
    var t = nowMs();
    return t === null ? null : t + RETRY_MS;
  }
  // The attempt stopped: a copy of the server's unreachable notice (its tone and icon) with this script's own two
  // sentences, as its "gaveup" notice, shown alone. Made once; a later attempt that stops shows the same one.
  function gaveUp(kind) {
    var box = document.getElementById("notice");
    if (!box || typeof box.querySelector !== "function") return;
    var mine = box.querySelector('[data-notice="gaveup"]');
    if (!mine) {
      var from = box.querySelector('[data-notice="unreachable"]');
      if (!from || typeof from.cloneNode !== "function" || typeof box.appendChild !== "function") return;
      mine = from.cloneNode(true);
      mine.setAttribute("data-notice", "gaveup");
      var t = mine.querySelector(".banner__t");
      var s = mine.querySelector(".banner__s");
      if (t) t.textContent = SIGN_IN_GAVE_UP.title;
      if (s) s.textContent = SIGN_IN_GAVE_UP[kind];
      box.appendChild(mine);
    }
    showOnly("gaveup");
  }
  // What works only with this script (the sign-in form, the link page's states) is drawn hidden with data-reveal, so a
  // browser without script shows only the noscript sentence (issue #737); the first thing either page does is show it.
  function revealScripted() {
    var els = typeof document.querySelectorAll === "function" ? document.querySelectorAll("[data-reveal]") : [];
    for (var i = 0; i < els.length; i++) els[i].hidden = false;
  }
  if (page === "login") {
    revealScripted();
    var form = document.getElementById("login-form");
    var input = document.getElementById("token");
    // Each submit is an attempt; a retry belongs to its attempt, so a new submit (another token) ends the old loop, and
    // an older attempt's answer, arriving late, does nothing.
    var attempt = 0;
    var retrying = null;
    // The current attempt's token, for its retries alone: dropped once the attempt is answered or has stopped.
    var held = null;
    var stopLogin = function () {
      held = null;
      if (input) input.value = "";
      gaveUp("login");
    };
    var signIn = function (mine, tries, from) {
      if (mine !== attempt) return;
      if (!mayPost(tries, from, nowMs())) return stopLogin();
      post("/login", { token: held }).then(function (r) {
        if (mine !== attempt) return;
        held = null;
        if (r.ok) location.assign("/");
        else refusedSignIn("/login", r);
      }, function () {
        if (mine !== attempt) return;
        if (!mayPost(tries + 1, from, nextAt())) return stopLogin();
        showOnly("unreachable");
        retrying = later(function () { retrying = null; signIn(mine, tries + 1, from); }, RETRY_MS);
      });
    };
    if (form && input) form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      // Out of the field at once, whatever the answer: the token stays in this closure for the retries alone.
      held = input.value;
      input.value = "";
      attempt += 1;
      if (retrying !== null && typeof clearTimeout === "function") clearTimeout(retrying);
      retrying = null;
      signIn(attempt, 0, nowMs());
    });
  } else if (page === "login-code") {
    revealScripted();
    // A new link pasted into this tab changes only the fragment, which loads no page: the page is loaded again for it,
    // so its code is read and posted as a first visit's is. (Dropping the fragment below fires no hashchange.)
    if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") window.addEventListener("hashchange", function () { location.reload(); });
    var frag = location.hash.length > 1 ? location.hash.slice(1) : "";
    history.replaceState(null, "", location.pathname);
    var amp = frag.indexOf("&");
    var code = amp < 0 ? frag : frag.slice(0, amp);
    var next = null;
    if (amp >= 0) {
      try { next = new URLSearchParams(frag.slice(amp + 1)).get("next"); } catch (e) { next = null; }
    }
    // The card's state: each [data-link-state] is the server's, and exactly the one named shows.
    var linkState = function (state) {
      var all = typeof document.querySelectorAll === "function" ? document.querySelectorAll("[data-link-state]") : [];
      for (var i = 0; i < all.length; i++) all[i].hidden = all[i].getAttribute("data-link-state") !== state;
    };
    // The state the server drew stands (revealScripted() showed it): the script moves off it only for a reason, a
    // fragment with no code or an answer (forcing "wait" here drew every link golden as "wait" in the width check, which
    // measured none of the others).
    var stopLink = function () {
      code = null;
      next = null;
      linkState("used");
      gaveUp("link");
    };
    if (code === "") {
      linkState("nocode");
    } else {
      var sendCode = function (tries, from) {
        if (!mayPost(tries, from, nowMs())) return stopLink();
        post("/login/code", next === null ? { code: code } : { code: code, next: next }).then(function (r) {
          if (r.ok) {
            location.replace(ownPage(r.body && r.body.next));
            return;
          }
          // Refused. A 429 is the sign-in limiter's, which answers before the code is read: the link was not tried,
          // so the state stays (not used) and the notice says to wait. A 401 is the link's own refusal; a 503 or a
          // 500 comes after the server took the code, so it is spent, and a new link is the way on.
          if (r.status !== 429) linkState("used");
          refusedSignIn("/login/code", r);
        }, function () {
          // The same cap as the token's: by then the link has expired, so the page says that and holds the code no more.
          if (!mayPost(tries + 1, from, nextAt())) return stopLink();
          showOnly("unreachable");
          later(function () { sendCode(tries + 1, from); }, RETRY_MS);
        });
      };
      sendCode(0, nowMs());
    }
  }
  // Where a sign-in may land: one of this console's own page paths, else the overview. The server has already judged
  // the return path with the page parser; this repeats the shape check, so a navigation off this origin needs both
  // to be wrong.
  function ownPage(path) {
    if (typeof path !== "string" || path.charAt(0) !== "/" || path.charAt(1) === "/" || path.indexOf("\\\\") >= 0 || path.indexOf("#") >= 0) return "/";
    var q = path.indexOf("?");
    return PAGE_PATHS.indexOf(q < 0 ? path : path.slice(0, q)) >= 0 ? path : "/";
  }
  // ---- local time (issue #710) ----
  // The server writes every instant as UTC text inside <time datetime="<ISO, UTC>">, the same bytes for every reader.
  // Here, and only here, it becomes the reader's own time: the text is rewritten to local time with its offset, and the
  // UTC text goes in the title. The UTC text is rebuilt from the datetime (never read back from the text), so running
  // this twice over one element changes nothing. An element whose datetime is not an ISO instant is left as it is.
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function localTime(el) {
    var iso = el.getAttribute("datetime");
    if (typeof iso !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$/.test(iso)) return;
    var d = new Date(iso);
    var ms = d.getTime();
    if (!isFinite(ms)) return;
    var off = -d.getTimezoneOffset();
    var abs = Math.abs(off);
    var zone = off === 0 ? "UTC" : "UTC" + (off > 0 ? "+" : "-") + Math.floor(abs / 60) + (abs % 60 ? ":" + pad2(abs % 60) : "");
    el.textContent = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " " + zone;
    el.setAttribute("title", iso.slice(0, 16).replace("T", " ") + " UTC");
  }
  function localTimes(root) {
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll("time[datetime]");
    for (var i = 0; i < els.length; i++) localTime(els[i]);
  }
  try { localTimes(document); } catch (e) { /* the times stay UTC */ }
  // Set before the sign-out is sent: the server then ends this session's streams with "elsewhere", which in any OTHER
  // tab means "probe, and reload if this browser is still signed in", and in this one means nothing.
  var signingOut = false;
  var out = document.getElementById("logout");
  // Signed out only on the console's 200 (issue #737): any other answer, none, or none within SIGN_OUT_TIMEOUT_MS, keeps
  // the page, which says the sign-out was not confirmed in a small failed banner after the title bar (an alert, so a
  // screen reader hears it), ONCE however often Sign out is pressed. Going to the sign-in page then would show a browser
  // signed out that may not be.
  var outNote = null;
  function signOutUnconfirmed() {
    signingOut = false;
    var main = document.getElementById("main");
    if (outNote !== null || !main || typeof document.createElement !== "function") return;
    outNote = document.createElement("div");
    outNote.className = "banner banner--sm tone-failed";
    outNote.setAttribute("role", "alert");
    outNote.setAttribute("data-signout", "unconfirmed");
    // The tile every server banner has (kit.mjs banner), holding a copy of the sign-out button's own icon: what the
    // banner is about, in the failed tone.
    var tile = document.createElement("span");
    tile.className = "tile";
    var glyph = out && typeof out.querySelector === "function" ? out.querySelector("svg") : null;
    if (glyph && typeof glyph.cloneNode === "function") tile.appendChild(glyph.cloneNode(true));
    outNote.appendChild(tile);
    var words = document.createElement("div");
    var t = document.createElement("p");
    var s = document.createElement("p");
    t.className = "banner__t";
    s.className = "banner__s";
    t.textContent = SIGN_OUT_UNCONFIRMED.title;
    s.textContent = SIGN_OUT_UNCONFIRMED.body;
    words.appendChild(t);
    words.appendChild(s);
    outNote.appendChild(words);
    var bar = typeof main.querySelector === "function" ? main.querySelector(".titlebar") : null;
    if (bar && typeof bar.after === "function") bar.after(outNote);
    else main.insertBefore(outNote, main.firstChild);
  }
  // The newest press, and its timer: a press clears the one before it, so an earlier press's timer or late answer never
  // says "not confirmed" (and stops the signing out) under a later press still waiting for its own.
  var outPress = 0;
  var outTimer = null;
  if (out) out.addEventListener("click", function () {
    signingOut = true;
    outPress += 1;
    var mine = outPress;
    if (outTimer !== null && typeof clearTimeout === "function") clearTimeout(outTimer);
    // This press is unconfirmed once, whichever comes first: an answer that is not 200, none, or the timeout.
    var said = false;
    var unconfirmed = function () {
      if (said || mine !== outPress) return;
      said = true;
      signOutUnconfirmed();
    };
    outTimer = later(unconfirmed, SIGN_OUT_TIMEOUT_MS);
    post("/logout", {}).then(function (r) {
      // Any press's 200 is the sign-out, whichever press it answers.
      if (r.status === 200) location.assign("/login");
      else unconfirmed();
    }, unconfirmed);
  });
  // ---- the shell (issue #737): the theme button, the More menu, the current pill, the Copy buttons ----
  // Every DOM API below is checked before it is used: the sign-in pages hold none of these elements, and the test stubs
  // this script also runs on have no documentElement, no cookie and no clipboard. The listeners are added only where
  // their element exists, and before the spend screen's, which handles Escape and clicks for its topology too.
  var THEME_COOKIE = ${JSON.stringify(THEME_COOKIE)};
  var THEME_ORDER = ${JSON.stringify(["system", ...THEMES])};
  var THEME_LABELS = ${JSON.stringify(THEME_LABELS)};
  var docEl = document.documentElement;
  var themeBtn = typeof document.querySelector === "function" ? document.querySelector("[data-theme-toggle]") : null;
  if (themeBtn && docEl && typeof docEl.getAttribute === "function" && typeof docEl.setAttribute === "function" && "cookie" in document) {
    // The choice the server drew, from <html data-theme>; anything else there is the system's.
    var themeNow = function () {
      var t = docEl.getAttribute("data-theme");
      return THEME_ORDER.indexOf(t) > 0 ? t : "system";
    };
    var themeSay = function (t) {
      themeBtn.setAttribute("aria-label", THEME_LABELS[t]);
      themeBtn.setAttribute("title", THEME_LABELS[t]);
    };
    themeSay(themeNow());
    themeBtn.hidden = false;
    themeBtn.addEventListener("click", function () {
      var next = THEME_ORDER[(THEME_ORDER.indexOf(themeNow()) + 1) % THEME_ORDER.length];
      var meta = document.querySelector('meta[name="color-scheme"]');
      if (next === "system") docEl.removeAttribute("data-theme");
      else docEl.setAttribute("data-theme", next);
      if (meta) meta.setAttribute("content", next === "system" ? ${JSON.stringify(SYSTEM_SCHEME)} : next);
      // Max-Age=0 forgets a choice: a page with no cookie follows the system. A browser that keeps no cookie (or a
      // sandboxed frame, where the setter throws) still re-themes this page; the next one follows the system again.
      try {
        document.cookie = THEME_COOKIE + "=" + (next === "system" ? "" : next) + "; Path=/; Max-Age=" + (next === "system" ? 0 : ${THEME_COOKIE_MAX_AGE_SEC}) + "; SameSite=${THEME_COOKIE_SAME_SITE}";
      } catch (e) { /* this page only */ }
      themeSay(next);
    });
  }
  var more = typeof document.querySelector === "function" ? document.querySelector("details.more") : null;
  if (more && typeof more.contains === "function") {
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !more.open) return;
      var inside = more.contains(document.activeElement);
      more.open = false;
      // Focus goes back to the menu's button when it was inside the menu, so the keyboard does not lose its place.
      var summary = inside && typeof more.querySelector === "function" ? more.querySelector("summary") : null;
      if (summary && typeof summary.focus === "function") summary.focus();
    });
    document.addEventListener("click", function (e) {
      if (more.open && e.target && !more.contains(e.target)) more.open = false;
    });
    // Tabbing past the menu's last link (or back before its button) closes it: an open list the keyboard has left would
    // cover the page under it with nothing to say it is still open. Focus that goes nowhere (a click on bare page) is the
    // click handler's.
    if (typeof more.addEventListener === "function") more.addEventListener("focusout", function (e) {
      if (more.open && e && e.relatedTarget && !more.contains(e.relatedTarget)) more.open = false;
    });
  }
  // On a phone the navigation scrolls sideways inside itself, and a scroll box clips every descendant positioned against
  // itself or anything inside it, so there the More menu's list is positioned against the whole top bar (the CSS leaves
  // the details unpositioned, page-css.mjs SHELL_CSS) and this script moves it under its own button: its right edge
  // under the button's, its top 6 px below it, kept inside the row. EVERY OPENING first scrolls the button whole into
  // the navigation's view, focus ring included, and then places the list: a tap, a click or a script's click() on a
  // button the row had cut opens the menu under a whole button. (An element.click(), which moves no focus, was measured
  // opening and at once closing the menu at every phone width: the opening measured the cut button as out of view.)
  // After that the list follows the button when the navigation scrolls or the bar changes size, and
  // the menu CLOSES only when such a later move (a scroll of the navigation, or a window turned or resized) leaves no
  // part of its button in view: a sliver still shows where it hangs from. Above the phone the navigation never
  // scrolls, the details is the list's containing block and the CSS alone puts it under its button (no script needed,
  // and right without one): there this only clears what it set, should the window have been a phone's when the menu
  // opened. Which case holds is read from the details' computed position, so the breakpoint lives in the stylesheet
  // alone, and a browser that cannot say leaves the list to the CSS. Element.style is the CSSOM, which the CSP's
  // style-src governs only for markup (the spend screen's tooltip is placed the same way). Also in the frame after the
  // click, so the list is laid out and measured before it is painted (the toggle event may come after that paint).
  var moreSummary = more && typeof more.querySelector === "function" ? more.querySelector("summary") : null;
  var moreList = more && typeof more.querySelector === "function" ? more.querySelector("summary + div") : null;
  var moreBar = more && typeof more.closest === "function" ? more.closest(".top") : null;
  var moreNav = more && typeof more.closest === "function" ? more.closest("nav") : null;
  function scriptPlacesMore() {
    return typeof getComputedStyle === "function" && getComputedStyle(more).position === "static";
  }
  // The navigation's own box is what the reader sees of the row: on a phone it runs past the bar to the screen's
  // edges, so the list is kept inside it (not the bar, which would pull it off a button at the screen's edge).
  function moreView() {
    return moreNav && typeof moreNav.getBoundingClientRect === "function" ? moreNav.getBoundingClientRect() : moreBar.getBoundingClientRect();
  }
  function placeMore() {
    if (!more.open) return;
    if (!scriptPlacesMore()) {
      moreList.style.left = "";
      moreList.style.right = "";
      moreList.style.top = "";
      return;
    }
    var button = moreSummary.getBoundingClientRect();
    var bar = moreBar.getBoundingClientRect();
    var view = moreView();
    // Right edges aligned where the button's shows (else at the row's end), and never past the row's start.
    var width = moreList.getBoundingClientRect().width;
    var left = Math.max(view.left, Math.min(button.right, view.right) - width) - bar.left;
    moreList.style.left = Math.round(left) + "px";
    moreList.style.right = "auto";
    moreList.style.top = Math.round(button.bottom - bar.top + 6) + "px";
  }
  // The opening: the button whole into view with its ring (reveal and RING are the navigation's, below), then the list.
  function openMore() {
    if (!more.open) return;
    if (moreNav && scriptPlacesMore()) reveal(moreNav, moreSummary, false, RING);
    placeMore();
  }
  // A later move (the navigation scrolled, the bar resized): the list follows its button, and on a phone the menu
  // closes once no part of the button shows.
  function moreMoved() {
    if (!more.open) return;
    if (scriptPlacesMore()) {
      var button = moreSummary.getBoundingClientRect();
      var view = moreView();
      if (button.right <= view.left || button.left >= view.right) {
        more.open = false;
        return;
      }
    }
    placeMore();
  }
  if (moreSummary && moreList && moreBar && typeof moreBar.getBoundingClientRect === "function" && typeof moreSummary.getBoundingClientRect === "function" && moreList.style) {
    moreSummary.addEventListener("click", function () {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(openMore);
    });
    more.addEventListener("toggle", openMore);
    if (moreNav && typeof moreNav.addEventListener === "function") moreNav.addEventListener("scroll", moreMoved);
    if (typeof ResizeObserver === "function") new ResizeObserver(moreMoved).observe(moreBar);
  }
  // On a phone the navigation scrolls sideways inside itself and starts at its first pill: a page further along (Fleet,
  // Audit inside More) would open with no pill saying where the reader is. So ONCE, on load, the current pill (or More's
  // button, for a page inside More) is scrolled into view, centred, when it is not already in full view. And a pill the
  // keyboard focuses is scrolled fully into view WITH its focus ring (bundle.css draws a 2 px outline 2 px out, and the
  // scroll box clips it): the browser's own focus scrolling stops at the pill's edge. Nothing re-centres on a resize or
  // a live word change, so a reader's own scrolling stands (a re-centre on every reconnect was measured undoing it).
  // Only the navigation's scrollLeft moves: scrollIntoView would also scroll the page, and undo
  // a restored scroll position. Above the phone the navigation never scrolls, so neither ever has anything to move.
  var nav = typeof document.querySelector === "function" ? document.querySelector("nav.pillnav") : null;
  var RING = 4;
  // The pill scrolled into the row's view by moving the row's scrollLeft alone: centred (on load), or by the least move
  // that shows it whole with a ring of that many px around it. Nothing moves when it already shows so. (Also how More's
  // opening brings its button into view, above.)
  function reveal(row, pill, centre, ring) {
    if (!row || !pill || typeof pill.getBoundingClientRect !== "function" || typeof row.getBoundingClientRect !== "function" || typeof row.scrollLeft !== "number") return;
    var box = row.getBoundingClientRect();
    var at = pill.getBoundingClientRect();
    if (at.left - ring >= box.left && at.right + ring <= box.right) return;
    if (centre) row.scrollLeft += at.left - box.left - (box.width - at.width) / 2;
    else if (at.left - ring < box.left) row.scrollLeft -= box.left - (at.left - ring);
    else row.scrollLeft += at.right + ring - box.right;
  }
  if (nav) {
    try {
      var current = typeof nav.querySelector === "function" ? nav.querySelector('a[aria-current="page"]') : null;
      var inMore = current && typeof current.closest === "function" ? current.closest("details.more") : null;
      if (inMore) current = typeof inMore.querySelector === "function" ? inMore.querySelector("summary") : null;
      reveal(nav, current, true, 0);
    } catch (e) { /* the navigation stays where it is */ }
    if (typeof nav.addEventListener === "function") nav.addEventListener("focusin", function (e) {
      // A pill or More's button; a link inside More's open list is not in the scrolling row (the list is placed
      // outside it), and its button showed whole when the menu opened.
      var t = e && e.target;
      var pill = t && typeof t.closest === "function" ? t.closest("nav.pillnav > a, details.more > summary") : null;
      try { reveal(nav, pill, false, RING); } catch (err) { /* the navigation stays where it is */ }
    });
  }
  // A secure context is what the clipboard needs (a page served from localhost is one; one served over plain http under
  // a tunnel's own name is not), so no page shows a button that cannot copy.
  var canCopy = typeof navigator !== "undefined" && !!navigator && !!navigator.clipboard && typeof navigator.clipboard.writeText === "function" && typeof isSecureContext !== "undefined" && isSecureContext === true;
  function copyButtons(root) {
    if (!canCopy || !root || typeof root.querySelectorAll !== "function") return;
    var btns = root.querySelectorAll("button[data-copy][hidden]");
    for (var i = 0; i < btns.length; i++) wireCopy(btns[i]);
  }
  function wireCopy(btn) {
    var label = btn.textContent;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var box = btn.closest ? btn.closest(".cmd") : null;
      var code = box ? box.querySelector("code") : null;
      if (!code) return;
      var said = function (text) {
        btn.textContent = text;
        setTimeout(function () { btn.textContent = label; }, 2000);
      };
      navigator.clipboard.writeText(code.textContent).then(function () { said("Copied"); }, function () { said("Not copied"); });
    });
  }
  try { copyButtons(document); } catch (e) { /* the Copy buttons stay hidden */ }
  // ---- the spend screen: chart tooltips and the interactive topology ----
  if (page === "insights") {
    try { fitInsightsLabels(); } catch (e) { /* the labels stay as drawn */ }
    insightsPage();
  }
  function fitInsightsLabels() {
${FIT_JS}
  }
  function insightsPage() {
    var tip = document.getElementById("tip");
    var wrap = document.getElementById("wrap");
    var svg = document.getElementById("graph");
    var root = document.getElementById("root");
    if (!tip || !wrap) return;
    // The texts the server listed, escaped, in two hidden lists: each chart tooltip (#insights-tips, by its data-tip
    // index) and each topology chip's tooltip, neighbours and wires (#graph-nodes, by minted id). Read as text and
    // attributes only; the offline page carried the same data as a JSON literal in an inline script, which the console's
    // CSP refuses.
    var tipsList = document.getElementById("insights-tips");
    var TIPS = [];
    if (tipsList) {
      var lis = tipsList.getElementsByTagName("li");
      for (var a = 0; a < lis.length; a++) TIPS.push(lis[a].textContent);
    }
    var NODES = {};
    var nodeList = document.getElementById("graph-nodes");
    if (nodeList) {
      var items = nodeList.getElementsByTagName("li");
      for (var b = 0; b < items.length; b++) {
        var nid = items[b].getAttribute("data-id");
        // Minted ordinals only, by the server's own rules (panels/insights.mjs, NODE_ID_RE and WIRE_ID_RE): a chip id
        // for the item and its neighbours, a wire id for its wires. A prototype-chain key or a stray attribute never
        // becomes a node.
        if (nid === null || !/^n\\d{1,6}$/.test(nid)) continue;
        var words = function (v, re) { return (v || "").split(" ").filter(function (w) { return re.test(w); }); };
        NODES[nid] = { tip: items[b].textContent, nb: words(items[b].getAttribute("data-nb"), /^n\\d{1,6}$/), w: words(items[b].getAttribute("data-w"), /^w\\d{1,6}$/) };
      }
    }
    // The ONLY indexed read of NODES: an id from the hash or the DOM could be "constructor", which a bare lookup returns.
    function ownNode(id) {
      return Object.prototype.hasOwnProperty.call(NODES, id) ? NODES[id] : null;
    }
    var mine = false;
    function place(e) {
      tip.style.display = "block";
      var wr = wrap.getBoundingClientRect();
      tip.style.left = e.clientX - wr.left + 14 + "px";
      tip.style.top = e.clientY - wr.top + 14 + "px";
    }
    function showChartTip(el, e) {
      var i = parseInt(el.getAttribute("data-tip"), 10);
      // The index rides a DOM attribute, so it is bounds-checked before it is used; a bad one shows nothing.
      if (!(i >= 0 && i < TIPS.length)) return false;
      tip.textContent = TIPS[i];
      place(e);
      mine = true;
      return true;
    }
    function hideChartTip() {
      // Only what the charts showed: the topology drives the same box for its chips, and blanking it on every stray move
      // would fight that code mid-hover.
      if (!mine) return;
      mine = false;
      tip.textContent = "";
      tip.style.display = "none";
    }
    document.addEventListener("pointermove", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!el || !showChartTip(el, e)) hideChartTip();
    });
    // pointerleave does not bubble, so delegation needs the capture phase to see a bar's exit.
    document.addEventListener("pointerleave", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (el) hideChartTip();
    }, true);
    // A breakdown row selects its trigger's chip: the click is replayed at the chip, so the topology's own handler stays
    // the one owner of the selection.
    document.addEventListener("click", function (e) {
      var row = e.target && e.target.closest ? e.target.closest("[data-node]") : null;
      if (!row) return;
      var id = row.getAttribute("data-node");
      if (id === null || !/^n\\d+$/.test(id)) return;
      var chip = document.getElementById(id);
      if (!chip) return;
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    if (!svg || !root || !svg.viewBox || !svg.viewBox.baseVal) return;
    var vb = svg.viewBox.baseVal;
    // How far the view zooms, as the drawn width over the view's: the wheel stops here, and a fragment is held to it.
    var ZOOM_MIN = 0.15;
    var ZOOM_MAX = 4;
    var baseW = vb.width;
    var baseH = vb.height;
    var selected = null;
    var hashTimer = null;
    // The view (the viewBox and the selection) rides the fragment, so a reload or a shared link keeps it. The fragment
    // never reaches the server.
    function writeHash() {
      hashTimer = null;
      var parts = ["vb=" + [vb.x, vb.y, vb.width, vb.height].map(function (v) { return Math.round(v * 10) / 10; }).join("_")];
      if (selected) parts.push("sel=" + selected);
      history.replaceState(null, "", location.pathname + location.search + "#" + parts.join("&"));
    }
    function scheduleHash() {
      if (hashTimer) return;
      hashTimer = setTimeout(writeHash, 300);
    }
    function clamp(x, lo, hi) {
      return x < lo ? lo : x > hi ? hi : x;
    }
    function readHash() {
      var h = location.hash.replace(/^#/, "");
      if (!h) return;
      var kvs = h.split("&");
      for (var i = 0; i < kvs.length; i++) {
        var at = kvs[i].indexOf("=");
        if (at < 0) continue;
        var k = kvs[i].slice(0, at);
        var v = kvs[i].slice(at + 1);
        if (k === "vb") {
          var n = v.split("_").map(parseFloat);
          if (n.length === 4 && n.every(isFinite) && n[2] > 0 && n[3] > 0) {
            // Clamped, because the fragment is anyone's to write: a viewBox attribute is a 32-bit float, and assigning
            // one past its range (vb=1e39_0_1_1) throws in Chromium. The size takes the wheel's own zoom bounds; the
            // origin a range far wider than any pan reaches.
            var far = 100 * Math.max(baseW, baseH, 1);
            vb.x = clamp(n[0], -far, far); vb.y = clamp(n[1], -far, far);
            vb.width = clamp(n[2], baseW / ZOOM_MAX, baseW / ZOOM_MIN); vb.height = clamp(n[3], baseH / ZOOM_MAX, baseH / ZOOM_MIN);
          }
        } else if (k === "sel" && ownNode(v)) {
          select(v);
        }
      }
    }
    // With preserveAspectRatio meet, the browser scales UNIFORMLY (the smaller of the two ratios) and centres the
    // remainder; mapping each axis by its own ratio pans at the wrong speed and zooms beside the cursor.
    function view() {
      var r = svg.getBoundingClientRect();
      var sc = Math.min(r.width / vb.width, r.height / vb.height);
      return { r: r, s: sc, ox: (r.width - vb.width * sc) / 2, oy: (r.height - vb.height * sc) / 2 };
    }
    var panning = null;
    var suppressClick = false;
    // The chip under the last press. setPointerCapture retargets the click that follows to the svg itself (Chromium), so
    // the click handler alone never sees a chip a mouse clicked; it falls back to this one. A row's replayed click has
    // no press, and finds its chip as its target.
    var pressed = null;
    svg.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      pressed = nodeAt(e);
      panning = { x: e.clientX, y: e.clientY, moved: 0 };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    });
    function nodeAt(e) {
      var el = e.target && e.target.closest ? e.target.closest(".gnode") : null;
      return el && ownNode(el.id) ? el : null;
    }
    function moveTip(e) {
      var el = nodeAt(e);
      if (!el) { if (!mine) tip.style.display = "none"; return; }
      tip.textContent = ownNode(el.id).tip;
      place(e);
      mine = false;
    }
    svg.addEventListener("pointermove", function (e) {
      if (panning) {
        var v = view();
        var dx = e.clientX - panning.x;
        var dy = e.clientY - panning.y;
        panning.moved += Math.abs(dx) + Math.abs(dy);
        vb.x -= dx / v.s;
        vb.y -= dy / v.s;
        panning.x = e.clientX;
        panning.y = e.clientY;
        scheduleHash();
      }
      moveTip(e);
    });
    svg.addEventListener("pointerup", function (e) {
      if (panning && svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      // Pointer capture makes the click after a pan land on the svg, which would read as a background click and wipe the
      // selection; a real drag therefore swallows that click.
      suppressClick = panning !== null && panning.moved > 3;
      panning = null;
    });
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var k = Math.exp(-e.deltaY * 0.0015);
      var scale = baseW / (vb.width / k);
      if (scale < ZOOM_MIN || scale > ZOOM_MAX) return;
      var v = view();
      var px = vb.x + (e.clientX - v.r.left - v.ox) / v.s;
      var py = vb.y + (e.clientY - v.r.top - v.oy) / v.s;
      vb.x = px - (px - vb.x) / k;
      vb.y = py - (py - vb.y) / k;
      vb.width = vb.width / k;
      vb.height = vb.height / k;
      scheduleHash();
    }, { passive: false });
    function mark(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add("hi");
    }
    function clearSel() {
      selected = null;
      root.classList.remove("dim");
      var hi = root.querySelectorAll(".hi");
      for (var i = 0; i < hi.length; i++) hi[i].classList.remove("hi");
      scheduleHash();
    }
    function select(id) {
      clearSel();
      var g = ownNode(id);
      if (!g) return;
      selected = id;
      root.classList.add("dim");
      mark(id);
      for (var i = 0; i < g.nb.length; i++) mark(g.nb[i]);
      for (var j = 0; j < g.w.length; j++) mark(g.w[j]);
      scheduleHash();
    }
    svg.addEventListener("click", function (e) {
      var el = nodeAt(e) || pressed;
      pressed = null;
      if (suppressClick) { suppressClick = false; return; }
      if (el) { if (selected === el.id) clearSel(); else select(el.id); }
      else clearSel();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearSel(); });
    // Last, and guarded: the fragment is anyone's to write, and a throw from it must not escape insightsPage() and take
    // the rest of this script (the action forms, the live stream) down with it. The view stays as drawn.
    try { readHash(); } catch (e) { /* the view stays as drawn */ }
  }
  // ---- the action forms (issue #642) and the confirm slot (issue #737) ----
  // The one slot a preview opens in, drawn by the server after the content (an operator's page on a console that is
  // not read-only) and hidden; its first contents are the previewing skeleton, kept to put back. Which form it is open
  // for, the ticket a preview answered and the live updates held back by a panel in use live here, in this closure.
  var slot = document.getElementById(CONFIRM_SLOT_ID);
  var skeleton = slot ? slot.innerHTML : "";
  var slotOwner = null;
  var slotForm = null;
  var slotAction = null;
  var slotLabel = "";
  var slotTicket = null;
  // Bumped whenever the slot is opened or closed, so an answer that comes back for a slot since re-used is dropped.
  var slotGen = 0;
  // Why the bar in the slot says this browser is someone else's now (the person refusal's ended, "switched"), or null:
  // its Look again then goes to sign-in saying so, never a reload into the other person's console.
  var slotEnded = null;
  var countdown = null;
  // Panel id to the newest html a held panel did not take, and the panels already showing the kept-still note. No
  // prototype: an id is the server's, but "constructor" would otherwise already be "held".
  var pending = Object.create(null);
  var heldNoted = Object.create(null);
  // The ONE write of markup into the slot: an answer's server-rendered html, or the skeleton put back.
  // Every markup the script writes shows its times as the page's own are: a bar can carry a time (a waiting job's).
  function fillSlot(markup) {
    slot.innerHTML = markup;
    try { localTimes(slot); } catch (e) { /* the times stay UTC */ }
  }
  // An answer's bar into the slot, and whether its Look again leads to sign-in (slotEnded, above).
  function answerBar(b) {
    slotEnded = own(b, "ended") && isReason(b.ended) ? b.ended : null;
    fillSlot(b.html);
  }
  // A write answered 401 was not refused by its action: the session behind the page ended. It is asked about as a closed
  // stream is (probe): sign-in with the reason (the console's answer's, else this one's), another person's sign-in as
  // switched, a reload only into the page's own person; never the answer's text in the slot. The slot says first that
  // nothing was changed and the console is being asked (CONFIRM_SIGNED_OUT): the question may already be out for a
  // stream the browser closed, and its answer may be a while; a slot left on its skeleton meanwhile said "Previewing".
  function signedOut(r) {
    if (r.status !== 401) return false;
    var b = r.body || {};
    slotSays(CONFIRM_SIGNED_OUT);
    probe({ ok: "reload", ended: own(b, "ended") && isReason(b.ended) ? b.ended : null }, false);
    return true;
  }
  function inSlot(selector) {
    return slot && typeof slot.querySelector === "function" ? slot.querySelector(selector) : null;
  }
  function slotDisable(selector, off) {
    var b = inSlot(selector);
    if (b) b.disabled = off;
  }
  function stopCountdown() {
    if (countdown !== null && typeof clearInterval === "function") clearInterval(countdown);
    countdown = null;
  }
  // Where the slot goes: after the card that asked. That is the form's panel (a section the stream may swap, so the
  // slot is never inside it), else the banner it sits in (the done banner's Undo), else the form itself; lifted out of
  // the panel's own .legacy wrapper, whose rules would restyle the Pulse bar's buttons and lists.
  function slotAnchor(form) {
    var anchor = (typeof form.closest === "function" && (form.closest("section[data-panel]") || form.closest(".banner"))) || form;
    var up = anchor.parentElement;
    if (up && up.classList && up.classList.contains("legacy")) anchor = up;
    return anchor;
  }
  function openSlot(form, action, label) {
    stopCountdown();
    slotGen += 1;
    fillSlot(skeleton);
    var title = inSlot("[data-slot-title]");
    if (title) title.textContent = "Previewing: " + label;
    slotDisable("[data-confirm]", true);
    var anchor = slotAnchor(form);
    if (typeof anchor.after === "function") anchor.after(slot);
    slot.hidden = false;
    var was = slotOwner;
    slotOwner = typeof form.closest === "function" ? form.closest("section[data-panel]") : null;
    slotForm = form;
    slotAction = action;
    slotLabel = label;
    slotTicket = null;
    slotEnded = null;
    // The slot moved on from another panel: that one is no longer held by it.
    if (was && was !== slotOwner) release();
    return slotGen;
  }
  function closeSlot() {
    stopCountdown();
    slotGen += 1;
    fillSlot(skeleton);
    slot.hidden = true;
    slotOwner = null;
    slotForm = null;
    slotAction = null;
    slotTicket = null;
    slotEnded = null;
    release();
  }
  // A sentence of this script's own (or a refusal's text with no bar to show it in) in the skeleton's message line: the
  // bar's title is the button's words, its grey lines and busy mark go, Confirm stays disabled and Cancel closes it.
  function slotSays(text) {
    stopCountdown();
    fillSlot(skeleton);
    var title = inSlot("[data-slot-title]");
    if (title) title.textContent = slotLabel;
    var busy = inSlot("[aria-busy]");
    if (busy) {
      busy.removeAttribute("aria-busy");
      if (busy.classList) busy.classList.remove("confirm--busy");
    }
    var ghost = inSlot(".confirm__ghost");
    if (ghost) ghost.hidden = true;
    var line = inSlot("[data-slot-message]");
    if (line) {
      line.textContent = text;
      line.hidden = false;
    }
    slotDisable("[data-confirm]", true);
  }
  // The ticket's life, counted down in the bar from when the bar arrived (its [data-expires], in ms): a browser's clock
  // is not the server's, so the bar carries a span, not an instant. At 0 Confirm is disabled; the server refuses an
  // expired ticket anyway, with its own sentence.
  function startCountdown() {
    var el = inSlot("[data-expires]");
    var ms = el ? Number(el.getAttribute("data-expires")) : NaN;
    if (!el || !isFinite(ms) || typeof setInterval !== "function" || typeof Date.now !== "function") return;
    var end = Date.now() + ms;
    var tick = function () {
      var left = Math.max(0, end - Date.now());
      // Whole seconds left, as the server drew the first figure (confirm-view.mjs countdownText).
      var s = Math.floor(left / 1000);
      el.textContent = Math.floor(s / 60) + ":" + pad2(s % 60);
      if (left > 0) return;
      stopCountdown();
      slotTicket = null;
      slotDisable("[data-confirm]", true);
    };
    tick();
    countdown = setInterval(tick, 1000);
  }
  function submitText(form, ev) {
    var b = ev && ev.submitter && typeof form.contains === "function" && form.contains(ev.submitter) ? ev.submitter : form.querySelector("button[type=submit]");
    var t = b ? String(b.textContent || "").replace(/\\s+/g, " ").trim() : "";
    return t || form.getAttribute("data-action") || "";
  }
  function preview(form, action, label) {
    var mine = openSlot(form, action, label);
    var body;
    try { body = bodyOf(form); } catch (e) { slotSays(e.message + "; nothing was sent."); return; }
    post("/api/act/" + action + "/preview", body, true).then(function (r) {
      if (mine !== slotGen) return;
      var b = r.body || {};
      if (signedOut(r)) return;
      if (typeof b.html === "string") {
        answerBar(b);
        if (r.ok && b.unchanged !== true && typeof b.ticket === "string") {
          slotTicket = b.ticket;
          startCountdown();
        }
        return;
      }
      slotSays(r.ok ? "The console answered with no preview to show; nothing was changed." : errorOf(r));
    }, function () {
      if (mine === slotGen) slotSays("The console could not be reached, so nothing was previewed or changed.");
    });
  }
  function confirmNow() {
    if (slotTicket === null) return;
    // Single use: the ticket leaves this closure as it is sent, so nothing can send it twice.
    var ticket = slotTicket;
    slotTicket = null;
    stopCountdown();
    var mine = slotGen;
    slotDisable("[data-confirm]", true);
    slotDisable("[data-cancel]", true);
    post("/api/act/" + slotAction + "/confirm", { ticket: ticket }, true).then(function (c) {
      if (mine !== slotGen) return;
      var b = c.body || {};
      if (c.ok) {
        var refused = false;
        if (b.results && b.results.length) for (var i = 0; i < b.results.length; i++) if (b.results[i] && b.results[i].ok === false) refused = true;
        if (refused && typeof b.html === "string") fillSlot(b.html);
        else location.reload();
        return;
      }
      if (signedOut(c)) return;
      if (typeof b.html === "string") answerBar(b);
      else slotSays(errorOf(c));
    }, function () {
      // No answer: the change may or may not have been made, and the ticket is spent either way, so this is said and
      // nothing is sent again.
      if (mine === slotGen) slotSays(CONFIRM_NO_ANSWER);
    });
  }
  if (slot && typeof slot.addEventListener === "function") slot.addEventListener("click", function (e) {
    var t = e && e.target && typeof e.target.closest === "function" ? e.target.closest("[data-confirm], [data-cancel], [data-close], [data-again], [data-reload]") : null;
    if (!t || t.disabled || (typeof slot.contains === "function" && !slot.contains(t))) return;
    if (t.hasAttribute("data-confirm")) confirmNow();
    else if (t.hasAttribute("data-again")) { if (slotForm) preview(slotForm, slotAction, slotLabel); }
    else if (t.hasAttribute("data-reload")) { if (!t.hasAttribute("href")) { if (slotEnded !== null) toLogin(slotEnded); else location.reload(); } }
    else closeSlot();
  });
  // ---- held panels: a form in use is never swapped away under the person using it ----
  function inUse(panel) {
    if (slot && !slot.hidden && slotOwner === panel) return true;
    if (panel.querySelector("details[open] form[data-action]")) return true;
    var active = document.activeElement;
    if (active && panel.contains(active) && active.closest && active.closest("form[data-action]")) return true;
    var fields = panel.querySelectorAll("form[data-action] input:not([type=hidden]), form[data-action] textarea");
    for (var i = 0; i < fields.length; i++) if (fields[i].value !== fields[i].defaultValue) return true;
    return false;
  }
  // The newest update waits, and the panel says so once, with the server's own note.
  function hold(el, markup) {
    pending[el.id] = markup;
    if (heldNoted[el.id]) return;
    heldNoted[el.id] = true;
    var tpl = document.getElementById("held-note");
    var copy = tpl && tpl.content && typeof tpl.content.cloneNode === "function" ? tpl.content.cloneNode(true) : null;
    if (copy && typeof el.insertBefore === "function") el.insertBefore(copy, el.firstChild);
  }
  // The ONE panel swap, for a stream's panel and a held one's update alike.
  function swapPanel(el, markup) {
    delete pending[el.id];
    delete heldNoted[el.id];
    el.innerHTML = markup;
    try { localTimes(el); } catch (e) { /* the swapped panel's times stay UTC */ }
    try { copyButtons(el); } catch (e) { /* the swapped panel's Copy buttons stay hidden */ }
  }
  // Every held panel no longer in use takes its newest update.
  function release() {
    for (var id in pending) {
      var el = document.getElementById(id);
      if (!el || !el.hasAttribute("data-panel")) delete pending[id];
      else if (!inUse(el)) swapPanel(el, pending[id]);
    }
  }
  // Focus leaving a field ends that hold once focus has landed (a tick later: during focusout it has not yet moved).
  if (slot) document.addEventListener("focusout", function () { later(release, 0); });
  function bodyOf(form) {
    var out = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name || el.disabled) continue;
      if (el.type === "checkbox") { if (el.checked) out[el.name] = true; continue; }
      var v = el.value;
      if (v === "") continue;
      var t = el.getAttribute("data-type");
      if (t === "int") {
        var n = Number(v);
        if (!isFinite(n)) throw new Error(el.name + " must be a number");
        out[el.name] = n;
      } else if (t === "json") {
        try { out[el.name] = JSON.parse(v); } catch (e) { throw new Error(el.name + " is not valid JSON"); }
      } else if (t === "list") {
        out[el.name] = v.split(/[\\s,]+/).filter(function (w) { return w !== ""; });
      } else {
        out[el.name] = v;
      }
    }
    return out;
  }
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.matches || !form.matches("form[data-action]")) return;
    ev.preventDefault();
    var action = form.getAttribute("data-action") || "";
    if (!/^[a-z0-9-]{1,40}$/.test(action) || !slot) return;
    preview(form, action, submitText(form, ev));
  });
  // ---- the live stream (issue #641) and how a page says what it is showing (issue #737) ----
  var live = document.body ? document.body.getAttribute("data-live") : null;
  var es = null;
  var tes = null;
  var tmark = null;
  var status = document.getElementById("live-status");
  var word = status && typeof status.querySelector === "function" ? status.querySelector("[data-live-word]") : null;
  // The live pill's states, written in from shell.mjs's table, which also draws its first state on the server.
  var LIVE = ${JSON.stringify(Object.fromEntries(Object.entries(LIVE_STATES).filter(([k]) => k !== "start")))};
  function mark(state) {
    var st = LIVE[state];
    if (!status || !st) return;
    status.className = st.cls;
    if (word) word.textContent = st.word;
    if (typeof status.setAttribute === "function") {
      if (st.title) status.setAttribute("title", st.title);
      else status.removeAttribute("title");
    }
  }
  // One of the server's live notes at a time (#live-note), or none. noteShown is the one THIS script showed: it only
  // ever takes back its own, so a note the server drew (a panel golden's) stays as drawn.
  var liveNote = document.getElementById("live-note");
  var noteShown = null;
  function note(state) {
    if (state !== null && LIVE_NOTE_KEYS.indexOf(state) < 0) return;
    noteShown = state;
    if (!liveNote || typeof liveNote.querySelectorAll !== "function") return;
    var all = liveNote.querySelectorAll("[data-live-note]");
    for (var i = 0; i < all.length; i++) all[i].hidden = all[i].getAttribute("data-live-note") !== state;
  }
  function unnote(state) {
    if (noteShown === state) note(null);
  }
  var mainEl = document.getElementById("main");
  // When the page was last seen whole: the hub's clock (ms) as an instant in the stale note's <time data-since>, shown
  // in the reader's own time as every other <time> is; nothing when the hub had no good render to keep.
  function since(ms) {
    var t = liveNote && typeof liveNote.querySelector === "function" ? liveNote.querySelector("time[data-since]") : null;
    if (!t) return;
    var iso = null;
    try { iso = typeof ms === "number" && isFinite(ms) ? new Date(ms).toISOString() : null; } catch (e) { iso = null; }
    if (iso === null) {
      t.removeAttribute("datetime");
      t.removeAttribute("title");
      t.textContent = "";
      return;
    }
    t.setAttribute("datetime", iso);
    t.textContent = iso.slice(0, 16).replace("T", " ") + " UTC";
    try { localTime(t); } catch (e) { /* the time stays UTC */ }
  }
  function closeStreams() {
    if (es) es.close();
    if (tes) tes.close();
  }
  // ---- asking the console what a closed stream meant (probe) ----
  // A caller's on.ok is what a 200 means to it on the first ask: "limit" (a stream the browser closed, refused while the
  // session holds: the stream limit) or "reload" (the console is there and this browser is signed in). on.ended is the
  // reason a 401 goes to sign-in with when its answer names none of the console's own. A 503 or no answer keeps the
  // page and asks again every RETRY_MS, and once that has happened a 200 reloads (the console is back).
  //
  // ONE QUESTION, EVERY CALLER ANSWERED (issue #737). The browser closes a run page's two streams together (a 429 over
  // the stream limit refuses both), and a write's 401 can come while a stream's question is out. So each probe (in a
  // browser that can ask at all) joins the callers waiting (asks) and says its own "asking", a question goes out only
  // when none is, and its answer settles every caller waiting: the limit is said on every stream the browser has closed
  // and by each caller in its own words, a reload or a sign-in once for all. A guard that dropped the second caller (the
  // first version) left it saying what it said while it asked: the pill Live over a closed page stream, or the
  // transcript's line "reconnecting" for good.
  //
  // A 200 is read for the person first (issue #737): the answer must name the page's own (pageName, pageRole, from the
  // top bar's .who). The cookie the probe carries is whatever this browser holds NOW: a one-time link opened in another
  // tab (anyone's link, sent to this browser) signs it in as that link's person, and a reload would put their console in
  // a tab this one was using. Another person, or a page that does not say who it is, goes to sign-in with "switched". Only
  // then does a 200 mean the stream limit (the server refuses a stream that says another person 401, which closes it
  // just as a 429 does) or the console being back.
  function samePerson(b) {
    return typeof pageName === "string" && typeof pageRole === "string" && own(b, "name") && own(b, "role") && b.name === pageName && b.role === pageRole;
  }
  // What a probe says while it asks ("asking"), when a 200 means the stream limit ("limit"), and when it cannot ask at
  // all ("guess"): by default the page's pill and notes; the transcript's probe says it on its own status line (on.say),
  // since its stream being refused says nothing about the page's.
  function pageSays(state) {
    if (state === "limit") {
      mark("off");
      note("limit");
    } else if (state === "guess") {
      mark("off");
    } else {
      mark("retry");
    }
  }
  // The callers waiting for the answer, oldest first, and whether a question is under way (waiting to go, out, or
  // between a failed one and the next). The queue is emptied only by an answer that settles it: a 200 or a 401.
  var asks = [];
  var probing = false;
  function probe(on, wait) {
    if (typeof fetch !== "function") {
      // A browser that cannot ask: nothing is asked, so this caller neither waits nor joins the callers waiting, and
      // says what is known as it comes. A stream the browser closed is Not live (the stream limit is a guess it cannot
      // check); any other caller keeps the page under the retry note. Nothing loops (a loop that asks nothing would
      // only spin), and every caller is answered on its own, so none is left saying what it said while it asked.
      if (on.ok === "limit") {
        (on.say || pageSays)("guess");
      } else {
        mark("retry");
        note("retry");
      }
      return;
    }
    asks.push(on);
    // This caller's stream is closed (or its write refused) and nothing is known yet: not Live while the question is out
    // (a fetch can hang for minutes).
    (on.say || pageSays)("asking");
    if (probing) return;
    probing = true;
    if (wait) later(function () { ask(false); }, RETRY_MS);
    else ask(false);
  }
  function settled() {
    var callers = asks;
    asks = [];
    return callers;
  }
  // Reached only where the browser has fetch: probe answers a browser without it before anything is queued.
  function ask(failed) {
    var again = function () {
      mark("retry");
      note("retry");
      later(function () { ask(true); }, RETRY_MS);
    };
    fetch("/api/whoami", { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      var read = typeof res.json === "function" ? res.json().catch(function () { return null; }) : Promise.resolve(null);
      return read.then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      if (r.status === 200) {
        var callers = settled();
        probing = false;
        var reload = failed;
        for (var i = 0; i < callers.length; i++) if (callers[i].ok === "reload") reload = true;
        if (!samePerson(r.body)) {
          mark("out");
          note("out");
          toLogin("switched");
        } else if (reload) {
          location.reload();
        } else {
          // The stream limit, said by every caller in its own words: each stream the browser closed asked for itself,
          // so each says it, whichever asked first. Not "every stream at readyState 2": the transcript's after its run
          // is over is closed too (by this script, on done), and its "ended" line is not the limit's to overwrite.
          for (var j = 0; j < callers.length; j++) (callers[j].say || pageSays)("limit");
        }
      } else if (r.status === 401) {
        // The reason the console's answer gives, else the first one a caller brought (a write's 401 says why).
        var why = null;
        var gone = settled();
        for (var k = 0; k < gone.length && why === null; k++) if (isReason(gone[k].ended)) why = gone[k].ended;
        mark("out");
        note("out");
        toLogin(own(r.body, "ended") && isReason(r.body.ended) ? r.body.ended : why);
      } else {
        again();
      }
    }, again);
  }
  // A stream's end, for the page's stream and the transcript's alike (the hub ends both of a session's streams).
  var ended = false;
  function streamEnded(ev) {
    var r = null;
    try {
      var d = JSON.parse(ev && ev.data);
      r = own(d, "ended") && typeof d.ended === "string" && STREAM_ENDS.indexOf(d.ended) >= 0 ? d.ended : null;
    } catch (e) { r = null; }
    closeStreams();
    if (ended || signingOut) return;
    ended = true;
    if (r === STREAM_SHUTDOWN) {
      // The console stopped: the page stays as it is and asks once it has had a moment to go (a reload now could meet
      // it half gone, the browser's own error page). A 401 then means it no longer knows this sign-in.
      mark("retry");
      note("retry");
      if (tmark) tmark("reconnecting", "off");
      probe({ ok: "reload", ended: "restart" }, true);
    } else if (r === "elsewhere") {
      // After a wait (issue #737): a sign-in in another tab ends this one's stream as its answer goes out, and the
      // browser may not have stored the new cookie yet; asked at once, the old cookie read "elsewhere" and this tab left
      // a browser that had just signed in.
      probe({ ok: "reload", ended: "elsewhere" }, true);
    } else {
      mark("out");
      note("out");
      if (tmark) tmark("signed out", "off");
      toLogin(r);
    }
  }
  // The stale note's sentence: the server's (the deployment's data), read once, or this script's own for a tokens file
  // the hub could not read (event: stale's what, issue #737). Only ever set as text: each backticked run of it a code
  // span (as kit.mjs withCode draws the server's), every other run a text node.
  var staleBody = liveNote && typeof liveNote.querySelector === "function" ? liveNote.querySelector('[data-live-note="stale"] .banner__s') : null;
  var staleData = staleBody ? staleBody.textContent : "";
  function sayWithCode(el, sentence) {
    var parts = String(sentence).split("\x60");
    el.textContent = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (parts[i] !== "") el.appendChild(document.createTextNode(parts[i]));
        continue;
      }
      var code = document.createElement("span");
      code.className = "code";
      code.textContent = parts[i];
      el.appendChild(code);
    }
  }
  // Whether this script dimmed the page: the one stale it takes back, on fresh.
  var staleShown = false;
  function unstale() {
    staleShown = false;
    if (mainEl && mainEl.classList) mainEl.classList.remove("stale");
    unnote("stale");
  }
  if (live && typeof EventSource === "function") {
    var query = document.body.getAttribute("data-query") || "";
    es = new EventSource("/api/events?page=" + encodeURIComponent(live) + (query ? "&" + query : "") + personQuery);
    es.addEventListener("open", function () {
      mark("on");
      unnote("retry");
      // Not the dimming: a stream that opens again says nothing yet about the page's data. The hub's first message on it
      // is its state, fresh or stale (live.mjs), and fresh alone takes the dimming back (issue #737: a tab that
      // reconnected while its data still failed showed Live, undimmed, over panels hours old).
    });
    // A dropped stream the browser reconnects by itself (CONNECTING, 0): Reconnecting. One it CLOSED (2: a 429 over the
    // stream limit, a 401, a 503) it never retries, and only the console can say which it was.
    es.addEventListener("error", function () {
      if (es.readyState === 2) probe({ ok: "limit", ended: null }, false);
      else mark("retry");
    });
    es.addEventListener("panel", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.id !== "string" || typeof msg.html !== "string") return;
      var el = document.getElementById(msg.id);
      if (!el || !el.hasAttribute("data-panel")) return;
      mark("on");
      unnote("retry");
      if (inUse(el)) hold(el, msg.html);
      else swapPanel(el, msg.html);
    });
    es.addEventListener("stale", function (ev) {
      var at = null;
      var tokens = false;
      try {
        var d = JSON.parse(ev.data);
        at = own(d, "since") && typeof d.since === "number" ? d.since : null;
        tokens = own(d, "what") && d.what === "tokens";
      } catch (e) { at = null; }
      // A stale with no time while this page is already dimmed (a lone tab's reconnect: the hub let the view go with its
      // last stream) keeps the time it was told: the panels it holds are still the ones last seen then.
      if (at !== null || !staleShown) since(at);
      staleShown = true;
      if (mainEl && mainEl.classList) mainEl.classList.add("stale");
      if (staleBody) sayWithCode(staleBody, tokens ? STALE_TOKENS_BODY : staleData);
      note("stale");
    });
    es.addEventListener("fresh", function () {
      if (staleShown) unstale();
    });
    es.addEventListener("end", streamEnded);
  }
  // ---- the live transcript (issue #643) ----
  var tbox = document.querySelector("[data-transcript]");
  var tjob = tbox ? tbox.getAttribute("data-job") : null;
  if (tbox && tjob && typeof EventSource === "function") {
    var tstatus = document.querySelector("[data-transcript-status]");
    tmark = function (text, cls) {
      if (!tstatus) return;
      tstatus.textContent = text;
      tstatus.className = "t-status " + cls;
    };
    tes = new EventSource("/api/transcript?id=" + encodeURIComponent(tjob) + personQuery);
    tes.addEventListener("open", function () { tmark("live", "on"); });
    // A transcript stream the browser CLOSED (a 401, a 429, a 503) is asked about as the page's own is (probe): a session
    // that ended goes to sign-in with its reason, another person to sign-in as switched, the console out of reach is
    // asked again; only a 200 for the page's person is the stream limit, said on this line alone.
    var transcriptSays = function (state) {
      tmark(state === "asking" ? "reconnecting" : "not live: reload after closing another console tab", "off");
    };
    tes.addEventListener("error", function () {
      tmark("reconnecting", "off");
      if (tes.readyState === 2) probe({ ok: "limit", ended: null, say: transcriptSays }, false);
    });
    tes.addEventListener("entry", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.html !== "string") return;
      // Follow the bottom only when the reader is already there: one who scrolled up to read keeps their place.
      var atBottom = tbox.scrollHeight - tbox.scrollTop - tbox.clientHeight < 24;
      tbox.insertAdjacentHTML("beforeend", msg.html);
      if (atBottom) tbox.scrollTop = tbox.scrollHeight;
      tmark("live", "on");
    });
    tes.addEventListener("done", function (ev) {
      tes.close();
      var outcome = "unknown";
      try {
        var d = JSON.parse(ev.data);
        if (d && typeof d.outcome === "string") outcome = Object.prototype.hasOwnProperty.call(OUTCOME_WORD, d.outcome) ? OUTCOME_WORD[d.outcome] : d.outcome;
      } catch (e) { /* keep unknown */ }
      tmark("ended (" + outcome + ")", "ended");
    });
    tes.addEventListener("end", streamEnded);
  }
})();
`;
