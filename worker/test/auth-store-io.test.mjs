import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAuthService } from "../src/auth-connections.mjs";
import { createAuthStore } from "../src/auth-store.mjs";
import { makeProcessor } from "../src/index.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { makeSubscriptionRuntime } from "../src/subscription-runtime.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const AT = 1_800_000_000_000;
const now = () => AT;
const policy = { version: 1, connections: [{ id: "chatgpt", provider: "openai", adapter: "openai-chatgpt", ownerHost: "owner" }], bindings: { openai: "chatgpt" } };

async function fixture(site, code) {
	const dir = join(tempDir("subscription-read-io-"), "private");
	let renewals = 0;
	const adapters = { "openai-chatgpt": { login: async () => ({ access: "access-sentinel", refresh: "refresh-sentinel", expires: AT + 3_600_000 }), refresh: async () => { renewals++; throw new Error("no renewal before a successful read"); } } };
	const base = createAuthService({ policy, host: "owner", storeDir: dir, now, adapters });
	await base.login("chatgpt");
	const path = join(dir, "chatgpt.json");
	const bytes = fs.readFileSync(path, "utf8");
	let armed = true;
	const view = { ...fs, [site](...args) {
		if (!armed) return fs[site](...args);
		// Closing still releases the real descriptor when the injected close acknowledgement fails.
		if (site === "closeSync") fs.closeSync(...args);
		throw Object.assign(new Error(`${path} refresh-sentinel`), { code });
	} };
	const store = createAuthStore({ dir, fs: view });
	const service = createAuthService({ policy, host: "owner", store, now, adapters });
	return { service, store, path, bytes, disarm: () => { armed = false; }, renewals: () => renewals };
}

test("credential read faults stay retryable at every I/O stage and preserve the durable grant", async t => {
	for (const site of ["lstatSync", "openSync", "fstatSync", "readFileSync", "closeSync"]) for (const code of ["EIO", "EACCES", "EFUTURE", undefined]) await t.test(`${site} ${code ?? "uncoded"}`, async () => {
		const f = await fixture(site, code);
		assert.throws(() => f.store.read("chatgpt"), error => error.code === "auth-store-unavailable" && error.transient === true && !error.message.includes(f.path) && !error.message.includes("sentinel"));
		const expected = { ok: false, managed: true, reason: "auth-store-unavailable", unavailable: true };
		assert.deepEqual(await f.service.check("openai"), expected);
		const prepared = await f.service.prepareSnapshot("openai", { deadlineAt: AT + 30 * 60_000 });
		assert.deepEqual(prepared, expected);
		assert.equal(Object.hasOwn(prepared, "snapshot"), false);
		assert.equal(f.renewals(), 0);
		assert.equal(fs.readFileSync(f.path, "utf8"), f.bytes);
		f.disarm();
		assert.equal((await f.service.check("openai")).ok, true, "a recovered read resumes the same credential without reauthentication");
	});
});

test("a real store-path symlink loop refuses determinately, while an absent store remains an empty read", async () => {
	const root = tempDir("subscription-store-loop-");
	fs.symlinkSync("loop", join(root, "loop"));
	const store = createAuthStore({ dir: join(root, "loop", "private") });
	assert.throws(() => store.read("chatgpt"), error => error.code === "auth-store-invalid" && error.transient === false && !error.message.includes(root));
	const service = createAuthService({ policy, host: "owner", now, store, adapters: { "openai-chatgpt": { validate() {} } } });
	assert.deepEqual(await service.check("openai"), { ok: false, managed: true, reason: "auth-store-invalid", unavailable: false });
	await assert.rejects(store.transaction("chatgpt", async () => { throw new Error("must refuse before a transaction callback"); }), { code: "auth-store-invalid", transient: false });
	const absent = join(root, "absent");
	assert.equal(createAuthStore({ dir: absent }).read("chatgpt"), null);
	assert.equal(fs.existsSync(absent), false);
});

test("malformed credential bytes remain a determinate refusal", async () => {
	const f = await fixture("readFileSync", "EIO");
	f.disarm();
	fs.writeFileSync(f.path, "{ damaged refresh-sentinel");
	assert.deepEqual(await f.service.check("openai"), { ok: false, managed: true, reason: "auth-store-invalid", unavailable: false });
	assert.equal(f.renewals(), 0);
});

test("actual pickup retries a credential read fault before quota, API-key fallback, mint or reservation", async () => {
	const f = await fixture("readFileSync", "EIO");
	const calls = [];
	const runtime = makeSubscriptionRuntime({ auth: f.service, quota: { admit: async () => { calls.push("quota"); throw new Error("not reached"); } }, now, lookup: () => ({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }) });
	const records = [];
	const redis = { get: async () => null, set: async () => "OK", expire: async () => 1, incr: async () => { calls.push("reserve"); return 1; }, decr: async () => 0, eval: async () => { calls.push("reserve"); throw new Error("not reached"); } };
	const processJob = makeProcessor({ redis, now, cancelJob() {}, stopContainer() {}, getSettings: () => ({ provider: "openai", model: "gpt-4.1", maxTurns: 5, dailyCap: 10, concurrency: 1, softHoldPct: null }), recordRun: record => records.push(record), deps: {
		subscriptionRuntime: runtime, now: new Date(AT),
		checkProviderCredential: () => { calls.push("api-key"); return { ok: true }; },
		mintToken: async () => { calls.push("mint"); return "token"; },
		prepareWorkspace: async () => { calls.push("prepare"); }, runContainer: async () => { calls.push("container"); },
		cleanup: async () => {}, comment: async () => {}, log: () => {},
	} });
	for (const github of [false, true]) await assert.rejects(processJob({ id: `credential-read-fault-${github}`, name: "local", data: { kind: "local", github, folder: tempDir("subscription-read-workspace-"), repo: "org/repo", provider: "openai", model: "gpt-4.1", models: ["openai/gpt-4.1"], task: "work" }, attemptsMade: 0, opts: {} }, "lock", new AbortController().signal), error => error instanceof InfraRetry && error.reason === "container-never-started" && error.budgetReserved === false);
	assert.deepEqual(calls, []);
	assert.equal(f.renewals(), 0);
	assert.equal(fs.readFileSync(f.path, "utf8"), f.bytes);
	assert.equal(JSON.stringify(records).includes(f.path), false);
	assert.equal(JSON.stringify(records).includes("sentinel"), false);
});
