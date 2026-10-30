import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { execDockerBounded } from "./backend-local.mjs";
import { makeRedisClient } from "./connection.mjs";
import { networkNameFor, removeJobNetwork } from "./egress.mjs";
import { stopSandbox } from "./sandbox.mjs";
import { SANDBOX_SESSION_LABEL, SANDBOX_SESSION_POLL_MS, parseSandboxSession, publishSandboxNotice, sandboxBounded, sandboxNoticeKey, sandboxSessionAccount, sandboxSessionKey, sandboxSessionTick } from "./sandbox-sessions.mjs";

/** Inspect distinguishes a missing container from a daemon that could not answer. No stderr is published. */
export async function inspectSandboxSession({ bin, name, run = execDockerBounded }) {
	let answer;
	try { answer = await run(["inspect", name], { bin, timeoutMs: 5_000, withStderr: true }); } catch { return { unknown: true }; }
	if (answer.code !== 0) return /no such (?:container|object)|no container with (?:name|ID)/i.test(answer.stderr ?? "") ? { present: false } : { unknown: true };
	try {
		const list = JSON.parse(answer.stdout);
		const c = Array.isArray(list) ? list[0] : null;
		if (!/^[a-f0-9]{64}$/.test(c?.Id ?? "")) return { unknown: true };
		return { present: true, running: c.State?.Running === true, containerId: c.Id, nonce: c.Config?.Labels?.[SANDBOX_SESSION_LABEL] ?? null, networks: Object.keys(c.NetworkSettings?.Networks ?? {}), proxy: c.Config?.Labels?.["org.pi-dispatch.sandbox-proxy"] ?? null };
	} catch { return { unknown: true }; }
}

/** A private monitor owns its network after ready. It survives detach and the terminal's death. */
export function makeSandboxMonitor({ env = process.env, config, by, spawnMonitor = fork, now = Date.now } = {}) {
	return async ({ resolved, args, network, runtime, admittedRuntime = null, existing = null }) => {
		const nonce = existing?.nonce ?? randomBytes(16).toString("hex");
		// The image is last in both sandbox builders. Put a label into the runtime argv, never an env variable.
		if (args) args.splice(args.length - 1, 0, "--label", `${SANDBOX_SESSION_LABEL}=${nonce}`, ...(network ? ["--label", `org.pi-dispatch.sandbox-proxy=${config.egressProxy}`] : []));
		const child = spawnMonitor(new URL("./sandbox-session-monitor.mjs", import.meta.url), [], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env });
		const account = sandboxSessionAccount(by ?? (() => { try { return userInfo().username; } catch { return "operator"; } })());
		const metadata = { host: config.workerName, id: String(resolved.manifest.jobId), venue: resolved.venue, name: resolved.name, nonce, by: account, since: existing?.since ?? now(), network, proxy: existing?.proxy ?? config.egressProxy, bin: runtime, valkeyUrl: config.valkeyUrl, admittedRuntime };
		try {
			await sandboxBounded(new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", () => reject(new Error("sandbox monitor exited before ready")));
				child.once("message", (message) => message?.ready === true ? resolve() : reject(new Error("sandbox tracking is unavailable")));
				child.send(metadata);
			}), 5_000);
		} catch {
			child.kill();
			throw new Error("Sandbox tracking is unavailable. Check Valkey before opening a shell.");
		}
		child.unref();
		child.channel?.unref();
		return { ownsNetwork: true, finish: () => { if (child.connected) child.send({ foregroundDone: true }); } };
	};
}

/** Reattach can repair a dead monitor only after the runtime confirms the immutable labelled incarnation. */
export async function ensureSandboxMonitor({ resolved, runtime, state, admittedRuntime = null, config, env = process.env, by, now = Date.now, makeClient = makeRedisClient, monitor = makeSandboxMonitor({ env, config, by, now }) }) {
	let redis;
	try {
		redis = makeClient(config.valkeyUrl, { failFast: true, lazyConnect: true, disconnectTimeoutMs: 0 });
		redis.on("error", () => {});
		await sandboxBounded(redis.connect(), 3_000);
		const current = parseSandboxSession(await sandboxBounded(redis.get(sandboxSessionKey(config.workerName, resolved.manifest.jobId))));
		if (current?.nonce === state.nonce && current?.containerId === state.containerId) return { tracked: true };
		const network = state.networks?.includes(networkNameFor(resolved.name)) ? networkNameFor(resolved.name) : null;
		if (network && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(state.proxy ?? "")) throw new Error("original egress proxy is unknown");
		await monitor({ resolved, runtime, args: null, network, admittedRuntime, existing: { nonce: state.nonce, since: current?.since ?? now(), proxy: state.proxy } });
		return { tracked: true, recovered: true };
	} finally { redis?.disconnect(); }
}

export async function watchSandboxSession({ metadata, redis, inspect = (name) => inspectSandboxSession({ bin: metadata.bin, name }), stop = (name) => stopSandbox({ bin: metadata.bin, name }), cleanup = async () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), foregroundDone = () => false, report = () => {} }) {
	let session = null;
	let absent = 0;
	for (;;) {
		try {
			if (!session) {
				const found = await inspect(metadata.name);
				if (found.unknown) { await sleep(SANDBOX_SESSION_POLL_MS); continue; }
				if (!found.present) {
					if (++absent >= 30 || foregroundDone()) break;
					await sleep(SANDBOX_SESSION_POLL_MS); continue;
				}
				if (found.nonce !== metadata.nonce) return { refused: "container-changed" };
				session = { v: 1, host: metadata.host, id: metadata.id, nonce: metadata.nonce, containerId: found.containerId, venue: metadata.venue, by: metadata.by, since: metadata.since, at: now() };
			}
			const result = await sandboxSessionTick({ redis, session, inspect, stop, now });
			if (result.unknown) await report("runtime-unreadable");
			if (result.gone) break;
			if (result.refused) return result;
		} catch {
			// No acknowledgement on a failed read or stop. The lease expires and the next good tick can recover.
			await report("runtime-unreadable");
		}
		await sleep(SANDBOX_SESSION_POLL_MS);
	}
	// A new open cannot reuse this network until it is removed; still inspect the name so a replacement is kept.
	const last = await inspect(metadata.name);
	if (!last.unknown && !last.present) {
		try { if (await cleanup() === false) await report("network-kept"); }
		catch { await report("network-cleanup-failed"); }
	} else if (metadata.network) await report("network-kept");
	return { gone: true };
}

export async function runSandboxSessionMonitor({ metadata, redis, ready = () => {}, foregroundDone = () => false, watchOptions = {}, removeNetwork = removeJobNetwork }) {
	await sandboxBounded(redis.connect().then(() => redis.ping()), 3_000);
	// Clearing an old diagnostic is best effort and precedes the launch handshake. An outage here must not
	// kill a monitor after it told the parent that a shell could start (#771).
	await sandboxBounded(redis.del(sandboxNoticeKey(metadata.host, metadata.id)), 500).catch(() => {});
	ready({ ready: true });
	let said = null;
	const report = async (reason) => { if (said === reason) return; try { await publishSandboxNotice(redis, { host: metadata.host, id: metadata.id, reason }); said = reason; } catch {} };
	return watchSandboxSession({ metadata, redis, foregroundDone, report, ...watchOptions, cleanup: async () => {
		if (metadata.network) return removeNetwork(spawn, { network: metadata.network, proxy: metadata.proxy, bin: metadata.bin, ...(metadata.admittedRuntime ? { readRuntime: async () => metadata.admittedRuntime } : {}), onRefused: () => {} });
		return true;
	} });
}

export async function monitorMain() {
	let finished = false;
	process.on("message", (m) => { if (m?.foregroundDone) finished = true; });
	const metadata = await new Promise((resolve) => process.once("message", resolve));
	let redis;
	try {
		redis = makeRedisClient(metadata.valkeyUrl, { noOfflineQueue: true, lazyConnect: true, disconnectTimeoutMs: 0 });
		redis.on("error", () => {});
		await runSandboxSessionMonitor({ metadata, redis, foregroundDone: () => finished, ready: (message) => { if (process.connected) process.send?.(message); } });
	} catch { if (process.connected) process.send?.({ ready: false }); }
	finally { redis?.disconnect(); if (process.connected) process.disconnect?.(); }
}
