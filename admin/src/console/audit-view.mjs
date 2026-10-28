/**
 * What the audit screen shows (issue #737, the AuditScreen card; most of issue #711): which rows a page of the console's
 * audit log lists, and what each one's place in the hash chain says about it. Pure over two readers the page data is
 * given (`pages.mjs` `loadPageData` wires them): `read`, the worker's `readConsoleAudit` asked for positions, and
 * `verify`, its `verifyConsoleAudit` asked for the last row it vouches for, the row before a broken link and its index
 * of the month files (`withLast`; both opt-in options, so the reader's and the verifier's other callers and the
 * INT-CONSOLE-AUDIT-LOG file format are untouched).
 *
 * A ROW'S STATE IS JUDGED BY ITS PLACE, NEVER BY ITS SEQ. The verifier names the first broken link by file and line, and
 * the last row it vouches for by file, line and seq. A row at the broken place is damaged, a row after it is not
 * verified (its link to the chain cannot be trusted, whatever it says), a row at or before the last vouched place is
 * ok, and a row after that place on an intact chain was written after the check (unchecked; the check is cached for a
 * few seconds, so the newest rows can be younger than it). The seq cannot do this job: a damaged line has none, and a
 * tampered file can hold one seq twice, or a seq that does not follow its neighbour's. A line that is not an audit row
 * is damaged wherever it sits.
 *
 * A ROW IS VOUCHED FOR ONLY BY THE LINE AFTER IT, when that line's `prev` matches the row's hash. An edited outcome
 * leaves its own line well formed and moves only its hash, so it shows only in the next line's `prev`. So at a break
 * whose line shows no `prev` that matches the row before it (the line does not parse, its `prev` is not a hash, or its
 * `prev` is another hash, whatever else is wrong with it), the row before the break is not vouched for either (state
 * `suspect`, drawn "not verified" with its own sentence) and the verified range ends one row earlier (the verifier's
 * `suspect` and `last`). Calling it ok, as the first version did, put a tampered outcome on the page under a green
 * banner, and so did the second whenever the line after the edit was damaged in any other way too. Only a line whose
 * `prev` matched and that fails another check (its seq, action, outcome or fields) is damaged alone, and the row before
 * it stays ok. The newest row has no line after it, so nothing vouches for it yet: on an intact chain it is shown ok all
 * the same, the one row the chain cannot speak for, a limit the docs name.
 *
 * A SEARCH IS BOUNDED. Filtering reads the log newest first, `CONSOLE_AUDIT_READ_MAX` rows at a time, until a page and
 * one more row match, `AUDIT_EXAMINE_MAX` rows have been examined, or nothing older remains, and the view says where it
 * stopped, so a filter over a log of any size costs a bounded read and never claims "no match" for rows it did not
 * read. No read is issued once the bound is reached. A DAMAGED ENTRY IS SHOWN UNDER EVERY FILTER, in its place, and is
 * not counted as a match: a line that is no row has no who, action or outcome a filter could judge, a damaged row's
 * fields are exactly what the chain does not vouch for, and a filtered view that hid them would look clean. (The first
 * version let a damaged line match no filter; the chain banner names only the FIRST break, so a second damaged line was
 * then on no filtered page at all.)
 *
 * A SEQ IS FOUND BY ITS NUMBER, NOT BY A WALK. The verifier's `files` index gives each month file's first row's seq, and
 * on the rows it walked line `s - first + 1` holds row `s`. THE ROW ASKED FOR decides whether the index places it, never
 * its chunk's top: a row the check counted is read at a place, from the newest row of its chunk the check counted (the
 * chunk's top, or the last row the check counted when the top is past it: rows written since the check, or after a
 * broken link), whose seq and place are checked there. A walk from the newest row, bounded like a search, is the
 * fallback for a row the check did not count (newer than the check, past a broken link, no check) or a place that no
 * longer holds its row (the files changed since the check), and the view says which (`seek.by`); a row below the log's
 * first row is reaped or removed, and is not walked for. A walk alone, as the first version did, could not reach a row
 * with 2,000 newer ones, so a kept link to a row (the done banner's) opened a page without it once the log had moved on
 * that far; and placing the chunk by its top, as the second did, sent every row of a chunk that runs past the check's
 * count to that walk (row 41 of a chain broken at row 46, with 2,000 rows after it, was never found, under a sentence
 * saying the check could not count to it).
 *
 * NEVER AN ECHO. A query parameter is checked against a closed list or a charset before anything reads it, and a
 * refusal names the parameter, never the value (`pages.mjs`'s rule).
 */
import { CONSOLE_AUDIT_ACTIONS, CONSOLE_AUDIT_CURSOR_RE, CONSOLE_AUDIT_OUTCOMES, CONSOLE_AUDIT_READ_MAX } from "@edgehero/pi-dispatch/console-audit";

/** The most rows one view examines while it searches (the AuditScreen card: "search over 2,000 rows"). */
export const AUDIT_EXAMINE_MAX = 2000;

/** A `who` filter: a token name as the console's tokens file allows one, at most 64 characters. */
export const AUDIT_WHO_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/** The longest search text, in code points. */
export const AUDIT_Q_MAX = 64;

/** A `seq` to open the page at: a row number, 1 or more, as many digits as a cursor's line may have. */
export const AUDIT_SEQ_RE = /^[1-9]\d{0,15}$/;

/** The parameters the audit page takes, in the order `auditQueryString` writes them. */
export const AUDIT_PARAMS = Object.freeze(["before", "who", "action", "outcome", "q", "seq"]);

/** The rows a page shows when the caller names no other count (`pages.mjs` `AUDIT_PER_PAGE` is the same 50). */
const PER_PAGE_DEFAULT = 50;

/**
 * The outcome badge's words, by what a row says or what its place says (the AuditScreen card: "a badge with a glyph and
 * a word"): a verified row shows the outcome it was written with; a damaged row, one after it and one written since the
 * last check show their state instead, since what such a row says about itself is not vouched for. `status` is a kit
 * status (its glyph), `icon` a sprite icon in its place where the status's own would mislead: not verified is waiting
 * on a check that cannot pass, the hourglass. The row before a broken link (`suspect`) is not verified either, so it
 * wears the same badge (the card's words: ok, refused, damaged, not verified); its sentence says why. The test holds
 * the outcome keys to `CONSOLE_AUDIT_OUTCOMES`.
 */
export const AUDIT_OUTCOME_WORDS = Object.freeze({
  ok: Object.freeze({ status: "ok", icon: null, word: "ok" }),
  refused: Object.freeze({ status: "refused", icon: null, word: "refused" }),
  failed: Object.freeze({ status: "failed", icon: null, word: "failed" }),
  damaged: Object.freeze({ status: "failed", icon: null, word: "damaged" }),
  unverified: Object.freeze({ status: "idle", icon: "hourglass", word: "not verified" }),
  suspect: Object.freeze({ status: "idle", icon: "hourglass", word: "not verified" }),
  unchecked: Object.freeze({ status: "idle", icon: null, word: "unchecked" }),
});

/** The row states a view hands the screen. */
export const AUDIT_ROW_STATES = Object.freeze(["ok", "damaged", "unverified", "suspect", "unchecked"]);

/** How a `seq` query's chunk was found (`seek.by`; see the header). */
export const AUDIT_SEEK_BY = Object.freeze(["place", "newer", "unplaced", "misplaced", "gone"]);

/** A month file's name as the worker writes them, which is all a place may name. */
const MONTH_FILE_RE = /^\d{4}-\d{2}\.jsonl$/;

/** An entry's place as `readConsoleAudit` writes it: the month, then the 1-based line (a read failure's may be 0). */
const PLACE_RE = /^(\d{4}-\d{2}):(\d{1,16})$/;

/**
 * A control, a zero-width or a direction mark: what a search text may not hold. The search is matched against stored
 * rows, whose fields the worker writes with those characters spelled out, so such a text could never match, and a
 * person could not see what they typed.
 */
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

/** `params` as a URLSearchParams: one already, a query string, or a plain object of strings. */
function asParams(params) {
  if (params instanceof URLSearchParams) return params;
  if (typeof params === "string" || params === null || params === undefined) return new URLSearchParams(params ?? "");
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === "string") out.append(k, v);
  return out;
}

/**
 * Judge the audit page's query: `{ query }` (frozen: `before`, `who`, `action`, `outcome` and `q` a string or null,
 * `seq` a number or null) or `{ refusal }`, a sentence that names the parameter and its rule and never its value.
 *
 *   - `before`: a place in the files, `YYYY-MM:<line>` (`readConsoleAudit`'s cursor, its own pattern);
 *   - `who`: a token name (`AUDIT_WHO_RE`); `action` and `outcome`: one of the worker's closed lists;
 *   - `q`: what to find in a row's target or reason, printable, at most `AUDIT_Q_MAX` characters;
 *   - `seq`: a row number, which opens the page holding that row, so it cannot be given with `before` (both say where
 *     the page starts).
 *
 * An empty value is the parameter left out (what a filter form's "anyone" sends). `pages.mjs` `parsePageQuery` checks
 * the count, the length and the repeats first; they are checked here again, so this function judges a query alone.
 */
export function parseAuditQuery(params) {
  const p = asParams(params);
  for (const k of p.keys()) if (!AUDIT_PARAMS.includes(k)) return { refusal: `the audit page takes only ${AUDIT_PARAMS.join(", ")}` };
  for (const k of AUDIT_PARAMS) if (p.getAll(k).length > 1) return { refusal: `${k} is given more than once` };
  const one = (k) => {
    const v = p.get(k);
    return v === null || v === "" ? null : v;
  };
  const before = one("before");
  if (before !== null) {
    const m = CONSOLE_AUDIT_CURSOR_RE.exec(before);
    if (m === null || !Number.isSafeInteger(Number(m[2]))) return { refusal: "before must be an audit position (YYYY-MM:line, as the Older rows link gives it)" };
  }
  const who = one("who");
  if (who !== null && !AUDIT_WHO_RE.test(who)) return { refusal: "who must be a token name (letters, digits and . _ @ -, at most 64 characters)" };
  const action = one("action");
  if (action !== null && !CONSOLE_AUDIT_ACTIONS.includes(action)) return { refusal: `action must be one of ${CONSOLE_AUDIT_ACTIONS.join(", ")}` };
  const outcome = one("outcome");
  if (outcome !== null && !CONSOLE_AUDIT_OUTCOMES.includes(outcome)) return { refusal: `outcome must be one of ${CONSOLE_AUDIT_OUTCOMES.join(", ")}` };
  const q = one("q");
  if (q !== null && ([...q].length > AUDIT_Q_MAX || UNPRINTABLE_RE.test(q))) return { refusal: `q must be at most ${AUDIT_Q_MAX} printable characters` };
  const rawSeq = one("seq");
  let seq = null;
  if (rawSeq !== null) {
    if (!AUDIT_SEQ_RE.test(rawSeq) || !Number.isSafeInteger(Number(rawSeq))) return { refusal: "seq must be an audit row number (a whole number, 1 or more)" };
    if (before !== null) return { refusal: "seq and before do not go together: each says where the page starts" };
    // A seq page is the row's own chunk, unfiltered (the banner after a write links it); refused with a filter rather
    // than drawn unfiltered under selects that say otherwise. The filter form drops seq for the same reason.
    if (who !== null || action !== null || outcome !== null || q !== null) return { refusal: "seq must not be combined with who, action, outcome or q: it opens its row's own page, unfiltered" };
    seq = Number(rawSeq);
  }
  return { query: Object.freeze({ before, who, action, outcome, q, seq }) };
}

/**
 * A parsed audit query as its canonical query string (no leading `?`), the parameters in `AUDIT_PARAMS`' order and the
 * absent ones left out, so a page's own links and `pages.mjs` `pageQueryString` write one form that `parseAuditQuery`
 * takes back. `over` replaces or drops (null) parameters first: the pager's `before`, a filter that starts again.
 */
export function auditQueryString(query, over = {}) {
  const q = { ...(query ?? {}), ...over };
  const out = new URLSearchParams();
  for (const k of AUDIT_PARAMS) if (q[k] !== null && q[k] !== undefined && q[k] !== "") out.set(k, String(q[k]));
  return out.toString();
}

/** Whether the query filters rows (a search, or who, action or outcome): the reads then look further than one page. */
export function auditFiltered(query) {
  return Boolean(query?.who || query?.action || query?.outcome || query?.q);
}

/** Whether an entry is an audit row (a parsed object with a seq), as `readConsoleAudit` hands them back. */
export function isAuditRow(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.broken !== true && Number.isSafeInteger(entry.seq) && entry.seq >= 1;
}

/** A place as `[month, line]`, or null for anything that is not one. */
function placeOf(pos) {
  const m = typeof pos === "string" ? PLACE_RE.exec(pos) : null;
  return m === null ? null : [m[1], Number(m[2])];
}

/** -1, 0 or 1: the order of two places in the files (an older month first, then the lower line). */
function comparePlaces(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1;
}

/** A verifier's place (`{ file, line }`), its `YYYY-MM:<line>` form, or null when the file is not a month file. */
function placeText(file, line) {
  return typeof file === "string" && MONTH_FILE_RE.test(file) && Number.isSafeInteger(line) && line >= 0 ? `${file.slice(0, 7)}:${line}` : null;
}

/** A verifier's `{ file, line, seq }` with its place, frozen, or null for anything else. */
function rowPlace(r) {
  const pos = r && typeof r === "object" ? placeText(r.file, r.line) : null;
  return pos !== null && Number.isSafeInteger(r.seq) && r.seq >= 1 ? Object.freeze({ file: r.file, line: r.line, seq: r.seq, pos }) : null;
}

/**
 * The verifier's `files` index as the view uses it: `[{ month, seq, rows }]`, oldest first, each a month file's name
 * without `.jsonl`, its first row's seq and the rows walked in it; [] for anything that is not one. An index whose seqs
 * do not run on from one file to the next is no index (the walk that wrote it could not have passed them), so a seq is
 * then walked for instead of placed.
 */
function indexOf(files) {
  if (!Array.isArray(files)) return Object.freeze([]);
  const out = [];
  for (const f of files) {
    const ok = f && typeof f === "object" && typeof f.file === "string" && MONTH_FILE_RE.test(f.file) && Number.isSafeInteger(f.seq) && f.seq >= 1 && Number.isSafeInteger(f.rows) && f.rows >= 1;
    const prior = out[out.length - 1];
    if (!ok || (prior && (f.file <= `${prior.month}.jsonl` || f.seq !== prior.seq + prior.rows))) return Object.freeze([]);
    out.push(Object.freeze({ month: f.file.slice(0, 7), seq: f.seq, rows: f.rows }));
  }
  return Object.freeze(out);
}

/** The chain as the screen reads it, from a `verifyConsoleAudit({ withLast: true })` result or anything else. */
function chainOf(v) {
  const unread = (why) => ({ state: "unreadable", why, from: null, through: null, startsAt: null, broken: null, last: null, suspect: null, index: Object.freeze([]), checkedAt: null });
  if (v === null || typeof v !== "object" || typeof v.ok !== "boolean") return unread("error");
  const checkedAt = Number.isFinite(v.checkedAt) ? v.checkedAt : null;
  const last = v.last ? rowPlace(v.last) : null;
  const suspect = !v.ok && v.suspect ? rowPlace(v.suspect) : null;
  const rows = Number.isSafeInteger(v.rows) && v.rows > 0 ? v.rows : 0;
  // The rows the walk read form one unbroken run of seqs ending at the last one walked (the suspect, when the break is a
  // prev that did not match), so the run's first is known too.
  const end = suspect ?? last;
  const from = end !== null && rows > 0 && end.seq - rows + 1 >= 1 ? end.seq - rows + 1 : null;
  const base = { from, through: last?.seq ?? null, last, suspect, index: indexOf(v.files), checkedAt };
  if (v.ok) return { state: "ok", why: null, ...base, startsAt: Number.isSafeInteger(v.startsAt?.seq) ? v.startsAt.seq : null, broken: null };
  const b = v.broken ?? {};
  const pos = placeText(b.file, b.line);
  if (pos === null) return { ...unread(b.file === null ? "directory" : "error"), checkedAt };
  const reason = typeof b.reason === "string" && b.reason !== "" ? b.reason : null;
  return { state: "broken", why: null, ...base, startsAt: null, broken: Object.freeze({ file: b.file, line: b.line, reason, pos }) };
}

/** A row's state (`AUDIT_ROW_STATES`) by its place against the chain (see the header). */
export function auditRowState(entry, pos, chain) {
  if (!isAuditRow(entry)) return "damaged";
  const at = placeOf(pos);
  if (at === null || chain === null || typeof chain !== "object" || chain.state === "unreadable") return "unchecked";
  if (chain.state === "broken") {
    const c = comparePlaces(at, placeOf(chain.broken.pos));
    if (c !== 0) {
      if (c > 0) return "unverified";
      const s = chain.suspect ? placeOf(chain.suspect.pos) : null;
      return s !== null && comparePlaces(at, s) === 0 ? "suspect" : "ok";
    }
    return "damaged";
  }
  if (chain.last === null) return "unchecked";
  return comparePlaces(at, placeOf(chain.last.pos)) <= 0 ? "ok" : "unchecked";
}

/**
 * Where row `seq` is, by the chain's index (see the header): `{ pos }`, its `YYYY-MM:<line>`; `{ gone: true }` when it is
 * below the log's first row (reaped, or removed); `{ newer: true }` when it is past the rows the index covers on an
 * intact chain (written after the check, or not at all yet); or null when the index cannot place it (no index, or past
 * a broken link).
 */
function seqPlace(chain, seq) {
  const index = chain?.index ?? [];
  if (index.length === 0) return null;
  if (seq < index[0].seq) return { gone: true };
  for (const f of index) if (seq < f.seq + f.rows) return { pos: `${f.month}:${seq - f.seq + 1}` };
  return chain.state === "ok" ? { newer: true } : null;
}

/** The last row the chain's index counts (its last month file's first seq and rows), or null for no index. */
function indexEnd(chain) {
  const last = chain?.index?.at(-1);
  return last ? last.seq + last.rows - 1 : null;
}

/** Whether a row matches the filters (a damaged entry is shown whatever they say, by the caller; see the header). */
function matches(entry, q) {
  if (!isAuditRow(entry)) return false;
  if (q.who && entry.actor?.name !== q.who) return false;
  if (q.action && entry.action !== q.action) return false;
  if (q.outcome && entry.outcome !== q.outcome) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    const has = (v) => typeof v === "string" && v.toLowerCase().includes(needle);
    if (!has(entry.target) && !has(entry.reason)) return false;
  }
  return true;
}

/**
 * Read one view of the audit screen: `{ rows, next, examined, stopped, found, seek, who, chain, unreadable }`.
 *
 *   - `read({ limit, before })` returns a `readConsoleAudit({ positions: true })` page (sync or a promise);
 *   - `verify()` returns a `verifyConsoleAudit({ withLast: true })` result, optionally with `checkedAt` (millis, when the
 *     check ran; the console caches it), or throws, or is not given: the chain is then `unreadable`;
 *   - `query` is `parseAuditQuery`'s; `perPage` the rows a page shows.
 *
 * `rows` are `{ entry, pos, state }`, newest first, at most `perPage` (under a filter, the damaged entries the search
 * met are among them whatever the filters say; see the header), and none on a `seq` page whose row was not found: what
 * its walk kept is whatever it met of the row's chunk before it stopped (one row above a row moved out of its place,
 * say), which, above a foot saying the row was not found, read as that row's page. `next` is the place the next page
 * starts below (the pager's `before`), or null when nothing older remains. `examined` counts the entries the search or the walk read,
 * `stopped` is true when it reached `AUDIT_EXAMINE_MAX` with more to read (`next` then continues it), and `found` says
 * whether a `seq` query's row was among them (null without one). `seek` is null without a `seq`, else `{ by, newest,
 * first }`: `by` how its chunk was found (`AUDIT_SEEK_BY`): read at the `place` the index gives; walked for from the
 * newest row because it is `newer` than the check, `unplaced` by the index (no check, or past a broken link) or
 * `misplaced` (the place the index gave did not hold it, or the read down from there did not find it); or not read,
 * being `gone` (below the log's first row).
 * `newest` is the newest row's seq when the view read from the top (else null), `first` the log's first row's seq by
 * the index (else null). `who` is the sorted token names the examined rows name, for the filter's list (the chosen one
 * included). `chain` is `{ state: "ok"|"broken"|"unreadable", why, from, through, startsAt, broken, last, suspect, index,
 * checkedAt }`. `unreadable` is the reader's sentence when it could not read (no rows then).
 *
 * `seq` opens the `perPage`-row chunk that holds that row: rows numbered from `(k - 1) * perPage + 1` to `k * perPage`
 * for the `k` that holds it, with the damaged lines among them, so a link to "row 41" lands on one page however many
 * rows have been written since. A chunk read at its place starts at its newest row the check counted, so its rows past
 * that count (written since the check, or after a broken link) are not on it; they are the newer pages' (see the header).
 */
export async function readAuditView({ read, verify = null, query = {}, perPage = PER_PAGE_DEFAULT } = {}) {
  const q = query ?? {};
  const size = Number.isSafeInteger(perPage) && perPage >= 1 ? Math.min(perPage, CONSOLE_AUDIT_READ_MAX - 1) : PER_PAGE_DEFAULT;
  let chain;
  try {
    chain = typeof verify === "function" ? chainOf(await verify()) : chainOf(null);
    if (typeof verify !== "function") chain = { ...chain, why: "missing" };
  } catch {
    chain = chainOf(null);
  }
  const filter = auditFiltered(q);
  const seq = Number.isSafeInteger(q.seq) && q.seq >= 1 ? q.seq : null;
  const top = seq === null ? null : Math.ceil(seq / size) * size;
  const bottom = top === null ? null : top - size + 1;
  const names = new Set();

  /**
   * Read the log from below `from` (null: the newest row) down, `limit` entries a call and never past
   * `AUDIT_EXAMINE_MAX` entries: a plain page, a search, or a seq's chunk. `placed` is `{ pos, seq }`, the row a chunk
   * read at its place starts at and where the index says it is: a first read whose first entry is not that row at that
   * place (both: a file that shrank above it moves its row up a line, seq and all) stops at once as `misplaced`, having
   * kept nothing from it.
   */
  const scan = async (from, limit, placed = null) => {
    const s = { picked: [], examined: 0, lastPos: null, stopped: false, older: false, found: seq === null ? null : false, newest: null, unreadable: null, misplaced: false };
    let before = from;
    let inChunk = placed !== null; // a seq's walk keeps entries from the chunk's top row down
    read: for (;;) {
      let page;
      try {
        page = await read({ limit: Math.min(limit, AUDIT_EXAMINE_MAX - s.examined), before });
      } catch {
        s.unreadable = "the audit log could not be read";
        break;
      }
      if (page === null || typeof page !== "object" || !Array.isArray(page.rows)) {
        s.unreadable = "the audit log could not be read";
        break;
      }
      if (typeof page.unreadable === "string") {
        s.unreadable = page.unreadable;
        break;
      }
      if (!Array.isArray(page.positions) || page.positions.length !== page.rows.length) {
        s.unreadable = "the audit reader gave no place for its rows";
        break;
      }
      if (placed !== null && s.examined === 0 && !(page.positions[0] === placed.pos && isAuditRow(page.rows[0]) && page.rows[0].seq === placed.seq)) {
        s.misplaced = true;
        break;
      }
      for (let i = 0; i < page.rows.length; i += 1) {
        // A reader that returns more than it was asked for still stops the search at its bound.
        if (s.examined >= AUDIT_EXAMINE_MAX) {
          s.stopped = true;
          break read;
        }
        const entry = page.rows[i];
        const pos = page.positions[i];
        s.examined += 1;
        s.lastPos = pos;
        if (isAuditRow(entry)) {
          if (from === null && s.newest === null) s.newest = entry.seq;
          if (typeof entry.actor?.name === "string" && AUDIT_WHO_RE.test(entry.actor.name)) names.add(entry.actor.name);
        }
        if (seq !== null) {
          if (isAuditRow(entry) && entry.seq < bottom) {
            s.older = true;
            break read;
          }
          if (isAuditRow(entry) && entry.seq <= top) inChunk = true;
          if (!inChunk) continue;
          if (isAuditRow(entry) && entry.seq === seq) s.found = true;
        } else if (filter && !matches(entry, q) && auditRowState(entry, pos, chain) !== "damaged") continue;
        s.picked.push({ entry, pos });
        if (s.picked.length > size) break read;
      }
      if (page.next === null || page.next === undefined) break;
      // The bound is reached with more to read: stop here rather than issue a read whose rows would not be examined.
      if (s.examined >= AUDIT_EXAMINE_MAX) {
        s.stopped = true;
        break;
      }
      before = page.next;
    }
    return s;
  };

  // A search or a walk for a seq looks through many rows for few: it reads the most a call returns. A plain page, and a
  // seq's chunk read at its place, read one more row than they show, which is how they know an older page exists.
  let s;
  let seek = null;
  if (seq === null) s = await scan(typeof q.before === "string" ? q.before : null, filter ? CONSOLE_AUDIT_READ_MAX : size + 1);
  else {
    // Placed or walked for by the row asked for, never by the chunk's top (see the header).
    const at = seqPlace(chain, seq);
    const first = chain.index.length > 0 ? chain.index[0].seq : null;
    if (at?.gone) {
      // Below the log's first row: reaped, or removed. A walk could only read the whole log to say so.
      s = { picked: [], examined: 0, lastPos: null, stopped: false, older: false, found: false, newest: null, unreadable: null };
      seek = { by: "gone", newest: null, first };
    } else {
      let by = at?.pos ? "place" : at?.newer ? "newer" : "unplaced";
      s = null;
      if (at?.pos) {
        // The chunk's newest row the check counted: at least the row asked for, which it counted.
        const start = Math.min(top, indexEnd(chain));
        const { pos } = seqPlace(chain, start);
        const [month, line] = placeOf(pos);
        s = await scan(`${month}:${line + 1}`, size + 1, { pos, seq: start });
        // A row the check counted is in its chunk while the files are as the check read them, so a read from its place
        // that does not find it means they changed since: walk for it, never say it is gone.
        if (s.misplaced || !s.found) {
          by = "misplaced";
          s = null;
        }
      }
      if (s === null) s = await scan(null, CONSOLE_AUDIT_READ_MAX);
      seek = { by, newest: s.newest, first };
    }
    seek = Object.freeze(seek);
  }
  // A search stopped at its bound with no more to read has read everything: it did not stop.
  const shown = s.picked.slice(0, size);
  let next = null;
  if (s.picked.length > size) next = shown[shown.length - 1].pos;
  else if (s.stopped) next = s.lastPos;
  else if (s.older && shown.length > 0) next = shown[shown.length - 1].pos;
  if (typeof q.who === "string" && AUDIT_WHO_RE.test(q.who)) names.add(q.who);
  // Not found: no rows (see above), and Older still goes on from where the walk got to.
  const drawn = seq !== null && s.found !== true ? [] : shown;
  return {
    rows: drawn.map(({ entry, pos }) => ({ entry, pos, state: auditRowState(entry, pos, chain) })),
    next,
    examined: s.examined,
    stopped: s.stopped,
    found: s.found,
    seek,
    who: [...names].sort(),
    chain: Object.freeze(chain),
    unreadable: s.unreadable,
  };
}
