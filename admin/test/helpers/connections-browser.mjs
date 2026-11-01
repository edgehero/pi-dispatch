/** #775: actual console routes and readers over the production publishers and live Valkey. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { createServer, request } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeHostRegistry } from "@edgehero/pi-dispatch/host-registry";
import { makeFleetLease, endpointSlotKey, hash16 } from "@edgehero/pi-dispatch/fleet-lease";
import { makeInFlight } from "@edgehero/pi-dispatch/scoped-limits";
import { startSetupBrowserFixture, SETUP_BROWSER_TOKENS } from "./setup-browser.mjs";
import { SETUP_AT } from "./setup-goldens.mjs";

export const CONNECTIONS_BROWSER_TOKENS = SETUP_BROWSER_TOKENS;
export const CONNECTIONS_SLICES = Object.freeze(["receiver", "hooks", "endpoints", "all", "baseline"]);

/** The database belongs to this one CLI invocation, never a running deployment. */
export async function startConnectionsBrowserFixture(dir, { slice, readOnly = false, agedReceiver = false, receiverName = "mini1", url = process.env.VALKEY_TEST_URL } = {}) {
  assert.ok(CONNECTIONS_SLICES.includes(slice), "Choose an explicit Connections slice");
  assert.ok(url, "Connections browser verification needs VALKEY_TEST_URL");
  const address = new URL(url); address.pathname = "/14";
  const redis = makeRedisClient(address.href);
  const closers = [];
  const registries = [];
  let endpointFactsEnabled = true;
  let fixture, edge, ownsDatabase = false;
  let at = agedReceiver ? SETUP_AT - 25 * 3_600_000 : SETUP_AT;
  const receiverRecordKey = `receiver:h:${receiverName}`;
  const now = () => at;
  const drain = async predicate => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("A production telemetry publisher did not finish");
  };
  const close = async () => {
    for (const closer of closers.reverse()) await closer.close?.();
    if (edge) { edge.closeAllConnections(); await new Promise(resolve => edge.close(resolve)); }
    if (fixture) await fixture.close();
    if (ownsDatabase) await redis.flushdb();
    redis.disconnect();
  };
  try {
    assert.equal(await redis.dbsize(), 0, "The dedicated browser database must be empty");
    ownsDatabase = true;
    fixture = await startSetupBrowserFixture(dir, { readOnly, connectionsOptions: { redis, now: SETUP_AT } });
    fixture.changeEnv("GITHUB_AUTH_SOURCE=gh\nWEBHOOK_SECRET=fixture-secret\nPI_WORKER_NAME=build3\nPI_PROVIDER=anthropic\nPI_ON_FAILURE=/fixture/notify\n");
    writeFileSync(join(dir, "egress-allowlist.conf"), "api.github.com\nregistry.npmjs.org\n");
    const endpoints = [
      { id: "local-model", host: "host.docker.internal", port: 11434, slots: 2, keyless: true },
      { id: "shared-model", host: "models.example.com", port: 443, slots: 4, keyless: true },
    ];
    writeFileSync(join(dir, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints }));
    fixture.snapshot.hostBudgets = ["mini1", "mini2", "build3"].map(name => ({ name, ttlAgeMs: 1000 }));
    fixture.snapshot.hosts = fixture.snapshot.hostBudgets;
    fixture.snapshot.doctor = { hosts: ["mini1", "mini2", "build3"].map(name => ({ name, at, ageMs: 1000, every: 24, checks: [{ id: "egress.proxy", level: "ok" }, { id: "provider.key", level: "ok" }] })) };
    fixture.snapshot.triggers = { triggers: [{ index: 0, forge: "github", type: "comment", statusComment: true }] };
    fixture.snapshot.settings = { overlay: {} };
    fixture.snapshot.overlayMcp = { servers: [], refused: [] };
    fixture.snapshot.stagedPackages = { packages: [] };
    for (const name of ["mini1", "mini2", "build3"]) {
      const registry = makeHostRegistry({ redis, name, now });
      let fields = {};
      if (slice === "endpoints" || slice === "all") {
        const { endpointStatusFields } = await import("../../../worker/src/endpoint-status.mjs");
        const slots = makeInFlight();
        slots.tryAcquire("local-model", 2);
        slots.tryAcquire("shared-model", 4);
        if (name === "mini2") slots.tryAcquire("shared-model", 4);
        if (name !== "build3") {
          const lease = makeFleetLease({ redis, holderPrefix: name, keyFor: endpointSlotKey, ttlMs: 600_000, now });
          for (let index = 0; index < (name === "mini2" ? 2 : 1); index++) {
            const claim = await lease.acquire(`fixture-${name}-${index}`, { slots: name === "mini2" ? 3 : 4, keyArgs: [hash16("shared-model")] });
            assert.ok(claim?.ok && !claim.degraded, "The real shared model lease must be acquired");
            closers.push({ close: () => claim.release() });
          }
        }
        const endpointFields = endpointStatusFields(endpoints.map(endpoint => ({ ...endpoint, ...(name === "mini2" && endpoint.id === "shared-model" ? { slots: 3 } : {}) })), slots, name !== "build3");
        fields = Object.fromEntries(Object.entries(endpointFields).map(([key, value]) => [key, facts => endpointFactsEnabled ? typeof value === "function" ? value(facts) : value : ""]));
      }
      await registry.start({ version: "4.3.1", ...fields }); closers.push(registry); registries.push(registry);
    }
    let receiverCounter = null, receiverPublisher = null;
    const send = async (body, authorized = true, path = "/") => {
      const raw = JSON.stringify(body);
      const port = edge.address().port;
      return new Promise((resolve, reject) => {
        const outgoing = request({ hostname: "127.0.0.1", port, method: "POST", path, headers: {
          "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-github-event": "issues",
          "x-github-delivery": "fixture-delivery-775", "x-hub-signature-256": authorized ? `sha256=${createHmac("sha256", "fixture-secret").update(raw).digest("hex")}` : "sha256=invalid",
        } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
        outgoing.once("error", reject); outgoing.end(raw);
      });
    };
    if (["receiver", "hooks", "endpoints", "all"].includes(slice)) {
      const { makeReceiverObservations, makeReceiverPublisher } = await import("../../../worker/src/receiver-status.mjs");
      const { makeReceiver } = await import("../../../receiver/src/receiver.mjs");
      receiverCounter = makeReceiverObservations({ now });
      const handler = makeReceiver({ observations: receiverCounter, queue: {}, cfg: { servesGithub: true, webhookSecret: "fixture-secret", triggers: { github: {}, knownFlows: [] } }, selfId: 1, now, watchEnv: {} });
      edge = createServer(handler);
      await new Promise(resolve => edge.listen(0, "127.0.0.1", resolve));
      if (agedReceiver) assert.equal(await send({}, false, "/gitlab"), 404);
      else {
        assert.equal(await send({}, false), 401);
        assert.equal(await send({}, false), 401);
      }
      receiverPublisher = makeReceiverPublisher({ client: () => redis, name: receiverName, version: "4.3.1", port: edge.address().port, bind: "loopback", forges: ["github"], observations: receiverCounter, now });
      receiverPublisher.start(); closers.push(receiverPublisher);
      await drain(async () => Boolean(await redis.get(receiverRecordKey)));
      if (agedReceiver) {
        at = SETUP_AT;
        await drain(async () => { receiverPublisher.beat(); return JSON.parse(await redis.get(receiverRecordKey)).at === at; });
      }
    }
    if (["hooks", "endpoints", "all"].includes(slice)) {
      const { makeHookRunsPublisher } = await import("../../../worker/src/hook-runs.mjs");
      const { makeOnFailure } = await import("../../../worker/src/on-failure.mjs");
      const publisher = makeHookRunsPublisher({ redis, name: "build3", now }); closers.push(publisher);
      // The hook's child is synthetic; the completion callback and persistence are production code.
      // Timeout itself has injected unit coverage. Here it is a recorded historical result for display.
      const child = new EventEmitter();
      const fire = makeOnFailure({ command: "/fixture/notify", host: "build3", hostEnv: {}, realExecutablePath: value => value, spawnFn: () => child, publish: fields => publisher.publish(fields), now });
      fire({ jobId: "gh-exit-775", outcome: "failed", reason: "container-infra-exit" }); child.emit("exit", 3, null);
      publisher.publish({ jobId: "gh-timeout-775", outcome: "failed", reason: "container-infra-exit", detail: "timeout", code: null });
      await drain(async () => Number(await redis.llen("hook:h:build3")) >= 2);
    }
    return {
      ...fixture, slice, redis, now, receiverName, receiverPort: edge?.address().port ?? null, agedRefusedAt: agedReceiver ? SETUP_AT - 25 * 3_600_000 : null,
      async addRefusal() {
        assert.ok(receiverPublisher);
        assert.equal(await send({}, false), 401);
        await drain(async () => {
          receiverPublisher.beat();
          return JSON.parse(await redis.get(receiverRecordKey)).deliveries.github.unauthorized.hours.some(([, count]) => count === 3);
        });
      },
      async publishHosts() { await Promise.all(registries.map(registry => registry.publish())); },
      async removeTelemetry() {
        if (slice === "receiver" && receiverPublisher) await receiverPublisher.close();
        // Keep the hosts alive while only their optional endpoint observations disappear.
        if (slice === "endpoints") {
          endpointFactsEnabled = false;
          await Promise.all(registries.map(registry => registry.publish()));
        }
        const keys = await redis.keys(slice === "receiver" ? "receiver:*" : slice === "hooks" ? "hook:*" : "host:h:*");
        if (slice === "endpoints") for (const key of keys) await redis.hdel(key, "endpoints", "endpointsMore", "endpointsVersion", "endpointsStartedAt");
        else if (keys.length) await redis.del(...keys);
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
