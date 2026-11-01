/** Start-only proxy planning, reusing the shipped argv and Quadlet installer; never a browser `up` pass. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentServiceEnv } from "./service-env.mjs";
import { egressArmed, egressProxyName, DEFAULT_EGRESS_PROXY } from "./egress.mjs";
import { venuesOf } from "./backends.mjs";
import { makeDockerEndpointResolver } from "./backend-local.mjs";
import { makePodmanInfoReader, decidePodmanJobUser } from "./backend-podman.mjs";
import { EGRESS_NETWORK_ARGS, EGRESS_RUN_ARGS } from "./up.mjs";
import { EGRESS_PROXY_IMAGE, PROXY_STATE_FORMAT, jobNetworksOf, parseProxyState, rulesIncludeEndpoints, shippedProxyDrift } from "./egress-proxy-state.mjs";
import { readPackagedProxyConf } from "./egress-conf-copy.mjs";
import { applyStack, foreignContainers, planStack, stackComponents, managerEnvRefusal, userBusRefusal } from "./podman-stack.mjs";

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const templatesDir = fileURLToPath(new URL("../deploy/", import.meta.url));
export function setupCommand(bin, args, { cwd, env, timeout = 15_000 } = {}) {
	return new Promise((done) => {
		try { execFile(bin, args, { cwd, env, timeout, maxBuffer: 256 * 1024, killSignal: "SIGKILL" }, (error, stdout, stderr) => done({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })); }
		catch { done({ code: null, stdout: "", stderr: "" }); }
	});
}
const no = (refusal) => ({ refusal });

export async function planSetupEgress(ctx) {
	const { CLI_SERVICE_KEYS } = await import("./doctor.mjs");
	const runtimeKeys = [...new Set([...CLI_SERVICE_KEYS.docker, ...CLI_SERVICE_KEYS.podman])];
	const runtime = deploymentServiceEnv({ env: ctx.env, dir: ctx.dir, keys: runtimeKeys, fs: ctx.fs, uid: ctx.uid, platform: ctx.platform });
	if (runtime.untrusted || runtime.unreadable || runtime.unread?.length || runtime.hazardSkipped?.length || runtime.disagreements?.length) return no("unsafe-deployment");
	const runtimeEnv = runtime.env;
	const run = ctx.run ?? ((bin, args) => setupCommand(bin, args, { cwd: ctx.dir, env: runtimeEnv }));
	const read = deploymentServiceEnv({ env: {}, dir: ctx.dir, keys: ["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY"], fs: ctx.fs, uid: ctx.uid, platform: ctx.platform });
	if (read.untrusted || read.unreadable || read.unread?.length || read.hazardSkipped?.length) return no("unsafe-deployment");
	const env = read.env;
	const venues = venuesOf(env);
	if (!egressArmed(env)) return no("egress-off");
	if (!venues.localUsed && !venues.podmanUsed) return no("gateway-egress");
	if (egressProxyName(env) !== DEFAULT_EGRESS_PROXY) return no("unsafe-proxy");
	const files = {};
	try {
		for (const rel of ["deploy/egress-proxy.conf", "egress-allowlist.conf", "model-endpoints.conf"]) {
			const path = join(ctx.dir, rel);
			const st = ctx.fs.lstatSync(path);
			if (!st.isFile() || st.isSymbolicLink() || st.uid !== ctx.uid || (st.mode & 0o022)) return no("unsafe-proxy");
			files[rel] = String(ctx.fs.readFileSync(path, "utf8"));
		}
	} catch { return no("unsafe-proxy"); }
	if (files["deploy/egress-proxy.conf"] !== (ctx.readPackagedConf ?? readPackagedProxyConf)()) return no("proxy-refresh-required");
	if (!venues.localUsed) {
		if (ctx.platform !== "linux") return no("unsupported");
		const info = await (ctx.readPodmanInfo ?? makePodmanInfoReader({ run: (args) => run("podman", args) }))();
		if (decidePodmanJobUser({ platform: ctx.platform, euid: ctx.uid, egid: process.getegid?.(), read: info }).mode !== "worker") return no("remote-runtime");
		const home = ctx.serviceDeps?.home ?? homedir();
		// env-internal USER: this account's manager label, never a declaration of another service account.
		const account = ctx.serviceDeps?.user ?? process.env.USER;
		if (userBusRefusal({ env: runtimeEnv, user: account, euid: ctx.uid })) return no("manager-unavailable");
		const manager = await run("systemctl", ["--user", "show-environment"]);
		if (manager.code !== 0 || managerEnvRefusal(manager, { home, euid: ctx.uid, user: account, realpath: ctx.fs.realpathSync })) return no("manager-unavailable");
		const components = stackComponents({ venues, env, includeValkey: false, armed: true });
		const stack = planStack({ components, templatesDir, deployDir: ctx.dir, home, fs: ctx.fs });
		if (stack.error || stack.files.some((f) => f.state === "changed") || stack.restart?.length) return no("unsafe-dependencies");
		for (const f of stack.files) {
			let path = f.path;
			while (path !== dirname(home)) {
				try { const st = ctx.fs.lstatSync(path); if (st.isSymbolicLink() || (st.mode & 0o022) || st.uid !== ctx.uid) return no("unsafe-dependencies"); } catch (e) { if (e.code !== "ENOENT") return no("unsafe-dependencies"); }
				if (path === home || path === dirname(path)) break;
				path = dirname(path);
			}
		}
		const foreign = await foreignContainers(stack, (bin, args) => run(bin, args));
		if (foreign.found.length || foreign.unknown.length) return no("unsafe-proxy");
		const running = await run("podman", ["inspect", PROXY_STATE_FORMAT, DEFAULT_EGRESS_PROXY]);
		const state = running.code === 0 ? parseProxyState(running.stdout) : null;
		if (state && !["running", "exited", "stopped", "created"].includes(state.status)) return no("unsafe-proxy");
		// Starting a keeper behind an existing proxy can require a disruptive replacement. Leave that repair to the host.
		if (state?.status === "running" && stack.files.some((f) => f.state === "new")) return no("unsafe-dependencies");
		return { effects: [...(stack.files.some((f) => f.state === "new") ? ["write-stack-files"] : []), "start-keeper", "start-proxy"], inputs: { runtime: digest(Object.fromEntries(runtimeKeys.map((key) => [key, runtimeEnv[key] ?? null]))), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, digest(v)])), stack, state }, egress: { bin: "podman", stack, run, running: state?.status === "running" } };
	}
	const endpoint = await (ctx.resolveEndpoint ?? makeDockerEndpointResolver({ run: (args) => run("docker", args) }))();
	if (endpoint.local !== true) return no("remote-runtime");
	const daemon = await run("docker", ["info", "--format", "{{.ID}}"]);
	if (daemon.code !== 0 || !daemon.stdout.trim()) return no("unavailable");
	const current = await run("docker", ["inspect", PROXY_STATE_FORMAT, DEFAULT_EGRESS_PROXY]);
	const state = current.code === 0 ? parseProxyState(current.stdout) : null;
	if (current.code === 0 && !state) return no("unsafe-proxy");
	if (!state && !/No such (?:object|container)/i.test(current.stderr)) return no("unavailable");
	if (state) {
		const drift = shippedProxyDrift(state, { cwd: ctx.dir, realpath: ctx.fs.realpathSync, platform: ctx.platform, rulesInclude: rulesIncludeEndpoints(files["deploy/egress-proxy.conf"]) });
		if (drift.drift.length || drift.unknown || jobNetworksOf(state).length || !["running", "exited", "created", "stopped"].includes(state.status)) return no("unsafe-proxy");
	}
	const image = await run("docker", ["image", "inspect", EGRESS_PROXY_IMAGE]);
	if (image.code !== 0) return no("unavailable");
	const network = await run("docker", ["network", "inspect", "pi-dispatch-egress-out"]);
	if (network.code !== 0 && !/No such network/i.test(network.stderr)) return no("unavailable");
	return { effects: ["start-proxy"], inputs: { runtime: digest(Object.fromEntries(runtimeKeys.map((key) => [key, runtimeEnv[key] ?? null]))), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, digest(v)])), state, daemon: daemon.stdout.trim(), network: network.code === 0 ? digest(network.stdout) : null }, egress: { bin: "docker", run, state, networkMissing: network.code !== 0, running: state?.status === "running" } };
}

export async function applySetupEgress(plan, ctx) {
	const e = plan.egress;
	if (e.running) return { state: "unchanged", reason: "already-running", effects: [] };
	if (e.bin === "podman") {
		const result = await applyStack(e.stack, { fs: ctx.fs, run: async (bin, args) => (await e.run(bin, args)).code });
		if (!result.ok) return { state: result.ran ? "partial" : "unknown", reason: "process-failed", effects: plan.effects };
	} else {
		if (e.networkMissing && (await e.run("docker", EGRESS_NETWORK_ARGS)).code !== 0) return { state: "unknown", reason: "process-failed" };
		const result = await e.run("docker", e.state ? ["start", DEFAULT_EGRESS_PROXY] : EGRESS_RUN_ARGS);
		if (result.code !== 0) return { state: "partial", reason: "process-failed", effects: plan.effects };
	}
	const read = await e.run(e.bin, ["inspect", PROXY_STATE_FORMAT, DEFAULT_EGRESS_PROXY]);
	return parseProxyState(read.stdout)?.status === "running" ? { state: "applied", reason: "ready", effects: plan.effects } : { state: "unknown", reason: "readback-unavailable", effects: plan.effects };
}
