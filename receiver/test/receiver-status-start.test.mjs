import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { FORGE_KINDS } from "@edgehero/pi-dispatch/triggers";
import { loadReceiverConfig, servedForges } from "../src/config.mjs";
import { startReceiver } from "../src/start.mjs";

const AT = Date.UTC(2026, 10, 1);
function fixture(overrides = {}) {
	const dir = tempDir("receiver-status-start-");
	const path = join(dir, "triggers.json"); writeFileSync(path, '{"triggers":[]}');
	const env = { PI_TRIGGERS_FILE: path, GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "secret", PI_WORKER_NAME: "mini1", ...overrides };
	const closers = []; const log = []; const events = []; let published;
	const server = { address: () => ({ address: "::ffff:127.0.0.1", port: 49155 }), listen(_port, _bind, cb) { events.push("listen"); cb(); }, close(cb) { cb?.(); } };
	const queue = { client: Promise.resolve({}), close: async () => events.push("queue-close") };
	const deps = { now: () => AT, closers, write: (line) => log.push(JSON.parse(line)), judgeValkey: async () => {}, makeAuth: async () => ({ selfId: 999, source: "gh" }), makeQueueFn: () => queue, makeForgeRouterFn: () => ({ close: async () => {} }), createServer: () => server,
		makeReceiverPublisherFn: (options) => { published = options; events.push("publisher"); return { start: () => events.push("start"), close: () => events.push("stop") }; } };
	return { env, deps, closers, server, queue, log, events, published: () => published };
}

test("publication starts only after successful listen, using the socket rather than the configured bind/port (#775)", async () => {
	const f = fixture();
	try {
		await startReceiver(f.env, f.deps);
		assert.deepEqual(f.events.slice(0, 3), ["listen", "publisher", "start"]);
		const p = f.published(); assert.equal(p.name, "mini1"); assert.equal(p.port, 49155); assert.equal(p.bind, "loopback"); assert.deepEqual(p.forges, ["github"]);
		assert.equal(await p.client(), await f.queue.client); assert.equal(typeof p.observations.observe, "function"); assert.equal(p.now(), AT);
	} finally { for (const c of f.closers) c.close(); }
});

test("a refused listen creates no publisher or timer; invalid telemetry names preserve receiver startup (#775)", async () => {
	const refused = fixture(); refused.server.listen = () => { throw new Error("listen refused"); };
	await assert.rejects(startReceiver(refused.env, refused.deps), /listen refused/);
	assert.equal(refused.published(), undefined); assert.equal(refused.closers.length, 0);
	const invalid = fixture({ PI_WORKER_NAME: "invalid/name" });
	try {
		assert.equal(await startReceiver(invalid.env, invalid.deps), invalid.server);
		assert.equal(invalid.published(), undefined);
		assert.deepEqual(invalid.log.filter((r) => r.event === "receiver_status_unavailable"), [{ event: "receiver_status_unavailable", reason: "identity-or-socket" }]);
	} finally { for (const c of invalid.closers) c.close(); }
});

test("shutdown stops the receiver's shared-client publisher before disconnecting that client (#775)", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const shutdown = source.slice(source.indexOf("const shutdown ="), source.indexOf('process.once("SIGTERM"'));
	assert.ok(shutdown.indexOf("receiverPublisher?.close()") < shutdown.indexOf("await queue.close()"));
	assert.ok(shutdown.indexOf("receiverPublisher?.close()") > shutdown.indexOf("server.close(resolve)"));
});

// Issue #824: the record's `forges` is built from FORGE_KINDS and the config's own block for each forge. A forge this
// table names needs a row here too, which is the point: the walk fails naming it until the test and the loader know it.
// At run time a forge with no block is unserved, so this walk is the only place that names one.
const SERVING = {
	github: { GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "secret" },
	gitlab: { GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "secret", GITLAB_TOKEN: "token" },
	forgejo: { FORGEJO_URL: "https://code.example", FORGEJO_WEBHOOK_SECRET: "secret", FORGEJO_TOKEN: "token" },
	azure: { AZURE_WEBHOOK_MODE: "basic", AZURE_WEBHOOK_SECRET: "secret", AZURE_TOKEN: "token", AZURE_ORG_URL: "https://dev.azure.com/acme" },
};
const configOf = (env) => loadReceiverConfig({ PI_TRIGGERS_FILE: "/triggers.json", ...env }, { readFile: () => '{"triggers":[]}', fileExists: () => true });
const blockless = (cfg, kinds) => kinds.filter((kind) => !Object.hasOwn(cfg, kind)).map((kind) => `${kind}: receiver/src/config.mjs loadReceiverConfig reads no ${kind} block, so servedForges reports it unserved`);

test("the status record names exactly the forges the config serves, walked over FORGE_KINDS, and a forge the config has no block for is unserved but named here (#824)", async () => {
	assert.deepEqual(blockless(configOf({}), FORGE_KINDS), []);
	assert.deepEqual(blockless(configOf({}), [...FORGE_KINDS, "bitbucket"]), ["bitbucket: receiver/src/config.mjs loadReceiverConfig reads no bitbucket block, so servedForges reports it unserved"]);
	for (const kind of FORGE_KINDS) {
		assert.ok(Object.hasOwn(SERVING, kind), `${kind}: receiver/src/config.mjs servedForges needs a config block for this forge, and this test an env that serves it`);
		assert.deepEqual(servedForges(configOf(SERVING[kind])), [kind], kind);
	}
	const all = configOf(Object.assign({}, ...Object.values(SERVING)));
	assert.deepEqual(servedForges(all), [...FORGE_KINDS]);
	assert.deepEqual(servedForges(configOf({})), []);
	// A forge the loader does not read yet arms no route, so it is unserved, and the record keeps every other forge's.
	assert.deepEqual(servedForges(all, [...FORGE_KINDS, "bitbucket"]), [...FORGE_KINDS]);
	// The receiver publishes that list, read once its arms are built.
	const f = fixture(Object.assign({}, ...Object.values(SERVING)));
	f.deps.resolveGitLabSelfId = async () => 7; f.deps.makeResolveAuthority = () => async () => 30;
	f.deps.resolveForgejoSelfId = async () => 8; f.deps.makeResolveForgejoAuthority = () => async () => "write";
	f.deps.resolveAzureSelfId = async () => ({ id: "11111111-1111-1111-1111-111111111111", email: null }); f.deps.makeResolveAzureAuthority = () => async () => true;
	try {
		await startReceiver(f.env, f.deps);
		assert.deepEqual(f.published().forges, [...FORGE_KINDS]);
	} finally { for (const c of f.closers) c.close(); }
});

test("the receiver writes no forge list out: the record's forges are servedForges(cfg) (#824)", () => {
	// Two forge names written as strings in one statement are a copy of the list, which a forge added to FORGES would not
	// reach. The arms handed on by name (`gitlab, forgejo, azure`) are variables, not names, and the match leaves them.
	const names = FORGE_KINDS.join("|");
	assert.doesNotMatch(readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8"), new RegExp(`(["'\`])(?:${names})\\1[^;]*?(["'\`])(?:${names})\\2`), "receiver/src/start.mjs writes a forge list out");
});
