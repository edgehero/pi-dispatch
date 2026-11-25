/**
 * What more than one screen's panels use (issue #737 split `../panels.mjs` by screen): the formatters, the action form
 * builders, the table and facts builders, the snapshot wrapper and a run's typed cost, then the helpers a screen's
 * section held that another screen reads too, each under a marker naming who shares it. The rules every
 * panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and run-text rule, the
 * action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header. The names exported at the end of
 * this module are shared between the screens' modules only; `../panels.mjs` does not re-export them.
 */
import { CHAT_REFUSALS, parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { DEFER_BUCKETS, DEFER_BUCKET_WORDS, DEFER_TIME_MAX_MS } from "@edgehero/pi-dispatch/defer-reasons";
import { hostKey } from "@edgehero/pi-dispatch/host-registry";
import { hostQueueName } from "@edgehero/pi-dispatch/queue";
import { replyErrorWords } from "@edgehero/pi-dispatch/reply-error-class";
import { formatMicros } from "@edgehero/pi-dispatch/money";
import { classifiedRows, refusedBeforeSpend } from "../../costs.mjs";
import { beatAgeOf } from "../../doctor-view.mjs";
import { fmtCost, usd2 } from "../../panel.mjs";
import { resolveWorkerCount, forgeLinkOf, progressStaleFor } from "../../read-model.mjs";
import { parseRunFilter } from "../../run-filter.mjs";
import { outcomeNote } from "../../loaded-words.mjs";
// The one vocabulary the panel reads too (issue #710): outcome words and tones, the venue label, the Spend and Held titles.
import { KILL_SWITCH_UNREAD_TEXT, NO_EXPLANATION, NO_REASON_FAILED, listed, outcomeKey, outcomeWord, queueErrorsLine, queueErrorsOf, reasonWords, recordReason, shortSentence } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { fileCaseOfView } from "../../file-case.mjs";
import { mirrorUnread } from "../../mirror-words.mjs";
import { SCHEDULES_PART_TEXT } from "../../trigger-list.mjs";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- formatting ------------------------------------------------------------------------------------------------------

/** A value as cell text: `-` for nothing. */
function cell(v) {
  return v === null || v === undefined || v === "" ? "-" : v;
}

/** A duration in the panel's words (`45s`, `12m`, `3h 5m`, `2d 4h`), or "unknown" for a value that is not one. */
export function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < MIN) return `${Math.floor(ms / SEC)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

/**
 * An instant as `YYYY-MM-DD HH:MM UTC` (never the reader's zone, so a page is the same bytes everywhere). Only from 0 to
 * the defer leaf's `DEFER_TIME_MAX_MS`, the year 9999's last instant: outside it the ISO string's year is not four
 * digits, and its first sixteen characters are a date that is not the instant's, so it is "unknown".
 */
export function utcText(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > DEFER_TIME_MAX_MS) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * An instant as a `<time>` element (issue #710): `utcText`'s bytes as its text, so a page without the script reads UTC
 * exactly as before, and the instant in `datetime` (ISO 8601, UTC), which the browser script (`script.mjs`) rewrites to
 * the reader's local time, keeping the UTC text in `title`. The server never formats a zone it does not know: a page is
 * the same bytes for every reader, and only the reader's own browser knows the reader's zone. "unknown" stays plain text.
 */
export function timeHtml(ms) {
  const text = utcText(ms);
  if (text === "unknown") return text;
  return html`<time datetime="${new Date(ms).toISOString()}">${text}</time>`;
}

/** A record's ISO instant as millis, or NaN. */
const msOf = (iso) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);

/** Micro-dollars as `$1.20`, `-` for a value that is not an amount. */
export function usdText(micros) {
  return Number.isSafeInteger(micros) && micros >= 0 ? `$${formatMicros(micros)}` : "-";
}

/**
 * Micro-dollars for a list row or an overview line (issue #710): `usd2`'s one fixed form, `$1,234.56`, with the exact
 * amount (`usdText`, every digit the counter holds) in the `title`, so a reader sees a number they can read at a glance
 * and can still hover for the one the ledger holds. `spent: true` for an amount read against a cap, which `usd2` rounds
 * DOWN, so a window one micro-dollar short of its cap never reads as the cap. `-` for a value that is not an amount.
 * Review round 1: the panel's `fmtUsd` was here first, and its ladder printed `$99.99`, `$412` and `$4.1k` in one
 * column, so two rows of a table were not comparable at a glance.
 */
export function moneyHtml(micros, { spent = false } = {}) {
  const full = usdText(micros);
  if (full === "-") return full;
  return html`<span title="${full}">${usd2(micros, { spent })}</span>`;
}

/** A whole number with thousands separators (fixed to `en-US`, so not the host's locale). */
function count(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-";
}

/** A path shown by its basename; anything that is not a path is shown as it is. */
export function shownPath(v) {
  if (typeof v !== "string" || !(v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v))) return v;
  // Either separator: a deployment on Windows writes its folders with backslashes, which `basename` here would not split.
  return `.../${v.split(/[\\/]/).filter(Boolean).pop() ?? ""}`;
}

/**
 * A run id as the worker mints them (`gh-…`, `repeat:<id>:<ms>`, a uuid), the read model's own charset, bounded: what
 * `/run?id=` takes (`parsePageQuery`) and so what a run link may carry.
 */
export const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * A link to one run's detail page. The id travels in the query string, encoded, and is escaped as text. An id outside
 * `RUN_ID_RE` (a hand-written or foreign mirror record) is shown as plain escaped text: `/run` would answer it 400.
 */
function runLink(jobId, { pulse = false } = {}) {
  const cls = pulse ? "code" : "mono";
  if (jobId === null || jobId === undefined || jobId === "") return "-";
  if (!RUN_ID_RE.test(String(jobId))) return html`<span class="${cls}">${cell(jobId)}</span>`;
  return html`<a class="${cls}" href="${`/run?${new URLSearchParams({ id: String(jobId) })}`}">${String(jobId)}</a>`;
}

/**
 * A record's target, linked to the forge when `forgeLinkOf` can build a link from the deployment's own env, else plain
 * text. `rel="noreferrer noopener"` with `target="_blank"`: the forge page gets no handle on this window and no Referer.
 */
function targetLink(record, env) {
  const target = record?.target;
  if (typeof target !== "string" || target === "") return "-";
  const url = forgeLinkOf(record, env ?? {});
  // forgeLinkOf only builds http(s) URLs; this belt keeps any other scheme out of an href whatever it returns.
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return html`<span class="mono">${target}</span>`;
  return html`<a class="mono" href="${url}" rel="noreferrer noopener" target="_blank">${target}</a>`;
}

/** A panel's heading plus body. */
const titled = (title, body) => html`<h2>${title}</h2>${body}`;

// ---- unread is not empty (issue #844) --------------------------------------------------------------------------------

/** In place of a host fact where nothing was read about the hosts: never "none", "gone" or a zero. */
export const HOSTS_UNREAD = "not known: the hosts could not be read";

/** The same as a sentence of its own. */
export const HOSTS_UNREAD_TEXT = "The hosts could not be read, so what they hold is not known. The next refresh tries again.";

/**
 * Whether NOTHING was read about the hosts: no snapshot at all, or one whose registry read failed before any had
 * succeeded (`queue.fleetDegraded` with `hostsReadAt` null). A degraded read after a good one still shows the rows as
 * they were last seen, which the panels say in their own sentence, so that is not this; nor is a registry read in part
 * (issue #1062, `registryReadInPart`), whose rows that answered are shown, and whose `hostsReadAt` is that read's.
 */
export const hostsUnread = (snapshot) => !snapshot || (Boolean(snapshot.queue?.fleetDegraded) && snapshot.queue?.registryReadInPart !== true && snapshot.hostsReadAt === null);

/**
 * Whether THIS read of the registry failed after an earlier one succeeded (issue #1073): `queue.fleetDegraded`, not a
 * read in part, with `hostsReadAt` set. The rows the reader holds are then as they were last read, which every list of
 * hosts drawn from them says ("as last read"), and none of them is "no live host": that was the last read's answer, not
 * this one's. `hostsUnread` is false here, which is why it cannot be the test.
 */
export const hostsAsLastRead = (snapshot) => Boolean(snapshot?.queue?.fleetDegraded) && snapshot?.queue?.registryReadInPart !== true && snapshot.hostsReadAt !== null;

/** A list of hosts' names over such a read, or none, with the words that say so (issue #1073). */
export const HOSTS_AS_LAST_READ = "as the registry was last read";
export const NO_HOST_AS_LAST_READ = "no host when the registry was last read";

/** Whether the snapshot's registry was read in part (issue #1062): it answered, some hosts' rows did not in time. */
export const registryReadInPart = (snapshot) => Boolean(snapshot?.queue?.fleetDegraded) && snapshot?.queue?.registryReadInPart === true;

/**
 * Whether a host row is drawn "as last seen", its beat and slots not judged: every row while the registry could not be
 * read, and over a registry read in part (issue #1062) only a row that read did not reach (`notRead`); a row it read is
 * current and is drawn as such.
 */
/** A beat count over a registry read in part (issue #1062) whose floor is 0: no "at least 0". */
export const NO_BEAT_READ = "no host's beat was read";

export const rowLastSeen = (snapshot, h) => Boolean(snapshot?.queue?.fleetDegraded) && (snapshot?.queue?.registryReadInPart !== true || h?.notRead === true);

/**
 * What a panel says over a registry read in part (issue #1062) that NAMES NO HOST it did not read (a snapshot of an
 * older shape; the reader names them since issue #1036, and `registryPartText` then says each): the rows that answered
 * are this read's, a host read before is as it was last seen, and one this console never read has no row at all.
 * "Were not read", not "did not answer in time": a row Valkey answered with an error did answer. It said "so those
 * hosts are as they were last seen" of every host not read, which is false of one never read here (issue #1036).
 */
export const REGISTRY_PART_TEXT = "The host registry was read in part: some hosts' rows were not read. A host read before is as it was last seen, and one never read here has no row.";

/** A reply's code as the snapshot may hold it: one word of letters, digits and `_`, anything else null. */
const codeOf = (value) => (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value) ? value : null);

/**
 * What a page says of ONE read of `key` that Valkey answered with `code` (issue #1036), by the code's class and
 * nothing past it (`replyErrorWords`, the worker's table): what was answered, what that means, and whether waiting
 * ends it. A key of another type and a permission last until someone puts them right, and the sentence names what;
 * a passing state may be gone at the next read; of any other code nothing is claimed. So no page promises "the next
 * refresh tries again" of a row that the next refresh will read exactly as this one did.
 */
export function erroredReadSentence(key, code) {
  const w = replyErrorWords(code);
  const said = `Valkey answers ${key} with ${code}`;
  if (w.class === "key" || w.class === "permission") return `${said}: ${w.means}. ${w.waiting}: an operator has to ${w.first} first.`;
  if (w.class === "passing") return `${said}: ${w.means}. ${w.waiting}.`;
  return `${said}.`;
}

/**
 * The hosts of a registry read in part whose rows were not read (the snapshot's `queue.unreadHosts`, issue #1036), as
 * a page names them: `[{ name, error, key, kept }]`. `error` is the code Valkey answered the row with, or null for a
 * row that got no answer; `key` the row's key, which a remedy names; `kept` whether this console read the host before
 * and still holds that row (`hostBudgets` holds it, marked `notRead`). One that is not kept was NEVER read here: it
 * has no row on any page, and its own queue, which only its row names, is in no set a read asks.
 */
export function unreadHostsOf(snapshot) {
  if (!registryReadInPart(snapshot)) return [];
  const kept = new Set((Array.isArray(snapshot.hostBudgets) ? snapshot.hostBudgets : []).filter((h) => h?.notRead === true).map((h) => h.name));
  return (Array.isArray(snapshot.queue.unreadHosts) ? snapshot.queue.unreadHosts : [])
    .filter((u) => typeof u?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(u.name))
    .map((u) => ({ name: u.name, error: codeOf(u.error), key: hostKey(u.name), kept: kept.has(u.name) }));
}

/** How many more hosts that read did not read than `unreadHostsOf` names (the snapshot's `queue.unreadHostsMore`). */
const unreadHostsMore = (snapshot) => (Number.isSafeInteger(snapshot?.queue?.unreadHostsMore) && snapshot.queue.unreadHostsMore > 0 ? snapshot.queue.unreadHostsMore : 0);

/**
 * The sentences for the rows Valkey answered with an error, one per code: every key that got it, then what the code
 * means and whether waiting ends it (`erroredReadSentence`). Null where no row was answered with one.
 */
function unreadHostCodes(unread) {
  const codes = [...new Set(unread.map((u) => u.error).filter((code) => code !== null))];
  if (codes.length === 0) return null;
  return codes.map((code) => erroredReadSentence(listed(unread.filter((u) => u.error === code).map((u) => u.key)), code)).join(" ");
}

/**
 * What a panel says over a registry read in part (issues #1062 and #1036): which hosts' rows were not read, what
 * became of each on this console (one read before is drawn as it was last seen; one never read here has no row), and
 * for a row Valkey answered with an error, its key, the code and what the code asks. It was one sentence for every
 * such read, "some hosts' rows were not read, so those hosts are as they were last seen": it named no host, no key and
 * no code, and it was false of a host this console never read, which is drawn nowhere.
 */
export function registryPartText(snapshot) {
  const unread = unreadHostsOf(snapshot);
  if (unread.length === 0) return REGISTRY_PART_TEXT;
  const more = unreadHostsMore(snapshot);
  const nor = more > 0 ? `, nor ${more === 1 ? "was 1 more host's" : `were ${more} more hosts'`}` : "";
  const codes = unreadHostCodes(unread);
  const tail = codes === null ? "" : ` ${codes}`;
  // One host: "it". A sentence never opens with a host's name, which is written as it is and takes no capital.
  if (unread.length === 1) return `The host registry was read in part. The row of ${unread[0].name} was not read${nor}: ${unread[0].kept ? "it is as it was last seen" : "this console never read it, so it has no row"}.${tail}`;
  const kept = unread.filter((u) => u.kept).map((u) => u.name);
  const never = unread.filter((u) => !u.kept).map((u) => u.name);
  const became = [
    ...(kept.length > 0 ? [`${listed(kept)} ${kept.length === 1 ? "is as it was" : "are as they were"} last seen`] : []),
    ...(never.length > 0 ? [`${listed(never)} ${never.length === 1 ? "was never read here, so it has" : "were never read here, so they have"} no row`] : []),
  ].join("; ");
  return `The host registry was read in part. The rows of ${listed(unread.map((u) => u.name))} were not read${nor}: ${became}.${tail}`;
}

/**
 * What ONE host's page says where that host's row was not read (`unreadHostsOf` names it), or null for a host that
 * read did reach or does not name: the row's key and what Valkey answered it with, and whether what is drawn is the
 * row as last seen or nothing at all.
 */
export function unreadHostText(snapshot, name) {
  const u = unreadHostsOf(snapshot).find((entry) => entry.name === name);
  if (u === undefined) return null;
  const answered = u.error === null ? `The row of ${u.name} (${u.key}) was not read this time.` : erroredReadSentence(u.key, u.error);
  return `${answered} ${u.kept ? "What is drawn here is the row as it was last seen." : `This console never read that row, so nothing here says whether ${u.name} is live, late or gone.`}`;
}

/**
 * What a registry read in part says of a host that has NO row here (issue #1036), by what that read names:
 * "unread", this host's row is one it did not read (`unreadHostText` says its key and what Valkey answered);
 * "unnamed", the read names no host it did not read, or not every one, so this may be one of them; null, the read
 * names every host it did not read and this is none of them, so its row was not there to read: the host has gone.
 * Every such host was "not known" before, also one the registry had answered about in full. Null too where the
 * registry was not read in part at all.
 */
export function hostPartCase(snapshot, name) {
  if (!registryReadInPart(snapshot)) return null;
  const unread = unreadHostsOf(snapshot);
  if (unread.some((u) => u.name === name)) return "unread";
  return unread.length === 0 || unreadHostsMore(snapshot) > 0 ? "unnamed" : null;
}

/**
 * Whether a host's OWN queue may exist that the snapshot's reads did not ask (issues #962 and #1036): the hosts' own
 * queues are named by their rows, so while the registry was never read only the shared queue is asked, and after a
 * read in part the queue of a host never read here is in no set (`unreadHostsOf`, a host that is not `kept`; hosts
 * past the ones the snapshot names count too, since nothing says they are kept). The lists read queue by queue (the
 * running jobs, the schedules) are floors then, FOR THAT HOST'S QUEUE: every queue that was asked answered or says so
 * itself.
 */
export function hostQueuesUnasked(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return false;
  if (Boolean(snapshot.queue?.fleetDegraded) && snapshot.queue?.registryReadInPart !== true && snapshot.hostsReadAt === null) return true;
  return unreadHostsOf(snapshot).some((u) => !u.kept) || (registryReadInPart(snapshot) && unreadHostsMore(snapshot) > 0);
}

/**
 * Why the lists read queue by queue are floors where the cause is a host's own queue that NO READ ASKED after a
 * registry read in part (issue #1036: a host whose row was not read and that this console never read before), or
 * null for any other cause. Every queue that was asked may have answered: "The running jobs could not be read, so
 * what runs is not known. The next refresh tries again." was false of it three times over, since they were read, what
 * runs in the queues asked is known, and the next refresh reads a row that Valkey answers with an error as this one
 * did. What is missing is that one queue, and the sentence says whose.
 */
export function unaskedQueuesText(snapshot) {
  if (!registryReadInPart(snapshot)) return null;
  const never = unreadHostsOf(snapshot).filter((u) => !u.kept).map((u) => u.name);
  if (never.length === 0) return unreadHostsMore(snapshot) > 0 ? "A host's own queue may not have been asked: it is named by the host's row, and not every row was read. A job running there is not listed here." : null;
  return `${never.length === 1 ? `The queue of ${never[0]} was` : `The queues of ${listed(never)} were`} not asked: a host's own queue is named by its row, and this console never read ${never.length === 1 ? "that row" : "those rows"}. A job running there is not listed here.`;
}

/**
 * What a host's page lacks of the running jobs where the fleet's active list is not whole (`activeUnreachable`), or
 * null where nothing of THIS host's is missing (issue #1036). A page draws a running job on a host only where the
 * host's own row names it (the reader takes a job's host from the ids each host publishes), so what can be missing on
 * its page is exactly a job the row names that no queue's list held. `{ kind }`:
 *
 *   - "unasked": the host has no row and is one this console never read, so its own queue, which only its row names,
 *     was asked by no read.
 *   - "unknown": no row, a row as last seen, or a row whose own list is cut or unreadable: the row cannot vouch for
 *     the page.
 *   - "missing", with `missing`, how many: a row read this time that names running jobs the page does not draw.
 *   - null: a row read this time, its list whole, and every job of it drawn. Nothing is missing, whatever queue
 *     elsewhere was not read or not asked.
 *
 * One rule for the host's Jobs card and for the pill there, so the page is Not live exactly where the card says so.
 */
export function hostActiveGap(snapshot, name) {
  if (snapshot === null || typeof snapshot !== "object" || snapshot.activeUnreachable !== true) return null;
  const h = (Array.isArray(snapshot.hostBudgets) ? snapshot.hostBudgets : []).find((row) => row?.name === name) ?? null;
  if (h === null && unreadHostsOf(snapshot).some((u) => u.name === name && !u.kept)) return { kind: "unasked" };
  // A row read this time: one the registry's last read reached (`rowLastSeen` is every row while it could not be
  // read, and over a read in part a row it did not reach).
  if (h === null || rowLastSeen(snapshot, h) || h.jobsUnreadable || h.jobsMore) return { kind: "unknown" };
  const drawn = new Set((Array.isArray(snapshot.active) ? snapshot.active : []).filter((j) => j?.host === name).map((j) => String(j.jobId)));
  const missing = (Array.isArray(h.jobs) ? h.jobs : []).filter((j) => !j?.o && typeof j?.id === "string" && !drawn.has(j.id)).length;
  return missing === 0 ? null : { kind: "missing", missing };
}

/**
 * The one sentence over queues Valkey answered with an error (issue #1064, `queueErrorsLine`: which queues, what was
 * answered, that they are in none of the counts, and whether they are paused), or null where every queue was read.
 * One helper, so the overview's queue row, Fleet, a host and a venue say it in the same words.
 */
export function queueErrorsText(snapshot) {
  const errored = queueErrorsOf(snapshot);
  return errored.length === 0 ? null : `${queueErrorsLine(errored)}.`;
}

/**
 * Of those queues, the ones a job on host `name` can be in: the host's own queue and the shared one (a queue with no
 * host in its name). What a host's page says of an errored queue, and what the pill follows there: another host's own
 * queue holds no job of this host, and its page draws no count that queue is missing from.
 */
export function hostQueueErrorsOf(snapshot, name) {
  if (typeof name !== "string" || name === "") return [];
  return queueErrorsOf(snapshot).filter((e) => hostQueueOf(name)(e.queue));
}

// ---- the waiting set's short marks (issue #1037) -------------------------------------------------------------------

/** The one sentence for a waiting read cut by a bound of its own: its bound on queues, or a queue's on jobs. */
export const WAITING_CUT_TEXT = "Not every waiting job was read, so jobs in line may be missing here.";

/** The one sentence for a waiting read whose set of queues may be short (`queuesShort`, issue #963). */
export const WAITING_QUEUES_SHORT_TEXT = "Not every queue could be found, so jobs waiting in a queue that was not asked may be missing here.";

/** A waiting row whose bucket rests on a paused flag that was not read (`pausedUnknown`, issue #1036): its one line. */
export const PAUSED_UNKNOWN_TEXT = "Waits for a free slot or on a pause: whether its queue is paused could not be read";

/** The queues of one of the waiting read's coded lists (`listsUnread`, `pausedUnread`), `[{ queue, error }]`. */
const codedQueues = (list) => (Array.isArray(list) ? list : []).filter((e) => typeof e?.queue === "string" && e.queue !== "").map((e) => ({ queue: e.queue, error: codeOf(e.error) }));
/** Those queues in a sentence, each with what Valkey answered: "pi-jobs (Valkey answered WRONGTYPE)". */
const codedNames = (queues) => listed(queues.map((e) => `${e.queue} (${e.error === null ? "no answer" : `Valkey answered ${e.error}`})`));

/**
 * WHY A WAITING READ'S ROWS ARE A FLOOR (issue #1037), or null over a read that is whole (and over one that was not
 * made or failed, which a page says in its own sentence). Four causes, each the reader's own mark, and a reader of the
 * rows that looks at `truncated` alone knew one of them:
 *
 *   - `lists`: a queue's list was not read (`listsUnread`, issue #1036: an error reply, or no answer), `[{ queue,
 *     error }]`. The jobs in that list are in no row. A read that failed.
 *   - `short`: the set of queues may not be every queue (`queuesShort`, issue #963: the host registry was not read, or
 *     the keyspace look that finds a stopped host's queue was not whole). A read that failed.
 *   - `cut`: the read stopped at its bound on queues (`queuesCut` of them not read).
 *   - `full`: a queue holds more waiting jobs than one read takes.
 *
 * `unread` is whether a read FAILED (the first two): the live pill follows that, never a bound, since a list that is
 * full is read. `text` says each cause that holds, the failed reads first (`failedText` those alone, or null); every
 * count over such rows is "at least".
 *
 * `of` (optional) is a predicate on a queue's name, for a reader of SOME queues' rows (a host's page reads its own
 * queue's and the shared one's): a list not read, or a queue that is full, counts only where it is one of them. The
 * bound on queues and a short set are no queue's in particular, so they hold for every reader.
 */
export function waitingFloor(w, of = null) {
  if (w === null || typeof w !== "object" || w.unreachable || !Array.isArray(w.rows)) return null;
  const mine = (queue) => of === null || of(queue);
  const lists = codedQueues(w.listsUnread).filter((e) => mine(e.queue));
  const short = w.queuesShort === true;
  const cut = Number.isSafeInteger(w.queuesCut) && w.queuesCut > 0 ? w.queuesCut : 0;
  const perQueue = Array.isArray(w.byQueue) ? w.byQueue.filter((q) => typeof q?.queue === "string") : [];
  const full = perQueue.some((q) => q.truncated === true && q.listsUnread !== true && mine(q.queue));
  // Whole for the queues asked about: no list of theirs unread, none of them full, no queue past the bound (which
  // may be one of them), the set of queues not short; and, for a read that says it is cut and not where (an older
  // shape with no `byQueue`), not cut at all.
  if (lists.length === 0 && !short && cut === 0 && !full && !(w.truncated === true && (of === null || perQueue.length === 0))) return null;
  const failed = [
    ...(lists.length > 0 ? [`A list of waiting jobs could not be read: ${codedNames(lists)}. Jobs waiting there may be missing here.`] : []),
    ...(short ? [WAITING_QUEUES_SHORT_TEXT] : []),
  ];
  // The bound's own sentence, also for a read that says it is cut and not how (an older shape).
  const bound = cut > 0 || full || failed.length === 0;
  return { lists, short, cut, full, unread: failed.length > 0, failedText: failed.length > 0 ? failed.join(" ") : null, text: [...failed, ...(bound ? [WAITING_CUT_TEXT] : [])].join(" ") };
}

/**
 * The queues whose paused flag the waiting read did not read (`pausedUnread`, issue #1036), `{ queues, text }`, or
 * null. Their rows are all there, so nothing is a floor; what is not known is whether a job in the wait list waits
 * for a free slot or on a pause, and the reader keeps such a row apart (`pausedUnknown`, see `waitBucketOf`).
 */
export function waitingPausedUnread(w, of = null) {
  if (w === null || typeof w !== "object" || w.unreachable) return null;
  const queues = codedQueues(w.pausedUnread).filter((e) => of === null || of(e.queue));
  if (queues.length === 0) return null;
  return { queues, text: `Whether a queue is paused could not be read: ${codedNames(queues)}. A job in its wait list waits for a free slot or on a pause, and which is not known.` };
}

/**
 * The reasons a page groups the waiting jobs by: the worker's buckets, and one more, for a row whose bucket rests on a
 * paused flag that was not read (`pausedUnknown`, issue #1036). The reader keeps such a row in `unknown`, which is
 * neither `slot` nor `paused`; that bucket's words are "A reason this console does not know", which is false of it
 * (the job recorded no reason; what is not known is its queue's flag), so a page draws it under its own.
 */
export const PAUSED_UNKNOWN_BUCKET = "slot-or-pause";
export const WAIT_BUCKETS = Object.freeze(DEFER_BUCKETS.flatMap((b) => (b === "paused" ? [b, PAUSED_UNKNOWN_BUCKET] : [b])));
export const WAIT_BUCKET_WORDS = Object.freeze({ ...DEFER_BUCKET_WORDS, [PAUSED_UNKNOWN_BUCKET]: Object.freeze({ title: "A free slot or a pause: the queue's paused flag could not be read", short: "Slot or pause, not known" }) });
/** The reason a page draws a waiting row under (`WAIT_BUCKETS`). */
export const waitBucketOf = (row) => (row?.pausedUnknown === true ? PAUSED_UNKNOWN_BUCKET : Object.hasOwn(DEFER_BUCKET_WORDS, row?.bucket) ? row.bucket : "none");

// ---- the schedules read in part (issue #986) -----------------------------------------------------------------------

/** Whether the snapshot's schedule list is not whole (`schedulersReadInPart`): a host queue's read failed or was not asked. */
export const schedulesShort = (snapshot) => snapshot?.schedulersReadInPart === true;
/** The one sentence over such a list (`trigger-list.mjs` holds it, for the Triggers page's own model), handed on. */
export { SCHEDULES_PART_TEXT };
/** A count of schedules: "3 schedules", and "at least 3 schedules" over a list read in part. */
export const schedulesCount = (snapshot, noun = "schedule") => {
  const n = Array.isArray(snapshot?.schedulers) ? snapshot.schedulers.length : 0;
  // A floor of none is "none was read", never "at least 0".
  if (schedulesShort(snapshot)) return n === 0 ? `no ${noun} was read` : `at least ${n} ${n === 1 ? noun : `${noun}s`}`;
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
};

/**
 * A read that answered that it could not reach what it reads (`unreachable`, a word or true), which is how the
 * readers answer an outage.
 */
const unreached = (read) => read !== null && typeof read === "object" && Boolean(read.unreachable);

/**
 * Whether the fleet mirror's word says it did not answer: the one rule of `mirror-words.mjs`, which every reader of the
 * word asks (issue #988). It knew two of the words of a mirror that answered and not an agent's "bounded", so an
 * agent's `/runs` said other hosts' runs could not be read, with a Not live pill, over a healthy mirror for good.
 */
export { mirrorUnread };

/**
 * A page of the run history read without one of its sides: this host's files (`unreachable`), or a fleet mirror that
 * is on and did not answer (`mirrorUnread`). A mirror that is off is a whole answer: there are no other hosts' runs
 * to hold.
 */
const historyPartUnread = (page) => page !== null && typeof page === "object" && (Boolean(page.unreachable) || mirrorUnread(page.mirror));

/** The 24 hours' window that could not be folded (null), or was folded without a side of the history (`partial`). */
const windowUnread = (window) => window === null || window?.partial === true;

/**
 * A host's run records that could not be read: a history that failed (null), or an empty one read without one of its
 * sides (`historyPartUnread`: the reader does not throw in an outage, it answers no runs and says which side it lacks,
 * a fleet mirror that is neither "ok" nor "off", or this host's own run files, `unreachable`). Neither is a host no
 * record names. The host page's sentence and the pill's mark are this one rule. The run files were not in it (issue
 * #988): with them not listed the page said "No retained run record names this host." of records nobody read.
 */
export const hostHistoryUnread = (history) => history === null || (history !== undefined && !history.records?.length && historyPartUnread(history));

/**
 * Why a run's page cannot tell that its shell is absent from the open shells (issue #988), from what the sandbox
 * service and the browser gateway say of their lists: "unread", a read that did not answer; "cut", the list holds the
 * first `SHELLS_SHOWN` of more; "rows", a registration in it does not parse; null where the lists are whole. Only the
 * first is a read that failed: a full list said "could not be read", with a Not live pill, for as long as that many
 * shells stayed open. A list that says only that it is not whole (no reason beside it) is taken as unread.
 */
export const SHELLS_SHOWN = 256;
export function shellsShort(data) {
  const w = data?.workspace, g = data?.browserGateways;
  if (!(w?.sessionsUnknown === true || g?.partial === true)) return null;
  const more = Math.max(Number(w?.sessionsMore) || 0, Number(g?.more) || 0), rows = Math.max(Number(w?.sessionsUnreadable) || 0, Number(g?.unreadable) || 0);
  if (w?.sessionsUnread === true || g?.unread === true || (more === 0 && rows === 0)) return "unread";
  return more > 0 ? "cut" : "rows";
}

/**
 * The same for Sandboxes' cleanup notices: "unread", "cut" or "rows" from what the report says beside
 * `noticesUnavailable`, null where the notices are whole.
 */
export function noticesShort(report) {
  if (!report?.noticesUnavailable) return null;
  if (report.noticesUnread === true || (report.noticesMore !== true && report.noticesUnreadable !== true)) return "unread";
  return report.noticesMore === true ? "cut" : "rows";
}

/**
 * The kept workspace Sandboxes was opened for (`sandboxPicked`, the id and host its query names), where the report
 * holds a row for it: the card that says what its run loaded is drawn for that row alone.
 */
const pickedWorkspace = (d) => {
  const want = d.sandboxPicked;
  if (want === null || typeof want !== "object" || typeof want.id !== "string") return false;
  return (Array.isArray(d.sandboxes?.hosts) ? d.sandboxes.hosts : []).some((h) => (!want.host || h?.name === want.host) && (Array.isArray(h?.rows) ? h.rows : []).some((r) => (r?.id ?? r?.jobId) === want.id));
};

/**
 * What the hosts last published about their doctor runs, for Sandboxes' cards that say what a host could load: the
 * page's read, or the reader's own answer for an outage where the page's read threw or was cut (`hostLoadsUnread`,
 * issue #988). Null alone is a console that wires no such read; a card drawn from a read that failed as if it were
 * null said "it has published no doctor run" of hosts nobody could ask.
 */
export const hostLoadsOf = (data) => data?.hostLoads ?? (data?.hostLoadsUnread === true ? { unreachable: true, hosts: [], more: 0 } : null);

/** A snapshot read with one of `parts` unread (`{ unreachable }`, each part's reader's own answer in an outage). */
const partUnread = (s, parts) => s !== null && typeof s === "object" && parts.some((part) => unreached(s[part]));

/**
 * A snapshot whose waiting read holds a mark of a read that FAILED beside one that did not answer at all (issues
 * #1037 and #1036): a list of a queue not read, a set of queues that may be short, or a queue's paused flag not read,
 * each of which a card of the page says in words (`waitingFloor`, `waitingPausedUnread`). Never a bound: a list that
 * is full was read. A snapshot that holds no waiting read made none, which is no mark.
 */
const waitingMarked = (s, of = null) => s !== null && typeof s === "object" && s.waiting !== null && typeof s.waiting === "object" && !s.waiting.unreachable && (waitingFloor(s.waiting, of)?.unread === true || waitingPausedUnread(s.waiting, of) !== null);

/** Whether a queue is one a job of host `name` can wait in: its own, or the shared one (no host in its name). */
export const hostQueueOf = (name) => (queue) => queue === hostQueueName(name) || queue.indexOf("@") < 0;

/**
 * Whether a settings view is of an overlay that was read and is refused (issue #988): it "does not load", which is
 * not a read that failed. The settings reader folds a file nobody could read into the same `invalid`, with these
 * words first, and that one "could not be read".
 */
export const overlayRefused = (read) => read !== null && typeof read === "object" && fileCaseOfView(read) === "refused";

/**
 * A settings overlay the snapshot holds and that was not read: a file nobody could read, or a view that holds no
 * overlay, which the overview's Caps card says could not be read. A file that does not exist is an empty overlay,
 * read; one that was read and is refused does not load (`overlayRefused`), and the card says that.
 */
const overlayUnread = (s) => {
  const read = s !== null && typeof s === "object" ? s.settings : undefined;
  if (read === undefined || overlayRefused(read)) return false;
  return !(read !== null && typeof read === "object" && !read.invalid && read.overlay !== null && typeof read.overlay === "object" && !Array.isArray(read.overlay));
};

/**
 * The overview's day, as the reader holds it when the fold of the run history failed (`failures24h`, `runsDay` or
 * `spendByHour` null) or was made without a side of it (`runsDay.partial`): what its day's failures, its timeline and
 * its spend per hour then say could not be read. The parked runs come from the same fold and their mark is judged on
 * every page, but an agent's copy of the data does not hold that mark's words, and holds these.
 */
const dayUnread = (s) => s !== null && typeof s === "object" && (s.failures24h === null || s.runsDay === null || s.runsDay?.partial === true || s.spendByHour === null);

/**
 * What each live page reads beside the three parts of a snapshot the rule holds for every page, and when one of those
 * reads failed in a way a panel of that page words as "could not be read" (issue #988): the marks are the readers'
 * own, held to the real readers over a Valkey that fails a read, and no sentence is new. A key the data lacks is a
 * read the page did not make, never a mark: the loader sets each key a page reads.
 *
 *   - overview, fleet: the waiting jobs, the failed jobs and the doctor results, which their cards draw; on the
 *     overview the settings overlay too where nobody could read it, which its Caps card draws, and the day's fold
 *     (`dayUnread`), which its other unread sentences come from (the day's failures, the run history, the spend
 *     per hour); on Fleet the held jobs, which its Held card and its header draw.
 *   - setup: the doctor results, which four of its steps are told from, and a triggers file that could not be read
 *     (one that does not load, or does not exist, is read and says so).
 *   - parked: the answer rules' results (any state but "ok", drawn as one banner where the parked runs were read), the
 *     planner's check of a question, and a question whose pending answer could not be told.
 *   - runs: the page of runs (a side of the history unread) and the 24 hours' window.
 *   - run: the record (`unreadable`: the mirror did not answer, or the host that holds it); the transcript's state,
 *     the progress, the inbox, the chat facts and the planner's check of a reply (`unreachable`); an inbox whose
 *     messages or whose open flag could not be read; a chat that cannot tell whether its question still waits
 *     (`CHAT_REFUSALS.parkedUnknown`); a search for child runs that was incomplete; the open shells and browser
 *     sessions behind an operator's Workspace row where their read did not answer (`shellsShort`: a list cut at its
 *     cap, or with a registration that does not parse, is read); and for a run refused before it started, which draws no
 *     transcript, progress or chat, the snapshot, its doctor results and the window its two cards are drawn from.
 *   - sandboxes: the open shells and the cleanup notices of a report that did arrive, where their read did not
 *     answer; the record of the run a kept workspace came from and the hosts' doctor runs, each where its card is
 *     drawn (the kept workspace the page was opened for; a sandbox being prepared);
 *     the browser terminals where their read failed; and the deployment's configuration where the report could not
 *     read it.
 *   - host: the run records of a host that has no row, the waiting jobs and the doctor results; and, since issues
 *     #1037 and #1064, the waiting set's marks and an errored queue this host's jobs can be in.
 *   - overview, fleet, since the same issues and #986: the waiting set's marks (a list or a paused flag not read, a
 *     set of queues that may be short), a queue Valkey answered with an error, and a schedule list read in part.
 *
 * NOT MARKS, each because it would hold the pill at Not live for good, or is not the console's read: where a run was
 * looked for (`runPlaces`: a finished run's lookup can be "not whole" for ever); what a host published about itself
 * (a job list, a CPU reserve or a publication it calls unreadable); a run's kept files that this host's store cannot
 * read; and a host's capacity history, which is read once when the page is drawn and never by the stream, as its card
 * says.
 */
const PAGE_UNREAD = Object.freeze({
  // The other marks of a snapshot that answered (issues #1037, #1064, #986), each said by a card of these two pages:
  // the waiting set's (`waitingMarked`), a queue Valkey answered with an error (`queueErrors`, in none of the counts),
  // and a schedule list read in part (`schedulersReadInPart`).
  overview: (d) => partUnread(d.snapshot, ["waiting", "failed", "doctor"]) || waitingMarked(d.snapshot) || queueErrorsOf(d.snapshot).length > 0 || schedulesShort(d.snapshot) || overlayUnread(d.snapshot) || dayUnread(d.snapshot),
  // The held jobs too: Fleet's own card says "The held jobs could not be read." and its header "held jobs unreadable".
  fleet: (d) => partUnread(d.snapshot, ["waiting", "failed", "doctor", "held"]) || waitingMarked(d.snapshot) || queueErrorsOf(d.snapshot).length > 0 || schedulesShort(d.snapshot),
  setup: (d) => partUnread(d.snapshot, ["doctor"]) || Boolean(d.snapshot?.triggers?.unreadable),
  parked: (d) => {
    const answerer = d.answerer;
    // A triggers file that was read and is refused (`configuration: "invalid"`) does not load: the page says that, and
    // it is not a read that failed.
    if (answerer !== null && typeof answerer === "object" && typeof answerer.state === "string" && answerer.state !== "ok" && answerer.configuration !== "invalid") return true;
    // A check that could not be made, and one whose refusal is a read that failed (`unread`: a triggers file nobody
    // could read), which the page draws in the check's own words.
    if (d.parkedChecks !== null && typeof d.parkedChecks === "object" && Object.values(d.parkedChecks).some((check) => unreached(check) || check?.unread === true)) return true;
    const rows = Array.isArray(d.snapshot?.parked) ? d.snapshot.parked : [];
    return rows.some((row) => row !== null && typeof row === "object" && Object.hasOwn(row, "pendingScan") && parkedVerdictOf(row.pendingScan).says === CHAT_REFUSALS.parkedUnknown);
  },
  runs: (d) => historyPartUnread(d.runsPage) || windowUnread(d.runsWindow),
  run: (d, operator) => {
    const record = d.run?.record !== null && typeof d.run?.record === "object" ? d.run.record : null;
    // A run refused before it started (run.mjs `refusedBeforeStart`): nothing ran, so its page draws no transcript,
    // progress, chat or loaded parts, and two cards more, the host with its doctor result and its queue from a
    // snapshot, and how often the same reason refused from the day's window.
    const refused = record !== null && record.outcome === "policy" && refusedBeforeSpend(record);
    if (Boolean(d.run?.unreadable) || unreached(d.inbox)) return true;
    // An inbox that was found and is a steer-armed run's: its messages, or whether it takes one now, not read.
    if (d.inbox?.found === true && d.inbox.steer === true && (d.inbox.entries === null || d.inbox.open === null)) return true;
    // Three reads only an operator's cards are drawn from (`RUN_VIEWER_PANELS` holds none of them): the search for
    // child runs, which the Chain card says was incomplete, and which anyone's banner says only where it counts the
    // runs queued (`queuedText`: a child found, or a request refused); the open shells behind the Workspace row; and
    // a refused run's two cards. On a viewer's or an agent's page nothing says them, so they are no mark there.
    const bannerCounts = (Array.isArray(d.children) && d.children.length > 0) || Number(record?.chainRefused) > 0;
    if (d.childrenIncomplete === true && (operator || bannerCounts)) return true;
    if (operator && shellsShort(d) === "unread") return true;
    if (refused) return operator && (d.snapshot === null || unreached(d.snapshot?.doctor) || windowUnread(d.runsWindow));
    if ([d.transcript, d.chat, d.chatAnswer].some(unreached) || d.chatAnswer?.unread === true || d.chat?.says === CHAT_REFUSALS.parkedUnknown) return true;
    // The progress key is the page's only source of progress while there is no record; with one, the card draws the
    // record's. The hosts' doctor runs are no mark here: the card that holds a run against them says which other
    // hosts lack what it loaded, and says nothing of hosts it could not ask.
    return record === null && unreached(d.progress);
  },
  sandboxes: (d) => {
    // A report that did not arrive is the page's primary read failing (`readFailed`), which the rule knows on any page.
    if (Boolean(d.sandboxes?.sessionsUnavailable) || noticesShort(d.sandboxes) === "unread") return true;
    // Two reads that one card each says were not read: the record of the run a kept workspace came from, on the card
    // of the kept workspace the page was opened for; and the hosts' doctor runs, on the card of a sandbox being
    // prepared (`plan`). On a page without that card nothing says so, and the pill is the page's.
    if ((d.sandboxRunUnread === true && pickedWorkspace(d)) || (unreached(hostLoadsOf(d)) && Boolean(d.sandboxes?.plan))) return true;
    // Two reads that answer in words: the gateway's where its read failed (`pages.mjs`; a registry it refuses says
    // something else), and the report's where the deployment's configuration could not be read (`sandbox-data.mjs`;
    // a triggers file that does not exist, or a host that published no settings, says something else).
    return [d.browserGateways?.problem, d.sandboxes?.refusal].some((words) => /could not be read/.test(String(words ?? "")));
  },
  host: (d) => {
    // The host panel's own rule, which it draws for a host with no row alone: there the run records are all that can
    // say when the host was last seen.
    if ((d.host === null || d.host === undefined) && hostHistoryUnread(d.hostHistory)) return true;
    // The waiting set's marks, which its Jobs card says of the two queues a job of this host can wait in (`hostName`,
    // the page's own host, which the loader sets: a list of another host's queue that was not read is none of this
    // page's); and such a queue that Valkey answered with an error (`hostQueueErrorsOf`), which the card of a host
    // that has a row says. Data that does not name its host is judged by every queue.
    const name = typeof d.hostName === "string" && d.hostName !== "" ? d.hostName : typeof d.host?.name === "string" ? d.host.name : null;
    return partUnread(d.snapshot, ["waiting", "doctor"]) || waitingMarked(d.snapshot, name === null ? null : hostQueueOf(name)) || (d.host !== null && d.host !== undefined && hostQueueErrorsOf(d.snapshot, d.host.name).length > 0);
  },
});

/**
 * Which of the three parts of a snapshot a live page draws (issue #962's parts, held page by page since issue #988):
 * the host registry (`queue.fleetDegraded`), the active jobs (`activeUnreachable`) and the parked runs
 * (`parkedUnreachable`). Every live page was judged by all three, so a page that draws nothing of a part said Not live
 * for it with no word of what it lacks: Parked over a registry that was not read, the setup guide over an active list
 * or over the run history, Fleet and a host over the parked runs.
 *
 *   - overview: all three (its Hosts and Running cards, its Parked card and the day beside it).
 *   - fleet, host: the registry and the active jobs. Neither draws a parked run. A host's page lacks a running job
 *     only where its own row names one that is not drawn, or cannot say (`hostActiveGap`).
 *   - setup: the registry, which its "Start a worker" step is told from.
 *   - parked: the parked runs.
 *   - run: the registry, on the two cards of a run refused before it started, which an operator alone is drawn.
 *     For these three and a host, a registry read in part is a part unread only where the page draws a row that read
 *     did not reach (`registryUnreadOn`).
 *   - runs, sandboxes: none; they read no snapshot.
 *
 * The navigation's Parked count is on every live page and is no mark: it is drawn only where it is known and above
 * zero, here as on the pages that read no snapshot, where it comes from a read with no mark of its own.
 */
const PAGE_PARTS = Object.freeze({
  overview: ["registry", "active", "parked"],
  fleet: ["registry", "active"],
  host: ["registry", "active"],
  setup: ["registry"],
  parked: ["parked"],
  run: [],
  runs: [],
  sandboxes: [],
});
const EVERY_PART = Object.freeze(["registry", "active", "parked"]);

/** A run page's snapshot is a refused run's, and its two cards an operator's: the one place that page draws the hosts. */
const refusedRunOf = (data) => {
  const record = data.run?.record !== null && typeof data.run?.record === "object" ? data.run.record : null;
  return record !== null && record.outcome === "policy" && refusedBeforeSpend(record) ? record : null;
};

/**
 * Whether a registry that was not read whole is a part of THIS page unread. One that was not read at all is, on every
 * page that draws the hosts. One READ IN PART (issue #1062) is where the page draws a row that read did not reach, or
 * says what it could not tell for want of one:
 *
 *   - overview, fleet: always. Their cards list the hosts and say which rows were not read.
 *   - setup: where no row that was read beats, so its "Start a worker" step says whether a worker runs is not known;
 *     with one beating the step is done and says nothing of the registry (`firstRunState`'s rule).
 *   - host: where its row is one that read did not reach, or it has no row and that read did not read it or may
 *     not have (`hostPartCase`). A host whose row was read is drawn as read now, and one the read names as none of
 *     the rows it missed has gone: neither page says anything of another host's row.
 *   - run: where the host a refused run was on has no row that read reached.
 */
function registryUnreadOn(page, data, s) {
  if (!s.queue?.fleetDegraded) return false;
  if (s.queue.registryReadInPart !== true || page === "overview" || page === "fleet") return true;
  const rows = Array.isArray(s.hostBudgets) ? s.hostBudgets : [];
  const reached = (name) => rows.some((h) => h?.name === name && h.notRead !== true);
  if (page === "setup") return !rows.some((h) => h?.notRead !== true && beatFresh(h));
  if (page === "host") {
    // A row that read did not reach is drawn as last seen; with no row, the page says so only where this host's row
    // is one that read did not read, or may be (`hostPartCase`): a host it names as none of them has gone.
    const name = typeof data.hostName === "string" && data.hostName !== "" ? data.hostName : typeof data.host?.name === "string" ? data.host.name : null;
    if (name === null) return true;
    const row = rows.find((h) => h?.name === name);
    return row !== undefined ? row.notRead === true : hostPartCase(s, name) !== null;
  }
  if (page === "run") return !reached(refusedRunOf(data)?.host);
  return true;
}

/**
 * Whether a page's data holds something the console could not read (issues #962 and #988), the one rule of the live
 * pill's Not live for the page the server draws (`shell.mjs`) and for the hub's streams (`live.mjs`). On any page: its
 * primary read failed (`readFailed`); or its load's deadline cut a read (`deadlineSpent`). On the pages `PAGE_UNREAD`
 * names, a read the page makes beside its snapshot failed, so that the pill there is Not live wherever a panel says
 * "could not be read" of a read the page made. And its snapshot was read with a part missing THAT THE PAGE DRAWS
 * (`PAGE_PARTS`): the host registry this time (`queue.fleetDegraded`, whether it shows nothing or the rows as last
 * seen, which are not current either), the active jobs (`activeUnreachable`) or the parked runs
 * (`parkedUnreachable`).
 *
 * `page` is the page the data is drawn on: the data's own name for it (`data.page`, which `loadPageData` sets), or the
 * page the shell draws, which it names itself. Data on no page that has a pill is judged by every part, as before.
 *
 * `role` is who the page is drawn for. A viewer's and an agent's page draw fewer cards than an operator's from the
 * same reads (the run page's `RUN_VIEWER_PANELS`), and a read only an operator's card says is no mark on theirs: the
 * pill said Not live there over a page that said nowhere what it lacks. A caller that does not say who looks (the
 * hub's keeping rule, which holds one load for every role watching it) is answered as for an operator, the widest.
 *
 * A declaration, so the modules that import each other in a circle can call it.
 */
export function dataUnread(data, page = data?.page, role = null) {
  if (data?.readFailed === true || data?.deadlineSpent === true) return true;
  const operator = role === null || role === undefined || role === "operator";
  if (typeof page === "string" && Object.hasOwn(PAGE_UNREAD, page) && data !== null && typeof data === "object" && PAGE_UNREAD[page](data, operator)) return true;
  const s = data?.snapshot;
  if (s === null || typeof s !== "object") return false;
  const parts = typeof page !== "string" || !Object.hasOwn(PAGE_PARTS, page) ? EVERY_PART : page === "run" ? (operator && refusedRunOf(data) !== null ? ["registry"] : []) : PAGE_PARTS[page];
  // The active jobs on a host's page: only where its Jobs card says something of them is missing (`hostActiveGap`).
  const hostName = page === "host" ? (typeof data.hostName === "string" && data.hostName !== "" ? data.hostName : typeof data.host?.name === "string" ? data.host.name : null) : null;
  const activeUnread = s.activeUnreachable === true && (hostName === null || hostActiveGap(s, hostName) !== null);
  return (parts.includes("registry") && registryUnreadOn(page, data, s)) || (parts.includes("active") && activeUnread) || (parts.includes("parked") && Boolean(s.parkedUnreachable));
}

// ---- action forms (issue #642) ---------------------------------------------------------------------------------------

/** Whether this view draws write controls: an operator, on a console that is not read-only. */
export const canAct = (view) => view?.role === "operator" && !view?.readOnly;

/**
 * The kill switch's two forms for a page that could NOT read the deployment (issue #1035), under its unread sentence:
 * Pause the fleet and Resume the fleet, with the sentence that says why they are there with nothing read, or null for
 * a view that draws no write control (`canAct`: a viewer, an agent's session, a read-only console).
 *
 * THE ONE EXCEPTION to the rule that a page which could not read the deployment offers no change. Every other form is
 * drawn from what a read showed (a row, a digest, a count), so with no read there is nothing to draw it from, and the
 * rule holds for them all. The kill switch is the control for exactly this state: a Valkey that stopped answering is
 * when someone needs to stop the fleet, and a console started during the outage had no Pause on any page, since both
 * pages that draw it draw it from a snapshot. The switch itself needs no snapshot: a pause is sent to every queue it
 * finds by its own discovery, and its answer names them. Gated on `canAct` alone, never on what was read. BOTH forms,
 * since which one applies is the thing that is not known; a resume previews with what it would start and is refused
 * where that cannot be read.
 */
export function killSwitchUnreadForms(view) {
  if (!canAct(view)) return null;
  return ui.banner({
    status: "attention",
    icon: "pause",
    sm: true,
    title: KILL_SWITCH_UNREAD_TEXT,
    // In a row of their own that wraps (`formrow`): side by side in the banner's action row, which does not wrap, the
    // two buttons ran 8 px past a 375 px screen.
    actions: html`<div class="formrow">${ui.actForm({ action: "fleet-pause", label: "Pause the fleet", kind: ["danger"], icon: "pause" })}${ui.actForm({ action: "fleet-resume", label: "Resume the fleet", kind: ["paid"], icon: "play" })}</div>`,
  });
}

/**
 * Whether the paused state of some queue of this snapshot is NOT KNOWN (issue #1035), which is when both of the kill
 * switch's forms are offered whatever the queues that were read say: a queue Valkey answered with an error (issue
 * #1064, `queueErrorsOf`: it is in none of the counts, and a snapshot none of whose queues was read is one where each
 * was answered so), or a host registry not read whole (`queue.fleetDegraded`: a host's own queue may exist that this
 * read did not ask). No snapshot at all is the same, for a caller that asks. A pause reaches every queue it finds and
 * its answer names them, so offering it over a fleet that reads paused costs nothing, and a resume is what an unread
 * queue that is in fact paused needs.
 */
export function pausedStateUnknown(s) {
  if (s === null || typeof s !== "object") return true;
  return queueErrorsOf(s).length > 0 || Boolean(s.queue?.fleetDegraded);
}

/**
 * Whether a page could not read the deployment: its snapshot failed, so what it draws is what the files hold.
 */
export const deploymentUnread = (view) => view?.data?.readFailed === true && (view.data.snapshot === null || view.data.snapshot === undefined);

/**
 * Whether a page offers a change to the deployment's files (issue #988): an operator on a console that takes changes
 * (`canAct`), on a page that read the deployment. A page that could not read it offers no change: its forms were
 * drawn from the files alone, and it cannot show what a change would meet (the hosts that read the file, what runs,
 * what waits). Configuration and Secrets drew none in that state; a trigger's page, Add a trigger, a project and
 * Models did. The page says so (`noChangeText`), and the file can still be changed by hand. The rule is the page's
 * alone: the routes answer as they did, and most of their previews need no Valkey at all.
 *
 * NEVER the kill switch. Pausing and resuming the fleet are what an operator reaches for when the deployment cannot
 * be read, so their forms ask `canAct` and nothing else: this rule is for a change to a file, not for an act on the
 * queues.
 */
export const changesOffered = (view) => canAct(view) && !deploymentUnread(view);

/**
 * The causes a page's snapshot read can fail by (issue #988, and issue #1073's fourth): "silent", nothing answered
 * (stopped, killed, refused, not reached); "error", Valkey answered the read with an error reply, whose code the loader
 * keeps; "late", the page's deadline cut the read of a Valkey that may well be answering; "fault", the console's own
 * code failed while it read (an engine error: a TypeError and its kin), which is no fact about Valkey at all.
 */
export const UNREAD_CAUSES = Object.freeze(["silent", "error", "late", "fault"]);

const REPLY_CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * What a load says of its failed snapshot read (`data.snapshotFailure`, issue #1073): `{ kind, code }`, `code` the reply's
 * code for an "error" (null where the reply had none) and null for every other kind. The loader sets it for every kind
 * but "silent", so no mark is "silent". A string is the shape before issue #1073 (`"late"`, `"error"`), read the same.
 * Not gated on whether the page could not read (`deploymentUnread`): a panel drawn with no snapshot asks it too.
 */
export function unreadCauseOf(data) {
  const f = data?.snapshotFailure;
  const kind = typeof f === "string" ? f : typeof f?.kind === "string" ? f.kind : "silent";
  if (!UNREAD_CAUSES.includes(kind)) return { kind: "silent", code: null };
  return { kind, code: kind === "error" && typeof f?.code === "string" && REPLY_CODE_RE.test(f.code) ? f.code : null };
}

/**
 * Why a page could not read the deployment (issue #988), so a sentence can be true of the cause: one of
 * `UNREAD_CAUSES`, or null for a page that read it.
 */
export const deploymentUnreadWhy = (view) => (!deploymentUnread(view) ? null : unreadCauseOf(view.data).kind);

/** The start of a sentence for each cause. "Valkey could not be read" was said of a Valkey that answered late. */
export const DEPLOYMENT_UNREAD_WORDS = Object.freeze({
  silent: "Valkey could not be read",
  error: "Valkey answered this page's read with an error",
  late: "This page could not read the deployment in time",
  fault: "This console failed while it read the deployment",
});

/** The class of a reply's code in a few words, for a sentence that names the code and its class (issue #1073). */
const REPLY_CLASS_WORDS = Object.freeze({ key: "a key of another type", permission: "a permission or sign-in refusal", passing: "a state that passes", other: "a reply of no class this console knows" });

/**
 * The start of a sentence for a cause, with the reply's code where Valkey answered with one: "Valkey answered this
 * page's read with WRONGTYPE".
 */
export const unreadLead = (cause) => (cause.kind === "error" && cause.code !== null ? `Valkey answered this page's read with ${cause.code}` : DEPLOYMENT_UNREAD_WORDS[cause.kind] ?? DEPLOYMENT_UNREAD_WORDS.silent);

/**
 * What a sentence adds after its lead, by the cause (issue #1073): of an error, the code's class and what the class
 * may claim (`replyErrorWords`, the worker's table: what it means and whether waiting ends it), and of a fault, that
 * it is the console's and not Valkey's, and that its log names it. Null for the other two, whose lead says it all.
 */
export function unreadAfter(cause) {
  if (cause.kind === "fault") return UNREAD_FAULT_TEXT;
  if (cause.kind !== "error" || cause.code === null) return null;
  const w = replyErrorWords(cause.code);
  const named = `${cause.code} is ${REPLY_CLASS_WORDS[w.class]}`;
  if (w.class === "key" || w.class === "permission") return `${named}: ${w.means}. ${w.waiting}: an operator has to ${w.first} first.`;
  if (w.class === "passing") return `${named}: ${w.means}. ${w.waiting}.`;
  return `${named}, so nothing is said here of how long it lasts.`;
}

/** After a fault's lead: whose failure it is, and where its cause is named. */
export const UNREAD_FAULT_TEXT = "Valkey is not the cause known here: the console's own code failed, and its log names the error.";

/** Whether waiting cannot end the cause: a reply of a lasting class (a key of another type, a permission). */
const lastingCause = (cause) => cause.kind === "error" && cause.code !== null && replyErrorWords(cause.code).lasting === true;

/**
 * THE ONE SENTENCE A PAGE SAYS OF A SNAPSHOT IT COULD NOT READ (issue #1073), by its cause (`unreadCauseOf`). The five
 * banners said "Valkey could not be read" of a Valkey that did not answer, one that answered with an error, a read the
 * page's deadline cut and a console fault alike. A site gives its own words for the case it was written for, the
 * silent one (`lead`, `prefix`, `then`), which are kept byte for byte, and its own next step (`retry`), which a lasting
 * reply drops: waiting does not end a key of another type or a permission. `more` is said before that step.
 */
export function unreadText(view, { lead = DEPLOYMENT_UNREAD_WORDS.silent, prefix = "", then = null, more = null, retry = null } = {}) {
  const cause = unreadCauseOf(view?.data);
  const said = cause.kind === "silent" ? lead : unreadLead(cause);
  const head = prefix === "" || /^Valkey\b/.test(said) ? `${prefix}${said}` : `${prefix}${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  return [`${head}${then ? `, ${then}` : ""}.`, unreadAfter(cause), more, lastingCause(cause) ? null : retry].filter(Boolean).join(" ");
}

/** The step a live page gives, and the one a page drawn once gives. */
export const NEXT_REFRESH_TEXT = "The next refresh tries again.";
export const RELOAD_TEXT = "Reload to try again.";

/**
 * Said on a page whose forms are left out because it could not read the deployment (`changesOffered`), where each
 * form or group of forms would be: why, in the words of the cause, and the file those forms write, which can still be
 * changed by hand.
 */
export function noChangeText(view, file = "triggers file") {
  const why = deploymentUnreadWhy(view) ?? "silent";
  return unreadText(view, { then: `so ${why === "late" ? "it" : "this page"} offers no change`, more: `The ${file} can still be changed by hand.`, retry: RELOAD_TEXT });
}

/** The sentence that sends an operator to /setup's doctor on this console's own host (issue #849). */
export const DOCTOR_FROM_SETUP = "here in the browser, without its container probes; the command below also runs those.";

/**
 * A link to /setup's doctor, for an operator where the host-setup grant is on (`data.setupGranted`) and only for this console's own host (`doctorSelf`):
 * the browser's doctor runs where the console runs, and publishes the same checks without the probe containers, so the command stays beside it. Null elsewhere.
 */
export function doctorFromSetup(view, hostName) {
  if (!canAct(view) || view.data?.setupGranted !== true) return null;
  const self = view.data?.snapshot?.doctorSelf;
  if (typeof self !== "string" || self === "" || hostName !== self) return null;
  return html`<p class="fl-doc__p"><a class="link" href="/setup">Run doctor from Set up</a>, ${DOCTOR_FROM_SETUP}</p>`;
}

/**
 * One action's form: hidden fields (`[name, value, type?]`), the visible controls, the submit button, and the
 * `[data-preview]` element the script fills with the server's preview. `type` is how the script reads a value
 * (`int`, `json`, `list`; text by default).
 */
function actForm(action, { hidden = [], fields = null, label, cls = "act" }) {
  return html`<form class="${cls}" data-action="${action}" autocomplete="off">${hidden.map(([k, v, type]) => html`<input type="hidden" name="${k}" value="${String(v)}"${type ? html` data-type="${type}"` : null}>`)}${fields}<button class="btn btn--sm" type="submit">${label}</button><div class="preview-area" data-preview hidden></div></form>`;
}

/** A labelled text input; `type` as `actForm`'s. */
function field(name, label, { type = null, input = "text", required = false, placeholder = null, max = 512 } = {}) {
  return html`<label>${label}<input name="${name}" type="${input}"${type ? html` data-type="${type}"` : null}${required ? html` required` : null}${placeholder ? html` placeholder="${placeholder}"` : null} maxlength="${max}" autocomplete="off" spellcheck="false"></label>`;
}

/** A labelled textarea (a JSON value, an answer, a list of members). */
function area(name, label, { type = null, rows = 4, required = false, placeholder = null, max = 16384 } = {}) {
  return html`<label>${label}<textarea name="${name}" rows="${rows}"${type ? html` data-type="${type}"` : null}${required ? html` required` : null}${placeholder ? html` placeholder="${placeholder}"` : null} maxlength="${max}" spellcheck="false"></textarea></label>`;
}

/** An index field: a whole number, 0 or more (the row number the list shows). */
const indexField = (label = "Row #") => field("index", label, { type: "int", input: "number", required: true, max: 6 });

/** A section's editor: the forms inside a closed `<details>`, so the panel reads as before until it is opened. */
function editor(summary, forms) {
  return html`<details class="editor"><summary>${summary}</summary><div class="forms">${forms}</div></details>`;
}

/** A `<table>` with a caption-free header row; `rows` are already-built `<tr>` fragments. */
function table(label, heads, rows, emptyText) {
  if (rows.length === 0) return html`<p class="note">${emptyText}</p>`;
  return html`<div class="scroll"><table class="grid" aria-label="${label}"><thead><tr>${heads.map((h) => (typeof h === "string" ? html`<th scope="col">${h}</th>` : html`<th scope="col" class="num">${h.num}</th>`))}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** A definition list of `[term, value]` pairs; a null value is left out. */
function facts(pairs) {
  return html`<dl class="facts">${pairs.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

/** The sentence a panel shows when the snapshot could not be read at all, for a Valkey that did not answer. */
export const SNAPSHOT_MISSING = "The deployment's Valkey could not be read, so this panel has nothing to show. The next refresh tries again.";

/** The same in the words of the cause (`unreadText`, issue #1073): `SNAPSHOT_MISSING` for a Valkey that did not answer. */
export const snapshotMissingText = (view) => unreadText(view, { lead: "The deployment's Valkey could not be read", then: "so this panel has nothing to show", retry: NEXT_REFRESH_TEXT });

/** Wrap a snapshot panel: the fixed sentence when there is no snapshot, else the renderer. */
function fromSnapshot(title, render) {
  return (view) => {
    const snap = view.data?.snapshot;
    if (!snap) return titled(title, html`<p class="warn">${snapshotMissingText(view)}</p>`);
    return titled(title, render(snap, view));
  };
}

// ---- cost ------------------------------------------------------------------------------------------------------------

/**
 * One run's typed cost, `{ usd, class, floor, planId }`, by the cost fold's own classifier (`classifyRow`): per ledger
 * row when the record has a usage ledger, else one row from the host-effective provider and model. A run whose rows all
 * share a class keeps it; mixed classes read as an estimate. A fallback-metered run (`metered: false`) is a floor. Null
 * when the run measured nothing (no `tokens`). The pricing table is not consulted (`classifyRow` needs it only for a
 * cost that is not a number), so this needs no pi.
 *
 * Issue #1008: the rows are the fold's own (`classifiedRows`), so a row of a provider the record names notional is of
 * class `subscription`, and a record with no ledger is split the worker's way into its notional and billed parts. `usd`
 * is what was billed, never a list price, which rides as `notional`. Subscription rows take no part in the class, so a
 * run that billed a key and ran its root on a subscription stays `metered`, and one that billed nothing is
 * `subscription`. A record without both notional keys is classed as before.
 */
export function runCost(record, subscriptions = []) {
  const tokens = record?.tokens;
  if (tokens === null || typeof tokens !== "object") return null;
  const rows = classifiedRows(record, subscriptions, null).map((row) => ({ ...row, provider: row.provider ?? "unknown", model: row.model ?? "unknown", cost: typeof row.cost === "number" && Number.isFinite(row.cost) ? row.cost : 0 }));
  const floor = tokens.metered === false;
  const usd = rows.reduce((s, r) => s + (r.class === "plan" || r.class === "subscription" ? 0 : r.cost), 0);
  const subscriptionRows = rows.filter((r) => r.class === "subscription");
  const notional = subscriptionRows.length > 0 ? { notional: subscriptionRows.reduce((s, r) => s + Math.max(0, r.cost), 0) } : {};
  const classes = [...new Set(rows.map((r) => r.class))].filter((c) => c !== "subscription");
  if (classes.length === 0) return { usd: 0, class: "subscription", floor, planId: null, ...notional };
  if (classes.length === 1 && classes[0] === "plan") {
    const ids = [...new Set(rows.filter((r) => r.class === "plan").map((r) => r.planId))];
    if (ids.length === 1 && !floor) return { usd: 0, class: "plan", floor: false, planId: ids[0], ...notional };
    return { usd, class: "estimated", floor, ...notional };
  }
  if (classes.length === 1) return { usd, class: classes[0], floor, planId: null, ...notional };
  return { usd, class: "estimated", floor, planId: null, ...notional };
}

/** A typed cost as text (`fmtCost`'s shapes), or "not metered" for a run that measured nothing. */
function costText(cost) {
  return cost ? fmtCost(cost) : "not metered";
}

/**
 * The per-job dollar cap a run was held to: what it reserved, else the cap its exit line names. A run that reserved
 * nothing (`unreserved`: no dollar window held it, or, issue #1008, every route was a notional subscription or zero-rated)
 * still ran under the cap its exit line names, so that one is its cap, never the reservation's $0.
 */
function capMicrosOf(record) {
  const reserved = record?.dollars?.reservedMicros;
  const cap = record?.tokens?.costCapMicros;
  if (record?.dollars?.basis === "unreserved" && Number.isSafeInteger(cap)) return cap;
  if (Number.isSafeInteger(reserved)) return reserved;
  return Number.isSafeInteger(cap) ? cap : null;
}

// ---- the queue and its hosts (the overview's and the fleet's) --------------------------------------------------------

/**
 * How old a host's last beat may be for the host to count as online (issue #710): a minute, four of the worker's 15 s
 * beats. The hosts tables mark an older beat amber by the same bound (`beatCell`). Not the registry row's 90 s TTL,
 * past which the row is gone anyway: a row that still lives with no beat for a minute is a worker that is wedged or
 * dying, and an overview that called it online would say jobs are being run when none is.
 */
export const BEAT_FRESH_MS = MIN;

/**
 * Who drains the queue (issue #710): `{ count, online, connected, staleBeats, none }`.
 *
 * - `count` is the registry-aware worker count (`resolveWorkerCount`, the status line's rule: the registry's rows when it
 *   has any, else BullMQ's `getWorkers`, else "unknown").
 * - `online` is how many registry rows beat within `BEAT_FRESH_MS`, or BullMQ's count for a deployment whose registry
 *   holds no row (a fallback that cannot see beats), or null when the registry could not be read (the page then says it
 *   shows the fleet as last seen, and judges nothing).
 * - `connected` is BullMQ's own worker list for the shared queue (`queue.workers`, 0 where it is "unknown"), and
 *   `staleBeats` is true when it sees more workers than there are fresh beats.
 * - `none` is the overview's warning: no fresh beat AND no worker BullMQ can see.
 *
 * WHY BULLMQ CAN OVERRULE THE BEATS (review round 1). A beat's age is the console's clock minus the worker's own `beatAt`
 * (`readLiveHosts`), so a worker whose clock runs 50 s behind reads 50 s staler than it is and, with a 15 s beat, drops
 * past the minute for part of every minute. BullMQ's list is read from Valkey's client connections and holds no clock at
 * all, so while it sees a worker the page never says "no worker online" nor turns the queue amber; it says the beats look
 * stale instead. The price, taken knowingly: a wedged worker keeps its connection too, so a fleet whose every worker is
 * wedged reads as the note rather than the warning, while the hosts tables still mark each stale beat amber. The other
 * way round is kept: a fresh beat with no BullMQ worker is online, because `getWorkers` rests on
 * CLIENT SETNAME, which some providers do not support (`resolveWorkerCount`'s reason for preferring the registry).
 *
 * A ROW'S AGE ON VALKEY'S CLOCK (issue #737) is now `readLiveHosts`' too: `ttlAgeMs`, the row's TTL minus its PTTL,
 * and `skewMs`, the console's clock against the host's measured from it, beside `staleMs`, which stays the wall-clock
 * difference doctor's skew check needs. The overview's hosts panel says a host's clock is out of step from those
 * (`hostSkewText`, past `HOST_SKEW_CLAIM_MS`). This rule still judges by the beats and BullMQ's list, a beat's age
 * taken as `beatAgeOf` gives it: Valkey's own measure of the row's last refresh where the reader had it (every beat
 * refreshes the row, so it is how long ago the host last beat, whatever the host's clock says), else the wall-clock
 * `staleMs`. A host whose clock runs behind is then beating when it beats, and says so, never "late".
 */
export function workersOnline(s) {
  const q = s?.queue ?? {};
  const hosts = Array.isArray(s?.hostBudgets) ? s.hostBudgets : [];
  const { count: n } = resolveWorkerCount({ hosts, workerCount: q.workers });
  const connected = Number.isSafeInteger(q.workers) && q.workers > 0 ? q.workers : 0;
  // Read in part (issue #1062): the rows it read that beat are a floor (`atLeast`), a row it did not reach has no beat
  // of now (`beatAgeOf`), and neither "no worker" nor stale beats is claimed. Wholly unread: not known.
  if (q.fleetDegraded && q.registryReadInPart === true) return { count: n, online: hosts.filter((h) => beatFresh(h)).length, atLeast: true, connected, staleBeats: false, none: false };
  if (q.fleetDegraded) return { count: n, online: null, connected, staleBeats: false, none: false };
  if (hosts.length === 0) return { count: n, online: connected, connected, staleBeats: false, none: connected === 0 };
  const online = hosts.filter((h) => beatFresh(h)).length;
  return { count: n, online, connected, staleBeats: connected > online, none: online === 0 && connected === 0 };
}

export { beatAgeOf };

/** Whether a host row beat within `BEAT_FRESH_MS`, by `beatAgeOf` (doctor-view.mjs). */
export function beatFresh(h) {
  const age = beatAgeOf(h);
  return age !== null && age <= BEAT_FRESH_MS;
}

/** A host's last beat as an age, with a warning class once it is older than `BEAT_FRESH_MS`. */
function beatCell(staleMs) {
  if (!Number.isSafeInteger(staleMs)) return html`<td>unknown</td>`;
  return staleMs > BEAT_FRESH_MS ? html`<td class="warn">${ageText(staleMs)} ago</td>` : html`<td>${ageText(staleMs)} ago</td>`;
}

/**
 * A host's blessed venues, compact (issue #712): `local (default), openshell`, the first the default as PI_BACKENDS reads
 * it; "not published" for a worker from before the registry's `backends` field, never a guessed `local`.
 */
function blessedText(h) {
  const blessed = Array.isArray(h?.backends?.blessed) ? h.backends.blessed : null;
  if (blessed === null) return html`<span class="note">not published</span>`;
  if (blessed.length === 0) return "none";
  return blessed.map((n, i) => (i === 0 ? `${n} (default)` : n)).join(", ");
}

// ---- the active jobs (the overview's and the fleet's; the stale words the run page's too) ----------------------------

/** The words a stale snapshot carries (`progressStaleFor`): whole minutes since the last write. */
export function staleText(ms) {
  return `no update for ${Math.floor(ms / MIN)} min; the worker may be gone`;
}

/**
 * An active row's progress (issue #644) as one cell: "turn 7, 12 steps (1 failed), bash running 40s, phase 2/4". Built
 * from the snapshot's integer projection alone (`activeProgressOf`): integers and a tool name in the live stream's
 * charset, never a phase name or a note, so the same cell is right for a viewer. `-` when the row has none, and for an
 * ENDED snapshot: the job is active, so an ended key is an earlier attempt's (an infra retry keeps the job id) and
 * this attempt has not written yet. A stale snapshot (no write for `PROGRESS_STALE_MS`) says so, and its running
 * step gets no age: the clock would keep counting for a step nobody is watching.
 */
export function progressText(p, now) {
  if (p === null || typeof p !== "object" || p.ended === true) return "-";
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const stale = progressStaleFor(p, now);
  const parts = [];
  if (n(p.turn) !== null) parts.push(`turn ${p.turn}`);
  if (n(p.steps) !== null) parts.push(`${count(p.steps)} ${p.steps === 1 ? "step" : "steps"}${n(p.failed) ? ` (${count(p.failed)} failed)` : ""}`);
  const r = p.running;
  if (r && typeof r.tool === "string") parts.push(`${r.tool} running${stale === null && n(r.since) !== null && Number.isFinite(now) && now >= r.since ? ` ${ageText(now - r.since)}` : ""}`);
  const f = p.phase;
  if (f && n(f.index) !== null) parts.push(`phase ${f.index + 1}/${n(f.count) ?? "?"}`);
  if (stale !== null) parts.push(staleText(stale));
  return parts.length > 0 ? parts.join(", ") : "-";
}

// ---- a run's outcome in a row (the runs list's and the run page's) ---------------------------------------------------

/**
 * A record's outcome in the console's words (words.mjs, the panel's too): completed, refused, failed, awaiting input or
 * cancelled; an outcome this release does not know is shown as it is (escaped, like every record string).
 */
function outcomeText(r) {
  const note = outcomeNote(r);
  if (note !== null) return note.charAt(0).toLowerCase() + note.slice(1);
  const w = outcomeWord(r?.outcome, r?.reason);
  return w.known ? w.word : cell(r?.outcome);
}

/**
 * What a row says for a run that did not complete and whose record names no reason token (issue #737): the short form
 * of `NO_REASON_FAILED`, derived (`shortSentence`), so the row cannot drift from that sentence. The run page does not
 * draw it: its banner says its own words for a record that names no reason (`run.mjs` `NO_REASON_TEXT`).
 * Outcome-neutral once the verdict is dropped, so a refused record with no token says it too.
 */
export const NO_REASON_SHORT = shortSentence(NO_REASON_FAILED);

/**
 * A run's outcome as a list cell (issue #737, the DataTable and RunsScreen cards): the outcome's badge, then for a run
 * that did not complete why, in one short sentence (`<span class="reason">`). The runs table's Outcome column and the
 * run page's chain draw this one cell.
 *   - A completed run is quiet: the badge in the idle tone with its check, and nothing more, so the runs that need a
 *     person stand out of a list that is mostly completed ones.
 *   - A word that says why (awaiting input, cancelled: `outcomeWord(...).says`) draws the badge alone.
 *   - Otherwise the reason's short catalog sentence (`reasonWords`, its `why` variant included), linked to every run
 *     with the same outcome key and reason where the runs filter accepts the pair (`link`), with the token in the
 *     link's title; a token the catalog does not know is shown as itself, in the code face, with `NO_EXPLANATION`; and
 *     a record with no token says `NO_REASON_SHORT`.
 * ONLY A TOKEN IS EVER PRINTED (words.mjs `recordReason`, the record's own charset), and a job's free-text
 * `failedReason` never comes here (REQ-CONSOLE-SECURITY (l)): an older worker recorded an infrastructure error's
 * message as the reason (an API path, a repository, a library's words), and a record from another host is that host's
 * text, so a reason that is no token is shown to nobody, in either role. Every other string is the catalog's own.
 */
export function outcomeCell(record, { link = true } = {}) {
  const outcome = record?.outcome;
  const raw = record?.reason;
  const w = outcomeWord(outcome, raw);
  const key = outcomeKey(outcome, raw);
  // Issue #800: a run that completed without what it needed does not stay quiet in a list that is mostly completed ones.
  const note = key === "completed" ? outcomeNote(record) : null;
  if (note !== null) return ui.badge("attention", note);
  if (key === "completed") return ui.badge("idle", w.word.charAt(0).toUpperCase() + w.word.slice(1), { icon: ui.STATUS.ok.icon });
  const badge = ui.outcomeBadge(outcome, raw);
  if (w.says) return badge;
  const token = recordReason(record);
  if (token === null) return html`${badge}<span class="reason">${NO_REASON_SHORT}</span>`;
  const said = reasonWords(token, typeof record.why === "string" ? record.why : null);
  const text = said.known ? said.short : html`<span class="code">${token}</span>, ${NO_EXPLANATION}`;
  // An outcome this release does not know has no key: its link names the reason alone, which the filter takes.
  const query = key === null ? { reason: token } : { outcome: key, reason: token };
  const href = link && parseRunFilter(query).filter ? `/runs?${new URLSearchParams(query)}` : null;
  return html`${badge}<span class="reason">${href === null ? text : html`<a href="${href}" title="${token}">${text}</a>`}</span>`;
}

// ---- a token cut (the outcome banner's and the failed jobs list's) ---------------------------------------------------

/**
 * The most of a token the catalog or the words do not know (a reason, or an outcome word from a newer worker) that the
 * banner prints, in code points, before its ellipsis.
 */
const BANNER_TOKEN_MAX = 64;

/** `token` cut to `BANNER_TOKEN_MAX` code points with an ellipsis (code points, so a surrogate pair is never split). */
function bannerCut(token) {
  const chars = [...String(token)];
  return chars.length > BANNER_TOKEN_MAX ? `${chars.slice(0, BANNER_TOKEN_MAX).join("")}…` : String(token);
}

// ---- the parked answer form (the parked inbox's and the run page's Chat panel) ---------------------------------------

/**
 * One parked run's answer form (issue #642): the `parked-answer` action, whose preview shows the answer and the reserve
 * and whose server refuses a pull request's park, expired job data and a trigger without `resume`. The parked inbox and
 * the run page's Chat panel (issue #647) draw this one form.
 */
function parkedAnswerForm(jobId) {
  return actForm("parked-answer", { hidden: [["jobId", jobId]], fields: area("text", "Your answer, as the reply on the issue", { rows: 4, required: true, max: 8192 }), label: "Preview the answer" });
}

// Shared with the screens' modules only; `../panels.mjs` does not re-export these.
/** "1 slot", "2 slots": a count and its noun, agreed. */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export {
  plural, SEC, MIN, cell, msOf, count, runLink, targetLink, titled, actForm, field, area, indexField, editor, table, facts,
  fromSnapshot, costText, capMicrosOf, beatCell, blessedText, outcomeText, bannerCut,
  parkedAnswerForm
};
