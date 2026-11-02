import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { PackageStageError, UNDO_DIR, lockfileProblem, npmFailureKind, pruneStagedTrees, serviceNpmEnv, stagePackageTree, stagedStem, stagedTreeName, treeDigest, withStageLock, writeStageManifest, STAGED_TREE_KEEP_MS, STAGE_LOCK_STALE_MS } from "../src/package-stage.mjs";
import { fakeNpm } from "./helpers/fake-npm.mjs";
import { readStageManifest, PACKAGES_SUBDIR } from "../src/packages.mjs";

const overlay = () => {
	const globalPiDir = tempDir("package-stage-");
	const packagesRoot = join(globalPiDir, PACKAGES_SUBDIR);
	fs.mkdirSync(packagesRoot);
	return { globalPiDir, packagesRoot };
};
const write = (path, value) => {
	fs.mkdirSync(join(path, ".."), { recursive: true });
	fs.writeFileSync(path, value);
};
/** npm, failing as told. */
const npm = ({ fails = null, ...rest } = {}) => fakeNpm({ ...rest, fail: fails ? { "1.2.3": fails } : {} });
const stage = ({ exec, packagesRoot }, entry = { name: "@acme/tool", version: "1.2.3", dir: "acme__tool" }) => stagePackageTree({ fs, exec, entry, packagesRoot, npmBin: "npm", platform: "linux" });

test("a stage lands in a directory of its own and touches nothing already staged", async () => {
	const { packagesRoot } = overlay();
	const running = join(packagesRoot, "acme__tool");
	write(join(running, "index.js"), "the file a running job has open");
	const { dir } = await stage({ exec: npm().exec, packagesRoot });
	assert.match(dir, /^acme__tool--1\.2\.3--[0-9a-f]{8}$/);
	assert.equal(fs.readFileSync(join(running, "index.js"), "utf8"), "the file a running job has open", "the old tree is exactly as it was");
	assert.match(fs.readFileSync(join(packagesRoot, dir, "index.js"), "utf8"), /1\.2\.3/);
	assert.deepEqual(fs.readdirSync(packagesRoot).filter((name) => name.startsWith(".staging")), [], "its staging directory is gone");
});

test("two stages of one version never share a directory, so a re-stage cannot change a running job's tree", async () => {
	const { packagesRoot } = overlay();
	const a = await stage({ exec: npm().exec, packagesRoot }), b = await stage({ exec: npm().exec, packagesRoot });
	assert.notEqual(a.dir, b.dir);
});

test("a failed install leaves nothing behind and names its kind", async () => {
	const { packagesRoot } = overlay();
	await assert.rejects(stage({ exec: npm({ fails: "npm error code E404\nnpm error 404 Not Found" }).exec, packagesRoot }), (error) => error instanceof PackageStageError && error.kind === "not-found");
	await assert.rejects(stage({ exec: npm({ fails: "npm error code ETIMEDOUT" }).exec, packagesRoot }), (error) => error.kind === "infra");
	assert.deepEqual(fs.readdirSync(packagesRoot), []);
});

test("a package that fails an assertion is a determinate refusal, not an outage", async () => {
	const { packagesRoot } = overlay();
	const writes = (manifest) => fakeNpm({ materialize: (root, name, version) => write(join(root, "package.json"), JSON.stringify({ name, version, ...manifest(version) })) }).exec;
	await assert.rejects(stage({ exec: writes(() => ({ version: "9.9.9", pi: {} })), packagesRoot }), (error) => error.kind === "policy" && /not the pinned/.test(error.message));
	await assert.rejects(stage({ exec: writes(() => ({})), packagesRoot }), (error) => error.kind === "policy" && /not a pi package/.test(error.message));
	await assert.rejects(stage({ exec: writes(() => ({ pi: { extensions: ["../../other"] } })), packagesRoot }), (error) => error.kind === "policy" && /leaves the package dir/.test(error.message));
});

test("--ignore-scripts and the other install flags hold on this path too", async () => {
	const { packagesRoot } = overlay();
	const fake = npm();
	await stage({ exec: fake.exec, packagesRoot });
	const steps = fake.calls.map((call) => call.args[0]);
	assert.deepEqual(steps, ["install", "config", "ci"], "resolve, judge, and only then install");
	assert.ok(fake.calls[0].args.includes("--package-lock-only"), "the first step installs nothing");
	for (const call of [fake.calls[0], fake.calls[2]]) for (const flag of ["--ignore-scripts", "--omit=dev", "--omit=peer", "--omit=optional", "--install-strategy=nested"]) assert.ok(call.args.includes(flag), flag);
	assert.equal(fake.calls[0].args[1], "@acme/tool@1.2.3", "an exact spec, never a range");
});

test("npm is only named absent when it says so: an outage is never a verdict on a package", () => {
	for (const stderr of ["npm error code E404", "npm error code ETARGET\nnpm error notarget No matching version"]) assert.equal(npmFailureKind({ stderr }), "not-found");
	for (const stderr of ["npm error code ECONNRESET", "npm error code E500", "npm error code ENOTFOUND registry", ""]) assert.equal(npmFailureKind({ stderr }), "infra", stderr);
	for (const stderr of ["npm error code EUNSUPPORTEDPROTOCOL", "npm error code ERESOLVE", "npm error code EINTEGRITY"]) assert.equal(npmFailureKind({ stderr }), "policy", `${stderr}: it can never install as asked, so retrying it is only repeating it`);
	assert.equal(npmFailureKind(new Error("spawn npm ENOENT")), "infra");
});

test("a service's npm sees no token of the worker's, and can still reach a registry", () => {
	const env = serviceNpmEnv({ PATH: "/bin", HOME: "/home/svc", HTTPS_PROXY: "http://proxy:3128", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "y", VALKEY_URL: "z", NPM_TOKEN: "n" });
	assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "PATH"]);
	assert.equal(serviceNpmEnv({ PATH: "/bin", PI_UPDATES_REGISTRY: "https://mirror.example/" }).npm_config_registry, "https://mirror.example/", "a private name must not fall through to the public registry");
	assert.equal(serviceNpmEnv({ PATH: "/bin", NPM_CONFIG_REGISTRY: "https://r/" }).NPM_CONFIG_REGISTRY, "https://r/");
	assert.equal(serviceNpmEnv({ NPM_TOKEN: "n", NPM_CONFIG__AUTH: "a" }).NPM_CONFIG__AUTH, undefined);
});

test("a tree holding anything but registry tarballs with a hash is refused, whichever way it got there", () => {
	const ok = { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-abc" };
	const origins = ["https://registry.npmjs.org"];
	const judged = (entry, name = "node_modules/a") => lockfileProblem({ packages: { "": {}, [name]: entry } }, origins);
	assert.equal(judged(ok), null);
	assert.equal(judged({ inBundle: true }), null, "what a checked tarball carries inside itself");
	assert.match(judged({ ...ok, resolved: "git+ssh://git@github.com/a/a.git#abc" }), /a does not come from/);
	assert.match(judged({ ...ok, resolved: "git+https://github.com/a/a.git#abc" }), /does not come from/);
	assert.match(judged({ ...ok, resolved: "https://evil.example/a.tgz" }), /does not come from/, "a tarball URL has npm fetch wherever the package said");
	assert.match(judged({ ...ok, resolved: "file:../a" }), /does not come from/);
	assert.match(judged({ link: true, resolved: "../a" }), /is a link/);
	assert.match(judged({ version: "1.0.0" }), /does not come from/);
	assert.match(judged({ ...ok, integrity: undefined }), /no integrity hash/);
	assert.match(lockfileProblem({ packages: { "": {}, "node_modules/x/node_modules/deep": { resolved: "https://evil.example/d.tgz", integrity: "sha512-a" } } }, origins), /^deep does not come from/, "named by the dependency itself, however deep");
	assert.equal(lockfileProblem({ packages: { "": {}, "node_modules/a": { ...ok, resolved: "https://mirror.example/a.tgz" } } }, ["https://mirror.example"]), null, "a scoped or private registry the account configured");
	assert.match(lockfileProblem({}, origins), /no tree/);
	assert.match(lockfileProblem(null, origins), /no tree/);
});

test("a tree's base is read from the right, so a name holding -- is not cut short", () => {
	assert.equal(stagedStem("foo--1.0.0--abcd1234"), "foo");
	assert.equal(stagedStem("foo--bar--1.0.0--abcd1234"), "foo--bar");
	assert.equal(stagedStem("foo--1.0.0-rc.1_build--abcd1234"), "foo");
	assert.equal(stagedStem("legacy-dir"), "legacy-dir");
	assert.equal(stagedStem(stagedTreeName("acme__tool", "1.2.3-rc.1+b5")), "acme__tool");
});

test("the manifest commits whole: a reader sees the old file or the new one, and a failed rename leaves the old one and no temp", () => {
	const { globalPiDir, packagesRoot } = overlay();
	writeStageManifest({ fs, packagesRoot, manifest: { stagedAt: "a", packages: [{ name: "a", version: "1.0.0", dir: "a--1.0.0--aaaaaaaa", from: "pi-packages" }] } });
	assert.deepEqual(readStageManifest({ globalPiDir }).packages.map((p) => p.dir), ["a--1.0.0--aaaaaaaa"], "the long per-stage name is a valid dir");
	const broken = { ...fs, renameSync: () => { throw new Error("EIO"); } };
	assert.throws(() => writeStageManifest({ fs: broken, packagesRoot, manifest: { stagedAt: "b", packages: [] } }));
	assert.equal(readStageManifest({ globalPiDir }).stagedAt, "a");
	assert.deepEqual(fs.readdirSync(packagesRoot).filter((name) => name.endsWith(".tmp")), []);
});

test("a manifest from before per-stage directories is still read", () => {
	const { globalPiDir, packagesRoot } = overlay();
	fs.writeFileSync(join(packagesRoot, "packages.json"), JSON.stringify({ stagedAt: "x", packages: [{ name: "a", version: "1.0.0", dir: "a" }] }));
	assert.deepEqual(readStageManifest({ globalPiDir }).packages.map((p) => p.dir), ["a"]);
});

test("a path is still refused as a dir, however long the name became", () => {
	const { globalPiDir, packagesRoot } = overlay();
	for (const dir of ["../up", "a/b", ".hidden", `${"a".repeat(145)}`]) {
		fs.writeFileSync(join(packagesRoot, "packages.json"), JSON.stringify({ packages: [{ name: "a", version: "1.0.0", dir }] }));
		assert.equal(readStageManifest({ globalPiDir }), null, dir);
	}
});

test("an old tree outlives any job: kept from when it left the manifest, removed after the delay, and rescued if it is named again", () => {
	const { packagesRoot } = overlay();
	let at = 1_000_000;
	const now = () => at;
	write(join(packagesRoot, "old--1.0.0--aaaaaaaa", "index.js"), "x");
	write(join(packagesRoot, "new--2.0.0--bbbbbbbb", "index.js"), "y");
	const current = { packages: [{ dir: "new--2.0.0--bbbbbbbb" }] };
	pruneStagedTrees({ fs, packagesRoot, manifest: current, now });
	assert.ok(fs.existsSync(join(packagesRoot, "old--1.0.0--aaaaaaaa")), "the first prune only starts its delay");
	at += STAGED_TREE_KEEP_MS - 1;
	pruneStagedTrees({ fs, packagesRoot, manifest: current, now });
	assert.ok(fs.existsSync(join(packagesRoot, "old--1.0.0--aaaaaaaa")), "a later stage does not restart or shorten it");
	// Named again before the delay ran out (an Undo): it leaves the record, and its delay starts afresh if it is retired again.
	const undone = { packages: [{ dir: "old--1.0.0--aaaaaaaa" }] };
	pruneStagedTrees({ fs, packagesRoot, manifest: undone, now });
	at += 1;
	pruneStagedTrees({ fs, packagesRoot, manifest: current, now });
	assert.ok(fs.existsSync(join(packagesRoot, "old--1.0.0--aaaaaaaa")));
	at += STAGED_TREE_KEEP_MS;
	pruneStagedTrees({ fs, packagesRoot, manifest: current, now });
	assert.equal(fs.existsSync(join(packagesRoot, "old--1.0.0--aaaaaaaa")), false, "removed once the delay has passed");
	assert.ok(fs.existsSync(join(packagesRoot, "new--2.0.0--bbbbbbbb")), "the tree the manifest names is never removed");
});

test("what Undo needs is not a stage, however long it has been there", () => {
	const { packagesRoot } = overlay();
	write(join(packagesRoot, UNDO_DIR, "a.json"), "{}");
	let at = 1_000;
	const now = () => at;
	pruneStagedTrees({ fs, packagesRoot, manifest: { packages: [] }, now });
	at += 10 * STAGED_TREE_KEEP_MS;
	pruneStagedTrees({ fs, packagesRoot, manifest: { packages: [] }, now });
	assert.ok(fs.existsSync(join(packagesRoot, UNDO_DIR, "a.json")));
});

test("the week the docs promise is the week the code keeps", () => {
	assert.equal(STAGED_TREE_KEEP_MS, 7 * 24 * 60 * 60 * 1000);
});

test("a held lock is not a retired tree, however long a stage takes", () => {
	const { packagesRoot } = overlay();
	write(join(packagesRoot, ".stage.lock", "holder.json"), "{}");
	let at = 1_000;
	const now = () => at;
	pruneStagedTrees({ fs, packagesRoot, manifest: { packages: [] }, now });
	at += 2 * STAGED_TREE_KEEP_MS;
	pruneStagedTrees({ fs, packagesRoot, manifest: { packages: [] }, now });
	assert.ok(fs.existsSync(join(packagesRoot, ".stage.lock", "holder.json")));
});

test("a peer's staging directory is left alone until it is older than any stage could be", () => {
	const { packagesRoot } = overlay();
	const peer = join(packagesRoot, ".staging-abc");
	write(join(peer, "x"), "y");
	const born = fs.statSync(peer).mtimeMs;
	pruneStagedTrees({ fs, packagesRoot, manifest: { packages: [] }, now: () => born + STAGE_LOCK_STALE_MS - 1 });
	assert.ok(fs.existsSync(peer), "a peer on a shared home is still working");
	pruneStagedTrees({ fs, packagesRoot, manifest: { packages: [] }, now: () => born + STAGE_LOCK_STALE_MS });
	assert.equal(fs.existsSync(peer), false, "a crashed stage does not stay for ever");
});

test("the lock serialises stages, also across hosts, and a crashed holder does not hold it for ever", async () => {
	const { packagesRoot } = overlay();
	let at = 5_000;
	const now = () => at;
	let peerRan = false;
	await withStageLock({ fs, packagesRoot, now, holder: "host-a" }, async () => {
		await assert.rejects(withStageLock({ fs, packagesRoot, now, holder: "host-b" }, async () => { peerRan = true; }), (error) => error.kind === "infra", "a live peer is an outage to retry, never a verdict");
	});
	assert.equal(peerRan, false);
	assert.equal(await withStageLock({ fs, packagesRoot, now }, async () => "free again"), "free again", "released on the way out");
	await assert.rejects(withStageLock({ fs, packagesRoot, now }, async () => { throw new Error("the stage failed"); }), /the stage failed/);
	assert.equal(await withStageLock({ fs, packagesRoot, now }, async () => "released"), "released", "released when the stage throws too");
	// A holder that crashed: the lock stays on disk with its time.
	fs.mkdirSync(join(packagesRoot, ".stage.lock"));
	fs.writeFileSync(join(packagesRoot, ".stage.lock", "holder.json"), JSON.stringify({ at, token: "crashed" }));
	await assert.rejects(withStageLock({ fs, packagesRoot, now }, async () => {}), (error) => error.kind === "infra", "not yet stale");
	at += STAGE_LOCK_STALE_MS;
	assert.equal(await withStageLock({ fs, packagesRoot, now }, async () => "taken"), "taken");
});

test("a fresh lock with no holder file yet is a peer that has just taken it, not a crash", async () => {
	const { packagesRoot } = overlay();
	fs.mkdirSync(join(packagesRoot, ".stage.lock"));
	await assert.rejects(withStageLock({ fs, packagesRoot }, async () => assert.fail("taken from a peer mid-acquire")), (error) => error.kind === "infra");
});

test("a holder that slept past the limit finds out, and does not remove its successor's lock", async () => {
	const { packagesRoot } = overlay();
	let at = 5_000;
	const now = () => at;
	let successorHeld = false;
	const asleep = withStageLock({ fs, packagesRoot, now, renewMs: 1e9 }, async ({ stillHeld }) => {
		assert.equal(stillHeld(), true);
		at += STAGE_LOCK_STALE_MS;
		// A peer judges it crashed and takes over while this one sleeps.
		await withStageLock({ fs, packagesRoot, now, renewMs: 1e9 }, async (peer) => {
			assert.equal(stillHeld(), false, "the first holder can tell, before it commits anything");
			assert.equal(peer.stillHeld(), true);
			successorHeld = true;
		});
		fs.mkdirSync(join(packagesRoot, ".stage.lock"));
		fs.writeFileSync(join(packagesRoot, ".stage.lock", "holder.json"), JSON.stringify({ at, token: "third" }));
	});
	await asleep;
	assert.equal(successorHeld, true);
	assert.equal(JSON.parse(fs.readFileSync(join(packagesRoot, ".stage.lock", "holder.json"), "utf8")).token, "third", "its release left another holder's lock alone");
});

test("a lock a peer took between the read and the rename is put back", async () => {
	const { packagesRoot } = overlay();
	const lock = join(packagesRoot, ".stage.lock");
	let at = 5_000;
	const now = () => at;
	fs.mkdirSync(lock);
	fs.writeFileSync(join(lock, "holder.json"), JSON.stringify({ at: 1, token: "crashed" }));
	at += STAGE_LOCK_STALE_MS;
	// The rename of a lock that changed hands just after it was judged stale.
	const racing = { ...fs, renameSync(from, to) { if (from === lock) fs.writeFileSync(join(lock, "holder.json"), JSON.stringify({ at, token: "fresh-peer" })); return fs.renameSync(from, to); } };
	await assert.rejects(withStageLock({ fs: racing, packagesRoot, now }, async () => assert.fail("two holders")), (error) => error.kind === "infra");
	assert.equal(JSON.parse(fs.readFileSync(join(lock, "holder.json"), "utf8")).token, "fresh-peer", "the peer still holds it");
});

test("a live holder renews its time, so a slow install is not taken for a crash", async () => {
	const { packagesRoot } = overlay();
	let at = 5_000;
	const now = () => at;
	await withStageLock({ fs, packagesRoot, now, renewMs: 5 }, async () => {
		at += STAGE_LOCK_STALE_MS + 1;
		await new Promise((resolve) => setTimeout(resolve, 40));
		await assert.rejects(withStageLock({ fs, packagesRoot, now }, async () => assert.fail("taken from a live holder")), (error) => error.kind === "infra");
	});
});

test("the digest changes with any file and any link target, and not with where the tree is", async () => {
	const one = tempDir("digest-"), two = tempDir("digest-");
	for (const root of [one, two]) {
		write(join(root, "a", "index.js"), "code");
		fs.mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
		fs.symlinkSync("../x/cli.js", join(root, "node_modules", ".bin", "x"));
	}
	assert.equal(await treeDigest(one, { fs }), await treeDigest(two, { fs }));
	write(join(two, "a", "index.js"), "changed");
	assert.notEqual(await treeDigest(one, { fs }), await treeDigest(two, { fs }));
	write(join(two, "a", "index.js"), "code");
	fs.rmSync(join(two, "node_modules", ".bin", "x"));
	fs.symlinkSync("../y/cli.js", join(two, "node_modules", ".bin", "x"));
	assert.notEqual(await treeDigest(one, { fs }), await treeDigest(two, { fs }), "a link is hashed by its target, never followed");
});

test("a tree name is a plain path segment whatever the version holds", () => {
	assert.match(stagedTreeName("acme__tool", "1.2.3-rc.1+build.5", "abcd1234"), /^acme__tool--1\.2\.3-rc\.1_build\.5--abcd1234$/);
	assert.ok(stagedTreeName("a".repeat(64), `1.2.3-${"x".repeat(80)}`, "abcd1234").length <= 144);
});
