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

/** One bounded cycle, also the test seam for restart, partial enqueue and concurrent-producer behavior. */
export async function pollWatchSources({ cfg, redis, store, enqueue, adapterFactory = makeWatchPullAdapter, env = process.env, now = () => Date.now(), log = () => {}, due = new Map() }) {
	const sources = cfg.triggers?.watchSources ?? cfg.watchSources ?? {};
	for (const known of due.keys()) if (!Object.hasOwn(sources, known)) due.delete(known);
	let failures = 0;
	for (const [source, declaration] of Object.entries(sources)) {
		if (!declaration.pull || (due.get(source) ?? 0) > now()) continue;
		const identity = hash([source, declaration.pull]); const leaseKey = `watch:pull:lease:${identity}`; const cursorKey = `watch:pull:cursor:${identity}`; const token = randomUUID();
		if (!await redis.set(leaseKey, token, "NX", "PX", 15000)) continue;
		try {
			const raw = await redis.get(cursorKey); const cursor = raw ? JSON.parse(raw) : {};
			const adapter = adapterFactory(declaration.pull, { env, now });
			const batch = await adapter.poll(cursor);
			if (!Array.isArray(batch.findings) || !Array.isArray(batch.deliveries) || batch.findings.length !== batch.deliveries.length || batch.findings.length > 100 || Buffer.byteLength(JSON.stringify(batch.cursor)) > 32768) throw new Error("invalid watch pull batch");
			for (const [index, finding] of batch.findings.entries()) await ingestWatchFinding({ cfg, store, enqueue, source, finding, delivery: batch.deliveries[index], log, signature: "host-pull" });
			if (!await redis.eval(CHECKPOINT, 2, leaseKey, cursorKey, token, JSON.stringify(batch.cursor), WATCH_PULL_CURSOR_TTL_MS)) throw new Error("watch pull lease lost");
			due.set(source, now() + (declaration.pull.intervalSeconds ?? 30) * 1000);
			log("watch_pull_cycle", { source, count: batch.findings.length, status: "checkpointed" });
		} catch { failures++; log("watch_pull_source_failed", { source, reason: "source-unavailable-cursor-retained" }); } finally { try { await redis.eval(RELEASE, 1, leaseKey, token); } catch { failures++; } }
	}
	if (failures) throw new Error("watch pull sources unavailable");
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
	const store = deps.store ?? makeWatchStore(redis, { now }); const due = new Map();
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
	const done = (async () => {
		try {
			while (!stopped) {
				triggersFollower.follow();
				try { await pollWatchSources({ cfg, redis, store, enqueue, adapterFactory, env, now, log, due }); } catch { if (!stopped) log("watch_pull_failed", { reason: "source-unavailable-cursor-retained" }); }
				if (!stopped) await wait(); clearTimeout(timer);
			}
		} finally {
			clearTimeout(timer); if (signals) { process.removeListener("SIGTERM", signal); process.removeListener("SIGINT", signal); }
			if (ownedRedis) redis.disconnect(); if (ownedQueue) await queue.disconnect().catch(() => {});
		}
	})();
	return { stop, done };
}
