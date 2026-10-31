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

export function installSubscriptionCredentials({ ModelRuntime, entries, env = process.env, now = Date.now }) {
	const access = new Map(entries.map((row) => [row.provider, subscriptionAccess(row.provider, env)]));
	for (const [provider, token] of access) {
		if (typeof token !== "string" || !token || /\s/.test(token) || (provider === "openai" ? token.startsWith("sk-") : !token.startsWith("sk-ant-oat"))) throw new Error("auth-snapshot-invalid");
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
	return { uninstall() { for (const [name, { original, wrapper }] of methods) if (ModelRuntime.prototype[name] === wrapper) ModelRuntime.prototype[name] = original; } };
}
