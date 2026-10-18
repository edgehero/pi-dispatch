import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { CHAT_USAGE, answerFailure, classifyDispatchChatTarget, dispatchChat, questionFromTranscript, quoteQuestion, terminalAsk } from "../src/dispatch-chat.mjs";
import { FORGE_URL_MAX } from "../src/read-model.mjs";
import { CHAT_URL_MAX, classifyChatTarget } from "../../worker/src/chat-cli.mjs";
import { CHAT_REFUSALS } from "@edgehero/pi-dispatch/chat-mode";

/**
 * `/dispatch chat` (issue #647, part 2, REQ-TERMINAL-CHAT): the argument classes, and each mode driven through fakes of
 * the seams `chatIo` wires in index.ts (the fleet reader, the lookup, the dashboard opener, the parked-answer planner,
 * the audited write, the enqueue and the chat-fork module). No Valkey, no pi, no terminal.
 */
const KEY = "0123456789abcdef0123456789abcdef";

function harness({ doc = null, lookupResult, entries = null, plan = { plan: PLAN() }, writeResult = { ok: true, jobIds: ["j2"], queue: "pi-jobs" }, input = "ship it", confirm = true, fork = fakeFork(), ui = {}, proc = fakeProc() } = {}) {
  const log = [];
  const notes = [];
  const reader = {
    disposed: false,
    async transcriptSince(jobId, after) {
      log.push(["transcriptSince", jobId, after]);
      if (entries === null) return { entries: [], next: null, ended: false };
      return after === null ? { entries, next: "9-9", ended: false } : { entries: [], next: "9-9", ended: false };
    },
    async dispose() {
      log.push(["dispose"]);
      this.disposed = true;
    },
  };
  const io = {
    ui: {
      notify: (m, l) => notes.push([m, l]),
      input: async (title) => (log.push(["input", title]), input),
      confirm: async (title, message) => (log.push(["confirm", title, message]), confirm),
      custom: async (factory) => {
        log.push(["custom"]);
        const tui = { stop: () => log.push(["tui.stop"]), start: () => log.push(["tui.start"]), requestRender: (force) => log.push(["tui.requestRender", force]) };
        return new Promise((resolve) => {
          const component = factory(tui, null, null, resolve);
          assert.equal(typeof component.render, "function", "custom gets a component back");
        });
      },
      ...ui,
    },
    env: { PI_SESSIONS_DIR: "/srv/sessions" },
    openReader: () => (log.push(["openReader"]), reader),
    lookup: async (fleet, query, env) => {
      log.push(["lookup", query, env]);
      assert.equal(fleet, reader, "the lookup reads through the reader this command opened");
      return lookupResult ?? { id: "j1", doc, record: doc?.mode === "fork" ? FULL_RECORD : null };
    },
    openDashboard: async (opts) => log.push(["openDashboard", opts, reader.disposed]),
    planAnswer: async (args) => (log.push(["planAnswer", args]), plan),
    write: async (opts, fn) => {
      log.push(["write", opts]);
      const res = await fn();
      return writeResult ?? res;
    },
    enqueueAnswer: async (p) => (log.push(["enqueueAnswer", p]), { ok: true, jobIds: ["j2"] }),
    fork,
    forkIo: { hostEnv: { PATH: "/bin" }, cwd: "/work", agentDir: "/agent", out: (line) => log.push(["out", line]), makeAsk: () => ({ canAsk: true, ask: async () => true, abort() {} }), pause: async () => log.push(["pause"]), proc },
  };
  return { io, log, notes, reader };
}

/** The full record the fleet read: distinguishable from the document's safe `run` (`host` and the outcome are its own). */
const FULL_RECORD = Object.freeze({ jobId: "j1", kind: "github", target: "o/r#7", outcome: "completed", host: "this-host" });

/** A process seam: signal listeners as an EventEmitter keeps them, `prependListener` included. */
function fakeProc() {
  return Object.assign(new EventEmitter(), { stdin: { isTTY: true } });
}

function PLAN() {
  return { kind: "parked-answer", jobId: "j1", forge: "github", queue: "pi-jobs", job: { trigger: { comment: { body: "ship it" } } }, runFields: { flow: "fix", model: null, maxCostUsd: "2.00" }, reserve: { dollarsMicros: 2_000_000 } };
}

function fakeFork({ refusal = null, run = async () => 0 } = {}) {
  const calls = [];
  return {
    calls,
    resolvePiBinary: (a) => (calls.push(["resolvePiBinary", a]), { path: "/bin/pi", from: "PATH" }),
    piVersionOf: (p, a) => (calls.push(["piVersionOf", p, a]), "1.2.0"),
    planFork: (a) => (calls.push(["planFork", a]), refusal ? { refusal } : { plan: { key: KEY, piPath: "/bin/pi", notes: [], warnings: [] } }),
    runFork: async (a) => {
      calls.push(["runFork", a]);
      return run(a);
    },
  };
}

const doc = (mode, extra = {}) => ({ version: 1, run: { id: "j1", jobId: "j1" }, state: mode === "live" ? "active" : mode === "reply" ? "parked" : mode === "fork" ? "finished" : "queued", mode, says: mode === null ? CHAT_REFUSALS.queued : null, activeJobId: null, forgeLink: "https://github.com/o/r/issues/7", newerRunOnTarget: null, ...extra });

test("the argument classes: a 32-hex key first, then an http(s) link, then a run id; anything else refused", () => {
  assert.deepEqual(classifyDispatchChatTarget(KEY), { kind: "key", key: KEY });
  assert.deepEqual(classifyDispatchChatTarget("https://github.com/o/r/issues/7"), { kind: "url", url: "https://github.com/o/r/issues/7" });
  assert.deepEqual(classifyDispatchChatTarget("HTTP://gitlab.example/g/p/-/merge_requests/3"), { kind: "url", url: "HTTP://gitlab.example/g/p/-/merge_requests/3" });
  assert.deepEqual(classifyDispatchChatTarget("1234"), { kind: "id", id: "1234" });
  assert.deepEqual(classifyDispatchChatTarget("recovery:j1.2"), { kind: "id", id: "recovery:j1.2" });
  assert.equal(classifyDispatchChatTarget(KEY.toUpperCase()).kind, "id", "an upper-case hex string is no session key (the store's keys are lowercase)");
  assert.equal(classifyDispatchChatTarget("").refusal, CHAT_USAGE);
  assert.match(classifyDispatchChatTarget("a b").refusal, /neither a run id/);
  assert.match(classifyDispatchChatTarget("https://[::1").refusal, /does not parse/);
  assert.match(classifyDispatchChatTarget(`https://github.com/${"x".repeat(3000)}`).refusal, /longer than/);
});

test("live: the dashboard opens on the run's active job's LIVE_TAIL, after the lookup's reader is closed", async () => {
  const h = harness({ doc: doc("live", { activeJobId: "recovery-9" }) });
  await dispatchChat("j1", h.io);
  const open = h.log.find((l) => l[0] === "openDashboard");
  assert.deepEqual(open[1], { initialTail: "recovery-9" }, "a run that goes on as a recovery tails the recovery job");
  assert.equal(open[2], true, "the lookup's reader is disposed before the dashboard opens its own");
  assert.deepEqual(h.log.find((l) => l[0] === "lookup")[1], { id: "j1" });
  assert.equal(h.notes.length, 0);
  const own = harness({ doc: doc("live") });
  await dispatchChat("https://github.com/o/r/issues/7", own.io);
  assert.deepEqual(own.log.find((l) => l[0] === "lookup")[1], { url: "https://github.com/o/r/issues/7" }, "a link is looked up as a link");
  assert.deepEqual(own.log.find((l) => l[0] === "openDashboard")[1], { initialTail: "j1" }, "no active job id in the document: the run's own id");
});

test("reply: shows the question, asks, plans, confirms, writes through the audited path around the enqueue", async () => {
  const h = harness({ doc: doc("reply"), entries: [{ kind: "assistant", text: "first" }, { kind: "tool-call", text: "{}" }, { kind: "assistant", text: "Which branch?\\u{000A}main or dev" }, { kind: "user", text: "later" }] });
  await dispatchChat("j1", h.io);
  assert.match(h.notes[0][0], /^run j1 asked:\n {2}\| Which branch\?\n {2}\| main or dev$/, "the last assistant entry, its escaped line break a line again, each line marked");
  const order = h.log.map((l) => l[0]).filter((n) => ["dispose", "input", "planAnswer", "confirm", "write", "enqueueAnswer"].includes(n));
  assert.deepEqual(order, ["dispose", "input", "planAnswer", "confirm", "write", "enqueueAnswer"]);
  assert.deepEqual(h.log.find((l) => l[0] === "planAnswer")[1], { jobId: "j1", text: "ship it" });
  const [, title, message] = h.log.find((l) => l[0] === "confirm");
  assert.match(title, /j1/);
  assert.match(message, /queue pi-jobs/);
  assert.match(message, /flow fix; model the deployment's default; per-job cap \$2\.00/, "the run fields, as the console's preview words them");
  assert.match(message, /\$2\.00 \(the per-job cap\)/, "the reserve, as the console's preview words it");
  assert.match(message, /The answer:\nship it$/);
  const [, opts] = h.log.find((l) => l[0] === "write");
  assert.equal(opts.kind, "parked-answer");
  assert.equal(opts.target, "j1");
  assert.equal(opts.afterDigest, createHash("sha256").update("ship it").digest("hex"), "the row carries the answer's digest");
  assert.ok(!JSON.stringify(opts).includes("ship it"), "and never its text");
  assert.equal(opts.failure, answerFailure);
  assert.match(h.notes.at(-1)[0], /answered: the run resumes as j2; follow it with \/dispatch chat j2/);
});

test("reply: refusals are printed verbatim, and nothing is written for a refused plan or a declined confirm", async () => {
  const refusal = "j1 is being answered: j9 is queued or running on o/r#7";
  const refused = harness({ doc: doc("reply"), plan: { refusal } });
  await dispatchChat("j1", refused.io);
  assert.deepEqual(refused.notes.at(-1), [`chat: ${refusal}`, "error"]);
  assert.ok(!refused.log.some((l) => l[0] === "confirm" || l[0] === "write"));

  const dup = "an answer to this issue is already queued or running (job j8), so the queue's semantic window took this one as a duplicate and nothing was queued";
  const late = harness({ doc: doc("reply"), writeResult: { refusal: dup, deduplicated: true } });
  await dispatchChat("j1", late.io);
  assert.deepEqual(late.notes.at(-1), [`chat: ${dup}`, "error"], "the enqueue's refusal, verbatim");

  const audit = harness({ doc: doc("reply"), writeResult: { ok: false, invalid: "the audit log could not be written, so nothing was changed; check PI_LOGS_DIR", refused: "x" } });
  await dispatchChat("j1", audit.io);
  assert.match(audit.notes.at(-1)[0], /^chat: the audit log could not be written/);

  const declined = harness({ doc: doc("reply"), confirm: false });
  await dispatchChat("j1", declined.io);
  assert.ok(!declined.log.some((l) => l[0] === "write"));
  assert.match(declined.notes.at(-1)[0], /not answered; nothing was queued/);

  const left = harness({ doc: doc("reply"), input: null });
  await dispatchChat("j1", left.io);
  assert.ok(!left.log.some((l) => l[0] === "planAnswer"), "Esc at the input plans nothing");
  assert.match(left.notes.at(-1)[0], /left without answering/);
});

test("reply: without a transcript the question points at the forge link", async () => {
  const h = harness({ doc: doc("reply") });
  await dispatchChat("j1", h.io);
  assert.match(h.notes[0][0], /the question is on https:\/\/github\.com\/o\/r\/issues\/7/);
});

test("fork: plans with the deployment's PI_SESSIONS_DIR, stops the TUI before pi and starts it after", async () => {
  const fork = fakeFork();
  const h = harness({ doc: doc("fork", { newerRunOnTarget: "j5" }), fork });
  await dispatchChat("j1", h.io);
  const plan = fork.calls.find((c) => c[0] === "planFork")[1];
  assert.equal(plan.env.PI_SESSIONS_DIR, "/srv/sessions");
  assert.equal(plan.record, FULL_RECORD, "the record the fleet read, not the document's safe run");
  assert.equal(plan.key, null);
  assert.equal(plan.newerRunOnTarget, "j5");
  assert.equal(plan.force, false);
  assert.equal(plan.piVersion, "1.2.0");
  const order = [...h.log.map((l) => l[0]), ...[]].filter((n) => n.startsWith("tui.") || n === "custom");
  assert.deepEqual(order, ["custom", "tui.stop", "tui.start", "tui.requestRender"]);
  const run = fork.calls.find((c) => c[0] === "runFork")[1];
  assert.equal(run.tools, false, "tools off");
  assert.equal(run.cwd, "/work");
  assert.equal(run.agentDir, "/agent");
  assert.deepEqual(run.env, { PATH: "/bin" });
  assert.equal(typeof run.proc.exit, "function", "a signal at the question never exits pi: the seam answers no instead");
  assert.equal(run.canAsk, true, "the panel's own reader says whether there is a terminal to ask on");
  assert.equal(typeof run.registerCleanup, "function");
  assert.ok(h.log.findIndex((l) => l[0] === "tui.stop") < h.log.findIndex((l) => l[0] === "tui.start"));
  assert.deepEqual(h.log.find((l) => l[0] === "tui.requestRender"), ["tui.requestRender", true], "a full redraw");
  assert.ok(!h.log.some((l) => l[0] === "pause"), "a clean exit is not held");
  assert.match(h.notes.at(-1)[0], /back from the fork/);
});

test("fork: the TUI comes back after a throw, and a refusal is held on screen before the redraw", async () => {
  const seen = [];
  const throwing = fakeFork({ run: async () => { seen.push("ran"); throw new Error("spawn EACCES"); } });
  const h = harness({ doc: doc("fork"), fork: throwing });
  h.io.ui.custom = async (factory) => new Promise((resolve) => {
    const tui = { stop: () => seen.push("stop"), start: () => seen.push("start"), requestRender: () => seen.push("render") };
    factory(tui, null, null, resolve);
  });
  await dispatchChat("j1", h.io);
  assert.deepEqual(seen, ["stop", "ran", "start", "render"]);
  assert.match(h.notes.at(-1)[0], /the fork failed \(spawn EACCES\)/);

  const one = harness({ doc: doc("fork"), fork: fakeFork({ run: async () => 1 }) });
  await dispatchChat("j1", one.io);
  const names = one.log.map((l) => l[0]);
  assert.ok(names.indexOf("pause") > names.indexOf("tui.stop") && names.indexOf("pause") < names.indexOf("tui.start"), "held while the terminal is still the fork's");
  assert.match(one.notes.at(-1)[0], /exit code 1/);
});

test("fork: a session key always forks, with no fleet read; a plan refusal never stops the TUI", async () => {
  const fork = fakeFork();
  const h = harness({ fork });
  await dispatchChat(KEY, h.io);
  assert.ok(!h.log.some((l) => l[0] === "openReader" || l[0] === "lookup"), "a key asks nobody about a run");
  const plan = fork.calls.find((c) => c[0] === "planFork")[1];
  assert.equal(plan.key, KEY);
  assert.equal(plan.record, null);
  assert.ok(h.log.some((l) => l[0] === "tui.stop"));

  const refusal = "PI_SESSIONS_DIR is not set for this deployment, so there is no session store on this host to fork from";
  const no = harness({ fork: fakeFork({ refusal }) });
  await dispatchChat(KEY, no.io);
  assert.deepEqual(no.notes.at(-1), [`chat: ${refusal}`, "error"]);
  assert.ok(!no.log.some((l) => l[0] === "custom" || l[0] === "tui.stop"), "nothing hands the terminal over for a refusal");

  const noTui = harness({ fork: fakeFork(), ui: { custom: undefined } });
  await dispatchChat(KEY, noTui.io);
  assert.match(noTui.notes.at(-1)[0], /pi-dispatch chat 0123456789abcdef0123456789abcdef in a shell/);
});

test("no mode: the rule's sentence; a failed lookup: its sentence and an Azure item's candidates", async () => {
  const h = harness({ doc: doc(null) });
  await dispatchChat("j1", h.io);
  assert.deepEqual(h.notes, [[`chat: ${CHAT_REFUSALS.queued}`, "warning"]]);
  assert.ok(!h.log.some((l) => ["openDashboard", "input", "custom"].includes(l[0])));

  const many = harness({ lookupResult: { status: 409, body: { error: "that work item has runs in more than one repository of its project; give one of these run ids", candidates: [{ target: "p/a#3", jobId: "ja" }, { target: "p/b#3", jobId: "jb" }] } } });
  await dispatchChat("https://dev.azure.com/org/p/_workitems/edit/3", many.io);
  const [text, level] = many.notes[0];
  assert.equal(level, "error");
  assert.match(text, /^chat: that work item has runs in more than one repository/);
  assert.match(text, /ja {2}p\/a#3/);
  assert.match(text, /\/dispatch chat <run-id>/);
  assert.ok(many.reader.disposed, "the reader is closed on every path");

  const bad = harness({});
  await dispatchChat("not a run", bad.io);
  assert.equal(bad.notes[0][1], "warning");
  assert.ok(!bad.log.some((l) => l[0] === "openReader"));
});

test("questionFromTranscript pages from the cursor, keeps the last assistant entry, and caps it", async () => {
  const pages = { start: { entries: [{ kind: "assistant", text: "old" }], next: "1-1" }, "1-1": { entries: [{ kind: "assistant", text: "x".repeat(5000) }], next: "1-2" }, "1-2": { entries: [], next: "1-2" } };
  const calls = [];
  const fleet = { transcriptSince: async (id, after) => (calls.push(after), pages[after ?? "start"]) };
  const q = await questionFromTranscript(fleet, "j1");
  assert.deepEqual(calls, [null, "1-1", "1-2"]);
  assert.deepEqual(q, { text: "x".repeat(4000), cut: true });
  assert.equal(await questionFromTranscript({ transcriptSince: async () => { throw new Error("down"); } }, "j1"), null);
  assert.equal(await questionFromTranscript({ transcriptSince: async () => ({ unreachable: "x" }) }, "j1"), null);
});

/** A TTY stdin as pi leaves it after `tui.stop()`: cooked, paused; it records raw-mode changes and pauses. */
function fakeTty() {
  const t = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, modes: [], pauses: 0, resumes: 0 });
  t.setRawMode = (on) => {
    t.isRaw = on;
    t.modes.push(on);
    return t;
  };
  t.resume = () => {
    t.resumes += 1;
  };
  t.pause = () => {
    t.pauses += 1;
  };
  return t;
}
const listeners = (t) => ["data", "end", "close"].map((e) => t.listenerCount(e));

const until = (pred, ms = 3000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const poll = () => (pred() ? resolve() : Date.now() - started > ms ? reject(new Error("timed out")) : setTimeout(poll, 2));
  poll();
});
const sink = () => ({ text: "", write(s) { this.text += s; } });
/** Ask on a fake terminal: `pre` is typed before the question shows, `keys` after it; what was echoed after the question. */
async function askOn(keys, { pre = [], opts = {} } = {}) {
  const input = fakeTty();
  const output = sink();
  const got = terminalAsk({ input, output, ...opts }).ask("go? ");
  assert.equal(input.isRaw, true, "raw while asked, so Ctrl+D and Ctrl+C are bytes, not an end and a signal");
  assert.deepEqual(listeners(input), [1, 1, 1]);
  for (const k of pre) input.emit("data", Buffer.from(k));
  await until(() => output.text.includes("go? "));
  for (const k of keys) input.emit("data", typeof k === "string" ? Buffer.from(k) : k);
  const answer = await got;
  return { answer, input, echo: output.text.slice(output.text.indexOf("go? ") + 4) };
}

test("terminalAsk reads a LINE in raw mode: yes only for a trimmed y or yes (any case) on Enter; any other line, Ctrl+C, Ctrl+D, Esc no; then raw mode restored, input paused, no listener left", { timeout: 30_000 }, async () => {
  for (const [keys, want] of [
    [["y\r"], true], [["Y\r"], true], [["yes\r"], true], [["YeS\n"], true], [["y", "e", "s", "\r"], true], [["  yes \r"], true],
    [["yx\x7f\r"], true], [["yx\b\r"], true],
    [["\r"], false], [["n\r"], false], [["no\r"], false], [["maybe\r"], false], [["why?\r"], false], [["sorry, no\r"], false], [["yeah\r"], false], [["y y\r"], false],
    [["y", "\x03"], false], [["y\x04"], false], [["y\x1b", "\r"], false], [["y\x1b[A", "\r"], false],
  ]) {
    const { answer, input } = await askOn(keys);
    assert.equal(answer, want, JSON.stringify(keys));
    assert.equal(input.isRaw, false, "the mode is put back as it was");
    assert.deepEqual(input.modes, [true, false]);
    assert.equal(input.pauses, 1, "the input is paused again");
    assert.deepEqual(listeners(input), [0, 0, 0], "nothing is left to read pi's input when the TUI starts again");
  }
  // A terminal pi left raw is left raw.
  const raw = fakeTty();
  raw.isRaw = true;
  const out = sink();
  const r = terminalAsk({ input: raw, output: out }).ask("go? ");
  await until(() => out.text.includes("go? "));
  raw.emit("data", Buffer.from("y\r"));
  assert.equal(await r, true);
  assert.equal(raw.isRaw, true);
});

test("terminalAsk echoes the line and edits it, but never an escape sequence or a control byte; a key split across chunks is one key; the line stops at 64 characters", { timeout: 30_000 }, async () => {
  assert.equal((await askOn(["yx\x7fes\r"])).echo, "yx\b \bes\n", "Backspace takes the last character off the screen too");
  const arrow = await askOn(["y\x1b[A", "\r"]);
  assert.doesNotMatch(arrow.echo, /\[A|\x1b/, "an arrow key is never painted as raw bytes");
  assert.equal((await askOn(["y\tz\x01\r"])).echo, "yz\n", "Tab and other control bytes are ignored, not echoed");
  const e = Buffer.from("é");
  const split = await askOn([e.subarray(0, 1), e.subarray(1), "\r"]);
  assert.equal(split.echo, "é\n", "the two halves of a UTF-8 key are one key, never U+FFFD");
  const capped = await askOn([`${" ".repeat(64)}y\r`]);
  assert.equal(capped.answer, false, "a 65th character is dropped, so the y never counts");
  assert.equal(capped.echo, `${" ".repeat(64)}\n`, "and never echoed");
  assert.equal((await askOn([`y${" ".repeat(100)}\r`])).answer, true, "the kept 64 are judged trimmed");
});

test("terminalAsk drains: a key typed before the question never answers it, and nothing typed after the answer is left for the next reader", { timeout: 30_000 }, async () => {
  const early = await askOn(["\r"], { pre: ["y"] });
  assert.equal(early.answer, false, "the y typed before the prompt was drained, so Enter alone is a no");
  assert.equal(early.echo, "\n");
  assert.equal((await askOn(["y\r"], { pre: ["n", "o"] })).answer, true, "and an early no does not stick either");
  // Typing that never stops: the question still shows, at the drain's bound.
  const input = fakeTty();
  const output = sink();
  const got = terminalAsk({ input, output, drainIdleMs: 50, drainMaxMs: 200 }).ask("go? ");
  // It stops at the question itself, so no x can land in the answer's line.
  const typing = setInterval(() => (output.text.includes("go? ") ? clearInterval(typing) : input.emit("data", Buffer.from("x"))), 10);
  try {
    await until(() => output.text.includes("go? "), 1500);
  } finally {
    clearInterval(typing);
  }
  input.emit("data", Buffer.from("yes\r"));
  assert.equal(await got, true);
  // After Enter: the rest of the chunk and keys a moment later are read and discarded until the quiet window passes
  // (widened here to 400 ms, so a loaded machine's late timer cannot make the check below race the drain).
  const after = fakeTty();
  const out = sink();
  let settled = false;
  const answer = terminalAsk({ input: after, output: out, drainIdleMs: 400, drainMaxMs: 5000 }).ask("go? ");
  void answer.then(() => (settled = true));
  await until(() => out.text.includes("go? "));
  after.emit("data", Buffer.from("yes\rzz"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, "the answer waits for the drain");
  assert.deepEqual(listeners(after), [1, 1, 1], "a reader is still taking the keys");
  after.emit("data", Buffer.from("kk"));
  const last = Date.now();
  assert.equal(await answer, true);
  assert.ok(Date.now() - last >= 350, "the drain ran to quiet after the last key");
  assert.doesNotMatch(out.text, /z|k/, "the trailing keys were read and dropped, never echoed and never left buffered");
  assert.deepEqual(listeners(after), [0, 0, 0]);
});

test("terminalAsk: an end or close of the input is a no; an abort is a no; no TTY is a no with canAsk false", { timeout: 5000 }, async () => {
  const output = { text: "", write(s) { this.text += s; } };
  for (const event of ["end", "close"]) {
    const input = fakeTty();
    const got = terminalAsk({ input, output }).ask("go? ");
    input.emit(event);
    assert.equal(await got, false, event);
    assert.deepEqual(listeners(input), [0, 0, 0]);
  }
  const input = fakeTty();
  const a = terminalAsk({ input, output });
  const aborted = a.ask("go? ");
  a.abort();
  assert.equal(await aborted, false);
  assert.deepEqual(listeners(input), [0, 0, 0]);
  assert.doesNotThrow(() => a.abort(), "an abort after the end is a no-op");
  const out = { text: "", write(s) { this.text += s; } };
  const none = terminalAsk({ input: { isTTY: false }, output: out });
  assert.equal(none.canAsk, false);
  assert.equal(await none.ask("go? "), false);
  assert.match(out.text, /no terminal to answer on/);
});

test("terminalAsk on a real terminal: a key typed before the question is drained, Ctrl+D is a no and never ends stdin, a yes split across writes is a yes, the keys after it never reach the next reader (skipped without script(1))", { timeout: 30_000 }, async (t) => {
  // eof2's scenario, headless: `script` gives the child a pseudo-terminal; the child asks, gets Ctrl+D, then reads on.
  const { spawnSync } = await import("node:child_process");
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no script(1) form known here");
  if (spawnSync("sh", ["-c", "command -v script"]).status !== 0) return t.skip("no script(1)");
  const dir = tempDir("admin-dchat-pty-");
  const child = join(dir, "child.mjs");
  const mod = fileURLToPath(new URL("../src/dispatch-chat.mjs", import.meta.url));
  writeFileSync(child, `import { terminalAsk } from ${JSON.stringify(mod)};
const a = terminalAsk({ input: process.stdin, output: process.stdout });
process.stdin.on("end", () => process.stdout.write("[ENDED]\\n"));
process.stdout.write("[READY]\\n");
await new Promise((r) => setTimeout(r, 600));
const r = await a.ask("Open it? [y/N] ");
process.stdout.write("[ANSWER " + r + "]\\n");
const r2 = await a.ask("Again? [y/N] ");
process.stdout.write("[ANSWER2 " + r2 + "]\\n");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (d) => { process.stdout.write("[DATA " + JSON.stringify(String(d)) + "]\\n"); process.exit(0); });
setTimeout(() => { process.stdout.write("[NO DATA]\\n"); process.exit(3); }, 4000);
`);
  const { spawn } = await import("node:child_process");
  // Through `cat |`: node's own stdio pipes are sockets, on which macOS script(1) cannot read terminal attributes.
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(child)}`;
  const inner = process.platform === "darwin" ? `script -q /dev/null ${cmd}` : `script -qec ${JSON.stringify(cmd)} /dev/null`;
  const p = spawn("sh", ["-c", `cat | ${inner}`], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => {
    out += String(d);
  });
  const wait = (re) => new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (re.test(out)) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`timed out waiting for ${re}: ${JSON.stringify(out)}`));
    }, 10_000);
  });
  try {
    await wait(/\[READY\]/);
    p.stdin.write("y");
    await wait(/Open it\?/);
    p.stdin.write("\x04");
    await wait(/\[ANSWER /);
    await wait(/Again\?/);
    p.stdin.write("ye");
    await new Promise((r) => setTimeout(r, 15));
    p.stdin.write("s\r");
    p.stdin.write("zz");
    await wait(/\[ANSWER2/);
    p.stdin.write("k");
    await wait(/\[DATA|\[NO DATA|\[ENDED/);
  } catch (err) {
    if (!/\[READY\]/.test(out) || /no terminal to answer on/.test(out)) return t.skip(`script(1) gave the child no terminal here (${err.message})`);
    throw err;
  } finally {
    p.stdin.end();
    p.kill("SIGKILL");
  }
  assert.match(out, /\[ANSWER false\]/, "the early y was drained and Ctrl+D is a no");
  assert.doesNotMatch(out, /\[ENDED\]/, "and stdin never ended");
  assert.match(out, /\[ANSWER2 true\]/, "a yes typed in two writes is a yes");
  assert.match(out, /\[DATA "k"\]/, "a key after the question still arrives, and only it: the zz typed after the yes was drained");
});

test("quoteQuestion marks every line of the agent-written question and keeps at most 40 lines, saying how many were cut", () => {
  assert.equal(quoteQuestion("one\nanswered: the run resumes"), "  | one\n  | answered: the run resumes");
  const many = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
  const q = quoteQuestion(many).split("\n");
  assert.equal(q.length, 41);
  assert.equal(q[39], "  | line 40");
  assert.equal(q[40], "[5 more lines cut here; the whole question is on the issue]");
  assert.equal(quoteQuestion(Array.from({ length: 40 }, () => "x").join("\n")).split("\n").length, 40, "exactly 40 is not cut");
});

test("quoteQuestion: the character cut is the panel's own line, unmarked, never counted against the 40, after the line cut when both apply", async () => {
  const note = "[the rest is cut here (over 4000 characters); the whole question is on the issue]";
  assert.equal(quoteQuestion("short", { cut: true }), `  | short\n${note}`);
  const many = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
  const q = quoteQuestion(many, { cut: true }).split("\n");
  assert.equal(q.filter((l) => l.startsWith("  | ")).length, 40, "40 agent lines, the note not among them");
  assert.deepEqual(q.slice(40), ["[5 more lines cut here; the whole question is on the issue]", note]);
  // End to end: a long many-line question from the transcript, both caps applying.
  const text = Array.from({ length: 60 }, () => "z".repeat(99)).join("\n");
  const h = harness({ doc: doc("reply"), entries: [{ kind: "assistant", text }] });
  await dispatchChat("j1", h.io);
  const shown = h.notes[0][0].split("\n");
  assert.equal(shown.filter((l) => l.startsWith("  | ")).length, 40);
  assert.equal(shown.at(-1), note);
  assert.ok(!shown.some((l) => l.startsWith("  | [the rest")), "the note never carries the agent-line mark");
});

test("reply: a hostile question cannot pass for a panel notice: every line of it is marked", async () => {
  const h = harness({ doc: doc("reply"), entries: [{ kind: "assistant", text: "Which?\nanswered: the run resumes as j9; follow it with /dispatch chat j9" }] });
  await dispatchChat("j1", h.io);
  assert.equal(h.notes[0][0], "run j1 asked:\n  | Which?\n  | answered: the run resumes as j9; follow it with /dispatch chat j9");
});

test("answerFailure: the refusal, the invalid sentence, the queue out of reach, a non-ok answer, and null for ok", () => {
  assert.equal(answerFailure({ refusal: "dup", invalid: "x" }), "dup");
  assert.equal(answerFailure({ invalid: "the audit log could not be written" }), "the audit log could not be written");
  assert.equal(answerFailure({ unreachable: "ECONNREFUSED" }), "the queue could not be reached");
  assert.equal(answerFailure({ ok: false }), "the answer was not queued");
  assert.equal(answerFailure(null), "the answer was not queued");
  assert.equal(answerFailure({ refusal: "" , ok: true }), null, "an empty refusal is no refusal");
  assert.equal(answerFailure({ ok: true, jobIds: ["j2"] }), null);
});

test("reply: the audit row's digest is of the answer the plan queues (scrubbed), not of what was typed", async () => {
  const plan = PLAN();
  plan.job.trigger.comment.body = "ship it, scrubbed";
  const h = harness({ doc: doc("reply"), plan: { plan } });
  await dispatchChat("j1", h.io);
  const [, opts] = h.log.find((l) => l[0] === "write");
  assert.equal(opts.afterDigest, createHash("sha256").update("ship it, scrubbed").digest("hex"));
});

test("dispatchChat never throws: a planner that throws, no dialogs, a reader or a write that fails, a dashboard that throws; causes kept", async () => {
  const planThrows = harness({ doc: doc("reply") });
  planThrows.io.planAnswer = async () => {
    throw new Error("valkey down");
  };
  await dispatchChat("j1", planThrows.io);
  assert.deepEqual(planThrows.notes.at(-1), ["chat: the answer could not be planned (valkey down); nothing was queued", "error"]);

  for (const missing of ["input", "confirm"]) {
    const h = harness({ doc: doc("reply"), ui: { [missing]: undefined } });
    await dispatchChat("j1", h.io);
    assert.match(h.notes.at(-1)[0], /answering needs pi's dialogs/, missing);
    assert.ok(!h.log.some((l) => l[0] === "planAnswer"));
  }

  const readFails = harness({ doc: doc("live") });
  readFails.io.lookup = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:6379");
  };
  await dispatchChat("j1", readFails.io);
  assert.deepEqual(readFails.notes.at(-1), ["chat: the run could not be read (ECONNREFUSED 127.0.0.1:6379)", "error"]);
  assert.ok(readFails.reader.disposed);

  const unreachable = harness({ doc: doc("reply"), writeResult: { unreachable: "ETIMEDOUT" } });
  await dispatchChat("j1", unreachable.io);
  assert.deepEqual(unreachable.notes.at(-1), ["chat: could not reach the queue: ETIMEDOUT", "error"]);
  const writeThrows = harness({ doc: doc("reply") });
  writeThrows.io.write = async () => {
    throw new Error("EACCES");
  };
  await dispatchChat("j1", writeThrows.io);
  assert.deepEqual(writeThrows.notes.at(-1), ["chat: could not reach the queue: EACCES", "error"]);

  const dash = harness({ doc: doc("live") });
  dash.io.openDashboard = async () => {
    throw new Error("overlay gone");
  };
  await assert.doesNotReject(dispatchChat("j1", dash.io));
  assert.deepEqual(dash.notes.at(-1), ["chat: failed (overlay gone)", "error"]);
});

test("the argument: trimmed, a run id at most 200 characters; a live run's activeJobId outside the charset tails the run itself", async () => {
  assert.deepEqual(classifyDispatchChatTarget("  j1\n"), { kind: "id", id: "j1" });
  assert.deepEqual(classifyDispatchChatTarget(` ${KEY} `), { kind: "key", key: KEY });
  assert.deepEqual(classifyDispatchChatTarget("x".repeat(200)), { kind: "id", id: "x".repeat(200) });
  assert.match(classifyDispatchChatTarget("x".repeat(201)).refusal, /neither a run id/);
  const h = harness({ doc: doc("live", { activeJobId: "recovery 9\u001b[2J" }) });
  await dispatchChat("j1", h.io);
  assert.deepEqual(h.log.find((l) => l[0] === "openDashboard")[1], { initialTail: "j1" }, "a hostile activeJobId never reaches the dashboard");
});

test("reply: a forge link that is not http(s) is never shown as where the question is", async () => {
  const h = harness({ doc: doc("reply", { forgeLink: "javascript:alert(1)" }) });
  await dispatchChat("j1", h.io);
  assert.doesNotMatch(h.notes[0][0], /javascript/);
  assert.match(h.notes[0][0], /the question is in the run's last comment on its issue/);
});

test("fork: with no record from the fleet the document's safe run is judged", async () => {
  const fork = fakeFork();
  const d = doc("fork");
  const h = harness({ fork, lookupResult: { id: "j1", doc: d, record: null } });
  await dispatchChat("j1", h.io);
  assert.equal(fork.calls.find((c) => c[0] === "planFork")[1].record, d.run);
});

test("fork: a no-op SIGINT listener is held from before tui.stop() until after tui.start(), across the y/N, pi and the hold", async () => {
  const proc = fakeProc();
  const seen = [];
  const count = () => proc.listenerCount("SIGINT");
  const fork = fakeFork({ run: async () => (seen.push(["runFork", count()]), 1) });
  const h = harness({ doc: doc("fork"), fork, proc });
  h.io.forkIo.pause = async () => seen.push(["pause", count()]);
  h.io.ui.custom = async (factory) => new Promise((resolve) => {
    const tui = { stop: () => seen.push(["stop", count()]), start: () => seen.push(["start", count()]), requestRender: () => {} };
    factory(tui, null, null, resolve);
  });
  await dispatchChat("j1", h.io);
  assert.deepEqual(seen, [["stop", 1], ["runFork", 1], ["pause", 1], ["start", 1]]);
  assert.equal(count(), 0, "removed once pi's screen is back");
  assert.deepEqual(["SIGTERM", "SIGHUP", "exit"].map((e) => proc.listenerCount(e)), [0, 0, 0]);
  proc.listeners("SIGINT").forEach((l) => l());
});

test("fork: SIGTERM, SIGHUP or exit while pi runs removes the unredacted copy FIRST, before the host pi's own handler", async () => {
  for (const event of ["SIGTERM", "SIGHUP", "exit"]) {
    const proc = fakeProc();
    const order = [];
    proc.on(event, () => order.push("pi's own handler"));
    const fork = fakeFork({
      run: async (a) => {
        a.registerCleanup(() => order.push("copy removed"));
        proc.emit(event);
        return 0;
      },
    });
    const h = harness({ doc: doc("fork"), fork, proc });
    await dispatchChat("j1", h.io);
    assert.deepEqual(order, ["copy removed", "pi's own handler"], event);
    assert.equal(proc.listenerCount(event), 1, `${event}: only pi's own handler is left`);
  }
});

test("fork: a signal at the y/N aborts the question, is said once as an interruption (never 'back from the fork'), and is held before the redraw", { timeout: 5000 }, async () => {
  const proc = fakeProc();
  const input = fakeTty();
  const output = { text: "", write(s) { this.text += s; } };
  const fork = fakeFork({
    run: async (a) => {
      const answer = a.ask("Open it? [y/N] ");
      a.proc.exit(143); // runFork's SIGTERM handler, with the copy removed
      assert.equal(await answer, false, "the question is answered no");
      return 143;
    },
  });
  const h = harness({ doc: doc("fork"), fork, proc });
  h.io.forkIo.makeAsk = () => terminalAsk({ input, output });
  await dispatchChat("j1", h.io);
  assert.deepEqual(h.notes.at(-1), ["chat: not forked: the question was interrupted by a signal; the copy was removed", "warning"]);
  const names = h.log.map((l) => l[0]);
  assert.ok(names.indexOf("pause") > names.indexOf("tui.stop") && names.indexOf("pause") < names.indexOf("tui.start"));
  assert.deepEqual(listeners(input), [0, 0, 0]);

  const declined = harness({ doc: doc("fork"), fork: fakeFork({ run: async (a) => ((await a.ask("q")) ? 3 : 0) }) });
  declined.io.forkIo.makeAsk = () => ({ canAsk: true, ask: async () => false, abort() {} });
  await dispatchChat("j1", declined.io);
  assert.deepEqual(declined.notes.at(-1), ["chat: not forked (you answered no); the copy was removed", "info"]);
  assert.ok(!declined.log.some((l) => l[0] === "pause"));
});

test("fork: a fork that throws is held on screen before the redraw too; with no terminal the reader says canAsk false", async () => {
  const h = harness({ doc: doc("fork"), fork: fakeFork({ run: async () => { throw new Error("spawn EACCES"); } }) });
  await dispatchChat("j1", h.io);
  const names = h.log.map((l) => l[0]);
  assert.ok(names.includes("pause") && names.indexOf("pause") < names.indexOf("tui.start"));
  const fork = fakeFork({ run: async () => 1 });
  const none = harness({ doc: doc("fork"), fork });
  none.io.forkIo.makeAsk = () => terminalAsk({ input: { isTTY: false }, output: { write() {} } });
  await dispatchChat("j1", none.io);
  assert.equal(fork.calls.find((c) => c[0] === "runFork")[1].canAsk, false, "runFork refuses before copying");
});

test("fork: a tui.stop() or tui.start() that throws never rejects, says what failed (never a fork's exit code), and every listener is removed", { timeout: 10_000 }, async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const [name, tui, notes, forked] of [
      ["stop throws", { stop() { throw new Error("stop broke"); } }, [["chat: failed (pi's screen could not be stopped for the fork, so nothing was forked: stop broke)", "error"]], false],
      ["start throws", { start() { throw new Error("start broke"); } }, [["chat: failed (pi's screen could not be started again after the fork: start broke)", "error"], ["chat: back from the fork (pi's fork, if you opened one, is in your pi's sessions folder)", "info"]], true],
      ["both throw", { stop() { throw new Error("stop broke"); }, start() { throw new Error("start broke"); } }, [["chat: failed (pi's screen could not be stopped for the fork, so nothing was forked: stop broke; pi's screen could not be started again after the fork: start broke)", "error"]], false],
    ]) {
      const proc = fakeProc();
      const fork = fakeFork();
      const h = harness({ doc: doc("fork"), fork, proc });
      const started = [];
      h.io.ui.custom = async (factory) => new Promise((resolve) => {
        factory({ stop() {}, start: () => started.push("start"), requestRender() {}, ...tui }, null, null, resolve);
      });
      await dispatchChat("j1", h.io);
      assert.deepEqual(h.notes.slice(-notes.length), notes, name);
      assert.ok(!h.notes.some(([m]) => /exit code/.test(m)), `${name}: no exit code for a fork that ${forked ? "ended 0" : "never ran"}`);
      assert.equal(fork.calls.some((c) => c[0] === "runFork"), forked, `${name}: runFork ${forked ? "ran" : "never ran"}`);
      if (!("start" in tui)) assert.deepEqual(started, ["start"], `${name}: pi's screen is still started again after a stop that threw`);
      assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((e) => proc.listenerCount(e)), [0, 0, 0, 0], `${name}: every listener removed`);
    }
    // What handOver's own steps do not catch (here a seam whose removal throws) is caught too: said, and the dialog settles.
    const proc = fakeProc();
    proc.removeListener = () => {
      throw new Error("seam broke");
    };
    const h = harness({ doc: doc("fork"), proc });
    await dispatchChat("j1", h.io);
    assert.deepEqual(h.notes.at(-1), ["chat: failed (seam broke)", "error"]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], "nothing rejects unhandled, which would end the operator's pi");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("questionFromTranscript: an ended stream stops the paging; a whitespace-only entry is no question; the cap is exactly 4000; an escaped CRLF is one break", async () => {
  const calls = [];
  const pages = { start: { entries: [{ kind: "assistant", text: "the question" }], next: "1-1", ended: true }, "1-1": { entries: [{ kind: "assistant", text: "AFTER THE END" }], next: "1-2", ended: true } };
  assert.deepEqual(await questionFromTranscript({ transcriptSince: async (id, after) => (calls.push(after), pages[after ?? "start"]) }, "j1"), { text: "the question", cut: false });
  assert.deepEqual(calls, [null]);
  const blank = { transcriptSince: async () => ({ entries: [{ kind: "assistant", text: "real" }, { kind: "assistant", text: " \n\t " }], next: null }) };
  assert.deepEqual(await questionFromTranscript(blank, "j1"), { text: "real", cut: false });
  const at = (n) => ({ transcriptSince: async () => ({ entries: [{ kind: "assistant", text: "y".repeat(n) }], next: null }) });
  assert.deepEqual(await questionFromTranscript(at(4000), "j1"), { text: "y".repeat(4000), cut: false }, "4000 is shown whole");
  assert.deepEqual(await questionFromTranscript(at(4001), "j1"), { text: "y".repeat(4000), cut: true });
  const crlf = { transcriptSince: async () => ({ entries: [{ kind: "assistant", text: "a\\u{000D}\\u{000A}b\r\nc" }], next: null }) };
  assert.deepEqual(await questionFromTranscript(crlf, "j1"), { text: "a\nb\nc", cut: false });
});

test("the bolt: admin's classifyDispatchChatTarget and the CLI's classifyChatTarget agree on kind and payload, and on the URL limit", () => {
  assert.equal(FORGE_URL_MAX, CHAT_URL_MAX, "one URL limit");
  const inputs = ["", " ", KEY, KEY.toUpperCase(), ` ${KEY} `, `${KEY}0`, "HTTPS://github.com/o/r/issues/1", "https://github.com/o/r/pull/2", "http://[bad", `https://x/${"a".repeat(FORGE_URL_MAX - 10)}`, `https://x/${"a".repeat(FORGE_URL_MAX - 9)}`, "ftp://x", "j1", "a b", "repeat:n:1", "recovery:j1.2", "x".repeat(200), "x".repeat(201), "https:/x", "https://", " j1 ", "j1\n", "bad\u0007arg", "j/1", "é"];
  for (const s of inputs) {
    const a = classifyDispatchChatTarget(s);
    const b = classifyChatTarget(s);
    const shape = (r) => (r.refusal !== undefined ? { refused: true } : r);
    assert.deepEqual(shape(a), shape(b), JSON.stringify(s).slice(0, 60));
  }
});

// ---- the wiring in index.ts, through pi's own loader ----

process.env.PI_LOGS_DIR = tempDir("admin-dchat-");
process.env.PI_CODING_AGENT_DIR = tempDir("admin-dchat-agent-");
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);

async function registered() {
  const mod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const commands = [];
  const tools = [];
  const sent = [];
  mod.default({ registerCommand: (n, d) => commands.push([n, d]), registerTool: (t) => tools.push(t), sendMessage: (m) => sent.push(m), on: () => {} });
  return { mod, def: commands[0][1], tools, sent };
}

test("/dispatch chat is a command: in the usage, the help line and the completions, never a tool", async () => {
  const { def, tools, sent } = await registered();
  assert.match(def.description, /\|logs\|chat\|/);
  assert.ok(def.getArgumentCompletions("ch").some((i) => i.value === "chat"));
  assert.equal(def.getArgumentCompletions("chat zz-no-such-run"), null, "run ids from this host's history, none here");
  assert.ok(!tools.some((t) => /chat/.test(t.name)), "no model-callable chat tool");
  const notes = [];
  await def.handler("chat", { ui: { notify: (m, l) => notes.push([m, l]) } });
  assert.deepEqual(notes.at(-1), [CHAT_USAGE, "warning"]);
  await def.handler("chat a b", { ui: { notify: (m, l) => notes.push([m, l]) } });
  assert.deepEqual(notes.at(-1), [CHAT_USAGE, "warning"], "one run, never two");
  await def.handler("chat bad\u0007arg", { ui: { notify: (m, l) => notes.push([m, l]) } });
  assert.match(notes.at(-1)[0], /neither a run id/);
  assert.equal(sent.length, 0, "nothing reaches the model channel");
  const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  assert.match(src, /usage: \/dispatch <[^>]*\|chat\|/);
});

test("the built extension bundle inlines chat-fork but no pi-tui, no terminal chat view and no chat CLI", { timeout: 120_000 }, async () => {
  // The bundle build.mjs makes, in memory (nothing written to admin/dist): same entry, same externals. The admin's
  // only pi-tui use is keys.mjs's RUNTIME require through the host pi (`piRequire`), never an inlined copy, and the
  // chat-fork import must not change that: the terminal chat's pi-tui view lives in chat-view.mjs, which chat-cli.mjs
  // loads, so neither may be reached.
  const { build } = await import("esbuild");
  const res = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    outfile: "index.mjs",
    write: false,
    metafile: true,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
    logLevel: "silent",
  });
  const inputs = Object.keys(res.metafile.inputs);
  assert.ok(inputs.some((p) => /src\/chat-fork\.mjs$/.test(p)), "chat-fork is inlined");
  assert.ok(inputs.some((p) => /src\/dispatch-chat\.mjs$/.test(p)));
  assert.deepEqual(inputs.filter((p) => /pi-tui|chat-view\.mjs|chat-cli\.mjs|console-client\.mjs/.test(p)), []);
  const text = res.outputFiles[0].text;
  assert.equal((text.match(/piRequire\("@earendil-works\/pi-tui"\)/g) ?? []).length, 1, "pi-tui is still reached once, at run time, through the host pi");
});

test("chatIo: the deployment's env, a read-only reader, the panel's planner, the enqueue on the deployment's Valkey, the dashboard's tail, the agent dir, fork lines scrubbed per line", async () => {
  const { mod } = await registered();
  const { scrubControlsPerLine } = await import("../src/panel.mjs");
  process.env.PI_SESSIONS_DIR = "/srv/dchat-sessions";
  try {
    const seen = {};
    const written = [];
    const paths = { valkeyUrl: "redis://127.0.0.1:1/5", logsDir: "/nowhere/logs", triggersPath: "/nowhere/triggers.json", settingsFile: "/nowhere/settings.json" };
    const io = mod.chatIo(paths, { ui: {}, cwd: "/w" }, () => {}, {
      readerFn: (p, o) => ((seen.reader = [p, o]), { reader: true }),
      planFn: async (a) => ((seen.plan = a), { plan: true }),
      enqueueFn: async (plan, o) => ((seen.enqueue = [plan, o]), { ok: true }),
      dashboardFn: async (p, c, n, o) => {
        seen.dash = o;
      },
      stdout: { write: (s) => written.push(s) },
    });
    assert.equal(io.env.PI_SESSIONS_DIR, "/srv/dchat-sessions", "the deployment's env is what planFork judges the store by");
    assert.deepEqual(io.openReader(), { reader: true });
    assert.equal(seen.reader[0], paths);
    assert.equal(seen.reader[1].readOnly, true, "the lookup's reader is read-only");
    await io.planAnswer({ jobId: "j1", text: "t" });
    assert.equal(seen.plan.from, "panel", "signed as the panel, whose trail says the /dispatch panel answered");
    assert.equal(seen.plan.by, undefined, "no token name is claimed");
    assert.deepEqual([seen.plan.url, seen.plan.logsDir, seen.plan.triggersPath, seen.plan.jobId, seen.plan.text], [paths.valkeyUrl, paths.logsDir, paths.triggersPath, "j1", "t"]);
    assert.equal(seen.plan.env, io.env);
    await io.enqueueAnswer("PLAN");
    assert.deepEqual(seen.enqueue, ["PLAN", { url: paths.valkeyUrl }]);
    await io.openDashboard({ initialTail: "jA" });
    assert.deepEqual(seen.dash, { initialTail: "jA" });
    assert.equal(io.forkIo.agentDir, process.env.PI_CODING_AGENT_DIR, "pi's agent dir as pi resolves it: PI_CODING_AGENT_DIR first");
    assert.equal(io.forkIo.cwd, "/w");
    const line = "copied to /h/x\u001b[2J\nsecond\u0007 line";
    io.forkIo.out(line);
    assert.deepEqual(written, [`${scrubControlsPerLine(line)}\n`]);
    assert.ok(!written[0].includes("\u001b") && !written[0].includes("\u0007") && written[0].includes("\n"), "controls gone, the line break kept");
  } finally {
    delete process.env.PI_SESSIONS_DIR;
  }
});

test("chatIo's real dashboard opener: the run's tail on the FIRST opening only; a CRUD round trip reopens on the LIST", { timeout: 30_000 }, async () => {
  const { mod } = await registered();
  const { resolvePaths } = await import("../src/read-model.mjs");
  const { stripAnsi } = await import("../src/style.mjs");
  const screens = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify() {},
      custom: (factory) =>
        new Promise((resolve) => {
          const comp = factory({ requestRender() {} }, null, null, () => {});
          setTimeout(async () => {
            screens.push(stripAnsi(comp.render(100).join("\n")));
            await comp.dispose?.();
            resolve(screens.length === 1 ? { action: "openInsights" } : undefined);
          }, 30);
        }),
    },
  };
  const paths = resolvePaths({ ...process.env, VALKEY_URL: "redis://127.0.0.1:1" });
  await mod.chatIo(paths, ctx, () => {}).openDashboard({ initialTail: "jA" });
  assert.equal(screens.length, 2);
  assert.match(screens[0], /┌─ live jA ─/, "opened on the run's tail");
  assert.doesNotMatch(screens[1], /live jA/, "the reopening after the action is the LIST");
});

test("/dispatch chat's completions are this host's run ids that start with what was typed", async () => {
  const { def } = await registered();
  writeFileSync(join(process.env.PI_LOGS_DIR, "jalpha.json"), "{}");
  writeFileSync(join(process.env.PI_LOGS_DIR, "kbeta.json"), "{}");
  assert.deepEqual(def.getArgumentCompletions("chat j"), [{ value: "chat jalpha", label: "jalpha" }]);
  assert.equal(def.getArgumentCompletions("chat zz"), null);
});
