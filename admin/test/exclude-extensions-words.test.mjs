import assert from "node:assert/strict";
import { test } from "node:test";
import { loadedFold, loadedOf, loadedRows, loadedVerdict, LOADED_WORDS, projectLoadsOf } from "../src/loaded-words.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";

/**
 * What a person reads of `run.excludeExtensions` and `run.excludeExtensionTools` (issue #800), on records made the way production makes them. A
 * trigger choosing one extension breaks what the project card used to take as a host's fact, so each sentence is tried against each shape that reaches it.
 */
const STOP = { code: 2, reason: "exclude-tool-not-loaded", message: "run.excludeExtensionTools names a tool" };
const FINE = { code: 0, reason: "stop" };
const rowValues = (record) => loadedRows(record).map((row) => JSON.stringify(row));

test("a stop for a name that matched nothing keeps its reason, and reads as what it was", async () => {
	const record = await recordThroughPipeline({ exit: STOP, jobFields: { excludeExtensionTools: ["lint_run", "typo_tool"] }, unmatched: [1] });
	assert.equal(record.reason, "exclude-tool-not-loaded", "not folded into runner-policy");
	assert.equal(record.outcome, "policy");
	assert.equal(record.budgetReserved, true, "the job-count slot stays held");
	const loaded = loadedOf(record);
	assert.equal(loaded.at, "ready");
	assert.deepEqual(loaded.tools.unmatched, ["typo_tool"]);
	const said = loadedVerdict(record);
	assert.equal(said.state, "stopped");
	assert.equal(said.rest, LOADED_WORDS.stoppedAfterLoading);
	assert.doesNotMatch(JSON.stringify(said), /Everything/, "what it asked for did not all hold");
});

test("left out by name is said as chosen, each kind by its own field, and nothing else on the line moves", async () => {
	const record = await recordThroughPipeline({ exit: FINE, jobFields: { excludeTools: ["bash"], excludeExtensions: ["pi-lint", "typo"], excludeExtensionTools: ["lint_run"] }, excludedNotHere: ["typo"], packages: [] });
	const said = loadedVerdict(record);
	assert.equal(said.state, "left-out");
	assert.equal(said.bold, "Left out, as it asks:");
	assert.equal(said.rest, "bash, lint_run and pi-lint.");
	assert.deepEqual(said.then, [{ bold: "Named to leave out, and not on this host:", rest: "typo." }]);
	assert.match(rowValues(record).join("\n"), /read; bash and lint_run removed/);
});

test("a name that matched nothing, on a job that ran, is said beside what it left out", async () => {
	const record = await recordThroughPipeline({ exit: FINE, jobFields: { packages: false, excludeExtensionTools: ["typo_tool"] }, unmatched: [0], packages: [] });
	const said = loadedVerdict(record);
	assert.equal(said.state, "left-out");
	assert.deepEqual([said.bold, said.rest], ["Left out, as it asks:", "typo_tool, and the staged packages."]);
	assert.deepEqual(said.then, [{ bold: "Named to remove, and no extension had registered it:", rest: "typo_tool." }]);
});

test("on an image that cannot leave either out, the run is refused and reads as refused, for free", async () => {
	for (const jobFields of [{ excludeExtensions: ["pi-lint"] }, { excludeExtensionTools: ["lint_run"] }]) {
		const record = await recordThroughPipeline({ exit: FINE, hostImage: "pi-job:old", jobFields });
		assert.equal(record.reason, "job-image-load-exclusions-unsupported", JSON.stringify(jobFields));
		assert.equal(record.budgetReserved, false);
		assert.equal(loadedVerdict(record).rest, LOADED_WORDS.refused);
	}
	const fine = await recordThroughPipeline({ exit: FINE, hostImage: "pi-job:old" });
	assert.equal(fine.outcome, "completed", "a job with neither field is not asked");
});

test("the fold names each, under the field that asked for it", async () => {
	const record = await recordThroughPipeline({ exit: FINE, jobFields: { excludeExtensions: ["pi-lint", "typo"], excludeExtensionTools: ["lint_run", "typo_tool"] }, excludedNotHere: ["typo"], unmatched: [1], packages: [] });
	const rows = loadedFold(record).map((row) => JSON.stringify(row));
	const row = (kind, name, why) => rows.some((line) => line.includes(kind) && line.includes(name) && line.includes(why));
	assert.ok(row("Left out", "pi-lint", "run.excludeExtensions"), rows.join("\n"));
	assert.ok(row("Left out", "lint_run", "run.excludeExtensionTools"));
	assert.ok(row("Not on this host", "typo", "run.excludeExtensions names it"));
	assert.ok(row("Matched nothing", "typo_tool", "run.excludeExtensionTools names it"));
	assert.ok(!rows.some((line) => line.includes("Left out") && line.includes("\"typo\"")), "a name this host holds neither way was not left out");
});

test("a run with neither field reads as it always did", async () => {
	const record = await recordThroughPipeline({ exit: FINE });
	assert.equal(loadedVerdict(record).state, "everything");
	assert.equal(Object.hasOwn(loadedOf(record).leftOut ?? {}, "extensions"), false);
});

const onHost = (host, over = {}) => recordThroughPipeline({ jobId: `gh-${host}-${over.jobFields ? "x" : "p"}`, host, exit: FINE, hostImage: "pi-job:4.3.1", imageCapabilities: "loadExclusions", ...over });
const FULL = { packages: [{ name: "pi-lint", version: "1.4.2" }], overlay: ["guard.ts"] };

test("the project card: an extension a trigger left out is no difference between hosts", async () => {
	const lint = { name: "pi-lint", version: "1.4.2" };
	// The control: two hosts' runs, each showing the whole of what it loaded, one without the package, really differ.
	const control = projectLoadsOf([await onHost("mini1", FULL), await onHost("mini2", { packages: [], overlay: ["guard.ts"] })]);
	assert.equal(control.state, "differs");
	// The same second host, but its trigger left the package out: it says nothing of what mini2 holds.
	const excluded = projectLoadsOf([await onHost("mini1", FULL), await onHost("mini2", { packages: [], overlay: ["guard.ts"], jobFields: { excludeExtensions: ["pi-lint"] } })]);
	assert.notEqual(excluded.state, "differs", JSON.stringify(excluded.top));
	assert.ok(excluded.small.some((line) => line === "The runs on mini2 left an extension out by name, so they say nothing of what their host holds."), JSON.stringify(excluded.small));
	assert.equal(excluded.tone, "idle", "a choice is nothing to look into");
	// Excluding an overlay entry is the same statement of the overlay.
	const overlayExcluded = projectLoadsOf([await onHost("mini1", FULL), await onHost("mini2", { packages: [lint], overlay: [], jobFields: { excludeExtensions: ["guard"] } })]);
	assert.notEqual(overlayExcluded.state, "differs");
	// A run elsewhere on that host that shows the whole lists still speaks for it, and a real difference is still read.
	const elsewhere = await onHost("mini2", { packages: [], overlay: ["guard.ts"] });
	const stillDiffers = projectLoadsOf([await onHost("mini1", FULL), elsewhere, await onHost("mini2", { packages: [], overlay: ["guard.ts"], jobFields: { excludeExtensions: ["pi-lint"] } })]);
	assert.equal(stillDiffers.state, "differs");
});

test("the project card: a name its host does not hold left nothing out, so that run still speaks for it", async () => {
	const notHere = await onHost("mini2", { packages: [], overlay: ["guard.ts"], jobFields: { excludeExtensions: ["pi-lint"] }, excludedNotHere: ["pi-lint"] });
	assert.deepEqual(loadedOf(notHere).leftOut.extensionsNotHere, ["pi-lint"]);
	assert.equal(projectLoadsOf([await onHost("mini1", FULL), notHere]).state, "differs", "mini2 really has no such package, and the host says so");
});

test("the project card: a tool left out says nothing of a host, so that run still speaks for it", async () => {
	const toolOnly = await onHost("mini2", { packages: [], overlay: ["guard.ts"], jobFields: { excludeExtensionTools: ["guard_check"] } });
	assert.equal(projectLoadsOf([await onHost("mini1", FULL), toolOnly]).state, "differs");
	const same = await onHost("mini2", { ...FULL, jobFields: { excludeExtensionTools: ["guard_check"] } });
	assert.equal(projectLoadsOf([await onHost("mini1", FULL), same]).state, "same");
});
