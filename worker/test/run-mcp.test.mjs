import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_SERVERS_MAX, parseTriggers } from "../src/triggers.mjs";

/**
 * `run.mcp` at the loader (REQ-MCP-OPERATOR-SERVERS): names of overlay MCP servers, validated for shape only (the
 * loader is fs-free; the pickup asks the overlay). The hazard is the silent half, as for excludeTools: a dropped or
 * misspelled field runs the job without the servers its flow was written against.
 */
const parse = (entries) => parseTriggers(JSON.stringify({ triggers: entries }), "/x/triggers.json");
const KINDS = [
	["cron", (run = {}, on = {}) => ({ on: { type: "cron", id: "n", pattern: "0 3 * * *", ...on }, run: { kind: "local", folder: "/p", flow: "f", task: "t", ...run } })],
	["label", (run = {}, on = {}) => ({ on: { type: "label", any: ["pi"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["comment", (run = {}, on = {}) => ({ on: { type: "comment", phrase: "@pi", ...on }, run: { kind: "github", flow: "f", ...run } })],
	["issue", (run = {}, on = {}) => ({ on: { type: "issue", action: ["closed"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["pull_request", (run = {}, on = {}) => ({ on: { type: "pull_request", action: ["opened"], ...on }, run: { kind: "github", flow: "f", ...run } })],
];
const refuses = (entry, pattern) => assert.throws(() => parse([entry]), (e) => e.piDispatchConfig === true && pattern.test(e.message));

test("run.mcp is absent unless written, and survives normalization as a fresh array, on all five kinds", () => {
	for (const [kind, make] of KINDS) {
		assert.equal("mcp" in parse([make()])[0].run, false, kind);
		const wrote = ["docs", "files-2"];
		const [t] = parse([make({ mcp: wrote })]);
		assert.deepEqual(t.run.mcp, ["docs", "files-2"], kind);
		assert.notEqual(t.run.mcp, wrote, kind);
	}
});

test("run.mcp refuses a value that is not a list of server names, on all five kinds", () => {
	for (const [kind, make] of KINDS) {
		for (const bad of ["docs", [], {}, [1], [""], ["Docs"], ["my_docs"], ["a".repeat(33)], [null], true]) {
			refuses(make({ mcp: bad }), /run\.mcp/);
		}
		refuses(make({ mcp: ["docs", "docs"] }), /twice/);
		refuses(make({ mcp: Array.from({ length: MCP_SERVERS_MAX + 1 }, (_, i) => `s${i}`) }), /more than 8/);
		assert.equal(parse([make({ mcp: Array.from({ length: MCP_SERVERS_MAX }, (_, i) => `s${i}`) })])[0].run.mcp.length, MCP_SERVERS_MAX, kind);
	}
});

test("a near-miss spelling of run.mcp, and on.mcp, are refused rather than dropped", () => {
	for (const [, make] of KINDS) {
		for (const key of ["mcpServers", "MCP", "mcp_servers", "mcps", "mcpServer", "Mcp-Servers"]) refuses(make({ [key]: ["docs"] }), /did you mean run\.mcp/);
		refuses(make({}, { mcp: ["docs"] }), /on\.mcp is not a field/);
		// A key outside plain ASCII whose plain letters are only the field's: lookalikes in every script (Cyrillic, Greek
		// capital Mu, Cherokee, small capitals, IPA, Armenian, fullwidth, circled, mathematical, Roman numeral, accents),
		// and zero-width and no-break padding.
		for (const key of ["m\u0441p", "m\u0441\u0440", "\u041ccp", "\u039ccp", "\u039cC\u03a1", "\u13b7\u13df\u13e2", "\u1d0d\u1d04\u1d18", "\u0271cp", "\u0574cp", "m\u03f2p", "mc\u1d18", "\uff4dcp", "\u24dc\u24d2\u24df", "\u{1d5c6}\u{1d5bc}\u{1d5c9}", "\u217fcp", "m\u200bcp", "mcp\u00a0", "mc\u1e55", "m\u00e8s", "\u043c\u0421\u0420"]) {
			refuses(make({ [key]: ["docs"] }), /plain ASCII/);
			refuses(make({}, { [key]: ["docs"] }), /plain ASCII/);
		}
	}
	// An unrelated key is not swept: an ASCII one unless it reads as the field, a non-ASCII one holding other letters.
	for (const key of ["mcpish", "mcpx", "mcpTimeout", "rmcp", "m", "mp", "ms", "mpc", "f\u00f6\u00f6", "fl\u00f6w", "notiz\u00e9n"]) {
		assert.equal(parse([KINDS[1][1]({ [key]: 1 })]).length, 1, key);
	}
});

test("run.excludeTools names the job's MCP tools only beside run.mcp: codemode, tool_search, the resource tools, and one server's tools as a whole", () => {
	for (const [kind, make] of KINDS) {
		const [t] = parse([make({ mcp: ["docs", "my-files"], excludeTools: ["codemode", "tool_search", "read_mcp_resource", "mcp__my_files__*", "bash"] })]);
		assert.deepEqual(t.run.excludeTools, ["codemode", "tool_search", "read_mcp_resource", "mcp__my_files__*", "bash"], kind);
		refuses(make({ excludeTools: ["codemode"] }), /excludable only by a trigger whose run\.mcp names its server/);
		refuses(make({ mcp: ["docs"], excludeTools: ["mcp__other__*"] }), /not a tool the pinned pi knows/);
		refuses(make({ mcp: ["docs"], excludeTools: ["mcp__docs__search"] }), /a server's tools only all at once/);
		refuses(make({ mcp: ["my-files"], excludeTools: ["mcp__my-files__*"] }), /not a tool the pinned pi knows/);
	}
});

test("run.mcp may name `forge`, the job's own forge server (DES-FORGE-MCP), on a github or gitlab trigger of every type, and on no other kind", () => {
	for (const [type, make] of KINDS.slice(1)) {
		for (const kind of ["github", "gitlab"]) {
			const entry = make({ kind, mcp: ["forge", "docs"] });
			if (kind === "gitlab" && type === "pull_request") entry.on.action = ["open"];
			if (kind === "gitlab" && type === "issue") entry.on.action = ["close"];
			assert.deepEqual(parse([entry])[0].run.mcp, ["forge", "docs"], `${kind} ${type}`);
		}
	}
	refuses(KINDS[0][1]({ mcp: ["forge"] }), /run\.mcp names "forge".*a github or gitlab trigger may name and this one may not: a cron job holds no forge token of its own/);
	refuses(KINDS[0][1]({ mcp: ["docs", "forge"] }), /no forge token/);
	refuses({ on: { type: "label", any: ["pi"] }, run: { kind: "forgejo", flow: "f", mcp: ["forge"] } }, /run\.mcp names "forge".*forgejo has no forge MCP server this deployment has verified yet/);
	refuses({ on: { type: "pull_request", action: ["created"] }, run: { kind: "azure", flow: "f", mcp: ["forge"] } }, /run\.mcp names "forge".*azure has no forge MCP server this deployment has verified yet/);
	// Only the exact name: an overlay server named like it is the overlay's, on any kind.
	assert.deepEqual(parse([KINDS[0][1]({ mcp: ["forges", "my-forge"] })])[0].run.mcp, ["forges", "my-forge"]);
	assert.deepEqual(parse([{ on: { type: "label", any: ["pi"] }, run: { kind: "forgejo", flow: "f", mcp: ["forge-docs"] } }])[0].run.mcp, ["forge-docs"]);
});
