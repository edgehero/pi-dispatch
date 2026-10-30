import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { tempDir } from "./helpers/temp-dir.mjs";
import { sandboxOpenUrl, parseSandboxOpenUrl } from "../src/opener-protocol.mjs";
import { readSandboxHosts, planSandboxHost, writeSandboxHost, sandboxCommand, validateSandboxHosts, quoteSandboxArg } from "../src/sandbox-hosts.mjs";
import { openerRegistration, openerDirectory, promptSandboxCommand, runOpener } from "../src/opener-cli.mjs";
import { terminalLaunch, spawnTerminal } from "../src/opener-terminal.mjs";

const mapping = { target: "rob@mini1", deployment: "/srv/pi dispatch", nodePath: "/usr/bin/node", cliPath: "/srv/pi dispatch/cli.mjs" };
const config = () => ({ version: 1, hosts: { mini1: mapping, local1: { ...mapping, target: null } } });
const fields = { verb: "open", id: "manual:nightly:1234", host: "mini1" };
const uri = () => sandboxOpenUrl(fields);
function world() { const root = tempDir("opener-"); return { root, path: join(root, "sandbox-hosts.json"), env: { HOME: root, PATH: process.env.PATH } }; }

test("the native smoke's actual generated recorder writes independently parseable JSON lines", () => {
	const root = tempDir("opener-native-recorder-");
	const events = join(root, "events.jsonl"), marker = join(root, "executed");
	const stub = join(root, "space and 'quote $literal% cli.mjs"), configHome = join(root, "config");
	const smoke = fs.readFileSync(new URL("../../.github/scripts/opener-native-smoke.mjs", import.meta.url), "utf8");
	const template = smoke.match(/fs\.writeFileSync\(stub, (`[\s\S]*?`), \{ mode: 0o600 \}\);/)?.[1];
	assert.ok(template, "evaluate the exact recorder template used by the native smoke, without registering a handler");
	const imported = new URL("../src/opener-cli.mjs", import.meta.url).href;
	fs.writeFileSync(stub, runInNewContext(template, { imported, configHome, env: { XDG_DATA_HOME: join(root, "desktop-data") }, events, marker, root, stub }));
	const invocations = [["sandbox", "sb-first", "literal\\ntext", "$(no-command); 'quoted'"], ["sandbox", "sb-second", "line\nbreak"]];
	for (const argv of invocations) execFileSync(process.execPath, [stub, ...argv]);
	const raw = fs.readFileSync(events, "utf8");
	assert.equal(raw.endsWith("\n"), true);
	assert.deepEqual(raw.trimEnd().split("\n").map((line) => JSON.parse(line).args), invocations);
	assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), invocations[1]);
});

test("the wire grammar is canonical, single-decode, closed, and round trips complete run ids and sb ids", () => {
	assert.equal(uri(), "pi-dispatch-open://open/manual%3Anightly%3A1234?host=mini1");
	assert.deepEqual(parseSandboxOpenUrl(uri()), fields);
	for (const verb of ["open", "attach"]) assert.deepEqual(parseSandboxOpenUrl(sandboxOpenUrl({ verb, id: "sb-0123", host: "local1" })), { verb, id: "sb-0123", host: "local1" });
	for (const link of ["pi-dispatch-open://delete/gh-1?host=mini1", "pi-dispatch-open://open/../gh-1?host=mini1", "pi-dispatch-open://open/%252e%252e?host=mini1", "pi-dispatch-open://open/%0als?host=mini1", "pi-dispatch-open://open/-x?host=mini1", "pi-dispatch-open://open/gh-1?host=-oProxyCommand=x", "pi-dispatch-open://open/gh-1?host=mini1&cmd=evil", "pi-dispatch-open://open/gh-1?host=mini1&host=other", "pi-dispatch-open://open/gh-1?host=mini1#x", "pi-dispatch-open://open/gh%2d1?host=mini1", "pi-dispatch-open://open/gh-1?host=mini%31", "pi-dispatch-open://open/%ZZ?host=mini1"]) assert.throws(() => parseSandboxOpenUrl(link), /opener/, link);
});

test("only the locally approved host supplies executable, deployment and SSH target; argv never evaluates a URL", () => {
	const command = sandboxCommand(config(), fields);
	assert.deepEqual(command.argv, ["ssh", "-t", "--", "rob@mini1", "/usr/bin/node '/srv/pi dispatch/cli.mjs' sandbox manual:nightly:1234 --deployment '/srv/pi dispatch' --expected-host mini1"]);
	assert.deepEqual(sandboxCommand(config(), { ...fields, host: "local1", verb: "attach" }).argv, ["/usr/bin/node", "/srv/pi dispatch/cli.mjs", "sandbox", fields.id, "--attach", "--deployment", "/srv/pi dispatch", "--expected-host", "local1"]);
	assert.throws(() => sandboxCommand(config(), { ...fields, host: "unknown" }), /host is unknown/);
	for (const bad of [{ ...mapping, target: "-oProxyCommand=x" }, { ...mapping, target: "rob@mini1;touch x" }, { ...mapping, cliPath: "node" }, { ...mapping, token: "no" }]) assert.throws(() => validateSandboxHosts({ version: 1, hosts: { mini1: bad } }));
	const quoted = sandboxCommand({ version: 1, hosts: { mini1: { ...mapping, cliPath: "/srv/it's $(touch marker)/cli.mjs" } } }, fields);
	assert.ok(quoted.argv[4].includes("it'\\''s $(touch marker)"));
});

test("Windows SSH is a fixed PowerShell script whose encoding and expanded display preserve literal arguments", () => {
	const windows = { target: "rob@winworker", deployment: "C:\\worker's deployment", nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\worker\\literal $name; dispatch.mjs", shell: "powershell" };
	const command = sandboxCommand({ version: 1, hosts: { winworker: windows } }, { ...fields, host: "winworker", verb: "attach" });
	assert.deepEqual(command.argv.slice(0, 4), ["ssh", "-t", "--", "rob@winworker"]);
	assert.match(command.argv[4], /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
	const decoded = Buffer.from(command.argv[4].split(" ").at(-1), "base64").toString("utf16le");
	assert.equal(decoded, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\worker\\literal $name; dispatch.mjs' 'sandbox' 'manual:nightly:1234' '--attach' '--deployment' 'C:\\worker''s deployment' '--expected-host' 'winworker'; exit $LASTEXITCODE");
	assert.equal(command.remoteScript, decoded);
	assert.ok(command.display.includes(command.argv[4]), "the exact wire command is visible");
	assert.ok(command.display.includes(decoded), "its expanded meaning is visible before Enter");
	assert.match(sandboxCommand({ version: 1, hosts: { winworker: { ...windows, target: null } } }, { ...fields, host: "winworker" }).display, /^& 'C:/);
	for (const field of ["deployment", "nodePath", "cliPath"]) assert.throws(() => validateSandboxHosts({ version: 1, hosts: { winworker: { ...windows, [field]: windows[field] + "\nNew-Item bad" } } }), /control bytes/);
	assert.throws(() => validateSandboxHosts({ version: 1, hosts: { winworker: { ...windows, shell: "cmd" } } }), /shell/);
});

test("Fleet mapping preview has no write; confirm uses an expected version and rejects a changed file", () => {
	const w = world();
	const plan = planSandboxHost(w.path, "mini1", mapping);
	assert.equal(fs.existsSync(w.path), false);
	assert.equal(plan.expect, null);
	assert.equal(writeSandboxHost(w.path, "mini1", mapping, { expect: plan.expect }).written, true);
	assert.equal(fs.statSync(w.path).mode & 0o777, 0o600);
	assert.equal(writeSandboxHost(w.path, "mini1", { ...mapping, target: "elsewhere" }, { expect: null }).written, undefined);
	assert.match(writeSandboxHost(w.path, "mini1", mapping, { expect: null }).refusal, /changed/);
	assert.equal(readSandboxHosts(w.path).config.hosts.mini1.target, "rob@mini1");
	const remove = planSandboxHost(w.path, "mini1", null);
	assert.equal(writeSandboxHost(w.path, "mini1", null, { expect: remove.expect }).written, true);
	assert.deepEqual(readSandboxHosts(w.path).config.hosts, {});
});

test("configuration refuses a symlink, a writable-by-others file, and schema expansion", () => {
	const w = world();
	fs.writeFileSync(w.path, JSON.stringify(config()), { mode: 0o600 });
	const link = join(w.root, "link.json");
	fs.symlinkSync(w.path, link);
	assert.ok(readSandboxHosts(link).refusal);
	fs.chmodSync(w.path, 0o666);
	assert.match(readSandboxHosts(w.path).refusal, /writable only/);
	fs.chmodSync(w.path, 0o600);
	fs.writeFileSync(w.path, JSON.stringify({ ...config(), shell: "bad" }));
	assert.ok(readSandboxHosts(w.path).refusal);
});

test("hostile links and unknown hosts refuse before any terminal is opened", async () => {
	const w = world();
	const dir = openerDirectory(w.env);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(join(dir, "hosts.json"), JSON.stringify(config()), { mode: 0o600 });
	let opened = 0;
	const errors = [];
	for (const link of ["pi-dispatch-open://exec/gh-1?host=mini1", "pi-dispatch-open://open/%24(touch)?host=mini1", sandboxOpenUrl({ ...fields, host: "unknown" })]) assert.equal(await runOpener(["handle", link], { env: w.env, deps: { err: (s) => errors.push(s), showTerminal: () => opened++ } }), 1);
	assert.equal(opened, 0);
	assert.match(errors.join(""), /verb.*id.*host|id is not/);
	assert.match(errors.join(""), /unknown/);
});

test("all platform handlers are per-user, quote executable paths, and only launch the fixed handle verb", () => {
	const common = { home: "/home/rob", directory: "/home/rob/.config/pi-dispatch/opener", nodePath: "/Program Files/node", cliPath: "/work/dispatch/cli.mjs" };
	const linux = openerRegistration({ ...common, platform: "linux" });
	assert.match(linux.files[0].content, /Exec="\/Program Files\/node" "\/work\/dispatch\/cli.mjs" opener handle %u/);
	assert.deepEqual(linux.commands[0], ["xdg-mime", ["default", "pi-dispatch-opener.desktop", "x-scheme-handler/pi-dispatch-open"]]);
	assert.equal(openerRegistration({ ...common, platform: "linux", dataHome: "/custom/desktop-data" }).files[0].path, "/custom/desktop-data/applications/pi-dispatch-opener.desktop");
	assert.throws(() => openerRegistration({ ...common, platform: "linux", dataHome: "relative" }), /absolute/);
	const mac = openerRegistration({ ...common, platform: "darwin" });
	assert.match(mac.between.content, /<key>CFBundleTypeRole<\/key><string>Editor<\/string>/, "LaunchServices requires a role for the URL claim");
	assert.match(mac.commands[0][1].at(-1), /on open location theURL/);
	assert.match(mac.between.content, /pi-dispatch-open/);
	assert.match(mac.commands[0][1][1], /\/home\/rob\/Applications\//);
	assert.equal(mac.commands[1][0], "/usr/bin/codesign", "metadata changes are signed before LaunchServices receives the bundle");
	assert.match(mac.commands[2][0], /lsregister$/);
	const windows = openerRegistration({ ...common, platform: "win32" });
	assert.equal(windows.commands.length, 3);
	for (const [, args] of windows.commands) assert.match(args[1], /^HKCU\\/);
	assert.ok(windows.commands.at(-1)[1].includes('"/Program Files/node" "/work/dispatch/cli.mjs" opener handle "%1"'));
	const percent = openerRegistration({ ...common, platform: "win32", nodePath: "C:\\node%20path\\node.exe", cliPath: "C:\\literal%1%TEMP%\\cli.mjs" }).commands.at(-1)[1];
	assert.ok(percent.includes('"C:\\node%%20path\\node.exe" "C:\\literal%%1%%TEMP%%\\cli.mjs" opener handle "%1"'), "fixed path percents are literal; only the final URI placeholder is substituted by ShellExecute");
	assert.throws(() => openerRegistration({ ...common, platform: "freebsd" }), /no supported/);
	assert.throws(() => openerRegistration({ ...common, platform: "linux", nodePath: "/home/x=y/node" }), /cannot name/);
});

test("installation imports a fixed map once, and a subsequent link cannot change it", async () => {
	const w = world();
	w.env.XDG_DATA_HOME = join(w.root, "custom-desktop-data");
	fs.writeFileSync(w.path, JSON.stringify(config()), { mode: 0o600 });
	const commands = [];
	assert.equal(await runOpener(["install", "--config", w.path], { env: w.env, deps: { platform: "linux", home: w.root, out: () => {}, execFile: async (...args) => commands.push(args) } }), 0);
	assert.equal(commands.length, 1);
	assert.equal(commands[0][2].env, w.env, "xdg-mime registers in the same explicit XDG directories as the desktop entry");
	assert.equal(fs.existsSync(join(w.env.XDG_DATA_HOME, "applications", "pi-dispatch-opener.desktop")), true, "the handler is written where xdg-mime resolves its registered desktop id");
	assert.equal(fs.existsSync(join(w.root, ".local", "share", "applications", "pi-dispatch-opener.desktop")), false);
	let launched;
	assert.equal(await runOpener(["handle", uri()], { env: w.env, deps: { platform: "linux", terminal: { bin: "/usr/bin/default-terminal", args: ["-e"] }, showTerminal: async (plan) => { launched = plan; } } }), 0);
	assert.equal(launched.args.at(-1), uri());
	assert.equal(readSandboxHosts(join(openerDirectory(w.env), "hosts.json")).config.hosts.mini1.target, "rob@mini1");
});

test("Windows enrollment removes previous explicit ACL grants before restricting the imported mapping", async () => {
	const w = world();
	fs.writeFileSync(w.path, JSON.stringify(config()), { mode: 0o600 });
	const commands = [];
	const result = await runOpener(["install", "--config", w.path], { env: w.env, deps: { platform: "win32", home: w.root, out: () => {}, execFile: async (bin, args) => { commands.push([bin, args]); return { stdout: bin === "whoami.exe" ? '"CI account","S-1-5-21-123-456-1001"' : "" }; } } });
	assert.equal(result, 0);
	assert.deepEqual(commands.slice(1, 3), [["icacls.exe", [openerDirectory(w.env), "/reset"]], ["icacls.exe", [openerDirectory(w.env), "/inheritance:r", "/grant:r", "*S-1-5-21-123-456-1001:(OI)(CI)F"]]]);
	assert.match(commands.at(-1)[0], /WindowsPowerShell.*powershell\.exe$/);
	assert.match(commands.at(-1)[1].at(-1), /SHChangeNotify\(0x08000000, 0x1000, \[System.IntPtr\]::Zero, \[System.IntPtr\]::Zero\)/, "the installed association is flushed to the native Shell after its registry command is written");
	assert.equal(readSandboxHosts(join(openerDirectory(w.env), "hosts.json")).config.hosts.mini1.target, mapping.target);
});

test("terminal launch starts an approval helper, never SSH or the sandbox, including private macOS command files", () => {
	const w = world();
	const common = { nodePath: "/usr/bin/node", cliPath: "/srv/dispatch cli.mjs", url: uri(), directory: w.root, env: w.env };
	const linux = terminalLaunch({ ...common, platform: "linux", terminal: { bin: "/usr/bin/x-terminal-emulator", args: ["-e"] } });
	assert.deepEqual(linux.args, ["-e", common.nodePath, common.cliPath, "opener", "prompt", uri()]);
	assert.throws(() => terminalLaunch({ ...common, platform: "linux", terminal: null }), /no default terminal/);
	const mac = terminalLaunch({ ...common, platform: "darwin" });
	assert.equal(mac.bin, "/usr/bin/open");
	assert.match(fs.readFileSync(mac.args[0], "utf8"), / opener prompt /);
	assert.doesNotMatch(fs.readFileSync(mac.args[0], "utf8"), /ssh| sandbox /);
	assert.equal(fs.statSync(mac.args[0]).mode & 0o777, 0o700);
	const windows = terminalLaunch({ ...common, platform: "win32" });
	const windowsScript = Buffer.from(windows.args.at(-1), "base64").toString("utf16le");
	assert.match(windowsScript, /CreateProcessW\(application, new StringBuilder\(commandLine\), IntPtr.Zero, IntPtr.Zero, false, 0x00000010,/);
	assert.match(windowsScript, /startup.dwFlags = 0x00000001;/, "only normal-window metadata is supplied, never inherited standard handles");
	assert.match(windowsScript, /opener.*prompt/);
});

test("the local PS5 launcher transports the entire nested argv script as UTF16LE without interpreting path metacharacters", () => {
	const w = world();
	const plan = terminalLaunch({ platform: "win32", nodePath: "C:\\Program Files\\node's $bin%\\node.exe", cliPath: "C:\\worker's $name%\\dispatch cli.mjs", url: uri(), directory: w.root, env: w.env });
	assert.deepEqual(plan.args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	const decoded = Buffer.from(plan.args.at(-1), "base64").toString("utf16le");
	assert.ok(decoded.endsWith(String.raw`[PiDispatchConsole]::Start('C:\Program Files\node''s $bin%\node.exe', '"C:\Program Files\node''s $bin%\node.exe" "C:\worker''s $name%\dispatch cli.mjs" "opener" "prompt" "${uri()}"')`));
	assert.match(decoded, /CloseHandle\(process.hThread\);[\s\S]*finally \{ CloseHandle\(process.hProcess\); \}/);
	assert.equal(plan.waitForExit, true, "only the finite dispatcher is awaited, never the interactive helper");
});

test("a Windows terminal child derives PS5 module paths even when its Node parent came from PowerShell 7", async () => {
	const w = world();
	const env = { ...w.env, PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules", pSmOdUlEpAtH: "another incompatible path", SystemRoot: "C:\\Windows" };
	const plan = terminalLaunch({ platform: "win32", nodePath: "C:\\node\\node.exe", cliPath: "C:\\dispatch cli.mjs", url: uri(), directory: w.root, env });
	let options;
	await spawnTerminal(plan, { spawn: (_bin, _args, passed) => { options = passed; const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child; } });
	assert.equal(Object.keys(options.env).some((key) => key.toLowerCase() === "psmodulepath"), false);
	assert.equal(options.env.SystemRoot, "C:\\Windows");
	assert.equal(options.detached, true, "the finite dispatcher does not give libuv ownership of its console's lifetime");
	assert.equal(env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules", "the invoking shell's environment is untouched");
});

test("the Windows dispatcher must finish successfully; process creation alone cannot hide its failure", async () => {
	const plan = { bin: "powershell.exe", args: ["fixed-dispatcher"], waitForExit: true };
	let child, settled = false;
	const pending = spawnTerminal(plan, { spawn: () => { child = new EventEmitter(); child.stderr = new PassThrough(); return child; } });
	pending.then(() => settled = true, () => settled = true);
	child.emit("spawn");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "a spawned PowerShell has not yet confirmed CreateProcessW succeeded");
	child.stderr.write("x".repeat(10_000));
	child.emit("exit", 1);
	await assert.rejects(pending, (error) => /could not open an interactive console/.test(error.message) && error.code === 1 && error.stderr.length === 4096);
	const failed = new Error("PowerShell executable unavailable");
	await assert.rejects(spawnTerminal(plan, { spawn: () => { const c = new EventEmitter(); queueMicrotask(() => c.emit("error", failed)); return c; } }), (error) => error === failed);
});

test("a failed Windows console dispatcher makes the opener refuse instead of announcing an opened terminal", async () => {
	const w = world(), errors = [];
	fs.mkdirSync(openerDirectory(w.env), { recursive: true, mode: 0o700 });
	fs.writeFileSync(join(openerDirectory(w.env), "hosts.json"), JSON.stringify(config()), { mode: 0o600 });
	const result = await runOpener(["handle", uri()], { env: w.env, deps: { platform: "win32", err: (s) => errors.push(s), showTerminal: (plan) => spawnTerminal(plan, { spawn: () => { const c = new EventEmitter(); queueMicrotask(() => c.emit("exit", 1)); return c; } }) } });
	assert.equal(result, 1);
	assert.match(errors.join(""), /could not open an interactive console/);
});

test("a Windows dispatcher that never completes is killed at its bounded deadline without waiting for Enter", async () => {
	let deadline, bound, killed = 0;
	const child = new EventEmitter();
	child.kill = () => { killed++; };
	const pending = spawnTerminal({ bin: "powershell.exe", args: ["dispatcher"], waitForExit: true }, {
		spawn: () => child,
		setTimer: (fn, ms) => { deadline = fn; bound = ms; return "timer"; },
		clearTimer: () => {},
	});
	assert.equal(bound, 30_000);
	assert.equal(killed, 0);
	deadline();
	await assert.rejects(pending, /could not open an interactive console/);
	assert.equal(killed, 1, "only the stuck finite dispatcher is stopped");
});

test("readable POSIX commands round-trip literal arguments through a real shell without evaluating metacharacters", { skip: process.platform === "win32" ? "POSIX shell oracle" : false }, () => {
	const w = world();
	const marker = join(w.root, "must-not-exist");
	const recorder = join(w.root, "record args' literal.mjs");
	fs.writeFileSync(recorder, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
	const args = ["safe", "manual:nightly:123", "-flag", "a=b", "space here", "it's literal", `$(touch ${marker})`, `\`touch ${marker}\``, "$HOME", "x;y", "x\ny", '"quoted"', "\\backslash", ""];
	const command = [process.execPath, recorder, ...args].map(quoteSandboxArg).join(" ");
	assert.deepEqual(JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })), args);
	assert.equal(fs.existsSync(marker), false);
	assert.equal(quoteSandboxArg("/usr/bin/node"), "/usr/bin/node");
	assert.equal(quoteSandboxArg("manual:nightly:123"), "manual:nightly:123");
});

test("the helper requires an empty Enter; no input, EOF and nonempty lines never spawn", async () => {
	for (const line of ["cancel\n", "yes\n", "ssh evil\n", "\u001b\n", null]) {
		const input = new PassThrough();
		const output = new PassThrough();
		let spawns = 0;
		const pending = promptSandboxCommand({ argv: ["ssh", "mini1"], display: "ssh mini1" }, { input, output, isTty: true, spawn: () => spawns++ });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(spawns, 0, "displaying the command executes nothing");
		if (line === null) input.end(); else input.write(line);
		assert.equal((await pending).cancelled, true);
		assert.equal(spawns, 0);
	}
	const input = new PassThrough();
	let seen;
	const pending = promptSandboxCommand({ argv: ["ssh", "-t", "--", "mini1", "fixed"], display: "exact command" }, { input, output: new PassThrough(), isTty: true, spawn: (bin, args) => { seen = [bin, args]; const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 17)); return child; } });
	input.write("\n");
	assert.equal((await pending).code, 17);
	assert.deepEqual(seen, ["ssh", ["-t", "--", "mini1", "fixed"]]);
	assert.equal((await promptSandboxCommand({ argv: ["never"], display: "never" }, { input: new PassThrough(), output: new PassThrough(), isTty: false })).refused, true);
});

test("a real pseudo-terminal proves the execution boundary before Enter and on cancellation", { skip: process.platform === "win32" ? "POSIX PTY oracle; Windows registration and prompt argv are covered separately" : false }, () => {
	const w = world();
	const marker = join(w.root, "executed");
	const script = join(w.root, "prompt.mjs");
	const module = pathToFileURL(join(import.meta.dirname, "../src/opener-cli.mjs")).href;
	fs.writeFileSync(script, `import { promptSandboxCommand } from ${JSON.stringify(module)}; const result=await promptSandboxCommand({argv:[process.execPath,"-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`)}],display:"the exact sandbox command"}); process.exitCode=result.code??0;`);
	const python = `import os,pty,subprocess,select,time,sys\nfor answer in [b"cancel\\n",b"\\n"]:\n master,slave=pty.openpty()\n proc=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,close_fds=True)\n os.close(slave)\n data=b""\n deadline=time.monotonic()+10\n while b"Press Enter" not in data and time.monotonic()<deadline:\n  if select.select([master],[],[],0.1)[0]: data+=os.read(master,8192)\n assert b"Press Enter" in data,data\n assert not os.path.exists(sys.argv[3]),"ran before Enter"\n os.write(master,answer)\n assert proc.wait(timeout=10)==0\n assert os.path.exists(sys.argv[3])==(answer==b"\\n"),"wrong execution decision"\n os.close(master)\nprint("PTY Enter boundary verified")\n`;
	assert.match(execFileSync("python3", ["-c", python, process.execPath, script, marker], { encoding: "utf8", timeout: 30_000 }), /verified/);
});
