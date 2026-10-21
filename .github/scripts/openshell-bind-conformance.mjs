#!/usr/bin/env node
/**
 * Issue #686 part 3: the `openshell-bind` venue's conformance run, the sibling of openshell-conformance.mjs, against the
 * REAL bundle `makeOpenshellBackend({ mode: "bind" })` builds, on a host with an OpenShell gateway (Docker driver) on
 * loopback and the job image in that gateway's engine. Two passes, because the gateway's settings decide the venue:
 *
 *   --default-config  on a gateway WITHOUT the bind settings (the lane runs it before writing gateway.toml): the bundle's
 *                     own preflight must refuse the job before spend, `openshell-bind-mounts-disabled`, its probe create
 *                     refused with upstream's `allow_driver_config` sentence (the setting is logged by name).
 *   (no argument)     on a gateway restarted WITH them: the backend conformance harness through the bundle's own
 *                     `runContainer`, and read back off live sandboxes:
 *                       - readOnlyJobInputs: an append to /job refused;
 *                       - mountSet: the mount points a bind sandbox has beyond a copy sandbox of the same image are
 *                         exactly the job's binds (so the driver added nothing of the job's own), the copy one read
 *                         through the real `openshell` bundle on the same gateway;
 *                       - localFolders: a folder job edits a host folder outside the job directory in place;
 *                       - the usual eight (isolation, ephemeral, egress, jobToJobIsolation, imagePinning, nonRoot);
 *                     then the real job image's runner, keyed and offline under a cost cap of 0, whose transcript must
 *                     reach the real publisher from the HOST FILE the bind writes (the tail), never over stderr.
 *
 * Run with the worker STOPPED (the harness's reap deletes every owner-labelled sandbox). Exit 0 when everything held,
 * 1 when anything failed or was not read, 2 when the host is not one this can run on.
 *
 *   PI_JOB_IMAGE=pi-job:ci node <repo>/.github/scripts/openshell-bind-conformance.mjs [--default-config]
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { makeOpenshellBackend, OPENSHELL_OWNER, OPENSHELL_OWNER_LABEL, sandboxNameOf } = await load("worker/src/backend-openshell.mjs");
const { READ_BACK_BY_A_LIVE_PROBE, runBackendConformance } = await load("worker/src/backend-conformance.mjs");
const { buildRecord, makeLogSink } = await load("worker/src/run-history.mjs");
const { networkPolicyFor } = await load("worker/src/openshell-policy.mjs");
const { makeLiveTranscriptOpener } = await load("worker/src/live-transcript.mjs");

// Every owned sandbox the gateway still lists, polled until the listing is empty or 30 s have passed: a delete is
// asynchronous (measured in #684), so a single read can see one on its way out.
async function ownedAfterSettling() {
	let left = [];
	for (let i = 0; i < 30; i++) {
		left = JSON.parse((await run("openshell", ["sandbox", "list", "--selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"])).stdout).sandboxes ?? [];
		if (left.length === 0) return left;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return left;
}
const refuse = (why) => {
	console.error(`openshell-bind-conformance: ${why}`);
	process.exit(2);
};
const image = process.env.PI_JOB_IMAGE;
if (!image) refuse("PI_JOB_IMAGE must name the job image in the gateway's engine");
const defaultConfig = process.argv.includes("--default-config");
const nonce = randomBytes(4).toString("hex");
const scratch = nodeFs.mkdtempSync(join(tmpdir(), "pi-dispatch-openshell-bind-conformance-"));
const run = (bin, args, timeout = 600_000) =>
	new Promise((resolveRun) => execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolveRun({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })));

const owned = await run("openshell", ["sandbox", "list", "--selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"]);
if (owned.code !== 0) refuse(`the gateway did not answer a listing: ${owned.stderr.trim().split("\n")[0]}`);
if (JSON.parse(owned.stdout).sandboxes?.length > 0) refuse("sandboxes with this worker's owner label exist; stop the worker and delete them first");

const JOB = { id: "conformance", kind: "github", repo: "edgehero/pi-dispatch-conformance", provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxTurns: 1 };
const POLICY_SOURCES = { readAllowlist: () => ["api.anthropic.com"], readEndpoints: () => [] };
const output = new Map();
const bundleFor = (mode, img, extra = {}) =>
	makeOpenshellBackend({
		mode,
		image: img,
		hostEnv: { ANTHROPIC_API_KEY: "conformance-probe-not-a-key" },
		onOutput: (chunk) => output.set("last", (output.get("last") ?? "") + String(chunk)),
		...POLICY_SOURCES,
		...extra,
	});

if (defaultConfig) {
	const events = [];
	const answer = await bundleFor("bind", image, { log: (event, fields) => events.push([event, fields]) }).observationPreflight(JOB);
	const setting = events.find(([e]) => e === "openshell_bind_mounts_disabled")?.[1]?.setting ?? null;
	const ok = answer?.venueRefused?.reason === "openshell-bind-mounts-disabled" && setting === "allow_driver_config";
	console.log(`${ok ? "ok     " : "FAIL   "} a default gateway refuses bind mode before spend: ${JSON.stringify(answer)}, setting ${setting}`);
	const left = await ownedAfterSettling();
	console.log(`${left.length === 0 ? "ok     " : "FAIL   "} the probe created nothing: ${left.length} owned sandbox(es) listed`);
	nodeFs.rmSync(scratch, { recursive: true, force: true });
	process.exit(ok && left.length === 0 ? 0 : 1);
}

// The probe image: the job image with its entrypoint replaced. It finds its prompt on either layout, so the copy bundle
// can run it too (for the mount-point baseline).
const context = join(scratch, "probe");
nodeFs.mkdirSync(context);
nodeFs.writeFileSync(
	join(context, "entrypoint.sh"),
	`#!/bin/sh
c=$(cat /job/prompt.md 2>/dev/null || cat /sandbox/job/prompt.md)
case "$c" in
	sleep) exec sleep 600 ;;
	folder) echo in-place >> /workspace/notes.txt && exit 0; exit 9 ;;
	background)
		# Review round 1 (#714), M1: a writer the agent leaves behind, outside the exec's process group.
		setsid sh -c 'i=0; while [ $i -lt 120 ]; do echo tick >> /workspace/bg.txt; i=$((i+1)); sleep 1; done' </dev/null >/dev/null 2>&1 &
		sleep 3
		# The marker the host reads: every tick after it was written after the exec's own process ended.
		echo EXIT >> /workspace/bg.txt
		exit 0 ;;
	rocheck)
		# Not vacuous (review round 2): each path is its own mount point, the host-planted file reads through it, and only
		# then is the write's refusal the bind's own (EROFS), not the policy's read-only /opt or a missing directory.
		for p in /inbox /opt/pi-global; do
			k=$(echo "$p" | tr -dc 'a-z')
			echo "probe mount.$k=$(awk -v p="$p" '$5 == p {print "yes"; exit}' /proc/self/mountinfo)"
			echo "probe read.$k=$(cat "$p/host-planted" 2>/dev/null)"
			if err=$( (echo x >> "$p/planted") 2>&1 ); then w=allowed; elif echo "$err" | grep -q 'Read-only file system'; then w=erofs; else w=other; fi
			echo "probe write.$k=$w"
		done
		exit 0 ;;
	whoami)
		echo "probe uid=$(id -u) gid=$(id -g)"
		echo mine > /workspace/owned.txt && echo "probe home=$(touch "$HOME/.probe" 2>/dev/null && echo writable || echo denied)"
		exit 0 ;;
	bundle)
		# Issue #704 part 3: the copy pass's bundle case, through the bind stage (one stage for both modes).
		echo "probe btoken=$(case "$BUNDLE_TOKEN" in openshell:resolve:env:*) echo placeholder ;; conformance-bundle-not-a-token) echo value ;; '') echo unset ;; *) echo other ;; esac)"
		echo "probe bplain=$(if [ "$PI_BUNDLE_ENV" = 1 ] && grep -q conformance-bundle-plain-value /job/bundle-env.json 2>/dev/null; then echo file; else echo other; fi)"
		# Readable means NON-EMPTY, read the way the count below reads it (a redirect, so the subshell's own environ, not a
		# fresh child's): under OpenShell 0.1.4 that file opens and reads as nothing, as the credentials case measured.
		echo "probe benviron-readable=$(if [ "$(tr '\\0' '\\n' < /proc/self/environ 2>/dev/null | wc -c)" -gt 0 ]; then echo yes; else echo no; fi)"
		echo "probe benviron=$(tr '\\0' '\\n' < /proc/self/environ | grep -c -e '^BUNDLE_TOKEN=openshell:resolve:env:')"
		echo "probe bown=$(node -e 'fetch("http://host.docker.internal:18080/bundle-bind",{headers:{authorization:"Bearer "+process.env.BUNDLE_TOKEN},signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log("refused",e.cause?.code??e.name))')"
		exit 0 ;;
	readback)
		echo "probe uid=$(id -u)"
		grep -E '^(CapEff|NoNewPrivs|Seccomp):' /proc/self/status | tr -d '\\t' | sed 's/^/probe /'
		echo "probe pids.max=$(cat /sys/fs/cgroup/pids.max 2>&1)"
		echo "probe memory.max=$(cat /sys/fs/cgroup/memory.max 2>&1)"
		echo "probe mounts=$(awk '{print $5}' /proc/self/mountinfo | sort -u | tr '\\n' ' ')"
		echo "probe ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' ')"
		echo "probe egress=$(node -e 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:5000});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("timeout",()=>{console.log("blocked");process.exit(0)});s.on("error",()=>{console.log("blocked");process.exit(0)})')"
		if echo planted >> /job/prompt.md 2>/dev/null; then echo "probe jobwrite=allowed"; else echo "probe jobwrite=denied"; fi
		exit 0 ;;
	*) exit "$c" ;;
esac
`,
	{ mode: 0o755 },
);
nodeFs.writeFileSync(join(context, "Dockerfile"), `FROM ${image}\nUSER root\nCOPY entrypoint.sh /entrypoint.sh\nRUN chmod 0755 /entrypoint.sh\nUSER pi\n`);
const probeImage = `pi-dispatch-openshell-bind-probe:${nonce}`;
const built = await run("docker", ["build", "--pull=false", "-q", "-t", probeImage, context]);
if (built.code !== 0) refuse(`the probe image did not build: ${built.stderr.trim().split("\n").slice(-1)[0]}`);

let n = 0;
const jobDirFor = (prompt, { folder = null } = {}) => {
	const jobDir = join(scratch, `job-${++n}`);
	nodeFs.mkdirSync(join(jobDir, "session"), { recursive: true });
	nodeFs.writeFileSync(join(jobDir, "prompt.md"), `${prompt}\n`);
	nodeFs.writeFileSync(join(jobDir, "session", "current.jsonl"), "");
	if (folder === null) nodeFs.mkdirSync(join(jobDir, "workspace"));
	return { jobDir, workspace: folder ?? join(jobDir, "workspace"), live: { hostDir: join(jobDir, "session") } };
};
const backend = bundleFor("bind", probeImage);

async function probe(b, { exitCode, aborted = false }) {
	const ac = new AbortController();
	const name = `pi-job-bind-conformance-${nonce}-${n + 1}`;
	const running = b.runContainer({ job: JOB, prepared: jobDirFor(aborted ? "sleep" : String(exitCode)), name, signal: ac.signal, size: { memMiB: 1024, cpuCenti: 100 } });
	if (aborted) {
		// The stop index.mjs sends on a timeout: the abort flag first, then the venue's own stop, once the sandbox is Ready.
		for (let i = 0; i < 120; i++) {
			const listed = await run("openshell", ["sandbox", "get", sandboxNameOf(name), "-o", "json"], 15_000);
			if (listed.code === 0 && JSON.parse(listed.stdout).phase === "Ready") break;
			await new Promise((r) => setTimeout(r, 1000));
		}
		await new Promise((r) => setTimeout(r, 5000));
		ac.abort();
		await b.stopContainer(name);
	}
	return running;
}
const withBrokenEnumeration = () => bundleFor("bind", probeImage, { gateway: `no-such-gateway-${nonce}` }).reap();

const said = (text) => Object.fromEntries([...String(text).matchAll(/^probe ([A-Za-z.-]+)[=:][ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const readings = {};
async function readBack(b) {
	output.set("last", "");
	const name = `pi-job-bind-conformance-${nonce}-readback`;
	const dirs = jobDirFor("readback");
	const result = await b.runContainer({ job: JOB, prepared: dirs, name, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const bindSaid = said(output.get("last"));
	const gone = await b.containerGone(name);
	// The baseline: the same image through the COPY bundle on the same gateway, so what the binds add is a difference.
	output.set("last", "");
	await bundleFor("copy", probeImage).runContainer({ job: JOB, prepared: jobDirFor("readback"), name: `pi-job-bind-conformance-${nonce}-baseline`, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const copySaid = said(output.get("last"));
	const set = (s) => new Set((s.mounts ?? "").split(" ").filter(Boolean));
	const extra = [...set(bindSaid)].filter((m) => !set(copySaid).has(m)).sort();
	const wantMounts = ["/job", "/session", "/workspace"];
	// A folder job: the operator's folder, outside the job directory, edited in place.
	const folder = join(scratch, `folder-${nonce}`);
	nodeFs.mkdirSync(folder);
	nodeFs.writeFileSync(join(folder, "notes.txt"), "before\n");
	const folderRun = await b.runContainer({ job: { ...JOB, kind: "local" }, prepared: { ...jobDirFor("folder", { folder }), outboxDir: undefined }, name: `pi-job-bind-conformance-${nonce}-folder`, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const notes = nodeFs.readFileSync(join(folder, "notes.txt"), "utf8");
	let pinned;
	try {
		await bundleFor("bind", `pi-dispatch-not-in-this-engine:${nonce}`).runContainer({ job: JOB, prepared: jobDirFor("0"), name: `pi-job-bind-conformance-${nonce}-absent`, signal: new AbortController().signal });
		pinned = { ok: false, detail: "a job image the engine does not hold ran" };
	} catch (err) {
		pinned = err?.reason === "container-never-started" ? { ok: true, detail: "an image the engine does not hold is refused before any sandbox exists" } : { ok: false, detail: `refused as ${err?.reason ?? err?.message}` };
	}
	console.log(`readback (exit ${result.code}): ${JSON.stringify(bindSaid)}; mounts beyond copy mode's: ${JSON.stringify(extra)}`);
	const ifaces = (bindSaid.ifaces ?? "").split(" ").filter(Boolean);
	Object.assign(readings, { readOnlyJobInputs: { ok: bindSaid.jobwrite === "denied", detail: `an append to /job was ${bindSaid.jobwrite ?? "not tried"}` } });
	return {
		isolation: { ok: bindSaid.CapEff === "0000000000000000" && bindSaid.NoNewPrivs === "1" && bindSaid.Seccomp === "2" && /^\d+$/.test(bindSaid["pids.max"] ?? "") && bindSaid["memory.max"] === String(1024 * 1024 * 1024), detail: `CapEff ${bindSaid.CapEff}, NoNewPrivs ${bindSaid.NoNewPrivs}, Seccomp ${bindSaid.Seccomp}, pids.max ${bindSaid["pids.max"]}, memory.max ${bindSaid["memory.max"]}` },
		ephemeral: { ok: gone === true, detail: `the bundle's own gone-check after the run said ${gone}` },
		mountSet: { ok: JSON.stringify(extra) === JSON.stringify(wantMounts), detail: `mount points a bind sandbox has beyond a copy one: ${JSON.stringify(extra)} (want exactly the job's binds ${JSON.stringify(wantMounts)})` },
		egress: { ok: bindSaid.egress === "blocked", detail: `an outbound connection to 1.1.1.1:443 was ${bindSaid.egress ?? "not tried"}` },
		jobToJobIsolation: { ok: ifaces.length > 0 && ifaces.every((i) => i === "lo"), detail: `network interfaces: ${ifaces.join(", ") || "none read"}` },
		imagePinning: pinned,
		nonRoot: { ok: /^[1-9]\d*$/.test(bindSaid.uid ?? ""), detail: `uid ${bindSaid.uid}` },
		localFolders: { ok: folderRun.code === 0 && notes === "before\nin-place\n", detail: `a folder job exited ${folderRun.code}, and the host folder's file reads ${JSON.stringify(notes)}` },
	};
}

let failed = false;
// The gate on a gateway with the settings on: the probe admits, and it leaves nothing behind (measured: its create fails
// at provisioning and the sandbox stays in phase Error, so the bundle deletes it).
{
	const events = [];
	const answer = await bundleFor("bind", probeImage, { log: (event, fields) => events.push([event, fields]) }).observationPreflight(JOB);
	// Not vacuous (review round 1): a gate that skipped its probe (`unprobed`) passes too, so the probe must have RUN.
	const probed = events.find(([e]) => e === "openshell_bind_probed")?.[1]?.answer ?? null;
	const left = await ownedAfterSettling();
	const ok = answer?.venueRefused === undefined && answer?.unavailable === undefined && probed === "admitted" && left.length === 0;
	console.log(`${ok ? "ok     " : "FAIL   "} the bind gate admits on a probe that ran (${probed}), its probe deleted: ${JSON.stringify(answer)}, ${left.length} owned sandbox(es) left`);
	if (!ok) failed = true;
}
const r = await runBackendConformance(backend, { probe, withBrokenEnumeration, readBack: readBack });
for (const f of r.findings) {
	console.log(`${f.ok ? (f.unverifiable ? "ABSTAIN" : "ok     ") : "FAIL   "} ${f.property ?? f.check}: ${f.detail ?? ""}`);
	if (!f.ok) failed = true;
	if (f.unverifiable && READ_BACK_BY_A_LIVE_PROBE.includes(f.property ?? f.check)) failed = true;
}
// The harness passes a binding venue's readOnlyJobInputs on its `binds` alone; this script reads it off the sandbox.
console.log(`${readings.readOnlyJobInputs?.ok ? "ok     " : "FAIL   "} readOnlyJobInputs (live): ${readings.readOnlyJobInputs?.detail}`);
if (!readings.readOnlyJobInputs?.ok) failed = true;

// The real runner, keyed and offline at a cost cap of 0, its transcript TAILED from the host file the bind writes.
{
	const logs = join(scratch, "logs");
	nodeFs.mkdirSync(logs);
	const xadds = [];
	const redis = {
		status: "ready",
		multi() {
			const tx = { del: () => tx, pexpire: () => tx, xadd: (_key, ...args) => (xadds.push(args), tx), exec: async () => [] };
			return tx;
		},
	};
	const opener = makeLiveTranscriptOpener({ redis, transcripts: true, progress: false });
	const opened = [];
	const openLiveTranscript = (args) => (opened.push({ source: args.source ?? "file", file: args.file ?? null }), opener(args));
	const events = [];
	const real = bundleFor("bind", image, { openJobLog: makeLogSink({ logsDir: logs, enabled: false }), openLiveTranscript, log: (event, fields) => events.push([event, fields]) });
	const dirs = jobDirFor("Reply with the single word ok.");
	output.set("last", "");
	const result = await real.runContainer({ job: { ...JOB, maxCostMicros: 0 }, prepared: dirs, name: `pi-job-bind-conformance-${nonce}-runner`, signal: new AbortController().signal, exitAuth: true, transcriptStderr: true, jobId: `bind-conformance-${nonce}`, size: { memMiB: 2048, cpuCenti: 200 } });
	const session = nodeFs.readFileSync(join(dirs.jobDir, "session", "current.jsonl"), "utf8");
	const ok = result.code === 2 && result.exitReason === "cost-cap" && result.exitAuth === "verified" && session.length > 0;
	console.log(`${ok ? "ok     " : "FAIL   "} the real runner: exit ${result.code}, reason ${result.exitReason}, exit line ${result.exitAuth}, session ${session.length} bytes written through the bind`);
	const kinds = xadds.map((fields) => fields[fields.indexOf("kind") + 1]);
	const fromSession = kinds.filter((k) => k !== "end" && k !== "skipped").length;
	const tailed = opened.length === 1 && opened[0].source === "file" && opened[0].file === join(dirs.jobDir, "session", "current.jsonl");
	const skipped = events.filter(([e]) => e === "live_transcript_skipped" || e === "transcript_record_unverified");
	const piped = tailed && fromSession > 0 && kinds.at(-1) === "end" && skipped.length === 0;
	console.log(`${piped ? "ok     " : "FAIL   "} the live transcript from the host file: opened ${JSON.stringify(opened)}, ${fromSession} entries from the session (${[...new Set(kinds)].join(", ") || "none"}), ${skipped.length} skip events`);
	if (!ok) console.log(String(output.get("last") ?? "").split("\n").slice(-15).join("\n"));
	if (!ok || !piped) failed = true;
}

// Review round 1 (#714), M1: a writer left running in the sandbox stops writing the host the moment the run returns,
// because the bundle ends the sandbox (and waits for it to be gone) first.
{
	const dirs = jobDirFor("background");
	const result = await backend.runContainer({ job: JOB, prepared: dirs, name: `pi-job-bind-conformance-${nonce}-bg`, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const bg = join(dirs.workspace, "bg.txt");
	const read = () => (nodeFs.existsSync(bg) ? nodeFs.readFileSync(bg, "utf8") : "");
	const atReturn = read();
	await new Promise((r) => setTimeout(r, 6000));
	const later = read();
	// Not vacuous (review round 2): the writer must have OUTLIVED the exec (ticks after its EXIT marker by the run's
	// return, which the settle waited through), and written nothing since.
	const after = atReturn.includes("EXIT\n") ? atReturn.slice(atReturn.indexOf("EXIT\n") + 5).split("\n").filter((l) => l === "tick").length : -1;
	const ok = result.code === 0 && result.lingering !== true && after > 0 && later === atReturn;
	console.log(`${ok ? "ok     " : "FAIL   "} a backgrounded setsid writer outlived the exec (${after} ticks after its exit) and stopped at the run's return (${atReturn.length} bytes then, ${later.length} six seconds later)`);
	if (!ok) failed = true;
}

// Review round 1 (#714): /inbox and the overlay are read-only binds (EROFS), on a steer-armed attempt with an overlay.
{
	const overlay = join(scratch, "overlay");
	nodeFs.mkdirSync(overlay);
	nodeFs.writeFileSync(join(overlay, "host-planted"), "from-host\n");
	const roDirs = jobDirFor("rocheck");
	// The inbox the run makes is `<jobDir>.inbox`, fresh per attempt, so its planted file is written by a relay that
	// writes it at start, as a real one writes a message file.
	const relay = { start: async () => nodeFs.writeFileSync(join(`${roDirs.jobDir}.inbox`, "host-planted"), "from-host\n"), stop: async () => {}, delivered: async () => {}, attach() {} };
	const opener = makeLiveTranscriptOpener({ redis: { status: "ready", multi() { const tx = { del: () => tx, pexpire: () => tx, xadd: () => tx, exec: async () => [] }; return tx; } }, transcripts: true, progress: false, steer: true });
	const ro = bundleFor("bind", probeImage, { globalPiDir: overlay, openInboxRelay: () => relay, openLiveTranscript: opener });
	output.set("last", "");
	await ro.runContainer({ job: { ...JOB, steer: true }, prepared: roDirs, name: `pi-job-bind-conformance-${nonce}-ro`, signal: new AbortController().signal, exitAuth: true, binds: true, jobId: `bind-ro-${nonce}`, size: { memMiB: 1024, cpuCenti: 100 } });
	const got = said(output.get("last"));
	const ok = ["inbox", "optpiglobal"].every((k) => got[`mount.${k}`] === "yes" && got[`read.${k}`] === "from-host" && got[`write.${k}`] === "erofs") && !nodeFs.existsSync(join(overlay, "planted"));
	console.log(`${ok ? "ok     " : "FAIL   "} /inbox and the overlay are read-only binds (mount points, host files read through, EROFS on a write): ${JSON.stringify(got)}`);
	if (!ok) failed = true;
}

// Issue #704 part 3: a project secret bundle in bind mode: the placeholder in the env and /proc/self/environ, the plain
// value in the bound job directory's bundle-env.json (review round 1, H1: never the exec), the real value at the stand-in's host (the workflow's, still running across the gateway restart), and
// the providers gone after the run.
{
	const values = { BUNDLE_TOKEN: "conformance-bundle-not-a-token", BUNDLE_PLAIN: "conformance-bundle-plain-value" };
	const b = bundleFor("bind", probeImage, { readEndpoints: () => [{ id: "lab-b", host: "host.docker.internal", port: 18080, slots: 1 }] });
	const name = `pi-job-bind-conformance-${nonce}-bundle`;
	output.set("last", "");
	const result = await b.runContainer({ job: JOB, prepared: jobDirFor("bundle"), name, signal: new AbortController().signal, secrets: values, bundleKeys: { endpoints: { BUNDLE_TOKEN: { host: "host.docker.internal", auth: "bearer" } }, plain: ["BUNDLE_PLAIN"] }, size: { memMiB: 1024, cpuCenti: 100 } });
	const got = said(output.get("last"));
	let seen = [];
	try {
		seen = nodeFs.readFileSync(process.env.STANDIN_LOG ?? "", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {}
	const swapped = seen.some((e) => e.path === "/bundle-bind" && e.authorization === `Bearer ${values.BUNDLE_TOKEN}`);
	const listed = await run("openshell", ["provider", "list", "--label-selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"], 30_000);
	const left = listed.code === 0 ? (JSON.parse(listed.stdout).providers ?? []).map((p) => p.name).filter((p) => p.startsWith(sandboxNameOf(name))) : null;
	const ok = result.code === 0 && got.btoken === "placeholder" && (got["benviron-readable"] === "no" || got.benviron === "1") && got.bplain === "file" && got.bown === "200" && swapped && Array.isArray(left) && left.length === 0;
	console.log(`${ok ? "ok     " : "FAIL   "} a secret bundle in bind mode: ${JSON.stringify({ exit: result.code, ...got, swapped, providersLeft: left })}`);
	if (!ok) failed = true;
	// Issue #712: the run's record-facing facts in bind mode (collectRun's early return carries them too): the mode, the
	// policy's hosts with the bundle's own among them, the job's provider and the bundle host's. Never a value.
	const record = buildRecord({ job: { id: "conformance", attemptsMade: 0, data: { ...JOB, backend: "openshell-bind" } }, result: { outcome: "completed", exitCode: result.code, openshell: result.openshell }, startedAt: null, endedAt: null });
	const facts = record.openshell ?? null;
	// Exact, from this run's sources (POLICY_SOURCES' allowlist, the endpoint this case reads) through the same generator,
	// and the keys: the job's provider binds ANTHROPIC_API_KEY (no token is passed here), the bundle host's BUNDLE_TOKEN.
	const policy = networkPolicyFor({ allowlist: POLICY_SOURCES.readAllowlist(), endpoints: [{ id: "lab-b", host: "host.docker.internal", port: 18080, slots: 1 }], kind: JOB.kind, repo: JOB.repo });
	const wantHosts = [...new Set(Object.values(policy.network_policies ?? {}).flatMap((rule) => rule.endpoints.map((e) => e.host)))].sort();
	const factsOk = facts !== null && facts.mode === "bind" && JSON.stringify(facts.ruleHosts) === JSON.stringify(wantHosts) && facts.ruleHostCount === wantHosts.length && facts.providers === 2 && facts.placeholders === 2 && !Object.values(values).some((v) => JSON.stringify(record).includes(v));
	console.log(`${factsOk ? "ok     " : "FAIL   "} the bind run's record carries its openshell facts: ${JSON.stringify(facts)} (hosts wanted ${JSON.stringify(wantHosts)}, 2 providers, 2 placeholders)`);
	if (!factsOk) failed = true;
}

// Review round 1 (#714): run_as_user other than the image's, exercised in CI. The job dir is handed to uid 2000 (sudo),
// the bundle runs the job as "2000:2000", and the bound file it writes lands on the host as 2000.
{
	const dirs = jobDirFor("whoami");
	const chowned = await run("sudo", ["-n", "chown", "-R", "2000:2000", dirs.jobDir]);
	if (chowned.code !== 0) {
		console.log(`FAIL   run_as_user 2000: could not hand the job dir to uid 2000 (${chowned.stderr.trim().split("\n")[0]})`);
		failed = true;
	} else {
		output.set("last", "");
		const result = await backend.runContainer({ job: JOB, prepared: dirs, name: `pi-job-bind-conformance-${nonce}-uid`, signal: new AbortController().signal, user: "2000:2000", home: "/home/pi", size: { memMiB: 1024, cpuCenti: 100 } });
		const got = said(output.get("last"));
		const owned = join(dirs.workspace, "owned.txt");
		const owner = nodeFs.existsSync(owned) ? nodeFs.statSync(owned).uid : null;
		const ok = result.code === 0 && /^2000 gid=2000$/.test(got.uid ?? "") && owner === 2000 && got.home === "writable";
		console.log(`${ok ? "ok     " : "FAIL   "} run_as_user 2000: exit ${result.code}, ${JSON.stringify(got)}, the bound file's owner ${owner}`);
		if (!ok) failed = true;
	}
}

await run("docker", ["image", "rm", "-f", probeImage]);
// Some of it is uid 2000's now.
await run("sudo", ["-n", "rm", "-rf", scratch]);
nodeFs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
