import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The offline preload (fixtures/offline-fetch.mjs) is what keeps every real runner and real pi child in these tests off
 * the network, so its claim is tested itself: through each way a process here reaches out (node:http, node:https,
 * fetch, undici's own fetch, net.connect by name and by address), a host that is not loopback is refused before any
 * lookup. The hosts cannot be reached even if a lock failed: a TEST-NET-1 address (RFC 5737, never routed) and names
 * under `.invalid` (RFC 6761, never resolved). A loopback server stays reachable, so the lock is not simply everything.
 */
const PRELOAD = fileURLToPath(new URL("./fixtures/offline-fetch.mjs", import.meta.url));
const UNDICI = fileURLToPath(new URL("../../../node_modules/undici/index.js", import.meta.url));

const PROBE = `
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createRequire } from "node:module";
const lookups = [];
const realLookup = dns.lookup;
dns.lookup = function (host, ...rest) { lookups.push(host); return realLookup.call(this, host, ...rest); };
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) { lookups.push(host); return realPromiseLookup.call(this, host, ...rest); };
const outcome = (start) => new Promise((resolve) => {
	const timer = setTimeout(() => resolve("timed out"), 5000);
	try {
		start((error) => { clearTimeout(timer); resolve(error ? String(error.message) : "connected"); });
	} catch (error) { clearTimeout(timer); resolve(String(error.message)); }
});
const viaRequest = (mod, url) => outcome((done) => mod.get(url, (res) => { res.resume(); done(null); }).on("error", done));
const viaSocket = (...args) => outcome((done) => { const socket = net.connect(...args); socket.once("connect", () => { socket.destroy(); done(null); }); socket.once("error", done); });
// undici reports a refused socket as "fetch failed", with the refusal as its cause.
const viaFetch = (impl, url) => outcome((done) => impl(url).then(() => done(null), (error) => done(error?.cause ?? error)));
const undici = createRequire(import.meta.url)(${JSON.stringify(UNDICI)});
const server = http.createServer((_req, res) => res.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const local = "http://127.0.0.1:" + server.address().port + "/";
// The listen looked its own address up: only what follows counts.
lookups.length = 0;
const results = {
	http: await viaRequest(http, "http://192.0.2.1/"),
	httpName: await viaRequest(http, "http://example.invalid/"),
	https: await viaRequest(https, "https://example.invalid/"),
	fetch: await viaFetch(globalThis.fetch, "https://example.invalid/"),
	undiciFetch: await viaFetch(undici.fetch, "https://example.invalid/"),
	netByName: await viaSocket({ host: "example.invalid", port: 443 }),
	netByAddress: await viaSocket(443, "192.0.2.1"),
	netLooksLoopback: await viaSocket({ host: "127.example.invalid", port: 443 }),
};
// Every lookup up to here, before the loopback control (which looks its own address up).
const before = [...lookups];
results.loopback = await viaRequest(http, local);
server.close();
process.stdout.write(JSON.stringify({ results, lookups: before }));
`;

test("the offline preload refuses every way out to a host that is not loopback, before any lookup, and leaves loopback open", { timeout: 60_000 }, () => {
	const dir = tempDir("offline-fetch-");
	const script = join(dir, "probe.mjs");
	writeFileSync(script, PROBE);
	const run = spawnSync(process.execPath, [`--import=${PRELOAD}`, script], { encoding: "utf8", timeout: 50_000, env: { PATH: process.env.PATH, OFFLINE_FETCH_LOG: join(dir, "log.jsonl"), NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" } });
	assert.equal(run.status, 0, run.stderr);
	const { results, lookups } = JSON.parse(run.stdout);
	for (const way of ["http", "httpName", "https", "undiciFetch", "netByName", "netByAddress", "netLooksLoopback"]) assert.match(results[way], /^offline: an outbound connection was refused$/, `${way}: ${results[way]}`);
	assert.match(results.fetch, /^offline: no such route$/, "fetch is pinned to the fake, which answers no other route");
	assert.deepEqual(lookups, [], "refused before any name was looked up");
	assert.equal(results.loopback, "connected", "a loopback server is still reached");
});
