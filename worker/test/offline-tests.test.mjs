import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { loopback } from "../../.github/scripts/offline-tests.mjs";

// Issue #1102: the preload `contract-tests` runs the suite under, and the helper a test file imports to check itself.
const PRELOAD = fileURLToPath(new URL("../../.github/scripts/offline-tests.mjs", import.meta.url));
const HELPER = new URL("./helpers/offline.mjs", import.meta.url).href;

// Every target here is one that cannot be reached even if the preload under test is broken: names under `.invalid`
// (RFC 6761, never resolved) and TEST-NET addresses (RFC 5737, never routed). And UNDERNEATH the preload, a child here
// loads a connect that never connects: whatever the preload lets through lands there and fails with these words, so
// "through" is told from "refused" by the error alone.
const UNDERNEATH = `import net from "node:net";
net.Socket.prototype.connect = function () {
	process.nextTick(() => this.destroy(new Error("underneath: let through")));
	return this;
};
`;

/** A directory with the connect underneath, and a child's env that loads it and then the preload, and no other preload. */
function world({ log = true } = {}) {
	const dir = tempDir("offline-tests-");
	writeFileSync(join(dir, "underneath.mjs"), UNDERNEATH);
	const env = { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(join(dir, "underneath.mjs")).href} --import ${pathToFileURL(PRELOAD).href}` };
	// The parent's own log is CI's oracle: a child here refuses on purpose and must never write to it, so it is always
	// named, as this world's own file or as "" (no log), never left for the preload to hand on.
	env.OFFLINE_TESTS_LOG = log ? join(dir, "refused.jsonl") : "";
	// NODE_TEST_CONTEXT marks the parent runner's own children; inherited, a child `node --test` would report to a parent
	// that is not listening instead of running its file, and exit 0. Dropped so each child is a plain run.
	delete env.NODE_TEST_CONTEXT;
	return { dir, env };
}

// A child of the probe: one connection out, then what it found in its own environment.
const CHILD = `const net = require("node:net");
net.connect({ host: "offline-probe.invalid", port: 443 }).on("error", (error) => {
	console.log(JSON.stringify({ refused: error.message.startsWith("offline:"), nodeOptions: process.env.NODE_OPTIONS ?? null, chosen: process.env.OFFLINE_TESTS_NODE_OPTIONS ?? null }));
});`;

const PROBE = `import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { refusals } from ${JSON.stringify(pathToFileURL(PRELOAD).href)};
const attempt = (connect) =>
	new Promise((resolve) => {
		const socket = connect();
		socket.on("error", (error) => resolve(error.message.startsWith("offline:") && error.code === "ECONNREFUSED" ? "refused" : "through"));
	});
async function dialOut(host) {
	return attempt(() => net.connect({ host, port: 443 }));
}
// Socket.prototype.connect called directly, as net's own normalizeArgs reads its arguments.
const raw = (...args) => attempt(() => new net.Socket().connect(...args));
const results = {};
for (const host of ["offline-probe.invalid", "127.offline-probe.invalid", "127.0.0.1", "127.3.2.1", "::1", "localhost"]) results[host] = await dialOut(host);
results["port, host"] = await raw(443, "203.0.113.7");
results["hex port, host"] = await raw("0x1bb", "offline-probe.invalid");
results["spaced port, host"] = await raw(" 443", "offline-probe.invalid");
results["port, callback"] = await raw(443, () => {});
results["unix socket"] = await attempt(() => net.connect(join(process.cwd(), "s.sock")));
results["path beside a host"] = await attempt(() => net.connect({ path: join(process.cwd(), "s.sock"), host: "offline-probe.invalid", port: 443 }));
results.fetch = await fetch("https://offline-probe.invalid/").then(
	() => "answered",
	(error) => (error.cause?.message?.startsWith("offline:") ? "refused" : "through"),
);
const child = ${JSON.stringify(CHILD)};
const children = {
	inherited: JSON.parse(execFileSync(process.execPath, ["-e", child], { encoding: "utf8" })),
	replaced: JSON.parse(execFileSync(process.execPath, ["-e", child], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_OPTIONS: "--no-warnings" } })),
	allowlist: await new Promise((resolve) => {
		let out = "";
		const started = spawn(process.execPath, ["-e", child], { env: { PATH: process.env.PATH } });
		started.stdout.on("data", (chunk) => (out += chunk));
		started.on("close", () => resolve(JSON.parse(out)));
	}),
	restored: JSON.parse(execFileSync(process.execPath, ["-e", child], { encoding: "utf8", env: { ...process.env, OFFLINE_TESTS_NODE_OPTIONS: JSON.stringify("--no-warnings") } })),
};
console.log(JSON.stringify({ results, children, refusals: refusals.length }));
`;

function probe(options) {
	const { dir, env } = world(options);
	writeFileSync(join(dir, "probe.test.mjs"), PROBE);
	const run = spawnSync(process.execPath, [join(dir, "probe.test.mjs")], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
	assert.equal(run.status, 0, run.stderr);
	return { dir, ...JSON.parse(run.stdout.trim().split("\n").at(-1)) };
}

const EXPECTED = {
	"offline-probe.invalid": "refused",
	"127.offline-probe.invalid": "refused",
	"127.0.0.1": "through",
	"127.3.2.1": "through",
	"::1": "through",
	localhost: "through",
	"port, host": "refused",
	"hex port, host": "refused",
	"spaced port, host": "refused",
	"port, callback": "through",
	"unix socket": "through",
	"path beside a host": "through",
	fetch: "refused",
};

/** The preload's own `--import` in a NODE_OPTIONS value, counted. */
const preloads = (value) => (String(value ?? "").match(/offline-tests\.mjs/g) ?? []).length;

/** What every child the probe started must show, whatever other preload a hook added beside this one. */
function assertChildren(children) {
	for (const [how, child] of Object.entries(children)) {
		assert.equal(child.refused, true, `${how}: the preload reached the child and refused its connection`);
		assert.equal(child.chosen, null, `${how}: the marker is gone from the child's environment`);
	}
	assert.equal(preloads(children.inherited.nodeOptions), 1, "an inherited NODE_OPTIONS that names the preload is not given it twice");
	// A replaced NODE_OPTIONS is the spawner's again in the child: the preload is not in it, and what was chosen leads.
	assert.equal(preloads(children.replaced.nodeOptions), 0, children.replaced.nodeOptions);
	assert.match(children.replaced.nodeOptions, /^--no-warnings( |$)/);
	assert.equal(preloads(children.allowlist.nodeOptions), 0, String(children.allowlist.nodeOptions));
	// Exact where no hook's addition can stand in the way: the marker itself says what to put back.
	assert.equal(children.restored.nodeOptions, "--no-warnings");
}

test("only a literal loopback address or localhost is this machine", () => {
	for (const host of ["127.0.0.1", "127.255.255.254", "::1", "[::1]", "localhost"]) assert.equal(loopback(host), true, host);
	for (const host of ["127.offline-probe.invalid", "127.0.0.1.offline-probe.invalid", "offline-probe.invalid", "192.0.2.1", "10.0.0.1", "0.0.0.0", "::ffff:127.0.0.1", "LOCALHOST", "", undefined, null]) assert.equal(loopback(host), false, String(host));
});

test("a connection to another machine is refused before any lookup and written down, in every node child too; loopback and a Unix socket go through", () => {
	const { results, children, refusals, dir } = probe();
	assert.deepEqual(results, EXPECTED);
	assertChildren(children);
	assert.equal(refusals, 6, "the probe's own refusals");
	const lines = readFileSync(join(dir, "refused.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines.map(({ host, port }) => `${host}:${port}`), ["offline-probe.invalid:443", "127.offline-probe.invalid:443", "203.0.113.7:443", "offline-probe.invalid:0x1bb", "offline-probe.invalid: 443", "offline-probe.invalid:443", ...Array(4).fill("offline-probe.invalid:443")]);
	// The real path on both sides: a module's URL is resolved through links, and macOS's temp directory sits behind one.
	const probeFile = realpathSync(join(dir, "probe.test.mjs"));
	assert.ok(lines.every((line) => realpathSync(line.test) === probeFile), `each line names the test file, a child's from its spawner: ${lines.map((line) => line.test).join(", ")}`);
	assert.ok(lines.slice(6).every((line) => !line.stack.some((frame) => frame.includes("probe.test.mjs"))), "the children's own stacks name no test file");
	assert.ok(lines[0].stack.some((frame) => frame.includes("dialOut") && frame.includes("probe.test.mjs")), `the stack names the caller: ${lines[0].stack.join(" | ")}`);
	assert.ok(lines[5].stack.some((frame) => frame.includes("probe.test.mjs")), `past undici's own frames to the fetch's caller: ${lines[5].stack.join(" | ")}`);
});

test("with no log named, the connection is still refused and nothing is written, by the process or its children", () => {
	const { results, children, refusals, dir } = probe({ log: false });
	assert.deepEqual(results, EXPECTED);
	assertChildren(children);
	assert.equal(refusals, 6);
	assert.deepEqual(readdirSync(dir).sort(), ["probe.test.mjs", "underneath.mjs"]);
});

test("the log exists, empty, as soon as the preload loads, so a missing one means it never loaded", () => {
	const { dir, env } = world();
	const run = spawnSync(process.execPath, ["-e", ""], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.ok(existsSync(join(dir, "refused.jsonl")), "made at load");
	assert.equal(statSync(join(dir, "refused.jsonl")).size, 0, "and nothing in it");
});

test("a test file that imports the helper fails when it reaches another machine, even though its own test tolerates the refusal", () => {
	const { dir, env } = world({ log: false });
	const file = (name, body) => {
		writeFileSync(join(dir, name), `import net from "node:net";\nimport { test } from "node:test";\nimport ${JSON.stringify(HELPER)};\nconst dial = (host) => new Promise((resolve) => net.connect({ host, port: 443 }).on("error", resolve));\n${body}\n`);
		return spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, name)], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
	};
	const clean = file("clean.test.mjs", `test("loopback only", async () => { await dial("127.0.0.1"); });`);
	assert.equal(clean.status, 0, clean.stdout + clean.stderr);
	const leaky = file("leaky.test.mjs", `test("reaches out and passes", async () => { await dial("offline-probe.invalid"); });`);
	assert.notEqual(leaky.status, 0, "the file fails");
	assert.match(leaky.stdout, /# pass 1\n/, "its own test passed");
	assert.match(leaky.stdout, /offline-probe\.invalid:443 from /, "the failure names the host and the caller");
	// A top-level await between tests runs the root hook before the tests after it: the exit backstop fails the file.
	const late = file("late.test.mjs", `test("first", () => {});\nawait new Promise((resolve) => setTimeout(resolve, 5));\ntest("after the await", async () => { await dial("offline-probe.invalid"); });`);
	assert.notEqual(late.status, 0, "the file fails");
	assert.match(late.stdout + late.stderr, /after its checks ran[\s\S]*offline-probe\.invalid:443/);
});
