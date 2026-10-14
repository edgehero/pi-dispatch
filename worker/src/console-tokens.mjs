/**
 * The operator console's tokens file (issue #640, INT-CONSOLE-TOKENS-FILE-CONTRACT).
 *
 * One JSON file, `{version: 1, generation, tokens: [{name, role, sha256, createdAt}]}`, at PI_CONSOLE_TOKENS_FILE
 * (default `console-tokens.json` in the deployment directory). The console reads it to sign a browser in; the CLI
 * (`pi-dispatch-console token ...`) is its only writer, and doctor judges it. Only the SHA-256 of each token is kept,
 * so a copy of the file signs nobody in.
 *
 * WHY SHA-256 AND NOT A PASSWORD KDF (bcrypt, scrypt, argon2): a KDF exists to make guessing a LOW-entropy secret slow.
 * These tokens are 32 random bytes (256 bits) from the CSPRNG, which no amount of guessing reaches, so a slow hash adds
 * only CPU per login and a dependency. A fast hash of a full-entropy secret is the standard construction for API
 * tokens. Do not "fix" this to a KDF; a token an operator typed would be the case for one, and none is.
 *
 * WHY THE FILE IS JUDGED LIKE ssh JUDGES authorized_keys: whoever can write it can add an operator, and whoever can read
 * it learns who exists. So a symlink, anything but a regular file, any group or world bit, or another owner than the
 * process is a refusal, never a warning. The read opens with O_NOFOLLOW and re-checks the open descriptor, so a link
 * swapped in between the lstat and the read is refused too.
 *
 * Writes are tmp + rename in the same directory (a tmp of its own, created exclusively at 0600), a symlinked target is
 * refused, and the file is re-read right before the rename: a concurrent writer's change is a refusal, never a silent
 * lost update.
 */
import * as nodeFs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

/** Every plaintext token starts with this, so a leaked one is greppable and a secret scanner can match it. */
export const TOKEN_PREFIX = "pdc_";

/** A token's name: lowercase, starts with a letter or digit, at most 32 characters. It lands in audit rows and logs. */
export const TOKEN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The roles a token can carry: an operator may write, a viewer only reads. */
export const TOKEN_ROLES = Object.freeze(["operator", "viewer"]);

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DEFAULT_FILE = "console-tokens.json";
const ADD_HINT = "`pi-dispatch-console token add --name <name> --role operator`";

/** A new plaintext token: the prefix plus 32 random bytes as base64url (43 characters). Shown once, never stored. */
export function newToken(random = randomBytes) {
	return `${TOKEN_PREFIX}${random(32).toString("base64url")}`;
}

/** The SHA-256 of a token, lowercase hex: what the file keeps. */
export function hashToken(token) {
	return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** The tokens file's absolute path: PI_CONSOLE_TOKENS_FILE, or `console-tokens.json`, resolved against `dir`. */
export function tokensFilePath(env, dir) {
	const configured = typeof env?.PI_CONSOLE_TOKENS_FILE === "string" ? env.PI_CONSOLE_TOKENS_FILE.trim() : "";
	return resolve(dir, configured || DEFAULT_FILE);
}

/**
 * Parse and validate the file's text. Returns `{version: 1, generation, tokens}` with each entry reduced to its four
 * fields, or THROWS an Error whose message is a sentence an operator can act on. A version other than 1 is refused
 * (a newer pi-dispatch wrote it, and reading it as 1 could drop a rule it added). Duplicate names are refused (a revoke
 * would remove only one), and so are duplicate hashes (two names for one secret make the audit row's actor ambiguous).
 * The message never quotes a hash.
 */
export function parseTokensFile(text, path) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`the console tokens file ${path} is not valid JSON; fix it by hand or remove it and run ${ADD_HINT}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`the console tokens file ${path} must hold a JSON object with "version" and "tokens"`);
	}
	if (raw.version !== 1) {
		const seen = raw.version === undefined ? "no version" : `version ${JSON.stringify(raw.version)}`;
		throw new Error(`the console tokens file ${path} has ${seen}, and this pi-dispatch reads only version 1; it was written by another pi-dispatch, so upgrade this one or recreate the file with ${ADD_HINT}`);
	}
	const generation = raw.generation === undefined ? 0 : raw.generation;
	if (!Number.isSafeInteger(generation) || generation < 0) {
		throw new Error(`the console tokens file ${path} has a "generation" that is not a whole number of 0 or more; set it to 0`);
	}
	if (!Array.isArray(raw.tokens)) {
		throw new Error(`the console tokens file ${path} has no "tokens" list; add one with ${ADD_HINT}`);
	}
	const names = new Set();
	const hashes = new Set();
	const tokens = raw.tokens.map((entry, i) => {
		const at = `entry ${i + 1} of the console tokens file ${path}`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} is not an object`);
		if (typeof entry.name !== "string" || !TOKEN_NAME_RE.test(entry.name)) {
			throw new Error(`${at} has a name that is not 1 to 32 characters of a-z, 0-9, '.', '_' and '-' starting with a letter or digit`);
		}
		if (names.has(entry.name)) throw new Error(`${at} repeats the name "${entry.name}"; remove one of them (token revoke removes both)`);
		names.add(entry.name);
		if (!TOKEN_ROLES.includes(entry.role)) throw new Error(`${at} ("${entry.name}") has a role other than ${TOKEN_ROLES.join(" or ")}`);
		if (typeof entry.sha256 !== "string" || !SHA256_HEX_RE.test(entry.sha256)) {
			throw new Error(`${at} ("${entry.name}") has a sha256 that is not 64 lowercase hex characters; rotate it with \`pi-dispatch-console token rotate --name ${entry.name}\``);
		}
		if (hashes.has(entry.sha256)) throw new Error(`${at} ("${entry.name}") has the same secret as another entry; rotate one of them`);
		hashes.add(entry.sha256);
		if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) {
			throw new Error(`${at} ("${entry.name}") has a createdAt that is not an ISO date`);
		}
		return { name: entry.name, role: entry.role, sha256: entry.sha256, createdAt: entry.createdAt };
	});
	return { version: 1, generation, tokens };
}

/** The uid the file must belong to by default: this process's, or undefined where there is none (Windows). */
function processUid() {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** What is wrong with a stat of the tokens file, or null. Shared by the lstat and the open-descriptor check. */
function statProblem(st, path, uid) {
	if (st.isSymbolicLink?.()) {
		return `the console tokens file ${path} is a symbolic link, and the console reads only a regular file; point PI_CONSOLE_TOKENS_FILE at the real file`;
	}
	if (!st.isFile()) return `the console tokens file ${path} is not a regular file; remove it and run ${ADD_HINT}`;
	if ((st.mode & 0o077) !== 0) {
		return `the console tokens file ${path} can be read or written by other accounts (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}); run \`chmod 600 ${path}\``;
	}
	if (uid !== undefined && uid !== null && st.uid !== uid) {
		return `the console tokens file ${path} is owned by uid ${st.uid}, not by this account (uid ${uid}); run the console as that account, or \`chown\` the file to this one`;
	}
	return null;
}

/**
 * null when the file at `path` is fit to read, else the sentence saying why not: missing, a symlink (by lstat, never
 * stat), not a regular file, any group or world mode bit, or an owner other than `uid`. `uid` defaults to this
 * process's; null skips the owner check (Windows has no uid).
 */
export function tokensFileProblem({ path, fs = nodeFs, uid = processUid() }) {
	let st;
	try {
		st = fs.lstatSync(path);
	} catch (e) {
		if (e?.code === "ENOENT") return `the console tokens file ${path} does not exist; create the first operator with ${ADD_HINT}`;
		return `the console tokens file ${path} could not be inspected (${typeof e?.code === "string" ? e.code : "error"}); check its directory's permissions`;
	}
	return statProblem(st, path, uid);
}

/**
 * Read the tokens file: `{file}` (the parsed shape) or `{refusal}` (a sentence). The problem check first, then the
 * read through an O_NOFOLLOW descriptor whose own fstat is judged again, so the bytes parsed are the file judged.
 */
export function readTokensFile({ path, fs = nodeFs, uid = processUid() }) {
	const read = readTokensText(path, fs, uid);
	return read.refusal ? { refusal: read.refusal } : { file: read.file };
}

/** `readTokensFile`, plus the exact `text` that was judged and parsed (a writer's `before`). */
function readTokensText(path, fs, uid) {
	const problem = tokensFileProblem({ path, fs, uid });
	if (problem) return { refusal: problem };
	let text;
	try {
		text = readJudged(path, fs, uid);
	} catch (e) {
		if (e?.refusal) return { refusal: e.refusal };
		return { refusal: `the console tokens file ${path} could not be read (${typeof e?.code === "string" ? e.code : "error"}); check its permissions` };
	}
	try {
		return { file: parseTokensFile(text, path), text };
	} catch (e) {
		return { refusal: e?.message ?? String(e) };
	}
}

/** The file's text read through a no-follow descriptor whose fstat passes `statProblem`; throws `{refusal}` if not. */
function readJudged(path, fs, uid) {
	const noFollow = fs.constants?.O_NOFOLLOW ?? nodeFs.constants.O_NOFOLLOW ?? 0;
	const rdOnly = fs.constants?.O_RDONLY ?? nodeFs.constants.O_RDONLY;
	if (typeof fs.openSync !== "function" || typeof fs.fstatSync !== "function") return fs.readFileSync(path, "utf8");
	let fd;
	try {
		fd = fs.openSync(path, rdOnly | noFollow);
	} catch (e) {
		if (e?.code === "ELOOP") throw { refusal: statProblem({ isSymbolicLink: () => true }, path, uid) };
		throw e;
	}
	try {
		const problem = statProblem(fs.fstatSync(fd), path, uid);
		if (problem) throw { refusal: problem };
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The entry whose token `presented` is, or null. The presented value is hashed and compared against EVERY entry with
 * `timingSafeEqual`, without an early exit, so the time taken says nothing about which entry (or how much of one)
 * matched. Equal-length buffers always: both sides are 32-byte digests.
 */
export function findToken(file, presented) {
	if (typeof presented !== "string" || presented === "" || !Array.isArray(file?.tokens)) return null;
	const digest = createHash("sha256").update(presented, "utf8").digest();
	let found = null;
	for (const entry of file.tokens) {
		const stored = Buffer.from(typeof entry?.sha256 === "string" && SHA256_HEX_RE.test(entry.sha256) ? entry.sha256 : "0".repeat(64), "hex");
		if (timingSafeEqual(stored, digest) && found === null) found = entry;
	}
	return found;
}

/** How many operator tokens the file holds. The console refuses to start on none. */
export function operatorCount(file) {
	return Array.isArray(file?.tokens) ? file.tokens.filter((t) => t?.role === "operator").length : 0;
}

/** The serialized file, the one shape every writer produces. */
function serialize(file) {
	return `${JSON.stringify({ version: 1, generation: file.generation, tokens: file.tokens }, null, 2)}\n`;
}

/**
 * The file as it is now, for a writer: `{file, text}` (text null when it does not exist yet, then `file` is the empty
 * one) or `{invalid}`. An existing file must pass the same check the console applies, so the CLI never quietly keeps
 * writing a file the console would refuse.
 */
function loadForWrite(path, fs, uid, { create }) {
	let missing = false;
	try {
		fs.lstatSync(path);
	} catch (e) {
		if (e?.code !== "ENOENT") return { invalid: `the console tokens file ${path} could not be inspected (${typeof e?.code === "string" ? e.code : "error"}); nothing was written` };
		missing = true;
	}
	if (missing) {
		if (!create) return { invalid: `the console tokens file ${path} does not exist, so there is nothing to change; create the first operator with ${ADD_HINT}` };
		return { file: { version: 1, generation: 0, tokens: [] }, text: null };
	}
	// ONE read: the text parsed is the text the pre-rename re-check compares against. A second read for `before` could
	// see another command's write that `next` (built from the first) does not hold, pass the re-check, and lose it.
	const read = readTokensText(path, fs, uid);
	if (read.refusal) return { invalid: `${read.refusal}. Nothing was written` };
	return { file: read.file, text: read.text };
}

/** The file's text, null when missing; any other read error is its own string, which no file's text equals. */
function snapshot(fs, path) {
	try {
		return fs.readFileSync(path, "utf8");
	} catch (e) {
		return e?.code === "ENOENT" ? null : `\u0000unreadable:${typeof e?.code === "string" ? e.code : "error"}`;
	}
}

/**
 * Replace the file with `next`: a tmp of its own beside it (`wx`, 0600, chmod'd exactly since create is masked by the
 * umask), the target re-checked as not a symlink and as still holding `before` right before the rename, then rename.
 * Returns `{ok}` or `{invalid}`.
 */
function writeTokens(path, next, before, fs, random) {
	const code = (e) => (typeof e?.code === "string" ? e.code : "error");
	const linked = () => {
		try {
			return fs.lstatSync(path).isSymbolicLink();
		} catch {
			return false;
		}
	};
	if (linked()) return { invalid: `the console tokens file ${path} is a symbolic link, and the console writes only a regular file; point PI_CONSOLE_TOKENS_FILE at the real file. Nothing was written` };
	const tmp = `${path}.${process.pid}.${random(6).toString("hex")}.tmp`;
	const drop = () => {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// nothing to drop
		}
	};
	try {
		fs.writeFileSync(tmp, serialize(next), { mode: 0o600, flag: "wx" });
	} catch (e) {
		return { invalid: `the console tokens file ${path} could not be written (${code(e)}: a new file beside it could not be created; does its directory exist and belong to this account?). Nothing was written` };
	}
	try {
		fs.chmodSync(tmp, 0o600);
	} catch (e) {
		drop();
		return { invalid: `the console tokens file ${path} could not be written (${code(e)}: the new file could not be made private). Nothing was written` };
	}
	if (linked() || snapshot(fs, path) !== before) {
		drop();
		return { invalid: `the console tokens file ${path} changed while this change was being made (another command wrote it); nothing was written. Run the command again` };
	}
	try {
		fs.renameSync(tmp, path);
	} catch (e) {
		drop();
		return { invalid: `the console tokens file ${path} could not be replaced (${code(e)}); nothing was written` };
	}
	return { ok: true };
}

/** The ISO time of `now()`. */
function iso(now) {
	return new Date(now()).toISOString();
}

/**
 * Add a token named `name` with `role`: `{token, entry}` (the plaintext, to print ONCE, and the stored entry) or
 * `{invalid}`. Creates the file at 0600 when it is missing. An existing name is refused: rotate it instead, so a typo
 * never silently replaces someone's secret.
 */
export function addToken({ path, name, role, fs = nodeFs, now = () => Date.now(), random = randomBytes, uid = processUid() }) {
	if (typeof name !== "string" || !TOKEN_NAME_RE.test(name)) {
		return { invalid: "a token name is 1 to 32 characters of a-z, 0-9, '.', '_' and '-', starting with a letter or digit" };
	}
	if (!TOKEN_ROLES.includes(role)) return { invalid: `a token's role is ${TOKEN_ROLES.join(" or ")}` };
	const loaded = loadForWrite(path, fs, uid, { create: true });
	if (loaded.invalid) return loaded;
	if (loaded.file.tokens.some((t) => t.name === name)) {
		return { invalid: `a token named "${name}" already exists; give it a new secret with \`pi-dispatch-console token rotate --name ${name}\`, or choose another name` };
	}
	const token = newToken(random);
	const entry = { name, role, sha256: hashToken(token), createdAt: iso(now) };
	const written = writeTokens(path, { ...loaded.file, tokens: [...loaded.file.tokens, entry] }, loaded.text, fs, random);
	if (written.invalid) return written;
	return { token, entry };
}

/** Remove the token named `name`: `{ok}` or `{invalid}`. Every session signed in with it ends on its next request. */
export function revokeToken({ path, name, fs = nodeFs, random = randomBytes, uid = processUid() }) {
	const loaded = loadForWrite(path, fs, uid, { create: false });
	if (loaded.invalid) return loaded;
	if (!loaded.file.tokens.some((t) => t.name === name)) return { invalid: `there is no token named "${String(name)}"; \`pi-dispatch-console token list\` shows the names` };
	return writeTokens(path, { ...loaded.file, tokens: loaded.file.tokens.filter((t) => t.name !== name) }, loaded.text, fs, random);
}

/**
 * Give the token named `name` a new secret, keeping its role: `{token, entry}` or `{invalid}`. The old secret stops
 * working, and every session signed in with it ends on its next request (its hash is gone from the file).
 */
export function rotateToken({ path, name, fs = nodeFs, now = () => Date.now(), random = randomBytes, uid = processUid() }) {
	const loaded = loadForWrite(path, fs, uid, { create: false });
	if (loaded.invalid) return loaded;
	const old = loaded.file.tokens.find((t) => t.name === name);
	if (!old) return { invalid: `there is no token named "${String(name)}"; \`pi-dispatch-console token list\` shows the names` };
	const token = newToken(random);
	const entry = { name, role: old.role, sha256: hashToken(token), createdAt: iso(now) };
	const written = writeTokens(path, { ...loaded.file, tokens: loaded.file.tokens.map((t) => (t.name === name ? entry : t)) }, loaded.text, fs, random);
	if (written.invalid) return written;
	return { token, entry };
}

/**
 * End every console session at once: bump `generation`, which every session was created under, so each one fails its
 * next request. The tokens stay valid. `{ok, generation}` (the new one) or `{invalid}`.
 */
export function endAllSessions({ path, fs = nodeFs, random = randomBytes, uid = processUid() }) {
	const loaded = loadForWrite(path, fs, uid, { create: false });
	if (loaded.invalid) return loaded;
	const generation = loaded.file.generation + 1;
	const written = writeTokens(path, { ...loaded.file, generation }, loaded.text, fs, random);
	if (written.invalid) return written;
	return { ok: true, generation };
}
