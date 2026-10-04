import { CAS_SCRIPT, SEED_SCRIPT } from "@edgehero/pi-dispatch/allocation";
import { RESTORE_EXPECTED_SCRIPT } from "../../src/read-model.mjs";

// The release script is the fleet lease's; matched by shape so this helper needs no import from a non-exported module.
const isRelease = (script) => /redis\.call\(['"]get['"]/i.test(script) && /del/i.test(script) && script !== CAS_SCRIPT && script !== SEED_SCRIPT;

/**
 * A hand-rolled Valkey for the admin's allocation tests (issue #504 part C), on the worker's own
 * `allocation-apply.test.mjs` fake: real SET NX semantics, the compare-and-set and the neutral seed by their Lua
 * semantics, the lock release, and the list and MGET commands the readers use. `ops` records every write command in
 * order, so a test can assert what was written and when (`alloc:envelope:expected` before the file).
 */
export function fakeAllocRedis({ onSet = null } = {}) {
  const store = new Map();
  const lists = new Map();
  const ops = [];
  const client = {
    store,
    lists,
    ops,
    on() {},
    disconnect() {},
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async mget(...keys) {
      return keys.map((k) => (store.has(k) ? store.get(k) : null));
    },
    async set(key, value, ...args) {
      if (args.includes("NX") && store.has(key)) return null;
      onSet?.(key, value);
      const was = store.has(key) ? store.get(key) : null;
      store.set(key, value);
      ops.push(["set", key, value]);
      return args.includes("GET") ? was : "OK";
    },
    async del(key) {
      store.delete(key);
      ops.push(["del", key]);
      return 1;
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
    async eval(script, _n, key, ...argv) {
      if (script === CAS_SCRIPT) {
        const cur = store.get(key);
        if (cur === undefined) return 0;
        let s;
        try {
          s = JSON.parse(cur);
        } catch {
          return 0;
        }
        if ((typeof s.planId === "string" ? s.planId : "") !== argv[0]) return 0;
        if (s.envelopeDigest !== argv[1]) return 0;
        store.set(key, argv[2]);
        ops.push(["cas", key]);
        return 1;
      }
      if (script === SEED_SCRIPT) {
        const [expectedKey, body, digest, mode, was] = argv;
        if (mode === "nx" ? store.has(key) : store.get(key) !== was) return 0;
        store.set(key, body);
        if (mode === "nx" || !store.has(expectedKey)) store.set(expectedKey, digest);
        ops.push(["seed", key]);
        return 1;
      }
      if (script === RESTORE_EXPECTED_SCRIPT) {
        if (store.get(key) !== argv[0]) return 0;
        if (argv[1] === "") store.delete(key);
        else store.set(key, argv[1]);
        ops.push(["restore", key]);
        return 1;
      }
      if (isRelease(script)) {
        if (store.get(key) !== argv[0]) return 0;
        store.delete(key);
        return 1;
      }
      throw new Error("unknown script");
    },
    async lpush(key, value) {
      const l = lists.get(key) ?? [];
      l.unshift(value);
      lists.set(key, l);
      return l.length;
    },
    async ltrim(key, start, stop) {
      const l = lists.get(key) ?? [];
      lists.set(key, l.slice(start, stop + 1));
    },
    async lrange(key, start, stop) {
      const l = lists.get(key) ?? [];
      return l.slice(start, stop + 1);
    },
  };
  return client;
}
