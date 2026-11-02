import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { GATEWAY_CONSOLE_SCRIPT } from "../src/console/gateway-console-script.mjs";

const I = "A".repeat(43), P = "B".repeat(43), T0 = Date.UTC(2026, 10, 2);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const R = "r".repeat(43);
function fixture({ mode = "authorize", stored = JSON.stringify({ proof: P, gateway: "http://127.0.0.1:4791", at: T0 }), search = `?intent=${I}`, hash = `#receipt=${R}`, gesture = false, width = 1440, fetchFn = null } = {}) {
  const nodes = new Map(), timers = new Map(), navigations = [], calls = [], values = new Map([["sandbox-gateway:" + I, stored]]);
  let timerId = 0;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: true, disabled: true, handlers: {}, focus() {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
    return nodes.get(id);
  };
  const root = { getAttribute: (name) => name === "data-sandbox-gateway-gesture" ? (gesture ? "1" : "0") : mode, querySelector: (selector) => node(selector.slice(1)) };
  const scrubbed = [], location = { search, hash, pathname: "/sandbox/gateway/authorize", replace: (url) => navigations.push(url) };
  const history = { replaceState(_state, _title, url) { scrubbed.push(url); location.hash = ""; } };
  const sessionStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (fetchFn) return fetchFn(url, options);
    return { ok: true, json: async () => url === "/api/whoami" ? { name: "ops", role: "operator", readOnly: false } : url.endsWith("context") ? { ok: true, id: "gh-42", host: "mini1", by: "ops", gatewayOrigin: "http://127.0.0.1:4791" } : { ok: true, returnUrl: `http://127.0.0.1:4791/s/${I}` } };
  };
  class ClockDate extends Date { static now() { return T0; } }
  const window = { innerWidth: width, addEventListener() {} };
  runInNewContext(GATEWAY_CONSOLE_SCRIPT, { window, document: { querySelector: () => root }, location, history, sessionStorage, fetch, AbortController, URL, URLSearchParams, Date: ClockDate, setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  return { node, nodes, calls, values, timers, navigations, scrubbed, location };
}
test("step-up shows trusted identity, sends the exact original proof, clears token and consumes local proof", async () => {
  const f = fixture(); await settle();
  assert.equal(f.node("gateway-target").textContent, "gh-42 on mini1");
  assert.equal(f.node("gateway-step-up").hidden, false);
  const context = f.calls.find((c) => c.url.endsWith("context"));
  assert.deepEqual(JSON.parse(context.options.body), { intentId: I, tabProof: P, receipt: R });
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

test("Strict-cookie return bridge fetches the current sign-in before the exact relative run route", async () => {
  const f = fixture({ mode: "return", search: "?run=gh-9575" }); await settle();
  assert.deepEqual(f.calls.map((c) => c.url), ["/api/whoami"]);
  assert.deepEqual(f.navigations, ["/run?id=gh-9575"]);
  const generic = fixture({ mode: "return", search: "" }); await settle(); assert.deepEqual(generic.navigations, ["/runs/sandboxes"]);
  for (const search of ["?run=//evil.invalid", "?run=gh-1&run=gh-2", "?run=gh-1&return=https://evil.invalid", "?run="]) {
    const bad = fixture({ mode: "return", search }); await settle(); assert.equal(bad.calls.length, 0); assert.equal(bad.navigations.length, 0);
  }
});

test("selector navigation is host-bound, operator-only, writable and wide before its private page", async () => {
  const f = fixture({ mode: "select", search: "?host=mini1" }); await settle();
  assert.deepEqual(f.calls.map((c) => c.url), ["/api/whoami"]);
  assert.deepEqual(f.navigations, ["/runs/sandboxes?gatewaySelect=1&host=mini1"]);
  for (const person of [{ name: "sam", role: "viewer" }, { name: "sam", role: "agent" }, { name: "sam", role: "operator", readOnly: true }]) {
    const denied = fixture({ mode: "select", search: "?host=mini1", fetchFn: async () => ({ ok: true, json: async () => person }) }); await settle(); assert.equal(denied.navigations.length, 0); assert.equal(denied.calls.length, 1);
  }
  const phone = fixture({ mode: "select", search: "?host=mini1", width: 760 }); await settle(); assert.equal(phone.navigations.length, 0); assert.equal(phone.node("gateway-phone").hidden, false);
  for (const search of ["?host=mini1&kind=watch", "?host=mini1&host=mini1", "?host=-bad", ""]) {
    const denied = fixture({ mode: "select", search }); await settle(); assert.equal(denied.calls.length, 0); assert.equal(denied.navigations.length, 0);
  }
});

test("watch launch sends only the closed kind and target, and step-up names the actual driver", async () => {
  const launch = fixture({ mode: "launch", search: "?host=mini1&id=gh-42&kind=watch", fetchFn: async (url) => ({ ok: true, json: async () => url === "/api/whoami" ? { name: "sam", role: "operator" } : { ok: true, intentId: I, tabProof: P, launchUrl: `http://127.0.0.1:4791/s/${I}#handoff=${"C".repeat(43)}` } }) }); await settle();
  assert.deepEqual(JSON.parse(launch.calls.find((c) => c.url.endsWith("launch")).options.body), { host: "mini1", id: "gh-42", width: 1440, kind: "watch" });
  assert.match(launch.navigations[0], /#handoff=/); assert.doesNotMatch(launch.navigations[0], new RegExp(P));
  const step = fixture({ fetchFn: async (url) => ({ ok: true, json: async () => url === "/api/whoami" ? { name: "sam", role: "operator" } : { ok: true, host: "mini1", id: "gh-42", by: "sam", kind: "watch", driverName: "lee", gatewayOrigin: "http://127.0.0.1:4791" } }) }); await settle();
  assert.match(step.node("gateway-person").textContent, /sam to watch lee’s shell, read only/);
  assert.equal(step.node("gateway-authorize").textContent, "Verify and watch");
});

test("watch-limit remains actionable, clears the entered token and never navigates or automatically retries", async () => {
  const f = fixture({ fetchFn: async (url) => ({ ok: !url.endsWith("authorize"), json: async () => url === "/api/whoami" ? { name: "ops", role: "operator" } : url.endsWith("context") ? { ok: true, host: "mini1", id: "gh-42", by: "ops", kind: "watch", driverName: "lee", gatewayOrigin: "http://127.0.0.1:4791" } : { refused: "watch-limit", error: "Three watch slots are in use. Wait until a watch stops." } }) }); await settle();
  f.node("gateway-token").value = "PRIVATE_OPERATOR_TOKEN";
  await f.node("gateway-step-up").handlers.submit({ preventDefault() {} });
  assert.match(f.node("gateway-status").textContent, /Three watch slots/); assert.equal(f.node("gateway-token").value, "");
  assert.equal(f.calls.filter((c) => c.url.endsWith("authorize")).length, 1); assert.equal(f.navigations.length, 0);
  assert.equal(f.node("gateway-authorize").disabled, false); assert.ok(f.values.has("sandbox-gateway:" + I));
});

test("the receipt leaves the address at once, survives a reload, and without it nothing is asked of the console", async () => {
  const first = fixture(); await settle();
  assert.equal(first.location.hash, ""); assert.deepEqual(first.scrubbed, [`/sandbox/gateway/authorize?intent=${I}`]);
  assert.equal(JSON.parse(first.values.get("sandbox-gateway:" + I)).receipt, R);
  const reload = fixture({ stored: JSON.stringify({ proof: P, gateway: "http://127.0.0.1:4791", at: T0, receipt: R }), hash: "" }); await settle();
  assert.equal(JSON.parse(reload.calls.find((c) => c.url.endsWith("context")).options.body).receipt, R);
  assert.equal(reload.node("gateway-step-up").hidden, false);
  for (const hash of ["", "#receipt=short", `#receipt=${R}&x=1`]) {
    const refused = fixture({ hash }); await settle();
    assert.equal(refused.calls.some((c) => c.url.endsWith("context")), false, `${JSON.stringify(hash)} asks nothing of the console`);
    assert.equal(refused.node("gateway-step-up").hidden, true);
  }
});

test("a launch that did not start from a console page waits for a person before it spends anything", async () => {
  const launchReply = async (url) => ({ ok: true, json: async () => url === "/api/whoami" ? { name: "ops", role: "operator" } : { ok: true, intentId: I, tabProof: P, launchUrl: `http://127.0.0.1:4791/s/${I}#handoff=${"C".repeat(43)}` } });
  const waiting = fixture({ mode: "launch", search: "?host=mini1&id=gh-42", gesture: true, fetchFn: launchReply }); await settle();
  assert.equal(waiting.calls.some((c) => c.url.endsWith("launch")), false, "no slot and no audit row yet");
  assert.equal(waiting.node("gateway-gesture").hidden, false);
  waiting.node("gateway-continue").handlers.click(); await settle();
  assert.equal(waiting.calls.filter((c) => c.url.endsWith("launch")).length, 1);
  assert.equal(waiting.node("gateway-gesture").hidden, true); assert.equal(waiting.navigations.length, 1);
  const direct = fixture({ mode: "launch", search: "?host=mini1&id=gh-42", fetchFn: launchReply }); await settle();
  assert.equal(direct.calls.filter((c) => c.url.endsWith("launch")).length, 1, "a console page's own button goes straight on");
});
