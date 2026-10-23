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
 */
import { html, page } from "./html.mjs";
import * as ui from "./kit.mjs";
// A cycle by design: `pages.mjs` draws through `shellHtml`, and this module reads the page table. Neither touches the
// other's exports while it loads, only when a page is drawn, which ES modules allow.
import { LEGACY_PAGES, PAGES } from "./pages.mjs";
import { ICON_NAMES, SPRITE } from "./pulse-icons.mjs";
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

/**
 * `content` in the compatibility wrapper when page `name` is still drawn in the old markup (`LEGACY_PAGES`), so the
 * legacy stylesheet applies inside it and nowhere else; as it is once the page has converted.
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

/**
 * Page `name`'s frame around `inner`. `ctx` is `renderPage`'s (`session`, `readOnly`, `data`, `query`, `theme`). The
 * run detail counts as Runs in the navigation and links back to it; its heading names the run.
 */
export function shellHtml(name, ctx, inner) {
  if (typeof name !== "string" || !Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const meta = PAGES[name];
  const s = ctx?.session ?? {};
  const role = typeof s.role === "string" && Object.hasOwn(ROLE_WORDS, s.role) ? s.role : null;
  const here = name === "run" ? "runs" : name;
  // Drawn on a live page always, so the stream has a panel to fill; elsewhere only when there is a count to show.
  const count = navParkedHtml(ctx?.data);
  const parked = meta.live || String(count) !== "" ? html`<span id="${NAV_PARKED_ID}" data-panel>${count}</span>` : null;
  const start = LIVE_STATES.start;
  const glyphs = Object.entries(LIVE_GLYPHS).map(([state, glyph]) => liveGlyph(state, glyph));
  const liveHtml = meta.live ? html`<span id="live-status" class="${start.cls}" role="status" aria-live="polite" title="${start.title}"><span class="dot"></span>${glyphs}<span data-live-word>${start.word}</span></span>` : null;
  // Name and role share one column, so the longer of the two is cut first with an ellipsis where the bar is short of
  // room (for "ops, Operator", the role; SHELL_CSS), and a phone shows the avatar alone, so the block carries both whole
  // in its title ("ops, Operator").
  const whoName = s.name ?? "-";
  const roleWord = role === null ? "-" : ROLE_WORDS[role];
  const who = html`<span class="who" title="${role === null ? whoName : `${whoName}, ${roleWord}`}"><span><b>${whoName}</b><small>${roleWord}</small></span><span class="avatar">${initialsOf(s.name)}</span></span>`;
  const back = name === "run" ? html`<a class="back" href="${PAGES.runs.path}">${ui.icon("chev-l", { size: "sm" })}${PAGES.runs.nav}</a>` : null;
  const heading = name === "run" && typeof ctx?.query?.id === "string" && ctx.query.id !== "" ? html`${meta.title} ${ctx.query.id}` : meta.title;
  return html`<a class="skip" href="#main">Skip to content</a>
${SPRITE}
<div class="page">
<header class="${ctx?.readOnly ? "top top--ro" : "top"}">${brandPill()}${navHtml(here, role, parked)}<div class="top__end">${liveHtml}${themeButton(ctx?.theme)}${ctx?.readOnly ? ui.chip("Read-only console", { status: "attention", icon: "shield" }) : null}${who}<button id="logout" class="roundbtn" type="button" aria-label="Sign out" title="Sign out">${ui.icon("logout")}</button></div></header>
<main id="main" tabindex="-1">
<div class="titlebar"><div class="titlebar__lead">${back}<h1>${heading}</h1></div></div>
${inner}
</main>
</div>`;
}

/**
 * A sign-in page's frame (the SignIn card's): the skip link and the sprite, then the page wrapper with a top bar of the
 * pi-dispatch pill and the theme button only (nobody is signed in: no navigation, no live pill, no sign-out), a title
 * bar, and `inner` as legacy. The theme button works here as on every page: the script only sets `<html data-theme>`
 * and writes the cookie, and the next page is drawn from it.
 */
function signInFrame(name, theme, inner) {
  return html`<a class="skip" href="#main">Skip to content</a>
${SPRITE}
<div class="page">
<header class="top">${brandPill()}<div class="top__end">${themeButton(theme)}</div></header>
<main id="main" tabindex="-1">
<div class="titlebar"><div class="titlebar__lead"><h1>pi-dispatch console</h1></div></div>
${legacyWrap(name, inner)}
</main>
</div>`;
}

/**
 * The sign-in form. Submitted by the script as JSON; a plain form POST would be form-encoded and is refused. `theme`
 * is the request's theme choice (`themeOf`), so the page is drawn in the theme the console was left in.
 */
export function loginPage({ theme = null } = {}) {
  return page({
    title: "pi-dispatch console: sign in",
    name: "login",
    theme,
    body: signInFrame("login", theme, html`<form id="login-form" autocomplete="off">
<label for="token">Console token</label>
<input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
<button type="submit">Sign in</button>
</form>
<p id="notice" role="status"></p>
<noscript><p>The console needs JavaScript to sign in.</p></noscript>`),
  });
}

/** The one-time link landing page: the script reads the code from the fragment, drops it from history and posts it. */
export function loginCodePage({ theme = null } = {}) {
  return page({
    title: "pi-dispatch console: signing in",
    name: "login-code",
    theme,
    body: signInFrame("login-code", theme, html`<p id="notice" role="status">Signing in with a one-time link...</p>
<p><a href="/login">Sign in with a token instead</a></p>`),
  });
}
