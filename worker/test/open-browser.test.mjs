import assert from "node:assert/strict";
import { test } from "node:test";
import { openBrowser } from "../src/open-browser.mjs";

/** A recording child the spawn fake returns; `errorHandlers` proves the swallow listener is attached. */
function fakeChild() {
	const child = { errorHandlers: [], unrefCalled: false };
	child.on = (event, cb) => {
		if (event === "error") child.errorHandlers.push(cb);
		return child;
	};
	child.unref = () => {
		child.unrefCalled = true;
	};
	return child;
}

test("openBrowser spawns the exact per-platform argv, detached and ignored", () => {
	// The argv table is the module (the GitHub App wizard shipped it first; the graph export reuses
	// it), so it is pinned literally per platform -- the up.mjs exact-argv doctrine.
	const cases = [
		["darwin", "open", ["https://x"]],
		["win32", "cmd", ["/c", "start", "", "https://x"]],
		["linux", "xdg-open", ["https://x"]],
	];
	for (const [platform, cmd, args] of cases) {
		const calls = [];
		const child = fakeChild();
		openBrowser("https://x", { platform, spawn: (...a) => (calls.push(a), child) });
		assert.equal(calls.length, 1, platform);
		assert.deepEqual(calls[0], [cmd, args, { stdio: "ignore", detached: true }], platform);
		assert.equal(child.errorHandlers.length, 1, "the async error path must be swallowed, or a missing opener crashes the process later");
		assert.equal(child.unrefCalled, true, "the child must not hold the event loop open");
	}
});

test("openBrowser swallows a synchronous spawn failure -- the printed URL carries the flow", () => {
	assert.doesNotThrow(() =>
		openBrowser("https://x", {
			platform: "linux",
			spawn: () => {
				throw new Error("ENOENT: no xdg-open");
			},
		}),
	);
});

test("openBrowser's swallowed error handler is inert when invoked", () => {
	const child = fakeChild();
	openBrowser("https://x", { platform: "darwin", spawn: () => child });
	assert.doesNotThrow(() => child.errorHandlers[0](new Error("spawn open ENOENT")));
});
