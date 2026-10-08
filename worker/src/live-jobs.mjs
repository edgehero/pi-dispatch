/**
 * The running jobs a host row publishes (issue #599, phase 2, INT-HOST-REGISTRY-CONTRACT `jobs`), written by the
 * worker's beat and read back by every reader of the row: one module for both halves, so the writer can never publish
 * a shape the reader drops, and pure (no clock, no filesystem, no Valkey), so the capacity report and the admin bundle
 * can import it.
 *
 * WHAT IS LISTED. Every job this host's processors hold a slot for right now (the in-flight map, `makeRunningJobs` in
 * index.mjs), and every ORPHAN of the host budget (a job whose container's stop did not take, or a container left
 * from before the worker started), flagged `o: 1`. An orphan comes from the budget's ledger only, because only the
 * budget keeps watching such a container until the runtime says it is gone; without a budget nothing does, and the
 * job leaves the list when its processor ends. A job listed by both is listed once, as running.
 *
 * WHY THIS MEETS THE CONTENT RULE (names, integers and digests). Every field is an integer, the fixed 1, or an id:
 *   - `id` is the job id, the one every run record already carries in `jobId` and `runs:rec:<id>` already puts in
 *     Valkey. Each shape the project mints is charset-checked by construction: `gh-`, `gl-`, `fj-` and the other forge
 *     prefixes with the forge's delivery id (and `-r<n>` for a replica), `repeat:<trigger id>:<millis>` and
 *     `manual:<trigger id>:<millis>` (a trigger id is `[A-Za-z0-9._-]+`, the loader's rule), `local-<hex>`,
 *     `chain-<hex>`, and a budget orphan's `container:<name>`. A delivery id is a forge's header value and is not
 *     checked by the receiver, so the id is held to `LIVE_JOB_ID_RE` HERE, and one outside it (or longer than 128
 *     characters) is published as its digest (`sha256:<16 hex>`), the rule's own idiom for a value that must be
 *     carried and cannot satisfy it. No quote, backslash, slash or control character can reach the JSON, so the
 *     writer's path-shape check never refuses the field.
 *   - `p` is a project id (`isProjectId`) or null; `runs:rec:*` already carries project ids.
 *   - `m`, `c` and `at` are integers (MiB, hundredths of a CPU, epoch millis), `o` is 1.
 *
 * ORDER AND SIZE. Oldest first (by `at`, then id), at most `LIVE_JOBS_MAX`: the jobs that have held a slot longest
 * carry the most busy time and are the ones an operator looks for. The rest are counted in `jobsMore`, never dropped
 * silently. A full list is about 7 KiB, once per beat.
 */

import { createHash } from "node:crypto";
import { isProjectId } from "./project-id.mjs";

/** The most jobs one row lists; the rest are counted (`jobsMore`). */
export const LIVE_JOBS_MAX = 32;
/** A job id as published: the charset every id shape the project mints is in, at most 128 characters. */
export const LIVE_JOB_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** The most a `jobs` value may be before a reader declines to parse it: 32 entries at their longest fit well inside. */
export const LIVE_JOBS_MAX_BYTES = 16 * 1024;

const positiveInt = (v) => Number.isSafeInteger(v) && v > 0;

/** A job id as it may be published: itself when inside `LIVE_JOB_ID_RE`, else its digest; null for no id. */
export function publishedJobId(id) {
	if (typeof id !== "string" || id === "") return null;
	if (LIVE_JOB_ID_RE.test(id)) return id;
	return `sha256:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/**
 * The list a row publishes, before the cap: `[{ id, p, m, c, at, o? }]`, oldest first. `running` is the in-flight
 * map's entries (`{ id, project, memMiB, cpuCenti, at }`), `budgetEntries` the host budget's ledger (`entries()`), of
 * which only orphans are taken. An entry with no id or no instant is left out and counted in `skipped`.
 */
export function liveJobsOf({ running = [], budgetEntries = [] } = {}) {
	const out = [];
	const seen = new Set();
	let skipped = 0;
	const push = (e, orphan) => {
		const id = publishedJobId(e?.id);
		if (id === null || !Number.isSafeInteger(e?.at) || e.at <= 0) {
			skipped++;
			return;
		}
		if (seen.has(id)) return; // one job, two pickups (or running and orphaned): listed once
		seen.add(id);
		out.push({ id, p: isProjectId(e.project) ? e.project : null, ...(positiveInt(e.memMiB) ? { m: e.memMiB } : {}), ...(positiveInt(e.cpuCenti) ? { c: e.cpuCenti } : {}), at: e.at, ...(orphan ? { o: 1 } : {}) });
	};
	// Running first, so a job both running and in the ledger as an orphan (it cannot be: the gate defers it) reads as running.
	for (const e of Array.isArray(running) ? running : []) push(e, false);
	for (const e of Array.isArray(budgetEntries) ? budgetEntries : []) if (e?.orphan) push(e, true);
	out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { jobs: out, skipped };
}

/**
 * The two row fields: `jobs`, the JSON of at most `LIVE_JOBS_MAX` entries, and `jobsMore`, how many running jobs are
 * not in it (past the cap, or with no id or instant), both strings as a row holds them.
 */
export function liveJobsFields(list) {
	const { jobs, skipped } = list;
	const kept = jobs.slice(0, LIVE_JOBS_MAX);
	return { jobs: JSON.stringify(kept), jobsMore: String(jobs.length - kept.length + skipped) };
}

/**
 * A row's `jobs` read back, through a per-field allowlist: `{ jobs, dropped }`, `jobs` an array of `{ id, p, m, c, at,
 * o }` (`m`, `c` null when not published, `o` true for an orphan), or null when the field is absent, empty, too long
 * or not a JSON list. An entry that is not an object, or whose id, project, size, instant or flag is not the shape
 * above, is dropped and counted; past `LIVE_JOBS_MAX` entries the rest are counted too. A list this function already
 * read (an array, its `o` a boolean) reads back the same, so a caller may hand either form. Never throws: a row is
 * another host's text.
 */
export function parseLiveJobs(raw) {
	if (Array.isArray(raw)) return parseList(raw);
	if (typeof raw !== "string" || raw === "" || raw.length > LIVE_JOBS_MAX_BYTES) return { jobs: null, dropped: 0 };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { jobs: null, dropped: 0 };
	}
	return Array.isArray(parsed) ? parseList(parsed) : { jobs: null, dropped: 0 };
}

const optionalSize = (v) => (v === undefined || v === null ? null : positiveInt(v) ? v : undefined);

function parseList(list) {
	const jobs = [];
	let dropped = 0;
	for (const e of list) {
		if (jobs.length >= LIVE_JOBS_MAX) {
			dropped++;
			continue;
		}
		const ok = e !== null && typeof e === "object" && !Array.isArray(e);
		const m = ok ? optionalSize(e.m) : undefined;
		const c = ok ? optionalSize(e.c) : undefined;
		if (!ok || typeof e.id !== "string" || !LIVE_JOB_ID_RE.test(e.id) || !(e.p === undefined || e.p === null || isProjectId(e.p)) || m === undefined || c === undefined || !positiveInt(e.at) || !(e.o === undefined || e.o === 1 || typeof e.o === "boolean")) {
			dropped++;
			continue;
		}
		jobs.push({ id: e.id, p: e.p ?? null, m, c, at: e.at, o: e.o === 1 || e.o === true });
	}
	return { jobs, dropped };
}

/**
 * A row's `jobsMore` read back: a non-negative integer, or null when absent or not one. A reader adds `dropped` from
 * `parseLiveJobs` to it: a listed job it could not read is a running job it does not count.
 */
export function parseJobsMore(raw) {
	if (Number.isSafeInteger(raw) && raw >= 0) return raw;
	return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}
