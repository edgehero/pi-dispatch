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
 * the page's `data-page` attribute; values the script needs are never embedded in a script element.
 */
import { escapeHtml } from "../graph-html.mjs";
import { scrubControls } from "../panel.mjs";

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

/** The page shell: one stylesheet-free document, the script by URL, `data-page` for the script to dispatch on. */
export function page({ title, name, body }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<script src="/static/console.js" defer></script>
</head>
<body data-page="${name}">
${body}
</body>
</html>
`;
}

/** The sign-in form. Submitted by the script as JSON; a plain form POST would be form-encoded and is refused. */
export function loginPage() {
  return page({
    title: "pi-dispatch console: sign in",
    name: "login",
    body: html`<main>
<h1>pi-dispatch console</h1>
<form id="login-form" autocomplete="off">
<label for="token">Console token</label>
<input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
<button type="submit">Sign in</button>
</form>
<p id="notice" role="status"></p>
<noscript><p>The console needs JavaScript to sign in.</p></noscript>
</main>`,
  });
}

/** The one-time link landing page: the script reads the code from the fragment, drops it from history and posts it. */
export function loginCodePage() {
  return page({
    title: "pi-dispatch console: signing in",
    name: "login-code",
    body: html`<main>
<h1>pi-dispatch console</h1>
<p id="notice" role="status">Signing in with a one-time link...</p>
<p><a href="/login">Sign in with a token instead</a></p>
</main>`,
  });
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
