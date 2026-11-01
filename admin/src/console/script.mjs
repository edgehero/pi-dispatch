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
 * and `data-role`, and every request this script makes on the session's behalf says that person (`<name>.<role>`): the
 * page stream in the `as` query parameter, every preview and confirm in the `x-console-as` header (`session-ends.mjs`
 * `PERSON_PARAM`, `PERSON_HEADER`). The server refuses a request whose person is not the cookie's session (a stream
 * 401, a write 409 with the bar's own refusal), so a browser that signed in as someone else in another tab can neither
 * stream that person's panels into this page nor preview or confirm as them under this page's bar; and a probe whose
 * answer names anyone else goes to `/login?ended=switched`, as the 409 bar's Look again does. A page that does not say
 * who it is sends no person, and is never reloaded into one.
 *
 * AN ANSWER THAT IS NOT A WRITE'S OWN IS NEVER ITS SENTENCE IN THE SLOT. A 401 from a preview or a confirm, or a stream
 * the browser closed, is a session that ended or a browser that is someone else's
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
 *   - the RUNS page (issue #737, PR 4): the search field `#q` (`kit.mjs` `SEARCH_ID`) takes the focus when the page
 *     opens at `#q`, when the fragment changes to it, and when the top bar's Search button (`shell.mjs` `SEARCH_HREF`)
 *     is pressed while the address already ends with it. Every `.filterbar[data-collapsible]` (on any page, and in each
 *     swapped panel) folds on a phone: the script adds `filterbar--collapsible` and shows its `[data-filter-toggle]`,
 *     which opens and closes it and says so in `aria-expanded`; a bar's state is kept by its panel's id across a swap.
 *     Without the script every filter shows and the toggle stays hidden. Every `form.filterbar` (the audit log's too)
 *     sends only its fields in use: its empty fields are disabled while the browser reads the form and enabled a tick
 *     later; without the script they are sent empty, which the page reads as no filter.
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
 *     card grid so the preview remains a full-width bar, using every layout grid marked
 *     `data-slot-after`, so it is never a grid's cell), never inside a panel or a table cell,
 *     titles it "Previewing: <the button's words>" with Confirm disabled, and shows it, scrolled into view by the least
 *     move (`scrollIntoView`, block nearest), the focus on its title (issue #737: the slot can sit a screen away from
 *     the button); every fill while it is open scrolls it into view again, since an answer is taller than the skeleton
 *     it replaces and its Confirm would otherwise land below the fold, and so does every other change this script
 *     makes to the page while the slot shows (a panel swapped, the kept-still note, a live note, the sign-out banner:
 *     `outside`); an answer that replaces what held the focus gives it to the new title, and takes none that was
 *     elsewhere; and closing it gives the focus back to the button that opened it, else, where a swap replaced that
 *     button, to the button of the form with the same action and the same hidden fields in the swapped card, else to
 *     the card that asked, when the focus was in the slot. The answer's `html`
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
 *   - while a form is in use (the slot open for its panel, a field, never a button, focused or changed, its editor
 *     open; a write's form or, since PR 4 of issue #737, a filter bar, a list in it changed too), a live panel holding it
 *     is NOT swapped, so an update cannot wipe a half-made change. The newest html waits
 *     (`pending`), the panel gets the server's kept-still note once (a copy of `<template id="held-note">`, which the
 *     shell draws on every live page for every role, as its first child), and the update is applied when the hold
 *     ends: Cancel or Close, or focus leaving a field that holds no change (a tick later, once focus has landed); a
 *     changed field holds its panel until it is applied (a filter bar's Apply loads the page anew), or set back as it
 *     was drawn and left. A swap never drops the focus: one that held it goes to the same form's button in the new
 *     markup, else a link to the same place, else the panel.
 *   - the run page's LIVE TRANSCRIPT (issue #747; `[data-transcript]`, drawn for an operator only): uses
 *     the page's one `EventSource`. Each `event: entry` carries `{html}`, server-rendered and
 *     escaped, which is APPENDED to that one element (`insertAdjacentHTML("beforeend")`) and nowhere else. The view
 *     follows the bottom unless the operator has scrolled up. `[data-transcript-status]` says "live", "reconnecting",
 *     "ended (<outcome>)", "not live" or "signed out", through `textContent`. `event: tdone` ends the transcript only;
 *     the page connection keeps receiving panels. `event: end` is the session handler (above). A dropped stream reconnects by
 *     itself and resends the last entry's id as `Last-Event-ID`, so nothing is appended twice. One the browser closed
 *     (a 401, a 429, a 503) is asked about with the page stream's probe, saying "reconnecting" on its own line while it
 *     asks: a 401 or another person goes to sign-in, and only a 200 for the page's person is the stream limit,
 *     said on both the page's pill and its transcript status.
 *   - every page's TIMES (issue #710): each `<time datetime>` the server drew (its text the UTC instant) is rewritten to
 *     the reader's local time with its UTC offset, its `title` set to the UTC text, on load and inside each panel a
 *     live update swaps in, with the reader's date before it. A time the server marks `data-day`, whose row names its UTC
 *     day (the runs table's Ended cell, `panels/runs.mjs` `endedHtml`), stays alone where the reader's day is that day
 *     and gains the reader's date where it is not. Without the script a page reads UTC, as it always did.
 * Server text is shown with `textContent`, never as markup. The markup writes are exactly four, all of server-escaped
 * fragments into elements the server marked for them (including the hypothetical checker result): the slot's (`fillSlot`: an answer's `html`, or the skeleton put
 * back), the panel swap (`swapPanel`, behind `data-panel`) and the transcript append.
 *
 * Every browser global past the DOM is checked before it is used (`fetch`, the timers, `requestAnimationFrame`), and
 * nothing calls `fetch` while the page loads: the tests run this script under stubs, where a global they did not stub
 * would be Node's own (its `fetch` reaches the network).
 */
import { PR_ACTIONS } from "@edgehero/pi-dispatch/triggers";
import { CONFIG_FIX_ACTIONS } from "./actions.mjs";
import { FIT_JS } from "../graph-html.mjs";
import { CONFIRM_NO_ANSWER, CONFIRM_SIGNED_OUT, CONFIRM_SLOT_ID } from "./confirm-view.mjs";
import { PAGES } from "./pages.mjs";
import { ENDED_REASONS, NOTICE_OF_STATUS, PERSON_HEADER, PERSON_PARAM, STREAM_ENDS, STREAM_SHUTDOWN } from "./session-ends.mjs";
import { SEARCH_ID } from "./kit.mjs";
import { LIVE_NOTES, LIVE_STATES, SEARCH_HREF } from "./shell.mjs";
import { SYSTEM_SCHEME, THEME_COOKIE, THEME_COOKIE_MAX_AGE_SEC, THEME_COOKIE_SAME_SITE, THEME_LABELS, THEMES } from "./theme.mjs";

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
  var CONFIG_FIX_ACTIONS = ${JSON.stringify(CONFIG_FIX_ACTIONS)};
  // The console's outcome words (words.mjs, issue #710), written in from the one table: a stream's end says "refused",
  // never the record's "policy". An outcome not in it shows as itself.
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
    endSetupPrivate();
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
  function post(path, body, mine, signal) {
    if (typeof fetch !== "function") return Promise.reject(new Error("this browser cannot send a request"));
    var headers = { "content-type": "application/json" };
    if (mine && pagePerson !== null) headers[PERSON_HEADER] = pagePerson;
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: headers,
      body: JSON.stringify(body),
      ...(signal ? { signal: signal } : {})
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
  // The reader's date leads the time, so no time is read against the wrong day. Only a <time data-day>, whose row
  // names its UTC day (the runs table's Ended cell under its day's row), stays a time alone, and only where the
  // reader's day is that UTC day. The form is the attribute's and the datetime's, never the text's, so a second run
  // keeps the first's.
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
    var day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    var alone = el.getAttribute("data-day") !== null && day === iso.slice(0, 10);
    el.textContent = (alone ? "" : day + " ") + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " " + zone;
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
    outside(function () {
      if (bar && typeof bar.after === "function") bar.after(outNote);
      else main.insertBefore(outNote, main.firstChild);
    });
  }
  // The newest press, and its timer: a press clears the one before it, so an earlier press's timer or late answer never
  // says "not confirmed" (and stops the signing out) under a later press still waiting for its own.
  var outPress = 0;
  var outTimer = null;
  if (out) out.addEventListener("click", function () {
    signingOut = true;
    endSetupPrivate();
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
  // ---- the runs page (issue #737): the search field the Search button opens, and the filter bar's fold ----
  // The top bar's Search button is a link to the runs page's search field (shell.mjs SEARCH_HREF): a fragment scrolls
  // to the field but focuses nothing, so the runs page puts the focus in it when it opens at that fragment, when the
  // fragment changes to it (the button pressed on the runs page itself, which loads nothing) and when the button is
  // pressed while the address already ends with it (which fires no hashchange). Nothing is focused otherwise: a page
  // that takes the focus on load moves a screen reader's place.
  var SEARCH_HASH = ${JSON.stringify(`#${SEARCH_ID}`)};
  var SEARCH_HREF = ${JSON.stringify(SEARCH_HREF)};
  function focusSearch() {
    var field = document.getElementById(${JSON.stringify(SEARCH_ID)});
    if (field && typeof field.focus === "function") field.focus();
  }
  if (page === "runs") {
    try { if (location.hash === SEARCH_HASH) focusSearch(); } catch (e) { /* the field stays unfocused */ }
    if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") window.addEventListener("hashchange", function () {
      if (location.hash === SEARCH_HASH) focusSearch();
    });
    document.addEventListener("click", function (e) {
      var a = e && e.target && typeof e.target.closest === "function" ? e.target.closest("a[href]") : null;
      if (a && a.getAttribute("href") === SEARCH_HREF && location.hash === SEARCH_HASH) focusSearch();
    });
  }
  // A filter bar marked data-collapsible folds on a phone: with filterbar--collapsible bundle.css shows only its search
  // and its toggle there (and the whole bar above a phone, where it hides the toggle), and the toggle, drawn hidden
  // (kit.mjs filterToggle), opens and closes it, saying which in aria-expanded. Without this script the class is never
  // set and the toggle never shown, so every filter shows. Whether a bar is open is kept by its panel's id: a live
  // update that swaps the panel (its counts changed) draws the bar folded, and swapPanel folds it again as the person
  // left it.
  var filtersOpen = Object.create(null);
  function foldBars(root) {
    var bars = root && typeof root.querySelectorAll === "function" ? root.querySelectorAll(".filterbar[data-collapsible]") : [];
    for (var i = 0; i < bars.length; i++) foldBar(bars[i]);
  }
  function foldBar(bar) {
    var toggle = typeof bar.querySelector === "function" ? bar.querySelector("[data-filter-toggle]") : null;
    if (!toggle || !bar.classList || typeof toggle.addEventListener !== "function") return;
    var panel = typeof bar.closest === "function" ? bar.closest("[data-panel]") : null;
    var key = panel && panel.id ? panel.id : "";
    var set = function (open) {
      filtersOpen[key] = open;
      if (open) bar.classList.remove("filterbar--collapsible");
      else bar.classList.add("filterbar--collapsible");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    set(filtersOpen[key] === true);
    toggle.hidden = false;
    toggle.addEventListener("click", function () { set(filtersOpen[key] !== true); });
  }
  try { foldBars(document); } catch (e) { /* every filter stays shown */ }
  // A filter bar's GET (the runs page's, the audit log's) carries only the fields in use: each named field that is
  // empty, a list left at "Any" included, is disabled as the form is sent, and a disabled control is not sent, so the
  // address reads /runs?outcome=failed rather than every field of the bar with no value. A tick later, once the browser
  // has read the form, each is enabled again, so a page brought back by Back works as it was left. Without this script
  // the empty fields are sent too, and the page reads an empty field as no filter.
  var modelEdits = typeof document.querySelectorAll === "function" ? document.querySelectorAll("[data-model-edit]") : [];
  for (var mi = 0; mi < modelEdits.length; mi++) (function (link) {
    link.addEventListener("click", function (ev) {
      var target = document.getElementById(link.getAttribute("data-model-edit"));
      if (!target || target.tagName.toLowerCase() !== "details") return;
      ev.preventDefault(); target.open = true;
      target.scrollIntoView({ block: "nearest" });
      var control = target.querySelector("input:not([type=hidden])");
      if (control) control.focus();
    });
  })(modelEdits[mi]);
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (ev.defaultPrevented || !form || typeof form.matches !== "function" || !form.matches("form.filterbar")) return;
    var els = form.elements || [];
    var off = [];
    for (var i = 0; i < els.length; i++) {
      if (els[i].name && !els[i].disabled && els[i].value === "") {
        els[i].disabled = true;
        off.push(els[i]);
      }
    }
    if (off.length > 0) later(function () { for (var j = 0; j < off.length; j++) off[j].disabled = false; }, 0);
  });
  // ---- the spend screen: chart tooltips and the interactive topology ----
  if (page === "insights" || (typeof page === "string" && page.indexOf("insights-") === 0)) {
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
        NODES[nid] = { trigger: items[b].getAttribute("data-trigger-index"), tip: items[b].textContent, nb: words(items[b].getAttribute("data-nb"), /^n\\d{1,6}$/), w: words(items[b].getAttribute("data-w"), /^w\\d{1,6}$/) };
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
      var zoom = e.target && e.target.closest ? e.target.closest("[data-graph-zoom]") : null;
      if (zoom && svg && root) { graphZoom(zoom.getAttribute("data-graph-zoom")); return; }
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
    var baseX = vb.x;
    var baseY = vb.y;
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
    function updateSelected(id) {
      if (!document.body || document.body.getAttribute("data-page") !== "insights-flows") return;
      var entry = id ? ownNode(id) : null;
      var panel = document.querySelector("[data-selected-details]");
      var empty = document.querySelector("[data-selected-empty]");
      var templates = document.querySelectorAll("template[data-trigger-details]");
      if (panel) {
        while (panel.firstChild) panel.removeChild(panel.firstChild);
        for (var i = 0; entry && i < templates.length; i++) {
          if (templates[i].getAttribute("data-trigger-details") === entry.trigger) panel.appendChild(templates[i].content.cloneNode(true));
        }
        panel.hidden = !panel.firstChild;
        if (empty) empty.hidden = !!panel.firstChild;
      }
      var chips = svg.querySelectorAll(".gnode");
      for (var i = 0; i < chips.length; i++) chips[i].setAttribute("aria-pressed", chips[i].id === id ? "true" : "false");
      var url = new URL(location.href);
      if (entry && entry.trigger !== null) url.searchParams.set("select", entry.trigger);
      else url.searchParams.delete("select");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
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
      updateSelected(id);
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
      if (el) { if (selected === el.id) { clearSel(); updateSelected(null); } else select(el.id); }
      else { clearSel(); updateSelected(null); }
    });
    svg.addEventListener("keydown", function (e) {
      var el = nodeAt(e);
      if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(el.id); }
    });
    function graphZoom(mode) {
      if (mode === "fit") { vb.x = baseX; vb.y = baseY; vb.width = baseW; vb.height = baseH; }
      else {
        var factor = mode === "in" ? 1.25 : mode === "out" ? 0.8 : 1;
        var width = clamp(vb.width / factor, baseW / ZOOM_MAX, baseW / ZOOM_MIN);
        var ratio = width / vb.width;
        vb.x += (vb.width - width) / 2; vb.y += vb.height * (1 - ratio) / 2;
        vb.width = width; vb.height *= ratio;
      }
      scheduleHash();
    }
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { clearSel(); updateSelected(null); } });
    // Last, and guarded: the fragment is anyone's to write, and a throw from it must not escape insightsPage() and take
    // the rest of this script (the action forms, the live stream) down with it. The view stays as drawn.
    var initial = typeof svg.querySelector === "function" ? svg.querySelector('.gnode[aria-pressed="true"]') : null;
    if (initial) select(initial.id);
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
  // The button that opened the slot and the card that asked (slotCard), where closing it gives the focus back, and how
  // to find that button again in the card once a swap has replaced it (slotFind, from formKey).
  var slotOpener = null;
  var slotCardEl = null;
  var slotFind = null;
  var slotAction = null;
  var slotLabel = "";
  var slotTicket = null;
  var slotBody = null;
  var slotPreviewController = null;
  function abortSetupPreview() {
    if (slotPreviewController) slotPreviewController.abort();
    slotPreviewController = null;
  }
  var setupPrivateEnded = false;
  var setupInviteBox = null;
  var setupInviteTimer = null;
  function clearProviderKeyFields() {
    var fields = typeof document.querySelectorAll === "function" ? document.querySelectorAll('form[data-provider-key-form] input[name="value"]') : [];
    for (var pk = 0; pk < fields.length; pk++) fields[pk].value = "";
  }
  function endSetupPrivate() {
    setupPrivateEnded = true;
    clearProviderKeyFields();
    forgetSetupInvitation();
    // Invalidate in-flight previews too, so a late reply cannot restore Confirm after navigation or sign-out.
    if (slot && typeof slotAction === "string" && slotAction.indexOf("setup-") === 0) closeSlot();
  }
  if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", endSetupPrivate);
    window.addEventListener("pageshow", function (ev) { if (ev.persisted) location.reload(); });
  }
  function forgetSetupInvitation() {
    if (setupInviteTimer !== null && typeof clearTimeout === "function") clearTimeout(setupInviteTimer);
    setupInviteTimer = null;
    if (setupInviteBox) setupInviteBox.textContent = "This private invitation is no longer shown. Ask for a new link on the host if needed.";
    setupInviteBox = null;
  }
  function cancelSetupTicket() {
    if (!slotTicket || typeof slotAction !== "string" || slotAction.indexOf("setup-") !== 0) return;
    var ticket = slotTicket, action = slotAction;
    slotTicket = null;
    post("/api/act/" + action + "/cancel", { ticket: ticket }, true).catch(function () { /* expiry and session cleanup remain the backstop */ });
  }
  function showSetupInvitation(invitation, started, viewer) {
    if (setupPrivateEnded || signingOut || !invitation || typeof invitation.href !== "string" || !(new RegExp("^/login/code#[A-Za-z0-9_-]{43}&next=/setup$")).test(invitation.href)) return false;
    var href;
    try {
      var address = new URL(invitation.href, location.href);
      if (address.origin !== location.origin || (address.protocol !== "http:" && address.protocol !== "https:")) return false;
      href = address.href;
    } catch (e) { return false; }
    forgetSetupInvitation();
    slotSays("Viewer created. Copy this one-use link privately; it is good for at most 60 seconds. The viewer needs a route or their own tunnel to this console.");
    var message = inSlot("[data-slot-message]");
    if (!message || typeof document.createElement !== "function") return false;
    var box = document.createElement("div");
    box.setAttribute("data-setup-invitation", "");
    box.setAttribute("role", "status");
    var command = document.createElement("div"); command.className = "cmd";
    var code = document.createElement("code"); code.textContent = href;
    var copy = document.createElement("button"); copy.setAttribute("type", "button"); copy.hidden = true;
    copy.setAttribute("data-copy", ""); copy.className = "btn btn--sm"; copy.textContent = "Copy invitation";
    command.appendChild(code); command.appendChild(copy); box.appendChild(command);
    if (viewer && typeof viewer.name === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(viewer.name) && typeof viewer.identity === "string" && /^[0-9a-f]{32}$/.test(viewer.identity)) {
      var revoke = document.createElement("form"); revoke.setAttribute("data-action", "setup-viewer-revoke"); revoke.setAttribute("data-setup-revoke", ""); revoke.className = "su-act";
      for (var field of ["name", "identity"]) {
        var hidden = document.createElement("input"); hidden.setAttribute("type", "hidden"); hidden.setAttribute("name", field); hidden.setAttribute("value", viewer[field]); revoke.appendChild(hidden);
      }
      var undo = document.createElement("button"); undo.setAttribute("type", "submit"); undo.className = "btn btn--ghost btn--sm"; undo.textContent = "Preview revoking this viewer"; revoke.appendChild(undo); box.appendChild(revoke);
    }
    message.after(box);
    setupInviteBox = box;
    copyButtons(box);
    // Subtract the whole request round trip, a conservative lifetime that does not trust a browser/server clock offset.
    var remaining = Math.max(0, 60000 - Math.max(0, Date.now() - started));
    setupInviteTimer = later(forgetSetupInvitation, remaining);
    slotDisable("[data-cancel]", false);
    return true;
  }

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
  // The slot's title takes the focus (issue #737): wherever slotAnchor put the slot, which on a page of laid-out cards
  // can be a screen away from the button that asked, a keyboard and a screen reader go on from the slot, never from the
  // page's top. The skeleton's title, else a bar's heading, else the results banner's; a heading is no control, so it
  // is made focusable by script alone (tabindex -1) and never enters the tab order. The scroll is slotInView's.
  function focusTitle() {
    var t = inSlot("[data-slot-title]") || inSlot(".confirm__h") || inSlot(".banner__t");
    if (!t || typeof t.focus !== "function") return;
    if (typeof t.hasAttribute === "function" && typeof t.setAttribute === "function" && !t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
    try { t.focus({ preventScroll: true }); } catch (e) { /* focus stays where it was */ }
  }
  // The slot brought into view by the least scroll that shows it (block: nearest), where the browser has the call.
  function slotInView() {
    if (typeof slot.scrollIntoView === "function") {
      try { slot.scrollIntoView({ block: "nearest" }); } catch (e) { /* the page stays where it is */ }
    }
  }
  // Whether the slot is open and some part of it is inside the window, where the browser can say; one that cannot is
  // taken to show it.
  function slotShows() {
    if (!slot || slot.hidden) return false;
    if (typeof slot.getBoundingClientRect !== "function" || typeof innerHeight !== "number") return true;
    var r = slot.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  }
  // EVERY CHANGE THIS SCRIPT MAKES OUTSIDE THE OPEN SLOT BRINGS IT INTO VIEW AGAIN (issue #737), as every fill does: a
  // panel swapped (above the slot, its height is the slot's place), the kept-still note put into the panel the slot
  // holds, a live note shown or hidden, the stale note's words, the sign-out banner. Each moves what is under it, and
  // the slot with its Confirm went below the fold a moment after the answer: at 1440 px the Hosts card, which changes
  // every tick, took its kept-still note about 200 ms after the answer and pushed Pause's Confirm from 956 to 1020 px
  // of a 1000 px window. Only where the slot showed before the change: a reader who scrolled it wholly out of view to
  // read another card keeps their place (on the overview the Hosts card changes every tick, and every tick would pull
  // them back). What changes no one's place is left out: the live pill's word and the transcript's status line (one
  // line each), a countdown inside the slot, and the transcript, which is drawn after every card that opens the slot.
  var changing = 0;
  function outside(change) {
    if (changing > 0) return change();
    var shows = slotShows();
    changing += 1;
    try { change(); } finally { changing -= 1; }
    if (shows) slotInView();
  }
  // A fill replaces what held the focus, and a browser then hands it to the page's body: focus that was in the slot
  // goes to its new title, so an answer arriving never takes the reader's place away. edit is what the caller writes
  // into the new markup (slotSays' sentence) before either is decided.
  //
  // EVERY FILL WHILE THE SLOT IS OPEN BRINGS IT INTO VIEW AGAIN (issue #737). The scroll at open measured the skeleton;
  // an answer is taller (a list, a diff, a reserve line), and with the slot near the fold its Confirm landed below it
  // (on a phone, Retry's Confirm sat wholly under the screen's edge), so the reader saw a slot with nothing to press. The
  // least scroll (block nearest) moves nothing when the answer already shows whole.
  function refill(markup, edit) {
    var had = typeof slot.contains === "function" && document.activeElement ? slot.contains(document.activeElement) : false;
    fillSlot(markup);
    if (typeof edit === "function") edit();
    if (had) focusTitle();
    if (!slot.hidden) slotInView();
  }
  // An answer's bar into the slot, and whether its Look again leads to sign-in (slotEnded, above).
  function answerBar(b) {
    slotEnded = own(b, "ended") && isReason(b.ended) ? b.ended : null;
    refill(b.html);
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
  // every layout grid it sits in that says so (data-slot-after: a row of cards, where the slot would be one more
  // cell), to after the outermost. A column with no such mark keeps the slot right under its card.
  function slotCard(form) {
    return (typeof form.closest === "function" && (form.closest("section[data-panel]") || form.closest(".banner"))) || form;
  }
  function slotAnchor(form) {
    var anchor = slotCard(form);
    for (var at = anchor.parentElement; at; at = at.parentElement) if (typeof at.hasAttribute === "function" && at.hasAttribute("data-slot-after")) anchor = at;
    return anchor;
  }
  function openSlot(form, action, label, opener) {
    abortSetupPreview();
    cancelSetupTicket();
    forgetSetupInvitation();
    stopCountdown();
    slotGen += 1;
    fillSlot(skeleton);
    var title = inSlot("[data-slot-title]");
    if (title) title.textContent = "Previewing: " + label;
    slotDisable("[data-confirm]", true);
    var anchor = slotAnchor(form);
    if (typeof anchor.after === "function") anchor.after(slot);
    slot.hidden = false;
    slotInView();
    focusTitle();
    var was = slotOwner;
    slotOwner = typeof form.closest === "function" ? form.closest("section[data-panel]") : null;
    slotForm = form;
    slotOpener = opener || null;
    slotCardEl = slotCard(form);
    slotFind = formKey(form, action, slotOpener);
    slotAction = action;
    slotLabel = label;
    slotTicket = null;
    slotEnded = null;
    // The slot moved on from another panel: that one is no longer held by it.
    if (was && was !== slotOwner) release();
    return slotGen;
  }
  // Whether el is still in the page: a panel the stream swapped has new nodes, and its old button is in none.
  function inPage(el) {
    return Boolean(el) && typeof document.contains === "function" && document.contains(el);
  }
  // A form as the slot can find it again: its action, its hidden fields as drawn (name and value, in order), and which
  // of its submit buttons opened the slot (-1 for none of them).
  function formKey(form, action, opener) {
    var fields = [];
    var hidden = typeof form.querySelectorAll === "function" ? form.querySelectorAll("input[type=hidden]") : [];
    for (var i = 0; i < hidden.length; i++) fields.push([hidden[i].name, hidden[i].value]);
    var buttons = typeof form.querySelectorAll === "function" ? form.querySelectorAll("button[type=submit]") : [];
    var at = -1;
    for (var j = 0; j < buttons.length; j++) if (buttons[j] === opener) at = j;
    return { action: action, fields: JSON.stringify(fields), at: at };
  }
  // The button in the card that does what the opener did: in the form with the opener's action and the same hidden
  // fields, the button at the opener's place (else its first submit button); null where the card holds no such form.
  function sameButton(card, find) {
    if (!find || typeof card.querySelectorAll !== "function" || !/^[a-z0-9-]{1,40}$/.test(find.action)) return null;
    var forms = card.querySelectorAll('form[data-action="' + find.action + '"]');
    for (var i = 0; i < forms.length; i++) {
      var key = formKey(forms[i], find.action, null);
      if (key.fields !== find.fields) continue;
      var buttons = forms[i].querySelectorAll("button[type=submit]");
      return buttons[find.at] || buttons[0] || null;
    }
    return null;
  }
  // The focus back where the reader was before the slot opened (issue #737): the button that opened it; else, when the
  // stream swapped that button's panel while the slot held it, the same button in the swapped card (sameButton: on
  // the overview the Hosts card is drawn anew on every tick, so its button was always replaced and the focus always
  // fell to the card); else the card that asked, focusable by script alone as the slot's title is. Without it, Close
  // and Cancel removed the control that held the focus and the browser gave it to the page's body, so the next Tab
  // started from the top of the page, in another panel.
  function focusBack(opener, card, find) {
    var to = inPage(opener) ? opener : inPage(card) ? sameButton(card, find) || card : null;
    if (!to || typeof to.focus !== "function") return;
    if (to === card && typeof to.hasAttribute === "function" && typeof to.setAttribute === "function" && !to.hasAttribute("tabindex")) to.setAttribute("tabindex", "-1");
    try { to.focus(); } catch (e) { /* the focus stays on the page */ }
  }
  function closeSlot() {
    abortSetupPreview();
    cancelSetupTicket();
    forgetSetupInvitation();
    slotBody = null;
    // Asked before the fill takes what holds it. In the slot, or on nothing (a browser that does not focus a button on
    // a click, Safari's, leaves the body focused when Cancel is pressed): never focus the reader put elsewhere.
    var active = document.activeElement;
    var had = !active || active === document.body || (typeof slot.contains === "function" && slot.contains(active));
    var opener = slotOpener;
    var card = slotCardEl;
    var find = slotFind;
    stopCountdown();
    slotGen += 1;
    fillSlot(skeleton);
    slot.hidden = true;
    slotOwner = null;
    slotForm = null;
    slotOpener = null;
    slotCardEl = null;
    slotFind = null;
    slotAction = null;
    slotTicket = null;
    slotEnded = null;
    // The held panels first: the release decides whether the button is still in the page, or which one replaced it.
    release();
    if (had) focusBack(opener, card, find);
  }
  // A sentence of this script's own (or a refusal's text with no bar to show it in) in the skeleton's message line: the
  // bar's title is the button's words, its grey lines and busy mark go, Confirm stays disabled and Cancel closes it.
  function slotSays(text) {
    stopCountdown();
    refill(skeleton, function () {
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
    });
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
      cancelSetupTicket();
      slotTicket = null;
      slotDisable("[data-confirm]", true);
    };
    tick();
    countdown = setInterval(tick, 1000);
  }
  // The button that sent the form: the event's submitter when it is the form's own, else the form's submit button.
  function submitterOf(form, ev) {
    return ev && ev.submitter && typeof form.contains === "function" && form.contains(ev.submitter) ? ev.submitter : form.querySelector("button[type=submit]");
  }
  function submitText(form, ev) {
    var b = submitterOf(form, ev);
    var t = b ? String(b.textContent || "").replace(/\\s+/g, " ").trim() : "";
    // A round button is its icon: its name is its aria-label, never the action's machine name.
    if (!t && b && typeof b.getAttribute === "function") t = String(b.getAttribute("aria-label") || "").trim();
    return t || form.getAttribute("data-action") || "";
  }
  function preview(form, action, label, opener) {
    var mine = openSlot(form, action, label, opener);
    var body;
    fieldErrors(form, null);
    try { body = bodyOf(form); } catch (e) { fieldErrors(form, e.message); slotSays(e.message + "; nothing was sent."); return; }
    var privateKey = action === "setup-provider-key" || action === "setup-provider-key-replace";
    slotBody = privateKey ? null : body;
    if (privateKey && typeof form.querySelector === "function") {
      var keyField = form.querySelector('input[name="value"]');
      if (keyField) keyField.value = "";
    }
    var becauseRun = document.body.getAttribute("data-because-run");
    if (becauseRun && CONFIG_FIX_ACTIONS.indexOf(action) >= 0) body.becauseRun = becauseRun;
    var controller = action.indexOf("setup-") === 0 && typeof AbortController === "function" ? new AbortController() : null;
    slotPreviewController = controller;
    var previewRequest = post("/api/act/" + action + "/preview", body, true, controller ? controller.signal : undefined);
    if (privateKey) body.value = undefined;
    previewRequest.then(function (r) {
      if (slotPreviewController === controller) slotPreviewController = null;
      if (mine !== slotGen) {
        if (action.indexOf("setup-") === 0 && r.ok && r.body && typeof r.body.ticket === "string") post("/api/act/" + action + "/cancel", { ticket: r.body.ticket }, true).catch(function () {});
        return;
      }
      var b = r.body || {};
      if (signedOut(r)) return;
      if (!r.ok) fieldErrors(form, b.refusal || b.error || errorOf(r));
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
      if (slotPreviewController === controller) slotPreviewController = null;
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
    var confirmStarted = Date.now();
    post("/api/act/" + slotAction + "/confirm", { ticket: ticket }, true).then(function (c) {
      if (mine !== slotGen) return;
      var b = c.body || {};
      if (c.ok) {
        if (slotAction === "setup-viewer-add" && b.invitation) {
          if (!showSetupInvitation(b.invitation, confirmStarted, b.viewer)) slotSays("The viewer was created, but the private invitation could not be displayed safely. Mint a new link on the host; do not add the viewer again.");
          return;
        }
        // Adoption is a distinct human act. Keep the exact confirmed reply in memory, never in a URL or storage,
        // and open its own editor rather than silently turning an answer into standing policy.
        var keep = slotAction === "parked-answer" && slotForm && slotForm.querySelector("[data-keep-standing]");
        var adoption = keep && keep.checked && document.querySelector("[data-standing-adoption]");
        if (adoption && slotBody && typeof slotBody.text === "string") {
          var adoptedText = adoption.querySelector("textarea[name=text]");
          if (adoptedText) adoptedText.value = slotBody.text;
          adoption.open = true;
          closeSlot();
          var adoptedTitle = adoption.querySelector("input[name=title]");
          if (adoptedTitle) adoptedTitle.focus();
          return;
        }
        var refused = false;
        if (b.results && b.results.length) for (var i = 0; i < b.results.length; i++) if (b.results[i] && b.results[i].ok === false) refused = true;
        if (refused && typeof b.html === "string") refill(b.html);
        else if (typeof b.requestId === "string" && /^sb-[0-9a-f]{32}$/.test(b.requestId) && typeof b.host === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(b.host)) location.assign("/runs/sandboxes?request=" + encodeURIComponent(b.requestId) + "&host=" + encodeURIComponent(b.host));
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
    else if (t.hasAttribute("data-again")) { if (slotForm) preview(slotForm, slotAction, slotLabel, slotOpener); }
    else if (t.hasAttribute("data-reload")) { if (!t.hasAttribute("href")) { if (slotEnded !== null) toLogin(slotEnded); else location.reload(); } }
    else closeSlot();
  });
  // ---- held panels: a form in use is never swapped away under the person using it ----
  // A control a person types into or picks from (a text field, a text area, a list), never a button: a button holds
  // nothing half made. A focused button held its panel, and since closing the slot gives the focus back to the button
  // that opened it, the panel took no update after Cancel and said "Updates paused while you edit" over a card no one
  // was editing, until a click elsewhere moved the focus.
  function isField(el) {
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag !== "input") return false;
    var t = String(el.type || "text").toLowerCase();
    return t !== "hidden" && t !== "submit" && t !== "button" && t !== "reset" && t !== "image";
  }
  // In use, and so held: the slot open for this panel, an editor open in it, or one of its forms' fields focused or
  // changed from what the server drew. Nothing else. A form is a write's (form[data-action]) or a page's filter bar
  // (form.filterbar, issue #737: the runs filters are a live panel whose counts change, and a swap would wipe a search
  // half typed or a list chosen and not yet applied, and take the focus out of the field).
  // Explicit data-live-hold opts native GET pickers into the same rule without giving them filterbar styling.
  var HELD_FORMS = "form[data-action], form.filterbar, form[data-live-hold]";
  function inUse(panel) {
    if (slot && !slot.hidden && slotOwner === panel) return true;
    if (panel.querySelector("details[open] form[data-action]")) return true;
    var active = document.activeElement;
    if (active && panel.contains(active) && isField(active) && active.closest && active.closest(HELD_FORMS)) return true;
    var fields = panel.querySelectorAll("form[data-action] input:not([type=hidden]), form[data-action] textarea, form.filterbar input:not([type=hidden]), form[data-live-hold] input:not([type=hidden]), form[data-live-hold] textarea");
    for (var i = 0; i < fields.length; i++) if (fields[i].type === "checkbox" ? fields[i].checked !== fields[i].defaultChecked : fields[i].value !== fields[i].defaultValue) return true;
    var lists = panel.querySelectorAll("form.filterbar select, form[data-live-hold] select, form[data-provider-key-form] select");
    for (var j = 0; j < lists.length; j++) if (picked(lists[j])) return true;
    return false;
  }
  // Whether a list's choice is not the one the server drew (the option it marked selected, else the first).
  function picked(list) {
    var options = list.querySelectorAll("option");
    var drawn = null;
    for (var i = 0; i < options.length; i++) if (options[i].hasAttribute("selected")) drawn = options[i];
    drawn = drawn || options[0] || null;
    return drawn !== null && list.value !== (drawn.hasAttribute("value") ? drawn.getAttribute("value") : drawn.textContent);
  }
  // The newest update waits, and the panel says so once, with the server's own note.
  function hold(el, markup) {
    pending[el.id] = markup;
    if (heldNoted[el.id]) return;
    heldNoted[el.id] = true;
    var tpl = document.getElementById("held-note");
    var copy = tpl && tpl.content && typeof tpl.content.cloneNode === "function" ? tpl.content.cloneNode(true) : null;
    if (copy && typeof el.insertBefore === "function") outside(function () { el.insertBefore(copy, el.firstChild); });
  }
  // The ONE panel swap, for a stream's panel and a held one's update alike. IT NEVER DROPS THE FOCUS (issue #737): a
  // focused button holds no panel, so the swap replaces it and the browser hands the focus to the page's body. On the
  // overview the Hosts card is drawn anew on every tick, so a keyboard reader on its Pause buttons was sent back to the
  // top of the page each tick and never reached the rows past the first.
  function swapPanel(el, markup) {
    delete pending[el.id];
    delete heldNoted[el.id];
    var keep = focusIn(el);
    outside(function () {
      el.innerHTML = markup;
      // This panel's fresh server state is authoritative (including expiry/not-kept reasons). A previous entry's
      // connection status must not overwrite it when question/tail slots are refilled after another panel swap.
      if (el.id === "p-transcript") tstate = null;
      try { enableAnswererControls(el); enableConfigControls(el); } catch (e) { /* actions remain disabled if they cannot be armed */ }
      try { localTimes(el); } catch (e) { /* the swapped panel's times stay UTC */ }
      try { copyButtons(el); } catch (e) { /* the swapped panel's Copy buttons stay hidden */ }
      try { foldBars(el); } catch (e) { /* the swapped panel's filters stay shown */ }
      try { fillRunSlots(); } catch (e) { /* transcript entries remain in their static box */ }
    });
    if (keep) keepFocus(el, keep);
  }
  // What holds the focus inside el, as new markup can find it again: a form's control by its form (formKey), else a
  // link by its href; null when the focus is elsewhere or on el itself.
  function focusIn(el) {
    var active = document.activeElement;
    if (!active || active === el || typeof el.contains !== "function" || !el.contains(active)) return null;
    var form = typeof active.closest === "function" ? active.closest("form[data-action]") : null;
    var href = !form && typeof active.getAttribute === "function" ? active.getAttribute("href") : null;
    var toggle = !form && typeof active.hasAttribute === "function" && active.hasAttribute("data-filter-toggle");
    return { el: active, find: form ? formKey(form, form.getAttribute("data-action") || "", active) : null, href: href, toggle: toggle };
  }
  // focusBack's rule after a swap: the same form's button, else a link to the same place, else (a filter bar's toggle)
  // the new bar's toggle, else the panel itself, focusable by script alone. Without scrolling: the reader's place is
  // theirs.
  function keepFocus(el, keep) {
    if (inPage(keep.el)) return;
    var to = keep.find ? sameButton(el, keep.find) : keep.href !== null ? sameLink(el, keep.href) : keep.toggle && typeof el.querySelector === "function" ? el.querySelector("[data-filter-toggle]") : null;
    to = to || el;
    if (typeof to.focus !== "function") return;
    if (to === el && typeof to.hasAttribute === "function" && typeof to.setAttribute === "function" && !to.hasAttribute("tabindex")) to.setAttribute("tabindex", "-1");
    try { to.focus({ preventScroll: true }); } catch (e) { /* the focus stays on the page */ }
  }
  function sameLink(el, href) {
    var links = typeof el.querySelectorAll === "function" ? el.querySelectorAll("a[href]") : [];
    for (var i = 0; i < links.length; i++) if (links[i].getAttribute("href") === href) return links[i];
    return null;
  }
  // Every held panel no longer in use takes its newest update.
  function release() {
    for (var id in pending) {
      var el = document.getElementById(id);
      if (!el || !el.hasAttribute("data-panel")) delete pending[id];
      else if (!inUse(el)) swapPanel(el, pending[id]);
    }
  }
  // Focus leaving a field ends that hold once focus has landed (a tick later: during focusout it has not yet moved). On
  // every page, the slot or none: a viewer's runs filters are held too.
  document.addEventListener("focusout", function () { later(release, 0); });
  // Shares describe the draft in these fields, not the plan currently in force. Keep them together while editing.
  document.addEventListener("input", function (event) {
    var el = event.target;
    var form = el && typeof el.closest === "function" ? el.closest('form[data-structured="priorities"]') : null;
    if (!form || !el.name || el.name.indexOf("weight:") !== 0) return;
    var weights = Object.create(null), sum = 0, valid = true;
    for (var i = 0; i < form.elements.length; i++) {
      var field = form.elements[i];
      if (!field.name || field.name.indexOf("weight:") !== 0) continue;
      var n = Number(field.value);
      if (field.value === "" || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > 1000) valid = false;
      else { weights[field.name.slice(7)] = n; sum += n; }
    }
    var outputs = form.querySelectorAll("[data-weight-share]");
    for (var i = 0; i < outputs.length; i++) {
      var weight = weights[outputs[i].getAttribute("data-weight-share")];
      outputs[i].textContent = valid && weight !== undefined ? "about " + (sum > 0 ? Math.round(weight / sum * 100) : 0) + "%" : "Share unknown";
    }
  });
  function enableAnswererControls(root) {
    var controls = typeof root.querySelectorAll === "function" ? root.querySelectorAll("[data-answerer-control]") : [];
    for (var ac = 0; ac < controls.length; ac++) controls[ac].disabled = false;
  }
  enableAnswererControls(document);
  function enableConfigControls(root) {
    var controls = typeof root.querySelectorAll === "function" ? root.querySelectorAll("[data-config-controls]") : [];
    for (var ci = 0; ci < controls.length; ci++) controls[ci].disabled = false;
    var keyForms = typeof root.querySelectorAll === "function" ? root.querySelectorAll("form[data-provider-key-form]") : [];
    for (var kf = 0; kf < keyForms.length; kf++) syncProviderKeyForm(keyForms[kf], false);
  }
  enableConfigControls(document);
  function syncProviderKeyForm(form, discardInput) {
    if (!form || typeof form.querySelector !== "function") return;
    var provider = form.querySelector('[name="provider"]');
    var mode = form.querySelector("[data-provider-key-mode]");
    var key = form.querySelector('input[name="value"]');
    if (!provider || !mode) return;
    if (discardInput) {
      if (key) key.value = "";
      // Closing also invalidates in-flight replies; their eventual tickets are cancelled on arrival.
      if (slotForm === form && slot && !slot.hidden) closeSlot();
      fieldErrors(form, null);
    }
    var replace = mode.value === "replace";
    form.setAttribute("data-action", replace ? "setup-provider-key-replace" : "setup-provider-key");
    var submit = form.querySelector("[data-provider-key-submit]");
    if (submit) submit.textContent = replace ? "Preview replacing key" : "Preview adding key";
    var contexts = form.querySelectorAll("[data-provider-context]");
    for (var pc = 0; pc < contexts.length; pc++) contexts[pc].hidden = contexts[pc].getAttribute("data-provider-context") !== provider.value;
  }
  document.addEventListener("change", function (ev) {
    var control = ev && ev.target;
    var form = control && typeof control.closest === "function" ? control.closest("form[data-provider-key-form]") : null;
    if (form && (control.name === "provider" || control.hasAttribute("data-provider-key-mode"))) syncProviderKeyForm(form, true);
  });
  document.addEventListener("click", function (ev) {
    var button = ev && ev.target && typeof ev.target.closest === "function" ? ev.target.closest("[data-provider-pick]") : null;
    if (!button || button.disabled) return;
    var form = document.querySelector("form[data-provider-key-form]");
    if (!form) return;
    var provider = form.querySelector('[name="provider"]'), mode = form.querySelector("[data-provider-key-mode]");
    if (!provider || !mode) return;
    provider.value = button.getAttribute("data-provider-pick");
    mode.value = button.getAttribute("data-provider-mode") === "replace" ? "replace" : "add";
    syncProviderKeyForm(form, true);
    var key = form.querySelector('input[name="value"]');
    if (key) key.focus();
  });
  var fixSource = document.body.getAttribute("data-because-run");
  if (fixSource && /^[A-Za-z0-9._:-]{1,200}$/.test(fixSource)) {
    var configLinks = document.querySelectorAll('a[href^="/config"]');
    for (var ci = 0; ci < configLinks.length; ci++) {
      var fixLink = new URL(configLinks[ci].getAttribute("href"), location.origin);
      fixLink.searchParams.set("becauseRun", fixSource);
      configLinks[ci].setAttribute("href", fixLink.pathname + fixLink.search + fixLink.hash);
    }
  }
  // One native picker keeps keyboard and touch behavior, while both declarations use their existing action paths.
  function resolverFields(form) {
    var kind = form.querySelector('[name="kind"]');
    var bundle = kind && kind.value === "bundle";
    form.setAttribute("data-action", bundle ? "secret-bundle-add" : "secret-profile-add");
    var box = form.querySelector("[data-resolver-format]");
    if (box) { box.hidden = !bundle; var format = box.querySelector('[name="format"]'); if (format) format.disabled = !bundle; }
    var button = form.querySelector('[type="submit"]');
    if (button) button.textContent = bundle ? "Preview the bundle resolver" : "Preview the profile";
    var hint = form.querySelector("[data-resolver-frequency]");
    if (hint) hint.textContent = bundle ? "The worker runs this script as the account it runs as, once per job start of each bound project, and hands the job every variable it prints. Only declare a resolver you trust." : "The worker runs this script as the account it runs as, once per reference before the container starts. Only declare a resolver you trust.";
  }
  var resolverForms = typeof document.querySelectorAll === "function" ? document.querySelectorAll('form[data-structured="resolver"]') : [];
  for (var ri = 0; ri < resolverForms.length; ri++) resolverFields(resolverForms[ri]);
  function resolverChanged(ev) {
    var form = ev.target && ev.target.closest ? ev.target.closest('form[data-structured="resolver"]') : null;
    if (!form) return;
    // A preview belongs to exactly what the person submitted, including the resolver kind. Closing also advances
    // slotGen, so a late answer for the old fields cannot arm a confirm under the new declaration.
    if (form === slotForm && slot) closeSlot();
    resolverFields(form);
  }
  document.addEventListener("change", resolverChanged);
  document.addEventListener("input", resolverChanged);
  var TRIGGER_ACTIONS = ${JSON.stringify(Object.fromEntries(Object.entries(PR_ACTIONS).map(([k,v])=>[k,[...v]])))};
  function triggerFields(form) {
    var kind = form.querySelector('[name="kind"]');
    if (!kind) return;
    var groups = form.querySelectorAll("[data-trigger-kind]");
    for (var i = 0; i < groups.length; i++) {
      var active = groups[i].getAttribute("data-trigger-kind") === kind.value;
      groups[i].hidden = !active;
      groups[i].disabled = !active;
    }
    var activeGroup = form.querySelector('[data-trigger-kind="' + kind.value + '"]');
    var forge = activeGroup && activeGroup.querySelector('[name="forge"]');
    var action = activeGroup && activeGroup.querySelector('[name="action"]');
    if (action && forge && kind.value === "pull_request" && typeof document.createElement === "function") {
      var actions = TRIGGER_ACTIONS[forge.value] || [];
      if (action.getAttribute("data-forge") !== forge.value) {
        var saved = action.value;
        while (action.firstChild) action.removeChild(action.firstChild);
        for (var ai = 0; ai < actions.length; ai++) { var option = document.createElement("option"); option.value = actions[ai]; option.textContent = actions[ai]; action.appendChild(option); }
        if (actions.indexOf(saved) >= 0) action.value = saved;
        action.setAttribute("data-forge", forge.value);
      }
    }
    if (activeGroup && action && forge && kind.value === "issue" && action.value !== (forge.value === "gitlab" ? "close" : "closed")) {
      while (action.firstChild) action.removeChild(action.firstChild);
      var issueOption = document.createElement("option"); issueOption.value = forge.value === "gitlab" ? "close" : "closed"; issueOption.textContent = issueOption.value; action.appendChild(issueOption);
    }
    var review = activeGroup && activeGroup.querySelector('[name="reviewState"]');
    if (review && action && forge) { var narrowed = forge.value === "github" && action.value === "review_submitted"; review.disabled = !narrowed; review.closest(".field").hidden = !narrowed; }
    if (activeGroup && action && kind.value === "pull_request") {
      var closeOnly = action.value === "closed" || action.value === "close";
      for (var oneKey of ["once", "number"]) { var oneControl = activeGroup.querySelector('[name="' + oneKey + '"]'); if (oneControl) { oneControl.disabled = !closeOnly; oneControl.closest(".field").hidden = !closeOnly; } }
    }
    var cron = kind.value === "cron";
    for (var key of ["statusComment", "recover"]) {
      var control = form.querySelector('[name="' + key + '"]');
      if (control) { control.disabled = cron; control.closest(".field").hidden = cron; }
    }
  }
  var triggerForms = typeof document.querySelectorAll === "function" ? document.querySelectorAll('form[data-structured="trigger"]') : [];
  for (var ti = 0; ti < triggerForms.length; ti++) triggerFields(triggerForms[ti]);
  document.addEventListener("change", function (ev) {
    var form = ev.target && ev.target.closest ? ev.target.closest('form[data-structured="trigger"]') : null;
    if (form) triggerFields(form);
  });
  var configErrorSequence = 0;
  function fieldErrors(form, message) {
    var slots = form.querySelectorAll("[data-field-error]");
    var matched = false;
    var tokens = typeof message === "string" ? message.toLowerCase().split(/[^a-z0-9_]+/) : [];
    // A validator's "run.provider ... provider id" names provider, not the separate scheduler id field.
    // Prefer its explicit field addresses; generic words are only a fallback for unqualified refusals.
    var mentioned = [];
    if (typeof message === "string") {
      var address = /(?:^|[^a-z0-9_])(?:on|run)[.]([a-z0-9_]+)/g;
      var found;
      while ((found = address.exec(message.toLowerCase())) !== null) {
        for (var si = 0; si < slots.length; si++) {
          if (slots[si].getAttribute("data-field-error").toLowerCase() === found[1]) { mentioned.push(found[1]); break; }
        }
      }
    }
    var targets = mentioned.length > 0 ? mentioned : tokens;
    for (var i = 0; i < slots.length; i++) {
      var key = slots[i].getAttribute("data-field-error");
      var control = slots[i].parentElement.querySelector("input, select, textarea");
      var active = control && !control.disabled && !(typeof control.closest === "function" && control.closest("fieldset[disabled]"));
      var applies = active && targets.indexOf(key.toLowerCase()) >= 0;
      slots[i].textContent = applies ? message + " Nothing was changed." : "";
      slots[i].hidden = !applies;
      if (slots[i].parentElement.classList) {
        if (applies) slots[i].parentElement.classList.add("field--err");
        else slots[i].parentElement.classList.remove("field--err");
      }
      if (control) {
        if (applies) {
          var id = slots[i].getAttribute("id");
          if (!id) {
            do { id = "cfg-error-" + (++configErrorSequence); } while (document.getElementById(id));
            slots[i].id = id;
          }
          control.setAttribute("aria-describedby", id);
          control.setAttribute("aria-invalid", "true");
          if (!matched && typeof control.focus === "function") control.focus();
          matched = true;
        } else { control.removeAttribute("aria-invalid"); control.removeAttribute("aria-describedby"); }
      }
    }
    var fallback = form.querySelector("[data-form-error]");
    if (fallback) { fallback.hidden = !message || matched; fallback.textContent = message || ""; }
  }
  function bodyOf(form) {
    var out = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name || el.disabled || (typeof el.closest === "function" && el.closest("fieldset[disabled]"))) continue;
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
    var structured = typeof form.getAttribute === "function" ? form.getAttribute("data-structured") : null;
    if (structured === "priorities" || structured === "envelope") {
      var weights = Object.create(null);
      var floors = Object.create(null);
      for (var key in out) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
        if (key.indexOf("weight:") === 0 || key.indexOf("floor:") === 0) {
          var id = key.slice(key.indexOf(":") + 1);
          if (!/^(?:_other|[a-z0-9][a-z0-9-]{0,31})$/.test(id)) throw new Error("Invalid envelope project");
          var value = Number(out[key]);
          if (!isFinite(value) || value < 0 || (key.indexOf("weight:") === 0 && (Math.floor(value) !== value || value > 1000))) throw new Error("Weights must be whole numbers from 0 to 1000; floors must be nonnegative numbers");
          (key.indexOf("weight:") === 0 ? weights : floors)[id] = value;
          delete out[key];
        }
      }
      if (structured === "priorities") {
        var projects = [];
        for (var id in weights) projects.push({ id: id, weight: weights[id] });
        return { projects: projects, validDays: Number(out.validDays) };
      }
      out.floorsUsd = floors;
      out.defaultWeights = weights;
      out.enabled = out.enabled === true;
      for (var key of ["totalUsd", "maxStepPct", "minIntervalHours", "maxPlanDays"]) {
        out[key] = Number(out[key]);
        if (!isFinite(out[key]) || out[key] < 0) throw new Error(key + " must be a nonnegative number");
      }
      if (!Array.isArray(out.writers)) out.writers = [];
      return { envelope: out };
    }
    if (structured === "resolver") { delete out.kind; if (form.getAttribute("data-action") === "secret-profile-add") delete out.format; return out; }
    if (structured === "trigger") { if (out.once === false) delete out.once; return { trigger: out }; }
    return out;
  }
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.matches || !form.matches("form[data-action]")) return;
    ev.preventDefault();
    var action = form.getAttribute("data-action") || "";
    if (!/^[a-z0-9-]{1,40}$/.test(action) || !slot) return;
    preview(form, action, submitText(form, ev), submitterOf(form, ev));
  });
  // The hypothetical checker never submits a navigation or a paid action. Its one markup sink accepts only the
  // server's rendered answer; descriptions and transport failures stay in controls or text nodes.
  var checkForm = document.querySelector("form[data-trigger-check]");
  var checkResult = document.querySelector("[data-trigger-check-result]");
  if (checkForm && checkResult) {
    var checkFields = checkForm.querySelector("[data-trigger-check-fields]");
    var checkSeq = 0;
    var checkTimer = null;
    var checkBusy = false;
    function checkControl(name) { return checkForm.querySelector('[name="' + name + '"]'); }
    function checkValue(name) { var el = checkControl(name); return el ? el.value : ""; }
    function checkStatus(text) { checkResult.textContent = text; }
    function checkFinish() {
      checkBusy = false;
      checkForm.removeAttribute("aria-busy");
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
      var submit = checkForm.querySelector('[type="submit"]');
      if (submit) submit.disabled = false;
    }
    function checkCondition(name, active) {
      var box = checkForm.querySelector('[data-check-field="' + name + '"]');
      var el = checkControl(name);
      if (box) box.hidden = !active;
      if (el) el.disabled = !active;
    }
    function checkOptions(name, forge) {
      var select = checkControl(name);
      if (!select) return;
      var options = select.querySelectorAll("option");
      var first = null, firstIndex = -1, valid = false, selected = -1;
      for (var i = 0; i < options.length; i++) {
        var owner = options[i].getAttribute("data-check-forge");
        var active = !owner || owner === forge;
        options[i].hidden = !active;
        options[i].disabled = !active;
        if (active && first === null) { first = options[i].value; firstIndex = i; }
        if (active && options[i].value === select.value) { valid = true; selected = i; }
      }
      if (!valid && first !== null) { select.value = first; selected = firstIndex; }
      if (selected >= 0) select.selectedIndex = selected;
    }
    function checkConditions() {
      var forge = checkValue("forge");
      checkOptions("event", forge);
      checkOptions("action", forge);
      var event = checkValue("event"), action = checkValue("action");
      var pr = event === "pull-request", prEvent = pr || event === "pull-request-comment";
      var review = forge === "github" && pr && action === "review_submitted";
      checkCondition("action", pr);
      checkCondition("prAuthor", forge === "github" && pr && ["opened", "synchronize", "reopened", "review_submitted"].indexOf(action) >= 0);
      checkCondition("reviewState", review);
      checkCondition("reviewBody", review);
      checkCondition("comment", event === "issue-comment" || event === "pull-request-comment");
      checkCondition("labels", !(forge === "azure" && prEvent));
      checkCondition("previousLabels", (forge === "gitlab" && ["issue-labeled", "issue-closed", "pull-request"].indexOf(event) >= 0) || (forge === "azure" && event === "issue-labeled"));
    }
    function checkInput() {
      var out = {};
      var controls = checkForm.querySelectorAll("[name]");
      for (var i = 0; i < controls.length; i++) {
        var el = controls[i];
        if (el.disabled || !el.name || el.value === "") continue;
        if (el.name === "labels" || el.name === "previousLabels") out[el.name] = el.value.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
        else if (el.name === "number") out.number = Number(el.value);
        else out[el.name] = el.value;
      }
      return out;
    }
    function checkChanged() {
      checkSeq++;
      var hadBusy = checkBusy;
      checkFinish();
      checkConditions();
      checkStatus(hadBusy ? "The description changed. Check again for this event." : "Check this description to see a hypothetical match. No delivery will be sent.");
    }
    checkForm.addEventListener("input", checkChanged);
    checkForm.addEventListener("change", checkChanged);
    checkForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (checkBusy) return;
      checkConditions();
      var input = checkInput(), fingerprint = JSON.stringify(input), mine = ++checkSeq;
      checkBusy = true;
      checkForm.setAttribute("aria-busy", "true");
      var submit = checkForm.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      checkStatus("Checking the described event. Nothing is being sent or queued.");
      checkTimer = later(function () {
        if (mine !== checkSeq) return;
        checkSeq++;
        checkFinish();
        checkStatus("The check timed out. Your description is preserved; try again.");
      }, 10000);
      post("/api/trigger-check", input, true).then(function (r) {
        if (mine !== checkSeq) return;
        checkFinish();
        if (fingerprint !== JSON.stringify(checkInput())) { checkSeq++; checkStatus("The description changed. Check again for this event."); return; }
        if (r.status === 401 || r.status === 409) {
          checkStatus("The session changed or ended. Sign in again before checking. Your description has been preserved.");
          return;
        }
        if ((r.status === 200 || r.status === 400) && r.body && typeof r.body.html === "string") {
          checkResult.innerHTML = r.body.html;
          if (typeof checkResult.focus === "function") checkResult.focus();
        } else checkStatus("The check is unavailable. Your description is preserved; try again.");
      }).catch(function () {
        if (mine !== checkSeq) return;
        checkFinish();
        checkStatus("The check could not connect. Your description is preserved; try again.");
      });
    });
    if (checkFields) checkFields.disabled = false;
    checkConditions();
  }
  // ---- the live stream (issue #641) and how a page says what it is showing (issue #737) ----
  var live = document.body ? document.body.getAttribute("data-live") : null;
  var es = null;
  var transcriptTimer = null;
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
    outside(function () {
      for (var i = 0; i < all.length; i++) all[i].hidden = all[i].getAttribute("data-live-note") !== state;
    });
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
    if (transcriptTimer !== null) clearInterval(transcriptTimer);
    transcriptTimer = null;
  }
  // ---- asking the console what a closed stream meant (probe) ----
  // A caller's on.ok is what a 200 means to it on the first ask: "limit" (a stream the browser closed, refused while the
  // session holds: the stream limit) or "reload" (the console is there and this browser is signed in). on.ended is the
  // reason a 401 goes to sign-in with when its answer names none of the console's own. A 503 or no answer keeps the
  // page and asks again every RETRY_MS, and once that has happened a 200 reloads (the console is back).
  //
  // ONE QUESTION, EVERY CALLER ANSWERED (issue #737). Repeated stream errors and a write's 401 can arrive together. So each probe (in a
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
    if (tmark && !tdone) tmark(state === "asking" ? "reconnecting" : "not live: reload after closing another console tab", "off");
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
  // The page stream's session end also ends its transcript; tdone never takes this path.
  var ended = false;
  function streamEnded(ev) {
    endSetupPrivate();
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
      outside(function () {
        if (at !== null || !staleShown) since(at);
        staleShown = true;
        if (mainEl && mainEl.classList) mainEl.classList.add("stale");
        if (staleBody) sayWithCode(staleBody, tokens ? STALE_TOKENS_BODY : staleData);
        note("stale");
      });
    });
    es.addEventListener("fresh", function () {
      if (staleShown) unstale();
    });
    es.addEventListener("end", streamEnded);
  }
  // ---- the run transcript: entries share the page's stream (issue #747) ----
  var tbox = document.querySelector("[data-transcript]");
  var tjob = tbox ? tbox.getAttribute("data-job") : null;
  var tseen = Object.create(null);
  var tfilter = "all";
  var tstate = null;
  var tdone = false;
  function transcriptEntries() {
    return tbox ? Array.prototype.slice.call(tbox.querySelectorAll("[data-kind]")) : [];
  }
  // Agent-written text is copied only from the server-escaped entries. Setting textContent keeps a question that
  // contains markup as text; panels themselves carry empty slots, including after a live swap.
  // A parked question is the hero, ahead of the main column's other cards. Move the existing panel node, never
  // clone it: its form, held input, and the independent transcript box survive the next state change.
  function placeRunChat() {
    var chat = document.getElementById("p-chat");
    var main = document.querySelector(".run-main");
    var side = document.querySelector(".run-side");
    if (!chat || !main || !side || typeof chat.querySelector !== "function") return;
    var target = chat.querySelector(".qcard") ? main : side;
    if (chat.parentNode !== target && typeof target.insertBefore === "function") target.insertBefore(chat, target.firstChild);
  }
  function fillRunSlots() {
    placeRunChat();
    if (!tbox) return;
    var entries = transcriptEntries();
    var question = document.querySelector("[data-run-question]");
    var tail = document.querySelector("[data-run-tail]");
    var tools = document.querySelector("[data-recovery-tools]");
    if (question) {
      var answer = "";
      for (var i = 0; i < entries.length; i++) {
        var kind = entries[i].getAttribute("data-kind");
        if (kind === "reset") answer = "";
        if (kind === "assistant") {
          var text = entries[i].querySelector("pre");
          if (text) answer = text.textContent;
        }
      }
      question.textContent = answer;
    }
    if (tail) {
      tail.textContent = "";
      entries.slice(-3).forEach(function (entry) { var clone = entry.cloneNode(true); clone.hidden = false; tail.appendChild(clone); });
    }
    if (tools) {
      tools.textContent = "";
      entries.filter(function (entry) { return entry.getAttribute("data-kind") === "tool-call" || entry.getAttribute("data-kind") === "tool-result"; }).slice(-3).forEach(function (entry) { var clone = entry.cloneNode(true); clone.hidden = false; tools.appendChild(clone); });
    }
    if (tstate && tmark) tmark(tstate.text, tstate.cls);
  }
  placeRunChat();
  function transcriptFollowing() {
    if (!tbox) return true;
    return tbox.scrollHeight - tbox.scrollTop - tbox.clientHeight < 24;
  }
  function followingState() {
    var follows = transcriptFollowing();
    var label = document.querySelector("[data-transcript-following]");
    var newest = document.querySelector("[data-transcript-newest]");
    if (label) label.textContent = follows ? "Following" : "Reading earlier entries";
    if (newest) newest.hidden = follows;
  }
  function filterTranscript() {
    transcriptEntries().forEach(function (entry) {
      var kind = entry.getAttribute("data-kind");
      var tool = kind === "tool-call" || kind === "tool-result";
      entry.hidden = tfilter === "tools" ? !tool : tfilter === "messages" ? kind !== "user" && kind !== "assistant" && kind !== "steer" : false;
    });
    var buttons = document.querySelectorAll("[data-transcript-filter]");
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-transcript-filter") === tfilter));
    followingState();
  }
  function transcriptTimers() {
    var entries = transcriptEntries();
    var active = Object.create(null);
    entries.forEach(function (entry) {
      var kind = entry.getAttribute("data-kind");
      var tool = entry.getAttribute("data-tool") || "?";
      if (kind === "reset" || kind === "end") active = Object.create(null);
      else if (kind === "tool-result" && active[tool]) active[tool].shift();
      else if (kind === "tool-call") {
        if (!active[tool]) active[tool] = [];
        active[tool].push(entry);
      }
      var old = entry.querySelector("[data-call-elapsed]");
      if (old) old.remove();
    });
    if (tdone) return;
    Object.keys(active).forEach(function (tool) {
      active[tool].forEach(function (entry) {
      var ts = Number(entry.getAttribute("data-ts"));
      if (!isFinite(ts) || ts <= 0) return;
      var span = document.createElement("span");
      span.setAttribute("data-call-elapsed", "");
      span.className = "muted mono";
      span.textContent = "running " + Math.max(0, Math.floor((Date.now() - ts) / 1000)) + "s";
      var timer = entry.querySelector("[data-tool-timer]") || entry.querySelector("header");
      if (timer) timer.appendChild(span);
      });
    });
  }
  if (tbox && tjob && es) {
    tmark = function (text, cls) {
      tstate = { text: text, cls: cls };
      var status = document.querySelector("[data-transcript-status]");
      if (!status) return;
      status.textContent = text;
      status.setAttribute("data-stream-state", cls);
    };
    es.addEventListener("error", function () { if (!tdone) tmark("reconnecting", "off"); });
    es.addEventListener("entry", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.html !== "string") return;
      var id = ev.lastEventId;
      if (id && tseen[id]) return;
      if (id) tseen[id] = true;
      var atBottom = transcriptFollowing();
      tbox.insertAdjacentHTML("beforeend", msg.html);
      // A resumed attempt may publish again after an earlier end on the same run key.
      tdone = false;
      if (transcriptTimer === null) transcriptTimer = setInterval(transcriptTimers, 1000);
      try { localTimes(tbox); } catch (e) { /* keep UTC */ }
      filterTranscript();
      transcriptTimers();
      fillRunSlots();
      if (atBottom) tbox.scrollTop = tbox.scrollHeight;
      followingState();
      tmark("live", "on");
    });
    es.addEventListener("tdone", function (ev) {
      tdone = true;
      if (transcriptTimer !== null) clearInterval(transcriptTimer);
      transcriptTimer = null;
      var outcome = "unknown";
      try {
        var d = JSON.parse(ev.data);
        if (d && typeof d.outcome === "string") outcome = d.outcome;
      } catch (e) { /* keep unknown */ }
      tmark("ended (" + outcome + ")", "ended");
      var ends = tbox.querySelectorAll("[data-transcript-end]");
      for (var i = 0; i < ends.length; i++) ends[i].textContent = "The run is over (" + outcome + ").";
      fillRunSlots();
      transcriptTimers();
      // The page stream stays open: its panels still change after the transcript ends.
    });
    tbox.addEventListener("scroll", followingState);
    document.addEventListener("click", function (ev) {
      var filter = ev.target && ev.target.closest ? ev.target.closest("[data-transcript-filter]") : null;
      if (filter) { tfilter = filter.getAttribute("data-transcript-filter"); filterTranscript(); }
      var newest = ev.target && ev.target.closest ? ev.target.closest("[data-transcript-newest]") : null;
      if (newest) { tbox.scrollTop = tbox.scrollHeight; followingState(); }
    });
    es.addEventListener("open", function () { if (tstate && tstate.text === "reconnecting" && !tdone) tmark("live", "on"); });
    filterTranscript();
  }
})();
`;
