import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MERGE_RULE, MERGE_POLICY_INPUT, MERGE_POLICY_PATH, PERMITTED_MERGE_RULE, guardrailsForMerge, readMergePolicy } from "../src/merge-policy.mjs";
import { LAYOUT } from "../src/layout.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const floor = readFileSync(new URL("../../../guardrails/HARD_RULES.md", import.meta.url), "utf8");
const policyError = (error) => error.piDispatchExit === 2 && error.piDispatchReason === "config";

test("the default floor is byte-identical to main before issue 908", () => {
	assert.equal(createHash("sha256").update(floor).digest("hex"), "762147563f4c909b29bc322464a146786065ed4fc7293c2c4b5d6f8f72544e44");
	assert.equal(guardrailsForMerge(floor), floor);
	assert.equal(guardrailsForMerge(floor, false), floor);
	assert.equal(floor.split(DEFAULT_MERGE_RULE).length, 2, "the copied rule is exactly the one baked into the floor");
});

test("permission replaces only the exact pinned rule and cannot remove unrelated rules", () => {
	const allowed = guardrailsForMerge(floor, true);
	assert.equal(allowed.replace(PERMITTED_MERGE_RULE, DEFAULT_MERGE_RULE), floor);
	assert.doesNotMatch(allowed, /Never merge|human reviews and lands/i);
	assert.match(allowed, /ordinary checks and approvals/);
	assert.match(allowed, /earlier harness merge restrictions/);
	assert.match(allowed, /does not override stricter project/);
	assert.match(allowed, /Never approve your own changes, bypass checks or approvals, push directly/);
	assert.match(allowed, /branch protection, branch policies, repository or project settings/);
	for (const bad of ["", floor + DEFAULT_MERGE_RULE, floor.replace("3. **Never merge.**", "3. Changed rule")]) assert.throws(() => guardrailsForMerge(bad, true), policyError);
	for (const bad of [1, "true", null]) assert.throws(() => guardrailsForMerge(floor, bad), policyError);
});

test("only the exact worker marker grants permission; absence stays default and read failures refuse", () => {
	assert.equal(MERGE_POLICY_PATH, `${LAYOUT.job}/merge-policy.json`);
	assert.equal(readMergePolicy({ readFile: () => MERGE_POLICY_INPUT }), true);
	assert.equal(readMergePolicy({ readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }), false);
	for (const text of ["", "null", "{}", '{"version":2,"mayMerge":true}\n', '{"version":1,"mayMerge":false}\n', '{"version":1,"mayMerge":"true"}\n', '{"version":1,"mayMerge":false,"mayMerge":true}\n', '{"version":1,"mayMerge":true,"extra":1}\n']) assert.throws(() => readMergePolicy({ readFile: () => text }), policyError);
	for (const code of ["EIO", "EACCES", "EISDIR"]) assert.throws(() => readMergePolicy({ readFile: () => { throw Object.assign(new Error("private path"), { code }); } }), (error) => policyError(error) && !error.message.includes("private path"));
});

let loaderModule;
try { loaderModule = await import("../src/loader.mjs"); }
catch (error) { if (process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw error; }
const skip = loaderModule ? false : "pinned pi is not installed";

test("the pinned real loader places the selected floor before every persona, also for continued sessions", { skip }, async () => {
	const root = tempDir("merge-floor-");
	const cwd = join(root, "workspace");
	const jobPiDir = join(root, "job", "pi");
	const globalPiDir = join(root, "global");
	for (const dir of [cwd, jobPiDir, globalPiDir]) mkdirSync(dir, { recursive: true });
	const guardrailsPath = join(root, "HARD_RULES.md");
	writeFileSync(guardrailsPath, floor);
	writeFileSync(join(jobPiDir, "APPEND_SYSTEM.md"), "PROJECT-PERSONA");
	writeFileSync(join(globalPiDir, "APPEND_SYSTEM.md"), "GLOBAL-PERSONA");
	for (const mayMerge of [false, true]) {
		const loader = await loaderModule.buildLoadedResourceLoader({ cwd, jobPiDir, globalPiDir, guardrailsPath, mayMerge, triggerSkillsDir: join(root, "no-skills"), outboxMount: join(root, "no-outbox"), portfolioPath: join(root, "no-portfolio") });
		const append = loader.getAppendSystemPrompt();
		assert.equal(append[0], guardrailsForMerge(floor, mayMerge));
		assert.deepEqual(append.slice(1), ["GLOBAL-PERSONA", "PROJECT-PERSONA"]);
	}
	assert.throws(() => loaderModule.buildResourceLoader({ guardrailsPath, watchReadOnly: true, mayMerge: true }), policyError);
});

test("the real runner diagnoses unreadable mounts before policy, then loads the selected floor for recovery too", () => {
	const source = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const inputs = source.indexOf("assertJobInputsReadable([JOB_DIR, GLOBAL_PI_DIR, WORKSPACE]);");
	const read = source.indexOf("const mayMerge = readMergePolicy();");
	const command = source.indexOf("if (mayMerge && cfg.command !== null) throw configError(\"a command job cannot carry merge permission\");");
	const loader = source.indexOf("const resourceLoader = await buildLoadedResourceLoader({\n\t\tmayMerge,");
	assert.ok(inputs > 0 && read > inputs, "an untraversable /job keeps its job-inputs-unreadable diagnostic instead of a policy read error");
	assert.ok(command > read && loader > command, "permission is read and command jobs refused before any extension loads");
	assert.ok(source.indexOf("if (cfg.recovering) {", loader) > loader, "recovery uses the same already-built loader");
});
