#!/usr/bin/env node
// The same display check doctor uses, with no deployment file, credentials, provider or Valkey.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { displayChecks } from "../../worker/src/doctor.mjs";
import { makeDockerEndpointResolver } from "../../worker/src/backend-local.mjs";

const [image, output, venue = "local", mode = "chromium"] = process.argv.slice(2);
if (!image || !["local", "podman"].includes(venue) || !["chromium", "electron"].includes(mode)) throw new Error("Usage: node .github/scripts/display-smoke.mjs <image> [output.png] [local|podman] [chromium|electron]");
const scratch = fs.mkdtempSync(join(tmpdir(), "pi-display-smoke-"));
try {
	const endpoint = venue === "local" ? await makeDockerEndpointResolver()() : null;
	let captured = false;
	const checks = await displayChecks({ PI_BACKENDS: venue, PI_JOB_IMAGE: image, PI_JOBS_DIR: scratch, PI_EGRESS: "0", ...(process.env.PI_JOB_MEMORY ? { PI_JOB_MEMORY: process.env.PI_JOB_MEMORY } : {}) }, {
		spawn, liveFs: fs, platform: process.platform, home: process.env.HOME,
		jobUserIdentity: { platform: process.platform, euid: process.geteuid?.(), egid: process.getegid?.() },
		fileExists: fs.existsSync, cwd: process.cwd(), pid: process.pid, nonce: randomBytes(6).toString("hex"),
		isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
		out: (s) => process.stdout.write(s),
		displayMode: mode,
		displayScreenshot: (bytes, measured) => {
			captured = true;
			console.log(JSON.stringify(measured));
			if (output) { const path = resolve(output); fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, bytes); }
		},
	}, { jobImage: image, dockerCode: 0, endpoint });
	for (const c of checks) console.log(`${c.warn ? "WARN" : c.ok ? "PASS" : "FAIL"} ${c.label}`);
	if (!captured || checks.some((c) => !c.ok || c.warn)) process.exitCode = 1;
} finally {
	// A failed container removal deliberately leaves its bind mounts in place for operator cleanup.
	if (fs.readdirSync(scratch).length === 0) fs.rmdirSync(scratch);
	else console.error(`Display probe cleanup is incomplete; retained ${scratch}`);
}
