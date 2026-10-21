/**
 * Is the operator console answering (issue #708)? One `GET /healthz` (the console's unauthenticated liveness route,
 * which answers `200 ok`) to the address `pi-dispatch-console serve` binds, for doctor's console line.
 *
 * The rule (the admin's `/dispatch console`, issue #708 part 1, imports this module rather than keeping a copy, so
 * there is one rule):
 *   - the address is PI_CONSOLE_LISTEN as the console reads it (trimmed; unset or empty is 127.0.0.1:4790);
 *   - a loopback TCP address (127.0.0.0/8, ::1) is asked as written;
 *   - an any-address bind (0.0.0.0, ::) is asked on 127.0.0.1 or ::1, its own family's loopback, which it also binds;
 *   - a unix socket is asked through the socket (`socketPath`);
 *   - port 0 (the OS picks the port, so only the running console knows it), any other address, and a value the console
 *     would refuse answer "unknown" and contact nothing. NO OTHER ADDRESS IS EVER CONTACTED: a probe that followed a
 *     configured non-loopback address would send a request across a network from a command that only reads, and a
 *     hostname is never resolved (the console refuses one anyway);
 *   - the request carries `Host: 127.0.0.1`, which the console's rebinding guard accepts for every listener, and is
 *     given 1 s: a console on this host answers in milliseconds, and a doctor run must not hang on one that does not.
 *
 * It lives in the worker because the dependency runs one way: the worker cannot import the admin package (not a
 * dependency), while the admin already imports the worker's subpath exports and bundles them, so it takes this one
 * as `@edgehero/pi-dispatch/console-probe`.
 *
 * `request` is `node:http`'s `request` signature, a seam: a test records what is contacted and answers without a socket.
 */
import { request as httpRequest } from "node:http";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { isAbsolute } from "node:path";

/** The console's default listen address, as `pi-dispatch-console serve` binds it. */
export const CONSOLE_DEFAULT_LISTEN = "127.0.0.1:4790";

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** True for 0.0.0.0 and :: in any IPv6 spelling (`::0`, `0:0:0:0:0:0:0:0`). */
function unspecified(host, family) {
	if (family === "ipv4") return host === "0.0.0.0";
	try {
		return new URL(`http://[${host}]/`).hostname === "[::]";
	} catch {
		return false;
	}
}

/**
 * Where the probe would ask, for a PI_CONSOLE_LISTEN value: `{ kind: "tcp", host, port, shown }`,
 * `{ kind: "unix", path, shown }`, or `{ unknown: reason }` when nothing may or can be asked.
 */
export function consoleProbeTarget(value) {
	const text = typeof value === "string" && value.trim() !== "" ? value.trim() : CONSOLE_DEFAULT_LISTEN;
	if (text.startsWith("unix:")) {
		const path = text.slice("unix:".length);
		if (!isAbsolute(path)) return { unknown: "PI_CONSOLE_LISTEN names a relative socket path, which the console refuses" };
		return { kind: "unix", path, shown: text };
	}
	const m = /^(?:\[([^\]]*)\]|([^:[\]]*)):([0-9]{1,5})$/.exec(text);
	if (!m || Number(m[3]) > 65535) return { unknown: "PI_CONSOLE_LISTEN is not ip:port, [ipv6]:port or unix:/abs/path" };
	const host = m[1] ?? m[2];
	const family = m[1] !== undefined ? (isIPv6(host) ? "ipv6" : null) : isIPv4(host) ? "ipv4" : null;
	if (family === null) return { unknown: `PI_CONSOLE_LISTEN names ${host}, which is not an IP literal` };
	const port = Number(m[3]);
	if (port === 0) return { unknown: "PI_CONSOLE_LISTEN asks for port 0, so the OS picks the port and only the running console knows it" };
	if (unspecified(host, family)) {
		const loopback = family === "ipv4" ? "127.0.0.1" : "::1";
		return { kind: "tcp", host: loopback, port, shown: `${family === "ipv4" ? loopback : `[${loopback}]`}:${port}` };
	}
	if (!LOOPBACK.check(host, family)) return { unknown: `PI_CONSOLE_LISTEN names ${host}, which is not a loopback address, and the probe asks nothing across a network` };
	return { kind: "tcp", host, port, shown: family === "ipv6" ? `[${host}]:${port}` : `${host}:${port}` };
}

/**
 * `{ state: "running" | "not-running" | "unknown", target?, reason? }` for the console of `env` (its PI_CONSOLE_LISTEN).
 * `target` is the address asked, as shown; `reason` says why it is not running or cannot be told. Never throws.
 */
export function probeConsole(env, { request = httpRequest, timeoutMs = 1000 } = {}) {
	const target = consoleProbeTarget(env?.PI_CONSOLE_LISTEN);
	if (target.unknown) return Promise.resolve({ state: "unknown", reason: target.unknown });
	const where = target.kind === "unix" ? { socketPath: target.path } : { host: target.host, port: target.port, family: isIPv6(target.host) ? 6 : 4 };
	return new Promise((resolvePromise) => {
		let settled = false;
		let req = null;
		const done = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				req?.destroy();
			} catch {}
			resolvePromise({ target: target.shown, ...result });
		};
		// Our own timer rather than the socket's idle timeout: that one restarts on every byte, so a listener that trickles
		// bytes would hold doctor past the second this promises.
		const timer = setTimeout(() => done({ state: "not-running", reason: `nothing answered within ${timeoutMs} ms` }), timeoutMs);
		try {
			req = request({ ...where, method: "GET", path: "/healthz", headers: { host: "127.0.0.1" }, agent: false }, (res) => {
				const code = res.statusCode;
				res.resume?.();
				done(code === 200 ? { state: "running" } : { state: "not-running", reason: `something answered HTTP ${code}, not the console's 200` });
			});
			req.on("error", (err) => done({ state: "not-running", reason: err?.code === "ECONNREFUSED" || err?.code === "ENOENT" ? "nothing listens there" : `the request failed (${err?.code ?? "error"})` }));
			req.end();
		} catch (err) {
			done({ state: "not-running", reason: `the request failed (${err?.code ?? "error"})` });
		}
	});
}
