/**
 * What this console and panel do with stored state a NEWER pi-dispatch wrote (issue #761, `DES-STORE-VERSION-WHEN-NEEDED`):
 * the words a refused write says, and the one rule every fold of run records reads them by. A leaf over two worker
 * leaves, so the console's actions (which never import the read model) and the read model share one sentence.
 *
 * Run records: a record from a newer release carries `v` above `RUN_RECORD_VERSION`, and only its stable core
 * (`RECORD_CORE_FIELDS`: id, attempt, outcome, times, host, kind, project) keeps its meaning in every version. So a fold
 * that adds up money, counts or capacity skips such a record and says how many it skipped (`readableRecords`), and a
 * page that lists runs keeps it, showing only the core (`coreRecordOf`) and one sentence (`NEWER_RECORD_SENTENCE`).
 * Reading a newer record's other fields could add a dollar figure whose meaning that release changed.
 */
import { pauseWindowsVersionRefusal } from "@edgehero/pi-dispatch/pause-windows";
import { RECORD_CORE_FIELDS, recordReadable } from "@edgehero/pi-dispatch/run-history";

/**
 * The refusal for a write over the parsed pause-windows document `doc` when a newer pi-dispatch wrote it, else null:
 * this build cannot know what that release's windows or blocks mean, and rewriting them under its own version would
 * lose them. Judged on the raw `version` only (`pauseWindowsVersionRefusal`); a broken `version` is not newer, and the
 * write repairs it like any broken file. The words are the triggers writer's for the same case.
 */
export function pauseWindowsNewerRefusal(doc, path) {
  const problem = pauseWindowsVersionRefusal(doc);
  return problem?.newer === true ? `${problem.message}, so nothing was written and nothing in it was lost; change it with that release: ${path}` : null;
}

/**
 * What a run page (the console's and the panel's) says, once, beside a record a newer pi-dispatch wrote, of which it
 * shows only the stable core: every field of `RECORD_CORE_FIELDS` in words (both times as "times"), which a test holds
 * to the core and to the rows the run card draws.
 */
export const NEWER_RECORD_SENTENCE = "Written by a newer pi-dispatch; only its core facts are shown (id, attempt, outcome, times, host, kind and project)";

/**
 * What a model-callable tool (`dispatch_runs`) says beside such a record: the core's own field names, derived from
 * `RECORD_CORE_FIELDS`, and that nothing past them may be inferred, since no page is there to show what is missing.
 */
export const NEWER_RECORD_MODEL_NOTE = `This run record was written by a newer pi-dispatch, so only the fields every release reads the same way are given (${RECORD_CORE_FIELDS.join(", ")}); its other fields, such as its cost, model and reason, are left out because that release may give them another meaning`;

/**
 * Whether `record` is a run record this build may read only as its stable core: an object whose `v` is above the version
 * this build knows, or is not a version at all (`0`, `"2"`, `1.5`, `null`: no release writes one, so nothing says what
 * the record's other fields mean). Such a record is "from a newer release" for every fold and page here, which is the
 * safe reading: it is cut to its core and left out of every sum, never read whole. A record whose `v` is missing
 * (version 1) or one this build knows is not (`recordReadable`). Anything that is not an object is not one either; each
 * fold keeps its own rule for such a value. Named apart from the worker's `newerRecord(a, b)`, the later of two records.
 */
export function fromNewerRelease(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record) && !recordReadable(record);
}

/**
 * The records a fold may read: `{ records, newerSkipped }`, every value of `records` that is not a newer record, in
 * order, and how many newer ones were left out. Values that are not records pass through untouched, so a fold that
 * already skips them keeps doing so in its own way.
 */
export function readableRecords(records) {
  const out = [];
  let newerSkipped = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (fromNewerRelease(record)) newerSkipped++;
    else out.push(record);
  }
  return { records: out, newerSkipped };
}

/** "N record(s) from a newer pi-dispatch not read", the worker's own words for a partial fold, or null for none. */
export function newerSkippedSentence(n) {
  return Number.isSafeInteger(n) && n > 0 ? `${n} record${n === 1 ? "" : "s"} from a newer pi-dispatch not read` : null;
}

/**
 * A newer record cut to its stable core, plus its `v`: the fields every version keeps the meaning of, so a list or a
 * page can still show the run. A field the core names but the record lacks stays absent.
 */
export function coreRecordOf(record) {
  const out = {};
  if (record === null || typeof record !== "object") return out;
  for (const key of [...RECORD_CORE_FIELDS, "v"]) if (Object.hasOwn(record, key)) out[key] = record[key];
  return out;
}

/**
 * A run record as every admin read hands it out: a newer record cut to its stable core and `v` (`coreRecordOf`), any
 * other value as it was. Applied where a record is READ (this host's files and the run mirror alike), so a page, a list
 * or a tool that forgets to ask can still only show fields whose meaning is the same in every release; the folds skip
 * such a record by its `v` (`readableRecords`), which the cut keeps.
 */
export function shownRecord(record) {
  return fromNewerRelease(record) ? coreRecordOf(record) : record;
}
