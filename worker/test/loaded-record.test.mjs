import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as runnerLoaded from "../../image/runner/src/loaded.mjs";
import { createExitWriter } from "../../image/runner/src/exit-line.mjs";
import { maximalLoaded } from "../../image/runner/test/helpers/maximal-loaded.mjs";
import * as record from "../src/loaded-record.mjs";
import { makeRedactor } from "../src/redact-secrets.mjs";
import { buildRecord, makeLogSink } from "../src/run-history.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const { LOADED_RECORD_MAX_BYTES, leavesOut, leftOutOf, loadedWithImage, rebuildLoaded, recordedLoaded } = record;
const { buildLoaded, fitLoaded } = runnerLoaded;

// Issue #800, INT-RUN-HISTORY-FILE-CONTRACT's `loaded`: the worker's half. The lines here come out of the runner's own
// buildLoaded and fitLoaded wherever a test is about what a genuine line reads as, so the two halves cannot pass apart.

const OWN = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const LINT = "/opt/pi-global/packages/lint";
const FMT = "/opt/pi-global/packages/fmt";
const OVERLAY_EXT = "/opt/pi-global/extensions";
const ROOTS = { packages: [LINT, FMT], jobPi: "/job/pi", triggerSkills: "/job/trigger-skills", overlay: "/opt/pi-global", workspace: "/workspace" };
const KNOWN = {
	packages: [{ name: "pi-lint", version: "1.4.2" }, { name: "@acme/fmt", version: "0.9.0" }],
	overlayExtensions: ["git-guard.ts", "broken.js"],
	servers: ["linear"],
	ownTools: OWN,
	leftOut: { tools: [], packages: false, overlayExtensions: false, restricted: false },
};
const tool = (name, path) => ({ name, path });

/** A genuine line of a whole job, as the runner writes it. */
function line(over = {}) {
	return buildLoaded({
		at: "ready",
		pi: "1.5.0",
		roots: ROOTS,
		flow: "lint-fix",
		extensions: [`${LINT}/ext.js`, `${OVERLAY_EXT}/git-guard.ts`, "/workspace/.pi/extensions/a.js"],
		skills: [{ name: "lint-fix", filePath: `${LINT}/skills/lint-fix/SKILL.md` }, { name: "deploy", filePath: "/job/pi/skills/deploy/SKILL.md" }],
		prompts: [`${FMT}/prompts/a.md`],
		failures: [{ root: OVERLAY_EXT, kind: "load", name: "broken.js" }],
		drops: [{ root: "/workspace/.pi/extensions" }],
		tools: [tool("read", "builtin:read"), tool("bash", "builtin:bash"), tool("lint_run", `${LINT}/ext.js`), tool("guard_check", `${OVERLAY_EXT}/git-guard.ts`), tool("repo_secret", "/workspace/.pi/extensions/a.js"), tool("report_progress", "<inline:job-report-progress>")],
		active: ["read", "bash", "lint_run", "guard_check", "repo_secret", "report_progress", "mcp__linear__x"],
		ownNames: [...OWN],
		mcp: [["connected", 12]],
		...over,
	});
}

const source = (loaded, tier, index = 0) => loaded.sources.filter((row) => row.tier === tier)[index];

test("the worker's copy of the runner's vocabulary and caps is the runner's (the worker cannot import the image)", () => {
	for (const name of ["LOADED_STAGES", "LOADED_TIERS", "LOADED_FLOW_WORDS", "LOADED_MCP_STATES", "LOADED_ROW", "LOADED_MAX_PACKAGES", "LOADED_MAX_SERVERS", "LOADED_MAX_OVERLAY_NAMES", "LOADED_MAX_EXT_TOOLS", "LOADED_MAX_COUNT", "LOADED_MAX_PROBLEM_COUNT", "LOADED_MAX_TOOL_COUNT", "LOADED_JOB_TOOLS"]) {
		assert.deepEqual(record[name], runnerLoaded[name], name);
	}
	assert.equal(String(record.LOADED_OVERLAY_NAME_RE), String(runnerLoaded.LOADED_OVERLAY_NAME_RE));
	assert.equal(String(record.LOADED_TOOL_NAME_RE), String(runnerLoaded.LOADED_TOOL_NAME_RE));
	assert.equal(record.LOADED_LINE_VERSION, runnerLoaded.LOADED_VERSION);
	assert.deepEqual(fitLoaded(line()).map((form) => form.cut.form), [...record.LOADED_FORMS]);
});

test("a genuine line reads as `reported`, joined by position with what the worker handed over", () => {
	const loaded = rebuildLoaded(line(), KNOWN);
	assert.equal(loaded.v, 1);
	assert.equal(loaded.runner, "reported");
	assert.equal(loaded.at, "ready");
	assert.equal(loaded.cut, null, "nothing was cut, so the record says nothing of it");
	assert.equal(loaded.pi, "1.5.0");
	assert.deepEqual(loaded.flow, { tier: "package", package: "pi-lint" });
	const [lint, fmt] = loaded.sources;
	assert.deepEqual(lint, { tier: "package", name: "pi-lint", version: "1.4.2", extensions: 1, skills: 1, prompts: 0, themes: 0, tools: 1, failed: 0, dropped: 0, shadowed: 0, toolNames: ["lint_run"] });
	assert.deepEqual(fmt, { tier: "package", name: "@acme/fmt", version: "0.9.0", extensions: 0, skills: 0, prompts: 1, themes: 0, tools: 0, failed: 0, dropped: 0, shadowed: 0, toolNames: [] });
	assert.deepEqual(source(loaded, "overlay"), { tier: "overlay", names: ["git-guard.ts"], failedNames: ["broken.js"], extensions: 1, skills: 0, prompts: 0, themes: 0, tools: 1, failed: 1, dropped: 0, shadowed: 0, namedTools: [{ name: "git-guard.ts", tools: ["guard_check"] }] });
	assert.deepEqual(source(loaded, "repository"), { tier: "repository", extensions: 1, skills: 1, prompts: 0, themes: 0, tools: 1, failed: 0, dropped: 1, shadowed: 0 }, "a repository is counts, with no list of names to hold one");
	assert.deepEqual(loaded.mcp, [{ name: "linear", state: "connected", tools: 12 }]);
	assert.deepEqual(loaded.tools, { active: 7, own: ["read", "bash"], job: ["report_progress"] });
	assert.deepEqual(loaded.problems, { failed: 1, dropped: 1, mcp: 0 });
	assert.deepEqual(loaded.leftOut, KNOWN.leftOut);
	assert.deepEqual(recordedLoaded(loaded), loaded, "what it builds is what the record keeps");
});

test("the line's two smaller forms read too, each saying what it no longer holds", () => {
	const [, compact, minimal] = fitLoaded(line());
	const small = rebuildLoaded(compact, KNOWN);
	assert.equal(small.runner, "reported");
	assert.deepEqual(small.cut, { form: "compact", packages: 0, servers: 0, names: 0, counts: 0 });
	assert.deepEqual(small.flow, { tier: "package", package: "pi-lint" }, "the worker still names it: the compact form keeps its row");
	assert.equal(source(small, "package").name, null, "one row of totals with no name");
	assert.equal(source(small, "package").extensions, 1);
	assert.equal(source(small, "package").toolNames, null);
	assert.equal(source(small, "overlay").names, null);
	assert.equal(source(small, "overlay").namedTools, null);
	assert.deepEqual(small.tools, { active: 7, own: null, job: null });
	assert.deepEqual(small.mcp, [{ name: "linear", state: "connected", tools: 12 }]);
	assert.deepEqual(small.problems, { failed: 1, dropped: 1, mcp: 0 });

	const least = rebuildLoaded(minimal, KNOWN);
	assert.equal(least.runner, "reported");
	assert.deepEqual(least.flow, { tier: "package", package: null }, "that it was a package's stays, and which does not");
	assert.deepEqual(least.sources, []);
	assert.equal(least.mcp, null);
	assert.equal(least.tools, null);
	assert.deepEqual(least.problems, { failed: 1, dropped: 1, mcp: 0 });
	assert.equal(least.cut.form, "minimal");
	for (const form of [small, least]) assert.deepEqual(recordedLoaded(form), form);
});

test("a job stopped early says only what its stage knew", () => {
	for (const at of ["start", "none"]) {
		const loaded = rebuildLoaded(buildLoaded({ at, pi: "1.5.0" }), KNOWN);
		assert.equal(loaded.runner, "reported");
		assert.equal(loaded.at, at);
		assert.deepEqual([loaded.flow, loaded.sources, loaded.mcp, loaded.tools, loaded.problems], [null, [], null, null, null], at);
	}
	const beforeTheSession = rebuildLoaded(line({ at: "loader", tools: null, mcp: null }), KNOWN);
	assert.equal(beforeTheSession.at, "loader");
	assert.equal(beforeTheSession.mcp, null);
	assert.equal(beforeTheSession.tools, null);
	assert.deepEqual(beforeTheSession.problems, { failed: 1, dropped: 1, mcp: null });
	assert.deepEqual(source(beforeTheSession, "package").toolNames, [], "no tool has been read yet");
});

test("a server the job stopped on is named from the worker's list, in the two ways a job stops on one", () => {
	const stopped = rebuildLoaded(line({ at: "session", mcp: [["timeout", 0], ["failed", 0], ["disabled", 0]] }), { ...KNOWN, servers: ["linear", "sentry", "forge"] });
	assert.deepEqual(stopped.mcp, [{ name: "linear", state: "timeout", tools: 0 }, { name: "sentry", state: "failed", tools: 0 }, { name: "forge", state: "disabled", tools: 0 }]);
	assert.equal(stopped.problems.mcp, 2);
});

test("the join is by position, a canary's candidate at its place, and a package the worker cannot name is a row with no name", () => {
	const known = { ...KNOWN, packages: [{ name: "pi-lint", version: "1.5.0-rc.1" }, null] };
	const loaded = rebuildLoaded(line(), known);
	assert.deepEqual([loaded.sources[0].name, loaded.sources[0].version], ["pi-lint", "1.5.0-rc.1"], "the candidate's version, not the staged one's");
	assert.deepEqual([loaded.sources[1].name, loaded.sources[1].version], [null, null]);
	assert.equal(loaded.sources[1].prompts, 1, "its counts stay");
	// A manifest edited by hand is no source of a name: what fails the charset reads as no name, never as written.
	const hand = rebuildLoaded(line(), { ...KNOWN, packages: [{ name: "pi-lint", version: "1.4.2" }, { name: "<img src=x>", version: "1" }] });
	assert.equal(hand.runner, "reported");
	assert.equal(hand.sources[1].name, null);
	assert.ok(!JSON.stringify(hand).includes("<img"));
});

test('`"packages": false` reads as left out, with no rows, and the job the runner saw reads the same', () => {
	const roots = { ...ROOTS, packages: [] };
	const known = { ...KNOWN, packages: [], leftOut: leftOutOf({ packages: false }) };
	const loaded = rebuildLoaded(line({ roots, flow: "deploy", extensions: [], skills: [{ name: "deploy", filePath: "/job/pi/skills/deploy/SKILL.md" }], prompts: [], tools: [], active: [], failures: [], drops: [] }), known);
	assert.equal(loaded.runner, "reported");
	assert.equal(loaded.leftOut.packages, true);
	assert.deepEqual(loaded.sources.filter((row) => row.tier === "package" && row.name !== null), [], "no package row");
	assert.equal(loaded.sources.filter((row) => row.tier === "package").length, 0);
	assert.deepEqual(loaded.flow, { tier: "repository", package: null });
});

test("left out comes from the worker: run.excludeTools, run.packages, the host's switch and a restricted job", () => {
	assert.deepEqual(leftOutOf({}), { tools: [], packages: false, overlayExtensions: false, restricted: false });
	assert.deepEqual(leftOutOf({ excludeTools: ["bash", "mcp__linear__*"] }).tools, ["bash", "mcp__linear__*"]);
	assert.equal(leftOutOf({ packages: false }).packages, true);
	assert.equal(leftOutOf({ packages: true }).packages, false);
	assert.equal(leftOutOf({}, { allowGlobalExtensions: false }).overlayExtensions, true);
	// A restricted job's overlay is forced off for it, which is `restricted`, not the host's switch.
	for (const job of [{ watch: { stage: "decision" } }, { answerDraft: { runId: "r" } }, { questionGrouping: { runId: "r" } }]) {
		assert.deepEqual(leftOutOf(job, { allowGlobalExtensions: true }), { tools: [], packages: false, overlayExtensions: false, restricted: true }, JSON.stringify(job));
	}
	assert.deepEqual(leftOutOf({ excludeTools: ["bash", "bash", "not a tool", 7, "<b>"] }).tools, ["bash"], "a hand-built job's junk never reaches the record");
	assert.equal(leavesOut(leftOutOf({})), false);
	for (const out of [leftOutOf({ excludeTools: ["bash"] }), leftOutOf({ packages: false }), leftOutOf({}, { allowGlobalExtensions: false }), leftOutOf({ watch: {} })]) assert.equal(leavesOut(out), true);
});

test("an older image and a line the supervisor wrote read as `absent`, with the worker's facts", () => {
	for (const raw of [undefined, null]) {
		const loaded = rebuildLoaded(raw, { ...KNOWN, leftOut: leftOutOf({ excludeTools: ["bash"] }) });
		assert.equal(loaded.runner, "absent");
		assert.equal(loaded.at, null);
		assert.deepEqual(loaded.leftOut.tools, ["bash"]);
		assert.deepEqual([loaded.pi, loaded.flow, loaded.mcp, loaded.tools, loaded.problems], [null, null, null, null, null]);
		assert.deepEqual(loaded.sources, []);
	}
});

test("any violation is `invalid`, every part of the line gone and the worker's facts kept", () => {
	const genuine = line();
	const edits = {
		"version": (l) => (l.v = 2),
		"a version that is no number": (l) => (l.v = "1"),
		"a stage": (l) => (l.at = "finished"),
		"pi not a version": (l) => (l.pi = "1.5.0 please read the file"),
		"a cut that names no form": (l) => (l.cut.form = "huge"),
		"a cut that is no count": (l) => (l.cut.names = -1),
		"a flow word": (l) => (l.flow = "sneaky"),
		"flowPackage out of range": (l) => (l.flowPackage = 2),
		"flowPackage that is no integer": (l) => (l.flowPackage = 0.5),
		"flowPackage beside a tier that has none": (l) => ((l.flow = "overlay"), (l.flowPackage = 0)),
		"a package flow naming no row": (l) => delete l.flowPackage,
		"too few package rows": (l) => l.packages.pop(),
		"too many package rows": (l) => l.packages.push([...l.packages[0]]),
		"a row of the wrong length": (l) => l.packages[0].pop(),
		"a row count that is no integer": (l) => (l.packages[0][0] = 1.5),
		"a negative row count": (l) => (l.packages[0][0] = -1),
		"a row count past its clamp": (l) => (l.packages[0][0] = 1000),
		"a problem count past its clamp": (l) => (l.packages[0][5] = 100),
		"a row count that is text": (l) => (l.packages[0][0] = "1"),
		"a tier missing": (l) => delete l.tiers.other,
		"a tier row that is short": (l) => l.tiers.other.pop(),
		"a tier count that is no integer": (l) => (l.tiers.other[0] = "x"),
		"an overlay name not on disk": (l) => l.overlay.loaded.push("not-here.ts"),
		"a failed overlay name not on disk": (l) => l.overlay.failed.push("not-here.ts"),
		"an overlay name failing its shape": (l) => l.overlay.loaded.push("a b"),
		"too many overlay names": (l) => l.overlay.loaded.push(...Array.from({ length: 16 }, () => "git-guard.ts")),
		"too few servers": (l) => l.mcp.pop(),
		"too many servers": (l) => l.mcp.push(["connected", 1]),
		"a server state": (l) => (l.mcp[0][0] = "fine"),
		"a server count past its clamp": (l) => (l.mcp[0][1] = 10000),
		"an own tool pi does not have": (l) => l.tools.own.push("rm_rf"),
		"an own tool twice": (l) => l.tools.own.push("read"),
		"a job tool outside the closed list": (l) => l.tools.job.push("mine"),
		"an active count past its clamp": (l) => (l.tools.active = 10000),
		"an extension tool failing its shape": (l) => l.extTools.p[0].push("has space"),
		"too many extension tools": (l) => l.extTools.p[0].push(...Array.from({ length: 24 }, (_, i) => `t${i}`)),
		"an extension tool's package out of range": (l) => (l.extTools.p[0][0] = 2),
		"an extension tool's overlay name out of range": (l) => (l.extTools.o[0][0] = 1),
		"a source named twice": (l) => l.extTools.p.push([...l.extTools.p[0]]),
		"an extTools row with no name": (l) => l.extTools.p.push([1]),
		"a cut count that disagrees with the rows": (l) => (l.cut.packages = 1),
		"a cut count that disagrees with the servers": (l) => (l.cut.servers = 1),
	};
	const known = { ...KNOWN, leftOut: leftOutOf({ excludeTools: ["bash"] }) };
	for (const [label, edit] of Object.entries(edits)) {
		const forged = structuredClone(genuine);
		edit(forged);
		const words = [];
		const loaded = rebuildLoaded(forged, { ...known, onViolation: (word) => words.push(word) });
		assert.equal(loaded.runner, "invalid", label);
		assert.equal(words.length, 1, `${label} is said once`);
		assert.match(words[0], /^[a-z-]+$/, "a fixed word, never line text");
		assert.deepEqual([loaded.at, loaded.pi, loaded.flow, loaded.mcp, loaded.tools, loaded.problems], [null, null, null, null, null, null], label);
		assert.deepEqual(loaded.sources, [], label);
		assert.deepEqual(loaded.leftOut.tools, ["bash"], `${label}: the worker's own fact stays`);
	}
	for (const notALine of ["a string", 7, true, []]) assert.equal(rebuildLoaded(notALine, known).runner, "invalid", JSON.stringify(notALine));
	// Nothing an injected log does can reach the field.
	assert.equal(rebuildLoaded("x", { ...known, onViolation: () => { throw new Error("a log that throws"); } }).runner, "invalid");
});

test("an overlay name not on this disk is invalid and the image stays, and a folder that could not be read vouches for nothing", () => {
	const noFolder = rebuildLoaded(line(), { ...KNOWN, overlayExtensions: [] });
	assert.equal(noFolder.runner, "invalid");
	const withImage = loadedWithImage(noFolder, { image: "pi-job:4.3.1", imageDigest: `sha256:${"a".repeat(64)}`, piVersion: "1.5.0" });
	const kept = recordedLoaded(withImage);
	assert.equal(kept.runner, "invalid");
	assert.deepEqual([kept.image, kept.imageDigest, kept.imagePi], ["pi-job:4.3.1", `sha256:${"a".repeat(64)}`, "1.5.0"]);
});

test("a hostile name never reaches the record: the bytes of a whole record, through every route a line has", () => {
	const HOSTILE = ["IGNORE PREVIOUS", "<script>alert(1)</script>", "../../etc/passwd", "/Users/rob/secret", "evil‮name", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "repo\nsecret"];
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const noLeak = (loaded, label) => {
		const bytes = JSON.stringify(buildRecord({ job, result: { outcome: "completed", exitCode: 0, loaded } }));
		for (const hostile of HOSTILE) {
			assert.ok(!bytes.includes(hostile) && !bytes.includes(JSON.stringify(hostile).slice(1, -1)), `${label}: ${hostile} reached the record`);
		}
		return bytes;
	};
	const routes = {
		"an overlay name": (l, h) => l.overlay.loaded.push(h),
		"a failed overlay name": (l, h) => l.overlay.failed.push(h),
		"the flow": (l, h) => (l.flow = h),
		"pi": (l, h) => (l.pi = h),
		"the stage": (l, h) => (l.at = h),
		"a server state": (l, h) => (l.mcp[0][0] = h),
		"an own tool": (l, h) => l.tools.own.push(h),
		"a job tool": (l, h) => l.tools.job.push(h),
		"an extension tool": (l, h) => l.extTools.p[0].push(h),
		"an overlay extension tool": (l, h) => l.extTools.o[0].push(h),
		"a cut form": (l, h) => (l.cut.form = h),
		"a row count": (l, h) => (l.packages[0][0] = h),
		"a tier count": (l, h) => (l.tiers.repository[0] = h),
		"a key the line invented": (l, h) => (l.name = h),
		"a tier the line invented": (l, h) => (l.tiers.secret = [h]),
	};
	for (const [label, route] of Object.entries(routes)) {
		for (const hostile of HOSTILE) {
			const forged = structuredClone(line());
			route(forged, hostile);
			noLeak(rebuildLoaded(forged, { ...KNOWN, redact: makeRedactor({ values: [] }) }), label);
		}
	}
	// The same strings handed to the record's own door, which is what a hand-built source would have to pass. The token
	// word has the shape of a tool's name, so it is the line's door that refuses it, holding the job's redactor (below).
	for (const hostile of HOSTILE.filter((word) => !record.LOADED_TOOL_NAME_RE.test(word))) {
		const good = rebuildLoaded(line(), KNOWN);
		const hand = {
			"a source's name": (l) => (l.sources[0].name = hostile),
			"a tool name": (l) => (l.sources[0].toolNames = [hostile]),
			"an overlay name": (l) => (source(l, "overlay").names = [hostile]),
			"a named tool": (l) => (source(l, "overlay").namedTools = [{ name: hostile, tools: ["a"] }]),
			"a server": (l) => (l.mcp[0].name = hostile),
			"the flow's package": (l) => (l.flow.package = hostile),
			"the flow's tier": (l) => (l.flow.tier = hostile),
			"a left-out tool": (l) => (l.leftOut.tools = [hostile]),
			"an own tool": (l) => (l.tools.own = [hostile]),
			"a tier": (l) => (l.sources[0].tier = hostile),
		};
		for (const [label, edit] of Object.entries(hand)) {
			const forged = structuredClone(good);
			edit(forged);
			assert.equal(recordedLoaded(forged), null, label);
			const bytes = noLeak(forged, label);
			assert.ok(!Object.hasOwn(JSON.parse(bytes), "loaded"), `${label}: a source that fails holds no key at all`);
		}
		const image = recordedLoaded({ ...good, imageDigest: hostile, imagePi: hostile });
		assert.deepEqual([image.imageDigest, image.imagePi], [null, null], "the image's facts are each held to their shape");
	}
});

test("a tool name that is the job's own secret, or a known token's shape, is invalid though it fits the shape", () => {
	const forge = (name) => {
		const forged = structuredClone(line());
		forged.extTools.p[0].push(name);
		return forged;
	};
	const redact = makeRedactor({ values: ["hunter2hunter2"] });
	const words = [];
	for (const name of ["hunter2hunter2", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) {
		assert.equal(rebuildLoaded(forge(name), { ...KNOWN, redact, onViolation: (word) => words.push(word) }).runner, "invalid", name);
	}
	assert.deepEqual(words, ["ext-tools-secret", "ext-tools-secret"]);
	assert.equal(rebuildLoaded(forge("lint_fix"), { ...KNOWN, redact }).runner, "reported");
	assert.equal(rebuildLoaded(forge("lint_fix"), { ...KNOWN, redact: () => "" }).runner, "invalid", "a redactor that could not be built judges nothing fine");
});

test("a forged list length and a forged tool name each fail their own check, and an unknown key is never read", () => {
	const longer = structuredClone(line());
	longer.packages.push([0, 0, 0, 0, 0, 0, 0, 0]);
	const words = [];
	assert.equal(rebuildLoaded(longer, { ...KNOWN, onViolation: (word) => words.push(word) }).runner, "invalid");
	assert.deepEqual(words, ["packages-length"]);
	const name = structuredClone(line());
	name.extTools.p[0].push("-leading-dash");
	words.length = 0;
	assert.equal(rebuildLoaded(name, { ...KNOWN, onViolation: (word) => words.push(word) }).runner, "invalid");
	assert.deepEqual(words, ["ext-tools-name"]);
	const extra = rebuildLoaded({ ...line(), secret: "SECRETKEY", tiers: { ...line().tiers, repository: [...line().tiers.repository] } }, KNOWN);
	assert.equal(extra.runner, "reported");
	assert.ok(!JSON.stringify(extra).includes("SECRETKEY"));
});

test("what the residual is: a token of the right shape on a real package passes, because the worker has nothing to compare it with", () => {
	// Pinned on purpose: this is the sentence the spec states, and a check added here would change what it says.
	const forged = structuredClone(line());
	forged.extTools.p[0].push("forged_tool");
	const loaded = rebuildLoaded(forged, KNOWN);
	assert.equal(loaded.runner, "reported");
	assert.ok(loaded.sources[0].toolNames.includes("forged_tool"));
});

test("a tool of a package past the row cap has no row to hold it, so it is counted as cut", () => {
	const packages = Array.from({ length: 18 }, (_, i) => `/opt/pi-global/packages/p${i}`);
	const known = { ...KNOWN, servers: [], packages: packages.map((_, i) => ({ name: `p${i}`, version: "1.0.0" })) };
	const raw = buildLoaded({ at: "session", pi: "1.5.0", roots: { ...ROOTS, packages }, tools: [tool("kept", `${packages[0]}/e.js`), tool("beyond", `${packages[17]}/e.js`)], active: [], ownNames: [...OWN], mcp: [] });
	const loaded = rebuildLoaded(raw, known);
	assert.equal(loaded.runner, "reported");
	assert.equal(loaded.sources.filter((row) => row.tier === "package").length, 16);
	assert.deepEqual(loaded.sources[0].toolNames, ["kept"]);
	assert.ok(!JSON.stringify(loaded).includes("beyond"));
	assert.deepEqual(loaded.cut, { form: "full", packages: 2, servers: 0, names: 1, counts: 0 });
});

/** The longest of each thing, through the runner's own maximal line, with every list and name at its cap. */
function maximal() {
	const line = maximalLoaded();
	const count = line.packages.length + 8;
	const longName = (i) => `@${"s".repeat(100)}/${String(i).padStart(2, "0")}${"n".repeat(110)}`;
	const longVersion = `1.2.3-${"r".repeat(122)}`;
	const overlayNames = line.overlay.loaded;
	const forged = { ...line, pi: `1.5.0-${"a".repeat(26)}`, cut: { form: "full", packages: 8, servers: 0, names: 99_999, counts: 99_999 } };
	const known = {
		packages: Array.from({ length: count }, (_, i) => ({ name: longName(i), version: longVersion })),
		overlayExtensions: overlayNames,
		servers: Array.from({ length: line.mcp.length }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(30)}`),
		ownTools: OWN,
		leftOut: { tools: Array.from({ length: 32 }, (_, i) => `mcp__${String(i).padStart(2, "0")}${"y".repeat(39)}*`), packages: true, overlayExtensions: true, restricted: true },
	};
	const img = { image: `ghcr.io/${"i".repeat(504)}`, imageDigest: `sha256:${"f".repeat(64)}`, piVersion: `1.5.0-${"a".repeat(26)}` };
	return { forged, known, img };
}

test("the record stays under 16 KiB at every cap, and the worst case is measured and pinned", () => {
	const { forged, known, img } = maximal();
	const built = rebuildLoaded(forged, known);
	assert.equal(built.runner, "reported", "the premise: this worst line passes every check");
	const kept = recordedLoaded(loadedWithImage(built, img));
	assert.ok(kept !== null, "and the record keeps it");
	const bytes = Buffer.byteLength(JSON.stringify(kept), "utf8");
	assert.equal(kept.sources.filter((row) => row.tier === "package").length, 16);
	assert.equal(kept.image.length, 512);
	assert.equal(kept.mcp.length, 8);
	assert.equal(kept.leftOut.tools.length, 32);
	assert.equal(kept.tools.job.length, record.LOADED_JOB_TOOLS.length);
	assert.ok(bytes <= LOADED_RECORD_MAX_BYTES, `the worst record is ${bytes} bytes`);
	assert.equal(bytes, 14_533);
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	assert.ok(spec.includes("14,533 bytes"), "INT-RUN-HISTORY-FILE-CONTRACT says the measured worst case");
	// And each smaller form, for a line that had to fall to one. The minimal form sums the tiers, so each is a fifth of the
	// largest safe integer here: a sum past that is no count and reads as invalid, which no real job comes near.
	const summable = { ...forged, tiers: Object.fromEntries(Object.entries(forged.tiers).map(([tier, row]) => [tier, row.map((value) => Math.floor(value / 5))])) };
	for (const form of fitLoaded(summable).slice(1)) {
		const loaded = recordedLoaded(loadedWithImage(rebuildLoaded(form, known), img));
		assert.equal(loaded.runner, "reported", form.cut.form);
		assert.ok(Buffer.byteLength(JSON.stringify(loaded), "utf8") < bytes);
	}
	// A hand-built source past the bound holds no key: its size is not something a reader should have to cope with.
	assert.equal(recordedLoaded({ ...kept, sources: kept.sources.map((row) => (row.tier === "package" ? { ...row, toolNames: Array.from({ length: 24 }, (_, i) => `${"t".repeat(40)}${i}`) } : row)) }), null);
});

test("`absent` and `invalid` carry no runner part, whatever the source said", () => {
	const good = rebuildLoaded(line(), KNOWN);
	for (const runner of ["absent", "invalid"]) {
		const kept = recordedLoaded({ ...good, runner });
		assert.deepEqual([kept.at, kept.cut, kept.pi, kept.flow, kept.mcp, kept.tools, kept.problems], [null, null, null, null, null, null, null], runner);
		assert.deepEqual(kept.sources, []);
		assert.deepEqual(kept.leftOut, good.leftOut, "what the worker said stays");
	}
	for (const bad of [null, "x", [], { v: 2, runner: "absent" }, { v: 1, runner: "fine" }, { v: 1, runner: "reported", at: "ready" }]) assert.equal(recordedLoaded(bad), null, JSON.stringify(bad));
});

test("the image is the worker's alone, and an unknown image leaves no key at all", () => {
	const only = loadedWithImage(null, { image: "pi-job:4.3.1", imageDigest: `sha256:${"b".repeat(64)}`, piVersion: "1.5.0" });
	assert.deepEqual(recordedLoaded(only), { v: 1, runner: "absent", at: null, cut: null, image: "pi-job:4.3.1", imageDigest: `sha256:${"b".repeat(64)}`, imagePi: "1.5.0", pi: null, flow: null, sources: [], mcp: null, tools: null, problems: null, leftOut: null });
	assert.equal(loadedWithImage(null, {}), null);
	assert.equal(loadedWithImage(null, null), null);
	const ran = rebuildLoaded(line(), KNOWN);
	assert.deepEqual(loadedWithImage(ran, {}), ran, "a preflight that named no image adds nothing");
	const both = loadedWithImage(ran, { image: "pi-job:4.3.1" });
	assert.deepEqual([both.image, both.imageDigest, both.imagePi], ["pi-job:4.3.1", null, null], "a fact the image did not declare is null");
	assert.equal(both.runner, "reported");
	assert.ok(!Object.hasOwn(ran, "x"));
});

test("the source does not need EXCLUDABLE_TOOL_NAMES to hold what the runner may name: the worker's set is pi's own (pinned elsewhere) and a list is read as one", async () => {
	const { EXCLUDABLE_TOOL_NAMES } = await import("../src/triggers.mjs");
	assert.deepEqual([...OWN].sort(), [...EXCLUDABLE_TOOL_NAMES].sort(), "the fixture here is the set the wiring hands in");
	assert.equal(rebuildLoaded(line(), { ...KNOWN, ownTools: [...EXCLUDABLE_TOOL_NAMES] }).runner, "reported");
	assert.equal(rebuildLoaded(line(), { ...KNOWN, ownTools: undefined }).runner, "invalid", "with nothing to check against, the own names cannot pass");
});

// The whole route on real bytes: the runner's writer signs a line, the worker's sink verifies it, the container's wrapper
// rebuilds it. Each half has its own tests; this is the one place a key they disagree on would show.
const KEY = "c".repeat(64);
let runMod;
let importError;
try {
	runMod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!runMod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`run-container is REQUIRED here but pi-ai could not import.\n${importError}`);
const skip = runMod ? false : `pi-ai not installed (node ${process.version}); CI runs these`;

const BASE_JOB = { kind: "local", provider: "anthropic", model: "m", maxTurns: 5 };

/** A fake `docker` whose stdout is what the runner's real writer writes, and which exits with `exitCode`. */
function spawnWriting(recorder, { noted, key = KEY, jobId = "pi-job-gh-1", exitCode = 0, extra = "" } = {}) {
	return (cmd, args) => {
		recorder.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = new EventEmitter();
		child.stdin.end = () => {};
		queueMicrotask(() => {
			const out = [];
			const writer = createExitWriter({ key, jobId, write: (text) => out.push(text), exit: () => {} });
			if (noted !== undefined) writer.note({ loaded: noted });
			writer.writeExit({ code: exitCode, reason: exitCode === 0 ? "stop" : "mcp-unreachable" });
			child.stdout.emit("data", Buffer.from(`${extra}${out.join("")}`));
			child.emit("close", exitCode);
		});
		return child;
	};
}

function runWith({ job = BASE_JOB, prepared = {}, known = {}, spawnOptions = {}, exitAuth = true, makeOptions = {} } = {}) {
	const recorder = {};
	const logs = [];
	const run = runMod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: { ANTHROPIC_API_KEY: "sk-real" },
		spawnFn: spawnWriting(recorder, spawnOptions),
		openJobLog: makeLogSink({ logsDir: tempDir("loaded-sink-"), enabled: false }),
		mintExitKey: () => KEY,
		globalPiDir: "/host/overlay",
		readOverlayExtensions: () => KNOWN.overlayExtensions,
		log: (event, fields) => logs.push({ event, ...fields }),
		...known,
		...makeOptions,
	});
	return run({ job, prepared: { workspace: "/host/w", jobDir: "/host/jobs/j1", ...prepared }, name: "pi-job-gh-1", exitAuth }).then((result) => ({ result, recorder, logs }));
}

const resolver = (rows) => {
	const paths = Object.keys(rows);
	const resolve = () => paths;
	resolve.rowOf = (path) => rows[path] ?? null;
	return resolve;
};

test("run-container: a signed line reads as `reported`, with names joined from the read that chose the paths", { skip }, async () => {
	const { result, recorder, logs } = await runWith({
		known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) },
		job: { ...BASE_JOB, mcp: ["linear"] },
		spawnOptions: { noted: line() },
	});
	assert.equal(result.exitAuth, "verified");
	assert.equal(result.loaded.runner, "reported");
	assert.deepEqual(result.loaded.sources.slice(0, 2).map((row) => [row.name, row.version]), [["pi-lint", "1.4.2"], ["@acme/fmt", "0.9.0"]]);
	assert.deepEqual(result.loaded.mcp, [{ name: "linear", state: "connected", tools: 12 }]);
	assert.ok(recorder.args.includes(`PI_PACKAGES=${LINT}:${FMT}`), "the rows are the paths the job got");
	assert.deepEqual(logs.filter((line_) => line_.event === "loaded_invalid"), []);
});

test("run-container: a canary's candidate takes the staged copy's row, in its place", { skip }, async () => {
	const staged = "/opt/pi-global/packages/lint--aaaaaaaaaaaa";
	const other = "/opt/pi-global/packages/fmt--bbbbbbbbbbbb";
	const candidate = "/job/canary/lint--cccccccccccc";
	const { result, recorder } = await runWith({
		known: { packagePaths: resolver({ [staged]: { name: "pi-lint", version: "1.4.2" }, [other]: { name: "@acme/fmt", version: "0.9.0" } }) },
		job: { ...BASE_JOB, mcp: ["linear"], packageCanary: { name: "pi-lint", version: "1.5.0" } },
		prepared: { packageCanary: { replaces: "lint--aaaaaaaaaaaa", tree: "lint--cccccccccccc" } },
		spawnOptions: { noted: line({ roots: { ...ROOTS, packages: [candidate, other] }, extensions: [`${candidate}/ext.js`], skills: [{ name: "lint-fix", filePath: `${candidate}/skills/lint-fix/SKILL.md` }], tools: [tool("read", "builtin:read"), tool("lint_run", `${candidate}/ext.js`)], active: ["read", "lint_run"], failures: [], drops: [], prompts: [] }) },
	});
	assert.ok(recorder.args.includes(`PI_PACKAGES=${candidate}:${other}`), JSON.stringify(recorder.args.filter((a) => String(a).startsWith("PI_PACKAGES"))));
	assert.equal(result.loaded.runner, "reported");
	assert.deepEqual(result.loaded.sources.slice(0, 2).map((row) => [row.name, row.version]), [["pi-lint", "1.5.0"], ["@acme/fmt", "0.9.0"]], "the candidate's version, at the staged copy's place");
	assert.deepEqual(result.loaded.flow, { tier: "package", package: "pi-lint" });
	assert.deepEqual(result.loaded.sources[0].toolNames, ["lint_run"]);
});

test('run-container: `"packages": false` is said as such, with no rows and no read of the manifest', { skip }, async () => {
	let reads = 0;
	const resolve = () => (reads++, [LINT]);
	const { result } = await runWith({
		known: { packagePaths: resolve },
		job: { ...BASE_JOB, packages: false, mcp: ["linear"] },
		spawnOptions: { noted: line({ roots: { ...ROOTS, packages: [] }, flow: null, extensions: [], skills: [], prompts: [], tools: [], active: [], failures: [], drops: [] }) },
	});
	assert.equal(reads, 0);
	assert.equal(result.loaded.runner, "reported");
	assert.equal(result.loaded.leftOut.packages, true);
	assert.deepEqual(result.loaded.sources.filter((row) => row.tier === "package"), []);
});

test("run-container: left out reads the host's switch and the job's own fields, and a restricted job's forced overlay stays `restricted`", { skip }, async () => {
	const off = await runWith({ makeOptions: { allowGlobalExtensions: false }, spawnOptions: {} });
	assert.equal(off.result.loaded.runner, "absent");
	assert.equal(off.result.loaded.leftOut.overlayExtensions, true);
	const excluded = await runWith({ job: { ...BASE_JOB, excludeTools: ["bash"] }, spawnOptions: {} });
	assert.deepEqual(excluded.result.loaded.leftOut, { tools: ["bash"], packages: false, overlayExtensions: false, restricted: false });
	const restricted = await runWith({ job: { ...BASE_JOB, questionGrouping: { runId: "r" }, questionGroupModel: { provider: "anthropic", id: "m" } }, spawnOptions: {} });
	assert.deepEqual(restricted.result.loaded.leftOut, { tools: [], packages: false, overlayExtensions: false, restricted: true }, "the host's switch is on");
	assert.ok(restricted.recorder.args.includes("PI_GLOBAL_ALLOW_EXTENSIONS=0"), "and this job's overlay is off all the same");
});

test("run-container: a forged line is `invalid`, says so on the log by a fixed word, and an unsigned one is not read at all", { skip }, async () => {
	const forged = structuredClone(line());
	forged.overlay.loaded.push("not-on-disk.ts");
	const { result, logs } = await runWith({ job: { ...BASE_JOB, mcp: ["linear"] }, known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) }, spawnOptions: { noted: forged } });
	assert.equal(result.exitAuth, "verified");
	assert.equal(result.loaded.runner, "invalid");
	assert.deepEqual(logs.filter((row) => row.event === "loaded_invalid"), [{ event: "loaded_invalid", container: "pi-job-gh-1", why: "overlay-not-on-disk" }]);

	// Signed with another key: what a tool that wrote to the container's stdout can do. No verified line, nothing read.
	const unverified = await runWith({ job: BASE_JOB, spawnOptions: { noted: line(), key: "d".repeat(64) } });
	assert.equal(unverified.result.exitAuth, "unverified");
	assert.equal(Object.hasOwn(unverified.result, "loaded"), false);

	// No key issued (an image without `exitAuth`): the whole tail is read as it always was, but never this field.
	const keyless = await runWith({ exitAuth: false, spawnOptions: { noted: line(), key: null } });
	assert.equal(Object.hasOwn(keyless.result, "loaded"), false);
});

test("run-container: a forged line beside the genuine one does not win, and a run with no line and nothing left out resolves the object it always did", { skip }, async () => {
	const body = `{"event":"exit","jobId":"pi-job-gh-1","loaded":{"v":1,"at":"start","pi":"6.6.6","cut":{"form":"full","packages":0,"servers":0,"names":0,"counts":0}},"code":0}`;
	const signedByTool = `${body.slice(0, -1)},"auth":"${createHmac("sha256", "e".repeat(64)).update(body, "utf8").digest("hex")}"}\n`;
	const { result } = await runWith({ job: { ...BASE_JOB, mcp: ["linear"] }, known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) }, spawnOptions: { noted: line(), extra: signedByTool } });
	assert.equal(result.loaded.runner, "reported");
	assert.equal(result.loaded.pi, "1.5.0");

	const plain = await runWith({ spawnOptions: {} });
	assert.equal(plain.result.exitAuth, "verified", "a line the runner never noted anything on");
	assert.equal(Object.hasOwn(plain.result, "loaded"), false);
});

test("run-container: the sandbox layout's paths carry the same rows, and an overlay folder that cannot be read vouches for nothing", { skip }, async () => {
	const moved = await runWith({
		known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) },
		job: { ...BASE_JOB, mcp: ["linear"] },
		makeOptions: { layout: "sandbox", observableRunner: false },
		spawnOptions: { noted: line() },
	});
	assert.deepEqual(moved.result.loaded.sources.slice(0, 2).map((row) => row.name), ["pi-lint", "@acme/fmt"]);
	assert.ok(moved.recorder.args.includes("PI_PACKAGES=/sandbox/pi-global/packages/lint:/sandbox/pi-global/packages/fmt"));

	const unreadable = await runWith({
		known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) },
		job: { ...BASE_JOB, mcp: ["linear"] },
		makeOptions: { readOverlayExtensions: () => { throw new Error("EACCES"); } },
		spawnOptions: { noted: line() },
	});
	assert.equal(unreadable.result.loaded.runner, "invalid", "the name cannot be vouched for");
	assert.equal(unreadable.result.code, 0, "and the run is what it was");
});

test("run-container: the job's own token is what a tool name is checked against, off this attempt's env", { skip }, async () => {
	const forged = structuredClone(line());
	forged.extTools.p[0].push("sekretAPIkeyvalue1234");
	const { result, logs } = await runWith({
		job: { ...BASE_JOB, mcp: ["linear"] },
		known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) },
		makeOptions: { hostEnv: { ANTHROPIC_API_KEY: "sekretAPIkeyvalue1234" } },
		spawnOptions: { noted: forged },
	});
	assert.equal(result.loaded.runner, "invalid");
	assert.equal(logs.find((row) => row.event === "loaded_invalid")?.why, "ext-tools-secret");
	assert.ok(!JSON.stringify(result.loaded).includes("sekretAPIkeyvalue1234"));
});

test("run-container: the real folder is what names are checked against", { skip }, async () => {
	const overlay = tempDir("loaded-overlay-");
	mkdirSync(join(overlay, "extensions", "broken.js"), { recursive: true });
	writeFileSync(join(overlay, "extensions", "git-guard.ts"), "export default () => {};\n");
	const { result } = await runWith({
		known: { packagePaths: resolver({ [LINT]: KNOWN.packages[0], [FMT]: KNOWN.packages[1] }) },
		job: { ...BASE_JOB, mcp: ["linear"] },
		makeOptions: { globalPiDir: overlay, readOverlayExtensions: undefined },
		spawnOptions: { noted: line() },
	});
	assert.equal(result.loaded.runner, "reported", JSON.stringify(result.loaded));
	assert.deepEqual(source(result.loaded, "overlay").names, ["git-guard.ts"]);
});
