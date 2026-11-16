import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { commitModelSelection, readModelSelection, armModelSelection, allowModelSelectionQuotaReselection, reuseModelSelection, finishModelSelection, keepModelSelection, modelSelectionKey } from "../src/model-selection-state.mjs";
import { MODEL_ATTEMPT_FINISHED_TTL_MS } from "../src/retention.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("model-selection.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const skip = url ? false : "needs VALKEY_TEST_URL";
const NOW = 1_800_000_000_000;
const pool = ["openai/a", "anthropic/b"];

test("real Valkey atomically commits one selection, rejects stale execution/quota writers and preserves retry retention", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const clients = Array.from({ length: 8 }, () => makeRedisClient(url, {}));
	t.after(() => clients.forEach((client) => client.disconnect()));
	const id = randomUUID();
	const key = modelSelectionKey(id);
	try {
		const initial = await Promise.all(clients.map((redis, i) => commitModelSelection(redis, id, { ref: pool[i % 2], candidates: pool, now: () => NOW })));
		assert.equal(initial.filter((result) => result.ok).length, 1);
		assert.equal(await clients[0].pttl(key), -1);
		const selected = await readModelSelection(clients[0], id);
		const arms = await Promise.all(clients.map((redis) => armModelSelection(redis, id, selected)));
		assert.equal(arms.filter((result) => result.ok).length, 1);
		assert.equal((await allowModelSelectionQuotaReselection(clients[0], id, selected, { beforeStart: true, quotaConfirmed: true })).ok, false);
		const armed = await readModelSelection(clients[0], id);
		const result = { code: 1, exitLineCode: 1, exitAuth: "verified", toolsStarted: false, replaySafe: true, providerFailure: { kind: "quota-exhausted", subscriptionProvider: armed.ref.split("/")[0] } };
		const permissions = await Promise.all(clients.map((redis) => allowModelSelectionQuotaReselection(redis, id, armed, { result, quotaConfirmed: true })));
		assert.equal(permissions.filter((permission) => permission.ok).length, 1);
		const allowed = await readModelSelection(clients[0], id);
		assert.equal(await finishModelSelection(clients[0], id, { attempt: 1, expectedRevision: armed.revision }), false);
		assert.equal(await finishModelSelection(clients[0], id, { attempt: 1, expectedRevision: allowed.revision }), true);
		const ttl = await clients[0].pttl(key);
		assert.ok(ttl > 0 && ttl <= MODEL_ATTEMPT_FINISHED_TTL_MS);
		assert.equal(await keepModelSelection(clients[0], id), true);
		assert.equal(await clients[0].pttl(key), -1);
		const retry = (await reuseModelSelection(clients[0], id, await readModelSelection(clients[0], id), { attempt: 2 })).state;
		assert.equal(retry.phase, "quota-reselectable");
		assert.equal(await finishModelSelection(clients[0], id, { attempt: 1 }), false);
		assert.equal(await clients[0].pttl(key), -1);
	} finally {
		await clients[0].del(key);
	}
});
