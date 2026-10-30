/** An explicit import enrolls trusted Fleet mappings. A link never changes configuration. */
import * as nodeFs from "node:fs";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parseSandboxOpenUrl } from "./opener-protocol.mjs";
import { readSandboxHosts, sandboxCommand } from "./sandbox-hosts.mjs";
import { spawnTerminal, terminalLaunch } from "./opener-terminal.mjs";
import { trustedChain } from "./service-env.mjs";

// env-internal XDG_CONFIG_HOME, HOME, USERPROFILE: the native handler belongs to the current account and uses its config directory.
export function openerDirectory(env = process.env) { return join(env.XDG_CONFIG_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".config"), "pi-dispatch", "opener"); }
const apple = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
// Desktop-entry values unescape first, then Exec unquotes. Both layers need their own backslash.
const desktop = (value) => `"${String(value).replaceAll("%", "%%").replace(/[\\"`$]/g, "\\$&").replaceAll("\\", "\\\\")}"`;

export function openerRegistration({ platform, home, directory, nodePath, cliPath, dataHome = join(home, ".local", "share") }) {
	if (platform === "darwin") {
		const app = join(home, "Applications", "pi-dispatch Opener.app");
		const source = `on open location theURL\n do shell script (quoted form of ${apple(nodePath)} & " " & quoted form of ${apple(cliPath)} & " opener handle " & quoted form of theURL)\nend open location\n`;
		const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>applet</string><key>CFBundleIdentifier</key><string>com.pi-dispatch.opener</string><key>CFBundleName</key><string>pi-dispatch Opener</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>CFBundleURLTypes</key><array><dict><key>CFBundleTypeRole</key><string>Editor</string><key>CFBundleURLName</key><string>pi-dispatch sandbox</string><key>CFBundleURLSchemes</key><array><string>pi-dispatch-open</string></array></dict></array></dict></plist>\n`;
		// osacompile signs its bundle. Our URL metadata changes its signed resources, so sign again after the
		// plist write; registering a modified signature can compile cleanly and still refuse at native launch.
		return { commands: [["/usr/bin/osacompile", ["-o", app, "-e", source]], ["/usr/bin/codesign", ["--force", "--sign", "-", app]], ["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app]]], between: { path: join(app, "Contents", "Info.plist"), content: plist }, directory: dirname(app) };
	}
	if (platform === "linux") {
		if (nodePath.includes("=")) throw new Error("the desktop Exec format cannot name a Node executable whose path contains '='; use Copy or install Node at another path");
		if (!dataHome.startsWith("/") || /[\x00-\x1f\x7f]/.test(dataHome)) throw new Error("XDG_DATA_HOME must be an absolute desktop data directory without control bytes");
		const path = join(dataHome, "applications", "pi-dispatch-opener.desktop");
		const content = `[Desktop Entry]\nType=Application\nName=pi-dispatch sandbox opener\nNoDisplay=true\nTerminal=false\nExec=${desktop(nodePath)} ${desktop(cliPath)} opener handle %u\nMimeType=x-scheme-handler/pi-dispatch-open;\n`;
		return { files: [{ path, content }], commands: [["xdg-mime", ["default", "pi-dispatch-opener.desktop", "x-scheme-handler/pi-dispatch-open"]]], directory: dirname(path) };
	}
	if (platform === "win32") {
		// HKCU registration requires no elevation. reg.exe takes values as argv, never through cmd.exe.
		const key = "HKCU\\Software\\Classes\\pi-dispatch-open";
		const quoted = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
		return { commands: [["reg.exe", ["add", key, "/ve", "/d", "URL:pi-dispatch sandbox opener", "/f"]], ["reg.exe", ["add", key, "/v", "URL Protocol", "/d", "", "/f"]], ["reg.exe", ["add", `${key}\\shell\\open\\command`, "/ve", "/d", `${quoted(nodePath)} ${quoted(cliPath)} opener handle "%1"`, "/f"]]] };
	}
	throw new Error("this operating system has no supported opener installer; copy the sandbox command instead");
}

/** A blank line is the entire approval vocabulary. A pasted command, y, Escape or EOF never runs anything. */
export async function promptSandboxCommand(command, { input = process.stdin, output = process.stdout, spawn = nodeSpawn, isTty = Boolean(input.isTTY && output.isTTY) } = {}) {
	if (!isTty) return { refused: true, message: "the opener needs a real terminal; copy the command into your terminal instead" };
	output.write(`\n${command.display}\n\nPress Enter to run this command, or type anything to cancel.\n`);
	const accepted = await new Promise((resolveAnswer) => {
		const lines = createInterface({ input, output, terminal: false });
		let answered = false;
		lines.once("line", (line) => { answered = true; lines.close(); resolveAnswer(line === ""); });
		lines.once("close", () => { if (!answered) resolveAnswer(false); });
	});
	if (!accepted) return { cancelled: true, code: 0 };
	const code = await new Promise((resolveCode, reject) => {
		const child = spawn(command.argv[0], command.argv.slice(1), { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolveCode(code ?? 1));
	});
	return { code };
}

export async function runOpener(argv = [], { env = process.env, deps = {} } = {}) {
	// env-internal HOME, USERPROFILE: the current account's home, for current-user native protocol registration.
	const { fs = nodeFs, platform = process.platform, home = env.HOME || env.USERPROFILE || homedir(), nodePath = process.execPath, cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url)), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), execFile = promisify(nodeExecFile), terminal = null, showTerminal = spawnTerminal, prompt = promptSandboxCommand, uid = process.geteuid?.() } = deps;
	const directory = openerDirectory(env);
	const configPath = join(directory, "hosts.json");
	try {
		if (argv[0] === "install") {
			if (argv.length !== 3 || argv[1] !== "--config") throw new Error("usage: pi-dispatch opener install --config <approved Fleet export.json>");
			const source = readSandboxHosts(resolve(argv[2]), { fs, uid, allowMissing: false });
			if (source.refusal) throw new Error(source.refusal);
			if (!Object.keys(source.config.hosts).length) throw new Error("the approved Fleet export has no sandbox hosts");
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			const configStat = fs.lstatSync(directory);
			if (!configStat.isDirectory() || configStat.isSymbolicLink() || (Number.isInteger(uid) && (configStat.uid !== uid || trustedChain(fs.realpathSync(directory), { fs, uid })))) throw new Error("the opener configuration folder must belong to this account, have a trusted parent and cannot be a link");
			fs.chmodSync(directory, 0o700);
			if (platform === "win32") {
				// chmod does not express a Windows DACL. Protect the imported mapping using this account's SID,
				// independently of a directory's inherited grants; the URL never supplies the principal or path.
				const identity = await execFile("whoami.exe", ["/user", "/fo", "csv", "/nh"], { env, timeout: 10_000, maxBuffer: 64 * 1024 });
				const sid = /S-1-\d+(?:-\d+)+/.exec(identity.stdout ?? "")?.[0];
				if (!sid) throw new Error("the Windows account SID could not be resolved; the opener configuration was not imported");
				// /grant:r replaces only this SID's grants. Reset first so a pre-existing explicit Everyone ACE is
				// not retained beside it; removing inheritance then leaves only the grant below on this directory.
				await execFile("icacls.exe", [directory, "/reset"], { env, timeout: 10_000, maxBuffer: 64 * 1024 });
				await execFile("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { env, timeout: 10_000, maxBuffer: 64 * 1024 });
			}
			const temporary = join(directory, `import-${randomBytes(12).toString("hex")}.json`);
			try {
				fs.writeFileSync(temporary, JSON.stringify(source.config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
				fs.renameSync(temporary, configPath);
			} finally { fs.rmSync(temporary, { force: true }); }
			// env-internal XDG_DATA_HOME: xdg-mime and xdg-open look up desktop handlers in this same OS data directory.
			const plan = openerRegistration({ platform, home, directory, nodePath, cliPath, dataHome: env.XDG_DATA_HOME || join(home, ".local", "share") });
			if (plan.directory) {
				fs.mkdirSync(plan.directory, { recursive: true, mode: 0o700 });
				if (Number.isInteger(uid) && trustedChain(fs.realpathSync(plan.directory), { fs, uid })) throw new Error("the native handler directory is in a folder another account can change");
			}
			for (const file of plan.files ?? []) fs.writeFileSync(file.path, file.content, { mode: 0o600 });
			for (let i = 0; i < plan.commands.length; i++) {
				const [bin, args] = plan.commands[i];
				// The MIME registration and the desktop entry must use the same XDG directories.
				await execFile(bin, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
				if (i === 0 && plan.between) fs.writeFileSync(plan.between.path, plan.between.content, { mode: 0o600 });
			}
			out("installed pi-dispatch-open for this account; commands wait for Enter in the terminal\n");
			return 0;
		}
		if (!["handle", "prompt"].includes(argv[0]) || argv.length !== 2) throw new Error("usage: pi-dispatch opener install --config <file> (or handle <pi-dispatch-open://link>)");
		const fields = parseSandboxOpenUrl(argv[1]);
		const stored = readSandboxHosts(configPath, { fs, uid, allowMissing: false });
		if (stored.refusal) throw new Error("the local opener has no usable approved configuration; run pi-dispatch opener install --config <Fleet export.json>");
		const command = sandboxCommand(stored.config, fields);
		if (argv[0] === "prompt") {
			const result = await prompt(command);
			if (result.refused) throw new Error(result.message);
			return result.code ?? 0;
		}
		const plan = terminalLaunch({ platform, nodePath, cliPath, url: argv[1], directory: join(directory, "prompts"), env, fs, ...(terminal ? { terminal } : {}) });
		await showTerminal(plan);
		return 0;
	} catch (error) { err(`opener: ${error.message}\n`); return 1; }
}
