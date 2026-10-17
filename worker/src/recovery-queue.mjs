/**
 * Durable runs, the queue half (issue #645): putting a crashed run's continuation on the queue, taking it back off when
 * the host that holds its checkpoint never returns, and the host-local leftovers of a crash (a stale job directory).
 *
 * WHY A NEW JOB AND NOT BULLMQ'S OWN RETRY. A retry re-runs the job from scratch under the same id: a fresh clone, a
 * fresh session, and a second payment for every turn the first attempt already paid for. A recovery continues from
 * the run's last checkpoint, which lives on ONE host (the store is host-local, `INT-WORKSPACE-CHECKPOINT-STORE`), so
 * it has to be routed there, and it has to carry which run it continues. Neither fits the retry: a retry cannot change
 * queue, and its data is the original's. So a recovery is its own job, `${runId}.r${n}`, with the original's data plus
 * `recoveryOf` (the run id, a string) and `recovery` (n, an integer). Nothing ever parses the id back: those two fields
 * carry it.
 *
 * THE ID, measured against the installed bullmq (5.80.4, `Job.validateOptions`): a custom id containing `:` is refused
 * ("Custom Id cannot contain :") unless it splits into exactly three parts, the legacy repeatable shape. A `.rN` suffix
 * adds no colon, so every run id the producers mint today maps to an accepted recovery id: the forge and local ids hold
 * none (`gh-<guid>`, `local-<hex>`, `chain-<hex>`), and the cron and manual ids hold exactly two (`repeat:<id>:<ms>`,
 * `manual:<id>:<ms>`), so `repeat:a:b.r1` is three parts. An id of any other colon count is refused HERE, before
 * anything is claimed, as `job-id-refused`, rather than by a throw out of `queue.add` after the claim.
 *
 * NO `deduplication` on the add, deliberately: the original forge job carried a semantic key (`repo#n:flow`, ten
 * minutes), and a recovery is the same target and flow by construction. With the key copied, a crash inside the
 * original's window would have the recovery swallowed by the very job it continues (measured: an add WITH the key
 * returns the original's id; one without it is stored). The custom job id is the only dedup a recovery needs.
 *
 * `attempts: 1`: a recovery is not retried by the queue. A crashed recovery is recovered again (n + 1, up to the cap)
 * by the same path that recovered the original, and that path is what keeps a retry from re-paying a run from zero.
 *
 * Every function here is dependency-injected (redis, queue handles, clock, fs), so the decisions are testable with
 * fakes and the claim race against a real Valkey.
 */
import * as nodeFsp from "node:fs/promises";
import { join } from "node:path";
import { QUEUE, hostQueueName as defaultHostQueueName } from "./queue.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { lastCompleteLineEnd, normalizeHost, validPointer } from "./run-checkpoint.mjs";

/** The most recoveries one run gets: the original, then `.r1`, then `.r2`. A third crash fails the run as before. */
export const RECOVERY_CAP = 2;

/**
 * How long a queued recovery may wait for its host before the host-lost sweep takes it back off the queue and says so.
 * Six hours: a host that reboots, or a worker that restarts on failure, is back in minutes; one that is still away after
 * a working day's morning is an operator's problem, and the run's issue deserves to be told rather than to wait for the
 * checkpoint's seven-day life. Not tied to that life on purpose: the pointer outliving the recovery is harmless, the
 * reverse would strand a job.
 */
export const RECOVERY_TTL_MS = 6 * 3600 * 1000;

/** The claim's life: as long as the checkpoint pointer's, so a claim cannot expire under a run that can still recover. */
export const RECOVERY_CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;

/** `run:recover:claim:<sanitized run id>:<n>`, SET NX: exactly one enqueuer wins recovery n of a run. */
export const RECOVER_CLAIM_PREFIX = "run:recover:claim:";

/**
 * The longest a recovery may be kept waiting for a host that is still ALIVE (in the host registry) or whose queue is
 * paused: the checkpoint pointer's life, past which there is nothing left to recover from anyway.
 */
export const RECOVERY_MAX_WAIT_MS = 7 * 24 * 3600 * 1000;

/** How far one extension moves a due recovery's deadline when its host is alive or its queue paused. */
export const RECOVERY_EXTEND_MS = 3600 * 1000;

/**
 * Per-ATTEMPT hold state the processor writes onto the queue job (`job.updateData` in index.mjs: the rootful Podman
 * restart hold, the rootless network keeper's young hold and its crash-loop marks). Each describes the attempt that
 * wrote it, and copied into a recovery it would make the recovery's first pickup believe it had already been holding
 * (a hold that expires at once, a crash loop counted from the crashed attempt's restarts). Stripped from the recovery's
 * data. `enqueueNonce` is a reporting producer's mark for its own add, meaningless on any other job. A test reads every
 * key index.mjs writes through `updateData` and requires each to be stripped here or kept on purpose
 * (`RECOVERY_KEPT_HOLD_KEYS`), so a new hold field cannot leak in silence.
 */
export const RECOVERY_STRIPPED_KEYS = Object.freeze(["podmanRestartHoldSinceMs", "podmanRestartHoldLastMs", "netnsKeeperHoldSinceMs", "netnsKeeperHoldLastMs", "netnsKeeperHoldStartedMs", "netnsKeeperLoopSeen", "enqueueNonce"]);

/** Keys index.mjs writes through `updateData` that a recovery deliberately KEEPS. None today; the test reads this list. */
export const RECOVERY_KEPT_HOLD_KEYS = Object.freeze([]);

/** The recovery's data: the original's, less every per-attempt key, plus the three recovery fields. */
export function recoveryDataOf(data, { runId, n, recoverBy }) {
	const out = { ...data };
	for (const key of RECOVERY_STRIPPED_KEYS) delete out[key];
	return { ...out, recoveryOf: runId, recovery: n, recoverBy };
}

/**
 * One sorted set for the fleet: member = the recovery's queue, id, the host holding its checkpoint and when it was
 * enqueued (for the hard maximum); score = its current deadline (`recoverBy`, moved on by each extension).
 */
export const RECOVER_PENDING_KEY = "run:recover:pending";

/** The queue states a job can still be picked up from, so the host-lost sweep may take it back. */
const NOT_STARTED_STATES = new Set(["waiting", "delayed", "prioritized", "paused", "waiting-children"]);

/** The worker-name charset (config.mjs), duplicated for queue.mjs's reason: a pointer is peer-written data. */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A job directory's basename as `mkdtemp(join(jobsDir, "job-"))` makes it. Nothing else is ever joined to jobsDir. */
const JOB_DIR_RE = /^job-[A-Za-z0-9_-]{1,64}$/;

/**
 * The run a queue job belongs to: its own id, or for a recovery the id of the run it continues. Every per-RUN key (the
 * progress key, the live stream, the status comment's id, the checkpoint pointer and store) is spelled from this, never
 * from `job.id`; the run RECORD stays per job id (a `.r1` writes its own, carrying `recoveryOf`).
 */
export function runIdOf(job) {
	const of = job?.data?.recoveryOf;
	return typeof of === "string" && of !== "" ? of : job?.id;
}

/** Whether a job's data arms a recovery (v1: forge jobs only; a local job with recover is `recoverSkipped: "local"`). */
export function isRecoveryArmed(data) {
	return data?.recover === true && data?.kind !== "local";
}

/** The recovery job id; null when bullmq would refuse it (a colon count other than none or exactly two). */
export function recoveryJobId(runId, n) {
	if (typeof runId !== "string" || runId === "" || !Number.isSafeInteger(n) || n < 1) return null;
	const id = `${runId}.r${n}`;
	if (id.includes(":") && id.split(":").length !== 3) return null;
	return id;
}

/** The claim key of recovery `n` of `runId`. Sanitized like every other per-run key, so one spelling per run. */
export const recoveryClaimKey = (runId, n) => `${RECOVER_CLAIM_PREFIX}${sanitizeJobId(runId)}:${n}`;

/** The pending set's member, as JSON so no part has to be a separator-free string. */
export const pendingMember = (queueName, jobId, host, at) => JSON.stringify({ q: queueName, id: jobId, host, at });

function parsePendingMember(member) {
	try {
		const m = JSON.parse(String(member));
		if (m && typeof m.q === "string" && m.q !== "" && typeof m.id === "string" && m.id !== "" && typeof m.host === "string" && HOST_RE.test(m.host) && Number.isSafeInteger(m.at)) return m;
	} catch {}
	return null;
}

/** A pointer is peer-written (another host wrote it), so its routing fields are re-checked before they route. */
function pointerRoute(pointer) {
	if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return null;
	if (typeof pointer.host !== "string" || !HOST_RE.test(pointer.host)) return null;
	if (pointer.hostQueue !== null && pointer.hostQueue !== undefined && typeof pointer.hostQueue !== "string") return null;
	return { host: pointer.host, hosted: typeof pointer.hostQueue === "string" && pointer.hostQueue !== "" };
}

const codeOf = (err) => (typeof err?.code === "string" ? err.code : typeof err?.name === "string" ? err.name : "error");

/**
 * `makeRecoveryEnqueuer({ redis, queues, hostQueueName, now, log, ttlMs, cap })` -> `enqueueRecovery({ job, cause,
 * pointer })`.
 *
 * - `queues.shared()` is the shared queue's handle, `queues.host(name)` a host queue's by its full name. The recovery
 *   goes to `hostQueueName(pointer.host)` when the pointer says its host drains a host queue (`pointer.hostQueue`),
 *   else to the shared queue: an unnamed deployment is one host, and its shared queue is drained only by it.
 * - Answers `{ enqueued: true, jobId, n, queue }` or `{ enqueued: false, reason }`; it NEVER throws, because both
 *   callers (the processor's infra exit and the stall listener) must fall back to today's path on any failure, loudly,
 *   rather than lose the run between the two.
 *
 * THE CLAIM. `SET run:recover:claim:<run>:<n> NX`. The winner adds the job and records it pending. A LOSER does not
 * report "not enqueued": that would send its caller down today's path (a retry from zero beside the recovery, or a
 * failure comment on a run that is continuing). It asks the target queue whether the job exists and, when it does not
 * (the winner crashed between its claim and its add, or is mid-add), adds it itself: the custom id makes that add
 * idempotent (bullmq answers an existing id with the stored job), so two enqueuers can never make two jobs, and a
 * winner that died after claiming cannot strand the run either.
 */
export function makeRecoveryEnqueuer({ redis, queues, hostQueueName = defaultHostQueueName, now = () => Date.now(), log = () => {}, ttlMs = RECOVERY_TTL_MS, cap = RECOVERY_CAP, claimTtlMs = RECOVERY_CLAIM_TTL_MS } = {}) {
	if (!redis || typeof queues?.shared !== "function" || typeof queues?.host !== "function") throw new TypeError("makeRecoveryEnqueuer needs redis and queues { shared, host }");

	return async function enqueueRecovery({ job, cause, pointer } = {}) {
		const data = job?.data;
		if (!data || typeof data !== "object") return { enqueued: false, reason: "no-job" };
		if (data.recover !== true) return { enqueued: false, reason: "not-armed" };
		if (data.kind === "local") return { enqueued: false, reason: "local" };
		const runId = runIdOf(job);
		const prior = Number.isSafeInteger(data.recovery) && data.recovery >= 0 ? data.recovery : 0;
		const n = prior + 1;
		const logged = { jobId: job.id, runId, n, cause: cause === "stall" ? "stall" : "infra" };
		if (n > cap) {
			log("job_recovery_refused", { ...logged, reason: "recovery-cap" });
			return { enqueued: false, reason: "recovery-cap" };
		}
		const route = pointerRoute(pointer);
		if (!route) {
			log("job_recovery_refused", { ...logged, reason: "pointer-invalid" });
			return { enqueued: false, reason: "pointer-invalid" };
		}
		const jobId = recoveryJobId(runId, n);
		if (!jobId) {
			log("job_recovery_refused", { ...logged, reason: "job-id-refused" });
			return { enqueued: false, reason: "job-id-refused" };
		}
		const queueName = route.hosted ? hostQueueName(route.host) : QUEUE;
		const claimKey = recoveryClaimKey(runId, n);
		let claimed = false;
		try {
			claimed = (await redis.set(claimKey, route.host, "PX", claimTtlMs, "NX")) === "OK";
			const queue = route.hosted ? queues.host(queueName) : queues.shared();
			if (!claimed && (await queue.getJob(jobId))) {
				log("job_recovery_enqueued", { ...logged, recoveryJobId: jobId, queue: queueName, claimed: false });
				return { enqueued: true, jobId, n, queue: queueName };
			}
			const at = now();
			const recoverBy = at + ttlMs;
			const recoveryData = recoveryDataOf(data, { runId, n, recoverBy });
			await queue.add(job.name ?? data.kind, recoveryData, {
				jobId,
				attempts: 1,
				// The forge jobs' retention (queue.mjs enqueueForgeJob), so a recovery is as visible as the run it continues.
				removeOnComplete: { age: 31 * 24 * 3600 },
				removeOnFail: { age: 31 * 24 * 3600 },
			});
			// Whoever ADDED records it pending, the winner or a loser that found the job missing: a loser's add is the only
			// add a stranded run gets, and without its member the host-lost backstop would never look at it. Two members for
			// one job (a winner mid-add and a loser) are harmless: the second the sweep reads finds the job gone or started.
			try {
				await redis.zadd(RECOVER_PENDING_KEY, recoverBy, pendingMember(queueName, jobId, route.host, at));
			} catch (err) {
				// The job is queued; only the host-lost backstop is missing for it. Said, never swallowed.
				log("job_recovery_pending_failed", { ...logged, recoveryJobId: jobId, code: codeOf(err) });
			}
			log("job_recovery_enqueued", { ...logged, recoveryJobId: jobId, queue: queueName, claimed });
			return { enqueued: true, jobId, n, queue: queueName };
		} catch (err) {
			// Release a claim this call took, so the caller's fallback (an InfraRetry, whose next attempt reaches here
			// again with the same n) is not answered "already claimed" for a job that was never added.
			if (claimed) await Promise.resolve(redis.del(claimKey)).catch(() => {});
			log("job_recovery_enqueue_failed", { ...logged, code: codeOf(err) });
			return { enqueued: false, reason: "enqueue-failed" };
		}
	};
}

/**
 * The host-lost sweep: a recovery that is still waiting past its `recoverBy`, whose host is GONE, is taken off the queue,
 * and `onLost(job)` tells its run (the start wiring posts the `recovery-host-lost` comment and fires on_failure).
 *
 * A DEADLINE IS NOT A VERDICT. A recovery can wait past it on a host that is perfectly alive: a scoped pause window
 * delays it, an operator paused the queue, a saturated host has no slot. Failing those runs with "the worker has not
 * come back" would be a false comment and a false page. So at the deadline the sweep asks: is the checkpoint's host in
 * the host registry (`liveHosts()`, its heartbeat rows, a Set of names, or null when the registry could not be read), or
 * is the queue paused? Either, or a registry it could not read (a Valkey blip is not a lost host), EXTENDS the deadline
 * by `extendMs` instead. Only a host absent from a readable registry is lost, and the extensions stop at the hard
 * maximum (`maxWaitMs` after the enqueue, the checkpoint pointer's life): past it the run is lost whatever the host says,
 * since there is nothing left to recover from.
 *
 * Fleet-safe without a lock: each due member is CLAIMED by its `ZREM` (1 for exactly one caller), so two hosts sweeping
 * at once act on disjoint members. A member whose handling faults after its claim is put back with its own score, so the
 * next sweep tries it again rather than the run waiting for ever with nothing said. A recovery that already started,
 * finished or vanished is only dropped from the set: it is not lost, it is past needing the backstop.
 */
export function makeHostLostSweep({ redis, queues, now = () => Date.now(), log = () => {}, onLost = async () => {}, liveHosts = async () => null, extendMs = RECOVERY_EXTEND_MS, maxWaitMs = RECOVERY_MAX_WAIT_MS, batch = 100 } = {}) {
	return async function sweepHostLost() {
		// Read once per sweep, and only when something is due: a sweep with nothing due costs one ZRANGEBYSCORE.
		let hosts;
		const hostsNow = async () => {
			if (hosts === undefined) {
				try {
					hosts = await liveHosts();
				} catch {
					hosts = null;
				}
			}
			return hosts;
		};
		let due;
		try {
			due = await redis.zrangebyscore(RECOVER_PENDING_KEY, "-inf", now(), "WITHSCORES", "LIMIT", 0, batch);
		} catch (err) {
			log("recovery_host_lost_sweep_failed", { code: codeOf(err) });
			return { skipped: "read-failed" };
		}
		const out = { claimed: 0, removed: 0, settled: 0, extended: 0 };
		for (let i = 0; i + 1 < due.length; i += 2) {
			const member = due[i];
			const score = due[i + 1];
			let mine;
			try {
				mine = (await redis.zrem(RECOVER_PENDING_KEY, member)) === 1;
			} catch (err) {
				log("recovery_host_lost_sweep_failed", { code: codeOf(err) });
				continue;
			}
			if (!mine) continue;
			out.claimed++;
			const m = parsePendingMember(member);
			if (!m) {
				log("recovery_pending_malformed", {});
				continue;
			}
			try {
				const queue = m.q === QUEUE ? queues.shared() : queues.host(m.q);
				const job = await queue.getJob(m.id);
				const state = job ? await job.getState() : "missing";
				if (!job || !NOT_STARTED_STATES.has(state)) {
					out.settled++;
					continue;
				}
				const hard = m.at + maxWaitMs;
				if (now() < hard) {
					const paused = typeof queue.isPaused === "function" ? await queue.isPaused().catch(() => false) : false;
					const live = await hostsNow();
					const why = paused === true ? "queue-paused" : live === null ? "registry-unreadable" : live.has(m.host) ? "host-alive" : null;
					if (why) {
						const next = Math.min(now() + extendMs, hard);
						await redis.zadd(RECOVER_PENDING_KEY, next, member);
						out.extended++;
						log("job_recovery_deadline_extended", { jobId: m.id, queue: m.q, reason: why, until: next });
						continue;
					}
				}
				// `remove` refuses a job that became active (locked) in between: that throw lands in the catch below and puts
				// the member back, and the next sweep finds it active and drops it.
				await job.remove();
				out.removed++;
				log("job_recovery_host_lost", { jobId: m.id, runId: runIdOf(job), queue: m.q, state, reason: now() >= hard ? "max-wait" : "host-absent" });
				try {
					await onLost(job);
				} catch (err) {
					log("job_recovery_host_lost_notify_failed", { jobId: m.id, code: codeOf(err) });
				}
			} catch (err) {
				log("recovery_host_lost_sweep_failed", { jobId: m.id, code: codeOf(err) });
				await Promise.resolve(redis.zadd(RECOVER_PENDING_KEY, score, member)).catch(() => {});
			}
		}
		return out;
	};
}

/**
 * Salvage: a recovery job that lands on the host that crashed may find the crashed attempt's job directory still there
 * (`pointer.jobDir` under jobsDir). Its workspace and transcript are newer than the last live checkpoint, so one more
 * checkpoint is taken FROM them (kind `salvage`, quiesced `dead`: the boot reaper stopped every job container before
 * this worker took a job), then the directory is removed.
 *
 * `salvage({ runId, pointer, attempt })` -> `{ salvaged: true, seq } | { skipped: reason } | { refused: reason }`. It
 * never throws. It needs an existing checkpoint (`readManifest`): the base commit and the run's meta (pi version, image,
 * venue, model) come from it, because a crashed attempt left nothing else this host can trust for them, and a salvage
 * whose meta differed from the restore's gate would only be refused there. Paths: the only thing ever joined to jobsDir
 * is a basename matching `job-<chars>`, lstat'd as a real directory, so a pointer cannot name `..`, a link or a file.
 *
 * RESIDUAL, stated: the crashed attempt's secret VALUES (its forge token, its resolved run.secrets) died with it, so the
 * snapshot's secret scan runs without them. The store is host-private (0700) and never mounted, a forge token expires
 * within the hour, and the restore puts the bytes back only into the same run's workspace; but a resolved secret the
 * agent wrote into a file is stored where a live checkpoint would have refused it.
 */
export function makeSalvager({ jobsDir, hostName, workspaceCheckpointer, runCheckpointer = null, fs = nodeFsp, log = () => {} } = {}) {
	return async function salvage({ runId, pointer, attempt = 0 } = {}) {
		try {
			if (!workspaceCheckpointer || !jobsDir) return { skipped: "no-store" };
			if (typeof runId !== "string" || runId === "") return { skipped: "bad-args" };
			// The pointer's host is the run checkpointer's normalised token, so this host is compared in the same spelling.
			if (!pointer || pointer.host !== normalizeHost(hostName)) return { skipped: "other-host" };
			if (typeof pointer.jobDir !== "string" || !JOB_DIR_RE.test(pointer.jobDir)) return { skipped: "no-job-dir" };
			const dir = join(jobsDir, pointer.jobDir);
			const st = await fs.lstat(dir).catch(() => null);
			if (!st?.isDirectory()) return { skipped: "absent" };
			let result;
			try {
				result = await snapshotFrom(dir);
			} finally {
				// Removed whatever the snapshot said: the run continues from the newest checkpoint either way, and a stale job
				// directory left behind is disk nothing will ever read again.
				await fs.rm(dir, { recursive: true, force: true }).catch((err) => log("salvage_remove_failed", { code: codeOf(err) }));
				// The container id file runContainer writes BESIDE the job dir (`<jobDir>.cid`) goes with it (lab of #645: one
				// was left per crashed attempt). `force` and no recursion: a missing file is fine and a link is removed as a link.
				await fs.rm(`${dir}.cid`, { force: true }).catch((err) => log("salvage_remove_failed", { code: codeOf(err) }));
			}
			log("checkpoint_salvage", { runId: sanitizeJobId(runId), ...(result.salvaged ? { seq: result.seq } : { skipped: result.skipped ?? null, refused: result.refused ?? null }) });
			return result;
		} catch (err) {
			log("checkpoint_salvage", { runId: sanitizeJobId(runId), skipped: "internal-error", code: codeOf(err) });
			return { skipped: "internal-error" };
		}

		async function snapshotFrom(dir) {
			const read = await workspaceCheckpointer.readManifest(runId);
			if (!read?.ok) return { skipped: "no-checkpoint" };
			const m = read.manifest;
			const transcriptFile = join(dir, "session", "current.jsonl");
			// run-checkpoint.mjs's own reader: O_NOFOLLOW, a regular file only (the file is the agent's, `/session` is mounted
			// read-write), the end of the last COMPLETE line, so a line the writer died appending is left out.
			const offset = await lastCompleteLineEnd(transcriptFile, { fs });
			if (offset === null) return { skipped: "no-transcript" };
			// A transcript shorter than the one the checkpoint already holds is not newer: salvaging it would move the run
			// BACKWARDS (a session file that was truncated, or one from another attempt).
			if (offset < m.transcript.bytes) return { skipped: "transcript-older" };
			const meta = { piVersion: m.piVersion, imageDigest: m.imageDigest, venue: m.venue, provider: m.provider, model: m.model };
			const runAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? Math.min(attempt, 10_000) : 0;
			// Through the run checkpointer when there is one (run-checkpoint.mjs): a handle opened WITHOUT pause verbs, whose
			// `exit({ kind: "salvage" })` numbers the checkpoint past the manifest and the pointer, reads the offset itself and
			// rewrites the pointer after the commit, exactly as an exit checkpoint does. The direct snapshot below is the
			// fallback for a host whose run checkpointer did not load: the same checkpoint, without the pointer rewrite.
			if (runCheckpointer && typeof runCheckpointer.open === "function") {
				const handle = runCheckpointer.open({ runId, attempt: runAttempt, jobDir: dir, workspace: join(dir, "workspace"), sessionFile: transcriptFile, baseSha: m.workspace.baseSha, branch: m.workspace.git?.branch ?? null, secretValues: [], meta });
				try {
					const r = await handle.exit({ kind: "salvage" });
					return Number.isSafeInteger(r?.seq) ? { salvaged: true, seq: r.seq } : { skipped: r?.skipped ?? "snapshot-failed" };
				} finally {
					await Promise.resolve(handle.close?.()).catch(() => {});
				}
			}
			const pointerSeq = Number.isSafeInteger(pointer.seq) ? pointer.seq : 0;
			const seq = Math.max(m.seq, pointerSeq) + 1;
			const r = await workspaceCheckpointer.snapshot({
				runId,
				workspace: join(dir, "workspace"),
				baseSha: m.workspace.baseSha,
				seq,
				branch: m.workspace.git?.branch ?? null,
				secretValues: [],
				attempt: runAttempt,
				kind: "salvage",
				quiesced: "dead",
				transcript: { srcFile: transcriptFile, offset },
				meta,
			});
			if (r?.ok) return { salvaged: true, seq: r.seq };
			return r?.refused ? { refused: r.refused } : { skipped: r?.skipped ?? "snapshot-failed" };
		}
	};
}

/**
 * The job directories a checkpoint pointer of THIS host still names: a crashed run's stale directory, kept for its
 * recovery's salvage. SCAN over `run:checkpoint:*`, bounded; throws on a Valkey fault, so the caller skips the orphan
 * sweep rather than delete a directory a recovery was about to salvage.
 */
export async function pointedJobDirs({ redis, hostName, maxKeys = 10_000, count = 500 } = {}) {
	const keep = new Set();
	let cursor = "0";
	let seen = 0;
	do {
		const [next, keys] = await redis.scan(cursor, "MATCH", "run:checkpoint:*", "COUNT", count);
		cursor = next;
		seen += keys.length;
		if (keys.length > 0) {
			const values = await redis.mget(...keys);
			for (const raw of values) {
				try {
					const p = validPointer(JSON.parse(raw));
					if (p?.host === normalizeHost(hostName)) keep.add(p.jobDir);
				} catch {}
			}
		}
		// Over the bound, the answer is incomplete, and an incomplete keep-list deletes what it missed: refuse instead.
		if (seen > maxKeys) throw Object.assign(new Error("too many checkpoint pointers to read at boot"), { code: "too-many-pointers" });
	} while (cursor !== "0");
	return keep;
}

/**
 * The boot sweep of orphaned `jobs/job-*` directories: what a crashed worker left behind (the processor's cleanup never
 * ran). Only a name `mkdtemp` makes, only a REAL directory (lstat: a link is never followed, never removed through), only
 * one older than `olderThanMs` (the job timeout bounds every running job's life, so nothing running here can own it), and
 * never one in `keep` (a pointer names it for a salvage). `fs.rm` recursive removes a link inside as the link, without
 * following it. Never throws; per-entry faults are counted and logged by code.
 */
export async function sweepOrphanJobDirs({ jobsDir, olderThanMs, now = () => Date.now(), keep = new Set(), fs = nodeFsp, log = () => {} } = {}) {
	const out = { removed: 0, kept: 0, failed: 0 };
	let names;
	try {
		names = await fs.readdir(jobsDir);
	} catch (err) {
		if (err?.code !== "ENOENT") log("job_dir_sweep_failed", { code: codeOf(err) });
		return out;
	}
	const present = new Set(names);
	for (const name of names) {
		// A stale `<jobDir>.cid` whose job dir is already gone (a crash after the dir's removal, or one left by a salvage
		// before #645's lab fix): only a regular file, only past the same age bound.
		if (name.endsWith(".cid") && JOB_DIR_RE.test(name.slice(0, -4)) && !present.has(name.slice(0, -4))) {
			try {
				const st = await fs.lstat(join(jobsDir, name));
				if (st.isFile() && now() - st.mtimeMs > olderThanMs) {
					await fs.rm(join(jobsDir, name), { force: true });
					out.removed++;
				} else out.kept++;
			} catch (err) {
				out.failed++;
				log("job_dir_sweep_failed", { code: codeOf(err) });
			}
			continue;
		}
		if (!JOB_DIR_RE.test(name)) continue;
		const dir = join(jobsDir, name);
		try {
			const st = await fs.lstat(dir);
			if (!st.isDirectory() || keep.has(name) || now() - st.mtimeMs <= olderThanMs) {
				out.kept++;
				continue;
			}
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rm(`${dir}.cid`, { force: true });
			out.removed++;
		} catch (err) {
			out.failed++;
			log("job_dir_sweep_failed", { code: codeOf(err) });
		}
	}
	if (out.removed || out.failed) log("job_dirs_swept", out);
	return out;
}
