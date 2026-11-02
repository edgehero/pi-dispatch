import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { GATEWAY_CONSOLE_SCRIPT } from "../src/console/gateway-console-script.mjs";

const I = "A".repeat(43), P = "B".repeat(43), T0 = Date.UTC(2026, 10, 2);
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ mode = "authorize", stored = JSON.stringify({ proof: P, gateway: "http://127.0.0.1:4791", at: T0 }), search = `?intent=${I}`, fetchFn = null } = {}) {
  const nodes = new Map(), timers = new Map(), navigations = [], calls = [], values = new Map([["sandbox-gateway:" + I, stored]]);
  let timerId = 0;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: true, disabled: true, handlers: {}, focus() {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
    return nodes.get(id);
  };
  const root = { getAttribute: () => mode, querySelector: (selector) => node(selector.slice(1)) };
  const location = { search, replace: (url) => navigations.push(url) };
  const sessionStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (fetchFn) return fetchFn(url, options);
    return { ok: true, json: async () => url === "/api/whoami" ? { name: "ops", role: "operator", readOnly: false } : url.endsWith("context") ? { ok: true, id: "gh-42", host: "mini1", by: "ops", gatewayOrigin: "http://127.0.0.1:4791" } : { ok: true, returnUrl: `http://127.0.0.1:4791/s/${I}` } };
  };
  class ClockDate extends Date { static now() { return T0; } }
  const window = { innerWidth: 1440, addEventListener() {} };
  runInNewContext(GATEWAY_CONSOLE_SCRIPT, { window, document: { querySelector: () => root }, location, sessionStorage, fetch, AbortController, URL, URLSearchParams, Date: ClockDate, setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  return { node, nodes, calls, values, timers, navigations };
}
test("step-up shows trusted identity, sends the exact original proof, clears token and consumes local proof", async () => {
  const f = fixture(); await settle();
  assert.equal(f.node("gateway-target").textContent, "gh-42 on mini1");
  assert.equal(f.node("gateway-step-up").hidden, false);
  const context = f.calls.find((c) => c.url.endsWith("context"));
  assert.deepEqual(JSON.parse(context.options.body), { intentId: I, tabProof: P });
  assert.equal(context.options.headers["x-console-as"], "ops.operator");
  const token = "PRIVATE_OPERATOR_TOKEN"; f.node("gateway-token").value = token;
  await f.node("gateway-step-up").handlers.submit({ preventDefault() {} });
  assert.equal(f.node("gateway-token").value, "");
  assert.equal(f.values.size, 0);
  assert.deepEqual(f.navigations, [`http://127.0.0.1:4791/s/${I}`]);
  assert.ok(!JSON.stringify([...f.nodes.values()]).includes(token));
});
test("corrupt, expired or incomplete local state cannot reflect a proof or request private context", async () => {
  for (const stored of ["{PRIVATE_PROOF", JSON.stringify({ proof: P, gateway: "http://127.0.0.1:4791" }), JSON.stringify({ proof: P, gateway: "http://127.0.0.1:4791", at: null }), JSON.stringify({ proof: P, gateway: "PRIVATE_PROOF", at: T0 })]) {
    const f = fixture({ stored }); await settle();
    assert.equal(f.calls.filter((c) => c.url.endsWith("context")).length, 0);
    assert.equal(f.node("gateway-step-up").hidden, true);
    assert.ok(!JSON.stringify([...f.nodes.values()]).includes("PRIVATE_PROOF"));
    assert.match(f.node("gateway-status").textContent, /Restart from Sandboxes/);
  }
});
test("a hung request aborts at the bounded deadline and leaves a native fallback without retry", async () => {
  let aborted = false;
  const f = fixture({ fetchFn: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); })) });
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0](); await settle();
  assert.equal(aborted, true); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.node("gateway-step-up").hidden, true);
  assert.match(f.node("gateway-status").textContent, /did not answer in time/);
});
test("duplicate and unknown navigation fields refuse before session/context requests", async () => {
  for (const search of [`?intent=${I}&intent=${I}`, `?intent=${I}&token=PRIVATE`, "?return=https://evil.invalid"]) {
    const f = fixture({ search }); await settle(); assert.equal(f.calls.length, 0); assert.equal(f.navigations.length, 0);
    assert.match(f.node("gateway-status").textContent, /not usable/);
  }
});
