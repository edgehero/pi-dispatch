/**
 * The overview's timeline (issue #737): the fleet's last hours as rows of pills, one row per project (or per host),
 * what ran left of the now line and what is in line right of it. PURE: `timelineModel` turns the snapshot's parts and
 * an instant into positions and words, `timelineHtml` draws a model as the TimelineAndWaitlists card draws it
 * (`.tl-wrap`, `.tl`, one `svg.tl__r` per lane, the bundle's `.tp*`, `.tnow`, `.tail`, `.dep` and `.gapline` classes),
 * and `timelineLegend` is its key. Nothing here reads a clock or a store: the same snapshot and the same `now` draw the
 * same bytes, which is what lets a live tick swap the panel only when something moved.
 *
 * WHAT IS DRAWN, AND FROM WHERE (every input is a snapshot field the reader already re-checked; each is held again here
 * to its type, since this module is handed whatever a caller passes):
 *   - `ok`: a run that ended completed, and one an operator cancelled (titled "cancelled"), from `runsDay`'s records. A
 *     run that asked a question and was answered since is completed too (titled so): only an unanswered one is parked.
 *   - `failed`, and `refused` (a circle at its instant: a refusal spends nothing and takes no time).
 *   - `run`: an `active` job, from its start to now, its host and project from the registry rows' `jobs`.
 *   - `parked`: an unanswered `awaiting-input` record (`parked`), its pill plus a violet tail to now. A park older than
 *     the day's records is still drawn, as the tail alone, because a person is still waited on.
 *   - `held`: a registry orphan (`o`), from when it took its slot to now, "still holds a <host> slot". Its own record,
 *     when the day has one, is folded into it (the record's outcome is its words) rather than drawn twice.
 *   - `wait`: a `readWaiting` row, from `max(now, dueAt)` to the window's end: it has no end yet. A dotted gap leads to
 *     a due time still to come; an arrow leads from what it waits for (`dep`). A cron trigger's run, which BullMQ names
 *     `repeat:<trigger>:<slot>`, is named by its trigger and its time on its pill ("hourly-sync 15:00 run", the kit's
 *     `schedulerRunOf`), its raw id in its title.
 * Ended runs are clipped at the window's start, and a run that ended before it is not drawn.
 *
 * POSITIONS ARE SVG PERCENTAGES. The CSP forbids `style=`, so a pill is placed by its `x` and `width` attributes, in
 * percent of the lane, every number through the kit's `svgNum` (a NaN or a runaway value can never reach an attribute).
 * A pill narrower than `PILL_MIN_PCT` would be a dot nobody can hover, so it is widened, toward the past for what ends
 * at now. A WAITING PILL ALWAYS SAYS WHAT IT WAITS FOR, AND WHEN IT STARTS WHERE ITS DUE IS NOT, IT SAYS WHEN. ONE
 * START RULE places it: it starts at its due time or at its bucket's start (`WAIT_START_X`), whichever is earlier, and
 * never before the lead just right of now (`WAIT_LEAD_PCT`; where a job already due starts). A bucket's start is where
 * the glyph, a name of `WAIT_NAME_MIN` characters, the bucket's one word (`TIMELINE_WAIT_WORDS`) and a due time just
 * fit before the window's end, one number for every pill of the bucket. A pill at its due is drawn where it is, the
 * dotted gap from now leading to it and the axis saying its time, and its label says what it waits for; one due later
 * than its bucket's start is MOVED left to that start, and its label is its word and its due time ("check 07:00", the
 * axis's UTC words; "in 2d 4h" for one more than a day off), since where it starts is no longer when. So of two pills
 * of one bucket the one due later never stands left of the other, whatever their names and however far off they are
 * due: the start is the due's alone. Across buckets the starts differ by the words' widths: a moved pill can stand left
 * of a pill of another bucket drawn at its due before it, only between the lead and the latest bucket start (`slot`'s,
 * the narrowest word that waits for a time; the widest words' starts are the lead itself), and it says its time. The
 * name is what gives way, never the word or the time: it is cut to what the pill leaves it (the title and the
 * Waitlists card name it whole). Without the rule a job due near the end was a sliver with no word on it; with a word
 * and no time, a job due tomorrow at 07:00 was drawn at 16:25 saying "check", which read as a check at 16:25; drawn
 * just right of now with no time, a job due tomorrow read as one about to start; placed for a long name's whole width,
 * a long name lost its word ("no reason" from 12 characters at every zoom); and with two starts, at its due where its
 * word alone fit and else further left where its word and its time fit, a job due later stood left of one due before
 * it (at 1h, a check due in 10 minutes at 77.78 and every one due 14 to 25 minutes on at 71.95).
 *
 * TIMES ON THE AXIS ARE UTC TEXT INSIDE THE SVG. The browser script turns `<time>` elements into the reader's local
 * time, and an SVG `<text>` is not one, so the axis, the now cap and the titles are UTC, and the axis writes "UTC"
 * beside its times. Every other time on the page is a `<time>`.
 *
 * LABELS ARE FITTED AGAINST THE NARROWEST LANE. The server cannot measure text, so a label is judged by an estimate of
 * its width against `TRACK_PX`: the bundle keeps `.tl` at least 720 px wide on a phone, which leaves 596 px beside the
 * 124 px row heads, and a wider lane only adds room. This relies on the page holding `.tl` at that minimum on every
 * screen, not only a phone's (`page-css.mjs`), since the bundle's minimum applies only up to 760 px and the timeline's
 * card is narrower than 720 px above that too: in the overview's one column just above a phone (673 px of timeline at
 * 761 px, up to 807), and beside the 470 px side column from 1,200 px (`OVERVIEW_LAYOUT.stackMax` is the last width of
 * one column) up to 1,293 (626 px at 1,200), as measured in Chrome. A label that
 * does not fit inside its pill goes beside it (a running job's, a failure's, a refusal's, whichever side has room, and
 * never right of now for what has ended) or is left out (a completed run's); the pill's `<title>` always carries the
 * id, the target and the words. A park's "waiting for you" sits over its tail where it ends before now, else with the
 * id before the pill; neither ever reaches now, since right of it is what is in line, which a park is not. The cost is
 * on wide screens, where a row may take a lane more than it needs: the alternative, labels that sit on each other on a
 * phone, says nothing at all.
 *
 * LANES: THE FEWEST, AND UNDER THE CAP WHAT A PERSON ACTS ON. A row packs its items by start, each into the first lane
 * where it and its label fit (a job waiting on something on its row tries that blocker's lane first), which is the
 * fewest lanes. When that needs more than `TIMELINE_LANES_MAX`, the row is packed again by kind (`TIMELINE_KINDS`):
 * running, held and parked first, then failed, refused and waiting, and completed runs fill what is left, an item
 * giving up its outside label before it gives up its place. Packing by start under the cap would drop whatever comes
 * last, which is the in-line work right of now, the part of the row a person came for. What fits nowhere is counted in
 * the row's `more` and its aria-label, never dropped silently. A waiting job runs to the window's end, so each takes a
 * lane of its own right of now: a row with more waiting jobs than lanes shows some and counts the rest, and the
 * Waitlists card beside it lists every one.
 *
 * NO PACKING PASS OPENS A LANE PAST THE CAP. The first pass asks only whether the row fits in `TIMELINE_LANES_MAX`
 * lanes, and stops at the first item that does not. It once packed into as many lanes as the row needed, and since a
 * waiting job needs a lane of its own, a queue of thousands opened thousands of lanes, each tried by every item after
 * it: quadratic, seconds of the hub's one thread on every tick. With at most four lanes, each holding what fits across
 * the window, an item tries a bounded number of places. And since every waiting job takes a lane of its own right of
 * now, at most four are drawn: the next four to start, a job that waits on something on its row first (as both
 * passes take them), the rest counted without being shaped, sorted or packed. A waiting job's blocker is what it waits on drawn left of now; one that is itself in line
 * draws no arrow (two waiting jobs never share a lane).
 *
 * ROWS AND CHIPS ARE BOUNDED. At most `TIMELINE_ROWS_MAX` rows are drawn and `TIMELINE_CHIPS_MAX` project chips given,
 * the ones a person acts on first (a row's or a project's most pressing item by `TIMELINE_KINDS`, then the most items,
 * then the name), shown in name order; the rows left out are counted in one line under the drawn ones (`rowsMore`), the
 * chips left out in `chipsMore`. Every project a record or a waiting job names was a row and a chip, and every host a
 * row, so a window that named thousands drew megabytes of panel on every tick.
 *
 * AN ARROW IS DRAWN ONLY BESIDE WHAT IS WAITED ON. A waiting job's blocker is the record's `holder` (a chained job's
 * parent, a recovery's run), or, for a job whose host is full (`host-slot`, `host-budget`), an orphan holding a slot on
 * that host: freeing that slot is what lets it in. The folder, repository, project, endpoint, size and bundle reasons
 * wait on something an orphan's slot does not free, so they draw none. The waiting pill is packed into its blocker's
 * lane when it fits there, and the arrow is drawn only when it did (an arrow in another lane would point from nothing).
 *
 * ONE ACCESSIBLE NAME PER ROW. A row's first lane is `role="img"` named "<row>: N completed, N failed, N running, N in
 * line" (plus the cancelled, refused, awaiting-input and slot-holding counts when there are any), counting every item,
 * drawn or not; the row's further lanes are `aria-hidden`, since naming each again would repeat the row.
 *
 * IMPORTS `html.mjs`, `kit.mjs` AND `words.mjs` ONLY (all three pure), so the words below are this module's own: the
 * outcome words are `words.mjs`'s and the buckets the worker's `defer-reasons.mjs` leaf's, and the timeline test holds
 * each table to its source. An ended run's word is read through `words.mjs` `outcomeWord` itself (issue #737), so a
 * reason that changes a run's word changes it here too.
 */
import { html } from "./html.mjs";
import { icon, ptag, schedulerRunOf, svgNum } from "./kit.mjs";
import { outcomeWord } from "../words.mjs";

/**
 * The zooms (`?zoom=`): how far back the window reaches, how far ahead, and the axis's tick. Now sits at
 * `pastMs / (pastMs + futureMs)` of the lane: two thirds at every zoom (the 24 hours look 12 hours ahead).
 */
export const TIMELINE_ZOOMS = Object.freeze({
  "1h": Object.freeze({ pastMs: 3_600_000, futureMs: 1_800_000, tickMs: 600_000 }),
  "3h": Object.freeze({ pastMs: 10_800_000, futureMs: 5_400_000, tickMs: 1_800_000 }),
  "24h": Object.freeze({ pastMs: 86_400_000, futureMs: 43_200_000, tickMs: 14_400_000 }),
});

/**
 * The groupings (`?rows=`): a row per project (the record's project, what money and limits were charged to) or per
 * host.
 */
export const TIMELINE_ROWS = Object.freeze(["project", "host"]);

/** What an overview with no `?rows=` or `?zoom=` draws. */
export const TIMELINE_DEFAULTS = Object.freeze({ rows: "project", zoom: "3h" });

/** The most lanes one row draws; the items that fit in none are counted in the row's `more`. */
export const TIMELINE_LANES_MAX = 4;

/** The most rows the timeline draws; the rest are counted in one line (`rowsMore`). */
export const TIMELINE_ROWS_MAX = 12;

/** The most project chips the model gives; the rest are counted (`chipsMore`). */
export const TIMELINE_CHIPS_MAX = 24;

/** The item kinds, in the order a row over its lane cap is packed (see the header): quiet completed runs last. */
export const TIMELINE_KINDS = Object.freeze(["run", "held", "parked", "failed", "refused", "wait", "ok"]);

/**
 * The words the timeline says of an ended run, each `words.mjs`'s (`OUTCOME_WORDS`, `REASON_WORDS`), pinned there by
 * the timeline test. `unknown` is a record whose outcome is not one of the three the record contract names, drawn as a
 * failure, as every surface draws one.
 */
export const TIMELINE_WORDS = Object.freeze({
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
  refused: "refused",
  parked: "awaiting input",
  unknown: "outcome not known",
});

/**
 * Each waiting bucket's glyph and words: `short` is the pill's own line, `word` the line of a pill too narrow for it
 * and, with its due time, of a pill moved left of its due (every waiting pill holds its word: its name gives way
 * first), `long` its title's. Each glyph is its
 * bucket's alone: the waitlist bar draws a bucket as its glyph and a count, with no word to tell two glyphs apart. The
 * keys are the worker leaf's `DEFER_BUCKETS`, pinned by the timeline test, so a bucket added there fails here until it
 * has words. The sprite has no overdue clock and no question mark of its own, so `due` has the bell (its time came and
 * nothing answered; the clock is `check`'s) and `unknown` the tag (a reason recorded as a token: the sprite's one
 * question mark is the parked run's, which waits for a person, not in line).
 */
export const TIMELINE_WAIT_WORDS = Object.freeze({
  slot: Object.freeze({ glyph: "slot", short: "needs a free slot", word: "slot", long: "waits for a free slot" }),
  run: Object.freeze({ glyph: "chain", short: "after another run", word: "after run", long: "waits for another run to finish" }),
  check: Object.freeze({ glyph: "clock", short: "held on a check", word: "check", long: "waits on a time or a check" }),
  retry: Object.freeze({ glyph: "rerun", short: "retry backoff", word: "retry", long: "waits to retry" }),
  pause: Object.freeze({ glyph: "pause", short: "pause window", word: "window", long: "waits out a pause window" }),
  ready: Object.freeze({ glyph: "hourglass", short: "host getting ready", word: "not ready", long: "waits for its host to get ready" }),
  paused: Object.freeze({ glyph: "queue", short: "queue paused", word: "paused", long: "its queue is paused" }),
  due: Object.freeze({ glyph: "bell", short: "due, not taken", word: "due", long: "due, and no worker has taken it" }),
  unknown: Object.freeze({ glyph: "tag", short: "unknown reason", word: "unknown", long: "a reason this console does not know" }),
  none: Object.freeze({ glyph: "info", short: "no reason recorded", word: "no reason", long: "no reason was recorded" }),
});

/**
 * What the band over the rows says on each side of now, and what the axis says its times are (UTC text, see the
 * header).
 */
export const TIMELINE_BAND = Object.freeze({ past: "Ran and running", future: "In line", axis: "UTC" });

/** A parked run's tail words. */
export const PARKED_TAIL_TEXT = "waiting for you";

/** The row of the runs and jobs that carry no project, last in the project grouping. */
export const NO_PROJECT_TEXT = "no project";

/** The row of the jobs in the shared queue, which any host may take, last in the host grouping. */
export const ANY_HOST_TEXT = "any host";

/**
 * The row of what ran or runs on a host the record or the registry did not name, when it is not only shared-queue work.
 */
export const HOST_NOT_KNOWN_TEXT = "host not known";

// ---- geometry -------------------------------------------------------------------------------------------------------

/** The narrowest lane, in px: `.tl` at its 720 px minimum, less the 124 px row heads (see the header). */
const TRACK_PX = 596;
/** A lane's height and its pill's place in it, as the card draws them. */
const LANE_H = 44;
const BAND_H = 24;
const PILL_Y = 9;
const PILL_H = 26;
const PILL_RX = 13;
const TEXT_Y = 27;
const MID_Y = 22;
const TAIL_Y = 28;
const TAIL_TEXT_Y = 20;
/** The refusal marker's radius, px. */
const REF_R = 12;
/** The narrowest pill drawn, in percent of the lane (about 12 px at `TRACK_PX`). */
const PILL_MIN_PCT = 2;
/** How far right of now a waiting pill that is due now starts, so the arrow or gap before it shows (the card's). */
const WAIT_LEAD_PCT = 1.5;
/**
 * The room a waiting pill's label keeps before the pill's end, px: the pill's rounded end bends in by about 1 px where
 * the label's letters are (12 px text in a 26 px pill), its dashed stroke is 1.5 px, and 4 px is left clear of both.
 * The label's own estimate (`sansPx`) is never under what Chrome draws, so this is room and not a guess.
 */
const WAIT_END_PX = 6;
/** The space kept between two items in one lane, percent. */
const PAD_PCT = 0.6;
/** An axis time this close to now is not written, since the now cap sits there (46 px wide); percent. */
const CAP_CLEAR_PCT = 7;
/** An axis time this close to either end is not written, since it would run past the lane; percent. */
const EDGE_CLEAR_PCT = 3;
/**
 * Estimated px per character, measured in Chrome over the system font stack and taken a little high: the mono id face
 * (12 px, 600: 7.2), a refusal's sans label (12 px, 650: 6.7) and the tail's (11 px, 650: 5.5), each one fixed face
 * whose text varies little. A label judged by them fits with a little room on another platform's fonts too.
 */
const MONO_PX = 7.3;
const REF_PX = 6.9;
const TAIL_PX = 5.8;
/**
 * The sans sub line's characters (12 px, at 500 or 600), px: one width per class, each the widest Chrome draws of its
 * class at either weight over the system stack, so a line is never estimated narrower than it is drawn: thin (`i`,
 * `l`, a space, most punctuation: 3.2 to 4.1), narrow (`f r t ( ) -`: 4.6 to 5.8), the narrower lowercase letters (6.5
 * to 7.1), the rest of them and the digits (tabular, 7.9 each), `w` (9.9), capitals (to 9.4), `m M @` (to 11.1) and
 * `W` (12.0), which is also what any other character is taken as. One average for every character, as the other faces
 * have, was wrong both ways on these lines: at 6.1 "pause window" (82.1 px, 6.8 a character) touched its pill's dashed
 * end, and any average high enough for a short word of wide letters ("unknown", 7.4 a character) pushed lines of narrow
 * ones ("needs this slot", 5.6) out of pills they fit with room to spare.
 */
const SANS_CLASSES = Object.freeze([
  [/[ijlI .,:;'!|/]/, 4.1],
  [/[frt()-]/, 5.8],
  [/w/, 9.9],
  [/[mM@]/, 11.1],
  [/[acekvsxyz]/, 7.1],
  [/[a-z0-9#_]/, 7.9],
  [/[A-LN-VX-Z]/, 9.4],
]);
const SANS_WIDE_PX = 12;
/** `SANS_CLASSES` as a table of the printable ASCII characters, by code. */
const SANS_ASCII = Object.freeze(Array.from({ length: 0x7f }, (_, code) => SANS_CLASSES.find(([re]) => re.test(String.fromCharCode(code)))?.[1] ?? SANS_WIDE_PX));
/** A sans sub line's estimated width, px (`SANS_CLASSES`). */
function sansPx(s) {
  let w = 0;
  for (let k = 0; k < s.length; k += 1) w += SANS_ASCII[s.charCodeAt(k)] ?? SANS_WIDE_PX;
  return w;
}
/** The longest id a pill writes; a longer one is cut with an ellipsis (its title carries it whole). */
const ID_LABEL_MAX = 14;
/**
 * The name a waiting pill is placed to hold, in characters with the ellipsis (`WAIT_START_X`): a job's id whole, as the
 * console names its jobs (`gh-71b2`, `local-9e20`, `gh-e802.r1`), a longer name cut to its first nine. Cut shorter,
 * every local job read "local-…"; placed to hold the whole name (up to `ID_LABEL_MAX`), a pill due late in the window
 * was moved left a name's width more. Held as this many characters whatever the name, so a shorter name never moves its
 * pill's start (see `WAIT_START_X`).
 */
const WAIT_NAME_MIN = 10;
/** Where a waiting pill's label starts inside it, px: the glyph's 14 px at 9 px, and 5 px after it (the card's). */
const WAIT_GLYPH_PX = 28;
/** The longest repository name a row head writes, and how many it writes. */
const REPO_LABEL_MAX = 28;
const REPOS_SHOWN = 2;

const pct = (px) => (px / TRACK_PX) * 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** A percent as the card writes it: two decimals, clamped to the lane. */
const pc = (v) => svgNum(v, 0, 100, 2);

// ---- words ----------------------------------------------------------------------------------------------------------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A duration in the console's words (`45s`, `12m`, `3h 5m`, `2d 4h`), as `panels/common.mjs` `ageText` writes it. */
function durText(ms) {
  const v = Math.max(0, ms);
  if (v < MIN) return `${Math.floor(v / SEC)}s`;
  if (v < HOUR) return `${Math.floor(v / MIN)}m`;
  if (v < DAY) return `${Math.floor(v / HOUR)}h ${Math.floor((v % HOUR) / MIN)}m`;
  return `${Math.floor(v / DAY)}d ${Math.floor((v % DAY) / HOUR)}h`;
}

/** An instant's UTC `HH:MM`. */
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/**
 * An instant in a title: `HH:MM` on now's UTC day, else with its date, so a 24-hour window's yesterday reads as one.
 */
function whenText(ms, nowMs) {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10) ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** A string cut to `max` code points with an ellipsis, so a cut never splits a surrogate pair. */
function cut(s, max) {
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join("")}…`;
}

/** The id a pill writes. */
const idLabel = (id) => cut(id, ID_LABEL_MAX);

/** A label's estimated width in px: the id in the mono face, then the sub line after a gap. */
const labelPx = (id, sub = null, gap = 8) => id.length * MONO_PX + (sub === null ? 0 : gap + sansPx(sub));

/** The repository a target names (`owner/repo#12` and `owner/repo!3` are `owner/repo`); a local target is itself. */
function repoOf(target) {
  const m = /^(.+?)[#!]\d+$/.exec(target);
  return m ? m[1] : target;
}

/** A row's repositories, most runs first: at most `REPOS_SHOWN`, a second of the same owner without its owner. */
function reposText(targets) {
  const seen = new Map();
  for (const t of targets) {
    const r = repoOf(t);
    seen.set(r, (seen.get(r) ?? 0) + 1);
  }
  if (seen.size === 0) return null;
  const order = [...seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([r]) => r);
  const first = order[0];
  const owner = first.includes("/") ? first.slice(0, first.indexOf("/") + 1) : null;
  const shown = order.slice(0, REPOS_SHOWN).map((r, i) => cut(i > 0 && owner !== null && r.startsWith(owner) ? r.slice(owner.length) : r, REPO_LABEL_MAX));
  const rest = order.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? `, ${rest} more` : ""}`;
}

// ---- inputs ---------------------------------------------------------------------------------------------------------

const str = (v) => (typeof v === "string" && v !== "" ? v : null);
const ms = (v) => (Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
/** A host queue's host (`pi-jobs@build3`), or null for the shared queue. */
function hostOfQueue(queue) {
  const m = typeof queue === "string" ? /^[^@]+@([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(queue) : null;
  return m ? m[1] : null;
}

/**
 * The zoom asked for: a key of `TIMELINE_ZOOMS`, the default for none, a throw for anything else (pages.mjs refuses it
 * first).
 */
function zoomOf(zoom) {
  const z = zoom ?? TIMELINE_DEFAULTS.zoom;
  if (typeof z !== "string" || !Object.hasOwn(TIMELINE_ZOOMS, z)) throw new RangeError(`timeline: unknown zoom ${JSON.stringify(zoom)} (one of ${Object.keys(TIMELINE_ZOOMS).join(", ")})`);
  return z;
}

/** The grouping asked for: one of `TIMELINE_ROWS`, the default for none, a throw for anything else. */
function rowsOf(rows) {
  const r = rows ?? TIMELINE_DEFAULTS.rows;
  if (!TIMELINE_ROWS.includes(r)) throw new RangeError(`timeline: unknown grouping ${JSON.stringify(rows)} (one of ${TIMELINE_ROWS.join(", ")})`);
  return r;
}

// ---- the model ------------------------------------------------------------------------------------------------------

/**
 * The timeline of one instant: `{ now, zoom, by, project, start, end, nowX, nowLabel, axis, rows, chips, empty }`.
 *
 *   - `now` (ms) is the instant the page is drawn at; `zoom` a key of `TIMELINE_ZOOMS` and `rows` one of
 *     `TIMELINE_ROWS` (null for the defaults); `project` the `?project=` filter, or null for every project.
 *   - `runs`: `snapshot.runsDay.runs` (the day's records as `dayRunOf` rebuilds them; the `runsDay` object is taken
 *     too). `active`: `snapshot.active`. `hostJobs`: `snapshot.hostBudgets` (each `{ name, jobs }`). `waiting`:
 *     `snapshot.waiting` (`readWaiting`'s `{ rows }`; `{ unreachable: true }` or null draw no waiting job). `parked`:
 *     `snapshot.parked` (unanswered parks; an entry marked `answered` is left out, and one may carry its `project`).
 *
 * Returns `start`/`end` (ms), `nowX` and every `x`/`w` as percent strings (`svgNum`, two decimals), `axis` as `[{ x,
 * label }]` (a tick whose time is not written, beside now or an end, has a null label), and `rows` as `[{ key, label,
 * tag, sub, lanes, counts, more }]`: `key` the project id or host name (null for the "no project", "any host" or "host
 * not known" row), `tag` how the head draws `label` (`project`, `host` or null), `lanes` at most `TIMELINE_LANES_MAX`
 * lists of items in drawing order, `counts` every item of the row by what it is, and `more` how many fit in no lane;
 * at most `TIMELINE_ROWS_MAX` rows, and `rowsMore` `{ rows, items }` the rows left out and the items they hold.
 * `chips` is `[{ project, count, on }]` over the projects in the window, before the filter, plus the filtered one when
 * it has nothing (count 0), so a page can always offer the way back: at most `TIMELINE_CHIPS_MAX`, the filtered one
 * always among them, and `chipsMore` `{ projects, count }` the projects left out and their items. `empty` is true when
 * no row is drawn.
 *
 * An item is `{ kind, jobId, target, project, host, word, startAt, endAt, x, w, pill, title, label, dep, depX, tailX,
 * tailText, glyph, bucket }`: `kind` one of `TIMELINE_KINDS`; `label` `{ text, sub, side }` with `side` `in`, `before`
 * or `after` its pill, or null; `dep` `arrow` (from `depX`) or `gap` (from now) for a waiting job, else null; `tailText`
 * a park's words over its tail (from `tailX`), null where they would reach now (its label carries them then, or
 * nothing does) and for every other kind.
 */
export function timelineModel({ now, zoom = null, rows = null, project = null, runs = [], active = [], hostJobs = [], waiting = null, parked = [] } = {}) {
  if (!Number.isFinite(now)) throw new TypeError(`timeline: now is an instant in ms, not ${JSON.stringify(now)}`);
  const zoomKey = zoomOf(zoom);
  const by = rowsOf(rows);
  const filter = str(project);
  const z = TIMELINE_ZOOMS[zoomKey];
  const span = z.pastMs + z.futureMs;
  const start = now - z.pastMs;
  const end = now + z.futureMs;
  const xOf = (t) => clamp(((t - start) / span) * 100, 0, 100);
  const nowX = (z.pastMs / span) * 100;

  const items = collect({ now, start, runs, active, hostJobs, waiting, parked });
  const { chips, chipsMore } = chipsOf(items, filter);
  const shown = filter === null ? items : items.filter((i) => i.project === filter);
  const { rows: grouped, rowsMore } = groupRows(shown, by);
  const rowList = grouped.map((row) => layRow(row, { by, now, start, nowX, xOf }));

  const axis = [];
  for (let t = Math.ceil(start / z.tickMs) * z.tickMs; t <= end; t += z.tickMs) {
    const x = xOf(t);
    const hidden = Math.abs(x - nowX) < CAP_CLEAR_PCT || x < EDGE_CLEAR_PCT || x > 100 - EDGE_CLEAR_PCT;
    axis.push({ x: pc(x), label: hidden ? null : hhmm(t) });
  }

  return {
    now,
    zoom: zoomKey,
    by,
    project: filter,
    start,
    end,
    nowX: pc(nowX),
    nowLabel: hhmm(now),
    axis,
    rows: rowList,
    rowsMore,
    chips,
    chipsMore,
    empty: rowList.length === 0,
  };
}

/**
 * Every item of the window, before any filter or grouping, as `{ kind, jobId, target, project, host, word, startAt,
 * endAt, ... }` with times in ms (`endAt` null for a waiting job, which has no end yet). What ended before the window's
 * start is left out.
 */
function collect({ now, start, runs, active, hostJobs, waiting, parked }) {
  const records = list(Array.isArray(runs) ? runs : runs?.runs).filter((r) => str(r?.jobId) !== null);
  const recordOf = new Map();
  for (const r of records) if (!recordOf.has(r.jobId)) recordOf.set(r.jobId, r);

  // The registry's jobs, host by host in name order, so a job two rows list is read from the same one on every tick.
  const live = new Map();
  const orphans = [];
  const hosts = list(hostJobs).filter((h) => str(h?.name) !== null).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const h of hosts) {
    for (const j of list(h.jobs)) {
      const id = str(j?.id);
      if (id === null || live.has(id)) continue;
      const entry = { id, host: h.name, project: str(j.p), at: ms(j.at), orphan: j.o === true || j.o === 1 };
      live.set(id, entry);
      if (entry.orphan) orphans.push(entry);
    }
  }
  const activeRows = list(active).filter((a) => str(a?.jobId) !== null);
  const activeIds = new Set(activeRows.map((a) => a.jobId));
  const unanswered = new Map();
  for (const p of list(parked)) if (str(p?.jobId) !== null && p.answered !== true && !unanswered.has(p.jobId)) unanswered.set(p.jobId, p);

  const out = [];
  const folded = new Set();

  for (const o of orphans) {
    if (activeIds.has(o.id)) continue;
    const rec = recordOf.get(o.id) ?? null;
    if (rec !== null) folded.add(o.id);
    const ended = rec === null ? null : ms(rec.endedAt) ?? ms(rec.startedAt);
    out.push({
      kind: "held",
      jobId: o.id,
      target: rec === null ? null : str(rec.target),
      project: o.project ?? (rec === null ? null : str(rec.project)),
      host: o.host,
      word: rec === null ? null : endedWord(rec),
      startAt: Math.min(o.at ?? now, now),
      endAt: now,
      endedAt: ended,
    });
  }

  for (const a of activeRows) {
    const reg = live.get(a.jobId) ?? null;
    const started = ms(a.startedAt) ?? reg?.at ?? now;
    out.push({ kind: "run", jobId: a.jobId, target: null, project: reg?.project ?? null, host: str(a.host) ?? reg?.host ?? null, word: "running", startAt: Math.min(started, now), endAt: now });
  }

  for (const r of records) {
    if (folded.has(r.jobId) || recordOf.get(r.jobId) !== r) continue;
    const s = ms(r.startedAt);
    const e = ms(r.endedAt);
    const endAt = Math.min(e ?? s ?? Number.NaN, now);
    if (!Number.isFinite(endAt)) continue;
    const startAt = Math.min(s ?? endAt, endAt);
    const base = { jobId: r.jobId, target: str(r.target), project: str(r.project), host: str(r.host), startAt, endAt };
    if (r.outcome === "completed" && r.reason === "awaiting-input") {
      if (unanswered.has(r.jobId)) {
        unanswered.delete(r.jobId);
        out.push({ kind: "parked", ...base, word: TIMELINE_WORDS.parked });
        continue;
      }
      if (endAt < start) continue;
      out.push({ kind: "ok", ...base, word: TIMELINE_WORDS.completed, answered: true });
      continue;
    }
    if (endAt < start) continue;
    const word = endedWord(r);
    // The pill's kind by the word, as its title says it: a recovery end is a failure's pill, not a refusal's circle.
    const kind = word === TIMELINE_WORDS.completed || word === TIMELINE_WORDS.cancelled ? "ok" : word === TIMELINE_WORDS.refused ? "refused" : "failed";
    out.push({ kind, ...base, word, ...(kind === "refused" ? { startAt: endAt } : {}) });
  }

  // A park the day's records do not reach: still waited on, so drawn, from its instant, by what its row says.
  for (const p of unanswered.values()) {
    const at = Math.min(ms(p.parkedAt) ?? now, now);
    out.push({ kind: "parked", jobId: p.jobId, target: str(p.target), project: str(p.project), host: null, word: TIMELINE_WORDS.parked, startAt: at, endAt: at });
  }

  const waitRows = list(Array.isArray(waiting) ? waiting : waiting?.rows);
  for (const w of waitRows) {
    // Every row is in line, a scheduler's next run among them once it is overdue (`due`): the reader keeps the ones that
    // are only scheduled out of `rows`.
    if (str(w?.jobId) === null) continue;
    const bucket = typeof w.bucket === "string" && Object.hasOwn(TIMELINE_WAIT_WORDS, w.bucket) ? w.bucket : "none";
    const queueHost = hostOfQueue(w.queue);
    out.push({
      kind: "wait",
      jobId: w.jobId,
      target: null,
      project: str(w.project),
      host: str(w.host) ?? queueHost,
      shared: str(w.host) === null && queueHost === null,
      word: "in line",
      startAt: Math.max(ms(w.dueAt) ?? now, now),
      endAt: null,
      bucket,
      why: str(w.why),
      known: w.known === true,
      dueAt: ms(w.dueAt),
      untilAt: ms(w.untilAt),
      // Past its due, a job waits on nothing its record names (the reader's `due`, whatever it recorded): no blocker.
      holder: bucket === "due" ? null : str(w.holder),
      attempt: Number.isSafeInteger(w.attempt) ? w.attempt : null,
      attempts: Number.isSafeInteger(w.attempts) ? w.attempts : null,
      queue: str(w.queue),
      scheduled: schedulerRunOf(w.jobId),
    });
  }
  return out;
}

/** The console status `outcomeWord` gives an ended record, as the timeline says it (`TIMELINE_WORDS`). */
const WORD_OF_STATUS = Object.freeze({ ok: TIMELINE_WORDS.completed, parked: TIMELINE_WORDS.parked, cancelled: TIMELINE_WORDS.cancelled, refused: TIMELINE_WORDS.refused, failed: TIMELINE_WORDS.failed });

/**
 * An ended record's word: `words.mjs` `outcomeWord`'s status for its outcome and reason, as `TIMELINE_WORDS` says it, so
 * a recovery end (recorded `policy`) is failed here as everywhere; an outcome the record contract does not name is
 * unknown. A map of the raw values instead would call every `policy` record but an operator's cancel refused, a
 * recovery end included.
 */
function endedWord(r) {
  const w = outcomeWord(r.outcome, r.reason);
  return w.known && Object.hasOwn(WORD_OF_STATUS, w.status) ? WORD_OF_STATUS[w.status] : TIMELINE_WORDS.unknown;
}

/** Each kind's packing rank (`TIMELINE_KINDS`' order). */
const RANK = Object.freeze(Object.fromEntries(TIMELINE_KINDS.map((k, i) => [k, i])));

/** Name order, the null key (the keyless row) last. */
const byKey = (a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0);

/**
 * Each key's items counted, `Map(key -> { key, rank, n })`: `rank` its most pressing item's (`TIMELINE_KINDS`), `n` how
 * many. An item whose key is null is left out with `skipNull`.
 */
function statsBy(items, keyOf, skipNull = false) {
  const out = new Map();
  for (const i of items) {
    const key = keyOf(i);
    if (key === null && skipNull) continue;
    const b = out.get(key);
    if (b === undefined) out.set(key, { key, rank: RANK[i.kind], n: 1 });
    else {
      b.rank = Math.min(b.rank, RANK[i.kind]);
      b.n += 1;
    }
  }
  return out;
}

/**
 * The keys a bounded list keeps (see the header), with what it leaves out: `{ kept, cut: { keys, n } }`. At most `max`,
 * the most pressing first, then the most items, then by name; `keep` (a key that must be among them) takes the last
 * place when it would not have one. `kept` is in name order, the null key last.
 */
function keptKeys(stats, max, keep = undefined) {
  const kept = firstOf(stats.values(), max, (a, b) => a.rank - b.rank || b.n - a.n || byKey(a.key, b.key)).first.map((e) => e.key);
  if (keep !== undefined && !kept.includes(keep)) kept.splice(Math.min(kept.length, max - 1), 1, keep);
  const shown = new Set(kept);
  const cut = { keys: 0, n: 0 };
  for (const b of stats.values()) {
    if (shown.has(b.key)) continue;
    cut.keys += 1;
    cut.n += b.n;
  }
  return { kept: kept.sort(byKey), cut };
}

/**
 * The project chips: the projects the window holds, by name, each with how many items it has, and the filtered one
 * always (with 0 when it has none); at most `TIMELINE_CHIPS_MAX`, the rest counted in `chipsMore`.
 */
function chipsOf(items, filter) {
  const stats = statsBy(items, (i) => i.project, true);
  const { kept, cut } = keptKeys(stats, TIMELINE_CHIPS_MAX, filter ?? undefined);
  const chips = kept.map((p) => ({ project: p, count: stats.get(p)?.n ?? 0, on: p === filter }));
  return { chips, chipsMore: { projects: cut.keys, count: cut.n } };
}

/**
 * The rows of a grouping, by key in name order, the keyless row last: at most `TIMELINE_ROWS_MAX`, the rest counted in
 * `rowsMore`. Only the rows drawn gather their items, labels and repositories.
 */
function groupRows(items, by) {
  const keyOf = (i) => (by === "project" ? i.project : i.host);
  const { kept, cut } = keptKeys(statsBy(items, keyOf), TIMELINE_ROWS_MAX);
  const gathered = new Map(kept.map((key) => [key, []]));
  for (const i of items) gathered.get(keyOf(i))?.push(i);
  const rowsMore = { rows: cut.keys, items: cut.n };
  const rows = kept.map((key) => {
    const its = gathered.get(key);
    let label;
    if (key !== null) label = key;
    else if (by === "project") label = NO_PROJECT_TEXT;
    else label = its.every((i) => i.kind === "wait" && i.shared) ? ANY_HOST_TEXT : HOST_NOT_KNOWN_TEXT;
    const targets = its.map((i) => i.target).filter((t) => t !== null);
    return { key, label, tag: key === null ? null : by, sub: by === "project" ? reposText(targets) : null, items: its };
  });
  return { rows, rowsMore };
}

/** Deterministic order: by `a` then the job id. */
const byThenId = (d, a, b) => d || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0);

/**
 * Lanes for a row's shaped items, at most `TIMELINE_LANES_MAX` of them: `{ placed: Map(item -> { lane, v }), lanes,
 * more }`. Each item tries its blocker's lane first (a waiting job beside what it waits on), then every lane in order,
 * with each of its labelled placements; then a new lane while under the cap; then, with the lanes full, its placement
 * without a label; else it is counted in `more`. With `fit` (the first pass) nothing is placed without its label or
 * counted: the first item with no labelled place returns null, since the row must be packed again by rank.
 */
function pack(order, { fit = false } = {}) {
  const lanes = [];
  const placed = new Map();
  let more = 0;
  const fits = (lane, v) => lane.every((o) => !(v.e0 < o.e1 && o.e0 < v.e1));
  const put = (s, lane, v) => {
    while (lanes.length <= lane) lanes.push([]);
    lanes[lane].push(v);
    placed.set(s, { lane, v });
  };
  for (const s of order) {
    const holderLane = s.holder === null ? null : placed.get(s.holder)?.lane ?? null;
    const tries = holderLane === null ? lanes.map((_, i) => i) : [holderLane, ...lanes.map((_, i) => i).filter((i) => i !== holderLane)];
    const pick = (variants) => {
      for (const lane of tries) for (const v of variants) if (fits(lanes[lane], v)) return { lane, v };
      return null;
    };
    const got = pick(s.variants) ?? (lanes.length < TIMELINE_LANES_MAX ? { lane: lanes.length, v: s.variants[0] } : fit || s.bare === null ? null : pick([s.bare]));
    if (got !== null) {
      put(s, got.lane, got.v);
      continue;
    }
    if (fit) return null;
    more += 1;
  }
  return { placed, lanes: lanes.length, more };
}

/**
 * One row's geometry, words and lanes. Packed first by start, the fewest lanes, and kept when that fits in
 * `TIMELINE_LANES_MAX`; otherwise packed again by rank under the cap (see the header), so what is left out is the quiet
 * part of the row.
 */
function layRow(row, ctx) {
  const { now, nowX } = ctx;
  const shaped = row.items.filter((i) => i.kind !== "wait").map((i) => shape(i, ctx));
  const byId = new Map(shaped.map((s) => [s.jobId, s]));
  // The slot a job waiting for its full host waits on: the oldest held slot on that host, found once for the row.
  const heldOn = new Map();
  for (const o of shaped) {
    if (o.kind !== "held") continue;
    const first = heldOn.get(o.src.host);
    if (first === undefined || byThenId(o.src.startAt - first.src.startAt, o, first) < 0) heldOn.set(o.src.host, o);
  }
  // Each waiting job's blocker on this row, if it has one (see the header): what it waits on, drawn left of now.
  const blockerOf = (i) => {
    let holder = i.holder !== null && i.holder !== i.jobId ? byId.get(i.holder) ?? null : null;
    if (holder === null && i.bucket === "slot" && (i.why === "host-slot" || i.why === "host-budget") && i.host !== null) holder = heldOn.get(i.host) ?? null;
    return holder;
  };
  // Among equals, a job that waits on something on this row goes first, so it reaches its blocker's lane before a job
  // that waits on nothing here takes that lane.
  const dependent = (a, b) => (a.holder === null ? 1 : 0) - (b.holder === null ? 1 : 0);
  // Every waiting job takes a lane of its own right of now, so at most `TIMELINE_LANES_MAX` are drawn: the first by
  // `dependent`, as both passes take them, then the next to start (its due, or now for one already due), then the id.
  // The rest are counted, never shaped or packed (see the header), and with more than the lanes hold the first pass
  // cannot fit the row. By the id alone, a queue's four lowest ids were drawn and the job due in a minute was counted.
  const waits = firstOf(
    row.items.filter((i) => i.kind === "wait").map((i) => ({ i, holder: blockerOf(i), jobId: i.jobId })),
    TIMELINE_LANES_MAX,
    (a, b) => byThenId(dependent(a, b) || a.i.startAt - b.i.startAt, a, b),
  );
  for (const w of waits.first) {
    const s = shape(w.i, ctx);
    s.holder = w.holder;
    shaped.push(s);
  }
  const byStart = waits.cut > 0 ? null : [...shaped].sort((a, b) => byThenId(a.variants[0].e0 - b.variants[0].e0 || dependent(a, b) || RANK[a.kind] - RANK[b.kind], a, b));
  let packed = byStart === null ? null : pack(byStart, { fit: true });
  if (packed === null) {
    const byRank = [...shaped].sort((a, b) => byThenId(RANK[a.kind] - RANK[b.kind] || dependent(a, b) || a.variants[0].e0 - b.variants[0].e0, a, b));
    packed = pack(byRank);
  }
  const lanes = Array.from({ length: packed.lanes }, () => []);
  for (const s of shaped) {
    const got = packed.placed.get(s);
    if (got === undefined) continue;
    s.lane = got.lane;
    s.label = got.v.label;
    s.tailText = got.v.tail;
    lanes[got.lane].push(s);
  }
  // A waiting job's lead: the arrow from its blocker when the two share a lane, else the gap to a due time to come.
  for (const s of shaped) {
    if (s.kind !== "wait" || s.lane === undefined) continue;
    if (s.holder !== null && s.holder.lane === s.lane) {
      s.dep = "arrow";
      s.depX = s.holder.x1;
    } else if (s.src.dueAt !== null && s.src.dueAt > now) {
      s.dep = "gap";
      s.depX = nowX;
    }
    s.label = waitLabel(s, now);
  }
  const counts = { completed: 0, cancelled: 0, failed: 0, refused: 0, parked: 0, running: 0, held: 0, waiting: 0 };
  for (const i of row.items) counts[countOf(i)] += 1;
  return {
    key: row.key,
    label: row.label,
    tag: row.tag,
    sub: row.sub,
    lanes: lanes.map((lane) => lane.sort((a, b) => byThenId(a.x0 - b.x0, a, b)).map(itemOut)),
    counts,
    more: packed.more + waits.cut,
  };
}

/**
 * The first `k` of `list` by `cmp`, in that order, and how many are left out: `{ first, cut }`. One pass that keeps the
 * `k` best seen, where sorting a queue of thousands to take four was most of a tick.
 */
function firstOf(list, k, cmp) {
  const first = [];
  let n = 0;
  for (const x of list) {
    n += 1;
    if (first.length === k && cmp(x, first[k - 1]) >= 0) continue;
    let at = first.length;
    while (at > 0 && cmp(x, first[at - 1]) < 0) at -= 1;
    first.splice(at, 0, x);
    if (first.length > k) first.pop();
  }
  return { first, cut: n - first.length };
}

/** Which count an item adds to. */
function countOf(i) {
  if (i.kind === "ok") return i.word === TIMELINE_WORDS.cancelled ? "cancelled" : "completed";
  if (i.kind === "failed") return "failed";
  if (i.kind === "refused") return "refused";
  if (i.kind === "parked") return "parked";
  if (i.kind === "run") return "running";
  if (i.kind === "held") return "held";
  return "waiting";
}

/** A pill's ends in percent: at least `PILL_MIN_PCT` apart, widened toward the past when it may not pass `hi`. */
function widen(x0, x1, hi) {
  if (x1 - x0 >= PILL_MIN_PCT) return [x0, x1];
  const right = x0 + PILL_MIN_PCT;
  return right <= hi ? [x0, right] : [Math.max(0, hi - PILL_MIN_PCT), hi];
}

/**
 * A placement: the label, a park's tail words (`tail`, null for none), and the space the item takes in a lane, the gap
 * to the next item included.
 */
const placement = (label, e0, e1, tail = null) => ({ label, tail, e0, e1: e1 + PAD_PCT });

/**
 * One item's geometry and words (percent numbers while packing): its pill `x0`..`x1`, its title (a function: the words
 * and the times are worked out for a drawn item alone), and its placements,
 * `variants` (each a label and the space it takes, `e0`..`e1`, the label and a tail included; the first preferred)
 * and `bare` (the same item without a label, which packing takes only when the lanes are full; null when the item has
 * no label to give up, or must keep it). A label of an ended run never passes now: right of now is what is in line.
 */
function shape(i, { by, now, start, nowX, xOf }) {
  const s = { src: i, kind: i.kind, jobId: i.jobId, holder: null, dep: null, depX: null, tailX: null, tailText: null, pill: true, glyph: null, label: null, bare: null };
  const id = idLabel(i.jobId);
  const target = i.target ? ` ${i.target}` : "";
  if (i.kind === "refused") {
    const cx = xOf(i.startAt);
    s.x0 = cx;
    s.x1 = cx;
    s.glyph = "refused";
    const text = `${id} ${i.word}`;
    const r = pct(REF_R);
    const w = pct(REF_R + 6 + text.length * REF_PX);
    s.variants = [];
    if (cx - w >= 0) s.variants.push(placement({ text, sub: null, side: "before" }, cx - w, cx + r));
    if (cx + w <= nowX) s.variants.push(placement({ text, sub: null, side: "after" }, cx - r, cx + w));
    s.bare = placement(null, cx - r, cx + r);
    if (s.variants.length === 0) s.variants.push(s.bare);
    s.title = () => `${i.jobId}${target}: refused at ${whenText(i.startAt, now)} UTC`;
    return s;
  }
  if (i.kind === "wait") {
    // ONE START RULE (see the header): its due time or its bucket's start (`WAIT_START_X`), whichever is earlier, and
    // never before the lead right of now (so the arrow or gap before it shows). Moved left of its due, its start is not
    // when it starts, so its label says when (`waitLabel`).
    const w = TIMELINE_WAIT_WORDS[i.bucket];
    const due = xOf(i.startAt);
    s.x0 = Math.max(nowX + WAIT_LEAD_PCT, Math.min(due, WAIT_START_X[i.bucket]));
    s.moved = s.x0 < due;
    s.x1 = 100;
    s.glyph = w.glyph;
    // From just after now: what ends at now (a running job, a held slot) keeps its lane for the job that waits on it.
    // Its label is chosen once its lead is known (`waitLabel`), and always fits the pill it is drawn in.
    s.variants = [placement(null, nowX + PAD_PCT, 100)];
    s.title = () => waitTitle(i, now);
    return s;
  }
  const [x0, x1] = widen(xOf(i.startAt), xOf(i.endAt), nowX);
  s.x0 = x0;
  s.x1 = x1;
  const inner = (px) => pct(px) <= x1 - x0;
  const own = (label) => placement(label, x0, x1);
  if (i.kind === "ok") {
    s.variants = [own(inner(12 + labelPx(id) + 8) ? { text: id, sub: null, side: "in" } : null)];
    s.title = () => `${i.jobId}${target}: ${i.answered ? `asked a question at ${whenText(i.endAt, now)} UTC, answered since` : `${i.word}, ${whenText(i.startAt, now)} to ${whenText(i.endAt, now)} UTC`}`;
  } else if (i.kind === "failed") {
    const lw = pct(8 + labelPx(id, i.word, 6));
    s.variants = [];
    if (x1 + lw <= nowX) s.variants.push(placement({ text: id, sub: i.word, side: "after" }, x0, x1 + lw));
    if (x0 - lw >= 0) s.variants.push(placement({ text: id, sub: i.word, side: "before" }, x0 - lw, x1));
    s.bare = own(null);
    if (s.variants.length === 0) s.variants.push(s.bare);
    s.title = () => `${i.jobId}${target}: ${i.word}, ${whenText(i.startAt, now)} to ${whenText(i.endAt, now)} UTC`;
  } else if (i.kind === "run") {
    const sub = by === "project" ? i.host : i.project;
    if (sub !== null && inner(12 + labelPx(id, sub) + 8)) s.variants = [own({ text: id, sub, side: "in" })];
    else if (inner(12 + labelPx(id) + 8)) s.variants = [own({ text: id, sub: null, side: "in" })];
    else {
      s.variants = [];
      const withSub = sub === null ? null : pct(8 + labelPx(id, sub, 6));
      const bare = pct(8 + labelPx(id));
      if (withSub !== null && x0 - withSub >= 0) s.variants.push(placement({ text: id, sub, side: "before" }, x0 - withSub, x1));
      if (x0 - bare >= 0) s.variants.push(placement({ text: id, sub: null, side: "before" }, x0 - bare, x1));
      s.bare = own(null);
      if (s.variants.length === 0) s.variants.push(s.bare);
    }
    s.title = () => `${i.jobId}: running${i.host ? ` on ${i.host}` : ""} since ${whenText(i.startAt, now)} UTC${i.host ? "" : ", host not known"}`;
  } else if (i.kind === "parked") {
    // A park that ended before the window has no pill in it: its tail alone runs from the window's start to now.
    s.pill = i.endAt >= start;
    if (!s.pill) {
      s.x0 = 0;
      s.x1 = 0;
    }
    s.tailX = s.x1;
    // Nothing of a park passes now (see the header). Its words go over its tail, as the card draws them, where they end
    // before now; else the id and the words before the pill, in the parked ink, the tail bare; else what fits (the id
    // in the pill, the words over the tail) and the title says the rest.
    const idIn = s.pill && inner(12 + labelPx(id) + 8) ? { text: id, sub: null, side: "in" } : null;
    const overTail = s.x1 + pct(6 + PARKED_TAIL_TEXT.length * TAIL_PX) <= nowX;
    const before = pct(8 + labelPx(id, PARKED_TAIL_TEXT, 6));
    s.variants = [];
    if (overTail && (idIn !== null || !s.pill)) s.variants.push(placement(idIn, s.x0, nowX, PARKED_TAIL_TEXT));
    if (s.pill && s.x0 - before >= 0) s.variants.push(placement({ text: id, sub: PARKED_TAIL_TEXT, side: "before" }, s.x0 - before, nowX));
    s.variants.push(placement(idIn, s.x0, nowX, overTail ? PARKED_TAIL_TEXT : null));
    s.title = () => `${i.jobId}${target}: awaiting input since ${whenText(i.endAt, now)} UTC`;
  } else if (i.kind === "held") {
    const ended = i.word !== null && Number.isFinite(i.endedAt);
    // "cancelled 10:59", but "ended 10:59" for a record whose outcome is not known: "outcome not known 10:59" read as
    // the outcome becoming unknown then. The title says the outcome is not known; on the pill, beside the rest of the
    // sentence, those words would not fit the narrowest lane's full-width pill.
    const unknown = i.word === TIMELINE_WORDS.unknown;
    const at = ended ? whenText(i.endedAt, now) : null;
    const sub = `${!ended ? "" : unknown ? `ended ${at}, ` : `${i.word} ${at}, `}still holds a ${i.host} slot`;
    let label = null;
    if (inner(14 + labelPx(id, sub) + 8)) label = { text: id, sub, side: "in" };
    else if (inner(14 + labelPx(id) + 8)) label = { text: id, sub: null, side: "in" };
    s.variants = [own(label)];
    s.title = () => ended ? `${i.jobId}${target}: ${unknown ? `ended at ${at} UTC, ${i.word}` : `${i.word} at ${at} UTC`}; still holds a ${i.host} slot` : `${i.jobId}: still holds a ${i.host} slot, since ${whenText(i.startAt, now)} UTC`;
  }
  return s;
}

/**
 * What a waiting pill names its job by, whole: a cron trigger's run by its trigger (`schedulerRunOf`), any other by its
 * id. A pill writes it cut (`waitLabel`); its title, whole.
 */
const waitNameOf = (i) => (i.scheduled === null ? i.jobId : i.scheduled.scheduler);

/** A waiting label's width in px, from the pill's start to its end: the glyph, the name, the line after a 6 px gap. */
const waitPx = (name, line) => WAIT_GLYPH_PX + labelPx(name, line, 6) + WAIT_END_PX;

/**
 * A due time in a waiting pill's words: its UTC `HH:MM`, as the axis writes its times, when it is within a day of now
 * (the next time the clock reads so), else how far off it is ("in 2d 4h"), which an `HH:MM` alone would put on the
 * wrong day.
 */
const dueWords = (at, now) => (at - now < DAY ? hhmm(at) : `in ${durText(at - now)}`);

/** A moved waiting pill's line: its bucket's word and its due time ("check 07:00"). */
const dueLine = (i, now) => `${TIMELINE_WAIT_WORDS[i.bucket].word} ${dueWords(i.startAt, now)}`;

/**
 * Each bucket's one start right of which no waiting pill of it stands (percent of the lane): where its glyph, a name of
 * `WAIT_NAME_MIN` characters, its word and a due time just fit before the window's end. One number per bucket, never
 * per pill: a start that hung on the pill's own name or its own time put a job due later left of one due before it
 * whose name or time was shorter (a seven-character id against a ten-character one; "in 2d 4h" against "07:00"). The
 * time is held as an `HH:MM` (every one is as wide: the digits are one class of `SANS_CLASSES`); a time more than a day
 * off is wider, and there the name gives way.
 */
const WAIT_START_X = Object.freeze(Object.fromEntries(Object.entries(TIMELINE_WAIT_WORDS).map(([b, w]) => [b, 100 - pct(waitPx("x".repeat(WAIT_NAME_MIN), `${w.word} 00:00`))])));

/** A waiting job's title: who it is, what it waits for, and when it is due. */
function waitTitle(i, now) {
  const w = TIMELINE_WAIT_WORDS[i.bucket];
  let what;
  if (i.bucket === "unknown" && i.why !== null) what = `${i.why}, no explanation yet`;
  else if (i.bucket === "due" && i.dueAt !== null) what = `due since ${whenText(i.dueAt, now)} UTC; no worker has taken it`;
  else if (i.bucket === "slot") what = i.host !== null ? `waits for a free slot on ${i.host}` : w.long;
  else if (i.bucket === "run") what = i.holder !== null ? `starts after ${i.holder}` : w.long;
  else if (i.bucket === "retry") what = i.attempt !== null && i.attempts !== null ? `attempt ${i.attempt} of ${i.attempts}` : w.long;
  else if (i.bucket === "pause" && (i.untilAt ?? i.dueAt) !== null) what = `in a pause window until ${whenText(i.untilAt ?? i.dueAt, now)} UTC`;
  else if (i.bucket === "ready" && i.host !== null) what = `waits for ${i.host} to get ready`;
  else if (i.bucket === "paused" && i.queue !== null) what = `its queue ${i.queue} is paused`;
  else what = w.long;
  const due = i.dueAt !== null && i.bucket !== "pause" && i.bucket !== "due" ? (i.dueAt > now ? `, due at ${whenText(i.dueAt, now)} UTC` : ", due now") : "";
  const unknownProject = i.project === null ? "; its project is not known until it starts" : "";
  const run = i.scheduled === null ? "" : ` (${i.scheduled.scheduler}, ${i.scheduled.at === null ? "a run" : `${whenText(i.scheduled.at, now)} UTC run`})`;
  return `${i.jobId}${run}: ${what}${due}${unknownProject}`;
}

/**
 * A waiting pill's own line, now that its lead is known. A pill at its due time: its name (up to `ID_LABEL_MAX`) and
 * the most its pill holds of what it waits for, the specific line (the blocker, the host, a time), else the bucket's
 * `short`, else its `word`. A pill moved left of its due (`shape`): its word and its due time (`dueLine`), since where
 * it starts is not when. Either way the last of those lines is always drawn, and where even it does not fit beside the
 * name, the name is what gives way, cut to what the pill leaves it (down to none, on a narrow future far from its due;
 * the title and the Waitlists card name it whole): a long name never takes the words that say what the job waits for.
 * A reason this console has no words for is its token, the specific line of the `unknown` bucket, whose words are true
 * of it where the token does not fit.
 */
function waitLabel(s, now) {
  const i = s.src;
  const w = TIMELINE_WAIT_WORDS[i.bucket];
  let sub;
  if (s.dep === "arrow") sub = i.bucket === "slot" ? "needs this slot" : "after this run";
  else if (i.scheduled !== null && i.scheduled.at !== null) sub = `${hhmm(i.scheduled.at)} run`;
  else if (i.bucket === "unknown" && i.why !== null) sub = i.why;
  else if (i.bucket === "due" && i.dueAt !== null) sub = `due since ${hhmm(i.dueAt)}`;
  else if (i.bucket === "retry" && i.dueAt !== null) sub = i.dueAt > now ? `retry in ${durText(i.dueAt - now)}` : "retry due now";
  else if (i.bucket === "slot" && i.host !== null) sub = `needs a ${i.host} slot`;
  else if (i.bucket === "run" && i.holder !== null) sub = `after ${idLabel(i.holder)}`;
  else if (i.bucket === "pause" && (i.untilAt ?? i.dueAt) !== null) sub = `paused until ${hhmm(i.untilAt ?? i.dueAt)}`;
  else if (i.bucket === "check" && i.dueAt !== null && i.dueAt > now) sub = `checks again in ${durText(i.dueAt - now)}`;
  else sub = w.short;
  const lines = s.moved ? [dueLine(i, now)] : [sub, w.short, w.word];
  const whole = waitNameOf(i);
  // The pill's width as `shape` set it, with a rounding's worth of room: a pill placed to hold its label just holds it.
  const width = s.x1 - s.x0 + 1e-9;
  const fits = (name, line) => pct(waitPx(name, line)) <= width;
  const name = idLabel(whole);
  for (const line of lines) if (fits(name, line)) return { text: name, sub: line, side: "in" };
  const last = lines[lines.length - 1];
  for (let k = Math.min(Array.from(whole).length, ID_LABEL_MAX) - 1; k >= 2; k -= 1) {
    if (fits(cut(whole, k), last)) return { text: cut(whole, k), sub: last, side: "in" };
  }
  return { text: "", sub: last, side: "in" };
}

/** An item as the model returns it: percent strings, no packing state. */
function itemOut(s) {
  const i = s.src;
  return {
    kind: s.kind,
    jobId: s.jobId,
    target: i.target,
    project: i.project,
    host: i.host,
    word: i.word,
    startAt: i.startAt,
    endAt: i.endAt,
    x: pc(s.x0),
    w: pc(s.x1 - s.x0),
    pill: s.pill,
    title: s.title(),
    label: s.label ?? null,
    dep: s.dep,
    depX: s.depX === null ? null : pc(s.depX),
    tailX: s.tailX === null ? null : pc(s.tailX),
    tailText: s.tailText,
    glyph: s.glyph,
    bucket: i.kind === "wait" ? i.bucket : null,
  };
}

// ---- the markup -----------------------------------------------------------------------------------------------------

/** What a row's first lane says to a screen reader: every item of the row, the four core counts always. */
function rowName(row) {
  const c = row.counts;
  const parts = [`${c.completed} completed`];
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`);
  parts.push(`${c.failed} failed`);
  if (c.refused > 0) parts.push(`${c.refused} refused`);
  if (c.parked > 0) parts.push(`${c.parked} awaiting input`);
  parts.push(`${c.running} running`);
  if (c.held > 0) parts.push(`${c.held} holding a slot`);
  parts.push(`${c.waiting} in line`);
  return `${row.label}: ${parts.join(", ")}`;
}

/** A pill: the rect, with its title. */
const rect = (cls, it) => html`<rect class="${cls}" x="${it.x}%" y="${PILL_Y}" width="${it.w}%" height="${PILL_H}" rx="${PILL_RX}"><title>${it.title}</title></rect>`;

/** Where a label's text starts, as the card writes it: `x` at the pill's start or end, `dx` its offset, the anchor. */
function labelAt(it, { inDx, outDx = 8 }) {
  const end = pc(Number(it.x) + Number(it.w));
  if (it.label.side === "in") return html`x="${it.x}%" dx="${inDx}" y="${TEXT_Y}"`;
  if (it.label.side === "after") return html`x="${end}%" dx="${outDx}" y="${TEXT_Y}"`;
  return html`x="${it.x}%" dx="-${outDx}" y="${TEXT_Y}" text-anchor="end"`;
}

/**
 * Each kind's label (`it.label`, `l`), drawn by `itemHtml` only for an item that has one: packing leaves an item with no
 * label where its row is crowded, and a kind with no label to fit has none (`shape`), so any kind can come without one
 * and is then its shape alone.
 */
const LABEL_HTML = Object.freeze({
  ok: (it, l) => html`<text class="tp-l" ${labelAt(it, { inDx: 12 })}>${l.text}</text>`,
  failed: (it, l) => html`<text class="tp-l tp-l--out-failed" ${labelAt(it, { inDx: 12 })}>${l.text}<tspan class="tp-sub3" dx="6">${l.sub}</tspan></text>`,
  refused: (it, l) => {
    const text = l.side === "before" ? html`x="${it.x}%" dx="-${REF_R + 6}" y="${TEXT_Y}" text-anchor="end"` : html`x="${it.x}%" dx="${REF_R + 6}" y="${TEXT_Y}"`;
    return html`<text class="tp-l tp-l--ref" ${text}>${l.text}</text>`;
  },
  run: (it, l) =>
    l.side === "in"
      ? html`<text class="tp-l tp-l--run" ${labelAt(it, { inDx: 12 })}>${l.text}${l.sub === null ? null : html`<tspan class="tp-sub" dx="8">${l.sub}</tspan>`}</text>`
      : html`<text class="tp-l tp-l--out-run" ${labelAt(it, { inDx: 12 })}>${l.text}${l.sub === null ? null : html`<tspan class="tp-sub2" dx="6">${l.sub}</tspan>`}</text>`,
  // Outside its pill the label is in the parked ink, the id and the tail's words, as a failure's is drawn.
  parked: (it, l) => (l.side === "in" ? html`<text class="tp-l tp-l--parked" ${labelAt(it, { inDx: 12 })}>${l.text}</text>` : html`<text class="tp-l tp-l--out-parked" ${labelAt(it, { inDx: 12 })}>${l.text}<tspan class="tp-sub3" dx="6">${l.sub}</tspan></text>`),
  held: (it, l) => html`<text class="tp-l tp-l--hold" ${labelAt(it, { inDx: 14 })}>${l.text}${l.sub === null ? null : html`<tspan class="tp-sub3" dx="8">${l.sub}</tspan>`}</text>`,
  wait: (it, l) => html`<text class="tp-l" ${labelAt(it, { inDx: WAIT_GLYPH_PX })}>${l.text}${l.sub === null ? null : html`<tspan class="tp-sub2" dx="6">${l.sub}</tspan>`}</text>`,
});

/** One item's SVG; `lead(it)` is a waiting job's line before its pill (`timelineHtml` draws it). */
function itemHtml(it, nowX, lead) {
  if (!Object.hasOwn(LABEL_HTML, it.kind)) throw new RangeError(`timeline: unknown item kind ${JSON.stringify(it.kind)}`);
  const label = it.label === null || it.label === undefined ? null : LABEL_HTML[it.kind](it, it.label);
  switch (it.kind) {
    case "ok":
      return html`${rect("tp--ok", it)}${label}`;
    case "failed":
      return html`${rect("tp--failed", it)}${label}`;
    case "refused":
      return html`<circle class="tp-ref" cx="${it.x}%" cy="${MID_Y}" r="${REF_R}"><title>${it.title}</title></circle><g transform="translate(-7 15)"><use class="tp-ref-g" href="#i-refused" x="${it.x}%" width="14" height="14"></use></g>${label}`;
    case "run":
      return html`${rect("tp--run", it)}${label}`;
    case "parked": {
      const tail = Number(it.tailX) < Number(nowX) ? (it.pill ? html`<line class="tail" x1="${it.tailX}%" x2="${nowX}%" y1="${TAIL_Y}" y2="${TAIL_Y}"/>` : html`<line class="tail" x1="${it.tailX}%" x2="${nowX}%" y1="${TAIL_Y}" y2="${TAIL_Y}"><title>${it.title}</title></line>`) : null;
      const words = it.tailText === null ? null : html`<text class="tail-t" x="${it.tailX}%" dx="6" y="${TAIL_TEXT_Y}">${it.tailText}</text>`;
      return html`${it.pill ? rect("tp--parked", it) : null}${label}${tail}${words}`;
    }
    case "held":
      return html`${rect("tp--held", it)}${label}`;
    default:
      // "wait", the one kind left of those `LABEL_HTML` names.
      return html`${lead(it)}${rect("tp--wait", it)}<g transform="translate(9 15)"><use class="tp-wait-g" href="#i-${it.glyph}" x="${it.x}%" width="14" height="14"></use></g>${label}`;
  }
}

/**
 * A row's head: its name (a project's tag, a host's name in the code face, or the keyless row's words) and its
 * repositories. The keyless row of the project grouping is a tag too, in the muted ink, so its head reads as the heads
 * above it do and as no project's. A name is cut to the heads' column by the page's rules (`page-css.mjs`, an ellipsis
 * where the browser measures it, which no estimate here could match on every font) and carries itself whole in its
 * `title`; the row's accessible name says it whole too.
 */
function headHtml(row, by) {
  let name;
  if (row.tag === "project") name = ptag(row.label, { title: row.label });
  else if (row.tag === "host") name = html`<span class="code" title="${row.label}">${row.label}</span>`;
  else name = by === "project" ? html`<span class="ptag"><span class="muted">${row.label}</span></span>` : html`<span class="muted">${row.label}</span>`;
  return html`${name}${row.sub === null ? null : html`<span class="tl__repo">${row.sub}</span>`}`;
}

/**
 * A model as the card's markup: the band ("Ran and running", "In line"), a head and an `svg.tl__r` per lane, then the
 * axis with the now cap, inside `.tl-wrap` (which scrolls inside its card on a phone), and after it, when any rows are
 * left out, the sentence that counts them (a `p.card__sub`, outside the scroll box). `label` names the whole timeline
 * for a screen reader ("Runs by project"). A model with no row draws the band and the axis alone; the page says why
 * beside it (`model.empty`).
 */
export function timelineHtml(model, { label } = {}) {
  if (typeof label !== "string" || label === "") throw new TypeError("timeline: the timeline is named (label)");
  const nowX = model.nowX;
  const future = pc(100 - Number(nowX));
  // A waiting job's lead (`dep`): the arrow from what it waits on (the sprite's `#arrow` marker), or the dotted gap to a
  // due time still to come.
  const lead = (it) => {
    if (it.dep === "arrow") return html`<line class="dep" x1="${it.depX}%" x2="${it.x}%" y1="${MID_Y}" y2="${MID_Y}" marker-end="url(#arrow)"/>`;
    return it.dep === "gap" ? html`<line class="gapline" x1="${it.depX}%" x2="${it.x}%" y1="${MID_Y}" y2="${MID_Y}"/>` : null;
  };
  const grid = (h) => html`<rect class="tl-future" x="${nowX}%" y="0" width="${future}%" height="${h}"/>${model.axis.map((t) => html`<line class="tg" x1="${t.x}%" x2="${t.x}%" y1="0" y2="${h}"/>`)}<line class="tnow" x1="${nowX}%" x2="${nowX}%" y1="0" y2="${h}"/>`;
  const band = html`<span></span><svg class="tl__r" height="${BAND_H}" aria-hidden="true"><rect class="tl-future" x="${nowX}%" y="0" width="${future}%" height="${BAND_H}"/><text class="tband" x="${nowX}%" dx="-10" y="16" text-anchor="end">${TIMELINE_BAND.past}</text><text class="tband tband--in" x="${nowX}%" dx="10" y="16">${TIMELINE_BAND.future}</text></svg>`;
  const rows = model.rows.map((row) => {
    const lanes = row.lanes.length === 0 ? [[]] : row.lanes;
    return lanes.map((lane, li) => {
      const first = li === 0;
      const last = li === lanes.length - 1;
      const more = last && row.more > 0 ? html`<span class="tl__repo">+${row.more} more</span>` : null;
      const head = html`<span class="${first ? "tl__h tl__h--first" : "tl__h"}">${first ? headHtml(row, model.by) : null}${more}</span>`;
      const named = first ? html` role="img" aria-label="${rowName(row)}"` : html` aria-hidden="true"`;
      return html`${head}<svg class="${first ? "tl__r tl__r--first" : "tl__r"}" height="${LANE_H}"${named}>${grid(LANE_H)}${lane.map((it) => itemHtml(it, nowX, lead))}</svg>`;
    });
  });
  // The rows left out (`TIMELINE_ROWS_MAX`): a card's sentence under the scroll box, not a line inside it. Inside, it was
  // as wide as the 720 px timeline, and a phone, whose timeline opens scrolled to its end, showed its last words alone,
  // or none of it.
  const cut = model.rowsMore?.rows > 0 ? html`<p class="card__sub">${rowsMoreText(model.rowsMore)}</p>` : null;
  const ticks = model.axis.filter((t) => t.label !== null).map((t) => html`<text class="tax" x="${t.x}%" y="14" text-anchor="middle">${t.label}</text>`);
  // "UTC" is written left of the lane's start, in the heads' column, beside the times it names (the SVG draws outside
  // its box); as a head of its own it read as one more line of the last row's head.
  const axis = html`<span></span><svg class="tl__r" height="${BAND_H}" aria-hidden="true"><text class="tax" x="0" dx="-8" y="14" text-anchor="end">${TIMELINE_BAND.axis}</text>${ticks}<rect class="tnowcap" x="${nowX}%" y="2" width="46" height="18" rx="9" transform="translate(-23 0)"/><text class="tnowcap-t" x="${nowX}%" y="15" text-anchor="middle">${model.nowLabel}</text></svg>`;
  return html`<div class="tl-wrap"><div class="tl" role="group" aria-label="${label}">${band}${rows}${axis}</div></div>${cut}`;
}

const GROUPED = new Intl.NumberFormat("en-US");

/** The line that counts the rows left out: "12 more rows are not drawn (340 runs and jobs in them)." */
function rowsMoreText({ rows, items }) {
  const one = rows === 1;
  return `${GROUPED.format(rows)} more ${one ? "row is" : "rows are"} not drawn (${GROUPED.format(items)} ${items === 1 ? "run or job" : "runs and jobs"} in ${one ? "it" : "them"}).`;
}

/** The legend's entries, in the card's order: each kind's swatch class and word; the arrow's is the chain icon. */
export const TIMELINE_LEGEND = Object.freeze([
  Object.freeze({ swatch: "lg--ok", word: "Completed" }),
  Object.freeze({ swatch: "lg--run", word: "Running" }),
  Object.freeze({ swatch: "lg--parked", word: "Awaiting input" }),
  Object.freeze({ swatch: "lg--failed", word: "Failed" }),
  Object.freeze({ swatch: "lg--ref", word: "Refused" }),
  Object.freeze({ swatch: "lg--hold", word: "Slot held" }),
  Object.freeze({ swatch: "lg--wait", word: "In line" }),
  Object.freeze({ icon: "chain", word: "waits for a run" }),
]);

/** The timeline's key, the card's `p.keyrow`: a swatch and a word per kind, so a colour is never the only cue. */
export function timelineLegend() {
  return html`<p class="keyrow">${TIMELINE_LEGEND.map((e) => html`<span>${e.icon ? icon(e.icon, { size: "sm" }) : html`<i class="lg ${e.swatch}"></i>`}${e.word}</span>`)}</p>`;
}
