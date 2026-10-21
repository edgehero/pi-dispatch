/**
 * Open a sign-in link without putting its code on a command line (issue #708, review round 1). The opener is a child
 * process (`open`, `xdg-open`, `rundll32`), and a child's argv is readable by every local account (`/proc/<pid>/cmdline`,
 * `ps`) for as long as it runs, so a link handed to it as an argument hands the code to them for that time. Instead the
 * link is written into a small HTML page that sends the browser on with `location.replace` (the fragment, which carries
 * the code, kept), and the OPENER is given that page's path, which says nothing.
 *
 * The page is a 0600 file in a fresh 0700 directory under the OS temp directory (`mkdtemp`, then chmod exactly, since
 * the mode is masked by the umask), so no other account can read it. It is removed after `keepMs` (long enough for the
 * browser to read it, and the code is good for 60 seconds anyway), and any page an earlier run left (a pi that exited
 * first) is removed on the next one, once it is older than `keepMs`: a second link within that time must not remove a
 * page another session's browser has yet to read.
 *
 * What stays exposed, named rather than implied: the notice that shows the link (the operator's own terminal, and
 * whoever watches it); the browser's history entry for the page and the link until the code is spent (the console's
 * script removes the fragment from history before it posts the code); and a pi attached over tmux from an SSH session
 * whose environment says "local", which opens the browser on the machine's own desktop, unattended. And what opens
 * the page is the desktop's handler for `.html` files, which is usually but not always the browser; on Linux a snap or
 * Flatpak browser has a private /tmp and cannot read the page at all (the notice then says to open the printed link).
 */
import * as nodeFs from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The prefix of the temporary directories, so the next run can find what an earlier one left. */
export const OPEN_DIR_PREFIX = "pi-dispatch-console-open-";

/** How long the redirect page lives. */
export const OPEN_KEEP_MS = 60000;

/** The redirect page for `url`: the URL as a JSON string literal, with `<` escaped so it cannot close the script. */
export function redirectPage(url) {
  const literal = JSON.stringify(String(url)).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `<!doctype html>\n<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n<title>pi-dispatch console</title>\n<script>location.replace(${literal});</script>\n`;
}

/**
 * Remove what earlier runs left: every `OPEN_DIR_PREFIX` directory under `base` this account owns whose mtime is older
 * than `keepMs`. Never throws.
 */
function sweep(base, fs, uid, keepMs, now) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(OPEN_DIR_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || now - st.mtimeMs < keepMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone, or not ours to remove
    }
  }
}

/**
 * Open `url` through a private redirect page. `open(target)` is the opener (`openBrowser`), handed a `file:` URL.
 * Returns `{ opened: true, page }` or `{ refusal }` (the page could not be made private, so nothing was opened).
 */
export function openLinkViaFile(url, { open, fs = nodeFs, tmpdir = osTmpdir(), keepMs = OPEN_KEEP_MS, setTimer = setTimeout, now = () => Date.now(), uid = typeof process.geteuid === "function" ? process.geteuid() : undefined } = {}) {
  sweep(tmpdir, fs, uid, keepMs, now());
  let dir;
  try {
    dir = fs.mkdtempSync(join(tmpdir, OPEN_DIR_PREFIX));
    fs.chmodSync(dir, 0o700);
    const page = join(dir, "open.html");
    fs.writeFileSync(page, redirectPage(url), { mode: 0o600, flag: "wx" });
    fs.chmodSync(page, 0o600);
    open(pathToFileURL(page).href);
    const timer = setTimer(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // the next run's sweep takes it
      }
    }, keepMs);
    // The page must not keep pi running; a page left by an exit is the next run's to sweep.
    timer?.unref?.();
    return { opened: true, page };
  } catch (e) {
    if (dir !== undefined) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // nothing more to do
      }
    }
    return { refusal: `the browser was not opened: a private page for the link could not be made (${typeof e?.code === "string" ? e.code : "error"})` };
  }
}
