import assert from "node:assert/strict";
import { test } from "node:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPACITY_ENV_KEYS, capacityText, durationText, historySourceText, milliText, percentText, runCapacity } from "../src/capacity-cli.mjs";
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
	const redis = { eval: async () => (redisCalls.push("eval"), [0]), on: () => {}, disconnect: () => redisCalls.push("disconnect") };
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
			"Coverage: history: this host's files only; no live row lists the jobs running now, so they are not known; no run mirror: only this host's files were read.",
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
});

test("an empty report says no host ran a job only when the whole fleet's history was read", () => {
	const cov = { source: "mirror+local", fromMs: 0, truncated: false, historyNotShared: [], unreadable: 0, withoutHost: 0, running: 0, reason: null };
	const said = (c) => capacityText({ hosts: [], window: { fromMs: 0, toMs: 1 }, coverage: { ...cov, ...c } }, { since: "24h" }).split("\n")[0];
	assert.equal(said({}), "No host ran a job in the last 24h.");
	// This host's files alone, a source not read, or a cut history: a host whose runs were not read may have run many.
	assert.equal(said({ source: "local" }), "No run in the history read here in the last 24h.");
	assert.equal(said({ reason: "run mirror unreachable (timeout): only this host's files were read" }), "No run in the history read here in the last 24h.");
	assert.equal(said({ truncated: true }), "No run in the history read here in the last 24h.");
	// Records the report could not put on a host: someone ran something.
	assert.equal(said({ withoutHost: 1 }), "No run in the history read here in the last 24h.");
	assert.equal(said({ unreadable: 2 }), "No run in the history read here in the last 24h.");
});

test("the coverage line says when the fleet's history is cut, and when the jobs running now are not known", async () => {
	const base = { source: "mirror", fromMs: 0, truncated: false, historyNotShared: [], unreadable: 0, withoutHost: 0, liveUnreadable: 0, liveNotCounted: 0, running: 0, liveRowMissing: null, reason: null };
	const line = (c) => capacityText({ hosts: [], window: { fromMs: 0, toMs: 1 }, coverage: { ...base, ...c } }, { since: "7d" }).split("\n")[1];
	assert.equal(line({}), "Coverage: history: the run mirror.");
	assert.equal(line({ truncated: true }), "Coverage: history: the run mirror; history truncated: the run mirror holds nothing older for at least one host, so its earlier time is counted as neither busy nor idle.");
	// This host's row gone while a peer's says it runs 2: the peers' count stands, and only this host's is not known.
	assert.equal(line({ running: 2, liveRowMissing: "mini1" }), "Coverage: history: the run mirror; 2 jobs running now, counted up to now; no live row read for this host (mini1), so the jobs it runs now are not known.");
	assert.equal(line({ running: null }), "Coverage: history: the run mirror; no live row lists the jobs running now, so they are not known.");
	assert.equal(line({ running: null, liveRowMissing: "mini1" }), "Coverage: history: the run mirror; no live row lists the jobs running now, so they are not known.", "said once");

	// Through the command: this host's row gone (until its next beat) while its runs are here.
	const gone = harness(deployment([run("a", 3, 2)]), { live: [{ name: "peer", routes: "true", jobs: "[]", jobsMore: "0" }] });
	assert.equal(await runCapacity(["--json"], gone.opts), 0);
	const report = JSON.parse(gone.out.join(""));
	assert.deepEqual([report.coverage.liveRowMissing, report.coverage.running], ["mini1", 0], "the peer's count stands");
	// Its row back: nothing to say.
	const back = harness(deployment([run("a", 3, 2)]), { live: [{ name: "mini1", routes: "true", jobs: "[]", jobsMore: "0" }] });
	assert.equal(await runCapacity([], back.opts), 0);
	assert.doesNotMatch(back.out.join(""), /not known/);
});

test("a Valkey the operator NAMED that refuses or does not answer is a failure, never a local-only report", async () => {
	const dir = deployment([run("a", 3, 2)]);
	const refused = harness(dir, { refused: "WRONGPASS" });
	assert.equal(await runCapacity(["--valkey-url", "redis://127.0.0.1:6399"], refused.opts), 1);
	assert.match(refused.err.join(""), /Valkey at redis:\/\/127\.0\.0\.1:6399 refused: WRONGPASS/);
	assert.deepEqual(refused.out, []);
	const down = harness(dir);
	down.opts.redisFn = () => ({ eval: () => Promise.reject(new Error("ECONNREFUSED")), on: () => {}, disconnect: () => {} });
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
	assert.match(h.out.join(""), /1 retried run: its earlier attempts are counted on the host that ran them, where that host's history is here and covers them; an attempt whose record was not kept is not counted, so busy time can be under-counted/);
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

test("a host's history source in words: both sources are named when both hold it, and none says `only`", () => {
	assert.deepEqual(["local", "mirror", "mirror+local", "records"].map(historySourceText), ["this host's files", "the run mirror", "the run mirror and this host's files", "the run records"]);
});

test("a retry whose earlier attempt ran on another host: each host's sentence is true of it", async () => {
	const { computeCapacity } = await import("../src/capacity.mjs");
	const { hostCaveats } = await import("../src/capacity-cli.mjs");
	const NOW = Date.parse("2026-10-08T12:00:00.000Z");
	const H = 3_600_000;
	const iso = (ms) => new Date(ms).toISOString();
	const cap = { slots: 2, memMiB: 8192, cpuCenti: 400, cpus: 4 };
	const retry = { jobId: "r", host: "b", project: "web", startedAt: iso(NOW - 2 * H), endedAt: iso(NOW - H), queuedAt: null, attempt: 2, capacity: cap, earlier: [{ host: "a", startedAt: iso(NOW - 4 * H), endedAt: iso(NOW - 3 * H), memMiB: 1024, cpuCenti: 100 }] };
	const r = computeCapacity({ records: [retry], windowStartMs: NOW - 24 * H, nowMs: NOW, bucketMs: H });
	const by = Object.fromEntries(r.hosts.map((h) => [h.name, hostCaveats(h.coverage)]));
	assert.deepEqual(by.b, ["1 retried run: its earlier attempts are counted on the host that ran them, where that host's history is here and covers them; an attempt whose record was not kept is not counted, so busy time can be under-counted"]);
	assert.deepEqual(by.a, ["1 earlier attempt of a retried run counted here, from the record its retry kept"]);
	assert.ok(!capacityText(r, { since: "24h" }).includes("0 earlier attempts"));
	assert.equal(hostCaveats({ ...r.hosts[0].coverage, retried: 0, earlier: 2 }).at(-1), "2 earlier attempts of retried runs counted here, from the records their retries kept");
});

test("shareText: a share that is there but rounds to nothing says so, at both ends; otherwise percentText(share)", async () => {
	const { shareText, percentText, share } = await import("../src/capacity-cli.mjs");
	assert.equal(shareText(1, 604_800_000), "under 0.1%", "a moment full in a week is not 0%");
	assert.equal(shareText(0, 604_800_000), "0%", "nothing is 0%");
	assert.equal(shareText(604_799_999, 604_800_000), "over 99.9%", "a moment idle in a week is not 100%");
	assert.equal(shareText(604_800_000, 604_800_000), "100%");
	assert.equal(shareText(5, 0), "0%", "no whole, no share");
	for (const [p, w] of [[1, 3], [2, 3], [123_456_789, 604_800_000]]) assert.equal(shareText(p, w), percentText(share(p, w)));
});

test("busyIdleText: idle is the complement of the printed busy, so the two always sum to 100%", async () => {
	const { busyIdleText } = await import("../src/capacity-cli.mjs");
	assert.deepEqual(busyIdleText(1235, 10_000), { busy: "12.4%", idle: "87.6%" }, "123.5 per mille: rounded on its own idle read 87.7%");
	assert.deepEqual(busyIdleText(0, 10_000), { busy: "0%", idle: "100%" });
	assert.deepEqual(busyIdleText(10_000, 10_000), { busy: "100%", idle: "0%" });
	assert.deepEqual(busyIdleText(1, 604_800_000), { busy: "under 0.1%", idle: "over 99.9%" });
	assert.deepEqual(busyIdleText(604_799_999, 604_800_000), { busy: "over 99.9%", idle: "under 0.1%" });
	for (const b of [7, 333, 1235, 4999, 5000, 9876]) {
		const { busy, idle } = busyIdleText(b, 10_000);
		assert.equal(Math.round((parseFloat(busy) + parseFloat(idle)) * 10), 1000, `${busy} + ${idle}`);
	}
});
