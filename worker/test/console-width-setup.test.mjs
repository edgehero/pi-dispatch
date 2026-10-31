import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { openPage } from "../../.github/scripts/console-width-check.mjs";
import { frozenDateSource } from "../../launch/chrome-pipe.mjs";

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function browserFixture() {
	const calls = [], events = [], load = deferred();
	let closed = 0;
	const target = {
		sessionId: "session",
		send(method, params) {
			const reply = deferred();
			calls.push({ method, params, reply });
			return reply.promise;
		},
		async close() { closed++; },
	};
	const browser = { openTarget: async () => target, event(match, what, ms) { events.push({ match, what, ms, before: calls.length }); return load.promise; } };
	return { browser, target, calls, events, load, closed: () => closed };
}

const metrics = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };
const options = { key: "page", url: "http://127.0.0.1:1/page", metrics, emulated: "dark", clockMs: 1234 };

test("page setup overlaps independent CDP calls and waits for every reply, with clock before probe and listener before navigation", async () => {
	const f = browserFixture();
	const opening = openPage({ ...options, browser: f.browser });
	await nextTurn();
	assert.deepEqual(f.calls.map(call => call.method), ["Page.enable", "Page.bringToFront", "Emulation.setDeviceMetricsOverride", "Emulation.setTimezoneOverride", "Emulation.setLocaleOverride", "Emulation.setEmulatedMedia", "Page.addScriptToEvaluateOnNewDocument"], "independent calls must be in flight together rather than await earlier replies");
	assert.deepEqual(f.calls[2].params, metrics);
	assert.deepEqual(f.calls[3].params, { timezoneId: "UTC" });
	assert.deepEqual(f.calls[4].params, { locale: "en-US" });
	assert.deepEqual(f.calls[5].params, { media: "screen", features: [{ name: "prefers-color-scheme", value: "dark" }] });
	assert.equal(f.calls[6].params.source, frozenDateSource(options.clockMs));
	f.calls[6].reply.resolve({ identifier: "clock" });
	await nextTurn();
	assert.equal(f.calls.length, 8);
	assert.equal(f.calls[7].method, "Page.addScriptToEvaluateOnNewDocument");
	assert.match(f.calls[7].params.source, /securitypolicyviolation/);
	assert.equal(f.events.length, 0);
	// Return all replies out of request order, except the viewport. A single unfinished setting must block navigation.
	for (const index of [7, 5, 4, 3, 1, 0]) f.calls[index].reply.resolve({});
	await nextTurn();
	assert.equal(f.calls.some(call => call.method === "Page.navigate"), false);
	assert.equal(f.events.length, 0);
	f.calls[2].reply.resolve({});
	await nextTurn();
	assert.equal(f.events.length, 1);
	assert.equal(f.events[0].before, 8, "load listener must be registered before Page.navigate can send a load event");
	assert.equal(f.events[0].match({ method: "Page.loadEventFired", sessionId: "another-session" }), false);
	assert.equal(f.events[0].match({ method: "Page.loadEventFired", sessionId: f.target.sessionId }), true);
	assert.equal(f.calls[8].method, "Page.navigate");
	assert.deepEqual(f.calls[8].params, { url: options.url });
	f.calls[8].reply.resolve({});
	await nextTurn();
	assert.equal(f.calls.length, 9, "settling must still wait for the actual load event");
	f.load.resolve({});
	await nextTurn();
	assert.equal(f.calls[9].method, "Runtime.evaluate");
	assert.equal(f.calls[9].params.awaitPromise, true);
	f.calls[9].reply.resolve({ result: { value: true } });
	assert.equal((await opening).settled, true);
	assert.equal(f.closed(), 0, "successful caller retains ownership of its tab");
});

test("a no-script setup must be acknowledged before navigation and any setup failure closes the tab", async () => {
	const f = browserFixture();
	const opening = openPage({ ...options, browser: f.browser, noScript: true });
	const failure = new Error("script configuration refused");
	const rejected = assert.rejects(opening, error => error === failure);
	await nextTurn();
	const script = f.calls.find(call => call.method === "Emulation.setScriptExecutionDisabled");
	assert.deepEqual(script?.params, { value: true });
	for (const call of f.calls) if (call !== script) call.reply.resolve({});
	await nextTurn();
	f.calls.find(call => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.params.source !== frozenDateSource(options.clockMs)).reply.resolve({});
	await nextTurn();
	assert.equal(f.calls.some(call => call.method === "Page.navigate"), false, "all other acknowledgements cannot bypass script disabling");
	assert.equal(f.events.length, 0);
	script.reply.reject(failure);
	await rejected;
	assert.equal(f.closed(), 1);
	assert.equal(f.calls.some(call => call.method === "Page.navigate"), false);
});

test("a rejected clock registration never registers the probe or starts navigation", async () => {
	const f = browserFixture();
	const opening = openPage({ ...options, browser: f.browser });
	const failure = new Error("clock registration refused");
	const rejected = assert.rejects(opening, error => error === failure);
	await nextTurn();
	for (const call of f.calls) {
		if (call.method === "Page.addScriptToEvaluateOnNewDocument") call.reply.reject(failure);
		else call.reply.resolve({});
	}
	await rejected;
	assert.equal(f.calls.filter(call => call.method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
	assert.equal(f.calls.some(call => call.method === "Page.navigate"), false);
	assert.equal(f.closed(), 1);
});
