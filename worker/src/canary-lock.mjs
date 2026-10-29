import { randomUUID } from "node:crypto";

export const CANARY_LOCK_KEY = "dispatch:canary:exclusive";
export const CANARY_LEASE_MS = 60_000;
const RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** Worker pickup asks before any paid work. An unavailable store throws, never admits. */
export async function readBusy(redis) {
	return Boolean(await redis.get(CANARY_LOCK_KEY));
}

/** The lease owner alone may renew or release it; a timed-out owner cannot erase a successor. */
export async function acquireCanaryLease(redis, { token = randomUUID() } = {}) {
	if (await redis.set(CANARY_LOCK_KEY, token, "PX", CANARY_LEASE_MS, "NX") !== "OK") return null;
	return {
		async renew() { return Number(await redis.eval(RENEW, 1, CANARY_LOCK_KEY, token, CANARY_LEASE_MS)) === 1; },
		async release() { return Number(await redis.eval(RELEASE, 1, CANARY_LOCK_KEY, token)) === 1; },
	};
}

/** Discover host queues as well as the shared queue, then ask BullMQ's public active-count API. */
export async function canaryQueueNames(redis) {
	const names = new Set(["pi-jobs"]);
	let cursor = "0", scanned = 0;
	do {
		const next = await redis.scan(cursor, "MATCH", "bull:pi-jobs*:meta", "COUNT", 100);
		cursor = next[0];
		for (const key of next[1]) {
			if (++scanned > 4096) throw new Error("canary queue discovery exceeded its bound");
			const name = key.slice(5, -5);
			if (/^pi-jobs(?:@[A-Za-z0-9._-]{1,64})?$/.test(name)) names.add(name);
		}
	} while (cursor !== "0");
	return [...names];
}
