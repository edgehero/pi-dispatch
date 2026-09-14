/**
 * `doctor --live`: the backend declarations READ BACK off a real container (issue #278, INT-LIVE-PROBE-CONTRACT).
 *
 * `doctor` prints what the backend table DECLARES, and the conformance harness checks what a probe REPORTS, but
 * nothing in this repository asked a running container whether the words were true. This module does, for the
 * `local` backend on this host, and says exactly how far that reaches.
 *
 * ONE CONTAINER, BUILT BY THE SAME BUILDER A JOB IS. `buildDockerRunArgs` with every isolation flag, `--network=none`,
 * an EMPTY environment, fixture directories for every conditional mount, and exactly three added flags (`-d`,
 * `--entrypoint`, `sleep`). A hand-written argv would read back a container nobody runs; this one differs from a
 * job's only in what it executes and what it is given, both of which are stated. The egress canary in `doctor.mjs`
 * is the one reading that does NOT come from this builder (it needs a job-shaped network and a proxy), and its
 * result is folded in from the canary's own `readBack` rather than re-probed here.
 *
 * NO NODE IMPORTS. Every spawn goes through `run(args, { timeoutMs })` and every filesystem call through `fs`, so
 * the whole sequence -- the teardown on every failure path included -- is driven by tests without Docker.
 *
 * WHAT IT PROVES, AND ONLY THAT. The verdicts are about THE FIXTURE on THIS daemon with PI_JOB_IMAGE: not the
 * operator's own folder, not an image a trigger names, not a remote venue (which reads back through the conformance
 * harness's `readBack` probe instead), and never on a docker CLI not observed local, where bind paths and `.Mounts`
 * would describe another machine.
 */

import { READ_BACK_BY_A_LIVE_PROBE } from "./backend-conformance.mjs";
import { containerSpec } from "./container-spec.mjs";
import { ISOLATION_FLAGS, buildDockerRunArgs } from "./docker-run.mjs";

/**
 * The namespace every live-probe object carries: the two container names and the fixture directory. OUTSIDE the
 * boot reapers' `pi-job-` filter, the sandbox tooling's `pi-sandbox-` and the loopback `pi-dispatch-valkey`, so no
 * sweep of theirs can touch a probe and no probe name can be mistaken for one of theirs.
 */
export const LIVE_PREFIX = "pi-dispatch-live-";

/** Each docker step's bound. A seam for the tests; the sleep below is derived from it, never typed twice. */
export const LIVE_STEP_TIMEOUT_MS = 20_000;

/** The docker steps that run while the probe container must still be alive: inspect, status exec, write exec. */
const STEPS_WHILE_ALIVE = 3;

/**
 * How long the probe container sleeps: every step that needs it alive at its full bound, plus a margin for the
 * spawn itself. DERIVED, so a longer step bound cannot leave a container that exits under the last read, and a
 * Ctrl-C mid-probe leaves a STARTED one that removes itself (`--rm`) within that window rather than a literal 300
 * seconds. One interrupted before it started has no `--rm` to run; the next run's sweep removes it.
 */
export function liveSleepSeconds(stepTimeoutMs = LIVE_STEP_TIMEOUT_MS) {
	return Math.ceil((STEPS_WHILE_ALIVE * stepTimeoutMs) / 1000) + 30;
}

/** The names one run uses. `pid` and a random nonce, so two concurrent `--live` runs never share one. */
export function liveNames(pid, nonce) {
	return {
		probe: `${LIVE_PREFIX}probe-${pid}-${nonce}`,
		pin: `${LIVE_PREFIX}pin-${pid}-${nonce}`,
		fixturePrefix: `${LIVE_PREFIX}${pid}-`,
	};
}

/** A reference no registry can serve (`.invalid` is reserved, RFC 6761), with the nonce so it is never cached. */
export function absentImageRef(nonce) {
	return `pi-dispatch-live-probe.invalid/absent:${nonce}`;
}

/** Every conditional mount a job can get, as fixture subdirectories of one root. */
export function liveFixture(root) {
	return { jobDir: `${root}/job`, workspace: `${root}/workspace`, outboxDir: `${root}/outbox`, sessionDir: `${root}/session`, globalPiDir: `${root}/global` };
}

/** The builder options both probe containers share: the fixture mounts, no network, and no environment at all. */
function probeOptions({ image, name, fixture }) {
	return { image, name, env: {}, network: "none", ...fixture };
}

/** The probe container's argv: the job builder's, detached, with `sleep <derived seconds>` as its whole program. */
export function liveProbeRunArgs({ image, name, fixture, sleepSeconds = liveSleepSeconds() }) {
	return [...buildDockerRunArgs({ ...probeOptions({ image, name, fixture }), extraFlags: ["-d", "--entrypoint", "sleep"] }), String(sleepSeconds)];
}

/**
 * The pinning probe's argv: the job builder's, detached, against an image this host does not have. Detached so a
 * container that WAS created prints the ID it is removed by; with `--pull=never` in the builder none should be.
 */
export function pinningProbeRunArgs({ name, nonce, fixture }) {
	return buildDockerRunArgs({ ...probeOptions({ image: absentImageRef(nonce), name, fixture }), extraFlags: ["-d"] });
}

/**
 * What the probe runs inside, as ONE constant script: no value from the host is interpolated into it. `cat` rather
 * than `grep`, so a job image without grep still answers, and the cgroup v1 paths are read where v2's are absent.
 */
export const STATUS_SCRIPT = [
	"cat /proc/1/status",
	'if [ -f /sys/fs/cgroup/cgroup.controllers ]; then echo "cgroup:v2"; echo "pids.max:$(cat /sys/fs/cgroup/pids.max 2>/dev/null)"; echo "memory.max:$(cat /sys/fs/cgroup/memory.max 2>/dev/null)";',
	'else echo "cgroup:v1"; echo "pids.max:$(cat /sys/fs/cgroup/pids/pids.max 2>/dev/null)"; echo "memory.max:$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"; fi',
].join("\n");

/** The write probe. The nonce rides argv as `$1`, never the script text; `-w` answers writability without prose. */
export const WRITE_SCRIPT = 'if [ -w /workspace ]; then printf %s "$1" > /workspace/.pi-dispatch-live-probe && echo wrote; else echo not-writable; fi';

/** The fields of `/proc/1/status` and the cgroup lines the verdicts read, or `null` for each one absent. */
export function parseStatus(output) {
	// `[ \t]*`, not `\s*`: an empty value (`pids.max:` on a host that could not read it) must not swallow the newline
	// and read the NEXT line as its value.
	const field = (name) => new RegExp(`^${name.replace(/\./g, "\\.")}:[ \\t]*(.*)$`, "m").exec(String(output ?? ""))?.[1]?.trim() ?? null;
	const uid = field("Uid");
	return {
		uids: uid === null ? null : uid.split(/\s+/),
		capBnd: field("CapBnd"),
		noNewPrivs: field("NoNewPrivs"),
		cgroup: field("cgroup"),
		pidsMax: field("pids.max"),
		memoryMax: field("memory.max"),
	};
}

/** The pids bound the builder passes, read off the imported flags rather than restated. */
export function expectedPidsLimit(flags = ISOLATION_FLAGS) {
	const flag = flags.find((f) => typeof f === "string" && f.startsWith("--pids-limit="));
	return flag ? Number(flag.slice("--pids-limit=".length)) : null;
}

/** The memory bound in bytes, from the spec's own default (`4g`), never a literal. */
export function expectedMemoryBytes(memory = containerSpec({ image: "i", name: "n", workspace: "/w" }).memory) {
	const m = /^(\d+)([kmg]?)$/i.exec(String(memory));
	if (!m) return null;
	return Number(m[1]) * { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
}

const verdict = (property, ok, detail, extra = {}) => ({ property, ok, detail, ...extra });
const notReadBack = (property, why) => verdict(property, false, `not read back: ${why}`, { warn: true });

/**
 * ISOLATION, read from PID 1 (docker-init under `--init`, running as the job user). `CapBnd` must be ZERO and
 * `NoNewPrivs` 1: `CapEff` alone is zero for any non-root image with or without `--cap-drop=ALL` (measured: the
 * raw image reads CapEff 0 and CapBnd 00000000a80425fb), so a check on it would pass a container with no boundary.
 * The pids and memory bounds come from the imported flags and the spec's default. On cgroup v2 a literal `max` is a
 * FAILURE (the bound was not applied, as on rootless docker without delegation); a bound that could not be read at
 * all is "not read back", never a pass.
 */
export function isolationVerdict(status, { pidsLimit = expectedPidsLimit(), memoryBytes = expectedMemoryBytes() } = {}) {
	if (!status || status.capBnd === null || status.noNewPrivs === null) return notReadBack("isolation", "PID 1's status did not show CapBnd and NoNewPrivs");
	const failures = [];
	if (!/^0+$/.test(status.capBnd)) failures.push(`CapBnd ${status.capBnd} (the capability bounding set is not empty)`);
	if (status.noNewPrivs !== "1") failures.push(`NoNewPrivs ${status.noNewPrivs}`);
	const bound = (name, got, want) => {
		if (got === null || got === "") return `${name} not readable`;
		if (got === "max") {
			failures.push(`${name} is max (the bound was not applied)`);
			return null;
		}
		if (Number(got) !== want) failures.push(`${name} ${got}, expected ${want}`);
		return null;
	};
	const unread = [bound("pids.max", status.pidsMax, pidsLimit), bound("memory.max", status.memoryMax, memoryBytes)].filter(Boolean);
	if (failures.length > 0) return verdict("isolation", false, failures.join("; "));
	if (unread.length > 0) return notReadBack("isolation", `${unread.join(" and ")} (cgroup ${status.cgroup ?? "unknown"}); CapBnd 0 and NoNewPrivs 1 did hold`);
	return verdict("isolation", true, `CapBnd 0, NoNewPrivs 1, pids.max ${pidsLimit}, memory.max ${memoryBytes}`);
}

/** NON-ROOT: all four Uid fields (real, effective, saved, filesystem) nonzero, on the process the job would be. */
export function nonRootVerdict(status) {
	const uids = status?.uids;
	if (!Array.isArray(uids) || uids.length !== 4 || uids.some((u) => !/^\d+$/.test(u))) return notReadBack("nonRoot", "PID 1's status did not show four Uid fields");
	if (uids.some((u) => u === "0")) return verdict("nonRoot", false, `Uid ${uids.join(" ")} (the job would run as root)`);
	return verdict("nonRoot", true, `Uid ${uids.join(" ")}`);
}

/**
 * THE MOUNT SET, from `docker inspect .Mounts`, keyed by destination and read-write flag. A COUNT would pass a
 * container whose `/job` became writable while another mount went missing; so each declared destination must be
 * present with its own RW, nothing else may be mounted, and three sources are refused outright wherever they
 * appear: the docker socket, the operator's home directory or any ancestor of it, and the shared session store.
 */
export function mountSetVerdict(inspectOutput, { expected, home = null, sessionsDir = null }) {
	let mounts;
	try {
		mounts = JSON.parse(String(inspectOutput ?? "").trim());
	} catch {
		return notReadBack("mountSet", "docker inspect did not return the mounts as JSON");
	}
	if (!Array.isArray(mounts)) return notReadBack("mountSet", "docker inspect did not return a mount list");
	const failures = [];
	const byDestination = new Map(mounts.map((m) => [m?.Destination, m]));
	for (const want of expected) {
		const got = byDestination.get(want.container);
		if (!got) failures.push(`${want.container} is missing`);
		else if (got.RW !== !want.readOnly) failures.push(`${want.container} is ${got.RW ? "writable" : "read-only"}, declared ${want.readOnly ? "read-only" : "writable"}`);
	}
	const declared = new Set(expected.map((m) => m.container));
	for (const m of mounts) {
		if (!declared.has(m?.Destination)) failures.push(`${m?.Destination} is mounted and nothing declares it`);
		const source = String(m?.Source ?? "");
		const under = (dir) => source !== "" && (source === dir || dir.startsWith(`${source.replace(/\/+$/, "")}/`));
		if (/docker\.sock$/.test(source) || /docker\.sock$/.test(String(m?.Destination ?? ""))) failures.push(`the docker socket is mounted (${m?.Destination})`);
		if (home && (source === "/" || under(home))) failures.push(`${m?.Destination} mounts the home directory or an ancestor of it`);
		if (sessionsDir && source !== "" && (source === sessionsDir || source.startsWith(`${sessionsDir.replace(/\/+$/, "")}/`) || under(sessionsDir))) failures.push(`${m?.Destination} mounts the shared session store or an ancestor of it`);
	}
	if (failures.length > 0) return verdict("mountSet", false, failures.join("; "));
	return verdict("mountSet", true, `${expected.map((m) => `${m.container}${m.readOnly ? ":ro" : ""}`).join(", ")} and nothing else`);
}

/**
 * LOCAL FOLDERS: a nonce written inside `/workspace` and read on the host, which is what "edited in place" means.
 * A folder the job user cannot write, and a write that does not show up on the host, are different failures with
 * different fixes, so they are told apart -- by `[ -w ]` inside, never by an error message.
 */
export function localFoldersVerdict({ code, stdout, hostRead, nonce }) {
	if (code !== 0) return notReadBack("localFolders", "the write probe did not run in the container");
	const said = String(stdout ?? "").trim();
	if (said === "not-writable") return verdict("localFolders", false, "the job user cannot write a bind-mounted host folder, so a local-folder job cannot edit its folder in place", { cause: "not-writable" });
	if (said !== "wrote") return notReadBack("localFolders", "the write probe gave no answer");
	if (hostRead !== nonce) return verdict("localFolders", false, "a file written inside /workspace is not visible in the host folder, so the folder is not the one edited in place", { cause: "not-visible" });
	return verdict("localFolders", true, "a file written inside /workspace was read back from the host folder");
}

/**
 * IMAGE PINNING: the builder's argv against an image this host does not have. It holds only if the run was
 * refused (nonzero), the daemon said `No such image`, docker did NOT try a pull (`Unable to find image` is the
 * CLI's announcement of one), and the image is still absent afterwards. A refusal in words this check does not
 * know is "not read back" rather than a pass.
 */
export function imagePinningVerdict({ code, output, stillAbsent }) {
	const text = String(output ?? "");
	if (code === null || code === undefined) return notReadBack("imagePinning", "the pinning probe did not run");
	if (code === 0) return verdict("imagePinning", false, "a container started from an image this host does not have");
	if (/Unable to find image/i.test(text)) return verdict("imagePinning", false, "docker tried to pull an image this host does not have");
	if (stillAbsent === false) return verdict("imagePinning", false, "an image this host did not have is present after the run");
	if (stillAbsent !== true) return notReadBack("imagePinning", "whether the image is still absent could not be read");
	if (!/No such image/i.test(text)) return notReadBack("imagePinning", "docker refused the run with a message this check does not recognise");
	return verdict("imagePinning", true, "an absent image was refused without a pull");
}

/**
 * EGRESS, folded in from `doctor.mjs`'s canary: two containers on a job-shaped network behind the proxy, one that
 * must reach the provider and one that must not reach an unlisted host. `results` is `[{ want, reached }]` from the
 * canary's `readBack`; anything short of both readings -- the policy off, the proxy down, the canary skipped -- is
 * "not read back", never a pass.
 */
export function egressVerdict({ armed, results }) {
	if (armed === null) return notReadBack("egress", "PI_EGRESS could not be read (see the .env check above)");
	if (armed !== true) return notReadBack("egress", "PI_EGRESS is off, so there is no policy to read back");
	if (!Array.isArray(results) || results.length < 2) return notReadBack("egress", "the egress canary did not run both probes (see the egress lines above)");
	// A WRONG reading fails first, whatever else is missing: an unlisted host that was reached is a finding even when
	// the provider probe did not run, and reporting it as merely unread would pass doctor over it.
	const wrong = results.filter((r) => typeof r.reached === "boolean" && r.reached !== r.want);
	if (wrong.length > 0) return verdict("egress", false, wrong.map((r) => (r.want ? "the provider was not reached" : "an unlisted host was reached")).join("; "));
	if (results.some((r) => typeof r.reached !== "boolean")) return notReadBack("egress", "an egress probe did not run to an answer (see the egress lines above)");
	return verdict("egress", true, "the provider was reached and an unlisted host was not");
}

/**
 * The whole sequence. Returns `{ ran, reason, verdicts, notes, swept }`: `ran` false with a `reason` when nothing was
 * read back; the verdicts in READ_BACK_BY_A_LIVE_PROBE's order otherwise; `notes` for a teardown that failed, on
 * either path; `swept` for what an interrupted earlier run left and this one removed, on either path too.
 *
 * Order: precondition, a FRESH endpoint read, the announcement, the sweep, the fixture, the probe container, the
 * reads, the pinning probe -- and a `finally` that removes each container BY THE ID `run -d` printed (by its
 * pid-and-nonce name only when no ID came back, which a CLI killed or timed out mid-create can leave) and the
 * fixture, whatever happened above it.
 */
export async function runLiveProbes({ image, endpoint, resolveEndpoint = null, dockerReachable, imagePresent, jobsDir, home = null, sessionsDir = null, egress, pid, nonce, run, fs, isAlive, announce = () => {}, stepTimeoutMs = LIVE_STEP_TIMEOUT_MS }) {
	const notRun = (reason) => ({ ran: false, reason, verdicts: [], notes: [], swept: [] });
	const notLocal = notRun("this shell's docker CLI is not observed to point at this host, so bind paths and .Mounts would describe another machine; nothing was run");
	if (endpoint?.local !== true) return notLocal;
	if (dockerReachable !== true) return notRun("the Docker daemon did not answer, so no container was run");
	if (imagePresent !== true) return notRun(`the job image ${image} is not present, so no container was run`);
	// ASKED AGAIN, immediately before the first command. The answer above came from the start of doctor's run, and
	// prompts and slow checks sit between the two; a `docker context use` in that window would otherwise send every
	// read below to another machine and report it as this one (the per-job re-read in `start.mjs`, for the same reason).
	if (typeof resolveEndpoint === "function" && (await resolveEndpoint())?.local !== true) return notLocal;

	const names = liveNames(pid, nonce);
	const notes = [];
	const step = (args) => run(args, { timeoutMs: stepTimeoutMs });
	// SHOWN BEFORE IT HAPPENS (REQ-DEPLOYMENT-BOOTSTRAP): the host mutation this makes is named, with where it lives
	// and that it goes away, before the sweep or the fixture touches anything.
	announce(`starting ${names.probe} from ${image} (no network, no environment) with a fixture under ${jobsDir}; both are removed when the read-back ends, as is anything an interrupted earlier run left`);
	const swept = [...sweepStaleFixtures({ jobsDir, pid, fs, isAlive }), ...(await sweepStaleContainers({ step, pid, isAlive }))];

	let root = null;
	let probeId = null;
	let pinId = null;
	let probeTried = false;
	let pinTried = false;
	try {
		// A jobs dir this shell cannot write (another user's, `PI_JOBS_DIR=""`, a path that is a file) is a reason not
		// to run, said as one, never an exception that takes the rest of doctor's output with it. `root` is set before
		// the realpath so a directory mkdtemp did make is still removed below when a later call fails.
		let fixture;
		try {
			fs.mkdirSync(jobsDir, { recursive: true });
			root = fs.mkdtempSync(`${jobsDir}/${names.fixturePrefix}`);
			root = fs.realpathSync(root);
			fs.chmodSync(root, 0o755);
			fixture = liveFixture(root);
			for (const dir of Object.values(fixture)) {
				fs.mkdirSync(dir, { recursive: true });
				fs.chmodSync(dir, 0o755);
			}
		} catch (err) {
			// The SAME `notes` array the `finally` below pushes into, so a removal that fails there is still reported.
			return { ran: false, reason: `the fixture could not be created under ${JSON.stringify(jobsDir)} (${err?.code ?? "error"}), so no container was run`, verdicts: [], notes, swept };
		}

		probeTried = true;
		const started = await step(liveProbeRunArgs({ image, name: names.probe, fixture, sleepSeconds: liveSleepSeconds(stepTimeoutMs) }));
		// The ID is taken whenever one was printed, whatever the exit. A CLI killed or timed out after the create can
		// leave a container that never started, which `--rm` does not remove; a start the daemon refused with `--rm` set
		// is removed by the daemon (measured, exit 127), and removing it again is harmless.
		probeId = containerIdOf(started);
		if (started?.code !== 0 || probeId === null) {
			return { ran: false, reason: "the probe container did not start, so nothing was read back", verdicts: [], notes, swept };
		}

		const expected = containerSpec(probeOptions({ image, name: names.probe, fixture })).mounts;
		const inspected = await step(["inspect", "--format={{json .Mounts}}", probeId]);
		const mountSet = inspected?.code === 0 ? mountSetVerdict(inspected.stdout, { expected, home, sessionsDir }) : notReadBack("mountSet", "docker inspect did not answer");

		const statusRun = await step(["exec", probeId, "sh", "-c", STATUS_SCRIPT]);
		const status = statusRun?.code === 0 ? parseStatus(statusRun.stdout) : null;
		const isolation = status ? isolationVerdict(status) : notReadBack("isolation", "the status probe did not run in the container");
		const nonRoot = status ? nonRootVerdict(status) : notReadBack("nonRoot", "the status probe did not run in the container");

		const written = await step(["exec", probeId, "sh", "-c", WRITE_SCRIPT, "sh", nonce]);
		let hostRead = null;
		try {
			hostRead = fs.readFileSync(`${fixture.workspace}/.pi-dispatch-live-probe`, "utf8");
		} catch {
			hostRead = null;
		}
		const localFolders = localFoldersVerdict({ code: written?.code, stdout: written?.stdout, hostRead, nonce });

		pinTried = true;
		const pinned = await step(pinningProbeRunArgs({ name: names.pin, nonce, fixture }));
		pinId = containerIdOf(pinned);
		const after = await step(["image", "inspect", absentImageRef(nonce)]);
		const stillAbsent = after?.code === 0 ? false : typeof after?.code === "number" ? true : null;
		const imagePinning = imagePinningVerdict({ code: pinned?.code, output: `${pinned?.stdout ?? ""}${pinned?.stderr ?? ""}`, stillAbsent });

		const byProperty = { isolation, mountSet, egress: egressVerdict(egress ?? {}), imagePinning, nonRoot, localFolders };
		return { ran: true, verdicts: READ_BACK_BY_A_LIVE_PROBE.map((p) => byProperty[p]), notes, swept };
	} finally {
		for (const [what, id, tried, name] of [["probe container", probeId, probeTried, names.probe], ["pinning container", pinId, pinTried, names.pin]]) {
			if (id !== null) {
				const removed = await step(["rm", "-f", id]);
				if (removed?.code !== 0) notes.push(`the ${what} ${id.slice(0, 12)} could not be removed: docker rm -f ${id}`);
			} else if (tried) {
				// No ID came back. The name carries this run's pid and nonce, so no other run's container can answer to it;
				// usually there is nothing by that name and docker says so, which is not worth a line.
				await step(["rm", "-f", name]);
			}
		}
		if (root !== null) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				notes.push(`the fixture ${root} could not be removed`);
			}
		}
	}
}

/** The container ID `docker run -d` printed: the last line of stdout that is one, else `null`. */
export function containerIdOf(result) {
	const lines = String(result?.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const last = lines.at(-1);
	return last && /^[0-9a-f]{12,64}$/.test(last) ? last : null;
}

/**
 * A fixture left by a `--live` run that did not reach its `finally` (a Ctrl-C). Only an entry of EXACTLY the shape
 * `mkdtemp` makes (the prefix, a PID, six characters), only a real directory (a symlink is never followed or
 * removed), and only one whose PID is no longer alive, so a concurrent run's fixture is never pulled out from under
 * its container. The shape is NARROW, not unique: a directory an operator happened to name `pi-dispatch-live-<n>-xxxxxx`
 * under the jobs dir, with no live process of that PID, is removed as well, which is why the jobs dir is not a place
 * for anything else and why what is removed is said. PIDs are this host's: a `--live` run from inside a container
 * that shares the host's docker numbers its own. Best effort: a sweep that fails is not a reason not to probe.
 */
export function sweepStaleFixtures({ jobsDir, pid, fs, isAlive }) {
	let entries;
	try {
		entries = fs.readdirSync(jobsDir);
	} catch {
		return [];
	}
	const swept = [];
	for (const entry of entries) {
		const m = new RegExp(`^${LIVE_PREFIX}(\\d+)-[A-Za-z0-9]{6}$`).exec(entry);
		if (!m || Number(m[1]) === pid || isAlive(Number(m[1]))) continue;
		try {
			const st = fs.lstatSync(`${jobsDir}/${entry}`);
			if (!st.isDirectory() || st.isSymbolicLink()) continue;
			fs.rmSync(`${jobsDir}/${entry}`, { recursive: true, force: true });
			swept.push(`fixture ${entry}`);
		} catch {
			// left for the next run
		}
	}
	return swept;
}

/**
 * A probe or pinning container left by a run interrupted before its container STARTED, which `--rm` never removes
 * (measured: a SIGINT during `docker run -d` leaves one in `created`). Only names of exactly this module's shape and
 * a PID no longer alive, removed by ID. Best effort, like the fixture sweep.
 */
export async function sweepStaleContainers({ step, pid, isAlive }) {
	const listed = await step(["ps", "-a", "--filter", `name=${LIVE_PREFIX}`, "--format", "{{.ID}} {{.Names}}"]);
	if (listed?.code !== 0) return [];
	const swept = [];
	for (const line of String(listed.stdout ?? "").split(/\r?\n/)) {
		const [id, name] = line.trim().split(/\s+/);
		const m = new RegExp(`^${LIVE_PREFIX}(?:probe|pin)-(\\d+)-[0-9a-f]+$`).exec(name ?? "");
		if (!m || !/^[0-9a-f]{12,64}$/.test(id ?? "") || Number(m[1]) === pid || isAlive(Number(m[1]))) continue;
		if ((await step(["rm", "-f", id]))?.code === 0) swept.push(`container ${name}`);
	}
	return swept;
}
