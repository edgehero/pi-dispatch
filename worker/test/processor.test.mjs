import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeKeyPrefix } from "../src/scoped-limits.mjs";
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
	assert.equal(e.session, null, "the repaired session and the ledger trio default null the same way");
	assert.equal(e.usage, null);
	assert.equal(e.provider, null);
	assert.equal(e.model, null);
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

// --- the egress policy (issue #202): a host whose policy cannot serve a job must not pay to find out ---

test("an absent egress proxy refuses BEFORE reserveBudget -- and this gate is worth MORE than the image one", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, egressPreflight: async () => ({ proxyMissing: "pi-dispatch-egress-proxy" }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "egress-proxy-missing");
	assert.equal(r.budgetReserved, false);
	assert.deepEqual([r.exitCode, r.turns, r.tokens], [null, null, null]);
	assert.ok(!calls.some((c) => c.startsWith("mint:")), "no credential for a job that cannot reach anything");
	assert.ok(!calls.includes("prepare"), "no clone");
	assert.ok(!calls.includes("run-container"), "no container");
	// The assertion this whole requirement exists for. WITHOUT this gate the container starts, the provider
	// is unreachable, the runner exits 1 -- the RETRYABLE class -- `attempts: 2` runs it again, and
	// releaseBudget refunds only `container-never-started`, which this is not. Two job-count slots per job,
	// neither refunded, on a schedule nobody is watching.
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- a down proxy must not burn two cap slots");
	assert.ok(
		calls.some((c) => c.startsWith("comment:")),
		"the operator is told which component is down and how to start it",
	);
});

test("a proxy that exists but is STOPPED is its own reason, because the fix is a different one", async () => {
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, egressPreflight: async () => ({ proxyStopped: "pi-dispatch-egress-proxy" }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "egress-proxy-stopped");
	assert.equal(redis.incrCalls, 0);
});

test("a docker daemon that will not answer the egress probe RETRIES, rather than refusing determinately", async () => {
	// The determinate/indeterminate split, and the direction matters in both. A refusal here would drop
	// real work on a daemon restart; a retry on a genuinely absent proxy would burn the second slot.
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, egressPreflight: async () => ({ unavailable: "pi-dispatch-egress-proxy" }) });
	await assert.rejects(() => runJob(ghJob, d), (e) => e.reason === "container-never-started");
	assert.equal(redis.incrCalls, 0, "still pre-reserve, so the refund path is a no-op and stays honest");
});

test("a deployment with no egress policy is unaffected: the default preflight admits every job", async () => {
	// The wired default and the real factory's unarmed return are the same shape, so a deployment that
	// never turned this on cannot be refused by a gate it does not use.
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis }); // no egressPreflight injected at all
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.ok(calls.includes("run-container"), "the job runs exactly as it did before this gate existed");
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

test("a CONTAINER exiting 3 is still unrecognised -- the wait participant's hold code is not shared", async () => {
	// Issue #230 gave exit 3 a meaning ("not yet, ask again later") for the WAIT PARTICIPANT only. That
	// widening is per-participant by construction, and this is the pin that keeps it so: a container has no
	// way to say "hold me", so a 3 from one is still a code we cannot reason about, still infra-retryable,
	// and still holding its budget slot. If this test ever goes green on a `policy` or a deferral, the
	// protocol amendment leaked into the classifier it promised not to touch.
	const redis = fakeRedis();
	const { deps: d } = deps({ redis, runContainer: async () => ({ code: 3, aborted: false }) });
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) => e instanceof InfraRetry && /unknown container exit 3/.test(e.message) && e.budgetReserved === true,
	);
	assert.equal(redis.decrCalls, 0, "and no refund, exactly as for any other unrecognised code");
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

test("the promotion carries the container's context reading, or the bound it feeds can never fire", async () => {
	// The join between the two halves of the context bound, and it was unpinned: the runner's emit and the
	// store's gate each had tests, while the one line that carries the number between them had none, so
	// deleting it left the whole suite green and the knob permanently inert on a wired worker.
	// deepEqual on the OPTIONS OBJECT, not a property probe, so a dropped key and a stray one both fail.
	const calls = [];
	const prepared = { workspace: "/w", jobDir: "/j", session: { key: "abc", hostDir: "/j/session", resume: true, reason: "resumed", bytes: 42 } };
	const { deps: base } = deps({
		prepareWorkspace: async () => prepared,
		promoteSession: (s, opts) => {
			calls.push(opts);
			return { promoted: true, reason: "promoted", bytes: 99 };
		},
		imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }),
	});

	await runJob(ghJob, {
		...base,
		runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: true, reason: "resumed" }, context: { tokens: 5000, window: 200000 } }),
	});
	assert.deepEqual(calls, [{ piVersion: "0.80.7", context: { tokens: 5000, window: 200000 } }]);

	// A container that reported none passes null through rather than omitting the key, so the store's
	// "leave the last real reading alone" branch is reached rather than its "no key" one.
	calls.length = 0;
	await runJob(ghJob, { ...base, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: true, reason: "resumed" }, context: null }) });
	assert.deepEqual(calls, [{ piVersion: "0.80.7", context: null }]);
});

test("a host gate that refused outranks the runner's absent, so the record names WHICH gate", async () => {
	// The repair. A refused read stages a 0-byte file rather than nothing, the container is handed it
	// either way, and pi opens it and finds no messages -- so the runner reports `absent` on EVERY host
	// refusal. While that won, `expired` and `pi-version-changed` reached no completed record at all and
	// docs/sessions.md's promise that every cold start is nameable in the record was false for them.
	for (const token of ["expired", "conversation-too-old", "pi-version-changed", "too-large", "not-a-regular-file", "unparseable"]) {
		const prepared = { workspace: "/w", jobDir: "/j", session: { key: "k", hostDir: "/j/session", resume: false, reason: token, bytes: null } };
		const { deps: d } = deps({
			prepareWorkspace: async () => prepared,
			imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }),
			promoteSession: () => ({ promoted: true, reason: "promoted", bytes: 1234 }),
		});
		const r = await runJob(ghJob, { ...d, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: false, reason: "absent" } }) });
		assert.equal(r.outcome, "completed");
		assert.equal(r.session.reason, token, `a completed run must name the gate that refused, not the container's restatement of it`);
		assert.equal(r.session.resumed, false);
	}

	// Not exit-code specific: a policy exit masked it identically before the repair.
	const prepared = { workspace: "/w", jobDir: "/j", session: { key: "k", hostDir: "/j/session", resume: false, reason: "expired", bytes: null } };
	const { deps: d } = deps({ prepareWorkspace: async () => prepared, imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }) });
	const policy = await runJob(ghJob, { ...d, runContainer: async () => ({ code: 2, aborted: false, turns: 1, tokens: null, session: { resumed: false, reason: "absent" } }) });
	assert.equal(policy.session.reason, "expired");
});

test("the override is narrow: a staged transcript the runner would not resume still reports the runner", async () => {
	// The disagreement this object exists to show. The host resolved a real transcript (resume:true) and
	// the container found nothing usable in it -- a corrupt file, a degrade -- and collapsing that into the
	// host's cheerful `resumed` would hide the one event worth seeing.
	const prepared = { workspace: "/w", jobDir: "/j", session: { key: "k", hostDir: "/j/session", resume: true, reason: "resumed", bytes: 7 } };
	const { deps: d } = deps({ prepareWorkspace: async () => prepared, imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }) });

	const disagree = await runJob(ghJob, { ...d, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: false, reason: "absent" } }) });
	assert.equal(disagree.session.reason, "absent", "host said resume, runner says absent: that is the degrade, not a gate");
	assert.equal(disagree.session.resumed, false);

	// The other half of "narrow": the override is keyed on the runner's token being exactly `absent`. A
	// host gate that refused AND a runner that quarantined the file it was handed is a mount fault worth
	// seeing, and a wider override would report the gate and hide it.
	const refused = { workspace: "/w", jobDir: "/j", session: { key: "k", hostDir: "/j/session", resume: false, reason: "expired", bytes: null } };
	const { deps: q } = deps({ prepareWorkspace: async () => refused, imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }) });
	const quarantined = await runJob(ghJob, { ...q, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: false, reason: "unparseable" } }) });
	assert.equal(quarantined.session.reason, "unparseable", "the runner saw something the host could not, so it keeps the line");

	// And a refused PROMOTION still outranks both, because it says why the NEXT run will cold start.
	const refusedPrepared = { workspace: "/w", jobDir: "/j", session: { key: "k", hostDir: "/j/session", resume: false, reason: "expired", bytes: null } };
	const { deps: locked } = deps({
		prepareWorkspace: async () => refusedPrepared,
		imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }),
		promoteSession: () => ({ promoted: false, reason: "locked" }),
	});
	const r = await runJob(ghJob, { ...locked, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: false, reason: "absent" } }) });
	assert.equal(r.session.reason, "locked");
});

test("a job with no session records session:null and never calls the store", async () => {
	let promoted = 0;
	const { deps: d } = deps({ prepareWorkspace: async () => ({ workspace: "/w", jobDir: "/j" }), promoteSession: () => { promoted += 1; return null; } });
	const r = await runJob(ghJob, { ...d, runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: null }) });
	assert.equal(r.session, null, "an unarmed job's record must look exactly as it did before this feature");
	assert.equal(promoted, 0);
});

// ---- REQ-RESUMABLE-SESSION's ONE fail-CLOSED case. Every other outcome in that feature degrades to a
// ---- named cold start; an armed trigger with no store to persist into is a pre-spend policy refusal,
// ---- because the alternative is a green run that persisted nothing and looked like it worked.

const armedJob = { ...ghJob, resume: true };

test("an armed run.resume with PI_SESSIONS_DIR unset refuses BEFORE the mint, the clone and the budget", async () => {
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, sessionsDir: null });
	const r = await runJob(armedJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "sessions-dir-unset");
	assert.equal(r.budgetReserved, false, "refused pre-reserve, so no daily slot was consumed");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- the gate is free by construction");
	assert.equal(redis.decrCalls, 0, "and with nothing reserved there is nothing to give back");
	// The refusal comment is the ONLY side effect: no mint (no credential created to be discarded), no
	// branch-check API call, no clone, no container -- and no cleanup, because nothing was prepared.
	assert.deepEqual(calls, ["comment:Refused: thi"]);
	// Attribution rides even a pre-container refusal (INT-RUN-HISTORY-FILE-CONTRACT); no ledger exists.
	assert.equal(r.provider, "anthropic");
	assert.equal(r.model, "m");
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.tokens, null);
	assert.equal("usage" in r, false, "nothing ran, so there is no ledger key");
	// RETURNED, never thrown: this await resolving IS the not-retried assertion. An unset environment
	// variable is determinate, and BullMQ retrying it would refuse identically N times (CONST-RETRY-INFRA-ONLY).
});

test("the same armed job proceeds untouched once a session store is configured", async () => {
	const { deps: d, calls } = deps({ sessionsDir: "/srv/pi-sessions" });
	const r = await runJob(armedJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(
		calls,
		["mint:org/repo", "branch-check", "prepare", "run-container", "collect-chain", "cleanup"],
		"the gate is the only thing run.resume changes in this file -- same order as the unarmed happy path",
	);
});

test("resume:false and an absent resume never reach the gate, store or no store", async () => {
	// Strict `=== true`, the same test prepare-github.mjs uses to decide whether to resolve a session at
	// all. Absent and false are today's behaviour exactly, and refusing either would refuse a job that
	// asked for nothing.
	for (const job of [{ ...ghJob, resume: false }, ghJob]) {
		const { deps: d, calls } = deps({ sessionsDir: null });
		const r = await runJob(job, d);
		assert.equal(r.outcome, "completed", `resume=${JSON.stringify(job.resume)} must not be refused`);
		assert.ok(calls.includes("run-container"));
	}
});

test("the gate is kind-agnostic: an armed LOCAL job refuses on the same terms", async () => {
	// No local job can arm the flag today -- triggers.mjs refuses run.resume on a cron trigger, and a CLI
	// or chained job has no trigger entry that could set it. The gate covers the kind anyway, because a
	// gate written as an enumeration of kinds is a gate the next kind skips silently.
	const { deps: d, calls } = deps({ sessionsDir: null });
	const r = await runJob({ kind: "local", folder: "/home/rob/proj", resume: true, provider: "anthropic", model: "m" }, d);
	assert.equal(r.reason, "sessions-dir-unset");
	assert.equal(r.budgetReserved, false);
	assert.ok(!calls.includes("run-container"));
});

test("the sessionsDir default is the PI_SESSIONS_DIR read, so an unpassed dep cannot false-refuse", async () => {
	// Load-bearing choice: a bare `null` default would refuse EVERY armed job under a wiring that omits the
	// key, and that false refusal is indistinguishable from the true one. config.mjs derives its own
	// `sessionsDir` from this same variable (`env.PI_SESSIONS_DIR || null`), so the two cannot disagree.
	const saved = process.env.PI_SESSIONS_DIR;
	try {
		process.env.PI_SESSIONS_DIR = "/srv/pi-sessions";
		const { deps: withStore } = deps(); // deliberately no sessionsDir key
		assert.equal((await runJob(armedJob, withStore)).outcome, "completed", "a configured store must admit the job with no wiring change");
		delete process.env.PI_SESSIONS_DIR;
		const { deps: noStore } = deps();
		assert.equal((await runJob(armedJob, noStore)).reason, "sessions-dir-unset", "and an unset variable is the real refusal");
	} finally {
		if (saved === undefined) delete process.env.PI_SESSIONS_DIR;
		else process.env.PI_SESSIONS_DIR = saved;
	}
});

// ---- per-(provider,model) usage ledger (INT-RUN-HISTORY-FILE-CONTRACT): the exit line's rebuilt
// ---- `usage` block and the host-effective provider/model thread through results AND throws.

/** A minimal valid rebuilt ledger, as the sink would hand it back after parseExitUsage. */
const LEDGER = { v: 1, piAi: "0.80.7", truncated: 0, models: [{ provider: "anthropic", model: "claude-x", calls: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 15, cost: 0.01, unpriced: 0 }] };

test("a completed run's result carries the host-effective provider/model and the container's usage block", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false, turns: 2, tokens: { total: 15 }, usage: LEDGER }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	// runJob's `job` IS the effectiveJob, so these are the overlay-resolved dispatch facts -- what the
	// HOST ran with -- never anything the container printed.
	assert.equal(r.provider, "anthropic");
	assert.equal(r.model, "m");
	assert.deepEqual(r.usage, LEDGER);
});

test("a runner-policy exit carries the ledger too -- a policy container still spent real money", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 2, aborted: false, turns: 1, tokens: { total: 15 }, usage: LEDGER }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "runner-policy");
	assert.deepEqual(r.usage, LEDGER);
	assert.equal(r.provider, "anthropic");
	assert.equal(r.model, "m");
});

test("a pre-container policy refusal carries provider/model but NO usage key", async () => {
	const { deps: d } = deps({ isDefaultBranchProtected: async () => false });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "unprotected-branch");
	assert.equal(r.provider, "anthropic", "even a refusal attributes which (provider, model) it was dispatched for");
	assert.equal(r.model, "m");
	assert.equal("usage" in r, false, "no container ran, so no ledger key exists -- buildRecord defaults the field null");
});

test("an exit-1 infra throw preserves usage, provider, model AND session on the InfraRetry", async () => {
	// The session half pins the latent-drop repair: the EXIT_INFRA throw always PASSED session, but the
	// InfraRetry constructor never read it, so every infra-retry record stored session:null and a degrade
	// seen only on a retried attempt vanished. The ledger fields joining the constructor is what surfaced it.
	const { deps: d } = deps({
		runContainer: async () => ({ code: 1, aborted: false, turns: 4, tokens: { total: 15 }, session: { resumed: true, reason: "resumed" }, usage: LEDGER }),
	});
	await assert.rejects(
		() => runJob(ghJob, d),
		(e) =>
			e instanceof InfraRetry &&
			e.provider === "anthropic" &&
			e.model === "m" &&
			JSON.stringify(e.usage) === JSON.stringify(LEDGER) &&
			e.session?.resumed === true &&
			e.session?.reason === "resumed",
	);
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

test("a command job on an image that does not declare command support refuses pre-spend, pre-reserve", async () => {
	// The replica gate's twin (issue #189). The image is PRESENT but its runner predates run.command: it
	// reads no PI_COMMAND, so the bare `/name args` prompt reaches the model as prose -- no handler, an
	// improvised run, a clean exit 0 the queue records as success. The runner-side refusal
	// (command-unregistered) does not exist on such an image, which is why the host refuses first.
	const redis = fakeRedis();
	const posted = [];
	const { deps: d, calls } = deps({
		redis,
		comment: async (_j, t) => posted.push(t),
		imagePreflight: async () => ({ commandUnsupported: "pi-job:stale", declared: [] }),
	});
	const r = await runJob({ kind: "local", folder: "/proj", command: "wf run", provider: "anthropic", model: "m", maxTurns: 5 }, d);
	assert.equal(r.outcome, "policy", "a policy RETURN, never a throw -- determinate refusals do not retry");
	assert.equal(r.reason, "job-image-commands-unsupported");
	assert.equal(r.budgetReserved, false);
	assert.equal(r.exitCode, null);
	assert.equal(r.turns, null);
	assert.equal(r.tokens, null);
	assert.equal(redis.incrCalls, 0, "a stale image must not burn a cap slot to find out");
	assert.ok(!calls.includes("prepare"), "no clone for a job that cannot run correctly");
	assert.ok(!calls.includes("run-container"), "no container -- this is the whole point of a pre-spend gate");
	assert.ok(posted[0]?.includes("dev.pi-dispatch.capabilities"), "the message names the label so it can be grepped for");
	assert.ok(posted[0]?.includes("Rebuild"), "and names the fix, not merely the symptom");
});

// ---- REQ-PER-TRIGGER-SKILLS: a trigger that named a skills dir the worker cannot see.

test("an absent run.skillsDir refuses BEFORE the mint, the clone and the budget", async () => {
	// Free and determinate -- one lstat -- so it belongs among the free gates and strictly before anything
	// that spends. Without it the job runs its flow WITHOUT the skills it was written against, writes a
	// plausible report, and exits 0.
	const redis = fakeRedis();
	const { deps: d, calls } = deps({ redis, isReadableDir: () => false });
	const r = await runJob({ ...ghJob, skillsDir: "/srv/gone" }, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "skills-dir-missing");
	assert.equal(r.budgetReserved, false, "refused pre-reserve, so no daily slot was consumed");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached -- the gate is free by construction");
	assert.deepEqual(calls, ["comment:Refused: thi"], "no mint, no branch check, no clone, no container");
});

test("a readable run.skillsDir does not refuse, and the gate is skipped entirely when the field is absent", async () => {
	let probed = 0;
	const ok = await runJob({ ...ghJob, skillsDir: "/srv/skills" }, deps({ isReadableDir: () => { probed++; return true; } }).deps);
	assert.equal(ok.outcome, "completed");
	assert.equal(probed, 1);
	const none = await runJob(ghJob, deps({ isReadableDir: () => { probed++; return false; } }).deps);
	assert.equal(none.outcome, "completed", "a job with no run.skillsDir must not be gated on one");
	assert.equal(probed, 1, "and the probe must not even run");
});

test("the skills-dir refusal names the FIELD and never the host path -- the comment is posted publicly", async () => {
	const said = [];
	const d = deps({ isReadableDir: () => false }).deps;
	const r = await runJob({ ...ghJob, skillsDir: "/srv/acme-internal/layout/skills" }, { ...d, comment: async (_j, text) => said.push(text) });
	assert.equal(r.reason, "skills-dir-missing");
	assert.ok(said[0].includes("run.skillsDir"), "the operator must be told which field");
	assert.ok(!said.join(" ").includes("acme-internal"), "a host path was published on the issue");
});

// --- run.secrets: the pre-spend gate (REQ-TRIGGER-SECRETS, issue #225) ---

test("an unflagged job never calls the resolver at all -- the probe must not even run", async () => {
	// The call-order pin one test up asserts the happy path stays byte-identical; this asserts the
	// mechanism. A dep that ran unconditionally would spawn a subprocess for every job on the host to
	// learn nothing, and would make the "free gates cost nothing when the feature is off" claim false.
	const probes = [];
	const { deps: d, calls } = deps({ resolveSecrets: async () => (probes.push("resolve"), { ok: true, secrets: {} }) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(probes, [], "an unflagged job must not reach the resolver");
	assert.deepEqual(calls, ["mint:org/repo", "branch-check", "prepare", "run-container", "collect-chain", "cleanup"]);
});

test("a job whose profile cannot be resolved refuses BEFORE the mint, the clone and the budget", async () => {
	const { deps: d, calls } = deps({ resolveSecrets: async () => ({ profileUnknown: "prod" }) });
	const r = await runJob({ ...ghJob, secrets: { A: "op://a/b/c" }, secretsProfile: "prod" }, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "secret-profile-unknown");
	assert.equal(r.budgetReserved, false);
	// Every one of these is money or a credential, and CONST-BUDGET-BEFORE-TOKENS puts all of them after
	// a determinate refusal. Asserting the ABSENCE is what proves the placement, not the outcome string.
	assert.ok(!calls.includes("run-container"), "must not spend");
	assert.ok(!calls.includes("prepare"), "must not clone");
	assert.ok(!calls.some((c) => c.startsWith("mint:")), "must not create a credential only to discard it");
	assert.equal(d.redis.incrCalls, 0, "must not reserve a budget slot");
});

test("the refusal names the FIELD and the operator's own profile label, never a path or a reference", async () => {
	// `comment` posts publicly on the issue. A resolver path there publishes the operator's filesystem
	// layout; a reference publishes their vault topology. This is processor.mjs's oldest restraint,
	// applied to a field that carries more of both than any before it.
	let posted = "";
	const { deps: d } = deps({ resolveSecrets: async () => ({ profileUnknown: "prod" }), comment: async (_j, t) => { posted = t; } });
	await runJob({ ...ghJob, secrets: { STRIPE_KEY: "op://Engineering-Prod/aws-root/password" }, secretsProfile: "prod" }, d);
	assert.match(posted, /run\.secrets/);
	assert.equal(/op:\/\//.test(posted), false, "a reference must never be published");
	assert.equal(/Engineering-Prod|aws-root|password/.test(posted), false, "no part of a reference, either");
	assert.equal(/\/opt\/|\.sh\b/.test(posted), false, "no resolver path may be published");
	assert.match(posted, /doctor/, "it must point somewhere the operator can actually look");
});

test("the resolver dep FAILS CLOSED: an armed job under a wiring that omits it refuses, never runs", async () => {
	// The default is the security property, not a convenience. imagePreflight and egressPreflight default
	// to admitting because a deployment without those features is the normal case; a job that ASKED for
	// secrets and got none is never normal, and starting it would look exactly like the feature working.
	for (const armed of [{ secrets: { A: "op://a/b/c" } }, { secretsProfile: "prod", secrets: { A: "x" } }]) {
		const { deps: d, calls } = deps(); // no resolveSecrets override: the real default runs
		const r = await runJob({ ...ghJob, ...armed }, d);
		assert.equal(r.outcome, "policy", `${JSON.stringify(armed)} must refuse`);
		assert.equal(r.reason, "secret-profile-unknown");
		assert.ok(!calls.includes("run-container"));
	}
});

test("a cron job may bind secrets, and its refusal reaches the operator through the log seam", async () => {
	// Extending to local jobs is deliberate (run.replicas refuses them for a reason that does not
	// transfer), so the gate must be reachable there. A local job has no issue to comment on; the
	// `comment` seam falls through to stdout, which REQ-LOCAL-JOB-VISIBILITY makes the completion signal.
	const { deps: d, calls } = deps({ resolveSecrets: async () => ({ profileUnknown: "default" }) });
	const r = await runJob({ kind: "local", folder: "/srv/site", flow: "deploy", provider: "anthropic", model: "m", maxTurns: 20, secrets: { DEPLOY_KEY: "op://ci/deploy/key" } }, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "secret-profile-unknown");
	assert.ok(calls.some((c) => c.startsWith("comment:")), "the operator must still be told");
});

// --- the one-shot pre-spend gate (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE) ---

// runJob's job is the effectiveJob: the receiver's matched rides trigger.matched directly on it.
const onceJob = { ...ghJob, target: { type: "issue", number: 40 }, trigger: { matched: { index: 0, type: "issue", action: "closed", number: 40, once: true } } };

test("a once job with a foreign-spent check refuses FIRST on the ladder -- nothing else runs at all", async () => {
	const redis = fakeRedis();
	const posted = [];
	const events = [];
	const { deps: d, calls } = deps({
		redis,
		checkOnceSpent: async () => (calls.push("check-once"), { refused: true, at: "2026-08-28T09:00:00.000Z", jobId: "gh-first" }),
		// The deps factory leaves imagePreflight to runJob's default, which the calls trace never sees --
		// so this override exists purely to make its ABSENCE from the trace provable.
		imagePreflight: async () => (calls.push("image-preflight"), { ok: true }),
		comment: async (_j, t) => (posted.push(t), calls.push("comment")),
		log: (event) => events.push(event),
	});
	const r = await runJob(onceJob, d);
	assert.equal(r.outcome, "policy", "a spent one-shot is a determinate refusal, RETURNED (never retried)");
	assert.equal(r.reason, "once-already-spent");
	assert.equal(r.budgetReserved, false, "refused before reserveBudget, so no cap slot was consumed");
	assert.deepEqual([r.exitCode, r.turns, r.tokens], [null, null, null], "refused pre-container: no exit, turn or token count exists");
	assert.deepEqual([r.provider, r.model], ["anthropic", "m"], "attribution rides even this refusal");
	// THE LADDER-POSITION PIN. The trace IS the assertion: the check ran, the comment posted, and
	// NOTHING else -- not the image inspect (this check is one file read, cheaper than the docker
	// inspect, so it goes first), not the mint, not the clone, not the reservation, not a container.
	assert.deepEqual(calls, ["check-once", "comment"], "one file read and one comment are the refusal's entire cost");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached");
	assert.equal(posted.length, 1, "the comment posts exactly once");
	assert.ok(posted[0].includes("already spent"), "the comment names the condition");
	assert.ok(posted[0].includes("Not run."), "and the outcome, in the family wording every refusal ends with");
	assert.ok(posted[0].includes("at 2026-08-28T09:00:00.000Z"), "the mark's harness-written at rides the comment");
	assert.ok(posted[0].includes("by job gh-first"), "and its provenance jobId -- never payload text");
	assert.ok(events.includes("refused_once_already_spent"), "the refusal leaves its log line");
});

test("a wait-skew refusal is pre-spend, and its cost is one file read and one comment (#230)", async () => {
	const redis = fakeRedis();
	const posted = [];
	const events = [];
	const { deps: d, calls } = deps({
		redis,
		checkWaitSkew: async () => (calls.push("check-skew"), { skewed: true, conditions: 2 }),
		imagePreflight: async () => (calls.push("image-preflight"), { ok: true }),
		comment: async (_j, t) => (posted.push(t), calls.push("comment")),
		log: (event) => events.push(event),
	});
	const r = await runJob(ghJob, d);

	assert.equal(r.outcome, "policy", "a skewed job is determinate: no version of it can succeed until a service is upgraded");
	assert.equal(r.reason, "wait-skew");
	assert.equal(r.budgetReserved, false);
	// The ladder position IS the assertion: this refusal exists to stop a paid run, so it must precede
	// everything that costs, including the docker inspect.
	assert.deepEqual(calls, ["check-skew", "comment"], "one file read and one comment are the whole cost");
	assert.equal(redis.incrCalls, 0, "reserveBudget never reached");
	assert.ok(posted[0].includes("2 wait conditions"), "the comment counts what was authored");
	assert.ok(!posted[0].includes("jira"), "and never says WHAT they were -- the count is the actionable part");
	assert.ok(posted[0].includes("below the version"), "it names the fix, which is an upgrade rather than an edit");
	assert.ok(posted[0].includes("Not run."));
	assert.ok(events.includes("refused_wait_skew"));
});

test("the default checkWaitSkew admits, so an unwired processor is unchanged (#230)", async () => {
	const { deps: d } = deps({});
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed", "the seam is off until the wiring turns it on");
});

test("a once job whose check answers ok runs exactly the happy path, with the check in front", async () => {
	const { deps: d, calls } = deps({ checkOnceSpent: async () => (calls.push("check-once"), { ok: true }) });
	const r = await runJob(onceJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(
		calls,
		["check-once", "mint:org/repo", "branch-check", "prepare", "run-container", "collect-chain", "cleanup"],
		"an armed-and-unspent one-shot changes nothing but the one read in front of the ladder",
	);
});

test("a NON-once job never calls checkOnceSpent -- the probe must not even run", async () => {
	// The arming test lives at the CALL SITE (job.trigger?.matched?.once === true), not inside the dep:
	// an injected checker running on every delivery would be a per-job file read nobody asked for, the
	// probe-nobody-wanted shape the resolveSecrets comment warns about.
	const probes = [];
	for (const job of [ghJob, { ...ghJob, trigger: { matched: { index: 0, type: "label", label: "dispatch" } } }]) {
		const { deps: d, calls } = deps({
			checkOnceSpent: async () => {
				probes.push(job);
				return { refused: true, at: null, jobId: null };
			},
		});
		const r = await runJob(job, d);
		assert.equal(r.outcome, "completed", "even a checker that would REFUSE cannot touch an unflagged job");
		assert.ok(calls.includes("run-container"), "the job runs exactly as before the gate existed");
	}
	assert.deepEqual(probes, [], "zero probes for jobs without matched.once === true");
});

test("the default admits everything: a once job under a deps set WITHOUT checkOnceSpent runs", async () => {
	// An unwired processor behaves exactly as before the gate existed -- imagePreflight's and
	// egressPreflight's posture, and the opposite of resolveSecrets' fail-closed default, because an
	// omitted wiring here risks one duplicate run, not a silently inverted credential.
	const { deps: d, calls } = deps(); // deliberately no checkOnceSpent key
	const r = await runJob(onceJob, d);
	assert.equal(r.outcome, "completed");
	assert.ok(calls.includes("run-container"), "the job runs; once-enforcement is the wired deployment's property");
});

// ── scoped budget windows (issue #242, INT-SCOPED-LIMITS-FILE-CONTRACT) ─────────────────────────────

/**
 * A KEYED fake redis (budget.test.mjs's shape), because the whole point of these tests is that the
 * scoped `budget:s:<h16>:*` keys and the global `budget:*` keys move independently -- the
 * single-counter fake above cannot express that.
 */
function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	return {
		store,
		async incr(k) {
			const v = (store.get(k) ?? 0) + 1;
			store.set(k, v);
			return v;
		},
		async decr(k) {
			const v = (store.get(k) ?? 0) - 1;
			store.set(k, v);
			return v;
		},
		async expire() {},
		async get() {
			return null;
		},
	};
}

// deps()'s clock is 2026-07-16, so the day keys are fixed strings the assertions can pin.
const G_DAY = "budget:2026-07-16";
const S_PREFIX = scopeKeyPrefix("org/repo");
const S_DAY = `${S_PREFIX}:2026-07-16`;
const SCOPED = { scope: "org/repo", caps: { day: 1, week: null, month: null } };

test("scope-cap: the scoped window refuses PRE-SPEND with the global ledger untouched and its own count kept", async () => {
	const redis = keyedRedis({ [S_DAY]: 1 }); // the scope already spent its day: 1
	const logs = [];
	const comments = [];
	const { deps: d } = deps({ redis, scopedCaps: SCOPED, log: (e, f) => logs.push({ e, f }), comment: async (_j, t) => comments.push(t) });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "scope-cap");
	assert.equal(r.budgetReserved, false, "budgetReserved stays GLOBAL-only: the global slot was never touched");
	assert.equal(redis.store.get(S_DAY), 2, "the scoped INCR is kept -- refused-still-counts, per ledger");
	assert.equal(redis.store.has(G_DAY), false, "the global key was never created, let alone incremented");
	assert.equal(comments[0], "Over the day run cap for org/repo (1). Not run.");
	const scoped = logs.find((l) => l.e === "over_scope_budget");
	assert.deepEqual(scoped.f, { scopeKey: S_PREFIX, window: "day", reserved: 2, cap: 1, kind: "forge" });
	assert.ok(!JSON.stringify(scoped.f).includes("org/repo"), "the raw scope never rides the log line");
});

test("a GLOBAL refusal after a scoped reserve RELEASES the scoped slot -- a storm cannot drain a scope's windows", async () => {
	const redis = keyedRedis({ [G_DAY]: 10 }); // the global day cap (10) is already exhausted
	const { deps: d } = deps({ redis, scopedCaps: { scope: "org/repo", caps: { day: 5, week: null, month: null } } });
	const r = await runJob(ghJob, d);
	assert.equal(r.reason, "over-budget", "the global window is what refused");
	assert.equal(r.budgetReserved, true, "the global refused-reservation still counts, as ever");
	assert.equal(redis.store.get(S_DAY), 0, "the scoped reserve was given back: INCR then DECR, net zero");
	assert.equal(redis.store.get(G_DAY), 11, "the global counter keeps its refused reservation");
});

test("container-never-started refunds BOTH ledgers; a container that ran refunds NEITHER", async () => {
	// exit 125: docker spawn fault -> refund both.
	{
		const redis = keyedRedis();
		const { deps: d } = deps({ redis, scopedCaps: SCOPED, runContainer: async () => ({ code: 125, aborted: false }) });
		await assert.rejects(() => runJob(ghJob, d), (e) => e.reason === "container-never-started");
		assert.equal(redis.store.get(S_DAY), 0, "scoped slot refunded");
		assert.equal(redis.store.get(G_DAY), 0, "global slot refunded");
	}
	// exit 1: the container RAN and spent -> both slots stay spent through the infra retry.
	{
		const redis = keyedRedis();
		const { deps: d } = deps({ redis, scopedCaps: SCOPED, runContainer: async () => ({ code: 1, aborted: false }) });
		await assert.rejects(() => runJob(ghJob, d), (e) => e instanceof InfraRetry && e.reason !== "container-never-started");
		assert.equal(redis.store.get(S_DAY), 1, "scoped slot kept -- the run spent real money");
		assert.equal(redis.store.get(G_DAY), 1, "global slot kept");
	}
});

test("softHoldPct is GLOBAL-only: a scoped window deep inside what would be its band still admits", async () => {
	// Scoped day 8/10 spent = 80%, inside a 50% hold band IF the band applied to scoped windows. It must
	// not: scoped windows are hard caps (DES-SCOPED-LIMITS-AND-FOLDER-MUTEX).
	const redis = keyedRedis({ [S_DAY]: 8 });
	const { deps: d } = deps({ redis, softHoldPct: 50, caps: { day: 100, week: null, month: null }, scopedCaps: { scope: "org/repo", caps: { day: 10, week: null, month: null } } });
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed", "the scoped window has no soft-hold band");
});

test("byte-identity: a run with no scopedCaps creates exactly the pre-#242 key set -- no budget:s: key ever", async () => {
	const redis = keyedRedis();
	const { deps: d } = deps({ redis }); // scopedCaps takes its null default
	const r = await runJob(ghJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual([...redis.store.keys()], [G_DAY], "key for key, the store is what it was before #242");
});

test("a LOCAL scope-cap keeps the folder path out of the comment text too -- the local adapter LOGS it", async () => {
	// start.mjs's forgeFor has no `local` entry, so the wiring's comment adapter falls through to
	// log("comment", { jobId, text }) -- the text reaches the worker log and must be path-free.
	const localScoped = { scope: "/Users/someone/work/site", caps: { day: 1, week: null, month: null } };
	const sPrefix = scopeKeyPrefix("/Users/someone/work/site");
	const redis = keyedRedis({ [`${sPrefix}:2026-07-16`]: 1 });
	const comments = [];
	const logs = [];
	const { deps: d } = deps({ redis, scopedCaps: localScoped, comment: async (_j, t) => comments.push(t), log: (e, f) => logs.push({ e, f }) });
	const localJob = { kind: "local", folder: "/Users/someone/work/site", flow: "tidy", provider: "anthropic", model: "m" };
	const r = await runJob(localJob, d);
	assert.equal(r.reason, "scope-cap");
	assert.equal(comments[0], "Over the day run cap for this folder (1). Not run.");
	assert.ok(!comments[0].includes("/Users/"), "the host path never enters the comment text");
	assert.ok(!JSON.stringify(logs).includes("/Users/someone"), "and never any log field");
});
