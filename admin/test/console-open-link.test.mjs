import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { OPEN_DIR_PREFIX, openLinkViaFile, redirectPage } from "../src/console/open-link.mjs";

// Issue #708, review round 1: a sign-in link is opened through a private redirect page, so the opener's argv (readable
// by every local account while it runs) holds a file path and never the code.

const posix = process.platform !== "win32";
const LINK = `http://127.0.0.1:4790/login/code#${"C".repeat(43)}&next=/run?id=gh-1`;

test("the opener gets a file: URL of a 0600 page in a 0700 directory; the page sends the browser on, fragment kept", { skip: !posix }, () => {
  const base = tempDir("pd-open-");
  const opened = [];
  const timers = [];
  const r = openLinkViaFile(LINK, { open: (u) => opened.push(u), tmpdir: base, setTimer: (fn, ms) => (timers.push([fn, ms]), { unref() {} }) });
  assert.equal(r.opened, true);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^file:\/\//);
  assert.ok(!opened[0].includes("C".repeat(43)) && !opened[0].includes("login/code"), "no code, no link, in the opener's argument");
  const page = fileURLToPath(opened[0]);
  assert.equal(page, r.page);
  assert.equal(fs.statSync(page).mode & 0o777, 0o600);
  assert.equal(fs.statSync(join(page, "..")).mode & 0o777, 0o700);
  assert.ok(join(page, "..").startsWith(join(base, OPEN_DIR_PREFIX)));
  const html = fs.readFileSync(page, "utf8");
  assert.ok(html.includes(`location.replace(${JSON.stringify(LINK)});`), html);
  assert.match(html, /name="referrer" content="no-referrer"/);
  // Removed after the delay, by the timer the page set.
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 60000);
  timers[0][0]();
  assert.equal(fs.existsSync(join(page, "..")), false);
});

test("a page an earlier run left is swept once it is older than keepMs; a younger one and a stranger's file are not", { skip: !posix }, () => {
  const base = tempDir("pd-open-");
  const left = join(base, `${OPEN_DIR_PREFIX}old`);
  fs.mkdirSync(left, { mode: 0o700 });
  fs.writeFileSync(join(left, "open.html"), "x");
  fs.writeFileSync(join(base, "other.txt"), "keep");
  const t = fs.statSync(left).mtimeMs;
  const quiet = { open: () => {}, tmpdir: base, setTimer: () => ({ unref() {} }) };
  // A second link within the minute (another session's): the first page is still being read, so it stays.
  const second = openLinkViaFile(LINK, { ...quiet, now: () => t + 59000 });
  assert.equal(fs.existsSync(left), true, "younger than keepMs: kept");
  assert.equal(fs.existsSync(second.page), true);
  openLinkViaFile(LINK, { ...quiet, now: () => t + 61000 });
  assert.equal(fs.existsSync(left), false, "older than keepMs: swept");
  assert.equal(fs.readFileSync(join(base, "other.txt"), "utf8"), "keep");
});

test("a page that cannot be made is refused and nothing is opened", () => {
  const opened = [];
  const failing = { ...fs, readdirSync: () => [], mkdtempSync: () => { const e = new Error("no"); e.code = "EACCES"; throw e; } };
  const r = openLinkViaFile(LINK, { open: (u) => opened.push(u), fs: failing, tmpdir: "/nowhere" });
  assert.match(r.refusal, /could not be made \(EACCES\)/);
  assert.deepEqual(opened, []);
});

test("redirectPage escapes what could end the script", () => {
  const html = redirectPage("http://127.0.0.1:4790/login/code#a</script><script>alert(1)//");
  assert.ok(!html.includes("</script><script>alert"));
  assert.ok(html.includes("\\u003c/script>"));
});
