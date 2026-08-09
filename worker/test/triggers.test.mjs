import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggers } from "../src/triggers.mjs";

// parseTriggers is pure over the file TEXT -- no fs, no bullmq. `parse` serializes triggers and feeds
// them through with a stable path for the "names the path" assertions.
const PATH = "/triggers.json";
const parse = (triggers) => parseTriggers(JSON.stringify({ triggers }), PATH);
const isConfigError = (e) => e.piDispatchConfig === true;

const CRON = { on: { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "run the tidy pass" } };
const LABEL = { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } };
const COMMENT = { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } };
const PR_LABELED = { on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } };
const PR_AUTO = { on: { type: "pull_request", action: ["opened", "synchronize"] }, run: { kind: "github", flow: "review" } };

test("invalid JSON is a config error naming the path", () => {
	assert.throws(() => parseTriggers("{ not json", PATH), (e) => isConfigError(e) && e.message.includes(PATH));
});

test('missing "triggers" array is a config error naming the path', () => {
	assert.throws(() => parseTriggers(JSON.stringify({ nope: [] }), PATH), (e) => isConfigError(e) && e.message.includes(PATH));
});

test("empty triggers array is valid -> []", () => {
	assert.deepEqual(parse([]), []);
});

test("unknown top-level keys are ignored (deploy/triggers.json carries a _note marker)", () => {
	// The parser reads only `parsed.triggers` -- pinned here because the shipped example file relies
	// on it: deploy/triggers.json opens with a "_note" key marking it as an example (issue #80), and
	// a stricter future parser silently breaking that file should fail THIS test, not an operator.
	const parsed = parseTriggers(JSON.stringify({ _note: "example file", triggers: [CRON] }), PATH);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].on.id, "nightly-tidy");
});

// --- diagonal: on x run trust boundary ---

test('cron -> github is rejected (a cron has no webhook payload)', () => {
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, kind: "github" } }]), (e) => isConfigError(e) && /local/.test(e.message));
});

test("label -> local is rejected (a webhook trigger produces a github job)", () => {
	assert.throws(() => parse([{ ...LABEL, run: { kind: "local", flow: "x" } }]), (e) => isConfigError(e) && /github/.test(e.message));
});

test("comment -> local and pull_request -> local are rejected", () => {
	assert.throws(() => parse([{ ...COMMENT, run: { kind: "local", flow: "x" } }]), (e) => isConfigError(e) && /github/.test(e.message));
	assert.throws(() => parse([{ ...PR_AUTO, run: { kind: "local", flow: "x" } }]), (e) => isConfigError(e) && /github/.test(e.message));
});

test("unknown on.type and unknown run.kind are config errors", () => {
	assert.throws(() => parse([{ on: { type: "push" }, run: { kind: "github", flow: "x" } }]), isConfigError);
	assert.throws(() => parse([{ ...LABEL, run: { kind: "remote", flow: "x" } }]), isConfigError);
});

test("a non-object entry / on / run is a config error", () => {
	assert.throws(() => parse([7]), isConfigError);
	assert.throws(() => parse([{ on: "x", run: { kind: "github", flow: "y" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "label" }, run: "x" }]), isConfigError);
});

// --- cron (ported from schedules.test.mjs) ---

test("a valid cron trigger normalizes; omitted provider/model/maxTurns/github/packages/image pass through absent", () => {
	const [t] = parse([CRON]);
	assert.deepEqual(t.on, { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" });
	assert.deepEqual(t.run, { kind: "local", folder: "/proj", flow: "tidy", task: "run the tidy pass", provider: undefined, model: undefined, maxTurns: undefined, github: undefined, packages: undefined, image: undefined, resume: undefined });
});

test("cron entry-level provider/model/maxTurns pass through verbatim", () => {
	const [t] = parse([{ ...CRON, run: { ...CRON.run, provider: "openai", model: "gpt-x", maxTurns: 5 } }]);
	assert.equal(t.run.provider, "openai");
	assert.equal(t.run.model, "gpt-x");
	assert.equal(t.run.maxTurns, 5);
});

test("a 6-field cron (with seconds) is accepted", () => {
	const [t] = parse([{ ...CRON, on: { ...CRON.on, pattern: "0 0 3 * * *" } }]);
	assert.equal(t.on.pattern, "0 0 3 * * *");
});

test("cron with wrong field count is a config error", () => {
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, pattern: "0 3 * *" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, pattern: "0 3 * * * * *" } }]), isConfigError);
});

test("missing / empty / non-string cron id is a config error", () => {
	assert.throws(() => parse([{ ...CRON, on: { type: "cron", pattern: "0 3 * * *" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: 7 } }]), isConfigError);
});

test('cron id containing ":" is a config error (would corrupt repeat:<id>:<millis>)', () => {
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "night:tidy" } }]), (e) => isConfigError(e) && e.message.includes(":"));
});

test("cron id with an out-of-charset character is a config error", () => {
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "night tidy" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, on: { ...CRON.on, id: "night/tidy" } }]), isConfigError);
});

test("duplicate cron id is a config error", () => {
	assert.throws(() => parse([CRON, { ...CRON, run: { ...CRON.run, folder: "/other" } }]), (e) => isConfigError(e) && /duplicate/.test(e.message));
});

test("cron run.github: true survives normalization (the per-trigger token opt-in)", () => {
	const [t] = parse([{ ...CRON, run: { ...CRON.run, github: true } }]);
	assert.equal(t.run.github, true);
	const [f] = parse([{ ...CRON, run: { ...CRON.run, github: false } }]);
	assert.equal(f.run.github, false);
});

test("cron run.github absent stays absent (undefined) -- the zero-GitHub default", () => {
	const [t] = parse([CRON]);
	assert.equal(t.run.github, undefined);
});

test('cron run.github that is not strictly boolean ("true", 1, null) is a config error naming the trigger', () => {
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, github: "true" } }]), (e) => isConfigError(e) && e.message.includes("nightly-tidy"));
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, github: 1 } }]), (e) => isConfigError(e) && e.message.includes("nightly-tidy"));
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, github: null } }]), (e) => isConfigError(e) && e.message.includes("nightly-tidy"));
});

test("cron missing folder / flow / task is a config error", () => {
	assert.throws(() => parse([{ ...CRON, run: { kind: "local", flow: "tidy", task: "t" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, run: { kind: "local", folder: "/proj", task: "t" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, run: { kind: "local", folder: "/proj", flow: "tidy", task: "   " } }]), isConfigError);
});

// --- label ---

test("a valid label trigger normalizes", () => {
	const [t] = parse([LABEL]);
	assert.deepEqual(t, { on: { type: "label", any: ["pi:frontend"], all: undefined, none: undefined }, run: { kind: "github", flow: "frontend-fix", packages: undefined, image: undefined, resume: undefined, replicas: undefined } });
});

test("label trigger with no positive selector (none-only) is a config error", () => {
	assert.throws(() => parse([{ on: { type: "label", none: ["blocked"] }, run: { kind: "github", flow: "x" } }]), (e) => isConfigError(e) && /positive selector/.test(e.message));
});

test("label selector that is not an array of non-empty strings is a config error", () => {
	assert.throws(() => parse([{ on: { type: "label", any: "pi:frontend" }, run: { kind: "github", flow: "x" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "label", any: ["", "ok"] }, run: { kind: "github", flow: "x" } }]), isConfigError);
});

test("label trigger missing run.flow is a config error", () => {
	assert.throws(() => parse([{ on: { type: "label", any: ["x"] }, run: { kind: "github" } }]), isConfigError);
});

// --- comment ---

test("a valid comment trigger normalizes", () => {
	const [t] = parse([COMMENT]);
	assert.deepEqual(t, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", packages: undefined, image: undefined, resume: undefined, replicas: undefined } });
});

test("comment trigger missing phrase or flow is a config error", () => {
	assert.throws(() => parse([{ on: { type: "comment" }, run: { kind: "github", flow: "fix" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github" } }]), isConfigError);
});

test("a second comment trigger is a config error (at most one)", () => {
	assert.throws(() => parse([COMMENT, { on: { type: "comment", phrase: "@bot" }, run: { kind: "github", flow: "fix" } }]), (e) => isConfigError(e) && /at most one/.test(e.message));
});

// --- pull_request ---

test("a valid labeled PR trigger normalizes with its predicate", () => {
	const [t] = parse([PR_LABELED]);
	assert.deepEqual(t, { on: { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: undefined, none: undefined }, run: { kind: "github", flow: "review", packages: undefined, image: undefined, resume: undefined, replicas: undefined } });
});

test("a labeled PR trigger with no positive selector is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["labeled"] }, run: { kind: "github", flow: "review" } }]), (e) => isConfigError(e) && /positive selector/.test(e.message));
});

test("an auto-only PR trigger (opened/synchronize) needs no predicate", () => {
	const [t] = parse([PR_AUTO]);
	assert.deepEqual(t.on.action, ["opened", "synchronize"]);
	assert.equal(t.run.flow, "review");
});

test("PR trigger with an empty or non-array action is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: [] }, run: { kind: "github", flow: "x" } }]), isConfigError);
	assert.throws(() => parse([{ on: { type: "pull_request", action: "opened" }, run: { kind: "github", flow: "x" } }]), isConfigError);
});

test("PR trigger with an unsupported action is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["closed"] }, run: { kind: "github", flow: "x" } }]), (e) => isConfigError(e) && /closed/.test(e.message));
});

test("PR trigger missing run.flow is a config error", () => {
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["opened"] }, run: { kind: "github" } }]), isConfigError);
});

// --- run.packages: the per-trigger pi-packages opt-OUT (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY) ---

// One shared validator serves all four kinds, so every case is asserted on all four: a normalizer that
// forgot to call it would pass three and fail exactly one. `mentions` is what the rejection must name --
// cron names its id, the webhook kinds their raw-file index -- so the operator can find the entry.
const KINDS = [
	{ kind: "cron", entry: CRON, mentions: "nightly-tidy" },
	{ kind: "label", entry: LABEL, mentions: "trigger at index 0" },
	{ kind: "comment", entry: COMMENT, mentions: "trigger at index 0" },
	{ kind: "pull_request", entry: PR_LABELED, mentions: "trigger at index 0" },
];
const withRun = (entry, over) => ({ ...entry, run: { ...entry.run, ...over } });

test("run.packages: true survives normalization on all four trigger kinds", () => {
	for (const { kind, entry } of KINDS) {
		const [t] = parse([withRun(entry, { packages: true })]);
		assert.equal(t.run.packages, true, `${kind} must carry the explicit opt-in`);
	}
});

test("run.packages: false -- the opt-out -- validates and survives on all four kinds", () => {
	// The only value that now withholds the staged packages from a job, so it must reach the worker intact
	// on every kind: a normalizer that dropped it would silently load third-party code the operator refused.
	for (const { kind, entry } of KINDS) {
		const [f] = parse([withRun(entry, { packages: false })]);
		assert.equal(f.run.packages, false, `${kind} must carry the opt-out`);
	}
});

test("run.packages absent stays absent (undefined) on all four kinds -- the default is resolved by the worker", () => {
	// Absent now MEANS load, but the file must not say so: writing a `true` in here would claim an opt-in the
	// operator never made, and would freeze today's default into every stored repeatable.
	for (const { kind, entry } of KINDS) {
		const [t] = parse([entry]);
		assert.equal(t.run.packages, undefined, `${kind} must not invent a default`);
	}
});

test('run.packages that is not strictly boolean ("true", "false", 1, null, {}) is a config error naming the trigger, on all four kinds', () => {
	// `"false"` matters most now: it is what an operator writes when they mean "no third-party code here",
	// and the worker's `!== false` reading would load everything anyway. Refusing the file is what keeps
	// that belief and the behaviour from diverging.
	for (const { kind, entry, mentions } of KINDS) {
		for (const bad of ["true", "false", 1, null, {}]) {
			assert.throws(
				() => parse([withRun(entry, { packages: bad })]),
				(e) => isConfigError(e) && e.message.includes(mentions) && /run\.packages/.test(e.message),
				`${kind} must refuse packages=${JSON.stringify(bad)}`,
			);
		}
	}
});

// --- run.image (issue #41): which container image this trigger's jobs run in ---

test("run.image survives normalization on all four trigger kinds", () => {
	// All four, not cron only: a toolchain is a capability of the FLOW, and a label/comment/PR trigger runs
	// the flows a cron trigger runs.
	for (const { kind, entry } of KINDS) {
		const [t] = parse([withRun(entry, { image: "my-python:1.2.0" })]);
		assert.equal(t.run.image, "my-python:1.2.0", `${kind} must carry its own image`);
	}
});

test("run.image absent stays absent (undefined) on all four kinds -- the deployment default is resolved by the worker", () => {
	for (const { kind, entry } of KINDS) {
		const [t] = parse([entry]);
		assert.equal(t.run.image, undefined, `${kind} must not freeze PI_JOB_IMAGE into the file`);
	}
});

test("run.image that is not a non-empty string is a config error naming the trigger, on all four kinds", () => {
	for (const { kind, entry, mentions } of KINDS) {
		for (const bad of ["", "   ", 1, null, true, {}, []]) {
			assert.throws(
				() => parse([withRun(entry, { image: bad })]),
				(e) => isConfigError(e) && e.message.includes(mentions) && /run\.image/.test(e.message),
				`${kind} must refuse image=${JSON.stringify(bad)}`,
			);
		}
	}
});

test("run.image with surrounding whitespace is REFUSED rather than trimmed", () => {
	// The file is the reviewed artifact: silently trimming would make it disagree with what runs, and the
	// operator diffs the file, not the argv. Its own message, separate from the empty case -- they are
	// different mistakes with different fixes.
	assert.throws(
		() => parse([withRun(CRON, { image: " pi-job:latest " })]),
		(e) => isConfigError(e) && /whitespace/.test(e.message),
	);
});

test('run.image starting with "-" is refused -- it would land where docker parses a flag', () => {
	// The image is the final argv positional. A leading dash is the one value that stops docker-run.mjs's
	// explicit-array argv from being injection-free by inspection.
	assert.throws(
		() => parse([withRun(CRON, { image: "--privileged" })]),
		(e) => isConfigError(e) && /run\.image/.test(e.message) && /flag/.test(e.message),
	);
});

test("a plausible-but-unbuildable image reference is ACCEPTED -- shape is docker's business, existence is the preflight's", () => {
	// This test exists to PIN the decision not to regex the OCI reference grammar. A regex would refuse the
	// rarer half of the problem (a malformed name) while missing the common half (a well-formed name for an
	// image nobody built), and an over-strict one would take the worker down at boot for a valid deployment.
	// A future contributor cannot "tighten" this without deleting an explicit assertion.
	for (const ref of ["registry.internal:5000/team/img:1.2", "ghcr.io/org/img@sha256:abc", "pi-job:latest", "img", "foo:", "localhost:5000/x"]) {
		const [t] = parse([withRun(CRON, { image: ref })]);
		assert.equal(t.run.image, ref, `${ref} is docker's to judge, not ours`);
	}
});

test("run.image and run.packages are independent on all four kinds", () => {
	for (const { kind, entry } of KINDS) {
		const [t] = parse([withRun(entry, { image: "my-python:1.2.0", packages: false })]);
		assert.equal(t.run.image, "my-python:1.2.0", `${kind}: declining packages must not cost the image`);
		assert.equal(t.run.packages, false, `${kind}: naming an image must not re-arm the packages`);
	}
});

test("cron run.github (opt-in) and run.packages (opt-out) are independent and coexist", () => {
	const [both] = parse([withRun(CRON, { github: true, packages: false })]);
	assert.equal(both.run.github, true);
	assert.equal(both.run.packages, false);
	// Neither flag implies the other: a token opt-in must not smuggle in third-party code, and refusing the
	// packages must not cost a trigger its scoped token.
	const [g] = parse([withRun(CRON, { github: true })]);
	assert.equal(g.run.packages, undefined);
	const [p] = parse([withRun(CRON, { packages: false })]);
	assert.equal(p.run.github, undefined);
});

// --- mixed file ---

test("a mixed file of all four types validates and preserves order", () => {
	const result = parse([CRON, LABEL, COMMENT, PR_LABELED, PR_AUTO]);
	assert.equal(result.length, 5);
	assert.deepEqual(result.map((t) => t.on.type), ["cron", "label", "comment", "pull_request", "pull_request"]);
});

// --- the forge a webhook trigger names (issue #42) ---

const GL_LABEL = { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "gitlab", flow: "frontend-fix" } };
const GL_COMMENT = { on: { type: "comment", phrase: "@pi" }, run: { kind: "gitlab", flow: "fix" } };
const GL_MR = { on: { type: "pull_request", action: ["open", "update"] }, run: { kind: "gitlab", flow: "review" } };

test("a webhook trigger may name gitlab, and the kind survives onto the normalized run", () => {
	for (const entry of [GL_LABEL, GL_COMMENT, GL_MR]) {
		const [t] = parse([entry]);
		assert.equal(t.run.kind, "gitlab", `${entry.on.type}: the forge the operator named must be the forge that is stored`);
	}
});

test("the on x run matrix still refuses local for a webhook type, and any forge for cron", () => {
	for (const entry of [LABEL, COMMENT, PR_LABELED]) {
		assert.throws(
			() => parse([{ ...entry, run: { ...entry.run, kind: "local" } }]),
			isConfigError,
			`${entry.on.type}: a webhook trigger is adversarial input and must never produce a local run`,
		);
	}
	// A cron trigger carries no delivery id, number, title or body -- true of every forge, not just github.
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, kind: "gitlab" } }]), isConfigError);
	assert.throws(() => parse([{ ...CRON, run: { ...CRON.run, kind: "github" } }]), isConfigError);
});

test("an unknown forge is refused, and the message names every kind that IS allowed", () => {
	assert.throws(
		() => parse([{ ...LABEL, run: { ...LABEL.run, kind: "bitbucket" } }]),
		(e) => isConfigError(e) && e.message.includes("local|github|gitlab"),
	);
});

test("pull_request actions are validated against the vocabulary of the forge the entry names", () => {
	// The sharp case: neither word is malformed, each is simply the OTHER forge's. Left unrefused, the
	// trigger loads clean and then never matches an event -- a silently dead trigger, not an error.
	assert.throws(
		() => parse([{ on: { type: "pull_request", action: ["synchronize"] }, run: { kind: "gitlab", flow: "review" } }]),
		(e) => isConfigError(e) && e.message.includes("gitlab") && e.message.includes("open|update|reopen|approved"),
		"a github action word on a gitlab trigger must refuse at load",
	);
	assert.throws(
		() => parse([{ on: { type: "pull_request", action: ["update"] }, run: { kind: "github", flow: "review" } }]),
		// The FULL github vocabulary, not a prefix of it. `.includes` on a shorter string would still pass
		// against a message that had grown a word, which is exactly how a new action ships unpinned.
		(e) => isConfigError(e) && e.message.includes("github") && e.message.includes("labeled|opened|synchronize|reopened|review_submitted"),
		"a gitlab action word on a github trigger must refuse at load",
	);
});

test("review_submitted is a github pull_request action, and needs no positive selector", () => {
	// It is not the label action, so `requirePositive` never engages -- an unpredicated review rule loads
	// exactly as an `opened`-only one does.
	const [t] = parse([{ on: { type: "pull_request", action: ["review_submitted"] }, run: { kind: "github", flow: "address-review" } }]);
	assert.deepEqual(t.on.action, ["review_submitted"]);
	assert.equal("reviewState" in t.on, false, "an unnarrowed rule normalizes with no reviewState key at all");
});

test("review_submitted is refused on every forge but github -- it is GitHub's word, not a shared one", () => {
	for (const kind of ["gitlab", "forgejo", "azure"]) {
		assert.throws(
			() => parse([{ on: { type: "pull_request", action: ["review_submitted"] }, run: { kind, flow: "review" } }]),
			(e) => isConfigError(e) && e.message.includes(kind),
			`review_submitted must refuse at load on ${kind}`,
		);
	}
});

test("on.reviewState narrows a review rule, and normalizes to its own array", () => {
	const [t] = parse([{ on: { type: "pull_request", action: ["review_submitted"], reviewState: ["changes_requested", "approved"] }, run: { kind: "github", flow: "address-review" } }]);
	assert.deepEqual(t.on.reviewState, ["changes_requested", "approved"]);
});

test("every on.reviewState refusal is fail-loud at load, because a dead narrowing looks configured", () => {
	const cases = [
		[{ type: "pull_request", action: ["review_submitted"], reviewState: ["merged"] }, "github", "unsupported review state", "a word GitHub never reports"],
		[{ type: "pull_request", action: ["review_submitted"], reviewState: [] }, "github", "non-empty array", "an empty list narrows to nothing and would refuse every review"],
		[{ type: "pull_request", action: ["review_submitted"], reviewState: "approved" }, "github", "non-empty array", "a bare string is not the array shape"],
		[{ type: "pull_request", action: ["opened", "synchronize"], reviewState: ["approved"] }, "github", "review_submitted", "beside auto actions it reads as a narrowing and does the opposite"],
		[{ type: "pull_request", action: ["approved"], reviewState: ["approved"] }, "gitlab", "github-only", "no other forge reports a review verdict"],
	];
	for (const [on, kind, needle, why] of cases) {
		assert.throws(
			() => parse([{ on, run: { kind, flow: "review" } }]),
			(e) => isConfigError(e) && e.message.includes(needle),
			`${JSON.stringify(on.reviewState)} on ${kind}: ${why}`,
		);
	}
});

test("gitlab merge-request actions load, including the one with no github counterpart", () => {
	const [t] = parse([{ on: { type: "pull_request", action: ["open", "update", "reopen", "approved"] }, run: { kind: "gitlab", flow: "review" } }]);
	assert.deepEqual(t.on.action, ["open", "update", "reopen", "approved"]);
});

test("a label trigger needs a positive selector on EVERY forge -- a none-only rule fires on any label change", () => {
	for (const kind of ["github", "gitlab"]) {
		assert.throws(
			() => parse([{ on: { type: "label", none: ["blocked"] }, run: { kind, flow: "fix" } }]),
			isConfigError,
			`${kind}: a none-only label rule matches every labelling event, which is wider than an allowlist`,
		);
	}
});

test("an unpredicated gitlab MR rule loads, where an unpredicated github `labeled` rule does not", () => {
	// Not an inconsistency: a github `labeled` rule has ONLY its predicate as the approval gate, so a rule
	// without one is ungated. Every gitlab trigger is additionally gated on the actor's resolved access
	// level, so there is no ungated case for the predicate to have to close.
	assert.doesNotThrow(() => parse([GL_MR]));
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["labeled"] }, run: { kind: "github", flow: "review" } }]), isConfigError);
});

test("the one-comment-trigger cap is PER FORGE: two of a kind refuse, one of each is fine", () => {
	assert.doesNotThrow(() => parse([COMMENT, GL_COMMENT]), "a deployment serving both forges may answer @pi on each");
	for (const [a, b] of [[COMMENT, COMMENT], [GL_COMMENT, GL_COMMENT]]) {
		assert.throws(
			() => parse([a, b]),
			(e) => isConfigError(e) && e.message.includes(a.run.kind),
			`two ${a.run.kind} comment triggers are ambiguous -- the receiver holds one per forge, so the second would be unreachable`,
		);
	}
});

test("a mixed-forge file validates and preserves order, and each entry keeps its own forge", () => {
	const result = parse([CRON, LABEL, GL_LABEL, COMMENT, GL_COMMENT, PR_LABELED, GL_MR]);
	assert.deepEqual(result.map((t) => t.run.kind), ["local", "github", "gitlab", "github", "gitlab", "github", "gitlab"]);
});

test("run.resume is an opt-IN, carried on every trigger kind that can honour it", () => {
	// Polarity is the OPPOSITE of run.packages, deliberately: staging a package is an operator act already
	// performed, so a trigger opts OUT; persisting a transcript is a disclosure, so a trigger opts IN.
	//
	// The three WEBHOOK kinds, not all four. Cron is refused at load by the test below -- `resolveSession`
	// reaches only the forge preparers, so an armed cron trigger would arm nothing.
	const [label, comment, pr] = parse([
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix", resume: true } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", resume: true } },
		{ on: { type: "pull_request", action: ["synchronize"] }, run: { kind: "github", flow: "review", resume: true } },
	]);
	for (const t of [label, comment, pr]) assert.equal(t.run.resume, true, `${t.on.type} must carry run.resume`);
});

test("run.resume: true on a cron trigger refuses at load, naming the field and the trigger kind", () => {
	// The defect this closes: the flag was accepted, documented, rode onto job data (schedules.mjs) and did
	// exactly nothing -- `resolveSession` is passed only to the forge preparers (prepare.mjs), the local
	// branch returns before it is in scope, and prepare-local.mjs has no session code. Accepted-and-ignored
	// is how an operator comes to trust a field that does nothing, which is validateReplicas' own argument.
	assert.throws(
		() => parse([withRun(CRON, { resume: true })]),
		(e) => isConfigError(e) && /run\.resume/.test(e.message) && /cron trigger/.test(e.message) && e.message.includes("nightly-tidy") && e.message.includes(PATH),
		"a cron trigger that armed run.resume must fail loud at load, naming itself",
	);
	// NOT YET COVERED, not impossible -- validateReplicas' distinction, and the two are different facts.
	// The local key exists (session-key.mjs keys a cron job on its scheduler id); nothing reaches it.
	assert.throws(() => parse([withRun(CRON, { resume: true })]), (e) => /not yet covered/.test(e.message) && !/never|impossible/.test(e.message));
});

test("resume:false and absent still normalize on a cron trigger, byte-identically to today", () => {
	// The property that must not regress. Only `true` is refused: `false` IS the documented default, so
	// refusing it would refuse an operator for writing down the behaviour they already have -- and both
	// values still have to reach schedules.mjs's `data` unchanged.
	const [absent] = parse([CRON]);
	assert.equal(absent.run.resume, undefined);
	assert.equal("resume" in absent.run, true, "the key stays present-and-undefined, so a consumer reads one shape");
	const [explicit] = parse([withRun(CRON, { resume: false })]);
	assert.equal(explicit.run.resume, false, "an explicit false is preserved, not collapsed to absent");
	// The whole normalized entry, keys and values, against the unflagged one -- a pin on the SHAPE rather
	// than on the one field, because `data` is built by spreading these.
	assert.deepEqual(Object.keys(explicit.run), Object.keys(absent.run));
	assert.deepEqual({ ...explicit.run, resume: undefined }, absent.run);
});

test("an unflagged trigger normalizes with resume absent -- byte-identical to before the feature", () => {
	const [t] = parse([{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } }]);
	assert.equal(t.run.resume, undefined);
	assert.equal("resume" in t.run, true, "the key is present-and-undefined like packages/image, so a consumer reads one shape");
	const [f] = parse([{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix", resume: false } }]);
	assert.equal(f.run.resume, false, "an explicit false is preserved, not collapsed to absent");
});

test("a non-boolean run.resume is refused at load, on every kind", () => {
	// The damaging misreading here is a truthy "false" STRING: it reads to an operator as an opt-out and
	// would arm the disclosure instead -- validatePackagesFlag's own inversion, from the other direction.
	for (const bad of ["true", "false", 1, 0, null, {}, []]) {
		for (const entry of [
			{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "f", task: "t", resume: bad } },
			{ on: { type: "label", any: ["l"] }, run: { kind: "github", flow: "f", resume: bad } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f", resume: bad } },
			{ on: { type: "pull_request", action: ["synchronize"] }, run: { kind: "github", flow: "f", resume: bad } },
		]) {
			assert.throws(() => parse([entry]), /run\.resume must be true or false/, `${entry.on.type} with resume=${JSON.stringify(bad)} must refuse at load`);
		}
	}
});

// --- run.replicas: the per-trigger fanout count (INT-TRIGGERS-FILE-CONTRACT, REQ-REPLICA-RUNS) ---

test("run.replicas accepts 2 and 3 on every github webhook kind", () => {
	// The three kinds a webhook can fire. Asserted on all of them because one shared validator serves all
	// four normalizers, and a normalizer that forgot to call it would pass two and fail exactly one.
	for (const entry of [LABEL, COMMENT, PR_LABELED]) {
		for (const n of [2, 3]) {
			const [t] = parse([withRun(entry, { replicas: n })]);
			assert.equal(t.run.replicas, n, `${entry.on.type} must carry replicas: ${n}`);
		}
	}
});

test("an unflagged trigger normalizes with replicas absent -- byte-identical to before the feature", () => {
	const [t] = parse([LABEL]);
	assert.equal(t.run.replicas, undefined);
	assert.equal("replicas" in t.run, true, "present-and-undefined like packages/image/resume, so a consumer reads one shape");
	// A cron entry can never carry one, so it does not get the key at all -- the one place the convention
	// deliberately does not apply.
	const [c] = parse([CRON]);
	assert.equal("replicas" in c.run, false, "a cron trigger has no replicas key to read");
});

test("run.replicas on a cron trigger refuses, naming the shared working tree", () => {
	// Not a coverage gap: a local job's /workspace IS the operator's folder, bind-mounted rw. Two replicas
	// would edit one tree with no gate and no undo, which is a different fact from "not yet covered" and
	// must not be reported as one.
	assert.throws(
		() => parse([withRun(CRON, { replicas: 2 })]),
		(e) => isConfigError(e) && /cron trigger/.test(e.message) && /working tree/.test(e.message) && e.message.includes("nightly-tidy"),
	);
});

test("run.replicas on a non-github forge refuses as NOT YET COVERED, not as impossible", () => {
	// Every forge mints its branch through the same issueBranch, so this is a gap to close. The message has
	// to say so: an operator planning work needs "not yet" rather than "never".
	for (const kind of ["gitlab", "forgejo", "azure"]) {
		const entry = kind === "azure" ? withRun(LABEL, { kind, replicas: 2, repository: "repo" }) : withRun(LABEL, { kind, replicas: 2 });
		assert.throws(
			() => parse([entry]),
			(e) => isConfigError(e) && e.message.includes(kind) && /not yet covered/.test(e.message),
			`${kind} must refuse and name itself`,
		);
	}
});

test("run.replicas beside run.resume refuses, naming BOTH fields", () => {
	// The refusal session-key.mjs depends on to keep calling issueBranch with one argument. Relaxing it
	// makes every replica of an issue resolve the same key, share one transcript and fight the writer lock.
	for (const entry of [LABEL, COMMENT, PR_LABELED]) {
		assert.throws(
			() => parse([withRun(entry, { replicas: 2, resume: true })]),
			(e) => isConfigError(e) && /run\.replicas/.test(e.message) && /run\.resume/.test(e.message),
			`${entry.on.type} must refuse the combination`,
		);
	}
	// resume:false is not the combination and must still load.
	const [ok] = parse([withRun(LABEL, { replicas: 2, resume: false })]);
	assert.equal(ok.run.replicas, 2);
});

test("run.replicas outside 2..3, or not an integer, refuses at load", () => {
	// `1` is refused rather than accepted-and-ignored: a one-member replica set is a field that does
	// nothing, and a field that does nothing is one an operator sets and then trusts.
	for (const bad of [1, 0, -1, 4, 10, "2", 2.5, null, true, {}, []]) {
		for (const entry of [LABEL, COMMENT, PR_LABELED]) {
			assert.throws(
				() => parse([withRun(entry, { replicas: bad })]),
				/run\.replicas must be an integer between 2 and 3/,
				`${entry.on.type} with replicas=${JSON.stringify(bad)} must refuse at load`,
			);
		}
	}
});

// --- run.skillsDir (issue #60, REQ-PER-TRIGGER-SKILLS) ---

test("run.skillsDir survives normalization on all four trigger kinds", () => {
	const withDir = (base) => ({ ...base, run: { ...base.run, skillsDir: "/srv/skills" } });
	for (const [name, entry] of [["cron", CRON], ["label", LABEL], ["comment", COMMENT], ["pull_request", PR_AUTO]]) {
		assert.equal(parse([withDir(entry)])[0].run.skillsDir, "/srv/skills", `${name} dropped run.skillsDir`);
	}
});

test("run.skillsDir absent stays ABSENT, not present-and-undefined -- an unflagged trigger is byte-identical", () => {
	for (const entry of [CRON, LABEL, COMMENT, PR_AUTO]) {
		assert.equal("skillsDir" in parse([entry])[0].run, false);
	}
});

test("run.skillsDir that is not a non-empty string is refused, naming the trigger, on all four kinds", () => {
	for (const entry of [CRON, LABEL, COMMENT, PR_AUTO]) {
		for (const bad of ["", "   ", 5, null, {}, []]) {
			assert.throws(
				() => parse([{ ...entry, run: { ...entry.run, skillsDir: bad } }]),
				isConfigError,
				`${JSON.stringify(bad)} was accepted`,
			);
		}
	}
});

test("run.skillsDir with surrounding whitespace is REFUSED rather than trimmed", () => {
	// The file is the reviewed artifact: it must not disagree with what runs. validateImageRef's rule.
	assert.throws(() => parse([{ ...LABEL, run: { ...LABEL.run, skillsDir: " /srv/skills " } }]), isConfigError);
});

test("a RELATIVE run.skillsDir loads here -- absoluteness is not decidable identically on two hosts", () => {
	// path.isAbsolute is OS-dependent ("C:\\x" is absolute on win32, relative on posix) and BOTH services
	// parse this file, so a shared check would let a Windows worker and a Linux receiver disagree about the
	// same reviewed file. The worker enforces it where the answer is knowable (schedules.mjs, processor.mjs).
	assert.equal(parse([{ ...LABEL, run: { ...LABEL.run, skillsDir: "relative/skills" } }])[0].run.skillsDir, "relative/skills");
});
