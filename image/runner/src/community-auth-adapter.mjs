/** Host-approved community sources are rechecked inside the container before extension code is loaded. */
import { verifyCommunityAuthAdapter } from "./community-auth-patches.mjs";
export { verifyCommunityAuthAdapter as verifyRunnerCommunityAuthAdapter } from "./community-auth-patches.mjs";

export function validateSubscriptionRequest({ provider, api, baseUrl }, entries, { now = () => Date.now() } = {}) {
	const entry = entries.find((row) => row.provider === provider);
	if (!entry) return true;
	if (!Number.isSafeInteger(entry.expiresAt) || !Number.isSafeInteger(entry.deadlineAt) || entry.deadlineAt <= now() || entry.expiresAt <= now() + 5 * 60_000 || entry.expiresAt <= entry.deadlineAt) return false;
	return api === (provider === "openai" ? "openai-responses" : "anthropic-messages") && baseUrl?.replace(/\/$/, "") === (provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com");
}

export function verifySubscriptionAuthEntries(entries, { now = () => Date.now(), verify = verifyCommunityAuthAdapter } = {}) {
	if (!Array.isArray(entries) || entries.length > 2) throw new Error("auth-snapshot-invalid");
	const providers = new Set();
	for (const row of entries) {
		if (!row || !["openai", "anthropic"].includes(row.provider) || providers.has(row.provider) || !Number.isSafeInteger(row.generation) || row.generation < 0 || typeof row.connectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.connectionId)) throw new Error("auth-snapshot-invalid");
		providers.add(row.provider);
		if (!validateSubscriptionRequest({ provider: row.provider, api: row.provider === "openai" ? "openai-responses" : "anthropic-messages", baseUrl: row.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com" }, entries, { now })) throw new Error("auth-snapshot-expired");
		if (row.provider === "openai" ? row.adapter !== "openai-chatgpt" : !["pi-anthropic-oauth@0.3.6", "@gotgenes/pi-anthropic-auth@3.4.3"].includes(row.adapter)) throw new Error("auth-adapter-unsupported");
		if (row.provider === "anthropic") verify({ adapter: row.adapter, root: row.root, digest: row.digest });
	}
	return entries;
}

/** A stage receipt is not proof that pi loaded its provider. Registrations are checked before inference. */
export function installSubscriptionRegistrationGuard({ ModelRuntime, entries }) {
	const expected = new Map(entries.map((row) => [row.provider, row.adapter]));
	const marker = Symbol.for("pi-dispatch.subscription-adapter");
	const selected = new WeakMap();
	const originals = new Map();
	const wrappers = new Map();
	const conflicts = new Set();
	let sealed = false;
	let sealedRuntime = null;
	function validConfig(provider, config) { return typeof config?.streamSimple === "function" && config.streamSimple[marker] === expected.get(provider) && config.api === "anthropic-messages" && (config.baseUrl === undefined || config.baseUrl === "https://api.anthropic.com") && !["apiKey", "headers", "authHeader", "models", "refreshModels", "images", "classifiers"].some((key) => config[key] !== undefined); }
	function refuse(provider) { conflicts.add(provider); throw new Error("auth-adapter-conflicting"); }
	for (const name of ["registerProvider", "registerNativeProvider", "unregisterProvider"]) {
		const original = ModelRuntime?.prototype?.[name];
		if (typeof original !== "function") throw new Error("auth-adapter-unavailable");
		const wrapper = function (providerOrId, config) {
			const provider = name === "registerNativeProvider" ? providerOrId?.id : providerOrId;
			if (!expected.has(provider)) return original.apply(this, arguments);
			if (sealed || provider === "openai" || name === "registerNativeProvider") return refuse(provider);
			if (name === "unregisterProvider") { selected.get(this)?.delete(provider); return original.apply(this, arguments); }
			const stream = config?.streamSimple;
			if (!validConfig(provider, config)) return refuse(provider);
			const result = original.apply(this, arguments);
			if (!selected.has(this)) selected.set(this, new Map());
			selected.get(this).set(provider, stream);
			return result;
		};
		originals.set(name, original);
		wrappers.set(name, wrapper);
		ModelRuntime.prototype[name] = wrapper;
	}
	function actual(runtime, provider) {
		if (typeof runtime?.getRegisteredProviderConfig !== "function" || typeof runtime?.getRegisteredProviderIds !== "function") return false;
		if (provider === "openai") return runtime.getRegisteredProviderConfig(provider) === undefined && !runtime.getRegisteredProviderIds().includes(provider);
		const stream = selected.get(runtime)?.get(provider);
		const config = runtime.getRegisteredProviderConfig(provider);
		return typeof stream === "function" && validConfig(provider, config) && config.streamSimple === stream;
	}
	for (const name of ["stream", "streamSimple", "streamDeferred", "classify", "generateImages"]) {
		const original = ModelRuntime?.prototype?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (model) {
			const provider = model?.provider;
			if (expected.has(provider) && (!sealed || conflicts.has(provider) || !actual(this, provider))) throw new Error("auth-adapter-conflicting");
			return original.apply(this, arguments);
		};
		originals.set(name, original); wrappers.set(name, wrapper); ModelRuntime.prototype[name] = wrapper;
	}
	return {
		seal(runtime) {
			if (conflicts.size || [...expected.keys()].some((provider) => !actual(runtime, provider))) throw new Error("auth-adapter-conflicting");
			sealedRuntime = runtime;
			sealed = true;
		},
		admitted(provider) {
			if (!expected.has(provider)) return true;
			if (!sealed || conflicts.has(provider) || !actual(sealedRuntime, provider)) return false;
			return true;
		},
		uninstall() { for (const [name, original] of originals) if (ModelRuntime.prototype[name] === wrappers.get(name)) ModelRuntime.prototype[name] = original; },
	};
}
