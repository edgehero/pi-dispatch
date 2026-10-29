import { modelListProblem, splitModelEntry } from "./model-ref.mjs";
import { isProjectId } from "./project-id.mjs";

export const MODEL_ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const scopeOf = (roles, id) => object(roles) && typeof id === "string" && Object.hasOwn(roles, id) ? roles[id] : {};
const failure = (reason, message) => Object.assign(new Error(message), { piDispatchConfig: true, modelSelectionReason: reason });

/** A misspelt policy block must refuse rather than silently removing the reviewed ceiling. */
export function isModelRolesField(key) {
	const text = String(key);
	const normalized = text.normalize("NFKC").replace(/[^a-z]/gi, "").toLowerCase();
	if (["modelroles", "modelrole"].includes(normalized)) return true;
	if (/^[\x20-\x7E]*$/.test(text) || normalized.length < 4) return false;
	let cursor = 0;
	for (const letter of "modelroles") if (normalized[cursor] === letter) cursor++;
	return cursor === normalized.length;
}

/** Reviewed policy, never job data. Bounded maps keep the effective allowlist a policy rather than a catalog. */
export function validateModelRoles(value) {
	if (value === undefined) return {};
	const bad = () => { throw failure("model-roles-invalid", "modelRoles must map default/project ids to at most 16 roles, each a provider/model or {model, fallbackModels}"); };
	if (!object(value) || Object.keys(value).length > 128) bad();
	const out = {};
	for (const [project, roles] of Object.entries(value)) {
		if (!isProjectId(project) || !object(roles) || Object.keys(roles).length > 16) bad();
		const row = {};
		for (const [role, entry] of Object.entries(roles)) {
			if (!MODEL_ROLE_RE.test(role) || ["inherit", "constructor", "prototype"].includes(role)) bad();
			const ref = typeof entry === "string" ? entry : entry?.model;
			if (!splitModelEntry(ref) || splitModelEntry(ref).model.startsWith("role:")) bad();
			if (typeof entry === "string") row[role] = entry;
			else {
				if (!object(entry) || Object.keys(entry).some((k) => !["model", "fallbackModels"].includes(k))) bad();
				if (entry.fallbackModels !== undefined && modelListProblem(entry.fallbackModels) !== null) bad();
				row[role] = { model: ref, ...(entry.fallbackModels !== undefined ? { fallbackModels: [...entry.fallbackModels] } : {}) };
			}
		}
		out[project] = row;
	}
	return out;
}

export function roleMapFor(roles, project = null) {
	const entries = { ...scopeOf(roles, "default"), ...(project && project !== "default" ? scopeOf(roles, project) : {}) };
	return Object.fromEntries(Object.entries(entries).map(([role, entry]) => [role, typeof entry === "string" ? entry : entry.model]));
}

/** One snapshot is used for admission, endpoint slots and the runner. Failover may narrow it afterwards. */
export function resolveModelRoles(job, roles, project = null, { authoredProvider = undefined } = {}) {
	// A receiver or an old queued delivery cannot carry authority over the live map.
	const { modelRoles: _queuedMap, modelRole: _queuedRole, ...authored } = job;
	job = authored;
	const map = roleMapFor(roles, project);
	const requested = typeof job.model === "string" && job.model.startsWith("role:") ? job.model.slice(5) : null;
	if (requested !== null && (!MODEL_ROLE_RE.test(requested) || !Object.hasOwn(map, requested))) throw failure("model-role-unknown", "the requested model role is not declared in modelRoles");
	if (requested === null && Object.keys(map).length === 0) return job;
	let resolved = { ...job };
	if (requested !== null) {
		const ref = splitModelEntry(map[requested]);
		if (authoredProvider !== undefined && authoredProvider !== null && authoredProvider !== ref.provider) throw failure("model-role-provider-conflict", "run.provider conflicts with its model role provider");
		const entry = scopeOf(roles, project)[requested] ?? scopeOf(roles, "default")[requested];
		resolved = { ...resolved, ...ref, modelRole: requested };
		if (job.fallbackModels !== undefined && typeof entry !== "string" && entry.fallbackModels !== undefined) throw failure("model-roles-invalid", "declare fallbackModels on the role or the trigger, not both");
		if (typeof entry !== "string" && entry.fallbackModels !== undefined) resolved.fallbackModels = [...entry.fallbackModels];
	}
	const refs = [...(job.models ?? [`${resolved.provider}/${resolved.model}`]), ...Object.values(map)];
	for (const entry of Object.values({ ...scopeOf(roles, "default"), ...(project && project !== "default" ? scopeOf(roles, project) : {}) })) if (typeof entry !== "string") refs.push(...(entry.fallbackModels ?? []));
	const models = [...new Set(refs)];
	if (modelListProblem(models) !== null) throw failure("model-roles-invalid", "the role-expanded allowed-model list is invalid or exceeds 16 models");
	return { ...resolved, models, modelRoles: map };
}
