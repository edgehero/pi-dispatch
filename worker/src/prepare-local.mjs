import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { materializePiDir } from "./materialize.mjs";

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
export async function prepareLocalWorkspace({ folder, task, jobDir, git = defaultGit, event = { source: "manual" } }) {
	if (!existsSync(folder)) {
		const error = new Error(`local folder does not exist: ${folder}`);
		error.piDispatchConfig = true;
		throw error;
	}
	if (!existsSync(join(folder, ".git"))) {
		const error = new Error(`local folder is not a git repository (v1 requires one): ${folder}`);
		error.piDispatchConfig = true;
		throw error;
	}

	const sha = (await git(folder, ["rev-parse", "HEAD"])).trim();

	mkdirSync(jobDir, { recursive: true });
	// The outbox is the container's only signal channel back to the worker (INT-OUTBOX-CONTRACT). It is
	// mounted /outbox:rw for local jobs only; the host reads it after the run to enqueue chained children.
	const outboxDir = join(jobDir, "outbox");
	mkdirSync(outboxDir, { recursive: true });
	// Instructions from HEAD, via the symlink-safe git materialiser, into /job/pi (mounted :ro).
	const pi = await materializePiDir({ gitDir: folder, sha, destDir: jobDir });
	// A .pi/ over a materialiser cap (issue #60) refuses the job determinately, before prompt.md and
	// event.json exist. Returned rather than thrown: the same tree breaches the same cap on every
	// retry (CONST-RETRY-INFRA-ONLY), and the processor's policy branch spends nothing on it.
	if (pi?.outcome === "policy") return pi;
	const written = pi.written;

	// The task the operator asked for. Plain data below the instructions.
	writeFileSync(join(jobDir, "prompt.md"), String(task ?? ""), { mode: 0o444 });

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
	writeFileSync(join(jobDir, "event.json"), JSON.stringify(eventBody, null, 2), { mode: 0o444 });

	// The folder itself is /workspace (rw). No clone: local jobs edit in place.
	return { workspace: folder, jobDir, outboxDir, sha, materialised: written };
}

async function defaultGit(gitDir, args) {
	const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "--no-pager", "-C", gitDir, ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}
