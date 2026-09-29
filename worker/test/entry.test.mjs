import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryModule } from "../src/entry.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #489: npm installs every bin as a SYMLINK, so argv[1] is the link and import.meta.url the file.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_CLI = join(HERE, "..", "src", "cli.mjs");
const RECEIVER_CLI = join(HERE, "..", "..", "receiver", "src", "cli.mjs");

test("isEntryModule: argv[1] naming this file, directly or through a link, is the entry; anything else is not (#489)", () => {
	const dir = tempDir("entry-");
	const file = join(dir, "cli.mjs");
	writeFileSync(file, "");
	const link = join(dir, "pi-dispatch");
	symlinkSync(file, link);
	const other = join(dir, "other.mjs");
	writeFileSync(other, "");
	const url = pathToFileURL(file).href;
	assert.equal(isEntryModule(url, { argv1: file }), true, "the file itself");
	assert.equal(isEntryModule(url, { argv1: link }), true, "npm's bin link: the case the old guard missed");
	assert.equal(isEntryModule(url, { argv1: other }), false, "another file, even one in the same folder");
	assert.equal(isEntryModule(url, { argv1: join(dir, "missing.mjs") }), false, "a path that does not exist");
	assert.equal(isEntryModule(url, { argv1: undefined }), false, "node -e and the REPL have no argv[1]");
	assert.equal(isEntryModule(url, { argv1: "" }), false);
});

// Each bin run through a link the way `npx`, a local `.bin` and a global install run it. Before #489 every
// one of these exited 0 having printed nothing.
for (const [bin, target, usage] of [
	["pi-dispatch", WORKER_CLI, /^pi-dispatch .* run pi coding-agent flows/],
	["pi-dispatch-receiver", RECEIVER_CLI, /^pi-dispatch-receiver .* the always-on trigger edge/],
]) {
	test(`${bin} --help through npm's bin link prints its usage (#489)`, () => {
		const dir = tempDir("bin-");
		const link = join(dir, bin);
		symlinkSync(target, link);
		const r = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8", cwd: dir });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, usage);
	});
}

test("pi-dispatch init through npm's bin link writes its files (#489)", () => {
	const dir = tempDir("bin-init-");
	const link = join(dir, "pi-dispatch");
	symlinkSync(WORKER_CLI, link);
	const work = tempDir("bin-init-work-");
	const r = spawnSync(process.execPath, [link, "init"], { encoding: "utf8", cwd: work });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /created .env/);
});

test("pi-dispatch --help and -h exit 0, a typo exits 1, as the receiver's CLI already does (#489)", () => {
	for (const [arg, code] of [["--help", 0], ["-h", 0], ["no-such-command", 1]]) {
		const r = spawnSync(process.execPath, [WORKER_CLI, arg], { encoding: "utf8" });
		assert.equal(r.status, code, `${arg}: ${r.stderr}`);
		assert.match(r.stdout, /^pi-dispatch .* run pi coding-agent flows/);
	}
});
