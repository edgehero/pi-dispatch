/** Explicit model projections for the configuration pages (#751), with the same one-shot reader lifetime. */
import { createFleetReader, readProjects, readScopedLimits, readTriggers, readSettingsView, readSubscriptions, scanRunRecords, readSizeSuggestions } from "./read-model.mjs";
import { assembleAllocationView } from "./insights-assembly.mjs";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { costsSinceMs } from "./costs.mjs";
import { secretsView, modelSecrets } from "./secrets-view.mjs";
import { readConnections, modelConnections } from "./connections-view.mjs";
import { readProjectView, projectViewForAgent, readProjectFleetRuns } from "./project-view.mjs";
import { projectShown } from "./write-plans.mjs";

let testReads = {};
/** TEST ONLY: the same injected I/O seam used by the reader's unit tests; never reachable through a tool call. */
export function setConfigToolReadsForTest(reads = {}) { testReads = reads; }

/** Reuse source reads and expensive history/allocation work; each project's planner still judges its own id. */
function once(fn) {
  let called = false;
  let value;
  let error;
  return (...args) => {
    if (!called) {
      called = true;
      try { value = fn(...args); } catch (e) { error = e; }
    }
    if (error) throw error;
    return value;
  };
}

export async function readConfigTool(kind, { paths, env = {}, deploymentDir, now = Date.now(), pricing, reads = {} } = {}) {
  if (!["secrets", "connections", "projects"].includes(kind)) throw new RangeError("unknown configuration tool");
  reads = { ...testReads, ...reads };
  const declared = kind === "projects" ? (reads.projects ?? readProjects)({ projectsPath: paths.projectsFile }) : null;
  if (kind === "projects" && !Array.isArray(declared?.projects)) return { ...(declared?.unset ? { unset: true } : declared?.missing ? { missing: true } : { unavailable: true }) };
  const fleet = (reads.fleet ?? createFleetReader)(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: () => now });
  try {
    let snapshot = null;
    try { snapshot = await fleet.snapshot(kind === "projects" ? { waiting: true } : {}); } catch { /* The file facts remain readable. */ }
    if (kind === "secrets") return modelSecrets((reads.secrets ?? secretsView)({ snapshot, env }));
    if (kind === "connections") return modelConnections(await (reads.connections ?? readConnections)({ paths, env, deploymentDir, snapshot, now }));
    const p = declared;
    const sl = (reads.limits ?? readScopedLimits)({ scopedLimitsPath: paths.scopedLimitsPath });
    const limits = sl?.limits ?? [];
    const history = await readProjectFleetRuns(fleet, { sinceMs: Math.min(now - 30 * 86400_000, costsSinceMs("mtd", now)) });
    const sources = reads.projectSources ?? {};
    const projectIds = p.projects.map((project) => project.id);
    const projectReads = {
      ...sources,
      projects: () => p,
      limits: () => sl,
      triggers: once(sources.triggers ?? readTriggers),
      settings: once(sources.settings ?? readSettingsView),
      subscriptions: once(sources.subscriptions ?? readSubscriptions),
      environment: once(sources.environment ?? deploymentServiceEnv),
      scan: once(sources.scan ?? scanRunRecords),
      allocation: once(sources.allocation ?? assembleAllocationView),
      sizing: once((opts) => (sources.sizing ?? readSizeSuggestions)({ ...opts, projectIds })),
      fleetRuns: async () => history,
    };
    const projects = [];
    for (const project of p.projects) {
      const view = await (reads.project ?? readProjectView)({ id: project.id, paths, env, deploymentDir, now, pricing, snapshot, fleet, reads: projectReads });
      projects.push({ ...projectShown(project), limitRows: limits.flatMap((l, i) => l.scope === `project:${project.id}` ? [i] : []), ...projectViewForAgent(view) });
    }
    return { projects, ...(sl?.invalid || sl?.unreadable ? { limitsInvalid: true } : {}) };
  } finally { await fleet.dispose(); }
}
