import { makeSandboxPrepareQueue, enqueueSandboxPreparation, readSandboxPreparation } from "@edgehero/pi-dispatch/sandbox-prepare-requests";
/** Private operator reads and zero-spend control requests. The console never clones or invokes a runtime (#771). */
import * as nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { planSandboxPreparation } from "@edgehero/pi-dispatch/sandbox-prepare";
import { readSandboxHosts, planSandboxHost, writeSandboxHost } from "@edgehero/pi-dispatch/sandbox-hosts";
import { parseProjects } from "@edgehero/pi-dispatch/projects";
import { parseScopedLimits } from "@edgehero/pi-dispatch/scoped-limits";
export const SANDBOX_READ_DEPS = Object.freeze({ makeSandboxPrepareQueueFn: makeSandboxPrepareQueue, enqueueSandboxPreparationFn: enqueueSandboxPreparation, readSandboxPreparationFn: readSandboxPreparation });
const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const refusalOf = (out) => out?.refusal ?? out?.message ?? out?.refused ?? "The sandbox request was refused.";

export function makeSandboxService({ paths, env = {}, deploymentDir, fleet, fs = nodeFs, now = Date.now, random = randomBytes, planFn = planSandboxPreparation, hostFile = paths?.sandboxHostsFile ?? env.PI_SANDBOX_HOSTS_FILE ?? join(deploymentDir, "sandbox-hosts.json") } = {}) {
  const hosts = () => readSandboxHosts(hostFile, { fs });
  async function inventory() {
    const [kept, open] = await Promise.all([fleet.sandboxInventory(), fleet.sandboxSessions()]);
    if (kept?.unreachable) throw new Error("sandbox inventory unreadable");
    return { hosts: kept?.hosts ?? [], sessions: open?.sessions ?? [], sessionsUnavailable: Boolean(open?.unreachable), sessionsMore: open?.more ?? 0, sessionsUnreadable: open?.unreadable ?? 0, notices: open?.notices ?? [], noticesUnavailable: Boolean(open?.noticesUnavailable), more: kept?.more ?? 0 };
  }
  function configuration() {
    const triggersText = fs.readFileSync(paths.triggersPath, "utf8");
    const parsed = parseTriggersDocument(triggersText, paths.triggersPath);
    const optional = (path, parse, required) => {
      if (path === null || path === undefined) return [];
      try { return parse(fs.readFileSync(path, "utf8"), path); }
      catch (error) { if (error.code === "ENOENT" && !required) return []; throw new Error("sandbox configuration unreadable", { cause: error }); }
    };
    // The configured worker path wins over the panel's editable default; absence is optional only where the worker
    // has no configured file. Permission and I/O failures can never turn a size override into a plausible default.
    const projectPath = Object.hasOwn(paths, "projectsFile") ? paths.projectsFile : paths.projectsPath;
    const projects = optional(projectPath, parseProjects, projectPath !== null && projectPath !== undefined);
    const limits = optional(paths.scopedLimitsPath, parseScopedLimits, env.PI_SCOPED_LIMITS_FILE !== undefined);
    return { triggersText, triggers: parsed.triggers, projects, limits };
  }
  function optionsOf(cfg) {
    return cfg.triggers.flatMap((trigger, index) => {
      const run = trigger.run ?? {};
      return ["github", "gitlab", "forgejo", "azure"].includes(run.kind) ? [{ index, repository: run.repository ?? null, label: `trigger ${index + 1}, ${trigger.on.type}, ${run.kind}, flow ${run.flow ?? "not named"}` }] : [];
    });
  }
  function preparation(params, inv, cfg) {
    const host = inv.hosts.find((h) => h.name === params.host);
    if (!host || host.stale || host.unreadable || !host.settings) return { refusal: "The host's current sandbox settings were not published. Choose a fresh host or inspect it in Fleet." };
    const s = host.settings;
    const config = { ...s, host: params.host, workerName: params.host, image: s.image, jobImage: s.image, backends: s.backends, backend: s.defaultBackend, defaultBackend: s.defaultBackend, egress: s.egress, egressProxy: s.egressProxy, sandboxRetentionHours: s.sandboxRetentionHours, sandboxPinDays: s.sandboxPinDays };
    const request = { host: params.host, repo: params.repo, ref: params.ref, triggerIndex: params.index, pin: params.pin };
    const out = planFn({ request, config, env: { PI_JOB_MEMORY: s.jobMemory, PI_JOB_CPUS: s.jobCpus }, triggersText: cfg.triggersText, projects: cfg.projects, limits: cfg.limits });
    return out.plan ? { plan: out.plan, request: { ...request, triggerDigest: out.plan.triggerDigest, planDigest: out.plan.planDigest } } : { refusal: refusalOf(out) };
  }
  return {
    hosts,
    async read(query = {}) {
      const inv = await inventory();
      let cfg;
      try { cfg = configuration(); } catch { return { ...inv, options: [], selected: query, refusal: "The triggers, projects or scoped limits could not be read. Fix the deployment configuration before preparing a sandbox." }; }
      const options = optionsOf(cfg);
      const selected = { repo: query.repo ?? null, index: query.index, ref: query.ref ?? "HEAD", host: query.host ?? inv.hosts.find((h) => !h.stale && !h.unreadable && h.settings)?.name ?? null, pin: query.pin === true };
      if (selected.index === null || selected.index === undefined) selected.index = options[0]?.index ?? null;
      const rawTrigger = cfg.triggers[selected.index]?.run;
      const eligibleHosts = inv.hosts.filter((h) => {
        const backend = rawTrigger?.backend ?? h.settings?.defaultBackend;
        return !h.stale && !h.unreadable && h.settings && ["local", "podman"].includes(backend) && h.settings.backends.includes(backend);
      }).map((h) => h.name);
      const judged = selected.repo && selected.host && selected.index !== null ? preparation(selected, inv, cfg) : {};
      const request = query.request && query.host ? await fleet.sandboxPreparationStatus(query.host, query.request) : null;
      return { ...inv, options, eligibleHosts, selected, ...judged, request };
    },
    async preview(name, params) {
      if (name === "sandbox-host-set") {
        const mapping = { target: params.target || null, deployment: params.deployment, nodePath: params.nodePath, cliPath: params.cliPath, shell: params.shell ?? "posix" };
        const out = planSandboxHost(hostFile, params.host, mapping, { fs });
        return out.refusal ? out : { target: params.host, payload: { params, expect: out.expect }, beforeDigest: sha(out.before), afterDigest: sha(out.after), summary: [`Save terminal target for ${params.host}`, "The exported file contains host and path settings, no credentials. The opener checks its own imported copy before showing a command.", "This changes no worker policy and opens no terminal."], beforeText: out.before, afterText: out.after };
      }
      const inv = await inventory();
      if (name === "sandbox-prepare") {
        let cfg;
        try { cfg = configuration(); } catch { return { refusal: "The triggers, projects or scoped limits could not be read. Fix the deployment configuration before preparing a sandbox." }; }
        if (!optionsOf(cfg).some((o) => o.index === params.index)) return { refusal: "The repository and trigger do not match. Review the settings again." };
        const out = preparation(params, inv, cfg);
        if (!out.plan) return out;
        return { target: params.host, payload: { params, request: { ...out.request, id: `sb-${random(16).toString("hex")}` } }, beforeDigest: sha(out.plan), afterDigest: sha(out.request), summary: [`Prepare a sandbox for ${params.repo} at ${params.ref}`, `On ${params.host}, as trigger ${params.index + 1}: ${out.plan.image}, ${out.plan.backend}, ${out.plan.size.memMiB} MiB and ${out.plan.size.cpuCenti / 100} CPU.`, "The worker clones with a repository credential, then drops it. No container or model starts, no dollars are spent and no run slot is taken.", `${params.pin ? `Pin for ${out.plan.pinDays} days` : `Keep for ${out.plan.retentionHours} hours`}. The worker refuses if these settings change before it prepares the clone.`] };
      }
      if (name === "sandbox-pin") {
        const host = inv.hosts.find((h) => h.name === params.host), row = host?.rows?.find((r) => r.id === params.id);
        if (!row || host.stale || host.unreadable || !row.generation) return { refusal: "This workspace's current generation could not be read. Reload, or pin it from its host's CLI." };
        const request = { op: "pin", host: params.host, runId: params.id, expect: { generation: row.generation, until: row.until ?? null, pin: Boolean(row.pin) } };
        return { target: params.host, payload: { params, request }, beforeDigest: sha(row), afterDigest: sha(request), summary: [`Pin ${params.id} on ${params.host}`, `Keep it for this host's pin window (${host.settings?.sandboxPinDays ?? "not published"} days). A changed workspace is refused.`, "No container starts and no run slot is taken."] };
      }
      const shell = inv.sessions.find((s) => s.id === params.id && s.host === params.host && s.nonce === params.nonce && s.containerId === params.containerId);
      if (!shell) return { refusal: "This shell is no longer registered, or a different shell replaced it. Reload before ending a shell." };
      return { target: params.host, payload: { params }, beforeDigest: sha(shell), afterDigest: sha(params), summary: [`End the shell for ${params.id} on ${params.host}`, "The terminal that opened this exact shell is asked to close it. A replacement shell is not ended. The workspace remains kept."] };
    },
    async apply(name, entry, by) {
      const p = entry.payload;
      if (name === "sandbox-host-set") {
        const out = writeSandboxHost(hostFile, p.params.host, { target: p.params.target || null, deployment: p.params.deployment, nodePath: p.params.nodePath, cliPath: p.params.cliPath, shell: p.params.shell ?? "posix" }, { expect: p.expect, fs });
        return out.written ? { ok: true } : { invalid: refusalOf(out) };
      }
      if (name === "sandbox-end") {
        const out = await fleet.sandboxEnd(p.params);
        return out.ended ? { ok: true } : { ...(out.timeout ? { partial: true } : {}), invalid: out.timeout ? "The terminal did not acknowledge End. Reload before trying again; the request may still take effect." : refusalOf(out) };
      }
      // Rebuild the preview over current publications/config before enqueue; the owning worker checks again.
      const current = await this.preview(name, p.params);
      if (current.refusal || current.beforeDigest !== entry.beforeDigest) return { invalid: current.refusal ?? "The sandbox settings changed since preview. Preview again." };
      const result = await fleet.sandboxPrepare({ ...p.request, by });
      if (result.refused) return { invalid: refusalOf(result) };
      return { ok: true, requestId: result.id, host: p.request.host, ...(result.state === "unknown" ? { warning: result.message } : {}) };
    },
  };
}
