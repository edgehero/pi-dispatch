/**
 * The frame every console page is drawn in (issue #737, the Pulse design's Shell card): the skip link, the icon sprite,
 * the top bar (the pi-dispatch pill, the pill navigation, the live state, the theme button, the read-only chip, who is
 * signed in and sign-out), then `<main>` with the page's title bar and its content. The sign-in pages get the same
 * frame with a top bar of two things only (the SignIn card's): the pi-dispatch pill and the theme button, since nobody
 * is signed in yet.
 *
 * WHY HERE AND NOT IN `pages.mjs` OR `html.mjs`. Those two hold the old markup until each page converts, and the
 * stylesheet's compatibility test reads them as such (`console-compat.test.mjs`): a class the Pulse bundle styles,
 * written there, would count as old markup the legacy layer must neutralise. And `html.mjs` cannot import this
 * module: the sprite is built with `html` while `pulse-icons.mjs` loads, which would be before `html.mjs` had run.
 *
 * WHAT THE SCRIPT RELIES ON, kept by every page: `#logout` (sign-out), `#live-status` with its `[data-live-word]`
 * (the live pill, on live pages only), `[data-theme-toggle]` (drawn `hidden`; the script reveals it where it can set
 * the cookie, the sign-in pages included), `details.more` (Escape, a click elsewhere and focus leaving it close it),
 * `nav.pillnav` with its `aria-current="page"` pill (scrolled into view once on load where the navigation scrolls, on a
 * phone) and `#main` (the skip link's target, focusable with `tabindex="-1"`).
 *
 * `top--ro` MARKS A READ-ONLY CONSOLE'S BAR. Its end holds one more part (the read-only chip), so the stylesheet lays
 * the bar out on one row only from a wider viewport (`SHELL_CSS`). The class is the server's, from the console's own
 * setting: the layout follows the viewport and this class alone, never what the script changes (the live word, the
 * revealed theme button), so the bar keeps its height whatever the stream says.
 *
 * THE PARKED COUNT IS A PANEL. It moves while a page is open, so it is `<span id="p-nav-parked" data-panel>` inside the
 * Parked pill, and the live stream swaps its inner HTML like any panel's (`pages.mjs` `pagePanels` sends it on a live
 * page). It is drawn only from a count that is known: an unreadable or partial parked list draws no bubble, never a 0
 * that reads as "nobody is waiting".
 *
 * SO IS A PAGE'S HEADLINE (PR 3 of issue #737). The overview's line under its title ("All clear. 4 jobs running,
 * nothing needs you.") changes while the page is open, and the title bar is the frame's static markup, so the line is
 * `<span id="p-headline" data-panel>` inside the title bar's `p.titlebar__sub`, drawn only for a page that has one
 * (`shellHtml`'s `headline`). The span carries its `id` and `data-panel` and nothing else, as every panel element does;
 * the paragraph around it is the frame's.
 *
 * EVERY STATE THE SCRIPT CAN SWITCH TO IS DRAWN HERE, HIDDEN (PR 2 of issue #737). The live notes (`LIVE_NOTES`: the
 * console out of reach, the stream refused, the session over, the data shown as last seen) are all in `#live-note`,
 * each hidden; the write flow's one slot (`#confirm-slot`) and the note a panel kept still carries (`<template
 * id="held-note">`) are drawn for an operator who can write. The script reveals, fills in text and moves the slot; it
 * never writes their markup, so each can be pinned by a golden. A page drawn once (not live) says when, beside a
 * Reload, in its title bar: nothing on it moves, and the reader should know how old it is.
 *
 * `frameHtml` is the same frame for a page that is not a screen: the sign-in pages (`signin.mjs`'s content) and the
 * error pages (`error-pages.mjs`), with the signed-in bar when there is a session to show and the sign-in bar (the pill
 * and the theme button) otherwise.
 */
import { confirmSlotHtml, doneBannerHtml, heldNoteHtml } from "./confirm-view.mjs";
import { html, page } from "./html.mjs";
import * as ui from "./kit.mjs";
// A cycle by design: `pages.mjs` draws through `shellHtml`, and this module reads the page table. Neither touches the
// other's exports while it loads, only when a page is drawn, which ES modules allow.
import { LEGACY_PAGES, PAGES, pageQueryString } from "./pages.mjs";
import { ICON_NAMES, SPRITE } from "./pulse-icons.mjs";
import { linkContent, signInContent } from "./signin.mjs";
import { themeLabel } from "./theme.mjs";

/**
 * The navigation, in its order: the screens a person works in, then Configuration. Watch and Models are not in it until
 * their issues land. Every name is a `PAGES` key with a `nav` label; the shell test holds `NAV` and
 * `NAV_MORE` together to exactly those pages.
 */
export const NAV = Object.freeze(["overview", "runs", "parked", "fleet", "insights", "config"]);

/** What the More menu holds: the audit log, for operators only, so a viewer has no More at all. */
export const NAV_MORE = Object.freeze(["audit"]);

/** The Parked count's panel id (see the header). */
export const NAV_PARKED_ID = "p-nav-parked";

/** The headline's panel id (see the header): the line under a page's title that says what needs the person. */
export const HEADLINE_ID = "p-headline";

/**
 * The panels the frame draws, not a page: each a `<span id data-panel>` the live stream swaps like a page's
 * `<section>`. The pages' panel lists (`pages.mjs`) and the panel checks take the span ids from here.
 */
export const SHELL_PANEL_IDS = Object.freeze([NAV_PARKED_ID, HEADLINE_ID]);

/**
 * The live pill's states (the LiveStates card): its classes, its word, and the sentence in its tooltip. `start` is the
 * server's first draw, before the script has opened the stream (and what stays without a script); the script switches
 * between the other four, written from this table so its words are these. Signed out is drawn in the muted colours of
 * Not live with the sign-out glyph in place of the dot (`live--out`; the pill holds both, `SHELL_CSS` shows one), so a
 * stopped stream and an ended session do not look alike. The classes are the whole state: what the pill shows (the
 * dot, a glyph, the word) is the stylesheet's choice from them, so the script, and anything else that sets a state,
 * only switches classes and text.
 */
export const LIVE_STATES = Object.freeze({
  start: Object.freeze({ cls: "live live--off", word: "Not live", title: "Not live until this page's script connects to the console's stream." }),
  on: Object.freeze({ cls: "live", word: "Live", title: null }),
  retry: Object.freeze({ cls: "live live--retry", word: "Reconnecting", title: "The page stays as it is and tries again every 2 seconds." }),
  off: Object.freeze({ cls: "live live--off", word: "Not live", title: "Not live: reload after closing another console tab." }),
  out: Object.freeze({ cls: "live live--off live--out", word: "Signed out", title: null }),
});

/**
 * The glyph each state that is not Live shows ON A PHONE (issue #737's third review), by the class that marks the state:
 * a retry arrow for Reconnecting, the stop square for Not live (the server's first state too; the LiveStates card's own
 * "not live" mark), the sign-out arrow for Signed out. Live is the dot. On a phone the pill is ONE 16 px slot holding
 * one of those four marks and its word is hidden from view (kept for a screen reader), so no state and no reconnect can
 * change the bar's size there: the second review's phone pill showed a word for every state but Live, and the first
 * load (drawn Not live, then Live a moment later) or a reconnect moved the page by a row. A shape per state, not a
 * colour alone; each mark is drawn in its state's ink on the canvas, at 3:1 or more in both themes
 * (`console-stylesheet.test.mjs` measures them). Above a phone the pill keeps the dot and the word, and only Signed out
 * shows its glyph. Each is a sprite icon, drawn once by the server with the class `live__<state>`; `SHELL_CSS` shows the
 * state's one.
 */
export const LIVE_GLYPHS = Object.freeze({ retry: "rerun", off: "cancel", out: "logout" });

for (const name of Object.values(LIVE_GLYPHS)) if (!ICON_NAMES.includes(name)) throw new Error(`shell: the live glyph ${name} is not in the sprite`);

/** A live state's glyph: the sprite's `name` at the small icon size (`kit.icon`'s markup) with the state's class. */
const liveGlyph = (state, name) => html`<svg class="ic ic--sm live__${state}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

/** A role as the top bar names it. */
const ROLE_WORDS = Object.freeze({ operator: "Operator", viewer: "Viewer" });

/** Whether `role` may open page `name` (the route table's rule: an operator page is the operator's alone). */
const mayOpen = (name, role) => PAGES[name].auth !== "operator" || role === "operator";

/**
 * The Parked count a page's data knows, or null. From the snapshot when the page read one (`snapshot.parked`, the
 * unanswered parked runs the parked inbox lists; null when the snapshot or its parked list could not be read), else
 * from the fleet reader's `parkedCount` (`loadPageData` reads it for the pages that read no snapshot), the same rule
 * off the same cached window, so the count is the same on every page.
 */
export function navParkedCount(data) {
  const d = data ?? {};
  if (Object.hasOwn(d, "snapshot")) {
    const s = d.snapshot;
    if (!s || s.parkedUnreachable || !Array.isArray(s.parked)) return null;
    return s.parked.length;
  }
  return Number.isSafeInteger(d.parkedCount) && d.parkedCount >= 0 ? d.parkedCount : null;
}

/** The Parked count panel's inner HTML: the violet count when it is known and above zero, else nothing. */
export function navParkedHtml(data) {
  const n = navParkedCount(data);
  return n === null || n === 0 ? html`` : ui.count(n, "parked", { label: `${n} unanswered` });
}

/** The read-only banner's title (the AccessStates card), shown on every page of a console started read-only. */
export const READ_ONLY_TITLE = "This console is read-only";

/** The read-only banner's sentence: why, what it means, and what operators keep. */
const READ_ONLY_BODY = html`It was started with <span class="code">PI_CONSOLE_READ_ONLY=1</span>, so every change is refused and no page shows a form. Operators still see reasons, transcripts and the audit log.`;

/**
 * The most live streams the whole console holds, every token together (`server.mjs` `STREAMS_TOTAL_MAX`). Written here
 * rather than imported, because the server imports this module and the notes are built as it loads; the shell test
 * pins the two equal.
 */
export const LIVE_STREAMS_TOTAL = 32;

/**
 * The notes a live page can show under its title bar (the LiveStates card), one at a time, each a small banner the
 * server draws hidden and the script reveals (`script.mjs`, which embeds these keys): the console out of reach (the
 * pill says Reconnecting; the page stays as it was), the stream refused (the pill says Not live: one token may hold
 * `maxStreams` streams), the session over (the pill says Signed out, and the page goes to sign-in, which says why), and
 * the data shown as last seen (the hub could not read the deployment and kept the panels; the time is the last good
 * render's, which the script writes into the title's `<time data-since>`). `{maxStreams}` in the limit note's body is
 * the console's own `PI_CONSOLE_MAX_STREAMS`, written in when the page is drawn.
 */
export const LIVE_NOTES = Object.freeze({
  retry: Object.freeze({ status: "attention", icon: "beat", title: "Console not reachable, retrying", body: "The page stays as it was. Live panels resume when the console answers." }),
  limit: Object.freeze({ status: "attention", icon: "slot", title: "Not live: this tab's live updates were refused", body: `One token may hold {maxStreams} live tabs, and the console ${LIVE_STREAMS_TOTAL} in all. This tab stays as it is; close another console tab, then reload. A run page with its transcript open counts as two.` }),
  out: Object.freeze({ status: "idle", icon: "logout", title: "Signed out", body: "Your session ended, so the live panels stopped. Going to sign-in, which says why." }),
  stale: Object.freeze({ status: "attention", icon: "clock", title: "Shown as last seen", body: "The console could not read the deployment's data; this is the page as it was last seen. The next refresh tries again." }),
});

/** A page's own address with its query: what Reload opens (a GET of the same page, so it works without the script). */
function selfHref(name, query) {
  return ui.pageHref(PAGES, name, new URLSearchParams(pageQueryString(name, query)));
}

/**
 * `#live-note`: a polite live region, always drawn on a live page, holding each of `LIVE_NOTES` hidden in its
 * `[data-live-note]` box. `maxStreams` is the token's stream limit; a value that is not one leaves the number out
 * rather than state a wrong one. `reload` is the page's own address, for the limit note's Reload.
 */
export function liveNoteHtml({ maxStreams = null, reload = null } = {}) {
  const limit = Number.isSafeInteger(maxStreams) && maxStreams >= 1 ? String(maxStreams) : null;
  const notes = Object.entries(LIVE_NOTES).map(([state, n]) => {
    let body = n.body;
    if (state === "limit") body = limit === null ? body.replace("One token may hold {maxStreams} live tabs, and the console", "One token may hold only a few live tabs, and the console") : body.replace("{maxStreams}", limit);
    // The stale note's time, written by the script; "at" shows only once there is one (`SHELL_CSS`).
    const title = state === "stale" ? html`${n.title}<span class="live-note__at"> at <time data-since></time></span>` : n.title;
    const actions = state === "limit" && reload !== null ? ui.btn({ kind: ["sm", "primary"], label: "Reload", href: reload }) : null;
    return html`<div data-live-note="${state}" hidden>${ui.banner({ status: n.status, icon: n.icon, sm: true, title, body, actions })}</div>`;
  });
  return html`<div id="live-note" class="live-note" aria-live="polite">${notes}</div>`;
}

/**
 * The title bar's end on a page drawn once (the LiveStates card: "Spend, Configuration and Audit are drawn once per
 * load and say when"): when it was drawn, as a `<time>` the script shows in the reader's own time, "not live", and
 * Reload. `now` is the page data's clock; a page with none says only that it is not live.
 */
function drawnHtml(now, reload) {
  const at = Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? new Date(now) : null;
  const when = at === null ? html`Drawn once` : html`Drawn at <time datetime="${at.toISOString()}">${at.toISOString().slice(11, 16)} UTC</time>`;
  return html`<div class="titlebar__end"><span class="drawn">${ui.icon("clock", { size: "sm" })}<span>${when} \u00b7 not live</span></span>${ui.btn({ kind: ["sm", "ghost"], icon: "rerun", label: "Reload", href: reload })}</div>`;
}

/**
 * `content` in the compatibility wrapper when page `name` is still drawn in the old markup (`LEGACY_PAGES`), so the
 * legacy stylesheet applies inside it and nowhere else; as it is once the page has converted. Called once per section
 * (PR 2 of issue #737): each old panel in a wrapper of its own, so the confirm slot the script puts after a section
 * that asked lands between two wrappers, never inside one, where the legacy layer would restyle its buttons and list.
 */
export function legacyWrap(name, content) {
  return LEGACY_PAGES.includes(name) ? html`<div class="legacy">${content}</div>` : content;
}

/**
 * Two letters for the avatar: the name's first two letters or digits, lower case (the Shell card's avatars read "op" and
 * "wa", and a name's case says nothing about who it is), or "-" for a name with none.
 */
function initialsOf(name) {
  const letters = Array.from(String(name ?? "")).filter((c) => /[\p{L}\p{N}]/u.test(c));
  return letters.length === 0 ? "-" : letters.slice(0, 2).join("").toLowerCase();
}

/** One navigation pill: its icon and label, `aria-current` on the screen shown, the Parked pill with its count panel. */
function navLink(name, here, parked) {
  const p = PAGES[name];
  return html`<a href="${p.path}"${name === here ? html` aria-current="page"` : null}>${ui.icon(p.icon)}${p.nav}${name === "parked" ? parked : null}</a>`;
}

/** The theme button, named for the choice the page was drawn in; drawn hidden, the script shows it (see the header). */
function themeButton(theme) {
  const label = themeLabel(theme);
  return html`<button class="roundbtn" type="button" data-theme-toggle hidden aria-label="${label}" title="${label}">${ui.icon("theme")}</button>`;
}

/** The pi-dispatch pill that opens the bar: a link to the overview (the sign-in page, for someone not signed in). */
function brandPill() {
  return html`<a class="brandpill" href="${PAGES.overview.path}"><span class="brandpill__m" aria-hidden="true">pi</span>pi-dispatch</a>`;
}

/** The navigation: the pills, then the More menu with what the role may open of `NAV_MORE` (none: no menu). */
function navHtml(here, role, parked) {
  const more = NAV_MORE.filter((n) => mayOpen(n, role));
  const menu = more.length === 0
    ? null
    : html`<details class="more"><summary aria-label="${`More: ${more.map((n) => PAGES[n].nav).join(", ")}`}" title="More">${ui.icon("more")}</summary><div>${more.map((n) => navLink(n, here, null))}</div></details>`;
  return html`<nav class="pillnav" aria-label="Console screens">${NAV.filter((n) => mayOpen(n, role)).map((n) => navLink(n, here, parked))}${menu}</nav>`;
}

/** The signed-in top bar: the pill, the navigation (`here` the current screen, or none), the end, by the session. */
function signedInBar({ here, role, parked, live, theme, readOnly, session }) {
  const s = session ?? {};
  // Name and role share one column, so the longer of the two is cut first with an ellipsis where the bar is short of
  // room (for "ops, Operator", the role; SHELL_CSS), and a phone shows the avatar alone, so the block carries both whole
  // in its title ("ops, Operator").
  const whoName = s.name ?? "-";
  const roleWord = role === null ? "-" : ROLE_WORDS[role];
  // `data-name` and `data-role` are the session's own, for the script (issue #737): a probe's 200 reloads the page only
  // into this same person, never into whoever this browser's cookie names by then. Absent when there is none to name.
  const whoData = typeof s.name === "string" && role !== null ? html` data-name="${s.name}" data-role="${role}"` : null;
  const who = html`<span class="who"${whoData} title="${role === null ? whoName : `${whoName}, ${roleWord}`}"><span><b>${whoName}</b><small>${roleWord}</small></span><span class="avatar">${initialsOf(s.name)}</span></span>`;
  return html`<header class="${readOnly ? "top top--ro" : "top"}">${brandPill()}${navHtml(here, role, parked)}<div class="top__end">${live}${themeButton(theme)}${readOnly ? ui.chip("Read-only console", { status: "attention", icon: "shield" }) : null}${who}<button id="logout" class="roundbtn" type="button" aria-label="Sign out" title="Sign out">${ui.icon("logout")}</button></div></header>`;
}

/** A session's role as the bar knows it, or null for one it does not (which opens no operator page). */
const roleOf = (session) => (typeof session?.role === "string" && Object.hasOwn(ROLE_WORDS, session.role) ? session.role : null);

/**
 * Page `name`'s frame around `inner`. `ctx` is `renderPage`'s: `session`, `readOnly`, `data`, `query`, `theme`, and since
 * PR 2 of issue #737 `flash` (the session's last write, shown once as the done banner), `maxStreams` (the token's
 * stream limit, for the limit note) and `slot` (false keeps the confirm slot off a page that must not have one). The run
 * detail counts as Runs in the navigation and links back to it; its heading names the run.
 *
 * In order inside `<main>`: the title bar (on a page drawn once, when it was drawn and Reload, where the role may open
 * it: a viewer refused the audit log is not offered its address), the read-only banner on a read-only console, the done
 * banner, the live notes on a live page, `inner`, and for an operator on a console that takes changes the confirm slot
 * and the held note's template.
 *
 * `headline` is the page's headline panel's first content (text or a fragment, an empty one included, which the stream
 * fills later), drawn under the title as `#p-headline` (see the header); null, the default, draws no line.
 */
export function shellHtml(name, ctx, inner, { headline = null } = {}) {
  if (typeof name !== "string" || !Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const meta = PAGES[name];
  const role = roleOf(ctx?.session);
  const here = name === "run" ? "runs" : name;
  // Drawn on a live page always, so the stream has a panel to fill; elsewhere only when there is a count to show.
  const count = navParkedHtml(ctx?.data);
  const parked = meta.live || String(count) !== "" ? html`<span id="${NAV_PARKED_ID}" data-panel>${count}</span>` : null;
  const start = LIVE_STATES.start;
  const glyphs = Object.entries(LIVE_GLYPHS).map(([state, glyph]) => liveGlyph(state, glyph));
  const liveHtml = meta.live ? html`<span id="live-status" class="${start.cls}" role="status" aria-live="polite" title="${start.title}"><span class="dot"></span>${glyphs}<span data-live-word>${start.word}</span></span>` : null;
  const back = name === "run" ? html`<a class="back" href="${PAGES.runs.path}">${ui.icon("chev-l", { size: "sm" })}${PAGES.runs.nav}</a>` : null;
  const heading = name === "run" && typeof ctx?.query?.id === "string" && ctx.query.id !== "" ? html`${meta.title} ${ctx.query.id}` : meta.title;
  const reload = mayOpen(name, role) ? selfHref(name, ctx?.query) : null;
  const drawn = !meta.live && reload !== null ? drawnHtml(ctx?.data?.now, reload) : null;
  const readOnly = Boolean(ctx?.readOnly);
  const ro = readOnly ? ui.banner({ status: "attention", icon: "shield", sm: true, title: READ_ONLY_TITLE, body: READ_ONLY_BODY }) : null;
  const flash = ctx?.flash !== null && typeof ctx?.flash === "object" ? doneBannerHtml(ctx.flash) : null;
  const notes = meta.live ? liveNoteHtml({ maxStreams: ctx?.maxStreams, reload }) : null;
  const writes = role === "operator" && !readOnly && ctx?.slot !== false ? html`${confirmSlotHtml()}<template id="held-note">${heldNoteHtml()}</template>` : null;
  const sub = headline === null ? null : html`<p class="titlebar__sub"><span id="${HEADLINE_ID}" data-panel>${headline}</span></p>`;
  return html`<a class="skip" href="#main">Skip to content</a>
${SPRITE}
<div class="page">
${signedInBar({ here, role, parked, live: liveHtml, theme: ctx?.theme, readOnly, session: ctx?.session })}
<main id="main" tabindex="-1">
<div class="titlebar"><div class="titlebar__lead">${back}<h1>${heading}</h1>${sub}</div>${drawn}</div>
${ro}${flash}${notes}${inner}${writes}
</main>
</div>`;
}

/**
 * A whole page in the console's frame for a page that is not a screen (the sign-in pages, the error pages): the skip
 * link (`skip` names it: "Skip to sign-in" on a sign-in page) and the sprite, the top bar, the title bar's `<h1>`, then
 * `inner`. With `nav` and a `session` the bar is the signed-in one: the pills (none marked current: this page is none of
 * them), More by the role, the theme button, the read-only chip, who is signed in and sign-out, and no live pill (the
 * page has no stream). Otherwise it is the sign-in bar: the pi-dispatch pill and the theme button only. `titleShown`
 * false keeps the `<h1>` for a screen reader and draws no title bar (the SignIn card's page is its card alone, whose
 * own heading leads it). `sub` is the title bar's line under the title (the ErrorPage card's "The console could not find
 * what this address points to."), drawn only with a title bar. `name` is the body's `data-page`, which the script and
 * the page's stylesheet read.
 */
export function frameHtml({ name, title, sub = null, theme = null, session = null, readOnly = false, nav = false, skip = "Skip to content", titleShown = true }, inner) {
  const signedIn = nav && session !== null && typeof session === "object";
  const bar = signedIn
    ? signedInBar({ here: null, role: roleOf(session), parked: null, live: null, theme, readOnly: Boolean(readOnly), session })
    : html`<header class="top">${brandPill()}<div class="top__end">${themeButton(theme)}</div></header>`;
  const subLine = typeof sub === "string" && sub !== "" ? html`<p class="titlebar__sub">${sub}</p>` : null;
  const head = titleShown ? html`<div class="titlebar"><div class="titlebar__lead"><h1>${title}</h1>${subLine}</div></div>` : html`<h1 class="sr">${title}</h1>`;
  const body = html`<a class="skip" href="#main">${skip}</a>
${SPRITE}
<div class="page">
${bar}
<main id="main" tabindex="-1">
${head}
${inner}
</main>
</div>`;
  return page({ title: `pi-dispatch console: ${title}`, name, body, theme });
}

/**
 * The sign-in page (the SignIn card): `signin.mjs`'s card, in the sign-in frame, posted by the script as JSON (a plain
 * form POST would be form-encoded and is refused). `theme` is the request's theme choice (`themeOf`), so the page is
 * drawn in the theme the console was left in; `notice` the reason a session ended (`session-ends.mjs`
 * `endedReasonOf`'s, never the query's own bytes); `limits` the console's `{ idleMinutes, maxHours }`; `listen` the
 * config's listen address, for the footer.
 */
export function loginPage({ theme = null, notice = null, limits = {}, listen = null } = {}) {
  return frameHtml({ name: "login", title: "Sign in", theme, skip: "Skip to sign-in", titleShown: false }, signInContent({ notice, limits, listen }));
}

/**
 * The link page's title (the tab's, and the `<h1>` a screen reader reads first): it names the page, never what happens
 * on it. "Signing in", its first title, was false without a script and once the link was refused.
 */
export const LINK_PAGE_TITLE = "One-time sign-in link";

/**
 * The one-time link's landing page (the AccessStates card): the script reads the code from the fragment, drops it from
 * history and posts it, switching the card to `used` or `nocode` as the answer says. `state` is the card's first state;
 * `notice` a notice to draw shown, for a panel golden (`signin.mjs` `linkContent`; the server passes neither).
 */
export function loginCodePage({ theme = null, state = "wait", notice = null } = {}) {
  return frameHtml({ name: "login-code", title: LINK_PAGE_TITLE, theme, skip: "Skip to sign-in", titleShown: false }, linkContent({ state, notice }));
}
