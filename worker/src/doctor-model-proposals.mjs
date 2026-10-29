import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import { parseTriggersDocument } from "./triggers.mjs";
import { parseAllowlist, allowlistEntryFor } from "./egress-allowlist.mjs";
import { parseModelsJson } from "./models-json.mjs";
import { endpointsForModel, loadModelEndpoints } from "./model-endpoints.mjs";
import { lifecycleModels, roleProposalChecks } from "./model-proposals.mjs";
import { getPricedModel } from "./pricing.mjs";

// The default catalog omits retired models, which would make a role's warning vanish on retirement.
// Match the provider SDK's bracket-array query encoding (internal/utils/query.ts).
const APIS = Object.freeze({ anthropic: "https://api.anthropic.com/v1/models?limit=1000&lifecycle%5B%5D=active&lifecycle%5B%5D=deprecated&lifecycle%5B%5D=retired", openai: "https://api.openai.com/v1/models" });
const KEYS = Object.freeze({ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" });
const safeRead = (path) => {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("not a bounded regular file");
	return readFileSync(path, "utf8");
};

export function parseProposalConfig(text) {
	const value = JSON.parse(text);
	if (!value || value.version !== 1 || Object.keys(value).some((key) => !["version", "lifecycleProviders", "proxyUrl", "noticeDays", "replacements", "routes"].includes(key))) throw new Error("invalid proposal configuration");
	const providers = value.lifecycleProviders ?? [];
	if (!Array.isArray(providers) || providers.length > 2 || new Set(providers).size !== providers.length || providers.some((p) => !Object.hasOwn(APIS, p))) throw new Error("unsupported lifecycle provider");
	if (value.noticeDays !== undefined && (!Number.isInteger(value.noticeDays) || value.noticeDays < 1 || value.noticeDays > 365)) throw new Error("invalid notice window");
	if (providers.length) {
		const proxy = new URL(value.proxyUrl);
		if (!["http:", "https:"].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error("invalid lifecycle egress proxy");
	}
	const ref = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/.test(v);
	if (value.replacements !== undefined && (!value.replacements || typeof value.replacements !== "object" || Array.isArray(value.replacements) || Object.entries(value.replacements).some(([a, b]) => !ref(a) || !ref(b)))) throw new Error("invalid replacements");
	if (value.routes !== undefined && (!Array.isArray(value.routes) || value.routes.length > 100 || value.routes.some((r) => !r || Object.keys(r).some((k) => !["model", "alternative"].includes(k)) || !ref(r.model) || !ref(r.alternative)))) throw new Error("invalid declared equivalent routes");
	return { ...value, lifecycleProviders: providers };
}

/** Every request traverses an operator-declared proxy; no direct fallback and no redirects. */
export async function fetchLifecycle(provider, { key, proxyUrl, fetch: request, timeoutMs = 5000 }) {
	if (!Object.hasOwn(APIS, provider)) throw new Error("unsupported lifecycle provider");
	let dispatcher;
	if (!request) {
		dispatcher = new ProxyAgent(proxyUrl);
		request = proxyFetch;
	}
	try {
		const response = await request(APIS[provider], { dispatcher, redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` } });
		if (!response.ok) throw new Error("lifecycle API unavailable");
		const parts = [];
		let length = 0;
		for await (const part of response.body) {
			length += part.length;
			if (length > 1024 * 1024) throw new Error("lifecycle response too large");
			parts.push(part);
		}
		const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
		if (value.has_more === true) throw new Error("lifecycle catalog is incomplete");
		return lifecycleModels(provider, value);
	} finally { await dispatcher?.close(); }
}

export function cheaperRouteChecks(roles, routes, models, endpoints, builtin = getPricedModel) {
	const active = new Set(Object.values(roles).flatMap((scope) => Object.values(scope).map((v) => typeof v === "string" ? v : v.model)));
	const lookup = (ref, declaredOnly) => {
		const slash = ref.indexOf("/"), provider = ref.slice(0, slash), modelId = ref.slice(slash + 1);
		const own = models.providers?.[provider]?.models?.find((m) => m.id === modelId);
		if (declaredOnly && (!own || endpointsForModel({ models, provider, modelId, endpoints }).length === 0)) return null;
		return own?.cost ?? builtin(provider, modelId)?.cost;
	};
	const checks = [];
	for (const route of routes) {
		if (!active.has(route.model)) continue;
		const a = lookup(route.model, false), b = lookup(route.alternative, true);
		const fields = ["input", "output", "cacheRead", "cacheWrite"];
		if (a && b && !a.tiers && !b.tiers && fields.every((f) => Number.isFinite(a[f]) && a[f] >= 0 && Number.isFinite(b[f]) && b[f] >= 0 && b[f] <= a[f]) && fields.some((f) => b[f] < a[f])) checks.push({ ok: true, label: `Model proposal: ${route.alternative} has lower recorded rates than ${route.model} through a declared endpoint; equivalence is operator-declared, review with a capped canary` });
	}
	return checks;
}

export async function doctorModelProposalChecks(env, { cwd, credentials = {}, now = Date.now, read = safeRead, fetch = fetchLifecycle, endpoints: suppliedEndpoints } = {}) {
	let config;
	try { config = parseProposalConfig(read(join(cwd, "model-proposals.json"))); }
	catch (error) {
		if (error?.code === "ENOENT") return [];
		return [{ ok: false, warn: true, label: "Model proposals: model-proposals.json is unreadable or invalid", fix: "use version 1 with explicit lifecycleProviders, proxyUrl and optional noticeDays, replacements or equivalent routes" }];
	}
	const checks = [];
	let roles;
	try { roles = parseTriggersDocument(read(env.PI_TRIGGERS_FILE ?? join(cwd, "triggers.json"))).modelRoles ?? {}; }
	catch { return [{ ok: false, warn: true, label: "Model proposals: current role map unavailable", fix: "fix triggers.json before evaluating proposals" }]; }
	const catalogs = {};
	for (const provider of config.lifecycleProviders) {
		try {
			const host = new URL(APIS[provider]).hostname;
			const allowed = parseAllowlist(read(join(cwd, "egress-allowlist.conf")));
			if (!allowlistEntryFor(allowed, host) || !credentials[KEYS[provider]]) throw new Error("lifecycle egress or credential unavailable");
			catalogs[provider] = await fetch(provider, { key: credentials[KEYS[provider]], proxyUrl: config.proxyUrl });
			checks.push({ ok: true, label: `Model proposals: ${provider} lifecycle catalog checked through declared proxy` });
		} catch { checks.push({ ok: false, warn: true, label: `Model proposals: ${provider} lifecycle catalog unavailable`, fix: "check the opt-in proxy, egress allowlist and API credential; no model was changed" }); }
	}
	checks.push(...roleProposalChecks({ roles, catalogs, replacements: config.replacements, now: now(), noticeDays: config.noticeDays }));
	if (config.routes?.length) try {
		const parsed = parseModelsJson(read(join(env.PI_GLOBAL_PI_DIR, "models.json")));
		if (parsed.error) throw new Error("overlay unavailable");
		const endpoints = suppliedEndpoints ?? loadModelEndpoints({ modelEndpointsFile: env.PI_MODEL_ENDPOINTS_FILE }, { cwd });
		checks.push(...cheaperRouteChecks(roles, config.routes, parsed.value, endpoints));
	} catch { checks.push({ ok: false, warn: true, label: "Model proposals: declared route prices or endpoints unavailable", fix: "check the overlay models.json and declared endpoints; no route was changed" }); }
	return checks;
}
