import { authError } from "./auth-store.mjs";
import { legacyAuthInteraction, loadCommunityAuthHelper, loadNativeAnthropicAuth, verifyNativeAnthropicAuth, readAuthJson, validCommunityCredential } from "./community-auth-helper.mjs";
import { createOpenAIAuthAdapter } from "./oauth-openai.mjs";
import { COMMUNITY_AUTH_ADAPTERS, verifyCommunityAuthAdapter } from "./community-auth-patches.mjs";
export { COMMUNITY_AUTH_ADAPTERS, prepareCommunityAuthAdapter, verifyCommunityAuthAdapter, communityPackageDigest } from "./community-auth-patches.mjs";

export function createDefaultAuthAdapters({ now = () => Date.now(), fetch = globalThis.fetch, loadHelper = loadCommunityAuthHelper, nativeOAuth = null } = {}) {
	let native;
	async function nativeAuth() {
		if (nativeOAuth) return nativeOAuth;
		if (!native) native = loadNativeAnthropicAuth({ fetch, now });
		return native;
	}
	async function usage({ access, signal }) {
		let response;
		try { response = await fetch("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) }); }
		catch { throw authError("auth-usage-unavailable", { transient: true }); }
		if (!response.ok) throw authError("auth-usage-unavailable", { transient: response.status === 429 || response.status >= 500 });
		return readAuthJson(response);
	}
	const entries = { "openai-chatgpt": createOpenAIAuthAdapter({ now, fetch }) };
	for (const [id, pin] of Object.entries(COMMUNITY_AUTH_ADAPTERS)) {
		if (!pin.community) continue;
		const validate = (connection) => { if (id === "@gotgenes/pi-anthropic-auth@3.4.3" && !nativeOAuth) verifyNativeAnthropicAuth(); return verifyCommunityAuthAdapter({ adapter: id, root: connection.root, digest: connection.digest }); };
		entries[id] = {
			validate,
			async login({ connection, interaction, signal }) {
				validate(connection);
				try {
					if (id === "pi-anthropic-oauth@0.3.6") { const helper = await loadHelper({ root: connection.root, fetch }); return validCommunityCredential(await helper.loginAnthropic(legacyAuthInteraction(interaction, signal), now)); }
					return validCommunityCredential(await (await nativeAuth()).login({ ...interaction, signal }));
				} catch (error) { if (error.code?.startsWith("auth-")) throw error; throw authError("auth-login-failed"); }
			},
			async refresh({ connection, credential, signal }) {
				validate(connection);
				try {
					if (id === "pi-anthropic-oauth@0.3.6") { const helper = await loadHelper({ root: connection.root, fetch }); return validCommunityCredential(await helper.refreshAnthropicToken(credential, signal, now)); }
					return validCommunityCredential(await (await nativeAuth()).refresh(credential, signal));
				} catch (error) { if (error.code?.startsWith("auth-")) throw error; throw authError("auth-refresh-uncertain", { uncertain: true }); }
			},
			usage,
			async revoke() { return { confirmed: false }; },
		};
	}
	return entries;
}
