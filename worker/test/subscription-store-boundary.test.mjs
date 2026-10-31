import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { makePrepareWorkspace } from "../src/prepare.mjs";
import { prepareLocalWorkspace } from "../src/prepare-local.mjs";
import { canonicalFuturePath, LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH, privateStoreExposed } from "../src/private-store-boundary.mjs";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { configuredSubscriptions } from "../src/subscription-config.mjs";
import { makeSubscriptionRuntime } from "../src/subscription-runtime.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = 1_800_000_000_000;
const secret = "PRIVATE-REFRESH-CUSTODY-SENTINEL";

function repo() {
	const folder = tempDir("subscription-local-repo-");
	const git = (...args) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
	fs.writeFileSync(join(folder, "untracked.txt"), "original working-tree bytes");
	return folder;
}

function redisFixture(calls = []) {
	const values = new Map();
	return {
		get: async key => values.get(key) ?? null,
		set: async (key, value) => { values.set(key, value); return "OK"; },
		incr: async key => { calls.push("reserve"); const n = Number(values.get(key) ?? 0) + 1; values.set(key, n); return n; },
		decr: async key => { const n = Number(values.get(key) ?? 0) - 1; values.set(key, n); return n; },
		expire: async () => 1,
		eval: async () => { throw new Error("no quota or money script should run for these unbound jobs"); },
	};
}

function configured(storeDir, redis = redisFixture(), overrides = {}) {
	const deployment = tempDir("subscription-boundary-deployment-");
	const policy = join(deployment, "connections.json");
	fs.writeFileSync(policy, JSON.stringify({ version: 1, connections: [{ id: "chatgpt", provider: "openai", adapter: "openai-chatgpt", ownerHost: "owner" }], bindings: { openai: "chatgpt" } }), { mode: 0o600 });
	return configuredSubscriptions({ config: { authConnectionsFile: policy, authStoreDir: storeDir, settingsFile: join(deployment, "settings.json"), workerName: "owner", globalPiDir: join(deployment, "overlay"), jobsDir: join(deployment, "jobs"), sandboxDir: join(deployment, "sandboxes"), ...overrides }, redis, now: () => NOW });
}

function execution(jobsDir, storeDir, calls) {
	return {
		redis: redisFixture(calls), caps: { day: 10, week: null, month: null }, softHoldPct: null, now: new Date(NOW),
		mintToken: async () => { calls.push("mint"); return "token"; },
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: makePrepareWorkspace({ jobsDir, localPlacement: { authStoreDir: storeDir }, stageLive: null }),
		runContainer: async ({ job, prepared }) => {
			calls.push("container");
			assert.equal(Object.hasOwn(job, "authStoreDir"), false);
			assert.equal(Object.hasOwn(prepared, "authStoreDir"), false);
			assert.equal(JSON.stringify(prepared).includes(storeDir), false, "private store metadata never enters prepared job inputs");
			return { code: 0, aborted: false };
		},
		collectChain: async () => ({ enqueued: 0, refused: 0 }), cleanup: async () => {}, comment: async () => {},
	};
}

test("every local mount containing the refresh store refuses before mint, preparation, reservation and container", async () => {
	const folder = repo();
	const storeDir = join(folder, "private-auth");
	fs.mkdirSync(storeDir, { mode: 0o700 });
	fs.writeFileSync(join(storeDir, "connection.credential"), secret, { mode: 0o600 });
	const calls = [];
	const redis = redisFixture(calls);
	const subscriptions = configured(storeDir, redis);
	assert.equal(subscriptions.storeDir, storeDir, "the path is available only to the host wiring");
	const records = [];
	const processJob = makeProcessor({ redis, now: () => NOW, cancelJob() {}, stopContainer() {}, getSettings: () => ({ provider: "unmanaged", model: "test-model", maxTurns: 5, dailyCap: 10, concurrency: 1, softHoldPct: null }), recordRun: record => records.push(record), deps: {
		subscriptionRuntime: subscriptions.runtime, now: new Date(NOW),
		mintToken: async () => { calls.push("mint"); return "token"; }, isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => { calls.push("prepare"); throw new Error("must refuse before preparing"); },
		runContainer: async () => { calls.push("container"); }, cleanup: async () => {}, comment: async () => {}, log: () => {},
	} });
	for (const [id, patch] of [["ordinary", {}], ["forge", { github: true }], ["fallback", { github: true, models: ["unmanaged/test-model", "unmanaged/fallback"], fallbackModels: ["unmanaged/fallback"] }]]) {
		// This provider is deliberately unbound, with ordinary unrestricted and reviewed fallback variants.
		const result = await processJob({ id: `local-custody-${id}`, name: "local", data: { kind: "local", folder, repo: "org/repo", provider: "unmanaged", model: "test-model", task: "work", ...patch }, attemptsMade: 0, opts: {} }, "lock", new AbortController().signal);
		assert.equal(result.reason, LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH);
		assert.equal(result.budgetReserved, false);
	}
	assert.deepEqual(calls, []);
	assert.equal(fs.readFileSync(join(storeDir, "connection.credential"), "utf8"), secret);
	assert.equal(fs.readFileSync(join(folder, "untracked.txt"), "utf8"), "original working-tree bytes");
	assert.equal(JSON.stringify(records).includes(storeDir), false);
	assert.equal(JSON.stringify(records).includes(secret), false);
});

test("a home repository containing the default state store is protected before its first login", async () => {
	const folder = repo();
	const settingsFile = join(folder, ".local", "state", "pi-dispatch", "settings.json");
	const subscriptions = configured(undefined, undefined, { settingsFile });
	assert.equal(subscriptions.storeDir, join(folder, ".local", "state", "pi-dispatch", "subscription-auth"));
	assert.equal(fs.existsSync(subscriptions.storeDir), false);
	assert.equal((await subscriptions.runtime.check({ kind: "local", folder, provider: "unmanaged", model: "test-model" })).reason, LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH);
	assert.equal(fs.existsSync(subscriptions.storeDir), false, "checking custody does not create the store");
});

test("final preparation rechecks a changed folder symlink and refuses before reservation or container", async () => {
	const safeFolder = repo(), privateFolder = repo();
	const storeDir = join(privateFolder, "private-auth");
	fs.mkdirSync(storeDir);
	fs.writeFileSync(join(storeDir, "connection.credential"), secret);
	const alias = join(tempDir("subscription-local-alias-"), "work");
	fs.symlinkSync(safeFolder, alias, "dir");
	assert.equal((await configured(storeDir).runtime.check({ kind: "local", folder: alias, provider: "unmanaged", model: "test-model" })).ok, true);
	fs.unlinkSync(alias);
	fs.symlinkSync(privateFolder, alias, "dir");
	const jobsDir = tempDir("subscription-local-jobs-");
	const calls = [];
	const result = await runJob({ kind: "local", folder: alias, provider: "unmanaged", model: "test-model", task: "work" }, execution(jobsDir, storeDir, calls));
	assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH, false]);
	assert.deepEqual(calls, []);
	assert.deepEqual(fs.readdirSync(jobsDir), [], "no job inputs, credential copy or retained directory remains");
	assert.equal(fs.readFileSync(join(storeDir, "connection.credential"), "utf8"), secret);
});

test("an outside store permits an ordinary local job and never becomes a job input", async () => {
	const folder = repo(), storeDir = join(tempDir("subscription-outside-auth-"), "private-auth");
	fs.mkdirSync(storeDir);
	fs.writeFileSync(join(storeDir, "connection.credential"), secret);
	const calls = [], jobsDir = tempDir("subscription-safe-jobs-");
	assert.equal((await configured(storeDir).runtime.check({ kind: "local", folder, provider: "unmanaged", model: "test-model" })).ok, true);
	const result = await runJob({ kind: "local", folder, provider: "unmanaged", model: "test-model", task: "work" }, execution(jobsDir, storeDir, calls));
	assert.equal(result.outcome, "completed");
	assert.deepEqual(calls, ["reserve", "container"]);
	for (const job of fs.readdirSync(jobsDir)) {
		const jobDir = join(jobsDir, job);
		assert.equal(fs.existsSync(join(jobDir, "connection.credential")), false);
		assert.equal(fs.readFileSync(join(jobDir, "prompt.md"), "utf8").includes(secret), false);
	}
});

test("future stores and existing or dangling symlink parents remain protected without creating them", async () => {
	const folder = repo(), links = tempDir("subscription-store-links-");
	const future = join(folder, "not-created", "auth");
	fs.symlinkSync(folder, join(links, "existing"), "dir");
	fs.symlinkSync(join(folder, "not-created"), join(links, "dangling"), "dir");
	for (const authStoreDir of [future, join(links, "existing", "not-created", "auth"), join(links, "dangling", "auth")]) {
		assert.equal(privateStoreExposed(folder, authStoreDir), true);
		const jobDir = join(tempDir("subscription-future-jobs-"), "job");
		assert.deepEqual(await prepareLocalWorkspace({ folder, authStoreDir, task: "work", jobDir }), { outcome: "policy", reason: LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH });
		assert.equal(fs.existsSync(jobDir), false);
	}
	assert.equal(fs.existsSync(future), false);
	assert.equal(privateStoreExposed(folder, `${folder}-sibling/auth`), false, "a prefix sibling is outside the mount");
	assert.equal(privateStoreExposed(folder, null), false, "an unconfigured deployment keeps its existing local behavior");
	assert.equal(privateStoreExposed(join(folder, "nested-repo"), join(folder, "auth")), false, "mounting a child does not expose its parent");
});

test("directory identity catches aliases whose canonical spellings differ", () => {
	const stats = new Map([["/mount/repo", { dev: 1n, ino: 9n }], ["/store/alias", { dev: 1n, ino: 9n }], ["/store/alias/private", { dev: 1n, ino: 10n }]]);
	const fsView = { realpathSync: path => path, statSync: path => { if (stats.has(path)) return stats.get(path); throw Object.assign(new Error(), { code: "ENOENT" }); } };
	assert.equal(privateStoreExposed("/mount/repo", "/store/alias/private", { fs: fsView }), true);
});

test("unanswered boundary reads are infrastructure failures, with no path or refresh value in diagnostics", async () => {
	const folder = repo(), authStoreDir = join(tempDir("subscription-boundary-io-"), "private-auth");
	for (const code of ["EIO", "EACCES"]) {
		const view = { ...fs, realpathSync: path => { if (path === authStoreDir) throw Object.assign(new Error(`${secret} ${authStoreDir}`), { code }); return fs.realpathSync(path); } };
		assert.throws(() => canonicalFuturePath(authStoreDir, { fs: view }), error => error.transient === true && !error.message.includes(secret) && !error.message.includes(authStoreDir));
		await assert.rejects(prepareLocalWorkspace({ folder, authStoreDir, task: "work", jobDir: join(tempDir("subscription-io-jobs-"), "job"), fs: view }), error => error instanceof InfraRetry && !error.message.includes(authStoreDir));
		let authCalls = 0;
		const runtime = makeSubscriptionRuntime({ auth: { check: async () => { authCalls++; } }, isPrivateStoreExposed: job => privateStoreExposed(job.folder, authStoreDir, { fs: view }), now: () => NOW });
		assert.deepEqual(await runtime.check({ kind: "local", folder }), { ok: false, managed: true, reason: "auth-store-unavailable", unavailable: true });
		assert.equal(authCalls, 0);
	}
});
