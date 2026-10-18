/**
 * The terminal chat's fork mode (issue #647, REQ-TERMINAL-CHAT): open a FINISHED run's conversation in the operator's
 * own pi, on the host that holds the session store, to read it and go on talking to it locally.
 *
 * THE CANONICAL TRANSCRIPT IS NEVER WRITTEN. `pi --session <path>` would open the store's `current.jsonl` and append to
 * it, a second writer beside the worker's promotion (no lock covers it, pi appends plainly), and the next job on that
 * issue would resume from the operator's local chat. `pi --fork <path>` copies the file into pi's own sessions folder
 * and records the source as the fork's `parentSession`; even that is not handed the canonical file. This module first
 * copies it, with `O_NOFOLLOW` and a descriptor re-check, to `~/.pi-dispatch/chat/<key>/source-<ts>.jsonl` (0600, the
 * directories 0700), and forks the COPY, so nothing pi writes or records ever names a path inside PI_SESSIONS_DIR.
 * The source is opened read-only; its bytes and its mtime are unchanged (a test holds both).
 *
 * HOST-LOCAL BY DECISION. No console route serves a raw transcript: the stored one is UNREDACTED (it holds whatever the
 * job saw, a secret a tool printed included), and the console's transcripts are the redacted live stream. So this mode
 * needs the store's directory on this machine and reads it directly; a remote fork was rejected (DES-TERMINAL-CHAT).
 *
 * THE CHECKS, ALL FREE, IN ORDER (`planFork`), each refusal a sentence:
 *   1. the record has a session at all (a forge issue or a cron trigger: a forge or `local` kind);
 *   2. it is not a pull or merge request (their key needs the head ref, which no record carries);
 *   3. its key derives (`sessionKeyOfRecord`, the one key rule: an issue number or a cron trigger id);
 *   4. the key, derived or given, is 32 lowercase hex;
 *   5. PI_SESSIONS_DIR is set (the deployment's, as the service reads it);
 *   6. the key's directory exists and can be read;
 *   7. it is a real directory, not a link or a file;
 *   8. `current.jsonl` exists and can be read;
 *   9. it is not a symbolic link;
 *  10. it is a regular file;
 *  11. it is not empty;
 *  12. it is within `FORK_SOURCE_MAX_BYTES`;
 *  13. the venue stamp is not the promotion's `(pending)` sentinel (a promotion is swapping the file right now);
 *  14. there is a pi to run (`resolvePiBinary`'s refusal, carried in);
 *  15. the `pi-version` stamp is readable, unless `--force`;
 *  16. the host pi's version is readable, unless `--force`;
 *  17. the stamp is not newer than the host pi, unless `--force` (an older stamp is only noted: pi reads older
 *      sessions);
 * then a warning (not a refusal) when a newer run on the same target shares the session: the file then holds that run's
 * conversation too, since the store keeps one transcript per issue.
 *
 * `runFork` then refuses, in order: no absolute home directory; a chat folder inside PI_SESSIONS_DIR (the store's
 * reaper owns everything there); a `~/.pi-dispatch` or chat folder that is a link, not a directory, or not owned by
 * this user (one owned by this user is made 0700); and a copy that fails (the source swapped since the check, grown
 * past the cap, or a planted destination). It asks y/N naming the bytes and the provider and model the operator's pi
 * will send them to (`forkModelOf`: when pi's settings name a default provider AND model, both are passed to pi as
 * `--provider` and `--model`, so the prompt names exactly what pi uses; otherwise the prompt says pi restores the run's
 * own model when it has a key for that provider, and else falls back to its default, which is what pi 1.2.0's
 * `createAgentSession` does). Then it runs `<pi> --fork <copy> --no-tools` in the operator's current directory, with
 * every `PI_CONSOLE_*` variable taken out of pi's environment (the console token is this command's, never pi's).
 * Tools are off unless `--tools`: the conversation is agent-written text from a job that read untrusted input, and a
 * forked agent with tools would act on the operator's machine (their directory is not the job's workspace either, which
 * the command says).
 *
 * NOTHING UNREDACTED IS LEFT IN ~/.pi-dispatch/chat. A "no", Ctrl+C or SIGTERM/SIGHUP at the y/N removes the copy
 * (the signal then ends the command); once pi exits the copy is removed too, because `pi --fork` has by then written
 * its own copy into its sessions folder (`SessionManager.forkFrom` writes `<sessionDir>/<ISO>_<id>.jsonl` before the
 * first prompt, pi 1.2.0). That copy is pi's, under the operator's own pi, and the command says it holds the same
 * unredacted transcript.
 */
import * as nodeFs from "node:fs";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_KEY_PATTERN, sessionKeyOfRecord } from "./session-key.mjs";
import { isForgeKind } from "./forges.mjs";

/** The largest transcript forked. The store's own default cap is 8 MiB; this is generous above any setting of it. */
export const FORK_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

/** The session store's file names (`session-store.mjs`; a test reads that file and holds these equal to it). */
export const SESSION_FILE = "current.jsonl";
export const PI_VERSION_FILE = "pi-version";
export const VENUE_FILE = "venue";
export const VENUE_PENDING = "(pending)";

/** Every sidecar is a handful of bytes (`session-store.mjs`'s SIDECAR_MAX_BYTES). */
const SIDECAR_MAX_BYTES = 4096;

/** How far a transcript's mtime may sit after its run's end before it is read as a later run's promotion. */
const NEWER_PROMOTION_SKEW_MS = 5 * 60 * 1000;

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The environment a child (pi, `pi --version`) is given: this shell's, minus every `PI_CONSOLE_*` variable. The console
 * token and address are this command's credentials; a forked agent (with `--tools`, able to run commands) or anything
 * it loads must never read them.
 */
export function childEnv(env = process.env) {
	const kept = {};
	for (const [name, value] of Object.entries(env ?? {})) if (!/^PI_CONSOLE_/.test(name)) kept[name] = value;
	return kept;
}

/** What to run when no pi is found. */
export const PI_INSTALL_HINT = "install pi (npm install -g @earendil-works/pi-coding-agent) or pass --pi <path>";

/** -1, 0 or 1 for two exact versions. */
export function compareVersions(a, b) {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
}

/** A pull or merge request's record: a `pull_request` trigger, or a target spelled with `!` (GitLab, Azure). */
export function isPullRequestRecord(record) {
	return record?.triggerType === "pull_request" || (typeof record?.target === "string" && /![0-9]+$/.test(record.target));
}

/** A small sidecar beside the transcript: its trimmed text, or null when it is not a regular, non-empty, small file. */
function readSidecar(fs, dir, name) {
	try {
		const st = fs.lstatSync(join(dir, name));
		if (!st.isFile() || st.size === 0 || st.size > SIDECAR_MAX_BYTES) return null;
		return String(fs.readFileSync(join(dir, name), "utf8")).trim();
	} catch {
		return null;
	}
}

/** Whether `child` is `parent` or inside it, by path alone. */
function within(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The pi binary to run: `--pi` (it must be an executable file), else `pi` on PATH, else the
 * `@earendil-works/pi-coding-agent` this package can resolve (its `bin.pi`), else `{refusal}` with the install hint.
 * Returns `{path, from}`.
 */
export function resolvePiBinary({ flag = null, env = process.env, fs = nodeFs, resolvePackage = defaultResolvePackage, platform = process.platform } = {}) {
	const executable = (p) => {
		try {
			const st = fs.statSync(p);
			if (!st.isFile()) return false;
			if (platform === "win32") return true;
			fs.accessSync(p, nodeFs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (typeof flag === "string" && flag !== "") {
		const p = resolve(flag);
		return executable(p) ? { path: p, from: "--pi" } : { refusal: `--pi ${p} is not an executable file` };
	}
	const names = platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
	// env-internal PATH: the operator's own command search path, to find the pi they run themselves.
	for (const dir of String(env.PATH ?? "").split(delimiter)) {
		if (dir === "" || !isAbsolute(dir)) continue;
		for (const name of names) if (executable(join(dir, name))) return { path: join(dir, name), from: "PATH" };
	}
	const installed = resolvePackage();
	if (installed && executable(installed)) return { path: installed, from: "the installed @earendil-works/pi-coding-agent" };
	return { refusal: `no pi to run: ${PI_INSTALL_HINT}` };
}

/** The installed pi-coding-agent's `bin.pi`, or null. pi exports no package.json, so its entry is walked up from. */
function defaultResolvePackage() {
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		for (let i = 0; i < 6; i += 1) {
			const pkg = join(dir, "package.json");
			if (nodeFs.existsSync(pkg)) {
				const json = JSON.parse(nodeFs.readFileSync(pkg, "utf8"));
				if (json?.name === "@earendil-works/pi-coding-agent" && typeof json?.bin?.pi === "string") return join(dir, json.bin.pi);
			}
			dir = dirname(dir);
		}
	} catch {
		// not installed beside this package
	}
	return null;
}

/** The host pi's version from `<pi> --version` (an exact x.y.z on its first line), or null. */
export function piVersionOf(piPath, { spawnSync = nodeSpawnSync, env = process.env } = {}) {
	try {
		const got = spawnSync(piPath, ["--version"], { encoding: "utf8", timeout: 15_000, env: childEnv(env), stdio: ["ignore", "pipe", "ignore"] });
		const first = String(got?.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
		return got?.status === 0 && VERSION_RE.test(first) ? first : null;
	} catch {
		return null;
	}
}

const MODEL_ID_RE = /^[A-Za-z0-9._@~/:+-]{1,128}$/;
const plainId = (v) => (typeof v === "string" && MODEL_ID_RE.test(v) ? v : null);

/**
 * The operator's pi defaults, `{provider, model}` (each a plain id or null): `defaultProvider` and `defaultModel` from
 * `<agentDir>/settings.json` ONLY, the operator's own file. The current folder's `.pi/settings.json` is never read,
 * because these become `--provider` and `--model`, which decide where the unredacted transcript is sent: a cloned
 * repository could otherwise route it to a provider of its author's choosing. pi 1.2.0 itself applies project
 * settings only in a folder the operator trusted (`SettingsManager.setProjectTrusted`); not reading them at all is the
 * simpler rule and needs no copy of pi's trust store.
 */
export function hostDefaultsOf({ agentDir, fs = nodeFs }) {
	const file = join(agentDir, "settings.json");
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile() || st.size > 1024 * 1024) return { provider: null, model: null };
		const settings = JSON.parse(fs.readFileSync(file, "utf8"));
		return { provider: plainId(settings?.defaultProvider), model: plainId(settings?.defaultModel) };
	} catch {
		return { provider: null, model: null }; // unreadable settings name nothing
	}
}

/**
 * The model a pi session last used, `{provider, modelId}` or null: the last `model_change` entry, or the last assistant
 * message's `provider`/`model`, whichever comes later in the file. That is what pi 1.2.0's `getBranchSelection` reads to
 * restore a model when a session is opened (for a linear transcript, the file's order is the branch's).
 */
export function sessionModelOf(file, { fs = nodeFs } = {}) {
	let text;
	try {
		text = String(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (lines[i].trim() === "") continue;
		let entry;
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const pair = entry?.type === "model_change" ? [entry.provider, entry.modelId] : entry?.type === "message" && entry.message?.role === "assistant" ? [entry.message.provider, entry.message.model] : null;
		if (pair === null) continue;
		const [provider, modelId] = pair.map(plainId);
		return provider && modelId ? { provider, modelId } : null;
	}
	return null;
}

/**
 * What the fork's consent names and what pi is told, so the two never disagree: `{args, phrase}`.
 *   - pi's settings name a default provider AND model: both are passed (`--provider P --model M`), and pi uses exactly
 *     them (an explicit model is never replaced by the session's);
 *   - else, the session names a model: pi restores it only when it knows the model and has a key for its provider, and
 *     otherwise falls back to its default; the phrase says both, since this command cannot see pi's keys;
 *   - else: pi's default provider, or a phrase saying pi picks.
 */
export function forkModelOf({ defaults = {}, session = null } = {}) {
	if (defaults.provider && defaults.model) {
		return { args: ["--provider", defaults.provider, "--model", defaults.model], phrase: `${defaults.provider} (model ${defaults.model}, your pi's default, passed to pi as --provider and --model)` };
	}
	const fallback = defaults.provider ? `your pi's default provider, ${defaults.provider}` : "whichever provider your pi falls back to";
	if (session) {
		return { args: [], phrase: `${session.provider} (the run's own model, ${session.provider}/${session.modelId}) if your pi knows that model and has a key for ${session.provider}, and otherwise ${fallback}` };
	}
	return { args: [], phrase: defaults.provider ? `${defaults.provider} (your pi's default provider)` : "whichever provider your pi is set to use (its agent dir's settings name no defaultProvider)" };
}

/**
 * Judge a fork before anything is copied or run (the module comment's checks 1 to 8, in that order). Inputs: `record`
 * (a run record, or null for a bare session key), `key` (a 32-hex key given directly), `env` (the deployment's
 * `PI_SESSIONS_DIR`), `force`, `newerRunOnTarget` (the console's: the newer run's job id, or null), `pi` (`{path}` from `resolvePiBinary`, or
 * `{refusal}`), `piVersion` (the host pi's, from `piVersionOf`). Returns `{plan}` or `{refusal}`.
 */
export function planFork({ record = null, key = null, env = {}, force = false, newerRunOnTarget = false, pi, piVersion = null, fs = nodeFs }) {
	let k = key;
	if (record !== null) {
		const sessionKind = isForgeKind(record?.kind) || record?.kind === "local";
		if (!sessionKind) return { refusal: "this run has no session to fork: only a forge issue's runs and a cron trigger's runs keep one" };
		if (isPullRequestRecord(record)) return { refusal: "this run worked on a pull or merge request, whose session key needs the request's head branch, which no run record carries; fork it by its session key instead (pi-dispatch chat <32-hex key>)" };
		k = sessionKeyOfRecord(record);
		if (k === null) return { refusal: "this run has no session to fork: its record names no issue number or cron trigger id to derive a session key from" };
	}
	if (typeof k !== "string" || !SESSION_KEY_PATTERN.test(k)) return { refusal: "a session key is 32 lowercase hex characters" };
	const sessionsDir = typeof env.PI_SESSIONS_DIR === "string" ? env.PI_SESSIONS_DIR.trim() : "";
	if (sessionsDir === "") return { refusal: "PI_SESSIONS_DIR is not set for this deployment, so there is no session store on this host to fork from; run this on the host whose worker keeps the sessions, from its deployment folder" };
	const dir = join(resolve(sessionsDir), k);
	let dst;
	try {
		dst = fs.lstatSync(dir);
	} catch (e) {
		if (e?.code === "ENOENT") return { refusal: `there is no session ${k} in ${resolve(sessionsDir)}: the run did not keep one (its trigger has no run.resume), it was reaped (PI_SESSIONS_TTL_DAYS), or the store is on another host` };
		return { refusal: `the session folder ${dir} cannot be read (${e?.code ?? "error"})` };
	}
	if (!dst.isDirectory()) return { refusal: `${dir} is not a plain directory (a link or a file), so it is not read` };
	const file = join(dir, SESSION_FILE);
	let st;
	try {
		st = fs.lstatSync(file);
	} catch (e) {
		return { refusal: e?.code === "ENOENT" ? `session ${k} has no transcript (${SESSION_FILE}) yet` : `the transcript ${file} cannot be read (${e?.code ?? "error"})` };
	}
	if (st.isSymbolicLink()) return { refusal: `${file} is a symbolic link, so it is not read (the store never writes one)` };
	if (!st.isFile()) return { refusal: `${file} is not a regular file, so it is not read` };
	if (st.size === 0) return { refusal: `${file} is empty: there is no conversation to fork` };
	if (st.size > FORK_SOURCE_MAX_BYTES) return { refusal: `${file} is ${st.size} bytes, over the ${FORK_SOURCE_MAX_BYTES}-byte limit for a fork` };
	if (readSidecar(fs, dir, VENUE_FILE) === VENUE_PENDING) return { refusal: `a promotion is replacing session ${k}'s transcript right now; try again in a minute` };
	if (pi?.refusal) return { refusal: pi.refusal };
	const notes = [];
	const stamp = readSidecar(fs, dir, PI_VERSION_FILE);
	const stampOk = typeof stamp === "string" && VERSION_RE.test(stamp);
	if (!stampOk) {
		if (!force) return { refusal: `session ${k} has no readable pi-version stamp, so whether your pi can read it is unknown; pass --force to fork it anyway` };
		notes.push("its pi-version stamp is unreadable (--force)");
	} else if (piVersion === null) {
		if (!force) return { refusal: `the version of ${pi.path} could not be read (pi --version), so whether it can read a session written by pi ${stamp} is unknown; pass --force to fork it anyway` };
		notes.push(`written by pi ${stamp}; your pi's version could not be read (--force)`);
	} else {
		const cmp = compareVersions(stamp, piVersion);
		if (cmp > 0 && !force) return { refusal: `session ${k} was written by pi ${stamp}, newer than your pi ${piVersion}; an older pi may misread it. Upgrade pi, or pass --force` };
		if (cmp > 0) notes.push(`written by pi ${stamp}, newer than your pi ${piVersion} (--force)`);
		else if (cmp < 0) notes.push(`written by pi ${stamp}; your pi ${piVersion} is newer, and pi reads older sessions`);
	}
	const warnings = [];
	// The console's run says `finishedAt`; this host's run-history record (`buildRecord`) says `endedAt`.
	const endedText = typeof record?.finishedAt === "string" ? record.finishedAt : typeof record?.endedAt === "string" ? record.endedAt : "";
	const endedAt = Date.parse(endedText);
	// The console names the newer run by its job id (`/api/run`'s `newerRunOnTarget`); a mtime after this run's end is
	// the same fact read off the store, for a record the console was not asked about.
	const newerId = typeof newerRunOnTarget === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(newerRunOnTarget) ? newerRunOnTarget : null;
	if (newerId !== null || newerRunOnTarget === true || (Number.isFinite(endedAt) && st.mtimeMs > endedAt + NEWER_PROMOTION_SKEW_MS)) {
		warnings.push(`a newer run on ${typeof record?.target === "string" ? record.target : "this target"}${newerId ? ` (${newerId})` : ""} shares this session: the transcript holds that run's conversation too, not only this run's`);
	}
	return { plan: { key: k, dir, file, bytes: st.size, dev: st.dev, ino: st.ino, stamp: stampOk ? stamp : null, piPath: pi.path, piVersion, notes, warnings, sessionsDir: resolve(sessionsDir) } };
}

/**
 * Copy the transcript to the snapshot path: the source opened `O_RDONLY | O_NOFOLLOW` and its descriptor re-checked
 * (a regular file, the same device and inode `planFork` judged, within the cap), the destination created
 * `O_CREAT | O_EXCL | O_NOFOLLOW` at 0600 so nothing planted at the name is followed or overwritten. Returns the bytes
 * copied; throws an Error with a sentence.
 */
export function copySnapshot({ plan, dest, fs = nodeFs }) {
	const C = nodeFs.constants;
	const src = fs.openSync(plan.file, C.O_RDONLY | (C.O_NOFOLLOW ?? 0));
	let out = null;
	try {
		const st = fs.fstatSync(src);
		if (!st.isFile() || st.dev !== plan.dev || st.ino !== plan.ino) throw new Error(`${plan.file} changed between the check and the copy; run the command again`);
		if (st.size > FORK_SOURCE_MAX_BYTES) throw new Error(`${plan.file} grew past the ${FORK_SOURCE_MAX_BYTES}-byte limit`);
		out = fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
		const buf = Buffer.alloc(1024 * 1024);
		let total = 0;
		for (;;) {
			const n = fs.readSync(src, buf, 0, buf.length, null);
			if (n === 0) break;
			total += n;
			if (total > FORK_SOURCE_MAX_BYTES) throw new Error(`${plan.file} grew past the ${FORK_SOURCE_MAX_BYTES}-byte limit while it was copied`);
			let off = 0;
			while (off < n) off += fs.writeSync(out, buf, off, n - off);
		}
		return total;
	} catch (e) {
		if (out !== null) {
			try {
				fs.closeSync(out);
			} catch {
				// closing a failed copy
			}
			out = null;
			try {
				fs.unlinkSync(dest);
			} catch {
				// nothing to remove
			}
		}
		throw e;
	} finally {
		if (out !== null) fs.closeSync(out);
		fs.closeSync(src);
	}
}

/**
 * Create `dir` and its missing parents at 0700, and refuse one that is a link, not a directory, or owned by another
 * user (who could read or swap what is written there); one of this user's with group or other bits is made 0700. `uid`
 * is the seam (null where the platform has no uids).
 */
export function ensurePrivateDir(fs, dir, { uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = fs.lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
	if (uid === null) return;
	if (st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not by you (uid ${uid}), so nothing is written there`);
	if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

const EXIT_CODE_OF_SIGNAL = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

/**
 * Run a planned fork: refuse when there is no terminal to ask on (`canAsk`, default `proc.stdin.isTTY`), so the
 * unredacted copy is never written for a question that cannot be asked; copy the snapshot under
 * `<home>/.pi-dispatch/chat/<key>/`, ask y/N (`ask(question)`, naming the
 * bytes and the provider `forkModelOf` names), then spawn `<pi> --fork <snapshot>` (with `--provider`/`--model` when
 * that names them, and `--no-tools` unless `tools`), stdio inherited, in `cwd`, with `childEnv(env)`. `out(line)`
 * prints. Returns the exit code: pi's own, 1 for a refusal, 0 for a declined prompt, and 143 or 129 when a SIGTERM
 * or SIGHUP was passed on to pi (the command was told to end, whatever pi then exited with).
 *
 * The snapshot never outlives the command: a "no" removes it; SIGINT, SIGTERM or SIGHUP from before the copy starts
 * until the question is answered removes it and exits (130, 143, 129); once pi exits (or fails to start) it is
 * removed, pi having written its own copy by then. Each removal also removes `<key>/` when that leaves it empty. The
 * signal handlers go on BEFORE the copy: with no listener a signal takes the default action and kills the process
 * mid-copy, leaving a partial unredacted file behind; with one, Node defers it to the handler. While pi runs, SIGTERM
 * and SIGHUP are passed on to it and SIGINT is left to it (a Ctrl+C reaches pi from the terminal itself), so this
 * process outlives pi and can clean up. `proc` is the seam (`on`, `removeListener`, `exit`, `stdin`).
 */
export async function runFork({ plan, ask, out, agentDir = null, cwd = process.cwd(), home = homedir(), tools = false, now = () => Date.now(), fs = nodeFs, spawn = nodeSpawn, env = process.env, proc = process, uid, canAsk = proc?.stdin?.isTTY === true }) {
	if (typeof home !== "string" || home === "" || !isAbsolute(home)) {
		out("error: there is no home directory to keep the fork's copy in, so nothing was forked");
		return 1;
	}
	const root = join(home, ".pi-dispatch", "chat");
	if (within(plan.sessionsDir, root)) {
		out(`error: the chat copies' folder ${root} is inside PI_SESSIONS_DIR (${plan.sessionsDir}), whose reaper owns everything there; move PI_SESSIONS_DIR to its own folder (the docs use ~/.pi-dispatch/sessions)`);
		return 1;
	}
	if (!canAsk) {
		out("error: there is no terminal to ask the y/N on (stdin is not a TTY), so nothing was copied or forked");
		return 1;
	}
	const dir = join(root, plan.key);
	const dest = join(dir, `source-${now()}.jsonl`);
	const owner = uid === undefined ? {} : { uid };
	// `ours` is true only while `dest` is a file this command made: copySnapshot removes its own failed copy, and a
	// path someone else planted (EEXIST) is never ours to unlink.
	let ours = false;
	let dirChecked = false; // `<key>/` is removed only once it was checked as ours (ensurePrivateDir)
	let removed = false;
	const removeCopy = () => {
		if (removed) return;
		removed = true;
		if (ours) {
			try {
				fs.unlinkSync(dest);
			} catch {
				// already gone
			}
		}
		if (!dirChecked) return;
		try {
			fs.rmdirSync(dir); // only when empty: rmdir refuses a folder that still holds anything
		} catch {
			// not empty
		}
	};
	const hook = (handlers) => {
		for (const [signal, handler] of Object.entries(handlers)) proc.on(signal, handler);
		return () => {
			for (const [signal, handler] of Object.entries(handlers)) proc.removeListener(signal, handler);
		};
	};
	const whileAsked = {};
	for (const [signal, code] of Object.entries(EXIT_CODE_OF_SIGNAL)) {
		whileAsked[signal] = () => {
			removeCopy();
			out("not forked; the copy was removed");
			proc.exit(code);
		};
	}
	const unhookAsk = hook(whileAsked);
	let bytes;
	let model;
	try {
		ensurePrivateDir(fs, join(home, ".pi-dispatch"), owner);
		ensurePrivateDir(fs, root, owner);
		ensurePrivateDir(fs, dir, owner);
		dirChecked = true;
		ours = true;
		bytes = copySnapshot({ plan, dest, fs });
		model = forkModelOf({ defaults: agentDir ? hostDefaultsOf({ agentDir, fs }) : {}, session: sessionModelOf(dest, { fs }) });
	} catch (e) {
		if (bytes === undefined) ours = false;
		unhookAsk();
		removeCopy();
		out(`error: the transcript could not be copied (${e?.code ?? e?.message ?? "error"}), so nothing was forked`);
		return 1;
	}
	for (const n of plan.notes) out(`note: session ${plan.key} ${n}`);
	for (const w of plan.warnings) out(`warning: ${w}`);
	out(`The run's transcript is ${bytes} bytes, copied to ${dest} (removed again when this command ends).`);
	out("It is UNREDACTED: it holds whatever the job saw, including any secret a tool printed.");
	let yes;
	try {
		yes = await ask(`Open it in your pi? Every message you send goes, with this whole transcript, to ${model.phrase}. [y/N] `);
	} finally {
		unhookAsk();
	}
	if (!yes) {
		removeCopy();
		out("not forked; the copy was removed");
		return 0;
	}
	out(`pi runs in ${cwd}: your current folder, NOT the job's workspace${tools ? "" : ", with its tools off (pass --tools to turn them on)"}.`);
	out("pi writes the fork into its own sessions folder (that copy is as unredacted as this one, and stays yours to delete); the run's stored transcript is not changed, and nothing goes back to the forge.");
	const args = ["--fork", dest, ...model.args, ...(tools ? [] : ["--no-tools"])];
	return new Promise((resolveCode) => {
		let unhookRun = () => {};
		const end = (code) => {
			unhookRun();
			removeCopy();
			resolveCode(code);
		};
		let child;
		try {
			child = spawn(plan.piPath, args, { cwd, stdio: "inherit", env: childEnv(env) });
		} catch (e) {
			out(`error: ${plan.piPath} could not be started (${e?.code ?? "error"})`);
			return end(1);
		}
		let forwarded = null;
		const pass = (signal) => () => {
			forwarded ??= signal; // the first signal told to end the command decides its exit code
			try {
				child.kill?.(signal);
			} catch {
				// pi is already gone
			}
		};
		unhookRun = hook({ SIGINT: () => {}, SIGTERM: pass("SIGTERM"), SIGHUP: pass("SIGHUP") });
		child.on("error", (e) => {
			out(`error: ${plan.piPath} could not be started (${e?.code ?? "error"})`);
			end(1);
		});
		child.on("exit", (code, signal) => end(forwarded ? EXIT_CODE_OF_SIGNAL[forwarded] : Number.isInteger(code) ? code : signal ? 1 : 0));
	});
}
