/**
 * The `host:` keyspace: which workers are alive, and what each one is (issue #57).
 *
 * Every gap in the multi-host issue wants the same missing fact -- WHICH HOSTS EXIST AND WHAT CAN EACH
 * ONE DO -- so one structure serves all of them rather than each growing its own. This module is that
 * structure and nothing else. It carries no configuration and no authority: every row is one host's
 * SELF-DESCRIPTION, published by that host, and no reader may write another's.
 *
 *   host:live            SET of worker names -- an index the READER prunes, never a source of truth
 *   host:h:<name>        HASH of that host's self-description, PEXPIRE'd on every beat
 *
 * WHY THIS IS NOT THE REDIS STATE `OQ-008` AND `DES-CONCURRENCY-3` REFUSED. That refusal is about a
 * claim whose truth-maker lives on the host while the claim lives in Redis -- an in-flight count
 * asserting a container the boot reaper had just killed, with no way for the two to notice they
 * disagree. Here the truth-maker IS the host process, and the refresh IS the claim: when the process
 * dies the claim stops being renewed and expires on its own. There is no reaper to contradict and no
 * second authority to drift from.
 *
 * The sharper test, and the one to apply to anything added here later: DELETE THE WHOLE `host:*`
 * KEYSPACE WHILE THE FLEET RUNS, and every host must behave exactly as it does today. That holds
 * because nothing here is consulted to decide anything a single-host deployment decides differently --
 * a reader that cannot read treats absence as "no peers", which is v1.6.1's behaviour. A Redis-side
 * toggle fails that test: deleting it loses the operator's edit. Anything that would fail it does not
 * belong in this keyspace.
 *
 * THE CONTENT RULE, which is a contract and not a style note: names, integers and digests. Never a
 * path, never a URL with credentials, never a repository name, never operator free text. This is
 * `targetFor`'s `local:<basename>` discipline applied to a Valkey value, and it earns its strictness
 * from the reader rather than the writer -- the panel is where an operator screenshots, and doctor
 * prints these rows. A value that must be carried but cannot satisfy the rule is HASHED before it gets
 * here (`scopeKeyPrefix`'s idiom), never abbreviated.
 */

/** The index. A SET cannot expire its members, so the leak is handled by the reader, as `wait:held` does. */
export const HOST_SET = "host:live";

/** One host's row. `h:` is a sub-namespace letter under one prefix, as `budget:` uses `w:`/`m:`/`t:`/`s:`. */
export const hostKey = (name) => `host:h:${name}`;

/** How often a live worker republishes. Cheap: three writes, off every job path. */
export const HOST_BEAT_MS = 15_000;

/**
 * How long a row outlives its last beat. SIX missed beats, not one or two: a heartbeat competes with the
 * event loop of a process whose whole job is spawning containers, so a single late beat is ordinary and
 * must not evict a healthy host. Ninety seconds is short enough that a crashed host stops being counted
 * within one panel refresh cycle of an operator noticing anything at all.
 */
export const HOST_TTL_MS = 90_000;

/**
 * Build the registry accessor. `redis` is the client the budget and the wait state already share.
 *
 * EVERY METHOD FAILS OPEN, and the direction is the design: a registry fault must be able to cost a
 * panel row and must never be able to invent a refusal. Nothing here is on the paid path, so there is no
 * case where throwing would be more correct than continuing.
 */
/**
 * How long any single registry command may take before it is treated as a failure.
 *
 * THIS BOUND IS THE WHOLE FAIL-OPEN MECHANISM, and getting it wrong is subtle enough to be worth the
 * paragraph. `makeRedisClient` sets `maxRetriesPerRequest: null`, which BullMQ's blocking connections
 * require and which means a command issued against an unreachable server does NOT reject -- it QUEUES,
 * forever. So a `try/catch` around it catches nothing: the failure mode of this client is a HANG, and a
 * hang is not an exception. Every `await` in this module therefore goes through `bounded`, which converts
 * "never answers" into "answered no" so the catch below can do its job.
 */
const REGISTRY_OP_TIMEOUT_MS = 2_000;

/** Reject rather than wait forever. See REGISTRY_OP_TIMEOUT_MS for why this is not optional here. */
function bounded(promise, ms = REGISTRY_OP_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		// NOT unref'd, deliberately. An unref'd timer does not fire when nothing else is holding the event
		// loop, so the bound would silently stop existing in exactly the situation it is for -- a shutdown
		// where the hung command is the last thing running. The cost is that a pending call can delay exit
		// by at most this timeout, which is the point: bounded, and short.
		const t = setTimeout(() => reject(new Error("registry timeout")), ms);
		Promise.resolve(promise).then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
}

export function makeHostRegistry({ redis, name, now = () => Date.now(), ttlMs = HOST_TTL_MS, log = () => {}, timeoutMs = REGISTRY_OP_TIMEOUT_MS }) {
	let timer = null;
	let facts = {};
	// Set the moment `close` is entered, so a beat already in flight cannot re-HSET the row AFTER the DEL
	// and recreate the very ghost `close` exists to remove.
	let closed = false;
	// Logged once per TRANSITION rather than once per beat: at four beats a minute, a Valkey outage would
	// otherwise drown the log it is meant to serve. `notePackageKey` sets this precedent and states it.
	let reachable = true;

	const write = async (fields) => {
		const key = hostKey(name);
		const flat = [];
		// A fact may be a VALUE or a THUNK. A thunk is what lets a fact that changes without a restart --
		// the cron fingerprint after a live triggers-file edit, the live concurrency after an overlay
		// change -- be re-read on every beat rather than frozen at the call that started the heartbeat.
		// Without it a peer would compare against what this host believed at boot, and two hosts would see
		// each other's fingerprint oscillate on the beat period after any edit.
		for (const [k, v] of Object.entries(fields)) {
			let resolved;
			try {
				resolved = typeof v === "function" ? v() : v;
			} catch {
				resolved = ""; // a fact that cannot be computed is absent, never a reason to skip the beat
			}
			const value = String(resolved ?? "");
			// THE CONTENT RULE, ENFORCED HERE rather than asserted in a test. A test can only check the fields
			// it happens to publish itself, so it could never catch the day someone adds `logsDir` at a call
			// site. This can: a value that is path-shaped is DROPPED and named, loudly, once.
			//
			// The rule is mechanical rather than a blanket ban on `/`, because one legitimate value contains
			// one: an IANA zone is `Europe/Amsterdam`. What no admissible value has is a filesystem ROOT -- a
			// leading separator, a backslash, or a drive letter.
			if (/^[/\\]|\\|^[A-Za-z]:[/\\]/.test(value)) {
				log("host_registry_field_refused", { host: name, field: k, reason: "path-shaped" });
				continue;
			}
			flat.push(k, value);
		}
		await bounded(redis.hset(key, ...flat), timeoutMs);
		// PEXPIRE ON EVERY BEAT, which REVERSES this project's stated TTL rule ("set the TTL only when the
		// key is first created, so a long window cannot push its expiry forward" -- budget.mjs). The
		// reversal is correct because the OBJECT is different, and the distinction is worth keeping:
		//
		//   a COUNTER whose TTL refreshes on every increment stops being a window, which is why the budget
		//   keys set it once and why a busy day must not postpone its own reset;
		//
		//   a LEASE's expiry IS the liveness claim, so refreshing it is not a leak, it is the mechanism.
		//
		// The in-repo precedent is lease-shaped and two files away: `wait-state.hold` re-PEXPIREs the
		// supersede lease `wait:key:<dedupId>` -- and only after checking the lease is still ours, which is
		// the same ownership check this key gets for free by being named after its only writer.
		await bounded(redis.pexpire(key, ttlMs), timeoutMs);
		await bounded(redis.sadd(HOST_SET, name), timeoutMs);
	};

	// The beat currently in flight, so `close` can DRAIN before it deletes. A `closed` flag checked at the
	// top of `beat` is not enough on its own: a beat that had already passed that check would land its
	// HSET after the DEL and recreate the very ghost `close` exists to remove.
	let inFlight = null;

	const beat = async (fields = facts) => {
		if (closed) return;
		facts = { ...facts, ...fields };
		try {
			inFlight = write({ ...facts, name, beatAt: now() });
			await inFlight;
			if (!reachable) {
				reachable = true;
				log("host_registry_restored", { host: name });
			}
		} catch (err) {
			if (reachable) {
				reachable = false;
				log("host_registry_unreachable", { host: name, reason: err?.message });
			}
		} finally {
			inFlight = null;
		}
	};

	return {
		/** This worker's own name, so a caller never re-derives it from config and gets a different answer. */
		self: () => name,

		/**
		 * Flush this host's current facts NOW, for a caller that must be visible before it reads peers.
		 *
		 * Takes NO fields, deliberately. It used to merge them, and that quietly destroyed the thunk
		 * mechanism it depends on: a caller passing `fpCron` as a computed STRING replaced the closure the
		 * heartbeat installed, so every later beat published a frozen value and two hosts' fingerprints
		 * could drift apart again. A caller that wants a fact re-read on every beat installs a thunk once,
		 * at `start`; a caller that wants it published NOW calls this.
		 */
		async publish() {
			await beat();
		},

		/**
		 * Every live host EXCEPT this one. Separate from `readLiveHosts` because "who else is there" is the
		 * question every caller actually has, and excluding self at the one place stops each of them doing it
		 * differently -- and stops a stale self-row, written by a previous process of this same host, being
		 * read as a peer that disagrees with the process that is running now.
		 */
		async livePeers() {
			const res = await readLiveHosts(redis, { now, timeoutMs });
			if (res.unreachable) return res;
			return { hosts: res.hosts.filter((h) => h.name !== name) };
		},

		/**
		 * Start beating. ONE `setInterval` -- the first in `worker/src`, every other timer here being a
		 * `setTimeout` -- and `.unref()`'d so it can never hold the process open, which is the posture the
		 * three `fs.watch` watchers already take. `stop` is registered as an extraCloser beside the runtime
		 * queue, so a clean shutdown clears it before `process.exit`.
		 */
		async start(fields = {}, { intervalMs = HOST_BEAT_MS } = {}) {
			if (closed || timer) return; // a second start would leak the first interval
			await beat({ ...fields, startedAt: now() });
			if (closed) return; // close() landed while the first beat was in flight
			timer = setInterval(() => void beat(), intervalMs);
			timer.unref?.();
		},

		/**
		 * Leave. A clean shutdown DELETES the row rather than letting it expire, so the TTL only ever
		 * covers a crash and a rolling restart does not leave a ghost peer behind for ninety seconds.
		 * `wait-state.release` takes the same posture for the same reason.
		 */
		async close() {
			if (closed) return; // idempotent, and the flag is also what stops an in-flight beat resurrecting the row
			closed = true;
			if (timer) clearInterval(timer);
			timer = null;
			// Drain before deleting, bounded like everything else here: an unbounded wait on a beat that is
			// itself hung would be the shutdown hang this module's timeout exists to prevent.
			await bounded(inFlight ?? Promise.resolve(), timeoutMs).catch(() => {});
			try {
				await bounded(redis.del(hostKey(name)), timeoutMs);
				await bounded(redis.srem(HOST_SET, name), timeoutMs);
			} catch {
				// Fail open: the TTL is the backstop, and a ghost row costs a panel line, never a decision.
			}
		},
	};
}

/**
 * Every live host's row, with the index pruned as it is read.
 *
 * THE INDEX LEAK IS HANDLED HERE, BY THE READER, and that is a decision rather than an oversight: a SET
 * cannot expire its members, so a host that dies leaves one behind. The alternative -- no index, and a
 * `SCAN host:h:*` instead -- was measured and refused for the `wait:held` keyspace on exactly this
 * shape: the panel reads every second, and a keyspace scan walks HARDEST on deployments with nothing to
 * show, because the early exit never fires. So the index exists, a member whose hash is gone is stale by
 * definition, and the reader removes it in passing.
 *
 * `{ unreachable }` and `[]` are DIFFERENT ANSWERS and must never be collapsed by a caller, even where
 * one treats them alike: "there are no other hosts" and "I could not find out" differ, and a panel that
 * renders the second as the first tells an operator their fleet is gone when Valkey merely blinked.
 */
export async function readLiveHosts(redis, { now = () => Date.now(), timeoutMs = REGISTRY_OP_TIMEOUT_MS } = {}) {
	let names;
	try {
		names = await bounded(redis.smembers(HOST_SET), timeoutMs);
		// Inside the try, not after it: a client that answers with something non-iterable would otherwise
		// throw straight out of a function whose contract is that every method fails open.
		if (names !== null && names !== undefined && !Array.isArray(names)) throw new Error("smembers did not return a list");
	} catch (err) {
		return { unreachable: err?.message ?? "registry unreadable" };
	}
	const hosts = [];
	for (const member of names ?? []) {
		try {
			const row = await bounded(redis.hgetall(hostKey(member)), timeoutMs);
			if (!row || Object.keys(row).length === 0) {
				await bounded(redis.srem(HOST_SET, member), timeoutMs).catch(() => {});
				continue;
			}
			const beatAt = typeof row.beatAt === "string" && row.beatAt.trim() !== "" ? Number(row.beatAt) : NaN;
			hosts.push({
				...row,
				name: row.name || member,
				// Derived rather than stored, so the panel can say "stale 2m" about a row that still lives.
				// A row whose clock is AHEAD of ours reads as 0 rather than negative: the difference is the
				// skew between two machines, which is its own signal and not this field's to report.
				staleMs: Number.isFinite(beatAt) ? Math.max(0, now() - beatAt) : null,
			});
		} catch {
			// One unreadable row degrades that row, never the listing.
		}
	}
	hosts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	return { hosts };
}
