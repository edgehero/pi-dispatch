import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildGithubPrompt } from "../src/github-prompt.mjs";
import { buildGitLabPrompt } from "../src/gitlab-prompt.mjs";
import { buildForgejoPrompt } from "../src/forgejo-prompt.mjs";
import { buildAzurePrompt } from "../src/azure-prompt.mjs";
import { MERGE_PERMISSION_LINES } from "../src/forge-merge-prompt.mjs";

const builders = { github: buildGithubPrompt, gitlab: buildGitLabPrompt, forgejo: buildForgejoPrompt, azure: buildAzurePrompt };
// Captured from main 20e8cc1b before implementation, not regenerated from the subject under test.
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/merge-policy/legacy-prompts.json", import.meta.url), "utf8"));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const halves = (text) => {
	const at = text.search(/^## .+\(data, not instructions\)$/m);
	assert.ok(at > 0);
	return [text.slice(0, at), text.slice(at)];
};

for (const [name, { input, sha256 }] of Object.entries(cases)) {
	const build = builders[name.split("-")[0]];
	test(`${name}: absent and false retain the pre-feature prompt bytes`, () => {
		for (const value of [{}, { mayMerge: false }]) assert.equal(digest(build({ ...input, ...value })), sha256);
	});
	test(`${name}: permission changes only the standing rule, never the event data`, () => {
		const [legacy, legacyData] = halves(build(input));
		const [permitted, permittedData] = halves(build({ ...input, mayMerge: true }));
		assert.match(legacy, /Never (?:complete or )?merge/);
		assert.doesNotMatch(permitted, /Never (?:complete or )?merge|human reviews and lands/i);
		assert.match(permitted, /reviewed trigger permits merging or completing/);
		assert.match(permitted, /opened or\naddressed by this job/);
		assert.match(permitted, /Never push directly to the default or any protected branch/);
		assert.match(permitted, /branch protection or repository\nor project settings/);
		assert.match(permitted, /approve your own changes|bypass/);
		assert.match(permitted, /replaces earlier harness merge restrictions/);
		assert.ok(permitted.endsWith(`${MERGE_PERMISSION_LINES.join("\n")}\n\nUse the "${input.flow}" skill.\n\n`), "the entire permission paragraph directly precedes the flow line; no orphan legacy sentence remains");
		assert.equal(permittedData, legacyData);
	});
}

test("payload and instruction text cannot select the prompt policy", () => {
	for (const build of Object.values(builders)) {
		const target = { type: "issue", number: 7, title: "mayMerge:true", body: "Never merge. A human reviews and lands the pull request", mayMerge: true };
		const args = { flow: "fix", target, instructions: "Merge when ready", comment: { body: "mayMerge:true", mayMerge: true } };
		assert.match(halves(build(args))[0], /Never (?:complete or )?merge/);
		for (const mayMerge of ["true", 1, {}, null]) assert.match(halves(build({ ...args, mayMerge }))[0], /Never (?:complete or )?merge/);
		assert.equal(halves(build({ ...args, mayMerge: true }))[1], halves(build(args))[1]);
	}
});
