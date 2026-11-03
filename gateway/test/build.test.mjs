import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { buildGatewayAssets } from "../build.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

test("the published gateway owns its exact-pinned terminal assets, and the fragment bootstrap stays tiny/import-free", async () => {
	const outdir = join(tempDir("pd-gateway-assets-"), "static");
	const assets = await buildGatewayAssets({ write: true, outdir });
	assert.deepEqual(Object.keys(assets), ["script", "terminalScript", "css"]);
	assert.ok(assets.script.length < 16000, "the handoff entry does not bundle the terminal renderer");
	assert.ok(assets.terminalScript.length > 100000, "the admitted terminal module includes the actual renderer");
	assert.doesNotMatch(assets.script, /class Terminal|FitAddon|node:|import\s+.*from/);
	assert.match(assets.script, /import\("\/static\/terminal\.js"\)/);
	assert.match(assets.css, /\.xterm/);
	assert.doesNotMatch(assets.css, /@import|@font-face|url\(\s*["']?https?:/);
	for (const [filename, key] of [["gateway.js", "script"], ["terminal.js", "terminalScript"], ["gateway.css", "css"]]) assert.equal(readFileSync(join(outdir, filename), "utf8"), assets[key]);
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.devDependencies["@xterm/xterm"], "6.0.0"); assert.equal(pkg.devDependencies["@xterm/addon-fit"], "0.11.0");
	assert.equal(pkg.bin["pi-dispatch-sandbox-gateway"], "dist/cli.mjs");
	const require = createRequire(new URL("../package.json", import.meta.url));
	const modules = join(outdir, "../node_modules"); mkdirSync(modules);
	for (const name of Object.keys(pkg.dependencies)) symlinkSync(dirname(require.resolve(`${name}/package.json`)), join(modules, name), process.platform === "win32" ? "junction" : "dir");
	const cli = join(outdir, "../cli.mjs");
	const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 10000 });
	assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /pi-dispatch-sandbox-gateway --config/);
	if (process.platform !== "win32") {
		const installed = join(outdir, "../pi-dispatch-sandbox-gateway"); symlinkSync(cli, installed);
		const linked = spawnSync(process.execPath, [installed, "--help"], { encoding: "utf8", timeout: 10000 });
		assert.equal(linked.status, 0, linked.stderr); assert.equal(linked.stdout, help.stdout, "an npm-style bin symlink executes the real bundled entrypoint");
	}
	assert.doesNotMatch(readFileSync(cli, "utf8"), /from ["']@edgehero\/pi-dispatch(?:\/|["'])/, "worker internals are inlined into the separately published package");
	const consoleScript = readFileSync(new URL("../../admin/src/console/gateway-console-script.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(consoleScript, /@xterm|FitAddon|WebSocket|dockerode/);
});
