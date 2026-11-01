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
 */
import * as nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** A code: 32 random bytes as base64url, always 43 characters. */
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_FILE_RE = /^[0-9a-f]{64}\.json$/;
/** How far a code's `expiresAt` may sit past `now + ttlMs` (a clock stepped between mint and consume). */
const EXPIRY_SKEW_MS = 5000;

/** The drop directory: `console-login-codes` beside the tokens file. */
export function loginCodesDir(tokensPath) {
  return join(dirname(tokensPath), "console-login-codes");
}

function codeHash(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
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
 * Make a code for token `name`, valid for `ttlMs`: `{code}` (to put in the link's fragment, printed once) or
 * `{refusal}`. The caller has already checked that `name` is in the tokens file.
 */
export function mintLoginCode({ dir, name, fs = nodeFs, now = () => Date.now(), random = randomBytes, ttlMs = 60000, binding = undefined }) {
  if (binding !== undefined && !validBinding(binding)) return { refusal: "the viewer invitation binding is invalid; create a new invitation" };
  if (typeof name !== "string" || name === "") return { refusal: "a login code needs the name of a token in the tokens file" };
  const problem = dirProblem(dir, fs, { create: true });
  if (problem) return { refusal: problem };
  const t = now();
  reap(dir, fs, t);
  const code = random(32).toString("base64url");
  const file = join(dir, `${codeHash(code)}.json`);
  try {
    fs.writeFileSync(file, `${JSON.stringify({ name, expiresAt: new Date(t + ttlMs).toISOString(), ...(binding === undefined ? {} : { binding }) })}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    return { refusal: `the login code could not be written in ${dir} (${errCode(e)}); nothing was made` };
  }
  try {
    // The create's mode is masked by the umask; set it exactly.
    fs.chmodSync(file, 0o600);
  } catch (e) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
    return { refusal: `the login code in ${dir} could not be made private (${errCode(e)}); nothing was made` };
  }
  return { code };
}

/**
 * Spend a code: `{name}` for the one caller that removes its file before it expires, `{refusal}` for everyone else
 * (unknown, already used, expired, malformed). The refusal never quotes the code.
 */
export function consumeLoginCode({ dir, code, fs = nodeFs, now = () => Date.now(), ttlMs = 60000, uid = processUid() }) {
  const used = "this login link is not valid: it was already used, has expired, or was never made. Run `pi-dispatch-console link --name <name>` for a new one";
  if (typeof code !== "string" || !CODE_RE.test(code)) return { refusal: used };
  const problem = dirProblem(dir, fs, { create: false });
  if (problem) return { refusal: problem };
  const t = now();
  const taken = take(join(dir, `${codeHash(code)}.json`), fs, uid);
  reap(dir, fs, t);
  if (!taken) return { refusal: used };
  if (!Number.isFinite(taken.expiresAt) || taken.expiresAt <= t) {
    return { refusal: "this login link has expired. Run `pi-dispatch-console link --name <name>` for a new one" };
  }
  // A code the minter made expires at most `ttlMs` after it was made; one that claims longer (allowing a few seconds of
  // clock step) was written by something else.
  if (taken.expiresAt > t + ttlMs + EXPIRY_SKEW_MS) return { refusal: used };
  if (typeof taken.name !== "string" || taken.name === "") return { refusal: used };
  if (Object.hasOwn(taken, "binding") && !validBinding(taken.binding)) return { refusal: used };
  return { name: taken.name, ...(taken.binding === undefined ? {} : { binding: taken.binding }) };
}

/** Browser invitations cannot follow a same-name replacement into a different role or token incarnation (#774). */
function validBinding(b) {
  return b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).sort().join(",") === "createdAt,generation,role,sha256" && b.role === "viewer" && /^[0-9a-f]{64}$/.test(b.sha256) && typeof b.createdAt === "string" && Number.isFinite(Date.parse(b.createdAt)) && Number.isSafeInteger(b.generation) && b.generation >= 0;
}

export function invitationMatches(binding, entry, file) {
  return validBinding(binding) && entry?.role === binding.role && entry?.sha256 === binding.sha256 && entry?.createdAt === binding.createdAt && file?.generation === binding.generation;
}
