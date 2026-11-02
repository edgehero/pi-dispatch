/** Hold the maintained SDK and real container PTY contract on Docker and rootless Podman (#754). */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { promisify, stripVTControlCharacters } from "node:util";
import { makeGatewayRuntime } from "../../gateway/src/runtime.mjs";

const execute = promisify(execFile);
const image = process.env.PI_JOB_IMAGE;
const venue = process.env.PI_SANDBOX_GATEWAY_VENUE ?? "local";
const socketPath = process.env.PI_SANDBOX_GATEWAY_SOCKET;
if (!image || !socketPath || !["local", "podman"].includes(venue)) throw new Error("gateway runtime smoke needs PI_JOB_IMAGE, PI_SANDBOX_GATEWAY_SOCKET and local/podman venue");
const bin = venue === "podman" ? "podman" : "docker";
const root = mkdtempSync(join(tmpdir(), "gateway-runtime-"));
const runtime = makeGatewayRuntime({ sockets: { [venue]: socketPath } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = async args => (await execute(bin, args, { timeout: 15000 })).stdout.trim();
const until = async (check, label) => {
	const deadline = performance.now() + 10000;
	while (performance.now() < deadline) { if (await check()) return; await pause(50); }
	throw new Error(`gateway runtime smoke timed out: ${label}`);
};
const lines = text => stripVTControlCharacters(text).replaceAll("\r", "").split("\n").slice(0, -1);
const helper = join(root, "native.py");
writeFileSync(helper, `import os,pty,subprocess,select,sys,json,time
master,slave=pty.openpty()
proc=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave)
seen=b""; ready=False
try:
 while proc.poll() is None:
  if select.select([master],[],[],0.1)[0]:
   try: data=os.read(master,16384)
   except OSError: break
   if not data: break
   seen=(seen+data)[-262144:]
   if not ready and b"GATEWAY_NATIVE_READY> " in seen:
    ready=True; print("PTY_READY",flush=True)
finally:
 os.close(master)
 if proc.poll() is None:
  try: proc.wait(timeout=2)
  except subprocess.TimeoutExpired: proc.terminate(); proc.wait(timeout=5)
sys.exit(proc.returncode or 0)
`, { mode: 0o600 });

async function fixture(idleSeconds, work) {
	const id = `gateway-check-${randomBytes(8).toString("hex")}`, nonce = randomBytes(16).toString("hex"), name = `pi-sandbox-${id}`;
	const args = [bin, "run", "--rm", "-i", "-t", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--name", name, "--label", `org.pi-dispatch.sandbox-session=${nonce}`, "-e", "TERM=xterm", "-e", `TMOUT=${idleSeconds}`, "-e", "PS1=GATEWAY_NATIVE_READY> ", "--entrypoint", "bash", image, "--noprofile", "--norc"];
	const native = spawn("python3", [helper, JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"] });
	let readiness = "", nativeFailure = "";
	native.stdout.on("data", b => { readiness = (readiness + b.toString()).slice(-1024); });
	native.stderr.on("data", b => { nativeFailure = (nativeFailure + b.toString()).slice(-1024); });
	try {
		await until(() => { if (native.exitCode !== null) throw new Error(`native PTY exited before ready (${native.exitCode}; ${nativeFailure})`); return readiness.includes("PTY_READY"); }, "native shell prompt");
		const containerId = await cli(["inspect", "--format", "{{.Id}}", name]);
		assert.match(containerId, /^[a-f0-9]{64}$/);
		if (venue === "local") assert.equal(await cli(["inspect", "--format", "{{.Config.StdinOnce}}", containerId]), "true", "the fixture must exercise an actual inherited-terminal run");
		await work({ target: { host: "gateway-test", id, nonce, containerId, venue }, native });
	} finally {
		await cli(["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), name]).catch(() => {});
		await until(() => native.exitCode !== null, "native CLI cleanup").catch(() => native.kill("SIGKILL"));
	}
}

try {
	await fixture(0, async ({ target, native }) => {
		let channel = await runtime.attach(target, { cols: 91, rows: 23 }), output = "";
		const decoder = new StringDecoder("utf8");
		channel.stream.on("error", () => {}); channel.stream.on("data", b => { output += decoder.write(b); });
		channel.stream.write("printf '\\nGATEWAY_RUNTIME_✓_界\\n'; stty size\r");
		await until(() => lines(output).includes("GATEWAY_RUNTIME_✓_界") && lines(output).includes("23 91"), "executed Unicode command and initial resize");
		output = ""; await channel.resize({ cols: 100, rows: 30 }); channel.stream.write("stty size\r");
		await until(() => lines(output).includes("30 100"), "live resize");
		output = ""; channel.stream.write("sleep 30\r"); await pause(200); channel.stream.write("\x03"); channel.stream.write("printf '\\nGATEWAY_INTERRUPTED\\n'\r");
		await until(() => lines(output).includes("GATEWAY_INTERRUPTED"), "Ctrl-C foreground interruption");
		channel.detach(); await pause(100);
		assert.equal((await runtime.inspect(target)).ok, true); assert.equal(native.exitCode, null, "browser detach must preserve the simultaneous native owner");
		channel = await runtime.attach(target, { cols: 80, rows: 24 }); channel.stream.on("error", () => {}); channel.stream.destroy(); await pause(100);
		assert.equal((await runtime.inspect(target)).ok, true); assert.equal(native.exitCode, null, "abrupt transport loss cannot end the shell");
		channel = await runtime.attach(target, { cols: 80, rows: 24 }); channel.stream.on("error", () => {}); channel.stream.resume(); channel.stream.write("exit\r");
		await until(async () => (await runtime.inspect(target)).refused === "sandbox-ended", "actual shell exit");
	});
	await fixture(2, async ({ target }) => {
		const channel = await runtime.attach(target, { cols: 80, rows: 24 }); channel.stream.on("error", () => {}); channel.stream.resume();
		await until(async () => (await runtime.inspect(target)).refused === "sandbox-ended", "native TMOUT logout");
	});
	await fixture(0, async ({ target }) => {
		const channel = await runtime.attach(target, { cols: 80, rows: 24 }); channel.stream.on("error", () => {}); channel.stream.resume();
		channel.stream.write("\x04");
		await until(async () => (await runtime.inspect(target)).refused === "sandbox-ended", "Ctrl-D at an empty shell prompt");
	});
	await fixture(0, async ({ target }) => {
		const channel = await runtime.attach(target, { cols: 80, rows: 24 }); channel.stream.on("error", () => {}); channel.stream.resume();
		// This is the external operator/test harness, never a capability of the gateway adapter.
		await cli(["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), target.containerId]);
		await until(async () => (await runtime.inspect(target)).refused === "sandbox-ended", "external End");
	});
	console.log(`sandbox gateway ${venue}: Unicode, resize, Ctrl-C/Ctrl-D, native PTY/StdinOnce, detach, abrupt loss, shell exit, idle and external End passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
