import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRunContainer } from "../src/run-container.mjs";
import { makeLogSink } from "../src/run-history.mjs";
import { SECRET_FILES_DIR_SUFFIX, SECRET_FILES_SUBDIR } from "../src/secret-files.mjs";
import { bundleProviderPlan, openshellExecArgs, sandboxPathOf, judgeBundle } from "../src/backend-openshell.mjs";
import { containerSpec, transfersFromSpec } from "../src/container-spec.mjs";

const VALUE = "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop123456789\n-----END PRIVATE KEY-----\n";
const JOB = { kind: "local", provider: "anthropic", model: "m", maxTurns: 1 };
function fixture() {
	const jobDir = tempDir("job-");
	const workspace = join(jobDir, "workspace"); mkdirSync(workspace);
	return { jobDir, workspace };
}
const child = (fn) => {
	const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
	queueMicrotask(() => fn(c)); return c;
};

test("a real staged secret is 0600 outside the workspace, paths alone enter argv, and both output pipes redact", async () => {
	const prepared = fixture();
	const root = `${prepared.jobDir}${SECRET_FILES_DIR_SUFFIX}`;
	const path = join(root, SECRET_FILES_SUBDIR, "DEVICE_SSH_KEY");
	const logsDir = tempDir("secret-file-logs-");
	const output = [];
	const run = makeRunContainer({ image: "image:pinned", hostEnv: { ANTHROPIC_API_KEY: "provider-test-value" }, onOutput: (c) => output.push(Buffer.from(c)), openJobLog: makeLogSink({ logsDir, enabled: true }), spawnFn: (_bin, args) => {
		assert.equal(readFileSync(path, "utf8"), VALUE);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(path).uid, process.geteuid());
		assert.ok(args.includes(`${join(root, SECRET_FILES_SUBDIR)}:/run/secrets:ro`));
		assert.ok(args.includes("DEVICE_SSH_KEY=/run/secrets/DEVICE_SSH_KEY"));
		assert.ok(!args.join(" ").includes(VALUE));
		return child((c) => {
			c.stdout.emit("data", Buffer.from(VALUE.slice(0, 40)));
			c.stderr.emit("data", Buffer.from("unrelated diagnostic\n"));
			c.stdout.emit("data", Buffer.from(VALUE.slice(40)));
			c.emit("close", 0);
		});
	} });
	await run({ job: JOB, prepared, secretFiles: { DEVICE_SSH_KEY: VALUE }, name: "file-secret", signal: new AbortController().signal });
	assert.equal(existsSync(root), false);
	for (const text of [Buffer.concat(output).toString(), readFileSync(join(logsDir, "file-secret.log"), "utf8")]) {
		assert.ok(!text.includes("abcdefghijklmnop")); assert.ok(text.includes("[redacted]"));
	}
	assert.ok(prepared.questionRedact(VALUE).includes("[redacted]"));
	assert.ok(prepared.credentialSecretValues.includes(VALUE));
});

test("every pre-spawn and running failure path removes secret files", async () => {
	for (const fault of ["env", "args", "stage", "spawn", "error", "abort"]) {
		const prepared = fixture();
		const ac = new AbortController();
		const run = makeRunContainer({ image: "image:pinned", hostEnv: fault === "env" ? {} : { ANTHROPIC_API_KEY: "provider-test-value" }, onOutput() {},
			...(fault === "args" ? { buildArgs: () => { throw new Error("argv fault"); } } : {}),
			...(fault === "stage" ? { stageRun: () => { throw new Error("stage fault"); }, teardownRun: async () => {} } : {}),
			spawnFn: () => {
				if (fault === "spawn") throw new Error("spawn fault");
				return child((c) => { if (fault === "error") c.emit("error", new Error("spawn fault")); else { ac.abort(); c.emit("close", 137); } });
			},
		});
		try { await run({ job: JOB, prepared, secretFiles: { DEVICE_SSH_KEY: VALUE }, name: "file-secret", signal: ac.signal }); }
		catch { assert.notEqual(fault, "abort"); }
		assert.equal(existsSync(`${prepared.jobDir}${SECRET_FILES_DIR_SUFFIX}`), false, fault);
	}
});

test("log opening, output collection and venue teardown failures cannot retain staged file secrets", async () => {
	for (const fault of ["log", "collect", "teardown"]) {
		const prepared = fixture();
		const run = makeRunContainer({
			image: "image:pinned", hostEnv: { ANTHROPIC_API_KEY: "provider-test-value" }, onOutput() {},
			stageRun: async () => {},
			teardownRun: async () => { if (fault === "teardown") throw new Error("venue teardown failed"); },
			...(fault === "log" ? { openJobLog: () => { throw new Error("log opening failed"); } } : {}),
			...(fault === "collect" ? { collectRun: async () => { throw new Error("output collection failed"); } } : {}),
			spawnFn: () => child((c) => c.emit("close", 0)),
		});
		const pending = run({ job: JOB, prepared, secretFiles: { DEVICE_SSH_KEY: VALUE }, name: "file-secret", signal: new AbortController().signal });
		if (fault === "teardown") assert.equal((await pending).code, 0, "best-effort teardown preserves the completed outcome");
		else await assert.rejects(pending, /failed/);
		assert.equal(existsSync(`${prepared.jobDir}${SECRET_FILES_DIR_SUFFIX}`), false, fault);
	}
});

test("an ungranted job creates no directory, mount or file-path environment", async () => {
	const prepared = fixture();
	const run = makeRunContainer({ image: "image:pinned", hostEnv: { ANTHROPIC_API_KEY: "provider-test-value" }, onOutput() {}, spawnFn: (_bin, args) => {
		assert.ok(!args.join(" ").includes("/run/secrets"));
		assert.ok(!args.join(" ").includes("PI_SECRET_FILES"));
		return child((c) => c.emit("close", 0));
	} });
	await run({ job: JOB, prepared, name: "ungranted", signal: new AbortController().signal });
	assert.equal(existsSync(`${prepared.jobDir}${SECRET_FILES_DIR_SUFFIX}`), false);
});

test("OpenShell files are input-only transfers and structural paths, never provider placeholders", () => {
	const spec = containerSpec({ image: "i", name: "n", workspace: "/tmp/ws", secretFilesDir: "/tmp/job-abc.secret-files/secrets" });
	const transfer = transfersFromSpec(spec, { binds: false }).find((t) => t.container === "/run/secrets");
	assert.equal(transfer.direction, "in"); assert.equal(sandboxPathOf(transfer.container), "/sandbox/secrets");
	for (const mode of ["copy", "bind"]) {
		const path = `${mode === "copy" ? "/sandbox/secrets" : "/run/secrets"}/DEVICE_SSH_KEY`;
		const env = { DEVICE_SSH_KEY: path, ANTHROPIC_API_KEY: "opaque-provider-key" };
		const plan = bundleProviderPlan({ name: "test", env, secretFileNames: ["DEVICE_SSH_KEY"] });
		assert.deepEqual(plan.job.keys, ["ANTHROPIC_API_KEY"]);
		const args = openshellExecArgs({ name: "test", env, mode, secretFileNames: ["DEVICE_SSH_KEY"] });
		assert.ok(args.includes(`DEVICE_SSH_KEY=${path}`)); assert.ok(!args.join(" ").includes("opaque-provider-key"));
	}
	for (const name of ["USER", "SHELL", "TERM", "OPENSHELL_PRIVATE"]) assert.equal(judgeBundle({ fileNames: [name] }).refused, "openshell-bundle-name-taken");
});
