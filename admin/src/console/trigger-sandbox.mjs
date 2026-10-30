/** Host facts qualify the venue declaration; an unreported blessing is never a negative verdict. */
import { jobNeeds } from "@edgehero/pi-dispatch/capabilities";

export function triggerSandboxHosts(trigger, snapshot = {}) {
  const needs = jobNeeds({ secretsProfile: trigger.secretsProfile, ...(trigger.secrets > 0 ? { secrets: { declared: true } } : {}), waitFor: trigger.waitFor });
  const rows = Array.isArray(snapshot.hostBudgets) ? snapshot.hostBudgets : [];
  return rows.filter((host) => trigger.type === "cron" || !needs.length || host.capsSeen !== true || needs.every((n) => host.caps?.includes(n))).map((host) => {
    const backend = trigger.backend ?? host.backends?.default ?? null;
    return { name: host.name, backend, deploymentDefault: trigger.backend == null,
      blessed: backend === null || !Array.isArray(host.backends?.blessed) ? null : host.backends.blessed.includes(backend),
      capabilityUnknown: needs.length > 0 && host.capsSeen !== true };
  });
}
