import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { catalogDiff, lifecycleModels, roleProposalChecks } from "../src/model-proposals.mjs";
import { cheaperRouteChecks, doctorModelProposalChecks, fetchLifecycle, parseProposalConfig } from "../src/doctor-model-proposals.mjs";
import { catalogFromArchive, modelProposalReport, registryCatalog } from "../../.github/scripts/model-proposal-report.mjs";

const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const model = (id, cost = rates) => ({ provider: "anthropic", id, type: "chat", api: "anthropic-messages", cost, maxTokens: 4096 });
const now = () => Date.parse("2026-01-01T00:00:00Z");

test("catalog proposals enumerate added, removed and repriced chat models deterministically", () => {
	const diff = catalogDiff([model("old"), model("changed")], [model("new"), model("changed", { ...rates, output: 3 }), { ...model("ignored"), provider: "other" }], ["anthropic"]);
	assert.deepEqual(diff.map(({ kind, ref }) => [kind, ref]), [["repriced", "anthropic/changed"], ["added", "anthropic/new"], ["removed", "anthropic/old"]]);
	assert.throws(() => catalogDiff([], [model("same"), model("same")], ["anthropic"]), /ambiguous/);
});

test("report uses the enforcement bound and labels public reference caps honestly", async () => {
	const report = await modelProposalReport("1.0.0", "1.0.1", { providers: ["anthropic"], capsUsd: [0.001, 5], outputTokens: 4096 }, { catalog: async (v) => v === "1.0.0" ? [] : [model("new")] });
	assert.match(report, /not deployment caps/);
	assert.match(report, /exceeds \$0.001, fits \$5/);
	assert.match(report, /actual job prompts/);
	await assert.rejects(modelProposalReport("1.0.0", "1.0.1", { providers: ["bad`"], capsUsd: [1], outputTokens: 1 }), /configuration/);
});

function archive(name, text) {
	const payload = Buffer.from(text), header = Buffer.alloc(512);
	header.write(name); header.write(payload.length.toString(8).padStart(11, "0"), 124); header[156] = 48;
	const bytes = gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512), Buffer.alloc(1024)]));
	return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

test("catalog extraction authenticates bytes and only parses fixed JSON archive paths", () => {
	const good = archive("package/dist/providers/data/anthropic.json", JSON.stringify({ anthropic: { "chat:new": model("new") } }));
	assert.equal(catalogFromArchive(good.bytes, good.integrity)[0].id, "new");
	assert.throws(() => catalogFromArchive(good.bytes, "sha512-AAAA"), /integrity/);
	const code = archive("package/dist/index.js", "throw new Error('must never execute')");
	assert.throws(() => catalogFromArchive(code.bytes, code.integrity), /no JSON/);
	const traversal = archive("package/dist/providers/data/../../evil.json", "{}");
	assert.throws(() => catalogFromArchive(traversal.bytes, traversal.integrity), /no JSON/);
});

test("registry metadata cannot redirect report downloads off npm", async () => {
	const calls = [];
	await assert.rejects(registryCatalog("1.4.0", { fetch: async (url, options) => {
		calls.push(url); assert.equal(options.redirect, "error");
		return new Response(JSON.stringify({ version: "1.4.0", dist: { tarball: "https://evil.invalid/package.tgz" } }));
	} }), /untrusted/);
	assert.equal(calls.length, 1);
});

test("registry report reads authenticated JSON catalog bytes without loading candidate code", async () => {
	const fixture = archive("package/dist/providers/data/anthropic.json", JSON.stringify({ anthropic: { "chat:new": model("new") } }));
	const rows = await registryCatalog("1.4.0", { fetch: async (url) => url.endsWith("1.4.0") ? new Response(JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.4.0", dist: { tarball: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz", integrity: fixture.integrity } })) : new Response(fixture.bytes) });
	assert.equal(rows[0].id, "new");
});

test("lifecycle adapters validate provider fields and warn for mapped deprecated roles", () => {
	const catalogs = { openai: lifecycleModels("openai", { data: [{ id: "old", shutdown_date: "2026-01-15" }] }) };
	const checks = roleProposalChecks({ roles: { default: { editor: "openai/old" } }, catalogs, now: now(), replacements: { "openai/old": "openai/new" } });
	assert.equal(checks.length, 1); assert.equal(checks[0].warn, true); assert.match(checks[0].fix, /openai\/new/);
	assert.throws(() => lifecycleModels("anthropic", { data: [{ id: "old", lifecycle: "maybe" }] }), /stage/);
	assert.throws(() => lifecycleModels("openai", { data: [{ id: "old", shutdown_date: "never" }] }), /date/);
	assert.deepEqual(roleProposalChecks({ roles: { default: { editor: "openai/missing" } }, catalogs, now: now() }), []);
});

test("newer sibling requires provider-declared line and newer release date", () => {
	const catalogs = { anthropic: lifecycleModels("anthropic", { data: [{ id: "old", lifecycle: "active", line: "sonnet", created_at: "2025-01-01" }, { id: "new", lifecycle: "active", line: "sonnet", created_at: "2025-12-01" }] }) };
	assert.match(roleProposalChecks({ roles: { shop: { editor: { model: "anthropic/old" } } }, catalogs, now: now() })[0].label, /sibling new/);
});

test("lifecycle fetch uses fixed API, no redirects, bounded body and refuses incomplete catalogs", async () => {
	await assert.rejects(fetchLifecycle("anthropic", { key: "fake", proxyUrl: "http://proxy:3128", fetch: async (url, options) => {
		assert.match(url, /^https:\/\/api.anthropic.com/); assert.equal(options.redirect, "error"); assert.equal(options.headers["x-api-key"], "fake");
		return new Response(JSON.stringify({ data: [], has_more: true }));
	} }), /incomplete/);
	await assert.rejects(fetchLifecycle("openai", { key: "fake", fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) }), /too large/);
});

test("Claude requests every lifecycle stage and a retired mapped model retains its warning", async () => {
	const rows = await fetchLifecycle("anthropic", { key: "fake", proxyUrl: "http://proxy:3128", fetch: async (url) => {
		const request = new URL(url);
		assert.equal(request.origin, "https://api.anthropic.com");
		assert.deepEqual(request.searchParams.getAll("lifecycle[]"), ["active", "deprecated", "retired"]);
		assert.equal(request.searchParams.get("limit"), "1000");
		return new Response(JSON.stringify({ data: [{ id: "retired", lifecycle: "retired", retires_at: "2025-12-01T00:00:00Z" }], has_more: false }));
	} });
	const checks = roleProposalChecks({ roles: { default: { editor: "anthropic/retired" } }, catalogs: { anthropic: rows }, now: now() });
	assert.equal(checks.length, 1);
	assert.equal(checks[0].warn, true);
	assert.match(checks[0].label, /anthropic\/retired/);
	assert.match(checks[0].label, /is retired/);
});

test("doctor defaults to no network and fails open explicitly on unavailable opt-in lifecycle", async () => {
	let fetched = 0;
	const fetch = async () => { fetched++; throw new Error("secret must not print"); };
	const missing = () => { throw Object.assign(new Error(), { code: "ENOENT" }); };
	assert.deepEqual(await doctorModelProposalChecks({}, { cwd: "/deployment", now, read: missing, fetch }), []);
	const read = (path) => path.endsWith("model-proposals.json") ? JSON.stringify({ version: 1, lifecycleProviders: ["openai"], proxyUrl: "http://proxy:3128" }) : path.endsWith("triggers.json") ? JSON.stringify({ version: 1, triggers: [], modelRoles: { default: { editor: "openai/old" } } }) : "api.openai.com";
	const checks = await doctorModelProposalChecks({}, { cwd: "/deployment", credentials: { OPENAI_API_KEY: "fake" }, now, read, fetch });
	assert.equal(fetched, 1); assert.match(checks[0].label, /unavailable/); assert.doesNotMatch(JSON.stringify(checks), /secret must/);
});

test("doctor joins current role maps to opted-in lifecycle and refuses an unlisted host before fetch", async () => {
	let fetched = 0, allow = true, optIn = true;
	const read = (path) => path.endsWith("model-proposals.json") ? JSON.stringify({ version: 1, lifecycleProviders: optIn ? ["openai"] : [], proxyUrl: "http://proxy:3128" }) : path.endsWith("triggers.json") ? JSON.stringify({ triggers: [], modelRoles: { default: { editor: "openai/old" }, shop: { explorer: "openai/old" } } }) : allow ? "api.openai.com" : "example.com";
	const fetch = async () => { fetched++; return lifecycleModels("openai", { data: [{ id: "old", shutdown_date: "2026-01-15" }] }); };
	const seams = { cwd: "/deployment", credentials: { OPENAI_API_KEY: "fake" }, now, read, fetch };
	const checks = await doctorModelProposalChecks({}, { ...seams, now });
	assert.equal(checks.filter((c) => c.warn).length, 2); assert.equal(fetched, 1);
	allow = false;
	assert.match((await doctorModelProposalChecks({}, { ...seams, now }))[0].label, /unavailable/);
	assert.equal(fetched, 1);
	optIn = false;
	assert.deepEqual(await doctorModelProposalChecks({}, { ...seams, now }), []); assert.equal(fetched, 1);
});

test("proposal configuration rejects unsupported providers and credential-bearing proxies", () => {
	assert.throws(() => parseProposalConfig('{"version":1,"lifecycleProviders":["unknown"]}'));
	assert.throws(() => parseProposalConfig('{"version":1,"lifecycleProviders":["openai"],"proxyUrl":"http://secret:pass@host"}'));
});

test("cheaper-route proposals require declared equivalence, mapped source and declared endpoints", () => {
	const roles = { default: { editor: "local/old" } }, routes = [{ model: "local/old", alternative: "local/new" }];
	const models = { providers: { local: { baseUrl: "http://server:8000/v1", models: [{ id: "old", cost: rates }, { id: "new", cost: { ...rates, output: 1 } }] } } };
	const endpoints = [{ host: "server", port: 8000 }];
	assert.equal(cheaperRouteChecks(roles, routes, models, endpoints).length, 1);
	assert.deepEqual(cheaperRouteChecks(roles, routes, models, []), []);
	assert.deepEqual(cheaperRouteChecks(roles, [], models, endpoints), []);
});
