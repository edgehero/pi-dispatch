/** Action implementations share the console's ticket and audit funnel, never a model-tool registration. */
import { diffHtmlOf } from "./confirm-view.mjs";

export const ANSWERER_ACTIONS = ["standing-answer-add", "answer-draft-drop"].map(name => ({
  name, kind: name, paid: false, bulk: false, needs: ["answerer"],
  async preview(body, ctx) {
    const params = name === "standing-answer-add" ? { title: body.title, text: body.text, projects: body.projects, repo: body.repo, ...(body.runId ? { runId: body.runId } : {}) } : { runId: body.runId, draftRunId: body.draftRunId, digest: body.digest };
    const got = await ctx.a.answerer.preview(name, params);
    if (!got.plan) return got;
    const p = got.plan;
    return { target: p.target, expect: p.expect, beforeDigest: p.beforeDigest ?? null, afterDigest: p.afterDigest ?? null, summary: p.summary, payload: { params, ...(p.answer?.adoptedAt ? { adoptedAt: p.answer.adoptedAt } : {}) }, ...(p.afterText ? { diff: diffHtmlOf(p.beforeText, p.afterText, { file: p.target }) } : {}) };
  },
  async apply(entry, ctx) { return ctx.a.answerer.apply(name, entry); },
}));

export const ANSWERER_WRITE_RULES = {
  "standing-answer-add": { fields: ["title", "text", "projects", "repo", "runId"], danger: false, undo: () => "Remove the standing answer by hand from triggers.json after reviewing any draft that cited it.", inverse: () => null, confirmLabel: () => "Adopt standing answer", done: () => "Adopted the standing answer" },
  "answer-draft-drop": { fields: ["runId", "draftRunId", "digest"], danger: false, undo: () => "Write your own answer on the run page. Dropping a draft never changes the parked question.", inverse: () => null, confirmLabel: () => "Drop draft", done: () => "Dropped the draft; the question still waits for you" },
};
