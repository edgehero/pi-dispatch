import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rebuildLoaded } from "../../../worker/src/loaded-record.mjs";
import { makeLogSink } from "../../../worker/src/run-history.mjs";
import { EXCLUDABLE_TOOL_NAMES } from "../../../worker/src/triggers.mjs";
import { chatServer, jobTree, put, runRealJob } from "./helpers/real-job.mjs";

/**
 * Issue #800, end to end: the real run-job.mjs and the real pi, with its mounts moved under a temp directory. `PI_EXCLUDE_EXTENSIONS`
 * has to act before a module is imported, which only a real load can show, and what a tool name matched is read off the extensions pi loaded.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`a job's load exclusions are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

const KEY = "0123456789abcdef".repeat(4);
const STRICT = "1";
const registration = (name) => `pi.registerTool({ name: ${JSON.stringify(name)}, label: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });`;
/** An extension whose module and factory each leave a mark where the test can read it, and whose tools are `tools`. */
const marked = (mark, tools = []) => `import { appendFileSync } from "node:fs";
appendFileSync(process.env.MARKS, "module:${mark}\\n");
export default function (pi) {
	appendFileSync(process.env.MARKS, "factory:${mark}\\n");
	${tools.map(registration).join("\n\t")}
}
`;
const marksOf = (root) => {
	const path = join(root, "tmp", "marks");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};
const run = (root, env = {}) => runRealJob(root, { MARKS: join(root, "tmp", "marks"), ...env }, { key: KEY });

function overlay(root) {
	put(root, "/opt/pi-global/extensions/gone.js", marked("gone", ["gone_tool"]));
	put(root, "/opt/pi-global/extensions/guard.ts", marked("guard", ["guard_check"]));
	put(root, "/opt/pi-global/extensions/folder/index.js", marked("folder", ["folder_tool"]));
}

test("an excluded overlay extension never runs: not its module, not its factory, whichever way its name is spelled", { skip }, async () => {
	const server = await chatServer();
	try {
		const control = jobTree({ base: server.base });
		overlay(control);
		const everything = await run(control);
		assert.equal(everything.exit?.code, 0, everything.stderr);
		assert.deepEqual(marksOf(control).sort(), ["factory:folder", "factory:gone", "factory:guard", "module:folder", "module:gone", "module:guard"], "the premise: each one runs when nothing names it");

		for (const [env, gone, kept] of [
			["gone", ["gone"], ["folder", "guard"]],
			["gone.js", ["gone"], ["folder", "guard"]],
			["guard", ["guard"], ["folder", "gone"]],
			["folder", ["folder"], ["gone", "guard"]],
			["gone,folder", ["gone", "folder"], ["guard"]],
		]) {
			const root = jobTree({ base: server.base });
			overlay(root);
			const { exit, stderr } = await run(root, { PI_EXCLUDE_EXTENSIONS: env });
			assert.equal(exit?.code, 0, stderr);
			const marks = marksOf(root);
			for (const name of gone) assert.ok(!marks.includes(`module:${name}`) && !marks.includes(`factory:${name}`), `${env}: ${name} ran: ${marks}`);
			for (const name of kept) assert.ok(marks.includes(`factory:${name}`), `${env}: ${name} did not run`);
			assert.deepEqual(exit.loaded.overlay.failed, [], "left out is no failure");
			for (const name of exit.loaded.overlay.loaded) assert.ok(!gone.some((left) => name === left || name.startsWith(`${left}.`)), `${env}: the record names ${name} as loaded`);
		}
	} finally {
		await server.close();
	}
});

test("a name that is no overlay entry's leaves the overlay whole, a repository's extension of that name included", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = jobTree({ base: server.base });
		overlay(root);
		put(root, "/workspace/.pi/extensions/repo-ext.js", marked("repo"));
		const { exit, stderr } = await run(root, { PI_EXCLUDE_EXTENSIONS: "@acme/pkg,gon,repo-ext" });
		assert.equal(exit?.code, 0, stderr);
		for (const name of ["gone", "guard", "folder"]) assert.ok(marksOf(root).includes(`factory:${name}`), name);
		assert.ok(marksOf(root).includes("factory:repo"), "run.excludeExtensions reaches the overlay and the stage, and a repository's own extension is not on either");
	} finally {
		await server.close();
	}
});

test("what the docs say a name does not reach: a kept extension's import of an excluded file, and a root manifest's entry outside the folder", { skip }, async () => {
	const server = await chatServer();
	try {
		const imports = jobTree({ base: server.base });
		put(imports, "/opt/pi-global/extensions/gone.js", marked("gone", ["gone_tool"]));
		put(imports, "/opt/pi-global/extensions/keeper.js", `import "./gone.js";\n${marked("keeper")}`);
		const imported = await run(imports, { PI_EXCLUDE_EXTENSIONS: "gone" });
		assert.equal(imported.exit?.code, 0, imported.stderr);
		const marks = marksOf(imports);
		assert.ok(marks.includes("module:gone"), `the name took the entry off the list and stopped no import: ${marks}`);
		assert.ok(!marks.includes("factory:gone"), "and pi never called it as an extension");

		const outside = jobTree({ base: server.base });
		put(outside, "/opt/pi-global/extensions/package.json", JSON.stringify({ pi: { extensions: ["../outside.js"] } }));
		put(outside, "/opt/pi-global/outside.js", marked("outside"));
		const named = await run(outside, { PI_EXCLUDE_EXTENSIONS: "outside,outside.js" });
		assert.equal(named.exit?.code, 0, named.stderr);
		assert.ok(marksOf(outside).includes("factory:outside"), "no name means an entry that climbs out of the folder");
	} finally {
		await server.close();
	}
});

test("a manifest entry the runner would have reported as skipped is no failure when the trigger names it", { skip }, async () => {
	const server = await chatServer();
	const tree = () => {
		const root = jobTree({ base: server.base });
		put(root, "/opt/pi-global/extensions/package.json", JSON.stringify({ pi: { extensions: ["./kept.js", "./as-folder"] } }));
		put(root, "/opt/pi-global/extensions/kept.js", marked("kept"));
		put(root, "/opt/pi-global/extensions/as-folder/index.js", marked("as-folder"));
		return root;
	};
	try {
		const control = await run(tree());
		assert.ok(control.lines.some((line) => line.event === "extension_load_failed"), "the premise: the runner reports a manifest entry naming a folder");
		const { exit, lines, stderr } = await run(tree(), { PI_EXCLUDE_EXTENSIONS: "as-folder" });
		assert.equal(exit?.code, 0, stderr);
		assert.equal(lines.some((line) => line.event === "extension_load_failed"), false, "what the trigger took away did not fail");
		assert.deepEqual(exit.loaded.overlay, { loaded: ["kept.js"], failed: [] });
	} finally {
		await server.close();
	}
});

test("a package the worker did not hand over brings no extension, skill, prompt or theme", { skip }, async () => {
	const server = await chatServer();
	const stage = (root) => {
		put(root, "/opt/pi-global/packages/lint/package.json", JSON.stringify({ name: "lint", version: "1.0.0", pi: { extensions: ["ext.js"], skills: ["skills"], prompts: ["prompts"] } }));
		put(root, "/opt/pi-global/packages/lint/ext.js", marked("lint", ["lint_run"]));
		put(root, "/opt/pi-global/packages/lint/skills/packflow/SKILL.md", `---\nname: "packflow"\ndescription: the skill\n---\nDo it.\n`);
		put(root, "/opt/pi-global/packages/lint/prompts/hello.md", "---\ndescription: a prompt\n---\nDo it.\n");
	};
	try {
		const withIt = jobTree({ base: server.base });
		stage(withIt);
		const loaded = await run(withIt, { PI_PACKAGES: "/opt/pi-global/packages/lint", PI_FLOW: "packflow" });
		assert.equal(loaded.exit.loaded.flow, "package", "the premise");
		const without = jobTree({ base: server.base });
		stage(without);
		const { exit } = await run(without, { PI_FLOW: "packflow" });
		assert.equal(exit.loaded.flow, "none", "its skill went with it, which is the record's word for a flow in no tier");
		assert.deepEqual(exit.loaded.tiers.package, [0, 0, 0, 0, 0, 0, 0, 0]);
		assert.deepEqual(marksOf(without), []);
	} finally {
		await server.close();
	}
});

test("a tool named in run.excludeExtensionTools leaves the session, on every shape of job, and a name pi knows from nowhere widens nothing", { skip }, async () => {
	const server = await chatServer();
	try {
		for (const env of [{}, { PI_EXCLUDE_TOOLS_STRICT: STRICT }, { PI_EXCLUDE_TOOLS: "bash" }]) {
			const root = jobTree({ base: server.base });
			overlay(root);
			const { exit, lines, stderr } = await run(root, { PI_EXCLUDE_EXTENSION_TOOLS: "guard_check", ...env });
			assert.equal(exit?.code, 0, stderr);
			const read = lines.find((line) => line.event === "tools_excluded");
			assert.ok(!read.active.includes("guard_check"), JSON.stringify(read));
			assert.ok(read.active.includes("gone_tool"), "and only that one");
			assert.deepEqual(read.excludeExtensionTools, ["guard_check"]);
			assert.equal(exit.loaded.tools.unmatched, undefined, "it matched");
			assert.ok(!JSON.stringify(exit.loaded.extTools).includes("guard_check"), "what the session lacks is not on the record as brought");
		}
	} finally {
		await server.close();
	}
});

test("a strict job with a name that matched nothing stops before its prompt, and the worker reads which name from its own list", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = jobTree({ base: server.base });
		overlay(root);
		const { exit, stdout, lines, stderr, code } = await run(root, { PI_EXCLUDE_EXTENSION_TOOLS: "guard_check,guard_chek", PI_EXCLUDE_TOOLS_STRICT: STRICT });
		assert.equal(code, 2, stderr);
		assert.equal(exit.reason, "exclude-tool-not-loaded");
		assert.equal(server.calls(), 0, "no prompt was sent, and no extension here made a call");
		assert.equal(exit.tokens.calls, 0, "the line a $0 settlement needs");
		assert.equal(exit.loaded.at, "ready");
		assert.deepEqual(exit.loaded.tools.unmatched, [1], "a position, so the name is not on the line");
		assert.doesNotMatch(JSON.stringify(exit.loaded), /guard_chek/);
		const said = lines.find((line) => line.event === "exclude_tools_unmatched");
		assert.deepEqual([said.tools, said.strict], [["guard_chek"], true], "the log's names are the worker's list's");
		const sink = makeLogSink({ logsDir: "/nonexistent", enabled: false, fs: { mkdirSync() {} } })("real", { exitKey: KEY });
		sink.write(Buffer.from(stdout));
		const read = await sink.close();
		assert.equal(read.exitAuth, "verified");
		assert.equal(read.exitReason, "exclude-tool-not-loaded", "named, and not folded into runner-policy");
		const record = rebuildLoaded(read.loaded, { packages: [], overlayExtensions: ["gone.js", "guard.ts", "folder"], servers: [], ownTools: EXCLUDABLE_TOOL_NAMES, leftOut: null, excludeExtensionTools: ["guard_check", "guard_chek"] });
		assert.equal(record.runner, "reported");
		assert.deepEqual(record.tools.unmatched, ["guard_chek"]);
	} finally {
		await server.close();
	}
});

test("a stop is not free when an extension called a model as it loaded: the call is metered and on the line", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = jobTree({ base: server.base });
		const model = { id: "m1", name: "m1", api: "openai-completions", provider: "real-job-fake", baseUrl: server.base, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } };
		put(root, "/opt/pi-global/extensions/caller.js", `import { streamSimple } from "@earendil-works/pi-ai";
export default async function () {
	await streamSimple(${JSON.stringify(model)}, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { apiKey: "real-job-fake-key" }).result();
}
`);
		const { exit, stderr } = await run(root, { PI_EXCLUDE_EXTENSION_TOOLS: "no_such_tool", PI_EXCLUDE_TOOLS_STRICT: STRICT });
		assert.equal(exit?.reason, "exclude-tool-not-loaded", stderr);
		assert.equal(server.calls(), 1, "the one call the extension made, and no prompt");
		assert.equal(exit.tokens.calls, 1);
	} finally {
		await server.close();
	}
});

test("not strict, the same name only says so: the job runs, for each job the worker leaves unmarked", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = jobTree({ base: server.base });
		overlay(root);
		const { exit, lines, stderr, code } = await run(root, { PI_EXCLUDE_EXTENSION_TOOLS: "guard_chek" });
		assert.equal(code, 0, stderr);
		assert.deepEqual(exit.loaded.tools.unmatched, [0]);
		assert.equal(lines.find((line) => line.event === "exclude_tools_unmatched").strict, false);
		assert.ok(server.calls() > 0, "and it went on to its prompt");
	} finally {
		await server.close();
	}
});

test("strict, a load that failed or a dropped extension may be why a name matched nothing, so neither stops the job", { skip }, async () => {
	const server = await chatServer();
	try {
		for (const [what, file, body] of [
			["a failed load", "/opt/pi-global/extensions/broken.js", "export default function ( {\n"],
			["a dropped extension", "/workspace/.pi/extensions/dispatch-admin.js", marked("admin", ["dispatch_run"])],
		]) {
			const root = jobTree({ base: server.base });
			overlay(root);
			put(root, file, body);
			const { exit, stderr, code } = await run(root, { PI_EXCLUDE_EXTENSION_TOOLS: "guard_chek", PI_EXCLUDE_TOOLS_STRICT: STRICT });
			assert.equal(code, 0, `${what}: ${stderr}`);
			assert.deepEqual(exit.loaded.tools.unmatched, [0], what);
		}
	} finally {
		await server.close();
	}
});

test("a tool an extension registers after it loads refuses a strict job, whose way out is excluding the extension", { skip }, async () => {
	const server = await chatServer();
	const late = `export default function (pi) {\n\tpi.on("session_start", () => { ${registration("late_tool")} });\n}\n`;
	try {
		const root = jobTree({ base: server.base });
		put(root, "/opt/pi-global/extensions/late.js", late);
		const stopped = await run(root, { PI_EXCLUDE_EXTENSION_TOOLS: "late_tool", PI_EXCLUDE_TOOLS_STRICT: STRICT });
		assert.equal(stopped.exit.reason, "exclude-tool-not-loaded");
		const out = jobTree({ base: server.base });
		put(out, "/opt/pi-global/extensions/late.js", late);
		const { exit, stderr } = await run(out, { PI_EXCLUDE_EXTENSIONS: "late" });
		assert.equal(exit?.code, 0, stderr);
	} finally {
		await server.close();
	}
});

test("a name only a repository registers answers alike on every repository: a strict job stops on the one that holds it and the one that does not, and it is out of the session either way", { skip }, async () => {
	const server = await chatServer();
	try {
		const withIt = jobTree({ base: server.base });
		put(withIt, "/workspace/.pi/extensions/repo-tool.js", marked("repo", ["repo_tool"]));
		const without = jobTree({ base: server.base });
		const strict = { PI_EXCLUDE_EXTENSION_TOOLS: "repo_tool", PI_EXCLUDE_TOOLS_STRICT: STRICT };
		const [a, b] = [await run(withIt, strict), await run(without, strict)];
		for (const [label, result] of [["repo A", a], ["repo B", b]]) {
			assert.equal(result.code, 2, `${label}: ${result.stderr}`);
			assert.equal(result.exit.reason, "exclude-tool-not-loaded", label);
			assert.deepEqual(result.exit.loaded.tools.unmatched, [0], label);
			assert.equal(result.lines.find((line) => line.event === "exclude_tools_unmatched").strict, true, label);
		}
		assert.equal(server.calls(), 0, "neither sent a prompt");
		assert.ok(!a.lines.find((line) => line.event === "tools_excluded").active.includes("repo_tool"), "the key takes a repository's tool of that name out of the session, which is what the job that does not stop relies on");
		// Not strict, the same job runs without the tool, and says the name is none a package or the overlay brought.
		const open = jobTree({ base: server.base });
		put(open, "/workspace/.pi/extensions/repo-tool.js", marked("repo", ["repo_tool", "repo_other"]));
		const { exit, lines, stderr, code } = await run(open, { PI_EXCLUDE_EXTENSION_TOOLS: "repo_tool" });
		assert.equal(code, 0, stderr);
		const read = lines.find((line) => line.event === "tools_excluded");
		assert.ok(!read.active.includes("repo_tool") && read.active.includes("repo_other"), JSON.stringify(read));
		assert.deepEqual(exit.loaded.tools.unmatched, [0]);
		assert.equal(lines.find((line) => line.event === "exclude_tools_unmatched").strict, false);
	} finally {
		await server.close();
	}
});

test("a name a staged package or an overlay extension brings answers a strict job, in a folder or a file, and beside a repository's tool of the same name", { skip }, async () => {
	const server = await chatServer();
	const stage = (root) => {
		put(root, "/opt/pi-global/packages/lint/package.json", JSON.stringify({ name: "lint", version: "1.0.0", pi: { extensions: ["ext.js"] } }));
		put(root, "/opt/pi-global/packages/lint/ext.js", marked("lint", ["lint_run"]));
	};
	const asked = { PI_PACKAGES: "/opt/pi-global/packages/lint", PI_EXCLUDE_EXTENSION_TOOLS: "lint_run,guard_check,folder_tool", PI_EXCLUDE_TOOLS_STRICT: STRICT };
	try {
		const clean = jobTree({ base: server.base });
		overlay(clean);
		stage(clean);
		const fine = await run(clean, asked);
		assert.equal(fine.code, 0, fine.stderr);
		assert.equal(fine.exit.loaded.tools.unmatched, undefined, "each is the host's, so nothing on the line");
		// A repository's tool of a package's name is a conflict pi reports, so it is a failed load, which a strict job does not stop on, and it must not read as unmatched either way round.
		const shared = jobTree({ base: server.base });
		overlay(shared);
		stage(shared);
		put(shared, "/workspace/.pi/extensions/repo-lint.js", marked("repo", ["lint_run", "guard_check"]));
		const both = await run(shared, asked);
		assert.equal(both.code, 0, both.stderr);
		assert.equal(both.exit.loaded.tools.unmatched, undefined, "the package and the overlay still brought them, whichever extension pi's own list would keep");
		assert.ok(!both.lines.find((line) => line.event === "tools_excluded").active.includes("lint_run"));
	} finally {
		await server.close();
	}
});
