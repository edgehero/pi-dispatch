/**
 * Seams for a REAL fleet reader (`createFleetReader`) in a test with no Valkey: a BullMQ queue that answers every read
 * the snapshot makes, and Valkey clients that answer the reader's own commands. The reader's code runs as it does in
 * production over them, so a degraded state is the one the reader itself makes from a failing seam, never a result
 * shape written by hand.
 */
import { HOST_SET, hostKey } from "@edgehero/pi-dispatch/host-registry";

/**
 * A queue that answers every read the snapshot makes with nothing, recording what `getActive` was asked. `failed`, a
 * queue name to the failed jobs `getFailed` gives (as BullMQ Jobs carry them), counted in `getJobCounts`.
 */
export const quietQueue = (asked = [], { failed = {} } = {}) => (_c, opts) => {
  const name = opts?.name ?? "pi-jobs";
  return {
    name,
    async isPaused() { return false; },
    async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: (failed[name] ?? []).length }; },
    async getWorkers() { return []; },
    async getJobSchedulers() { return []; },
    async getActive(a, b) { asked.push([a, b]); return []; },
    async getFailed(start, end) { return (failed[name] ?? []).slice(start, end + 1); },
    async close() {},
  };
};

/** A Valkey that holds nothing, recording each range read on the run index; `mirrorDown` makes those reads throw. */
export function emptyRedis({ mirrorDown = false } = {}) {
  const ranges = [];
  return {
    ranges,
    on() {},
    async smembers() { return []; },
    async hgetall() { return {}; },
    async get() { return null; },
    async mget(...keys) { return keys.map(() => null); },
    async zrevrangebyscore(...args) {
      ranges.push(args);
      if (mirrorDown) throw new Error("ECONNREFUSED");
      return [];
    },
    async exists() { return 0; },
    disconnect() {},
  };
}

/**
 * A Valkey that holds `keys` (a key to a hash as an object, a set or list as an array, a sorted set as
 * `{ zset: [[member, score], ...] }`), answering the commands the fleet reader, `readLiveHosts`, `readWaiting` and
 * `readHeldJobs` send, with no pipeline (the readers then send each command alone). `registryDown()` true makes the
 * host registry's SMEMBERS reject, the way a Valkey that stopped answering does; `scanDown()` true makes SCAN reject,
 * so the keyspace discovery (`discoverHostQueuesReporting`) reads nothing whole. `pttlOf(key)` is a held key's PTTL
 * (-1, no expiry, by default). SCAN answers every match in one page.
 */
export function keyedRedis(keys = {}, { registryDown = () => false, scanDown = () => false, pttlOf = () => -1 } = {}) {
  const at = (key) => keys[key];
  const hash = (key) => (at(key) !== null && typeof at(key) === "object" && !Array.isArray(at(key)) && !at(key).zset ? at(key) : null);
  const range = (list, start, stop) => {
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    const to = stop < 0 ? list.length + stop : stop;
    return list.slice(from, to + 1);
  };
  return {
    on() {},
    async smembers(key) {
      if (key === HOST_SET && registryDown()) throw new Error("ETIMEDOUT");
      return Array.isArray(at(key)) ? [...at(key)] : [];
    },
    async srem() { return 0; },
    async hgetall(key) { return { ...(hash(key) ?? {}) }; },
    async hmget(key, ...fields) { return fields.map((f) => hash(key)?.[f] ?? null); },
    async hget(key, field) { return hash(key)?.[field] ?? null; },
    async hexists(key, field) { return hash(key) && field in hash(key) ? 1 : 0; },
    async pttl(key) { return at(key) === undefined ? -2 : pttlOf(key); },
    async get(key) { return typeof at(key) === "string" ? at(key) : null; },
    async mget(...names) { return names.map((key) => (typeof at(key) === "string" ? at(key) : null)); },
    async lrange(key, start, stop) { return Array.isArray(at(key)) ? range(at(key), start, stop) : []; },
    async zrange(key, start, stop, withScores) {
      const z = at(key)?.zset ?? [];
      const picked = range([...z].sort((a, b) => a[1] - b[1]), start, stop);
      return withScores ? picked.flatMap(([m, s]) => [m, String(s)]) : picked.map(([m]) => m);
    },
    async zscore(key, member) { const hit = (at(key)?.zset ?? []).find(([m]) => m === member); return hit ? String(hit[1]) : null; },
    async zrevrangebyscore() { return []; },
    async scan(_cursor, _match, pattern) {
      if (scanDown()) throw new Error("ETIMEDOUT");
      const escaped = String(pattern).split("*").map((part) => part.replace(/[.+?^$()|[\]{}\\]/g, "\\$&"));
      const re = new RegExp("^" + escaped.join(".*") + "$");
      return ["0", Object.keys(keys).filter((key) => re.test(key))];
    },
    async exists(key) { return at(key) === undefined ? 0 : 1; },
    disconnect() {},
  };
}

/** The registry keys of `rows`: a host name to its row as the worker writes it (every field a string). */
export function registryKeys(rows) {
  const keys = { [HOST_SET]: Object.keys(rows) };
  for (const [name, row] of Object.entries(rows)) keys[hostKey(name)] = { name, ...row };
  return keys;
}
