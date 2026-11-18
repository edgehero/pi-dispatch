import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { BESIDE_JOB_DIR, makeSalvager } from "../src/recovery-queue.mjs";
import { SECRET_FILES_DIR_SUFFIX, SECRET_FILES_OWNER, SECRET_FILES_SUBDIR, stageSecretFiles, removeSecretFiles, secretFileProcessIdentity, sweepSecretFiles } from "../src/secret-files.mjs";

const BOOT = "11111111-1111-1111-1111-111111111111";
const OWNER = { pid: 12345, start: `linux:${BOOT}:1234` };
const value = "-----BEGIN PRIVATE KEY-----\nfixture-secret-material\n-----END PRIVATE KEY-----\r\n";
function fixture(name = "job-fixture") {
	const jobsDir = tempDir("pi-secret-files-");
	const jobDir = join(jobsDir, name);
	fs.mkdirSync(jobDir, { mode: 0o700 });
	return { jobsDir, jobDir };
}
const stage = (jobDir, values = { DEVICE_SSH_KEY: value }, opts = {}) => stageSecretFiles(jobDir, values, { owner: OWNER, ...opts });
const dead = () => ({ alive: false, start: null });

test("salvage cannot override an owner keep, even after its bind sandbox has settled", async () => {
	for (const backend of ["local", "openshell-bind"]) {
		for (const identity of [() => ({ alive: true, start: OWNER.start }), () => ({ alive: null, start: null })]) {
			const { jobsDir, jobDir } = fixture();
			const dir = stage(jobDir, undefined, { backend });
			if (backend === "openshell-bind") fs.writeFileSync(`${jobDir}.openshell-bind`, "bound");
			assert.equal((await sweepSecretFiles({ jobsDir, reapedBackends: [backend], identity })).kept, 1);
			let settlements = 0;
			const salvage = makeSalvager({
				jobsDir, hostName: "worker", workspaceCheckpointer: { readManifest: async () => ({ ok: false }) },
				settleJobDir: async () => { settlements++; return true; },
			});
			assert.deepEqual(await salvage({ runId: "run", pointer: { host: "worker", jobDir: "job-fixture" } }), { skipped: "no-checkpoint" });
			assert.equal(settlements, backend === "openshell-bind" ? 1 : 0);
			assert.equal(fs.existsSync(jobDir), false);
			assert.deepEqual(fs.readFileSync(join(dir, SECRET_FILES_SUBDIR, "DEVICE_SSH_KEY")), Buffer.from(value));
			assert.equal((await sweepSecretFiles({ jobsDir, reapedBackends: [backend], identity: dead })).removed, 1, "a later proven-dead owner is swept without the job directory");
		}
	}
});

test("file contents preserve all UTF-8 bytes and newline forms, modes and owner metadata stay outside the mount", () => {
	const { jobDir } = fixture();
	const values = { KEY: value, RAW: "without final newline", LF: "one\n", CRLF: "one\r\n", UNICODE: "é漢字\n" };
	const dir = stage(jobDir, values);
	assert.equal(dir, `${jobDir}${SECRET_FILES_DIR_SUFFIX}`);
	assert.equal(SECRET_FILES_SUBDIR, "secrets", "OpenShell uploads this directory directly: its basename matches /sandbox/secrets, with no duplicate staging copy");
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	const files = join(dir, SECRET_FILES_SUBDIR);
	assert.equal(fs.statSync(files).mode & 0o777, 0o700);
	assert.deepEqual(fs.readdirSync(files).sort(), Object.keys(values).sort());
	for (const [name, text] of Object.entries(values)) {
		const file = join(files, name);
		assert.deepEqual(fs.readFileSync(file), Buffer.from(text));
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.statSync(file).uid, process.geteuid?.() ?? fs.statSync(file).uid);
	}
	assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, SECRET_FILES_OWNER), "utf8")), { v: 1, ...OWNER, backend: "local" });
	assert.equal(fs.existsSync(join(jobDir, SECRET_FILES_SUBDIR)), false);
	assert.ok(BESIDE_JOB_DIR.includes(SECRET_FILES_DIR_SUFFIX));
	assert.equal(removeSecretFiles(dir), true);
	assert.equal(fs.existsSync(dir), false);
	assert.equal(fs.existsSync(jobDir), true);
});

test("staging refuses names that alias on a case-insensitive volume, paths, unsupported text, and an existing directory", () => {
	const { jobDir } = fixture();
	for (const values of [{ KEY: "a", key: "b" }, { CON: "secret" }, { nul: "secret" }, { COM1: "secret" }, { "../KEY": "v" }, { ["A".repeat(129)]: "v" }, { KEY: "" }, { KEY: "nul\0value" }, { KEY: "bad\ud800" }, { KEY: "a".repeat(64 * 1024 + 1) }, [], {}]) {
		assert.throws(() => stage(jobDir, values), /secret files could not be staged/);
		assert.equal(fs.existsSync(`${jobDir}${SECRET_FILES_DIR_SUFFIX}`), false);
	}
	const dir = stage(jobDir);
	assert.throws(() => stage(jobDir, { OTHER: "new" }), /secret files could not be staged/);
	assert.deepEqual(fs.readFileSync(join(dir, SECRET_FILES_SUBDIR, "DEVICE_SSH_KEY")), Buffer.from(value), "an existing attempt is never overwritten or deleted");
});

test("owner is durably published before content; partial write failure removes files without exposing the value", () => {
	const { jobDir } = fixture();
	const operations = [];
	let opens = 0;
	const fakeFs = {
		...fs,
		openSync(path, flags, mode) {
			operations.push(["open", typeof path === "string" ? path : "fd"]);
			if (typeof path === "string" && path.endsWith("DEVICE_SSH_KEY")) {
				opens++;
				throw Object.assign(new Error(value), { code: "ENOSPC" });
			}
			return fs.openSync(path, flags, mode);
		},
		fsyncSync(fd) { operations.push(["sync"]); fs.fsyncSync(fd); },
	};
	assert.throws(() => stage(jobDir, undefined, { fs: fakeFs }), (error) => error.message === "secret files could not be staged" && error.code === "ENOSPC");
	assert.equal(opens, 1);
	assert.ok(operations.findIndex(([kind]) => kind === "sync") < operations.findIndex(([, path]) => path?.endsWith("DEVICE_SSH_KEY")));
	assert.equal(fs.existsSync(`${jobDir}${SECRET_FILES_DIR_SUFFIX}`), false);
});

test("cleanup faults are named without their error payload", () => {
	const logs = [];
	assert.equal(removeSecretFiles("/unused", { fs: { rmSync() { throw Object.assign(new Error(value), { code: "EACCES" }); } }, log: (event, fields) => logs.push({ event, ...fields }) }), false);
	assert.deepEqual(logs, [{ event: "secret_files_remove_failed", code: "EACCES" }]);
});

test("boot sweep removes dead attempt secrets immediately even when the workspace remains for recovery", async () => {
	const { jobsDir, jobDir } = fixture();
	const dir = stage(jobDir);
	fs.writeFileSync(join(jobDir, "keep-for-recovery"), "checkpoint");
	const out = await sweepSecretFiles({ jobsDir, reapedBackends: ["local"], identity: dead });
	assert.deepEqual(out, { removed: 1, kept: 0, failed: 0 });
	assert.equal(fs.existsSync(dir), false);
	assert.equal(fs.readFileSync(join(jobDir, "keep-for-recovery"), "utf8"), "checkpoint");
});

test("boot sweep removes a dead pre-spawn attempt and orphan whose job directory is already gone", async () => {
	const { jobsDir, jobDir } = fixture();
	const dir = stage(jobDir, undefined, { backend: "podman" });
	fs.rmSync(jobDir, { recursive: true });
	assert.deepEqual(await sweepSecretFiles({ jobsDir, reapedBackends: ["podman"], identity: dead }), { removed: 1, kept: 0, failed: 0 });
	assert.equal(fs.existsSync(dir), false);
});

test("boot sweep keeps a concurrent live owner, unknown liveness, and a venue whose reap did not succeed", async () => {
	for (const [identity, reapedBackends, reason] of [[() => ({ alive: true, start: OWNER.start }), ["local"], "owner-alive"], [() => ({ alive: null, start: null }), ["local"], "owner-unknown"], [dead, ["podman"], "venue-not-reaped"]]) {
		const { jobsDir, jobDir } = fixture();
		const dir = stage(jobDir);
		const logs = [];
		assert.deepEqual(await sweepSecretFiles({ jobsDir, reapedBackends, identity, log: (event, fields) => logs.push({ event, ...fields }) }), { removed: 0, kept: 1, failed: 0 });
		assert.equal(fs.existsSync(dir), true);
		assert.ok(logs.some((row) => row.reason === reason));
		assert.ok(!JSON.stringify(logs).includes(value));
	}
});

test("PID reuse and a new Linux boot identity cannot preserve a crashed attempt's files", async () => {
	for (const start of [`linux:${BOOT}:1235`, "linux:22222222-2222-2222-2222-222222222222:1234"]) {
		const { jobsDir, jobDir } = fixture();
		stage(jobDir);
		assert.equal((await sweepSecretFiles({ jobsDir, reapedBackends: ["local"], identity: () => ({ alive: true, start }) })).removed, 1);
	}
});

test("boot sweep follows neither directory nor owner symlinks, and refuses malformed ownership", async () => {
	const { jobsDir, jobDir } = fixture();
	const outside = tempDir("pi-secret-files-outside-");
	fs.writeFileSync(join(outside, "keep"), "untouched");
	fs.symlinkSync(outside, join(jobsDir, `job-link${SECRET_FILES_DIR_SUFFIX}`));
	const dir = stage(jobDir);
	fs.rmSync(join(dir, SECRET_FILES_OWNER));
	fs.symlinkSync(join(outside, "keep"), join(dir, SECRET_FILES_OWNER));
	const out = await sweepSecretFiles({ jobsDir, reapedBackends: ["local"], identity: dead });
	assert.deepEqual(out, { removed: 0, kept: 2, failed: 0 });
	assert.equal(fs.readFileSync(join(outside, "keep"), "utf8"), "untouched");
	fs.rmSync(join(dir, SECRET_FILES_OWNER));
	fs.writeFileSync(join(dir, SECRET_FILES_OWNER), "{}", { mode: 0o600 });
	assert.equal((await sweepSecretFiles({ jobsDir, reapedBackends: ["local"], identity: dead })).kept, 2);
});

test("filesystem faults are logged by code and do not prevent other dead attempts from being swept", async () => {
	const { jobsDir, jobDir } = fixture();
	stage(jobDir);
	const second = join(jobsDir, "job-second");
	fs.mkdirSync(second);
	stage(second);
	const logs = [];
	const io = { ...fsp, async rm(path, options) { if (path === `${jobDir}${SECRET_FILES_DIR_SUFFIX}`) throw Object.assign(new Error(value), { code: "EACCES" }); return fsp.rm(path, options); } };
	assert.deepEqual(await sweepSecretFiles({ jobsDir, fs: io, reapedBackends: ["local"], identity: dead, log: (event, fields) => logs.push({ event, ...fields }) }), { removed: 1, kept: 0, failed: 1 });
	assert.ok(!JSON.stringify(logs).includes(value));
});

test("process identity distinguishes ESRCH from permission faults and reads only Linux start ticks and boot id", () => {
	assert.deepEqual(secretFileProcessIdentity(123, { kill() { throw Object.assign(new Error(), { code: "ESRCH" }); } }), { alive: false, start: null });
	assert.deepEqual(secretFileProcessIdentity(123, { kill() { throw Object.assign(new Error(), { code: "EPERM" }); } }), { alive: null, start: null });
	const fields = ["S", ...Array(18).fill("0"), "555", "0"];
	const read = (path) => path.endsWith("boot_id") ? BOOT : `123 (a process (name)) ${fields.join(" ")}`;
	assert.deepEqual(secretFileProcessIdentity(123, { platform: "linux", kill() {}, read }), { alive: true, start: `linux:${BOOT}:555` });
	assert.deepEqual(secretFileProcessIdentity(123, { platform: "other", kill() {} }), { alive: true, start: null });
});

test("the ordinary age sweep cannot override an independent live-owner keep", async () => {
	const { sweepOrphanJobDirs } = await import("../src/recovery-queue.mjs");
	const { jobsDir, jobDir } = fixture();
	const dir = stage(jobDir);
	const now = () => 2_000_000_000_000;
	fs.utimesSync(jobDir, new Date(now() - 10_000), new Date(now() - 10_000));
	fs.utimesSync(dir, new Date(now() - 10_000), new Date(now() - 10_000));
	await sweepOrphanJobDirs({ jobsDir, now, olderThanMs: 1 });
	assert.equal(fs.existsSync(dir), true, "the private owner's check, not the workspace's age, owns deletion");
	await sweepOrphanJobDirs({ jobsDir, now, olderThanMs: 1 });
	assert.equal(fs.existsSync(dir), true, "an orphan's private owner remains authoritative too");
});
