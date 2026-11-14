import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { APPROVAL_KEEP_MS, MATCH_ALPHABET, MATCH_LENGTH, approvalMessage, dialogRunnerFor, makeApprovals, matchCodeOf } from "../src/console/approve-dialog.mjs";

/**
 * Issue #882: signing in by approving a window on the host. Nothing here shows a real window: the runner's `spawnFn`
 * and the store's `runner` are the seams, and what is checked is what each tool is handed and how its answer is read.
 */

/** A spawn that records each call and answers with `code` and `out` (or never, with `hang`). */
function fakeSpawn({ code = 0, out = "", hang = false, throws = false } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (throws) throw new Error("ENOENT");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { child.emit("close", null); };
    if (!hang) setImmediate(() => { if (out) child.stdout.emit("data", Buffer.from(out)); child.emit("close", code); });
    return child;
  };
  return { spawnFn, calls };
}
const okAccess = () => {};
const noAccess = () => { throw new Error("ENOENT"); };

test("where a window can be shown: macOS with osascript, Linux with a display and zenity or kdialog, nowhere else", () => {
  assert.equal(dialogRunnerFor({ platform: "darwin", access: okAccess }).tool, "osascript");
  assert.equal(dialogRunnerFor({ platform: "darwin", access: noAccess }).available, false);
  assert.match(dialogRunnerFor({ platform: "linux", env: { PATH: "/usr/bin" }, access: okAccess }).why, /no display/);
  const zenityOnly = (p) => { if (!p.endsWith("/zenity")) throw new Error("ENOENT"); };
  assert.equal(dialogRunnerFor({ platform: "linux", env: { DISPLAY: ":0", PATH: "/usr/bin" }, access: zenityOnly }).tool, "zenity");
  const kdialogOnly = (p) => { if (!p.endsWith("/kdialog")) throw new Error("ENOENT"); };
  assert.equal(dialogRunnerFor({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" }, access: kdialogOnly }).tool, "kdialog");
  assert.match(dialogRunnerFor({ platform: "linux", env: { DISPLAY: ":0", PATH: "/usr/bin" }, access: noAccess }).why, /neither zenity nor kdialog/);
  assert.equal(dialogRunnerFor({ platform: "win32" }).available, false);
});

test("osascript: every word reaches the window as an argument, never inside the script, Deny the default, and its answers are read", async () => {
  const evil = 'alice" & (do shell script "id") & "';
  const one = fakeSpawn({ out: "Allow\n" });
  const r1 = dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: one.spawnFn });
  assert.deepEqual(await r1.ask({ message: "M", names: [evil], timeoutMs: 60_000 }), { answer: "allow", name: evil });
  const { cmd, args } = one.calls[0];
  assert.equal(cmd, "/usr/bin/osascript");
  const script = args.filter((_, i) => args[i - 1] === "-e").join("\n");
  assert.ok(!script.includes(evil) && !script.includes("do shell script"), "the name is never script text");
  assert.match(script, /default button "Deny"/);
  assert.match(script, /giving up after/);
  assert.deepEqual(args.slice(-3), ["M", "60", evil], "the message, the seconds and the names follow the script as argv");
  for (const [out, answer] of [["Deny\n", "deny"], ["timeout\n", "timeout"], ["", "error"], ["Allow:bob\n", "error"]]) {
    const f = fakeSpawn({ out });
    assert.equal((await dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: f.spawnFn }).ask({ message: "M", names: ["alice"] })).answer, answer, JSON.stringify(out));
  }
  // Several operators: a list to pick from; the pick must be one of them.
  const many = fakeSpawn({ out: "Allow:bob\n" });
  assert.deepEqual(await dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: many.spawnFn }).ask({ message: "M", names: ["alice", "bob"] }), { answer: "allow", name: "bob" });
  assert.match(many.calls[0].args.join(" "), /choose from list/);
  const stranger = fakeSpawn({ out: "Allow:mallory\n" });
  assert.equal((await dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: stranger.spawnFn }).ask({ message: "M", names: ["alice", "bob"] })).answer, "error");
  // A non-zero exit (no GUI session: "No user interaction allowed") and a spawn that throws are errors, never an allow.
  assert.equal((await dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: fakeSpawn({ code: 1, out: "Allow" }).spawnFn }).ask({ message: "M", names: ["alice"] })).answer, "error");
  assert.equal((await dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: fakeSpawn({ throws: true }).spawnFn }).ask({ message: "M", names: ["alice"] })).answer, "error");
});

test("a window that never answers is a timeout, and its process is ended", async () => {
  const f = fakeSpawn({ hang: true });
  const got = await dialogRunnerFor({ platform: "darwin", access: okAccess, spawnFn: f.spawnFn }).ask({ message: "M", names: ["alice"], timeoutMs: 1 });
  assert.equal(got.answer, "timeout");
});

test("zenity and kdialog: their exit codes read as allow, deny and timeout", async () => {
  const zenityOnly = (p) => { if (!p.endsWith("/zenity")) throw new Error("ENOENT"); };
  const ask = async (code, out = "", names = ["alice"]) => {
    const f = fakeSpawn({ code, out });
    return { got: await dialogRunnerFor({ platform: "linux", env: { DISPLAY: ":0", PATH: "/usr/bin" }, access: zenityOnly, spawnFn: f.spawnFn }).ask({ message: "M", names }), call: f.calls[0] };
  };
  assert.deepEqual((await ask(0)).got, { answer: "allow", name: "alice" });
  assert.equal((await ask(1)).got.answer, "deny");
  assert.equal((await ask(5)).got.answer, "timeout");
  assert.ok((await ask(0)).call.args.includes("--text=M"), "the message is one argument");
  assert.deepEqual((await ask(0, "bob\n", ["alice", "bob"])).got, { answer: "allow", name: "bob" });
  const kdialogOnly = (p) => { if (!p.endsWith("/kdialog")) throw new Error("ENOENT"); };
  const k = fakeSpawn({ code: 0 });
  assert.deepEqual(await dialogRunnerFor({ platform: "linux", env: { DISPLAY: ":0", PATH: "/usr/bin" }, access: kdialogOnly, spawnFn: k.spawnFn }).ask({ message: "M", names: ["alice"] }), { answer: "allow", name: "alice" });
});

test("a match code: four letters a person cannot misread, evenly drawn", () => {
  for (let i = 0; i < 200; i++) {
    const code = matchCodeOf();
    assert.equal(code.length, MATCH_LENGTH);
    for (const ch of code) assert.ok(MATCH_ALPHABET.includes(ch), code);
  }
  assert.ok(!/[01OIL]/.test(MATCH_ALPHABET));
  assert.match(approvalMessage({ names: ["alice"], match: "AB2C", from: "this computer" }), /as alice\..*AB2C.*From: this computer/s);
});

test("the store: one request waits at a time, an allowed one signs in once, and answers are kept only so long", async () => {
  let t = 1_000_000;
  let answer = null;
  const settled = [];
  const runner = { available: true, ask: () => new Promise((resolve) => { answer = resolve; }) };
  const store = makeApprovals({ runner, now: () => t, onSettle: (r) => settled.push(r.state) });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = store.start({ names: ["alice"], from: "this computer" });
  assert.match(first.id, /^[A-Za-z0-9_-]{43}$/, "256 bits");
  assert.deepEqual(store.start({ names: ["alice"], from: "this computer" }), { refusal: "busy" });
  assert.deepEqual(store.status(first.id), { state: "pending", match: first.match });
  assert.equal(store.take(first.id), null, "nothing to take while it waits");
  await tick();
  answer({ answer: "allow", name: "alice" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.status(first.id).state, "allow");
  assert.deepEqual(store.take(first.id), { name: "alice" });
  assert.equal(store.take(first.id), null, "an allowed request signs in one browser, once");
  assert.equal(store.status(first.id), null);
  assert.deepEqual(settled, ["allow"]);
  // A denied one is told, then forgotten after the keep window; the next request may start once nothing waits.
  const second = store.start({ names: ["alice"], from: "10.0.0.5" });
  await tick();
  answer({ answer: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.status(second.id).state, "deny");
  t += APPROVAL_KEEP_MS + 1;
  assert.equal(store.status(second.id), null);
  // A runner that names someone not asked for, or answers nonsense, is an error, never an allow.
  const third = store.start({ names: ["alice"], from: "this computer" });
  await tick();
  answer({ answer: "allow", name: "mallory" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.status(third.id).state, "error");
  assert.equal(store.take(third.id), null);
  // No window here at all.
  assert.deepEqual(makeApprovals({ runner: { available: false } }).start({ names: ["alice"], from: "x" }), { refusal: "unavailable" });
  // An unknown or malformed id is null, never an exception.
  assert.equal(store.status("nope"), null);
  assert.equal(store.status(undefined), null);
});
