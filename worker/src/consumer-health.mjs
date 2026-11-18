/** Consumer observations are display facts, never permission to start or retry work (#924). */
export const CONSUMER_HEALTH_VERSION = 1;
export const CONSUMER_ROLES = Object.freeze(["shared", "host", "sandbox"]);
export const CONSUMER_STATES = Object.freeze(["starting", "running", "paused", "closing", "failed"]);
export const CONSUMER_CONNECTIONS = Object.freeze(["starting", "ready", "reconnecting", "ended"]);
export const CONSUMER_VERDICTS = Object.freeze(["unknown", "starting", "idle", "busy", "paused", "rate-limited", "reconnecting", "failed", "stalled", "stopping"]);
export const CONSUMER_STALE_MS = 120_000;
export const CONSUMER_ROW_MAX_AGE_MS = 60_000;
export const CONSUMER_HEALTH_MAX_BYTES = 4096;
export const CONSUMER_FIELDS = Object.freeze(["role", "state", "connection", "active", "rateLimited", "lastFetchAt", "lastSuccessAt", "lastTakenAt", "fetchAgeMs", "successAgeMs"]);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const nullableInteger = (n) => n === null || integer(n);

/** Generation-bound: an older worker's HSET can otherwise renew a previous process's health forever. */
export function parseConsumerHealth(row) {
	const raw = row?.consumers;
	if (typeof raw !== "string" || raw.length > CONSUMER_HEALTH_MAX_BYTES || new TextEncoder().encode(raw).length > CONSUMER_HEALTH_MAX_BYTES) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed?.v !== CONSUMER_HEALTH_VERSION || !integer(parsed.startedAt) || parsed.startedAt !== Number(row.startedAt) || !Array.isArray(parsed.rows) || parsed.rows.length === 0 || parsed.rows.length > CONSUMER_ROLES.length) return null;
		const seen = new Set();
		const rows = [];
		for (const c of parsed.rows) {
			if (!c || !CONSUMER_ROLES.includes(c.role) || seen.has(c.role) || !CONSUMER_STATES.includes(c.state) || !CONSUMER_CONNECTIONS.includes(c.connection) || !integer(c.active) || typeof c.rateLimited !== "boolean") return null;
			for (const field of ["lastFetchAt", "lastSuccessAt", "lastTakenAt", "fetchAgeMs", "successAgeMs"]) if (!nullableInteger(c[field])) return null;
			seen.add(c.role);
			rows.push(Object.fromEntries(CONSUMER_FIELDS.map((key) => [key, c[key]])));
		}
		return rows;
	} catch { return null; }
}

/**
 * Elapsed ages belong to the producer's monotonic clock. Add only the registry's age at the reader, not the
 * difference between two hosts' clocks. Old last-taken timestamps are informational: an empty queue is healthy.
 * `demand` is keyed by role and contains only { paused, overdue }, from bounded queue reads.
 */
export function consumerHealthOf(row, demand = {}) {
	const rows = parseConsumerHealth(row);
	const age = row?.ttlAgeMs ?? row?.staleMs;
	if (!rows || !integer(age) || age > CONSUMER_ROW_MAX_AGE_MS || row?.noExpiry === true) return { state: "unknown", rows: [] };
	if (row.routes !== undefined && (!rows.some((c) => c.role === "shared") || !rows.some((c) => c.role === "sandbox") || (String(row.routes) === "true" && !rows.some((c) => c.role === "host")))) return { state: "unknown", rows: [] };
	const result = rows.map((c) => {
		const queue = demand[c.role];
		let state;
		if (c.state === "failed") state = "failed";
		else if (c.state === "closing") state = "stopping";
		else if (c.connection === "ended") state = "failed";
		else if (c.connection === "reconnecting") state = "reconnecting";
		else if (c.state === "starting" || c.connection === "starting") state = "starting";
		else if (c.state === "paused" || queue?.paused === true) state = "paused";
		else if (c.active > 0) state = "busy";
		else if (c.rateLimited) state = "rate-limited";
		else if (c.successAgeMs === null || c.successAgeMs + age > CONSUMER_STALE_MS) state = queue?.paused === false && queue?.overdue === true ? "stalled" : "unknown";
		else state = "idle";
		return { ...c, verdict: state };
	});
	const state = result.some((c) => c.verdict === "failed") ? "failed" : result.some((c) => c.verdict === "stalled") ? "stalled" : result.some((c) => ["unknown", "starting", "reconnecting", "stopping"].includes(c.verdict)) ? "unknown" : "healthy";
	return { state, rows: result };
}

export function consumerHealthText(health) {
	if (health?.state === "failed") return "Queue consumer stopped; the worker needs a restart.";
	if (health?.state === "stalled") return "Queue consumption stalled: work is overdue while an idle consumer reports no recent queue progress.";
	if (health?.state === "healthy") return "Queue consumers are responding.";
	return "Queue consumer health is unknown; a process heartbeat alone does not prove consumption.";
}
