/**
 * The console's one stylesheet, served from `/static/console.css` (issue #641). A string module for `script.mjs`'s
 * reason: `dist/console.mjs` ships as one file. The CSP's `style-src 'self'` admits it because it arrives from a URL on
 * this origin; no page carries a `<style>` element or a `style=` attribute.
 *
 * FIVE PARTS, IN CASCADE ORDER (issue #737, the Pulse design):
 *
 *   1. `tokenCss()`: every design token as a custom property, light by default, dark from `prefers-color-scheme`
 *      unless the page says `data-theme="light"`, and dark when it says `data-theme="dark"` (the theme button's
 *      choice, stamped by the server so there is no flash);
 *   2. `PULSE_CSS`: the design's `bundle.css`, verbatim and pinned by its hash;
 *   3. `SHELL_CSS`: what the shell needs that the bundle does not draw;
 *   4. `pageCss()`: each converted page's own rules, confined to that page;
 *   5. `LEGACY_CSS`: the temporary look of the panels not converted yet, confined to `.legacy` (`compat-css.mjs`
 *      says why and how its deletion is forced).
 *
 * Tokens come first so every later part reads them; the legacy layer comes last so it wins inside `.legacy`, where it
 * alone applies. The old dark palette and its light twin are gone: the insights charts' colours now follow the tokens
 * through the compatibility layer, and `PAGE_THEME` stays where the standalone renderers need it (`graph-html.mjs`).
 */
import { LEGACY_CSS } from "./compat-css.mjs";
import { SHELL_CSS, pageCss } from "./page-css.mjs";
import { PULSE_CSS } from "./pulse-css.mjs";
import { tokenCss } from "./pulse-tokens.mjs";

/** The stylesheet `/static/console.css` serves. */
export const CONSOLE_CSS = [tokenCss(), PULSE_CSS, SHELL_CSS, pageCss(), LEGACY_CSS].join("\n");
