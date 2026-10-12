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
	assert.equal(result.document.codemodeModels, true, "on unless the overlay says false");
	const off = parseOverlayMcp(JSON.stringify({ ...OVERLAY, codemodeModels: false }));
	assert.equal(check({ read: () => off })(job(["docs"])).document.codemodeModels, false);
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
	for (const reason of ["mcp-list-invalid", "mcp-excluded", "mcp-config-invalid", "mcp-server-unknown", "mcp-secret-unmapped", "mcp-secret-reserved", "mcp-egress-unreachable", "mcp-package-runner"]) {
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

test("makeMcpCheck: a server the trigger's own exclusions leave no way in is refused, as pi routes; one with a route left, or the overlay's own hiding, is not", () => {
	const routes = parseOverlayMcp(JSON.stringify({ mcpServers: {
		cm: { url: "https://mcp.example.com/a", description: "Codemode" },
		dd: { url: "https://mcp.example.com/b", description: "Deferred", exposure: "deferred" },
		mixed: { url: "https://mcp.example.com/c", description: "Mixed", toolExposure: { search: "direct" } },
		hid: { url: "https://mcp.example.com/d", description: "Hidden", exposure: "hidden" },
		allhid: { url: "https://mcp.example.com/e", description: "All hidden", toolExposure: { "*": "hidden" } },
	} }));
	const run = (mcp, excludeTools) => check({ read: () => routes, allowlist: () => ["mcp.example.com"] })({ ...job(mcp), excludeTools });
	assert.equal(run(["cm"], ["codemode"]).refused, "mcp-excluded");
	assert.equal(run(["cm"], ["codemode"]).name, "cm");
	assert.equal(run(["dd"], ["tool_search"]).refused, "mcp-excluded");
	assert.equal(run(["dd"], ["codemode"]).ok, true, "a deferred server does not need codemode");
	assert.equal(run(["mixed"], ["codemode"]).ok, true, "one direct tool is a route");
	assert.equal(run(["cm", "dd"], ["codemode"]).ok, true, "tool_search, active for dd, loads cm's tools too");
	assert.equal(run(["cm", "dd"], ["tool_search"]).ok, true, "codemode, active for cm, calls dd's tools too");
	assert.equal(run(["cm", "dd"], ["codemode", "tool_search"]).refused, "mcp-excluded");
	assert.equal(run(["cm"], ["mcp__cm__*"]).ok, true, "its tools removed on purpose: its resources, through codemode, are the point");
	assert.equal(run(["cm"], ["mcp__cm__*", "codemode"]).refused, "mcp-excluded", "nor are its resources reachable now");
	assert.equal(run(["cm"], ["mcp__cm__*", "read_mcp_resource"]).refused, "mcp-excluded");
	assert.equal(run(["hid"], ["codemode", "tool_search", "read_mcp_resource"]).ok, true, "the overlay's own hiding is not the trigger's to be refused for");
	assert.equal(run(["allhid"], ["bash"]).ok, true);
	assert.equal(run(["allhid"], ["codemode"]).refused, "mcp-excluded", "its tools are hidden, and its resources went through codemode");
	assert.equal(run(["allhid"], ["read_mcp_resource"]).refused, "mcp-excluded", "a `*` exposure hides every tool, so its resources were its only way");
	const shared = parseOverlayMcp(JSON.stringify({ mcpServers: { a: { url: "https://mcp.example.com/a", description: "A" }, b: { url: "https://mcp.example.com/b", description: "B", exposure: "direct" }, late: { url: "https://mcp.example.com/c", description: "C", toolExposure: { "*": "hidden", "pub*": "direct" } } } }));
	const both = (mcp, excludeTools) => check({ read: () => shared, allowlist: () => ["mcp.example.com"] })({ ...job(mcp), excludeTools });
	assert.equal(both(["a", "b"], ["codemode", "mcp__a__*"]).ok, true, "the resource tools take b's direct exposure and read a's resources too");
	assert.equal(both(["late"], ["codemode"]).refused, "mcp-excluded", "a pattern after * never applies, so pub* is no direct way in, and its resources went through codemode");
	assert.equal(both(["late"], ["read_mcp_resource"]).refused, "mcp-excluded", "its resources, through codemode, were its only way");
	assert.equal(run(["cm"], []).ok, true);
	assert.equal(run(["cm"], ["bash"]).ok, true);
	const off = parseOverlayMcp(JSON.stringify({ autoEnableCodemode: false, mcpServers: { cm: { url: "https://mcp.example.com/a", description: "C" }, dd: { url: "https://mcp.example.com/b", description: "D", exposure: "deferred" } } }));
	assert.equal(check({ read: () => off, allowlist: () => ["mcp.example.com"] })({ ...job(["cm", "dd"]), excludeTools: ["tool_search"] }).refused, "mcp-excluded", "with codemode not activated, tool_search was cm's only way");
});

// --- the forge's own server (DES-FORGE-MCP) ---

const forgeJob = (mcp, kind = "github", secrets = {}) => ({ kind, mcp, secrets, provider: "anthropic" });

test("makeMcpCheck: a github job naming only `forge` passes with no mcp.json and with no overlay at all, and the document holds the worker's entry", () => {
	for (const seams of [{ read: () => null }, { globalPiDir: null, read: () => null }, { globalPiDir: "" }]) {
		const result = check({ allowlist: () => ["api.github.com"], ...seams })(forgeJob(["forge"]));
		assert.equal(result.ok, true, JSON.stringify(seams));
		assert.deepEqual(Object.keys(result.document.servers), ["forge"]);
		assert.equal(result.document.servers.forge.command, "/usr/local/bin/forge-mcp-github");
		assert.deepEqual(result.document.servers.forge.env, { GITHUB_PERSONAL_ACCESS_TOKEN: "${GH_TOKEN}", GITHUB_LOCKDOWN_MODE: "1", GITHUB_TOOLSETS: "default" });
		assert.deepEqual(result.document.refs, { forge: ["GH_TOKEN"] });
		assert.equal(result.document.codemodeModels, true);
	}
	// A file that is there still governs it: its top-level switches are the deployment's.
	const off = parseOverlayMcp(JSON.stringify({ mcpServers: {}, codemodeModels: false, autoEnableCodemode: false }));
	const governed = check({ allowlist: () => ["api.github.com"], read: () => off })(forgeJob(["forge"])).document;
	assert.deepEqual([governed.codemodeModels, governed.autoEnableCodemode], [false, false]);
	// And one that is there and cannot be read refuses it, or retries a read that may pass.
	assert.equal(check({ read: () => { throw Object.assign(new Error("x"), { mcpConfig: true }); } })(forgeJob(["forge"])).refused, "mcp-config-invalid");
	assert.deepEqual(check({ read: () => { throw Object.assign(new Error("x"), { code: "EIO" }); } })(forgeJob(["forge"])), { unavailable: "EIO" });
});

test("makeMcpCheck: `forge` beside overlay servers keeps run.mcp order, and the other names still need the file", () => {
	const result = check({ allowlist: () => ["mcp.example.com", "api.github.com"] })(forgeJob(["docs", "forge"], "github", { DOCS_TOKEN: "op://x" }));
	assert.equal(result.ok, true);
	assert.deepEqual(Object.keys(result.document.servers), ["docs", "forge"]);
	assert.deepEqual(result.document.servers.forge.toolExposure, { "dispatch_*": "hidden" });
	assert.equal(check({ read: () => null })(forgeJob(["forge", "docs"], "github", { DOCS_TOKEN: "op://x" })).refused, "mcp-config-invalid");
	assert.equal(check({ allowlist: () => ["mcp.example.com", "api.github.com"] })(forgeJob(["forge", "nope"])).refused, "mcp-server-unknown");
});

test("makeMcpCheck: the forge entry alone is exempt from the secret rules; an overlay server naming GH_TOKEN is still refused", () => {
	// GH_TOKEN is reserved (a minted forge token) and not mapped by the trigger, yet the forge entry passes.
	assert.equal(check({ allowlist: () => ["api.github.com"] })(forgeJob(["forge"], "github", {})).ok, true);
	const gl = check({ gitlabUrl: "https://gitlab.com", reserved: () => new Set(["GITLAB_TOKEN"]), allowlist: () => ["gitlab.com"] })(forgeJob(["forge"], "gitlab", {}));
	assert.equal(gl.ok, true);
	const theft = parseOverlayMcp(JSON.stringify({ mcpServers: { gh: { command: "/usr/local/bin/github-mcp-server", args: ["stdio"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GH_TOKEN}" }, description: "GitHub" } } }));
	const stolen = check({ read: () => theft, allowlist: () => ["api.github.com"] })(forgeJob(["forge", "gh"], "github", { GH_TOKEN: "x" }));
	assert.equal(stolen.refused, "mcp-secret-reserved");
	assert.equal(stolen.name, "gh");
	// The exemption is the forge entry's, not the job's: an unmapped reference of an overlay server beside it is refused.
	assert.equal(check({ allowlist: () => ["mcp.example.com", "api.github.com"] })(forgeJob(["forge", "docs"], "github", {})).refused, "mcp-secret-unmapped");
});

test("makeMcpCheck: `forge` on a job that is not a github or gitlab one is refused as unknown, never handed another forge's entry", () => {
	for (const kind of ["local", "forgejo", "azure", null, "__proto__", "GitHub"]) {
		const result = check({ read: () => null, gitlabUrl: "https://gitlab.com" })(forgeJob(["forge"], kind));
		assert.deepEqual(result, { refused: "mcp-server-unknown", name: "forge", why: "the forge's own server is offered to a github or gitlab job only" }, String(kind));
	}
	assert.equal(check({ read: () => null })(forgeJob(["forge"], "gitlab")).why, "this worker has no GitLab URL configured");
});

test("makeMcpCheck: with egress on, the forge server's API host must be allowlisted: api.github.com, or the configured GitLab's", () => {
	const gh = check({ read: () => null, allowlist: () => ["mcp.example.com"] })(forgeJob(["forge"]));
	assert.equal(gh.refused, "mcp-egress-unreachable");
	assert.match(gh.why, /api\.github\.com is not in egress-allowlist\.conf/);
	assert.equal(check({ read: () => null, allowlist: () => [".github.com"] })(forgeJob(["forge"])).ok, true, "a leading-dot entry holds it");
	const self = { read: () => null, gitlabUrl: "https://git.example.com/gitlab/" };
	const refused = check({ ...self, allowlist: () => ["gitlab.com"] })(forgeJob(["forge"], "gitlab"));
	assert.equal(refused.refused, "mcp-egress-unreachable");
	assert.match(refused.why, /git\.example\.com is not in egress-allowlist\.conf/);
	const passed = check({ ...self, allowlist: () => ["git.example.com"] })(forgeJob(["forge"], "gitlab"));
	assert.equal(passed.ok, true);
	assert.equal(passed.document.servers.forge.env.GITLAB_API_URL, "https://git.example.com/gitlab/api/v4");
	assert.equal(check({ read: () => null, gitlabUrl: "https://git.example.com:8443", allowlist: () => ["git.example.com"] })(forgeJob(["forge"], "gitlab")).refused, "mcp-egress-unreachable", "the proxy opens 443 only");
	assert.equal(check({ read: () => null, egress: false, allowlist: () => assert.fail("not read") })(forgeJob(["forge"])).ok, true);
});

test("makeMcpCheck: run.excludeTools judges the forge server like any other", () => {
	const job = { ...forgeJob(["forge"]), excludeTools: ["mcp__forge__*", "read_mcp_resource"] };
	const result = check({ read: () => null, allowlist: () => ["api.github.com"] })(job);
	assert.equal(result.refused, "mcp-excluded");
	assert.equal(result.name, "forge");
});

test("makeMcpCheck: a GITLAB_URL the forge entry cannot carry refuses a gitlab job naming `forge`, saying why in the log only", () => {
	for (const gitlabUrl of ["https://u:p@gitlab.com", "https://gitlab.com/?private_token=x", "https://a.example.com,https://b.example.com", "ftp://gitlab.com"]) {
		const result = check({ read: () => null, gitlabUrl, allowlist: () => ["gitlab.com"] })(forgeJob(["forge"], "gitlab"));
		assert.equal(result.refused, "mcp-server-unknown", gitlabUrl);
		assert.match(result.why, /^GITLAB_URL cannot be handed to the forge server: /);
		assert.doesNotMatch(result.why, /private_token|u:p/, "the URL itself never reaches the log line");
	}
	const ok = check({ read: () => null, gitlabUrl: "https://gitlab.com/api/v4", allowlist: () => ["gitlab.com"] })(forgeJob(["forge"], "gitlab"));
	assert.equal(ok.document.servers.forge.env.GITLAB_API_URL, "https://gitlab.com/api/v4", "an /api/v4 already there is not doubled");
	assert.equal(check({ read: () => null, gitlabUrl: "https://u:p@gitlab.com", allowlist: () => ["api.github.com"] })(forgeJob(["forge"])).ok, true, "a github job never reads GITLAB_URL");
});
