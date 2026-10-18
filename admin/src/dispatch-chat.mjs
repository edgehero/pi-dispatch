/**
 * `/dispatch chat <run-id | issue-or-PR-url | session-key>` (issue #647, part 2, REQ-TERMINAL-CHAT): a run's chat from
 * inside pi, the panel's twin of `pi-dispatch chat`. Pi-free, so its tests drive it with fakes; index.ts wires the real
 * fleet reader, dialogs, dashboard and audit writer in.
 *
 * ONE RULE FOR THE MODE. The run is resolved by `resolveRunChat` (`console/run-api.mjs`), the function `/api/run`
 * answers with, over the panel's own fleet reader, so a link or an id names the same run, in the same mode
 * (`chatModeOf`), here, in a browser and in a terminal. The panel reads Valkey directly (it is the deployment's own
 * operator surface, as its LIST and PARKED views are), where `pi-dispatch chat` goes through the console's HTTP API.
 *
 *   - live: the dashboard opens on that run's LIVE_TAIL (`makeDashboard({ initialTail })`); Esc lands on its ACTIVE
 *     row, where `t` and `T` steer, through the panel's own audited steer;
 *   - reply: the question (the last assistant entry of the run's live transcript, else where it was posted), then
 *     `ui.input` for the answer, `planParkedAnswer` (free: every refusal said before anything is written), a confirm
 *     naming what it starts and holds, then `enqueueParkedAnswer` inside the panel's audited write (kind
 *     `parked-answer`, the console's, its row carrying the answer's sha256 and never its text). Refusals verbatim;
 *   - fork: `planFork` (`@edgehero/pi-dispatch/chat-fork`, the CLI's checks, over the deployment's PI_SESSIONS_DIR),
 *     then the TUI handed over (`tui.stop()`), `runFork`'s y/N and pi with inherited stdio, then `tui.start()`, the
 *     sandbox `b` key's order, with the start in a `finally`, so a throw cannot leave pi's screen suspended. A
 *     32-hex session key always forks, with no fleet read at all. WHILE THE TERMINAL IS HANDED OVER (`handOver`) pi
 *     must survive what a bare terminal sends it: a no-op SIGINT listener is held from before `tui.stop()` until after
 *     `tui.start()` (with the terminal cooked, Ctrl+C is a SIGINT, and with no listener Node's default ends pi); the
 *     y/N is a line read in raw mode (`terminalAsk`), drained of buffered keys before and after, yes only for y or
 *     yes, so Ctrl+D is a "no" and never ends stdin, which pi's keyboard needs after `tui.start()`; and the unredacted copy's removal (`runFork`'s `registerCleanup`) runs FIRST
 *     on SIGTERM and SIGHUP (prepended, before pi's own handler can exit) and on `exit`;
 *   - no mode: the rule's sentence (`says`).
 *
 * WHY THE ARGUMENT CLASSES ARE NOT `classifyChatTarget`. That function lives in `worker/src/chat-cli.mjs`, which
 * imports the pi-tui view (dynamically, but a bundler follows a literal dynamic import), and the admin bundle must not
 * carry pi-tui (a test builds it and looks). The rule is the same three shapes in the same order, and the key's shape is
 * imported (`SESSION_KEY_PATTERN`), not restated.
 */
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { SESSION_KEY_PATTERN } from "@edgehero/pi-dispatch/session-key";
import * as chatFork from "@edgehero/pi-dispatch/chat-fork";
import { resolveRunChat } from "./console/run-api.mjs";
import { reserveText, runFieldsLines } from "./console/actions.mjs";
import { FORGE_URL_MAX } from "./read-model.mjs";

/** The usage line, also printed for a missing or malformed argument. */
export const CHAT_USAGE = "usage: /dispatch chat <run-id | issue-or-PR-url | session-key>";

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** The most lines of a question shown; the rest is on the forge, and a line says how many were cut. */
const QUESTION_MAX_LINES = 40;
/** Each line of a question is shown behind this, so agent-written text can never pass for one of the panel's notices. */
const QUESTION_MARK = "  | ";
/** How long a fork's non-zero end stays on the bare terminal before pi redraws over it (a timer, never a key). */
const FORK_HOLD_MS = 2500;

/** How much of a transcript the question is looked for in: the stream's retained entries, in pages of 200. */
const QUESTION_PAGES_MAX = 20;
/** The longest question shown, in characters; the rest is on the forge, and the line says so. */
const QUESTION_MAX_CHARS = 4000;
/** A line break in an entry's text: a real one, or the worker's escaped spelling of one (`escapeControls`). */
const TRANSCRIPT_BREAK = /\\u\{000D\}\\u\{000A\}|\\u\{000A\}|\r?\n/g;

/**
 * What the argument names: `{ kind: "key", key }`, `{ kind: "url", url }`, `{ kind: "id", id }` or `{ refusal }`. A key
 * is tested first (32 lowercase hex is never read as a job id), then an http(s) link that parses, then the run-id
 * charset.
 */
export function classifyDispatchChatTarget(arg) {
  const s = typeof arg === "string" ? arg.trim() : "";
  if (s === "") return { refusal: CHAT_USAGE };
  if (SESSION_KEY_PATTERN.test(s)) return { kind: "key", key: s };
  if (/^https?:\/\//i.test(s)) {
    if (s.length > FORGE_URL_MAX) return { refusal: `the link is longer than ${FORGE_URL_MAX} characters` };
    try {
      new URL(s);
    } catch {
      return { refusal: "the link does not parse" };
    }
    return { kind: "url", url: s };
  }
  if (RUN_ID_RE.test(s)) return { kind: "id", id: s };
  return { refusal: `the argument is neither a run id (letters, digits and . _ : -), an issue or pull request link, nor a 32-hex session key. ${CHAT_USAGE}` };
}

/**
 * The parked run's question: the last non-empty assistant entry of its live transcript, read through the fleet
 * reader's `transcriptSince` (bounded pages), with the worker's escaped line breaks made lines again: `{ text, cut }`,
 * `cut` when the text was longer than `QUESTION_MAX_CHARS` and is shown cut. Null when there is no transcript, no
 * assistant entry, or the read fails. Dialogs scrub what they show (`gateDialogs`), so this only shapes it. The cut is
 * a flag, never a note appended to the text: appended, the note was one of the agent's lines to `quoteQuestion`,
 * marked as the agent's and counted against its 40.
 */
export async function questionFromTranscript(fleet, jobId) {
  if (typeof fleet?.transcriptSince !== "function") return null;
  let cursor = null;
  let last = null;
  try {
    for (let page = 0; page < QUESTION_PAGES_MAX; page += 1) {
      const res = await fleet.transcriptSince(jobId, cursor);
      if (!Array.isArray(res?.entries)) break;
      for (const e of res.entries) if (e?.kind === "assistant" && typeof e.text === "string" && e.text.trim() !== "") last = e.text;
      if (typeof res.next === "string") cursor = res.next;
      if (res.ended === true || res.entries.length === 0 || typeof res.next !== "string") break;
    }
  } catch {
    return null;
  }
  if (last === null) return null;
  const text = last.replace(TRANSCRIPT_BREAK, "\n").trim();
  return text.length > QUESTION_MAX_CHARS ? { text: text.slice(0, QUESTION_MAX_CHARS), cut: true } : { text, cut: false };
}

/**
 * A question's text as a notice shows it: every line behind `QUESTION_MARK`, at most `QUESTION_MAX_LINES` of them, then
 * a line saying how many were cut, then (`cut`, from `questionFromTranscript`) a line saying the characters were. The
 * question is agent-written (it may quote the issue), so without the mark a line of it reading "answered: the run
 * resumes" would look like the panel's own words under it.
 */
export function quoteQuestion(text, { cut = false } = {}) {
  const lines = String(text).split("\n");
  const shown = lines.slice(0, QUESTION_MAX_LINES).map((l) => `${QUESTION_MARK}${l}`);
  if (lines.length > QUESTION_MAX_LINES) shown.push(`[${lines.length - QUESTION_MAX_LINES} more lines cut here; the whole question is on the issue]`);
  // The character cut is the panel's own line, unmarked and outside the 40, like the line cut's.
  if (cut) shown.push(`[the rest is cut here (over ${QUESTION_MAX_CHARS} characters); the whole question is on the issue]`);
  return shown.join("\n");
}

/** The longest answer line kept, in characters: a "yes" needs three; anything typed past this is dropped, never echoed. */
const ASK_LINE_MAX = 64;
/** The drain's quiet window and bound, pi's own `drainInput(1000, 50)`: input is discarded until 50 ms pass with none, at most 1 s. */
const ASK_DRAIN_IDLE_MS = 50;
const ASK_DRAIN_MAX_MS = 1000;

/**
 * A y/N asked on the terminal while pi's TUI is stopped: `{ ask, abort, canAsk }`. `canAsk` is whether the input is a
 * terminal (`runFork` refuses before copying anything when it is not). `ask(question)` resolves true only for a line
 * that is exactly y or yes (trimmed, any case) ended by Enter, and false for any other line, for Ctrl+C, Ctrl+D or Esc,
 * for the input ending or closing, for no terminal, and when `abort()` is called (`runFork`'s signal handler, through
 * the proc seam in `handOver`).
 *
 * A LINE, READ IN RAW MODE. Raw, because `tui.stop()` leaves the terminal cooked and a cooked read ends badly: Ctrl+D
 * on an empty line ENDS stdin, for good, and pi's keyboard is dead once `tui.start()` asks it for data again (a cooked
 * Ctrl+C is a SIGINT, which `handOver` holds a listener for). In raw mode both are plain bytes, read here as "no". A
 * line, not one key (round 2): a key read answered on the first y anywhere, so "why?" or "sorry, no" forked, and a y
 * typed into pi a moment before the question (still buffered) answered a question nobody had seen. So the line is
 * echoed and edited (Backspace) here, and judged whole on Enter.
 *
 * DRAINED ON BOTH SIDES. Before the question is shown, whatever is already buffered is read and discarded until 50 ms
 * of quiet (bounded at 1 s, pi's own `drainInput(1000, 50)`), so no key typed before the prompt can answer it. After
 * the answer, the same drain, so the rest of a fast-typed line ("yes" then more keys, the \n of a \r\n) reaches
 * neither the forked pi nor pi's own TUI when it starts again.
 *
 * ANY ESC IS A NO, NEVER PARSED. An arrow key or any other escape sequence starts with ESC, as a bare Esc does, and a
 * chunk boundary can fall anywhere inside a sequence, so telling them apart needs pi-tui's timing parser; echoing the
 * bytes would paint junk and keep them in the line. A mis-pressed arrow answering no costs one re-run, never an
 * unwanted fork, and the drain after it swallows the rest of the sequence. Other control bytes (Tab and the like) are
 * ignored, never echoed.
 *
 * The raw mode is put back as it was, the input paused, and every listener this added removed whichever way it ends,
 * so nothing of it is left to read pi's input once the TUI starts again (`console-client`'s `askYesNo` cannot be
 * aborted, and reads cooked lines).
 */
export function terminalAsk({ input = process.stdin, output = process.stderr, drainIdleMs = ASK_DRAIN_IDLE_MS, drainMaxMs = ASK_DRAIN_MAX_MS } = {}) {
  let finish = null;
  return {
    canAsk: input?.isTTY === true,
    ask(question) {
      if (!input?.isTTY) {
        output.write(`${question}\nno terminal to answer on, so the answer is no\n`);
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        const wasRaw = input.isRaw === true;
        // "drain" discards (before the question and after the answer); "line" reads the answer.
        let phase = "drain";
        let lastData = Date.now();
        let line = "";
        let timer = null;
        // A key's UTF-8 bytes can be split across two chunks; the decoder holds the first half instead of a U+FFFD.
        const decoder = new StringDecoder("utf8");
        const drain = (then) => {
          phase = "drain";
          lastData = Date.now();
          const until = lastData + drainMaxMs;
          const tick = () => {
            timer = null;
            if (finish === null) return;
            const now = Date.now();
            if (now - lastData >= drainIdleMs || now >= until) return then();
            timer = setTimeout(tick, Math.max(1, Math.min(drainIdleMs - (now - lastData), until - now)));
          };
          timer = setTimeout(tick, Math.max(1, Math.min(drainIdleMs, drainMaxMs)));
        };
        const answer = (yes) => {
          output.write("\n");
          drain(() => finish?.(yes));
        };
        const onData = (chunk) => {
          lastData = Date.now();
          const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
          if (phase !== "line") return;
          for (const ch of text) {
            if (ch === "\r" || ch === "\n") return answer(/^(y|yes)$/i.test(line.trim()));
            if (ch === "\x03" || ch === "\x04" || ch === "\x1b") return answer(false);
            if (ch === "\x7f" || ch === "\b") {
              if (line !== "") {
                line = Array.from(line).slice(0, -1).join("");
                output.write("\b \b");
              }
              continue;
            }
            if (ch < " " || (ch >= "\x80" && ch <= "\x9f")) continue;
            if (Array.from(line).length >= ASK_LINE_MAX) continue;
            line += ch;
            output.write(ch);
          }
        };
        const onEnd = () => finish?.(false);
        finish = (yes) => {
          finish = null;
          if (timer !== null) clearTimeout(timer);
          input.removeListener("data", onData);
          input.removeListener("end", onEnd);
          input.removeListener("close", onEnd);
          try {
            input.setRawMode?.(wasRaw);
          } catch {
            // a terminal that went away has no mode to restore
          }
          input.pause?.();
          resolve(yes);
        };
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("close", onEnd);
        try {
          input.setRawMode?.(true);
        } catch {
          // no raw mode: the keys still arrive, a line at a time
        }
        input.resume?.();
        drain(() => {
          phase = "line";
          output.write(question);
        });
      });
    },
    abort() {
      finish?.(false);
    },
  };
}

/** The sha256 of an answer, the audit row's `afterDigest` (INT-CONSOLE-AUDIT-LOG: the digest, never the text). */
const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

/** A parked-answer enqueue's failure, for the audit row: the refusal it names, or the queue out of reach. */
export function answerFailure(res) {
  if (typeof res?.refusal === "string" && res.refusal !== "") return res.refusal;
  if (typeof res?.invalid === "string" && res.invalid !== "") return res.invalid;
  if (res?.unreachable !== undefined) return "the queue could not be reached";
  if (res?.ok !== true) return "the answer was not queued";
  return null;
}

/**
 * Run `/dispatch chat <arg>`. `io`:
 *   - `ui`: the command's (gated) `ctx.ui`: `notify`, `input`, `confirm`, `custom`;
 *   - `env`: the deployment's environment (`deploymentEnv()`): its PI_SESSIONS_DIR, and the forge hosts a link names;
 *   - `openReader()`: a fleet reader (`createFleetReader`), disposed here once the run is judged;
 *   - `lookup(fleet, query, env)`: `resolveRunChat` by default;
 *   - `openDashboard({ initialTail })`: the overlay, opened on that job's live tail;
 *   - `planAnswer({ jobId, text })`: `planParkedAnswer` bound to the deployment, `from` the panel;
 *   - `write(opts, fn)`: the panel's audited write (`panelWrite` over the deployment's logs directory);
 *   - `enqueueAnswer(plan)`: `enqueueParkedAnswer` bound to the deployment's Valkey;
 *   - `fork`: `{ resolvePiBinary, piVersionOf, planFork, runFork }` (the chat-fork module by default);
 *   - `forkIo`: `{ hostEnv, cwd, agentDir, out, makeAsk, proc, pause }` for the fork's run (`handOver`).
 * Never throws: every failure is a notice (a seam that throws where no step expects it included).
 */
export async function dispatchChat(arg, io) {
  try {
    await chatOf(arg, io);
  } catch (err) {
    try {
      io?.ui?.notify?.(`chat: failed (${err?.message ?? String(err)})`, "error");
    } catch {
      // nowhere left to say it
    }
  }
}

async function chatOf(arg, io) {
  const notify = (text, level = "info") => io.ui?.notify?.(text, level);
  const target = classifyDispatchChatTarget(arg);
  if (target.refusal) {
    notify(target.refusal, "warning");
    return;
  }
  if (target.kind === "key") {
    await forkRun(io, { record: null, key: target.key, newerRunOnTarget: null, label: target.key });
    return;
  }
  let fleet = null;
  let got;
  let question = null;
  try {
    fleet = io.openReader();
    got = await (io.lookup ?? resolveRunChat)(fleet, target.kind === "url" ? { url: target.url } : { id: target.id }, io.env ?? {});
    if (got?.doc?.mode === "reply") question = await questionFromTranscript(fleet, got.id);
  } catch (err) {
    notify(`chat: the run could not be read (${err?.message ?? String(err)})`, "error");
    return;
  } finally {
    try {
      await fleet?.dispose?.();
    } catch {
      // best-effort teardown
    }
  }
  if (!got?.doc) {
    const lines = [`chat: ${String(got?.body?.error ?? "the run could not be looked up")}`];
    const candidates = Array.isArray(got?.body?.candidates) ? got.body.candidates : [];
    for (const c of candidates) lines.push(`  ${String(c?.jobId ?? "")}  ${String(c?.target ?? "")}`);
    if (candidates.length > 0) lines.push("  name one of them: /dispatch chat <run-id>");
    notify(lines.join("\n"), "error");
    return;
  }
  const { id, doc, record } = got;
  if (doc.mode === "live") {
    const tail = typeof doc.activeJobId === "string" && RUN_ID_RE.test(doc.activeJobId) ? doc.activeJobId : id;
    await io.openDashboard({ initialTail: tail });
    return;
  }
  if (doc.mode === "reply") {
    await reply(io, { id, doc, question });
    return;
  }
  if (doc.mode === "fork") {
    // This host's own record when the fleet read one (the local run history first, then the mirror), else the
    // document's safe fields: the record `pi-dispatch chat` judges a fork on, the same way round.
    await forkRun(io, { record: record ?? doc.run ?? null, key: null, newerRunOnTarget: typeof doc.newerRunOnTarget === "string" ? doc.newerRunOnTarget : null, label: id });
    return;
  }
  notify(`chat: ${typeof doc.says === "string" && doc.says !== "" ? doc.says : "this run has no chat to open"}`, "warning");
}

/** The reply mode: question, answer, plan, confirm, the audited enqueue. */
async function reply(io, { id, doc, question }) {
  const notify = (text, level = "info") => io.ui?.notify?.(text, level);
  const where = typeof doc.forgeLink === "string" && /^https?:\/\//.test(doc.forgeLink) ? doc.forgeLink : null;
  notify(question !== null ? `run ${id} asked:\n${quoteQuestion(question.text, { cut: question.cut })}` : where ? `run ${id} parked on a question; the question is on ${where}` : `run ${id} parked on a question; the question is in the run's last comment on its issue (no transcript to read it from)`, "info");
  if (typeof io.ui?.input !== "function" || typeof io.ui?.confirm !== "function") {
    notify(`chat: answering needs pi's dialogs, which this session has none of; answer on the console's parked page, or with pi-dispatch chat ${id}`, "warning");
    return;
  }
  const text = await io.ui.input(`Your answer to run ${id} (it resumes the run; Esc leaves without answering)`, "the answer");
  if (typeof text !== "string" || text.trim() === "") {
    notify("chat: left without answering", "info");
    return;
  }
  let planned;
  try {
    planned = await io.planAnswer({ jobId: id, text });
  } catch (err) {
    planned = { refusal: `the answer could not be planned (${err?.message ?? String(err)}); nothing was queued` };
  }
  if (!planned?.plan) {
    notify(`chat: ${String(planned?.refusal ?? "the answer could not be planned; nothing was queued")}`, "error");
    return;
  }
  const p = planned.plan;
  const answer = String(p.job?.trigger?.comment?.body ?? "");
  const reserve = reserveText(p.reserve);
  const message = [
    `Answer parked run ${id} on ${String(p.forge)}, from the panel.`,
    `It resumes the parked transcript on queue ${String(p.queue)}; once the job passes every check and reserve, the worker posts one comment on the issue saying it was answered from an operator's /dispatch panel, quoting the answer.`,
    ...runFieldsLines(p.runFields, "It runs as the comment trigger says now"),
    ...(reserve ? [reserve] : []),
    "",
    "The answer:",
    answer,
  ].join("\n");
  const ok = await io.ui.confirm(`Answer run ${id}?`, message);
  if (!ok) {
    notify("chat: not answered; nothing was queued", "info");
    return;
  }
  let res;
  try {
    res = await io.write({ kind: "parked-answer", target: id, afterDigest: sha256(answer), failure: answerFailure }, () => io.enqueueAnswer(p));
  } catch (err) {
    res = { unreachable: err?.message ?? String(err) };
  }
  if (res?.ok === true) {
    const jobs = Array.isArray(res.jobIds) ? res.jobIds.map(String) : [];
    notify(`answered: the run resumes${jobs.length > 0 ? ` as ${jobs.join(", ")}` : ""}; follow it with /dispatch chat ${jobs[0] ?? id}`, "info");
    return;
  }
  const why = typeof res?.refusal === "string" ? res.refusal : typeof res?.invalid === "string" ? res.invalid : res?.unreachable !== undefined ? `could not reach the queue: ${String(res.unreachable)}` : "the answer was not queued";
  notify(`chat: ${why}`, "error");
}

/** The fork mode: plan (free), then the TUI handed to pi and taken back (`handOver`). */
async function forkRun(io, { record, key, newerRunOnTarget, label }) {
  const notify = (text, level = "info") => io.ui?.notify?.(text, level);
  const fork = io.fork ?? chatFork;
  const f = io.forkIo ?? {};
  const hostEnv = f.hostEnv ?? process.env;
  let planned;
  try {
    const pi = fork.resolvePiBinary({ env: hostEnv });
    const piVersion = pi?.path ? fork.piVersionOf(pi.path, { env: hostEnv }) : null;
    planned = fork.planFork({ record, key, env: io.env ?? {}, force: false, newerRunOnTarget, pi, piVersion });
  } catch (err) {
    planned = { refusal: `the fork could not be judged (${err?.message ?? String(err)})` };
  }
  if (!planned?.plan) {
    notify(`chat: ${String(planned?.refusal ?? "the fork could not be planned")}`, "error");
    return;
  }
  if (typeof io.ui?.custom !== "function") {
    notify(`chat: the fork hands the terminal to pi, which needs pi's TUI; run pi-dispatch chat ${label} in a shell on this host instead`, "warning");
    return;
  }
  const result = await io.ui.custom((tui, _theme, _keybindings, done) => {
    // Never a bare `void`: a rejection here would be unhandled, and an unhandled rejection ends the operator's pi.
    // `handOver` catches what its own steps throw; this is for what is left (a listener that cannot be added), and it
    // still settles the dialog, once, so the command never waits forever.
    let settled = false;
    const once = (value) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    handOver({ fork, plan: planned.plan, f, hostEnv, tui, done: once }).catch((err) => {
      const cause = err?.message ?? String(err);
      if (settled) notify(`chat: failed (${cause})`, "error");
      else once({ code: null, failed: cause });
    });
    return { render: () => [], invalidate() {}, handleInput() {} };
  });
  const code = result?.code;
  if (typeof result?.failed === "string") {
    // What failed was the handover itself, not the fork: "exit code 1" would name a run that never happened.
    notify(`chat: failed (${result.failed})`, "error");
    return;
  }
  if (typeof result?.screen === "string") notify(`chat: failed (${result.screen})`, "error");
  if (code !== null && typeof code === "object") notify(`chat: the fork failed (${String(code.error)})`, "error");
  else if (result?.interrupted) notify("chat: not forked: the question was interrupted by a signal; the copy was removed", "warning");
  else if (result?.answered === false) notify("chat: not forked (you answered no); the copy was removed", "info");
  else notify(code === 0 ? "chat: back from the fork (pi's fork, if you opened one, is in your pi's sessions folder)" : `chat: the fork ended with exit code ${String(code)}`, code === 0 ? "info" : "warning");
}

/**
 * The terminal handed to `runFork` and taken back; resolves `done({ code, answered, interrupted, failed, screen })`.
 * `failed` names a `tui.stop()` that threw (then nothing was forked, and the code is not the fork's), `screen` a
 * `tui.start()` that threw; neither is ever thrown on, since this runs unawaited inside `ui.custom`. `f.proc` is the
 * process seam (`on`, `prependListener`, `removeListener`, `stdin`), the real process by default.
 *
 * From before `tui.stop()` until after `tui.start()` (the y/N, the copy, pi, the hold) three listeners are held, and
 * removed in the `finally`:
 *   - SIGINT, a no-op: with the TUI stopped the terminal is cooked, so Ctrl+C is a signal, and a process with no SIGINT
 *     listener takes Node's default and ENDS (here: the operator's pi, with its screen suspended);
 *   - SIGTERM and SIGHUP, PREPENDED, and `exit`: the copy's removal from `runFork` (`registerCleanup`), synchronous. Pi's
 *     own handler for these can end the process before `runFork`'s (added after it) run, which would leave the
 *     unredacted copy in ~/.pi-dispatch/chat; prepended, the removal runs first whatever then exits.
 * `runFork` gets a proc whose `exit` does not end pi: it records the signal and aborts the question, and `runFork` then
 * returns the signal's exit code with the copy removed. `canAsk` is the panel's own reader's (`terminalAsk.canAsk`).
 */
async function handOver({ fork, plan, f, hostEnv, tui, done }) {
  const proc = f.proc ?? process;
  let code = 1;
  let answered = null;
  let interrupted = false;
  let removeCopy = null;
  const holdSigint = () => {};
  const cleanup = () => {
    try {
      removeCopy?.();
    } catch {
      // the removal is best-effort here; runFork removes the copy itself on every path it sees
    }
  };
  const first = (signal, handler) => (typeof proc.prependListener === "function" ? proc.prependListener(signal, handler) : proc.on(signal, handler));
  let failed = null;
  let screen = null;
  const why = (err) => err?.message ?? String(err);
  try {
    // Added inside the try, so a seam that throws on one still has every one removed in the `finally`.
    proc.on("SIGINT", holdSigint);
    first("SIGTERM", cleanup);
    first("SIGHUP", cleanup);
    first("exit", cleanup);
    try {
      tui?.stop?.();
    } catch (err) {
      // pi's screen may still own the terminal: pi with inherited stdio under it would fight it for every key, so no fork.
      failed = `pi's screen could not be stopped for the fork, so nothing was forked: ${why(err)}`;
    }
    if (failed === null) {
      try {
        const asker = (f.makeAsk ?? terminalAsk)();
        const seam = {
          on: (s, h) => proc.on(s, h),
          removeListener: (s, h) => proc.removeListener(s, h),
          exit: () => {
            interrupted = true;
            asker.abort();
          },
          stdin: proc.stdin,
        };
        code = await fork.runFork({
          plan,
          ask: async (q) => (answered = (await asker.ask(q)) === true),
          out: f.out ?? ((line) => process.stdout.write(`${line}\n`)),
          agentDir: f.agentDir ?? null,
          cwd: f.cwd ?? process.cwd(),
          tools: false,
          env: hostEnv,
          proc: seam,
          canAsk: asker.canAsk === true,
          registerCleanup: (fn) => {
            removeCopy = fn;
          },
        });
      } catch (err) {
        code = { error: why(err) };
      }
      try {
        // A refusal, a failure or an interruption printed on the bare terminal would be painted over by the redraw before
        // anyone read it: held a moment first, as the sandbox's refusals are (a timer, never a key: see `pauseForMessage`).
        if (code !== 0) await (f.pause ?? (() => new Promise((r) => setTimeout(r, FORK_HOLD_MS))))();
      } catch {
        // the pause is a courtesy
      }
    }
  } finally {
    // The `b` key's guarantee: whatever the fork did, pi's screen comes back and is redrawn whole, also after a stop()
    // that threw (it may have half stopped). The listeners go only after it, so a Ctrl+C up to the last moment of the
    // handover is still not pi's end. A start() that throws is said, never thrown: thrown, it would be unhandled.
    try {
      tui?.start?.();
      tui?.requestRender?.(true);
    } catch (err) {
      screen = `pi's screen could not be started again after the fork: ${why(err)}`;
    }
    proc.removeListener("SIGINT", holdSigint);
    proc.removeListener("SIGTERM", cleanup);
    proc.removeListener("SIGHUP", cleanup);
    proc.removeListener("exit", cleanup);
    if (failed !== null && screen !== null) failed = `${failed}; ${screen}`;
    done({ code, answered, interrupted, failed, screen });
  }
}
