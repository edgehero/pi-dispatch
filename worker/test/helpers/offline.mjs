/**
 * Fail the importing test file when it opens a connection to anything but this machine (issue #1102).
 *
 * WHY A FILE CHECKS ITSELF WHEN CI ALREADY DOES. `contract-tests` runs the suite under
 * `.github/scripts/offline-tests.mjs` and fails when its log has a line or is missing, which covers every file. This is the same
 * refusal, imported, so a file that once leaked fails on a laptop too, with no preload and no log, and says which host
 * it reached and from where. `start-wiring.test.mjs` tried 122 connections to api.github.com in one run before it
 * was fixed (the issue's count, every one refused), and every test in it passed.
 *
 * Importing it is the whole use: the refusal is installed on import (the copy `NODE_OPTIONS` loads in CI is the same
 * module, so nothing is wrapped twice), and the root `after()` hook below fails the file on any refusal so far.
 *
 * THE ROOT HOOK CAN RUN TOO EARLY, so process exit is the backstop (temp-dir.mjs measured it, issue #507): in a file
 * with a top-level await between its tests, `node:test` runs root hooks before the tests declared after the await. A
 * refusal the hook never saw sets the exit code, which `node --test` reports as the file failing (measured on Node
 * 22.19), and its lines go to stderr.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { refusals } from "../../../.github/scripts/offline-tests.mjs";

/** One line per host and caller (the first frame outside a dependency, which is who asked), with how often. */
const described = (list) => {
	const counts = new Map();
	for (const { host, port, stack } of list) {
		const line = `${host}:${port} from ${(stack.find((frame) => !frame.includes("node_modules")) ?? stack[0] ?? "an unnamed caller").replace(/^at /, "")}`;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return [...counts].map(([line, count]) => (count > 1 ? `${line} (${count} times)` : line));
};

let checked = 0;
after(() => {
	checked = refusals.length;
	assert.deepEqual(described(refusals), [], "a test in this file opened a connection to another machine (issue #1102): inject the fake the code under test accepts");
});
process.on("exit", () => {
	if (refusals.length <= checked) return;
	process.stderr.write(`a test in this file opened a connection to another machine after its checks ran (issue #1102):\n${described(refusals.slice(checked)).join("\n")}\n`);
	process.exitCode = 1;
});
