import assert from "node:assert/strict";
import { test } from "node:test";
import { contentTypeRefusal, GATEWAY_HOSTS, hostnameOf, hostRefusal, isGatewayHost, makeLoginLimiter, originRefusal, readOnlyRefusal, roleRefusal } from "../src/console/guards.mjs";

// The console's pure guards (issue #640, REQ-CONSOLE-SECURITY b, c, d). The HTTP tests drive them through the
// dispatcher; these pin each rule's edges without a socket.

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

test("hostnameOf keeps the name, drops any port and one trailing dot, lowercases, and refuses anything else", () => {
  assert.equal(hostnameOf("LocalHost:8080"), "localhost");
  assert.equal(hostnameOf("localhost."), "localhost");
  assert.equal(hostnameOf("[::1]:9999"), "[::1]");
  assert.equal(hostnameOf("127.0.0.1"), "127.0.0.1");
  for (const bad of ["", "user@localhost", "localhost/x", "localhost:abc", "localhost:", "[::1", "[evil.test]", "local host", "a..b", "-a.test", "localhost:123456"]) {
    assert.equal(hostnameOf(bad), null, JSON.stringify(bad));
  }
});

test("hostRefusal: loopback names on any port pass; rebinding names, gateway names and garbage are refused", () => {
  for (const ok of ["127.0.0.1:4790", "localhost:9999", "[::1]:1", "localhost", "LOCALHOST.:80"]) assert.equal(hostRefusal(ok, []), null, ok);
  for (const bad of ["evil.test", "127.0.0.1.nip.io", "localhost.evil.test", "127.0.0.2", "0.0.0.0", "[::2]", undefined, "", "   "]) {
    assert.equal(typeof hostRefusal(bad, []), "string", String(bad));
  }
  for (const gw of GATEWAY_HOSTS) {
    assert.match(hostRefusal(`${gw}:4790`, []), /container gateway/);
    // even when someone managed to list it: the gateway rule is checked first
    assert.match(hostRefusal(gw, [gw]), /container gateway/);
    assert.ok(isGatewayHost(`${gw.toUpperCase()}.`));
  }
  assert.equal(hostRefusal("console.lan:8443", ["console.lan"]), null);
  assert.equal(hostRefusal("console.lan.", ["Console.LAN"]), null);
  assert.equal(typeof hostRefusal("sub.console.lan", ["console.lan"]), "string", "an allowed name does not allow its subdomains");
});

test("originRefusal: Sec-Fetch-Site must be same-origin when present, and Origin must be http://<Host> always", () => {
  const base = { host: "localhost:9999", origin: "http://localhost:9999" };
  assert.equal(originRefusal({ ...base, "sec-fetch-site": "same-origin" }), null);
  assert.equal(originRefusal(base), null, "no Sec-Fetch-Site: Origin decides");
  for (const site of ["same-site", "cross-site", "none", "", "SAME-ORIGIN"]) assert.match(originRefusal({ ...base, "sec-fetch-site": site }), /Sec-Fetch-Site/, site);
  assert.match(originRefusal({ host: base.host, "sec-fetch-site": "same-origin" }), /Origin/);
  assert.match(originRefusal({ host: base.host }), /Origin/);
  for (const origin of ["http://localhost:3000", "https://localhost:9999", "null", "http://localhost:9999/", "http://evil.test"]) {
    assert.match(originRefusal({ ...base, origin }), /origin/i, origin);
  }
  assert.match(originRefusal({ origin: "http://localhost:9999" }), /origin/i, "no Host to compare against");
  assert.equal(originRefusal({ host: "LOCALHOST:9999", origin: "http://localhost:9999" }), null, "case-insensitive");
});

test("contentTypeRefusal: application/json (any case, any parameters) only", () => {
  for (const ok of ["application/json", "Application/JSON; charset=utf-8"]) assert.equal(contentTypeRefusal({ "content-type": ok }), null, ok);
  for (const bad of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", "application/json-patch+json", undefined]) {
    assert.match(contentTypeRefusal({ "content-type": bad }), /application\/json/, String(bad));
  }
});

test("readOnlyRefusal and roleRefusal", () => {
  assert.equal(readOnlyRefusal({ readOnly: false }), null);
  assert.match(readOnlyRefusal({ readOnly: true }), /PI_CONSOLE_READ_ONLY/);
  assert.equal(roleRefusal({ role: "operator" }, "operator"), null);
  assert.equal(roleRefusal({ role: "operator" }, "viewer"), null);
  assert.equal(roleRefusal({ role: "viewer" }, "viewer"), null);
  assert.match(roleRefusal({ role: "viewer" }, "operator"), /operator role/);
  assert.match(roleRefusal({ role: "shell" }, "viewer"), /viewer role/, "an unknown role ranks lowest");
  assert.match(roleRefusal(null, "viewer"), /absent/);
});

test("the login limiter: a burst of 10, then one per 12 s at 5 a minute, never above the burst", () => {
  let t = T0;
  const limiter = makeLoginLimiter({ now: () => t });
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.take(), true, `burst ${i}`);
  assert.equal(limiter.take(), false);
  assert.equal(limiter.retryAfterSec(), 12);
  t += 11_999;
  assert.equal(limiter.take(), false);
  t += 1;
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
  t += 3_600_000;
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false, "an hour idle refills to the burst, not beyond");
  t -= 60_000;
  assert.equal(limiter.take(), false, "a clock that steps back adds nothing");
});
