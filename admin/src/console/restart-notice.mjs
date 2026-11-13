/**
 * What a running console cannot pick up without a restart, said on every page and in its log (issue #845).
 *
 * Measured on macOS against a real console before this: a changed `VALKEY_URL`, other values in the deployment's `.env`,
 * and a database Valkey refused all took a restart to pick up, and the console never said so. It kept reading the old
 * Valkey with nothing said, or repeated "nothing answers VALKEY_URL" or a refused database once a minute, and raising
 * `databases` recovered nothing. Needing the restart is the design (`DES-OPERATOR-CONSOLE`); not being told was the
 * fault. A password rotated in the `.env` is not here: the console's long-lived clients read it again before each
 * connect (`worker/src/connection.mjs`, `freshPassword`), so it needs no restart.
 *
 * HOW IT KNOWS. What the console read at start is compared with what the same reads give now, with this shell's
 * environment as at start, so a key the shell sets is never called changed by an edit to the file. Modelled on
 * `makeSetupExposureReader`, which differs there: it re-reads the file alone, since it asks whether the service's settings
 * moved. Compared: the console's own keys (`consoleEnv`, `CONSOLE_ENV_KEYS`) and the read side's (`readSideOf`,
 * `PANEL_SERVICE_KEYS` and the keys it reads beside them), a path by the file or folder it names (`cli.mjs`
 * `restartValuesOf`). A key whose value differs is named, never its value: a VALKEY_URL may carry a password, and the
 * banner is shown to viewers as well as operators. Three reasons, in this order:
 *   - `settings`: keys the `.env` now sets differently (a bad line fixed since start shows here, as keys that now read);
 *   - `env`: the `.env` cannot be read now in a way it could at start (gone, unreadable, another account can change it,
 *     or a line the service's loader reads differently, `envProblemOf`, judged over the Valkey context's keys as well,
 *     VALKEY_PASSWORD among them), so a restart now would run without what it holds: fix it first. Told apart by kind and
 *     keys, never by line, so a bad line the console started with that only moved is no reason. Keys that only this
 *     problem keeps from being read are not also named as changed;
 *   - `database`: a long-lived client holds a refused database (`DB_REFUSED`), which it never tries again, so only a
 *     restart picks up a `databases` raised since. The sentence is this module's own and names the number, never an
 *     address (`valkeyDbRangeSentence`, which names the URL, is for the log and the CLI, and stays as it is).
 *
 * WHEN. A page asks `current()`, which reads again when its answer is older than `RESTART_RECHECK_MS`, and a timer reads
 * again every `RESTART_CHECK_EVERY_MS`, unref'd, so the log line comes with no page open and never holds the process.
 * The log says the reasons once per change of them, the change back to none included. Every read is a few small file
 * reads and two property reads on held clients; none touches Valkey. Clock and timers are injected.
 *
 * REJECTED: re-reading the whole `.env` live and applying it, which every page's closure over the paths read at start
 * rules out (each would have to learn to swap them mid-request); and dropping a held database refusal once a connect
 * could succeed, which would have the client keep reconnecting to a database Valkey refused, the loop `DB_REFUSED` ended
 * (gate round 2 of PR #478).
 */
import { withCode } from "./kit.mjs";
import { html } from "./html.mjs";

/** How old an answer `current()` gives may be before it reads again. */
export const RESTART_RECHECK_MS = 5_000;

/** How often the timer reads again with no page open, so the log line comes on its own. */
export const RESTART_CHECK_EVERY_MS = 60_000;

/** The banner's title when the console needs a restart to use what changed. */
export const RESTART_TITLE = "This console needs a restart";

/** The banner's title when the only reason is a `.env` that cannot be read now: a restart would make it worse. */
export const RESTART_FIX_FIRST_TITLE = "Fix the deployment's .env before restarting the console";

/** The log line's words when the reasons go back to none. */
export const RESTART_CLEARED = "no restart needed any more: what the console reads matches what it started with";

/** At most this many keys are named in a sentence; the rest are counted. */
const KEYS_NAMED = 6;

/** `keys` as words, each in backticks for the code face, the rest past `KEYS_NAMED` counted. */
function keyList(keys) {
  const named = keys.slice(0, KEYS_NAMED).map((k) => `\`${k}\``);
  const more = keys.length - named.length;
  const all = more > 0 ? [...named, `${more} more`] : named;
  return all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

/**
 * What a `deploymentServiceEnv` result says the `.env` keeps from being read now, or null when nothing: `{ kind, ... ,
 * keys }`, where `keys` are the keys it keeps from being read (null: every key). Only what reaches the console counts: a
 * key this shell sets is the shell's either way. Names lines and keys, never a value or a path.
 */
export function envProblemOf(read) {
  if (!read || typeof read !== "object") return null;
  // A file gone between the reader's two looks at it is gone too.
  if (read.absent === true || read.unreadable === "ENOENT") return { kind: "absent", keys: null };
  if (read.untrusted) return { kind: "untrusted", keys: null };
  if (read.unreadable) return { kind: "unreadable", code: errorCodeOf(read.unreadable), keys: null };
  const skipped = Array.isArray(read.hazardSkipped) ? [...read.hazardSkipped].sort() : [];
  if (skipped.length > 0) return { kind: "hazard", line: Number.isSafeInteger(read.hazard?.line) ? read.hazard.line : null, keys: skipped };
  const unread = Array.isArray(read.unread) ? read.unread.filter((row) => row && row.shellSet !== true && typeof row.key === "string") : [];
  if (unread.length > 0) return { kind: "unread", line: Number.isSafeInteger(unread[0].line) ? unread[0].line : null, keys: [...new Set(unread.map((row) => row.key))].sort() };
  return null;
}

/**
 * A system error's code (`EACCES`, `EISDIR`), or null for anything else: the reader hands back an error's message where
 * it has no code, and a message can carry a path, which a viewer's banner must not.
 */
function errorCodeOf(text) {
  return typeof text === "string" && /^E[A-Z0-9_]{1,30}$/.test(text) ? text : null;
}

/** The problem a reading that threw stands for: the `.env` could not be read, by the error's code alone. */
export function thrownProblem(e) {
  return { kind: "unreadable", code: errorCodeOf(e?.code), keys: null };
}

/** What tells one problem from another: its kind and the keys it hides, never the line (an edit above it moves that). */
const problemIdentity = (problem) => (problem === null ? null : JSON.stringify([problem.kind, problem.keys]));

/** The sentence for an `envProblemOf` problem: what keeps the `.env` from being read, in a few words. */
function problemWords(problem) {
  switch (problem.kind) {
    case "absent":
      return "there is no file there any more";
    case "untrusted":
      return "another account can change it, so the console takes nothing from it";
    case "unreadable":
      return `it could not be read${problem.code ? ` (${problem.code})` : ""}`;
    case "hazard":
      return `${problem.line === null ? "a line" : `line ${problem.line}`} is one the service's loader reads differently, so ${keyList(problem.keys)} cannot be read from it`;
    default:
      return `${problem.line === null ? "a line" : `line ${problem.line}`} assigns ${keyList(problem.keys)} in a form the service's loader may read differently`;
  }
}

/**
 * The reasons a console needs a restart, from what it read at `start`, what the same reads give `now` (each `{ values,
 * problem }`: `values` a key's reading as a comparable string, never shown; `problem` `envProblemOf`'s) and the
 * databases its held clients were refused (`refusedDatabaseOf`'s answers). Returns `[]`, or reasons `{ kind, sentence }`
 * (`settings` with `keys`, `env` with `problem`, `database` with `db`), each sentence a backticked catalog sentence
 * (`withCode`). Pure.
 */
export function restartReasons({ start, now, refused = [] }) {
  const reasons = [];
  const problem = now?.problem ?? null;
  const fresh = problem !== null && problemIdentity(problem) !== problemIdentity(start?.problem ?? null) ? problem : null;
  const covered = fresh === null ? new Set() : fresh.keys === null ? null : new Set(fresh.keys);
  const before = start?.values ?? {};
  const after = now?.values ?? {};
  const changed = covered === null ? [] : [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => (before[key] ?? null) !== (after[key] ?? null) && !covered.has(key)).sort();
  if (changed.length > 0) {
    const one = changed.length === 1;
    // Except the kill switch, which reads VALKEY_URL from the `.env` at each use (`killSwitchPlan`), so the service's own
    // Valkey is paused whatever this console was started with; the sentence says so rather than claiming every use waits.
    const killSwitch = changed.includes("VALKEY_URL") ? " Pause the fleet and Resume the fleet already use the `VALKEY_URL` the .env names now; the pages read the one the console started with." : "";
    reasons.push({ kind: "settings", keys: changed, sentence: `${keyList(changed)} ${one ? "has" : "have"} changed in the deployment's .env since this console started, and the console keeps the ${one ? "value" : "values"} it started with until it is restarted.${killSwitch}` });
  }
  if (fresh !== null) {
    reasons.push({ kind: "env", problem: fresh, sentence: `The deployment's .env cannot be read now: ${problemWords(fresh)}. Fix it before restarting the console, since one started now would run without what it cannot read.` });
  }
  // The two held clients read VALKEY_URL by the same rule, so one refusal is said once; one without its number only alone.
  const dbs = [...new Set(refused.filter((r) => r !== null && typeof r === "object").map((r) => (Number.isSafeInteger(r.db) ? r.db : null)))];
  const known = dbs.filter((db) => db !== null);
  for (const db of known.length > 0 ? known : dbs) {
    const which = db === null ? "the database" : `database ${db}, the one`;
    reasons.push({ kind: "database", db, sentence: `Valkey refused ${which} \`VALKEY_URL\` named when this console started, and the console does not try a refused database again. Name one that Valkey has, or raise \`databases\` in its configuration, then restart the console.` });
  }
  return reasons;
}

/** The notice for `reasons`: `{ title, reasons }`, or null for none. */
export function restartNoticeOf(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const title = reasons.some((r) => r.kind !== "env") ? RESTART_TITLE : RESTART_FIX_FIRST_TITLE;
  return { title, reasons };
}

/** The notice's one log line, plain text (the catalog's backticks dropped), or the cleared line for none. */
export function restartLogLine(notice) {
  if (notice === null) return `pi-dispatch-console: ${RESTART_CLEARED}`;
  const lead = notice.title === RESTART_TITLE ? "restart needed" : "fix the deployment's .env before a restart";
  return `pi-dispatch-console: ${lead}: ${notice.reasons.map((r) => r.sentence.replaceAll("`", "")).join(" ")}`;
}

/** The banner's sentence: every reason's, each name in the code face. */
export function restartBody(notice) {
  return html`${notice.reasons.map((r, i) => html`${i > 0 ? " " : ""}${withCode(r.sentence)}`)}`;
}

/**
 * The watch serve keeps (see the header). `start` is `readNow()`'s answer at start; `readNow()` reads the same again
 * (`{ values, problem }`); `refused()` the databases the held clients were refused. `log` takes one line. Returns
 * `{ current, check, close }`: `current()` the notice a page draws (null for none), `check()` a read now, `close()` the
 * timer stopped. A read that throws is a problem of its own (`unreadable`), said, never a silent "nothing changed".
 */
export function makeRestartWatch({ start, readNow, refused = () => [], now = () => Date.now(), timers = { setInterval, clearInterval }, log = () => {}, recheckMs = RESTART_RECHECK_MS, everyMs = RESTART_CHECK_EVERY_MS }) {
  let held = null;
  let said = JSON.stringify(null);
  const check = () => {
    let read;
    try {
      read = readNow();
    } catch (e) {
      read = { values: start?.values ?? {}, problem: thrownProblem(e) };
    }
    let databases = [];
    try {
      databases = refused() ?? [];
    } catch {
      databases = [];
    }
    const notice = restartNoticeOf(restartReasons({ start, now: read, refused: databases }));
    const key = JSON.stringify(notice);
    if (key !== said) {
      said = key;
      log(restartLogLine(notice));
    }
    held = { at: now(), notice };
    return notice;
  };
  const current = () => {
    const t = now();
    if (held !== null && t >= held.at && t - held.at < recheckMs) return held.notice;
    return check();
  };
  const timer = Number.isSafeInteger(everyMs) && everyMs > 0 ? timers.setInterval(() => {
    try {
      check();
    } catch {
      // A log sink that throws costs that line, never the timer or the process; the next tick reads again.
    }
  }, everyMs) : null;
  timer?.unref?.();
  return {
    current,
    check,
    close() {
      if (timer !== null) timers.clearInterval(timer);
    },
  };
}
