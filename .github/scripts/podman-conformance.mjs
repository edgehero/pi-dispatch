#!/usr/bin/env node
/**
 * Issue #354: run the backend conformance harness against the REAL `podman` bundle, on a host with rootless Podman.
 *
 * `runBackendConformance` is written for an adapter author to run against their own backend, with probes only their
 * runtime can supply (`worker/src/backend-conformance.mjs`, `docs/backends.md`). This is those probes for the `podman`
 * venue, and every one of them goes through the bundle `makePodmanBackend` builds, so what is checked is what a job
 * gets rather than a copy of it:
 *
 *   - `probe`: the bundle's own `runContainer`, with the job user its own `jobUserPreflight` decides, on an image built
 *     FROM the job image whose entrypoint exits with the integer in `/job/prompt.md` (or sleeps, for the abort, which
 *     is then stopped through the bundle's own `stopContainer`). Nothing is fabricated: the integer the harness sees is
 *     the one `podman run` exited with.
 *   - `withBrokenEnumeration`: the same reaper factory with a binary that does not exist, so the enumeration really
 *     fails rather than being told to.
 *   - `readBack`: `runLiveProbes` with the podman runner, the podman argv builder and `serviceIsRemote === false` as
 *     its gate, exactly as `pi-dispatch doctor --live` runs it on this venue, with doctor's own egress canary
 *     (`runEgressCanary`, issue #431) under the same Podman, as `--live` runs it there.
 *   - after the harness, doctor's own stale canary sweep (`sweepStaleCanaryNetworks`, issue #452) over two leftovers
 *     this script makes as a killed `doctor --live` leaves them, which the harness has no probe for.
 *
 * AND TWO CASES OF ITS OWN, run before the harness. Issue #458: two egress-armed jobs in sequence through the same
 * bundle built with egress on, so each one's network is made and torn down by the worker's own `createJobNetwork` and
 * `removeJobNetwork`, and after EACH teardown doctor's canary reads the proxy's route to the provider again. On Podman
 * 4.9 the teardown's `network disconnect` of the proxy kills this account's rootless network helper whenever no other
 * bridge container runs, and the proxy has no route out from then on; the one read this script took before, on a
 * fresh proxy ahead of any teardown, could not see that. The rootless network keeper
 * (deploy/pi-dispatch-netns-keeper.container) is what keeps it green, so the workflow starts it beside the proxy.
 * Issue #450: with the proxy and the keeper running on bridge networks this account's rootless network helper MUST
 * exist, so the worker's own check is asked to find it from Podman's record, and to find it narrow. The worker reads no
 * helper as no live network, so a Podman release that moved its record (the 5.x pid file under runRoot, or the 4.x
 * slirp4netns argv) would make that check blind with every unit test still green; this is the one place a real Podman
 * says so.
 *
 * Run it AS THE WORKER'S ACCOUNT, with the job image in that account's own store, and with the worker STOPPED: the
 * harness calls the bundle's real `reap`, which removes every `pi-job-` container in this account's store, so this
 * refuses to start while any exists. PI_EGRESS is read as the worker reads it (on unless `0`), and with it on the
 * proxy (`PI_EGRESS_PROXY`, default `pi-dispatch-egress-proxy`) must be running under this account's Podman on a
 * named bridge network; `docs/podman.md` has the command.
 *
 *   PI_JOB_IMAGE=localhost/pi-job:latest node <repo>/.github/scripts/podman-conformance.mjs
 *
 * STRICTER THAN THE HARNESS, on purpose. The harness abstains on a property nobody read, which is right for an adapter
 * author's first run and wrong for the run a claim in the docs rests on: here any abstention among the eight
 * read-back properties FAILS, as does a job user that did not run as this account's own uid. It also refuses to run as
 * uid 1001, the image's own uid, where the files would be readable without keep-id and the run would prove less than
 * it says. Exit 0 when everything held, 1 when anything failed or was not read, 2 when the host is not one this can
 * run on.
 *
 * WHAT A PASS DOES NOT COVER. The exit-code probes run first, on an image built FROM the job image, so they pay the
 * first keep-id copy of the shared layers and the read-back always starts warm: its `PODMAN_FIRST_START_TIMEOUT_MS`
 * bound is never reached cold here. That bound was measured cold through `pi-dispatch doctor --live` instead (32.5 s
 * on a freshly squashed image, against 4.2 s warm). The egress canary is doctor's (issue #431): it takes the runner's own
 * route to the network (pi loaded, then the runner's proxy restore, #427) rather than a plain `fetch`, so it proves the
 * route the runner's provider call takes, not only the network and the allowlist; what it still does not prove is that
 * the runner's entrypoint calls that route early enough, which the image contract job runs the real entrypoint for.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { PODMAN_BACKEND } = await load("worker/src/backends.mjs");
const { PODMAN_FIRST_START_TIMEOUT_MS, decidePodmanJobUser, makePodmanBackend, makePodmanInfoReader, observeRootlessNetns, podmanJobUserRefusal } = await load("worker/src/backend-podman.mjs");
const { makeReaper } = await load("worker/src/backend-local.mjs");
const { READ_BACK_BY_A_LIVE_PROBE, UNVERIFIED_BY_THIS_HARNESS, runBackendConformance } = await load("worker/src/backend-conformance.mjs");
const { SHIPPED_IMAGE_UID } = await load("worker/src/container-spec.mjs");
const { CANARY_PROBE_SLUGS, liveRunVia, runEgressCanary, sweepStaleCanaryNetworks } = await load("worker/src/doctor.mjs");
const { buildPodmanRunArgs } = await load("worker/src/docker-run.mjs");
const { egressArmed, egressCanaryNetwork, egressCanaryProbe, egressProxyName, networkNameFor, removeNetworkOrSay } = await load("worker/src/egress.mjs");
const { makeDetachGate } = await load("worker/src/netns-keeper.mjs");
const { NETNS_KEEPER, NETNS_KEEPER_FORMAT, judgeNetnsKeeper } = await load("worker/src/podman-stack.mjs");
const { runLiveProbes } = await load("worker/src/live-probes.mjs");
const { cgroupParentFor, makeCpuReserve, readQuota, reservePlan, writeQuota } = await load("worker/src/cpu-reserve.mjs");
const { computeHostBudget, hostBudgetSettings, readUserServiceLimits } = await load("worker/src/host-budget.mjs");
const { jobSizeDefaults } = await load("worker/src/job-size.mjs");

const refuse = (why) => {
	console.error(`podman-conformance: ${why}`);
	process.exit(2);
};

if (process.platform !== "linux") refuse("the podman venue runs only on Linux");
const image = process.env.PI_JOB_IMAGE;
if (!image) refuse("set PI_JOB_IMAGE to the job image as this account's `podman images` names it");
const euid = process.geteuid();
const egid = process.getegid();
if (euid === 0) refuse("run as the worker's unprivileged account, not root");
if (euid === SHIPPED_IMAGE_UID) refuse(`uid ${SHIPPED_IMAGE_UID} is the image's own uid, so a job's files would be readable without keep-id; run as an account with another uid`);

const nonce = randomBytes(6).toString("hex");
const probeImage = `localhost/pi-dispatch-conformance-probe:${nonce}`;
const scratch = nodeFs.mkdtempSync(join(tmpdir(), "pi-dispatch-conformance-"));
const STEP_MS = 120_000;

/** Run the podman CLI without a shell. Never throws: `code` is null when it could not start or ran out of time. */
const podman = (args, { timeoutMs = STEP_MS } = {}) => liveRunVia(spawn, { bin: "podman" })(args, { timeoutMs });
const firstLine = (text) => String(text ?? "").trim().split("\n")[0] ?? "";

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

let armed;
try {
	armed = egressArmed(process.env);
} catch (err) {
	refuse(`PI_EGRESS: ${err.message}`);
}
const proxy = egressProxyName(process.env);

// --- the host: the same read and decision the worker makes, refused by the worker's own words ---
const readInfo = makePodmanInfoReader();
const read = await readInfo();
const decision = decidePodmanJobUser({ euid, egid, read });
if (decision.mode !== "worker") refuse(decision.mode === "unmappable" ? podmanJobUserRefusal(decision) : `podman info did not answer (${decision.reason})`);
const leftovers = await podman(["ps", "-a", "--filter", "name=^pi-job-", "--format", "{{.Names}}"]);
if (leftovers.code !== 0) refuse(`podman ps did not answer: ${firstLine(leftovers.stderr)}`);
if (leftovers.stdout.trim() !== "") refuse(`pi-job- containers exist in this account's store (${leftovers.stdout.trim().split("\n").join(", ")}); stop the worker first, since the harness runs the real reaper`);
if ((await podman(["image", "exists", image])).code !== 0) refuse(`${image} is not in this account's Podman store`);

// --- the probe image: the job image with an entrypoint that exits with the integer the job directory holds ---
// Built FROM the job image, so the labels (`anyUid`), the user and the runner's filesystem are the job image's own; only
// the entrypoint differs. `--init` is in the job argv, so catatonit is PID 1 and forwards the stop to `sleep`.
const context = join(scratch, "probe-image");
nodeFs.mkdirSync(context);
nodeFs.writeFileSync(
	join(context, "Containerfile"),
	`FROM ${image}\nENTRYPOINT ["sh", "-c", "c=$(cat /job/prompt.md); if [ \\"$c\\" = sleep ]; then exec sleep 600; fi; exit \\"$c\\""]\n`,
);
const built = await podman(["build", "--pull=never", "--quiet", "-t", probeImage, "-f", join(context, "Containerfile"), context], { timeoutMs: 600_000 });
if (built.code !== 0) refuse(`the probe image did not build: ${firstLine(built.stderr)}`);

// Quiet: the containers' own output is not what is being checked, and the integer arrives through the exit.
const backend = makePodmanBackend({
	image: probeImage,
	// A placeholder credential: `buildContainerEnv` refuses a job with none, and the probe entrypoint never reads it.
	hostEnv: { ...process.env, ANTHROPIC_API_KEY: "conformance-probe-not-a-key" },
	egress: false,
	readInfo,
	onOutput: () => {},
	euid,
	egid,
	// An isolation floor (issue #453, gate round 1), so the bounds observation must HOLD for the probe to be admitted:
	// without it `observationPreflight` admitted every probe whatever `podmanBoundsDelegated` said, and an observation
	// reading the wrong path would have stayed green here. The runner's pdjob has linger, a user bus and the drop-in.
	backendFloor: { isolation: "enforced" },
});

// Issue #458: the same bundle with egress ON, for `egressAcrossTeardowns`: its runContainer makes each job's
// `--internal` network, attaches the proxy, and in its `finally` detaches the proxy and removes the network, which is
// the step Podman 4.9 turns into a dead route out. The harness's own probes keep `egress: false` above, unchanged.
const egressBackend = armed === true ? makePodmanBackend({ image: probeImage, hostEnv: { ...process.env, ANTHROPIC_API_KEY: "conformance-probe-not-a-key" }, egress: true, egressProxy: proxy, readInfo, onOutput: () => {}, euid, egid }) : null;

let probes = 0;
// The container name of the last probe, so a caller can find the network the worker made for it (`networkNameFor`).
let lastProbeName = null;
/** Wait until `podman ps` lists `name` running, or give up after `ms`. */
async function awaitRunning(name, ms = 60_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const state = await podman(["ps", "--filter", `name=^${name}$`, "--format", "{{.State}}"]);
		if (state.code === 0 && state.stdout.trim() === "running") return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

// Set when the venue refuses the probe outright, so the summary says that ONE thing and stops: every later check would
// report a consequence of it (an unread uid, probes that never ran) as if it were a finding of its own.
let venueRefused = null;
let venueTransient = false;

/** The harness's `probe`: one real job container through the bundle, exiting `exitCode` or stopped by the worker. */
async function probe(bundle, { exitCode, aborted = false }) {
	probes += 1;
	const jobId = `conformance-${nonce}-${probes}`;
	const jobDir = nodeFs.mkdtempSync(join(scratch, "job-"));
	nodeFs.chmodSync(jobDir, 0o700);
	const workspace = nodeFs.mkdtempSync(join(scratch, "workspace-"));
	nodeFs.writeFileSync(join(jobDir, "prompt.md"), aborted ? "sleep" : String(exitCode));
	const job = { id: jobId, kind: "local", provider: "anthropic", model: "conformance", maxTurns: 1 };
	// The job user the bundle itself decides, through the same two preflights the processor calls, in its order.
	const observed = await bundle.observationPreflight(job);
	if (!observed?.ok) throw new Error(`observationPreflight did not admit the probe: ${JSON.stringify(observed)}`);
	// `ok: true` is not admission on its own: a refused identity and a widening containers.conf (issue #428) ride beside
	// it, and the processor refuses on either before the image preflight. A probe past them would read back a container
	// no real job gets.
	if (observed.jobUserRefused || observed.podmanConfRefused) {
		venueTransient = observed.podmanConfRefused?.transient === true && !observed.jobUserRefused;
		venueRefused = `observationPreflight ${venueTransient ? "could not decide" : "refused"} the probe: ${JSON.stringify({ jobUserRefused: observed.jobUserRefused, podmanConfRefused: observed.podmanConfRefused })}`;
		throw new Error(venueRefused);
	}
	const img = await bundle.imagePreflight(job);
	if (!img?.ok) throw new Error(`imagePreflight did not admit the probe image: ${JSON.stringify(img)}`);
	const who = await bundle.jobUserPreflight(job, { capabilities: img.capabilities ?? [], observed });
	if (!who?.user) throw new Error(`jobUserPreflight gave no job user: ${JSON.stringify(who)}`);
	const name = bundle.containerName(jobId);
	lastProbeName = name;
	const controller = new AbortController();
	const running = bundle.runContainer({ job, token: null, prepared: { jobDir, workspace }, secrets: {}, name, signal: controller.signal, user: who.user, home: who.home, relabel: who.relabel });
	try {
		if (!aborted) return await running;
		if (!(await awaitRunning(name))) throw new Error(`${name} never reported running`);
		// The worker's own order: the abort signal first, then the stop, whose effect arrives through the exit.
		controller.abort();
		await bundle.stopContainer(name, job);
		return await running;
	} finally {
		nodeFs.rmSync(jobDir, { recursive: true, force: true });
		nodeFs.rmSync(workspace, { recursive: true, force: true });
	}
}

// The reaper's failure path, REAL rather than simulated: the same factory the bundle's reaper comes from, pointed at a
// binary that is not there, so the enumeration fails the way a missing CLI makes it fail.
const withBrokenEnumeration = () => makeReaper({ log: () => {}, bin: `pi-dispatch-conformance-no-such-podman-${nonce}` })();

/**
 * The egress readings `egressVerdict` takes, from doctor's own canary (`runEgressCanary`, issue #431) under this
 * account's Podman: a job-shaped `--internal` network with the proxy attached, and three probe containers built by the
 * podman builder as a job's are, as the job user: two running the runner's route to the network, and one sending plain
 * HTTP to a listed host off port 80, which the proxy must refuse (issue #508). This script carried a copy
 * of its own until then, with a plain `fetch`, which proved the network and the allowlist and not the runner's route;
 * the one canary now serves `doctor --live` and this run alike. Every line it prints that is not a pass is repeated
 * here, since the harness only sees the readings.
 */
async function egressCanary() {
	if (armed !== true) return { results: [], proxyRunning: null };
	// `.State.Status` "running", as the worker's egress preflight reads it (issue #453).
	const state = await podman(["inspect", "--format={{.State.Status}}", proxy]);
	const proxyRunning = state.code === 0 && state.stdout.trim() === "running";
	if (!proxyRunning) return { results: [], proxyRunning };
	const canary = await runEgressCanary({ run: liveRunVia(spawn, { bin: "podman" }), bin: "podman", proxy, image, pid: process.pid, user: decision.user, hostCpus: read.info?.hostCpus ?? null });
	for (const check of canary.checks) if (!check.ok) console.error(`podman-conformance: ${check.label}`);
	return { results: canary.results, proxyRunning };
}

/**
 * Issue #458: two egress-armed jobs in sequence, each followed by a fresh read of the proxy's route to the provider
 * (doctor's canary, which proves the route a job's provider call takes). Returns `{ ran, ok, detail }`. Every reading
 * is taken AFTER a job's network was torn down by the worker's own code, which is the one order that shows the Podman
 * 4.9 defect: measured without the keeper, job 1's teardown left the proxy with no route out and every later egress
 * job got 503. The keeper's state is read and named, so a red run says which of the two it was.
 */
const TEARDOWN_RUNS = 2;
async function egressAcrossTeardowns() {
	if (armed !== true) return { ran: false, ok: true, detail: "PI_EGRESS is off, so no job network is torn down under a proxy" };
	const state = judgeNetnsKeeper(await podman(["inspect", NETNS_KEEPER_FORMAT, NETNS_KEEPER]));
	const keeper = `the rootless network keeper ${NETNS_KEEPER} ${state.holds ? "is running on its own bridge network" : state.problem}`;
	// `.State.Status` "running", as the worker's egress preflight reads it (issue #453).
	const running = await podman(["inspect", "--format={{.State.Status}}", proxy]);
	if (running.code !== 0 || running.stdout.trim() !== "running") return { ran: false, ok: false, detail: `${proxy} is not running under this account's Podman, so nothing could be read (${keeper})` };
	const steps = [];
	for (let i = 1; i <= TEARDOWN_RUNS; i++) {
		const result = await probe(egressBackend, { exitCode: 0 });
		const network = networkNameFor(lastProbeName);
		if (result?.code !== 0) return { ran: true, ok: false, detail: `egress job ${i} exited ${result?.code} instead of 0, after: ${steps.join("; ") || "nothing"} (${keeper})` };
		// The teardown ran: the worker's `finally` removed the network, so the reading below is one taken after it.
		if ((await podman(["network", "exists", network])).code === 0) return { ran: true, ok: false, detail: `egress job ${i}'s network ${network} is still there, so its teardown did not run (${keeper})` };
		const canary = await runEgressCanary({ run: liveRunVia(spawn, { bin: "podman" }), bin: "podman", proxy, image, pid: process.pid, user: decision.user, hostCpus: read.info?.hostCpus ?? null });
		for (const check of canary.checks) if (!check.ok) console.error(`podman-conformance: after egress job ${i}'s teardown: ${check.label}`);
		const reached = canary.results.find((r) => r.want === true)?.reached ?? null;
		steps.push(`job ${i} exited 0 and its network was removed, then the provider was ${reached === true ? "reached" : reached === false ? "NOT reached" : "not read"} through ${proxy}`);
		if (reached !== true) return { ran: true, ok: false, detail: `${steps.join("; ")}. On Podman 4.x a job network's teardown cuts the proxy's route out unless another bridge container runs (issue #458), and ${keeper}` };
	}
	return { ran: true, ok: true, detail: `${steps.join("; ")} (${keeper})` };
}

/** Issue #450: the worker's rootless network scan, against this account's real helper while the proxy runs. */
async function liveNetnsSeen() {
	if (armed !== true) return { ran: false, ok: true, detail: "PI_EGRESS is off, so no bridge container is sure to be running" };
	const running = await podman(["inspect", "--format={{.State.Status}}", proxy]);
	if (running.code !== 0 || running.stdout.trim() !== "running") return { ran: false, ok: false, detail: `${proxy} is not running under this account's Podman, so no rootless network is sure to exist` };
	const seen = observeRootlessNetns({ fs: nodeFs, euid, runRoot: read.info.runRoot });
	if (seen.unread) return { ran: true, ok: false, detail: `${seen.unread.path} could not be read (${seen.unread.code})` };
	if (seen.helpers.length === 0) return { ran: true, ok: false, detail: `no rootless network helper of this account was found in /proc while ${proxy} runs on a bridge network, so the worker's live network check would read every widened network as narrow` };
	const wide = seen.helpers.filter((h) => h.widened.length > 0);
	if (wide.length > 0) return { ran: true, ok: false, detail: wide.map((h) => `${h.kind} (pid ${h.pid}) ${h.widened.join(", and ")}`).join("; ") };
	return { ran: true, ok: true, detail: `found ${seen.helpers.map((h) => `${h.kind} (pid ${h.pid})`).join(", ")}, running with none of the options that widen a job` };
}

/**
 * Issue #596, phase 2: the aggregate CPU reserve, by the worker's OWN code. The budget is computed as the worker computes
 * it from this `podman info` and this account's user service (the env's settings, `auto` by default), the venue's plan
 * says how its quota is kept, and the worker's reserve keeps it: on rootless Podman `systemctl --user set-property
 * pidispatch.slice CPUQuota=<budget*100>%` through this account's user manager, then read back. The read-back below then
 * finds the probe container under that parent with that quota. A quota this account had before is put back afterwards
 * (none is cleared), so a run on a real worker account leaves its user manager as it found it.
 */
const systemctl = (args, { timeoutMs }) => liveRunVia(spawn, { bin: "systemctl" })(args, { timeoutMs });
const runFor = (bin, args, opts) => (bin === "systemctl" ? systemctl(args, opts) : liveRunVia(spawn, { bin })(args, opts));
const jobDefault = (() => {
	const d = jobSizeDefaults(process.env);
	return { memMiB: d.memMiB, cpuCenti: d.cpuCenti };
})();
const budget = computeHostBudget(hostBudgetSettings(process.env, jobDefault), { memTotalMiB: read.info?.memTotalMiB ?? null, hostCpus: read.info?.hostCpus ?? null, ...readUserServiceLimits({ uid: euid, readFile: (path) => nodeFs.readFileSync(path, "utf8") }) }, jobDefault);
const reservePlanHere = reservePlan({ venue: PODMAN_BACKEND, facts: read.info, endpointLocal: read.info?.serviceIsRemote === false, platform: process.platform });
const quotaBefore = reservePlanHere.method ? await readQuota(reservePlanHere, { run: runFor, image }) : { ok: false, reason: reservePlanHere.why ?? "no-method" };
let reserveState = null;
async function applyReserve() {
	const reserve = makeCpuReserve({ run: runFor, image, log: (event, fields) => console.log(`cpu reserve: ${event} ${JSON.stringify(fields)}`) });
	await reserve.sync({ cpuCenti: budget.cpuCenti, plans: [reservePlanHere] });
	reserveState = reserve.states()[0] ?? null;
}
let parentRead = null;

let ranAs = null;
/** The harness's `readBack`: the live probes, run as `doctor --live` runs them on this venue, with the verdict ARRAY. */
async function readBack() {
	const canary = await egressCanary();
	const jobsDir = nodeFs.mkdtempSync(join(scratch, "jobs-"));
	const result = await runLiveProbes({
		image,
		endpoint: read.info,
		resolveEndpoint: async () => {
			const again = await makePodmanInfoReader()();
			return again?.answered ? again.info : null;
		},
		isLocal: (info) => info?.serviceIsRemote === false,
		dockerReachable: true,
		imagePresent: true,
		jobsDir,
		home: homedir(),
		sessionsDir: null,
		egress: { armed, results: canary.results, proxy, proxyRunning: canary.proxyRunning },
		pid: process.pid,
		nonce,
		run: liveRunVia(spawn, { bin: "podman" }),
		// The first keep-id run of an image copies its layers (27 s measured), longer than the 20 s step bound.
		startTimeoutMs: PODMAN_FIRST_START_TIMEOUT_MS,
		buildArgs: buildPodmanRunArgs,
		bin: "podman",
		fs: nodeFs,
		isAlive,
		announce: (line) => console.log(`read back on podman: ${line}`),
		user: decision.user,
		relabel: decision.relabel === true,
		euid,
		// Issue #596: the `--cpus` ceiling a job on this venue gets, from the same `podman info`, so the read-back proves
		// `cpu.max` as well as the swap bound and the weight. The size is the built-in default, as doctor's with no setting.
		hostCpus: read.info?.hostCpus ?? null,
		// Issue #596, phase 2: the parent a job on this venue runs under, and the budget its quota must read back as.
		cgroupParent: cgroupParentFor({ podman: true, cgroupManager: read.info?.cgroupManager ?? null }),
		cpuBudgetCenti: budget.cpuCenti,
	});
	for (const note of result.notes ?? []) console.error(`podman-conformance: ${note}`);
	if (!result.ran) throw new Error(`the live probes did not run: ${result.reason}`);
	ranAs = result.ranAs;
	parentRead = result.cgroupParent ?? null;
	return result.verdicts;
}

/**
 * Issue #452: the stale canary sweep, REAL, over a leftover it did not make. Podman 4.9 renders no `.Containers`, so the
 * member read that sweep depended on failed for every network there and a leftover was reported "could not be read" on
 * every `doctor --live` and never removed, while this job stayed green because nothing here ever left one behind. So
 * this leaves two, as a `doctor --live` killed mid-canary does: an EMPTY one, and one built as `runEgressCanary` builds
 * it (`network create --internal`, the proxy connected by name) with one probe RUNNING and one STOPPED under the probes'
 * own names. Then it runs doctor's own sweep and reads back what the sweep promises: the networks and the probes gone,
 * the proxy still running, still on its upstream network, and still reaching out.
 *
 * LAST, after the harness, and with NOTHING holding the rootless network up but what the deployment itself runs. On
 * Podman 4.9.3, disconnecting the proxy from a network while no other container runs on a bridge network tears the
 * account's rootless network namespace down under the running proxy (round 446, M0-c), and the canary's teardowns, the
 * peers' and this sweep's all disconnect it. The rootless network keeper (issue #458, started by the workflow before the
 * proxy) is what holds it now, so this case adds no container of its own for that and restarts nothing: a proxy that
 * has lost its route out, or answers `inspect` with an error, BEFORE the sweep is a FAILURE, because by then the harness
 * has torn down job, canary and peer networks under it, and so is one after it. Either is a #458 regression, and it
 * turns this required check red. It was measured both ways on Podman 4.9.3: passing with the keeper running, failing
 * with it stopped. What the sweep itself owns is asserted beside it: it never `rm -f`s, detaches the proxy from its
 * upstream network or removes it. Every failure names the keeper's state.
 */
async function staleCanarySweep() {
	// ONE array, returned by reference, so the observations the `finally` below adds reach the summary on every path.
	const lines = [];
	const fail = (why) => ({ ok: false, why, lines });
	if (armed !== true) return { ok: true, notRead: "PI_EGRESS is off, so there is no proxy to leave a canary network holding" };
	// From `ps`, not `inspect`: on Podman 4.9.3 the harness's own canary and peer teardowns can leave the proxy running
	// with an `inspect` that exits 125 ("network inspection mismatch ... internal libpod error"), measured in this very
	// job's position (round 446), and a case that read that as "not running" would say nothing about the sweep.
	const proxyRow = async () => {
		const row = await podman(["ps", "-a", "--filter", `name=^${proxy}$`, "--format", "{{.State}}\t{{.Networks}}"]);
		const [state = "", networks = ""] = row.code === 0 ? row.stdout.trim().split("\t") : [];
		return { state: state.trim(), networks: networks.split(",").map((n) => n.trim()).filter(Boolean) };
	};
	const inspectable = async () => {
		const answer = await podman(["inspect", "--format={{.State.Running}}", proxy]);
		return answer.code === 0 ? null : `exit ${answer.code}: ${firstLine(answer.stderr)}`;
	};
	// The proxy's own route out, to an ADDRESS: a name would also test the proxy's resolver, which is not this case's.
	const reachesOut = async () => (await podman(["exec", proxy, "bash", "-c", "exec 3<>/dev/tcp/1.1.1.1/443"], { timeoutMs: 20_000 })).code === 0;
	// Named in every failure, so a red run says whether the keeper was there at all.
	const keeperSays = async () => {
		const state = judgeNetnsKeeper(await podman(["inspect", NETNS_KEEPER_FORMAT, NETNS_KEEPER]));
		return `the rootless network keeper ${NETNS_KEEPER} ${state.holds ? "is running on its own bridge network" : state.problem}`;
	};
	if ((await proxyRow()).state !== "running") return fail(`${proxy} is not running under this account's Podman (${await keeperSays()})`);
	const broken = await inspectable();
	if (broken) return fail(`BEFORE the sweep, after the harness's job, canary and peer teardowns, ${proxy} answers inspect with ${broken} (${await keeperSays()}; issue #458)`);
	if (!(await reachesOut())) return fail(`BEFORE the sweep, after the harness's job, canary and peer teardowns, ${proxy} has NO route out (${await keeperSays()}; issue #458)`);
	const upstream = (await proxyRow()).networks.filter((n) => !n.startsWith("pi-dispatch-egress-doctor-"));
	if (upstream.length === 0) return fail(`${proxy} is on no network this case can hold open`);

	// Two pids no process has, so the sweep's `isAlive` reads both networks as left by a run that is over.
	const dead = [];
	for (let pid = 999_999; dead.length < 2 && pid > 900_000; pid -= 1) {
		if (pid === process.pid || isAlive(pid)) continue;
		if ((await podman(["network", "exists", egressCanaryNetwork(pid)])).code === 1) dead.push(pid);
	}
	if (dead.length < 2) return fail("no two free dead pids for the leftover networks");
	const [emptyPid, fullPid] = dead;
	const emptyNet = egressCanaryNetwork(emptyPid);
	const fullNet = egressCanaryNetwork(fullPid);
	// The first two slugs only: two leftover shapes (one running, one stopped) are what the sweep is tested on, and the
	// third slug (issue #508) is matched by the same pattern, so a third leftover would add nothing.
	const [runningProbe, stoppedProbe] = CANARY_PROBE_SLUGS.map((slug) => egressCanaryProbe(slug, fullPid));
	const exists = async (kind, name) => (await podman([kind, "exists", name])).code === 0;
	try {
		// The leftovers, built as the canary builds its network and names its probes.
		if ((await podman(["network", "create", "--internal", emptyNet])).code !== 0) return fail(`could not create ${emptyNet}`);
		if ((await podman(["network", "create", "--internal", fullNet])).code !== 0) return fail(`could not create ${fullNet}`);
		if ((await podman(["network", "connect", fullNet, proxy])).code !== 0) return fail(`could not attach ${proxy} to ${fullNet}`);
		const sleeper = (name, network, detach) => ["run", ...(detach ? ["-d"] : []), "--name", name, "--pull=never", `--network=${network}`, "--entrypoint", "sh", image, "-c", detach ? "exec sleep 600" : "exit 0"];
		if ((await podman(sleeper(runningProbe, fullNet, true))).code !== 0 || !(await awaitRunning(runningProbe))) return fail(`could not start ${runningProbe}`);
		// Exited and not `--rm`: the stopped member Podman's `network rm` refuses on (measured on 4.9.3 and 5.8.1).
		if ((await podman(sleeper(stoppedProbe, fullNet, false))).code !== 0) return fail(`could not leave ${stoppedProbe} stopped`);

		const checks = await sweepStaleCanaryNetworks({ run: (args) => podman(args, { timeoutMs: 30_000 }), pid: process.pid, isAlive, endpoint: { local: true }, bin: "podman" });
		for (const check of checks) lines.push(`sweep said: ${check.label}`);
		const said = (net) => checks.find((c) => c.canary?.params?.name === net);
		const problems = [];
		for (const net of [emptyNet, fullNet]) {
			if (said(net)?.canary?.shape !== "removed") problems.push(`the sweep did not say it removed ${net}`);
			if (await exists("network", net)) problems.push(`${net} is still there`);
		}
		for (const probeName of [runningProbe, stoppedProbe]) if (await exists("container", probeName)) problems.push(`${probeName} is still there`);
		const after = await proxyRow();
		if (after.state !== "running") problems.push(`${proxy} is no longer running (${after.state || "not listed"})`);
		if (!upstream.every((n) => after.networks.includes(n))) problems.push(`${proxy} lost its upstream network (${upstream.join(", ")} before, ${after.networks.join(", ") || "none"} after)`);
		if (!(await reachesOut())) problems.push(`${proxy} no longer reaches out`);
		const inspectAfter = await inspectable();
		if (inspectAfter) problems.push(`${proxy} answers inspect with ${inspectAfter}`);
		return problems.length > 0 ? fail(`${problems.join("; ")} (${await keeperSays()})`) : { ok: true, lines };
	} finally {
		// Whatever a failed pass left, removed WITHOUT `-f` on a network: `network rm -f` deletes the containers on it,
		// the proxy included (measured on 4.9.3).
		// Through the ONE detach helper and its gate (issue #452), as every detach in worker/src is: without a holding keeper
		// on 4.x this leaves the network and says so, rather than cut the proxy's route out for the steps after it.
		for (const name of [runningProbe, stoppedProbe]) await podman(["rm", "-f", "--time=0", name]);
		// The gate's own read asks for its bound (15 s), which this runner passes through; every other step keeps 30 s.
		const cleanupRun = (args, opts) => podman(args, { timeoutMs: opts?.timeoutMs ?? 30_000 });
		const cleanupGate = makeDetachGate(cleanupRun, { bin: "podman" });
		for (const net of [emptyNet, fullNet]) {
			if (!(await exists("network", net))) continue;
			const outcome = await removeNetworkOrSay(cleanupRun, { network: net, detach: [proxy], bin: "podman", gate: cleanupGate });
			if (outcome.blocked) lines.push(`kept ${net} with ${proxy} on it (${outcome.blocked}): detaching it now could cut the proxy's route out`);
			else if (!outcome.removed) lines.push(`could not remove ${net}: ${outcome.command}`);
		}
	}
}

let report;
let teardowns;
let sweepCase;
let netns;
try {
	// Before the harness, so its own egress read-back is also one taken after job teardowns rather than on a fresh proxy.
	try {
		teardowns = await egressAcrossTeardowns();
	} catch (err) {
		teardowns = { ran: false, ok: false, detail: `did not finish: ${err?.message ?? err}` };
	}
	try {
		netns = await liveNetnsSeen();
	} catch (err) {
		netns = { ran: false, ok: false, detail: `did not finish: ${err?.message ?? err}` };
	}
	await applyReserve();
	report = await runBackendConformance(backend, { probe, withBrokenEnumeration, readBack });
	// LAST, see `staleCanarySweep`.
	sweepCase = venueRefused ? null : await staleCanarySweep();
} finally {
	// The account's quota as it was: cleared where there was none, left where the worker's own value was already set.
	if (reserveState && quotaBefore.ok && quotaBefore.cpuCenti !== (reserveState.wantCenti ?? null)) await writeQuota(reservePlanHere, quotaBefore.cpuCenti, { run: runFor, image });
	await podman(["rmi", "-f", probeImage]);
	nodeFs.rmSync(scratch, { recursive: true, force: true });
}

// --- the summary: every finding, then what this run adds to the harness's own verdict ---
if (venueRefused) {
	// A transient conf read is a retry the worker would make, not a refusal of every job, so it is worded as what it is.
	const lead = venueTransient ? "the podman venue could not read this account's containers.conf just now (a worker would retry the job)" : "the podman venue refuses every job on this host";
	console.log(`\nFAILED: ${lead}, so nothing below it was measured.\n  - ${venueRefused}`);
	process.exit(1);
}
const failures = [];
console.log(`\npodman conformance, ${PODMAN_BACKEND} venue, Podman ${read.info.version ?? "(version not reported)"}, as uid:gid ${decision.user}${decision.relabel ? ", SELinux relabel on" : ""}`);
for (const f of report.findings) {
	const mark = !f.ok ? "FAIL" : f.unverifiable ? "NOT READ" : "PASS";
	console.log(`  ${mark.padEnd(8)} ${f.check}: ${f.detail}`);
	if (!f.ok) failures.push(`${f.check}: ${f.detail}`);
	else if (f.unverifiable && READ_BACK_BY_A_LIVE_PROBE.includes(f.check)) failures.push(`${f.check} was not read back: ${f.detail}`);
}
// Issue #452: the stale canary sweep over a real leftover, on this Podman.
if (sweepCase) {
	const mark = sweepCase.notRead ? "NOT READ" : sweepCase.ok ? "PASS" : "FAIL";
	console.log(`  ${mark.padEnd(8)} stale canary sweep: ${sweepCase.notRead ?? (sweepCase.ok ? "an empty leftover and one with the proxy, a running and a stopped probe were removed, and the proxy kept running with its route out" : "see below")}`);
	for (const line of sweepCase.lines ?? []) console.log(`           ${line}`);
	if (!sweepCase.ok) {
		console.log(`           FAILED: ${sweepCase.why}`);
		failures.push(`stale canary sweep: ${sweepCase.why}`);
	}
}
// The job user, read back: PID 1's uid against this account's own. Not one of the harness's findings, and the property
// this venue exists for, so it is checked here rather than left to `nonRoot`, which only asks for a non-zero uid.
const userHeld = ranAs === euid;
console.log(`  ${(userHeld ? "PASS" : "FAIL").padEnd(8)} job user: PID 1 ran as ${ranAs ?? "an unread uid"}, this account is ${euid}`);
if (!userHeld) failures.push(`the job user: PID 1 ran as ${ranAs ?? "an unread uid"}, not ${euid}`);
// Issue #596, phase 2: the jobs' parent cgroup and its quota, applied by the worker's own reserve and read back off the
// probe container. Strict like the rest: a quota not held, or a placement not read, FAILS (this venue's user manager
// delegates cpu, so the worker can always set it here; a runner without one already fails the bounds observation).
const reserveHeld = reserveState?.status === "held";
const parentHeld = parentRead?.ok === true && parentRead.warn !== true;
console.log(`  ${(reserveHeld && parentHeld ? "PASS" : "FAIL").padEnd(8)} cpu reserve: the worker's reserve ${reserveHeld ? `held ${budget.cpuCenti / 100} CPUs on pidispatch.slice` : `did not hold (${reserveState?.status ?? "not run"}, ${reserveState?.reason ?? "no reason"})`}; read back: ${parentRead?.detail ?? "not read"}`);
if (!reserveHeld) failures.push(`cpu reserve: the quota was not held (${reserveState?.status ?? "not run"}, ${reserveState?.reason ?? "no reason"})`);
if (!parentHeld) failures.push(`cpu reserve: ${parentRead?.detail ?? "the probe's cgroup parent was not read back"}`);
// Issue #458. Egress off is a skip, not a pass: there is then no teardown under a proxy to read.
console.log(`  ${(!teardowns.ok ? "FAIL" : teardowns.ran ? "PASS" : "SKIP").padEnd(8)} egress after ${TEARDOWN_RUNS} job teardowns: ${teardowns.detail}`);
if (!teardowns.ok) failures.push(`egress after ${TEARDOWN_RUNS} job teardowns: ${teardowns.detail}`);
// Issue #450. Egress off is a skip: no bridge container is then sure to be running.
console.log(`  ${(!netns.ok ? "FAIL" : netns.ran ? "PASS" : "SKIP").padEnd(8)} the live rootless network, as the worker reads it: ${netns.detail}`);
if (!netns.ok) failures.push(`the live rootless network: ${netns.detail}`);
console.log("\n  not verified by this harness at all:");
for (const [property, why] of Object.entries(UNVERIFIED_BY_THIS_HARNESS)) console.log(`    ${property}: ${why}`);

if (failures.length > 0) {
	console.log(`\nFAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
	process.exit(1);
}
console.log(`\nPASSED: every check held, and all ${READ_BACK_BY_A_LIVE_PROBE.length} read-back properties were read back off live containers.`);
