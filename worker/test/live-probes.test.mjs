import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { READ_BACK_BY_A_LIVE_PROBE } from "../src/backend-conformance.mjs";
import { JOB_NAME_PREFIX } from "../src/backend-local.mjs";
import { ISOLATION_FLAGS } from "../src/docker-run.mjs";
import {
	LIVE_PREFIX,
	STATUS_SCRIPT,
	WRITE_SCRIPT,
	absentImageRef,
	containerIdOf,
	egressVerdict,
	expectedMemoryBytes,
	expectedPidsLimit,
	imagePinningVerdict,
	isolationVerdict,
	liveFixture,
	liveNames,
	liveProbeRunArgs,
	liveSleepSeconds,
	localFoldersVerdict,
	mountSetVerdict,
	nonRootVerdict,
	parseStatus,
	pinningProbeRunArgs,
	runLiveProbes,
	sweepStaleContainers,
	sweepStaleFixtures,
} from "../src/live-probes.mjs";

const FIXTURE = liveFixture("/tmp/pi-dispatch-live-1-abc");
const ID = "a".repeat(64);
const nodeFs = { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync };

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
	const run = async (args) => {
		calls.push(args);
		const key = args[0] === "run" && args.includes("sleep") ? "run" : args[0] === "run" ? "pin" : args[0] === "exec" && args.includes(STATUS_SCRIPT) ? "status" : args[0] === "exec" ? "write" : args[0];
		if (over[key]) return over[key](args);
		switch (key) {
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
	jobsDir: mkdtempSync(join(tmpdir(), "pi-live-jobs-")),
	egress: { armed: false, results: [] },
	pid: 4242,
	nonce: "n0nce",
	run: docker.run,
	fs: nodeFs,
	isAlive: () => false,
	stepTimeoutMs: 1000,
	...over,
});

test("a green run reads back all six, in the conformance list's order, and leaves nothing behind", async () => {
	const docker = fakeDocker();
	const args = probeArgs(docker);
	const result = await runLiveProbes(args);
	assert.equal(result.ran, true);
	assert.deepEqual(result.verdicts.map((v) => v.property), [...READ_BACK_BY_A_LIVE_PROBE]);
	assert.deepEqual(result.verdicts.filter((v) => !v.ok).map((v) => v.property), ["egress"], "egress is off in this fixture, so it alone is unread");
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
	assert.match(order[0], /^starting pi-dispatch-live-probe-4242-n0nce from pi-job:x .* both are removed/);
	assert.deepEqual(order.slice(1, 3), ["docker ps", "docker run"], "announced before the sweep's first docker call and the probe's");
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
	assert.deepEqual(docker.calls.map((a) => a[0]), ["ps", "run", "rm"], "no inspect, no exec, no pin");
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
	const jobsDir = mkdtempSync(join(tmpdir(), "pi-live-jobs-"));
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
	const jobsDir = mkdtempSync(join(tmpdir(), "pi-live-sweep-"));
	const target = mkdtempSync(join(tmpdir(), "pi-live-sweep-target-"));
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
});
