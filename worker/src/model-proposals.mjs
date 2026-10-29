/** Reviewed suggestions only (#717). Data enters here; no routing or settings writes leave it. */

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export function catalogDiff(before, after, providers) {
	const index = (rows) => {
		const out = new Map();
		for (const row of rows) {
			if (!row || typeof row.provider !== "string" || typeof row.id !== "string" || !REF.test(row.provider) || !REF.test(row.id) || !providers.includes(row.provider) || row.type !== "chat") continue;
			const key = `${row.provider}/${row.id}`;
			if (out.has(key)) throw new Error("ambiguous model catalog");
			out.set(key, row);
		}
		return out;
	};
	const old = index(before), next = index(after);
	const changed = [];
	for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
		const a = old.get(key), b = next.get(key);
		const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
		const rates = (row) => JSON.stringify(canonical(row?.cost ?? null));
		if (!a || !b || rates(a) !== rates(b)) changed.push({ ref: key, kind: !a ? "added" : !b ? "removed" : "repriced", before: a ?? null, after: b ?? null });
	}
	return changed;
}

/** Same worst-call bound as enforcement, for an explicitly disclosed empty-text fixture, not a job forecast. */
export function proposalCallBound(model, outputTokens = 4096, callCostBound) {
	const micros = callCostBound("streamSimple", model, { messages: [] }, { maxTokens: outputTokens }, {});
	return Number.isFinite(micros) ? micros / 1e6 : null;
}

export function renderCatalogProposal(changes, { providers, capsUsd, outputTokens = 4096 }, callCostBound) {
	const lines = ["## Model catalog proposals", "", `Public report scope: ${providers.join(", ")}. Reference caps: ${capsUsd.map((n) => `$${n}`).join(", ")}; these are public report inputs, not deployment caps.`, "", `First-call bounds use the runner's guard with an empty-text context and maxTokens=${outputTokens}; actual job prompts, images, thinking and options can increase the bound. Models remain unchanged until a reviewed edit.`, ""];
	if (!changes.length) lines.push("No added, removed or repriced chat models in this scope.");
	for (const change of changes) {
		const bound = change.after ? proposalCallBound(change.after, outputTokens, callCostBound) : null;
		const price = bound === null ? "not boundable" : `$${bound.toFixed(6)}`;
		const beforeBound = change.before ? proposalCallBound(change.before, outputTokens, callCostBound) : null;
		const previous = change.before ? `; previous reference bound: ${beforeBound === null ? "not boundable" : `$${beforeBound.toFixed(6)}`}` : "";
		lines.push(`- ${change.kind}: \`${change.ref}\`; reference first-call bound: ${change.after ? price : "removed"}${previous}${bound === null ? "" : `; ${capsUsd.map((cap) => `${bound <= cap ? "fits" : "exceeds"} $${cap}`).join(", ")}`}.`);
	}
	return lines.join("\n");
}

/** Provider fields verified against their Models API references, 2026-10-29. No name-based sibling guesses. */
export function lifecycleModels(provider, response) {
	if (!Array.isArray(response?.data) || response.data.length > 1000) throw new Error("invalid lifecycle catalog");
	return response.data.map((row) => {
		if (!row || typeof row.id !== "string" || !REF.test(row.id)) throw new Error("invalid lifecycle model");
		const date = provider === "anthropic" ? row.retires_at : row.shutdown_date;
		if (date != null && (typeof date !== "string" || !Number.isFinite(Date.parse(date)))) throw new Error("invalid retirement date");
		if (provider === "anthropic" && !["active", "deprecated", "retired"].includes(row.lifecycle)) throw new Error("invalid lifecycle stage");
		return { id: row.id, retiresAt: date ?? null, deprecated: provider === "anthropic" ? row.lifecycle !== "active" : date != null, line: typeof row.line === "string" ? row.line : null, createdAt: row.created_at ?? null };
	});
}

export function roleProposalChecks({ roles, catalogs = {}, replacements = {}, now, noticeDays = 90 }) {
	const checks = [];
	for (const [scope, mapping] of Object.entries(roles)) for (const [role, value] of Object.entries(mapping)) {
		const ref = typeof value === "string" ? value : value?.model;
		if (typeof ref !== "string") continue;
		const slash = ref.indexOf("/"), provider = ref.slice(0, slash), id = ref.slice(slash + 1);
		const rows = catalogs[provider] ?? [];
		const model = rows.find((m) => m.id === id);
		if (!model) continue;
		const retirement = model.retiresAt === null ? null : Date.parse(model.retiresAt);
		if (model.deprecated || retirement !== null && retirement - now <= noticeDays * 86400000) checks.push({ ok: false, warn: true, label: `Model role ${scope}/${role}: ${ref} is deprecated${model.retiresAt ? `; retirement ${model.retiresAt}` : ""}`, fix: replacements[ref] ? `review provider replacement ${replacements[ref]} with a capped canary, then edit modelRoles` : "review the provider's deprecation notice and run a capped canary before editing modelRoles" });
		const siblings = model.line ? rows.filter((m) => m.line === model.line && !m.deprecated && Number.isFinite(Date.parse(m.createdAt)) && Date.parse(m.createdAt) > Date.parse(model.createdAt)) : [];
		if (siblings.length) checks.push({ ok: true, label: `Model role ${scope}/${role}: newer provider-declared sibling ${siblings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0].id}; review with a capped canary` });
	}
	return checks;
}
