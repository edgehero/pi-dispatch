/** Closed host-side setup operations. HTTP never chooses a program, argv, directory or environment (#774). */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentServiceEnv } from "./service-env.mjs";
import { ENV_WRITER_FS, planEnvEdit, readEnvAssignments, updateEnvFile } from "./env-file.mjs";
import { planServiceSetup, runService } from "./service.mjs";
import { apiKeyVariable, needsHostAuthentication, nonApiKeyKind } from "./provider-key.mjs";
import { resolveSetupWorkerEntry } from "./setup-host-entry.mjs";
import { SETUP_LIMITS, SETUP_VERSION, validSetupRequest } from "./setup-contract.mjs";
import { acquireSetupLock } from "./setup-lock.mjs";
import { providerFrom, settingsFilePath, workerName } from "./config.mjs";
import { readOverlay } from "./runtime-settings.mjs";

const hash = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
function failure(reason) { return { refusal: reason }; }

function sourceSnapshot(path, ctx) {
	let fd;
	try {
		// Check the spelling as well as its target: an untrusted parent must not be able to
		// redirect the settings/policy read between preview and the credential rename.
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			let st;
			try { st = ctx.fs.lstatSync(parent); } catch (e) { if (e?.code !== "ENOENT") throw e; }
			if (st && (!st.isDirectory() || (st.uid !== ctx.uid && st.uid !== 0) || ((st.mode & 0o022) && !(st.mode & 0o1000)))) return failure("env-unsafe");
			if (parent === dirname(parent)) break;
		}
		const st = ctx.fs.lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink() || (st.uid !== ctx.uid && st.uid !== 0) || (st.mode & 0o022) || st.size > 1024 * 1024) return failure("env-unsafe");
		fd = ctx.fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK);
		const opened = ctx.fs.fstatSync(fd);
		if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || (opened.uid !== ctx.uid && opened.uid !== 0) || (opened.mode & 0o022) || opened.size > 1024 * 1024) return failure("env-unsafe");
		const bytes = ctx.fs.readFileSync(fd);
		if (bytes.length > 1024 * 1024) return failure("env-unsafe");
		return { path, digest: hash({ bytes: hash(bytes), dev: opened.dev, ino: opened.ino, mode: opened.mode, uid: opened.uid }), bytes };
	} catch (e) { return e?.code === "ENOENT" ? { path, digest: null, bytes: null } : failure("env-unsafe"); }
	finally { if (fd !== undefined) ctx.fs.closeSync(fd); }
}

/** One judged descriptor, so a FIFO/symlink or another account's file is never a setup input. */
function privateEnv(dir, { fs, uid }) {
	const path = join(dir, ".env");
	let fd;
	try {
		const st = fs.lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) return failure("env-unsafe");
		fd = fs.openSync(path, (fs.constants?.O_RDONLY ?? nodeFs.constants.O_RDONLY) | (fs.constants?.O_NOFOLLOW ?? nodeFs.constants.O_NOFOLLOW));
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.uid !== uid || (opened.mode & 0o077) !== 0) return failure("env-unsafe");
		const bytes = fs.readFileSync(fd);
		if (bytes.length > 1024 * 1024) return failure("env-unsafe");
		return { path, bytes, identity: { dev: opened.dev, ino: opened.ino, mode: opened.mode, uid: opened.uid }, digest: hash(bytes) };
	} catch { return failure("env-unsafe"); } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function providerPlan(request, ctx, envRead) {
	const keys = ["PI_PROVIDER", "PI_AUTH_CONNECTIONS_FILE", "PI_SETTINGS_FILE", "PI_AUTH_FROM_PI", "PI_CODING_AGENT_DIR"];
	const declared = deploymentServiceEnv({ env: {}, dir: ctx.dir, keys, fs: ctx.fs, uid: ctx.uid, platform: ctx.platform });
	if (declared.untrusted || declared.unreadable || declared.hazardSkipped?.length || declared.unread?.length) return failure("env-unsafe");
	const configured = { ...Object.fromEntries(keys.filter((key) => typeof ctx.env[key] === "string").map((key) => [key, ctx.env[key]])), ...declared.env };
	const settingsPath = resolve(ctx.dir, settingsFilePath(configured, ctx.serviceDeps.home));
	const settings = sourceSnapshot(settingsPath, ctx);
	if (settings.refusal) return settings;
	const loaded = readOverlay(settingsPath, { fs: { readFileSync: () => { if (settings.bytes === null) throw Object.assign(new Error(), { code: "ENOENT" }); return String(settings.bytes); } } });
	if (loaded.invalid) return failure("env-unsafe");
	let provider;
	try { provider = request.input?.provider ?? loaded.overlay.provider ?? providerFrom(configured); } catch { return failure("provider-unsupported"); }
	const providers = await ctx.providerNames();
	if (!providers.includes(provider)) return failure("provider-unsupported");
	if (needsHostAuthentication(provider)) return failure("provider-host-auth");
	const candidates = await ctx.providerCandidates(provider);
	const key = apiKeyVariable(candidates);
	if (!key || nonApiKeyKind(key) !== null || (request.input?.key !== undefined && request.input.key !== key)) return failure("provider-unsupported");
	const aliases = [];
	for (const name of providers) {
		const candidate = apiKeyVariable(await ctx.providerCandidates(name));
		if (candidate === key && nonApiKeyKind(candidate) === null) aliases.push(name);
	}
	aliases.sort();
	const mode = request.operation === "setup-provider-key-replace" ? "replace" : "add";
	// A managed policy is deliberately not changed here. Its precedence belongs to the reviewed auth path.
	const sources = [settings];
	if (configured.PI_AUTH_CONNECTIONS_FILE) {
		const policy = sourceSnapshot(resolve(ctx.dir, configured.PI_AUTH_CONNECTIONS_FILE), ctx);
		if (policy.refusal || policy.bytes === null) return failure("env-unsafe");
		try {
			const { parseAuthConnections } = await import("./auth-connections.mjs");
			const config = parseAuthConnections(String(policy.bytes));
			if (config.bindings[provider]) return failure("provider-managed");
		} catch { return failure("env-unsafe"); }
		sources.push(policy);
	}
	if (candidates.some((name) => typeof ctx.env[name] === "string" && ctx.env[name] !== "")) return failure("provider-shadowed");
	const present = deploymentServiceEnv({ env: {}, dir: ctx.dir, keys: candidates, fs: ctx.fs, uid: ctx.uid, platform: ctx.platform });
	if (present.untrusted || present.unreadable || present.hazardSkipped?.length || present.unread?.length) return failure("env-unsafe");
	if (candidates.some((name) => name !== key && Boolean(present.env[name]))) return failure("provider-shadowed");
	if (String(envRead.bytes).split("\n").filter((line) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`).test(line)).length > 1) return failure("env-unsafe");
	const assigned = typeof present.env[key] === "string" && present.env[key] !== "";
	if (mode === "add" && assigned) return failure("key-present");
	if (mode === "replace" && !assigned) return failure("key-missing");
	let source = assigned ? "deployment-env" : "none";
	if (!assigned && configured.PI_AUTH_FROM_PI !== "0") {
		// Only identify the declaration being superseded. Its value never leaves this child,
		// and this does not claim the provider has accepted or can spend with that credential.
		const agentDir = resolve(ctx.dir, configured.PI_CODING_AGENT_DIR || join(ctx.serviceDeps.home, ".pi", "agent"));
		const login = sourceSnapshot(join(agentDir, "auth.json"), ctx);
		if (login.refusal) return login;
		if (login.bytes !== null) {
			let auth;
			try { auth = JSON.parse(String(login.bytes)); } catch { return failure("env-unsafe"); }
			if (!auth || typeof auth !== "object" || Array.isArray(auth)) return failure("env-unsafe");
			const entry = Object.hasOwn(auth, provider) ? auth[provider] : null;
			if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim() !== "") source = "pi-api-key";
		}
		sources.push(login);
	}
	// A single loader-proven empty quoted assignment needs the overwrite transform too:
	// the generic never-clobber transform deliberately preserves even an explicit "".
	const overwrite = mode === "replace" || typeof present.env[key] === "string";
	const plan = planEnvEdit(envRead.bytes, envRead.path, key, "setup-preview-placeholder", { platform: ctx.platform, overwrite });
	if (plan.error || (mode === "add" && !plan.changed)) return failure("env-unsafe");
	return { component: "provider", provider, key, mode, aliases, source, overwrite, effects: ["write-provider-key"], inputs: { provider, key, mode, aliases, source, env: envRead.digest, identity: envRead.identity, config: configured, sources: sources.map(({ path, digest }) => ({ path, digest })) }, sources, envRead };
}

async function makePlan(request, ctx) {
	const envRead = privateEnv(ctx.dir, ctx);
	if (envRead.refusal) return envRead;
	if (["setup-provider-key", "setup-provider-key-replace"].includes(request.operation)) return providerPlan(request, ctx, envRead);
	if (request.operation === "setup-egress-start") {
		const { planSetupEgress } = await import("./setup-egress.mjs");
		const got = await planSetupEgress(ctx);
		return got.refusal ? got : { ...got, component: "egress", inputs: { ...got.inputs, env: envRead.digest } };
	}
	if (request.operation === "setup-doctor") return { component: "doctor", effects: ["publish-doctor"], inputs: { env: envRead.digest } };
	const [, component, operation] = /^setup-(worker|receiver)-(install|start|stop|restart)$/.exec(request.operation) ?? [];
	if (!component) return failure("invalid-request");
	const argv = [operation, ...(component === "receiver" ? ["--receiver"] : [])];
	const planned = await ctx.servicePlan(argv, ctx.serviceDeps);
	if (!planned || typeof planned !== "object") return failure("unavailable");
	if (planned.refusal) return planned;
	return { component, effects: planned.effects, inputs: { env: envRead.digest, unit: planned }, service: { argv, planned } };
}

/** Injectable worker boundary; production callers enter through the fixed CLI's stdin only. */
export async function runSetupHost(request, deps = {}) {
	const base = { version: SETUP_VERSION, id: /^[a-f0-9]{32}$/.test(request?.id ?? "") ? request.id : "0".repeat(32), operation: request?.operation };
	const answer = (state, reason, extra = {}) => ({ ...base, state, reason, ...extra });
	if (!validSetupRequest(request)) return answer("refused", "invalid-request");
	const fs = deps.fs ?? nodeFs;
	const platform = deps.platform ?? process.platform;
	const uid = deps.uid ?? process.geteuid?.();
	const env = deps.env ?? process.env;
	let dir;
	try {
		dir = fs.realpathSync(deps.cwd ?? process.cwd());
		const st = fs.statSync(dir);
		if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022)) return answer("refused", "unsafe-deployment");
	} catch { return answer("refused", "unsafe-deployment"); }
	if (!["linux", "darwin"].includes(platform) || (platform === "darwin" && uid === 0)) return answer("refused", "unsupported");
	const entry = (deps.resolveEntry ?? resolveSetupWorkerEntry)();
	if (!entry?.entry) return answer("refused", "unsafe-entry");
	const serviceDeps = { env, cwd: dir, platform, euid: uid, fs, home: deps.home ?? homedir(), moduleDir: dirname(entry.entry), ...(deps.serviceDeps ?? {}) };
	const ctx = { dir, fs, uid, platform, env, serviceDeps, servicePlan: deps.servicePlan ?? planServiceSetup, runService: deps.runService ?? runService, ...(deps.egressDeps ?? {}), providerCandidates: deps.providerCandidates ?? (async (provider) => (await import("./env-allowlist.mjs")).providerKeyCandidates(provider)), providerNames: deps.providerNames ?? (async () => (await import("./env-allowlist.mjs")).piProviders()) };
	let lock;
	try {
		if (request.phase === "apply") {
			lock = acquireSetupLock(dir, { fs, uid });
			if (lock.refusal) return answer("refused", lock.refusal);
		}
		const plan = await makePlan(request, ctx);
		if (plan.refusal) return answer("refused", plan.refusal);
		const workerRead = deploymentServiceEnv({ env: {}, dir, keys: ["PI_WORKER_NAME"], fs, uid, platform });
		if (workerRead.untrusted || workerRead.unreadable || workerRead.unread?.length || workerRead.hazardSkipped?.length) return answer("refused", "unsafe-deployment");
		const registeredName = workerName({ ...env, ...workerRead.env });
		const digest = hash({ operation: request.operation, entry: entry.entry, uid, dir, registeredName, inputs: plan.inputs });
		const publicPlan = { digest, component: plan.component, manager: platform === "linux" ? "systemd" : "launchd", host: String((deps.hostname ?? hostname)()).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64), workerName: registeredName, account: String(deps.account ?? userInfo().username).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64), effects: plan.effects, ...(plan.key ? { key: plan.key, provider: plan.provider, mode: plan.mode, aliases: plan.aliases, source: plan.source } : {}) };
		if (request.phase === "plan") return answer("planned", "ready", { plan: publicPlan });
		if (request.phase === "status") return answer(plan.service?.planned.active ? "applied" : "unchanged", "ready", { plan: publicPlan });
		if (request.expected !== digest) return answer("refused", "plan-stale");
		if (plan.component === "provider") {
			const value = request.input?.value;
			if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > SETUP_LIMITS.keyBytes || /[\u0000-\u0020\u007f$`]/.test(value) || value.startsWith("!") || value.includes("sk-ant-oat")) return answer("refused", "key-invalid");
			const before = plan.envRead;
			const overwrite = plan.overwrite;
			const edit = planEnvEdit(before.bytes, before.path, plan.key, value, { platform, overwrite });
			if (edit.error) return answer("refused", "key-invalid");
			const expectedInputs = () => {
				const current = privateEnv(dir, ctx);
				if (current.refusal || hash(current.identity) !== hash(before.identity) || current.digest !== before.digest || plan.sources.some((source) => { const current = sourceSnapshot(source.path, ctx); return current.refusal || current.digest !== source.digest; })) throw Object.assign(new Error("stale setup input"), { code: "SETUP_STALE" });
			};
			const guardedFs = { ...ENV_WRITER_FS, ...fs, readFileSync(path, ...args) {
				if (path !== before.path) return fs.readFileSync(path, ...args);
				// The writer must transform the exact judged bytes. Rereading this pathname
				// could copy a transient competing edit even if the old file is restored later.
				expectedInputs();
				return Buffer.from(before.bytes);
			}, renameSync(from, to) {
				expectedInputs();
				fs.renameSync(from, to);
			} };
			let saved;
			try { saved = updateEnvFile(before.path, plan.key, value, { fs: guardedFs, platform, narrow: true, overwrite }); }
			catch (e) { return answer(e?.code === "SETUP_STALE" ? "refused" : "unknown", e?.code === "SETUP_STALE" ? "plan-stale" : "process-failed"); }
			return answer(saved.changed ? "applied" : "unchanged", "ready", { effects: saved.changed ? plan.effects : [] });
		}
		if (plan.component === "doctor") {
			const doctor = deps.runDoctor ?? (await import("./doctor.mjs")).runDoctor;
			let published = false;
			const doctorOpts = { cwd: dir, setupReadOnly: true, publish: true, out: () => {}, writeErr: () => {}, ...(deps.doctorDeps ?? {}), publishDoctor: async (...args) => { const writer = deps.publishDoctor ?? (await import("./doctor.mjs")).defaultPublishDoctor; const result = await writer(...args); published = result?.published === true || result?.ok === true || result === undefined; return result; } };
			await doctor(env, doctorOpts);
			return answer(published ? "applied" : "partial", published ? "doctor-published" : "doctor-incomplete", { effects: plan.effects });
		}
		if (plan.component === "egress") {
			const { applySetupEgress } = await import("./setup-egress.mjs");
			const result = await applySetupEgress(plan, ctx);
			return answer(result.state, result.reason, { effects: result.effects ?? [] });
		}
		const code = await ctx.runService(plan.service.argv, { ...serviceDeps, setupExpected: plan.service.planned, out: () => {}, err: () => {} });
		const readback = await ctx.servicePlan(["start", ...(plan.component === "receiver" ? ["--receiver"] : [])], serviceDeps);
		const wanted = plan.service.argv[0] !== "stop";
		if (!readback?.refusal && Boolean(readback.active) === wanted) return answer(code === 0 ? "applied" : "partial", code === 0 ? "ready" : "process-failed", { effects: plan.effects });
		return answer("unknown", code === 0 ? "readback-unavailable" : "process-failed", { effects: plan.effects });
	} catch { return answer(request.phase === "apply" ? "unknown" : "refused", "unavailable"); }
	finally { lock?.release?.(); }
}

export async function runSetupHostCli({ input = process.stdin, out = (text) => process.stdout.write(text), ...deps } = {}) {
	let bytes = 0;
	const chunks = [];
	try {
		for await (const chunk of input) { bytes += Buffer.byteLength(chunk); if (bytes > SETUP_LIMITS.inputBytes) return 2; chunks.push(Buffer.from(chunk)); }
		const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!validSetupRequest(request)) return 2;
		const result = await runSetupHost(request, deps);
		out(`${JSON.stringify(result)}\n`);
		return result.state === "refused" ? 2 : 0;
	} catch { return 2; }
}
