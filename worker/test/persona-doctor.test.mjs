import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { overlayPersonaCheck } from "../src/doctor.mjs";

test("doctor distinguishes an absent, empty, unreadable and loaded persona without printing its text", () => {
	const lstat = () => ({ isFile: () => true });
	const readFile = () => "private standing instructions";
	const loaded = overlayPersonaCheck("/overlay", { lstat, readFile });
	assert.equal(loaded.ok, true);
	assert.ok(loaded.label.includes(createHash("sha256").update(readFile()).digest("hex")));
	assert.ok(!JSON.stringify(loaded).includes(readFile()));
	const missing = overlayPersonaCheck("/overlay", { lstat, readFile() { throw Object.assign(new Error(), { code: "ENOENT" }); } });
	assert.equal(missing.ok, true);
	assert.match(missing.label, /no APPEND_SYSTEM/);
	assert.equal(overlayPersonaCheck("/overlay", { lstat, readFile: () => "\n " }).warn, true);
	const denied = overlayPersonaCheck("/overlay", { lstat, readFile() { throw Object.assign(new Error("private value"), { code: "EACCES" }); } });
	assert.equal(denied.ok, false);
	assert.ok(!JSON.stringify(denied).includes("private value"));
});
test("doctor never opens a persona link or special file", () => {
	let opened = false;
	const result = overlayPersonaCheck("/overlay", { lstat: () => ({ isFile: () => false }), readFile: () => { opened = true; } });
	assert.equal(result.ok, false);
	assert.equal(opened, false);
});
