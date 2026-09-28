import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { authRefusalFor, judgeValkeyAtStart, makeRedisClient, parseConnection, valkeyAuthState } from "../src/connection.mjs";
import { readEnvAssignments, renderEnvValue, updateEnvFile } from "../src/env-file.mjs";
import { readValkeyKeys } from "../src/podman-stack.mjs";
import { refuseValkeyAuth } from "../src/start.mjs";
import { DEPLOYMENT_LABEL, OWNER_MARKER_KEY, valkeyVolumeCreateArgs, valkeyVolumeOwner, VALKEY_HEALTH_SCRIPT, VALKEY_PASSWORD_KEY, VALKEY_PORT_KEY, VALKEY_START_SCRIPT, VALKEY_VOLUME, composeHandoverPlan, dollarsDoubled, foreignVolumeUsers, valkeyContainerIsOurs, valkeyContainerOwner, valkeyPortEnvDecision, isLoopbackHost, managedValkeyUrl, newValkeyPassword, valkeyAuthRefusal, valkeyDockerRunArgs, valkeyEnvFileText, valkeyPasswordDecision, valkeyPasswordProblem } from "../src/valkey-auth.mjs";
import { defaultValkeyContext, useValkeyContext, valkeyClientContext, valkeyContextFromKeys, valkeyPasswordFor } from "../src/valkey-endpoint.mjs";

// Issue #468: the Valkey pi-dispatch starts gets a per-deployment password. Every rule here is one an account on the same
// host would otherwise walk through: read, enqueue or delete another account's jobs.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PW = "0123456789abcdef".repeat(4);
const ctx = (password = {}, over = {}) => ({ envPath: "/d/.env", shared: false, rootRefused: false, error: null, password: { environment: null, file: null, ...password }, ...over });

test("a generated password is 64 hex characters that every .env loader reads back byte for byte (#468)", () => {
	const seen = new Set();
	for (let i = 0; i < 50; i++) {
		const pw = newValkeyPassword();
		assert.match(pw, /^[0-9a-f]{64}$/);
		assert.equal(valkeyPasswordProblem(pw), null);
		seen.add(pw);
		// The writer renders it bare (nothing to quote), and systemd, a sourcing shell and the cmd wrapper all read the same.
		assert.equal(renderEnvValue(pw, { platform: "linux" }), pw);
		for (const loader of ["systemd", "shell", "cmd"]) {
			const read = readEnvAssignments(`A=1\n${VALKEY_PASSWORD_KEY}=${pw}\n`, [VALKEY_PASSWORD_KEY], { loader })[VALKEY_PASSWORD_KEY];
			assert.deepEqual([read.plain, read.value], [true, pw], loader);
		}
		assert.deepEqual(readValkeyKeys(Buffer.from(`${VALKEY_PASSWORD_KEY}=${pw}\n`)).keys, { [VALKEY_PASSWORD_KEY]: pw }, "the hardened reader every client uses");
	}
	assert.equal(seen.size, 50, "random, not a constant");
	assert.equal(newValkeyPassword(() => Buffer.alloc(32, 0xab)), "ab".repeat(32), "the randomness is the one seam");
});

test("a password the start script could not hand to Valkey is refused, with the way to make one (#468)", () => {
	for (const ok of [PW, "A-Za_z0123456789", "x".repeat(512)]) assert.equal(valkeyPasswordProblem(ok), null, ok);
	for (const [bad, why] of [["", /empty/], ["has space inside it", /character other than/], ['quote"d-0123456789', /character other than/], ["hash#0123456789abc", /character other than/], ["short", /at least 16/], ["x".repeat(513), /over the 512/], ["dollar$0123456789ab", /character other than/]]) {
		assert.match(valkeyPasswordProblem(bad), why, bad);
	}
	const decided = valkeyPasswordDecision({ VALKEY_PASSWORD: "bad value here!" }, { envPath: "/d/.env" });
	assert.match(decided.error, /^VALKEY_PASSWORD in \/d\/\.env cannot be handed to Valkey: .*`openssl rand -hex 32`/);
	assert.ok(!decided.error.includes("bad value here!"), "the value is never quoted back");
});

test("valkeyPasswordDecision: kept when set, generated only for this machine's own Valkey, never for a shared or an operator's one (#468)", () => {
	assert.deepEqual(valkeyPasswordDecision({ VALKEY_PASSWORD: PW }), { password: PW, generate: false, note: null }, "never replaced");
	assert.deepEqual(valkeyPasswordDecision({}), { password: null, generate: true, note: null }, "unset VALKEY_URL is 127.0.0.1");
	assert.equal(valkeyPasswordDecision({ VALKEY_PASSWORD: "" }).generate, true, "an empty line is filled, as WEBHOOK_SECRET's is");
	for (const url of ["redis://127.0.0.1:6380", "redis://localhost:6379", "redis://[::1]:6379"]) assert.equal(valkeyPasswordDecision({ VALKEY_URL: url }).generate, true, url);
	const shared = valkeyPasswordDecision({ PI_VALKEY_SHARED: "1" }, { envPath: "/d/.env" });
	assert.deepEqual([shared.generate, shared.password], [false, null]);
	assert.match(shared.note, /PI_VALKEY_SHARED=1 in \/d\/\.env: no VALKEY_PASSWORD is generated, since the shared Valkey is another account's\. Put that Valkey's password in VALKEY_PASSWORD/);
	for (const url of ["redis://queue.lan:6379", "rediss://managed.example:6380", "redis://:secret@127.0.0.1:6379", "redis://user:pw@localhost:6379", "not a url"]) {
		const d = valkeyPasswordDecision({ VALKEY_URL: url });
		assert.deepEqual([d.generate, d.password], [false, null], url);
	}
	assert.equal(managedValkeyUrl(undefined), true);
	for (const h of ["127.0.0.1", "127.9.9.9", "localhost", "LOCALHOST", "::1", "[::1]", "0.0.0.0", "::", "::ffff:127.0.0.1"]) assert.equal(isLoopbackHost(h), true, h);
	for (const h of ["10.0.0.5", "valkey", "queue.lan", "128.0.0.1", "::2", "localhost.example"]) assert.equal(isLoopbackHost(h), false, h);
});

// ---------------------------------------------------------------------------------------------------------------------
// The one start script, in three carriers, and never on a command line
// ---------------------------------------------------------------------------------------------------------------------

const quadlet = readFileSync(join(REPO, "deploy", "pi-dispatch-valkey.container"), "utf8");
const compose = readFileSync(join(REPO, "deploy", "docker-compose.yml"), "utf8");
const undoubled = (s) => s.replaceAll("$$", "$");

test("the Quadlet unit, the compose file and `up`'s docker run carry the ONE start script and health check, the password in the environment only (#468)", () => {
	// Quadlet: Exec=sh -c '<script>' with every $ doubled for systemd, and the 0600 file the password comes from.
	const exec = /^Exec=sh -c '(.*)'$/m.exec(quadlet);
	assert.ok(exec, "the Exec= line");
	assert.equal(undoubled(exec[1]), VALKEY_START_SCRIPT);
	assert.equal(exec[1], dollarsDoubled(VALKEY_START_SCRIPT));
	assert.doesNotMatch(exec[1].replaceAll("$$", ""), /\$/, "no single $ systemd would expand (with the password loaded into the unit's environment)");
	assert.equal(undoubled(/^HealthCmd=(.*)$/m.exec(quadlet)[1]), VALKEY_HEALTH_SCRIPT);
	assert.doesNotMatch(/^HealthCmd=(.*)$/m.exec(quadlet)[1].replaceAll("$$", ""), /\$/);
	assert.match(quadlet, /^EnvironmentFile=%h\/\.config\/pi-dispatch\/valkey\.env$/m);
	// compose: the same, `$$` being compose's escape, and the value interpolated from --env-file .env into the environment.
	const cmd = /^ {4}command: \["sh", "-c", '(.*)'\]$/m.exec(compose);
	assert.ok(cmd, "the command: line");
	assert.equal(undoubled(cmd[1]), VALKEY_START_SCRIPT);
	assert.equal(undoubled(/^ {6}test: \["CMD-SHELL", '(.*)'\]$/m.exec(compose.slice(compose.indexOf("  valkey:")))[1]), VALKEY_HEALTH_SCRIPT);
	assert.match(compose, /^ {4}environment:\n {6}VALKEY_PASSWORD: \$\{VALKEY_PASSWORD:-\}$/m);
	// PR #475's review, round 2: published on VALKEY_URL's port, through the one variable up and the wizard set.
	assert.match(compose, new RegExp(`^ {6}- "127\\.0\\.0\\.1:\\$\\{${VALKEY_PORT_KEY}:-6379\\}:6379"$`, "m"));
	assert.equal(VALKEY_PORT_KEY, "PI_VALKEY_PORT");
	// docker run: `-e VALKEY_PASSWORD` names the variable, and the value is in no argv position.
	const argv = valkeyDockerRunArgs();
	assert.deepEqual(argv.slice(argv.indexOf("-e"), argv.indexOf("-e") + 2), ["-e", "VALKEY_PASSWORD"]);
	assert.deepEqual(argv.slice(-3), ["sh", "-c", VALKEY_START_SCRIPT]);
	assert.equal(argv[argv.indexOf("--health-cmd") + 1], VALKEY_HEALTH_SCRIPT);
	// And the three things no carrier may do: a password on a command line, a systemd specifier, a quote or escape a
	// carrier would read differently.
	for (const [where, text] of [["Quadlet", quadlet], ["compose", compose], ["docker run", argv.join(" ")]]) {
		assert.doesNotMatch(text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"), /requirepass\s+[^$"\s]|--requirepass|VALKEY_EXTRA_FLAGS/, where);
	}
	for (const script of [VALKEY_START_SCRIPT, VALKEY_HEALTH_SCRIPT]) assert.doesNotMatch(script, /[%\\']/, "no %, backslash or single quote: each carrier would read one differently");
	assert.ok(existsSync(join(REPO, "worker", "deploy", "pi-dispatch-valkey.container")), "the published mirror (publish.test.mjs holds it byte-identical)");
	assert.equal(valkeyEnvFileText(PW).split("\n").filter((l) => !l.startsWith("#")).join("\n"), `VALKEY_PASSWORD=${PW}\n`);
	assert.match(valkeyEnvFileText(null), /^VALKEY_PASSWORD=$/m, "no password: an empty value, which starts Valkey without one");
});

// The script runs under the IMAGE's /bin/sh, which is dash (measured: valkey/valkey:8 is Debian). Run it under each POSIX
// shell this host has, dash among them where installed (CI's /bin/sh is dash), with a stand-in for the image's entrypoint
// that records its argv and what it reads on stdin.
const SHELLS = ["/bin/sh", "/bin/dash", "/usr/bin/dash", "/bin/bash"].filter((s) => existsSync(s));

test("the start script hands the password to valkey-server as config on stdin, never on its argv, and unsets it; with none it starts without (#468)", { skip: process.platform === "win32" }, () => {
	assert.ok(SHELLS.length > 0);
	for (const sh of SHELLS) {
		const dir = tempDir("valkey-start-");
		const record = join(dir, "record");
		// The image's entrypoint, stood in for: its argv, its stdin (the config), and whether VALKEY_PASSWORD is still set.
		writeFileSync(join(dir, "docker-entrypoint.sh"), `#!/bin/sh\nprintf 'argv:%s\\n' "$*" > "${record}"\nprintf 'env:%s\\n' "\${VALKEY_PASSWORD-unset}" >> "${record}"\nprintf 'stdin:' >> "${record}"\ncat >> "${record}"\n`);
		chmodSync(join(dir, "docker-entrypoint.sh"), 0o755);
		const env = { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: dir, VALKEY_PASSWORD: PW };
		execFileSync(sh, ["-c", VALKEY_START_SCRIPT], { env, stdio: ["ignore", "ignore", "pipe"] });
		const got = readFileSync(record, "utf8");
		assert.match(got, /^argv:valkey-server - --appendonly yes$/m, `${sh}: config from stdin ("-"), AOF on`);
		assert.ok(!/^argv:.*0123456789abcdef/m.test(got), `${sh}: the password is on no argv`);
		assert.match(got, /^env:unset$/m, `${sh}: unset before valkey-server starts`);
		assert.match(got, new RegExp(`^stdin:requirepass ${PW}$`, "m"), `${sh}: one requirepass line on stdin`);
		assert.deepEqual(execFileSync("ls", ["-A", dir], { encoding: "utf8" }).trim().split("\n").sort(), ["docker-entrypoint.sh", "record"], `${sh}: the temp file is deleted before the entrypoint runs`);
		// No password (an older .env): no requirepass, no stdin config, the plain AOF command, as before.
		for (const value of ["", undefined]) {
			const e = { PATH: env.PATH, TMPDIR: dir, ...(value === undefined ? {} : { VALKEY_PASSWORD: value }) };
			execFileSync(sh, ["-c", VALKEY_START_SCRIPT], { env: e, stdio: ["ignore", "ignore", "pipe"] });
			const none = readFileSync(record, "utf8");
			assert.match(none, /^argv:valkey-server --appendonly yes$/m, `${sh} VALKEY_PASSWORD=${JSON.stringify(value)}`);
			assert.match(none, /^stdin:$/m);
		}
	}
});

test("the health check is healthy only on PONG, with the password from the environment (#468)", { skip: process.platform === "win32" }, () => {
	for (const sh of SHELLS) {
		const dir = tempDir("valkey-health-");
		// A valkey-cli that answers as the measured one does: NOAUTH (exit 0) without the right REDISCLI_AUTH, PONG with it.
		writeFileSync(join(dir, "valkey-cli"), `#!/bin/sh\nif [ "\${REDISCLI_AUTH-}" = "${PW}" ] || [ -z "\${WANT-}" ]; then echo PONG; else echo "NOAUTH Authentication required."; fi\nexit 0\n`);
		chmodSync(join(dir, "valkey-cli"), 0o755);
		const run = (env) => spawnSync(sh, ["-c", VALKEY_HEALTH_SCRIPT], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env } }).status;
		assert.equal(run({ WANT: "1", VALKEY_PASSWORD: PW }), 0, `${sh}: the password reaches valkey-cli`);
		assert.equal(run({ WANT: "1", VALKEY_PASSWORD: "" }), 1, `${sh}: NOAUTH is unhealthy, although valkey-cli exits 0 on it`);
		assert.equal(run({ VALKEY_PASSWORD: "" }), 0, `${sh}: a Valkey with no password is healthy without one`);
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Every client sends it, from ONE function
// ---------------------------------------------------------------------------------------------------------------------

test("parseConnection sends the URL's own password first, then VALKEY_PASSWORD from the environment, then the .env's for a loopback host only (#468)", () => {
	const both = ctx({ environment: "E".repeat(20), file: "F".repeat(20) });
	assert.equal(parseConnection("redis://:p%40ss%2Fw0rd@127.0.0.1:6379", { context: both }).password, "p@ss/w0rd", "an operator's own URL password wins, percent-decoded");
	assert.equal(parseConnection("redis://u%3An:x@127.0.0.1:6379", { context: both }).username, "u:n");
	assert.equal(parseConnection("redis://127.0.0.1:6379", { context: both }).password, "E".repeat(20), "the environment (the service's loader) next");
	assert.equal(parseConnection("redis://valkey:6379", { context: both }).password, "E".repeat(20), "for any host: compose's receiver dials valkey:6379");
	const fileOnly = ctx({ file: "F".repeat(20) });
	for (const url of ["redis://127.0.0.1:6379", "redis://localhost:6380", "redis://[::1]:6379"]) assert.equal(parseConnection(url, { context: fileOnly }).password, "F".repeat(20), url);
	for (const url of ["redis://queue.lan:6379", "rediss://managed.example:6380"]) assert.equal(parseConnection(url, { context: fileOnly }).password, undefined, `${url}: the .env's password never leaves this machine`);
	assert.equal(parseConnection("redis://127.0.0.1:6379", { context: ctx() }).password, undefined, "none configured: no AUTH, as before");
	assert.equal(parseConnection("redis://:x@127.0.0.1:6379", { context: both, withoutPassword: true }).password, undefined, "a probe asks as a client that sends none");
	assert.deepEqual(valkeyPasswordFor("redis://127.0.0.1:6379", fileOnly), { password: "F".repeat(20), from: "/d/.env" });
	assert.deepEqual(valkeyPasswordFor("redis://127.0.0.1:6379", ctx({ environment: "E".repeat(20) })), { password: "E".repeat(20), from: "the environment" });
	assert.deepEqual(valkeyPasswordFor("redis://:u@127.0.0.1:6379", fileOnly), { password: "u", from: "VALKEY_URL" });
});

test("valkeyClientContext reads VALKEY_PASSWORD from the environment and the deployment .env, and a process may install its own default context (#468)", () => {
	const dir = tempDir("valkey-ctx-");
	writeFileSync(join(dir, ".env"), `VALKEY_URL=redis://127.0.0.1:6379\n${VALKEY_PASSWORD_KEY}=${PW}\n`);
	assert.deepEqual(valkeyClientContext({ env: {}, cwd: dir }).password, { environment: null, file: PW });
	assert.deepEqual(valkeyClientContext({ env: { VALKEY_PASSWORD: "E".repeat(20) }, cwd: dir }).password, { environment: "E".repeat(20), file: PW });
	assert.deepEqual(valkeyClientContext({ env: { VALKEY_PASSWORD: "" }, cwd: tempDir("valkey-ctx-none-") }).password, { environment: null, file: null }, "empty is unset");
	// The admin panel runs wherever pi was started, and installs the context its own one `.env` reader built (issue #471's
	// `readDeploymentEnv`, the pointer's folder); a client with no context of its own gets it, and no file is read here.
	const built = valkeyContextFromKeys({ env: {}, envPath: "/pointed/.env", fileKeys: { [VALKEY_PASSWORD_KEY]: PW, VALKEY_URL: "redis://127.0.0.1:6379" } });
	useValkeyContext(() => built);
	try {
		assert.equal(defaultValkeyContext(), built);
		assert.equal(parseConnection("redis://127.0.0.1:6379").password, PW, "a client with no context sends the installed one's");
	} finally {
		useValkeyContext(null);
	}
	assert.equal(defaultValkeyContext().envPath, join(process.cwd(), ".env"), "removed: the working directory again");
	assert.deepEqual(valkeyContextFromKeys({ env: {}, fileKeys: { PI_VALKEY_SHARED: "1", PI_BACKENDS: "podman" }, platform: "linux" }).shared, true);
	// A password line the loaders read differently is an error, never a silently missing password.
	writeFileSync(join(dir, ".env"), `${VALKEY_PASSWORD_KEY}="a b\n`);
	const broken = valkeyClientContext({ env: {}, cwd: dir });
	assert.match(broken.error, /\.env/);
	assert.equal(broken.password.file, null);
});

// A Valkey stand-in that speaks enough RESP for ioredis: requirepass `password` (null: none), AUTH, INFO, PING.
function fakeValkey(password) {
	const sockets = new Set();
	const server = createServer((sock) => {
		sockets.add(sock);
		sock.on("close", () => sockets.delete(sock));
		let authed = server.password === null;
		let buf = Buffer.alloc(0);
		sock.on("error", () => {});
		sock.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			for (;;) {
				const parsed = parseResp(buf);
				if (!parsed) break;
				buf = buf.subarray(parsed.used);
				const [cmd, ...args] = parsed.args;
				const c = String(cmd).toUpperCase();
				if (c === "AUTH") {
					if (server.password === null) sock.write("-ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?\r\n");
					else if (args.at(-1) === server.password) {
						authed = true;
						sock.write("+OK\r\n");
					} else sock.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
				} else if (!authed) sock.write("-NOAUTH Authentication required.\r\n");
				else if (c === "PING") sock.write("+PONG\r\n");
				else if (c === "BADCMD") sock.write(`-ERR unknown command '${cmd}'\r\n`);
				else if (c === "INFO") {
					const body = "# Server\r\nredis_version:8.1.10\r\nloading:0\r\n";
					sock.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
				} else sock.write("+OK\r\n");
			}
		});
	});
	server.password = password;
	// A rotation, as `CONFIG SET requirepass` and `CLIENT KILL` make one: a new password, and every connection dropped.
	const rotate = (next) => {
		server.password = next;
		for (const sk of sockets) sk.destroy();
	};
	return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port, rotate })));
}
function parseResp(buf) {
	const s = buf.toString("latin1");
	if (!s.startsWith("*")) return null;
	let at = s.indexOf("\r\n");
	if (at < 0) return null;
	const n = Number(s.slice(1, at));
	let pos = at + 2;
	const args = [];
	for (let i = 0; i < n; i++) {
		at = s.indexOf("\r\n", pos);
		if (at < 0) return null;
		const len = Number(s.slice(pos + 1, at));
		pos = at + 2;
		if (s.length < pos + len + 2) return null;
		args.push(s.slice(pos, pos + len));
		pos += len + 2;
	}
	return { args, used: pos };
}
const pinnedTo = () => (url, opts) => makeRedisClient(url, { ...opts, judge: async () => ({ host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }) });

test("valkeyAuthState tells a Valkey that accepts this client from one that requires a password (NOAUTH) or refuses it (WRONGPASS), and never says the value (#468)", { timeout: 30_000 }, async () => {
	const withPw = await fakeValkey(PW);
	const open = await fakeValkey(null);
	try {
		const url = `redis://127.0.0.1:${withPw.port}`;
		const makeClient = pinnedTo(withPw.port);
		assert.deepEqual(await valkeyAuthState(url, { context: ctx({ environment: PW }), makeClient }), { state: "ok" });
		assert.deepEqual(await valkeyAuthState(url, { context: ctx(), makeClient }), { state: "noauth" });
		assert.deepEqual(await valkeyAuthState(url, { context: ctx({ environment: "W".repeat(20) }), makeClient }), { state: "wrongpass" });
		assert.deepEqual(await valkeyAuthState(url, { context: ctx({ environment: PW }), makeClient, withoutPassword: true }), { state: "noauth" }, "asked as a client with none, the way another account would");
		// A Valkey with no password (an older deployment) keeps working for a client that has one: ioredis takes the
		// server's "without any password configured" as a warning, not a failure.
		const openUrl = `redis://127.0.0.1:${open.port}`;
		assert.deepEqual(await valkeyAuthState(openUrl, { context: ctx({ environment: PW }), makeClient: pinnedTo(open.port) }), { state: "ok" });
		assert.deepEqual(await valkeyAuthState(openUrl, { context: ctx(), makeClient: pinnedTo(open.port), withoutPassword: true }), { state: "ok" }, "any local account's view of it");
		const closed = await valkeyAuthState("redis://127.0.0.1:1", { context: ctx(), makeClient: pinnedTo(1), timeoutMs: 4000 });
		assert.equal(closed.state, "unreachable");
	} finally {
		withPw.server.close();
		open.server.close();
	}
});

test("a client refused for its password is a configError naming VALKEY_PASSWORD and where it is set, never the value, at every start (#468)", async () => {
	const url = "redis://127.0.0.1:6379";
	const endpoint = { host: "127.0.0.1", servername: null, pinned: "127.0.0.1" };
	const judge = async () => endpoint;
	// No password configured, one required: the refusal B (sharing A's Valkey without its password) meets.
	await assert.rejects(judgeValkeyAtStart(url, ctx(), { judge, checkAuth: async () => ({ state: "noauth" }) }), (err) => {
		assert.equal(err.piDispatchConfig, true, "exit 2, never restarted into the same answer");
		assert.equal(err.valkeyRefused, true);
		assert.match(err.message, /^the Valkey VALKEY_URL reaches requires a password, and this deployment sets none: put VALKEY_PASSWORD=<that Valkey's password> in \/d\/\.env \(a Valkey shared with PI_VALKEY_SHARED=1 takes the password of the account that runs it\)$/);
		return true;
	});
	await assert.rejects(judgeValkeyAtStart(url, ctx({ file: PW }), { judge, checkAuth: async () => ({ state: "wrongpass" }) }), (err) => {
		assert.match(err.message, /refused VALKEY_PASSWORD from \/d\/\.env \(WRONGPASS\): it is not that Valkey's password/);
		assert.ok(!err.message.includes(PW), "never the value");
		return true;
	});
	assert.equal(await judgeValkeyAtStart(url, ctx(), { judge, checkAuth: async () => ({ state: "ok" }) }), endpoint);
	assert.equal(await judgeValkeyAtStart(url, ctx(), { judge, checkAuth: async () => ({ state: "unreachable" }) }), endpoint, "nothing answering is the command's own connect error, not a refusal");
	let asked = 0;
	assert.equal(await judgeValkeyAtStart(url, ctx(), { judge, checkAuth: undefined }), endpoint);
	assert.equal(await judgeValkeyAtStart(url, ctx(), { judge: async () => (asked++, endpoint) }), endpoint, "a caller that stands in for the host asks no Valkey");
	assert.equal(asked, 1);
	// The worker's boot: the same refusal as a configError, from its judged address and its own context.
	await assert.rejects(refuseValkeyAuth({ url, servername: null, rootRefused: false }, {}, { cwd: tempDir("boot-"), authState: async () => ({ state: "noauth" }) }), (err) => err.piDispatchConfig === true && /requires a password, and this deployment sets none/.test(err.message));
	await refuseValkeyAuth({ url, servername: null, rootRefused: false }, {}, { cwd: tempDir("boot-"), authState: async () => ({ state: "ok" }) });
	assert.equal(authRefusalFor("wrongpass", "redis://:x@127.0.0.1:6379", ctx()).includes("the password in VALKEY_URL"), true);
	assert.equal(valkeyAuthRefusal(new Error("ECONNREFUSED"), { passwordSet: false }), null, "only a credential refusal is one");
});

test("against a real Valkey with no password, a client that sends one still works (the upgrade's first half) (#468)", { timeout: 20_000 }, async (t) => {
	const url = process.env.VALKEY_TEST_URL;
	if (!url) return t.skip("needs a Valkey (VALKEY_TEST_URL); CI runs it");
	const { hostname } = new URL(url);
	const makeClient = (u, opts) => makeRedisClient(u, { ...opts, judge: async () => ({ host: hostname, servername: null, pinned: hostname }) });
	assert.deepEqual(await valkeyAuthState(url, { context: ctx({ environment: PW }), makeClient }), { state: "ok" });
	assert.deepEqual(await valkeyAuthState(url, { context: ctx(), makeClient, withoutPassword: true }), { state: "ok" }, "and it answers a client that sends none, which doctor warns about");
});

test("updateEnvFile narrow: the password lands only in a file its owner alone can read, and the tmp is never wider (#468)", { skip: process.platform === "win32" }, () => {
	const dir = tempDir("narrow-");
	const path = join(dir, ".env");
	writeFileSync(path, "A=1\n", { mode: 0o644 });
	chmodSync(path, 0o644);
	const created = [];
	const realFs = { readFileSync, writeFileSync: (p, d, o) => (created.push([p, o?.mode]), writeFileSync(p, d, o)), renameSync, statSync, chmodSync, realpathSync };
	assert.deepEqual(updateEnvFile(path, VALKEY_PASSWORD_KEY, PW, { fs: realFs, platform: "linux", narrow: true }), { changed: true, narrowed: true });
	assert.equal(readFileSync(path, "utf8"), `A=1\n${VALKEY_PASSWORD_KEY}=${PW}\n`);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(created, [[`${realpathSync(path)}.tmp`, 0o600]], "the tmp is created 0600, never at the umask");
	// Without `narrow` the operator's mode is kept, as before (only the tmp is created 0600 now).
	writeFileSync(path, "B=1\n");
	chmodSync(path, 0o640);
	updateEnvFile(path, "C", "x", { fs: realFs, platform: "linux" });
	assert.equal(statSync(path).mode & 0o777, 0o640);
});

// PR #475's review: after a rotation, a client still sending the old password gets WRONGPASS, and ioredis hangs the
// AUTH command, its args the password, on that error. A BullMQ Queue with no `error` listener printed it whole with
// console.error (measured against a real Redis). Run in a child process, so BOTH its streams are what is checked.
test("a password rotation under a running Queue never prints the password, on stdout or stderr (#468)", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
	const OLD = "oldPasswordNeverPrinted0001";
	const valkey = await fakeValkey(OLD);
	const dir = tempDir("valkey-rotate-");
	const script = join(dir, "queue.mjs");
	const src = resolve(REPO, "worker", "src");
	writeFileSync(script, `
const { parseConnection, makeRedisClient } = await import(${JSON.stringify(join(src, "connection.mjs"))});
const { makeQueue } = await import(${JSON.stringify(join(src, "queue.mjs"))});
const ctx = { envPath: "/nonexistent/.env", shared: false, rootRefused: false, error: null, password: { environment: ${JSON.stringify(OLD)}, file: null } };
const judge = async () => ({ host: "127.0.0.1", servername: null, pinned: "127.0.0.1" });
const q = makeQueue(parseConnection("redis://127.0.0.1:${valkey.port}", { context: ctx, judge }), { name: "rotation" });
const probe = makeRedisClient("redis://127.0.0.1:${valkey.port}", { context: ctx, judge });
await probe.ping();
console.log("CONNECTED");
// A raw client with no listener of its own, too: ioredis' own fallback prints only the stack, which must not carry it.
setTimeout(() => { probe.disconnect(); q.close().catch(() => {}); console.log("DONE"); process.exit(0); }, 3000);
`);
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => {
		out += d;
		if (out.includes("CONNECTED") && valkey.server.password === OLD) valkey.rotate("theNEWpasswordNeverPrinted2");
	});
	child.stderr.on("data", (d) => (err += d));
	await new Promise((r) => child.on("close", r));
	valkey.server.close();
	assert.match(out, /DONE/, `${out}\n${err}`);
	assert.match(err, /\[pi-dispatch\] Valkey error \(queue rotation\): WRONGPASS invalid username-password pair/, "the Queue's error, as one line with its message");
	for (const pw of [OLD, "theNEWpasswordNeverPrinted2"]) {
		assert.ok(!out.includes(pw), "not on stdout");
		assert.ok(!err.includes(pw), `not on stderr:\n${err}`);
	}
});

test("scrubValkeyError keeps a command's name and drops its args, for every error a Redis client emits (#468)", async () => {
	const { scrubValkeyError } = await import("../src/connection.mjs");
	const e = Object.assign(new Error("WRONGPASS"), { command: { name: "auth", args: ["s3cret-value-0000"] } });
	assert.equal(scrubValkeyError(e), e);
	assert.deepEqual(e.command, { name: "auth" });
	assert.equal(scrubValkeyError("x"), "x");
	const c = makeRedisClient("redis://127.0.0.1:1", { lazyConnect: true, context: ctx(), judge: async () => ({ host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }) });
	const seen = [];
	c.on("error", (err) => seen.push(err));
	c.emit("error", Object.assign(new Error("WRONGPASS"), { command: { name: "auth", args: ["s3cret-value-0000"] } }));
	assert.deepEqual(seen[0].command, { name: "auth" }, "scrubbed before any listener sees it");
	c.disconnect();
	// Round 2: a client with NO listener gets its error through silentEmit, which skips emit(); scrubbed there too.
	const quiet = makeRedisClient("redis://127.0.0.1:1", { lazyConnect: true, context: ctx(), judge: async () => ({ host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }) });
	const e2 = Object.assign(new Error("WRONGPASS"), { command: { name: "auth", args: ["s3cret-value-0001"] } });
	const origError = console.error;
	console.error = () => {};
	try {
		quiet.silentEmit("error", e2);
	} finally {
		console.error = origError;
	}
	assert.deepEqual(e2.command, { name: "auth" }, "silentEmit, with nobody listening");
	quiet.disconnect();
});

test("a command a Valkey rejects carries its name, never its arguments (every command's reject is scrubbed, #468)", { timeout: 20_000 }, async () => {
	const valkey = await fakeValkey(null);
	const c = makeRedisClient(`redis://127.0.0.1:${valkey.port}`, { context: ctx(), judge: async () => ({ host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }) });
	c.on("error", () => {});
	try {
		await c.ping();
		const err = await c.call("BADCMD", "an-argument-never-kept").then(() => null, (e) => e);
		assert.match(String(err?.message), /unknown command/);
		assert.deepEqual(err.command, { name: "BADCMD" }, "a reply error rejects its command without the args");
	} finally {
		c.disconnect();
		valkey.server.close();
	}
});

// PR #475's review: the CLI read the password from the deployment .env and VALKEY_URL from the shell alone, so from the
// folder of a Valkey on another port it dialled 6379. One resolver now: this shell's, else the .env's, else the default.
test("the CLI's VALKEY_URL is this shell's, else the deployment .env's, a disagreement named; every verb uses the one resolver", async () => {
	const { cliValkeyUrl } = await import("../src/connection.mjs");
	const { valkeyUrlFor } = await import("../src/valkey-endpoint.mjs");
	const dir = tempDir("valkey-url-");
	writeFileSync(join(dir, ".env"), `VALKEY_URL=redis://127.0.0.1:16480\nVALKEY_PASSWORD=${PW}\n`);
	const warned = [];
	assert.equal(cliValkeyUrl({}, { cwd: dir, warn: (l) => warned.push(l) }), "redis://127.0.0.1:16480", "the folder's own port");
	assert.deepEqual(warned, []);
	assert.equal(cliValkeyUrl({ VALKEY_URL: "redis://:x@127.0.0.1:16481" }, { cwd: dir, warn: (l) => warned.push(l) }), "redis://:x@127.0.0.1:16481", "this shell's wins");
	assert.deepEqual(warned, [`warning: VALKEY_URL is redis://127.0.0.1:16481 in this shell and redis://127.0.0.1:16480 in ${join(dir, ".env")}: using this shell's, while the service uses the file's\n`], "named, never a refusal, never the URL's userinfo");
	assert.equal(cliValkeyUrl({ VALKEY_URL: "redis://127.0.0.1:16480" }, { cwd: dir, warn: (l) => warned.push(l) }), "redis://127.0.0.1:16480");
	assert.equal(warned.length, 1, "agreeing values say nothing");
	assert.equal(cliValkeyUrl({}, { cwd: tempDir("valkey-url-none-"), warn: (l) => warned.push(l) }), "redis://127.0.0.1:6379", "no .env: the default");
	assert.deepEqual(valkeyUrlFor({ envPath: "/d/.env", error: "/d/.env could not be read (EACCES)", url: { environment: null, file: null } }), { url: "redis://127.0.0.1:6379", from: null, note: "/d/.env could not be read (EACCES), so VALKEY_URL is the default, redis://127.0.0.1:6379" });
	// Every CLI verb and `service restart --drain` go through it: none reads the shell's VALKEY_URL on its own any more.
	for (const f of ["cli.mjs", "service.mjs"]) {
		const code = readFileSync(join(REPO, "worker", "src", f), "utf8");
		assert.doesNotMatch(code, /env\.VALKEY_URL \?\?/, f);
	}
	const cli = readFileSync(join(REPO, "worker", "src", "cli.mjs"), "utf8");
	assert.equal((cli.match(/cliValkeyUrl\(env\)/g) ?? []).length, 1, "run");
	assert.equal((cli.match(/await killSwitchUrls\(argv\.slice\(\d\), env\)/g) ?? []).length, 2, "pause/resume/status, and cancel (round 2: both URLs on a disagreement)");
	// And end to end: `pi-dispatch status` from that folder dials the folder's Valkey (nothing answers there, so it says
	// where it tried), not 6379.
	const { main } = await import("../src/cli.mjs");
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://127.0.0.1:1\n");
	const prev = process.cwd();
	const errs = [];
	const origErr = process.stderr.write.bind(process.stderr);
	process.chdir(dir);
	process.stderr.write = (chunk, ...rest) => (errs.push(String(chunk)), true);
	try {
		assert.equal(await main(["status"], {}, { write: () => {}, valkeyRefusal: async () => null }), 1);
	} finally {
		process.stderr.write = origErr;
		process.chdir(prev);
	}
	assert.match(errs.join(""), /could not reach Valkey at redis:\/\/127\.0\.0\.1:1/, errs.join(""));
});

// PR #475's review, round 2: a client with NO `error` listener (the worker's shared client, a CLI probe) never reaches
// the emit hook, since ioredis' silentEmit skips emit() then, and the same error object rejects every command waiting on
// the connection. So the scrub also sits in silentEmit and in each command's reject, and the entry points print an
// unhandled rejection as its message alone. Run in a child process: both streams, and an unhandled rejection's print.
test("a listener-less client after a rotation leaks the password nowhere: not a rejection, not an unhandled one, not a print (#468)", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
	const OLD = "oldPasswordNeverPrinted0002";
	const NEW = "theNEWpasswordNeverPrinted3";
	const valkey = await fakeValkey(OLD);
	const dir = tempDir("valkey-rotate-raw-");
	const script = join(dir, "raw.mjs");
	const src = resolve(REPO, "worker", "src");
	writeFileSync(script, `
import { inspect } from "node:util";
const { makeRedisClient } = await import(${JSON.stringify(join(src, "connection.mjs"))});
const { installRejectionPrinter } = await import(${JSON.stringify(join(src, "exit-code.mjs"))});
installRejectionPrinter();
const ctx = { envPath: "/nonexistent/.env", shared: false, rootRefused: false, error: null, password: { environment: ${JSON.stringify(OLD)}, file: null } };
const raw = makeRedisClient("redis://127.0.0.1:${valkey.port}", { context: ctx, judge: async () => ({ host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }) });
await raw.ping();
console.log("CONNECTED");
await new Promise((r) => setTimeout(r, 300));
// Issued while the client reconnects: rejected by the AUTH failure with the error that carried the password.
raw.get("k").then(() => console.log("GET-OK"), (e) => console.log("REJECTED " + inspect(e, { depth: 6 }) + " " + JSON.stringify(e)));
raw.set("u", "1"); // left unhandled on purpose, as a caller that forgets a catch would
setTimeout(() => { console.log("NOT-REACHED"); process.exit(0); }, 6000);
`);
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => {
		out += d;
		if (out.includes("CONNECTED") && valkey.server.password === OLD) valkey.rotate(NEW);
	});
	child.stderr.on("data", (d) => (err += d));
	const code = await new Promise((r) => child.on("close", r));
	valkey.server.close();
	assert.match(out, /REJECTED ReplyError: WRONGPASS/, `the waiting command was rejected with the AUTH error:\n${out}\n${err}`);
	assert.match(out, /command: \{ name: 'auth' \}/, "its command kept, by name alone");
	assert.match(err, /^error: an unhandled rejection: WRONGPASS invalid username-password pair or user is disabled\.$/m, err);
	assert.equal(code, 1, "and the process exits 1, as Node's own default for an unhandled rejection");
	for (const pw of [OLD, NEW]) {
		assert.ok(!out.includes(pw), `not on stdout:\n${out}`);
		assert.ok(!err.includes(pw), `not on stderr:\n${err}`);
	}
});

// PR #475's review, round 2: a stale VALKEY_URL in the shell made `pause` "succeed" on the wrong Valkey while the
// service's kept taking jobs. On a shell/.env disagreement `pause` pauses BOTH and says so, `status` shows both, and
// `resume` and `cancel` refuse until `--valkey-url` names which. Two databases of the test Valkey stand in for two.
test("the kill switch on a shell/.env disagreement: pause pauses both, status shows both, resume and cancel refuse until named (#468)", { timeout: 60_000 }, async (t) => {
	const base = process.env.VALKEY_TEST_URL;
	if (!base) return t.skip("needs a Valkey (VALKEY_TEST_URL); CI runs it");
	const shellUrl = `${base}/13`;
	const fileUrl = `${base}/14`;
	const dir = tempDir("valkey-kill-");
	writeFileSync(join(dir, ".env"), `VALKEY_URL=${fileUrl}\n`);
	const { main } = await import("../src/cli.mjs");
	const { makeQueue } = await import("../src/queue.mjs");
	const run = async (argv, env = { VALKEY_URL: shellUrl }) => {
		const out = [];
		const errs = [];
		const prev = process.cwd();
		const origErr = process.stderr.write.bind(process.stderr);
		process.chdir(dir);
		process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
		try {
			const code = await main(argv, env, { write: (c) => out.push(String(c)), valkeyRefusal: async () => null });
			return { code, out: out.join(""), err: errs.join("") };
		} finally {
			process.stderr.write = origErr;
			process.chdir(prev);
		}
	};
	const paused = async (url) => {
		const q = makeQueue(parseConnection(url, { failFast: true, context: ctx() }));
		try {
			return await q.isPaused();
		} finally {
			await q.close();
		}
	};
	try {
		const p = await run(["pause"]);
		assert.equal(p.code, 0, p.err);
		assert.match(p.err, /warning: VALKEY_URL is redis:\/\/127\.0\.0\.1:\d+\/13 in this shell and redis:\/\/127\.0\.0\.1:\d+\/14 in .*\.env \(what the service uses\): pausing both/);
		assert.equal((p.out.match(/^\[redis:\/\/127\.0\.0\.1:\d+\/1[34]\] paused/gm) ?? []).length, 2, p.out);
		assert.deepEqual([await paused(shellUrl), await paused(fileUrl)], [true, true], "both, so the service's is stopped whichever is right");
		const st = await run(["status"]);
		const rows = st.out.trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(rows.map((r) => [r.valkey.endsWith("/13") || r.valkey.endsWith("/14"), r.pausedState]), [[true, true], [true, true]], "one row per Valkey, each named");
		const r = await run(["resume"]);
		assert.equal(r.code, 1);
		assert.match(r.err, /resume would start jobs on one of them, so it names neither\. Say which: pi-dispatch resume --valkey-url <url>/);
		assert.deepEqual([await paused(shellUrl), await paused(fileUrl)], [true, true], "a refused resume changes nothing");
		const c = await run(["cancel", "local-0123456789abcdef"]);
		assert.equal(c.code, 1);
		assert.match(c.err, /a job lives in one of them\. Say which: pi-dispatch cancel local-0123456789abcdef --valkey-url <url>/);
		// Round 3 of PR #475's review: the verb's flags are parsed with parseArgs, so the flag before the id is the flag
		// (a hand scan took "--valkey-url" for the job id), and the id is the id.
		const flagFirst = await run(["cancel", "--valkey-url", fileUrl, "local-0123456789abcdef"]);
		assert.equal(flagFirst.code, 1);
		assert.match(flagFirst.err, /no job local-0123456789abcdef in \d+ queue\(s\)/, flagFirst.err);
		assert.doesNotMatch(flagFirst.err, /no job --valkey-url/);
		// A URL that is neither side's is used, and said.
		const third = await run(["status", "--valkey-url", `${base}/15`]);
		assert.equal(third.code, 0, third.err);
		assert.match(third.err, /warning: using --valkey-url redis:\/\/127\.0\.0\.1:\d+\/15, which is neither this shell's VALKEY_URL \(redis:\/\/127\.0\.0\.1:\d+\/13\) nor .*\.env's \(redis:\/\/127\.0\.0\.1:\d+\/14\)/);
		const named = await run(["resume", "--valkey-url", fileUrl]);
		assert.equal(named.code, 0, named.err);
		assert.doesNotMatch(named.err, /which is neither/, "the .env's own URL is not a surprise");
		assert.deepEqual([await paused(shellUrl), await paused(fileUrl)], [true, false], "the named one alone");
		// Agreement (no shell value): one Valkey, the .env's, and the output as before (no label, no `valkey` field).
		const one = await run(["status"], {});
		assert.equal(JSON.parse(one.out).valkey, undefined);
		assert.equal(JSON.parse(one.out).pausedState, false);
	} finally {
		await run(["resume", "--valkey-url", shellUrl]);
		await run(["resume", "--valkey-url", fileUrl]);
	}
	// A password in the URL never reaches the terminal (PR #475's review): every URL is printed through urlShown.
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://:urlSecretNeverShown0001@127.0.0.1:1\n");
	for (const argv of [["status"], ["pause"]]) {
		const res = await run(argv, {});
		assert.equal(res.code, 1);
		assert.match(res.err, /could not (reach Valkey|pause the whole deployment) at redis:\/\/127\.0\.0\.1:1/, res.err);
		assert.ok(!res.err.includes("urlSecretNeverShown0001") && !res.out.includes("urlSecretNeverShown0001"), argv.join(" "));
	}
});

// PR #475's review, round 3: a Valkey container or volume is this deployment's only when it is PROVABLY this
// deployment's. Measured before: the wizard's hand-over removed another deployment's pi-dispatch-valkey, and a second
// deployment's `up` ran a Valkey on the AOF another deployment's compose Valkey was appending to.
const record = ({ name = "pi-dispatch-valkey", labels = {}, bindings = [{ HostIp: "127.0.0.1", HostPort: "6379" }], where = "HostConfig" } = {}) => {
	const ports = { "6379/tcp": bindings };
	return { Name: `/${name}`, Config: { Labels: labels }, ...(where === "HostConfig" ? { HostConfig: { PortBindings: ports } } : { NetworkSettings: { Ports: ports } }) };
};

test("valkeyContainerIsOurs: up's label naming this folder, compose's working dir here, or a legacy unlabelled pi-dispatch-valkey on VALKEY_URL's port (#475 round 3)", () => {
	const at = { dirs: ["/real/a", "/link/a"], port: 16495 };
	assert.equal(valkeyDockerRunArgs({ deployment: "/real/a" }).join(" ").includes(`--label ${DEPLOYMENT_LABEL}=/real/a`), true, "up labels what it creates");
	assert.equal(valkeyDockerRunArgs().includes("--label"), false);
	assert.equal(valkeyContainerIsOurs(record({ labels: { [DEPLOYMENT_LABEL]: "/real/a" } }), at), true);
	assert.equal(valkeyContainerIsOurs(record({ labels: { [DEPLOYMENT_LABEL]: "/link/a" } }), at), true, "the folder as given counts too");
	// A label is decisive: another folder's is not ours even on our port.
	assert.equal(valkeyContainerIsOurs(record({ labels: { [DEPLOYMENT_LABEL]: "/real/b" }, bindings: [{ HostIp: "127.0.0.1", HostPort: "16495" }] }), at), false);
	assert.equal(valkeyContainerIsOurs(record({ labels: { [DEPLOYMENT_LABEL]: "/real/a/" } }), at), false, "exact paths only");
	// Compose's own label: this folder or its deploy/ (compose names the directory of its first -f).
	for (const [wd, ours] of [["/real/a/deploy", true], ["/real/a", true], ["/real/b/deploy", false], ["/real", false]]) {
		assert.equal(valkeyContainerIsOurs(record({ name: "a-valkey-1", labels: { "com.docker.compose.project.working_dir": wd }, bindings: [{ HostIp: "127.0.0.1", HostPort: "16495" }] }), at), ours, wd);
	}
	// Legacy, unlabelled: only the name pi-dispatch-valkey, and only publishing this deployment's port on 127.0.0.1.
	assert.equal(valkeyContainerIsOurs(record({ bindings: [{ HostIp: "127.0.0.1", HostPort: "16495" }] }), at), true);
	assert.equal(valkeyContainerIsOurs(record({ bindings: [{ HostIp: "127.0.0.1", HostPort: "16495" }], where: "NetworkSettings" }), at), true, "a running record's NetworkSettings too");
	assert.equal(valkeyContainerIsOurs(record({ bindings: [{ HostIp: "127.0.0.1", HostPort: "16496" }] }), at), false);
	assert.equal(valkeyContainerIsOurs(record({ bindings: [{ HostIp: "0.0.0.0", HostPort: "16495" }] }), at), false, "not a loopback publish");
	assert.equal(valkeyContainerIsOurs(record({ bindings: [] }), at), false);
	assert.equal(valkeyContainerIsOurs(record({ name: "valkey", bindings: [{ HostIp: "127.0.0.1", HostPort: "16495" }] }), at), false, "another name is never ours by its port");
	assert.equal(valkeyContainerIsOurs({}, at), false);
});

test("valkeyContainerOwner, foreignVolumeUsers and composeHandoverPlan: docker's answers, never a guess (#475 round 3)", async () => {
	const at = { dirs: ["/real/a"], port: 6379 };
	// pi-dispatch-valkey-data itself is this folder's (its label) unless a test answers otherwise (the volume gap).
	const docker = (answers) => async (cmd, args) => answers[args.join(" ")] ?? (args[0] === "volume" ? { code: 0, stdout: JSON.stringify([{ Name: VALKEY_VOLUME, Labels: { [DEPLOYMENT_LABEL]: "/real/a" } }]), stderr: "" } : { code: 1, stdout: "", stderr: `Error: No such container: ${args.at(-1)}\n` });
	const json = (r) => ({ code: 0, stdout: JSON.stringify([r]), stderr: "" });
	assert.deepEqual(await valkeyContainerOwner("pi-dispatch-valkey", { ...at, query: docker({}) }), { absent: true });
	assert.deepEqual(await valkeyContainerOwner("pi-dispatch-valkey", { ...at, query: docker({ "container inspect pi-dispatch-valkey": { code: 1, stdout: "", stderr: "Error: no such object: pi-dispatch-valkey" } }) }), { absent: true });
	assert.ok((await valkeyContainerOwner("pi-dispatch-valkey", { ...at, query: docker({ "container inspect pi-dispatch-valkey": { code: 125, stdout: "", stderr: "Cannot connect" } }) })).unknown);
	assert.ok((await valkeyContainerOwner("pi-dispatch-valkey", { ...at, query: docker({ "container inspect pi-dispatch-valkey": { code: 0, stdout: "not json", stderr: "" } }) })).unknown);
	assert.deepEqual(await valkeyContainerOwner("pi-dispatch-valkey", { ...at, query: docker({ "container inspect pi-dispatch-valkey": json(record({ labels: { [DEPLOYMENT_LABEL]: "/real/b" } })) }) }), { ours: false, owner: "the deployment in /real/b" });
	const ps = `ps -a --filter volume=${VALKEY_VOLUME} --format {{.Names}}`;
	// Ours on the volume is fine; another's, or one docker cannot describe, is named.
	const mixed = docker({ [ps]: { code: 0, stdout: "pi-dispatch-valkey\nb-valkey-1\ngone\n", stderr: "" }, "container inspect pi-dispatch-valkey": json(record({ labels: { [DEPLOYMENT_LABEL]: "/real/a" } })), "container inspect b-valkey-1": json(record({ name: "b-valkey-1", labels: { "com.docker.compose.project.working_dir": "/real/b/deploy" } })) });
	assert.deepEqual(await foreignVolumeUsers({ ...at, query: mixed }), { foreign: [{ name: "b-valkey-1", owner: "the compose project in /real/b/deploy" }] });
	assert.ok((await foreignVolumeUsers({ ...at, query: docker({ [ps]: { code: 1, stdout: "", stderr: "" } }) })).unknown);
	// The hand-over: only this deployment's pi-dispatch-valkey, never with a foreign container on the volume.
	const oursOnly = docker({ [ps]: { code: 0, stdout: "pi-dispatch-valkey\n", stderr: "" }, "container inspect pi-dispatch-valkey": json(record({ labels: { [DEPLOYMENT_LABEL]: "/real/a" } })) });
	assert.deepEqual(await composeHandoverPlan({ ...at, override: false, query: oursOnly }), { handover: true, note: null });
	const theirs = docker({ [ps]: { code: 0, stdout: "pi-dispatch-valkey\n", stderr: "" }, "container inspect pi-dispatch-valkey": json(record({ labels: { [DEPLOYMENT_LABEL]: "/real/b" } })) });
	const noOverride = await composeHandoverPlan({ ...at, override: false, query: theirs });
	assert.equal(noOverride.handover, false, "another deployment's is never handed over");
	assert.match(noOverride.note, /pi-dispatch-valkey is not this deployment's Valkey \(the deployment in \/real\/b\), so it is never stopped, removed or reused from here; it is left running/);
	assert.match((await composeHandoverPlan({ ...at, override: true, query: theirs })).refused, /pi-dispatch-valkey-data is mounted by pi-dispatch-valkey \(the deployment in \/real\/b\), which is not this deployment's Valkey/, "compose's valkey would mount that volume");
	assert.match((await composeHandoverPlan({ ...at, override: false, query: docker({ "container inspect pi-dispatch-valkey": { code: 125, stdout: "", stderr: "down" } }) })).refused, /could not be read/);
	assert.deepEqual(await composeHandoverPlan({ ...at, override: false, query: docker({}) }), { handover: false, note: null }, "nothing there, nothing asked of the volume");
});

test("valkeyPortEnvDecision: PI_VALKEY_PORT written where VALKEY_URL's port is not 6379, a different value named and never overwritten (#475 round 3)", () => {
	assert.deepEqual(valkeyPortEnvDecision(undefined, 16495), { write: "16495" });
	assert.deepEqual(valkeyPortEnvDecision("", 16495), { write: "16495" });
	assert.deepEqual(valkeyPortEnvDecision(undefined, 6379), {});
	assert.deepEqual(valkeyPortEnvDecision("16495", 16495), {});
	assert.match(valkeyPortEnvDecision("16000", 16495, { envPath: "/d/.env" }).conflict, /^PI_VALKEY_PORT is 16000 in \/d\/\.env, and VALKEY_URL's port is 16495: compose publishes its Valkey on 16000, where the worker does not dial\. Set PI_VALKEY_PORT=16495 there/);
	assert.ok(valkeyPortEnvDecision("16000", 6379).conflict, "a stray value on a 6379 deployment is named too");
});

// PR #475's review, round 3: the kill switch's flags, refused before anything is dialled.
test("the kill switch's --valkey-url: a password in it is refused (a command line is readable in /proc), stray arguments are refused, the one resolver the panel shares (#475 round 3)", async () => {
	const dir = tempDir("valkey-kill-args-");
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://127.0.0.1:16495\n");
	const { main } = await import("../src/cli.mjs");
	const run = async (argv, env = {}) => {
		const errs = [];
		const out = [];
		const prev = process.cwd();
		const origErr = process.stderr.write.bind(process.stderr);
		process.chdir(dir);
		process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
		try {
			const code = await main(argv, env, { write: (c) => out.push(String(c)), valkeyRefusal: async () => null });
			return { code, err: errs.join(""), out: out.join("") };
		} finally {
			process.stderr.write = origErr;
			process.chdir(prev);
		}
	};
	for (const verb of ["pause", "resume", "status", "cancel"]) {
		const argv = verb === "cancel" ? [verb, "--valkey-url", "redis://:hunter2secretNeverShown@127.0.0.1:16495", "j1"] : [verb, "--valkey-url=redis://:hunter2secretNeverShown@127.0.0.1:16495"];
		const r = await run(argv);
		assert.equal(r.code, 1, verb);
		assert.match(r.err, /--valkey-url carries a password \(or a user\): a command line is readable by every account on this host in \/proc, so the URL is refused\. Put the password in VALKEY_PASSWORD/, verb);
		assert.ok(!r.err.includes("hunter2secretNeverShown") && !r.out.includes("hunter2secretNeverShown"), verb);
	}
	const extra = await run(["pause", "now"]);
	assert.equal(extra.code, 1);
	assert.match(extra.err, /pi-dispatch pause takes no argument but --valkey-url <url> \(got "now"\)/);
	const two = await run(["cancel", "j1", "j2", "--valkey-url", "redis://127.0.0.1:1"]);
	assert.equal(two.code, 1);
	assert.match(two.err, /pi-dispatch cancel takes one job id \(got "j1" "j2"\)/);
	const unknown = await run(["pause", "--valky-url", "x"]);
	assert.equal(unknown.code, 1);
	assert.match(unknown.err, /valky-url/);
	// The resolver itself, as the panel calls it.
	const { killSwitchValkeyUrls } = await import("../src/valkey-endpoint.mjs");
	assert.deepEqual(killSwitchValkeyUrls({ env: {}, cwd: dir }), { urls: ["redis://127.0.0.1:16495"], disagreement: null, note: null });
	const both = killSwitchValkeyUrls({ env: { VALKEY_URL: "redis://:shellSecret1@127.0.0.1:16000" }, cwd: dir });
	assert.deepEqual(both.urls, ["redis://:shellSecret1@127.0.0.1:16000", "redis://127.0.0.1:16495"]);
	assert.equal(both.disagreement, `VALKEY_URL is redis://127.0.0.1:16000 in this shell and redis://127.0.0.1:16495 in ${join(dir, ".env")} (what the service uses)`);
	assert.equal(killSwitchValkeyUrls({ env: {}, cwd: dir, flagUrl: "redis://127.0.0.1:16495" }).note, null);
	assert.match(killSwitchValkeyUrls({ env: {}, cwd: dir, flagUrl: "redis://127.0.0.1:17000" }).note, /^using --valkey-url redis:\/\/127\.0\.0\.1:17000, which is neither this shell's VALKEY_URL \(unset\) nor .*\.env's \(redis:\/\/127\.0\.0\.1:16495\)$/);
	assert.match(killSwitchValkeyUrls({ env: {}, cwd: dir, flagUrl: "not a url" }).error, /--valkey-url is not a URL/);
	assert.match(killSwitchValkeyUrls({ env: {}, cwd: dir, flagUrl: "redis://user@127.0.0.1:1" }).error, /carries a password \(or a user\)/);
});

// PR #475's review, the volume gap: the volume's own label, and the queue's own marker.
test("valkeyVolumeOwner and the hand-over plan: another folder's label refuses, an unlabelled volume asks unless this deployment's container serves it (#475 volume gap)", async () => {
	assert.deepEqual(valkeyVolumeCreateArgs("/real/a"), ["volume", "create", "--label", `${DEPLOYMENT_LABEL}=/real/a`, VALKEY_VOLUME]);
	const vol = (labels) => ({ code: 0, stdout: JSON.stringify([{ Name: VALKEY_VOLUME, Labels: labels }]), stderr: "" });
	const q = (answer) => async () => answer;
	const at = { dirs: ["/real/a", "/link/a"] };
	assert.deepEqual(await valkeyVolumeOwner({ ...at, query: q({ code: 1, stdout: "", stderr: "Error: no such volume" }) }), { absent: true });
	assert.ok((await valkeyVolumeOwner({ ...at, query: q({ code: 125, stdout: "", stderr: "down" }) })).unknown);
	assert.ok((await valkeyVolumeOwner({ ...at, query: q({ code: 0, stdout: "x", stderr: "" }) })).unknown);
	assert.deepEqual(await valkeyVolumeOwner({ ...at, query: q(vol({ [DEPLOYMENT_LABEL]: "/link/a" })) }), { ours: true, owner: "/link/a" });
	assert.deepEqual(await valkeyVolumeOwner({ ...at, query: q(vol({ [DEPLOYMENT_LABEL]: "/real/a/deploy" })) }), { ours: false, owner: "/real/a/deploy" }, "exactly the folder");
	assert.deepEqual(await valkeyVolumeOwner({ ...at, query: q(vol(null)) }), { unlabelled: true, createdAt: null });
	assert.deepEqual(await valkeyVolumeOwner({ ...at, query: q(vol({ [DEPLOYMENT_LABEL]: "" })) }), { unlabelled: true, createdAt: null });
	// The plan: the volume's owner, only where compose's valkey would mount it.
	const docker = (volume, up = null) => async (cmd, args) => {
		if (args[0] === "volume") return volume;
		if (args[0] === "ps") return { code: 0, stdout: up ? "pi-dispatch-valkey\n" : "", stderr: "" };
		return up ? { code: 0, stdout: JSON.stringify([{ Name: "/pi-dispatch-valkey", Config: { Labels: { [DEPLOYMENT_LABEL]: "/real/a" } } }]), stderr: "" } : { code: 1, stdout: "", stderr: "Error: No such container" };
	};
	const plan = (volume, { override = true, up = null } = {}) => composeHandoverPlan({ dirs: ["/real/a"], port: 6379, override, query: docker(volume, up) });
	assert.match((await plan(vol({ [DEPLOYMENT_LABEL]: "/real/b" }))).refused, /belongs to the deployment in \/real\/b \(its label\), so this deployment never uses it/);
	assert.deepEqual(await plan(vol(null)), { handover: false, note: null, adopt: true });
	assert.deepEqual(await plan(vol(null), { override: false, up: "ours" }), { handover: true, note: null }, "this deployment's own container serves it: no question (and no CreatedAt here, so nothing to record)");
	assert.deepEqual(await plan(vol({ [DEPLOYMENT_LABEL]: "/real/a" })), { handover: false, note: null });
	assert.match((await plan({ code: 125, stdout: "", stderr: "down" })).refused, /whose pi-dispatch-valkey-data is could not be read/);
	assert.deepEqual(await plan(vol({ [DEPLOYMENT_LABEL]: "/real/b" }), { override: false }), { handover: false, note: null }, "not mounted: not asked");
});

test("claimValkeyOwner records pi-dispatch:owner once and reads it back: a second folder gets the first one's (#475 volume gap)", { timeout: 30_000 }, async (t) => {
	const base = process.env.VALKEY_TEST_URL;
	if (!base) return t.skip("needs a Valkey (VALKEY_TEST_URL); CI runs it");
	const { claimValkeyOwner } = await import("../src/connection.mjs");
	const url = `${base}/12`;
	const dir = tempDir("valkey-owner-");
	const context = valkeyClientContext({ env: {}, cwd: dir });
	const wipe = makeRedisClient(url, { context });
	try {
		await wipe.del(OWNER_MARKER_KEY);
		assert.deepEqual(await claimValkeyOwner(url, "/srv/a", { context }), { owner: "/srv/a", claimed: true });
		assert.deepEqual(await claimValkeyOwner(url, "/srv/a", { context }), { owner: "/srv/a", claimed: false });
		assert.deepEqual(await claimValkeyOwner(url, "/srv/b", { context }), { owner: "/srv/a", claimed: false }, "never overwritten");
		assert.equal(await wipe.get(OWNER_MARKER_KEY), "/srv/a");
	} finally {
		await wipe.del(OWNER_MARKER_KEY);
		wipe.disconnect();
	}
	// Nothing answering: an error after the wait, never an owner.
	const r = await claimValkeyOwner("redis://127.0.0.1:1", "/srv/a", { context, waitMs: 600, sleep: async () => {} });
	assert.ok(r.error, JSON.stringify(r));
});

// PR #475's round-cap re-review: the adoption record and the unpublished owner check, as pure pieces.
test("the adoption record matches exactly its volume, and the owner check runs with no network, no port and no password (#475 round-cap re-review)", async () => {
	const { OWNER_CHECK_EXEC, ownerCheckAnswer, readVolumeRecord, valkeyOwnerCheckArgs, volumeRecordMatches, volumeRecordText } = await import("../src/valkey-auth.mjs");
	const vol = { unlabelled: true, createdAt: "2026-09-01T10:00:00Z" };
	const record = JSON.parse(volumeRecordText(vol));
	assert.deepEqual(record, { name: VALKEY_VOLUME, createdAt: "2026-09-01T10:00:00Z" });
	assert.equal(volumeRecordMatches(record, vol), true);
	assert.equal(volumeRecordMatches(record, { ...vol, createdAt: "2026-09-02T10:00:00Z" }), false, "made again: another volume");
	assert.equal(volumeRecordMatches(record, { unlabelled: true, createdAt: null }), false, "no CreatedAt from docker: nothing to match");
	assert.equal(volumeRecordMatches({ ...record, name: "other" }, vol), false);
	assert.equal(volumeRecordMatches(record, { ours: true, owner: "/x" }), false, "only an unlabelled volume");
	assert.equal(volumeRecordMatches(null, vol), false);
	const dir = tempDir("valkey-record-");
	assert.equal(readVolumeRecord(dir, { existsSync, readFileSync }), null);
	writeFileSync(join(dir, ".pi-dispatch-valkey-volume.json"), "not json");
	assert.equal(readVolumeRecord(dir, { existsSync, readFileSync }), null, "unreadable: nothing taken from it");
	const args = valkeyOwnerCheckArgs("/real/a");
	assert.equal(args[args.indexOf("--network") + 1], "none");
	assert.ok(!args.includes("-p") && !args.includes("-e") && !args.join(" ").includes("VALKEY_PASSWORD"));
	assert.ok(args.includes("pi-dispatch-valkey-data:/data") && args.includes("--appendonly"));
	assert.deepEqual(OWNER_CHECK_EXEC.slice(-2), ["GET", "pi-dispatch:owner"]);
	assert.deepEqual(ownerCheckAnswer({ code: 0, stdout: "/real/a\n" }), { owner: "/real/a" });
	assert.deepEqual(ownerCheckAnswer({ code: 0, stdout: "\n" }), { owner: "" });
	assert.ok(ownerCheckAnswer({ code: 1, stdout: "(error) LOADING Valkey is loading the dataset in memory\n" }).retry);
	assert.ok(ownerCheckAnswer({ code: 1, stdout: "Could not connect to Valkey at 127.0.0.1:6379: Connection refused\n" }).retry);
	assert.ok(ownerCheckAnswer({ code: 0, stdout: "(error) NOAUTH Authentication required.\n" }).error);
	assert.ok(ownerCheckAnswer({ code: 125, stderr: "Error: no such container\n" }).error);
	// The hand-over plan: a recorded unlabelled volume needs no adoption; one served by up's own container is to be recorded.
	const docker = (up) => async (cmd, a) => (a[0] === "volume" ? { code: 0, stdout: JSON.stringify([{ Name: VALKEY_VOLUME, CreatedAt: vol.createdAt, Labels: {} }]), stderr: "" } : a[0] === "ps" ? { code: 0, stdout: up ? "pi-dispatch-valkey\n" : "", stderr: "" } : up ? { code: 0, stdout: JSON.stringify([{ Name: "/pi-dispatch-valkey", Config: { Labels: { [DEPLOYMENT_LABEL]: "/real/a" } } }]), stderr: "" } : { code: 1, stdout: "", stderr: "Error: No such container" });
	assert.deepEqual(await composeHandoverPlan({ dirs: ["/real/a"], port: 6379, override: true, query: docker(false), record }), { handover: false, note: null });
	assert.deepEqual(await composeHandoverPlan({ dirs: ["/real/a"], port: 6379, override: true, query: docker(false) }), { handover: false, note: null, adopt: true });
	assert.deepEqual(await composeHandoverPlan({ dirs: ["/real/a"], port: 6379, override: false, query: docker(true) }), { handover: true, note: null, record: { unlabelled: true, createdAt: vol.createdAt } });
});
