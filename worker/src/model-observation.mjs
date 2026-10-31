/** Model policy observations use pickup's resolver and never acquire a slot, reserve or start work. */
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { projectOf } from "./projects.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { resolveModelRoles } from "./model-roles.mjs";

/** The same role resolver as pickup, expanded over every project a broad forge trigger can reach. */
export function resolveConfiguredModelRuns({ runs = [], deployment, envList = null, modelRoles = {}, projects = [], resolveFolder = realpathSync, conservativeLocal = false }) {
	const resolved = [];
	const checks = [];
	for (const run of runs) {
		if (Object.keys(modelRoles).length === 0 && !run.model?.startsWith("role:")) { resolved.push(run); continue; }
		const list = run.models ?? envList;
		const job = { ...run, provider: run.provider ?? deployment.provider, model: run.model ?? deployment.model, ...(list ? { models: list } : {}) };
		// Forge events without a fully qualified repository can reach any matching project. Azure
		// run.repository alone is only a repository name, not enough to infer a project-qualified scope.
		let projectUnknown = false;
		if (job.kind === "local" && typeof job.folder === "string") {
			try { job.folder = resolveFolder(job.folder); } catch { projectUnknown = conservativeLocal; }
		}
		const fixed = run.kind === "local" || typeof run.repo === "string";
		const possible = projectUnknown ? [null, ...projects.filter(project => project.members?.some(member => typeof member === "string" && isAbsolute(member))).map(project => project.id)] : fixed ? [projectOf(job, projects)] : [null, ...projects.filter((project) => project.members?.some((member) => typeof member === "string" && member.startsWith(`${run.kind}:`))).map((project) => project.id)];
		for (const project of new Set(possible)) {
			const label = project === null ? run.label : `${run.label} (project ${project})`;
			try {
				const selected = resolveModelRoles(job, modelRoles, project, { authoredProvider: Object.hasOwn(run, "authoredProvider") ? run.authoredProvider : run.provider });
				resolved.push({ ...selected, label, project, ...(projectUnknown ? { projectUnknown: true } : {}), roleScope: selected.modelRole && Object.hasOwn(modelRoles?.[project] ?? {}, selected.modelRole) ? project : "default" });
			} catch (error) {
				checks.push({ ok: false, warn: true, sourceIndex: run.sourceIndex ?? null, project, ...(projectUnknown ? { projectUnknown: true } : {}), reason: error.modelSelectionReason ?? "model-roles-invalid", label: `${label}: reviewed model roles refuse this job (${error.modelSelectionReason ?? "model-roles-invalid"})`, fix: "review triggers.json modelRoles and this trigger's provider/model/allowed list; project roles override defaults" });
			}
		}
	}
	return { runs: resolved, checks };
}

/** The configured failover models, never arbitrary keyspace members. Non-failover jobs add no read. */
export function cooldownModelRefs(runs, deployment, { modelRoles = {}, projects = [], envList = null } = {}) {
	const refs = new Set();
	for (const run of resolveConfiguredModelRuns({ runs, deployment, envList, modelRoles, projects }).runs) {
		if (!Array.isArray(run.fallbackModels) || run.fallbackModels.length === 0) continue;
		for (const ref of [`${run.provider ?? deployment.provider}/${run.model ?? deployment.model}`, ...run.fallbackModels]) {
			if (splitModelEntry(ref)) refs.add(ref);
		}
	}
	return [...refs];
}

export const RADIUS_COST_CAP_LABEL = "Radius (pi-messages) has no verified local cost bound, including zero-rate routes and custom gateways, so the runner refuses every call under a per-job cost cap as unboundable";
export const RADIUS_COST_CAP_FIX = "use a provider with a locally bounded API for capped jobs; raising the cap or changing catalog rates cannot bound Radius: docs/costs.md";
