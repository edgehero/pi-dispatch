/** Durable per-host kept-workspace snapshots. This operator-only display is never an admission authority (#771). */
import { parseSandboxes, sandboxManifestGeneration } from "./host-telemetry.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";
import { imageRefProblem } from "./image-ref.mjs";
import { BACKEND_NAMES } from "./backends.mjs";
import { jobSizeDefaults } from "./job-size.mjs";

export { sandboxManifestGeneration };
export const SANDBOX_INVENTORY_HOSTS = "sandbox:inventory:hosts";
export const sandboxInventoryKey = (host) => `sandbox:inventory:h:${host}`;
export const SANDBOX_INVENTORY_INTERVAL_MS = 60_000;
export const SANDBOX_INVENTORY_TTL_MS = 7 * 86_400_000;
export const SANDBOX_INVENTORY_HOSTS_MAX = 64;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;

function bounded(promise, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("sandbox inventory did not answer")), timeoutMs);
		Promise.resolve(promise).then((r) => { clearTimeout(timer); resolve(r); }, (e) => { clearTimeout(timer); reject(e); });
	});
}

/** Fields which let another host preview precisely its image/venue/size/egress, with no credential or host path. */
export function sandboxInventorySettings(raw) {
	if (!raw || typeof raw !== "object" || imageRefProblem(raw.image) || !BACKEND_NAMES.includes(raw.defaultBackend) || !Array.isArray(raw.backends) || raw.backends.some((v) => !BACKEND_NAMES.includes(v)) || typeof raw.egress !== "boolean" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(raw.egressProxy ?? "") || !integer(raw.sandboxRetentionHours) || !Number.isInteger(raw.sandboxPinDays) || raw.sandboxPinDays < 1) return null;
	try { jobSizeDefaults({ PI_JOB_MEMORY: raw.jobMemory, PI_JOB_CPUS: raw.jobCpus }); } catch { return null; }
	return { image: raw.image, defaultBackend: raw.defaultBackend, backends: [...raw.backends], egress: raw.egress, egressProxy: raw.egressProxy, sandboxRetentionHours: raw.sandboxRetentionHours, sandboxPinDays: raw.sandboxPinDays, ...(raw.jobMemory !== undefined ? { jobMemory: raw.jobMemory } : {}), ...(raw.jobCpus !== undefined ? { jobCpus: raw.jobCpus } : {}) };
}

export function makeSandboxInventory({ redis, host, read, settings = null, now = Date.now, log = () => {}, intervalMs = SANDBOX_INVENTORY_INTERVAL_MS, ttlMs = SANDBOX_INVENTORY_TTL_MS, timeoutMs = 2_000 } = {}) {
	if (!WORKER_NAME_RE.test(host ?? "") || typeof read !== "function") throw new Error("sandbox inventory requires a checked host and reader");
	let timer = null, closed = false, inFlight = null, failed = false;
	const publish = async () => {
		if (closed) return { closed: true };
		if (inFlight) return inFlight;
		inFlight = (async () => {
			try {
				let projection;
				try { projection = await read(); } catch { projection = {}; }
				const rows = parseSandboxes(projection?.sandboxes);
				const more = /^\d+$/.test(String(projection?.sandboxesMore ?? "")) ? Number(projection.sandboxesMore) : null;
				const retentionHours = /^\d+$/.test(String(projection?.sandboxRetentionHours ?? "")) ? Number(projection.sandboxRetentionHours) : null;
				const record = { version: 1, host, at: now(), rows, more: integer(more) ? more : null, retentionHours: integer(retentionHours) ? retentionHours : null, settings: sandboxInventorySettings(typeof settings === "function" ? settings() : settings) };
				await bounded(redis.set(sandboxInventoryKey(host), JSON.stringify(record), "PX", ttlMs), timeoutMs);
				if (!closed) await bounded(redis.sadd(SANDBOX_INVENTORY_HOSTS, host), timeoutMs);
				failed = false;
				return { published: true };
			} catch {
				if (!closed && !failed) log("sandbox_inventory_unreachable", { reason: "publish-failed" });
				failed = true;
				return { unreachable: true };
			}
		})();
		try { return await inFlight; } finally { inFlight = null; }
	};
	return { publish, start() { if (!timer && !closed) { void publish(); timer = setInterval(() => void publish(), intervalMs); timer.unref?.(); } return this; }, async close() { closed = true; if (timer) clearInterval(timer); timer = null; if (inFlight) await bounded(inFlight, timeoutMs).catch(() => {}); } };
}

export async function readSandboxInventories(redis, { now = Date.now, hosts = [], timeoutMs = 2_000, prune = false } = {}) {
	let indexed;
	try { indexed = await bounded(redis.smembers(SANDBOX_INVENTORY_HOSTS), timeoutMs); }
	catch { return { unreachable: true }; }
	const all = [...new Set([...(Array.isArray(indexed) ? indexed : []), ...hosts].filter((h) => typeof h === "string" && WORKER_NAME_RE.test(h)))].sort();
	const names = all.slice(0, SANDBOX_INVENTORY_HOSTS_MAX);
	if (!names.length) return { hosts: [], more: 0 };
	let values;
	try { values = await bounded(redis.mget(...names.map(sandboxInventoryKey)), timeoutMs); }
	catch { return { unreachable: true }; }
	const at = now();
	const records = names.map((name, i) => {
		let raw;
		try { if (typeof values[i] === "string" && values[i].length <= 64 * 1024) raw = JSON.parse(values[i]); } catch {}
		if (!raw || raw.version !== 1 || raw.host !== name || !integer(raw.at) || !(raw.more === null || integer(raw.more)) || !(raw.retentionHours === null || integer(raw.retentionHours))) return { name, unreadable: true, stale: true, missing: values[i] == null, rows: null, more: null, retentionHours: null, settings: null };
		const rows = parseSandboxes(raw.rows);
		const ageMs = Math.max(0, at - raw.at);
		return { name, at: raw.at, ageMs, stale: ageMs > 2 * SANDBOX_INVENTORY_INTERVAL_MS || at < raw.at - 30_000, unreadable: rows === null, rows, more: raw.more, retentionHours: raw.retentionHours, settings: sandboxInventorySettings(raw.settings) };
	});
	if (prune) {
		const missing = records.filter((r) => r.missing).map((r) => r.name);
		if (missing.length) await bounded(redis.srem(SANDBOX_INVENTORY_HOSTS, ...missing), timeoutMs).catch(() => {});
	}
	return { hosts: records, more: all.length - names.length };
}
