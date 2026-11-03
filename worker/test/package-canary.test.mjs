import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, relative } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fakeNpm } from "./helpers/fake-npm.mjs";
import { makePackageCanaryRuntime, parsePackageCanary, readChangelog, recordedPackageCanary, stagedContainerPath, withCanaryPath } from "../src/package-canary.mjs";
import { buildRecord, parseExitCanaryLoad } from "../src/run-history.mjs";
import { CONTAINER_ENV_NAMES } from "../src/reserved-env.mjs";

const NOW = 1_800_000_000_000;
const CANARY = { name: "@a/b", version: "1.1.0" };

function overlay(packages = [{ name: "@a/b", version: "1.0.0", dir: "a__b--1.0.0--aaaaaaaa", from: "host" }]) {
	const globalPiDir = tempDir("canary-overlay-");
	fs.mkdirSync(join(globalPiDir, "packages"));
	fs.writeFileSync(join(globalPiDir, "packages", "packages.json"), JSON.stringify({ stagedAt: "x", packages }));
	return globalPiDir;
}
const npm = ({ view, install = null, files } = {}) => fakeNpm({ view, files, fail: install ? { "1.1.0": install.stderr ?? install.message } : {} });
const runtime = (over = {}) => makePackageCanaryRuntime({ globalPiDir: overlay(), env: { PATH: "/bin", GITHUB_TOKEN: "ghp_secret", ANTHROPIC_API_KEY: "k" }, platform: "linux", host: "mini1", now: () => NOW, ...over });

test("the job field is rebuilt: one package at one exact version, or nothing", () => {
	assert.deepEqual(parsePackageCanary({ ...CANARY, extra: "dropped" }), CANARY);
	for (const bad of [null, [], "x", { name: "@a/b" }, { ...CANARY, version: "^1.0.0" }, { ...CANARY, version: "latest" }, { ...CANARY, name: "../up" }, { ...CANARY, name: "A B" }]) assert.equal(parsePackageCanary(bad), null, JSON.stringify(bad));
});

test("the record says what the runner said, in a closed word, and a missing report reads as its own word", () => {
	assert.deepEqual(recordedPackageCanary(CANARY, "loaded"), { ...CANARY, load: "loaded" });
	assert.deepEqual(recordedPackageCanary(CANARY, "failed"), { ...CANARY, load: "failed" });
	for (const other of [null, undefined, "passed", "LOADED", 1]) assert.equal(recordedPackageCanary(CANARY, other).load, "not-reported");
	assert.equal(recordedPackageCanary({ name: "<b>", version: "1.0.0" }, "loaded"), null);
});

test("the exit line's word is read closed", () => {
	const line = (fields) => `${JSON.stringify({ event: "exit", jobId: "j", code: 0, reason: "completed", ...fields })}\n`;
	assert.equal(parseExitCanaryLoad(line({ canaryLoad: "loaded" })), "loaded");
	assert.equal(parseExitCanaryLoad(line({ canaryLoad: "failed" })), "failed");
	assert.equal(parseExitCanaryLoad(line({ canaryLoad: "passed" })), null);
	assert.equal(parseExitCanaryLoad(line({})), null);
	assert.equal(parseExitCanaryLoad("not a line"), null);
});

test("the run record carries the canary, and nothing on any other run", () => {
	const record = (data, result) => buildRecord({ job: { id: "j", name: "cron", data }, result, startedAt: "2026-11-02T00:00:00.000Z", endedAt: "2026-11-02T00:01:00.000Z" });
	assert.deepEqual(record({ kind: "local", packageCanary: CANARY }, { outcome: "completed", canaryLoad: "loaded" }).packageCanary, { ...CANARY, load: "loaded" });
	assert.equal(record({ kind: "local", packageCanary: CANARY }, { outcome: "failed" }).packageCanary.load, "not-reported");
	assert.equal(Object.hasOwn(record({ kind: "local" }, { outcome: "completed", canaryLoad: "loaded" }), "packageCanary"), false);
	assert.equal(Object.hasOwn(record({ kind: "local", packageCanary: { name: "<script>", version: "1" } }, { outcome: "completed" }), "packageCanary"), false, "no attacker-chosen string reaches the record");
});

test("a trigger cannot name the variable", () => {
	assert.ok(CONTAINER_ENV_NAMES.has("PI_PACKAGE_CANARY"));
});

// ---- the candidate replaces the staged copy, for this job only

const STAGED = ["/opt/pi-global/packages/first", "/opt/pi-global/packages/a__b--1.0.0--aaaaaaaa", "/opt/pi-global/packages/last"];
const PLAN = { replaces: "a__b--1.0.0--aaaaaaaa", tree: "a__b--1.1.0--bbbbbbbb" };

test("the candidate takes the staged copy's place, never a place beside it", () => {
	const { paths, candidate } = withCanaryPath(STAGED, PLAN, "/job");
	assert.equal(candidate, "/job/canary/a__b--1.1.0--bbbbbbbb");
	assert.deepEqual(paths, ["/opt/pi-global/packages/first", candidate, "/opt/pi-global/packages/last"], "and in its place: package order is pi's load order");
});

test("an Adopt that moved the manifest since the check still leaves one copy of the package", () => {
	const moved = ["/opt/pi-global/packages/first", "/opt/pi-global/packages/a__b--1.2.0--cccccccc"];
	assert.deepEqual(withCanaryPath(moved, PLAN, "/job").paths, ["/opt/pi-global/packages/first", "/job/canary/a__b--1.1.0--bbbbbbbb"]);
	const legacy = ["/opt/pi-global/packages/a__b"];
	assert.deepEqual(withCanaryPath(legacy, { replaces: "a__b", tree: "a__b--1.1.0--bbbbbbbb" }, "/job").paths, ["/job/canary/a__b--1.1.0--bbbbbbbb"], "a manifest from before per-stage directories too");
	assert.deepEqual(withCanaryPath(["/opt/pi-global/packages/a__bc--1.0.0--dddddddd"], PLAN, "/job").paths, ["/opt/pi-global/packages/a__bc--1.0.0--dddddddd", "/job/canary/a__b--1.1.0--bbbbbbbb"], "a package whose name merely starts the same is another package");
});

test("a job that manifest no longer holds the package for still loads the candidate", () => {
	assert.deepEqual(withCanaryPath([], PLAN, "/job").paths, ["/job/canary/a__b--1.1.0--bbbbbbbb"]);
	const beside = ["/opt/pi-global/packages/foo--bar--1.0.0--aaaaaaaa", "/opt/pi-global/packages/foo--1.0.0--bbbbbbbb"];
	assert.deepEqual(withCanaryPath(beside, { replaces: "foo--1.0.0--bbbbbbbb", tree: "foo--2.0.0--cccccccc" }, "/job").paths, ["/opt/pi-global/packages/foo--bar--1.0.0--aaaaaaaa", "/job/canary/foo--2.0.0--cccccccc"], "foo--bar is another package, though its name starts the same");
});

test("each layout's own /job names the candidate", () => {
	assert.equal(withCanaryPath(STAGED, PLAN, "/sandbox/job").candidate, "/sandbox/job/canary/a__b--1.1.0--bbbbbbbb");
	assert.equal(stagedContainerPath("x"), "/opt/pi-global/packages/x");
});

// ---- the free check

test("every free refusal is a closed reason, before npm is asked anything that costs", async () => {
	const fake = npm();
	const check = (job, over = {}) => runtime({ exec: fake.exec, ...over }).check(job);
	assert.deepEqual(await check({ packageCanary: { name: "<b>", version: "1.0.0" } }), { refused: "package-canary-invalid" });
	assert.deepEqual(await check({ packageCanary: CANARY, packages: false }), { refused: "package-canary-packages-off" });
	assert.deepEqual(await check({ packageCanary: { name: "pi-anthropic-oauth", version: "0.3.7" } }), { refused: "package-canary-adapter" });
	assert.deepEqual(await check({ packageCanary: CANARY, resume: true }), { refused: "package-canary-resume" }, "its next run would continue the candidate's work");
	assert.deepEqual(await check({ packageCanary: { name: "absent", version: "1.0.0" } }), { refused: "package-canary-not-staged" });
	assert.deepEqual(await check({ packageCanary: CANARY }, { globalPiDir: undefined }), { refused: "package-canary-not-staged" });
	assert.equal(fake.calls.length, 0, "none of these needed the registry");
});

test("the registry check reads metadata only, sees no token, and tells absent from unreachable", async () => {
	const fake = npm();
	const ok = await runtime({ exec: fake.exec }).check({ packageCanary: CANARY });
	assert.deepEqual(ok, { ok: true, canary: CANARY, replaces: "a__b--1.0.0--aaaaaaaa" });
	assert.equal(fake.calls[0].args[0], "view", "no tarball is fetched and nothing the package wrote runs");
	assert.equal(fake.calls[0].args[1], "@a/b@1.1.0");
	assert.deepEqual(Object.keys(fake.calls[0].options.env), ["PATH"], "the worker's tokens stay out of npm's environment");
	assert.ok(fake.calls[0].options.timeout > 0);
	assert.deepEqual(await runtime({ exec: npm({ view: { stdout: "" } }).exec }).check({ packageCanary: CANARY }), { refused: "package-canary-version-missing" }, "npm prints nothing for a version that is not there");
	assert.deepEqual(await runtime({ exec: npm({ view: Object.assign(new Error("x"), { stderr: "npm error code E404" }) }).exec }).check({ packageCanary: CANARY }), { refused: "package-canary-version-missing" });
	await assert.rejects(runtime({ exec: npm({ view: Object.assign(new Error("x"), { stderr: "npm error code ETIMEDOUT" }) }).exec }).check({ packageCanary: CANARY }), (error) => error.kind === "infra", "an outage is no verdict on the version");
});

// ---- the install

test("the candidate lands under this job's directory, the overlay is untouched, and its facts go beside the host's", async () => {
	const globalPiDir = overlay();
	const before = fs.readFileSync(join(globalPiDir, "packages", "packages.json"), "utf8");
	const jobDir = tempDir("canary-job-");
	const published = [];
	const fake = npm({ files: { "CHANGELOG.md": "# 1.1.0\n\nFixes a thing.\n" } });
	const got = await runtime({ globalPiDir, exec: fake.exec, publishFacts: async (facts) => published.push(facts) }).install({ packageCanary: CANARY }, jobDir, { replaces: "a__b--1.0.0--aaaaaaaa" });
	assert.equal(got.replaces, "a__b--1.0.0--aaaaaaaa");
	assert.match(got.tree, /^a__b--1\.1\.0--[0-9a-f]{8}$/);
	assert.ok(fs.existsSync(join(jobDir, "canary", got.tree, "index.js")));
	assert.deepEqual(fs.readdirSync(join(jobDir, "canary")), [got.tree], "its staging directory is gone");
	assert.equal(fs.readFileSync(join(globalPiDir, "packages", "packages.json"), "utf8"), before);
	assert.deepEqual(fs.readdirSync(join(globalPiDir, "packages")), ["packages.json"], "a concurrent job, which mounts the overlay whole, cannot see it");
	assert.ok(fake.calls[0].args.includes("--ignore-scripts"));
	assert.deepEqual(Object.keys(fake.calls[0].options.env), ["PATH"]);
	assert.deepEqual(fake.calls.map((call) => call.args[0]), ["install", "config", "ci"], "resolved and judged before anything is installed");
	assert.equal(published.length, 1);
	assert.equal(published[0].name, "@a/b");
	assert.equal(published[0].host, "mini1");
	assert.equal(published[0].at, NOW);
	assert.match(published[0].digest, /^[a-f0-9]{64}$/);
	assert.match(published[0].excerpt, /Fixes a thing/);
});

test("a failure to publish the facts costs a line on the page, never the job", async () => {
	const logged = [];
	const got = await runtime({ exec: npm().exec, publishFacts: async () => { throw new Error("valkey down"); }, log: (event) => logged.push(event) }).install({ packageCanary: CANARY }, tempDir("canary-job-"), { replaces: "x" });
	assert.ok(got.tree);
	assert.deepEqual(logged, ["package_canary_facts_unpublished"]);
});

test("an install's failure says which kind it is", async () => {
	const install = (exec) => runtime({ exec }).install({ packageCanary: CANARY }, tempDir("canary-job-"), { replaces: "x" });
	assert.deepEqual(await install(npm({ install: { stderr: "npm error code ETARGET" } }).exec), { refused: "package-canary-version-missing" });
	await assert.rejects(install(npm({ install: { stderr: "npm error code ECONNRESET" } }).exec), (error) => error.kind === "infra");
	assert.deepEqual(await install(fakeNpm({ resolved: { resolved: "git+https://example.invalid/x.git#abc" } }).exec), { refused: "package-canary-refused" }, "a tree holding a git dependency installs nothing");
	const notPi = fakeNpm({ materialize: (root, name, version) => fs.writeFileSync(join(root, "package.json"), JSON.stringify({ name, version })) }).exec;
	assert.deepEqual(await install(notPi), { refused: "package-canary-refused" });
});

test("a changelog is read as pi finds it, inside its package, and bounded", () => {
	const root = tempDir("canary-changelog-");
	const write = (pkg, files = {}) => {
		fs.writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
		for (const [file, text] of Object.entries(files)) fs.writeFileSync(join(root, file), text);
	};
	write({ pi: { changelogPath: "HISTORY.md" } }, { "HISTORY.md": "declared", "CHANGELOG.md": "default" });
	assert.equal(readChangelog(root), "declared");
	write({}, {});
	assert.equal(readChangelog(root), "default");
	// Real files out there, so that these are refused for where they point and not because they are not found.
	const outside = tempDir("canary-changelog-outside-");
	fs.writeFileSync(join(outside, "secret.txt"), "a file of this host");
	write({ pi: { changelogPath: relative(root, join(outside, "secret.txt")) } });
	assert.equal(readChangelog(root), null, "a path that leaves the package is ignored");
	write({ pi: { changelogPath: join(outside, "secret.txt") } });
	assert.equal(readChangelog(root), null);
	fs.symlinkSync("/etc/hosts", join(root, "LINK.md"));
	write({ pi: { changelogPath: "LINK.md" } });
	assert.equal(readChangelog(root), null, "a link could point anywhere on the host");
	const elsewhere = tempDir("canary-changelog-elsewhere-");
	fs.writeFileSync(join(elsewhere, "secret.txt"), "a file of this host");
	fs.symlinkSync(elsewhere, join(root, "linked-dir"));
	write({ pi: { changelogPath: "linked-dir/secret.txt" } });
	assert.equal(readChangelog(root), null, "a link earlier in the path reaches the host just the same");
	write({ pi: { changelogPath: "BIG.md" } }, { "BIG.md": "x".repeat(1024 * 1024) });
	assert.equal(readChangelog(root).length, 2000);
	let asked = 0;
	const counting = { ...fs, readSync(handle, buffer, offset, length, position) { asked += length; return fs.readSync(handle, buffer, offset, length, position); } };
	readChangelog(root, counting);
	assert.ok(asked > 0 && asked <= 64 * 1024, "a huge changelog is not read whole");
	fs.rmSync(join(root, "package.json"));
	assert.equal(readChangelog(root), null);
});
