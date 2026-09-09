import { GIT_READ_FLAGS } from "./git-hardening.mjs";
import { execFile } from "node:child_process";
import * as realFs from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { materializePiDir } from "./materialize.mjs";
import { InfraRetry } from "./processor.mjs";
import { isDeterminateFsCode } from "./transient.mjs";

const exec = promisify(execFile);

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
	requirePath(fs, join(folder, ".git"), `local folder is not a git repository (v1 requires one): ${folder}`, "the local folder's .git");

	const sha = (await git(folder, ["rev-parse", "HEAD"])).trim();

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
	try {
		fs.statSync(path);
	} catch (error) {
		if (isDeterminateFsCode(error?.code)) {
			const refusal = new Error(absentMessage);
			refusal.piDispatchConfig = true;
			throw refusal;
		}
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
