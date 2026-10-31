import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, symlinkSync, chmodSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { configuredSubscriptions, readAuthPolicy } from "../src/subscription-config.mjs";

function fixture() {
	const root = tempDir("subscription-config-");
	const path = join(root, "connections.json");
	writeFileSync(path, JSON.stringify({ version: 1, connections: [{ id: "openai", provider: "openai", adapter: "openai-chatgpt", ownerHost: "host1" }], bindings: { openai: "openai" } }), { mode: 0o600 });
	return { root, path, config: { authConnectionsFile: path, settingsFile: join(root, "settings.json"), workerName: "host1", globalPiDir: join(root, "overlay"), jobsDir: join(root, "jobs"), sandboxDir: join(root, "sandboxes") } };
}
test("subscription policy reads fail closed without exposing a private path", () => {
	const { root, path } = fixture();
	assert.equal(readAuthPolicy(path).bindings.openai, "openai");
	for (const target of [join(root, "private-user-secret-policy"), join(root, "linked")]) {
		if (target.endsWith("linked")) symlinkSync(path, target);
		assert.throws(() => readAuthPolicy(target), error => error.code === "auth-policy-invalid" && !error.message.includes(root));
	}
	chmodSync(path, 0o666);
	assert.throws(() => readAuthPolicy(path), { code: "auth-policy-invalid" });
});
test("a host credential store cannot be inside a job, sandbox or overlay, including symlink parents", () => {
	const { root, config } = fixture();
	for (const key of ["globalPiDir", "jobsDir", "sandboxDir"]) {
		mkdirSync(config[key]);
		assert.throws(() => configuredSubscriptions({ config: { ...config, authStoreDir: join(config[key], "auth") } }), { code: "auth-store-location" });
	}
	const linked = join(root, "private-looking-parent");
	symlinkSync(config.globalPiDir, linked, "dir");
	assert.throws(() => configuredSubscriptions({ config: { ...config, authStoreDir: join(linked, "auth") } }), { code: "auth-store-location" });
});
test("all boot roots exclude the same physical directory under macOS volume aliases", { skip: process.platform !== "darwin" ? "the alternate /System/Volumes/Data firmlink is a macOS filesystem contract" : false }, () => {
	const { root, config } = fixture();
	for (const key of ["globalPiDir", "jobsDir", "sandboxDir"]) {
		mkdirSync(config[key]);
		const canonicalRoot = realpathSync(config[key]);
		const alias = `/System/Volumes/Data${canonicalRoot}`;
		assert.notEqual(realpathSync(alias), canonicalRoot, "realpath spellings remain distinct in this counterexample");
		const actual = statSync(canonicalRoot, { bigint: true }), alternate = statSync(alias, { bigint: true });
		assert.deepEqual([actual.dev, actual.ino], [alternate.dev, alternate.ino], "the two spellings identify one physical directory");
		assert.throws(() => configuredSubscriptions({ config: { ...config, authStoreDir: join(alias, "future-auth") } }), error => error.code === "auth-store-location" && !error.message.includes(root));
		assert.throws(() => configuredSubscriptions({ config: { ...config, [key]: alias, authStoreDir: join(canonicalRoot, "future-auth") } }), { code: "auth-store-location" });
	}
});
test("a private store outside all boot roots remains usable", () => {
	const { root, config } = fixture();
	for (const key of ["globalPiDir", "jobsDir", "sandboxDir"]) mkdirSync(config[key]);
	const storeDir = join(root, "private-auth");
	const subscriptions = configuredSubscriptions({ config: { ...config, authStoreDir: storeDir } });
	assert.equal(subscriptions.storeDir, storeDir);
	assert.equal(typeof subscriptions.auth.check, "function");
	assert.equal(subscriptions.runtime, null);
});
test("unconfigured deployments construct no auth or quota service", () => {
	assert.equal(configuredSubscriptions({ config: {} }), null);
});

test("known co-loaded Claude replacements are a conflict, while unrelated extensions remain allowed", async () => {
	const { stagedAuthConflict } = await import("../src/subscription-config.mjs");
	const primary = { name: "pi-anthropic-oauth", version: "0.3.6" };
	const secondary = { name: "@gotgenes/pi-anthropic-auth", version: "3.4.3" };
	assert.equal(stagedAuthConflict({ packages: [primary, secondary] }, "pi-anthropic-oauth@0.3.6"), true);
	assert.equal(stagedAuthConflict({ packages: [primary, { name: "other-tools", version: "1.0.0" }] }, "pi-anthropic-oauth@0.3.6"), false);
});
