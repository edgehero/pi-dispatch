import { readCapacityRecords } from "./capacity-records.mjs";
import { TOUCH_CAUSES, WAIT_END_REASONS, makeTouchStore } from "./touch-state.mjs";

const DAY = 86400_000;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const time = (v) => typeof v === "number" ? v : Date.parse(v ?? "");
const validTime = (v) => Number.isSafeInteger(v) && v >= 0;
const percentage = (touched, runs) => runs > 0 ? touched / runs * 100 : null;
const emptyCauses = () => TOUCH_CAUSES.map((cause) => ({ cause, count: 0 }));
const median = (values) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const scopeOf = (record) => record.touchScopeId ?? record.scopeId ?? `legacy:${record.kind ?? "unknown"}:${record.target ?? "unknown"}`;
// A configured project may be named "unassigned". Only this reserved query value means no project;
// it cannot collide with the ordinary project-id grammar and never enters a record or touch event.
export const ZERO_TOUCH_NO_PROJECT = "~";
export const zeroTouchProjectMatches = (recordProject, project) => project === null || project === undefined || (project === ZERO_TOUCH_NO_PROJECT ? recordProject === null || recordProject === undefined : recordProject === project);
const repoLabel = (record) => {
	if (record.kind === "local" || record.target?.startsWith("local:")) return record.target ?? "Local folder";
	return typeof record.target === "string" ? record.target.replace(/(?:#|!)\d+$/, "") : "Repository not recorded";
};

/**
 * A recount, independent of the console and of audit history. The requested interval is preserved even when only its
 * covered suffix is measurable. Legacy records cannot be presumed untouched: their missing lineage is not evidence.
 */
export function computeZeroTouch({ records = [], events = [], stops = [], fixes = [], groups = [], nowMs, windowDays = 30, coverage = {}, project = null, scopeId = null } = {}) {
	if (!validTime(nowMs)) throw new TypeError("nowMs must be an injected non-negative millisecond clock");
	if (![7, 30, 90].includes(windowDays)) throw new TypeError("windowDays must be 7, 30 or 90");
	const requestedFromMs = Math.max(0, nowMs - windowDays * DAY);
	const reasons = [...new Set(Array.isArray(coverage.reasons) ? coverage.reasons : [])];
	const byId = new Map();
	for (const r of records) {
		if (!r || !ID.test(r.jobId ?? "") || !validTime(time(r.endedAt)) || time(r.endedAt) > nowMs || ["zero-touch-grouping", "answer-draft"].includes(r.purpose)) continue;
		const prior = byId.get(r.jobId);
		if (!prior || time(prior.endedAt) < time(r.endedAt)) byId.set(r.jobId, r);
	}
	let fromMs = Math.min(nowMs, Math.max(0, Number.isFinite(coverage.fromMs) ? coverage.fromMs : nowMs));
	const legacy = [...byId.values()].filter((r) => r.touchTrackingVersion !== 1 && time(r.endedAt) >= fromMs);
	if (legacy.length) { fromMs = Math.min(nowMs, Math.max(fromMs, ...legacy.map((r) => time(r.endedAt) + 1))); if (legacy.some((r) => time(r.endedAt) >= requestedFromMs)) reasons.push("legacy-touch-history-incomplete"); }
	const selected = [...byId.values()].filter((r) => r.touchTrackingVersion === 1 && zeroTouchProjectMatches(r.project, project) && (scopeId === null || scopeOf(r) === scopeId));
	if (selected.some((r) => r.touchLineageSkipped === "source-unavailable" && time(r.endedAt) >= fromMs)) {
		// A resumed answer with an unprovable parent may have touched any retained park in this scope. It
		// cannot be counted as an untouched run, or leave its unknown parent looking untouched either.
		fromMs = nowMs;
		reasons.push("answer-source-unavailable");
	}
	const sourceEvents = [...events, ...[...byId.values()].flatMap((r) => Array.isArray(r.touches) ? r.touches : [])];
	const allEvents = sourceEvents.filter((e) => e?.type !== "stop" && e?.type !== "wait-end" && TOUCH_CAUSES.includes(e?.cause) && ID.test(e.runId ?? "") && validTime(e.at) && e.at <= nowMs);
	const waitEndsByRun = new Map();
	for (const event of sourceEvents) {
		if (event?.type !== "wait-end" || !WAIT_END_REASONS.includes(event.reason) || !ID.test(event.runId ?? "") || !validTime(event.at) || event.at > nowMs) continue;
		if (!waitEndsByRun.has(event.runId) || event.at < waitEndsByRun.get(event.runId)) waitEndsByRun.set(event.runId, event.at);
	}
	// A terminal cancel and the authenticated delivery counter are durable fallback evidence when their index write
	// is being repaired. The index supplies the actual intervention time; record end is used only for older evidence.
	for (const r of selected) {
		for (const cause of [...(r.reason === "operator-cancel" ? ["cancel"] : []), ...(r.steered?.delivered > 0 ? ["steer"] : [])]) {
			if (!allEvents.some((e) => e.runId === r.jobId && e.cause === cause)) allEvents.push({ runId: r.jobId, cause, at: time(r.endedAt), project: r.project ?? null, scopeId: scopeOf(r) });
		}
	}
	const eventsByRun = new Map();
	for (const e of allEvents) {
		if (!eventsByRun.has(e.runId)) eventsByRun.set(e.runId, []);
		eventsByRun.get(e.runId).push(e);
	}
	for (const list of eventsByRun.values()) list.sort((a, b) => a.at - b.at || TOUCH_CAUSES.indexOf(a.cause) - TOUCH_CAUSES.indexOf(b.cause));
	const inInterval = (rows, start, end) => rows.filter((r) => time(r.endedAt) >= start && time(r.endedAt) < end);
	const count = (rows) => {
		const touched = rows.filter((r) => eventsByRun.has(r.jobId));
		const causes = emptyCauses();
		for (const r of touched) causes.find((x) => x.cause === eventsByRun.get(r.jobId)[0].cause).count++;
		return { runs: rows.length, touched: touched.length, rate: percentage(touched.length, rows.length), causes, touchedRunIds: touched.map((r) => r.jobId).sort() };
	};
	const intervalFrom = Math.max(requestedFromMs, fromMs);
	const currentRows = inInterval(selected, intervalFrom, nowMs);
	const current = count(currentRows);
	const previousFrom = requestedFromMs - windowDays * DAY;
	const previous = fromMs <= previousFrom && !coverage.partial ? count(inInterval(selected, previousFrom, requestedFromMs)) : null;
	const waitsOf = (rows, start, end) => {
		let waitingMs = 0;
		const completed = [];
		const pending = [];
		let unknown = 0;
		for (const r of rows) {
			if (!["awaiting-input", "awaiting-approval"].includes(r.reason)) continue;
			const parkedAt = validTime(r.parkedAt) ? r.parkedAt : time(r.endedAt);
			if (parkedAt > end) continue;
			const answer = (eventsByRun.get(r.jobId) ?? []).find((e) => e.cause === "question-answer" || e.cause === "approval-decision");
			const answeredAt = answer ? Math.max(parkedAt, answer.receivedAt ?? answer.at) : null;
			const terminal = r.reason === "awaiting-approval" ? waitEndsByRun.get(r.jobId) : undefined;
			const closedAt = answeredAt === null && terminal === undefined ? null : Math.max(parkedAt, Math.min(answeredAt ?? Infinity, terminal ?? Infinity));
			// An old park can outlive the index entry that ended it. Without a retained terminal answer,
			// absence before the coverage epoch proves neither an open wait nor a completed one.
			if (closedAt === null && parkedAt < fromMs) { unknown++; continue; }
			waitingMs += Math.max(0, Math.min(end, closedAt ?? end) - Math.max(start, parkedAt));
			// The median describes a person's answer. An automatic deadline/revocation closes the wait,
			// but it must not manufacture either an answer sample or a human intervention.
			if (answeredAt !== null && closedAt === answeredAt && answeredAt >= start && answeredAt < end) completed.push(answeredAt - parkedAt);
			if (closedAt === null) pending.push({ runId: r.jobId, parkedAt, project: r.project ?? null, scopeId: scopeOf(r) });
		}
		return { waitingHours: waitingMs / 3600_000, medianWaitMs: median(completed), pending, unknown, partial: unknown > 0 };
	};
	const waits = waitsOf(selected, intervalFrom, nowMs);
	const rowMetric = (rows, name, extra) => {
		const cur = count(inInterval(rows, intervalFrom, nowMs));
		const prev = previous ? count(inInterval(rows, previousFrom, requestedFromMs)) : null;
		const ids = new Set(rows.map((r) => r.jobId));
		// Repository rows also carry their project's id. Only project rows may use it to find events whose
		// source record has expired; otherwise activity in one repository resets every sibling's streak.
		const related = allEvents.filter((e) => ids.has(e.runId) || (extra.scopeId ? e.scopeId === extra.scopeId : extra.project && e.project === extra.project));
		const lastTouch = related.length ? Math.max(...related.map((e) => e.at)) : null;
		const waiting = waitsOf(rows, intervalFrom, nowMs);
		const pending = waiting.pending;
		const observedSince = Math.max(fromMs, lastTouch ?? fromMs);
		const streakDays = waiting.partial ? null : pending.length ? 0 : Math.max(0, Math.floor((nowMs - observedSince) / DAY));
		const topCause = [...cur.causes].sort((a, b) => b.count - a.count || TOUCH_CAUSES.indexOf(a.cause) - TOUCH_CAUSES.indexOf(b.cause))[0];
		return { ...extra, name, ...cur, previousRate: prev?.rate ?? null, deltaPoints: cur.rate !== null && prev?.rate !== null && prev?.rate !== undefined ? cur.rate - prev.rate : null,
			streakDays, zeroTouch: !waiting.partial && streakDays >= 30 && fromMs <= nowMs - 30 * DAY && !coverage.partial && rows.some((r) => time(r.endedAt) >= nowMs - 30 * DAY),
			waiting: waiting.partial ? null : pending.length, waitingNow: waiting.partial ? null : pending.length, waitingPartial: waiting.partial, topCause: topCause?.count > 0 ? topCause.cause : null, lastTouchAt: lastTouch };
	};
	const projectGroups = new Map();
	for (const r of selected) { const id = r.project ?? ZERO_TOUCH_NO_PROJECT; if (!projectGroups.has(id)) projectGroups.set(id, []); projectGroups.get(id).push(r); }
	const projects = [...projectGroups].map(([id, rows]) => {
		const repoGroups = new Map();
		for (const r of rows) { const scope = scopeOf(r); if (!repoGroups.has(scope)) repoGroups.set(scope, []); repoGroups.get(scope).push(r); }
		const repositories = [...repoGroups].map(([scope, repoRows]) => rowMetric(repoRows, repoLabel(repoRows[0]), { scopeId: scope, target: repoLabel(repoRows[0]), project: id }));
		return { ...rowMetric(rows, id === ZERO_TOUCH_NO_PROJECT ? "No project recorded" : id, { project: id }), repositories };
	}).sort((a, b) => a.project.localeCompare(b.project));
	const stopped = new Map();
	const stoppedUnattributed = new Map();
	const projectsByScope = new Map();
	for (const record of byId.values()) {
		const key = scopeOf(record);
		if (!projectsByScope.has(key)) projectsByScope.set(key, new Set());
		projectsByScope.get(key).add(record.project ?? null);
	}
	for (const e of [...events.filter((e) => e?.type === "stop"), ...stops]) {
		const id = e?.runId ?? e?.jobId;
		if (!ID.test(id ?? "") || !validTime(e.at) || e.at < intervalFrom || e.at >= nowMs) continue;
		const knownProjects = e.scopeId ? projectsByScope.get(e.scopeId) : null;
		const knownProject = e.project ?? (knownProjects?.size === 1 ? [...knownProjects][0] : undefined);
		if (scopeId !== null && e.scopeId && e.scopeId !== scopeId || project !== null && knownProject !== undefined && !zeroTouchProjectMatches(knownProject, project)) continue;
		const unknown = scopeId !== null && !e.scopeId || project !== null && knownProject === undefined;
		if (unknown) stoppedUnattributed.set(id, e);
		else {
			stopped.set(id, e);
			if (project === null && scopeId === null && !e.scopeId && knownProject === undefined) stoppedUnattributed.set(id, e);
		}
	}
	const trend = Array.from({ length: 8 }, (_, i) => {
		const atMs = nowMs - (7 - i) * 7 * DAY;
		const start = atMs - windowDays * DAY;
		const knownStart = Math.max(start, fromMs);
		const part = knownStart >= atMs;
		const facts = count(part ? [] : inInterval(selected, knownStart, atMs));
		return { atMs, ...facts, partial: part || knownStart > start || coverage.partial === true };
	});
	const assignedQuestionRuns = new Set(groups.filter((g) => g.groupId ?? g.id).flatMap((g) => g.runIds ?? []));
	const fixed = fixes.filter((f) => validTime(f?.at) && f.at <= nowMs && zeroTouchProjectMatches(f.project, project) && (scopeId === null || f.scopeId === scopeId)).map((f) => {
		const reverted = validTime(f.undoneAt);
		const spanMs = Math.max(0, Math.min(windowDays * DAY, nowMs - f.at, reverted ? f.undoneAt - f.at : Infinity));
		const eligible = selected.filter((r) => (!f.scopeId || scopeOf(r) === f.scopeId) && (!f.project || r.project === f.project));
		const group = groups.find((g) => (g.groupId ?? g.id) === f.groupId);
		const members = new Set(group?.runIds ?? []);
		const matches = (r) => f.reason ? r.reason === f.reason : f.groupId ? members.has(r.jobId) : (eventsByRun.get(r.jobId) ?? []).some((e) => e.cause === f.cause);
		const beforeRows = inInterval(eligible, f.at - spanMs, f.at);
		const afterRows = inInterval(eligible, f.at, f.at + spanMs);
		const before = beforeRows.filter(matches).length;
		const after = afterRows.filter(matches).length;
		// A new question not yet classified could be this group's recurrence. Absence from this group's members
		// is evidence only after classification; the unassigned bucket cannot prove that a fix worked.
		const unclassified = f.groupId && [...beforeRows, ...afterRows].some((r) => r.reason === "awaiting-input" && !assignedQuestionRuns.has(r.jobId));
		const partial = coverage.partial === true || fromMs > f.at - spanMs || spanMs === 0 || Boolean(unclassified);
		const status = partial || afterRows.length === 0 || reverted ? "observing" : after < before ? "improved" : after > before ? "worse" : "unchanged";
		return { ...f, spanMs, before, after, beforeRuns: beforeRows.length, afterRuns: afterRows.length, beforeCount: before, afterCount: after, subsequentRuns: afterRows.length, partial, status, worked: status === "improved" };
	});
	const medianWaitMs = waits.partial ? null : waits.medianWaitMs;
	return { nowMs, windowDays, coverage: { requestedFromMs, fromMs: intervalFrom, toMs: nowMs, partial: coverage.partial === true || intervalFrom > requestedFromMs || reasons.length > 0, reasons: [...new Set(reasons)], unknownRuns: legacy.filter((r) => time(r.endedAt) >= requestedFromMs).length, stopsPartial: stoppedUnattributed.size > 0 },
		totals: { runs: current.runs, touched: current.touched, rate: current.rate, previousRate: previous?.rate ?? null, deltaPoints: current.rate !== null && previous?.rate !== null && previous?.rate !== undefined ? current.rate - previous.rate : null, stopped: stopped.size, stoppedUnattributed: stoppedUnattributed.size, waitingHours: waits.partial ? null : waits.waitingHours, waitingPartial: waits.partial, waitingUnknown: waits.unknown, medianWaitMs, medianWaitHours: medianWaitMs === null ? null : medianWaitMs / 3600_000, pending: waits.partial ? null : waits.pending.length, waitingNow: waits.pending, draftAnswers: new Set(allEvents.filter((e) => e.answerSource === "draft" && current.touchedRunIds.includes(e.runId)).map((e) => e.runId)).size },
		trend, projects, causes: current.causes, fixes: fixed, groups, touchedRunIds: current.touchedRunIds };
}

/** The expensive scan is on demand, never the short dashboard snapshot or a mutating mirror reader. */
export async function readZeroTouch({ redis = null, logsDir, retentionDays = 30, localHost = null, now = Date.now, windowDays = 30, project = null, scopeId = null, fixes = [], groups = [], fs, timeoutMs, includeRecords = false } = {}) {
	const nowMs = now();
	// A park may predate every plotted interval and still wait throughout this one. Read retained history,
	// not only the trend's lookback, or a long-lived unanswered run disappears from current waiting hours.
	const retainedFromMs = Number(retentionDays) > 0 ? nowMs - Number(retentionDays) * DAY : 0;
	const sinceMs = Math.max(0, Math.min(retainedFromMs, nowMs - 2 * windowDays * DAY, nowMs - (windowDays + 49) * DAY, nowMs - 30 * DAY));
	const [runs, touches] = await Promise.all([
		readCapacityRecords({ redis, logsDir, sinceMs, nowMs, retentionDays, localHost, fs, ...(timeoutMs ? { timeoutMs } : {}) }),
		makeTouchStore({ redis, retentionDays, now, ...(timeoutMs ? { timeoutMs } : {}) }).read(),
	]);
	const boundaries = [touches.coverage.fromMs];
	if (runs.coverage.local) boundaries.push(runs.coverage.local.fromMs);
	if (runs.coverage.mirror) boundaries.push(runs.coverage.mirror.fromMs);
	const reasons = [...touches.coverage.reasons];
	if (runs.coverage.reason) reasons.push(runs.coverage.reason);
	const unavailable = !runs.coverage.local && !runs.coverage.mirror;
	const report = computeZeroTouch({ records: runs.records, events: touches.events, fixes, groups, nowMs, windowDays, project, scopeId,
		coverage: { fromMs: unavailable ? nowMs : Math.max(...boundaries), partial: touches.coverage.partial || unavailable || runs.coverage.skipped > 0 || runs.mirrorState.startsWith("unreachable"), reasons } });
	// Local records cannot establish the absence of fleet interventions when their index is unreadable. A collapsed
	// coverage window likewise contains no observed interval, unlike a useful shorter retained window.
	report.state = unavailable || reasons.includes("touch-index-unavailable") || report.coverage.partial && report.coverage.fromMs >= nowMs ? "unavailable" : "ready";
	if (includeRecords) Object.defineProperties(report, { records: { value: runs.records }, recordMirror: { value: runs.mirrorState } });
	return report;
}
