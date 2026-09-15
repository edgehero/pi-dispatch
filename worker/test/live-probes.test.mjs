import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { READ_BACK_BY_A_LIVE_PROBE } from "../src/backend-conformance.mjs";
import { JOB_NAME_PREFIX } from "../src/backend-local.mjs";
import { ISOLATION_FLAGS } from "../src/docker-run.mjs";
import {
	absentImageRef,
	awaitRemoved,
	CONNECT_SCRIPT,
	containerIdOf,
	egressVerdict,
	EPHEMERAL_SCRIPT,
	ephemeralRunArgs,
	ephemeralVerdict,
	expectedMemoryBytes,
	expectedPidsLimit,
	imagePinningVerdict,
	isolationVerdict,
	jobToJobIsolationVerdict,
	LIVE_CONTAINER_KINDS,
	LIVE_PREFIX,
	LIVE_REMOVAL_DEADLINE_MS,
	liveFixture,
	liveNames,
	liveProbeRunArgs,
	liveSleepSeconds,
	localFoldersVerdict,
	mountSetVerdict,
	nonRootVerdict,
	parseConnectResults,
	parseStatus,
	PEER_PORT,
	PEER_SCRIPT,
	peerRunArgs,
	peerTargetsOf,
	pinningProbeRunArgs,
	runLiveProbes,
	STATUS_SCRIPT,
	sweepStaleContainers,
	sweepStaleFixtures,
	sweepStaleNetworks,
	WRITE_SCRIPT,
} from "../src/live-probes.mjs";

const FIXTURE = liveFixture("/tmp/pi-dispatch-live-1-abc");
const ID = "a".repeat(64);
const nodeFs = { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync };

// Every directory a test here makes is removed when the file ends: the OS temp dir is not this suite's to fill, and a
// fixture a test leaves behind is exactly what the sweeps under test are there to stop.
const madeDirs = [];
const tempDir = (prefix) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	madeDirs.push(dir);
	return dir;
};
after(() => {
	for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

// What the shipped image reads under the builder's flags (measured on docker 27.4 / Docker Desktop), and what the
// same image reads WITHOUT them. The second is the non-vacuity fixture: CapEff is 0 in both.
const HELD_STATUS = "Name:\tdocker-init\nUid:\t1001\t1001\t1001\t1001\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\ncgroup:v2\npids.max:512\nmemory.max:4294967296\n";
const RAW_STATUS = "Uid:\t1001\t1001\t1001\t1001\nCapEff:\t0000000000000000\nCapBnd:\t00000000a80425fb\nNoNewPrivs:\t0\ncgroup:v2\npids.max:max\nmemory.max:max\n";

// --- the argv ---------------------------------------------------------------------------------------------------

test("the probe container is the JOB BUILDER's argv: every isolation flag, no network, no env, sleep as its program", () => {
	const args = liveProbeRunArgs({ image: "pi-job:x", name: "pi-dispatch-live-probe-1-n", fixture: FIXTURE, sleepSeconds: 90 });
	for (const flag of ISOLATION_FLAGS) assert.ok(args.includes(flag), `${flag} reaches the probe argv (checked against the imported array)`);
	assert.ok(args.includes("--network=none"));
	for (const flag of ["-d", "--entrypoint", "sleep"]) assert.ok(args.includes(flag), flag);
	assert.equal(args.includes("-e"), false, "an EMPTY environment: nothing of this shell's reaches the probe");
	assert.deepEqual(args.slice(-2), ["pi-job:x", "90"], "the image, then the sleep, last");
	for (const dest of ["/job:ro", "/workspace", "/outbox", "/session", "/opt/pi-global:ro"]) {
		assert.ok(args.some((a) => a.endsWith(`:${dest}`)), `every conditional mount is present: ${dest}`);
	}
});

test("the sleep is DERIVED from the step bound, never a literal", () => {
	assert.equal(liveSleepSeconds(20_000), 90);
	assert.equal(liveSleepSeconds(40_000), 150);
	assert.ok(liveSleepSeconds(20_000) * 1000 > 3 * 20_000, "outlives every step that needs the container alive");
});

test("names carry the pid and nonce, and sit outside every sweep's namespace", () => {
	const a = liveNames(42, "n1");
	const b = liveNames(42, "n2");
	assert.notEqual(a.probe, b.probe);
	for (const name of [a.probe, a.pin, a.fixturePrefix]) {
		assert.ok(name.startsWith(LIVE_PREFIX));
		assert.ok(!name.includes(JOB_NAME_PREFIX), "never inside the boot reapers' pi-job- filter");
		assert.ok(!name.includes("pi-sandbox-"));
		assert.ok(!name.startsWith("pi-dispatch-valkey"));
	}
	assert.ok(a.probe.endsWith("-42-n1"));
});

test("the pinning probe is the builder's argv against an image no registry can serve", () => {
	const args = pinningProbeRunArgs({ name: "pi-dispatch-live-pin-1-n", nonce: "n", fixture: FIXTURE });
	assert.ok(args.includes("--pull=never"));
	assert.equal(args.at(-1), absentImageRef("n"));
	assert.match(absentImageRef("n"), /\.invalid\/absent:n$/);
	assert.ok(args.includes("-d"), "detached, so a container that was somehow created prints the ID it is removed by");
});

test("the scripts interpolate nothing from the host: the nonce rides argv", () => {
	assert.ok(!STATUS_SCRIPT.includes("${"), "no template value");
	assert.ok(!WRITE_SCRIPT.includes("${"), "no template value");
	assert.match(WRITE_SCRIPT, /"\$1"/);
	// Issue #341: PINNED LITERALLY, line by line. A unit test cannot run it (its paths are a container's), so a step
	// dropped from it (the job dir check, a mount out of the -w loop) would otherwise pass every assertion here.
	assert.deepEqual(WRITE_SCRIPT.split("\n"), [
		'[ -r /job ] && [ -x /job ] || { echo job-unreadable; exit 0; }',
		'for d in /workspace /outbox /session; do [ -w "$d" ] || { echo "not-writable $d"; exit 0; }; done',
		'printf %s "$1" > /workspace/.pi-dispatch-live-probe && printf %s "$1" > /outbox/.pi-dispatch-live-probe && printf %s "$1" > /session/.pi-dispatch-live-probe && echo wrote',
	]);
});

test("the probes run as the job user a job on this host gets, and still carry no environment at all (#341)", () => {
	const args = liveProbeRunArgs({ image: "pi-job:x", name: "pi-dispatch-live-probe-1-n", fixture: FIXTURE, sleepSeconds: 90, user: "1234:1234" });
	assert.ok(args.includes("--user=1234:1234"));
	assert.equal(args.includes("-e"), false, "not even HOME: the probe runs no pi and reads no home");
	assert.ok(pinningProbeRunArgs({ name: "pi-dispatch-live-pin-1-n", nonce: "n", fixture: FIXTURE, user: "1234:1234" }).includes("--user=1234:1234"));
	assert.ok(!liveProbeRunArgs({ image: "pi-job:x", name: "p", fixture: FIXTURE, sleepSeconds: 90 }).some((a) => a.startsWith("--user")), "no user, no flag: the image's own");
});

// --- the verdicts -----------------------------------------------------------------------------------------------

test("isolation FAILS on a nonzero CapBnd even with CapEff 0, which is what a non-root image reads without the flags", () => {
	const raw = isolationVerdict(parseStatus(RAW_STATUS));
	assert.equal(raw.ok, false);
	assert.notEqual(raw.warn, true, "a failure, not an unread");
	assert.match(raw.detail, /CapBnd 00000000a80425fb/);
	assert.match(raw.detail, /NoNewPrivs 0/);
	assert.match(raw.detail, /pids\.max is max/);
	const held = isolationVerdict(parseStatus(HELD_STATUS));
	assert.equal(held.ok, true, held.detail);
});

test("isolation reads its bounds from the imported flags and the spec default, not literals", () => {
	assert.equal(expectedPidsLimit(), Number(ISOLATION_FLAGS.find((f) => f.startsWith("--pids-limit=")).split("=")[1]));
	assert.equal(expectedMemoryBytes("4g"), 4 * 1024 ** 3);
	assert.equal(expectedMemoryBytes(), 4 * 1024 ** 3, "the spec's own default is 4g");
	const wrong = isolationVerdict(parseStatus(HELD_STATUS.replace("pids.max:512", "pids.max:4096")));
	assert.equal(wrong.ok, false);
	assert.match(wrong.detail, /pids\.max 4096, expected 512/);
});

test("isolation: NoNewPrivs 0 alone fails; an unreadable bound is NOT read back, never a pass", () => {
	assert.equal(isolationVerdict(parseStatus(HELD_STATUS.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"))).ok, false);
	const v1 = isolationVerdict(parseStatus(HELD_STATUS.replace("cgroup:v2", "cgroup:v1").replace("pids.max:512", "pids.max:").replace("memory.max:4294967296", "memory.max:")));
	assert.equal(v1.ok, false);
	assert.equal(v1.warn, true);
	assert.match(v1.detail, /not read back/);
	assert.equal(isolationVerdict(parseStatus("Uid:\t1\t1\t1\t1\n")).warn, true, "no CapBnd line at all");
});

test("nonRoot needs all four Uid fields nonzero", () => {
	assert.equal(nonRootVerdict(parseStatus(HELD_STATUS)).ok, true);
	assert.equal(nonRootVerdict(parseStatus("Uid:\t0\t0\t0\t0\n")).ok, false);
	assert.equal(nonRootVerdict(parseStatus("Uid:\t1001\t0\t1001\t1001\n")).ok, false, "a zero effective uid alone is root");
	assert.equal(nonRootVerdict(parseStatus("")).warn, true);
});

const EXPECTED = [
	{ container: "/job", readOnly: true },
	{ container: "/workspace", readOnly: false },
];
const mounts = (list) => JSON.stringify(list.map(([Destination, RW, Source = `/tmp/f${Destination}`]) => ({ Destination, RW, Source, Type: "bind" })));

test("mountSet is keyed by destination AND read-write flag, so a flip with an equal count fails", () => {
	assert.equal(mountSetVerdict(mounts([["/job", false], ["/workspace", true]]), { expected: EXPECTED }).ok, true);
	const flipped = mountSetVerdict(mounts([["/job", true], ["/workspace", true]]), { expected: EXPECTED });
	assert.equal(flipped.ok, false);
	assert.match(flipped.detail, /\/job is writable, declared read-only/);
	assert.match(mountSetVerdict(mounts([["/job", false]]), { expected: EXPECTED }).detail, /\/workspace is missing/);
	assert.match(mountSetVerdict(mounts([["/job", false], ["/workspace", true], ["/extra", true]]), { expected: EXPECTED }).detail, /\/extra is mounted and nothing declares it/);
});

test("mountSet refuses the docker socket, the home directory or an ancestor, and the shared session store", () => {
	const base = [["/job", false], ["/workspace", true]];
	const sock = mountSetVerdict(mounts([...base, ["/var/run/docker.sock", true, "/var/run/docker.sock"]]), { expected: EXPECTED });
	assert.match(sock.detail, /docker socket/);
	const home = mountSetVerdict(mounts([["/job", false], ["/workspace", true, "/home"]]), { expected: EXPECTED, home: "/home/op" });
	assert.equal(home.ok, false);
	assert.match(home.detail, /home directory or an ancestor/);
	const sessions = mountSetVerdict(mounts([["/job", false], ["/workspace", true, "/srv/sessions/k1"]]), { expected: EXPECTED, sessionsDir: "/srv/sessions" });
	assert.match(sessions.detail, /shared session store/);
	assert.equal(mountSetVerdict("not json", { expected: EXPECTED }).warn, true);
});

test("localFolders tells a folder the job user cannot write from a write the host cannot see", () => {
	assert.equal(localFoldersVerdict({ code: 0, stdout: "wrote\n", hostRead: "n", nonce: "n" }).ok, true);
	const eacces = localFoldersVerdict({ code: 0, stdout: "not-writable /workspace\n", hostRead: null, nonce: "n" });
	assert.equal(eacces.ok, false);
	assert.match(eacces.detail, /cannot write/);
	assert.equal(eacces.cause, "not-writable", "the cause rides the verdict, so doctor can give each its own fix");
	const invisible = localFoldersVerdict({ code: 0, stdout: "wrote\n", hostRead: null, nonce: "n" });
	assert.equal(invisible.ok, false);
	assert.match(invisible.detail, /not visible on the host/);
	assert.equal(invisible.cause, "not-visible");
	assert.equal(localFoldersVerdict({ code: 1, stdout: "", hostRead: null, nonce: "n" }).warn, true, "a vanished container is not read back, never a failure");
});

test("localFolders reads every mount a job uses, in a job's modes, and the host owner of what the job wrote (#341)", () => {
	const unreadable = localFoldersVerdict({ code: 0, stdout: "job-unreadable\n", hostRead: null, nonce: "n" });
	assert.deepEqual([unreadable.ok, unreadable.cause], [false, "job-unreadable"]);
	for (const mount of ["/outbox", "/session"]) {
		const v = localFoldersVerdict({ code: 0, stdout: `not-writable ${mount}\n`, hostRead: null, nonce: "n" });
		assert.deepEqual([v.ok, v.cause], [false, "mount-not-writable"], mount);
		assert.match(v.detail, new RegExp(mount));
	}
	assert.equal(localFoldersVerdict({ code: 0, stdout: "not-writable /workspace\n", hostRead: null, nonce: "n" }).cause, "not-writable");
	assert.equal(localFoldersVerdict({ code: 0, stdout: "not-writable\n", hostRead: null, nonce: "n" }).warn, true, "a bare answer the constant script never prints is no answer");
	const theirs = localFoldersVerdict({ code: 0, stdout: "wrote\n", hostRead: "n", nonce: "n", hostOwner: 1001, euid: 1234 });
	assert.deepEqual([theirs.ok, theirs.cause], [false, "not-yours"]);
	assert.match(theirs.detail, /uid 1001 on the host, not by this shell's uid 1234/);
	assert.equal(localFoldersVerdict({ code: 0, stdout: "wrote\n", hostRead: "n", nonce: "n", hostOwner: 1234, euid: 1234 }).ok, true);
	assert.equal(localFoldersVerdict({ code: 0, stdout: "wrote\n", hostRead: "n", nonce: "n", hostOwner: 1001, euid: undefined }).ok, true, "no uid to compare (Windows): skipped, not failed");
	assert.equal(localFoldersVerdict({ code: 0, stdout: "wrote\n", hostRead: "n", nonce: "n", hostOwner: null, euid: 1234 }).ok, true, "an owner the host could not stat: skipped, not failed");
});

test("imagePinning holds only for a refusal with no pull attempt, and the image still absent", () => {
	const refused = "docker: Error response from daemon: No such image: pi-dispatch-live-probe.invalid/absent:n.\n";
	assert.equal(imagePinningVerdict({ code: 125, output: refused, stillAbsent: true }).ok, true);
	assert.equal(imagePinningVerdict({ code: 125, output: `Unable to find image 'x' locally\n${refused}`, stillAbsent: true }).ok, false, "a nonzero exit AFTER a pull attempt is not pinning");
	assert.equal(imagePinningVerdict({ code: 0, output: "", stillAbsent: true }).ok, false);
	assert.equal(imagePinningVerdict({ code: 125, output: refused, stillAbsent: false }).ok, false);
	assert.equal(imagePinningVerdict({ code: 125, output: "some other refusal", stillAbsent: true }).warn, true, "unknown words are not a pass");
	assert.equal(imagePinningVerdict({ code: 125, output: refused, stillAbsent: null }).warn, true);
	assert.equal(imagePinningVerdict({ code: null, output: "", stillAbsent: null }).warn, true);
});

test("egress is folded from the canary: off or partial is not read back, a wrong reading fails", () => {
	assert.equal(egressVerdict({ armed: false, results: [] }).warn, true);
	assert.equal(egressVerdict({ armed: true, results: [{ want: true, reached: true }] }).warn, true, "one of two readings is not a read-back");
	assert.equal(egressVerdict({ armed: true, results: [{ want: true, reached: true }, { want: false, reached: false }] }).ok, true);
	const leak = egressVerdict({ armed: true, results: [{ want: true, reached: true }, { want: false, reached: true }] });
	assert.equal(leak.ok, false);
	assert.match(leak.detail, /unlisted host was reached/);
	assert.equal(egressVerdict({ armed: true, results: [{ want: true, reached: true }, { want: false, reached: null }] }).warn, true, "a probe that did not run is no reading, never a deny");
	assert.match(egressVerdict({ armed: null, results: [] }).detail, /could not be read/, "a malformed PI_EGRESS is not reported as off");
	const reachedWhileProviderUnread = egressVerdict({ armed: true, results: [{ want: true, reached: null }, { want: false, reached: true }] });
	assert.equal(reachedWhileProviderUnread.ok, false);
	assert.notEqual(reachedWhileProviderUnread.warn, true, "a reached unlisted host is a finding even when the other probe did not run");
});

test("containerIdOf takes the ID docker run -d printed, and nothing else", () => {
	assert.equal(containerIdOf({ stdout: `${ID}\n` }), ID);
	assert.equal(containerIdOf({ stdout: "Unable to find image\n" }), null);
	assert.equal(containerIdOf({ stdout: "" }), null);
});

// --- the sequence -----------------------------------------------------------------------------------------------

/** A docker CLI that answers like the measured one, recording every argv. `over` replaces one step's answer. */
function fakeDocker(over = {}, { id = ID } = {}) {
	const calls = [];
	let volumes = [];
	let ephemeralRuns = 0;
	// A container started WITH --rm is gone once it exits; one without stays listed, stopped. So dropping --rm from the
	// builder's flags turns the ephemeral probe red here, not only on a real daemon.
	const removedOnExit = new Set();
	const peerIds = {};
	const run = async (args) => {
		calls.push(args);
		const key =
			args[0] === "run"
				? args.includes("sleep") ? "run" : args.includes(EPHEMERAL_SCRIPT) ? "ephemeral" : args.includes(PEER_SCRIPT) ? "peer" : "pin"
				: args[0] === "exec"
					? args.includes(STATUS_SCRIPT) ? "status" : args.includes(CONNECT_SCRIPT) ? (args[1] === peerIds.peer2 ? "control" : "connect") : "write"
					: args[0] === "ps"
						? args.includes("--no-trunc") ? "gone" : "ps"
						: args[0] === "network"
							? `network-${args[1]}`
							: args[0] === "inspect" && String(args[1]).includes("NetworkSettings")
								? "peer-inspect"
								: args[0];
		if (over[key]) return over[key](args);
		switch (key) {
			case "ephemeral": {
				// What EPHEMERAL_SCRIPT does on a daemon that holds: a fresh /tmp, so the nonce under the run's number.
				const ws = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : [])).find((v) => v.split(":")[1] === "/workspace").split(":")[0];
				writeFileSync(join(ws, `.pi-dispatch-live-ephemeral-${args.at(-1)}`), args.at(-2));
				ephemeralRuns++;
				const eid = String(ephemeralRuns).repeat(64);
				if (args.includes("--rm")) removedOnExit.add(eid);
				return { code: 0, stdout: `${eid}\n`, stderr: "" };
			}
			case "peer": {
				const name = args.find((a) => a.startsWith("--name=")).slice("--name=".length);
				const which = name.includes("-peer1-") ? "peer1" : "peer2";
				peerIds[which] = (which === "peer1" ? "b" : "c").repeat(64);
				return { code: 0, stdout: `${peerIds[which]}\n`, stderr: "" };
			}
			case "peer-inspect": {
				const net = `${calls.find((a) => a[0] === "run" && a.includes(PEER_SCRIPT) && a.some((x) => x.includes("-peer2-")))?.find((x) => x.startsWith("--network="))?.slice("--network=".length)}`;
				return { code: 0, stdout: JSON.stringify({ [net]: { IPAddress: "10.99.0.3", GlobalIPv6Address: "", DNSNames: ["pi-dispatch-live-peer2-4242-n0nce", "cccccccccccc"], Aliases: null } }), stderr: "" };
			}
			case "connect": {
				// A daemon that holds: the proxy accepts, the other job's names and addresses do not.
				const targets = args.slice(args.indexOf(CONNECT_SCRIPT) + 2);
				return { code: 0, stdout: targets.map((t) => `${t} ${t.startsWith("pi-dispatch-egress-proxy:") ? "connected" : t.startsWith("10.") ? "enetunreach" : "eai_again"}`).join("\n"), stderr: "" };
			}
			case "control": {
				const targets = args.slice(args.indexOf(CONNECT_SCRIPT) + 2);
				return { code: 0, stdout: targets.map((t) => `${t} reached`).join("\n"), stderr: "" };
			}
			case "gone": {
				const wanted = args.find((a) => a.startsWith("id=")).slice("id=".length);
				return { code: 0, stdout: removedOnExit.has(wanted) || !/^\d/.test(wanted) ? "" : `${wanted} exited\n`, stderr: "" };
			}
			case "ps":
				return { code: 0, stdout: "", stderr: "" };
			case "run":
				volumes = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
				return { code: 0, stdout: `${id}\n`, stderr: "" };
			case "inspect":
				return {
					code: 0,
					stdout: JSON.stringify(volumes.map((v) => {
						const [Source, Destination, mode] = v.split(":");
						return { Type: "bind", Source, Destination, RW: mode !== "ro" };
					})),
					stderr: "",
				};
			case "status":
				return { code: 0, stdout: HELD_STATUS, stderr: "" };
			case "write": {
				// What the constant script does on a host that holds: the nonce into every writable mount a job uses.
				for (const dest of ["/workspace", "/outbox", "/session"]) {
					const src = volumes.find((v) => v.split(":")[1] === dest).split(":")[0];
					writeFileSync(join(src, ".pi-dispatch-live-probe"), args.at(-1));
				}
				return { code: 0, stdout: "wrote\n", stderr: "" };
			}
			case "pin":
				return { code: 125, stdout: "", stderr: `docker: Error response from daemon: No such image: ${args.at(-1)}.\n` };
			case "image":
				return { code: 1, stdout: "", stderr: "" };
			case "rm":
				return { code: 0, stdout: `${args.at(-1)}\n`, stderr: "" };
			case "network-ls":
				return { code: 0, stdout: "", stderr: "" };
			case "network-create":
			case "network-connect":
			case "network-disconnect":
			case "network-rm":
				return { code: 0, stdout: "", stderr: "" };
			default:
				return { code: 1, stdout: "", stderr: "" };
		}
	};
	return { run, calls };
}

const LOCAL = { local: true, context: "desktop-linux", endpoint: "unix:///x.sock" };
const probeArgs = (docker, over = {}) => ({
	image: "pi-job:x",
	endpoint: LOCAL,
	dockerReachable: true,
	imagePresent: true,
	jobsDir: tempDir("pi-live-jobs-"),
	egress: { armed: false, results: [] },
	pid: 4242,
	nonce: "n0nce",
	run: docker.run,
	fs: nodeFs,
	isAlive: () => false,
	stepTimeoutMs: 1000,
	// A clock no test waits on: a mutant that leaves a container listed runs into the deadline at once, not in 10 s.
	...instant(),
	...over,
});

test("a green run reads back all eight, in the conformance list's order, and leaves nothing behind", async () => {
	const docker = fakeDocker();
	const args = probeArgs(docker);
	const result = await runLiveProbes(args);
	assert.equal(result.ran, true);
	assert.deepEqual(result.verdicts.map((v) => v.property), [...READ_BACK_BY_A_LIVE_PROBE]);
	assert.deepEqual(result.verdicts.filter((v) => !v.ok).map((v) => v.property), ["egress", "jobToJobIsolation"], "egress is off in this fixture, so it and the peer probe are unread");
	assert.ok(!docker.calls.some((a) => a[0] === "network" && a[1] !== "ls"), "and the policy off builds no network at all");
	assert.deepEqual(docker.calls.filter((a) => a[0] === "rm"), [["rm", "-f", ID], ["rm", "-f", "pi-dispatch-live-pin-4242-n0nce"]], "the probe BY THE ID run -d printed; the pin, which printed none, by its own pid-and-nonce name");
	assert.deepEqual(readdirSync(args.jobsDir), [], "the fixture is gone");
	assert.deepEqual(result.notes, []);
	const run = docker.calls.find((a) => a[0] === "run" && a.includes("sleep"));
	assert.equal(run.at(-1), String(liveSleepSeconds(1000)), "the argv the sequence builds ends in the sleep DERIVED from its own step bound");
});

test("the mutation is ANNOUNCED before the first docker call, and not at all when nothing will run", async () => {
	const order = [];
	const docker = fakeDocker();
	const run = async (args) => (order.push(`docker ${args[0]}`), docker.run(args));
	await runLiveProbes(probeArgs(docker, { run, announce: (line) => order.push(line) }));
	assert.match(order[0], /^starting pi-dispatch-live-probe-4242-n0nce, pi-dispatch-live-pin-4242-n0nce and pi-dispatch-live-ephemeral-4242-n0nce \(twice\) from pi-job:x .* all of them are removed/);
	assert.deepEqual(order.slice(1, 4), ["docker ps", "docker network", "docker run"], "announced before the sweeps' first docker calls and the probe's");
	const silent = [];
	await runLiveProbes(probeArgs(fakeDocker(), { endpoint: { local: false }, announce: (line) => silent.push(line) }));
	assert.deepEqual(silent, []);
});

test("a docker CLI not observed local runs NOTHING: no container, no fixture", async () => {
	for (const endpoint of [{ local: false }, { local: null }, undefined]) {
		const docker = fakeDocker();
		const args = probeArgs(docker, { endpoint });
		const result = await runLiveProbes(args);
		assert.equal(result.ran, false);
		assert.deepEqual(docker.calls, []);
		assert.deepEqual(readdirSync(args.jobsDir), []);
		assert.match(result.reason, /not observed to point at this host/);
	}
});

test("a probe container that never started removes nothing it did not create, and no pin runs", async () => {
	const docker = fakeDocker({ run: async () => ({ code: 125, stdout: "", stderr: "docker: Error response from daemon: No such image" }) });
	const args = probeArgs(docker);
	const result = await runLiveProbes(args);
	assert.equal(result.ran, false);
	assert.deepEqual(docker.calls.map((a) => a[0]), ["ps", "network", "run", "rm"], "the two sweeps' listings, then no inspect, no exec, no pin");
	assert.deepEqual(docker.calls.at(-1), ["rm", "-f", "pi-dispatch-live-probe-4242-n0nce"], "no ID came back, so its own pid-and-nonce name, in case the create landed");
	assert.deepEqual(readdirSync(args.jobsDir), []);
});

test("on a not-run path a removal that fails is still reported, beside the reason", async () => {
	const docker = fakeDocker({ run: async () => ({ code: 127, stdout: `${ID}\n`, stderr: "" }), rm: async () => ({ code: 1, stdout: "", stderr: "" }) });
	const result = await runLiveProbes(probeArgs(docker));
	assert.equal(result.ran, false);
	assert.match(result.reason, /did not start/);
	assert.match(result.notes.join("\n"), new RegExp(`docker rm -f ${ID}`), "the finally's note reaches the caller on this path too");
});

test("a start that printed an ID and then failed or timed out is removed BY THAT ID, whether or not the daemon already did", async () => {
	for (const code of [127, null]) {
		const docker = fakeDocker({ run: async () => ({ code, stdout: `${ID}\n`, stderr: "" }) });
		const result = await runLiveProbes(probeArgs(docker));
		assert.equal(result.ran, false);
		assert.deepEqual(docker.calls.filter((a) => a[0] === "rm"), [["rm", "-f", ID]], `exit ${code}`);
	}
});

test("a fixture that cannot be created is a reason not to run, never an exception, and a half-made one is removed", async () => {
	const docker = fakeDocker();
	for (const [name, fs] of [
		["mkdtemp", { ...nodeFs, mkdtempSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }],
		["realpath", { ...nodeFs, realpathSync: () => { throw Object.assign(new Error("ELOOP"), { code: "ELOOP" }); } }],
	]) {
		const args = probeArgs(docker, { fs });
		const result = await runLiveProbes(args);
		assert.equal(result.ran, false, name);
		assert.match(result.reason, /fixture could not be created .*\((EACCES|ELOOP)\)/);
		assert.deepEqual(readdirSync(args.jobsDir), [], `${name}: nothing mkdtemp made is left behind`);
	}
	// A fixture whose removal then fails is still reported on this not-run path: the notes are the ones the finally fills.
	const stuck = { ...nodeFs, realpathSync: () => { throw Object.assign(new Error("ELOOP"), { code: "ELOOP" }); }, rmSync: () => { throw new Error("EBUSY"); } };
	const stuckResult = await runLiveProbes(probeArgs(fakeDocker(), { fs: stuck }));
	assert.equal(stuckResult.ran, false);
	assert.match(stuckResult.notes.join("\n"), /the fixture .* could not be removed/);
	assert.ok(!docker.calls.some((a) => a[0] === "run"), "no container");
	const empty = await runLiveProbes(probeArgs(fakeDocker(), { jobsDir: "" }));
	assert.equal(empty.ran, false, 'PI_JOBS_DIR="" is a note, not a crash');
});

test("the endpoint is asked AGAIN before the first command, and a context switched since the collection runs nothing", async () => {
	const docker = fakeDocker();
	const announced = [];
	const result = await runLiveProbes(probeArgs(docker, { resolveEndpoint: async () => ({ local: false }), announce: (l) => announced.push(l) }));
	assert.equal(result.ran, false);
	assert.deepEqual(docker.calls, []);
	assert.deepEqual(announced, []);
	const unresolved = fakeDocker();
	assert.equal((await runLiveProbes(probeArgs(unresolved, { resolveEndpoint: async () => ({ local: null, reason: "timeout" }) }))).ran, false, "an unanswered re-read is not local either");
	assert.deepEqual(unresolved.calls, []);
	assert.equal((await runLiveProbes(probeArgs(fakeDocker(), { resolveEndpoint: async () => LOCAL }))).ran, true);
});

test("teardown by ID runs in finally when a step times out or the container vanishes mid-read", async () => {
	for (const over of [{ status: async () => ({ code: null, stdout: "", stderr: "" }) }, { write: async () => ({ code: 1, stdout: "", stderr: "Error: No such container" }) }]) {
		const docker = fakeDocker(over);
		const args = probeArgs(docker);
		const result = await runLiveProbes(args);
		assert.equal(result.ran, true);
		assert.ok(result.verdicts.some((v) => v.warn), "an unread step is not read back, never a failure or a pass");
		assert.ok(docker.calls.some((a) => a[0] === "rm" && a[2] === ID));
		assert.deepEqual(readdirSync(args.jobsDir), []);
	}
});

test("a thrown step still removes the container and the fixture", async () => {
	const docker = fakeDocker({
		inspect: async () => {
			throw new Error("spawn EMFILE");
		},
	});
	const args = probeArgs(docker);
	await assert.rejects(() => runLiveProbes(args), /EMFILE/);
	assert.ok(docker.calls.some((a) => a[0] === "rm" && a[2] === ID));
	assert.deepEqual(readdirSync(args.jobsDir), []);
});

test("two concurrent runs never remove each other's container or fixture", async () => {
	const jobsDir = tempDir("pi-live-jobs-");
	const a = fakeDocker({}, { id: "a".repeat(64) });
	const b = fakeDocker({}, { id: "b".repeat(64) });
	await Promise.all([
		runLiveProbes(probeArgs(a, { jobsDir, pid: 1, nonce: "x", isAlive: () => true })),
		runLiveProbes(probeArgs(b, { jobsDir, pid: 2, nonce: "y", isAlive: () => true })),
	]);
	assert.deepEqual(a.calls.filter((c) => c[0] === "rm").map((c) => c[2]), ["a".repeat(64), "pi-dispatch-live-pin-1-x"]);
	assert.deepEqual(b.calls.filter((c) => c[0] === "rm").map((c) => c[2]), ["b".repeat(64), "pi-dispatch-live-pin-2-y"]);
	assert.ok(a.calls.find((c) => c[0] === "run").some((x) => x === "--name=pi-dispatch-live-probe-1-x"));
});

test("a container that could not be removed is said, with the command", async () => {
	const docker = fakeDocker({ rm: async () => ({ code: 1, stdout: "", stderr: "" }) });
	const result = await runLiveProbes(probeArgs(docker));
	assert.match(result.notes[0], new RegExp(`docker rm -f ${ID}`));
});

test("a pinning container that WAS created is removed by its own ID and pinning fails", async () => {
	const pinId = "c".repeat(64);
	const docker = fakeDocker({ pin: async () => ({ code: 0, stdout: `${pinId}\n`, stderr: "" }) });
	const result = await runLiveProbes(probeArgs(docker));
	assert.equal(result.verdicts.find((v) => v.property === "imagePinning").ok, false);
	assert.deepEqual(docker.calls.filter((a) => a[0] === "rm").map((a) => a[2]), [ID, pinId]);
});

test("the stale-fixture sweep removes only a dead PID's fixture of mkdtemp's exact shape, never a live run's, its own, or a lookalike", () => {
	const jobsDir = tempDir("pi-live-sweep-");
	const target = tempDir("pi-live-sweep-target-");
	writeFileSync(join(target, "keep.txt"), "x");
	for (const d of [`${LIVE_PREFIX}100-aB3xYz`, `${LIVE_PREFIX}200-bbbbbb`, `${LIVE_PREFIX}300-cccccc`, `${LIVE_PREFIX}98765-notes`, "some-job-dir"]) mkdirSync(join(jobsDir, d));
	writeFileSync(join(jobsDir, `${LIVE_PREFIX}101-fil3ab`), "a file, not a fixture");
	symlinkSync(target, join(jobsDir, `${LIVE_PREFIX}102-l1nkab`));
	const swept = sweepStaleFixtures({ jobsDir, pid: 300, fs: nodeFs, isAlive: (p) => p === 200 });
	assert.deepEqual(swept, [`fixture ${LIVE_PREFIX}100-aB3xYz`]);
	assert.deepEqual(readdirSync(jobsDir).sort(), [`${LIVE_PREFIX}101-fil3ab`, `${LIVE_PREFIX}102-l1nkab`, `${LIVE_PREFIX}200-bbbbbb`, `${LIVE_PREFIX}300-cccccc`, `${LIVE_PREFIX}98765-notes`, "some-job-dir"]);
	assert.ok(existsSync(join(target, "keep.txt")), "a symlink's target is never touched");
	assert.deepEqual(sweepStaleFixtures({ jobsDir: join(jobsDir, "absent"), pid: 1, fs: nodeFs, isAlive: () => false }), [], "an unreadable dir sweeps nothing and does not throw");
});

test("the container sweep removes a probe or pin a DEAD pid left, by ID, and says so; never a live run's, its own, or another name", async () => {
	const calls = [];
	const listing = [
		`${"1".repeat(12)} pi-dispatch-live-probe-100-abc123`,
		`${"2".repeat(12)} pi-dispatch-live-pin-100-abc123`,
		`${"3".repeat(12)} pi-dispatch-live-probe-200-def456`,
		`${"4".repeat(12)} pi-dispatch-live-probe-300-aaa111`,
		`${"5".repeat(12)} pi-dispatch-live-probe-100-notes`,
		`${"6".repeat(12)} pi-job-pi-dispatch-live-probe-100-abc123`,
	].join("\n");
	const step = async (args) => (calls.push(args), args[0] === "ps" ? { code: 0, stdout: listing } : { code: 0, stdout: "" });
	const swept = await sweepStaleContainers({ step, pid: 300, isAlive: (p) => p === 200 });
	assert.deepEqual(swept, ["container pi-dispatch-live-probe-100-abc123", "container pi-dispatch-live-pin-100-abc123"]);
	assert.deepEqual(calls.filter((a) => a[0] === "rm").map((a) => a[2]), ["1".repeat(12), "2".repeat(12)]);
	assert.deepEqual(await sweepStaleContainers({ step: async () => ({ code: 1, stdout: "" }), pid: 1, isAlive: () => false }), [], "a docker that cannot list sweeps nothing");
	const refusing = async (args) => (args[0] === "ps" ? { code: 0, stdout: listing } : { code: 1, stdout: "" });
	assert.deepEqual(await sweepStaleContainers({ step: refusing, pid: 300, isAlive: () => false }), [], "a removal that failed is not reported as done");
});

test("the fixture is created under jobsDir, resolved, EMPTY, and in a job's own modes: 0700 job and session dirs (#341)", async () => {
	const docker = fakeDocker();
	const chmods = [];
	const made = new Map();
	const fs = {
		...nodeFs,
		chmodSync: (p, m) => (chmods.push([p, m]), chmodSync(p, m)),
		mkdirSync: (p, o) => {
			const r = mkdirSync(p, o);
			if (p.includes("pi-dispatch-live-4242-")) made.set(p.split("/").at(-1), { mode: statSync(p).mode & 0o777, entries: readdirSync(p).length });
			return r;
		},
	};
	const args = probeArgs(docker, { fs });
	await runLiveProbes(args);
	assert.deepEqual(chmods, [], "no chmod widens a mode: a probe in friendlier modes than a job passed on hosts where every job failed");
	assert.deepEqual([...made.keys()].sort(), ["global", "job", "outbox", "session", "workspace"]);
	for (const dir of ["job", "session"]) assert.equal(made.get(dir).mode, 0o700, `${dir} is 0700, as prepare's mkdtemp and the session store make it`);
	for (const [dir, { entries }] of made) assert.equal(entries, 0, `${dir} is created empty (CONST-ISOLATION-CONTAINER-PER-JOB)`);
	const runArgs = docker.calls.find((a) => a[0] === "run" && a.includes("sleep"));
	const jobMount = runArgs.find((a) => a.endsWith(":/job:ro"));
	assert.ok(jobMount.startsWith(realpathSync(args.jobsDir)), "under the worker's own jobs dir, realpath'd");
	assert.equal(existsSync(jobMount.split(":")[0]), false, "and removed");
});

test("a live run passes the job user into both probes, checks the host owner, and says what uid PID 1 ran as (#341)", async () => {
	const docker = fakeDocker();
	const args = probeArgs(docker, { user: "1234:1234", euid: process.geteuid?.() ?? 0 });
	const result = await runLiveProbes(args);
	assert.equal(result.ran, true);
	assert.ok(docker.calls.filter((a) => a[0] === "run").every((a) => a.includes("--user=1234:1234")), "the reading probe and the pinning probe alike");
	assert.equal(result.ranAs, 1001, "read from PID 1's Uid line, not assumed from the decision");
	assert.equal(result.verdicts.find((v) => v.property === "localFolders").ok, true, "this shell wrote the fake's nonce, so the owner is this shell's");

	const other = fakeDocker();
	const theirs = await runLiveProbes(probeArgs(other, { euid: 999_999, fs: { ...nodeFs, statSync: () => ({ uid: 1001 }) } }));
	assert.equal(theirs.verdicts.find((v) => v.property === "localFolders").cause, "not-yours");

	// The outbox and session writes are read back too: a container that said "wrote" without landing one is not visible.
	const partial = fakeDocker({
		write: (args) => {
			const runArgs = partial.calls.find((a) => a[0] === "run" && a.includes("sleep"));
			const ws = runArgs.find((a) => a.endsWith(":/workspace")).split(":")[0];
			writeFileSync(join(ws, ".pi-dispatch-live-probe"), args.at(-1));
			return { code: 0, stdout: "wrote\n", stderr: "" };
		},
	});
	const missing = await runLiveProbes(probeArgs(partial));
	assert.equal(missing.verdicts.find((v) => v.property === "localFolders").cause, "not-visible");
	for (const skipped of ["/outbox", "/session"]) {
		const one = fakeDocker({
			write: (args) => {
				const runArgs = one.calls.find((a) => a[0] === "run" && a.includes("sleep"));
				for (const dest of ["/workspace", "/outbox", "/session"].filter((d) => d !== skipped)) {
					writeFileSync(join(runArgs.find((a) => a.endsWith(`:${dest}`)).split(":")[0], ".pi-dispatch-live-probe"), args.at(-1));
				}
				return { code: 0, stdout: "wrote\n", stderr: "" };
			},
		});
		const v = (await runLiveProbes(probeArgs(one))).verdicts.find((x) => x.property === "localFolders");
		assert.equal(v.cause, "not-visible", skipped);
		assert.match(v.detail, new RegExp(`inside ${skipped} is not visible`), `${skipped}: the failure names the mount`);
	}
});

// --- issue #344: ephemeral and jobToJobIsolation ----------------------------------------------------------------

const LIVE_EGRESS = { armed: true, results: [], proxy: "pi-dispatch-egress-proxy", proxyRunning: true };
const instant = () => {
	let t = 0;
	return { now: () => t, delay: async (ms) => (t += ms) };
};

test("the ephemeral and peer argv are the job builder's: every isolation flag, the job user, no environment", () => {
	const ephemeral = ephemeralRunArgs({ image: "pi-job:x", name: "pi-dispatch-live-ephemeral-1-n", fixture: FIXTURE, nonce: "n", run: 2, user: "1234:1234" });
	const peer = peerRunArgs({ image: "pi-job:x", name: "pi-dispatch-live-peer1-1-n", fixture: FIXTURE, network: "pi-dispatch-live-peer1-1-n-net", nonce: "n", seconds: 90, user: "1234:1234" });
	for (const args of [ephemeral, peer]) {
		for (const flag of ISOLATION_FLAGS) assert.ok(args.includes(flag), flag);
		assert.ok(args.includes("--user=1234:1234"));
		assert.equal(args.includes("-e"), false, "an EMPTY environment, as every live-probe container");
	}
	assert.deepEqual(ephemeral.slice(-6), ["pi-job:x", "-c", EPHEMERAL_SCRIPT, "sh", "n", "2"]);
	assert.ok(ephemeral.includes("--entrypoint") && ephemeral[ephemeral.indexOf("--entrypoint") + 1] === "sh");
	assert.ok(peer.includes("--network=pi-dispatch-live-peer1-1-n-net"), "its own job network, as a job with egress armed");
	assert.ok(!peer.includes("--network=none"));
	assert.deepEqual(peer.slice(-6), ["pi-job:x", "--eval", PEER_SCRIPT, "n", String(PEER_PORT), "90"]);
	for (const script of [EPHEMERAL_SCRIPT, PEER_SCRIPT, CONNECT_SCRIPT]) assert.ok(!script.includes("${"), "constant: no host value in the text");
	assert.deepEqual([...LIVE_CONTAINER_KINDS], ["probe", "pin", "ephemeral", "peer1", "peer2"]);
});

test("ephemeralVerdict: a survivor, a held name, a reused container or residue fails; anything unfinished is not read back", () => {
	const gone = (ms = 40) => ({ state: "gone", ms });
	const ok = { started: true, id: "a".repeat(64), removal: gone() };
	const next = { started: true, id: "b".repeat(64), removal: gone(60) };
	const markers = { first: "n", second: "n" };
	const v = (over) => ephemeralVerdict({ first: ok, second: next, markers, nonce: "n", ...over });
	assert.equal(v({}).ok, true);
	assert.match(v({}).detail, /in 40 ms and 60 ms/);
	for (const [label, over, cause] of [
		["first survived", { first: { ...ok, removal: { state: "exited", ms: 10_000 } }, second: null }, "survived"],
		["name held", { second: { started: false, id: null, nameHeld: true, removal: null } }, "name-held"],
		["reused", { second: { ...next, id: ok.id } }, "reused"],
		["residue", { markers: { first: "n", second: "residue" } }, "residue"],
		["second survived", { second: { ...next, removal: { state: "exited", ms: 10_000 } } }, "survived"],
	]) {
		const got = v(over);
		assert.deepEqual([got.ok, got.warn, got.cause], [false, undefined, cause], label);
	}
	for (const [label, over] of [
		["first did not start", { first: { started: false, id: null, removal: null }, second: null }],
		["first still running", { first: { ...ok, removal: { state: "present", ms: 10_000 } }, second: null }],
		["ps unanswered", { second: { ...next, removal: { state: "unanswered", ms: 1 } } }],
		["second did not start", { second: { started: false, id: null, nameHeld: false, removal: null } }],
		["marker missing", { markers: { first: "n", second: null } }],
	]) {
		assert.equal(v(over).warn, true, label);
	}
	// A first run still running is not a held name: the second conflicts with a container that is merely slow.
	assert.equal(v({ first: { ...ok, removal: { state: "present", ms: 10_000 } }, second: { started: false, id: null, nameHeld: true, removal: null } }).warn, true);
});

test("jobToJobIsolationVerdict: a peer reached fails before any missing reading; an unproven block is not read back", () => {
	const peerTargets = ["pi-dispatch-live-peer2-1-n:47431", "10.99.0.3:47431"];
	const base = { armed: true, proxyRunning: true, networksCreated: true, peersStarted: true, proxyTarget: "pi-dispatch-egress-proxy:3128", peerTargets, peerAddresses: ["10.99.0.3:47431"] };
	const fromPeer1 = (over = {}) => new Map([["pi-dispatch-egress-proxy:3128", "connected"], ["pi-dispatch-live-peer2-1-n:47431", "eai_again"], ["10.99.0.3:47431", "enetunreach"], ...Object.entries(over)]);
	const answered = new Map([["10.99.0.3:47431", "reached"]]);
	const held = jobToJobIsolationVerdict({ ...base, fromPeer1: fromPeer1(), controlBefore: answered, controlAfter: answered });
	assert.equal(held.ok, true);
	assert.match(held.detail, /none of peer2's 2 name\(s\) and address\(es\).*answered itself before and after/);
	// A reach fails with NOTHING else there: no controls, no proxy line, not even an address list.
	for (const bare of [{ fromPeer1: new Map([["10.99.0.3:47431", "reached"]]) }, { fromPeer1: new Map([["10.99.0.3:47431", "reached"], ["pi-dispatch-egress-proxy:3128", "timeout"]]), peerAddresses: [] }]) {
		const reached = jobToJobIsolationVerdict({ ...base, ...bare });
		assert.deepEqual([reached.ok, reached.warn, reached.cause], [false, undefined, "reached"], JSON.stringify([...bare.fromPeer1]));
	}
	for (const [label, over] of [
		["policy off", { armed: false }],
		["policy unreadable", { armed: null }],
		["proxy down", { proxyRunning: false }],
		["no networks", { networksCreated: false }],
		["no peers", { peersStarted: false }],
		["names only, no address", { peerAddresses: [], peerTargets: ["pi-dispatch-live-peer2-1-n:47431"], fromPeer1: fromPeer1(), controlBefore: answered, controlAfter: answered }],
		["proxy unreached", { fromPeer1: fromPeer1({ "pi-dispatch-egress-proxy:3128": "timeout" }), controlBefore: answered, controlAfter: answered }],
		["a line missing", { fromPeer1: new Map([["pi-dispatch-egress-proxy:3128", "connected"]]), controlBefore: answered, controlAfter: answered }],
		["listener not up before the attempt", { fromPeer1: fromPeer1({ "10.99.0.3:47431": "econnrefused" }), controlBefore: new Map([["10.99.0.3:47431", "econnrefused"]]), controlAfter: answered }],
		["no control before", { fromPeer1: fromPeer1(), controlBefore: new Map(), controlAfter: answered }],
		["listener gone after", { fromPeer1: fromPeer1(), controlBefore: answered, controlAfter: new Map() }],
		["accepted without the nonce", { fromPeer1: fromPeer1({ "10.99.0.3:47431": "connected" }), controlBefore: answered, controlAfter: answered }],
	]) {
		const got = jobToJobIsolationVerdict({ ...base, ...over });
		assert.deepEqual([got.ok, got.warn], [false, true], label);
	}
	assert.match(jobToJobIsolationVerdict({ ...base, armed: null }).detail, /PI_EGRESS could not be read/, "a malformed PI_EGRESS is not reported as off");
});

test("parseConnectResults and peerTargetsOf read what the scripts and inspect print, and nothing else", () => {
	assert.deepEqual([...parseConnectResults("a:1 reached\n[fd00::3]:47431 enetunreach\n\ngarbage\nb:2 \u001b[31mreached\nc:3 Reached\n")], [["a:1", "reached"], ["[fd00::3]:47431", "enetunreach"]], "a result that is not a plain lower-case word is dropped");
	const inspect = JSON.stringify({ net: { IPAddress: "10.99.0.3", GlobalIPv6Address: "fd00::3", DNSNames: ["peer2", "35b76264799a"], Aliases: ["alias"] }, other: { IPAddress: "172.17.0.2" } });
	assert.deepEqual(peerTargetsOf(inspect, { network: "net", name: "peer2" }), {
		targets: ["peer2:47431", "35b76264799a:47431", "alias:47431", "10.99.0.3:47431", "[fd00::3]:47431"],
		addresses: ["10.99.0.3:47431", "[fd00::3]:47431"],
	}, "addresses come from the address FIELDS: a short ID that starts with a digit is still a name");
	assert.deepEqual(peerTargetsOf(JSON.stringify({ net: { IPAddress: "", GlobalIPv6Address: "", DNSNames: ["peer2"] } }), { network: "net", name: "peer2" }), { targets: ["peer2:47431"], addresses: [] });
	assert.deepEqual(peerTargetsOf(inspect, { network: "missing", name: "p" }), { targets: [], addresses: [] });
	assert.deepEqual(peerTargetsOf("not json", { network: "net", name: "p" }), { targets: [], addresses: [] });
});

test("awaitRemoved polls until the container is gone, and gives up at the deadline without a real clock", async () => {
	const clock = instant();
	let polls = 0;
	const present = async () => (polls++, { code: 0, stdout: `${"a".repeat(64)} running\n` });
	assert.deepEqual(await awaitRemoved({ step: present, id: "a".repeat(64), ...clock, deadlineMs: 1000, pollMs: 100 }), { state: "present", ms: 1000 });
	assert.equal(polls, 11, "bounded by the deadline, not by the daemon");
	const exited = async () => ({ code: 0, stdout: `${"a".repeat(64)} exited\n` });
	assert.equal((await awaitRemoved({ step: exited, id: "a".repeat(64), ...instant(), deadlineMs: 1000 })).state, "exited");
	let answers = [`${"a".repeat(64)} removing\n`, ""];
	const soon = async () => ({ code: 0, stdout: answers.shift() });
	assert.deepEqual(await awaitRemoved({ step: soon, id: "a".repeat(64), ...instant(), pollMs: 100 }), { state: "gone", ms: 100 });
	assert.equal((await awaitRemoved({ step: async () => ({ code: 1, stdout: "" }), id: "a", ...instant() })).state, "unanswered");
	assert.equal(LIVE_REMOVAL_DEADLINE_MS, 10_000);
});

test("ephemeral: two runs under one name, each seen gone and never removed again; a container without --rm is a survivor", async () => {
	const docker = fakeDocker();
	const result = await runLiveProbes(probeArgs(docker, { ...instant() }));
	const eph = result.verdicts.find((v) => v.property === "ephemeral");
	assert.equal(eph.ok, true, eph.detail);
	const runs = docker.calls.filter((a) => a[0] === "run" && a.includes(EPHEMERAL_SCRIPT));
	assert.equal(runs.length, 2);
	assert.equal(new Set(runs.map((a) => a.find((x) => x.startsWith("--name=")))).size, 1, "the same name both times");
	assert.ok(!docker.calls.some((a) => a[0] === "rm" && /^[12]+$/.test(a[2])), "a container seen gone is never rm -f'd");

	const noRm = fakeDocker({
		ephemeral: async (args) => {
			const ws = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : [])).find((v) => v.split(":")[1] === "/workspace").split(":")[0];
			writeFileSync(join(ws, `.pi-dispatch-live-ephemeral-${args.at(-1)}`), args.at(-2));
			return { code: 0, stdout: `${"7".repeat(64)}\n`, stderr: "" };
		},
	});
	const kept = await runLiveProbes(probeArgs(noRm, { ...instant() }));
	const survived = kept.verdicts.find((v) => v.property === "ephemeral");
	assert.equal(survived.cause, "survived");
	assert.ok(noRm.calls.some((a) => a[0] === "rm" && a[2] === "7".repeat(64)), "a survivor is removed by its ID");
	assert.equal(noRm.calls.filter((a) => a[0] === "run" && a.includes(EPHEMERAL_SCRIPT)).length, 1, "no second run into a name the first still holds");
	const armed = fakeDocker({ ephemeral: async () => ({ code: 0, stdout: `${"7".repeat(64)}\n`, stderr: "" }) });
	await runLiveProbes(probeArgs(armed, { egress: LIVE_EGRESS }));
	const survivorGone = armed.calls.findIndex((a) => a[0] === "rm" && a[2] === "7".repeat(64));
	assert.ok(survivorGone > 0 && survivorGone < armed.calls.findIndex((a) => a[0] === "network" && a[1] === "create"), "and removed in its own phase, before the peers' networks exist");
});

test("jobToJobIsolation, armed: two job networks, two peers, a control before and after the attempt, then peers BEFORE networks", async () => {
	const docker = fakeDocker();
	const args = probeArgs(docker, { egress: LIVE_EGRESS, ...instant() });
	const result = await runLiveProbes(args);
	const j2j = result.verdicts.find((v) => v.property === "jobToJobIsolation");
	assert.equal(j2j.ok, true, j2j.detail);
	const creates = docker.calls.filter((a) => a[0] === "network" && a[1] === "create");
	assert.deepEqual(creates, [["network", "create", "--internal", "pi-dispatch-live-peer1-4242-n0nce-net"], ["network", "create", "--internal", "pi-dispatch-live-peer2-4242-n0nce-net"]]);
	assert.ok(docker.calls.some((a) => a.join(" ") === "network connect pi-dispatch-live-peer1-4242-n0nce-net pi-dispatch-egress-proxy"));
	const execs = docker.calls.filter((a) => a[0] === "exec" && a.includes(CONNECT_SCRIPT));
	assert.deepEqual(execs.map((a) => a[1]), ["c".repeat(64), "b".repeat(64), "c".repeat(64)], "peer2's control, peer1's attempt, peer2's control again");
	const argvOf = (a) => a.slice(a.indexOf(CONNECT_SCRIPT) + 1);
	assert.deepEqual(argvOf(execs[1]), ["n0nce", "pi-dispatch-egress-proxy:3128", "pi-dispatch-live-peer2-4242-n0nce:47431", "cccccccccccc:47431", "10.99.0.3:47431"]);
	for (const control of [execs[0], execs[2]]) assert.deepEqual(argvOf(control), ["n0nce", "10.99.0.3:47431"], "the control tries peer2's own ADDRESSES, never a name");
	const peerRuns = docker.calls.filter((a) => a[0] === "run" && a.includes(PEER_SCRIPT));
	assert.deepEqual(peerRuns.map((a) => a.filter((x) => x.startsWith("--network"))), [["--network=pi-dispatch-live-peer1-4242-n0nce-net"], ["--network=pi-dispatch-live-peer2-4242-n0nce-net"]], "each peer's ONLY network is its own");
	const at = (pred) => docker.calls.findIndex(pred);
	const peersGone = Math.max(at((a) => a[0] === "rm" && a[2] === "b".repeat(64)), at((a) => a[0] === "rm" && a[2] === "c".repeat(64)));
	const firstNetworkRm = at((a) => a[0] === "network" && a[1] === "rm");
	assert.ok(peersGone > 0 && firstNetworkRm > peersGone, "peers are removed before their networks");
	assert.ok(docker.calls.filter((a) => a[0] === "network" && a[1] === "rm").every((a) => !a.includes("-f")), "never network rm -f");
	assert.deepEqual(readdirSync(args.jobsDir), []);
	assert.deepEqual(result.notes, []);
	for (const name of [...Object.values(liveNames(4242, "n0nce")), "pi-dispatch-live-peer1-4242-n0nce-net", "pi-dispatch-live-peer2-4242-n0nce-net"]) {
		assert.ok(!name.includes(JOB_NAME_PREFIX) && !name.includes("pi-sandbox-"), `${name} sits outside the job and sandbox reapers' names`);
	}
});

test("jobToJobIsolation: a reach fails; the policy off or the proxy down builds no network; a half-built phase is torn down", async () => {
	const reaching = fakeDocker({ connect: async (a) => ({ code: 0, stdout: a.slice(a.indexOf(CONNECT_SCRIPT) + 2).map((t) => `${t} ${t.startsWith("10.") ? "reached" : "connected"}`).join("\n") }) });
	const reached = (await runLiveProbes(probeArgs(reaching, { egress: LIVE_EGRESS, ...instant() }))).verdicts.find((v) => v.property === "jobToJobIsolation");
	assert.deepEqual([reached.ok, reached.cause], [false, "reached"]);

	for (const egress of [{ armed: false, results: [] }, { ...LIVE_EGRESS, proxyRunning: false }]) {
		const docker = fakeDocker();
		await runLiveProbes(probeArgs(docker, { egress, ...instant() }));
		assert.deepEqual(docker.calls.filter((a) => a[0] === "network").map((a) => a[1]), ["ls"], `only the sweep's listing: ${JSON.stringify(egress)}`);
		assert.ok(!docker.calls.some((a) => a.includes(PEER_SCRIPT)));
	}

	const half = fakeDocker({ peer: async (a) => (a.some((x) => x.includes("-peer2-")) ? { code: 125, stdout: "", stderr: "" } : { code: 0, stdout: `${"b".repeat(64)}\n`, stderr: "" }) });
	const args = probeArgs(half, { egress: LIVE_EGRESS, ...instant() });
	const partial = await runLiveProbes(args);
	assert.equal(partial.verdicts.find((v) => v.property === "jobToJobIsolation").warn, true);
	assert.ok(half.calls.some((a) => a[0] === "rm" && a[2] === "b".repeat(64)), "peer1 removed by ID");
	assert.equal(half.calls.filter((a) => a[0] === "network" && a[1] === "rm").length, 2, "both networks removed");
	assert.deepEqual(readdirSync(args.jobsDir), []);

	const noNet = fakeDocker({ "network-create": async (a) => ({ code: a[3].includes("peer2") ? 1 : 0, stdout: "" }) });
	const noNetResult = await runLiveProbes(probeArgs(noNet, { egress: LIVE_EGRESS, ...instant() }));
	assert.equal(noNetResult.verdicts.find((v) => v.property === "jobToJobIsolation").warn, true);
	assert.ok(!noNet.calls.some((a) => a.includes(PEER_SCRIPT)), "no peer runs without both networks");
	assert.ok(noNet.calls.some((a) => a.join(" ") === "network rm pi-dispatch-live-peer1-4242-n0nce-net"), "the network that was made is removed");
});

test("sweepStaleNetworks removes only a dead run's peer networks: never one a probe container is on, never with -f, and says when one stays", async () => {
	const calls = [];
	const listing = [
		"pi-dispatch-live-peer1-100-abc123-net",
		"pi-dispatch-live-peer2-100-abc123-net",
		"pi-dispatch-live-peer1-200-def456-net",
		"pi-dispatch-live-peer1-300-aaa111-net",
		"pi-job-x-net",
		"pi-dispatch-live-probe-100-abc123-net",
		"pi-dispatch-live-peer2-400-bbb222-net",
	].join("\n");
	const attached = {
		"pi-dispatch-live-peer1-100-abc123-net": { e1: { Name: "an-old-proxy-name" } },
		"pi-dispatch-live-peer2-100-abc123-net": {},
		// A PID from another namespace reads as dead here; its peer still on the network says the run is not over.
		"pi-dispatch-live-peer2-400-bbb222-net": { e2: { Name: "pi-dispatch-live-peer2-400-bbb222" }, e3: { Name: "pi-dispatch-egress-proxy" } },
	};
	const step = async (args) => {
		calls.push(args);
		if (args[1] === "ls") return { code: 0, stdout: listing };
		if (args[1] === "inspect") return { code: 0, stdout: JSON.stringify(attached[args.at(-1)] ?? {}) };
		return { code: 0, stdout: "" };
	};
	const notes = [];
	const swept = await sweepStaleNetworks({ step, pid: 300, isAlive: (p) => p === 200, notes });
	assert.deepEqual(swept, ["network pi-dispatch-live-peer1-100-abc123-net", "network pi-dispatch-live-peer2-100-abc123-net"]);
	assert.deepEqual(calls.filter((a) => a[1] === "disconnect" || a[1] === "rm"), [
		["network", "disconnect", "-f", "pi-dispatch-live-peer1-100-abc123-net", "an-old-proxy-name"],
		["network", "rm", "pi-dispatch-live-peer1-100-abc123-net"],
		["network", "rm", "pi-dispatch-live-peer2-100-abc123-net"],
	], "whatever that run attached is detached, and a network a probe container is still on is not touched");
	assert.deepEqual(notes, []);
	const stays = async (args) => (args[1] === "ls" ? { code: 0, stdout: "pi-dispatch-live-peer1-100-abc123-net" } : args[1] === "inspect" ? { code: 0, stdout: "{}" } : { code: args[1] === "rm" ? 1 : 0, stdout: "" });
	const stayNotes = [];
	assert.deepEqual(await sweepStaleNetworks({ step: stays, pid: 300, isAlive: () => false, notes: stayNotes }), [], "a network that would not go is not reported as removed");
	assert.deepEqual(stayNotes, ["the stale network pi-dispatch-live-peer1-100-abc123-net could not be removed: docker network rm pi-dispatch-live-peer1-100-abc123-net"]);
	const unreadable = async (args) => (calls.push(args), args[1] === "ls" ? { code: 0, stdout: "pi-dispatch-live-peer1-100-abc123-net" } : { code: 1, stdout: "" });
	const before = calls.length;
	assert.deepEqual(await sweepStaleNetworks({ step: unreadable, pid: 300, isAlive: () => false }), []);
	assert.deepEqual(calls.slice(before).map((a) => a[1]), ["ls", "inspect"], "a network whose attachments cannot be read is left alone");
});

test("the container sweep matches every kind liveNames makes, and still only a dead run's", async () => {
	const calls = [];
	const listing = LIVE_CONTAINER_KINDS.map((k, i) => `${String(i + 1).repeat(12)} pi-dispatch-live-${k}-100-abc123`).join("\n");
	const step = async (args) => (calls.push(args), args[0] === "ps" ? { code: 0, stdout: listing } : { code: 0, stdout: "" });
	const swept = await sweepStaleContainers({ step, pid: 1, isAlive: () => false });
	assert.deepEqual(swept, LIVE_CONTAINER_KINDS.map((k) => `container pi-dispatch-live-${k}-100-abc123`));
	assert.deepEqual(await sweepStaleContainers({ step, pid: 1, isAlive: () => true }), []);
});

test("ephemeral: a held name is the daemon's own words; a second run that printed its ID and failed is not a held name (#344)", async () => {
	// The first run holds (gone at once, its marker written); the second answers as `second` says.
	const pair = (second) => {
		let runs = 0;
		const docker = fakeDocker({
			ephemeral: async (args) => {
				runs++;
				if (runs === 2) return second(args);
				const ws = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : [])).find((v) => v.split(":")[1] === "/workspace").split(":")[0];
				writeFileSync(join(ws, ".pi-dispatch-live-ephemeral-1"), args.at(-2));
				return { code: 0, stdout: `${"d".repeat(64)}\n`, stderr: "" };
			},
			gone: async (args) => ({ code: 0, stdout: args.includes(`id=${"f".repeat(64)}`) ? `${"f".repeat(64)} created\n` : "" }),
		});
		return docker;
	};
	const ephemeralOf = async (docker) => (await runLiveProbes(probeArgs(docker, { ...instant() }))).verdicts.find((v) => v.property === "ephemeral");
	const dockerSays = 'docker: Error response from daemon: Conflict. The container name "/pi-dispatch-live-ephemeral-4242-n0nce" is already in use by container "0123". You have to remove (or rename) that container to be able to reuse that name.';
	const podmanSays = 'Error: creating container storage: the container name "pi-dispatch-live-ephemeral-4242-n0nce" is already in use by 0123. You have to remove that container to be able to reuse that name: that name is already in use';
	for (const stderr of [dockerSays, podmanSays]) {
		assert.equal((await ephemeralOf(pair(async () => ({ code: 125, stdout: "", stderr })))).cause, "name-held", stderr.slice(0, 20));
	}
	const own = pair(async () => ({ code: 125, stdout: `${"f".repeat(64)}\n`, stderr: "Error: unable to start container: OCI runtime error" }));
	const ownVerdict = await ephemeralOf(own);
	assert.deepEqual([ownVerdict.ok, ownVerdict.warn], [false, true], "its own container failing to start is not a held name");
	assert.ok(own.calls.some((a) => a[0] === "rm" && a[2] === "f".repeat(64)), "and it is removed by the ID it printed");
	const refusedOtherwise = await ephemeralOf(pair(async () => ({ code: 125, stdout: "", stderr: "docker: Error response from daemon: No such image" })));
	assert.deepEqual([refusedOtherwise.ok, refusedOtherwise.warn], [false, true], "a refusal in other words is not read back");
});

test("awaitRemoved counts Podman's stopped as stopped, matches only the container it was given, and a stopped survivor fails (#344)", async () => {
	const id = "a".repeat(64);
	const stateAfterDeadline = async (state) => (await awaitRemoved({ step: async () => ({ code: 0, stdout: `${id} ${state}\n` }), id, ...instant(), deadlineMs: 300 })).state;
	for (const state of ["exited", "Exited", "dead", "stopped"]) assert.equal(await stateAfterDeadline(state), "exited", state);
	for (const state of ["running", "created", "removing", "paused", "stopping", ""]) assert.equal(await stateAfterDeadline(state), "present", state);
	assert.equal((await awaitRemoved({ step: async () => ({ code: 0, stdout: `${"b".repeat(64)} exited\n` }), id, ...instant() })).state, "gone", "another container's line is not this one");
	const stuck = fakeDocker({ gone: async (args) => ({ code: 0, stdout: `${args.find((a) => a.startsWith("id=")).slice(3)} stopped\n` }) });
	assert.equal((await runLiveProbes(probeArgs(stuck, { removalDeadlineMs: 300 }))).verdicts.find((v) => v.property === "ephemeral").cause, "survived");
	assert.equal(stuck.calls.filter((a) => a[0] === "ps" && a.includes("--no-trunc")).length, 4, "polled every 100 ms up to the deadline it was GIVEN, and no longer");
});

test("jobToJobIsolation: a listener not up yet cannot pass for a block, no address reads nothing, and the proxy is the configured one (#344)", async () => {
	const j2jOf = async (docker, egress = LIVE_EGRESS) => (await runLiveProbes(probeArgs(docker, { egress, ...instant() }))).verdicts.find((v) => v.property === "jobToJobIsolation");
	const answer = (a, word) => ({ code: 0, stdout: a.slice(a.indexOf(CONNECT_SCRIPT) + 2).map((t) => `${t} ${word(t)}`).join("\n") });
	// Isolation BROKEN and peer2 slow to listen: the attempt is refused at its address, and the listener is up only later.
	let controls = 0;
	const slow = fakeDocker({
		control: async (a) => (controls++, answer(a, () => (controls === 1 ? "econnrefused" : "reached"))),
		connect: async (a) => answer(a, (t) => (t.startsWith("10.") ? "econnrefused" : t.endsWith(":3128") ? "connected" : "eai_again")),
	});
	const late = await j2jOf(slow);
	assert.deepEqual([late.ok, late.warn], [false, true]);
	assert.match(late.detail, /before the attempt/);

	for (const [label, over] of [
		["inspect gave no address", { "peer-inspect": async () => ({ code: 0, stdout: JSON.stringify({ elsewhere: { IPAddress: "10.1.1.1" } }) }) }],
		["inspect failed", { "peer-inspect": async () => ({ code: 1, stdout: "" }) }],
		["the control never reached peer2", { control: async (a) => answer(a, () => "econnrefused") }],
		["the control printed nothing", { control: async () => ({ code: 0, stdout: "" }) }],
		["the control failed", { control: async () => ({ code: 1, stdout: "" }) }],
	]) {
		const docker = fakeDocker(over);
		const got = await j2jOf(docker);
		assert.deepEqual([got.ok, got.warn], [false, true], label);
	}
	const noAddress = fakeDocker({ "peer-inspect": async () => ({ code: 0, stdout: "{}" }) });
	await j2jOf(noAddress);
	assert.ok(!noAddress.calls.some((a) => a[0] === "exec" && a[1] === "c".repeat(64)), "with no address there is no control to run");

	const named = fakeDocker({ connect: async (a) => answer(a, (t) => (t.startsWith("my-proxy:") ? "connected" : "enetunreach")) });
	assert.equal((await j2jOf(named, { ...LIVE_EGRESS, proxy: "my-proxy" })).ok, true);
	for (const net of ["pi-dispatch-live-peer1-4242-n0nce-net", "pi-dispatch-live-peer2-4242-n0nce-net"]) {
		assert.ok(named.calls.some((a) => a.join(" ") === `network connect ${net} my-proxy`), `PI_EGRESS_PROXY's name is the one attached to ${net}`);
		assert.ok(named.calls.some((a) => a.join(" ") === `network disconnect -f ${net} my-proxy`), "and the one detached");
	}
	const attempt = named.calls.find((a) => a[0] === "exec" && a[1] === "b".repeat(64));
	assert.equal(attempt[attempt.indexOf(CONNECT_SCRIPT) + 2], "my-proxy:3128", "and the one tried");
});

test("a peer network that stays is a note, one that never landed is silent, and a throw mid-phase removes peers, networks and fixture (#344)", async () => {
	const stays = fakeDocker({ "network-rm": async () => ({ code: 1, stdout: "" }), "network-inspect": async () => ({ code: 0, stdout: "" }) });
	const stayed = await runLiveProbes(probeArgs(stays, { egress: LIVE_EGRESS, ...instant() }));
	assert.deepEqual(stayed.notes, ["peer1", "peer2"].map((k) => `the network pi-dispatch-live-${k}-4242-n0nce-net could not be removed: docker network rm pi-dispatch-live-${k}-4242-n0nce-net`));

	const neverLanded = fakeDocker({ "network-create": async () => ({ code: null, stdout: "" }), "network-rm": async () => ({ code: 1, stdout: "" }) });
	const quiet = await runLiveProbes(probeArgs(neverLanded, { egress: LIVE_EGRESS, ...instant() }));
	assert.deepEqual(quiet.notes, [], "a create that timed out and left nothing is not a leak to report");
	assert.ok(neverLanded.calls.some((a) => a.join(" ") === "network rm pi-dispatch-live-peer1-4242-n0nce-net"), "its removal is still tried: a create that timed out may have landed");
	assert.ok(!neverLanded.calls.some((a) => a.join(" ").includes("peer2-4242-n0nce-net")), "and the second network is never started");

	const throwing = fakeDocker({
		connect: async () => {
			throw new Error("spawn EMFILE");
		},
	});
	const args = probeArgs(throwing, { egress: LIVE_EGRESS, ...instant() });
	await assert.rejects(() => runLiveProbes(args), /EMFILE/);
	const at = (pred) => throwing.calls.findIndex(pred);
	const peer1Gone = at((a) => a[0] === "rm" && a[2] === "b".repeat(64));
	const peer2Gone = at((a) => a[0] === "rm" && a[2] === "c".repeat(64));
	assert.ok(peer1Gone > 0 && peer2Gone > 0, "both peers removed by ID");
	assert.deepEqual(throwing.calls.filter((a) => a[0] === "network" && a[1] === "rm").map((a) => a[2]), ["pi-dispatch-live-peer1-4242-n0nce-net", "pi-dispatch-live-peer2-4242-n0nce-net"]);
	assert.ok(at((a) => a[0] === "network" && a[1] === "rm") > Math.max(peer1Gone, peer2Gone), "then the networks");
	assert.deepEqual(readdirSync(args.jobsDir), [], "then the fixture");
});

test("the peer and connect scripts do what the verdicts read, run by this node on loopback (#344)", async () => {
	const { execFile, spawn } = await import("node:child_process");
	const net = await import("node:net");
	const listening = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
	const answering = net.createServer((s) => s.end("n0nce\n"));
	const silent = net.createServer(() => {});
	const [answerPort, silentPort] = [await listening(answering), await listening(silent)];
	// Port 1 for the refusal: nothing unprivileged can listen there, so no other test's socket can take it mid-run.
	const closedPort = 1;
	try {
		const out = await new Promise((resolve, reject) => execFile(process.execPath, ["--eval", CONNECT_SCRIPT, "n0nce", `127.0.0.1:${answerPort}`, `127.0.0.1:${silentPort}`, `127.0.0.1:${closedPort}`, "[::1]:x", "no-port"], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
		assert.deepEqual([...parseConnectResults(out)], [[`127.0.0.1:${answerPort}`, "reached"], [`127.0.0.1:${silentPort}`, "connected"], [`127.0.0.1:${closedPort}`, "econnrefused"], ["[::1]:x", "unparsed"], ["no-port", "unparsed"]]);
	} finally {
		answering.close();
		silent.close();
	}

	// A free port is found by binding and closing one, and on a loaded suite another socket can take it before the peer
	// binds (PEER_SCRIPT swallows that error by design and simply never answers). So a peer that has not answered
	// within its window is replaced on a fresh port, rather than waited on forever or failed on the first race.
	const answeredOn = async () => {
		const free = net.createServer();
		const port = await listening(free);
		await new Promise((resolve) => free.close(resolve));
		const peer = spawn(process.execPath, ["--eval", PEER_SCRIPT, "n0nce", String(port), "60"], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		peer.stderr.on("data", (d) => (stderr += d));
		const started = performance.now();
		try {
			let said = "";
			while (!said.includes("n0nce") && peer.exitCode === null && performance.now() - started < 15_000) {
				said = await new Promise((resolve) => {
					const s = net.connect({ host: "127.0.0.1", port });
					let data = "";
					// Bounded whichever way it goes, and paced when nothing came back, so a port something else took
					// neither hangs this loop nor spins it.
					const done = () => {
						s.destroy();
						setTimeout(() => resolve(data), data ? 0 : 100);
					};
					s.setTimeout(2000, done);
					s.on("data", (d) => (data += d));
					s.on("end", done);
					s.on("error", done);
				});
			}
			return { said, detail: `port ${port}, ${Math.round(performance.now() - started)} ms, peer exit ${peer.exitCode}, stderr ${JSON.stringify(stderr)}` };
		} finally {
			peer.kill();
		}
	};
	const attempts = [];
	for (let i = 0; i < 3 && !attempts.at(-1)?.said.includes("n0nce"); i++) attempts.push(await answeredOn());
	assert.equal(attempts.at(-1).said, "n0nce\n", `every connection is answered with the nonce (${attempts.map((a) => a.detail).join("; ")})`);
});

test("when the peer phase's own teardown throws, the outer finally still removes the other peer, THEN the networks, then the fixture (#344)", async () => {
	const docker = fakeDocker({
		rm: async (args) => {
			if (args[2] === "b".repeat(64)) throw new Error("spawn EMFILE");
			return { code: 0, stdout: `${args.at(-1)}\n`, stderr: "" };
		},
	});
	const args = probeArgs(docker, { egress: LIVE_EGRESS });
	await assert.rejects(() => runLiveProbes(args), /EMFILE/);
	const at = (pred) => docker.calls.findIndex(pred);
	const peer2Gone = at((a) => a[0] === "rm" && a[2] === "c".repeat(64));
	assert.ok(peer2Gone > 0, "peer2 removed by the outer finally");
	assert.deepEqual(docker.calls.filter((a) => a[0] === "network" && a[1] === "rm").map((a) => a[2]), ["pi-dispatch-live-peer1-4242-n0nce-net", "pi-dispatch-live-peer2-4242-n0nce-net"]);
	assert.ok(at((a) => a[0] === "network" && a[1] === "rm") > peer2Gone, "networks only after every container");
	assert.equal(docker.calls.filter((a) => a[0] === "rm" && a[2] === "b".repeat(64)).length, 1, "a removal already tried is not tried again");
	assert.deepEqual(readdirSync(args.jobsDir), []);
});
