import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { CONTAINER_HOME, SHIPPED_IMAGE_UID } from "../src/container-spec.mjs";
import { buildDockerRunArgs, containerSpec, DOCKER_EXTRA_ALLOWED, dockerArgsFromSpec, ISOLATION_FLAGS } from "../src/docker-run.mjs";

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

test("env is an explicit -e NAME=VALUE allowlist, never a pass-through or --env-file", () => {
	const args = buildDockerRunArgs(base);
	assert.ok(args.includes("-e") && args.includes("ANTHROPIC_API_KEY=sk-real"));
	assert.ok(!args.includes("--env-file"), "must never use --env-file");
	// No bare `-e NAME` (which would inherit the host value) -- every -e is followed by NAME=VALUE.
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e") assert.match(args[i + 1], /=/, `bare -e ${args[i + 1]} would inherit from host`);
	}
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
	assert.deepEqual(hits, []);
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
		"--shm-size=1g",
	]);
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
		{ image: "i", name: "n", workspace: "/w", memory: "8g", cpus: "4" },
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
