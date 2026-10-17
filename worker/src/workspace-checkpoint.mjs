/**
 * Durable workspace checkpoints (issue #645): snapshot a paused job's `/workspace` into a per-run bare git
 * store on the worker host, and restore it into a fresh base checkout after a crash or a move.
 *
 * THE THREAT MODEL IS THE WHOLE DESIGN. The tree being snapshotted was written by the agent, so every
 * byte, every name and every file TYPE in it is attacker-chosen, and the snapshot runs on the HOST,
 * outside the container. Four consequences, each of which rules out an obvious implementation:
 *
 * 1. NO GIT COMMAND EVER RUNS ON THE AGENT'S REPOSITORY. `git add -A && git commit` in `/workspace` is the
 *    two-line version, and it runs the agent's clean filters, its `core.fsmonitor`, its signing program,
 *    follows its `gitdir:` redirect and its `objects/info/alternates` into any repository on the host.
 *    Hardening flags close the ones we know of; not reading the config at all closes the ones we do not.
 *    So the tree is walked IN NODE, hashed in Node, and streamed into a bare store we own through one
 *    `git fast-import`. The agent's `.git` is parsed from FILES for a branch name and a tip, nothing more.
 *    Two bounded exceptions, each argued where it lives: `primeBase`'s `fetch` from the workspace's `.git`,
 *    which runs BEFORE the container starts, while that `.git` is still the fresh clone the worker itself
 *    made; and `check-ignore` in the byte-cap tier (`dropIgnored`), which is given the work tree but not
 *    its `.git`, and reads nothing but ignore files.
 * 2. NOTHING IS FOLLOWED. Every stat is `lstat`, every open is `O_NOFOLLOW`, a symlink is stored as what
 *    it is (a mode 120000 blob holding the target) and a FIFO is skipped, never opened blocking.
 *    `O_NOFOLLOW` guards only the LAST component, so a directory swapped for a link between the walk's
 *    lstat and the open would still be followed. The caller pauses the container first, which is the
 *    precondition; on Linux the open is ALSO checked after the fact: `/proc/self/fd/<fd>` must resolve
 *    inside the workspace's realpath, or the snapshot is abandoned as `tree-changed`, so an unpaused or
 *    misbehaving caller cannot make it read a host file. Where `/proc/self/fd` does not exist (macOS, a
 *    development host) only the pause precondition and the dev/inode check stand, and that is the
 *    residual: an unpaused agent racing a directory swap there could get a host file read and stored.
 * 3. IT NEVER THROWS. The caller has paused a PAID container to call this; a throw that unwinds through
 *    the pause handling is a job lost for a checkpoint that was optional. Every public method returns
 *    `{ skipped: reason }` (could not, try later) or `{ refused: reason }` (must not, a policy answer).
 * 4. IT NEVER BLOCKS THE EVENT LOOP. The worker's heartbeat, its lock renewals and the container's own
 *    output pump share this loop; a synchronous walk of 200,000 files stalls them long enough for BullMQ
 *    to call the job stalled and hand it to another worker. So `fs/promises` throughout, and every git
 *    is an async spawn with an AbortSignal deadline and SIGKILL.
 *
 * WHY A BARE GIT STORE AND NOT A TARBALL: content addressing gives deduplication across checkpoints for
 * free (a 2 GiB repository whose agent touched three files costs three blobs), and the restore can ask
 * git for exactly the changed paths. Why not `git worktree`/`git stash` in the agent's repository: rule 1.
 *
 * Layout (`ck` is a hash of the run id, never the id itself: `sanitizeJobId` maps `..` to `..`, so a
 * sanitised name is not a safe directory name):
 *
 *     <storeDir>/                0700
 *       <ck>/                    0700, ck = sha256("checkpoint\0" + runId).hex[0..32]
 *         repo.git/              bare, refs/pi-dispatch/{base,checkpoint,cp/<seq>}
 *         home/                  empty, HOME and XDG_CONFIG_HOME for every store git
 *         lock                   exclusive create, "<pid> <tag>\n"
 *         base-too-large         marker: primeBase judged the base over the cap
 *         CURRENT                "<seq>\n", the commit point
 *         cp-<seq>/manifest.json 0600
 *         cp-<seq>/transcript.jsonl
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as FS } from "node:fs";
import * as nodeFsp from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { foldCase, isDotGitSegment, MAX_DEPTH, MAX_PATH_BYTES, validPath, validSegment } from "./checkpoint-paths.mjs";
import { STORE_GIT_FLAGS, storeGitEnv } from "./git-hardening.mjs";
import { sanitizeJobId } from "./run-history.mjs";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const DEFAULT_CHECKPOINT_LIMITS = Object.freeze({
	maxBaseBytes: 2 * GiB,
	maxNewBytes: 512 * MiB,
	maxFiles: 200_000,
	maxFileBytes: 64 * MiB,
	maxStoreBytes: 20 * GiB,
	// The transcript copy's cap, judged against the caller's offset BEFORE a byte is copied. Without it a
	// sparse session file (`truncate -s 100G`, one line appended) makes the copy write 100 GB of zeros onto
	// the host while the paid container is frozen. 256 MiB is far above any real pi session (a long run's
	// JSONL is tens of MiB; a model's context window bounds what one turn can add), equal to half the byte
	// cap, and with at most two checkpoints kept per run it bounds one run's transcripts to 512 MiB.
	maxTranscriptBytes: 256 * MiB,
	snapshotTimeoutMs: 60_000,
	gitTimeoutMs: 60_000,
	ttlMs: 7 * 24 * 3600 * 1000,
	lockStaleMs: 3600 * 1000,
	repackEvery: 20,
});

const MAX_LINK_BYTES = 4096;
const HEX = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };
const ANY_HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
/** piVersion, imageDigest, venue, provider, model: short tokens, never prose (the manifest holds no attacker string). */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const BRANCH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const KINDS = new Set(["live", "exit", "salvage"]);
const QUIESCED = new Set(["frozen", "dead"]);
const GIT_STATES = new Set(["parsed", "unreadable", "none"]);
const META_FIELDS = ["piVersion", "imageDigest", "venue", "provider", "model"];
const COMMITTER = "pi-dispatch <checkpoint@pi-dispatch.invalid>";

/** The directory name for a run: a hash, so no run id can name `..`, a slash or another run's directory. */
export function checkpointKey(runId) {
	return createHash("sha256").update(`checkpoint\0${runId}`).digest("hex").slice(0, 32);
}

/** The plain spawn. Tests swap it for a spy that records every argv and env (the flags bolt). */
export function defaultSpawnGit(args, { env, cwd, signal }) {
	return spawn("git", args, { env, cwd, signal, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
}

function isBranchName(b) {
	if (typeof b !== "string" || b.length === 0 || b.length > 200 || !BRANCH_RE.test(b)) return false;
	return !b.split("/").some((seg) => seg.endsWith(".lock") || seg.includes(".."));
}

function token(v) {
	return typeof v === "string" && TOKEN_RE.test(v) ? v : null;
}

function isInt(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
	return Number.isSafeInteger(v) && v >= min && v <= max;
}

/**
 * C-quote a path for fast-import, ALWAYS. fast-import takes an unquoted path too, but then a name starting
 * with `"` means something else and a newline ends the command; quoting every path removes the need to
 * decide which names are safe bare. Bytes outside printable ASCII go out as octal, which fast-import
 * unquotes back to the exact bytes.
 */
export function cQuote(path) {
	let out = "\"";
	for (const b of Buffer.from(path, "utf8")) {
		if (b === 0x22) out += "\\\"";
		else if (b === 0x5c) out += "\\\\";
		else if (b < 0x20 || b >= 0x7f) out += `\\${b.toString(8).padStart(3, "0")}`;
		else out += String.fromCharCode(b);
	}
	return `${out}"`;
}

/** git's blob id, computed in Node, so the id a cache holds is exactly the id the store will have. */
function blobOid(objectFormat, bytes) {
	return createHash(objectFormat === "sha256" ? "sha256" : "sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

/** Does `buf` contain any of `needles`? Byte comparison, so an encoding never hides a match. */
function containsAny(buf, needles) {
	return needles.some((n) => buf.includes(n));
}

/**
 * A chunked reader over a child's stdout for the `cat-file --batch` protocol: one header line, then
 * exactly N bytes. Chunks are kept as a list and joined once per `take`, because concatenating on every
 * `data` event is quadratic on a 64 MiB blob.
 */
function byteReader(stream) {
	const chunks = [];
	let length = 0;
	let ended = false;
	let wake = null;
	const poke = () => {
		const w = wake;
		wake = null;
		w?.();
	};
	stream.on("data", (c) => {
		chunks.push(c);
		length += c.length;
		poke();
	});
	stream.on("end", () => {
		ended = true;
		poke();
	});
	stream.on("error", () => {
		ended = true;
		poke();
	});
	const wait = () => new Promise((r) => (wake = r));
	const take = (n) => {
		const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
		const out = all.subarray(0, n);
		const rest = all.subarray(n);
		chunks.length = 0;
		length = rest.length;
		if (rest.length) chunks.push(rest);
		return out;
	};
	return {
		async line() {
			for (;;) {
				if (chunks.length > 1) {
					const all = Buffer.concat(chunks, length);
					chunks.length = 0;
					chunks.push(all);
				}
				const nl = length ? chunks[0].indexOf(0x0a) : -1;
				if (nl !== -1) return take(nl + 1).subarray(0, nl).toString("latin1");
				if (ended) throw new Error("eof");
				await wait();
			}
		},
		async bytes(n) {
			while (length < n) {
				if (ended) throw new Error("eof");
				await wait();
			}
			return Buffer.from(take(n));
		},
	};
}

/**
 * @param {object} deps
 * @param {string} deps.storeDir the checkpoint root on the worker host (made 0700)
 * @param {Function} [deps.spawnGit] `(argv, { env, cwd, signal }) => ChildProcess`
 * @param {object} [deps.fs] a `node:fs/promises`-shaped object (the crash-injection seam)
 * @param {() => number} [deps.now] milliseconds; the lock's staleness and the sweep's TTL read it
 * @param {Function} [deps.log] `(event, fields)`; fields are names, counts and codes, never a path or value
 * @param {object} [deps.limits] overrides of `DEFAULT_CHECKPOINT_LIMITS`
 * @param {string} [deps.hostName] recorded in the manifest
 * @param {Function} [deps.statfs] `(dir) => { bavail, bsize, blocks }`
 * @param {string|null} [deps.procFdDir] where the open-file links live (Linux); a test points it at a fake
 */
export function makeWorkspaceCheckpointer({
	storeDir,
	spawnGit = defaultSpawnGit,
	fs = nodeFsp,
	now = Date.now,
	log = () => {},
	limits = {},
	hostName = osHostname(),
	statfs = (dir) => nodeFsp.statfs(dir),
	procFdDir = "/proc/self/fd",
} = {}) {
	const L = { ...DEFAULT_CHECKPOINT_LIMITS, ...limits };
	const host = HOST_RE.test(String(hostName)) ? String(hostName) : String(hostName).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "unknown";
	/** Per run, in memory: the stat cache and the object format. Lost on restart, which only costs re-reading. */
	const runs = new Map();

	function runState(runId) {
		let s = runs.get(runId);
		if (!s) {
			s = { cache: new Map(), objectFormat: null };
			runs.set(runId, s);
		}
		return s;
	}

	function runPaths(runId) {
		const run = join(storeDir, checkpointKey(runId));
		return {
			run,
			repo: join(run, "repo.git"),
			home: join(run, "home"),
			lock: join(run, "lock"),
			current: join(run, "CURRENT"),
			tooLarge: join(run, "base-too-large"),
			cp: (seq) => join(run, `cp-${seq}`),
		};
	}

	// ── git ────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Start one store git. EVERY spawn goes through here, which is what lets one test pin that every argv
	 * starts with `STORE_GIT_FLAGS` and every env is `storeGitEnv` exactly. `workTree` exists for one
	 * caller (`dropIgnored`) and is the only way `GIT_WORK_TREE` can reach a git.
	 */
	function startGit(paths, args, { signal, workTree = null, cwd = paths.run } = {}) {
		const env = storeGitEnv({ gitDir: paths.repo, home: paths.home });
		// env-internal GIT_WORK_TREE: written into the store git's closed env here, never read from the worker's environment.
		if (workTree) env.GIT_WORK_TREE = workTree;
		const timeout = AbortSignal.timeout(L.gitTimeoutMs);
		const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const child = spawnGit([...STORE_GIT_FLAGS, ...args], { env, cwd, signal: sig });
		const out = [];
		const err = [];
		let errBytes = 0;
		child.stdout?.on("data", (c) => out.push(c));
		child.stderr?.on("data", (c) => {
			// Kept for a test's eyes only and bounded: stderr can name agent paths, so it is never logged.
			if (errBytes < 65536) err.push(c);
			errBytes += c.length;
		});
		child.stdin?.on("error", () => {});
		const done = new Promise((resolve) => {
			let settled = false;
			const settle = (code) => {
				if (settled) return;
				settled = true;
				resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), aborted: sig.aborted });
			};
			child.on("error", () => {
				// A spawn that never started emits no `close`; one that did is settled by `close` below.
				if (child.pid === undefined) settle(-1);
			});
			child.on("close", (code) => settle(code ?? -1));
		});
		return { child, done };
	}

	/** Run a store git to completion. Resolves, never rejects. */
	async function runGit(paths, args, { input = null, ...opts } = {}) {
		let started;
		try {
			started = startGit(paths, args, opts);
		} catch {
			return { code: -1, stdout: Buffer.alloc(0), stderr: "", aborted: false };
		}
		started.child.stdin?.end(input ?? undefined);
		return started.done;
	}

	// ── small fs helpers ────────────────────────────────────────────────────────────────────────────────

	const rand = () => randomBytes(6).toString("hex");

	/**
	 * Read a small REGULAR file without following a link and without blocking on a FIFO: `O_NOFOLLOW`
	 * refuses a final-component link, `O_NONBLOCK` makes a FIFO open return at once, and the fstat then
	 * refuses anything that is not a regular file of at most `max` bytes.
	 */
	async function readRegular(path, max) {
		let fh;
		try {
			fh = await fs.open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
		} catch (err) {
			return { error: err?.code ?? "open" };
		}
		try {
			const st = await fh.stat();
			if (!st.isFile()) return { error: "not-regular" };
			if (st.size > max) return { error: "too-large" };
			const buf = Buffer.alloc(st.size);
			let off = 0;
			while (off < st.size) {
				const { bytesRead } = await fh.read(buf, off, st.size - off, off);
				if (bytesRead === 0) break;
				off += bytesRead;
			}
			return { buf: buf.subarray(0, off) };
		} catch (err) {
			return { error: err?.code ?? "read" };
		} finally {
			await fh.close().catch(() => {});
		}
	}

	async function lstatOrNull(path, opts) {
		try {
			return await fs.lstat(path, opts);
		} catch (err) {
			if (err?.code === "ENOENT") return null;
			throw err;
		}
	}

	/** Make a directory ours (0700), or refuse one that exists as anything but a real directory. */
	async function ensureDir(path) {
		try {
			await fs.mkdir(path, { mode: 0o700 });
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
		}
		const st = await fs.lstat(path);
		if (!st.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
	}

	async function fsyncDir(dir) {
		const fh = await fs.open(dir, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close().catch(() => {});
		}
	}

	/**
	 * Write `name` in `dir` the crash-safe way: a fresh `<name>.<rand>.incoming` (exclusive create, so a
	 * planted link at the temp name cannot redirect the write), fsync, rename over, fsync the directory.
	 * A crash before the rename leaves the old file; after it, the new one, complete.
	 */
	async function atomicWrite(dir, name, data, mode = 0o600) {
		const tmp = join(dir, `${name}.${rand()}.incoming`);
		try {
			const fh = await fs.open(tmp, "wx", mode);
			try {
				await fh.writeFile(data);
				await fh.sync();
			} finally {
				await fh.close().catch(() => {});
			}
			await fs.rename(tmp, join(dir, name));
		} catch (err) {
			await fs.unlink(tmp).catch(() => {});
			throw err;
		}
		await fsyncDir(dir);
	}

	// ── the lock ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Exclusive create IS the lock, as in `session-store.mjs`'s `takeLock` (mirrored, not imported: that
	 * module is sync and keyed differently). The difference is the takeover. A stale lock (older than
	 * `lockStaleMs` by the injected clock) is taken over by RENAMING it to a unique name, which is atomic,
	 * so of two processes judging the same stale lock exactly one moves it. The mover then checks that what
	 * it moved still holds the bytes it judged stale: a rival may have taken the lock over in between and
	 * written a NEW tag, and that live lock is put back (`link`, which never overwrites) rather than
	 * removed. Only then is the moved file unlinked and a fresh lock created with `wx`. An unlink by path,
	 * the obvious version, can delete a rival's brand new lock on the strength of a judgement about its
	 * predecessor.
	 */
	async function takeLock(paths) {
		const tag = randomBytes(16).toString("hex");
		const body = `${process.pid} ${tag}\n`;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fh = await fs.open(paths.lock, "wx", 0o600);
				try {
					await fh.writeFile(body);
				} finally {
					await fh.close().catch(() => {});
				}
				return { tag };
			} catch (err) {
				if (err?.code !== "EEXIST") return { error: err?.code ?? "lock" };
				const seen = await readRegular(paths.lock, 256);
				const st = await lstatOrNull(paths.lock).catch(() => null);
				if (!seen.buf || !st) continue; // released between our create and our read: retry answers
				const ageMs = now() - st.mtimeMs;
				if (ageMs <= L.lockStaleMs) return { locked: true };
				const moved = await moveAside(paths.lock, "stale");
				if (!moved) continue; // someone else moved it first; the retry create answers who won
				const held = await readRegular(moved, 256);
				if (!held.buf || !held.buf.equals(seen.buf)) {
					await putBack(moved, paths.lock);
					return { locked: true };
				}
				await fs.unlink(moved).catch(() => {});
				log("checkpoint_lock_stale_taken", { ageMs: Math.round(ageMs) });
			}
		}
		return { locked: true };
	}

	/** Rename `path` to a unique sibling; the new name, or null when it was already gone. */
	async function moveAside(path, why) {
		const to = `${path}.${why}.${rand()}`;
		try {
			await fs.rename(path, to);
			return to;
		} catch {
			return null;
		}
	}

	/** Return a lock we moved but do not own. `link` fails if a new lock appeared meanwhile, which then wins. */
	async function putBack(moved, path) {
		await fs.link(moved, path).catch(() => {});
		await fs.unlink(moved).catch(() => {});
	}

	/** Release only a lock that still holds OUR tag, by the same move, verify, then unlink. */
	async function releaseLock(paths, tag) {
		const moved = await moveAside(paths.lock, "release");
		if (!moved) return;
		const held = await readRegular(moved, 256);
		if (held.buf && held.buf.toString("latin1").includes(tag)) await fs.unlink(moved).catch(() => {});
		else await putBack(moved, paths.lock);
	}

	async function withLock(paths, fn) {
		const lock = await takeLock(paths);
		if (lock.locked) return { skipped: "locked" };
		if (lock.error) return { skipped: "lock-failed" };
		try {
			return await fn();
		} finally {
			await releaseLock(paths, lock.tag).catch(() => {});
		}
	}

	// ── the walk ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Walk `root` without following anything. Returns the regular files and symlinks worth storing, with
	 * the counts of what was not, or `{ skipped }` when the tree is not one we can describe.
	 *
	 * What is excluded, and why it is COUNTED rather than silent: a dotgit segment at ANY depth (a nested
	 * repository's files are captured, its `.git` is not, and `sub/.GIT` is `.git` on a Mac); FIFOs,
	 * sockets and devices (no content to store, and opening a FIFO blocks); a name `validSegment` refuses;
	 * a directory or file we may not read (EACCES/EPERM, `partial`, and never chmod'ed: changing modes in
	 * the agent's tree is a write to it); a file over `maxFileBytes`. The counts reach the manifest so a
	 * restore that is missing something says how much.
	 */
	async function walkTree(root, signal, maxFiles = L.maxFiles) {
		const rootSt = await lstatOrNull(root);
		if (!rootSt?.isDirectory()) return { skipped: "workspace-not-directory" };
		const files = [];
		const excluded = { unreadable: 0, special: 0, dotgit: 0, badName: 0, tooLarge: 0 };
		let partial = false;
		let unsafeIgnoreFile = false;
		const stack = [{ rel: "", depth: 0 }];
		while (stack.length) {
			if (signal?.aborted) return { skipped: "timeout" };
			const { rel, depth } = stack.pop();
			let dirents;
			try {
				dirents = await fs.readdir(rel ? join(root, rel) : root, { withFileTypes: true, encoding: "buffer" });
			} catch (err) {
				if (err?.code === "EACCES" || err?.code === "EPERM") {
					excluded.unreadable++;
					partial = true;
					continue;
				}
				// The container is paused: a directory that vanished or turned into a file under us means
				// something other than the agent is writing, and a snapshot of a moving tree is not one.
				if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { skipped: "tree-changed" };
				throw err;
			}
			for (const d of dirents) {
				// Per ENTRY, not per directory: one directory of 200,000 names would otherwise run past the
				// deadline and grow `files` without bound before either check got a turn.
				if (signal?.aborted) return { skipped: "timeout" };
				const nameBuf = d.name;
				if (isDotGitSegment(nameBuf)) {
					excluded.dotgit++;
					continue;
				}
				if (!validSegment(nameBuf)) {
					excluded.badName++;
					continue;
				}
				const name = nameBuf.toString("utf8");
				const path = rel ? `${rel}/${name}` : name;
				if (Buffer.byteLength(path) > MAX_PATH_BYTES) {
					excluded.badName++;
					continue;
				}
				let st;
				try {
					st = await fs.lstat(join(root, path), { bigint: true });
				} catch (err) {
					if (err?.code === "EACCES" || err?.code === "EPERM") {
						excluded.unreadable++;
						partial = true;
						continue;
					}
					if (err?.code === "ENOENT") return { skipped: "tree-changed" };
					throw err;
				}
				if (st.isDirectory()) {
					// Children of a directory at MAX_DEPTH would be deeper than any path `validPath` accepts,
					// so the restore could never write them: counted as bad names, not silently lost.
					if (depth + 1 >= MAX_DEPTH) excluded.badName++;
					else stack.push({ rel: path, depth: depth + 1 });
				} else if (st.isSymbolicLink()) {
					files.push({ path, kind: "link", st });
					if (files.length > maxFiles) return { skipped: "over-file-cap" };
				} else if (st.isFile()) {
					if (st.size > BigInt(L.maxFileBytes)) {
						excluded.tooLarge++;
						continue;
					}
					files.push({ path, kind: "file", st });
					if (files.length > maxFiles) return { skipped: "over-file-cap" };
				} else {
					excluded.special++;
					// git opens `.gitignore` with a plain blocking open: a FIFO there would hang `check-ignore`
					// until its deadline. Remembered so the ignore tier is never attempted on such a tree.
					if (name === ".gitignore") unsafeIgnoreFile = true;
				}
			}
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return { files, excluded, partial, unsafeIgnoreFile };
	}

	/**
	 * Read exactly the file the walk saw: `O_NOFOLLOW` (a link swapped in since the lstat is refused),
	 * `O_NONBLOCK` (a FIFO swapped in does not hang the open), then the fstat must show a regular file with
	 * the walk's dev and inode, and exactly `size` bytes must arrive. Anything else means the tree moved
	 * under a paused container, and the whole snapshot is abandoned rather than recording a mix.
	 */
	async function readExact(abs, st, rootReal = null) {
		let fh;
		try {
			fh = await fs.open(abs, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
		} catch (err) {
			if (err?.code === "EACCES" || err?.code === "EPERM") return { unreadable: true };
			return { changed: true };
		}
		try {
			const now2 = await fh.stat({ bigint: true });
			if (!now2.isFile() || now2.dev !== st.dev || now2.ino !== st.ino) return { changed: true };
			if (rootReal && !(await openedInside(fh, rootReal))) return { changed: true };
			const size = Number(st.size);
			const buf = Buffer.allocUnsafe(size);
			let off = 0;
			while (off < size) {
				const { bytesRead } = await fh.read(buf, off, size - off, off);
				if (bytesRead === 0) break;
				off += bytesRead;
			}
			if (off !== size) return { changed: true };
			return { buf };
		} catch {
			return { changed: true };
		} finally {
			await fh.close().catch(() => {});
		}
	}

	/**
	 * Linux only: where did this open REALLY land? `/proc/self/fd/<fd>` names the opened file's path as the
	 * kernel resolved it, through every intermediate link `O_NOFOLLOW` does not cover. Outside the
	 * workspace's realpath is a swap under us. Where the proc link does not exist the answer is "unknown",
	 * which passes: the header records that residual and the pause precondition that covers it.
	 */
	let procFd = procFdDir;
	async function openedInside(fh, rootReal) {
		if (!procFd) return true;
		let where;
		try {
			where = await fs.readlink(`${procFd}/${fh.fd}`);
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
				procFd = null; // no procfs on this host: stop asking
				return true;
			}
			return false;
		}
		return String(where).startsWith(`${rootReal}/`);
	}

	async function readLinkTarget(abs) {
		try {
			const target = await fs.readlink(abs, { encoding: "buffer" });
			if (target.length === 0 || target.length > MAX_LINK_BYTES) return { tooLarge: true };
			return { buf: target };
		} catch (err) {
			if (err?.code === "EACCES" || err?.code === "EPERM") return { unreadable: true };
			return { changed: true };
		}
	}

	function cacheMatches(hit, st) {
		return hit && hit.dev === st.dev && hit.ino === st.ino && hit.size === st.size && hit.mtimeNs === st.mtimeNs && hit.ctimeNs === st.ctimeNs;
	}

	function cacheEntry(st, oid) {
		return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, oid };
	}

	// ── the agent's git state, from files ──────────────────────────────────────────────────────────────

	const NO_GIT = Object.freeze({ state: "none", branch: null, tip: null, detached: false });
	const UNREADABLE_GIT = Object.freeze({ state: "unreadable", branch: null, tip: null, detached: false });

	/**
	 * Where the agent's repository points, parsed from files and never from a git command (rule 1). Only
	 * the CALLER's branch (the harness-minted issue branch) is ever looked up: a name read from HEAD is
	 * agent-chosen, so it is compared, never used as a path and never recorded. A `.git` that is a file
	 * (a `gitdir:` redirect) or a link is `unreadable`: following it is reading another repository.
	 */
	async function parseGitState(workspace, branch) {
		const gitDir = join(workspace, ".git");
		let st;
		try {
			st = await fs.lstat(gitDir);
		} catch (err) {
			return err?.code === "ENOENT" ? NO_GIT : UNREADABLE_GIT;
		}
		if (!st.isDirectory()) return UNREADABLE_GIT;
		const head = await readRegular(join(gitDir, "HEAD"), 256);
		if (!head.buf) return UNREADABLE_GIT;
		const text = head.buf.toString("latin1");
		const detached = /^([0-9a-f]{40}|[0-9a-f]{64})\n?$/.exec(text);
		if (detached) return { state: "parsed", branch: null, tip: detached[1], detached: true };
		const sym = /^ref: refs\/heads\/([^\n]+)\n?$/.exec(text);
		if (!sym) return UNREADABLE_GIT;
		if (!isBranchName(branch) || sym[1] !== branch) return { state: "parsed", branch: null, tip: null, detached: false };
		return { state: "parsed", branch, tip: await lookupBranchTip(gitDir, branch), detached: false };
	}

	async function lookupBranchTip(gitDir, branch) {
		const parts = ["refs", "heads", ...branch.split("/")];
		let dir = gitDir;
		let loose = true;
		for (let i = 0; i < parts.length - 1; i++) {
			dir = join(dir, parts[i]);
			const st = await lstatOrNull(dir).catch(() => null);
			if (!st?.isDirectory()) {
				loose = false;
				break;
			}
		}
		if (loose) {
			const ref = await readRegular(join(dir, parts.at(-1)), 256);
			const m = ref.buf && /^([0-9a-f]{40}|[0-9a-f]{64})\n?$/.exec(ref.buf.toString("latin1"));
			if (m) return m[1];
		}
		const packed = await readRegular(join(gitDir, "packed-refs"), MiB);
		if (!packed.buf) return null;
		const want = ` refs/heads/${branch}`;
		for (const line of packed.buf.toString("latin1").split("\n")) {
			if (line.endsWith(want)) {
				const oid = line.slice(0, line.length - want.length);
				if (ANY_HEX_OID.test(oid)) return oid;
			}
		}
		return null;
	}

	// ── store setup ─────────────────────────────────────────────────────────────────────────────────────

	async function ensureRun(paths) {
		await ensureDir(storeDir);
		await fs.chmod(storeDir, 0o700).catch(() => {});
		await ensureDir(paths.run);
		await ensureDir(paths.home);
	}

	/**
	 * `git init --bare` once, with the config appended once. `uploadpack.allowAnySHA1InWant` lets the
	 * caller's restore fetch the base by its sha (`baseSourceUrl`) whatever refs the store advertises; the
	 * store is ours and holds only this run's objects, so "any sha" is no wider than "this repository".
	 */
	async function initStore(paths, objectFormat, signal) {
		if (await lstatOrNull(join(paths.repo, "HEAD"))) return true;
		const r = await runGit(paths, ["init", "--bare", "--quiet", `--object-format=${objectFormat}`], { signal });
		if (r.code !== 0) return false;
		await fs.appendFile(
			join(paths.repo, "config"),
			"[core]\n\tlogAllRefUpdates = false\n[gc]\n\tauto = 0\n[uploadpack]\n\tallowAnySHA1InWant = true\n",
		);
		return true;
	}

	async function storeObjectFormat(paths, state, signal) {
		if (state.objectFormat) return state.objectFormat;
		const r = await runGit(paths, ["rev-parse", "--show-object-format"], { signal });
		const fmt = r.stdout.toString("latin1").trim();
		if (r.code !== 0 || !HEX[fmt]) return null;
		state.objectFormat = fmt;
		return fmt;
	}

	async function storeBytes(dir = storeDir) {
		let total = 0;
		const stack = [dir];
		while (stack.length) {
			const d = stack.pop();
			let names;
			try {
				names = await fs.readdir(d);
			} catch {
				continue;
			}
			for (const n of names) {
				const st = await lstatOrNull(join(d, n)).catch(() => null);
				if (!st) continue;
				if (st.isDirectory()) stack.push(join(d, n));
				else total += st.size;
			}
		}
		return total;
	}

	async function readCurrent(paths) {
		const cur = await readRegular(paths.current, 32);
		if (cur.error === "ENOENT") return { absent: true };
		if (!cur.buf) return { invalid: "current-unreadable" };
		const m = /^([1-9][0-9]{0,8})\n$/.exec(cur.buf.toString("latin1"));
		if (!m) return { invalid: "current-malformed" };
		return { seq: Number(m[1]) };
	}

	// ── primeBase ───────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Seed the store from the FRESH clone, before the container starts: the one moment the workspace's
	 * `.git` is still the worker's own, so the `fetch` from it reads a repository nobody hostile has
	 * touched (and with the store flags anyway). The stat cache it seeds is what makes a later snapshot
	 * cheap: a file whose dev, inode, size, mtime and ctime all match is not re-read.
	 *
	 * Only oids that exist in the base TREE are cached. The checkout may have converted a file on its way
	 * out (eol, ident, an encoding): its on-disk id is then not in the store, and fast-import refuses a
	 * `M` naming a missing object. Hashing the disk bytes and keeping only ids the base tree holds is
	 * exact either way.
	 */
	async function primeBase({ runId, workspace, baseSha, objectFormat } = {}) {
		try {
			if (typeof runId !== "string" || !runId || !HEX[objectFormat] || !HEX[objectFormat].test(String(baseSha))) {
				return { skipped: "bad-args" };
			}
			const paths = runPaths(runId);
			await ensureRun(paths);
			return await withLock(paths, async () => {
				const signal = AbortSignal.timeout(L.snapshotTimeoutMs);
				const walk = await walkTree(workspace, signal);
				if (walk.skipped) return { skipped: walk.skipped };
				const rootReal = await fs.realpath(workspace);
				const baseBytes = walk.files.reduce((n, f) => n + Number(f.st.size), 0);
				if (baseBytes > L.maxBaseBytes) {
					await atomicWrite(paths.run, "base-too-large", "1\n");
					log("checkpoint_base_skipped", { reason: "base-too-large", baseBytes });
					return { skipped: "base-too-large" };
				}
				if (!(await initStore(paths, objectFormat, signal))) return { skipped: "store-init-failed" };
				const url = pathToFileURL(join(workspace, ".git")).href;
				const fetched = await runGit(
					paths,
					["-c", "protocol.file.allow=always", "fetch", "--quiet", "--depth=1", "--no-tags", url, `+${baseSha}:refs/pi-dispatch/base`],
					{ signal },
				);
				if (fetched.code !== 0) return { skipped: fetched.aborted ? "timeout" : "base-fetch-failed" };
				const tree = await runGit(paths, ["ls-tree", "-r", "-z", "--full-tree", "refs/pi-dispatch/base"], { signal });
				if (tree.code !== 0) return { skipped: "base-fetch-failed" };
				const baseOids = new Set();
				for (const rec of tree.stdout.toString("latin1").split("\0")) {
					const m = /^\d+ blob ([0-9a-f]+)\t/.exec(rec);
					if (m) baseOids.add(m[1]);
				}
				const state = runState(runId);
				state.objectFormat = objectFormat;
				state.cache.clear();
				for (const f of walk.files) {
					if (signal.aborted) return { skipped: "timeout" };
					if (f.kind !== "file") continue;
					const got = await readExact(join(workspace, f.path), f.st, rootReal);
					if (!got.buf) continue;
					const oid = blobOid(objectFormat, got.buf);
					if (baseOids.has(oid)) state.cache.set(f.path, cacheEntry(f.st, oid));
				}
				log("checkpoint_base_primed", { files: walk.files.length, cached: state.cache.size });
				return { ok: true, files: walk.files.length, cached: state.cache.size };
			});
		} catch (err) {
			log("checkpoint_failed", { phase: "prime", code: err?.code ?? "internal" });
			return { skipped: "internal-error" };
		}
	}

	// ── snapshot ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Tier 2 of the byte cap: drop every path the repository's ignore rules match (build output, caches,
	 * `node_modules`), which is usually what blew the cap.
	 *
	 * THE ONE GIT GIVEN THE WORK TREE, and why that is safe. `check-ignore --no-index` reads exactly the
	 * ignore FILES (`.gitignore` along each path, the store's `info/exclude`, and a global excludes file
	 * that cannot exist under `storeGitEnv`'s empty HOME): it runs no filter, reads no attributes, never
	 * touches an index (`--no-index`), and `GIT_DIR` is still the store, so the agent's `.git/config`,
	 * hooks and fsmonitor are never read. A `.gitignore` that is a FIFO would hang it, so the walk refuses
	 * this tier for such a tree. The rejected alternative, a Node reimplementation of gitignore matching,
	 * is a second dialect of a subtle format: it would drop files git keeps, which is data loss.
	 */
	async function dropIgnored(paths, workspace, files, signal) {
		const input = Buffer.from(files.map((f) => `${f.path}\0`).join(""), "utf8");
		// cwd is the run's empty `home/`, NOT the workspace: git resolves a work tree it is not inside from
		// `GIT_WORK_TREE` alone and takes the paths relative to its top (measured on git 2.39), and a cwd
		// inside the agent's tree is one more place git could look for something to read.
		const r = await runGit(paths, ["check-ignore", "--no-index", "--stdin", "-z"], { input, signal, workTree: workspace, cwd: paths.home });
		// Exit 1 is "nothing ignored", which is an answer, not a failure; anything else keeps nothing back,
		// so the caller refuses over the cap rather than storing everything it was asked to cut.
		if (r.code !== 0 && r.code !== 1) {
			log("checkpoint_ignore_tier", { outcome: "failed" });
			return null;
		}
		const ignored = new Set(r.stdout.toString("utf8").split("\0").filter(Boolean));
		log("checkpoint_ignore_tier", { outcome: r.code === 1 ? "none-ignored" : "dropped", dropped: ignored.size });
		return files.filter((f) => !ignored.has(f.path));
	}

	/**
	 * Free space must cover twice the byte cap plus the transcript about to be copied, AND 5% of the volume: a checkpoint that fills the disk takes
	 * the worker's logs, the queue's AOF and every other job's workspace down with it, which is a far
	 * worse outcome than one checkpoint skipped.
	 */
	async function diskOk(transcriptBytes = 0) {
		try {
			const s = await statfs(storeDir);
			const free = Number(s.bavail) * Number(s.bsize);
			const total = Number(s.blocks) * Number(s.bsize);
			return free >= 2 * L.maxNewBytes + transcriptBytes && free >= 0.05 * total;
		} catch {
			return false;
		}
	}

	/** Stream one checkpoint commit into `git fast-import`. Returns `{ commit, newOids }` or a refusal. */
	async function importTree(paths, ctx) {
		const { workspace, rootReal, files, cachedOid, baseSha, seq, secrets, objectFormat, signal, counts } = ctx;
		const { child, done } = startGit(paths, ["fast-import", "--quiet", "--done", "--force", "--date-format=raw"], { signal });
		let failed = false;
		const closed = done.then(() => {
			failed = true;
		});
		const write = async (buf) => {
			if (failed) throw new Error("fast-import exited");
			// Backpressure: wait for `drain`, but never past the child's death (a dead git never drains).
			if (!child.stdin.write(buf)) await Promise.race([new Promise((r) => child.stdin.once("drain", r)), closed]);
			if (failed) throw new Error("fast-import exited");
		};
		const abort = async (result) => {
			child.kill("SIGKILL");
			await done;
			await cleanupImport(paths);
			return result;
		};
		const newOids = new Map();
		try {
			const msg = `pi-dispatch checkpoint ${seq}\n`;
			const sec = Math.floor(now() / 1000);
			await write(
				`feature done\ncommit refs/pi-dispatch/checkpoint\nmark :1\ncommitter ${COMMITTER} ${sec} +0000\n` +
					`data ${Buffer.byteLength(msg)}\n${msg}from ${baseSha}\ndeleteall\n`,
			);
			for (const f of files) {
				if (signal.aborted) return await abort({ skipped: "timeout" });
				const abs = join(workspace, f.path);
				const q = cQuote(f.path);
				if (f.kind === "link") {
					const t = await readLinkTarget(abs);
					if (t.changed) return await abort({ skipped: "tree-changed" });
					if (t.unreadable) {
						counts.skipped.unreadable++;
						counts.partial = true;
						continue;
					}
					if (t.tooLarge) {
						counts.skipped.tooLarge++;
						continue;
					}
					if (containsAny(t.buf, secrets)) return await abort({ refused: "job-secret-in-tree" });
					await write(`M 120000 inline ${q}\ndata ${t.buf.length}\n`);
					await write(t.buf);
					await write("\n");
					counts.files++;
					continue;
				}
				const mode = (f.st.mode & 0o111n) !== 0n ? "100755" : "100644";
				const known = cachedOid.get(f.path);
				if (known) {
					await write(`M ${mode} ${known} ${q}\n`);
					counts.files++;
					counts.bytes += Number(f.st.size);
					continue;
				}
				const got = await readExact(abs, f.st, rootReal);
				if (got.unreadable) {
					counts.skipped.unreadable++;
					counts.partial = true;
					continue;
				}
				if (!got.buf) return await abort({ skipped: "tree-changed" });
				if (containsAny(got.buf, secrets)) return await abort({ refused: "job-secret-in-tree" });
				newOids.set(f.path, cacheEntry(f.st, blobOid(objectFormat, got.buf)));
				await write(`M ${mode} inline ${q}\ndata ${got.buf.length}\n`);
				await write(got.buf);
				await write("\n");
				counts.files++;
				counts.bytes += got.buf.length;
				counts.newBytes += got.buf.length;
			}
			await write(`\nreset refs/pi-dispatch/cp/${seq}\nfrom :1\n\ndone\n`);
			child.stdin.end();
		} catch {
			return await abort({ skipped: signal.aborted ? "timeout" : "import-failed" });
		}
		const r = await done;
		if (r.code !== 0) {
			await cleanupImport(paths);
			return { skipped: r.aborted ? "timeout" : "import-failed" };
		}
		const rev = await runGit(paths, ["rev-parse", "--verify", "--quiet", `refs/pi-dispatch/cp/${seq}^{commit}`], { signal });
		const commit = rev.stdout.toString("latin1").trim();
		if (rev.code !== 0 || !HEX[objectFormat].test(commit)) return { skipped: "import-failed" };
		return { commit, newOids };
	}

	/**
	 * After a killed fast-import: its half-written pack (`objects/pack/tmp_*`) and its crash report
	 * (`fast_import_crash_<pid>`, which quotes recent commands, so agent path names) are removed. A
	 * refused snapshot must leave no trace of the bytes it refused, which is the whole point of refusing.
	 */
	async function cleanupImport(paths) {
		const packDir = join(paths.repo, "objects", "pack");
		for (const [dir, prefix] of [
			[packDir, "tmp_"],
			[paths.repo, "fast_import_crash_"],
		]) {
			const names = await fs.readdir(dir).catch(() => []);
			for (const n of names) if (n.startsWith(prefix)) await fs.rm(join(dir, n), { force: true }).catch(() => {});
		}
	}

	/** Reserve `cp-<seq>/`, clearing temp files a crashed attempt at the same seq left behind. */
	async function reserveCp(paths, seq) {
		const dir = paths.cp(seq);
		await ensureDir(dir);
		for (const n of await fs.readdir(dir)) if (n.endsWith(".incoming")) await fs.rm(join(dir, n), { force: true });
		return dir;
	}

	/**
	 * Copy bytes [0, offset) of the transcript into `cp-<seq>/transcript.jsonl`: the source opened
	 * `O_NOFOLLOW` (the worker's session file, but a link there must not pull in some other file), the copy
	 * fsynced and renamed into place. The offset is the caller's: the transcript keeps growing while the
	 * container runs, and the checkpoint must describe the bytes that match the workspace, not later ones.
	 */
	async function copyTranscript(dir, srcFile, offset, signal) {
		const tmp = join(dir, `transcript.jsonl.${rand()}.incoming`);
		const hash = createHash("sha256");
		let bytes = 0;
		try {
			const out = await fs.open(tmp, "wx", 0o600);
			try {
				if (srcFile && offset > 0) {
					const src = await fs.open(srcFile, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
					try {
						if (!(await src.stat()).isFile()) throw Object.assign(new Error("transcript not a file"), { code: "ENOTREG" });
						const chunk = Buffer.allocUnsafe(MiB);
						while (bytes < offset) {
							// The snapshot's deadline covers the copy too: bounded 1 MiB chunks, the signal checked
							// before each, so a slow or huge source cannot hold the container frozen past it.
							if (signal?.aborted) throw Object.assign(new Error("transcript copy timed out"), { code: "ETIMEDOUT" });
							const { bytesRead } = await src.read(chunk, 0, Math.min(chunk.length, offset - bytes), bytes);
							if (bytesRead === 0) break;
							hash.update(chunk.subarray(0, bytesRead));
							await out.write(chunk, 0, bytesRead);
							bytes += bytesRead;
						}
					} finally {
						await src.close().catch(() => {});
					}
					if (bytes !== offset) throw Object.assign(new Error("transcript short"), { code: "ESHORT" });
				}
				await out.sync();
			} finally {
				await out.close().catch(() => {});
			}
			await fs.rename(tmp, join(dir, "transcript.jsonl"));
		} catch (err) {
			await fs.unlink(tmp).catch(() => {});
			throw err;
		}
		return { bytes, sha256: hash.digest("hex") };
	}

	/** The public transcript helper: reserve `cp-<seq>/` and copy into it. Never throws. */
	async function writeTranscript(runId, seq, srcFile, offset) {
		try {
			if (typeof runId !== "string" || !runId || !isInt(seq, 1, 999_999_999) || !isInt(offset)) return { skipped: "bad-args" };
			const paths = runPaths(runId);
			if (!(await lstatOrNull(paths.run))?.isDirectory()) return { skipped: "not-primed" };
			if (offset > L.maxTranscriptBytes) return { skipped: "transcript-too-large" };
			const signal = AbortSignal.timeout(L.snapshotTimeoutMs);
			const dir = await reserveCp(paths, seq);
			try {
				return { ok: true, ...(await copyTranscript(dir, srcFile, offset, signal)) };
			} catch (err) {
				if (signal.aborted) return { skipped: "timeout" };
				throw err;
			}
		} catch (err) {
			log("checkpoint_failed", { phase: "transcript", code: err?.code ?? "internal" });
			return { skipped: "transcript-failed" };
		}
	}

	/**
	 * Take a checkpoint of a PAUSED container's workspace (the caller paused it; this never does).
	 *
	 * Order: free refusals and caps first (lock, seq, disk, store size, walk, file cap, byte cap with its
	 * ignore tier), then the one expensive step (reading new bytes into fast-import, refusing on a job
	 * secret), then the commit point: transcript, manifest, CURRENT, each fsynced and renamed, so a crash
	 * at any step leaves the previous CURRENT pointing at a complete checkpoint.
	 */
	async function snapshot({
		runId,
		workspace,
		baseSha,
		seq,
		branch = null,
		secretValues = [],
		attempt = 0,
		kind = "live",
		quiesced = "frozen",
		transcript = {},
		meta = {},
	} = {}) {
		try {
			if (typeof runId !== "string" || !runId || !isInt(seq, 1, 999_999_999) || !ANY_HEX_OID.test(String(baseSha))) return { skipped: "bad-args" };
			if (!KINDS.has(kind) || !QUIESCED.has(quiesced) || !isInt(attempt, 0, 10_000)) return { skipped: "bad-args" };
			const paths = runPaths(runId);
			if (!(await lstatOrNull(paths.run))?.isDirectory()) return { skipped: "not-primed" };
			if (await lstatOrNull(paths.tooLarge)) return { skipped: "base-too-large" };
			if (!(await lstatOrNull(join(paths.repo, "HEAD")))) return { skipped: "not-primed" };
			return await withLock(paths, () =>
				snapshotLocked(paths, { runId, workspace, baseSha, seq, branch, secretValues, attempt, kind, quiesced, transcript, meta }),
			);
		} catch (err) {
			log("checkpoint_failed", { phase: "snapshot", code: err?.code ?? "internal" });
			return { skipped: "internal-error" };
		}
	}

	async function snapshotLocked(paths, args) {
		const { runId, workspace, baseSha, seq, branch, secretValues, attempt, kind, quiesced, transcript, meta } = args;
		const signal = AbortSignal.timeout(L.snapshotTimeoutMs);
		const cur = await readCurrent(paths);
		if (cur.seq && seq <= cur.seq) return { skipped: "stale-seq" };
		// Judged on the caller's OFFSET, before anything is read or written: the offset is the number of bytes
		// the copy would write, whatever the source's apparent size (a sparse file reads as zeros).
		const trOffset = isInt(transcript?.offset) ? transcript.offset : 0;
		if (trOffset > L.maxTranscriptBytes) return { skipped: "transcript-too-large" };
		const state = runState(runId);
		const objectFormat = await storeObjectFormat(paths, state, signal);
		if (!objectFormat || !HEX[objectFormat].test(baseSha)) return { skipped: "store-unreadable" };
		if (!(await diskOk(trOffset))) return { skipped: "disk-low" };
		if ((await storeBytes()) + trOffset > L.maxStoreBytes) return { skipped: "store-full" };

		const walk = await walkTree(workspace, signal);
		if (walk.skipped) return { skipped: walk.skipped };
		let files = walk.files;
		const rootReal = await fs.realpath(workspace);

		const cachedOid = new Map();
		const newBytesOf = (list) => list.reduce((n, f) => (cachedOid.has(f.path) ? n : n + Number(f.st.size)), 0);
		for (const f of files) {
			const hit = f.kind === "file" ? state.cache.get(f.path) : null;
			if (cacheMatches(hit, f.st)) cachedOid.set(f.path, hit.oid);
		}
		let ignoredDropped = false;
		if (newBytesOf(files) > L.maxNewBytes) {
			if (walk.unsafeIgnoreFile) return { skipped: "over-byte-cap" };
			const kept = await dropIgnored(paths, workspace, files, signal);
			if (!kept) return { skipped: signal.aborted ? "timeout" : "over-byte-cap" };
			files = kept;
			ignoredDropped = true;
			if (newBytesOf(files) > L.maxNewBytes) return { skipped: "over-byte-cap" };
		}

		const git = await parseGitState(workspace, branch);
		// Scanned: every stored PATH (a file named after a token leaks it as surely as one containing it, and
		// a directory name is a substring of every path under it), every symlink target, and every byte READ
		// for this snapshot. Not re-scanned: the CONTENT of a file served from the stat cache, which is
		// either base content (the repository's own, already on the forge) or bytes a previous snapshot of
		// this run read and scanned; writing a secret into one changes its ctime, so it is re-read.
		const secrets = [...new Set(secretValues)].filter((s) => typeof s === "string" && s.length > 0).map((s) => Buffer.from(s, "utf8"));
		if (files.some((f) => containsAny(Buffer.from(f.path, "utf8"), secrets))) {
			log("checkpoint_snapshot_skipped", { seq, reason: "job-secret-in-tree" });
			return { refused: "job-secret-in-tree" };
		}
		const counts = { files: 0, bytes: 0, newBytes: 0, skipped: { ...walk.excluded }, partial: walk.partial };
		const imported = await importTree(paths, { workspace, rootReal, files, cachedOid, baseSha, seq, secrets, objectFormat, signal, counts });
		if (!imported.commit) {
			log("checkpoint_snapshot_skipped", { seq, reason: imported.refused ?? imported.skipped });
			return imported;
		}
		for (const [p, entry] of imported.newOids) state.cache.set(p, entry);
		if (seq % L.repackEvery === 0) await runGit(paths, ["repack", "-adq"], { signal });

		// ── the commit point ──
		const dir = await reserveCp(paths, seq);
		let tr;
		try {
			tr = await copyTranscript(dir, transcript?.srcFile ?? null, trOffset, signal);
		} catch (err) {
			if (signal.aborted) return { skipped: "timeout" };
			throw err;
		}
		const manifest = {
			v: 1,
			runId: sanitizeJobId(runId).slice(0, 200),
			seq,
			attempt,
			host,
			kind,
			quiesced,
			at: Math.floor(now()),
			transcript: tr,
			workspace: {
				commit: imported.commit,
				baseSha,
				objectFormat,
				partial: counts.partial,
				ignoredDropped,
				counts: { files: counts.files, bytes: counts.bytes, newBytes: counts.newBytes, skipped: counts.skipped },
				git,
			},
		};
		for (const field of META_FIELDS) {
			manifest[field] = token(meta?.[field]);
			// Fail open and say which: a malformed token is dropped to null, and its NAME is logged.
			if (meta?.[field] != null && manifest[field] === null) log("checkpoint_meta_dropped", { field });
		}
		await atomicWrite(dir, "manifest.json", `${JSON.stringify(manifest)}\n`);
		await atomicWrite(paths.run, "CURRENT", `${seq}\n`);
		log("checkpoint_snapshot", { seq, files: counts.files, newBytes: counts.newBytes, partial: counts.partial, ignoredDropped });
		await pruneOld(paths, seq, cur.seq ?? null);
		return { ok: true, seq, manifest };
	}

	/**
	 * Keep the checkpoint `CURRENT` now names and the one it replaced; remove every other `cp-<seq>/` and
	 * every other `refs/pi-dispatch/cp/<seq>` (so the next repack can drop their objects). Without it every
	 * checkpoint's transcript copy stays forever, and a long run's store grows by one transcript per
	 * snapshot until `store-full` stops checkpointing altogether.
	 *
	 * CRASH-SAFE BY ORDER: it runs only after `CURRENT`'s rename and directory fsync, and it never touches
	 * the two it keeps, so a crash anywhere in here leaves `CURRENT` naming a complete checkpoint; what is
	 * left over is pruned by the next snapshot. The previous one is kept as the fallback an operator (or a
	 * later recovery change) can reach when the newest turns out to be the bad one. A failure here is
	 * logged and does not fail the snapshot, which has already committed. It runs under the snapshot's lock.
	 */
	async function pruneOld(paths, seq, previous) {
		const keep = new Set([seq, previous].filter((n) => n !== null));
		try {
			const refs = await runGit(paths, ["for-each-ref", "--format=%(refname)", "refs/pi-dispatch/cp/"]);
			const doomed = refs.stdout
				.toString("latin1")
				.split("\n")
				.filter((r) => /^refs\/pi-dispatch\/cp\/[1-9][0-9]*$/.test(r) && !keep.has(Number(r.slice("refs/pi-dispatch/cp/".length))));
			if (doomed.length) {
				const del = await runGit(paths, ["update-ref", "--stdin"], { input: doomed.map((r) => `delete ${r}\n`).join("") });
				if (del.code !== 0) throw Object.assign(new Error("update-ref failed"), { code: "EGIT" });
			}
			let removed = 0;
			for (const n of await fs.readdir(paths.run)) {
				const m = /^cp-([1-9][0-9]*)$/.exec(n);
				if (!m || keep.has(Number(m[1]))) continue;
				await fs.rm(join(paths.run, n), { recursive: true, force: true });
				removed++;
			}
			if (removed || doomed.length) log("checkpoint_pruned", { removed, refs: doomed.length });
		} catch (err) {
			log("checkpoint_prune_failed", { code: err?.code ?? "internal" });
		}
	}

	// ── readManifest ────────────────────────────────────────────────────────────────────────────────────

	/**
	 * A plain object with EXACTLY these keys. Closed at every level, not only the top: an open nested
	 * object is where a path or a payload string would ride along unvalidated into everything that reads
	 * a manifest.
	 */
	function closed(o, keys) {
		if (!o || typeof o !== "object" || Array.isArray(o)) return false;
		const have = Object.keys(o).sort();
		const want = [...keys].sort();
		return have.length === want.length && have.every((k, i) => k === want[i]);
	}

	/** Every field typed, every string an enum, hex, a host name or a short token. A reason, or null. */
	function manifestProblem(m) {
		const keys = ["v", "runId", "seq", "attempt", "host", "kind", "quiesced", "at", "transcript", "workspace", ...META_FIELDS];
		if (!m || typeof m !== "object" || Array.isArray(m)) return "not-object";
		if (!closed(m, keys)) return "keys";
		if (m.v !== 1) return "v";
		if (typeof m.runId !== "string" || !RUN_ID_RE.test(m.runId)) return "runId";
		if (!isInt(m.seq, 1, 999_999_999)) return "seq";
		if (!isInt(m.attempt, 0, 10_000)) return "attempt";
		if (typeof m.host !== "string" || !HOST_RE.test(m.host)) return "host";
		if (!KINDS.has(m.kind)) return "kind";
		if (!QUIESCED.has(m.quiesced)) return "quiesced";
		if (!isInt(m.at)) return "at";
		const t = m.transcript;
		if (!closed(t, ["bytes", "sha256"]) || !isInt(t.bytes) || typeof t.sha256 !== "string" || !SHA256_HEX.test(t.sha256)) return "transcript";
		const w = m.workspace;
		if (!closed(w, ["commit", "baseSha", "objectFormat", "partial", "ignoredDropped", "counts", "git"])) return "workspace";
		if (!HEX[w.objectFormat]) return "objectFormat";
		if (typeof w.commit !== "string" || !HEX[w.objectFormat].test(w.commit)) return "commit";
		if (typeof w.baseSha !== "string" || !HEX[w.objectFormat].test(w.baseSha)) return "baseSha";
		if (typeof w.partial !== "boolean" || typeof w.ignoredDropped !== "boolean") return "flags";
		const c = w.counts;
		if (!closed(c, ["files", "bytes", "newBytes", "skipped"]) || !isInt(c.files) || !isInt(c.bytes) || !isInt(c.newBytes)) return "counts";
		const skippedKeys = ["unreadable", "special", "dotgit", "badName", "tooLarge"];
		if (!closed(c.skipped, skippedKeys) || !skippedKeys.every((k) => isInt(c.skipped[k]))) return "counts";
		const g = w.git;
		if (!closed(g, ["state", "branch", "tip", "detached"]) || !GIT_STATES.has(g.state) || typeof g.detached !== "boolean") return "git";
		if (g.branch !== null && !isBranchName(g.branch)) return "git";
		if (g.tip !== null && !(typeof g.tip === "string" && ANY_HEX_OID.test(g.tip))) return "git";
		for (const f of META_FIELDS) if (m[f] !== null && token(m[f]) === null) return f;
		return null;
	}

	async function hashFile(path) {
		const fh = await fs.open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
		try {
			if (!(await fh.stat()).isFile()) return null;
			const hash = createHash("sha256");
			const chunk = Buffer.allocUnsafe(MiB);
			let bytes = 0;
			for (;;) {
				const { bytesRead } = await fh.read(chunk, 0, chunk.length, bytes);
				if (bytesRead === 0) break;
				hash.update(chunk.subarray(0, bytesRead));
				bytes += bytesRead;
			}
			return { bytes, sha256: hash.digest("hex") };
		} finally {
			await fh.close().catch(() => {});
		}
	}

	/**
	 * The checkpoint CURRENT names, validated: `{ ok, manifest, transcriptPath }`, `{ absent }` when there
	 * is none, `{ invalid, reason }` when what is there cannot be trusted. The transcript's bytes are hashed
	 * against the manifest, because the resume feeds it to a paid model and a truncated one resumes a
	 * different conversation.
	 */
	async function readManifest(runId) {
		try {
			if (typeof runId !== "string" || !runId) return { invalid: true, reason: "bad-args" };
			const paths = runPaths(runId);
			// lstat, and a real directory: a link at the run's name is not this run's store, whatever it points at.
			if (!(await lstatOrNull(paths.run))?.isDirectory()) return { absent: true };
			const cur = await readCurrent(paths);
			if (cur.absent) return { absent: true };
			if (cur.invalid) return { invalid: true, reason: cur.invalid };
			const raw = await readRegular(join(paths.cp(cur.seq), "manifest.json"), MiB);
			if (!raw.buf) return { invalid: true, reason: "manifest-unreadable" };
			let manifest;
			try {
				manifest = JSON.parse(raw.buf.toString("utf8"));
			} catch {
				return { invalid: true, reason: "manifest-json" };
			}
			const problem = manifestProblem(manifest);
			if (problem) return { invalid: true, reason: `field:${problem}` };
			if (manifest.seq !== cur.seq) return { invalid: true, reason: "seq-mismatch" };
			const transcriptPath = join(paths.cp(cur.seq), "transcript.jsonl");
			const got = await hashFile(transcriptPath).catch(() => null);
			if (!got || got.bytes !== manifest.transcript.bytes || got.sha256 !== manifest.transcript.sha256) {
				return { invalid: true, reason: "transcript-mismatch" };
			}
			return { ok: true, manifest, transcriptPath };
		} catch (err) {
			log("checkpoint_failed", { phase: "read", code: err?.code ?? "internal" });
			return { invalid: true, reason: "internal-error" };
		}
	}

	// ── restore ─────────────────────────────────────────────────────────────────────────────────────────

	/** `file://` URL of a run's store, for the caller's `fetch --depth=1 <url> <baseSha>` (needs `protocol.file.allow=always`). */
	function baseSourceUrl(runId) {
		return pathToFileURL(runPaths(runId).repo).href;
	}

	/** Parse `diff-tree -r -z --raw` output into `{ srcMode, dstMode, dstOid, status, path }` records. */
	function parseRaw(buf) {
		const parts = buf.toString("utf8").split("\0");
		const out = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/.exec(parts[i]);
			if (!m) return null;
			out.push({ srcMode: m[1], dstMode: m[2], dstOid: m[4], status: m[5], path: parts[i + 1] });
		}
		return out;
	}

	function prefixes(path) {
		const segs = path.split("/");
		const out = [];
		for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
		return out;
	}

	/**
	 * Judge the whole change list BEFORE touching the disk: every path through `validPath` (the same rule
	 * the snapshot applied), no gitlink in the result (the snapshot never writes one, so one there is a
	 * forged store), no file under a path the result makes a symlink (the write would land through the
	 * link), and no two spellings of one name under case folding (one would silently overwrite the other).
	 *
	 * A gitlink on the BASE side being deleted is not refused and not acted on: the snapshot cannot record
	 * a submodule, so its absence from the snapshot tree describes the snapshot, not a change to make.
	 */
	function judgeChanges(changes, commitTree) {
		const OK_MODES = new Set(["100644", "100755", "120000"]);
		const links = new Set();
		const folds = new Map();
		for (const { path, mode } of commitTree) {
			if (mode === "120000") links.add(path);
			for (const p of [...prefixes(path), path]) {
				const k = foldCase(p);
				if (!folds.has(k)) folds.set(k, new Set());
				folds.get(k).add(p);
			}
		}
		for (const c of changes) {
			if (!validPath(c.path)) return "tampered";
			// The mode check IS the gitlink check: 160000 is not a mode a snapshot writes, so a gitlink on the
			// result side is refused here, before any blob is asked for.
			if (c.status !== "D" && !OK_MODES.has(c.dstMode)) return "tampered";
			if (c.status === "D") continue;
			for (const p of prefixes(c.path)) if (links.has(p)) return "path-through-symlink";
			for (const p of [...prefixes(c.path), c.path]) if ((folds.get(foldCase(p))?.size ?? 0) > 1) return "case-collision";
		}
		return null;
	}

	class Refusal extends Error {
		constructor(reason) {
			super(reason);
			this.reason = reason;
		}
	}

	/**
	 * Every existing ancestor of `path` under `root` must lstat as a real directory; missing ones are made
	 * one segment at a time (0755). A symlink anywhere on the way refuses: `mkdir -p` would follow it.
	 */
	async function ensureParents(root, path, create) {
		let cur = root;
		for (const seg of prefixes(path).map((p) => p.split("/").at(-1))) {
			cur = join(cur, seg);
			const st = await lstatOrNull(cur);
			if (!st) {
				if (!create) return;
				await fs.mkdir(cur, { mode: 0o755 });
				continue;
			}
			if (st.isSymbolicLink()) throw new Refusal("path-through-symlink");
			if (!st.isDirectory()) throw new Refusal("path-conflict");
		}
	}

	/** Remove now-empty parents of a deleted path, the way a git checkout would; stops at the first non-empty. */
	async function pruneEmpty(root, path) {
		for (const p of prefixes(path).reverse()) {
			try {
				await fs.rmdir(join(root, p));
			} catch {
				return;
			}
		}
	}

	/** One `cat-file --batch` for every blob a restore writes: one process, request, header, bytes. */
	function blobReader(paths, signal) {
		const { child, done } = startGit(paths, ["cat-file", "--batch"], { signal });
		child.stdout.removeAllListeners("data");
		const reader = byteReader(child.stdout);
		return {
			async read(oid) {
				child.stdin.write(`${oid}\n`);
				const header = await reader.line();
				const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
				if (!m || m[1] !== oid) throw new Refusal("tampered");
				const size = Number(m[2]);
				if (size > L.maxFileBytes) throw new Refusal("tampered");
				const bytes = await reader.bytes(size + 1);
				return bytes.subarray(0, size);
			},
			async close() {
				child.stdin.end();
				await done;
			},
		};
	}

	/**
	 * The commit the caller's checkout is at, from FILES: `HEAD` as a sha, or `ref: refs/heads/<name>`
	 * resolved through the loose ref or `packed-refs`. The restore applies a diff against `baseSha`, so a
	 * checkout at any other commit would come out as neither tree. Parsed rather than `git rev-parse`,
	 * although the target is a fresh host-made clone where rev-parse would be acceptable, for two reasons:
	 * every store git keeps `GIT_DIR` pointing at the STORE (the bolt the tests hold), and the parser
	 * already exists for the snapshot side. `null` when it cannot be read.
	 */
	async function checkoutHead(dir) {
		const gitDir = join(dir, ".git");
		if (!(await lstatOrNull(gitDir).catch(() => null))?.isDirectory()) return null;
		const head = await readRegular(join(gitDir, "HEAD"), 256);
		if (!head.buf) return null;
		const text = head.buf.toString("latin1");
		const sha = /^([0-9a-f]{40}|[0-9a-f]{64})\n?$/.exec(text);
		if (sha) return sha[1];
		const sym = /^ref: refs\/heads\/([^\n]+)\n?$/.exec(text);
		return sym && isBranchName(sym[1]) ? lookupBranchTip(gitDir, sym[1]) : null;
	}

	/**
	 * Apply a checkpoint to `intoWorkspace`, which already holds a base checkout at the manifest's
	 * `baseSha`. Only the changed paths are touched. Order: deletions and type changes (so a path that was a
	 * file and is now a directory is free), then regular files, then symlinks LAST, so no write of this
	 * restore can ever traverse a link this restore created. Files are opened `O_NOFOLLOW` with `O_TRUNC`
	 * and their mode set explicitly (an existing file keeps its old mode through `O_CREAT`).
	 *
	 * A refusal found on DISK (a symlinked ancestor the base checkout holds) can come after some writes;
	 * the caller discards a refused workspace, it never resumes in one.
	 */
	async function restore({ runId, manifest, intoWorkspace } = {}) {
		try {
			if (typeof runId !== "string" || !runId) return { skipped: "bad-args" };
			if (manifestProblem(manifest)) return { refused: "bad-manifest" };
			// A manifest from ANOTHER run's store applied here would restore that run's tree into this one.
			if (manifest.runId !== sanitizeJobId(runId).slice(0, 200)) return { refused: "run-mismatch" };
			const paths = runPaths(runId);
			if (!(await lstatOrNull(paths.run))?.isDirectory()) return { skipped: "not-primed" };
			if (!(await lstatOrNull(join(paths.repo, "HEAD")))) return { skipped: "not-primed" };
			if (!(await lstatOrNull(intoWorkspace))?.isDirectory()) return { skipped: "workspace-not-directory" };
			if ((await checkoutHead(intoWorkspace)) !== manifest.workspace.baseSha) return { refused: "base-mismatch" };
			return await withLock(paths, () => restoreLocked(paths, manifest, intoWorkspace));
		} catch (err) {
			if (err instanceof Refusal) return { refused: err.reason };
			log("checkpoint_failed", { phase: "restore", code: err?.code ?? "internal" });
			return { skipped: "internal-error" };
		}
	}

	async function restoreLocked(paths, manifest, root) {
		const signal = AbortSignal.timeout(L.snapshotTimeoutMs);
		const { baseSha, commit } = manifest.workspace;
		const diff = await runGit(paths, ["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", baseSha, commit], { signal });
		if (diff.code !== 0) return { skipped: "store-unreadable" };
		const changes = parseRaw(diff.stdout);
		if (!changes) return { refused: "tampered" };
		const tree = await runGit(paths, ["ls-tree", "-r", "-z", "--full-tree", commit], { signal });
		if (tree.code !== 0) return { skipped: "store-unreadable" };
		const commitTree = [];
		for (const rec of tree.stdout.toString("utf8").split("\0")) {
			const m = /^(\d{6}) \w+ [0-9a-f]+\t(.+)$/s.exec(rec);
			if (m) commitTree.push({ mode: m[1], path: m[2] });
		}
		const verdict = judgeChanges(changes, commitTree);
		if (verdict) {
			log("checkpoint_restore_refused", { reason: verdict });
			return { refused: verdict };
		}

		let removed = 0;
		let written = 0;
		for (const c of changes) {
			if (c.status !== "D" && c.status !== "T") continue;
			if (c.srcMode === "160000") continue;
			await ensureParents(root, c.path, false);
			const abs = join(root, c.path);
			const st = await lstatOrNull(abs);
			if (st?.isDirectory()) throw new Refusal("path-conflict");
			if (st) {
				await fs.unlink(abs);
				removed++;
			}
			if (c.status === "D") await pruneEmpty(root, c.path);
		}
		const blobs = blobReader(paths, signal);
		try {
			const ordered = changes.filter((c) => c.status !== "D");
			for (const c of [...ordered.filter((c) => c.dstMode !== "120000"), ...ordered.filter((c) => c.dstMode === "120000")]) {
				if (signal.aborted) return { skipped: "timeout" };
				await ensureParents(root, c.path, true);
				const abs = join(root, c.path);
				const bytes = await blobs.read(c.dstOid);
				const existing = await lstatOrNull(abs);
				if (existing?.isDirectory()) throw new Refusal("path-conflict");
				if (c.dstMode === "120000") {
					if (bytes.length === 0 || bytes.length > MAX_LINK_BYTES || bytes.includes(0)) throw new Refusal("tampered");
					if (existing) await fs.unlink(abs);
					await fs.symlink(bytes, abs);
				} else {
					const mode = c.dstMode === "100755" ? 0o755 : 0o644;
					let fh;
					try {
						fh = await fs.open(abs, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, mode);
					} catch (err) {
						if (err?.code === "ELOOP") throw new Refusal("path-through-symlink");
						throw err;
					}
					try {
						await fh.writeFile(bytes);
						await fh.chmod(mode);
					} finally {
						await fh.close().catch(() => {});
					}
				}
				written++;
			}
		} finally {
			await blobs.close().catch(() => {});
		}
		log("checkpoint_restored", { seq: manifest.seq, written, removed });
		return { written, removed };
	}

	// ── remove, sweep, usage ────────────────────────────────────────────────────────────────────────────

	async function remove(runId) {
		try {
			if (typeof runId !== "string" || !runId) return { skipped: "bad-args" };
			await fs.rm(runPaths(runId).run, { recursive: true, force: true });
			runs.delete(runId);
			return { removed: true };
		} catch (err) {
			log("checkpoint_failed", { phase: "remove", code: err?.code ?? "internal" });
			return { skipped: "remove-failed" };
		}
	}

	/**
	 * Remove run stores older than `ttlMs`. Only names that ARE run keys (32 hex) are judged, and only
	 * when they lstat as a real directory: a link with a key's name is left alone, never followed into
	 * whatever it points at. Age is the newest manifest's mtime (a run checkpointing yesterday is young
	 * whatever its directory's mtime says), falling back to the directory's own. `active` names runs the
	 * caller still holds; one yield between entries keeps a large store from monopolising the loop.
	 */
	async function sweep({ active = [] } = {}) {
		try {
			const keep = new Set([...active].map((id) => checkpointKey(String(id))));
			let names;
			try {
				names = await fs.readdir(storeDir);
			} catch (err) {
				if (err?.code === "ENOENT") return { removed: 0, kept: 0 };
				throw err;
			}
			let removed = 0;
			let kept = 0;
			for (const name of names) {
				await yieldTick();
				if (!/^[0-9a-f]{32}$/.test(name)) continue;
				const dir = join(storeDir, name);
				const st = await lstatOrNull(dir).catch(() => null);
				if (!st?.isDirectory() || keep.has(name)) {
					kept++;
					continue;
				}
				let newest = st.mtimeMs;
				let sawManifest = false;
				for (const n of await fs.readdir(dir).catch(() => [])) {
					if (!/^cp-[1-9][0-9]*$/.test(n)) continue;
					const m = await lstatOrNull(join(dir, n, "manifest.json")).catch(() => null);
					if (m?.isFile()) {
						newest = sawManifest ? Math.max(newest, m.mtimeMs) : m.mtimeMs;
						sawManifest = true;
					}
				}
				if (now() - newest > L.ttlMs) {
					await fs.rm(dir, { recursive: true, force: true });
					removed++;
				} else {
					kept++;
				}
			}
			if (removed) log("checkpoint_swept", { removed, kept });
			return { removed, kept };
		} catch (err) {
			log("checkpoint_failed", { phase: "sweep", code: err?.code ?? "internal" });
			return { skipped: "sweep-failed" };
		}
	}

	async function usage() {
		try {
			return { bytes: await storeBytes() };
		} catch {
			return { skipped: "usage-failed" };
		}
	}

	return { primeBase, snapshot, restore, remove, sweep, usage, readManifest, writeTranscript, baseSourceUrl };
}
