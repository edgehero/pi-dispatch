import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MCP_CONFIG_MAX_BYTES, MCP_PACKAGE_RUNNERS, MCP_SERVER_NAME_RE, mcpServerWhere, overlayMcpText, parseOverlayMcp, piEntry, readOverlayMcp, refValue } from "../src/mcp-config.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const doc = (mcpServers, extra = {}) => JSON.stringify({ ...extra, mcpServers });
const http = (more = {}) => ({ url: "https://mcp.example.com/mcp", description: "Docs search", ...more });
const stdio = (more = {}) => ({ command: "/usr/local/bin/mcp-fs", description: "File index", ...more });
/** The one server's refusal, or null when it was accepted. */
const problemOf = (server, name = "s") => {
	const parsed = parseOverlayMcp(doc({ [name]: server }));
	return parsed.refused.find((r) => r.name === name)?.problem ?? null;
};

test("parseOverlayMcp: an http and a stdio server are accepted and normalised, with their references", () => {
	const parsed = parseOverlayMcp(
		doc({
			docs: http({ headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "${TEAM}" }, exposure: "codemode", toolExposure: { "delete_*": "hidden" }, timeout: 60 }),
			fs: stdio({ args: ["--root", "/workspace", "--log-level", "warn"], env: { FS_TOKEN: "${FS_TOKEN}", A: "${A}", B: "${B}" }, exposure: "deferred", enabled: false }),
		}),
	);
	assert.deepEqual(parsed.refused, []);
	assert.equal(parsed.autoEnableCodemode, true);
	assert.deepEqual(parsed.servers.docs, {
		name: "docs",
		transport: "http",
		description: "Docs search",
		exposure: "codemode",
		toolExposure: { "delete_*": "hidden" },
		timeout: 60,
		url: "https://mcp.example.com/mcp",
		headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "${TEAM}" },
		refs: ["DOCS_TOKEN", "TEAM"],
	});
	assert.deepEqual(parsed.servers.fs.refs, ["A", "B", "FS_TOKEN"]);
	assert.equal(parsed.servers.fs.enabled, false);
	assert.equal(parsed.servers.fs.packageRunner, false);
	assert.deepEqual(piEntry(parsed.servers.docs), { type: "http", description: "Docs search", exposure: "codemode", toolExposure: { "delete_*": "hidden" }, timeout: 60, url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "${TEAM}" } });
	assert.equal(mcpServerWhere(parsed.servers.docs), "mcp.example.com");
	assert.equal(mcpServerWhere(parsed.servers.fs), "mcp-fs");
	assert.equal(parseOverlayMcp(doc({}, { autoEnableCodemode: false })).autoEnableCodemode, false);
	assert.deepEqual(parseOverlayMcp("{}").servers, {});
});

test("refValue: an env value is exactly ${NAME}; a header value may have one word before it", () => {
	assert.deepEqual(refValue("${A_1}"), { name: "A_1" });
	assert.deepEqual(refValue("Bearer ${T}", { header: true }), { name: "T" });
	assert.deepEqual(refValue("token ${T}", { header: true }), { name: "T" });
	assert.deepEqual(refValue("${T}", { header: true }), { name: "T" });
	for (const bad of ["Bearer ${T}", "x${A}", "${A}${B}", "plain", "", "$A", "${a}", "${1A}", "${A", "$${A}", "!${A}", " ${A}"]) {
		assert.ok(refValue(bad).problem, `env ${JSON.stringify(bad)}`);
	}
	assert.deepEqual(refValue("bearer ${T}", { header: true }), { name: "T" }, "a scheme is matched without case");
	for (const bad of ["Bearer sk-live", "Basic dXNlcjpwYXNz${X}", "Bearer ${A} sk-literal", "Bearer  ${A}", "${A} trailing", "a b ${A}", "!cmd ${A}", "Bearer ${A}\r\nX: 1", "core", "sk-proj-abc ${X}", "AKIAIOSFODNN7EXAMPLE ${X}", "Custom ${X}"]) {
		assert.ok(refValue(bad, { header: true }).problem, `header ${JSON.stringify(bad)}`);
	}
	assert.equal(refValue(5).problem, "is not a string");
});

test("parseOverlayMcp: no literal value reaches the overlay, whatever its name", () => {
	for (const headers of [{ Authorization: "Bearer abc" }, { "X-Goog-Key": "AIzaSECRET" }, { "X-Custom": "Bearer sk-ant-x" }, { "X-Team": "core" }, { Cookie: "s=1" }]) {
		assert.match(problemOf(http({ headers })), /must be `\$\{NAME\}`, or an auth scheme/, JSON.stringify(headers));
	}
	for (const env of [{ GH_PAT: "ghp_x" }, { PRIVATE_KEY: "x" }, { DATABASE_URL: "postgres://u:pw@db/x" }, { LOG_LEVEL: "warn" }, { X: "$HOME" }, { X: "!gh auth token" }]) {
		assert.match(problemOf(stdio({ env })), /must be exactly `\$\{NAME\}`/, JSON.stringify(env));
	}
	// A query value is a reference too; a fragment and a user name are refused.
	assert.match(problemOf(http({ url: "https://h/mcp?api_key=sk-live-123" })), /query value "api_key" must be exactly/);
	assert.match(problemOf(http({ url: "https://h/mcp?v=2" })), /query value "v"/);
	assert.match(problemOf(http({ url: "https://h/mcp?flag" })), /query value "flag"/);
	assert.match(problemOf(http({ url: "https://h/mcp#k=1" })), /fragment/);
	// A credential goes where servers put one, as a reference: the url's path and query, an argument.
	const placed = parseOverlayMcp(doc({
		zap: http({ url: "https://actions.zapier.com/mcp/${ZAP_KEY}/sse" }),
		q: http({ url: "https://h/mcp?api_key=${API_KEY}&v=${API_VERSION}" }),
		cli: stdio({ args: ["--max-tokens", "4096", "--token=${T}", "--header", "Authorization: Bearer ${T}", "cost$"] }),
	}));
	assert.deepEqual(placed.refused, []);
	assert.deepEqual(placed.servers.zap.refs, ["ZAP_KEY"]);
	assert.deepEqual(placed.servers.q.refs, ["API_KEY", "API_VERSION"]);
	assert.deepEqual(placed.servers.cli.refs, ["T"]);
});

test("parseOverlayMcp: references are whole, never in a host or a command; no `~` that pi would expand", () => {
	assert.match(problemOf(http({ url: "https://${HOST}/mcp" })), /reference in its host/);
	assert.match(problemOf(http({ url: "https://h.${ZONE}.example/mcp" })), /reference in its host/);
	assert.match(problemOf(http({ url: "https://h/${a}" })), /not a whole/);
	assert.match(problemOf(http({ url: "https://h/${A" })), /not a whole/);
	// The parser also starts a host after one slash, a backslash or a tab: the host is read from the parse, twice.
	for (const url of ["http:/${X}/", "https:/${X}/p", "https:///;${B}x", "https:/\\${X}/", "https:\\/${X}/", "https:/\t/${X}/", " https:/${X}/"]) {
		assert.match(problemOf(http({ url })), /reference in its host/, JSON.stringify(url));
	}
	// One spelling: the url as the parser writes it back.
	for (const url of ["https://H/mcp", "https://h:443/mcp", "https:h/${X}", "HTTPS://h/mcp"]) assert.match(problemOf(http({ url })), /plain form/, url);
	assert.match(problemOf(http({ url: "https://h ?a=${A}" })), /not a URL/);
	for (const url of ["https://h", "https://h/", "https://h:8443/mcp", "https://[::1]:8080/m"]) assert.equal(problemOf(http({ url })), null, url);
	assert.match(problemOf(stdio({ command: "${BIN}" })), /holds a `\$`/);
	assert.match(problemOf(stdio({ args: ["--root", "${dir}"] })), /not a whole/);
	assert.match(problemOf(stdio({ args: ["!x"] })), /starts with `!`/);
	assert.match(problemOf(stdio({ args: ["~/x"] })), /`~`/);
	assert.match(problemOf(stdio({ command: "~" })), /`~`/);
	assert.match(problemOf(stdio({ command: "~/bin/s" })), /`~`/);
});

test("parseOverlayMcp: header and env names", () => {
	for (const header of ["Bad Name", "", "Authorizatıon", "X:Y", "__proto__", "constructor"]) {
		assert.match(problemOf(http({ headers: { [header]: "${A}" } })), /not a valid HTTP header name/, JSON.stringify(header));
	}
	for (const key of ["BAD-NAME", "__proto__", "constructor", "1X"]) {
		assert.match(problemOf(stdio({ env: { [key]: "${A}" } })), /not a variable name/, key);
	}
});

test("parseOverlayMcp: auth, oauth, cwd and sse are refused with a reason", () => {
	assert.match(problemOf(http({ auth: { provider: "github" } })), /`auth` is not accepted/);
	assert.match(problemOf(http({ oauth: { clientId: "x" } })), /`oauth` is not accepted/);
	assert.match(problemOf(stdio({ cwd: "/srv" })), /`cwd` is not accepted/);
	assert.match(problemOf(http({ type: "sse" })), /SSE/);
});

test("parseOverlayMcp: keys are strict, per transport", () => {
	assert.match(problemOf(http({ command: "/bin/x" })), /exactly one of/);
	assert.match(problemOf({ description: "x" }), /exactly one of/);
	assert.match(problemOf(http({ env: {} })), /"env" is not a key/);
	assert.match(problemOf(stdio({ headers: {} })), /"headers" is not a key/);
	assert.match(problemOf(http({ inheritEnv: false })), /"inheritEnv" is not a key/);
	assert.match(problemOf(http({ type: "stdio" })), /does not match/);
	assert.match(problemOf(stdio({ type: "http" })), /does not match/);
	assert.equal(problemOf(http({ type: "streamable-http" })), null);
	assert.match(problemOf(http({ type: "websocket" })), /`type` must be/);
});

test("parseOverlayMcp: description, exposure, timeout and enabled", () => {
	assert.match(problemOf(http({ description: undefined })), /`description` is required/);
	assert.match(problemOf(http({ description: "  " })), /`description` is required/);
	assert.match(problemOf(http({ description: "a\nb" })), /one line/);
	assert.match(problemOf(http({ description: "x".repeat(301) })), /one line/);
	for (const c of ["\u2028", "\u0085", "\u202e", "\u200b", "\t"]) assert.match(problemOf(http({ description: `a${c}b` })), /one line/, JSON.stringify(c));
	assert.match(problemOf(http({ exposure: "codemode-deferred" })), /`exposure` must be/);
	assert.match(problemOf(http({ toolExposure: { a: "visible" } })), /toolExposure/);
	assert.match(problemOf(http({ toolExposure: ["a"] })), /toolExposure/);
	assert.match(problemOf(http({ timeout: 0 })), /timeout/);
	assert.match(problemOf(http({ timeout: 1.5 })), /timeout/);
	assert.match(problemOf(http({ timeout: 601 })), /timeout/);
	assert.match(problemOf(http({ enabled: "yes" })), /enabled/);
});

test("parseOverlayMcp: names", () => {
	assert.match(problemOf(http(), "Docs"), /lowercase/);
	assert.match(problemOf(http(), "my_docs"), /lowercase/);
	assert.match(problemOf(http(), "-docs"), /lowercase/);
	assert.match(problemOf(http(), "a".repeat(33)), /lowercase/);
	// A homoglyph is not a letter here.
	assert.match(problemOf(http(), "dоcs"), /lowercase/);
	for (const name of ["dispatch-tools", "my-pi-dispatch", "pidispatch", "my-dispatch"]) assert.match(problemOf(http(), name), /reserved/, name);
	assert.equal(problemOf(http(), "docs-2"), null);
});

test("parseOverlayMcp: URLs", () => {
	assert.match(problemOf(http({ url: "ftp://h/x" })), /http or https/);
	assert.match(problemOf(http({ url: "not a url" })), /not a URL/);
	assert.match(problemOf(http({ url: "https://user:pw@h/mcp" })), /user name or password/);
	assert.match(problemOf(http({ url: "https://user@h/mcp" })), /user name or password/);
	assert.equal(problemOf(http({ url: "http://192.168.1.5:8080/mcp" })), null);
});

test("parseOverlayMcp: stdio commands", () => {
	assert.match(problemOf(stdio({ command: "bin/server" })), /absolute path or a bare name/);
	assert.match(problemOf(stdio({ command: "./server" })), /absolute path or a bare name/);
	for (const path of ["/workspace/server", "/job/x", "/tmp/s", "/home/pi/s", "/opt/../workspace/s", "/var/tmp/s", "/dev/shm/s", "/workspaces/server", "/usr", "//workspace/x", "/usrx/s"]) {
		assert.match(problemOf(stdio({ command: path })), /must sit under/, path);
	}
	for (const path of ["/opt/pi-global/mcp/server", "/usr/local/bin/s", "/app/bin/s", "/bin/s", "/opt/./x/../y/s"]) assert.equal(problemOf(stdio({ command: path })), null, path);
	assert.equal(problemOf(stdio({ command: "mcp-fs" })), null);
	for (const runner of MCP_PACKAGE_RUNNERS) {
		assert.match(problemOf(stdio({ command: runner })), /package registry/, runner);
		assert.match(problemOf(stdio({ command: `/usr/bin/${runner}` })), /package registry/, runner);
	}
	const allowed = parseOverlayMcp(doc({ s: stdio({ command: "npx", args: ["-y", "pkg@1.2.3"], allowPackageRunner: true }) }));
	assert.equal(allowed.servers.s.packageRunner, true);
	assert.equal("allowPackageRunner" in piEntry(allowed.servers.s), false, "never reaches pi");
	assert.match(problemOf(stdio({ allowPackageRunner: "yes" })), /allowPackageRunner/);
	assert.match(problemOf(stdio({ args: "--x" })), /list of strings/);
	assert.match(problemOf(stdio({ env: { "BAD-NAME": "x" } })), /not a variable name/);
});

test("parseOverlayMcp: a file that cannot be read whole is refused whole", () => {
	assert.throws(() => parseOverlayMcp("{"), /not valid JSON/);
	// The parser's own message quotes the text around the error, which can be a header's value: never shown.
	assert.throws(() => parseOverlayMcp('{"mcpServers":{"a":{"headers":{"Authorization": Bearer sk-live-secret}}}}'), (error) => error.message === "mcp.json: not valid JSON");
	assert.throws(() => parseOverlayMcp("[]"), /expected an object/);
	assert.throws(() => parseOverlayMcp('{"mcpServers":[]}'), /must be an object/);
	assert.throws(() => parseOverlayMcp('{"servers":{}}'), /"servers" is not a top-level key/);
	assert.throws(() => parseOverlayMcp('{"autoEnableCodemode":"no"}'), /autoEnableCodemode/);
	const dup = '{"mcpServers":{"a":{"url":"https://safe/mcp","description":"x"},"a":{"url":"https://evil/mcp","description":"x"}}}';
	assert.throws(() => parseOverlayMcp(dup), (error) => error.mcpConfig === true && /mcpServers\.a/.test(error.message) && /appears twice/.test(error.message));
	assert.throws(() => parseOverlayMcp('{"mcpServers":{"a":{"url":"https://h/m","description":"x","headers":{"X":"1","X":"2"}}}}'), /appears twice/);
});

test("overlayMcpText: the accepted servers only, in pi's shape, and it parses back to the same", () => {
	const parsed = parseOverlayMcp(
		doc({
			docs: http({ headers: { Authorization: "Bearer ${T}" } }),
			fs: stdio({ command: "uvx", args: ["mcp-fs==1.0"], allowPackageRunner: true }),
			bad: http({ headers: { Authorization: "Bearer literal" } }),
		}),
		"/host/mcp.json",
	);
	assert.deepEqual(parsed.refused.map((r) => r.name), ["bad"]);
	const text = overlayMcpText(parsed);
	assert.doesNotMatch(text, /literal/);
	const again = parseOverlayMcp(text);
	assert.deepEqual(again.servers, parsed.servers);
	assert.deepEqual(again.refused, []);
	assert.deepEqual(JSON.parse(text).mcpServers.docs.type, "http");
	assert.equal(JSON.parse(overlayMcpText(parseOverlayMcp(doc({}, { autoEnableCodemode: false })))).autoEnableCodemode, false);
});

test("readOverlayMcp: absent is null; a link, a non-file and an oversized file are refused; the rest parses", () => {
	const dir = tempDir("pi-dispatch-mcp-overlay-");
	assert.equal(readOverlayMcp(dir), null);
	assert.equal(readOverlayMcp(""), null);
	assert.equal(readOverlayMcp(join(dir, "missing")), null);
	writeFileSync(join(dir, "real.json"), doc({ docs: http() }));
	symlinkSync(join(dir, "real.json"), join(dir, "mcp.json"));
	assert.throws(() => readOverlayMcp(dir), (error) => error.mcpConfig === true && /is a link/.test(error.message));
	const folder = tempDir("pi-dispatch-mcp-overlay-");
	mkdirSync(join(folder, "mcp.json"));
	assert.throws(() => readOverlayMcp(folder), /not a regular file/);
	const big = tempDir("pi-dispatch-mcp-overlay-");
	writeFileSync(join(big, "mcp.json"), " ".repeat(MCP_CONFIG_MAX_BYTES + 1));
	assert.throws(() => readOverlayMcp(big), /larger than/);
	const ok = tempDir("pi-dispatch-mcp-overlay-");
	writeFileSync(join(ok, "mcp.json"), doc({ docs: http() }));
	assert.deepEqual(Object.keys(readOverlayMcp(ok).servers), ["docs"]);
	// Any other errno is rethrown with its code, never read as absence.
	const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
	assert.throws(() => readOverlayMcp(ok, { lstatSync: () => { throw eacces; } }), (error) => error.code === "EACCES");
	// A FIFO is judged from lstat and never opened.
	assert.throws(() => readOverlayMcp(ok, { lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => false, size: 0 }), readFileSync: () => assert.fail("never opened") }), /not a regular file/);
});

test("a server name is words joined by single -, so no two servers' tool names can read alike in pi's namespace", () => {
	for (const name of ["a", "docs", "a-b", "files-2", "a".repeat(32)]) assert.ok(MCP_SERVER_NAME_RE.test(name), name);
	for (const name of ["a-", "-a", "a--b", "", "a".repeat(33), "A", "a_b"]) assert.equal(MCP_SERVER_NAME_RE.test(name), false, name);
});
