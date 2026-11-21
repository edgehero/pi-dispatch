// Shared helpers for the lab steps. Runs on a GitHub runner with a real dockerd (cgroupfs driver).
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const IMAGE = process.env.LAB_IMAGE ?? "alpine:3.20";
export const OUT = process.env.LAB_OUT ?? "lab-out";

export function sh(bin, args, { timeoutMs = 60_000 } = {}) {
	return new Promise((resolve) => {
		const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
			resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), killed: Boolean(err?.killed) });
		});
		child.stdin?.end();
	});
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function pidOf(name) {
	const r = await sh("pidof", [name]);
	return r.stdout.trim().split(/\s+/).filter(Boolean);
}

/**
 * Make container STARTS hang while creates still answer: containerd is stopped in pulses, dockerd keeps serving the
 * API. That is the OrbStack symptom in the issue (creates fine, starts take minutes).
 */
export function pulse({ target = "containerd", stopMs = 10_000, contMs = 3_000 } = {}) {
	let running = true;
	let stopped = false;
	const loop = (async () => {
		while (running) {
			const pids = await pidOf(target);
			await sh("sudo", ["kill", "-STOP", ...pids]);
			stopped = true;
			await sleep(stopMs);
			await sh("sudo", ["kill", "-CONT", ...pids]);
			stopped = false;
			if (!running) break;
			await sleep(contMs);
		}
	})();
	return {
		isStopped: () => stopped,
		async end() {
			running = false;
			await loop;
			const pids = await pidOf(target);
			await sh("sudo", ["kill", "-CONT", ...pids]);
		},
	};
}

export async function containers(filters = []) {
	const args = ["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.State}}\t{{.Names}}\t{{.Labels}}\t{{.Command}}"];
	for (const f of filters) args.push("--filter", f);
	const r = await sh("docker", args);
	return r.stdout.split("\n").filter(Boolean).map((line) => {
		const [id, state, name, labels, command] = line.split("\t");
		return { id, state, name, labels, command };
	});
}

export function write(name, data) {
	mkdirSync(OUT, { recursive: true });
	writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
	console.log(`${name}: ${JSON.stringify(data.summary ?? data).slice(0, 2000)}`);
}
