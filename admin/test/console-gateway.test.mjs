import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createConsoleServer } from "../src/console/server.mjs";
import { SECURITY_HEADERS } from "../src/console/headers.mjs";
import * as cookies from "../src/console/sessions.mjs";
import { findToken } from "../../worker/src/console-tokens.mjs";

const AT = Date.UTC(2026, 10, 2), TOKEN = "pdc_" + "t".repeat(43);
async function fixture(t, { readOnly = false, canonical = null } = {}) {
  const now = () => AT, audit = [], calls = [];
  const file = { version: 1, generation: 0, tokens: ["operator", "viewer", "agent"].map((role) => ({ name: role, role, sha256: createHash("sha256").update(role === "operator" ? TOKEN : role).digest("hex") })) };
  const sessions = cookies.makeSessionStore({ now });
  const ids = Object.fromEntries(file.tokens.map((entry) => [entry.role, sessions.create({ name: entry.name, role: entry.role, tokenHash: entry.sha256, generation: 0 }).id]));
  const gateway = Object.fromEntries(["launch", "context", "authorize"].map((method) => [method, async (input) => { calls.push({ method, input }); return { ok: true }; }]));
  const server = createConsoleServer({ config: { allowedHosts: ["console.example"], readOnly, maxMs: 3600000, logsDir: tempDir("gateway-http-") }, sessions, cookies, now, audit: { append: (row) => audit.push(row) }, readTokens: () => ({ file }), findToken, gateway, consoleOrigin: typeof canonical === "function" ? canonical : () => canonical });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const port = server.address().port;
  const send = (path, { role = "operator", method = "POST", origin = `http://localhost:${port}`, host = `localhost:${port}`, site = "same-origin", body = {}, person = role + "." + role, extra = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host, ...(origin === null ? {} : { origin }), ...(site === null ? {} : { "sec-fetch-site": site }), "content-type": "application/json", ...(role ? { cookie: "pdc_session=" + ids[role] } : {}), ...(person ? { "x-console-as": person } : {}), ...extra } }, (res) => { let text = ""; res.on("data", (b) => text += b); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text })); });
    req.on("error", reject); req.end(method === "POST" ? JSON.stringify(body) : undefined);
  });
  return { send, calls, audit, port };
}
test("generic gateway landings reveal no sandbox data and carry unchanged console CSP", async (t) => {
  const f = await fixture(t);
  for (const mode of ["launch", "authorize", "return", "select"]) {
    const out = await f.send(`/sandbox/gateway/${mode}?host=PRIVATE_HOST&id=PRIVATE_RUN&intent=PUBLIC`, { role: null, method: "GET", person: null });
    assert.equal(out.status, 200); assert.ok(!out.text.includes("PRIVATE_HOST")); assert.ok(!out.text.includes("PRIVATE_RUN"));
    assert.match(out.text, /id="gateway-token"[^>]*disabled/); assert.ok(!out.text.includes('name="token"'));
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) assert.equal(out.headers[key], value, `${mode}: ${key}`);
    assert.equal(out.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(f.calls.length, 0);
});
test("every gateway API refuses viewer, agent, switched person, foreign origin and read-only before broker", async (t) => {
  const f = await fixture(t);
  for (const operation of ["launch", "context", "authorize"]) {
    const path = `/api/sandbox-gateway/${operation}`;
    for (const role of ["viewer", "agent"]) assert.equal((await f.send(path, { role })).status, 403);
    assert.equal((await f.send(path, { person: "someone.operator" })).status, 409);
    assert.equal((await f.send(path, { origin: "http://evil.example" })).status, 403);
    assert.equal((await f.send(path, { site: "same-site" })).status, 403);
    assert.equal((await f.send(path, { origin: null })).status, 403);
  }
  assert.equal(f.calls.length, 0);
  const ro = await fixture(t, { readOnly: true });
  assert.equal((await ro.send("/api/sandbox-gateway/launch")).status, 403); assert.equal(ro.calls.length, 0);
});
test("protected HTTPS canonical origin works through the actual dispatcher without trusting proxy headers", async (t) => {
  const f = await fixture(t, { canonical: "https://console.example" });
  const path = "/api/sandbox-gateway/launch";
  assert.equal((await f.send(path, { origin: "https://console.example", host: "console.example" })).status, 200);
  assert.equal(f.calls[0].input.origin, "https://console.example");
  for (const origin of ["http://console.example", "https://evil.example", "https://console.example:444"]) assert.equal((await f.send(path, { origin, host: "console.example", extra: { "x-forwarded-proto": "https", "forwarded": "proto=https;host=console.example" } })).status, 403);
  assert.equal((await f.send(path, { origin: "https://console.example", host: `localhost:${f.port}` })).status, 403);
  assert.equal(f.calls.length, 1);
});
test("protected HTTPS login sets a Secure host-only cookie and sign-out expires that same cookie identity", async (t) => {
  const f = await fixture(t, { canonical: "https://console.example" });
  const address = { origin: "https://console.example", host: "console.example", role: null, person: null };
  const signedIn = await f.send("/login", { ...address, body: { token: TOKEN } });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers["set-cookie"]?.[0];
  assert.match(cookie, /^pdc_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600; Secure$/);
  assert.doesNotMatch(cookie, /Domain=/i);
  const presented = cookie.split(";", 1)[0];
  assert.equal((await f.send("/api/whoami", { ...address, method: "GET", extra: { cookie: presented } })).status, 200);
  const signedOut = await f.send("/logout", { ...address, extra: { cookie: presented } });
  assert.equal(signedOut.status, 200);
  assert.deepEqual(signedOut.headers["set-cookie"], [cookies.clearSessionCookie()]);
  assert.match(signedOut.headers["set-cookie"][0], /^pdc_session=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
  assert.equal((await f.send("/api/whoami", { ...address, method: "GET", extra: { cookie: presented } })).status, 401);
});
test("HTTP-loopback login preserves its plain cookie even when forwarding headers claim HTTPS", async (t) => {
  const f = await fixture(t);
  const signedIn = await f.send("/login", { role: null, person: null, body: { token: TOKEN }, extra: { "x-forwarded-proto": "https", forwarded: "proto=https;host=console.example" } });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers["set-cookie"]?.[0], /^pdc_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600$/);
  const enrolled = await fixture(t, { canonical: "http://localhost:4790" });
  const loopback = await enrolled.send("/login", { origin: "http://localhost:4790", host: "localhost:4790", role: null, person: null, body: { token: TOKEN } });
  assert.equal(loopback.status, 200);
  assert.doesNotMatch(loopback.headers["set-cookie"][0], /; Secure/);
});
test("login cookie security uses the same protected declaration the origin guard judged, without a second read", async (t) => {
  let reads = 0;
  const f = await fixture(t, { canonical: () => ++reads === 1 ? "https://console.example" : null });
  const result = await f.send("/login", { origin: "https://console.example", host: "console.example", role: null, person: null, body: { token: TOKEN } });
  assert.equal(result.status, 200);
  assert.equal(reads, 1);
  assert.match(result.headers["set-cookie"][0], /; Secure$/);
});
test("step-up clears raw token body and has an actual attempt limit", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.send("/api/sandbox-gateway/authorize", { body: { token: TOKEN } })).status, 200);
  assert.equal((await f.send("/api/sandbox-gateway/authorize", { body: { token: TOKEN } })).status, 429);
  assert.equal(f.calls.length, 10);
  assert.ok(f.calls.every((c) => c.input.body.token === ""));
  assert.ok(!JSON.stringify(f.audit).includes(TOKEN));
});
