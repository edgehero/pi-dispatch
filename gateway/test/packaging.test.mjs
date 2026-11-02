import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGatewayAssets } from "../build.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npm = process.env.npm_execpath ?? resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
const run = (args, options = {}) => {
	const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, ...options });
	assert.equal(result.status, 0, result.stderr || String(result.error));
	return result;
};

/** Copy the installed production graph, without workspace links, a registry, or a build tool in the result. */
function copyRuntime(name, from, nodeModules, ancestors = new Set()) {
	const require = createRequire(join(from, "package.json"));
	let source;
	try { source = dirname(require.resolve(`${name}/package.json`)); }
	catch { source = dirname(require.resolve(name)); }
	while (!existsSync(join(source, "package.json")) || JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name !== name) {
		const parent = dirname(source);
		assert.notEqual(parent, source, `the installed runtime package ${name} must have its own manifest`);
		source = parent;
	}
	const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	const identity = `${name}@${pkg.version}`;
	if (ancestors.has(identity)) return;
	assert.ok(!name.startsWith("@edgehero/") && !name.startsWith("@xterm/") && name !== "esbuild", "runtime cannot depend on the checkout or frontend build tools");
	const target = join(nodeModules, name);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true, filter: (path) => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes("node_modules") });
	const next = new Set([...ancestors, identity]);
	for (const child of Object.keys(pkg.dependencies ?? {})) copyRuntime(child, source, join(target, "node_modules"), next);
}

test("the actual npm tarball runs standalone with only production dependencies and loads its packaged assets", { timeout: 120_000 }, async () => {
	const work = tempDir("gateway-pack-"), staged = join(work, "staged"), unpacked = join(work, "unpacked");
	mkdirSync(staged); mkdirSync(unpacked);
	writeFileSync(join(staged, "package.json"), JSON.stringify(manifest));
	cpSync(new URL("../README.md", import.meta.url), join(staged, "README.md"));
	await buildGatewayAssets({ write: true, outdir: join(staged, "dist", "static") });
	const packed = JSON.parse(run([npm, "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", work], { cwd: staged }).stdout)[0];
	assert.equal(packed.name, manifest.name);
	assert.deepEqual(packed.files.map((f) => f.path).sort(), ["README.md", "dist/cli.mjs", "dist/static/gateway.css", "dist/static/gateway.js", "dist/static/terminal.js", "package.json"]);
	const tar = spawnSync("tar", ["-xzf", join(work, packed.filename), "-C", unpacked], { encoding: "utf8", timeout: 10_000 });
	assert.equal(tar.status, 0, tar.stderr);
	const installed = join(unpacked, "package"), nodeModules = join(installed, "node_modules");
	for (const dependency of Object.keys(manifest.dependencies)) copyRuntime(dependency, join(root, "gateway"), nodeModules);
	const help = run([join(installed, "dist", "cli.mjs"), "--help"], { cwd: unpacked });
	assert.match(help.stdout, /pi-dispatch-sandbox-gateway --config/);
	assert.equal(help.stderr, "");
	for (const forbidden of ["@edgehero", "@xterm", "esbuild", "src", "test"]) assert.equal(existsSync(join(nodeModules, forbidden)), false);
	// Exercise the built CLI's real asset URLs before the injected control connection refuses. A help-only
	// smoke would miss a bundle that still reads src/static or the original checkout's design directory.
	const { startGateway } = await import(pathToFileURL(join(installed, "dist", "cli.mjs")).href);
	let connected = false;
	await assert.rejects(startGateway({ env: {}, sockets: { local: "/unused.sock" }, logsDir: join(work, "logs"), deployment: work }, {
		makeClient: () => ({ on() {}, async connect() { connected = true; throw new Error("injected-control-refusal"); }, disconnect() {} }),
		journal: {},
	}), /injected-control-refusal/);
	assert.equal(connected, true, "all three packaged assets were loaded before the intended refusal");
	assert.deepEqual(readdirSync(installed).sort(), ["README.md", "dist", "node_modules", "package.json"]);
});

test("gateway release gating handles existing versions, a real registry 404 and infrastructure failures without publishing", () => {
	const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
	assert.match(workflow, /release:\n(?:[^\n]*\n)*?    if: github\.ref == 'refs\/heads\/main'/);
	assert.doesNotMatch(workflow, /pull_request(?:_target)?:/);
	const group = workflow.split('      - name: "gateway: resolve version + decide publish/release"')[1]?.split('      - name: "gateway: publish to npm"')[0];
	const code = group?.split("        run: |\n")[1]?.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
	assert.ok(code);
	const work = tempDir("gateway-release-"), bin = join(work, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "npm"), '#!/bin/sh\ncase "$GATEWAY_REGISTRY_CASE" in\nexists) printf "4.3.1\\n"; exit 0;;\nmissing) printf "npm error code E404\\n" >&2; exit 1;;\n*) printf "npm error code ENETUNREACH\\n" >&2; exit 1;;\nesac\n', { mode: 0o755 });
	writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	for (const [scenario, expected] of [["exists", "publish=no"], ["missing", "publish=yes"], ["outage", null]]) {
		const output = join(work, `${scenario}.out`); writeFileSync(output, "");
		const result = spawnSync("bash", ["-e", "-c", code], { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, GITHUB_OUTPUT: output, GATEWAY_REGISTRY_CASE: scenario } });
		assert.equal(result.status, expected ? 0 : 1, result.stderr);
		const receipt = readFileSync(output, "utf8");
		if (expected) assert.ok(receipt.includes(expected), scenario);
		else assert.doesNotMatch(receipt, /publish=yes|release=yes/, "a registry outage is not evidence that publishing is needed");
	}
});

test("both required live-runtime lanes verify the pinned browser before extraction and stop on failed verification", () => {
	const steps = [
		["pi-upgrade-check.yml", "Verify and install pinned Chrome for the separate sandbox gateway (#754)"],
		["podman-conformance.yml", "Verify and install pinned Chrome for the worker account's sandbox gateway (#754)"],
	];
	for (const [file, title] of steps) {
		const workflow = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
		assert.match(workflow, /node \.github\/scripts\/sandbox-gateway-browser\.mjs --tls(?:\n|$)/, `${file}: the required browser run exercises genuine HTTPS`);
		assert.ok(workflow.includes('      - ".github/scripts/sandbox-gateway-tls-fixture.mjs"'), `${file}: TLS fixture changes also trigger its main-push run`);
		const section = workflow.split(`      - name: "${title}"\n`)[1]?.split("\n      - ")[0];
		const code = section?.split("        run: |\n")[1]?.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
		assert.ok(code, file);
		const work = tempDir("gateway-chrome-gate-"), bin = join(work, "bin"); mkdirSync(bin);
		const scripts = {
			node: '#!/bin/sh\ncase "$*" in\n*--check-pin*) echo pin >> "$GATEWAY_TRACE"; printf "https://storage.googleapis.com/chrome-for-testing-public/pinned/linux64/chrome-linux64.zip\\n";;\n*--verify-zip*) echo verify >> "$GATEWAY_TRACE"; test "$GATEWAY_VERIFY" = good;;\n*) exit 90;;\nesac\n',
			curl: '#!/bin/sh\nprintf "curl %s\\n" "$*" >> "$GATEWAY_TRACE"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf zip > "$1"; fi; shift; done\n',
			unzip: '#!/bin/sh\necho unzip >> "$GATEWAY_TRACE"\n',
			mktemp: '#!/bin/sh\nmkdir -p "$RUNNER_TEMP/browser"\nprintf "%s/browser\\n" "$RUNNER_TEMP"\n',
		};
		for (const [name, source] of Object.entries(scripts)) writeFileSync(join(bin, name), source, { mode: 0o755 });
		for (const verification of ["good", "bad"]) {
			const trace = join(work, `${verification}.trace`), output = join(work, `${verification}.env`);
			writeFileSync(trace, ""); writeFileSync(output, "");
			const result = spawnSync("bash", ["-e", "-c", code], { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: work, GITHUB_ENV: output, GATEWAY_TRACE: trace, GATEWAY_VERIFY: verification } });
			assert.equal(result.status, verification === "good" ? 0 : 1, result.stderr);
			const events = readFileSync(trace, "utf8").trim().split("\n");
			assert.equal(events[0], "pin");
			assert.match(events[1], /curl .*--proto =https --proto-redir =https.*https:\/\/storage\.googleapis\.com\//);
			assert.deepEqual(events.slice(2), verification === "good" ? ["verify", "unzip"] : ["verify"], `${file}: unverifiable bytes must never be extracted`);
		}
	}
});
