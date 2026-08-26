import assert from "node:assert/strict";
import { test } from "node:test";
import { issueBranch, normalizeNumber } from "../src/branch.mjs";
import { buildGithubPrompt } from "../src/github-prompt.mjs";
import { buildGitLabPrompt } from "../src/gitlab-prompt.mjs";
import { buildForgejoPrompt } from "../src/forgejo-prompt.mjs";
import { buildAzurePrompt } from "../src/azure-prompt.mjs";

test("the branch derives from the number alone, so a re-run converges on the same branch", () => {
	assert.equal(issueBranch(7), "pi/issue-7");
	// The shared normaliser COERCES, so a numeric string lands on the same branch -- which is the point:
	// the prompt and the session key must not disagree because one of them was handed a string.
	assert.equal(issueBranch("7"), "pi/issue-7");
});

test("a number that is not a positive integer refuses rather than minting a garbage branch", () => {
	for (const number of [0, -1, 1.5, "abc", undefined, null, "", "../../etc/passwd"]) {
		assert.throws(
			() => issueBranch(number),
			(e) => e.piDispatchConfig === true,
			`number ${JSON.stringify(number)} must refuse -- a branch name is a path segment and a host filesystem key`,
		);
	}
});

test("normalizeNumber is the same function at both addresses, so gitlab-prompt's import did not fork", async () => {
	const { normalizeNumber: viaPrompt } = await import("../src/github-prompt.mjs");
	assert.equal(viaPrompt, normalizeNumber, "github-prompt re-exports branch.mjs's function; a copy would drift");
});

test("both envelopes name the branch branch.mjs mints -- the drift this module exists to stop is silent", () => {
	// A second copy of `pi/issue-${n}` would not throw. It would key a session on a branch the agent was
	// never told to push to, so every resume would miss and every job would look like a normal cold start.
	const target = { type: "issue", number: 42, title: "T", body: "B" };
	const branch = issueBranch(42);
	assert.ok(buildGithubPrompt({ flow: "fix", target }).includes(`\`${branch}\``));
	assert.ok(buildGitLabPrompt({ flow: "fix", target }).includes(`\`${branch}\``));
});

// --- replica runs (REQ-REPLICA-RUNS) ---

test("a replica index suffixes the branch, and its absence leaves the string byte-identical", () => {
	// Symmetric on purpose: neither `-r1` nor `-r2` is "the original". Two replicas exist to produce two
	// independent pull requests, and a naming scheme where one of them is the plain branch would make the
	// other read as a copy.
	assert.equal(issueBranch(7), "pi/issue-7", "an unreplicated run must mint exactly what it always did");
	assert.equal(issueBranch(7, 1), "pi/issue-7-r1");
	assert.equal(issueBranch(7, 2), "pi/issue-7-r2");
	assert.equal(issueBranch("7", 3), "pi/issue-7-r3", "the number still coerces; the replica does not, and rides on top");
});

test("a replica that is not a positive integer refuses rather than minting a garbage suffix", () => {
	// `undefined` is the ONLY value that means "no replica". Everything else is a caller bug, and a branch
	// name is a path segment, a host filesystem key and a `git push` argument. STRICTER than the number
	// check above, which coerces: `"2"` is refused here so this and job-id.mjs -- which also refuses it --
	// can never disagree about whether a run is a replica.
	for (const replica of [0, -1, 1.5, "2", "abc", null, "", {}]) {
		assert.throws(
			() => issueBranch(7, replica),
			(e) => e.piDispatchConfig === true,
			`replica ${JSON.stringify(replica)} must refuse`,
		);
	}
});

test("every replica of one issue gets a DISTINCT branch -- the push race the feature exists to avoid", () => {
	const branches = [1, 2, 3].map((i) => issueBranch(42, i));
	assert.equal(new Set(branches).size, 3);
	for (const b of branches) assert.ok(b.startsWith("pi/issue-42-"), `${b} must stay under the pi/issue-* namespace HARD_RULES rule 3 bounds`);
});

test("the github envelope names the replica branch branch.mjs mints, not the plain one", () => {
	const target = { type: "issue", number: 42, title: "T", body: "B" };
	const prompt = buildGithubPrompt({ flow: "fix", target, replica: 2, replicas: 2 });
	assert.ok(prompt.includes(`\`${issueBranch(42, 2)}\``), "the prompt and the minted branch cannot be allowed to drift");
	assert.equal(prompt.includes("`pi/issue-42`"), false, "the unsuffixed branch must not appear -- it is the sibling's namespace, not this job's");
});

test("EVERY forge's envelope names the replica branch branch.mjs mints, not the plain one (#187)", () => {
	// The github twin above is the original; this is the assertion that would have caught the gap #187
	// closed. A builder that still passes one argument to issueBranch renders a paragraph naming siblings
	// and a step 1 naming `pi/issue-42` -- convincing, and both replicas push to one branch.
	const target = { type: "issue", number: 42, title: "T", body: "B" };
	const builders = [
		["gitlab", buildGitLabPrompt],
		["forgejo", buildForgejoPrompt],
		["azure", buildAzurePrompt],
	];
	for (const [forge, build] of builders) {
		const prompt = build({ flow: "fix", target, replica: 2, replicas: 2 });
		assert.ok(prompt.includes(`\`${issueBranch(42, 2)}\``), `${forge}: the prompt and the minted branch cannot drift`);
		assert.equal(prompt.includes("`pi/issue-42`"), false, `${forge}: the unsuffixed branch is the sibling's namespace, not this job's`);
		assert.ok(prompt.includes(issueBranch(42, 1)), `${forge}: the sibling branch is named so "do not touch" has a subject`);
	}
});
