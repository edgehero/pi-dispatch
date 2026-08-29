import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { InfraRetry, runJob } from "./processor.mjs";

const exec = promisify(execFile);

export const QUEUE = "pi-jobs";
export const JOB_TIMEOUT_MS = 30 * 60 * 1000; // REQ-JOB-TIMEOUT-30M

/**
 * Build the BullMQ processor.
 *
 * It MUST declare exactly three parameters (job, token, signal). BullMQ only allocates an
 * AbortController when `processor.length >= 3` (it inspects the function's arity at construction),
 * so dropping the unused `token` would silently disable BOTH the 30-minute timeout and the shutdown
 * abort -- with no error. A test asserts the arity precisely because the failure is silent.
 *
 * Dependencies are injected so this is testable without a live queue: `cancelJob` (fired by the
 * timeout), `stopContainer` (fired by the abort), and the orchestration deps.
 *
 * Once per job, before runJob, it resolves the runtime-settings overlay via `getSettings`
 * (INT-CONFIG-OVERLAY-CONTRACT). A present-but-invalid overlay resolves to a POLICY refusal RETURNED
 * (never thrown), so BullMQ marks the job completed without a retry (CONST-RETRY-INFRA-ONLY). A valid
 * overlay fills the effective `provider`/`model`/`maxTurns`/`dailyCap`/`weeklyCap`/`monthlyCap`/`softHoldPct`
 * under `job.data > overlay > env` precedence and re-binds the worker slot count via `applyConcurrency`.
 * The overlay changes which values the spend caps take, never when they are checked -- reserveBudget still
 * runs inside runJob against the freshly passed caps (CONST-BUDGET-BEFORE-TOKENS).
 */
export function makeProcessor({ cancelJob, stopContainer, redis, getSettings, applyConcurrency = () => {}, pauseUntil = () => null, deps, recordRun = () => {}, timeoutMs = JOB_TIMEOUT_MS, now = () => Date.now() }) {
	return async function processor(job, token, signal) {
		// Scoped pause windows (REQ-SCOPED-PAUSE-WINDOWS): if this job's folder/repo is inside an active pause
		// window, DEFER it to the window end via BullMQ's delayed set -- the job keeps its identity/dedup and
		// auto-resumes when re-picked. This is FIRST, before the kill timer, the settings read, and the budget
		// reservation, so a deferred job arms no timer, reserves no slot, and spends nothing
		// (CONST-BUDGET-BEFORE-TOKENS). `moveToDelayed` needs the worker's `token`; the `> now + 1s` guard keeps
		// a boundary tick from busy-deferring. A thrown `DelayedError` is how BullMQ learns the job was deferred
		// (worker.js recognises it) rather than completed or failed.
		// One clock snapshot for both the window lookup and the guard, so they cannot disagree across the
		// call (and a test can inject a fixed clock). `now` defaults to the real wall clock in production.
		const nowMs = now();
		const until = pauseUntil(job.data, nowMs);
		if (until && until > nowMs + 1000) {
			await job.moveToDelayed(until, token);
			throw new DelayedError();
		}

		const startedAt = new Date().toISOString();
		const name = `pi-job-${job.id}`;
		const timer = setTimeout(() => {
			// BullMQ has no per-job kill timer; this is ours. cancelJob raises the AbortSignal.
			Promise.resolve(cancelJob(job.id, "job-timeout-30m")).catch(() => {});
		}, timeoutMs);

		// Abort (timeout OR shutdown) => stop the container. docker stop sends SIGTERM then SIGKILL
		// after the grace period; the runner exits and runContainer returns/throws.
		const onAbort = () => {
			Promise.resolve(stopContainer(name)).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			const settings = await getSettings();
			if (settings.invalid) {
				// A present-but-invalid overlay is a POLICY refusal, RETURNED (never thrown) so BullMQ marks the
				// job completed and does not retry a file that can never parse (CONST-RETRY-INFRA-ONLY). Resolved
				// before runJob, so no budget slot is reserved and no container starts (CONST-BUDGET-BEFORE-TOKENS).
				// recordRun leaves the durable settings-overlay-invalid trace for the admin extension.
				// No provider/model here, alone among the terminal results: the overlay is the thing that failed to parse, so no honest effective value exists -- buildRecord defaults both null.
				const result = { outcome: "policy", reason: "settings-overlay-invalid", exitCode: null, turns: null, tokens: null, budgetReserved: false };
				recordRun({ job, result, startedAt, endedAt: new Date().toISOString() });
				return result;
			}

			// Re-bind the worker slot count to the effective concurrency before the run (no-op default when
			// unwired, e.g. a bare makeProcessor under test).
			applyConcurrency(settings.concurrency);

			// Fill the effective job settings under `job.data > overlay > env` precedence: an explicit per-job
			// field wins; an omitted one takes the overlay value, else env, resolved at this job's start
			// (INT-CONFIG-OVERLAY-CONTRACT). Receiver GitHub jobs carry no provider/model/maxTurns, so this fill
			// supplies the provider the container env allowlist requires -- absent it, the allowlist refuses a job
			// only after its budget slot is reserved. The `caps`/`softHoldPct` passed to runJob change which
			// values reserveBudget checks, never when it runs.
			const effectiveJob = {
				...job.data,
				provider: job.data.provider ?? settings.provider,
				model: job.data.model ?? settings.model,
				maxTurns: job.data.maxTurns ?? settings.maxTurns,
				maxTokens: job.data.maxTokens ?? settings.maxTokens, // optional per-job token budget (issue #25); null => runner meter only
			};

			const result = await runJob(effectiveJob, {
				redis,
				// The three spend windows (week/month null when disabled) and the soft-hold band, resolved this
				// job-start under overlay > env. reserveBudget checks them before the container.
				caps: { day: settings.dailyCap, week: settings.weeklyCap, month: settings.monthlyCap },
				softHoldPct: settings.softHoldPct,
				// The daily TOKEN cap (issue #25), same overlay > env resolution. Check-AFTER, so it gates the
				// NEXT job on prior recorded spend; null => the daily token counter is disabled.
				tokenCap: settings.dailyTokenCap,
				...deps,
				runContainer: (ctx) => deps.runContainer({ ...ctx, name, signal }),
				// REQ-TRIGGER-SECRETS. The resolver runs INSIDE the 30-minute kill timer armed above, so it has
				// to be abortable for the same reason runContainer does: a resolver blocking on an unreachable
				// vault would otherwise hold its slot until its own timeout, and an abort landing mid-resolution
				// would neither stop it nor keep the job from going on to mint, clone and reserve budget for a
				// container that runContainer will refuse at entry anyway. Injected here, mirroring runContainer,
				// because `signal` exists only in this scope. Omitted when unwired so a bare processor keeps
				// runJob's own fail-closed default.
				// `secretProfiles` is the OVERLAY half of the resolver table, read this job-start with the ten
				// tunables above. It is bound here rather than at construction for the reason the overlay exists:
				// an operator who declares a profile in the panel must not have to restart the worker.
				...(deps.resolveSecrets ? { resolveSecrets: (j) => deps.resolveSecrets(j, { signal, overlayProfiles: settings.secretProfiles ?? {} }) } : {}),
				// collectChain (INT-OUTBOX-CONTRACT) reads the completed parent's REAL BullMQ job: its `.id`
				// (the parent id children carry) and `.data` (kind/chainDepth). runJob's own `job` is the
				// effectiveJob -- a spread of job.data with no `.id`/`.data` -- so inject the real wrapper here,
				// mirroring the name/signal injection above. Omitted when unwired so a bare processor falls back
				// to runJob's no-op default (a chain fault can never flip a completed outcome either way).
				...(deps.collectChain ? { collectChain: (ctx) => deps.collectChain({ ...ctx, job }) } : {}),
				// prepareWorkspace needs the REAL BullMQ job's `.id` to derive a cron job's scheduled-for
				// instant from the deterministic repeat:<id>:<millis> jobId (DES-CRON-VIA-BULLMQ-SCHEDULER)
				// for the local /job/event.json. runJob's own `job` is the effectiveJob -- a spread of
				// job.data with no `.id` -- and the real wrapper is only in scope here, so inject it as
				// `queueJobId`, mirroring the collectChain injection above. Omitted when unwired so a bare
				// processor keeps runJob's plain (job, token) call.
				...(deps.prepareWorkspace ? { prepareWorkspace: (j, t) => deps.prepareWorkspace(j, t, { queueJobId: job.id }) } : {}),
				// The one-shot pre-spend check (issue #231) needs the REAL BullMQ job's `.id` to excuse this
				// delivery's own earlier attempt -- runJob's effectiveJob has no `.id`, prepareWorkspace's
				// own injection above states why, and this one mirrors it. Omitted when unwired so a bare
				// processor keeps runJob's admit-everything default.
				...(deps.checkOnceSpent ? { checkOnceSpent: (j) => deps.checkOnceSpent(j, { queueJobId: job.id }) } : {}),
			});
			recordRun({ job, result, startedAt, endedAt: new Date().toISOString() });
			return result;
		} catch (error) {
			recordRun({ job, error, startedAt, endedAt: new Date().toISOString() });
			if (error instanceof InfraRetry) throw error; // retryable: BullMQ retries per attempts
			// A non-retryable, non-infra error (our bug) must not retry forever. UnrecoverableError
			// records it as failed-and-distinct in the queue's failed set without a retry.
			throw new UnrecoverableError(error.message);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	};
}

export function createWorker({ connection, concurrency, getSettings, redis, deps, recordRun, limiter, pauseUntil, extraClosers = [] }) {
	let worker; // referenced by cancelJob/applyConcurrency before assignment; only called later, so the TDZ is fine
	const processor = makeProcessor({
		cancelJob: (id, reason) => worker.cancelJob(id, reason),
		stopContainer: (name) => exec("docker", ["stop", "-t", "5", name]),
		redis,
		getSettings,
		// Late-bound over `worker`: an overlay concurrency change re-binds the live slot count at the next
		// job start. Guarded so only an integer that actually differs touches the property.
		applyConcurrency: (n) => {
			if (Number.isInteger(n) && worker.concurrency !== n) worker.concurrency = n;
		},
		pauseUntil,
		deps,
		recordRun,
	});

	worker = new Worker(QUEUE, processor, {
		// maxRetriesPerRequest: null is REQUIRED for BullMQ's blocking connections, or it throws.
		connection: { ...connection, maxRetriesPerRequest: null },
		concurrency,
		maxStalledCount: 0, // a stalled paid job FAILS, never silently re-runs (verified live)
		...(limiter ? { limiter } : {}),
	});

	const shutdown = async () => {
		// Abort active jobs (=> docker stop via onAbort), then close. Without the cancel,
		// worker.close() would wait up to 30 minutes for the container.
		await Promise.resolve(worker.cancelAllJobs?.("shutdown")).catch(() => {});
		await worker.close();
		// Close auxiliary resources (e.g. a cron scheduler) after the worker drains. Per-item catch
		// so one failing or absent closer never strands the others or blocks exit -- matches the
		// swallow posture on cancelAllJobs above.
		await Promise.all(extraClosers.map((c) => Promise.resolve(c.close?.()).catch(() => {})));
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	// Windows never delivers an external SIGTERM. nssm's console-stop delivers Ctrl-C => SIGINT
	// (handled above); SIGBREAK covers console-close. Route it to the same shutdown so a stopped
	// worker still aborts in-flight jobs and docker-stops their containers rather than orphaning them.
	if (process.platform === "win32") process.once("SIGBREAK", shutdown);

	return worker;
}
