import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	EMPTY_MODEL_ENDPOINTS,
	ENDPOINTS_INCLUDE_HEADER,
	LOCAL_ADDRESSES,
	MODEL_ENDPOINTS_VERSION,
	baseUrlTarget,
	endpointsForModel,
	endpointsForProvider,
	loadModelEndpoints,
	modelEndpointsPath,
	parseModelEndpoints,
	readOverlayModels,
	renderEndpointsInclude,
	valkeyPortOf,
} from "../src/model-endpoints.mjs";
import { PROXY_LOCAL_ADDRESSES } from "../src/backends.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const tmp = () => tempDir("pi-endpoints-");
const wrap = (endpoints, version = 1) => JSON.stringify({ version, endpoints });
const parse = (endpoints, opts) => parseModelEndpoints(wrap(endpoints), "me.json", opts);
const ep = (over = {}) => ({ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, ...over });

// ── parse ──────────────────────────────────────────────────────────────────────────────────────────────

test("parseModelEndpoints normalises an endpoint and defaults keyless to false", () => {
	assert.deepEqual(parse([ep()]), [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: false }]);
	assert.deepEqual(parse([ep({ keyless: true })])[0].keyless, true);
	assert.deepEqual(parse([]), []);
	assert.equal(MODEL_ENDPOINTS_VERSION, 1);
	assert.deepEqual(parseModelEndpoints(EMPTY_MODEL_ENDPOINTS, "me.json"), [], "the scaffold parses");
});

test("parseModelEndpoints refuses a malformed file, a missing or newer version and an unknown key", () => {
	assert.throws(() => parseModelEndpoints("{ nope", "me.json"), /not valid JSON: me\.json/);
	assert.throws(() => parseModelEndpoints("[]", "me.json"), /must be an object with "version" and "endpoints"/);
	assert.throws(() => parseModelEndpoints(JSON.stringify({ endpoints: [] }), "me.json"), /must have "version": 1/);
	assert.throws(() => parseModelEndpoints(JSON.stringify({ version: 0, endpoints: [] }), "me.json"), /must have "version": 1/);
	assert.throws(() => parseModelEndpoints(JSON.stringify({ version: "1", endpoints: [] }), "me.json"), /must have "version": 1/);
	assert.throws(() => parseModelEndpoints(wrap([], 2), "me.json"), /written by a newer pi-dispatch \(version 2; this build understands 1\)/);
	assert.throws(() => parseModelEndpoints(JSON.stringify({ version: 1 }), "me.json"), /must have an "endpoints" array/);
	assert.throws(() => parseModelEndpoints(JSON.stringify({ version: 1, endpoints: [], extra: 1 }), "me.json"), /unknown key\(s\) "extra"/);
	// Refused, not dropped: this file decides proxy rules, and a key an old worker drops is a rule nobody has.
	assert.throws(() => parse([ep({ models: ["qwen"] })]), /model endpoint at index 0: unknown key\(s\) "models"/);
	assert.throws(() => parse([null]), /at index 0: must be an object/);
	assert.throws(() => parse(["x"]), /at index 0: must be an object/);
});

test("parseModelEndpoints refuses a bad id and a duplicate id", () => {
	for (const id of ["", "Mac", "mac_ollama", "a".repeat(33), "mac ollama", 7, undefined]) {
		assert.throws(() => parse([ep({ id })]), /id must be 1 to 32 of a-z, 0-9 and -/, JSON.stringify(id));
	}
	assert.deepEqual(parse([ep({ id: "a".repeat(32) })])[0].id, "a".repeat(32));
	assert.throws(() => parse([ep(), ep({ port: 11435 })]), /at index 1: duplicate id "mac-ollama" \(first at index 0\)/);
});

test("parseModelEndpoints refuses a duplicate host and port under another id, after canonicalising the host", () => {
	assert.throws(() => parse([ep({ id: "a" }), ep({ id: "b" })]), /at index 1: host\.docker\.internal port 11434 is already declared as "a"/);
	assert.throws(() => parse([ep({ id: "a" }), ep({ id: "b", host: "HOST.docker.internal" })]), /already declared as "a"/);
	assert.throws(() => parse([ep({ id: "a", host: "fd00::2" }), ep({ id: "b", host: "[FD00:0:0::2]" })]), /\[fd00::2\] port 11434 is already declared as "a"/);
	assert.equal(parse([ep({ id: "a" }), ep({ id: "b", port: 11435 })]).length, 2, "the same host on another port is another endpoint");
});

test("parseModelEndpoints refuses a loopback, localhost or unspecified host", () => {
	for (const host of ["localhost", "LOCALHOST", "ollama.localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "::1", "[::1]", "::", "[::]", "0:0:0:0:0:0:0:1"]) {
		assert.throws(() => parse([ep({ host })]), /loopback|unspecified/, host);
	}
	// Issue #503 part 3: the parser refuses every address the proxy denies as host-local, from the one shared set, so
	// slirp4netns's host alias is refused too: the rendered `_local` deny would block a declaration of it anyway.
	assert.throws(() => parse([ep({ host: "10.0.2.2" })]), /slirp4netns's host alias, which the proxy denies as host-local/);
	assert.equal(parse([ep({ host: "10.0.2.3" })])[0].host, "10.0.2.3", "only the /32");
});

test("parseModelEndpoints canonicalises a host: lowercase names, bracketed compressed IPv6, dotted IPv4", () => {
	assert.equal(parse([ep({ host: "Ollama.LAN" })])[0].host, "ollama.lan");
	assert.equal(parse([ep({ host: "192.168.5.2" })])[0].host, "192.168.5.2");
	assert.equal(parse([ep({ host: "fd00:0:0::2" })])[0].host, "[fd00::2]", "bare IPv6 is stored bracketed, the form squid and a URL use");
	assert.equal(parse([ep({ host: "[FD00::2]" })])[0].host, "[fd00::2]");
	assert.equal(parse([ep({ host: "gpu_box.lan" })])[0].host, "gpu_box.lan", "an underscore is a name a URL keeps");
});

test("parseModelEndpoints refuses a trailing dot rather than stripping it (refuse, never repair)", () => {
	assert.throws(() => parse([ep({ host: "ollama.lan." })]), /ends in a dot: write it without the dot/);
});

test("parseModelEndpoints refuses a host that is not a name or a literal a URL and squid read the same way", () => {
	const bad = {
		"010.1.1.1": /neither a DNS name nor an IPv4 address in dotted-decimal form/, // a URL reads it as octal 8.1.1.1
		"127.1": /neither a DNS name nor an IPv4 address/, // a URL reads it as 127.0.0.1
		"a.0x10": /neither a DNS name nor an IPv4 address/,
		"::ffff:10.0.0.1": /IPv4 tail/,
		"::ffff:a00:1": /IPv4-mapped/,
		"::a00:1": /IPv4-compatible/,
		"fe80::1%en0": /zone id/,
		"fd00::zz": /not a DNS name, an IPv4 address or an IPv6 address/,
		"example.com:80": /carries a port: put the host alone in "host" and the port in "port"/,
		"host.docker.internal:11434": /carries a port/,
		"192.168.5.2:11434": /carries a port/,
		"[fd00::2]:8080": /carries a port/,
		// An empty port is still a port separator (#515 review): not "an IPv6 address with an IPv4 tail".
		"a.lan:": /carries a port: put the host alone/,
		"192.168.5.2:": /carries a port/,
		"[fd00::2]:": /carries a port/,
		"-bad.lan": /not a DNS name/,
		"a..b": /not a DNS name/,
		"a b": /not a DNS name/,
		" ollama": /must not carry spaces/,
		"": /non-empty string/,
		"ollama.lan\nhttp_access allow all": /not a DNS name/,
	};
	for (const [host, re] of Object.entries(bad)) assert.throws(() => parse([ep({ host })]), re, JSON.stringify(host));
	assert.throws(() => parse([ep({ host: 5 })]), /host must be a non-empty string/);
	assert.throws(() => parse([ep({ host: `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}` })]), /longer than 253/);
});

test("parseModelEndpoints refuses a port outside 1-65535, the proxy's 3128 and the queue's port", () => {
	for (const port of [0, 65536, -1, 1.5, "11434", null]) assert.throws(() => parse([ep({ port })]), /port must be an integer from 1 to 65535/, String(port));
	assert.throws(() => parse([ep({ port: 3128 })]), /port 3128 is the egress proxy's own port/);
	assert.throws(() => parse([ep({ port: 6379 })], { valkeyPort: 6379 }), /port 6379 is the job queue's \(VALKEY_URL\)/);
	assert.throws(() => parse([ep({ port: 16379 })], { valkeyPort: 16379 }), /job queue's/);
	assert.equal(parse([ep({ port: 6379 })]).length, 1, "with no queue port passed, 6379 is an ordinary port");
	assert.equal(parse([ep({ port: 1 })])[0].port, 1);
	assert.equal(parse([ep({ port: 65535 })])[0].port, 65535);
});

test("valkeyPortOf reads VALKEY_URL's port, 6379 when none is written, null when it does not parse", () => {
	assert.equal(valkeyPortOf("redis://127.0.0.1:6379"), 6379);
	assert.equal(valkeyPortOf("redis://valkey:16379/0"), 16379);
	assert.equal(valkeyPortOf("redis://valkey"), 6379);
	assert.equal(valkeyPortOf("rediss://:pw@valkey"), 6379);
	assert.equal(valkeyPortOf("not a url"), null);
	assert.equal(valkeyPortOf(undefined), null);
});

test("parseModelEndpoints refuses slots outside 1-64 and a keyless that is not a boolean", () => {
	for (const slots of [0, 65, -1, 1.5, "2", undefined]) assert.throws(() => parse([ep({ slots })]), /slots must be an integer from 1 to 64/, String(slots));
	assert.equal(parse([ep({ slots: 1 })])[0].slots, 1);
	assert.equal(parse([ep({ slots: 64 })])[0].slots, 64);
	for (const keyless of ["true", 1, null]) assert.throws(() => parse([ep({ keyless })]), /keyless must be true or false/, String(keyless));
});

// ── load ───────────────────────────────────────────────────────────────────────────────────────────────

test("loadModelEndpoints reads model-endpoints.json in the deployment folder when PI_MODEL_ENDPOINTS_FILE is unset", () => {
	const dir = tmp();
	assert.deepEqual(loadModelEndpoints({ modelEndpointsFile: null }, { cwd: dir }), [], "a missing DEFAULT file declares no endpoints");
	writeFileSync(join(dir, "model-endpoints.json"), wrap([ep()]));
	assert.equal(loadModelEndpoints({ modelEndpointsFile: null }, { cwd: dir })[0].id, "mac-ollama");
	assert.deepEqual(modelEndpointsPath({}, dir), { path: join(dir, "model-endpoints.json"), explicit: false });
});

test("loadModelEndpoints: PI_MODEL_ENDPOINTS_FILE overrides, a missing named file and an empty value are refused", () => {
	const dir = tmp();
	mkdirSync(join(dir, "etc"));
	writeFileSync(join(dir, "etc", "eps.json"), wrap([ep({ id: "named" })]));
	writeFileSync(join(dir, "model-endpoints.json"), wrap([ep({ id: "default" })]));
	assert.equal(loadModelEndpoints({ modelEndpointsFile: join(dir, "etc", "eps.json") }, { cwd: dir })[0].id, "named");
	assert.equal(loadModelEndpoints({ modelEndpointsFile: "etc/eps.json" }, { cwd: dir })[0].id, "named", "a relative path resolves against the deployment folder");
	assert.throws(() => loadModelEndpoints({ modelEndpointsFile: join(dir, "nope.json") }, { cwd: dir }), /model-endpoints file does not exist: .*nope\.json/);
	assert.throws(() => loadModelEndpoints({ modelEndpointsFile: "" }, { cwd: dir }), /PI_MODEL_ENDPOINTS_FILE is set to an empty value/);
});

test("loadModelEndpoints refuses an endpoint on VALKEY_URL's port, read from the config", () => {
	const dir = tmp();
	writeFileSync(join(dir, "model-endpoints.json"), wrap([ep({ port: 6380 })]));
	assert.throws(() => loadModelEndpoints({ modelEndpointsFile: null, valkeyUrl: "redis://10.0.0.5:6380" }, { cwd: dir }), /job queue's/);
	assert.equal(loadModelEndpoints({ modelEndpointsFile: null, valkeyUrl: "redis://10.0.0.5:6379" }, { cwd: dir }).length, 1);
});

test("readOverlayModels parses <globalPiDir>/models.json as pi does, null with no overlay or no file", () => {
	const dir = tmp();
	assert.equal(readOverlayModels(null), null);
	assert.equal(readOverlayModels(dir), null, "no models.json");
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { baseUrl: "$OLLAMA_URL" } } }));
	assert.deepEqual(readOverlayModels(dir), { providers: { p: { baseUrl: "$OLLAMA_URL" } } }, "no $VAR expansion");
	writeFileSync(join(dir, "models.json"), "{ nope");
	assert.throws(() => readOverlayModels(dir), /overlay models\.json is not valid JSON/);
	writeFileSync(join(dir, "models.json"), "[]");
	assert.throws(() => readOverlayModels(dir), /overlay models\.json does not match pi's models\.json schema/);
	// Issue #502: what pi accepts is read, and what pi drops is refused (models-json.test.mjs holds the rule to pi).
	writeFileSync(join(dir, "models.json"), '\uFEFF{ // overlay\n "providers": { "p": { "models": [ { "id": "m" }, ] } } }');
	assert.deepEqual(readOverlayModels(dir), { providers: { p: { models: [{ id: "m" }] } } });
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "m", contextWindow: "big" }] } } }));
	assert.throws(() => readOverlayModels(dir), (e) => e.piDispatchConfig === true && !/big/.test(e.message));
});

// PR #520 round 2: the READ is outside the parse's try and has no existsSync before it, so an unreadable file is a
// transient error carrying its code (the keyless gate retries on it), never "not valid JSON" and never absence.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
test("readOverlayModels: absence is null, every other read error is rethrown with its code, only a parse error is a configError", { skip: asRoot ? "root reads a mode-000 file" : false }, () => {
	const dir = tmp();
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));
	chmodSync(join(dir, "models.json"), 0o000);
	try {
		assert.throws(() => readOverlayModels(dir), (e) => e.code === "EACCES" && e.piDispatchConfig !== true, "a mode-000 file");
	} finally {
		chmodSync(join(dir, "models.json"), 0o600);
	}
	const parent = tmp();
	const overlay = join(parent, "overlay");
	mkdirSync(overlay);
	writeFileSync(join(overlay, "models.json"), "{}");
	chmodSync(overlay, 0o000);
	try {
		// existsSync answers false here, which is why it is not asked: this is not absence.
		assert.throws(() => readOverlayModels(overlay), (e) => e.code === "EACCES" && e.piDispatchConfig !== true, "a mode-000 parent directory");
	} finally {
		chmodSync(overlay, 0o700);
	}
	const eio = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
	assert.throws(() => readOverlayModels(dir, { readFileSync: () => { throw eio; } }), (e) => e === eio, "rethrown as-is");
	for (const code of ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]) {
		assert.equal(readOverlayModels(dir, { readFileSync: () => { throw Object.assign(new Error(code), { code }); } }), null, code);
	}
	assert.throws(() => readOverlayModels(dir, { readFileSync: () => "{ nope" }), (e) => e.piDispatchConfig === true && /not valid JSON/.test(e.message));
});

// ── derivation ─────────────────────────────────────────────────────────────────────────────────────────

const ENDPOINTS = [
	{ id: "mac", host: "host.docker.internal", port: 11434, slots: 2, keyless: true },
	{ id: "gpu", host: "gpu.lan", port: 8000, slots: 4, keyless: false },
	{ id: "web", host: "llm.lan", port: 443, slots: 1, keyless: false },
	{ id: "plain", host: "llm.lan", port: 80, slots: 1, keyless: false },
	{ id: "v6", host: "[fd00::2]", port: 8080, slots: 1, keyless: false },
];
const MODELS = {
	providers: {
		local: {
			baseUrl: "http://host.docker.internal:11434/v1",
			models: [{ id: "qwen" }, { id: "big", baseUrl: "http://gpu.lan:8000/v1" }, { id: "wrong-port", baseUrl: "http://gpu.lan:8001/v1" }],
		},
		tls: { baseUrl: "https://LLM.lan/v1", models: [{ id: "a" }] },
		plain: { baseUrl: "http://llm.lan/v1", models: [{ id: "b" }] },
		six: { baseUrl: "http://[FD00:0::2]:8080/v1", models: [{ id: "c" }] },
		none: { models: [{ id: "d" }] },
		odd: { baseUrl: "ftp://gpu.lan:8000/", models: [{ id: "e" }] },
	},
};
const idsFor = (provider, modelId) => endpointsForModel({ models: MODELS, provider, modelId, endpoints: ENDPOINTS }).map((e) => e.id);

test("endpointsForModel: a model's own baseUrl beats its provider's", () => {
	assert.deepEqual(idsFor("local", "big"), ["gpu"]);
	assert.deepEqual(idsFor("local", "qwen"), ["mac"], "no model baseUrl: the provider's");
	assert.deepEqual(idsFor("local", "not-listed"), ["mac"], "a model the overlay does not list takes the provider's");
});

test("endpointsForModel: the port must match, and a missing port is the scheme's default", () => {
	assert.deepEqual(idsFor("local", "wrong-port"), [], "same host, other port: no endpoint");
	assert.deepEqual(idsFor("tls", "a"), ["web"], "https with no port is 443");
	assert.deepEqual(idsFor("plain", "b"), ["plain"], "http with no port is 80");
});

test("endpointsForModel: the host compares case-insensitively and IPv6 in canonical form", () => {
	assert.deepEqual(idsFor("tls", "a"), ["web"], "LLM.lan in the baseUrl");
	assert.deepEqual(idsFor("six", "c"), ["v6"]);
});

test("endpointsForModel: a baseUrl with one trailing dot uses the endpoint its name without the dot declares", () => {
	const models = { providers: { dot: { baseUrl: "http://Host.Docker.Internal.:11434/v1", models: [{ id: "q" }] } } };
	assert.deepEqual(endpointsForModel({ models, provider: "dot", modelId: "q", endpoints: ENDPOINTS }).map((e) => e.id), ["mac"]);
});

test("endpointsForModel: a $VAR or any other non-URL baseUrl matches no endpoint (the residual the contract names)", () => {
	// No expansion: the host's environment is not the job's. Such a model takes no slot lease and does not pass the
	// keyless gate, which the contract's Derivation bullet states as a residual.
	for (const baseUrl of ["$OLLAMA_URL", "${OLLAMA_URL}/v1", "!echo http://host.docker.internal:11434", "host.docker.internal:11434"]) {
		const models = { providers: { v: { baseUrl, models: [{ id: "q" }] } } };
		assert.deepEqual(endpointsForModel({ models, provider: "v", modelId: "q", endpoints: ENDPOINTS }), [], baseUrl);
		assert.deepEqual(endpointsForProvider({ models, provider: "v", endpoints: ENDPOINTS }), [{ modelId: "q", endpoints: [] }], baseUrl);
	}
});

test("endpointsForModel: no overlay, no provider, no baseUrl or a non-http scheme is no endpoint", () => {
	assert.deepEqual(endpointsForModel({ models: null, provider: "local", modelId: "qwen", endpoints: ENDPOINTS }), []);
	assert.deepEqual(idsFor("anthropic", "x"), []);
	assert.deepEqual(idsFor("none", "d"), []);
	assert.deepEqual(idsFor("odd", "e"), []);
	assert.deepEqual(idsFor("toString", "x"), [], "an inherited name is not a provider");
	assert.deepEqual(endpointsForModel({ models: MODELS, provider: "local", modelId: "qwen", endpoints: [] }), []);
});

test("baseUrlTarget reads what a URL dials", () => {
	assert.deepEqual(baseUrlTarget("http://Host.Docker.Internal:11434/v1"), { host: "host.docker.internal", port: 11434 });
	assert.deepEqual(baseUrlTarget("https://x.lan"), { host: "x.lan", port: 443 });
	assert.deepEqual(baseUrlTarget("http://x.lan:80/"), { host: "x.lan", port: 80 });
	// ONE trailing dot is stripped: squid tunnels `name.` to the same server (measured 200), so the baseUrl reaches the
	// endpoint and must take its lease. Two dots stay, and match nothing.
	assert.deepEqual(baseUrlTarget("http://x.lan./"), { host: "x.lan", port: 80 });
	assert.deepEqual(baseUrlTarget("http://x.lan../"), { host: "x.lan.", port: 80 });
	assert.equal(baseUrlTarget("$OLLAMA_URL"), null);
	assert.equal(baseUrlTarget(undefined), null);
});

test("endpointsForProvider lists every model of the provider with its endpoints", () => {
	assert.deepEqual(
		endpointsForProvider({ models: MODELS, provider: "local", endpoints: ENDPOINTS }).map((m) => [m.modelId, m.endpoints.map((e) => e.id)]),
		[["qwen", ["mac"]], ["big", ["gpu"]], ["wrong-port", []]],
	);
	assert.deepEqual(endpointsForProvider({ models: MODELS, provider: "anthropic", endpoints: ENDPOINTS }), []);
	assert.deepEqual(endpointsForProvider({ models: { providers: { p: { baseUrl: "http://gpu.lan:8000" } } }, provider: "p", endpoints: ENDPOINTS }), [], "no models listed");
});

// ── render ─────────────────────────────────────────────────────────────────────────────────────────────

// Golden. Checked against squid 6.13 on 2026-09-30 (`squid -k parse`, and CONNECT probes): the name, the IPv4
// literal and the IPv6 literal each admit a CONNECT to their own port only.
const GOLDEN = `# Generated by pi-dispatch from model-endpoints.json. Do not edit: regenerate it with \`pi-dispatch egress render\`.
# Each endpoint is a CONNECT tunnel to exactly one declared host and port, and nothing else (issue #503).
# The host ACL comes first on every line, so squid only ever resolves a declared name.

# lan-box
acl pde_lan-box_host dstdomain -n 192.168.5.2
acl pde_lan-box_port port 11434
acl pde_lan-box_local dst 127.0.0.0/8 0.0.0.0/32 10.0.2.2/32 ::1 ::/128
http_access deny CONNECT pde_lan-box_host pde_lan-box_port pde_lan-box_local
http_access allow CONNECT pde_lan-box_host pde_lan-box_port

# mac-ollama
acl pde_mac-ollama_host dstdomain -n host.docker.internal
acl pde_mac-ollama_port port 11434
acl pde_mac-ollama_local dst 127.0.0.0/8 0.0.0.0/32 10.0.2.2/32 ::1 ::/128
http_access deny CONNECT pde_mac-ollama_host pde_mac-ollama_port pde_mac-ollama_local
http_access allow CONNECT pde_mac-ollama_host pde_mac-ollama_port

# v6
acl pde_v6_host dstdomain -n [fd00::2]
acl pde_v6_port port 8080
acl pde_v6_local dst 127.0.0.0/8 0.0.0.0/32 10.0.2.2/32 ::1 ::/128
http_access deny CONNECT pde_v6_host pde_v6_port pde_v6_local
http_access allow CONNECT pde_v6_host pde_v6_port
`;
const DECLARED = [ep(), ep({ id: "v6", host: "fd00::2", port: 8080, slots: 1 }), ep({ id: "lan-box", host: "192.168.5.2", slots: 1, keyless: true })];

test("renderEndpointsInclude: golden for a name, an IPv4 literal and an IPv6 literal, sorted by id", () => {
	assert.equal(renderEndpointsInclude(parse(DECLARED)), GOLDEN);
	assert.equal(renderEndpointsInclude(parse([...DECLARED].reverse())), GOLDEN, "file order does not matter");
});

test("renderEndpointsInclude of no endpoints is the header alone (squid starts on it, and refuses a missing file)", () => {
	assert.equal(renderEndpointsInclude([]), `${ENDPOINTS_INCLUDE_HEADER}\n`);
	assert.ok(renderEndpointsInclude([]).split("\n").every((l) => l === "" || l.startsWith("#")), "comments only");
});

test("every http_access line the render emits is a CONNECT rule, and every allow names the endpoint's host and port", () => {
	const endpoints = parse(DECLARED);
	const lines = renderEndpointsInclude(endpoints).split("\n");
	const access = lines.filter((l) => l.startsWith("http_access"));
	assert.equal(access.length, 2 * endpoints.length);
	for (const line of access) assert.match(line, /^http_access (allow|deny) CONNECT /, `no plain forward rule: ${line}`);
	for (const e of endpoints) {
		const n = `pde_${e.id}`;
		const allows = access.filter((l) => l.startsWith("http_access allow") && l.includes(`${n}_`));
		assert.deepEqual(allows, [`http_access allow CONNECT ${n}_host ${n}_port`], e.id);
	}
});

test("the loopback ACL is to_host_local's set minus the link-local ranges a rootless job reaches its host through", () => {
	const conf = readFileSync(new URL("../../deploy/egress-proxy.conf", import.meta.url), "utf8");
	const hostLocal = /^acl to_host_local dst (.+)$/m.exec(conf)[1].split(" ");
	// The shared source in backends.mjs is what LOCAL_ADDRESSES is built from, so this pins both.
	assert.equal(LOCAL_ADDRESSES, PROXY_LOCAL_ADDRESSES.join(" "));
	const local = [...PROXY_LOCAL_ADDRESSES];
	// Left out on purpose: host.containers.internal is 169.254.1.2 on Podman 5.3 and later (measured 2026-09-30).
	assert.deepEqual(hostLocal.filter((a) => !local.includes(a)), ["169.254.0.0/16", "fe80::/10"]);
	assert.deepEqual(local.filter((a) => !hostLocal.includes(a)), [], "and nothing to_host_local does not have");
	assert.ok(local.includes("10.0.2.2/32"), "slirp4netns's host alias stays");
});

test("the host ACL is dstdomain -n for names and literals alike, never dst", () => {
	// Measured on squid 6.13, 2026-09-30: a `dst <ip>` host ACL resolves the name of every CONNECT reaching the line (a
	// DNS channel out of the job) and admits any name that resolves to the address.
	const lines = renderEndpointsInclude(parse(DECLARED)).split("\n");
	const hostAcls = lines.filter((l) => /^acl pde_[a-z0-9-]+_host /.test(l));
	assert.equal(hostAcls.length, 3);
	for (const l of hostAcls) assert.match(l, /^acl pde_[a-z0-9-]+_host dstdomain -n \S+$/);
	assert.ok(!lines.some((l) => /^acl pde_[a-z0-9-]+_host dst /.test(l)));
});

test("the deny line names the host ACL before the loopback ACL, so only a declared name is ever resolved", () => {
	for (const line of renderEndpointsInclude(parse(DECLARED)).split("\n").filter((l) => l.startsWith("http_access deny"))) {
		const m = /^http_access deny CONNECT (pde_[a-z0-9-]+)_host \1_port \1_local$/.exec(line);
		assert.ok(m, line);
	}
});

test("renderEndpointsInclude refuses what the parser would never produce", () => {
	assert.throws(() => renderEndpointsInclude([{ id: "x\nhttp_access allow all", host: "a.lan", port: 1 }]), /bad id/);
	assert.throws(() => renderEndpointsInclude([{ id: "x", host: "a.lan\nhttp_access allow all", port: 1 }]), /bad host/);
	assert.throws(() => renderEndpointsInclude([{ id: "x", host: "a.lan", port: "1 2" }]), /bad port/);
});
