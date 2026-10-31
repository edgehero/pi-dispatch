import assert from "node:assert/strict";
import { test } from "node:test";
import { readAgentWritesToday } from "../src/agent-write-count.mjs";

const AT = Date.parse("2026-10-31T12:00:00Z");
const row = (seq, action, { ticket = "one", outcome = "ok", role = "agent", at = AT - 1000 } = {}) => ({ seq, at: new Date(at).toISOString(), action, actor: { name: "service", role }, ticket, kind: "queue-pause", target: "queue-a", outcome });
const recount = (rows, extra = {}) => readAgentWritesToday({ now: () => AT, host: "host-a", read: async () => ({ rows, next: null }), verify: async () => ({ ok: true, rows: rows.length, last: { seq: rows[0]?.seq ?? 0 }, startsAt: null }), ...extra });

test("agent writes count applied receipts, not intents, people, logins or duplicate receipts", async () => {
  const rows = [row(7, "write-applied", { role: "operator" }), row(6, "login"), row(5, "write-applied"), row(4, "write-applied"), row(3, "write"), row(2, "write", { ticket: "not-applied" }), row(1, "write", { at: AT - 86400000, ticket: "old" })];
  const got = await recount(rows);
  assert.equal(got.count, 1);
  assert.equal(got.partial, true, "An intent with no receipt makes the total incomplete");
  assert.equal(got.scope, "local-console");
  assert.equal(got.host, "host-a");
});

test("compensated and refused writes contribute zero, with ticket-target matching for bulk operations", async () => {
  const rows = [row(5, "write", { outcome: "failed" }), row(4, "write-applied"), row(3, "write"), { ...row(2, "write-applied"), target: "queue-b" }, { ...row(1, "write"), target: "queue-b" }];
  const got = await recount(rows);
  assert.equal(got.count, 1, "Only the uncompensated target is counted");
  assert.equal(got.partial, false);
});

test("native paging counts beyond the 500-row mirror and filters by UTC today", async () => {
  const all = [];
  for (let i = 0; i < 600; i++) all.push(row(1201 - i * 2, "write-applied", { ticket: `op-${i}` }), row(1200 - i * 2, "write", { ticket: `op-${i}` }));
  all.push(row(1, "login", { at: AT - 86400000 }));
  const reads = [];
  const got = await recount([], { read: async ({ before, limit }) => { const at = before === null ? 0 : Number(before); reads.push(at); return { rows: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null }; }, verify: async () => ({ ok: true, last: { seq: 1201 }, startsAt: null }) });
  assert.equal(got.count, 600);
  assert.equal(got.partial, false);
  assert.equal(reads.length, 3);
});

test("a clock adjustment cannot hide today's receipts behind older timestamps", async () => {
  const rows = [row(6, "login", { at: AT - 86400000 }), row(5, "write-applied"), row(4, "write"), row(3, "login", { at: AT - 86400000 }), row(2, "write-applied", { ticket: "two" }), row(1, "write", { ticket: "two" })];
  const positions = [];
  const got = await recount([], {
    read: async ({ before }) => { const index = before === null ? 0 : Number(before); positions.push(index); return { rows: rows.slice(index, index + 3), next: index === 0 ? "3" : null }; },
    verify: async () => ({ ok: true, last: { seq: 6 }, startsAt: null }),
  });
  assert.deepEqual(positions, [0, 3]);
  assert.equal(got.count, 2);
  assert.equal(got.partial, false);
});

test("retained first slice, a bounded scan and rows newer than verification stay partial", async () => {
  const rows = [row(10, "write-applied"), row(9, "write")];
  assert.equal((await recount(rows, { verify: async () => ({ ok: true, last: { seq: 10 }, startsAt: { file: "2026-10.jsonl", seq: 9 } }) })).partial, true);
  assert.equal((await recount(rows, { verify: async () => ({ ok: true, last: { seq: 9 }, startsAt: null }) })).partial, true);
  assert.equal((await recount(rows, { maxRows: 1, read: async () => ({ rows: rows.slice(0, 1), next: "older" }) })).partial, true);
});

test("broken, unreadable and malformed evidence is unavailable instead of zero", async () => {
  for (const extra of [{ verify: async () => ({ ok: false }) }, { read: async () => { throw Error("private error must not escape"); } }, { read: async () => ({ rows: [{ broken: true }], next: null }) }, { read: async () => ({ rows: [{ ...row(1, "write"), at: "invalid" }], next: null }) }]) {
    const got = await recount([], extra);
    assert.equal(got.count, null);
    assert.equal(got.unavailable, true);
    assert.ok(!JSON.stringify(got).includes("private error"));
  }
});
