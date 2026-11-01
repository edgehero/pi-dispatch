/** Endpoint occupancy is a display of the admission map, never another source of admission state (#775). */
import { isPerMachineHost } from "./backends.mjs";
import { HOST_SET, HOST_TTL_MS, hostKey } from "./host-registry.mjs";
import { MODEL_ENDPOINT_ID_RE, MAX_SLOTS } from "./model-endpoints.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const ENDPOINT_STATUS_VERSION = 1;
export const ENDPOINT_STATUS_MAX = 32;
export const ENDPOINT_STATUS_HOSTS_MAX = 64;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;

/** Re-read the loaded file and the SAME map both queue processors claim on every registry beat. */
export function endpointStatusFields(endpoints, slots, multiHost) {
	const rows = [...(endpoints ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const listed = rows.slice(0, ENDPOINT_STATUS_MAX).map((ep) => ({ id: ep.id, slots: ep.slots, used: slots.count(ep.id), fleet: multiHost && !isPerMachineHost(ep.host) ? 1 : 0 }));
	return { endpointsVersion: ENDPOINT_STATUS_VERSION, endpointsStartedAt: ({ startedAt } = {}) => startedAt ?? "", endpoints: listed.length ? JSON.stringify(listed) : "", endpointsMore: Math.max(0, rows.length - listed.length) };
}

/** Unknown versions/fields are never interpreted as an empty host. No path, address or operator text survives. */
export function parseEndpointStatus(row) {
	const absent = { state: "not-reported", endpoints: null, endpointsMore: null };
	if (!row || row.endpointsVersion === undefined || row.endpointsVersion === "") return absent;
	if (String(row.endpointsVersion) !== String(ENDPOINT_STATUS_VERSION)) return { ...absent, state: /^\d+$/.test(String(row.endpointsVersion)) && Number(row.endpointsVersion) > ENDPOINT_STATUS_VERSION ? "unsupported" : "unreadable" };
	// HSET preserves fields unknown to an older worker. Its new startedAt must invalidate old occupancy.
	if (!/^(?:0|[1-9]\d*)$/.test(String(row.endpointsStartedAt)) || String(row.endpointsStartedAt) !== String(row.startedAt)) return { ...absent, state: "unreadable" };
	if (row.endpoints === undefined) return absent;
	const more = /^(?:0|[1-9]\d*)$/.test(String(row.endpointsMore)) ? Number(row.endpointsMore) : NaN;
	if (!integer(more)) return { ...absent, state: "unreadable" };
	if (row.endpoints === "" && more === 0) return { ...absent, endpointsMore: 0 };
	try {
		if (typeof row.endpoints !== "string" || row.endpoints.length > 8192) throw Error();
		const entries = JSON.parse(row.endpoints);
		if (!Array.isArray(entries) || entries.length > ENDPOINT_STATUS_MAX) throw Error();
		let previous = "";
		const endpoints = entries.map((ep) => {
			if (!ep || typeof ep !== "object" || Array.isArray(ep) || typeof ep.id !== "string" || !MODEL_ENDPOINT_ID_RE.test(ep.id) || ep.id <= previous || !Number.isInteger(ep.slots) || ep.slots < 1 || ep.slots > MAX_SLOTS || !integer(ep.used) || ep.used > MAX_SLOTS || ![0, 1].includes(ep.fleet)) throw Error();
			previous = ep.id;
			return { id: ep.id, slots: ep.slots, used: ep.used, fleet: ep.fleet };
		});
		return { state: "reported", endpoints, endpointsMore: more };
	} catch { return { ...absent, state: "unreadable" }; }
}

function bounded(promise, ms) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("endpoint status timeout")), ms); })]).finally(() => clearTimeout(timer));
}

/** Read at most 64 rows, known live hosts first, without pruning or touching the registry's other projections. */
export async function readEndpointStatus(redis, options = {}) {
	let stopped = false;
	try { return await bounded(readEndpointStatusInner(redis, { ...options, stopped: () => stopped }), options.timeoutMs ?? 2500); }
	catch { return { state: "unknown", hosts: [], more: 0, partial: true }; }
	finally { stopped = true; }
}

async function readEndpointStatusInner(redis, { hosts = [], now = () => Date.now(), timeoutMs = 2500, stopped } = {}) {
	let indexed = [];
	let partial = false;
	let cardinality = null;
	try {
		cardinality = await bounded(redis.scard(HOST_SET), timeoutMs);
		if (!integer(cardinality)) throw Error();
		let cursor = "0";
		for (let page = 0; page < 4 && !stopped(); page++) {
			const answer = await bounded(redis.sscan(HOST_SET, cursor, "COUNT", ENDPOINT_STATUS_HOSTS_MAX), timeoutMs);
			if (!Array.isArray(answer) || typeof answer[0] !== "string" || !Array.isArray(answer[1])) throw Error();
			indexed.push(...answer[1].slice(0, ENDPOINT_STATUS_HOSTS_MAX));
			if (answer[1].length > ENDPOINT_STATUS_HOSTS_MAX) partial = true;
			cursor = answer[0];
			if (cursor === "0") break;
			if (page === 3) partial = true;
		}
	} catch { partial = true; }
	const valid = (name) => typeof name === "string" && WORKER_NAME_RE.test(name);
	if (indexed.some((name) => !valid(name))) partial = true;
	const known = [...new Set(hosts.map((h) => typeof h === "string" ? h : h?.name).filter(valid))].sort();
	const names = [...new Set([...known, ...indexed.filter(valid).sort()])];
	const more = Math.max(0, Math.max(cardinality ?? 0, names.length) - Math.min(names.length, ENDPOINT_STATUS_HOSTS_MAX));
	const selected = names.slice(0, ENDPOINT_STATUS_HOSTS_MAX);
	if (!selected.length) return { state: partial ? "unknown" : "reported", hosts: [], more, partial: partial || more > 0 };
	if (stopped()) return { state: "unknown", hosts: [], more, partial: true };
	const rows = await Promise.all(selected.map(async (name) => {
		let row;
		let ttl;
		try {
			[row, ttl] = await bounded(Promise.all([redis.hgetall(hostKey(name)), redis.pttl(hostKey(name))]), timeoutMs);
		} catch { partial = true; return { name, at: null, ageMs: null, state: "unreadable", endpoints: null, endpointsMore: null }; }
		if (!row || Object.keys(row).length === 0 || ttl === -2) {
			return known.includes(name) ? { name, at: null, ageMs: null, state: "not-reported", endpoints: null, endpointsMore: null } : null;
		}
		const at = /^(?:0|[1-9]\d*)$/.test(String(row.beatAt)) && integer(Number(row.beatAt)) ? Number(row.beatAt) : null;
		const ageMs = Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= HOST_TTL_MS ? HOST_TTL_MS - ttl : null;
		const parsed = parseEndpointStatus(row);
		if (ageMs === null || row.name !== name) { parsed.state = "unreadable"; parsed.endpoints = null; partial = true; }
		if (["unsupported", "unreadable"].includes(parsed.state) || parsed.endpointsMore > 0) partial = true;
		return { name, at, ageMs, ...parsed };
	}));
	return { state: partial && !rows.filter(Boolean).length ? "unknown" : "reported", hosts: rows.filter(Boolean), more, partial: partial || more > 0 };
}
