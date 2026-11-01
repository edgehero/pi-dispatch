import assert from "node:assert/strict";
import { test } from "node:test";
import { runAuth, authSelectAnswer } from "../src/auth-cli.mjs";
import { loadNativeAnthropicAuth } from "../src/community-auth-helper.mjs";
import { OPENAI_LOGIN_INSTRUCTIONS } from "../src/oauth-openai.mjs";

function fixture() {
	const calls = [];
	const output = [];
	const row = { id: "claude", provider: "anthropic", ownerHost: "host1", active: true, accountGroup: "private-group", generation: 1 };
	const service = { auth: { login: async (id) => (calls.push(["login", id]), { credential: "private-token" }), logout: async (id) => calls.push(["logout", id]), status: async () => [row] }, runtime: { status: async () => ({ connections: [row] }), usage: async (id) => (calls.push(["usage", id]), { kind: "unavailable", reason: "auth-usage-unsupported" }) }, quota: { read: async () => ({ version: 3 }), grantOneTrial: async (...args) => (calls.push(["trial", ...args]), { ok: true }) } };
	const options = { write: (value) => output.push(value), writeErr: (value) => output.push(value), configure: () => service, configFn: () => ({ authConnectionsFile: "/policy.json", valkeyUrl: "redis://localhost", workerName: "host1" }), redisFn: () => ({ quit: async () => calls.push(["quit"]) }), interaction: { prompt() {}, notify() {} } };
	return { calls, output, options };
}
test("host login is real lifecycle dispatch, while its output contains only safe status", async () => {
	const { options, calls, output } = fixture();
	assert.equal(await runAuth(["login", "claude"], options), 0);
	assert.deepEqual(calls, [["login", "claude"], ["quit"]]);
	assert.doesNotMatch(output.join(""), /private-token|private-group|generation/);
	assert.match(output.join(""), /claude/);
});
test("only the explicit host trial command supplies person authority and the read state version", async () => {
	const { options, calls } = fixture();
	assert.equal(await runAuth(["trial", "claude"], options), 0);
	assert.equal(calls[0][0], "trial");
	assert.deepEqual(calls[0][2], { expectedVersion: 3, actorKind: "person" });
});
test("unknown actions cannot reach authentication and unsupported usage is reported as unavailable", async () => {
	const { options, calls } = fixture();
	assert.equal(await runAuth(["refresh", "claude"], options), 2);
	assert.deepEqual(calls, []);
	assert.equal(await runAuth(["usage", "claude"], options), 2);
	assert.deepEqual(calls, [["usage", "claude"], ["quit"]]);
});

test("the OpenAI terminal login prints fixed remote-callback guidance without copying adapter instruction text", async () => {
	const { options, output } = fixture();
	const service = options.configure();
	const opened = [];
	service.auth.login = async (_id, { interaction }) => {
		interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?state=ephemeral", instructions: "private-adapter-instruction-canary" });
		interaction.notify({ type: "auth_url", url: "https://auth.openai.com.example.invalid/authorize", instructions: "another-private-canary" });
	};
	assert.equal(await runAuth(["login", "chatgpt"], { ...options, configure: () => service, interaction: null, openBrowserFn: url => opened.push(url) }), 0);
	assert.equal(output.filter(line => line.includes(OPENAI_LOGIN_INSTRUCTIONS)).length, 1);
	assert.match(output.join(""), /forward port 1455 to 127\.0\.0\.1:1455/);
	assert.match(output.join(""), /http:\/\/127\.0\.0\.1:1455\/auth\/callback/);
	assert.doesNotMatch(output.join(""), /private-adapter-instruction-canary|another-private-canary/);
	assert.equal(opened.length, 2);
});

test("terminal selection accepts native IDs and legacy values, rejecting every unoffered answer", () => {
	const native = { options: [{ id: "browser", label: "Browser" }, { id: "copy_code", label: "Copy code" }] };
	assert.equal(authSelectAnswer(native, "1"), "browser");
	assert.equal(authSelectAnswer(native, "2"), "copy_code");
	assert.equal(authSelectAnswer(native, "copy_code"), "copy_code");
	assert.equal(authSelectAnswer({ options: [{ value: "legacy" }] }, "1"), "legacy");
	for (const answer of ["0", "3", "999999999999999999999", "1.5", "", "private-sentinel"]) assert.throws(() => authSelectAnswer(native, answer), (error) => error.code === "auth-selection-invalid" && !error.message.includes(answer || "sentinel"));
	for (const options of [[], [{}], [{ id: false }]]) assert.throws(() => authSelectAnswer({ options }, "1"), /auth-selection-invalid/);
});

test("actual pinned native Anthropic login accepts terminal choice 2 and completes copy-code exchange", async () => {
	const instant = 1_800_000_000_000;
	let authorization, request, selectCount = 0;
	const oauth = loadNativeAnthropicAuth({ now: () => instant, fetch: async (url, options) => {
		assert.equal(url, "https://platform.claude.com/v1/oauth/token");
		request = JSON.parse(options.body);
		return Response.json({ access_token: "sk-ant-oat-terminal-fixture", refresh_token: "rotated-fixture", expires_in: 3600 });
	} });
	const { options, output } = fixture();
	const result = await runAuth(["login", "claude"], {
		...options, interaction: null, terminalInput: { isTTY: true }, terminalOutput: {},
		openBrowserFn(url) { authorization = new URL(url); },
		createPrompt() { return { async question() { selectCount++; return authorization ? `fixture-code#${authorization.searchParams.get("state")}` : "2"; }, close() {} }; },
		configure: () => ({ auth: { login: async (_id, { interaction, signal }) => {
			const credential = await oauth.login({ ...interaction, signal });
			assert.equal(credential.access, "sk-ant-oat-terminal-fixture");
			assert.equal(credential.expires, instant + 55 * 60_000);
		} }, runtime: { status: async () => ({ state: "ready", connections: [] }) } }),
	});
	assert.equal(result, 0);
	assert.match(output.join(""), /1\. Browser login \(default\)/);
	assert.match(output.join(""), /2\. Copy code login \(headless\)/);
	assert.doesNotMatch(output.join(""), /sk-ant-oat-terminal-fixture|rotated-fixture/);
	assert.equal(selectCount, 2);
	assert.equal(request.grant_type, "authorization_code");
	assert.equal(request.code, "fixture-code");
	assert.equal(request.redirect_uri, "https://platform.claude.com/oauth/code/callback");
});

test("logout reports remote revocation separately from local disconnected status", async () => {
	for (const confirmed of [true, false]) {
		const { options, output } = fixture();
		const configure = options.configure;
		options.configure = (...args) => {
			const service = configure(...args);
			service.auth.logout = async () => ({ id: "claude", state: "disconnected", remoteRevocationConfirmed: confirmed });
			return service;
		};
		assert.equal(await runAuth(["logout", "claude"], options), 0);
		const value = JSON.parse(output.join(""));
		assert.deepEqual(value.logout, { id: "claude", state: "disconnected", remoteRevocationConfirmed: confirmed });
		assert.doesNotMatch(output.join(""), /private-token|private-group|credential/);
	}
});

test("a failed quota-status read cannot erase completed local logout evidence", async () => {
	const { options, output } = fixture();
	const configure = options.configure;
	options.configure = (...args) => {
		const service = configure(...args);
		service.runtime.status = async () => { throw new Error("private status diagnostic"); };
		return service;
	};
	assert.equal(await runAuth(["logout", "claude"], options), 0);
	const value = JSON.parse(output.join(""));
	assert.equal(value.logout.state, "disconnected");
	assert.equal(value.logout.remoteRevocationConfirmed, false);
	assert.equal(value.partial, true);
	assert.doesNotMatch(output.join(""), /private status diagnostic|private-group/);
});
