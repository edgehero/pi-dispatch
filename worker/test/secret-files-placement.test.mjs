import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { checkSecretFileSources, checkSecretFilesPlacement } from "../src/secret-files-placement.mjs";
import { makePrepareWorkspace } from "../src/prepare.mjs";
import { prepareLocalWorkspace } from "../src/prepare-local.mjs";
import { stageSecretFiles, SECRET_FILES_DIR_SUFFIX } from "../src/secret-files.mjs";
import { makeRunContainer } from "../src/run-container.mjs";
import { InfraRetry } from "../src/processor.mjs";

const refusal = { outcome: "policy", reason: "secret-files-placement-unsafe" };
function fixture() {
	const root = tempDir("pi-secret-placement-");
	const jobsDir = join(root, "jobs");
	fs.mkdirSync(jobsDir);
	return { root, jobsDir };
}

test("ungranted local jobs cannot mount an ancestor, equal or descendant of the jobs root, including aliases", () => {
	const { root, jobsDir } = fixture();
	const alias = join(root, "alias"); fs.symlinkSync(jobsDir, alias);
	for (const folder of [root, jobsDir, join(jobsDir, "job-other.secret-files", "secrets"), alias, join(alias, "future")]) {
		assert.deepEqual(checkSecretFilesPlacement({ kind: "local", folder }, { jobsDir }), refusal);
	}
	assert.deepEqual(checkSecretFilesPlacement({ kind: "local", folder: root }, { jobsDir: join(root, "future", "jobs") }), refusal);
	assert.equal(checkSecretFilesPlacement({ kind: "local", folder: `${jobsDir}-sibling` }, { jobsDir }), null);
});

test("identity aliases are compared in both directions even when realpath spellings differ", () => {
	const stats = new Map([["/alias", { dev: 1n, ino: 9n }], ["/store/jobs", { dev: 1n, ino: 9n }], ["/store/jobs/child", { dev: 1n, ino: 10n }]]);
	const view = { realpathSync: path => path, statSync: path => { if (stats.has(path)) return stats.get(path); throw Object.assign(new Error(), { code: "ENOENT" }); } };
	assert.deepEqual(checkSecretFileSources(["/alias"], "/store/jobs/child", { fs: view }), refusal);
	assert.deepEqual(checkSecretFileSources(["/store/jobs/child"], "/alias", { fs: view }), refusal);
});

test("skills and global overlay sources cannot expose any attempt, before copy or special preparation", async () => {
	for (const source of ["skills", "overlay", "local"]) {
		const { root, jobsDir } = fixture();
		const prepare = makePrepareWorkspace({ jobsDir, ...(source === "overlay" ? { globalPiDir: root } : {}),
			injectSkills: () => assert.fail("must refuse before copying"), prepareLocal: () => assert.fail("must refuse before preparing") });
		const job = source === "local" ? { kind: "local", folder: root } : { kind: "github", questionGrouping: {}, ...(source === "skills" ? { skillsDir: root } : {}) };
		assert.deepEqual(await prepare(job, null), refusal);
		assert.deepEqual(fs.readdirSync(jobsDir), [], "not even a job directory was made");
	}
});

test("preparation repeats the boundary on the exact resolved local mount", async () => {
	const { root, jobsDir } = fixture();
	const outside = tempDir("pi-secret-placement-outside-");
	const view = { ...fs, realpathSync: path => path === outside ? root : fs.realpathSync(path) };
	assert.deepEqual(await prepareLocalWorkspace({ folder: outside, secretFilesJobsDir: jobsDir, jobDir: join(jobsDir, "job-new"), task: "", fs: view }), refusal);
	assert.deepEqual(fs.readdirSync(jobsDir), []);
});

test("forge clones within their own canonical job directory pass, while a replaced workspace does not", async () => {
	const { root, jobsDir } = fixture();
	const prepare = makePrepareWorkspace({ jobsDir, stageLive: null, preparers: { github: async (_job, _token, { jobDir }) => {
		const workspace = join(jobDir, "workspace"); fs.mkdirSync(workspace); return { jobDir, workspace };
	} } });
	const job = { kind: "github", repo: "org/repo" };
	const prepared = await prepare(job, "token");
	assert.equal(checkSecretFilesPlacement(job, { jobsDir, prepared }), null);
	fs.rmSync(prepared.workspace, { recursive: true }); fs.symlinkSync(jobsDir, prepared.workspace);
	assert.deepEqual(checkSecretFilesPlacement(job, { jobsDir, prepared }), refusal);
	assert.deepEqual(checkSecretFilesPlacement(job, { jobsDir, prepared: { ...prepared, workspace: root } }), refusal);
});

test("unanswered placement reads remain retryable and expose neither paths nor filesystem text", () => {
	const view = { realpathSync: () => { throw Object.assign(new Error("private path and value"), { code: "EACCES" }); } };
	assert.deepEqual(checkSecretFilesPlacement({ kind: "local", folder: "/private" }, { jobsDir: "/other", fs: view }), { unavailable: true });
});

test("final runtime revalidation also refuses an ungranted job before any spawn", async () => {
	const { root, jobsDir } = fixture();
	const prepared = { jobDir: join(jobsDir, "job-new"), workspace: root };
	const job = { kind: "local" };
	const run = makeRunContainer({ spawnFn: () => assert.fail("placement precedes spawn") });
	await assert.rejects(run({ job, prepared }), error => error instanceof InfraRetry, "bare callers also cannot expose this attempt's sibling");
	const overlayRun = makeRunContainer({ globalPiDir: root, spawnFn: () => assert.fail("overlay placement precedes spawn") });
	await assert.rejects(overlayRun({ job, prepared: { ...prepared, workspace: tempDir("pi-secret-placement-workspace-") } }), error => error instanceof InfraRetry);
	await assert.rejects(run({ job, prepared, checkSecretFilesPlacement: () => checkSecretFilesPlacement(job, { jobsDir, prepared }) }), error => error instanceof InfraRetry);
	assert.deepEqual(fs.readdirSync(jobsDir), []);
});

test("staging checks the exact sibling against mounted sources but allows the own forge workspace", () => {
	const { root, jobsDir } = fixture();
	const jobDir = join(jobsDir, "job-new"); fs.mkdirSync(jobDir);
	for (const options of [{ workspace: root }, { globalPiDir: jobsDir }]) {
		assert.throws(() => stageSecretFiles(jobDir, { KEY: "exact secret\n" }, options), /could not be staged/);
		assert.equal(fs.existsSync(`${jobDir}${SECRET_FILES_DIR_SUFFIX}`), false);
	}
	const workspace = join(jobDir, "workspace"); fs.mkdirSync(workspace);
	assert.equal(stageSecretFiles(jobDir, { KEY: "exact secret\n" }, { workspace }), `${jobDir}${SECRET_FILES_DIR_SUFFIX}`);
});
