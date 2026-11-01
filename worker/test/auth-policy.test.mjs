import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseAuthConnections } from "../src/auth-policy.mjs";
import { parseAuthConnections as existing } from "../src/auth-connections.mjs";
import { COMMUNITY_AUTH_ADAPTERS } from "../src/community-auth-metadata.mjs";
import { COMMUNITY_AUTH_ADAPTERS as existingMetadata } from "../src/community-auth-patches.mjs";

test("metadata consumers and the auth service share the exact parser and adapter descriptors", () => {
	assert.equal(parseAuthConnections, existing);
	assert.equal(COMMUNITY_AUTH_ADAPTERS, existingMetadata);
	const value = { version: 1, connections: [{ id: "main", provider: "openai", adapter: "openai-chatgpt", ownerHost: "worker" }], bindings: { openai: "main" } };
	assert.deepEqual(parseAuthConnections(JSON.stringify(value)), { ...value, connections: [{ ...value.connections[0], quotaWindows: ["five-hour", "seven-day"] }] });
	for (const invalid of [{ ...value, version: 2 }, { ...value, bindings: { anthropic: "main" } }, { ...value, connections: [{ ...value.connections[0], root: "/private" }] }, { ...value, connections: [{ ...value.connections[0], adapter: "unreviewed" }] }]) assert.throws(() => parseAuthConnections(invalid));
});
test("the read-only policy parser bundles without subscription adapters, OAuth code or provider SDKs", async () => {
	const result = await build({ entryPoints: [new URL("../src/auth-policy.mjs", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false, metafile: true });
	const paths = Object.keys(result.metafile.inputs).join("\n");
	assert.doesNotMatch(paths, /community-auth-adapters|community-auth-helper|oauth-openai|@anthropic|node_modules\/openai|pi-ai/);
	assert.match(paths, /auth-policy\.mjs/);
	assert.match(paths, /community-auth-metadata\.mjs/);
});
