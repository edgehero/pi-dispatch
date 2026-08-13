/**
 * Select the worker's cron schedules from the unified triggers file (DES-CRON-VIA-BULLMQ-SCHEDULER,
 * issue #20). The worker owns exactly the `on.type:"cron"` entries; the receiver owns the webhook types.
 * The shared validator (`triggers.mjs`) parses and validates the WHOLE file fail-loud -- the diagonal,
 * the `id` charset, cron field count -- so this module only selects the cron subset, checks that each
 * `run.folder` exists on disk (the one fs-dependent check the pure validator cannot make), and normalizes
 * to the shape the caller hands to BullMQ's `upsertJobScheduler` (`schedulerId`, `name`, `pattern`, and
 * the `data`/`opts` job template).
 *
 * Fail-loud, like config.mjs: a misconfigured triggers file makes the worker refuse to start with a clear
 * message rather than upserting a broken scheduler that silently never fires. Every load-time rejection is
 * a `configError` so the CLI/entry prints it cleanly and exits non-zero.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { configError } from "./config.mjs";
import { parseTriggers } from "./triggers.mjs";

/**
 * Parse, validate, and select the cron schedules from the triggers file named by `config.triggersFile`.
 * Returns `[]` when cron is disabled (`triggersFile` null/absent) -- a worker with no cron triggers is a
 * valid deployment. `readFileSync`/`existsSync` are injectable so tests exercise the full path with no
 * real filesystem.
 */
export function loadSchedules(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.triggersFile;
	if (path === null || path === undefined) return []; // cron disabled

	if (!existsSync(path)) {
		throw configError(`triggers file does not exist: ${path}`);
	}

	const triggers = parseTriggers(readFileSync(path, "utf8"), path);

	return triggers.filter((t) => t.on.type === "cron").map((t) => normalizeCronSchedule(t, path, existsSync));
}

function normalizeCronSchedule({ on, run }, path, existsSync) {
	// The pure validator already guaranteed a non-empty, `:`-free, charset-valid, unique id and a
	// well-formed pattern; folder existence is the one fs-dependent check it deferred to here.
	if (!existsSync(run.folder)) {
		throw configError(`cron trigger "${on.id}": run.folder does not exist: ${run.folder} (${path})`);
	}

	// `run.skillsDir` gets the same treatment, and for the same reason (REQ-PER-TRIGGER-SKILLS): the pure
	// validator cannot check a host path, because the RECEIVER parses the same file and may run on another
	// machine entirely. Absoluteness is checked here rather than there for a second reason -- `isAbsolute`
	// is OS-dependent, so a shared check would let a Windows worker and a Linux receiver disagree about the
	// same reviewed file. A broken cron trigger refuses the worker's BOOT rather than failing at 03:00.
	if (run.skillsDir !== undefined) {
		if (!isAbsolute(run.skillsDir)) {
			throw configError(`cron trigger "${on.id}": run.skillsDir must be an absolute path: ${run.skillsDir} (${path})`);
		}
		if (!existsSync(run.skillsDir)) {
			throw configError(`cron trigger "${on.id}": run.skillsDir does not exist: ${run.skillsDir} (${path})`);
		}
	}

	// Absent provider/model/maxTurns stay absent (undefined) so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT). data key order matches
	// queue.mjs -- the shape the processor's runJob consumes. The three per-trigger fields ride along the same
	// way and are kept adjacent: `github` (the scoped token flag), `packages` (load the operator-staged pi
	// packages) and `image` (which container image this schedule's jobs run in) -- INT-TRIGGERS-FILE-CONTRACT,
	// REQ-GLOBAL-PI-OVERLAY. `image` is a SELECTOR rather than an opt-in: absent does not mean "off", it means
	// the deployment default, resolved at job start (image-preflight.mjs). Undefined drops out at JSON
	// serialization, so an unflagged schedule stays byte-identical to today's. `trigger` is the one
	// cron-only field: it is carried into the local `/job/event.json` (INT-CONTAINER-JOB-INPUTS) so a
	// scheduled job can name its own trigger; the INT-TRIGGERS-FILE-CONTRACT byte-match acceptance is
	// amended for exactly this field.
	//
	// `command` (issue #189) is conditional like `skillsDir`, not present-and-undefined like flow/task,
	// and both spellings serve the same byte-identity: a flow trigger's stored repeatable must not grow a
	// key. A command trigger carries no flow/task at all (the validator enforces the XOR), so those two
	// keys hold undefined here and drop at JSON serialization -- the command schedule's data is exactly
	// kind/folder/command plus the shared fields.
	const data = { kind: "local", folder: run.folder, flow: run.flow, task: run.task, ...(run.command !== undefined && { command: run.command }), provider: run.provider, model: run.model, maxTurns: run.maxTurns, github: run.github, packages: run.packages, image: run.image, ...(run.skillsDir !== undefined && { skillsDir: run.skillsDir }), resume: run.resume, trigger: { id: on.id, pattern: on.pattern } };
	// Retention only; the deterministic repeat:<id>:<millis> jobId supplies dedup, so no jobId here, and
	// scheduler jobs are not retried (DES-CRON-VIA-BULLMQ-SCHEDULER) so no attempts/backoff.
	const opts = { removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } };

	return { schedulerId: on.id, name: "local", pattern: on.pattern, data, opts };
}
