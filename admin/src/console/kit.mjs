/**
 * The console's kit (issue #737): the Pulse design's components as pure functions, each returning a fragment built with
 * `html`, so a page says `ui.badge("failed", "Failed")` and gets the design's markup and class names, never its own copy
 * of them. Imported as `import * as ui from "./kit.mjs"`. The markup is the component cards' (Shell, Status, Actions,
 * CardsAndBanners, DataTable, FactsAndLevels, FieldsDiffCommand, since PR 3 TimelineAndWaitlists, and since PR 4
 * RunsScreen, RunsPhone and ParkedPhone), pinned helper by helper in `admin/test/console-kit.test.mjs` against each
 * card's own sample.
 *
 * WHERE A HELPER'S LOOK LIVES. Most classes the kit writes are bundle.css's. A few are the console's own, for parts the
 * bundle has no rule for (it draws them in a card's own style block): the summary strip and a table's day rows
 * (`runs-css.mjs` `RUNS_CSS`, served on the runs page), the question card and its answer form (`parked-css.mjs`
 * `QCARD_CSS`, served on the parked page, the one page that draws them). The kit test holds every class a helper
 * writes to one of those stylesheets.
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
import { ANSWER_TEXT_MAX_BYTES } from "@edgehero/pi-dispatch/console-answer";
import { DEFER_TIME_MAX_MS } from "@edgehero/pi-dispatch/defer-reasons";
import { html, isSafeHtml } from "./html.mjs";
import { ICON_NAMES, SPRITE } from "./pulse-icons.mjs";
import { STATUS_KINDS, outcomeWord } from "../words.mjs";

const ICONS = new Set(ICON_NAMES);

/**
 * The ids the page frame draws and the browser script finds by name, which no kit helper may write: the shell's
 * (`shell.mjs`: `#main`, `#logout`, `#live-status`, the Parked count `#p-nav-parked`, since PR 2 of issue #737 the
 * live notes `#live-note`, the write flow's one `#confirm-slot` and the `#held-note` template the script clones into a
 * panel it keeps still, and since PR 3 the headline panel `#p-headline` in a page's title bar), the sign-in pages'
 * (`#login-form`, `#token`, `#notice`, which `signin.mjs` draws by hand with the kit's class names, since a kit helper
 * may not write them), and the spend screen's chart hooks the script reads
 * (`#tip`, `#wrap`, `#graph`, `#root`, `#insights-tips`, `#graph-nodes`), and since PR 4 the runs search field `#q`
 * (`SEARCH_ID`), which the top bar's Search button opens and the script focuses. Hand-listed because the kit cannot
 * import the shell (the shell imports the kit), so the kit test pins it both ways: every id the frame draws outside a
 * page's panels and every id the script names in a `getElementById("...")` is refused (listed here, the sprite's, or
 * one of the families below), and each one listed here is still one of those.
 */
export const RESERVED_IDS = Object.freeze(["main", "logout", "live-status", "p-nav-parked", "p-headline", "live-note", "confirm-slot", "held-note", "login-form", "token", "notice", "tip", "wrap", "graph", "root", "insights-tips", "graph-nodes", "q"]);

/**
 * The runs search field's id (the RunsScreen card's search pill): the top bar's Search button links to `/runs#q`
 * (`shell.mjs` `SEARCH_HREF`) and the browser script focuses the field it names. It is reserved (`RESERVED_IDS`), so no
 * other helper can write it, and `searchPill` is the one helper that may: the runs page's filter bar and the run-id 404
 * each draw one such field, the one the button and the script mean.
 */
export const SEARCH_ID = "q";

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
const ROW_KEYS = new Set(["cells", "mark", "id", "group"]);
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
/** An action's name as the browser script posts it (`/api/act/<name>/preview`), held to the script's own check. */
const ACTION_RE = /^[a-z0-9-]{1,40}$/;
/** A hidden field's name: a key of the body the action reads (`jobId`, `queue`, `index`). */
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/**
 * How the browser script reads a hidden field (`script.mjs` `bodyOf`, its `data-type`): a whole number, a JSON value or
 * a list of words. A field with no type is text.
 */
const FIELD_TYPES = new Set(["int", "json", "list"]);
/** A row's end with a look of its own (`rowPill`): its text, in a status's ink or the faint ink. */
const END_KEYS = new Set(["text", "status", "faint"]);
/** A summary strip item's options (`sumStrip`). */
const SUM_KEYS = new Set(["n", "label", "status", "href", "floor", "hidePhone"]);

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

/**
 * A project tag: the project's name on a neutral pill. `title` is the name whole where a page's rules cut the tag to
 * its column (the timeline's row heads).
 */
export function ptag(project, { title = null } = {}) {
  return html`<span class="ptag"${given(title) ? html` title="${title}"` : null}>${project}</span>`;
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

/**
 * An icon tile: the status's icon (or `icon`) on its tint; `sm` is the small tile. `iconSm` draws the small icon in it,
 * as the overview's cards draw a waitlist's head (OverviewScreen, TimelineAndWaitlists); the ConfirmStates card's small
 * tile keeps the full-size icon, so the two are separate choices.
 */
export function tile(status, { icon: glyph = null, sm = false, iconSm = false } = {}) {
  const s = statusOf(status, "tile");
  return html`<span class="${classes("tile", sm && "tile--sm", `tone-${s.tone}`)}">${icon(glyph ?? s.icon, iconSm ? { size: "sm" } : {})}</span>`;
}

/** The most slot dots `slots` draws; past it the rest is a count. */
export const SLOTS_MAX = 32;

/** A count a mark draws one of per unit, or a throw: a whole number of 0 or more. */
function wholeOf(n, what, who) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`kit.${who}: ${what} is a whole count of 0 or more, not ${JSON.stringify(n)}`);
  return n;
}

/**
 * A host's slots as dots (the Status card's): filled blue for each running job (`sl--run`), a yellow ring for each slot
 * held by a job that is gone (`sl--hold`), an empty ring for each free one, in that order. An image, named by `label`
 * ("build3: 1 running, 1 held, 1 free"; by default the three counts), since the dots are drawn instead of the numbers.
 * At most `SLOTS_MAX` dots, then "+N" for the rest; the dots kept are the held ones first, then the running, then the
 * free, so a held slot, the one the overview calls out, is never the dot that is cut.
 */
export function slots({ run = 0, hold = 0, free = 0, label = null } = {}) {
  const [r, h, f] = [wholeOf(run, "run", "slots"), wholeOf(hold, "hold", "slots"), wholeOf(free, "free", "slots")];
  const held = Math.min(h, SLOTS_MAX);
  const running = Math.min(r, SLOTS_MAX - held);
  const open = Math.min(f, SLOTS_MAX - held - running);
  const more = r + h + f - held - running - open;
  const dots = (n, cls) => Array.from({ length: n }, () => html`<i class="${cls}"></i>`);
  const name = given(label) ? label : `${r} running, ${h} held, ${f} free`;
  return html`<span class="sls" role="img" aria-label="${name}">${dots(running, "sl sl--run")}${dots(held, "sl sl--hold")}${dots(open, "sl")}${more > 0 ? `+${grouped(more, "slots")}` : null}</span>`;
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

/** A row's end (`rowPill`): a count in bold, text or a fragment as it is, or `{ text, status | faint }` in that ink. */
function rowEnd(end) {
  if (typeof end === "number") return html`<span class="end"><b>${grouped(end, "rowPill")}</b></span>`;
  if (typeof end === "string" || isSafeHtml(end)) return html`<span class="end">${end}</span>`;
  if (end === null || typeof end !== "object" || Array.isArray(end)) throw new TypeError(`kit.rowPill: an end is a count, text, a fragment or { text, status | faint }, not ${JSON.stringify(end)}`);
  for (const k of Object.keys(end)) if (!END_KEYS.has(k)) throw new RangeError(`kit.rowPill: unknown end option ${JSON.stringify(k)}`);
  const { text, status = null, faint = false } = end;
  if (status !== null && faint) throw new RangeError("kit.rowPill: an end is in a status's ink or the faint one, not both");
  if (status !== null) return html`<span class="end tinted ${toneOrNull(status, "rowPill")}"><b class="tinted">${text}</b></span>`;
  return faint ? html`<span class="end faint">${text}</span>` : html`<span class="end">${text}</span>`;
}

/**
 * One row of a KPI card's list (the CardsAndBanners card's rows: Needs you's, In line's, Running's): a pill holding an
 * optional small icon in the status's ink (`status`, none for a neutral row), then `items` (text in a `<span>` each, a
 * fragment as it is: a `ptag`, an id in the code face, a host's name in bold, its `slots`), then `end` at the row's
 * right (`rowEnd`: In line's count, Running's "1 held" in the attention ink or "2 free" in the faint one), then
 * `action`: a link, `{ label, href }`, drawn as the row's small pill button (`rowpill__act`), or a fragment as it is
 * (an `actForm` for a write, which the shell's rules put at the row's right as they do the link).
 */
export function rowPill({ icon: glyph = null, status = null, items, action = null, end = null }) {
  if (!Array.isArray(items)) throw new TypeError("kit.rowPill: items is a list");
  const parts = items.map((it) => (isSafeHtml(it) ? it : html`<span>${it}</span>`));
  let act = null;
  if (action !== null) {
    if (isSafeHtml(action)) act = action;
    else if (typeof action === "object" && !Array.isArray(action) && Object.keys(action).every((k) => k === "label" || k === "href")) act = html`<a class="rowpill__act" href="${hrefOf(action.href, "rowPill")}">${action.label}</a>`;
    else throw new TypeError(`kit.rowPill: an action is { label, href } or a fragment (an actForm), not ${JSON.stringify(action)}`);
  }
  return html`<li class="${classes("rowpill", toneOrNull(status, "rowPill"))}">${glyph === null ? null : icon(glyph, { size: "sm" })}${parts}${end === null ? null : rowEnd(end)}${act}</li>`;
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

/**
 * One `<td>`: the column's flags and the cell's own, the phone label in a stacked table, an id in the no-wrap code face.
 * A column with no phone label ("") writes no `data-l` at all, so bundle.css's `td[data-l]::before` draws nothing before
 * its cells: an empty label is never a rule each page must remember to switch off.
 */
function cellOf(c, col, stack) {
  const own = c !== null && typeof c === "object" && !isSafeHtml(c) && !Array.isArray(c) ? c : { html: c };
  for (const k of Object.keys(own)) if (!CELL_KEYS.has(k)) throw new RangeError(`kit.tbl: unknown cell option ${JSON.stringify(k)}`);
  const flags = { ...own, num: own.num === true || col.num, hidePhone: own.hidePhone === true || col.hidePhone };
  const cls = classes(...Object.entries(CELL_FLAGS).map(([k, name]) => flags[k] === true && name));
  const content = own.id === true ? html`<span class="code">${own.html}</span>` : own.html;
  return html`<td${cls ? html` class="${cls}"` : null}${stack && col.l !== "" ? html` data-l="${col.l}"` : null}>${content}</td>`;
}

/**
 * A data table in its scrolling box. It is named by a `caption` (visually hidden; a card's title is what the eye
 * reads) or an `aria-label`, and one of them is required; every head is `<th scope="col">`. `rows` are lists of cells,
 * or `{ cells, mark, id }` where `mark` (attention, failed) tints the row and `id` names it, so a link elsewhere can
 * open the page at it (the audit log's `#seq-41`); a row id is held to the kit's id rule like any other (`idOf`). A
 * cell is a value or `{ html, id, num, wide, hidePhone, when, tgt, act }`; bundle.css never breaks an `id` cell's text
 * (the runs page lets a long id wrap inside a box of its own, `runs-css.mjs`). A column's `num` and `hidePhone` mark
 * its head as well as its cells, so a page's stylesheet can leave a whole column out. `stack` turns the rows into
 * stacked blocks on a phone, each cell labelled from its column's head (`data-l`), or not labelled where the head's
 * `l` is "". With no rows, `empty` is drawn instead: a fragment as it is, text as a note.
 *
 * A row may be `{ group: label }` instead (the RunsScreen card's day rows, "Thursday 8 October"): a header across every
 * column, `<tr class="tbl-group"><th scope="rowgroup" colspan="N">`, for the rows under it. Each group is a `<tbody>` of
 * its own, opened at its header, so `scope="rowgroup"` names exactly its own rows and not the whole table's; the rows
 * before the first header (none, as the runs page draws them) keep a body of their own. A group row carries nothing
 * else, and a group with no rows under it is the caller's to leave out.
 */
export function tbl({ label = null, caption = null, heads, rows, stack = false, empty = null }) {
  if (!given(label) && !given(caption)) throw new TypeError("kit.tbl: a table is named by a caption or an aria-label");
  if (rows.length === 0 && given(empty)) return isSafeHtml(empty) ? empty : html`<p class="note">${empty}</p>`;
  const cols = heads.map(headOf);
  // A head carries its column's `num` (right-aligned, as its cells are) and `hide-phone`, in the cells' order.
  const headClass = (c) => (c.num && c.hidePhone ? html` class="num hide-phone"` : c.num ? html` class="num"` : c.hidePhone ? html` class="hide-phone"` : null);
  const head = html`<thead><tr>${cols.map((c) => html`<th scope="col"${headClass(c)}>${c.label}</th>`)}</tr></thead>`;
  const bodies = [[]];
  for (const r of rows) {
    const row = Array.isArray(r) ? { cells: r, mark: null, id: null } : r;
    for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) throw new RangeError(`kit.tbl: unknown row option ${JSON.stringify(k)}`);
    if (Object.hasOwn(row, "group")) {
      if (Object.keys(row).length !== 1 || !given(row.group)) throw new TypeError("kit.tbl: a group row is { group: label } and nothing else");
      bodies.push([html`<tr class="tbl-group"><th scope="rowgroup" colspan="${String(cols.length)}">${row.group}</th></tr>`]);
      continue;
    }
    const mark = row.mark === null || row.mark === undefined ? null : pick(ROW_CLASS, row.mark, "row mark", "tbl");
    const id = row.id === null || row.id === undefined ? null : idOf(row.id, "tbl");
    if (row.cells.length !== cols.length) throw new RangeError(`kit.tbl: a row has ${row.cells.length} cells for ${cols.length} columns`);
    bodies.at(-1).push(html`<tr${id ? html` id="${id}"` : null}${mark ? html` class="${mark}"` : null}>${row.cells.map((c, i) => cellOf(c, cols[i], stack))}</tr>`);
  }
  // The rows before the first group's header are the first body; it is left out when there are none and a group follows.
  const drawn = bodies.length > 1 && bodies[0].length === 0 ? bodies.slice(1) : bodies;
  return html`<div class="tbl-wrap"><table class="${classes("tbl", stack && "tbl--stack")}"${given(label) ? html` aria-label="${label}"` : null}>${given(caption) ? html`<caption class="sr">${caption}</caption>` : null}${head}${drawn.map((b) => html`<tbody>${b}</tbody>`)}</table></div>`;
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

/**
 * A capsule's drawing, the FactsAndLevels card's: 40 by 150, the pill 32 wide and never lower than 32 (so it is a
 * round-ended pill at 0%, as the card draws a small level), its value 21 below the pill's top, which centres it in the
 * pill's round top (and in the whole pill at the minimum).
 */
const CAP = Object.freeze({ w: 40, h: 150, pillMin: 32, valueDy: 21 });

/** Text a helper writes into an attribute as well as the page, or a throw: a fragment's markup would show in a title. */
function plainOf(text, what, who) {
  if (typeof text !== "string") throw new TypeError(`kit.${who}: ${what} is text, not ${JSON.stringify(text)}`);
  return text;
}

/**
 * A cap's level as a capsule (the FactsAndLevels card's, the overview's Caps): a rail, the soft-hold line as a ring at
 * `hold` percent from the bottom (none where `hold` is null: a dollar window has no soft hold), the level as a pill
 * rising from the bottom, at least 32 high, its percent printed in it, and the window's name under it (`name` in bold,
 * then `window`). Its status follows the meter rule unless given (ok, attention from the hold, failed at the cap), and
 * its tone class is on the `<svg>`, not on the pill as the card writes it: bundle.css paints the pill `--tone` and the
 * printed percent `--on-tone`, and the percent is the pill's sibling, so on the card it inherited no tone and was drawn
 * in SVG's default black, 4.16:1 on the light theme's `ok` and 4.42:1 on its `failed`. On the `<svg>` both read it, and
 * the percent is the `on-<status>` on `<status>` pair (4.5:1 in both themes, `console-contrast.test.mjs`). The
 * capsule's `title` and its image's name (`label`, by default "Jobs today: 63 percent of cap") say the percent, whole;
 * the pill stops at the top, the printed percent does not (a window past its cap says so). `pct` is a finite number, or
 * a throw: a level that is not known is not drawn. A `unit` ("$") follows the name joined by a no-break space, written
 * here because `html` turns one in a value into a plain space (a blank a reader cannot tell from a space is scrubbed):
 * the label is a quarter of a phone's card, where a long model name wraps, and a unit alone on a line names nothing.
 */
export function capsule({ name, window, pct, hold = null, status = null, label = null, unit = null }) {
  if (!Number.isFinite(pct)) throw new TypeError(`kit.capsule: a level is a finite percentage, not ${JSON.stringify(pct)}`);
  const named = unit === null ? plainOf(name, "a name", "capsule") : `${plainOf(name, "a name", "capsule")} ${plainOf(unit, "a unit", "capsule")}`;
  const what = `${named} ${plainOf(window, "a window", "capsule")}`;
  const tone = `tone-${statusOf(status ?? levelStatus(pct, hold), "capsule").tone}`;
  const shown = String(Math.max(0, Math.round(pct)));
  const pill = Math.max(CAP.pillMin, Math.round((CAP.h * Math.min(100, Math.max(0, pct))) / 100));
  const top = CAP.h - pill;
  const ring = Number.isFinite(hold) ? html`<circle class="cap__hold" cx="20" cy="${svgNum(CAP.h * (1 - hold / 100), 0, CAP.h, 0)}" r="4"/>` : null;
  return html`<div class="cap" title="${`${what}: ${shown}%`}"><svg class="${tone}" width="${CAP.w}" height="${CAP.h}" viewBox="0 0 ${CAP.w} ${CAP.h}" role="img" aria-label="${given(label) ? label : `${what}: ${shown} percent of cap`}"><line class="cap__rail" x1="20" x2="20" y1="0" y2="${CAP.h}"/>${ring}<rect class="cap__pill" x="4" y="${svgNum(top, 0, CAP.h, 0)}" width="32" height="${svgNum(pill, 0, CAP.h, 0)}" rx="16"/><text class="cap__v" x="20" y="${svgNum(top + CAP.valueDy, 0, CAP.h, 0)}" text-anchor="middle">${shown}</text></svg><p class="cap__l"><b>${name}${unit === null ? null : html`&nbsp;${unit}`}</b>${window}</p></div>`;
}

/** How many dots a spend column has, the CardsAndBanners card's: one hour's spend is drawn as 0 to 7 of them lit. */
export const SPEND_DOTS = 7;

/**
 * Spend by hour as a dot matrix (the CardsAndBanners card's Spend today): one column per hour of `hours` (a list of
 * amounts, any unit, the first at `startHour`, 0 to 23, UTC; at most a day's 24), each of `SPEND_DOTS` dots lit from the
 * bottom, `round(7 * value / max)` of them, `max` the top of the scale (by default the largest hour, which is then a
 * full column). An hour that spent anything lights at least one dot, so a small hour never reads as one with none; an
 * amount that is not a positive number is none. An image named by `label`; under it the axis, the first, middle and
 * last hours. No hours draw nothing.
 */
export function spendDots({ hours, max = null, label, startHour = 0 }) {
  if (!Array.isArray(hours) || hours.length > 24) throw new RangeError("kit.spendDots: hours is a list of at most a day's 24");
  if (!given(label)) throw new TypeError("kit.spendDots: the chart is named");
  if (!Number.isSafeInteger(startHour) || startHour < 0 || startHour > 23) throw new RangeError(`kit.spendDots: startHour is an hour, 0 to 23, not ${JSON.stringify(startHour)}`);
  if (hours.length === 0) return html``;
  const values = hours.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const scale = Number.isFinite(max) && max > 0 ? max : Math.max(...values);
  const lit = (v) => (v === 0 || !(scale > 0) ? 0 : Math.min(SPEND_DOTS, Math.max(1, Math.round((SPEND_DOTS * v) / scale))));
  const columns = values.map((v) => {
    const on = lit(v);
    return html`<span class="sd__c">${Array.from({ length: SPEND_DOTS }, (_, i) => (i < on ? html`<i class="on"></i>` : html`<i></i>`))}</span>`;
  });
  const marks = [...new Set([0, Math.floor(values.length / 2), values.length - 1])];
  const hourAt = (i) => `${String((startHour + i) % 24).padStart(2, "0")}:00`;
  return html`<div class="sd" role="img" aria-label="${label}">${columns}</div><p class="axis">${marks.map((i) => html`<span>${hourAt(i)}</span>`)}</p>`;
}

/** A scheduler's run's id as BullMQ names it, `repeat:<scheduler>:<slot>`; a cron trigger's scheduler is its id. */
const SCHEDULER_RUN_RE = /^repeat:([A-Za-z0-9._-]{1,200}):(0|[1-9][0-9]{0,15})$/;

/**
 * A cron trigger's run, from its id alone: `{ scheduler, at }`, the scheduler's (the trigger's) id and the instant of
 * the run, its slot in ms (null for one no date can show, past `DEFER_TIME_MAX_MS`), or null for any other id. The id
 * is a key and a number, which says nothing to a person: the overview's waitlist and timeline name the run by its
 * trigger and its time, and keep the id for its title. One copy, here, since the timeline (which imports the kit
 * alone) and the overview's panels both read it.
 */
export function schedulerRunOf(jobId) {
  const m = typeof jobId === "string" ? SCHEDULER_RUN_RE.exec(jobId) : null;
  if (m === null) return null;
  const at = Number(m[2]);
  return { scheduler: m[1], at: Number.isSafeInteger(at) && at <= DEFER_TIME_MAX_MS ? at : null };
}

/** The narrowest wait bar, px: the Waitlists card's at 375 px, against which a segment's room is judged. */
export const WAIT_BAR_PX = 310;

/** A wait bar row's height and the gap between two rows, px. */
const WAIT_ROW = Object.freeze({ h: 30, gap: 6 });

/**
 * The least share of the narrowest bar a segment showing `text` takes, in percent: its glyph (10 px in, 14 wide, 6
 * before the count), its count at 13 px, 800 (each character taken as a tabular digit, 8.8 px in Chrome, so 9; a group
 * comma is narrower), and 10 px before the segment's end.
 */
const segmentPct = (text) => ((30 + text.length * 9 + 10) / WAIT_BAR_PX) * 100;

/**
 * Each count's share of 100, in proportion, except that a share under its `floors[i]` is raised to it and the others
 * share what is left in proportion again, until none is under (so a bar of 1, 1, 1 and 2 is 20, 20, 20 and 40, the
 * card's). The floors add up to at most 100, so what is left is never negative.
 */
function sharesOf(counts, floors) {
  const out = counts.map(() => null);
  let room = 100;
  let left = counts.reduce((a, b) => a + b, 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, n] of counts.entries()) {
      if (out[i] === null && (room * n) / left < floors[i]) {
        out[i] = floors[i];
        room -= floors[i];
        left -= n;
        changed = true;
      }
    }
  }
  return out.map((w, i) => w ?? (room * counts[i]) / left);
}

/**
 * The bar's rows: the segments in order, cut into the fewest rows, as even in number as they can be, whose segments'
 * least shares each fit in one row (`[[from, to], ...]`). One segment's least share is under a row's whole (its count
 * at most 16 digits and 5 commas is 229 px of 310), so there is always a cut.
 */
function waitRowsOf(floors) {
  for (let k = 1; ; k += 1) {
    const size = Math.ceil(floors.length / k);
    const rows = [];
    for (let from = 0; from < floors.length; from += size) rows.push([from, Math.min(floors.length, from + size)]);
    if (rows.every(([from, to]) => floors.slice(from, to).reduce((a, b) => a + b, 0) <= 100)) return rows;
  }
}

/**
 * The waiting jobs by reason as one bar (the TimelineAndWaitlists card's Waitlists): a segment per reason with jobs,
 * each `{ icon, count }`, its width its share of them (`sharesOf`), its icon and its count in it, the segments
 * alternating their two greys (`wb--0` to `wb--3`, as the card's four, then again). A segment of 0 jobs is not drawn,
 * and a bar with none draws nothing. An image named by `label`. Each segment's edge is placed from the running total,
 * so a row's widths add up to exactly 100%.
 *
 * NO SEGMENT IS NARROWER THAN ITS GLYPH AND ITS COUNT. A segment takes at least what they need on the narrowest bar
 * (`WAIT_BAR_PX`), sized to its count's digits; when the segments' least shares add up to more than the bar, it wraps
 * into rows (`waitRowsOf`), each row a bar of its own, `WAIT_ROW.gap` apart. One least share for every segment, 100% /
 * n with seven reasons or more, had drawn every count out of sight at 375 px and cut a three-digit count to "1:".
 */
export function waitBar(segments, { label } = {}) {
  if (!Array.isArray(segments)) throw new TypeError("kit.waitBar: segments is a list");
  if (!given(label)) throw new TypeError("kit.waitBar: the bar is named");
  for (const s of segments) {
    if (typeof s?.icon !== "string" || !ICONS.has(s.icon)) throw new RangeError(`kit.waitBar: unknown icon ${JSON.stringify(s?.icon)}`);
    wholeOf(s.count, "a segment's count", "waitBar");
  }
  const drawn = segments.filter((s) => s.count > 0).map((s) => ({ ...s, text: grouped(s.count, "waitBar") }));
  if (drawn.length === 0) return html``;
  const floors = drawn.map((s) => segmentPct(s.text));
  const rows = waitRowsOf(floors);
  const parts = rows.map(([from, to], r) => {
    const y = r * (WAIT_ROW.h + WAIT_ROW.gap);
    const row = drawn.slice(from, to);
    const shares = sharesOf(row.map((s) => s.count), floors.slice(from, to));
    let total = 0;
    const edges = [0, ...shares.map((w) => Number(svgNum((total += w), 0, 100, 2)))];
    return row.map((s, i) => {
      const x = svgNum(edges[i], 0, 100, 2);
      return html`<rect class="wb wb--${(from + i) % 4}" x="${x}%" y="${y}" width="${svgNum(edges[i + 1] - edges[i], 0, 100, 2)}%" height="${WAIT_ROW.h}" rx="8"/><g transform="translate(10 ${y + 8})"><use class="wb-g" href="#i-${s.icon}" x="${x}%" width="14" height="14"></use></g><text class="wb-t" x="${x}%" dx="30" y="${y + 20}">${s.text}</text>`;
    });
  });
  const height = rows.length * WAIT_ROW.h + (rows.length - 1) * WAIT_ROW.gap;
  return html`<svg class="wbar" height="${height}" role="img" aria-label="${label}">${parts}</svg>`;
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

/**
 * A catalog sentence with each `backticked` run in the code face (`<span class="code">`), the way the console's own
 * sentences mark a command or a name (the reason catalog writes its backticks for Markdown the same way): "An operator
 * should run `pi-dispatch doctor` on the host." Every run is escaped like any text. A sentence with an odd number of
 * backticks throws: the catalogs are code, and a stray backtick would otherwise put the rest of a sentence in the code
 * face. A sentence with none is itself.
 */
export function withCode(text) {
  const parts = String(text).split("`");
  if (parts.length % 2 === 0) throw new RangeError(`kit.withCode: an unclosed backtick in ${JSON.stringify(String(text))}`);
  return html`${parts.map((p, i) => (i % 2 === 1 ? html`<span class="code">${p}</span>` : p))}`;
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
 * `maxlength` is the most characters the field takes (a whole number of 1 or more, or a throw), as the action that
 * reads it bounds its text (a parked answer's 8,192).
 */
export function textarea({ id, name = null, value = "", placeholder = null, rows = null, maxlength = null, ...rest }) {
  if (maxlength !== null && (!Number.isSafeInteger(maxlength) || maxlength < 1)) throw new RangeError(`kit.textarea: maxlength is a whole number of 1 or more, not ${JSON.stringify(maxlength)}`);
  const lines = String(value ?? "").split(/\r?\n/);
  const text = lines.map((line, i) => (i === 0 ? html`${line}` : html`\n${line}`));
  return html`<textarea id="${idOf(id, "textarea")}" class="textarea"${name === null ? null : html` name="${name}"`}${rows === null ? null : html` rows="${svgNum(rows, 1, 40, 0)}"`}${maxlength === null ? null : html` maxlength="${String(maxlength)}"`}${placeholder === null ? null : html` placeholder="${placeholder}"`}${controlAttrs(rest, "textarea")}>${lines[0] === "" && lines.length > 1 ? html`\n` : null}${text}</textarea>`;
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
 * Each argument is a `<span>` of its own, the spaces between them text, so the `<code>`'s text is still exactly the
 * line (the card draws the line as one text): the console's copy box wraps (`page-css.mjs` `SHELL_CSS`), and as one
 * text a line broke after any hyphen, so `--name` was cut into `--` and `name` on a phone; as boxes of their own, a line
 * breaks between arguments, and inside one only when it is wider than the box.
 */
export function cmd(argv, { host = null } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("kit.cmd: a command is a non-empty argument list");
  const words = argv.map((a, i) => shellWord(a, i === 0, "cmd"));
  const line = words.map((w, i) => html`${i === 0 ? null : " "}<span>${w}</span>`);
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

// ---- filters and summaries ----------------------------------------------------------------------------------------------------

/**
 * A search pill (the RunsScreen and ErrorPage cards'): the search icon and a search field in one pill, the field named
 * by `label` in visually hidden text inside the `<label>`. `id` is the field's: `SEARCH_ID` for the runs search (the one
 * reserved id a helper may write, see there), else any kit id. `name` is its query parameter and `value` what it holds
 * (null for none). The field is a bare `<input>`, as the cards draw it, not the kit's `.input`, whose ring and ground
 * would draw a second field inside the pill.
 */
export function searchPill({ id, name, value = null, label = "Search runs", placeholder = "Repository, target or job id" }) {
  const fid = id === SEARCH_ID ? id : idOf(id, "searchPill");
  if (typeof name !== "string" || !FIELD_NAME_RE.test(name)) throw new RangeError(`kit.searchPill: a field's name is a query parameter, not ${JSON.stringify(name)}`);
  if (!given(label)) throw new TypeError("kit.searchPill: a search field is named");
  return html`<label class="search">${icon("search")}<span class="sr">${label}</span><input id="${fid}" type="search" name="${name}"${value === null ? null : html` value="${value}"`}${placeholder === null ? null : html` placeholder="${placeholder}"`} autocomplete="off" spellcheck="false"></label>`;
}

/**
 * The Filters button that folds a filter bar on a phone (the RunsPhone card's): an `fpill` with the settings icon, its
 * label and, where filters are applied, their number in bold. Drawn `hidden` with `data-reveal`, `data-filter-toggle`
 * and `aria-expanded="false"`: the browser script shows it and folds the bar (`.filterbar[data-collapsible]`,
 * `script.mjs`), so a page without the script shows every filter and no button that does nothing. bundle.css draws the
 * button on a phone alone (`.filterbar__toggle`).
 */
export function filterToggle({ count = null, label = "Filters" } = {}) {
  const n = count === null ? 0 : wholeOf(count, "count", "filterToggle");
  return html`<button class="fpill filterbar__toggle" type="button" data-filter-toggle aria-expanded="false" hidden data-reveal>${icon("config", { size: "sm" })}${label}${n === 0 ? null : html` <b>(${grouped(n, "filterToggle")})</b>`}</button>`;
}

/**
 * A filter pill (the RunsScreen card's project chips): a link drawn as a pill, its `label` (text, or a fragment such as a
 * project's `ptag`), then its `count` in bold where one is given. `on` marks the filter in force (`fpill--on`, the
 * primary fill) and says so with `aria-current="page"`, since the link leads to the page shown, so the state is never
 * the colour alone.
 */
export function fpill({ label, count = null, href, on = false }) {
  const n = count === null ? null : grouped(count, "fpill");
  return html`<a class="${classes("fpill", on && "fpill--on")}" href="${hrefOf(href, "fpill")}"${on ? html` aria-current="page"` : null}>${label}${n === null ? null : html` <b>${n}</b>`}</a>`;
}

/**
 * An applied filter as a removable chip (the RunsScreen card's): "label:", its `value` in the code face, and a link that
 * removes it (`href`: the page's query without that filter), an icon named for what it removes ("Remove Outcome"). A
 * link, not a button: removing a filter is opening the page without it, which needs no script.
 */
export function fchip({ label, value, href }) {
  const name = plainOf(label, "a label", "fchip");
  return html`<span class="chip">${name}: <span class="code">${value}</span><a class="chip__x" href="${hrefOf(href, "fchip")}" aria-label="${`Remove ${name}`}">${icon("failed", { size: "sm" })}</a></span>`;
}

/**
 * A row of pills or chips (the project pills, the applied filters and Clear filters), named for what it holds
 * (`role="group"`, `label`). `items` are fragments. It wraps above a phone and scrolls inside itself on one
 * (`runs-css.mjs`), so many projects or a long filter value never widen the page.
 */
export function chipRow(items, { label }) {
  if (!Array.isArray(items)) throw new TypeError("kit.chipRow: items is a list");
  if (!given(label)) throw new TypeError("kit.chipRow: a row of chips is named");
  return html`<div class="chiprow" role="group" aria-label="${label}">${items}</div>`;
}

/**
 * A summary strip (the RunsScreen card's counts by outcome): a named list (`label`) of items, each `{ n, label, status,
 * href, floor, hidePhone }`: its number in bold over its label, in a status's tone with the status's icon (`status`
 * null for a neutral item), a link where `href` is given (the runs filtered to it). `n` is a count (grouped, "1,204") or
 * text ("$6.13"); `floor` says the count is a lower bound, in words ("at least 2,000"), where the read stopped short.
 * `hidePhone` leaves an item off a phone's strip, which shows the counts that matter (the RunsPhone card's four).
 */
export function sumStrip(items, { label }) {
  if (!Array.isArray(items)) throw new TypeError("kit.sumStrip: items is a list");
  if (!given(label)) throw new TypeError("kit.sumStrip: a strip is named");
  const drawn = items.map((it) => {
    if (it === null || typeof it !== "object" || Array.isArray(it)) throw new TypeError("kit.sumStrip: an item is { n, label, status, href, floor, hidePhone }");
    for (const k of Object.keys(it)) if (!SUM_KEYS.has(k)) throw new RangeError(`kit.sumStrip: unknown item option ${JSON.stringify(k)}`);
    const { n, label: what, status = null, href = null, floor = false, hidePhone = false } = it;
    const shown = typeof n === "number" ? grouped(n, "sumStrip") : n;
    if (typeof shown !== "string" && !isSafeHtml(shown)) throw new TypeError(`kit.sumStrip: a value is a count, text or a fragment, not ${JSON.stringify(n)}`);
    const s = status === null ? null : statusOf(status, "sumStrip");
    const inner = html`<b>${floor ? html`<small>at least</small> ` : null}${shown}</b><span>${s === null ? null : icon(s.icon, { size: "sm" })}${what}</span>`;
    const cls = classes("sumstrip__i", s !== null && `tone-${s.tone}`);
    const item = href === null ? html`<span class="${cls}">${inner}</span>` : html`<a class="${cls}" href="${hrefOf(href, "sumStrip")}">${inner}</a>`;
    return html`<li${hidePhone ? html` class="hide-phone"` : null}>${item}</li>`;
  });
  return html`<ul class="sumstrip" aria-label="${label}">${drawn}</ul>`;
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

/** One hidden field of an `actForm`: `[name, value, type]` or `{ name, value, type }`, each held to its rule. */
function hiddenOf(f) {
  const [name, value, type = null] = Array.isArray(f) ? f : f !== null && typeof f === "object" ? [f.name, f.value, f.type ?? null] : [];
  if (typeof name !== "string" || !FIELD_NAME_RE.test(name)) throw new RangeError(`kit.actForm: a field's name is a body key, not ${JSON.stringify(name)}`);
  if (type !== null && !FIELD_TYPES.has(type)) throw new RangeError(`kit.actForm: unknown field type ${JSON.stringify(type)} (one of ${[...FIELD_TYPES].join(", ")}, or none for text)`);
  const plain = typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
  if (!plain) throw new TypeError(`kit.actForm: ${name}'s value is text, a finite number or a boolean, not ${JSON.stringify(value)}`);
  return html`<input type="hidden" name="${name}" value="${String(value)}"${type === null ? null : html` data-type="${type}"`}>`;
}

/**
 * A write's button (issue #642's action forms, in the kit's look): `<form class="act" data-action>`, its `hidden` fields
 * (`[name, value, type]` or `{ name, value, type }`; `type`, `int`, `json` or `list`, says how the browser script reads
 * the value, text by default), then the submit button, `btn`'s with `kind` (small by default; a paid act adds `paid`, a
 * destructive one `danger`, a round button `round` with its `icon` and `label` as its name). The browser script
 * previews it in the page's one confirm slot (`confirm-view.mjs`), so the form holds no preview area of its own, and
 * nothing is written until its Confirm. The attributes are the console's other action forms' (`panels/common.mjs`
 * `actForm`), `autocomplete="off"` included, so the script's one delegated handler reads both alike.
 */
export function actForm({ action, hidden = [], label, kind = ["sm"], icon: glyph = null }) {
  if (typeof action !== "string" || !ACTION_RE.test(action)) throw new RangeError(`kit.actForm: an action is a name the script posts, [a-z0-9-]{1,40}, not ${JSON.stringify(action)}`);
  if (!Array.isArray(hidden)) throw new TypeError("kit.actForm: hidden is a list of fields");
  return html`<form class="act" data-action="${action}" autocomplete="off">${hidden.map(hiddenOf)}${btn({ type: "submit", kind, label, icon: glyph })}</form>`;
}

// ---- a parked run's question ----------------------------------------------------------------------------------------------------

/**
 * A parked run's question as a card (the ParkedPhone card's): the parked tile, "<id> asks" with the run's id in the code
 * face linked to its page (`runHref`), how long it has waited (`waited`, text), a meta line (the project's tag, the
 * `target`, and `where`: text or a fragment each, such as the forge and the chain's count), the `body` on the parked
 * tint, then `answer` (an `answerForm`, or a banner saying why it cannot be answered here). An `<article>`, a card
 * ringed in the parked tone and named "<id> asks"; the panel element around it stays bare.
 *
 * THE CARD HOLDS NO QUESTION TEXT unless a caller puts it in `body`, and the console's callers never do: a parked row
 * carries none, and transcript text is shown only in a run page's transcript (REQ-CONSOLE-SECURITY (l)). Their body
 * says where the question is read.
 */
export function questionCard({ jobId, runHref = null, waited = null, project = null, target = null, where = null, body = null, answer = null }) {
  const id = plainOf(jobId, "a job id", "questionCard");
  const part = (v) => (isSafeHtml(v) ? v : html`<span>${v}</span>`);
  const meta = [given(project) ? ptag(project) : null, given(target) ? part(target) : null, given(where) ? part(where) : null].filter((m) => m !== null);
  const wait = given(waited) ? html`<span class="qcard__wait"><span class="sr">waiting </span>${waited}</span>` : null;
  return html`<article class="card card--ring tone-parked qcard" aria-label="${`${id} asks`}"><p class="qcard__top">${tile("parked", { sm: true, iconSm: true })}<b>${runHref === null ? html`<span class="code">${id}</span>` : html`<a class="code" href="${hrefOf(runHref, "questionCard")}">${id}</a>`} asks</b>${wait}</p>${meta.length === 0 ? null : html`<p class="qcard__meta">${meta}</p>`}${given(body) ? html`<div class="qcard__body">${body}</div>` : null}${given(answer) ? answer : null}</article>`;
}

/** The most characters an answer's field takes: the worker's bound on an answer (`console-answer.mjs`, in bytes). */
export const ANSWER_MAX = ANSWER_TEXT_MAX_BYTES;

/**
 * A parked run's answer form (the ParkedPhone card's answer box), drawn where the console can build the answer, which
 * the caller has checked: `<form class="act qform" data-action="parked-answer">` with the run's id as its `jobId` field
 * and the answer as `text`, the names `panels/common.mjs` `parkedAnswerForm` has always posted, so the browser script
 * and the action read it as before. The field's label is visually hidden (the card above it says what is asked); it
 * takes at most `ANSWER_MAX` characters, is required, and names `hint` (the line under the buttons) as its description.
 * Then Preview the answer, in the answer act's fill, and an Open run link where `runHref` is given. `id` is the field's,
 * a kit id unique on the page. Nothing is posted until the preview's Confirm (`confirm-view.mjs`).
 */
export function answerForm({ jobId, id, hint, runHref = null }) {
  const fid = idOf(id, "answerForm");
  const field = html`<label class="sr" for="${fid}">Your answer, as the reply on the issue</label>${textarea({ id: fid, name: "text", rows: 3, maxlength: ANSWER_MAX, placeholder: "Write your answer", required: true, describedBy: given(hint) ? `${fid}-hint` : null })}`;
  const open = runHref === null ? null : btn({ kind: "ghost", label: "Open run", href: runHref });
  const said = given(hint) ? html`<p class="field__hint" id="${idOf(`${fid}-hint`, "answerForm")}">${hint}</p>` : null;
  return html`<form class="act qform" data-action="parked-answer" autocomplete="off">${hiddenOf(["jobId", plainOf(jobId, "a job id", "answerForm")])}${field}<div class="qform__act">${btn({ type: "submit", kind: "answer", icon: "comment", label: "Preview the answer" })}${open}</div>${said}</form>`;
}

/**
 * A link out of the console (a run's issue on its forge, a reasons docs page): `href` an http(s) URL in its own
 * canonical form with no user name (`outHrefOf`; every link `forgeLinkOf` and `docsHref` build is one), drawn as the
 * design's link (`code` sets it in the code face), opening in a new tab that gets no handle on this window and no
 * Referer. The attributes are written in exactly the order `console-pages-harness.mjs`'s outbound-link rule reads
 * (`href`, then `rel="noreferrer noopener"`, then `target="_blank"`, last), the one shape of reference to another host
 * a page may carry. `btn` (a `btn` kind or a list of them, as `btn` takes) draws the link as that button instead, as
 * the SetupScreen card draws "What triggers can do" beside its primary: a ghost button, the same link otherwise.
 */
export function outLink({ href, label, code = false, btn: kind = null }) {
  const kinds = kind === null ? [] : Array.isArray(kind) ? kind : [kind];
  for (const k of kinds) if (!BTN_KINDS.includes(k)) throw new RangeError(`kit.outLink: unknown button kind ${JSON.stringify(k)} (one of ${BTN_KINDS.join(", ")})`);
  const cls = kind === null ? classes("link", code && "code") : classes("btn", ...kinds.map((k) => `btn--${k}`), code && "code");
  return html`<a class="${cls}" href="${outHrefOf(href, "outLink")}" rel="noreferrer noopener" target="_blank">${label}</a>`;
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
