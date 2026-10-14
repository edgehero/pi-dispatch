import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { consumeLoginCode, loginCodesDir, mintLoginCode } from "../src/console/login-codes.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// One-time login codes (issue #640). Real files: single use rests on the kernel's unlink, and the refusals on modes and
// links the kernel reports. Windows has neither mode bits nor this rename discipline to judge.
const posix = process.platform !== "win32";
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
const sha = (s) => createHash("sha256").update(s).digest("hex");

function setup() {
  const base = tempDir("pd-clc-");
  return { base, dir: loginCodesDir(join(base, "console-tokens.json")) };
}

test("loginCodesDir is console-login-codes beside the tokens file", () => {
  assert.equal(loginCodesDir("/srv/dep/console-tokens.json"), "/srv/dep/console-login-codes");
});

test("mint makes the directory 0700 and a 0600 file named by the code's hash holding only the name and expiry", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const { code } = mintLoginCode({ dir, name: "rob", now, random: counter() });
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!code.startsWith("pdc_"), "a code is not a token");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const file = join(dir, `${sha(code)}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(text), { name: "rob", expiresAt: new Date(T0 + 60000).toISOString() });
  assert.ok(!text.includes(code), "the code itself is never on disk");
  assert.deepEqual(fs.readdirSync(dir), [`${sha(code)}.json`]);
  assert.match(mintLoginCode({ dir, name: "", now, random: counter() }).refusal, /needs the name/);
  assert.match(mintLoginCode({ dir, name: "rob" }).code, /^[A-Za-z0-9_-]{43}$/);
});

test("consume signs in once: the second consume of the same code is refused and the file is gone", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const { code } = mintLoginCode({ dir, name: "rob", now, random: counter() });
  now.advance(59999);
  assert.deepEqual(consumeLoginCode({ dir, code, now }), { name: "rob" });
  assert.match(consumeLoginCode({ dir, code, now }).refusal, /already used, has expired, or was never made/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("two consumers that both read the code before either unlinks: only the one whose unlink succeeds wins", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const { code } = mintLoginCode({ dir, name: "rob", now, random: counter() });
  const file = join(dir, `${sha(code)}.json`);
  const text = fs.readFileSync(file, "utf8");
  const st = fs.lstatSync(file);
  // Both readers saw the file: the lstat and the read keep answering as they did before the first unlink.
  const raced = {
    ...fs,
    lstatSync: (p) => (p === file ? st : fs.lstatSync(p)),
    readFileSync: (p, enc) => (p === file ? text : fs.readFileSync(p, enc)),
  };
  const results = [consumeLoginCode({ dir, code, fs: raced, now }), consumeLoginCode({ dir, code, fs: raced, now })];
  assert.deepEqual(results[0], { name: "rob" });
  assert.match(results[1].refusal, /already used/);
});

test("an expired code is refused and removed; other expired codes are reaped, live ones kept", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const random = counter();
  const old = mintLoginCode({ dir, name: "rob", now, random }).code;
  const stale = mintLoginCode({ dir, name: "ann", now, random }).code;
  now.advance(30000);
  const live = mintLoginCode({ dir, name: "view", now, random }).code;
  now.advance(30000);
  assert.match(consumeLoginCode({ dir, code: old, now }).refusal, /has expired/);
  assert.deepEqual(fs.readdirSync(dir), [`${sha(live)}.json`], "the expired code and its expired sibling are gone");
  assert.match(consumeLoginCode({ dir, code: stale, now }).refusal, /already used/);
  assert.deepEqual(consumeLoginCode({ dir, code: live, now }), { name: "view" });
});

test("minting reaps expired codes and leaves files of other names alone", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const random = counter();
  const old = mintLoginCode({ dir, name: "rob", now, random }).code;
  fs.writeFileSync(join(dir, "notes.txt"), "keep");
  fs.writeFileSync(join(dir, `${"f".repeat(64)}.json`), "not json");
  now.advance(60000);
  const fresh = mintLoginCode({ dir, name: "rob", now, random }).code;
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${sha(fresh)}.json`, "notes.txt"].sort());
  assert.ok(!fs.readdirSync(dir).includes(`${sha(old)}.json`));
});

test("a malformed or unknown code is refused without touching the drop, and the refusal never quotes it", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const { code } = mintLoginCode({ dir, name: "rob", now, random: counter() });
  for (const bad of [undefined, "", "short", `${code}x`, `${code.slice(0, 42)}!`, 42]) {
    const r = consumeLoginCode({ dir, code: bad, now });
    assert.match(r.refusal, /not valid/);
  }
  const unknown = Buffer.alloc(32, 200).toString("base64url");
  const r = consumeLoginCode({ dir, code: unknown, now });
  assert.ok(!r.refusal.includes(unknown));
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("a code file holding garbage, or no name, signs nobody in and is removed", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  mintLoginCode({ dir, name: "rob", now, random: counter() });
  const a = Buffer.alloc(32, 77).toString("base64url");
  const b = Buffer.alloc(32, 78).toString("base64url");
  fs.writeFileSync(join(dir, `${sha(a)}.json`), "{", { mode: 0o600 });
  fs.writeFileSync(join(dir, `${sha(b)}.json`), JSON.stringify({ expiresAt: new Date(T0 + 60000).toISOString() }), { mode: 0o600 });
  assert.match(consumeLoginCode({ dir, code: a, now }).refusal, /has expired/);
  assert.match(consumeLoginCode({ dir, code: b, now }).refusal, /not valid/);
  assert.ok(!fs.existsSync(join(dir, `${sha(a)}.json`)));
  assert.ok(!fs.existsSync(join(dir, `${sha(b)}.json`)));
});

test("a code planted as a symlink in the drop is removed, never followed", { skip: !posix }, () => {
  const { base, dir } = setup();
  const now = clock();
  mintLoginCode({ dir, name: "rob", now, random: counter() });
  const target = join(base, "elsewhere.json");
  fs.writeFileSync(target, JSON.stringify({ name: "rob", expiresAt: new Date(T0 + 60000).toISOString() }));
  const code = Buffer.alloc(32, 90).toString("base64url");
  fs.symlinkSync(target, join(dir, `${sha(code)}.json`));
  assert.match(consumeLoginCode({ dir, code, now }).refusal, /not valid/);
  assert.ok(fs.existsSync(target), "the link's target is untouched");
  assert.ok(!fs.readdirSync(dir).includes(`${sha(code)}.json`));
});

test("the drop directory is refused when it is a symlink, not a directory, or reachable by other accounts", { skip: !posix }, () => {
  const { base, dir } = setup();
  const now = clock();
  const code = Buffer.alloc(32, 3).toString("base64url");
  assert.match(consumeLoginCode({ dir, code, now }).refusal, /no login code has been made here yet/);
  assert.ok(!fs.existsSync(dir), "consume never creates the drop");

  const real = join(base, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, dir);
  assert.match(mintLoginCode({ dir, name: "rob", now, random: counter() }).refusal, /is a symbolic link/);
  assert.match(consumeLoginCode({ dir, code, now }).refusal, /is a symbolic link/);
  assert.deepEqual(fs.readdirSync(real), [], "nothing was written through the link");
  fs.unlinkSync(dir);

  fs.writeFileSync(dir, "x");
  assert.match(mintLoginCode({ dir, name: "rob", now, random: counter() }).refusal, /is not a directory/);
  fs.rmSync(dir);

  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  assert.match(mintLoginCode({ dir, name: "rob", now, random: counter() }).refusal, /reached by other accounts \(mode 755\); run `chmod 700 /);
  assert.match(consumeLoginCode({ dir, code, now }).refusal, /mode 755/);
  fs.chmodSync(dir, 0o701);
  assert.match(mintLoginCode({ dir, name: "rob", now, random: counter() }).refusal, /mode 701/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("mint refuses when the tokens file's directory does not exist", { skip: !posix }, () => {
  const base = tempDir("pd-clc-");
  const dir = loginCodesDir(join(base, "absent", "console-tokens.json"));
  assert.match(mintLoginCode({ dir, name: "rob", now: clock(), random: counter() }).refusal, /could not be created \(ENOENT\)/);
});

test("mint creates its file exclusively: a link planted at the code's path after the reap is refused, never written through", { skip: !posix }, () => {
  const { base, dir } = setup();
  const now = clock();
  const target = join(base, "elsewhere.json");
  fs.writeFileSync(target, "untouched\n");
  // The race the exclusive create closes: another account's link appears at the code's path between the reap (which
  // removes links it sees) and the write. The wrapper plants it at exactly that moment.
  const racing = { ...fs, writeFileSync: (path, ...rest) => (fs.symlinkSync(target, path), fs.writeFileSync(path, ...rest)) };
  const res = mintLoginCode({ dir, name: "rob", now, random: counter(), fs: racing });
  assert.match(res.refusal, /could not be written .*EEXIST/);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched\n", "the planted link's target was not written");
});
