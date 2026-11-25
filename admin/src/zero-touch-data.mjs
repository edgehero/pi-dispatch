/** Page-specific reads and console-only writes. Private question input has no path through this service. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue, closeWithin, enqueueQuestionGroupJob } from "@edgehero/pi-dispatch/queue";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { makeQuestionGroupStore } from "@edgehero/pi-dispatch/question-groups";
import { fixIdOf, makeZeroTouchFixStore } from "@edgehero/pi-dispatch/zero-touch-fixes";
import { makeZeroTouchOutcomes, ZERO_TOUCH_OUTCOMES_DIR } from "@edgehero/pi-dispatch/zero-touch-outcomes";
import { makeTouchStore } from "@edgehero/pi-dispatch/touch-state";
import { makeTouchOutbox } from "@edgehero/pi-dispatch/touch-outbox";
import { readZeroTouch, ZERO_TOUCH_NO_PROJECT, zeroTouchProjectMatches } from "@edgehero/pi-dispatch/zero-touch";
import { runMirrorMaxRunsOf } from "@edgehero/pi-dispatch/retention";
import { QUEUE_CLOSE_TIMEOUT_MS, readRunById, RUN_MIRROR_UNREAD } from "./read-model.mjs";
import { addNeverLeft, boundedClient, dropDeadQueue, checkTriggerFixSource, connectedQueue, CONFIRM_READ_TIMEOUT_MS, refusedByValkey, STORE_TIMEOUTS, TRIGGER_FIX_UNCHECKED, unconfirmedWrite, valkeyRead, within } from "./job-actions.mjs";
import { runMatches } from "./run-filter.mjs";
import { planZeroTouchGroup, planZeroTouchName, planZeroTouchInstruction, planZeroTouchInstructionUndo, applyZeroTouchFilePlan } from "./zero-touch-actions.mjs";
import { fileCaseOfError } from "./file-case.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");

/**
 * How long the Zero touch page's read may take in all (issue #961), the fleet snapshot's ten seconds: it folds the
 * window's records and the stores, each read with a bound of its own, and one after another those add up without end
 * on a Valkey that stopped answering.
 */
export const ZERO_TOUCH_READ_TIMEOUT_MS = 10_000;

/**
 * The bound one command of the report's stores has by itself (the question groups', the touch index's and the run
 * records' own defaults), named here (issue #988) for a page's deadline: the page's read hands each of them this or
 * what the deadline has left, whichever is sooner. The fix store takes no bound and keeps its own, the same two seconds.
 */
export const ZERO_TOUCH_STORE_MS = 2_000;

/** What a configuration fix says when its accounting could not be begun or staged: the file was not touched. */
const ACCOUNTING_UNPREPARED = "Fix accounting could not be prepared. Nothing was changed; try again when Valkey is available.";
/**
 * What it says when the staging itself was asked for and not answered (issue #987). The fix store ends each command by
 * a timer of its own, 2 seconds, with an error that cannot say whether it was sent, and the first command of a stage is
 * its write: a row that lands when Valkey answers again stays `pending` (no change ever proves it applied), and the
 * Zero touch page then reads its fixes as partial until that row expires. "Nothing was changed" was said of that.
 */
export const FIX_STAGE_UNCONFIRMED = unconfirmedWrite({ what: "The fix's accounting row", done: "staged", asked: "it", next: "The configuration was not changed; preview the change again once Valkey answers." });
/**
 * What it says when Valkey ANSWERED the staging's transaction and one of its commands with an error (the store's
 * "fix metadata unavailable"): a transaction is not rolled back, so the commands that did not fail were made. The row
 * can be there with no entry in the list of fixes, which no page then reads, or be listed with a part missing, which
 * the page reads as fixes that are partial. It said "Nothing was changed" of that as well.
 */
export const FIX_STAGE_IN_PART = "The fix's accounting row may have been staged in part: Valkey answered its staging with an error. The configuration was not changed; preview the change again once Valkey is well.";
/**
 * A stage that threw. Valkey's own refusal of the whole transaction staged nothing; a transaction it answered with one
 * command's error staged the rest; anything else (the store's timer, a lost answer) may land when Valkey answers again.
 */
const stageRefusal = (err) => {
  if (refusedByValkey(err)) return { invalid: ACCOUNTING_UNPREPARED };
  return { invalid: err?.message === "fix metadata unavailable" ? FIX_STAGE_IN_PART : FIX_STAGE_UNCONFIRMED, partial: true };
};
/**
 * Whether a stage that threw may have left its row behind (issue #1072): everything but Valkey's own refusal of the
 * whole transaction. The change is not made after such a stage, so its outcome is known, and a row that lands later
 * is one a settle refuses (`outcomes`), never one it commits by its bytes.
 */
const stageMayLand = (err) => !refusedByValkey(err);
/**
 * What an Undo says when its instruction was put back in the triggers file and its fix could not then be marked undone
 * (issue #987): a change that landed in part, said as one, in the bar and in the audit row. The file is changed by
 * then, whatever became of the mark: thrown on, the store's timer made the confirm say the change could not be made
 * and that nothing was changed. Nothing repairs the mark, so the sentence says what stays so: the fix is still shown
 * as applied until its row expires, and a second Undo finds the instructions already as it would write them
 * (`planZeroTouchInstructionUndo` says that).
 */
export const UNDO_UNMARKED = "The instruction was put back as it was before this fix, but the fix could not be marked undone: Zero touch may still show it as applied until its row expires. Do not undo it again.";

/** What a settle's preview and confirm say when nothing waits (issue #1076): another settle, or the worker's daily sweep, came first. */
export const SETTLE_NOTHING = "Nothing is waiting to be settled. Reload the Zero touch page.";
/**
 * What a settle says when the fix store did not answer it after the touches were settled (issue #1076): some fixes may
 * have been committed. Settling again is safe, since a committed fix is no longer pending.
 */
export const SETTLE_IN_PART = "The pending accounting may have been settled in part: Valkey did not answer. Preview the settle again once Valkey answers; settling twice records nothing twice.";
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a grouping confirm says of an add that was started and not confirmed, and of a status write that was not answered. */
export const GROUP_UNCONFIRMED = "The grouping job may or may not have been queued: the queue did not confirm it. Preview it again first: the preview says when a grouping is pending. A second one is paid again.";
// How long it may read as pending is said too (issue #987): only a grouping's own status write replaces the mark (one
// the worker refuses before it starts writes none), or the record's expiry ends it, and the confirm that follows such
// a mark pays again.
export const GROUP_STATUS_UNANSWERED = "Nothing was queued: the question's grouping status write was not answered, so it may read as pending until a grouping records a result or its record expires.";

/** This project's own fixed sentences an error may carry into a log line: the stores' timer words, and the fix store's word for a transaction Valkey answered with an error. */
const LOGGED_SENTENCES = Object.freeze([...STORE_TIMEOUTS, "fix metadata unavailable"]);
/**
 * What a log line says of an error (issue #987): its name and its code always, the mark this project set on it, and
 * its message ONLY when that is one of this project's own fixed sentences (`LOGGED_SENTENCES`). A log names keys,
 * never values, and that is a guarantee here and not a habit of the errors that happen to come by: any other message
 * can quote what was stored (a row that did not parse, a reply that repeats a value), so it is left out whole.
 */
export const causeOf = (err) => {
  const name = typeof err?.name === "string" && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "Error";
  const code = typeof err?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ` ${err.code}` : "";
  const mark = err?.valkeyMayStillRun === true ? " (may still run)" : err?.valkeyNotSent === true ? " (not sent)" : "";
  return `${name}${code}${mark}${LOGGED_SENTENCES.includes(err?.message) ? `: ${err.message}` : ""}`;
};

/** What a read that ran out of time throws: its page says unavailable, its preview that it failed; nothing was written for it. */
const READ_LATE = Symbol("read-late");

export function makeZeroTouchService({ paths, env = {}, fs = nodeFs, now = Date.now, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, triggerBindingFn = checkTriggerFixSource, log = () => {}, readTimeoutMs = ZERO_TOUCH_READ_TIMEOUT_MS, stepTimeoutMs = CONFIRM_READ_TIMEOUT_MS } = {}) {
  const retentionDays = /^\d+$/.test(String(env.PI_LOG_RETENTION_DAYS ?? "30")) ? Number(env.PI_LOG_RETENTION_DAYS ?? 30) : 30;
  // The mirror's cap (PI_RUN_MIRROR_MAX_RUNS, issue #761), read as the capacity report reads it, so an index the workers
  // were allowed to grow past the built-in cap does not read as a history a trim cut short.
  const indexMax = runMirrorMaxRunsOf(env.PI_RUN_MIRROR_MAX_RUNS).value;
  const config = () => parseTriggersDocument(fs.readFileSync(paths.triggersPath, "utf8"), paths.triggersPath).zeroTouch;
  const repairFiles = new Set(Object.entries(paths).filter(([key, value]) => /(?:File|Path)$/.test(key) && typeof value === "string").map(([, value]) => value));
  // What proves a pending fix landed: the triggers file's entry, and a configuration file only on the console's own
  // allowlist (a path a peer wrote into the row never chooses a read). The page's read and the settle use the same two.
  const proof = { readTrigger: (index) => JSON.parse(fs.readFileSync(paths.triggersPath, "utf8")).triggers?.[index], readFile: (path) => repairFiles.has(path) ? fs.readFileSync(path, "utf8") : null };
  // How each change ended, where the console knew it and its mark may not have landed (issue #1072): written before the
  // commit or the refusal, removed once that is answered, read by the proof before the bytes. A failure to write it is
  // logged, and the row keeps the byte rule, as before the file existed.
  const outcomes = makeZeroTouchOutcomes({ dir: join(paths.logsDir, ZERO_TOUCH_OUTCOMES_DIR), fs, now, log });
  // The proof with what this host's folder holds, read once per call, and the settle's removal of a settled row's file.
  const proved = () => { const known = outcomes.inspect().outcomes; return { ...proof, outcomeOf: (id) => known.get(id) ?? null }; };
  const forget = (id) => outcomes.remove(id);
  /**
   * The row's mark, with its outcome recorded first (issue #1072). The file goes once the mark is answered, true or
   * false: a false is a row that is gone or no longer pending, which the file cannot help. One that throws keeps the
   * file for a settle, and throws on.
   */
  const marked = async (id, outcome, mark) => {
    outcomes.record(id, outcome);
    const answer = await mark();
    outcomes.remove(id);
    return answer;
  };
  // Every path on the console's bounded client (issue #961): a command a Valkey took and never answered ends at the
  // bound, with `valkeyMayStillRun`. `timeoutMs` is for a path that only READS for its answer (the page, a preview): it
  // ends there whatever is still waiting, its client dropped so nothing more is sent. NEVER for a path that carries a
  // person's write (`withWriters`, `trackConfiguration`, `apply`): a timer that fired first would answer for a write
  // it knows nothing about, where the client's own error says whether it was sent.
  // `reads` (issue #987) is for a timed path that writes nothing at all (a preview, a fix's context, and since issue
  // #1076 the page's read): its timer's error is marked `valkeyNotSent`, which the console's preview answers as Valkey
  // unreachable with Try again. The page's read repaired what an earlier write left behind before it read, so its
  // timer could not say that; it now only counts what a settle would do (`zero-touch-settle`).
  const using = async (fn, { timeoutMs = null, reads = false } = {}) => {
    const redis = boundedClient(redisFn, paths.valkeyUrl);
    const groups = makeQuestionGroupStore({ redis, now, retentionDays });
    const fixes = makeZeroTouchFixStore({ redis, now, retentionDays });
    const touches = makeTouchStore({ redis, now, retentionDays });
    const outbox = makeTouchOutbox({ dir: join(paths.logsDir, "touch-outbox"), store: touches, fs, log });
    // The stores that take a bound, made again with `ms` for each of their commands (issue #988): a page's read makes
    // them step by step, each with what is left of its deadline.
    const boundedBy = (ms) => ({ groups: makeQuestionGroupStore({ redis, now, retentionDays, timeoutMs: ms }) });
    const release = () => {
      try { redis.disconnect(); } catch { /* already closed */ }
    };
    const work = Promise.resolve().then(() => fn({ redis, groups, fixes, touches, outbox, boundedBy }));
    if (timeoutMs === null) {
      try { return await work; }
      finally { release(); }
    }
    try {
      const got = await within(work, timeoutMs, () => READ_LATE);
      if (got === READ_LATE) throw Object.assign(new Error(`Valkey did not answer within ${timeoutMs / 1000} seconds`), reads ? { valkeyNotSent: true } : {});
      return got;
    } finally {
      release();
      work.catch(() => {});
    }
  };
  // The two store reads that throw when Valkey does not answer are asked through `valkeyRead` (issue #987): the store's
  // own timer ends each after 2 seconds, before the client's bound, with an error that names no Valkey, and the preview
  // then said it had failed. The confirm's re-plan catches whatever this throws as nothing sent, as before.
  /**
   * Take back the accounting of a change that was not made (issue #987): the staged row is refused and the touch
   * intent aborted. NEVER throws and never answers, so the change's own answer goes on as it is: a failure here is
   * logged with its cause, since the operator is told nothing of it and the row then stays pending. The fix store
   * throws what it could not do; the touch store ANSWERS an error and never throws, so its answer is read too. The
   * abort is reached whether or not the refusal could be written, and it comes last, since the intent's file is what
   * a later read of the page would begin again.
   *
   * `landed` is for a change whose answer says it may have been made (`partial`, or a throw marked
   * `valkeyMayStillRun`): its row is left pending, for a settle (`zero-touch-settle`) to commit by the file's digest,
   * never refused. NO action reaches that today: every action that can be made because of a refusal changes a file alone,
   * and none of them answers `partial` or throws the mark. It is for one that would write Valkey beside its file, and
   * the tests reach it through `trackConfiguration` itself.
   */
  async function untrack({ fixes, outbox }, fixId, intent, landed) {
    if (!landed) {
      try { await marked(fixId, "refused", () => fixes.reject(fixId)); }
      catch (err) { log("zero_touch_fix_reject_pending", { cause: causeOf(err) }); }
    }
    try {
      const aborted = await outbox.abort(intent);
      if (typeof aborted?.error === "string") log("zero_touch_touch_abort_pending", { cause: /^[a-z-]{1,60}$/.test(aborted.error) ? aborted.error : "error" });
    } catch (err) { log("zero_touch_touch_abort_pending", { cause: causeOf(err) }); }
  }
  async function plan(name, params, stores) {
    if (name === "zero-touch-group") return planZeroTouchGroup({ params, config: config(), meta: await valkeyRead(stores.groups.readMeta(params.runId)), surface: "console" });
    if (name === "zero-touch-name") {
      const snapshot = await stores.groups.publicSnapshot();
      if (!snapshot.groups.some((g) => g.id === params.groupId)) return { refusal: "This group is no longer retained. Reload the Zero touch page." };
      return planZeroTouchName({ params, paths, fs, surface: "console" });
    }
    if (name === "zero-touch-instruction") {
      const source = await readRunById(stores.redis, { logsDir: paths.logsDir, jobId: params.runId, fs });
      // A run record that could not be read is not one that names another trigger (issue #844): only `missing` says both
      // places were read. A mirror that did not answer may answer on a reload; a file here that is not a record will not.
      if (source.unreadable === RUN_MIRROR_UNREAD) return { refusal: TRIGGER_FIX_UNCHECKED };
      if (!source.record && !source.missing) return { refusal: "This host's record of the source run cannot be read as a record, so its trigger cannot be checked. Nothing was changed." };
      const snapshot = await stores.groups.publicSnapshot();
      const binding = await triggerBindingFn({ url: paths.valkeyUrl, jobId: params.runId, index: params.index, triggersPath: paths.triggersPath, fs, redisFn, queueFn });
      if (!binding.ok) return { refusal: binding.refusal };
      // Nor is a group the store could not list one that is gone.
      if (snapshot.state !== "ok" && typeof params.groupId === "string" && !snapshot.groups.some((g) => g.id === params.groupId)) return { refusal: TRIGGER_FIX_UNCHECKED };
      return planZeroTouchInstruction({ params, paths, sourceRecord: source.record, group: snapshot.groups.find((g) => g.id === params.groupId), binding, fs, surface: "console" });
    }
    if (name === "zero-touch-undo") return planZeroTouchInstructionUndo({ params, paths, fix: await valkeyRead(stores.fixes.read(params.fixId, { includeUndo: true })), fs, surface: "console" });
    if (name === "zero-touch-settle") return planSettle(stores);
    return { refusal: "This Zero touch action is not available." };
  }
  /**
   * What a settle would do (issue #1076), read only: the touch intents this host's outbox holds as applied (actions that
   * ran and whose accounting did not finish), the ones it holds as pending (interrupted before they said whether they
   * ran, which a settle only begins again), and the pending fixes whose file or trigger proves the change landed.
   * Nothing waiting is a refusal, so a confirm a settle elsewhere overtook says so rather than settling nothing.
   */
  async function planSettle(stores) {
    const touches = stores.outbox.inspect();
    const { ready, refused } = await valkeyRead(stores.fixes.settleable(proved()));
    if (touches.applied === 0 && ready.length === 0 && refused.length === 0) return { refusal: SETTLE_NOTHING };
    const lines = [
      ...(touches.applied > 0 ? [`${plural(touches.applied, "action")} that ran and whose touch was not recorded: each is recorded once, and none runs again.`] : []),
      ...(ready.length > 0 ? [`${plural(ready.length, "fix", "fixes")} whose change landed and whose accounting did not finish: each is listed under Fixes that worked.`] : []),
      // Issue #1072: a change this console knows was not made, whose refusal Valkey did not take. Closed, never a fix.
      ...(refused.length > 0 ? [`${plural(refused.length, "change")} that ${refused.length === 1 ? "was" : "were"} not made and whose accounting did not finish: each is closed, and none is listed as a fix.`] : []),
      ...(touches.pending > 0 ? [touches.pending === 1 ? "1 action interrupted before it said whether it ran stays unknown: a settle begins it again and cannot prove it." : `${touches.pending} actions interrupted before they said whether they ran stay unknown: a settle begins them again and cannot prove them.`] : []),
    ];
    return { plan: { title: "Settle pending Zero touch accounting", summary: lines, target: "Zero touch accounting", settle: { touches: touches.applied, fixes: ready.length, refused: refused.length } } };
  }
  /**
   * The settle itself: the outbox's repair, then the fix store's. Each is idempotent (an intent is published once by
   * its id, a committed fix is no longer pending), so a settle repeated, or one the worker's daily sweep overtook,
   * changes nothing twice. The fix store ends each command by a timer of its own: a throw after the outbox's repair is
   * a settle that may have landed in part, said as one.
   */
  async function settle(stores) {
    const touches = await stores.outbox.repair();
    let fixes;
    try { fixes = await stores.fixes.repair({ ...proved(), forget }); }
    catch (err) { log("zero_touch_fix_settle_pending", { cause: causeOf(err) }); return { invalid: SETTLE_IN_PART, partial: true }; }
    const left = stores.outbox.inspect().applied;
    return { ok: true, settled: { touches: touches.repaired, fixes: fixes.settled, refused: fixes.refused }, ...(left > 0 ? { note: `${plural(left, "touch")} could not be recorded: Valkey did not take ${left === 1 ? "it" : "them"}. Settle again once Valkey answers` } : {}) };
  }
  return {
    // `within` (issue #988) is a page's deadline: a read's own bound, or what the deadline has left when that is
    // sooner. The report's steps follow one another (the fix proof, the two snapshots, the fold of the window), each with
    // a bound of two seconds, so on a Valkey that stopped answering they end together with a six second deadline, and
    // a page that cut the read there drew "could not be read" where this read was about to say what it could not
    // read: a window that is partial, this host's runs, the mirror not reached. With `within` each step that takes a
    // bound is made with what is left, so the report ends by the deadline in its own words whatever came before it.
    async read({ days = 30, windowDays = days, project = null, scope = null, scopeId = scope, includeRecords = false, within: deadline = null } = {}) {
      return using(async ({ redis, groups: ownGroups, fixes, outbox: ownOutbox, boundedBy }) => {
        const left = typeof deadline === "function" ? () => deadline(ZERO_TOUCH_STORE_MS) : null;
        const step = () => (left ? boundedBy(left()) : { groups: ownGroups });
        // What a settle would do, and nothing done (issue #1076): a page view is a read. The outbox is counted from this
        // host's files; the fixes are proved against their files and triggers. A proof the store did not answer leaves
        // `fixesOpen` unsaid, since a row that still reads pending may then be one a settle commits.
        const touches = ownOutbox.inspect();
        let inspected = true;
        let settleable = 0;
        let refusedWaiting = 0;
        try { const found = await fixes.settleable(proved()); settleable = found.ready.length; refusedWaiting = found.refused.length; }
        catch (err) { inspected = false; log("zero_touch_fix_inspect_failed", { cause: causeOf(err) }); }
        // One word per case (issue #988): a triggers file that does not exist configures no grouping, which is an
        // answer; one nobody could read is unread; one that was read and is refused does not load.
        let cfg; let configUnavailable = false; let configuration = null;
        try { cfg = config(); } catch (error) {
          const fileCase = fileCaseOfError(error);
          if (fileCase !== "absent") { configUnavailable = true; configuration = fileCase === "unreadable" ? "unreadable" : "invalid"; }
        }
        const { groups } = step();
        const [questions, changes] = await Promise.all([groups.publicSnapshot({ names: cfg?.names ?? {} }), fixes.publicSnapshot()]);
        const selectedGroups = questions.groups.filter((g) => zeroTouchProjectMatches(g.project, project) && (!scopeId || g.scopeId === scopeId));
        const selectedSources = questions.rows.filter((r) => zeroTouchProjectMatches(r.project, project) && (!scopeId || r.scopeId === scopeId));
        const report = await readZeroTouch({ redis, logsDir: paths.logsDir, retentionDays, indexMax, localHost: env.PI_WORKER_NAME ?? null, now, windowDays, project, scopeId, groups: selectedGroups, fixes: changes.fixes, fs, includeRecords: true, ...(left ? { timeoutMs: left() } : {}) });
        const knownSources = new Set(questions.rows.map((r) => r.runId));
        const missingSources = cfg?.capture && questions.state === "ok" ? report.records.filter((r) => r.reason === "awaiting-input" && zeroTouchProjectMatches(r.project, project) && (!scopeId || r.touchScopeId === scopeId) && !knownSources.has(r.jobId)).map((r) => ({ runId: r.jobId, status: "source-unavailable" })) : [];
        report.grouping = { enabled: cfg?.capture === true, state: configUnavailable ? "configuration-unavailable" : questions.state, ...(configuration === null ? {} : { configuration }), partial: questions.partial, pending: selectedSources.filter((r) => r.status === "pending").length, unassigned: selectedSources.filter((r) => !r.groupId).length };
        report.ungroupedRunIds = selectedSources.filter((r) => !r.groupId).map((r) => r.runId);
        report.groupingStatuses = [...selectedSources.filter((r) => !r.groupId).map((r) => ({ runId: r.runId, status: r.status })), ...missingSources];
        report.grouping.partial = questions.partial || missingSources.length > 0;
        report.fixes = report.fixes.map((f) => f.groupId && report.grouping.partial ? { ...f, partial: true, worked: false, status: "observing" } : f);
        report.fixesPartial = changes.partial;
        // What waits for a settle (issue #1076): touches this host's outbox holds as applied, ones it holds as pending
        // (unknown, which a settle cannot prove), and fixes whose change is proved landed.
        // Issue #1072: and the changes this host knows were not made, whose refusal a settle records.
        report.waiting = { touches: touches.applied, unknown: touches.pending, fixes: settleable, refused: refusedWaiting };
        // The changes whose accounting is open and that no settle can commit, since their file does not show them, and for
        // how many days such a row lives at most: its record's retention, by the fix store's own rule.
        report.fixesOpen = inspected && changes.state === "ok" && Number.isSafeInteger(changes.pendingCount) ? Math.max(0, changes.pendingCount - settleable - refusedWaiting) : 0;
        report.fixesOpenDays = Math.min(retentionDays > 0 ? retentionDays : 365, 365);
        report.groups = report.groups.map((group) => {
          const fix = report.fixes.filter((f) => f.groupId === group.id && !f.undoneAt).sort((a, b) => b.at - a.at)[0];
          return fix ? { ...group, status: "fixed", fixedAt: fix.at } : group;
        });
        return report;
      }, { timeoutMs: readTimeoutMs, reads: true });
    },
    async runs({ before = null, limit = 50, filter = {}, windowDays = 30, scopeId = null, within: deadline = null } = {}) {
      const report = await this.read({ windowDays, project: filter.project ?? null, scopeId, includeRecords: true, within: deadline });
      const touched = new Set(report.touchedRunIds);
      const runFilter = filter.project === ZERO_TOUCH_NO_PROJECT ? { ...filter, project: undefined } : filter;
      const records = report.records.filter((r) => touched.has(r.jobId) && runMatches(r, runFilter) && (before === null || Date.parse(r.endedAt) < before)).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.jobId.localeCompare(b.jobId));
      let take = Math.min(limit, records.length);
      while (take < records.length && records[take].endedAt === records[take - 1].endedAt) take++;
      return { runs: records.slice(0, take), next: take < records.length ? Date.parse(records[take - 1].endedAt) : null, mirror: report.recordMirror ?? "off", truncated: report.coverage.partial, examined: report.records.length, touchCoverage: report.coverage, touchTotal: report.state !== "ready" ? null : report.totals.touched };
    },
    async preview(name, params) { return using((stores) => plan(name, params, stores), { timeoutMs: stepTimeoutMs, reads: true }); },
    async withWriters(fn) { return using(({ touches, outbox }) => fn({ touchStore: touches, touchOutbox: outbox, now })); },
    async configurationContext(runId) {
      return using(async ({ redis }) => {
        const { record } = await readRunById(redis, { logsDir: paths.logsDir, jobId: runId, fs });
        if (record?.outcome !== "policy" || !/^[a-f0-9]{64}$/.test(record.touchScopeId ?? "") || typeof record.reason !== "string") return null;
        return { runId, scopeId: record.touchScopeId, project: record.project ?? null, reason: record.reason, groupId: null, triggerIndex: record.triggerIndex ?? null };
      }, { timeoutMs: stepTimeoutMs, reads: true });
    },
    async trackConfiguration(entry, apply) {
      return using(async ({ fixes, outbox }) => {
        const cause = entry.payload.touchContext;
        const intent = await outbox.begin({ ...cause, cause: "config-fix", at: now(), nonce: entry.ticketDigest ?? entry.afterDigest });
        let staged;
        const value = { ...cause, kind: "config" };
        const identity = entry.ticketDigest ?? entry.afterDigest;
        try { staged = await fixes.stage(value, { identity, privateUndo: entry.target && entry.afterDigest ? { file: entry.target, afterDigest: entry.afterDigest } : null }); }
        catch (err) { if (stageMayLand(err)) outcomes.record(fixIdOf(value, identity), "refused"); await outbox.abort(intent).catch(() => {}); return stageRefusal(err); }
        if (!staged.ok) { await outbox.abort(intent); return { invalid: staged.invalid ?? "The source refusal is not available; nothing was changed." }; }
        // The change itself. Its own answer is the answer, whatever the tracking does after it (issue #987): the
        // staged row's refusal went through the fix store, whose timer threw in place of an answer that said what had
        // happened, and the intent's abort behind it was then never reached.
        let result;
        try { result = await apply(); }
        catch (error) { await untrack({ fixes, outbox }, staged.fix.id, intent, error?.valkeyMayStillRun === true); throw error; }
        if (!result?.ok) { await untrack({ fixes, outbox }, staged.fix.id, intent, result?.partial === true); return result; }
        let pending = false;
        try { pending = !await marked(staged.fix.id, "applied", () => fixes.commit(staged.fix.id)); } catch (err) { pending = true; log("zero_touch_fix_pending", { cause: causeOf(err) }); }
        const tracked = await outbox.applied(intent);
        return { ...result, ...(pending || !tracked.ok ? { warning: "The configuration was changed; its accounting is waiting to be settled on the Zero touch page. Do not repeat the change." } : {}) };
      });
    },
    async apply(name, entry) {
      return using(async (stores) => {
        const params = entry.payload.params;
        // A re-plan whose read was not answered sent nothing (issue #961): Valkey is why, not a change, and its error
        // carries a read's mark, which the confirm would word as a change that may have been made.
        let planned;
        try { planned = await plan(name, params, stores); }
        catch { return { unreachable: true }; }
        if (!planned.plan) return { invalid: planned.refusal ?? "The change no longer applies; preview it again." };
        const p = planned.plan;
        if (p.afterText && hash(p.afterText) !== entry.afterDigest) return { invalid: "The file changed since the preview. Reload and preview it again." };
        if (name === "zero-touch-settle") return settle(stores);
        if (name === "zero-touch-group") {
          if (p.configDigest !== entry.payload.configDigest || p.digest !== entry.payload.digest) return { invalid: "The question or grouping configuration changed since the preview." };
          // A paid enqueue in two phases (issue #961, `connectedQueue`): a connected queue under a bound, past which
          // nothing was sent; then the add under its client's bound alone. The job's id comes from the confirm's
          // ticket, so one confirm is one job however often its add is sent, where a random id made each send a paid
          // job of its own. An entry without a ticket (a caller that is not the console) keeps a random id.
          const connected = await connectedQueue({ url: paths.valkeyUrl, queueFn, parseConnectionFn, connectTimeoutMs: stepTimeoutMs });
          if (!connected.queue) return { unreachable: connected.unreachable };
          const { queue } = connected;
          // The status is written `pending` BEFORE the add, and put back only where the add provably queued nothing:
          // an add whose answer was lost leaves it, so the next preview says a grouping is marked pending and that
          // confirming can pay for another (`GROUP_PENDING_LINE`). A pending that never resolves (the job did not
          // land, or the worker refused it before it started, which writes no status) stays until a grouping records
          // a result or the question's record expires; it refuses nothing, and a later confirm writes it again.
          let prior;
          let marked;
          let writing = false;
          try {
            prior = (await stores.groups.readMeta(p.runId))?.status ?? null;
            writing = true;
            marked = await stores.groups.setStatus(p.runId, "pending");
          } catch {
            void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
            // Nothing was queued. A status write that was not answered may still land (the store's own timer ends it
            // before the client's bound does, with an error that cannot say whether it was sent), and then the
            // question reads as pending with no job: said, never "nothing was changed".
            return writing ? { invalid: GROUP_STATUS_UNANSWERED, partial: true } : { unreachable: true };
          }
          const putBack = async () => {
            if (marked !== true || typeof prior !== "string" || prior === "pending") return;
            try { await stores.groups.setStatus(p.runId, prior); } catch { /* it reads as pending, which the preview says */ }
          };
          let jobId;
          try {
            jobId = await enqueueQuestionGroupJob(queue, p, /^[a-f0-9]{64}$/.test(entry.ticketDigest ?? "") ? { nonce: () => entry.ticketDigest } : {});
          } catch (err) {
            // Issue #1072: an add its client refused before it left (a connection that died after the connect) queued
            // nothing, as one Valkey refused did not.
            if (refusedByValkey(err) || err?.message === "invalid question grouping reference" || addNeverLeft(err)) {
              if (addNeverLeft(err)) dropDeadQueue(queue);
              await putBack();
              return { unreachable: true };
            }
            return { invalid: GROUP_UNCONFIRMED, partial: true };
          } finally { void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS); }
          return marked === true ? { ok: true, jobId } : { ok: true, jobId, warning: "The grouping job was queued; its status could not be updated. Do not queue it again." };
        }
        const intent = name === "zero-touch-instruction" ? await stores.outbox.begin({ runId: p.runId, cause: "config-fix", at: now(), nonce: entry.ticketDigest ?? entry.afterDigest, scopeId: p.scopeId, project: p.project ?? null }) : null;
        let staged;
        if (intent) {
          try { staged = await stores.fixes.stage(p, { privateUndo: p.privateUndo, identity: entry.ticketDigest ?? entry.afterDigest }); }
          catch (err) { if (stageMayLand(err)) outcomes.record(fixIdOf(p, entry.ticketDigest ?? entry.afterDigest), "refused"); await stores.outbox.abort(intent).catch(() => {}); return stageRefusal(err); }
          if (!staged.ok) { await stores.outbox.abort(intent); return { invalid: staged.invalid ?? "The fix could not be recorded; nothing was changed." }; }
        }
        // The file's write. Refused or thrown, the accounting staged for it is taken back (issue #987): a write that
        // THREW (a trigger edited between this confirm's look at it and its write) left the row pending and the
        // intent's file for every later read of the page to begin again, where one that answered a refusal took both back.
        let result;
        try { result = applyZeroTouchFilePlan({ plan: { ...p, expect: entry.expect }, paths, fs }); }
        catch (error) { if (intent) await untrack(stores, staged.fix.id, intent, false); throw error; }
        if (result.invalid || result.ok === false) { if (intent) await untrack(stores, staged.fix.id, intent, false); return result; }
        if (name === "zero-touch-instruction") {
          let fixPending = false;
          try { fixPending = !await marked(staged.fix.id, "applied", () => stores.fixes.commit(staged.fix.id)); }
          catch (err) { fixPending = true; log("zero_touch_fix_pending", { cause: causeOf(err) }); }
          const tracked = await stores.outbox.applied(intent);
          return { ok: true, fixId: staged.fix.id, ...(tracked.ok && !fixPending ? {} : { warning: "The instruction was saved; its accounting is waiting to be settled on the Zero touch page. Do not repeat the edit." }) };
        }
        // The Undo's file is written by now. Its mark goes through the fix store, whose read and write each end by the
        // store's own timer: whatever it throws, the instruction is put back in the file, so the answer is a change
        // that landed in part, with what did and what did not, never a throw (issue #987).
        if (name === "zero-touch-undo") {
          try { await stores.fixes.markUndone(params.fixId); }
          catch { return { invalid: UNDO_UNMARKED, partial: true }; }
        }
        return { ok: true };
      });
    },
  };
}
