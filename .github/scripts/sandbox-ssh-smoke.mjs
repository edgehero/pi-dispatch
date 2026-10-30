/** Real SSH TTY, deployment loading, detach/attach and End on the host's sandbox venue (#771). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { sandboxCommand } from "../../worker/src/sandbox-hosts.mjs";
import { makeRedisClient } from "../../worker/src/connection.mjs";
import { readSandboxSessions, requestSandboxEnd } from "../../worker/src/sandbox-sessions.mjs";
import { readPodmanStore } from "../../worker/src/sandbox.mjs";
import { sandboxSmokeLines, sendSandboxSmokeDetach, waitSandboxSmokeTty } from "./sandbox-smoke-tty.mjs";

const execFile = promisify(execFileCallback);
const venue = process.env.PI_SANDBOX_SMOKE_VENUE ?? "local";
assert.ok(["local", "podman"].includes(venue));
const bin = venue === "podman" ? "podman" : "docker";
const image = process.env.PI_JOB_IMAGE;
assert.ok(image, "PI_JOB_IMAGE names the already-built pinned job image");
const root = fs.mkdtempSync(join(homedir(), ".pi-dispatch-sandbox-smoke-"));
fs.chmodSync(root, 0o700);
const processes = [];
const id = `sb-${randomBytes(16).toString("hex")}`;
const host = `smoke-${randomBytes(8).toString("hex")}`;
const containerName = `pi-sandbox-${id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const n = s.address().port; await new Promise((r) => s.close(r)); return n; }
async function until(fn, description, ms = 30_000) { const end = performance.now() + ms; while (performance.now() < end) { const value = await fn(); if (value) return value; await sleep(100); } throw new Error(`${description} timed out`); }
function daemon(file, args) { const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] }); let error = ""; child.on("error", (e) => error = e.code ?? "spawn-failed"); child.stderr.on("data", (b) => error += b); processes.push(child); child.failure = () => error; return child; }
let redis;
try {
	const redisPort = await port();
	const password = randomBytes(20).toString("hex");
	const redisConfig = join(root, "redis.conf");
	fs.writeFileSync(redisConfig, `bind 127.0.0.1\nport ${redisPort}\nsave ""\nappendonly no\nrequirepass ${password}\ndir ${root}\n`, { mode: 0o600 });
	let controlServer = daemon(process.env.PI_SANDBOX_SMOKE_REDIS ?? "redis-server", [redisConfig]);
	redis = makeRedisClient(`redis://:${password}@127.0.0.1:${redisPort}`, { noOfflineQueue: true });
	redis.on("error", () => {});
	await until(() => redis.ping().then(() => true, () => false), "private control store");

	const sshPort = await port();
	const key = join(root, "client");
	const hostKey = join(root, "host");
	await execFile("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
	await execFile("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
	for (const path of [key, hostKey]) { fs.chmodSync(path, 0o600); assert.equal(fs.statSync(path).mode & 0o777, 0o600); }
	const authorized = join(root, "authorized_keys");
	fs.copyFileSync(`${key}.pub`, authorized); fs.chmodSync(authorized, 0o600);
	const sshdConfig = join(root, "sshd_config");
	fs.writeFileSync(sshdConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${authorized}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes yes\nPrintMotd no\nLogLevel ERROR\nAllowUsers ${userInfo().username}\n`, { mode: 0o600 });
	const sshd = daemon("/usr/sbin/sshd", ["-D", "-e", "-f", sshdConfig]);
	const known = join(root, "known_hosts");
	fs.writeFileSync(known, `[127.0.0.1]:${sshPort} ${fs.readFileSync(`${hostKey}.pub`, "utf8")}`);
	const sshConfig = join(root, "ssh_config");
	fs.writeFileSync(sshConfig, `Host sandbox-smoke\n HostName 127.0.0.1\n Port ${sshPort}\n User ${userInfo().username}\n IdentityFile ${key}\n UserKnownHostsFile ${known}\n StrictHostKeyChecking yes\n BatchMode yes\n LogLevel ERROR\n`, { mode: 0o600 });
	let sshFailure = "";
	try {
		await until(() => execFile("/usr/bin/ssh", ["-F", sshConfig, "sandbox-smoke", "true"], { timeout: 2_000 }).then(() => true, (error) => { sshFailure = String(error.stderr ?? error.code ?? "SSH unavailable"); if (sshd.exitCode !== null) throw new Error(`isolated sshd failed: ${sshd.failure()}`); return false; }), "private SSH server");
	} catch (error) { throw new Error(`${String(error.message).replaceAll(password, "[redacted]")}; SSH ${sshFailure.replaceAll(password, "[redacted]").slice(-3000)}; server ${sshd.failure().replaceAll(password, "[redacted]").slice(-3000)}`); }

	const dir = join(root, "sandboxes", id);
	const workspace = join(dir, "workspace"); fs.mkdirSync(workspace, { recursive: true });
	const createdAt = new Date().toISOString();
	const manifest = { jobId: id, kind: "github", backend: venue, image, workspace, createdAt, retainUntil: new Date(Date.now() + 86_400_000).toISOString(), keepUntil: null, size: { memMiB: 512, cpuCenti: 50, source: "project" } };
	if (venue === "podman") { manifest.jobUser = { user: `${process.geteuid()}:${process.getegid()}`, home: "/home/pi" }; manifest.podmanStore = await readPodmanStore(); assert.ok(manifest.podmanStore); }
	fs.writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	const egress = process.env.PI_EGRESS === "1";
	const settings = { PI_WORKER_NAME: host, PI_BACKENDS: venue, PI_JOB_IMAGE: image, PI_EGRESS: egress ? "1" : "0", PI_SANDBOX_DIR: join(root, "sandboxes"), VALKEY_URL: `redis://127.0.0.1:${redisPort}`, VALKEY_PASSWORD: password };
	settings.PATH = process.env.PATH;
	// A remote login does not get the systemd user manager's rootless identity environment by default.
	if (venue === "podman") Object.assign(settings, { XDG_CONFIG_HOME: join(homedir(), ".config"), XDG_RUNTIME_DIR: `/run/user/${process.geteuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.geteuid()}/bus` });
	fs.writeFileSync(join(root, ".env"), Object.entries(settings).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
	const mappings = { version: 1, hosts: { [host]: { target: "sandbox-smoke", deployment: root, nodePath: process.execPath, cliPath: resolve("worker/src/cli.mjs"), shell: "posix" } } };
	function terminal(verb) {
		const command = sandboxCommand(mappings, { verb, id, host });
		assert.equal(command.argv[0], "ssh");
		// CI has no local terminal. -tt supplies the remote TTY a real terminal's -t supplies.
		const remote = `printf '\\nSANDBOX_REMOTE_TTY:%s\\n' "$(tty)"\n${command.argv.at(-1)}`;
		const child = spawn("/usr/bin/ssh", ["-F", sshConfig, "-tt", "--", "sandbox-smoke", remote], { stdio: ["pipe", "pipe", "pipe"] });
		child.output = ""; child.stdout.on("data", (b) => child.output += b); child.stderr.on("data", (b) => child.output += b); processes.push(child); return child;
	}
	const terminalDiagnostic = (child) => `SSH exit ${child.exitCode ?? "running"}; output ${JSON.stringify(child.output.replaceAll(password, "[redacted]").slice(-6000))}`;
	async function terminalUntil(child, predicate, description) {
		try { return await until(() => { if (child.exitCode !== null) throw new Error("SSH terminal exited"); return predicate(); }, description); }
		catch (error) { throw new Error(`${error.message}; ${terminalDiagnostic(child)}`); }
	}
	async function runtimeAttached(child) {
		// A lease can be published before `run -it` owns stdin. Its raw-mode transition can flush an early line.
		// Read the actual remote TTY instead of sleeping or assuming container registration means attachment.
		try {
			await waitSandboxSmokeTty({ child, until, description: "runtime SSH terminal raw mode", inspect: async (tty) => {
				const { stdout } = await execFile("/usr/bin/ssh", ["-F", sshConfig, "sandbox-smoke", "/bin/stty", process.platform === "darwin" ? "-f" : "-F", tty, "-a"], { timeout: 2_000 });
				return stdout;
			} });
		} catch (error) { throw new Error(`${error.message}; ${terminalDiagnostic(child)}`); }
	}
	const opened = terminal("open");
	const current = () => readSandboxSessions(redis, { hosts: [host] }).then((r) => r.sessions[0]);
	const first = await terminalUntil(opened, current, "SSH sandbox lease");
	assert.equal(first.venue, venue);
	await runtimeAttached(opened);
	opened.stdin.write("node -e 'const bad=Object.keys(process.env).filter(k=>/TOKEN|SECRET|PASSWORD|API_KEY/.test(k));if(bad.length){console.log(\"SANDBOX_CREDENTIAL_KEYS:\"+JSON.stringify(bad));process.exit(3);}console.log(\"SANDBOX_CREDENTIALS_CLEAR\")'\n");
	await terminalUntil(opened, () => {
		const lines = sandboxSmokeLines(opened.output);
		if (lines.some((line) => line.startsWith("SANDBOX_CREDENTIAL_KEYS:"))) throw new Error("sandbox shell contains credential key names");
		return lines.includes("SANDBOX_CREDENTIALS_CLEAR");
	}, "credential-free shell environment");
	await sendSandboxSmokeDetach(opened.stdin, sleep);
	try { await until(() => opened.exitCode !== null, "terminal detach"); }
	catch (error) { throw new Error(`${error.message}; ${terminalDiagnostic(opened)}`); }
	const renewed = await until(async () => { const s = await current(); return s && s.at > first.at + 500 ? s : null; }, "lease renewal after detach");
	assert.equal(renewed.containerId, first.containerId);
	controlServer.kill("SIGTERM");
	await until(() => controlServer.exitCode !== null, "control store shutdown");
	controlServer = daemon(process.env.PI_SANDBOX_SMOKE_REDIS ?? "redis-server", [redisConfig]);
	await until(() => redis.ping().then(() => true, () => false), "control store restart");
	const recovered = await until(async () => { const s = await current(); return s?.containerId === first.containerId && s.at > renewed.at ? s : null; }, "monitor reconnect and lease recovery");
	const attached = terminal("attach");
	await runtimeAttached(attached);
	attached.stdin.write("printf 'SANDBOX_ATTACH_READY\\n'\n");
	await terminalUntil(attached, () => sandboxSmokeLines(attached.output).includes("SANDBOX_ATTACH_READY"), "SSH attach to original runtime");
	assert.deepEqual(await requestSandboxEnd({ redis, ...recovered }), { ended: true });
	await until(() => attached.exitCode !== null, "End reaching attached terminal");
	assert.ok(fs.existsSync(workspace), "End preserves the kept workspace");
	assert.equal((await current()), undefined, "lease removed after confirmed stop");
	console.log(`SSH ${venue}: deployment settings, TTY, credential-free shell, detach renewal, control-store restart recovery, attach and End verified.`);
} finally {
	await execFile(bin, ["rm", "-f", ...(bin === "podman" ? ["--time=0"] : []), containerName]).catch(() => {});
	redis?.disconnect();
	for (const child of processes.reverse()) if (child.exitCode === null) child.kill("SIGTERM");
	await sleep(200);
	fs.rmSync(root, { recursive: true, force: true });
}
