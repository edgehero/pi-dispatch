import assert from "node:assert/strict";
import { connect as netConnect, createServer } from "node:net";
import { test } from "node:test";
import { Command, Redis } from "ioredis";
import { JudgedConnector, VALKEY_ERROR_QUIET_MS, givesUp, makeRedisClient, onValkeyError, parseConnection, passwordDeclinedOf, useValkeyContext } from "../src/connection.mjs";

// Issue #464, gate round 1 (measured on Fedora 44): WHATWG URL keeps an IPv6 literal's brackets in `hostname`, and the
// queue client then looked up the name "[::1]", which never resolves, so a `redis://[::1]:port` VALKEY_URL never
// connected. The host handed to BullMQ and ioredis is the address inside them.
test("parseConnection hands the client an IPv6 literal without its brackets, and every other host as written", () => {
	assert.equal(parseConnection("redis://[::1]:16510").host, "::1");
	assert.equal(parseConnection("redis://:pw@[fe80::1]:6379/2").host, "fe80::1");
	assert.equal(parseConnection("redis://[::1]:16510").port, 16510);
	assert.equal(parseConnection("redis://127.0.0.1:6379").host, "127.0.0.1");
	assert.equal(parseConnection("redis://localhost").host, "localhost");
	assert.equal(parseConnection("redis://valkey.lan:6380/3").db, 3);
});

// Gate round 2: the worker connects to a pinned literal address; a `rediss:` URL keeps its name for the certificate
// check, and `rediss:` gets TLS at all (host and port alone dropped it, so BullMQ spoke plaintext).
test("parseConnection gives rediss: TLS, with the original name as servername when the address is pinned", () => {
	assert.deepEqual(parseConnection("rediss://192.168.5.15:6380", { servername: "valkey.lan" }).tls, { servername: "valkey.lan" });
	assert.deepEqual(parseConnection("rediss://valkey.lan:6380").tls, {});
	assert.equal(parseConnection("redis://127.0.0.1:6379", { servername: "x" }).tls, undefined, "plain redis: stays plaintext");
});

// PR #478's gate (measured on pd-fedora): a VALKEY_URL whose path is not a database number became `db: NaN`, and the
// SELECT ioredis then sent failed outside every await, so doctor and each client died on an unhandled rejection.
test("a VALKEY_URL path that names no database is refused where every client is made, and at each start (#477 follow-up)", async () => {
	const { valkeyUrlProblem, judgeValkeyAtStart, makeRedisClient } = await import("../src/connection.mjs");
	for (const url of ["redis://127.0.0.1:6379/abc", "redis://127.0.0.1:6379/0,x=y=z", "redis://h/-1", "redis://h/1.5", "redis://h/0000000001", "redis://h/0/1", "redis://h/%20"]) {
		const problem = valkeyUrlProblem(url);
		assert.match(problem ?? "", /^VALKEY_URL redis:\/\/[^ ]+ names no database: its path must be a whole number/, url);
		assert.throws(() => parseConnection(url), (err) => err.valkeyRefused === true && err.piDispatchConfig === true && err.message === problem, url);
		assert.throws(() => makeRedisClient(url, { lazyConnect: true }), (err) => err.valkeyRefused === true, url);
		let judged = false;
		await assert.rejects(judgeValkeyAtStart(url, {}, { judge: async () => { judged = true; return {}; }, checkAuth: null }), (err) => err.valkeyRefused === true && err.message === problem, url);
		assert.equal(judged, false, `${url}: refused before anything is asked`);
	}
	// A database number, or no path at all, is what it always was; a URL that does not parse is left to its callers.
	// Leading zeros are the number (gate round 2): ioredis and the code before read `/01` as database 1.
	for (const [url, db] of [["redis://h:6379", undefined], ["redis://h:6379/", undefined], ["redis://h:6379/0", 0], ["redis://h:6379/15", 15], ["redis://h:6379/00", 0], ["redis://h:6379/01", 1], ["redis://h:6379/000000015", 15], ["rediss://h:6380/2", 2]]) {
		assert.equal(valkeyUrlProblem(url), null, url);
		assert.equal(parseConnection(url).db, db, url);
	}
	assert.equal(valkeyUrlProblem("not a url"), null);
	// Nothing of a credential in the sentence.
	assert.doesNotMatch(valkeyUrlProblem("redis://:s3cret@h:6379/abc"), /s3cret/);
});

test("a scheme no client here speaks is named as such, never as a database or a host (gate round 2 of PR #478)", async () => {
	const { valkeyUrlProblem } = await import("../src/connection.mjs");
	// `unix:///path` had "<no host> names no database", and before that change dialled 127.0.0.1.
	for (const [url, scheme] of [["unix:///run/valkey.sock", "unix:"], ["http://127.0.0.1:6379/0", "http:"], ["valkeyx://127.0.0.1:6379", "valkeyx:"]]) {
		const problem = valkeyUrlProblem(url);
		assert.equal(problem, `VALKEY_URL uses the scheme "${scheme}", which pi-dispatch does not connect with: write redis://host:port (or rediss://host:port for TLS; valkey:// and valkeys:// are the same two)`, url);
		assert.throws(() => parseConnection(url), (err) => err.valkeyRefused === true && err.message === problem, url);
	}
});

const valkeyTest = process.env.VALKEY_TEST_URL;
test("against a real Valkey, a database it does not have is refused by every client, never database 0 (gate round 2 of PR #478, VALKEY_TEST_URL)", { skip: valkeyTest ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async (t) => {
	const { DB_REFUSED, defaultValkeyContext, judgeValkeyAtStart, makeRedisClient, refusedDatabaseOf, valkeyAuthState } = await import("../src/connection.mjs");
	const base = new URL(valkeyTest);
	base.pathname = "";
	const plain = makeRedisClient(base.toString(), {});
	// Every client this test makes is closed however it ends, so a failure is a failure, never a hung run.
	const made = [plain];
	t.after(() => {
		for (const c of made) c.disconnect();
	});
	const databases = Number((await plain.config("GET", "databases"))[1]);
	assert.ok(Number.isInteger(databases) && databases > 0);
	const url = `${base.toString().replace(/\/$/, "")}/${databases}`;
	const expected = `VALKEY_URL ${url.replace(/\/\/[^@/]*@/, "//")} names database ${databases}, which that Valkey does not have: it has ${databases} (databases 0 to ${databases - 1}, its \`databases\` setting). No client uses another database in its place; name one it has, or raise \`databases\` in that Valkey's configuration`;
	// The probe every start judgement and doctor use.
	assert.deepEqual(await valkeyAuthState(url), { state: "dbrange", error: expected });
	await assert.rejects(judgeValkeyAtStart(url, defaultValkeyContext()), (err) => err.valkeyRefused === true && err.piDispatchConfig === true && err.message === expected);
	// A client made on it: its commands reject with the refusal (without the count, which only the probes read), it
	// ends rather than going ready, and nothing it was asked reaches database 0.
	const key = `pd477-db-range-${process.pid}-${Date.now()}`;
	const client = makeRedisClient(url, {});
	made.push(client);
	const seen = [];
	client.on("error", (err) => seen.push(err));
	await assert.rejects(client.set(key, "x"), (err) => err.valkeyRefused === true && /names database \d+, which that Valkey does not have: it answered the SELECT with "DB index is out of range"/.test(err.message));
	for (let i = 0; i < 50 && client.status !== "end"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(client.status, "end", "the client closed and does not reconnect");
	assert.ok(client[DB_REFUSED] && seen.length === 1 && seen[0] === client[DB_REFUSED], "one error event, the refusal");
	// Issue #845: the number the console's restart banner names, from the client that holds the refusal; none for one that does not.
	assert.deepEqual(refusedDatabaseOf(client), { db: databases });
	assert.equal(refusedDatabaseOf(plain), null);
	assert.equal(refusedDatabaseOf(null), null);
	await assert.rejects(client.get(key));
	assert.equal(await plain.get(key), null, "nothing was written to database 0");
	assert.equal(await plain.exists(key), 0);
	// A database it has still works, leading zeros included.
	const ok = makeRedisClient(`${base.toString().replace(/\/$/, "")}/0${databases - 1}`, {});
	made.push(ok);
	await ok.set(key, "y");
	assert.equal(ok.condition.select, databases - 1);
	assert.equal(await ok.get(key), "y");
	assert.equal(await plain.get(key), null, "and on its own database");
	await ok.del(key);
	ok.disconnect();
	plain.disconnect();
});

test("a connector whose client's SELECT was refused fails the ready check and refuses every later connect (gate round 2 of PR #478)", { timeout: 10_000 }, async () => {
	// The ready check ioredis runs after the SELECT: when both replies arrive in one chunk, the INFO answer is already in
	// hand as the refusal lands, and only `check` then stops the client going ready on database 0.
	const { DB_REFUSED, JudgedConnector } = await import("../src/connection.mjs");
	let dialled = 0;
	const connector = new JudgedConnector(parseConnection("redis://127.0.0.1:6379/16", { judge: async () => { dialled += 1; throw new Error("the judge was asked"); } }));
	assert.equal(connector.check("# Server\r\n"), true, "an ordinary client passes");
	const refusal = Object.assign(new Error("VALKEY_URL redis://127.0.0.1:6379/16 names database 16, which that Valkey does not have"), { valkeyRefused: true });
	connector[DB_REFUSED] = refusal;
	assert.equal(connector.check("# Server\r\n"), false);
	await assert.rejects(connector.connect(), (err) => err === refusal);
	assert.equal(dialled, 0, "nothing is judged or dialled for a refused database");
});

test("valkey:// and valkeys:// are aliases of redis:// and rediss:// wherever a scheme is judged (gate round 3 of PR #478)", async () => {
	// They connected before #477's scheme check refused them; an upgrading deployment must keep working.
	const { valkeyUrlProblem } = await import("../src/connection.mjs");
	const { pinnedValkeyUrl, valkeySchemeOf, valkeyTarget } = await import("../src/podman-stack.mjs");
	assert.deepEqual(["redis:", "valkey:", "rediss:", "valkeys:", "unix:", "http:"].map(valkeySchemeOf), ["redis:", "redis:", "rediss:", "rediss:", null, null]);
	for (const url of ["valkey://127.0.0.1:6379", "valkey://127.0.0.1:6379/3", "valkeys://valkey.lan:6380/2"]) {
		assert.equal(valkeyUrlProblem(url), null, url);
		assert.equal(valkeyTarget(url).error, undefined, url);
	}
	assert.equal(parseConnection("valkey://127.0.0.1:6379/3").db, 3);
	assert.equal(parseConnection("valkey://127.0.0.1:6379").tls, undefined, "valkey: is plaintext, as redis: is");
	assert.deepEqual(parseConnection("valkeys://192.168.5.15:6380", { servername: "valkey.lan" }).tls, { servername: "valkey.lan" }, "valkeys: is TLS, as rediss: is");
	assert.deepEqual(pinnedValkeyUrl("valkeys://valkey.lan:6380/2", "192.168.5.15"), { url: "valkeys://192.168.5.15:6380/2", servername: "valkey.lan" });
	assert.equal(pinnedValkeyUrl("valkey://valkey.lan:6379", "192.168.5.15").servername, null);
	assert.match(valkeyUrlProblem("unix:///run/valkey.sock"), /valkey:\/\/ and valkeys:\/\/ are the same two/);
});

test("against a real Valkey, a valkey:// URL connects and uses its database, as redis:// does (gate round 3 of PR #478, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async (t) => {
	const { defaultValkeyContext, judgeValkeyAtStart, makeRedisClient, valkeyAuthState } = await import("../src/connection.mjs");
	const redisUrl = new URL(process.env.VALKEY_TEST_URL);
	redisUrl.pathname = "/2";
	const url = redisUrl.toString().replace(/^redis:/, "valkey:");
	assert.match(url, /^valkey:\/\//);
	const key = `pd477-valkey-scheme-${process.pid}-${Date.now()}`;
	const viaAlias = makeRedisClient(url, {});
	const viaRedis = makeRedisClient(redisUrl.toString(), {});
	t.after(() => {
		viaAlias.disconnect();
		viaRedis.disconnect();
	});
	assert.deepEqual(await valkeyAuthState(url), { state: "ok" });
	await judgeValkeyAtStart(url, defaultValkeyContext());
	await viaAlias.set(key, "via-valkey-scheme");
	assert.equal(await viaRedis.get(key), "via-valkey-scheme", "the same Valkey and the same database 2");
	await viaRedis.del(key);
});

test("onValkeyError says every line unless it is asked to be quiet, so a worker's second outage shows in its log", () => {
	const lines = [];
	const handlers = {};
	onValkeyError({ on: (event, fn) => (handlers[event] = fn) }, "worker q", (line) => lines.push(line));
	handlers.error(new Error("nothing answers"));
	handlers.error(new Error("nothing answers"));
	assert.deepEqual(lines, ["[pi-dispatch] Valkey error (worker q): nothing answers\n", "[pi-dispatch] Valkey error (worker q): nothing answers\n"]);
	assert.equal(handlers.ready, undefined, "a worker going ready ends no reader's quiet");
});

test("givesUp is true of a failFast connection only", () => {
	assert.equal(givesUp(parseConnection("redis://127.0.0.1:6379", { failFast: true })), true);
	assert.equal(givesUp(parseConnection("redis://127.0.0.1:6379")), false);
	assert.equal(givesUp(null), false);
});

test("the quiet is a minute, on the real clock by default", (t) => {
	assert.equal(VALKEY_ERROR_QUIET_MS, 60_000);
	t.mock.timers.enable({ apis: ["Date"], now: 3_000_000 });
	const lines = [];
	const handlers = {};
	onValkeyError({ on: (event, fn) => (handlers[event] = fn) }, "queue quiet-clock", (line) => lines.push(line), { quietly: true });
	handlers.error(new Error("nothing answers"));
	handlers.error(new Error("nothing answers"));
	assert.equal(lines.length, 1);
	t.mock.timers.tick(VALKEY_ERROR_QUIET_MS);
	handlers.error(new Error("nothing answers"));
	assert.equal(lines.length, 2);
});

test("the quiet holds a bounded number of lines: past that it forgets, and says a held line again", () => {
	const lines = [];
	const handlers = {};
	onValkeyError({ on: (event, fn) => (handlers[event] = fn) }, "queue quiet-held", (line) => lines.push(line), { quietly: true, now: () => 4_000_000 });
	handlers.error(new Error("the first fault"));
	for (let i = 0; i < 256; i += 1) handlers.error(new Error(`fault ${i}`));
	assert.equal(lines.length, 257);
	handlers.error(new Error("the first fault"));
	assert.equal(lines.length, 258);
});

test("a client going ready ends the quiet, so a second outage inside the minute is said at once", () => {
	const lines = [];
	const handlers = {};
	onValkeyError({ on: (event, fn) => (handlers[event] = fn) }, "queue quiet-ready", (line) => lines.push(line), { quietly: true, now: () => 2_000_000 });
	handlers.error(new Error("nothing answers"));
	handlers.error(new Error("nothing answers"));
	assert.equal(lines.length, 1);
	handlers.ready();
	handlers.error(new Error("nothing answers"));
	assert.equal(lines.length, 2);
});

test("onValkeyError quietly says a repeated line once per quiet window, across emitters, and a line not said in it at once", () => {
	const lines = [];
	let t = 1_000_000;
	const listen = (what) => {
		const handlers = {};
		onValkeyError({ on: (event, fn) => (handlers[event] = fn) }, what, (line) => lines.push(line), { quietly: true, now: () => t });
		return handlers.error;
	};
	const first = listen("queue quiet-a");
	const second = listen("queue quiet-a");
	first(new Error("nothing answers"));
	second(new Error("nothing answers"));
	assert.equal(lines.length, 1, "a replacement queue repeats its predecessor's line");
	first(new Error("refused"));
	assert.equal(lines.length, 2, "a change of what is wrong is said at once");
	listen("queue quiet-b")(new Error("nothing answers"));
	assert.equal(lines.length, 3, "another queue's line is its own");
	t += VALKEY_ERROR_QUIET_MS - 1;
	second(new Error("nothing answers"));
	assert.equal(lines.length, 3);
	t += 1;
	second(new Error("nothing answers"));
	assert.equal(lines.length, 4, "said again once the window has passed");
	t -= 5 * VALKEY_ERROR_QUIET_MS;
	second(new Error("nothing answers"));
	assert.equal(lines.length, 5, "a clock gone backwards says it rather than holding it back");
	assert.equal(lines[0], "[pi-dispatch] Valkey error (queue quiet-a): nothing answers\n");
});

test("freshContext judges each connect by the process's context as it is then; without it, by the one at construction", async () => {
	const seen = [];
	const judge = async (_url, context) => {
		seen.push(context.mark);
		throw new Error("no dial in this test");
	};
	let mark = "before the fix";
	useValkeyContext(() => ({ mark }));
	try {
		const fresh = new JudgedConnector(parseConnection("redis://127.0.0.1:1", { judge, freshContext: true }));
		const frozen = new JudgedConnector(parseConnection("redis://127.0.0.1:1", { judge }));
		const named = new JudgedConnector(parseConnection("redis://127.0.0.1:1", { judge, freshContext: true, context: { mark: "named" } }));
		await fresh.connect();
		await frozen.connect();
		await named.connect();
		mark = "after the fix";
		await fresh.connect();
		await frozen.connect();
		await named.connect();
		assert.deepEqual(seen, ["before the fix", "before the fix", "named", "after the fix", "before the fix", "named"]);
	} finally {
		useValkeyContext(null);
	}
});

test("freshContext: a context read that throws fails that connect the way a refused judgement does, and never rejects it", async () => {
	useValkeyContext(() => {
		if (armed) throw new Error("the context could not be read");
		return {};
	});
	let armed = false;
	try {
		const connector = new JudgedConnector(parseConnection("redis://127.0.0.1:1", { judge: async () => ({ host: "127.0.0.1", servername: null, pinned: null }), freshContext: true }));
		armed = true;
		const stream = await connector.connect();
		assert.equal(stream.destroyed, true);
		assert.match(connector.firstError.message, /the context could not be read/);
	} finally {
		useValkeyContext(null);
	}
});

// Issue #845: a `freshContext` client's password is the context's as it is at each connect, so a password rotated in the
// deployment's `.env` reaches a running console. What ioredis sends is `condition.auth`, which `_connect` builds from the
// options, so that is what is read here. No dial: the judge refuses each connect, and the client retries by its strategy.
test("freshContext: each connect sends the password the context gives then; the URL's own, a throwing, broken or missing context, another deployment's, and withoutPassword keep theirs (#845)", async () => {
	const refuse = async () => {
		throw new Error("no dial in this test");
	};
	// The deployment's own VALKEY_URL is the one the clients below dial, as a console's is.
	const ctx = (password, over = {}) => ({ envPath: "/d/.env", shared: false, rootRefused: false, error: null, password: { environment: null, file: password }, url: { environment: null, file: "redis://127.0.0.1:1" }, ...over });
	let now = ctx("first-password");
	useValkeyContext(() => {
		if (now instanceof Error) throw now;
		return now;
	});
	const clients = [];
	// No retry, so the client's every connect is one the test makes: the judge's refusal ends it, and the next starts
	// from "end", which ioredis' `connect()` accepts.
	const made = (url, opts = {}) => {
		const c = makeRedisClient(url, { lazyConnect: true, judge: refuse, ...opts });
		c.options.retryStrategy = () => null;
		c.on("error", () => {});
		clients.push(c);
		return c;
	};
	/** The AUTH a connect of `c` was built with: its password, or null for none. */
	const connectOnce = async (c) => {
		await c.connect().catch(() => {});
		assert.equal(c.status, "end");
		return c.condition?.auth ?? null;
	};
	try {
		const fresh = made("redis://127.0.0.1:1", { freshContext: true });
		const frozen = made("redis://127.0.0.1:1");
		const fromUrl = made("redis://:fromTheUrl@127.0.0.1:1", { freshContext: true });
		const probe = made("redis://127.0.0.1:1", { freshContext: true, withoutPassword: true });
		assert.deepEqual([await connectOnce(fresh), await connectOnce(frozen), await connectOnce(fromUrl), await connectOnce(probe)], ["first-password", "first-password", "fromTheUrl", null]);
		now = ctx("rotated-password");
		assert.equal(await connectOnce(fresh), "rotated-password", "the rotation, at the next connect, on the same client");
		assert.equal(await connectOnce(frozen), "first-password", "without freshContext: the password read at construction");
		assert.equal(await connectOnce(fromUrl), "fromTheUrl", "a password in VALKEY_URL is the URL's, whatever the .env says");
		assert.equal(await connectOnce(probe), null, "a probe that sends none never gets one");
		const twin = fresh.duplicate();
		twin.on("error", () => {});
		clients.push(twin);
		now = ctx("third-password");
		assert.equal(await connectOnce(twin), "third-password", "a duplicate (BullMQ's blocking connections) reads it too");
		assert.equal(await connectOnce(fresh), "third-password");
		now = new Error("the context could not be read");
		assert.equal(await connectOnce(fresh), "third-password", "a context that throws keeps the last password, and the connect still runs");
		now = ctx(null, { error: "/d/.env line 3 has an open quote" });
		assert.equal(await connectOnce(fresh), "third-password", "a .env that cannot be told keeps the last password rather than dropping one that works");
		now = ctx(null, { absent: true });
		assert.equal(await connectOnce(fresh), "third-password", "a .env gone (for good, or while an editor replaces it) is not one that sets none");
		// The pi extension's context follows the deployment pointer: a client built for one deployment's Valkey never sends
		// another deployment's password to it, and takes its own again once the context is its deployment's.
		now = ctx("the-next-deployments-password", { envPath: "/other/.env" });
		assert.equal(await connectOnce(fresh), "third-password", "another deployment's context: the last password stays");
		now = ctx("the-next-deployments-password", { envPath: null });
		assert.equal(await connectOnce(fresh), "third-password", "no deployment at all: the same");
		now = ctx("fourth-password");
		assert.equal(await connectOnce(fresh), "fourth-password", "its own deployment again");
		// Review of PR #878, measured with two Valkeys: a password that came with another VALKEY_URL is that Valkey's, and a
		// held client never moves there. One deployment moving to another Valkey changes both lines together; a symlinked
		// deployment folder repointed reads another deployment's file through the same .env path.
		now = ctx("the-new-valkeys-password", { url: { environment: null, file: "redis://127.0.0.1:2" } });
		assert.equal(await connectOnce(fresh), "fourth-password", "the deployment moved to another Valkey: the old one's password stays");
		now = ctx("deployment-b-password", { envPath: "/d/.env", url: { environment: null, file: "redis://127.0.0.1:3" } });
		assert.equal(await connectOnce(fresh), "fourth-password", "the same .env path naming another Valkey: the same");
		now = ctx("fifth-password", { url: { environment: null, file: "redis://127.0.0.1:1" } });
		assert.equal(await connectOnce(fresh), "fifth-password", "the URL it was built on, rotated: taken");
		now = ctx(null, { url: { environment: null, file: "redis://127.0.0.1:2" } });
		assert.equal(await connectOnce(fresh), "fifth-password", "another Valkey's file that sets none drops nothing either");
		// Third review of PR #878, measured with two Valkeys: a shell that exports VALKEY_URL keeps the client on that URL,
		// so the context's own choice of URL never moved; the file's password belongs to the file's Valkey all the same.
		now = ctx("shell-first", { url: { environment: "redis://127.0.0.1:1", file: "redis://127.0.0.1:1" } });
		const shelled = made("redis://127.0.0.1:1", { freshContext: true });
		assert.equal(await connectOnce(shelled), "shell-first");
		now = ctx("valkey-2-password", { url: { environment: "redis://127.0.0.1:1", file: "redis://127.0.0.1:2" } });
		assert.equal(await connectOnce(shelled), "shell-first", "the file moved to another Valkey under the shell's URL: its password is not this client's");
		now = ctx("shell-rotated", { url: { environment: "redis://127.0.0.1:1", file: "redis://127.0.0.1:1" } });
		assert.equal(await connectOnce(shelled), "shell-rotated", "the file names the client's Valkey again, rotated: taken");
		now = ctx("valkey-2-password", { url: { environment: "redis://127.0.0.1:1", file: null } });
		assert.equal(await connectOnce(shelled), "shell-rotated", "a file naming no VALKEY_URL speaks for the default Valkey, which is not this client's");
		// A password a bad line hid at start: the client was built on the default URL (the line hid VALKEY_URL too) with no
		// password; once the line is fixed it is taken where the file names that same Valkey, and not where it names another.
		now = ctx(null, { error: "/d/.env line 1 has a carriage return", url: { environment: null, file: null } });
		const hidden = made("redis://127.0.0.1:6379", { freshContext: true });
		assert.equal(await connectOnce(hidden), null);
		now = ctx("found-after-the-fix", { url: { environment: null, file: "redis://127.0.0.1:9" } });
		assert.equal(await connectOnce(hidden), null, "the fixed file names another Valkey: the banner says VALKEY_URL changed, and nothing is sent here");
		now = ctx("found-after-the-fix", { url: { environment: null, file: "redis://127.0.0.1:6379" } });
		assert.equal(await connectOnce(hidden), "found-after-the-fix", "the fixed file names this client's Valkey: taken, no restart");
		// A password from this process's environment is not the file's, and is taken whatever the file names.
		now = ctx(null, { password: { environment: "exported-password", file: null }, url: { environment: null, file: "redis://127.0.0.1:9" } });
		assert.equal(await connectOnce(hidden), "exported-password");
		// Fourth review of PR #878: the default Valkey's file, a file that names another Valkey than a shell's, and a bad
		// line that hid the URL under a shell's. Each of the first two fails a wrong version of the check: one without the
		// default for a file that names none, and one against the URL the file named at construction.
		now = ctx("default-rotated", { url: { environment: null, file: null } });
		assert.equal(await connectOnce(hidden), "default-rotated", "a file naming no VALKEY_URL speaks for the default Valkey, which this client dials");
		now = ctx("t-first", { url: { environment: "redis://127.0.0.1:1", file: "redis://127.0.0.1:2" } });
		const split = made("redis://127.0.0.1:1", { freshContext: true });
		assert.equal(await connectOnce(split), "t-first", "at start a client takes the file's password for any Valkey on this machine, as before");
		assert.equal(passwordDeclinedOf(split), false, "the password it holds is the file's: nothing to say");
		now = ctx("t-rotated", { url: { environment: "redis://127.0.0.1:1", file: "redis://127.0.0.1:2" } });
		assert.equal(await connectOnce(split), "t-first", "the file never named this client's Valkey: its rotation is not taken");
		assert.equal(passwordDeclinedOf(split), true, "and the decline is recorded, so the console says a restart is needed");
		now = ctx(null, { error: "x", url: { environment: "redis://127.0.0.1:1", file: null } });
		const hiddenShell = made("redis://127.0.0.1:1", { freshContext: true });
		assert.equal(await connectOnce(hiddenShell), null);
		now = ctx("s-found", { url: { environment: "redis://127.0.0.1:1", file: "redis://127.0.0.1:1" } });
		assert.equal(await connectOnce(hiddenShell), "s-found", "the fixed file names the shell's Valkey: taken");
		// The same Valkey spelled another way is the same server: a scheme alias, a database path, a trailing slash and the
		// default port. `localhost` is another name than 127.0.0.1, so its rotation is declined, and said.
		for (const [file, password] of [["valkey://127.0.0.1:1/0", "alias"], ["redis://127.0.0.1:1/", "slash"], ["redis://127.0.0.1:1/3", "database"]]) {
			now = ctx(password, { url: { environment: "redis://127.0.0.1:1", file } });
			assert.equal(await connectOnce(hiddenShell), password, file);
			assert.equal(passwordDeclinedOf(hiddenShell), false, file);
		}
		const onDefault = made("redis://127.0.0.1", { freshContext: true });
		now = ctx("default-port", { url: { environment: null, file: "redis://127.0.0.1:6379/0" } });
		assert.equal(await connectOnce(onDefault), "default-port", "no port is 6379");
		now = ctx("by-name", { url: { environment: "redis://127.0.0.1:1", file: "redis://localhost:1" } });
		assert.equal(await connectOnce(hiddenShell), "database", "localhost is not 127.0.0.1 by name");
		assert.equal(passwordDeclinedOf(hiddenShell), true);
		now = ctx("database", { url: { environment: "redis://127.0.0.1:1", file: "redis://localhost:1" } });
		assert.equal(await connectOnce(hiddenShell), "database");
		assert.equal(passwordDeclinedOf(hiddenShell), false, "the same password as it holds is no news");
		now = ctx(null);
		assert.equal(await connectOnce(fresh), null, "a context that gives none sends none, as a restart would");
		assert.equal(Object.hasOwn(fresh.options, "password"), false);
	} finally {
		for (const c of clients) c.disconnect();
		useValkeyContext(null);
	}
});

/** `promise`, or a failure of its own after `ms`: with the bound gone these reads never end, and a test's `finally` must still run. */
function within(promise, ms = 3000) {
	let timer;
	return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(reject, ms, new Error("no answer within the test's own limit")); })]).finally(() => clearTimeout(timer));
}

test("commandTimeoutMs bounds a persistent client's command while it cannot connect, on real ioredis and no network", { timeout: 8000 }, async () => {
	const client = makeRedisClient("redis://127.0.0.1:1", { context: {}, commandTimeoutMs: 40, judge: async () => { throw new Error("refused"); } });
	client.on("error", () => {});
	try {
		await assert.rejects(within(client.get("x")), /Command timed out/);
	} finally {
		client.disconnect();
	}
});

/** A loopback listener that answers +OK to every command and keeps what it heard, and a judge standing in for the outage. */
async function listeningValkey(onCommand = () => {}) {
	const heard = [];
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("data", (data) => {
			const text = String(data);
			heard.push(text);
			const said = onCommand(text, socket);
			if (said === "silent") return;
			if (said === "refuse") return void socket.write("-ERR refused here\r\n");
			socket.write("+OK\r\n".repeat(text.match(/(?:^|\r\n)\*\d+\r\n/g)?.length ?? 0));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		heard: () => heard.join(""),
		port: server.address().port,
		close: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

test("a command past commandTimeoutMs never goes out when Valkey returns, and one asked later does", { timeout: 15000 }, async () => {
	const valkey = await listeningValkey();
	let down = true;
	const client = makeRedisClient(`redis://127.0.0.1:${valkey.port}`, { context: {}, commandTimeoutMs: 40, judge: async () => { if (down) throw new Error("down"); return { host: "127.0.0.1", servername: null, pinned: null }; } });
	client.on("error", () => {});
	try {
		await assert.rejects(within(client.set("told-it-failed", "1")), /Command timed out/);
		const ready = new Promise((resolve) => client.once("ready", resolve));
		down = false;
		await within(ready);
		assert.equal(await within(client.set("asked-later", "2")), "OK");
		assert.match(valkey.heard(), /asked-later/);
		assert.doesNotMatch(valkey.heard(), /told-it-failed/);
	} finally {
		client.disconnect();
		valkey.close();
	}
});

test("only the command that timed out leaves the offline queue; one still inside its bound stays for Valkey's return", { timeout: 8000 }, async () => {
	const client = makeRedisClient("redis://127.0.0.1:1", { context: {}, commandTimeoutMs: 200, judge: async () => { throw new Error("refused"); } });
	client.on("error", () => {});
	try {
		const first = client.get("first");
		await new Promise((resolve) => setTimeout(resolve, 150));
		const second = client.get("second");
		assert.equal(client.offlineQueue.length, 2);
		await assert.rejects(within(first), /Command timed out/);
		assert.equal(client.offlineQueue.length, 1, "the second is still inside its bound");
		await assert.rejects(within(second), /Command timed out/);
		assert.equal(client.offlineQueue.length, 0, "and nothing that timed out stays behind, however long the outage lasts");
	} finally {
		client.disconnect();
	}
});

test("a command on a connection that died is not sent again on the next one, once commands have a bound", { timeout: 15000 }, async () => {
	const valkey = await listeningValkey((text, socket) => {
		if (!/on-the-wire/.test(text)) return "answer";
		socket.destroy();
		return "silent";
	});
	const judge = async () => ({ host: "127.0.0.1", servername: null, pinned: null });
	const client = makeRedisClient(`redis://127.0.0.1:${valkey.port}`, { context: {}, commandTimeoutMs: 100, judge });
	client.on("error", () => {});
	try {
		await within(new Promise((resolve) => client.once("ready", resolve)));
		const again = new Promise((resolve) => client.once("close", () => client.once("ready", resolve)));
		await assert.rejects(within(client.set("on-the-wire", "1")), /Command timed out/);
		await within(again);
		assert.equal(await within(client.set("after", "2")), "OK");
		assert.equal(valkey.heard().match(/on-the-wire/g).length, 1);
	} finally {
		client.disconnect();
		valkey.close();
	}
});

test("a timed-out command says whether it could still run: not from the offline queue, yes from a socket", { timeout: 8000 }, async () => {
	const offline = makeRedisClient("redis://127.0.0.1:1", { context: {}, commandTimeoutMs: 40, judge: async () => { throw new Error("refused"); } });
	offline.on("error", () => {});
	const valkey = await listeningValkey((text) => (/frozen-write/.test(text) ? "silent" : "answer"));
	const connected = makeRedisClient(`redis://127.0.0.1:${valkey.port}`, { context: {}, commandTimeoutMs: 40, judge: async () => ({ host: "127.0.0.1", servername: null, pinned: null }) });
	connected.on("error", () => {});
	const ready = new Promise((resolve) => connected.once("ready", resolve));
	try {
		const unsent = await within(offline.set("k", "1")).catch((err) => err);
		assert.equal(unsent.code, "ETIMEDOUT");
		assert.equal(unsent.valkeyMayStillRun, undefined);
		await within(ready);
		const sent = await within(connected.set("frozen-write", "1")).catch((err) => err);
		assert.equal(sent.code, "ETIMEDOUT");
		assert.equal(sent.valkeyMayStillRun, true);
	} finally {
		offline.disconnect();
		connected.disconnect();
		valkey.close();
	}
});

test("an error Valkey answered with is no timeout: it stays as it was, with no word about what may still run", { timeout: 8000 }, async () => {
	const valkey = await listeningValkey((text) => (/refused-write/.test(text) ? "refuse" : "answer"));
	const client = makeRedisClient(`redis://127.0.0.1:${valkey.port}`, { context: {}, commandTimeoutMs: 2000, judge: async () => ({ host: "127.0.0.1", servername: null, pinned: null }) });
	client.on("error", () => {});
	try {
		const refused = await within(client.set("refused-write", "1")).catch((err) => err);
		assert.match(refused.message, /refused here/);
		assert.equal(refused.code, undefined);
		assert.equal(refused.valkeyMayStillRun, undefined);
	} finally {
		client.disconnect();
		valkey.close();
	}
});

test("a bound that is not a positive whole number is no bound, and freshContext reaches the client", () => {
	for (const commandTimeoutMs of [0, -1, 1.5, "40", null, Number.NaN]) {
		const client = makeRedisClient("redis://127.0.0.1:1", { context: {}, lazyConnect: true, commandTimeoutMs });
		assert.equal(client.options.commandTimeout, undefined, String(commandTimeoutMs));
		assert.equal(client.options.autoResendUnfulfilledCommands, true, String(commandTimeoutMs));
	}
	const judged = (options) => makeRedisClient("redis://127.0.0.1:1", { lazyConnect: true, ...options }).options.piDispatchValkeyJudge;
	assert.equal(judged({ freshContext: true }).freshContext, true);
	assert.equal(judged({}).freshContext, undefined);
});

test("a command's timer holds no process, so a client told to stop with reads in flight does not wait out their bound", { timeout: 8000 }, async () => {
	const client = makeRedisClient("redis://127.0.0.1:1", { context: {}, commandTimeoutMs: 60_000, judge: async () => { throw new Error("refused"); } });
	client.on("error", () => {});
	const command = new Command("get", ["x"]);
	const answer = client.sendCommand(command).catch((err) => err);
	try {
		assert.equal(command._commandTimeoutTimer.hasRef(), false);
	} finally {
		client.disconnect();
		clearTimeout(command._commandTimeoutTimer);
		command.reject(new Error("the test is done"));
		await answer;
	}
});

test("a client with no command bound stays plain ioredis, so a worker's commands still wait out a restart and are sent again", () => {
	const plain = makeRedisClient("redis://127.0.0.1:1", { context: {}, lazyConnect: true });
	const bounded = makeRedisClient("redis://127.0.0.1:1", { context: {}, lazyConnect: true, commandTimeoutMs: 40 });
	assert.equal(plain.options.commandTimeout, undefined);
	assert.equal(plain.options.autoResendUnfulfilledCommands, true);
	assert.notEqual(Object.getPrototypeOf(plain), Object.getPrototypeOf(bounded));
	assert.equal(bounded.options.commandTimeout, 40);
	assert.equal(bounded.options.autoResendUnfulfilledCommands, false);
});

// ── issue #867: parseConnection's command bound, for the one-shot BullMQ queues of `pi-dispatch cancel` ─────────────

const judgeHere = async () => ({ host: "127.0.0.1", servername: null, pinned: null });

test("parseConnection's command bound is for a failFast client only, so a worker's persistent connection cannot carry one (#867)", () => {
	// A Worker's blocking read waits longer than any bound by design, and a persistent client keeps an offline queue, from
	// which ioredis would send a command that timed out once Valkey returns.
	assert.throws(() => parseConnection("redis://127.0.0.1:1", { context: {}, commandTimeoutMs: 5000 }), (err) => err instanceof TypeError && /failFast/.test(err.message));
	const bounded = parseConnection("redis://127.0.0.1:1", { context: {}, failFast: true, commandTimeoutMs: 5000 });
	assert.equal(bounded.commandTimeout, 5000);
	assert.equal(bounded.autoResendUnfulfilledCommands, false, "what the caller was told failed is never sent again on a later connection");
	assert.equal(bounded.enableOfflineQueue, false);
	assert.equal(bounded.piDispatchValkeyJudge.commandBound, true);
	for (const options of [{}, { failFast: true }, ...[0, -1, 1.5, "40", null, Number.NaN].map((commandTimeoutMs) => ({ failFast: true, commandTimeoutMs }))]) {
		const plain = parseConnection("redis://127.0.0.1:1", { context: {}, ...options });
		assert.equal(plain.commandTimeout, undefined, JSON.stringify(options));
		assert.equal(plain.autoResendUnfulfilledCommands, undefined, JSON.stringify(options));
		assert.equal(plain.piDispatchValkeyJudge.commandBound, undefined, JSON.stringify(options));
	}
});

test("a bounded failFast client says a command that reached a silent Valkey may still run, not one Valkey refused, and its timer holds no process (#867)", { timeout: 8000 }, async () => {
	const valkey = await listeningValkey((text) => (/frozen-write/.test(text) ? "silent" : /refused-write/.test(text) ? "refuse" : "answer"));
	const client = new Redis(parseConnection(`redis://127.0.0.1:${valkey.port}`, { context: {}, judge: judgeHere, failFast: true, commandTimeoutMs: 100 }));
	client.on("error", () => {});
	try {
		await within(new Promise((resolve) => client.once("ready", resolve)));
		// The refusal first: replies are matched in order, so after a command that is never answered nothing is.
		const refused = await within(client.set("refused-write", "1")).catch((err) => err);
		assert.match(refused.message, /refused here/);
		assert.equal(refused.valkeyMayStillRun, undefined, "Valkey answered");
		assert.equal(refused.code, undefined);
		const command = new Command("set", ["frozen-write", "1"]);
		const sent = client.sendCommand(command).catch((err) => err);
		assert.equal(command._commandTimeoutTimer.hasRef(), false, "a one-shot that said its last line does not wait out a bound nobody awaits");
		const lost = await within(sent);
		assert.equal(lost.message, "Command timed out");
		assert.equal(lost.code, "ETIMEDOUT");
		assert.equal(lost.valkeyMayStillRun, true, "it reached the socket, so Valkey may run it when it wakes");
	} finally {
		client.disconnect();
		valkey.close();
	}
	// Refused at once, never written (no connection, and no offline queue to wait in): no word about what may still run.
	const unsent = await within(client.get("after-the-end")).catch((err) => err);
	assert.match(unsent.message, /Connection is closed|Stream isn't writeable/);
	assert.equal(unsent.valkeyMayStillRun, undefined);
	// A client without the bound is left as ioredis made it: a worker's, a receiver's, every other failFast queue's.
	const plain = new Redis(parseConnection("redis://127.0.0.1:1", { context: {}, failFast: true, lazyConnect: true }));
	const planned = new Command("get", ["x"]);
	const answer = plain.sendCommand(planned).catch((err) => err);
	assert.equal(planned._commandTimeoutTimer, undefined);
	plain.disconnect();
	await answer;
});

test("the hook marks nothing on a client without the bound: a written command's lost answer on any other client carries no mark (#867)", { timeout: 15000 }, async () => {
	// The console branches on `valkeyMayStillRun` (a confirm's "may or may not", an audit row's reason, the panel's note),
	// so a mark leaking onto its clients would change what it says. Each client below writes a command Valkey never
	// answers and is then dropped, so the command fails with "Connection is closed.", a lost answer by the hook's rule.
	const valkey = await listeningValkey((text) => (/frozen-write/.test(text) ? "silent" : "answer"));
	const url = `redis://127.0.0.1:${valkey.port}`;
	const clients = {
		"a plain client (a worker's, a receiver's)": () => makeRedisClient(url, { context: {}, judge: judgeHere }),
		"a BoundedRedis (cancel's probe, the console's own)": () => makeRedisClient(url, { context: {}, judge: judgeHere, commandTimeoutMs: 60_000 }),
		"a failFast queue client without the bound (the console's fleet reader)": () => new Redis(parseConnection(url, { context: {}, judge: judgeHere, failFast: true })),
		"a failFast client with the bound": () => new Redis(parseConnection(url, { context: {}, judge: judgeHere, failFast: true, commandTimeoutMs: 60_000 })),
	};
	const marks = {};
	try {
		for (const [name, make] of Object.entries(clients)) {
			const client = make();
			client.on("error", () => {});
			await within(new Promise((resolve) => client.once("ready", resolve)));
			const answer = client.set("frozen-write", "1").catch((err) => err);
			await new Promise((resolve) => setImmediate(resolve));
			client.disconnect();
			const err = await within(answer);
			assert.equal(err.message, "Connection is closed.", name);
			marks[name] = err.valkeyMayStillRun;
		}
	} finally {
		valkey.close();
	}
	assert.deepEqual(marks, {
		"a plain client (a worker's, a receiver's)": undefined,
		"a BoundedRedis (cancel's probe, the console's own)": undefined,
		"a failFast queue client without the bound (the console's fleet reader)": undefined,
		"a failFast client with the bound": true,
	});
});

/**
 * A loopback proxy to the real Valkey that can stop passing bytes either way and later pass what it held, in order: a
 * `kill -STOP` and a `kill -CONT` of that Valkey as one client sees them, without a Valkey process of the test's own.
 */
async function freezingProxy(target) {
	const to = new URL(target);
	let frozen = false;
	const held = [];
	const sockets = new Set();
	const server = createServer((client) => {
		const upstream = netConnect({ host: to.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(to.port || 6379) });
		for (const s of [client, upstream]) {
			sockets.add(s);
			s.on("error", () => {});
		}
		client.on("data", (data) => (frozen ? held.push([upstream, data]) : upstream.write(data)));
		upstream.on("data", (data) => (frozen ? held.push([client, data]) : client.write(data)));
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const via = new URL(target);
	via.hostname = "127.0.0.1";
	via.port = String(server.address().port);
	return {
		url: via.toString(),
		freeze: () => (frozen = true),
		thaw: () => {
			frozen = false;
			for (const [socket, data] of held.splice(0)) socket.write(data);
		},
		close: () => {
			for (const s of sockets) s.destroy();
			server.close();
		},
	};
}

test("a BullMQ queue with the bound reads as before, and its remove on a Valkey that stops answering ends at the bound, marked, and lands when Valkey wakes (#867, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 20_000 }, async () => {
	const { makeQueue } = await import("../src/queue.mjs");
	const target = process.env.VALKEY_TEST_URL;
	const proxy = await freezingProxy(target);
	const name = `pi-jobs-test-867-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const direct = makeQueue(parseConnection(target, { failFast: true }), { name });
	const bounded = makeQueue(parseConnection(proxy.url, { failFast: true, commandTimeoutMs: 300, context: {}, judge: judgeHere }), { name });
	try {
		// The remove script in Valkey's cache first: a remove that waited out a NOSCRIPT would never be sent as EVAL.
		const scratch = await direct.add("t", {}, { delay: 600_000 });
		await direct.remove(scratch.id);
		const added = await direct.add("t", { n: 1 }, { delay: 600_000 });
		const job = await within(bounded.getJob(added.id));
		assert.equal(job?.id, added.id, "a Valkey that answers is read through the bound as before");
		assert.equal(await within(job.getState()), "delayed");
		proxy.freeze();
		const started = performance.now();
		const lost = await within(job.remove()).catch((err) => err);
		assert.equal(lost.message, "Command timed out");
		assert.equal(lost.code, "ETIMEDOUT");
		assert.equal(lost.valkeyMayStillRun, true);
		assert.ok(performance.now() - started < 2000, "ended at the bound");
		assert.equal((await direct.getJob(added.id))?.id, added.id, "nothing has reached Valkey yet");
		proxy.thaw();
		const until = Date.now() + 5000;
		while ((await direct.getJob(added.id)) !== undefined && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(await direct.getJob(added.id), undefined, "the remove the client gave up on ran once Valkey read it: may or may not, never 'nothing was changed'");
	} finally {
		proxy.thaw();
		await bounded.close().catch(() => {});
		await direct.obliterate({ force: true }).catch(() => {});
		await direct.close().catch(() => {});
		proxy.close();
	}
});
