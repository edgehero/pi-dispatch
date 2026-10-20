// Project secret bundles in the processor (issue #704): which jobs get their project's bundle, the fork check, the
// refusals and their place before every spend, the merge with run.secrets and the record. The binding is read by the
// worker's own `makeFindSecretBundle` from a real triggers file, and the bundle by the real `makeBundleResolver` from a
// real file-backed resolver script, so the seam under test is the one a deployment runs.
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { InfraRetry, SecretBundleProfileHold, runJob } from "../src/processor.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { makeBundleResolver } from "../src/secret-bundles.mjs";
import { makeFindSecretBundle } from "../src/triggers-file.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

function fakeRedis() {
	let n = 0;
	const redis = { incrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, ++n);
	redis.decr = async () => --n;
	redis.expire = async () => {};
	redis.get = async () => null;
	return redis;
}

const cron = { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/shop", flow: "f", task: "t" } };
const pr = { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "review" } };

/**
 * A deployment: a triggers file binding project `shop` to a file-backed bundle, the resolver script, and processor deps
 * that record the order of every step and what reached the container. `bundle` is the bundle's file text.
 */
function deployment({ bundle = "STRIPE_KEY=sk_live_value\nDB_URL=postgres://u:pw@db/shop\n", triggers = [cron, pr], bundles = undefined, declared = true, over = {} } = {}) {
	const dir = tempDir("pi-bundle-deploy-");
	const script = join(dir, "resolve.sh");
	writeFileSync(script, `#!/bin/sh\n[ -e "${dir}/down" ] && exit 1\n[ -e "${dir}/$1.env" ] || exit 2\nexec cat "${dir}/$1.env"\n`);
	chmodSync(script, 0o755);
	const triggersPath = join(dir, "triggers.json");
	const writeTriggers = (t, b = bundles ?? { shop: { profile: "shop-env", ref: "shop", project: "shop" } }) => writeFileSync(triggersPath, JSON.stringify({ triggers: t, secretBundles: b }));
	writeTriggers(triggers);
	const writeBundle = (text) => writeFileSync(join(dir, "shop.env"), text);
	writeBundle(bundle);
	const calls = [];
	const logs = [];
	const comments = [];
	const ran = [];
	const log = (event, fields) => logs.push({ event, fields });
	// A generous timeout: the first exec of a freshly written script can be slow on a loaded host (measured past 10 s on
	// macOS under the full suite), and these tests are about the gates, not the timeout.
	const resolver = makeBundleResolver({ envBundles: declared ? { "shop-env": { path: script, format: "dotenv" } } : {}, timeoutMs: 120_000, log });
	const redis = fakeRedis();
	const deps = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		pickupProject: "shop",
		findSecretBundle: makeFindSecretBundle({ triggersPath, log }),
		secretBundles: resolver,
		resolvePullRequestHead: async (job) => (calls.push("head"), { headRef: "b", headRepo: job.repo }),
		mintToken: async () => (calls.push("mint"), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async ({ secrets }) => (calls.push("run-container"), ran.push({ ...secrets }), { code: 0, aborted: false }),
		cleanup: async () => {},
		comment: async (_j, text) => comments.push(text),
		log,
		now: new Date("2026-07-16T10:00:00Z"),
		...over,
	};
	return { dir, deps, calls, logs, comments, ran, redis, writeBundle, writeTriggers };
}

const cronJob = { kind: "local", folder: "/srv/shop", flow: "f", task: "t", provider: "anthropic", model: "m", trigger: { id: "nightly", pattern: "0 3 * * *" } };
const prJob = { kind: "github", repo: "acme/shop", flow: "review", provider: "anthropic", model: "m", target: { type: "pull_request", number: 7 }, trigger: { deliveryId: "d1", matched: { index: 1, type: "pull_request", action: "opened" } } };
const record = (data, outcome) => buildRecord({ job: { id: "j1", data }, ...(outcome instanceof Error ? { error: outcome } : { result: outcome }), startedAt: "2026-07-16T10:00:00Z", endedAt: "2026-07-16T10:01:00Z" });

test("a project's cron and forge jobs get its bundle, and the record lists the names", async () => {
	for (const job of [cronJob, prJob]) {
		const d = deployment();
		const r = await runJob(job, d.deps);
		assert.equal(r.outcome, "completed", job.kind);
		assert.deepEqual(d.ran[0], { STRIPE_KEY: "sk_live_value", DB_URL: "postgres://u:pw@db/shop" }, job.kind);
		assert.deepEqual(record(job, r).bundle, { id: "shop", variables: ["DB_URL", "STRIPE_KEY"], shadowed: [] });
		assert.equal(record(job, r).bundleSkipped, undefined);
	}
});

test("a variable added to the file reaches the next job, and a removed one is gone, with no other edit", async () => {
	const d = deployment();
	await runJob(cronJob, d.deps);
	d.writeBundle("STRIPE_KEY=sk_live_value\nNEW_FLAG=on\n");
	await runJob(cronJob, d.deps);
	assert.deepEqual(d.ran.map((s) => Object.keys(s).sort()), [["DB_URL", "STRIPE_KEY"], ["NEW_FLAG", "STRIPE_KEY"]]);
});

test("chained, manual and opted-out jobs get no bundle, each recorded as bundleSkipped", async () => {
	const optedOut = deployment({ triggers: [{ ...cron, run: { ...cron.run, secretBundle: false } }, pr] });
	const cases = [
		// Each chain field alone marks a chained child: either one is enough, so neither can be the one that is checked.
		["chained", { ...cronJob, parentJobId: "p1" }, deployment()],
		["chained", { ...cronJob, chainDepth: 1 }, deployment()],
		["manual", { kind: "local", folder: "/srv/shop", task: "t", provider: "anthropic", model: "m" }, deployment()],
		["opted-out", cronJob, optedOut],
	];
	for (const [reason, job, d] of cases) {
		const r = await runJob(job, d.deps);
		assert.equal(r.outcome, "completed", reason);
		assert.deepEqual(d.ran[0], {}, `${reason}: no bundle variable reached the container`);
		assert.equal(r.bundleSkipped, reason);
		assert.equal(record(job, r).bundleSkipped, reason);
		assert.equal(record(job, r).bundle, undefined);
	}
});

test("a job whose project has no bundle carries neither record key", async () => {
	const d = deployment({ over: { pickupProject: "other" } });
	const r = await runJob(cronJob, d.deps);
	const rec = record(cronJob, r);
	assert.ok(!("bundle" in rec) && !("bundleSkipped" in rec));
});

test("a fork pull request runs without the bundle unless forkReviews, decided by the forge after the mint", async () => {
	const fork = deployment({ over: { resolvePullRequestHead: async () => ({ headRef: "x", headRepo: "stranger/shop" }) } });
	const r = await runJob(prJob, fork.deps);
	assert.equal(r.outcome, "completed");
	assert.equal(r.bundleSkipped, "fork");
	assert.deepEqual(fork.ran[0], {});
	const opted = deployment({ bundles: { shop: { profile: "shop-env", ref: "shop", project: "shop", forkReviews: true } }, over: { resolvePullRequestHead: async () => assert.fail("forkReviews: true needs no head read") } });
	const r2 = await runJob(prJob, opted.deps);
	assert.equal(r2.bundle.id, "shop");
	assert.equal(opted.ran[0].STRIPE_KEY, "sk_live_value");
	const same = deployment();
	await runJob(prJob, same.deps);
	assert.deepEqual(same.calls.slice(0, 3), ["mint", "head", "branch-check"], "the head is read after the mint and before branch protection");
});

test("a head read that fails retries, and nothing past it runs", async () => {
	const d = deployment({ over: { resolvePullRequestHead: async () => { throw Object.assign(new Error("boom"), { status: 502 }); } } });
	await assert.rejects(runJob(prJob, d.deps), (e) => e instanceof InfraRetry);
	assert.ok(!d.calls.includes("prepare") && !d.calls.includes("run-container"));
	assert.equal(d.redis.incrCalls, 0);
});

test("a reserved name in the bundle refuses before the clone and every reserve, naming the variable in the log only", async () => {
	const d = deployment({ bundle: "OK=1\nANTHROPIC_API_KEY=sk-ant-stolen\n" });
	const r = await runJob(cronJob, d.deps);
	assert.deepEqual([r.outcome, r.reason, r.budgetReserved], ["policy", "secret-name-reserved", false]);
	assert.ok(!d.calls.includes("prepare") && !d.calls.includes("run-container"));
	assert.equal(d.redis.incrCalls, 0, "no reservation");
	assert.deepEqual(d.logs.find((l) => l.event === "refused_secret_bundle_name_reserved").fields, { kind: "local", bundle: "shop", name: "ANTHROPIC_API_KEY" });
	assert.ok(!d.comments.join("\n").includes("ANTHROPIC_API_KEY"), "the public comment names no variable of the operator's manager");
});

test("malformed dotenv, non-string json, too many variables and too many bytes each refuse before spend", async () => {
	const bodies = ["A=1\nnot a line\n", `${Array.from({ length: 65 }, (_, i) => `V${i}=x`).join("\n")}\n`, `${Array.from({ length: 300 }, (_, i) => `V${i}=${"x".repeat(1000)}`).join("\n")}\n`];
	for (const bundle of bodies) {
		const d = deployment({ bundle });
		const r = await runJob(cronJob, d.deps);
		assert.deepEqual([r.outcome, r.reason], ["policy", "secret-unresolved"]);
		assert.ok(!d.calls.includes("prepare"));
	}
	const json = deployment();
	json.deps.secretBundles = makeBundleResolver({ envBundles: { "shop-env": { path: join(json.dir, "resolve.sh"), format: "json" } } });
	json.writeBundle('{"A":1}');
	const r = await runJob(cronJob, json.deps);
	assert.deepEqual([r.outcome, r.reason], ["policy", "secret-unresolved"]);
});

test("exit 2 refuses and is never retried, exit 1 throws so the queue retries", async () => {
	const wrong = deployment({ bundles: { shop: { profile: "shop-env", ref: "no-such-env", project: "shop" } } });
	const r = await runJob(cronJob, wrong.deps);
	assert.deepEqual([r.outcome, r.reason], ["policy", "secret-unresolved"]);
	const down = deployment();
	writeFileSync(join(down.dir, "down"), "");
	await assert.rejects(runJob(cronJob, down.deps), (e) => e instanceof InfraRetry && e.reason === "secret-resolver-unreachable");
	assert.ok(!down.calls.includes("prepare"));
});

test("the trigger's own run.secrets shadow a bundle variable, and the record names the shadowed one", async () => {
	const d = deployment({ over: { resolveSecrets: async () => ({ ok: true, secrets: { STRIPE_KEY: "sk_trigger_value" } }) } });
	const job = { ...cronJob, secrets: { STRIPE_KEY: "op://ci/stripe" } };
	const r = await runJob(job, d.deps);
	assert.equal(d.ran[0].STRIPE_KEY, "sk_trigger_value");
	assert.equal(d.ran[0].DB_URL, "postgres://u:pw@db/shop");
	assert.deepEqual(record(job, r).bundle, { id: "shop", variables: ["DB_URL", "STRIPE_KEY"], shadowed: ["STRIPE_KEY"] });
});

test("no bundle value reaches the record, a log line or a comment, on success or on refusal", async () => {
	const values = ["sk_live_value", "postgres://u:pw@db/shop"];
	const ok = deployment();
	const done = await runJob(prJob, ok.deps);
	const refused = deployment({ bundle: "STRIPE_KEY=sk_live_value\nGITHUB_TOKEN=postgres://u:pw@db/shop\n" });
	const no = await runJob(cronJob, refused.deps);
	const surfaces = JSON.stringify([record(prJob, done), record(cronJob, no), ok.logs, ok.comments, refused.logs, refused.comments]);
	for (const v of values) assert.ok(!surfaces.includes(v), v);
});

test("the free refusals come before the mint: an undeclared profile, run.resume, a changed trigger", async () => {
	const undeclared = deployment({ declared: false });
	const r1 = await runJob(prJob, undeclared.deps);
	assert.deepEqual([r1.reason, undeclared.calls], ["secret-bundle-profile-unknown", []]);
	const resume = deployment({ over: { sessionsDir: tempDir("pi-sessions-"), isReadableDir: () => true } });
	const r2 = await runJob({ ...prJob, resume: true }, resume.deps);
	assert.deepEqual([r2.reason, resume.calls], ["secret-bundle-resume", []]);
	const changed = deployment({ triggers: [cron] });
	const r3 = await runJob(prJob, changed.deps);
	assert.deepEqual([r3.reason, changed.calls], ["secret-bundle-trigger-changed", []]);
});

// Issue #704 part 3: both OpenShell venues hold a bundle now. The venue judges it twice inside the read (`bundleGate`):
// the hosts before the resolver runs, then the received variables, and its counts reach the record.
// A forge job that needs no fork check (an issue), since the copy venue refuses a local folder job before any of this.
const issueOn = { ...prJob, target: { type: "issue", number: 7 }, trigger: { deliveryId: "d3", matched: { index: 1, type: "pull_request", action: "opened" } } };
const endpointBundles = { shop: { profile: "shop-env", ref: "shop", project: "shop", endpoints: { STRIPE_KEY: { host: "api.stripe.com", auth: "bearer" } } } };
function gated(answer = () => ({ ok: true, placeholders: 1, plain: 1 }), over = {}) {
	const asks = [];
	const kept = [];
	const d = deployment({ bundles: endpointBundles, over: { blessedBackends: ["local", "openshell", "openshell-bind"], ...over } });
	// The venue's own facts ride every ask (the job's credential hosts and the image's capabilities), kept apart here.
	d.deps.bundleGate = async (job, ask) => {
		const { credentialHosts, capabilities, ...rest } = ask;
		asks.push({ ask: JSON.parse(JSON.stringify(rest)), calls: [...d.calls], credentialHosts, capabilities });
		return answer(ask);
	};
	const run = d.deps.runContainer;
	d.deps.runContainer = async (args) => (kept.push(args.bundleKeys ?? null), run(args));
	return { ...d, asks, kept };
}

test("on both OpenShell venues a bundled job runs: hosts judged before the read, variables after, the split handed on and counted", async () => {
	for (const backend of ["openshell", "openshell-bind"]) {
		const g = gated();
		const job = { ...issueOn, backend };
		const r = await runJob(job, g.deps);
		assert.equal(r.outcome, "completed", backend);
		assert.deepEqual(g.asks.map((a) => a.ask), [
			{ endpoints: endpointBundles.shop.endpoints, vars: null },
			{ endpoints: endpointBundles.shop.endpoints, vars: { STRIPE_KEY: "sk_live_value", DB_URL: "postgres://u:pw@db/shop" }, shadowed: [] },
		], backend);
		assert.deepEqual(g.asks.map((a) => a.calls), [[], []], "both asks come before the mint for a job that needs no fork check");
		assert.deepEqual(g.kept[0], { endpoints: { STRIPE_KEY: { host: "api.stripe.com", auth: "bearer" } }, plain: ["DB_URL"] });
		assert.deepEqual(record(job, r).bundle, { id: "shop", variables: ["DB_URL", "STRIPE_KEY"], shadowed: [], placeholders: 1, plain: 1 });
	}
	// On local the same gate admits (a venue without one), the split still rides the call bag, and the record has no counts.
	const local = gated(() => ({ ok: true }));
	const r = await runJob(cronJob, local.deps);
	assert.deepEqual(record(cronJob, r).bundle, { id: "shop", variables: ["DB_URL", "STRIPE_KEY"], shadowed: [] });
});

test("an OpenShell venue's refusal of the bundle returns before the resolver, the mint and every reserve, with its fixed sentence", async () => {
	const g = gated((ask) => (ask.vars === null ? { venueRefused: { reason: "openshell-bundle-endpoint-not-allowed", comment: "Refused: fixed. Not run." } } : assert.fail("never read")));
	const r = await runJob({ ...issueOn, backend: "openshell" }, g.deps);
	assert.deepEqual([r.outcome, r.reason, r.budgetReserved, g.calls], ["policy", "openshell-bundle-endpoint-not-allowed", false, []]);
	assert.equal(g.comments.at(-1), "Refused: fixed. Not run.");
	assert.equal(g.redis.incrCalls, 0);
	assert.equal(g.logs.some((l) => l.event === "secret_bundle_applied"), false, "the resolver never ran");
	// The second ask's refusal: after the read, still before the mint.
	const after = gated((ask) => (ask.vars === null ? { ok: true } : { venueRefused: { reason: "openshell-bundle-endpoint-unknown", comment: "Refused: fixed. Not run." } }));
	const r2 = await runJob({ ...issueOn, backend: "openshell" }, after.deps);
	assert.deepEqual([r2.reason, after.calls, after.ran], ["openshell-bundle-endpoint-unknown", [], []]);
	// A source the venue could not read retries.
	const down = gated(() => ({ unavailable: true }));
	await assert.rejects(runJob({ ...issueOn, backend: "openshell" }, down.deps), (e) => e instanceof InfraRetry);
	assert.deepEqual(down.calls, []);
});

test("part 2's residual is gone: a fork's pull request on OpenShell runs without the bundle, never refused for it", async () => {
	const g = gated(() => assert.fail("a fork's job never reaches the bundle gate"), { resolvePullRequestHead: async () => ({ headRef: "x", headRepo: "stranger/shop" }) });
	const r = await runJob({ ...prJob, backend: "openshell" }, g.deps);
	assert.deepEqual([r.outcome, r.bundleSkipped, g.kept], ["completed", "fork", [null]]);
});

test("a run.secrets value that shadows an endpoint variable keeps the declared host binding with the trigger's value, and the venue is told which", async () => {
	const g = gated(() => ({ ok: true, placeholders: 0, plain: 1 }), { resolveSecrets: async () => ({ ok: true, secrets: { STRIPE_KEY: "sk_trigger_value" } }) });
	const job = { ...issueOn, backend: "openshell", secrets: { STRIPE_KEY: "op://ci/stripe" } };
	const r = await runJob(job, g.deps);
	assert.deepEqual(g.asks[1].ask, { endpoints: endpointBundles.shop.endpoints, vars: { DB_URL: "postgres://u:pw@db/shop" }, shadowed: ["STRIPE_KEY"] });
	assert.deepEqual(g.kept[0], { endpoints: { STRIPE_KEY: { host: "api.stripe.com", auth: "bearer" } }, plain: ["DB_URL"] }, "review round 1, M2: the trigger's STRIPE_KEY stays on the host the bundle binds the name to");
	assert.deepEqual(record(job, r).bundle, { id: "shop", variables: ["DB_URL", "STRIPE_KEY"], shadowed: ["STRIPE_KEY"], placeholders: 0, plain: 1 });
});

test("on a multi-host worker's shared queue a profile this host lacks defers the job; a single host refuses it", async () => {
	const shared = deployment({ declared: false, over: { bundleProfileDeferrable: true } });
	await assert.rejects(runJob(prJob, shared.deps), (e) => e instanceof SecretBundleProfileHold && e.bundleProfileHold === true && e.reason === "secret-bundle-profile-unknown");
	assert.deepEqual(shared.calls, [], "nothing minted or cloned before the hand-back");
	const single = deployment({ declared: false });
	assert.equal((await runJob(prJob, single.deps)).reason, "secret-bundle-profile-unknown");
});

test("a triggers file never read in this process retries a project job; after a good read a broken file keeps the last good bundles", async () => {
	const broken = deployment();
	writeFileSync(join(broken.dir, "triggers.json"), "{ nope");
	await assert.rejects(runJob(cronJob, broken.deps), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
	assert.deepEqual(broken.calls, []);
	// A job with no project holds no bundle whatever the file says, so it runs.
	const projectless = deployment({ over: { pickupProject: null } });
	writeFileSync(join(projectless.dir, "triggers.json"), "{ nope");
	assert.equal((await runJob(cronJob, projectless.deps)).outcome, "completed");
	// A good read first, then the operator saves a broken file: the bundle still applies, from the last good read.
	const kept = deployment();
	await runJob(cronJob, kept.deps);
	writeFileSync(join(kept.dir, "triggers.json"), "{ nope");
	const r = await runJob(cronJob, kept.deps);
	assert.equal(r.bundle.id, "shop");
	assert.equal(kept.ran[1].STRIPE_KEY, "sk_live_value");
	assert.ok(kept.logs.some((l) => l.event === "secret_bundles_last_good"));
});

test("a job that needs no fork check reads its bundle before the mint, so a refused bundle mints nothing", async () => {
	const issueJob = { ...prJob, target: { type: "issue", number: 7 }, trigger: { deliveryId: "d2", matched: { index: 1, type: "pull_request", action: "opened" } } };
	const d = deployment({ bundle: "NODE_OPTIONS=--require /tmp/x.js\n" });
	const r = await runJob(issueJob, d.deps);
	assert.deepEqual([r.reason, d.calls], ["secret-name-reserved", []], "the loader name refuses, and before the mint");
	const forked = deployment({ bundles: { shop: { profile: "shop-env", ref: "shop", project: "shop", forkReviews: true } }, bundle: "LD_PRELOAD=/x.so\n" });
	assert.deepEqual([(await runJob(prJob, forked.deps)).reason, forked.calls], ["secret-name-reserved", []], "forkReviews needs no head, so it reads before the mint too");
});

test("the fork check: a determinate forge answer runs without the bundle, and GitHub's names compare case-insensitively", async () => {
	for (const status of [401, 403, 404]) {
		const d = deployment({ over: { resolvePullRequestHead: async () => { throw Object.assign(new Error("no"), { status }); } } });
		const r = await runJob(prJob, d.deps);
		assert.deepEqual([r.outcome, r.bundleSkipped, d.ran[0]], ["completed", "head-unverified", {}], String(status));
		assert.equal(record(prJob, r).bundleSkipped, "head-unverified");
	}
	// A GitHub rate limit is not a determinate answer: it retries, whichever header says so.
	for (const headers of [{ "x-ratelimit-remaining": "0" }, { "retry-after": "60" }]) {
		for (const status of [403, 429]) {
			const limited = deployment({ over: { resolvePullRequestHead: async () => { throw Object.assign(new Error("limited"), { status, response: { headers } }); } } });
			await assert.rejects(runJob(prJob, limited.deps), (e) => e instanceof InfraRetry, `${status} ${JSON.stringify(headers)}`);
			assert.ok(!limited.calls.includes("prepare"));
		}
	}
	const message = deployment({ over: { resolvePullRequestHead: async () => { throw new Error("forgejo-host: GET /repos/a/b/pulls/7 returned 404"); } } });
	assert.equal((await runJob(prJob, message.deps)).bundleSkipped, "head-unverified", "a fetch-based host's status is read off its message");
	const cased = deployment({ over: { resolvePullRequestHead: async () => ({ headRef: "b", headRepo: "ACME/Shop" }) } });
	assert.equal((await runJob(prJob, cased.deps)).bundle.id, "shop");
	const gitlab = deployment({ triggers: [cron, { on: { type: "pull_request", action: ["open"] }, run: { kind: "gitlab", flow: "review" } }], over: { resolvePullRequestHead: async () => ({ headRef: "b", headRepo: "ACME/Shop" }) } });
	assert.equal((await runJob({ ...prJob, kind: "gitlab" }, gitlab.deps)).bundleSkipped, "fork", "GitLab answers by project id and reports the job's own name, so its comparison stays exact");
});

// The hand-back itself, through makeProcessor: index.mjs imports bullmq, so this skips below the node floor and is
// REQUIRED in CI, as podman-restart-hold.test.mjs is.
let indexMod;
try {
	indexMod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw error;
}
test("makeProcessor hands a shared-queue job back for the never-fits recheck when its bundle profile is not served here", { skip: indexMod ? false : "bullmq not installed" }, async () => {
	const { NEVER_FITS_RECHECK_MS } = await import("../src/host-budget.mjs");
	const { QUEUE } = await import("../src/queue.mjs");
	const NOW = Date.UTC(2026, 9, 19, 12, 0);
	const run = async (multiHost) => {
		const records = [];
		const moves = [];
		const processor = indexMod.makeProcessor({
			cancelJob: () => {},
			stopContainer: () => {},
			redis: { incr: async () => 1, decr: async () => 0, expire: async () => {} },
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
			now: () => NOW,
			multiHost,
			projects: () => [{ id: "shop", members: ["/srv/shop"] }],
			recordRun: (r) => records.push(r),
			timeoutMs: 100000,
			deps: {
				findSecretBundle: () => ({ id: "shop", bundle: { profile: "shop-env", ref: "shop", project: "shop" }, optedOut: false, entry: "cron" }),
				secretBundles: { lookup: (profile) => ({ profileUnknown: profile }), resolve: async () => assert.fail("never read") },
				prepareWorkspace: async () => assert.fail("never prepared"),
				runContainer: async () => assert.fail("never run"),
				cleanup: async () => {},
				comment: async () => {},
			},
		});
		const job = { id: "cron-1", name: "local", queueName: QUEUE, attemptsMade: 0, data: { kind: "local", folder: "/srv/shop", flow: "f", task: "t", trigger: { id: "nightly" } }, moveToDelayed: async (ts) => moves.push(ts), updateData: async () => {} };
		let outcome;
		try {
			outcome = await processor(job, "tok", new AbortController().signal);
		} catch (error) {
			outcome = error;
		}
		return { outcome, moves, records };
	};
	const shared = await run(true);
	assert.equal(shared.outcome?.name, "DelayedError");
	assert.deepEqual(shared.moves, [NOW + NEVER_FITS_RECHECK_MS]);
	assert.equal(shared.records.length, 0, "a hand-back writes no record");
	const single = await run(false);
	assert.equal(single.outcome?.reason, "secret-bundle-profile-unknown");
	assert.deepEqual(single.moves, []);
});

test("review round 1, H2: the bundle gate is told every host the job's own credentials go to, and the image's capabilities", async () => {
	const g = gated(() => ({ ok: true, placeholders: 1, plain: 1 }), {
		modelEndpoints: { models: null, endpoints: [{ id: "lab-a", host: "llm.lan", port: 8000 }, { id: "other", host: "Other.Lan", port: 9000 }] },
		builtinModel: (provider) => (provider === "anthropic" ? { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } : null),
		imagePreflight: async () => ({ ok: true, capabilities: ["bundleEnvFile"] }),
	});
	const r = await runJob({ ...issueOn, backend: "openshell" }, g.deps);
	assert.equal(r.outcome, "completed", r.reason);
	for (const ask of g.asks) {
		assert.deepEqual(ask.credentialHosts, ["api.anthropic.com", "llm.lan", "other.lan"]);
		assert.deepEqual(ask.capabilities, ["bundleEnvFile"]);
	}
});
