/** Native URL delivery and terminal handoff, without Docker, SSH, credentials or a real sandbox (#771). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openerDirectory, runOpener } from "../../worker/src/opener-cli.mjs";
import { sandboxOpenUrl } from "../../worker/src/opener-protocol.mjs";
import { sandboxCommand } from "../../worker/src/sandbox-hosts.mjs";
import { windowsPowerShellEnv } from "../../worker/src/opener-terminal.mjs";

if (process.env.CI !== "true") throw new Error("native opener registration smoke runs only in an isolated CI account");
const execFile = promisify(nodeExecFile);
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-dispatch-opener-native-")));
fs.chmodSync(root, 0o700);
const events = join(root, "events.jsonl");
const marker = join(root, "executed");
const executableDir = join(root, "space and 'quote $literal%");
fs.mkdirSync(executableDir);
const stub = join(executableDir, "native cli.mjs");
const source = join(root, "approved-hosts.json");
const configHome = join(root, "config");
const env = { ...(process.platform === "win32" ? windowsPowerShellEnv(process.env) : process.env), XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(root, "desktop-data") };
const protocol = sandboxOpenUrl({ verb: "open", id: "sb-native-smoke", host: "native" });
const imported = pathToFileURL(resolve("worker/src/opener-cli.mjs")).href;
fs.writeFileSync(stub, `import fs from "node:fs"; import {runOpener} from ${JSON.stringify(imported)};
process.env.XDG_CONFIG_HOME=${JSON.stringify(configHome)}; process.env.XDG_DATA_HOME=${JSON.stringify(env.XDG_DATA_HOME)};
const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({args,pid:process.pid})+"\\n");
if(args[0]==="sandbox") fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(args));
else process.exitCode=await runOpener(args.slice(1),{env:process.env,deps:{home:${JSON.stringify(root)},nodePath:process.execPath,cliPath:${JSON.stringify(stub)}}});
`, { mode: 0o600 });
fs.writeFileSync(source, JSON.stringify({ version: 1, hosts: { native: { target: null, deployment: root, nodePath: process.execPath, cliPath: stub, shell: process.platform === "win32" ? "powershell" : "posix" } } }), { mode: 0o600 });

function rows() { try { return fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } }
async function until(test, description, ms = 30_000) {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) { if (test()) return; await new Promise((done) => setTimeout(done, 100)); }
	throw new Error(`${description} did not happen; observed ${JSON.stringify(rows())}`);
}
async function openProtocol() {
	if (process.platform === "darwin") await execFile("/usr/bin/open", [protocol], { env });
	else if (process.platform === "linux") await execFile("xdg-open", [protocol], { env, timeout: 10_000 });
	else await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${protocol}'`], { env });
}
let registered = false;
try {
	if (process.platform === "win32") {
		let existing = false;
		try { await execFile("reg.exe", ["query", "HKCU\\Software\\Classes\\pi-dispatch-open"]); existing = true; } catch {}
		assert.equal(existing, false, "the isolated account already has an opener; do not replace it");
		fs.mkdirSync(openerDirectory(env), { recursive: true });
		await execFile("icacls.exe", [openerDirectory(env), "/grant", "*S-1-1-0:(OI)(CI)M"]);
	}
	assert.equal(await runOpener(["install", "--config", source], { env, deps: { home: root, nodePath: process.execPath, cliPath: stub } }), 0, "native per-user installation");
	registered = true;
	if (process.platform === "win32") {
		const path = openerDirectory(env).replaceAll("'", "''");
		const script = `(Get-Acl -LiteralPath '${path}').Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;allow=($_.AccessControlType -eq 'Allow')} } | ConvertTo-Json -Compress`;
		const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env });
		const parsed = JSON.parse(stdout);
		const access = Array.isArray(parsed) ? parsed : [parsed];
		assert.equal(access.some((r) => r.allow && r.sid === "S-1-1-0"), false, "the pre-existing Everyone grant must be removed");
		assert.equal(access.filter((r) => r.allow).length, 1, "only the installing account is granted access");
		console.log("Native Windows DACL removed a seeded explicit Everyone modification grant.");
	}
	await openProtocol();
	await until(() => rows().some((r) => r.args[0] === "opener" && r.args[1] === "handle" && r.args[2] === protocol), "native protocol delivery");
	await until(() => rows().some((r) => r.args[0] === "opener" && r.args[1] === "prompt"), "native terminal approval helper");
	assert.equal(fs.existsSync(marker), false, "native URL delivery and terminal opening must execute no sandbox command");
	console.log("Native per-user protocol delivery and terminal-helper launch verified; no command ran before Enter.");
	if (process.platform === "linux") {
		const { stdout } = await execFile("xdotool", ["search", "--class", "XTerm"], { env });
		const window = stdout.trim().split("\n").at(-1);
		assert.match(window, /^\d+$/);
		await execFile("xdotool", ["windowfocus", "--sync", window, "key", "Return"], { env });
		await until(() => fs.existsSync(marker), "Enter dispatch through the native terminal");
		const invoked = JSON.parse(fs.readFileSync(marker, "utf8"));
		assert.deepEqual(invoked, ["sandbox", "sb-native-smoke", "--deployment", root, "--expected-host", "native"]);
		console.log("Linux X11 native Enter dispatch verified against a harmless command recorder.");
	} else console.log("Native GUI keystrokes were not synthesised on this platform; the Enter/cancel decision is covered by behavioral tests and the POSIX PTY oracle.");
	if (process.platform === "win32") {
		const quotedDir = join(root, "space and 'quote");
		fs.mkdirSync(quotedDir);
		const quotedCli = join(quotedDir, "literal $name; cli.mjs");
		fs.copyFileSync(stub, quotedCli);
		const command = sandboxCommand({ version: 1, hosts: { native: { target: "unused-ssh-alias", deployment: quotedDir, nodePath: process.execPath, cliPath: quotedCli, shell: "powershell" } } }, { verb: "attach", id: "sb-powershell-smoke", host: "native" });
		await execFile("powershell.exe", command.argv[4].split(" ").slice(1), { env, timeout: 10_000 });
		assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ["sandbox", "sb-powershell-smoke", "--attach", "--deployment", quotedDir, "--expected-host", "native"]);
		console.log("Native PowerShell encoded-command quoting verified with spaces, apostrophes and literal metacharacters.");
	}
} finally {
	for (const row of rows()) if (row.args[1] === "prompt") { try { process.kill(row.pid, "SIGTERM"); } catch {} }
	if (registered && process.platform === "win32") await execFile("reg.exe", ["delete", "HKCU\\Software\\Classes\\pi-dispatch-open", "/f"]).catch(() => {});
	if (registered && process.platform === "darwin") await execFile("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", join(root, "Applications", "pi-dispatch Opener.app")]).catch(() => {});
	fs.rmSync(root, { recursive: true, force: true });
}
