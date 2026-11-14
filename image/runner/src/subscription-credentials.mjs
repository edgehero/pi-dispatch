/** Explicit subscription credentials outrank models.json placeholders and request auth headers. */
import { validateSubscriptionRequest } from "./community-auth-adapter.mjs";

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key", "openai-organization", "openai-project", "anthropic-organization-id"]);
export const subscriptionAccess = (provider, env) => env[provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_OAUTH_TOKEN"];
export function subscriptionRequestOverrides(options, access) {
	if (options?.apiKey !== undefined && options.apiKey !== access) return true;
	if (Object.keys(options?.headers ?? {}).some((name) => AUTH_HEADERS.has(name.toLowerCase()))) return true;
	return Object.entries(options?.env ?? {}).some(([name, value]) => ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"].includes(name) && value !== access);
}
const withoutAuthHeaders = (headers) => Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase())));

const tokenShaped = (provider, token) => typeof token === "string" && token !== "" && !/\s/.test(token) && (provider === "openai" ? !token.startsWith("sk-") : token.startsWith("sk-ant-oat"));

export function installSubscriptionCredentials({ ModelRuntime, entries, env = process.env, now = Date.now }) {
	const access = new Map(entries.map((row) => [row.provider, subscriptionAccess(row.provider, env)]));
	for (const [provider, token] of access) {
		if (!tokenShaped(provider, token)) throw new Error("auth-snapshot-invalid");
	}
	const methods = new Map();
	for (const name of ["getAuth", "prepareRequest"]) {
		const original = ModelRuntime.prototype[name];
		if (typeof original !== "function" && entries.length > 0) throw new Error("auth-capability-unsupported");
		if (typeof original !== "function") continue;
		const wrapper = async function (model, options) {
			const provider = typeof model === "string" ? model : model?.provider;
			if (!access.has(provider)) return original.call(this, model, options);
			const token = access.get(provider);
			if (subscriptionRequestOverrides(options, token) || (typeof model === "object" && !validateSubscriptionRequest(model, entries, { now }))) throw new Error("auth-request-override");
			const result = await original.call(this, model, { ...options, apiKey: token });
			if (name === "getAuth") return result ? { ...result, auth: { ...result.auth, apiKey: token, headers: withoutAuthHeaders(result.auth?.headers) } } : result;
			if (!result || !validateSubscriptionRequest(result.model, entries, { now })) throw new Error("auth-request-override");
			return { ...result, model: { ...result.model, headers: withoutAuthHeaders(result.model.headers) }, options: { ...result.options, apiKey: token, headers: withoutAuthHeaders(result.options?.headers) } };
		};
		methods.set(name, { original, wrapper });
		ModelRuntime.prototype[name] = wrapper;
	}
	return {
		uninstall() { for (const [name, { original, wrapper }] of methods) if (ModelRuntime.prototype[name] === wrapper) ModelRuntime.prototype[name] = original; },
		/**
		 * Issue #888, part 3: a renewed snapshot for a running job (credential-refresh.mjs). Taken only for the SAME
		 * connection of a provider this job already holds, a generation no older, a deadline no earlier and still ahead, an
		 * expiry past that deadline, and a token of the provider's shape; then the entry the request check reads moves to
		 * it and every call from now on uses the new token. Anything else is refused (false) and changes nothing.
		 */
		refresh(row) {
			const entry = entries.find((candidate) => candidate.provider === row?.provider);
			if (!entry || row.connectionId !== entry.connectionId) return false;
			if (!Number.isSafeInteger(row.generation) || row.generation < entry.generation) return false;
			if (!Number.isSafeInteger(row.deadlineAt) || row.deadlineAt < entry.deadlineAt || row.deadlineAt <= now()) return false;
			if (!Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.deadlineAt) return false;
			if (!tokenShaped(row.provider, row.token)) return false;
			entry.generation = row.generation;
			entry.deadlineAt = row.deadlineAt;
			entry.expiresAt = row.expiresAt;
			access.set(row.provider, row.token);
			return true;
		},
	};
}
