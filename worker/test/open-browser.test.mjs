import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalBrowserSession, openBrowser, openerArgv } from "../src/open-browser.mjs";

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
		["win32", "rundll32", ["url.dll,FileProtocolHandler", "https://x"]],
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

test("win32: a URL holding & and # reaches the opener as ONE argument, and no shell parses it (issue #708)", () => {
	// `cmd /c start "" <url>` cut the URL at its first `&` and ran the rest as a command; rundll32 is not a shell.
	const url = "http://127.0.0.1:4790/login/code#abc_DEF-123&next=/insights?range=30d&whatif=a/b";
	const [cmd, args] = openerArgv(url, "win32");
	assert.equal(cmd, "rundll32");
	assert.deepEqual(args, ["url.dll,FileProtocolHandler", url]);
	assert.ok(!args.includes("/c") && cmd !== "cmd", "never cmd, which re-parses & as a command separator");
	const calls = [];
	openBrowser(url, { platform: "win32", spawn: (...a) => (calls.push(a), fakeChild()) });
	assert.equal(calls[0][1].at(-1), url, "the whole URL, fragment included, is the last argument");
});

test("isLocalBrowserSession: no SSH variable, and a desktop opener or a display", () => {
	const cases = [
		[{}, "darwin", true],
		[{}, "win32", true],
		[{}, "linux", false],
		[{ DISPLAY: ":0" }, "linux", true],
		[{ WAYLAND_DISPLAY: "wayland-0" }, "linux", true],
		[{ DISPLAY: "" }, "linux", false],
		[{ DISPLAY: ":0" }, "freebsd", true],
		[{ SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" }, "darwin", false],
		[{ SSH_CLIENT: "10.0.0.2 5000 22" }, "win32", false],
		[{ SSH_TTY: "/dev/pts/1", DISPLAY: ":0" }, "linux", false],
		[{ SSH_CONNECTION: "", DISPLAY: ":0" }, "linux", true],
	];
	for (const [env, platform, want] of cases) assert.equal(isLocalBrowserSession({ env, platform }), want, `${platform} ${JSON.stringify(env)}`);
});
