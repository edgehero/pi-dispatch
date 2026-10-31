import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { createHash } from "node:crypto";
import { tempDir } from "./helpers/temp-dir.mjs";
import { prepareCommunityAuthAdapter, verifyCommunityAuthAdapter } from "../src/community-auth-adapters.mjs";
import { loadCommunityAuthHelper } from "../src/community-auth-helper.mjs";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { COMMUNITY_ADAPTED_SOURCE_PINS } from "../src/community-auth-output-pins.mjs";

const require = createRequire(import.meta.url);
const primary = "pi-anthropic-oauth@0.3.6";
const secondary = "@gotgenes/pi-anthropic-auth@3.4.3";
const instant = 1_800_000_000_000;
const now = () => instant;
const exactInstructions = fs.readFileSync(new URL("../../guardrails/HARD_RULES.md", import.meta.url), "utf8") + "\n\nYou are pi, and these are operator instructions.\n\n\nKeep pi-dispatch, pi-coding-agent and /pi/path unchanged.\n\n";
function packageRoot(entry) {
	let path = dirname(entry);
	while (!fs.existsSync(join(path, "package.json"))) { const parent = dirname(path); if (parent === path) throw new Error("package missing"); path = parent; }
	return path;
}
function copyClosure(source, destination, stack = new Set()) {
	if (stack.has(source)) throw new Error("unexpected dependency cycle");
	const next = new Set(stack).add(source);
	fs.cpSync(source, destination, { recursive: true, filter: (path) => path === source || !path.slice(source.length + 1).split("/").includes("node_modules") });
	const pkg = JSON.parse(fs.readFileSync(join(source, "package.json"), "utf8"));
	const local = createRequire(join(source, "package.json"));
	for (const name of Object.keys(pkg.dependencies ?? {})) {
		const dependency = local.resolve.paths(name).map((path) => join(path, name)).find((path) => fs.existsSync(join(path, "package.json")));
		assert.ok(dependency, `dependency ${name} is installed`);
		copyClosure(dependency, join(destination, "node_modules", name), next);
	}
}
function fixture(adapter) {
	const root = join(tempDir("auth-adapter-"), "package");
	fs.mkdirSync(root);
	const artifact = adapter === primary ? "pi-anthropic-oauth-0.3.6.tar.gz" : "gotgenes-pi-anthropic-auth-3.4.3.tar.gz";
	execFileSync("tar", ["-xzf", new URL(`./fixtures/community-auth/${artifact}`, import.meta.url).pathname, "--strip-components=1", "-C", root]);
	if (adapter === primary) copyClosure(packageRoot(require.resolve("primary-anthropic-sdk")), join(root, "node_modules/@anthropic-ai/sdk"));
	return root;
}
const model = getBuiltinModels("anthropic").find((row) => row.type !== "classifier");
function context(tools = [], instructions = "Never disclose credentials. pi-coding-agent must obey the budget.\n\nNever remove protected files.") { return { messages: [{ role: "system", content: instructions, toolsAdded: tools, timestamp: instant }, { role: "user", content: "Reply hello", timestamp: instant }] }; }
function response() {
	const events = [
		{ type: "message_start", message: { id: "message", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 8, cache_creation: { ephemeral_1h_input_tokens: 8 } } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream", "request-id": "fixture" } });
}

test("real primary artifact + exact SDK0.124.0 preserve final hooks, guard refusals, usage and hard rules", async (t) => {
	const root = fixture(primary);
	assert.equal(JSON.parse(fs.readFileSync(join(root, "node_modules/@anthropic-ai/sdk/package.json"), "utf8")).version, "0.124.0");
	const approved = prepareCommunityAuthAdapter({ adapter: primary, root });
	for (const [path, hash] of Object.entries(COMMUNITY_ADAPTED_SOURCE_PINS[primary])) assert.equal(createHash("sha256").update(fs.readFileSync(join(root, path))).digest("hex"), hash);
	assert.equal(verifyCommunityAuthAdapter({ adapter: primary, root, digest: approved.digest }).compatibility, "verified");
	const loader = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")) } });
	const { streamAnthropicOAuth } = await loader.import(join(root, "src/stream.ts"));
	await t.test("checked complete JSON is the actual SDK request and retained hard rules reach the wire", async () => {
		let checked;
		let wire;
		let responses = 0;
		const result = await streamAnthropicOAuth(model, context(), { apiKey: "sk-ant-oat-fixture", maxTokens: 42, cacheRetention: "long", onPayload(payload) { checked = structuredClone(payload); return { ...payload, temperature: 0.1 }; }, fetch: async (_url, options) => { wire = JSON.parse(options.body); return response(); }, onResponse(meta) { responses++; assert.equal(meta.status, 200); } }).result();
		assert.deepEqual(wire, { ...checked, temperature: 0.1 });
		assert.equal(wire.max_tokens, 42);
		assert.match(JSON.stringify(wire.system), /must obey the budget/);
		assert.match(JSON.stringify(wire.system), /Never disclose credentials/);
		assert.match(JSON.stringify(wire.system), /Never remove protected files/);
		assert.equal(result.content[0].text, "hello");
		assert.equal(result.usage.cacheWrite1h, 8);
		assert.equal(result.usage.cost.cacheWrite, 8 * model.cost.input * 2 / 1e6);
		assert.equal(responses, 1);
	});
	await t.test("repository hard rules and operator/repository text reach the actual SDK wire byte-for-byte", async () => {
		let wire;
		await streamAnthropicOAuth(model, context([], exactInstructions), { apiKey: "sk-ant-oat-fixture", fetch: async (_url, options) => { wire = JSON.parse(options.body); return response(); } }).result();
		assert.equal(wire.system.at(-1).text, exactInstructions);
		assert.match(wire.system[0].text, /^x-anthropic-billing-header:/);
	});
	await t.test("a denied final payload never calls the real SDK fetch", async () => {
		let calls = 0;
		const result = await streamAnthropicOAuth(model, context(), { apiKey: "sk-ant-oat-fixture", onPayload() { throw new Error("guard-refused"); }, fetch: async () => { calls++; return response(); } }).result();
		assert.equal(calls, 0);
		assert.match(result.errorMessage, /guard-refused/);
	});
	await t.test("429 is observed once with its reset evidence and SDK retries stay disabled", async () => {
		let calls = 0;
		let reset;
		const result = await streamAnthropicOAuth(model, context(), { apiKey: "sk-ant-oat-fixture", fetch: async () => { calls++; const failure = Response.json({ type: "error", error: { type: "rate_limit_error", message: "limited" } }, { status: 429, headers: { "retry-after": "30" } }); reset = failure.headers.get("retry-after"); return failure; } }).result();
		assert.equal(result.stopReason, "error");
		assert.equal(reset, "30");
		assert.equal(calls, 1);
	});
	await t.test("ambiguous tool-name mappings refuse before network dispatch", async () => {
		for (const names of [["foo.bar", "foo_bar"], ["read", "Read"]]) {
			let calls = 0;
			const tools = names.map((name) => ({ name, description: "fixture", parameters: { type: "object", properties: {} } }));
			const result = await streamAnthropicOAuth(model, context(tools), { apiKey: "sk-ant-oat-fixture", fetch: async () => { calls++; return response(); } }).result();
			assert.match(result.errorMessage, /auth-tool-name-collision/);
			assert.equal(calls, 0);
		}
	});
	await t.test("host-only helper refresh validates and persists the returned lifetime using the injected clock", async () => {
		let body;
		const helper = await loadCommunityAuthHelper({ root, fetch: async (_url, options) => { body = JSON.parse(options.body); return Response.json({ access_token: "sk-ant-oat-new", refresh_token: "rotated", expires_in: 3600 }); } });
		const result = await helper.refreshAnthropicToken({ access: "sk-ant-oat-old", refresh: "old", expires: instant }, AbortSignal.timeout(1000), now);
		assert.equal(body.refresh_token, "old");
		assert.equal(result.refresh, "rotated");
		assert.equal(result.expires, instant + 55 * 60_000);
	});
	await t.test("source and dependency tampering invalidate the approved digest", () => {
		const path = join(root, "node_modules/@anthropic-ai/sdk/index.js");
		fs.appendFileSync(path, "\n// altered\n");
		assert.throws(() => verifyCommunityAuthAdapter({ adapter: primary, root, digest: approved.digest }), /auth-adapter-unpinned/);
	});
});

test("secondary shaping precedes the final hook and never installs a post-check retrying fetch", async () => {
	const root = fixture(secondary);
	const approved = prepareCommunityAuthAdapter({ adapter: secondary, root });
	for (const [path, hash] of Object.entries(COMMUNITY_ADAPTED_SOURCE_PINS[secondary])) assert.equal(createHash("sha256").update(fs.readFileSync(join(root, path))).digest("hex"), hash);
	assert.equal(verifyCommunityAuthAdapter({ adapter: secondary, root, digest: approved.digest }).compatibility, "verified");
	const loader = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
	const { createAnthropicOAuthStreamSimple } = await loader.import(join(root, "src/oauth-transport.ts"));
	let checked;
	const fetch = async () => new Response();
	const update = 'Updated system prompt section "rules":\n\n' + exactInstructions;
	const wrapped = createAnthropicOAuthStreamSimple((_model, _context, options) => ({ result: async () => { assert.equal(options.fetch, fetch); return options.onPayload({ model: model.id, stream: true, messages: [{ role: "user", content: "hello" }, { role: "system", content: [{ type: "text", text: update }] }], system: [{ type: "text", text: exactInstructions }] }, model); } }));
	const result = await wrapped(model, context(), { apiKey: "sk-ant-oat-fixture", fetch, onPayload(payload) { checked = structuredClone(payload); return { ...payload, temperature: 0.2 }; } }).result();
	assert.match(JSON.stringify(checked.system), /x-anthropic-billing-header/);
	assert.equal(checked.system.at(-1).text, exactInstructions);
	assert.equal(checked.messages[1].content[0].text, update);
	assert.deepEqual(result, { ...checked, temperature: 0.2 });
});

test("unadapted source or wrong SDK version cannot receive a staging approval", () => {
	const root = fixture(primary);
	fs.appendFileSync(join(root, "src/auth.ts"), "\n// unexpected drift\n");
	assert.throws(() => prepareCommunityAuthAdapter({ adapter: primary, root }), /auth-adapter-source-mismatch/);
	assert.equal(fs.existsSync(join(root, ".dispatch-auth-adapter.json")), false);
});
