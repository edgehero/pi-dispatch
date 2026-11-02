import Docker from "dockerode";
import Modem from "docker-modem";
import { Readable } from "node:stream";
import { sandboxContainerName } from "@edgehero/pi-dispatch/sandbox";
import { SANDBOX_SESSION_LABEL } from "@edgehero/pi-dispatch/sandbox-sessions";
import { cleanGatewayTarget } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { gatewayDimensions } from "./terminal-protocol.mjs";
export { gatewayDimensions } from "./terminal-protocol.mjs";
export const GATEWAY_AMBIENT_RUNTIME_KEYS = Object.freeze(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CLIENT_TIMEOUT", "DOCKER_PATH_PREFIX"]);
function reviewedClient(options) {
	// Modem's constructor reads defaultOpts BEFORE applying explicit options, including certificate
	// files. A forbidden ambient default must refuse before construction, not merely lose a merge.
	if (GATEWAY_AMBIENT_RUNTIME_KEYS.some(key => typeof process.env[key] === "string" && process.env[key] !== "")) throw Object.assign(new Error("runtime-environment"), { code: "GATEWAY_RUNTIME_ENV" });
	return new Docker({ modem: new Modem({ ...options, host: null, port: null, pathPrefix: "/", username: null, password: null, key: null, cert: null, ca: null, protocol: "http", timeout: null, connectionTimeout: null, agent: null, headers: {} }) });
}

export const GATEWAY_RUNTIME_TIMEOUT_MS = 3_000;
/** The existing container owns its PTY. This adapter has only inspect, attach and resize calls. */
export function makeGatewayRuntime({ sockets, clientFactory = reviewedClient, timeoutMs = GATEWAY_RUNTIME_TIMEOUT_MS } = {}) {
	const clients = new Map();
	const client = (venue) => {
		if (!sockets?.[venue]) throw new Error("runtime-unavailable");
		if (!clients.has(venue)) clients.set(venue, clientFactory({ socketPath: sockets[venue], version: "v1.40" }));
		return clients.get(venue);
	};
	async function operation(fn, signal = null) {
		const controller = new AbortController();
		let timer, onAbort;
		if (signal?.aborted) throw new Error("runtime-unavailable");
		try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("runtime-unavailable")); }, timeoutMs); if (signal) { onAbort = () => { controller.abort(); reject(new Error("runtime-unavailable")); }; signal.addEventListener("abort", onAbort, { once: true }); } })]); }
		finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
	}
	async function inspect(target) {
		if (!cleanGatewayTarget(target)) return { refused: "runtime-unavailable" };
		try {
			const c = await operation((signal) => client(target.venue).getContainer(target.containerId).inspect({ abortSignal: signal }));
			if (c?.Id !== target.containerId || c.Name !== `/${sandboxContainerName(target.id)}` || c.Config?.Labels?.[SANDBOX_SESSION_LABEL] !== target.nonce) return { refused: "runtime-unavailable" };
			if (c.State?.Running === false) return { refused: "sandbox-ended" };
			if (c.State?.Running !== true || c.Config?.Tty !== true || c.Config?.OpenStdin !== true) return { refused: "runtime-unavailable" };
			return { ok: true };
		} catch (error) { return { refused: error?.code === "GATEWAY_RUNTIME_ENV" ? "runtime-environment" : error?.statusCode === 404 ? "sandbox-ended" : "runtime-unavailable" }; }
	}
	async function attach(target, { cols, rows, signal = null } = {}, watch = false) {
		if (!watch && !gatewayDimensions(cols, rows)) throw new Error("protocol-error");
		if (!(await inspect(target)).ok) throw new Error("runtime-unavailable");
		const container = client(target.venue).getContainer(target.containerId);
		// docker-modem 5.0.7 otherwise serializes POST query options as a JSON body. An
		// Engine upgrade can leave that body in the PTY's input (measured: "stream:trueexit").
		// An empty _body instead selects chunked framing without ending that request, which
		// waits forever on this endpoint. The maintained modem's empty file/body slot emits
		// Content-Length: 0 and performs the same maintained HTTP upgrade, without stdin bytes.
		const stream = await operation((abortSignal) => new Promise((resolve, reject) => client(target.venue).modem.dial({ path: `/containers/${target.containerId}/attach?`, method: "POST", options: { stream: true, stdin: !watch, stdout: true, stderr: true, logs: false, ...(!watch ? { detachKeys: "ctrl-p,ctrl-q" } : {}) }, file: Buffer.alloc(0), headers: { "Content-Type": "application/octet-stream" }, isStream: true, hijack: !watch, openStdin: !watch, abortSignal, statusCodes: { 200: true, 404: "no such container", 500: "server error" } }, (error, socket) => { if (abortSignal.aborted) { socket?.destroy(); reject(new Error("runtime-unavailable")); } else if (error) reject(error); else resolve(socket); })), signal);
		// Expose only a Readable, even if a future SDK returns a Duplex on the output-only
		// endpoint. The watcher capability has no write or resize member to misuse.
		const output = watch ? Readable.from(stream, { objectMode: false, highWaterMark: 65536 }) : stream;
		// Destroying that wrapper does not reach its source while the source is idle: the wrapper's iterator is parked
		// on a next chunk that never comes. Close the transport from here, or an idle watch keeps a daemon socket open.
		if (output !== stream) output.once("close", () => stream.destroy());
		let streamFailed = false;
		// A daemon can disappear while the first resize is still awaited, before the session's
		// listeners exist. Record that loss immediately rather than crashing on an unhandled event.
		stream.on("error", () => { streamFailed = true; });
		let detached = false;
		const detach = () => {
			if (detached) return;
			detached = true;
			// Only close this transport. A control-key detach sequence passed through Podman's
			// compatible API into readline and recalled an old command (measured). Raw close
			// preserves the existing shell on both measured runtimes, including StdinOnce=true.
			stream.destroy();
			if (output !== stream) output.destroy();
		};
		if (signal) { if (signal.aborted) { detach(); throw new Error("runtime-unavailable"); } signal.addEventListener("abort", detach, { once: true }); stream.once("close", () => signal.removeEventListener("abort", detach)); }
		try { if (!watch) await operation((abortSignal) => container.resize({ w: cols, h: rows, abortSignal }), signal); }
		catch { detach(); throw new Error("runtime-unavailable"); }
		if (streamFailed || stream.destroyed) { detach(); throw new Error("runtime-unavailable"); }
		return { stream: output, detach, ...(!watch ? { resize: async ({ cols: w, rows: h }) => {
			if (detached || !gatewayDimensions(w, h)) throw new Error("protocol-error");
			await operation((signal) => container.resize({ w, h, abortSignal: signal }));
		} } : {}) };
	}
	return {
		inspect,
		attach: (target, options) => attach(target, options, false),
		attachWatch: (target, options) => attach(target, options, true),
	};
}
