import assert from "node:assert/strict";
import { test } from "node:test";
import { piPinProblems, repositoryPins } from "../../.github/scripts/pi-pin-check.mjs";

// Issue #587: pi 1.0.1 dropped its shrinkwrap and depends on its siblings by a range, so the root overrides pin each
// pi package to the runner's pin, and the lockfile must hold nothing else. The rule on constructed input, then on
// this repository's own files.

function pins(pin = "1.0.3") {
	const entry = { version: pin };
	return {
		root: { overrides: { "@earendil-works/pi-ai": pin, "@earendil-works/pi-coding-agent": pin, "@earendil-works/pi-tui": pin } },
		lock: { packages: { "": {}, "node_modules/@earendil-works/pi-ai": entry, "node_modules/@earendil-works/pi-coding-agent": entry, "node_modules/@earendil-works/pi-tui": entry, "node_modules/undici": { version: "8.10.2" } } },
		runner: { dependencies: { "@earendil-works/pi-coding-agent": pin } },
		worker: { dependencies: { "@earendil-works/pi-ai": pin } },
		admin: { devDependencies: { "@earendil-works/pi-coding-agent": pin } },
		adminIndex: `x\nexport const SUPPORTED_PI_VERSION = "${pin}";\n`,
		dockerfile: `FROM x\nARG PI_VERSION=${pin}\n`,
	};
}

test("one pin everywhere is no problem", () => {
	assert.deepEqual(piPinProblems(pins()), []);
});

test("a sibling the lockfile resolved elsewhere, at any depth, is named", () => {
	const drift = pins();
	drift.lock.packages["node_modules/@earendil-works/pi-tui"] = { version: "1.0.4" };
	drift.lock.packages["admin/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai"] = { version: "1.0.2" };
	assert.deepEqual(piPinProblems(drift), [
		'package-lock.json\'s node_modules/@earendil-works/pi-tui is "1.0.4", not the pin 1.0.3',
		'package-lock.json\'s admin/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai is "1.0.2", not the pin 1.0.3',
	]);
});

test("a pi package the overrides do not pin, or pin elsewhere, is named", () => {
	const missing = pins();
	delete missing.root.overrides["@earendil-works/pi-tui"];
	assert.deepEqual(piPinProblems(missing), ['package.json\'s overrides["@earendil-works/pi-tui"] is undefined, not the pin 1.0.3']);
	const ranged = pins();
	ranged.root.overrides["@earendil-works/pi-ai"] = "^1.0.3";
	assert.deepEqual(piPinProblems(ranged), ['package.json\'s overrides["@earendil-works/pi-ai"] is "^1.0.3", not the pin 1.0.3']);
	const extra = pins();
	extra.root.overrides["@earendil-works/chord"] = "1.0.2";
	assert.deepEqual(piPinProblems(extra), ['package.json\'s overrides["@earendil-works/chord"] is "1.0.2", not the pin 1.0.3'], "an override for a package not installed is still held to the pin");
});

test("each hand-written pin is held to the runner's", () => {
	for (const [label, edit] of [
		["worker/package.json's @earendil-works/pi-ai", (p) => (p.worker.dependencies["@earendil-works/pi-ai"] = "1.0.2")],
		["admin/package.json's devDependency @earendil-works/pi-coding-agent", (p) => (p.admin.devDependencies["@earendil-works/pi-coding-agent"] = "1.0.2")],
		["admin/src/index.ts's SUPPORTED_PI_VERSION", (p) => (p.adminIndex = 'export const SUPPORTED_PI_VERSION = "1.0.2";')],
		["image/Dockerfile's PI_VERSION", (p) => (p.dockerfile = "ARG PI_VERSION=1.0.2")],
	]) {
		const p = pins();
		edit(p);
		assert.deepEqual(piPinProblems(p), [`${label} is "1.0.2", not the pin 1.0.3`], label);
	}
	const ranged = pins();
	ranged.runner.dependencies["@earendil-works/pi-coding-agent"] = "^1.0.3";
	assert.deepEqual(piPinProblems(ranged), ['image/runner/package.json pins pi-coding-agent at "^1.0.3", not an exact version']);
	assert.deepEqual(piPinProblems({ ...pins(), lock: { packages: {} } }), ["package-lock.json holds no pi package at all"]);
});

test("this repository's pins all agree", () => {
	assert.deepEqual(piPinProblems(repositoryPins(new URL("../../", import.meta.url))), []);
});
