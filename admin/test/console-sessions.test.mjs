import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { COOKIE_NAME, clearSessionCookie, makeSessionStore, readSessionCookie, sessionCookie, sessionDigest } from "../src/console/sessions.mjs";

// The console's in-memory sessions (issue #640). Every expiry is judged on an injected clock.
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60000;

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}
function counter(start = 1) {
  let n = start;
  return (size) => Buffer.alloc(size, n++);
}
const H = (c) => c.repeat(64);
function tokensFile(tokens, generation = 0) {
  return { version: 1, generation, tokens: tokens.map(([name, role, sha256]) => ({ name, role, sha256, createdAt: "2026-10-01T00:00:00.000Z" })) };
}
const FILE = tokensFile([["rob", "operator", H("a")], ["view", "viewer", H("b")]]);

function store(now = clock(), opts = {}) {
  return makeSessionStore({ now, random: counter(), idleMs: 60 * MIN, maxMs: 12 * 60 * MIN, maxStreams: 2, ...opts });
}

test("create issues a fresh 43-character id per login, and get returns the session with its fields", () => {
  const now = clock();
  const s = store(now);
  const a = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const b = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  assert.match(a.id, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.id, b.id, "a new id every login, so no fixation");
  assert.deepEqual(s.get(a.id, FILE), { id: a.id, name: "rob", role: "operator", tokenHash: H("a"), generation: 0, createdAt: T0, lastSeen: T0 });
  assert.equal(s.size(), 2);
  const real = makeSessionStore();
  assert.match(real.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id, /^[A-Za-z0-9_-]{43}$/);
});

test("get returns null for an unknown, a malformed or a missing id", () => {
  const s = store();
  s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  assert.equal(s.get("x".repeat(43), FILE), null);
  assert.equal(s.get(undefined, FILE), null);
  assert.equal(s.get(null, FILE), null);
  assert.equal(s.get(42, FILE), null);
});

test("an idle session expires after idleMs without a request, and each request moves lastSeen forward", () => {
  const now = clock();
  const s = store(now);
  const { id } = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  now.advance(59 * MIN);
  assert.equal(s.get(id, FILE).lastSeen, T0 + 59 * MIN);
  now.advance(60 * MIN);
  assert.ok(s.get(id, FILE), "exactly idleMs since the last request is still live");
  now.advance(60 * MIN + 1);
  assert.equal(s.get(id, FILE), null);
  assert.equal(s.size(), 0, "an expired session is deleted, not only refused");
});

test("a busy session still ends at maxMs after its creation", () => {
  const now = clock();
  const s = store(now);
  const { id } = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  for (let i = 0; i < 24; i++) {
    now.advance(30 * MIN);
    assert.ok(s.get(id, FILE), `still live at ${(i + 1) * 30} minutes`);
  }
  now.advance(1);
  assert.equal(s.get(id, FILE), null);
});

test("a bumped generation ends every session, and editing it back does not revive them", () => {
  const s = store();
  const a = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const b = s.create({ name: "view", role: "viewer", tokenHash: H("b"), generation: 0 });
  const bumped = { ...FILE, generation: 1 };
  assert.equal(s.get(a.id, bumped), null);
  assert.equal(s.get(b.id, bumped), null);
  assert.equal(s.get(a.id, FILE), null, "deleted on the failed check");
  assert.equal(s.size(), 0);
});

test("a revoked or rotated token ends its sessions and leaves the others alone", () => {
  const s = store();
  const rob = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const view = s.create({ name: "view", role: "viewer", tokenHash: H("b"), generation: 0 });
  const revoked = tokensFile([["view", "viewer", H("b")]]);
  assert.equal(s.get(rob.id, revoked), null);
  assert.ok(s.get(view.id, revoked));
  const rotated = tokensFile([["view", "viewer", H("c")]]);
  assert.equal(s.get(view.id, rotated), null);
  assert.equal(s.get(view.id, FILE), null, "rotating back does not revive it");
});

test("a role change on the token ends the session, in both directions", () => {
  const s = store();
  const rob = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const view = s.create({ name: "view", role: "viewer", tokenHash: H("b"), generation: 0 });
  const swapped = tokensFile([["rob", "viewer", H("a")], ["view", "operator", H("b")]]);
  assert.equal(s.get(rob.id, swapped), null);
  assert.equal(s.get(view.id, swapped), null);
});

test("a missing or malformed tokens file ends the session rather than letting it through", () => {
  const s = store();
  const ids = [0, 1, 2].map(() => s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id);
  assert.equal(s.get(ids[0], null), null);
  assert.equal(s.get(ids[1], { generation: 0 }), null);
  assert.equal(s.get(ids[2], { generation: "0", tokens: FILE.tokens }), null);
});

test("destroy ends a session, and size forgets the expired ones", () => {
  const now = clock();
  const s = store(now);
  const a = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  s.destroy(a.id);
  assert.equal(s.get(a.id, FILE), null);
  s.destroy("never-was");
  s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  assert.equal(s.size(), 1);
  now.advance(61 * MIN);
  assert.equal(s.size(), 0);
});

test("create forgets expired sessions, so abandoned browsers do not accumulate", () => {
  const now = clock();
  const s = store(now);
  for (let i = 0; i < 5; i++) s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  now.advance(61 * MIN);
  const fresh = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  assert.equal(s.size(), 1);
  assert.ok(s.get(fresh.id, FILE));
});

test("streamAcquire caps live streams per session at maxStreams; release frees a slot; a gone session gets none", () => {
  const s = store();
  const a = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const b = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  assert.equal(s.streamAcquire(a.id), true);
  assert.equal(s.streamAcquire(a.id), true);
  assert.equal(s.streamAcquire(a.id), false);
  assert.equal(s.streamAcquire(b.id), true, "the cap is per session");
  s.streamRelease(a.id);
  assert.equal(s.streamAcquire(a.id), true);
  s.streamRelease(b.id);
  s.streamRelease(b.id);
  s.streamRelease(b.id);
  assert.equal(s.streamAcquire(b.id), true);
  assert.equal(s.streamAcquire(b.id), true);
  assert.equal(s.streamAcquire(b.id), false, "extra releases never push the count below zero");
  assert.equal(s.streamAcquire("unknown"), false);
  s.destroy(a.id);
  assert.equal(s.streamAcquire(a.id), false);
});

test("sessionCookie sets HttpOnly, SameSite=Strict and Path=/, and refuses an id that could split the header", () => {
  const id = Buffer.alloc(32, 9).toString("base64url");
  assert.equal(COOKIE_NAME, "pdc_session");
  assert.equal(sessionCookie(id, { maxAgeSec: 43200 }), `pdc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
  assert.equal(sessionCookie(id), `pdc_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
  assert.equal(sessionCookie(id, { maxAgeSec: 0 }), `pdc_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
  assert.throws(() => sessionCookie(`${id.slice(0, 40)}; a`), /43 base64url/);
  assert.throws(() => sessionCookie(undefined), /43 base64url/);
  assert.equal(clearSessionCookie(), "pdc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
});

test("readSessionCookie takes only an exact-name, well-formed, single pdc_session cookie", () => {
  const id = Buffer.alloc(32, 9).toString("base64url");
  const other = Buffer.alloc(32, 8).toString("base64url");
  assert.equal(readSessionCookie(`pdc_session=${id}`), id);
  assert.equal(readSessionCookie(`theme=dark; pdc_session=${id}; lang=nl`), id, "other cookies are ignored");
  assert.equal(readSessionCookie(`theme=dark;pdc_session=${id}`), id);
  assert.equal(readSessionCookie(["a=1", `pdc_session=${id}`]), id);
  assert.equal(readSessionCookie(`xpdc_session=${id}`), null, "a name that only ends with it does not count");
  assert.equal(readSessionCookie(`pdc_session2=${id}`), null);
  assert.equal(readSessionCookie(`PDC_SESSION=${id}`), null);
  assert.equal(readSessionCookie(`pdc_session=${id}; pdc_session=${other}`), null, "two candidates: neither is trusted");
  assert.equal(readSessionCookie(`pdc_session=${id}x`), null);
  assert.equal(readSessionCookie(`pdc_session=${id.slice(1)}`), null);
  assert.equal(readSessionCookie(`pdc_session="${id}"`), null);
  assert.equal(readSessionCookie("pdc_session="), null);
  assert.equal(readSessionCookie("pdc_session"), null);
  assert.equal(readSessionCookie(";;=;"), null);
  assert.equal(readSessionCookie(""), null);
  assert.equal(readSessionCookie(undefined), null);
});

test("sessionDigest is the first 12 hex of the id's SHA-256, never the id", () => {
  const id = Buffer.alloc(32, 9).toString("base64url");
  assert.equal(sessionDigest(id), createHash("sha256").update(id).digest("hex").slice(0, 12));
  assert.match(sessionDigest(id), /^[0-9a-f]{12}$/);
  assert.notEqual(sessionDigest(id), sessionDigest(Buffer.alloc(32, 8).toString("base64url")));
});
