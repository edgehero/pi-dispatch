import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { forkPolicyDigest, makeCheckForkPolicy } from "../src/fork-policy.mjs";

const entry = { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", resume: true, models: ["anthropic/claude-haiku-4-5"] } };
const job = { kind: "github", flow: "fix", trigger: { matched: { index: 0, type: "comment" } } };
test("a queued fork loses authority after any normalized trigger policy change", () => {
	const path = join(tempDir("pi-fork-policy-"), "triggers.json");
	const write = (e) => writeFileSync(path, JSON.stringify({ triggers: [e] }));
	write(entry);
	const first = forkPolicyDigest({ triggersPath: path, job });
	assert.equal(first.ok, true);
	const queued = { ...job, forkPolicy: first.digest };
	const check = makeCheckForkPolicy({ triggersPath: path });
	assert.deepEqual(check(queued), { ok: true });
	write({ ...entry, run: { ...entry.run, maxTurns: 1 } });
	assert.deepEqual(check(queued), { refused: "fork-trigger-changed" });
	write(entry);
	assert.deepEqual(check(queued), { ok: true });
	writeFileSync(path, "broken");
	assert.deepEqual(check(queued), { refused: "fork-trigger-unavailable" });
});
test("missing, replaced or foreign trigger identity refuses rather than retaining stale policy", () => {
	const fs = { readFileSync: () => JSON.stringify({ triggers: [entry] }) };
	for (const changed of [{ ...job, kind: "gitlab" }, { ...job, trigger: { matched: { index: 1, type: "comment" } } }, { ...job, trigger: { matched: { index: 0, type: "label" } } }, { ...job, trigger: undefined }]) {
		assert.ok(forkPolicyDigest({ triggersPath: "/triggers", job: changed, fs }).refused);
	}
});
