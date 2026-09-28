import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { JudgedConnector, assertJudgedConnection, isJudgedConnection, makeRedisClient, parseConnection } from "../src/connection.mjs";
import { makeQueue } from "../src/queue.mjs";
import { PINNED, judgedEndpoint, valkeyClientContext } from "../src/valkey-endpoint.mjs";

// Issue #464, gate round 2 follow-up: EVERY Valkey client in the repo goes through one judge-and-pin function
// (valkey-endpoint.mjs), by construction: connection.mjs builds each ioredis and BullMQ client with JudgedConnector,
// and makeQueue and the worker refuse any other connection. During another account's [::1] squat, `pi-dispatch run`
// with VALKEY_URL=localhost used to carry a job's task text to that account's Valkey (measured on Fedora 44).

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TREES = ["worker/src", "receiver/src", "admin/src", "image/runner"];
const SKIP_DIRS = new Set(["test", "node_modules", "dist"]);
const EXTS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts"]);

function sources() {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(p);
			} else if (EXTS.has(extname(name))) out.push(p);
		}
	};
	for (const tree of TREES) walk(join(REPO_ROOT, tree));
	return out.map((p) => ({ path: relative(REPO_ROOT, p), code: stripComments(readFileSync(p, "utf8")) }));
}

/** Code without comments, so a comment that merely mentions a constructor is not a construction. */
function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// Every way this codebase could open a Valkey connection, and the ONE file allowed to do each. Gate round 3: the
// libraries are matched as ANY string literal naming them, in any quote style, subpaths included, so a backtick import,
// a `require` or a specifier held in a variable are caught alike; `createRequire` only where pi's own packages are
// loaded by path, and a dynamic import whose specifier is not a plain literal (a computed one) only in the files that
// load a module by variable for their own reasons (the runner's pi loaders, and doctor's canary script, which is a
// string it hands a container).
const LIB = (name) => new RegExp(`["'\`]${name}(?:/[^"'\`]*)?["'\`]`);
const RULES = [
	{ what: "the ioredis driver", re: LIB("ioredis"), allowed: ["worker/src/connection.mjs"] },
	{ what: "the bullmq library", re: LIB("bullmq"), allowed: ["worker/src/queue.mjs", "worker/src/index.mjs"] },
	// The two that load pi's own packages (undici, pi-coding-agent's keys) by pi's install path; neither names a Valkey library.
	{ what: "createRequire", re: /\bcreateRequire\b/, allowed: ["admin/src/keys.mjs", "image/runner/src/env-proxy.mjs"] },
	{ what: "a computed dynamic import", re: /\bimport\(\s*(?:[^"'`\s)]|`[^`]*\$\{)/, allowed: ["image/runner/src/env-proxy.mjs", "image/runner/src/usage-meter.mjs", "image/runner/src/outcome.mjs", "worker/src/doctor.mjs"] },
	{ what: "an ioredis client constructor", re: /new\s+(Redis|IORedis|ioredis|Cluster)\s*\(|\bcreateClient\s*\(/, allowed: ["worker/src/connection.mjs"] },
	{ what: "a BullMQ Queue, QueueEvents or FlowProducer", re: /new\s+(Queue|QueueEvents|FlowProducer)\s*\(/, allowed: ["worker/src/queue.mjs"] },
	{ what: "a BullMQ Worker", re: /new\s+Worker\s*\(/, allowed: ["worker/src/index.mjs"] },
];

test("no file constructs a Valkey client except through connection.mjs' judged connection (the bolt, #464)", () => {
	const files = sources();
	assert.ok(files.some((f) => f.path.startsWith("receiver/src/")) && files.some((f) => f.path.startsWith("admin/src/")), "the scan reaches the receiver and the admin");
	const offenders = [];
	for (const rule of RULES) {
		for (const f of files) {
			if (rule.re.test(f.code) && !rule.allowed.includes(f.path)) offenders.push(`${f.path}: ${rule.what}`);
		}
	}
	assert.deepEqual(offenders, [], "open Valkey only through parseConnection/makeRedisClient (worker/src/connection.mjs) and makeQueue; the receiver and the admin import them from @edgehero/pi-dispatch/connection");
	// The two allowed BullMQ constructions assert the connection is judged right before they build on it.
	const at = (path) => files.find((f) => f.path === path).code;
	assert.match(at("worker/src/queue.mjs"), /assertJudgedConnection\(connection\);\s*const queue = new Queue\(/);
	assert.match(at("worker/src/index.mjs"), /assertJudgedConnection\(connection\);\s*worker = new Worker\(/);
	// Issue #468: and each carries the one-line `error` listener, so BullMQ never prints the whole error object.
	assert.match(at("worker/src/queue.mjs"), /const queue = new Queue\([^;]*\);\s*onValkeyError\(queue, /);
	assert.match(at("worker/src/index.mjs"), /worker = new Worker\([\s\S]*?\}\);\s*onValkeyError\(worker, /);
	// And connection.mjs' own client is built from parseConnection's options, never from a bare URL.
	assert.match(at("worker/src/connection.mjs"), /return new Redis\(\{ \.\.\.parseConnection\(url,/);
	assert.equal((at("worker/src/connection.mjs").match(/new Redis\(/g) ?? []).length, 1);
	// Non-vacuity: the sites that DO connect are there to be found, in all three packages.
	const users = files.filter((f) => /\b(parseConnection|makeRedisClient)\b/.test(f.code)).map((f) => f.path);
	for (const expected of ["worker/src/start.mjs", "worker/src/cli.mjs", "worker/src/cancel-cli.mjs", "worker/src/doctor.mjs", "worker/src/service.mjs", "receiver/src/start.mjs", "receiver/src/route.mjs", "receiver/src/poller.mjs", "admin/src/read-model.mjs", "admin/src/dashboard.ts"]) {
		assert.ok(users.includes(expected), `${expected} opens its Valkey clients through connection.mjs`);
	}
	for (const rule of RULES) assert.equal(rule.re.test(""), false);
	// The patterns catch what gate round 3 bypassed the first set with, in every quote style.
	const matches = (what, code) => RULES.find((r) => r.what === what).re.test(code);
	for (const code of ['import Redis from "ioredis";', "import(`ioredis`)", "const m = require('ioredis');", 'import x from "ioredis/built/Redis.js";', "const spec = `ioredis`; await import(spec);"]) assert.equal(matches("the ioredis driver", code), true, code);
	for (const code of ['import { Queue } from "bullmq";', "await import(`bullmq`)"]) assert.equal(matches("the bullmq library", code), true, code);
	assert.equal(matches("createRequire", 'import { createRequire } from "node:module";'), true);
	assert.equal(matches("a computed dynamic import", "await import(name)"), true);
	assert.equal(matches("a computed dynamic import", "await import(`${a}redis`)"), true);
	assert.equal(matches("a computed dynamic import", 'await import("./x.mjs")'), false, "a literal specifier is a plain import");
	assert.equal(matches("the ioredis driver", "ioredisish"), false);
	assert.equal(matches("an ioredis client constructor", "new Redis(url)"), true);
	assert.equal(matches("a BullMQ Queue, QueueEvents or FlowProducer", "new Queue(name, { connection })"), true);
});

// Issue #468: the credential is part of the ONE connection function too. Every client of the project (the worker, the
// CLI, the receiver, the admin panel, doctor) is built by parseConnection, so the password is attached there and nowhere
// else, and VALKEY_PASSWORD is read from a process environment in one place (`valkeyClientContext`). A client that
// took its own password, or a file that read the variable itself, would be a second rule for which password goes where.
test("a Valkey client's password is attached by parseConnection alone, and VALKEY_PASSWORD is read from an environment in one place (#468)", () => {
	// A client's options come from parseConnection (the bolt above holds every construction to connection.mjs); what
	// could still carry a password of its own is a caller passing one IN (a `password:` in the arguments of
	// parseConnection, makeRedisClient or makeQueue), or reading the variable itself and handing it on.
	const passes = /\b(?:parseConnection|makeRedisClient|makeQueue|parseConnectionFn|redisFn|makeQueueFn)\([^;]*\bpassword\s*:/;
	const reads = /\benv\.VALKEY_PASSWORD\b|\benv\[\s*(?:VALKEY_PASSWORD_KEY|"VALKEY_PASSWORD")\s*\]|process\.env\.VALKEY_PASSWORD\b/;
	const files = sources();
	const offenders = [];
	for (const f of files) {
		if (passes.test(f.code) && f.path !== "worker/src/connection.mjs") offenders.push(`${f.path}: passes a password to a client`);
		if (reads.test(f.code) && f.path !== "worker/src/valkey-endpoint.mjs") offenders.push(`${f.path}: reads VALKEY_PASSWORD from an environment`);
	}
	assert.deepEqual(offenders, [], "attach the password in parseConnection (valkeyPasswordFor) and read it in valkeyClientContext");
	// Non-vacuity: the one place each happens is where the rule says, in the shape the pattern looks for.
	const at = (path) => files.find((f) => f.path === path).code;
	assert.match(at("worker/src/connection.mjs"), /const \{ password \} = valkeyPasswordFor\(url, where, \{ withoutPassword \}\);[\s\S]*\.\.\.\(password \? \{ password \} : \{\}\)/);
	assert.match(at("worker/src/valkey-endpoint.mjs"), reads);
	for (const code of ["makeRedisClient(url, { password: x })", "parseConnection(u, { failFast: true, password: p })", "makeQueue({ ...c, password: pw })"]) assert.ok(passes.test(code), code);
	for (const code of ["const p = env.VALKEY_PASSWORD;", 'env["VALKEY_PASSWORD"]', "process.env.VALKEY_PASSWORD", "env[VALKEY_PASSWORD_KEY]"]) assert.ok(reads.test(code), code);
	assert.equal(reads.test("dockerEnv[VALKEY_PASSWORD_KEY] = pw"), false, "a spawn environment being SET is not a read");
	assert.equal(passes.test("makeRedisClient(url, { failFast: true }); const x = { password: 1 }"), false, "only inside the call");
});

test("every connection parseConnection and makeRedisClient build is judged; makeQueue refuses any other (#464)", () => {
	const c = parseConnection("redis://localhost:6379", { context: { rootRefused: false, shared: false, envPath: "/d/.env", error: null } });
	assert.equal(c.Connector, JudgedConnector);
	assert.equal(isJudgedConnection(c), true);
	assert.equal(isJudgedConnection({ ...c, maxRetriesPerRequest: null }), true, "a spread copy (BullMQ's, the worker's) stays judged");
	assert.equal(isJudgedConnection({ host: "127.0.0.1", port: 6379 }), false);
	assert.equal(isJudgedConnection({ host: "127.0.0.1", Connector: JudgedConnector }), false, "the Connector alone, without what it judges, is not enough");
	assert.throws(() => makeQueue({ host: "127.0.0.1", port: 6379 }), /a Valkey connection must be built by parseConnection/);
	assert.throws(() => assertJudgedConnection(undefined), TypeError);
	const r = makeRedisClient("redis://localhost:6379", { lazyConnect: true, context: { rootRefused: false, shared: false, envPath: "/d/.env", error: null } });
	try {
		assert.equal(isJudgedConnection(r), true, "an ioredis client, judged by its options");
		assert.equal(isJudgedConnection(r.duplicate({ lazyConnect: true })), true, "and its duplicates (BullMQ's blocking connections)");
	} finally {
		r.disconnect();
	}
});

test("JudgedConnector dials the judged address, and a judgement that throws never ends the client: a refusal is its error, retried by its strategy (#464)", { timeout: 20_000 }, async () => {
	const url = process.env.VALKEY_TEST_URL;
	const asked = [];
	const errors = [];
	const refusing = makeRedisClient("redis://localhost:6379", {
		lazyConnect: true,
		failFast: true,
		judge: async (u, ctx) => {
			asked.push([u, ctx.rootRefused]);
			throw Object.assign(new Error("the Valkey VALKEY_URL reaches is refused: [::1]:6379 is held by op2 (uid 1235)"), { piDispatchConfig: true, valkeyRefused: true });
		},
		context: { rootRefused: true, shared: false, envPath: "/d/.env", error: null },
	});
	refusing.on("error", (e) => errors.push(e.message));
	await assert.rejects(refusing.connect());
	for (let i = 0; i < 50 && asked.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
	refusing.disconnect();
	assert.deepEqual(asked[0], ["redis://localhost:6379", true]);
	assert.ok(asked.length >= 2, "judged again on each retry of its strategy (failFast: a few), never ended by the first");
	assert.match(errors[0], /refused: \[::1\]:6379 is held by op2/, "the refusal is the client's error, in its words");
	// Only the refusal, never a ready check on a dead stream: measured on the VMs when the socket was destroyed a tick
	// after ioredis looked at it ("Stream isn't writeable and enableOfflineQueue options is false" beside each one).
	assert.deepEqual(errors.filter((m) => !/refused: \[::1\]:6379 is held by op2/.test(m)), []);
	if (!url) return; // the dialled half needs a Valkey (CI runs it)
	const { hostname, port } = new URL(url);
	const client = makeRedisClient(`redis://valkey-name-never-resolves.invalid:${port}`, { lazyConnect: true, failFast: true, judge: async () => ({ host: hostname, servername: null, pinned: hostname }) });
	client.on("error", () => {});
	try {
		await client.connect();
		assert.equal(await client.ping(), "PONG", "the connector dialled the judged address, not the name in the URL");
		assert.equal(client.stream.remoteAddress, hostname);
	} finally {
		client.disconnect();
	}
});

// Gate round 3, item 1 (measured against ioredis 5.11.1): a judgement that threw while the Valkey restarted rejected
// connect(), and ioredis then set the client's status to "end" and never retried: every job after one Valkey restart
// failed "Connection is closed.". The judgement now fails the socket instead, and ioredis retries and judges again.
test("a client whose judgement fails while the Valkey restarts reconnects when it answers again, never \"end\" (#464)", { timeout: 30_000 }, async (t) => {
	const url = process.env.VALKEY_TEST_URL;
	if (!url) return t.skip("needs a Valkey (VALKEY_TEST_URL); CI runs it");
	const { hostname } = new URL(url);
	let failures = 3;
	const statuses = [];
	const client = makeRedisClient(url, {
		lazyConnect: true,
		judge: async () => {
			if (failures > 0) {
				failures -= 1;
				throw Object.assign(new Error("nothing answers VALKEY_URL (127.0.0.1:6399), so whose Valkey it is cannot be judged yet"), { valkeyRetryable: true });
			}
			return { host: hostname, servername: null, pinned: hostname };
		},
	});
	const errors = [];
	client.on("error", (e) => errors.push(e.message));
	client.on("end", () => statuses.push("end"));
	try {
		client.connect().catch(() => {});
		assert.equal(await client.ping(), "PONG", "the command waited in the offline queue and ran once the judgement passed");
		assert.equal(failures, 0, "three failed judgements, each retried");
		assert.deepEqual(statuses, [], "the client never ended");
		// Measured on the VMs with the socket destroyed a tick late: ioredis took it as connected and its ready check
		// failed on the dead stream, beside every failed judgement.
		assert.deepEqual(errors.filter((m) => !/^nothing answers VALKEY_URL/.test(m)), [], "only the judgement's own error, never a ready check on a dead stream");
		assert.equal(errors.length, 3);
		assert.equal(client.status, "ready");
	} finally {
		client.disconnect();
	}
});

// Gate round 3, M2: the TLS servername is kept on a pinned connect, so a certificate for the name still verifies.
test("a pinned rediss: connect is made to the judged address with the URL's name as the TLS servername (#464)", async () => {
	const dialled = [];
	const saved = JudgedConnector.dial;
	JudgedConnector.dial = {
		net: saved.net,
		tls: (opts) => {
			dialled.push(opts);
			const s = new Socket();
			process.nextTick(() => s.destroy(new Error("test: not dialled")));
			return s;
		},
	};
	const client = makeRedisClient("rediss://valkey.example:6380", { lazyConnect: true, failFast: true, judge: async () => ({ host: "127.0.0.1", servername: "valkey.example", pinned: "127.0.0.1" }) });
	client.on("error", () => {});
	try {
		await client.connect().catch(() => {});
		assert.equal(dialled[0].host, "127.0.0.1");
		assert.equal(dialled[0].port, 6380);
		assert.equal(dialled[0].servername, "valkey.example");
	} finally {
		JudgedConnector.dial = saved;
		client.disconnect();
	}
});

const TCP_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row4 = (addr, port, uid) => `   3: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`;
const row6 = (addr, port, uid) => `   1: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`;
const factsWith = (files, extra = {}) => ({
	fs: { readFileSync: (p) => ({ "/proc/net/tcp": TCP_HEAD, "/proc/net/tcp6": TCP_HEAD, "/etc/subuid": "", ...files })[p] ?? "" },
	euid: 1234,
	user: "tester",
	subuids: { ranges: [], source: "/etc/subuid" },
	probeTcp: async () => true,
	lookup: async (host) => (host === "localhost" ? [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]),
	interfaces: () => ({}),
	ownerName: (u) => ({ 1235: "op2" })[u] ?? null,
	...extra,
});

test("judgedEndpoint: the localhost squat pins this account's 127.0.0.1 for every client, resolved once and re-judged on each connect (#464)", async () => {
	const cache = new Map();
	// This account's Valkey on 127.0.0.1, another account's on [::1] of the same port (the gate's defect 2).
	const squat = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1234)}`, "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1235)}` };
	for (const rootRefused of [false, true]) {
		const ep = await judgedEndpoint("redis://localhost:16483", { rootRefused, shared: false, envPath: "/d/.env", error: null }, { cache, facts: factsWith(squat) });
		assert.deepEqual(ep, { host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }, `rootRefused ${rootRefused}: never the other account's ::1`);
	}
	// Resolved ONCE: a later connect does not ask DNS again, and a DNS answer that changed cannot move it.
	let lookups = 0;
	const again = await judgedEndpoint("redis://localhost:16483", { rootRefused: true, shared: false, envPath: "/d/.env", error: null }, { cache, facts: factsWith(squat, { lookup: async () => (lookups++, [{ address: "::1", family: 6 }]) }) });
	assert.equal(again.host, "127.0.0.1");
	assert.equal(lookups, 0);
	// Re-judged on each connect: our Valkey gone and another account on 127.0.0.1 meanwhile is refused.
	const taken = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` };
	await assert.rejects(judgedEndpoint("redis://localhost:16483", { rootRefused: false, shared: false, envPath: "/d/.env", error: null }, { cache, facts: factsWith(taken) }), (err) => err.piDispatchConfig === true && err.valkeyRefused === true && /127\.0\.0\.1:16483 is held by op2/.test(err.message));
});

// Gate round 3's simpler rule: another account's listener is refused by EVERY client, whatever the cwd or the venue;
// root's only where the podman venue is the deployment's without `local`.
test("judgedEndpoint: another account's listener is refused on every venue, root's only where root is refused; the opt-in and the .env's facts decide the rest (#464)", async () => {
	const theirs = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 6379, 1235)}` };
	const root = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 6379, 0)}` };
	const ctx = (rootRefused, shared = false, error = null) => ({ rootRefused, shared, envPath: "/d/.env", error });
	for (const rootRefused of [false, true]) {
		await assert.rejects(judgedEndpoint("redis://127.0.0.1:6379", ctx(rootRefused), { cache: new Map(), facts: factsWith(theirs) }), /refused: 127\.0\.0\.1:6379 is held by op2 \(uid 1235\)/, `item 7 and defect 2: rootRefused ${rootRefused}`);
		assert.equal((await judgedEndpoint("redis://127.0.0.1:6379", ctx(rootRefused, true), { cache: new Map(), facts: factsWith(theirs) })).host, "127.0.0.1", "PI_VALKEY_SHARED=1 from the .env");
	}
	assert.equal((await judgedEndpoint("redis://0.0.0.0:6379", ctx(false), { cache: new Map(), facts: factsWith(root) })).host, "127.0.0.1", "docker-proxy (root) on the local venue: accepted, pinned to what 0.0.0.0 reaches");
	assert.equal((await judgedEndpoint("redis://127.0.0.1:6379", ctx(false), { cache: new Map(), facts: factsWith({}) })).host, "127.0.0.1", "no socket row (docker's NAT, root's doing) on the local venue: accepted");
	await assert.rejects(judgedEndpoint("redis://127.0.0.1:6379", ctx(true), { cache: new Map(), facts: factsWith(root) }), /refused: 127\.0\.0\.1:6379 is held by root/, "root where the podman venue is the deployment's");
	// A .env that could not be read: neither the opt-in nor the venue can be told, so only this account's own is taken.
	await assert.rejects(judgedEndpoint("redis://127.0.0.1:6379", ctx(false, false, "/d/.env line 2 has a NUL byte"), { cache: new Map(), facts: factsWith(root) }), (err) => err.valkeyRefused === true && /held by root, not by this account, and \/d\/\.env line 2 has a NUL byte, so whether it may be used cannot be told/.test(err.message));
	const own = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 6379, 1234)}` };
	assert.equal((await judgedEndpoint("redis://127.0.0.1:6379", ctx(true, false, "/d/.env could not be read (EACCES)"), { cache: new Map(), facts: factsWith(own) })).host, "127.0.0.1", "this account's own needs no fact of the file");
	assert.deepEqual(await judgedEndpoint("redis://queue.lan:6379", ctx(true), { cache: new Map(), facts: factsWith({}) }), { host: "queue.lan", servername: null, pinned: null });
	assert.equal((await judgedEndpoint("rediss://localhost:6379", ctx(false), { cache: new Map(), facts: factsWith(own, { probeTcp: async (h) => h === "127.0.0.1" }) })).servername, "localhost", "a rediss: name kept for TLS");
	const cache = new Map();
	await assert.rejects(judgedEndpoint("redis://127.0.0.1:6379", ctx(true), { cache, facts: factsWith({}, { probeTcp: async () => false }) }), (err) => err.valkeyRetryable === true && /^nothing answers VALKEY_URL/.test(err.message));
	assert.equal(cache.size, 0, "a failed judgement pins nothing; the next connect judges afresh");
	assert.ok(PINNED instanceof Map);
});

// Gate round 3, item 4: a lookup that failed or timed out was read as "another host", and the name dialled unjudged.
test("judgedEndpoint: a name that does not resolve, or a resolver that does not answer, is a judgement to retry, never another host (#464)", async () => {
	const lookups = [
		async () => {
			throw Object.assign(new Error("getaddrinfo EAI_AGAIN localhost"), { code: "EAI_AGAIN" });
		},
		async () => [],
	];
	for (const lookup of lookups) {
		await assert.rejects(judgedEndpoint("redis://localhost:6379", { rootRefused: true, shared: false, envPath: "/d/.env", error: null }, { cache: new Map(), facts: factsWith({}, { lookup }) }), (err) => err.valkeyRetryable === true && /^VALKEY_URL's host localhost did not resolve here/.test(err.message));
	}
});

test("judgeValkeyAtStart: a refusal at once, a retryable judgement retried until it passes or the wait ends (#464)", async () => {
	const { judgeValkeyAtStart } = await import("../src/valkey-endpoint.mjs");
	let clock = 0;
	const opts = (judge, waitMs = 2000) => ({ waitMs, now: () => clock, sleep: async (ms) => { clock += ms; }, judge });
	const refusal = Object.assign(new Error("refused"), { valkeyRefused: true, piDispatchConfig: true });
	let n = 0;
	await assert.rejects(judgeValkeyAtStart("redis://x", {}, opts(async () => { n++; throw refusal; })), (e) => e === refusal);
	assert.equal(n, 1, "a refusal is not retried");
	const late = await judgeValkeyAtStart("redis://x", {}, opts(async () => { if (clock < 1000) throw Object.assign(new Error("nothing answers"), { valkeyRetryable: true }); return { host: "127.0.0.1" }; }));
	assert.equal(late.host, "127.0.0.1");
	clock = 0;
	await assert.rejects(judgeValkeyAtStart("redis://x", {}, opts(async () => { throw Object.assign(new Error("nothing answers"), { valkeyRetryable: true }); })), (e) => e.valkeyRetryable === true && !e.piDispatchConfig);
	assert.ok(clock >= 2000, "waited the whole window");
});

test("valkeyClientContext: root refused on the podman venue without local on Linux, PI_VALKEY_SHARED from the .env only, never from the environment, and a .env the hardened reader refuses is an error, never dropped (#464)", () => {
	const readEnv = (text) => () => Buffer.from(text);
	const none = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "podman" }, cwd: "/d", platform: "linux", readEnv: none }).rootRefused, true);
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "local,podman" }, cwd: "/d", platform: "linux", readEnv: none }).rootRefused, false, "docker's Valkey is the queue");
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "podman" }, cwd: "/d", platform: "darwin", readEnv: none }).rootRefused, false, "no /proc to judge by");
	assert.equal(valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=podman\n") }).rootRefused, true);
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "local" }, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=podman\n") }).rootRefused, false, "this environment's PI_BACKENDS first");
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "podman" }, cwd: "/d", platform: "linux", readEnv: none, rootRefused: false }).rootRefused, false, "a caller's own decision wins");
	// PI_VALKEY_SHARED: the deployment's .env, never the environment, not even with no .env found (see the module).
	assert.equal(valkeyClientContext({ env: { PI_VALKEY_SHARED: "1" }, cwd: "/d", platform: "linux", readEnv: none }).shared, false, "no .env: never the environment's");
	assert.equal(valkeyClientContext({ env: { PI_VALKEY_SHARED: "1" }, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=podman\n") }).shared, false, "nor over a .env that does not say it");
	assert.equal(valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: readEnv("PI_VALKEY_SHARED=1\n") }).shared, true);
	const ok = valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: none });
	assert.deepEqual([ok.envPath, ok.error], ["/d/.env", null]);
	// Gate round 3, item 5: bytes through the hardened reader. A lone CR (systemd splits the line, this reader would not),
	// a NUL (systemd refuses the file) and a line the loaders read differently are errors, none read as "no opt-in".
	for (const [content, re] of [["PI_VALKEY_SHARED=1\rPI_BACKENDS=podman\n", /carriage return/], ["PI_BACKENDS=podman\nX=\u0000\n", /line 2 has a NUL byte/], ["VALKEY_URL=redis://[::1]:1\n", /unquoted \[ or \]/]]) {
		const c = valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: readEnv(content) });
		assert.match(String(c.error), re, JSON.stringify(content));
		assert.equal(c.shared, false);
	}
	// A line only the venue's reader refuses (a $ in PI_BACKENDS): the venue is then unknown, and that is an error too.
	const venue = valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=pod$man\n") });
	assert.match(String(venue.error), /PI_BACKENDS/);
	const denied = valkeyClientContext({
		env: {},
		cwd: "/d",
		platform: "linux",
		readEnv: () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		},
	});
	assert.equal(denied.error, "/d/.env could not be read (EACCES)");
	// Bytes the decoder would have hidden: invalid UTF-8 in a value is a load hazard only a byte read can see.
	const bad = valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: () => Buffer.concat([Buffer.from("PI_BACKENDS="), Buffer.from([0xff]), Buffer.from("\n")]) });
	assert.match(String(bad.error), /UTF-8/);
});

test("the worker's clients are enforced exactly as its boot judgement was (#464)", async () => {
	const { workerValkeyContext } = await import("../src/start.mjs");
	const none = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	assert.equal(workerValkeyContext({ rootRefused: true }, {}, { cwd: "/d", readEnv: none }).rootRefused, true, "a boot that refused root");
	assert.equal(workerValkeyContext({ rootRefused: false }, { PI_BACKENDS: "podman" }, { cwd: "/d", readEnv: none }).rootRefused, false, "a boot on docker's venue");
	assert.equal(workerValkeyContext({}, {}, { cwd: "/d", readEnv: () => "PI_VALKEY_SHARED=1\n" }).shared, true);
});
