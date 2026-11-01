/** Display-only receiver observations (#775). No request makes a storage command or carries request text here. */
import { DEFER_TIME_MAX_MS } from "./defer-reasons.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const RECEIVER_FORGES = Object.freeze(["github", "gitlab", "forgejo", "azure"]);
export const RECEIVER_OUTCOMES = Object.freeze(["queued", "deduplicated", "held", "steered", "dropped", "unauthorized", "not-configured", "lookup-failed", "enqueue-failed", "malformed", "error"]);
export const RECEIVER_TAKEN = Object.freeze(RECEIVER_OUTCOMES.slice(0, 4));
export const RECEIVER_REFUSED = Object.freeze(RECEIVER_OUTCOMES.slice(5));
export const RECEIVER_BEAT_MS = 15_000;
export const RECEIVER_TTL_MS = 90_000;
export const RECEIVER_HOSTS_MAX = 64;
export const RECEIVER_MAX_BYTES = 64 * 1024;
export const RECEIVER_LIVE = "receiver:live";
export const receiverKey = (name) => `receiver:h:${name}`;
const HOUR = 3_600_000;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const instant = (n) => integer(n) && n <= DEFER_TIME_MAX_MS;
const nameOk = (s) => typeof s === "string" && WORKER_NAME_RE.test(s);
const hourOf = (at) => Math.floor(at / HOUR) * HOUR;
const safeLog = (log, reason) => { try { log("receiver_status_unavailable", { reason }); } catch {} };

/** The address is classified and discarded. Both IPv4 and IPv6 socket answers occur for localhost. */
export function receiverBind(address) {
	if (typeof address !== "string") return null;
	const value = address.toLowerCase();
	if (["0.0.0.0", "::", "::0"].includes(value)) return "all";
	if (value === "::1" || /^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value)) return "loopback";
	return "address";
}

export function receiverOutcome(status, result) {
	if (status === 202) return RECEIVER_TAKEN.includes(result) ? result : null;
	if (status === 204) return "dropped";
	if (status === 401) return "unauthorized";
	if (status === 404) return "not-configured";
	if ([400, 405, 413, 415].includes(status)) return "malformed";
	if (status === 503) return result === "enqueue-failed" ? "enqueue-failed" : result === "lookup-failed" ? "lookup-failed" : null;
	return status === 500 ? "error" : null;
}

/** At most 24 hours and 44 last instants. Clock reversal never resurrects an expired bucket. */
export function makeReceiverObservations({ now = Date.now } = {}) {
	let newest = hourOf(now());
	const words = Object.fromEntries(RECEIVER_FORGES.map((forge) => [forge, Object.fromEntries(RECEIVER_OUTCOMES.map((word) => [word, { lastAt: null, hours: new Map() }]))]));
	const trim = () => {
		newest = Math.max(newest, hourOf(now()));
		for (const forge of Object.values(words)) for (const value of Object.values(forge)) for (const hour of value.hours.keys()) if (hour < newest - 23 * HOUR) value.hours.delete(hour);
	};
	return {
		observe(forge, status, result) {
			const word = receiverOutcome(status, result);
			if (!RECEIVER_FORGES.includes(forge) || word === null) return;
			trim();
			const at = now();
			const value = words[forge][word];
			value.lastAt = Math.max(value.lastAt ?? 0, at);
			const hour = hourOf(at);
			if (hour >= newest - 23 * HOUR) value.hours.set(hour, Math.min(Number.MAX_SAFE_INTEGER, (value.hours.get(hour) ?? 0) + 1));
		},
		snapshot() {
			trim();
			return Object.fromEntries(RECEIVER_FORGES.map((forge) => [forge, Object.fromEntries(RECEIVER_OUTCOMES.map((word) => [word, { lastAt: words[forge][word].lastAt, hours: Array.from({ length: 24 }, (_, i) => { const at = newest - (23 - i) * HOUR; return [at, words[forge][word].hours.get(at) ?? 0]; }) }]))]));
		},
	};
}

/** Strict rebuilding keeps a planted extension field out of the console and the agent's context. */
export function parseReceiverStatus(raw) {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > RECEIVER_MAX_BYTES) return null;
	let d;
	try { d = JSON.parse(raw); } catch { return null; }
	if (!d || d.v !== 1 || !nameOk(d.name) || typeof d.version !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(d.version) || !instant(d.startedAt) || !instant(d.at) || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || !["all", "loopback", "address"].includes(d.bind) || !Array.isArray(d.forges) || d.forges.length > 4 || new Set(d.forges).size !== d.forges.length || d.forges.some((f) => !RECEIVER_FORGES.includes(f))) return null;
	const deliveries = {};
	for (const forge of RECEIVER_FORGES) {
		deliveries[forge] = {};
		for (const word of RECEIVER_OUTCOMES) {
			const v = d.deliveries?.[forge]?.[word];
			if (!v || !(v.lastAt === null || instant(v.lastAt)) || !Array.isArray(v.hours) || v.hours.length !== 24 || v.hours.some((r, i) => !Array.isArray(r) || r.length !== 2 || !instant(r[0]) || r[0] % HOUR !== 0 || !integer(r[1]) || i > 0 && r[0] !== v.hours[i - 1][0] + HOUR)) return null;
			deliveries[forge][word] = { lastAt: v.lastAt, hours: v.hours.map(([at, n]) => [at, n]) };
		}
	}
	return { v: 1, name: d.name, version: d.version, startedAt: d.startedAt, at: d.at, port: d.port, bind: d.bind, forges: [...d.forges], deliveries };
}

function bounded(p, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		Promise.resolve(p).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
	});
}

/** A timeout diagnoses the write but never frees its flight: ioredis may still have it queued offline. */
export function makeReceiverPublisher({ client, name, version, port, bind, forges, observations, now = Date.now, log = () => {}, timeoutMs = 2000, intervalMs = RECEIVER_BEAT_MS, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
	let closed = false;
	let busy = false;
	let timer = null;
	let pruneCursor = "0";
	const startedAt = now();
	const valid = nameOk(name) && Number.isInteger(port) && port > 0 && port <= 65535 && ["all", "loopback", "address"].includes(bind);
	if (!valid) safeLog(log, "identity-or-socket");
	const beat = () => {
		if (closed || busy || !valid) return;
		busy = true;
		let reported = false;
		const fail = (reason) => { if (!reported) { reported = true; safeLog(log, reason); } };
		const timeout = setTimeout(() => fail("timeout"), timeoutMs);
		timeout.unref?.();
		const work = async () => {
			const redis = await client();
			if (closed) return;
			const record = { v: 1, name, version, startedAt, at: now(), port, bind, forges, deliveries: observations.snapshot() };
			if (!parseReceiverStatus(JSON.stringify(record))) throw new Error("record");
			if (await redis.set(receiverKey(name), JSON.stringify(record), "PX", RECEIVER_TTL_MS) !== "OK") throw new Error("set");
			if (closed) return;
			if (!integer(await redis.sadd(RECEIVER_LIVE, name))) throw new Error("index");
			if (closed) return;
			const indexed = await redis.sscan(RECEIVER_LIVE, pruneCursor, "COUNT", 64);
			if (!Array.isArray(indexed) || typeof indexed[0] !== "string" || !/^\d{1,20}$/.test(indexed[0]) || !Array.isArray(indexed[1])) throw new Error("index");
			pruneCursor = indexed[0];
			const look = indexed[1].slice(0, 256).filter((n) => nameOk(n) && n !== name);
			if (look.length && !closed) {
				// A separate GET/SREM can erase a peer that republished between them. Check and prune atomically.
				const removed = await redis.eval("local n = 0; for i = 2, #KEYS do if redis.call('EXISTS', KEYS[i]) == 0 then n = n + redis.call('SREM', KEYS[1], ARGV[i - 1]) end end; return n", look.length + 1, RECEIVER_LIVE, ...look.map(receiverKey), ...look);
				if (!integer(removed)) throw new Error("index");
			}
		};
		Promise.resolve().then(work).catch(() => fail("write")).finally(() => { clearTimeout(timeout); busy = false; });
	};
	return {
		start() { if (closed || timer || !valid) return; beat(); timer = setIntervalFn(beat, intervalMs); timer.unref?.(); },
		beat,
		close() { closed = true; if (timer) clearIntervalFn(timer); timer = null; },
	};
}

/** Read-only, live names first. Incomplete reads cannot prove no receiver or a zero delivery count. */
export async function readReceiverStatus(redis, { names = [], now = Date.now, timeoutMs = 2000 } = {}) {
	const deadline = performance.now() + timeoutMs;
	const within = (fn) => {
		const left = deadline - performance.now();
		if (left <= 0) return Promise.reject(new Error("timeout"));
		try { return bounded(fn(), Math.max(1, Math.ceil(left))); } catch { return Promise.reject(new Error("unavailable")); }
	};
	let indexed;
	let complete = true;
	indexed = [];
	try {
		let cursor = "0";
		for (let page = 0; page < 4; page++) {
			const answer = await within(() => redis.sscan(RECEIVER_LIVE, cursor, "COUNT", 64));
			if (!Array.isArray(answer) || typeof answer[0] !== "string" || !/^\d{1,20}$/.test(answer[0]) || !Array.isArray(answer[1])) throw new Error("index");
			cursor = answer[0];
			const room = 256 - indexed.length;
			indexed.push(...answer[1].slice(0, room));
			if (answer[1].length > room) complete = false;
			if (cursor === "0") break;
			if (page === 3 || indexed.length >= 256) { complete = false; break; }
		}
	} catch { complete = false; }
	const live = [...new Set(names.filter(nameOk))].sort();
	const rest = [...new Set(indexed.filter(nameOk))].filter((n) => !live.includes(n)).sort();
	if (indexed.some((n) => !nameOk(n))) complete = false;
	const all = [...live, ...rest];
	const wanted = all.slice(0, RECEIVER_HOSTS_MAX);
	const more = Math.max(0, all.length - wanted.length);
	const moreUnknown = !complete;
	if (more) complete = false;
	if (!wanted.length) return { hosts: [], complete, more, moreUnknown };
	let values;
	let ttls;
	try {
		[values, ttls] = await within(() => Promise.all([redis.mget(...wanted.map(receiverKey)), Promise.all(wanted.map((name) => Promise.resolve().then(() => redis.pttl(receiverKey(name))).catch(() => null)))]));
		if (!Array.isArray(values) || values.length !== wanted.length) throw new Error("records");
	} catch { return { hosts: wanted.map((name) => ({ name, unreadable: true })), complete: false, more, moreUnknown }; }
	const hosts = [];
	for (const [i, name] of wanted.entries()) {
		if (values[i] === null || ttls[i] === -2) continue;
		const record = parseReceiverStatus(values[i]);
		if (!record || record.name !== name || !Number.isInteger(ttls[i]) || ttls[i] < 0 || ttls[i] > RECEIVER_TTL_MS) { hosts.push({ name, unreadable: true }); complete = false; continue; }
		hosts.push({ ...record, ageMs: RECEIVER_TTL_MS - ttls[i] });
	}
	return { hosts, complete, more, moreUnknown };
}

/** Current counts are folded on the reader's clock; a dead process never freezes an old busy hour in view. */
export function receiverForgeFacts(record, forge, now) {
	if (!record?.deliveries?.[forge]) return null;
	const start = hourOf(now) - 23 * HOUR;
	const end = hourOf(now);
	const counts = {};
	const last = (words) => Math.max(0, ...words.map((word) => record.deliveries[forge][word].lastAt ?? 0)) || null;
	for (const word of RECEIVER_OUTCOMES) counts[word] = Math.min(Number.MAX_SAFE_INTEGER, record.deliveries[forge][word].hours.reduce((sum, [at, n]) => sum + (at >= start && at <= end ? n : 0), 0));
	return { counts, lastTaken: last(RECEIVER_TAKEN), lastRefused: last(RECEIVER_REFUSED) };
}
