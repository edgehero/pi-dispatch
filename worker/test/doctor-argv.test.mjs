// Issue #1114: doctor's one static line on the credential names a docker or podman job would keep on its client's argv.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobEnvArgs } from "../src/docker-run.mjs";
import { argvCredentialChecks } from "../src/doctor.mjs";
import { TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

test("issue #1114: no line where neither docker nor podman runs jobs or nothing is configured, and a tick naming the venues where no configured name stays on the argv", () => {
	assert.deepEqual(argvCredentialChecks({ localUsed: false, podmanUsed: false, forwarded: ["DOCKER_HOST"] }), [], "an openshell-only deployment builds no docker argv");
	const [line] = argvCredentialChecks({ localUsed: true, podmanUsed: true, forwarded: ["DATABASE_URL", "TZ"], secretNames: ["DEPLOY_TOKEN", "DATABASE_URL"] });
	assert.equal(line.ok, true);
	assert.match(line.label, /^local and podman: no credential name configured here stays on the runtime client's argv \(of the 3 names PI_FORWARD_ENV and the triggers file configure, 3 go as a bare -e NAME with their values in the client's environment\)$/);
	// Only what holds: a forwarded name that carries no secret (HOME) is not called bare.
	const [home] = argvCredentialChecks({ localUsed: true, forwarded: ["HOME", "DATABASE_URL"] });
	assert.equal(home.label, "local: no credential name configured here stays on the runtime client's argv (of the 2 names PI_FORWARD_ENV and the triggers file configure, 1 goes as a bare -e NAME with its value in the client's environment, and 1 carries no secret)");
	assert.match(argvCredentialChecks({ localUsed: true, forwarded: ["HOME"] })[0].label, /\(of the 1 name PI_FORWARD_ENV and the triggers file configure, 0 go as a bare -e NAME with their values in the client's environment, and 1 carries no secret\)$/);
	assert.equal(line.label.includes("bundle"), false, "no bundle declared, none mentioned");
	// A deployment that names no variable is told nothing (the provider key and the minted token are never kept); one that
	// declares a bundle is told the line cannot speak for its names.
	assert.deepEqual(argvCredentialChecks({ localUsed: true, podmanUsed: true }), []);
	const [bundled] = argvCredentialChecks({ podmanUsed: true, bundles: true });
	assert.equal(bundled.ok, true);
	assert.match(bundled.label, /^podman: no credential name configured here .*; a secret bundle's names are known only when a job resolves it, and the job's log line names any it keeps \(secret_env_on_argv\)$/);
});

test("issue #1114: a warning names each kept name with its reason, never a value, and never fails the run", () => {
	const [line] = argvCredentialChecks({ localUsed: true, forwarded: ["docker_config", "HTTPS_PROXY", "FOO-BAR", "Api_Token"], secretNames: ["SSH_DEPLOY_KEY", "API_TOKEN", "FINE_SECRET"] });
	assert.equal(line.ok, false);
	assert.equal(line.warn, true, "a warning: the job runs, with the exposure it always had");
	assert.match(line.label, /^local: these credential names stay on the runtime client's argv as -e NAME=VALUE, readable from the host's process list while a job runs: /);
	assert.match(line.label, /HTTPS_PROXY \(a proxy variable, which always travels with its value\)/);
	assert.match(line.label, /docker_config, SSH_DEPLOY_KEY \(the docker or podman client reads it itself\)/);
	assert.match(line.label, /Api_Token \(it differs only by case from API_TOKEN, also configured; a Windows environment holds one of two such names, so wherever both are in a job the upper-case one goes bare and this one stays\)/);
	assert.equal(line.label.includes("API_TOKEN ("), false, "the upper-case spelling goes bare and is not named as kept");
	assert.match(line.label, /FOO-BAR \(it is not a name a shell can spell\)/);
	assert.equal(line.label.includes("FINE_SECRET"), false, "a name that goes bare is not named");
	assert.match(line.fix, /CLIENT_ENV_GUARD/);
	const [lower] = argvCredentialChecks({ localUsed: true, forwarded: ["Foo_Key"], secretNames: ["foo_key"] });
	assert.match(lower.label, /Foo_Key \(it differs only by case from foo_key, also configured; a Windows environment holds one of two such names, so none of them being the upper-case spelling, all of them stay\), foo_key \(it differs only by case from Foo_Key, also configured;/);
	const [one] = argvCredentialChecks({ podmanUsed: true, secretNames: ["XDG_TOKEN"] });
	assert.match(one.label, /^podman: this credential name stays on the runtime client's argv/);
});

test("issue #1114: a configured name that differs only by case from a name the worker writes itself is named with it, and the line is no tick", () => {
	// The loaders accept a run secret or a forwarded `github_token`; beside a forge job's minted GITHUB_TOKEN the upper-case
	// name goes bare and the operator's stays on the argv, so doctor must not say none does.
	for (const [configured, written] of [["github_token", "GITHUB_TOKEN"], ["anthropic_api_key", "ANTHROPIC_API_KEY"], ["Gl_Token", "GL_TOKEN"]]) {
		const [line] = argvCredentialChecks({ localUsed: true, forwarded: [configured] });
		assert.equal(line.ok, false, configured);
		assert.equal(line.warn, true);
		assert.equal(line.label, `local: this credential name stays on the runtime client's argv as -e NAME=VALUE, readable from the host's process list while a job runs: ${configured} (it differs only by case from ${written}, which the worker writes into a job that uses it; a Windows environment holds one of two such names, so wherever both are in a job the upper-case one goes bare and this one stays)`);
	}
	// A structural upper-case twin stays inline itself, so the line does not say it goes bare: only that this one stays.
	const [structural] = argvCredentialChecks({ localUsed: true, forwarded: ["pi_model"] });
	assert.equal(structural.ok, false);
	assert.equal(structural.label, "local: this credential name stays on the runtime client's argv as -e NAME=VALUE, readable from the host's process list while a job runs: pi_model (it differs only by case from PI_MODEL, which the worker writes into a job that uses it; a Windows environment holds one of two such names, so wherever both are in a job this one stays)");
	assert.equal(jobEnvArgs({ PI_MODEL: "m", pi_model: "x" }).args.filter((a) => a === "PI_MODEL" || a === "pi_model").length, 0, "and indeed neither spelling goes bare");
	// The worker's own spelling, configured, is no twin of itself: it goes bare.
	assert.equal(argvCredentialChecks({ localUsed: true, forwarded: ["ANTHROPIC_API_KEY"] })[0].ok, true);
});

/** A spawn every probe sees exit 0 at once, so doctor's own commands answer and say nothing. */
const quietSpawn = () => {
	const stream = () => ({ on() { return this; } });
	const handlers = {};
	queueMicrotask(() => handlers.close?.(0));
	return { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
};

test("issue #1114: doctor reads the names from PI_FORWARD_ENV, run.secrets and an answer rule's declared keys, and leaves run.secretFiles' path variables out", async () => {
	const dir = tempDir("pd-1114-doctor-");
	const path = join(dir, "triggers.json");
	const answerRule = { id: "help", projects: ["web"], categories: ["how-to"], confidence: 0.9, mode: "draft", flow: "answer", model: "openai/gpt-5-mini", decisionModel: "anthropic/claude-haiku-4-5", maxCostUsd: "0.10", secrets: { OPENAI_API_KEY: "op://vault/openai" } };
	writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, answerRules: [answerRule], triggers: [{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", secrets: { SSH_DEPLOY_KEY: "op://vault/deploy", DEPLOY_TOKEN: "op://vault/token" }, secretFiles: { SSH_KEY_FILE: "op://vault/key" } } }] }));
	// A forwarded lower-case twin of the answer rule's key: said to twin a configured name only if that key was read.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-doctor", PI_TRIGGERS_FILE: path, PI_FORWARD_ENV: "DATABASE_URL,docker_config,openai_api_key" };
	const checks = await collectChecks(env, { cwd: dir, home: tempDir("pd-1114-doctor-home-"), out: () => {}, spawn: quietSpawn, fileExists: existsSync, readEnvFile: (p) => readFileSync(p), nodeVersion: "22.19.0" });
	const lines = checks.filter((c) => typeof c.label === "string" && c.label.includes("runtime client's argv"));
	assert.equal(lines.length, 1, "one line");
	assert.match(lines[0].label, /^local: these credential names stay .*docker_config, SSH_DEPLOY_KEY \(the docker or podman client reads it itself\)/);
	// "also configured" rather than "which the worker writes": the answer rule's key was read as a configured name.
	assert.match(lines[0].label, /openai_api_key \(it differs only by case from OPENAI_API_KEY, also configured;/);
	assert.equal(lines[0].label.includes("SSH_KEY_FILE"), false, "a file secret's variable holds a path, never the secret");
	assert.equal(lines[0].label.includes("op://"), false);
	assert.equal(JSON.stringify(lines).includes("sk-test-doctor"), false);
});
