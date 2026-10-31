/** Fresh producer admission for model-requested local starts (#766). No persona or request rationale is authority. */
export function paidStartEnvironment(env, grantsEnv) {
  const roots = grantsEnv?.PI_DISPATCH_RUN_ROOTS;
  const hourly = grantsEnv?.PI_DISPATCH_RUN_PER_HOUR;
  if (typeof roots !== "string" || !roots.trim() || typeof hourly !== "string" || !/^\d+$/.test(hourly) || !Number.isSafeInteger(Number(hourly))) return { refusal: "Agent starts require explicit PI_DISPATCH_RUN_ROOTS and PI_DISPATCH_RUN_PER_HOUR in this process's environment." };
  return { env: { ...env, PI_DISPATCH_RUN_ROOTS: roots, PI_DISPATCH_RUN_PER_HOUR: hourly } };
}

export async function checkAgentRerun(plan, { rm, env, grantsEnv, now, consumeRate = false } = {}) {
  if (!["local", "cron"].includes(plan?.kind)) return { refusal: "A forge rerun is person-only; agent reruns are local or cron runs." };
  const job = plan.job;
  if (!job || job.command !== undefined || job.portfolio === true) return { refusal: "Command and portfolio runs cannot be started by an agent." };
  const granted = paidStartEnvironment(env, grantsEnv);
  if (granted.refusal) return granted;
  const result = await rm.checkDispatchRun({ folder: job.folder, flow: job.flow, aiInvoked: true, consumeRate, env: granted.env, now });
  if (result.refused || result.unreachable) return { refusal: result.refused ?? "The paid-start admission could not read its shared allowance." };
  return { ok: true };
}
