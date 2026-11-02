/**
 * The Updates page's facts and a person's desired versions, in Valkey (issue #796, `INT-UPDATES-KEYS`, `DES-PACKAGE-UPDATES-PREPARED-NOT-APPLIED`).
 *
 * THE SAME TEST AS DOCTOR'S RESULTS: delete every `updates:*` key while the fleet runs and every job behaves exactly as before, because a job reads
 * only the stage manifest on disk. What is lost is the page's facts and any Adopt no host has applied yet.
 *
 * A look record is rebuilt on read, never passed through. Names and versions must match the same rules the stager takes, and each state is a closed
 * word, so what a registry or a forge answered cannot reach a viewer as anything else.
 */
import { randomUUID } from "node:crypto";
import { EXACT_VERSION_RE, NPM_NAME_RE } from "./packages.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const UPDATES_HOSTS = "updates:hosts";
export const UPDATES_GENERATION = "updates:generation";
export const UPDATES_DESIRED = "updates:desired";
export const updatesLookKey = (host) => `updates:h:${host}`;
export const updatesAppliedKey = (host) => `updates:applied:${host}`;
export const updatesCanaryKey = (name, version) => `updates:canary:${name}@${version}`;

export const UPDATES_LOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const UPDATES_APPLIED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const UPDATES_CANARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A host with no row at the newest generation is pending; this long after the request it reads as overdue, never as lost. */
export const UPDATES_OVERDUE_MS = 24 * 60 * 60 * 1000;
export const UPDATES_LOOK_EVERY_HOURS = 24;
export const UPDATES_HOSTS_MAX = 64;
export const UPDATES_PACKAGES_MAX = 64;
export const UPDATES_EXCERPT_MAX = 2000;

export const READ_STATES = Object.freeze(["ok", "unknown"]);
export const CHECK_STATES = Object.freeze(["passing", "failing", "pending", "unknown"]);
export const HOST_PI_STATES = Object.freeze(["same", "newer", "older", "absent", "unknown"]);
export const PROBE_STATES = Object.freeze(["ok", "drift", "unknown"]);
export const APPLIED_STATES = Object.freeze(["adopted", "undone", "no-change", "cannot-adopt"]);
export const CANNOT_ADOPT_REASONS = Object.freeze(["no-overlay", "overlay-read-only", "packages-file-unusable", "adapter", "not-staged-here", "version-not-found", "stage-refused"]);
export const DESIRED_OPS = Object.freeze(["adopt", "undo"]);

const OP_TIMEOUT_MS = 3_000;
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const word = (value, words) => (words.includes(value) ? value : null);
const name = (value) => (typeof value === "string" && value.length <= 214 && NPM_NAME_RE.test(value) ? value : null);
const version = (value) => (typeof value === "string" && value.length <= 128 && EXACT_VERSION_RE.test(value) ? value : null);
const instant = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const digest = (value) => (typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null);
const person = (value) => (typeof value === "string" && /^[A-Za-z0-9._@-]{1,64}$/.test(value) ? value : null);

function bounded(promise, timeoutMs = OP_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("valkey did not answer")), timeoutMs);
		timer.unref?.();
		Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
	});
}

/** A version's order. A pre-release sorts before its release, as semver says. Build metadata does not order. */
export function compareVersions(a, b) {
	const parts = (v) => {
		const [core, pre = null] = String(v).split("+")[0].split(/-(.*)/s);
		return { nums: core.split(".").map(Number), pre };
	};
	const x = parts(a), y = parts(b);
	for (let i = 0; i < 3; i += 1) {
		if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
	}
	if (x.pre === y.pre) return 0;
	if (x.pre === null) return 1;
	if (y.pre === null) return -1;
	return x.pre < y.pre ? -1 : 1;
}

/** One look record, rebuilt from anything: `null` unless its frame is whole, and an unknown word degrades to `unknown`, never to a good state. */
export function parseLookRecord(text) {
	let raw;
	try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch { return null; }
	if (!object(raw) || raw.v !== 1 || !WORKER_NAME_RE.test(raw.host ?? "") || !instant(raw.at) || !Number.isSafeInteger(raw.everyHours) || raw.everyHours < 1 || raw.everyHours > 168) return null;
	const pi = object(raw.pi) ? raw.pi : {};
	const host = object(raw.hostPi) ? raw.hostPi : {};
	const packages = [];
	for (const row of Array.isArray(raw.packages) ? raw.packages.slice(0, UPDATES_PACKAGES_MAX) : []) {
		const pkg = object(row) ? name(row.name) : null;
		const at = object(row) ? version(row.version) : null;
		if (!pkg || !at) continue;
		packages.push({ name: pkg, version: at, newest: version(row.newest), read: word(row.read, READ_STATES) ?? "unknown" });
	}
	return {
		v: 1, host: raw.host, at: raw.at, everyHours: raw.everyHours,
		pi: { pinned: version(pi.pinned), newest: version(pi.newest), read: word(pi.read, READ_STATES) ?? "unknown", checks: pi.checks === null ? null : word(pi.checks, CHECK_STATES) ?? "unknown" },
		hostPi: { version: version(host.version), tested: version(host.tested), state: word(host.state, HOST_PI_STATES) ?? "unknown", needles: word(host.needles, PROBE_STATES) ?? "unknown", extension: word(host.extension, PROBE_STATES) ?? "unknown" },
		packages,
	};
}

export const lookIsStale = (record, now) => now - record.at > 2 * record.everyHours * 60 * 60 * 1000;

/** The value and its expiry in one command, for doctor's reason. The look's whole record replaces the last one. */
export async function publishLook(redis, record) {
	const parsed = parseLookRecord(record);
	if (!parsed) throw new Error("not a look record");
	await bounded(redis.set(updatesLookKey(parsed.host), JSON.stringify(parsed), "PX", UPDATES_LOOK_TTL_MS));
	await bounded(redis.sadd(UPDATES_HOSTS, parsed.host));
}

/** `{ hosts: [{ record, stale }], more }` or `{ unreachable }`. Writes nothing: a viewer's page view prunes no index. */
export async function readLooks(redis, { now = Date.now } = {}) {
	try {
		const members = (await bounded(redis.smembers(UPDATES_HOSTS))) ?? [];
		const names = [...new Set(members)].filter((host) => typeof host === "string" && WORKER_NAME_RE.test(host)).sort();
		const wanted = names.slice(0, UPDATES_HOSTS_MAX);
		if (wanted.length === 0) return { hosts: [], more: 0 };
		const values = await bounded(redis.mget(...wanted.map(updatesLookKey)));
		const hosts = [];
		for (const value of values) {
			const record = typeof value === "string" ? parseLookRecord(value) : null;
			if (record) hosts.push({ record, stale: lookIsStale(record, now()) });
		}
		return { hosts, more: names.length - wanted.length };
	} catch {
		return { unreachable: true };
	}
}

/** One desired row, rebuilt. `undoOf` is the generation an Undo takes back. */
export function parseDesired(text) {
	let raw;
	try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch { return null; }
	if (!object(raw) || raw.v !== 1 || !Number.isSafeInteger(raw.generation) || raw.generation < 1) return null;
	const pkg = name(raw.name), at = version(raw.version), op = word(raw.op, DESIRED_OPS), by = person(raw.by), when = instant(raw.at);
	if (!pkg || !at || !op || !by || !when) return null;
	const undoOf = op === "undo" && Number.isSafeInteger(raw.undoOf) && raw.undoOf > 0 ? raw.undoOf : null;
	if (op === "undo" && undoOf === null) return null;
	return { v: 1, generation: raw.generation, name: pkg, version: at, op, by, at: when, ...(undoOf === null ? {} : { undoOf }), request: typeof raw.request === "string" && raw.request.length <= 64 ? raw.request : null };
}

/**
 * The generation and its row in ONE script. INCR then HSET as two commands would let two concurrent requests land in the wrong order, leaving the older
 * one as the row with the newer one's generation lost, and every host would then reconcile to what nobody last asked for.
 */
const SET_DESIRED = `local g = redis.call('INCR', KEYS[1])
local row = cjson.decode(ARGV[2])
row.generation = g
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(row))
return g`;

/** Record what a person asked for, and return its generation. */
export async function setDesired(redis, { name: pkg, version: at, op, by, at: when, undoOf = null }) {
	const row = { v: 1, generation: 1, name: pkg, version: at, op, by, at: when, ...(undoOf === null ? {} : { undoOf }), request: randomUUID() };
	if (!parseDesired(row)) throw new Error("not a desired version");
	return await bounded(redis.eval(SET_DESIRED, 2, UPDATES_GENERATION, UPDATES_DESIRED, pkg, JSON.stringify(row)));
}

/** Every desired row, or `null` when Valkey could not answer. An unreadable row is one nobody can act on, so it is left out. */
export async function readDesired(redis) {
	try {
		const raw = (await bounded(redis.hgetall(UPDATES_DESIRED))) ?? {};
		const rows = [];
		for (const [key, value] of Object.entries(raw)) {
			const row = parseDesired(value);
			if (row && row.name === key) rows.push(row);
		}
		return rows.sort((a, b) => a.generation - b.generation);
	} catch {
		return null;
	}
}

export function parseApplied(text) {
	let raw;
	try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch { return null; }
	if (!object(raw) || raw.v !== 1 || !Number.isSafeInteger(raw.generation) || raw.generation < 1) return null;
	const state = word(raw.state, APPLIED_STATES), when = instant(raw.at);
	if (!state || !when) return null;
	return { v: 1, generation: raw.generation, state, version: version(raw.version), reason: state === "cannot-adopt" ? word(raw.reason, CANNOT_ADOPT_REASONS) : null, digest: digest(raw.digest), at: when };
}

export async function writeApplied(redis, host, pkg, row) {
	const parsed = parseApplied(row);
	if (!parsed || !WORKER_NAME_RE.test(host) || !name(pkg)) throw new Error("not an applied row");
	await bounded(redis.hset(updatesAppliedKey(host), pkg, JSON.stringify(parsed)));
	await bounded(redis.pexpire(updatesAppliedKey(host), UPDATES_APPLIED_TTL_MS));
}

/** `{ <package>: row }` for one host, or `null` when Valkey could not answer. */
export async function readApplied(redis, host) {
	try {
		const raw = (await bounded(redis.hgetall(updatesAppliedKey(host)))) ?? {};
		const rows = {};
		for (const [key, value] of Object.entries(raw)) {
			const row = parseApplied(value);
			if (row && name(key)) rows[key] = row;
		}
		return rows;
	} catch {
		return null;
	}
}

/** Whether this host has work: any desired row newer than what it applied. Read every couple of minutes by the worker, so it must stay two reads. */
export async function hostHasPending(redis, host) {
	const desired = await readDesired(redis);
	const applied = desired === null ? null : await readApplied(redis, host);
	if (!desired || !applied) return false;
	return desired.some((row) => (applied[row.name]?.generation ?? 0) < row.generation);
}

/** Third-party text for a person to read: control characters gone, cut to its bound. Escaped where it is drawn, like everything else. */
export function changelogExcerpt(text) {
	if (typeof text !== "string") return null;
	const clean = text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim();
	return clean === "" ? null : clean.slice(0, UPDATES_EXCERPT_MAX);
}

export function parseCanaryFacts(text) {
	let raw;
	try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch { return null; }
	if (!object(raw) || raw.v !== 1 || !WORKER_NAME_RE.test(raw.host ?? "") || !instant(raw.at)) return null;
	return { v: 1, host: raw.host, at: raw.at, digest: digest(raw.digest), excerpt: changelogExcerpt(raw.excerpt) };
}

/** What a canary's install found, published beside the host's facts and never on the run record: the excerpt is a third party's text. */
export async function publishCanaryFacts(redis, { name: pkg, version: at, host, digest: tree, excerpt, at: when }) {
	if (!name(pkg) || !version(at)) throw new Error("not a canary's package");
	const facts = parseCanaryFacts({ v: 1, host, at: when, digest: tree, excerpt });
	if (!facts) throw new Error("not a canary's facts");
	await bounded(redis.set(updatesCanaryKey(pkg, at), JSON.stringify(facts), "PX", UPDATES_CANARY_TTL_MS));
}

export async function readCanaryFacts(redis, pkg, at) {
	try {
		const value = await bounded(redis.get(updatesCanaryKey(pkg, at)));
		return typeof value === "string" ? parseCanaryFacts(value) : null;
	} catch {
		return null;
	}
}
