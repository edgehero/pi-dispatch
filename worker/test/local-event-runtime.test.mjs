import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocalEventJob, localEventJobId } from "../src/local-event.mjs";
import { LocalEventWait, makeLocalEventRuntime } from "../src/local-event-runtime.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";

const refusal = (reason) => ({ outcome: "policy", reason, budgetReserved: false });
function fixture({ once = false } = {}) {
	const raw = {
		on: { type: "issue", forge: "github", id: "maintenance", action: ["closed"], debounceSeconds: 10, ...(once && { once: true, number: 7 }) },
		run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker: "owner" },
	};
	const document = { version: TRIGGERS_FILE_VERSION, triggers: [raw] };
	const [trigger] = parseTriggers(JSON.stringify(document), "triggers.json");
	const generation = "a".repeat(32);
	const job = { id: localEventJobId(generation), data: JSON.parse(JSON.stringify(buildLocalEventJob(trigger, generation))) };
	const h = {
		document, raw, trigger, job, instant: 10_000, text: null, readError: null, reads: 0, claims: [],
		state: { current: { generation, phase: "pending", dueAt: 10_000, data: job.data } },
		claimResult: { ok: true, count: 1 },
		onClaim: null,
	};
	h.store = {
		async read() { return h.state; },
		async claim(meta, owner) { h.claims.push({ meta, owner }); return h.onClaim ? h.onClaim() : h.claimResult; },
	};
	h.runtime = makeLocalEventRuntime({ store: h.store, worker: "owner", triggersPath: "triggers.json", now: () => h.instant, readFile(path, encoding) {
		assert.equal(path, "triggers.json"); assert.equal(encoding, "utf8"); h.reads++;
		if (h.readError) throw h.readError;
		return h.text ?? JSON.stringify(h.document);
	} });
	return h;
}

test("local event authority survives object order and trigger row order changes", async () => {
	const h = fixture();
	h.job.data.localEvent = Object.fromEntries(Object.entries(h.job.data.localEvent).reverse());
	h.document.triggers.unshift({ on: { type: "label", any: ["ready"] }, run: { kind: "github", flow: "fix" } });
	h.document.triggers[1] = { run: Object.fromEntries(Object.entries(h.raw.run).reverse()), on: Object.fromEntries(Object.entries(h.raw.on).reverse()) };
	assert.deepEqual(await h.runtime.check(h.job), { ok: true, index: 1 });
	assert.deepEqual(await h.runtime.claim(h.job, "attempt"), { ok: true });
	assert.equal(h.reads, 2, "the authority file is re-read immediately before claim");
	assert.deepEqual(h.claims, [{ meta: h.job.data.localEvent, owner: "attempt" }]);
});

test("local event identities and provenance must match their deterministic queue job", async () => {
	for (const change of [
		(h) => { h.job.id = "another-job"; },
		(h) => { h.job.data.kind = "github"; },
		(h) => { h.job.data.localEvent = null; },
		(h) => { h.job.data.localEvent.generation = "invalid"; },
		(h) => { h.job.data.localEvent.digest = "invalid"; },
		(h) => { h.job.data.localEvent.type = "watch"; },
		(h) => { h.job.data.localEvent.extra = "forged metadata"; },
		(h) => { h.job.data.localEvent.number = 999; },
	]) {
		const h = fixture(); change(h);
		assert.deepEqual(await h.runtime.claim(h.job, "attempt"), refusal("local-event-invalid"));
		assert.equal(h.claims.length, 0);
	}
});

test("the reviewed worker owns both the metadata and execution destination", async () => {
	for (const change of [
		(h) => { h.job.data.worker = "another-owner"; },
		(h) => { delete h.job.data.worker; },
		(h) => { h.job.data.localEvent.worker = "another-owner"; },
	]) {
		const h = fixture(); change(h);
		assert.deepEqual(await h.runtime.claim(h.job, "attempt"), refusal("local-event-wrong-worker"));
		assert.equal(h.reads, 0, "wrong placement is refused before reading that host's authority");
		assert.equal(h.claims.length, 0);
	}
});

test("changed definitions and changed queued execution fields cannot retain old authority", async () => {
	for (const change of [
		(h) => { h.raw.run.command = "different-command"; },
		(h) => { h.raw.run.folder = "/srv/other"; },
		(h) => { h.raw.on.debounceSeconds = 20; },
		(h) => { h.raw.on.once = true; h.raw.on.number = 9; },
		(h) => { h.raw.on.id = "replacement"; },
		(h) => { h.job.data.command = "different-command"; },
		(h) => { h.job.data.folder = "/srv/other"; },
		(h) => { h.job.data.task = "event body must not become instructions"; },
		(h) => { h.job.data.secrets = ["additional-secret"]; },
	]) {
		const h = fixture(); change(h);
		assert.deepEqual(await h.runtime.claim(h.job, "attempt"), refusal("local-event-trigger-changed"));
		assert.equal(h.claims.length, 0);
	}
});

test("a reviewed secret-bundle opt-out survives the job and remains part of runtime authority", async () => {
	const h = fixture();
	h.raw.run.secretBundle = false;
	const [trigger] = parseTriggers(JSON.stringify(h.document), "triggers.json");
	h.job.data = JSON.parse(JSON.stringify(buildLocalEventJob(trigger, h.job.data.localEvent.generation)));
	assert.equal(h.job.data.secretBundle, false);
	assert.deepEqual(await h.runtime.check(h.job), { ok: true, index: 0 });
	delete h.job.data.secretBundle;
	assert.deepEqual(await h.runtime.claim(h.job, "attempt"), refusal("local-event-trigger-changed"));
	assert.equal(h.claims.length, 0);
});

test("deletion, invalid configuration and a newer file are distinct free decisions", async () => {
	for (const [prepare, expected] of [
		[(h) => { h.document.triggers = []; }, refusal("local-event-trigger-changed")],
		[(h) => { h.readError = Object.assign(new Error("gone"), { code: "ENOENT" }); }, refusal("local-event-trigger-changed")],
		[(h) => { h.text = "{"; }, refusal("local-event-config-invalid")],
		[(h) => { h.raw.run.command = "/invalid"; }, refusal("local-event-config-invalid")],
		[(h) => { h.document.version = TRIGGERS_FILE_VERSION + 1; }, { newer: true }],
	]) {
		const h = fixture(); prepare(h);
		assert.deepEqual(await h.runtime.claim(h.job, "attempt"), expected);
		assert.equal(h.claims.length, 0);
	}
	const h = fixture();
	h.readError = Object.assign(new Error("temporary read failure"), { code: "EIO" });
	await assert.rejects(h.runtime.claim(h.job, "attempt"), (error) => error === h.readError);
	assert.equal(h.claims.length, 0, "infrastructure failures propagate without claiming intent");
});

test("a file edited after pickup is checked again at claim", async () => {
	const h = fixture();
	assert.deepEqual(await h.runtime.check(h.job), { ok: true, index: 0 });
	h.raw.run.command = "replacement";
	assert.deepEqual(await h.runtime.claim(h.job, "attempt"), refusal("local-event-trigger-changed"));
	assert.equal(h.claims.length, 0);
});

test("missing, superseded and cancelled durable intents cannot be claimed", async () => {
	for (const [state, expected] of [
		[null, "local-event-superseded"],
		[{ current: { generation: "b".repeat(32) } }, "local-event-superseded"],
		[{ current: { generation: "a".repeat(32), cancelled: true } }, "operator-cancel"],
	]) {
		const h = fixture(); h.state = state;
		assert.deepEqual(await h.runtime.claim(h.job, "attempt"), refusal(expected));
		assert.equal(h.claims.length, 0);
	}
});

test("pending debounce waits without an attempt, and a retry of claimed work does not reopen the debounce", async () => {
	const h = fixture();
	h.state.current.dueAt = h.instant + 5_000;
	assert.deepEqual(await h.runtime.check(h.job), { untilMs: 15_000 });
	await assert.rejects(h.runtime.claim(h.job, "attempt"), (error) => error instanceof LocalEventWait && error.untilMs === 15_000);
	assert.equal(h.claims.length, 0);
	h.state.current.phase = "active";
	assert.deepEqual(await h.runtime.claim(h.job, "retry"), { ok: true });
	assert.equal(h.claims[0].owner, "retry");
});

test("a delivery, cancellation or supersession between read and atomic claim wins the race", async () => {
	for (const [answer, expected] of [
		[{ untilMs: 20_000 }, "wait"],
		[{ cancelled: true }, refusal("operator-cancel")],
		[{ stale: true }, refusal("local-event-superseded")],
	]) {
		const h = fixture();
		h.onClaim = () => answer;
		if (expected === "wait") await assert.rejects(h.runtime.claim(h.job, "attempt"), (error) => error instanceof LocalEventWait && error.untilMs === 20_000);
		else assert.deepEqual(await h.runtime.claim(h.job, "attempt"), expected);
		assert.equal(h.claims.length, 1);
	}
});

test("an exact one-shot attempt retains authority after its own disarm, but another attempt does not", async () => {
	const h = fixture({ once: true });
	h.raw.on.disarmed = { at: "2026-01-01T00:00:00Z", jobId: h.job.id };
	assert.deepEqual(await h.runtime.claim(h.job, "retry"), { ok: true });
	h.raw.on.disarmed.jobId = "another-job";
	assert.deepEqual(await h.runtime.claim(h.job, "next"), refusal("once-already-spent"));
	assert.equal(h.claims.length, 1);
	h.raw.on.disarmed.jobId = h.job.id;
	h.raw.run.command = "changed-after-disarm";
	assert.deepEqual(await h.runtime.claim(h.job, "changed"), refusal("local-event-trigger-changed"));
	assert.equal(h.claims.length, 1);
});
