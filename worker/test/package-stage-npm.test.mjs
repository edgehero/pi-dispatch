/**
 * The real npm against a registry on loopback, because what these prove is what npm itself does: `--ignore-scripts` does not stop a git dependency's `prepare`, and resolving first does.
 * Nothing leaves the machine. Each fixture has a positive control, so that a marker that stays absent means the install was refused and not that the fixture never fires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "./helpers/temp-dir.mjs";
import { preparePackage, serviceNpmEnv, stagePackageTree } from "../src/package-stage.mjs";

const exec = promisify(execFile);
const LONG = { timeout: 120_000 };

/** A registry serving `packages`, each `{ name, version, manifest, files }`, as npm expects: metadata with a hash, and a tarball. */
async function registry(packages) {
	const dir = tempDir("npm-registry-");
	const built = new Map();
	for (const p of packages) {
		const root = join(dir, `${p.name}-${p.version}`, "package");
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(join(root, "package.json"), JSON.stringify({ name: p.name, version: p.version, ...p.manifest }));
		for (const [file, text] of Object.entries(p.files ?? { "index.js": "export default () => {};\n" })) fs.writeFileSync(join(root, file), text);
		const tgz = join(dir, `${p.name}-${p.version}.tgz`);
		execFileSync("tar", ["czf", tgz, "-C", join(dir, `${p.name}-${p.version}`), "package"]);
		built.set(p.name, { ...p, bytes: fs.readFileSync(tgz) });
	}
	const server = http.createServer((req, res) => {
		const parts = new URL(req.url, "http://x").pathname.split("/").filter(Boolean);
		const p = built.get(decodeURIComponent(parts[0]));
		if (!p) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}'); return; }
		if (parts[1] === "-") { res.writeHead(200); res.end(p.bytes); return; }
		const dist = { tarball: `http://127.0.0.1:${server.address().port}/${p.name}/-/${p.name}-${p.version}.tgz`, shasum: createHash("sha1").update(p.bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(p.bytes).digest("base64")}` };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ name: p.name, "dist-tags": { latest: p.version }, versions: { [p.version]: { name: p.name, version: p.version, ...p.manifest, dist } } }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const home = tempDir("npm-home-");
	const env = serviceNpmEnv({ PATH: process.env.PATH, HOME: home, PI_UPDATES_REGISTRY: url, GITHUB_TOKEN: "ghp_notreal" });
	return { url, env, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const stage = (env, name, packagesRoot = tempDir("npm-stage-")) => stagePackageTree({ fs, exec, entry: { name, version: "1.0.0", dir: name }, packagesRoot, npmBin: "npm", platform: process.platform, timeoutMs: 60_000, env }).then((got) => ({ ...got, packagesRoot }));

/** A local git repository whose `prepare` writes `marker`: what npm builds when a package names it as a dependency. */
function gitDependency(marker) {
	const repo = tempDir("npm-git-dep-");
	fs.writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "built-from-git", version: "1.0.0", scripts: { prepare: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` } }));
	for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x"]]) execFileSync("git", args, { cwd: repo });
	return `git+file://${repo}`;
}

test("a git dependency's prepare runs under --ignore-scripts when npm is simply asked, and never when a service stages it", LONG, async () => {
	const marker = join(tempDir("npm-marker-"), "PREPARE-RAN");
	const r = await registry([{ name: "uses-git", version: "1.0.0", manifest: { pi: { extensions: ["index.js"] }, dependencies: { "built-from-git": gitDependency(marker) } } }]);
	try {
		await assert.rejects(stage(r.env, "uses-git"), (error) => error.kind === "policy" && /built-from-git does not come from a configured registry/.test(error.message));
		assert.equal(fs.existsSync(marker), false, "no code of that dependency ran on this host");
		// The control: this is why the rule exists. The plain install ran it, whatever the flag says.
		const staging = join(tempDir("npm-control-"), "staging");
		await preparePackage({ fs, exec, entry: { name: "uses-git", version: "1.0.0", dir: "uses-git" }, staging, npmBin: "npm", platform: process.platform, env: { ...r.env } }).catch(() => {});
		assert.equal(fs.existsSync(marker), true, "the fixture does fire when nothing refuses it");
	} finally {
		await r.close();
	}
});

test("a dependency that is a path on this host, or a tarball somewhere else, is refused before anything is installed", LONG, async () => {
	const other = await registry([{ name: "elsewhere", version: "1.0.0", manifest: {} }]);
	const hostPath = tempDir("npm-host-path-");
	fs.writeFileSync(join(hostPath, "package.json"), JSON.stringify({ name: "from-host", version: "1.0.0" }));
	const r = await registry([
		{ name: "uses-path", version: "1.0.0", manifest: { pi: { extensions: ["index.js"] }, dependencies: { "from-host": `file:${hostPath}` } } },
		{ name: "uses-url", version: "1.0.0", manifest: { pi: { extensions: ["index.js"] }, dependencies: { elsewhere: `${other.url}elsewhere/-/elsewhere-1.0.0.tgz` } } },
	]);
	try {
		const root = tempDir("npm-stage-");
		await assert.rejects(stage(r.env, "uses-path", root), (error) => error.kind === "policy");
		await assert.rejects(stage(r.env, "uses-url", root), (error) => error.kind === "policy" && /elsewhere does not come from a configured registry/.test(error.message));
		assert.deepEqual(fs.readdirSync(root), [], "nothing was left behind");
	} finally {
		await r.close();
		await other.close();
	}
});

test("a package from the registry installs, whole and self-contained, and its own lifecycle scripts do not run", LONG, async () => {
	const marker = join(tempDir("npm-marker-"), "POSTINSTALL-RAN");
	const script = `node -e "require('fs').writeFileSync('${marker}', 'ran')"`;
	const r = await registry([
		{ name: "dep-a", version: "1.2.3", manifest: { scripts: { postinstall: script } } },
		{ name: "good", version: "1.0.0", manifest: { pi: { extensions: ["index.js"] }, dependencies: { "dep-a": "1.2.3" }, scripts: { postinstall: script } } },
	]);
	try {
		const { dir, packagesRoot } = await stage(r.env, "good");
		const tree = join(packagesRoot, dir);
		assert.equal(JSON.parse(fs.readFileSync(join(tree, "package.json"), "utf8")).version, "1.0.0");
		assert.ok(fs.existsSync(join(tree, "node_modules", "dep-a", "package.json")), "its dependency is inside it");
		assert.equal(fs.existsSync(marker), false, "--ignore-scripts holds for a registry tarball");
		assert.deepEqual(fs.readdirSync(packagesRoot), [dir], "and its staging directory is gone");
		// The control: the same package, without the flag, does run them.
		const cwd = tempDir("npm-control-");
		fs.writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "control", private: true }));
		await exec("npm", ["install", "good@1.0.0", "--no-audit", "--no-fund", "--loglevel=error"], { cwd, env: r.env });
		assert.equal(fs.existsSync(marker), true, "the fixture does fire when nothing stops it");
	} finally {
		await r.close();
	}
});

test("a version that does not exist is named as absent, not as an outage", LONG, async () => {
	const r = await registry([{ name: "real", version: "2.0.0", manifest: { pi: {} } }]);
	try {
		await assert.rejects(stage(r.env, "real"), (error) => error.kind === "not-found");
		await assert.rejects(stage(r.env, "never-published"), (error) => error.kind === "not-found");
	} finally {
		await r.close();
	}
});
