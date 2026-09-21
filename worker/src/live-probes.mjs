/**
 * `doctor --live`: the backend declarations READ BACK off a real container (issue #278, INT-LIVE-PROBE-CONTRACT).
 *
 * `doctor` prints what the backend table DECLARES, and the conformance harness checks what a probe REPORTS, but
 * nothing in this repository asked a running container whether the words were true. This module does, for the
 * `local` backend on this host, and says exactly how far that reaches.
 *
 * EVERY CONTAINER IS BUILT BY THE SAME BUILDER A JOB IS. `buildDockerRunArgs` with every isolation flag, an EMPTY
 * environment, fixture directories for every conditional mount, and the job user; what each adds through `extraFlags`
 * is `-d` and an entrypoint. A hand-written argv would read back a container nobody runs; these differ from a job's
 * only in what they execute and what they are given, both of which are stated, and in the job's `--cidfile` (issue
 * #345), which only a job's never-started exit reads. There are four kinds: the READING container (`sleep`, then a
 * `cat /proc/self/mountinfo` and the status and write scripts), the PINNING container (an absent image), the EPHEMERAL
 * pair (two runs under one name, issue #344) and, only with the egress policy armed, two PEERS on their own
 * `--internal` job networks behind the proxy (issue #344). The egress canary in `doctor.mjs` is the one reading that
 * does NOT come from this module (its containers need the proxy's allowlist), folded in from its own `readBack`.
 *
 * NO SPAWN OF ITS OWN. Every docker step goes through `run(args, { timeoutMs })`, every filesystem call through `fs`,
 * and every wait through `now`/`delay`, so the whole sequence -- the teardown on every failure path included -- is
 * driven by tests without Docker. The job networks are built by `egress.mjs`'s own `createJobNetworkWith` over that
 * same runner, so a peer's network is a job's network, not a second copy of the sequence.
 *
 * WHAT IT PROVES, AND ONLY THAT. The verdicts are about THE FIXTURE on THIS daemon with PI_JOB_IMAGE: not the
 * operator's own folder, not an image a trigger names, not a remote venue (which reads back through the conformance
 * harness's `readBack` probe instead), and never on a docker CLI not observed local, where bind paths and `.Mounts`
 * would describe another machine.
 */

import { READ_BACK_BY_A_LIVE_PROBE } from "./backend-conformance.mjs";
import { containerSpec } from "./container-spec.mjs";
import { ISOLATION_FLAGS, buildDockerRunArgs } from "./docker-run.mjs";
import { DEFAULT_EGRESS_PROXY, EGRESS_PROXY_PORT, createJobNetworkWith, networkEndpoints, networkNameFor, removeNetworkOrSay } from "./egress.mjs";

/**
 * The namespace every live-probe object carries: every container name, the peer networks and the fixture directory. OUTSIDE the
 * boot reapers' `pi-job-` filter, the sandbox tooling's `pi-sandbox-` and the loopback `pi-dispatch-valkey`, so no
 * sweep of theirs can touch a probe and no probe name can be mistaken for one of theirs.
 */
export const LIVE_PREFIX = "pi-dispatch-live-";

/** Each docker step's bound. A seam for the tests; the sleep below is derived from it, never typed twice. */
export const LIVE_STEP_TIMEOUT_MS = 20_000;

/**
 * The docker steps that run while a container must still be alive: four for the reading container (inspect, mountinfo
 * exec, status exec, write exec), and three for the peers (the control before, the attempt, the control after; peer2's
 * inspect runs while peer1 is already waiting, well inside one step's bound).
 */
const STEPS_WHILE_ALIVE = 4;

/**
 * How long the probe container sleeps: every step that needs it alive at its full bound, plus a margin for the
 * spawn itself. DERIVED, so a longer step bound cannot leave a container that exits under the last read, and a
 * Ctrl-C mid-probe leaves a STARTED one that removes itself (`--rm`) within that window rather than a literal 300
 * seconds. One interrupted before it started has no `--rm` to run; the next run's sweep removes it.
 */
export function liveSleepSeconds(stepTimeoutMs = LIVE_STEP_TIMEOUT_MS) {
	return Math.ceil((STEPS_WHILE_ALIVE * stepTimeoutMs) / 1000) + 30;
}

/**
 * How long a container run with `--rm` may take to be gone after it exits before its survival is a finding (issue
 * #344). Measured removal: at most 51 ms over twenty runs on rootful Docker and 32 ms on rootful Podman, polled every
 * 10 ms; 278 ms on Docker Desktop and about 120 ms on both rootful daemons through this module's own 100 ms polls.
 * 10 s is over thirty times the slowest. A container still listed at the deadline FAILS only when it is stopped
 * (`exited`, `dead`, or Podman's `stopped`), and is not read back while it is still running or being removed.
 */
export const LIVE_REMOVAL_DEADLINE_MS = 10_000;
const LIVE_REMOVAL_POLL_MS = 100;

/** The port a peer listens on. Unprivileged, fixed, and inside a container that has nothing else listening. */
export const PEER_PORT = 47431;

/**
 * The names one run uses. `pid` and a random nonce, so two concurrent `--live` runs never share one. Every CONTAINER
 * kind is a key here, and the stale-container sweep derives its match from these keys, so a kind added here is a
 * kind the sweep removes.
 */
export function liveNames(pid, nonce) {
	return {
		probe: `${LIVE_PREFIX}probe-${pid}-${nonce}`,
		pin: `${LIVE_PREFIX}pin-${pid}-${nonce}`,
		ephemeral: `${LIVE_PREFIX}ephemeral-${pid}-${nonce}`,
		peer1: `${LIVE_PREFIX}peer1-${pid}-${nonce}`,
		peer2: `${LIVE_PREFIX}peer2-${pid}-${nonce}`,
		fixturePrefix: `${LIVE_PREFIX}${pid}-`,
	};
}

/** The container kinds `liveNames` makes, derived from it rather than typed a second time. */
export const LIVE_CONTAINER_KINDS = Object.freeze(Object.keys(liveNames(0, "0")).filter((k) => k !== "fixturePrefix"));

/** A reference no registry can serve (`.invalid` is reserved, RFC 6761), with the nonce so it is never cached. */
export function absentImageRef(nonce) {
	return `pi-dispatch-live-probe.invalid/absent:${nonce}`;
}

/** Every conditional mount a job can get, as fixture subdirectories of one root. */
export function liveFixture(root) {
	return { jobDir: `${root}/job`, workspace: `${root}/workspace`, outboxDir: `${root}/outbox`, sessionDir: `${root}/session`, globalPiDir: `${root}/global` };
}

/**
 * The builder options every live-probe container shares: the fixture mounts, no network (a peer sets its own), no
 * environment at all, and the
 * job user a job on this host would get (issue #341). `user` rides the builder's own field, so the probe is `--user`
 * exactly where a job is; there is still no `-e`, not even HOME, because the probe runs no pi and reads no home.
 */
function probeOptions({ image, name, fixture, user = null }) {
	return { image, name, env: {}, network: "none", user, ...fixture };
}

/** The probe container's argv: the job builder's, detached, with `sleep <derived seconds>` as its whole program. */
export function liveProbeRunArgs({ image, name, fixture, sleepSeconds = liveSleepSeconds(), user = null }) {
	return [...buildDockerRunArgs({ ...probeOptions({ image, name, fixture, user }), extraFlags: ["-d", "--entrypoint", "sleep"] }), String(sleepSeconds)];
}

/**
 * The pinning probe's argv: the job builder's, detached, against an image this host does not have. Detached so a
 * container that WAS created prints the ID it is removed by; with `--pull=never` in the builder none should be.
 */
export function pinningProbeRunArgs({ name, nonce, fixture, user = null }) {
	return buildDockerRunArgs({ ...probeOptions({ image: absentImageRef(nonce), name, fixture, user }), extraFlags: ["-d"] });
}

/**
 * One ephemeral run's argv (issue #344): the job builder's, detached, running EPHEMERAL_SCRIPT with the nonce and the
 * run's number. The same NAME both times, because "a job id run twice" is the question.
 */
export function ephemeralRunArgs({ image, name, fixture, nonce, run, user = null }) {
	return [...buildDockerRunArgs({ ...probeOptions({ image, name, fixture, user }), extraFlags: ["-d", "--entrypoint", "sh"] }), "-c", EPHEMERAL_SCRIPT, "sh", nonce, String(run)];
}

/**
 * One peer's argv (issue #344): the job builder's, detached, on its OWN job network, running PEER_SCRIPT, which answers
 * every connection with the nonce for `seconds`. Built with `network` set exactly as a job with egress armed is.
 */
export function peerRunArgs({ image, name, fixture, network, nonce, seconds = liveSleepSeconds(), user = null }) {
	return [...buildDockerRunArgs({ ...probeOptions({ image, name, fixture, user }), network, extraFlags: ["-d", "--entrypoint", "node"] }), "--eval", PEER_SCRIPT, nonce, String(PEER_PORT), String(seconds)];
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

/**
 * The write probe, as a job uses its mounts (issue #341): read and traverse the `0700` job dir (`[ -r ]` and `[ -x ]`,
 * shell builtins, the runner's own `access(R_OK|X_OK)`, so no image binary answers for it), then write the
 * workspace, the outbox and the session. The nonce rides argv as `$1`, never the script text; `-w` answers
 * writability without prose, and the FIRST mount that fails is named by its fixed path, never by an error message.
 */
export const WRITE_SCRIPT = [
	'[ -r /job ] && [ -x /job ] || { echo job-unreadable; exit 0; }',
	'for d in /workspace /outbox /session; do [ -w "$d" ] || { echo "not-writable $d"; exit 0; }; done',
	'printf %s "$1" > /workspace/.pi-dispatch-live-probe && printf %s "$1" > /outbox/.pi-dispatch-live-probe && printf %s "$1" > /session/.pi-dispatch-live-probe && echo wrote',
].join("\n");

/**
 * The ephemeral run's script (issue #344). A marker in the container's OWN `/tmp` says whether this filesystem was
 * used before; the nonce, or the word `residue`, lands in the shared fixture workspace under the run's number, so the
 * host reads both what ran and what it found. Positional values only: nothing from the host is in the text.
 */
export const EPHEMERAL_SCRIPT = [
	'if [ -e /tmp/.pi-dispatch-live-ephemeral ]; then printf residue > "/workspace/.pi-dispatch-live-ephemeral-$2"; exit 0; fi',
	// ONE list, so a /tmp this user cannot write leaves NO workspace marker, which is "not read back", rather than a
	// marker that says a residue check ran when it could not have.
	'printf %s "$1" > /tmp/.pi-dispatch-live-ephemeral && printf %s "$1" > "/workspace/.pi-dispatch-live-ephemeral-$2"',
].join("\n");

/**
 * A peer's program (issue #344), for `node --eval`: a TCP listener on every address that answers each connection with
 * the nonce, for `seconds`, then exits. `node` because the job image has it and a shell cannot listen portably; its
 * arguments are `process.argv.slice(1)` under `--eval` (measured in the job image).
 */
export const PEER_SCRIPT = [
	'const [nonce, port, seconds] = process.argv.slice(1);',
	'const net = require("node:net");',
	'const listen = (host) => net.createServer((s) => s.end(nonce + "\\n")).on("error", () => host === "::" && listen("0.0.0.0")).listen(Number(port), host);',
	'listen("::");',
	'setTimeout(() => process.exit(0), Number(seconds) * 1000);',
].join("\n");

/**
 * The connection attempt (issue #344), for `node --eval` inside a peer: `nonce` then `host:port` targets (`[v6]:port`
 * for an IPv6 literal), each tried at once with a 3 s bound, one output line per target. `reached` means the nonce
 * came back, `connected` that something accepted without it, and anything else is the error code in lower case or
 * `timeout`: a word, never a message.
 */
export const CONNECT_SCRIPT = [
	'const [nonce, ...targets] = process.argv.slice(1);',
	'const net = require("node:net");',
	'const one = (t) => new Promise((resolve) => {',
	'  const m = /^\\[(.*)\\]:(\\d+)$/.exec(t) || /^([^:]+):(\\d+)$/.exec(t);',
	'  if (!m) return resolve(t + " unparsed");',
	'  let data = ""; let done = false; let s = null;',
	'  const finish = (r) => { if (done) return; done = true; if (s) s.destroy(); resolve(t + " " + r); };',
	'  s = net.connect({ host: m[1], port: Number(m[2]) });',
	'  s.setTimeout(3000, () => finish(data.includes(nonce) ? "reached" : s.connecting ? "timeout" : "connected"));',
	'  s.on("connect", () => setTimeout(() => finish(data.includes(nonce) ? "reached" : "connected"), 500));',
	'  s.on("data", (d) => { data += d; if (data.includes(nonce)) finish("reached"); });',
	'  s.on("error", (e) => finish(String((e && e.code) || "error").toLowerCase()));',
	'});',
	'Promise.all(targets.map(one)).then((lines) => console.log(lines.join("\\n")));',
].join("\n");

/**
 * CONNECT_SCRIPT's output, as a Map of target to result word. Lines it did not print are simply absent, and so is a
 * line whose word is not a plain lower-case word: the image's `node` prints these, and nothing else reaches a verdict.
 */
export function parseConnectResults(output) {
	const results = new Map();
	for (const line of String(output ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		const at = trimmed.lastIndexOf(" ");
		if (at > 0 && /^[a-z0-9_]{1,40}$/.test(trimmed.slice(at + 1))) results.set(trimmed.slice(0, at), trimmed.slice(at + 1));
	}
	return results;
}

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
 * Mount points `/proc/self/mountinfo` may show inside a job container that no `.Mounts` entry lists, because the runtime
 * makes them for every container (issue #345, measured with the builder's argv on Docker Desktop, rootful Docker 27.5.1
 * and rootful Podman 5.8.2): the root, the three files docker writes per container, each runtime's init binary
 * (`/usr/sbin/docker-init` and `/run/podman-init` measured; `/sbin/docker-init`, where older Docker mounts it, is not),
 * and Podman's `.containerenv`. EXACT paths, never prefixes, so `/run/secrets` beside `/run/.containerenv` is not allowed.
 */
export const MOUNTINFO_ALLOWED_EXACT = Object.freeze(["/", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts", "/usr/sbin/docker-init", "/sbin/docker-init", "/run/podman-init", "/run/.containerenv"]);

/**
 * Kernel filesystems a container always has, allowed with everything beneath them BY PATH SEGMENT (the path itself or
 * `<tree>/...`): the proc masks (`/proc/kcore`, and Podman's `/proc/interrupts`), `/dev/pts`, `/dev/shm`, `/dev/mqueue`,
 * cgroup v1's per-controller mounts and `/sys/firmware`. A string prefix would allow `/devices`; a segment does not.
 */
export const MOUNTINFO_ALLOWED_TREES = Object.freeze(["/proc", "/dev", "/sys"]);

/**
 * Filesystem types a mount under those trees must NOT have: a disk or a network filesystem, or a host share, is a host
 * directory bound there, never one of the runtime's own masks (measured: the masks are `proc`, `tmpfs` and `sysfs` on
 * Docker, and `overlay` for Podman's `/proc/scsi` and `/sys/firmware`, so an allow-list of kernel types would fail
 * Podman). A deny-list, so a host path bound under a tree from an `overlay` or `tmpfs` source still passes (a residual).
 */
export const MOUNTINFO_HOST_FILESYSTEM = /^(?:ext[234]|xfs|btrfs|zfs|f2fs|vfat|exfat|ntfs3?|nfs4?|cifs|smb3|9p|virtiofs|fakeowner|fuseblk|fuse(?:\..+)?)$/;

/**
 * The mount points in a `/proc/self/mountinfo` body: field five of every line that has the `-` separator, with the
 * kernel's octal escapes (`\040` for a space) decoded. Lines of any other shape are skipped; an empty answer is `[]`.
 */
export function mountPointsOf(mountinfo) {
	return mountEntriesOf(mountinfo).map((entry) => entry.point);
}

/** `mountPointsOf` with each point's filesystem type (the field after the `-`), as `{ point, fstype }`. */
export function mountEntriesOf(mountinfo) {
	const entries = [];
	for (const line of String(mountinfo ?? "").split(/\r?\n/)) {
		const fields = line.trim().split(" ");
		const separator = fields.indexOf("-", 6);
		if (fields.length < 10 || separator < 0) continue;
		const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
		if (point.startsWith("/")) entries.push({ point, fstype: fields[separator + 1] ?? "" });
	}
	return entries;
}

/**
 * THE MOUNT SET, from `docker inspect .Mounts`, keyed by destination and read-write flag. A COUNT would pass a
 * container whose `/job` became writable while another mount went missing; so each declared destination must be
 * present with its own RW, nothing else may be mounted, and three sources are refused outright wherever they
 * appear: the docker socket, the operator's home directory or any ancestor of it, and the shared session store.
 *
 * `mountinfo` is what `/proc/self/mountinfo` said inside the container (issue #345): `undefined` when the caller did not
 * read it, `null` when the read failed. `.Mounts` is the daemon's own list, and a runtime can mount things into every
 * container that it never lists there (rootful Podman's `/run/secrets`, measured), so a mount point inside the container
 * that is neither declared nor on the runtime's own short list fails `runtime-mount`.
 */
export function mountSetVerdict(inspectOutput, { expected, home = null, sessionsDir = null, mountinfo = undefined }) {
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
	const declaredList = `${expected.map((m) => `${m.container}${m.readOnly ? ":ro" : ""}`).join(", ")} and nothing else`;
	if (mountinfo === undefined) return verdict("mountSet", true, declaredList);
	const entries = mountinfo === null ? [] : mountEntriesOf(mountinfo);
	if (entries.length === 0) return notReadBack("mountSet", `docker inspect lists ${declaredList}, but /proc/self/mountinfo could not be read inside the container, so a mount the runtime adds without listing it was not checked`);
	const underTree = (point) => MOUNTINFO_ALLOWED_TREES.some((tree) => point === tree || point.startsWith(`${tree}/`));
	const allowed = ({ point, fstype }) => declared.has(point) || MOUNTINFO_ALLOWED_EXACT.includes(point) || (underTree(point) && !MOUNTINFO_HOST_FILESYSTEM.test(fstype));
	// Printable only: a mount point is the container's text, and a verdict detail reaches the operator's terminal.
	const extra = [...new Set(entries.filter((e) => !allowed(e)).map((e) => e.point))].map((p) => p.replace(/[^\x20-\x7e]/g, "?"));
	if (extra.length > 0) {
		return verdict("mountSet", false, `${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} mounted inside the container, and neither docker inspect nor the job lists ${extra.length === 1 ? "it" : "them"}`, { cause: "runtime-mount" });
	}
	return verdict("mountSet", true, `${declaredList}, in docker inspect and in /proc/self/mountinfo`);
}

/**
 * LOCAL FOLDERS: a nonce written inside `/workspace` and read on the host, which is what "edited in place" means.
 * A folder the job user cannot write, and a write that does not show up on the host, are different failures with
 * different fixes, so they are told apart -- by `[ -w ]` inside, never by an error message.
 *
 * Issue #341 widens it to every mount a job uses, with the fixture in a job's real modes: a `0700` job dir the job
 * user cannot list (`job-unreadable`), an outbox or session it cannot write (`mount-not-writable`), and a nonce the
 * host sees owned by a uid other than this shell's (`not-yours`), which is a worker that could not clean up after
 * its own job. The owner check is skipped where there is no uid to compare (`euid` undefined, as on Windows) or the
 * host could not stat the file.
 */
export function localFoldersVerdict({ code, stdout, hostRead, nonce, hostOwner = null, euid = undefined, unseen = "/workspace" }) {
	if (code !== 0) return notReadBack("localFolders", "the write probe did not run in the container");
	const said = String(stdout ?? "").trim();
	if (said === "job-unreadable") return verdict("localFolders", false, "the job user cannot list a 0700 job directory this shell created, so no job here can read its own inputs", { cause: "job-unreadable" });
	if (said === "not-writable /workspace") return verdict("localFolders", false, "the job user cannot write a bind-mounted host folder, so a local-folder job cannot edit its folder in place", { cause: "not-writable" });
	if (said === "not-writable /outbox" || said === "not-writable /session") return verdict("localFolders", false, `the job user cannot write ${said.slice("not-writable ".length)}, a mount every job of that kind writes`, { cause: "mount-not-writable" });
	if (said !== "wrote") return notReadBack("localFolders", "the write probe gave no answer");
	if (hostRead !== nonce) return verdict("localFolders", false, `a file written inside ${unseen} is not visible on the host, so that mount is not the folder a job edits in place`, { cause: "not-visible" });
	if (typeof euid === "number" && typeof hostOwner === "number" && hostOwner !== euid) {
		return verdict("localFolders", false, `a file the job wrote is owned by uid ${hostOwner} on the host, not by this shell's uid ${euid}, so the worker could not remove what a job leaves`, { cause: "not-yours" });
	}
	return verdict("localFolders", true, `every mount a job uses was used as the job user, and the files written inside /workspace, /outbox and /session were read back on the host${typeof euid === "number" && typeof hostOwner === "number" ? `, owned by this shell's uid ${euid}` : ""}`);
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
 * EPHEMERAL (issue #344): two runs under ONE name, each detached with `--rm`, each waited on until `docker ps -a` no
 * longer lists it. `first`/`second` are `{ started, id, removal: { state, ms } }` (`state` one of `gone`, `exited`
 * (still listed, stopped, past the deadline), `present` (still listed, not stopped), `unanswered`), plus `nameHeld` on
 * the second when its run was refused while a container held the name; `markers` are what each run left in the
 * workspace. A finding needs positive evidence; anything that did not run to an answer is not read back.
 */
export function ephemeralVerdict({ first, second, markers = {}, nonce }) {
	const deadline = `${LIVE_REMOVAL_DEADLINE_MS / 1000} s`;
	const unfinished = (which, run) => {
		if (run?.removal?.state === "present") return notReadBack("ephemeral", `the ${which} run was still listed and not stopped after ${deadline}, so its removal was not seen`);
		if (run?.removal?.state === "unanswered") return notReadBack("ephemeral", `docker ps did not answer while the ${which} run was being waited on`);
		return null;
	};
	if (!first?.started) return notReadBack("ephemeral", "the first ephemeral run did not start");
	if (first.removal?.state === "exited") return verdict("ephemeral", false, `the first run's container was still listed, stopped, ${deadline} after it started: a job's container outlives the job`, { cause: "survived" });
	const firstUnfinished = unfinished("first", first);
	if (firstUnfinished) return firstUnfinished;
	if (second?.nameHeld) return verdict("ephemeral", false, "a second run under the same name was refused because a container still held the name after the first was gone: a job id cannot run twice", { cause: "name-held" });
	if (second?.started && second.id && first.id && second.id === first.id) return verdict("ephemeral", false, "the second run was given the first run's container", { cause: "reused" });
	if (markers.second === "residue") return verdict("ephemeral", false, "the second run found the first run's /tmp marker: a container's filesystem outlived it", { cause: "residue" });
	if (second?.removal?.state === "exited") return verdict("ephemeral", false, `the second run's container was still listed, stopped, ${deadline} after it started: a job's container outlives the job`, { cause: "survived" });
	const secondUnfinished = unfinished("second", second);
	if (secondUnfinished) return secondUnfinished;
	if (!second?.started) return notReadBack("ephemeral", "the second ephemeral run did not start");
	if (markers.first !== nonce || markers.second !== nonce) return notReadBack("ephemeral", "a run left no marker in the workspace, so whether it ran its script is not known");
	return verdict("ephemeral", true, `two runs under one name each removed themselves (in ${first.removal.ms} ms and ${second.removal.ms} ms), and the second found nothing of the first`);
}

/**
 * JOB-TO-JOB ISOLATION (issue #344): two peers, each on its own `--internal` job network behind the proxy, the way two
 * concurrent jobs get them. `fromPeer1` is peer1's results for the proxy (`proxyTarget`) and every name and address of
 * peer2 (`peerTargets`, `peerAddresses` the address subset); `controlBefore` and `controlAfter` are peer2's results
 * against its own addresses, run BEFORE and AFTER peer1's attempt. A peer reached is a FAILURE, and wins over every
 * missing reading. A block counts only when: at least one ADDRESS was tried (a name alone proves DNS scoping, not
 * routing); peer1 reached the proxy (a network that reaches nothing blocks everything); and peer2 answered itself
 * both before the attempt (else a refused connection may be a listener not yet up, which is the opposite of a block)
 * and after it (so it stayed up throughout).
 */
export function jobToJobIsolationVerdict({ armed, proxyRunning, networksCreated, peersStarted, proxyTarget, peerTargets = [], peerAddresses = [], fromPeer1 = new Map(), controlBefore = new Map(), controlAfter = new Map() }) {
	if (armed === null) return notReadBack("jobToJobIsolation", "PI_EGRESS could not be read (see the .env check above)");
	if (armed !== true) return notReadBack("jobToJobIsolation", "PI_EGRESS is off, so jobs share docker's default bridge by design and there is no per-job network to read back");
	if (proxyRunning === false) return notReadBack("jobToJobIsolation", "the egress proxy is not running, so no job-shaped network could be built");
	if (networksCreated !== true) return notReadBack("jobToJobIsolation", "the peer networks could not be created");
	if (peersStarted !== true) return notReadBack("jobToJobIsolation", "a peer container did not start");
	const reached = peerTargets.filter((t) => fromPeer1.get(t) === "reached");
	if (reached.length > 0) return verdict("jobToJobIsolation", false, `one job reached another across their own networks, at ${reached.join(", ")}`, { cause: "reached" });
	if (peerAddresses.length === 0) return notReadBack("jobToJobIsolation", "docker inspect gave peer2 no address on its network, so only names could be tried and a name proves nothing about routing");
	if (peerTargets.some((t) => !fromPeer1.has(t)) || !fromPeer1.has(proxyTarget)) return notReadBack("jobToJobIsolation", "the connection attempt did not answer for every target");
	if (!["connected", "reached"].includes(fromPeer1.get(proxyTarget))) return notReadBack("jobToJobIsolation", `peer1 could not reach the proxy (${fromPeer1.get(proxyTarget)}), so an unreached peer proves nothing`);
	// Keyed by the addresses peer1 was given, never by whatever the control printed: a control that answered one of
	// two addresses says nothing about the one peer1 was refused on.
	const answered = (control) => peerAddresses.every((address) => control.get(address) === "reached");
	if (!answered(controlBefore)) return notReadBack("jobToJobIsolation", "peer2 did not answer its own addresses before the attempt, so a refused connection may be a listener not yet up");
	if (!answered(controlAfter)) return notReadBack("jobToJobIsolation", "peer2 did not answer its own addresses after the attempt, so its listener was not up throughout");
	const accepted = peerTargets.filter((t) => fromPeer1.get(t) === "connected");
	if (accepted.length > 0) return notReadBack("jobToJobIsolation", `something accepted a connection at ${accepted.join(", ")} without the peer's nonce, which is neither reached nor refused`);
	return verdict("jobToJobIsolation", true, `peer1 reached the proxy and none of peer2's ${peerTargets.length} name(s) and address(es) (${peerTargets.map((t) => `${t} ${fromPeer1.get(t)}`).join(", ")}); peer2 answered itself before and after`);
}

/**
 * Wait for a container to be gone (issue #344): `docker ps -a --no-trunc --filter id=` until it lists nothing, or the
 * deadline passes. `docker wait --condition=removed` would be one call, and the docker CLI has no such flag (checked
 * on 27.4.0). Returns `{ state, ms }` with `state` `gone`, `exited`, `present` or `unanswered`.
 */
export async function awaitRemoved({ step, id, now, delay, deadlineMs = LIVE_REMOVAL_DEADLINE_MS, pollMs = LIVE_REMOVAL_POLL_MS }) {
	const start = now();
	for (;;) {
		const listed = await step(["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}} {{.State}}"]);
		if (listed?.code !== 0) return { state: "unanswered", ms: now() - start };
		const line = String(listed.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(id));
		if (!line) return { state: "gone", ms: now() - start };
		// Stopped, in either daemon's words: Docker's `exited` and `dead`, and Podman's `stopped` for a container that
		// exited and was never cleaned up (measured on rootful Podman 5.8.2 as the state before `exited`).
		if (now() - start >= deadlineMs) return { state: /^(exited|dead|stopped)$/i.test(line.split(/\s+/)[1] ?? "") ? "exited" : "present", ms: now() - start };
		await delay(pollMs);
	}
}

/**
 * The names and addresses a peer answers at on one network, from `docker inspect --format={{json .NetworkSettings.Networks}}`:
 * `{ targets, addresses }`, where `addresses` are the `IPAddress` and `GlobalIPv6Address` targets only, taken from
 * those FIELDS rather than recognised by shape (a short container ID that starts with a digit is a name).
 */
export function peerTargetsOf(inspectOutput, { network, name }) {
	let networks;
	try {
		networks = JSON.parse(String(inspectOutput ?? "").trim());
	} catch {
		return { targets: [], addresses: [] };
	}
	const on = networks?.[network];
	if (!on || typeof on !== "object") return { targets: [], addresses: [] };
	const hosts = new Set([name]);
	for (const n of [...(Array.isArray(on.DNSNames) ? on.DNSNames : []), ...(Array.isArray(on.Aliases) ? on.Aliases : [])]) if (typeof n === "string" && n) hosts.add(n);
	const addresses = [];
	if (typeof on.IPAddress === "string" && on.IPAddress) addresses.push(`${on.IPAddress}:${PEER_PORT}`);
	if (typeof on.GlobalIPv6Address === "string" && on.GlobalIPv6Address) addresses.push(`[${on.GlobalIPv6Address}]:${PEER_PORT}`);
	return { targets: [...[...hosts].map((h) => `${h}:${PEER_PORT}`), ...addresses], addresses };
}

/**
 * The whole sequence. Returns `{ ran, reason, verdicts, notes, swept, ranAs }`: `ran` false with a `reason` when nothing
 * was read back; the verdicts in READ_BACK_BY_A_LIVE_PROBE's order otherwise; `notes` for a teardown that failed, on
 * either path; `swept` for what an interrupted earlier run left and this one removed, on either path too.
 *
 * Order: precondition, a FRESH endpoint read, the announcement, the sweeps, the fixture, then one PHASE per kind of
 * container (reading, pinning, ephemeral, peers), each removing what it started before the next begins. ONE ownership
 * list holds every container and network this run made, and a `finally` removes whatever is left in it: containers
 * first, BY THE ID `run -d` printed (by the pid-and-nonce name only when no ID came back), then networks, then the
 * fixture. A container already SEEN gone is never removed again.
 */
export async function runLiveProbes({
	image,
	endpoint,
	resolveEndpoint = null,
	dockerReachable,
	imagePresent,
	jobsDir,
	home = null,
	sessionsDir = null,
	egress,
	pid,
	nonce,
	run,
	fs,
	isAlive,
	announce = () => {},
	stepTimeoutMs = LIVE_STEP_TIMEOUT_MS,
	user = null,
	euid = undefined,
	now = () => Date.now(),
	delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	removalDeadlineMs = LIVE_REMOVAL_DEADLINE_MS,
}) {
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
	const proxy = typeof egress?.proxy === "string" && egress.proxy ? egress.proxy : DEFAULT_EGRESS_PROXY;
	// The peers run only where a job would get its own network: the policy armed and its proxy not known to be down.
	const peersWanted = egress?.armed === true && egress?.proxyRunning !== false;
	const networkOf = { peer1: networkNameFor(names.peer1), peer2: networkNameFor(names.peer2) };
	// SHOWN BEFORE IT HAPPENS (REQ-DEPLOYMENT-BOOTSTRAP): every host mutation this makes is named, with where it lives
	// and that it goes away, before a sweep or the fixture touches anything.
	announce(
		`starting ${names.probe}, ${names.pin} and ${names.ephemeral} (twice) from ${image} (no environment, ${user ? `as the job user ${user}` : "as the image's own user"})` +
			(peersWanted ? `, and ${names.peer1} and ${names.peer2} on their own --internal networks ${networkOf.peer1} and ${networkOf.peer2}, with ${proxy} attached to both` : "") +
			`, with a fixture under ${jobsDir}; all of them are removed when the read-back ends, as is anything an interrupted earlier run left`,
	);
	const swept = [...sweepStaleFixtures({ jobsDir, pid, fs, isAlive }), ...(await sweepStaleContainers({ step, pid, isAlive })), ...(await sweepStaleNetworks({ step, pid, isAlive, notes }))];

	const owned = [];
	const networks = [];
	const start = async (what, name, args) => {
		const entry = { what, name, id: null, done: false };
		owned.push(entry);
		const result = await step(args);
		// The ID is taken whenever one was printed, whatever the exit: a CLI killed or timed out after the create can
		// leave a container that never started, which `--rm` does not remove.
		entry.id = containerIdOf(result);
		return { result, entry };
	};
	const release = async (entry) => {
		if (entry.done) return;
		entry.done = true;
		if (entry.id !== null) {
			const removed = await step(["rm", "-f", entry.id]);
			if (removed?.code !== 0) notes.push(`the ${entry.what} ${entry.id.slice(0, 12)} could not be removed: docker rm -f ${entry.id}`);
		} else {
			// No ID came back. The name carries this run's pid and nonce, so no other run's container can answer to it;
			// usually there is nothing by that name and docker says so, which is not worth a line.
			await step(["rm", "-f", entry.name]);
		}
	};
	const dropNetwork = async (entry) => {
		if (entry.done) return;
		entry.done = true;
		// The wording rule this used to carry inline now lives in `egress.mjs` beside the proxy name and the
		// network suffix, because three more sweeps needed the same rule and a second copy is the one nobody
		// updates when a third runtime words it differently. The call sequence is byte-for-byte what it was:
		// disconnect the proxy, `network rm` without `-f`, and on a failure one `network inspect` whose answer
		// decides between silence and a note.
		const outcome = await removeNetworkOrSay(step, { network: entry.name, detach: [proxy] });
		if (!outcome.removed) notes.push(`the network ${entry.name} could not be removed: ${outcome.command}`);
	};
	const makeFixture = (base) => {
		const fixture = liveFixture(base);
		// A JOB'S MODES, not friendlier ones (issue #341). A job's dir is a `0700` mkdtemp and its session dir `0700`;
		// this fixture used to chmod every directory `0755`, which is how a probe passed on hosts where every job
		// failed. The rest take the default mode, as a job's clone and outbox do. Still created EMPTY.
		for (const [key, dir] of Object.entries(fixture)) {
			fs.mkdirSync(dir, { recursive: true, ...(key === "jobDir" || key === "sessionDir" ? { mode: 0o700 } : {}) });
		}
		return fixture;
	};

	let root = null;
	try {
		// A jobs dir this shell cannot write (another user's, `PI_JOBS_DIR=""`, a path that is a file) is a reason not
		// to run, said as one, never an exception that takes the rest of doctor's output with it. `root` is set before
		// the realpath so a directory mkdtemp did make is still removed below when a later call fails.
		let fixture;
		try {
			fs.mkdirSync(jobsDir, { recursive: true });
			root = fs.mkdtempSync(`${jobsDir}/${names.fixturePrefix}`);
			root = fs.realpathSync(root);
			fixture = makeFixture(root);
		} catch (err) {
			// The SAME `notes` array the `finally` below pushes into, so a removal that fails there is still reported.
			return { ran: false, reason: `the fixture could not be created under ${JSON.stringify(jobsDir)} (${err?.code ?? "error"}), so no container was run`, verdicts: [], notes, swept };
		}

		// --- the reading container: mounts, status, writes ---
		const reading = await start("probe container", names.probe, liveProbeRunArgs({ image, name: names.probe, fixture, sleepSeconds: liveSleepSeconds(stepTimeoutMs), user }));
		const probeId = reading.entry.id;
		if (reading.result?.code !== 0 || probeId === null) {
			return { ran: false, reason: "the probe container did not start, so nothing was read back", verdicts: [], notes, swept };
		}

		const expected = containerSpec(probeOptions({ image, name: names.probe, fixture, user })).mounts;
		const inspected = await step(["inspect", "--format={{json .Mounts}}", probeId]);
		// Issue #345: the mount table as the container itself sees it, by a constant `cat`, for what `.Mounts` does not list.
		const mountinfo = await step(["exec", probeId, "cat", "/proc/self/mountinfo"]);
		const mountSet = inspected?.code === 0 ? mountSetVerdict(inspected.stdout, { expected, home, sessionsDir, mountinfo: mountinfo?.code === 0 ? mountinfo.stdout : null }) : notReadBack("mountSet", "docker inspect did not answer");

		const statusRun = await step(["exec", probeId, "sh", "-c", STATUS_SCRIPT]);
		const status = statusRun?.code === 0 ? parseStatus(statusRun.stdout) : null;
		const isolation = status ? isolationVerdict(status) : notReadBack("isolation", "the status probe did not run in the container");
		const nonRoot = status ? nonRootVerdict(status) : notReadBack("nonRoot", "the status probe did not run in the container");

		const written = await step(["exec", probeId, "sh", "-c", WRITE_SCRIPT, "sh", nonce]);
		const readBack = (dir) => {
			try {
				return fs.readFileSync(`${dir}/.pi-dispatch-live-probe`, "utf8");
			} catch {
				return null;
			}
		};
		// The workspace nonce is the check; the outbox's and the session's must match it too, or a write the container
		// reported is not one the host can see. A read that worked with a stat that did not leaves the owner unchecked.
		const reads = [["/workspace", readBack(fixture.workspace)], ["/outbox", readBack(fixture.outboxDir)], ["/session", readBack(fixture.sessionDir)]];
		const unseen = reads.find(([, r]) => r !== nonce)?.[0] ?? "/workspace";
		const hostRead = reads.every(([, r]) => r === nonce) ? nonce : null;
		let hostOwner = null;
		try {
			hostOwner = fs.statSync(`${fixture.workspace}/.pi-dispatch-live-probe`).uid;
		} catch {
			hostOwner = null;
		}
		const localFolders = localFoldersVerdict({ code: written?.code, stdout: written?.stdout, hostRead, nonce, hostOwner, euid, unseen });
		await release(reading.entry);

		// --- the pinning container: an image this host does not have ---
		const pinning = await start("pinning container", names.pin, pinningProbeRunArgs({ name: names.pin, nonce, fixture, user }));
		const after = await step(["image", "inspect", absentImageRef(nonce)]);
		const stillAbsent = after?.code === 0 ? false : typeof after?.code === "number" ? true : null;
		const imagePinning = imagePinningVerdict({ code: pinning.result?.code, output: `${pinning.result?.stdout ?? ""}${pinning.result?.stderr ?? ""}`, stillAbsent });
		await release(pinning.entry);

		// --- the ephemeral pair (issue #344): one name, two runs, each waited on until it is gone ---
		const runEphemeral = async (n) => {
			const { result, entry } = await start(`ephemeral container (run ${n})`, names.ephemeral, ephemeralRunArgs({ image, name: names.ephemeral, fixture, nonce, run: n, user }));
			const started = result?.code === 0 && entry.id !== null;
			// A HELD NAME is the daemon refusing the create for the name, in its own words (measured: Docker "Conflict. ...
			// is already in use", Podman "that name is already in use"). Not a listed container: after the first run was
			// seen gone, the only container listed under this run's name is this run's own failed one.
			// A run that printed an ID made its own container, so whatever failed after that was not the name.
			const nameHeld = !started && entry.id === null && /already in use/i.test(`${result?.stdout ?? ""}${result?.stderr ?? ""}`);
			const removal = entry.id === null ? null : await awaitRemoved({ step, id: entry.id, now, delay, deadlineMs: removalDeadlineMs });
			// SEEN GONE: never removed again, so a later `rm -f` cannot land on a new container that took its ID.
			if (removal?.state === "gone") entry.done = true;
			else await release(entry);
			return { started, id: entry.id, nameHeld, removal };
		};
		const first = await runEphemeral(1);
		const second = first.started && first.removal?.state === "gone" ? await runEphemeral(2) : null;
		const marker = (n) => {
			try {
				return fs.readFileSync(`${fixture.workspace}/.pi-dispatch-live-ephemeral-${n}`, "utf8");
			} catch {
				return null;
			}
		};
		const ephemeral = ephemeralVerdict({ first, second, markers: { first: marker(1), second: marker(2) }, nonce });

		// --- the peers (issue #344): two job networks, two peers, one attempt each way ---
		let jobToJobIsolation = jobToJobIsolationVerdict({ armed: egress?.armed, proxyRunning: egress?.proxyRunning });
		if (peersWanted) {
			const reading = { armed: true, proxyRunning: egress?.proxyRunning, networksCreated: false, peersStarted: false };
			const peerNetworks = [];
			const peers = [];
			try {
				for (const key of ["peer1", "peer2"]) {
					// OWNED BEFORE THE CREATE, as a container is before its run: a create that timed out may still have made it.
					const entry = { name: networkOf[key], done: false };
					networks.push(entry);
					peerNetworks.push(entry);
					if (!(await createJobNetworkWith(step, { network: networkOf[key], proxy }))) break;
					entry.created = true;
				}
				reading.networksCreated = peerNetworks.length === 2 && peerNetworks.every((e) => e.created);
				if (reading.networksCreated) {
					const ids = {};
					for (const key of ["peer1", "peer2"]) {
						let peerFixture;
						try {
							peerFixture = makeFixture(`${root}/${key}`);
						} catch {
							break;
						}
						const { result, entry } = await start(`${key} container`, names[key], peerRunArgs({ image, name: names[key], fixture: peerFixture, network: networkOf[key], nonce, seconds: liveSleepSeconds(stepTimeoutMs), user }));
						peers.push(entry);
						if (result?.code !== 0 || entry.id === null) break;
						ids[key] = entry.id;
					}
					reading.peersStarted = Boolean(ids.peer1 && ids.peer2);
					if (reading.peersStarted) {
						const described = await step(["inspect", "--format={{json .NetworkSettings.Networks}}", ids.peer2]);
						const { targets, addresses } = described?.code === 0 ? peerTargetsOf(described.stdout, { network: networkOf.peer2, name: names.peer2 }) : { targets: [], addresses: [] };
						reading.peerTargets = targets;
						reading.peerAddresses = addresses;
						reading.proxyTarget = `${proxy}:${EGRESS_PROXY_PORT}`;
						// The control brackets the attempt: peer2 answering its own addresses BEFORE proves a refused connection is
						// not a listener still starting, and AFTER proves it stayed up.
						const control = async () => {
							if (addresses.length === 0) return new Map();
							const self = await step(["exec", ids.peer2, "node", "--eval", CONNECT_SCRIPT, nonce, ...addresses]);
							return self?.code === 0 ? parseConnectResults(self.stdout) : new Map();
						};
						reading.controlBefore = await control();
						const attempt = await step(["exec", ids.peer1, "node", "--eval", CONNECT_SCRIPT, nonce, reading.proxyTarget, ...targets]);
						reading.fromPeer1 = attempt?.code === 0 ? parseConnectResults(attempt.stdout) : new Map();
						reading.controlAfter = await control();
					}
				}
			} finally {
				// Peers first, THEN their networks: a network with a container still on it is not removed without -f, and
				// this never uses -f.
				for (const entry of peers) await release(entry);
				for (const entry of peerNetworks) await dropNetwork(entry);
			}
			jobToJobIsolation = jobToJobIsolationVerdict(reading);
		}

		const byProperty = { isolation, ephemeral, mountSet, egress: egressVerdict(egress ?? {}), jobToJobIsolation, imagePinning, nonRoot, localFolders };
		// The uid PID 1 actually ran as, for doctor's job-user line: the decision it was given, read back.
		const ranAs = Array.isArray(status?.uids) && /^\d+$/.test(status.uids[1] ?? "") ? Number(status.uids[1]) : null;
		return { ran: true, verdicts: READ_BACK_BY_A_LIVE_PROBE.map((p) => byProperty[p]), notes, swept, ranAs };
	} finally {
		for (const entry of owned) await release(entry);
		for (const entry of networks) await dropNetwork(entry);
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
 * A live-probe container left by a run interrupted before its container STARTED, which `--rm` never removes
 * (measured: a SIGINT during `docker run -d` leaves one in `created`), or one a peer phase never reached the end of.
 * Only names of exactly one of `liveNames`' container kinds (derived, never retyped) and a PID no longer alive,
 * removed by ID. Best effort, like the fixture sweep.
 */
export async function sweepStaleContainers({ step, pid, isAlive }) {
	const listed = await step(["ps", "-a", "--filter", `name=${LIVE_PREFIX}`, "--format", "{{.ID}} {{.Names}}"]);
	if (listed?.code !== 0) return [];
	const swept = [];
	const shape = new RegExp(`^${LIVE_PREFIX}(?:${LIVE_CONTAINER_KINDS.join("|")})-(\\d+)-[0-9a-f]+$`);
	for (const line of String(listed.stdout ?? "").split(/\r?\n/)) {
		const [id, name] = line.trim().split(/\s+/);
		const m = shape.exec(name ?? "");
		if (!m || !/^[0-9a-f]{12,64}$/.test(id ?? "") || Number(m[1]) === pid || isAlive(Number(m[1]))) continue;
		if ((await step(["rm", "-f", id]))?.code === 0) swept.push(`container ${name}`);
	}
	return swept;
}

/**
 * A peer network an interrupted run left (issue #344): only a name of exactly a peer network's shape (the peer kinds
 * of `liveNames`, derived) and a PID no longer alive. What is attached to it decides what happens: a live-probe
 * CONTAINER still on it means a run that is not over (a PID from another namespace reads as dead here), so nothing is
 * touched; otherwise every endpoint still attached (a proxy, whatever `PI_EGRESS_PROXY` named when that run started)
 * is detached, each one named in what is reported, and the network is removed WITHOUT `-f`. One that stays is a note
 * carrying the command, never silence.
 */
export async function sweepStaleNetworks({ step, pid, isAlive, notes = [] }) {
	const listed = await step(["network", "ls", "--filter", `name=${LIVE_PREFIX}`, "--format", "{{.Name}}"]);
	if (listed?.code !== 0) return [];
	const swept = [];
	const peerKinds = LIVE_CONTAINER_KINDS.filter((k) => k.startsWith("peer"));
	const shape = new RegExp(`^${LIVE_PREFIX}(?:${peerKinds.join("|")})-(\\d+)-[0-9a-f]+-net$`);
	const probeContainer = new RegExp(`^${LIVE_PREFIX}(?:${LIVE_CONTAINER_KINDS.join("|")})-\\d+-`);
	for (const line of String(listed.stdout ?? "").split(/\r?\n/)) {
		const name = line.trim();
		const m = shape.exec(name);
		if (!m || Number(m[1]) === pid || isAlive(Number(m[1]))) continue;
		// Through the shared reader since issue #357, which is where the fail-closed rule lives: a `.Containers`
		// that renders as `null` used to parse to `{}` here and read as "nothing attached", which would detach
		// and remove a network that still had members. Unreadable is now unreadable, and this sweep's own
		// silence on it is unchanged -- it is best effort, and what it CAN read it still says.
		const { ok, names: attached } = await networkEndpoints(step, name);
		if (!ok) continue;
		if (attached.some((n) => probeContainer.test(n))) continue;
		for (const endpoint of attached) await step(["network", "disconnect", "-f", name, endpoint]);
		// Every endpoint detached is SAID, the proxy included: a container this sweep did not make may be among them.
		const detached = attached.length > 0 ? ` (after detaching ${attached.join(", ")})` : "";
		if ((await step(["network", "rm", name]))?.code === 0) swept.push(`network ${name}${detached}`);
		else notes.push(`the stale network ${name}${detached} could not be removed: docker network rm ${name}`);
	}
	return swept;
}
