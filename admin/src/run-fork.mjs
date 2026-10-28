/** Managed forks use current trigger policy and immutable run sources, never the target's moving canonical file. */
import { forkBranch, FORK_THINKING_LEVELS } from "@edgehero/pi-dispatch/fork-job";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { modelIdProblem, providerIdProblem, modelOnList } from "@edgehero/pi-dispatch/model-ref";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@edgehero/pi-dispatch/config";
import { canonicalJson } from "@edgehero/pi-dispatch/priorities";
import { formatMicros } from "@edgehero/pi-dispatch/money";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { planRerun, enqueueRerun } from "./job-actions.mjs";

const JOB_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const ENTRY_RE = /^[A-Za-z0-9_-]{1,128}$/;
export { FORK_THINKING_LEVELS };

export async function readForkPoints({ jobId, env = {}, now = Date.now, store = null, entry, position, sourceDigest } = {}) {
  if (typeof jobId !== "string" || !JOB_RE.test(jobId)) return { refusal: "fork-source-invalid-run" };
  if (!store) {
    if (!env.PI_SESSIONS_DIR) return { refusal: "fork-source-store-unset" };
    const { createForkStore } = await import("@edgehero/pi-dispatch/fork-store");
    store = createForkStore({ dir: join(env.PI_SESSIONS_DIR, ".fork-sources"), now });
  }
  const got = await store[entry ? "readPoint" : "read"]({ runId: jobId, ...(entry ? { entryId: entry, position } : {}), ...(sourceDigest ? { sourceDigest } : {}) });
  if (!got.ok) return { refusal: got.refused ?? "fork-source-unavailable" };
  if (got.manifest.venue === "openshell") return { refusal: "openshell-fork-unsupported" };
  return got;
}

/** Preview and pickup validate separately: a ticket must not freeze privileges the trigger has since withdrawn. */
export async function planRunFork({ jobId, entry, position = "before", provider, model, thinking, message, forkId, sourceDigest, maxCostUsd, ...deps } = {}) {
  if (typeof entry !== "string" || !ENTRY_RE.test(entry)) return { refusal: "fork-entry-invalid" };
  if (position !== "before" && position !== "at") return { refusal: "fork-position-invalid" };
  if (provider != null && provider !== "" && providerIdProblem(provider)) return { refusal: "fork-provider-invalid" };
  if (model != null && model !== "" && modelIdProblem(model)) return { refusal: "fork-model-invalid" };
  if (thinking != null && thinking !== "" && !FORK_THINKING_LEVELS.includes(thinking)) return { refusal: "fork-thinking-invalid" };
  if (message != null && (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 16_384 || message.includes("\0"))) return { refusal: "fork-message-invalid" };
  const source = await (deps.readSource ?? readForkPoints)({ jobId, entry, position, sourceDigest, env: deps.env, now: deps.now, store: deps.store });
  if (!source.ok) return source;
  const got = await (deps.planRerunFn ?? planRerun)({ ...deps, jobId });
  if (!got.plan) return got;
  const p = got.plan;
  if (p.kind !== "forge" || p.job?.target?.type !== "issue") return { refusal: "fork-target-unsupported" };
  if (p.job.replica !== undefined || p.job.replicas !== undefined) return { refusal: "fork-replicas-unsupported" };
  const id = forkId ?? (deps.random ?? randomBytes)(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(id)) return { refusal: "fork-id-invalid" };
  // The paid preview names one model. Freeze it in both queue data and the confirmation request so a later
  // settings change cannot substitute another model between the preview, confirm and worker pickup.
  const effectiveProvider = provider || p.job.provider || deps.overlay?.provider || deps.env?.PI_PROVIDER || DEFAULT_PROVIDER;
  const effectiveModel = model || p.job.model || deps.overlay?.model || deps.env?.PI_MODEL || DEFAULT_MODEL;
  const job = { ...p.job, provider: effectiveProvider, model: effectiveModel, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}), ...(thinking ? { thinkingLevel: thinking } : {}), fork: { id, fromJob: jobId, fromEntry: entry, position, sourceDigest: source.manifest.sourceDigest, rootKey: source.manifest.sessionKey, ...(message ? { message } : {}) } };
  const checkPolicy = deps.policyDigestFn ?? (await import("@edgehero/pi-dispatch/fork-policy")).forkPolicyDigest;
  const policy = await checkPolicy({ triggersPath: deps.triggersPath, job: { ...job, kind: p.forge }, fs: deps.fs });
  if (!policy.ok) return { refusal: policy.refused ?? "fork-policy-unavailable" };
  job.forkPolicy = policy.digest;
  const allowed = job.models ?? (deps.env?.PI_ALLOWED_MODELS ? deps.env.PI_ALLOWED_MODELS.split(",") : null);
  if (!modelOnList(allowed, effectiveProvider, effectiveModel)) return { refusal: "model-not-allowed" };
  const reserve = estimateReserve(job, deps);
  if (reserve.invalid) return { refusal: reserve.invalid };
  job.forkReserveMicros = reserve.dollarsMicros;
  // The hold shown at preview is also a per-job ceiling. Deployment defaults may narrow it later,
  // but a wider default must never widen what this confirmation authorized.
  if (Number.isSafeInteger(reserve.capMicros) && reserve.capMicros > 0) job.maxCostUsd = formatMicros(reserve.capMicros);
  const queue = source.manifest.hostQueue ?? p.queue;
  const request = { jobId, entry, position, provider: effectiveProvider, model: effectiveModel, ...(job.maxCostUsd !== undefined ? { maxCostUsd: job.maxCostUsd } : {}), ...(thinking ? { thinking } : {}), ...(message ? { message } : {}), forkId: id, sourceDigest: source.manifest.sourceDigest };
  return { plan: { ...p, queue, branch: forkBranch(job), job, request, sourceDigest: source.manifest.sourceDigest, policyDigest: policyDigest(job, reserve), reserve, runFields: { ...p.runFields, maxCostUsd: job.maxCostUsd ?? null, model: effectiveProvider && effectiveModel ? `${effectiveProvider}/${effectiveModel}` : effectiveModel } } };
}

function policyDigest(job, reserve) {
  const { fork, trigger, ...policy } = job;
  return createHash("sha256").update(canonicalJson({ ...policy, trigger: { ...trigger, deliveryId: null }, reserve })).digest("hex");
}

export async function enqueueRunFork(plan, deps = {}) {
  if (!plan?.request || !plan?.job?.fork) return { refusal: "not a fork plan" };
  const checked = await (deps.planForkFn ?? planRunFork)({ ...deps, ...plan.request });
  if (!checked.plan) return checked;
  if (checked.plan.policyDigest !== plan.policyDigest || checked.plan.queue !== plan.queue) return { refusal: "the trigger or fork destination changed since the preview; preview again" };
  return (deps.enqueueFn ?? enqueueRerun)(plan, deps);
}
