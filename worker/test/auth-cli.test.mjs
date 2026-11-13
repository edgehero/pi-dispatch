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

// ── issue #867: auth's Valkey client has a command bound, and a Valkey failure is one plain line ─────────────────────

/** The fixture with a client of its own: what it was built with, its listeners, and whether it was asked to QUIT. */
function valkeyFixture(status) {
	const { output, options } = fixture();
	const client = { built: null, listeners: {}, quit: 0, disconnected: 0 };
	options.redisFn = (url, opts) => {
		client.built = { url, opts };
		return { on: (event, fn) => (client.listeners[event] = fn), quit: async () => void client.quit++, disconnect: () => void client.disconnected++ };
	};
	const configure = options.configure;
	options.configure = (...args) => {
		const service = configure(...args);
		service.runtime.status = status(client);
		service.quota.grantOneTrial = async () => status(client)();
		return service;
	};
	options.configFn = () => ({ authConnectionsFile: "/policy.json", valkeyUrl: "redis://127.0.0.1:6379", workerName: "host1" });
	return { output, options, client };
}
const lostAnswer = () => Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", valkeyMayStillRun: true });
const down = "is it running? (`pi-dispatch up` in the deployment folder starts it)";

test("auth's Valkey client has the command bound and an error listener, so an outage prints no stack trace (#867)", async () => {
	const { VALKEY_COMMAND_TIMEOUT_MS } = await import("../src/connection.mjs");
	const { options, client } = valkeyFixture(() => async () => ({ connections: [] }));
	assert.equal(await runAuth(["status"], options), 0);
	assert.deepEqual(client.built, { url: "redis://127.0.0.1:6379", opts: { commandTimeoutMs: VALKEY_COMMAND_TIMEOUT_MS, disconnectTimeoutMs: 0 } });
	assert.equal(typeof client.listeners.error, "function");
	assert.equal(client.quit, 1, "a run Valkey answered still ends with QUIT");
});

test("a Valkey failure in auth is one plain line naming Valkey, by what failed, and exits 1 (#867)", async () => {
	const cases = [
		// A status read whose answer was lost on a Valkey that stopped answering.
		[["status"], () => async () => { throw lostAnswer(); }, `Subscription authentication: Valkey at redis://127.0.0.1:6379 did not answer (Command timed out). Run \`pi-dispatch auth status\` once it answers: ${down}\n`],
		// A client that never connected: the timeout says only that nothing answered, the client's own error says why.
		[["status"], (client) => async () => { client.listeners.error(new Error("nothing answers VALKEY_URL (127.0.0.1:6379), so whose Valkey it is cannot be judged yet")); throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" }); }, `Subscription authentication: Valkey at redis://127.0.0.1:6379 did not answer (nothing answers VALKEY_URL (127.0.0.1:6379), so whose Valkey it is cannot be judged yet). Run \`pi-dispatch auth status\` once it answers: ${down}\n`],
		// After a login, which sends nothing to Valkey: the login finished, and the status read is what failed.
		[["login", "claude"], () => async () => { throw lostAnswer(); }, `Subscription authentication: the login finished, but Valkey at redis://127.0.0.1:6379 did not answer (Command timed out). Run \`pi-dispatch auth status\` once it answers: ${down}\n`],
		// Valkey's own refusal, quoted.
		[["status"], () => async () => { throw Object.assign(new Error("NOPERM User default has no permissions to run the 'get' command"), { name: "ReplyError", command: { name: "get" } }); }, "Subscription authentication: Valkey at redis://127.0.0.1:6379 refused GET (NOPERM User default has no permissions to run the 'get' command).\n"],
	];
	for (const [args, status, line] of cases) {
		const { output, options, client } = valkeyFixture(status);
		assert.equal(await runAuth(args, options), 1, line);
		assert.equal(output.join(""), line);
		assert.deepEqual([client.quit, client.disconnected], [0, 1], "no QUIT to wait out one more bound on a Valkey that stopped answering");
	}
	// A provider's request that timed out is no Valkey failure, whatever its code says.
	const { output, options } = valkeyFixture(() => async () => { throw Object.assign(new Error("connect ETIMEDOUT 203.0.113.9:443"), { code: "ETIMEDOUT" }); });
	assert.equal(await runAuth(["status"], options), 2);
	assert.equal(output.join(""), "Subscription authentication: auth-unavailable. Run auth status on the connection owner host.\n");
});

test("on real clients, auth against a closed port or a Valkey that never answers ends at its bound with the line and no stack trace (#867)", { timeout: 30_000 }, async () => {
	const { spawn } = await import("node:child_process");
	const { createServer } = await import("node:net");
	const sockets = new Set();
	const silent = createServer((s) => (sockets.add(s), s.on("error", () => {}), s.on("data", () => {})));
	await new Promise((r) => silent.listen(0, "127.0.0.1", r));
	const closed = createServer();
	await new Promise((r) => closed.listen(0, "127.0.0.1", r));
	const closedPort = closed.address().port;
	await new Promise((r) => closed.close(r));
	// In a process of its own, since ioredis prints "Unhandled error event" with console.error, which this one shares.
	const script = `
		const { runAuth } = await import(${JSON.stringify(new URL("../src/auth-cli.mjs", import.meta.url).href)});
		const { makeRedisClient } = await import(${JSON.stringify(new URL("../src/connection.mjs", import.meta.url).href)});
		process.exitCode = await runAuth(["status"], {
			configFn: () => ({ authConnectionsFile: "/policy.json", valkeyUrl: process.env.AUTH_TEST_URL, workerName: "h" }),
			configure: ({ redis }) => ({ runtime: { status: async () => { await redis.get("quota"); return { connections: [] }; } } }),
			// runAuth's own bound, made short for the test; a client runAuth asks for without one keeps none.
			redisFn: (url, opts) => makeRedisClient(url, opts?.commandTimeoutMs ? { ...opts, commandTimeoutMs: 400 } : opts),
		});`;
	const run = (url) => new Promise((resolve) => {
		const started = performance.now();
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, AUTH_TEST_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.on("close", (code) => (clearTimeout(killer), resolve({ code, out, took: performance.now() - started })));
	});
	try {
		for (const [url, said] of [[`redis://127.0.0.1:${closedPort}`, `nothing answers VALKEY_URL (127.0.0.1:${closedPort}), so whose Valkey it is cannot be judged yet`], [`redis://127.0.0.1:${silent.address().port}`, "Command timed out"]]) {
			const { code, out, took } = await run(url);
			assert.doesNotMatch(out, /Unhandled error event|\n\s+at /, out);
			assert.equal(out, `Subscription authentication: Valkey at ${url} did not answer (${said}). Run \`pi-dispatch auth status\` once it answers: ${down}\n`);
			assert.equal(code, 1);
			// The bound, plus the time it takes to start a node process and load the worker's modules.
			assert.ok(took < 8000, `${url}: ended at its bound (${Math.round(took)} ms)`);
		}
	} finally {
		for (const s of sockets) s.destroy();
		silent.close();
	}
});

test("auth trial says the grant may or may not have been made only when its compare-and-set was sent and lost its answer (#867)", async () => {
	// The trial reads the quota row (a GET), then writes it with a compare-and-set (EVAL), each through runAuth's client.
	// A GET lost before the write means the write was never sent, so nothing is said of a grant.
	const run = async (lost) => {
		const { output, options } = fixture();
		const sent = [];
		options.redisFn = () => ({
			on() {},
			quit: async () => {},
			disconnect() {},
			get: async () => { sent.push("GET"); if (lost === "GET") throw lostAnswer(); return null; },
			eval: async () => { sent.push("EVAL"); if (lost === "EVAL") throw lostAnswer(); return 1; },
		});
		options.configFn = () => ({ authConnectionsFile: "/policy.json", valkeyUrl: "redis://127.0.0.1:6379", workerName: "host1" });
		const configure = options.configure;
		options.configure = ({ redis, ...rest }) => {
			const service = configure({ redis, ...rest });
			service.quota.read = async () => (await redis.get("quota"), { version: 3 });
			service.quota.grantOneTrial = async () => ((await redis.eval("cas", 1, "quota")), { ok: true });
			return service;
		};
		const code = await runAuth(["trial", "claude"], options);
		return { code, said: output.join(""), sent };
	};
	assert.deepEqual(await run("GET"), { code: 1, said: `Subscription authentication: Valkey at redis://127.0.0.1:6379 did not answer (Command timed out). Run \`pi-dispatch auth status\` once it answers: ${down}\n`, sent: ["GET"] });
	assert.deepEqual(await run("EVAL"), { code: 1, said: `Subscription authentication: Valkey at redis://127.0.0.1:6379 did not answer (Command timed out). The trial grant may or may not have been made. Run \`pi-dispatch auth status\` once it answers: ${down}\n`, sent: ["GET", "EVAL"] });
	// Both answered: the trial is granted, and nothing is said of Valkey.
	assert.deepEqual(await run(null), { code: 0, said: (await run(null)).said, sent: ["GET", "EVAL"] });
	assert.doesNotMatch((await run(null)).said, /Valkey/);
});

test("auth logout keeps its evidence on a Valkey failure, says Valkey's line, and does not wait out a QUIT (#867)", async () => {
	const { output, options, client } = valkeyFixture(() => async () => { throw lostAnswer(); });
	assert.equal(await runAuth(["logout", "claude"], options), 0, "the logout itself is done");
	const [line, ...json] = output;
	assert.equal(line, `Subscription authentication: the logout finished, but Valkey at redis://127.0.0.1:6379 did not answer (Command timed out). Run \`pi-dispatch auth status\` once it answers: ${down}\n`);
	assert.deepEqual(JSON.parse(json.join("")).logout, { id: "claude", state: "disconnected", remoteRevocationConfirmed: false });
	assert.deepEqual([client.quit, client.disconnected], [0, 1]);
});

test("auth's line quotes no outage that ended before it: the client's error is forgotten when it goes ready (#867)", async () => {
	const { output, options } = valkeyFixture((client) => async () => {
		client.listeners.error(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
		client.listeners.ready();
		throw lostAnswer();
	});
	assert.equal(await runAuth(["status"], options), 1);
	assert.equal(output.join(""), `Subscription authentication: Valkey at redis://127.0.0.1:6379 did not answer (Command timed out). Run \`pi-dispatch auth status\` once it answers: ${down}\n`);
});
