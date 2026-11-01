/**
 * Display history, never a notification queue (INT-HOOK-RUNS-KEY, #775). Deleting hook:* changes no hook or job.
 * Each completion appends one bounded, versioned record; the key expires seven days after the last append.
 * The small memory drain absorbs simultaneous completions without making a hook wait for Valkey. It never retries:
 * a failed append is lost and named. An operation that timed out still owns the drain until it ACTUALLY settles,
 * because ioredis queues commands while offline and a timeout alone cannot bound that queue.
 */
import { publishedJobId, LIVE_JOB_ID_RE } from "./live-jobs.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";
import { RECORD_REASON_RE } from "./record-reason.mjs";

export const HOOK_HOSTS = "hook:hosts";
export const hookRunsKey = (name) => `hook:h:${name}`;
export const HOOK_RUN_VERSION = 1;
export const HOOK_RUNS_MAX = 20;
export const HOOK_RUN_BYTES = 1024;
export const HOOK_HOSTS_MAX = 64;
export const HOOK_PENDING_MAX = 64;
export const HOOK_RUNS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The portable union, not this reader's platform: a Linux worker may be read from macOS or Windows. */
export const HOOK_SIGNALS = Object.freeze(["SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCLD", "SIGCONT", "SIGEMT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINFO", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGLOST", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK"]);
export const HOOK_DETAILS = Object.freeze(["exit", "timeout", "spawn", "unresolvable", "argv-unusable", "signal-unknown", ...HOOK_SIGNALS.map((signal) => `signal-${signal}`)]);
const instant = (value) => Number.isSafeInteger(value) && value >= 0;
// Windows reports the full unsigned process status (including NTSTATUS), not POSIX's low eight bits.
const codeOf = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
const outcomeOf = (value) => value === "failed" || value === "policy" ? value : null;
const reasonOf = (value) => typeof value === "string" && RECORD_REASON_RE.test(value) ? value : "infra";

export function buildHookRun(fields, at) {
	return { v: HOOK_RUN_VERSION, at, jobId: publishedJobId(fields?.jobId), outcome: outcomeOf(fields?.outcome), reason: reasonOf(fields?.reason), detail: HOOK_DETAILS.includes(fields?.detail) ? fields.detail : "signal-unknown", code: codeOf(fields?.code) };
}

/** Another host's text is projected again, including records passed directly to the model boundary. */
export function parseHookRun(raw) {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > HOOK_RUN_BYTES) return null;
	let value;
	try { value = JSON.parse(raw); } catch { return null; }
	if (!value || value.v !== HOOK_RUN_VERSION || !instant(value.at) || !(value.jobId === null || typeof value.jobId === "string" && LIVE_JOB_ID_RE.test(value.jobId)) || !(value.outcome === null || outcomeOf(value.outcome)) || typeof value.reason !== "string" || !RECORD_REASON_RE.test(value.reason) || !HOOK_DETAILS.includes(value.detail) || !(value.code === null || codeOf(value.code) === value.code)) return null;
	return { v: HOOK_RUN_VERSION, at: value.at, jobId: value.jobId, outcome: value.outcome, reason: value.reason, detail: value.detail, code: value.code };
}

function bounded(promise, timeoutMs = 2000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Error("timeout")), timeoutMs);
		Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
	});
}
const validName = (name) => typeof name === "string" && WORKER_NAME_RE.test(name);

/** No message from a client, record, executable or environment reaches this diagnostic. */
export function makeHookRunsPublisher({ redis, name, now = Date.now, log = () => {}, timeoutMs = 2000 }) {
	const pending = [];
	let draining = false;
	let closed = false;
	let pruneAt = null;
	let pruneCursor = "0";
	const note = (reason) => { try { log("hook_runs_publish_failed", { reason }); } catch {} };
	const prune = async (at) => {
		if (closed || pruneAt !== null && at - pruneAt < 15_000) return;
		pruneAt = at;
		const found = await redis.sscan(HOOK_HOSTS, pruneCursor, "COUNT", HOOK_HOSTS_MAX);
		if (!Array.isArray(found) || typeof found[0] !== "string" || !Array.isArray(found[1])) return;
		pruneCursor = found[0];
		const names = found[1].slice(0, HOOK_HOSTS_MAX).filter((member) => validName(member) && member !== name);
		if (closed || !names.length) return;
		const pipe = redis.pipeline();
		// Checking and removing together cannot erase an index entry another host has just republished.
		for (const member of names) pipe.eval("if redis.call('EXISTS', KEYS[1]) == 0 then return redis.call('SREM', KEYS[2], ARGV[1]) end return 0", 2, hookRunsKey(member), HOOK_HOSTS, member);
		const result = await pipe.exec();
		if (!Array.isArray(result) || result.length !== names.length || result.some((row) => !Array.isArray(row) || row[0])) throw Error("unavailable");
	};
	const drain = async () => {
		draining = true;
		while (!closed && pending.length) {
			const record = pending.shift();
			let said = false;
			const fail = () => { if (!said && !closed) { said = true; note("unavailable"); } };
			const timer = setTimeout(fail, timeoutMs);
			timer.unref?.();
			try {
				const key = hookRunsKey(name);
				const tx = redis.multi().lpush(key, JSON.stringify(record)).ltrim(key, 0, HOOK_RUNS_MAX - 1).pexpire(key, HOOK_RUNS_TTL_MS).sadd(HOOK_HOSTS, name);
				const answer = await tx.exec();
				if (!Array.isArray(answer) || answer.length !== 4 || answer.some((row) => !Array.isArray(row) || row[0])) fail();
				else await prune(record.at);
			} catch { fail(); }
			finally { clearTimeout(timer); }
		}
		draining = false;
	};
	return {
		publish(fields) {
			if (closed) return;
			if (!validName(name)) { note("invalid-host"); return; }
			if (pending.length + (draining ? 1 : 0) >= HOOK_PENDING_MAX) { note("full"); return; }
			let at;
			try { at = now(); } catch { note("invalid-time"); return; }
			if (!instant(at)) { note("invalid-time"); return; }
			pending.push(buildHookRun(fields, at));
			if (!draining) void drain();
		},
		close() { closed = true; pending.length = 0; },
	};
}

/**
 * Bounded discovery: live names first, then at most four SSCAN pages, no SMEMBERS. COUNT is a hint, so even a large
 * response is cut before issuing row commands. SCARD reports an incomplete index walk without calling it empty.
 * A lost index still reads known live hosts; an unreadable index makes that answer partial, never complete.
 */
async function hostNames(redis, names, timeoutMs, stopped) {
	const live = [...new Set(names.filter(validName))].sort();
	const wanted = new Set(live.slice(0, HOOK_HOSTS_MAX));
	const indexed = new Set();
	const members = new Set();
	let total = 0;
	let partial = live.length > HOOK_HOSTS_MAX;
	let indexFailed = false;
	let cursor = "0";
	try {
		total = await bounded(redis.scard(HOOK_HOSTS), timeoutMs);
		if (!Number.isSafeInteger(total) || total < 0) throw Error("invalid");
		if (total > 0) for (let page = 0; page < 4 && !stopped(); page++) {
			const result = await bounded(redis.sscan(HOOK_HOSTS, cursor, "COUNT", HOOK_HOSTS_MAX), timeoutMs);
			if (!Array.isArray(result) || typeof result[0] !== "string" || !Array.isArray(result[1])) throw Error("invalid");
			cursor = result[0];
			for (const name of result[1].slice(0, HOOK_HOSTS_MAX * 4)) {
				members.add(name);
				if (validName(name)) { indexed.add(name); if (wanted.size < HOOK_HOSTS_MAX) wanted.add(name); }
			}
			if (cursor === "0" || wanted.size === HOOK_HOSTS_MAX) break;
		}
		partial ||= cursor !== "0" || total !== members.size || indexed.size !== members.size;
	} catch { partial = true; indexFailed = true; }
	// With an incomplete walk the unseen members may overlap the omitted live names. Count only the union we SAW,
	// explicitly a floor; adding the two remainders would count a large fleet's same hosts twice.
	const more = Math.max(0, new Set([...live, ...indexed]).size - wanted.size);
	const moreUnknown = indexFailed || cursor !== "0" || total !== members.size;
	return { names: [...wanted], more, moreUnknown, partial: partial || more > 0 };
}

/** Readers write nothing. Expired index members are pruned by the next publisher, not by a console request. */
export async function readHookRuns(redis, { names = [], timeoutMs = 2000 } = {}) {
	let stopped = false;
	// Register the WHOLE-read timer before issuing any command. Per-command bounds alone can turn four slow
	// discovery pages and one row read into ten seconds; late settlement must never start follow-up commands.
	const work = Promise.resolve().then(() => readHookRunsInner(redis, names, timeoutMs, () => stopped));
	try { return await bounded(work, timeoutMs); }
	catch { return { hosts: [], more: 0, moreUnknown: true, partial: true }; }
	finally { stopped = true; }
}

async function readHookRunsInner(redis, names, timeoutMs, stopped) {
	const selected = await hostNames(redis, names, timeoutMs, stopped);
	if (stopped()) return { hosts: [], more: selected.more, moreUnknown: true, partial: true };
	const hosts = await Promise.all(selected.names.map(async (name) => {
		try {
			const key = hookRunsKey(name);
			const [raw, ttl] = await Promise.all([bounded(redis.lrange(key, 0, HOOK_RUNS_MAX), timeoutMs), bounded(redis.pttl(key), timeoutMs)]);
			if (!Array.isArray(raw) || raw.length > HOOK_RUNS_MAX || !Number.isSafeInteger(ttl)) throw Error("invalid");
			if (raw.length === 0 && ttl === -2) return { name, runs: [], absent: true };
			if (ttl <= 0 || ttl > HOOK_RUNS_TTL_MS || raw.length === 0) throw Error("invalid");
			const runs = raw.map(parseHookRun);
			if (runs.some((record) => record === null)) throw Error("invalid");
			return { name, runs };
		} catch { return { name, runs: [], unreadable: true }; }
	}));
	return { hosts: hosts.sort((a, b) => a.name.localeCompare(b.name)), more: selected.more, moreUnknown: selected.moreUnknown, partial: selected.partial || hosts.some((host) => host.unreadable) };
}

/** Public display/model DTO. Recomputing counts prevents a polluted DTO inventing a successful hook history. */
export function hookRunsView(value) {
	const hosts = [];
	const input = Array.isArray(value?.hosts) ? value.hosts : [];
	const omitted = Math.max(0, input.length - HOOK_HOSTS_MAX);
	let partial = value?.partial !== false || omitted > 0;
	const seen = new Set();
	for (const host of input.slice(0, HOOK_HOSTS_MAX)) {
		if (!validName(host?.name) || seen.has(host.name)) { partial = true; continue; }
		seen.add(host.name);
		const raw = Array.isArray(host.runs) ? host.runs : [];
		const runs = raw.slice(0, HOOK_RUNS_MAX).map((run) => { try { return parseHookRun(JSON.stringify(run)); } catch { return null; } });
		const unreadable = host.unreadable === true || !Array.isArray(host.runs) || raw.length > HOOK_RUNS_MAX || runs.some((run) => !run);
		const counts = unreadable ? null : Object.fromEntries([...new Set(runs.map((run) => run.detail))].map((detail) => [detail, runs.filter((run) => run.detail === detail).length]));
		hosts.push({ name: host.name, unreadable, absent: !unreadable && (host.absent === true || runs.length === 0), runs: unreadable ? [] : runs, counts });
	}
	return { hosts, more: (Number.isSafeInteger(value?.more) && value.more >= 0 ? value.more : 0) + omitted, moreUnknown: value?.moreUnknown === true, partial: partial || hosts.some((host) => host.unreadable) };
}
