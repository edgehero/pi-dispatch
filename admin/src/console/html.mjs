/**
 * The console's pages and the one way to build HTML (issue #640, REQ-CONSOLE-SECURITY clause f and the run-text rule).
 *
 * `html` is a tagged template that ESCAPES EVERY INTERPOLATION: control bytes scrubbed first (`scrubControls`, the
 * panel's class, so a bidi override or an ESC in a token name cannot reorder or hide the page's text), then
 * `escapeHtml` (the graph page's, which also makes the string well-formed). Raw interpolation is impossible by
 * construction: the only value that passes through unescaped is a `SafeHtml` that `html` itself built, and `raw()`
 * accepts nothing else. There is deliberately no `raw(string)`: a helper that trusts a string is the helper a later
 * screen passes run text to.
 *
 * No page carries inline script or style (the CSP forbids both). Behaviour lives in `/static/console.js`, which reads
 * the page's `data-page` attribute; values the script needs are never embedded in a script element. The one exception
 * to "only `html` builds a fragment" is `trustedRenderer`, for the insights renderers' already-escaped output (issue
 * #641), and it checks what it admits.
 *
 * Since issue #737 the frames inside `<body>` (the signed-in shell, and the sign-in pages built on `page`) are drawn by
 * `shell.mjs`. They cannot live here: the shell draws the icon sprite, and `pulse-icons.mjs` builds it with `html` as
 * it loads, so this module importing the shell would ask for `html` before this module had defined it.
 */
import { escapeHtml } from "../graph-html.mjs";
import { scrubControls, scrubControlsPerLine } from "../panel.mjs";
import { SYSTEM_SCHEME, THEMES } from "./theme.mjs";

/** An already-escaped HTML fragment. Only `html` makes one. */
class SafeHtml {
  #text;
  constructor(text) {
    this.#text = text;
  }
  toString() {
    return this.#text;
  }
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(scrubControls(String(value)));
}

/** Build a fragment; every `${value}` is escaped unless it is a fragment `html` built. Arrays are rendered item by item. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/**
 * Join already-built fragments into one. Throws on anything that is not a fragment, so a string can never be
 * smuggled past the escaping by wrapping it.
 */
export function raw(...fragments) {
  for (const f of fragments.flat()) {
    if (!(f instanceof SafeHtml)) throw new TypeError("raw() takes only fragments built by html``, never a string");
  }
  return new SafeHtml(fragments.flat().map(String).join(""));
}

/** True for a fragment `html` built. */
export function isSafeHtml(value) {
  return value instanceof SafeHtml;
}

/**
 * What a page's theme choice (`theme.mjs` `themeOf`: "light", "dark" or null) puts in its head, by choice, derived from
 * `THEMES`: the `data-theme` attribute on `<html>`, which the stylesheet's tokens follow, and the `color-scheme` meta,
 * so the browser's own parts (scrollbars, form controls, the canvas before the stylesheet arrives) match it. A value not
 * in the table (null, or anything a caller got wrong) is the system's: no attribute, and both schemes offered. The
 * attribute comes from this frozen table and never from the value asked with, so no caller can put its own bytes there.
 */
const THEME_HEAD = Object.freeze(Object.fromEntries(THEMES.map((t) => [t, Object.freeze({ attr: html` data-theme="${t}"`, scheme: t })])));
const SYSTEM_HEAD = Object.freeze({ attr: null, scheme: SYSTEM_SCHEME });

/**
 * The page shell: the stylesheet and the script by URL, `data-page` for the script to dispatch on. A live page (issue
 * #641) also carries `data-live` (the page name the event stream is opened for) and `data-query` (its query string,
 * encoded here like any value), so the script can reopen the stream with exactly what rendered the page. Neither is
 * ever read as markup: the script passes them to `EventSource` as a URL. `theme` (issue #737) is the person's theme
 * choice (`THEME_HEAD`); the theme button's script changes the same two places when it is clicked.
 */
export function page({ title, name, body, live = null, query = "", theme = null }) {
  const liveAttrs = live ? html` data-live="${live}" data-query="${query ?? ""}"` : null;
  const head = typeof theme === "string" && Object.hasOwn(THEME_HEAD, theme) ? THEME_HEAD[theme] : SYSTEM_HEAD;
  return html`<!doctype html>
<html lang="en"${head.attr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${head.scheme}">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="/static/console.css">
<script src="/static/console.js" defer></script>
</head>
<body data-page="${name}"${liveAttrs}>
${body}
</body>
</html>
`;
}

/**
 * What `trustedRenderer` refuses: a `<script` or `<style` element, and inside any tag an `on…=` handler, a `style=`
 * attribute or a `javascript:` URL in a link or source attribute. The console's CSP would block each at the browser;
 * this check makes a regression in a renderer fail at the server, loudly, before any page carries it. The attribute
 * checks look INSIDE TAGS only (`<[^>]*`): the renderers escape every value, so text never holds a `<`, and a run's
 * target that merely reads "onload=" or "javascript:" stays text instead of taking the whole screen down.
 */
const RENDERER_REFUSED = [/<\s*(?:script|style)\b/i, /<[^>]*\s(?:on[a-z]+|style)\s*=/i, /<[^>]*\s(?:href|src|xlink:href|action|formaction)\s*=\s*["']?\s*javascript:/i];

/**
 * Admit the output of ONE family of renderers as a fragment: the insights section renderers (`insights-html.mjs`,
 * `graph-html.mjs`), which escape every value they interpolate with their own `escapeHtml` and are pinned by their own
 * tests (issue #641). Nothing else may be passed here: a page's own markup is built with `html`, and run text never
 * reaches this function. The string is still checked (`RENDERER_REFUSED`), and a match THROWS rather than being
 * cleaned, so a renderer that starts emitting script or inline style breaks the page instead of shipping it.
 *
 * Control bytes ARE cleaned, line by line (`scrubControlsPerLine`, the panel's class, newlines kept): the renderers
 * escape markup but not controls, and a run record's target can carry one into the topology's labels (measured with
 * this module's hostile fixture: a repository name with an ESC reached the SVG text). A control byte is inert in HTML,
 * so substituting it changes no structure, and the console's every-value-scrubbed rule then holds here too.
 */
export function trustedRenderer(input) {
  if (typeof input !== "string") throw new TypeError("trustedRenderer() takes an insights renderer's string output");
  const str = scrubControlsPerLine(input);
  for (const rule of RENDERER_REFUSED) {
    const hit = rule.exec(str);
    if (hit) throw new Error(`an insights renderer emitted markup the console refuses (${JSON.stringify(hit[0].slice(0, 60))})`);
  }
  return new SafeHtml(str);
}

/** The signed-in placeholder (#641 replaces the body with screens). `name` and `role` are escaped like any value. */
export function signedInPage({ name, role, readOnly }) {
  return page({
    title: "pi-dispatch console",
    name: "home",
    body: html`<main>
<h1>pi-dispatch console</h1>
<p>Signed in as <strong>${name}</strong> (${role}).</p>
${readOnly ? html`<p>This console is read-only.</p>` : null}
<button id="logout" type="button">Sign out</button>
<p id="notice" role="status"></p>
</main>`,
  });
}
