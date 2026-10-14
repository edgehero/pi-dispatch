import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConfirmTickets } from "../src/console/confirm.mjs";

// The console's diff-bound confirm tickets (issue #640), on an injected clock.
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

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
function preview(over = {}) {
  return {
    sessionId: "s1",
    action: "pause-windows",
    target: "pause-windows.json",
    payload: { windows: [] },
    expect: [{ path: "/p.json", text: "{}" }],
    beforeDigest: "b".repeat(64),
    afterDigest: "a".repeat(64),
    ...over,
  };
}

test("issue returns only a random ticket, and redeem gives back exactly what was stored", () => {
  const now = clock();
  const t = makeConfirmTickets({ now, random: counter() });
  const { ticket } = t.issue(preview());
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  const { entry } = t.redeem({ sessionId: "s1", ticket, action: "pause-windows" });
  assert.deepEqual(entry, { ...preview(), reserve: null, issuedAt: T0, expiresAt: T0 + 300000 });
  const paid = t.issue(preview({ reserve: { micros: 5 } }));
  assert.deepEqual(t.redeem({ sessionId: "s1", ticket: paid.ticket, action: "pause-windows" }).entry.reserve, { micros: 5 });
  assert.match(makeConfirmTickets().issue(preview()).ticket, /^[A-Za-z0-9_-]{43}$/);
});

test("a ticket is single use: the second redeem is refused", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  assert.ok(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).entry);
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).refusal, /already used, has expired, or was never issued/);
});

test("an unknown or non-string ticket is refused", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  t.issue(preview());
  assert.match(t.redeem({ sessionId: "s1", ticket: "nope", action: "pause-windows" }).refusal, /never issued/);
  assert.match(t.redeem({ sessionId: "s1", ticket: undefined, action: "pause-windows" }).refusal, /never issued/);
  assert.match(t.redeem({ sessionId: "s1", ticket: { toString: () => "x" }, action: "pause-windows" }).refusal, /never issued/);
  assert.equal(t.size(), 1, "a refused unknown ticket touches no other");
});

test("a ticket expires after ttlMs, and is gone after the refused attempt", () => {
  const now = clock();
  const t = makeConfirmTickets({ now, random: counter(), ttlMs: 1000 });
  const a = t.issue(preview());
  const b = t.issue(preview());
  now.advance(999);
  assert.ok(t.redeem({ sessionId: "s1", ticket: a.ticket, action: "pause-windows" }).entry);
  now.advance(1);
  assert.match(t.redeem({ sessionId: "s1", ticket: b.ticket, action: "pause-windows" }).refusal, /has expired/);
  assert.equal(t.size(), 0);
});

test("another session's ticket is refused, and the attempt burns it for its owner too", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  assert.match(t.redeem({ sessionId: "s2", ticket, action: "pause-windows" }).refusal, /belongs to another sign-in/);
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).refusal, /already used/);
});

test("a ticket for another action is refused and burned, so it cannot be probed", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "scoped-limits" }).refusal, /issued for another action/);
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).refusal, /already used/);
});

test("past max live tickets the oldest is dropped, and expired ones go first", () => {
  const now = clock();
  const t = makeConfirmTickets({ now, random: counter(), max: 3, ttlMs: 1000 });
  const issued = [0, 1, 2, 3].map(() => t.issue(preview()).ticket);
  assert.equal(t.size(), 3);
  assert.match(t.redeem({ sessionId: "s1", ticket: issued[0], action: "pause-windows" }).refusal, /never issued/);
  assert.ok(t.redeem({ sessionId: "s1", ticket: issued[1], action: "pause-windows" }).entry);
  assert.ok(t.redeem({ sessionId: "s1", ticket: issued[3], action: "pause-windows" }).entry);

  now.advance(1000);
  const fresh = [0, 1, 2].map(() => t.issue(preview()).ticket);
  assert.equal(t.size(), 3, "the expired one was swept rather than a live one dropped");
  for (const ticket of fresh) assert.ok(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).entry);
});

test("refusals never quote the ticket", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  const r = t.redeem({ sessionId: "s2", ticket, action: "pause-windows" });
  assert.ok(!r.refusal.includes(ticket));
});
