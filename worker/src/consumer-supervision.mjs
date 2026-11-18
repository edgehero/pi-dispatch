import { observeConsumer } from "./bullmq-internals.mjs";
import { CONSUMER_HEALTH_VERSION, CONSUMER_ROLES } from "./consumer-health.mjs";

/** All consumers share one fatal callback; a socket close that will reconnect is not a fatal event. */
export function makeConsumerSupervisor({ onFatal = () => {}, now = Date.now, monotonic = () => performance.now() } = {}) {
	const entries = new Map();
	let stopping = false;
	let failed = false;
	function fail(entry, reason) {
		if (stopping || entry.closing || failed) return;
		entry.state = "failed";
		failed = true;
		// Defer until the constructor's caller has its worker and teardown closure, also for an already-ended client.
		queueMicrotask(() => { if (!stopping) onFatal({ role: entry.role, reason }); });
	}
	return {
		attach(worker, role) {
			if (!CONSUMER_ROLES.includes(role) || entries.has(role)) throw new Error("invalid consumer role");
			const entry = { role, worker, state: "starting", active: 0, closing: stopping, lastFetchAt: null, lastSuccessAt: null, lastTakenAt: null, fetchMono: null, successMono: null };
			const success = () => { entry.lastSuccessAt = now(); entry.successMono = monotonic(); };
			const observer = observeConsumer(worker, {
				fetch: () => { entry.lastFetchAt = now(); entry.fetchMono = monotonic(); },
				success,
				taken: () => { entry.active++; entry.lastTakenAt = now(); success(); },
				finished: () => { entry.active--; },
				connection: () => { if (observer.connection() === "ended") fail(entry, "connection-ended"); },
			});
			entry.observer = observer;
			entries.set(role, entry);
			const close = worker.close.bind(worker);
			worker.close = (...args) => { entry.closing = true; observer.close(); return close(...args); };
			if (observer.connection() === "ended") fail(entry, "connection-ended");
			// Explicit run after listeners exist. The promise covers both an unexpected return and a rejection.
			const run = worker.run.bind(worker);
			// Resume invokes run again inside BullMQ. Supervise every invocation, not only the boot promise.
			worker.run = () => Promise.resolve().then(() => {
				if (entry.closing || stopping) return;
				entry.state = "running";
				return run();
			}).then(() => {
				if (!worker.isPaused?.()) fail(entry, "loop-ended");
			}, () => fail(entry, "loop-rejected"));
			entry.run = worker.run();
			return worker;
		},
		stop() {
			stopping = true;
			for (const entry of entries.values()) {
				entry.closing = true;
				entry.observer.close();
				// Local pause sets the pickup flag before its first await; it never pauses another host's queue.
				try { void Promise.resolve(entry.worker.pause?.(true)).catch(() => {}); } catch {}
			}
		},
		snapshot(startedAt) {
			const at = monotonic();
			const age = (value) => value === null ? null : Math.max(0, Math.floor(at - value));
			return JSON.stringify({ v: CONSUMER_HEALTH_VERSION, startedAt: Number(startedAt), rows: [...entries.values()].map((e) => ({
				role: e.role, state: e.state === "failed" ? "failed" : e.closing ? "closing" : e.worker.isPaused?.() ? "paused" : e.state,
				connection: e.observer.connection(), active: e.active, rateLimited: e.observer.rateLimited(),
				lastFetchAt: e.lastFetchAt, lastSuccessAt: e.lastSuccessAt, lastTakenAt: e.lastTakenAt,
				fetchAgeMs: age(e.fetchMono), successAgeMs: age(e.successMono),
			})) });
		},
	};
}

/** A broken queue may never finish close(). Bound the whole failure drain, not just its individual steps. */
export const CONSUMER_SHUTDOWN_MS = 30_000;
export function makeConsumerFailureShutdown({ stop, exit = (code) => process.exit(code), log = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, timeoutMs = CONSUMER_SHUTDOWN_MS }) {
	let task;
	return (fault) => task ??= (async () => {
		log("consumer_failed", fault);
		let timer;
		const expired = Symbol("expired");
		const result = await Promise.race([
			Promise.resolve().then(stop).catch(() => {}),
			new Promise((resolve) => { timer = setTimeoutFn(() => resolve(expired), timeoutMs); }),
		]);
		clearTimeoutFn(timer);
		if (result === expired) log("consumer_shutdown_timeout", { ms: timeoutMs });
		exit(1);
	})();
}
