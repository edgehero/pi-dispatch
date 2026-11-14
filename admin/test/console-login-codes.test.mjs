import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { SHORT_CODE_ALPHABET, SHORT_CODE_SCRYPT, SHORT_TTL_MS, clearLoginCodes, codeKindOf, consumeLoginCode, loginCodesDir, mintLoginCode, shortCodeName, shortCodeOf, showShortCode } from "../src/console/login-codes.mjs";
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
  assert.deepEqual(consumeLoginCode({ dir, code, now }), { name: "rob", codeKind: "link" });
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
  assert.deepEqual(results[0], { name: "rob", codeKind: "link" });
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
  const refused = consumeLoginCode({ dir, code: old, now });
  assert.match(refused.refusal, /has expired/);
  assert.equal(refused.kind, "expired", "the only thing that lets the link page say expired");
  assert.deepEqual(fs.readdirSync(dir), [`${sha(live)}.json`], "the expired code and its expired sibling are gone");
  assert.match(consumeLoginCode({ dir, code: stale, now }).refusal, /already used/);
  assert.deepEqual(consumeLoginCode({ dir, code: live, now }), { name: "view", codeKind: "link" });
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
  // Not "chmod 700" (issue #708): a directory others could write may already hold a planted code, so it must go.
  const loose = mintLoginCode({ dir, name: "rob", now, random: counter() }).refusal;
  assert.match(loose, /reached by other accounts \(mode 755\), so what it holds cannot be trusted; remove the directory \(`rm -r /);
  assert.doesNotMatch(loose, /chmod/);
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

test("consume refuses and removes a code file this minter did not write: loose mode, another owner, a too-long life (issue #708)", { skip: !posix }, () => {
  const now = clock();
  const plant = (dir, code, { mode = 0o600, expiresAt = new Date(now() + 30000).toISOString() } = {}) => {
    const file = join(dir, `${sha(code)}.json`);
    fs.writeFileSync(file, JSON.stringify({ name: "rob", expiresAt }));
    fs.chmodSync(file, mode);
    return file;
  };
  const { dir } = setup();
  assert.ok(mintLoginCode({ dir, name: "rob", now, random: counter() }).code, "the drop exists, 0700");
  for (const [i, mode] of [0o644, 0o640, 0o604, 0o660].entries()) {
    const code = String.fromCharCode(97 + i).repeat(43);
    const file = plant(dir, code, { mode });
    assert.match(consumeLoginCode({ dir, code, now }).refusal, /not valid/, mode.toString(8));
    assert.equal(fs.existsSync(file), false, `a ${mode.toString(8)} file is removed`);
  }
  const owned = "o".repeat(43);
  const ownedFile = plant(dir, owned);
  assert.match(consumeLoginCode({ dir, code: owned, now, uid: process.geteuid() + 1 }).refusal, /not valid/, "another account's file");
  assert.equal(fs.existsSync(ownedFile), false);
  const forever = "f".repeat(43);
  plant(dir, forever, { expiresAt: "9999-01-01T00:00:00.000Z" });
  assert.match(consumeLoginCode({ dir, code: forever, now }).refusal, /not valid/, "an expiry past now + ttl");
  const skewed = "s".repeat(43);
  plant(dir, skewed, { expiresAt: new Date(now() + 63000).toISOString() });
  assert.deepEqual(consumeLoginCode({ dir, code: skewed, now }), { name: "rob", codeKind: "link" }, "a few seconds past the ttl is a clock step");
  const fine = "g".repeat(43);
  plant(dir, fine);
  assert.deepEqual(consumeLoginCode({ dir, code: fine, now }), { name: "rob", codeKind: "link" }, "a 0600 file of this account within the ttl");
});

test("browser viewer codes retain a validated exact-incarnation binding while ordinary host links keep their old shape", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const binding = { sha256: "a".repeat(64), createdAt: new Date(T0).toISOString(), role: "viewer", generation: 2 };
  const { code } = mintLoginCode({ dir, name: "observer", binding, now });
  assert.deepEqual(consumeLoginCode({ dir, code, now }), { name: "observer", codeKind: "link", binding });
  for (const invalid of [{ ...binding, role: "operator" }, { ...binding, generation: -1 }, { ...binding, sha256: "bad" }, { ...binding, unexpected: true }]) assert.ok(mintLoginCode({ dir, name: "observer", binding: invalid, now }).refusal);
  const forged = Buffer.alloc(32, 209).toString("base64url");
  fs.writeFileSync(join(dir, `${sha(forged)}.json`), JSON.stringify({ name: "observer", expiresAt: new Date(T0 + 60_000).toISOString(), binding: { ...binding, role: "operator" } }), { mode: 0o600 });
  assert.ok(consumeLoginCode({ dir, code: forged, now }).refusal);
  assert.equal(fs.existsSync(join(dir, `${sha(forged)}.json`)), false);
});

// ---- the short code (issue #882) ----

/** The drop's short-code salt, as the minter wrote it. */
const saltOf = (dir) => fs.readFileSync(join(dir, ".short-code-salt"), "utf8").trim();
/** Where a short code's file is: its scrypt name under the drop's salt. */
const shortFile = (dir, code) => join(dir, `${shortCodeName(code, saltOf(dir))}.json`);

test("a short code is 8 symbols of Crockford's base32, shown in two groups of four, from 5 random bytes", () => {
  assert.equal(SHORT_CODE_ALPHABET, "0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  assert.equal(SHORT_CODE_ALPHABET.length, 32);
  for (const letter of "ILOU") assert.ok(!SHORT_CODE_ALPHABET.includes(letter), `${letter} is easy to mistake, so no code holds it`);
  assert.equal(showShortCode("K7QX9M2D"), "K7QX-9M2D");
});

test("typing a short code forgives case, dashes, spaces and the letters people mistake for digits, and nothing else", () => {
  for (const typed of ["K7QX-9M2D", "k7qx-9m2d", "K7QX9M2D", " k7qx 9m2d ", "K7QX--9M2D", "k7qx\t9m2d"]) assert.equal(shortCodeOf(typed), "K7QX9M2D", typed);
  assert.equal(shortCodeOf("O0IL-1111"), "00111111", "O is 0, I and L are 1");
  assert.equal(shortCodeOf("oo-ii-ll-00"), "00111100");
  for (const bad of ["K7QX-9M2", "K7QX-9M2DD", "K7QU-9M2D", "K7QX_9M2D", "K7QX.9M2D", "", undefined, 42, "K".repeat(33), " ".repeat(30) + "K7QX9M2D"]) assert.equal(shortCodeOf(bad), null, String(bad));
  assert.equal(codeKindOf("K7QX-9M2D"), "short-code");
  assert.equal(codeKindOf("a".repeat(43)), "link");
  assert.equal(codeKindOf("a".repeat(42)), null);
  assert.equal(codeKindOf("hello"), null);
});

test("mint with short makes a link and a short code, the short one a 0600 file under a slow salted name, living 5 minutes", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const made = mintLoginCode({ dir, name: "rob", now, random: counter(), short: true });
  assert.match(made.code, /^[A-Za-z0-9_-]{43}$/);
  // counter() gives 32 bytes of 1 for the link, 32 bytes of 2 for the drop's salt, then 5 bytes of 3: 0x0303030303, read 5 bits at a time.
  assert.equal(made.short, "0C1G60R3");
  assert.equal(saltOf(dir), "02".repeat(32));
  assert.equal(fs.statSync(join(dir, ".short-code-salt")).mode & 0o777, 0o600);
  const file = shortFile(dir, made.short);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { name: "rob", expiresAt: new Date(T0 + SHORT_TTL_MS).toISOString() });
  // Not the plain sha256 a listing could be searched against in minutes (review, issue #882).
  assert.ok(!fs.existsSync(join(dir, `${sha(made.short)}.json`)));
  assert.deepEqual(fs.readdirSync(dir).sort(), [".short-code-salt", `${sha(made.code)}.json`, `${shortCodeName(made.short, saltOf(dir))}.json`].sort());
  assert.ok(!fs.readFileSync(file, "utf8").includes(made.short), "the code itself is never on disk");
  assert.match(mintLoginCode({ dir, name: "ann", now, short: true, binding: { sha256: "a".repeat(64), createdAt: new Date(T0).toISOString(), role: "viewer", generation: 0 } }).refusal, /a link alone/, "an invitation is never typed");
  // A second mint keeps the drop's salt: every code of the drop under one.
  const again = mintLoginCode({ dir, name: "rob", now, short: true });
  assert.equal(saltOf(dir), "02".repeat(32));
  assert.ok(fs.existsSync(shortFile(dir, again.short)));
});

test("a short code's name is scrypt at the declared cost, and depends on the drop's salt", () => {
  assert.deepEqual({ ...SHORT_CODE_SCRYPT }, { N: 16384, r: 8, p: 1 });
  assert.match(shortCodeName("K7QX9M2D", "a".repeat(64)), /^[0-9a-f]{64}$/);
  assert.notEqual(shortCodeName("K7QX9M2D", "a".repeat(64)), shortCodeName("K7QX9M2D", "b".repeat(64)), "another drop, another name");
  assert.notEqual(shortCodeName("K7QX9M2D", "a".repeat(64)), sha("K7QX9M2D"));
});

test("a short code signs in once, typed any way, for 5 minutes; the link beside it is its own and works once too", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const { short } = mintLoginCode({ dir, name: "rob", now, random: counter(), short: true });
  const typed = showShortCode(short).toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
  now.advance(SHORT_TTL_MS - 1);
  assert.deepEqual(consumeLoginCode({ dir, code: typed, now }), { name: "rob", codeKind: "short-code" });
  const again = consumeLoginCode({ dir, code: short, now });
  assert.match(again.refusal, /this sign-in code is not valid: it was already used/);
  assert.equal(again.codeKind, "short-code");
  // The link expired a while ago, and was reaped by the consume; the salt stays for the next code.
  assert.deepEqual(fs.readdirSync(dir), [".short-code-salt"]);

  const both = mintLoginCode({ dir, name: "rob", now, random: counter(9), short: true });
  assert.deepEqual(consumeLoginCode({ dir, code: both.code, now }), { name: "rob", codeKind: "link" });
  assert.deepEqual(consumeLoginCode({ dir, code: both.short, now }), { name: "rob", codeKind: "short-code" }, "each is its own credential");
});

test("a short code past 5 minutes is refused as expired, and one whose file claims a longer life was not made here", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  const { short } = mintLoginCode({ dir, name: "rob", now, random: counter(), short: true });
  now.advance(SHORT_TTL_MS);
  const late = consumeLoginCode({ dir, code: short, now });
  assert.equal(late.kind, "expired");
  assert.match(late.refusal, /this sign-in code has expired/);
  const plant = (name, body) => { const f = join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(body)); fs.chmodSync(f, 0o600); };
  const salt = saltOf(dir);
  plant(shortCodeName("AAAAAAAA", salt), { name: "rob", expiresAt: new Date(now() + SHORT_TTL_MS + 6000).toISOString() });
  assert.match(consumeLoginCode({ dir, code: "aaaa-aaaa", now }).refusal, /not valid/);
  plant(shortCodeName("BBBBBBBB", salt), { name: "ann", expiresAt: new Date(now() + 1000).toISOString(), binding: { sha256: "a".repeat(64), createdAt: new Date(T0).toISOString(), role: "viewer", generation: 0 } });
  assert.match(consumeLoginCode({ dir, code: "BBBBBBBB", now }).refusal, /not valid/);
  // A link's code is held to a link's life: a file under a link's hash may not claim a short code's 5 minutes.
  plant(sha("l".repeat(43)), { name: "rob", expiresAt: new Date(now() + SHORT_TTL_MS).toISOString() });
  assert.match(consumeLoginCode({ dir, code: "l".repeat(43), now }).refusal, /not valid/);
  // A file under the plain sha256 of a short code is no short code's.
  plant(sha("CCCCCCCC"), { name: "rob", expiresAt: new Date(now() + 1000).toISOString() });
  assert.match(consumeLoginCode({ dir, code: "CCCC-CCCC", now }).refusal, /not valid/);
});

test("the short-code salt: none means no short code can match, and one another account could write is refused", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  mintLoginCode({ dir, name: "rob", now });
  assert.match(consumeLoginCode({ dir, code: "K7QX-9M2D", now }).refusal, /not valid/, "a drop that never held a short code");
  assert.ok(!fs.existsSync(join(dir, ".short-code-salt")), "a consume makes none");
  const { short } = mintLoginCode({ dir, name: "rob", now, short: true });
  fs.chmodSync(join(dir, ".short-code-salt"), 0o644);
  assert.match(consumeLoginCode({ dir, code: short, now }).refusal, /not valid/, "a loose salt matches nothing");
  assert.match(mintLoginCode({ dir, name: "rob", now, short: true }).refusal, /not a private file/);
  fs.chmodSync(join(dir, ".short-code-salt"), 0o600);
  fs.writeFileSync(join(dir, ".short-code-salt"), "not hex\n");
  assert.match(mintLoginCode({ dir, name: "rob", now, short: true }).refusal, /not one this console wrote/);
  // Sign everyone out clears the codes, not the salt.
  fs.writeFileSync(join(dir, ".short-code-salt"), `${"c".repeat(64)}\n`);
  mintLoginCode({ dir, name: "rob", now, short: true });
  clearLoginCodes({ dir });
  assert.deepEqual(fs.readdirSync(dir), [".short-code-salt"]);
});

test("a short code that cannot be written takes its link with it: both or neither", { skip: !posix }, () => {
  const { dir } = setup();
  const now = clock();
  let writes = 0;
  // The link's file, the salt, then the short code's file, which fails.
  const failing = { ...fs, writeFileSync: (...args) => { writes += 1; if (writes === 3) throw Object.assign(new Error("full"), { code: "ENOSPC" }); return fs.writeFileSync(...args); } };
  const made = mintLoginCode({ dir, name: "rob", now, random: counter(), short: true, fs: failing });
  assert.match(made.refusal, /could not be written .*ENOSPC/);
  assert.deepEqual(fs.readdirSync(dir), [".short-code-salt"], "no live link was left behind");
});
