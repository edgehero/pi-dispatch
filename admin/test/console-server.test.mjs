import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeLoginLimiter } from "../src/console/guards.mjs";
import { SECURITY_HEADERS } from "../src/console/headers.mjs";
import { html, page } from "../src/console/html.mjs";
import * as realPages from "../src/console/pages.mjs";
import { ACTIONS } from "../src/console/actions.mjs";
import { BODY_LIMIT, createConsoleServer, lookupRoute, REFUSAL_ROWS_PER_MINUTE, ROUTES, SERVER_LIMITS, STATE_UNREADABLE, STREAMS_TOTAL_MAX } from "../src/console/server.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { writePauseWindows as realWritePauseWindows } from "../src/read-model.mjs";

// The console's dispatcher over a real node:http server on 127.0.0.1:0 (issue #640, REQ-CONSOLE-SECURITY). Requests
// are raw `http.request` calls so each test controls Host, Origin and Sec-Fetch-Site exactly as a hostile page or a
// rebinding attacker would send them. Every collaborator is a small fake; the pause-windows writer is the real one, so
// the preview's digest is held to what the writer puts on disk.

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// Test tokens in the real shape, so the leak canary below has something a real leak would look like.
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;
const FILE = {
  version: 1,
  generation: 0,
  tokens: [
    { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
    { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
  ],
};

// Everything any test saw, for the canary, and every secret it must not find there: session ids and one-time codes
// join the tokens as they are minted or presented.
const seen = { logs: [], audit: [], bodies: [] };
const secrets = new Set();

// One counter for every store, so each session id in the run is distinct and the canary can tell them apart.
let sessionCount = 0;
function fakeSessions() {
  const live = new Map();
  return {
    live,
    create({ name, role, tokenHash, generation }) {
      sessionCount += 1;
      const id = `s${String(sessionCount).padStart(42, "0")}`;
      secrets.add(id);
      live.set(id, { id, name, role, tokenHash, generation });
      return { id };
    },
    get(id, file) {
      const s = live.get(id);
      if (!s) return null;
      if (!file.tokens.some((t) => t.sha256 === s.tokenHash && t.role === s.role)) {
        live.delete(id);
        return null;
      }
      return { ...s };
    },
    peek(id, file) {
      const s = live.get(id);
      return s && file.tokens.some((t) => t.sha256 === s.tokenHash && t.role === s.role) ? { ...s } : null;
    },
    destroy(id) {
      live.delete(id);
    },
    streamAcquire: (id) => live.has(id),
    streamRelease() {},
  };
}

/**
 * The pages module as the server sees it (issue #641): the REAL table and query parser, so the routes and refusals
 * under test are the shipped ones, and a renderer that stands in for the screens (their own tests are C's).
 */
function fakePages(loads = []) {
  return {
    ...realPages,
    loadPageData: async (name, query, deps) => (loads.push({ name, query, deps }), { name }),
    pagePanels: async () => [],
    renderPage: async (name, ctx) => ({
      status: 200,
      html: page({ title: name, name, body: html`<main><p>Signed in as <strong>${ctx.session.name}</strong> (${ctx.session.role}).</p>${ctx.readOnly ? html`<p>read-only</p>` : null}</main>` }),
    }),
  };
}

const fakeCookies = {
  sessionCookie: (id, { maxAgeSec }) => `pdc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`,
  clearSessionCookie: () => "pdc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  readSessionCookie: (header) => {
    const m = /(?:^|;\s*)pdc_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(header ?? "");
    return m ? m[1] : null;
  },
  sessionDigest: (id) => sha256(id).slice(0, 12),
};

function fakeTickets(now) {
  const held = new Map();
  let n = 0;
  return {
    held,
    issue(entry) {
      n += 1;
      const ticket = `ticket-${n}`;
      held.set(ticket, { ...entry, expiresAt: now() + 300000 });
      return { ticket };
    },
    redeem({ sessionId, ticket, action }) {
      const entry = held.get(ticket);
      held.delete(ticket);
      if (!entry) return { refusal: "this confirmation is not valid" };
      if (entry.expiresAt <= now()) return { refusal: "this confirmation has expired" };
      if (entry.sessionId !== sessionId) return { refusal: "this confirmation belongs to another sign-in" };
      if (entry.action !== action) return { refusal: "this confirmation was issued for another action" };
      return { entry };
    },
  };
}

function fakeAudit() {
  const rows = [];
  const audit = {
    rows,
    failNext: 0,
    append(row) {
      if (audit.failNext > 0) {
        audit.failNext -= 1;
        const e = new Error("disk full");
        e.code = "ENOSPC";
        throw e;
      }
      rows.push(row);
      seen.audit.push(JSON.stringify(row));
      return row;
    },
  };
  return audit;
}

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

/** A running console with fakes; returns helpers for raw requests. */
async function start(overrides = {}) {
  const dir = tempDir("console-server-");
  let t = T0;
  const now = () => t;
  const audit = fakeAudit();
  const sessions = fakeSessions();
  const tickets = fakeTickets(now);
  const writes = [];
  const codes = new Map(overrides.codes ?? []);
  for (const [code] of codes) secrets.add(code);
  const codesTried = [];
  const loads = [];
  const config = { allowedHosts: [], readOnly: false, maxMs: 12 * 3600000, pauseWindowsPath: join(dir, "pause-windows.json"), ...overrides.config };
  const server = createConsoleServer({
    config,
    now,
    audit,
    sessions,
    cookies: fakeCookies,
    tickets,
    limiter: overrides.limiter ?? makeLoginLimiter({ now }),
    log: (line) => seen.logs.push(line),
    readTokens: () => ({ file: FILE }),
    findToken: (file, presented) => file.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: (code) => {
      codesTried.push(code);
      const name = codes.get(code);
      codes.delete(code);
      return name ? { name } : { refusal: "unknown" };
    },
    writePauseWindows: (args) => {
      writes.push(args);
      return (overrides.writePauseWindows ?? realWritePauseWindows)(args);
    },
    pages: overrides.pages ?? fakePages(loads),
    pageDeps: overrides.pageDeps ?? { fleet: { snapshot: async () => overrides.snapshot ?? {} } },
    hub: overrides.hub ?? null,
    ...(overrides.limits && { limits: overrides.limits }),
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;

  // A body is sent with its Content-Length, as a browser's fetch sends a string body; `chunked` sends it without one.
  function send({ method = "GET", path = "/", headers = {}, body = null, chunked = false }) {
    return new Promise((resolve, reject) => {
      const length = body !== null && !chunked ? { "content-length": String(Buffer.byteLength(body)) } : {};
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...length, ...headers }, setHost: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          seen.bodies.push(text);
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
  }
  const writeHeaders = (extra = {}) => ({ origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
  const post = (path, obj, extra = {}) => send({ method: "POST", path, headers: writeHeaders(extra), body: JSON.stringify(obj) });
  async function login(token = OP_TOKEN, extra = {}) {
    const res = await post("/login", { token }, extra);
    const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0] ?? null;
    return { res, cookie };
  }
  return { server, port, host, dir, config, audit, sessions, tickets, writes, codes, codesTried, loads, send, post, login, writeHeaders, advance: (ms) => (t += ms) };
}

// ---- Host (REQ-CONSOLE-SECURITY b) ----

test("a rebinding or container-gateway Host is refused 421 on a page and on a write, and the write is audited", async () => {
  const c = await start();
  for (const host of ["evil.test", "evil.test:80", "host.docker.internal", `host.docker.internal:${c.port}`, "HOST.CONTAINERS.INTERNAL", "gateway.docker.internal", "127.0.0.1.nip.io", "localhost.evil.test", ""]) {
    const page = await c.send({ path: "/healthz", headers: { host } });
    assert.equal(page.status, 421, `GET with Host ${JSON.stringify(host)}`);
    const before = c.audit.rows.length;
    const write = await c.send({ method: "POST", path: "/login", headers: { ...c.writeHeaders(), host, origin: `http://${host}` }, body: JSON.stringify({ token: OP_TOKEN }) });
    assert.equal(write.status, 421, `POST with Host ${JSON.stringify(host)}`);
    assert.equal(c.audit.rows.length, before + 1);
    assert.equal(c.audit.rows.at(-1).action, "refused");
    assert.match(c.audit.rows.at(-1).reason, /^host: /);
  }
  assert.equal(c.sessions.live.size, 0, "no rebinding request signed anyone in");
});

test("a tunnel's Host on another port is accepted: localhost:9999, 127.0.0.1:1 and [::1]:8080", async () => {
  const c = await start();
  for (const host of ["localhost:9999", "127.0.0.1:1", "[::1]:8080", "LOCALHOST.", "localhost"]) {
    const res = await c.send({ path: "/healthz", headers: { host } });
    assert.equal(res.status, 200, host);
    assert.equal(res.text, "ok");
  }
  // and a write through the tunnel, with the tunnel's own Origin, passes every guard and signs in
  const res = await c.send({ method: "POST", path: "/login", headers: { ...c.writeHeaders(), host: "localhost:9999", origin: "http://localhost:9999" }, body: JSON.stringify({ token: OP_TOKEN }) });
  assert.equal(res.status, 200);
});

test("an extra name in allowedHosts is accepted, with any port", async () => {
  const c = await start({ config: { allowedHosts: ["console.lan"] } });
  assert.equal((await c.send({ path: "/healthz", headers: { host: "console.lan:4790" } })).status, 200);
  assert.equal((await c.send({ path: "/healthz", headers: { host: "other.lan" } })).status, 421);
});

// ---- Origin, content type (REQ-CONSOLE-SECURITY c) ----

test("same-site and cross-site writes are refused 403 and audited; same-origin is accepted", async () => {
  const c = await start();
  for (const site of ["same-site", "cross-site", "none", "Same-Origin"]) {
    const before = c.audit.rows.length;
    const res = await c.post("/login", { token: OP_TOKEN }, { "sec-fetch-site": site });
    assert.equal(res.status, 403, site);
    assert.equal(c.audit.rows.length, before + 1);
    assert.equal(c.audit.rows.at(-1).action, "refused");
    assert.match(c.audit.rows.at(-1).reason, /^origin: /);
  }
  assert.equal(c.sessions.live.size, 0);
  assert.equal((await c.post("/login", { token: OP_TOKEN })).status, 200);
});

test("a write with no Origin, or with another origin, is refused 403 even when Sec-Fetch-Site claims same-origin", async () => {
  const c = await start();
  const res = await c.send({ method: "POST", path: "/login", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token: OP_TOKEN }) });
  assert.equal(res.status, 403);
  assert.match(res.json().error, /Origin/);
  const noFetchMeta = await c.send({ method: "POST", path: "/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: OP_TOKEN }) });
  assert.equal(noFetchMeta.status, 403);
  for (const origin of ["http://localhost:3000", `https://${c.host}`, "null", `http://${c.host}.evil.test`]) {
    assert.equal((await c.post("/login", { token: OP_TOKEN }, { origin })).status, 403, origin);
  }
  // no Sec-Fetch-Site (an older engine) with the right Origin is accepted
  const old = await c.send({ method: "POST", path: "/login", headers: { origin: `http://${c.host}`, "content-type": "application/json" }, body: JSON.stringify({ token: OP_TOKEN }) });
  assert.equal(old.status, 200);
});

test("a form-encoded, multipart or text/plain write is refused 403 (a cross-site form needs no preflight for those)", async () => {
  const c = await start();
  for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", undefined]) {
    const headers = c.writeHeaders();
    if (type === undefined) delete headers["content-type"];
    else headers["content-type"] = type;
    const res = await c.send({ method: "POST", path: "/login", headers, body: `token=${OP_TOKEN}` });
    assert.equal(res.status, 403, String(type));
    assert.match(c.audit.rows.at(-1).reason, /^content-type: /);
  }
  assert.equal(c.sessions.live.size, 0);
});

test("EVERY write route in ROUTES (every action's preview and confirm among them) refuses same-site, cross-site, a missing Origin, form-encoded and text/plain 403 before auth, and audits each (derived from the table)", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const writeRoutes = ROUTES.filter((r) => r.write);
  for (const a of ACTIONS) for (const step of ["preview", "confirm"]) assert.ok(writeRoutes.some((r) => r.path === `/api/act/${a.name}/${step}`), `${a.name} ${step} is in the loop`);
  for (const route of writeRoutes) {
    // A minute per route, so the anonymous refusal budget (REFUSAL_ROWS_PER_MINUTE) writes every row asserted here.
    c.advance(60_000);
    for (const site of ["same-site", "cross-site"]) {
      const res = await c.post(route.path, { ticket: "x" }, { cookie, "sec-fetch-site": site });
      assert.equal(res.status, 403, `${route.path} ${site}`);
      assert.match(c.audit.rows.at(-1).reason, /^origin: /, `${route.path} ${site} audited`);
    }
    const noOrigin = c.writeHeaders({ cookie });
    delete noOrigin.origin;
    const bare = await c.send({ method: "POST", path: route.path, headers: noOrigin, body: JSON.stringify({ ticket: "x" }) });
    assert.equal(bare.status, 403, `${route.path} no Origin`);
    assert.match(c.audit.rows.at(-1).reason, /^origin: a write must carry an Origin header/);
    for (const type of ["application/x-www-form-urlencoded", "text/plain"]) {
      const res = await c.send({ method: "POST", path: route.path, headers: c.writeHeaders({ cookie, "content-type": type }), body: "ticket=x" });
      assert.equal(res.status, 403, `${route.path} ${type}`);
      assert.match(c.audit.rows.at(-1).reason, /^content-type: /, `${route.path} ${type} audited`);
    }
  }
  assert.equal(c.writes.length, 0);
  assert.equal(c.tickets.held.size, 0);
});

test("OPTIONS is a 405 with no Access-Control-* header, so no preflight ever succeeds", async () => {
  const c = await start();
  for (const path of ["/login", "/api/pause-windows/confirm", "/nowhere"]) {
    const res = await c.send({ method: "OPTIONS", path, headers: { origin: "http://evil.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.ok(res.status === 405 || res.status === 404, `${path}: ${res.status}`);
    assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith("access-control-")), [], path);
  }
});

// ---- headers on every response (REQ-CONSOLE-SECURITY e) ----

function assertSecurityHeaders(res, label) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name], value, `${label}: ${name}`);
  assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith("access-control-")), [], label);
}

test("EVERY route in ROUTES answers with every security header, unauthenticated and signed in (derived from the table)", async () => {
  const c = await start();
  const { cookie } = await c.login();
  assert.ok(ROUTES.length >= 11);
  for (const route of ROUTES) {
    const label = `${route.method} ${route.path}`;
    const body = route.method === "POST" ? "{}" : null;
    const anon = await c.send({ method: route.method, path: route.path, headers: route.write ? c.writeHeaders() : {}, body });
    assertSecurityHeaders(anon, `${label} (anonymous, ${anon.status})`);
    const signed = await c.send({ method: route.method, path: route.path, headers: { ...(route.write ? c.writeHeaders() : {}), cookie }, body: route.path === "/logout" ? null : body });
    assertSecurityHeaders(signed, `${label} (signed in, ${signed.status})`);
  }
});

test("every refusal and error status carries the headers too: 400, 401, 403, 404, 405, 413, 421, 429, 303", async () => {
  const c = await start({ limiter: { take: () => false, retryAfterSec: () => 12 } });
  const cases = [
    [await c.send({ path: "/nowhere" }), 404],
    [await c.send({ method: "DELETE", path: "/login" }), 405],
    [await c.send({ path: "/", headers: { host: "evil.test" } }), 421],
    [await c.post("/login", { token: OP_TOKEN }, { "sec-fetch-site": "cross-site" }), 403],
    [await c.send({ path: "/api/whoami" }), 401],
    [await c.send({ path: "/" }), 303],
    [await c.post("/login", { token: OP_TOKEN }), 429],
    [await c.send({ method: "POST", path: "/login", headers: c.writeHeaders(), body: "{not json" }), 400],
    [await c.send({ method: "POST", path: "/login", headers: c.writeHeaders(), body: "x".repeat(BODY_LIMIT + 1) }), 413],
  ];
  for (const [res, status] of cases) {
    assert.equal(res.status, status);
    assertSecurityHeaders(res, String(status));
  }
});

test("the route table: every route declares auth and write, writes are POST, and lookups answer 405 with Allow", () => {
  for (const r of ROUTES) {
    assert.ok(["none", "viewer", "operator"].includes(r.auth), r.path);
    assert.equal(typeof r.write, "boolean", r.path);
    assert.equal(r.write, r.method === "POST", `${r.path}: a POST is a write and only a POST is`);
    assert.equal(typeof r.handler, "function");
  }
  // Only signing in and out may pass a read-only console.
  assert.deepEqual(ROUTES.filter((r) => r.readOnlyExempt).map((r) => r.path).sort(), ["/login", "/login/code", "/logout"]);
  assert.deepEqual(lookupRoute("PUT", "/login"), { allow: ["GET", "HEAD", "POST"] });
  assert.equal(lookupRoute("HEAD", "/healthz").route.path, "/healthz");
  assert.equal(lookupRoute("GET", "/missing"), null);
  assert.deepEqual(SERVER_LIMITS, { headersTimeout: 10000, requestTimeout: 30000, maxConnections: 64, connectionsCheckingInterval: 1000 });
  // Issue #641: one GET route per screen, its auth taken from the pages' own table (derived, never restated), and
  // the overview is `/`.
  for (const [name, spec] of Object.entries(realPages.PAGES)) {
    const found = lookupRoute("GET", spec.path);
    assert.equal(found?.route?.page, name, spec.path);
    assert.equal(found.route.auth, spec.auth, `${spec.path}: the page's own auth`);
    assert.equal(lookupRoute("HEAD", spec.path).route, found.route, `${spec.path}: HEAD is served by the GET route`);
  }
  assert.equal(lookupRoute("GET", "/").route.page, "overview");
  assert.equal(realPages.PAGES.audit.auth, "operator");
  const fixed = Object.fromEntries(ROUTES.filter((r) => !r.page).map((r) => [`${r.method} ${r.path}`, r.auth]));
  assert.equal(fixed["GET /api/state"], "viewer");
  assert.equal(fixed["GET /api/events"], "viewer");
  assert.equal(fixed["GET /static/console.css"], "none");
  // Issue #642: two operator write routes per action, generated from the table; #640's paths stay as aliases.
  for (const a of ACTIONS) {
    for (const step of ["preview", "confirm"]) {
      const found = lookupRoute("POST", `/api/act/${a.name}/${step}`)?.route;
      assert.ok(found, `${a.name} ${step}`);
      assert.deepEqual([found.auth, found.write, found.action, found.readOnlyExempt ?? false], ["operator", true, a.name, false]);
    }
  }
  assert.equal(lookupRoute("POST", "/api/pause-windows/preview").route.action, "pause-windows");
  assert.equal(lookupRoute("POST", "/api/pause-windows/confirm").route.action, "pause-windows");
  assert.equal(ROUTES.filter((r) => r.path.startsWith("/api/act/")).length, 2 * ACTIONS.length);
  assert.equal(STREAMS_TOTAL_MAX, 32);
  assert.ok(STREAMS_TOTAL_MAX < SERVER_LIMITS.maxConnections, "streams can never take every connection");
});

test("the server carries its limits", async () => {
  const c = await start();
  assert.equal(c.server.headersTimeout, 10000);
  assert.equal(c.server.requestTimeout, 30000);
  assert.equal(c.server.maxConnections, 64);
});

// ---- auth, role, read-only (REQ-CONSOLE-SECURITY d) ----

test("unauthenticated: a page redirects to /login, an API answers 401, a write answers 401 and is audited", async () => {
  const c = await start();
  const page = await c.send({ path: "/" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, "/login");
  const api = await c.send({ path: "/api/whoami" });
  assert.equal(api.status, 401);
  assert.match(api.headers["set-cookie"]?.[0] ?? "", /^pdc_session=;.*Max-Age=0/, "a stale cookie is cleared");
  const write = await c.post("/api/pause-windows/preview", { windows: [] });
  assert.equal(write.status, 401);
  assert.equal(c.audit.rows.at(-1).action, "refused");
  assert.match(c.audit.rows.at(-1).reason, /^auth: /);
  // a forged cookie for no session is the same as none
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie: `pdc_session=${"x".repeat(43)}` } })).status, 401);
});

// The operator's writes, from the table (issue #642, REQ-CONSOLE-SECURITY d): every action route is one of them.
const OPERATOR_WRITES = ROUTES.filter((r) => r.write && r.auth === "operator");

test("a viewer's write is refused 403 and audited with the viewer's name, on EVERY operator write route; the viewer can still read", async () => {
  const c = await start();
  const { cookie } = await c.login(VIEW_TOKEN);
  const who = await c.send({ path: "/api/whoami", headers: { cookie } });
  assert.deepEqual(who.json(), { name: "vic", role: "viewer", readOnly: false });
  assert.ok(OPERATOR_WRITES.length >= 2 * ACTIONS.length, "every action's two routes are operator writes");
  for (const route of OPERATOR_WRITES) {
    const res = await c.post(route.path, { windows: [], ticket: "x" }, { cookie });
    assert.equal(res.status, 403, route.path);
    assert.match(res.json().error, /operator role/);
    const row = c.audit.rows.at(-1);
    assert.equal(row.action, "refused");
    assert.equal(row.outcome, "refused");
    assert.equal(row.target, route.path);
    assert.equal(row.actor.name, "vic");
    assert.equal(row.actor.role, "viewer");
    assert.equal(row.actor.session, sha256(cookie.split("=")[1]).slice(0, 12));
    assert.match(row.reason, /^role: /);
  }
  assert.equal(c.writes.length, 0);
  assert.equal(c.tickets.held.size, 0, "no preview ran");
});

test("read-only refuses an operator's write 403 and audits it on EVERY write route but sign-in and out, and still lets people sign in and out", async () => {
  const c = await start({ config: { readOnly: true } });
  const { res: signedIn, cookie } = await c.login();
  assert.equal(signedIn.status, 200);
  for (const route of ROUTES.filter((r) => r.write && !r.readOnlyExempt)) {
    const res = await c.post(route.path, { windows: [], ticket: "x" }, { cookie });
    assert.equal(res.status, 403, route.path);
    assert.match(res.json().error, /read-only/);
    assert.match(c.audit.rows.at(-1).reason, /^read-only: /);
  }
  assert.equal(c.writes.length, 0);
  assert.equal(c.tickets.held.size, 0);
  assert.equal((await c.post("/logout", {}, { cookie })).status, 200);
});

// ---- body limit ----

test("a body over 64 KiB is refused 413 without being read", async () => {
  const c = await start();
  const res = await c.send({ method: "POST", path: "/login", headers: c.writeHeaders(), body: JSON.stringify({ token: "x".repeat(BODY_LIMIT) }) });
  assert.equal(res.status, 413);
  assert.equal(res.headers.connection, "close", "the unread body is not left on a kept-alive connection");
  assert.equal(c.sessions.live.size, 0);
  // exactly at the limit is read (and is simply a wrong token)
  const fits = `{"token":"${"y".repeat(BODY_LIMIT - 12)}"}`;
  assert.equal(Buffer.byteLength(fits), BODY_LIMIT);
  assert.equal((await c.send({ method: "POST", path: "/login", headers: c.writeHeaders(), body: fits })).status, 401);
});

test("a signed-in write refused for its body (bad JSON, not an object, over 64 KiB) gets its own audit row with the session's actor and no byte of the body", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const canary = "body-canary-91c2";
  const cases = [
    [`{"windows": "${canary}"`, 400, "body: the request body is not valid JSON"],
    [`["${canary}"]`, 400, "body: the request body must be a JSON object"],
    [JSON.stringify({ windows: canary, pad: "x".repeat(BODY_LIMIT) }), 413, `body: the request body is larger than ${BODY_LIMIT} bytes`],
  ];
  for (const [body, status, reason] of cases) {
    const before = c.audit.rows.length;
    const res = await c.send({ method: "POST", path: "/api/pause-windows/preview", headers: c.writeHeaders({ cookie }), body });
    assert.equal(res.status, status, reason);
    assert.equal(c.audit.rows.length, before + 1, `${reason}: one row`);
    const row = c.audit.rows.at(-1);
    assert.deepEqual([row.action, row.outcome, row.reason, row.target, row.actor.name], ["refused", "refused", reason, "/api/pause-windows/preview", "alice"]);
    assert.ok(!JSON.stringify(row).includes(canary), "no body content in the row");
  }
  assert.equal(c.writes.length, 0);
});

test("a chunked body that grows past 64 KiB is cut off mid-stream (no length to answer 413 from), and nothing is done", async () => {
  // readRawBody (the worker's shared bounded reader) destroys the request at the first chunk over the limit, so the
  // client sees the connection end rather than a status. The memory bound is the property; the 413 status is for a
  // declared length, which is what a browser's fetch sends.
  const c = await start();
  await assert.rejects(c.send({ method: "POST", path: "/login", headers: c.writeHeaders(), body: JSON.stringify({ token: OP_TOKEN, pad: "x".repeat(BODY_LIMIT) }), chunked: true }), { code: "ECONNRESET" });
  assert.equal(c.sessions.live.size, 0);
});

// ---- sign-in ----

test("sign-in: a valid token sets an HttpOnly SameSite=Strict cookie with a FRESH id; a planted cookie is destroyed", async () => {
  const c = await start();
  const first = await c.login();
  assert.equal(first.res.status, 200);
  const set = first.res.headers["set-cookie"][0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Max-Age=43200/);
  assert.deepEqual(first.res.json(), { ok: true, name: "alice", role: "operator" });
  // signing in again while presenting the old cookie mints a new id and ends the old session
  const second = await c.login(OP_TOKEN, { cookie: first.cookie });
  assert.notEqual(second.cookie, first.cookie);
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie: first.cookie } })).status, 401);
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie: second.cookie } })).status, 200);
  const row = c.audit.rows.at(-1);
  assert.equal(row.action, "login");
  assert.equal(row.outcome, "ok");
  assert.equal(row.actor.name, "alice");
});

test("a wrong token is 401, audited as login-failed, and never echoed", async () => {
  const c = await start();
  const wrong = `pdc_${"w".repeat(43)}`;
  const res = await c.post("/login", { token: wrong });
  assert.equal(res.status, 401);
  assert.equal(res.headers["set-cookie"], undefined);
  const row = c.audit.rows.at(-1);
  assert.equal(row.action, "login-failed");
  assert.equal(row.actor.name, "anonymous");
  assert.ok(!JSON.stringify(row).includes(wrong));
  assert.ok(!res.text.includes(wrong));
  assert.equal((await c.post("/login", {})).status, 401, "no token at all");
  assert.equal((await c.post("/login", { token: 7 })).status, 401, "a non-string token");
});

test("the sign-in rate limit answers 429 with Retry-After after the burst, and refills with the clock", async () => {
  const c = await start();
  const wrong = { token: "nope" };
  for (let i = 0; i < 10; i += 1) assert.equal((await c.post("/login", wrong)).status, 401, `attempt ${i + 1}`);
  const limited = await c.post("/login", { token: OP_TOKEN });
  assert.equal(limited.status, 429, "even the right token waits once the bucket is empty");
  assert.equal(limited.headers["retry-after"], "12");
  assert.equal(c.audit.rows.at(-1).reason, "sign-in rate limit");
  assert.equal(c.sessions.live.size, 0);
  c.advance(12000);
  assert.equal((await c.post("/login", { token: OP_TOKEN })).status, 200);
});

test("a sign-in whose audit row cannot be written is refused and leaves no session", async () => {
  const c = await start();
  c.audit.failNext = 1;
  const res = await c.post("/login", { token: OP_TOKEN });
  assert.equal(res.status, 500);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(c.sessions.live.size, 0);
});

test("a one-time code signs in once; a used, unknown or malformed one is 401 and audited", async () => {
  const code = "c".repeat(43);
  const c = await start({ codes: [[code, "alice"]] });
  const ok = await c.post("/login/code", { code });
  assert.equal(ok.status, 200);
  assert.match(ok.headers["set-cookie"][0], /^pdc_session=/);
  assert.equal(c.audit.rows.at(-1).action, "login-code");
  assert.equal(c.audit.rows.at(-1).outcome, "ok");
  for (const again of [code, "d".repeat(43), "<script>", ""]) {
    const res = await c.post("/login/code", { code: again });
    assert.equal(res.status, 401);
    assert.equal(c.audit.rows.at(-1).action, "login-code");
    assert.equal(c.audit.rows.at(-1).outcome, "refused");
    assert.ok(!JSON.stringify(c.audit.rows.at(-1)).includes(code));
  }
  assert.deepEqual(c.codesTried, [code, code, "d".repeat(43)], "a malformed code is refused before it reaches the code store");
});

test("sign-out destroys the session, clears the cookie and is audited", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const res = await c.post("/logout", {}, { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal(c.sessions.live.size, 0);
  assert.equal(c.audit.rows.at(-1).action, "logout");
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie } })).status, 401);
});

test("a signed-in page escapes and shows the name, and serves its script and stylesheet from URLs, never inline", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const res = await c.send({ path: "/", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/html/);
  assert.match(res.text, /Signed in as <strong>alice<\/strong> \(operator\)/);
  assert.match(res.text, /<script src="\/static\/console.js" defer><\/script>/);
  assert.equal((res.text.match(/<script/g) ?? []).length, 1);
  assert.equal(c.loads.at(-1).name, "overview", "/ is the overview page");
  const js = await c.send({ path: "/static/console.js" });
  assert.match(js.headers["content-type"], /^text\/javascript/);
  assert.match(js.text, /history\.replaceState/);
  assert.match(js.text, /location\.hash/);
  // The fragment leaves history BEFORE the code is posted, so neither a failed post nor the back button can replay it.
  const codeBranch = js.text.slice(js.text.indexOf('page === "login-code"'));
  assert.ok(codeBranch.indexOf("history.replaceState") < codeBranch.indexOf('post("/login/code"'), "replaceState runs before the post");
  const css = await c.send({ path: "/static/console.css" });
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  assert.equal(css.text, CONSOLE_CSS);
  assertSecurityHeaders(css, "the stylesheet");
});

// ---- issue #641: the screens, /api/state and the stream's refusals ----

test("every page: signed out it redirects to /login; signed in it loads its data with the console's deps and renders; HEAD sends no body", async () => {
  const pageDeps = { fleet: { snapshot: async () => ({}) }, marker: "the-deps" };
  const c = await start({ pageDeps });
  const { cookie } = await c.login();
  for (const [name, spec] of Object.entries(realPages.PAGES)) {
    const anon = await c.send({ path: spec.path });
    assert.equal(anon.status, 303, spec.path);
    assert.equal(anon.headers.location, "/login");
    // `run` needs an id; every other page renders bare.
    const path = name === "run" ? `${spec.path}?id=job-1` : spec.path;
    const res = await c.send({ path, headers: { cookie } });
    assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 200)}`);
    assert.equal(c.loads.at(-1).name, name);
    assert.equal(c.loads.at(-1).deps, pageDeps, "loadPageData reads with the deps the CLI built");
    const head = await c.send({ method: "HEAD", path, headers: { cookie } });
    assert.equal(head.status, 200, `HEAD ${path}`);
    assert.equal(head.text, "", `HEAD ${path} has no body`);
    assertSecurityHeaders(head, `HEAD ${path}`);
  }
});

test("a viewer is refused an operator page 403, and gets every viewer page", async () => {
  const c = await start();
  const { cookie } = await c.login(VIEW_TOKEN);
  for (const [name, spec] of Object.entries(realPages.PAGES)) {
    const path = name === "run" ? `${spec.path}?id=job-1` : spec.path;
    const res = await c.send({ path, headers: { cookie } });
    assert.equal(res.status, spec.auth === "operator" ? 403 : 200, path);
  }
});

test("the session's role reaches the page read: a viewer's /insights?paths=full asks the assembly for folder names only", async () => {
  const asked = [];
  const pageDeps = { insights: async (window, opts) => (asked.push(opts), {}), now: T0 };
  const c = await start({ pageDeps, pages: { ...fakePages(), loadPageData: realPages.loadPageData } });
  for (const [token, want] of [[VIEW_TOKEN, false], [OP_TOKEN, true]]) {
    const { cookie } = await c.login(token);
    const res = await c.send({ path: "/insights?paths=full", headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(asked.splice(0), [{ fullPaths: want }], token === VIEW_TOKEN ? "viewer" : "operator");
  }
});

test("a page query the page refuses is 400 with the security headers, before any data is read", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const before = c.loads.length;
  for (const path of ["/?zz%00=1", "/insights?range=forever", `/run?id=${"x".repeat(5000)}`, "/run?id=a%0Ab"]) {
    const res = await c.send({ path, headers: { cookie } });
    assert.equal(res.status, 400, path);
    assertSecurityHeaders(res, path);
    assert.equal(typeof res.json().error, "string");
  }
  assert.equal(c.loads.length, before, "a refused query reads nothing");
});

test("/api/state: role-aware JSON of the fleet snapshot; a viewer never gets failedReason, signed out is 401", async () => {
  const snapshot = {
    queue: { pausedState: true, counts: { waiting: 5 } },
    failed: { rows: [{ jobId: "j1", queue: "pi", attemptsMade: 2, endedAt: 7, failedReason: "free text from a job" }], more: 0 },
    parked: [{ target: "o/r#1", kind: "github", jobId: "j2", ageMs: 10, chainCount: null, answered: false }],
  };
  const c = await start({ snapshot });
  assert.equal((await c.send({ path: "/api/state" })).status, 401);
  const op = await c.login();
  const viewer = await c.login(VIEW_TOKEN);
  const a = await c.send({ path: "/api/state", headers: { cookie: op.cookie } });
  const b = await c.send({ path: "/api/state", headers: { cookie: viewer.cookie } });
  assert.equal(a.status, 200);
  assert.match(a.headers["content-type"], /^application\/json/);
  assertSecurityHeaders(b, "/api/state");
  assert.equal(a.json().paused.state, true);
  assert.equal(a.json().counts.waiting, 5);
  assert.deepEqual(a.json().parked, [{ target: "o/r#1", kind: "github", ageMs: 10, chainCount: null }]);
  assert.equal(a.json().failed.rows[0].failedReason, "free text from a job");
  assert.equal(b.json().role, "viewer");
  assert.equal(a.json().version, 1);
  assert.ok(!b.text.includes("free text from a job"));
  assert.equal(b.json().failed.rows[0].jobId, "j1");
});

test("/api/state: a snapshot that rejects (Valkey down) is 503 {version, error} with a fixed sentence and the security headers, never the error's text", async () => {
  const c = await start({ pageDeps: { fleet: { snapshot: async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 10.9.8.7:6379 secret-host"), { code: "ECONNREFUSED" })) } } });
  const { cookie } = await c.login();
  const res = await c.send({ path: "/api/state", headers: { cookie } });
  assert.equal(res.status, 503, res.text);
  assert.match(res.headers["content-type"], /^application\/json/);
  assertSecurityHeaders(res, "/api/state 503");
  assert.deepEqual(res.json(), { version: 1, error: STATE_UNREADABLE });
  assert.ok(!res.text.includes("10.9.8.7") && !res.text.includes("secret-host"), "no error text leaves the process");
  assert.ok(seen.logs.some((l) => l.includes("/api/state could not read the fleet (ECONNREFUSED)")), "the log names the code alone");
  assert.ok(!seen.logs.some((l) => l.includes("10.9.8.7")));
});

test("/api/events: a Last-Event-ID of the hub's shape reaches the hub; any other shape reaches it as no id at all (so the whole view is sent)", async () => {
  const seenIds = [];
  const c = await start({ hub: { subscribe: (args) => (seenIds.push(args.lastEventId), () => {}), endSession() {} } });
  const { cookie } = await c.login();
  const open = (id) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${c.port}`, cookie, ...(id !== undefined && { "last-event-id": id }) };
      const req = request({ host: "127.0.0.1", port: c.port, path: "/api/events?page=overview", headers, setHost: false }, (res) => {
        res.once("data", () => (req.destroy(), resolve(res.statusCode)));
      });
      req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
      req.end();
    });
  const ids = ["cafebabe-12", "cafebabe-12x", "CAFEBABE-12", "cafebabe_12", "12", "cafebabe-", "-12", `${"a".repeat(17)}-1`, `cafebabe-${"1".repeat(16)}`];
  for (const id of [...ids, undefined]) assert.equal(await open(id), 200, String(id));
  assert.deepEqual(seenIds, ["cafebabe-12", null, null, null, null, null, null, null, null, null]);
});

test("sign-out ends the session's live streams at once through the hub", async () => {
  const ended = [];
  const c = await start({ hub: { endSession: (id) => ended.push(id), subscribe: () => () => {} } });
  const { cookie } = await c.login();
  const id = cookie.split("=")[1];
  assert.equal((await c.post("/logout", {}, { cookie })).status, 200);
  assert.deepEqual(ended, [id]);
});

// ---- the reference write ----

const WINDOWS = [{ scope: "global", days: ["sat", "sun"], from: "00:00", to: "23:59", tz: "UTC" }];

test("pause windows: preview then confirm writes exactly the previewed file, audits it with both digests, and the ticket is single use", async () => {
  const c = await start();
  const { cookie } = await c.login();
  writeFileSync(c.config.pauseWindowsPath, `${JSON.stringify({ windows: [] }, null, 2)}\n`);
  const beforeText = readFileSync(c.config.pauseWindowsPath, "utf8");
  const preview = await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie });
  assert.equal(preview.status, 200, preview.text);
  const p = preview.json();
  assert.deepEqual(p.before, []);
  assert.deepEqual(p.after, WINDOWS);
  assert.equal(p.beforeDigest, sha256(beforeText));
  assert.equal(readFileSync(c.config.pauseWindowsPath, "utf8"), beforeText, "a preview writes nothing");
  const confirm = await c.post("/api/pause-windows/confirm", { ticket: p.ticket }, { cookie });
  assert.equal(confirm.status, 200, confirm.text);
  const written = readFileSync(c.config.pauseWindowsPath, "utf8");
  // The preview's digest IS the digest of what the real writer put on disk.
  assert.equal(sha256(written), p.afterDigest);
  assert.deepEqual(JSON.parse(written).windows, WINDOWS);
  const row = c.audit.rows.at(-1);
  assert.equal(row.action, "write");
  assert.equal(row.outcome, "ok");
  assert.equal(row.target, c.config.pauseWindowsPath);
  assert.equal(row.beforeDigest, p.beforeDigest);
  assert.equal(row.afterDigest, p.afterDigest);
  assert.equal(row.ticket, sha256(p.ticket).slice(0, 12));
  // the writer got the preview's snapshot as `expect`
  assert.deepEqual(c.writes.at(-1).expect, [{ path: c.config.pauseWindowsPath, text: beforeText }]);
  const reuse = await c.post("/api/pause-windows/confirm", { ticket: p.ticket }, { cookie });
  assert.equal(reuse.status, 409);
  assert.equal(c.audit.rows.at(-1).outcome, "refused");
  assert.equal(c.writes.length, 1);
});

test("pause windows: an invalid list is refused at preview with the loader's reason; no ticket, no write", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const res = await c.post("/api/pause-windows/preview", { windows: [{ scope: "global", days: ["someday"] }] }, { cookie });
  assert.equal(res.status, 400);
  assert.equal(c.tickets.held.size, 0);
  assert.equal((await c.post("/api/pause-windows/preview", { windows: "all" }, { cookie })).status, 400);
});

test("pause windows: a ticket from another session is refused and nothing is written", async () => {
  const c = await start();
  const a = await c.login();
  const b = await c.login();
  const p = (await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie: a.cookie })).json();
  const res = await c.post("/api/pause-windows/confirm", { ticket: p.ticket }, { cookie: b.cookie });
  assert.equal(res.status, 409);
  assert.match(res.json().error, /another sign-in/);
  assert.equal(c.writes.length, 0);
});

test("pause windows: a file changed after the preview is refused by the writer, audited ok then failed, and left as the other writer made it", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const p = (await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie })).json();
  const theirs = `${JSON.stringify({ windows: [{ scope: "global", days: ["mon"], from: "01:00", to: "02:00", tz: "UTC" }] }, null, 2)}\n`;
  writeFileSync(c.config.pauseWindowsPath, theirs);
  const res = await c.post("/api/pause-windows/confirm", { ticket: p.ticket }, { cookie });
  assert.equal(res.status, 409, res.text);
  assert.match(res.json().error, /changed after/);
  assert.equal(readFileSync(c.config.pauseWindowsPath, "utf8"), theirs);
  const [okRow, failedRow] = c.audit.rows.slice(-2);
  assert.equal(okRow.outcome, "ok");
  assert.equal(failedRow.outcome, "failed");
  assert.equal(failedRow.ticket, okRow.ticket, "the compensating row names the same ticket");
});

test("pause windows: an audit append failure refuses the confirm with 500 and writes nothing", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const p = (await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie })).json();
  c.audit.failNext = 1;
  const res = await c.post("/api/pause-windows/confirm", { ticket: p.ticket }, { cookie });
  assert.equal(res.status, 500);
  assert.match(res.json().error, /audit log/);
  assert.equal(c.writes.length, 0, "the writer was never called");
  assert.throws(() => readFileSync(c.config.pauseWindowsPath, "utf8"), { code: "ENOENT" });
});

test("pause windows: a writer that throws gets a compensating failed row and a 500", async () => {
  const c = await start({
    writePauseWindows: () => {
      const e = new Error("rename failed");
      e.code = "EXDEV";
      throw e;
    },
  });
  const { cookie } = await c.login();
  const p = (await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie })).json();
  const res = await c.post("/api/pause-windows/confirm", { ticket: p.ticket }, { cookie });
  assert.equal(res.status, 500);
  assert.equal(c.audit.rows.at(-1).outcome, "failed");
  assert.match(c.audit.rows.at(-1).reason, /EXDEV/);
});

test("pause windows: a confirm applies the PREVIEWED windows, whatever its own body carries", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const p = (await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie })).json();
  const other = [{ scope: "*", from: "00:00", to: "23:59" }];
  const confirm = await c.post("/api/pause-windows/confirm", { ticket: p.ticket, windows: other }, { cookie });
  assert.equal(confirm.status, 200, confirm.text);
  assert.deepEqual(JSON.parse(readFileSync(c.config.pauseWindowsPath, "utf8")).windows, WINDOWS);
});

test("a method a known path does not take is 405 naming the methods it does take", async () => {
  const c = await start();
  const res = await c.send({ method: "DELETE", path: "/login" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET, HEAD, POST");
});

test("a query string never reaches the request log or an audit row", async () => {
  const c = await start();
  const marker = "q9secretq9";
  await c.send({ path: `/healthz?token=${marker}` });
  await c.send({ path: `/api/whoami?x=${marker}` });
  await c.send({ method: "POST", path: `/login?code=${marker}`, headers: { ...c.writeHeaders(), host: "evil.test" }, body: "{}" });
  await c.send({ method: "POST", path: `/login?code=${marker}`, headers: c.writeHeaders({ "sec-fetch-site": "cross-site" }), body: "{}" });
  for (const text of [...seen.logs, ...seen.audit]) assert.ok(!text.includes(marker), text);
});

test("refusals without a session are written one row each only up to the limit; the rest are counted into one row", async () => {
  const c = await start();
  const flood = 2 * REFUSAL_ROWS_PER_MINUTE + 50;
  for (let i = 0; i < flood; i += 1) {
    const res = await c.post("/api/pause-windows/preview", { windows: [] }, { "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 403, "every one is still refused");
  }
  assert.equal(c.audit.rows.length, 2 * REFUSAL_ROWS_PER_MINUTE, "the burst is written, the rest are not");
  c.advance(60_000);
  await c.post("/api/pause-windows/preview", { windows: [] }, { "sec-fetch-site": "cross-site" });
  const [summary, next] = c.audit.rows.slice(-2);
  assert.equal(summary.action, "refused");
  assert.equal(summary.target, "(rate limited)");
  assert.match(summary.reason, /^50 more refusals without a session went unwritten/);
  assert.match(next.reason, /^origin: /);
  // A signed-in refusal is always its own row, whatever the anonymous budget.
  const { cookie } = await c.login(VIEW_TOKEN);
  for (let i = 0; i < 2 * REFUSAL_ROWS_PER_MINUTE; i += 1) await c.post("/api/pause-windows/preview", { windows: [] }, { "sec-fetch-site": "cross-site" });
  const before = c.audit.rows.length;
  assert.equal((await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie })).status, 403);
  assert.equal(c.audit.rows.length, before + 1);
  assert.equal(c.audit.rows.at(-1).actor.name, "vic");
});

test("an idle connection that sends nothing is closed soon after the header timeout, so idle sockets cannot hold every slot", { timeout: 30_000 }, async () => {
  const c = await start();
  const { connect } = await import("node:net");
  const opened = Date.now();
  const socket = connect(c.port, "127.0.0.1");
  socket.resume();
  await new Promise((resolve) => socket.once("close", resolve));
  const held = Date.now() - opened;
  assert.ok(held < SERVER_LIMITS.headersTimeout + 3 * SERVER_LIMITS.connectionsCheckingInterval, `held ${held} ms`);
});

test("an absolute-form or scheme-relative request target is refused 400, never resolved to a route", async () => {
  const c = await start();
  const { cookie } = await c.login();
  for (const path of ["http://evil.test/api/whoami", "//evil.test/api/whoami", "*"]) {
    const res = await c.send({ path, headers: { cookie } });
    assert.equal(res.status, 400, path);
    assert.ok(res.headers["content-security-policy"], "the refusal carries the headers too");
  }
});

test("pause windows: a preview refuses a field the file does not take, a non-object entry and a nested value", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const base = { scope: "*", from: "01:00", to: "02:00" };
  const bad = [
    [{ ...base, note: "x" }, /does not take/],
    [JSON.parse('[{"scope":"*","from":"01:00","to":"02:00","__proto__":{"scope":"zzz"}}]')[0], /does not take/],
    [[[[]]], /not an object/],
    [{ ...base, scope: { deep: [[[]]] } }, /scope must be a string/],
    [{ ...base, days: [["mon"]] }, /days must be a list of weekday names/],
  ];
  for (const [w, why] of bad) {
    const res = await c.post("/api/pause-windows/preview", { windows: [w] }, { cookie });
    assert.equal(res.status, 400, JSON.stringify(w));
    assert.match(res.json().error, why);
  }
  const deep = `{"windows":[${"[".repeat(20000)}${"]".repeat(20000)}]}`;
  const res = await c.send({ method: "POST", path: "/api/pause-windows/preview", headers: c.writeHeaders({ cookie }), body: deep });
  assert.equal(res.status, 400);
  assert.equal(c.tickets.held.size, 0, "no ticket was issued for any of them");
});

// ---- the real session cookie, when the session module is present ----

test("with the real session module, the sign-in cookie is pdc_session, HttpOnly, SameSite=Strict, Path=/", async (t) => {
  let real;
  try {
    real = await import("../src/console/sessions.mjs");
  } catch {
    t.skip("sessions.mjs is not in this tree yet");
    return;
  }
  const set = real.sessionCookie("a".repeat(43), { maxAgeSec: 60 });
  assert.match(set, /^pdc_session=a{43}; /);
  for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(set.split("; ").includes(attr), attr);
});

// ---- the leak canary (REQ-CONSOLE-SECURITY f): runs last, over everything every test above captured ----

test("leak canary: no log line, audit row or response body carries a token, a session id, a one-time code or the pdc_ prefix", () => {
  assert.ok(seen.logs.length > 50 && seen.audit.length > 20 && seen.bodies.length > 50, "the canary saw real traffic");
  assert.ok(secrets.size > 10, "session ids and codes were collected");
  for (const [kind, list] of Object.entries(seen)) {
    for (const text of list) {
      for (const needle of [OP_TOKEN, VIEW_TOKEN, "pdc_", ...secrets]) assert.ok(!text.includes(needle), `${kind} carries ${needle.slice(0, 4)}: ${text.slice(0, 120)}`);
    }
  }
});
