/** Host-bound control requests. This queue never enters the paid job processor or pi-jobs discovery (#771). */
import { Worker } from "bullmq";
import { createHash } from "node:crypto";
import { makeQueue } from "./queue.mjs";
import { assertJudgedConnection, onValkeyError } from "./connection.mjs";
import { TOKEN_NAME_RE } from "./console-tokens.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";
import { createSandboxPinHandler, newSandboxId, PREPARED_SANDBOX_ID_RE } from "./sandbox-prepare.mjs";
import { RELEASE_IF_MINE } from "./fleet-lease.mjs";

export const SANDBOX_PREPARE_REQUEST_TTL_MS = 30 * 60_000;
export const SANDBOX_PREPARE_PENDING_MAX = 32;
const RESULT_RETENTION_SECONDS = 7 * 86_400;
const REQUEST_OP_TIMEOUT_MS = 3_000;
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const refused = (reason, message) => ({ refused: reason, message });
const idOk = (id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(id);

export function sandboxPrepareQueueName(host) {
	if (!WORKER_NAME_RE.test(host ?? "")) throw new Error("sandbox control queue requires a checked host");
	return `pi-sandbox-prepare@${host}`;
}

export const sandboxPrepareSlotKey = (host, slot) => `sandbox:prepare:pending:${host}:${slot}`;
export function makeSandboxPrepareQueue(connection, { host } = {}) {
	return makeQueue(connection, { name: sandboxPrepareQueueName(host) });
}

/** Rebuild exactly the command's fields; no payload can add a token, image, executable or provider setting. */
export function sandboxPreparationRequest(raw) {
	if (!raw || !PREPARED_SANDBOX_ID_RE.test(raw.id ?? "") || !WORKER_NAME_RE.test(raw.host ?? "") || !TOKEN_NAME_RE.test(raw.by ?? "")) return refused("sandbox-request-invalid", "the sandbox request needs a checked id, host and operator name");
	const common = { op: raw.op ?? "prepare", id: raw.id, host: raw.host, by: raw.by };
	if (common.op === "prepare") {
		if (typeof raw.repo !== "string" || raw.repo.length > 300 || typeof raw.ref !== "string" || raw.ref.length > 200 || !Number.isInteger(raw.triggerIndex) || raw.triggerIndex < 0 || !/^[a-f0-9]{64}$/.test(raw.triggerDigest ?? "") || !/^[a-f0-9]{64}$/.test(raw.planDigest ?? "") || typeof raw.pin !== "boolean") return refused("sandbox-request-invalid", "the prepare request is missing its reviewed trigger and host plan");
		return { request: { ...common, repo: raw.repo, ref: raw.ref, triggerIndex: raw.triggerIndex, triggerDigest: raw.triggerDigest, planDigest: raw.planDigest, pin: raw.pin } };
	}
	if (common.op === "pin") {
		const expect = raw.expect;
		if (!idOk(raw.runId) || !expect || !/^[a-f0-9]{64}$/.test(expect.generation ?? "") || !(expect.until === null || (Number.isSafeInteger(expect.until) && expect.until >= 0)) || typeof expect.pin !== "boolean") return refused("sandbox-request-invalid", "the pin request needs the kept workspace's reviewed incarnation and deadline");
		return { request: { ...common, runId: raw.runId, expect: { generation: expect.generation, until: expect.until, pin: expect.pin } } };
	}
	return refused("sandbox-request-invalid", "the sandbox control request names an unknown operation");
}

function bounded(promise, timeoutMs = REQUEST_OP_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("sandbox request did not answer")), timeoutMs);
		Promise.resolve(promise).then((r) => { clearTimeout(timer); resolve(r); }, (e) => { clearTimeout(timer); reject(e); });
	});
}

async function releaseSlot(redis, request) {
	if (!Number.isInteger(request?.slot) || request.slot < 0 || request.slot >= SANDBOX_PREPARE_PENDING_MAX) return;
	await bounded(redis.eval(RELEASE_IF_MINE, 1, sandboxPrepareSlotKey(request.host, request.slot), request.id)).catch(() => {});
}

/** Thirty-two expiring individual claims bound pending work atomically, including concurrent console sessions. */
export async function enqueueSandboxPreparation(queue, raw, { now = Date.now } = {}) {
	const parsed = sandboxPreparationRequest({ ...raw, id: raw?.id ?? newSandboxId() });
	if (parsed.refused) return parsed;
	const request = parsed.request;
	if (queue.name !== sandboxPrepareQueueName(request.host)) return refused("sandbox-host-mismatch", "the request queue does not belong to the selected host");
	let redis, slot = null;
	try {
		const existing = await bounded(queue.getJob(request.id));
		if (existing) return digest(sandboxPreparationRequest(existing.data).request) === digest(request) ? { id: request.id, state: (await readSandboxPreparation(queue, request.id)).state, existing: true } : refused("sandbox-request-collision", "this request id already names another sandbox request");
		redis = await bounded(queue.client);
		for (let i = 0; i < SANDBOX_PREPARE_PENDING_MAX; i++) {
			const taken = await bounded(redis.set(sandboxPrepareSlotKey(request.host, i), request.id, "PX", SANDBOX_PREPARE_REQUEST_TTL_MS, "NX"));
			if (taken === "OK") { slot = i; break; }
		}
		if (slot === null) return refused("sandbox-preparation-full", "this host already has 32 pending sandbox requests; wait for one to finish");
		const stored = { ...request, requestedAt: now(), slot };
		await bounded(queue.add("sandbox-control", stored, { jobId: request.id, attempts: 2, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: { age: RESULT_RETENTION_SECONDS, count: 1_000 }, removeOnFail: { age: RESULT_RETENTION_SECONDS, count: 1_000 } }));
		const saved = await bounded(queue.getJob(request.id));
		const same = saved && digest(sandboxPreparationRequest(saved.data).request) === digest(request);
		if (!same) {
			await releaseSlot(redis, stored);
			return refused("sandbox-request-collision", "this request id already names another sandbox request");
		}
		// Two simultaneous identical adds can acquire different claims; the stored request owns only its own one.
		if (saved.data.slot !== slot) await releaseSlot(redis, stored);
		return { id: request.id, state: "pending" };
	} catch {
		// A timed-out add can still land on reconnect. Keep its claim until its expiry; report ambiguity with the id.
		return { id: request.id, state: "unknown", message: "the host request could not be confirmed; refresh its status before preparing again" };
	}
}

export async function readSandboxPreparation(queue, id) {
	if (!PREPARED_SANDBOX_ID_RE.test(id ?? "")) return { id, state: "unknown" };
	try {
		const job = await bounded(queue.getJob(id));
		if (!job) return { id, state: "unknown" };
		const parsed = sandboxPreparationRequest(job.data);
		if (parsed.refused || job.id !== id) return { id, state: "unknown" };
		const rawState = await bounded(job.getState());
		const base = { id, host: parsed.request.host, op: parsed.request.op };
		if (rawState === "completed") {
			const result = job.returnvalue;
			if (result?.refused) return { ...base, state: "refused", reason: result.refused, message: result.message };
			if (idOk(result?.id) && result?.host === base.host && Number.isSafeInteger(result.until) && typeof result.pinned === "boolean") return { ...base, state: "ready", result: { id: result.id, host: result.host, until: result.until, pinned: result.pinned, ...(typeof result.backend === "string" ? { backend: result.backend } : {}), ...(result.prepared === true ? { prepared: true } : {}), ...(/^[a-f0-9]{64}$/.test(result.generation ?? "") ? { generation: result.generation } : {}) } };
			return { ...base, state: "unknown" };
		}
		if (rawState === "failed") return { ...base, state: "failed", reason: "sandbox-infrastructure-failed", message: "sandbox preparation failed on its host; check the host's forge connection and disk, then prepare again" };
		return { ...base, state: rawState === "active" ? "preparing" : ["waiting", "prioritized", "delayed", "paused", "waiting-children"].includes(rawState) ? "pending" : "unknown" };
	} catch { return { id, state: "unknown", unreachable: true }; }
}

export async function listSandboxPreparations(queue, { limit = SANDBOX_PREPARE_PENDING_MAX } = {}) {
	try {
		const cap = Math.max(1, Math.min(SANDBOX_PREPARE_PENDING_MAX, limit));
		const jobs = await bounded(queue.getJobs(["active", "waiting", "delayed", "completed", "failed"], 0, cap));
		const rows = await Promise.all(jobs.slice(0, cap).map((j) => readSandboxPreparation(queue, j.id)));
		return { rows, more: jobs.length > cap };
	} catch { return { unreachable: true, rows: [] }; }
}

export function startSandboxPrepareWorker({ connection, host, prepare, pin = null, config = null, now = Date.now, Worker: WorkerClass = Worker, workerOptions = {}, log = () => {} } = {}) {
	assertJudgedConnection(connection);
	if (typeof prepare !== "function") throw new Error("sandbox control worker needs a preparer");
	const pinWorkspace = pin ?? (config ? createSandboxPinHandler({ config, now }) : null);
	const name = sandboxPrepareQueueName(host);
	const worker = new WorkerClass(name, async (job) => {
		const parsed = sandboxPreparationRequest(job.data);
		if (parsed.refused) return parsed;
		const request = parsed.request;
		if (request.host !== host) return refused("sandbox-host-mismatch", "the request reached another host; prepare it again on the selected host");
		const requestedAt = job.data.requestedAt;
		const redis = await worker.client;
		let release = true;
		try {
			if (!Number.isSafeInteger(requestedAt) || now() < requestedAt - 30_000 || now() - requestedAt > SANDBOX_PREPARE_REQUEST_TTL_MS) return refused("sandbox-request-expired", "the sandbox request waited too long; preview and prepare it again");
			if (request.op === "pin") return typeof pinWorkspace === "function" ? await pinWorkspace(request) : refused("sandbox-pin-unavailable", "this host cannot pin a workspace");
			return await prepare(request);
		} catch (error) {
			if (error?.piDispatchConfig) return refused("sandbox-config-invalid", "the host's sandbox configuration is invalid; run pi-dispatch doctor on that host");
			release = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 2);
			log("sandbox_preparation_failed", { id: request.id, reason: "infrastructure" });
			throw new Error("sandbox preparation infrastructure failed");
		} finally { if (release) await releaseSlot(redis, job.data); }
	}, { lockDuration: 30_000, ...workerOptions, connection, concurrency: 1, maxStalledCount: 1 });
	onValkeyError(worker, "sandbox control worker");
	return worker;
}
