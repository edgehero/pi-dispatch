import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { DEVICE_END_REASONS } from "@edgehero/pi-dispatch/console-devices";
import { ENDED_OF_DEVICE_REASON, REMEMBER_FRESH_MS, makeDeviceTrust } from "../src/console/device-trust.mjs";
import { ENDED_REASONS, STREAM_ENDS } from "../src/console/session-ends.mjs";
import * as realPages from "../src/console/pages.mjs";
import { DEVICE_STORE_UNUSABLE, createConsoleServer } from "../src/console/server.mjs";
import * as cookies from "../src/console/sessions.mjs";
import { makeSessionStore } from "../src/console/sessions.mjs";
import { makeLoginLimiter } from "../src/console/guards.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { clearLoginCodes, mintLoginCode } from "../src/console/login-codes.mjs";

// Remembered devices through the real server, the real session store, the real cookies and the real device store (issue #849). A "restart" is a new server and a
// new session store over the same folder, which is exactly what a console restart leaves behind.

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const HOUR = 3600 * 1000;
const sha = (t) => createHash("sha256").update(t).digest("hex");
const OPERATOR = `pdc_${"o".repeat(43)}`;
const VIEWER = `pdc_${"v".repeat(43)}`;
const AGENT = `pdc_${"a".repeat(43)}`;
const SECOND = `pdc_${"s".repeat(43)}`;
const baseFile = () => ({ version: 1, generation: 0, tokens: [
  { name: "rob", role: "operator", sha256: sha(OPERATOR), createdAt: "2026-10-01T00:00:00.000Z" },
  { name: "ann", role: "viewer", sha256: sha(VIEWER), createdAt: "2026-10-01T00:00:00.000Z" },
  { name: "bot", role: "agent", sha256: sha(AGENT), createdAt: "2026-10-01T00:00:00.000Z" },
  { name: "sam", role: "operator", sha256: sha(SECOND), createdAt: "2026-10-01T00:00:00.000Z" },
] });

const servers = [];
after(() => { for (const s of servers) s.close(); });

function world({ config = {}, consoleOrigin = null, hub = false, denyMax = undefined, realTickets = false, platform = "linux", loginCodes = undefined } = {}) {
  const root = fs.realpathSync(tempDir("console-remembered-"));
  const shared = { root, tokensPath: join(root, "console-tokens.json"), file: baseFile(), t: T0, consoleOrigin, rows: [], logs: [], bodies: [], ticketEnds: [], setupEnds: [], hubEnds: [], answer: null, fsOverride: fs };
  const now = () => shared.t;
  async function boot() {
    const trust = makeDeviceTrust({ tokensPath: shared.tokensPath, fs: shared.fsOverride === fs ? fs : shared.fsOverride, now, log: (l) => shared.logs.push(l), platform, ...(denyMax === undefined ? {} : { denyMax }) });
    const sessions = makeSessionStore({ now, idleMs: HOUR, maxMs: 12 * HOUR, deviceVerdict: (hash) => trust.verdictOf(hash) });
    const server = createConsoleServer({
      config: { allowedHosts: [], readOnly: false, maxMs: 12 * HOUR, idleMs: HOUR, listen: { kind: "tcp", host: "127.0.0.1", port: 0 }, pauseWindowsPath: join(root, "pw.json"), ...config },
      now, sessions, devices: trust, cookies,
      audit: { append: (row) => { if (shared.auditFails) throw new Error("disk full"); shared.rows.push(row); return { seq: shared.rows.length }; } },
      tickets: realTickets ? (() => { const t = makeConfirmTickets({ now }); return { ...t, endSession(id) { shared.ticketEnds.push(id); return t.endSession(id); } }; })() : { endSession(id) { shared.ticketEnds.push(id); }, issue: () => ({ ticket: "t" }), redeem: () => ({ refusal: "no" }) },
      actionDeps: { setup: { endSession(id) { shared.setupEnds.push(id); } }, ...(loginCodes === null ? {} : { loginCodes: loginCodes ?? { clear: () => clearLoginCodes({ dir: join(root, "console-login-codes"), fs }) } }) },
      limiter: makeLoginLimiter({ now, burst: 1000, perMinute: 1000 }),
      log: (l) => shared.logs.push(l),
      readTokens: () => ({ file: shared.file }),
      findToken: (file, presented) => file.tokens.find((e) => e.sha256 === sha(presented)) ?? null,
      consumeLoginCode: (code) => shared.codes?.get(code) ?? { refusal: "unknown" },
      writePauseWindows: () => ({ ok: true }),
      pages: { ...realPages, loadPageData: async () => ({}), pagePanels: async (name) => [{ id: "p-main", html: `<p>${name}</p>` }], renderPage: async (name, ctx) => { shared.pageCtx = ctx; return { status: 200, html: `<!doctype html><title>${name}</title><p>${ctx?.session?.name ?? ""}</p>` }; } },
      pageDeps: { fleet: { snapshot: async () => ({}) } },
      // A hub that says, for each end, whether the request it came from had answered yet (`answer`, a sign-in's response, seen beside the handler).
      hub: hub ? { endSession: (id, reason) => shared.hubEnds.push([id, reason, shared.answer?.writableFinished === true]), subscribe: () => () => {} } : null,
      consoleOrigin: () => (shared.originUnreadable ? false : shared.consoleOrigin),
    });
    servers.push(server);
    server.on("request", (req, res) => {
      if (req.url === "/login") shared.answer = res;
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const host = `127.0.0.1:${port}`;
    const send = ({ method = "GET", path = "/", headers = {}, body = null }) => new Promise((resolve, reject) => {
      const length = body !== null ? { "content-length": String(Buffer.byteLength(body)) } : {};
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...length, ...headers }, setHost: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); shared.bodies.push(text); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
      });
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
    const writeHeaders = (extra = {}) => ({ origin: `${consoleOrigin ?? `http://${host}`}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
    const post = (path, obj, extra = {}) => send({ method: "POST", path, headers: writeHeaders(extra), body: JSON.stringify(obj) });
    /** A write whose body is held back until `release` is called: the race a slow client can run. */
    const slowPost = (path, obj, extra = {}) => {
      let release;
      const done = new Promise((resolve, reject) => {
        const body = JSON.stringify(obj);
        const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host, ...writeHeaders(extra), "content-length": String(Buffer.byteLength(body)) }, setHost: false }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.flushHeaders();
        release = () => { req.write(body); req.end(); };
      });
      return { release: () => release(), done };
    };
    return { send, post, slowPost, host, trust, sessions, server };
  }
  return { shared, boot, advance: (ms) => { shared.t += ms; } };
}

const pairsOf = (res) => (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]);
const deviceCookieOf = (res) => pairsOf(res).find((c) => c.startsWith("pdc_device_") && !c.endsWith("=")) ?? null;
const sessionCookieOf = (res) => pairsOf(res).find((c) => c.startsWith("pdc_session=") && c !== "pdc_session=") ?? null;
const whoami = (c, cookie) => c.send({ path: "/api/whoami", headers: { cookie } });
async function remember(c, token = OPERATOR) {
  const res = await c.post("/login", { token, remember: true });
  assert.equal(res.status, 200, res.text);
  return { res, cookie: deviceCookieOf(res) };
}

test("remembering at sign-in sets the device cookie and no session cookie, with the right attributes, and records it", async () => {
  const w = world();
  const c = await w.boot();
  const { res, cookie } = await remember(c);
  assert.ok(cookie, JSON.stringify(res.headers["set-cookie"]));
  assert.equal(sessionCookieOf(res), null, "a remembered browser holds one credential");
  assert.match(res.headers["set-cookie"][0], /^pdc_device_[0-9a-f]{10}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=34560000$/);
  assert.equal(res.json().remembered, true);
  assert.deepEqual(c.trust.list().devices.map((d) => [d.name, d.role]), [["rob", "operator"]]);
  assert.deepEqual(w.shared.rows.map((r) => r.action), ["login", "device-remembered"]);
  assert.equal((await whoami(c, cookie)).status, 200);
});

test("acceptance 1: past the idle and absolute limits a remembered browser is still in, and an ordinary one is not", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const ordinary = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  w.advance(13 * HOUR);
  assert.equal((await whoami(c, cookie)).json().name, "rob");
  const out = await whoami(c, ordinary);
  assert.deepEqual([out.status, out.json().ended], [401, "idle"]);
  w.advance(30 * 24 * HOUR);
  assert.equal((await whoami(c, cookie)).status, 200);
});

test("acceptance 2: a restart keeps a remembered browser in, with one sign-in row, and an ordinary session does not survive", async () => {
  const w = world();
  const first = await w.boot();
  const { cookie } = await remember(first);
  const ordinary = sessionCookieOf(await first.post("/login", { token: VIEWER }));
  const c = await w.boot();
  const before = w.shared.rows.length;
  assert.equal((await whoami(c, cookie)).json().name, "rob");
  await whoami(c, cookie);
  assert.deepEqual(w.shared.rows.slice(before).map((r) => r.action), ["login-device"], "one row per device per process");
  assert.equal((await whoami(c, ordinary)).status, 401);
});

test("several requests arriving together after a restart share one session", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  const before = w.shared.rows.length;
  const all = await Promise.all(Array.from({ length: 12 }, () => whoami(c, cookie)));
  assert.ok(all.every((r) => r.status === 200));
  assert.equal(c.sessions.size(), 1);
  assert.equal(w.shared.rows.slice(before).filter((r) => r.action === "login-device").length, 1);
});

test("an audit log that cannot be written refuses a restored sign-in", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  w.shared.auditFails = true;
  assert.equal((await whoami(c, cookie)).status, 500);
  assert.equal(c.sessions.size(), 0);
  w.shared.auditFails = false;
  assert.equal((await whoami(c, cookie)).status, 200, "and it works again once the log does");
});

test("acceptance 4: sign-out ends the device for good, across a restart, and clears its cookie", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const out = await c.post("/logout", {}, { cookie });
  assert.equal(out.status, 200);
  const cleared = [].concat(out.headers["set-cookie"]);
  assert.ok(cleared.some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)));
  assert.ok(w.shared.rows.some((r) => r.action === "device-ended" && r.outcome === "ok"));
  const again = await whoami(await w.boot(), cookie);
  assert.deepEqual([again.status, again.json().ended], [401, "elsewhere"]);
});

test("acceptance 4: end-all, revoke, rotate and a role change each end a remembered browser, with the true reason, after a restart too", async () => {
  const cases = {
    all: (f) => { f.generation += 1; },
    revoked: (f) => { f.tokens = f.tokens.filter((e) => e.name !== "rob"); },
    "rotated, so revoked": (f) => { f.tokens.find((e) => e.name === "rob").sha256 = "f".repeat(64); },
    role: (f) => { f.tokens.find((e) => e.name === "rob").role = "viewer"; },
  };
  const expected = { all: "all", revoked: "revoked", "rotated, so revoked": "revoked", role: "role" };
  for (const [name, change] of Object.entries(cases)) {
    for (const restart of [false, true]) {
      const w = world();
      const first = await w.boot();
      const { cookie } = await remember(first);
      assert.equal((await whoami(first, cookie)).status, 200);
      change(w.shared.file);
      const c = restart ? await w.boot() : first;
      const res = await whoami(c, cookie);
      assert.deepEqual([res.status, res.json().ended], [401, expected[name]], `${name}, restart ${restart}`);
      const later = await whoami(await w.boot(), cookie);
      assert.deepEqual([later.status, later.json().ended], [401, expected[name]], `${name}: still ended, with its reason, after a further restart`);
    }
  }
});

test("removing a device ends a live session, and the page is told why, with the dead cookie cleared", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  assert.equal((await whoami(c, cookie)).status, 200);
  const [{ hash }] = c.trust.list().devices;
  c.trust.end(hash, "removed");
  const api = await whoami(c, cookie);
  assert.deepEqual([api.status, api.json().ended, api.headers["set-cookie"]], [401, "device", undefined], "no Set-Cookie on an API refusal");
  const page = await c.send({ path: "/runs", headers: { cookie } });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, "/login?ended=device&next=%2Fruns");
  assert.ok(page.headers["set-cookie"].some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)));
});

test("a store that cannot be read signs nobody out: the cookie stays, the page says so, a program gets a 503, and token sign-in still works", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const [{ hash }] = c.trust.list().devices;
  const path = join(w.shared.root, "console-devices", `${hash}.json`);
  const bytes = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, "{corrupt");
  const fresh = await w.boot();
  const api = await whoami(fresh, cookie);
  assert.deepEqual([api.status, api.json().ended, api.json().error], [503, "device-store", DEVICE_STORE_UNUSABLE]);
  const page = await fresh.send({ path: "/runs", headers: { cookie } });
  assert.deepEqual([page.status, page.headers.location, page.headers["set-cookie"]], [303, "/login?ended=device-store&next=%2Fruns", undefined], "nothing cleared");
  assert.equal((await fresh.post("/login", { token: VIEWER })).status, 200);
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  assert.equal((await whoami(fresh, cookie)).status, 200, "and it comes back whole when the store does");
});

test("a dead device cookie does not outrank a live session: signing in again really does sign you in", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  w.shared.file.generation += 1;
  await whoami(c, cookie);
  const signedIn = await c.post("/login", { token: OPERATOR }, { cookie });
  const session = sessionCookieOf(signedIn);
  assert.ok(session);
  assert.ok(signedIn.headers["set-cookie"].some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)), "and the sign-in clears the dead one");
  assert.equal((await whoami(c, `${cookie}; ${session}`)).json().name, "rob", "even for a request that still carries it");
});

test("signing in again as the same person on a remembered browser keeps the device", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const again = await c.post("/login", { token: OPERATOR }, { cookie });
  assert.deepEqual([again.status, again.json().remembered, again.headers["set-cookie"]], [200, true, undefined]);
  assert.equal(c.trust.list().devices.filter((d) => d.ended === undefined).length, 1);
  assert.equal((await whoami(c, cookie)).status, 200);
  assert.equal(c.sessions.size(), 1);
});

test("someone else signing in on a remembered browser ends that device, so a later sign-out cannot land on the wrong console", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const other = await c.post("/login", { token: SECOND }, { cookie });
  assert.equal(other.json().deviceEnded, true);
  assert.ok(other.headers["set-cookie"].some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)));
  assert.equal(c.trust.list().devices[0].ended.reason, "replaced");
  assert.equal((await whoami(c, sessionCookieOf(other))).json().name, "sam");
  assert.equal((await whoami(c, cookie)).status, 401);
});

/** A store that reads but cannot be written: a full disk, as the deny-list exists for. */
const unwritable = () => ({ ...fs, renameSync: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } });

test("a sign-out the store cannot write still signs out, says so, and refuses the device in this process", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const [{ hash }] = c.trust.list().devices;
  const out = await c.post("/logout", {}, { cookie });
  assert.deepEqual([out.status, out.json().device], [200, "unerased"]);
  assert.ok(w.shared.rows.some((r) => r.action === "device-ended" && r.outcome === "failed"));
  assert.equal((await whoami(c, cookie)).status, 401, "refused here, though the record is intact");
  assert.equal(c.trust.read(hash).denied, true);
});

test("an agent cannot be remembered, by sign-in or afterwards", async () => {
  const w = world();
  const c = await w.boot();
  // Issue #882 (review): the box starts ticked, so an agent token arrives asking. It signs in, as an ordinary session, and is told on its first page.
  const res = await c.post("/login", { token: AGENT, remember: true });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([deviceCookieOf(res), Boolean(sessionCookieOf(res)), res.json().remembered], [null, true, undefined]);
  assert.ok(!w.shared.rows.some((r) => r.action === "login-failed"), "no refusal: it signed in");
  assert.ok(w.shared.rows.some((r) => r.action === "login" && r.actor.role === "agent" && r.outcome === "ok"));
  assert.equal(c.trust.list().devices.length, 0);
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(res), accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], ["attention", "This browser was not remembered"]);
  assert.match(w.shared.pageCtx.flash.body, /An agent token is never remembered on a browser, so you are signed in for this session only/);
  assert.equal(w.shared.pageCtx.offer, false, "and never offered it either");
  const session = sessionCookieOf(await c.post("/login", { token: AGENT }));
  const up = await c.post("/api/device/remember", {}, { cookie: session });
  assert.equal(up.status, 403);
  assert.equal(c.trust.list().devices.length, 0);
});

test("plain HTTP across a network is refused; an enrolled HTTPS origin is allowed and gets Secure", async () => {
  const plain = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const p = await plain.boot();
  assert.equal((await p.post("/login", { token: OPERATOR, remember: true })).status, 403);
  assert.equal(p.trust.list().devices.length, 0);
  const https = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1", "console.example"] }, consoleOrigin: "https://console.example" });
  const h = await https.boot();
  const res = await h.post("/login", { token: OPERATOR, remember: true }, { host: "console.example" });
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers["set-cookie"][0], /; Secure$/);
});

test("the store's real path never decides a Secure cookie by a Host header a client could forge", async () => {
  const w = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const c = await w.boot();
  assert.equal((await c.post("/login", { token: OPERATOR, remember: true }, { host: "localhost" })).status, 403, "a public bind, whatever Host says");
});

test("remembering after signing in: in place, soon after, once, and never for a stale or invited sign-in", async () => {
  const w = world();
  const c = await w.boot();
  const first = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [, id] = first.split("=");
  const up = await c.post("/api/device/remember", {}, { cookie: first });
  assert.equal(up.status, 200, up.text);
  const device = deviceCookieOf(up);
  assert.ok(device);
  assert.ok(up.headers["set-cookie"].some((h) => h.startsWith("pdc_session=;")), "the ordinary cookie goes in the same answer");
  assert.equal(c.sessions.sessionOfDevice(c.trust.list().devices[0].hash), id, "the same session, so its tickets and streams carry on");
  assert.equal((await whoami(c, device)).status, 200);
  assert.deepEqual([(await c.post("/api/device/remember", {}, { cookie: device })).status, c.trust.list().devices.length], [200, 1], "asked twice is one device");
  const stale = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  w.advance(REMEMBER_FRESH_MS + 1);
  const late = await c.post("/api/device/remember", {}, { cookie: stale });
  assert.equal(late.status, 403);
  assert.match(late.text, /too old/);
  w.shared.codes = new Map([["i".repeat(43), { name: "ann", binding: { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) } }]]);
  const invited = sessionCookieOf(await c.post("/login/code", { code: "i".repeat(43) }));
  assert.ok(invited);
  const refused = await c.post("/api/device/remember", {}, { cookie: invited });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /invitation/);
});

test("the remember route keeps the write guards: another origin and a cross-site request are refused", async () => {
  const w = world();
  const c = await w.boot();
  const cookie = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  for (const extra of [{ origin: "http://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await c.post("/api/device/remember", {}, { cookie, ...extra })).status, 403, JSON.stringify(extra));
  }
  assert.equal(c.trust.list().devices.length, 0);
  assert.equal((await c.send({ method: "POST", path: "/api/device/remember", headers: { ...{ origin: `http://${c.host}`, "sec-fetch-site": "same-origin", "content-type": "text/plain" }, cookie }, body: "{}" })).status, 403);
});

/** Make the device's last use two days old, so its next use moves it and re-sets the cookie. */
function ageDevice(w, c) {
  const [{ hash }] = c.trust.list().devices;
  const old = (w.shared.t - 2 * 24 * HOUR) / 1000;
  fs.utimesSync(join(w.shared.root, "console-devices", `${hash}.json`), old, old);
}

test("the cookie is re-set at most daily, with the attributes it was set with", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  assert.equal((await whoami(c, cookie)).headers["set-cookie"], undefined, "not yet");
  ageDevice(w, c);
  const renewed = await whoami(c, cookie);
  assert.match(renewed.headers["set-cookie"][0], /^pdc_device_[0-9a-f]{10}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=34560000$/);
  assert.equal((await whoami(c, cookie)).headers["set-cookie"], undefined, "and then not again until tomorrow");
});

test("under an enrolled HTTPS origin the re-set cookie keeps Secure", async () => {
  const w = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1", "console.example"] }, consoleOrigin: "https://console.example" });
  const c = await w.boot();
  const res = await c.post("/login", { token: OPERATOR, remember: true }, { host: "console.example" });
  const cookie = deviceCookieOf(res);
  ageDevice(w, c);
  const renewed = await c.send({ path: "/api/whoami", headers: { cookie, host: "console.example" } });
  assert.equal(renewed.status, 200, renewed.text);
  assert.match(renewed.headers["set-cookie"][0], /; Max-Age=34560000; Secure$/);
});

test("the cookie is not re-set when the console's origin cannot be read, nor on a write, nor on a stream", async () => {
  const unreadable = world();
  const u = await unreadable.boot();
  const { cookie } = await remember(u);
  ageDevice(unreadable, u);
  unreadable.shared.originUnreadable = true;
  const res = await whoami(u, cookie);
  assert.deepEqual([res.status, res.headers["set-cookie"]], [200, undefined], "a cookie whose Secure cannot be told is not sent at all");

  const writes = world();
  const w = await writes.boot();
  const device = (await remember(w)).cookie;
  ageDevice(writes, w);
  const posted = await w.post("/api/device/remember", {}, { cookie: device });
  assert.deepEqual([posted.status, posted.headers["set-cookie"]], [200, undefined], "a write");

  const streams = world();
  const s = await streams.boot();
  const held = (await remember(s)).cookie;
  ageDevice(streams, s);
  const head = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(s.host.split(":")[1]), path: "/api/events?page=overview", headers: { host: s.host, cookie: held }, setHost: false }, (r) => {
      resolve({ status: r.statusCode, headers: r.headers });
      req.destroy();
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(head.headers["set-cookie"], undefined, `a stream (status ${head.status})`);
});

test("the signed-in bar of a 404 reads a remembered device without signing it in", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  const before = w.shared.rows.length;
  const page = await c.send({ path: "/nowhere", headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 404);
  assert.match(page.text, /rob/, "the bar names the remembered person");
  assert.deepEqual(w.shared.rows.slice(before), [], "no row");
  assert.equal(c.sessions.size(), 0, "no session");
});

test("the device secret reaches no page and no log", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const secret = cookie.split("=")[1];
  await whoami(c, cookie);
  await c.send({ path: "/runs", headers: { cookie } });
  await c.post("/logout", {}, { cookie });
  for (const text of [...w.shared.bodies, ...w.shared.logs, JSON.stringify(w.shared.rows)]) assert.ok(!text.includes(secret));
});

// Round 2 of the review (issue #849).

const tick = () => new Promise((r) => setTimeout(r, 30));

test("a remember whose body arrives after end-all or a sign-out is refused, and leaves no device", async () => {
  for (const ending of ["end-all", "sign-out"]) {
    const w = world();
    const c = await w.boot();
    const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
    const slow = c.slowPost("/api/device/remember", {}, { cookie: session });
    await tick();
    if (ending === "end-all") w.shared.file.generation += 1;
    else assert.equal((await c.post("/logout", {}, { cookie: session })).status, 200);
    slow.release();
    const res = await slow.done;
    assert.equal(res.status, 401, `${ending}: ${res.text}`);
    assert.equal(c.trust.list().devices.length, 0, ending);
  }
});

test("two tabs pressing Remember together leave one device, not an orphan that outlives sign-out", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const a = c.slowPost("/api/device/remember", {}, { cookie: session });
  const b = c.slowPost("/api/device/remember", {}, { cookie: session });
  await tick();
  a.release();
  b.release();
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  assert.equal(c.trust.list().devices.filter((d) => d.ended === undefined).length, 1);
});

test("the pdc_session a browser held before it was remembered no longer signs in, and signing out with it ends the device", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const device = deviceCookieOf(await c.post("/api/device/remember", {}, { cookie: session }));
  assert.equal((await whoami(c, session)).status, 401, "a copy of the old cookie");
  w.advance(30 * 24 * HOUR);
  assert.equal((await whoami(c, session)).status, 401, "and not later either");
  assert.equal((await whoami(c, device)).status, 200, "while the device itself is fine");
  assert.equal((await c.post("/logout", {}, { cookie: session })).status, 200);
  assert.equal((await whoami(c, device)).status, 401, "signing out with the old cookie ended the device");
  const row = w.shared.rows.find((r) => r.action === "device-ended");
  assert.deepEqual([row?.outcome, row?.reason], ["ok", "signed out"]);
});

test("a refused sign-in by someone else leaves the browser's remembered person as they were", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  w.shared.auditFails = true;
  assert.equal((await c.post("/login", { token: SECOND }, { cookie })).status, 500);
  w.shared.auditFails = false;
  assert.equal((await whoami(c, cookie)).json().name, "rob");
  assert.equal(c.trust.list().devices[0].ended, undefined);
});

test("the same person signing in again after their token changed ends the old device with the true reason", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  w.shared.file.generation += 1;
  const again = await c.post("/login", { token: OPERATOR }, { cookie });
  assert.equal(again.status, 200);
  assert.equal(c.trust.list().devices[0].ended.reason, "all");
});

test("a same-person sign-in that cannot be audited leaves no session to be restored later without a row", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  w.shared.auditFails = true;
  assert.equal((await c.post("/login", { token: OPERATOR }, { cookie })).status, 500);
  assert.equal(c.sessions.size(), 0);
  w.shared.auditFails = false;
  const before = w.shared.rows.length;
  assert.equal((await whoami(c, cookie)).status, 200);
  assert.deepEqual(w.shared.rows.slice(before).map((r) => r.action), ["login-device"], "the restore that follows has its row");
});

test("a loopback console reached under another name over plain HTTP is not remembered", async () => {
  const w = world({ config: { allowedHosts: ["console.lan"] } });
  const c = await w.boot();
  const res = await c.send({ method: "POST", path: "/login", headers: { host: "console.lan", origin: "http://console.lan", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR, remember: true }) });
  assert.equal(res.status, 403, res.text);
  assert.equal(c.trust.list().devices.length, 0);
});

test("a record unused for longer than any browser keeps the cookie is a copy, and is ended", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const [{ hash }] = c.trust.list().devices;
  w.advance(401 * 24 * HOUR);
  const old = (w.shared.t - 401 * 24 * HOUR) / 1000;
  fs.utimesSync(join(w.shared.root, "console-devices", `${hash}.json`), old, old);
  const res = await whoami(c, cookie);
  assert.deepEqual([res.status, res.json().ended], [401, "device"]);
  assert.equal(c.trust.list().devices[0].ended.reason, "removed");
});

test("with no device folder a presented cookie is simply no device: signed out and cleared, never the store alarm", async () => {
  const w = world();
  const c = await w.boot();
  const planted = `${c.trust.cookieName}=${"p".repeat(43)}`;
  const api = await whoami(c, planted);
  assert.deepEqual([api.status, api.json().ended], [401, "device"]);
  const page = await c.send({ path: "/runs", headers: { cookie: planted } });
  assert.equal(page.headers.location, "/login?ended=device&next=%2Fruns");
  assert.ok(page.headers["set-cookie"].some((h) => h.startsWith(`${c.trust.cookieName}=;`)));
});

test("a sign-out the store cannot write names the device and the command to finish it in the log", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const [{ id }] = c.trust.list().devices;
  await c.post("/logout", {}, { cookie });
  assert.ok(w.shared.logs.some((l) => l.includes(id) && l.includes(`device revoke --id ${id}`)), w.shared.logs.join(" | "));
});

// Round 3 of the review (issue #849).

test("a junk device cookie beside the old pdc_session does not reach the device's session", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  await c.post("/api/device/remember", {}, { cookie: session });
  const junk = `${c.trust.cookieName}=${"j".repeat(43)}`;
  assert.equal((await whoami(c, `${session}; ${junk}`)).status, 401);
});

test("a unix-socket console is remembered only through a loopback name, as a tunnel arrives", async () => {
  const w = world({ config: { listen: { kind: "unix", path: "/tmp/x.sock" }, allowedHosts: ["console.lan"] } });
  const c = await w.boot();
  const proxied = await c.send({ method: "POST", path: "/login", headers: { host: "console.lan", origin: "http://console.lan", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR, remember: true }) });
  assert.equal(proxied.status, 403, proxied.text);
  const tunnel = await c.send({ method: "POST", path: "/login", headers: { host: "localhost:4790", origin: "http://localhost:4790", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token: OPERATOR, remember: true }) });
  assert.equal(tunnel.status, 200, tunnel.text);
});

test("one sign-out writes one row per device", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  await whoami(c, cookie);
  const before = w.shared.rows.length;
  await c.post("/logout", {}, { cookie });
  assert.equal(w.shared.rows.slice(before).filter((r) => r.action === "device-ended").length, 1);
});

test("signing in again on a browser whose record is past 400 days replaces it rather than keeping a dead one", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const [{ hash }] = c.trust.list().devices;
  w.advance(401 * 24 * HOUR);
  const old = (w.shared.t - 401 * 24 * HOUR) / 1000;
  fs.utimesSync(join(w.shared.root, "console-devices", `${hash}.json`), old, old);
  const before = w.shared.rows.length;
  const again = await c.post("/login", { token: OPERATOR }, { cookie });
  assert.equal(again.json().remembered, undefined, "not answered as remembered");
  assert.equal((await whoami(c, sessionCookieOf(again))).status, 200, "and the new sign-in works on the next request");
  assert.equal(c.trust.list().devices[0].ended.reason, "removed", "the same person's own record, ended as unused, not as replaced");
  assert.equal(w.shared.rows.slice(before).find((r) => r.action === "device-ended")?.reason, "unused for longer than any browser keeps the cookie");
});

test("an end met at a device's next use is in the audit log, with why", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  w.shared.file.generation += 1;
  await whoami(c, cookie);
  const row = w.shared.rows.find((r) => r.action === "device-ended");
  assert.deepEqual([row?.outcome, row?.reason], ["ok", "its token entry no longer matches"]);
});

// Round 4 of the review (issue #849): guarantees the earlier tests did not hold.

test("sign-out with both the tokens file and the device store unreadable still signs out, and says the device was not erased", async (t) => {
  // Twice: with the device's session held in this process, which proves the record real here, and after a restart, when nothing does.
  for (const restarted of [false, true]) {
    const w = world();
    const first = await w.boot();
    const { cookie } = await remember(first);
    const [{ hash }] = first.trust.list().devices;
    const c = restarted ? await w.boot() : first;
    const file = w.shared.file;
    const dir = join(w.shared.root, "console-devices");
    w.shared.file = null;
    fs.chmodSync(dir, 0o500);
    t.after(() => fs.chmodSync(dir, 0o700));
    const out = await c.post("/logout", {}, { cookie });
    assert.deepEqual([out.status, out.json().device], [200, "unerased"]);
    const cleared = [].concat(out.headers["set-cookie"]);
    assert.ok(cleared.some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)), "the device cookie cleared");
    assert.ok(w.shared.rows.some((r) => r.action === "device-ended" && r.outcome === "failed"));
    w.shared.file = file;
    const after = await whoami(c, cookie);
    if (restarted) {
      assert.deepEqual([after.status, after.json().ended], [503, "device-store"], "a copy signs nobody in while the store cannot be read");
      assert.notEqual(c.trust.read(hash).denied, true, "and a cookie alone, with no session behind it here, adds nothing to the deny-list");
    } else {
      assert.deepEqual([after.status, after.json().ended], [401, "device"], "refused in this process, whatever the record says later");
    }
    fs.chmodSync(dir, 0o700);
  }
});

test("a record that cannot be read does not hide a revocation the tokens file already proves", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  assert.equal((await whoami(c, cookie)).status, 200);
  const [{ hash }] = c.trust.list().devices;
  w.shared.file.tokens = w.shared.file.tokens.filter((e) => e.name !== "rob");
  fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
  const res = await whoami(c, cookie);
  assert.deepEqual([res.status, res.json().ended], [401, "revoked"]);
  assert.equal(c.sessions.size(), 0);
});

test("an unjudged device gives way to a live ordinary session in the same browser", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const [{ hash }] = c.trust.list().devices;
  fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
  const fresh = await w.boot();
  const session = sessionCookieOf(await fresh.post("/login", { token: SECOND }));
  const res = await whoami(fresh, `${cookie}; ${session}`);
  assert.deepEqual([res.status, res.json().name], [200, "sam"]);
});

test("a device found dead loses its session here, with its tickets", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  assert.equal((await whoami(c, cookie)).status, 200);
  const [{ hash }] = c.trust.list().devices;
  const id = c.sessions.sessionOfDevice(hash);
  c.trust.end(hash, "removed");
  assert.equal((await whoami(c, cookie)).status, 401);
  assert.equal(c.sessions.size(), 0);
  assert.ok(w.shared.ticketEnds.includes(id));
});

test("sign-out by device cookie and a sign-in by someone else each end the device's session in this process", async () => {
  for (const ending of ["sign-out", "someone else"]) {
    const w = world();
    const c = await w.boot();
    const { cookie } = await remember(c);
    assert.equal((await whoami(c, cookie)).status, 200);
    const [{ hash }] = c.trust.list().devices;
    const id = c.sessions.sessionOfDevice(hash);
    if (ending === "sign-out") await c.post("/logout", {}, { cookie });
    else await c.post("/login", { token: SECOND }, { cookie });
    assert.equal(c.sessions.sessionOfDevice(hash) ?? null, null, ending);
    assert.ok(w.shared.ticketEnds.includes(id), ending);
  }
});

test("a sign-out after a restart is that person's, on the record, not an anonymous one", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  const before = w.shared.rows.length;
  await c.post("/logout", {}, { cookie });
  const rows = w.shared.rows.slice(before);
  assert.deepEqual(rows.map((r) => [r.action, r.actor.name]), [["device-ended", "rob"], ["logout", "rob"]]);
});

test("the remember route refuses plain HTTP across a network, and sets Secure under an enrolled HTTPS origin", async () => {
  const plain = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const p = await plain.boot();
  const ordinary = sessionCookieOf(await p.post("/login", { token: OPERATOR }));
  const refused = await p.post("/api/device/remember", {}, { cookie: ordinary });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /plain HTTP/);
  assert.equal(p.trust.list().devices.length, 0);
  const https = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1", "console.example"] }, consoleOrigin: "https://console.example" });
  const h = await https.boot();
  const session = sessionCookieOf(await h.post("/login", { token: OPERATOR }, { host: "console.example" }));
  const up = await h.post("/api/device/remember", {}, { cookie: session, host: "console.example" });
  assert.equal(up.status, 200, up.text);
  assert.match(up.headers["set-cookie"][0], /; Secure$/);
});

test("the remember route stops when its audit row cannot be written, and leaves no device", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  w.shared.auditFails = true;
  const res = await c.post("/api/device/remember", {}, { cookie: session });
  assert.equal(res.status, 503);
  assert.equal(c.trust.list().devices.length, 0);
  w.shared.auditFails = false;
  assert.equal((await whoami(c, session)).status, 200, "and the ordinary session carries on");
});

test("a device someone else replaced, whose end the store could not write, is on the record as failed", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  await c.post("/login", { token: SECOND }, { cookie });
  const row = w.shared.rows.find((r) => r.action === "device-ended");
  assert.deepEqual([row?.outcome, row?.actor.name], ["failed", "rob"]);
});

test("remembering with a new token ends the devices of the token it replaced, as revoked", async () => {
  const w = world();
  const c = await w.boot();
  await remember(c);
  w.advance(24 * HOUR);
  const NEW = `pdc_${"n".repeat(43)}`;
  const rob = w.shared.file.tokens.find((e) => e.name === "rob");
  rob.sha256 = sha(NEW);
  rob.createdAt = new Date(w.shared.t - HOUR).toISOString();
  await remember(c, NEW);
  const devices = c.trust.list().devices;
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((d) => d.ended?.reason ?? "live").sort(), ["live", "revoked"]);
});

test("ENDED_OF_DEVICE_REASON has a sign-in page word for every reason the store writes, and only those", () => {
  // A hand-written table over the worker's list: a reason added there without a word here would reach the page as the bare `device`.
  assert.deepEqual(Object.keys(ENDED_OF_DEVICE_REASON).sort(), [...DEVICE_END_REASONS].sort());
  // Each word ends a page and a stream alike, so it must be in both lists: `restart` or `device-store` would pass the first alone.
  for (const word of Object.values(ENDED_OF_DEVICE_REASON)) assert.ok(ENDED_REASONS.includes(word) && STREAM_ENDS.includes(word), word);
});

// Round 4 of the adversarial review (issue #849).

test("a sign-out over a record that cannot be read keeps a copy out once the record reads again, in this process", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const [{ hash, id }] = c.trust.list().devices;
  const path = join(w.shared.root, "console-devices", `${hash}.json`);
  const bytes = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, "{corrupt");
  const out = await c.post("/logout", {}, { cookie });
  assert.deepEqual([out.status, out.json().device], [200, "unerased"]);
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  const copy = await whoami(c, cookie);
  assert.deepEqual([copy.status, copy.json().ended], [401, "device"]);
  assert.ok(w.shared.logs.some((l) => l.includes(`device revoke --id ${id}`)), w.shared.logs.join(" | "));
});

test("a renewal never drops Secure: once the HTTPS enrollment is gone, a cookie made under it is left to age", async () => {
  const w = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1", "console.example"] }, consoleOrigin: "https://console.example" });
  const c = await w.boot();
  const cookie = deviceCookieOf(await c.post("/login", { token: OPERATOR, remember: true }, { host: "console.example" }));
  ageDevice(w, c);
  w.shared.consoleOrigin = null;
  const res = await c.send({ path: "/api/whoami", headers: { cookie, host: "console.example" } });
  assert.deepEqual([res.status, res.headers["set-cookie"]], [200, undefined]);
});

test("a remembered session whose record cannot be read keeps its tickets when its old pdc_session comes back", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [, id] = session.split("=");
  const device = deviceCookieOf(await c.post("/api/device/remember", {}, { cookie: session }));
  const [{ hash }] = c.trust.list().devices;
  const path = join(w.shared.root, "console-devices", `${hash}.json`);
  const bytes = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, "{corrupt");
  assert.equal((await whoami(c, session)).status, 401);
  assert.ok(!w.shared.ticketEnds.includes(id), "its pending confirms are not cancelled by an old cookie");
  assert.equal(c.sessions.size(), 1);
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  assert.equal((await whoami(c, device)).status, 200);
});

test("a stream or a write on the day's first use leaves the cookie's re-set for the next read", async () => {
  for (const first of ["stream", "write"]) {
    const w = world();
    const c = await w.boot();
    const { cookie } = await remember(c);
    ageDevice(w, c);
    if (first === "write") {
      assert.equal((await c.post("/api/device/remember", {}, { cookie })).status, 200);
    } else {
      await new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: Number(c.host.split(":")[1]), path: "/api/events?page=overview", headers: { host: c.host, cookie }, setHost: false }, (r) => {
          resolve();
          req.destroy();
        });
        req.on("error", reject);
        req.end();
      });
    }
    const page = await whoami(c, cookie);
    assert.match(page.headers["set-cookie"]?.[0] ?? "", /^pdc_device_[0-9a-f]{10}=/, `${first} first, then a read: renewed`);
  }
});

test("a failed end over an unreadable record names the person signing out, so no anonymous flood can keep it out of the log", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const [{ hash }] = c.trust.list().devices;
  fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
  const before = w.shared.rows.length;
  await c.post("/logout", {}, { cookie });
  const rows = w.shared.rows.slice(before);
  const ended = rows.filter((r) => r.action === "device-ended");
  assert.deepEqual(ended.map((r) => [r.actor.name, r.outcome]), [["rob", "failed"]]);
  assert.deepEqual(rows.filter((r) => r.action === "logout").map((r) => r.actor.name), ["rob"]);
});

// The walkthrough's findings (issue #849).

test("signing out of a remembered console leaves another loopback console's ordinary session alone", async () => {
  const a = world();
  const ca = await a.boot();
  const { cookie } = await remember(ca);
  const b = world();
  const cb = await b.boot();
  const other = sessionCookieOf(await cb.post("/login", { token: VIEWER }));
  const out = await ca.post("/logout", {}, { cookie: `${cookie}; ${other}` });
  const cleared = [].concat(out.headers["set-cookie"]);
  assert.ok(cleared.some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)), "its own device cookie goes");
  assert.ok(!cleared.some((h) => h.startsWith("pdc_session=;")), "a pdc_session this console never held stays");
  assert.equal((await whoami(cb, other)).status, 200);
  // A pdc_session this console did hold, beside the device cookie, still goes.
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const device = deviceCookieOf(await c.post("/api/device/remember", {}, { cookie: session }));
  const both = await c.post("/logout", {}, { cookie: `${device}; ${session}` });
  assert.ok([].concat(both.headers["set-cookie"]).some((h) => h.startsWith("pdc_session=;")));
});

test("signing in again while this browser's record cannot be read clears its cookie, leaves a row with its id, and keeps a copy out here", async () => {
  for (const restarted of [false, true]) {
    const w = world();
    const first = await w.boot();
    const { cookie } = await remember(first);
    const [{ hash, id }] = first.trust.list().devices;
    const path = join(w.shared.root, "console-devices", `${hash}.json`);
    const bytes = fs.readFileSync(path, "utf8");
    fs.writeFileSync(path, "{corrupt");
    const c = restarted ? await w.boot() : first;
    const before = w.shared.rows.length;
    const again = await c.post("/login", { token: OPERATOR }, { cookie });
    assert.equal(again.status, 200, again.text);
    assert.ok([].concat(again.headers["set-cookie"]).some((h) => /^pdc_device_[0-9a-f]{10}=;/.test(h)), "the cookie goes: the record could be anyone's");
    const row = w.shared.rows.slice(before).find((r) => r.action === "device-ended");
    assert.deepEqual([row?.target, row?.outcome, row?.actor.name], [id, "failed", "rob"]);
    fs.writeFileSync(path, bytes, { mode: 0o600 });
    const copy = await whoami(c, cookie);
    if (restarted) assert.equal(copy.status, 200, "after a restart nothing held it: the residual, which the row's id is for");
    else assert.deepEqual([copy.status, copy.json().ended], [401, "device"], "refused in memory while its session was held here");
  }
});

// Round 5 of the spec audit (issue #849).

test("someone else signing in ends the replaced device's open streams only once the answer has gone out, its record readable or not", async () => {
  for (const unreadable of [false, true]) {
    const w = world({ hub: true });
    const c = await w.boot();
    const { cookie } = await remember(c);
    assert.equal((await whoami(c, cookie)).status, 200);
    const [{ hash }] = c.trust.list().devices;
    const id = c.sessions.sessionOfDevice(hash);
    if (unreadable) fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
    assert.equal((await c.post("/login", { token: SECOND }, { cookie })).status, 200);
    assert.deepEqual(w.shared.hubEnds.filter(([sid]) => sid === id), [[id, "elsewhere", true]], `unreadable ${unreadable}: never before the new cookie was sent`);
  }
});

test("a sign-out's device row says it was a sign-out", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  await c.post("/logout", {}, { cookie });
  assert.equal(w.shared.rows.find((r) => r.action === "device-ended")?.reason, "signed out");
});

test("remembering at sign-in over a live ordinary session clears its pdc_session in the same answer", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const res = await c.post("/login", { token: OPERATOR, remember: true }, { cookie: session });
  const set = [].concat(res.headers["set-cookie"]);
  assert.ok(set.some((h) => /^pdc_device_[0-9a-f]{10}=[A-Za-z0-9_-]{43};/.test(h)) && set.some((h) => h.startsWith("pdc_session=;")), JSON.stringify(set));
});

test("a record or a whole folder removed ends that device's session at its next judgement", async () => {
  for (const removed of ["record", "folder"]) {
    const w = world();
    const c = await w.boot();
    const { cookie } = await remember(c);
    const [{ hash }] = c.trust.list().devices;
    const id = c.sessions.sessionOfDevice(hash);
    const dir = join(w.shared.root, "console-devices");
    if (removed === "record") fs.unlinkSync(join(dir, `${hash}.json`));
    else fs.rmSync(dir, { recursive: true });
    assert.deepEqual(c.sessions.verdict(id, w.shared.file), { ended: "device" }, `${removed}: what the hub asks each tick`);
    assert.deepEqual([(await whoami(c, cookie)).status], [401], removed);
  }
});

test("past the in-memory limit an end that cannot be written is not claimed as refused", async () => {
  const root = fs.realpathSync(tempDir("console-remembered-cap-"));
  const tokensPath = join(root, "console-tokens.json");
  const writable = makeDeviceTrust({ tokensPath, fs, platform: "linux", now: () => T0 });
  const a = writable.remember({ name: "rob", role: "operator", tokenHash: sha(OPERATOR), generation: 0 });
  const b = writable.remember({ name: "rob", role: "operator", tokenHash: sha(OPERATOR), generation: 0 });
  const logs = [];
  const full = makeDeviceTrust({ tokensPath, fs: unwritable(), platform: "linux", now: () => T0, log: (l) => logs.push(l), denyMax: 1 });
  assert.deepEqual([full.end(a.hash, "signed-out").held, full.read(a.hash).denied], [true, true]);
  const second = full.end(b.hash, "signed-out");
  assert.deepEqual([second.unerased, second.held, full.read(b.hash).denied], [true, false, undefined]);
  assert.match(logs.at(-1), /holds too many such refusals/);
  assert.doesNotMatch(logs.at(-1), /it is refused until/);
  assert.equal(full.end(a.hash, "signed-out").held, true, "one already held stays held, however full the list");
});

test("past the in-memory limit a sign-out's audit row does not claim the device is refused either", async () => {
  const w = world({ denyMax: 0 });
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  await c.post("/logout", {}, { cookie });
  const row = w.shared.rows.find((r) => r.action === "device-ended");
  assert.equal(row?.outcome, "failed");
  assert.match(row.reason, /could not hold it either, so revoke it/);
  assert.doesNotMatch(row.reason, /refused in memory/);
});

// Part 5 of issue #849: the Remember choice, the offer, the remembered mark, and the two operator actions.

test("the session store offers a fresh sign-in once, never a remembered one, and forgets the offer with the session", () => {
  let t = T0;
  const store = makeSessionStore({ now: () => t, idleMs: HOUR, maxMs: 12 * HOUR });
  const { id } = store.create({ name: "rob", role: "operator", tokenHash: "a".repeat(64), generation: 0 });
  assert.equal(store.takeOffer(id, REMEMBER_FRESH_MS), false, "nothing offered yet");
  assert.equal(store.setOffer(id), true);
  assert.equal(store.takeOffer(id, REMEMBER_FRESH_MS), true);
  assert.equal(store.takeOffer(id, REMEMBER_FRESH_MS), false, "once");
  store.setOffer(id);
  t += REMEMBER_FRESH_MS + 1;
  assert.equal(store.takeOffer(id, REMEMBER_FRESH_MS), false, "too old to be remembered: not offered");
  const other = store.create({ name: "ann", role: "viewer", tokenHash: "b".repeat(64), generation: 0 }).id;
  store.setOffer(other);
  store.destroy(other, "elsewhere");
  assert.equal(store.takeOffer(other, REMEMBER_FRESH_MS), false);
  assert.equal(store.setOffer("x".repeat(43)), false, "an id the store does not hold");
  const device = store.ensureDevice({ deviceHash: "d".repeat(64), name: "rob", role: "operator", tokenHash: "a".repeat(64), generation: 0 }).id;
  store.setOffer(device);
  assert.equal(store.takeOffer(device, REMEMBER_FRESH_MS), false, "a remembered session is never offered");
});

test("endAll ends every session with the tombstone all, keeps a time limit's word, and returns the ids", () => {
  let t = T0;
  const store = makeSessionStore({ now: () => t, idleMs: HOUR, maxMs: 12 * HOUR });
  const file = { version: 1, generation: 0, tokens: [] };
  const a = store.create({ name: "rob", role: "operator", tokenHash: "a".repeat(64), generation: 0 }).id;
  const b = store.create({ name: "ann", role: "viewer", tokenHash: "b".repeat(64), generation: 0 }).id;
  const d = store.ensureDevice({ deviceHash: "d".repeat(64), name: "rob", role: "operator", tokenHash: "a".repeat(64), generation: 0 }).id;
  // The two ordinary sessions go idle; the device-backed one has no idle limit.
  t += 70 * 60000;
  assert.deepEqual(store.endAll().map(({ id, reason }) => [id, reason]).sort(), [[a, "idle"], [b, "idle"], [d, "all"]].sort());
  assert.equal(store.size(), 0);
  assert.deepEqual([store.endedOf(a), store.endedOf(b), store.endedOf(d)], ["idle", "idle", "all"], "a time limit keeps its word");
  assert.equal(store.sessionOfDevice("d".repeat(64)), null);
  const live = store.create({ name: "ann", role: "viewer", tokenHash: "b".repeat(64), generation: 0 }).id;
  store.endAll();
  assert.deepEqual([store.endedOf(live), store.get(live, file)], ["all", null]);
});

test("clearLoginCodes removes every pending link, expired or not, and a missing folder holds none", () => {
  const root = fs.realpathSync(tempDir("console-remembered-codes-"));
  const dir = join(root, "console-login-codes");
  assert.deepEqual(clearLoginCodes({ dir, fs }), { removed: 0, left: 0 });
  const one = mintLoginCode({ dir, name: "rob", fs, now: () => T0 });
  const two = mintLoginCode({ dir, name: "ann", fs, now: () => T0, binding: { sha256: "b".repeat(64), createdAt: "2026-10-01T00:00:00.000Z", role: "viewer", generation: 0 } });
  assert.ok(one.code && two.code);
  fs.writeFileSync(join(dir, "README"), "not a code");
  assert.deepEqual(clearLoginCodes({ dir, fs }), { removed: 2, left: 0 });
  assert.deepEqual(fs.readdirSync(dir), ["README"], "only code files go");
});

test("a fresh sign-in that did not ask is offered once on its next page; a remembered, invited, agent or plain-HTTP sign-in is not", async () => {
  const w = world();
  const c = await w.boot();
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  await c.send({ path: "/runs", headers: { cookie: session, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, true);
  assert.equal(w.shared.pageCtx.session.remembered, null);
  await c.send({ path: "/runs", headers: { cookie: session, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, false, "once");
  const remembered = (await remember(c)).cookie;
  await c.send({ path: "/runs", headers: { cookie: remembered, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, false, "asked already");
  assert.match(w.shared.pageCtx.session.remembered, /^[0-9a-f]{12}$/, "the page knows this browser is remembered, by its short id");
  const agent = sessionCookieOf(await c.post("/login", { token: AGENT }));
  await c.send({ path: "/runs", headers: { cookie: agent, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, false, "an agent token is never offered");
  w.shared.codes = new Map([["i".repeat(43), { name: "ann", binding: { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) } }]]);
  const invited = sessionCookieOf(await c.post("/login/code", { code: "i".repeat(43) }));
  await c.send({ path: "/runs", headers: { cookie: invited, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, false, "nor an invitation");
  const late = sessionCookieOf(await c.post("/login", { token: SECOND }));
  w.advance(REMEMBER_FRESH_MS + 1);
  await c.send({ path: "/runs", headers: { cookie: late, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, false, "nor once it is too old to be remembered");
  const plain = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const p = await plain.boot();
  const across = sessionCookieOf(await p.post("/login", { token: OPERATOR }));
  await p.send({ path: "/runs", headers: { cookie: across, accept: "text/html" } });
  assert.equal(plain.shared.pageCtx.offer, false, "nor over plain HTTP across a network");
});

test("the sign-in page draws the Remember choice only where the console would remember this browser", async () => {
  const w = world();
  const c = await w.boot();
  assert.match((await c.send({ path: "/login" })).text, /name="remember"/);
  const plain = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  assert.doesNotMatch((await (await plain.boot()).send({ path: "/login" })).text, /name="remember"/, "a public bind over plain HTTP");
  const lan = world({ config: { allowedHosts: ["console.lan"] } });
  assert.doesNotMatch((await (await lan.boot()).send({ path: "/login", headers: { host: "console.lan" } })).text, /name="remember"/, "a proxy name over plain HTTP");
  const https = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1", "console.example"] }, consoleOrigin: "https://console.example" });
  assert.match((await (await https.boot()).send({ path: "/login", headers: { host: "console.example" } })).text, /name="remember"/, "an enrolled HTTPS origin");
});

test("someone else signing in on a remembered browser is told, on their first page, that it no longer remembers the other person", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  const sam = sessionCookieOf(await c.post("/login", { token: SECOND }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: sam, accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.notice, w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], [true, "idle", "This browser no longer remembers rob"]);
  const rob = (await remember(c)).cookie;
  const own = await c.post("/login", { token: OPERATOR }, { cookie: rob });
  assert.equal(own.json().remembered, true, "the same person on their own remembered browser");
  await c.send({ path: "/runs", headers: { cookie: rob, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.flash, null, "a person's own sign-in says nothing of the kind");
});

/** Preview then confirm an action as `cookie`, with the page's person, as the console's own page does. */
async function act(c, cookie, name, body, person) {
  const headers = { cookie, ...(person ? { "x-console-as": person } : {}) };
  const preview = await c.post(`/api/act/${name}/preview`, body, headers);
  if (preview.status !== 200) return { preview };
  const confirm = await c.post(`/api/act/${name}/confirm`, { ticket: preview.json().ticket }, headers);
  return { preview, confirm };
}

test("an operator removes one remembered browser, behind a preview, and it signs out at its next request", async () => {
  const w = world({ realTickets: true });
  const c = await w.boot();
  const ann = (await remember(c, VIEWER)).cookie;
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [{ id }] = c.trust.list().devices;
  const { preview, confirm } = await act(c, ops, "device-remove", { id }, "rob.operator");
  assert.equal(preview.status, 200, preview.text);
  assert.match(preview.json().summary[0], /^Stop remembering .+ for ann$/);
  assert.equal(preview.json().danger, true);
  assert.equal(confirm.status, 200, confirm.text);
  assert.equal(c.trust.list().devices[0].ended.reason, "removed");
  assert.deepEqual([(await whoami(c, ann)).status, (await whoami(c, ann)).json().ended], [401, "device"]);
  assert.ok(w.shared.rows.some((r) => r.action === "write" && r.kind === "device-remove" && r.target === id && r.outcome === "ok"));
  assert.equal((await act(c, ops, "device-remove", { id }, "rob.operator")).preview.status, 409, "nothing left to remove");
  assert.equal((await act(c, ops, "device-remove", { id: "../../etc" }, "rob.operator")).preview.status, 400);
});

test("a viewer and an agent can remove no browser and sign nobody out", async () => {
  const w = world({ realTickets: true });
  const c = await w.boot();
  await remember(c);
  const [{ id }] = c.trust.list().devices;
  const viewer = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  const agent = sessionCookieOf(await c.post("/login", { token: AGENT }));
  for (const [cookie, person] of [[viewer, "ann.viewer"], [agent, "bot.agent"]]) {
    assert.equal((await act(c, cookie, "device-remove", { id }, person)).preview.status, 403, person);
    assert.equal((await act(c, cookie, "sessions-end-all", {}, person)).preview.status, 403, person);
  }
  assert.equal(c.trust.list().devices[0].ended, undefined);
});

test("signing everyone out ends every session and remembered browser and every pending link, and needs no tokens file change", async () => {
  const w = world({ realTickets: true, hub: true });
  const c = await w.boot();
  const remembered = (await remember(c, VIEWER)).cookie;
  const other = sessionCookieOf(await c.post("/login", { token: SECOND }));
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const codes = join(w.shared.root, "console-login-codes");
  mintLoginCode({ dir: codes, name: "ann", fs, now: () => w.shared.t, binding: { sha256: sha(VIEWER), createdAt: "2026-10-01T00:00:00.000Z", role: "viewer", generation: 0 } });
  const generation = w.shared.file.generation;
  const { preview, confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
  assert.equal(preview.status, 200, preview.text);
  assert.match(preview.json().summary[1], /^3 sessions end now, 1 remembered browser is forgotten/);
  assert.equal(confirm.status, 200, confirm.text);
  for (const cookie of [remembered, other, ops]) {
    const res = await whoami(c, cookie);
    assert.equal(res.status, 401);
  }
  assert.equal((await whoami(c, other)).json().ended, "all");
  assert.equal(c.trust.list().devices[0].ended.reason, "all");
  assert.deepEqual(fs.readdirSync(codes).filter((n) => n.endsWith(".json")), [], "the invitation link is gone");
  assert.equal(w.shared.file.generation, generation, "the tokens file was not touched");
  assert.ok(w.shared.hubEnds.some(([, why]) => why === "all"), "open streams end, said why");
  assert.ok(w.shared.rows.some((r) => r.action === "write" && r.kind === "sessions-end-all" && r.outcome === "ok"));
});

test("signing everyone out is refused before anything is touched when the remembered browsers cannot be read", async () => {
  const w = world({ realTickets: true });
  const c = await w.boot();
  await remember(c);
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const dir = join(w.shared.root, "console-devices");
  fs.chmodSync(dir, 0o755);
  try {
    const { preview } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
    assert.equal(preview.status, 503, preview.text);
    assert.equal((await whoami(c, ops)).status, 200, "nobody was signed out");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("signing everyone out names a browser it could not forget, and still signs everyone else out", async () => {
  const w = world({ realTickets: true });
  const { cookie } = await remember(await w.boot(), VIEWER);
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [{ id }] = c.trust.list().devices;
  const { confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
  assert.equal(confirm.status, 409, confirm.text);
  assert.match(confirm.json().error, new RegExp(`Everyone else was signed out, but 1 remembered browser could not be forgotten \\(${id}\\)`));
  assert.equal((await whoami(c, ops)).status, 401);
  assert.equal((await whoami(c, cookie)).status, 401, "refused in memory all the same");
});

// Part 5, the adversary's round 1 (issue #849).

test("signing everyone out refuses a held browser whose record cannot be read, names it, and points to the host's command", async () => {
  const w = world({ realTickets: true });
  const c = await w.boot();
  const { cookie } = await remember(c, VIEWER);
  assert.equal((await whoami(c, cookie)).status, 200);
  const [{ hash, id }] = c.trust.list().devices;
  const path = join(w.shared.root, "console-devices", `${hash}.json`);
  const bytes = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, "{corrupt");
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const { preview, confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
  assert.match(preview.json().summary.join(" "), new RegExp(`1 remembered browser cannot be read now \\(${id}\\)`));
  assert.equal(confirm.status, 409, confirm.text);
  assert.match(confirm.json().error, new RegExp(`1 remembered browser could not be read \\(${id}\\).*pi-dispatch-console sessions end-all on the host`));
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  assert.equal((await whoami(c, cookie)).status, 401, "refused in this process once the record reads again");
});

test("signing everyone out keeps the truer word where the tokens file proves one", async () => {
  const w = world({ realTickets: true });
  const c = await w.boot();
  const ann = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  const annDevice = (await remember(c, VIEWER)).cookie;
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  w.shared.file.tokens = w.shared.file.tokens.filter((e) => e.name !== "ann");
  const { confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
  assert.equal(confirm.status, 200, confirm.text);
  assert.equal((await whoami(c, ann)).json().ended, "revoked");
  assert.equal(c.trust.list().devices[0].ended.reason, "revoked");
  assert.equal((await whoami(c, annDevice)).json().ended, "revoked");
});

test("a ticked box the console could not honour says so on the next page, and a full sign-in says what to do", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const res = await c.post("/login", { token: SECOND, remember: true });
  assert.deepEqual([res.status, res.json().remembered], [200, false]);
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(res), accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.notice, w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], [true, "attention", "This browser was not remembered"]);
  assert.match(w.shared.pageCtx.flash.body, /signed in for this session only/);
  assert.ok(cookie);
  // The most remembered browsers one sign-in may have: the person can do something about that, and is told what.
  const full = world();
  const f = await full.boot();
  for (let i = 0; i < 32; i++) assert.equal((await f.post("/login", { token: OPERATOR, remember: true })).json().remembered, true, `browser ${i + 1}`);
  const over = await f.post("/login", { token: OPERATOR, remember: true });
  assert.equal(over.json().remembered, false);
  await f.send({ path: "/runs", headers: { cookie: sessionCookieOf(over), accept: "text/html" } });
  assert.match(full.shared.pageCtx.flash.body, /already has 32 remembered browsers.*Remove one on Remembered browsers/);
  const later = sessionCookieOf(await f.post("/login", { token: OPERATOR }));
  const refused = await f.post("/api/device/remember", {}, { cookie: later });
  assert.deepEqual([refused.status, /already has 32 remembered browsers/.test(refused.text)], [409, true]);
});

test("the replaced browser's banner warns when its end could not be written", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const sam = sessionCookieOf(await c.post("/login", { token: SECOND }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: sam, accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], ["attention", "This browser may still remember rob"]);
});

test("the devices page tells a person to tick the box only where the sign-in page draws it", async () => {
  const draw = async (rememberable, session = {}) => String((await realPages.renderPage("devices", { data: { devices: { devices: [], unreadable: 0, unreadableIds: [] } }, query: {}, session: { name: "rob", role: "operator", remembered: null, ...session }, rememberable })).html);
  assert.match(await draw(true), /sign in again with Remember this trusted device ticked/);
  const here = await draw("transport");
  assert.doesNotMatch(here, /ticked/);
  assert.match(here, /cannot be from here/);
  assert.match(await draw("store"), /cannot use its store of remembered browsers/, "a store problem is doctor's, not the transport's");
  assert.match(await draw("windows"), /Windows host/);
  assert.match(await draw(true, { role: "viewer", invited: true }), /a sign-in from an invitation cannot be/);
});

test("a codes folder that cannot be listed is said to be unreadable, never counted", () => {
  const root = fs.realpathSync(tempDir("console-remembered-codes-"));
  const dir = join(root, "console-login-codes");
  mintLoginCode({ dir, name: "rob", fs, now: () => T0 });
  const unlistable = { ...fs, readdirSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  assert.deepEqual(clearLoginCodes({ dir, fs: unlistable }), { removed: 0, left: 0, unreadable: true });
});

// Part 5, the adversary's round 2 (issue #849).

test("signing everyone out tells each open tab the same word its next request reads", async () => {
  const w = world({ realTickets: true, hub: true });
  const c = await w.boot();
  const ann = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  const [, annId] = ann.split("=");
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [, opsId] = ops.split("=");
  w.shared.file.tokens = w.shared.file.tokens.filter((e) => e.name !== "ann");
  assert.equal((await act(c, ops, "sessions-end-all", {}, "rob.operator")).confirm.status, 200);
  assert.deepEqual(w.shared.hubEnds.filter(([id]) => id === annId).map(([, why]) => why), ["revoked"]);
  assert.deepEqual(w.shared.hubEnds.filter(([id]) => id === opsId).map(([, why]) => why), ["all"]);
});

test("past the in-memory limit, signing everyone out does not claim to refuse an unreadable browser", async () => {
  const w = world({ realTickets: true, denyMax: 0 });
  const c = await w.boot();
  const { cookie } = await remember(c, VIEWER);
  assert.equal((await whoami(c, cookie)).status, 200);
  const [{ hash }] = c.trust.list().devices;
  fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const { preview, confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
  assert.match(preview.json().summary.join(" "), /can refuse only those it holds a session for/);
  assert.match(confirm.json().error, /could not refuse them all in memory either/);
  assert.doesNotMatch(confirm.json().error, /refuses those it held/);
});

test("a sign-in that both replaces a browser it could not end and could not remember says both on one banner", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const sam = sessionCookieOf(await c.post("/login", { token: SECOND, remember: true }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: sam, accept: "text/html" } });
  const flash = w.shared.pageCtx.flash;
  assert.equal(flash.status, "attention");
  assert.equal(flash.summary, "This browser may still remember rob, and this browser was not remembered");
  assert.match(flash.body, /could not be ended.*signed in for this session only/);
});

test("a viewer at the most remembered browsers is told what she can do, not to press a Remove she does not have", async () => {
  const w = world();
  const c = await w.boot();
  for (let i = 0; i < 32; i++) assert.equal((await c.post("/login", { token: VIEWER, remember: true })).json().remembered, true);
  const over = await c.post("/login", { token: VIEWER, remember: true });
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(over), accept: "text/html" } });
  assert.match(w.shared.pageCtx.flash.body, /Sign out on one you no longer use, or ask an operator to remove one/);
  assert.doesNotMatch(w.shared.pageCtx.flash.body, /Remove one on Remembered browsers/);
  const later = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  assert.match((await c.post("/api/device/remember", {}, { cookie: later })).text, /ask an operator to remove one/);
});

// Part 5, the adversary's round 3 (issue #849).

test("on a read-only console the cap tells an operator to use the host's command, since the page draws no Remove there", async () => {
  const w = world({ config: { readOnly: true } });
  const c = await w.boot();
  for (let i = 0; i < 32; i++) assert.equal((await c.post("/login", { token: OPERATOR, remember: true })).json().remembered, true);
  const over = await c.post("/login", { token: OPERATOR, remember: true });
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(over), accept: "text/html" } });
  assert.match(w.shared.pageCtx.flash.body, /read-only.*pi-dispatch-console device revoke on the host/);
  assert.doesNotMatch(w.shared.pageCtx.flash.body, /Remove one on Remembered browsers/);
  const later = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  assert.match((await c.post("/api/device/remember", {}, { cookie: later })).text, /read-only.*device revoke on the host/);
});

test("signing in over a record that cannot be read says the browser may still remember someone else", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  const [{ hash, id }] = c.trust.list().devices;
  fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
  const sam = sessionCookieOf(await c.post("/login", { token: SECOND }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: sam, accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], ["attention", "This browser may still remember someone else"]);
  assert.match(w.shared.pageCtx.flash.body, new RegExp(`device revoke --id ${id}`));
});

test("an agent on Remembered browsers is told the page is people's, not operators'; the top bar marks a remembered browser for a phone too", async () => {
  const agent = String((await realPages.renderPage("devices", { data: {}, query: {}, session: { name: "bot", role: "agent", remembered: null } })).html);
  assert.match(agent, /This page is for people/);
  assert.doesNotMatch(agent, /for operators only/);
  const remembered = String((await realPages.renderPage("devices", { data: { devices: { devices: [], unreadable: 0, unreadableIds: [] } }, query: {}, session: { name: "rob", role: "operator", remembered: "3f9a1c0b7d2e" } })).html);
  assert.match(remembered, /class="who who--remembered"/, "the avatar's ring, which a phone shows where it hides the words");
});

test("signing in while the whole remembered-browser folder is unusable says the store could not be checked, never someone else", async (t) => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const dir = join(w.shared.root, "console-devices");
  fs.chmodSync(dir, 0o755);
  t.after(() => fs.chmodSync(dir, 0o700));
  const c = await w.boot();
  const again = sessionCookieOf(await c.post("/login", { token: OPERATOR }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: again, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.flash?.summary, "This browser's remembered sign-in could not be checked");
  assert.doesNotMatch(w.shared.pageCtx.flash.body, /someone else|--id/);
});

// Part 5, the spec audit's round 1 (issue #849): guarantees that had no test failing without them.

test("on a Windows host the sign-in page draws no Remember box, nothing is offered, and the devices page says why", async () => {
  const w = world({ platform: "win32" });
  const c = await w.boot();
  assert.doesNotMatch((await c.send({ path: "/login" })).text, /name="remember"/);
  const session = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  await c.send({ path: "/runs", headers: { cookie: session, accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.offer, w.shared.pageCtx.rememberable], [false, "windows"]);
});

test("a store problem draws no Remember box either, and pages are told it is the store's", async (t) => {
  const w = world();
  const c = await w.boot();
  await remember(c);
  const dir = join(w.shared.root, "console-devices");
  fs.chmodSync(dir, 0o755);
  t.after(() => fs.chmodSync(dir, 0o700));
  assert.doesNotMatch((await c.send({ path: "/login" })).text, /name="remember"/);
  const session = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  await c.send({ path: "/runs", headers: { cookie: session, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.rememberable, "store");
});

test("pages are told the transport's refusal and an invitation's sign-in, and a HEAD never takes the offer", async () => {
  const plain = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const p = await plain.boot();
  const across = sessionCookieOf(await p.post("/login", { token: OPERATOR }));
  await p.send({ path: "/runs", headers: { cookie: across, accept: "text/html" } });
  assert.equal(plain.shared.pageCtx.rememberable, "transport");
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["i".repeat(43), { name: "ann", binding: { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) } }]]);
  const invited = sessionCookieOf(await c.post("/login/code", { code: "i".repeat(43) }));
  await c.send({ path: "/runs", headers: { cookie: invited, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.session.invited, true);
  const fresh = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  await c.send({ method: "HEAD", path: "/runs", headers: { cookie: fresh, accept: "text/html" } });
  await c.send({ path: "/runs", headers: { cookie: fresh, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, true, "the HEAD left the offer for the page a person sees");
});

test("a remembered browser's refusal pages say remembered in the bar too", async () => {
  const w = world();
  const { cookie } = await remember(await w.boot());
  const c = await w.boot();
  const missing = await c.send({ path: "/nowhere", headers: { cookie, accept: "text/html" } });
  assert.equal(missing.status, 404);
  assert.match(missing.text, /Operator, remembered/);
  await whoami(c, cookie);
  const signedIn = await c.send({ path: "/nowhere", headers: { cookie, accept: "text/html" } });
  assert.match(signedIn.text, /Operator, remembered/);
});

test("the devices page lists live browsers only; an ended one the store keeps to say why is not drawn", async () => {
  const listed = { devices: [{ id: "3f9a1c0b7d2e", name: "rob", role: "operator", label: "Chrome on macOS", createdAt: "2026-10-01T09:00:00.000Z", lastUsedAt: "2026-10-20T09:00:00.000Z" }, { id: "0d4c2b1a9e8f", name: "rob", role: "operator", label: "Firefox on Linux", createdAt: "2026-10-01T09:00:00.000Z", lastUsedAt: "2026-10-02T09:00:00.000Z", ended: { reason: "signed-out", at: "2026-10-02T09:00:00.000Z" } }], unreadable: 0, unreadableIds: [] };
  const page = String((await realPages.renderPage("devices", { data: { devices: listed }, query: {}, session: { name: "rob", role: "operator", remembered: null } })).html);
  assert.match(page, /3f9a1c0b7d2e/);
  assert.doesNotMatch(page, /0d4c2b1a9e8f/);
});

test("signing everyone out names an unreadable browser no session holds, and refuses to report success", async () => {
  const w = world({ realTickets: true });
  const first = await w.boot();
  await remember(first, VIEWER);
  const [{ hash, id }] = first.trust.list().devices;
  fs.writeFileSync(join(w.shared.root, "console-devices", `${hash}.json`), "{corrupt");
  const c = await w.boot();
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const { confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
  assert.equal(confirm.status, 409, confirm.text);
  assert.match(confirm.json().error, new RegExp(`could not be read \\(${id}\\)`));
});

test("signing everyone out says so when sign-in links remain, the links folder cannot be read, or this console has none wired", async () => {
  const cases = [[{ clear: () => ({ removed: 1, left: 2 }) }, /2 sign-in links could not be removed/], [{ clear: () => ({ removed: 0, left: 0, unreadable: true }) }, /sign-in links folder could not be read/], [null, /sign-in links folder could not be read/]];
  for (const [loginCodes, said] of cases) {
    const w = world({ realTickets: true, loginCodes });
    const c = await w.boot();
    const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
    const { confirm } = await act(c, ops, "sessions-end-all", {}, "rob.operator");
    assert.equal(confirm.status, 409, confirm.text);
    assert.match(confirm.json().error, said);
  }
});

test("signing everyone out ends each session's tickets and setup state, and re-reads the store at the confirm", async () => {
  const w = world({ realTickets: true });
  const c = await w.boot();
  const ann = sessionCookieOf(await c.post("/login", { token: VIEWER }));
  const [, annId] = ann.split("=");
  await remember(c, VIEWER);
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [, opsId] = ops.split("=");
  assert.equal((await act(c, ops, "sessions-end-all", {}, "rob.operator")).confirm.status, 200);
  for (const id of [annId, opsId]) {
    assert.ok(w.shared.ticketEnds.includes(id), "tickets");
    assert.ok(w.shared.setupEnds.includes(id), "setup state");
  }
  const late = world({ realTickets: true });
  const l = await late.boot();
  await remember(l, VIEWER);
  const op2 = sessionCookieOf(await l.post("/login", { token: OPERATOR }));
  const preview = await l.post("/api/act/sessions-end-all/preview", {}, { cookie: op2, "x-console-as": "rob.operator" });
  assert.equal(preview.status, 200);
  const dir = join(late.shared.root, "console-devices");
  fs.chmodSync(dir, 0o755);
  try {
    const confirm = await l.post("/api/act/sessions-end-all/confirm", { ticket: preview.json().ticket }, { cookie: op2, "x-console-as": "rob.operator" });
    assert.equal(confirm.status, 409, confirm.text);
    assert.match(confirm.json().error, /nobody was signed out/);
    assert.equal((await whoami(l, op2)).status, 200);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("removing a browser whose end cannot be written says so instead of reporting success", async () => {
  const w = world({ realTickets: true });
  await remember(await w.boot(), VIEWER);
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const [{ id }] = c.trust.list().devices;
  const ops = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const { confirm } = await act(c, ops, "device-remove", { id }, "rob.operator");
  assert.equal(confirm.status, 409, confirm.text);
  assert.match(confirm.json().error, /could not be forgotten/);
});

// Part 5, the spec audit's round 2 (issue #849).

test("the same person signing in again after their token changed hears nothing about someone else", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c);
  w.shared.file.generation += 1;
  const again = sessionCookieOf(await c.post("/login", { token: OPERATOR }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: again, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.flash, null);
  assert.equal(c.trust.list().devices[0].ended.reason, "all", "the old record still ended, with its own word");
});

test("a refusal page reached by a signed-in remembered browser says remembered in the bar", async () => {
  const w = world();
  const c = await w.boot();
  const { cookie } = await remember(c, VIEWER);
  const refused = await c.send({ path: "/audit", headers: { cookie, accept: "text/html" } });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Viewer, remembered/);
});

test("the combined banner is a warning whenever either notice is, the warning second included", async () => {
  const w = world();
  const c = await w.boot();
  for (let i = 0; i < 32; i++) assert.equal((await c.post("/login", { token: SECOND, remember: true })).json().remembered, true);
  const { cookie } = await remember(c);
  const sam = sessionCookieOf(await c.post("/login", { token: SECOND, remember: true }, { cookie }));
  await c.send({ path: "/runs", headers: { cookie: sam, accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash.status, w.shared.pageCtx.flash.summary], ["attention", "This browser no longer remembers rob, and this browser was not remembered"]);
});

test("clearLoginCodes counts a link file it could not remove", () => {
  const root = fs.realpathSync(tempDir("console-remembered-codes-"));
  const dir = join(root, "console-login-codes");
  mintLoginCode({ dir, name: "rob", fs, now: () => T0 });
  const stuck = { ...fs, unlinkSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  assert.deepEqual(clearLoginCodes({ dir, fs: stuck }), { removed: 0, left: 1 });
});

// Part 6 (issue #849): a link for the person this browser is already signed in as keeps its session.

test("a one-time link for the person already signed in keeps that session; another person's or an invitation's replaces it", async () => {
  const w = world();
  const c = await w.boot();
  const rob = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  const [, robId] = rob.split("=");
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }], ["s".repeat(43), { name: "sam" }]]);
  const kept = await c.post("/login/code", { code: "r".repeat(43), next: "/runs" }, { cookie: rob });
  assert.deepEqual([kept.status, kept.json().kept, kept.json().next, kept.json().remembered], [200, true, "/runs", true]);
  // Issue #882: the kept session is remembered as a fresh one would be, by the remember route's own step: its device cookie in place of pdc_session.
  const device = deviceCookieOf(kept);
  assert.ok(device);
  assert.ok(pairsOf(kept).includes("pdc_session="), "one credential: the pdc_session is cleared");
  assert.equal((await whoami(c, device)).status, 200, "the same session carries on, by its device");
  assert.equal(c.sessions.endedOf(robId), null, "nothing ended");
  assert.ok(w.shared.rows.some((r) => r.action === "login-code" && r.kind === "link" && r.outcome === "ok" && /already signed in as this person/.test(r.reason ?? "")));
  assert.ok(w.shared.rows.some((r) => r.action === "device-remembered" && r.outcome === "ok"));
  const other = await c.post("/login/code", { code: "s".repeat(43) }, { cookie: device });
  assert.equal(other.json().kept, undefined);
  assert.ok(deviceCookieOf(other) && deviceCookieOf(other) !== device, "someone else's link is a new sign-in, remembered for them");
  assert.equal((await whoami(c, device)).status, 401, "and rob's remembered browser ended, as for any other person signing in on it");
  assert.ok(w.shared.rows.some((r) => r.action === "device-ended" && r.reason === "another person signed in on this browser"));
});

test("a session near the end of its longest life is replaced by a same-person link rather than kept", async () => {
  const w = world();
  const c = await w.boot();
  const rob = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  // Kept busy every half hour, so it is the longest life that runs out, never the idle limit.
  for (let i = 0; i < 23; i++) {
    w.advance(30 * 60000);
    assert.equal((await whoami(c, rob)).status, 200, `still signed in after ${(i + 1) / 2} hours`);
  }
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const fresh = await c.post("/login/code", { code: "r".repeat(43) }, { cookie: rob });
  assert.equal(fresh.json().kept, undefined, "half an hour left: a new session");
  assert.ok(deviceCookieOf(fresh), "remembered, as a link's sign-in is (issue #882)");
});

test("an invited or a remembered session is never kept by a link, and an invitation's link is a sign-in of its own", async () => {
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["i".repeat(43), { name: "ann", binding: { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) } }], ["a".repeat(43), { name: "ann" }], ["j".repeat(43), { name: "ann", binding: { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) } }]]);
  const invited = sessionCookieOf(await c.post("/login/code", { code: "i".repeat(43) }));
  const over = await c.post("/login/code", { code: "a".repeat(43) }, { cookie: invited });
  assert.equal(over.json().kept, undefined, "an invited session is never kept");
  const plain = sessionCookieOf(over);
  const invitation = await c.post("/login/code", { code: "j".repeat(43) }, { cookie: plain });
  assert.equal(invitation.json().kept, undefined, "an invitation's link binds a session of its own kind");
  const remembered = (await remember(c)).cookie;
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const linked = await c.post("/login/code", { code: "r".repeat(43) }, { cookie: remembered });
  assert.equal(linked.json().kept, undefined, "a remembered browser's own path keeps its device, not this one");
});

test("on a console set to a one-hour session life, a fresh session is still kept by a same-person link", async () => {
  const w = world({ config: { maxMs: HOUR } });
  const c = await w.boot();
  const rob = sessionCookieOf(await c.post("/login", { token: OPERATOR }));
  w.advance(60000);
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const kept = await c.post("/login/code", { code: "r".repeat(43) }, { cookie: rob });
  assert.equal(kept.json().kept, true, "a quarter of an hour's life is the threshold here");
});

// ---- issue #882: a sign-in with a credential the host made remembers the browser without asking ----

test("a one-time link remembers the browser at once, through a restart, and is never offered it again", async () => {
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const res = await c.post("/login/code", { code: "r".repeat(43) });
  assert.deepEqual([res.status, res.json().remembered], [200, true]);
  const cookie = deviceCookieOf(res);
  assert.ok(cookie, "the device cookie, at once");
  assert.equal(sessionCookieOf(res), null, "and no pdc_session: one credential");
  assert.deepEqual(w.shared.rows.map((r) => [r.action, r.kind ?? null]), [["login-code", "link"], ["device-remembered", null]], "the sign-in's row says which kind of code, then the device's");
  await c.send({ path: "/runs", headers: { cookie, accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, false, "nothing to offer: it is remembered");
  const after = await w.boot();
  assert.equal((await whoami(after, cookie)).json().name, "rob", "a console restart keeps it signed in");
});

test("a typed short code remembers the browser too, on its own route, and its row says short-code", async () => {
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["k7qx-9m2d", { name: "ann" }]]);
  const res = await c.post("/login/typed-code", { code: "k7qx-9m2d", next: "/runs" });
  assert.deepEqual([res.status, res.json().remembered, res.json().next], [200, true, "/runs"]);
  assert.ok(deviceCookieOf(res));
  assert.deepEqual(c.trust.list().devices.map((d) => [d.name, d.role]), [["ann", "viewer"]], "a viewer's own code remembers her browser, as her token's box would");
  const row = w.shared.rows.find((r) => r.action === "login-code");
  assert.deepEqual([row.kind, row.outcome], ["short-code", "ok"]);
  w.shared.codes = new Map(); // spent: this harness's code store is a plain map
  const refused = await c.post("/login/typed-code", { code: "k7qx-9m2d" });
  assert.deepEqual([refused.status, refused.json().link], [401, "used"]);
  assert.match(refused.json().error, /^that sign-in code is used, expired or unknown/);
  assert.deepEqual(Object.fromEntries(["target", "kind", "outcome"].map((k) => [k, w.shared.rows.at(-1)[k]])), { target: "/login/typed-code", kind: "short-code", outcome: "refused" });
  assert.ok(!JSON.stringify(w.shared.rows).includes("k7qx") && !JSON.stringify(w.shared.rows).toLowerCase().includes("k7qx9m2d"), "no row holds the code");
});

test("a host-made code remembers nothing where remembering is not allowed: an agent, an invitation, plain HTTP across a network, a Windows host", async () => {
  const invitation = { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) };
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["b".repeat(43), { name: "bot" }], ["i".repeat(43), { name: "ann", binding: invitation }]]);
  for (const code of ["b".repeat(43), "i".repeat(43)]) {
    const res = await c.post("/login/code", { code });
    assert.equal(res.status, 200, code);
    assert.equal(deviceCookieOf(res), null, code);
    assert.ok(sessionCookieOf(res), code);
    assert.equal(res.json().remembered, undefined, `${code}: nothing was tried, so nothing is said`);
    await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(res), accept: "text/html" } });
    assert.equal(w.shared.pageCtx.offer, false, `${code}: and nothing is offered`);
  }
  assert.deepEqual(c.trust.list().devices, []);
  const plain = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const p = await plain.boot();
  plain.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const across = await p.post("/login/code", { code: "r".repeat(43) });
  assert.deepEqual([across.status, deviceCookieOf(across), Boolean(sessionCookieOf(across))], [200, null, true], "plain HTTP across a network carries no remembered cookie");
  const windows = world({ platform: "win32" });
  const win = await windows.boot();
  windows.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const there = await win.post("/login/code", { code: "r".repeat(43) });
  assert.deepEqual([there.status, deviceCookieOf(there)], [200, null]);
});

test("a host-made code the store cannot remember still signs in, and the next page says so", async () => {
  const w = world();
  await w.boot();
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const res = await c.post("/login/code", { code: "r".repeat(43) });
  assert.deepEqual([res.status, res.json().remembered], [200, false]);
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(res), accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], ["attention", "This browser was not remembered"]);
  assert.match(w.shared.pageCtx.flash.body, /signed in for this session only/);
});

test("a token sign-in still remembers only when its box is ticked, and is offered once when it is not", async () => {
  const w = world();
  const c = await w.boot();
  const plain = await c.post("/login", { token: OPERATOR });
  assert.deepEqual([deviceCookieOf(plain), plain.json().remembered], [null, undefined], "a token is not a host-made credential: the box decides");
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(plain), accept: "text/html" } });
  assert.equal(w.shared.pageCtx.offer, true);
  assert.ok((await remember(c)).cookie);
});

test("the sign-in page's Remember box starts ticked", async () => {
  const w = world();
  const c = await w.boot();
  assert.match((await c.send({ path: "/login" })).text, /<input type="checkbox" name="remember" checked>/);
});

// ---- issue #882, review: the kept session's remember step, the cap, and the routes ----

/** A live ordinary session for `token`, and a link for the same person, posted with it: the kept path. */
async function keptLink(c, w, token = OPERATOR, name = "rob") {
  const held = sessionCookieOf(await c.post("/login", { token }));
  w.shared.codes = new Map([["r".repeat(43), { name }]]);
  return { held, res: await c.post("/login/code", { code: "r".repeat(43) }, { cookie: held }) };
}

test("a kept session is not remembered over plain HTTP across a network, and keeps its own cookie", async () => {
  const w = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1"] } });
  const c = await w.boot();
  const { held, res } = await keptLink(c, w);
  assert.deepEqual([res.status, res.json().kept, res.json().remembered, res.headers["set-cookie"]], [200, true, undefined, undefined]);
  assert.equal((await whoami(c, held)).status, 200, "the same pdc_session carries on");
  assert.equal(c.trust.list().devices.length, 0);
});

test("an agent's kept session is not remembered", async () => {
  const w = world();
  const c = await w.boot();
  const { held, res } = await keptLink(c, w, AGENT, "bot");
  assert.deepEqual([res.status, res.json().kept, res.json().remembered, res.headers["set-cookie"]], [200, true, undefined, undefined]);
  assert.equal((await whoami(c, held)).status, 200);
  assert.equal(c.trust.list().devices.length, 0);
});

test("a kept session under an enrolled HTTPS origin is remembered with a Secure device cookie", async () => {
  const w = world({ config: { listen: { kind: "tcp", host: "0.0.0.0", port: 0 }, allowedHosts: ["127.0.0.1", "console.example"] }, consoleOrigin: "https://console.example" });
  const c = await w.boot();
  const held = sessionCookieOf(await c.post("/login", { token: OPERATOR }, { host: "console.example" }));
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const res = await c.post("/login/code", { code: "r".repeat(43) }, { host: "console.example", cookie: held });
  assert.deepEqual([res.status, res.json().kept, res.json().remembered], [200, true, true]);
  const device = res.headers["set-cookie"].find((x) => x.startsWith("pdc_device_"));
  assert.match(device, /; Secure/);
  assert.ok(res.headers["set-cookie"].some((x) => x.startsWith("pdc_session=;")), "and the old pdc_session cleared");
});

test("a kept session whose store refuses is told on its next page, and keeps its pdc_session", async () => {
  const w = world();
  await w.boot();
  w.shared.fsOverride = unwritable();
  const c = await w.boot();
  const { held, res } = await keptLink(c, w);
  assert.deepEqual([res.status, res.json().kept, res.json().remembered, res.headers["set-cookie"]], [200, true, false, undefined]);
  await c.send({ path: "/runs", headers: { cookie: held, accept: "text/html" } });
  assert.deepEqual([w.shared.pageCtx.flash?.status, w.shared.pageCtx.flash?.summary], ["attention", "This browser was not remembered"]);
  assert.match(w.shared.pageCtx.flash.body, /signed in for this session only/);
});

test("at the cap, a host-made sign-in forgets the least recently used browser of that person, on the record, and is remembered", async () => {
  const w = world();
  const c = await w.boot();
  const cookies = [];
  for (let i = 0; i < 32; i++) cookies.push((await remember(c)).cookie);
  // Last use is each record's mtime: set by hand, so the one least recently used is known and the clock is the test's.
  const hashes = cookies.map((cookie) => c.trust.hashOf(cookie.split("=")[1]));
  const setUse = (hash, ms) => fs.utimesSync(join(c.trust.dir, `${hash}.json`), ms / 1000, ms / 1000);
  hashes.forEach((hash, i) => setUse(hash, T0 - (i + 1) * HOUR));
  setUse(hashes[7], T0 - 40 * 24 * HOUR);
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const res = await c.post("/login/code", { code: "r".repeat(43) });
  assert.deepEqual([res.status, res.json().remembered], [200, true]);
  assert.ok(deviceCookieOf(res));
  const after = c.trust.list().devices;
  assert.equal(after.filter((d) => !d.ended).length, 32, "still 32: one in, one out");
  const ended = after.filter((d) => d.ended);
  assert.deepEqual(ended.map((d) => [d.hash, d.ended.reason]), [[hashes[7], "removed"]], "the least recently used one, as removed");
  const row = w.shared.rows.find((r) => r.action === "device-ended");
  assert.deepEqual([row.actor.name, row.target, row.outcome], ["rob", ended[0].id, "ok"]);
  assert.match(row.reason, /least recently used of the 32 browsers one sign-in may remember/);
  const gone = await whoami(c, cookies[7]);
  assert.deepEqual([gone.status, gone.json().ended], [401, "device"], "that browser is signed out at its next request, and told why");
  assert.equal((await whoami(c, cookies[0])).status, 200, "the others stay");
});

test("at the cap, a token's ticked box still says the browser was not remembered, with what to do", async () => {
  const w = world();
  const c = await w.boot();
  for (let i = 0; i < 32; i++) await remember(c);
  const over = await c.post("/login", { token: OPERATOR, remember: true });
  assert.equal(over.json().remembered, false);
  await c.send({ path: "/runs", headers: { cookie: sessionCookieOf(over), accept: "text/html" } });
  assert.match(w.shared.pageCtx.flash.body, /already has 32 remembered browsers.*Remove one on Remembered browsers/);
  assert.equal(c.trust.list().devices.filter((d) => d.ended).length, 0, "nothing forgotten for a box: the person can choose which to remove");
});

test("/login/code takes a typed short code too, as /login/typed-code takes a link's code: one handler, one rule", async () => {
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["K7QX-9M2D", { name: "ann" }], ["q".repeat(43), { name: "rob" }]]);
  const short = await c.post("/login/code", { code: "K7QX-9M2D" });
  assert.deepEqual([short.status, short.json().remembered], [200, true]);
  assert.equal(w.shared.rows.find((r) => r.action === "login-code").kind, "short-code");
  const link = await c.post("/login/typed-code", { code: "q".repeat(43) });
  assert.equal(link.status, 200);
  assert.equal(w.shared.rows.filter((r) => r.action === "login-code").at(-1).kind, "link");
  for (const odd of ["K7QX-9M2", "q".repeat(42), "<script>"]) {
    const res = await c.post("/login/code", { code: odd });
    assert.equal(res.status, 401, odd);
    assert.equal(w.shared.rows.at(-1).kind, undefined, `${odd}: a code of neither shape names no kind`);
  }
});

test("a viewer invitation is no host-made sign-in: never remembered, never offered, nothing forgotten for it", async () => {
  const w = world();
  const c = await w.boot();
  w.shared.codes = new Map([["i".repeat(43), { name: "ann", binding: { createdAt: "2026-10-01T00:00:00.000Z", generation: 0, role: "viewer", sha256: sha(VIEWER) } }]]);
  const res = await c.post("/login/code", { code: "i".repeat(43) });
  assert.deepEqual([res.status, deviceCookieOf(res), res.json().remembered], [200, null, undefined]);
  assert.ok(!w.shared.rows.some((r) => r.action === "device-remembered"));
});

test("a browser at pi-dispatch.localhost is remembered as at localhost, under its own name's cookie (issue #882)", async () => {
  const w = world();
  const c = await w.boot();
  const host = `pi-dispatch.localhost:${c.server.address().port}`;
  w.shared.codes = new Map([["r".repeat(43), { name: "rob" }]]);
  const res = await c.post("/login/code", { code: "r".repeat(43) }, { host, origin: `http://${host}` });
  assert.deepEqual([res.status, res.json().remembered], [200, true]);
  const cookie = deviceCookieOf(res);
  assert.ok(cookie);
  assert.doesNotMatch(res.headers["set-cookie"].join("\n"), /Domain=/i, "host-only: the browser keeps it for pi-dispatch.localhost alone");
  assert.equal((await c.send({ path: "/api/whoami", headers: { host, cookie } })).status, 200);
  assert.match((await c.send({ path: "/login", headers: { host } })).text, /name="remember" checked/, "the box is drawn there too");
});
