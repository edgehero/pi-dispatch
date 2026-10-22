/**
 * One vocabulary for the operator console and the `/dispatch` panel (issue #710, PR 2). Both surfaces read their
 * outcome words, their venue label and their Spend and Held titles from here, so a run the panel calls "refused" is
 * never "policy" on the console, and the panel's SPEND section and the console's Spend page are the same word. A test
 * (`admin/test/words.test.mjs`) holds that both import this module, and holds every table here to its source.
 *
 * THE WORDS COME FROM THE RECORD, MADE READABLE. The run record's `outcome` is `completed`, `policy` or `failed`
 * (INT-RUN-HISTORY-FILE-CONTRACT); `policy` reads as "refused", since that is what the worker did. Two reasons change the
 * word, because the outcome alone says the wrong thing about them: a completed run with `awaiting-input` is waiting on a
 * person (the panel's row once said "done" for it, issue #646's finding), and a policy run with `operator-cancel` was
 * stopped by an operator, not refused by a rule. Those two are `REASON_WORDS`, each tied to the outcome it qualifies: the
 * same token under another outcome keeps the outcome's word, so a malformed record cannot borrow one.
 *
 * The field and query names stay what the record calls them (`outcome`, `backend`): these are display words only.
 */

import { explainReason } from "@edgehero/pi-dispatch/reason-catalog";

/**
 * The record's `outcome` values, each with its word, the panel's glyph and its tone. The tone is the panel's colour name
 * (`success`, `warning`, `error`) and the console's class (`TONE_CLASS`). Refused is a warning, not an error: nothing
 * broke, a rule said no, and the operator may want to change the rule.
 */
export const OUTCOME_WORDS = Object.freeze({
  completed: Object.freeze({ word: "completed", glyph: "✔", tone: "success" }),
  policy: Object.freeze({ word: "refused", glyph: "⚠", tone: "warning" }),
  failed: Object.freeze({ word: "failed", glyph: "✘", tone: "error" }),
});

/** Each outcome's word alone, as a plain map: what the browser script and the topology (which load no module) are handed. */
export const OUTCOME_WORD_OF = Object.freeze(Object.fromEntries(Object.entries(OUTCOME_WORDS).map(([k, v]) => [k, v.word])));

/**
 * The reasons that change the outcome's word, each with the one outcome it qualifies. `awaiting-input` keeps the
 * completed glyph (it completed, its work is promoted, it is never retried) with a warning tone, since a person has to
 * act. `operator-cancel` keeps the refused glyph and tone: the run did not complete, and someone chose that.
 */
export const REASON_WORDS = Object.freeze({
  "awaiting-input": Object.freeze({ outcome: "completed", word: "awaiting input", glyph: "✔", tone: "warning" }),
  "operator-cancel": Object.freeze({ outcome: "policy", word: "cancelled", glyph: "⚠", tone: "warning" }),
});

/** The tone of a word that is not one of ours (an outcome value this release does not know): shown raw, as a failure. */
const UNKNOWN = Object.freeze({ known: false, word: null, glyph: "✘", tone: "error" });

/**
 * The word for a record's outcome and reason: `{ known, word, glyph, tone }`. Compared against the RAW values, never a
 * scrubbed copy, so a control byte can change what a row looks like but never what it says a run did. `known: false`
 * (an outcome that is not an own key of `OUTCOME_WORDS`, `__proto__` included) has no word: the caller prints the value
 * itself, scrubbed or escaped, as a failure, which is what the panel always did with one.
 */
export function outcomeWord(outcome, reason) {
  if (typeof outcome !== "string" || !Object.hasOwn(OUTCOME_WORDS, outcome)) return UNKNOWN;
  if (typeof reason === "string" && Object.hasOwn(REASON_WORDS, reason) && REASON_WORDS[reason].outcome === outcome) {
    const q = REASON_WORDS[reason];
    return { known: true, word: q.word, glyph: q.glyph, tone: q.tone, qualified: true };
  }
  const o = OUTCOME_WORDS[outcome];
  return { known: true, word: o.word, glyph: o.glyph, tone: o.tone, qualified: false };
}

/** The console's CSS class for each tone (style.mjs `.good`, `.warn`, `.bad`); a completed run takes none, as before. */
export const TONE_CLASS = Object.freeze({ success: null, warning: "warn", error: "bad" });

/** What both surfaces call the record's `backend` field (issue #712's word): the field and the query name stay `backend`. */
export const VENUE_LABEL = "Venue";

/**
 * The spend screen's name: the console's `/insights` page and nav entry, and the panel's SPEND section. The insights (the
 * charts, the breakdowns, the topology) are its sub-view: the page keeps its `/insights` path and the panel its `i` key.
 */
export const SPEND_TITLE = "Spend";

/** The jobs held on wait conditions: the console's fleet panel and the panel's HELD section and `h` view. */
export const HELD_LABEL = "Held";

/**
 * Where a catalog anchor (`docs/reasons.md#<token>`, a path from the repository root) is read (issue #710): the
 * repository's docs on its forge, on `main`. The console serves no docs of its own (its other docs mentions are plain
 * `docs/console.md` text), and an operator reading a run page is on a browser, not in a checkout. `main` and not the
 * running release's tag: a release tag that predates a reason's heading would answer a page without it, while `main`
 * keeps every heading a released worker can write (the catalog's tokens only grow). The root is held by a test to the
 * repository URL the packages publish (`worker/package.json`'s `repository.url`).
 */
export const DOCS_ROOT = "https://github.com/edgehero/pi-dispatch/blob/main/";

/** A catalog anchor as a link into the repository's docs (`DOCS_ROOT`), or null for anything that is not one. */
export function docsHref(anchor) {
  if (typeof anchor !== "string" || !/^docs\/[a-z0-9-]+\.md(?:#[a-z0-9-]+)?$/.test(anchor)) return null;
  return `${DOCS_ROOT}${anchor}`;
}

/** What a surface says for a reason the catalog does not know (a newer worker's token): the token itself, then this. */
export const NO_EXPLANATION = "no explanation yet";

/** The longest short sentence, in characters, the ellipsis included: a list row's reason cell wraps to two lines at most. */
export const SHORT_MAX = 72;

/**
 * A catalog sentence cut to a list row, DERIVED, never written by hand (a second hand-written sentence per reason would
 * drift from the first, CLAUDE.md's "derived or pinned"). The rule, in order:
 *   1. drop a leading verdict of at most four words and a colon ("Refused: ", "Not run: ", "Failed, continuing: ",
 *      "Failed before it started: "), since the outcome word beside it already says it;
 *   2. keep the first sentence (up to the first full stop followed by a space, or the end), without its full stop;
 *   3. drop the backticks the catalog writes for Markdown (`run.mcp` reads as run.mcp in a table cell);
 *   4. capitalise the first letter;
 *   5. over `SHORT_MAX`, drop its asides (every closed parenthetical, and a ", which ...," clause between commas),
 *      and if it is still over, cut at the last space that leaves room for the ellipsis, by code points, then BACK
 *      OFF, as often as one applies: past a trailing comma, semicolon or colon, past a "(" the cut left unclosed, and
 *      past a trailing word that cannot end a phrase (`DANGLING`; a negation goes together with the word before it),
 *      never below `SHORT_FLOOR`. End with "…".
 * Cutting at a clause instead was measured and rejected: a third of the catalog's sentences open with the same clause
 * ("This trigger names MCP servers in run.mcp, and ...", "This job's project has a secret bundle ..."), so the first
 * clause names the feature and drops the cause. The cut keeps the cause's start, and the row links to every run refused
 * for the token, whose run page has the whole sentence.
 */
export function shortSentence(sentence) {
  if (typeof sentence !== "string") return "";
  let s = sentence.replace(/^[A-Z][a-z]*(?:,? [a-z]+){0,3}: /, "");
  const stop = s.search(/\.(\s|$)/);
  if (stop >= 0) s = s.slice(0, stop);
  s = s.replace(/`/g, "").trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return cutToRow(s);
}

/** Step 5 of `shortSentence`: a sentence over `SHORT_MAX`, its asides dropped, cut at a word, backed off, with the ellipsis. */
function cutToRow(s) {
  if (codePoints(s) <= SHORT_MAX) return s;
  // An aside is the one part of a sentence written to be left out, so a sentence that has to be cut loses its asides
  // first, wherever they open (round 2 of the #710 review): a parenthetical, and a relative clause between commas. Cut
  // with its aside, "The worker host's Podman configuration (rootful Podman's, ...) lets a job's container reach more"
  // backed off to its subject alone, and four rows said what the cause was about and not what it did.
  const lean = s.replace(/\s*\([^()]*\)/g, "").replace(/, which [^,()]*,/g, "");
  if (lean !== s) return cutToRow(lean);
  // By code points, never UTF-16 units, so a cut can never split a surrogate pair (a sentence with no space at all).
  const head = Array.from(s).slice(0, SHORT_MAX).join("");
  const room = head.lastIndexOf(" ");
  let body = room > 0 ? head.slice(0, room) : Array.from(s).slice(0, SHORT_MAX - 1).join("");
  for (;;) {
    body = body.replace(/[,;:]$/, "");
    const open = body.lastIndexOf("(");
    const unclosed = open >= 0 && !body.includes(")", open);
    // Never below `SHORT_FLOOR`: a cut that backs off that far would say less than the token beside it.
    const back = unclosed ? open : body.search(DANGLING);
    if (back < SHORT_FLOOR) break;
    body = body.slice(0, back).trimEnd();
  }
  return `${body}…`;
}

/** A string's length in code points, which is what a reader counts as characters. */
const codePoints = (s) => Array.from(s).length;

/**
 * The words a cut sentence may not end on (round 1 of the #710 review): a row that reads "its cost limit, so it…" or
 * "this job's forge (it ships no client for…" ends mid-phrase, and the reader guesses the rest. Articles,
 * conjunctions, prepositions, determiners and auxiliaries, and a subject pronoun after a conjunction ("so it", "while
 * it"); an object pronoun ends a phrase ("could not enforce it", "a folder above it") and stays. A negation ("not",
 * "no", "never") is never dropped alone, since "could not" cut to "could" says the opposite (round 2): it goes together
 * with the word before it, or, where that would pass the floor, stays. Measured over the
 * catalog's 180 sentences (REASONS, the nested tables and the `why` variants), 157 of them cut (147 once round 2 dropped the asides first): without the back-off,
 * 77 cut sentences ended on one of these and 19 inside an open parenthesis; with it, none does.
 */
const DANGLING = /\s+(?:\S+ (?:not|no|never)|(?:so|and|but|or|nor|that|which|because|if|when|while|until|whether) (?:it|they|there)|a|an|the|so|of|to|and|or|nor|but|in|on|at|by|for|with|from|into|as|than|if|when|while|until|after|before|because|whether|which|whose|that|this|its|their|any|every|each|is|are|was|were|be|has|have|had|can|could|may|might|must|should|would|will|does|did|do)$/i;

/** The shortest a backed-off cut may get, in characters, the ellipsis not counted. */
const SHORT_FLOOR = 24;

/**
 * A reason for a list row: `{ known: true, token, short, sentence, next }` from the catalog (`why` picks its variant),
 * or `{ known: false, token }` for a token the catalog does not know, which the caller shows raw beside
 * `NO_EXPLANATION`. Only the closed `reason` enum ever comes here: a job's free-text `failedReason` never does
 * (REQ-CONSOLE-SECURITY (l)), and every string this returns but the token is the catalog's own fixed text.
 */
export function reasonWords(token, why = null) {
  const got = explainReason(token, { why });
  if (!got.known) return { known: false, token };
  return { known: true, token, short: shortSentence(got.sentence), sentence: got.sentence, next: got.next };
}
