import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { BROWSER_LANES, BUDGET_WARN, FIXTURES, PROGRESS_MS, RUN_MS, Refusal, UNSETTLED_NAMED, VIEWPORT, browserLanePlans, budgetLines, checkPageLane, checkPages, laneTiming, loadModules, longRunId, noScriptRun, planRuns, planShellRuns, readGoldens, settleSource, shellContexts, shellDocs, unsettledLines } from "../../.github/scripts/console-width-check.mjs";

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const LANES = Array.from({ length: BROWSER_LANES }, (_, index) => index + 1);

test("the lane partitions together preserve every original golden and shell case, with no overlap and one no-script/extras owner", async () => {
	const m = await loadModules();
	const docs = [...readGoldens(FIXTURES, "").docs, ...readGoldens(join(FIXTURES, "panels"), "panels/").docs];
	const runId = longRunId((id) => m.pages.parsePageQuery("run", new URLSearchParams({ id })).query?.id === id);
	const sweep = await shellDocs({ pageNames: Object.keys(m.pages.PAGES), contexts: shellContexts(m.TOKEN_NAME_RE), runId, draw: (name, ctx) => m.pages.renderPage(name, ctx) });
	const plans = browserLanePlans(docs, sweep);
	assert.equal(plans.length, BROWSER_LANES);
	for (const [field, original] of [["pages", planRuns(docs)], ["shell", planShellRuns(sweep)]]) {
		const assigned = plans.flatMap((plan) => plan[field]);
		const byKey = (runs) => [...runs].sort((a, b) => a.key.localeCompare(b.key));
		assert.deepEqual(byKey(assigned), byKey(original), `${field}: union must equal the complete original schedule, including widths/themes/emulation`);
		assert.equal(new Set(assigned.map((run) => run.key)).size, original.length, `${field}: no case may occur in two lanes`);
		const sizes = plans.map((plan) => plan[field].length);
		assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${field}: dealt out evenly (${sizes.join(", ")})`);
		for (const plan of plans) {
			const own = new Set(plan[field].map((run) => run.key));
			assert.deepEqual(plan[field], original.filter((run) => own.has(run.key)), "each lane retains the original ordering");
		}
	}
	assert.deepEqual(plans.flatMap((plan) => plan.noScript ? [plan.noScript] : []), [noScriptRun(sweep)]);
	assert.equal(plans.filter((plan) => plan.extras).length, 1);
});

const docs = [{ id: "overview.operator", page: "overview", path: "/overview", html: "overview" }];
const result = (lane) => ({ product: "Chrome/pinned", results: [{ run: { key: `page-${lane}` } }], shell: [{ run: { key: `shell-${lane}` } }], controls: [{ run: { key: "control" }, failures: [`observed-${lane}`] }] });

test("every lane starts concurrently with complete route/control maps and separate artifacts, then every result is merged", async () => {
	assert.ok(BROWSER_LANES >= 2, "one lane would have nothing to run beside");
	const gates = LANES.map(() => deferred()), seen = [];
	const shellDocs = [], controls = [{ id: "control" }], liveStates = [];
	const args = { docs, shellDocs, controls, liveStates, work: tempDir("pd-width-lanes-"), shots: tempDir("pd-width-shots-"), log() {} };
	const running = checkPages(args, { checkLane: async (lane) => {
		seen.push(lane);
		assert.equal(lane.docs, docs, "partition runs, never the server's complete document map");
		assert.equal(lane.shellDocs, shellDocs);
		assert.equal(lane.controls, controls, "the negative controls must reach every lane");
		assert.equal(lane.liveStates, liveStates);
		assert.ok(existsSync(lane.work));
		assert.ok(existsSync(lane.shots));
		await gates[lane.lanePlan.id - 1].promise;
		return result(lane.lanePlan.id);
	} });
	await nextTurn();
	assert.deepEqual(seen.map((lane) => lane.lanePlan.id), LANES, "every browser must start while the first is waiting");
	assert.equal(new Set(seen.map((lane) => lane.work)).size, BROWSER_LANES);
	assert.equal(new Set(seen.map((lane) => lane.shots)).size, BROWSER_LANES);
	// The last lane finishes first: the merge is by lane, never by who was done first.
	for (const gate of [...gates].reverse()) gate.resolve();
	const merged = await running;
	assert.deepEqual(merged.results.map((entry) => entry.run.key), LANES.map((lane) => `page-${lane}`));
	assert.deepEqual(merged.shell.map((entry) => entry.run.key), LANES.map((lane) => `shell-${lane}`));
	assert.deepEqual(merged.controls.map((entry) => [entry.lane, entry.failures]), LANES.map((lane) => [lane, [`observed-${lane}`]]));
});

test("a rejected lane waits for every other lane's cleanup and cannot become a passing partial result", async () => {
	const gates = LANES.map(() => deferred()), cleaned = [];
	const running = checkPages({ docs, work: tempDir("pd-width-lanes-fail-"), log() {} }, { checkLane: async ({ lanePlan }) => {
		try { return await gates[lanePlan.id - 1].promise; }
		finally { cleaned.push(lanePlan.id); }
	} });
	let settled = false;
	const said = (lane) => (lane === 1 ? "lane 1: startup failed" : `lane ${lane}: measurement ${lane} failed`);
	const rejected = assert.rejects(running, (error) => error instanceof AggregateError && error.errors.length === BROWSER_LANES && LANES.every((lane) => error.message.includes(said(lane)))).finally(() => { settled = true; });
	gates[0].reject(new Error("startup failed"));
	await nextTurn();
	assert.deepEqual(cleaned, [1]);
	assert.equal(settled, false, "early failure cannot abandon the browsers still running");
	for (const lane of LANES.slice(1)) {
		assert.equal(settled, false, `lane ${lane} is still running`);
		gates[lane - 1].reject(new Error(`measurement ${lane} failed`));
		await nextTurn();
	}
	await rejected;
	assert.deepEqual(cleaned, LANES);
});

test("the lanes must agree on the browser build, even when all measurements pass", async () => {
	await assert.rejects(checkPages({ docs, work: tempDir("pd-width-lanes-build-"), log() {} }, { checkLane: async ({ lanePlan }) => ({ ...result(lanePlan.id), product: `Chrome/${lanePlan.id}` }) }), /same Chrome build/);
});

function fakeServer() {
	const calls = [];
	const server = {
		once() { return server; },
		listen(port, host, resolve) { calls.push(["listen", port, host]); resolve(); },
		address() { return { port: 12345 }; },
		closeAllConnections() { calls.push(["close connections"]); },
		close(resolve) { calls.push(["close server"]); resolve(); },
	};
	return { server, calls };
}

const emptyLane = { docs: [], heads: {}, controls: [], lanePlan: { pages: [], shell: [], noScript: null, extras: false }, work: "/test-only", children: new Set(), log() {} };

test("a browser startup refusal closes its already-listening lane server", async () => {
	const f = fakeServer(), failure = new Refusal("browser could not start");
	await assert.rejects(checkPageLane(emptyLane, { makeServer: () => f.server, openBrowser: async () => { throw failure; } }), (error) => error === failure);
	assert.deepEqual(f.calls, [["listen", 0, "127.0.0.1"], ["close connections"], ["close server"]]);
});

test("a browser close failure still removes its singleton and closes its lane server", async () => {
	const f = fakeServer(), failure = new Error("browser close failed");
	let singletonRemoved = false;
	const browser = { send: async () => ({ product: "Chrome/pinned" }), close: async () => { throw failure; }, removeSingleton() { singletonRemoved = true; } };
	await assert.rejects(checkPageLane(emptyLane, { makeServer: () => f.server, openBrowser: async () => browser }), (error) => error === failure);
	assert.equal(singletonRemoved, true);
	assert.deepEqual(f.calls.at(-2), ["close connections"]);
	assert.deepEqual(f.calls.at(-1), ["close server"]);
});

test("a lane's clock tells each part's runs and time, the runs that never settled, and where a cut found it", () => {
	let at = 1_000;
	const said = [];
	const timing = laneTiming({ now: () => at, log: (line) => said.push(line) });
	assert.equal(timing.cut(), "cut off in not started, 0.0 s in, 0 runs not settled, 0 navigations retried");
	timing.begin("Chrome start");
	at += 1_500;
	assert.equal(timing.cut(), "cut off in Chrome start, 1.5 s in, 0 runs not settled, 0 navigations retried", "a part that is not a list of runs has no count");
	timing.begin("golden runs", 3);
	timing.run("overview.operator light");
	at += 20_000;
	assert.equal(timing.cut(), "cut off in golden runs 0 of 3, at overview.operator light, 21.5 s in, 0 runs not settled, 0 navigations retried");
	timing.settled(true);
	timing.ran();
	timing.run("overview.operator dark");
	at += PROGRESS_MS - 21_500 - 1;
	timing.settled(false, "overview.operator dark");
	timing.ran();
	assert.deepEqual(said, [], "nothing is said before a minute has passed");
	timing.run("fleet.operator light");
	at += 1;
	timing.ran();
	assert.deepEqual(said, ["progress: golden runs 3 of 3, 60.0 s in"], "said between runs, so it names no run in hand");
	timing.begin("shell runs", 2);
	timing.run("shell.operator.overview 320");
	at += PROGRESS_MS;
	timing.settled(false, "shell.operator.overview 320");
	timing.ran();
	assert.deepEqual(said.slice(1), ["progress: shell runs 1 of 2, 120.0 s in"], "and again a minute after it last spoke, not before");
	timing.run("shell.operator.overview 375");
	at += 500;
	timing.ran();
	assert.equal(said.length, 2);
	timing.begin("spend");
	timing.run("spend-browser");
	at += 2_250;
	assert.equal(timing.line(), "timing: Chrome start 1.5 s, golden runs 3 in 58.5 s, shell runs 2 in 60.5 s, spend 2.3 s, total 122.8 s, 2 runs not settled, 0 navigations retried", "a part still open is told as it stands");
	assert.equal(timing.cut(), "cut off in spend, at spend-browser, 122.8 s in, 2 runs not settled, 0 navigations retried");
	timing.end();
	assert.deepEqual(timing.unsettled(), ["overview.operator dark", "shell.operator.overview 320"], "each by its run, in order");
	at += 10_000;
	assert.equal(timing.line(), "timing: Chrome start 1.5 s, golden runs 3 in 58.5 s, shell runs 2 in 60.5 s, spend 2.3 s, total 132.8 s, 2 runs not settled, 0 navigations retried", "a closed part keeps its time");
	assert.equal(timing.cut(), "cut off in finished, 132.8 s in, 2 runs not settled, 0 navigations retried", "the lanes were done: the time went after them");
	const single = laneTiming({ now: () => at });
	single.settled(false);
	assert.equal(single.line(), "timing: total 0.0 s, 1 run not settled, 0 navigations retried");
	assert.deepEqual(single.unsettled(), [null], "a page nobody named is still counted");
	single.retried();
	assert.equal(single.line(), "timing: total 0.0 s, 1 run not settled, 1 navigation retried");
	single.retried();
	assert.equal(single.cut("failed"), "failed in not started, 0.0 s in, 1 run not settled, 2 navigations retried", "a lane's own failure is told as a cut is, under its own word");
});

test("a finished run tells its time against the deadline once, and warns only above the share that leaves no room", () => {
	assert.deepEqual(budgetLines(612_340), ["::notice::the console width check took 612.3 s of its 1200 s (51 %)"]);
	assert.equal(RUN_MS, 1_200_000);
	assert.equal(BUDGET_WARN, 0.7);
	assert.equal(budgetLines(RUN_MS * BUDGET_WARN).length, 1, "at the share itself there is no warning");
	const over = budgetLines(RUN_MS * BUDGET_WARN + 1_000);
	assert.deepEqual(over, [
		"::notice::the console width check took 841.0 s of its 1200 s (70 %)",
		"::warning::the console width check took 841.0 s of its 1200 s (70 %): above 70 %, so a slower runner would not finish; the lane timing lines above say where the time goes",
	]);
	assert.deepEqual(budgetLines(30_000, 60_000), ["::notice::the console width check took 30.0 s of its 60 s (50 %)"]);
});

/**
 * A browser whose every page answers what a clean golden run reads: the settle (`settled`, by page path), the CSP and
 * error lists, the canvas, the width measure and a phone's emulation, and to a shell run's reads of the bar and of More
 * that the page has neither. `asked` is every expression evaluated, by page.
 */
function cleanBrowser({ settled = () => true, onNavigate = () => {}, noLoad = () => false, threw = () => false } = {}) {
	const asked = [];
	let closed = 0, tabs = 0;
	const browser = {
		async send(method) {
			assert.equal(method, "Browser.getVersion");
			return { product: "Chrome/pinned", revision: "r1" };
		},
		// The load event of the tab just opened: `noLoad(n)` says the nth tab's never arrives.
		async event(match, what, ms) {
			if (noLoad(tabs)) throw new Refusal(`Chrome sent no ${what} within ${ms / 1000} s`);
			return {};
		},
		async openTarget() {
			let path = null;
			tabs++;
			return {
				sessionId: "session",
				async send(method, params) {
					if (method === "Page.navigate") {
						path = new URL(params.url).pathname;
						onNavigate(path);
					}
					if (method !== "Runtime.evaluate") return {};
					const expression = params.expression;
					asked.push({ path, expression });
					if (threw(path)) return { exceptionDetails: { text: "the page broke" } };
					const value = /^new Promise/.test(expression) ? settled(path)
						: expression.includes("__pdCsp") || expression.includes("__pdErrors") ? "[]"
						: expression.includes("--canvas") ? "#ffffff"
						: expression.includes('meta[name="viewport"]') ? { dpr: VIEWPORT.scale, mobile: true, probed: 1234 }
						: expression.includes("[data-live-word]") || expression.includes("details.more") ? null
						: { scrollWidth: VIEWPORT.width, clientWidth: VIEWPORT.width, elements: [] };
					return { result: { value } };
				},
				async close() {},
			};
		},
		async close() { closed++; },
		removeSingleton() {},
	};
	return { browser, asked, closed: () => closed, tabs: () => tabs };
}

const golden = (name, body) => ({ id: `${name}.operator`, file: `${name}.operator.html`, path: `/fixtures/${name}.operator.html`, page: name, role: "operator", html: `<!doctype html><body data-page="${name}"${body}>` });
const laneOf = (pages, extra = {}) => ({ docs: pages, heads: {}, controls: [], canvasOf: () => "#ffffff", clockMs: 0, shots: null, work: "/test-only", children: new Set(), applyHeaders() {}, lanePlan: { id: 1, pages: pages.map((doc) => ({ key: `${doc.id} light`, doc, emulated: "light", forced: null, expect: "light", label: "light" })), shell: [], noScript: null, extras: false }, ...extra });

test("a lane hands out its clock as it starts and closes with one timing line that counts the runs that never settled", async () => {
	const pages = [golden("fleet", ""), golden("runs", ""), golden("audit", "")];
	const f = fakeServer(), b = cleanBrowser({ settled: (path) => !path.includes("runs") });
	const lines = [], handed = [];
	let at = 0;
	const outcome = await checkPageLane(laneOf(pages, { log: (line) => lines.push(line), onTiming: (timing) => handed.push(timing) }), { makeServer: () => f.server, openBrowser: async () => b.browser, now: () => (at += 250) });
	assert.deepEqual(outcome.results.map((r) => [r.run.key, r.failures, r.notes.length]), [["fleet.operator light", [], 0], ["runs.operator light", [], 1], ["audit.operator light", [], 0]]);
	assert.equal(handed.length, 1, "handed out once, before the browser starts, so a cut during startup can still ask it");
	assert.match(lines[0], /^Chrome Chrome\/pinned /);
	assert.equal(lines.length, 2, "nothing between the browser's line and the closing one in a run this short");
	assert.match(lines[1], /^timing: Chrome start [\d.]+ s, controls 0 in [\d.]+ s, golden runs 3 in [\d.]+ s, shell runs 0 in [\d.]+ s, total [\d.]+ s, 1 run not settled, 0 navigations retried$/);
	assert.match(handed[0].line(), /golden runs 3 in .*, 1 run not settled, 0 navigations retried$/, "the clock handed out is the lane's own");
	assert.deepEqual(outcome.unsettled, ["runs.operator light"], "and the lane names them to the check");
	assert.match(handed[0].cut(), /^cut off in finished, /);
	assert.equal(b.closed(), 1);
});

test("a lane a minute into its runs says where it is, and every lane's clock reaches the caller under its lane", async () => {
	const pages = [golden("fleet", ""), golden("runs", "")];
	const f = fakeServer(), b = cleanBrowser();
	const lines = [];
	let at = 0;
	await checkPageLane(laneOf(pages, { log: (line) => lines.push(line) }), { makeServer: () => f.server, openBrowser: async () => b.browser, now: () => (at += PROGRESS_MS / 2) });
	assert.ok(lines.some((line) => /^progress: golden runs 1 of 2, [\d.]+ s in$/.test(line)), lines.join("\n"));
	const seen = [];
	await checkPages({ docs, work: tempDir("pd-width-lanes-clock-"), log() {}, onTiming: (lane, timing) => seen.push([lane, timing]) }, { checkLane: async (lane) => {
		lane.onTiming(`clock-${lane.lanePlan.id}`);
		return result(lane.lanePlan.id);
	} });
	assert.deepEqual(seen.sort((a, b) => a[0] - b[0]), LANES.map((lane) => [lane, `clock-${lane}`]));
});

/** A lane server that keeps its handler, so a test can make the requests a page would: `get(path)`. */
function servingServer() {
	const f = fakeServer();
	let handler = null;
	const get = (path) => handler({ method: "GET", url: path, on() {}, resume() {} }, { writeHead() { return this; }, end() {}, flushHeaders() {}, destroy() {} });
	return { make: (h) => { handler = h; return f.server; }, get };
}

test("every page a lane opens is settled by the page's own rule", async () => {
	const pages = [golden("fleet", ' data-live="fleet"'), golden("secrets", "")];
	const s = servingServer(), b = cleanBrowser();
	await checkPageLane(laneOf(pages, { log() {} }), { makeServer: s.make, openBrowser: async () => b.browser });
	const settles = b.asked.filter((a) => /^new Promise/.test(a.expression));
	assert.deepEqual(settles.map((a) => a.path), pages.map((doc) => doc.path));
	for (const a of settles) assert.equal(a.expression, settleSource());
});

test("a page with no data-live that opens the event stream fails its run: it was called settled before its pill moved", async () => {
	const pages = [golden("fleet", ' data-live="fleet"'), golden("secrets", ""), golden("audit", "")];
	const s = servingServer();
	// The live page and one of the others open a stream, as their script would on load.
	const b = cleanBrowser({ onNavigate: (path) => {
		s.get(path);
		if (!path.includes("audit")) s.get("/api/events?page=x");
	} });
	const outcome = await checkPageLane(laneOf(pages, { log() {} }), { makeServer: s.make, openBrowser: async () => b.browser });
	assert.deepEqual(outcome.results.map((r) => [r.run.key, r.failures]), [
		["fleet.operator light", []],
		["secrets.operator light", ["asked for /api/events, but its page (secrets.operator) has no data-live on <body>: such a page counts as settled at once, so it was measured before its stream opened (give the page data-live, or teach settleSource what opens a stream there)"]],
		["audit.operator light", []],
	]);
});

test("a stream opened by a page of the interactive checks, which have no run of their own to fail, refuses the lane", async () => {
	const pages = [{ ...golden("triggers", ""), file: "triggers.operator.html" }];
	const s = servingServer();
	const b = cleanBrowser({ onNavigate: (path) => {
		s.get(path);
		s.get("/api/events?page=triggers");
	} });
	const lane = laneOf(pages, { log() {} });
	await assert.rejects(checkPageLane({ ...lane, lanePlan: { ...lane.lanePlan, pages: [], extras: true } }, { makeServer: s.make, openBrowser: async () => b.browser }), (error) => error instanceof Refusal && /^triggers-browser: asked for \/api\/events, but its page \(triggers\.operator\) has no data-live on <body>/.test(error.message));
	assert.equal(b.closed(), 1, "and its browser is still closed");
});

const shellDoc = (name) => ({ id: `shell.operator.${name}`, path: `/shell/operator/${name}`, page: name, role: "operator", longest: false, readOnly: false, html: `<!doctype html><body data-page="${name}" data-live="${name}">` });
const controlOf = (id) => ({ id, name: id, path: `/control/${id}`, css: "", width: 1024, mobile: false, html: `<!doctype html><body data-page="${id}">` });

test("the controls and the shell runs open through the lane as the golden runs do: each unsettled one is counted and named", async () => {
	const pages = [golden("fleet", "")];
	const sweep = [shellDoc("overview"), shellDoc("fleet")];
	const controls = [controlOf("control"), controlOf("control-phone")];
	const shell = [{ key: "shell.operator.overview 320", doc: sweep[0], width: 320, mobile: true }, { key: "shell.operator.fleet 1024", doc: sweep[1], width: 1024, mobile: false }];
	const lane = laneOf(pages, { log() {}, shellDocs: sweep, controls });
	const run = async (settled) => {
		const f = fakeServer(), b = cleanBrowser({ settled });
		const lines = [];
		const outcome = await checkPageLane({ ...lane, log: (line) => lines.push(line), lanePlan: { ...lane.lanePlan, shell } }, { makeServer: () => f.server, openBrowser: async () => b.browser });
		return { outcome, line: lines.at(-1) };
	};
	const none = await run(() => true);
	assert.deepEqual(none.outcome.unsettled, []);
	assert.match(none.line, /controls 2 in [\d.]+ s, golden runs 1 in [\d.]+ s, shell runs 2 in [\d.]+ s, total [\d.]+ s, 0 runs not settled, 0 navigations retried$/);
	const all = await run(() => false);
	assert.deepEqual(all.outcome.unsettled, ["control", "control-phone", "fleet.operator light", "shell.operator.overview 320", "shell.operator.fleet 1024"]);
	assert.match(all.line, /, 5 runs not settled, 0 navigations retried$/);
	assert.deepEqual(all.outcome.controls.map((r) => r.notes.length > 0), [true, true], "each carries its note too");
	assert.deepEqual(all.outcome.shell.map((r) => r.notes.length > 0), [true, true]);
	const shellOnly = await run((path) => !path.startsWith("/shell/"));
	assert.deepEqual(shellOnly.outcome.unsettled, shell.map((r) => r.key));
	const controlsOnly = await run((path) => !path.startsWith("/control/"));
	assert.deepEqual(controlsOnly.outcome.unsettled, ["control", "control-phone"]);
});

test("the runs that did not settle are one warning for the whole check: the count and the first of them", async () => {
	assert.deepEqual(unsettledLines([]), []);
	assert.deepEqual(unsettledLines(["overview.operator light"]), ["::warning::1 run did not settle within 1.5 s and was measured as it stood, a live page with the pill the server drew: overview.operator light"]);
	const keys = Array.from({ length: UNSETTLED_NAMED + 3 }, (_, index) => `run ${index + 1}`);
	assert.equal(UNSETTLED_NAMED, 5);
	assert.deepEqual(unsettledLines(keys.slice(0, UNSETTLED_NAMED)), ["::warning::5 runs did not settle within 1.5 s and were measured as they stood, a live page with the pill the server drew: run 1; run 2; run 3; run 4; run 5"]);
	assert.deepEqual(unsettledLines(keys), ["::warning::8 runs did not settle within 1.5 s and were measured as they stood, a live page with the pill the server drew: run 1; run 2; run 3; run 4; run 5 and 3 more"]);
	const check = async (unsettledOf) => {
		const lines = [];
		const merged = await checkPages({ docs, work: tempDir("pd-width-lanes-unsettled-"), log: (line) => lines.push(line) }, { checkLane: async ({ lanePlan, log }) => {
			log("a lane's own line");
			return { ...result(lanePlan.id), unsettled: unsettledOf(lanePlan.id) };
		} });
		return { lines, merged };
	};
	const clean = await check(() => []);
	assert.deepEqual(clean.lines, LANES.map((lane) => `[lane ${lane}] a lane's own line`), "no warning when every page settled");
	const some = await check((lane) => (lane === 1 ? [] : [`run of lane ${lane}`]));
	assert.deepEqual(some.lines.slice(BROWSER_LANES), [unsettledLines(LANES.slice(1).map((lane) => `run of lane ${lane}`))[0]], "one line, with no lane before it, so it is read as an annotation");
	assert.match(some.lines.at(-1), /^::warning::/);
	assert.equal(some.merged.results.length, BROWSER_LANES, "and the check goes on: a warning, not a failure");
});

test("a navigation whose load event never arrives is opened once more in a fresh tab, said and counted; a second loss fails the lane at once with where it was", async () => {
	const pages = [golden("fleet", ""), golden("runs", ""), golden("audit", "")];
	const once = cleanBrowser({ noLoad: (tab) => tab === 2 });
	const f = fakeServer(), lines = [];
	const outcome = await checkPageLane(laneOf(pages, { log: (line) => lines.push(line) }), { makeServer: () => f.server, openBrowser: async () => once.browser });
	assert.deepEqual(outcome.results.map((r) => [r.run.key, r.failures]), [["fleet.operator light", []], ["runs.operator light", []], ["audit.operator light", []]], "the run is measured on its second tab, and no run is lost or made twice");
	assert.equal(once.tabs(), 4, "three runs and one more tab");
	assert.deepEqual(lines.filter((line) => line.startsWith("retrying")), ["retrying once in a fresh tab: Chrome sent no load event for runs.operator light within 20 s"]);
	assert.match(lines.at(-1), /, 0 runs not settled, 1 navigation retried$/);

	const twice = cleanBrowser({ noLoad: (tab) => tab === 2 || tab === 3 });
	const g = fakeServer(), said = [];
	await assert.rejects(checkPageLane(laneOf(pages, { log: (line) => said.push(line) }), { makeServer: () => g.server, openBrowser: async () => twice.browser }), (error) => error instanceof Refusal && error.message === "Chrome sent no load event for runs.operator light within 20 s");
	assert.equal(twice.tabs(), 3, "once more, never twice");
	assert.match(said.at(-1), /^failed in golden runs 1 of 3, at runs\.operator light, [\d.]+ s in, 0 runs not settled, 1 navigation retried: Chrome sent no load event for runs\.operator light within 20 s$/, "the lane's last line is where it died, said when it died");
	assert.equal(said.some((line) => line.startsWith("timing:")), false);
	assert.equal(twice.closed(), 1);
});

test("a page that loaded and then failed is never opened again", async () => {
	const pages = [golden("fleet", ""), golden("runs", "")];
	const b = cleanBrowser({ threw: (path) => path.includes("runs") });
	const f = fakeServer(), lines = [];
	await assert.rejects(checkPageLane(laneOf(pages, { log: (line) => lines.push(line) }), { makeServer: () => f.server, openBrowser: async () => b.browser }), (error) => error instanceof Refusal && /^runs\.operator light: the page threw while measured/.test(error.message));
	assert.equal(b.tabs(), 2, "one tab a run");
	assert.equal(lines.some((line) => line.startsWith("retrying")), false);
	assert.match(lines.at(-1), /^failed in golden runs 1 of 2, at runs\.operator light, .*, 0 navigations retried: runs\.operator light: the page threw while measured/);
});
