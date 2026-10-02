import { GIT_READ_FLAGS } from "./git-hardening.mjs";
import { execFile } from "node:child_process";
import * as realFs from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { materializePiDir } from "./materialize.mjs";
import { InfraRetry } from "./processor.mjs";
import { isDeterminateFsCode } from "./transient.mjs";

const exec = promisify(execFile);

/** The run-record reason for a local job whose folder has no `.git` at its root (issue #524). */
export const LOCAL_FOLDER_NOT_A_REPO = "local-folder-not-a-repo";
/** The run-record reason for a local job whose repository has no commit at HEAD yet (issue #524). */
export const LOCAL_FOLDER_NO_COMMIT = "local-folder-no-commit";
/** The run-record reason for a local job whose repository git cannot resolve HEAD in, other than an unborn HEAD (issue #524). */
export const LOCAL_FOLDER_UNREADABLE_REPO = "local-folder-unreadable-repo";

/**
 * Prepare a LOCAL-FOLDER job. This is the zero-GitHub path: no token, no clone, no PR. The folder
 * on the operator's own machine becomes /workspace (bind-mounted read-write), edited in place.
 *
 * For v1 the folder must be a git repository, which buys two things for free: a stable ref (HEAD)
 * to read instructions from, and git's object model, so `.pi/` materialises through the same
 * symlink/submodule-safe path as GitHub jobs (materializePiDir). Instructions come from HEAD
 * (committed, reviewed); work happens on the working tree in /workspace. A non-git folder is a
 * documented v1 limitation -- `git init` it first.
 *
 * The task text is DATA (CONST-ISSUE-TEXT-IS-DATA): it goes into /job/prompt.md, never the
 * instructions. The operator supplies it via the CLI (`pi-dispatch run --task`).
 *
 * `event` is the trigger context the dispatcher derived (cron/manual/chain); it lands in
 * /job/event.json (INT-CONTAINER-JOB-INPUTS) -- one file per concern, alongside prompt.md. The
 * default keeps a directly-constructed call (tests, older wiring) honest: a job with no derived
 * context is a manual run.
 */
export async function prepareLocalWorkspace({ folder, task, jobDir, git = defaultGit, event = { source: "manual" }, fs = realFs }) {
	requirePath(fs, folder, `local folder does not exist: ${folder}`, "the local folder");
	// Issue #524: a folder that is not a repository is its own determinate refusal, RETURNED with its own reason
	// (CONST-RETRY-INFRA-ONLY), not a config throw. As a throw it reached the processor's config arm, which can only
	// say "this deployment is misconfigured" (`config-refused`), about a folder the operator can fix with `git init`.
	// Returned here it is a prepare-stage policy refusal like `sha-gone`: before the budget reserve, so it spends
	// nothing, and `prepare.mjs` removes the job dir it made. The reason is a fixed token and carries no path, so the
	// worker log and the run record stay as PII-free as they are. `pi-dispatch run` refuses the same folder before
	// queueing; this is the check for a folder that stopped being a repository between queue and pickup, and for a
	// cron trigger's folder, which nothing checks when it fires.
	if (!presentAt(fs, join(folder, ".git"), "the local folder's .git")) return { outcome: "policy", reason: LOCAL_FOLDER_NOT_A_REPO };

	// Issue #524: a HEAD git cannot resolve escaped as an untagged throw, a failed job with no reason. It is now
	// refused by name, RETURNED before the reserve and before anything is written, like the not-a-repo one above,
	// but only once the files git needs have been read back under `presentAt`'s rule (PR #528's review, round 2).
	// git's exit code says "could not", never "why": `rev-parse --verify --quiet` exits 1 for an unborn HEAD AND for
	// a missing commit object, a garbage branch ref, an unreadable `refs/heads`; it exits 128 for an empty `.git`
	// AND for an EACCES on `.git/HEAD` or `.git/objects`, with the same "not a git repository" either way (all
	// measured, git 2.x). Its text is no help either: a locale translates it, and it names host paths.
	//   - `local-folder-no-commit` only for a truly unborn HEAD: the follow-up `rev-parse --verify --quiet HEAD`
	//     also exits 1 AND `symbolic-ref -q HEAD` succeeds (HEAD names a branch that does not exist yet). A HEAD
	//     that resolves to a missing object or a non-commit, or a branch ref that cannot be read, is not "commit
	//     once" and must not be told so.
	//   - `local-folder-unreadable-repo` for every other 1 or 128.
	// Before either refusal, `assertGitFilesReadable` reads what git needed. An error outside the determinate
	// allow-list (`transient.mjs`: EACCES and EIO are deliberately transient) throws InfraRetry, so a filesystem
	// that cannot answer right now is retried rather than refused for good. Any other git failure (a missing git
	// binary, a signal) still throws as it did.
	let sha;
	try {
		sha = (await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
	} catch (error) {
		if (error?.code !== 1 && error?.code !== 128) throw error;
		assertGitFilesReadable(fs, folder);
		if (error.code === 1 && (await unbornHead(git, folder))) return { outcome: "policy", reason: LOCAL_FOLDER_NO_COMMIT };
		return { outcome: "policy", reason: LOCAL_FOLDER_UNREADABLE_REPO };
	}

	fs.mkdirSync(jobDir, { recursive: true });
	// The outbox is the container's only signal channel back to the worker (INT-OUTBOX-CONTRACT). It is
	// mounted /outbox:rw for local jobs only; the host reads it after the run to enqueue chained children.
	const outboxDir = join(jobDir, "outbox");
	fs.mkdirSync(outboxDir, { recursive: true });
	// Instructions from HEAD, via the symlink-safe git materialiser, into /job/pi (mounted :ro).
	const pi = await materializePiDir({ gitDir: folder, sha, destDir: jobDir });
	// A .pi/ over a materialiser cap (issue #60) refuses the job determinately, before prompt.md and
	// event.json exist. Returned rather than thrown: the same tree breaches the same cap on every
	// retry (CONST-RETRY-INFRA-ONLY), and the processor's policy branch spends nothing on it.
	if (pi?.outcome === "policy") return pi;
	const written = pi.written;

	// The task the operator asked for. Plain data below the instructions.
	fs.writeFileSync(join(jobDir, "prompt.md"), String(task ?? ""), { mode: 0o444 });

	// The trigger context, /job/event.json (INT-CONTAINER-JOB-INPUTS): one file per concern, 0o444 like
	// the prompt, written unconditionally so every local run carries its origin. `folder` is the BASENAME
	// only -- the full path embeds the operator's OS account name and /job is agent-readable, the same
	// PII restraint run-history's `local:<basename>` target applies. The cron-only keys (trigger,
	// scheduledFor, previousRunAt) appear only for a cron source, nulls preserved.
	const eventBody = {
		source: event.source,
		...(event.trigger ? { trigger: event.trigger } : {}),
		folder: basename(folder),
		sha,
		...(event.source === "cron" ? { scheduledFor: event.scheduledFor ?? null, previousRunAt: event.previousRunAt ?? null } : {}),
	};
	fs.writeFileSync(join(jobDir, "event.json"), JSON.stringify(eventBody, null, 2), { mode: 0o444 });

	// The folder itself is /workspace (rw). No clone: local jobs edit in place.
	return { workspace: folder, jobDir, outboxDir, sha, materialised: written };
}

/**
 * Assert that something exists at `path`, distinguishing absence from a filesystem that is momentarily
 * unable to answer (issue #316).
 *
 * `existsSync` was the wrong instrument and it was the only one here for a year: it returns FALSE for
 * every stat error, not only `ENOENT`. So `EACCES` on a parent directory, `EIO` on a failing disk, and a
 * hung or not-yet-mounted autofs/NFS path after a host reboot all reported "your folder does not exist".
 * #310 turned that into a refund, a never-retried delivery and a public comment telling the issue author
 * the operator's deployment is misconfigured, on a deployment that was correct a second earlier and is
 * correct again a second later.
 *
 * `statSync` FOLLOWS symlinks and accepts a file as readily as a directory, both of which this needs:
 * `.git` is a FILE in a worktree and in a submodule, and a symlinked project folder is ordinary.
 */
function requirePath(fs, path, absentMessage, what) {
	if (presentAt(fs, path, what)) return;
	const refusal = new Error(absentMessage);
	refusal.piDispatchConfig = true;
	throw refusal;
}

/**
 * True when something is at `path`, false when it is determinately absent, and a THROWN InfraRetry when the
 * filesystem could not answer. The second half of `requirePath`, split out so the `.git` check can return its own
 * refusal instead of throwing one, with the same rule about which errors mean absent (issue #316, below).
 */
function presentAt(fs, path, what) {
	try {
		fs.statSync(path);
		return true;
	} catch (error) {
		if (isDeterminateFsCode(error?.code)) return false;
		// Not absent, just unreachable right now. Throw the retryable class so the queue tries again
		// instead of spending the delivery on a verdict that is wrong by the time it is posted.
		// BASENAME, not the path (issue #289): an InfraRetry survives retries and its message becomes the
		// queue's failedReason and the job_failed line -- a full host path there carries an OS account
		// name, which is buildRecord's own reason for reducing folders to basenames. The config refusals
		// above keep their full paths: they surface on CLI stderr and through the #310 classifier's fixed
		// sentence, where the path is the repair.
		throw new InfraRetry(`could not read ${what} (${error?.code ?? error?.message ?? "unknown"}): ${basename(path)}`);
	}
}

/**
 * True only for an unborn HEAD: one that names a branch with no commit yet (issue #524, PR #528's review). Both
 * answers are git's exit codes. `rev-parse --verify --quiet HEAD` exits 0 when HEAD names SOME object, which after
 * `HEAD^{commit}` failed means a missing or non-commit object; `symbolic-ref -q HEAD` fails for a detached HEAD and
 * for a branch ref git cannot read (measured: a garbage ref and an EACCES `refs/heads` both exit 128 there).
 */
async function unbornHead(git, folder) {
	try {
		await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
		return false;
	} catch (error) {
		if (error?.code !== 1) return false;
	}
	try {
		await git(folder, ["symbolic-ref", "-q", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read back the files git needs to resolve HEAD, under `presentAt`'s rule: an absence the allow-list calls
 * determinate is fine (the refusal stands), anything else throws InfraRetry so the job is retried (PR #528's review,
 * round 2). `.git`; when it is a file (a worktree or submodule), the gitdir it names; `<gitdir>/HEAD`;
 * `<gitdir>/config` when present; and the branch ref HEAD names, which is where an unreadable `refs/heads` shows.
 * A ref that is absent is ordinary (an unborn branch, or one only in packed-refs). Messages carry basenames only.
 */
function assertGitFilesReadable(fs, folder) {
	const dotGit = join(folder, ".git");
	const st = statOrRetry(fs, dotGit);
	if (!st) return;
	let gitDir = dotGit;
	if (st.isFile?.()) {
		const pointer = readOrRetry(fs, dotGit);
		const named = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
		if (!named) return;
		gitDir = resolve(folder, named);
		if (!statOrRetry(fs, gitDir)) return;
	}
	const head = readOrRetry(fs, join(gitDir, "HEAD"));
	readOrRetry(fs, join(gitDir, "config"));
	const ref = head === null ? null : /^ref:\s*(refs\/\S+)\s*$/m.exec(head)?.[1];
	if (ref && !ref.split("/").includes("..")) readOrRetry(fs, join(gitDir, ref));
}

function statOrRetry(fs, path) {
	try {
		return fs.statSync(path);
	} catch (error) {
		if (isDeterminateFsCode(error?.code)) return null;
		throw new InfraRetry(`could not read the local folder's git files (${error?.code ?? "unknown"}): ${basename(path)}`);
	}
}

function readOrRetry(fs, path) {
	try {
		return fs.readFileSync(path, "utf8");
	} catch (error) {
		if (isDeterminateFsCode(error?.code)) return null;
		throw new InfraRetry(`could not read the local folder's git files (${error?.code ?? "unknown"}): ${basename(path)}`);
	}
}

async function defaultGit(gitDir, args) {
	// This was the one copy of seven missing `core.fsmonitor=false`, which is why the flags are imported
	// now rather than restated (issue #286's sweep). Nothing was exploitable -- the only command below is
	// `rev-parse HEAD`, which does not refresh the index -- but a local-folder job's agent can write
	// `.git/config` inside /workspace, so the moment this grows a second command that touches the index,
	// an attacker-controlled fsmonitor hook runs on the worker HOST, outside any container.
	const { stdout } = await exec("git", [...GIT_READ_FLAGS, "-C", gitDir, ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}
