/**
 * Fleet-wide leases for the bounds that stopped meaning what they say when a second host appeared
 * (issue #57).
 *
 * `PI_WAIT_CHECK_SLOTS` and a `scoped-limits.json` row's `concurrent` are both enforced by
 * `makeInFlight()`, an in-process `Map`. One worker per docker daemon made that correct; two hosts make
 * it a bound that MULTIPLIES BY THE OPERATOR'S DEPLOYMENT SHAPE, which is not a bound. Four hosts with
 * `PI_WAIT_CHECK_SLOTS=1` run four concurrent checks against one Jira; four hosts with
 * `{"scope":"acme/web","concurrent":1}` run four paid containers on one repository.
 *
 * WHAT THIS OWES `OQ-008` AND `DES-CONCURRENCY-3`. Both refuse a Redis-held in-flight count, in terms:
 * "a Redis-held count would survive a crash WRONGLY -- a claim for a container the reaper just killed,
 * demanding TTL/heartbeat machinery, a second source of truth about what is running". Every clause of
 * that is about a CONTAINER, and the two leases here answer it differently:
 *
 *   The CHECK lease claims no container. It claims a subprocess this same process spawned, bounded by
 *   `PI_WAIT_CHECK_TIMEOUT_MS`, holding no folder and spending no money. Three properties invert. What a
 *   stale claim costs: a container claim is a folder mutex nobody holds and a job that never runs, while
 *   a check claim is one check deferred by at most the TTL. What contradicts it: the reaper is a second
 *   source of truth about containers and runs at boot with authority, while nothing enumerates,
 *   inspects or reaps a check. And how long it can be wrong: a container has no natural expiry, while a
 *   check has a hard, configured, small timeout, so the TTL is DERIVED rather than guessed.
 *
 *   The SCOPE claim really is for a container, so the refusal lands squarely -- and the answer is the
 *   boot reaper. It establishes, at boot, that this host holds no `pi-job-*` containers, so a claim
 *   whose value names this host is a claim for a container that no longer exists, and deleting it is not
 *   a second source of truth: it is the SAME source writing down what it just established. Making the
 *   reaper the claim's owner removes the contradiction rather than arguing around it.
 *
 *   The ENDPOINT claim (issue #503) is the third, and it is a scope claim in every property that matters
 *   here: a job takes one slot of a declared model server at pickup and holds it until its container is
 *   gone, so the claim is for a container, its TTL is the scope claim's, and the boot reaper owns it the
 *   same way. Local jobs take it too, where they skip the scope claim: a folder path names nothing across
 *   hosts, but an endpoint is one physical server.
 *
 * N INDEPENDENT KEYS, NEVER ONE COUNTER. A counter with one TTL loses every claim when it expires and
 * leaks a permanent `+1` on a crash; N `SET NX PX` keys mean a lost release costs exactly one slot for
 * exactly the TTL and never the whole semaphore. `wait:key:<dedupId>` is the in-repo precedent.
 *
 * And a property the in-process map does not have: RELEASE IS IDEMPOTENT here, because it deletes only a
 * key whose value is still ours. `makeInFlight().release` clamps at zero but a double release on a
 * `concurrent: 2` scope frees the other holder's slot.
 */

import { createHash } from "node:crypto";

/**
 * Sixteen hex of a sha256: the `localJobId` idiom, shared by the scope budget keys (`scopeKeyPrefix`) and the
 * two hashed slot keys below, so one spelling of "the hash of this name" exists. A hash rather than the name
 * itself because a scope legally contains `:` and `/`, which would collide with the key grammar.
 */
export const hash16 = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/** Slot keys. All live under a prefix an operator can see whole with one `KEYS`. */
export const checkSlotKey = (i) => `wait:check:${i}`;
export const scopeSlotKey = (hash, i) => `slot:s:${hash}:${i}`;
/**
 * A model endpoint's slots (issue #503): `slot:m:<hash16(id)>:<i>`. Hashed although an endpoint id is already
 * `[a-z0-9-]{1,32}`, so the three slot keys share one shape and the sweeper one argument list.
 */
export const endpointSlotKey = (hash, i) => `slot:m:${hash}:${i}`;

/**
 * Build a lease over `slots` numbered keys.
 *
 * `holder` is `<workerName>#<jobId>`: the worker-name charset excludes `#`, so the value decomposes and
 * the boot sweep can recognise its own claims without a second index to keep in step.
 *
 * FAIL OPEN, and in the GRANTING direction. A Valkey fault must never be able to wedge every wait in a
 * deployment or stop every scoped job; the in-process bound is still there underneath, so failing open
 * degrades the fleet bound to the per-host one, which is exactly the behaviour before this existed.
 */
/**
 * Compare-and-delete, in ONE server-side step (PR #518's gate). A GET followed by a DEL is not release-if-mine: between
 * the two, the claim can expire and another host take it, and the DEL then frees THAT host's slot (measured). The
 * script deletes only while the value is still ours.
 */
export const RELEASE_IF_MINE = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** The sweep's twin: delete only while the value starts with this host's `<workerName>#` prefix. */
export const DELETE_IF_PREFIX = 'local v = redis.call("get", KEYS[1]) if v and string.sub(v, 1, #ARGV[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export function makeFleetLease({ redis, holderPrefix, keyFor, ttlMs, now = () => Date.now(), log = () => {}, timeoutMs = 2_000 }) {
	// Bounded for `host-registry.mjs`'s reason, which applies to every module sharing this client:
	// `maxRetriesPerRequest: null` makes a command against an unreachable server QUEUE rather than reject,
	// so a try/catch around it catches nothing and an outage would hang the gate rather than fail it.
	const bounded = (p) =>
		new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("lease timeout")), timeoutMs);
			Promise.resolve(p).then(
				(v) => (clearTimeout(t), resolve(v)),
				(e) => (clearTimeout(t), reject(e)),
			);
		});

	return {
		/**
		 * Take one of `slots`, or `null` when they are all held. Returns a handle whose `release` and
		 * `refresh` act only on the key this call actually won.
		 *
		 * Probing starts at `hash(id) mod slots` rather than at 0. Without the rotation every host tries
		 * index 0 first, so a host can sit behind a busy slot while a free one exists two along -- a
		 * starvation that looks exactly like the capacity shortage the bound is meant to report.
		 */
		async acquire(id, { slots, keyArgs = [], ttlMs: perCall } = {}) {
			if (!Number.isFinite(slots) || slots < 1) return { ok: true, release: async () => {}, refresh: async () => true };
			const holder = `${holderPrefix}#${id}`;
			const start = Math.abs(hashCode(String(id))) % slots;
			const releaseIfMine = async (key) => {
				try {
					await bounded(redis.eval(RELEASE_IF_MINE, 1, key, holder));
				} catch {
					// The TTL is the backstop. A lost release costs one slot for one TTL.
				}
			};
			const attempted = [];
			for (let n = 0; n < slots; n++) {
				const key = keyFor(...keyArgs, (start + n) % slots);
				attempted.push(key);
				try {
					const won = await bounded(redis.set(key, holder, "PX", perCall ?? ttlMs, "NX"));
					if (!won) continue;
					return {
						ok: true,
						key,
						// Release-if-MINE, which is what makes this idempotent where the in-process map is not: a double
						// release cannot free another holder's slot, because the second call finds a value that is no
						// longer ours. Atomic, so a release after the TTL cannot free a claim another host took since.
						release: () => releaseIfMine(key),
						async refresh(nextMs = ttlMs) {
							try {
								if ((await bounded(redis.get(key))) !== holder) return false;
								await bounded(redis.pexpire(key, nextMs));
								return true;
							} catch {
								return true; // a blip is not a reason to believe we lost a slot we hold
							}
						},
					};
				} catch (err) {
					// Granting is the safe direction: the in-process bound is still underneath, so this
					// degrades the fleet-wide ceiling to the per-host one rather than to nothing.
					log("fleet_lease_unavailable", { reason: err?.message });
					// A TIMED-OUT SET IS NOT A FAILED ONE (PR #518's gate). The shared client queues commands rather
					// than rejecting them, so the SET this call gave up on can still land later and hold the slot for
					// a whole TTL in another host's way, with nobody left to release it (measured with a slow Valkey).
					// So the degraded handle still releases, best-effort and compare-and-delete, every key it tried:
					// only a key holding our own value is deleted, so a key that was never ours is left alone. A
					// release that runs before the late SET lands misses it, and the TTL is the backstop then.
					return { ok: true, degraded: true, release: async () => void (await Promise.all(attempted.map(releaseIfMine))), refresh: async () => true };
				}
			}
			return null;
		},
	};
}

/** A small, stable, non-cryptographic spread for the slot rotation. Not a key, so not a digest. */
function hashCode(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

/**
 * Delete every scope slot this host still claims, at boot, right after the container reaper.
 *
 * THIS IS THE ANSWER TO `OQ-008`, and its correctness rests entirely on one precondition: the reaper
 * must have ENUMERATED. `makeReaper` catches its own `docker ps` failure and logs `reaper_skipped`, and
 * on that path nothing was listed and nothing reaped -- so this host has NOT established that it holds
 * no containers, and its claims may be for containers that are still running. Sweeping then would free
 * slots for another host to start more alongside them, which is a money overrun rather than a tidy-up.
 * `makeInFlight`'s own escape ("a state where no NEW container can start either") does not transfer,
 * because the sweep frees slots for a DIFFERENT machine.
 *
 * Driven by config rather than by a scan: `scoped-limits.json` enumerates every scope that can carry a
 * claim and `concurrent` bounds the index, so this is `sum(concurrent)` GETs -- typically under twenty.
 * No `KEYS`, no `SCAN`, and no index set to leak.
 */
export function makeScopeClaimSweeper({ redis, workerName, limits, log = () => {}, timeoutMs = 2_000 }) {
	return makeClaimSweeper({ redis, workerName, keyFor: scopeSlotKey, rows: (limits ?? []).map((row) => ({ hash: row?.hash, count: Number(row?.concurrent) })), event: "scope_claims", log, timeoutMs });
}

/**
 * The sweep itself, over any hashed slot key (issue #503 added the endpoint slots beside the scope slots). Each row is
 * `{ hash, count }`: the hash the key is built from and how many indexes can carry a claim. `event` names the two log
 * lines, `<event>_sweep_skipped` and `<event>_swept`, so each lease's sweep says which it is.
 *
 * An endpoint's claim is for a container exactly as a scope's is (a job holds its slot for its whole run), so the
 * same precondition decides it: only after a reaper that enumerated.
 */
export function makeClaimSweeper({ redis, workerName, keyFor, rows, event, log = () => {}, timeoutMs = 2_000 }) {
	return async function sweep({ reaped }) {
		if (!reaped) {
			log(`${event}_sweep_skipped`, { reason: "reaper-skipped" });
			return { swept: 0, skipped: true };
		}
		const prefix = `${workerName}#`;
		let swept = 0;
		for (const row of rows ?? []) {
			const n = Number(row?.count);
			if (!Number.isFinite(n) || n < 1 || !row?.hash) continue;
			for (let i = 0; i < n; i++) {
				const key = keyFor(row.hash, i);
				try {
					// One atomic compare-and-delete per key, the release's own rule: a GET then DEL could delete a claim
					// another host took in between.
					if (Number(await withTimeout(redis.eval(DELETE_IF_PREFIX, 1, key, prefix), timeoutMs)) > 0) swept++;
				} catch (err) {
					// A REPLY error is about THIS key (a WRONGTYPE on a key someone else wrote under the prefix): the server
					// answered, so the next key is worth asking. Logged by key, never by value, and the sweep goes on
					// (PR #518's second gate).
					if (err?.name === "ReplyError") {
						log(`${event}_sweep_key_error`, { key, reason: String(err.message).slice(0, 200) });
						continue;
					}
					// Best-effort by contract: this is an OPTIMISATION over the TTL, never the mechanism, so it must never
					// block boot. It STOPS at the first fault (PR #518's gate): a Valkey that does not answer would
					// otherwise cost one timeout per key, 64 per endpoint, before the worker starts. A timeout or a connection
					// fault is about the server, so no other key would fare better.
					log(`${event}_sweep_skipped`, { reason: "valkey-fault", detail: err?.message, swept });
					return { swept, skipped: true };
				}
			}
		}
		if (swept > 0) log(`${event}_swept`, { count: swept });
		return { swept, skipped: false };
	};
}

function withTimeout(p, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("lease timeout")), ms);
		Promise.resolve(p).then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
}
