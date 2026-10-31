/** Closed proposal metadata. A generic successful doctor check never gains publishable prose. */
import { splitModelEntry, providerIdProblem } from "./model-ref.mjs";
import { MODEL_ROLE_RE } from "./model-roles.mjs";
import { isProjectId } from "./project-id.mjs";
export const MODEL_PROPOSAL_KINDS = Object.freeze(["retirement", "newer-sibling", "cheaper-route", "catalog-checked", "unavailable"]);
export function modelProposalOf(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || !MODEL_PROPOSAL_KINDS.includes(value.kind)) return null;
	const out = { kind: value.kind };
	for (const key of ["model", "candidate"]) if (value[key] !== undefined) {
		if (!splitModelEntry(value[key])) return null;
		out[key] = value[key];
	}
	if (value.scope !== undefined) { if (!isProjectId(value.scope)) return null; out.scope = value.scope; }
	if (value.role !== undefined) { if (!MODEL_ROLE_RE.test(value.role) || ["inherit", "constructor", "prototype"].includes(value.role)) return null; out.role = value.role; }
	if (value.provider !== undefined) { if (providerIdProblem(value.provider) !== null) return null; out.provider = value.provider; }
	if (["retirement", "newer-sibling"].includes(out.kind) && (!out.model || !out.scope || !out.role)) return null;
	if (["newer-sibling", "cheaper-route"].includes(out.kind) && !out.candidate) return null;
	if (out.kind === "cheaper-route" && !out.model) return null;
	if (out.kind === "catalog-checked" && !out.provider) return null;
	return out;
}
