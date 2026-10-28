/**
 * The defer record's half of a redis fake (issue #737): the one transaction `defer-write.mjs` sends
 * (`multi().del().hset().pexpire().exec()`) and its compare-and-delete (`eval` of `DEFER_CAD_LUA`), over maps of their
 * own, so a processor test can read which reason each gate recorded. Added to a test's own fake, it answers nothing
 * else: a fake that already has `eval` keeps it for every other script.
 *
 * `exec`, when given, replaces the transaction's answer (a rejection, a reply that never comes) and writes nothing.
 */
import { DEFER_FIELDS, deferKey, parseDefer } from "../../src/defer-reasons.mjs";
import { DEFER_CAD_LUA } from "../../src/defer-write.mjs";

export function withDeferRecords(redis = {}, { exec = null } = {}) {
	const hashes = new Map();
	const ttls = new Map();
	const sent = [];
	const removals = [];
	redis.deferHashes = hashes;
	redis.deferTtls = ttls;
	redis.deferSent = sent;
	redis.deferRemovals = removals;
	redis.multi = () => {
		const ops = [];
		const tx = {
			del: (key) => (ops.push(["del", key]), tx),
			hset: (key, ...kv) => (ops.push(["hset", key, ...kv]), tx),
			pexpire: (key, ms) => (ops.push(["pexpire", key, ms]), tx),
			exec: async () => {
				sent.push(ops);
				if (exec) return exec(ops);
				for (const [op, key, ...rest] of ops) {
					if (op === "del") {
						hashes.delete(key);
						ttls.delete(key);
					} else if (op === "hset") {
						const h = hashes.get(key) ?? new Map();
						for (let i = 0; i < rest.length; i += 2) h.set(rest[i], rest[i + 1]);
						hashes.set(key, h);
					} else if (op === "pexpire") {
						ttls.set(key, rest[0]);
					}
				}
				return ops.map(() => [null, 1]);
			},
		};
		return tx;
	};
	const inner = typeof redis.eval === "function" ? redis.eval.bind(redis) : null;
	redis.eval = async (script, numKeys, key, ...args) => {
		if (script !== DEFER_CAD_LUA) return inner ? inner(script, numKeys, key, ...args) : null;
		removals.push({ key, n: args[0] });
		if (hashes.get(key)?.get("n") !== args[0]) return 0;
		hashes.delete(key);
		ttls.delete(key);
		return 1;
	};
	return redis;
}

/** The raw fields written for a job id, as an object, or null when nothing is recorded. */
export function deferFieldsOf(redis, jobId) {
	const h = redis.deferHashes.get(deferKey(jobId));
	return h ? Object.fromEntries(h) : null;
}

/** The record for a job id as the console's reader parses it (`parseDefer`), or null. */
export function deferRecordOf(redis, jobId) {
	const h = redis.deferHashes.get(deferKey(jobId));
	return h ? parseDefer(DEFER_FIELDS.map((f) => h.get(f) ?? null)) : null;
}
