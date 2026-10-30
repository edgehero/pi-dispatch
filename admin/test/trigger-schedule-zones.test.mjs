import assert from "node:assert/strict";
import { test } from "node:test";
import { QUEUE, hostQueueName } from "@edgehero/pi-dispatch/queue";
import { readScheduleHosts, readTriggerScheduleZones, scheduleZonesOf } from "../src/trigger-schedule-zones.mjs";

const now = () => Date.UTC(2026, 9, 30, 12);
const trigger = { type: "cron", id: "nightly", pattern: "0 3 * * *" };
const host = { name: "build1", routes: true, tz: "Europe/Amsterdam", fpCron: "a".repeat(16), clockVerified: true };
const row = { key: trigger.id, pattern: trigger.pattern };
const queue = { name: hostQueueName(host.name), schedulers: [row] };
const zone = (opts = {}) => scheduleZonesOf({ hosts: [host], queues: [queue], triggers: [trigger], ...opts }).nightly.zone;

test("a named scheduler uses its actual declared queue owner's zone, never another live host's", () => {
  assert.equal(zone(), host.tz);
  assert.equal(zone({ hosts: [{ ...host, name: "other", tz: "UTC" }, host] }), host.tz);
  assert.equal(zone({ hosts: [{ ...host, name: "other" }] }), null);
  assert.equal(zone({ hosts: [{ ...host, routes: false }] }), null);
  assert.equal(zone({ hosts: [{ ...host, tz: "not-a-zone" }] }), null);
  assert.equal(zone({ queues: [{ ...queue, schedulers: [{ ...row, pattern: "0 4 * * *" }] }] }), null);
});

test("shared schedules require reconciler agreement and the clock of every consumer, including cron abstainers", () => {
  const shared = [{ name: QUEUE, schedulers: [row] }];
  const a = { ...host, routes: false };
  assert.equal(zone({ hosts: [a], queues: shared }), host.tz);
  assert.equal(zone({ hosts: [a, { ...a, name: "two", fpCron: "" }], queues: shared }), host.tz);
  assert.equal(zone({ hosts: [a, { ...a, name: "two", tz: "UTC" }], queues: shared }), null);
  assert.equal(zone({ hosts: [a, { ...a, name: "two", fpCron: "b".repeat(16) }], queues: shared }), null);
  assert.equal(zone({ hosts: [a, { ...a, name: "old", fpCron: undefined }], queues: shared }), null);
  assert.equal(zone({ hosts: [host], queues: shared }), null);
  assert.equal(zone({ hosts: [a, host], queues: shared }), host.tz);
  assert.equal(zone({ hosts: [a, { ...host, tz: "UTC" }], queues: shared }), null, "named workers still consume and advance shared schedules");
  assert.equal(zone({ hosts: [a, { ...a, fpCron: "", tz: "UTC" }], queues: shared }), null, "an abstainer still advances a consumed schedule");
  assert.equal(zone({ hosts: [a, { ...a, fpCron: "", clockVerified: false }], queues: shared }), null);

});

test("duplicate scheduler ids, an unread queue and a bounded read cannot prove a unique owning zone", () => {
  assert.equal(zone({ complete: false }), null);
  assert.equal(zone({ queues: [queue, { name: QUEUE, schedulers: null }] }), null);
  assert.equal(zone({ hosts: [host, { ...host, name: "two", tz: "UTC" }], queues: [queue, { name: hostQueueName("two"), schedulers: [row] }] }), null);
  assert.equal(zone({ queues: [queue, { ...queue, schedulers: [{ ...row, pattern: "1 3 * * *" }] }] }), null);
  assert.equal(zone({ queues: [] }), null);
  const dangerous = { ...trigger, id: "__proto__" };
  const result = scheduleZonesOf({ hosts: [host], triggers: [dangerous], queues: [{ ...queue, schedulers: [{ ...row, key: dangerous.id }] }] });
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(result.__proto__.zone, host.tz);
});

test("the real read asks the registry's actual queue names, awaits clients and closes every queue", async () => {
  const asked = [], closed = [];
  const result = await readTriggerScheduleZones({
    url: "redis://unused", triggers: [trigger], now,
    readHostsFn: async () => ({ hosts: [host] }), parseConnectionFn: () => ({}),
    makeQueueFn: (_connection, { name }) => ({
      client: Promise.resolve(),
      getJobSchedulers(start, end) { asked.push({ name, start, end }); return name === queue.name ? [row] : []; },
      close() { closed.push(name); },
    }),
  });
  assert.equal(result.nightly.zone, host.tz);
  assert.deepEqual(result.nightly.hosts, [host.name]);
  assert.deepEqual(asked.map((x) => x.name), [QUEUE, queue.name]);
  assert.ok(asked.every((x) => x.start === 0 && x.end === 1024));
  assert.deepEqual(closed.sort(), [QUEUE, queue.name].sort());
});

test("a hanging registry/client/close degrades to unknown and releases resources, without a scheduler call before ready", async () => {
  const never = () => new Promise(() => {});
  const missing = await readTriggerScheduleZones({ triggers: [trigger], now, readHostsFn: never, timeoutMs: 5 });
  assert.equal(missing.nightly.zone, null);
  let calls = 0, closed = 0, disconnected = 0;
  const result = await readTriggerScheduleZones({
    triggers: [trigger], now, timeoutMs: 5,
    readHostsFn: async () => ({ hosts: [host] }), parseConnectionFn: () => ({}),
    makeQueueFn: () => ({ client: never(), getJobSchedulers() { calls++; }, close() { closed++; return never(); }, disconnect() { disconnected++; } }),
  });
  assert.equal(result.nightly.zone, null);
  assert.equal(calls, 0);
  assert.equal(closed, 2);
  assert.equal(disconnected, 2);
});


test("registry clock evidence is GET-only, complete and fresh; failed members cannot disappear into agreement", async () => {
  let disconnected = 0;
  const commands = [];
  const read = (overrides = {}) => readScheduleHosts({ url: "redis://unused", now, timeoutMs: 5, redisFn: () => new Proxy({
    async smembers(key) { commands.push(["smembers", key]); return ["build1", "gone"]; },
    async hgetall(key) { commands.push(["hgetall", key]); return key.endsWith(":gone") ? {} : { ...host, routes: "true", beatAt: String(now() - 1000) }; },
    async pttl(key) { commands.push(["pttl", key]); return key.endsWith(":gone") ? -2 : 89000; },
    disconnect() { disconnected++; },
    ...overrides,
  }, { get(target, key) { assert.ok(key in target, `unexpected registry method ${String(key)}`); return target[key]; } }) });
  const good = await read();
  assert.equal(good.complete, true);
  assert.equal(good.hosts.length, 1);
  assert.equal(good.hosts[0].clockVerified, true);
  const failed = await read({ async hgetall() { throw new Error("cannot read member"); } });
  assert.equal(failed.complete, false);
  for (const ttl of [-1, null, 10000]) {
    const result = await read({ async pttl() { return ttl; } });
    assert.ok(result.hosts.every((h) => !h.clockVerified), String(ttl));
  }
  const skewed = await read({ async hgetall() { return { ...host, routes: "true", beatAt: String(now() - 3600000) }; } });
  assert.ok(skewed.hosts.every((h) => !h.clockVerified));
  const missingRoute = await read({ async hgetall() { return { ...host, routes: undefined, beatAt: String(now() - 1000) }; } });
  assert.ok(missingRoute.hosts.every((h) => !h.clockVerified));
  const hanging = await read({ hgetall: () => new Promise(() => {}) });
  assert.equal(hanging.complete, false);
  assert.equal(disconnected, 8);
  assert.ok(commands.every(([name]) => ["smembers", "hgetall", "pttl"].includes(name)));
});
