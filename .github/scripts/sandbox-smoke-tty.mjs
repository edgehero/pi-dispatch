/** Observe the runtime CLI's SSH terminal handoff before injecting a shell command (#771). */
import { stripVTControlCharacters } from "node:util";

export function sandboxSmokeLines(output) {
	// Readline surrounds actual output with bracketed-paste controls and carriage returns on Linux.
	// Keep complete-line matching: the command's own echoed source is never proof that it executed.
	return stripVTControlCharacters(output).replaceAll("\r", "").split("\n").slice(0, -1);
}

export function sandboxSmokeTty(output) {
	const match = /(?:^|\r?\n)SANDBOX_REMOTE_TTY:(\/dev\/(?:pts\/\d+|ttys[A-Za-z0-9]+))\r?\n/.exec(output);
	return match?.[1] ?? null;
}

export function sandboxSmokeTtyRaw(output) {
	return /(?:^|[\s;])-icanon(?:[\s;]|$)/.test(output) && /(?:^|[\s;])-echo(?:[\s;]|$)/.test(output);
}

export async function waitSandboxSmokeTty({ child, inspect, until, description }) {
	return until(async () => {
		if (child.exitCode !== null) throw new Error(`SSH terminal exited before its runtime attached (exit ${child.exitCode})`);
		const tty = sandboxSmokeTty(child.output);
		if (!tty) return false;
		return sandboxSmokeTtyRaw(await inspect(tty));
	}, description);
}
