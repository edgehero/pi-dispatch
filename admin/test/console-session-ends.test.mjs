import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ENDED_REASONS, NOTICE_OF_STATUS, SIGN_IN_NOTICES, STREAM_ENDS, STREAM_SHUTDOWN, endedNotices, endedReasonOf, streamEndOf } from "../src/console/session-ends.mjs";
import { ICON_NAMES } from "../src/console/pulse-icons.mjs";
import { LINK_NOTICES } from "../src/console/signin.mjs";
import { STATUS_KINDS } from "../src/words.mjs";

// Why a session ended, and what the sign-in page says (issues #737 and #711): one closed list the server, the hub and
// the browser script share. Pure: no clock, no store.

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

test("the reason lists: a stream ends for every reason but restart and switched, and shutdown takes their place", () => {
  assert.deepEqual([...ENDED_REASONS], ["idle", "max", "revoked", "role", "all", "elsewhere", "restart", "switched"]);
  assert.equal(STREAM_SHUTDOWN, "shutdown");
  assert.deepEqual([...STREAM_ENDS], [...ENDED_REASONS.filter((r) => r !== "restart" && r !== "switched"), STREAM_SHUTDOWN], "derived, in the same order");
  assert.ok(Object.isFrozen(ENDED_REASONS) && Object.isFrozen(STREAM_ENDS));
  assert.ok(!STREAM_ENDS.includes("restart"), "this process opened every stream it ends");
  assert.ok(!STREAM_ENDS.includes("switched"), "no session ends for it: only the page says it (issue #737)");
  // Disjoint from the sign-in refusals' kinds, so a notice named by one word means one thing (signin.mjs noticeKey).
  assert.deepEqual(ENDED_REASONS.filter((r) => Object.hasOwn(SIGN_IN_NOTICES, r)), []);
  assert.ok(!ENDED_REASONS.includes(STREAM_SHUTDOWN), "the console stopping is not a sign-out");
});

test("endedReasonOf and streamEndOf answer a member byte for byte or null, never the input's bytes", () => {
  for (const r of ENDED_REASONS) assert.equal(endedReasonOf(r), r);
  for (const r of STREAM_ENDS) assert.equal(streamEndOf(r), r);
  assert.equal(endedReasonOf("shutdown"), null);
  assert.equal(streamEndOf("restart"), null);
  const hostile = ["", " idle", "idle ", "IDLE", "Idle", "idle\n", "idle\u0000", "id\u200ble", "../idle", "idle&x=1", "<script>", "__proto__", "constructor", "toString", "length", "0"];
  const shapes = [null, undefined, 0, 1, true, {}, [], ["idle"], new String("idle"), { toString: () => "idle" }, Symbol("idle")];
  for (const v of [...hostile, ...shapes]) {
    assert.equal(endedReasonOf(v), null, String(typeof v === "symbol" ? "symbol" : JSON.stringify(v)));
    assert.equal(streamEndOf(v), null);
  }
});

test("endedNotices: one notice per reason, in the list's order, each frozen, drawn in a STATUS_KINDS status with a sprite icon", () => {
  const notices = endedNotices();
  assert.deepEqual(Object.keys(notices), [...ENDED_REASONS]);
  assert.ok(Object.isFrozen(notices));
  for (const [reason, n] of Object.entries(notices)) {
    assert.ok(Object.isFrozen(n), reason);
    assert.deepEqual(Object.keys(n), ["status", "icon", "title", "body"], reason);
    assert.ok(STATUS_KINDS.includes(n.status), `${reason}: ${n.status} is a status`);
    assert.ok(ICON_NAMES.includes(n.icon), `${reason}: ${n.icon} is in the sprite`);
    for (const text of [n.title, n.body]) {
      assert.equal(typeof text, "string");
      assert.ok(text.length > 0, reason);
      assert.ok(!CONTROL_RE.test(text) && !text.includes("\u2014") && !text.includes("pdc_"), `${reason}: ${text}`);
    }
  }
  // The console's own limits, and the defaults when none are given.
  assert.equal(notices.idle.title, "You were signed out after 60 minutes without a request");
  assert.equal(notices.max.title, "You were signed out after 12 hours");
  const mine = endedNotices({ idleMinutes: 15, maxHours: 3 });
  assert.equal(mine.idle.title, "You were signed out after 15 minutes without a request");
  assert.equal(mine.max.title, "You were signed out after 3 hours");
  assert.deepEqual(endedNotices({}), notices);
  // restart is a possibility, never a claim.
  assert.match(notices.restart.title, /\bmay\b/);
  // switched (issue #737): the browser is signed in, as someone else, which the elsewhere notice ("signed out in
  // another tab") would have got wrong; it says what to do.
  assert.deepEqual(notices.switched, { status: "attention", icon: "key", title: "This browser is now signed in as someone else", body: "Another tab signed this browser in with a different token, so this page stopped rather than act for that sign-in. Sign in again to carry on as yourself." });
});

test("SIGN_IN_NOTICES: each kind drawn in a STATUS_KINDS status with a sprite icon; only other has no body (the server's sentence fills it)", () => {
  assert.deepEqual(Object.keys(SIGN_IN_NOTICES), ["wrong", "rate", "tokens", "audit", "unreachable", "other"]);
  assert.ok(Object.isFrozen(SIGN_IN_NOTICES));
  for (const [kind, n] of Object.entries(SIGN_IN_NOTICES)) {
    assert.ok(Object.isFrozen(n), kind);
    assert.deepEqual(Object.keys(n), ["status", "icon", "title", "body"], kind);
    assert.ok(STATUS_KINDS.includes(n.status), `${kind}: ${n.status} is a status`);
    assert.ok(ICON_NAMES.includes(n.icon), `${kind}: ${n.icon} is in the sprite`);
    assert.ok(n.title.length > 0);
    assert.equal(n.body === "", kind === "other", kind);
    for (const text of [n.title, n.body]) assert.ok(!CONTROL_RE.test(text) && !text.includes("\u2014") && !text.includes("pdc_"), `${kind}: ${text}`);
    // A command in a body is marked for the code face, each mark closed; a title is plain words.
    assert.ok(!n.title.includes("`") && n.body.split("`").length % 2 === 1, `${kind}: ${n.body}`);
  }
  assert.equal(SIGN_IN_NOTICES.tokens.body, "An operator should run `pi-dispatch doctor` on the host.");
});

test("NOTICE_OF_STATUS maps each sign-in route's statuses to a SIGN_IN_NOTICES kind, or to none; network failures and other statuses are the script's", () => {
  assert.ok(Object.isFrozen(NOTICE_OF_STATUS));
  assert.deepEqual(Object.keys(NOTICE_OF_STATUS), ["/login", "/login/code"]);
  for (const [route, byStatus] of Object.entries(NOTICE_OF_STATUS)) {
    assert.ok(Object.isFrozen(byStatus), route);
    for (const [status, kind] of Object.entries(byStatus)) {
      assert.match(status, /^[45][0-9]{2}$/, `${route} ${status}`);
      assert.ok(kind === null || Object.hasOwn(SIGN_IN_NOTICES, kind), `${route} ${status}: ${kind}`);
      assert.notEqual(kind, "unreachable", "no status means unreachable");
      assert.notEqual(kind, "other", "other is every status not listed");
    }
  }
  assert.equal(NOTICE_OF_STATUS["/login"][401], "wrong");
  // A link's own refusal is the link page's used state alone, which says it whole: no notice repeats it.
  assert.equal(NOTICE_OF_STATUS["/login/code"][401], null);
});

test("every notice a sign-in page draws is one it can show: a status selects it, or it is the script's own", () => {
  // The script shows `unreachable` when a post reaches nothing and `other` for any status not listed (script.mjs).
  const theScripts = ["unreachable", "other"];
  const selected = (route) => Object.values(NOTICE_OF_STATUS[route]).filter((k) => k !== null);
  // The sign-in page draws every SIGN_IN_NOTICES kind (signin.mjs signInContent); the link page its LINK_NOTICES.
  assert.deepEqual(new Set([...selected("/login"), ...theScripts]), new Set(Object.keys(SIGN_IN_NOTICES)), "/login");
  assert.deepEqual(new Set([...selected("/login/code"), ...theScripts]), new Set(LINK_NOTICES), "/login/code");
});

test("session-ends.mjs is a pure leaf: it imports nothing, so the server, the hub and the script's build can all take it", () => {
  const text = readFileSync(new URL("../src/console/session-ends.mjs", import.meta.url), "utf8");
  assert.ok(!/^\s*import\b/m.test(text) && !/\bimport\s*\(/.test(text) && !/\brequire\s*\(/.test(text));
});
