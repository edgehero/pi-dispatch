/** Page-specific reads and console-only writes. Private question input has no path through this service. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue, enqueueQuestionGroupJob } from "@edgehero/pi-dispatch/queue";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { makeQuestionGroupStore } from "@edgehero/pi-dispatch/question-groups";
import { makeZeroTouchFixStore } from "@edgehero/pi-dispatch/zero-touch-fixes";
import { makeTouchStore } from "@edgehero/pi-dispatch/touch-state";
import { makeTouchOutbox } from "@edgehero/pi-dispatch/touch-outbox";
import { readZeroTouch, ZERO_TOUCH_NO_PROJECT, zeroTouchProjectMatches } from "@edgehero/pi-dispatch/zero-touch";
import { readRunById } from "./read-model.mjs";
import { checkTriggerFixSource } from "./job-actions.mjs";
import { runMatches } from "./run-filter.mjs";
import { planZeroTouchGroup, planZeroTouchName, planZeroTouchInstruction, planZeroTouchInstructionUndo, applyZeroTouchFilePlan } from "./zero-touch-actions.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");

export function makeZeroTouchService({ paths, env = {}, fs = nodeFs, now = Date.now, redisFn = makeRedisClient, queueFn = makeQueue, triggerBindingFn = checkTriggerFixSource, log = () => {} } = {}) {
  const retentionDays = /^\d+$/.test(String(env.PI_LOG_RETENTION_DAYS ?? "30")) ? Number(env.PI_LOG_RETENTION_DAYS ?? 30) : 30;
  const config = () => parseTriggersDocument(fs.readFileSync(paths.triggersPath, "utf8"), paths.triggersPath).zeroTouch;
  const repairFiles = new Set(Object.entries(paths).filter(([key, value]) => /(?:File|Path)$/.test(key) && typeof value === "string").map(([, value]) => value));
  const using = async (fn) => {
    const redis = redisFn(paths.valkeyUrl);
    const groups = makeQuestionGroupStore({ redis, now, retentionDays });
    const fixes = makeZeroTouchFixStore({ redis, now, retentionDays });
    const touches = makeTouchStore({ redis, now, retentionDays });
    const outbox = makeTouchOutbox({ dir: join(paths.logsDir, "touch-outbox"), store: touches, fs, log });
    try { return await fn({ redis, groups, fixes, touches, outbox }); }
    finally { redis.disconnect(); }
  };
  async function plan(name, params, stores) {
    if (name === "zero-touch-group") return planZeroTouchGroup({ params, config: config(), meta: await stores.groups.readMeta(params.runId), surface: "console" });
    if (name === "zero-touch-name") {
      const snapshot = await stores.groups.publicSnapshot();
      if (!snapshot.groups.some((g) => g.id === params.groupId)) return { refusal: "This group is no longer retained. Reload the Zero touch page." };
      return planZeroTouchName({ params, paths, fs, surface: "console" });
    }
    if (name === "zero-touch-instruction") {
      const source = await readRunById(stores.redis, { logsDir: paths.logsDir, jobId: params.runId, fs });
      const snapshot = await stores.groups.publicSnapshot();
      const binding = await triggerBindingFn({ url: paths.valkeyUrl, jobId: params.runId, index: params.index, triggersPath: paths.triggersPath, fs, redisFn, queueFn });
      if (!binding.ok) return { refusal: binding.refusal };
      return planZeroTouchInstruction({ params, paths, sourceRecord: source.record, group: snapshot.groups.find((g) => g.id === params.groupId), binding, fs, surface: "console" });
    }
    if (name === "zero-touch-undo") return planZeroTouchInstructionUndo({ params, paths, fix: await stores.fixes.read(params.fixId, { includeUndo: true }), fs, surface: "console" });
    return { refusal: "This Zero touch action is not available." };
  }
  return {
    async read({ days = 30, windowDays = days, project = null, scope = null, scopeId = scope, includeRecords = false } = {}) {
      return using(async ({ redis, groups, fixes, outbox }) => {
        await outbox.repair();
        try { await fixes.repair({ readTrigger: (index) => JSON.parse(fs.readFileSync(paths.triggersPath, "utf8")).triggers?.[index], readFile: (path) => repairFiles.has(path) ? fs.readFileSync(path, "utf8") : null }); }
        catch { log("zero_touch_fix_repair_pending", {}); }
        let cfg; let configUnavailable = false;
        try { cfg = config(); } catch { configUnavailable = true; }
        const [questions, changes] = await Promise.all([groups.publicSnapshot({ names: cfg?.names ?? {} }), fixes.publicSnapshot()]);
        const selectedGroups = questions.groups.filter((g) => zeroTouchProjectMatches(g.project, project) && (!scopeId || g.scopeId === scopeId));
        const report = await readZeroTouch({ redis, logsDir: paths.logsDir, retentionDays, localHost: env.PI_WORKER_NAME ?? null, now, windowDays, project, scopeId, groups: selectedGroups, fixes: changes.fixes, fs, includeRecords: true });
        const knownSources = new Set(questions.rows.map((r) => r.runId));
        const missingSources = cfg?.capture && questions.state === "ok" ? report.records.filter((r) => r.reason === "awaiting-input" && zeroTouchProjectMatches(r.project, project) && (!scopeId || r.touchScopeId === scopeId) && !knownSources.has(r.jobId)).map((r) => ({ runId: r.jobId, status: "source-unavailable" })) : [];
        report.grouping = { enabled: cfg?.capture === true, state: configUnavailable ? "configuration-unavailable" : questions.state, partial: questions.partial, pending: questions.rows.filter((r) => r.status === "pending").length, unassigned: questions.rows.filter((r) => !r.groupId).length };
        report.ungroupedRunIds = questions.rows.filter((r) => !r.groupId && zeroTouchProjectMatches(r.project, project) && (!scopeId || r.scopeId === scopeId)).map((r) => r.runId);
        report.groupingStatuses = [...questions.rows.filter((r) => !r.groupId && zeroTouchProjectMatches(r.project, project) && (!scopeId || r.scopeId === scopeId)).map((r) => ({ runId: r.runId, status: r.status })), ...missingSources];
        report.grouping.partial = questions.partial || missingSources.length > 0;
        report.fixes = report.fixes.map((f) => f.groupId && report.grouping.partial ? { ...f, partial: true, worked: false, status: "observing" } : f);
        report.fixesPartial = changes.partial;
        report.groups = report.groups.map((group) => {
          const fix = report.fixes.filter((f) => f.groupId === group.id && !f.undoneAt).sort((a, b) => b.at - a.at)[0];
          return fix ? { ...group, status: "fixed", fixedAt: fix.at } : group;
        });
        return report;
      });
    },
    async runs({ before = null, limit = 50, filter = {}, windowDays = 30, scopeId = null } = {}) {
      const report = await this.read({ windowDays, project: filter.project ?? null, scopeId, includeRecords: true });
      const touched = new Set(report.touchedRunIds);
      const runFilter = filter.project === ZERO_TOUCH_NO_PROJECT ? { ...filter, project: undefined } : filter;
      const records = report.records.filter((r) => touched.has(r.jobId) && runMatches(r, runFilter) && (before === null || Date.parse(r.endedAt) < before)).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.jobId.localeCompare(b.jobId));
      let take = Math.min(limit, records.length);
      while (take < records.length && records[take].endedAt === records[take - 1].endedAt) take++;
      return { runs: records.slice(0, take), next: take < records.length ? Date.parse(records[take - 1].endedAt) : null, mirror: report.recordMirror ?? "off", truncated: report.coverage.partial, examined: report.records.length, touchCoverage: report.coverage, touchTotal: report.state === "unavailable" ? null : report.totals.touched };
    },
    async preview(name, params) { return using((stores) => plan(name, params, stores)); },
    async withWriters(fn) { return using(({ touches, outbox }) => fn({ touchStore: touches, touchOutbox: outbox, now })); },
    async configurationContext(runId) {
      return using(async ({ redis }) => {
        const { record } = await readRunById(redis, { logsDir: paths.logsDir, jobId: runId, fs });
        if (record?.outcome !== "policy" || !/^[a-f0-9]{64}$/.test(record.touchScopeId ?? "") || typeof record.reason !== "string") return null;
        return { runId, scopeId: record.touchScopeId, project: record.project ?? null, reason: record.reason, groupId: null, triggerIndex: record.triggerIndex ?? null };
      });
    },
    async trackConfiguration(entry, apply) {
      return using(async ({ fixes, outbox }) => {
        const cause = entry.payload.touchContext;
        const intent = await outbox.begin({ ...cause, cause: "config-fix", at: now(), nonce: entry.ticketDigest ?? entry.afterDigest });
        let staged;
        try { staged = await fixes.stage({ ...cause, kind: "config" }, { identity: entry.ticketDigest ?? entry.afterDigest, privateUndo: entry.target && entry.afterDigest ? { file: entry.target, afterDigest: entry.afterDigest } : null }); }
        catch { await outbox.abort(intent); return { invalid: "Fix accounting could not be prepared. Nothing was changed; try again when Valkey is available." }; }
        if (!staged.ok) { await outbox.abort(intent); return { invalid: staged.invalid ?? "The source refusal is not available; nothing was changed." }; }
        let result;
        try { result = await apply(); }
        catch (error) { await fixes.reject(staged.fix.id); await outbox.abort(intent); throw error; }
        if (!result?.ok) { await fixes.reject(staged.fix.id); await outbox.abort(intent); return result; }
        let pending = false;
        try { pending = !await fixes.commit(staged.fix.id); } catch { pending = true; }
        const tracked = await outbox.applied(intent);
        return { ...result, ...(pending || !tracked.ok ? { warning: "The configuration was changed; accounting is pending repair. Do not repeat the change." } : {}) };
      });
    },
    async apply(name, entry) {
      return using(async (stores) => {
        const params = entry.payload.params;
        const planned = await plan(name, params, stores);
        if (!planned.plan) return { invalid: planned.refusal ?? "The change no longer applies; preview it again." };
        const p = planned.plan;
        if (p.afterText && hash(p.afterText) !== entry.afterDigest) return { invalid: "The file changed since the preview. Reload and preview it again." };
        if (name === "zero-touch-group") {
          if (p.configDigest !== entry.payload.configDigest || p.digest !== entry.payload.digest) return { invalid: "The question or grouping configuration changed since the preview." };
          const queue = queueFn(parseConnection(paths.valkeyUrl, { failFast: true }));
          try {
            const jobId = await enqueueQuestionGroupJob(queue, p);
            try { await stores.groups.setStatus(p.runId, "pending"); }
            catch { return { ok: true, jobId, warning: "The grouping job was queued; its status could not be updated. Do not queue it again." }; }
            return { ok: true, jobId };
          } finally { void queue.close().catch(() => {}); }
        }
        const intent = name === "zero-touch-instruction" ? await stores.outbox.begin({ runId: p.runId, cause: "config-fix", at: now(), nonce: entry.ticketDigest ?? entry.afterDigest, scopeId: p.scopeId, project: p.project ?? null }) : null;
        let staged;
        if (intent) {
          try { staged = await stores.fixes.stage(p, { privateUndo: p.privateUndo, identity: entry.ticketDigest ?? entry.afterDigest }); }
          catch { await stores.outbox.abort(intent); return { invalid: "Fix accounting could not be prepared. Nothing was changed; try again when Valkey is available." }; }
          if (!staged.ok) { await stores.outbox.abort(intent); return { invalid: staged.invalid ?? "The fix could not be recorded; nothing was changed." }; }
        }
        const result = applyZeroTouchFilePlan({ plan: { ...p, expect: entry.expect }, paths, fs });
        if (result.invalid || result.ok === false) { if (intent) { await stores.outbox.abort(intent); await stores.fixes.reject(staged.fix.id); } return result; }
        if (name === "zero-touch-instruction") {
          let fixPending = false;
          try { fixPending = !await stores.fixes.commit(staged.fix.id); }
          catch { fixPending = true; log("zero_touch_fix_pending", {}); }
          const tracked = await stores.outbox.applied(intent);
          return { ok: true, fixId: staged.fix.id, ...(tracked.ok && !fixPending ? {} : { warning: "The instruction was saved; accounting is pending repair. Do not repeat the edit." }) };
        }
        if (name === "zero-touch-undo") await stores.fixes.markUndone(params.fixId);
        return { ok: true };
      });
    },
  };
}
