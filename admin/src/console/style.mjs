/**
 * The console's one stylesheet, served from `/static/console.css` (issue #641). A string module for `script.mjs`'s
 * reason: `dist/console.mjs` ships as one file. The CSP's `style-src 'self'` admits it because it arrives from a URL on
 * this origin; no page carries a `<style>` element or a `style=` attribute.
 *
 * BUILT FROM THE INSIGHTS PAGE'S OWN CSS, NOT A COPY OF IT. The spend screen renders the insights section renderers
 * (`insights-html.mjs`), whose class names and ids `INSIGHTS_CSS` styles, so that CSS is included as the module exports
 * it, with each `PAGE_THEME` colour rewritten to a custom property (`themed`). A change to the insights page's layout
 * then reaches the console with no second edit, and the colours can follow the reader's light or dark preference.
 *
 * LIGHT AND DARK. The insights palette is dark (`PAGE_THEME`), and it stays the default. `prefers-color-scheme: light`
 * swaps every token for `LIGHT_THEME`, a light variant of the same roles (canvas, panel, border, text, dim, accent and
 * the three states). The charts draw their colours as SVG presentation attributes (`fill="#58a6ff"`), which a custom
 * property cannot reach, so one rule per token re-points those attributes at the token (`svgTokenRules`): an author
 * style rule beats a presentation attribute, and in the dark theme it resolves to the same colour.
 */
import { PAGE_THEME } from "../graph-html.mjs";
import { INSIGHTS_CSS } from "../insights-html.mjs";

/** The two colours `INSIGHTS_CSS` writes literally beside `PAGE_THEME`'s: the banner fill and the header controls. */
const INSIGHTS_EXTRA = Object.freeze({ bannerBg: "#2d1517", control: "#21262d" });

/** The dark palette: the insights page's, by role. */
export const DARK_THEME = Object.freeze({ ...PAGE_THEME, ...INSIGHTS_EXTRA });

/** The light palette: the same roles, each with contrast against a white canvas (text and dim at 4.5:1 or better). */
export const LIGHT_THEME = Object.freeze({
  canvas: "#ffffff",
  panel: "#f6f8fa",
  border: "#d0d7de",
  fg: "#1f2328",
  dim: "#59636e",
  accent: "#0969da",
  amber: "#9a6700",
  danger: "#cf222e",
  green: "#1a7f37",
  chipStroke: "#6e7781",
  bannerBg: "#ffebe9",
  control: "#eaeef2",
});

/** A role's custom property: `chipStroke` is `--pd-chip-stroke`. */
const tokenOf = (role) => `--pd-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** Every role as a declaration list, for `:root`. */
const declarations = (theme) => Object.entries(theme).map(([role, hex]) => `${tokenOf(role)}:${hex}`).join(";");

/**
 * `css` with each dark-palette colour replaced by its token. Longest first, and never inside a longer hex literal (the
 * lookahead), so `#999` cannot rewrite part of `#9999aa`.
 */
function themed(css) {
  let out = css;
  for (const [role, hex] of Object.entries(DARK_THEME).sort((a, b) => b[1].length - a[1].length)) {
    out = out.replace(new RegExp(`${hex}(?![0-9a-fA-F])`, "gi"), `var(${tokenOf(role)})`);
  }
  return out;
}

/** The charts' presentation attributes, re-pointed at the tokens (see the header). */
function svgTokenRules() {
  return Object.entries(DARK_THEME)
    .flatMap(([role, hex]) => [`svg [fill="${hex}"]{fill:var(${tokenOf(role)})}`, `svg [stroke="${hex}"]{stroke:var(${tokenOf(role)})}`])
    .join("\n");
}

/** The console's own layout, after the insights rules so it wins where both style one element (the body, a section). */
const LAYOUT_CSS = `
html{color-scheme:dark}
body{background:var(--pd-canvas);color:var(--pd-fg);padding:0}
a{color:var(--pd-accent)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--pd-accent);outline-offset:2px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:var(--pd-panel);border-bottom:1px solid var(--pd-border)}
.brand{font-weight:600;color:var(--pd-fg);text-decoration:none}
.top nav ul{display:flex;flex-wrap:wrap;gap:4px;list-style:none}
.top nav a{display:block;padding:4px 10px;border-radius:6px;text-decoration:none;color:var(--pd-fg)}
.top nav a[aria-current="page"]{background:var(--pd-control);font-weight:600}
.who{color:var(--pd-dim);font-size:12px;margin-left:auto}
#live-status{font-size:12px;color:var(--pd-dim)}
#live-status.on{color:var(--pd-green)}
#live-status.off{color:var(--pd-amber)}
button,input,select{font:inherit;color:var(--pd-fg);background:var(--pd-control);border:1px solid var(--pd-border);border-radius:6px;padding:4px 10px}
main{max-width:1100px;margin:0 auto;padding:16px}
main>h1{font-size:18px;margin:4px 0 12px}
section[data-panel]{max-width:none;margin:0 0 16px;padding:12px 14px;background:var(--pd-panel);border:1px solid var(--pd-border);border-radius:6px}
section[data-panel] section{margin:12px 0;max-width:none}
section[data-panel] h2{font-size:14px;margin:0 0 8px}
p{margin:4px 0}
.note{color:var(--pd-dim);font-size:12px}
.warn{color:var(--pd-amber)}
.bad{color:var(--pd-danger)}
.good{color:var(--pd-green)}
.big{font-size:22px;font-weight:600}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:13px}
.facts dt{color:var(--pd-dim)}
.facts dd{margin:0;overflow-wrap:anywhere}
.tiles{display:flex;flex-wrap:wrap;gap:10px}
.tile{flex:1 1 160px;padding:8px 12px;border:1px solid var(--pd-border);border-radius:6px;background:var(--pd-canvas)}
.tile .l{color:var(--pd-dim);font-size:12px}
.scroll{overflow-x:auto}
table.grid{border-collapse:collapse;width:100%;font-size:13px}
table.grid th,table.grid td{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid var(--pd-border);vertical-align:top}
table.grid th{color:var(--pd-dim);font-weight:500}
table.grid td.num,table.grid th.num{text-align:right}
table.grid tr.warn td{color:var(--pd-amber)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
form.filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px 12px;align-items:end}
form.filters label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--pd-dim)}
form.filters .actions{display:flex;gap:8px;align-items:center}
.pager{display:flex;gap:16px;margin-top:10px;font-size:13px}
.range{display:flex;gap:8px;list-style:none}
.range a{padding:3px 10px;border:1px solid var(--pd-border);border-radius:6px;text-decoration:none}
.range a[aria-current="page"]{background:var(--pd-control);font-weight:600}
details{margin:6px 0}
details summary{cursor:pointer}
details p{margin:4px 0 4px 16px}
ul.plain{list-style:none}
ul.plain li{margin:2px 0}
.hidden-tips{display:none}
@media (max-width:640px){.who{margin-left:0}.facts{grid-template-columns:1fr}}
`;

/** The light override: every token, plus the browser's own controls and scrollbars. */
const LIGHT_CSS = `@media (prefers-color-scheme: light){html{color-scheme:light}:root{${declarations(LIGHT_THEME)}}}`;

/** The stylesheet `/static/console.css` serves. */
export const CONSOLE_CSS = [`:root{${declarations(DARK_THEME)}}`, themed(INSIGHTS_CSS).trim(), svgTokenRules(), LAYOUT_CSS.trim(), LIGHT_CSS, ""].join("\n");
