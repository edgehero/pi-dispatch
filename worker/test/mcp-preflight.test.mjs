import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_REFUSAL_COMMENT, MCP_TRANSIENT_READ_CODES, jobProviders, makeMcpCheck, providerKeyNames } from "../src/mcp-preflight.mjs";
import { parseOverlayMcp } from "../src/mcp-config.mjs";
import { OVERLAY_TRANSIENT_READ_CODES } from "../src/model-catalog.mjs";
import { packageRunnerHosts } from "../src/egress-allowlist.mjs";

const OVERLAY = {
	mcpServers: {
		docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, description: "Docs" },
		lan: { url: "http://192.168.1.5:8080/mcp", description: "Lan" },
		files: { command: "/opt/pi-global/mcp/files", env: { FILES_TOKEN: "${FILES_TOKEN}" }, description: "Files" },
		npx: { command: "npx", args: ["-y", "pkg@1.0.0"], allowPackageRunner: true, description: "Npx" },
		off: { url: "https://mcp.example.com/off", description: "Off", enabled: false },
		leaky: { url: "https://mcp.example.com/l", headers: { Authorization: "Bearer literal" }, description: "Leaky" },
		keyed: { url: "https://mcp.example.com/k", headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}" }, description: "Keyed" },
	},
};
const parsed = parseOverlayMcp(JSON.stringify(OVERLAY));
const check = (overrides = {}) =>
	makeMcpCheck({
		globalPiDir: "/srv/pi-global",
		forwardEnv: [],
		egress: true,
		reserved: () => new Set(["ANTHROPIC_API_KEY", "GH_TOKEN"]),
		allowlist: () => ["mcp.example.com", "registry.npmjs.org"],
		endpoints: () => [{ id: "lan", host: "192.168.1.5", port: 8080 }],
		read: () => parsed,
		...overrides,
	});
const job = (mcp, secrets = { DOCS_TOKEN: "op://x", FILES_TOKEN: "op://y" }) => ({ mcp, secrets, provider: "anthropic" });

test("makeMcpCheck: a job that names no server passes without reading anything", () => {
	const unread = check({ read: () => assert.fail("never read") });
	assert.deepEqual(unread({}), { ok: true, document: null });
	assert.equal(unread({ mcp: [] }).refused, "mcp-list-invalid", "the loader never writes an empty list");
});

test("makeMcpCheck: the servers the job names pass, and the document holds exactly them, references only", () => {
	const result = check()(job(["docs", "lan", "files", "npx"]));
	assert.equal(result.ok, true);
	assert.deepEqual(Object.keys(result.document.servers), ["docs", "lan", "files", "npx"]);
	assert.deepEqual(result.document.refs, { docs: ["DOCS_TOKEN"], lan: [], files: ["FILES_TOKEN"], npx: [] });
	assert.equal(result.document.version, 1);
	assert.equal(result.document.codemodeModels, false);
	assert.deepEqual(result.document.servers.docs.headers, { Authorization: "Bearer ${DOCS_TOKEN}" });
	assert.equal("allowPackageRunner" in result.document.servers.npx, false, "pi-dispatch's own key never reaches pi");
	assert.deepEqual(Object.keys(result.document.servers.docs.toolExposure), ["dispatch_*"]);
	assert.doesNotMatch(JSON.stringify(result.document), /op:\/\//, "a secret's reference to the vault never reaches the job's file");
});

test("makeMcpCheck: the admin's tool names are hidden first, ahead of every key of the operator's", () => {
	const own = parseOverlayMcp(JSON.stringify({ mcpServers: { t: { url: "https://mcp.example.com/t", description: "T", toolExposure: { "*": "direct", dispatch_run: "direct", "dispatch_r*": "direct", "dispatch*": "hidden", dispatcher_x: "hidden", read: "hidden" } } } }));
	const { document } = check({ read: () => own })(job(["t"]));
	assert.deepEqual(document.servers.t.toolExposure, { "dispatch_*": "hidden", "*": "direct", "dispatch*": "hidden", dispatcher_x: "hidden", read: "hidden" });
	// deepEqual ignores key order, and pi applies patterns in order, so the order is its own assertion.
	assert.deepEqual(Object.keys(document.servers.t.toolExposure), ["dispatch_*", "*", "dispatch*", "dispatcher_x", "read"]);
});

test("makeMcpCheck: each refusal, in order", () => {
	assert.equal(check()(job(["nope"])).refused, "mcp-server-unknown");
	assert.match(check()(job(["nope"])).why, /does not offer/);
	assert.match(check()(job(["off"])).why, /turns it off/);
	assert.match(check()(job(["leaky"])).why, /refuses it/);
	assert.equal(check()(job(["docs"], {})).refused, "mcp-secret-unmapped");
	assert.match(check()(job(["docs"], {})).why, /DOCS_TOKEN/);
	assert.equal(check({ forwardEnv: ["DOCS_TOKEN"], hostEnv: { DOCS_TOKEN: "v" } })(job(["docs"], {})).ok, true, "PI_FORWARD_ENV maps a reference too");
	// Only when the worker holds a value: buildContainerEnv leaves an unset or empty forwarded name out of the job.
	for (const hostEnv of [{}, { DOCS_TOKEN: "" }]) assert.equal(check({ forwardEnv: ["DOCS_TOKEN"], hostEnv })(job(["docs"], {})).refused, "mcp-secret-unmapped", JSON.stringify(hostEnv));
	assert.equal(check()(job(["keyed"], { ANTHROPIC_API_KEY: "x" })).refused, "mcp-secret-reserved", "a reserved name the trigger maps is still refused");
	assert.equal(check()(job(["keyed"], {})).refused, "mcp-secret-reserved", "reserved is asked before mapped");
	// Of every reference, before any is asked whether it is mapped: a first server with an unmapped reference does not
	// hide a second one's reserved reference.
	assert.equal(check()(job(["docs", "keyed"], {})).refused, "mcp-secret-reserved");
	assert.equal(check({ allowlist: () => [] })(job(["docs"])).refused, "mcp-egress-unreachable");
	assert.equal(check({ endpoints: () => [] })(job(["lan"])).refused, "mcp-egress-unreachable");
	assert.equal(check({ allowlist: () => ["mcp.example.com"] })(job(["npx"])).refused, "mcp-package-runner");
	// Each runner's registries, every one of them held: uvx fetches its index from pypi.org and its files from elsewhere.
	assert.deepEqual(packageRunnerHosts("uvx"), ["pypi.org", "files.pythonhosted.org"]);
	assert.deepEqual(packageRunnerHosts("/usr/bin/yarn"), ["registry.yarnpkg.com"]);
	assert.deepEqual(packageRunnerHosts("npx"), ["registry.npmjs.org"]);
	// With the egress policy off, neither egress question is asked.
	const off = check({ egress: false, allowlist: () => assert.fail("not read"), endpoints: () => assert.fail("not read") });
	assert.equal(off(job(["docs", "npx"])).ok, true);
	for (const reason of ["mcp-list-invalid", "mcp-config-invalid", "mcp-server-unknown", "mcp-secret-unmapped", "mcp-secret-reserved", "mcp-egress-unreachable", "mcp-package-runner"]) {
		assert.equal(typeof MCP_REFUSAL_COMMENT[reason], "string", reason);
		assert.doesNotMatch(MCP_REFUSAL_COMMENT[reason], /\$\{|http|\.com/, "the public sentence names no host and no variable");
	}
});

test("makeMcpCheck: the overlay that cannot be read refuses, and one that may read on a retry is retried", () => {
	assert.match(check({ read: () => null })(job(["docs"])).why, /holds no mcp\.json/);
	assert.match(check({ globalPiDir: null, read: () => null })(job(["docs"])).why, /no overlay/);
	assert.equal(check({ read: () => { throw Object.assign(new Error("x"), { mcpConfig: true }); } })(job(["docs"])).refused, "mcp-config-invalid");
	assert.equal(check({ read: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } })(job(["docs"])).refused, "mcp-config-invalid");
	assert.deepEqual(check({ read: () => { throw Object.assign(new Error("x"), { code: "EIO" }); } })(job(["docs"])), { unavailable: "EIO" });
	// The parser's own refusal is determinate whatever errno it carries: a file that does not parse will not parse on a retry.
	assert.equal(check({ read: () => { throw Object.assign(new Error("x"), { mcpConfig: true, code: "EIO" }); } })(job(["docs"])).refused, "mcp-config-invalid");
	assert.deepEqual([...MCP_TRANSIENT_READ_CODES].sort(), [...OVERLAY_TRANSIENT_READ_CODES].sort(), "the restated set is model-catalog's");
});

test("makeMcpCheck: a job's list the loader would not have written is refused, never read as none and never posted", () => {
	const unread = check({ read: () => assert.fail("never read") });
	for (const mcp of [null, "docs", { 0: "docs", length: 1 }, { docs: true }, [], ["docs", "docs"], ["__proto__"], ["x\" @everyone https://evil.example"], [{}], Array.from({ length: 9 }, (_, i) => `s${i}`)]) {
		assert.deepEqual(unread(job(mcp)), { refused: "mcp-list-invalid", name: null, why: "the job's run.mcp is not a list of server names the loader accepts" }, JSON.stringify(mcp));
	}
	// A name that passes the rule but that the file does not hold, inherited properties included, is unknown.
	for (const name of ["constructor", "tostring", "valueof", "hasownproperty"]) assert.equal(check()(job([name])).refused, "mcp-server-unknown", name);
});

test("makeMcpCheck: the allowlist read that may pass on a retry is retried; any other failure refuses", () => {
	const failing = (code) => check({ allowlist: () => { throw Object.assign(new Error("x"), { code }); } });
	assert.deepEqual(failing("EIO")(job(["docs"])), { unavailable: "EIO" });
	assert.equal(failing("EACCES")(job(["docs"])).refused, "mcp-egress-unreachable");
	assert.equal(failing("EACCES")(job(["npx"])).refused, "mcp-egress-unreachable");
});

test("providerKeyNames: the builtin key variables of the providers given, and every variable the overlay models.json references", () => {
	const names = providerKeyNames({
		providers: ["anthropic", "openai"],
		candidatesOf: (provider) => ({ anthropic: ["ANTHROPIC_API_KEY"], openai: ["OPENAI_API_KEY"], huggingface: ["HF_TOKEN"] })[provider],
		overlayModels: {
			providers: {
				whole: { apiKey: "$MY_PROVIDER_KEY" },
				braced: { apiKey: "${BRACED_KEY}" },
				template: { apiKey: "corp-${KEY_PART_A}$KEY_PART_B" },
				header: { apiKey: "none", headers: { Authorization: "Bearer $CORP_KEY" }, models: [{ id: "m", headers: { "x-model": "${MODEL_KEY}" } }] },
				override: { modelOverrides: { m: { headers: { "api-key": "$OVERRIDE_KEY" } } } },
				literal: { apiKey: "sk-literal" },
			},
		},
	});
	assert.deepEqual([...names].sort(), ["ANTHROPIC_API_KEY", "BRACED_KEY", "CORP_KEY", "KEY_PART_A", "KEY_PART_B", "MODEL_KEY", "MY_PROVIDER_KEY", "OPENAI_API_KEY", "OVERRIDE_KEY"]);
	assert.ok(!names.has("HF_TOKEN"), "a provider the job cannot call is not counted");
	assert.deepEqual([...providerKeyNames({ overlayModels: { providers: [] } })], []);
});

test("jobProviders: the job's own provider and each on its model list, the trigger's before the deployment's", () => {
	assert.deepEqual(jobProviders({ provider: "anthropic", models: [] }), ["anthropic"]);
	assert.deepEqual(jobProviders({ models: [] }, { defaultProvider: "anthropic" }), ["anthropic"]);
	// No list anywhere: no guard in the runner, so every builtin provider is one the job may call.
	assert.deepEqual(jobProviders({ provider: "anthropic" }, { everyProvider: ["anthropic", "openai", "huggingface"] }), ["anthropic", "openai", "huggingface"]);
	assert.deepEqual(jobProviders({ provider: "openai", models: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"] }, { allowedModels: ["google/x"] }), ["openai", "anthropic"]);
	assert.deepEqual(jobProviders({ provider: "openai" }, { allowedModels: ["google/x"] }), ["openai", "google"]);
});

test("makeMcpCheck: a read inside reserved that may pass on a retry is retried", () => {
	assert.deepEqual(check({ reserved: () => { throw Object.assign(new Error("x"), { code: "EIO" }); } })(job(["docs"])), { unavailable: "EIO" });
	assert.throws(() => check({ reserved: () => { throw new Error("bug"); } })(job(["docs"])), /bug/);
});
