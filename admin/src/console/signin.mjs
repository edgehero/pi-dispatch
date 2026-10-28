/**
 * The sign-in pages' content (issue #737, the SignIn and AccessStates cards; issue #711): the token form with the help
 * that says where a token and a link come from, and the one-time link's page. `shell.mjs` draws the frame around them
 * (`loginPage`, `loginCodePage`); this module never imports the shell, so the shell's page table and this content stay
 * one way round.
 *
 * EVERY STATE IS SERVER MARKUP. The browser script switches between states and never writes markup here: each notice
 * the page can show (why a session ended, why a sign-in was refused, the console being out of reach) and each state of
 * the link page is drawn by the server, hidden but the one it chose, and the script reveals one (`hidden`) and sets the
 * server's own refusal sentence through `textContent` (`[data-notice-text]`). So every state is a fragment a golden can
 * pin, and a query string can only select one of these sentences, never put its own bytes on the page
 * (`session-ends.mjs` `endedReasonOf`).
 *
 * THE THREE IDS THE SCRIPT FINDS (`#login-form`, `#token`, `#notice`) are drawn here by hand, with the kit's class names:
 * the kit refuses to write them (`kit.mjs` `RESERVED_IDS`), so no other element of a page can take one.
 *
 * WITHOUT JAVASCRIPT A PAGE SHOWS ONLY WHAT WORKS. Signing in is the script's: it posts the token or the link's code as
 * JSON, which a plain form cannot send. So what only the script can make true is drawn
 * `hidden data-reveal`: the token form with the sentence that leads into it, and the link page's first state ("Signing
 * in with a one-time link", which without a script would never happen). The script's first act on either page is to
 * remove `hidden` from every `[data-reveal]` (`script.mjs`; the contract is that and nothing else), so with a script
 * the page is as the card draws it, and without one it says first, in its card, that the console needs JavaScript to
 * sign in (`NO_SCRIPT_TEXT`), and nothing it cannot do. What stays true without a script stays shown: why a session
 * ended, the help that says where a token or a link comes from (commands run elsewhere), and where the console answers.
 *
 * NO TOKEN PREFIX, ANYWHERE. A token starts with a fixed prefix, and the server's leak canary fails on any page that
 * holds it, so the field has no placeholder and the help names the commands that print a token, never its shape.
 *
 * WHERE IT ANSWERS (the footer) follows the console's own listen address: its loopback address, its unix socket, or, for
 * a public bind, nothing about loopback at all (the page never claims what the bind does not make true).
 */
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";
import { isLoopbackAddress } from "./listen.mjs";
import { ENDED_REASONS, SIGN_IN_NOTICES, endedNotices } from "./session-ends.mjs";

/** The notices a link page can show: it has no ended session and no token to be wrong, so a subset of the sign-in's. */
export const LINK_NOTICES = Object.freeze(["unreachable", "rate", "tokens", "audit", "other"]);

/** The link page's states (the AccessStates card): signing in, a used or unknown link, a link with no code. */
export const LINK_STATES = Object.freeze(["wait", "used", "nocode"]);

/** The sentence a page without JavaScript shows; the sign-in posts JSON from the script, so it cannot work without it. */
export const NO_SCRIPT_TEXT = "The console needs JavaScript to sign in.";

/** The attributes of a part only the script can make true: drawn hidden, revealed by the script as the page loads. */
const REVEAL = html` hidden data-reveal`;

/** The help's two commands: a one-time link from pi (`console-command.mjs`: `--link` prints it), and a token on the host. */
const PI_LINK = Object.freeze(["/dispatch", "console", "--link"]);
const TOKEN_ADD = Object.freeze(["pi-dispatch-console", "token", "add", "--name", "<you>", "--role", "operator"]);
const CLI_LINK = Object.freeze(["pi-dispatch-console", "link", "--name", "<you>"]);

/** The footer's sentence by where the console listens (see the header); null says nothing. */
export const LISTEN_FOOTERS = Object.freeze({
  loopback: "This console answers on this host's loopback address only. Reach it on this host, or through an SSH tunnel.",
  unix: "This console answers on its unix socket only. Reach it on this host, or through an SSH tunnel to the socket.",
  public: null,
});

/**
 * Where the console listens, as a footer's key. `listen` is a word, as `server.mjs` passes it after judging its own
 * listen address: `"tcp"` (a TCP listener on a loopback address; a non-loopback one is `"public"`), `"unix"` or
 * `"public"`, or `"loopback"` for the same as `"tcp"`; or the config's listen address itself (`{ kind: "tcp", host }`,
 * `{ kind: "unix" }`), judged here. Anything else, and no value, draws nothing: the page never claims a bind it was not
 * told of.
 */
function listenKey(listen) {
  if (listen === "tcp") return "loopback";
  if (typeof listen === "string") return Object.hasOwn(LISTEN_FOOTERS, listen) ? listen : "public";
  if (listen?.kind === "unix") return "unix";
  if (listen?.kind === "tcp" && typeof listen.host === "string" && isLoopbackAddress(listen.host)) return "loopback";
  return "public";
}

/** A positive whole number, or undefined (so `endedNotices` keeps its default rather than printing a wrong limit). */
const limitOf = (n) => (Number.isSafeInteger(n) && n > 0 ? n : undefined);

/**
 * The notice a page opens with: `"ended-<reason>"` for a reason in `ENDED_REASONS`, a `SIGN_IN_NOTICES` kind as itself
 * (a panel golden draws a refusal this way; the server sends only an ended reason), else none. The two lists share no
 * name, so a value can only mean one of them.
 */
function noticeKey(notice) {
  if (typeof notice !== "string") return null;
  if (ENDED_REASONS.includes(notice)) return `ended-${notice}`;
  return Object.hasOwn(SIGN_IN_NOTICES, notice) ? notice : null;
}

/** One notice: a small banner in a `[data-notice]` box, hidden unless it is the one shown. */
function noticeBox(key, n, shown) {
  // The `other` notice's body is the server's own refusal sentence, which the script sets through textContent; every
  // other body is the catalog's, its commands in the code face.
  const body = key === "other" ? html`<span data-notice-text></span>` : ui.withCode(n.body);
  return html`<div data-notice="${key}"${key === shown ? null : html` hidden`}>${ui.banner({ status: n.status, icon: n.icon, sm: true, title: n.title, body })}</div>`;
}

/** `#notice`: a polite live region, always drawn, holding `entries` (`[key, notice]`), all hidden but `shown`. */
function noticeRegion(entries, shown) {
  return html`<div id="notice" class="signin__notice" aria-live="polite">${entries.map(([key, n]) => noticeBox(key, n, shown))}</div>`;
}

/** The "pi" mark that opens the card (the brand pill's own circle, drawn larger). */
const MARK = html`<span class="brandpill__m signin__mark" aria-hidden="true">pi</span>`;

/**
 * The first thing in either page's card: without a script, the sentence that says why nothing here can sign in, as a
 * notice (the card's notices are banners). A browser that runs scripts does not render a `<noscript>`'s content.
 */
const NO_SCRIPT = html`<noscript>${ui.banner({ status: "attention", icon: "info", sm: true, title: NO_SCRIPT_TEXT })}</noscript>`;

/**
 * The sign-in panel: `notice` (see `noticeKey`), the console's session `limits` (`{ idleMinutes, maxHours }`, so the
 * ended notices state the limits it runs with) and where it `listen`s (`listenKey`). The form and its lead-in are the
 * script's to reveal (see the header).
 */
export function signInContent({ notice = null, limits = {}, listen = null } = {}) {
  const ended = endedNotices({ idleMinutes: limitOf(limits?.idleMinutes), maxHours: limitOf(limits?.maxHours) });
  const entries = [...ENDED_REASONS.map((r) => [`ended-${r}`, ended[r]]), ...Object.entries(SIGN_IN_NOTICES)];
  const footer = LISTEN_FOOTERS[listenKey(listen)];
  return html`<section id="p-signin" data-panel><div class="card signin">
${NO_SCRIPT}
${MARK}
<h2>Sign in to the console</h2>
<p class="muted"${REVEAL}>Paste a console token, or open a one-time link from pi.</p>
${noticeRegion(entries, noticeKey(notice))}
<form id="login-form" class="signin__form" autocomplete="off"${REVEAL}><div class="field"><label for="token">Console token</label><input id="token" class="input input--code" name="token" type="password" autocomplete="off" spellcheck="false" required aria-describedby="notice"></div><button class="btn btn--primary btn--lg" type="submit">Sign in</button></form>
<div class="signin__help"><p class="signin__help-h">No token yet?</p><p class="muted">Make a link from pi. It works once, for 60 seconds:</p>${ui.cmd([...PI_LINK])}<p class="muted">Or make a token on the host:</p>${ui.cmd([...TOKEN_ADD])}</div>
${footer === null ? null : html`<p class="signin__foot faint">${footer}</p>`}
</div></section>`;
}

/** The link to the token form, which every state of the link page offers. */
const TOKEN_INSTEAD = html`<a class="link signin__alt" href="/login">Sign in with a token instead</a>`;

/**
 * One state of the link page: its tile, heading and sentence, then what it offers. The state the page opens in is the
 * script's to reveal, like every other (see the header): a page without a script shows none of them.
 */
function linkState(state, shown, { status, icon, title, body }) {
  return html`<div class="signin__state" data-link-state="${state}"${state === shown ? REVEAL : html` hidden`}><div class="signin__top">${MARK}${ui.tile(status, { icon })}</div><h2>${title}</h2>${body}${TOKEN_INSTEAD}</div>`;
}

/**
 * The one-time link's page, in `state` (`LINK_STATES`; the server draws `wait`, and the script switches to `used` or
 * `nocode`): what is happening, the command for a new link where one is needed, and the token form's link. `notice` is
 * one of `LINK_NOTICES` to draw shown, for a panel golden alone (as `signInContent`'s refusals): the server draws none,
 * and the script shows the one an answer selects.
 */
export function linkContent({ state = "wait", notice = null } = {}) {
  const shown = LINK_STATES.includes(state) ? state : "wait";
  const states = [
    linkState("wait", shown, { status: "running", icon: "hourglass", title: "Signing in with a one-time link", body: html`<p class="muted">This takes a moment. The link is taken out of your browser history first, so it cannot be used again from there.</p>` }),
    // Two commands for a new link, each led in by where it runs: the host's own CLI, then pi's.
    linkState("used", shown, { status: "failed", icon: "failed", title: "This sign-in link is used, expired or unknown", body: html`<p class="muted">A link works once, for 60 seconds. Ask for a new one on the host:</p>${ui.cmd([...CLI_LINK])}<p class="muted">Or in pi:</p>${ui.cmd([...PI_LINK])}` }),
    linkState("nocode", shown, { status: "attention", icon: "attention", title: "This link carries no code", body: html`<p class="muted">Copy the whole link, or ask for a new one with <span class="code">pi-dispatch-console link</span>. In pi, <span class="code">/dispatch console --link</span> makes one for you.</p>` }),
  ];
  const entries = LINK_NOTICES.map((k) => [k, SIGN_IN_NOTICES[k]]);
  return html`<section id="p-link" data-panel><div class="card signin">
${NO_SCRIPT}
${states}
${noticeRegion(entries, LINK_NOTICES.includes(notice) ? notice : null)}
</div></section>`;
}
