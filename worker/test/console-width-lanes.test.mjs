import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { BROWSER_LANES, FIXTURES, Refusal, browserLanePlans, checkPageLane, checkPages, loadModules, longRunId, noScriptRun, planRuns, planShellRuns, readGoldens, shellContexts, shellDocs } from "../../.github/scripts/console-width-check.mjs";

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test("both lane partitions together preserve every original golden and shell case, with no overlap and one no-script/extras owner", async () => {
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
		assert.equal(new Set(assigned.map((run) => run.key)).size, original.length, `${field}: no case may occur in both lanes`);
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

test("both lanes start concurrently with complete route/control maps and separate artifacts, then merge every result", async () => {
	const gates = [deferred(), deferred()], seen = [];
	const shellDocs = [], controls = [{ id: "control" }], liveStates = [];
	const args = { docs, shellDocs, controls, liveStates, work: tempDir("pd-width-lanes-"), shots: tempDir("pd-width-shots-"), log() {} };
	const running = checkPages(args, { checkLane: async (lane) => {
		seen.push(lane);
		assert.equal(lane.docs, docs, "partition runs, never the server's complete document map");
		assert.equal(lane.shellDocs, shellDocs);
		assert.equal(lane.controls, controls, "both negative controls must reach every lane");
		assert.equal(lane.liveStates, liveStates);
		assert.ok(existsSync(lane.work));
		assert.ok(existsSync(lane.shots));
		await gates[lane.lanePlan.id - 1].promise;
		return result(lane.lanePlan.id);
	} });
	await nextTurn();
	assert.equal(seen.length, 2, "the second browser must start while the first is waiting");
	assert.equal(new Set(seen.map((lane) => lane.work)).size, 2);
	assert.equal(new Set(seen.map((lane) => lane.shots)).size, 2);
	gates[1].resolve();
	gates[0].resolve();
	const merged = await running;
	assert.deepEqual(merged.results.map((entry) => entry.run.key), ["page-1", "page-2"]);
	assert.deepEqual(merged.shell.map((entry) => entry.run.key), ["shell-1", "shell-2"]);
	assert.deepEqual(merged.controls.map((entry) => [entry.lane, entry.failures]), [[1, ["observed-1"]], [2, ["observed-2"]]]);
});

test("a rejected lane waits for the other lane's cleanup and cannot become a passing partial result", async () => {
	const gates = [deferred(), deferred()], cleaned = [];
	const running = checkPages({ docs, work: tempDir("pd-width-lanes-fail-"), log() {} }, { checkLane: async ({ lanePlan }) => {
		try { return await gates[lanePlan.id - 1].promise; }
		finally { cleaned.push(lanePlan.id); }
	} });
	let settled = false;
	const rejected = assert.rejects(running, (error) => error instanceof AggregateError && /lane 1: startup failed/.test(error.message) && /lane 2: measurement failed/.test(error.message)).finally(() => { settled = true; });
	gates[0].reject(new Error("startup failed"));
	await nextTurn();
	assert.deepEqual(cleaned, [1]);
	assert.equal(settled, false, "early failure cannot abandon the browser still running");
	gates[1].reject(new Error("measurement failed"));
	await rejected;
	assert.deepEqual(cleaned, [1, 2]);
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
