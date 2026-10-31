/** Only audited auth entry points load on the credential owner, never an extension's default/UI entry. */
import { join } from "node:path";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { authError, validateAuthCredential } from "./auth-store.mjs";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const NATIVE_ANTHROPIC_AUTH_SHA256 = "835268caed5dab6a0c7f157c551ed59a00635c76305e6e0c41b579c41aa07bc5";
const TERMINAL = new Set(["invalid_grant", "invalid_refresh_token", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
export async function readAuthJson(response, { maxBytes = 128 * 1024 } = {}) {
	const reader = response.body?.getReader?.();
	if (!reader) { const text = await response.text(); if (Buffer.byteLength(text) > maxBytes) throw authError("auth-response-invalid", { uncertain: true }); try { return JSON.parse(text); } catch { throw authError("auth-response-invalid", { uncertain: true }); } }
	const chunks = []; let size = 0;
	try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maxBytes) throw authError("auth-response-invalid", { uncertain: true }); chunks.push(Buffer.from(item.value)); } }
	finally { await reader.cancel().catch(() => {}); }
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw authError("auth-response-invalid", { uncertain: true }); }
}

export function makeAuthFetch({ fetch = globalThis.fetch } = {}) {
	return async (input, options = {}) => {
		if (String(input) !== TOKEN_URL) throw authError("auth-endpoint-unsupported");
		let response;
		try { response = await fetch(input, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]) }); }
		catch { throw authError("auth-network-unavailable", { transient: true, uncertain: true }); }
		if (!response.ok) {
			let data; try { data = await readAuthJson(response); } catch {}
			const code = typeof data?.error === "string" ? data.error : data?.error?.code;
			if (TERMINAL.has(code) || response.status === 401) throw authError("auth-reauth-required");
			if (response.status === 429 || response.status >= 500) throw authError("auth-network-unavailable", { transient: true });
			throw authError("auth-provider-refused");
		}
		const data = await readAuthJson(response);
		if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31 * 24 * 3600 || (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token))) throw authError("auth-response-invalid", { uncertain: true });
		return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
	};
}

export async function loadCommunityAuthHelper({ root, fetch = globalThis.fetch, load = null }) {
	const loader = load ?? createJiti(import.meta.url, { fsCache: false, moduleCache: false }).import;
	const module = await loader(join(root, "src/auth.ts"));
	if (typeof module.configureDispatchAuth !== "function" || typeof module.loginAnthropic !== "function" || typeof module.refreshAnthropicToken !== "function") throw authError("auth-adapter-unavailable");
	module.configureDispatchAuth(makeAuthFetch({ fetch }));
	return module;
}

export function verifyNativeAnthropicAuth({ resolve = import.meta.resolve, readFile = readFileSync } = {}) {
	const path = fileURLToPath(new URL("../auth/oauth/anthropic.js", resolve("@earendil-works/pi-ai/providers/anthropic")));
	const source = readFile(path, "utf8");
	if (createHash("sha256").update(source).digest("hex") !== NATIVE_ANTHROPIC_AUTH_SHA256) throw authError("auth-adapter-source-mismatch");
	return { path, source };
}

export function loadNativeAnthropicAuth({ fetch = globalThis.fetch, now = () => Date.now(), verify = verifyNativeAnthropicAuth, evaluate = null } = {}) {
	const { path, source: original } = verify();
	let source = original.replace("await fetch(url, {", "await dispatchFetch(url, {").replaceAll("Date.now()", "dispatchNow()");
	source = source.replace('const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";', 'const CALLBACK_HOST = "127.0.0.1";');
	source = source.replaceAll("catch (error) {", 'catch (error) { if (error?.code?.startsWith("auth-")) throw error;');
	source = 'let dispatchFetch = globalThis.fetch; let dispatchNow = Date.now;\nexport function configureDispatchAuth(transport, clock) { dispatchFetch = transport; dispatchNow = clock; }\n' + source;
	const run = evaluate ?? ((text, options) => createJiti(import.meta.url, { fsCache: false, moduleCache: false }).evalModule(text, options));
	const module = run(source, { filename: path });
	module.configureDispatchAuth(makeAuthFetch({ fetch }), now);
	return module.anthropicOAuth;
}

export function legacyAuthInteraction(interaction, signal) {
	if (!interaction || typeof interaction.notify !== "function" || typeof interaction.prompt !== "function") throw authError("auth-interaction-required");
	return { signal, onAuth: (info) => interaction.notify({ type: "auth_url", ...info }), onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }), onPrompt: (prompt) => interaction.prompt({ type: "text", ...prompt, signal }), onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: "Paste the final callback URL or code#state", signal }), onSelect: (prompt) => interaction.prompt({ type: "select", ...prompt, signal }), onProgress: () => {} };
}

export function validCommunityCredential(value) {
	const credential = validateAuthCredential(value, { provider: "anthropic" });
	if (!credential.access.startsWith("sk-ant-oat")) throw authError("auth-credential-invalid");
	return credential;
}
