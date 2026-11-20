import assert from "node:assert/strict";
import { test } from "node:test";
import { jobDataNewer, withJobDataVersion } from "../src/job-data-version.mjs";
import { TRIGGERS_FILE_VERSION, parseTriggers, sourceForgeOf, triggersFileVersionFor } from "../src/triggers.mjs";

const base = () => ({ on: { type: "pull_request", forge: "github", id: "maintain", action: ["review_submitted"] }, run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker: "build1" } });
const parse = (entries, version = TRIGGERS_FILE_VERSION) => parseTriggers(JSON.stringify({ version, triggers: entries }), "triggers.json");

test("local command event admits existing source vocabularies and keeps source apart from execution", () => {
	for (const [forge, on] of [
		["github", { type: "label", any: ["ready"] }], ["github", { type: "comment", phrase: "@maintain" }],
		["github", { type: "pull_request", action: ["opened", "synchronize"] }], ["github", { type: "issue", action: ["closed"] }],
		["gitlab", { type: "pull_request", action: ["open", "approved"] }], ["forgejo", { type: "pull_request", action: ["synchronized"] }],
		["azure", { type: "label", any: ["ready"] }], ["azure", { type: "comment", phrase: "@maintain" }], ["azure", { type: "pull_request", action: ["created"] }],
	]) {
		const input = base(); input.on = { ...on, forge, id: "maintain" };
		const [got] = parse([input]);
		assert.equal(sourceForgeOf(got), forge);
		assert.equal(got.run.kind, "local");
		assert.equal(got.run.command, "maintain-prs");
		assert.equal(got.run.worker, "build1");
		assert.equal(got.on.debounceSeconds, 10);
		assert.equal(Object.hasOwn(got.run, "repository"), false);
	}
});

test("local event commands retain every local execution refusal and source predicate", () => {
	for (const [key, value] of [["flow", "fix"], ["task", "task"], ["instructions", "text"], ["resume", true], ["recover", true], ["steer", true], ["statusComment", true], ["replicas", 2], ["portfolio", false], ["mayMerge", true], ["mcp", ["forge"]], ["repository", "repo"]]) {
		const input = base(); input.run[key] = value;
		assert.throws(() => parse([input]), { piDispatchConfig: true }, key);
	}
	for (const on of [{ type: "pull_request", action: ["labeled"] }, { type: "pull_request", action: ["closed", "opened"] }, { type: "label" }, { type: "pull_request", action: ["open"] }]) {
		assert.throws(() => parse([{ ...base(), on: { ...on, forge: "github", id: "maintain" } }]), { piDispatchConfig: true });
	}
	const noCommand = base(); delete noCommand.run.command;
	assert.throws(() => parse([noCommand]), /run.command only/);
});

test("identity, debounce, worker and review-author policy fail loudly", () => {
	for (const [key, values] of Object.entries({ forge: [undefined, "elsewhere"], id: [undefined, "", "has:colon", "x".repeat(65)], debounceSeconds: [null, -1, 301, 1.5, "10"], reviewAuthors: [null, [], ["Somebody"], ["*"], ["same", "same"], Array.from({ length: 33 }, (_, i) => `bot${i}`)] })) {
		for (const value of values) { const input = base(); input.on[key] = value; assert.throws(() => parse([input]), { piDispatchConfig: true }, `${key}: ${JSON.stringify(value)}`); }
	}
	for (const worker of [undefined, "", "has:colon", "a.json", "a.LOG", "x".repeat(65)]) {
		assert.throws(() => parse([{ ...base(), run: { ...base().run, worker } }]), /run.worker/);
	}
	assert.throws(() => parse([base(), base()]), /duplicate local event on.id/);
	const input = base(); input.on.reviewAuthors = ["reviewer-app[bot]", "reviewer"]; input.on.debounceSeconds = 0;
	const [got] = parse([input]);
	assert.deepEqual(got.on.reviewAuthors, input.on.reviewAuthors);
	assert.equal(got.on.debounceSeconds, 0);
	for (const action of [["opened"], ["closed"]]) assert.throws(() => parse([{ ...input, on: { ...input.on, action } }]), /reviewAuthors/);
});

test("independent local comment listeners coexist with the existing single forge comment rule", () => {
	const old = { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } };
	const local = { ...base(), on: { ...base().on, type: "comment", phrase: "@maintain" } };
	const second = { ...local, on: { ...local.on, id: "second", phrase: "@other" } };
	assert.equal(parse([old, local, second]).length, 3);
	assert.throws(() => parse([old, old, local]), /at most one github comment/);
});

test("exact close actors are an opt-in grant on GitHub local close listeners only", () => {
	const input = base(); input.on.action = ["closed"]; input.on.closeActors = ["closer-app[bot]", "maintainer"];
	for (const type of ["issue", "pull_request"]) {
		input.on.type = type;
		assert.deepEqual(parse([input])[0].on.closeActors, input.on.closeActors);
	}
	assert.equal(triggersFileVersionFor({ triggers: [input] }), 10);
	assert.throws(() => parse([input], 9), /needs triggers file version 10/);
	for (const value of [null, [], ["Somebody"], ["*"], ["same", "same"], [" bot"], ["bot[bot]-impostor"], [7], Array.from({ length: 33 }, (_, i) => `bot${i}`)]) {
		assert.throws(() => parse([{ ...input, on: { ...input.on, closeActors: value } }]), /on.closeActors/);
	}
	for (const on of [
		{ forge: "gitlab" }, { forge: "forgejo" }, { forge: "azure" },
		{ type: "label", any: ["ready"] }, { type: "comment", phrase: "@sweep" },
		{ action: ["opened"] }, { action: ["review_submitted"] }, { action: ["closed", "opened"] },
	]) assert.throws(() => parse([{ ...input, on: { ...input.on, ...on } }]), /on.closeActors/);
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["closed"], closeActors: input.on.closeActors }, run: { kind: "github", flow: "fix" } }]), /on.closeActors.*only available/);
	assert.throws(() => parse([{ on: { type: "cron", id: "fallback", pattern: "0 * * * *", closeActors: input.on.closeActors }, run: { kind: "local", folder: "/srv/maintenance", command: "sweep" } }]), /on.closeActors.*only available/);
	input.on.once = true; input.on.number = 7; input.on.disarmed = { at: "2026-11-20T10:00:00Z", jobId: "local-event-test" };
	assert.deepEqual(parse([input])[0], { on: { type: "disarmed" }, run: {} });
	input.on.closeActors = ["*"];
	assert.throws(() => parse([input]), /on.closeActors/, "disarmed definitions still validate the grant");
});

test("local close one-shots validate completely and collapse spent rules", () => {
	const input = base(); input.on = { ...input.on, action: ["closed"], number: 7, once: true };
	assert.equal(parse([input])[0].on.once, true);
	input.on.disarmed = { at: "2026-11-16T10:00:00Z", jobId: "local-event-test" };
	assert.deepEqual(parse([input])[0], { on: { type: "disarmed" }, run: {} });
	input.run.command = "/invalid";
	assert.throws(() => parse([input]), /must not start/);
});

test("new authority stamps only files and jobs using it; previous readers defer", () => {
	assert.equal(triggersFileVersionFor({ triggers: [base()] }), 5);
	assert.throws(() => parse([base()], 4), /needs triggers file version 5/);
	const cron = { on: { type: "cron", id: "fallback", pattern: "0 * * * *" }, run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs" } };
	assert.equal(triggersFileVersionFor({ triggers: [cron] }), 1);
	assert.equal(sourceForgeOf(cron), null);
	cron.run.worker = "build1";
	assert.equal(triggersFileVersionFor({ triggers: [cron] }), 5);
	assert.equal(parse([cron])[0].run.worker, "build1");
	for (const extra of [{ worker: "build1" }, { localEvent: { id: "maintain" } }]) {
		const job = withJobDataVersion({ kind: "local", ...extra });
		assert.equal(job.dataVersion, 6, "later policy fields must not raise the minimum for existing local events");
		assert.deepEqual(jobDataNewer(job, { supported: 5 }), { version: 6 });
	}
	assert.deepEqual(withJobDataVersion({ kind: "local" }), { kind: "local" });
	for (const on of [{ type: "cron", id: "fallback", pattern: "0 * * * *", debounceSeconds: 10 }, { type: "label", any: ["ready"], reviewAuthors: ["reviewer"] }]) {
		assert.throws(() => parse([{ on, run: on.type === "cron" ? cron.run : { kind: "github", flow: "fix" } }]), /only available/);
	}
});
