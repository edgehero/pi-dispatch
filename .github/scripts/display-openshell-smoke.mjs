#!/usr/bin/env node
// Run the graphical fixture through OpenShell's REAL adapter, including its policy, Landlock and copy/bind paths.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { makeOpenshellBackend } from "../../worker/src/backend-openshell.mjs";
import { DISPLAY_SCREENSHOT_MAX, displayResult } from "../../worker/src/display-probe.mjs";
import { imageRefProblem } from "../../worker/src/image-ref.mjs";
import { DEFAULT_JOB_SIZE } from "../../worker/src/job-size.mjs";

const [image, mode = "copy", output, expectation] = process.argv.slice(2);
if (!image || imageRefProblem(image) || !["copy", "bind"].includes(mode) || (expectation && expectation !== "--expect-identity-refusal")) throw new Error("Usage: node .github/scripts/display-openshell-smoke.mjs <display-image> <copy|bind> [output.png] [--expect-identity-refusal]");
const scratch = fs.mkdtempSync(join(tmpdir(), "pi-display-openshell-"));
const nonce = randomBytes(6).toString("hex");
const probeImage = `pi-dispatch-display-probe:${nonce}`;
const name = `pi-job-conformance-display-${nonce}`;
let backend;
let timer;
try {
	// This fixed offline fixture has no repository or real credentials. Preserve Xvfb's own diagnostic on failure;
	// ordinary doctor still receives only the closed reason, never arbitrary application stderr.
	fs.writeFileSync(join(scratch, "entrypoint.sh"), `#!/bin/sh
if [ "\${PI_JOB_LAYOUT:-}" = sandbox ]; then ws=/sandbox/workspace; else ws=/workspace; fi
pi-display-probe "$ws/display.png"
code=$?
if [ "$code" -eq 70 ]; then
  node -e 'const result = {}; for (const [set, get] of [["setgid", "getgid"], ["setuid", "getuid"]]) { try { process[set](process[get]()); result[set] = "allowed"; } catch (e) { result[set] = e.code; } } console.log(JSON.stringify(result));' > "$ws/display-diagnostic.txt" 2>&1
  timeout 5s Xvfb -displayfd 3 -screen 0 800x600x24 -nolisten tcp -noreset >> "$ws/display-diagnostic.txt" 2>&1 3>&1
fi
exit "$code"
`);
	fs.writeFileSync(join(scratch, "Dockerfile"), `FROM ${image}\nUSER root\nCOPY entrypoint.sh /entrypoint.sh\nRUN chmod 0755 /entrypoint.sh\nUSER pi\n`);
	if (spawnSync("docker", ["build", "--pull=false", "-q", "-t", probeImage, scratch], { stdio: "inherit" }).status !== 0) throw new Error("display probe image did not build");
	const jobDir = join(scratch, "job");
	const workspace = join(jobDir, "workspace");
	const session = join(jobDir, "session");
	fs.mkdirSync(jobDir, { mode: 0o700 });
	fs.mkdirSync(workspace);
	fs.mkdirSync(session, { mode: 0o700 });
	fs.writeFileSync(join(jobDir, "prompt.md"), "Offline graphical fixture.\n");
	fs.writeFileSync(join(session, "current.jsonl"), "");
	let text = "";
	let outputExceeded = false;
	const abort = new AbortController();
	backend = makeOpenshellBackend({ mode, image: probeImage, engine: "docker", hostEnv: { ANTHROPIC_API_KEY: "display-probe-not-a-key" }, readAllowlist: () => [], readEndpoints: () => [], onOutput: (chunk) => {
		if (text.length + String(chunk).length > 16 * 1024) { outputExceeded = true; abort.abort(); }
		else text += String(chunk);
	} });
	timer = setTimeout(() => { abort.abort(); backend.stopContainer(name).catch(() => {}); }, 360_000);
	const result = await backend.runContainer({ job: { id: "display", kind: "github", repo: "edgehero/pi-dispatch-conformance", provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxTurns: 1 }, prepared: { jobDir, workspace, live: { hostDir: session } }, name, signal: abort.signal, size: DEFAULT_JOB_SIZE });
	const screenshot = join(workspace, "display.png");
	const gone = await backend.containerGone(name) === true;
	const verdict = !gone ? { ok: false, reason: "probe-cleanup-failed" } : displayResult({ code: result.code, stdout: outputExceeded ? "" : text.trim() }, () => {
		const stat = fs.lstatSync(screenshot);
		if (!stat.isFile() || stat.size > DISPLAY_SCREENSHOT_MAX) throw new Error("not a bounded regular screenshot");
		return fs.readFileSync(screenshot);
	});
	console.log(JSON.stringify({ venue: mode === "copy" ? "openshell" : "openshell-bind", ...verdict }));
	let startupDiagnostic = "";
	if (gone && !verdict.ok) {
		const diagnostic = join(workspace, "display-diagnostic.txt");
		try {
			const stat = fs.lstatSync(diagnostic);
			if (stat.isFile() && stat.size <= 16 * 1024) {
				startupDiagnostic = fs.readFileSync(diagnostic, "utf8");
				console.log(`Xvfb startup diagnostic (fixed offline fixture):\n${startupDiagnostic}`);
			}
		} catch {}
	}
	// OpenShell 0.1.4 denies even identity-preserving setgid/setuid. Xvfb's Popen exits before xkbcomp.
	// Assert that measured limitation, not any failure: a changed vendor policy must make us revisit the docs.
	if (expectation) {
		const confirmed = verdict.reason === "display-start-failed"
			&& startupDiagnostic.startsWith('{"setgid":"EPERM","setuid":"EPERM"}\n')
			&& startupDiagnostic.includes("XKB: Failed to compile keymap");
		console.log(JSON.stringify({ expectedIdentityRefusalConfirmed: confirmed }));
		if (!confirmed) process.exitCode = 1;
	} else if (!verdict.ok) process.exitCode = 1;
	else if (output) { const path = resolve(output); fs.mkdirSync(dirname(path), { recursive: true }); fs.copyFileSync(screenshot, path); }
} finally {
	clearTimeout(timer);
	await backend?.stopContainer(name).catch(() => {});
	spawnSync("docker", ["image", "rm", probeImage], { stdio: "ignore" });
	// A sandbox whose removal cannot be verified may still write its bind mounts.
	if (backend && await backend.containerGone(name).catch(() => null) !== true) console.error(`Display sandbox cleanup is incomplete; retained ${scratch}`);
	else fs.rmSync(scratch, { recursive: true, force: true });
}
