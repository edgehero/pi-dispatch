import * as nodeFs from "node:fs";
import { join } from "node:path";
import { PLAN_MAX_BYTES, parsePlan } from "./priorities.mjs";

/**
 * The plan collector (issue #505, INT-OUTBOX-CONTRACT's second file, DES-JOB-OUTBOX-CHAINING's second kind): the host-side
 * reader of a completed portfolio job's `/outbox/priorities.json`, which it hands to `applyPlan` (allocation.mjs) with
 * the writer `{ kind: "portfolio-job", jobId, triggerId }`.
 *
 * A SEPARATE FILE, never a `request-<n>.json` with a `type` key: a plan would then share the chain count cap
 * (`PI_CHAIN_MAX_PER_JOB`), and a worker too old to know the key would refuse it as `chain-bad-flow-name`, a reason that
 * says nothing about plans. An older worker never opens a file it does not know.
 *
 * NEVER THROWS, the rule `makeCollectChain` keeps and for its reason: this runs after a completed, PAID container, so a
 * throw would turn that completion into a retry and pay again for one answer (CONST-RETRY-INFRA-ONLY). Every fault is
 * caught, logged as a fixed token, and recorded as `plan-collect-error`. A refused plan is a recorded outcome of a
 * completed job, never a failed job.
 *
 * The ladder, failing closed at the first miss (each refusal a fixed token, `PLAN_COLLECT_REASONS`):
 *   1. No `/outbox/priorities.json` (or no outbox: a forge job has none): nothing happens and the record says
 *      `plan: null`. An unflagged job that writes no plan is byte-identical to before. Only ENOENT and ENOTDIR mean
 *      "no file"; any other answer (an outbox the job made unreadable) is judged by rung 2 first: a job that was never a
 *      portfolio job then has no plan (`null`), and a confirmed one meets rung 4, which reads it again.
 *   2. Portfolio authority, `plan-not-portfolio`: the job was a portfolio job AT PICKUP (the processor's `portfolio`
 *      decision: the flag on the data, a cron `trigger`, no chain field, and the live file), it still has the flag, a
 *      trigger and no chain field on its data, prepare AGREED (it wrote the snapshot, `prepared.portfolio`), and the
 *      LIVE triggers file still flags that same entry NOW. All three, so an operator who removes the flag while the job
 *      runs is obeyed, a job that ran without the facts writes no plan, and a flag added back mid-run grants nothing to
 *      a job that started as an ordinary one.
 *      WHERE it is recorded depends on who was refused. A job that was never a portfolio job at pickup (a manual run, a
 *      chained child, an unflagged cron job) is refused in its run record and its log line ONLY: no audit row and
 *      no `alloc:log` row, because `alloc:log` holds 500 rows, is the panel's revert history and the next manager's
 *      `lastAttempt`, and any local job could otherwise wipe it one row per run. A job the pickup confirmed whose flag
 *      went away later (at prepare or at collection) is the trigger's own attempt, so it is recorded like every other
 *      refusal below.
 *   3. Size, `plan-oversize`: more than 16 KiB (`PLAN_MAX_BYTES`), from `lstat`, before anything is opened.
 *   4. A regular file, `plan-not-regular-file`: `lstat`, which never follows a link, so a symlink is refused on its own
 *      inode. Then the file is OPENED with `O_NOFOLLOW` (a link swapped in after the lstat fails with ELOOP) and
 *      `O_NONBLOCK` (a FIFO swapped in cannot hang the worker on open), and the OPEN descriptor is `fstat`ed: regular and
 *      within the size again, so what is read is what was judged. At most `PLAN_MAX_BYTES + 1` bytes are read, so a
 *      file that grows after the fstat is still refused as oversize. Any other fs fault is `plan-unreadable`.
 *   5. JSON with an object root, `plan-parse-error`.
 *   6. `applyPlan`, which judges the plan (`plan-invalid` naming one field) and applies the ladder of
 *      DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE (`delegation-off` through `plan-busy`).
 * Rungs 2 (as above) to 5 are recorded by `recordRefusal` (a file row and an `alloc:log` row, the reason and nothing of
 * the body); rung 6 records its own. So no refusal of a portfolio job is silent, and the next snapshot's `lastAttempt`
 * tells the next manager run. `plan-collect-error` means the outcome is UNKNOWN: a fault after the compare-and-set was
 * sent (a lost reply) may hide a plan that applied, so the record carries the plan's id when it could be computed, and
 * `alloc:plan` and the audit file are the truth.
 *
 * Returns the record's `plan`: `{ outcome, reason, planId, clamped }` (`outcome` one of `applied`, `duplicate`,
 * `refused`), or null when there was no file. The worker log line is `plan_collected { jobId, outcome, reason }`.
 */

/** The collector's own refusals, in ladder order, and the catch-all for a fault inside it. */
export const PLAN_NOT_PORTFOLIO = "plan-not-portfolio";
export const PLAN_OVERSIZE = "plan-oversize";
export const PLAN_NOT_REGULAR_FILE = "plan-not-regular-file";
export const PLAN_UNREADABLE = "plan-unreadable";
export const PLAN_PARSE_ERROR = "plan-parse-error";
export const PLAN_COLLECT_ERROR = "plan-collect-error";
export const PLAN_COLLECT_REASONS = Object.freeze([PLAN_NOT_PORTFOLIO, PLAN_OVERSIZE, PLAN_NOT_REGULAR_FILE, PLAN_UNREADABLE, PLAN_PARSE_ERROR, PLAN_COLLECT_ERROR]);

/** The plan file's name in `/outbox`. */
export const PLAN_FILE = "priorities.json";

const HEX16_RE = /^[0-9a-f]{16}$/;
const TOKEN_RE = /^[a-z][a-z0-9-]{0,63}$/;

class Refusal extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
}

/**
 * Read the plan file under rungs 3 and 4, or throw a `Refusal`. Returns the text. `fs` needs `lstatSync`, `openSync`,
 * `fstatSync`, `readSync`, `closeSync` and `constants`.
 */
function readPlanFile(fs, path) {
	const pre = fs.lstatSync(path);
	if (pre.size > PLAN_MAX_BYTES) throw new Refusal(PLAN_OVERSIZE);
	if (!pre.isFile()) throw new Refusal(PLAN_NOT_REGULAR_FILE);
	const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants ?? nodeFs.constants;
	let fd;
	try {
		fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (error) {
		// ELOOP: a link was swapped in after the lstat. ENXIO: a socket. Both are files of the wrong kind.
		if (error?.code === "ELOOP" || error?.code === "ENXIO") throw new Refusal(PLAN_NOT_REGULAR_FILE);
		throw error;
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) throw new Refusal(PLAN_NOT_REGULAR_FILE);
		if (st.size > PLAN_MAX_BYTES) throw new Refusal(PLAN_OVERSIZE);
		const buf = Buffer.alloc(PLAN_MAX_BYTES + 1);
		let got = 0;
		for (;;) {
			const n = fs.readSync(fd, buf, got, buf.length - got, null);
			if (n === 0) break;
			got += n;
			if (got > PLAN_MAX_BYTES) throw new Refusal(PLAN_OVERSIZE);
		}
		return buf.subarray(0, got).toString("utf8");
	} finally {
		try {
			fs.closeSync(fd);
		} catch {}
	}
}

/**
 * Build the collector. `allocation` is the worker's allocation state (`applyPlan`, `recordRefusal`), `governing()` this
 * host's `{ envelope, digest }` or null, `projects()` the live parsed projects.json, `checkPortfolioFlag(jobData)` the
 * live-file check (triggers-file.mjs). `now` is injected.
 */
export function makeCollectPlan({ allocation, governing = () => null, projects = () => [], checkPortfolioFlag = async () => false, fs = nodeFs, log = () => {}, now = () => new Date() }) {
	return async function collectPlan({ job, prepared, portfolio = false }) {
		const data = job?.data ?? {};
		const jobId = job?.id ?? null;
		const result = (outcome, reason, planId = null, clamped = false) => {
			log("plan_collected", { jobId, outcome, reason });
			return { outcome, reason, planId: typeof planId === "string" && HEX16_RE.test(planId) ? planId : null, clamped: clamped === true };
		};
		const writer = { kind: "portfolio-job", jobId, triggerId: typeof data.trigger?.id === "string" ? data.trigger.id : null };
		// `audit: false` for a job that was never a portfolio job: the run record and the log line only.
		const refuse = async (reason, at, { audit = true } = {}) => {
			if (!audit) return result("refused", reason);
			try {
				await allocation.recordRefusal({ writer, reason, digest: governing()?.digest ?? null, now: at });
			} catch (error) {
				// The run record still says it; the audit row is what is lost, and the line says so.
				log("plan_refusal_row_lost", { jobId, reason, code: typeof error?.code === "string" ? error.code : "error" });
			}
			return result("refused", reason);
		};
		let at;
		let text = null;
		try {
			at = now();
			if (data.kind !== "local" || typeof prepared?.jobDir !== "string") return null;
			const path = join(prepared.jobDir, "outbox", PLAN_FILE);
			// Rung 1: no file, no plan. lstat, so a dangling link is a file that is there (and refused below), not "none".
			// Any other error is NOT judged here: the authority rung comes first, and rung 4 reads it again.
			let present = true;
			try {
				fs.lstatSync(path);
			} catch (error) {
				if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
				present = false;
			}

			// Rung 2: the pickup decision, prepare and the live file, all three.
			const shaped = data.portfolio === true && data.trigger !== undefined && data.parentJobId === undefined && data.chainDepth === undefined;
			// A job that was never a portfolio job, with no file PROVEN present (its outbox could not be read), has no plan:
			// the record stays `plan: null`, so an unflagged job that writes no plan is byte-identical whatever its outbox.
			if (portfolio !== true || !shaped) return present ? await refuse(PLAN_NOT_PORTFOLIO, at, { audit: false }) : null;
			if (prepared.portfolio !== true) return await refuse(PLAN_NOT_PORTFOLIO, at);
			const live = await Promise.resolve()
				.then(() => checkPortfolioFlag(data))
				.catch(() => false);
			if (live !== true) return await refuse(PLAN_NOT_PORTFOLIO, at);

			// Rungs 3 and 4.
			try {
				text = readPlanFile(fs, path);
			} catch (error) {
				if (error instanceof Refusal) return await refuse(error.reason, at);
				return await refuse(PLAN_UNREADABLE, at);
			}

			// Rung 5. Never the parser's message: it quotes the agent's text.
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				return await refuse(PLAN_PARSE_ERROR, at);
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return await refuse(PLAN_PARSE_ERROR, at);

			// Rung 6: the plan's own judgement and the apply ladder, recorded by applyPlan itself.
			const g = governing() ?? null;
			const applied = await allocation.applyPlan({ envelope: g?.envelope ?? null, digest: g?.digest ?? null, projects: projects(), text, writer, now: at });
			const reason = typeof applied?.reason === "string" && TOKEN_RE.test(applied.reason) ? applied.reason : null;
			if (applied?.outcome === "applied") return result("applied", null, applied.planId, applied.clamped);
			if (applied?.outcome === "duplicate") return result("duplicate", reason, applied.planId);
			// `apply-failed` (a CAS lost to another writer) is a refusal as `plan-stale`: the plan did not apply.
			return result("refused", reason ?? PLAN_COLLECT_ERROR, applied?.planId ?? null);
		} catch (error) {
			// Infrastructure inside applyPlan (Valkey, the audit file) or a defect here: logged by its code, recorded as a
			// refusal, and the completed job stays completed.
			log("plan_collect_failed", { jobId, code: typeof error?.code === "string" ? error.code : "error" });
			// The plan's id when the text is in hand, so a plan that applied behind a lost reply can still be found. The id
			// is a property of the text alone (INT-PRIORITIES-PLAN-CONTRACT), so it is computed without the envelope and with
			// the widest plan life, which only the validity of `validUntil` depends on.
			let planId = null;
			try {
				if (typeof text === "string") planId = parsePlan(text, { now: at, maxPlanDays: 366 }).id ?? null;
			} catch {}
			return result("refused", PLAN_COLLECT_ERROR, planId);
		}
	};
}
