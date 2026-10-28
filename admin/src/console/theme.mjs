/**
 * The console's theme choice (issue #737): follow the system (the default), or a person's own light or dark, kept in a
 * cookie the browser script writes and the server reads, so a page is drawn in its theme from the first byte and never
 * flashes the other one.
 *
 * WHY A COOKIE THE SERVER READS, AND NOT A SCRIPT THAT SETS THE THEME. The script is deferred: by the time it could set
 * `data-theme` the page has been painted once in the system's colours. The server stamps `<html data-theme>` instead,
 * from this cookie, before anything is painted. The server never SETS the cookie (no response carries it): the theme
 * button does, in the browser, and a page with no cookie follows the system exactly as it always did.
 *
 * WHY THE NAME IS `pd_theme`. The console's own secrets all start `pdc_` (the session cookie, the tokens), and the
 * server test's leak canary fails on any response body holding that prefix; the theme cookie is not a secret, and the
 * script that writes it is a response body.
 *
 * WHY `SameSite=Lax` AND NOT `Strict`. The cookie is a preference, not a credential: it opens nothing and a forged one
 * can only pick a colour. `Strict` withholds it on a navigation that starts on another site, and the pages such a
 * navigation can draw are the sign-in page and the one-time link's landing page (a link from a chat, an email, the
 * `pi-dispatch-console link` output pasted elsewhere): drawn in the system's theme, then the next page in the person's
 * own. `Lax` sends it on such a top-level navigation and still never on another site's subrequests. It does NOT carry
 * a page past sign-in: the session cookie (`sessions.mjs`) stays `Strict`, because it is the credential, so a run page
 * opened from a link on another site (a forge comment) arrives without a session and is a redirect to sign-in, which
 * this cookie then draws in the chosen theme.
 *
 * THE COOKIE IS NOT TRUSTED. Anything may arrive in it (another tool on localhost, a hand-edited value, a second copy).
 * `themeOf` answers from a closed set, so the page never carries the cookie's own bytes: what reaches
 * `<html data-theme>` is one of `THEMES`, or nothing.
 */

/** The cookie the theme button writes. Not `pdc_`: see the header. */
export const THEME_COOKIE = "pd_theme";

/** The themes a person may choose over the system's. No entry means "follow the system". */
export const THEMES = Object.freeze(["light", "dark"]);

/** The `color-scheme` a page that follows the system offers: both, so the browser picks the system's. */
export const SYSTEM_SCHEME = "light dark";

/** How long the browser keeps a choice: a year, renewed by every click of the theme button. */
export const THEME_COOKIE_MAX_AGE_SEC = 31_536_000;

/**
 * The cookie's `SameSite`: `Lax`, so the sign-in page and the one-time link's page, opened from a link on another site,
 * are drawn in the chosen theme too (see the header: the session is `Strict`, so no other page is reached that way).
 */
export const THEME_COOKIE_SAME_SITE = "Lax";

/**
 * What the theme button says it is set to, by choice (`system` for none): its accessible name and its tooltip, the same
 * words on the server's first draw and after the script's every click, since the script is written from this table.
 */
export const THEME_LABELS = Object.freeze({ system: "Theme: follows the system", light: "Theme: light", dark: "Theme: dark" });

/**
 * The theme button's words for a page drawn in `theme` (`themeOf`'s answer, or anything else): read as an OWN key of
 * `THEME_LABELS` only, so a value such as `constructor` names the system's choice instead of reaching a prototype's.
 */
export function themeLabel(theme) {
  return typeof theme === "string" && Object.hasOwn(THEME_LABELS, theme) ? THEME_LABELS[theme] : THEME_LABELS.system;
}

/**
 * The theme a request's `Cookie` header chose: `"light"`, `"dark"`, or null (follow the system). Null for no header,
 * no `pd_theme`, a value that is not EXACTLY one of `THEMES` (case counts: `Dark` is not `dark`), and for a header that
 * carries the cookie twice: neither copy is known to be the person's latest choice, and guessing one would draw a theme
 * they may have just turned off. The answer is always the constant from `THEMES`, never a slice of the header.
 *
 * A SECOND COPY. The theme button writes one cookie, on `Path=/` for this host. A second can only come from elsewhere:
 * a copy set on a sub-path (`Path=/runs`) or for another `Domain` (a parent domain the console's host name sits under),
 * by another tool or by hand. While such a copy exists the browser sends both, this answers null, and every click of
 * the theme button silently does nothing after a reload: the button rewrites its own copy, the stray one stays, and the
 * server keeps drawing the system's theme. Clearing the stray copy (the browser's site data) ends it.
 */
export function themeOf(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader === "") return null;
  let found = null;
  let copies = 0;
  for (const pair of cookieHeader.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0 || pair.slice(0, at).trim() !== THEME_COOKIE) continue;
    copies += 1;
    found = pair.slice(at + 1).trim();
  }
  if (copies !== 1) return null;
  const i = THEMES.indexOf(found);
  return i < 0 ? null : THEMES[i];
}
