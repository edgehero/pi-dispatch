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
 *     its gate, exactly as `pi-dispatch doctor --live` runs it on this venue, plus an egress canary of this script's
 *     own under the same Podman (doctor's canary runs on docker only).
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
 * on a freshly squashed image, against 4.2 s warm). And the egress canary is this script's own request, not the
 * runner's provider call, so it proves the network and the allowlist but not that the runner uses the proxy.
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
const { PODMAN_FIRST_START_TIMEOUT_MS, decidePodmanJobUser, makePodmanBackend, makePodmanInfoReader, podmanJobUserRefusal } = await load("worker/src/backend-podman.mjs");
const { makeReaper } = await load("worker/src/backend-local.mjs");
const { READ_BACK_BY_A_LIVE_PROBE, UNVERIFIED_BY_THIS_HARNESS, runBackendConformance } = await load("worker/src/backend-conformance.mjs");
const { SHIPPED_IMAGE_UID } = await load("worker/src/container-spec.mjs");
const { liveRunVia } = await load("worker/src/doctor.mjs");
const { buildPodmanRunArgs } = await load("worker/src/docker-run.mjs");
const { EGRESS_PROXY_PORT, createJobNetworkWith, egressArmed, egressProxyName, removeNetworkOrSay } = await load("worker/src/egress.mjs");
const { runLiveProbes } = await load("worker/src/live-probes.mjs");

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
});

let probes = 0;
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
	const img = await bundle.imagePreflight(job);
	if (!img?.ok) throw new Error(`imagePreflight did not admit the probe image: ${JSON.stringify(img)}`);
	const who = await bundle.jobUserPreflight(job, { capabilities: img.capabilities ?? [], observed });
	if (!who?.user) throw new Error(`jobUserPreflight gave no job user: ${JSON.stringify(who)}`);
	const name = bundle.containerName(jobId);
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
 * The egress readings `egressVerdict` takes, from two containers on a job-shaped network under this account's Podman:
 * `createJobNetworkWith` builds it exactly as a job's is built (`--internal`, then the proxy attached), one probe must
 * reach the provider through the proxy and one must not reach an unlisted host. doctor's canary does the same on
 * docker, and since issue #427 takes the runner's own route (pi loaded, then the runner's proxy restore); this is its
 * older method with a plain `fetch`, not its code, because doctor's is written against the docker CLI (issue #431).
 */
async function egressCanary() {
	if (armed !== true) return { results: [], proxyRunning: null };
	const state = await podman(["inspect", "--format={{.State.Running}}", proxy]);
	const proxyRunning = state.code === 0 && state.stdout.trim() === "true";
	if (!proxyRunning) return { results: [], proxyRunning };
	const network = `pi-dispatch-conformance-egress-${process.pid}-${nonce}-net`;
	const results = [];
	try {
		if (!(await createJobNetworkWith(podman, { network, proxy }))) return { results, proxyRunning };
		for (const [slug, url, want] of [["provider", "https://api.anthropic.com/v1/messages", true], ["unlisted", "https://example.com/", false]]) {
			const ran = await podman([
				"run",
				"--rm",
				"--name",
				`pi-dispatch-conformance-egress-${slug}-${process.pid}-${nonce}`,
				"--pull=never",
				`--network=${network}`,
				"-e",
				`HTTPS_PROXY=http://${proxy}:${EGRESS_PROXY_PORT}`,
				"-e",
				"NODE_USE_ENV_PROXY=1",
				"--entrypoint",
				"node",
				image,
				"-e",
				`fetch(${JSON.stringify(url)},{method:"POST"}).then(()=>process.exit(0),()=>process.exit(3))`,
			]);
			// 0 reached, 3 blocked; anything else is a container that did not run the script, which is no reading.
			results.push({ want, reached: ran.code === 0 ? true : ran.code === 3 ? false : null });
		}
	} finally {
		const removed = await removeNetworkOrSay(podman, { network, detach: [proxy], bin: "podman" });
		if (!removed.removed) console.error(`podman-conformance: the canary network was not removed: ${removed.command}`);
	}
	return { results, proxyRunning };
}

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
	});
	for (const note of result.notes ?? []) console.error(`podman-conformance: ${note}`);
	if (!result.ran) throw new Error(`the live probes did not run: ${result.reason}`);
	ranAs = result.ranAs;
	return result.verdicts;
}

let report;
try {
	report = await runBackendConformance(backend, { probe, withBrokenEnumeration, readBack });
} finally {
	await podman(["rmi", "-f", probeImage]);
	nodeFs.rmSync(scratch, { recursive: true, force: true });
}

// --- the summary: every finding, then what this run adds to the harness's own verdict ---
const failures = [];
console.log(`\npodman conformance, ${PODMAN_BACKEND} venue, Podman ${read.info.version ?? "(version not reported)"}, as uid:gid ${decision.user}${decision.relabel ? ", SELinux relabel on" : ""}`);
for (const f of report.findings) {
	const mark = !f.ok ? "FAIL" : f.unverifiable ? "NOT READ" : "PASS";
	console.log(`  ${mark.padEnd(8)} ${f.check}: ${f.detail}`);
	if (!f.ok) failures.push(`${f.check}: ${f.detail}`);
	else if (f.unverifiable && READ_BACK_BY_A_LIVE_PROBE.includes(f.check)) failures.push(`${f.check} was not read back: ${f.detail}`);
}
// The job user, read back: PID 1's uid against this account's own. Not one of the harness's findings, and the property
// this venue exists for, so it is checked here rather than left to `nonRoot`, which only asks for a non-zero uid.
const userHeld = ranAs === euid;
console.log(`  ${(userHeld ? "PASS" : "FAIL").padEnd(8)} job user: PID 1 ran as ${ranAs ?? "an unread uid"}, this account is ${euid}`);
if (!userHeld) failures.push(`the job user: PID 1 ran as ${ranAs ?? "an unread uid"}, not ${euid}`);
console.log("\n  not verified by this harness at all:");
for (const [property, why] of Object.entries(UNVERIFIED_BY_THIS_HARNESS)) console.log(`    ${property}: ${why}`);

if (failures.length > 0) {
	console.log(`\nFAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
	process.exit(1);
}
console.log(`\nPASSED: every check held, and all ${READ_BACK_BY_A_LIVE_PROBE.length} read-back properties were read back off live containers.`);
