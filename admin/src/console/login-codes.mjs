/**
 * One-time login codes (issue #640): `pi-dispatch-console link --name <n>` signs a browser in as token `<n>` without the
 * operator pasting the token. The command runs as the deployment account, which is already trusted with the tokens
 * file, so it may vouch for a name in it.
 *
 * The drop is a directory beside the tokens file, 0700, one file per code named by the code's SHA-256 and holding only
 * `{name, expiresAt}`, written 0600 and exclusively. The code itself is 32 random bytes, never the token and never on
 * disk, and the link carries it in the URL FRAGMENT, which a browser sends to no server and puts in no Referer.
 *
 * Single use rests on the filesystem, not on a check-then-act: the consumer reads the file and then unlinks it, and
 * only the caller whose `unlinkSync` succeeds wins. Two tabs racing on one link get one session between them. An
 * expired code is refused AND removed, and every consume also removes whatever other codes have expired.
 *
 * TWO KINDS OF CODE (issue #882). The LINK's code above, 43 characters, lives `LINK_TTL_MS` (60 seconds), and is opened,
 * never typed. The SHORT code is 8 characters of Crockford's base32 (`SHORT_CODE_ALPHABET`, shown `K7QX-9M2D`), for a
 * person to read off a terminal and type on the sign-in page, on another computer or a phone; it lives
 * `SHORT_TTL_MS` (5 minutes), because typing takes longer than a click. Typing forgives what a person gets wrong without
 * meaning anything by it: case, dashes and spaces are ignored, and O is read as 0 and I and L as 1 (`shortCodeOf`), so the
 * code a person types and the code that was printed hash the same. It goes in the same drop, by the same rules: written
 * 0600 and exclusively, spent by the one `unlinkSync` that wins; but filed under a slow keyed hash of its canonical
 * spelling (`shortCodeName`), never a plain sha256 (below).
 *
 * WHY 40 BITS ARE ENOUGH, and what they are not enough against. A guess reaches a code only through `POST /login/code` or
 * `/login/typed-code`, behind the console's one global sign-in limiter (`guards.mjs`: 5 a minute after a burst of 10), so
 * in a code's 5 minutes at most 35 guesses are made by one console process, against 2^40 codes: about one chance in 30
 * billion per live code. (The bucket lives in the process, so a restart refills it; restarting the console is the
 * deployment account's to do, and that account can mint a code anyway.) The FILES are a different matter: a file named
 * by the plain sha256 of a 40-bit code gives the code away to anyone who can list the folder and try every code in
 * minutes, and the deployment's own pi session can list it (`ls`, `find`; the extension guards only `write` and `edit`).
 * So a short code's file is named by scrypt (N 2^14, r 8, p 1: about 30 ms and 16 MiB a try) of the code under a random
 * per-drop salt (`.short-code-salt`, 0600): one hash per attempt behind the limiter for the console, and for a search
 * of the listing about a thousand CPU-years per drop, against a code that lives 5 minutes. REJECTED: an HMAC under a
 * key kept in the drop, which pi's `read` tool can read as easily as it lists the folder, so a key buys nothing a salt
 * does not, while scrypt's cost holds whoever reads it. A link's 256 bits need none of this.
 *
 * Each code is its own credential. `link` prints a link and a short code together, and each works once: signing in with
 * one leaves the other as it was, so a person can open the link here and type the code on a phone. REJECTED: tying the
 * two so that the first one used ends the other. `/dispatch console --link` hands its link to this machine's browser,
 * which uses it at once, so the code it prints beside it would always be dead by the time anyone read it.
 */
import * as nodeFs from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";

/** A link's code: 32 random bytes as base64url, always 43 characters. */
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_FILE_RE = /^[0-9a-f]{64}\.json$/;
/** How far a code's `expiresAt` may sit past `now + ttlMs` (a clock stepped between mint and consume). */
const EXPIRY_SKEW_MS = 5000;

/** How long a link's code lives: opened within a minute, by a click. */
export const LINK_TTL_MS = 60000;
/** How long a short code lives (issue #882): read off a terminal and typed, perhaps on a phone, which takes longer than a click. */
export const SHORT_TTL_MS = 5 * 60000;

/** Crockford's base32: the ten digits and the letters but I, L, O and U, so no two symbols are easy to mistake for each other. */
export const SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A short code's length: 8 symbols of 5 bits, 40 bits. */
export const SHORT_CODE_LENGTH = 8;
const SHORT_RE = new RegExp(`^[${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}}$`);
/** The longest text read as a typed code before it is refused unread: the 9 characters shown and room for stray spaces. */
const TYPED_MAX = 32;

/**
 * The canonical spelling of a typed short code, or null when the text is not one: case, dashes and white space ignored,
 * O read as 0, I and L as 1 (Crockford's own folding). U is in no code, so a U is no code either.
 */
export function shortCodeOf(text) {
  if (typeof text !== "string" || text.length > TYPED_MAX) return null;
  const folded = text.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return SHORT_RE.test(folded) ? folded : null;
}

/** A short code as it is shown and printed: two groups of four, `K7QX-9M2D`. */
export function showShortCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Which kind of code `text` is, by its shape alone: `link` (a link's 43 characters, exactly), `short-code` (a typed short
 * code, `shortCodeOf`), or null. The two cannot be confused: no 43-character text is a short code. These two words are
 * the `kind` of the console's `login-code` audit rows (`INT-CONSOLE-AUDIT-LOG`).
 */
export function codeKindOf(text) {
  if (typeof text !== "string") return null;
  if (CODE_RE.test(text)) return "link";
  return shortCodeOf(text) === null ? null : "short-code";
}

/** 5 random bytes as 8 symbols of `SHORT_CODE_ALPHABET`, 5 bits each, so every code is equally likely. */
function shortFrom(bytes) {
  let bits = 0n;
  for (const b of bytes.subarray(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = SHORT_CODE_LENGTH - 1; i >= 0; i--) out += SHORT_CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/**
 * Why no sign-in link is made for a token the tokens file keeps for a role this console does not know (issue #761,
 * `keptTokens`): a code for it would only be refused at sign-in, since no reader of `tokens` meets it. One sentence for
 * both makers of a link, `pi-dispatch-console link` and the panel's `/dispatch console --link`, so the two never drift.
 */
export function keptTokenLinkRefusal(entry) {
  return `the token "${entry.name}" has the role \`${entry.role}\`, which this pi-dispatch-console does not know, so it signs in nowhere here and no link is made for it`;
}

/** The drop directory: `console-login-codes` beside the tokens file. */
export function loginCodesDir(tokensPath) {
  return join(dirname(tokensPath), "console-login-codes");
}

function codeHash(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** The drop's salt for short codes: 32 random bytes as hex, in one 0600 file of this account, made with the first short code. */
const SALT_FILE = ".short-code-salt";
const SALT_RE = /^[0-9a-f]{64}$/;
/** scrypt's cost for a short code's name (see the header): what one guess costs whoever reads the folder. */
export const SHORT_CODE_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });

/**
 * The drop's short-code salt: `{salt}`, or `{refusal}`. With `create` (a mint), one is made when there is none, exclusively,
 * so two minters racing agree on the one that won. Read as `take` reads a code: a regular file of this account with no group
 * or other bit, else refused (a salt another account could write would let it choose the names).
 */
function shortSalt(dir, fs, { create, random = randomBytes, uid = processUid() }) {
  const file = join(dir, SALT_FILE);
  const read = () => {
    const st = fs.lstatSync(file);
    if (!st.isFile() || (uid !== undefined && ((st.mode & 0o077) !== 0 || st.uid !== uid))) return { refusal: `the short-code salt ${file} is not a private file of this account; remove it and make a new code` };
    const text = fs.readFileSync(file, "utf8").trim();
    return SALT_RE.test(text) ? { salt: text } : { refusal: `the short-code salt ${file} is not one this console wrote; remove it and make a new code` };
  };
  try {
    return read();
  } catch (e) {
    if (e?.code !== "ENOENT") return { refusal: `the short-code salt in ${dir} could not be read (${errCode(e)})` };
    if (!create) return { refusal: "no short code was ever made here" };
  }
  try {
    fs.writeFileSync(file, `${random(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(file, 0o600);
  } catch (e) {
    if (e?.code !== "EEXIST") return { refusal: `the short-code salt in ${dir} could not be written (${errCode(e)}); nothing was made` };
  }
  try {
    return read();
  } catch (e) {
    return { refusal: `the short-code salt in ${dir} could not be read (${errCode(e)})` };
  }
}

/** A short code's file name (without `.json`): scrypt of its canonical spelling under the drop's salt, as 64 hex characters, so it fits `CODE_FILE_RE`. */
export function shortCodeName(code, salt) {
  return scryptSync(code, salt, 32, { ...SHORT_CODE_SCRYPT, maxmem: 64 * 1024 * 1024 }).toString("hex");
}

function errCode(e) {
  return typeof e?.code === "string" ? e.code : "error";
}

/**
 * What is wrong with the drop directory, or null. A symlink is refused (by lstat: the drop must be where the tokens
 * file says, not wherever a link points), and so is anything but a directory, and any group or world bit: another
 * account that can list it learns when a link was made, one that can write it can plant a code. With `create`, a
 * missing directory is made 0700 (chmod'd exactly, since mkdir's mode is masked by the umask).
 */
function dirProblem(dir, fs, { create }) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e?.code !== "ENOENT") return `the login-code directory ${dir} could not be inspected (${errCode(e)}); check its parent's permissions`;
    if (!create) return `no login code has been made here yet (${dir} does not exist); run \`pi-dispatch-console link --name <name>\``;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      st = fs.lstatSync(dir);
    } catch (e2) {
      return `the login-code directory ${dir} could not be created (${errCode(e2)}); check that the tokens file's directory exists and belongs to this account`;
    }
  }
  if (st.isSymbolicLink()) return `the login-code directory ${dir} is a symbolic link, and the console uses only a real directory; remove the link and run the command again`;
  if (!st.isDirectory()) return `${dir} is not a directory; remove it and run the command again`;
  if ((st.mode & 0o077) !== 0) {
    // NOT "chmod 700": a directory another account could write may already hold a code it planted (issue #708, review
    // round 1), and tightening the mode would make that code good. Its contents cannot be trusted, so it goes.
    return `the login-code directory ${dir} can be reached by other accounts (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}), so what it holds cannot be trusted; remove the directory (\`rm -r ${dir}\`) and make a new link, which creates it again 0700`;
  }
  return null;
}

/**
 * This process's effective uid, or undefined where there is none (Windows), where the owner check is skipped. Not
 * because the directory check holds there instead: Node reports group and other bits on every Windows file and
 * directory (a mode such as 0o666 or 0o777), so `dirProblem` refuses every drop and no code is ever minted or spent on
 * a Windows host. One-time links (`pi-dispatch-console link`, `/dispatch console --link`) are not supported there; a
 * token is pasted instead (docs/console.md).
 */
function processUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

/**
 * Read one code file and remove it: `{name, expiresAt}` when THIS call removed it, else null (gone, already taken, or
 * not a regular file, which is removed too: nothing else belongs here). Defence in depth beside the directory check
 * (issue #708): a file with any group or other permission bit, or one another account owns, was not written by
 * `mintLoginCode` (0600, this account), so it is removed and refused rather than read.
 */
function take(file, fs, uid) {
  let text;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || (uid !== undefined && ((st.mode & 0o077) !== 0 || st.uid !== uid))) {
      fs.unlinkSync(file);
      return null;
    }
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    return null; // another consumer removed it first: it won
  }
  try {
    const raw = JSON.parse(text);
    return { name: raw?.name, expiresAt: Date.parse(raw?.expiresAt), ...(Object.hasOwn(raw ?? {}, "binding") ? { binding: raw.binding } : {}) };
  } catch {
    return { name: undefined, expiresAt: Number.NaN };
  }
}

/** Remove every expired (or unreadable) code file in the drop. Best effort, never throws. */
function reap(dir, fs, t) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!CODE_FILE_RE.test(name)) continue;
    const file = join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const expiresAt = Date.parse(raw?.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > t) continue;
    } catch {
      // unreadable or not JSON: nothing can consume it, so it goes too
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

/**
 * Remove every pending code in the drop, expired or not: what "sign everyone out" does to links not yet opened (issue #849), host-minted ones and
 * viewer invitations alike. `{removed, left}`: `left` counts the files that could not be removed, which the caller reports, since a link it
 * leaves still signs in; `unreadable` says the folder itself could not be listed, so how many links remain is not known. A folder that does not
 * exist holds no link. Never throws.
 */
export function clearLoginCodes({ dir, fs = nodeFs }) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return e?.code === "ENOENT" ? { removed: 0, left: 0 } : { removed: 0, left: 0, unreadable: true };
  }
  let removed = 0;
  let left = 0;
  for (const name of names) {
    if (!CODE_FILE_RE.test(name)) continue;
    try {
      fs.unlinkSync(join(dir, name));
      removed += 1;
    } catch (e) {
      if (e?.code !== "ENOENT") left += 1;
    }
  }
  return { removed, left };
}

/** Write one code's file, named `name` (64 hex), 0600 and exclusively: null, or the refusal having removed whatever it wrote. */
function writeCode(dir, fs, name, body) {
  const file = join(dir, `${name}.json`);
  try {
    fs.writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    return `the login code could not be written in ${dir} (${errCode(e)}); nothing was made`;
  }
  try {
    // The create's mode is masked by the umask; set it exactly.
    fs.chmodSync(file, 0o600);
  } catch (e) {
    removeCode(dir, fs, name);
    return `the login code in ${dir} could not be made private (${errCode(e)}); nothing was made`;
  }
  return null;
}

function removeCode(dir, fs, name) {
  try {
    fs.unlinkSync(join(dir, `${name}.json`));
  } catch {
    // already gone
  }
}

/**
 * Make a code for token `name`, valid for `ttlMs`: `{code}` (to put in the link's fragment, printed once) or
 * `{refusal}`. With `short` (issue #882), a short code too, valid for `shortTtlMs`: `{code, short}`, `short` in its
 * canonical spelling (`showShortCode` prints it), or nothing at all when either cannot be written. A viewer invitation
 * (`binding`) is a link alone: it is handed over in a browser, never typed. The caller has already checked that `name` is
 * in the tokens file.
 */
export function mintLoginCode({ dir, name, fs = nodeFs, now = () => Date.now(), random = randomBytes, ttlMs = LINK_TTL_MS, binding = undefined, short = false, shortTtlMs = SHORT_TTL_MS }) {
  if (binding !== undefined && !validBinding(binding)) return { refusal: "the viewer invitation binding is invalid; create a new invitation" };
  if (binding !== undefined && short) return { refusal: "a viewer invitation is a link alone, with no code to type" };
  if (typeof name !== "string" || name === "") return { refusal: "a login code needs the name of a token in the tokens file" };
  const problem = dirProblem(dir, fs, { create: true });
  if (problem) return { refusal: problem };
  const t = now();
  reap(dir, fs, t);
  const code = random(32).toString("base64url");
  const refused = writeCode(dir, fs, codeHash(code), { name, expiresAt: new Date(t + ttlMs).toISOString(), ...(binding === undefined ? {} : { binding }) });
  if (refused) return { refusal: refused };
  if (!short) return { code };
  // Both or neither: a person told that nothing was made must not leave a live link behind.
  const salted = shortSalt(dir, fs, { create: true, random });
  if (salted.refusal) {
    removeCode(dir, fs, codeHash(code));
    return { refusal: salted.refusal };
  }
  const shortCode = shortFrom(random(5));
  const shortRefused = writeCode(dir, fs, shortCodeName(shortCode, salted.salt), { name, expiresAt: new Date(t + shortTtlMs).toISOString() });
  if (shortRefused) {
    removeCode(dir, fs, codeHash(code));
    return { refusal: shortRefused };
  }
  return { code, short: shortCode };
}

/** The operator names in a tokens file, in file order. */
export function operatorNames(file) {
  return (file?.tokens ?? []).filter((t) => t.role === "operator").map((t) => t.name);
}

/** The one operator a command can pick without being told, or null when there is none or more than one. */
export function soleOperatorName(file) {
  const names = operatorNames(file);
  return names.length === 1 ? names[0] : null;
}

/**
 * Is this code still waiting to be spent? Looks and takes nothing, so a watcher cannot spend the code it watches. A drop that has gone
 * counts as still waiting: the file went with the folder, so its absence says nothing about a browser having taken it.
 */
export function codePending({ dir, code, fs = nodeFs }) {
  if (typeof code !== "string" || !CODE_RE.test(code)) return false;
  return !fs.existsSync(dir) || fs.existsSync(join(dir, `${codeHash(code)}.json`));
}

/**
 * Spend a code, either kind (`codeKindOf`): `{name, codeKind}` for the one caller that removes its file before it
 * expires, `{refusal, codeKind?}` for everyone else (unknown, already used, expired, malformed), with `kind: "expired"`
 * where the code alone shows that. The refusal never quotes the code. Each kind is held to its own life: a file that
 * claims longer than its kind's (allowing a few seconds of clock step) was written by something else.
 */
export function consumeLoginCode({ dir, code, fs = nodeFs, now = () => Date.now(), ttlMs = LINK_TTL_MS, shortTtlMs = SHORT_TTL_MS, uid = processUid() }) {
  const codeKind = codeKindOf(code);
  const what = codeKind === "short-code" ? "sign-in code" : "login link";
  const used = `this ${what} is not valid: it was already used, has expired, or was never made. Run \`pi-dispatch-console link --name <name>\` for a new one`;
  if (codeKind === null) return { refusal: used };
  const problem = dirProblem(dir, fs, { create: false });
  if (problem) return { refusal: problem, codeKind };
  const t = now();
  // A short code's name costs one scrypt, this attempt's alone (see the header); a drop with no salt has never held one.
  let fileName;
  if (codeKind === "link") fileName = codeHash(code);
  else {
    const salted = shortSalt(dir, fs, { create: false, uid });
    if (salted.refusal) {
      reap(dir, fs, t);
      return { refusal: used, codeKind };
    }
    fileName = shortCodeName(shortCodeOf(code), salted.salt);
  }
  const taken = take(join(dir, `${fileName}.json`), fs, uid);
  reap(dir, fs, t);
  if (!taken) return { refusal: used, codeKind };
  if (!Number.isFinite(taken.expiresAt) || taken.expiresAt <= t) {
    return { kind: "expired", codeKind, refusal: `this ${what} has expired. Run \`pi-dispatch-console link --name <name>\` for a new one` };
  }
  if (taken.expiresAt > t + (codeKind === "link" ? ttlMs : shortTtlMs) + EXPIRY_SKEW_MS) return { refusal: used, codeKind };
  if (typeof taken.name !== "string" || taken.name === "") return { refusal: used, codeKind };
  // A short code never carries an invitation's binding: one that does was not written by `mintLoginCode`.
  if (Object.hasOwn(taken, "binding") && (codeKind !== "link" || !validBinding(taken.binding))) return { refusal: used, codeKind };
  return { name: taken.name, codeKind, ...(taken.binding === undefined ? {} : { binding: taken.binding }) };
}

/** Browser invitations cannot follow a same-name replacement into a different role or token incarnation (#774). */
function validBinding(b) {
  return b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).sort().join(",") === "createdAt,generation,role,sha256" && b.role === "viewer" && /^[0-9a-f]{64}$/.test(b.sha256) && typeof b.createdAt === "string" && Number.isFinite(Date.parse(b.createdAt)) && Number.isSafeInteger(b.generation) && b.generation >= 0;
}

export function invitationMatches(binding, entry, file) {
  return validBinding(binding) && entry?.role === binding.role && entry?.sha256 === binding.sha256 && entry?.createdAt === binding.createdAt && file?.generation === binding.generation;
}
