/** Official ChatGPT direct OAuth. Registration identity and renewal secrets stay on the owner host. */
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authError, validOpenAIAccessToken } from "./auth-store.mjs";
import { readAuthJson } from "./community-auth-helper.mjs";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const REDIRECT = "http://localhost:1455/auth/callback";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
export const PINNED_OPENAI_OAUTH_SHA256 = "4cf9fc758a07ffe4ee022326404b5dcc86767ee4154945c0417c7f95eaecdcc2";
export function verifyPinnedOpenAIOAuth({ resolve = import.meta.resolve, readFile = readFileSync } = {}) {
	const path = fileURLToPath(new URL("../auth/oauth/openai-chatgpt.js", resolve("@earendil-works/pi-ai/providers/openai")));
	if (createHash("sha256").update(readFile(path)).digest("hex") !== PINNED_OPENAI_OAUTH_SHA256) throw authError("auth-adapter-source-mismatch");
	return true;
}
export function parseOpenAIToken(data, { now, previous = null } = {}) {
	if (!data || !validOpenAIAccessToken(data.access_token) || typeof data.refresh_token !== "string" || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31 * 24 * 3600 || typeof data.scope !== "string") throw authError("auth-response-invalid", { uncertain: true });
	const scopes = data.scope.split(/\s+/).filter(Boolean);
	if (!scopes.includes("chatgpt.tokens.use.direct")) throw authError("auth-permission-missing");
	const earliest = data.earliest_refresh_at;
	const earliestRefreshAt = typeof earliest === "number" && Number.isFinite(earliest) ? Math.ceil(earliest < 1e12 ? earliest * 1000 : earliest) : typeof earliest === "string" && Number.isFinite(Date.parse(earliest)) ? Date.parse(earliest) : null;
	return { type: "oauth", access: data.access_token, refresh: data.refresh_token, expires: Math.floor(now() + data.expires_in * 1000), scopes, ...(earliestRefreshAt === null ? {} : { earliestRefreshAt }) };
}

export async function verifyOpenAIIdentity({ token, clientId, nonce, fetch = globalThis.fetch, now = () => Date.now(), verify = null }) {
	let claims;
	try {
		if (verify) claims = await verify({ token, clientId, nonce, issuer: ISSUER });
		else {
			const { createRemoteJWKSet, jwtVerify, customFetch } = await import("jose");
			const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
			if (!response.ok) throw new Error();
			const discovery = await readAuthJson(response);
			if (discovery.issuer !== ISSUER || typeof discovery.jwks_uri !== "string" || new URL(discovery.jwks_uri).origin !== ISSUER) throw new Error();
			const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: fetch });
			claims = (await jwtVerify(token, jwks, { issuer: ISSUER, audience: clientId, currentDate: new Date(now()), clockTolerance: 30, algorithms: ["RS256", "ES256"] })).payload;
		}
		if (typeof claims?.sub !== "string" || !claims.sub || claims.sub.length > 512 || claims.nonce !== nonce || claims.iss !== ISSUER || !(claims.aud === clientId || Array.isArray(claims.aud) && claims.aud.includes(clientId)) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) throw new Error();
		return { subject: claims.sub };
	} catch { throw authError("auth-identity-invalid"); }
}

async function authorizationCallback({ url, state, interaction, signal, serverFactory = createServer }) {
	const manualAbort = new AbortController();
	let resolveCallback;
	const callback = new Promise((resolve) => { resolveCallback = resolve; });
	const server = serverFactory((request, response) => {
		const received = new URL(request.url, REDIRECT);
		if (received.pathname !== "/auth/callback" || received.searchParams.get("state") !== state || !received.searchParams.get("code")) { response.writeHead(400); response.end("Invalid authorization callback"); return; }
		response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); response.end("Sign-in complete. Return to pi-dispatch.");
		resolveCallback(received);
	});
	const abort = () => resolveCallback(null);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		await new Promise((resolve) => { server.once("error", resolve); server.listen(1455, "127.0.0.1", resolve); });
		interaction.notify({ type: "auth_url", url, instructions: "Complete sign-in, or paste the final localhost callback URL. Forward port 1455 when using another machine." });
		const manual = Promise.resolve(interaction.prompt({ type: "manual_code", message: "Paste the final callback URL", signal: AbortSignal.any([manualAbort.signal, ...(signal ? [signal] : [])]) })).then((value) => new URL(value));
		const received = await Promise.race([callback, manual]);
		signal?.throwIfAborted();
		if (!received || received.origin !== "http://localhost:1455" || received.pathname !== "/auth/callback" || received.searchParams.get("state") !== state || !received.searchParams.get("code")) throw authError("auth-callback-invalid");
		return received;
	} finally { manualAbort.abort(); signal?.removeEventListener("abort", abort); server.closeAllConnections?.(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
}

export function createOpenAIAuthAdapter({ fetch = globalThis.fetch, now = () => Date.now(), verifyIdentity = verifyOpenAIIdentity, callback = authorizationCallback } = {}) {
	async function tokenRequest(body, signal) {
		let response;
		try { response = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]) }); }
		catch { throw authError("auth-network-unavailable", { transient: true, uncertain: true }); }
		const data = await readAuthJson(response);
		if (!response.ok) {
			const code = typeof data?.error === "string" ? data.error : data?.error?.code;
			if (TERMINAL.has(code)) throw authError("auth-reauth-required");
			if (code === "invalid_client") throw authError("auth-client-invalid");
			throw authError("auth-provider-refused", { transient: response.status === 429 || response.status >= 500 });
		}
		return data;
	}
	return {
		async validate() { verifyPinnedOpenAIOAuth(); },
		async login({ interaction, signal, previous }) {
			if (typeof interaction?.prompt !== "function" || typeof interaction?.notify !== "function") throw authError("auth-interaction-required");
			const verifier = randomBytes(32).toString("base64url");
			const state = randomBytes(32).toString("base64url");
			const nonce = randomBytes(32).toString("base64url");
			const hostId = previous.registration.hostId;
			const savedClient = previous.registration.clientId;
			const url = new URL(`${ISSUER}/oauth/authorize`);
			url.search = new URLSearchParams({ client_id: savedClient ?? "dynamic_agent_client", ...(savedClient ? {} : { agent_name_hint: "pi-dispatch" }), ext_agent_host_id: `urn:uuid:${hostId}`, response_type: "code", redirect_uri: REDIRECT, resource: RESOURCE, scope: SCOPES, state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
			const returned = await callback({ url: url.toString(), state, interaction, signal });
			const clientId = savedClient ?? returned.searchParams.get("client_id");
			if (typeof clientId !== "string" || !clientId || clientId.length > 1024) throw authError("auth-client-invalid");
			const data = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code: returned.searchParams.get("code"), code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE }, signal);
			const identity = await verifyIdentity({ token: data.id_token, clientId, nonce, fetch, now });
			if (previous.registration.subject && previous.registration.subject !== identity.subject) throw authError("auth-account-changed");
			return { credential: { ...parseOpenAIToken(data, { now }), clientId }, registration: { hostId, clientId, subject: identity.subject } };
		},
		async refresh({ credential, signal }) {
			if (credential.earliestRefreshAt > now()) throw authError("auth-refresh-too-early", { transient: true });
			if (typeof credential.clientId !== "string" || !credential.clientId) throw authError("auth-client-invalid");
			return { ...parseOpenAIToken(await tokenRequest({ grant_type: "refresh_token", client_id: credential.clientId, refresh_token: credential.refresh, resource: RESOURCE }, signal), { now, previous: credential }), clientId: credential.clientId };
		},
		async revoke({ credential, signal }) {
			const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal });
			if (!discovery.ok) throw authError("auth-revocation-unconfirmed");
			const config = await readAuthJson(discovery);
			if (typeof config.revocation_endpoint !== "string" || new URL(config.revocation_endpoint).origin !== ISSUER) throw authError("auth-revocation-unconfirmed");
			const response = await fetch(config.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.refresh, token_type_hint: "refresh_token", client_id: credential.clientId }), signal });
			return { confirmed: response.status === 200 };
		},
	};
}
