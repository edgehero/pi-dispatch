import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAllowlist } from "../src/egress-allowlist.mjs";
import { forgeGitHost, forgeGitRules, hostsOfEntry, networkPolicyFor, RUNNER_NODE } from "../src/openshell-policy.mjs";

/**
 * Issue #684: the openshell venue's network policy is generated from the sources the squid venues read. These pin the
 * translation (GOLDEN, so a change to the generated rules is a reviewed change to this file) and every refusal.
 */

const LABEL = ["/usr/local/bin/node", "/usr/bin/git"];
const bins = [RUNNER_NODE, ...LABEL].map((path) => ({ path }));
/** Every rule's single endpoint, by host and port, so a test does not depend on the key's spelling. */
const byHost = (policy) => Object.fromEntries(Object.values(policy.network_policies).map((r) => [`${r.endpoints[0].host}:${r.endpoints[0].port}`, r]));

test("the scaffolded allowlist, a github job: github.com carries the git transport with a push to the job's own repo only", () => {
	const allowlist = parseAllowlist("api.anthropic.com\n.github.com\nregistry.npmjs.org\n");
	const rules = byHost(networkPolicyFor({ allowlist, kind: "github", repo: "acme/widget", binaries: LABEL }));
	assert.deepEqual(Object.keys(rules).sort(), ["*.github.com:443", "api.anthropic.com:443", "github.com:443", "registry.npmjs.org:443"]);
	assert.deepEqual(rules["github.com:443"].endpoints, [{ host: "github.com", port: 443, protocol: "rest", enforcement: "enforce", rules: [
		{ allow: { method: "GET", path: "**" } },
		{ allow: { method: "HEAD", path: "**" } },
		{ allow: { method: "OPTIONS", path: "**" } },
		{ allow: { method: "POST", path: "/**/git-upload-pack" } },
		{ allow: { method: "POST", path: "/**/info/lfs/objects/batch" } },
		{ allow: { method: "POST", path: "/acme/widget.git/git-receive-pack" } },
		{ allow: { method: "POST", path: "/acme/widget/git-receive-pack" } },
	] }]);
	for (const host of ["*.github.com:443", "api.anthropic.com:443", "registry.npmjs.org:443"]) {
		assert.deepEqual(rules[host].endpoints[0], { host: host.split(":")[0], port: 443, protocol: "rest", access: "full", enforcement: "enforce" }, host);
	}
	for (const rule of Object.values(rules)) assert.deepEqual(rule.binaries, bins, "the runner's node first, then the label");
});

test("the runner's node is always first, even when an image's label leaves it out; a bad label entry is skipped and named", () => {
	const skipped = [];
	const policy = networkPolicyFor({ allowlist: ["example.org"], binaries: ["/usr/bin/git", "git", "/usr/*/node", " /usr/bin/gh ", RUNNER_NODE], onSkipped: (w) => skipped.push(w) });
	assert.deepEqual(Object.values(policy.network_policies)[0].binaries, [RUNNER_NODE, "/usr/bin/git", "/usr/bin/gh"].map((path) => ({ path })));
	assert.deepEqual(skipped, [{ binary: "git" }, { binary: "/usr/*/node" }]);
	assert.deepEqual(Object.values(networkPolicyFor({ allowlist: ["example.org"] }).network_policies)[0].binaries, [{ path: RUNNER_NODE }], "no label at all");
});

test("the shipped image's label is what the rules name, its runner first (image/Dockerfile)", () => {
	const dockerfile = readFileSync(new URL("../../image/Dockerfile", import.meta.url), "utf8");
	const label = /^LABEL dev\.pi-dispatch\.net-binaries="([^"]*)"$/m.exec(dockerfile)?.[1]?.split(",");
	assert.ok(label, "the image declares its network binaries");
	const rule = Object.values(networkPolicyFor({ allowlist: ["example.org"], binaries: label }).network_policies)[0];
	assert.equal(rule.binaries[0].path, RUNNER_NODE);
	assert.deepEqual(rule.binaries.map((b) => b.path), [...new Set([RUNNER_NODE, ...label])]);
});

test("every endpoint enforces (OpenShell's default is audit), and model endpoints open exactly their port", () => {
	const rules = byHost(networkPolicyFor({ allowlist: ["example.org"], endpoints: [{ id: "ollama", host: "host.docker.internal", port: 11434 }] }));
	assert.ok(Object.values(rules).every((r) => r.endpoints.every((e) => e.enforcement === "enforce")));
	assert.deepEqual(rules["host.docker.internal:11434"].endpoints, [{ host: "host.docker.internal", port: 11434, protocol: "rest", access: "full", enforcement: "enforce" }]);
});

test("only GitHub's web host is narrowed: GitLab, Forgejo and Azure share their API with git, so their host keeps full access", () => {
	assert.equal(forgeGitHost("github"), "github.com");
	for (const kind of ["gitlab", "forgejo", "azure", "local"]) assert.equal(forgeGitHost(kind), null, kind);
	const gl = byHost(networkPolicyFor({ allowlist: ["git.example.com", "gitlab.com"], kind: "gitlab", repo: "group/sub/project" }));
	assert.equal(gl["git.example.com:443"].endpoints[0].access, "full");
	assert.equal(gl["gitlab.com:443"].endpoints[0].access, "full");
	assert.equal(gl["git.example.com:443"].endpoints[0].rules, undefined);
	// A GitHub job whose allowlist does not admit github.com gets no rule for it, and no push.
	assert.deepEqual(Object.keys(byHost(networkPolicyFor({ allowlist: ["api.github.com"], kind: "github", repo: "a/b" }))), ["api.github.com:443"]);
});

test("GitHub's own name rules: dot and underscore names push, a dot segment or a glob is refused", () => {
	for (const repo of ["acme/.github", "acme/_infra", "acme/-x", "Acme/Widget.js"]) assert.ok(forgeGitRules(repo).rules, repo);
	for (const repo of ["a/..", "./b", "a/*", "a/b/c", "noslash", "", "a/b c"]) assert.equal(forgeGitRules(repo).refused, "repo-not-a-path", repo);
	assert.equal(networkPolicyFor({ allowlist: ["github.com"], kind: "github", repo: "a/*" }).refused, "repo-not-a-path");
});

test("what would widen is refused; what squid matches nothing for is skipped and named", () => {
	assert.deepEqual(hostsOfEntry(".com"), { refused: "wildcard-too-wide", entry: ".com" });
	assert.deepEqual(hostsOfEntry(".github.com"), { hosts: ["github.com", "*.github.com"] });
	for (const line of ["github.com.", "host:443", "foo#bar", "[::1]", "exa mple.com"]) assert.deepEqual(hostsOfEntry(line), { hosts: [], skipped: line.toLowerCase() }, line);
	assert.equal(networkPolicyFor({ allowlist: [".com"] }).refused, "wildcard-too-wide");
	const skipped = [];
	assert.deepEqual(networkPolicyFor({ allowlist: ["github.com.", "example.org"], onSkipped: (w) => skipped.push(w) }).network_policies && skipped, [{ entry: "github.com." }]);
	assert.equal(networkPolicyFor({ endpoints: [{ host: "localhost", port: 11434 }] }).refused, "endpoint-loopback");
	assert.equal(networkPolicyFor({ endpoints: [{ host: "x.example", port: 0 }] }).refused, "endpoint-not-a-host-port");
});

test("hosts that sanitise alike keep their own rules", () => {
	const keys = Object.keys(networkPolicyFor({ allowlist: ["a-b.com", "a.b.com", ".x.y", "any.x.y"] }).network_policies);
	assert.equal(new Set(keys).size, keys.length);
	assert.deepEqual(Object.keys(byHost(networkPolicyFor({ allowlist: ["a-b.com", "a.b.com", ".x.y", "any.x.y"] }))).sort(), ["*.x.y:443", "a-b.com:443", "a.b.com:443", "any.x.y:443", "x.y:443"]);
});

test("no source, no rule: the policy is deny-all", () => {
	assert.deepEqual(networkPolicyFor({}), { network_policies: {} });
});
