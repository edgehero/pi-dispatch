import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dropModelAttempt, finishModelAttempt, keepModelAttempt, modelAttemptIdOf, modelAttemptKey } from "../src/model-attempts.mjs";
import { modelAttemptKey as reExported, readModelAttempt, writeModelAttempt } from "../src/model-failover.mjs";
import { MODEL_ATTEMPT_FINISHED_TTL_MS } from "../src/retention.mjs";

// A model attempt key's life (issue #812): no expiry while a retry may come, an expiry once the queue says the job
// finished, a delete when a cancel removes the job, a console retry's `PERSIST` and a retry's write that clear the expiry
// again. The fake below keeps Valkey's expiry rules on an injected clock: a key with an expiry at T is still there at T
// and gone after it (`keyIsExpired`: now > when), `PEXPIRE` on an absent key sets nothing and answers 0, a plain `SET`
// drops the expiry, and `PERSIST` drops it too, answering 0 for an absent key or one without an expiry.
// model-failover.integration.test.mjs checks the same rules against a real server.

const T = Date.parse("2026-11-03T12:00:00.000Z");
const ID = modelAttemptIdOf("pi-jobs@mini1", "gh-812");

function fakeValkey(now) {
	const store = new Map();
	const live = (key) => {
		const entry = store.get(key);
		if (entry && entry.expireAt !== null && now() > entry.expireAt) {
			store.delete(key);
			return undefined;
		}
		return entry;
	};
	return {
		store,
		async get(key) {
			return live(key)?.value ?? null;
		},
		async set(key, value, ...args) {
			const px = args.findIndex((a) => String(a).toUpperCase() === "PX");
			if (args.some((a) => String(a).toUpperCase() === "NX") && live(key)) return null;
			store.set(key, { value: String(value), expireAt: px >= 0 ? now() + Number(args[px + 1]) : null });
			return "OK";
		},
		async pexpire(key, ms) {
			const entry = live(key);
			if (!entry) return 0;
			entry.expireAt = now() + Number(ms);
			return 1;
		},
		async pttl(key) {
			const entry = live(key);
			if (!entry) return -2;
			return entry.expireAt === null ? -1 : entry.expireAt - now();
		},
		async del(key) {
			if (!live(key)) return 0;
			store.delete(key);
			return 1;
		},
		async persist(key) {
			const entry = live(key);
			if (!entry || entry.expireAt === null) return 0;
			entry.expireAt = null;
			return 1;
		},
	};
}

const clock = () => {
	const c = () => c.at;
	c.at = T;
	return c;
};

test("the key and the id: the processor's `queueName:jobId`, hashed into dispatch:model-attempt:, the one model-failover.mjs exports", () => {
	assert.equal(ID, "pi-jobs@mini1:gh-812");
	assert.equal(modelAttemptKey(ID), `dispatch:model-attempt:${createHash("sha256").update("pi-jobs@mini1:gh-812").digest("hex")}`);
	assert.equal(reExported, modelAttemptKey);
	// Light, so the admin's cancel path can import it: the crypto module and the retention leaf, nothing else.
	const src = readFileSync(new URL("../src/model-attempts.mjs", import.meta.url), "utf8");
	assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["node:crypto", "./retention.mjs"]);
	assert.equal(/\bimport\s*\(/.test(src), false, "no dynamic import");
});

test("a finished job's key is there one millisecond before its expiry and gone after it; until it finished it had none", async () => {
	const now = clock();
	const redis = fakeValkey(now);
	await writeModelAttempt(redis, ID, { ref: "openai/fallback", modelWhy: "fallback-cooldown" });
	now.at = T + 400 * 24 * 3600 * 1000;
	assert.equal(await redis.pttl(modelAttemptKey(ID)), -1, "a retry that waits any time still finds it");
	await finishModelAttempt(redis, ID);
	const at = now.at;
	assert.equal(await redis.pttl(modelAttemptKey(ID)), MODEL_ATTEMPT_FINISHED_TTL_MS);
	now.at = at + MODEL_ATTEMPT_FINISHED_TTL_MS - 1;
	assert.equal((await readModelAttempt(redis, ID))?.ref, "openai/fallback");
	assert.equal(await redis.pttl(modelAttemptKey(ID)), 1);
	now.at = at + MODEL_ATTEMPT_FINISHED_TTL_MS + 1;
	assert.equal(await readModelAttempt(redis, ID), null);
	assert.equal(redis.store.size, 0, "the key is gone");
});

test("a retry's write clears the expiry again: a job retried from the console keeps its key while it may retry once more", async () => {
	const now = clock();
	const redis = fakeValkey(now);
	await writeModelAttempt(redis, ID, { ref: "anthropic/primary" });
	await finishModelAttempt(redis, ID);
	assert.ok((await redis.pttl(modelAttemptKey(ID))) > 0, "the finished job's key has an expiry");
	now.at = T + MODEL_ATTEMPT_FINISHED_TTL_MS - 60_000;
	await writeModelAttempt(redis, ID, { ref: "openai/fallback", modelWhy: "fallback-unavailable" });
	assert.equal(await redis.pttl(modelAttemptKey(ID)), -1);
	now.at = T + 10 * MODEL_ATTEMPT_FINISHED_TTL_MS;
	assert.equal((await readModelAttempt(redis, ID))?.ref, "openai/fallback");
});

test("finishing a job that has no key creates nothing: a job without fallbacks never had one", async () => {
	const now = clock();
	const redis = fakeValkey(now);
	await finishModelAttempt(redis, ID);
	assert.equal(redis.store.size, 0);
	assert.equal(await redis.pttl(modelAttemptKey(ID)), -2);
	// Nor after it was dropped: a cancel, then the finish of the same id, leaves no key either.
	await writeModelAttempt(redis, ID, { ref: "anthropic/primary" });
	await dropModelAttempt(redis, ID);
	await finishModelAttempt(redis, ID);
	assert.equal(redis.store.size, 0);
});

test("dropping deletes the key, an absent key is no fault, and a delete that hangs, rejects or throws is bounded and never thrown", { timeout: 10_000 }, async () => {
	const now = clock();
	const redis = fakeValkey(now);
	await writeModelAttempt(redis, ID, { ref: "anthropic/primary" });
	await writeModelAttempt(redis, modelAttemptIdOf("pi-jobs", "gh-other"), { ref: "anthropic/primary" });
	await dropModelAttempt(redis, ID);
	assert.equal(await readModelAttempt(redis, ID), null);
	assert.equal(redis.store.size, 1, "only that job's key");
	await dropModelAttempt(redis, ID);
	for (const del of [() => new Promise(() => {}), async () => { throw new Error("ECONNRESET"); }, () => { throw new Error("not connected"); }]) {
		const t0 = Date.now();
		await dropModelAttempt({ del }, ID, 30);
		assert.ok(Date.now() - t0 < 1000, "bounded");
	}
	await dropModelAttempt({}, ID);
	await dropModelAttempt(null, ID);
	// The bound's timer is cleared once the delete answers, so a CLI is not held open by it.
	const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	const before = timers();
	await dropModelAttempt(redis, ID, 60_000);
	assert.equal(timers(), before);
});

test("keeping takes a finished job's expiry off, creates nothing for an absent key, and is bounded and never thrown", { timeout: 10_000 }, async () => {
	const now = clock();
	const redis = fakeValkey(now);
	await writeModelAttempt(redis, ID, { ref: "openai/fallback", modelWhy: "fallback-cooldown" });
	await finishModelAttempt(redis, ID);
	// Retried from the console a day before the expiry; the retry then waits far past it before its next selection.
	now.at = T + MODEL_ATTEMPT_FINISHED_TTL_MS - 24 * 3600 * 1000;
	await keepModelAttempt(redis, ID);
	assert.equal(await redis.pttl(modelAttemptKey(ID)), -1);
	now.at = T + 10 * MODEL_ATTEMPT_FINISHED_TTL_MS;
	assert.equal((await readModelAttempt(redis, ID))?.ref, "openai/fallback", "the waiting retry still finds its evidence");
	// A job without fallbacks, or one whose key already expired: nothing is created.
	const other = modelAttemptIdOf("pi-jobs", "gh-none");
	await keepModelAttempt(redis, other);
	assert.equal(await redis.pttl(modelAttemptKey(other)), -2);
	assert.equal(redis.store.size, 1);
	for (const persist of [() => new Promise(() => {}), async () => { throw new Error("ECONNRESET"); }, () => { throw new Error("not connected"); }]) {
		const t0 = Date.now();
		await keepModelAttempt({ persist }, ID, 30);
		assert.ok(Date.now() - t0 < 1000, "bounded");
	}
	await keepModelAttempt({}, ID);
	await keepModelAttempt(null, ID);
	await keepModelAttempt(redis, undefined, 30);
	const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	const before = timers();
	await keepModelAttempt(redis, ID, 60_000);
	assert.equal(timers(), before);
});
