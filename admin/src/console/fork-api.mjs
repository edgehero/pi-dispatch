import { readForkPoints } from "../run-fork.mjs";

/** Operator-only metadata. Raw source transcripts never cross the console boundary. */
export async function getForkPoints(ctx) {
  const params = ctx.searchParams;
  if ([...params.keys()].some((k) => k !== "id") || params.getAll("id").length !== 1) return ctx.json(400, { error: "name exactly one run id" });
  const reader = ctx.deps.actionDeps?.rm?.readForkPoints ?? readForkPoints;
  const got = await reader({ jobId: params.get("id"), env: ctx.deps.actionDeps?.env ?? ctx.deps.pageDeps?.env ?? {}, now: ctx.deps.now });
  if (!got.ok) return ctx.json(409, { error: got.refusal });
  return ctx.json(200, { entries: got.entries.map((e) => ({ id: e.id, parentId: e.parentId, type: e.type, role: e.role, positions: e.positions ?? [] })) });
}
