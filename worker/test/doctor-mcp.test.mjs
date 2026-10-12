import assert from "node:assert/strict";
import { test } from "node:test";
import { overlayMcpChecks } from "../src/doctor.mjs";
import { allowlistEntryFor, egressRefusalFor, parseAllowlist } from "../src/egress-allowlist.mjs";
import { parseOverlayMcp } from "../src/mcp-config.mjs";

const OVERLAY = "/srv/pi-global";
const doc = (mcpServers) => parseOverlayMcp(JSON.stringify({ mcpServers }));
const armed = { PI_EGRESS: "1" };
const run = ({ parsed = null, env = armed, files = [], allowlist = [], endpoints = [], read } = {}) =>
	overlayMcpChecks({ overlay: OVERLAY, env, fileExists: (p) => files.includes(p), read: read ?? (() => parsed), allowlist, endpoints: () => endpoints });

test("parseAllowlist and allowlistEntryFor read the file as squid's dstdomain does", () => {
	const entries = parseAllowlist("# models\napi.example.com\n .Docs.Example.org # inline\n\n  github.com\n");
	assert.deepEqual(entries, ["api.example.com", ".docs.example.org", "github.com"]);
	// One entry per line: squid reads `a b` as one entry that matches neither (measured), so neither is admitted.
	assert.deepEqual(parseAllowlist("two.example.net three.example.net\nfour.example.net\tfive.example.net\n"), []);
	// A `#` inside a word is part of it, and the word matches nothing.
	assert.deepEqual(parseAllowlist("a.com#x\n"), ["a.com#x"]);
	assert.equal(allowlistEntryFor(entries, "api.example.com"), "api.example.com");
	assert.equal(allowlistEntryFor(entries, "sub.api.example.com"), null, "a name without a dot admits only itself");
	assert.equal(allowlistEntryFor(entries, "docs.example.org"), ".docs.example.org");
	assert.equal(allowlistEntryFor(entries, "A.DOCS.example.org"), ".docs.example.org");
	assert.equal(allowlistEntryFor(entries, "notdocs.example.org"), null);
	assert.equal(allowlistEntryFor(entries, "example.org"), null);
});

test("egressRefusalFor: an allowlisted name on 443, or a declared endpoint's exact host and port", () => {
	const allowlist = parseAllowlist("mcp.example.com\n.corp.example\n");
	const endpoints = [{ id: "lan", host: "192.168.1.5", port: 8080 }];
	assert.equal(egressRefusalFor("https://mcp.example.com/mcp", { allowlist }), null);
	assert.equal(egressRefusalFor("https://mcp.example.com:443/mcp", { allowlist }), null);
	assert.match(egressRefusalFor("http://mcp.example.com:443/mcp", { allowlist }), /for TLS/, "plain http to the TLS port the proxy opens never connects");
	assert.equal(egressRefusalFor("https://mcp.example.com./mcp", { allowlist }), null, "one trailing dot, as baseUrlTarget strips it");
	assert.equal(egressRefusalFor("https://tools.corp.example/mcp", { allowlist }), null);
	assert.equal(egressRefusalFor("http://192.168.1.5:8080/mcp", { allowlist, endpoints }), null);
	assert.match(egressRefusalFor("https://mcp.example.com:8443/mcp", { allowlist }), /port 443 only, and this is port 8443/);
	assert.match(egressRefusalFor("http://mcp.example.com/mcp", { allowlist }), /port 443 only, and this is port 80/);
	assert.match(egressRefusalFor("https://other.example.com/mcp", { allowlist }), /not in egress-allowlist\.conf$/);
	assert.match(egressRefusalFor("http://192.168.1.5:9090/mcp", { allowlist, endpoints }), /not in egress-allowlist\.conf, and port 9090 opens only as a declared endpoint/);
	assert.match(egressRefusalFor("ftp://h/x"), /not an http or https URL/);
	// The proxy never opens its own machine from the allowlist (`to_host_local`), whatever the file says.
	const local = parseAllowlist("127.0.0.1\nlocalhost\n169.254.169.254\n[::1]\n[fe80::1]\n10.0.2.2\n");
	for (const url of ["https://127.0.0.1/mcp", "https://localhost/mcp", "https://169.254.169.254/mcp", "https://[::1]/mcp", "https://[fe80::1]/mcp", "https://10.0.2.2/mcp"]) {
		assert.match(egressRefusalFor(url, { allowlist: local }), /proxy's own machine/, url);
	}
	// A declared endpoint is its own route.
	assert.equal(egressRefusalFor("http://host.docker.internal:8080/mcp", { endpoints: [{ host: "host.docker.internal", port: 8080 }] }), null);
});

test("overlayMcpChecks: no file says nothing; a file names what it offers", () => {
	assert.deepEqual(run(), []);
	const checks = run({ parsed: doc({ docs: { url: "https://mcp.example.com/mcp", description: "Docs" } }), allowlist: ["mcp.example.com"] });
	assert.deepEqual(checks.map((c) => [c.ok, c.label]), [[true, "Overlay mcp.json offers 1 MCP server to triggers that name them (docs)"]]);
	assert.equal(run({ parsed: doc({}) })[0].label, "Overlay mcp.json offers no MCP server");
});

test("overlayMcpChecks: a refused server, an unreadable file and an mcp-auth.json are each ✗", () => {
	const refused = run({ parsed: doc({ bad: { url: "https://h/m", oauth: {}, description: "x" } }) });
	assert.equal(refused[1].ok, false);
	assert.match(refused[1].label, /server "bad" is refused: `oauth` is not accepted/);
	const unreadable = run({ read: () => { throw Object.assign(new Error("/srv/pi-global/mcp.json: is a link"), { mcpConfig: true }); } });
	assert.equal(unreadable[0].ok, false);
	assert.match(unreadable[0].label, /is a link/);
	const eacces = run({ read: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } });
	assert.match(eacces[0].label, /cannot be read \(EACCES\)/);
	const auth = run({ files: [`${OVERLAY}/mcp-auth.json`] });
	assert.equal(auth[0].ok, false);
	assert.match(auth[0].label, /mcp-auth\.json/);
	assert.equal(auth[0].fixAction.describe, `rm ${OVERLAY}/mcp-auth.json`);
});

test("overlayMcpChecks: with the policy on, an unreachable HTTP server and a package runner are ⚠; off, only the runner", () => {
	const parsed = doc({
		far: { url: "https://far.example.com/mcp", description: "Far" },
		near: { url: "https://mcp.example.com/mcp", description: "Near" },
		off: { url: "https://far.example.com/mcp", description: "Off", enabled: false },
		npx: { command: "npx", args: ["-y", "pkg@1"], allowPackageRunner: true, description: "Npx" },
	});
	const on = run({ parsed, allowlist: ["mcp.example.com"] });
	const warned = on.filter((c) => c.warn);
	assert.equal(warned.length, 2);
	assert.match(warned.find((c) => c.label.includes("far"))?.label, /MCP server far \(far\.example\.com\) is not reachable with the egress policy on: far\.example\.com is not in egress-allowlist\.conf/);
	assert.match(warned.find((c) => c.label.includes("npx"))?.label, /runs npx, which fetches the server from a package registry/);
	assert.match(warned.find((c) => c.label.includes("npx"))?.fix, /allowlist registry\.npmjs\.org/);
	// Already allowlisted: not suggested again.
	assert.doesNotMatch(run({ parsed, allowlist: ["mcp.example.com", "registry.npmjs.org"] }).find((c) => c.warn && c.label.includes("runs npx")).fix, /allowlist/);
	// uvx needs both of PyPI's hosts; with one listed, the other is named.
	const uvx = doc({ uv: { command: "uvx", args: ["pkg==1"], allowPackageRunner: true, description: "Uv" } });
	assert.match(run({ parsed: uvx, allowlist: ["pypi.org"] }).find((c) => c.warn).fix, /allowlist files\.pythonhosted\.org in/);
	assert.match(run({ parsed: uvx, allowlist: [] }).find((c) => c.warn).fix, /allowlist pypi\.org and files\.pythonhosted\.org in/);
	const offPolicy = run({ parsed, env: { PI_EGRESS: "0" }, allowlist: [] });
	assert.deepEqual(offPolicy.filter((c) => c.warn).map((c) => c.label.split(" ")[2]), ["npx"]);
	assert.doesNotMatch(offPolicy.find((c) => c.warn).fix, /allowlist/);
	// The endpoints are read only when an HTTP server needs them.
	let reads = 0;
	overlayMcpChecks({ overlay: OVERLAY, env: armed, fileExists: () => false, read: () => doc({ s: { command: "/bin/s", description: "S" } }), endpoints: () => (reads += 1, []) });
	assert.equal(reads, 0);
});
