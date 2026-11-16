import { createHash, randomUUID } from "node:crypto";
import { buildLocalEventJob, localEventIdentity, localEventJobId, LOCAL_EVENT_MAX_AGE_MS, validLocalEvent } from "./local-event.mjs";
import { FORGE_JOB_RETENTION_S, LOCAL_JOB_KEPT_COMPLETED_S, LOCAL_JOB_KEPT_FAILED_S } from "./retention.mjs";

export const LOCAL_EVENT_STATE_PREFIX = "local:event:state:";
export const LOCAL_EVENT_RECEIPT_PREFIX = "local:event:receipt:";
export const LOCAL_EVENT_INDEX_KEY = "local:event:index";
export const LOCAL_EVENT_RECONCILE_MS = 1_000;

// Our own bounded signal state, never BullMQ's keys. Receipt and intent are committed together; the queue add is
// replayable by generation id. In particular, duplicate deliveries do not refresh the debounce or dirty an active run.
export const LOCAL_EVENT_LUA = `
local op = ARGV[1]
local now = tonumber(ARGV[2])
if now < 0 then
  local clock = redis.call('TIME')
  now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end
local raw = redis.call('GET', KEYS[1])
local s = raw and cjson.decode(raw) or {version=1}
if s.version ~= 1 then return redis.error_reply('unsupported local event state version') end
local function save()
  if s.current then
    redis.call('SET', KEYS[1], cjson.encode(s))
    redis.call('ZADD', KEYS[2], now, KEYS[1])
  else
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[2], KEYS[1])
  end
end
local function advance()
  s.current = s.next
  s.next = nil
  if s.current then s.current.dueAt = math.max(now, s.current.dueAt) end
  save()
end
if op == 'signal' then
  if redis.call('EXISTS', KEYS[3]) == 1 then return cjson.encode({accepted=true,duplicate=true,coalesced=true}) end
  local n = cjson.decode(ARGV[3])
  local delay = tonumber(ARGV[4])
  local maxAge = tonumber(ARGV[5])
  local coalesced = s.current ~= nil
  -- Unclaimed work has no execution authority yet. Superseding it lets a changed owner make progress even when
  -- the former owner is offline; its old queue job will fail the generation check before any credentials.
  if s.current and s.current.phase == 'pending' and (s.current.cancelled or s.current.data.localEvent.digest ~= n.data.localEvent.digest) then
    s.current = nil
    s.next = nil
  end
  local dest = 'current'
  if s.current and (s.current.phase ~= 'pending' or s.current.data.localEvent.digest ~= n.data.localEvent.digest or s.current.cancelled) then dest = 'next' end
  local p = s[dest]
  if not p or p.data.localEvent.digest ~= n.data.localEvent.digest then
    p = n
    p.phase = 'pending'
    p.firstAt = now
    p.count = 0
    s[dest] = p
  end
  p.lastAt = now
  p.count = math.min(2147483647, p.count + 1)
  p.dueAt = math.min(now + delay, p.firstAt + maxAge)
  redis.call('SET', KEYS[3], '1', 'EX', ARGV[6])
  save()
  return cjson.encode({accepted=true,coalesced=coalesced,generation=p.generation,worker=p.data.localEvent.worker,triggerId=p.data.localEvent.id})
end
local generation = ARGV[3]
local p = s.current
if not p or p.generation ~= generation then return cjson.encode({stale=true}) end
if op == 'ready' or op == 'claim' then
  if p.cancelled then return cjson.encode({cancelled=true}) end
  if p.phase == 'pending' and p.dueAt > now then return cjson.encode({untilMs=p.dueAt}) end
  if op == 'ready' then return cjson.encode({ok=true}) end
  p.phase = 'active'
  p.owner = ARGV[4]
  save()
  return cjson.encode({ok=true,count=p.count})
elseif op == 'finish' then
  if ARGV[4] ~= '' and p.owner and p.owner ~= ARGV[4] then return cjson.encode({stale=true}) end
  if ARGV[5] == 'discard' and s.next and s.next.data.localEvent.digest == p.data.localEvent.digest then s.next = nil end
  advance()
  return cjson.encode({ok=true})
elseif op == 'cancel' then
  if p.cancelled then return cjson.encode({ok=true}) end
  p.cancelled = true
  s.next = nil
  save()
  return cjson.encode({ok=true})
elseif op == 'missing' then
  p.blocked = 'queue-job-missing'
  save()
  return cjson.encode({ok=true})
end
return cjson.encode({stale=true})
`;

function decode(raw) {
	if (raw === null) return null;
	const state = JSON.parse(raw);
	if (state?.version !== 1 || !state.current || !validLocalEvent(state.current.data?.localEvent)) throw new Error("local event state unreadable");
	return state;
}

export function localEventStateKey(meta) {
	return `${LOCAL_EVENT_STATE_PREFIX}${localEventIdentity(meta)}`;
}

/** Operator visibility, rebuilt rather than exposing the state's private execution data. */
export async function readLocalEventStatus(redis, meta) {
	const state = decode(await redis.get(localEventStateKey(meta)));
	if (!state) return null;
	const project = (p) => p ? { jobId: localEventJobId(p.generation), phase: p.phase, cancelled: p.cancelled === true, count: p.count, dueAt: p.dueAt, ...(p.blocked === "queue-job-missing" && { blocked: p.blocked }) } : null;
	return { current: project(state.current), next: project(state.next) };
}

/** Only normalized reviewed rules enter signal. No forge payload is stored, even transiently in queue data. */
export function makeLocalEventStore({ redis, now = null, nonce = randomUUID }) {
	let cursor = "0";
	const evalState = async (op, meta, args = [], receipt = "") => JSON.parse(await redis.eval(LOCAL_EVENT_LUA, 3, localEventStateKey(meta), LOCAL_EVENT_INDEX_KEY, receipt, op, now ? now() : -1, ...args));
	const store = {
		async signal({ trigger, deliveryId }) {
			if (typeof deliveryId !== "string" || deliveryId.length < 1 || deliveryId.length > 256 || /[\x00-\x1f\x7f]/.test(deliveryId)) throw new Error("invalid local event delivery identity");
			const generation = nonce().replaceAll("-", "");
			const data = buildLocalEventJob(trigger, generation);
			const delay = trigger.on.debounceSeconds ?? 10;
			if (!Number.isInteger(delay) || delay < 0 || delay > 300) throw new Error("invalid local event debounce");
			const receipt = `${LOCAL_EVENT_RECEIPT_PREFIX}${createHash("sha256").update(JSON.stringify([trigger.on.forge, trigger.on.id, deliveryId])).digest("hex")}`;
			return evalState("signal", data.localEvent, [JSON.stringify({ generation, data }), delay * 1000, LOCAL_EVENT_MAX_AGE_MS, FORGE_JOB_RETENTION_S], receipt);
		},
		async read(meta) { return decode(await redis.get(localEventStateKey(meta))); },
		ready(meta) { return evalState("ready", meta, [meta.generation]); },
		claim(meta, owner) { return evalState("claim", meta, [meta.generation, owner]); },
		finish(meta, { owner = "", discard = false } = {}) { return evalState("finish", meta, [meta.generation, owner, discard ? "discard" : ""]); },
		cancel(meta) { return evalState("cancel", meta, [meta.generation]); },
		/** A bounded scan also finds intents whose trigger was deleted or whose publisher crashed. */
		async reconcile({ worker, queueFor }) {
			const scan = await redis.zscan(LOCAL_EVENT_INDEX_KEY, cursor, "COUNT", 100);
			cursor = scan[0];
			let published = 0;
			let blocked = 0;
			for (let i = 0; i < scan[1].length; i += 2) {
				const key = scan[1][i];
				const state = decode(await redis.get(key));
				if (!state) {
					// A signal can recreate this key after GET. Never remove that new intent's index membership.
					await redis.eval("if redis.call('EXISTS', KEYS[1]) == 0 then return redis.call('ZREM', KEYS[2], KEYS[1]) end return 0", 2, key, LOCAL_EVENT_INDEX_KEY);
					continue;
				}
				const current = state.current;
				const meta = current.data.localEvent;
				if (meta.worker !== worker) continue;
				const queue = await queueFor(worker);
				const id = localEventJobId(meta.generation);
				const job = await queue.getJob(id);
				if (job) {
					const status = await job.getState();
					if (status === "completed" || status === "failed") {
						await store.finish(meta, { discard: meta.once === true });
					} else if (current.cancelled && status !== "active") {
						await job.remove();
						await store.finish(meta);
					}
					continue;
				}
				// Active work whose queue entry disappeared is uncertain, never a license to execute it again.
				if (current.phase === "active") {
					await evalState("missing", meta, [meta.generation]);
					blocked++;
					continue;
				}
				if (current.cancelled) { await store.finish(meta); continue; }
				await queue.add("local", current.data, {
					jobId: id, delay: Math.max(0, current.dueAt - (now ?? Date.now)()), attempts: 2,
					backoff: { type: "exponential", delay: 5000 },
					removeOnComplete: { age: LOCAL_JOB_KEPT_COMPLETED_S }, removeOnFail: { age: LOCAL_JOB_KEPT_FAILED_S },
				});
				published++;
			}
			return { published, ...(blocked > 0 && { blocked }) };
		},
	};
	return store;
}

/** No overlapping sweeps and no silent background rejection. The durable intent survives every failed sweep. */
export function startLocalEventReconciler({ store, worker, queueFor, log = () => {}, intervalMs = LOCAL_EVENT_RECONCILE_MS }) {
	let closed = false;
	let running = null;
	let failed = false;
	let blocked = false;
	const tick = () => {
		if (closed || running) return running;
		running = store.reconcile({ worker, queueFor }).then((result) => {
			failed = false;
			if (result.blocked > 0 && !blocked) log("local_event_queue_job_missing", { worker, count: result.blocked });
			blocked = result.blocked > 0;
		}, () => {
			if (!failed) log("local_event_reconcile_failed", { worker });
			failed = true;
		}).finally(() => { running = null; });
		return running;
	};
	const timer = setInterval(tick, intervalMs);
	timer.unref?.();
	void tick();
	return { async close() { closed = true; clearInterval(timer); await running; } };
}
