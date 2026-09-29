import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConnection } from "../src/connection.mjs";

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
	const { DB_REFUSED, defaultValkeyContext, judgeValkeyAtStart, makeRedisClient, valkeyAuthState } = await import("../src/connection.mjs");
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
