import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";

/** A fake redis whose counter we can preset, to force over/under budget. `decrCalls` spies
 *  releaseBudget, so tests assert the slot is (or is not) given back and never double-released.
 *  `tokenSpent` presets the daily TOKEN counter that `checkTokenCap`'s read-only GET consults. */
function fakeRedis(start = 0, tokenSpent = 0) {
	let n = start;
	const redis = { decrCalls: 0, incrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, ++n);
	redis.decr = async () => (redis.decrCalls++, --n);
	redis.expire = async () => {};
	// The daily token counter is a separate key; GET returns its current value (a string) or null.
	redis.get = async () => (tokenSpent > 0 ? String(tokenSpent) : null);
	return redis;
}

/** Deps with call-order tracking, so tests can assert the money-safety ORDER, not just outcomes. */
function deps(overrides = {}) {
	const calls = [];
	const base = {
		redis: fakeRedis(),
		// The day window is the only one active by default (week/month disabled), so the single-counter
		// fakeRedis stays valid; soft-hold is off unless a test sets it. Mirrors a default deployment.
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async (job) => (calls.push(`mint:${job?.repo}`), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => (calls.push("collect-chain"), { enqueued: 0, refused: 0 }),
		cleanup: async () => (calls.push("cleanup"), undefined),
		comment: async (_j, t) => calls.push(`comment:${t.slice(0, 12)}`),
		now: new Date("2026-07-16T10:00:00Z"),
	};
	return { deps: { ...base, ...overrides }, calls };
}

const ghJob = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20 };

test("happy path: mint -> branch-check -> prepare -> budget -> container, in that order", async () => {
	const { deps: d, calls } = deps();
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(calls, ["mint:org/repo", "branch-check", "prepare", "run-container", "collect-chain", "cleanup"]);
});

test("an unprotected branch refuses BEFORE any container -- and never prepares/spends", async () => {
	const { deps: d, calls } = deps({ isDefaultBranchProtected: async () => false });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "unprotected-branch");
	assert.ok(!calls.includes("run-container"), "must not spend on an unprotected repo");
	assert.ok(!calls.includes("prepare"), "must not even clone an unprotected repo");
});

test("over budget refuses AFTER prepare but BEFORE the container -- no provider spend", async () => {
	// counter starts at cap, so the reservation lands over-cap (base caps.day is 10).
	const { deps: d, calls } = deps({ redis: fakeRedis(10) });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "over-budget");
	assert.ok(calls.includes("prepare"), "prepared (free work) before the budget gate");
	assert.ok(!calls.includes("run-container"), "over budget => NO container, no money spent");
});

test("soft-hold refuses AFTER prepare but BEFORE the container, with a distinct soft-hold reason", async () => {
	// day cap 5, 80% band -> threshold floor(4)=4; counter at 4 makes the reservation land at 5 (in-band).
	const { deps: d, calls } = deps({ redis: fakeRedis(4), caps: { day: 5, week: null, month: null }, softHoldPct: 80 });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "soft-hold", "an in-band reservation is a soft-hold, distinct from over-budget");
	assert.equal(r.budgetReserved, true, "the reservation still counts (no give-back)");
	assert.ok(calls.includes("prepare"), "prepared (free work) before the budget gate");
	assert.ok(!calls.includes("run-container"), "soft-hold => new start paused, NO container, no money spent");
});

test("a prepare policy outcome (sha-gone) RETURNS before reserveBudget -- no cap slot burned", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({
		redis,
		prepareWorkspace: async () => ({ outcome: "policy", reason: "sha-gone" }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "sha-gone");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached on a determinate prepare policy outcome");
	assert.ok(!calls.includes("run-container"), "a sha-gone prepare must never spend on a container");
});

test("container exit 0 => success, no retry", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false }) });
	assert.equal((await runJob(ghJob, d)).outcome, "completed");
});

test("container exit 2 => policy, RETURNS (not retried)", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 2, aborted: false }) });
	assert.equal((await runJob(ghJob, d)).outcome, "policy");
});

test("container exit 1 => THROWS InfraRetry (BullMQ will retry)", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
	await assert.rejects(() => runJob(ghJob, d), (e) => e instanceof InfraRetry && e.piDispatchRetry === true);
});

test("a worker-initiated abort (137, aborted) => policy RETURNS worker-abort, never retried", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 137, aborted: true }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "worker-abort", "our own docker stop must not re-run into a second PR");
});

test("a graceful-shutdown SIGTERM (143, aborted) => policy worker-abort, not retried", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 143, aborted: true }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "worker-abort");
});

test("an unbidden 137 (aborted:false, kernel OOM) throws InfraRetry -- infra stays retryable", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 137, aborted: false }) });
	await assert.rejects(() => runJob(ghJob, d), InfraRetry);
});

test("cleanup runs even when the container throws", async () => {
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
	await runJob(ghJob, d).catch(() => {});
	assert.ok(calls.includes("cleanup"), "the job dir must be cleaned up on the infra path too");
});

test("a local-folder job skips minting and branch-check entirely", async () => {
	const { deps: d, calls } = deps();
	const localJob = { kind: "local", folder: "/home/rob/proj", provider: "anthropic", model: "m", maxTurns: 5 };
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed");
	assert.ok(!calls.some((c) => c.startsWith("mint")), "no token for a local job");
	assert.ok(!calls.includes("branch-check"), "no branch check for a non-git folder");
});

test("an empty minted token refuses as configError BEFORE reserveBudget -- no cap slot burned", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, mintToken: async () => "" });
	await assert.rejects(() => runJob(ghJob, d), (e) => e.piDispatchConfig === true);
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- no slot burned on a bad token");
	assert.ok(!calls.includes("run-container"), "an empty credential must never spend");
});

test("a whitespace-only minted token is also refused as configError", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, mintToken: async () => "   " });
	await assert.rejects(() => runJob(ghJob, d), (e) => e.piDispatchConfig === true);
	assert.equal(redis.incrCalls, 0, "whitespace is empty -- no slot burned");
});

test("an unflagged local job does not hit the empty-credential guard (it never mints)", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, mintToken: async () => "" });
	const localJob = { kind: "local", folder: "/home/rob/proj", provider: "anthropic", model: "m", maxTurns: 5 };
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed", "an unflagged local job never mints, so the empty-token guard cannot fire");
});

// ---- run.github opt-in: a local cron job flagged `github: true` mints the same scoped per-job token
// ---- the github path mints (CONST-TOKEN-SCOPED-PER-JOB), with no repo to pass or branch-check.

const flaggedLocalJob = { kind: "local", folder: "/home/rob/proj", github: true, provider: "anthropic", model: "m", maxTurns: 5 };

test("a run.github local job mints with an UNDEFINED repo, skips the branch check, and threads the token through", async () => {
	const minted = [];
	const tokens = { prepare: "unset", container: "unset" };
	const { deps: d, calls } = deps({
		mintToken: async (job) => (minted.push(job), "tok-local"),
		prepareWorkspace: async (_job, token) => ((tokens.prepare = token), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async ({ token }) => ((tokens.container = token), { code: 0, aborted: false }),
	});
	const r = await runJob(flaggedLocalJob, d);
	assert.equal(r.outcome, "completed");
	assert.equal(minted.length, 1, "mintToken is called exactly once");
	// The App path refuses a repo-less mint (get-token.mjs) because an installation token must be scoped to
	// one repo -- so what matters is that the job handed to the minter carries no repo, not that the
	// argument itself is undefined.
	assert.equal(minted[0]?.repo, undefined, "a local job carries no repo for the minter to scope to");
	assert.ok(!calls.includes("branch-check"), "no branch-protection check -- REQ-BRANCH-PROTECTION-PRECONDITION is forge-jobs-only");
	assert.equal(tokens.prepare, "tok-local", "the minted token reaches prepareWorkspace");
	assert.equal(tokens.container, "tok-local", "the minted token reaches runContainer");
});

test("a local job WITHOUT the flag never mints; the container sees a null token (today's behavior)", async () => {
	const tokens = { container: "unset" };
	const { deps: d, calls } = deps({
		runContainer: async ({ token }) => ((tokens.container = token), { code: 0, aborted: false }),
	});
	const localJob = { kind: "local", folder: "/home/rob/proj", provider: "anthropic", model: "m", maxTurns: 5 };
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed");
	assert.ok(!calls.some((c) => c.startsWith("mint")), "no mint for an unflagged local job");
	assert.equal(tokens.container, null, "token stays null exactly as before the opt-in existed");
});

test("a flagged local job whose mint rejects (config-tagged) propagates BEFORE reserveBudget -- no cap slot burned", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({
		redis,
		mintToken: async () => {
			const e = new Error("github jobs and cron triggers with run.github require a working GITHUB_AUTH_SOURCE (gh/pat/app)");
			e.piDispatchConfig = true;
			throw e;
		},
	});
	await assert.rejects(() => runJob(flaggedLocalJob, d), (e) => e.piDispatchConfig === true);
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- no slot burned on a broken auth source");
	assert.ok(!calls.includes("run-container"), "no container, no provider spend");
});

test("a flagged local job with an empty minted token is refused by the empty-credential guard", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, mintToken: async () => "" });
	await assert.rejects(() => runJob(flaggedLocalJob, d), (e) => e.piDispatchConfig === true);
	assert.equal(redis.incrCalls, 0, "no slot burned on an empty credential");
	assert.ok(!calls.includes("run-container"), "an empty credential must never reach a paid run");
});

test("container-never-started (spawn fault) after reserving RELEASES the slot, still throws InfraRetry", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({
		redis,
		runContainer: async () => {
			throw new InfraRetry("container-never-started", { reason: "container-never-started" });
		},
	});
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.reason === "container-never-started",
	);
	assert.equal(redis.decrCalls, 1, "releaseBudget gives the slot back exactly once -- no double-release");
});

test("exit-1 infra retry KEEPS the slot -- the container ran and spent, so no release", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, runContainer: async () => ({ code: 1, aborted: false }) });
	await assert.rejects(() => runJob(ghJob, d), InfraRetry);
	assert.equal(redis.decrCalls, 0, "a container that ran must not get its slot back");
});

test("InfraRetry back-compat: message-only ctor keeps piDispatchRetry and defaults reason to the message", () => {
	const e = new InfraRetry("x");
	assert.equal(e.piDispatchRetry, true);
	assert.equal(e.reason, "x");
	assert.equal(e.message, "x");
	assert.equal(e.exitCode, null, "telemetry fields default null on the message-only ctor");
	assert.equal(e.turns, null);
	assert.equal(e.budgetReserved, null);
});

test("a completed return carries exitCode/turns from the container and budgetReserved true", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false, turns: 7 }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.exitCode, 0);
	assert.equal(r.turns, 7);
	assert.equal(r.budgetReserved, true);
});

test("an over-budget return carries null exit/turns but budgetReserved true (slot kept)", async () => {
	const { deps: d } = deps({ redis: fakeRedis(10) });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "over-budget");
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.budgetReserved, true);
});

test("an unprotected-branch return carries null exit/turns and budgetReserved false (pre-reserve)", async () => {
	const { deps: d } = deps({ isDefaultBranchProtected: async () => false });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "unprotected-branch");
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.budgetReserved, false);
});

test("an exit-1 infra throw stamps exitCode/turns and budgetReserved true (container ran and spent)", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 1, aborted: false, turns: 4 }) });
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.exitCode === 1 && e.turns === 4 && e.budgetReserved === true,
	);
});

test("a container-never-started throw stamps budgetReserved false (its slot is refunded)", async () => {
	const { deps: d } = deps({
		runContainer: async () => {
			throw new InfraRetry("container-never-started", { reason: "container-never-started" });
		},
	});
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.reason === "container-never-started" && e.budgetReserved === false,
	);
});

test("a completed run collects the chain and carries chainEnqueued/chainRefused from collectChain", async () => {
	const { deps: d } = deps({
		runContainer: async () => ({ code: 0, aborted: false, turns: 9 }),
		collectChain: async () => ({ enqueued: 2, refused: 1 }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.chainEnqueued, 2);
	assert.equal(r.chainRefused, 1);
});

test("collectChain runs BEFORE cleanup deletes the job dir (the outbox is read before deletion)", async () => {
	const order = [];
	const { deps: d } = deps({
		collectChain: async () => (order.push("collect"), { enqueued: 0, refused: 0 }),
		cleanup: async () => (order.push("cleanup"), undefined),
	});
	await runJob(ghJob, d);
	assert.deepEqual(order, ["collect", "cleanup"], "the chain must be collected before jobDir is cleaned up");
});

test("collectChain counts are additive telemetry: they never alter the completed outcome/exit/turns/budget", async () => {
	const { deps: d } = deps({
		runContainer: async () => ({ code: 0, aborted: false, turns: 9 }),
		collectChain: async () => ({ enqueued: 5, refused: 3 }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed", "a chain result never flips the completed outcome");
	assert.equal(r.exitCode, 0);
	assert.equal(r.turns, 9);
	assert.equal(r.budgetReserved, true);
	assert.equal(r.chainEnqueued, 5);
	assert.equal(r.chainRefused, 3);
});

test("collectChain runs ONLY on the completed branch, never on policy / abort / infra / over-budget", async () => {
	// EXIT_POLICY (runner-policy, container exit 2)
	{
		const { deps: d, calls } = deps({ runContainer: async () => (calls.push("run-container"), { code: 2, aborted: false }) });
		const r = await runJob(ghJob, d);
		assert.equal(r.outcome, "policy");
		assert.ok(!calls.includes("collect-chain"), "runner-policy must not chain");
	}
	// worker-abort (137, aborted)
	{
		const { deps: d, calls } = deps({ runContainer: async () => (calls.push("run-container"), { code: 137, aborted: true }) });
		await runJob(ghJob, d);
		assert.ok(!calls.includes("collect-chain"), "a worker abort must not chain");
	}
	// EXIT_INFRA (exit 1 => throws InfraRetry; a retried job would double-chain)
	{
		const { deps: d, calls } = deps({ runContainer: async () => (calls.push("run-container"), { code: 1, aborted: false }) });
		await runJob(ghJob, d).catch(() => {});
		assert.ok(!calls.includes("collect-chain"), "an infra retry must not chain -- it re-runs");
	}
	// over-budget (policy, pre-container)
	{
		const { deps: d, calls } = deps({ redis: fakeRedis(10) });
		await runJob(ghJob, d);
		assert.ok(!calls.includes("collect-chain"), "over-budget must not chain");
	}
	// unprotected-branch (policy, pre-container)
	{
		const { deps: d, calls } = deps({ isDefaultBranchProtected: async () => false });
		await runJob(ghJob, d);
		assert.ok(!calls.includes("collect-chain"), "an unprotected branch must not chain");
	}
});

// ---- daily token cap (issue #25): check-BEFORE reserveBudget, record-AFTER the container ----

test("daily token cap refuses BEFORE reserveBudget when the day is over budget -- no job-count slot burned", async () => {
	// The token counter is preset over the cap; checkTokenCap runs before reserveBudget's INCR.
	const redis = fakeRedis(0, 2000);
	const { deps: d, calls } = deps({ redis, tokenCap: 1500 });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "daily-token-cap");
	assert.equal(r.budgetReserved, false, "a token-cap refusal consumes no job-count slot");
	assert.equal(redis.incrCalls, 0, "reserveBudget (job-count INCR) is never reached");
	assert.ok(!calls.includes("run-container"), "no container, no provider spend");
});

test("under the token cap: the run proceeds and records its spend AFTER the container", async () => {
	const recorded = [];
	const { deps: d } = deps({
		redis: fakeRedis(0, 500),
		tokenCap: 1_000_000,
		runContainer: async () => ({ code: 0, aborted: false, turns: 3, tokens: { input: 4000, output: 1000, total: 5000, cost: 0.1 } }),
		recordSpend: async (_redis, tokens) => (recorded.push(tokens), 5500),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(r.tokens, { input: 4000, output: 1000, total: 5000, cost: 0.1 }, "usage totals thread into the result");
	assert.deepEqual(recorded, [5000], "the job's total tokens are INCRBY'd into the daily counter after the run");
});

test("token spend is recorded even on a runner-policy exit -- the container still spent", async () => {
	const recorded = [];
	const { deps: d } = deps({
		tokenCap: 1_000_000,
		runContainer: async () => ({ code: 2, aborted: false, turns: 9, tokens: { total: 4000 } }),
		recordSpend: async (_redis, tokens) => recorded.push(tokens),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "runner-policy");
	assert.deepEqual(recorded, [4000], "a policy exit that ran a container is accounted, not free");
});

test("with the token cap disabled (null), the counter is never recorded", async () => {
	const recorded = [];
	const { deps: d } = deps({
		// tokenCap omitted => defaults to null
		runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: { total: 5000 } }),
		recordSpend: async (_redis, tokens) => recorded.push(tokens),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(recorded, [], "nothing reads the counter when the cap is off, so nothing writes it");
});

test("a Redis failure while recording token spend never fails a completed, paid job", async () => {
	const { deps: d } = deps({
		tokenCap: 1_000_000,
		runContainer: async () => ({ code: 0, aborted: false, turns: 2, tokens: { total: 5000 } }),
		recordSpend: async () => {
			throw new Error("valkey down");
		},
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed", "money is already spent -- a counter blip must not turn success into failure");
});

// --- the job image (issue #41): a host that cannot run the image must not pay to find out ---

test("a missing job image refuses BEFORE mint, prepare and reserveBudget -- nothing spent, no slot burned", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, imagePreflight: async () => ({ missing: "my-python:1.2.0" }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "job-image-missing");
	assert.equal(r.budgetReserved, false);
	assert.deepEqual([r.exitCode, r.turns, r.tokens], [null, null, null], "refused pre-container: no exit, turn or token count exists");
	// This gate outranks every other because it needs no credential, no network and no repo -- so a host
	// missing its image never mints a token it will not use or clones a repo it will not read.
	assert.ok(!calls.some((c) => c.startsWith("mint:")), "no credential is minted for a job that cannot run");
	assert.ok(!calls.includes("prepare"), "no clone");
	assert.ok(!calls.includes("run-container"), "no container");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- a misspelled tag must not burn a cap slot");
	assert.ok(
		calls.some((c) => c.startsWith("comment:")),
		"the operator is told, by name, which image is missing",
	);
});

test("an image that cannot serve this job's forge refuses pre-spend, and names run.image as the fix", async () => {
	// Same money gate, a different cause: the image is PRESENT and says it ships no CLI for this forge.
	// Without this the job runs, finds no such command, and fails at step 3 inside a paid container -- on
	// every delivery, looking exactly like a bad agent run rather than a missing tool.
	const redis = fakeRedis();
	// The shared fake truncates comment text, so this test captures it whole -- the WORDING is the point
	// here, not merely that something was posted.
	const posted = [];
	const { deps: d, calls } = deps({
		redis,
		comment: async (_j, t) => posted.push(t),
		imagePreflight: async () => ({ forgeUnsupported: "pi-job:latest", kind: "azure", declared: ["github", "gitlab", "forgejo"] }),
	});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "job-image-forge-unsupported");
	assert.equal(r.budgetReserved, false);
	assert.equal(redis.incrCalls, 0, "a trigger that forgot run.image must not burn a cap slot to find out");
	assert.ok(!calls.some((c) => c.startsWith("mint:")), "no credential is minted for a job that cannot run");
	assert.ok(!calls.includes("run-container"), "no container");
	assert.ok(posted[0]?.includes("run.image"), "the message names the likely cause, not the label that detected it");
	assert.ok(posted[0]?.includes("azure"), "and which forge it could not serve");
});

test("a missing job image is RETURNED, never thrown -- retrying cannot make a misspelled tag appear", async () => {
	// Throwing would make BullMQ retry and burn a SECOND slot on a determinate config fault. This is the
	// same policy-not-infra call CONST-RETRY-INFRA-ONLY makes for settings-overlay-invalid.
	const { deps: d } = deps({ imagePreflight: async () => ({ missing: "nope:1" }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy", "a determinate refusal returns");
});

test("an unreachable docker daemon at preflight THROWS InfraRetry (transient), not a policy refusal", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, imagePreflight: async () => ({ unavailable: "pi-job:latest" }) });
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && e.reason === "container-never-started",
		"a daemon blip must be retried, not turned into a permanent refusal of a job whose image is fine",
	);
	assert.equal(redis.incrCalls, 0, "and it still burns no slot");
	assert.ok(!calls.includes("run-container"));
});

test("docker exits 125/126/127 throw container-never-started and RELEASE the slot", async () => {
	// docker never handed control to the runner in any of the three, so nothing was spent. These used to
	// fall to the unknown-exit branch, which KEPT the slot and retried -- burning a second one.
	for (const code of [125, 126, 127]) {
		const redis = fakeRedis();
		const { deps: d } = deps({ redis, runContainer: async () => ({ code, aborted: false }) });
		await assert.rejects(
			() => runJob(ghJob, d),
			(e) => e instanceof InfraRetry && e.reason === "container-never-started" && e.budgetReserved === false,
			`exit ${code} means the container never ran`,
		);
		assert.equal(redis.decrCalls, 1, `exit ${code} gives the slot back exactly once`);
	}
});

test("an unrecognised container exit still falls to the unknown-exit InfraRetry and KEEPS its slot", async () => {
	// Pins that the 125/126/127 case NARROWED `default:` rather than replacing it: a code we did not foresee
	// means the container may well have run and spent, so its slot stays reserved.
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, runContainer: async () => ({ code: 42, aborted: false }) });
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && /unknown container exit 42/.test(e.message) && e.budgetReserved === true,
	);
	assert.equal(redis.decrCalls, 0, "an unknown exit is not assumed to have spent nothing");
});

test("a completed run promotes its transcript; a policy or infra exit does NOT", async () => {
	// Completed-only promotion is what keeps CONST-RETRY-INFRA-ONLY true: promote on every exit and a
	// retry inherits the failed attempt's residue, so attempt 2 stops being the same run as attempt 1.
	const calls = [];
	const prepared = { workspace: "/w", jobDir: "/j", session: { key: "abc", hostDir: "/j/session", resume: true, reason: "resumed", bytes: 42 } };
	const { deps: base } = deps({
		prepareWorkspace: async () => prepared,
		promoteSession: (s, opts) => {
			calls.push({ key: s.key, piVersion: opts.piVersion });
			return { promoted: true, reason: "promoted", bytes: 99 };
		},
		imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }),
	});

	const ok = await runJob(ghJob, { ...base, runContainer: async () => ({ code: 0, aborted: false, turns: 3, tokens: null, session: { resumed: true, reason: "resumed" } }) });
	assert.equal(ok.outcome, "completed");
	assert.deepEqual(calls, [{ key: "abc", piVersion: "0.80.7" }], "the promotion must carry the image's pi version, or the next run cannot tell whether the schema moved");
	assert.equal(ok.session.resumed, true);

	calls.length = 0;
	const policy = await runJob(ghJob, { ...base, runContainer: async () => ({ code: 2, aborted: false, turns: 1, tokens: null, session: { resumed: true, reason: "resumed" } }) });
	assert.equal(policy.outcome, "policy");
	assert.deepEqual(calls, [], "a policy exit must leave the canonical transcript byte-identical");

	calls.length = 0;
	await assert.rejects(() => runJob(ghJob, { ...base, runContainer: async () => ({ code: 1, aborted: false, turns: 1, tokens: null, session: null }) }));
	assert.deepEqual(calls, [], "an infra exit must not promote either -- the retry would otherwise continue rather than re-run");
});

test("the record's session merges host intent with what the container actually did", async () => {
	// Both halves, because either alone lies. A host that staged a transcript while the runner reports
	// resumed:false is a degrade, and with one number it is indistinguishable from an ordinary cold start.
	const prepared = { workspace: "/w", jobDir: "/j", session: { key: "k", hostDir: "/j/session", resume: true, reason: "resumed", bytes: 7 } };
	const { deps: d } = deps({ prepareWorkspace: async () => prepared, imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }) });

	const degraded = await runJob(ghJob, { ...d, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: false, reason: "unparseable" } }) });
	assert.equal(degraded.session.resumed, false, "the runner observed the outcome, so its verdict wins");
	assert.equal(degraded.session.reason, "unparseable");

	// PII-free by construction: a boolean, a fixed enum, an integer. No key, no branch, no path.
	assert.deepEqual(Object.keys(degraded.session).sort(), ["bytes", "reason", "resumed"]);
	// The KEY and the branch name must never reach the record: its PII-free-by-construction property
	// rests on holding no attacker-chosen string, and a branch name is exactly that.
	assert.equal("key" in degraded.session, false);
	assert.equal(JSON.stringify(degraded.session).includes(prepared.session.key), false);
});

test("a job with no session records session:null and never calls the store", async () => {
	let promoted = 0;
	const { deps: d } = deps({ prepareWorkspace: async () => ({ workspace: "/w", jobDir: "/j" }), promoteSession: () => { promoted += 1; return null; } });
	const r = await runJob(ghJob, { ...d, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: null }) });
	assert.equal(r.session, null, "an unarmed job's record must look exactly as it did before this feature");
	assert.equal(promoted, 0);
});

test("a replica job on an image that does not declare replica support refuses pre-spend, pre-reserve", async () => {
	// The stale-image gate (REQ-REPLICA-RUNS). The image is PRESENT and its baked guardrails predate the
	// feature, so rule 3 still hard-codes `pi/issue-<n>` as a SYSTEM rule and would override the user prompt
	// naming `-r2`. Both replicas converge on one branch: nothing errors, and the operator pays twice for
	// one pull request. Determinate, so a refusal and not a retry.
	const redis = fakeRedis();
	const posted = [];
	const { deps: d, calls } = deps({
		redis,
		comment: async (_j, t) => posted.push(t),
		imagePreflight: async () => ({ replicaUnsupported: "pi-job:stale", declared: [] }),
	});
	const r = await runJob({ ...ghJob, replica: 2, replicas: 2 }, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "job-image-replicas-unsupported");
	assert.equal(r.budgetReserved, false);
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.tokens, null);
	assert.equal(redis.incrCalls, 0, "a stale image must not burn a cap slot to find out");
	assert.ok(!calls.some((c) => c.startsWith("mint:")), "no credential is minted for a job that cannot run correctly");
	assert.ok(!calls.includes("run-container"), "no container -- this is the whole point of a pre-spend gate");
	assert.ok(posted[0]?.includes("dev.pi-dispatch.capabilities"), "the message names the label so it can be grepped for");
	assert.ok(posted[0]?.includes("Rebuild"), "and names the fix, not merely the symptom");
});
