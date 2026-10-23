/**
 * The console's kit (issue #737): the Pulse design's components as pure functions, each returning a fragment built with
 * `html`, so a page says `ui.badge("failed", "Failed")` and gets the design's markup and class names, never its own copy
 * of them. Imported as `import * as ui from "./kit.mjs"`. The markup is the component cards' (Shell, Status, Actions,
 * CardsAndBanners, DataTable, FactsAndLevels, FieldsDiffCommand), pinned helper by helper in
 * `admin/test/console-kit.test.mjs` against each card's own sample.
 *
 * THE RULES EVERY HELPER KEEPS.
 *   - Every value is escaped: it goes through `html`, which scrubs control bytes and escapes markup, and only a
 *     fragment `html` built passes through as markup. A helper never concatenates a string into markup.
 *   - The closed sets THROW on anything else: a status (`STATUS`, keyed by `words.mjs` `STATUS_KINDS`), an icon
 *     (`ICON_NAMES`, read out of the sprite), a button kind, a size, a column count, a tag. Those values come from code,
 *     never from a record, so an unknown one is a programming error and a page that names one fails its test instead
 *     of shipping a grey badge. Text (words, titles, names, run data) is free and escaped.
 *   - A status is an icon and a word, never colour alone: the tone class colours what the icon and the word say. No
 *     helper emits a Unicode symbol or an emoji; every mark is a sprite icon (`pulse-icons.mjs`).
 *   - No `style=`, no inline script, no `on*=` handler (the console's CSP forbids them). A level is drawn the way the
 *     cards draw it: SVG geometry attributes (`width="62.5%"`, `stroke-dasharray`), every number through `svgNum`, the
 *     one clamping formatter, so a NaN or a runaway value can never reach an attribute.
 *   - A link goes only where a console link may: a console path (`pageHref` builds one, with its query) or an in-page
 *     `#id`, the two forms `console-pages-harness.mjs` `assertOwnReferences` accepts; anything else, `javascript:`, a
 *     bare `?query` and an `https:` URL included, throws. A link OUT of the console (a run's issue, a reasons docs page)
 *     is `outLink`'s alone, which stamps the `rel` and `target` that rule asks of one. The kit test holds every link
 *     form the kit writes to that rule, so the two cannot drift apart.
 *   - An id the kit writes is never one the page frame or the browser script owns (`RESERVED_IDS`, the sprite's ids,
 *     the `i-`/`p-` families of icon and panel ids, and the spend topology's minted ordinals, `RESERVED_ID_FAMILIES`):
 *     a second `#main`, `#logout` or `#n3` would take the script's or the skip link's element.
 *   - A command in a copy box is an argument list, each argument quoted for a POSIX shell (and for zsh) unless it is
 *     plainly safe (`cmd`), so a value holding `;`, `$(...)` or a quote is copied as one argument, never as more shell.
 *   - A card is an `<article class="card">` or a `<div class="card">`, never the `section[data-panel]` the live script
 *     swaps: a panel element carries only its `id` and `data-panel`, and the card is drawn inside it.
 */
import { html, isSafeHtml } from "./html.mjs";
import { ICON_NAMES, SPRITE } from "./pulse-icons.mjs";
import { STATUS_KINDS, outcomeWord } from "../words.mjs";

const ICONS = new Set(ICON_NAMES);

/**
 * The ids the page frame draws and the browser script finds by name, which no kit helper may write: the shell's
 * (`shell.mjs`: `#main`, `#logout`, `#live-status`, the Parked count `#p-nav-parked`), the sign-in pages' (`#login-form`,
 * `#token`, `#notice`), and the spend screen's chart hooks the script reads (`#tip`, `#wrap`, `#graph`, `#root`,
 * `#insights-tips`, `#graph-nodes`). Hand-listed because the kit cannot import the shell (the shell imports the kit),
 * so the kit test pins it both ways: every id the frame draws outside a page's content and every id the script names
 * in a `getElementById("...")` is refused (listed here, the sprite's, or one of the families below), and each one
 * listed here is still one of those.
 */
export const RESERVED_IDS = Object.freeze(["main", "logout", "live-status", "p-nav-parked", "login-form", "token", "notice", "tip", "wrap", "graph", "root", "insights-tips", "graph-nodes"]);

/**
 * The ordinal id families the spend topology mints (`graph-html.mjs`: `n<k>` for a chip, `w<k>` for a wire, `sg<k>`
 * for a skill-group box, `g<k>` for a folder group) and the browser script finds by id (a chip and its neighbours and
 * wires, by the minted ordinals `#graph-nodes` lists, and the chip a breakdown row's `data-node` names). A kit `#n3` on
 * the spend screen would be the element the script highlights or clicks instead of the chip. Hand-listed because the
 * kit loads no renderer; the kit test holds it to every `` id: `<family>${...}` `` mint in graph-html.mjs, both ways.
 */
export const RESERVED_ID_FAMILIES = Object.freeze(["n", "w", "sg", "g"]);

/**
 * The id families no kit helper may write: `i-` is the sprite's icons (`#i-run`), `p-` a page's panels
 * (`<section id="p-runs" data-panel>`, which `pages.mjs` draws and the live stream swaps by id), and a topology family
 * followed by its ordinal and nothing else (`n12`, never `nav` or `run1`).
 */
const RESERVED_ID_RE = new RegExp(`^(?:i|p)-|^(?:${RESERVED_ID_FAMILIES.join("|")})\\d+$`);

/** The sprite's own ids (`#hatch`, `#arrow` and every icon), read out of it, so a symbol added there is reserved here. */
const SPRITE_IDS = new Set(Array.from(String(SPRITE).matchAll(/\sid="([^"]+)"/g), (m) => m[1]));
const RESERVED = new Set([...RESERVED_IDS, ...SPRITE_IDS]);

/**
 * Each status kind's tone (the stylesheet's `.tone-*` class) and its icon, as the Status card draws them: completed is
 * `ok` with the check, awaiting input is `parked` with the question, cancelled is the idle tone with the stop square,
 * idle (held, queued, waiting) the clock. Keyed by `STATUS_KINDS` in its order; the test holds the two together.
 */
export const STATUS = Object.freeze({
  running: Object.freeze({ tone: "running", icon: "running" }),
  parked: Object.freeze({ tone: "parked", icon: "parked" }),
  failed: Object.freeze({ tone: "failed", icon: "failed" }),
  refused: Object.freeze({ tone: "refused", icon: "refused" }),
  attention: Object.freeze({ tone: "attention", icon: "attention" }),
  ok: Object.freeze({ tone: "ok", icon: "done" }),
  idle: Object.freeze({ tone: "idle", icon: "clock" }),
  cancelled: Object.freeze({ tone: "idle", icon: "cancel" }),
});

/** The tones, derived from `STATUS`: the stylesheet's seven `.tone-*` classes. */
export const TONES = Object.freeze([...new Set(Object.values(STATUS).map((s) => s.tone))]);

/** The button kinds (`.btn--<kind>`): the acts, then the sizes and the round icon button, which combine with an act. */
export const BTN_KINDS = Object.freeze(["primary", "answer", "paid", "danger", "confirm", "confirm-paid", "confirm-danger", "ghost", "sm", "lg", "round"]);

const ICON_CLASS = new Map([[undefined, "ic"], [null, "ic"], ["sm", "ic ic--sm"], ["lg", "ic ic--lg"]]);
const FACT_CLASS = new Map([[1, "facts facts--1"], [2, "facts"], [3, "facts facts--3"]]);
const TRI_CLASS = new Map([["up", "tri"], ["down", "tri tri--down"]]);
const ROW_CLASS = new Map([["attention", "row--attention"], ["failed", "row--failed"]]);
const INPUT_TYPES = new Set(["text", "password", "number", "search", "url", "email"]);
const BUTTON_TYPES = new Set(["button", "submit"]);
/** A table cell's flags, each the bundle's class, in the order a cell's `class` lists them. */
const CELL_FLAGS = Object.freeze({ id: "id", when: "when", tgt: "tgt", num: "num", act: "act", wide: "wide", hidePhone: "hide-phone" });
const CELL_KEYS = new Set([...Object.keys(CELL_FLAGS), "html"]);
const HEAD_KEYS = new Set(["label", "num", "hidePhone", "l"]);
const CONTROL_KEYS = new Set(["required", "disabled", "invalid", "describedBy"]);
/**
 * A console link: a path (one `/`, never `//host`, then printable ASCII with no backslash, which a browser reads as a
 * `/`, and no space; `pageHref` percent-encodes whatever a query holds) or an in-page `#id`, anchored at both ends.
 */
const HREF_RE = /^(?:\/(?!\/)[\x21-\x5b\x5d-\x7e]*|#[a-z][a-z0-9-]*)$/;
const ID_RE = /^[a-z][a-z0-9-]*$/;
/** A copy-box argument written as it is: nothing a POSIX shell reads as more than a word's letters (see `shellWord`). */
const SHELL_SAFE_RE = /^[A-Za-z0-9._/:@%+=-]+$/;
const GROUPED = new Intl.NumberFormat("en-US");

/** A status kind's entry, or a throw: the closed set of `STATUS_KINDS`. */
function statusOf(status, who) {
  if (typeof status !== "string" || !Object.hasOwn(STATUS, status)) {
    throw new RangeError(`kit.${who}: unknown status ${JSON.stringify(status)} (one of ${STATUS_KINDS.join(", ")})`);
  }
  return STATUS[status];
}

/** The tone class of a status kind, or null for none (`null`/`undefined` mean a neutral element). */
function toneOrNull(status, who) {
  return status === null || status === undefined ? null : `tone-${statusOf(status, who).tone}`;
}

/** A value of a closed map, or a throw. */
function pick(map, value, what, who) {
  if (!map.has(value)) throw new RangeError(`kit.${who}: unknown ${what} ${JSON.stringify(value)} (one of ${[...map.keys()].filter((k) => k !== undefined && k !== null).join(", ")})`);
  return map.get(value);
}

/** An id another element carries, as an `aria-describedby` names it: lower-case letters, digits and hyphens. */
function refOf(id, who) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new RangeError(`kit.${who}: an id is [a-z][a-z0-9-]*, not ${JSON.stringify(id)}`);
  return id;
}

/**
 * An element id the kit writes, or a throw: lower-case letters, digits and hyphens, so `#id` references stay simple,
 * and never a reserved one (`RESERVED_IDS`, the sprite's, an `i-` or `p-` id), so a page cannot hold two elements
 * the script or a reference would look for by the same name.
 */
function idOf(id, who) {
  refOf(id, who);
  if (RESERVED.has(id) || RESERVED_ID_RE.test(id)) throw new RangeError(`kit.${who}: ${JSON.stringify(id)} is an id the page frame, the sprite or a panel owns`);
  return id;
}

/** A console link the kit writes, or a throw (see the header). */
function hrefOf(href, who) {
  if (typeof href !== "string" || !HREF_RE.test(href)) throw new RangeError(`kit.${who}: a link is a console path or an in-page #id (a link out of the console is outLink's), not ${JSON.stringify(href)}`);
  return href;
}

/**
 * A link out of the console, or a throw. It must parse (`new URL`), be `http:` or `https:`, carry no user name and no
 * password (`https://github.com@evil.example/` opens evil.example), and be EXACTLY what the parser writes back for it,
 * byte for byte. That last rule is the one that makes the host a reader sees the host the browser opens: the parser
 * rewrites every spelling it reads as another, a numeric or shorthand IPv4 host (`https://127.1/`,
 * `https://2130706433/` and `https://0x7f.1/` are all 127.0.0.1), an IPv6 literal not in its shortest form, a default
 * or zero-padded port, an upper-case scheme or host, a backslash (read as `/`), a dot segment, a tab or a newline
 * (dropped), a space or a quote (escaped), a non-ASCII host (punycode), and it refuses a port past 65535. A pattern of
 * allowed characters, this rule's first version, passed every one of those numeric hosts.
 *
 * No pattern for the host on top: a canonical host can still be an odd name (`x..y`, `a'b`), but it is the name the
 * browser opens, so it misleads no one, and refusing it would throw on a page whose forge instance URL an operator
 * spelled that way. `forgeLinkOf` builds on `new URL(...).origin` (GitHub on its literal host) and `docsHref` on its
 * fixed root, each followed by a path of plain characters, so every link they return is its own canonical form and
 * passes (the kit test holds the two to each other).
 */
function outHrefOf(href, who) {
  let u = null;
  try {
    u = typeof href === "string" ? new URL(href) : null;
  } catch {
    u = null;
  }
  const plain = u !== null && (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.href === href;
  if (!plain) throw new RangeError(`kit.${who}: a link out of the console is an http(s) URL with no user name, written as the browser writes it back, not ${JSON.stringify(href)}`);
  return href;
}

/**
 * One argument of a command as a shell reads it back: as written when it is plain, else in single quotes, inside
 * which a shell reads no character specially, with each `'` written `'\''` (close, an escaped quote, reopen). An empty
 * argument is `''`, so it is still one. Plain is `SHELL_SAFE_RE` with two exceptions, both quoted:
 *   - an argument that STARTS with `=`: zsh (the shell macOS opens by default) replaces `=name` with the path of the
 *     command `name` (its EQUALS option, on by default), and fails the whole line when there is none;
 *   - a FIRST word holding `=`: in a command's first position `NAME=value` is an assignment, so the shell would set a
 *     variable and run the next argument as the command.
 * Everywhere else `=` is a letter to every POSIX shell and to zsh (`--model=a/b` is one word as written).
 */
function shellWord(arg, first, who) {
  if (typeof arg !== "string") throw new TypeError(`kit.${who}: a command's argument is a string, not ${JSON.stringify(arg)}`);
  const plain = SHELL_SAFE_RE.test(arg) && !arg.startsWith("=") && !(first && arg.includes("="));
  return plain ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A whole count with the thousands separator ("85,577"), or a throw: a count that is not known is not drawn. */
function grouped(n, who) {
  if (!Number.isFinite(n)) throw new TypeError(`kit.${who}: a count is a finite number, not ${JSON.stringify(n)}`);
  return GROUPED.format(n);
}

/** Whether an optional part was given: null, undefined, false, "" and an empty list draw nothing. */
const given = (v) => v !== null && v !== undefined && v !== false && v !== "" && !(Array.isArray(v) && v.length === 0);

/** The `class` value of a list of names, the absent ones left out. */
const classes = (...names) => names.filter(Boolean).join(" ");

/** `aria-describedby`, `aria-invalid` and the boolean attributes a form control shares; any other option throws. */
function controlAttrs(rest, who) {
  for (const k of Object.keys(rest)) if (!CONTROL_KEYS.has(k)) throw new RangeError(`kit.${who}: unknown option ${JSON.stringify(k)}`);
  const { required = false, disabled = false, invalid = false, describedBy = null } = rest;
  // A reference may name any element, a reserved one too (a sign-in field described by `#notice`), so it is checked
  // for its charset alone.
  const ids = describedBy === null ? [] : (Array.isArray(describedBy) ? describedBy : [describedBy]).map((d) => refOf(d, who));
  return html`${required ? html` required` : null}${disabled ? html` disabled` : null}${invalid ? html` aria-invalid="true"` : null}${ids.length > 0 ? html` aria-describedby="${ids.join(" ")}"` : null}`;
}

/**
 * THE ONE FORMATTER FOR AN SVG NUMBER: a finite number clamped to `[min, max]` and written with `digits` fixed decimals;
 * anything else (NaN, an infinity, a string, null) is `min`. Negative zero is written as zero.
 */
export function svgNum(value, min, max, digits = 1) {
  const v = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  const s = v.toFixed(digits);
  return /^-0(?:\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** `value` as a percentage of `max` (0 when either is not a finite number or `max` is not above 0), unclamped. */
function percentOf(value, max) {
  return Number.isFinite(value) && Number.isFinite(max) && max > 0 ? (value / max) * 100 : 0;
}

/** A level's status when none is given: the cap (100%) is failed, the soft hold attention, below it ok (the meter rule). */
function levelStatus(pct, hold) {
  if (pct >= 100) return "failed";
  return Number.isFinite(hold) && pct >= hold ? "attention" : "ok";
}

// ---- marks -------------------------------------------------------------------------------------------------------------

/** A sprite icon: `<svg class="ic"><use href="#i-NAME"></use></svg>`, hidden from assistive technology (`size`: sm, lg). */
export function icon(name, { size = null } = {}) {
  if (typeof name !== "string" || !ICONS.has(name)) throw new RangeError(`kit.icon: unknown icon ${JSON.stringify(name)}`);
  return html`<svg class="${pick(ICON_CLASS, size, "icon size", "icon")}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** A status badge: the status's icon (or `icon`) and the word, in its tone; `solid` fills it. */
export function badge(status, word, { solid = false, icon: glyph = null } = {}) {
  const s = statusOf(status, "badge");
  return html`<span class="${classes("badge", solid && "badge--solid", `tone-${s.tone}`)}">${icon(glyph ?? s.icon)}${word}</span>`;
}

/**
 * A run's outcome as a badge, in `words.mjs`'s word and status (`outcomeWord`): "Completed", "Refused", "Awaiting
 * input", "Cancelled", "Failed". An outcome this release does not know is shown as itself, as a failure, as the panel
 * always showed one; a missing one reads "unknown".
 */
export function outcomeBadge(outcome, reason = null) {
  const w = outcomeWord(outcome, reason);
  const word = w.known ? w.word.charAt(0).toUpperCase() + w.word.slice(1) : typeof outcome === "string" && outcome !== "" ? outcome : "unknown";
  return badge(w.status, word);
}

/** A chip: a short fact on a pill, neutral or in a status's tone, with an optional icon. */
export function chip(text, { status = null, icon: glyph = null } = {}) {
  return html`<span class="${classes("chip", toneOrNull(status, "chip"))}">${glyph === null ? null : icon(glyph)}${text}</span>`;
}

/** A project tag: the project's name on a neutral pill. */
export function ptag(project) {
  return html`<span class="ptag">${project}</span>`;
}

/** A venue tag: the venue's name, outlined. */
export function vtag(venue) {
  return html`<span class="vtag">${venue}</span>`;
}

/**
 * A count bubble ("1,204"), neutral or in a status's tone. `label` is what a screen reader says for it ("1 waiting"):
 * visually hidden text (`.sr`) beside the number, which is then `aria-hidden` so it is not read twice. Not an
 * `aria-label`: a plain `span` is ARIA's `generic` role, which may not be named, so a screen reader can skip one.
 */
export function count(n, status = null, { label = null } = {}) {
  const cls = classes("count", toneOrNull(status, "count"));
  const shown = grouped(n, "count");
  return label === null ? html`<span class="${cls}">${shown}</span>` : html`<span class="${cls}"><span aria-hidden="true">${shown}</span><span class="sr">${label}</span></span>`;
}

/**
 * A status dot, drawn beside the word it marks, never alone (a colour is never the only cue). `label` gives it an
 * accessible name for a reader that does not see the word beside it, never a replacement for that word.
 */
export function dot(status, { label = null } = {}) {
  return html`<span class="dot tone-${statusOf(status, "dot").tone}"${label === null ? null : html` role="img" aria-label="${label}"`}></span>`;
}

/** An icon tile: the status's icon (or `icon`) on its tint; `sm` is the small tile. */
export function tile(status, { icon: glyph = null, sm = false } = {}) {
  const s = statusOf(status, "tile");
  return html`<span class="${classes("tile", sm && "tile--sm", `tone-${s.tone}`)}">${icon(glyph ?? s.icon)}</span>`;
}

// ---- containers ----------------------------------------------------------------------------------------------------------

/**
 * A card: an optional head (an `h2` title, a sub line, and `end` at its right), then `body`. `flush` drops the padding
 * (a table's card), `tint` and `ring` name the status whose tint fills it or whose ring outlines it (one status for
 * both). `tag` is `div` (the default) or `article`; never the panel's `section`.
 */
export function card({ title = null, sub = null, end = null, flush = false, tint = null, ring = null, body = null, tag = "div" } = {}) {
  if (tag !== "div" && tag !== "article") throw new RangeError(`kit.card: a card is a div or an article, not ${JSON.stringify(tag)}`);
  if (tint !== null && ring !== null && tint !== ring) throw new RangeError("kit.card: tint and ring name the same status");
  const cls = classes("card", flush && "card--flush", tint !== null && "card--tint", ring !== null && "card--ring", toneOrNull(tint ?? ring, "card"));
  const head = given(title) || given(sub) || given(end)
    ? html`<div class="card__head">${given(title) ? html`<h2>${title}</h2>` : null}${given(sub) ? html`<span class="card__sub">${sub}</span>` : null}${given(end) ? html`<span class="end">${end}</span>` : null}</div>`
    : null;
  return tag === "article" ? html`<article class="${cls}">${head}${body}</article>` : html`<div class="${cls}">${head}${body}</div>`;
}

/** A card's one big number and what it counts: `<p class="kpi"><b>5</b><span>jobs waiting to start</span></p>`. */
export function kpi(value, label = null) {
  return html`<p class="kpi"><b>${value}</b>${given(label) ? html`<span>${label}</span>` : null}</p>`;
}

/** A big number with its label, in a status's tone, a link where `href` is given; `trend` up or down draws the triangle. */
export function big({ n, label, status = null, href = null, trend = null }) {
  const tri = trend === null ? null : html`<span class="${pick(TRI_CLASS, trend, "trend", "big")}"></span>`;
  const cls = classes("big", toneOrNull(status, "big"));
  const inner = html`<span class="big__n">${tri}${n}</span><span class="big__l">${label}</span>`;
  return href === null ? html`<span class="${cls}">${inner}</span>` : html`<a class="${cls}" href="${hrefOf(href, "big")}">${inner}</a>`;
}

/** A fact grid: `pairs` of `[term, value]` in one, two (the default) or three columns; an absent value reads "-". */
export function facts(pairs, { cols = 2 } = {}) {
  const cls = pick(FACT_CLASS, cols, "column count", "facts");
  return html`<dl class="${cls}">${pairs.map(([term, value]) => html`<div class="fact"><dt>${term}</dt><dd>${given(value) || value === 0 ? value : "-"}</dd></div>`)}</dl>`;
}

// ---- tables ----------------------------------------------------------------------------------------------------------------

/** A column head: a string, or `{ label, num, hidePhone, l }` (`l` replaces the phone label; "" for none). */
function headOf(h) {
  if (typeof h === "string" || isSafeHtml(h)) return { label: h, num: false, hidePhone: false, l: typeof h === "string" ? h : "" };
  for (const k of Object.keys(h)) if (!HEAD_KEYS.has(k)) throw new RangeError(`kit.tbl: unknown column option ${JSON.stringify(k)}`);
  return { label: h.label, num: h.num === true, hidePhone: h.hidePhone === true, l: typeof h.l === "string" ? h.l : typeof h.label === "string" ? h.label : "" };
}

/** One `<td>`: the column's flags and the cell's own, the phone label in a stacked table, an id in the no-wrap code face. */
function cellOf(c, col, stack) {
  const own = c !== null && typeof c === "object" && !isSafeHtml(c) && !Array.isArray(c) ? c : { html: c };
  for (const k of Object.keys(own)) if (!CELL_KEYS.has(k)) throw new RangeError(`kit.tbl: unknown cell option ${JSON.stringify(k)}`);
  const flags = { ...own, num: own.num === true || col.num, hidePhone: own.hidePhone === true || col.hidePhone };
  const cls = classes(...Object.entries(CELL_FLAGS).map(([k, name]) => flags[k] === true && name));
  const content = own.id === true ? html`<span class="code">${own.html}</span>` : own.html;
  return html`<td${cls ? html` class="${cls}"` : null}${stack ? html` data-l="${col.l}"` : null}>${content}</td>`;
}

/**
 * A data table in its scrolling box. It is named by a `caption` (visually hidden; a card's title is what the eye
 * reads) or an `aria-label`, and one of them is required; every head is `<th scope="col">`. `rows` are lists of cells,
 * or `{ cells, mark }` where `mark` (attention, failed) tints the row. A cell is a value or `{ html, id, num, wide,
 * hidePhone, when, tgt, act }`; an `id` cell's text never breaks. `stack` turns the rows into stacked blocks on a
 * phone, each cell labelled from its column's head (`data-l`). With no rows, `empty` is drawn instead: a fragment as it
 * is, text as a note.
 */
export function tbl({ label = null, caption = null, heads, rows, stack = false, empty = null }) {
  if (!given(label) && !given(caption)) throw new TypeError("kit.tbl: a table is named by a caption or an aria-label");
  if (rows.length === 0 && given(empty)) return isSafeHtml(empty) ? empty : html`<p class="note">${empty}</p>`;
  const cols = heads.map(headOf);
  const head = html`<thead><tr>${cols.map((c) => html`<th scope="col"${c.num ? html` class="num"` : null}>${c.label}</th>`)}</tr></thead>`;
  const body = rows.map((r) => {
    const row = Array.isArray(r) ? { cells: r, mark: null } : r;
    const mark = row.mark === null || row.mark === undefined ? null : pick(ROW_CLASS, row.mark, "row mark", "tbl");
    if (row.cells.length !== cols.length) throw new RangeError(`kit.tbl: a row has ${row.cells.length} cells for ${cols.length} columns`);
    return html`<tr${mark ? html` class="${mark}"` : null}>${row.cells.map((c, i) => cellOf(c, cols[i], stack))}</tr>`;
  });
  return html`<div class="tbl-wrap"><table class="${classes("tbl", stack && "tbl--stack")}"${given(label) ? html` aria-label="${label}"` : null}>${given(caption) ? html`<caption class="sr">${caption}</caption>` : null}${head}<tbody>${body}</tbody></table></div>`;
}

/** A table's foot line: what the table shows, then the pager at its right. */
export function tblFoot(body, pagerHtml = null) {
  return html`<div class="tbl-foot">${body}${pagerHtml}</div>`;
}

/**
 * Newer and Older, as the DataTable card draws them (Newer quiet, Older the plain button): a link each where there is
 * a page, a disabled one (no `href`, `aria-disabled`) where there is not. The "" only makes it a link: `btn` draws a
 * disabled link without its target.
 */
export function pager({ newer = null, older = null, newerLabel = "Newer", olderLabel = "Older" } = {}) {
  return html`<span class="pager">${btn({ kind: ["sm", "ghost"], label: newerLabel, href: newer ?? "", disabled: newer === null })}${btn({ kind: "sm", label: olderLabel, href: older ?? "", disabled: older === null })}</span>`;
}

// ---- levels ----------------------------------------------------------------------------------------------------------------

/**
 * A meter against a cap: a bar of `value` out of `max`, with the soft-hold tick at `hold` percent where one is given.
 * Its status, unless given, is the meter rule: red at the cap, yellow from the hold, else ok. `role="meter"`, its value
 * in percent, named by `label` ("Jobs today: 25 of 40").
 */
export function meter({ value, max, label, status = null, hold = null, height = 10 }) {
  const pct = percentOf(value, max);
  const tone = `tone-${statusOf(status ?? levelStatus(pct, hold), "meter").tone}`;
  const h = Number(svgNum(height, 4, 24, 0));
  const rx = svgNum(h / 2, 2, 12, 1);
  const tick = Number.isFinite(hold) ? html`<line class="pbar__hold" x1="${svgNum(hold, 0, 100, 1)}%" x2="${svgNum(hold, 0, 100, 1)}%" y1="-3" y2="${svgNum(h + 3, 7, 27, 0)}"/>` : null;
  return html`<svg class="pbar ${tone}" height="${h}" role="meter" aria-valuenow="${svgNum(pct, 0, 100, 0)}" aria-valuemin="0" aria-valuemax="100" aria-label="${label}"><rect class="pbar__bed" width="100%" height="${h}" rx="${rx}"/><rect class="pbar__fill" width="${svgNum(pct, 0, 100, 1)}%" height="${h}" rx="${rx}"/>${tick}</svg>`;
}

/**
 * A ring: `value` of `max` as an arc from the top, clockwise, over its track, with the hold tick at `hold` percent
 * where one is given. The status follows the meter rule unless given. `role="meter"`, named by `label`.
 */
export function ring({ value, max, label, status = null, hold = null, size = 96, stroke = 9 }) {
  const pct = percentOf(value, max);
  const tone = `tone-${statusOf(status ?? levelStatus(pct, hold), "ring").tone}`;
  const s = Number(svgNum(size, 24, 480, 0));
  const sw = Number(svgNum(stroke, 1, s / 4, 0));
  const c = svgNum(s / 2, 0, s, 1);
  const r = s / 2 - sw / 2;
  const geo = html`cx="${c}" cy="${c}" r="${svgNum(r, 0, s, 1)}" stroke-width="${sw}"`;
  let tick = null;
  if (Number.isFinite(hold)) {
    const a = (Math.min(100, Math.max(0, hold)) / 100) * 2 * Math.PI;
    const at = (rad) => [svgNum(s / 2 + rad * Math.sin(a), -sw, s + sw, 1), svgNum(s / 2 - rad * Math.cos(a), -sw, s + sw, 1)];
    const [x1, y1] = at(r - sw / 2 - 1);
    const [x2, y2] = at(r + sw / 2 + 1);
    tick = html`<line class="ring__hold" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return html`<svg class="ring ${tone}" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" role="meter" aria-valuenow="${svgNum(pct, 0, 100, 0)}" aria-valuemin="0" aria-valuemax="100" aria-label="${label}"><circle class="ring__track" ${geo}/><circle class="ring__arc" ${geo} pathLength="100" stroke-dasharray="${svgNum(pct, 0, 100, 1)} 100" transform="rotate(-90 ${c} ${c})"/>${tick}</svg>`;
}

// ---- notices -----------------------------------------------------------------------------------------------------------------

/**
 * A banner: what happened (`title`), what it means or what to do (`body`), and its `actions`, in a status's tint with
 * the status's icon (or `icon`) on a tile. `sm` is the compact notice. `role="status"`.
 */
export function banner({ status, title, body = null, actions = null, icon: glyph = null, sm = false }) {
  const s = statusOf(status, "banner");
  return html`<div class="${classes("banner", sm && "banner--sm", `tone-${s.tone}`)}" role="status"><span class="tile">${icon(glyph ?? s.icon)}</span><div><p class="banner__t">${title}</p>${given(body) ? html`<p class="banner__s">${body}</p>` : null}</div>${given(actions) ? html`<div class="banner__act">${actions}</div>` : null}</div>`;
}

/** An empty state: a status tile, the one-line verdict in bold, and the sentence under it. */
export function empty({ status, icon: glyph = null, title, body = null }) {
  return html`<div class="empty">${tile(status, { icon: glyph })}<b>${title}</b>${given(body) ? html`<span>${body}</span>` : null}</div>`;
}

/** A section with nothing to show, collapsed to one line: an icon, its name in bold, and why. */
export function collapsed({ icon: glyph, title, body = null }) {
  return html`<p class="collapsed">${icon(glyph, { size: "sm" })}<b>${title}</b>${given(body) ? html` ${body}` : null}</p>`;
}

// ---- forms --------------------------------------------------------------------------------------------------------------------

/**
 * A form field: its label for `id`, the control (built with `input`, `select` or `textarea` and the same `id`), a hint
 * and an error under it. The hint is `#<id>-hint` and the error `#<id>-err`, which the control names in its
 * `describedBy`; an error marks the field (`field--err`) and opens with the failed icon.
 */
export function field({ label, id, control, hint = null, error = null }) {
  // The label's `for` names the control's id, which the control's own helper holds to the reserved ids; the hint's and
  // the error's ids are written here, so they are held here (an `f` field is fine, an `i` field's hint is `#i-hint`).
  const fid = refOf(id, "field");
  return html`<div class="${classes("field", given(error) && "field--err")}"><label for="${fid}">${label}</label>${control}${given(hint) ? html`<p class="field__hint" id="${idOf(`${fid}-hint`, "field")}">${hint}</p>` : null}${given(error) ? html`<p class="field__err" id="${idOf(`${fid}-err`, "field")}">${icon("failed", { size: "sm" })}${error}</p>` : null}</div>`;
}

/** A text input (`type` text, password, number, search, url, email); `code` sets it in the code face. */
export function input({ id, name = null, value = null, type = "text", code = false, placeholder = null, autocomplete = null, spellcheck = null, ...rest }) {
  if (!INPUT_TYPES.has(type)) throw new RangeError(`kit.input: unknown type ${JSON.stringify(type)}`);
  return html`<input id="${idOf(id, "input")}" class="${classes("input", code && "input--code")}"${type === "text" ? null : html` type="${type}"`}${name === null ? null : html` name="${name}"`}${value === null ? null : html` value="${value}"`}${placeholder === null ? null : html` placeholder="${placeholder}"`}${autocomplete === null ? null : html` autocomplete="${autocomplete}"`}${spellcheck === null ? null : html` spellcheck="${spellcheck ? "true" : "false"}"`}${controlAttrs(rest, "input")}>`;
}

/** A closed list as a select: `options` are strings, or `{ value, label }`; the one equal to `value` is selected. */
export function select({ id, name = null, options, value = null, ...rest }) {
  const opts = options.map((o) => {
    const v = typeof o === "string" ? o : o.value;
    const on = value !== null && v === value ? html` selected` : null;
    return typeof o === "string" ? html`<option${on}>${o}</option>` : html`<option value="${o.value}"${on}>${o.label}</option>`;
  });
  return html`<select id="${idOf(id, "select")}" class="select"${name === null ? null : html` name="${name}"`}${controlAttrs(rest, "select")}>${opts}</select>`;
}

/**
 * A textarea. Its text keeps its line breaks (each value is scrubbed line by line, so a newline is the only control
 * that survives), and a text that opens with one keeps it: the parser drops the first newline after the tag.
 */
export function textarea({ id, name = null, value = "", placeholder = null, rows = null, ...rest }) {
  const lines = String(value ?? "").split(/\r?\n/);
  const text = lines.map((line, i) => (i === 0 ? html`${line}` : html`\n${line}`));
  return html`<textarea id="${idOf(id, "textarea")}" class="textarea"${name === null ? null : html` name="${name}"`}${rows === null ? null : html` rows="${svgNum(rows, 1, 40, 0)}"`}${placeholder === null ? null : html` placeholder="${placeholder}"`}${controlAttrs(rest, "textarea")}>${lines[0] === "" && lines.length > 1 ? html`\n` : null}${text}</textarea>`;
}

/**
 * A command in a copy box, with the line under it that says where it must run (`host`). `argv` is the command as an
 * argument list (`["pi-dispatch", "chat", id]`), written as a POSIX shell and zsh read it back (`shellWord`): a plain
 * argument as it is, any other in single quotes, so a run id or a target holding `;`, `|`, `$(...)`, a backtick, a
 * quote, a space, a leading `=` or a `~` is pasted as the one argument it is (the kit test runs each line through a
 * real sh, bash and zsh). A whole command line as one string is refused: the kit cannot tell its words from its data.
 * What `html` scrubs in all text, a control byte or a character a reader would not see (a zero-width space, a bidi
 * control), is a space here too, inside its quotes: the copied argument is the one the page shows.
 * The Copy button is drawn `hidden` with `data-copy`: the browser script reveals it only where it can copy
 * (`navigator.clipboard` in a secure context), and copies the box's `<code>` text, so a page without the script never
 * shows a button that does nothing.
 */
export function cmd(argv, { host = null } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("kit.cmd: a command is a non-empty argument list");
  const line = argv.map((a, i) => shellWord(a, i === 0, "cmd")).join(" ");
  const box = html`<div class="cmd"><code>${line}</code><button class="btn btn--sm" type="button" data-copy hidden>Copy</button></div>`;
  return given(host) ? html`${box}<p class="card__sub">${host}</p>` : box;
}

// ---- navigation and actions -------------------------------------------------------------------------------------------------

/** Tabs between views or sections: links in a named `nav`, the current one `aria-current="page"`, each with an optional icon and count. */
export function tabs(items, { label }) {
  if (!given(label)) throw new TypeError("kit.tabs: a tab bar is named");
  return html`<nav class="tabs" aria-label="${label}">${items.map((t) => html`<a href="${hrefOf(t.href, "tabs")}"${t.current ? html` aria-current="page"` : null}>${given(t.icon) ? icon(t.icon, { size: "sm" }) : null}${t.label}${t.count === null || t.count === undefined ? null : count(t.count)}</a>`)}</nav>`;
}

/**
 * A segmented control, a named group: buttons with `aria-pressed`, or links (`href`) with `aria-current="page"`; `on`
 * marks the chosen one, and a `count` follows its label in bold.
 */
export function seg(items, { label }) {
  if (!given(label)) throw new TypeError("kit.seg: a segmented control is named");
  return html`<div class="seg" role="group" aria-label="${label}">${items.map((s) => {
    const inner = html`${s.label}${s.count === null || s.count === undefined ? null : html` <b>${grouped(s.count, "seg")}</b>`}`;
    return s.href === null || s.href === undefined ? html`<button type="button" aria-pressed="${s.on ? "true" : "false"}">${inner}</button>` : html`<a href="${hrefOf(s.href, "seg")}"${s.on ? html` aria-current="page"` : null}>${inner}</a>`;
  })}</div>`;
}

/**
 * A button, or a link drawn as one (`href`). `kind` is one of `BTN_KINDS` or a list of them (`["sm", "ghost"]`):
 * primary is the one step forward, answer is for a parked run, paid and danger are outlined until their confirm
 * (confirm, confirm-paid, confirm-danger), ghost is quiet, sm and lg size it, round makes it an icon alone whose
 * `label` is its accessible name. A disabled link has no `href` and says `aria-disabled`.
 */
export function btn({ kind = null, label, href = null, icon: glyph = null, type = "button", disabled = false, id = null, name = null, value = null }) {
  const kinds = kind === null ? [] : Array.isArray(kind) ? kind : [kind];
  for (const k of kinds) if (!BTN_KINDS.includes(k)) throw new RangeError(`kit.btn: unknown kind ${JSON.stringify(k)} (one of ${BTN_KINDS.join(", ")})`);
  const cls = classes("btn", ...kinds.map((k) => `btn--${k}`));
  const round = kinds.includes("round");
  if (round && glyph === null) throw new TypeError("kit.btn: a round button is its icon");
  const content = round ? icon(glyph, { size: "sm" }) : html`${glyph === null ? null : icon(glyph, { size: "sm" })}${label}`;
  const named = html`${id === null ? null : html` id="${idOf(id, "btn")}"`}${round ? html` aria-label="${label}"` : null}`;
  if (href !== null) {
    return disabled ? html`<a class="${cls}"${named} aria-disabled="true">${content}</a>` : html`<a class="${cls}" href="${hrefOf(href, "btn")}"${named}>${content}</a>`;
  }
  if (!BUTTON_TYPES.has(type)) throw new RangeError(`kit.btn: unknown type ${JSON.stringify(type)}`);
  return html`<button class="${cls}" type="${type}"${named}${name === null ? null : html` name="${name}"`}${value === null ? null : html` value="${value}"`}${disabled ? html` disabled` : null}>${content}</button>`;
}

/**
 * A link out of the console (a run's issue on its forge, a reasons docs page): `href` an http(s) URL in its own
 * canonical form with no user name (`outHrefOf`; every link `forgeLinkOf` and `docsHref` build is one), drawn as the
 * design's link (`code` sets it in the code face), opening in a new tab that gets no handle on this window and no
 * Referer. The attributes are written in exactly the order `console-pages-harness.mjs`'s outbound-link rule reads
 * (`href`, then `rel="noreferrer noopener"`, then `target="_blank"`, last), the one shape of reference to another host
 * a page may carry.
 */
export function outLink({ href, label, code = false }) {
  return html`<a class="${classes("link", code && "code")}" href="${outHrefOf(href, "outLink")}" rel="noreferrer noopener" target="_blank">${label}</a>`;
}

/**
 * The path of a console page with its query (`{ key: value }`, a value list repeated, null and "" left out, or a
 * `URLSearchParams`), from a page table shaped like `pages.mjs` `PAGES`; null when the table has no such page.
 */
export function pageHref(pages, name, query = null) {
  if (pages === null || typeof pages !== "object" || typeof name !== "string" || !Object.hasOwn(pages, name)) return null;
  const path = pages[name]?.path;
  if (typeof path !== "string") return null;
  const q = new URLSearchParams();
  if (query instanceof URLSearchParams) {
    for (const [k, v] of query) q.append(k, v);
  } else if (query !== null && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) for (const one of Array.isArray(v) ? v : [v]) if (one !== null && one !== undefined && one !== "") q.append(k, String(one));
  }
  const s = q.toString();
  return s === "" ? path : `${path}?${s}`;
}
