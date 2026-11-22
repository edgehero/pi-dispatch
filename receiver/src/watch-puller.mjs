import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadReceiverConfig, makeTriggersFollower, triggersFilePath } from "./config.mjs";
import { makeWatchPullAdapter } from "./watch-pull.mjs";
import { ingestWatchFinding } from "./watch.mjs";
import { makeWatchStore } from "@edgehero/pi-dispatch/watch-store";
import { makeQueue, enqueueWatchJob } from "@edgehero/pi-dispatch/queue";
import { judgeValkeyAtStart, valkeyClientContext, makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { configError } from "@edgehero/pi-dispatch/config";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
const CHECKPOINT = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return 1";
/**
 * How long a pull source's cursor is kept, in MILLISECONDS (the checkpoint's `PX`), renewed by every checkpoint: 35 days
 * (docs/watch.md), so a collector stopped for weeks resumes where it left off. It is a resume point, NOT a dedup window,
 * and deliberately not derived from the forge job retention (`FORGE_JOB_RETENTION_S`, the time a forge redelivery is
 * refused): no forge job id stands behind it. Watch deliveries are deduplicated by the watch store's replay keys and
 * the watch queue's job ids, both kept seven days, and a cursor that expires only costs a re-read (a file from its
 * start, journald and Loki from a minute before the next poll), so tying it to the forge retention would move a
 * collector's resume window for a reason that has nothing to do with it.
 */
export const WATCH_PULL_CURSOR_TTL_MS = 35 * 86_400_000;

/**
 * One bounded cycle, also the test seam for restart, partial enqueue and concurrent-producer behavior.
 *
 * A SOURCE THAT FAILS WAITS ITS INTERVAL (issue #1027), as one that checkpointed does: whichever step fails once its
 * lease is held (`stage`: reading its cursor, its own `poll`, the batch's bounds, a finding's ingest or enqueue, the
 * checkpoint, a lease lost included), it is next due `intervalSeconds` later with its cursor kept. It used to stay due,
 * so the loop asked a failing remote once a second whatever its interval. A lease another collector holds is that
 * collector's turn, not a failure: nothing is said and the source stays due.
 *
 * A FAILURE IS SAID ONCE PER CHANGE: `watch_pull_source_failed` names the source and the stage, and a source that goes on
 * failing at the same stage says nothing more until it checkpoints or fails at another. Its next `watch_pull_cycle`,
 * which every checkpoint logs, is the recovery's line, so a recovery needs no line of its own: a log alert pairs the two
 * by `source`. Each pass said the failure twice before, once for the source and once more for the pass.
 *
 * `due` and `failing` are the loop's, keyed by the source's identity (its name and pull block, as its lease and cursor
 * are), so a source edited in place is due at once and its first failure is said, whatever the copy before it did, and
 * a source removed from the file leaves nothing behind. This throws only for what is no source's: at once when Valkey
 * answers a lease request with an error (out of memory, say), and after every source's turn when it answered a release
 * with one. A Valkey that stops answering at all holds the pass, with nothing said, until it answers: this client, like
 * every long-running client of the receiver, queues its commands and bounds none (`parseConnection` gives a command
 * bound to a short-lived failFast client only).
 */
export async function pollWatchSources({ cfg, redis, store, enqueue, adapterFactory = makeWatchPullAdapter, env = process.env, now = () => Date.now(), log = () => {}, due = new Map(), failing = new Map() }) {
	const sources = cfg.triggers?.watchSources ?? cfg.watchSources ?? {};
	const pulled = Object.entries(sources).filter(([, declaration]) => declaration.pull).map(([source, declaration]) => ({ source, declaration, identity: hash([source, declaration.pull]) }));
	const live = new Set(pulled.map(({ identity }) => identity));
	for (const kept of [due, failing]) for (const known of kept.keys()) if (!live.has(known)) kept.delete(known);
	let unreleased = 0;
	for (const { source, declaration, identity } of pulled) {
		if ((due.get(identity) ?? 0) > now()) continue;
		const leaseKey = `watch:pull:lease:${identity}`; const cursorKey = `watch:pull:cursor:${identity}`; const token = randomUUID();
		if (!await redis.set(leaseKey, token, "NX", "PX", 15000)) continue;
		let stage = "cursor";
		try {
			const raw = await redis.get(cursorKey); const cursor = raw ? JSON.parse(raw) : {};
			stage = "poll";
			const adapter = adapterFactory(declaration.pull, { env, now });
			const batch = await adapter.poll(cursor);
			stage = "batch";
			if (!Array.isArray(batch.findings) || !Array.isArray(batch.deliveries) || batch.findings.length !== batch.deliveries.length || batch.findings.length > 100 || Buffer.byteLength(JSON.stringify(batch.cursor)) > 32768) throw new Error("invalid watch pull batch");
			stage = "ingest";
			for (const [index, finding] of batch.findings.entries()) await ingestWatchFinding({ cfg, store, enqueue, source, finding, delivery: batch.deliveries[index], log, signature: "host-pull" });
			stage = "checkpoint";
			if (!await redis.eval(CHECKPOINT, 2, leaseKey, cursorKey, token, JSON.stringify(batch.cursor), WATCH_PULL_CURSOR_TTL_MS)) throw new Error("watch pull lease lost");
			failing.delete(identity);
			log("watch_pull_cycle", { source, count: batch.findings.length, status: "checkpointed" });
		} catch {
			if (failing.get(identity) !== stage) {
				failing.set(identity, stage);
				log("watch_pull_source_failed", { source, stage, reason: "source-unavailable-cursor-retained" });
			}
		} finally {
			due.set(identity, now() + (declaration.pull.intervalSeconds ?? 30) * 1000);
			try { await redis.eval(RELEASE, 1, leaseKey, token); } catch { unreleased++; }
		}
	}
	if (unreleased) throw new Error("watch pull lease release unavailable");
}

/**
 * Run the pull collector until `stop()`. Seams: `now`, `signals`, `out` (one object per log line), `loadConfig(env, fs)`,
 * `fsDeps` (`{ readFile, fileExists }`, the triggers file's reads), `sleep(ms)` (the wait between passes, a timer by
 * default), `adapterFactory`, and `redis`, `store`, `enqueue`, `judgeValkey`, `makeQueueFn` for its Valkey.
 *
 * THE TRIGGERS FILE IS FOLLOWED BY ITS TEXT (issue #995), with the poller's follower (`makeTriggersFollower`,
 * config.mjs): read at the top of every pass and regrouped only when what was read changed, so a bad edit is said once
 * each time the invalid text changes (`triggers_reload_invalid` with `kept: true`, the poller's and `serve`'s words) and the last good
 * copy goes on collecting, and a good text after it says `triggers_reloaded` once. The loop reloaded the file on every
 * pass and logged `watch_pull_config_invalid` each time it was invalid, one identical line a second until someone fixed
 * it. The baseline is the boot load's own read (issue #386's idiom), so a quiet start says nothing. The follower judges
 * the file as the boot did, for this config's command (`watch`), so it refuses no text over a setting the collector does
 * not read: a watch source without its push secret is taken here, as the poller takes it.
 */
export async function startWatchPuller(env = process.env, deps = {}) {
	const { now = () => Date.now(), signals = true, out = value => process.stdout.write(`${JSON.stringify(value)}\n`), loadConfig = (e, fs) => loadReceiverConfig(e, { ...fs, command: "watch" }), fsDeps = {}, sleep = null, adapterFactory = makeWatchPullAdapter } = deps;
	// Loaded as the collector (issues #994, #1006): it pulls, resolves no identity and calls no forge, so a source's push
	// secret, the forge webhook blocks, WEBHOOK_SECRET, RECEIVER_PORT, the GitHub auth block and the identity retry
	// window refuse neither this start nor a reload below; `serve` and `poll`, which read some of them, refuse them.
	const triggersPath = triggersFilePath(env);
	const bootRead = fsDeps.readFile ?? readFileSync;
	let triggersAtBoot = null;
	const cfg = loadConfig(env, {
		fileExists: fsDeps.fileExists ?? existsSync,
		readFile: (file, enc) => {
			const text = bootRead(file, enc);
			if (file === triggersPath) triggersAtBoot = text;
			return text;
		},
	});
	if (!Object.values(cfg.triggers?.watchSources ?? {}).some(source => source.pull)) throw configError("watch: no pull sources configured");
	const ownedRedis = !deps.redis; const ownedQueue = !deps.enqueue;
	if (ownedRedis || ownedQueue) await (deps.judgeValkey ?? judgeValkeyAtStart)(cfg.valkeyUrl, valkeyClientContext({ env }), { now });
	const redis = deps.redis ?? makeRedisClient(cfg.valkeyUrl);
	const queue = ownedQueue ? (deps.makeQueueFn ?? makeQueue)(parseConnection(cfg.valkeyUrl)) : null;
	const enqueue = deps.enqueue ?? (fields => enqueueWatchJob(queue, fields, { now }));
	const store = deps.store ?? makeWatchStore(redis, { now }); const due = new Map(); const failing = new Map();
	const triggersFollower = makeTriggersFollower(env, cfg, { readFile: fsDeps.readFile, fileExists: fsDeps.fileExists, baseline: triggersAtBoot, log: out, now });
	let stopped = false; let wake; let timer;
	const log = (event, fields) => out({ event, ...fields });
	const wait = () => (sleep ? sleep(1000) : new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 1000); }));
	const stop = () => {
		stopped = true; clearTimeout(timer); wake?.();
		// Disconnect our clients to release an in-flight reconnect wait. No cursor is advanced until
		// every enqueue succeeded, so interruption converges on the same delivery and finding IDs.
		if (ownedRedis) redis.disconnect();
		if (ownedQueue) void queue.disconnect().catch(() => {});
	};
	const signal = () => stop();
	if (signals) { process.once("SIGTERM", signal); process.once("SIGINT", signal); }
	// Whether the last pass threw (issue #1027): `watch_pull_failed` is said once per streak of passes cut short by a lease
	// request or release that Valkey answered with an error, and a pass that finishes ends the streak. A source's own
	// failure is said by `pollWatchSources`, never here, so the line no longer repeats it every second. A Valkey that does
	// not answer at all says nothing here: the pass waits for it (see `pollWatchSources`).
	let passFailing = false;
	const done = (async () => {
		try {
			while (!stopped) {
				triggersFollower.follow();
				try {
					await pollWatchSources({ cfg, redis, store, enqueue, adapterFactory, env, now, log, due, failing });
					passFailing = false;
				} catch {
					if (!stopped && !passFailing) log("watch_pull_failed", { reason: "valkey-unavailable-cursor-retained" });
					passFailing = true;
				}
				if (!stopped) await wait(); clearTimeout(timer);
			}
		} finally {
			clearTimeout(timer); if (signals) { process.removeListener("SIGTERM", signal); process.removeListener("SIGINT", signal); }
			if (ownedRedis) redis.disconnect(); if (ownedQueue) await queue.disconnect().catch(() => {});
		}
	})();
	return { stop, done };
}
