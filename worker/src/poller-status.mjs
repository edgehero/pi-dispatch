/**
 * The poller's heartbeat (issue #970): a display record each running `pi-dispatch-receiver poll` publishes from inside
 * its own loop, so `pi-dispatch status` and the console's Connections page can say whether a poller runs and whether it
 * runs on an older triggers file than the current one. Before it, a poller that exited 2 on an invalid file left
 * nothing behind but its own error log, while the worker kept its old schedules and the deployment looked healthy.
 *
 *   poller:live         SET of poller host names; an index its writers prune, never the liveness claim
 *   poller:h:<name>     STRING, one JSON record SET whole with PX, a TTL that covers the poller's next beat
 *
 * A DISPLAY, NEVER AN INPUT. Nothing reads it to admit, route, authenticate or doctor anything, and deleting `poller:*`
 * while a poller runs changes no polling: the next beat writes it again. The host registry's test applies
 * (host-registry.mjs): the truth-maker is the poller process, the refresh is the claim, and a dead poller's claim
 * expires on its own.
 *
 * NOT THE RECEIVER'S KEYS. Under GITHUB_INGEST=both `serve` and `poll` run side by side under one `workerName`, so a
 * shared `receiver:h:<name>` would have each overwrite the other; and every reader of a receiver record requires a
 * listening `port` (receiver-status.mjs), so a console of an earlier release would show the poller as an unreadable
 * receiver. The index check-and-prune and the bounded indexed read are the receiver's own (`pruneLiveIndex`,
 * `readIndexedRecords`), shared so the two channels cannot drift.
 *
 * THE CONTENT RULE, host-registry.mjs's: names, integers, digests and closed words. The follower's refusal reason
 * carries the file's path and the loader's words, so it never enters Valkey: the record says only that the file was
 * refused, missing or unreadable, and the 16-hex SHA-256 digest of the text the poller runs on and of the text it
 * refused. `pi-dispatch status` judges its own copy of the file (`pi-dispatch triggers check`'s rules) and says the
 * reason when the digests show it is the same file.
 *
 * NO TIMER OF ITS OWN. The poller's loop beats at its own points (after its start line, at each cycle's top, and
 * before each wait with a TTL that covers the wait), awaited like the loop's own cursor writes, so a beat adds no wait
 * those commands do not already have; and the loop's contract, that no timer it armed outlives `done`, needs nothing
 * new. A beat never throws: a failed write logs `poller_status_unavailable` once per failure streak, with a fixed
 * reason, never an error's text.
 */
import { createHash } from "node:crypto";
import { DEFER_TIME_MAX_MS } from "./defer-reasons.mjs";
import { pruneLiveIndex, readIndexedRecords } from "./receiver-status.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const POLLER_LIVE = "poller:live";
export const pollerKey = (name) => `poller:h:${name}`;
/** What a beat's TTL adds to the wait it plans, and the whole TTL of a beat inside a cycle: a cycle that has not beaten
 * again within five minutes is no longer polling. */
export const POLLER_GRACE_MS = 5 * 60_000;
/** The longest TTL a record may carry: a rate-limit sleep (up to an hour) plus the grace fits many times over. A wait
 * longer than this (a POLL_INTERVAL_SECONDS of more than a week) lets the record expire during it, read as no poller. */
export const POLLER_TTL_MAX_MS = 7 * 24 * 3_600_000;
export const POLLER_HOSTS_MAX = 64;
export const POLLER_MAX_BYTES = 4 * 1024;
export const POLLER_TRIGGERS = Object.freeze(["current", "kept"]);
export const POLLER_REFUSALS = Object.freeze(["refused", "missing", "unreadable"]);

const DIGEST_RE = /^[0-9a-f]{16}$/;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const instant = (n) => integer(n) && n <= DEFER_TIME_MAX_MS;
const nameOk = (s) => typeof s === "string" && WORKER_NAME_RE.test(s);
const digestOk = (s) => typeof s === "string" && DIGEST_RE.test(s);
const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const safeLog = (log, reason) => { try { log("poller_status_unavailable", { reason }); } catch {} };

/** The digest a record carries of a triggers file's text, and the one `pi-dispatch status` compares with its own copy. */
export function triggersDigest(text) {
	return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

/**
 * A version 1 record, rebuilt by field name, or null. Another `v`, a value over 4 KiB, a field of the wrong shape, and
 * fields that disagree (a current file with a refusal, a kept one without one, a refused text with no digest) are
 * unreadable. A field this release does not know is dropped by the rebuild, so a planted one never reaches a reader.
 */
export function parsePollerStatus(raw) {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > POLLER_MAX_BYTES) return null;
	let d;
	try { d = JSON.parse(raw); } catch { return null; }
	if (!plainObject(d) || d.v !== 1 || !nameOk(d.name) || typeof d.version !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(d.version)) return null;
	if (!instant(d.startedAt) || !instant(d.at) || !Number.isSafeInteger(d.ttlMs) || d.ttlMs < 1 || d.ttlMs > POLLER_TTL_MAX_MS || !(d.nextAt === null || instant(d.nextAt))) return null;
	if (!Number.isSafeInteger(d.intervalSeconds) || d.intervalSeconds < 1 || !integer(d.repos) || !POLLER_TRIGGERS.includes(d.triggers) || !digestOk(d.running)) return null;
	if (d.triggers === "current" ? d.refusal !== null || d.rejected !== null || d.rejectedAt !== null : !POLLER_REFUSALS.includes(d.refusal) || !instant(d.rejectedAt) || (d.refusal === "refused" ? !digestOk(d.rejected) : d.rejected !== null)) return null;
	return { v: 1, name: d.name, version: d.version, startedAt: d.startedAt, at: d.at, ttlMs: d.ttlMs, nextAt: d.nextAt, intervalSeconds: d.intervalSeconds, repos: d.repos, triggers: d.triggers, refusal: d.refusal, running: d.running, rejected: d.rejected, rejectedAt: d.rejectedAt };
}

/**
 * The poller's writer. `client` is the poller's Valkey client (or a function answering it). `name` is the poller's
 * `workerName`; one that is not a name (null when the poller could not resolve one) publishes nothing and says so once.
 *
 * `beat(fields)` writes one record: `fields` is `{ ttlMs, nextAt, intervalSeconds, repos, triggers, refusal, running,
 * rejected, rejectedAt }`, the rest is this writer's (`v`, `name`, `version`, `startedAt`, `at`). A record this module
 * would not read back is not written. SET with PX, then SADD, then one page of the index checked and pruned. `remove()`
 * deletes the record and its index entry, for a poller that stops; no beat writes after it.
 *
 * Both are async and never throw. A failure logs `poller_status_unavailable` with a fixed reason once, and again only
 * after a beat has succeeded since: a Valkey outage across many cycles is one line, not one per cycle.
 */
export function makePollerBeat({ client, name, version, now = Date.now, log = () => {} }) {
	const startedAt = now();
	const valid = nameOk(name);
	const prune = { at: "0" };
	let failing = false;
	let removed = false;
	const fail = (reason) => {
		if (failing) return;
		failing = true;
		safeLog(log, reason);
	};
	const connection = async () => (typeof client === "function" ? client() : client);
	if (!valid) fail("identity");
	return {
		async beat(fields = {}) {
			if (!valid || removed) return;
			let step = "record";
			try {
				const { ttlMs, nextAt = null, intervalSeconds, repos, triggers, refusal = null, running, rejected = null, rejectedAt = null } = fields;
				const raw = JSON.stringify({ v: 1, name, version, startedAt, at: now(), ttlMs, nextAt, intervalSeconds, repos, triggers, refusal, running, rejected, rejectedAt });
				if (!parsePollerStatus(raw)) throw new Error("record");
				step = "write";
				const redis = await connection();
				if (await redis.set(pollerKey(name), raw, "PX", ttlMs) !== "OK") throw new Error("set");
				if (removed) return;
				step = "index";
				if (!integer(await redis.sadd(POLLER_LIVE, name))) throw new Error("index");
				await pruneLiveIndex(redis, { live: POLLER_LIVE, keyOf: pollerKey, self: name, cursor: prune, closed: () => removed });
				failing = false;
			} catch {
				fail(step);
			}
		},
		async remove() {
			if (removed) return;
			removed = true;
			if (!valid) return;
			try {
				const redis = await connection();
				await redis.del(pollerKey(name));
				await redis.srem(POLLER_LIVE, name);
			} catch {
				// The record expires on its own within its TTL; the index entry goes at a peer's prune or stays as a name
				// whose record is absent, which every reader skips.
				fail("remove");
			}
		},
	};
}

/**
 * Read-only, the receiver's bounded indexed read (`readIndexedRecords`): at most four index pages and 256 names,
 * `names` first, at most 64 records, two seconds for the whole read. Returns `{ hosts, complete, more, moreUnknown }`:
 * each host is its record with `ageMs`, how long ago its last SET landed by Valkey's own count (the record's `ttlMs`
 * minus its PTTL, a duration, so no two clocks are compared), or `{ name, unreadable: true }`. A record that is not
 * version 1, names another host, carries no expiry or a PTTL above its own `ttlMs` is unreadable and makes `complete`
 * false; so do a discovery that did not finish and a record read that failed or ran out of time. A key that expired
 * between the reads is absent. No reader invents a poller, or the absence of one, from an incomplete read.
 */
export async function readPollerStatus(redis, { names = [], now = Date.now, timeoutMs = 2000, clock = () => performance.now() } = {}) {
	const read = await readIndexedRecords(redis, { live: POLLER_LIVE, keyOf: pollerKey, names, hostsMax: POLLER_HOSTS_MAX, timeoutMs, clock });
	const { more, moreUnknown } = read;
	if (read.rows === null) return { hosts: read.wanted.map((name) => ({ name, unreadable: true })), complete: false, more, moreUnknown };
	let { complete } = read;
	const hosts = [];
	for (const { name, value, ttl } of read.rows) {
		if (value === null || ttl === -2) continue;
		const record = parsePollerStatus(value);
		if (!record || record.name !== name || !Number.isInteger(ttl) || ttl < 0 || ttl > record.ttlMs) { hosts.push({ name, unreadable: true }); complete = false; continue; }
		hosts.push({ ...record, ageMs: record.ttlMs - ttl });
	}
	return { hosts, complete, more, moreUnknown };
}
