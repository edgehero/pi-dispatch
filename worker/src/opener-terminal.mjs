/** Terminal launchers start only the approval helper. SSH and the sandbox wait for its empty Enter. */
import * as nodeFs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, delimiter, win32 } from "node:path";
import { quoteSandboxArg } from "./sandbox-hosts.mjs";

export function findTerminal(env, { fs = nodeFs } = {}) {
	// env-internal PATH: search only absolute directories for the OS default terminal launcher, never for a sandbox command.
	for (const bin of ["xdg-terminal-exec", "x-terminal-emulator"]) for (const dir of (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter)) {
		if (!dir.startsWith("/")) continue;
		const path = join(dir, bin);
		try { fs.accessSync(path, fs.constants.X_OK); return { bin: path, args: bin === "x-terminal-emulator" ? ["-e"] : [] }; } catch {}
	}
	return null;
}
export function windowsArgument(value) {
	return `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}
const psString = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function terminalLaunch({ platform, nodePath, cliPath, url, directory, env, fs = nodeFs, terminal = findTerminal(env, { fs }) }) {
	const args = [cliPath, "opener", "prompt", url];
	if (platform === "linux") {
		if (!terminal) throw new Error("no default terminal launcher was found; install xdg-terminal-exec or configure x-terminal-emulator, then use Copy until it is installed");
		return { bin: terminal.bin, args: [...terminal.args, nodePath, ...args] };
	}
	if (platform === "darwin") {
		// Opening a .command file delegates to the account's registered terminal application. The file is private,
		// contains only a fixed helper invocation and removes itself after that helper ends.
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `prompt-${randomBytes(12).toString("hex")}.command`);
		fs.writeFileSync(path, `#!/bin/sh\n${[nodePath, ...args].map(quoteSandboxArg).join(" ")}\nresult=$?\nrm -f -- "$0"\nexit "$result"\n`, { mode: 0o700, flag: "wx" });
		return { bin: "/usr/bin/open", args: [path] };
	}
	if (platform === "win32") {
		// env-internal SystemRoot: Windows' own system directory, not a variable forwarded to a container.
		// Start-Process allocates a console using Windows' configured default terminal. Its ArgumentList is one
		// command-line string, so quote for the receiving executable, then quote that string for PowerShell.
		const script = `Start-Process -FilePath ${psString(nodePath)} -ArgumentList ${psString(args.map(windowsArgument).join(" "))} -Wait`;
		return { bin: win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-Command", script] };
	}
	throw new Error("this operating system has no supported terminal opener; copy the sandbox command instead");
}
export function spawnTerminal(plan, { spawn = nodeSpawn } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(plan.bin, plan.args, { detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}
