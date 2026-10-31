/** Role projections and human writes for answer rules. Question/draft bytes are read only for an operator's run. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { loadGitLabAuth, loadForgejoAuth, loadAzureAuth } from "@edgehero/pi-dispatch/config";
import { parseProjects, projectOf } from "@edgehero/pi-dispatch/projects";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { makeAnswerDraftStore, answerStandingSource, answerRuleConfigDigest, answerApiRoot } from "@edgehero/pi-dispatch/answerer";
import { planStandingAnswerAdd, applyStandingAnswerAdd, planAnswerDraftDrop } from "./answerer-actions.mjs";

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

export function makeAnswererService({ paths, env = {}, fs = nodeFs, now = Date.now, redisFn = makeRedisClient, storeFn = makeAnswerDraftStore } = {}) {
  const using = async fn => {
    const redis = redisFn(paths.valkeyUrl);
    try { return await fn(storeFn({ redis, now, retentionDays: Number(env.PI_LOG_RETENTION_DAYS ?? 30) })); }
    finally { redis.disconnect?.(); }
  };
  const configuredApiRoot = kind => {
    try {
      const root = kind === "github" ? "https://api.github.com" : kind === "gitlab" ? loadGitLabAuth(env)?.apiUrl : kind === "forgejo" ? loadForgejoAuth(env)?.apiUrl : kind === "azure" ? loadAzureAuth(env)?.orgUrl : null;
      return answerApiRoot(root);
    } catch { return null; }
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
      if (!input.source || typeof input.source.repo !== "string" || !["github", "gitlab", "forgejo", "azure"].includes(input.source.kind) || input.source.target?.type !== "issue") return { draft: null, problem: "source-unavailable" };
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
    async read({ role, runId = null } = {}) {
      return using(async store => {
        const snapshot = await store.publicSnapshot();
        const rows = Array.isArray(snapshot.rows) ? snapshot.rows.map(row => ({ ...row, ...(row.by ? { sentBy: row.by } : {}) })) : [];
        if (role !== "operator") return { state: snapshot.state, partial: Boolean(snapshot.partial), rows: rows.map(answererPublicRow).filter(Boolean) };
        let config;
        try { config = parseTriggersDocument(fs.readFileSync(paths.triggersPath, "utf8"), paths.triggersPath); }
        catch { return { state: "configuration-unavailable", partial: true, rows, rules: [], standing: [], stats: answererStats(rows, now()) }; }
        const standing = (config.standingAnswers ?? []).map(answer => ({ ...answer, used: rows.filter(r => r.sources?.some(s => s.kind === "standing" && s.id === answerStandingSource(answer).id)).length }));
        const selected = RUN_RE.test(runId ?? "") ? await currentDraft(store, rows.find(row => row.draftRunId === runId)?.runId ?? runId, config) : null;
        return { state: snapshot.state, partial: Boolean(snapshot.partial), rows, rules: (config.answerRules ?? []).map(rule => ({ ...rule, stats: answererStats(rows.filter(row => row.ruleId === rule.id), now()) })), standing, stats: answererStats(rows, now()), ...(selected ? { privateDraft: selected.draft, privateDraftProblem: selected.problem } : {}) };
      });
    },
    async privateDraft(runId) { return RUN_RE.test(runId ?? "") ? using(async store => (await currentDraft(store, runId)).draft) : null; },
    async preview(name, params) {
      if (name === "standing-answer-add") return planStandingAnswerAdd({ params, paths, fs, now });
      if (name === "answer-draft-drop") return using(async store => planAnswerDraftDrop({ params, draft: (await currentDraft(store, params.runId)).draft }));
      return { refusal: "This answerer action is not available." };
    },
    async apply(name, entry) {
      const params = entry.payload.params;
      if (name === "standing-answer-add") {
        const got = planStandingAnswerAdd({ params, paths, fs, now, adoptedAt: entry.payload.adoptedAt });
        if (!got.plan || got.plan.afterDigest !== entry.afterDigest || got.plan.beforeDigest !== entry.beforeDigest) return { invalid: "The standing answers changed since the preview. Reload and preview again." };
        return applyStandingAnswerAdd({ plan: got.plan, paths, fs });
      }
      if (name === "answer-draft-drop") return using(async store => {
        const got = planAnswerDraftDrop({ params, draft: (await currentDraft(store, params.runId)).draft });
        if (!got.plan) return { invalid: got.refusal };
        return await store.drop(params.runId, { draftRunId: params.draftRunId, draftDigest: params.digest }) ? { ok: true } : { invalid: "The draft changed before it could be dropped. Reload its run page." };
      });
      return { invalid: "This answerer action is not available." };
    },
    async sent({ runId, draftRunId, digest, text, by }) {
      return using(async store => {
        const draft = (await currentDraft(store, runId)).draft;
        if (!draft || draft.meta.draftRunId !== draftRunId || draft.digest !== digest) return false;
        return store.markSent(runId, { by, at: now(), draftRunId, draftDigest: draft.digest, disposition: hash(text) === hash(draft.draft) ? "as-drafted" : "edited" });
      });
    },
  };
}
