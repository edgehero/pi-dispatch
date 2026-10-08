import assert from "node:assert/strict";
import { test } from "node:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPACITY_ENV_KEYS, capacityText, durationText, milliText, percentText, runCapacity } from "../src/capacity-cli.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// `pi-dispatch capacity` (issue #599, REQ-CAPACITY-INSIGHTS): every collaborator injected, the clock too. The Valkey is
// a fake with no mirror index, so the report reads this host's files, as an unnamed single host does.

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const H = 60 * 60 * 1000;
const CAP = { slots: 2, memMiB: 16384, cpuCenti: 800, cpus: 8 };

function deployment(records) {
	const dir = tempDir("pi-cap-cli-");
	for (const r of records) {
		const p = join(dir, `${r.jobId}.json`);
		writeFileSync(p, JSON.stringify(r));
		utimesSync(p, NOW / 1000, NOW / 1000);
	}
	return dir;
}

const run = (jobId, from, to, extra = {}) => ({ jobId, host: "mini1", project: "web", startedAt: new Date(NOW - from * H).toISOString(), endedAt: new Date(NOW - to * H).toISOString(), queuedAt: new Date(NOW - from * H - 40_000).toISOString(), size: { memMiB: 4096, cpuCenti: 200, source: "env" }, resources: { cpuUsec: (from - to) * H * 1000 }, capacity: CAP, ...extra });

function harness(dir, { live = [], disagreement = false, refused = null } = {}) {
	const out = [];
	const err = [];
	const redisCalls = [];
	const redis = { zcard: async () => (redisCalls.push("zcard"), 0), on: () => {}, disconnect: () => redisCalls.push("disconnect") };
	const opts = {
		env: { PI_LOGS_DIR: dir, PI_WORKER_NAME: "mini1", PI_LOG_RETENTION_DAYS: "30" },
		write: (c) => out.push(c),
		errWrite: (c) => err.push(c),
		now: () => NOW,
		pickUrls: () => (disagreement ? { urls: ["redis://a:1", "redis://b:2"], disagreement: "VALKEY_URL is a in this shell and b in .env" } : { urls: ["redis://127.0.0.1:6399"], disagreement: null, note: null }),
		valkeyRefusal: async () => refused,
		redisFn: () => redis,
		readLiveHostsFn: async () => ({ hosts: live }),
	};
	return { opts, out, err, redisCalls };
}

test("the human report: one block per host with busy and idle, slots, promised and used, waits and projects, then the coverage", async () => {
	const h = harness(deployment([run("a", 10, 8), run("b", 9, 7, { project: "shop" }), run("r", 2, 2, { capacity: null })]));
	assert.equal(await runCapacity(["--since", "24h"], h.opts), 0);
	const text = h.out.join("");
	assert.equal(
		text,
		[
			"Host mini1, last 24h",
			"  busy 12.5%, idle 87.5%",
			"  slots: avg 0.2 of 2, peak 2 of 2, full 4.2% of the time",
			"  promised: memory 4.2% of the 16g budget, CPU 4.2% of the 8 CPU budget",
			"  CPU used: 2.1% of the host's 8 CPUs",
			"  wait for a slot: p50 40s, p95 40s (2 runs)",
			"  projects by run time: shop 2h, web 2h",
			"  1 job refused before a slot",
			"  history from this host's files",
			"Coverage: history: this host's files only; no run mirror: only this host's files were read.",
			"Jobs only: a machine busy with other work reads as idle.",
			"",
		].join("\n"),
	);
	assert.deepEqual(h.redisCalls.at(-1), "disconnect", "the client is closed");
});

test("--json prints the report itself; --host keeps one host and refuses a name it never saw", async () => {
	const live = [{ name: "other", routes: "false", concurrency: "4" }];
	const h = harness(deployment([run("a", 3, 2)]), { live });
	assert.equal(await runCapacity(["--json", "--since", "7d"], h.opts), 0);
	const report = JSON.parse(h.out.join(""));
	assert.equal(report.v, 1);
	assert.equal(report.window.toMs - report.window.fromMs, 7 * 24 * H);
	assert.deepEqual(report.hosts.map((x) => x.name), ["mini1", "other"]);
	assert.deepEqual(report.coverage.historyNotShared, ["other"], "an unnamed peer's runs are not here, and the report says so");

	const one = harness(deployment([run("a", 3, 2)]), { live });
	assert.equal(await runCapacity(["--json", "--host", "mini1"], one.opts), 0);
	assert.deepEqual(JSON.parse(one.out.join("")).hosts.map((x) => x.name), ["mini1"]);

	const missing = harness(deployment([run("a", 3, 2)]));
	assert.equal(await runCapacity(["--host", "nope"], missing.opts), 1);
	assert.match(missing.err.join(""), /no host named "nope" in the last 7d \(hosts: mini1\)/);
});

test("a host whose history is not shared says so rather than reading idle", async () => {
	const h = harness(deployment([]), { live: [{ name: "far", routes: "false" }] });
	assert.equal(await runCapacity([], h.opts), 0);
	assert.match(h.out.join(""), /Host far, last 7d\n {2}no history here: no source here holds its runs \(a worker without PI_WORKER_NAME/);
	assert.match(h.out.join(""), /not shared here: far/);
});

test("refusals: a window it does not offer, an unknown flag, and two Valkeys it cannot choose between", async () => {
	const dir = deployment([]);
	const bad = harness(dir);
	assert.equal(await runCapacity(["--since", "2d"], bad.opts), 1);
	assert.match(bad.err.join(""), /--since takes 24h, 7d, 30d \(got "2d"\)/);
	const flag = harness(dir);
	assert.equal(await runCapacity(["--fix"], flag.opts), 1);
	assert.match(flag.err.join(""), /usage: pi-dispatch capacity/);
	const two = harness(dir, { disagreement: true });
	assert.equal(await runCapacity([], two.opts), 1);
	assert.match(two.err.join(""), /Say which: pi-dispatch capacity --valkey-url <url>/);
	const retention = harness(dir);
	retention.opts.env = { ...retention.opts.env, PI_LOG_RETENTION_DAYS: "soon" };
	assert.equal(await runCapacity([], retention.opts), 1);
	const problem = harness(dir);
	assert.equal(await runCapacity([], { ...problem.opts, deploymentEnv: () => ({ problem: "PI_LOGS_DIR disagrees" }) }), 1);
	assert.match(problem.err.join(""), /PI_LOGS_DIR disagrees/);
	assert.deepEqual(CAPACITY_ENV_KEYS, ["PI_LOGS_DIR", "PI_LOG_RETENTION_DAYS", "PI_WORKER_NAME"]);
});

test("a refused Valkey is not a failure: the local files are read, no client is made, and the reason is said", async () => {
	const h = harness(deployment([run("a", 3, 2)]), { refused: "WRONGPASS" });
	assert.equal(await runCapacity(["--since", "24h"], h.opts), 0);
	assert.deepEqual(h.redisCalls, [], "no client against a Valkey that refused");
	assert.match(h.out.join(""), /Valkey at redis:\/\/127\.0\.0\.1:6399 refused \(WRONGPASS\): only this host's files were read\./);
	assert.doesNotMatch(h.out.join(""), /no run mirror|host registry unreadable/, "the reason it was not read, once, and not a second wrong one");
	assert.match(h.out.join(""), /busy 4\.2%/);
});

test("the CLI dispatches capacity and lists it in its usage", async () => {
	const { main } = await import("../src/cli.mjs");
	const out = [];
	const errs = [];
	const origErr = process.stderr.write;
	process.stderr.write = (c) => (errs.push(String(c)), true);
	try {
		assert.equal(await main(["capacity", "--since", "1y"], { PI_LOGS_DIR: tempDir("pi-cap-cli-") }, { write: (c) => out.push(c) }), 1);
	} finally {
		process.stderr.write = origErr;
	}
	assert.match(errs.join(""), /--since takes 24h, 7d, 30d/);
	await main(["--help"], {}, { write: (c) => out.push(c) });
	assert.match(out.join(""), /pi-dispatch capacity \[--since 24h\|7d\|30d\] \[--host <name>\] \[--json\] \[--valkey-url <url>\]/);
});

test("the words: durations in their largest units, per-mille as a percentage, thousandths with one decimal", () => {
	assert.deepEqual([0, 40_000, 6 * 60_000, 2 * H + 5 * 60_000, 3 * H, 3 * 24 * H + 4 * H, 2 * 24 * H].map(durationText), ["0s", "40s", "6m", "2h 5m", "3h", "3d 4h", "2d"]);
	assert.deepEqual([0, 5, 125, 1000, 1234].map(percentText), ["0%", "0.5%", "12.5%", "100%", "123.4%"]);
	assert.deepEqual([0, 49, 50, 2149, 2150, 2000].map(milliText), ["0", "0", "0.1", "2.1", "2.2", "2"]);
	const empty = capacityText({ hosts: [], window: { fromMs: 0, toMs: 1 }, coverage: { source: "local", fromMs: 0, historyNotShared: [], unreadable: 0, withoutHost: 0, running: null, reason: null } }, { since: "24h" });
	assert.match(empty, /^No host ran a job in the last 24h\./);
});

test("a Valkey the operator NAMED that refuses or does not answer is a failure, never a local-only report", async () => {
	const dir = deployment([run("a", 3, 2)]);
	const refused = harness(dir, { refused: "WRONGPASS" });
	assert.equal(await runCapacity(["--valkey-url", "redis://127.0.0.1:6399"], refused.opts), 1);
	assert.match(refused.err.join(""), /Valkey at redis:\/\/127\.0\.0\.1:6399 refused: WRONGPASS/);
	assert.deepEqual(refused.out, []);
	const down = harness(dir);
	down.opts.redisFn = () => ({ zcard: () => Promise.reject(new Error("ECONNREFUSED")), on: () => {}, disconnect: () => {} });
	down.opts.readLiveHostsFn = async () => ({ hosts: [] });
	assert.equal(await runCapacity(["--valkey-url", "redis://127.0.0.1:6399"], down.opts), 1);
	assert.match(down.err.join(""), /could not read Valkey at redis:\/\/127\.0\.0\.1:6399: run mirror unreachable \(ECONNREFUSED\)/);
	// The same Valkey from the environment: a report from this host's files, with the reason.
	const envDown = harness(dir);
	envDown.opts.redisFn = down.opts.redisFn;
	assert.equal(await runCapacity([], envDown.opts), 0);
	assert.match(envDown.out.join(""), /run mirror unreachable \(ECONNREFUSED\): only this host's files were read/);
});

test("the registry is read without pruning, and per host lines carry that host's own counts", async () => {
	const h = harness(deployment([run("a", 3, 2, { attempt: 2 }), { ...run("old", 5, 4), capacity: undefined }]));
	let asked = null;
	h.opts.readLiveHostsFn = async (_redis, opts) => ((asked = opts), { hosts: [] });
	assert.equal(await runCapacity(["--since", "24h"], h.opts), 0);
	assert.equal(asked.prune, false, "a report writes nothing, not even the registry's tidying");
	assert.match(h.out.join(""), /1 retried run: 0 earlier attempts counted from the records the retries kept; an attempt whose record was not kept is not counted, so busy time can be under-counted/);
});

test("control characters never reach the terminal, whatever a report holds", () => {
	const report = { hosts: [], window: { fromMs: 0, toMs: 1 }, coverage: { source: "local", fromMs: 0, historyNotShared: ["x\u001b[2J\u009b"], unreadable: 0, withoutHost: 0, running: null, reason: "r\u0007" } };
	const text = capacityText(report, { since: "24h" });
	assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	assert.match(text, /not shared here: x\[2J/);
});

test("--host keeps that host's coverage in --json too: its start, its cut and its counts", async () => {
	const live = [{ name: "other", routes: "false", concurrency: "4" }];
	const h = harness(deployment([run("a", 3, 2), run("b", 3, 2, { host: "peer" }), run("c", 2, 1, { host: "peer", stalledRepick: true })]), { live });
	assert.equal(await runCapacity(["--json", "--host", "peer"], h.opts), 0);
	const report = JSON.parse(h.out.join(""));
	assert.deepEqual(report.hosts.map((x) => x.name), ["peer"]);
	assert.deepEqual([report.coverage.used, report.coverage.stalledRepick, report.coverage.historyNotShared], [2, 1, []]);
	assert.equal(report.coverage.fromMs, report.hosts[0].coverage.fromMs);
	const text = harness(deployment([run("c", 2, 1, { stalledRepick: true })]));
	assert.equal(await runCapacity([], text.opts), 0);
	assert.match(text.out.join(""), /1 run was picked up again after a stall: the first pickup's time is not counted/);
});
