import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

// CONST-MERGE-NEVER-AUTOMATIC's grep, run as CI runs it. The script is read out of the `no automatic merge` job, not
// copied here, so this tests the step itself: red on each planted merge or approval symbol in each path in scope (the
// pi bump workflow and its scripts since issue #587), red when a path in scope is missing, and clean on this tree.

const repo = fileURLToPath(new URL("../../", import.meta.url));

/** The `run:` block of the step named `name` in a workflow, dedented. */
function stepScript(workflow, name) {
	const lines = workflow.split("\n");
	const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	assert.ok(at >= 0, `no step named ${name}`);
	assert.match(lines[at + 1], /^\s+run: \|$/, "the step's run block follows its name");
	const indent = lines[at + 2].match(/^ */)[0];
	const body = [];
	for (const line of lines.slice(at + 2)) {
		if (line.trim() !== "" && !line.startsWith(indent)) break;
		body.push(line.slice(indent.length));
	}
	return body.join("\n");
}

const script = stepScript(readFileSync(join(repo, ".github/workflows/pi-upgrade-check.yml"), "utf8"), "No merge API call anywhere");
// GitHub's own invocation of a `run:` step on Linux.
const runIn = (cwd) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd, encoding: "utf8" });

const SCOPE = ["worker/src/x.mjs", "image/runner/x.mjs", "receiver/src/x.mjs", ".github/scripts/x.mjs", ".github/workflows/pi-bump.yml"];
const PLANTED = [
	"octokit.pulls.merge({ pull_number })",
	"gh pr merge 12 --rebase",
	"enableAutoMerge",
	"gh pr merge --auto",
	"auto-merge: true",
	"AUTOMERGE=1",
	"allow_auto_merge",
	"gh pr review 12 --approve",
	"gh pr review 12 -a",
	"mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }",
	"mergePullRequest",
	"glab mr merge 3",
	"PUT /projects/1/merge_requests/2/merge",
	"gh  pr\tmerge 12",
	"await octokit.pulls.createReview({ pull_number })",
	'{ event: "APPROVE" }',
	'{"event":"APPROVE"}',
	"event=APPROVE",
];
// Reading a pull request's reviews is the receiver's job (the poller's review feed, issue #66), so this one is refused
// only where the pi bump runs.
const BUMP_ONLY = ["gh api repos/o/r/pulls/12/reviews -f event=COMMENT"];
const BUMP_SCOPE = SCOPE.slice(3);

function cleanTree() {
	const dir = tempDir("merge-grep-");
	for (const path of SCOPE) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), "// nothing here merges, approves or reviews\n");
	}
	return dir;
}

test("the grep is clean on this repository, whose patterns live outside its own scope", () => {
	const run = runIn(repo);
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /OK: no merge or approval symbols/);
});

test("each merge or approval symbol, planted in each path in scope, turns the grep red", () => {
	const dir = cleanTree();
	assert.equal(runIn(dir).status, 0, "the clean tree passes");
	for (const path of SCOPE) {
		const clean = readFileSync(join(dir, path), "utf8");
		for (const planted of PLANTED) {
			writeFileSync(join(dir, path), `${clean}${planted}\n`);
			const run = runIn(dir);
			assert.equal(run.status, 1, `${planted} in ${path} passed`);
			assert.match(run.stdout, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${path}: the match is listed`);
		}
		writeFileSync(join(dir, path), clean);
	}
	for (const path of SCOPE) {
		const clean = readFileSync(join(dir, path), "utf8");
		for (const planted of BUMP_ONLY) {
			writeFileSync(join(dir, path), `${clean}${planted}\n`);
			assert.equal(runIn(dir).status, BUMP_SCOPE.includes(path) ? 1 : 0, `${planted} in ${path}`);
		}
		writeFileSync(join(dir, path), clean);
	}
});

test("a path in scope that is missing turns the grep red rather than reading as no match", () => {
	const dir = cleanTree();
	rmSync(join(dir, ".github/workflows/pi-bump.yml"));
	const run = runIn(dir);
	assert.equal(run.status, 1);
	assert.match(run.stdout + run.stderr, /a path in scope is missing/);
});
