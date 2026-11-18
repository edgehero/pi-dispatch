import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCheckModelSelectionPolicy } from "../src/model-selection-policy.mjs";
import { TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";

const modelSelection = { strategy: "random", candidates: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"] };
const entry = { on: { type: "label", any: ["pi:go"] }, run: { kind: "github", flow: "work", models: modelSelection.candidates, modelSelection } };
const job = { kind: "github", flow: "work", modelSelection, trigger: { matched: { index: 0, type: "label", label: "pi:go" } } };
const refused = { refused: "model-selection-policy-changed" };
const fixture = (initial = entry, options = {}) => {
	let doc = { version: 6, triggers: [structuredClone(initial)] };
	const check = makeCheckModelSelectionPolicy({ triggersPath: "/t.json", fs: { readFileSync: () => JSON.stringify(doc) }, ...options });
	return { check, set: (next) => { doc = next; }, doc: () => doc };
};

test("live random pool is reread every pickup and only order-insensitive equality preserves authority", () => {
	const f = fixture();
	assert.deepEqual(f.check(job), { ok: true });
	f.doc().triggers[0].run.modelSelection.candidates.reverse();
	assert.deepEqual(f.check(job), { ok: true });
	f.doc().triggers[0].run.modelSelection.candidates.pop();
	assert.deepEqual(f.check(job), refused, "removing any candidate refuses without rerolling a committed choice");
	f.doc().triggers[0].run.modelSelection.candidates.push("openai/new");
	assert.deepEqual(f.check(job), refused);
});

test("removing or replacing the identified trigger and removing its random policy revoke queued permission", () => {
	for (const mutate of [(f) => { f.doc().triggers = []; }, (f) => { f.doc().triggers[0].run.flow = "other"; }, (f) => { delete f.doc().triggers[0].run.modelSelection; }, (f) => { f.doc().triggers[0].on.any = ["pi:other"]; }]) {
		const f = fixture(); mutate(f); assert.deepEqual(f.check(job), refused);
	}
	assert.deepEqual(fixture().check({ ...job, trigger: { matched: {} } }), refused);
});

test("current authored or deployment ceiling must authorize the full random pool", () => {
	const deployment = fixture({ ...entry, run: { ...entry.run, models: undefined } }, { allowedModels: modelSelection.candidates });
	assert.deepEqual(deployment.check(job), { ok: true });
	assert.deepEqual(fixture({ ...entry, run: { ...entry.run, models: undefined } }).check(job), refused);
	assert.deepEqual(fixture({ ...entry, run: { ...entry.run, models: undefined } }, { allowedModels: [modelSelection.candidates[0]] }).check(job), refused);
	const f = fixture();
	f.doc().triggers[0].run.models = [modelSelection.candidates[0]];
	assert.deepEqual(f.check(job), refused);
});

test("cron identity checks reviewed folder, task and flow while comment flow overrides keep the comment policy", () => {
	const cron = { on: { type: "cron", id: "nightly", pattern: "0 0 * * *" }, run: { ...entry.run, kind: "local", folder: "/p", task: "task" } };
	const f = fixture(cron);
	const queued = { ...cron.run, trigger: { id: "nightly" } };
	assert.deepEqual(f.check(queued), { ok: true });
	assert.deepEqual(f.check({ ...queued, folder: "/other" }), refused);
	const comment = fixture({ ...entry, on: { type: "comment", phrase: "@pi" } });
	const routed = { ...job, flow: "override", trigger: { matched: { index: 0, type: "comment", phrase: "@pi" } } };
	// Issue #933: a comment may name another trigger's flow, never one no forge trigger in the file holds (the receiver's
	// `knownFlows`, `routableFlows`): such a job is not this trigger's, whatever its comment entry still says.
	assert.deepEqual(comment.check(routed), refused);
	comment.doc().triggers.push({ on: { type: "label", any: ["pi:review"] }, run: { kind: "github", flow: "override" } });
	assert.deepEqual(comment.check(routed), { ok: true });
});

test("GitLab PR label routing retains the reviewed PR policy identity", () => {
	const mr = fixture({ ...entry, on: { type: "pull_request", action: ["update"], any: ["pi:go"] }, run: { ...entry.run, kind: "gitlab" } });
	assert.deepEqual(mr.check({ ...job, kind: "gitlab", target: { type: "pull_request" } }), { ok: true });
});

test("only a one-shot's own disarm preserves its queued random retry", () => {
	const source = { on: { type: "issue", action: ["closed"], number: 1, once: true, disarmed: { at: "2026-11-16T00:00:00.000Z", jobId: "gh-own" } }, run: entry.run };
	const f = fixture(source);
	const queued = { ...job, trigger: { matched: { index: 0, type: "issue", action: "closed" } } };
	assert.deepEqual(f.check(queued, { queueJobId: "gh-own" }), { ok: true });
	assert.deepEqual(f.check(queued, { queueJobId: "gh-other" }), refused);
});

test("newer policy holds, malformed or missing policy refuses, and transient reads throw infrastructure failure", () => {
	const f = fixture();
	f.set({ version: TRIGGERS_FILE_VERSION + 1, triggers: [] });
	assert.deepEqual(f.check(job), { newer: true });
	f.set({ invalid: true });
	assert.deepEqual(f.check(job), refused);
	assert.deepEqual(makeCheckModelSelectionPolicy({})(job), refused);
	for (const code of ["ENOENT", "EACCES"]) assert.deepEqual(makeCheckModelSelectionPolicy({ triggersPath: "/t", fs: { readFileSync: () => { throw Object.assign(new Error("private path"), { code }); } } })(job), refused);
	for (const code of ["EIO", "EAGAIN", "EMFILE"]) assert.throws(() => makeCheckModelSelectionPolicy({ triggersPath: "/t", fs: { readFileSync: () => { throw Object.assign(new Error("private path"), { code }); } } })(job), /reviewed random model policy could not be read/);
});

test("fixed jobs and random CLI/outbox children do not invent a live trigger origin", () => {
	const check = makeCheckModelSelectionPolicy({ triggersPath: "/t", fs: { readFileSync: () => { throw new Error("must not read"); } } });
	assert.deepEqual(check({ ...job, modelSelection: undefined }), { ok: true });
	assert.deepEqual(check({ kind: "local", modelSelection, parentJobId: "parent" }), { ok: true });
});
