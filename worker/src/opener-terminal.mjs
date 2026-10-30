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
// Redirected dispatcher handles do not create an interactive terminal. The new console owns fresh
// keyboard/screen buffers instead of inheriting the dispatcher's pipes or NUL input.
const WINDOWS_CONSOLE_SOURCE = `using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class PiDispatchConsole {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	private struct STARTUPINFO {
		public uint cb;
		public string lpReserved, lpDesktop, lpTitle;
		public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
		public ushort wShowWindow, cbReserved2;
		public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
	}
	[StructLayout(LayoutKind.Sequential)]
	private struct PROCESS_INFORMATION {
		public IntPtr hProcess, hThread;
		public uint dwProcessId, dwThreadId;
	}
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool CloseHandle(IntPtr handle);
	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
	[DllImport("kernel32.dll")]
	private static extern IntPtr GetCurrentProcess();
	public static string Start(string application, string commandLine) {
		STARTUPINFO startup = new STARTUPINFO();
		startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
		startup.dwFlags = 0x00000001;
		startup.wShowWindow = 1;
		PROCESS_INFORMATION process;
		if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x00000010, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
		try {
			bool parentJob, childJob;
			uint exitCode;
			// The console already started. Optional observations must not turn that success into a refusal.
			string parentState = IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out parentJob) ? parentJob.ToString() : "unknown:" + Marshal.GetLastWin32Error();
			string childState = IsProcessInJob(process.hProcess, IntPtr.Zero, out childJob) ? childJob.ToString() : "unknown:" + Marshal.GetLastWin32Error();
			string initialExit = GetExitCodeProcess(process.hProcess, out exitCode) ? exitCode.ToString() : "unknown:" + Marshal.GetLastWin32Error();
			return "pid=" + process.dwProcessId + ";parentJob=" + parentState + ";childJob=" + childState + ";initialExit=" + initialExit;
		} finally { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
	}
}`;
export function windowsPowerShellEnv(env) {
	// env-internal PSModulePath: Windows PowerShell must derive its own module directories. A Node child of
	// PowerShell 7 otherwise inherits incompatible modules ahead of the system's Start-Process implementation.
	return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}
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
		// ShellExecute expands percent templates; CreateProcessW gets the fixed literal argv directly and
		// explicitly allocates a new console without inheriting the dispatcher's redirected standard handles.
		const script = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition ${psString(WINDOWS_CONSOLE_SOURCE)}; [PiDispatchConsole]::Start(${psString(nodePath)}, ${psString([nodePath, ...args].map(windowsArgument).join(" "))})`;
		// EncodedCommand preserves this fixed script through PowerShell 5's command-line parser, including the
		// nested quotes in Arguments. The URI is still validated data in a quoted literal, never script input.
		return { bin: win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], env: windowsPowerShellEnv(env), waitForExit: true };
	}
	throw new Error("this operating system has no supported terminal opener; copy the sandbox command instead");
}
export function spawnTerminal(plan, { spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
	return new Promise((resolve, reject) => {
		// Windows PowerShell can exit successfully without running its command under DETACHED_PROCESS.
		// Await its finite dispatcher normally. libuv's job has SILENT_BREAKAWAY_OK, so the console that
		// dispatcher creates is not owned by the URL handler's lifetime (Node 22.19, win/process.c).
		const child = spawn(plan.bin, plan.args, { detached: !plan.waitForExit, stdio: plan.waitForExit ? ["ignore", "pipe", "pipe"] : "ignore", windowsHide: true, ...(plan.env ? { env: plan.env } : {}) });
		let timer;
		let stdout = "", stderr = "";
		child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-4096); });
		child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
		const failed = (code) => Object.assign(new Error("Windows could not open an interactive console; check Windows PowerShell and use Copy until it is available"), { code, stdout, stderr });
		child.once("error", (error) => { clearTimer(timer); reject(error); });
		if (plan.waitForExit) {
			// This dispatcher exits as soon as CreateProcessW returns. Waiting catches a refused launch without
			// waiting for the person to press Enter, and the deadline bounds a blocked PowerShell/compiler.
			timer = setTimer(() => { child.kill(); reject(failed()); }, 30_000);
			child.once("close", (code) => {
				clearTimer(timer);
				// Exit zero alone does not establish that PowerShell executed the fixed dispatcher at all.
				const receipt = stdout.trim().split(/\r?\n/).at(-1);
				const created = /^pid=[1-9]\d*;parentJob=(?:True|False|unknown:-?\d+);childJob=(?:True|False|unknown:-?\d+);initialExit=(?:\d+|unknown:-?\d+)$/.test(receipt);
				if (code === 0 && created) resolve({ stdout, stderr }); else reject(failed(code));
			});
		} else child.once("spawn", () => { child.unref(); resolve(); });
	});
}
