import * as nodeFs from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { deploymentServiceEnv, trustedChain } from "@edgehero/pi-dispatch/service-env";
import { cleanGatewayTarget, distinctGatewayOrigins } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v, fields) => object(v) && Object.keys(v).every((k) => fields.includes(k));
const pathOk = (v) => typeof v === "string" && isAbsolute(v) && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
export const GATEWAY_DEPLOYMENT_KEYS = Object.freeze(["PI_WORKER_NAME", "PI_SANDBOX_IDLE_MINUTES", "PI_LOGS_DIR", "VALKEY_URL", "VALKEY_PASSWORD", "PI_VALKEY_SHARED"]);

export function validateGatewayConfig(raw) {
	if (!only(raw, ["version", "origin", "consoleOrigin", "host", "deployment", "sockets", "listen"]) || raw.version !== 1 || !distinctGatewayOrigins(raw.origin, raw.consoleOrigin) || !pathOk(raw.deployment) || !only(raw.sockets, ["local", "podman"]) || !Object.keys(raw.sockets).length || Object.values(raw.sockets).some((v) => !pathOk(v))) throw new Error("gateway configuration requires distinct canonical origins, an absolute deployment, host and explicit local runtime sockets");
	if (!cleanGatewayTarget({ host: raw.host, id: "check", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" })) throw new Error("gateway host must be a worker name");
	const listen = raw.listen ?? { host: "127.0.0.1", port: 8788 };
	if (!only(listen, ["host", "port"]) || !["127.0.0.1", "::1", "0.0.0.0", "::"].includes(listen.host) || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535) throw new Error("gateway listen requires an explicit IP bind and port");
	if (new URL(raw.origin).protocol === "http:" && !["127.0.0.1", "::1"].includes(listen.host)) throw new Error("an HTTP development gateway must listen only on loopback");
	return { version: 1, origin: raw.origin, consoleOrigin: raw.consoleOrigin, host: raw.host, deployment: raw.deployment, sockets: { ...raw.sockets }, listen: { ...listen } };
}

/** The trusted file is deployment authority. Ambient runtime, provider and forge variables never enter this process. */
export function readGatewayConfig(path, { fs = nodeFs, uid = process.geteuid?.(), platform = process.platform, readDeployment = deploymentServiceEnv } = {}) {
	if (!pathOk(path)) throw new Error("gateway --config requires an absolute configuration path");
	let fd;
	try {
		if (fs.lstatSync(path).isSymbolicLink()) throw new Error("gateway configuration cannot be a symbolic link");
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > 16384 || Number.isInteger(uid) && (st.uid !== uid && st.uid !== 0 || st.mode & 0o022) || Number.isInteger(uid) && trustedChain(fs.realpathSync(dirname(path)), { fs, uid })) throw new Error("gateway configuration must be a trusted regular file writable only by its owner");
		const bytes = Buffer.alloc(st.size + 1), n = fs.readSync(fd, bytes, 0, bytes.length, 0);
		if (n > st.size) throw new Error("gateway configuration changed while it was read");
		const config = validateGatewayConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n))));
		const deployment = readDeployment({ dir: config.deployment, env: {}, keys: GATEWAY_DEPLOYMENT_KEYS, fs, uid, platform });
		if (deployment.unreadable || deployment.untrusted || deployment.hazard || deployment.unread?.length || deployment.hazardSkipped?.length || !fs.existsSync(deployment.path)) throw new Error("the gateway deployment .env cannot be read with the service's trust rules");
		const env = Object.fromEntries(GATEWAY_DEPLOYMENT_KEYS.filter((k) => typeof deployment.env[k] === "string").map((k) => [k, deployment.env[k]]));
		if (env.PI_WORKER_NAME !== config.host) throw new Error("the gateway host must match PI_WORKER_NAME in the trusted deployment");
		const idle = env.PI_SANDBOX_IDLE_MINUTES ?? "30";
		if (!/^(0|[1-9][0-9]*)$/.test(idle) || !Number.isSafeInteger(Number(idle))) throw new Error("PI_SANDBOX_IDLE_MINUTES must be a non-negative integer");
		return { ...config, idleMinutes: Number(idle), env, logsDir: resolve(config.deployment, env.PI_LOGS_DIR ?? "logs") };
	} catch (error) {
		// Parse errors may quote file content, which is configuration text rather than a safe diagnostic.
		if (error instanceof SyntaxError) throw new Error("the gateway configuration is not valid JSON");
		throw error;
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}
