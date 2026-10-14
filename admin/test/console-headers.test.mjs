import assert from "node:assert/strict";
import { test } from "node:test";
import { applySecurityHeaders, SECURITY_HEADERS } from "../src/console/headers.mjs";

// The header set itself (issue #640, REQ-CONSOLE-SECURITY e). That EVERY response carries it is pinned in
// console-server.test.mjs over the route table; this pins what the set says.

test("the CSP forbids inline script and framing and allows only this origin", () => {
  const csp = SECURITY_HEADERS["content-security-policy"];
  const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.deepEqual(directives["script-src"], ["'self'"]);
  assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
  assert.deepEqual(directives["base-uri"], ["'none'"]);
  assert.deepEqual(directives["form-action"], ["'self'"]);
  assert.deepEqual(directives["connect-src"], ["'self'"]);
  assert.ok(!/unsafe-inline|unsafe-eval|nonce-|sha256-|\*/.test(csp), csp);
});

test("the rest of the set, and never an Access-Control-* header", () => {
  assert.ok(Object.isFrozen(SECURITY_HEADERS));
  assert.equal(SECURITY_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(SECURITY_HEADERS["referrer-policy"], "no-referrer");
  assert.equal(SECURITY_HEADERS["cross-origin-opener-policy"], "same-origin");
  assert.equal(SECURITY_HEADERS["cross-origin-resource-policy"], "same-origin");
  assert.equal(SECURITY_HEADERS["cache-control"], "no-store");
  assert.match(SECURITY_HEADERS["permissions-policy"], /camera=\(\)/);
  for (const name of Object.keys(SECURITY_HEADERS)) {
    assert.equal(name, name.toLowerCase());
    assert.ok(!name.startsWith("access-control-"), name);
  }
});

test("applySecurityHeaders sets every header in the set", () => {
  const set = {};
  applySecurityHeaders({ setHeader: (k, v) => (set[k] = v) });
  assert.deepEqual(set, { ...SECURITY_HEADERS });
});
