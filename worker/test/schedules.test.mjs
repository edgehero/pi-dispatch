import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSchedules } from "../src/schedules.mjs";

// loadSchedules selects the cron subset of the unified triggers file over injected fs -- no real
// filesystem, no bullmq. The shared validator (triggers.test.mjs) owns the exhaustive validation cases;
// here we cover selection, the folder-existence check, and normalization to the scheduler shape.
const CONFIG = { triggersFile: "/triggers.json" };

const CRON = { on: { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "run the tidy pass" } };
const LABEL = { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } };
const PR = { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "review" } };

// Serialize `triggers` and feed them through injected fakes. existsSync defaults to true for both the
// triggers file and every folder; override it to fail a specific path.
function load(triggers, { existsSync = () => true, config = CONFIG } = {}) {
	return loadSchedules(config, {
		readFileSync: () => JSON.stringify({ triggers }),
		existsSync,
	});
}

const isConfigError = (e) => e.piDispatchConfig === true;

test("null triggersFile -> [] (cron disabled)", () => {
	assert.deepEqual(loadSchedules({ ...CONFIG, triggersFile: null }, { readFileSync: () => "", existsSync: () => true }), []);
});

test("absent triggersFile -> [] (cron disabled)", () => {
	const { triggersFile, ...rest } = CONFIG;
	assert.deepEqual(loadSchedules(rest, { readFileSync: () => "", existsSync: () => true }), []);
});

test("set-but-missing triggers file is a config error naming the path", () => {
	assert.throws(
		() => loadSchedules(CONFIG, { readFileSync: () => "", existsSync: () => false }),
		(e) => isConfigError(e) && e.message.includes("/triggers.json"),
	);
});

test("malformed JSON is a config error naming the file", () => {
	assert.throws(
		() => loadSchedules(CONFIG, { readFileSync: () => "{ not json", existsSync: () => true }),
		(e) => isConfigError(e) && e.message.includes("/triggers.json"),
	);
});

test("only cron entries are selected; webhook triggers are ignored by the worker", () => {
	const result = load([LABEL, CRON, PR]);
	assert.equal(result.length, 1);
	assert.equal(result[0].schedulerId, "nightly-tidy");
});

test("a triggers file with no cron entries -> [] (worker cron disabled)", () => {
	assert.deepEqual(load([LABEL, PR]), []);
});

test("nonexistent run.folder (existsSync -> false) is a config error naming the folder", () => {
	// The triggers file exists; only the folder is missing.
	assert.throws(() => load([CRON], { existsSync: (p) => p === "/triggers.json" }), (e) => isConfigError(e) && e.message.includes("/proj"));
});

test("a valid cron trigger normalizes to the scheduler shape; omitted provider/model/maxTurns pass through absent", () => {
	const [s] = load([CRON]);

	assert.equal(s.schedulerId, "nightly-tidy");
	assert.equal(s.name, "local");
	assert.equal(s.pattern, "0 3 * * *");

	assert.deepEqual(s.data, {
		kind: "local",
		folder: "/proj",
		flow: "tidy",
		task: "run the tidy pass",
		provider: undefined,
		model: undefined,
		maxTurns: undefined,
		github: undefined,
		// `packages` is asserted PRESENT-and-undefined, not omitted: this is a whole-object deepEqual under
		// assert/strict, which counts an own key holding undefined, and the normalizer builds the key by
		// construction. Asserting it honestly pins the real shape -- the key exists, the flag does not --
		// and JSON serialization still drops it, so the upserted schedule stays byte-identical to today's.
		packages: undefined,
		image: undefined,
		// Same present-and-undefined shape, for the same reason. An unflagged schedule stays byte-identical
		// to today's once serialized, so a cron trigger that never asked to resume writes nothing to disk.
		resume: undefined,
		// The cron-only field carried into the local /job/event.json (INT-CONTAINER-JOB-INPUTS).
		trigger: { id: "nightly-tidy", pattern: "0 3 * * *" },
	});

	// opts: retention only -- no jobId, attempts, or backoff.
	assert.equal("jobId" in s.opts, false);
	assert.equal("attempts" in s.opts, false);
	assert.equal("backoff" in s.opts, false);
	assert.equal(s.opts.removeOnComplete.age, 24 * 3600);
	assert.equal(s.opts.removeOnFail.age, 7 * 24 * 3600);
});

test("run-level provider/model/maxTurns pass through verbatim into data", () => {
	const [s] = load([{ ...CRON, run: { ...CRON.run, provider: "openai", model: "gpt-x", maxTurns: 5 } }]);
	assert.equal(s.data.provider, "openai");
	assert.equal(s.data.model, "gpt-x");
	assert.equal(s.data.maxTurns, 5);
});

test("run.github: true flows into the scheduler data (the token opt-in reaches the job template)", () => {
	const [s] = load([{ ...CRON, run: { ...CRON.run, github: true } }]);
	assert.equal(s.data.github, true);
});

test("an unflagged cron trigger's data.github is undefined -- drops out at JSON serialization, schedule byte-identical to today's", () => {
	const [s] = load([CRON]);
	assert.equal(s.data.github, undefined);
});

test("run.packages: true flows into the scheduler data (the pi-packages opt-in reaches the job template)", () => {
	const [s] = load([{ ...CRON, run: { ...CRON.run, packages: true } }]);
	assert.equal(s.data.packages, true);
	const [f] = load([{ ...CRON, run: { ...CRON.run, packages: false } }]);
	assert.equal(f.data.packages, false, "an explicit opt-out reaches the template too, never coerced away");
});

test("an unflagged cron trigger's data.packages is undefined -- no third-party code by default", () => {
	const [s] = load([CRON]);
	assert.equal(s.data.packages, undefined);
});

test("run.image flows into the scheduler data -- the toolchain reaches the job template", () => {
	const [s] = load([{ ...CRON, run: { ...CRON.run, image: "my-python:1.2.0" } }]);
	assert.equal(s.data.image, "my-python:1.2.0");
});

test("an unflagged cron trigger's data.image is undefined -- the deployment default is resolved at job start", () => {
	// Writing PI_JOB_IMAGE in here would freeze today's default into every stored repeatable, so an operator
	// changing the deployment image would silently keep running the old one on every existing schedule.
	const [s] = load([CRON]);
	assert.equal(s.data.image, undefined);
});

test("github and packages reach the scheduler data independently -- neither opt-in implies the other", () => {
	const [s] = load([{ ...CRON, run: { ...CRON.run, github: true, packages: true } }]);
	assert.equal(s.data.github, true);
	assert.equal(s.data.packages, true);
	const [g] = load([{ ...CRON, run: { ...CRON.run, github: true } }]);
	assert.equal(g.data.packages, undefined, "a token opt-in must not smuggle in third-party code");
});

test("run.command rides the cron data; flow/task hold undefined and drop at serialization", () => {
	// Issue #189. A command trigger carries no flow/task at all (the validator enforces the XOR), so the
	// normalizer's unconditional flow/task keys hold undefined here and JSON serialization drops them --
	// the stored repeatable's data is exactly kind/folder/command plus the shared fields.
	const CMD = { on: { type: "cron", id: "nightly-cmd", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", command: "wf run nightly" } };
	const [s] = load([CMD]);
	assert.equal(s.data.command, "wf run nightly");
	assert.equal(s.data.flow, undefined);
	assert.equal(s.data.task, undefined);
	assert.equal(s.data.folder, "/proj");
});

test("a flow trigger's data grows NO command key -- byte-identical to before the feature", () => {
	// `in` rather than an undefined compare: the conditional spread must not even create the key, or a
	// present-and-undefined command would survive the whole-object deepEqual pin above by accident.
	const [s] = load([CRON]);
	assert.equal("command" in s.data, false);
});

test("multiple valid cron entries with distinct ids all normalize in order", () => {
	const result = load([CRON, { ...CRON, on: { type: "cron", id: "weekly-audit", pattern: "0 4 * * 0" } }]);
	assert.equal(result.length, 2);
	assert.deepEqual(result.map((s) => s.schedulerId), ["nightly-tidy", "weekly-audit"]);
});

test("the diagonal is enforced at load: a cron -> github trigger throws", () => {
	assert.throws(() => load([{ ...CRON, run: { ...CRON.run, kind: "github" } }]), isConfigError);
});
