import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { acquireSetupLock } from "../src/setup-lock.mjs";

test("the shared deployment lock excludes a second caller and releases only its own entry", () => {
	const dir = tempDir("setup-lock-");
	const first = acquireSetupLock(dir);
	assert.equal(first.refusal, undefined);
	assert.equal(acquireSetupLock(dir).refusal, "setup-busy");
	const path = join(dir, ".pi-dispatch-setup.lock");
	assert.equal(fs.statSync(path).mode & 0o077, 0);
	fs.unlinkSync(path);
	const next = acquireSetupLock(dir);
	first.release();
	assert.equal(acquireSetupLock(dir).refusal, "setup-busy", "an older release cannot delete its replacement");
	next.release();
	assert.equal(fs.existsSync(path), false);
});

test("existing and crash-stale locks fail closed without racing an unlink against another caller", () => {
	const dir = tempDir("setup-lock-stale-");
	const path = join(dir, ".pi-dispatch-setup.lock");
	for (const text of [`2147483647:${"a".repeat(32)}`, "invalid lock"]) {
		fs.writeFileSync(path, text, { mode: 0o600 });
		assert.equal(acquireSetupLock(dir).refusal, "setup-busy");
		assert.equal(fs.readFileSync(path, "utf8"), text);
	}
});

test("unsafe deployment roots and nonsticky writable ancestors cannot acquire setup authority", () => {
	const parent = tempDir("setup-lock-parent-");
	const dir = join(parent, "deployment");
	fs.mkdirSync(dir);
	fs.chmodSync(parent, 0o777);
	assert.equal(acquireSetupLock(dir).refusal, "unsafe-deployment");
	fs.chmodSync(parent, 0o700);
	fs.chmodSync(dir, 0o777);
	assert.equal(acquireSetupLock(dir).refusal, "unsafe-deployment");
	assert.equal(fs.existsSync(join(dir, ".pi-dispatch-setup.lock")), false);
});
