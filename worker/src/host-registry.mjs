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
 *
 * `jobs` (issue #599, phase 2) is the one field that carries a list: JSON of the jobs this host runs now, ids and
 * integers only, built and read back by `live-jobs.mjs`, whose header argues each field against this rule. The reader
 * below parses it through that module's allowlist, so a row's `jobs` is an array (or null), never the raw string.
 *
 * VALKEY'S CLOCK IS USED ONLY AS A DURATION (issue #737). The reader asks each row's `PTTL` beside its `HGETALL`, and
 * `ttlMs - PTTL` is how long ago the row's last PEXPIRE landed, counted by the server that holds it. That is a length
 * of time, never an instant: no field here is ever compared with Valkey's own time of day. Set beside `beatAt` (an
 * instant on the HOST's clock) and the reader's own `now()`, it gives a third party's estimate of how far the two
 * machines' clocks disagree (`skewMs`), and it says when a row has no expiry at all (`noExpiry`), which is a row the TTL
 * will never remove.
 */

import { parseJobsMore, parseLiveJobs } from "./live-jobs.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

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
 * The smallest `skewMs` a reader may call a clock skew (issue #737). TWO BEATS, and the margin is not decoration:
 * `skewMs` is measured from the row's last PEXPIRE, and a read landing between a beat's HSET (the new `beatAt`) and its
 * PEXPIRE sees the previous beat's expiry, so the estimate can be off by one beat period, and by a round trip besides.
 * Below this, a difference is noise a reader must not report.
 */
export const HOST_SKEW_CLAIM_MS = 30_000;

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

/**
 * Reject rather than wait forever. See REGISTRY_OP_TIMEOUT_MS for why this is not optional here. `armed`, when given,
 * is a Set that holds the timer while it runs, so a caller that stops waiting on the bound (`readLiveHosts`, once its
 * read has ended) can clear it rather than leave it holding the process for the rest of the bound.
 */
function bounded(promise, ms = REGISTRY_OP_TIMEOUT_MS, armed = null) {
	return new Promise((resolve, reject) => {
		// NOT unref'd, deliberately. An unref'd timer does not fire when nothing else is holding the event
		// loop, so the bound would silently stop existing in exactly the situation it is for -- a shutdown
		// where the hung command is the last thing running. The cost is that a pending call can delay exit
		// by at most this timeout, which is the point: bounded, and short.
		const t = setTimeout(() => (armed?.delete(t), reject(new Error("registry timeout"))), ms);
		armed?.add(t);
		Promise.resolve(promise).then(
			(v) => (clearTimeout(t), armed?.delete(t), resolve(v)),
			(e) => (clearTimeout(t), armed?.delete(t), reject(e)),
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
				// A dependent display fact can bind to this row's generation without guessing another clock.
				resolved = typeof v === "function" ? v(fields) : v;
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
		// RE-CHECKED HERE, AND ONLY HERE (issue #302). `close`'s drain is bounded at one `timeoutMs` while
		// this function can spend one per command, so a write that outlived the drain would SADD the name
		// back AFTER `close`'s SREM had removed it: the ghost the `inFlight` drain exists to prevent,
		// arriving by a different door. Measured: `hset@0, pexpire@74, del@104, srem@105, sadd@145`.
		//
		// NOT before the PEXPIRE, which is the tempting symmetry and is wrong. A close landing between the
		// HSET and the PEXPIRE would then leave `host:h:<name>` with NO EXPIRY AT ALL, where today it dies in
		// ninety seconds -- invisible, because every reader walks `host:live` and the SREM emptied it, so a
		// keyspace leak rather than a ghost peer, and the reader's own prune does not reach it. The SADD is
		// the index write `close` undoes; the PEXPIRE is the row's own fuse and is always worth attempting.
		if (closed) return;
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
			// GATED ON `closed`, IN BOTH ARMS, and that is the whole of issue #302. `close` drains with ONE
			// `bounded(inFlight, timeoutMs)` while `write` spends a fresh `timeoutMs` on each of its commands,
			// so a write can outlive the drain -- and the continuation here then speaks through the boot's own
			// `log` closure, stamped with a host that has stopped. Measured against a stalled Valkey:
			// `host_registry_unreachable` at +76ms and `host_registry_restored` at +108ms after `close()` had
			// RESOLVED. The restored arm is not the afterthought it looks like: a drain that gave up can see the
			// write SUCCEED late just as easily as fail, and #302 named only the catch.
			//
			// This is `makeWatchCloser`'s `reloadLog` posture reached from the other side: work already in
			// flight cannot be recalled, so what a close gates is its VOICE.
			if (!reachable && !closed) {
				reachable = true;
				log("host_registry_restored", { host: name });
			}
		} catch (err) {
			if (reachable && !closed) {
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
			// A listing that is not whole stays so (issue #1062): the peers it could not read may disagree.
			return { hosts: res.hosts.filter((h) => h.name !== name), ...(res.incomplete ? { incomplete: res.incomplete } : {}) };
		},

		/**
		 * Start beating. ONE `setInterval` -- the first in `worker/src`, every other timer here being a
		 * `setTimeout` -- and `.unref()`'d so it can never hold the process open. `close` is registered as an
		 * extraCloser beside the runtime queue, so a clean shutdown clears it before `process.exit`; the three
		 * `fs.watch` watchers take the same two-part posture since issue #295, unref'd AND closed.
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
			//
			// So the drain is BEST-EFFORT, and it deliberately stays at one `timeoutMs` (issue #302): `write`
			// can spend one per command, so this can return while a write is still running, and widening the
			// wait to match would triple a shutdown bound whose entire point is to be short. What makes that
			// safe is the `closed` FLAG rather than the wait -- it gates the SADD inside `write` and both log
			// arms in `beat`, so a write that outlives this drain can neither re-index the row nor say a word.
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
 * renders the second as the first tells an operator their fleet is gone when Valkey merely blinked. A third, since
 * issue #1062: `{ hosts, incomplete }`, the rows that were read while others were not, which is neither.
 *
 * Each row also carries three fields read off the key's `PTTL` (issue #737), all null where the client has no `pttl`,
 * where the PTTL failed or timed out, or where the key went between the two reads (-2):
 *   - `ttlAgeMs`: how long ago the row's last PEXPIRE landed, `ttlMs - PTTL` (never below 0), on Valkey's clock as a
 *     duration. `ttlMs` is the TTL the writer sets, `HOST_TTL_MS` for every worker.
 *   - `skewMs`: `(now() - beatAt) - ttlAgeMs`, the reader's clock minus the host's, as a third party measures it.
 *     Positive: the host's clock is behind. A round trip and up to one beat period of noise; a reader claims a skew only
 *     past `HOST_SKEW_CLAIM_MS`. Null without a readable `beatAt`.
 *   - `noExpiry`: true when the key has no expiry at all (-1), which the TTL will never remove; false when it has one.
 *     A reader walks `host:live`, and a beat SADDs only after its PEXPIRE, so a reader meets it only under a name an
 *     EARLIER beat indexed: for a moment when a beat re-creates a row that expired while its name stayed, and for good
 *     when the process died between that HSET and its PEXPIRE.
 * The PTTL goes out beside the HGETALL, in the same tick and each under its own bound, so it costs no round trip; a
 * failed PTTL costs these three fields and never the row.
 *
 * `timeoutMs` BOUNDS THE WHOLE READ (issue #1062), not each command: the rows are read side by side, every one under
 * what is left of the bound once the index answered, so a stalled Valkey costs the caller one bound however many hosts
 * are listed. Read one after another, each under a full bound, three hosts behind a stalled scan cost six seconds: a
 * resume's five-second deadline was gone before its write, so it sent nothing and blamed the connection. A row that did
 * not answer in time, or whose connection failed, may be a live host's, so the listing then carries `incomplete` ("2 of
 * 3 host rows not read") and `unreadHosts` (those members' names), and every caller that says its list of hosts or
 * queues may be short says that too; such a row is never pruned.
 *
 * A ROW VALKEY ANSWERED WITH AN ERROR IS A ROW NOT READ TOO (issue #1036). `host:live` lists the member and its key is
 * not a hash (`SET host:h:<name> x`), so nothing here says the host is gone: dropped as no host's, as it was, every
 * reader stated "no such host" and "$0 held" of a host the registry lists. It counts in `incomplete`, is named in
 * `unreadHosts`, and its reply's code is kept in `hostErrors` (`{ <member>: "WRONGTYPE" }`, present only when not
 * empty), which `incomplete`'s words name as well, so a caller that prints them says which row and what Valkey
 * answered. It is not pruned. What the code means is not said here: whether waiting helps and what there is to repair
 * depend on it (a key of another type, a permission this user lacks, a Valkey that could not serve the read just
 * then), and a caller that says either asks `replyErrorClass` (connection.mjs). The index itself answered with an
 * error is `{ unreachable, error }`, the code beside the words.
 */
export async function readLiveHosts(redis, { now = () => Date.now(), timeoutMs = REGISTRY_OP_TIMEOUT_MS, prune = true, ttlMs = HOST_TTL_MS } = {}) {
	// On the monotonic clock: a wall clock stepped mid-read must not widen or cut the bound.
	const deadline = performance.now() + timeoutMs;
	const left = () => Math.max(1, Math.round(deadline - performance.now()));
	let names;
	try {
		names = await bounded(redis.smembers(HOST_SET), timeoutMs);
		// Inside the try, not after it: a client that answers with something non-iterable would otherwise
		// throw straight out of a function whose contract is that every method fails open.
		if (names !== null && names !== undefined && !Array.isArray(names)) throw new Error("smembers did not return a list");
	} catch (err) {
		const error = replyCode(err);
		return { unreachable: err?.message ?? "registry unreadable", ...(error !== null ? { error } : {}) };
	}
	const withTtl = typeof redis?.pttl === "function";
	// A name outside the worker name charset (`WORKER_NAME_RE`: a letter or a digit, then letters, digits, `.`, `_` and
	// `-`, at most 64 in all) is no host's: anything with the Valkey's URL can SADD one, and a reader that took it would
	// print it wherever rows are drawn (a 3,000-character member widened the console's page to 43,000 px). The charset
	// alone, looser than the boot rule, which also refuses a `.json` or `.log` tail on `PI_WORKER_NAME` (`config.mjs`).
	// Skipped before its row is even read, and never pruned: removing what someone else wrote is not a reader's call,
	// and the member costs only its place in the set.
	const members = (names ?? []).filter((member) => typeof member === "string" && WORKER_NAME_RE.test(member));
	// A row not read is `{ [unread]: code }`: the code of Valkey's error reply, or null for a row that got no answer.
	const unread = Symbol("row not read");
	const notRead = (row) => row !== null && Object.hasOwn(row, unread);
	const rowMs = left();
	// Every row's bounds, cleared once the read ends: a row whose HGETALL failed at once stops waiting on its PTTL, whose
	// bound would otherwise hold the process for the rest of it.
	const armed = new Set();
	const read = await Promise.all(members.map(async (member) => {
		try {
			const key = hostKey(member);
			// Both issued before either is awaited. The PTTL's own failure (a throw, a rejection, a hang past its bound)
			// is null here, so only the HGETALL decides whether the row is read at all.
			const [row, pttl] = await Promise.all([
				bounded(redis.hgetall(key), rowMs, armed),
				withTtl ? bounded((async () => redis.pttl(key))(), rowMs, armed).catch(() => null) : null,
			]);
			if (!row || Object.keys(row).length === 0) {
				// `prune: false` for a reader that promises to write nothing (the capacity report, issue #599): the stale member
				// is skipped the same, and left for the next pruning reader. Only a row Valkey answered as empty is stale.
				if (prune) await bounded(redis.srem(HOST_SET, member), left()).catch(() => {});
				return null;
			}
			const beatAt = typeof row.beatAt === "string" && row.beatAt.trim() !== "" ? Number(row.beatAt) : NaN;
			const nowMs = now();
			// The running jobs through the allowlist (issue #599, phase 2): an array, or null where the row publishes none (a
			// worker from before the field) or none that parses. A listed entry that does not read is a running job not
			// counted, so it joins `jobsMore` rather than vanishing.
			// The row's own `name` stands for the member only when it holds to the same rule, else the row is no host's.
			const name = row.name || member;
			if (typeof name !== "string" || !WORKER_NAME_RE.test(name)) return null;
			const live = parseLiveJobs(row.jobs);
			const more = parseJobsMore(row.jobsMore);
			return {
				...row,
				jobs: live.jobs,
				jobsMore: live.jobs === null ? more : (more ?? 0) + live.dropped,
				// A row that HAS a `jobs` value that is not a list: how many it runs is unknown, which a reader must say
				// rather than read as a worker from before the field.
				jobsUnreadable: live.jobs === null && typeof row.jobs === "string" && row.jobs !== "",
				name,
				// Derived rather than stored, so the panel can say "stale 2m" about a row that still lives.
				// A row whose clock is AHEAD of ours reads as 0 rather than negative: the difference is the
				// skew between two machines, which is its own signal and not this field's to report (`skewMs` is).
				staleMs: Number.isFinite(beatAt) ? Math.max(0, nowMs - beatAt) : null,
				...expiryFields(pttl, { ttlMs, beatAt, nowMs }),
			};
		} catch (err) {
			// No answer in time (the bound's own error) or a failed connection says nothing about the host, and neither does
			// Valkey's error reply about the key (issue #1036): the member is listed and its row was not read, so the listing
			// is not whole. The reply's code is kept; nothing else of it is.
			return { [unread]: replyCode(err) };
		}
	})).finally(() => {
		for (const t of armed) clearTimeout(t);
	});
	const hosts = read.filter((row) => row !== null && !notRead(row));
	hosts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	// The members whose rows were not read (`unreadHosts`), so a reader that keeps rows across reads keeps only theirs:
	// a row that answered empty was pruned and its host is gone, as a whole read says.
	const codes = new Map(members.flatMap((member, i) => (notRead(read[i]) ? [[member, read[i][unread]]] : [])));
	const unreadHosts = [...codes.keys()].sort();
	if (unreadHosts.length === 0) return { hosts };
	const errored = unreadHosts.filter((member) => codes.get(member) !== null);
	const hostErrors = Object.fromEntries(errored.map((member) => [member, codes.get(member)]));
	// The words name the rows Valkey answered with an error, at most `HOST_ERRORS_NAMED` of them: a member is a worker
	// name and a code is one word of Valkey's, so neither is a client's free text.
	const named = errored.slice(0, HOST_ERRORS_NAMED).map((member) => `${member} (${codes.get(member)})`).join(", ");
	const answered = errored.length === 0 ? "" : `, of which Valkey answered with an error: ${named}${errored.length > HOST_ERRORS_NAMED ? ` and ${errored.length - HOST_ERRORS_NAMED} more` : ""}`;
	return { hosts, incomplete: `${unreadHosts.length} of ${members.length} host rows not read${answered}`, unreadHosts, ...(errored.length > 0 ? { hostErrors } : {}) };
}

/** How many rows answered with an error `readLiveHosts`' `incomplete` words name; `hostErrors` holds every one. */
const HOST_ERRORS_NAMED = 5;

/**
 * How many hosts a LIST of the hosts a registry read did not read names, on every surface that prints one or hands it
 * on (issue #1036): the fleet reader's `unreadHosts`, `dispatch_hosts`, `status`' and `dispatch_status`' `hostErrors`,
 * doctor's warnings. The rest are counted beside it. A member of `host:live` is anyone's to add who holds the
 * Valkey's URL, so a list without a bound is theirs to grow: 23 broken rows gave 23 warnings and 23 entries.
 */
export const UNREAD_HOSTS_MAX = 20;

/**
 * `hostErrors` as a surface shows it: `{ hostErrors, hostErrorsMore }`, the first `UNREAD_HOSTS_MAX` hosts in name
 * order with their codes and how many more there are (present only when there are), or `{}` when the read holds none.
 * `readLiveHosts`' own map stays whole: `liveHostNamesOf` and the readers that keep a host's last row need every name.
 */
export function hostErrorsShown(hostErrors) {
	if (hostErrors === null || typeof hostErrors !== "object") return {};
	const names = Object.keys(hostErrors).sort();
	if (names.length === 0) return {};
	return { hostErrors: Object.fromEntries(names.slice(0, UNREAD_HOSTS_MAX).map((name) => [name, hostErrors[name]])), ...(names.length > UNREAD_HOSTS_MAX ? { hostErrorsMore: names.length - UNREAD_HOSTS_MAX } : {}) };
}

/**
 * The code of Valkey's error reply, or null for an error that is no reply: `replyErrorCode`'s rule (connection.mjs),
 * word for word. A copy, because this module imports two leaves and nothing else: `capacity.mjs` imports it, and that
 * module's graph holds no filesystem, no os and no config, all of which connection.mjs reaches. A test holds the two
 * equal over `readLiveHosts`' own answers.
 */
function replyCode(err) {
	if (err?.name !== "ReplyError") return null;
	return /^([A-Z][A-Z0-9_]{0,31})(?=\s|$)/.exec(String(err.message ?? ""))?.[1] ?? "error";
}

/**
 * The names in a `readLiveHosts` listing, each through `normalize`, as a Set, or null when the listing cannot vouch for
 * every live host: unreachable, not a list, or `incomplete` with a row that got no answer (issue #1062). For a caller
 * that acts on a host being ABSENT (the host-lost sweep fails a recovery whose host is gone): a row that was not read
 * in time may be a live host's, so such a listing is "not known", never a fleet without that host.
 *
 * A row Valkey answered with an error (`hostErrors`, issue #1036) is different: the read finished, and it will answer
 * the same on the next. Its member is listed and nothing says its host is gone, so the name is in the set, as a live
 * host's. Null for it instead would let one key of the wrong type, which anyone with the Valkey's URL can write, turn
 * every read into "not known": the sweep would extend every recovery for as long as that key exists, and a host that
 * is really gone would never be found lost.
 */
export function liveHostNamesOf(read, normalize = (name) => name) {
	if (read?.unreachable || !Array.isArray(read?.hosts)) return null;
	const errored = read.hostErrors !== null && typeof read.hostErrors === "object" ? Object.keys(read.hostErrors) : [];
	if (read.incomplete && !(Array.isArray(read.unreadHosts) && read.unreadHosts.every((name) => errored.includes(name)))) return null;
	return new Set([...read.hosts.map((h) => h.name), ...errored].map(normalize));
}

/** `readLiveHosts`'s three PTTL fields (see there). `pttl` is the reply, or null where none was read. */
function expiryFields(pttl, { ttlMs, beatAt, nowMs }) {
	if (pttl === -1) return { ttlAgeMs: null, skewMs: null, noExpiry: true };
	// -2 (the key went between the two reads), a failed read, or a reply that is not a whole number: nothing is known.
	if (!Number.isSafeInteger(pttl) || pttl < 0) return { ttlAgeMs: null, skewMs: null, noExpiry: null };
	const ttl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : HOST_TTL_MS;
	const ttlAgeMs = Math.max(0, ttl - pttl);
	return { ttlAgeMs, skewMs: Number.isFinite(beatAt) ? nowMs - beatAt - ttlAgeMs : null, noExpiry: false };
}
