import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, ensureJobsDir } from "./config.mjs";
import { readOverlay, resolveSettings } from "./runtime-settings.mjs";
import { readManifest, sandboxExpiry } from "./sandbox-store.mjs";
import { builtinModel, isBuiltinModel } from "./model-catalog.mjs";
import { resolveProviderCredential } from "./env-allowlist.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { makeRunContainer } from "./run-container.mjs";
import { makeLogSink, makeRecordWriter, buildRecord } from "./run-history.mjs";
import { materializePiDir } from "./materialize.mjs";
import { runJob } from "./processor.mjs";
import { dollarWindowCaps } from "./dollar-budget.mjs";
import { makeRedisClient, parseConnection } from "./connection.mjs";
import { makeQueue } from "./queue.mjs";
import { acquireCanaryLease, canaryQueueNames } from "./canary-lock.mjs";
import { MODEL_ROLE_RE } from "./model-roles.mjs";
import { parseTriggersDocument } from "./triggers.mjs";
import { CONTAINER_HOME } from "./container-spec.mjs";
import { readAuthPolicy } from "./subscription-config.mjs";

// env-internal PATH: host git executable lookup in a clean subprocess environment.
const exec = promisify(execFile);
// The same pinned artifact as deploy/docker-compose.yml. A contract test holds the copy to it.
export const CANARY_PROXY_IMAGE = "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";
const PROVIDER_HOSTS = Object.freeze({ anthropic: "api.anthropic.com", openai: "api.openai.com" });
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };

export function canaryProxyPolicy(provider) {
	const host = PROVIDER_HOSTS[provider];
	if (!host) fail("canary supports first-party anthropic and openai only; gateways and custom endpoints cannot establish a no-forge boundary");
	return `http_port 3128\naccess_log none\ncache_log /dev/null\npid_filename /tmp/squid.pid\nacl CONNECT method CONNECT\nacl tls port 443\nacl provider dstdomain ${host}\nacl private dst 0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ::1 ::/128 fc00::/7 fe80::/10\nhttp_access deny provider private\nhttp_access allow CONNECT tls provider\nhttp_access deny all\ncache deny all\n`;
}

/** Read regular files without following a job-authored link, bounded before allocating its contents. */
function regular(path, max = 8 * 1024 * 1024) {
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > max) fail("canary source contains an unsupported file");
		return fs.readFileSync(fd);
	} finally { fs.closeSync(fd); }
}

/** Only ordinary object files; no alternates, symlinks, hooks or original config enter the new repository. */
export function copyCanaryObjects(source, destination) {
	let bytes = 0, files = 0;
	function copy(from, to, relative = "") {
		if (!fs.lstatSync(from).isDirectory()) fail("canary source objects must be directories without links");
		fs.mkdirSync(to, { recursive: true, mode: 0o700 });
		for (const name of fs.readdirSync(from)) {
			if (!/^[A-Za-z0-9._-]+$/.test(name) || name === ".." || name === ".") fail("canary source has an invalid object path");
			const path = relative ? `${relative}/${name}` : name;
			if (path === "info/alternates" || path === "info/http-alternates") fail("canary source uses alternate object stores; retain a self-contained source");
			const src = join(from, name), dest = join(to, name), st = fs.lstatSync(src);
			if (st.isDirectory()) copy(src, dest, path);
			else {
				if (!st.isFile() || ++files > 100_000 || (bytes += st.size) > MAX_SOURCE_BYTES) fail("canary source object store is unsupported or too large");
				fs.writeFileSync(dest, regular(src, MAX_SOURCE_BYTES), { mode: 0o600 });
			}
		}
	}
	copy(source, destination);
}

function sourceFor(record, config, now) {
	const source = readManifest({ sandboxDir: config.sandboxDir, jobId: record.jobId });
	if (!source || source.jobId !== record.jobId || sandboxExpiry(source, { at: now(), retentionHours: config.sandboxRetentionHours }).expired) fail("a selected source sandbox is absent or expired; enable retention and run the flow again");
	if (source.backend !== "local" || !SHA.test(source.baseSha ?? "")) fail("a selected source has no retained base commit on the local venue; run the flow again with this version");
	if (!source.workspace || !fs.lstatSync(source.workspace).isDirectory() || !fs.lstatSync(join(source.workspace, ".git")).isDirectory()) fail("a selected source has no self-contained retained git repository");
	// These files were mounted read-only to the original job. Never reconstruct a task from its PII-free record.
	if (record.bundle || record.secretsProfile || record.session?.resumed === true || record.fork || record.recoveryOf) fail("canary cannot replay a source requiring secrets, a previous session, recovery or a fork");
	const roles = JSON.parse(regular(join(source.dir, "model-roles.json")));
	if (roles.version !== 1 || !roles.roles || !Object.hasOwn(roles.roles, record.modelRole)) fail("canary source has no retained role snapshot; run the flow again");
	return { ...source, roles: roles.roles, prompt: regular(join(source.dir, "prompt.md")), event: regular(join(source.dir, "event.json")) };
}

export async function createCanaryRuntime({ env, options, now = Date.now, execCommand = exec, redisFactory = makeRedisClient, queueFactory = makeQueue, imagePreflightFactory = makeImagePreflight, containerFactory = makeRunContainer, runJobFn = runJob }) {
	const config = loadConfig(env);
	if (config.authConnectionsFile) {
		let policy;
		try { policy = readAuthPolicy(config.authConnectionsFile); }
		catch { fail("canary cannot validate the subscription connection policy; fix the reviewed file before retrying"); }
		if (policy.bindings[splitModelEntry(options.model)?.provider]) fail("canary does not support a bound subscription connection; it cannot substitute an environment API key");
	}
	const settings = resolveSettings(config, readOverlay(config.settingsFile));
	if (settings.invalid) fail("canary settings overlay is invalid; run doctor");
	if (config.backends.length !== 1 || config.defaultBackend !== "local") fail("canary currently requires the local Docker venue");
	if (!process.getuid?.() || !process.getgid?.()) fail("canary requires a non-root local account");
	if (config.envelopeFile || config.scopedLimitsFile || config.pauseWindowsFile !== null || env.PI_HOST_MEMORY_BUDGET || env.PI_HOST_CPU_BUDGET || env.PI_HOST_RESERVE_MEMORY || env.PI_HOST_RESERVE_CPUS) fail("canary cannot bypass envelope, scoped, pause-window or host-capacity admission; use a deployment without those policies");
	if (env.PI_MODEL_ENDPOINTS_FILE) fail("canary cannot use declared custom endpoints; use a first-party-only deployment");
	if (!MODEL_ROLE_RE.test(options.role)) fail("canary role is invalid");
	let declared;
	try { declared = parseTriggersDocument(fs.readFileSync(config.triggersFile ?? "triggers.json", "utf8"), config.triggersFile ?? "triggers.json").modelRoles; }
	catch { fail("canary cannot read the reviewed modelRoles map; check triggers.json"); }
	if (!Object.values(declared ?? {}).some((map) => Object.hasOwn(map, options.role))) fail("canary role is not declared in modelRoles");
	const { provider, model } = splitModelEntry(options.model);
	const policy = canaryProxyPolicy(provider);
	const builtin = builtinModel(provider, model);
	if (!isBuiltinModel(provider, model, { chatOnly: true }) || new URL(builtin.baseUrl).hostname !== PROVIDER_HOSTS[provider]) fail("canary candidate must be a pinned first-party chat model");
	const credential = resolveProviderCredential({ provider, hostEnv: env, authFromPi: config.authFromPi });
	if (!credential || !Object.values(credential).some(Boolean)) fail("canary provider credential is missing; configure the first-party provider key");
	const providerEnv = credential;
	let records;
	try { records = fs.readdirSync(config.logsDir).filter((n) => /^[A-Za-z0-9._-]+\.json$/.test(n)).flatMap((n) => { try { return [JSON.parse(regular(join(config.logsDir, n), 256 * 1024))]; } catch { return []; } }); }
	catch { fail("canary run history cannot be read; run this command on the host retaining the originals"); }
	ensureJobsDir(config.jobsDir, { env });
	const root = fs.mkdtempSync(join(config.jobsDir, "canary-"));
	const name = `pi-dispatch-canary-${randomUUID()}`;
	const proxy = `${name}-proxy`, outNetwork = `${name}-out`;
	const run = async (args) => {
		try { return await execCommand("docker", args, { timeout: 30_000, maxBuffer: 1024 * 1024 }); }
		catch { fail("canary Docker operation failed; check the local daemon and pinned images"); }
	};
	let redis, queues = [], proxyMade = false, outMade = false, lease = null, renewTimer = null, leaseLost = false, interrupted = false;
	const active = new Set();
	const stops = new Set();
	const removeContainer = async (container) => {
		try { await run(["rm", "-f", container]); }
		catch {
			// --rm may already have removed it. Only a successful daemon listing proves absence.
			const listed = await run(["ps", "-aq", "--filter", `name=^/${container}$`]);
			if (listed.stdout.trim() !== "") fail("canary container remains after cleanup");
		}
	};
	const close = async () => {
		if (renewTimer) clearInterval(renewTimer);
		const leftovers = [];
		for (const container of active) await removeContainer(container).catch(() => leftovers.push(container));
		if (proxyMade) await removeContainer(proxy).catch(() => leftovers.push(proxy));
		if (outMade) await run(["network", "rm", outNetwork]).catch(() => leftovers.push(outNetwork));
		for (const queue of queues) await queue.close().catch(() => {});
		if (lease && !leftovers.length) await lease.release().catch(() => leftovers.push("canary lease (expires in 60 seconds)"));
		redis?.disconnect();
		if (leftovers.length) fail(`canary cleanup failed; remove these Docker resources before another experiment: ${leftovers.join(", ")}`);
		fs.rmSync(root, { recursive: true, force: true });
	};
	try {
		// Proxy validation and the model/image checks run before the first count or dollar reservation.
		await run(["image", "inspect", CANARY_PROXY_IMAGE]);
		const preflight = imagePreflightFactory({ image: config.jobImage });
		const checked = await preflight({ kind: "local", models: [options.model], maxCostMicros: 1 });
		if (!checked.ok || !["costCap", "modelPolicy", "modelRoles", "exitAuth", "anyUid"].every((c) => checked.capabilities?.includes(c))) fail("canary job image must declare costCap, modelPolicy, modelRoles, exitAuth and anyUid; rebuild the job image");
		redis = redisFactory(config.valkeyUrl, { failFast: true, lazyConnect: true });
		redis.on("error", () => {});
		if (typeof redis.connect === "function") await redis.connect();
		await redis.ping();
		lease = await acquireCanaryLease(redis);
		if (!lease) fail("another canary owns the deployment admission lease; wait for it to finish");
		const loseLease = () => { leaseLost = true; for (const stop of stops) stop(); };
		renewTimer = setInterval(() => { void lease.renew().then((ok) => { if (!ok) loseLease(); }, loseLease); }, 10_000);
		queues = (await canaryQueueNames(redis)).map((name) => queueFactory(parseConnection(config.valkeyUrl, { failFast: true }), { name }));
		for (const queue of queues) if ((await queue.getJobCounts("active")).active !== 0) fail("canary refused while jobs are active; wait for those runs to finish");
		const unpaused = async () => {
			if (interrupted) fail("canary experiment was stopped; no further replay was started");
			if (leaseLost || !await lease.renew()) { loseLease(); fail("canary lost its admission lease; the experiment was stopped"); }
			for (const queue of queues) if (await queue.isPaused()) fail("canary refused while dispatch is paused; resume it explicitly first");
		};
		await unpaused();
		const sink = makeLogSink({ logsDir: config.logsDir, enabled: false });
		const writer = makeRecordWriter({ logsDir: config.logsDir });
		const createProxy = async () => {
			if (proxyMade) return;
			fs.writeFileSync(join(root, "squid.conf"), policy, { mode: 0o644 });
			await run(["network", "create", outNetwork]); outMade = true;
			await run(["run", "--pull=never", "--rm", "-d", "--name", proxy, "--network", outNetwork, "--user", "proxy", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--entrypoint", "/usr/sbin/squid", "--mount", `type=bind,source=${join(root, "squid.conf")},target=/etc/squid/squid.conf,readonly`, CANARY_PROXY_IMAGE, "-f", "/etc/squid/squid.conf", "-NYC"]); proxyMade = true;
			await run(["exec", proxy, "squid", "-k", "parse"]);
		};
		const prepareSource = async (source) => {
			const jobDir = fs.mkdtempSync(join(root, "job-")), workspace = join(jobDir, "workspace");
			const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
			const git = async (args) => { try { return await execCommand("git", args, { env: gitEnv, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); } catch { fail("canary base commit cannot be restored from its retained object store"); } };
			fs.mkdirSync(workspace);
			await git(["init", "--template=", workspace]);
			copyCanaryObjects(join(source.workspace, ".git", "objects"), join(workspace, ".git", "objects"));
			await git(["-C", workspace, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", source.baseSha]);
			fs.writeFileSync(join(jobDir, "prompt.md"), source.prompt, { mode: 0o400 });
			fs.writeFileSync(join(jobDir, "event.json"), source.event, { mode: 0o400 });
			const materialized = await materializePiDir({ gitDir: workspace, sha: source.baseSha, destDir: jobDir });
			if (materialized.outcome === "policy") fail("canary base instructions exceed the materializer limits");
			try { regular(join(jobDir, "pi", "skills", options.flow, "SKILL.md")); }
			catch { fail("canary flow must be present in the retained base repository; injected and overlay-only flows are unsupported"); }
			return { ...source, prepared: { jobDir, workspace, sha: source.baseSha } };
		};
		return {
			records, deploymentCapUsd: settings.maxCostUsd, close,
			inspectSource: async (record) => {
				const source = sourceFor(record, config, now);
				for (const entry of Object.values({ ...source.roles, [options.role]: options.model })) {
					const ref = splitModelEntry(entry);
					if (ref.provider !== provider || !isBuiltinModel(ref.provider, ref.model, { chatOnly: true }) || new URL(builtinModel(ref.provider, ref.model).baseUrl).hostname !== PROVIDER_HOSTS[provider]) fail("canary source roles need endpoints outside the isolated provider policy; use a single first-party provider");
				}
				return prepareSource(source);
			},
			execute: async ({ source, original, jobId, maxCostMicros }) => {
				await unpaused();
				await createProxy();
				const { jobDir, workspace } = source.prepared;
				const modelRoles = { ...source.roles, [options.role]: options.model };
				const job = { kind: "local", folder: workspace, flow: options.flow, provider, model, modelRole: options.role, modelRoles, models: [...new Set([options.model, ...Object.values(modelRoles)])], maxCostMicros, maxTurns: settings.maxTurns, maxTokens: settings.maxTokens, packages: false, canary: { sourceJobId: original.jobId, role: options.role, candidate: options.model } };
				const startedAt = new Date(now()).toISOString();
				let result, error;
				try {
					const runContainer = containerFactory({ image: config.jobImage, hostEnv: providerEnv, allowGlobalExtensions: false, packagePaths: [], egress: true, egressProxy: proxy, onOutput: () => {}, openJobLog: sink });
					result = await runJobFn(job, { redis, caps: { day: settings.dailyCap, week: settings.weeklyCap, month: settings.monthlyCap }, softHoldPct: settings.softHoldPct, tokenCap: settings.dailyTokenCap, dollarCaps: dollarWindowCaps(settings), now: new Date(now()), imagePreflight: async () => checked, checkProviderCredential: () => ({ ok: true }), prepareWorkspace: async () => ({ jobDir, workspace, sha: source.baseSha }), runContainer: async (args) => {
						const controller = new AbortController();
						const stop = () => { interrupted = true; if (!controller.signal.aborted) { controller.abort(); void run(["stop", "-t", "5", jobId]).catch(() => {}); } };
						stops.add(stop);
						const timer = setTimeout(stop, 30 * 60_000);
						const pausePoll = setInterval(() => { void unpaused().catch(stop); }, 1000);
						process.once("SIGINT", stop); process.once("SIGTERM", stop);
						active.add(jobId);
						try { return await runContainer({ ...args, name: jobId, signal: controller.signal, exitAuth: true, jobId, user: `${process.getuid()}:${process.getgid()}`, home: CONTAINER_HOME }); }
						finally { stops.delete(stop); clearTimeout(timer); clearInterval(pausePoll); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await removeContainer(jobId).then(() => active.delete(jobId), () => {}); }
					}, comment: async () => {}, collectChain: async () => ({ enqueued: 0, refused: 0 }), cleanup: async () => {} });
					if (result) result = { ...result, modelRole: options.role };
					return result;
				} catch (e) { error = e; throw new Error("canary replay failed; inspect its run record before retrying"); }
				finally {
					await writer(buildRecord({ job: { id: jobId, data: job }, result, error, startedAt, endedAt: new Date(now()).toISOString(), host: config.workerName, defaultBackend: "local" }));
					if (!active.has(jobId)) fs.rmSync(jobDir, { recursive: true, force: true });
				}
			},
		};
	} catch (error) { await close(); throw error; }
}
