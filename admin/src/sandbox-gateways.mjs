/** Hand-owned enrollment for browser terminals. The native opener's import cannot enroll a gateway (#754). */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { trustedChain } from "@edgehero/pi-dispatch/service-env";
import { gatewayOrigin as protocolOrigin } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function gatewayOrigin(value) {
  const origin = protocolOrigin(value);
  if (!origin) throw new Error("A gateway origin must be canonical HTTPS; HTTP is supported only on explicit loopback hosts.");
  return origin;
}
export function validateSandboxGateways(input) {
  if (!object(input) || input.version !== 1 || !object(input.hosts) || Object.keys(input).some((k) => !["version", "consoleOrigin", "hosts"].includes(k)) || Object.keys(input.hosts).length > 64) throw new Error("Gateway enrollment requires version 1, consoleOrigin and at most 64 hosts.");
  const consoleOrigin = gatewayOrigin(input.consoleOrigin), consoleHost = new URL(consoleOrigin).hostname;
  const hosts = {};
  const gatewayHosts = new Set();
  for (const [host, entry] of Object.entries(input.hosts)) {
    if (!HOST.test(host) || !object(entry) || Object.keys(entry).some((k) => k !== "origin")) throw new Error("Each gateway enrollment names one worker and its origin only.");
    const origin = gatewayOrigin(entry.origin);
    if (new URL(origin).hostname === consoleHost) throw new Error("Gateway and console hostnames must differ: another port does not isolate cookies.");
    const gatewayHost = new URL(origin).hostname;
    if (gatewayHosts.has(gatewayHost)) throw new Error("Each gateway needs its own hostname: cookies are shared across ports and Web Locks are not.");
    gatewayHosts.add(gatewayHost);
    Object.defineProperty(hosts, host, { value: { origin }, enumerable: true });
  }
  return { version: 1, consoleOrigin, hosts };
}
export function readSandboxGateways(path, { fs = nodeFs, uid = process.geteuid?.(), platform = process.platform } = {}) {
  let fd;
  try {
    if (fs.lstatSync(path).isSymbolicLink()) return { refusal: "Gateway enrollment cannot be a symbolic link." };
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || Number.isInteger(uid) && stat.uid !== uid || platform !== "win32" && (stat.mode & 0o022)) return { refusal: "Gateway enrollment must be a bounded regular file owned by this account and writable only by it." };
    if (Number.isInteger(uid) && trustedChain(fs.realpathSync(dirname(path)), { fs, uid })) return { refusal: "Gateway enrollment is in a folder another account can change." };
    const raw = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) > 65536) return { refusal: "Gateway enrollment is too large." };
    const config = validateSandboxGateways(JSON.parse(raw));
    return { config, digest: createHash("sha256").update(raw).digest("hex") };
  } catch (error) {
    if (error.code === "ENOENT") return { disabled: true };
    return { refusal: "Gateway enrollment could not be read or validated. Inspect sandbox-gateways.json on the console host." };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
