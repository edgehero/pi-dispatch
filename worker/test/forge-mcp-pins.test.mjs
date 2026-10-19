import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAPABILITY_GATES } from "../src/image-preflight.mjs";
import { GITHUB_MCP_COMMAND, GITLAB_MCP_COMMAND, forgeMcpServer } from "../src/mcp-config.mjs";

/**
 * The forge's own MCP servers (DES-FORGE-MCP) as the job image bakes them. The worker writes an entry naming a command
 * path and a set of environment names; the image must carry exactly that program at exactly the version those names
 * were read against (github-mcp-server 2.0.2's cmd/github-mcp-server/main.go, @zereight/mcp-gitlab 2.1.67's
 * build/config.js). A pin that moves without the entry being re-read is how a server quietly stops honouring
 * GITHUB_LOCKDOWN_MODE or starts asking a registry for a newer release, so every pin is held here, not trusted.
 */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const dockerfile = read("image/Dockerfile");
const arg = (name) => new RegExp(`^ARG ${name}=(\\S*)$`, "m").exec(dockerfile)?.[1];
const GITLAB_DIR = "image/forge-mcp/gitlab";

test("github-mcp-server: exactly 2.0.2, from GitHub's release tarball, checked against both architectures' sha256", () => {
	// The digests GitHub publishes for the two Linux assets of the v2.0.2 release (github-mcp-server_Linux_x86_64.tar.gz
	// and github-mcp-server_Linux_arm64.tar.gz). Moving the version means re-reading the entry against the new source.
	assert.equal(arg("GITHUB_MCP_SERVER_VERSION"), "2.0.2");
	assert.equal(arg("GITHUB_MCP_SERVER_SHA256_AMD64"), "815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0");
	assert.equal(arg("GITHUB_MCP_SERVER_SHA256_ARM64"), "73f5e76c6a3b5e0d731e1134a7c38575df6ec96c646192095a3be2d4d0d6c1fc");
	const run = dockerfile.slice(dockerfile.indexOf("ARG GITHUB_MCP_SERVER_SHA256_ARM64"), dockerfile.indexOf("@zereight/mcp-gitlab for a gitlab job"));
	assert.match(run, /amd64\) asset=x86_64; sha="\$GITHUB_MCP_SERVER_SHA256_AMD64" ;;/);
	assert.match(run, /arm64\) asset=arm64; sha="\$GITHUB_MCP_SERVER_SHA256_ARM64" ;;/);
	assert.match(run, /\*\) echo "github-mcp-server: unsupported architecture \$arch" >&2; exit 1 ;;/, "an unknown architecture fails the build, never downloads unchecked");
	assert.ok(run.includes('"https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_SERVER_VERSION}/github-mcp-server_Linux_${asset}.tar.gz"'));
	assert.ok(run.includes('echo "${sha}  /tmp/github-mcp-server.tgz" | sha256sum -c -;'), "the download is checked before it is unpacked");
	assert.ok(run.indexOf("sha256sum -c") < run.indexOf("tar -xzf"));
	assert.ok(run.includes("install -m 0755 /tmp/github-mcp-server/github-mcp-server /usr/local/bin/github-mcp-server;"), "installed where its wrapper runs it");
	assert.ok(run.includes('github-mcp-server --version | grep -qxF "Version: ${GITHUB_MCP_SERVER_VERSION}"'), "a binary without the release stamp fails the build");
});

test("mcp-gitlab: exactly 2.1.67, from a committed lockfile of registry packages with integrity and no install script, outside the workspaces", () => {
	const pkg = JSON.parse(read(`${GITLAB_DIR}/package.json`));
	assert.deepEqual(pkg.dependencies, { "@zereight/mcp-gitlab": "2.1.67" }, "one dependency, an exact version");
	assert.equal(pkg.private, true);
	const lock = JSON.parse(read(`${GITLAB_DIR}/package-lock.json`));
	assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies, "the lockfile was generated from this package.json");
	assert.equal(lock.packages["node_modules/@zereight/mcp-gitlab"].version, "2.1.67");
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "") continue;
		assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${path} comes from the npm registry`);
		assert.match(entry.integrity ?? "", /^sha512-/, `${path} carries an integrity hash`);
		assert.notEqual(entry.hasInstallScript, true, `${path} declares no install script`);
	}
	const root = JSON.parse(read("package.json"));
	assert.ok(root.workspaces.every((w) => !w.startsWith("image/forge-mcp")), "not a workspace: a pi bump must not re-resolve the server's tree");
	assert.ok(dockerfile.includes(`COPY ${GITLAB_DIR}/package.json ${GITLAB_DIR}/package-lock.json /opt/forge-mcp/gitlab/`));
	assert.ok(dockerfile.includes("&& npm ci --omit=dev --ignore-scripts --no-audit --no-fund"), "npm ci, so the lockfile is the install, and no script runs");
	assert.ok(dockerfile.includes(`test "$(node -p 'require("./node_modules/@zereight/mcp-gitlab/package.json").version')" = "${pkg.dependencies["@zereight/mcp-gitlab"]}"`), "the build checks the version it installed against the pin");
	assert.match(read(".dockerignore"), /image\/forge-mcp\/gitlab/, "the build context keeps the folder, and the ignore file says why");
});

test("the worker's forge entries run the image's withholding wrappers, never a server itself; the label declares every capability gate", () => {
	assert.equal(forgeMcpServer("github").command, "/usr/local/bin/forge-mcp-github");
	assert.equal(forgeMcpServer("gitlab").command, "/usr/local/bin/forge-mcp-gitlab");
	assert.equal(forgeMcpServer("github").command, GITHUB_MCP_COMMAND);
	assert.equal(forgeMcpServer("gitlab").command, GITLAB_MCP_COMMAND);
	assert.equal(forgeMcpServer("github").args, undefined, "the wrapper takes no arguments of the entry's");
	assert.ok(dockerfile.includes("COPY image/forge-mcp/withhold.mjs /opt/forge-mcp/withhold.mjs"));
	assert.ok(dockerfile.includes(`COPY image/forge-mcp/forge-mcp-github.sh ${GITHUB_MCP_COMMAND}`));
	assert.ok(dockerfile.includes(`COPY image/forge-mcp/forge-mcp-gitlab.sh ${GITLAB_MCP_COMMAND}`));
	assert.ok(dockerfile.includes(`chmod 0755 ${GITHUB_MCP_COMMAND} ${GITLAB_MCP_COMMAND}`));
	const label = /^LABEL dev\.pi-dispatch\.capabilities="([^"]*)"$/m.exec(dockerfile)?.[1]?.split(",");
	assert.ok(label, "the Dockerfile still declares its capabilities");
	for (const gate of CAPABILITY_GATES) assert.ok(label.includes(gate.token), `this repository's image declares ${gate.token}`);
	assert.match(read("image/verify-image.sh"), /\n\t\t\tforgeMcp\)\n/, "and the conformance script proves the claim");
});

// --- the withheld merge and approval tools (CONST-MERGE-NEVER-AUTOMATIC) ---

/** The wrapper's withheld list, and the lines that set and use it. */
function wrapper(name) {
	const text = read(`image/forge-mcp/${name}`);
	const list = /^WITHHELD="([^"]*)"$/m.exec(text)?.[1];
	assert.ok(list, `${name} declares its withheld list`);
	return { text, list, names: list.split(",") };
}

test("forge-mcp-github withholds its merge and approval tools and the two that start Copilot, three ways, ignoring its caller's arguments", () => {
	const { text, list, names } = wrapper("forge-mcp-github.sh");
	// merge_pull_request merges; pull_request_review_write can submit an APPROVE; the Copilot two spend off the meter.
	assert.deepEqual(names, ["merge_pull_request", "pull_request_review_write", "assign_copilot_to_issue", "request_copilot_review"]);
	// Exported AFTER the entry's env reached the process, so no entry can clear them; the server's own exclusion by env
	// and by flag, and withhold.mjs over the top.
	assert.ok(text.includes('export GITHUB_EXCLUDE_TOOLS="$WITHHELD"'));
	assert.ok(text.includes('export GITHUB_TOOLSETS="default"'), "the actions toolset stays off whatever the entry says");
	assert.ok(text.trimEnd().endsWith('exec /usr/local/bin/node /opt/forge-mcp/withhold.mjs "$WITHHELD" -- /usr/local/bin/github-mcp-server stdio --exclude-tools="$WITHHELD"'));
	assert.doesNotMatch(text, /"\$@"|\$\*/, "the caller's arguments never reach the server");
	assert.match(list, /^[a-z_,]+$/);
});

test("forge-mcp-gitlab withholds its merge and approval tools, discover_tools and execute_graphql, through withhold.mjs", () => {
	const { text, names } = wrapper("forge-mcp-gitlab.sh");
	assert.deepEqual(names, ["merge_merge_request", "approve_merge_request", "unapprove_merge_request", "approve_deployment", "discover_tools", "execute_graphql"]);
	assert.ok(text.includes('export GITLAB_TOOL_POLICY_HIDDEN="$WITHHELD"'));
	assert.ok(text.includes("unset GITLAB_TOOLSETS GITLAB_TOOLS"), "the default toolsets stay whatever the entry says");
	assert.ok(text.trimEnd().endsWith('exec /usr/local/bin/node /opt/forge-mcp/withhold.mjs "$WITHHELD" -- /usr/local/bin/node /opt/forge-mcp/gitlab/node_modules/@zereight/mcp-gitlab/build/index.js'));
	assert.doesNotMatch(text, /"\$@"|\$\*/);
});

test("verify-image.sh proves the withholding with the wrappers' own lists and a list of the other names that mention a merge request", () => {
	const script = read("image/verify-image.sh");
	for (const name of ["forge-mcp-github.sh", "forge-mcp-gitlab.sh"]) {
		const { list } = wrapper(name);
		assert.ok(script.includes(list), `verify-image.sh asks for ${name}'s list`);
	}
	assert.ok(script.includes("/merge|approv/i.test(name)"), "the probe flags every name that mentions a merge or an approval");
	assert.ok(script.includes("withheld.includes(name) || (/merge|approv/i.test(name) && !allowed.has(name))"));
	assert.ok(script.includes("if (!/unknown tool/i.test(message.error?.message ?? \"\"))"), "a call counts as refused only when refused as unknown, not failed on its arguments");
	assert.ok(script.includes('const calls = [...withheld, "execute_graphql", "never_listed_tool"];'));
});

test("the wrappers and verify-image.sh claim no boundary: the withheld tools are a convenience not handed out, and the token's role is the boundary", () => {
	for (const name of ["forge-mcp-github.sh", "forge-mcp-gitlab.sh"]) assert.match(wrapper(name).text, /is not a boundary/, name);
	assert.match(wrapper("forge-mcp-gitlab.sh").text, /quick actions/);
	assert.match(read("image/verify-image.sh"), /it is not a boundary/);
	assert.doesNotMatch(read("image/verify-image.sh"), /never merge or approve/);
});

test("docs/job-image.md lists exactly the capabilities the image declares, and verify-image.sh proves each (#683)", () => {
	// The page restates the label by hand; pinned here so a new token cannot ship undocumented, or a doc row outlive one.
	const label = /^LABEL dev\.pi-dispatch\.capabilities="([^"]*)"$/m.exec(dockerfile)?.[1]?.split(",");
	const row = read("docs/job-image.md").split("\n").find((l) => l.startsWith("| Label `dev.pi-dispatch.capabilities`"));
	assert.ok(row, "the capabilities row is in docs/job-image.md");
	const listed = /the optional features it honours \(([^)]*)\)/.exec(row)?.[1].split(",").map((t) => t.trim().replace(/`/g, ""));
	assert.deepEqual(listed, label);
	const script = read("image/verify-image.sh");
	for (const token of label) assert.match(script, new RegExp(`\n\t\t\t${token}\\)\n`), `verify-image.sh has a ${token}) case`);
});

test("the network-binaries label names the binary the runner and pi run as, and every forge MCP server (#683)", () => {
	// The per-binary egress policy (#684) is generated from this label, so a binary missing here loses the network.
	const label = /^LABEL dev\.pi-dispatch\.net-binaries="([^"]*)"$/m.exec(dockerfile)?.[1]?.split(",");
	assert.ok(label, "the Dockerfile declares its network binaries");
	assert.equal(label[0], "/opt/pi-dispatch/runner-node", "the exec-only node every provider call leaves through");
	assert.ok(dockerfile.includes("RUN install -o root -g root -m 0711 /usr/local/bin/node /opt/pi-dispatch/runner-node"));
	for (const bin of ["/usr/local/bin/node", "/usr/bin/git", "/usr/lib/git-core/git-remote-http", "/usr/bin/gh", "/usr/local/bin/glab", "/usr/local/bin/tea", "/usr/local/bin/github-mcp-server"]) {
		assert.ok(label.includes(bin), bin);
	}
	assert.equal(new Set(label).size, label.length, "no entry twice");
});
