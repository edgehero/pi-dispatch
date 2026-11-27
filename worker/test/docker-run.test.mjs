import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { assertUserns, CONTAINER_HOME, SHIPPED_IMAGE_UID, transfersFromSpec, USERNS_MODES } from "../src/container-spec.mjs";
import { assertJobEnvArgv, BARE_ENV_NAME, buildDockerRunArgs, buildPodmanRunArgs, CLIENT_ENV_GUARD, containerSpec, DOCKER_EXTRA_ALLOWED, DOCKER_EXTRA_FORBIDDEN, dockerArgsFromSpec, insideDir, isClientEnvGuarded, ISOLATION_FLAGS, jobClientEnv, jobEnvArgs, PODMAN_PINNED_FLAGS, podmanArgsFromSpec } from "../src/docker-run.mjs";
import { containerEnvOf, envNamesOf } from "./helpers/container-env.mjs";
import { createHash } from "node:crypto";
import { egressCanaryProbeArgs } from "../src/doctor.mjs";
import { egressEnv } from "../src/egress.mjs";
import { MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { DEFAULT_JOB_SIZE, jobSizeEnv } from "../src/job-size.mjs";
import { ephemeralRunArgs, liveFixture, liveProbeRunArgs, peerRunArgs, pinningProbeRunArgs } from "../src/live-probes.mjs";
import { EGRESS_ENV_KEYS, NON_SECRET_ENV_KEYS } from "../src/redact-secrets.mjs";
import { buildSandboxRunArgs } from "../src/sandbox.mjs";

const base = {
	image: "pi-job:pinned",
	env: { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-real" },
	jobDir: "/srv/jobs/abc/job",
	workspace: "/srv/jobs/abc/workspace",
	outboxDir: "/srv/jobs/abc/outbox",
	name: "pi-job-abc",
};

test("carries every isolation flag -- these ARE the boundary", () => {
	const args = buildDockerRunArgs(base);
	const s = args.join(" ");
	for (const flag of ["--pull=never", "--rm", "--init", "--cap-drop=ALL", "no-new-privileges", "--pids-limit=512", "--shm-size=1g"]) {
		assert.ok(args.includes(flag) || s.includes(flag), `missing isolation flag: ${flag}`);
	}
	// The dangerous one we must NEVER add.
	assert.ok(!s.includes("--ipc=host"), "--ipc=host shares the host IPC namespace with adversarial code");
	assert.ok(!s.includes("--privileged"), "--privileged");
	// The image is the last positional, and nothing may make docker fetch it: --pull=never is what stops a
	// per-trigger image name from becoming a registry pull of a stranger's image (INT-TRIGGERS-FILE-CONTRACT).
	assert.equal(args.at(-1), base.image, "the image is the final argv element");
	assert.ok(!s.includes("--pull=missing") && !s.includes("--pull=always"), "no argv may re-enable the fetch");
});

test("/job is read-only, /workspace is writable", () => {
	const args = buildDockerRunArgs(base);
	assert.ok(args.includes("/srv/jobs/abc/job:/job:ro"), "the whole /job must be :ro");
	assert.ok(args.includes("/srv/jobs/abc/workspace:/workspace"), "/workspace must be writable");
	assert.ok(!args.some((a) => a.includes("/workspace:ro")), "/workspace must not be read-only");
});

test("a local job mounts a writable /outbox host bind (the container's request channel)", () => {
	const args = buildDockerRunArgs(base);
	assert.ok(args.includes("/srv/jobs/abc/outbox:/outbox"), "local /outbox must be a host bind mount");
	assert.ok(!args.some((a) => a.includes("/outbox:ro")), "/outbox must be writable, never :ro");
});

test("a github job (no outboxDir) emits no /outbox mount -- the request channel does not exist for it", () => {
	const args = buildDockerRunArgs({ ...base, outboxDir: undefined });
	assert.ok(!args.some((a) => a.includes(":/outbox")), "a github job must have no /outbox mount");
});

test("the operator global overlay mounts /opt/pi-global:ro only when configured", () => {
	const on = buildDockerRunArgs({ ...base, globalPiDir: "/srv/pi-global" });
	assert.ok(on.includes("/srv/pi-global:/opt/pi-global:ro"), "overlay must mount at /opt/pi-global, read-only");
	assert.ok(!on.some((a) => a.includes("/opt/pi-global") && !a.endsWith(":ro")), "the overlay mount must be :ro");
	const off = buildDockerRunArgs({ ...base, globalPiDir: undefined });
	assert.ok(!off.some((a) => a.includes("/opt/pi-global")), "no overlay mount when PI_GLOBAL_PI_DIR is unset");
});

test("env is an explicit allowlist, never a pass-through or --env-file: a credential is a bare -e NAME whose value only the job gives the client (issue #1114)", () => {
	const args = buildDockerRunArgs(base);
	assert.ok(!args.includes("--env-file"), "must never use --env-file");
	assert.deepEqual(envNamesOf(args), ["PI_PROVIDER", "ANTHROPIC_API_KEY"]);
	assert.ok(args.includes("PI_PROVIDER=anthropic"), "a structural name keeps its value on the argv");
	assert.equal(args[args.indexOf("ANTHROPIC_API_KEY") - 1], "-e", "the credential is a bare -e NAME");
	assert.ok(!args.some((a) => a.includes("sk-real")), "and its value is on no argv token");
	// What the old "every -e is NAME=VALUE" assertion was for: no HOST value reaches the container. A bare name is filled
	// from the client's own environment, and `jobClientEnv` drops the host's key of that name, in any case, and puts the
	// job's value there; the rest of the client's environment is the host's.
	const clientEnv = jobClientEnv(base.env, { ANTHROPIC_API_KEY: "sk-host", anthropic_api_key: "sk-host-lower", PATH: "/usr/bin" });
	assert.deepEqual(clientEnv, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-real" });
	assert.deepEqual(containerEnvOf(args, { env: clientEnv }), base.env, "the container gets exactly the closed map");
	assert.deepEqual(containerEnvOf(args, { env: { PATH: "/usr/bin" } }), { PI_PROVIDER: "anthropic" }, "and a client env without the value leaves the variable out");
});

/** Every `-v` VALUE in argv, in order -- the enumerated mount list CONST-ISOLATION-CONTAINER-PER-JOB pins. */
function mounts(args) {
	return args.filter((_a, i) => args[i - 1] === "-v");
}

test("PI_PACKAGES rides the env allowlist and adds NO mount -- the staged packages live under the existing overlay bind", () => {
	const withPkgs = buildDockerRunArgs({ ...base, env: { ...base.env, PI_PACKAGES: "/a:/b" } });
	const i = withPkgs.indexOf("PI_PACKAGES=/a:/b");
	assert.ok(i > 0, "the joined package paths must be passed as an explicit -e value");
	assert.equal(withPkgs[i - 1], "-e", "PI_PACKAGES is an env entry, not a flag of its own");

	const without = buildDockerRunArgs({ ...base, env: { ...base.env, PI_PACKAGES: undefined } });
	assert.ok(!without.some((a) => a.startsWith("PI_PACKAGES")), "an unflagged job must have no PI_PACKAGES element at all, not an empty one");

	// The mount list is the security boundary: staging packages must never widen it. Both argvs carry
	// exactly the mounts the base job already had.
	const expected = mounts(buildDockerRunArgs(base));
	assert.deepEqual(mounts(withPkgs), expected, "a packages job must add no new -v mount");
	assert.deepEqual(mounts(without), expected, "and neither does the unflagged one");
});

test("an undefined env value is skipped, not passed as empty", () => {
	const args = buildDockerRunArgs({ ...base, env: { PI_MODEL: "m", GITHUB_TOKEN: undefined } });
	assert.ok(!args.some((a) => a.startsWith("GITHUB_TOKEN")), "absent token must not appear at all");
});

test("the job user is a spec field: --user=<uid>:<gid> after --network and before dockerExtra (issue #341)", () => {
	const args = buildDockerRunArgs({ ...base, network: "pi-job-abc-net", user: "1234:1234", extraFlags: ["--entrypoint", "sh"] });
	const at = args.indexOf("--user=1234:1234");
	assert.ok(at > args.indexOf("--network=pi-job-abc-net"), "after the network flag");
	assert.ok(at < args.indexOf("--entrypoint"), "before dockerExtra, where a repeat could otherwise supersede it");
	assert.equal(args.filter((a) => a.startsWith("--user")).length, 1);
	assert.equal(containerSpec({ ...base, user: "1234:1234" }).user, "1234:1234");
});

test("no user means NO --user at all: the argv is byte-identical to one built before issue #341", () => {
	const before = buildDockerRunArgs(base);
	assert.deepEqual(buildDockerRunArgs({ ...base, user: null }), before);
	assert.deepEqual(buildDockerRunArgs({ ...base, user: undefined }), before);
	assert.ok(!before.some((a) => a.startsWith("--user") || a === "-u"));
});

test("the job user must be a non-root <uid>:<gid>: uid 0, gid 0, a bare uid, a name and root are refused", () => {
	for (const bad of ["0:0", "0:1000", "1000:0", "1000", "root", "pi:pi", "root:root", "1000:1000 ", " 1000:1000", "01000:1000", "1000:-1", "1000:1000:1", "", 1000, { toString: () => "1000:1000" }]) {
		assert.throws(() => containerSpec({ ...base, user: bad }), /refusing a job user/, JSON.stringify(String(bad)));
		assert.throws(() => dockerArgsFromSpec({ ...containerSpec(base), user: bad }), /refusing a job user/, `hand-built ${String(bad)}`);
	}
	assert.doesNotThrow(() => containerSpec({ ...base, user: "4294967294:4294967294" }));
});

test("fused short flags are refused: -u0, -iu0, -v/:/h, -m1g all reach docker as the flags they hide", () => {
	for (const bad of ["-u0", "-iu0", "-v/:/host", "-m1g", "-it", "-p8080:80"]) {
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [bad] }), /supersede the isolation boundary/, bad);
	}
	// What callers really pass stays allowed: separate tokens, long flags, their values.
	assert.doesNotThrow(() => buildDockerRunArgs({ ...base, extraFlags: ["-i", "-t", "--entrypoint", "bash", "-p", "127.0.0.1:3000:3000", "-d"] }));
});

test("dockerExtra is an allow-list: only what the sandbox and the live probes pass reaches docker (issue #341)", () => {
	// Each of these reached docker past the deny-list (an adversarial pass): a bare token or `--` becomes the IMAGE and
	// turns every later -e and -v into that image's arguments; the rest change the user, the groups or the mounts.
	const refused = [
		["alpine"],
		["--", "alpine"],
		["--annotation", "run.oci.keep_original_groups=1"],
		["--annotation=run.oci.keep_original_groups=1"],
		["--uidmap", "0:1:1"],
		["--gidmap=0:1:1"],
		["--use-api-socket"],
		["--env", "X=1"],
		["-e", "X=1"],
		["--read-only=false"],
		["-p", "8080:80"],
		["-p", "0.0.0.0:8080:80"],
		// Anchored: the address must BEGIN with loopback, or an IPv6 literal ending in it binds elsewhere.
		["-p", "2001:db8::127.0.0.1:8080:80"],
		["-p", "127.0.0.1:8080:80", "-p"],
		["-p=127.0.0.1:8080:80"],
		["--entrypoint"],
		["--entrypoint", "--privileged"],
		["--entrypoint", "sh -c id"],
		["--entrypoint=bash"],
		["-i", "bash"],
	];
	for (const extra of refused) {
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: extra }), /refusing a dockerExtra (token|flag)/, JSON.stringify(extra));
	}
	// A valued flag consumes exactly its next token, so a value can never be read as a flag, nor a flag as a value.
	assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: ["--entrypoint", "-i"] }), /outside what the builder's callers pass/);
	// The pinned shape of the list, and every real caller's exact tokens.
	assert.deepEqual([...DOCKER_EXTRA_ALLOWED.bare], ["-i", "-t", "-d"]);
	assert.deepEqual(Object.keys(DOCKER_EXTRA_ALLOWED.valued), ["--entrypoint", "-p"]);
	for (const extra of [["-i", "-t", "--entrypoint", "bash", "-p", "127.0.0.1:1:65535", "-p", "127.0.0.1:8080:3000"], ["-d", "--entrypoint", "sleep"], ["-d"], []]) {
		assert.doesNotThrow(() => buildDockerRunArgs({ ...base, extraFlags: extra }), JSON.stringify(extra));
	}
});

test("SHIPPED_IMAGE_UID and CONTAINER_HOME are the image's own useradd uid and home", () => {
	const dockerfile = readFileSync(new URL("../../image/Dockerfile", import.meta.url), "utf8");
	const m = dockerfile.match(/useradd --create-home --shell \/bin\/bash --uid (\d+) pi/);
	assert.ok(m, "image/Dockerfile must still create the pi user with an explicit uid");
	assert.equal(Number(m[1]), SHIPPED_IMAGE_UID);
	assert.equal(CONTAINER_HOME, "/home/pi");
	assert.equal(SHIPPED_IMAGE_UID, 1001, "a literal pin: a constant-derived test is blind to a change IN the value");
});

test("nothing in worker/src but the builder spells a docker --user flag", () => {
	// systemctl --user in service.mjs is a different tool's flag, so the grep is for the docker spelling the builder
	// emits. A second place emitting it is a second, unvalidated path to uid 0.
	const dir = new URL("../src/", import.meta.url);
	const hits = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "docker-run.mjs").filter((f) => readFileSync(new URL(f, dir), "utf8").includes("--user="));
	// ONE named exception (issue #596, phase 2): the CPU reserve's one-shot helper writes the jobs' parent cgroup's
	// `cpu.max` on Docker Desktop, which needs uid 0 even with every capability dropped (measured). It runs no job code and
	// mounts nothing but that one cgroup directory; its exact argv is pinned in cpu-reserve.test.mjs, and here it may
	// spell uid 0 in exactly one place and no other user at all.
	assert.deepEqual(hits, ["cpu-reserve.mjs"]);
	const helper = readFileSync(new URL("cpu-reserve.mjs", dir), "utf8");
	assert.deepEqual(helper.match(/--user=[^"`\s]*/g), ["--user=0:0"]);
});

test("refuses to build without image / name / workspace", () => {
	assert.throws(() => buildDockerRunArgs({ ...base, image: undefined }), /image/);
	assert.throws(() => buildDockerRunArgs({ ...base, name: undefined }), /name/);
	assert.throws(() => buildDockerRunArgs({ ...base, workspace: undefined }), /workspace/);
});

test("--network is CONFIGURED, never frozen: it must not be a member of ISOLATION_FLAGS", () => {
	// The boundary between the two lists is itself pinned, because the pressure to move this flag into the
	// array is real and the consequence is silent. `ISOLATION_FLAGS` is the LITERAL, value-free,
	// unconditional set, and two places assert every member of it reaches the sandbox argv against the
	// IMPORTED array (CONST-ISOLATION-CONTAINER-PER-JOB, INT-SANDBOX-CONTRACT). A conditional member makes
	// "every member" false on any deployment running without an egress policy, so the assertion would have
	// to be weakened to "every member except this one" -- which does not weaken a constraint so much as
	// retire the assertion that was enforcing it.
	assert.ok(!ISOLATION_FLAGS.some((f) => f.startsWith("--network")), "the boundary is fixed; the network is configured");
});

test("the egress network flag is ABSENT when no policy is armed -- byte-identical to a pre-feature argv", () => {
	const common = { image: "pi-job:latest", env: {}, jobDir: "/j", workspace: "/w", name: "pi-job-1" };
	assert.deepEqual(buildDockerRunArgs(common), buildDockerRunArgs({ ...common, network: null }));
	assert.ok(!buildDockerRunArgs(common).join(" ").includes("--network"), "no policy, no flag");
});

test("an armed job carries --network, positioned before the image positional", () => {
	const args = buildDockerRunArgs({
		image: "pi-job:latest",
		env: {},
		jobDir: "/j",
		workspace: "/w",
		name: "pi-job-1",
		network: "pi-job-1-net",
	});
	assert.ok(args.includes("--network=pi-job-1-net"));
	// The image stays last, which is the one positional constraint the whole argv has.
	assert.equal(args.at(-1), "pi-job:latest", "the image is still the final argv element");
	// And it sits beside --memory/--cpus, the other two configured-value flags, ahead of the mounts.
	assert.ok(args.indexOf("--network=pi-job-1-net") < args.indexOf("-v"), "flags precede the mounts");
});

test("ISOLATION_FLAGS is frozen intent -- the exact set the spec pins", () => {
	// A change here is a change to the security boundary and must be deliberate.
	assert.deepEqual(ISOLATION_FLAGS, [
		"--pull=never",
		"--rm",
		"--init",
		"--cap-drop=ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit=512",
	]);
	// Issue #596: `--shm-size` is a SIZE now (min(1g, memory/2)), emitted beside `--memory`, and so not in this literal set.
	assert.equal(ISOLATION_FLAGS.some((f) => f.startsWith("--shm-size")), false);
});

test("the job's size reaches the argv beside --memory, on both runtimes, in one fixed order (issue #596)", () => {
	const sized = { ...base, size: { memMiB: 1536, cpuCenti: 75 }, hostCpus: 8 };
	const docker = buildDockerRunArgs(sized);
	const at = docker.indexOf("--pids-limit=512") + 1;
	assert.deepEqual(docker.slice(at, at + 5), ["--memory=1536m", "--memory-swap=1536m", "--cpus=7", "--cpu-shares=768", "--shm-size=768m"]);
	const podman = buildPodmanRunArgs({ ...sized, user: "1234:1234" });
	const pat = podman.indexOf("--pids-limit=512") + 1;
	assert.deepEqual(podman.slice(pat, pat + 5), docker.slice(at, at + 5), "the podman argv sizes a job exactly as the docker one does");
	// Each size flag exactly once, so no later token can be a second, wider one.
	for (const flag of ["--memory=", "--memory-swap=", "--cpus=", "--cpu-shares=", "--shm-size="]) {
		assert.equal(docker.filter((a) => a.startsWith(flag)).length, 1, flag);
	}
	// No CPU count from the runtime: no ceiling at all, everything else unchanged.
	const open = buildDockerRunArgs({ ...sized, hostCpus: null });
	assert.equal(open.some((a) => a.startsWith("--cpus")), false);
	assert.deepEqual(open.filter((a) => !a.startsWith("--cpus")), docker.filter((a) => !a.startsWith("--cpus")));
});

test("the builder REFUSES a hand-built spec whose size allows swap, or that has no size fields at all (issue #596)", () => {
	const good = containerSpec({ ...base, size: { memMiB: 2048, cpuCenti: 100 }, hostCpus: 4 });
	assert.ok(dockerArgsFromSpec(good).includes("--memory-swap=2g"));
	const bad = [
		{ ...good, memorySwap: "4g" },
		{ ...good, memorySwap: undefined },
		{ ...good, memorySwap: "-1" },
		{ ...good, memory: "2G", memorySwap: "2G" },
		{ ...good, memory: undefined, memorySwap: undefined },
		{ ...good, cpuShares: 1 },
		{ ...good, cpuShares: 262145 },
		{ ...good, cpuShares: "1024" },
		{ ...good, cpus: "0" },
		{ ...good, cpus: 3 },
		{ ...good, cpus: "1.555" },
		{ ...good, cpus: "0.00" },
		{ ...good, cpus: "01" },
		{ ...good, cpus: undefined },
		// Issue #596, phase 2: the size labels are exactly the two, with integer values.
		{ ...good, labels: { "pi.dispatch.mem": "2048" } },
		{ ...good, labels: { "pi.dispatch.mem": "2048", "pi.dispatch.cpu": "1.5" } },
		{ ...good, labels: { "pi.dispatch.mem": "2048", "pi.dispatch.cpu": "100", other: "1" } },
		{ ...good, labels: null },
		{ ...good, shmSize: "1G" },
		{ ...good, shmSize: undefined },
	];
	for (const spec of bad) assert.throws(() => dockerArgsFromSpec(spec), /size fields are not containerSpec's/, JSON.stringify({ memory: spec.memory, memorySwap: spec.memorySwap, cpus: spec.cpus, cpuShares: spec.cpuShares, shmSize: spec.shmSize }));
	assert.throws(() => containerSpec({ ...base, size: { memMiB: 256, cpuCenti: 100 } }), /refusing a job size/);
});

test("every flag that sets a CPU or memory bound, a weight or an OOM preference is refused in dockerExtra (issue #596)", () => {
	for (const flag of ["-m", "-c", "--cpu-shares", "--cpu-quota", "--cpu-period", "--cpuset-cpus", "--memory-reservation", "--memory-swap", "--blkio-weight", "--device-read-bps", "--device-write-bps", "--device-read-iops", "--device-write-iops", "--oom-score-adj", "--shm-size", "--cpus", "--memory"]) {
		assert.ok(DOCKER_EXTRA_FORBIDDEN.includes(flag), `${flag} must be denied`);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [flag, "1"] }), /supersede the isolation boundary/, flag);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [`${flag}=1`] }), /supersede the isolation boundary/, `${flag}=1`);
	}
});

test("the /session mount is per-job and writable, and the container learns nothing about the host layout", () => {
	const args = buildDockerRunArgs({
		image: "pi-job:latest",
		env: {},
		jobDir: "/tmp/jobs/job-abc",
		workspace: "/tmp/jobs/job-abc/workspace",
		sessionDir: "/tmp/jobs/job-abc/session",
		name: "pi-job-1",
	});
	const mounts = args.filter((a, i) => args[i - 1] === "-v");
	assert.deepEqual(
		mounts.filter((m) => m.includes(":/session")),
		["/tmp/jobs/job-abc/session:/session"],
		"exactly one session mount, and writable -- pi appends to the transcript as the agent works",
	);
	// The mount is the capability. A whole-store mount would hand one job's agent every other branch's
	// and every other repository's transcripts, which is not a weakening of container-per-job but its
	// inversion -- and it is a one-word change, so it gets an assertion rather than a comment.
	assert.equal(mounts.some((m) => m.endsWith(":/session:ro")), false);
	assert.ok(mounts.every((m) => m.startsWith("/tmp/jobs/job-abc")), "every writable mount stays inside this job's own dir");
	// Nothing key-derived crosses: the container path is a constant, so no repo, branch or host layout
	// is legible from inside the job.
	assert.equal(args.join(" ").includes("current.jsonl"), false);
});

test("a job with no session gets an argv byte-identical to one built before the feature existed", () => {
	const common = { image: "pi-job:latest", env: {}, jobDir: "/j", workspace: "/w", name: "pi-job-1" };
	assert.deepEqual(buildDockerRunArgs(common), buildDockerRunArgs({ ...common, sessionDir: undefined }));
	assert.equal(buildDockerRunArgs(common).includes("/session"), false);
	assert.equal(buildDockerRunArgs({ ...common, sessionDir: null }).join(" ").includes(":/session"), false);
});

test("run.skillsDir adds NO mount -- injected skills ride the /job bind that already exists", () => {
	// CONST-ISOLATION-CONTAINER-PER-JOB's acceptance ENUMERATES the mounts, and DES-OPERATOR-GLOBAL-OVERLAY
	// already refused a mount for staged packages on exactly this trade. The worker copies the skills into
	// the per-job dir instead, so this argv is byte-identical to one built before the feature existed.
	const base = buildDockerRunArgs({ image: "pi-job:latest", name: "pi-job-1", jobDir: "/j", workspace: "/w", env: {} });
	const withSkills = buildDockerRunArgs({ image: "pi-job:latest", name: "pi-job-1", jobDir: "/j", workspace: "/w", env: {} });
	assert.deepEqual(withSkills, base);
	const mounts = base.filter((a, i) => base[i - 1] === "-v");
	assert.deepEqual(mounts, ["/j:/job:ro", "/w:/workspace"]);
	assert.ok(!base.some((a) => String(a).includes("trigger-skills")), "a trigger-skills mount was emitted");
});

// --- the spec, and the argv builder that consumes it (issue #261) -----------------------------------------
//
// `buildDockerRunArgs` is now `dockerArgsFromSpec(containerSpec(opts))`. Every test above still calls it
// directly and is untouched, which is the point: the extraction changed the middle of that sentence and
// neither end. These pin the middle.

test("the spec describes the box in its own vocabulary, not docker's", () => {
	const spec = containerSpec({ ...base, sessionDir: "/s", globalPiDir: "/g", network: "pi-job-1-net" });
	// Mounts are STRUCTURED, because the flattening is the docker part: a runtime that does not bind-mount
	// still has to see which host path becomes which container path, and what may be written.
	assert.deepEqual(spec.mounts, [
		{ host: "/srv/jobs/abc/job", container: "/job", readOnly: true },
		{ host: "/srv/jobs/abc/workspace", container: "/workspace", readOnly: false },
		{ host: "/srv/jobs/abc/outbox", container: "/outbox", readOnly: false },
		{ host: "/s", container: "/session", readOnly: false },
		{ host: "/g", container: "/opt/pi-global", readOnly: true },
	]);
	assert.equal(spec.image, base.image);
	assert.equal(spec.network, "pi-job-1-net");
	assert.equal(spec.user, null, "no user unless asked: the image's own USER runs");
	// Named for what it is. A non-docker consumer must REFUSE this field rather than translate it.
	assert.deepEqual(spec.dockerExtra, []);
	assert.equal("extraFlags" in spec, false, "the docker-only escape hatch is not disguised as portable");
});

test("an absent optional mount is absent from the spec, not a null entry", () => {
	const spec = containerSpec({ image: "i", name: "n", workspace: "/w" });
	assert.deepEqual(spec.mounts, [{ host: "/w", container: "/workspace", readOnly: false }]);
});

test("the spec CANNOT describe an unisolated container", () => {
	// The boundary is not something a caller opts into: CONST-ISOLATION-CONTAINER-PER-JOB is why every
	// other flag exists. So there is no parameter that unsets it, and passing one changes nothing.
	assert.equal(containerSpec(base).isolated, true);
	assert.equal(containerSpec({ ...base, isolated: false }).isolated, true, "a hostile or mistaken caller cannot ask for less");
});

test("the argv builder REFUSES a spec that is not isolated", () => {
	// Only reachable for a hand-built spec, and that is exactly the case that must fail loudly: a spec
	// that forgot the field would otherwise emit a container with no isolation flags at all.
	const good = containerSpec(base);
	assert.ok(dockerArgsFromSpec(good).includes("--cap-drop=ALL"));
	for (const bad of [{ ...good, isolated: false }, { ...good, isolated: undefined }, { ...good, isolated: "true" }, {}, null]) {
		assert.throws(() => dockerArgsFromSpec(bad), /not isolated/, `must refuse ${JSON.stringify(bad)}`);
	}
});

test("composing the two halves is exactly what the public builder does", () => {
	// The regression pin for the extraction itself: if these ever diverge, one of the two paths has grown
	// behaviour the other has not.
	const shapes = [
		base,
		{ ...base, sessionDir: "/s", globalPiDir: "/g", network: "n", env: { A: "1", B: undefined } },
		{ image: "i", name: "pi-sandbox-1", workspace: "/w", jobDir: "/j", extraFlags: ["-i", "-t", "--entrypoint", "bash"] },
		{ image: "i", name: "n", workspace: "/w", size: { memMiB: 8192, cpuCenti: 400 }, hostCpus: 2 },
		{ ...base, user: "1234:1234", network: "n" },
	];
	for (const s of shapes) assert.deepEqual(dockerArgsFromSpec(containerSpec({ ...s })), buildDockerRunArgs({ ...s }));
});

test("mounts flatten in spec order, and -v stays two argv elements", () => {
	// The pairing is load-bearing beyond style: the mount assertions in this suite extract by adjacency
	// (`args[i - 1] === "-v"`), so a single `--volume=` token would make those filters return nothing and
	// turn several exact-array checks vacuously green.
	const args = dockerArgsFromSpec(containerSpec({ ...base, sessionDir: "/s", globalPiDir: "/g" }));
	const flat = args.filter((_a, i) => args[i - 1] === "-v");
	assert.deepEqual(flat, [
		"/srv/jobs/abc/job:/job:ro",
		"/srv/jobs/abc/workspace:/workspace",
		"/srv/jobs/abc/outbox:/outbox",
		"/s:/session",
		"/g:/opt/pi-global:ro",
	]);
	assert.equal(args.filter((a) => a === "-v").length, flat.length, "one -v per mount, never a fused token");
});

test("the cidfile is a builder-owned field: its own token before dockerExtra, absent by default, refused in extraFlags, and a plain absolute path (#345)", () => {
	const before = buildDockerRunArgs({ ...base });
	assert.deepEqual(buildDockerRunArgs({ ...base, cidFile: null }), before, "no cidfile, byte-identical argv");
	assert.equal(before.some((a) => a.startsWith("--cidfile")), false);
	const args = buildDockerRunArgs({ ...base, cidFile: "/srv/jobs/job-abc.cid", extraFlags: ["--entrypoint", "sh"] });
	assert.ok(args.indexOf("--cidfile=/srv/jobs/job-abc.cid") < args.indexOf("--entrypoint"), "before dockerExtra, where nothing can follow it");
	assert.equal(containerSpec({ ...base, cidFile: "C:\\jobs\\job-abc.cid" }).cidFile, "C:\\jobs\\job-abc.cid", "a Windows worker's jobs dir");
	for (const flag of ["--cidfile", "--cidfile=/tmp/x"]) {
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [flag, "/tmp/x"] }), /would supersede the isolation boundary/, flag);
	}
	assert.ok(DOCKER_EXTRA_FORBIDDEN.includes("--cidfile"));
	for (const bad of ["relative.cid", "/srv/../etc/x.cid", "/srv/jobs/x\n.cid", 42, ""]) {
		assert.throws(() => containerSpec({ ...base, cidFile: bad }), /refusing a cidfile/, JSON.stringify(bad));
		assert.throws(() => dockerArgsFromSpec({ ...containerSpec(base), cidFile: bad }), /refusing a cidfile/, `hand-built ${JSON.stringify(bad)}`);
	}
});

// --- issue #355: SELinux relabelling of the worker's own per-job mounts -----------------------------------------

test("with relabel, /job, /outbox and /session are relabelled private, /workspace only when the worker owns it, /opt/pi-global never", () => {
	const all = { ...base, sessionDir: "/s", globalPiDir: "/g" };
	assert.deepEqual(containerSpec({ ...all, relabel: true, workspaceOwned: true }).mounts, [
		{ host: "/srv/jobs/abc/job", container: "/job", readOnly: true, relabel: "private" },
		{ host: "/srv/jobs/abc/workspace", container: "/workspace", readOnly: false, relabel: "private" },
		{ host: "/srv/jobs/abc/outbox", container: "/outbox", readOnly: false, relabel: "private" },
		{ host: "/s", container: "/session", readOnly: false, relabel: "private" },
		{ host: "/g", container: "/opt/pi-global", readOnly: true },
	]);
	// A local job: /workspace is the operator's folder, which a private label would take from every other container.
	assert.deepEqual(containerSpec({ ...all, relabel: true, workspaceOwned: false }).mounts[1], { host: "/srv/jobs/abc/workspace", container: "/workspace", readOnly: false });
	assert.deepEqual(containerSpec({ ...all, relabel: true }).mounts[1], { host: "/srv/jobs/abc/workspace", container: "/workspace", readOnly: false }, "not owned unless the caller says so");
});

test("with relabel, the argv spells :ro,Z, :Z and a bare overlay, with -v and its value still two elements", () => {
	const args = buildDockerRunArgs({ ...base, sessionDir: "/s", globalPiDir: "/g", relabel: true, workspaceOwned: true });
	const i = args.indexOf("/srv/jobs/abc/job:/job:ro,Z");
	assert.deepEqual(args.slice(i - 1, i + 1), ["-v", "/srv/jobs/abc/job:/job:ro,Z"]);
	assert.deepEqual(args.filter((_a, n) => args[n - 1] === "-v"), [
		"/srv/jobs/abc/job:/job:ro,Z",
		"/srv/jobs/abc/workspace:/workspace:Z",
		"/srv/jobs/abc/outbox:/outbox:Z",
		"/s:/session:Z",
		"/g:/opt/pi-global:ro",
	]);
	assert.ok(args.includes("/srv/jobs/abc/workspace:/workspace:Z"));
	assert.ok(!args.some((a) => /:z$|,z$/.test(a)), "never the shared form, which would open a job's directory to every container");
	const local = buildDockerRunArgs({ ...base, relabel: true, workspaceOwned: false });
	assert.ok(local.includes("/srv/jobs/abc/workspace:/workspace"), "an operator's folder is mounted exactly as before");
});

test("without relabel the argv is byte-identical to one built before issue #355, whatever workspaceOwned says", () => {
	const all = { ...base, sessionDir: "/s", globalPiDir: "/g", user: "1234:1234", network: "n", cidFile: "/srv/jobs/abc/job.cid" };
	const before = buildDockerRunArgs(all);
	assert.deepEqual(buildDockerRunArgs({ ...all, relabel: false }), before);
	assert.deepEqual(buildDockerRunArgs({ ...all, relabel: false, workspaceOwned: true }), before);
	assert.ok(!before.some((a) => a.endsWith(":Z") || a.endsWith(",Z")));
	assert.deepEqual(containerSpec({ ...all, workspaceOwned: true }).mounts, containerSpec(all).mounts, "no relabel key at all, not a null one");
	for (const m of containerSpec({ ...all, relabel: false }).mounts) assert.equal("relabel" in m, false, m.container);
});

test("relabel and workspaceOwned are booleans, and a hand-built mount may carry only the private relabel", () => {
	for (const bad of ["true", 1, null]) {
		assert.throws(() => containerSpec({ ...base, relabel: bad }), /relabel must be a boolean/, JSON.stringify(bad));
		assert.throws(() => containerSpec({ ...base, relabel: true, workspaceOwned: bad }), /workspaceOwned must be a boolean/, JSON.stringify(bad));
	}
	const spec = containerSpec(base);
	for (const relabel of ["shared", "z", "Z", true]) {
		const bad = { ...spec, mounts: [{ host: "/w", container: "/workspace", readOnly: false, relabel }] };
		assert.throws(() => dockerArgsFromSpec(bad), /relabel other than "private"/, JSON.stringify(relabel));
	}
});

test("a copying runtime's transfers carry no relabel: the label is a bind-mount option, not a file property", () => {
	const spec = containerSpec({ ...base, relabel: true, workspaceOwned: true });
	for (const t of transfersFromSpec(spec)) assert.equal("relabel" in t, false, t.container);
});

// --- issue #354: the userns field, and the podman argv that shares the docker builder -------------------------------

test("userns is a closed field: null by default, \"keep-id\" accepted, every other spelling refused", () => {
	assert.equal(containerSpec(base).userns, null, "present and null, the runtime's own default");
	assert.equal(containerSpec({ ...base, userns: undefined }).userns, null, "one spelling of the default");
	assert.equal(containerSpec({ ...base, userns: "keep-id" }).userns, "keep-id");
	assert.deepEqual([...USERNS_MODES], ["keep-id"]);
	assert.ok(Object.isFrozen(USERNS_MODES));
	for (const bad of ["host", "auto", "nomap", "keep-id:uid=0", "ns:/proc/1/ns/user", "KEEP-ID", " keep-id", "", true, 1, { toString: () => "keep-id" }]) {
		assert.throws(() => containerSpec({ ...base, userns: bad }), /refusing a userns/, JSON.stringify(String(bad)));
		assert.throws(() => assertUserns(bad), /refusing a userns/);
	}
	assert.doesNotThrow(() => assertUserns(null));
	assert.doesNotThrow(() => assertUserns(undefined));
});

test("the docker builder REFUSES a spec with a userns: the docker CLI rejects --userns=keep-id, and dropping it would change who the job is", () => {
	assert.throws(() => buildDockerRunArgs({ ...base, user: "1234:1234", userns: "keep-id" }), /refusing a spec with userns "keep-id"/);
	for (const bad of ["keep-id", "host", ""]) {
		assert.throws(() => dockerArgsFromSpec({ ...containerSpec({ ...base, user: "1234:1234" }), userns: bad }), /refusing a spec with userns/, JSON.stringify(bad));
	}
	// A hand-built spec that predates the field asked for nothing, and builds exactly what it always did.
	const { userns, ...legacy } = containerSpec(base);
	assert.equal(userns, null);
	assert.deepEqual(dockerArgsFromSpec(legacy), buildDockerRunArgs(base));
});

test("the podman argv, literally: --userns=keep-id immediately after --user=, then the cidfile, dockerExtra, env, mounts and the image", () => {
	const args = buildPodmanRunArgs({
		image: "pi-job:pinned",
		env: { PI_MODEL: "m", A: "1" },
		jobDir: "/j",
		workspace: "/j/workspace",
		name: "pi-job-1",
		network: "pi-job-1-net",
		user: "1234:1234",
		cidFile: "/j.cid",
		relabel: true,
		workspaceOwned: true,
		size: { memMiB: 1024, cpuCenti: 50 },
		hostCpus: 4,
	});
	assert.deepEqual(args, [
		"run",
		"--name=pi-job-1",
		"--pull=never",
		"--rm",
		"--init",
		"--cap-drop=ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit=512",
		"--memory=1g",
		"--memory-swap=1g",
		"--cpus=3",
		"--cpu-shares=512",
		"--shm-size=512m",
		"--cgroup-parent=pidispatch.slice",
		"--label=pi.dispatch.mem=1024",
		"--label=pi.dispatch.cpu=50",
		"--network=pi-job-1-net",
		"--user=1234:1234",
		"--userns=keep-id",
		"--pid=private",
		"--ipc=private",
		"--uts=private",
		"--cgroupns=private",
		"--env-host=false",
		"--http-proxy=false",
		"--cidfile=/j.cid",
		"-e",
		"PI_MODEL=m",
		"-e",
		"A",
		"-v",
		"/j:/job:ro,Z",
		"-v",
		"/j/workspace:/workspace:Z",
		"--workdir=/workspace",
		"pi-job:pinned",
	]);
	assert.equal(args.filter((a) => a.startsWith("--userns")).length, 1);
});

test("the podman argv is the docker argv plus keep-id and the pinned namespaces: one private builder, so the boundary cannot drift between runtimes", () => {
	const shapes = [
		{ ...base, user: "1234:1234" },
		{ ...base, user: "1234:1234", sessionDir: "/s", globalPiDir: "/g", network: "n", cidFile: "/c.cid", relabel: true, workspaceOwned: true },
		{ image: "i", name: "pi-sandbox-1", workspace: "/w", jobDir: "/j", user: "1:1", extraFlags: ["-i", "-t", "--entrypoint", "bash"] },
	];
	for (const s of shapes) {
		const podman = buildPodmanRunArgs(s);
		const at = podman.indexOf("--userns=keep-id");
		assert.equal(podman[at - 1], `--user=${s.user}`);
		assert.deepEqual(podman.slice(at + 1, at + 1 + PODMAN_PINNED_FLAGS.length), [...PODMAN_PINNED_FLAGS], "the pinned namespaces follow keep-id");
		// A job with no network of its own is pinned to Podman's private default; one with a network keeps its own.
		const docker = buildDockerRunArgs(s);
		const net = podman.indexOf("--network=private");
		assert.equal(net !== -1, !s.network, JSON.stringify(s));
		const stripped = podman.filter((a, i) => i !== net && (i < at || i > at + PODMAN_PINNED_FLAGS.length));
		assert.deepEqual(stripped, docker, JSON.stringify(s));
	}
	// The same refusals reach the podman path: they live in the shared body, not in the docker wrapper.
	assert.throws(() => buildPodmanRunArgs({ ...base, user: "1:1", extraFlags: ["--userns=host"] }), /supersede the isolation boundary/);
	assert.throws(() => buildPodmanRunArgs({ ...base, user: "1:1", extraFlags: ["--privileged"] }), /supersede the isolation boundary/);
	assert.throws(() => podmanArgsFromSpec({ ...containerSpec({ ...base, user: "1:1", userns: "keep-id" }), isolated: false }), /not isolated/);
	assert.throws(() => podmanArgsFromSpec({ ...containerSpec({ ...base, user: "1:1", userns: "keep-id" }), user: "0:0" }), /refusing a job user/);
	assert.ok(DOCKER_EXTRA_FORBIDDEN.includes("--userns"), "a dockerExtra repeat could otherwise supersede keep-id");
	assert.deepEqual([...PODMAN_PINNED_FLAGS], ["--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--env-host=false", "--http-proxy=false"]);
	for (const flag of ["--pid", "--ipc", "--uts", "--cgroupns", "--network", "--env-host", "--http-proxy"]) {
		assert.throws(() => buildPodmanRunArgs({ ...base, user: "1:1", extraFlags: [`${flag}=host`] }), /supersede|not allowed|refus/i, `${flag} cannot be re-set by dockerExtra`);
	}
});

test("the podman builder refuses a spec without keep-id, and keep-id without a job user (/job would be unreadable)", () => {
	assert.throws(() => buildPodmanRunArgs(base), /no job user/, "user absent");
	assert.throws(() => buildPodmanRunArgs({ ...base, user: null }), /no job user/);
	assert.throws(() => podmanArgsFromSpec(containerSpec({ ...base, user: "1234:1234" })), /userns is not "keep-id": null/);
	assert.throws(() => podmanArgsFromSpec({ ...containerSpec({ ...base, user: "1234:1234" }), userns: "host" }), /userns is not "keep-id"/);
	assert.throws(() => podmanArgsFromSpec(null), /userns is not "keep-id"/);
	assert.throws(() => podmanArgsFromSpec({ ...containerSpec({ ...base, userns: "keep-id" }) }), /no job user/);
	// An opts bag cannot talk the podman path out of keep-id: the wrapper sets it last.
	for (const userns of [null, "host"]) {
		const args = buildPodmanRunArgs({ ...base, user: "1234:1234", userns });
		assert.deepEqual(args.filter((a) => a.startsWith("--userns")), ["--userns=keep-id"], JSON.stringify(userns));
	}
});

test("insideDir: strictly inside, failing closed on anything else (issue #355)", () => {
	assert.equal(insideDir("/j/job-1", "/j/job-1/workspace"), true);
	assert.equal(insideDir("/j/job-1/", "/j//job-1/workspace/"), true, "separators normalised");
	for (const [outer, inner] of [["/j/job-1", "/j/job-1"], ["/j/job-1", "/j/job-10/workspace"], ["/j/job-1", "/j/elsewhere"], ["/j/job-1", "/j/job-1/../x"], [undefined, "/j/job-1/workspace"], ["/j/job-1", undefined], ["", "/x"], [null, null]]) {
		assert.equal(insideDir(outer, inner), false, JSON.stringify([outer, inner]));
	}
});

test("memoryBytes and memoryBytesOfArgs: the --memory bound in bytes, binary units, null for anything else (issue #596)", async () => {
	const { memoryBytes, memoryBytesOfArgs, containerSpec } = await import("../src/container-spec.mjs");
	assert.equal(memoryBytes("4g"), 4 * 1024 ** 3);
	assert.equal(memoryBytes("4G"), 4 * 1024 ** 3);
	assert.equal(memoryBytes("512m"), 512 * 1024 ** 2);
	assert.equal(memoryBytes("64k"), 64 * 1024);
	assert.equal(memoryBytes("1000"), 1000);
	assert.equal(memoryBytes("1000b"), 1000);
	for (const bad of ["", "4gb", "4t", "-1g", "1.5g", "0", "g", null, undefined, "4 g", "9999999999999999g"]) assert.equal(memoryBytes(bad), null, String(bad));
	// The spec's default, read the way runContainer reads it: off the argv the builder makes.
	const args = buildDockerRunArgs({ image: "i", name: "n", workspace: "/w" });
	assert.equal(memoryBytesOfArgs(args), 4 * 1024 ** 3);
	assert.equal(containerSpec({ image: "i", name: "n", workspace: "/w" }).memory, "4g");
	assert.equal(memoryBytesOfArgs(["run", "--cpus=2"]), null);
	assert.equal(memoryBytesOfArgs(null), null);
});

test("issue #596, phase 2: every job container carries its size as two labels, a fractional CPU budget is a valid --cpus, and no extra flag can relabel", () => {
	const spec = containerSpec({ image: "i", name: "pi-job-1", workspace: "/w", size: { memMiB: 1536, cpuCenti: 50 }, hostCpus: 8, cpuBudgetCenti: 350 });
	assert.deepEqual(spec.labels, { "pi.dispatch.mem": "1536", "pi.dispatch.cpu": "50" });
	const args = dockerArgsFromSpec(spec);
	assert.deepEqual(args.filter((a) => a.startsWith("--label=") || a.startsWith("--cpus=")), ["--cpus=3.5", "--label=pi.dispatch.mem=1536", "--label=pi.dispatch.cpu=50"]);
	assert.equal(args.indexOf("--label=pi.dispatch.mem=1536"), args.indexOf("--shm-size=768m") + 2, "right after the size flags and the parent, before the network");
	// The podman argv is built by the same function, so it carries them too.
	assert.ok(buildPodmanRunArgs({ image: "i", name: "pi-job-1", workspace: "/w", user: "1234:1234", size: { memMiB: 1536, cpuCenti: 50 } }).includes("--label=pi.dispatch.cpu=50"));
	for (const flag of ["--label", "-l", "--label-file"]) {
		assert.ok(DOCKER_EXTRA_FORBIDDEN.includes(flag), `${flag} must be denied`);
		assert.throws(() => buildDockerRunArgs({ image: "i", name: "n", workspace: "/w", extraFlags: [flag, "pi.dispatch.mem=1"] }), /supersede the isolation boundary/, flag);
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Issue #596, phase 2: the parent cgroup every job shares (the aggregate CPU reserve, `cpu-reserve.mjs`).

test("issue #596, phase 2: every docker and podman job argv carries --cgroup-parent=pidispatch.slice exactly once, right after the size flags", () => {
	const job = { image: "i", name: "pi-job-1", workspace: "/w", size: { memMiB: 1536, cpuCenti: 50 } };
	const docker = buildDockerRunArgs(job);
	const podman = buildPodmanRunArgs({ ...job, user: "1234:1234" });
	for (const args of [docker, podman]) {
		assert.deepEqual(args.filter((a) => a.startsWith("--cgroup-parent")), ["--cgroup-parent=pidispatch.slice"]);
		assert.equal(args.indexOf("--cgroup-parent=pidispatch.slice"), args.indexOf("--shm-size=768m") + 1);
	}
	// The literal, not the constant: a constant-derived test is blind to a change IN the value, and a dash would nest.
	assert.equal(containerSpec(job).cgroupParent, "pidispatch.slice");
	assert.ok(!containerSpec(job).cgroupParent.includes("-"));
	// The parent leaves the job's own weight alone: under it a weight orders sibling jobs only.
	assert.ok(docker.includes("--cpu-shares=512"));
	assert.ok(buildDockerRunArgs({ ...job, size: { memMiB: 1536, cpuCenti: 25600 } }).includes("--cpu-shares=262144"));
});

test("issue #596, phase 2: without the parent the flag is absent and the job's shares are capped at 1024, and nothing else may be named", () => {
	const job = { image: "i", name: "pi-job-1", workspace: "/w", size: { memMiB: 4096, cpuCenti: 400 } };
	const spec = containerSpec({ ...job, cgroupParent: null });
	assert.equal(spec.cgroupParent, null);
	assert.equal(spec.cpuShares, 1024);
	const args = dockerArgsFromSpec(spec);
	assert.equal(args.some((a) => a.startsWith("--cgroup-parent")), false);
	assert.ok(args.includes("--cpu-shares=1024"));
	// A size below the cap keeps its own weight: the cap only lowers.
	assert.equal(containerSpec({ ...job, size: { memMiB: 4096, cpuCenti: 50 }, cgroupParent: null }).cpuShares, 512);
	assert.equal(containerSpec({ ...job, cgroupParent: "pidispatch.slice" }).cpuShares, 4096);
	for (const bad of ["pd-jobs.slice", "", "user.slice", "/pidispatch.slice", 0]) {
		assert.throws(() => containerSpec({ ...job, cgroupParent: bad }), /refusing a cgroup parent/, JSON.stringify(bad));
		assert.throws(() => dockerArgsFromSpec({ ...containerSpec(job), cgroupParent: bad }), /refusing a spec whose cgroup parent/, JSON.stringify(bad));
	}
	// A hand-built spec from before the field asked for no parent.
	const { cgroupParent: _p, ...legacy } = containerSpec(job);
	assert.equal(dockerArgsFromSpec(legacy).some((a) => a.startsWith("--cgroup-parent")), false);
});

test("issue #596, phase 2: --cgroup-parent is refused in dockerExtra in both spellings", () => {
	assert.ok(DOCKER_EXTRA_FORBIDDEN.includes("--cgroup-parent"));
	for (const extra of [["--cgroup-parent=other.slice"], ["--cgroup-parent", "other.slice"], ["--cgroup-parent=pidispatch.slice"]]) {
		assert.throws(() => buildDockerRunArgs({ image: "i", name: "n", workspace: "/w", extraFlags: extra }), /supersede the isolation boundary/, JSON.stringify(extra));
		assert.throws(() => buildPodmanRunArgs({ image: "i", name: "n", workspace: "/w", user: "1234:1234", extraFlags: extra }), /supersede the isolation boundary/, JSON.stringify(extra));
	}
});

test("issue #596, phase 2: only the job builder and the reserve's helper spell --cgroup-parent; the egress proxy, Valkey and the deploy units never carry it", async () => {
	const dir = new URL("../src/", import.meta.url);
	const hits = readdirSync(dir).filter((f) => f.endsWith(".mjs")).filter((f) => readFileSync(new URL(f, dir), "utf8").includes("--cgroup-parent="));
	assert.deepEqual(hits.sort(), ["cpu-reserve.mjs", "docker-run.mjs"]);
	const { valkeyDockerRunArgs, valkeyOwnerCheckArgs } = await import("../src/valkey-auth.mjs");
	for (const args of [valkeyDockerRunArgs({}), valkeyOwnerCheckArgs("/srv/d")]) assert.equal(args.some((a) => String(a).includes("cgroup")), false);
	const deploy = new URL("../../deploy/", import.meta.url);
	for (const f of readdirSync(deploy)) assert.equal(/cgroup.?parent|pidispatch\.slice/i.test(readFileSync(new URL(f, deploy), "utf8")), false, f);
	// up.mjs runs the proxy from a literal argv; it names no parent.
	assert.equal(readFileSync(new URL("up.mjs", dir), "utf8").includes("cgroup"), false);
});

test("the argv pins the working directory to the workspace mount, on docker and podman alike, and a dockerExtra cannot move it (#683)", () => {
	// The image's WORKDIR moved to /sandbox (a copying venue's tree); a binding venue's job must still start in its repo.
	for (const args of [buildDockerRunArgs(base), buildPodmanRunArgs({ ...base, user: "1234:1234" })]) {
		assert.deepEqual(args.filter((a) => a.startsWith("--workdir") || a === "-w"), ["--workdir=/workspace"]);
		assert.equal(args[args.length - 2], "--workdir=/workspace", "last before the image, after every dockerExtra token");
	}
	for (const flag of ["--workdir", "-w"]) {
		assert.ok(DOCKER_EXTRA_FORBIDDEN.includes(flag), `${flag} must be denied`);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [flag, "/"] }), /supersede the isolation boundary/, flag);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [`${flag}=/`] }), /supersede the isolation boundary/, flag);
	}
});

test("the image's WORKDIR is /sandbox, owned by its user, and /workspace still exists in it (#683)", () => {
	const dockerfile = readFileSync(new URL("../../image/Dockerfile", import.meta.url), "utf8");
	assert.deepEqual([...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].map((m) => m[1]).slice(-1), ["/sandbox"], "the final stage's last WORKDIR");
	assert.match(dockerfile, /^RUN mkdir -p \/sandbox \/workspace && chown pi:pi \/sandbox && chmod 0755 \/sandbox \/workspace$/m);
});

// --- issue #1114: credentials leave the runtime client's argv ------------------------------------------------------

/** The env tokens the builder emitted before issue #1114: `-e NAME=VALUE` for every defined entry, in order. */
const legacyEnvArgs = (env) => Object.entries(env ?? {}).filter(([, v]) => v !== undefined && v !== null).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

/** Arbitrary secret names a run secret or a forwarded variable could carry: fixed, so the test reads the same every run. */
const arbitraryNames = Array.from({ length: 24 }, (_, i) => `X${createHash("sha256").update(`name-${i}`).digest("hex").slice(0, 10).toUpperCase()}`);

test("issue #1114: no credential value the worker writes is on the argv, and the client env rebuilds the closed map exactly", () => {
	// Every forge token name a mint writes, the provider credentials pi reads, the worker's own names that are in no
	// structural list (they go bare too, the safe direction), and arbitrary secret names.
	const secretNames = [...MINTED_TOKEN_VARS, "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_OPENAI_API_KEY", "PI_JOB_IDLE_MS", "PI_JOB_STALL_MS", "PI_JOB_MAX_MS", "PI_JOB_LEFT_MS", "PI_CREDENTIAL_REFRESH", "PI_PACKAGE_CANARY", "PI_SUBSCRIPTION_AUTH", ...arbitraryNames];
	const secrets = Object.fromEntries(secretNames.map((name, i) => [name, `sk-test-${i}-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`]));
	const env = { PI_PROVIDER: "anthropic", PI_MODEL: "m", PI_JOB_ID: "pi-job-1", HOME: "/home/pi", ...egressEnv({ armed: true }), ...secrets };
	for (const args of [buildDockerRunArgs({ ...base, env }), buildPodmanRunArgs({ ...base, env, user: "1234:1234" })]) {
		for (const [name, value] of Object.entries(secrets)) {
			assert.equal(args.some((a) => a.includes(value)), false, `${name}'s value is on the argv`);
			assert.equal(args[args.indexOf(name) - 1], "-e", `${name} is a bare -e NAME`);
		}
		assert.deepEqual(containerEnvOf(args, { env: jobClientEnv(env, { PATH: "/usr/bin" }) }), env);
	}
	const { bare, kept } = jobEnvArgs(env, { workerSet: egressEnv({ armed: true }) });
	assert.deepEqual(bare, secrets);
	assert.deepEqual(kept, [], "nothing secret stays inline: the egress variables are the worker's own");
});

test("issue #1114: what stays -e NAME=VALUE: a structural name, the egress set, the terminal pair, an empty value, a client name in any case, a case twin that is not the upper-case spelling, a name no shell spells", () => {
	const structural = Object.fromEntries([...NON_SECRET_ENV_KEYS].map((name) => [name, `v-${name}`]));
	const egress = egressEnv({ armed: true });
	const terminal = { TERM: "xterm", TMOUT: "600" };
	assert.deepEqual(jobEnvArgs({ ...structural, ...egress, ...terminal, EMPTY_SECRET: "" }), { args: legacyEnvArgs({ ...structural, ...egress, ...terminal, EMPTY_SECRET: "" }), bare: {}, kept: [...EGRESS_ENV_KEYS] });
	// A private endpoint's host and port are structural through the same function the redactor asks.
	assert.deepEqual(jobEnvArgs({ PI_DISPATCH_ENDPOINT_NAS_HOST: "192.168.1.5", PI_DISPATCH_ENDPOINT_NAS_PORT: "5000" }).bare, {});
	// Every guard name and a name under every guard prefix, upper, lower and mixed: inline, and named in `kept`.
	const spellings = (name) => [name, name.toLowerCase(), name.split("").map((c, i) => (i % 2 ? c.toLowerCase() : c)).join("")];
	const guarded = [...CLIENT_ENV_GUARD.names, ...CLIENT_ENV_GUARD.prefixes.map((p) => `${p}SECRET`)].flatMap(spellings).filter((name) => !NON_SECRET_ENV_KEYS.has(name) && !EGRESS_ENV_KEYS.includes(name));
	for (const name of guarded) {
		assert.ok(isClientEnvGuarded(name), name);
		assert.deepEqual(jobEnvArgs({ [name]: "sk-test-guarded" }), { args: ["-e", `${name}=sk-test-guarded`], bare: {}, kept: [name] }, name);
	}
	for (const name of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "PIDOCKER_X", "SSHKEY", "LDAP_PASSWORD", "XDGX", "DOCKERHUB_TOKEN"]) assert.equal(isClientEnvGuarded(name), false, name);
	// Names Windows would hold as one: the upper-case spelling goes bare as it would alone (the minted token's name, here
	// beside an operator's twin, never reaches the argv), and every other spelling stays inline and is kept.
	assert.deepEqual(jobEnvArgs({ GITHUB_TOKEN: "sk-test-a", github_token: "sk-test-b", OTHER: "sk-test-c" }), { args: ["-e", "GITHUB_TOKEN", "-e", "github_token=sk-test-b", "-e", "OTHER"], bare: { GITHUB_TOKEN: "sk-test-a", OTHER: "sk-test-c" }, kept: ["github_token"] });
	assert.deepEqual(jobEnvArgs({ api_key: "sk-test-l", Api_Key: "sk-test-m", API_KEY: "sk-test-u" }), { args: ["-e", "api_key=sk-test-l", "-e", "Api_Key=sk-test-m", "-e", "API_KEY"], bare: { API_KEY: "sk-test-u" }, kept: ["api_key", "Api_Key"] }, "three spellings, whatever their order");
	assert.deepEqual(jobEnvArgs({ Foo_Key: "sk-test-f", foo_key: "sk-test-g" }).kept, ["Foo_Key", "foo_key"], "a group with no upper-case spelling stays inline whole");
	assert.deepEqual(jobEnvArgs({ PI_MODEL: "m", pi_model: "sk-test-d" }).kept, ["pi_model"], "a twin of a structural name too");
	assert.deepEqual(jobEnvArgs({ DOCKER_HOST: "tcp://a.invalid", docker_host: "tcp://b.invalid" }).bare, {}, "an upper-case spelling the guard holds stays inline too");
	// One key per folded name in the client's environment, so a Windows dedupe has nothing to choose between.
	const twinClient = jobClientEnv({ GITHUB_TOKEN: "sk-test-a", github_token: "sk-test-b" }, { github_token: "sk-test-host", PATH: "/usr/bin" });
	assert.deepEqual(Object.entries(twinClient).filter(([k]) => k.toUpperCase() === "GITHUB_TOKEN"), [["GITHUB_TOKEN", "sk-test-a"]]);
	// Podman globs a bare `NAME*`, and a `=` would split where the CLI splits: a name outside the pattern is never bare.
	for (const name of ["FOO*", "FOO-BAR", "1ABC", "A.B", "A B", "ÄX", ""]) {
		assert.equal(BARE_ENV_NAME.test(name), false, JSON.stringify(name));
		assert.deepEqual(jobEnvArgs({ [name]: "sk-test-e" }), { args: ["-e", `${name}=sk-test-e`], bare: {}, kept: [name] }, JSON.stringify(name));
	}
	for (const name of ["A", "_", "_A1", "lower_case", "GITHUB_TOKEN"]) assert.equal(BARE_ENV_NAME.test(name), true, name);
	// The egress variables are kept only while their value is not the one the worker wrote; the argv is the same both ways.
	assert.deepEqual(jobEnvArgs({ HTTPS_PROXY: "http://user:pw@proxy:3128" }, { workerSet: egress }), { args: ["-e", "HTTPS_PROXY=http://user:pw@proxy:3128"], bare: {}, kept: ["HTTPS_PROXY"] });
	assert.ok(Object.isFrozen(CLIENT_ENV_GUARD) && Object.isFrozen(CLIENT_ENV_GUARD.names) && Object.isFrozen(CLIENT_ENV_GUARD.prefixes));
});

test("issue #1114: the client env drops every host key a bare name folds to, and keeps the host's value of every name the client acts on", () => {
	const env = { GITHUB_TOKEN: "sk-test-job", docker_host: "tcp://job.invalid:2375", CONTAINER_HOST: "ssh://job.invalid", CONTAINERS_CONF_OVERRIDE: "/job/containers.conf", _CONTAINERS_USERNS_CONFIGURED: "job" };
	const host = { PATH: "/usr/bin", GITHUB_TOKEN: "sk-test-host", github_token: "sk-test-host-lower", Github_Token: "sk-test-host-mixed", DOCKER_HOST: "unix:///worker.sock", CONTAINER_HOST: "unix:///worker-podman.sock", CONTAINERS_CONF_OVERRIDE: "/worker/containers.conf", _CONTAINERS_USERNS_CONFIGURED: "worker" };
	const clientEnv = jobClientEnv(env, host);
	assert.deepEqual(Object.keys(clientEnv).filter((k) => k.toUpperCase() === "GITHUB_TOKEN"), ["GITHUB_TOKEN"], "one key, so a Windows dedupe has nothing to choose between");
	assert.equal(clientEnv.GITHUB_TOKEN, "sk-test-job");
	for (const key of ["PATH", "DOCKER_HOST", "CONTAINER_HOST", "CONTAINERS_CONF_OVERRIDE", "_CONTAINERS_USERNS_CONFIGURED"]) assert.equal(clientEnv[key], host[key], key);
	assert.equal(Object.hasOwn(clientEnv, "docker_host"), false, "a guarded job name never enters the client's environment");
	// A job with no bare name hands the client the host's environment unchanged.
	assert.deepEqual(jobClientEnv({ PI_MODEL: "m" }, host), host);
	// Node on win32 keeps the first of keys that differ only by case (sorted); what survives is still the job's value.
	const win32 = Object.fromEntries(Object.entries(clientEnv).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([k], i, all) => all.findIndex(([o]) => o.toUpperCase() === k.toUpperCase()) === i));
	assert.equal(win32.GITHUB_TOKEN, "sk-test-job");
	// A name like `__proto__` is an own key, never a prototype write that drops it.
	assert.equal(Object.hasOwn(jobEnvArgs({ __proto__x: "1", ["__proto__"]: "sk-test-p" }).bare, "__proto__"), true);
});

test("issue #1114: the pre-spawn check holds the env flags to the job's env exactly, reading every token but the last (the image), and never refuses a real argv", () => {
	const env = { PI_MODEL: "m", GITHUB_TOKEN: "sk-test-job" };
	const args = buildDockerRunArgs({ ...base, env });
	const clientEnv = jobClientEnv(env, { PATH: "/usr/bin", GITHUB_TOKEN: "sk-test-host" });
	assert.doesNotThrow(() => assertJobEnvArgv(args, env, clientEnv));
	const image = args.at(-1);
	const head = args.slice(0, -1);
	const withoutCredential = head.filter((a, i) => !(a === "GITHUB_TOKEN" || (a === "-e" && head[i + 1] === "GITHUB_TOKEN")));
	const refused = [
		[[...head, "-e", "GITHUB_TOKEN=sk-test-job", image], /carries the value of GITHUB_TOKEN/],
		[[...head, "--env", "GITHUB_TOKEN=sk-test-job", image], /carries the value of GITHUB_TOKEN/],
		[[...head, "--env=GITHUB_TOKEN=sk-test-job", image], /carries the value of GITHUB_TOKEN/],
		[head.map((a) => (a === "GITHUB_TOKEN" ? "GITHUB_TOKEN=sk-test-job" : a)).concat(image), /carries the value of GITHUB_TOKEN/],
		[[...head, "-e", "github_token=sk-test-job", image], /entry 3 is github_token with a value where nothing was due/],
		[[...head, "-e", "AWS_SECRET_ACCESS_KEY", image], /bare -e AWS_SECRET_ACCESS_KEY whose value is not this job's/],
		[[...head, "-e", "github_token", image], /bare -e github_token whose value is not this job's/],
		[[...head, "-e", "AWS_SECRET_ACCESS_KEY=sk-test-other", image], /entry 3 is AWS_SECRET_ACCESS_KEY with a value where nothing was due/],
		[[...withoutCredential, image], /entry 2 is nothing where a bare GITHUB_TOKEN was due/],
		[head.map((a) => (a === "PI_MODEL=m" ? "PI_MODEL=sk-test-other" : a)).concat(image), /entry 1 gives PI_MODEL a value other than the job's/],
		[[...head, "-eGITHUB_TOKEN=sk-test-job", image], /fused env flag for GITHUB_TOKEN/],
		[[...head, "-e=GITHUB_TOKEN=sk-test-job", image], /fused env flag for GITHUB_TOKEN/],
		[[...head, "-e", image], /last -e has no entry before the image/],
		[[...head, "--env", image], /last --env has no entry before the image/],
		// Every token but the last is read: one after the image is a job argv no builder makes, and it is read too.
		[[...args, "-e", "GITHUB_TOKEN=sk-test-job", "more"], /carries the value of GITHUB_TOKEN/],
	];
	for (const [argv, why] of refused) {
		assert.throws(() => assertJobEnvArgv(argv, env, clientEnv), (error) => why.test(error.message) && !error.message.includes("sk-test"), why.source);
	}
	assert.throws(() => assertJobEnvArgv(args, env, { ...clientEnv, GITHUB_TOKEN: "sk-test-host" }), /bare -e GITHUB_TOKEN whose value is not this job's/, "the client must hold the JOB's value");
	assert.throws(() => assertJobEnvArgv(args, env, { PATH: "/usr/bin" }), /bare -e GITHUB_TOKEN/, "and hold it at all");
	// Env flags only: a value the builder put in another flag is a builder defect this check does not look for.
	assert.doesNotThrow(() => assertJobEnvArgv([...head, "--label=x=sk-test-job", image], env, clientEnv));
	// Every argv a builder makes passes: both runtimes, twins, guarded names, empty values, the egress set, no env at all,
	// and the extra flags the callers pass (the signed exit line's `-i`, the sandbox's, the probes').
	const shapes = [
		env,
		{},
		{ PI_MODEL: "m", GITHUB_TOKEN: "sk-test-a", github_token: "sk-test-b", docker_host: "tcp://x.invalid", EMPTY: "", "FOO-BAR": "sk-test-c", ...egressEnv({ armed: true }) },
		{ HOME: "/home/pi", TERM: "xterm", TMOUT: "60", ANTHROPIC_API_KEY: "sk-test-d", PI_PACKAGE_CANARY: "/job/canary/x" },
	];
	for (const shape of shapes) {
		for (const extraFlags of [[], ["-i"], ["-i", "-t", "--entrypoint", "bash"], ["-d"]]) {
			for (const argv of [buildDockerRunArgs({ ...base, env: shape, extraFlags }), buildPodmanRunArgs({ ...base, env: shape, extraFlags, user: "1234:1234", cgroupParent: null })]) {
				assert.doesNotThrow(() => assertJobEnvArgv(argv, shape, jobClientEnv(shape, { PATH: "/usr/bin" })), JSON.stringify(Object.keys(shape)));
			}
		}
	}
});

test("issue #1114: the sandbox, the live and display probes and doctor's canaries emit no bare name, so their argv is byte for byte what it was", () => {
	const egress = egressEnv({ armed: true });
	for (const venue of ["local", "podman"]) {
		const args = buildSandboxRunArgs({ venue, image: "pi-job:pinned", name: "pi-sandbox-gh-1", workspace: "/w", jobDir: "/j", term: "xterm", idleSeconds: 600, network: "pi-sandbox-gh-1-net", egressEnv: egress, user: "1234:1234", home: "/home/pi" });
		const expected = { TERM: "xterm", TMOUT: "600", HOME: "/home/pi", ...jobSizeEnv(DEFAULT_JOB_SIZE), ...egress };
		assert.deepEqual(args.filter((_, i) => args[i - 1] === "-e"), legacyEnvArgs(expected).filter((_, i) => i % 2 === 1), venue);
	}
	const fixture = liveFixture("/srv/doctor");
	for (const buildArgs of [buildDockerRunArgs, (opts) => buildPodmanRunArgs({ ...opts, user: "1:1" })]) {
		for (const args of [liveProbeRunArgs({ image: "i", name: "n", fixture, buildArgs }), pinningProbeRunArgs({ name: "n", nonce: "x", fixture, buildArgs }), ephemeralRunArgs({ image: "i", name: "n", fixture, nonce: "x", run: 1, buildArgs }), peerRunArgs({ image: "i", name: "n", fixture, network: "net", nonce: "x", buildArgs })]) {
			assert.equal(args.includes("-e"), false, "a probe has no environment at all");
		}
	}
	for (const bin of ["docker", "podman"]) {
		const args = egressCanaryProbeArgs({ bin, slug: "provider", pid: 1, network: "n", proxy: "p", image: "pi-job:pinned", url: "https://x", user: "1234:1234", httpProxy: true });
		const head = args.slice(0, args.indexOf("pi-job:pinned"));
		assert.ok(head.filter((_, i) => head[i - 1] === "-e").every((t) => t.includes("=")), `${bin}: every -e before the image carries its value`);
	}
	// The CI scripts' env shapes (job-user-e2e.mjs, podman-host-check.mjs: their names, with placeholder values) build
	// exactly the legacy tokens.
	for (const shape of [{ PI_PROVIDER: "p", PI_MODEL: "m", PI_MAX_TURNS: "1" }, { PI_PROVIDER: "p", PI_MODEL: "m", PI_MAX_TURNS: "1", HOME: CONTAINER_HOME }, { HOME: CONTAINER_HOME }, {}]) {
		assert.deepEqual(jobEnvArgs(shape), { args: legacyEnvArgs(shape), bare: {}, kept: [] });
	}
});

test("issue #1114: the network canary smoke's probe variable goes bare, and the script hands its run the client env built from the same map", () => {
	// The script's own build (.github/scripts/canary-network-smoke.mjs), which cannot be imported: it runs docker at load.
	const env = { PROBE_PROXY: "pi-dispatch-canary-smoke-1-proxy" };
	const args = buildDockerRunArgs({ image: "pi-job:pinned", name: "pi-dispatch-canary-smoke-1", network: "n-in", jobDir: "/r/job", workspace: "/r/workspace", env, extraFlags: ["--entrypoint", "node"] });
	assert.equal(args[args.indexOf("PROBE_PROXY") - 1], "-e");
	assert.deepEqual(containerEnvOf(args, { env: jobClientEnv(env, {}) }), env);
	const script = readFileSync(new URL("../../.github/scripts/canary-network-smoke.mjs", import.meta.url), "utf8");
	assert.match(script, /buildDockerRunArgs\(\{[^\n]*env, extraFlags/);
	assert.match(script, /await docker\(\[\.\.\.args, "--eval", probe\], jobClientEnv\(env\)\)/);
});
