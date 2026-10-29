/** Runtime names shared with operator guidance without importing runtime or provider implementations. */
import { createHash } from "node:crypto";

/**
 * `pi-job-` -- the container-name namespace, and a LOAD-BEARING string rather than a prefix chosen for
 * readability. TWO sweeps match it as a SUBSTRING, both at boot in `start.mjs`: the container reaper's
 * `docker ps` filter and the network reaper's `docker network ls` filter. They share the NAME rule
 * (`isJobNamespace`) and deliberately not the STATE question -- see `reapNetwork` for why one lists running
 * containers and the other asks about members in any state. The sandbox tooling is the
 * counterpart rather than a third sweep -- it names itself `pi-sandbox-` precisely to stay OUTSIDE this
 * namespace, so a worker restart cannot tear down the shell an operator is sitting in, and it reaps its own
 * by job id rather than by name.
 *
 * Exported and imported rather than re-typed at each site for the reason `CONTAINER_GLOBAL_PI_DIR` is: the
 * namespace and the filters that sweep it are ONE fact, and two literals in two modules is how a rename
 * lands in the producer and not in the reaper, leaving every crashed worker's containers behind forever with
 * both test suites green.
 */
export const JOB_NAME_PREFIX = "pi-job-";

/**
 * `pi-job-<jobId>`. The name a running job answers to, for `docker stop` on the 30-minute timeout, for the
 * per-job egress network derived from it, and for the reaper's filter.
 *
 * Sanitised to the runtimes' own name rule, `[a-zA-Z0-9][a-zA-Z0-9_.-]*` (docker's `RestrictedNameChars`, and
 * Podman's, measured), every other character becoming `_`, as `sanitizeJobId` does for file names. It said here that
 * BullMQ ids are already that shape, and a cron job's is not: the job scheduler mints `repeat:<schedulerId>:<millis>`,
 * so `pi-job-repeat:...` was refused at create (exit 125, measured on Podman 5.8.1) and so was its `-net` network, and
 * every cron job ended `container-never-started` before it ever ran (issue #435). The prefix supplies the first
 * character. Deterministic, because every path that must find the container again (the timeout's stop, the cancel,
 * the network, the log sink) asks this function for the name rather than deriving it. Not injective: `repeat:a:1`
 * and a literal `repeat_a_1` share a name. BullMQ ids are unique per queue and no producer here mints an id with `_`
 * where a scheduler id has `:`, so it is a residual rather than a collision anything reaches.
 */
export function jobContainerName(jobId) {
	return `${JOB_NAME_PREFIX}${String(jobId).replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * A sandbox's name for a job's container name. OpenShell refuses a sandbox name longer than 19 characters (measured:
 * "name exceeds maximum length (34 > 19)"), and a job's container name is `pi-job-<the queue's job id>`, routinely
 * longer, so the sandbox is named by a hash of it: `pi-job-s` and 11 hex digits, 19 exactly, still inside the job
 * namespace every sweep matches. A name already of that shape is its own sandbox name, so what `list` returned (a
 * leftover the host budget seeded by its sandbox name) maps to itself, and every step, the stop and the gone-check
 * included, goes through this one function.
 */
export const SANDBOX_NAME = /^pi-job-s[0-9a-f]{11}$/;
export function sandboxNameOf(containerName) {
	if (SANDBOX_NAME.test(containerName)) return containerName;
	return `${JOB_NAME_PREFIX}s${createHash("sha256").update(String(containerName)).digest("hex").slice(0, 11)}`;
}
