/**
 * `pi-dispatch cancel <jobId>` (issue #287): the operator's stop for ONE job, whatever state it is in.
 *
 * VALKEY_URL-only like `pause`, and for the same reason: stopping a job must work even when forge auth is
 * misconfigured. The verb finds the job across every queue this deployment drains (the kill switch's own
 * fleet discovery), then dispatches on what the job IS:
 *
 *   held on run.waitFor  -> the shared removeHeldJob sequence (hold keys first, then the job); no record,
 *                           because the job never ran (the dispatch_wait_cancel rule).
 *   delayed / queued     -> job.remove(); no record, same rule.
 *   active               -> a `cancel:req` key + a brief ack poll (cancel-state.mjs), because the abort can
 *                           only be raised by the process that holds the job. No ack within the window is a
 *                           NAMED failure, never a silent one: the job may be on a host that is down, or on
 *                           a worker predating this verb.
 *
 * Held is checked BEFORE the plain state dispatch: a held job IS delayed, and removing it through the plain
 * path would strand its wait:* keys as a panel row for a job that no longer exists.
 */

import { cancelReqKey, removeHeldJob, requestCancel } from "./cancel-state.mjs";
import { jobKey } from "./wait-state.mjs";

/** Same budget the kill switch gives the host registry before acting on what the keyspace alone says. */
const FLEET_READ_TIMEOUT_MS = 2_000;

/**
 * Run the cancel. Returns the process exit code. Every collaborator is a seam with the production default,
 * so tests drive states and races without a queue; `write` is the stdout seam cli.mjs already injects.
 */
export async function runCancel(jobId, url, { write = (chunk) => process.stdout.write(chunk), errWrite = (chunk) => process.stderr.write(chunk), redisFn, queueFn, parseConnectionFn, readLiveHostsFn, discoverHostQueuesFn, fleetQueueNamesFn, unionQueueNamesFn, ackTimeoutMs = 10_000, pollMs = 250, sleep } = {}) {
	const fail = (message) => {
		errWrite(`error: ${message}\n`);
		return 1;
	};
	if (typeof jobId !== "string" || jobId === "") {
		return fail("a job id is required: pi-dispatch cancel <jobId>  (ids are in `pi-dispatch status`, the panel, and the run log)");
	}
	// Lazy imports, the pause verb's shape: a mistyped id must not load bullmq before it can be refused.
	const { parseConnection, makeRedisClient } = await import("./connection.mjs");
	const { fleetQueueNames, discoverHostQueues, unionQueueNames, makeQueue } = await import("./queue.mjs");
	const { readLiveHosts } = await import("./host-registry.mjs");
	const parseConn = parseConnectionFn ?? parseConnection;
	const mkRedis = redisFn ?? makeRedisClient;
	const mkQueue = queueFn ?? makeQueue;
	const liveHosts = readLiveHostsFn ?? readLiveHosts;
	const discover = discoverHostQueuesFn ?? discoverHostQueues;
	const fleetNames = fleetQueueNamesFn ?? fleetQueueNames;
	const unionNames = unionQueueNamesFn ?? unionQueueNames;

	const probe = mkRedis(url);
	probe.on?.("error", () => {});
	const queues = [];
	let requested = false;
	try {
		// The job could sit on the shared queue or on any host's own (issue #57): find it the way pause
		// spans them, and fail OPEN but LOUDLY on a degraded registry read, exactly as the kill switch does.
		const [fleet, existing] = await Promise.all([
			liveHosts(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((error) => ({ unreachable: error?.message ?? String(error) })),
			discover(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }),
		]);
		const blind = fleet?.unreachable ?? null;
		const names = unionNames(fleetNames(fleet?.hosts), existing);

		// Constructed INSIDE the try (the pause loop's leak posture); first queue that knows the id wins.
		// Job ids are delivery GUIDs, `local-<hex>` or `repeat:<id>:<millis>`, so a cross-queue duplicate
		// is not a state this project can produce.
		let job = null;
		let owner = null;
		for (const name of names) {
			const q = mkQueue(parseConn(url, { failFast: true }), { name });
			queues.push(q);
			job = await q.getJob(jobId);
			if (job) {
				owner = q;
				break;
			}
		}
		if (!job) {
			return fail(`no job ${jobId} in ${names.length} queue(s)${blind ? ` [registry unreadable: ${blind} — a host that is not registered may still hold it]` : ""}`);
		}

		// Held FIRST (see the header). The hash tells held apart from plain-delayed; `since` is the clock
		// that makes it a real hold rather than a counter key.
		const hash = await probe.hgetall(jobKey(jobId)).catch(() => null);
		if (hash?.since) {
			const res = await removeHeldJob({ redis: probe, queue: owner, jobId });
			if (res.ok) {
				write(`cancelled ${jobId} — it was held on its wait condition and never ran; no record written\n`);
				return 0;
			}
			return fail(`could not cancel held job ${jobId}: ${res.invalid}`);
		}

		let state = await job.getState().catch(() => "unknown");
		if (state === "delayed" || state === "waiting" || state === "prioritized" || state === "paused") {
			try {
				await job.remove();
				write(`removed ${jobId} (${state}) — it never ran; no record written\n`);
				return 0;
			} catch (error) {
				// The one race worth handling by name: picked up between getState and remove. remove() throws
				// on a locked job, so re-read and fall through to the active path rather than failing an
				// operator whose job is now exactly the case the active path exists for.
				state = await job.getState().catch(() => "unknown");
				if (state !== "active") return fail(`could not remove ${jobId} (${state}): ${error.message}`);
			}
		}

		if (state === "active") {
			requested = true;
			const res = await requestCancel({ redis: probe, jobId, ackTimeoutMs, pollMs, ...(sleep ? { sleep } : {}) });
			if (res.ack !== undefined) {
				write(`cancel accepted by ${res.ack === "" ? "the worker" : res.ack} — stopping the container (allow ~30s); the run record will say operator-cancel\n`);
				return 0;
			}
			return fail(`no worker acknowledged within ${Math.round(ackTimeoutMs / 1000)}s — the job is active but no reachable worker owns it (host down, or a worker predating cancel); nothing was changed`);
		}

		return fail(`job ${jobId} is ${state} — nothing to cancel`);
	} catch (error) {
		// Best-effort, and ONLY when a request was actually placed: an abandoned request must not fire
		// after the operator read an error and walked away -- but against a Valkey that is DOWN, a bare
		// del would sit in ioredis's retry queue and hold this process open long past the error message.
		if (requested) await Promise.race([Promise.resolve(probe.del?.(cancelReqKey(jobId))).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
		return fail(`could not reach Valkey at ${url} — is it running? (docker compose up)\n  ${error.message}`);
	} finally {
		probe.disconnect?.();
		for (const q of queues) await q.close().catch(() => {});
	}
}

