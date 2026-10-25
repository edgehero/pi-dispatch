import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { COOKIE_NAME, FLASH_MAX_BYTES, TOMBSTONE_MAX, clearSessionCookie, makeSessionStore, readSessionCookie, readSessionCookies, sessionCookie, sessionDigest } from "../src/console/sessions.mjs";

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

test("a missing or malformed tokens file lets no session through, and an unusable one ends none (issue #737: a chmod mistake signs nobody out)", () => {
  const s = store();
  const ids = [0, 1, 2].map(() => s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id);
  for (const unusable of [null, undefined, {}, { generation: 0 }, { generation: 0, tokens: "x" }, { generation: 0, tokens: { 0: FILE.tokens[0] } }]) {
    assert.equal(s.get(ids[0], unusable), null, JSON.stringify(unusable));
    assert.equal(s.endedOf(ids[0]), null, "no tombstone: it did not end");
  }
  assert.ok(s.get(ids[0], FILE), "kept: the next usable file judges it as before");
  assert.equal(s.get(ids[1], { generation: 0 }), null);
  assert.ok(s.peek(ids[1], FILE));
  // A file WITH a tokens array judges, and a generation of another type is another generation.
  assert.equal(s.get(ids[2], { generation: "0", tokens: FILE.tokens }), null);
  assert.equal(s.endedOf(ids[2]), "all");
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

test("streamAcquire caps live streams per token at maxStreams; release frees a slot; a gone session gets none", () => {
  const s = store();
  const a = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const b = s.create({ name: "vic", role: "viewer", tokenHash: H("b"), generation: 0 });
  assert.equal(s.streamAcquire(a.id), true);
  assert.equal(s.streamAcquire(a.id), true);
  assert.equal(s.streamAcquire(a.id), false);
  assert.equal(s.streamAcquire(b.id), true, "another token has its own budget");
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

test("every session of one token shares its maxStreams budget; an ended session's streams hold their slots until they close", () => {
  const s = store();
  const sessions = Array.from({ length: 4 }, () => s.create({ name: "vic", role: "viewer", tokenHash: H("b"), generation: 0 }));
  assert.equal(s.streamAcquire(sessions[0].id), true);
  assert.equal(s.streamAcquire(sessions[1].id), true);
  for (const x of sessions) assert.equal(s.streamAcquire(x.id), false, "signing in again buys no more streams");
  s.destroy(sessions[0].id);
  assert.equal(s.streamAcquire(sessions[2].id), false, "the ended session's stream is still open, so its slot is still taken");
  s.streamRelease(sessions[0].id);
  assert.equal(s.streamAcquire(sessions[2].id), true, "its close gives the token's slot back");
  s.streamRelease(sessions[0].id);
  assert.equal(s.streamAcquire(sessions[3].id), false, "an extra release of a closed session frees nothing");
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

test("readSessionCookies (a sign-out's, issue #737): every well-formed pdc_session value, each once, in order; nothing else", () => {
  const id = Buffer.alloc(32, 9).toString("base64url");
  const other = Buffer.alloc(32, 8).toString("base64url");
  assert.deepEqual(readSessionCookies(`pdc_session=${id}`), [id]);
  assert.deepEqual(readSessionCookies(`pdc_session=${other}; theme=dark; pdc_session=${id}`), [other, id], "both, where readSessionCookie trusts neither");
  assert.equal(readSessionCookie(`pdc_session=${other}; pdc_session=${id}`), null);
  assert.deepEqual(readSessionCookies(`pdc_session=${id}; pdc_session=${id}`), [id], "a repeated id once");
  assert.deepEqual(readSessionCookies(["a=1", `pdc_session=${id}`, `pdc_session=${other}`]), [id, other]);
  assert.deepEqual(readSessionCookies(`pdc_session=short; pdc_session=${id}x; xpdc_session=${other}; pdc_session2=${other}; PDC_SESSION=${other}; pdc_session=${id}`), [id], "a malformed value or another name is not one");
  for (const none of ["", undefined, null, "pdc_session=", "pdc_session", ";;=;", 7]) assert.deepEqual(readSessionCookies(none), [], String(none));
});

test("sessionDigest is the first 12 hex of the id's SHA-256, never the id", () => {
  const id = Buffer.alloc(32, 9).toString("base64url");
  assert.equal(sessionDigest(id), createHash("sha256").update(id).digest("hex").slice(0, 12));
  assert.match(sessionDigest(id), /^[0-9a-f]{12}$/);
  assert.notEqual(sessionDigest(id), sessionDigest(Buffer.alloc(32, 8).toString("base64url")));
});

test("peek applies every check get does (unknown, idle, max age, generation, revoked hash, changed role) and returns a copy", () => {
  const now = clock();
  const s = store(now);
  const { id } = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  const copy = s.peek(id, FILE);
  assert.deepEqual(copy, { id, name: "rob", role: "operator", tokenHash: H("a"), generation: 0, createdAt: T0, lastSeen: T0 });
  copy.role = "viewer";
  assert.equal(s.peek(id, FILE).role, "operator", "a copy, not the stored session");
  assert.equal(s.peek("x".repeat(43), FILE), null);
  assert.equal(s.peek(undefined, FILE), null);
  assert.equal(s.peek(id, tokensFile([["rob", "operator", H("a")]], 1)), null, "another generation");
  assert.equal(s.peek(id, tokensFile([["rob", "operator", H("c")]])), null, "revoked or rotated");
  assert.equal(s.peek(id, tokensFile([["rob", "viewer", H("a")]])), null, "a role change");
  assert.equal(s.peek(id, null), null, "no usable file");
  assert.ok(s.peek(id, FILE), "and none of those refusals deleted it");
  const busy = store(now);
  const b = busy.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  now.advance(11 * 60 * MIN);
  busy.get(b.id, FILE);
  now.advance(60 * MIN + 1);
  assert.equal(busy.peek(b.id, FILE), null, "older than maxMs, however busy");
});

test("peek never moves lastSeen: a session only peeked for longer than idleMs is over at the next get", () => {
  const now = clock();
  const s = store(now);
  const { id } = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  for (let i = 0; i < 60; i += 1) {
    now.advance(MIN);
    assert.ok(s.peek(id, FILE), `minute ${i + 1}: still within idleMs of the last request`);
    assert.equal(s.peek(id, FILE).lastSeen, T0, "unchanged");
  }
  now.advance(1);
  assert.equal(s.peek(id, FILE), null, "an hour and a millisecond of peeks is still an hour idle");
  assert.equal(s.size(), 0, "and the next sweep forgets it");
  assert.equal(s.get(id, FILE), null);
});

test("peek does not delete a failing session: it is gone at the next get, not before, and a streamed session keeps its slots until then", () => {
  const s = store();
  const { id } = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 });
  assert.equal(s.streamAcquire(id), true);
  assert.equal(s.peek(id, tokensFile([["rob", "operator", H("c")]])), null);
  assert.ok(s.peek(id, FILE), "peek left it in place");
  assert.equal(s.get(id, tokensFile([["rob", "operator", H("c")]])), null);
  assert.equal(s.peek(id, FILE), null, "get deleted it");
  assert.equal(s.streamAcquire(id), false);
});

// ---- why a session ended (issues #737 and #711): reasons, tombstones, endedOf, verdict and the flash ----

const ID_OF = (n) => Buffer.alloc(32, n).toString("base64url");
const signIn = (s, name = "rob", role = "operator", hash = H("a"), generation = 0) => s.create({ name, role, tokenHash: hash, generation }).id;

test("TOMBSTONE_MAX and FLASH_MAX_BYTES are the figures their docblocks state", () => {
  assert.equal(TOMBSTONE_MAX, 1024);
  assert.equal(FLASH_MAX_BYTES, 16384);
});

test("get ends a failing session with the reason, judged idle, then max, then all, then role, then revoked", () => {
  const now = clock();
  // One store per case, so each judges a single fresh session.
  const ended = (fileOf, touches = 0, wait = 0) => {
    const s = store(now);
    const id = signIn(s);
    for (let i = 0; i < touches; i += 1) {
      now.advance(30 * MIN);
      assert.ok(s.get(id, FILE), `touch ${i + 1}`);
    }
    now.advance(wait);
    assert.equal(s.get(id, fileOf), null);
    assert.equal(s.peek(id, FILE), null, "deleted");
    return s.endedOf(id);
  };
  // Idle past its limit AND past its longest life, another generation, its token gone: idle is the first check.
  assert.equal(ended(tokensFile([], 1), 22, 61 * MIN), "idle");
  // Kept busy (a request every half hour) to exactly maxMs, then a millisecond: past max, another generation and its
  // token gone, but not idle; max is next.
  assert.equal(ended(tokensFile([], 1), 24, 1), "max");
  // Within both limits: another generation outranks a changed role and a revoked token.
  assert.equal(ended(tokensFile([["rob", "viewer", H("a")]], 1)), "all");
  assert.equal(ended(tokensFile([], 1)), "all");
  // The same generation: its hash with another role is a role change; no entry with its hash at all is a revocation.
  assert.equal(ended(tokensFile([["rob", "viewer", H("a")], ["x", "operator", H("c")]])), "role");
  assert.equal(ended(tokensFile([["rob", "operator", H("c")]])), "revoked");
  assert.equal(ended(tokensFile([])), "revoked");
});

test("a token entry with the session's hash AND role passes, whatever other entries with that hash say", () => {
  const s = store();
  const id = signIn(s);
  const both = tokensFile([["rob", "viewer", H("a")], ["rob", "operator", H("a")]]);
  assert.ok(s.get(id, both));
  assert.deepEqual(Object.keys(s.verdict(id, both)), ["session"]);
});

test("peek and verdict write nothing: no tombstone, no delete, no lastSeen move, so endedOf stays null for a held id", () => {
  const now = clock();
  const s = store(now);
  const id = signIn(s);
  const revoked = tokensFile([["rob", "operator", H("c")]]);
  assert.equal(s.peek(id, revoked), null);
  assert.deepEqual(s.verdict(id, revoked), { ended: "revoked" });
  assert.deepEqual(s.verdict(id, tokensFile([["rob", "viewer", H("a")]])), { ended: "role" });
  assert.deepEqual(s.verdict(id, { ...FILE, generation: 3 }), { ended: "all" });
  assert.equal(s.endedOf(id), null, "still held, so not ended");
  now.advance(30 * MIN);
  const v = s.verdict(id, FILE);
  assert.deepEqual(v, { session: { id, name: "rob", role: "operator", tokenHash: H("a"), generation: 0, createdAt: T0, lastSeen: T0 } });
  v.session.role = "viewer";
  assert.equal(s.peek(id, FILE).role, "operator", "a copy");
  now.advance(30 * MIN + 1);
  assert.deepEqual(s.verdict(id, FILE), { ended: "idle" }, "verdict never moved lastSeen");
  assert.equal(s.endedOf(id), null);
  assert.equal(s.get(id, FILE), null, "the next request ends it");
  assert.equal(s.endedOf(id), "idle");
});

test("verdict: unjudged for an unusable file, whatever the id; endedOf's answer for an id the store does not hold", () => {
  const s = store();
  const id = signIn(s);
  for (const f of [null, {}, { generation: 0 }]) {
    assert.deepEqual(s.verdict(id, f), { unjudged: true });
    assert.deepEqual(s.verdict(ID_OF(200), f), { unjudged: true });
  }
  assert.deepEqual(s.verdict(ID_OF(200), FILE), { ended: "restart" });
  assert.deepEqual(s.verdict("short", FILE), { ended: null });
  assert.deepEqual(s.verdict(undefined, FILE), { ended: null });
  s.destroy(id, "elsewhere");
  assert.deepEqual(s.verdict(id, FILE), { ended: "elsewhere" });
});

test("sweep tombstones every expired session with its limit, idle before max (create and size sweep)", () => {
  const now = clock();
  const s = store(now);
  const idle = signIn(s);
  const busy = signIn(s);
  for (let i = 0; i < 24; i += 1) {
    now.advance(30 * MIN);
    assert.ok(s.get(busy, FILE));
    if (i === 0) assert.ok(s.get(idle, FILE));
  }
  now.advance(1);
  // idle has been idle 11.5 hours AND is past maxMs; busy is past maxMs only.
  assert.equal(s.size(), 0);
  assert.equal(s.endedOf(idle), "idle");
  assert.equal(s.endedOf(busy), "max");
  const late = signIn(s);
  now.advance(61 * MIN);
  signIn(s);
  assert.equal(s.endedOf(late), "idle", "create sweeps too");
});

test("destroy: elsewhere or null only; a tombstone only for a held id; one already past a limit keeps that limit", () => {
  const now = clock();
  const s = store(now);
  // `switched` is the page's word (issue #737), never a tombstone: no session ends for it.
  for (const bad of ["idle", "restart", "revoked", "shutdown", "switched", "", 0, false, "Elsewhere"]) assert.throws(() => s.destroy(signIn(s), bad), RangeError, JSON.stringify(bad));
  const a = signIn(s);
  s.destroy(a, "elsewhere");
  assert.equal(s.get(a, FILE), null);
  assert.equal(s.endedOf(a), "elsewhere");
  const b = signIn(s);
  s.destroy(b);
  assert.equal(s.endedOf(b), null, "the explicit no-reason entry");
  assert.equal(s.verdict(b, FILE).ended, null, "and not restart");
  const c = signIn(s);
  s.destroy(c, null);
  assert.equal(s.endedOf(c), null);
  // An id the store never held: destroy writes nothing, so it still reads as a possible restart.
  const unknown = ID_OF(201);
  s.destroy(unknown, "elsewhere");
  assert.equal(s.endedOf(unknown), "restart");
  // Destroyed again later: an id already ended has no session, so its tombstone stays as it was.
  s.destroy(a);
  assert.equal(s.endedOf(a), "elsewhere");
  // Past its idle limit but not yet swept: it had ended before the sign-out asked.
  const d = signIn(s);
  now.advance(61 * MIN);
  s.destroy(d, "elsewhere");
  assert.equal(s.endedOf(d), "idle");
});

test("destroy says who it ended, from the store alone (issue #737: a sign-out needs no tokens file), and null for an id it did not hold", () => {
  const now = clock();
  const s = store(now);
  const a = signIn(s, "view", "viewer", H("b"));
  const out = s.destroy(a, "elsewhere");
  assert.deepEqual(out, { name: "view", role: "viewer" });
  assert.deepEqual(Object.keys(out).sort(), ["name", "role"], "name and role only: never the id or the token's hash");
  assert.equal(s.destroy(a, "elsewhere"), null, "already ended");
  assert.equal(s.destroy(ID_OF(202), "elsewhere"), null, "never held");
  assert.equal(s.destroy(null), null);
  // Past its idle limit, not yet swept: still the store's, so still named, and its limit stays the reason.
  const b = signIn(s);
  now.advance(61 * MIN);
  assert.deepEqual(s.destroy(b, "elsewhere"), { name: "rob", role: "operator" });
  assert.equal(s.endedOf(b), "idle");
});

test("endedOf: restart only for a well-formed unknown id while the store is younger than maxMs and has evicted nothing", () => {
  const now = clock();
  const s = store(now);
  const held = signIn(s);
  assert.equal(s.endedOf(held), null, "a held id has not ended");
  assert.equal(s.endedOf(ID_OF(202)), "restart");
  for (const bad of ["x".repeat(42), `${"x".repeat(42)}=`, "x".repeat(44), "", null, undefined, 7, {}]) assert.equal(s.endedOf(bad), null, JSON.stringify(bad));
  now.advance(12 * 60 * MIN - 1);
  assert.equal(s.endedOf(ID_OF(202)), "restart", "a millisecond short of maxMs since the store began");
  now.advance(1);
  assert.equal(s.endedOf(ID_OF(202)), null, "up for maxMs: no session from before could still be live");
});

test("tombstones are a FIFO of tombstoneMax: re-ending moves an id to the newest, overflow drops the oldest, and an eviction ends restart", () => {
  const now = clock();
  const s = store(now, { tombstoneMax: 3 });
  const [a, b, c, d] = [0, 1, 2, 3].map(() => signIn(s));
  s.destroy(a, "elsewhere");
  s.destroy(b, "elsewhere");
  s.destroy(c, "elsewhere");
  assert.equal(s.endedOf(ID_OF(203)), "restart", "three held, nothing evicted yet");
  s.destroy(d, "elsewhere");
  assert.equal(s.endedOf(a), null, "the oldest is forgotten");
  assert.deepEqual([s.endedOf(b), s.endedOf(c), s.endedOf(d)], ["elsewhere", "elsewhere", "elsewhere"]);
  assert.equal(s.endedOf(ID_OF(203)), null, "once one was forgotten, an unknown id may be a forgotten one");
  assert.equal(s.endedOf(a), null);
  // The FIFO keeps insertion order, so the next overflow drops b, the oldest left (the next test re-ends an id).
  const e = signIn(s);
  s.destroy(e);
  assert.equal(s.endedOf(b), null);
  assert.deepEqual([s.endedOf(c), s.endedOf(d), s.endedOf(e)], ["elsewhere", "elsewhere", null]);
  // Real random ids: a counter seam wraps at 256 and would repeat one.
  const real = makeSessionStore({ now, maxMs: 12 * 60 * MIN });
  const ids = Array.from({ length: TOMBSTONE_MAX + 1 }, () => real.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id);
  for (const id of ids.slice(0, TOMBSTONE_MAX)) real.destroy(id, "elsewhere");
  assert.equal(real.endedOf(ID_OF(204)), "restart", "exactly TOMBSTONE_MAX held");
  real.destroy(ids.at(-1), "elsewhere");
  assert.equal(real.endedOf(ids[0]), null);
  assert.equal(real.endedOf(ids[1]), "elsewhere");
  assert.equal(real.endedOf(ID_OF(204)), null);
});

test("a tombstone written again for the same id moves it to the newest place", () => {
  const now = clock();
  // An id ends, a new session is created with the SAME id (a random seam that repeats), and ends again: the second
  // tombstone replaces the first and is now the newest, so the overflow drops the other one.
  let next = 1;
  const s = makeSessionStore({ now, random: (size) => Buffer.alloc(size, next), tombstoneMax: 2 });
  const a = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id;
  s.destroy(a, "elsewhere");
  next = 2;
  const b = s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id;
  s.destroy(b, "elsewhere");
  next = 1;
  assert.equal(s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id, a);
  assert.equal(s.endedOf(a), null, "held again");
  assert.equal(s.get(a, tokensFile([["rob", "operator", H("c")]])), null);
  assert.equal(s.endedOf(a), "revoked", "the newer reason");
  next = 3;
  s.destroy(s.create({ name: "rob", role: "operator", tokenHash: H("a"), generation: 0 }).id, null);
  assert.equal(s.endedOf(b), null, "b was the oldest, so it went");
  assert.equal(s.endedOf(a), "revoked", "a was moved to the newest, so it stayed");
});

test("setFlash holds a JSON copy for a held session only, past FLASH_MAX_BYTES it is refused, and takeFlash gives it once", () => {
  const now = clock();
  const s = store(now);
  const id = signIn(s);
  const change = { summary: "Paused the fleet", by: "rob", auditSeq: 41, count: 1, undo: "Resume it", inverse: { action: "fleet-resume", body: {} }, at: new Date(T0) };
  assert.equal(s.setFlash(id, change), true);
  change.summary = "changed afterwards";
  change.inverse.body.x = 1;
  assert.deepEqual(s.get(id, FILE), { id, name: "rob", role: "operator", tokenHash: H("a"), generation: 0, createdAt: T0, lastSeen: T0 }, "a session's copy carries no flash");
  assert.deepEqual(s.takeFlash(id), { summary: "Paused the fleet", by: "rob", auditSeq: 41, count: 1, undo: "Resume it", inverse: { action: "fleet-resume", body: {} }, at: new Date(T0).toISOString() });
  assert.equal(s.takeFlash(id), null, "once");
  assert.equal(s.setFlash(ID_OF(205), change), false, "no session");
  assert.equal(s.takeFlash(ID_OF(205)), null);
  assert.equal(s.setFlash(42, change), false);
  assert.equal(s.takeFlash(undefined), null);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(s.setFlash(id, cyclic), false);
  assert.equal(s.setFlash(id, undefined), false);
  assert.equal(s.setFlash(id, () => {}), false);
  assert.equal(s.setFlash(id, { big: 1n }), false);
  assert.equal(s.takeFlash(id), null, "nothing refused was held");
  // Exactly at the cap is held; a byte over is refused (bytes, not characters).
  const pad = (n) => ({ s: "x".repeat(n - 8) });
  assert.equal(Buffer.byteLength(JSON.stringify(pad(FLASH_MAX_BYTES))), FLASH_MAX_BYTES);
  assert.equal(s.setFlash(id, pad(FLASH_MAX_BYTES)), true);
  assert.equal(s.setFlash(id, pad(FLASH_MAX_BYTES + 1)), false);
  assert.deepEqual(s.takeFlash(id), pad(FLASH_MAX_BYTES), "the refused one did not replace the held one");
  assert.equal(s.setFlash(id, { s: "\u00e9".repeat(FLASH_MAX_BYTES / 2) }), false, "two bytes a character");
  assert.equal(s.setFlash(id, { n: 1 }), true);
  assert.equal(s.setFlash(id, { n: 2 }), true);
  assert.deepEqual(s.takeFlash(id), { n: 2 }, "the newer flash replaces the older");
});

test("a flash goes with its session: on destroy, on a failing get, and on a sweep", () => {
  const now = clock();
  const s = store(now);
  const a = signIn(s);
  s.setFlash(a, { n: 1 });
  s.destroy(a, "elsewhere");
  assert.equal(s.takeFlash(a), null);
  const b = signIn(s);
  s.setFlash(b, { n: 2 });
  assert.equal(s.get(b, tokensFile([])), null);
  assert.equal(s.takeFlash(b), null);
  const c = signIn(s);
  s.setFlash(c, { n: 3 });
  assert.equal(s.peek(c, tokensFile([])), null);
  assert.deepEqual(s.takeFlash(c), { n: 3 }, "peek ends nothing, so the flash stays");
  s.setFlash(c, { n: 4 });
  now.advance(61 * MIN);
  assert.equal(s.size(), 0);
  assert.equal(s.takeFlash(c), null);
});
