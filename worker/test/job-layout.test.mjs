import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LAYOUTS as RUNNER_LAYOUTS, DEFAULT_LAYOUT as RUNNER_DEFAULT } from "../../image/runner/src/layout.mjs";
import { CONTAINER_GLOBAL_PI_DIR, CONTAINER_INBOX_DIR, CONTAINER_SESSION_DIR, containerSpec } from "../src/container-spec.mjs";
import { DEFAULT_LAYOUT, LAYOUTS, layoutFor } from "../src/job-layout.mjs";

/**
 * Issue #683: the worker's copy of the container's file layouts is the runner's, byte for byte, and its `mounts` row is
 * exactly the mount targets the argv builder has always emitted. The two tables live on different hosts at run time,
 * so the copy is forced; this is the bolt that keeps it a copy.
 */

test("the worker's layout table is the runner's, row for row and path for path", () => {
	assert.deepEqual(LAYOUTS, RUNNER_LAYOUTS);
	assert.equal(DEFAULT_LAYOUT, RUNNER_DEFAULT);
});

test("the mounts row is the container paths containerSpec mounts, so a binding venue's argv did not move", () => {
	const spec = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/w", outboxDir: "/o", sessionDir: "/s", steerInboxDir: "/in", globalPiDir: "/g" });
	const targets = new Set(spec.mounts.map((m) => m.container));
	const mounts = layoutFor("mounts");
	for (const key of ["job", "workspace", "outbox", "session", "inbox", "global"]) assert.ok(targets.has(mounts[key]), `${key}: ${mounts[key]} is a mount target`);
	assert.equal(mounts.session, CONTAINER_SESSION_DIR);
	assert.equal(mounts.inbox, CONTAINER_INBOX_DIR);
	assert.equal(mounts.global, CONTAINER_GLOBAL_PI_DIR);
});

test("layoutFor refuses a name the table does not hold, rather than guess a tree", () => {
	assert.equal(layoutFor(), LAYOUTS.mounts);
	assert.equal(layoutFor("sandbox"), LAYOUTS.sandbox);
	for (const bad of ["", "Sandbox", "toString", "__proto__", null, 1]) assert.throws(() => layoutFor(bad), /unknown job layout/, String(bad));
});

test("INT-CONTAINER-JOB-INPUTS' layout table is the table, row for row", () => {
	// The spec restates LAYOUTS by hand, so it is pinned here (CLAUDE.md: a hand-written table is derived or pinned).
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const at = spec.indexOf("  | | `mounts` | `sandbox` |");
	assert.ok(at > 0, "the layout table is in INT-CONTAINER-JOB-INPUTS");
	const after = spec.slice(at).split("\n").slice(2);
	const end = after.findIndex((l) => !l.startsWith("  | "));
	const rows = after.slice(0, end).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
	const cell = (path) => `\`${path}\``;
	const want = [
		["job inputs", "job"],
		["workspace", "workspace"],
		["session", "session"],
		["outbox (local jobs)", "outbox"],
		["steer inbox", "inbox"],
		["operator overlay", "global"],
	];
	assert.equal(rows.length, want.length, "one row per layout key");
	for (const [i, [label, key]] of want.entries()) {
		assert.equal(rows[i][0], label);
		assert.equal(rows[i][1], cell(LAYOUTS.mounts[key]), `${key}: mounts`);
		if (LAYOUTS.sandbox[key] === null) assert.match(rows[i][2], /^none/, `${key}: sandbox`);
		else assert.equal(rows[i][2], cell(LAYOUTS.sandbox[key]), `${key}: sandbox`);
	}
	assert.deepEqual(Object.keys(LAYOUTS.mounts).sort(), want.map(([, key]) => key).sort(), "every key has a row");
});
