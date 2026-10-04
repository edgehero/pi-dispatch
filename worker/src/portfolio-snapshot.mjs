/**
 * The portfolio snapshot, `/job/portfolio.json` (issue #505, INT-CONTAINER-JOB-INPUTS): what a flagged cron job's agent
 * reads to write a priorities plan (INT-PRIORITIES-PLAN-CONTRACT). A job container is queue-blind on purpose
 * (DES-JOB-OUTBOX-CHAINING), so the facts a project manager needs are written into its read-only `/job` instead: the
 * envelope's numbers, the applied split, what each project has spent in the window, and how its runs went.
 *
 * THE CONTENT RULE, and why it is strict. The agent reads this file as facts. So it holds ids, digests, integers, ISO
 * instants and fixed enum tokens only, plus two kinds of operator configuration: project ids and a member's label
 * (`github:acme/web` as projects.json stores it, or `local:<basename>` for a folder, the `targetFor` rule), and a label
 * holding a control, format, bidi or unassigned character is replaced by the member's ref. It holds no
 * issue text, no title, no task, no plan `reason` and no path: each is text an agent or a forge user wrote, and the next
 * manager run would read it as if it were a fact. Every value is rebuilt here from named fields, charset-checked, and
 * nothing is spread from a record, a state or a row.
 *
 * Money is integer micro-dollars, from the FLEET-WIDE counters (the `budget:usd:s:*` keys every host reserves and
 * settles in), so the numbers are complete on every host. A counter holds what was spent AND what running jobs still
 * hold: that is the number the next job is admitted against, so it is the one a manager should plan with. Run counts
 * come from the local run history merged with the Valkey run mirror; without a mirror (no `PI_WORKER_NAME`) they are
 * this host's alone, and `fleet.runsComplete` says so.
 */

import * as nodeFs from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { AUDIT_OUTCOMES, STATE_WRITERS, memberDollarKeyPrefix } from "./allocation.mjs";
import { dayKey, monthKey, weekKey } from "./budget.mjs";
import { OTHER, PLAN_FIELDS, PLAN_RULES, envelopeEntries, scopeRef } from "./priorities.mjs";
import { InfraRetry } from "./processor.mjs";
import { isProjectId } from "./project-id.mjs";
import { RUNS_INDEX_MAX, mergeRuns, readMirroredRuns } from "./run-mirror.mjs";
import { scopeDollarKeyPrefix } from "./scoped-limits.mjs";

/** The snapshot's shape version. */
export const PORTFOLIO_SNAPSHOT_VERSION = 1;
/** The largest snapshot written, in bytes. Over it the job is refused before it spends. */
export const PORTFOLIO_SNAPSHOT_MAX_BYTES = 64 * 1024;
/** The refusal of a job whose snapshot would be larger than `PORTFOLIO_SNAPSHOT_MAX_BYTES`. */
export const PORTFOLIO_SNAPSHOT_OVERSIZE = "portfolio-snapshot-oversize";
/** How far back `runs7d` counts. */
export const RUNS_WINDOW_DAYS = 7;
/** The run outcomes `runs7d` counts. */
export const RUN_OUTCOMES = Object.freeze(["completed", "policy", "failed"]);
/** The `byReason` key a reason that is not a plain token is counted under: the token rule, never the text. */
export const OTHER_REASON = "other";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HEX16_RE = /^[0-9a-f]{16}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// What a label may not hold: every control, format character (the bidi controls included), surrogate, private-use or
// unassigned code point, and the line and paragraph separators. Each can change what a reader sees.
const LABEL_REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

const asDate = (now) => (now instanceof Date ? now : new Date(now));
const instant = (value) => (typeof value === "string" && INSTANT_RE.test(value) && Number.isFinite(Date.parse(value)) ? value : null);
const micros = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The envelope window that holds `now`: `{ kind, start, end }`, `end` the first day after it (UTC dates). */
export function windowBounds(kind, now) {
	const d = asDate(now);
	const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	if (kind === "day") return { kind, start: ymd(day), end: ymd(day + DAY_MS) };
	if (kind === "week") {
		const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
		return { kind, start: ymd(monday), end: ymd(monday + 7 * DAY_MS) };
	}
	if (kind === "month") return { kind, start: ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), end: ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) };
	throw new TypeError(`unknown envelope window: ${kind}`);
}

/** A counter key of `prefix` for the envelope window holding `now`, by budget.mjs's own key functions. */
function windowKey(prefix, kind, now) {
	return kind === "day" ? dayKey(now, prefix) : kind === "week" ? weekKey(now, prefix) : monthKey(now, prefix);
}

/** A counter's value as micro-dollars: absent is 0 (nothing reserved yet), anything that is no integer is 0. */
function counterMicros(raw) {
	if (raw === null || raw === undefined) return 0;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * A member's label: a forge member as projects.json stores it, a folder as `local:<basename>` (never the path). A label
 * holding a character `LABEL_REFUSED` names, or longer than 200 code points, is the member's ref instead.
 */
export function memberLabel(member) {
	const label = isAbsolute(member) ? `local:${basename(member)}` : member;
	return LABEL_REFUSED.test(label) || [...label].length > 200 ? scopeRef(member) : label;
}

/** An empty `runs7d`. */
function emptyRuns() {
	return { completed: 0, policy: 0, failed: 0, byReason: {} };
}

/** `byReason` with its keys sorted, so the bytes do not depend on the order runs were read in. */
function sortedCounts(counts) {
	return Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
}

/**
 * Count runs by envelope entry: a record's `project` when the envelope names it, else `_other`. Only the three outcomes
 * and a reason that is a plain token are read; a reason that is not one counts under `other`, so no text a record could
 * carry (a planted title included) reaches the snapshot.
 */
function countRuns(records, entries, sinceMs) {
	const out = Object.fromEntries(entries.map((id) => [id, emptyRuns()]));
	for (const r of records) {
		const at = Date.parse(r?.endedAt ?? r?.startedAt ?? "");
		if (!Number.isFinite(at) || at < sinceMs) continue;
		if (!RUN_OUTCOMES.includes(r?.outcome)) continue;
		const id = isProjectId(r?.project) && r.project !== OTHER && entries.includes(r.project) ? r.project : OTHER;
		const row = out[id];
		row[r.outcome] += 1;
		if (r.reason !== null && r.reason !== undefined) {
			const key = typeof r.reason === "string" && TOKEN_RE.test(r.reason) ? r.reason : OTHER_REASON;
			row.byReason[key] = (row.byReason[key] ?? 0) + 1;
		}
	}
	for (const id of entries) out[id].byReason = sortedCounts(out[id].byReason);
	return out;
}

/** The applied plan as the snapshot shows it, or null for the neutral split (then a plan's `basis` is null). */
function planOf(state) {
	if (typeof state?.planId !== "string" || !HEX16_RE.test(state.planId)) return null;
	return {
		id: state.planId,
		writer: STATE_WRITERS.includes(state.writer) ? state.writer : null,
		appliedAt: instant(state.appliedAt),
		validUntil: instant(state.validUntil),
		clamped: state.clamped === true,
	};
}

/** The last attempt of this trigger's portfolio jobs, from an `alloc:log` row: enum tokens and an id only. */
function lastAttemptOf(row) {
	if (!row || typeof row !== "object") return null;
	const out = {
		at: instant(row.at),
		outcome: AUDIT_OUTCOMES.includes(row.outcome) ? row.outcome : null,
		reason: typeof row.reason === "string" && TOKEN_RE.test(row.reason) ? row.reason : null,
		planId: typeof row.planId === "string" && HEX16_RE.test(row.planId) ? row.planId : null,
	};
	if (PLAN_FIELDS.includes(row.field)) {
		out.field = row.field;
		out.rule = PLAN_RULES.includes(row.rule) ? row.rule : null;
	}
	return out;
}

/** When the next plan may apply: the last plan plus the interval, or null when no writer's plan has applied. */
function planAllowedAfter(state, envelope) {
	const last = Date.parse(state?.lastPlanAt ?? "");
	const hours = envelope?.delegation?.minIntervalHours;
	if (!Number.isFinite(last) || !Number.isInteger(hours)) return null;
	return new Date(last + hours * 60 * 60 * 1000).toISOString();
}

/**
 * Build the snapshot object. `envelope` and `digest` are this host's (envelope.mjs), `projects` the parsed projects.json,
 * `limits` the parsed scoped-limits.json (a member's spend is read from the key its matched row settles in,
 * `memberDollarKeyPrefix`, the one enforcement uses),
 * `allocation` `{ state, lastAttempt }` (the applied state `alloc:plan` and the newest `alloc:log` row of this trigger's
 * portfolio jobs), `redis` the client the counters are read from (one MGET), `runs` `{ records, complete }` (the merged
 * history) and `now` the clock. Throws on a Valkey fault; the caller turns that into an InfraRetry.
 */
export async function buildPortfolioSnapshot({ envelope, digest, projects = [], limits = null, allocation = {}, redis, runs = { records: [], complete: false }, now }) {
	const at = asDate(now);
	const state = allocation.state ?? null;
	const kind = envelope.window;
	const entries = envelopeEntries(envelope);
	const byId = new Map((Array.isArray(projects) ? projects : []).filter((p) => isProjectId(p?.id)).map((p) => [p.id, p]));

	// Every counter in ONE read: each entry's project key, then each member that has a repo share.
	const keys = [];
	const rows = entries.map((id) => {
		const projectKey = keys.push(windowKey(scopeDollarKeyPrefix(`project:${id}`), kind, at)) - 1;
		const members = id === OTHER ? [] : (byId.get(id)?.members ?? []).filter((m) => typeof m === "string" && m !== "");
		const memberRows = members
			.map((m) => {
				const ref = scopeRef(m);
				const weight = state?.repoWeights?.[id]?.[ref];
				return { ref, label: memberLabel(m), weight: Number.isInteger(weight) ? weight : null, allocation: micros(state?.repos?.[id]?.[ref]), key: Number.isInteger(weight) ? keys.push(windowKey(memberDollarKeyPrefix(m, { limits }), kind, at)) - 1 : null };
			})
			.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
		return { id, projectKey, memberRows };
	});
	const values = keys.length > 0 ? await redis.mget(...keys) : [];
	const counted = countRuns(Array.isArray(runs.records) ? runs.records : [], entries, at.getTime() - RUNS_WINDOW_DAYS * DAY_MS);

	return {
		version: PORTFOLIO_SNAPSHOT_VERSION,
		generatedAt: at.toISOString(),
		window: windowBounds(kind, at),
		envelope: {
			digest: typeof digest === "string" && HEX16_RE.test(digest) ? digest : null,
			totalMicros: envelope.totalMicros,
			maxStepPct: envelope.delegation?.maxStepPct ?? null,
			minIntervalHours: envelope.delegation?.minIntervalHours ?? null,
			maxPlanDays: envelope.delegation?.maxPlanDays ?? null,
			planAllowedAfter: planAllowedAfter(state, envelope),
		},
		plan: planOf(state),
		lastAttempt: lastAttemptOf(allocation.lastAttempt),
		projects: rows.map(({ id, projectKey, memberRows }) => ({
			id,
			floorMicros: envelope.floors[id],
			weight: Number.isInteger(state?.weights?.[id]) ? state.weights[id] : envelope.defaultWeights[id],
			allocationMicros: micros(state?.allocations?.[id]),
			spentMicros: counterMicros(values[projectKey]),
			members: memberRows.map((m) => ({ ref: m.ref, label: m.label, ...(m.weight === null ? {} : { weight: m.weight, allocationMicros: m.allocation, spentMicros: counterMicros(values[m.key]) }) })),
			runs7d: counted[id],
		})),
		fleet: { runsComplete: runs.complete === true },
	};
}

/**
 * The run records of this host's history (`PI_LOGS_DIR/*.json`) that ended at or after `sinceMs`: `{ records, complete }`.
 * A file older than the window by its mtime is not opened (a record is written when its run ends). Never throws: a
 * missing directory is no runs, and any other fault reads as `complete: false`.
 */
export function readLocalRuns({ logsDir, sinceMs, fs = nodeFs }) {
	let names;
	try {
		names = fs.readdirSync(logsDir);
	} catch (error) {
		return { records: [], complete: error?.code === "ENOENT" };
	}
	const records = [];
	let complete = true;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const st = fs.statSync(join(logsDir, name));
			if (!st.isFile() || st.mtimeMs < sinceMs) continue;
			const rec = JSON.parse(fs.readFileSync(join(logsDir, name), "utf8"));
			if (rec && typeof rec === "object" && typeof rec.jobId === "string") records.push(rec);
		} catch (error) {
			// A record reaped between the listing and the read is simply gone; anything else leaves the count short.
			if (error?.code !== "ENOENT") complete = false;
		}
	}
	return { records, complete };
}

/**
 * The prepare-time builder the wiring hands `prepareLocalWorkspace` (through `makePrepareWorkspace`), as
 * `(job) => null | { body } | { outcome: "policy", reason }`. Called only for a job the processor confirmed as a
 * portfolio job at pickup, and it confirms again here: the LIVE triggers file must still flag the job's entry
 * (`checkPortfolioFlag`), else nothing is written and null comes back. Null too when this host has no envelope any more:
 * the plan would be refused as `delegation-off`, so there is nothing true to show.
 *
 * Every Valkey read (the reconcile, `alloc:log`, the counters) that fails throws InfraRetry: the job has not reserved
 * anything yet, so it is retried rather than run on a snapshot with holes. The run mirror is a view and never throws; a
 * mirror that could not be read makes `runsComplete` false. A snapshot over 64 KiB is refused as
 * `portfolio-snapshot-oversize`, before any spend, and the log line names the project count.
 */
export function makePortfolioSnapshot({ checkPortfolioFlag, governing, projects = () => [], limits = () => null, allocation, redis, logsDir, mirror = false, readMirror = readMirroredRuns, fs = nodeFs, now = () => new Date(), log = () => {} }) {
	return async function portfolioSnapshot(job) {
		const flagged = await Promise.resolve()
			.then(() => checkPortfolioFlag(job))
			.catch(() => false);
		if (flagged !== true) {
			log("portfolio_snapshot_skipped", { why: "flag-not-live" });
			return null;
		}
		const g = governing?.() ?? null;
		if (!g?.envelope) {
			log("portfolio_snapshot_skipped", { why: "no-envelope" });
			return null;
		}
		const at = now();
		const sinceMs = at.getTime() - RUNS_WINDOW_DAYS * DAY_MS;
		let snapshot;
		try {
			const { state } = await allocation.reconcile({ envelope: g.envelope, digest: g.digest, now: at });
			if (!state) throw new Error("the applied state was written by a newer build");
			const last = await allocation.lastAttempt({ kind: "portfolio-job", triggerId: job?.trigger?.id });
			const local = readLocalRuns({ logsDir, sinceMs, fs });
			let mirrored = [];
			let complete = false;
			if (mirror) {
				const read = await readMirror(redis, { limit: RUNS_INDEX_MAX, sinceMs, now: () => at.getTime() });
				mirrored = read.runs;
				complete = local.complete && (read.degraded === "ok" || read.degraded === "off");
			}
			const records = mergeRuns(local.records, mirrored, { limit: Number.POSITIVE_INFINITY });
			snapshot = await buildPortfolioSnapshot({ envelope: g.envelope, digest: g.digest, projects: projects(), limits: limits(), allocation: { state, lastAttempt: last }, redis, runs: { records, complete }, now: at });
		} catch (error) {
			log("portfolio_snapshot_failed", { code: typeof error?.code === "string" ? error.code : "error" });
			throw new InfraRetry("the portfolio snapshot could not be read", { cause: error });
		}
		const body = JSON.stringify(snapshot, null, 2);
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > PORTFOLIO_SNAPSHOT_MAX_BYTES) {
			log("refused_portfolio_snapshot_oversize", { projects: snapshot.projects.length, bytes, max: PORTFOLIO_SNAPSHOT_MAX_BYTES });
			return { outcome: "policy", reason: PORTFOLIO_SNAPSHOT_OVERSIZE };
		}
		return { body };
	};
}
