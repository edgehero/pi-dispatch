/** Fleet targets are an operator-edited file. A URL cannot enroll or alter a local trusted target. */
import * as nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { sandboxOpenFields } from "./opener-protocol.mjs";
import { trustedChain } from "./service-env.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(value);
const absolute = (value) => text(value) && (isAbsolute(value) || win32.isAbsolute(value));
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const EMPTY_SANDBOX_HOSTS = Object.freeze({ version: 1, hosts: Object.freeze({}) });
export function sandboxHostsPath(env = process.env) {
	// env-internal XDG_CONFIG_HOME, HOME, USERPROFILE: the current account's OS configuration directory, not job settings.
	return env.PI_SANDBOX_HOSTS_FILE || join(env.XDG_CONFIG_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".config"), "pi-dispatch", "sandbox-hosts.json");
}
export function validateSandboxHosts(input) {
	if (!object(input) || input.version !== 1 || !object(input.hosts) || Object.keys(input).some((key) => !["version", "hosts"].includes(key))) throw new Error("sandbox hosts must contain version 1 and a hosts object");
	if (Object.keys(input.hosts).length > 64) throw new Error("sandbox hosts accepts at most 64 hosts");
	const hosts = {};
	for (const [host, raw] of Object.entries(input.hosts)) {
		sandboxOpenFields({ verb: "open", id: "sb-check", host });
		if (!object(raw) || Object.keys(raw).some((key) => !["target", "deployment", "nodePath", "cliPath", "shell"].includes(key))) throw new Error("a sandbox host accepts only target, deployment, nodePath, cliPath and shell");
		if (raw.target !== null && (typeof raw.target !== "string" || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(raw.target))) throw new Error("the SSH target must be a host or user@host (use an SSH config alias for ports)");
		for (const key of ["deployment", "nodePath", "cliPath"]) if (!absolute(raw[key])) throw new Error(`the sandbox host ${key} must be an absolute path without control bytes`);
		const shell = raw.shell ?? (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(raw.nodePath) ? "powershell" : "posix");
		if (!["posix", "powershell"].includes(shell)) throw new Error("a sandbox host shell must be posix or powershell");
		if (raw.target !== null && [raw.deployment, raw.nodePath, raw.cliPath].some((p) => shell === "posix" ? !p.startsWith("/") : !win32.isAbsolute(p))) throw new Error("the SSH sandbox paths must be absolute for the selected host shell");
		Object.defineProperty(hosts, host, { value: { target: raw.target, deployment: raw.deployment, nodePath: raw.nodePath, cliPath: raw.cliPath, shell }, enumerable: true, writable: true, configurable: true });
	}
	return { version: 1, hosts };
}
export function readSandboxHosts(path, { fs = nodeFs, uid = process.geteuid?.(), allowMissing = true, platform = process.platform } = {}) {
	let fd;
	try {
		if (fs.lstatSync(path).isSymbolicLink()) return { refusal: "the sandbox hosts file cannot be a symbolic link" };
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || (Number.isInteger(uid) && stat.uid !== uid) || (platform !== "win32" && (stat.mode & 0o022))) return { refusal: "the sandbox hosts file must be a regular file owned by this account and writable only by it" };
		if (Number.isInteger(uid) && trustedChain(fs.realpathSync(dirname(path)), { fs, uid })) return { refusal: "the sandbox hosts file is in a folder another account can change" };
		const raw = fs.readFileSync(fd, "utf8");
		if (Buffer.byteLength(raw) > 128 * 1024) return { refusal: "the sandbox hosts file is too large" };
		return { config: validateSandboxHosts(JSON.parse(raw)), expect: digest(raw) };
	} catch (error) {
		if (allowMissing && error.code === "ENOENT") return { config: { version: 1, hosts: {} }, expect: null };
		return { refusal: `the sandbox hosts file could not be used (${typeof error.code === "string" ? error.code : "invalid configuration"})` };
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function planSandboxHost(path, host, mapping, options = {}) {
	const read = readSandboxHosts(path, options);
	if (read.refusal) return read;
	try {
		sandboxOpenFields({ verb: "open", id: "sb-check", host });
		const hosts = { ...read.config.hosts };
		if (mapping === null) delete hosts[host]; else Object.defineProperty(hosts, host, { value: mapping, enumerable: true, configurable: true });
		const config = validateSandboxHosts({ version: 1, hosts });
		return { config, before: JSON.stringify(read.config, null, 2) + "\n", after: JSON.stringify(config, null, 2) + "\n", expect: read.expect };
	} catch (error) { return { refusal: error.message }; }
}
export function writeSandboxHost(path, host, mapping, { expect, fs = nodeFs, uid = process.geteuid?.(), platform = process.platform } = {}) {
	const plan = planSandboxHost(path, host, mapping, { fs, uid });
	if (plan.refusal) return plan;
	if (plan.expect !== expect) return { refusal: "the sandbox hosts file changed since the preview; preview again" };
	let temporary;
	try {
		fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const parent = fs.lstatSync(dirname(path));
		if (!parent.isDirectory() || parent.isSymbolicLink() || (Number.isInteger(uid) && (parent.uid !== uid || trustedChain(fs.realpathSync(dirname(path)), { fs, uid }))) || (platform !== "win32" && (parent.mode & 0o022))) return { refusal: "the sandbox hosts folder must be owned by this account and writable only by it" };
		temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
		fs.writeFileSync(temporary, plan.after, { flag: "wx", mode: 0o600 });
		const fresh = readSandboxHosts(path, { fs, uid });
		if (fresh.refusal || fresh.expect !== expect) return { refusal: "the sandbox hosts file changed since the preview; preview again" };
		fs.renameSync(temporary, path);
		return { written: true, expect: digest(plan.after), config: plan.config };
	} catch (error) { return { refusal: `the sandbox hosts file was not written (${error.code ?? "write failed"})` }; }
	finally { if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch {} } }
}
export function quoteSandboxArg(value) {
	const word = String(value);
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
export function quotePowerShellArg(value) { return `'${String(value).replaceAll("'", "''")}'`; }
export function sandboxCommand(input, fields) {
	const config = validateSandboxHosts(input);
	const { verb, id, host } = sandboxOpenFields(fields);
	const mapping = Object.hasOwn(config.hosts, host) ? config.hosts[host] : null;
	if (!mapping) throw new Error("the opener host is unknown; import the approved Fleet host configuration first");
	const command = [mapping.nodePath, mapping.cliPath, "sandbox", id, ...(verb === "attach" ? ["--attach"] : []), "--deployment", mapping.deployment, "--expected-host", host];
	const remoteScript = mapping.shell === "powershell" ? `& ${command.map(quotePowerShellArg).join(" ")}; exit $LASTEXITCODE` : command.map(quoteSandboxArg).join(" ");
	// EncodedCommand keeps one fixed script intact through either cmd.exe or PowerShell as the Windows SSH
	// login shell. Its expanded text is shown beside the exact wire command before Enter, never hidden by encoding.
	const remoteCommand = mapping.shell === "powershell" ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(remoteScript, "utf16le").toString("base64")}` : remoteScript;
	const argv = mapping.target === null ? command : ["ssh", "-t", "--", mapping.target, remoteCommand];
	const display = mapping.target === null && mapping.shell === "powershell" ? `& ${argv.map(quotePowerShellArg).join(" ")}` : argv.map(quoteSandboxArg).join(" ");
	return { argv, display: mapping.target !== null && mapping.shell === "powershell" ? `${display}\nRemote PowerShell command: ${remoteScript}` : display, local: mapping.target === null, remoteScript: mapping.target !== null ? remoteScript : null };
}
