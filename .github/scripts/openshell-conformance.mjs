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
 * through the bundle, which must end on its own signed `cost-cap` line with the session brought back, and (issue #686)
 * whose session lines must reach the live transcript publisher as verified records over the exec's stderr. And (issue
 * #686, part 2) the same runner STEERED: one message through the real relay down the exec's stdin as a frame, its ack
 * back over the stderr transcript and its id on the signed exit line, still at zero spend.
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
const { makeLiveTranscriptOpener } = await load("worker/src/live-transcript.mjs");
const { makeInboxRelay } = await load("worker/src/inbox-relay.mjs");

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
		# Issue #684 part 2: the job's credentials are placeholders in the agent, no process's environment holds a value,
		# and the supervisor swaps the real one in for a request to an admitted host: a header to the stand-in, and git's
		# Basic auth through the worker-set credential helper (the stand-in records both, the script reads its log).
		echo "probe envkey=$(case "$ANTHROPIC_API_KEY" in openshell:resolve:env:*) echo placeholder ;; conformance-probe-not-a-key) echo value ;; '') echo unset ;; *) echo other ;; esac)"
		echo "probe envtoken=$(case "$GH_TOKEN" in openshell:resolve:env:*) echo placeholder ;; conformance-probe-not-a-token) echo value ;; '') echo unset ;; *) echo other ;; esac)"
		# Readable means NON-EMPTY: under OpenShell 0.1.4 the file opens and reads as nothing (measured, self and parent).
		echo "probe environ-readable=$(if [ "$(tr '\\0' '\\n' < /proc/self/environ 2>/dev/null | wc -c)" -gt 0 ]; then echo yes; else echo no; fi)"
		echo "probe environ-self=$(tr '\\0' '\\n' < /proc/self/environ | grep -c -e '^ANTHROPIC_API_KEY=openshell:resolve:env:')"
		echo "probe environ-values=$(cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c -e conformance-probe-not-a)"
		echo "probe header=$(node -e 'fetch("http://host.openshell.internal:18080/header",{headers:{"x-api-key":process.env.ANTHROPIC_API_KEY},signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log("refused",e.cause?.code??e.name))')"
		echo "probe git=$(cd /tmp && GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote http://host.openshell.internal:18080/edgehero/pi-dispatch-conformance.git >/dev/null 2>&1; echo $?)"
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
	const result = await b.runContainer({ job: JOB, token: "conformance-probe-not-a-token", prepared: jobDirFor("readback"), name, signal: new AbortController().signal, size: { memMiB: 1024, cpuCenti: 100 } });
	const said = Object.fromEntries([...String(output.get("last")).matchAll(/^probe ([A-Za-z.-]+)[=:][ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	const urls = Object.fromEntries([...String(output.get("last")).matchAll(/^probe url (\S+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	const pushes = Object.fromEntries([...String(output.get("last")).matchAll(/^probe push (\S+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
	Object.assign(readings, { urls, pushes, said });
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
// Issue #684 part 2: the credentials. Placeholders in the agent, no value in any environment it can read, and the real
// values received by the stand-in only after the supervisor's swap (a header, and git's Basic auth via the helper).
{
	const said = readings.said ?? {};
	let seen = [];
	try {
		seen = nodeFs.readFileSync(process.env.STANDIN_LOG ?? "", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {}
	const basic = `Basic ${Buffer.from("x-access-token:conformance-probe-not-a-token").toString("base64")}`;
	const swapped = seen.some((e) => e.xApiKey === "conformance-probe-not-a-key");
	// A placeholder that reached the stand-in unswapped, in a header or inside git's base64 Basic credentials.
	const decoded = (a) => (/^Basic /.test(a ?? "") ? Buffer.from(a.slice(6), "base64").toString("utf8") : (a ?? ""));
	const leaked = seen.some((e) => /openshell:resolve/.test(`${e.xApiKey ?? ""}${decoded(e.authorization)}`));
	const git = seen.some((e) => e.authorization === basic);
	// The values in no readable environment: either the process's own environ is readable and holds the placeholder (so
	// the scan of every process's is not vacuous), or it is not readable at all, which is the stronger answer.
	const environ = said["environ-values"] === "0" && (said["environ-readable"] === "no" || (said["environ-readable"] === "yes" && said["environ-self"] === "1"));
	const ok = said.envkey === "placeholder" && said.envtoken === "placeholder" && environ && swapped && !leaked && git;
	console.log(`${ok ? "ok     " : "FAIL   "} the credentials: ${JSON.stringify({ envkey: said.envkey, envtoken: said.envtoken, environReadable: said["environ-readable"], environSelf: said["environ-self"], environValues: said["environ-values"], header: said.header, git: said.git, swapped, leaked, gitBasic: git })}`);
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
	// Under the same policy as the probes: with no rule no provider is made and the key reaches the job not at all
	// (`openshell_secrets_unbound`), which is the venue working, and a runner with no key to read.
	// Issue #686: the REAL publisher (live-transcript.mjs, the opener start.mjs builds), transcripts on and progress off,
	// over a Valkey stand-in that records every XADD in memory, so what is checked is the path a job's lines take: the
	// runner's mirror, the exec's stderr, the demux's verification under this attempt's key, the stdio source.
	const xadds = [];
	const redis = {
		status: "ready",
		multi() {
			const tx = { del: () => tx, pexpire: () => tx, xadd: (_key, ...args) => (xadds.push(args), tx), exec: async () => [] };
			return tx;
		},
	};
	const openLiveTranscript = makeLiveTranscriptOpener({ redis, transcripts: true, progress: false });
	const events = [];
	const real = bundleFor(image, { ...POLICY_SOURCES, openJobLog: makeLogSink({ logsDir: logs, enabled: false }), openLiveTranscript, log: (event, fields) => events.push([event, fields]) });
	const dirs = jobDirFor("Reply with the single word ok.");
	// This run's output alone, so the record check below reads nothing an earlier probe wrote.
	output.set("last", "");
	const result = await real.runContainer({ job: { ...JOB, maxCostMicros: 0 }, prepared: dirs, name: `pi-job-conformance-${nonce}-runner`, signal: new AbortController().signal, exitAuth: true, transcriptStderr: true, jobId: `conformance-${nonce}`, size: { memMiB: 2048, cpuCenti: 200 } });
	const session = nodeFs.readFileSync(join(dirs.jobDir, "session", "current.jsonl"), "utf8");
	const ok = result.code === 2 && result.exitReason === "cost-cap" && result.exitAuth === "verified" && session.length > 0;
	console.log(`${ok ? "ok     " : "FAIL   "} the real runner: exit ${result.code}, reason ${result.exitReason}, exit line ${result.exitAuth}, session ${session.length} bytes`);
	// Every published entry's kind (the field list is flat: "kind", <kind>, "ts", ...): at least one from the session (the
	// prompt's `user` entry is the one a cost cap of 0 always leaves), the `end`, and no forged or broken record on the way.
	const kinds = xadds.map((fields) => fields[fields.indexOf("kind") + 1]);
	const fromSession = kinds.filter((k) => k !== "end" && k !== "skipped").length;
	const unverified = events.filter(([e]) => e === "transcript_record_unverified" || e === "transcript_record_dropped" || e === "transcript_demux_failed" || e === "live_transcript_skipped");
	const piped = fromSession > 0 && kinds.at(-1) === "end" && unverified.length === 0 && !/\x1epidt /.test(String(output.get("last") ?? ""));
	console.log(`${piped ? "ok     " : "FAIL   "} the live transcript over stderr: ${fromSession} entries from the session (${[...new Set(kinds)].join(", ") || "none"}), ${unverified.length} skip, unverified or dropped events, records kept out of the output`);
	if (!piped) failed = true;
	if (!ok) console.log(String(output.get("last") ?? "").split("\n").slice(-15).join("\n"));
	if (!ok) failed = true;
}

// Issue #686, part 2: the real runner STEERED over the exec's stdin. The real relay (inbox-relay.mjs) over an in-memory
// inbox holding one queued steer, the real publisher with the steer ack consumer (the opener start.mjs builds), and the
// bundle handed both, as start.mjs hands them. A fresh job's relay is released at the spawn (an empty upload has no
// prior line), so the FIRST message's frame travels right behind the key frame, before the runner has loaded pi. Still at
// a cost cap of 0: pi polls its steering queue once at the start of its loop, BEFORE the first model call the cap
// refuses, so that message is persisted (and acked) at zero spend. Asserted: the job ends on its own signed cost-cap
// line, the ack came back through the stderr transcript (the ack consumer verified one), the signed exit line's
// deliveredIds names it, the inbox calls it delivered, and the stream never broke and carried no forged frame.
// A SECOND message is queued the moment the first one's ack arrives, and the relay is ticked from that very mark (not a
// later turn of the event loop), so its frame is written mid-run, on the open pipe, before the exit line's close (M1)
// can run: the tick's whole pass is microtasks over this in-memory inbox, and the close waits for a stdout read. Asserted:
// the relay wrote two frames, and writing the second mid-run broke nothing (no stream break, no unverified frame, no
// relay fault); held 6 of 6 on Docker. Whether the runner still READS it is not asserted: at zero spend the run is over
// within milliseconds of that ack (its only model call is refused), so it ends `delivered` or `written` (the settle then
// calls it late), printed. A delivery mid-run is shown with spend by the runner's own test
// (image/runner/test/inbox.test.mjs, "the real run-job on the stdin frame channel").
{
	const logs = join(scratch, "logs-steer");
	nodeFs.mkdirSync(logs);
	const xadds = [];
	const redis = {
		status: "ready",
		multi() {
			const tx = { del: () => tx, pexpire: () => tx, xadd: (_key, ...args) => (xadds.push(args), tx), exec: async () => [] };
			return tx;
		},
	};
	const id = randomBytes(16).toString("hex");
	const second = randomBytes(16).toString("hex");
	const state = { [id]: "queued" };
	let relayRef = null;
	const entries = [{ v: 1, id, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "Before anything else, reply with the single word steered.", at: Date.now() }];
	const marks = [];
	const inbox = {
		resetClosedInbox: async () => ({ reset: false }),
		registerLive: async () => ({ ok: true }),
		refreshLive: async () => ({ ok: true }),
		holdLive: async () => ({ held: true }),
		readInbox: async () => ({ entries: entries.map((e) => ({ ...e })), state: { ...state }, closed: false }),
		markState: async ({ id: mid, from, to }) => {
			marks.push([from.join("|"), to]);
			if (!from.includes(state[mid])) return { ok: false, prior: state[mid] };
			const prior = state[mid];
			state[mid] = to;
			// The first ack: queue the second message and have the relay write it now, mid-run.
			if (mid === id && to === "delivered" && !(second in state)) {
				entries.push({ v: 1, id: second, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "And a second thing, sent while you run.", at: Date.now() });
				state[second] = "queued";
				void relayRef?.tick();
			}
			return { ok: true, prior };
		},
	};
	const events = [];
	const log = (event, fields) => events.push([event, fields]);
	const opener = makeLiveTranscriptOpener({ redis, transcripts: true, progress: false, steer: true });
	const handles = [];
	const openLiveTranscript = (args) => {
		const h = opener(args);
		if (h) handles.push(h);
		return h;
	};
	const openInboxRelay = (args) => (relayRef = makeInboxRelay({ redis: {}, host: "conformance", log, pollMs: 500, inbox, ...args }));
	const real = bundleFor(image, { ...POLICY_SOURCES, openJobLog: makeLogSink({ logsDir: logs, enabled: false }), openLiveTranscript, openInboxRelay, log });
	const dirs = jobDirFor("Reply with the single word ok.");
	output.set("last", "");
	const result = await real.runContainer({ job: { ...JOB, maxCostMicros: 0, steer: true }, prepared: dirs, name: `pi-job-conformance-${nonce}-steer`, signal: new AbortController().signal, exitAuth: true, transcriptStderr: true, steerStdin: true, jobId: `conformance-steer-${nonce}`, size: { memMiB: 2048, cpuCenti: 200 } });
	const said = String(output.get("last") ?? "");
	const ackVerified = handles[0]?.stats?.().steer?.verified ?? 0;
	const exitLine = said.split("\n").filter((l) => l.startsWith('{"event":"exit"')).at(-1) ?? "";
	const named = exitLine.includes(`"deliveredIds":["${id}"`);
	const broken = /"event":"steer_(stream_broken|frame_unverified|stdin_shared)"/.test(said) || events.some(([e]) => e === "steer_relay_fault" || e === "steer_skipped" || e === "steer_frame_refused" || e === "steer_acks_unread");
	const secondOutcome = state[second] ?? "never queued";
	const written = relayRef?.counts().written ?? 0;
	const secondHonest = (secondOutcome === "delivered" || secondOutcome === "written") && written >= 2;
	const ok = result.code === 2 && result.exitReason === "cost-cap" && result.exitAuth === "verified" && (result.steer?.delivered ?? 0) >= 1 && ackVerified >= 1 && named && state[id] === "delivered" && !broken && second in state && secondHonest;
	console.log(`${ok ? "ok     " : "FAIL   "} steering over the exec's stdin: exit ${result.code} ${result.exitReason} (${result.exitAuth}), runner delivered ${result.steer?.delivered ?? "none"}, acks verified over stderr ${ackVerified}, exit line names the first ${named}, inbox says ${state[id]}; the mid-run second: ${secondOutcome} (${written} frames written, 2 wanted); marks ${JSON.stringify(marks)}, broken or refused ${broken}`);
	if (!ok) {
		console.log(said.split("\n").slice(-20).join("\n"));
		console.log(JSON.stringify(events.filter(([e]) => /steer|transcript/.test(e))));
		failed = true;
	}
}

await run(engine, ["image", "rm", "-f", probeImage]);
nodeFs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
