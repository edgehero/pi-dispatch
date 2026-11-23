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

/** What the reader's bounded client ends a command with when Valkey has not answered it in time: ioredis's own words. */
const NO_ANSWER = "Command timed out";

/**
 * A Valkey that is connected and does not answer (issue #988): every command rejects the way the reader's bounded
 * client ends one, a pipeline's `exec` too, and `asked` records each command by name. A rejection and never a throw
 * from the call itself: the reader catches its reads as promises, and a client that threw there would skip those
 * catches and leave a state no real client makes. Its events and `disconnect` do nothing.
 */
export function downRedis(asked = []) {
  const late = (name) => () => {
    asked.push(name);
    return Promise.reject(new Error(NO_ANSWER));
  };
  const chain = new Proxy({}, { get: (_, key) => (typeof key === "symbol" || key === "then" ? undefined : key === "exec" ? late("exec") : () => chain) });
  const silent = new Set(["on", "once", "off", "removeListener", "disconnect"]);
  return new Proxy({ status: "ready", options: {} }, {
    get(held, key) {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (Object.hasOwn(held, key)) return held[key];
      if (silent.has(key)) return () => {};
      if (key === "pipeline" || key === "multi") return () => chain;
      return late(key);
    },
  });
}

/** The BullMQ queue calls that ask Valkey, of those the console makes. */
const QUEUE_ASKS = Object.freeze(["isPaused", "getJobCounts", "getWorkers", "getJobSchedulers", "getActive", "getFailed", "getFailedCount", "getJob", "getJobs", "getJobState", "getRanges", "pause", "resume"]);

/**
 * A queue on that Valkey, as `makeQueueFn`: each call that asks Valkey rejects the same way and `asked` records it by
 * `<queue>.<method>`. Its client is connected (a Valkey that stopped answering ends no connection), so the reader
 * keeps the queue rather than replacing it, and `close` settles. The calls are named, not caught whole: a queue that
 * answered every property with a function would also pass for one that has BullMQ's own `toKey`, which asks nothing.
 */
export const downQueue = (asked = []) => (_c, opts) => {
  const name = opts?.name ?? "pi-jobs";
  const late = (method) => () => {
    asked.push(`${name}.${method}`);
    return Promise.reject(new Error(NO_ANSWER));
  };
  return { name, client: Promise.resolve({ status: "ready", on() {}, once() {} }), on() {}, once() {}, off() {}, async close() {}, ...Object.fromEntries(QUEUE_ASKS.map((method) => [method, late(method)])) };
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

/**
 * The two fields every running worker's row carries beside its beat: when its process started, and the health of its
 * consumers as its supervisor publishes it (`consumers`, the shared queue's and its own), in the worker's own format
 * (`parseConsumerHealth` reads it; a test holds that). A reader of such a row asks Valkey how each consumer's queue
 * stands, one round trip per queue, which a row without the field never makes it do: with rows that publish none, a
 * read that goes wrong while that round trip is in flight is seen by no test (issue #1036).
 */
export function consumersPublished(startedAt = Date.UTC(2026, 10, 21, 11)) {
  const consumer = (role) => ({ role, state: "running", connection: "ready", active: 0, rateLimited: false, lastFetchAt: null, lastSuccessAt: null, lastTakenAt: null, fetchAgeMs: null, successAgeMs: null });
  return { startedAt: String(startedAt), consumers: JSON.stringify({ v: 1, startedAt, rows: [consumer("shared"), consumer("host")] }) };
}

/**
 * The registry keys of `rows`: a host name to its row as the worker writes it (every field a string), its consumers'
 * health with it (`consumersPublished`), as every real worker's row has.
 */
export function registryKeys(rows) {
  const keys = { [HOST_SET]: Object.keys(rows) };
  for (const [name, row] of Object.entries(rows)) keys[hostKey(name)] = { name, ...consumersPublished(), ...row };
  return keys;
}

/** A read Valkey ANSWERS WITH AN ERROR, as its client rejects it: a reply whose first word is `code`. */
export const answeredWith = (code) => () => Promise.reject(Object.assign(new Error(`${code} said by Valkey about the key`), { name: "ReplyError" }));

/** A read that got NO ANSWER: the connection failed under it. */
export const noAnswer = () => Promise.reject(new Error("Connection is closed."));

/**
 * `keyedRedis` over a registry of `hosts` (live, beating at `beatAt`) whose three discovery reads answer as `how()`
 * says at each call (issue #1035), so one client serves a test that changes what Valkey answers: `index`, the
 * registry's `host:live`; `rows`, a host's row by its key; `scan`, the look for queues. Each is a function giving the
 * reply (`answeredWith`, `noAnswer`, or one that never settles); a read `how()` does not name answers well.
 */
export function discoveryRedis(how, { hosts = ["hosta", "hostw"], beatAt = Date.now() } = {}) {
  const base = keyedRedis(registryKeys(Object.fromEntries(hosts.map((name) => [name, { routes: "true", beatAt: String(beatAt) }]))));
  return {
    ...base,
    status: "ready",
    smembers: (key) => (key === HOST_SET && how().index ? how().index() : base.smembers(key)),
    hgetall: (key) => (how().rows?.[key] ? how().rows[key]() : base.hgetall(key)),
    scan: (...args) => (how().scan ? how().scan() : base.scan(...args)),
  };
}
