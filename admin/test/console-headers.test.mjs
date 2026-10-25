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

// Issue #737: the error pages are served under this same header set (the dispatcher sets it before any route or
// refusal), so they must work under its CSP: no inline script, no inline style, no handler attribute, and the one
// script by URL. Drawn here directly for every kind, with hostile values where a kind takes one.
test("every error page holds to the CSP: one script by URL, no inline script or style, no on*= or style=", async () => {
  const { ERROR_KINDS, errorPage } = await import("../src/console/error-pages.mjs");
  const hostile = `"><script>alert(1)</script><style>*{}</style><img onerror=1 style=x>`;
  for (const kind of ERROR_KINDS) {
    for (const session of [null, { name: hostile, role: "operator" }]) {
      const text = String(errorPage({ kind, session, readOnly: true, sentence: hostile, host: hostile, port: 7788, page: "runs", theme: "dark" }).html);
      const label = `${kind}${session ? " signed in" : ""}`;
      assert.deepEqual(text.match(/<script\b[^>]*>/g), ['<script src="/static/console.js" defer>'], label);
      assert.ok(!/<style\b/i.test(text), `${label}: no style element`);
      // Attribute values emptied first: \`html\` escapes every quote inside one, so a value never holds a \`"\`, and an escaped
      // hostile name inside a title (" onerror=1") is text there, not an attribute.
      const tags = text.replace(/"[^"]*"/g, '""');
      assert.ok(!/<[^>]*\s(?:on[a-z]+|style)\s*=/i.test(tags), `${label}: no handler or style attribute`);
      assert.ok(!/<[^>]*\s(?:href|src|action|formaction)\s*=\s*"\s*javascript:/i.test(text), label);
      assert.ok(!text.includes("<script>alert") && !text.includes("<img onerror"), `${label}: the hostile value is escaped`);
    }
  }
});
