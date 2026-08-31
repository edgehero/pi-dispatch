/**
 * Which queue a forge delivery is enqueued onto, when the deployment runs on more than one machine
 * (issue #57, `OQ-032`).
 *
 * The receiver is the only process that can make this decision. Routing has to happen at ENQUEUE -- a
 * delayed job is promoted on each worker's own clock, so the fastest clock wins every attempt and a job
 * cannot reliably be handed from a host that will not serve it to one that will -- and forge deliveries are
 * enqueued here. `capabilities.mjs` owns the RULE and is shared with the worker so the two cannot drift;
 * this module owns the plumbing: one cached registry read, and a pool of queue handles.
 *
 * EVERYTHING HERE FAILS OPEN ONTO THE SHARED QUEUE, which is what this receiver did before any of it
 * existed. An unreadable registry, a timed-out read, a malformed row, a name that is not routable: every
 * one of them returns the shared queue, so the worst this can do is fail to improve on a coin flip. A
 * webhook handler is the wrong place to invent a new way to drop work.
 */

import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { makeQueue, hostQueueName } from "@edgehero/pi-dispatch/queue";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { forgeDeliveryJobId } from "@edgehero/pi-dispatch/job-id";
import { jobNeeds, routeForgeJob } from "@edgehero/pi-dispatch/capabilities";

/**
 * How long a registry read is reused.
 *
 * The registry beats every 15s, so anything below that mostly re-reads a value that cannot have changed.
 * Five seconds is well inside one beat and bounds the extra load a busy receiver puts on Valkey at one read
 * per five seconds rather than one per delivery -- and a delivery burst, which is exactly when this must
 * not add latency, is served entirely from cache.
 *
 * Staleness costs nothing that freshness would have saved: a host that appears within the window is missed
 * and its work goes to the shared queue, which is today's behaviour, and a host that vanishes is already
 * guarded by `ROUTE_FRESH_MS` on the row's own beat timestamp.
 */
const HOSTS_TTL_MS = 5_000;

/** Bound on the registry read itself. A routing hint is never worth making a webhook wait. */
const READ_TIMEOUT_MS = 1_500;

/**
 * @returns {{queueFor: (kind: string, job: object) => Promise<object>, close: () => Promise<void>}}
 */
export function makeForgeRouter({
	valkeyUrl,
	shared,
	log = () => {},
	makeQueueFn = makeQueue,
	parseConnectionFn = parseConnection,
	redisFn = makeRedisClient,
	readLiveHostsFn = readLiveHosts,
	now = () => Date.now(),
	ttlMs = HOSTS_TTL_MS,
} = {}) {
	const pool = new Map(); // queue name -> Queue, opened lazily and only for hosts actually routed to
	let redis = null;
	let cached = { at: -Infinity, hosts: [] };
	let inFlight = null;

	// One read at a time. Without this a burst of deliveries arriving on a cold cache each start their own
	// registry read, which is the moment the deployment can least afford N of them.
	const hosts = async () => {
		if (now() - cached.at < ttlMs) return cached.hosts;
		if (inFlight) return await inFlight;
		inFlight = (async () => {
			try {
				if (!redis) {
					redis = redisFn(valkeyUrl);
					// A receiver must never print ioredis reconnect noise into its own log: this client is an
					// optimisation, and its failures are already handled by falling back to the shared queue.
					redis.on?.("error", () => {});
				}
				const res = await readLiveHostsFn(redis, { timeoutMs: READ_TIMEOUT_MS });
				cached = { at: now(), hosts: Array.isArray(res?.hosts) ? res.hosts : [] };
			} catch {
				// Cache the FAILURE too, so an unreachable Valkey costs one read per window rather than one
				// per delivery. The empty list routes everything to the shared queue.
				cached = { at: now(), hosts: [] };
			} finally {
				inFlight = null;
			}
			return cached.hosts;
		})();
		return await inFlight;
	};

	return {
		async queueFor(kind, job) {
			const needs = jobNeeds(job);
			// The overwhelming majority of deliveries bind neither a secret profile nor a wait profile, and
			// they must not pay even a cache lookup for a decision that cannot apply to them.
			if (needs.length === 0) return shared;

			let name = null;
			try {
				name = routeForgeJob({ hosts: await hosts(), needs, jobId: forgeDeliveryJobId(kind, job?.trigger?.deliveryId, job?.replica) });
			} catch {
				return shared; // an unroutable id, a bad row: the shared queue is always a correct answer
			}
			if (!name) return shared;

			const queueName = hostQueueName(name);
			if (!pool.has(queueName)) pool.set(queueName, makeQueueFn(parseConnectionFn(valkeyUrl), { name: queueName }));
			// Logged because a routed job is the one case where "which host ran it" was DECIDED rather than
			// observed, and an operator debugging a job that never started needs to know it was sent
			// somewhere specific. Host names are deployment topology: this reaches the log, never a forge
			// comment (`triggers.mjs` sets that rule for refusal messages and it holds here).
			log({ event: "forge_job_routed", kind, host: name, needs: needs.join(",") });
			return pool.get(queueName);
		},
		async close() {
			for (const q of pool.values()) {
				try {
					await q.close();
				} catch {
					// best-effort teardown
				}
			}
			pool.clear();
			try {
				redis?.disconnect?.();
			} catch {
				// best-effort teardown
			}
		},
	};
}
