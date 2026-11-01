import assert from "node:assert/strict";
import { test } from "node:test";
import { makeReceiverObservations } from "@edgehero/pi-dispatch/receiver-status";
import { buildHookRun } from "@edgehero/pi-dispatch/hook-runs";
import { readConnections, modelConnections } from "../src/connections-view.mjs";

const AT = Date.UTC(2026, 10, 1, 12);
const endpoint = { id: "shared-model", host: "models.example.com", port: 443, slots: 4, keyless: true };

function fixture() {
  const calls = [];
  let closed = false;
  const client = { disconnect() { assert.equal(closed, false); closed = true; calls.push("disconnect"); } };
  const observations = makeReceiverObservations({ now: () => AT });
  observations.observe("github", 401);
  const receiver = { v: 1, name: "mini1", version: "4.3.1", startedAt: AT - 60_000, at: AT, ageMs: 0, port: 3000, bind: "loopback", forges: ["github"], deliveries: observations.snapshot(), rawBody: "SECRET_SENTINEL" };
  const publications = {
    endpointStatus: { state: "reported", partial: false, more: 0, rawAddress: "SECRET_SENTINEL", hosts: [{ name: "mini1", state: "reported", at: AT, ageMs: 5000, endpointsMore: 0, rawAddress: "SECRET_SENTINEL", endpoints: [{ id: "shared-model", slots: 4, used: 1, fleet: 1, rawAddress: "SECRET_SENTINEL" }, { id: "local-model", slots: 2, used: 2, fleet: 0, rawAddress: "SECRET_SENTINEL" }] }] },
    slots: [2],
    receivers: { complete: true, more: 0, hosts: [receiver] },
    hookRuns: { partial: false, more: 0, hosts: [{ name: "mini1", runs: [{ ...buildHookRun({ jobId: "gh-union", outcome: "failed", reason: "infra", detail: "exit", code: 3 }, AT), rawOutput: "SECRET_SENTINEL" }] }] },
  };
  const read = (key) => async (redis, options) => {
    assert.equal(redis, client);
    assert.equal(closed, false, `${key} must finish before the owned client is disconnected`);
    if (key === "slots") assert.deepEqual(options.map((ep) => ep.id), ["shared-model"], "host-only occupancy must not read a fleet lease key");
    calls.push(key);
    return publications[key];
  };
  return {
    calls, client, publications,
    closed: () => closed,
    options: {
      deploymentDir: "/fixture", now: AT, paths: { valkeyUrl: "redis://fixture.invalid" },
      snapshot: { hostBudgets: [{ name: "mini1" }], triggers: { triggers: [] }, doctor: { hosts: [] } },
      redisFn: () => { calls.push("connect"); return client; },
      reads: {
        environment: () => ({ env: { PI_WORKER_NAME: "mini1", GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "SECRET_SENTINEL" } }),
        allowlist: () => [], endpoints: () => [endpoint],
        endpointStatus: read("endpointStatus"), slots: read("slots"), receivers: read("receivers"), hookRuns: read("hookRuns"),
      },
    },
  };
}

function assertOtherPublications(model, failed = null) {
  assert.equal(model.endpoints[0].used, failed === "slots" ? null : 2);
  assert.equal(model.endpointStatus.state, failed === "endpointStatus" ? "unknown" : "reported");
  assert.equal(model.endpointStatus.partial, failed === "endpointStatus");
  if (failed !== "endpointStatus") {
    assert.deepEqual(model.endpointStatus.hosts, [{ name: "mini1", state: "reported", at: AT, ageMs: 5000, endpointsMore: 0 }]);
    assert.deepEqual(model.endpoints[0].hostCounts, [{ name: "mini1", slots: 4, used: 1, fleet: 1, at: AT, ageMs: 5000 }]);
    assert.equal(model.endpoints[1].id, "local-model");
    assert.equal(model.endpoints[1].host, null);
    assert.equal(model.endpoints[1].counting, "host-only");
    assert.equal(model.endpoints[1].used, null);
    assert.deepEqual(model.endpoints[1].hostCounts, [{ name: "mini1", slots: 2, used: 2, fleet: 0, at: AT, ageMs: 5000 }]);
  } else {
    assert.deepEqual(model.endpointStatus.hosts, []);
    assert.deepEqual(model.endpoints[0].hostCounts, []);
    assert.equal(model.endpoints.length, 1);
  }
  assert.equal(model.receivers.complete, failed !== "receivers");
  if (failed !== "receivers") assert.equal(model.receivers.hosts[0].deliveries.github.counts.unauthorized, 1);
  else assert.deepEqual(model.receivers.hosts, []);
  assert.equal(model.hookRuns.partial, failed === "hookRuns");
  if (failed !== "hookRuns") {
    assert.equal(model.hookRuns.hosts[0].runs[0].code, 3);
    assert.deepEqual(model.hookRuns.hosts[0].counts, { exit: 1 });
  } else assert.deepEqual(model.hookRuns.hosts, []);
  assert.doesNotMatch(JSON.stringify(model), /SECRET_SENTINEL/);
}

test("endpoint, lease, receiver and hook reads share one owned client through the last asynchronous read", async () => {
  const f = fixture();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const hookStarted = new Promise((resolve) => { started = resolve; });
  f.options.reads.hookRuns = async (redis) => {
    assert.equal(redis, f.client); assert.equal(f.closed(), false);
    f.calls.push("hooks-start"); started();
    await gate;
    assert.equal(f.closed(), false, "a pending hook read still owns access to the shared client");
    f.calls.push("hooks-end");
    return f.publications.hookRuns;
  };
  const reading = readConnections(f.options);
  try {
    await hookStarted;
    assert.equal(f.calls.filter((call) => call === "connect").length, 1);
    assert.equal(f.calls.includes("disconnect"), false);
    assert.equal(f.closed(), false);
  } finally { release(); }
  assertOtherPublications(modelConnections(await reading));
  assert.deepEqual([...f.calls].sort(), ["connect", "endpointStatus", "slots", "receivers", "hooks-start", "hooks-end", "disconnect"].sort());
  assert.equal(f.calls[0], "connect"); assert.equal(f.calls.at(-1), "disconnect");
});

test("a borrowed client is never constructed or disconnected, including after a failed source", async () => {
  for (const failed of [null, "endpointStatus", "slots", "receivers", "hookRuns"]) {
    const f = fixture();
    let factoryCalls = 0;
    f.options.redis = f.client;
    f.options.redisFn = () => { factoryCalls++; throw Error("a borrowed client cannot cause another connection"); };
    if (failed) f.options.reads[failed] = () => { f.calls.push(failed); throw Error("SECRET_SENTINEL"); };
    assertOtherPublications(modelConnections(await readConnections(f.options)), failed);
    assert.equal(factoryCalls, 0);
    assert.deepEqual([...f.calls].sort(), ["endpointStatus", "slots", "receivers", "hookRuns"].sort());
    assert.equal(f.closed(), false);
  }
});

test("each failed publication source preserves the other slices and still releases the one owned client", async () => {
  for (const failed of ["endpointStatus", "slots", "receivers", "hookRuns"]) {
    const f = fixture();
    f.options.reads[failed] = (redis) => {
      assert.equal(redis, f.client); assert.equal(f.closed(), false);
      f.calls.push(failed); throw Error("SECRET_SENTINEL");
    };
    assertOtherPublications(modelConnections(await readConnections(f.options)), failed);
    assert.deepEqual([...f.calls].sort(), ["connect", "endpointStatus", "slots", "receivers", "hookRuns", "disconnect"].sort());
    assert.equal(f.calls[0], "connect"); assert.equal(f.calls.at(-1), "disconnect");
    assert.equal(f.closed(), true);
  }
});

test("Setup opts out of every publication and lease read and leaves owned and borrowed clients untouched", async () => {
  for (const borrowed of [false, true]) {
    const f = fixture();
    if (borrowed) f.options.redis = f.client;
    await readConnections({ ...f.options, publications: false });
    assert.deepEqual(f.calls, []);
    assert.equal(f.closed(), false);
  }
});

test("fully injected publication readers without a URL run without constructing any client", async () => {
  const f = fixture();
  let factoryCalls = 0;
  f.options.paths = {};
  f.options.redisFn = () => { factoryCalls++; throw Error("injected readers without a URL must not construct a real client"); };
  for (const key of ["endpointStatus", "slots", "receivers", "hookRuns"]) f.options.reads[key] = async (redis) => {
    assert.equal(redis, null);
    f.calls.push(key);
    return f.publications[key];
  };
  assertOtherPublications(modelConnections(await readConnections(f.options)));
  assert.equal(factoryCalls, 0);
  assert.deepEqual([...f.calls].sort(), ["endpointStatus", "slots", "receivers", "hookRuns"].sort());
  assert.equal(f.closed(), false);
});
