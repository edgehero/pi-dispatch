#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/** Xvfb writes its allocated display only after it is listening. No xauth, shared display or readiness sleep. */
export async function withDisplay(command, args, { spawnFn = spawn, env = process.env, signals = process, killFn = process.kill.bind(process), timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
	if (!command) return 2;
	let display;
	let app;
	let stopping = false;
	const kill = (child, signal = "SIGKILL") => {
		if (!child?.pid) return;
		try { killFn(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
	};
	const stop = () => { stopping = true; kill(app); kill(display); };
	signals.once("SIGTERM", stop);
	signals.once("SIGINT", stop);
	try {
		display = spawnFn("Xvfb", ["-displayfd", "3", "-screen", "0", "800x600x24", "-nolisten", "tcp", "-noreset"], { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
		const number = await new Promise((resolve) => {
			let text = "";
			let settled = false;
			const finish = (value) => { if (!settled) { settled = true; clearTimer(timer); resolve(value); } };
			const timer = setTimer(() => finish(null), timeoutMs);
			display.once("error", () => finish(null));
			display.once("exit", () => finish(null));
			display.stdio[3]?.on("data", (bytes) => {
				text += bytes;
				if (text.length > 16) finish(null);
				else if (text.includes("\n")) finish(/^\d{1,5}\n$/.test(text) ? text.trim() : null);
			});
		});
		if (stopping) return 143;
		if (number === null || display.exitCode !== null) return 70;
		return await new Promise((resolve) => {
			app = spawnFn(command, args, { detached: true, stdio: "inherit", env: { ...env, HOME: env.HOME || "/home/pi", DISPLAY: `:${number}` } });
			app.once("error", () => resolve(127));
			app.once("exit", (code, signal) => resolve(stopping ? 143 : code ?? (signal ? 1 : 127)));
			// Losing the display must stop the suite, not leave it hanging until the job's wall clock expires.
			display.once("exit", () => { kill(app); resolve(stopping ? 143 : 70); });
		});
	} catch {
		return 70;
	} finally {
		signals.removeListener("SIGTERM", stop);
		signals.removeListener("SIGINT", stop);
		kill(app);
		kill(display);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await withDisplay(process.argv[2], process.argv.slice(3));
