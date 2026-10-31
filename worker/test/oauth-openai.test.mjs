import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIAuthAdapter, parseOpenAIToken, verifyOpenAIIdentity, verifyPinnedOpenAIOAuth } from "../src/oauth-openai.mjs";
import { makeAuthFetch, readAuthJson, loadNativeAnthropicAuth, verifyNativeAnthropicAuth } from "../src/community-auth-helper.mjs";

const instant = 1_800_000_000_000;
const now = () => instant;
const token = () => ({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct", id_token: "identity" });

test("official token parsing requires direct permission and preserves precise lifetime/refresh metadata", () => {
	assert.equal(verifyPinnedOpenAIOAuth(), true);
	assert.throws(() => verifyPinnedOpenAIOAuth({ readFile: () => "upstream flow changed" }), /auth-adapter-source-mismatch/);
	assert.equal(parseOpenAIToken({ ...token(), earliest_refresh_at: instant / 1000 + 1800 }, { now }).earliestRefreshAt, instant + 1800_000);
	assert.equal(parseOpenAIToken(token(), { now }).expires, instant + 3600_000);
	assert.equal(JSON.stringify(parseOpenAIToken({ ...token(), id_token: "private-identity-token" }, { now })).includes("private-identity-token"), false);
	for (const invalid of [{ ...token(), expires_in: -1 }, { ...token(), refresh_token: "" }, { ...token(), scope: "openid" }]) assert.throws(() => parseOpenAIToken(invalid, { now }), /auth-/);
	for (const access_token of ["sk-paid-api-key", "SK-paid-api-key", " token", "token ", "token\tother", "token\nother", "token:invalid", ""]) assert.throws(() => parseOpenAIToken({ ...token(), access_token }, { now }), /auth-response-invalid/);
});

test("new sign-in validates identity, while returning sign-in reuses client and stable host registration", async () => {
	const requests = [];
	let authorization;
	let identityNonce;
	const adapter = createOpenAIAuthAdapter({ now, fetch: async (url, options) => { requests.push({ url, options }); return Response.json(token()); }, callback: async ({ url, state }) => { authorization = new URL(url); return new URL(`http://localhost:1455/auth/callback?code=code&state=${state}&client_id=issued-client`); }, verifyIdentity: async ({ nonce, clientId }) => { identityNonce = nonce; assert.equal(clientId, "issued-client"); return { subject: "private-subject" }; } });
	const interaction = { notify() {}, prompt() {} };
	const first = await adapter.login({ interaction, previous: { registration: { hostId: "installation-id" } } });
	assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
	assert.equal(authorization.searchParams.get("agent_name_hint"), "pi-dispatch");
	assert.equal(identityNonce, authorization.searchParams.get("nonce"));
	assert.equal(requests[0].options.body.get("resource"), "https://api.openai.com/v1");
	assert.equal(first.registration.subject, "private-subject");
	await adapter.login({ interaction, previous: first });
	assert.equal(authorization.searchParams.get("client_id"), "issued-client");
	assert.equal(authorization.searchParams.has("agent_name_hint"), false);
	assert.equal(authorization.searchParams.has("id_token_hint"), false);
	assert.equal(authorization.toString().includes("identity"), false);
	assert.equal(authorization.searchParams.get("ext_agent_host_id"), "urn:uuid:installation-id");
});

test("returning sign-in cannot silently change the connected account", async () => {
	const adapter = createOpenAIAuthAdapter({ now, fetch: async () => Response.json(token()), callback: async ({ state }) => new URL(`http://localhost:1455/auth/callback?state=${state}&code=code`), verifyIdentity: async () => ({ subject: "another-subject" }) });
	await assert.rejects(adapter.login({ interaction: { notify() {}, prompt() {} }, previous: { registration: { clientId: "saved", hostId: "host", subject: "original" } } }), /auth-account-changed/);
});

test("refresh uses issued client/resource and rotating replacement, never requests scope", async () => {
	let body;
	const adapter = createOpenAIAuthAdapter({ now, fetch: async (_url, options) => { body = options.body; return Response.json({ ...token(), refresh_token: "replacement" }); } });
	const result = await adapter.refresh({ credential: { access: "old", refresh: "old-refresh", expires: instant, clientId: "issued" } });
	assert.equal(body.get("client_id"), "issued");
	assert.equal(body.get("refresh_token"), "old-refresh");
	assert.equal(body.has("scope"), false);
	assert.equal(result.refresh, "replacement");
	assert.equal(Object.hasOwn(result, "idToken"), false);
	await assert.rejects(adapter.refresh({ credential: { earliestRefreshAt: instant + 60_000 } }), /auth-refresh-too-early/);
});

test("refresh failures expose closed classifications rather than provider payloads", async () => {
	for (const [response, code, transient, uncertain] of [[Response.json({ error: "invalid_grant", secret: "private" }, { status: 400 }), "auth-reauth-required", false, false], [Response.json({ error: "invalid_client" }, { status: 400 }), "auth-client-invalid", false, false], [Response.json({ detail: "private" }, { status: 503 }), "auth-provider-refused", true, false]]) {
		const adapter = createOpenAIAuthAdapter({ now, fetch: async () => response });
		await assert.rejects(adapter.refresh({ credential: { clientId: "issued", refresh: "private" } }), (error) => error.message === code && error.transient === transient && error.uncertain === uncertain);
	}
});

test("JWKS validation rejects incorrect nonce, audience, issuer, expiry and signature", async () => {
	const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
	const pair = await generateKeyPair("RS256");
	const key = { ...(await exportJWK(pair.publicKey)), kid: "key", alg: "RS256", use: "sig" };
	const fetch = async (url) => Response.json(String(url).endsWith("openid-configuration") ? { issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/keys" } : { keys: [key] });
	const make = (claims = {}, signing = pair.privateKey) => new SignJWT({ nonce: "nonce", ...claims }).setProtectedHeader({ alg: "RS256", kid: "key" }).setIssuer(claims.iss ?? "https://auth.openai.com").setAudience(claims.aud ?? "client").setSubject("subject").setExpirationTime(claims.exp ?? instant / 1000 + 3600).sign(signing);
	assert.deepEqual(await verifyOpenAIIdentity({ token: await make(), clientId: "client", nonce: "nonce", fetch, now }), { subject: "subject" });
	for (const claims of [{ nonce: "wrong" }, { aud: "other" }, { iss: "https://other.invalid" }, { exp: instant / 1000 - 60 }]) await assert.rejects(verifyOpenAIIdentity({ token: await make(claims), clientId: "client", nonce: "nonce", fetch, now }), /auth-identity-invalid/);
	const wrong = await generateKeyPair("RS256");
	await assert.rejects(verifyOpenAIIdentity({ token: await make({}, wrong.privateKey), clientId: "client", nonce: "nonce", fetch, now }), /auth-identity-invalid/);
});

test("Anthropic helper refuses unrelated routes, terminal token failure and oversized secret responses", async () => {
	const request = makeAuthFetch({ fetch: async () => Response.json({ error: "invalid_grant", payload: "private" }, { status: 400 }) });
	await assert.rejects(request("https://attacker.invalid"), /auth-endpoint-unsupported/);
	await assert.rejects(request("https://platform.claude.com/v1/oauth/token"), /auth-reauth-required/);
	await assert.rejects(readAuthJson(new Response("x".repeat(100)), { maxBytes: 10 }), /auth-response-invalid/);
});

test("secondary native-pi auth is content-pinned and refresh uses injected bounded transport and clock", async () => {
	let body;
	let signal;
	const oauth = loadNativeAnthropicAuth({ now, fetch: async (_url, options) => { body = JSON.parse(options.body); signal = options.signal; return Response.json({ access_token: "sk-ant-oat-new", refresh_token: "rotated", expires_in: 3600 }); } });
	const controller = new AbortController();
	const result = await oauth.refresh({ access: "sk-ant-oat-old", refresh: "old", expires: instant }, controller.signal);
	assert.equal(body.refresh_token, "old");
	assert.equal(result.refresh, "rotated");
	assert.equal(result.expires, instant + 55 * 60_000);
	assert.equal(signal.aborted, false);
	controller.abort();
	assert.equal(signal.aborted, true);
	assert.throws(() => verifyNativeAnthropicAuth({ readFile: () => "changed source" }), /auth-adapter-source-mismatch/);
});
