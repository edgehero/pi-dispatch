/**
 * The rule for a run record's `earlier` (issue #599, INT-RUN-HISTORY-FILE-CONTRACT), in a module that imports only the
 * worker name rule, so the record writer (run-history.mjs, which re-exports both names) and the capacity report, a pure
 * reader, rebuild it with ONE validator.
 */

import { WORKER_NAME_RE } from "./worker-name.mjs";

const recordInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The most earlier attempts a record carries: the newest are kept. */
export const EARLIER_MAX = 4;

/** One earlier attempt as a record carries it, or null: a worker name, two canonical ISO instants in order, two sizes. */
function earlierEntry(e) {
	if (e === null || typeof e !== "object" || Array.isArray(e)) return null;
	const instant = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v ? v : null);
	const startedAt = instant(e.startedAt);
	const endedAt = instant(e.endedAt);
	if (typeof e.host !== "string" || !WORKER_NAME_RE.test(e.host) || startedAt === null || endedAt === null || Date.parse(endedAt) < Date.parse(startedAt)) return null;
	return { host: e.host, startedAt, endedAt, memMiB: recordInt(e.memMiB), cpuCenti: recordInt(e.cpuCenti) };
}

/** A record's `earlier`, rebuilt: the valid entries, the newest `EARLIER_MAX` of them, or null when none is. */
export function recordedEarlier(list) {
	if (!Array.isArray(list)) return null;
	const kept = list.map(earlierEntry).filter((e) => e !== null).slice(-EARLIER_MAX);
	return kept.length > 0 ? kept : null;
}
