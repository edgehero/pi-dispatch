import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CREDENTIAL_FILE, createCredentialRefresher, FORGE_TOKEN_VARS, parseCredentialDrop, readCredentialDrop, readCredentialRefreshWanted } from "../src/credential-refresh.mjs";
import { installSubscriptionCredentials } from "../src/subscription-credentials.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const drop = (fields = {}) => JSON.stringify({ v: 1, seq: 1, forge: null, subscriptions: [], ...fields });
const SUB = { provider: "anthropic", connectionId: "claude-main", generation: 4, expiresAt: 9_000_000, deadlineAt: 5_000_000, token: "sk-ant-oat-renewed-0002" };

test("the worker's switch is read once and leaves the environment", () => {
	const env = { PI_CREDENTIAL_REFRESH: "1" };
	assert.equal(readCredentialRefreshWanted(env), true);
	assert.deepEqual(env, {});
	assert.equal(readCredentialRefreshWanted({ PI_CREDENTIAL_REFRESH: "yes" }), false);
	assert.equal(readCredentialRefreshWanted({}), false);
});

test("a drop is held to its whole shape: one bad entry refuses the file, never half of it", () => {
	assert.deepEqual(parseCredentialDrop(drop({ forge: { token: "ghs_abcdefgh123" } })), { seq: 1, forge: { token: "ghs_abcdefgh123" }, subscriptions: [] });
	assert.deepEqual(parseCredentialDrop(drop({ subscriptions: [SUB] })).subscriptions, [SUB]);
	for (const bad of [
		"{",
		JSON.stringify({ v: 2, seq: 1 }),
		drop({ seq: 0 }),
		drop({ forge: { token: "short" } }),
		drop({ forge: { token: "has space inside" } }),
		drop({ subscriptions: [{ ...SUB, provider: "other" }] }),
		drop({ subscriptions: [{ ...SUB, deadlineAt: "soon" }] }),
		drop({ subscriptions: [{ ...SUB, connectionId: "../x" }] }),
		drop({ subscriptions: [SUB, SUB, SUB] }),
	]) {
		assert.equal(parseCredentialDrop(bad), null, bad);
	}
});

test("the drop is read as untrusted bytes: a regular file only, never through a link", () => {
	const dir = tempDir("cred-drop-");
	assert.equal(readCredentialDrop(dir), null);
	fs.writeFileSync(join(dir, CREDENTIAL_FILE), drop({ forge: { token: "ghs_abcdefgh123" } }));
	assert.equal(readCredentialDrop(dir).forge.token, "ghs_abcdefgh123");
	const other = tempDir("cred-other-");
	fs.writeFileSync(join(other, "x.json"), drop({ seq: 9 }));
	fs.rmSync(join(dir, CREDENTIAL_FILE));
	fs.symlinkSync(join(other, "x.json"), join(dir, CREDENTIAL_FILE));
	assert.equal(readCredentialDrop(dir), null);
});

test("a renewed forge token reaches only the names the job already carries, once per seq, and is never logged", () => {
	const env = { GH_TOKEN: "ghs_old_token_1", GITHUB_TOKEN: "ghs_old_token_1" };
	const lines = [];
	let current = { seq: 1, forge: { token: "ghs_new_token_22" }, subscriptions: [] };
	const heard = [];
	const r = createCredentialRefresher({ read: () => current, env, log: (event, fields) => lines.push({ event, ...fields }), onForge: (t) => heard.push(t), timers: { setInterval: () => null, clearInterval: () => {} } });
	r.start();
	assert.deepEqual(env, { GH_TOKEN: "ghs_new_token_22", GITHUB_TOKEN: "ghs_new_token_22" });
	assert.deepEqual(heard, ["ghs_new_token_22"]);
	assert.equal(r.apply(), false, "the same seq again changes nothing");
	current = { seq: 2, forge: { token: "ghs_newer_token_3" }, subscriptions: [] };
	assert.equal(r.apply(), true);
	assert.equal(env.GH_TOKEN, "ghs_newer_token_3");
	assert.ok(!JSON.stringify(lines).includes("ghs_"), "no value in any line");
	assert.deepEqual(FORGE_TOKEN_VARS, ["GH_TOKEN", "GITHUB_TOKEN"]);
	const bare = {};
	createCredentialRefresher({ read: () => ({ seq: 1, forge: { token: "ghs_new_token_22" }, subscriptions: [] }), env: bare, timers: { setInterval: () => null, clearInterval: () => {} } }).start();
	assert.deepEqual(bare, {}, "a job given no GitHub token is given none");
});

/** A ModelRuntime stand-in whose two methods record the key each call is made with. */
function fakeRuntime() {
	const calls = [];
	class ModelRuntime {
		async getAuth(model, options) {
			calls.push(options?.apiKey);
			return { auth: { apiKey: options?.apiKey } };
		}
		async prepareRequest(model, options) {
			calls.push(options?.apiKey);
			return { model, options };
		}
	}
	return { ModelRuntime, calls };
}

test("a renewed subscription snapshot moves the guard forward for the same connection, and nothing else does", async () => {
	const { ModelRuntime, calls } = fakeRuntime();
	let now = 1_000_000;
	const entries = [{ provider: "anthropic", connectionId: "claude-main", adapter: "pi-anthropic-oauth@0.3.6", generation: 3, expiresAt: 4_000_000, deadlineAt: 2_800_000 }];
	const env = { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-first-0001" };
	const guard = installSubscriptionCredentials({ ModelRuntime, entries, env, now: () => now });
	try {
		const model = { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
		await new ModelRuntime().getAuth(model, {});
		const refresher = createCredentialRefresher({ read: () => ({ seq: 1, forge: null, subscriptions: [SUB] }), env, subscriptions: guard, timers: { setInterval: () => null, clearInterval: () => {} } });
		refresher.start();
		assert.equal(env.ANTHROPIC_OAUTH_TOKEN, SUB.token, "a role child started from now on gets it");
		assert.deepEqual({ generation: entries[0].generation, deadlineAt: entries[0].deadlineAt, expiresAt: entries[0].expiresAt }, { generation: 4, deadlineAt: 5_000_000, expiresAt: 9_000_000 });
		// Past the OLD deadline, a call still goes out, with the new token.
		now = 3_000_000;
		await new ModelRuntime().getAuth(model, {});
		assert.deepEqual(calls, ["sk-ant-oat-first-0001", SUB.token]);
		// Refused: another connection, an older generation, an earlier deadline, a deadline behind us, an expiry before the deadline, a wrong shape.
		for (const bad of [{ ...SUB, connectionId: "other" }, { ...SUB, generation: 2 }, { ...SUB, deadlineAt: 4_000_000 }, { ...SUB, deadlineAt: 2_000_000 }, { ...SUB, expiresAt: 5_000_000 }, { ...SUB, token: "sk-not-oauth-xxxx" }, { ...SUB, provider: "openai" }]) {
			assert.equal(guard.refresh(bad), false, JSON.stringify(bad));
		}
		assert.equal(entries[0].deadlineAt, 5_000_000, "a refused one changes nothing");
	} finally {
		guard.uninstall();
	}
});

test("the model guard judges a call against the renewed snapshot: the new deadline and the new token, read where the runner keeps them", async () => {
	const { createModelGuard } = await import("../src/usage-meter.mjs");
	const MODEL_NOT_ALLOWED = "model-not-allowed";
	const { ModelRuntime } = fakeRuntime();
	let now = 3_000_000;
	const entries = [{ provider: "anthropic", connectionId: "claude-main", adapter: "pi-anthropic-oauth@0.3.6", generation: 3, expiresAt: 4_000_000, deadlineAt: 2_800_000 }];
	const env = { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-first-0001", PI_SUBSCRIPTION_AUTH: JSON.stringify(entries) };
	const model = { provider: "anthropic", id: "claude-x", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
	const why = [];
	const guard = createModelGuard({ allowedModels: [{ provider: "anthropic", model: "claude-x" }], env, now: () => now, subscriptionAdmission: () => true, subscriptions: entries, log: (event, fields) => why.push(fields.why) });
	const ask = (apiKey) => guard.admit({ method: "streamSimple", model, args: [model, { apiKey }] });
	assert.equal(ask("sk-ant-oat-first-0001"), MODEL_NOT_ALLOWED, "past the old deadline, with no renewal, the call is refused");
	const sub = installSubscriptionCredentials({ ModelRuntime, entries, env, now: () => now });
	try {
		createCredentialRefresher({ read: () => ({ seq: 1, forge: null, subscriptions: [SUB] }), env, subscriptions: sub, onSubscriptions: () => (env.PI_SUBSCRIPTION_AUTH = JSON.stringify(entries)), timers: { setInterval: () => null, clearInterval: () => {} } }).start();
		assert.equal(ask(SUB.token), null, `renewed: the new deadline and the new token (${why.join(",")})`);
		assert.equal(ask("sk-ant-oat-first-0001"), MODEL_NOT_ALLOWED, "the old token is now an override");
		assert.equal(JSON.parse(env.PI_SUBSCRIPTION_AUTH)[0].deadlineAt, SUB.deadlineAt, "a role child started now reads the new deadline");
	} finally {
		sub.uninstall();
	}
});
