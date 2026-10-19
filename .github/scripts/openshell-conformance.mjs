#!/usr/bin/env node
/**
 * Issue #683: run the backend conformance harness against the REAL `openshell` bundle, on a host with an OpenShell
 * gateway (Docker driver) registered on loopback, and the job image in that gateway's engine.
 *
 * Every probe goes through the bundle `makeOpenshellBackend` builds, so what is checked is what a job gets:
 *
 *   - `probe`: the bundle's own `runContainer` (create, policy read-back, upload, `sandbox exec` through pi-landlock,
 *     download, delete) on an image built FROM the job image whose `/entrypoint.sh` exits with the integer in
 *     `/sandbox/job/prompt.md`, or sleeps for the abort, which is then stopped through the bundle's own `stopContainer`.
 *   - `withBrokenEnumeration`: the same bundle on a gateway name that is not registered, so the listing really fails.
 *   - `readBack`: one more run of that image whose entrypoint prints what the sandbox looks like from inside (its
 *     capabilities, seccomp, no_new_privs, pids and memory bounds, uid, mounts, network interfaces, an outbound
 *     connection attempt, a write into its job inputs), plus two of the bundle's own answers: the sandbox listed gone
 *     after the run, and a job image the engine does not hold refused before any sandbox exists.
 *
 * AND ONE CASE OF ITS OWN: the real job image's real runner, keyed, on the sandbox layout, offline under a cost cap of 0,
 * through the bundle, which must end on its own signed `cost-cap` line with the session brought back.
 *
 * STRICTER THAN THE HARNESS, as podman-conformance.mjs is: any abstention among the read-back properties fails. Run it
 * with the worker STOPPED: the harness calls the real `reap`, which deletes every sandbox carrying this worker's owner
 * label, so this refuses to start while one exists.
 *
 *   PI_JOB_IMAGE=pi-job:ci node <repo>/.github/scripts/openshell-conformance.mjs
 *
 * Exit 0 when everything held, 1 when anything failed or was not read, 2 when the host is not one this can run on.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { makeOpenshellBackend, OPENSHELL_OWNER, OPENSHELL_OWNER_LABEL } = await load("worker/src/backend-openshell.mjs");
const { READ_BACK_BY_A_LIVE_PROBE, UNVERIFIED_BY_THIS_HARNESS, runBackendConformance } = await load("worker/src/backend-conformance.mjs");
const { makeLogSink } = await load("worker/src/run-history.mjs");

const refuse = (why) => {
	console.error(`openshell-conformance: ${why}`);
	process.exit(2);
};
const image = process.env.PI_JOB_IMAGE;
if (!image) refuse("PI_JOB_IMAGE must name the job image in the gateway's engine");
const engine = process.env.PI_OPENSHELL_ENGINE ?? "docker";
const nonce = randomBytes(4).toString("hex");
const scratch = nodeFs.mkdtempSync(join(tmpdir(), "pi-dispatch-openshell-conformance-"));
const run = (bin, args, timeout = 600_000) =>
	new Promise((resolveRun) => execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolveRun({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })));

const owned = await run("openshell", ["sandbox", "list", "--selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"]);
if (owned.code !== 0) refuse(`the gateway did not answer a listing: ${owned.stderr.trim().split("\n")[0]}`);
if (JSON.parse(owned.stdout).sandboxes?.length > 0) refuse("sandboxes with this worker's owner label exist; stop the worker and delete them first");

// The probe image: the job image with its entrypoint replaced, so an exit code is the integer the harness asked for.
const context = join(scratch, "probe");
nodeFs.mkdirSync(context);
nodeFs.writeFileSync(
	join(context, "entrypoint.sh"),
	`#!/bin/sh
c=$(cat /sandbox/job/prompt.md)
case "$c" in
	sleep) exec sleep 600 ;;
	readback)
		echo "probe uid=$(id -u)"
		grep -E '^(CapEff|NoNewPrivs|Seccomp):' /proc/self/status | tr -d '\\t' | sed 's/^/probe /'
		echo "probe pids.max=$(cat /sys/fs/cgroup/pids.max 2>&1)"
		echo "probe memory.max=$(cat /sys/fs/cgroup/memory.max 2>&1)"
		echo "probe sandbox-mounts=$(awk '$5 ~ /^\\/sandbox/ {print $5}' /proc/self/mountinfo | tr '\\n' ' ')"
		echo "probe ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' ')"
		echo "probe egress=$(node -e 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:5000});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("timeout",()=>{console.log("blocked");process.exit(0)});s.on("error",()=>{console.log("blocked");process.exit(0)})')"
		if echo planted >> /sandbox/job/prompt.md 2>/dev/null; then echo "probe jobwrite=allowed"; else echo "probe jobwrite=denied"; fi
		# Issue #684: the generated policy, read from inside. An allowlisted host answers (any HTTP status), an unlisted
		# one does not, and a model server on the gateway host answers under each alias the policy names.
		for u in https://api.anthropic.com/ https://example.com/ http://host.openshell.internal:18080/ http://host.docker.internal:18080/ https://github.com/ https://api.github.com/; do
			echo "probe url $u=$(node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(10000)}).then(r=>console.log("reached",r.status),e=>console.log("refused",e.cause?.code??e.name))' "$u")"
		done
		# The forge rule: a push to another repository than the job's is refused by the LAYER (its own 403 body names
		# the policy), never answered by GitHub, which would say 401.
		for u in https://github.com/octocat/Hello-World.git/git-receive-pack; do
			echo "probe push $u=$(node -e 'fetch(process.argv[1],{method:"POST",signal:AbortSignal.timeout(10000)}).then(async r=>console.log(r.status,/policy/i.test(await r.text())?"policy":"upstream"),e=>console.log("refused",e.cause?.code??e.name))' "$u")"
		done
		exit 0 ;;
	*) exit "$c" ;;
esac
`,
	{ mode: 0o755 },
);
nodeFs.writeFileSync(join(context, "Dockerfile"), `FROM ${image}\nUSER root\nCOPY entrypoint.sh /entrypoint.sh\nRUN chmod 0755 /entrypoint.sh\nUSER pi\n`);
const probeImage = `pi-dispatch-openshell-probe:${nonce}`;
const built = await run(engine, ["build", "--pull=false", "-q", "-t", probeImage, context]);
if (built.code !== 0) refuse(`the probe image did not build: ${built.stderr.trim().split("\n").slice(-1)[0]}`);

const output = new Map();
const bundleFor = (img, extra = {}) =>
	makeOpenshellBackend({
		image: img,
		engine,
		hostEnv: { ANTHROPIC_API_KEY: "conformance-probe-not-a-key" },
		onOutput: (chunk) => output.set("last", (output.get("last") ?? "") + String(chunk)),
		...extra,
	});
// Issue #684: the policy every probe runs under: the provider's host, and a model server on the gateway host (the
// workflow starts one on 18080) under both aliases. example.com is deliberately absent.
const POLICY_SOURCES = { readAllowlist: () => ["api.anthropic.com", ".github.com"], readEndpoints: () => [{ id: "lab-a", host: "host.openshell.internal", port: 18080, slots: 1 }, { id: "lab-b", host: "host.docker.internal", port: 18080, slots: 1 }] };
const backend = bundleFor(probeImage, POLICY_SOURCES);
let n = 0;
const jobDirFor = (prompt) => {
	const jobDir = join(scratch, `job-${++n}`);
	nodeFs.mkdirSync(join(jobDir, "workspace"), { recursive: true });
	nodeFs.mkdirSync(join(jobDir, "session"), { recursive: true });
	nodeFs.writeFileSync(join(jobDir, "prompt.md"), `${prompt}\n`);
	nodeFs.writeFileSync(join(jobDir, "session", "current.jsonl"), "");
	return { jobDir, workspace: join(jobDir, "workspace"), live: { hostDir: join(jobDir, "session") } };
};
const JOB = { id: "conformance", kind: "github", repo: "edgehero/pi-dispatch-conformance", provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxTurns: 1 };

async function probe(b, { exitCode, aborted = false }) {
	const ac = new AbortController();
	const name = `pi-job-conformance-${nonce}-${n + 1}`;
	const dirs = jobDirFor(aborted ? "sleep" : String(exitCode));
	const running = b.runContainer({ job: JOB, prepared: dirs, name, signal: ac.signal, size: { memMiB: 1024, cpuCenti: 100 } });
	if (aborted) {
		// The stop index.mjs sends on a timeout: the abort flag first, then the venue's own stop, once the exec runs.
		for (let i = 0; i < 120; i++) {
			const listed = await run("openshell", ["sandbox", "get", name, "-o", "json"], 15_000);
			if (listed.code === 0 && JSON.parse(listed.stdout).phase === "Ready") break;
			await new Promise((r) => setTimeout(r, 1000));
		}
		await new Promise((r) => setTimeout(r, 5000));
		ac.abort();
		await b.stopContainer(name);
	}
	return running;
}

const withBrokenEnumeration = () => bundleFor(probeImage, { gateway: `no-such-gateway-${nonce}` }).reap();

async function readBack(b) {
	output.set("last", "");
	const name = `pi-job-conformance-${nonce}-readback`;
	const result = await b.runContainer({ job: JOB, prepared: jobDirFor("readback"), name, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const said = Object.fromEntries([...String(output.get("last")).matchAll(/^probe ([A-Za-z.-]+)[=:][ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	const urls = Object.fromEntries([...String(output.get("last")).matchAll(/^probe url (\S+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	const pushes = Object.fromEntries([...String(output.get("last")).matchAll(/^probe push (\S+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	Object.assign(readings, { urls, pushes });
	const gone = await b.containerGone(name);
	let pinned;
	try {
		await bundleFor(`pi-dispatch-not-in-this-engine:${nonce}`).runContainer({ job: JOB, prepared: jobDirFor("0"), name: `pi-job-conformance-${nonce}-absent`, signal: new AbortController().signal });
		pinned = { ok: false, detail: "a job image the engine does not hold ran" };
	} catch (err) {
		const listed = await run("openshell", ["sandbox", "get", `pi-job-conformance-${nonce}-absent`, "-o", "json"], 15_000);
		pinned = err?.reason === "container-never-started" && listed.code !== 0 ? { ok: true, detail: "an image the engine does not hold is refused before any sandbox exists (the ID is read from the engine, never pulled)" } : { ok: false, detail: `refused as ${err?.reason ?? err?.message}, sandbox listed: ${listed.code === 0}` };
	}
	console.log(`readback (exit ${result.code}): ${JSON.stringify(said)}`);
	const ifaces = (said.ifaces ?? "").split(" ").filter(Boolean);
	return {
		isolation: { ok: said.CapEff === "0000000000000000" && said.NoNewPrivs === "1" && said.Seccomp === "2" && /^\d+$/.test(said["pids.max"] ?? "") && said["memory.max"] === String(1024 * 1024 * 1024), detail: `CapEff ${said.CapEff}, NoNewPrivs ${said.NoNewPrivs}, Seccomp ${said.Seccomp}, pids.max ${said["pids.max"]}, memory.max ${said["memory.max"]}` },
		ephemeral: { ok: gone === true, detail: `the bundle's own gone-check after the run said ${gone}` },
		mountSet: { ok: (said["sandbox-mounts"] ?? "") === "", detail: `mounts under /sandbox: ${JSON.stringify(said["sandbox-mounts"] ?? null)} (a copy mounts nothing there)` },
		egress: { ok: said.egress === "blocked", detail: `an outbound connection to 1.1.1.1:443 was ${said.egress ?? "not tried"}` },
		jobToJobIsolation: { ok: ifaces.length > 0 && ifaces.every((i) => i === "lo"), detail: `network interfaces: ${ifaces.join(", ") || "none read"}` },
		imagePinning: pinned,
		nonRoot: { ok: /^[1-9]\d*$/.test(said.uid ?? ""), detail: `uid ${said.uid}` },
		localFolders: { ok: false, detail: "copy mode edits a copy, never a folder in place (declared absent)" },
		readOnlyJobInputs: { ok: said.jobwrite === "denied", detail: `an append to /sandbox/job/prompt.md was ${said.jobwrite ?? "not tried"}` },
	};
}

let failed = false;
const readings = {};
const r = await runBackendConformance(backend, { probe, withBrokenEnumeration, readBack: async (b) => Object.assign(readings, await readBack(b)) });
for (const f of r.findings) {
	console.log(`${f.ok ? (f.unverifiable ? "ABSTAIN" : "ok     ") : "FAIL   "} ${f.property ?? f.check}: ${f.detail ?? ""}`);
	if (!f.ok) failed = true;
	if (f.unverifiable && READ_BACK_BY_A_LIVE_PROBE.includes(f.property ?? f.check)) failed = true;
}
// Issue #684: the generated policy, held to what it says: the allowlisted host and both model-server aliases reached, the
// unlisted host refused.
{
	const u = readings.urls ?? {};
	const reached = (url) => /^reached /.test(u[url] ?? "");
	const push = readings.pushes?.["https://github.com/octocat/Hello-World.git/git-receive-pack"] ?? "";
	const ok = reached("https://api.anthropic.com/") && !reached("https://example.com/") && reached("http://host.openshell.internal:18080/") && reached("http://host.docker.internal:18080/") && reached("https://github.com/") && reached("https://api.github.com/") && /^403 policy$/.test(push);
	console.log(`${ok ? "ok     " : "FAIL   "} the generated policy: ${JSON.stringify({ ...u, push })}`);
	if (!ok) failed = true;
}
// readOnlyJobInputs is not in the harness's read-back list (the transfer check covers its word); this script reads it.
console.log(`${readings.readOnlyJobInputs?.ok ? "ok     " : "FAIL   "} readOnlyJobInputs (live): ${readings.readOnlyJobInputs?.detail}`);
if (!readings.readOnlyJobInputs?.ok) failed = true;
for (const [property, why] of Object.entries(UNVERIFIED_BY_THIS_HARNESS)) console.log(`not read ${property}: ${why}`);

// The real runner, keyed and offline, under a cost cap of 0: its own signed exit line, the session brought back.
{
	const logs = join(scratch, "logs");
	nodeFs.mkdirSync(logs);
	const real = bundleFor(image, { openJobLog: makeLogSink({ logsDir: logs, enabled: false }) });
	const dirs = jobDirFor("Reply with the single word ok.");
	const result = await real.runContainer({ job: { ...JOB, maxCostMicros: 0 }, prepared: dirs, name: `pi-job-conformance-${nonce}-runner`, signal: new AbortController().signal, exitAuth: true, size: { memMiB: 2048, cpuCenti: 200 } });
	const session = nodeFs.readFileSync(join(dirs.jobDir, "session", "current.jsonl"), "utf8");
	const ok = result.code === 2 && result.exitReason === "cost-cap" && result.exitAuth === "verified" && session.length > 0;
	console.log(`${ok ? "ok     " : "FAIL   "} the real runner: exit ${result.code}, reason ${result.exitReason}, exit line ${result.exitAuth}, session ${session.length} bytes`);
	if (!ok) failed = true;
}

await run(engine, ["image", "rm", "-f", probeImage]);
nodeFs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
