import { createHash, randomUUID } from "node:crypto";
import { loadReceiverConfig, reloadTriggers } from "./config.mjs";
import { makeWatchPullAdapter } from "./watch-pull.mjs";
import { ingestWatchFinding } from "./watch.mjs";
import { makeWatchStore } from "@edgehero/pi-dispatch/watch-store";
import { makeQueue, enqueueWatchJob } from "@edgehero/pi-dispatch/queue";
import { judgeValkeyAtStart, valkeyClientContext, makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { configError } from "@edgehero/pi-dispatch/config";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
const CHECKPOINT = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return 1";

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
			if (!await redis.eval(CHECKPOINT, 2, leaseKey, cursorKey, token, JSON.stringify(batch.cursor), 35 * 86400000)) throw new Error("watch pull lease lost");
			due.set(source, now() + (declaration.pull.intervalSeconds ?? 30) * 1000);
			log("watch_pull_cycle", { source, count: batch.findings.length, status: "checkpointed" });
		} catch { failures++; log("watch_pull_source_failed", { source, reason: "source-unavailable-cursor-retained" }); } finally { try { await redis.eval(RELEASE, 1, leaseKey, token); } catch { failures++; } }
	}
	if (failures) throw new Error("watch pull sources unavailable");
}

export async function startWatchPuller(env = process.env, deps = {}) {
	const { now = () => Date.now(), signals = true, out = value => process.stdout.write(`${JSON.stringify(value)}\n`), loadConfig = loadReceiverConfig, reload = reloadTriggers, adapterFactory = makeWatchPullAdapter } = deps;
	const cfg = loadConfig(env);
	if (!Object.values(cfg.triggers?.watchSources ?? {}).some(source => source.pull)) throw configError("watch: no pull sources configured");
	const ownedRedis = !deps.redis; const ownedQueue = !deps.enqueue;
	if (ownedRedis || ownedQueue) await (deps.judgeValkey ?? judgeValkeyAtStart)(cfg.valkeyUrl, valkeyClientContext({ env }), { now });
	const redis = deps.redis ?? makeRedisClient(cfg.valkeyUrl);
	const queue = ownedQueue ? (deps.makeQueueFn ?? makeQueue)(parseConnection(cfg.valkeyUrl)) : null;
	const enqueue = deps.enqueue ?? (fields => enqueueWatchJob(queue, fields, { now }));
	const store = deps.store ?? makeWatchStore(redis, { now }); const due = new Map();
	let stopped = false; let wake; let timer;
	const log = (event, fields) => out({ event, ...fields });
	const wait = () => new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 1000); });
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
				const reloaded = reload(env, cfg);
				if (reloaded.invalid) log("watch_pull_config_invalid", { reason: "invalid-config-kept-last-good" });
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
