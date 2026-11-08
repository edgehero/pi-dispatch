/**
 * `pi-dispatch-console open` (issue #849): sign the person at this terminal in, with as little copying as the situation allows.
 *
 * WHEN THE CODE IS MINTED IS THE POINT. A code lives for 60 seconds. Over SSH it used to be printed before the tunnel existed, so the
 * minute was spent setting up the tunnel. Here the code is minted when the person presses Enter with the tunnel up, which removes the
 * race without making any code live longer (`REQ-CONSOLE-SECURITY` (i) is unchanged).
 *
 * A LOCAL CODE IS NOT PRINTED until someone asks. It goes to the browser through `openLinkViaFile`, so it is on no command line and in
 * no scrollback, and an agent reading this command's output sees no credential. Enter prints a fresh one on a terminal, which is the way
 * in for a snap or Flatpak browser that cannot read the private page (`open-link.mjs`) and for anyone whose browser did not come up.
 *
 * A code that disappears means the browser took it, which is all this side can know: the page says whether the sign-in worked. So the
 * words are "your browser took the link", not "you are signed in".
 */

/** Fresh links one run may make. A bound on how many live codes a held-down Enter key can leave behind. */
export const MAX_LINKS = 20;

const POLL_MS = 500;

/** How long after attaching a line of input counts as typed earlier. A person pressing Enter on purpose is reading what this printed first. */
export const ENTER_SETTLE_MS = 200;

/**
 * One Enter at a time from `input`. `next()` is true for a line and false once the input has closed. Lines that arrive in the first moment
 * are dropped: Enter pressed during a long image pull sits in the terminal's buffer, and over SSH one such press would mint a code before
 * the tunnel exists, which is the race this command exists to remove.
 */
export async function enterReader(input, { now = Date.now, settleMs = ENTER_SETTLE_MS } = {}) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input });
  const lines = [];
  const waiting = [];
  let closed = false;
  // From the next turn of the loop, not from here: a slow start would otherwise use up the window before the buffered lines are even read.
  let attached = null;
  setImmediate(() => { attached = now(); });
  rl.on("line", () => {
    if (attached === null || now() - attached < settleMs) return;
    if (waiting.length) waiting.shift()(true);
    else lines.push(true);
  });
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()(false);
  });
  return {
    next: () => (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve(false) : new Promise((done) => waiting.push(done))),
    close: () => rl.close(),
  };
}

/**
 * Run the command. Everything that touches the world is handed in: `mint()` returns `{ url, code }` or `{ exit }` once it has said why
 * it could not, `pending(code)` says whether the code is unspent, `openLink(url)` hands it to the browser and may return `{ refusal }`.
 */
export async function runOpenCommand({ local, isTTY, windows = false, plainUrl, tunnelLine = null, mint, pending, openLink, openPlain, enter = null, say, print, consoleCommand = "pi-dispatch-console", now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), ttlMs = 60000, snapHint = false }) {
  if (windows) {
    // One-time links cannot work on Windows (`dirProblem`), so the most this can do is open the page.
    openPlain(plainUrl);
    say("opened the console. One-time links do not work on Windows, so paste a token on the page");
    return 0;
  }
  if (!local && !isTTY) {
    say(`there is no browser here and no terminal to wait on, so nothing was opened; use ${consoleCommand} link for a link to pass along`);
    return 2;
  }
  let enterPress = null;
  const nextEnter = () => (enterPress ??= enter.next().then((more) => { enterPress = null; return more; }));
  if (!local) {
    if (tunnelLine) say(`first open a tunnel from your own computer: ${tunnelLine}`);
    say("press Enter when you can reach it, and a link good for 60 seconds will be printed");
    if (!(await nextEnter())) {
      say("no link was made");
      return 0;
    }
  }

  /** Watch one code: `used` once it is gone in time, `enter` on a key press, `expired` when its minute is up. */
  const watch = async (code, expiresAt) => {
    let inputOpen = true;
    for (;;) {
      const raced = await Promise.race([inputOpen ? nextEnter().then((more) => (more ? "enter" : "closed")) : new Promise(() => {}), sleep(POLL_MS).then(() => null)]);
      if (raced === "enter") return "enter";
      if (raced === "closed") inputOpen = false;
      if (!pending(code)) return now() < expiresAt ? "used" : "expired";
      if (now() >= expiresAt) return "expired";
    }
  };

  let handToBrowser = local;
  for (let made = 0; made < MAX_LINKS; made++) {
    const link = mint();
    if (link.exit !== undefined) return link.exit;
    const expiresAt = now() + ttlMs;
    if (handToBrowser) {
      const handed = openLink(link.url);
      if (handed?.refusal) {
        say(handed.refusal);
        // With no terminal there is no Enter to ask for, and nothing has reached anyone.
        if (!isTTY) return 2;
      } else say("your browser is opening");
    } else {
      print(link.url);
      say("open it within 60 seconds; it works once");
    }
    if (!isTTY) return 0;
    if (handToBrowser) say(`nothing there? press Enter for a link to open yourself${snapHint ? " (a snap or Flatpak browser cannot read the page this opens)" : ""}`);
    handToBrowser = false;
    const seen = await watch(link.code, expiresAt);
    if (seen === "used") {
      say("your browser took the link. You can close this terminal");
      return 0;
    }
    if (seen === "expired") {
      say("that link has expired. Press Enter for a fresh one, or Ctrl-C to stop");
      if (!(await nextEnter())) return 0;
    }
  }
  say(`that was ${MAX_LINKS} links, so this run stops here; run it again if you still need one`);
  return 2;
}
