import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { verifySecretFiles } from "../src/secret-files.mjs";
import { secretFileNameAllowed } from "../../../worker/src/secret-file-names.mjs";

function fixture() {
	const directory = join(tempDir("secret-files-"), "secrets");
	mkdirSync(directory, { mode: 0o700 });
	const value = "-----BEGIN PRIVATE KEY-----\r\nexact-key-body-123456\r\n-----END PRIVATE KEY-----\r\n";
	const file = join(directory, "DEVICE_SSH_KEY");
	writeFileSync(file, value, { mode: 0o600 });
	const env = { PI_SECRET_FILES: "DEVICE_SSH_KEY", DEVICE_SSH_KEY: file };
	return { directory, file, value, env };
}

test("file grant verifies exact readable bytes and owner-only modes, leaving the path for tools", () => {
	const f = fixture();
	assert.equal(verifySecretFiles(f), 1);
	assert.equal(f.env.PI_SECRET_FILES, undefined);
	assert.equal(f.env.DEVICE_SSH_KEY, f.file);
	assert.equal(readFileSync(f.file, "utf8"), f.value);
	assert.equal(verifySecretFiles({ env: {}, directory: "/does-not-exist" }), 0);
});

test("a bad mount is refused before loading tools, without printing contents or caller paths", () => {
	for (const alter of [
		(f) => chmodSync(f.file, 0o644),
		(f) => chmodSync(f.directory, 0o755),
		(f) => { f.uid = process.geteuid() + 1; },
		(f) => { f.env.DEVICE_SSH_KEY = "/workspace/caller-selected"; },
		(f) => { f.env.PI_SECRET_FILES = "../outside"; },
		(f) => { f.env.PI_SECRET_FILES = "DEVICE_SSH_KEY,device_ssh_key"; },
		(f) => { f.env.PI_SECRET_FILES = ""; },
		(f) => writeFileSync(f.file, ""),
		(f) => writeFileSync(f.file, "x".repeat(65537)),
	]) {
		const f = fixture(); alter(f);
		assert.throws(() => verifySecretFiles(f), (e) => e.exitWhy === "secret-files-unusable" || /secret files are missing/.test(e.message));
	}
});

test("a symlink cannot turn a file grant into a read elsewhere", () => {
	const f = fixture();
	symlinkSync(f.file, join(f.directory, "LINK"));
	assert.throws(() => verifySecretFiles({ ...f, env: { PI_SECRET_FILES: "LINK", LINK: join(f.directory, "LINK") } }), /secret files are missing/);
});

test("the runner holds the worker's portable file-name boundary, including Windows device names", () => {
	const names = ["DEVICE_KEY", "PI_DEVICE_KEY", "_key", "A".repeat(128), "COM0", "COM10", "CON_KEY", "toString", "", "1KEY", "../key", "CON", "con", "PRN", "AUX", "nul", "COM1", "COM9", "LPT1", "lpt9", "A".repeat(129), "__proto__"];
	const directory = "/mounted-secrets";
	const fs = {
		constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
		lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: 10 }),
		openSync: () => 42,
		fstatSync: () => ({ isFile: () => true, mode: 0o600, uid: 10, nlink: 1, size: 8 }),
		closeSync: () => {},
	};
	for (const name of names) {
		const verify = () => verifySecretFiles({ directory, uid: 10, fs, env: { PI_SECRET_FILES: name, [name]: `${directory}/${name}` } });
		if (secretFileNameAllowed(name)) assert.equal(verify(), 1, name);
		else assert.throws(verify, /secret files are missing/, name);
	}
});
