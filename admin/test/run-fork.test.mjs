import { test } from "node:test";
import assert from "node:assert/strict";
import { planRunFork, enqueueRunFork, readForkPoints } from "../src/run-fork.mjs";

const id = "a".repeat(32);
const digest = "b".repeat(64);
const request = { jobId: "source-job", entry: "entry01", position: "before" };
function deps(extra = {}) {
  return { env: {}, policyDigestFn: async () => ({ ok: true, digest: "policy-digest" }), readSource: async () => ({ ok: true, manifest: { sourceDigest: digest, sessionKey: "c".repeat(32) } }),
    planRerunFn: async () => ({ plan: { kind: "forge", forge: "github", queue: "pi-jobs", job: { repo: "owner/repo", target: { type: "issue", number: 7 }, flow: "fix", provider: "test", model: "small", models: ["test/small", "test/large"], trigger: { deliveryId: "new-delivery" } } } }),
    random: () => Buffer.from(id, "hex"), ...extra };
}

test("managed fork reconstructs current policy and preserves the source binding", async () => {
  const got = await planRunFork({ ...request, ...deps(), model: "large", thinking: "high", message: "Try the other approach" });
  assert.equal(got.plan.job.model, "large");
  assert.equal(got.plan.job.thinkingLevel, "high");
  assert.deepEqual(got.plan.job.fork, { id, fromJob: "source-job", fromEntry: "entry01", position: "before", sourceDigest: digest, rootKey: "c".repeat(32), message: "Try the other approach" });
  assert.deepEqual(got.plan.job.models, ["test/small", "test/large"]);
});

test("source refusal happens before trigger reconstruction or queue work", async () => {
  const got = await planRunFork({ ...request, ...deps({ readSource: async () => ({ refusal: "fork-point-unavailable" }), planRerunFn: () => { throw new Error("must not read queue"); } }) });
  assert.equal(got.refusal, "fork-point-unavailable");
});

test("model choice cannot widen the current trigger policy", async () => {
  assert.equal((await planRunFork({ ...request, ...deps(), model: "forbidden" })).refusal, "model-not-allowed");
});

test("invalid fork inputs refuse before reading a source", async () => {
  for (const change of [{ entry: "../x" }, { position: "after" }, { thinking: "infinite" }, { model: "bad model" }, { provider: "../bad" }, { message: "\0" }, { message: "x".repeat(16_385) }]) {
    const got = await planRunFork({ ...request, ...deps({ readSource: () => { throw new Error("must not read"); } }), ...change });
    assert.equal(typeof got.refusal, "string");
  }
});

test("confirmation rejects policy changes, and an unchanged plan queues its fixed fork id", async () => {
  const d = deps();
  const { plan } = await planRunFork({ ...request, ...d });
  let writes = 0;
  const queued = await enqueueRunFork(plan, { ...d, enqueueFn: async (p) => { writes++; assert.equal(p.job.fork.id, id); return { ok: true }; } });
  assert.equal(queued.ok, true);
  const changed = await enqueueRunFork(plan, { ...d, planForkFn: async () => ({ plan: { ...plan, policyDigest: "changed" } }), enqueueFn: () => { throw new Error("must not queue"); } });
  assert.match(changed.refusal, /changed since/);
  assert.equal(writes, 1);
});

test("confirmation refuses expired or replaced source before enqueue", async () => {
  const { plan } = await planRunFork({ ...request, ...deps() });
  const got = await enqueueRunFork(plan, deps({ readSource: async (q) => { assert.equal(q.sourceDigest, digest); return { refusal: "fork-source-expired" }; }, enqueueFn: () => { throw new Error("must not queue"); } }));
  assert.equal(got.refusal, "fork-source-expired");
});

test("source metadata reader validates run identity and forwards exact point binding", async () => {
  const store = { readPoint(q) { assert.deepEqual(q, { runId: "source-job", entryId: "entry01", position: "at", sourceDigest: digest }); return { ok: true, manifest: {}, entries: [] }; } };
  assert.equal((await readForkPoints({ jobId: "../bad", store })).refusal, "fork-source-invalid-run");
  assert.equal((await readForkPoints({ ...request, position: "at", sourceDigest: digest, store })).ok, true);
});

test("copy-mode OpenShell is refused in the source reader before any paid action is offered", async () => {
  const store = { read: () => ({ ok: true, manifest: { venue: "openshell" }, entries: [] }) };
  assert.equal((await readForkPoints({ jobId: "source-job", store })).refusal, "openshell-fork-unsupported");
});

test("the default provider is resolved before judging an allowed-model list", async () => {
  const got = await planRunFork({ ...request, ...deps({ planRerunFn: async () => ({ plan: { kind: "forge", forge: "github", queue: "pi-jobs", job: { target: { type: "issue", number: 7 }, model: "small", models: ["anthropic/small"] } } }) }) });
  assert.equal(got.plan.runFields.model, "anthropic/small");
});




test("the preview names the derived branch and freezes the shown model across settings changes", async () => {
  const d = deps({ overlay: { provider: "test", model: "small" }, planRerunFn: async () => ({ plan: { kind: "forge", forge: "github", queue: "pi-jobs", job: { repo: "owner/repo", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "new-delivery" }, models: ["test/small", "test/large"] } } }) });
  const { plan } = await planRunFork({ ...request, ...d });
  assert.equal(plan.branch, `pi/issue-7-fork-${id}`);
  assert.deepEqual([plan.job.provider, plan.job.model, plan.request.provider, plan.request.model], ["test", "small", "test", "small"]);
  const got = await enqueueRunFork(plan, { ...d, overlay: { provider: "test", model: "large" }, enqueueFn: async (queued) => {
    assert.deepEqual([queued.job.provider, queued.job.model], ["test", "small"]);
    return { ok: true };
  } });
  assert.equal(got.ok, true);
});


test("a wider deployment cap cannot widen the confirmed fork, and a narrower hold needs a new preview", async () => {
  const d = deps({ overlay: { maxCostUsd: "1.000001" } });
  const { plan } = await planRunFork({ ...request, ...d });
  assert.equal(plan.job.maxCostUsd, "1.000001");
  assert.equal(plan.job.forkReserveMicros, 1_000_001);
  assert.equal(plan.request.maxCostUsd, "1.000001");
  const wide = await enqueueRunFork(plan, { ...d, overlay: { maxCostUsd: "20" }, enqueueFn: async (queued) => {
    assert.equal(queued.job.maxCostUsd, "1.000001");
    return { ok: true };
  } });
  assert.equal(wide.ok, true);
  const narrow = await enqueueRunFork(plan, { ...d, overlay: { maxCostUsd: "0.50" }, enqueueFn: () => { throw new Error("must preview the changed hold"); } });
  assert.match(narrow.refusal, /changed since/);
});

test("an uncapped preview cannot silently acquire a different reservation at confirmation", async () => {
  const d = deps();
  const { plan } = await planRunFork({ ...request, ...d });
  assert.equal(plan.reserve.capMicros, null);
  assert.equal(plan.job.forkReserveMicros, null);
  const got = await enqueueRunFork(plan, { ...d, overlay: { maxCostUsd: "2" }, enqueueFn: () => { throw new Error("must not queue"); } });
  assert.match(got.refusal, /changed since/);
});


test("a zero-rated preview is pinned in queue data and cannot become a paid reservation at confirmation", async () => {
  const modelEndpoints = { endpoints: [{ id: "test-endpoint", host: "host.docker.internal", port: 11434, slots: 1, keyless: true }], models: { providers: { test: { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "small" }, { id: "large" }] } } } };
  const d = deps({ overlay: { maxCostUsd: "2" }, modelEndpoints });
  const { plan } = await planRunFork({ ...request, ...d });
  assert.equal(plan.reserve.zeroRated, true);
  assert.equal(plan.job.forkReserveMicros, 0);
  const got = await enqueueRunFork(plan, { ...d, modelEndpoints: null, enqueueFn: () => { throw new Error("must not queue a newly paid fork"); } });
  assert.match(got.refusal, /changed since/);
});
