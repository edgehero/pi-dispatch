import assert from "node:assert/strict";
import { mkdirSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { checkedSetupDeployment, makeSetupBroker, setupWorkerEntry } from "../src/setup-host-client.mjs";

const DIGEST = "d".repeat(64);
const plan = { digest: DIGEST, component: "worker", manager: "systemd", host: "build3", account: "ops", effects: ["start-worker"] };
function harness(reply = null, options = {}) {
  const calls = [], timers = [], kills = [];
  let child, wire;
  const broker = makeSetupBroker({
    cliPath: "/deployment/node_modules/@edgehero/pi-dispatch/src/cli.mjs", deployment: "/deployment", execPath: "/node", env: { PATH: "/bin" },
    checkDeployment: path => ({ path, uid: 501, dev: 1, ino: 2 }),
    checkEntry: (entry) => ({ entry, version: "4.3.1", identity: "test-entry" }),
    ...options,
    random: (n) => Buffer.alloc(n, 0xab),
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    spawn(bin, argv, options) {
      calls.push({ bin, argv, options }); child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
      child.stdin.end = (body) => {
        wire = JSON.parse(body);
        if (reply) queueMicrotask(() => reply({ child, wire }));
      };
      child.kill = (signal) => { kills.push(signal); queueMicrotask(() => child.emit("close", null)); };
      return child;
    },
  });
  return { broker, calls, timers, kills, child: () => child, wire: () => wire };
}
const response = (wire, extra = {}) => ({ version: 1, id: wire.id, operation: wire.operation, state: "planned", reason: "ready", plan, ...extra });
const emit = (child, value, code = 0) => { child.stdout.end(JSON.stringify(value)); child.emit("close", code); };

test("host setup transport fixes executable, argv, cwd and environment; private value travels only on stdin", async () => {
  const h = harness(({ child, wire }) => emit(child, response(wire, wire.phase === "apply" ? { state: "applied", effects: ["write-provider-key"], plan: undefined } : {})));
  assert.equal((await h.broker.preview("setup-worker-start", {})).plan.digest, DIGEST);
  const value = "synthetic-private-key";
  assert.equal((await h.broker.apply("setup-provider-key", { expected: DIGEST, input: { value } })).state, "applied");
  assert.equal(h.wire().input.value, value);
  assert.equal(h.wire().expected, DIGEST);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(call.bin, "/node");
    assert.deepEqual(call.argv, ["/deployment/node_modules/@edgehero/pi-dispatch/src/cli.mjs", "setup-host"]);
    assert.equal(call.options.cwd, "/deployment"); assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.env, { PATH: "/bin" });
    assert.equal(JSON.stringify(call).includes(value), false);
  }
  assert.ok(h.timers.every((t) => t.cleared));
});

test("apply serializes private stdin before returning its promise so the caller can release its input immediately", async () => {
  const h = harness(({ child, wire }) => emit(child, response(wire, { state: "applied", plan: undefined, effects: ["write-provider-key"] })));
  const input = { provider: "openai", key: "OPENAI_API_KEY", value: "private-serialization-canary" };
  const submitted = { ...input };
  const pending = h.broker.apply("setup-provider-key", { expected: DIGEST, input });
  input.value = undefined;
  input.provider = "deepseek";
  input.key = "DEEPSEEK_API_KEY";
  assert.deepEqual(h.wire().input, submitted, "the wire already owns the selected provider/key/value before any caller cleanup");
  assert.equal(h.wire().expected, DIGEST);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(h.calls).includes(submitted.value), false, "the serialized value never rides executable arguments or environment");
  assert.equal((await pending).state, "applied");
});

test("malformed, foreign, extended and nonzero child replies cannot enter an action response", async () => {
  for (const mutate of [
    (r) => ({ ...r, id: "0".repeat(32) }),
    (r) => ({ ...r, operation: "setup-doctor" }),
    (r) => ({ ...r, reason: "a secret from stderr" }),
    (r) => ({ ...r, secret: "never echo this" }),
    (r) => ({ ...r, plan: { ...r.plan, path: "/private/path" } }),
  ]) {
    const h = harness(({ child, wire }) => emit(child, mutate(response(wire))));
    const out = await h.broker.preview("setup-worker-start", {});
    assert.equal(out.state, "refused"); assert.equal(out.reason, "process-failed"); assert.equal(out.plan, undefined);
  }
  const h = harness(({ child, wire }) => emit(child, response(wire), 1));
  assert.equal((await h.broker.preview("setup-worker-start", {})).reason, "process-failed");
  const broken = harness(({ child }) => { child.stdout.end("uncontrolled diagnostics"); child.emit("close", 0); });
  assert.equal((await broken.broker.apply("setup-worker-start", { expected: DIGEST })).state, "unknown");
});

test("both stdout and discarded stderr are bounded, and an applied request is never retried after a broken reply", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const h = harness(({ child }) => child[stream].write("x".repeat(256 * 1024 + 1)));
    const out = await h.broker.apply("setup-worker-start", { expected: DIGEST });
    assert.equal(out.state, "unknown"); assert.equal(out.reason, "process-failed");
    assert.deepEqual(h.kills, ["SIGTERM"]); assert.equal(h.calls.length, 1);
  }
});

test("timeout and session cancellation report uncertainty after dispatch and stop the child", async () => {
  const timed = harness();
  const pending = timed.broker.apply("setup-doctor", { expected: DIGEST });
  assert.equal(timed.timers[0].ms, 120000); timed.timers[0].fn();
  const out = await pending;
  assert.equal(out.state, "unknown"); assert.equal(out.reason, "process-timeout");
  assert.deepEqual(timed.kills, ["SIGTERM"]); assert.equal(timed.calls.length, 1);
  const cancelled = harness(), controller = new AbortController();
  const next = cancelled.broker.preview("setup-worker-start", {}, { signal: controller.signal });
  controller.abort();
  assert.equal((await next).state, "refused"); assert.deepEqual(cancelled.kills, ["SIGTERM"]);
});

test("invalid or oversized requests refuse before spawning, and closed brokers dispatch nothing", async () => {
  const h = harness();
  for (const [action, input] of [["arbitrary-shell", {}], ["setup-worker-start", { provider: "anthropic" }], ["setup-provider-key", { value: "do not preview a secret in the host process" }]]) {
    assert.equal((await h.broker.preview(action, input)).reason, "invalid-request");
  }
  assert.equal((await h.broker.apply("setup-provider-key", { expected: DIGEST, input: { value: "x".repeat(65536) } })).reason, "invalid-request");
  h.broker.close();
  assert.equal((await h.broker.preview("setup-worker-start", {})).reason, "unavailable");
  assert.deepEqual(h.calls, []);
});

test("worker entry lookup verifies installed trees, tries the console's own durable tree and refuses no match", () => {
  const seen = [];
  const out = setupWorkerEntry("/deployment", {
    resolveFrom: () => { throw Error("not installed here"); },
    resolveOwn: () => "/global/node_modules/@edgehero/pi-dispatch/src/entry.mjs",
    check: ({ entry }) => { seen.push(entry); return { entry, version: "4.3.1" }; },
  });
  assert.equal(out.entry, "/global/node_modules/@edgehero/pi-dispatch/src/cli.mjs");
  assert.deepEqual(seen, [out.entry]);
  assert.deepEqual(setupWorkerEntry("/deployment", { resolveFrom: () => "/cache/src/entry.mjs", resolveOwn: () => "/cache/src/entry.mjs", check: () => ({ refusal: "unsafe-entry" }) }), { refusal: "unsafe-entry" });
});

// The child uses the CLI policy-refusal exit; it is still a well-formed, actionable result.
test("a validated CLI refusal on exit 2 keeps its reason while unexpected exits remain unknown", async () => {
  const h = harness(({ child, wire }) => emit(child, response(wire, { state: "refused", reason: "provider-managed", plan: undefined }), 2));
  const out = await h.broker.apply("setup-provider-key", { expected: DIGEST });
  assert.equal(out.state, "refused"); assert.equal(out.reason, "provider-managed");
  const wrong = harness(({ child, wire }) => emit(child, response(wire, { state: "applied", plan: undefined }), 2));
  assert.equal((await wrong.broker.apply("setup-worker-start", { expected: DIGEST })).state, "unknown");
});

// A running console does not keep executing a path whose installed artifact changed underneath it.
test("entry authority is rechecked before each child and changed identities refuse without dispatch", async () => {
  let identity = "reviewed";
  const h = harness(({ child, wire }) => emit(child, response(wire)), { checkEntry: entry => identity === null ? null : ({ entry, version: "4.3.1", identity }) });
  assert.equal((await h.broker.preview("setup-worker-start", {})).state, "planned");
  identity = "replaced";
  assert.equal((await h.broker.apply("setup-worker-start", { expected: DIGEST })).reason, "unsafe-entry");
  identity = null;
  assert.equal((await h.broker.preview("setup-worker-start", {})).reason, "unsafe-entry");
  assert.equal(h.calls.length, 1);
});


test("host grant binds the canonical deployment incarnation before dispatch, including symlink retargets and replaced directories", async () => {
  const base = realpathSync(tempDir("setup-bound-deployment-"));
  const first = join(base, "first"), second = join(base, "second"), selected = join(base, "selected");
  mkdirSync(first); mkdirSync(second); symlinkSync(first, selected);
  const h = harness(({ child, wire }) => emit(child, response(wire)), { deployment: selected, checkDeployment: checkedSetupDeployment });
  assert.equal((await h.broker.preview("setup-worker-start", {})).state, "planned");
  assert.equal(h.calls[0].options.cwd, first, "the child uses the canonical grant, not the mutable alias");
  unlinkSync(selected); symlinkSync(second, selected);
  assert.equal((await h.broker.preview("setup-worker-start", {})).reason, "unsafe-deployment");
  unlinkSync(selected); symlinkSync(first, selected);
  renameSync(first, join(base, "old-first")); mkdirSync(first);
  assert.equal((await h.broker.apply("setup-worker-start", { expected: DIGEST })).reason, "unsafe-deployment");
  assert.equal(h.calls.length, 1, "neither retargeted nor same-path replacement receives execution authority");
});
