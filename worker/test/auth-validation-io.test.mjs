import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAuthService } from "../src/auth-connections.mjs";
import { createAuthStore } from "../src/auth-store.mjs";
import { createDefaultAuthAdapters, prepareCommunityAuthAdapter } from "../src/community-auth-adapters.mjs";
import { makeProcessor } from "../src/index.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { readAuthPolicy } from "../src/subscription-config.mjs";
import { makeSubscriptionRuntime } from "../src/subscription-runtime.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const AT = 1_800_000_000_000;
const now = () => AT;
const sentinel = "PRIVATE-REFRESH-SENTINEL";
const adapter = "@gotgenes/pi-anthropic-auth@3.4.3";
const openaiPolicy = { version: 1, connections: [{ id: "chatgpt", provider: "openai", adapter: "openai-chatgpt", ownerHost: "owner" }], bindings: { openai: "chatgpt" } };

function policyFixture() {
	const root = tempDir("auth-policy-read-");
	const path = join(root, "policy.json");
	fs.writeFileSync(path, JSON.stringify(openaiPolicy), { mode: 0o600 });
	return { root, path };
}

test("policy reads classify every unanswered I/O stage as transient and keep explicit refusals determinate", async t => {
	const { root, path } = policyFixture();
	for (const site of ["openSync", "fstatSync", "readFileSync", "closeSync"]) for (const code of ["EIO", "EACCES", "EFUTURE", undefined]) await t.test(`${site} ${code ?? "uncoded"}`, async () => {
		const view = { ...fs, [site](...args) {
			if (site === "closeSync") fs.closeSync(...args);
			throw Object.assign(new Error(`${path} ${sentinel}`), { code });
		} };
		assert.throws(() => readAuthPolicy(path, { fs: view }), error => error.code === "auth-policy-unavailable" && error.transient === true && !error.message.includes(path) && !error.message.includes(sentinel));
		const service = createAuthService({ readPolicy: () => readAuthPolicy(path, { fs: view }), storeDir: join(root, "private"), host: "owner", now, adapters: {} });
		assert.deepEqual(await service.check("openai"), { ok: false, managed: true, reason: "auth-policy-unavailable", unavailable: true });
	});
	for (const code of ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]) {
		assert.throws(() => readAuthPolicy(path, { fs: { ...fs, openSync() { throw Object.assign(new Error(path), { code }); } } }), { code: "auth-policy-invalid", transient: false });
	}
	fs.writeFileSync(path, "{ malformed");
	assert.throws(() => readAuthPolicy(path), { code: "auth-policy-invalid", transient: false });
});

test("actual permission-denied policy reads retry and recover without policy changes", { skip: process.getuid?.() === 0 ? "a root process bypasses filesystem read permissions; injected I/O covers every stage" : false }, async () => {
	const { root, path } = policyFixture();
	const service = createAuthService({ readPolicy: () => readAuthPolicy(path), storeDir: join(root, "private"), host: "owner", now, adapters: {} });
	fs.chmodSync(path, 0o000);
	try { assert.deepEqual(await service.check("openai"), { ok: false, managed: true, reason: "auth-policy-unavailable", unavailable: true }); }
	finally { fs.chmodSync(path, 0o600); }
	assert.equal(readAuthPolicy(path).bindings.openai, "chatgpt");
});

async function adapterFixture() {
	const root = tempDir("auth-validator-source-");
	execFileSync("tar", ["-xzf", fileURLToPath(new URL("./fixtures/community-auth/gotgenes-pi-anthropic-auth-3.4.3.tar.gz", import.meta.url)), "--strip-components=1", "-C", root]);
	const approved = prepareCommunityAuthAdapter({ adapter, root });
	const policy = { version: 1, connections: [{ id: "claude", provider: "anthropic", adapter, ownerHost: "owner", root, digest: approved.digest }], bindings: { anthropic: "claude" } };
	const storeDir = join(tempDir("auth-validator-store-"), "private");
	const store = createAuthStore({ dir: storeDir });
	await createAuthService({ policy, host: "owner", store, now, adapters: { [adapter]: { login: async () => ({ access: "sk-ant-oat-fixture", refresh: sentinel, expires: AT + 3_600_000 }) } } }).login("claude");
	const privatePath = join(storeDir, "claude.json");
	const bytes = fs.readFileSync(privatePath, "utf8");
	const service = (view = fs) => createAuthService({ policy, host: "owner", store, now, adapters: createDefaultAuthAdapters({ now, fs: view, fetch: async () => { throw new Error("validation must never call a provider"); } }) });
	return { root, policy, approved, service, privatePath, bytes, store };
}

async function pickup(service, transient, { provider = "anthropic", model = "claude-sonnet-4-5" } = {}) {
	const calls = [], records = [];
	const runtime = makeSubscriptionRuntime({ auth: service, quota: { admit: async () => { calls.push("quota"); throw new Error("not reached"); } }, now, lookup: () => ({ api: provider === "openai" ? "openai-responses" : "anthropic-messages", baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com" }) });
	const redis = { get: async () => null, set: async () => "OK", expire: async () => 1, incr: async () => { calls.push("reserve"); return 1; }, decr: async () => 0 };
	const processJob = makeProcessor({ redis, now, cancelJob() {}, stopContainer() {}, getSettings: () => ({ provider, model, maxTurns: 5, dailyCap: 10, concurrency: 1, softHoldPct: null }), recordRun: record => records.push(record), deps: {
		subscriptionRuntime: runtime, now: new Date(AT), checkProviderCredential: () => { calls.push("api-key"); return { ok: true }; },
		mintToken: async () => { calls.push("mint"); return "token"; }, prepareWorkspace: async () => { calls.push("prepare"); }, runContainer: async () => { calls.push("container"); }, cleanup: async () => {}, comment: async () => {}, log: () => {},
	} });
	const operation = processJob({ id: "adapter-read-fault", name: "github", data: { kind: "github", repo: "org/repo", provider, model, models: [`${provider}/${model}`] }, attemptsMade: 0, opts: {} }, "lock", new AbortController().signal);
	if (transient) await assert.rejects(operation, error => error instanceof InfraRetry && error.budgetReserved === false);
	else {
		const result = await operation;
		assert.equal(result.reason, "auth-adapter-unavailable");
		assert.equal(result.budgetReserved, false);
	}
	assert.deepEqual(calls, [], "no quota, API-key fallback, mint, preparation, reservation or container before adapter validation");
	assert.equal(JSON.stringify(records).includes(sentinel), false);
}

test("default OpenAI validation checks actual pinned bytes and classifies source absence, read faults and empty source", async t => {
	let sourcePath;
	await createDefaultAuthAdapters({ now, fs: { ...fs, readFileSync(path, ...args) { sourcePath = path; return fs.readFileSync(path, ...args); } } })["openai-chatgpt"].validate();
	assert.equal(sourcePath.endsWith("/auth/oauth/openai-chatgpt.js"), true, "the normal validator reads the actual installed pinned artifact");
	for (const failure of ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EIO", "EACCES", "EFUTURE", "uncoded", "empty-source"]) await t.test(failure, async () => {
		const view = { ...fs, readFileSync(path, ...args) {
			if (path !== sourcePath) return fs.readFileSync(path, ...args);
			if (failure === "empty-source") return Buffer.alloc(0);
			throw Object.assign(new Error(`${path} ${sentinel}`), { code: failure === "uncoded" ? undefined : failure });
		} };
		const adapters = createDefaultAuthAdapters({ now, fs: view });
		const transient = ["EIO", "EACCES", "EFUTURE", "uncoded"].includes(failure);
		const reason = ["ENOENT", "ENOTDIR"].includes(failure) ? "auth-adapter-unstaged" : failure === "empty-source" ? "auth-adapter-source-mismatch" : "auth-adapter-unavailable";
		await assert.rejects(adapters["openai-chatgpt"].validate(), error => error.code === reason && (error.transient === true) === transient && !error.message.includes(sourcePath) && !error.message.includes(sentinel));
		const service = createAuthService({ policy: openaiPolicy, host: "owner", now, adapters, store: { read() { throw new Error("must refuse before credential resolution"); } } });
		assert.deepEqual(await service.check("openai"), { ok: false, managed: true, reason, unavailable: transient });
		if (["ENOENT", "EIO", "empty-source"].includes(failure)) await pickup(service, transient, { provider: "openai", model: "gpt-4.1" });
	});
});

test("real staged adapter metadata damage is determinate at service and pickup, and never changes private credentials", async t => {
	for (const damage of ["missing-package", "malformed-receipt", "null-package", "null-receipt"]) await t.test(damage, async () => {
		const f = await adapterFixture();
		assert.equal((await f.service().check("anthropic")).ok, true);
		if (damage === "missing-package") fs.unlinkSync(join(f.root, "package.json"));
		else fs.writeFileSync(join(f.root, damage === "null-package" ? "package.json" : ".dispatch-auth-adapter.json"), damage === "malformed-receipt" ? "{ malformed" : "null");
		const service = f.service();
		const result = await service.check("anthropic");
		assert.equal(result.unavailable, false);
		assert.equal(result.reason, damage === "missing-package" ? "auth-adapter-unstaged" : "auth-adapter-unavailable");
		assert.equal((await service.status())[0].compatibility, damage === "missing-package" ? "unstaged" : "unavailable");
		assert.equal((await service.prepareSnapshot("anthropic", { deadlineAt: AT + 30 * 60_000 })).unavailable, false);
		await pickup(service, false);
		assert.equal(fs.readFileSync(f.privatePath, "utf8"), f.bytes);
		assert.equal(JSON.stringify(result).includes(f.root), false);
	});
});

test("actual adapter validation I/O faults retry through service and pickup, then recover the same credential", async t => {
	const f = await adapterFixture();
	for (const code of ["EIO", "EACCES", "EFUTURE", undefined]) await t.test(code ?? "uncoded", async () => {
		let armed = true;
		const view = { ...fs, readFileSync(path, ...args) {
			if (armed && path === join(f.root, "package.json")) throw Object.assign(new Error(`${f.root} ${sentinel}`), { code });
			return fs.readFileSync(path, ...args);
		} };
		const service = f.service(view);
		assert.deepEqual(await service.check("anthropic"), { ok: false, managed: true, reason: "auth-adapter-unavailable", unavailable: true });
		assert.equal((await service.prepareSnapshot("anthropic", { deadlineAt: AT + 30 * 60_000 })).unavailable, true);
		await pickup(service, true);
		assert.equal(fs.readFileSync(f.privatePath, "utf8"), f.bytes);
		armed = false;
		assert.equal((await service.check("anthropic")).ok, true);
	});
});

test("local default-adapter validation after the marker restores the unchanged grant before any remote renewal", async t => {
	for (const failure of ["missing", "EIO"]) await t.test(failure, async () => {
		const f = await adapterFixture();
		await f.store.transaction("claude", async (row, write) => write({ ...row, credential: { ...row.credential, expires: AT + 1000 } }));
		const before = fs.readFileSync(f.privatePath, "utf8");
		let marked = false, remote = 0;
		const view = { ...fs, readFileSync(path, ...args) {
			if (marked && failure === "EIO" && path === join(f.root, "package.json")) throw Object.assign(new Error(f.root), { code: "EIO" });
			return fs.readFileSync(path, ...args);
		} };
		const store = { read: f.store.read, transaction: (id, fn, options) => f.store.transaction(id, (row, write) => fn(row, async next => {
			await write(next);
			if (next.state === "refresh-uncertain") {
				marked = true;
				if (failure === "missing") fs.unlinkSync(join(f.root, ".dispatch-auth-adapter.json"));
			}
		}), options) };
		const service = createAuthService({ policy: f.policy, host: "owner", store, now, adapters: createDefaultAuthAdapters({ now, fs: view, fetch: async () => { remote++; throw new Error("must fail before renewal"); } }) });
		const result = await service.prepareSnapshot("anthropic", { deadlineAt: AT + 30 * 60_000 });
		assert.equal(marked, true, "ordinary service checks must succeed before the local preflight fails");
		assert.deepEqual(result, { ok: false, reason: failure === "missing" ? "auth-adapter-unstaged" : "auth-adapter-unavailable", unavailable: failure !== "missing" });
		assert.equal(remote, 0);
		assert.equal(fs.readFileSync(f.privatePath, "utf8"), before, "state, credential, generation and registration are restored exactly");
	});
});

test("actual default-adapter remote rejection and uncertain transport retain their distinct renewal outcomes", async t => {
	for (const outcome of ["invalid-grant", "uncertain"]) await t.test(outcome, async () => {
		const f = await adapterFixture();
		await f.store.transaction("claude", async (row, write) => write({ ...row, credential: { ...row.credential, expires: AT + 1000 } }));
		let remote = 0;
		const adapters = createDefaultAuthAdapters({ now, fetch: async () => {
			remote++;
			if (outcome === "uncertain") throw Object.assign(new Error("unanswered renewal"), { beforeRefresh: true });
			return Response.json({ error: "invalid_grant", beforeRefresh: true }, { status: 400 });
		} });
		const service = createAuthService({ policy: f.policy, host: "owner", store: f.store, now, adapters });
		const result = await service.prepareSnapshot("anthropic", { deadlineAt: AT + 30 * 60_000 });
		assert.equal(remote, 1);
		const saved = f.store.read("claude");
		if (outcome === "invalid-grant") {
			assert.equal(result.reason, "auth-reauth-required");
			assert.equal(saved.state, "reauth-required");
			assert.equal(saved.credential, null);
		} else {
			assert.equal(result.reason, "auth-network-unavailable");
			assert.equal(saved.state, "refresh-uncertain");
			assert.equal(saved.credential.refresh, sentinel);
		}
	});
});
