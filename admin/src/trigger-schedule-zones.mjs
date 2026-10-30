/** The shared scheduler display deliberately omits queue ownership. Read it privately for the rules projection;
 * neither a console's local timezone nor an arbitrary live host is evidence of the scheduler's owning clock. */
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { HOST_SET, HOST_TTL_MS, HOST_BEAT_MS, HOST_SKEW_CLAIM_MS, hostKey } from "@edgehero/pi-dispatch/host-registry";
import { QUEUE, fleetQueueNames, hostQueueName, makeQueue } from "@edgehero/pi-dispatch/queue";

export const SCHEDULE_ZONE_LIMITS = Object.freeze({ queues: 64, schedulers: 1024 });
const unknown = "The scheduler's owning timezone could not be verified.";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT_RE = /^[a-f0-9]{16}$/;
const validZone = (zone) => {
  if (typeof zone !== "string" || zone.length > 100) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
};

/** Every consumer advances a shared scheduler using its own repeat strategy, even a named worker or one with no
 * cron config. Reconciler agreement alone cannot prove the clock that will schedule the next recurrence. */
function zoneForQueue(name, hosts) {
  const owners = name === QUEUE
    ? hosts.filter((h) => h?.routes === false || h?.routes === "false").filter((h) => h.fpCron !== "")
    : hosts.filter((h) => (h?.routes === true || h?.routes === "true") && hostQueueName(h.name) === name);
  if (!owners.length || owners.some((h) => h.clockVerified !== true || !validZone(h.tz) || !FINGERPRINT_RE.test(h.fpCron ?? ""))) return null;
  if (new Set(owners.map((h) => h.tz)).size !== 1 || new Set(owners.map((h) => h.fpCron)).size !== 1) return null;
  if (name === QUEUE && hosts.some((h) => h.clockVerified !== true || ![true, false, "true", "false"].includes(h.routes) || !validZone(h.tz) || h.tz !== owners[0].tz)) return null;
  return owners[0].tz;
}

/** A pure join, tested with conflicting owners and stale same-id patterns. No raw peer text leaves the join. */
export function scheduleZonesOf({ hosts = [], queues = [], triggers = [], complete = true } = {}) {
  const zones = Object.create(null);
  for (const trigger of triggers.filter((t) => t?.type === "cron")) {
    const evidence = [];
    const consumers = new Set();
    let uncertain = !complete;
    for (const queue of queues) {
      if (!Array.isArray(queue.schedulers) || queue.schedulers.length > SCHEDULE_ZONE_LIMITS.schedulers) { uncertain = true; continue; }
      const matching = queue.schedulers.filter((s) => s?.key === trigger.id);
      for (const s of matching) {
        const zone = zoneForQueue(queue.name, hosts);
        if (s.pattern !== trigger.pattern || !zone) uncertain = true;
        else {
          evidence.push(zone);
          for (const host of hosts) {
            if (NAME_RE.test(host?.name ?? "") && (queue.name === QUEUE || hostQueueName(host.name) === queue.name)) consumers.add(host.name);
          }
        }
      }
    }
    zones[trigger.id] = !uncertain && evidence.length && new Set(evidence).size === 1 ? { zone: evidence[0], hosts: [...consumers].sort() } : { zone: null, hosts: [], problem: unknown };
  }
  return zones;
}

function bounded(work, timeoutMs, fallback) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]).finally(() => clearTimeout(timer));
}

/** The general registry reader can prune stale members and omit failed rows. Neither is valid evidence of
 * unanimous clocks. This narrower reader issues only SMEMBERS/HGETALL/PTTL, tracks completeness and verifies
 * freshness against Valkey's expiry clock as well as the worker's beat. No stale member is removed. */
export async function readScheduleHosts({ url, now = () => Date.now(), timeoutMs = 2000, redisFn = makeRedisClient } = {}) {
  let redis;
  try {
    redis = redisFn(url, { failFast: true, disconnectTimeoutMs: 0 });
    const names = await bounded(() => redis.smembers(HOST_SET), timeoutMs, null);
    if (!Array.isArray(names)) return { hosts: [], complete: false };
    const valid = [...new Set(names.filter((n) => typeof n === "string" && NAME_RE.test(n)))];
    let complete = valid.length <= SCHEDULE_ZONE_LIMITS.queues;
    const hosts = (await Promise.all(valid.slice(0, SCHEDULE_ZONE_LIMITS.queues).map(async (name) => {
      try {
        const [row, ttl] = await Promise.all([
          bounded(() => redis.hgetall(hostKey(name)), timeoutMs, null),
          bounded(() => redis.pttl(hostKey(name)), timeoutMs, null),
        ]);
        if (row && !Object.keys(row).length && ttl === -2) return null;
        if (!row || !Object.keys(row).length || (row.name && row.name !== name)) { complete = false; return null; }
        const beat = typeof row.beatAt === "string" && row.beatAt.trim() !== "" ? Number(row.beatAt) : NaN;
        const age = HOST_TTL_MS - ttl;
        const routesKnown = [true, false, "true", "false"].includes(row.routes);
        const clockVerified = routesKnown && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= HOST_TTL_MS && age <= HOST_BEAT_MS * 4 && Number.isSafeInteger(beat) && Math.abs(now() - beat - age) <= HOST_SKEW_CLAIM_MS;
        return { name, routes: row.routes, tz: row.tz, fpCron: row.fpCron, clockVerified };
      } catch { complete = false; return null; }
    }))).filter(Boolean);
    return { hosts, complete };
  } catch { return { hosts: [], complete: false }; }
  finally { redis?.disconnect?.(); }
}

/** Every queue client, scheduler read and close has a bound, including BullMQ's separate scheduler connection. */
export async function readTriggerScheduleZones({ url, triggers = [], now = () => Date.now(), timeoutMs = 2000, readHostsFn = readScheduleHosts, makeQueueFn = makeQueue, parseConnectionFn = parseConnection } = {}) {
  let hosts;
  const opened = [];
  try {
    const fleet = await bounded(() => readHostsFn({ url, now, timeoutMs }), timeoutMs, null);
    if (!Array.isArray(fleet?.hosts)) return scheduleZonesOf({ triggers, complete: false });
    hosts = fleet.hosts;
    const names = fleetQueueNames(hosts);
    const queues = await Promise.all(names.slice(0, SCHEDULE_ZONE_LIMITS.queues).map(async (name) => {
      try {
        const q = makeQueueFn(parseConnectionFn(url, { failFast: true }), { name });
        opened.push(q);
        const schedulers = await bounded(async () => { await q.client; return q.getJobSchedulers(0, SCHEDULE_ZONE_LIMITS.schedulers, true); }, timeoutMs, null);
        return { name, schedulers };
      } catch { return { name, schedulers: null }; }
    }));
    return scheduleZonesOf({ hosts, queues, triggers, complete: fleet.complete !== false && names.length <= SCHEDULE_ZONE_LIMITS.queues });
  } catch { return scheduleZonesOf({ triggers, complete: false }); }
  finally {
    const timedOut = Symbol("close timed out");
    await Promise.all(opened.map(async (q) => {
      const closed = await bounded(() => q.close(), timeoutMs, timedOut).catch(() => timedOut);
      if (closed === timedOut) await bounded(() => q.disconnect?.(), timeoutMs, null).catch(() => {});
    }));
  }
}
