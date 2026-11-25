/** Role projections and human writes for answer rules. Question/draft bytes are read only for an operator's run. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { loadGitLabAuth, loadForgejoAuth, loadAzureAuth } from "@edgehero/pi-dispatch/config";
import { forgeApiRoot, isForgeKind } from "@edgehero/pi-dispatch/forges";
import { parseProjects, projectOf } from "@edgehero/pi-dispatch/projects";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { makeAnswerDraftStore, answerStandingSource, answerRuleConfigDigest, answerApiRoot } from "@edgehero/pi-dispatch/answerer";
import { planStandingAnswerAdd, applyStandingAnswerAdd, planAnswerDraftDrop } from "./answerer-actions.mjs";
import { boundedClient, CONFIRM_READ_TIMEOUT_MS, refusedByValkey, unconfirmedWrite, valkeyRead, within } from "./job-actions.mjs";
import { writeTracking } from "./read-model.mjs";
import { fileCaseOfError } from "./file-case.mjs";
import { providerKeyNames } from "./provider-key-names.mjs";

/** What a read that ran out of time answers inside the service, told apart from every value a store returns. */
const READ_LATE = Symbol("read-late");

/**
 * What a draft's drop says when its write was asked for and not answered (issue #987). The store ends each of its
 * commands by a timer of its own, 2 seconds, before the client's bound, with an error that cannot say whether the
 * command was sent, and the drop threw it on: the confirm then said the change could not be made and that nothing was
 * changed, of a drop that landed when Valkey woke (measured on a real console: the row read `dropped` after the wake).
 */
export const DRAFT_DROP_UNCONFIRMED = unconfirmedWrite({ what: "The draft", done: "dropped", asked: "the drop", next: "Reload its run page once Valkey answers before trying again." });

const hash = text => createHash("sha256").update(text).digest("hex");
const RUN_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function answererPublicRow(row) {
  if (!row || !RUN_RE.test(row.runId ?? "")) return null;
  return { runId: row.runId, draftExists: row.draftExists === true && !["dropped", "sent"].includes(row.status), ...(typeof (row.sentBy ?? row.by) === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(row.sentBy ?? row.by) ? { sentBy: row.sentBy ?? row.by } : {}), ...(Number.isSafeInteger(row.sentAt) ? { sentAt: row.sentAt } : {}) };
}

export function answererStats(rows, now) {
  const lower = now - 30 * 86400000;
  const kept = rows.filter(r => Number(r.at ?? r.completedAt ?? r.sentAt ?? 0) >= lower);
  const total = key => kept.filter(key).length;
  const costs = kept.filter(r => Number.isFinite(r.costUsd) && r.costUsd >= 0);
  return { sent: total(r => r.disposition === "as-drafted"), edited: total(r => r.disposition === "edited"), dropped: total(r => r.status === "dropped"), passed: total(r => r.status === "passed" || r.status === "classified"), jobs: kept.length, costUsd: costs.reduce((n, r) => n + r.costUsd, 0), costPartial: costs.length !== kept.length };
}

/**
 * The bound one command of the answer store has by itself (`makeAnswerDraftStore`'s own default), named here
 * (issue #988) for a page's deadline: the page's read hands the store this or what the deadline has left.
 */
export const ANSWER_STORE_MS = 2_000;

export function makeAnswererService({ paths, env = {}, fs = nodeFs, now = Date.now, redisFn = makeRedisClient, storeFn = makeAnswerDraftStore, readTimeoutMs = CONFIRM_READ_TIMEOUT_MS } = {}) {
  // Every path on the console's bounded client (issue #961). `timed` is for a path that only READS (the page's rows, a
  // draft, a preview): it ends at `readTimeoutMs` whatever is still waiting, its client dropped, and what it throws
  // carries no `valkeyMayStillRun` (a read's error has that mark as a write's does, and a confirm that read it there
  // said a change may have been made where none was sent). NEVER for a path that carries a write (`apply`, `sent`):
  // those time their own reads (`readInTime`) and leave the write to the client's bound.
  // What a timed path throws because Valkey did not answer is marked `valkeyNotSent` (issue #987), which the console's
  // preview answers as Valkey unreachable with Try again: this timer's own error, and a read asked through
  // `valkeyRead`, whose mark is kept where every other is dropped. True of each of them, since none writes.
  // `tracking` hands `fn` the client's write tracker beside the store (`writeTracking`), for a path whose answer depends
  // on whether a write had left when the store gave up on it.
  // `storeMs` (issue #988): the store's bound for each command where a caller names one (a page's read, with what is
  // left of its deadline), the store's own otherwise.
  const using = async (fn, { timed = false, tracking = false, storeMs = null } = {}) => {
    const redis = boundedClient(redisFn, paths.valkeyUrl);
    const release = () => {
      try { redis.disconnect?.(); } catch { /* already closed */ }
    };
    const tracked = tracking ? writeTracking(redis) : null;
    const work = Promise.resolve().then(() => fn(storeFn({ redis: tracked ? tracked.redis : redis, now, retentionDays: Number(env.PI_LOG_RETENTION_DAYS ?? 30), ...(storeMs === null ? {} : { timeoutMs: storeMs }) }), tracked));
    if (!timed) {
      try { return await work; }
      finally { release(); }
    }
    let got;
    try {
      got = await within(work, readTimeoutMs, () => READ_LATE);
    } catch (err) {
      throw Object.assign(new Error(err?.message ?? String(err)), err?.valkeyNotSent === true ? { valkeyNotSent: true } : {});
    } finally {
      release();
      work.catch(() => {});
    }
    if (got === READ_LATE) throw Object.assign(new Error(`Valkey did not answer within ${readTimeoutMs / 1000} seconds`), { valkeyNotSent: true });
    return got;
  };
  /** A read inside a path that also writes: its answer, or `READ_LATE` (also for a read that failed: nothing was sent). */
  const readInTime = (reading) => within(Promise.resolve(reading).catch(() => READ_LATE), readTimeoutMs, () => READ_LATE);
  // The parsed forge configs under the keys the worker's config holds them by, for the forge table's `forgeApiRoot`.
  // Getters, so only the asked forge's loader runs, inside the catch below: a broken GitLab block in the env refuses
  // a GitLab draft and no other.
  const forgeConfigs = { get gitlab() { return loadGitLabAuth(env); }, get forgejo() { return loadForgejoAuth(env); }, get azure() { return loadAzureAuth(env); } };
  const configuredApiRoot = kind => {
    try { return answerApiRoot(forgeApiRoot(kind, forgeConfigs)); } catch { return null; }
  };
  const currentDraft = async (store, runId, config = null) => {
    const draft = await store.privateDraft(runId);
    if (!draft) return { draft: null, problem: null };
    let document, input;
    try {
      document = config ?? parseTriggersDocument(fs.readFileSync(paths.triggersPath, "utf8"), paths.triggersPath);
      input = await store.privateInput(runId);
      const rule = document.answerRules.find(rule => rule.id === draft.meta.ruleId);
      if (!input || input.runId !== runId || input.ruleId !== draft.meta.ruleId || !rule || rule.mode !== "draft" || !rule.projects.includes(input.project) || input.configDigest !== answerRuleConfigDigest(document, rule)) return { draft: null, problem: "config-changed" };
      if (!rule.categories.includes(draft.meta.category) || !Number.isFinite(draft.meta.confidence) || !Number.isFinite(draft.meta.answerableConfidence) || draft.meta.confidence < rule.confidence || draft.meta.answerableConfidence < rule.confidence || !Array.isArray(draft.sources) || !draft.sources.length) return { draft: null, problem: "output-invalid" };
      if (!input.source || typeof input.source.repo !== "string" || !isForgeKind(input.source.kind) || input.source.target?.type !== "issue") return { draft: null, problem: "source-unavailable" };
      // A completed body belongs to the instance that supplied its sources. Same repository/issue ids on
      // a newly configured host cannot authorize prefill or send; the worker separately rechecks the account.
      const root = configuredApiRoot(input.source.kind);
      if (!root || root !== answerApiRoot(input.source.apiUrl)) return { draft: null, problem: "config-changed" };
      if (paths.projectsPath) {
        const projects = parseProjects(fs.readFileSync(paths.projectsPath, "utf8"), paths.projectsPath);
        if (projectOf(input.source, projects) !== input.project) return { draft: null, problem: "config-changed" };
      }
      return { draft, problem: null };
    } catch { return { draft: null, problem: "source-unavailable" }; }
  };
  return {
    // `within` (issue #988) is a page's deadline: a read's own bound, or what the deadline has left when that is
    // sooner. The store is made with it, so this read ends inside the page's time with its own answer: the rows not
    // known, and the rules and standing answers the triggers file holds all the same, which a page that cut the read
    // from outside could only call unread.
    async read({ role, runId = null, within: left = null } = {}) {
      return using(async store => {
        const snapshot = await store.publicSnapshot();
        const rows = Array.isArray(snapshot.rows) ? snapshot.rows.map(row => ({ ...row, ...(row.by ? { sentBy: row.by } : {}) })) : [];
        if (role !== "operator") return { state: snapshot.state, partial: Boolean(snapshot.partial), rows: rows.map(answererPublicRow).filter(Boolean) };
        let config;
        try { config = parseTriggersDocument(fs.readFileSync(paths.triggersPath, "utf8"), paths.triggersPath); }
        catch (err) {
          // No `standing` list where the file that holds them could not be read or did not load (issue #844): an empty
          // one would read as none adopted. A file that does not exist is another matter (issue #988): it holds no
          // answer rule and no standing answer, which is an empty document and the page's true empty state.
          // Which of the two it is rides beside the state (issue #988): a file nobody could read (the read failed with
          // an errno, EACCES and the like), or one that was read and is refused.
          if (err?.code !== "ENOENT") return { state: "configuration-unavailable", configuration: fileCaseOfError(err) === "unreadable" ? "unreadable" : "invalid", partial: true, rows, rules: [], stats: answererStats(rows, now()) };
          config = { triggers: [], answerRules: [], standingAnswers: [] };
        }
        const standing = (config.standingAnswers ?? []).map(answer => ({ ...answer, used: rows.filter(r => r.sources?.some(s => s.kind === "standing" && s.id === answerStandingSource(answer).id)).length }));
        // Issue #1013: a rule's declared provider keys by name only (`secretNames`). Their references are the address of
        // the operator's credentials in their manager, kept out of every display as `run.secrets`' are. `secretsNotPassed`
        // are the names neither of the rule's models' providers reads, which the worker's draft builder withholds (pi's
        // generated table, the one the worker reads), so the page does not call them the draft's keys.
        const selected = RUN_RE.test(runId ?? "") ? await currentDraft(store, rows.find(row => row.draftRunId === runId)?.runId ?? runId, config) : null;
        return { state: snapshot.state, partial: Boolean(snapshot.partial), rows, rules: (config.answerRules ?? []).map(({ secrets, ...rule }) => ({ ...rule, ...(secrets ? { secretNames: Object.keys(secrets), secretsNotPassed: Object.keys(secrets).filter(name => ![rule.model, rule.decisionModel].some(ref => providerKeyNames(ref.slice(0, ref.indexOf("/"))).includes(name))) } : {}), stats: answererStats(rows.filter(row => row.ruleId === rule.id), now()) })), standing, stats: answererStats(rows, now()), ...(selected ? { privateDraft: selected.draft, privateDraftProblem: selected.problem } : {}) };
      }, { timed: true, storeMs: typeof left === "function" ? left(ANSWER_STORE_MS) : null });
    },
    async privateDraft(runId) { return RUN_RE.test(runId ?? "") ? using(async store => (await currentDraft(store, runId)).draft, { timed: true }) : null; },
    async preview(name, params) {
      if (name === "standing-answer-add") return planStandingAnswerAdd({ params, paths, fs, now });
      // The draft's read is the one thing here that throws when Valkey does not answer (the store's own timer, after 2
      // seconds, with an error that names no Valkey), so it is asked through `valkeyRead` (issue #987).
      if (name === "answer-draft-drop") return using(async store => planAnswerDraftDrop({ params, draft: (await valkeyRead(currentDraft(store, params.runId))).draft }), { timed: true });
      return { refusal: "This answerer action is not available." };
    },
    async apply(name, entry) {
      const params = entry.payload.params;
      if (name === "standing-answer-add") {
        const got = planStandingAnswerAdd({ params, paths, fs, now, adoptedAt: entry.payload.adoptedAt });
        if (!got.plan || got.plan.afterDigest !== entry.afterDigest || got.plan.beforeDigest !== entry.beforeDigest) return { invalid: "The standing answers changed since the preview. Reload and preview again." };
        return applyStandingAnswerAdd({ plan: got.plan, paths, fs });
      }
      if (name === "answer-draft-drop") return using(async (store, tracked) => {
        // The read has an end of its own. The drop below has the store's (2 seconds for each command), whose error
        // cannot say whether its command was sent, so what it left is told by what the client was asked: nothing was
        // changed while the store had only read (the row's own read comes first), and once the write was asked for it
        // may or may not have been made (issue #987). Valkey's own reply is an answer, and is thrown on as it is.
        const read = await readInTime(currentDraft(store, params.runId));
        if (read === READ_LATE) return { unreachable: true };
        const got = planAnswerDraftDrop({ params, draft: read.draft });
        if (!got.plan) return { invalid: got.refusal };
        try {
          return await store.drop(params.runId, { draftRunId: params.draftRunId, draftDigest: params.digest }) ? { ok: true } : { invalid: "The draft changed before it could be dropped. Reload its run page." };
        } catch (err) {
          if (refusedByValkey(err)) throw err;
          return tracked.wrote ? { invalid: DRAFT_DROP_UNCONFIRMED, partial: true } : { unreachable: true };
        }
      }, { tracking: true });
      return { invalid: "This answerer action is not available." };
    },
    async sent({ runId, draftRunId, digest, text, by }) {
      return using(async store => {
        const read = await readInTime(currentDraft(store, runId));
        const draft = read === READ_LATE ? null : read.draft;
        if (!draft || draft.meta.draftRunId !== draftRunId || draft.digest !== digest) return false;
        return store.markSent(runId, { by, at: now(), draftRunId, draftDigest: draft.digest, disposition: hash(text) === hash(draft.draft) ? "as-drafted" : "edited" });
      });
    },
  };
}
