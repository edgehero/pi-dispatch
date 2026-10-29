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
import { ERROR_KINDS, ERROR_SENTENCES, HOST_SHOWN_MAX, errorPage, forbiddenContent } from "../src/console/error-pages.mjs";
import { ICON_NAMES } from "../src/console/pulse-icons.mjs";
import { BODY_LIMIT, createConsoleServer, loginNoticeOf, lookupRoute, PERSON_CHANGED, PERSON_CHANGED_STREAM, REFUSAL_ROWS_PER_MINUTE, ROUTES, SERVER_LIMITS, SIGN_IN_FIRST, STATE_UNREADABLE, STREAMS_TOTAL_MAX, TOKENS_UNUSABLE, wantsHtml } from "../src/console/server.mjs";
import { ENDED_REASONS, NOTICE_OF_STATUS, PERSON_HEADER, PERSON_PARAM } from "../src/console/session-ends.mjs";
import { makeSessionStore, readSessionCookies } from "../src/console/sessions.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { writePauseWindows as realWritePauseWindows } from "../src/read-model.mjs";
import { STATUS_KINDS } from "../src/words.mjs";

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
/**
 * The session store as the server sees it, small: the real one's shape (issue #737's `endedOf`, `destroy(id, reason)`,
 * `verdict` and the flash among it), recording each `destroy` and each `peek`, so a test can see which were asked. The
 * real store's rules (the reason order, the tombstones, `restart`) are its own test's; the tests below that need them
 * run the server on the real store (`realSessions`).
 */
function fakeSessions() {
  const live = new Map();
  const ended = new Map();
  const flashes = new Map();
  const destroyed = [];
  const peeked = [];
  const judge = (s, file) => (file.tokens.some((t) => t.sha256 === s.tokenHash && t.role === s.role) ? null : file.tokens.some((t) => t.sha256 === s.tokenHash) ? "role" : "revoked");
  const end = (id, reason) => {
    live.delete(id);
    flashes.delete(id);
    ended.set(id, reason);
  };
  return {
    live,
    ended,
    flashes,
    destroyed,
    peeked,
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
      const reason = judge(s, file);
      if (reason) {
        end(id, reason);
        return null;
      }
      return { ...s };
    },
    peek(id, file) {
      peeked.push(id);
      const s = live.get(id);
      return s && judge(s, file) === null ? { ...s } : null;
    },
    verdict(id, file) {
      const s = live.get(id);
      if (!s) return { ended: ended.get(id) ?? null };
      const reason = judge(s, file);
      return reason ? { ended: reason } : { session: { ...s } };
    },
    endedOf: (id) => (live.has(id) ? null : ended.get(id) ?? null),
    destroy(id, reason = null) {
      destroyed.push([id, reason]);
      const s = live.get(id);
      if (!s) return null;
      end(id, reason);
      return { name: s.name, role: s.role };
    },
    setFlash(id, change) {
      if (!live.has(id)) return false;
      flashes.set(id, JSON.parse(JSON.stringify(change)));
      return true;
    },
    takeFlash(id) {
      const f = flashes.get(id) ?? null;
      flashes.delete(id);
      return f;
    },
    streamAcquire: (id) => live.has(id),
    streamRelease() {},
  };
}

/**
 * The REAL session store on the test's clock (issue #737), its ids added to the canary's secrets as they are minted, so
 * the tests of why a session ended run on the rules that ship. `live.size` stands in for the fake's map, for the
 * assertions that count sessions.
 */
function realSessions(now, opts = {}) {
  const store = makeSessionStore({ now, idleMs: 60 * 60000, maxMs: 12 * 3600000, ...opts });
  return {
    ...store,
    create(args) {
      const out = store.create(args);
      secrets.add(out.id);
      return out;
    },
    get live() {
      return { size: store.size() };
    },
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
  // Every well-formed id, as the real module reads them for a sign-out (issue #737).
  readSessionCookies,
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
  const sessions = overrides.sessionsOf ? overrides.sessionsOf(now) : fakeSessions();
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
    readTokens: overrides.readTokens ?? (() => ({ file: FILE })),
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
    ...(overrides.errorPage && { errorPage: overrides.errorPage }),
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

/** What a browser's navigation sends as Accept (Firefox's, the longest of the three engines'). */
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

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

test("every refusal and error status carries the headers too: 400, 401, 403, 404, 405, 413, 421, 429, 303, as JSON and as a page", async () => {
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
  // Issue #737: the same refusals asked for by a browser's navigation, where they are pages.
  const nav = { accept: HTML_ACCEPT };
  const pages = [
    [await c.send({ path: "/nowhere", headers: nav }), 404],
    [await c.send({ path: "/logout", headers: nav }), 405],
    [await c.send({ method: "HEAD", path: "/logout", headers: nav }), 405],
    [await c.send({ path: "/", headers: { ...nav, host: "evil.test" } }), 421],
    [await c.send({ path: "/", headers: nav }), 303],
  ];
  for (const [res, status] of pages) {
    assert.equal(res.status, status);
    assertSecurityHeaders(res, `${status} as a page`);
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
  assert.equal(fixed["GET /favicon.ico"], "none");
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

test("GET /favicon.ico answers 204 with no body and every security header, signed in or not (issue #737)", async () => {
  const c = await start();
  const { cookie } = await c.login();
  for (const headers of [{}, { cookie }]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await c.send({ method, path: "/favicon.ico", headers });
      assert.equal(res.status, 204, `${method} ${headers.cookie ? "signed in" : "anonymous"}`);
      assert.equal(res.text, "");
      assert.equal(res.headers.location, undefined, "no redirect to sign-in");
      assertSecurityHeaders(res, `${method} /favicon.ico`);
    }
  }
  assert.deepEqual(lookupRoute("POST", "/favicon.ico"), { allow: ["GET", "HEAD"] });
});

// ---- auth, role, read-only (REQ-CONSOLE-SECURITY d) ----

test("unauthenticated: a page redirects to /login, an API answers 401, a write answers 401 and is audited", async () => {
  const c = await start();
  const page = await c.send({ path: "/" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, "/login");
  assert.equal(page.headers["set-cookie"], undefined, "no cookie came, so none is cleared");
  const api = await c.send({ path: "/api/whoami" });
  assert.equal(api.status, 401);
  assert.deepEqual(api.json(), { error: SIGN_IN_FIRST, ended: null }, "issue #737: the body says why, here nothing");
  assert.equal(api.headers["set-cookie"], undefined, "issue #737: an API's 401 clears no cookie (a page's 303 does)");
  const write = await c.post("/api/pause-windows/preview", { windows: [] });
  assert.equal(write.status, 401);
  assert.deepEqual(write.json(), { error: SIGN_IN_FIRST, ended: null });
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
    const path = name === "run" ? `${spec.path}?id=job-1` : name === "watch-board" ? `${spec.path}?rule=shop` : name === "host" ? `${spec.path}?name=build3` : name === "venue" ? `${spec.path}?name=local` : spec.path;
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
    const path = name === "run" ? `${spec.path}?id=job-1` : name === "watch-board" ? `${spec.path}?rule=shop` : name === "host" ? `${spec.path}?name=build3` : name === "venue" ? `${spec.path}?name=local` : spec.path;
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
    assert.deepEqual(asked.splice(0), [{ view: "spend", project: null, role: want ? "operator" : "viewer", fullPaths: want }], token === VIEW_TOKEN ? "viewer" : "operator");
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
  assert.deepEqual(a.json().parked, [{ target: "o/r#1", kind: "github", jobId: "j2", ageMs: 10, chainCount: null }]);
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

test("sign-out ends the session as elsewhere, and its live streams at once through the hub with the same reason", async () => {
  const ended = [];
  const c = await start({ hub: { endSession: (id, reason) => ended.push([id, reason]), subscribe: () => () => {} } });
  const { cookie } = await c.login();
  const id = cookie.split("=")[1];
  assert.equal((await c.post("/logout", {}, { cookie })).status, 200);
  assert.deepEqual(ended, [[id, "elsewhere"]]);
  assert.deepEqual(c.sessions.destroyed, [[id, "elsewhere"]]);
  assert.equal(c.sessions.endedOf(id), "elsewhere");
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
  assert.equal(summary.reason, `50 more rows without a session (refusals and sign-outs) went unwritten one by one (limit ${REFUSAL_ROWS_PER_MINUTE} a minute)`);
  assert.match(next.reason, /^origin: /);
  // The count is of ROWS (issue #737): a sign-out with no session held is one of them, and the summary
  // says so rather than calling it a refusal. One unwritten is "1 more row".
  // Sign out with nothing held until one goes unwritten (the budget is spent), then a minute later once more.
  for (let written = true; written; ) {
    const rows = c.audit.rows.length;
    await c.post("/logout", {});
    written = c.audit.rows.length > rows;
  }
  c.advance(60_000);
  await c.post("/logout", {});
  const [quiet, signedOut] = c.audit.rows.slice(-2);
  assert.equal(quiet.reason, `1 more row without a session (refusals and sign-outs) went unwritten one by one (limit ${REFUSAL_ROWS_PER_MINUTE} a minute)`);
  assert.deepEqual([signedOut.action, signedOut.actor.name], ["logout", "anonymous"]);
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

// ---- the theme cookie (issue #737): read for every page, never set, never echoed ----

test("pd_theme: only an exact light or dark reaches a page, a hostile value is in no body, and no response sets the cookie", async () => {
  const themes = [];
  const pages = {
    ...realPages,
    loadPageData: async (name) => ({ name }),
    pagePanels: async () => [],
    renderPage: async (name, ctx) => (themes.push(ctx.theme), { status: 200, html: page({ title: name, name, body: html`<main></main>`, theme: ctx.theme }) }),
  };
  const c = await start({ pages });
  const { cookie: session } = await c.login();
  const MARK = "HOSTILE-THEME";
  const matrix = [
    [null, null],
    ["pd_theme=light", "light"],
    ["pd_theme=dark", "dark"],
    ["other=1; pd_theme=dark; more=2", "dark"],
    ["pd_theme= dark ", "dark"],
    ["pd_theme=DARK", null],
    ["PD_THEME=dark", null],
    ["pd_theme=Light", null],
    ["pd_theme=system", null],
    ["pd_theme=", null],
    ["pd_theme", null],
    ['pd_theme="dark"', null],
    ["pd_theme=dark; pd_theme=dark", null],
    ["pd_theme=dark; pd_theme=light", null],
    ["pd_themes=dark", null],
    [`pd_theme=${MARK}"><script>alert(1)</script>`, null],
    [`pd_theme=dark${MARK}`, null],
    ["pd_theme=__proto__", null],
  ];
  for (const [header, want] of matrix) {
    const label = JSON.stringify(header);
    for (const path of ["/login", "/login/code"]) {
      const res = await c.send({ path, headers: header === null ? {} : { cookie: header } });
      assert.equal(res.status, 200, `${path} ${label}`);
      assert.match(res.text, want === null ? /<html lang="en">\n/ : new RegExp(`<html lang="en" data-theme="${want}">\n`), `${path} ${label}`);
      assert.match(res.text, new RegExp(`<meta name="color-scheme" content="${want ?? "light dark"}">`), `${path} ${label}`);
      assert.ok(!res.text.includes(MARK) && !res.text.includes("<script>alert"), `${path} ${label}: the cookie's bytes are in no body`);
      assert.equal(res.headers["set-cookie"], undefined, `${path} ${label}: the server never sets a cookie on a page`);
    }
    const before = themes.length;
    const res = await c.send({ path: "/", headers: { cookie: header === null ? session : `${session}; ${header}` } });
    assert.equal(res.status, 200, `/ ${label}`);
    assert.deepEqual(themes.slice(before), [want], `/ ${label}: the page is drawn in ${want ?? "the system's theme"}`);
    assert.ok(!res.text.includes(MARK), `/ ${label}`);
    assert.equal(res.headers["set-cookie"], undefined, `/ ${label}`);
  }
  // A signed-out page request with a theme still redirects to sign-in, carrying nothing of the cookie.
  const out = await c.send({ path: "/", headers: { cookie: `pd_theme=${MARK}` } });
  assert.equal(out.status, 303);
  assert.ok(!JSON.stringify(out.headers).includes(MARK));
});

// ---- why a session ended, and the tokens file that cannot be read (issues #737 and #711) ----

test("TOKENS_UNUSABLE and SIGN_IN_FIRST are the sentences the server always answered", () => {
  assert.equal(TOKENS_UNUSABLE, "the console's tokens file cannot be used right now; the operator should run pi-dispatch doctor");
  assert.equal(SIGN_IN_FIRST, "sign in first");
});

test("an unreadable tokens file: a request with a cookie is 503 everywhere but sign-out, with no Set-Cookie and nothing ended; one with no cookie still goes to sign-in", async () => {
  let readable = true;
  const c = await start({ readTokens: () => (readable ? { file: FILE } : { refusal: "the tokens file is world-readable" }), sessionsOf: (now) => realSessions(now) });
  const { cookie } = await c.login();
  const id = cookie.split("=")[1];
  readable = false;
  const before = c.audit.rows.length;
  // Sign-out is not among them (issue #737): it judges nothing, so it needs no tokens file (its own test, below).
  const cases = [
    ["page", await c.send({ path: "/", headers: { cookie } })],
    ["page as a browser asks", await c.send({ path: "/runs", headers: { cookie, accept: HTML_ACCEPT } })],
    ["HEAD", await c.send({ method: "HEAD", path: "/", headers: { cookie, accept: HTML_ACCEPT } })],
    ["api", await c.send({ path: "/api/whoami", headers: { cookie, accept: HTML_ACCEPT } })],
    ["write", await c.post("/api/pause-windows/preview", { windows: [] }, { cookie })],
    ["confirm", await c.post(`/api/act/${ACTIONS[0].name}/confirm`, { ticket: "ticket-0" }, { cookie })],
  ];
  for (const [label, res] of cases) {
    assert.equal(res.status, 503, label);
    assert.equal(res.headers["set-cookie"], undefined, `${label}: the cookie is kept for when the file reads again`);
    assert.equal(res.headers.location, undefined, label);
    assertSecurityHeaders(res, label);
  }
  assert.deepEqual(cases[0][1].json(), { error: TOKENS_UNUSABLE }, "JSON to a request that did not ask for a page");
  assert.deepEqual(cases[3][1].json(), { error: TOKENS_UNUSABLE }, "an API answers JSON whatever its Accept");
  // A write's 503 carries the confirm bar's refusal for it, never a raw sentence for the slot to show as text: the fixed
  // sentence word for word, its command in the code face, in the setup state, whose one step is Close (nothing on the
  // page fixes the file, and a reload would meet the same 503).
  for (const [label, res] of cases.slice(4)) {
    const body = res.json();
    assert.deepEqual(Object.keys(body), ["error", "html"], label);
    assert.equal(body.error, TOKENS_UNUSABLE, label);
    assert.match(body.html, /<p class="banner__t">This console cannot take this action<\/p>/, label);
    assert.ok(body.html.includes("<p class=\"banner__s\">The console&#39;s tokens file cannot be used right now; the operator should run <span class=\"code\">pi-dispatch doctor</span>. Nothing was changed.</p>"), label);
    const said = /<p class="banner__s">(.*?)<\/p>/.exec(body.html)[1].replace(/<[^>]+>/g, "").replace(/&#39;/g, "'");
    assert.equal(said, `${TOKENS_UNUSABLE.charAt(0).toUpperCase()}${TOKENS_UNUSABLE.slice(1)}. Nothing was changed.`, `${label}: the words are TOKENS_UNUSABLE's, byte for byte`);
    assert.match(body.html, /<button[^>]*data-close[^>]*>Close<\/button>/, label);
    assert.doesNotMatch(body.html, /data-reload|data-again/, label);
  }
  assert.match(cases[1][1].headers["content-type"], /^text\/html/);
  assert.equal(cases[2][1].text, "", "HEAD: no body");
  // The writes' refusals are audited like any other (rate-limited, anonymous: no session was judged).
  assert.deepEqual(c.audit.rows.slice(before).map((r) => r.reason), ["auth: the tokens file cannot be used", "auth: the tokens file cannot be used"]);
  // No cookie: nothing to judge, so the request goes to sign-in as before, which answers for the file itself.
  const anon = await c.send({ path: "/" });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.location, "/login");
  assert.equal((await c.send({ path: "/api/whoami" })).status, 401);
  assert.equal((await c.post("/login", { token: OP_TOKEN })).status, 503);
  readable = true;
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie } })).status, 200, "the session was never ended");
  assert.equal(c.sessions.endedOf(id), null);
});

test("sign-out needs no tokens file (issue #737): it ends the session the store holds, its streams, audits its name, and always answers 200 clearing the cookie", async () => {
  let readable = true;
  const ended = [];
  const c = await start({ readTokens: () => (readable ? { file: FILE } : { refusal: "the tokens file is world-readable" }), sessionsOf: (now) => realSessions(now), hub: { endSession: (id, reason) => ended.push([id, reason]), subscribe: () => () => {} } });
  const clear = /^pdc_session=;.*Max-Age=0/;
  const { cookie } = await c.login();
  const id = cookie.split("=")[1];
  readable = false;
  const out = await c.post("/logout", {}, { cookie });
  assert.equal(out.status, 200, "an unreadable file does not keep a browser signed in that asked to sign out");
  assert.deepEqual(out.json(), { ok: true });
  assert.match(out.headers["set-cookie"]?.[0] ?? "", clear);
  assert.deepEqual(ended, [[id, "elsewhere"]], "its streams end at once");
  assert.equal(c.sessions.endedOf(id), "elsewhere");
  const row = c.audit.rows.at(-1);
  assert.deepEqual([row.action, row.outcome, row.actor], ["logout", "ok", { name: "alice", role: "operator", session: sha256(id).slice(0, 12) }], "named from the store, which kept who it was");
  readable = true;
  const after = await c.send({ path: "/api/whoami", headers: { cookie } });
  assert.deepEqual([after.status, after.json().ended], [401, "elsewhere"], "and it stays signed out once the file reads again");
  // Nothing held (no cookie, a cookie for no session, one already signed out): still 200, still cleared, so the page
  // that asked goes to sign-in truthfully; the row is the anonymous kind.
  for (const [label, headers] of [["no cookie", {}], ["unknown", { cookie: `pdc_session=${"u".repeat(43)}` }], ["already out", { cookie }]]) {
    const res = await c.post("/logout", {}, headers);
    assert.equal(res.status, 200, label);
    assert.match(res.headers["set-cookie"]?.[0] ?? "", clear, label);
    assert.deepEqual([c.audit.rows.at(-1).action, c.audit.rows.at(-1).actor.name, c.audit.rows.at(-1).reason], ["logout", "anonymous", "no session was held, so only the cookie was cleared"], label);
  }
  // The write guards still run first: no other site can sign this browser out.
  const second = await c.login();
  const cross = await c.post("/logout", {}, { cookie: second.cookie, "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  assert.equal(cross.headers["set-cookie"], undefined);
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie: second.cookie } })).status, 200);
});

test("sign-out ends EVERY session the browser presents (issue #737): a cookie planted Path=/logout beside the live one cannot make it a no-op", async () => {
  const ended = [];
  const c = await start({ sessionsOf: (now) => realSessions(now), hub: { endSession: (id, reason) => ended.push([id, reason]), subscribe: () => () => {} } });
  const ANON = { name: "anonymous", role: "none", session: null };
  const anonymousRow = { actor: ANON, action: "logout", target: "/logout", outcome: "ok", reason: "no session was held, so only the cookie was cleared" };
  const planted = `pdc_session=${"P".repeat(43)}`;
  // A browser lists the longer path first, so the planted cookie comes before the real one; either order ends the real one.
  for (const order of ["planted first", "live first"]) {
    const { cookie } = await c.login();
    const id = cookie.split("=")[1];
    ended.length = 0;
    const rows = c.audit.rows.length;
    const header = order === "planted first" ? `${planted}; ${cookie}` : `${cookie}; ${planted}`;
    const res = await c.post("/logout", {}, { cookie: header });
    assert.equal(res.status, 200, order);
    assert.match(res.headers["set-cookie"]?.[0] ?? "", /^pdc_session=;.*Max-Age=0/, order);
    const after = await c.send({ path: "/api/whoami", headers: { cookie } });
    assert.deepEqual([after.status, after.json().ended], [401, "elsewhere"], `${order}: the live session is signed out, as the 200 says`);
    assert.deepEqual(c.audit.rows.slice(rows).map((r) => [r.action, r.outcome, r.actor.name, r.actor.session]), [["logout", "ok", "alice", sha256(id).slice(0, 12)]], `${order}: one row, the held session's, and no anonymous one`);
    assert.deepEqual(new Set(ended.map(([i]) => i)), new Set(["P".repeat(43), id]), `${order}: every presented id's streams are ended`);
    assert.ok(ended.every(([, reason]) => reason === "elsewhere"));
  }
  // Two live sessions in one header (two tabs' sign-ins a jar kept apart): both end, each with its own row.
  const a = await c.login();
  const b = await c.login();
  const rows = c.audit.rows.length;
  assert.equal((await c.post("/logout", {}, { cookie: `${a.cookie}; ${b.cookie}; ${a.cookie}` })).status, 200);
  assert.equal(c.audit.rows.length - rows, 2, "one row per session ended, a repeated id once");
  for (const { cookie } of [a, b]) assert.equal((await c.send({ path: "/api/whoami", headers: { cookie } })).status, 401);
  // Nothing held (only a planted or malformed value): the anonymous row, whole (its outcome and target too).
  for (const header of [planted, `${planted}; pdc_session=short`, "pdc_session=short"]) {
    const res = await c.post("/logout", {}, { cookie: header });
    assert.equal(res.status, 200, header);
    assert.deepEqual(c.audit.rows.at(-1), anonymousRow, header);
  }
  // The doubled-cookie rule for every other route is unchanged: a request runs as no session when two are presented.
  const live = await c.login();
  const doubled = await c.send({ path: "/api/whoami", headers: { cookie: `${planted}; ${live.cookie}` } });
  assert.equal(doubled.status, 401);
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie: live.cookie } })).status, 200, "and the live session is untouched by it");
});

test("a page acts only as the person it was drawn for (issue #737): a stream that says another person is 401 switched, a preview or confirm 409, and saying none is not checked", async () => {
  const subscribed = [];
  const c = await start({ hub: { subscribe: (args) => (subscribed.push(args), () => {}), subscribeTranscript: (args) => (subscribed.push(args), () => {}), endSession() {} } });
  const { cookie } = await c.login();
  const viewer = await c.login(VIEW_TOKEN);
  assert.equal(PERSON_PARAM, "as");
  assert.equal(PERSON_HEADER, "x-console-as");
  // No page's own query takes the parameter, so the server must take it off before the page's query is parsed.
  for (const name of Object.keys(realPages.PAGES)) assert.ok(realPages.parsePageQuery(name, new URLSearchParams({ [PERSON_PARAM]: "alice.operator" })).refusal, name);
  const open = (path, headers) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: c.port, path, headers: { host: c.host, ...headers }, setHost: false }, (res) => {
        if (res.statusCode === 200) return res.once("data", () => (req.destroy(), resolve({ status: 200 })));
        const chunks = [];
        res.on("data", (x) => chunks.push(x));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
      req.end();
    });
  // The page's own person: the stream opens, and the hub is given the page's query without the parameter.
  assert.equal((await open("/api/events?page=runs&repo=a%2Fb&as=alice.operator", { cookie })).status, 200);
  assert.deepEqual([subscribed.at(-1).page, subscribed.at(-1).query.filter.repo], ["runs", "a/b"]);
  assert.equal((await open("/api/transcript?id=gh-1&format=json&as=alice.operator", { cookie })).status, 200, "the transcript's own parameter check never sees it");
  assert.equal(subscribed.at(-1).jobId, "gh-1");
  // Saying none: not checked (the terminal chat, curl).
  assert.equal((await open("/api/events?page=overview", { cookie })).status, 200);
  const before = subscribed.length;
  // Another person, a role that differs, a name that only looks the same, two values one of which differs, or an empty
  // one: 401 with ended "switched", before any slot or subscription is taken.
  for (const said of ["vic.viewer", "alice.viewer", "Alice.operator", "alice", "alice.operator&as=vic.viewer", ""]) {
    const res = await open(`/api/events?page=overview&as=${said}`, { cookie });
    assert.deepEqual([res.status, res.json], [401, { error: PERSON_CHANGED_STREAM, ended: "switched" }], said);
    const t = await open(`/api/transcript?id=gh-1&as=${said}`, { cookie });
    assert.deepEqual([t.status, t.json], [401, { error: PERSON_CHANGED_STREAM, ended: "switched" }], `transcript ${said}`);
  }
  assert.equal(subscribed.length, before, "no refused stream reached the hub");
  // The person is judged before the role: a viewer's cookie under an operator's page is told it is someone else.
  const t = await open("/api/transcript?id=gh-1&as=alice.operator", { cookie: viewer.cookie });
  assert.deepEqual([t.status, t.json.ended], [401, "switched"]);
  // A stream changes nothing, so its refusal says what it refused, never "nothing was changed".
  assert.match(PERSON_CHANGED_STREAM, /^this browser is now signed in as someone else, so this page's live updates were refused$/);
  assert.ok(!/nothing was changed/.test(PERSON_CHANGED_STREAM));
  // A preview or confirm: 409, saying why as the stream does (ended "switched"), the confirm bar's own refusal with
  // Look again, audited as the session's own, and nothing issued or written.
  const rows = c.audit.rows.length;
  const pre = await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie, [PERSON_HEADER]: "vic.viewer" });
  assert.equal(pre.status, 409);
  assert.deepEqual([pre.json().error, pre.json().ended], [PERSON_CHANGED, "switched"]);
  assert.match(PERSON_CHANGED, /^this browser is now signed in as someone else, so nothing was changed; sign in again$/);
  assert.match(pre.json().html, /The change did not go through/);
  assert.match(pre.json().html, /This browser is now signed in as someone else, so nothing was changed; sign in again\./);
  assert.match(pre.json().html, /<button[^>]*data-reload[^>]*>Look again<\/button>/);
  assert.equal(c.tickets.held.size, 0, "no ticket");
  assert.deepEqual(c.audit.rows.slice(rows).map((r) => [r.action, r.outcome, r.actor.name, r.target, r.reason]), [["refused", "refused", "alice", "/api/pause-windows/preview", "person: the page was drawn for another sign-in"]]);
  const ok = await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie, [PERSON_HEADER]: "alice.operator" });
  assert.equal(ok.status, 200, "its own person: previewed");
  const conf = await c.post("/api/pause-windows/confirm", { ticket: ok.json().ticket }, { cookie, [PERSON_HEADER]: "vic.viewer" });
  assert.deepEqual([conf.status, conf.json().error], [409, PERSON_CHANGED]);
  assert.equal(c.writes.length, 0, "nothing written");
  assert.equal(c.tickets.held.size, 1, "and the ticket was never redeemed, so the page that owns it can still use it");
  for (const action of ACTIONS.slice(0, 3)) {
    const res = await c.post(`/api/act/${action.name}/preview`, {}, { cookie: viewer.cookie, [PERSON_HEADER]: "alice.operator" });
    assert.deepEqual([res.status, res.json().error], [409, PERSON_CHANGED], `${action.name}: the person before the role`);
  }
  // Saying none on a write is not checked either: the terminal chat's previews go on as they did.
  assert.equal((await c.post("/api/pause-windows/preview", { windows: WINDOWS }, { cookie })).status, 200);
  // Only a stream's query says a person: on any other route `as` is no person, a write's or a read's.
  const whoami = await c.send({ path: "/api/whoami?as=vic.viewer", headers: { cookie } });
  assert.deepEqual([whoami.status, whoami.json().name], [200, "alice"], "a read with ?as= is not refused as someone else");
  assert.equal((await c.post("/api/pause-windows/preview?as=vic.viewer", { windows: WINDOWS }, { cookie })).status, 200, "nor a write");
  // A refused stream says ended "switched", which is one of the reasons the sign-in page knows, and which no tombstone holds.
  assert.ok(ENDED_REASONS.includes("switched"));
});

test("a cookie whose session ended: a page goes to /login?ended=<reason> with the cookie cleared, and an API or write 401 says the reason (real store)", async () => {
  let file = FILE;
  const c = await start({ readTokens: () => ({ file }), sessionsOf: (now) => realSessions(now) });
  const clear = /^pdc_session=;.*Max-Age=0/;
  const expectEnded = async (cookie, reason, label) => {
    const page = await c.send({ path: "/runs", headers: { cookie } });
    assert.equal(page.status, 303, label);
    assert.equal(page.headers.location, reason === null ? "/login" : `/login?ended=${reason}`, label);
    assert.match(page.headers["set-cookie"]?.[0] ?? "", clear, `${label}: the dead cookie is cleared`);
    const api = await c.send({ path: "/api/whoami", headers: { cookie } });
    assert.equal(api.status, 401, label);
    assert.deepEqual(api.json(), { error: SIGN_IN_FIRST, ended: reason }, label);
    const write = await c.post("/api/pause-windows/preview", { windows: [] }, { cookie });
    assert.equal(write.status, 401, label);
    assert.deepEqual(write.json(), { error: SIGN_IN_FIRST, ended: reason }, label);
    assert.deepEqual([api.headers["set-cookie"], write.headers["set-cookie"]], [undefined, undefined], `${label}: an API's or a write's 401 clears no cookie (issue #737)`);
  };
  // revoked: the token's hash left the file. The FIRST request that sees it ends the session and says why.
  let { cookie } = await c.login();
  file = { ...FILE, tokens: FILE.tokens.filter((t) => t.name !== "alice") };
  await expectEnded(cookie, "revoked", "revoked");
  file = FILE;
  await expectEnded(cookie, "revoked", "editing the file back revives nothing, and the reason stays");
  // role: the same hash with another role.
  ({ cookie } = await c.login());
  file = { ...FILE, tokens: FILE.tokens.map((t) => (t.name === "alice" ? { ...t, role: "viewer" } : t)) };
  await expectEnded(cookie, "role", "role");
  file = FILE;
  // all: sessions end-all bumped the generation.
  ({ cookie } = await c.login());
  file = { ...FILE, generation: 1 };
  await expectEnded(cookie, "all", "all");
  file = FILE;
  // idle: an hour and a millisecond without a request.
  ({ cookie } = await c.login());
  c.advance(60 * 60000 + 1);
  await expectEnded(cookie, "idle", "idle");
  // elsewhere: this browser signed out (or signed in again over the cookie, below).
  ({ cookie } = await c.login());
  assert.equal((await c.post("/logout", {}, { cookie })).status, 200);
  await expectEnded(cookie, "elsewhere", "signed out");
  ({ cookie } = await c.login());
  const again = await c.login(OP_TOKEN, { cookie });
  await expectEnded(cookie, "elsewhere", "signed in again over it");
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie: again.cookie } })).status, 200);
  // restart: a well-formed id this process never issued, while it is young and has forgotten nothing.
  await expectEnded(`pdc_session=${"r".repeat(43)}`, "restart", "unknown id");
});

/** A browser's jar for the one session cookie: what it sends, and what each response's Set-Cookie leaves in it. */
function cookieJar(start = null) {
  let value = start;
  return {
    get header() {
      return value === null ? {} : { cookie: value };
    },
    get value() {
      return value;
    },
    take(res) {
      for (const line of res.headers["set-cookie"] ?? []) {
        const m = /^pdc_session=([^;]*)/.exec(line);
        if (m) value = m[1] === "" || /;\s*Max-Age=0/i.test(line) ? null : `pdc_session=${m[1]}`;
      }
      return res;
    },
  };
}

test("issue #737: a stream's 401 leaves the cookie, so the probe after it reads why; an old cookie's 401 never clears a newer sign-in's (a browser's jar, real store)", async () => {
  let file = FILE;
  const c = await start({ readTokens: () => ({ file }), sessionsOf: (now) => realSessions(now) });
  const jar = cookieJar();
  jar.take((await c.login()).res);
  // The token is revoked while the page's stream is down; the browser's reconnect meets the 401 first.
  file = { ...FILE, tokens: FILE.tokens.filter((t) => t.name !== "alice") };
  const stream = jar.take(await c.send({ path: "/api/events?page=overview", headers: jar.header }));
  assert.deepEqual([stream.status, stream.json().ended], [401, "revoked"]);
  const probe = jar.take(await c.send({ path: "/api/whoami", headers: jar.header }));
  assert.deepEqual([probe.status, probe.json().ended], [401, "revoked"], "the probe still carries the cookie, so the sign-in page can say why");
  // One browser, two tabs: one signs in again over the live cookie while the other's probe is out with the old one.
  file = FILE;
  const two = cookieJar();
  two.take((await c.login()).res);
  const old = two.value;
  two.take((await c.login(OP_TOKEN, { cookie: old })).res);
  assert.ok(two.value !== null && two.value !== old, "the jar holds the new sign-in");
  const late = two.take(await c.send({ path: "/api/whoami", headers: { cookie: old } }));
  assert.deepEqual([late.status, late.json().ended], [401, "elsewhere"]);
  assert.equal((await c.send({ path: "/api/whoami", headers: two.header })).status, 200, "the new sign-in survives the old cookie's 401");
});

test("max and restart through the server: a session past its longest life, and restart no longer said once the console has been up for maxMs (real store)", async () => {
  const c = await start({ sessionsOf: (now) => realSessions(now) });
  const { cookie } = await c.login();
  for (let i = 0; i < 24; i += 1) {
    c.advance(30 * 60000);
    assert.equal((await c.send({ path: "/api/whoami", headers: { cookie } })).status, 200, `${(i + 1) * 30} minutes`);
  }
  c.advance(1);
  const res = await c.send({ path: "/", headers: { cookie } });
  assert.equal(res.headers.location, "/login?ended=max");
  const unknown = await c.send({ path: "/", headers: { cookie: `pdc_session=${"u".repeat(43)}` } });
  assert.equal(unknown.headers.location, "/login", "up for maxMs: an unknown id may be anything, so no reason is claimed");
  assert.match(unknown.headers["set-cookie"]?.[0] ?? "", /Max-Age=0/, "but the cookie it presented is still cleared");
});

test("a cookie that is not well formed is no cookie: /login exactly, nothing cleared; a fake store's reason outside ENDED_REASONS is no reason", async () => {
  const c = await start();
  for (const cookie of ["pdc_session=short", `pdc_session=${"x".repeat(44)}`, "other=1"]) {
    const res = await c.send({ path: "/", headers: { cookie } });
    assert.equal(res.headers.location, "/login", cookie);
    assert.equal(res.headers["set-cookie"], undefined, cookie);
  }
  // A store that answered something off the list (a bug, or a word from a newer release) reaches no URL and no body.
  c.sessions.endedOf = () => "../evil?x=<script>";
  const page = await c.send({ path: "/", headers: { cookie: `pdc_session=${"z".repeat(43)}` } });
  assert.equal(page.headers.location, "/login");
  const api = await c.send({ path: "/api/whoami", headers: { cookie: `pdc_session=${"z".repeat(43)}` } });
  assert.deepEqual(api.json(), { error: SIGN_IN_FIRST, ended: null });
  for (const r of ENDED_REASONS) {
    c.sessions.endedOf = () => r;
    assert.equal((await c.send({ path: "/", headers: { cookie: `pdc_session=${"z".repeat(43)}` } })).headers.location, `/login?ended=${r}`, r);
  }
});

test("a sign-in over a live cookie ends that session as elsewhere and its streams with it, once the answer has gone out; an audit failure ends the new one with no reason", async () => {
  const ended = [];
  // The sign-in's own response, seen beside the console's handler, so the hub's end can say whether it was out yet.
  let answer = null;
  const c = await start({ hub: { endSession: (id, reason) => ended.push([id, reason, answer?.writableFinished === true]), subscribe: () => () => {} } });
  c.server.on("request", (req, res) => {
    if (req.url === "/login") answer = res;
  });
  const first = await c.login();
  const id = first.cookie.split("=")[1];
  const second = await c.login(OP_TOKEN, { cookie: first.cookie });
  assert.equal(second.res.status, 200);
  assert.deepEqual(c.sessions.destroyed, [[id, "elsewhere"]]);
  assert.deepEqual(ended, [[id, "elsewhere", true]], "issue #737: the other tabs' streams end after the new cookie was sent, never before it");
  assert.equal(c.sessions.endedOf(id), "elsewhere");
  // A planted cookie for no session: destroy is asked (it ends nothing), the hub too (it holds no stream for it).
  const planted = `pdc_session=${"p".repeat(43)}`;
  await c.login(OP_TOKEN, { cookie: planted });
  assert.deepEqual(c.sessions.destroyed.at(-1), ["p".repeat(43), "elsewhere"]);
  assert.equal(c.sessions.endedOf("p".repeat(43)), null, "the store wrote no tombstone for an id it never held");
  c.audit.failNext = 1;
  const refused = await c.post("/login", { token: OP_TOKEN });
  assert.equal(refused.status, 500);
  const [newId, reason] = c.sessions.destroyed.at(-1);
  assert.equal(reason, null, "the session that never reached a browser ends with no reason");
  assert.ok(!c.sessions.live.has(newId));
});

test("a sign-in over a live cookie that is refused for its audit row leaves the session the browser held as it was: not ended, its streams open, still signed in", async () => {
  const ended = [];
  const c = await start({ codes: [["r".repeat(43), "alice"]], sessionsOf: (now) => realSessions(now), hub: { endSession: (id, reason) => ended.push([id, reason]), subscribe: () => () => {} } });
  const held = await c.login();
  const id = held.cookie.split("=")[1];
  const live = c.sessions.live.size;
  for (const path of ["/login", "/login/code"]) {
    c.audit.failNext = 1;
    const refused = path === "/login" ? await c.login(OP_TOKEN, { cookie: held.cookie }) : { res: await c.post(path, { code: "r".repeat(43) }, { cookie: held.cookie }) };
    assert.equal(refused.res.status, 500, path);
    assert.equal(refused.res.headers["set-cookie"], undefined, `${path}: no new cookie`);
    assert.equal(c.sessions.endedOf(id), null, `${path}: the held session was not ended`);
    assert.equal(c.sessions.live.size, live, `${path}: the refused one is gone, the held one stays`);
    assert.deepEqual(ended, [], `${path}: none of its streams were ended`);
    const who = await c.send({ path: "/api/whoami", headers: { cookie: held.cookie } });
    assert.deepEqual([who.status, who.json().name], [200, "alice"], `${path}: the browser is still signed in`);
  }
  // The audit row of a refused sign-in is the new session's; the held one's row stays its sign-in alone.
  const ok = await c.login(OP_TOKEN, { cookie: held.cookie });
  assert.equal(ok.res.status, 200);
  assert.equal(c.sessions.endedOf(id), "elsewhere", "a sign-in that succeeds ends it");
  assert.deepEqual(ended, [[id, "elsewhere"]]);
});

test("a sign-in link refused 429 by the rate limit is never read: the limiter answers before the code store, so the link still works", async () => {
  // The link page relies on it: after a 429 it shows the rate notice and keeps the link "not tried yet", never "used".
  const code = "w".repeat(43);
  let allowed = false;
  const c = await start({ codes: [[code, "alice"]], limiter: { take: () => allowed, retryAfterSec: () => 3 } });
  const limited = await c.post("/login/code", { code });
  assert.equal(limited.status, 429);
  assert.deepEqual(c.codesTried, [], "the code store was never asked");
  allowed = true;
  assert.equal((await c.post("/login/code", { code })).status, 200, "the same link signs in once the limit allows");
});

test("the login routes answer every status NOTICE_OF_STATUS maps, so each notice the script can show is one the server can cause", async () => {
  assert.deepEqual(Object.keys(NOTICE_OF_STATUS).sort(), ["/login", "/login/code"]);
  for (const path of Object.keys(NOTICE_OF_STATUS)) {
    const route = lookupRoute("POST", path)?.route;
    assert.ok(route?.readOnlyExempt && route.auth === "none", `${path} is a sign-in route`);
  }
  const seenStatus = { "/login": new Set(), "/login/code": new Set() };
  const code = "n".repeat(43);
  let readable = true;
  const c = await start({ codes: [[code, "alice"], ["m".repeat(43), "alice"], ["q".repeat(43), "alice"]], readTokens: () => (readable ? { file: FILE } : { refusal: "unreadable" }) });
  seenStatus["/login"].add((await c.post("/login", { token: "wrong" })).status);
  seenStatus["/login/code"].add((await c.post("/login/code", { code: "k".repeat(43) })).status);
  c.audit.failNext = 1;
  seenStatus["/login"].add((await c.post("/login", { token: OP_TOKEN })).status);
  c.audit.failNext = 1;
  seenStatus["/login/code"].add((await c.post("/login/code", { code })).status);
  readable = false;
  seenStatus["/login"].add((await c.post("/login", { token: OP_TOKEN })).status);
  seenStatus["/login/code"].add((await c.post("/login/code", { code: "m".repeat(43) })).status);
  readable = true;
  const limited = await start({ limiter: { take: () => false, retryAfterSec: () => 3 } });
  seenStatus["/login"].add((await limited.post("/login", { token: OP_TOKEN })).status);
  seenStatus["/login/code"].add((await limited.post("/login/code", { code: "q".repeat(43) })).status);
  for (const [path, statuses] of Object.entries(seenStatus)) {
    assert.deepEqual([...statuses].sort(), Object.keys(NOTICE_OF_STATUS[path]).map(Number).sort(), path);
  }
});

test("each sign-in refusal's cause, on both routes, is the status whose notice says that cause (literal, not the table read back: issue #737)", async () => {
  // [cause, status, notice]: a swap in the table (a 503 drawn as the audit notice) fails here, where a test that read
  // the expectation from NOTICE_OF_STATUS itself would pass.
  const CAUSES = [["the audit log", 500, "audit"], ["the tokens file", 503, "tokens"], ["the rate limit", 429, "rate"]];
  let readable = true;
  const codes = ["G", "H", "J", "K", "L", "M"].map((ch) => [ch.repeat(43), "alice"]);
  const c = await start({ codes, readTokens: () => (readable ? { file: FILE } : { refusal: "unreadable" }) });
  const limited = await start({ limiter: { take: () => false, retryAfterSec: () => 3 }, codes });
  let k = 0;
  const attempt = async (path, cause) => {
    const body = path === "/login" ? { token: OP_TOKEN } : { code: codes[k++][0] };
    if (cause === "the audit log") c.audit.failNext = 1;
    if (cause === "the tokens file") readable = false;
    const res = await (cause === "the rate limit" ? limited : c).post(path, body);
    readable = true;
    c.audit.failNext = 0;
    return res;
  };
  for (const path of ["/login", "/login/code"]) {
    for (const [cause, status, notice] of CAUSES) {
      const res = await attempt(path, cause);
      assert.equal(res.status, status, `${path}, ${cause}`);
      assert.equal(NOTICE_OF_STATUS[path][String(res.status)], notice, `${path}, ${cause}: the notice the script shows names it`);
      assert.equal(res.headers["set-cookie"], undefined, `${path}, ${cause}: no session was handed out`);
    }
  }
  assert.equal(NOTICE_OF_STATUS["/login"]["401"], "wrong");
});

test("GET /login selects a notice only for exactly one ended that is a member of ENDED_REASONS, and never echoes the query", async () => {
  const c = await start({ config: { idleMs: 30 * 60000, maxMs: 8 * 3600000, listen: { kind: "tcp", host: "127.0.0.1", port: 4790 } } });
  const MARK = "HOSTILE-ENDED";
  // The notices drawn unhidden: each `data-notice` element whose own tag carries no `hidden`, wherever it sits.
  const shown = (text) => Array.from(text.matchAll(/<[^>]*\sdata-notice="([a-z-]+)"[^>]*>/g)).filter((m) => !/\shidden[\s>=]/.test(m[0])).map((m) => m[1]);
  for (const r of ENDED_REASONS) {
    const res = await c.send({ path: `/login?ended=${r}` });
    assert.equal(res.status, 200, r);
    assert.deepEqual(shown(res.text), [`ended-${r}`], `${r}: exactly its own notice is drawn unhidden`);
  }
  assert.match((await c.send({ path: "/login?ended=idle" })).text, /30 minutes without a request/, "the console's own idle limit");
  assert.match((await c.send({ path: "/login?ended=max" })).text, /after 8 hours/, "and its own longest life");
  const none = [`/login?ended=${MARK}`, "/login?ended=IDLE", "/login?ended=idle%20", "/login?ended=%20idle", "/login?ended=idle&ended=max", "/login?ended=idle&ended=idle", "/login?ended=shutdown", "/login?ended=", "/login?ended", `/login?${MARK}=idle`, `/login?x=${MARK}&ended=__proto__`, "/login?ended=constructor", "/login"];
  for (const path of none) {
    const res = await c.send({ path });
    assert.equal(res.status, 200, path);
    assert.deepEqual(shown(res.text).filter((n) => n.startsWith("ended-")), [], `${path}: no reason`);
    assert.ok(!res.text.includes(MARK), `${path}: no byte of the query`);
  }
});

test("the sign-in footer follows how the console listens: loopback, a unix socket, or a public bind that says nothing about loopback", async () => {
  const footer = async (listen) => (await (await start({ config: { listen } })).send({ path: "/login" })).text;
  const loopback = await footer({ kind: "tcp", host: "127.0.0.1", port: 4790 });
  const v6 = await footer({ kind: "tcp", host: "::1", port: 4790 });
  const unix = await footer({ kind: "unix", path: "/run/pi/console.sock" });
  const pub = await footer({ kind: "tcp", host: "0.0.0.0", port: 4790 });
  assert.match(loopback, /loopback address only/);
  assert.match(v6, /loopback address only/);
  assert.match(unix, /unix socket only/);
  assert.ok(!unix.includes("/run/pi/console.sock"), "the socket's path is not printed");
  assert.ok(!/loopback|unix socket only/.test(pub), "a public bind is never called loopback");
});

// ---- the error pages (issue #737, the ErrorPage card) ----

test("wantsHtml: GET or HEAD, outside /api/ and /static/, with text/html in Accept in any case", () => {
  const req = (method, accept) => ({ method, headers: accept === undefined ? {} : { accept } });
  assert.equal(wantsHtml(req("GET", HTML_ACCEPT), "/nowhere"), true);
  assert.equal(wantsHtml(req("HEAD", "text/html"), "/"), true);
  assert.equal(wantsHtml(req("GET", "TEXT/HTML"), "/runs"), true);
  assert.equal(wantsHtml(req("GET", "application/json, Text/Html;q=0.1"), "/runs"), true);
  assert.equal(wantsHtml(req("GET", HTML_ACCEPT), "/api"), true, "only /api/ is the API");
  assert.equal(wantsHtml(req("GET", HTML_ACCEPT), "/apix"), true);
  for (const path of ["/api/whoami", "/api/", "/api/act/fleet-pause/preview", "/static/console.js", "/static/"]) assert.equal(wantsHtml(req("GET", HTML_ACCEPT), path), false, path);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) assert.equal(wantsHtml(req(method, HTML_ACCEPT), "/"), false, method);
  for (const accept of [undefined, "", "*/*", "application/json", "text/plain", "text/htm", ["text/html"]]) assert.equal(wantsHtml(req("GET", accept), "/"), false, JSON.stringify(accept));
  assert.equal(wantsHtml({ headers: { accept: "text/html" }, url: "/runs" }), true, "no method is GET; the path comes from the URL");
  assert.equal(wantsHtml({ method: "GET", headers: { accept: "text/html" }, url: "/api/state" }), false);
  assert.equal(wantsHtml({ method: "GET", headers: { accept: "text/html" }, url: "//evil.test/" }), false, "no path, no page");
});

/** The panels a page draws, by id. */
const panelsOf = (text) => Array.from(text.matchAll(/<section id="([a-z0-9-]+)" data-panel>/g), (m) => m[1]);

/** One panel's markup (its section, open tag to close), so a link is looked for in the card and not in the bar. */
function panelText(text, id) {
  const open = `<section id="${id}" data-panel>`;
  const at = text.indexOf(open);
  assert.ok(at >= 0, `the page draws ${id}`);
  return text.slice(at, text.indexOf("</section>", at) + "</section>".length);
}

test("a 404 is a page for a browser and JSON for everyone else; the page names no path and keeps the nav, read with peek (no session moved)", async () => {
  const c = await start({ sessionsOf: (now) => realSessions(now) });
  const { cookie } = await c.login();
  const MARK = "path-canary-4f1";
  const page = await c.send({ path: `/${MARK}/<script>?x=${MARK}`, headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(page.status, 404);
  assert.match(page.headers["content-type"], /^text\/html/);
  assertSecurityHeaders(page, "404 page");
  assert.deepEqual(panelsOf(page.text), ["p-error"]);
  assert.match(page.text, /data-page="error"/);
  assert.ok(!page.text.includes(MARK) && !page.text.includes("<script>"), "the path is not echoed");
  const card = panelText(page.text, "p-error");
  assert.match(card, /<a class="btn btn--primary" href="\/runs">.*Go to Runs<\/a>/, "Runs first, the primary");
  assert.match(card, /<a class="btn" href="\/">.*Go to Overview<\/a>/);
  assert.match(page.text, /alice/, "signed in: the bar names the person");
  assert.ok(!page.text.includes(cookie.split("=")[1]), "never the session id");
  const anon = await c.send({ path: "/nowhere", headers: { accept: HTML_ACCEPT } });
  assert.equal(anon.status, 404);
  assert.ok(!anon.text.includes("alice"));
  assert.ok(!anon.text.includes('id="logout"'), "no session: the sign-in bar");
  for (const [label, req] of [
    ["no Accept", { path: "/nowhere" }],
    ["an API path", { path: "/api/nowhere", headers: { accept: HTML_ACCEPT } }],
    ["a static path", { path: "/static/nowhere.js", headers: { accept: HTML_ACCEPT } }],
    ["a write", { method: "POST", path: "/nowhere", headers: { ...c.writeHeaders(), accept: HTML_ACCEPT }, body: "{}" }],
  ]) {
    const res = await c.send(req);
    assert.equal(res.status, 404, label);
    assert.match(res.headers["content-type"], /^application\/json/, label);
    assert.deepEqual(res.json(), { error: "there is no such page on this console" }, label);
    assertSecurityHeaders(res, label);
  }
  // The nav was read with peek: 59 minutes after sign-in a 404 does not count as a request, so at 61 the session is
  // still idle-ended.
  c.advance(59 * 60000);
  assert.equal((await c.send({ path: "/nowhere", headers: { cookie, accept: HTML_ACCEPT } })).status, 404);
  c.advance(2 * 60000);
  assert.equal((await c.send({ path: "/", headers: { cookie } })).headers.location, "/login?ended=idle", "a 404 extended nothing");
});

test("a 405 to a browser is a page that keeps Allow; to anyone else the JSON it was", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const page = await c.send({ path: "/logout", headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(page.status, 405);
  assert.equal(page.headers.allow, "POST");
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.deepEqual(panelsOf(page.text), ["p-error"]);
  assert.ok(c.sessions.peeked.length > 0, "the bar's person came from peek");
  const json = await c.send({ method: "DELETE", path: "/login", headers: { accept: HTML_ACCEPT } });
  assert.equal(json.status, 405);
  assert.equal(json.headers.allow, "GET, HEAD, POST");
  assert.deepEqual(json.json(), { error: "DELETE is not accepted here; use GET or HEAD or POST" });
  const head = await c.send({ method: "HEAD", path: "/api/events", headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(head.status, 405, "an API path never answers a page");
  assert.equal(head.headers.allow, "GET");
});

test("a 421 to a browser names the refused Host escaped and cut, gives the tunnel for this port, and carries no nav and no session data", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const peekedBefore = c.sessions.peeked.length;
  const res = await c.send({ path: "/", headers: { host: "myhost.lan:8080", cookie, accept: HTML_ACCEPT } });
  assert.equal(res.status, 421);
  assertSecurityHeaders(res, "421 page");
  assert.deepEqual(panelsOf(res.text), ["p-error-421"]);
  assert.match(res.text, /<span class="code">myhost\.lan<\/span>/);
  assert.ok(panelText(res.text, "p-error-421").includes(`<span>ssh</span> <span>-L</span> <span>${c.port}:127.0.0.1:${c.port}</span> <span>&#39;&lt;this host&gt;&#39;</span>`), "the tunnel uses this connection's own port");
  assert.match(res.text, /answers only to the names it was started with \(127\.0\.0\.1, localhost and \[::1\] unless more were added\)/);
  for (const absent of ["alice", "Operator", 'id="logout"', "pillnav", 'href="/runs"', 'href="/audit"', "aria-current"]) assert.ok(!res.text.includes(absent), `no ${absent}`);
  assert.equal(c.sessions.peeked.length, peekedBefore, "no session was even read");
  const long = `${"a".repeat(70)}.test`;
  const cut = await c.send({ path: "/", headers: { host: long, accept: HTML_ACCEPT } });
  assert.match(cut.text, new RegExp(`<span class="code">${"a".repeat(64)}…</span>`));
  assert.ok(!cut.text.includes("a".repeat(65)));
  const odd = await c.send({ path: "/", headers: { host: "ev<il>.test", accept: HTML_ACCEPT } });
  assert.equal(odd.status, 421);
  assert.match(odd.text, /a Host that is not a plain name/);
  assert.ok(!odd.text.includes("ev<il") && !odd.text.includes("ev&lt;il"));
  const json = await c.send({ path: "/api/whoami", headers: { host: "myhost.lan", accept: HTML_ACCEPT } });
  assert.equal(json.status, 421);
  assert.match(json.json().error, /^the Host myhost\.lan is not/);
});

test("the 421 page's own files answer on any Host (issue #737): the script, the stylesheet and the favicon; every other path, the API and sign-in included, is still 421", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const refused = { host: "myhost.lan:8080", cookie, accept: HTML_ACCEPT };
  // What the 421 page loads, so a refused name is drawn styled and its Copy button works: public bytes, no session.
  for (const [method, path, status, type] of [["GET", "/static/console.css", 200, /^text\/css/], ["GET", "/static/console.js", 200, /^text\/javascript/], ["HEAD", "/static/console.css", 200, /^text\/css/], ["GET", "/favicon.ico", 204, null]]) {
    const res = await c.send({ method, path, headers: refused });
    assert.equal(res.status, status, `${method} ${path}`);
    if (type) assert.match(res.headers["content-type"], type, path);
    assertSecurityHeaders(res, `${method} ${path} on a refused Host`);
  }
  assert.equal((await c.send({ path: "/static/console.css", headers: refused })).text, CONSOLE_CSS);
  // Everything else keeps the check, a path that exists or not, a write to a public path, and the sign-in itself.
  const before = c.audit.rows.length;
  for (const [method, path] of [["GET", "/"], ["GET", "/login"], ["GET", "/login/code"], ["GET", "/api/whoami"], ["GET", "/api/state"], ["GET", "/api/events?page=overview"], ["GET", "/healthz"], ["GET", "/static/other.js"], ["GET", "/nowhere"], ["POST", "/static/console.js"], ["POST", "/login"], ["POST", "/logout"]]) {
    const write = method === "POST";
    const res = await c.send({ method, path, headers: write ? { ...c.writeHeaders(), ...refused, origin: "http://myhost.lan:8080" } : refused, body: write ? JSON.stringify({ token: OP_TOKEN }) : null });
    assert.equal(res.status, 421, `${method} ${path}`);
    assert.equal(res.headers["set-cookie"], undefined, `${method} ${path}`);
  }
  assert.equal(c.audit.rows.length, before + 3, "each refused write is audited, as before");
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie } })).status, 200, "and the session is as it was");
});

test("a viewer's /audit is the operators-only page with the viewer's nav; a 400 query is a page that says the refusal and links back without the query", async () => {
  const c = await start();
  const viewer = await c.login(VIEW_TOKEN);
  const forbidden = await c.send({ path: "/audit", headers: { cookie: viewer.cookie, accept: HTML_ACCEPT } });
  assert.equal(forbidden.status, 403);
  assertSecurityHeaders(forbidden, "403 page");
  assert.deepEqual(panelsOf(forbidden.text), ["p-error"]);
  assert.match(panelText(forbidden.text, "p-error"), /The audit log is for operators/);
  assert.match(forbidden.text, /vic/);
  const forbiddenJson = await c.send({ path: "/audit", headers: { cookie: viewer.cookie } });
  assert.match(forbiddenJson.json().error, /operator role/);
  const op = await c.login();
  const MARK = "query-canary-77";
  const before = c.loads.length;
  const bad = await c.send({ path: `/insights?range=${MARK}`, headers: { cookie: op.cookie, accept: HTML_ACCEPT } });
  assert.equal(bad.status, 400);
  assertSecurityHeaders(bad, "400 page");
  assert.match(panelText(bad.text, "p-error"), /<span class="code">range<\/span> must be one of 7d, 30d, mtd/);
  assert.ok(!bad.text.includes(MARK), "the value is not echoed");
  assert.match(panelText(bad.text, "p-error"), /href="\/insights"/, "back to the page, without its query");
  assert.match(panelText(bad.text, "p-error"), /href="\/"/);
  assert.equal(c.loads.length, before, "nothing was read");
  const run = await c.send({ path: "/run", headers: { cookie: op.cookie, accept: HTML_ACCEPT } });
  assert.equal(run.status, 400);
  assert.match(panelText(run.text, "p-error"), /href="\/runs"/, "the run detail sends back to Runs, since /run alone is a 400 too");
  assert.ok(!panelText(run.text, "p-error").includes('href="/run"'));
  const stream = await c.send({ path: `/api/events?page=insights&range=${MARK}`, headers: { cookie: op.cookie, accept: HTML_ACCEPT } });
  assert.equal(stream.status, 400);
  assert.match(stream.headers["content-type"], /^application\/json/);
});

test("a 500 is a page for a browser and the fixed JSON otherwise, with the headers on both; the error's text leaves neither", async () => {
  const pages = { ...fakePages(), loadPageData: async () => Promise.reject(Object.assign(new Error("ENOENT /secret/host/path"), { code: "ENOENT" })) };
  const c = await start({ pages });
  const { cookie } = await c.login();
  const page = await c.send({ path: "/", headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(page.status, 500);
  assertSecurityHeaders(page, "500 page");
  assert.deepEqual(panelsOf(page.text), ["p-error"]);
  assert.ok(!page.text.includes("alice") && !page.text.includes('id="logout"'), "a 500 draws no nav");
  assert.ok(!page.text.includes("/secret/host/path"));
  const json = await c.send({ path: "/", headers: { cookie } });
  assert.equal(json.status, 500);
  assertSecurityHeaders(json, "500 JSON");
  assert.deepEqual(json.json(), { error: "the console failed on this request; see its log" });
  const head = await c.send({ method: "HEAD", path: "/", headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(head.status, 500);
  assert.equal(head.text, "");
});

test("the 503 page draws no nav and keeps the cookie", async () => {
  let readable = true;
  const c = await start({ readTokens: () => (readable ? { file: FILE } : { refusal: "unreadable" }) });
  const { cookie } = await c.login();
  readable = false;
  const res = await c.send({ path: "/", headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(res.status, 503);
  assert.deepEqual(panelsOf(res.text), ["p-error"]);
  assert.match(res.text, /pi-dispatch doctor/);
  assert.ok(!res.text.includes("alice") && !res.text.includes('id="logout"'));
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(c.sessions.destroyed.length, 0);
});

test("what the server hands the error page: the kind, the status, the sentence, and a person as name and role only, for the kinds with a bar", async () => {
  const asked = [];
  const recording = (args) => (asked.push(args), errorPage(args));
  let readable = true;
  const pages = { ...fakePages(), loadPageData: async (name) => (name === "fleet" ? Promise.reject(new Error("boom")) : { name }) };
  const c = await start({ errorPage: recording, pages, readTokens: () => (readable ? { file: FILE } : { refusal: "unreadable" }) });
  const op = await c.login();
  const viewer = await c.login(VIEW_TOKEN);
  const nav = { accept: HTML_ACCEPT };
  const ask = async (req) => {
    const before = asked.length;
    await c.send(req);
    assert.equal(asked.length, before + 1, JSON.stringify(req.path));
    return asked.at(-1);
  };
  const who = (args) => args.session;
  assert.deepEqual(who(await ask({ path: "/nowhere", headers: { ...nav, cookie: op.cookie } })), { name: "alice", role: "operator" }, "404: name and role, never the id or the hash");
  assert.equal(who(await ask({ path: "/nowhere", headers: nav })), null);
  assert.deepEqual(who(await ask({ path: "/logout", headers: { ...nav, cookie: viewer.cookie } })), { name: "vic", role: "viewer" });
  const forbidden = await ask({ path: "/audit", headers: { ...nav, cookie: viewer.cookie } });
  assert.deepEqual([forbidden.kind, forbidden.status, forbidden.session], ["operators-only", 403, { name: "vic", role: "viewer" }]);
  const bad = await ask({ path: "/runs?before=x", headers: { ...nav, cookie: op.cookie } });
  assert.deepEqual([bad.kind, bad.status, bad.sentence, bad.page, bad.session], ["bad-query", 400, "before must be a whole number of milliseconds", "runs", { name: "alice", role: "operator" }]);
  const host = await ask({ path: "/", headers: { ...nav, host: "myhost.lan", cookie: op.cookie } });
  assert.deepEqual([host.kind, host.status, host.host, host.port, host.address, host.session], ["host", 421, "myhost.lan", c.port, "127.0.0.1", null], "the connection's own address and port");
  const failed = await ask({ path: "/fleet", headers: { ...nav, cookie: op.cookie } });
  assert.deepEqual([failed.kind, failed.status, failed.session], ["failed", 500, null]);
  readable = false;
  const unavailable = await ask({ path: "/", headers: { ...nav, cookie: op.cookie } });
  assert.deepEqual([unavailable.kind, unavailable.status, unavailable.sentence, unavailable.session], ["unavailable", 503, TOKENS_UNUSABLE, null]);
  readable = true;
  for (const args of asked) {
    assert.ok(!JSON.stringify(args).includes(op.cookie.split("=")[1]) && !JSON.stringify(args).includes(viewer.cookie.split("=")[1]), "no session id reaches the page");
    assert.ok(!("tokenHash" in (args.session ?? {})));
  }
  // A request that wants no page asks for none.
  const before = asked.length;
  await c.send({ path: "/nowhere" });
  await c.send({ path: "/api/nowhere", headers: nav });
  assert.equal(asked.length, before);
});

test("an error page that cannot be drawn falls back to the refusal's own JSON, status and headers kept; a 500 that cannot be drawn is the fixed JSON", async () => {
  const pages = { ...fakePages(), loadPageData: async () => Promise.reject(new Error("boom")) };
  const c = await start({ errorPage: () => { throw new TypeError("frame broke"); }, pages });
  const { cookie } = await c.login();
  const missing = await c.send({ path: "/nowhere", headers: { accept: HTML_ACCEPT } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json(), { error: "there is no such page on this console" });
  assertSecurityHeaders(missing, "404 fallback");
  const method = await c.send({ path: "/logout", headers: { accept: HTML_ACCEPT } });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "POST", "the fallback keeps Allow");
  assert.ok(seen.logs.some((l) => l.includes("the no-page error page could not be drawn (TypeError)")), "logged by kind and error name only");
  const failed = await c.send({ path: "/", headers: { cookie, accept: HTML_ACCEPT } });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.json(), { error: "the console failed on this request; see its log" });
  assertSecurityHeaders(failed, "500 fallback");
});

// ---- the error pages drawn directly (issue #737): what each kind may and may not carry, whoever calls it ----

test("loginNoticeOf: exactly one ended, a member of ENDED_REASONS, else null", () => {
  for (const r of ENDED_REASONS) assert.equal(loginNoticeOf(new URLSearchParams(`ended=${r}`)), r);
  for (const q of ["", "ended=", "ended=IDLE", "ended=idle%20", "ended=idle&ended=idle", "ended=idle&ended=max", "ended=shutdown", "ended=__proto__", "x=idle", "Ended=idle"]) assert.equal(loginNoticeOf(new URLSearchParams(q)), null, q);
  assert.equal(loginNoticeOf(new URLSearchParams("x=1&ended=all")), "all", "another parameter is ignored, not refused");
  assert.equal(loginNoticeOf("ended=idle"), null, "a string is not a query");
  assert.equal(loginNoticeOf(null), null);
});

test("ERROR_SENTENCES: one per kind, frozen, each tile a STATUS_KINDS status and a sprite icon, no em dash and no token prefix", () => {
  assert.deepEqual(Object.keys(ERROR_SENTENCES), [...ERROR_KINDS]);
  assert.ok(Object.isFrozen(ERROR_KINDS) && Object.isFrozen(ERROR_SENTENCES));
  for (const [kind, said] of Object.entries(ERROR_SENTENCES)) {
    assert.ok(Object.isFrozen(said), kind);
    assert.ok(STATUS_KINDS.includes(said.status), `${kind}: ${said.status}`);
    assert.ok(ICON_NAMES.includes(said.icon), `${kind}: ${said.icon}`);
    for (const text of [said.title, said.heading, said.sentence]) {
      assert.ok(typeof text === "string" && text.length > 0, kind);
      assert.ok(!text.includes("\u2014") && !text.includes("pdc_"), `${kind}: ${text}`);
    }
  }
  // The host sentence never claims 127.0.0.1 alone, since PI_CONSOLE_ALLOWED_HOSTS may add names.
  assert.ok(!/127\.0\.0\.1 only/.test(ERROR_SENTENCES.host.sentence));
  // The operators-only heading names the audit log, which holds while it is the one operator page; a second one would
  // make the heading wrong, so this pins the relation to the page table.
  assert.deepEqual(Object.entries(realPages.PAGES).filter(([, p]) => p.auth === "operator").map(([n]) => n), ["audit"]);
});

const SOMEONE = Object.freeze({ name: "alice-nav-mark", role: "operator" });

test("errorPage: each kind's status, its one panel, data-page error, and a bar with the person only where the kind keeps the nav", () => {
  const want = { "no-page": 404, "bad-query": 400, "operators-only": 403, host: 421, unavailable: 503, failed: 500, method: 405, "no-run": 404 };
  for (const kind of ERROR_KINDS) {
    const out = errorPage({ kind, session: SOMEONE, readOnly: true, host: "myhost.lan", port: 7788, page: "insights", sentence: "range must be one of 7d, 30d, mtd" });
    const text = String(out.html);
    assert.equal(out.status, want[kind], kind);
    assert.match(text, /data-page="error"/, kind);
    assert.deepEqual(panelsOf(text), [kind === "host" ? "p-error-421" : "p-error"], kind);
    assert.match(panelText(text, kind === "host" ? "p-error-421" : "p-error"), new RegExp(`<p class="er-code">${want[kind]}</p>`), kind);
    const nav = ["no-page", "bad-query", "operators-only", "method", "no-run"].includes(kind);
    assert.equal(text.includes(SOMEONE.name), nav, `${kind}: the person ${nav ? "is" : "is not"} named`);
    assert.equal(text.includes('id="logout"'), nav, `${kind}: sign-out ${nav ? "is" : "is not"} drawn`);
    assert.ok(!text.includes("pdc_"), kind);
    assert.equal(errorPage({ kind, status: 418 }).status, 418, "the server's status, when it is one");
    assert.equal(errorPage({ kind, status: 200 }).status, want[kind], "never a success status");
  }
  assert.throws(() => errorPage({ kind: "teapot" }), RangeError);
  assert.throws(() => errorPage({ kind: "__proto__" }), RangeError);
  assert.throws(() => errorPage({}), RangeError);
});

test("errorPage: the server's sentence is shown for a 400 alone; every other kind says its catalog sentence", () => {
  const MARK = "/sentence-canary-91/<x>";
  for (const kind of ERROR_KINDS) {
    const text = String(errorPage({ kind, sentence: MARK, page: "runs" }).html);
    assert.equal(text.includes("sentence-canary-91"), kind === "bad-query", kind);
    assert.ok(!text.includes("<x>"), `${kind}: escaped`);
  }
  const bad = panelText(String(errorPage({ kind: "bad-query", sentence: "before must be a whole number of milliseconds", page: "runs", session: SOMEONE }).html), "p-error");
  assert.match(bad, /The page refused its address, so it read nothing: <span class="code">before<\/span> must be a whole number of milliseconds\./);
  assert.match(bad, /<a class="btn btn--primary" href="\/runs">.*Go to Runs<\/a><a class="btn" href="\/">.*Go to Overview<\/a>/);
  assert.match(panelText(String(errorPage({ kind: "bad-query" }).html), "p-error"), /so it read nothing\.<\/p>/, "no refusal: the lead-in alone");
  const unknownPage = panelText(String(errorPage({ kind: "bad-query", sentence: "x", page: "nope" }).html), "p-error");
  const links = (text) => Array.from(text.matchAll(/<a [^>]*href="([^"]*)"/g), (m) => m[1]);
  assert.deepEqual(links(unknownPage), ["/"], "a page that is not one: Overview only");
  const overview = panelText(String(errorPage({ kind: "bad-query", sentence: "x", page: "overview" }).html), "p-error");
  assert.deepEqual(links(overview), ["/"], "no second button to the same place");
});

test("errorPage 421: the name escaped and cut, the tunnel for the connection's port or a placeholder for a socket, nothing else", () => {
  const card = (args) => panelText(String(errorPage({ kind: "host", ...args }).html), "p-error-421");
  const tcp = card({ host: "myhost.lan", port: 7788, address: "127.0.0.1" });
  assert.match(tcp, /Your browser asked for <span class="code">myhost\.lan<\/span>, so the request was refused/);
  assert.ok(tcp.includes("<span>ssh</span> <span>-L</span> <span>7788:127.0.0.1:7788</span> <span>&#39;&lt;this host&gt;&#39;</span>"));
  assert.ok(tcp.includes("http://localhost:7788/"));
  // The address the connection reached, as serve's own hint names its bound host: never a fixed 127.0.0.1.
  const tunnel = (address) => /<span>ssh<\/span> <span>-L<\/span> <span>([^<]*)<\/span>/.exec(card({ host: "h", port: 7788, address }))[1];
  assert.deepEqual(
    ["127.0.0.1", "::1", "127.0.0.2", "10.1.2.3", "fd00::5", "::ffff:127.0.0.1", "::ffff:10.1.2.3", undefined, null, "", "not an address", "1.2.3.4]:9 -R x"].map(tunnel),
    ["7788:127.0.0.1:7788", "&#39;7788:[::1]:7788&#39;", "7788:127.0.0.2:7788", "7788:10.1.2.3:7788", "&#39;7788:[fd00::5]:7788&#39;", "7788:127.0.0.1:7788", "7788:10.1.2.3:7788", "7788:localhost:7788", "7788:localhost:7788", "7788:localhost:7788", "7788:localhost:7788", "7788:localhost:7788"],
    "IPv4 as itself, IPv6 in brackets (quoted for the shell, which would read them as a glob), a dual-stack socket's mapped IPv4 as itself, anything else (or none) localhost",
  );
  const socket = card({ host: "myhost.lan", port: null });
  assert.ok(socket.includes("<span>ssh</span> <span>-L</span> <span>&#39;4790:&lt;console socket&gt;&#39;</span> <span>&#39;&lt;this host&gt;&#39;</span>"), "a placeholder, never the socket's path");
  assert.ok(socket.includes("http://localhost:4790/"));
  for (const odd of [0, 65536, -1, 1.5, "7788", NaN]) assert.ok(card({ host: "h", port: odd }).includes("4790:&lt;console socket&gt;"), String(odd));
  assert.match(card({ host: null }), /asked for a Host that is not a plain name,/);
  assert.match(card({ host: "" }), /asked for a Host that is not a plain name,/);
  const long = "b".repeat(HOST_SHOWN_MAX + 10);
  assert.match(card({ host: long }), new RegExp(`<span class="code">${"b".repeat(HOST_SHOWN_MAX)}…</span>`));
  assert.match(card({ host: "c".repeat(HOST_SHOWN_MAX) }), new RegExp(`<span class="code">${"c".repeat(HOST_SHOWN_MAX)}</span>`), "exactly the cap is whole");
  assert.match(card({ host: `<img src=x onerror=1>"'` }), /<span class="code">&lt;img src=x onerror=1&gt;&quot;&#39;<\/span>/, "escaped by html, whoever calls it");
  const page = String(errorPage({ kind: "host", host: "myhost.lan", port: 7788, session: SOMEONE, readOnly: true }).html);
  for (const absent of [SOMEONE.name, "pillnav", 'href="/runs"', "Read-only"]) assert.ok(!page.includes(absent), absent);
});

test("forbiddenContent is the operators-only panel errorPage draws, so the role refusal and renderPage's belt say the same", () => {
  const panel = String(forbiddenContent());
  assert.deepEqual(panelsOf(panel), ["p-error"]);
  assert.match(panel, /The audit log is for operators/);
  assert.match(panel, /<a class="btn btn--primary" href="\/">/);
  assert.equal(panelText(String(errorPage({ kind: "operators-only", session: SOMEONE }).html), "p-error"), panel);
});

// ---- the flash (issue #737, the after-write banner) ----

test("a page GET takes the session's flash once and hands it to renderPage with maxStreams; HEAD, a refused query and a failed read leave it", async () => {
  const seen = [];
  let failLoad = false;
  const pages = {
    ...fakePages(),
    loadPageData: async (name) => {
      if (failLoad) throw new Error("read failed");
      return { name };
    },
    renderPage: async (name, ctx) => (seen.push({ flash: ctx.flash, maxStreams: ctx.maxStreams }), { status: 200, html: page({ title: name, name, body: html`<main></main>` }) }),
  };
  const c = await start({ pages, config: { maxStreams: 3 } });
  const { cookie } = await c.login();
  const id = cookie.split("=")[1];
  const change = { summary: "Paused the fleet", by: "alice", auditSeq: 7, count: 1, undo: "Resume it.", inverse: { action: "fleet-resume", body: {} } };
  c.sessions.setFlash(id, change);
  assert.equal((await c.send({ method: "HEAD", path: "/", headers: { cookie } })).status, 200);
  assert.deepEqual(seen.at(-1), { flash: null, maxStreams: 3 }, "HEAD takes nothing");
  assert.equal((await c.send({ path: "/insights?range=never", headers: { cookie } })).status, 400);
  failLoad = true;
  assert.equal((await c.send({ path: "/", headers: { cookie } })).status, 500);
  failLoad = false;
  assert.equal(seen.length, 1, "neither the 400 nor the failed read drew a page");
  assert.equal((await c.send({ path: "/", headers: { cookie } })).status, 200);
  assert.deepEqual(seen.at(-1), { flash: change, maxStreams: 3 }, "the next GET has it");
  assert.equal((await c.send({ path: "/", headers: { cookie } })).status, 200);
  assert.deepEqual(seen.at(-1), { flash: null, maxStreams: 3 }, "once");
});

test("the flash waits through a page whose read failed inside the REAL loadPageData (readFailed, no throw), and the next good page shows it (issue #737)", async () => {
  const seen = [];
  let down = true;
  const pages = { ...realPages, renderPage: async (name, ctx) => (seen.push({ name, flash: ctx.flash, readFailed: ctx.data.readFailed === true }), { status: 200, html: page({ title: name, name, body: html`<main></main>` }) }) };
  const fleet = { snapshot: async () => (down ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) : {}) };
  const c = await start({ pages, pageDeps: { fleet, now: T0 } });
  const { cookie } = await c.login();
  const change = { summary: "Paused the fleet", by: "alice", auditSeq: 7, count: 1 };
  c.sessions.setFlash(cookie.split("=")[1], change);
  assert.equal((await c.send({ path: "/", headers: { cookie } })).status, 200, "the page is drawn: loadPageData swallowed the throw");
  assert.deepEqual(seen.at(-1), { name: "overview", flash: null, readFailed: true }, "its panels say the fleet could not be read, so the banner waits");
  down = false;
  await c.send({ path: "/", headers: { cookie } });
  assert.deepEqual(seen.at(-1), { name: "overview", flash: change, readFailed: false }, "the next page that reads shows it");
  await c.send({ path: "/", headers: { cookie } });
  assert.equal(seen.at(-1).flash, null, "once");
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

test("a one-time code's return path (issue #708): one of this console's own pages, judged by the page parser, else /", async () => {
  const cases = [
    [undefined, "/"],
    ["/runs", "/runs"],
    ["/run?id=gh-acme-1", "/run?id=gh-acme-1"],
    ["/insights?range=7d", "/insights?range=7d"],
    ["//evil.example/x", "/"],
    ["https://evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["/login", "/"],
    ["/login/code", "/"],
    ["/nope", "/"],
    ["/runs?evil=1", "/"],
    ["/run", "/"],
    [7, "/"],
  ];
  for (const [i, [next, want]] of cases.entries()) {
    const code = String.fromCharCode(97 + i).repeat(43);
    const c = await start({ codes: [[code, "alice"]] });
    const res = await c.post("/login/code", next === undefined ? { code } : { code, next });
    assert.equal(res.status, 200, String(next));
    assert.equal(JSON.parse(res.text).next, want, String(next));
  }
});

test("a page request tells loadPageData who asks and the console's readOnly, so a read-only console's Parked page reads no planner check", async () => {
  for (const readOnly of [true, false]) {
    const loads = [];
    const pages = { ...fakePages(), loadPageData: async (name, query, deps, who) => (loads.push({ name, who }), { name }) };
    const c = await start({ config: { readOnly }, pages });
    const { cookie } = await c.login();
    assert.equal((await c.send({ path: "/parked", headers: { cookie } })).status, 200);
    assert.deepEqual(loads.at(-1), { name: "parked", who: { role: "operator", readOnly } });
  }
});

test("watch evidence refuses viewers before any private storage read and authenticates every request", async () => {
  const asked = [];
  const c = await start({ pageDeps: { watch: {
    readFinding: async (id, opts) => (asked.push(["finding", id, opts]), { id, samples: ["operator evidence"] }),
    readTrace: async (id, opts) => (asked.push(["trace", id, opts]), [{ kind: "query", text: "private query" }]),
  } } });
  const viewer = await c.login(VIEW_TOKEN);
  const denied = await c.send({ path: "/api/watch-trace?finding=f1", headers: { cookie: viewer.cookie } });
  assert.equal(denied.status, 403);
  assert.deepEqual(asked, []);
  const operator = await c.login();
  const accepted = await c.send({ path: "/api/watch-trace?finding=f1", headers: { cookie: operator.cookie } });
  assert.equal(accepted.status, 200);
  assert.match(accepted.text, /operator evidence/);
  assertSecurityHeaders(accepted, "private watch evidence");
  assert.deepEqual(asked, [["finding", "f1", { private: true }], ["trace", "f1", { private: true }]]);
});


test("saved flow what-if links redirect to Breakdown before reading data, retaining the query", async () => {
  const c = await start();
  const { cookie } = await c.login();
  const query = "range=7d&project=web&paths=full&whatif=acme%2Fmodel-1&flow=fix";
  const before = c.loads.length;
  for (const method of ["GET", "HEAD"]) {
    const out = await c.send({ method, path: `/insights?${query}`, headers: { cookie } });
    assert.equal(out.status, 303);
    assert.equal(out.headers.location, `/insights/breakdown?${query}`);
    assertSecurityHeaders(out, method);
  }
  assert.equal(c.loads.length, before, "redirect performs no assembly");
});
