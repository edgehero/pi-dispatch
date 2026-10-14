/**
 * Where the console listens (issue #640, REQ-CONSOLE-SECURITY clauses a and j).
 *
 * `PI_CONSOLE_LISTEN` takes an IP literal and a port (`127.0.0.1:4790`, `[::1]:4790`) or `unix:/abs/path`.
 *
 * IP LITERALS ONLY. A hostname is refused even when it is `localhost`: what a name resolves to is decided by a file or
 * a server the console does not control, and "loopback" must be a property of the bind, not of today's resolver. A
 * non-loopback literal (`0.0.0.0`, a LAN address) is refused unless PI_CONSOLE_BIND_PUBLIC=1, and doctor warns while it
 * is set: the console has no TLS, and a token over plain HTTP on a network is a token anyone on it can read.
 *
 * UNIX SOCKET MODE removes every network peer, the job container on the host gateway included. The parent directory
 * must be ours and 0700 (a socket file's own mode is not honoured by every platform's `connect`, a directory's is), the
 * socket is created under umask 077 and then chmod 0600, and a path longer than the platform's `sun_path` is refused
 * BY NAME before the bind, because the kernel's own error for it (`EINVAL`/`ENAMETOOLONG`) names nothing an operator
 * can act on.
 */
import * as nodeFs from "node:fs";
import { BlockList, createConnection, isIPv4, isIPv6 } from "node:net";
import { dirname, isAbsolute } from "node:path";

// `sun_path` sizes, NUL terminator included: 104 bytes on macOS and the BSDs, 108 on Linux. Other platforms get the
// Linux figure, the larger, so a refusal there is never stricter than the kernel's.
const SUN_PATH = { darwin: 104, freebsd: 104, openbsd: 104, netbsd: 104, linux: 108 };

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** True when `address` (an IP literal, no brackets) is 127.0.0.0/8 or ::1. */
export function isLoopbackAddress(address) {
  if (isIPv4(address)) return LOOPBACK.check(address, "ipv4");
  if (isIPv6(address)) return LOOPBACK.check(address, "ipv6");
  return false;
}

/**
 * Parse a PI_CONSOLE_LISTEN value. Returns `{kind: "tcp", host, port}` (host unbracketed), `{kind: "unix", path}` or
 * `{refusal}`. `bindPublic` is PI_CONSOLE_BIND_PUBLIC=1.
 */
export function parseListen(value, { bindPublic = false, platform = process.platform } = {}) {
  const text = String(value ?? "").trim();
  if (text.startsWith("unix:")) {
    const path = text.slice("unix:".length);
    if (!isAbsolute(path)) return { refusal: `PI_CONSOLE_LISTEN unix socket path must be absolute (got ${path === "" ? "nothing" : "a relative path"}); write unix:/abs/path` };
    const limit = SUN_PATH[platform] ?? 108;
    const bytes = Buffer.byteLength(path);
    if (bytes >= limit) {
      return { refusal: `PI_CONSOLE_LISTEN unix socket path is ${bytes} bytes, and this platform allows at most ${limit - 1}; choose a shorter path, for example under /tmp or $XDG_RUNTIME_DIR` };
    }
    return { kind: "unix", path };
  }
  let host;
  let portText;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0 || text[close + 1] !== ":") return { refusal: `PI_CONSOLE_LISTEN ${text} is not [ipv6]:port; write for example [::1]:4790` };
    host = text.slice(1, close);
    portText = text.slice(close + 2);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon < 0) return { refusal: `PI_CONSOLE_LISTEN ${text === "" ? "is empty" : `${text} has no port`}; write ip:port (127.0.0.1:4790), [::1]:port or unix:/abs/path` };
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
  }
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) > 65535) {
    return { refusal: `PI_CONSOLE_LISTEN port ${portText} is not a number from 0 to 65535` };
  }
  if (!text.startsWith("[") && host.includes(":")) {
    return { refusal: `PI_CONSOLE_LISTEN ${text} looks like an IPv6 address without brackets; write [address]:port, for example [::1]:4790` };
  }
  if (!isIPv4(host) && !(isIPv6(host) && text.startsWith("["))) {
    return { refusal: `PI_CONSOLE_LISTEN names ${host}, which is not an IP literal; a hostname can resolve anywhere, so write 127.0.0.1 or [::1] instead` };
  }
  if (!isLoopbackAddress(host) && !bindPublic) {
    return { refusal: `PI_CONSOLE_LISTEN ${host} is not a loopback address; the console has no TLS, so reach it with ssh -L instead, or set PI_CONSOLE_BIND_PUBLIC=1 to accept that risk` };
  }
  return { kind: "tcp", host, port: Number(portText) };
}

/** The URL a browser on this host opens for a TCP spec; null for a socket (the browser reaches it through a tunnel). */
export function listenUrl(spec, port = spec.port) {
  if (spec.kind !== "tcp") return null;
  return `http://${isIPv6(spec.host) ? `[${spec.host}]` : spec.host}:${port}/`;
}

/** Does something accept on the unix socket at `path`? A refusal or any error means nobody does. */
function socketAnswers(path) {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    const done = (alive) => {
      sock.destroy();
      resolve(alive);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** The checks a unix socket's parent directory must pass. Returns a sentence or null. */
function socketDirProblem(dir, fs, uid) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    return `the socket directory ${dir} does not exist (${e?.code ?? "error"}); create it with mode 0700`;
  }
  if (st.isSymbolicLink()) return `the socket directory ${dir} is a symlink; use the real directory, mode 0700`;
  if (!st.isDirectory()) return `the socket directory ${dir} is not a directory`;
  if (uid !== undefined && st.uid !== uid) return `the socket directory ${dir} is owned by uid ${st.uid}, not this account (${uid}); use a directory of your own`;
  if ((st.mode & 0o077) !== 0) {
    return `the socket directory ${dir} has mode ${(st.mode & 0o777).toString(8)}, so another account could reach the socket; chmod 700 ${dir}`;
  }
  return null;
}

/**
 * Listen on `spec`. Resolves `{ok: true, address}` or `{refusal}`; throws only on a failure no configuration explains.
 * For a unix socket: the directory checks above, a stale socket removed only when lstat says it is a socket AND a
 * connect to it fails (a live console is refused, never displaced; a regular file is never deleted), umask 077 around
 * the bind, then chmod 0600.
 */
export async function listenOn(server, spec, { fs = nodeFs, uid = process.geteuid?.(), umask = process.umask.bind(process) } = {}) {
  const bind = (...args) =>
    new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once("error", onError);
      server.listen(...args, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  const bindRefusal = (e, where) => {
    if (e?.code === "EADDRINUSE") return { refusal: `${where} is already in use; stop the other process or set another PI_CONSOLE_LISTEN` };
    if (e?.code === "EACCES" || e?.code === "EPERM") return { refusal: `this account may not listen on ${where} (${e.code}); pick another port or path` };
    if (e?.code === "EADDRNOTAVAIL") return { refusal: `${where} is not an address of this host; set PI_CONSOLE_LISTEN to one that is` };
    return null;
  };
  if (spec.kind === "tcp") {
    try {
      await bind(spec.port, spec.host);
    } catch (e) {
      const refused = bindRefusal(e, `${spec.host}:${spec.port}`);
      if (refused) return refused;
      throw e;
    }
    return { ok: true, address: server.address() };
  }
  const dirProblem = socketDirProblem(dirname(spec.path), fs, uid);
  if (dirProblem) return { refusal: dirProblem };
  let existing = null;
  try {
    existing = fs.lstatSync(spec.path);
  } catch (e) {
    if (e?.code !== "ENOENT") return { refusal: `${spec.path} cannot be checked (${e?.code ?? "error"}); remove it or choose another path` };
  }
  if (existing) {
    if (!existing.isSocket()) return { refusal: `${spec.path} exists and is not a socket; it was left alone, so choose another path or remove it yourself` };
    if (await socketAnswers(spec.path)) return { refusal: `another process is listening on ${spec.path}; stop it first (only one console may run per deployment)` };
    fs.unlinkSync(spec.path);
  }
  const previous = umask(0o077);
  try {
    await bind(spec.path);
  } catch (e) {
    const refused = bindRefusal(e, spec.path);
    if (refused) return refused;
    throw e;
  } finally {
    umask(previous);
  }
  fs.chmodSync(spec.path, 0o600);
  return { ok: true, address: spec.path };
}
