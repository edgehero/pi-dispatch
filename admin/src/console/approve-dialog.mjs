/**
 * Signing in by approving a dialog on the host (issue #882, the owner's "do not have to leave the webpage"): the
 * sign-in page's "Sign in on this computer" asks the host's DESKTOP, in a system dialog, whether to let that browser in.
 *
 * WHY A DIALOG, AND NOT "THE SAME OS ACCOUNT AS THE CONSOLE". A loopback request's peer process can be traced to its
 * account (Linux /proc, macOS lsof), and a browser runs as the operator. REJECTED: a job container's traffic reaches the
 * host through helpers that run as the operator too (Docker Desktop's backend, OrbStack, rootless Podman's
 * pasta/slirp4netns), so an agent in a job would pass that check and sign itself in as an operator; the Host and Origin
 * checks do not stop it, since a script sets any header it likes. A container can send HTTP; it cannot click a dialog
 * on the operator's screen. That is the whole of the trust here, and it is why the dialog is the credential.
 *
 * WHAT HOLDS IT:
 * - The dialog shows a 4-character MATCH CODE that the page shows too, so the person can tell their own request from
 *   one a container fired at the same moment, and it names where the request came from.
 * - One request waits at a time (`busy`), and every ask spends the console's sign-in limiter (server.mjs), so a
 *   container spamming requests shows dialogs the person denies, and cannot queue them up.
 * - The request id the page waits on is 256 random bits, given only to the browser that asked: an allowed request
 *   signs in exactly that browser, once (`take`).
 * - The default button is Deny, and an unanswered dialog gives up (`APPROVAL_WAIT_MS`).
 * - Every outcome is on the audit log (`login-approval`), the allowed sign-in by `startSession` and the rest by the
 *   server's `onSettle`.
 * The approval is a credential the HOST makes, as a link or a code is, so the browser is remembered where a host-made
 * sign-in may be (server.mjs `hostMade`) and `OQ-058` is untouched: no browser ever lets another browser in.
 *
 * WHERE IT WORKS. macOS through `osascript` (a LaunchAgent in the person's GUI session shows the dialog: measured on
 * 2026-11-14 on macOS 27, no permission asked), Linux through `zenity` or `kdialog` where the console's environment has
 * a display (`DISPLAY` or `WAYLAND_DISPLAY`). Anywhere else, or a macOS console started over SSH with no GUI session
 * (the dialog then fails, said as `error`), the page points to `pi-dispatch console` and the code. Windows: none.
 */
import { spawn } from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

/** How long a dialog waits for an answer before it gives up, and the page with it. */
export const APPROVAL_WAIT_MS = 60_000;
/** How long an answered request is kept for its page to collect (an allowed one is then gone, unanswered). */
export const APPROVAL_KEEP_MS = 30_000;
/** The match code's letters: no 0/O, 1/I/L, so it reads the same on the page and in the dialog. */
export const MATCH_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const MATCH_LENGTH = 4;
/** What a dialog answered, and what the server records for each (`login-approval` rows). */
export const APPROVAL_ANSWERS = Object.freeze(["allow", "deny", "timeout", "error"]);

const OSASCRIPT = "/usr/bin/osascript";
// env-internal DISPLAY: read to know whether a Linux console can show a window (X11), never set or passed on but to the tool.
// env-internal WAYLAND_DISPLAY: the same, for a Wayland session.
// env-internal PATH: searched for zenity and kdialog, as a shell would.

/** Whether an executable named `name` is on `envPath`. */
function onPath(name, envPath, access) {
  for (const dir of String(envPath ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      access(join(dir, name), fsConstants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

/**
 * How this host can ask its desktop: `{ available: true, tool, ask }`, or `{ available: false, why }`. `ask({ message,
 * names, timeoutMs })` resolves `{ answer, name? }`, never rejects: `allow` (with the operator `name` chosen, the only one
 * when there is one), `deny`, `timeout`, or `error` (the dialog could not be shown). Every string reaches the dialog as an
 * ARGUMENT, never inside script text, so no token name or address can inject AppleScript or a shell word.
 */
export function dialogRunnerFor({ platform = process.platform, env = process.env, access = accessSync, spawnFn = spawn } = {}) {
  const run = (cmd, args, timeoutMs) => new Promise((resolve) => {
    let out = "";
    let done = false;
    let timedOut = false;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // The tools' own give-up is the first bound (osascript's `giving up after`, zenity's `--timeout`); this one is for a
    // tool that has none (osascript's list, kdialog) or that hangs: the dialog goes with its process.
    const timer = setTimeout(() => {
      // Marked before the kill: the process's close can arrive at once, and must read as this give-up, never as an error.
      timedOut = true;
      try { child?.kill("SIGTERM"); } catch {}
      finish({ code: null, out, timedOut: true });
    }, timeoutMs + 2_000);
    try {
      child = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      return finish({ code: null, out: "", spawnFailed: true });
    }
    child.stdout?.on("data", (d) => { out += String(d); });
    child.on("error", () => finish({ code: null, out, spawnFailed: true }));
    child.on("close", (code) => finish({ code, out, timedOut }));
  });
  const seconds = (ms) => String(Math.max(1, Math.round(ms / 1000)));

  if (platform === "darwin") {
    try {
      access(OSASCRIPT, fsConstants.X_OK);
    } catch {
      return { available: false, why: "osascript is missing" };
    }
    const ask = async ({ message, names, timeoutMs = APPROVAL_WAIT_MS }) => {
      // One operator: Allow or Deny, Deny the default. Several: the person picks who signs in; Deny closes the list.
      const script = names.length === 1
        ? ["on run argv", 'set r to display dialog (item 1 of argv) buttons {"Deny", "Allow"} default button "Deny" with title "pi-dispatch" with icon caution giving up after ((item 2 of argv) as integer)', 'if gave up of r then return "timeout"', "return button returned of r", "end run"]
        : ["on run argv", 'set r to choose from list (items 3 thru -1 of argv) with title "pi-dispatch" with prompt (item 1 of argv) OK button name "Allow" cancel button name "Deny"', 'if r is false then return "Deny"', 'return "Allow:" & (item 1 of r)', "end run"];
      const args = [...script.flatMap((line) => ["-e", line]), message, seconds(timeoutMs), ...names];
      const got = await run(OSASCRIPT, args, timeoutMs);
      if (got.timedOut) return { answer: "timeout" };
      if (got.spawnFailed || got.code !== 0) return { answer: "error" };
      const said = got.out.trim();
      if (said === "timeout") return { answer: "timeout" };
      if (said === "Deny") return { answer: "deny" };
      if (said === "Allow" && names.length === 1) return { answer: "allow", name: names[0] };
      const picked = said.startsWith("Allow:") ? said.slice("Allow:".length) : null;
      return picked !== null && names.includes(picked) ? { answer: "allow", name: picked } : { answer: "error" };
    };
    return { available: true, tool: "osascript", ask };
  }

  if (platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { available: false, why: "no display in the console's environment" };
    const zenity = onPath("zenity", env.PATH, access);
    const kdialog = zenity ? null : onPath("kdialog", env.PATH, access);
    if (!zenity && !kdialog) return { available: false, why: "neither zenity nor kdialog is installed" };
    const ask = async ({ message, names, timeoutMs = APPROVAL_WAIT_MS }) => {
      let got;
      if (zenity) {
        const common = ["--title=pi-dispatch", `--text=${message}`, "--ok-label=Allow", "--cancel-label=Deny", `--timeout=${seconds(timeoutMs)}`];
        got = await run(zenity, names.length === 1 ? ["--question", "--icon-name=dialog-warning", ...common] : ["--list", ...common, "--column=Sign in as", ...names], timeoutMs);
        // zenity: 0 Allow, 1 Deny, 5 its own give-up.
        if (got.code === 5) return { answer: "timeout" };
      } else {
        got = await run(kdialog, names.length === 1 ? ["--title", "pi-dispatch", "--yes-label", "Allow", "--no-label", "Deny", "--yesno", message] : ["--title", "pi-dispatch", "--menu", message, ...names.flatMap((n) => [n, n])], timeoutMs);
      }
      if (got.timedOut) return { answer: "timeout" };
      if (got.spawnFailed) return { answer: "error" };
      if (got.code === 1) return { answer: "deny" };
      if (got.code !== 0) return { answer: "error" };
      if (names.length === 1) return { answer: "allow", name: names[0] };
      const picked = got.out.trim();
      return names.includes(picked) ? { answer: "allow", name: picked } : { answer: "error" };
    };
    return { available: true, tool: zenity ? "zenity" : "kdialog", ask };
  }

  return { available: false, why: "this platform has no dialog the console can show" };
}

/** A match code: `MATCH_LENGTH` letters of `MATCH_ALPHABET`, from `random(n)` bytes (rejection sampling, so even). */
export function matchCodeOf(random = nodeRandomBytes) {
  const span = MATCH_ALPHABET.length;
  const limit = 256 - (256 % span);
  let code = "";
  while (code.length < MATCH_LENGTH) {
    for (const b of random(MATCH_LENGTH * 2)) {
      if (b < limit && code.length < MATCH_LENGTH) code += MATCH_ALPHABET[b % span];
    }
  }
  return code;
}

/** The dialog's words: who asks, the code to compare, and where from. Plain text: every tool shows it as is. */
export function approvalMessage({ names, match, from }) {
  const as = names.length === 1 ? ` as ${names[0]}` : "";
  const pick = names.length === 1 ? "" : " Choose who signs in.";
  return `A browser wants to sign in to the pi-dispatch console${as}.${pick}\n\nThe code on that page is ${match}. Allow it only if you just asked for this and the codes match.\n\nFrom: ${from}`;
}

/**
 * The console's one store of approval requests. `runner` is `dialogRunnerFor`'s; `onSettle(request)` hears every
 * answer as it lands (the server's audit row for a deny, a timeout or an error), and is never allowed to throw into it.
 * - `available`: whether this console can ask at all (the sign-in page draws the button only then).
 * - `start({ names, from })` -> `{ id, match }`, or `{ refusal: "busy" }` while one request waits, or
 *   `{ refusal: "unavailable" }`.
 * - `status(id)` -> `{ state: "pending" | "allow" | "deny" | "timeout" | "error", match }`, or null for an id this store
 *   does not hold (never asked, collected, or past `keepMs`).
 * - `take(id)` -> `{ name }` once for an allowed request, and null for anything else: an allowed request signs in one
 *   browser, once.
 */
export function makeApprovals({ runner, now = () => Date.now(), random = nodeRandomBytes, waitMs = APPROVAL_WAIT_MS, keepMs = APPROVAL_KEEP_MS, onSettle = () => {} } = {}) {
  const requests = new Map();
  const prune = () => {
    const t = now();
    for (const [id, r] of requests) if (r.state !== "pending" && t - r.settledAt > keepMs) requests.delete(id);
  };
  const available = Boolean(runner?.available);
  return {
    available,
    start({ names, from }) {
      if (!available) return { refusal: "unavailable" };
      prune();
      for (const r of requests.values()) if (r.state === "pending") return { refusal: "busy" };
      const id = random(32).toString("base64url");
      const match = matchCodeOf(random);
      const request = { id, match, names: [...names], from, state: "pending", askedAt: now(), settledAt: null, name: null };
      requests.set(id, request);
      Promise.resolve()
        .then(() => runner.ask({ message: approvalMessage({ names: request.names, match, from }), names: request.names, timeoutMs: waitMs }))
        .catch(() => ({ answer: "error" }))
        .then((got) => {
          const answer = APPROVAL_ANSWERS.includes(got?.answer) ? got.answer : "error";
          request.state = answer;
          request.name = answer === "allow" && request.names.includes(got.name) ? got.name : null;
          if (answer === "allow" && request.name === null) request.state = "error";
          request.settledAt = now();
          try {
            onSettle({ ...request });
          } catch {}
        });
      return { id, match };
    },
    status(id) {
      prune();
      const r = typeof id === "string" ? requests.get(id) : undefined;
      return r ? { state: r.state, match: r.match } : null;
    },
    take(id) {
      prune();
      const r = typeof id === "string" ? requests.get(id) : undefined;
      if (!r || r.state !== "allow") return null;
      requests.delete(id);
      return { name: r.name };
    },
  };
}
