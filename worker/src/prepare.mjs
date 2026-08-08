import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveJobImage } from "./image-preflight.mjs";
import { retainJobDir } from "./sandbox-store.mjs";
import { prepareGithubWorkspace } from "./prepare-github.mjs";
import { gitlabRemoteUrl } from "./gitlab-host.mjs";
import { forgejoRemoteUrl } from "./forgejo-host.mjs";
import { azureRemoteUrl } from "./azure-host.mjs";
import { buildGitLabPrompt } from "./gitlab-prompt.mjs";
import { buildForgejoPrompt } from "./forgejo-prompt.mjs";
import { buildAzurePrompt } from "./azure-prompt.mjs";
import { prepareLocalWorkspace } from "./prepare-local.mjs";

/**
 * The `prepareWorkspace` dispatcher the processor injects. Creates a per-job dir under `jobsDir`
 * (holding the read-only /job inputs) and routes by job kind: local jobs go to `prepareLocalWorkspace`,
 * forge-backed jobs to the preparer registered for their kind.
 *
 * The `flow` becomes a prompt hint; the actual skill is provided by the project's materialised
 * .pi/skills.
 *
 * `forgeFor(job)` yields the `{ auth, host }` pair for that job's forge (start.mjs owns the map). The
 * preparer is handed `host.resolveDefaultBranchSha` rather than the whole pair, so a preparer can only
 * resolve a SHA -- it gets no minting capability and no comment surface it has no business holding.
 *
 * `findPreviousRun` (run-history's `makeFindPreviousRun`) feeds the cron event context below; the
 * default returns null so an unwired dispatcher (tests, a bare construction) still writes a complete
 * event with `previousRunAt: null`.
 */
export function makePrepareWorkspace({
	jobsDir,
	forgeFor,
	// REQ-RESURRECTABLE-SANDBOX. The DEPLOYMENT default image, resolved per job against the trigger's own
	// `run.image` through the SAME function the pre-spend preflight and run-container use -- so the tag that
	// was checked, the tag that ran and the tag a sandbox later re-opens are one answer by construction
	// rather than three call sites that happen to agree. Null leaves the stamp imageless, and
	// `resolveSandbox` then refuses rather than guessing.
	jobImage = null,
	findPreviousRun = () => null,
	// REQ-RESUMABLE-SESSION. The default returns null, so an unwired dispatcher -- tests, a bare
	// construction -- prepares exactly what it always did: no /session mount, nothing on disk.
	resolveSession = () => null,
	prepareLocal = prepareLocalWorkspace,
	// Keyed by `job.kind`, so a new forge is one entry rather than a new `if`. A kind with no entry falls
	// through to the throw below, which is what makes an unrouted job loud instead of a silent no-op.
	preparers = { github: prepareGithubWorkspace },
}) {
	mkdirSync(jobsDir, { recursive: true });
	return async function prepareWorkspace(job, token, { queueJobId, piVersion = null } = {}) {
		const jobDir = mkdtempSync(join(jobsDir, "job-"));
		// What `cleanup` needs to retain this run's directory, stamped here because this is the only place
		// that holds all three at once. Applied to the RESULT rather than mutated in, so a preparer's
		// `{ outcome: "policy" }` refusal -- which carries no jobDir -- is passed through untouched.
		const sandbox = { jobId: queueJobId ?? null, kind: job.kind ?? null, image: resolveJobImage(job, jobImage) };
		if (job.kind === "local") {
			// Harness text above, operator DATA below: the fixed pointer line names /job/event.json so a
			// flow can discover the trigger context (mirroring the github prompt, which names the same
			// file); nothing in-container reads it otherwise. The pointer sits AFTER the flow hint and
			// BEFORE the operator's task, which stays verbatim (CONST-ISSUE-TEXT-IS-DATA).
			const pointer = "Context about this run -- its trigger and schedule -- is in /job/event.json.\n\n";
			const task = job.flow
				? `Use the "${job.flow}" skill for this task.\n\n${pointer}${job.task ?? ""}`
				: `${pointer}${job.task ?? ""}`;
			const event = localEventContext(job, queueJobId, findPreviousRun);
			return discardOnPolicy(stampSandbox(await prepareLocal({ folder: job.folder, task, jobDir, event }), sandbox), jobDir);
		}
		const prepare = preparers[job.kind];
		if (prepare) {
			const host = forgeFor?.(job)?.host;
			return discardOnPolicy(
				stampSandbox(
					await prepare(job, token, {
						jobDir,
						resolveDefaultBranchSha: host?.resolveDefaultBranchSha,
						// The head ref a pull/merge-request job keys on comes from the FORGE API, never the webhook
						// payload: an issue_comment on a PR carries no head at all, and a payload-supplied head repo
						// is attacker-controlled data that must not decide which transcript a job is handed.
						resolvePullRequestHead: host?.resolvePullRequestHead,
						resolveSession,
						piVersion,
					}),
					sandbox,
				),
				jobDir,
			);
		}
		throw new Error(`unknown job kind: ${job.kind}`);
	};
}

/**
 * The trigger context a local job's `/job/event.json` carries (INT-CONTAINER-JOB-INPUTS). Source is
 * derived from the job data alone: a chained child carries `parentJobId`/`chainDepth` (queue.mjs sets
 * them only on chains), a scheduled job carries the cron-only `trigger` field (schedules.mjs), and
 * everything else is the operator's own `pi-dispatch run` -- manual.
 *
 * For cron, the scheduled-for instant comes from BullMQ's deterministic `repeat:<id>:<millis>` jobId
 * (DES-CRON-VIA-BULLMQ-SCHEDULER) -- the wiring injects it as `queueJobId`. When the id is missing or
 * unparseable the lookup is SKIPPED: both `scheduledFor` and `previousRunAt` are null, never a guess.
 */
function localEventContext(job, queueJobId, findPreviousRun) {
	if (job.parentJobId !== undefined || job.chainDepth !== undefined) return { source: "chain" };
	if (job.trigger) {
		const millis = scheduledForMillis(queueJobId);
		return {
			source: "cron",
			trigger: job.trigger,
			scheduledFor: millis === null ? null : new Date(millis).toISOString(),
			previousRunAt: millis === null ? null : (findPreviousRun({ schedulerId: job.trigger.id, beforeMillis: millis }) ?? null),
		};
	}
	return { source: "manual" };
}

/** Parse the millis out of a `repeat:<id>:<millis>` BullMQ scheduled jobId, or null. */
function scheduledForMillis(queueJobId) {
	if (typeof queueJobId !== "string" || !queueJobId.startsWith("repeat:")) return null;
	const tail = queueJobId.slice(queueJobId.lastIndexOf(":") + 1);
	if (tail === "") return null;
	const millis = Number(tail);
	return Number.isFinite(millis) ? millis : null;
}

/**
 * Attach the sandbox stamp to a successful prepare, and to nothing else.
 *
 * A preparer's determinate refusal (`{ outcome: "policy", reason: "sha-gone" }`) carries no `jobDir`, so
 * it is returned verbatim: there is no directory to retain and the processor's policy branch reads the
 * same object it always did.
 */
function stampSandbox(prepared, sandbox) {
	if (!prepared?.jobDir) return prepared;
	return { ...prepared, sandbox };
}

/**
 * Remove the mkdtemp'd job dir when the preparer REFUSED, because nothing downstream will.
 *
 * A determinate refusal carries no `jobDir` (see stampSandbox), and both teardown paths -- `cleanup`
 * and `makeCleanup`'s retention branch -- guard on `prepared?.jobDir`. So the directory this function
 * created two dozen lines up, which by then may hold a partial clone, was simply left on disk: one
 * per refusal, forever. That has been true of `sha-gone` since it shipped and was only ever invisible
 * because refusals are rare; issue #60 adds cap refusals that a misconfigured repo hits on EVERY
 * delivery, which turns a slow leak into a fast one.
 *
 * Deliberately not folded into stampSandbox: that function's job is to decide what a RESULT carries,
 * and a filesystem side effect hidden inside it would be the kind of thing the next reader has to
 * discover. Deliberately `rmSync` rather than the async `rm`, so the directory is gone before the
 * refusal is returned and no teardown ordering has to be reasoned about.
 */
function discardOnPolicy(prepared, jobDir) {
	if (prepared?.outcome !== "policy") return prepared;
	rmSync(jobDir, { recursive: true, force: true });
	return prepared;
}

/** Remove a per-job dir after the run. The workspace (the operator's folder) is never touched here. */
export async function cleanup(prepared) {
	if (prepared?.jobDir) await rm(prepared.jobDir, { recursive: true, force: true });
}

/**
 * The teardown the worker injects: retain this run's directory for a bounded window instead of deleting
 * it, so `pi-dispatch sandbox` can re-open it (REQ-RESURRECTABLE-SANDBOX).
 *
 * With the window at 0 -- the documented "off" -- this IS `cleanup`, by the same `rm` on the same path,
 * so a deployment that does not want retention keeps today's behaviour exactly rather than a
 * near-equivalent of it. `retainJobDir` owns the other branch entirely, including removing `jobDir` on
 * every failure path, which is why there is no `rm` here to pair with it.
 *
 * NEVER THROWS -- the processor already swallows this in a `finally`, and a retention fault must not be
 * the thing that turns a paid, completed run into a failure.
 */
export function makeCleanup({ sandboxDir, retentionHours = 0, log = () => {} } = {}) {
	return async function cleanupWithRetention(prepared) {
		if (!prepared?.jobDir) return;
		if (!sandboxDir || retentionHours <= 0) {
			await cleanup(prepared);
			return;
		}
		retainJobDir(prepared, { sandboxDir, log });
	};
}

/**
 * The per-forge preparer map `makePrepareWorkspace` dispatches on.
 *
 * Every forge shares `prepareGithubWorkspace`: the askpass helper, the hardening flags, the gone-SHA
 * markers, the pinned detached checkout and the read-only event.json are facts about git and about this
 * project, not about GitHub. Only two things differ, and both are injected -- where the clone comes from,
 * and how the agent's envelope is phrased. A second copy of the clone path would be a second place to fix
 * a clone bug, and the copy that did not get fixed would be the one nobody was looking at.
 *
 * Exported so the wiring is assertable: a job cloning from the wrong forge is a silent failure -- the URL
 * simply would not exist, or worse, would.
 */
export function makeForgePreparers({ gitlabApiUrl = null, forgejoApiUrl = null, azureOrgUrl = null, prepareForge = prepareGithubWorkspace } = {}) {
	return {
		github: prepareForge,
		gitlab: (job, token, opts) =>
			prepareForge(job, token, {
				...opts,
				remoteUrlFor: (j) => gitlabRemoteUrl(gitlabApiUrl, j.repo),
				buildPrompt: buildGitLabPrompt,
			}),
		forgejo: (job, token, opts) =>
			prepareForge(job, token, {
				...opts,
				remoteUrlFor: (j) => forgejoRemoteUrl(forgejoApiUrl, j.repo),
				buildPrompt: buildForgejoPrompt,
			}),
		azure: (job, token, opts) =>
			prepareForge(job, token, {
				...opts,
				// Azure's clone URL is `<org>/<project>/_git/<repo>` -- built from the job's structured scope,
				// not from its `repo` label, because that label is `project/repo` and reassembling a URL from
				// a display string is how the wrong repository gets cloned.
				remoteUrlFor: (j) => azureRemoteUrl(azureOrgUrl, j),
				buildPrompt: buildAzurePrompt,
			}),
	};
}
