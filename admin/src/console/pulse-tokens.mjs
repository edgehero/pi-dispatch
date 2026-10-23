/**
 * The Pulse design tokens (issue #737): every colour in both themes, the two font stacks, spacing, radius and layout,
 * and the custom properties the console stylesheet reads them through (`tokenCss`, first in `CONSOLE_CSS`).
 *
 * A VERBATIM COPY, PINNED BY ITS CONTENT HASH. `PULSE_TOKENS` is the design system's `tokens.json` as an object
 * literal: the same keys in the same order, the same values, the same `usage` sentences, generated from the file
 * rather than typed. The design folder is not in this repository, so nothing here can derive the copy from it, and
 * CLAUDE.md's rule for a copy of an external file is that the copy is pinned by that file's content hash.
 * `PULSE_TOKENS_SHA256` is the hash of `tokens.json`, and `JSON.stringify(PULSE_TOKENS, null, 1)` reproduces the file
 * byte for byte, so `admin/test/console-contrast.test.mjs` holds the two together: a value edited here alone turns
 * it red, and a new `tokens.json` is pasted whole with its hash moved in the same commit. The `usage` sentences stay
 * because that test reads them: a token's backticked grounds and stated ratio are its contrast contract.
 *
 * LIGHT, DARK AND THE SYSTEM. `tokenCss()` writes three rules. `:root` carries the light colours and every token that
 * is not a colour, so a browser that understands nothing more still draws a complete light page. The
 * `prefers-color-scheme: dark` block swaps in the dark colours on `:root:not([data-theme="light"])`, so the system's
 * preference decides unless the person forced light. `:root[data-theme="dark"]` repeats the dark colours for a person
 * who forced dark on a light system. No `data-theme` attribute means "follow the system". `color-scheme` follows the
 * colours in each rule, so scrollbars and form controls match the page.
 *
 * WHY NOT `light-dark()`. One `--x:light-dark(#light,#dark)` per token would be shorter, but a browser without the
 * function (Chrome before 123, Firefox before 120, Safari before 17.5) drops each such declaration as invalid, and
 * with it every colour on the page. The three rules above degrade to the light theme instead.
 */

/** The sha256 of `tokens.json`, which `JSON.stringify(PULSE_TOKENS, null, 1)` reproduces (see the header). */
export const PULSE_TOKENS_SHA256 = "23a272327010840ed86e4138c3d2c904831b7a33a24d7a9dcb67a58cb1c1c868";

/** `tokens.json`, verbatim and deep-frozen. Generated from the file; never edit a value by hand. */
export const PULSE_TOKENS = deepFreeze({
  name: "pi-dispatch console",
  version: 2,
  color: {
    themes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }],
    tokens: [
      {
        name: "canvas",
        value: { light: "#edeeec", dark: "#000000" },
        usage: "Page background behind cards and the sidebar.",
      },
      {
        name: "surface",
        value: { light: "#ffffff", dark: "#161717" },
        usage: "Cards: the one container. Everything a person reads sits on a card.",
      },
      {
        name: "surface-2",
        value: { light: "#f4f5f3", dark: "#202121" },
        usage: "Insets inside a card: chips, quotes, the answer box, track beds, the side panel.",
      },
      {
        name: "surface-3",
        value: { light: "#e8eae7", dark: "#2b2c2c" },
        usage: "Secondary pill buttons, hover rows, unselected segments.",
      },
      {
        name: "line",
        value: { light: "#e3e5e2", dark: "#2a2b2b" },
        usage: "Hairlines between rows inside a card. Decorative only.",
      },
      {
        name: "line-strong",
        value: { light: "#7f8682", dark: "#6d7370" },
        usage: "Input and outline-button borders, empty slot rings: 3:1 on `surface` and `surface-2`.",
      },
      {
        name: "ink",
        value: { light: "#131514", dark: "#f3f4f2" },
        usage: "Primary text on `canvas`, `surface`, `surface-2`, `surface-3`.",
      },
      {
        name: "ink-muted",
        value: { light: "#5b625e", dark: "#a6aca8" },
        usage: "Labels, meta, units on the same grounds as `ink`.",
      },
      {
        name: "ink-faint",
        value: { light: "#69706c", dark: "#8e9490" },
        usage: "Axis numerals and hints only; 4.5:1 on `surface` and `surface-2`.",
      },
      {
        name: "primary",
        value: { light: "#131514", dark: "#f3f4f2" },
        usage: "The one primary action per card: a solid pill. Also the active nav item.",
      },
      {
        name: "on-primary",
        value: { light: "#ffffff", dark: "#131514" },
        usage: "Text and icons on `primary`.",
      },
      {
        name: "focus",
        value: { light: "#2a5bdc", dark: "#8fb0ff" },
        usage: "Keyboard focus ring (2px, offset 2px) and links in sentences.",
      },
      {
        name: "running",
        value: { light: "#3667f0", dark: "#7b9dff" },
        usage: "Running now; the live edge. As a mark: dots, ring arcs, pill bars, timeline pills.",
      },
      {
        name: "running-ink",
        value: { light: "#2350cf", dark: "#a9bfff" },
        usage: "Text and glyphs that mean running, on `surface`, `surface-2` and `running-tint`.",
      },
      {
        name: "running-tint",
        value: { light: "#e5ecff", dark: "#172038" },
        usage: "Pastel ground of a running card, tile or badge.",
      },
      {
        name: "on-running",
        value: { light: "#ffffff", dark: "#0b1330" },
        usage: "Text on a solid `running` fill.",
      },
      {
        name: "parked",
        value: { light: "#8155ee", dark: "#b49cff" },
        usage: "Waiting for a person: a parked question or, later, an approval. As a mark: dots, ring arcs, pill bars, timeline pills.",
      },
      {
        name: "parked-ink",
        value: { light: "#6236d4", dark: "#cdbdff" },
        usage: "Text and glyphs that mean parked, on `surface`, `surface-2` and `parked-tint`.",
      },
      {
        name: "parked-tint",
        value: { light: "#efe8ff", dark: "#221b38" },
        usage: "Pastel ground of a parked card, tile or badge.",
      },
      {
        name: "on-parked",
        value: { light: "#ffffff", dark: "#1a1235" },
        usage: "Text on a solid `parked` fill.",
      },
      {
        name: "failed",
        value: { light: "#d4392c", dark: "#ff786b" },
        usage: "Failed runs and failing checks. As a mark: dots, ring arcs, pill bars, timeline pills.",
      },
      {
        name: "failed-ink",
        value: { light: "#b92a1e", dark: "#ffa79f" },
        usage: "Text and glyphs that mean failed, on `surface`, `surface-2` and `failed-tint`.",
      },
      {
        name: "failed-tint",
        value: { light: "#ffe8e5", dark: "#331817" },
        usage: "Pastel ground of a failed card, tile or badge.",
      },
      {
        name: "on-failed",
        value: { light: "#ffffff", dark: "#2e0804" },
        usage: "Text on a solid `failed` fill.",
      },
      {
        name: "refused",
        value: { light: "#ef8a1d", dark: "#ffab4f" },
        usage: "Refused before spend: a rule said no. As a mark: dots, ring arcs, pill bars, timeline pills.",
      },
      {
        name: "refused-ink",
        value: { light: "#964d00", dark: "#ffc98d" },
        usage: "Text and glyphs that mean refused, on `surface`, `surface-2` and `refused-tint`.",
      },
      {
        name: "refused-tint",
        value: { light: "#fff0dd", dark: "#30220f" },
        usage: "Pastel ground of a refused card, tile or badge.",
      },
      {
        name: "on-refused",
        value: { light: "#2b1500", dark: "#2b1500" },
        usage: "Text on a solid `refused` fill.",
      },
      {
        name: "attention",
        value: { light: "#e2b100", dark: "#ffd24d" },
        usage: "Warnings: a late heartbeat, a doctor warning, a held slot. As a mark: dots, ring arcs, pill bars, timeline pills.",
      },
      {
        name: "attention-ink",
        value: { light: "#735400", dark: "#ffe08a" },
        usage: "Text and glyphs that mean attention, on `surface`, `surface-2` and `attention-tint`.",
      },
      {
        name: "attention-tint",
        value: { light: "#fff6d4", dark: "#2c250e" },
        usage: "Pastel ground of a attention card, tile or badge.",
      },
      {
        name: "on-attention",
        value: { light: "#2a1f00", dark: "#2a1f00" },
        usage: "Text on a solid `attention` fill.",
      },
      {
        name: "ok",
        value: { light: "#177f45", dark: "#5ed692" },
        usage: "Completed runs and healthy hosts. As a mark: dots, ring arcs, pill bars, timeline pills.",
      },
      {
        name: "ok-ink",
        value: { light: "#16703d", dark: "#97e7b8" },
        usage: "Text and glyphs that mean ok, on `surface`, `surface-2` and `ok-tint`.",
      },
      {
        name: "ok-tint",
        value: { light: "#e2f5e9", dark: "#132a1d" },
        usage: "Pastel ground of a ok card, tile or badge.",
      },
      {
        name: "on-ok",
        value: { light: "#ffffff", dark: "#062413" },
        usage: "Text on a solid `ok` fill.",
      },
      {
        name: "idle",
        value: { light: "#9aa09c", dark: "#5f6562" },
        usage: "Held, delayed, cancelled and free slots: neutral marks.",
      },
      {
        name: "idle-tint",
        value: { light: "#eef0ee", dark: "#222423" },
        usage: "Ground of neutral tiles (held, scheduled, cancelled).",
      },
      {
        name: "dot-off",
        value: { light: "#e4e7e3", dark: "#262828" },
        usage: "Unlit dots in dot matrices and empty ring tracks.",
      },
      {
        name: "canvas-dot",
        value: { light: "#cdd1cc", dark: "#2c2e2d" },
        usage: "The dotted grid on the flow canvas.",
      },
    ],
  },
  type: {
    fonts: [],
    families: {
      sans: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
      mono: "ui-monospace, \"SF Mono\", \"Cascadia Mono\", \"Segoe UI Mono\", Menlo, Consolas, monospace",
    },
    groups: [
      {
        name: "Display",
        family: "sans",
        styles: [
          {
            name: "t-hero",
            fontSize: "36px",
            lineHeight: "42px",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            sample: "3 runs need you",
            usage: "The page's one headline: what needs the person, in a count.",
          },
          {
            name: "t-kpi",
            fontSize: "32px",
            lineHeight: "36px",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            sample: "$15.04",
            usage: "A single number a card is about. Tabular figures.",
          },
        ],
      },
      {
        name: "Text",
        family: "sans",
        styles: [
          {
            name: "t-title",
            fontSize: "17px",
            lineHeight: "24px",
            fontWeight: 650,
            sample: "Needs you",
            usage: "Card titles, sentence case.",
          },
          {
            name: "t-lead",
            fontSize: "16px",
            lineHeight: "24px",
            fontWeight: 500,
            sample: "Should the export rate limit apply per API key?",
            usage: "A quoted question, the headline's sub-sentence.",
          },
          {
            name: "t-body",
            fontSize: "14px",
            lineHeight: "20px",
            fontWeight: 400,
            sample: "Refused: the egress proxy is not running on build3.",
            usage: "Body copy and reason sentences.",
          },
          {
            name: "t-label",
            fontSize: "14px",
            lineHeight: "20px",
            fontWeight: 600,
            sample: "gh-f0c2 failed on mini1",
            usage: "The subject of a row or card, button text.",
          },
          {
            name: "t-small",
            fontSize: "12px",
            lineHeight: "16px",
            fontWeight: 500,
            sample: "26m ago",
            usage: "Meta: times, hosts, axis labels, legends.",
          },
        ],
      },
      {
        name: "Code",
        family: "mono",
        styles: [
          {
            name: "t-code",
            fontSize: "13px",
            lineHeight: "18px",
            fontWeight: 500,
            sample: "gh-b3d7",
            usage: "Job ids, commands, config keys.",
          },
        ],
      },
    ],
  },
  spacing: {
    tokens: [
      { name: "space-1", value: "4px", usage: "Icon to label inside a chip." },
      { name: "space-2", value: "8px", usage: "Between chips; pill padding block." },
      { name: "space-3", value: "12px", usage: "Between rows in a card." },
      { name: "space-4", value: "16px", usage: "Gap between cards; pill padding inline." },
      { name: "space-5", value: "20px", usage: "Card padding." },
      { name: "space-6", value: "24px", usage: "Hero card padding; page gutter." },
      { name: "space-8", value: "32px", usage: "Between page sections." },
      { name: "space-10", value: "40px", usage: "Top of a focus column." },
    ],
  },
  radius: {
    tokens: [
      { name: "radius-sm", value: "8px", usage: "Inline chips, small tiles inside a card." },
      { name: "radius-md", value: "14px", usage: "Icon tiles, inputs, quotes, rows inside a card, the confirm bar." },
      { name: "radius-lg", value: "26px", usage: "Cards: every panel on a page." },
      { name: "radius-xl", value: "32px", usage: "The sign-in card and dialogs." },
      { name: "radius-pill", value: "999px", usage: "Buttons, nav items, filters, timeline pills, progress bars." },
    ],
  },
  layout: {
    tokens: [
      {
        name: "side-w",
        value: "470px",
        usage: "The right-hand column beside a page's main card (waitlists, inspector, answer box).",
      },
      {
        name: "control-h",
        value: "48px",
        usage: "Height of nav pills, filter pills and round buttons in the top bar.",
      },
    ],
  },
});

/** `value` with every object and array in it frozen, so no importer can change a token in place. */
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** The theme ids, from the file: `light` and `dark`. */
const THEME_IDS = PULSE_TOKENS.color.themes.map((theme) => theme.id);

/** Each colour token by name. */
const COLOR_BY_NAME = new Map(PULSE_TOKENS.color.tokens.map((token) => [token.name, token]));

/**
 * The hex of colour token `name` in `theme` (`"light"` or `"dark"`). Throws on an unknown name or theme: both are
 * closed sets, so a miss is a programming error, never a colour to guess.
 */
export function colorOf(name, theme) {
  const token = COLOR_BY_NAME.get(name);
  if (!token) throw new Error(`colorOf: unknown colour token ${String(name)}`);
  if (!THEME_IDS.includes(theme)) throw new Error(`colorOf: unknown theme ${String(theme)}`);
  return token.value[theme];
}

/** Name and value pairs as custom property declarations: `canvas` is `--canvas`. */
const declarations = (pairs) => pairs.map(([name, value]) => `--${name}:${value}`).join(";");

/** Every colour token's value in `theme`, in the file's order. */
const colours = (theme) => declarations(PULSE_TOKENS.color.tokens.map((token) => [token.name, token.value[theme]]));

/** Everything that is not a colour: the font stacks as `--font-<family>`, then spacing, radius and layout by name. */
const OTHER_TOKENS = [
  ...Object.entries(PULSE_TOKENS.type.families).map(([family, stack]) => [`font-${family}`, stack]),
  ...[PULSE_TOKENS.spacing, PULSE_TOKENS.radius, PULSE_TOKENS.layout].flatMap((group) =>
    group.tokens.map((token) => [token.name, token.value]),
  ),
];

const TOKEN_CSS = [
  `:root{color-scheme:light;${colours("light")};${declarations(OTHER_TOKENS)}}`,
  `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${colours("dark")}}}`,
  `:root[data-theme="dark"]{color-scheme:dark;${colours("dark")}}`,
].join("\n");

/** The tokens as custom properties: light on `:root`, dark for the system's preference or a forced choice. */
export function tokenCss() {
  return TOKEN_CSS;
}
