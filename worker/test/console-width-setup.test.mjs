import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { NoLoadEvent, Refusal, SETTLE_CAP_MS, SETTLE_WAIT_MS, SIGN_IN, liveDoc, openPage, settleSource } from "../../.github/scripts/console-width-check.mjs";
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
	assert.equal(f.calls[9].params.expression, settleSource(), "the page is asked to settle by its own rule");
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

/** The probe `openPage` installs before any page script, as the browser was sent it. */
async function probeSource() {
	const f = browserFixture();
	const opening = openPage({ ...options, browser: f.browser });
	opening.catch(() => {});
	await nextTurn();
	f.calls[6].reply.resolve({});
	await nextTurn();
	const source = f.calls[7].params.source;
	for (const call of f.calls) call.reply.reject(new Error("only the probe was wanted"));
	await opening.catch(() => {});
	return source;
}

/**
 * A page for `settleSource` to run in: its fonts, frames and timers are held until the test releases them, so each
 * wait the page makes is seen. `pill` says whether the page has a live pill, `page` is the body's `data-page`, and
 * `probe` whether the check's probe ran first (it records the script's first write of the pill: `mark()` here).
 */
function settlingPage({ live = false, page = "fleet", pill = false, timeline = false, gateway = false, probe = true, marked = false } = {}) {
	const frames = [], timers = [];
	const fonts = deferred();
	const seen = { marked, wake: null };
	const document = {
		body: { hasAttribute: (name) => name === "data-live" && live, getAttribute: (name) => (name === "data-page" ? page : null) },
		fonts: { ready: fonts.promise },
		getElementById: (id) => ((id === "live-status" && pill) || (id === "p-timeline" && timeline) ? {} : null),
		querySelector: (selector) => (gateway && selector === "[data-sandbox-gateway-mode]" ? {} : null),
	};
	const setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer; };
	const clearTimeout = (timer) => { timer.cleared = true; };
	const promise = new Function("window", "document", "requestAnimationFrame", "setTimeout", "clearTimeout", `return ${settleSource()};`)(probe ? { __pdLive: seen } : {}, document, (fn) => frames.push(fn), setTimeout, clearTimeout);
	const page_ = { state: "waiting", frames, timers };
	promise.then((value) => { page_.state = value; });
	page_.frame = async () => { frames.shift()(); await nextTurn(); };
	// Fonts in and both frames drawn: where every page's own rule starts.
	page_.drawn = async () => {
		assert.equal(frames.length, 0, "no frame is asked for before the fonts are in");
		fonts.resolve();
		await nextTurn();
		await page_.frame();
		assert.equal(page_.state, "waiting", "one frame is never enough");
		await page_.frame();
	};
	// The page's script writes the pill, as the probe tells it.
	page_.mark = async () => {
		seen.marked = true;
		if (seen.wake) seen.wake();
		await nextTurn();
	};
	page_.fire = async (ms) => {
		const timer = timers.find((t) => t.ms === ms && !t.cleared && !t.fired);
		timer.fired = true;
		timer.fn();
		await nextTurn();
	};
	page_.waits = () => timers.filter((timer) => !timer.cleared && !timer.fired).map((timer) => timer.ms);
	return page_;
}

test("a page with no event stream is settled at once after its fonts and two frames, with no fixed wait", async () => {
	const p = settlingPage();
	assert.deepEqual(p.waits(), [SETTLE_CAP_MS], "only the cap is armed");
	await p.drawn();
	assert.equal(p.state, true);
	assert.deepEqual([p.waits(), p.frames.length], [[], 0], "the cap is cleared, and nothing else was waited for");
	assert.equal(SETTLE_CAP_MS, 1500);
	const pillOnly = settlingPage({ pill: true });
	await pillOnly.drawn();
	assert.equal(pillOnly.state, true, "a pill on a page with no data-live is not waited for: its script opens no stream");
});

test("a live page is settled one frame after its script first writes the pill, already or when it does, whatever the server drew", async () => {
	const waiting = settlingPage({ live: true, pill: true });
	await waiting.drawn();
	assert.equal(waiting.state, "waiting", "the stream has not opened: the pill still says what the server drew, in whichever state");
	assert.deepEqual([waiting.waits(), waiting.frames.length], [[SETTLE_CAP_MS], 0], "and neither a timer nor a frame stands in for it");
	await waiting.mark();
	assert.deepEqual([waiting.state, waiting.frames.length], ["waiting", 1], "one more frame, so the pill's new width is laid out");
	await waiting.frame();
	assert.equal(waiting.state, true);
	assert.deepEqual(waiting.waits(), []);

	const open = settlingPage({ live: true, pill: true, marked: true });
	await open.drawn();
	assert.deepEqual([open.state, open.frames.length, open.waits()], ["waiting", 1, [SETTLE_CAP_MS]], "a pill written before the fonts were in is not waited for again, but its frame is");
	await open.frame();
	assert.equal(open.state, true);
});

test("a live page that also needs the fixed wait gets it after its pill, never instead: the overview's timeline", async () => {
	for (const page of [{ timeline: true }, { page: "login" }, { gateway: true }]) {
		const p = settlingPage({ live: true, pill: true, ...page });
		await p.drawn();
		assert.deepEqual([p.state, p.waits(), p.frames.length], ["waiting", [SETTLE_CAP_MS], 0], "the fixed wait has not started: the stream is not open");
		await p.mark();
		assert.deepEqual([p.waits(), p.frames.length], [[SETTLE_CAP_MS], 1], "the pill's frame first");
		await p.frame();
		assert.deepEqual([p.state, p.waits()], ["waiting", [SETTLE_CAP_MS, SETTLE_WAIT_MS]], "then the fixed wait");
		await p.fire(SETTLE_WAIT_MS);
		assert.equal(p.state, true);
		assert.equal(p.timers[0].cleared, true);
	}
});

test("a page whose load-time work ends with no event keeps the fixed wait: the timeline, the sign-in pages, the gateway, a live page with nothing to watch", async () => {
	assert.equal(SETTLE_WAIT_MS, 100);
	const kept = [
		["the timeline on a page with no stream", { timeline: true }],
		...SIGN_IN.map(([page]) => [`the sign-in page ${page}`, { page }]),
		["the sandbox gateway's page", { gateway: true }],
		["a live page with no pill", { live: true }],
		["a live page loaded without the probe", { live: true, pill: true, probe: false }],
	];
	assert.deepEqual(SIGN_IN.map(([page]) => page), ["login", "login-code"]);
	for (const [what, page] of kept) {
		const p = settlingPage(page);
		await p.drawn();
		assert.equal(p.state, "waiting", what);
		assert.deepEqual([p.waits(), p.frames.length], [[SETTLE_CAP_MS, SETTLE_WAIT_MS], 0], what);
		await p.fire(SETTLE_WAIT_MS);
		assert.equal(p.state, true, what);
		assert.equal(p.timers[0].cleared, true, `${what}: the cap is cleared`);
	}
});

test("a page that never settles is measured at the cap and says so", async () => {
	for (const page of [{}, { live: true, pill: true }, { live: true, pill: true, timeline: true }]) {
		const p = settlingPage(page);
		if (page.live) await p.drawn();
		await p.fire(SETTLE_CAP_MS);
		assert.equal(p.state, false);
	}
});

test("the probe records the script's first write of the live pill and nothing else, and wakes a settle that waits for it", async () => {
	const source = await probeSource();
	const observers = [];
	class MutationObserver {
		constructor(seen) { this.seen = seen; this.watching = null; observers.push(this); }
		observe(element, how) { this.watching = { element, how }; }
		disconnect() { this.watching = null; }
	}
	const window = { addEventListener() {} };
	const document = { addEventListener() {} };
	new Function("window", "document", "MutationObserver", source)(window, document, MutationObserver);
	const live = window.__pdLive;
	assert.deepEqual(live, { marked: false, wake: null });
	assert.equal(observers.length, 1);
	assert.equal(observers[0].watching.element, document, "from before the pill exists: the whole document");
	assert.deepEqual(observers[0].watching.how, { subtree: true, attributes: true, attributeFilter: ["class"] });
	observers[0].seen([{ target: { id: "main" } }, { target: { id: "" } }]);
	assert.equal(live.marked, false, "another element's class is not the pill's");
	let woken = 0;
	live.wake = () => { woken++; };
	observers[0].seen([{ target: { id: "nav" } }, { target: { id: "live-status" } }]);
	assert.deepEqual([live.marked, woken], [true, 1]);
	assert.equal(observers[0].watching, null, "the first write is the one waited for: nothing is watched after it");
});

test("a navigation whose load event never arrives is its own failure, with its tab closed; any other failure is not", async () => {
	for (const [failure, own] of [[new Refusal("Chrome sent no load event for page within 20 s"), true], [new Refusal("Chrome exited (code 1) before it answered"), false]]) {
		const f = browserFixture();
		const opening = openPage({ ...options, browser: f.browser });
		const rejected = assert.rejects(opening, (error) => (error instanceof NoLoadEvent) === own && error.message === failure.message && error instanceof Refusal);
		await nextTurn();
		f.calls[6].reply.resolve({});
		await nextTurn();
		for (const call of f.calls) call.reply.resolve({});
		await nextTurn();
		f.calls.find((call) => call.method === "Page.navigate").reply.resolve({});
		f.load.reject(failure);
		await rejected;
		assert.equal(f.closed(), 1);
	}
});

test("a doc is live by data-live on its body alone", () => {
	assert.equal(liveDoc({ html: '<!doctype html><html><body data-page="fleet" data-live="fleet" data-query="">' }), true);
	assert.equal(liveDoc({ html: '<body data-live="fleet">' }), true);
	assert.equal(liveDoc({ html: '<body data-page="secrets"><form data-live-hold><span data-live-word>Live</span><div data-live="x">' }), false, "not an attribute that starts alike, nor one on another element");
	assert.equal(liveDoc({ html: "" }), false);
	assert.equal(liveDoc(undefined), false);
});
