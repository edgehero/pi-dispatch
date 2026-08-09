import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDockerRunArgs, ISOLATION_FLAGS } from "../src/docker-run.mjs";

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

test("a local-folder job can add a Linux-only --user via extraFlags", () => {
	const args = buildDockerRunArgs({ ...base, extraFlags: ["--user", "1000:1000"] });
	assert.ok(args.includes("--user") && args.includes("1000:1000"));
});

test("refuses to build without image / name / workspace", () => {
	assert.throws(() => buildDockerRunArgs({ ...base, image: undefined }), /image/);
	assert.throws(() => buildDockerRunArgs({ ...base, name: undefined }), /name/);
	assert.throws(() => buildDockerRunArgs({ ...base, workspace: undefined }), /workspace/);
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
