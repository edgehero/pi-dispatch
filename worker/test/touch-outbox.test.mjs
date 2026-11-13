import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import * as fs from "node:fs";
import { makeTouchOutbox, trackTouchAction } from "../src/touch-outbox.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
const NOW = Date.UTC(2026, 9, 30);
const event = { runId: "run", cause: "rerun", at: NOW, nonce: "one-action" };

test("successful action and failed publication survive restart without repeating the action", async () => {
	const dir = join(tempDir("pd-touch-outbox-"), "outbox");
	let writes = 0;
	let calls = 0;
	let available = false;
	const store = { begin: async (e) => ({ ok: true, event: e }), abort: async () => ({}), write: async () => { writes++; return available ? { ok: true } : { error: "unavailable" }; } };
	let outbox = makeTouchOutbox({ dir, store });
	const result = await trackTouchAction({ outbox, event, act: async () => { calls++; return { ok: true }; } });
	assert.equal(result.ok, true);
	assert.equal(result.touchWarning, "touch-tracking-incomplete");
	assert.equal(calls, 1);
	assert.equal(fs.readdirSync(dir).length, 1);
	available = true;
	outbox = makeTouchOutbox({ dir, store });
	assert.deepEqual(await outbox.repair(), { repaired: 1, pending: 0, invalid: 0 });
	assert.equal(calls, 1);
	assert.equal(writes, 2);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test("a crash before an applied marker remains uncertain rather than fabricating a touch", async () => {
	const dir = join(tempDir("pd-touch-intent-"), "outbox");
	let writes = 0;
	let pending = 0;
	const store = { begin: async (e) => { pending++; return { ok: true, event: e }; }, write: async () => { writes++; return { ok: true }; } };
	await makeTouchOutbox({ dir, store }).begin(event);
	const read = await makeTouchOutbox({ dir, store }).repair();
	assert.equal(read.pending, 1);
	assert.equal(writes, 0);
	assert.equal(pending, 2);
});

test("refused or throwing actions abort their intent and never publish a successful touch", async () => {
	let aborts = 0;
	let writes = 0;
	const store = { begin: async (e) => ({ ok: true, event: e }), abort: async () => { aborts++; }, write: async () => { writes++; return { ok: true }; } };
	assert.deepEqual(await trackTouchAction({ store, event, act: async () => ({ invalid: "changed" }) }), { invalid: "changed" });
	await assert.rejects(trackTouchAction({ store, event, act: async () => { throw new Error("refused"); } }), /refused/);
	assert.equal(aborts, 2);
	assert.equal(writes, 0);
});

test("an action whose answer was lost aborts its intent too, so nothing is left that no reader can resolve (issue #867)", async () => {
	// The stop may have landed, so the stops count can be one short. Keeping the intent pending instead was tried and
	// REJECTED: nothing resolves it, and the Zero touch page would read unavailable for as long as anything is tracked.
	let aborts = 0;
	let writes = 0;
	const store = { begin: async (e) => ({ ok: true, event: e }), abort: async () => { aborts++; }, write: async () => { writes++; return { ok: true }; } };
	const lost = Object.assign(new Error("Command timed out"), { valkeyMayStillRun: true });
	await assert.rejects(trackTouchAction({ store, event, act: async () => { throw lost; } }), (error) => error === lost);
	assert.equal(aborts, 1);
	assert.equal(writes, 0);
});
