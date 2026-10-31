import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PINNED_PI_NEEDLES } from "../src/host-pi.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

function fixture() {
	const root = tempDir("host-pi-source-canary-");
	const source = join(root, "checkout"), scratch = join(root, "scratch");
	const script = join(source, ".github/scripts/host-pi-canary.mjs");
	mkdirSync(dirname(script), { recursive: true });
	cpSync(new URL("../src", import.meta.url), join(source, "worker/src"), { recursive: true });
	cpSync(new URL("../../.github/scripts/host-pi-canary.mjs", import.meta.url), script);
	assert.equal(existsSync(join(source, "node_modules")), false);
	assert.equal(existsSync(join(source, "worker/node_modules")), false);
	// TMPDIR can itself be below the checkout in CI. Deny package resolution so no ancestor install can mask drift.
	const guard = join(root, "source-only.mjs");
	writeFileSync(guard, 'import { isBuiltin, registerHooks } from "node:module";\nregisterHooks({ resolve(specifier, context, nextResolve) { if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:")) throw new Error(`source-only canary imported dependency: ${specifier}`); return nextResolve(specifier, context); } });\n');
	const piRoot = join(scratch, "node_modules/@earendil-works/pi-coding-agent");
	const installed = new URL("../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
	for (const file of ["package.json", ...Object.keys(PINNED_PI_NEEDLES)]) {
		const destination = join(piRoot, file);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(new URL(file, installed), destination);
	}
	const run = () => spawnSync(process.execPath, ["--import", guard, script, scratch], { cwd: source, encoding: "utf8", env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, timeout: 10_000 });
	return { run, piRoot, version: JSON.parse(readFileSync(fileURLToPath(new URL("package.json", installed)), "utf8")).version };
}

test("host-pi scratch canary reads actual pinned pi without any checkout dependency installation", () => {
	const { run, version } = fixture();
	const result = run();
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`host-pi canary: pi ${version.replaceAll(".", "\\.")} still matches every internal`));
	assert.equal(result.stdout.includes("::warning::"), false);
	assert.equal(result.stderr, "");
});

test("source-only scratch canary still reports real upstream source drift instead of a successful match", () => {
	const { run, piRoot } = fixture();
	const [file, needles] = Object.entries(PINNED_PI_NEEDLES)[0];
	const path = join(piRoot, file);
	const original = readFileSync(path, "utf8");
	assert.equal(original.includes(needles[0]), true);
	writeFileSync(path, original.replaceAll(needles[0], "REMOVED-UPSTREAM-INTERNAL"));
	const result = run();
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /::warning::pi .* moved 1 internal/);
	assert.equal(result.stdout.includes(`missing -- ${file}: ${JSON.stringify(needles[0])}`), true);
	assert.equal(result.stdout.includes("still matches every internal"), false);
	assert.equal(result.stderr, "");
});

test("source-only scratch canary fails loudly when pi was not installed", () => {
	const { run, piRoot } = fixture();
	rmSync(piRoot, { recursive: true });
	const result = run();
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /::error::no pi installed.*infrastructure failure/);
	assert.equal(result.stdout, "");
});
