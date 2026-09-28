import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
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

// Every way this codebase could open a Valkey connection, and the ONE file allowed to do each.
const RULES = [
	{ what: "the ioredis driver", re: /from\s+["']ioredis["']|import\(\s*["']ioredis["']\s*\)|require\(\s*["']ioredis["']\s*\)/, allowed: ["worker/src/connection.mjs"] },
	{ what: "the bullmq library", re: /from\s+["']bullmq["']|import\(\s*["']bullmq["']\s*\)|require\(\s*["']bullmq["']\s*\)/, allowed: ["worker/src/queue.mjs", "worker/src/index.mjs"] },
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
	assert.match(at("worker/src/queue.mjs"), /assertJudgedConnection\(connection\);\s*return new Queue\(/);
	assert.match(at("worker/src/index.mjs"), /assertJudgedConnection\(connection\);\s*worker = new Worker\(/);
	// And connection.mjs' own client is built from parseConnection's options, never from a bare URL.
	assert.match(at("worker/src/connection.mjs"), /return new Redis\(\{ \.\.\.parseConnection\(url,/);
	assert.equal((at("worker/src/connection.mjs").match(/new Redis\(/g) ?? []).length, 1);
	// Non-vacuity: the sites that DO connect are there to be found, in all three packages.
	const users = files.filter((f) => /\b(parseConnection|makeRedisClient)\b/.test(f.code)).map((f) => f.path);
	for (const expected of ["worker/src/start.mjs", "worker/src/cli.mjs", "worker/src/cancel-cli.mjs", "worker/src/doctor.mjs", "worker/src/service.mjs", "receiver/src/start.mjs", "receiver/src/route.mjs", "receiver/src/poller.mjs", "admin/src/read-model.mjs", "admin/src/dashboard.ts"]) {
		assert.ok(users.includes(expected), `${expected} opens its Valkey clients through connection.mjs`);
	}
	for (const rule of RULES) assert.equal(rule.re.test(""), false);
	assert.equal(RULES[2].re.test("new Redis(url)"), true, "the patterns match what they are meant to");
	assert.equal(RULES[3].re.test("new Queue(name, { connection })"), true);
});

test("every connection parseConnection and makeRedisClient build is judged; makeQueue refuses any other (#464)", () => {
	const c = parseConnection("redis://localhost:6379", { context: { enforce: false, shared: false, envPath: "/d/.env" } });
	assert.equal(c.Connector, JudgedConnector);
	assert.equal(isJudgedConnection(c), true);
	assert.equal(isJudgedConnection({ ...c, maxRetriesPerRequest: null }), true, "a spread copy (BullMQ's, the worker's) stays judged");
	assert.equal(isJudgedConnection({ host: "127.0.0.1", port: 6379 }), false);
	assert.equal(isJudgedConnection({ host: "127.0.0.1", Connector: JudgedConnector }), false, "the Connector alone, without what it judges, is not enough");
	assert.throws(() => makeQueue({ host: "127.0.0.1", port: 6379 }), /a Valkey connection must be built by parseConnection/);
	assert.throws(() => assertJudgedConnection(undefined), TypeError);
	const r = makeRedisClient("redis://localhost:6379", { lazyConnect: true, context: { enforce: false, shared: false, envPath: "/d/.env" } });
	try {
		assert.equal(isJudgedConnection(r), true, "an ioredis client, judged by its options");
		assert.equal(isJudgedConnection(r.duplicate({ lazyConnect: true })), true, "and its duplicates (BullMQ's blocking connections)");
	} finally {
		r.disconnect();
	}
});

test("JudgedConnector dials the judged address, and a refusal fails the connect with its words (#464)", { timeout: 20_000 }, async () => {
	const url = process.env.VALKEY_TEST_URL;
	const asked = [];
	const refusing = makeRedisClient("redis://localhost:6379", {
		lazyConnect: true,
		failFast: true,
		judge: async (u, ctx) => {
			asked.push([u, ctx.enforce]);
			throw Object.assign(new Error("the Valkey VALKEY_URL reaches is refused: [::1]:6379 is held by op2 (uid 1235)"), { piDispatchConfig: true });
		},
		context: { enforce: true, shared: false, envPath: "/d/.env" },
	});
	refusing.on("error", () => {});
	await assert.rejects(refusing.connect(), /refused: \[::1\]:6379 is held by op2/);
	refusing.disconnect();
	assert.deepEqual(asked[0], ["redis://localhost:6379", true]);
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
	for (const enforce of [false, true]) {
		const ep = await judgedEndpoint("redis://localhost:16483", { enforce, shared: false, envPath: "/d/.env" }, { cache, facts: factsWith(squat) });
		assert.deepEqual(ep, { host: "127.0.0.1", servername: null, pinned: "127.0.0.1" }, `enforce ${enforce}: never the other account's ::1`);
	}
	// Resolved ONCE: a later connect does not ask DNS again, and a DNS answer that changed cannot move it.
	let lookups = 0;
	const again = await judgedEndpoint("redis://localhost:16483", { enforce: true, shared: false, envPath: "/d/.env" }, { cache, facts: factsWith(squat, { lookup: async () => (lookups++, [{ address: "::1", family: 6 }]) }) });
	assert.equal(again.host, "127.0.0.1");
	assert.equal(lookups, 0);
	// Re-judged on each connect: our Valkey gone and another account on 127.0.0.1 meanwhile is refused where enforced.
	const taken = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` };
	await assert.rejects(judgedEndpoint("redis://localhost:16483", { enforce: true, shared: false, envPath: "/d/.env" }, { cache, facts: factsWith(taken) }), (err) => err.piDispatchConfig === true && err.valkeyRefused === true && /127\.0\.0\.1:16483 is held by op2/.test(err.message));
});

test("judgedEndpoint: refused where enforced unless opted in, pinned to what answers elsewhere, a remote name left alone, nothing answering not cached (#464)", async () => {
	const theirs = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 6379, 1235)}` };
	const ctx = (enforce, shared = false) => ({ enforce, shared, envPath: "/d/.env" });
	await assert.rejects(judgedEndpoint("redis://127.0.0.1:6379", ctx(true), { cache: new Map(), facts: factsWith(theirs) }), /refused: 127\.0\.0\.1:6379 is held by op2 \(uid 1235\)/);
	assert.equal((await judgedEndpoint("redis://127.0.0.1:6379", ctx(true, true), { cache: new Map(), facts: factsWith(theirs) })).host, "127.0.0.1", "PI_VALKEY_SHARED=1");
	assert.equal((await judgedEndpoint("redis://0.0.0.0:6379", ctx(false), { cache: new Map(), facts: factsWith(theirs) })).host, "127.0.0.1", "docker's venue: not refused, pinned to what 0.0.0.0 reaches");
	assert.deepEqual(await judgedEndpoint("redis://queue.lan:6379", ctx(true), { cache: new Map(), facts: factsWith({}) }), { host: "queue.lan", servername: null, pinned: null });
	assert.equal((await judgedEndpoint("rediss://localhost:6379", ctx(false), { cache: new Map(), facts: factsWith(theirs, { probeTcp: async (h) => h === "127.0.0.1" }) })).servername, "localhost", "a rediss: name kept for TLS");
	const cache = new Map();
	await assert.rejects(judgedEndpoint("redis://127.0.0.1:6379", ctx(true), { cache, facts: factsWith({}, { probeTcp: async () => false }) }), /^Error: nothing answers VALKEY_URL/);
	assert.equal(cache.size, 0, "a failed judgement pins nothing; the next connect judges afresh");
	assert.ok(PINNED instanceof Map);
});

test("valkeyClientContext: enforced on the podman venue without local on Linux, the venue from this environment else the .env, PI_VALKEY_SHARED from the .env only (#464)", () => {
	const readEnv = (text) => () => text;
	const none = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "podman" }, cwd: "/d", platform: "linux", readEnv: none }).enforce, true);
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "local,podman" }, cwd: "/d", platform: "linux", readEnv: none }).enforce, false, "docker's Valkey is the queue");
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "podman" }, cwd: "/d", platform: "darwin", readEnv: none }).enforce, false, "no /proc to judge by");
	assert.equal(valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=podman\n") }).enforce, true, "`pi-dispatch run` in the deployment folder without exporting PI_BACKENDS is judged as the service");
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "local" }, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=podman\n") }).enforce, false, "this environment's PI_BACKENDS first");
	assert.equal(valkeyClientContext({ env: { PI_BACKENDS: "podman" }, cwd: "/d", platform: "linux", readEnv: none, enforce: false }).enforce, false, "a caller's own decision wins");
	assert.equal(valkeyClientContext({ env: { PI_VALKEY_SHARED: "1" }, cwd: "/d", platform: "linux", readEnv: none }).shared, false, "never this environment's");
	assert.equal(valkeyClientContext({ env: { PI_VALKEY_SHARED: "1" }, cwd: "/d", platform: "linux", readEnv: readEnv("PI_BACKENDS=podman\n") }).shared, false, "nor over a .env that does not say it");
	assert.equal(valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: readEnv("PI_VALKEY_SHARED=1\n") }).shared, true);
	assert.equal(valkeyClientContext({ env: {}, cwd: "/d", platform: "linux", readEnv: none }).envPath, "/d/.env");
});

test("the worker's clients are enforced exactly as its boot judgement was (#464)", async () => {
	const { workerValkeyContext } = await import("../src/start.mjs");
	const none = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	assert.equal(workerValkeyContext({ enforce: true }, {}, { cwd: "/d", readEnv: none }).enforce, true, "a boot that enforced");
	assert.equal(workerValkeyContext({ enforce: false }, { PI_BACKENDS: "podman" }, { cwd: "/d", readEnv: none }).enforce, false, "a boot that judged nothing (docker's venue, another host)");
	assert.equal(workerValkeyContext({}, {}, { cwd: "/d", readEnv: () => "PI_VALKEY_SHARED=1\n" }).shared, true);
});
