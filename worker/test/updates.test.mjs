import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient } from "../src/connection.mjs";
import { fakeNpm } from "./helpers/fake-npm.mjs";
import { readStageManifest, parsePackagesFile } from "../src/packages.mjs";
import { STAGED_TREE_KEEP_MS, pruneStagedTrees } from "../src/package-stage.mjs";
import { runUpdatesCli } from "../src/updates-cli.mjs";
import { ADMIN_USED_API, boundedJson, bumpChecks, buildLook, hostPiFacts, newestVersion } from "../src/updates-look.mjs";
import { applyDesired, isSubscriptionAdapter, reconcileUpdates } from "../src/updates-reconcile.mjs";
import { CANNOT_ADOPT_REASONS, UPDATES_DESIRED, UPDATES_GENERATION, UPDATES_HOSTS, changelogExcerpt, compareVersions, hostHasPending, lookIsStale, parseApplied, parseCanaryFacts, parseDesired, parseLookRecord, publishCanaryFacts, publishLook, readApplied, readCanaryFacts, readDesired, readLooks, setDesired, updatesAppliedKey, updatesCanaryKey, updatesLookKey, writeApplied } from "../src/updates.mjs";

const NOW = 1_800_000_000_000;
const clock = () => NOW;

/** A registry and a forge answering from a table: a URL it does not know throws, as an unreachable host does. */
const table = (answers) => async (url) => {
	if (!Object.hasOwn(answers, url)) throw new Error(`no answer for ${url}`);
	return answers[url];
};
const REG = "https://registry.npmjs.org";
const API = "https://api.github.com/repos/edgehero/pi-dispatch/commits/chore%2Fpi-bump";

// ---- what a look concludes

test("versions order as semver says, and a pre-release sorts before its release", () => {
	assert.equal(compareVersions("1.10.0", "1.9.9"), 1, "numeric, not lexical");
	assert.equal(compareVersions("1.5.0", "1.5.0"), 0);
	assert.equal(compareVersions("1.5.0-rc.1", "1.5.0"), -1);
	assert.equal(compareVersions("1.5.0+build", "1.5.0"), 0, "build metadata does not order");
	assert.equal(compareVersions("1.5.0-rc.1", "1.5.0-rc.2"), -1);
	assert.equal(compareVersions("1.5.0-rc.2", "1.5.0-rc.1"), 1);
	assert.equal(compareVersions("1.5.0-rc.10", "1.5.0-rc.9"), 1, "numbers as numbers");
	assert.equal(compareVersions("1.5.0-rc.1", "1.5.0-rc"), 1, "more parts sort after fewer");
	assert.equal(compareVersions("1.5.0-1", "1.5.0-alpha"), -1, "numbers below words");
	assert.equal(compareVersions("1.5.0-beta", "1.5.0-alpha"), 1);
});

test("the registry is asked for one small document, the scoped name encoded", async () => {
	const seen = [];
	const get = async (url) => { seen.push(url); return { value: { version: "2.0.0" } }; };
	assert.equal(await newestVersion("@acme/tool", { get }), "2.0.0");
	assert.equal(await newestVersion("plain", { get, registry: "https://mirror.example" }), "2.0.0");
	assert.deepEqual(seen, [`${REG}/@acme%2ftool/latest`, "https://mirror.example/plain/latest"]);
});

const bump = (subject, runs, total = runs.length) => table({ [API]: { value: { commit: { message: `${subject}\n\nbody` } } }, [`${API}/check-runs?per_page=100`]: { value: { total_count: total, check_runs: runs } } });
const PASS = { status: "completed", conclusion: "success" };

test("the bump branch's checks: a failed read or an unproven one is unknown, never passing", async () => {
	const subject = "chore(pi): run on pi 1.6.0";
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS, { status: "completed", conclusion: "skipped" }]) }), "passing");
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS, { status: "completed", conclusion: "failure" }]) }), "failing");
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS, { status: "in_progress", conclusion: null }]) }), "pending");
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS, { status: "completed", conclusion: "failure" }, { status: "queued", conclusion: null }]) }), "failing", "one failure is enough, whatever is still running");
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, []) }), "unknown", "no run at all proves nothing");
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS], 140) }), "unknown", "a list cut short could hide a failure");
	assert.equal(await bumpChecks("1.6.0", { get: bump("chore(pi): run on pi 1.5.1", [PASS]) }), "unknown", "green on another version says nothing about this one");
	assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [{ status: "completed", conclusion: "weird-new-word" }]) }), "unknown", "a conclusion nobody has judged");
	await assert.rejects(bumpChecks("1.6.0", { get: table({}) }));
	for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]) assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS, { status: "completed", conclusion }]) }), "failing", conclusion);
	for (const conclusion of ["neutral", "skipped"]) assert.equal(await bumpChecks("1.6.0", { get: bump(subject, [PASS, { status: "completed", conclusion }]) }), "passing", conclusion);
});

const overlayWith = (packages) => {
	const globalPiDir = tempDir("updates-look-");
	fs.mkdirSync(join(globalPiDir, "packages"));
	fs.writeFileSync(join(globalPiDir, "packages", "packages.json"), JSON.stringify({ stagedAt: "x", packages }));
	return globalPiDir;
};
const absentPi = async () => ({ version: null, tested: "1.5.0", state: "absent", needles: "unknown", extension: "unknown" });

test("a look says what it could read, and every failed read is a word on the record, not a good state", async () => {
	const globalPiDir = overlayWith([{ name: "@a/ok", version: "1.0.0", dir: "a" }, { name: "gone", version: "1.0.0", dir: "g" }]);
	const get = table({ [`${REG}/@earendil-works%2fpi-coding-agent/latest`]: { value: { version: "1.6.0" } }, [`${REG}/@a%2fok/latest`]: { value: { version: "1.1.0" } } });
	const record = await buildLook({ env: {}, host: "mini1", pinned: "1.5.0", now: clock, get, hostPi: absentPi, globalPiDir });
	assert.equal(record.pi.newest, "1.6.0");
	assert.equal(record.pi.checks, "unknown", "newer pi, and the forge did not answer: unknown, never passing");
	assert.deepEqual(record.packages, [{ name: "@a/ok", version: "1.0.0", newest: "1.1.0", read: "ok" }, { name: "gone", version: "1.0.0", newest: null, read: "unknown" }]);
	assert.equal(record.at, NOW);
});

test("a look with no registry at all still publishes, and says it could not read", async () => {
	const record = await buildLook({ env: {}, host: "mini1", pinned: "1.5.0", now: clock, get: table({}), hostPi: absentPi, globalPiDir: overlayWith([]) });
	assert.equal(record.pi.read, "unknown");
	assert.equal(record.pi.newest, null);
	assert.equal(record.pi.checks, null, "nothing newer is known, so there is nothing to have checked");
});

test("when nothing is newer the forge is not asked at all", async () => {
	const get = table({ [`${REG}/@earendil-works%2fpi-coding-agent/latest`]: { value: { version: "1.5.0" } } });
	const record = await buildLook({ env: {}, host: "mini1", pinned: "1.5.0", now: clock, get, hostPi: absentPi, globalPiDir: overlayWith([]) });
	assert.equal(record.pi.checks, null);
	assert.equal(record.pi.read, "ok");
});

test("the bounded read refuses a redirect, a response past its size, and does not fall back around a proxy", async () => {
	let init;
	const ok = async (_url, options) => { init = options; return { ok: true, status: 200, body: (async function* () { yield Buffer.from('{"a":1}'); })() }; };
	assert.deepEqual((await boundedJson("https://x", { request: ok })).value, { a: 1 });
	assert.equal(init.redirect, "error");
	assert.ok(init.signal, "bounded in time");
	assert.equal(init.dispatcher, undefined, "no proxy declared: direct");
	await assert.rejects(boundedJson("https://x", { maxBytes: 3, request: ok }), /too large/);
	const closed = [];
	class Proxy { constructor(url) { this.url = url; } async close() { closed.push(this.url); } }
	await boundedJson("https://x", { proxyUrl: "http://proxy:3128", request: ok, ProxyAgentClass: Proxy });
	assert.equal(init.dispatcher.url, "http://proxy:3128", "every request traverses the declared proxy");
	assert.deepEqual(closed, ["http://proxy:3128"]);
	await assert.rejects(boundedJson("https://x", { proxyUrl: "http://proxy:3128", ProxyAgentClass: Proxy, request: async () => { throw new Error("proxy refused"); } }), /proxy refused/, "a failing proxy is a failed read, with no direct retry");
	assert.equal((await boundedJson("https://x", { request: async () => ({ ok: false, status: 404 }) })).value, null);
});

const hostFs = (files, real = "/opt/pi/bin/pi") => ({
	realpathSync: () => real,
	existsSync: (p) => Object.hasOwn(files, p),
	readFileSync: (p) => {
		if (!Object.hasOwn(files, p)) throw new Error("ENOENT");
		return files[p];
	},
});
const NEEDLES = { "dist/x.js": ["needle one"] };
const PI_FILES = { "/opt/pi/package.json": JSON.stringify({ name: "@earendil-works/pi-coding-agent" }), "/opt/pi/dist/x.js": "needle one", "/opt/pi/dist/core/extensions/loader.js": ADMIN_USED_API.map((m) => `${m}(a) {}`).join("\n") };

test("a host's own pi: same, newer, older, none here, and what cannot be read is unknown", () => {
	const facts = (version, files = PI_FILES, found = { path: "/usr/bin/pi" }) => hostPiFacts({ tested: "1.5.0", resolvePi: () => found, versionOf: () => version, fs: hostFs(files), needles: NEEDLES });
	assert.deepEqual(facts("1.5.0"), { version: "1.5.0", tested: "1.5.0", state: "same", needles: "ok", extension: "ok" });
	assert.equal(facts("1.6.0").state, "newer");
	assert.equal(facts("1.4.0").state, "older");
	assert.equal(facts(null).state, "unknown");
	assert.equal(facts("1.5.0", PI_FILES, { refusal: "no pi" }).state, "absent", "no pi on a host is a normal host");
	assert.equal(facts("1.5.0", { ...PI_FILES, "/opt/pi/dist/x.js": "moved" }).needles, "drift");
	const noApi = { ...PI_FILES, "/opt/pi/dist/core/extensions/loader.js": "on(a) {}" };
	assert.equal(facts("1.5.0", noApi).extension, "drift");
	assert.equal(facts("1.5.0", { "/elsewhere": "" }).needles, "unknown", "a wrapper that lives elsewhere is unknown, not a failure");
	const noFile = { ...PI_FILES };
	delete noFile["/opt/pi/dist/x.js"];
	assert.equal(facts("1.5.0", noFile).needles, "drift", "a file this pi no longer has is drift, not a pass");
	const noLoader = { ...PI_FILES };
	delete noLoader["/opt/pi/dist/core/extensions/loader.js"];
	assert.equal(facts("1.5.0", noLoader).extension, "drift");
});

// ---- the records

test("a look record is rebuilt: nothing a registry said reaches a reader except as a checked word or version", () => {
	const good = { v: 1, host: "mini1", at: NOW, everyHours: 24, pi: { pinned: "1.5.0", newest: "1.6.0", read: "ok", checks: "passing" }, hostPi: { version: "1.5.0", tested: "1.5.0", state: "same", needles: "ok", extension: "ok" }, packages: [{ name: "@a/b", version: "1.0.0", newest: "1.1.0", read: "ok" }] };
	assert.deepEqual(parseLookRecord(JSON.stringify(good)), good);
	const hostile = parseLookRecord({ ...good, extra: "x", pi: { pinned: "1.5.0", newest: "<script>", read: "great", checks: "all good" }, hostPi: { state: "fine", needles: "yes", extension: "yes", version: "latest" }, packages: [{ name: "<b>", version: "1.0.0" }, { name: "ok", version: "^1.0.0" }, { name: "kept", version: "1.0.0", newest: "javascript:x", read: "fine" }] });
	assert.equal(hostile.extra, undefined);
	assert.deepEqual(hostile.pi, { pinned: "1.5.0", newest: null, read: "unknown", checks: "unknown" }, "an unknown word degrades to unknown, never to a good state");
	assert.deepEqual(hostile.hostPi, { version: null, tested: null, state: "unknown", needles: "unknown", extension: "unknown" });
	assert.deepEqual(hostile.packages, [{ name: "kept", version: "1.0.0", newest: null, read: "unknown" }]);
	for (const bad of [null, "not json", { ...good, v: 2 }, { ...good, host: "a b" }, { ...good, at: "soon" }, { ...good, everyHours: 0 }]) assert.equal(parseLookRecord(bad), null);
});

test("a look past two intervals is stale", () => {
	const record = { at: NOW, everyHours: 24 };
	assert.equal(lookIsStale(record, NOW + 48 * 3_600_000), false);
	assert.equal(lookIsStale(record, NOW + 48 * 3_600_000 + 1), true);
});

test("a desired row filed under another package's key is nobody's to act on", async () => {
	const row1 = { v: 1, generation: 1, name: "@a/b", version: "1.1.0", op: "adopt", by: "ops", at: NOW };
	const redis = { hgetall: async () => ({ "other": JSON.stringify(row1), "@a/b": JSON.stringify(row1) }) };
	assert.deepEqual((await readDesired(redis)).map((r) => r.name), ["@a/b"]);
	assert.equal((await readDesired({ hgetall: async () => ({ other: JSON.stringify(row1) }) })).length, 0);
});

test("a look past the host bound says how many it did not read", async () => {
	const names = Array.from({ length: 65 }, (_, i) => `host${String(i).padStart(2, "0")}`);
	const redis = { smembers: async () => names, mget: async (...keys) => keys.map((key) => JSON.stringify({ v: 1, host: key.slice("updates:h:".length), at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [] })) };
	const read = await readLooks(redis, { now: clock });
	assert.equal(read.hosts.length, 64);
	assert.equal(read.more, 1);
});

test("desired and applied rows are closed", () => {
	const good = { v: 1, generation: 3, name: "@a/b", version: "1.0.0", op: "adopt", by: "ops", at: NOW, request: "r" };
	assert.deepEqual(parseDesired(JSON.stringify(good)), good);
	for (const bad of [{ ...good, version: "^1.0.0" }, { ...good, name: "../x" }, { ...good, op: "update" }, { ...good, by: "a b" }, { ...good, generation: 0 }, { ...good, op: "undo" }]) assert.equal(parseDesired(bad), null, JSON.stringify(bad));
	assert.equal(parseDesired({ ...good, op: "undo", undoOf: 2 }).undoOf, 2);
	const row = parseApplied({ v: 1, generation: 3, state: "cannot-adopt", reason: "evil words", version: "1.0.0", at: NOW, digest: "x" });
	assert.equal(row.reason, null, "a reason outside the closed list reads as none");
	assert.equal(row.digest, null);
	assert.equal(parseApplied({ v: 1, generation: 3, state: "great", at: NOW }), null);
});

test("an excerpt is third-party text: bounded, its control and direction characters gone", () => {
	assert.equal(changelogExcerpt(`a\u0007b‮c\r\nd`), "a b c\nd");
	assert.equal(changelogExcerpt("x".repeat(5000)).length, 2000);
	assert.equal(changelogExcerpt("   "), null);
	assert.equal(changelogExcerpt(7), null);
	assert.equal(parseCanaryFacts({ v: 1, host: "mini1", at: NOW, digest: "nope", excerpt: "<b>kept for escaping at the draw</b>" }).digest, null);
});

// ---- a host applying what a person asked for, on real files

const installer = (fail = null) => fakeNpm({ fail: fail ?? {} });
/** A host: an overlay holding `@a/b` at 1.0.0 in a kept tree, and a deployment folder that may hold a pin file. */
function aHost({ file = undefined } = {}) {
	const globalPiDir = tempDir("updates-host-"), cwd = tempDir("updates-cwd-");
	const dir = "a__b--1.0.0--aaaaaaaa";
	fs.mkdirSync(join(globalPiDir, "packages", dir), { recursive: true });
	fs.writeFileSync(join(globalPiDir, "packages", dir, "index.js"), "// 1.0.0\n");
	fs.writeFileSync(join(globalPiDir, "packages", "packages.json"), JSON.stringify({ stagedAt: "x", packages: [{ name: "@a/b", version: "1.0.0", dir, from: "host" }, { name: "other", version: "2.0.0", dir: "other", from: "pi-packages" }] }));
	if (file !== undefined) fs.writeFileSync(join(cwd, "pi-packages.json"), JSON.stringify(file));
	return { globalPiDir, cwd, env: { PI_GLOBAL_PI_DIR: globalPiDir }, dir };
}
const row = (fields = {}) => ({ v: 1, generation: 5, name: "@a/b", version: "1.1.0", op: "adopt", by: "ops", at: NOW, ...fields });
const apply = (host, desired, exec = installer().exec) => applyDesired({ desired, env: host.env, cwd: host.cwd, exec, now: clock, platform: "linux" });
const staged = (host) => readStageManifest({ globalPiDir: host.globalPiDir }).packages.find((p) => p.name === "@a/b");
const pins = (host) => JSON.parse(fs.readFileSync(join(host.cwd, "pi-packages.json"), "utf8")).packages;

test("Adopt stages the exact version in a new tree, pins it, and leaves what a running job has mounted", async () => {
	const host = aHost();
	const fake = installer();
	const out = await apply(host, row(), fake.exec);
	assert.equal(out.state, "adopted");
	assert.equal(out.version, "1.1.0");
	assert.match(out.digest, /^[a-f0-9]{64}$/);
	assert.equal(fake.calls[0].args[1], "@a/b@1.1.0");
	assert.ok(fake.calls[0].args.includes("--ignore-scripts"));
	assert.equal(fake.calls[0].options.timeout > 0, true, "a service's npm has a timeout");
	assert.ok(fake.calls.some((call) => call.args[0] === "ci"), "what it installed is what it judged");
	assert.deepEqual(staged(host).version, "1.1.0");
	assert.equal(staged(host).from, "host", "where it came from is unchanged");
	assert.deepEqual(pins(host), [{ name: "@a/b", version: "1.1.0" }]);
	assert.doesNotThrow(() => parsePackagesFile(fs.readFileSync(join(host.cwd, "pi-packages.json"), "utf8"), "x"), "the next import-pi can read what it wrote");
	assert.ok(fs.existsSync(join(host.globalPiDir, "packages", host.dir, "index.js")), "the old tree stays for the job that has it");
});

test("a job that starts at any moment of an Adopt reads a whole set", async () => {
	const host = aHost();
	const seen = [];
	const look = () => {
		const p = staged(host);
		seen.push(p.version);
		assert.ok(fs.existsSync(join(host.globalPiDir, "packages", p.dir, "index.js")), `the manifest names a tree that is there (${p.dir})`);
	};
	const stepping = { ...fs };
	for (const name of ["renameSync", "writeFileSync", "mkdirSync", "rmSync"]) stepping[name] = (...args) => { look(); const result = fs[name](...args); look(); return result; };
	const out = await applyDesired({ desired: row(), env: host.env, cwd: host.cwd, exec: installer().exec, now: clock, fs: stepping, platform: "linux" });
	assert.equal(out.state, "adopted");
	assert.ok(seen.includes("1.0.0") && seen.includes("1.1.0"), "the check saw both sides of the commit");
	assert.equal(seen.indexOf("1.1.0") > seen.lastIndexOf("1.0.0"), true, "and once on the new set, never back");
});

test("Undo restores a pin the file did not have by removing it: a written pin would override discovery for ever", async () => {
	const host = aHost();
	await apply(host, row());
	const out = await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }));
	assert.equal(out.state, "undone");
	assert.equal(out.version, "1.0.0");
	assert.equal(staged(host).dir, host.dir, "the kept tree is flipped back, not installed again");
	assert.deepEqual(pins(host), [], "the file is as it was: no entry for this package");
});

test("Undo restores a pin the file did have, and another package's later Adopt is left alone", async () => {
	const host = aHost({ file: { packages: [{ name: "@a/b", version: "1.0.0", dir: "kept" }, { name: "other", version: "2.0.0" }] } });
	await apply(host, row());
	assert.deepEqual(pins(host)[0], { name: "@a/b", version: "1.1.0", dir: "kept" }, "its other fields stay");
	await apply(host, row({ generation: 6, name: "other", version: "2.1.0" }));
	await apply(host, row({ generation: 7, op: "undo", version: "1.0.0", undoOf: 5 }));
	assert.deepEqual(pins(host), [{ name: "@a/b", version: "1.0.0", dir: "kept" }, { name: "other", version: "2.1.0" }]);
});

test("Undo after the old tree has gone stages the old version again", async () => {
	const host = aHost();
	await apply(host, row());
	fs.rmSync(join(host.globalPiDir, "packages", host.dir), { recursive: true });
	const fake = installer();
	const out = await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }), fake.exec);
	assert.equal(out.state, "undone");
	assert.equal(fake.calls[0].args[1], "@a/b@1.0.0");
	assert.ok(fs.existsSync(join(host.globalPiDir, "packages", staged(host).dir, "index.js")));
});

test("a host never moves to an older version for an Adopt, so a person's later choice stands, whoever reads the row again", async () => {
	const host = aHost();
	const manifestPath = join(host.globalPiDir, "packages", "packages.json");
	const moved = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	moved.packages[0].version = "3.0.0";
	fs.writeFileSync(manifestPath, JSON.stringify(moved));
	const fake = installer();
	const out = await apply(host, row({ version: "2.0.0" }), fake.exec);
	assert.equal(out.state, "no-change");
	assert.equal(out.version, "3.0.0");
	assert.equal(fake.calls.length, 0);
	assert.equal(fs.existsSync(join(host.cwd, "pi-packages.json")), false, "no pin written for a version it did not take");
});

test("Undo still works a long time after the Adopt: its record is not a retired stage", async () => {
	const host = aHost();
	await apply(host, row());
	const root = join(host.globalPiDir, "packages");
	const manifest = readStageManifest({ globalPiDir: host.globalPiDir });
	pruneStagedTrees({ fs, packagesRoot: root, manifest, now: () => NOW });
	pruneStagedTrees({ fs, packagesRoot: root, manifest, now: () => NOW + 3 * STAGED_TREE_KEEP_MS });
	assert.equal(fs.existsSync(join(root, host.dir)), false, "the old tree has gone by now");
	const out = await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }));
	assert.equal(out.state, "undone", "and Undo stages it again rather than silently doing nothing");
	assert.equal(staged(host).version, "1.0.0");
});

test("Undo whose old version can no longer be had says so, and leaves what jobs load and the pin alone", async () => {
	const host = aHost();
	await apply(host, row());
	fs.rmSync(join(host.globalPiDir, "packages", host.dir), { recursive: true });
	const manifestBefore = fs.readFileSync(join(host.globalPiDir, "packages", "packages.json"), "utf8");
	const pinsBefore = fs.readFileSync(join(host.cwd, "pi-packages.json"), "utf8");
	const out = await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }), installer({ "1.0.0": "npm error code E404" }).exec);
	assert.equal(out.state, "cannot-adopt");
	assert.equal(out.reason, "version-not-found");
	assert.equal(fs.readFileSync(join(host.globalPiDir, "packages", "packages.json"), "utf8"), manifestBefore, "an empty or half manifest would take every staged package from every job");
	assert.equal(fs.readFileSync(join(host.cwd, "pi-packages.json"), "utf8"), pinsBefore);
});

test("Adopt's npm sees none of the worker's tokens, and a host's Adopt retires the tree it replaced", async () => {
	const host = aHost();
	const fake = installer();
	host.env = { ...host.env, PATH: "/bin", GITHUB_TOKEN: "ghp_notreal", ANTHROPIC_API_KEY: "k" };
	await apply(host, row(), fake.exec);
	for (const call of fake.calls) assert.deepEqual(Object.keys(call.options.env), ["PATH"], call.args[0]);
	const retired = JSON.parse(fs.readFileSync(join(host.globalPiDir, "packages", ".retired.json"), "utf8"));
	assert.ok(Object.hasOwn(retired, host.dir), "its delay has started");
	assert.equal(retired[host.dir], NOW);
});

test("a retried Adopt keeps the true prior state, so Undo restores what was there and not the pin it wrote", async () => {
	const host = aHost({ file: { packages: [{ name: "@a/b", version: "1.0.0" }] } });
	// The manifest commit fails after the pin was written.
	let failNext = true;
	const flaky = { ...fs, renameSync(from, to) { if (failNext && String(to).endsWith("packages.json") && String(from).includes(".tmp") && String(to).includes(join("packages", "packages.json"))) { failNext = false; throw new Error("EIO"); } return fs.renameSync(from, to); } };
	await assert.rejects(applyDesired({ desired: row(), env: host.env, cwd: host.cwd, exec: installer().exec, now: clock, fs: flaky, platform: "linux" }));
	assert.equal(pins(host)[0].version, "1.1.0", "the failure this test is about: the pin landed");
	assert.equal(staged(host).version, "1.0.0", "and jobs are still on the old set");
	assert.equal((await apply(host, row())).state, "adopted", "the host tries again");
	await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }));
	assert.deepEqual(pins(host), [{ name: "@a/b", version: "1.0.0" }], "back to what the file said before any of it");
	assert.equal(staged(host).version, "1.0.0");
});

test("a package staged under its own dir keeps that dir's name, so a canary and an Adopt still recognise each other", async () => {
	const host = aHost();
	const manifestPath = join(host.globalPiDir, "packages", "packages.json");
	const custom = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	custom.packages[0].dir = "house--1.0.0--aaaaaaaa";
	fs.renameSync(join(host.globalPiDir, "packages", host.dir), join(host.globalPiDir, "packages", custom.packages[0].dir));
	fs.writeFileSync(manifestPath, JSON.stringify(custom));
	await apply(host, row());
	assert.match(staged(host).dir, /^house--1\.1\.0--[0-9a-f]{8}$/);
});

test("each refusal is a closed word on the host's row and changes nothing", async () => {
	const pinsOf = (host) => {
		try { return fs.readFileSync(join(host.cwd, "pi-packages.json"), "utf8"); } catch { return null; }
	};
	const unchanged = async (host, desired, reason, exec) => {
		const before = fs.readFileSync(join(host.globalPiDir, "packages", "packages.json"), "utf8");
		const pinsBefore = pinsOf(host);
		const out = await apply(host, desired, exec);
		assert.equal(out.state, "cannot-adopt");
		assert.equal(out.reason, reason);
		assert.equal(fs.readFileSync(join(host.globalPiDir, "packages", "packages.json"), "utf8"), before);
		assert.equal(pinsOf(host), pinsBefore, "and no pin was written for a version it did not take");
		assert.ok(CANNOT_ADOPT_REASONS.includes(reason));
	};
	await unchanged(aHost(), row({ name: "absent-here" }), "not-staged-here");
	const adapter = aHost();
	const manifestPath = join(adapter.globalPiDir, "packages", "packages.json");
	fs.writeFileSync(manifestPath, JSON.stringify({ stagedAt: "x", packages: [{ name: "pi-anthropic-oauth", version: "0.3.6", dir: "oauth" }] }));
	assert.equal(isSubscriptionAdapter("pi-anthropic-oauth"), true);
	const adapterRow = await apply(adapter, row({ name: "pi-anthropic-oauth", version: "0.3.7" }));
	assert.equal(adapterRow.reason, "adapter", "re-staging would break its reviewed identity");
	await unchanged(aHost(), row(), "version-not-found", installer({ "1.1.0": "npm error code E404" }).exec);
	await unchanged(aHost({ file: "not a packages document" }), row(), "packages-file-unusable");
	const garbage = aHost();
	fs.writeFileSync(join(garbage.cwd, "pi-packages.json"), "{ not json");
	await unchanged(garbage, row(), "packages-file-unusable");
	const none = await applyDesired({ desired: row(), env: {}, cwd: tempDir("updates-none-"), exec: installer().exec, now: clock });
	assert.equal(none.reason, "no-overlay");
	const assertsFail = aHost();
	const notPi = fakeNpm({ materialize: (root, name, version) => fs.writeFileSync(join(root, "package.json"), JSON.stringify({ name, version })) }).exec;
	await unchanged(assertsFail, row(), "stage-refused", notPi);
});

test("a writable pins file in a folder that is not writable cannot be replaced, and says so before installing anything", { skip: process.getuid?.() === 0 ? "root ignores file modes" : false }, async () => {
	const host = aHost({ file: { packages: [] } });
	const fake = installer();
	fs.chmodSync(host.cwd, 0o555);
	try {
		const out = await apply(host, row(), fake.exec);
		assert.equal(out.reason, "packages-file-unusable");
		assert.equal(fake.calls.length, 0);
	} finally {
		fs.chmodSync(host.cwd, 0o755);
	}
});

test("a commit that fails leaves no tree behind, so a host that keeps trying does not fill its disk", async () => {
	const host = aHost();
	const root = join(host.globalPiDir, "packages");
	const before = fs.readdirSync(root).filter((name) => name.startsWith("a__b--"));
	const broken = { ...fs, renameSync(from, to) { if (String(to) === join(root, "packages.json")) throw new Error("EIO"); return fs.renameSync(from, to); } };
	await assert.rejects(applyDesired({ desired: row(), env: host.env, cwd: host.cwd, exec: installer().exec, now: clock, fs: broken, platform: "linux" }), (error) => error.kind === "infra");
	assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith("a__b--")), before);
});

test("a read-only overlay cannot adopt, and says so", { skip: process.getuid?.() === 0 ? "root ignores file modes" : false }, async () => {
	const host = aHost();
	const root = join(host.globalPiDir, "packages");
	fs.chmodSync(root, 0o555);
	try {
		const out = await apply(host, row());
		assert.equal(out.reason, "overlay-read-only");
	} finally {
		fs.chmodSync(root, 0o755);
	}
});

test("a registry that cannot be reached or a peer's lock is no verdict: it throws so the host stays pending", async () => {
	await assert.rejects(apply(aHost(), row(), installer({ "1.1.0": "npm error code ECONNRESET" }).exec), (error) => error.kind === "infra");
	const host = aHost();
	fs.mkdirSync(join(host.globalPiDir, "packages", ".stage.lock"));
	fs.writeFileSync(join(host.globalPiDir, "packages", ".stage.lock", "holder.json"), JSON.stringify({ at: NOW }));
	await assert.rejects(apply(host, row()), (error) => error.kind === "infra");
	assert.equal(staged(host).version, "1.0.0");
});

test("adopting the version already staged changes nothing and needs no install", async () => {
	const fake = installer();
	const out = await apply(aHost(), row({ version: "1.0.0" }), fake.exec);
	assert.equal(out.state, "no-change");
	assert.equal(fake.calls.length, 0);
});

test("a host that never took an Adopt has nothing to undo: it changes nothing, whatever else is true of it", async () => {
	const host = aHost();
	const fake = installer();
	const out = await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }), fake.exec);
	assert.equal(out.state, "no-change");
	assert.equal(fake.calls.length, 0);
	assert.equal(out.version, "1.0.0");
	assert.equal(fs.existsSync(join(host.cwd, "pi-packages.json")), false);
	const undoRow = row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 });
	const none = await applyDesired({ desired: undoRow, env: {}, cwd: tempDir("updates-none-"), exec: fake.exec, now: clock });
	assert.equal(none.state, "no-change", "no overlay at all");
	const absent = aHost();
	assert.equal((await apply(absent, { ...undoRow, name: "not-staged" }, fake.exec)).state, "no-change", "not staged here");
	const garbage = aHost();
	fs.writeFileSync(join(garbage.cwd, "pi-packages.json"), "{ not json");
	assert.equal((await apply(garbage, undoRow, fake.exec)).state, "no-change", "a file it could not have written to anyway");
});

test("an Undo of an older Adopt than the one this host holds is not this host's to apply", async () => {
	const host = aHost();
	await apply(host, row());
	const out = await apply(host, row({ generation: 7, op: "undo", version: "1.0.0", undoOf: 4 }));
	assert.equal(out.state, "no-change");
	assert.equal(staged(host).version, "1.1.0");
});

test("on a shared overlay the second host finds the work done and does not lose the record of what to undo", async () => {
	const host = aHost();
	const fake = installer();
	// The peer applies this very row after this host's first read and before it takes the lock, which is the window only the second read closes.
	let peerRan = false;
	const racing = { ...fs, mkdirSync(path, options) {
		if (String(path).endsWith(".stage.lock") && !peerRan) {
			peerRan = true;
			const manifestPath = join(host.globalPiDir, "packages", "packages.json");
			const peerManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			peerManifest.packages[0] = { ...peerManifest.packages[0], version: "1.1.0" };
			fs.writeFileSync(manifestPath, JSON.stringify(peerManifest));
			fs.mkdirSync(join(host.globalPiDir, "packages", ".undo"), { recursive: true });
			fs.writeFileSync(join(host.globalPiDir, "packages", ".undo", "a__b.json"), JSON.stringify({ generation: 5, manifestEntry: { name: "@a/b", version: "1.0.0", dir: host.dir, from: "host" }, fileEntry: null }));
		}
		return fs.mkdirSync(path, options);
	} };
	const peer = await applyDesired({ desired: row(), env: host.env, cwd: host.cwd, exec: fake.exec, now: clock, fs: racing, platform: "linux" });
	assert.equal(peerRan, true);
	assert.equal(peer.state, "no-change");
	assert.equal(fake.calls.length, 0, "it installed nothing and wrote no pin");
	const out = await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }));
	assert.equal(out.state, "undone", "the first host's undo record survived");
});

test("a retired tree an Undo flips back to is rescued from the delay", async () => {
	const host = aHost();
	await apply(host, row());
	const root = join(host.globalPiDir, "packages");
	pruneStagedTrees({ fs, packagesRoot: root, manifest: readStageManifest({ globalPiDir: host.globalPiDir }), now: () => NOW + STAGED_TREE_KEEP_MS - 1 });
	assert.ok(fs.existsSync(join(root, host.dir)));
	await apply(host, row({ generation: 6, op: "undo", version: "1.0.0", undoOf: 5 }));
	assert.equal(staged(host).dir, host.dir);
	pruneStagedTrees({ fs, packagesRoot: root, manifest: readStageManifest({ globalPiDir: host.globalPiDir }), now: () => NOW + 2 * STAGED_TREE_KEEP_MS });
	assert.ok(fs.existsSync(join(root, host.dir)), "the tree the manifest names again is never removed");
});

// ---- real Valkey: the keys, and two hosts over one desired row

const VALKEY = process.env.VALKEY_TEST_URL;
// CI sets PI_DISPATCH_REQUIRE_WORKER_TESTS, which turns a missing URL into a failure rather than a quiet skip.
if (!VALKEY && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS) throw new Error("updates.test REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS is set");
const live = { skip: VALKEY ? false : "needs VALKEY_TEST_URL (CI sets it)" };
async function withValkey(fn) {
	const redis = makeRedisClient(VALKEY, {});
	const wipe = async () => {
		const keys = await redis.keys("updates:*");
		if (keys.length) await redis.del(...keys);
	};
	try {
		await wipe();
		await fn(redis);
	} finally {
		await wipe().catch(() => {});
		redis.disconnect();
	}
}

test("the generation and its row land together, and concurrent requests end on the newest", live, async () => {
	await withValkey(async (redis) => {
		const asks = Array.from({ length: 20 }, (_, i) => setDesired(redis, { name: "@a/b", version: `1.0.${i}`, op: "adopt", by: "ops", at: NOW }));
		const generations = await Promise.all(asks);
		assert.deepEqual([...generations].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
		const [row1] = await readDesired(redis);
		assert.equal(row1.generation, 20);
		assert.equal(row1.version, `1.0.${generations.indexOf(20)}`, "the row is the one that took the newest generation");
		assert.equal(await redis.get(UPDATES_GENERATION), "20");
		assert.equal(await redis.hlen(UPDATES_DESIRED), 1);
	});
});

test("what a person was shown has to still be the row, or nothing is written", live, async () => {
	await withValkey(async (redis) => {
		const first = await setDesired(redis, { name: "@a/b", version: "1.1.0", op: "adopt", by: "ops", at: NOW, expectGeneration: 0 });
		assert.equal(first, 1, "no row yet, as expected");
		assert.equal(await setDesired(redis, { name: "@a/b", version: "1.2.0", op: "adopt", by: "ops", at: NOW, expectGeneration: 0 }), 0, "someone got there first");
		assert.equal((await readDesired(redis))[0].version, "1.1.0");
		const second = await setDesired(redis, { name: "@a/b", version: "1.0.0", op: "undo", undoOf: first, by: "ops", at: NOW, expectGeneration: first });
		assert.ok(second > first);
		assert.equal(await setDesired(redis, { name: "@a/b", version: "1.0.0", op: "undo", undoOf: first, by: "ops", at: NOW, expectGeneration: first }), 0, "an Undo of what has moved");
		assert.equal(await redis.get(UPDATES_GENERATION), String(second), "a refused write takes no generation");
		assert.ok(await setDesired(redis, { name: "other", version: "1.0.0", op: "adopt", by: "ops", at: NOW }), "without an expectation it is plain last-writer");
	});
});

test("looks, applied rows and canary facts round trip, each with its expiry, and a read writes nothing", live, async () => {
	await withValkey(async (redis) => {
		await publishLook(redis, { v: 1, host: "mini1", at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [] });
		assert.ok((await redis.pttl(updatesLookKey("mini1"))) > 0);
		assert.deepEqual(await redis.smembers(UPDATES_HOSTS), ["mini1"]);
		await redis.sadd(UPDATES_HOSTS, "expired-host");
		const read = await readLooks(redis, { now: () => NOW + 49 * 3_600_000 });
		assert.equal(read.hosts.length, 1);
		assert.equal(read.hosts[0].stale, true);
		assert.equal(read.more, 0);
		assert.equal((await redis.smembers(UPDATES_HOSTS)).length, 2, "a viewer's read prunes nothing");
		await writeApplied(redis, "mini1", "@a/b", { v: 1, generation: 2, state: "adopted", version: "1.1.0", at: NOW });
		assert.equal(await redis.pttl(updatesAppliedKey("mini1")), -1, "no expiry: an expired row would have this host read an old request as new");
		assert.equal((await readApplied(redis, "mini1"))["@a/b"].state, "adopted");
		await publishCanaryFacts(redis, { name: "@a/b", version: "1.1.0", host: "mini1", digest: "a".repeat(64), excerpt: "changes", at: NOW });
		assert.ok((await redis.pttl(updatesCanaryKey("@a/b", "1.1.0"))) > 0);
		assert.deepEqual(await readCanaryFacts(redis, "@a/b", "1.1.0"), { v: 1, host: "mini1", at: NOW, digest: "a".repeat(64), excerpt: "changes" });
		assert.equal(await readCanaryFacts(redis, "@a/b", "9.9.9"), null);
	});
});

test("two hosts, one offline: it adopts on return, and an Adopt then Undo it missed never replays", live, async () => {
	await withValkey(async (redis) => {
		const up = aHost(), off = aHost();
		const pass = (host, name, exec = installer().exec) => reconcileUpdates({ redis, host: name, env: host.env, cwd: host.cwd, exec, now: clock, platform: "linux" });
		const first = await setDesired(redis, { name: "@a/b", version: "1.1.0", op: "adopt", by: "ops", at: NOW });
		assert.equal(await hostHasPending(redis, "up"), true);
		assert.deepEqual(await pass(up, "up"), { applied: 1, pending: 0 });
		assert.equal(await hostHasPending(redis, "up"), false, "nothing starts on the next tick");
		assert.equal((await readApplied(redis, "up"))["@a/b"].state, "adopted");
		assert.equal(staged(up).version, "1.1.0");
		assert.equal((await readApplied(redis, "off"))["@a/b"], undefined, "the offline host has no row, which the page shows as pending");

		// It returns: it adopts what a person asked for.
		const lateAdopt = aHost();
		await pass(lateAdopt, "late");
		assert.equal(staged(lateAdopt).version, "1.1.0");

		// The Undo arrives while `off` is still away, so all it ever reads is the newest row.
		await setDesired(redis, { name: "@a/b", version: "1.0.0", op: "undo", undoOf: first, by: "ops", at: NOW + 1 });
		await pass(up, "up");
		assert.equal((await readApplied(redis, "up"))["@a/b"].state, "undone");
		assert.equal(staged(up).version, "1.0.0");
		const fake = installer();
		await pass(off, "off", fake.exec);
		assert.equal(fake.calls.length, 0, "the Adopt it missed is not replayed");
		assert.equal(staged(off).version, "1.0.0");
		assert.equal((await readApplied(redis, "off"))["@a/b"].state, "no-change");
		assert.equal(await hostHasPending(redis, "off"), false);
	});
});

test("an outage leaves the host pending and it tries again; one package's failure does not stop another's", live, async () => {
	await withValkey(async (redis) => {
		const host = aHost();
		await setDesired(redis, { name: "@a/b", version: "1.1.0", op: "adopt", by: "ops", at: NOW });
		await setDesired(redis, { name: "other", version: "2.1.0", op: "adopt", by: "ops", at: NOW });
		const logged = [];
		const failing = installer({ "1.1.0": "npm error code ETIMEDOUT" });
		const done = await reconcileUpdates({ redis, host: "h", env: host.env, cwd: host.cwd, exec: failing.exec, now: clock, platform: "linux", log: (event, fields) => logged.push({ event, ...fields }) });
		assert.deepEqual(done, { applied: 1, pending: 1 });
		assert.equal(await hostHasPending(redis, "h"), true);
		assert.equal((await readApplied(redis, "h"))["@a/b"], undefined, "no row, so it stays pending");
		assert.equal((await readApplied(redis, "h")).other.state, "adopted");
		assert.ok(logged.some((line) => line.event === "updates_pending" && line.kind === "infra"));
		assert.deepEqual(await reconcileUpdates({ redis, host: "h", env: host.env, cwd: host.cwd, exec: installer().exec, now: clock, platform: "linux" }), { applied: 1, pending: 0 });
		assert.equal(staged(host).version, "1.1.0");
	});
});

test("the child the worker starts does the work end to end, through a real connection", live, async () => {
	await withValkey(async (redis) => {
		const host = aHost();
		await setDesired(redis, { name: "@a/b", version: "1.1.0", op: "adopt", by: "ops", at: NOW });
		const printed = [];
		const code = await runUpdatesCli(["reconcile"], { env: { ...host.env, VALKEY_URL: VALKEY, PI_WORKER_NAME: "cli-host" }, cwd: host.cwd, exec: installer().exec, out: (s) => printed.push(s), err: (s) => printed.push(s) });
		assert.equal(code, 0, printed.join(""));
		assert.equal(staged(host).version, "1.1.0");
		assert.equal((await readApplied(redis, "cli-host"))["@a/b"].state, "adopted");
		assert.match(printed.join(""), /"updates_applied"/);
		assert.equal(printed.join("").includes(host.globalPiDir), false, "names and words only");
		const look = async ({ host: name }) => ({ v: 1, host: name, at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [] });
		assert.equal(await runUpdatesCli(["look"], { env: { VALKEY_URL: VALKEY, PI_WORKER_NAME: "cli-host", PI_UPDATES_LOOK: "1" }, look, out: () => {} }), 0);
		assert.equal((await readLooks(redis)).hosts[0].record.host, "cli-host");
	});
});

test("the child's look goes through the declared proxy", async () => {
	const seen = [];
	const look = async ({ get, host }) => {
		await get("https://registry.example/x");
		return { v: 1, host, at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [] };
	};
	const code = await runUpdatesCli(["look"], { env: { VALKEY_URL: "redis://x", PI_WORKER_NAME: "h", PI_UPDATES_LOOK: "1", PI_UPDATES_PROXY: "http://proxy:3128" }, look, out: () => {}, fetchJson: async (url, options) => { seen.push([url, options.proxyUrl]); return { value: null }; }, withClient: async (_url, fn) => fn({ set: async () => "OK", sadd: async () => 1 }) });
	assert.equal(code, 0);
	assert.deepEqual(seen, [["https://registry.example/x", "http://proxy:3128"]]);
});

test("the child refuses what it was not asked for, and a look that is off starts nothing", async () => {
	const said = [];
	const err = (s) => said.push(s);
	const never = async () => { throw new Error("must not connect"); };
	assert.equal(await runUpdatesCli(["nope"], { err, withClient: never }), 2);
	assert.equal(await runUpdatesCli(["look", "extra"], { err, withClient: never }), 2);
	assert.equal(await runUpdatesCli(["look"], { env: { VALKEY_URL: "redis://x" }, err, withClient: never }), 2);
	assert.match(said.at(-1), /off until PI_UPDATES_LOOK=1/);
	assert.equal(await runUpdatesCli(["reconcile"], { env: {}, err, withClient: never }), 1);
	assert.match(said.at(-1), /VALKEY_URL/);
	assert.equal(await runUpdatesCli(["reconcile"], { env: { VALKEY_URL: "redis://x", PI_WORKER_NAME: "h" }, err, withClient: async () => { throw Object.assign(new Error("secret in here"), { code: "ECONNREFUSED" }); } }), 1);
	assert.match(said.at(-1), /ECONNREFUSED/);
	assert.equal(said.join("").includes("secret"), false);
});

test("Valkey going away is a failed read, never a false picture", async () => {
	const dead = { smembers: async () => { throw new Error("down"); }, hgetall: async () => { throw new Error("down"); }, get: async () => { throw new Error("down"); } };
	assert.deepEqual(await readLooks(dead), { unreachable: true });
	assert.equal(await readDesired(dead), null);
	assert.equal(await readApplied(dead, "h"), null);
	assert.equal(await hostHasPending(dead, "h"), false, "not knowing starts nothing");
	assert.equal(await readCanaryFacts(dead, "a", "1.0.0"), null);
	assert.deepEqual(await reconcileUpdates({ redis: dead, host: "h", env: {}, cwd: "/", exec: async () => {} }), { unreachable: true });
});
