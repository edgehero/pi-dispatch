/** Exact subscription-policy parser shared with read-only metadata consumers. */
import { isAbsolute } from "node:path";
import { SUBSCRIPTION_CONNECTION_LIMIT } from "./subscription-limits.mjs";
import { AUTH_ID_RE, authError } from "./auth-store.mjs";
import { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-metadata.mjs";
import { MAX_USD_MICROS } from "./money.mjs";
const PROVIDERS = new Set(["openai", "anthropic"]);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
export function parseAuthConnections(text) {
	let value;
	try { value = typeof text === "string" ? JSON.parse(text) : text; } catch { throw authError("auth-policy-invalid"); }
	if (!value || value.version !== 1 || !onlyKeys(value, ["version", "connections", "bindings"]) || !Array.isArray(value.connections) || value.connections.length > SUBSCRIPTION_CONNECTION_LIMIT || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) throw authError("auth-policy-invalid");
	const ids = new Set();
	const connections = value.connections.map((row) => {
		if (!row || !onlyKeys(row, ["id", "provider", "adapter", "ownerHost", "root", "digest", "extraUsageCreditMicros", "quotaWindows"]) || typeof row.id !== "string" || !AUTH_ID_RE.test(row.id) || ids.has(row.id) || !PROVIDERS.has(row.provider) || typeof row.ownerHost !== "string" || !AUTH_ID_RE.test(row.ownerHost)) throw authError("auth-policy-invalid");
		ids.add(row.id);
		const adapter = COMMUNITY_AUTH_ADAPTERS[row.adapter];
		if (!adapter || adapter.provider !== row.provider) throw authError("auth-adapter-unsupported");
		if (adapter.community && (typeof row.root !== "string" || !isAbsolute(row.root) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest))) throw authError("auth-adapter-unapproved");
		if (!adapter.community && (row.root !== undefined || row.digest !== undefined)) throw authError("auth-policy-invalid");
		if (row.extraUsageCreditMicros !== undefined && (!Number.isSafeInteger(row.extraUsageCreditMicros) || row.extraUsageCreditMicros <= 0 || row.extraUsageCreditMicros > MAX_USD_MICROS)) throw authError("auth-policy-invalid");
		const quotaWindows = row.quotaWindows ?? ["five-hour", "seven-day"];
		if (!Array.isArray(quotaWindows) || quotaWindows.length > 2 || new Set(quotaWindows).size !== quotaWindows.length || quotaWindows.some((item) => !["five-hour", "seven-day"].includes(item))) throw authError("auth-policy-invalid");
		return { id: row.id, provider: row.provider, adapter: row.adapter, ownerHost: row.ownerHost, quotaWindows: [...quotaWindows], ...(row.extraUsageCreditMicros === undefined ? {} : { extraUsageCreditMicros: row.extraUsageCreditMicros }), ...(adapter.community ? { root: row.root, digest: row.digest } : {}) };
	});
	const bindings = {};
	for (const [provider, id] of Object.entries(value.bindings)) {
		if (!PROVIDERS.has(provider) || !connections.some((row) => row.id === id && row.provider === provider)) throw authError("auth-policy-invalid");
		bindings[provider] = id;
	}
	return { version: 1, connections, bindings };
}
