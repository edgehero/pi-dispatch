/**
 * One vocabulary for the operator console and the `/dispatch` panel (issue #710, PR 2). Both surfaces read their
 * outcome words, their venue label and their Spend and Held titles from here, so a run the panel calls "refused" is
 * never "policy" on the console, and the panel's SPEND section and the console's Spend page are the same word. A test
 * (`admin/test/words.test.mjs`) holds that both import this module, and holds every table here to its source.
 *
 * THE WORDS COME FROM THE RECORD, MADE READABLE. The run record's `outcome` is `completed`, `policy` or `failed`
 * (INT-RUN-HISTORY-FILE-CONTRACT); `policy` reads as "refused", since that is what the worker did. Some reasons change
 * the word, because the outcome alone says the wrong thing about them: a completed run with `awaiting-input` is waiting
 * on a person (the panel's row once said "done" for it, as issue #646 saw), a policy run with `operator-cancel` was
 * stopped by an operator, not refused by a rule, and a policy run with one of the three recovery ends was lost and could
 * not be continued, a failure (issue #737). Those are `REASON_WORDS`, each tied to the outcome it qualifies: the same
 * token under another outcome keeps the outcome's word, so a malformed record cannot borrow one.
 *
 * The field and query names stay what the record calls them (`outcome`, `backend`): these are display words only.
 */

import { explainReason } from "@edgehero/pi-dispatch/reason-catalog";
import { RECORD_REASON_RE } from "@edgehero/pi-dispatch/record-reason";
import { REPLY_ERROR_CLASSES, replyErrorClass, replyErrorWords } from "@edgehero/pi-dispatch/reply-error-class";

export { RECORD_REASON_RE };

/**
 * The console's status kinds (issue #737): the closed set a Pulse badge, chip, tile or banner is drawn in. Each is one
 * tone and one icon in the console's kit (`console/kit.mjs` `STATUS`, held to this list by its test), so a status says
 * itself with an icon and a word, never by colour alone. `cancelled` is its own kind with the idle tone: a stopped run
 * reads as stopped, not as a failure and not as a refusal.
 */
export const STATUS_KINDS = Object.freeze(["running", "parked", "failed", "refused", "attention", "ok", "idle", "cancelled"]);

/**
 * The record's `outcome` values, each with its word, the panel's glyph and its tone. The tone is the panel's colour name
 * (`success`, `warning`, `error`) ; the console uses its status. Refused is a warning, not an error: nothing
 * broke, a rule said no, and the operator may want to change the rule. The `status` is the console's (`STATUS_KINDS`):
 * the panel keeps its glyph and tone, the Pulse console draws the status.
 */
export const OUTCOME_WORDS = Object.freeze({
  completed: Object.freeze({ word: "completed", glyph: "✔", tone: "success", status: "ok" }),
  policy: Object.freeze({ word: "refused", glyph: "⚠", tone: "warning", status: "refused" }),
  failed: Object.freeze({ word: "failed", glyph: "✘", tone: "error", status: "failed" }),
});

/** Each outcome's word alone, as a plain map: what the browser script and the topology (which load no module) are handed. */
export const OUTCOME_WORD_OF = Object.freeze(Object.fromEntries(Object.entries(OUTCOME_WORDS).map(([k, v]) => [k, v.word])));

/**
 * The reasons that change the outcome's word, each with the one outcome it qualifies. `awaiting-input` keeps the
 * completed glyph (it completed, its work is promoted, it is never retried) with a warning tone, since a person has to
 * act. `operator-cancel` keeps the refused glyph and tone: the run did not complete, and someone chose that. On the
 * console each has its own status: a run awaiting input is parked (a person answers it), a cancelled run is cancelled.
 * The three recovery ends (issue #737) are recorded as `policy` but are failures: the run was lost and could not be
 * resumed, so they read as failed. `says` is whether the word says why: "awaiting input" and "cancelled" do, so a row
 * draws no reason sentence beside them; "failed" does not, so a recovery end keeps its sentence.
 */
export const REASON_WORDS = Object.freeze({
  "awaiting-approval": Object.freeze({ outcome: "completed", word: "awaiting approval", glyph: "✔", tone: "warning", status: "parked", says: true }),
  "awaiting-input": Object.freeze({ outcome: "completed", word: "awaiting input", glyph: "✔", tone: "warning", status: "parked", says: true }),
  "operator-cancel": Object.freeze({ outcome: "policy", word: "cancelled", glyph: "⚠", tone: "warning", status: "cancelled", says: true }),
  "agent-cancel": Object.freeze({ outcome: "policy", word: "cancelled", glyph: "⚠", tone: "warning", status: "cancelled", says: true }),
  "recovery-cap": Object.freeze({ outcome: "policy", word: "failed", glyph: "✘", tone: "error", status: "failed", says: false }),
  "recovery-checkpoint-absent": Object.freeze({ outcome: "policy", word: "failed", glyph: "✘", tone: "error", status: "failed", says: false }),
  "recovery-unsafe-extensions": Object.freeze({ outcome: "policy", word: "failed", glyph: "✘", tone: "error", status: "failed", says: false }),
});

/** The tone of a word that is not one of ours (an outcome value this release does not know): shown raw, as a failure. */
const UNKNOWN = Object.freeze({ known: false, word: null, glyph: "✘", tone: "error", status: "failed", qualified: false, says: false });

/**
 * The word for a record's outcome and reason: `{ known, word, glyph, tone, status, qualified, says }` (`qualified`: a
 * reason changed the word; `says`: the word itself says why, so a row adds no reason sentence). Compared against the RAW values, never a
 * scrubbed copy, so a control byte can change what a row looks like but never what it says a run did. `known: false`
 * (an outcome that is not an own key of `OUTCOME_WORDS`, `__proto__` included) has no word: the caller prints the value
 * itself, scrubbed or escaped, as a failure, which is what the panel always did with one.
 */
export function outcomeWord(outcome, reason) {
  if (typeof outcome !== "string" || !Object.hasOwn(OUTCOME_WORDS, outcome)) return UNKNOWN;
  if (typeof reason === "string" && Object.hasOwn(REASON_WORDS, reason) && REASON_WORDS[reason].outcome === outcome) {
    const q = REASON_WORDS[reason];
    return { known: true, word: q.word, glyph: q.glyph, tone: q.tone, status: q.status, qualified: true, says: q.says };
  }
  const o = OUTCOME_WORDS[outcome];
  return { known: true, word: o.word, glyph: o.glyph, tone: o.tone, status: o.status, qualified: false, says: false };
}

/** The five outcomes a person filters and counts by (issue #737): each word `outcomeWord` gives, as a query value. */
export const OUTCOME_KEYS = Object.freeze(["completed", "refused", "failed", "awaiting-input", "awaiting-approval", "cancelled"]);
const KEY_OF_WORD = Object.freeze({ completed: "completed", refused: "refused", failed: "failed", "awaiting input": "awaiting-input", "awaiting approval": "awaiting-approval", cancelled: "cancelled" });

/** A record's outcome key (`OUTCOME_KEYS`) from its outcome and reason; null for an outcome this release does not know. */
export function outcomeKey(outcome, reason) {
  const w = outcomeWord(outcome, reason);
  return w.known && Object.hasOwn(KEY_OF_WORD, w.word) ? KEY_OF_WORD[w.word] : null;
}

/**
 * Each outcome key's word and status, `{ word, status }`, as the runs page names a key in a list and a count: DERIVED
 * from `OUTCOME_WORDS` and `REASON_WORDS` (the first entry that says the key's word), so a key never reads otherwise
 * than the badge of a run it matches.
 */
export const OUTCOME_KEY_WORDS = Object.freeze(
  Object.fromEntries(
    OUTCOME_KEYS.map((key) => {
      const w = [...Object.values(OUTCOME_WORDS), ...Object.values(REASON_WORDS)].find((v) => KEY_OF_WORD[v.word] === key);
      return [key, Object.freeze({ word: w.word, status: w.status })];
    }),
  ),
);

/** A record's reason when it is a token (`RECORD_REASON_RE`), else null: a reason that is no token is shown to nobody. */
export function recordReason(record) {
  const r = record?.reason;
  return typeof r === "string" && RECORD_REASON_RE.test(r) ? r : null;
}

/** A sentence with a full stop, adding none where it ends in its own. */
export const stopped = (s) => `${s}${/[.!?]$/.test(s) ? "" : "."}`;

/**
 * The words a sentence uses to say that nothing changed. A planner's sentence is sent as it is (the `error` a tool and
 * the console share, byte for byte), and many already say so in their own words ("nothing was written", "Nothing was
 * sent", "nothing to cancel"); the slot adds "Nothing was changed." only to one that says none of them.
 */
export const SAYS_NOTHING_CHANGED = /\bnothing (?:was|is) (?:changed|done|applied|reverted|queued|sent|written)\b|\bnothing to (?:do|cancel)\b/i;

/** A refusal's sentence as a person reads it anywhere but the slot's bar: stopped, and saying nothing changed once. */
export const refusalLine = (sentence) => `${stopped(sentence)}${SAYS_NOTHING_CHANGED.test(sentence) ? "" : " Nothing was changed."}`;

/**
 * Whether one Valkey's kill switch answer (the read model's `switchOutcome` shape) says its set of queues may be short
 * (issue #964): the registry (`blind`) or the keyspace scan (`incomplete`) was not read whole, so a queue may exist that
 * the switch never named. True of an answer that switched every queue it named, too: that answer is the one that used
 * to say nothing.
 */
export function switchListShort(res) {
  return Boolean(res?.blind || res?.incomplete);
}

/**
 * What a sentence may say of ONE read of `key` that Valkey answered with `code` (issue #1036), by the code's class and
 * nothing past it (`replyErrorWords`, the worker's table): `said`, the key and the code; `first`, what has to be put
 * right before anything else, for a class that lasts, else null (a key of another type is removed or repaired; a
 * permission is the Valkey user's ACL, never the key; NOAUTH and WRONGPASS are the user and password this connects
 * with, never an ACL); `again`, whether "try again" is true, which it is of a passing
 * class alone; `lasting`, the class's own true, false or null; `waiting`, the clause the class allows about waiting, or
 * null. The words every admin surface that names a remedy builds its sentence from (the trigger edit's gate,
 * `dispatch_cancel`'s refusal, the kill switch's short note), so that an ACL user without HGETALL is never told to
 * remove a sound key, and a Valkey that was busy for a moment is never called a cause waiting does not end.
 */
export function erroredReadWords(key, code) {
  const { class: cls, lasting, waiting, first } = replyErrorWords(code);
  return { class: cls, lasting, waiting, said: `Valkey answers ${key} with ${code}`, first: first === null ? null : `${first.charAt(0).toUpperCase()}${first.slice(1)} first`, again: cls === "passing" };
}

/**
 * What a page that could not read the deployment says under its unread sentence where it still draws the kill
 * switch's two forms (issue #1035): why a form is there with nothing read, and what its answer will say.
 */
export const KILL_SWITCH_UNREAD_TEXT = "The kill switch works without a read: a pause reaches every queue it finds, and its answer names them.";

/** How a kill switch's short note names the look for queues, a read with no key of its own. */
const LOOK_FOR_QUEUES = "the look for queues";

/** The classes of a reply's code in the order a sentence names one read of several: what most needs a hand first. */
const SHORT_CAUSE_ORDER = Object.freeze(["key", "permission", "other", "passing"]);

/** How many errored reads a kill switch's cause keeps (the lists of hosts not read have the same bound). */
const SHORT_CAUSE_ERRORS_MAX = 20;

/**
 * WHY a kill switch's set of queues may be short (issue #1035), from one Valkey's answer or from several (the read
 * model's `switchOutcome` shape, whose `shortCause` says what its own discovery did not read): null for an answer that
 * is not short, else `{ waits, errors, more, lasting }`. Three causes, told apart because they ask different things of
 * a person. A read that got NO ANSWER, and host rows NOT READ IN TIME, wait on Valkey (`waits`). A read Valkey ANSWERED
 * WITH AN ERROR does not wait on anything by itself: what it asks is its code's class's (`erroredReadWords`), and
 * `errors` lists them, `{ key, code, class }`, a key of another type first, then a permission, then any other code,
 * then a passing state, at most twenty with `more` counting the rest. `key` is the key that was read (`host:live`, a
 * host's row) or null for the look for queues. `lasting` is the class of the first when it lasts ("key" or
 * "permission"), else null: the audit's word and a tool's answer carry it. An answer that says it is short without
 * saying why (an older shape, a discovery that threw) waits, which is what every short answer said before.
 */
export function switchShortCause(res) {
  const answers = (Array.isArray(res) ? res : [res]).filter((r) => switchListShort(r));
  if (answers.length === 0) return null;
  const keyOk = (key) => key === null || (typeof key === "string" && /^host:(?:live|h:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(key));
  const errors = answers
    .flatMap((r) => (Array.isArray(r.shortCause?.errors) ? r.shortCause.errors : []))
    .filter((e) => keyOk(e?.key ?? null) && typeof e?.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(e.code))
    .map((e) => ({ key: e.key ?? null, code: e.code, class: replyErrorClass(e.code) }));
  errors.sort((a, b) => SHORT_CAUSE_ORDER.indexOf(a.class) - SHORT_CAUSE_ORDER.indexOf(b.class));
  const more = answers.reduce((n, r) => n + (Number.isSafeInteger(r.shortCause?.more) && r.shortCause.more > 0 ? r.shortCause.more : 0), 0) + Math.max(0, errors.length - SHORT_CAUSE_ERRORS_MAX);
  const waits = errors.length === 0 || answers.some((r) => r.shortCause === null || typeof r.shortCause !== "object" || r.shortCause.waits !== false);
  const first = errors[0] ?? null;
  return { waits, errors: errors.slice(0, SHORT_CAUSE_ERRORS_MAX), more, lasting: first !== null && REPLY_ERROR_CLASSES[first.class].lasting === true ? first.class : null };
}

/**
 * What a fleet pause or resume whose set of queues may be short says (issue #964), on every surface that switches the
 * fleet: that other queues may exist and were not switched, and what to do. "Once Valkey answers", never once a page
 * reads it: a page can stay unread while the switch works (issue #986). Queue names never, so an audit row, the pi
 * extension and the CLI (`worker/src/cli.mjs`, held equal by a test over every cause) carry the same sentence.
 *
 * WHAT TO DO DEPENDS ON THE CAUSE (issue #1035, `switchShortCause`). With no cause given, or one that only waits, the
 * sentence is the one it always was: pause again once Valkey answers. That was said of every short list, also where
 * Valkey DID answer and the list is short for a reason that waiting does not end (`host:live` holding a string), so
 * each press gave the same advice again. Over a read answered with an error the sentence names the key and the reply's
 * code, then what the code's class supports: for a key of another type or a permission, "Waiting does not change
 * that" with the class's remedy before the switch is tried again; for a passing state, that a later read may succeed;
 * for any other code, no claim at all. Where one read was answered with an error and another got no answer, both are
 * said, the lasting one with its remedy. The remedy stands before the consequence on purpose: an audit row keeps 200
 * code points of a reason, and with the longest host name they still hold what to put right; with `host:live` or a
 * host name of ordinary length they hold the whole sentence.
 */
export function switchShortNote(paused, cause = null) {
  const p = switchShortParts(paused, cause);
  return p.named ? `the list of queues may be short: ${p.why}. ${p.advice}; ${p.rest}${p.tail}` : `the list of queues may be short: ${p.why}, so ${p.rest}. ${p.advice}`;
}

/**
 * How a part-way kill switch's answer closes when its set of queues may be short as well (issue #1035): that other
 * queues may exist, and what to do by the cause, the same parts as `switchShortNote`. Last in its sentence, since what
 * the switch reached leads there.
 */
export function switchShortThen(paused, cause = null) {
  const p = switchShortParts(paused, cause);
  const rest = `Other queues may exist and were not ${paused ? "paused" : "resumed"}`;
  return p.named ? `${rest}: ${p.why}. ${p.advice}${p.tail}` : `${rest}: ${p.advice.charAt(0).toLowerCase()}${p.advice.slice(1)}`;
}

/**
 * What a model is handed of the cause when a fleet pause or resume did not reach every queue and its set may be short
 * (issue #1035): the key and the code of the read Valkey answered with an error and what its class supports, as a
 * sentence, or "" where the cause only waits (the refusal's own closing words say that). Keys and a code, never a
 * queue's name or a Valkey's address.
 */
export function switchShortCauseSentence(paused, cause = null) {
  const p = switchShortParts(paused, cause);
  return p.named ? ` ${p.why.charAt(0).toUpperCase()}${p.why.slice(1)}. ${p.advice}${p.tail}.` : "";
}

/**
 * What a part-way switch whose set of queues may be short says FIRST on the `/dispatch` panel and its command (issue
 * #964): an audit row keeps the start of a sentence (200 code points), and at the end this was cut, or read past. With
 * its cause in a parenthesis where Valkey answered a read with an error (issue #1035): the key and the code, then for
 * a class that lasts what to put right first, for a passing state that a later read may succeed, and that another
 * read got no answer where one did not. A cause that only waits adds nothing, as before.
 */
export function switchShortLead(cause = null) {
  const named = Array.isArray(cause?.errors) && cause.errors.length > 0 ? cause.errors[0] : null;
  if (named === null) return "the list of queues may be short, so other queues may exist and were not switched; ";
  const w = erroredReadWords(named.key ?? LOOK_FOR_QUEUES, named.code);
  const then = w.first !== null ? `: ${w.first.charAt(0).toLowerCase()}${w.first.slice(1)}` : w.again ? `: ${w.waiting.charAt(0).toLowerCase()}${w.waiting.slice(1)}` : "";
  return `the list of queues may be short (${w.said}${then}${cause.waits === true ? "; another read got no answer" : ""}), so other queues may exist and were not switched; `;
}

/** The parts those sentences share: whether a read is named, why the list is short, what to do, what it leaves, and the count of the reads not named. */
function switchShortParts(paused, cause) {
  const again = `${paused ? "pause" : "resume"} the fleet again`;
  const Again = `${paused ? "Pause" : "Resume"} the fleet again`;
  const rest = `other queues may exist and were not ${paused ? "paused" : "resumed"}`;
  const named = Array.isArray(cause?.errors) && cause.errors.length > 0 ? cause.errors[0] : null;
  if (named === null) return { named: false, why: "the host registry or the look for queues could not be read whole", advice: `${Again} once Valkey answers`, rest, tail: "" };
  const w = erroredReadWords(named.key ?? LOOK_FOR_QUEUES, named.code);
  const others = cause.errors.length - 1 + (Number.isSafeInteger(cause.more) && cause.more > 0 ? cause.more : 0);
  // Last, after what to do: one read is named, the rest are counted.
  const tail = others > 0 ? ` (${others} more ${others === 1 ? "read was" : "reads were"} answered with an error)` : "";
  // "Remove or repair that key first" as the middle of a sentence: "remove or repair that key".
  const remedy = w.first === null ? null : `${w.first.charAt(0).toLowerCase()}${w.first.slice(1).replace(/ first$/, "")}`;
  // "then pause again", the fleet left unsaid: with it the commonest of these sentences (`host:live` holding a string)
  // was one code point past what an audit row keeps, and the row ended "were not pause".
  if (remedy !== null) return { named: true, why: w.said, advice: cause.waits === true ? `${w.waiting}: ${remedy}. Another read got no answer: ${again} once Valkey answers and that is put right` : `${w.waiting}: ${remedy}, then ${paused ? "pause" : "resume"} again`, rest, tail };
  if (cause.waits === true) return { named: true, why: `${w.said}, and another read got no answer`, advice: `${Again} once Valkey answers`, rest, tail };
  if (w.again) return { named: true, why: w.said, advice: `${w.waiting}: ${again}`, rest, tail };
  return { named: true, why: w.said, advice: `${Again} once the list can be read whole`, rest, tail };
}

/**
 * The queues of a part-way pause or resume whose switch Valkey ANSWERED with a refusal or an error (issue #1064), from
 * one Valkey's answer or from several (the read model's `switchOutcome` shape, `partial.codes`): `[{ queue, code,
 * class }]`, a key of another type first, then a permission, then any other code, then a passing state, each class in
 * the answer's own order. A queue name and the reply's code alone (one word of letters, digits and `_`), anything else
 * left out, so no client's words reach a page, a tool's answer or the audit.
 */
export function switchAnsweredCodes(res) {
  const answered = (Array.isArray(res) ? res : [res]).flatMap((r) => {
    const codes = r?.partial?.codes;
    if (codes === null || typeof codes !== "object" || Array.isArray(codes)) return [];
    return Object.entries(codes).filter(([queue, code]) => queue !== "" && typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(code)).map(([queue, code]) => ({ queue, code, class: replyErrorClass(code) }));
  });
  return SHORT_CAUSE_ORDER.flatMap((cls) => answered.filter((a) => a.class === cls));
}

/**
 * What a part-way fleet pause or resume says to do about a queue Valkey ANSWERED with a refusal or an error (issue
 * #1064), by the first such reply's code and nothing past it (`replyErrorWords`). Every part-way switch closed with
 * "Look at the fleet and try again"; over a queue one of whose keys holds a string, trying again is the same answer
 * again, on every press. So the sentence names the queue and the code, then what the code supports: for a key of
 * another type, that a key of that queue has to be removed or repaired, and then that queue switched; for a
 * permission, the Valkey user's ACL (the user and password for NOAUTH and WRONGPASS); for a passing state, that a
 * later try may succeed; for any other code, no claim, only to look before trying again. One queue is named and the
 * rest are counted. `answered` is `switchAnsweredCodes`' list, not empty.
 */
export function switchAnsweredThen(paused, answered) {
  const noun = paused ? "pause" : "resume";
  const [named] = answered;
  const w = replyErrorWords(named.code);
  const said = `Valkey answers the ${noun} of ${named.queue} with ${named.code}`;
  const tail = answered.length > 1 ? ` (${answered.length - 1} more ${answered.length === 2 ? "queue was" : "queues were"} answered with an error)` : "";
  if (w.class === "key") return `${said}: a key of that queue holds another kind of value. Trying again does not change that: ${w.first}, then ${noun} that queue${tail}`;
  if (w.class === "permission") return `${said}: ${w.means}. Trying again does not change that: ${w.first}, then ${noun} the fleet again${tail}`;
  if (w.class === "passing") return `${said}: ${w.means}. A later try may succeed: ${noun} the fleet again${tail}`;
  return `${said}. Look at the fleet before trying again${tail}`;
}

/**
 * The same for a model (issue #1064): the code and what its class supports, as a sentence, never a queue's name or a
 * Valkey's address. `code` is the first answered queue's (`switchAnsweredCodes`).
 */
export function switchAnsweredSentence(paused, code) {
  const noun = paused ? "pause" : "resume";
  const w = replyErrorWords(code);
  const said = `Valkey answered a queue's ${noun} with ${code}`;
  if (w.class === "key") return ` ${said}: a key of that queue holds another kind of value. Trying again does not change that: an operator has to ${w.first} first.`;
  if (w.class === "permission") return ` ${said}: ${w.means}. Trying again does not change that: an operator has to ${w.first} first.`;
  if (w.class === "passing") return ` ${said}: ${w.means}. A later try may succeed.`;
  return ` ${said}.`;
}

/**
 * What a queue whose pause or resume Valkey answered with an error after its script may have run (issue #1014) reads
 * as, read back: "paused" or "running", or "unknown" where Valkey answered that read with an error too (issue #1041).
 * That second error is an answer, so the queue stays one answered with an error, never one not confirmed, which is for a
 * read that got no answer. The console keeps no other value, so no client's words reach a page or the audit.
 */
export const SWITCH_ERRORED_READS = Object.freeze(["paused", "running", "unknown"]);

/** What a queue whose read back Valkey answered with an error too may have become (issue #1041), the CLI's words. */
export const SWITCH_READ_UNKNOWN = "its state could not be read, so it may have partly applied";

/**
 * One queue Valkey answered with an error after its script may have run (issue #1014), as the console's confirm, its
 * audit row, the panel's note and the `/dispatch` line name it: what it reads now, or `SWITCH_READ_UNKNOWN` (issue #1041).
 */
export function switchErroredQueue({ queue, reads }) {
  return `${queue} (${reads === "paused" || reads === "running" ? `reads ${reads} now` : SWITCH_READ_UNKNOWN})`;
}

/**
 * The queues a read left out because Valkey answered their read with an error (issue #1064): `[{ queue, error }]` off
 * `queueErrors`, the map `{ <queue>: <code> }` that the fleet reader's snapshot, `readQueueState`, the state API and
 * `pi-dispatch status` all carry under that one name. A queue name and the reply's code alone (one word of letters,
 * digits and `_`), anything else left out, so no client's words reach a page, a tool's answer or the audit. For every
 * surface: the console's pages and its switch previews, the `/dispatch` panel and its status line, the agent tools.
 */
export function queueErrorsOf(read) {
  const map = read?.queueErrors;
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  // `paused` (issue #1064, the read's `queueErrorsPaused`): the queue's paused flag where it WAS read and only its
  // counts were answered with an error, true or false; absent where the flag was not read.
  const flags = read?.queueErrorsPaused !== null && typeof read?.queueErrorsPaused === "object" && !Array.isArray(read.queueErrorsPaused) ? read.queueErrorsPaused : {};
  return Object.entries(map).filter(([queue, error]) => queue !== "" && typeof error === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(error)).map(([queue, error]) => ({ queue, error, ...(Object.hasOwn(flags, queue) && typeof flags[queue] === "boolean" ? { paused: flags[queue] } : {}) }));
}

/** How many queues `queueErrorsLead` names before it counts the rest (the switch previews' own bound, issue #737). */
export const QUEUE_ERRORS_NAMED = 20;

/**
 * How every surface starts what it says of those queues (issue #1053's words for a switch preview, shared since issue
 * #1064): "Not read, so not in these counts: pi-jobs@hostb (Valkey answered WRONGTYPE)", each queue with what Valkey
 * answered, at most `QUEUE_ERRORS_NAMED` named and then "and N more". What follows is the surface's own: a switch
 * preview says the switch is still sent, a page says the paused state is not known (`queueErrorsLine`). An entry
 * whose `error` is null is a queue whose read got no answer at all, which the status line names beside the others
 * (`readQueueState`'s `unavailableQueues`); `queueErrorsOf` never gives one. A queue whose paused flag WAS read
 * (`paused`, a boolean) says so in its own parenthesis: the error was its counts' alone, and it is paused or running.
 */
export function queueErrorsLead(errored) {
  const named = errored.slice(0, QUEUE_ERRORS_NAMED).map((e) => `${e.queue} (${e.error === null ? "no answer" : `Valkey answered ${e.error}${typeof e.paused === "boolean" ? ` for its counts; it is ${e.paused ? "paused" : "running"}` : ""}`})`).join(", ");
  return `Not read, so not in these counts: ${errored.length > QUEUE_ERRORS_NAMED ? `${named}, and ${errored.length - QUEUE_ERRORS_NAMED} more` : named}`;
}

/**
 * The one sentence for a page, the panel and the status line over such queues (issue #1064): which queues, what Valkey
 * answered, that they are in none of the counts beside it, and that whether they are paused is not known. Waiting does
 * not read them: the cause is a key Valkey answers with an error, which stays until it is repaired.
 */
export function queueErrorsLine(errored) {
  // "Whether it is paused is not known" only of a queue whose paused flag was not read (issue #1064). It was said of
  // every queue left out, also of one whose flag was read and whose counts alone were answered with an error; that
  // queue is said as it reads, in the lead, and the sentence closes on the others, or on nothing when there is none.
  const unknown = errored.filter((e) => typeof e.paused !== "boolean").length;
  if (unknown === 0) return queueErrorsLead(errored);
  if (unknown === errored.length) return `${queueErrorsLead(errored)}; whether ${errored.length === 1 ? "it is" : "they are"} paused is not known`;
  return `${queueErrorsLead(errored)}; whether the ${unknown === 1 ? "other is" : "others are"} paused is not known`;
}

/** Names in a sentence: "a", "a and b", "a, b and c". The order is the caller's. */
export function listed(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * A sentence's first letter in capitals: the planners write theirs in lower case, as the tools' errors read. Only when
 * it opens with a plain word: one that opens with an id (a job id's `gh-2f6a`, a queue's `pi-jobs@build3`, a model's
 * `anthropic/claude-opus-5-5`, a repository's `acme/web`) keeps the id as it is written, since "Gh-2f6a" names no job and
 * "Anthropic/claude-opus-5-5" names no model.
 */
export function capitalised(s) {
  const t = String(s ?? "");
  // A word is letters up to a space or a sentence's own punctuation; a dash, an at sign, an underscore, a slash or a digit,
  // or a colon or a full stop with no space after it, joins it into an id.
  return /^[a-z]+(?![a-z0-9@_/-]|[.:]\S)/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** A failed record with no reason (an older worker's untagged failure, or one whose reason was free text). */
export const NO_REASON_FAILED = "Failed: no reason was recorded. The worker that ran it predates the reasons for infrastructure exits.";

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
 * A list position as a person reads it (issue #737): the 0-based index a file, a tool and a form's `index` field
 * carry, as the 1-based number a row is called by ("trigger #1" is the first trigger). The pi panel and tools name
 * rows this way, as the planners' confirm titles already did (`#${index + 1}`). The console's Configuration page does
 * not yet: until its row buttons arrive its table, its "Row #" forms and its write sentences all use the page's own
 * 0-based index ("index N", `actions.mjs` `atIndex`), so that page never shows two numberings for one row. Anything that is not a safe integer of 0 or more is
 * "?", never a number it is not (a NaN, a negative, a string that looks like a number): the machine value stays the
 * index, and only its display goes through here.
 */
export function rowNumber(index) {
  return Number.isSafeInteger(index) && index >= 0 ? String(index + 1) : "?";
}

/** What a refusal calls a field whose name it will not print (`fieldNamed`). */
export const UNNAMED_FIELD = "a field it was sent";

/**
 * A field name as a refusal may print it (issue #737): a plain identifier of at most 40 characters is named, so the
 * sentence says which field to drop; anything else (a key with a space, a quote, a control, a homoglyph, 200
 * characters of it) is `UNNAMED_FIELD`, so a caller's bytes never travel into a sentence a page or a model reads. A
 * field's VALUE is never printed at all. The console's action table (`console/actions.mjs`) and the trigger add
 * (`write-plans.mjs` `planTriggerAdd`) both name a field through here, so the two refusals spell a key alike.
 */
export function fieldNamed(key) {
  return typeof key === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ? key : UNNAMED_FIELD;
}

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
 * drift from the first, AGENTS.md's "derived or pinned"). The rule, in order:
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
