import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #489. start.mjs is what receiver.service execs, and it must boot when named directly or through a link,
// and must NOT boot when cli.mjs imports it (the double-boot the old endsWith("start.mjs") test existed to avoid).
const START = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "start.mjs");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

// A triggers file that does not exist is a config refusal the boot reaches before any network or Valkey work.
const refusingEnv = (dir) => ({ PATH: process.env.PATH, HOME: dir, PI_TRIGGERS_FILE: join(dir, "absent.json") });

test("start.mjs run through a link boots (and here refuses on config, exit 2) rather than doing nothing (#489)", () => {
	const dir = tempDir("start-link-");
	const link = join(dir, "receiver-start");
	symlinkSync(START, link);
	const r = spawnSync(process.execPath, [link], { encoding: "utf8", cwd: dir, env: refusingEnv(dir), timeout: 20000 });
	assert.match(r.stderr, /receiver_start_failed/, "the entry ran");
	assert.equal(r.status, 2, r.stderr);
});

// `serve` (the default) lazily imports start.mjs, and start.mjs imports cli.mjs back: a double boot would print the
// refusal twice. --help never reaches start.mjs, so it cannot prove this (PR #490's review); serve and the bare
// link can.
for (const [label, argv] of [["cli.mjs serve", (dir) => [CLI, "serve"]], ["the bin link with no arguments", (dir) => {
	const link = join(dir, "pi-dispatch-receiver");
	symlinkSync(CLI, link);
	return [link];
}]]) {
	test(`${label} boots start.mjs exactly once (#489)`, () => {
		const dir = tempDir("cli-once-");
		const r = spawnSync(process.execPath, argv(dir), { encoding: "utf8", cwd: dir, env: refusingEnv(dir), timeout: 20000 });
		const boots = (r.stderr.match(/receiver_start_failed/g) ?? []).length;
		assert.equal(boots, 1, r.stderr);
		assert.equal(r.status, 2, r.stderr);
	});
}
