import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { SECRET_FILE_FIXTURES, SECRET_FILES_PROBE_SOURCE, judgeSecretFilesProbe, secretFileStageRemoved } from "../../.github/scripts/secret-files-conformance.mjs";

const facts = { verified: true, paths: true, bytes: true, owner: true, modes: true, readonly: true, cmdline: true, environ: true };
const jobDir = "/jobs/job-conformance";
const clean = () => ({
	code: 0, output: `secret-files ${JSON.stringify(facts)}\n`, jobDir,
	commands: [["openshell", "sandbox", "upload", "pi-job-conformance", `${jobDir}.secret-files/secrets`, "/sandbox"]],
	gatewayLog: "gateway started", persistedLog: "[REDACTED]\n", fs: { existsSync: () => false },
});

test("the venue probe source parses independently of the host's image filesystem", () => {
	const path = join(tempDir("secret-file-conformance-"), "probe.mjs");
	writeFileSync(path, SECRET_FILES_PROBE_SOURCE);
	execFileSync(process.execPath, ["--check", path]);
	for (const value of Object.values(SECRET_FILE_FIXTURES)) assert.equal(SECRET_FILES_PROBE_SOURCE.includes(value), false, "the image carries hashes, not a second copy of the secret");
});

test("conformance requires every measured file property, successful exit and actual clean reads", () => {
	assert.equal(judgeSecretFilesProbe(clean()).ok, true);
	assert.equal(judgeSecretFilesProbe({ ...clean(), copy: true }).ok, true);
	for (const key of Object.keys(facts)) {
		for (const value of [false, undefined]) {
			assert.equal(judgeSecretFilesProbe({ ...clean(), output: `secret-files ${JSON.stringify({ ...facts, [key]: value })}\n` }).ok, false, key);
		}
	}
	for (const patch of [{ code: 1 }, { output: "" }, { output: "secret-files not-json" }, { commands: [] }, { commands: null }, { persistedLog: null }, { persistedLog: "" }, { gatewayLog: "" }, { gatewayLog: null }]) {
		assert.equal(judgeSecretFilesProbe({ ...clean(), ...patch }).ok, false, JSON.stringify(patch));
	}
});

test("conformance catches content in every output channel, command arguments and gateway logs without echoing it", () => {
	for (const value of Object.values(SECRET_FILE_FIXTURES).flatMap((value) => [value, ...value.split(/\r?\n/).filter(Boolean)])) {
		for (const patch of [{ output: clean().output + value }, { persistedLog: value }, { gatewayLog: value }, { commands: [["exec", "--env", `CREDENTIAL=${value}`]] }]) {
			const answer = judgeSecretFilesProbe({ ...clean(), ...patch });
			assert.equal(answer.ok, false);
			assert.equal(answer.detail.includes(value), false);
		}
	}
});

test("conformance requires independent host cleanup and direct upload of the secret subtree", () => {
	for (const leftover of [`${jobDir}.secret-files`, `${jobDir}.openshell-up/secrets`]) {
		const fs = { existsSync: (path) => path === leftover };
		assert.equal(judgeSecretFilesProbe({ ...clean(), fs }).ok, false);
		assert.equal(secretFileStageRemoved(jobDir, fs), false);
	}
	assert.equal(secretFileStageRemoved(jobDir, clean().fs), true);
	assert.equal(judgeSecretFilesProbe({ ...clean(), copy: true, commands: [["openshell", "sandbox", "upload", `${jobDir}.openshell-up/secrets`]] }).ok, false);
});


test("the bind probe's default log path is the workflow's existing restart log", async () => {
	const { readFileSync } = await import("node:fs");
	const workflow = readFileSync(new URL("../../.github/workflows/openshell-conformance.yml", import.meta.url), "utf8");
	const probe = readFileSync(new URL("../../.github/scripts/openshell-bind-conformance.mjs", import.meta.url), "utf8");
	assert.ok(workflow.includes('openshell-gateway > "$RUNNER_TEMP/gateway-bind.log"'));
	assert.ok(probe.includes('join(process.env.RUNNER_TEMP, "gateway-bind.log")'));
	assert.ok(probe.includes('process.env.GATEWAY_LOG ??'), "manual runs can name their own log");
});
