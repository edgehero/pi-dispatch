import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { weekKey } from "../src/budget.mjs";
import { parseEnvelope, envelopeDigest } from "../src/envelope.mjs";
import { buildPortfolioSnapshot } from "../src/portfolio-snapshot.mjs";
import { PLAN_FIELDS, allocate, neutralAllocation, parsePlan } from "../src/priorities.mjs";
import { scopeDollarKeyPrefix } from "../src/scoped-limits.mjs";
import { PLAN_FIELDS as REPORT_PLAN_FIELDS, main } from "../../examples/portfolio-manager/.pi/skills/portfolio-manager/report.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The example's report script (issue #506). It lives in examples/, which no workspace's `npm test` globs, so it is
// tested from here. Every date it prints comes from an injected clock, and the snapshot it reads is built by the
// worker's own builder, so a change to the snapshot's shape reaches this file.

const SCRIPT = fileURLToPath(new URL("../../examples/portfolio-manager/.pi/skills/portfolio-manager/report.mjs", import.meta.url));
const USD = 1_000_000;
const NOW = new Date("2026-10-12T06:00:05.000Z");
const RAN = new Date("2026-10-12T06:03:00.000Z");
const PROJECTS = [
	{ id: "shop", members: ["github:acme/shop"] },
	{ id: "platform", members: ["github:acme/platform"] },
	{ id: "ops", members: ["/home/me/pm"] },
];
const ENVELOPE = parseEnvelope(
	JSON.stringify({ version: 1, window: "week", totalUsd: 100, floorsUsd: { shop: 10, platform: 10, ops: 5, _other: 0 }, defaultWeights: { shop: 1, platform: 1, ops: 1, _other: 1 }, delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }),
	"/e/envelope.json",
	{ projects: PROJECTS, maxCostMicros: 2 * USD },
);
const FIXTURE = parsePlan(readFileSync(new URL("../../examples/portfolio-manager/plan.fixture.json", import.meta.url), "utf8"), { envelope: ENVELOPE, projects: PROJECTS, now: NOW });

/** The applied state after last week's fixture plan: the allocator's own numbers. */
function appliedState() {
	const neutral = neutralAllocation(ENVELOPE);
	const weights = Object.fromEntries(FIXTURE.plan.projects.map((p) => [p.id, p.weight]));
	const out = allocate({ envelope: ENVELOPE, weights, current: { allocations: neutral.allocations, unallocated: 0 } });
	return { planId: FIXTURE.id, writer: "portfolio-job", appliedAt: "2026-10-05T06:01:10.000Z", validUntil: "2026-10-13T12:00:00.000Z", lastPlanAt: "2026-10-05T06:01:10.000Z", clamped: out.clamped, weights, allocations: out.allocations, unallocated: out.unallocated, repoWeights: {}, repos: {} };
}

const week = (scope) => weekKey(NOW, scopeDollarKeyPrefix(scope));
const SPEND = { [week("project:shop")]: "12345678", [week("project:platform")]: "4000000", [week("project:ops")]: "1995000" };
const fakeRedis = (values) => ({ mget: async (...keys) => keys.map((k) => values[k] ?? null) });

async function snapshot(lastAttempt = { at: "2026-10-05T06:01:10.000Z", outcome: "applied", reason: null, planId: FIXTURE.id, writer: "portfolio-job", triggerId: "pm-weekly" }) {
	return buildPortfolioSnapshot({ envelope: ENVELOPE, digest: envelopeDigest(ENVELOPE), projects: PROJECTS, allocation: { state: appliedState(), lastAttempt }, redis: fakeRedis(SPEND), runs: { records: [], complete: false }, now: NOW });
}

/**
 * This week's plan, with reasons an agent could write: a pipe, a backtick, a mention, a link, Slack's `<!here>` and
 * `<url|text>`, a right-to-left override, a bell and a line separator.
 */
const PLAN = {
	version: 1,
	basis: "0000000000000000",
	validUntil: "2026-10-19T12:00:00Z",
	projects: [
		{ id: "_other", weight: 0, reason: "Nothing\u2028planned.\u0007" },
		{ id: "ops", weight: 1, reason: "Keep the manager | running." },
		{ id: "platform", weight: 5, reason: "Build `runners` are on fire, ping @octocat <!here>." },
		{ id: "shop", weight: 2, reason: "Checkout due 2026-10-30\u202e, see [x](https://evil.example) <https://evil.example|docs>." },
	],
};

/** A folder holding the snapshot, the plan and priorities.md, and the argv that names them. */
function files({ snap, plan = PLAN, front = "", noPlan = false } = {}) {
	const dir = tempDir("pm-report-");
	if (snap !== undefined) writeFileSync(join(dir, "portfolio.json"), JSON.stringify(snap, null, 2));
	if (!noPlan) writeFileSync(join(dir, "priorities.json"), typeof plan === "string" ? plan : JSON.stringify(plan, null, 2));
	writeFileSync(join(dir, "priorities.md"), `${front}# Priorities\n`);
	return { dir, argv: ["--snapshot", join(dir, "portfolio.json"), "--plan", join(dir, "priorities.json"), "--priorities", join(dir, "priorities.md")] };
}

/** Run main with captured output. */
async function run(argv, io = {}) {
	let out = "";
	const code = await main(argv, { env: {}, now: () => RAN, out: (s) => (out += s), ...io });
	return { code, out };
}

// The whole report, byte for byte. The reasons are agent text: each sits in a code span, a backtick became a quote
// and a pipe is escaped, so a reason can neither mention anyone, link, nor break the table.
const EXPECTED = `Last plan: applied

In force: plan ${FIXTURE.id} from portfolio-job, since 2026-10-05T06:01:10.000Z, until 2026-10-13T12:00:00.000Z.

## Requested this week

The host judges this request after the job ends. The next report says what it met.

| Project | Weight | Reason |
|---|---:|---|
| \`_other\` | 0 | \`Nothing planned.\` |
| \`ops\` | 1 | \`Keep the manager \\| running.\` |
| \`platform\` | 5 | \`Build 'runners' are on fire, ping @octocat \u2039!here\u203a.\` |
| \`shop\` | 2 | \`Checkout due 2026-10-30 , see [x](https://evil.example) \u2039https://evil.example\\|docs\u203a.\` |

## Spend so far (week from 2026-10-12)

| Project | Spent | Share | Floor |
|---|---:|---:|---:|
| _other | $0.00 | $0.00 | $0.00 |
| ops | $2.00 | $17.50 | $5.00 |
| platform | $4.00 | $35.00 | $10.00 |
| shop | $12.35 | $47.50 | $10.00 |

Total spent $18.34 of $100.00.
Run counts in the snapshot cover this host only.

Written 2026-10-12T06:03:00.000Z by the portfolio-manager flow.
`;

test("--dry-run prints the report byte for byte and posts nothing (#506)", async () => {
	const { argv } = files({ snap: await snapshot() });
	let posted = false;
	const { code, out } = await run([...argv, "--dry-run"], { env: { REPORT_WEBHOOK_URL: "https://hooks.example/x" }, fetch: async () => (posted = true) });
	assert.equal(code, 0);
	assert.equal(posted, false);
	assert.equal(out, EXPECTED);
});

test("the report says requested, never applied, below its first line (#506)", async () => {
	const { argv } = files({ snap: await snapshot() });
	const { out } = await run([...argv, "--dry-run"]);
	const [first, ...rest] = out.split("\n");
	assert.equal(first, "Last plan: applied");
	assert.ok(out.includes("## Requested this week"));
	for (const line of rest) assert.doesNotMatch(line, /applied/i, line);
});

test("a refused last attempt prints its reason, and a plan-invalid one its field and rule (#506)", async () => {
	const at = "2026-10-05T06:01:10.000Z";
	const tooSoon = files({ snap: await snapshot({ at, outcome: "refused", reason: "plan-too-soon", planId: "1111111111111111" }) });
	assert.equal((await run([...tooSoon.argv, "--dry-run"])).out.split("\n")[0], "Last plan: refused (plan-too-soon)");
	const invalid = files({ snap: await snapshot({ at, outcome: "refused", reason: "plan-invalid", field: "projects.weight", rule: "range", planId: null }) });
	assert.equal((await run([...invalid.argv, "--dry-run"])).out.split("\n")[0], "Last plan: refused (plan-invalid: projects.weight range)");
	const none = files({ snap: await snapshot(null) });
	assert.equal((await run([...none.argv, "--dry-run"])).out.split("\n")[0], "Last plan: none yet");
});

test("no snapshot: the report says so, and a missing or broken plan is named (#506)", async () => {
	const missing = files({ noPlan: true });
	const { out } = await run([...missing.argv, "--dry-run"]);
	assert.equal(out.split("\n")[0], "Last plan: unknown (no snapshot: is run.portfolio set?)");
	assert.ok(out.includes("Nothing requested: no plan file was written."));
	const broken = files({ snap: await snapshot(), plan: "{ not json" });
	assert.ok((await run([...broken.argv, "--dry-run"])).out.includes("Nothing requested: the plan file is not valid JSON."));
});

test("the clock is injected: the written line follows it (#506)", async () => {
	const { argv } = files({ snap: await snapshot() });
	const later = new Date("2027-01-04T06:00:00.000Z");
	const { out } = await run([...argv, "--dry-run"], { now: () => later });
	assert.ok(out.includes(`Written ${later.toISOString()} by the portfolio-manager flow.`));
});

test("no channel configured: report-not-sent: no-channel, and the process exits 0 (#506)", async () => {
	const { argv } = files({ snap: await snapshot() });
	const child = spawnSync(process.execPath, [SCRIPT, ...argv], { env: { PATH: process.env.PATH }, encoding: "utf8" });
	assert.equal(child.status, 0);
	assert.match(child.stdout, /\nreport-not-sent: no-channel\n$/);
	assert.equal(child.stderr, "");
});

/** A loopback webhook that answers `status` and records each request. */
async function webhook(status) {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			requests.push({ method: req.method, url: req.url, type: req.headers["content-type"], body });
			res.writeHead(status).end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { requests, url: `http://127.0.0.1:${server.address().port}/hook/T0`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a webhook gets one POST of { text } with the report (#506)", async () => {
	const hook = await webhook(200);
	try {
		const { argv } = files({ snap: await snapshot() });
		const { code, out } = await run(argv, { env: { REPORT_WEBHOOK_URL: hook.url } });
		assert.equal(code, 0);
		assert.equal(hook.requests.length, 1);
		const [req] = hook.requests;
		assert.equal(req.method, "POST");
		assert.equal(req.url, "/hook/T0");
		assert.equal(req.type, "application/json");
		assert.deepEqual(JSON.parse(req.body), { text: out.slice(0, out.lastIndexOf("report-sent")) });
		assert.ok(out.endsWith("\nreport-sent: webhook\n"));
	} finally {
		await hook.close();
	}
});

test("a failed post prints report-not-sent with a token, never the URL, and still exits 0 (#506)", async () => {
	const hook = await webhook(500);
	try {
		const { argv } = files({ snap: await snapshot() });
		const { code, out } = await run(argv, { env: { REPORT_WEBHOOK_URL: hook.url } });
		assert.equal(code, 0);
		assert.ok(out.endsWith("\nreport-not-sent: webhook-status-500\n"));
		assert.ok(!out.includes(hook.url));
	} finally {
		await hook.close();
	}
	const { argv } = files({ snap: await snapshot() });
	const thrown = await run(argv, { env: { REPORT_WEBHOOK_URL: "https://hooks.example/x" }, fetch: async () => { throw new TypeError("fetch failed"); } });
	assert.equal(thrown.code, 0);
	assert.ok(thrown.out.endsWith("\nreport-not-sent: webhook-error\n"));
});

/** A `gh` on PATH that records its argv, its GH_TOKEN and its stdin, and exits `code`. */
function ghStub(code) {
	const dir = tempDir("pm-gh-");
	const gh = join(dir, "gh");
	writeFileSync(gh, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/argv"\nprintf '%s' "$GH_TOKEN" > "${dir}/token"\ncat > "${dir}/stdin"\nexit ${code}\n`);
	chmodSync(gh, 0o755);
	return { dir, PATH: `${dir}:/usr/bin:/bin`, read: (name) => readFileSync(join(dir, name), "utf8") };
}

test("the GitHub channel runs exactly gh issue comment <n> --repo <r> --body-file -, with the report token (#506)", async () => {
	const stub = ghStub(0);
	const { argv } = files({ snap: await snapshot(), front: "---\nreport-repo: acme/ops\nreport-issue: 7\n---\n" });
	const { code, out } = await run(argv, { env: { PATH: stub.PATH, REPORT_GH_TOKEN: "github_pat_lab", REPORT_WEBHOOK_URL: "https://hooks.example/x" }, spawn });
	assert.equal(code, 0);
	assert.deepEqual(stub.read("argv").split("\n").slice(0, -1), ["issue", "comment", "7", "--repo", "acme/ops", "--body-file", "-"]);
	assert.equal(stub.read("token"), "github_pat_lab");
	assert.equal(stub.read("stdin"), out.slice(0, out.lastIndexOf("report-sent")));
	assert.ok(out.endsWith("\nreport-sent: github\n"), "GitHub comes first when both are set");
});

test("gh failing, or a half-set repo, is report-not-sent and exit 0 (#506)", async () => {
	const stub = ghStub(1);
	const front = "---\nreport-repo: acme/ops\nreport-issue: 7\n---\n";
	const failed = await run(files({ snap: await snapshot(), front }).argv, { env: { PATH: stub.PATH, REPORT_GH_TOKEN: "t" }, spawn });
	assert.equal(failed.code, 0);
	assert.ok(failed.out.endsWith("\nreport-not-sent: gh-exit-1\n"));
	const half = await run(files({ snap: await snapshot(), front: "---\nreport-repo: acme/ops\n---\n" }).argv, { env: { PATH: stub.PATH, REPORT_GH_TOKEN: "t" }, spawn });
	assert.equal(half.code, 0);
	assert.ok(half.out.endsWith("\nreport-not-sent: report-repo-invalid\n"));
});

test("the report's copy of PLAN_FIELDS is the worker's list, and a refusal naming validUntil prints it (#506 review)", async () => {
	assert.deepEqual([...REPORT_PLAN_FIELDS], [...PLAN_FIELDS]);
	const snap = await snapshot({ at: "2026-10-05T06:01:10.000Z", outcome: "refused", reason: "plan-invalid", field: "validUntil", rule: "past", planId: null });
	assert.equal(snap.lastAttempt.field, "validUntil");
	assert.equal((await run([...files({ snap }).argv, "--dry-run"])).out.split("\n")[0], "Last plan: refused (plan-invalid: validUntil past)");
	// A snapshot written by hand, or by a newer build, with text where a token belongs: the token rule prints `?`.
	const odd = { ...snap, lastAttempt: { outcome: "refused", reason: "<!here> read the issue", field: "projects|x", rule: "Range" } };
	assert.equal((await run([...files({ snap: odd }).argv, "--dry-run"])).out.split("\n")[0], "Last plan: refused (?: ? ?)");
	const noField = { ...snap, lastAttempt: { outcome: "refused", reason: "Plan Too Soon" } };
	assert.equal((await run([...files({ snap: noField }).argv, "--dry-run"])).out.split("\n")[0], "Last plan: refused (?)");
});

test("a snapshot that exists but cannot be used says why, not that run.portfolio is unset (#506 review)", async () => {
	const broken = files({});
	writeFileSync(broken.argv[1], "{ not json");
	const out = (await run([...broken.argv, "--dry-run"])).out;
	assert.equal(out.split("\n")[0], "Last plan: unknown (the snapshot is not valid JSON)");
	assert.ok(out.includes("Unknown: the snapshot is not valid JSON."));
	const denied = files({ snap: await snapshot() });
	const readFile = (path, enc) => {
		if (path === denied.argv[1]) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		return readFileSync(path, enc);
	};
	assert.equal((await run([...denied.argv, "--dry-run"], { readFile })).out.split("\n")[0], "Last plan: unknown (the snapshot is unreadable)");
});

test("spend rows: a member with a share gets its own row, its label gated; a project id that is no id prints ? (#506 review)", async () => {
	const snap = await snapshot();
	const shop = snap.projects.find((p) => p.id === "shop");
	shop.members = [{ ref: "abcd1234", label: "github:acme/shop <!here>|x\u202e", weight: 2, allocationMicros: 30_000_000, spentMicros: 5_000_000 }, { ref: "ffff0000", label: "local:other" }];
	snap.projects.push({ id: "Evil | row\n", floorMicros: 0, allocationMicros: 0, spentMicros: 0, members: [] });
	const { out } = await run([...files({ snap }).argv, "--dry-run"]);
	assert.ok(out.includes("| shop | $12.35 | $47.50 | $10.00 |\n| shop `github:acme/shop \u2039!here\u203a\\|x` | $5.00 | $30.00 | |\n| ? | $0.00 | $0.00 | $0.00 |\n"), out);
	assert.ok(!out.includes("local:other"), "a member with no repo weight has no row");
	assert.ok(!out.includes("Evil"));
});

test("an http webhook is refused unless it is this machine, and a redirect is not followed (#506 review)", async () => {
	const { argv } = files({ snap: await snapshot() });
	let called = 0;
	const fetch = async () => {
		called += 1;
		return new Response(null, { status: 200 });
	};
	for (const url of ["http://hooks.example/x", "http://10.0.0.5/x", "http://localhost.evil.com/x", "http://127.0.0.1.nip.io/x", "ftp://hooks.example/x", "not a url"]) {
		const { code, out } = await run(argv, { env: { REPORT_WEBHOOK_URL: url }, fetch });
		assert.equal(code, 0);
		assert.ok(out.endsWith("\nreport-not-sent: webhook-url-invalid\n"), url);
	}
	assert.equal(called, 0);
	for (const url of ["https://hooks.example/x", "http://localhost:9/x", "http://[::1]:9/x"]) {
		assert.ok((await run(argv, { env: { REPORT_WEBHOOK_URL: url }, fetch })).out.endsWith("\nreport-sent: webhook\n"), url);
	}
	const target = await webhook(200);
	const redirect = createServer((req, res) => req.resume().on("end", () => res.writeHead(307, { location: target.url }).end()));
	await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
	try {
		const { code, out } = await run(argv, { env: { REPORT_WEBHOOK_URL: `http://127.0.0.1:${redirect.address().port}/hook` } });
		assert.equal(code, 0);
		assert.ok(out.endsWith("\nreport-not-sent: webhook-error\n"));
		assert.equal(target.requests.length, 0, "the redirect target got nothing");
	} finally {
		await new Promise((resolve) => redirect.close(resolve));
		await target.close();
	}
});

test("a webhook that never answers, and a gh that never ends, time out: report-not-sent and exit 0 (#506 review)", async () => {
	const sockets = new Set();
	const hung = createServer(() => {});
	hung.on("connection", (s) => sockets.add(s));
	await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
	try {
		const { argv } = files({ snap: await snapshot() });
		const { code, out } = await run(argv, { env: { REPORT_WEBHOOK_URL: `http://127.0.0.1:${hung.address().port}/hook` }, timeoutMs: 200 });
		assert.equal(code, 0);
		assert.ok(out.endsWith("\nreport-not-sent: webhook-timeout\n"), out.slice(-60));
	} finally {
		for (const s of sockets) s.destroy();
		await new Promise((resolve) => hung.close(resolve));
	}
	const dir = tempDir("pm-gh-hang-");
	writeFileSync(join(dir, "gh"), "#!/bin/sh\nexec sleep 30\n");
	chmodSync(join(dir, "gh"), 0o755);
	const started = Date.now();
	const { code, out } = await run(files({ snap: await snapshot(), front: "---\nreport-repo: acme/ops\nreport-issue: 7\n---\n" }).argv, { env: { PATH: `${dir}:/usr/bin:/bin`, REPORT_GH_TOKEN: "t" }, spawn, timeoutMs: 300 });
	assert.equal(code, 0);
	assert.ok(out.endsWith("\nreport-not-sent: gh-timeout\n"));
	assert.ok(Date.now() - started < 10_000, "the stub was killed, not waited for");
});

test("anything that throws inside the script still exits 0 (#506 review)", async () => {
	const { argv } = files({ snap: await snapshot() });
	const thrown = await run([...argv, "--dry-run"], { now: () => { throw new Error("clock"); } });
	assert.equal(thrown.code, 0);
	assert.equal(thrown.out, "report-not-sent: report-error\n");
	const code = await main([...argv, "--dry-run"], { env: {}, now: () => RAN, out: () => { throw new Error("EPIPE"); } });
	assert.equal(code, 0);
});

test("a report repo must start with a letter or a digit on both sides, so gh never reads it as an option (#506 review)", async () => {
	const stub = ghStub(0);
	for (const repo of ["-R/x", "acme/-x", "--repo=evil/x", "acme", "acme/ops/extra", "acme /ops"]) {
		const { code, out } = await run(files({ snap: await snapshot(), front: `---\nreport-repo: ${repo}\nreport-issue: 7\n---\n` }).argv, { env: { PATH: stub.PATH, REPORT_GH_TOKEN: "t" }, spawn });
		assert.equal(code, 0);
		assert.ok(out.endsWith("\nreport-not-sent: report-repo-invalid\n"), repo);
	}
	for (const issue of ["0", "-1", "7x", "--body-file"]) {
		const { out } = await run(files({ snap: await snapshot(), front: `---\nreport-repo: acme/ops\nreport-issue: ${issue}\n---\n` }).argv, { env: { PATH: stub.PATH, REPORT_GH_TOKEN: "t" }, spawn });
		assert.ok(out.endsWith("\nreport-not-sent: report-repo-invalid\n"), issue);
	}
	const ok = await run(files({ snap: await snapshot(), front: "---\nreport-repo: acme-co/ops.web_1\nreport-issue: 7\n---\n" }).argv, { env: { PATH: stub.PATH, REPORT_GH_TOKEN: "t" }, spawn });
	assert.ok(ok.out.endsWith("\nreport-sent: github\n"));
});

test("what gh prints never reaches the job: its stdout and stderr are discarded (#506 review)", async () => {
	const dir = tempDir("pm-gh-loud-");
	writeFileSync(join(dir, "gh"), "#!/bin/sh\ncat > /dev/null\necho GH-STDOUT-MARKER\necho GH-STDERR-MARKER >&2\nexit 0\n");
	chmodSync(join(dir, "gh"), 0o755);
	const { argv } = files({ snap: await snapshot(), front: "---\nreport-repo: acme/ops\nreport-issue: 7\n---\n" });
	const child = spawnSync(process.execPath, [SCRIPT, ...argv], { env: { PATH: `${dir}:${process.env.PATH}`, REPORT_GH_TOKEN: "t" }, encoding: "utf8" });
	assert.equal(child.status, 0);
	assert.match(child.stdout, /\nreport-sent: github\n$/);
	assert.ok(!child.stdout.includes("MARKER") && !child.stderr.includes("MARKER"), "gh output reached the job");
});
