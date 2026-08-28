import assert from "node:assert/strict";
import { test } from "node:test";
import { EGRESS_ENV_VARS, WORKER_ONLY_SECRET_VARS } from "../src/config.mjs";
import { FORGE_HOST_VARS, MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { CONTAINER_ENV_NAMES } from "../src/reserved-env.mjs";
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

// The three forges #187 brought into run.replicas. Spelled out rather than derived from LABEL/COMMENT/
// PR_LABELED by a `kind` swap, because a swap does not survive contact with the loader: every forge has its
// OWN pull_request action vocabulary (triggers.mjs PR_ACTIONS), azure refuses a label predicate on a
// pull_request rule outright, and an azure label/comment rule must carry run.repository. A swapped fixture
// fails for those reasons instead of the one under test, which reads as the change having broken something.
const FORGE_ENTRIES = [
	{ forge: "gitlab", type: "label", entry: { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "gitlab", flow: "frontend-fix" } } },
	{ forge: "gitlab", type: "comment", entry: { on: { type: "comment", phrase: "@pi" }, run: { kind: "gitlab", flow: "fix" } } },
	{ forge: "gitlab", type: "pull_request", entry: { on: { type: "pull_request", action: ["open", "update"] }, run: { kind: "gitlab", flow: "review" } } },
	{ forge: "forgejo", type: "label", entry: { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "forgejo", flow: "frontend-fix" } } },
	{ forge: "forgejo", type: "comment", entry: { on: { type: "comment", phrase: "@pi" }, run: { kind: "forgejo", flow: "fix" } } },
	{ forge: "forgejo", type: "pull_request", entry: { on: { type: "pull_request", action: ["label_updated"], any: ["pi:review"] }, run: { kind: "forgejo", flow: "review" } } },
	{ forge: "azure", type: "label", entry: { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "azure", flow: "frontend-fix", repository: "repo" } } },
	{ forge: "azure", type: "comment", entry: { on: { type: "comment", phrase: "@pi" }, run: { kind: "azure", flow: "fix", repository: "repo" } } },
	{ forge: "azure", type: "pull_request", entry: { on: { type: "pull_request", action: ["created"] }, run: { kind: "azure", flow: "review" } } },
];

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
	// `merged` rather than `closed` since #231 made the close word actionable: `merged` is the word the
	// vocabulary table deliberately keeps out everywhere (a merge that should release work is a close).
	assert.throws(() => parse([{ on: { type: "pull_request", action: ["merged"] }, run: { kind: "github", flow: "x" } }]), (e) => isConfigError(e) && /merged/.test(e.message));
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
		// The pin is the FULL joined vocabulary, moved here by #231's close word: a prefix `.includes`
		// stays green while the message grows, which is exactly how a new action would ship unpinned.
		(e) => isConfigError(e) && e.message.includes("gitlab") && e.message.includes("open|update|reopen|approved|close"),
		"a github action word on a gitlab trigger must refuse at load",
	);
	assert.throws(
		() => parse([{ on: { type: "pull_request", action: ["update"] }, run: { kind: "github", flow: "review" } }]),
		// The FULL github vocabulary, not a prefix of it (#231 grew it by `closed`). `.includes` on a shorter
		// string would still pass against a message that had grown a word, which is exactly how a new action
		// ships unpinned.
		(e) => isConfigError(e) && e.message.includes("github") && e.message.includes("labeled|opened|synchronize|reopened|review_submitted|closed"),
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
	// NOT YET COVERED, not impossible, and the two are different facts. run.replicas carried this same
	// wording until #187 closed its gap; run.resume's is still open, which is why the phrasing outlived it.
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
	// The sibling "not yet covered" refusal is gone (#187), so this message must stand on the hazard alone.
	// It is also the ONLY kind gate left: reorder it below the range check and `replicas: 2` on a cron entry
	// would be ACCEPTED rather than refused, which is why the ordering is pinned here and not just commented.
	assert.throws(() => parse([withRun(CRON, { replicas: 2 })]), (e) => !/not yet covered/.test(e.message));
	assert.throws(() => parse([withRun(CRON, { replicas: 99 })]), (e) => /cron trigger/.test(e.message) && !/between 2 and/.test(e.message));
});

test("run.replicas is accepted on every FORGE and every webhook kind (#187)", () => {
	// The refusal this replaces said "not yet covered", which was the honest word for a gap rather than a
	// limit. Closing it is what #187 is. Asserted across the whole 3x3 rather than one representative,
	// because the field is validated once but REACHED through three separate normalizers per forge, and a
	// normalizer that forgot to call the validator would pass two and fail exactly one.
	for (const { forge, type, entry } of FORGE_ENTRIES) {
		for (const n of [2, 3]) {
			const [t] = parse([withRun(entry, { replicas: n })]);
			assert.equal(t.run.replicas, n, `${forge} ${type} must carry replicas: ${n}`);
			assert.equal(t.run.kind, forge, `${forge} ${type} must keep its kind`);
		}
	}
});

test("run.replicas beside run.resume refuses, naming BOTH fields", () => {
	// The refusal session-key.mjs depends on to keep calling issueBranch with one argument. Relaxing it
	// makes every replica of an issue resolve the same key, share one transcript and fight the writer lock.
	// Swept across every forge since #187: session-key.mjs gates on isForgeKind, not on github, so the
	// coupling it documents is now four couplings and a refusal that held on one of them is not enough.
	for (const entry of [LABEL, COMMENT, PR_LABELED, ...FORGE_ENTRIES.map((f) => f.entry)]) {
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
		for (const entry of [LABEL, COMMENT, PR_LABELED, ...FORGE_ENTRIES.map((f) => f.entry)]) {
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

// --- run.instructions (issue #60, REQ-PER-TRIGGER-INSTRUCTION) ---

test("run.instructions survives normalization on the three webhook kinds", () => {
	for (const [name, entry] of [["label", LABEL], ["comment", COMMENT], ["pull_request", PR_AUTO]]) {
		const out = parse([{ ...entry, run: { ...entry.run, instructions: "Tests run with pnpm." } }]);
		assert.equal(out[0].run.instructions, "Tests run with pnpm.", `${name} dropped run.instructions`);
	}
});

test("run.instructions absent stays ABSENT -- an unflagged trigger is byte-identical", () => {
	for (const entry of [LABEL, COMMENT, PR_AUTO]) {
		assert.equal("instructions" in parse([entry])[0].run, false);
	}
});

test("run.instructions on a CRON trigger is refused, and the message names run.task", () => {
	// A different refusal from the "not yet covered" shape (run.resume's, since #187 retired run.replicas'):
	// cron ALREADY has operator-authored free
	// text landing in the same region of the same file, and a local prompt has no envelope for a second
	// field to occupy. Two fields writing one region with an undefined order would both appear to work.
	try {
		parse([{ ...CRON, run: { ...CRON.run, instructions: "prefer X" } }]);
		assert.fail("a cron run.instructions was accepted");
	} catch (error) {
		assert.ok(isConfigError(error));
		assert.ok(error.message.includes("run.task"), "the refusal must point at the field that already does this");
	}
});

test("run.instructions over the length cap is refused, and the message names where longer text belongs", () => {
	try {
		parse([{ ...LABEL, run: { ...LABEL.run, instructions: "x".repeat(2001) } }]);
		assert.fail("an over-cap run.instructions was accepted");
	} catch (error) {
		assert.ok(isConfigError(error));
		assert.ok(error.message.includes("SKILL.md"), "the cap must teach, not merely block");
		assert.ok(error.message.includes("APPEND_SYSTEM.md"));
	}
	// Exactly at the cap is fine: the bound is a refusal above it, not at it.
	assert.equal(parse([{ ...LABEL, run: { ...LABEL.run, instructions: "x".repeat(2000) } }])[0].run.instructions.length, 2000);
});

test("a whitespace-only run.instructions is refused; surrounding whitespace in real prose is NOT", () => {
	// Deliberately unlike run.image, and the comment in the validator says why: whitespace changes what an
	// image REFERENCE means and does not change what prose means. A trailing newline in a multi-line JSON
	// string is a papercut, not a hazard.
	assert.throws(() => parse([{ ...LABEL, run: { ...LABEL.run, instructions: "   " } }]), isConfigError);
	assert.equal(parse([{ ...LABEL, run: { ...LABEL.run, instructions: "prefer X\n" } }])[0].run.instructions, "prefer X\n");
});

// --- run.command (issue #189): dispatch a registered pi extension command instead of a flow ---

// Swap the fixture's flow for a command. `task` is shed too, which only matters on CRON: a command job's
// prompt IS the /name args line, so validateCommand refuses run.task beside one -- the removal here is
// the fixture obeying the rule under test (pinned below), not dodging it.
const withCommand = (entry, command = "wf run") => {
	const { flow, task, ...rest } = entry.run;
	return { ...entry, run: { ...rest, command } };
};
// The full `at` prefix a kind's messages carry -- cron names its id, the rest their raw-file index --
// so the pins below can be COMPLETE message strings per the action-vocabulary test's doctrine.
const cmdAt = (kind) => (kind === "cron" ? `cron trigger "nightly-tidy"` : "trigger at index 0");

test("run.command survives normalization on all four trigger kinds, in run.flow's place", () => {
	// The whole run, not the one field: a command trigger's normalized shape is pinned here once, so a
	// normalizer that grew or dropped a key fails this test rather than surfacing downstream in `data`.
	const [c] = parse([withCommand(CRON)]);
	assert.deepEqual(c.run, { kind: "local", folder: "/proj", flow: undefined, task: undefined, provider: undefined, model: undefined, maxTurns: undefined, github: undefined, packages: undefined, image: undefined, resume: undefined, command: "wf run" });
	for (const entry of [LABEL, COMMENT, PR_LABELED, PR_AUTO]) {
		const [t] = parse([withCommand(entry)]);
		assert.deepEqual(t.run, { kind: "github", flow: undefined, packages: undefined, image: undefined, resume: undefined, replicas: undefined, command: "wf run" }, `${entry.on.type} must carry the command`);
	}
});

test("run.command absent stays ABSENT -- an unflagged file normalizes byte-identically to before the feature", () => {
	// Full shapes, keys and values: the conditional spread must not leave a present-and-undefined
	// `command` behind, because `data` is built by spreading these runs and every stored repeatable
	// would grow a key the operator never wrote.
	assert.deepEqual(parse([CRON])[0].run, { kind: "local", folder: "/proj", flow: "tidy", task: "run the tidy pass", provider: undefined, model: undefined, maxTurns: undefined, github: undefined, packages: undefined, image: undefined, resume: undefined });
	assert.deepEqual(parse([LABEL])[0].run, { kind: "github", flow: "frontend-fix", packages: undefined, image: undefined, resume: undefined, replicas: undefined });
	assert.deepEqual(parse([COMMENT])[0].run, { kind: "github", flow: "fix", packages: undefined, image: undefined, resume: undefined, replicas: undefined });
	assert.deepEqual(parse([PR_LABELED])[0].run, { kind: "github", flow: "review", packages: undefined, image: undefined, resume: undefined, replicas: undefined });
	for (const entry of [CRON, LABEL, COMMENT, PR_LABELED, PR_AUTO]) {
		assert.equal("command" in parse([entry])[0].run, false, `${entry.on.type} must not grow a command key`);
	}
});

test("run.command that is not a non-empty string is a config error naming the trigger, on all four kinds", () => {
	// One shared validator serves all four normalizers, so every case runs on every kind: a normalizer
	// that forgot the call would pass three and fail exactly one. Whitespace-only refuses as EMPTY, not
	// as surrounding-whitespace -- it is a field the operator believes they set.
	for (const { kind, entry } of KINDS) {
		for (const bad of [5, null, "", "   "]) {
			assert.throws(
				() => parse([withCommand(entry, bad)]),
				(e) => isConfigError(e) && e.message.includes(`${cmdAt(kind)}: run.command must be a non-empty string -- the registered command name, optionally followed by its arguments: ${PATH}`),
				`${kind} must refuse command=${JSON.stringify(bad)}`,
			);
		}
	}
});

test("run.flow beside run.command refuses as exactly-one on all four kinds, BEFORE any flow check", () => {
	for (const { kind, entry } of KINDS) {
		assert.throws(
			() => parse([withRun(entry, { command: "wf run" })]),
			(e) => isConfigError(e) && e.message.includes(`${cmdAt(kind)}: exactly one of run.flow or run.command must be set -- a trigger dispatches either a flow or a registered command, and with both present the file does not say which one runs: ${PATH}`),
			`${kind} must refuse flow+command as ambiguous, not as a field error`,
		);
	}
	// The ordering half of the contract: an EMPTY flow beside a command must still get the exclusion
	// message, never "run.flow must be a non-empty string" -- the entry's problem is ambiguity, and a
	// fix that deletes the empty string would flip a flow trigger into a command trigger unreviewed.
	assert.throws(
		() => parse([withRun(withCommand(LABEL), { flow: "" })]),
		(e) => isConfigError(e) && e.message.includes("exactly one of run.flow or run.command") && !e.message.includes("non-empty"),
	);
	// And a command-only entry never sees the flow-required message at all: it simply loads.
	assert.doesNotThrow(() => parse([withCommand(LABEL)]));
});

test("neither flow nor command still refuses as flow-required, now naming the alternative -- full strings, all four kinds", () => {
	// FULL amended messages, not prefixes: a prefix pin would keep passing after the "(or use
	// run.command)" amendment silently vanished, which is the exact drift the :372 doctrine refuses.
	const cases = [
		[{ ...CRON, run: { kind: "local", folder: "/proj", task: "t" } }, `cron trigger "nightly-tidy": run.flow must be a non-empty string (or use run.command): ${PATH}`],
		[{ ...LABEL, run: { kind: "github" } }, `trigger at index 0: label trigger run.flow must be a non-empty string (or use run.command): ${PATH}`],
		[{ ...COMMENT, run: { kind: "github" } }, `trigger at index 0: comment trigger run.flow (the default flow) must be a non-empty string (or use run.command): ${PATH}`],
		[{ ...PR_AUTO, run: { kind: "github" } }, `trigger at index 0: pull_request trigger run.flow must be a non-empty string (or use run.command): ${PATH}`],
	];
	for (const [entry, message] of cases) {
		assert.throws(
			() => parse([entry]),
			(e) => isConfigError(e) && e.message.includes(message),
			`${entry.on.type}: the flow-required message must acknowledge run.command`,
		);
	}
});

test("run.command and run.task on a cron trigger refuse together, naming BOTH fields", () => {
	// validateReplicas' cross-field posture: two prompts written for one job, with only one ever sent,
	// and the one that is dropped would be the one the operator wrote prose into.
	assert.throws(
		() => parse([{ ...CRON, run: { kind: "local", folder: "/proj", command: "wf run", task: "t" } }]),
		(e) => isConfigError(e) && e.message.includes(`cron trigger "nightly-tidy": run.command and run.task cannot be combined -- a command job's prompt IS the /name args line, so there is no task text for the runner to render; put the arguments in run.command: ${PATH}`),
	);
});

test("run.command and run.instructions refuse together on each webhook kind -- nothing would render them", () => {
	// Instructions land in the prompt ENVELOPE, which a command job bypasses entirely: accepted here,
	// the field would sit in the file looking configured while every dispatch ignored it.
	for (const entry of [LABEL, COMMENT, PR_AUTO]) {
		assert.throws(
			() => parse([withRun(withCommand(entry), { instructions: "prefer X" })]),
			(e) => isConfigError(e) && e.message.includes(`trigger at index 0: run.command and run.instructions cannot be combined -- instructions render into the prompt envelope, and a command job's prompt is the exact /name args line with no envelope, so nothing would render them: ${PATH}`),
			`${entry.on.type} must refuse the pair`,
		);
	}
});

test("run.command and run.resume: true refuse as NOT YET COVERED, on cron and on a forge kind", () => {
	// validateResumeFlag's vocabulary on purpose: what a resumed session should do with a re-dispatched
	// command is undesigned, which is a different fact from impossible, and an operator planning work
	// needs the right one. On cron this message wins over the resume-on-cron one -- validateCommand runs
	// first -- so the operator hears about the pair they wrote, not only the half that is also wrong.
	const message = (at) => `${at}: combining run.command and run.resume is not yet covered -- what a resumed session should do with a re-dispatched command is undesigned, so this is a gap to close, not a limit: ${PATH}`;
	assert.throws(() => parse([withRun(withCommand(CRON), { resume: true })]), (e) => isConfigError(e) && e.message.includes(message(cmdAt("cron"))));
	assert.throws(() => parse([withRun(withCommand(LABEL), { resume: true })]), (e) => isConfigError(e) && e.message.includes(message(cmdAt("label"))));
	// resume: false is the documented default, not the combination -- it keeps loading beside a command
	// exactly as it does beside a flow, or the refusal would punish writing today's behaviour down.
	const [ok] = parse([withRun(withCommand(LABEL), { resume: false })]);
	assert.equal(ok.run.command, "wf run");
	assert.equal(ok.run.resume, false);
});

test('run.command with a leading "/" is refused -- the runner adds the slash itself', () => {
	// A written slash would dispatch "//name": a command no registry holds, refused only after review
	// already passed the entry, inside the paid path instead of here.
	assert.throws(
		() => parse([withCommand(LABEL, "/wf run")]),
		(e) => isConfigError(e) && e.message.includes(`trigger at index 0: run.command must not start with "/" -- the runner prepends the slash when it builds the /name args prompt, so a written one would dispatch "//name" (got "/wf run"): ${PATH}`),
	);
});

test("run.command with surrounding whitespace is REFUSED rather than trimmed -- the arguments are verbatim", () => {
	// validateImageRef's rule, sharpened: a trim here would not merely mis-describe the file, it would
	// CHANGE the argv the handler receives, because the runner passes the args through untouched.
	assert.throws(
		() => parse([withCommand(CRON, " wf run ")]),
		(e) => isConfigError(e) && e.message.includes(`cron trigger "nightly-tidy": run.command must not have leading or trailing whitespace -- the arguments reach the command handler verbatim, so trimming here would make the reviewed file disagree with what runs (got " wf run "): ${PATH}`),
	);
});

test("run.command containing a control character is refused -- a newline would smuggle a second command line", () => {
	// "\u001b[1m" is ESC opening an ANSI SGR sequence and "a\nb" a mid-string newline; both are spelled
	// as escapes so THIS file carries no literal control byte either, the same reviewability argument
	// the validator makes for refusing the whole class rather than the newline alone.
	for (const bad of ["\u001b[1m", "a\nb"]) {
		assert.throws(
			() => parse([withCommand(COMMENT, bad)]),
			(e) => isConfigError(e) && e.message.includes(`trigger at index 0: run.command must not contain control characters -- a newline would smuggle a second line into what the operator reviewed as one command line (got ${JSON.stringify(bad)}): ${PATH}`),
			`${JSON.stringify(bad)} must refuse at load`,
		);
	}
});

test("run.command is orthogonal to packages/image/skillsDir on all four kinds -- each survives beside it", () => {
	// The :311 block's shape, both directions from one parse: declining the packages must not cost the
	// command, and naming a command must not re-arm the packages or drop the image and skills.
	for (const { kind, entry } of KINDS) {
		const [t] = parse([withRun(withCommand(entry), { packages: false, image: "my-python:1.2.0", skillsDir: "/srv/skills" })]);
		assert.equal(t.run.command, "wf run", `${kind}: the container fields must not cost the command`);
		assert.equal(t.run.packages, false, `${kind}: a command must not re-arm the packages`);
		assert.equal(t.run.image, "my-python:1.2.0", `${kind}: a command job still picks its image`);
		assert.equal(t.run.skillsDir, "/srv/skills", `${kind}: a command job still carries its skills`);
	}
});

test("run.command beside run.replicas, run.github, and an azure run.repository all load -- container fields, not prompt fields", () => {
	const [r] = parse([withRun(withCommand(LABEL), { replicas: 2 })]);
	assert.equal(r.run.replicas, 2, "a command race is still a race");
	assert.equal(r.run.command, "wf run");
	const [g] = parse([withRun(withCommand(CRON), { github: true })]);
	assert.equal(g.run.github, true, "a command cron job can still opt into the scoped token");
	assert.equal(g.run.command, "wf run");
	// The azure cross-requirement is untouched: a command label trigger still must (and may) name the
	// repository, because the work item still names only a project.
	const [z] = parse([{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "azure", command: "wf run", repository: "repo" } }]);
	assert.equal(z.run.repository, "repo");
	assert.equal(z.run.command, "wf run");
});

test("a comment command trigger loads with no default-flow refusal", () => {
	// run.flow is "the default flow" in this normalizer's message because the receiver's
	// `<phrase> <flow>` comment override can replace it. A command rule has no default flow to replace,
	// so the override token is inert -- enforced in the receiver's filter, which is the only place that
	// ever sees the adversarial comment text carrying it; this validator only proves the shape loads.
	const [t] = parse([{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "wf run" } }]);
	assert.equal(t.run.command, "wf run");
	assert.equal(t.run.flow, undefined);
	assert.deepEqual(t.on, { type: "comment", phrase: "@pi" });
});

// --- run.secrets / run.secretsProfile (REQ-TRIGGER-SECRETS, issue #225) ---

test("run.secrets survives normalization on all four kinds, cron included", () => {
	// Cron is the case worth stating: `run.replicas` refuses a local job, and the reason (two agents
	// sharing one bind-mounted working tree) does not transfer to resolving a credential. A nightly
	// deploy is the obvious user, so a refusal here would be a refusal of the use case.
	for (const { kind, entry } of KINDS) {
		const [t] = parse([withRun(entry, { secrets: { STRIPE_KEY: "op://ci/stripe/api-key" } })]);
		assert.deepEqual(t.run.secrets, { STRIPE_KEY: "op://ci/stripe/api-key" }, `${kind} must carry the map`);
	}
});

test("an unflagged trigger grows NEITHER key, on all four kinds", () => {
	// The conditional-spread invariant every deepEqual pin in this file depends on.
	for (const { kind, entry } of KINDS) {
		const [t] = parse([entry]);
		assert.equal("secrets" in t.run, false, `${kind} must not gain a secrets key`);
		assert.equal("secretsProfile" in t.run, false, `${kind} must not gain a secretsProfile key`);
	}
});

test("run.secrets that is not an object of strings is refused, naming the trigger, on all four kinds", () => {
	for (const { kind, entry, mentions } of KINDS) {
		for (const bad of ["op://x/y/z", 1, null, true, [], [{ A: "b" }]]) {
			assert.throws(
				() => parse([withRun(entry, { secrets: bad })]),
				(e) => isConfigError(e) && e.message.includes(mentions) && /run\.secrets/.test(e.message),
				`${kind} must refuse secrets=${JSON.stringify(bad)}`,
			);
		}
	}
});

test("an EMPTY run.secrets map is refused -- a field that does nothing is the failure class, not a shortcut", () => {
	assert.throws(
		() => parse([withRun(LABEL, { secrets: {} })]),
		(e) => isConfigError(e) && /empty/.test(e.message),
	);
});

test("a run.secrets key that is not an environment variable name is refused", () => {
	// No downstream check exists: `-e NAME=VALUE` reaches the docker argv as written, so a key carrying
	// an `=` binds a different variable than the one the operator wrote.
	for (const bad of ["1STRIPE", "STRIPE-KEY", "STRIPE KEY", "STRIPE=KEY", "", "stripe.key", "PI:X"]) {
		assert.throws(
			() => parse([withRun(LABEL, { secrets: { [bad]: "op://a/b/c" } })]),
			(e) => isConfigError(e) && /environment variable name/.test(e.message),
			`key ${JSON.stringify(bad)} must refuse`,
		);
	}
	// Lowercase and underscores are LEGAL env names and must stay accepted: refusing them would be this
	// project inventing a naming convention for the operator's own variables.
	const [t] = parse([withRun(LABEL, { secrets: { db_url: "x", _X9: "y" } })]);
	assert.deepEqual(Object.keys(t.run.secrets).sort(), ["_X9", "db_url"]);
});

test("a run.secrets key the worker sets itself is refused, from every set and derived from the table", () => {
	// Derived, never retyped: a forge added to FORGES later stays covered without a second edit here.
	// FORGE_HOST_VARS is the one that was missing when this was first designed -- `hostVar` is a separate
	// column from `tokenVars`, so GITLAB_HOST was in NO refusal set while buildContainerEnv wrote it
	// after the mint, which would have silently discarded the trigger's value.
	const reserved = [...MINTED_TOKEN_VARS, ...FORGE_HOST_VARS, ...WORKER_ONLY_SECRET_VARS, ...EGRESS_ENV_VARS, ...CONTAINER_ENV_NAMES];
	assert.ok(reserved.includes("GITHUB_TOKEN") && reserved.includes("GITLAB_HOST"), "the fixture must span both columns");
	assert.ok(reserved.includes("GITHUB_APP_PRIVATE_KEY") && reserved.includes("HTTPS_PROXY") && reserved.includes("PI_OFFLINE"));
	for (const name of reserved) {
		assert.throws(
			() => parse([withRun(LABEL, { secrets: { [name]: "op://a/b/c" } })]),
			(e) => isConfigError(e) && e.message.includes(name),
			`${name} must be refused as a reserved name`,
		);
	}
});

test("a run.secrets reference that is empty, whitespace-padded, or starts with a dash is refused", () => {
	for (const [bad, needle] of [["", /non-empty string/], ["   ", /non-empty string/], [" op://a/b/c ", /whitespace/], ["--help", /start with/], ["-rf", /start with/]]) {
		assert.throws(
			() => parse([withRun(LABEL, { secrets: { A: bad } })]),
			(e) => isConfigError(e) && needle.test(e.message),
			`reference ${JSON.stringify(bad)} must refuse`,
		);
	}
});

test("the reference grammar is NOT validated -- this project blesses no vendor (#206, #209)", () => {
	// The deliberately-permissive pin, in `validateImageRef`'s tradition: its job is to stop a future
	// contributor from "tightening" this into an `op://` regex. What parses a reference is a script the
	// operator wrote, so a Vault path, a Doppler name and a bare word are all correct inputs here.
	for (const reference of ["op://ci-vault/stripe/api-key", "secret/data/ci#stripe", "STRIPE_KEY", "projects/1/secrets/x/versions/2", "a b c"]) {
		const [t] = parse([withRun(LABEL, { secrets: { A: reference } })]);
		assert.equal(t.run.secrets.A, reference);
	}
});

test("more than the cap is refused -- the ceiling bounds a concurrency slot, not tidiness", () => {
	const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, "op://a/b/c"]));
	assert.throws(
		() => parse([withRun(LABEL, { secrets: seventeen })]),
		(e) => isConfigError(e) && /17 variables, over the 16 cap/.test(e.message),
	);
	const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`K${i}`, "op://a/b/c"]));
	assert.equal(Object.keys(parse([withRun(LABEL, { secrets: sixteen })])[0].run.secrets).length, 16);
});

test("run.secrets beside run.resume: true refuses, naming BOTH fields, on every kind that can resume", () => {
	// get-token.mjs refuses the `gh` token source on a resumed job for this exact argument: a credential
	// is safe because it is an env value that dies with the container, while a transcript is a FILE on
	// host disk replayed into the next job on that key. A resolved vault value is an env value the agent
	// can echo, and nothing in this project redacts a transcript.
	for (const { kind, entry } of KINDS.filter((k) => k.kind !== "cron")) {
		assert.throws(
			() => parse([withRun(entry, { secrets: { A: "op://a/b/c" }, resume: true })]),
			(e) => isConfigError(e) && /run\.secrets/.test(e.message) && /run\.resume/.test(e.message),
			`${kind} must refuse the combination`,
		);
	}
});

test("run.secretsProfile: a name is accepted, a path or a separator is not", () => {
	const [t] = parse([withRun(LABEL, { secrets: { A: "op://a/b/c" }, secretsProfile: "prod" })]);
	assert.equal(t.run.secretsProfile, "prod");
	// A NAME, never a path: DES-SERVICE-ENV-SETUP-SEAM rejected letting a trigger file name an exec, and
	// this field is allowed to exist only because it selects among execs the operator already declared.
	// The `,` and `:` refusals are load-bearing twice over -- PI_SECRET_PROFILES is a comma-separated
	// list of name:path pairs, so a name carrying either could not round-trip through its own declaration.
	for (const bad of ["/opt/pi/resolve.sh", "prod:staging", "a,b", "with space", "", "  ", 7, true, null]) {
		assert.throws(
			() => parse([withRun(LABEL, { secrets: { A: "op://a/b/c" }, secretsProfile: bad })]),
			(e) => isConfigError(e) && /run\.secretsProfile/.test(e.message),
			`profile ${JSON.stringify(bad)} must refuse`,
		);
	}
});

test("run.secretsProfile without run.secrets is refused on all four kinds", () => {
	for (const { kind, entry, mentions } of KINDS) {
		assert.throws(
			() => parse([withRun(entry, { secretsProfile: "prod" })]),
			(e) => isConfigError(e) && e.message.includes(mentions) && /names nothing/.test(e.message),
			`${kind} must refuse a profile that resolves nothing`,
		);
	}
});

test("whether the named profile EXISTS is not decided here -- that is deployment state", () => {
	// parseTriggers is pure and fs-free, so it cannot see PI_SECRET_PROFILES. Accepting an unknown name
	// here is correct and the refusal lands pre-spend per delivery, exactly as run.resume splits against
	// PI_SESSIONS_DIR. A validator that guessed would refuse a file that is fine on the real worker.
	const [t] = parse([withRun(LABEL, { secrets: { A: "op://a/b/c" }, secretsProfile: "nothing-declares-this" })]);
	assert.equal(t.run.secretsProfile, "nothing-declares-this");
});

test("run.secrets is orthogonal to the other run fields -- each survives beside it", () => {
	const [t] = parse([withRun(LABEL, { secrets: { A: "op://a/b/c" }, secretsProfile: "prod", packages: false, image: "pi-job:x", replicas: 2 })]);
	assert.equal(t.run.packages, false);
	assert.equal(t.run.image, "pi-job:x");
	assert.equal(t.run.replicas, 2);
	assert.equal(t.run.secretsProfile, "prod");
	assert.deepEqual(t.run.secrets, { A: "op://a/b/c" });
});

// --- close triggers: on.type "issue", PR close, on.number, on.once, on.disarmed (issue #231, INT-TRIGGERS-FILE-CONTRACT) ---

// The close is the starting gun, not the subject: an operator wrote "when this closes, run that", so the
// close family gets its own on.type for issues, a close-ONLY action list on pull_request, and a narrowing
// pair (on.number, on.once) no other kind may carry. A spent one-shot normalizes to the DISARMED sentinel
// in place rather than being filtered out, so raw-array positions survive for triggerIndex attribution.
const ISSUE_ONCE = { on: { type: "issue", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy" } };
const ISSUE_CLOSE = { on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "deploy" } };
const withOn = (entry, over) => ({ ...entry, on: { ...entry.on, ...over } });
const DISARMED = withOn(ISSUE_ONCE, { disarmed: { at: "2026-08-27T09:00:00Z", jobId: "job-40" } });

test("an issue one-shot normalizes: the full on, and a run shaped exactly like a label trigger's", () => {
	const [t] = parse([ISSUE_ONCE]);
	// The WHOLE on, not one field: a normalizer that grew or dropped a key must fail here, not
	// downstream where `data` is built by spreading these.
	assert.deepEqual(t.on, { type: "issue", action: ["closed"], number: 40, once: true });
	// Byte-identical to the label run literal at :156: the issue kind is a fifth normalizer over the
	// same run vocabulary, not a new run shape for consumers to special-case.
	assert.deepEqual(t.run, { kind: "github", flow: "deploy", packages: undefined, image: undefined, resume: undefined, replicas: undefined });
});

test("a standing issue close rule loads, and number/once absent stay ABSENT, not present-and-undefined", () => {
	// reviewState's rule (:416): an unnarrowed rule's normalized shape must not grow keys the operator
	// never wrote, or every stored pre-#231 rule would re-serialize differently after a reload.
	const [t] = parse([ISSUE_CLOSE]);
	assert.deepEqual(t.on, { type: "issue", action: ["closed"] });
	assert.equal("number" in t.on, false, "an unnarrowed rule must not grow a number key");
	assert.equal("once" in t.on, false, "a standing rule must not grow a once key");
});

test("issue on.action speaks each forge's own words, and the wrong forge's word refuses at load", () => {
	// The :394 sharp case restated for the issue kind: "closed" on gitlab is not malformed, it is
	// GitHub's word, and unrefused it would load clean and never match an event.
	for (const [kind, word] of [["github", "closed"], ["forgejo", "closed"], ["gitlab", "close"]]) {
		const [t] = parse([{ on: { type: "issue", action: [word] }, run: { kind, flow: "deploy" } }]);
		assert.deepEqual(t.on.action, [word], `${kind} must take its own close word`);
	}
	// The FULL parenthesized join, the :399 doctrine -- each vocabulary is one word today, and a second
	// word growing in unpinned is how it would ship.
	assert.throws(
		() => parse([{ on: { type: "issue", action: ["closed"] }, run: { kind: "gitlab", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("gitlab") && e.message.includes("(expected close)"),
		"GitHub's word on a gitlab trigger must refuse at load, naming gitlab's own",
	);
	assert.throws(
		() => parse([{ on: { type: "issue", action: ["close"] }, run: { kind: "github", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("github") && e.message.includes("(expected closed)"),
		"GitLab's word on a github trigger must refuse at load, naming github's own",
	);
	assert.throws(() => parse([{ on: { type: "issue", action: [] }, run: { kind: "github", flow: "deploy" } }]), (e) => isConfigError(e) && /non-empty array/.test(e.message));
});

test("an azure issue trigger refuses as NOT YET COVERED -- the payload subset cannot see a work item close", () => {
	// validateResumeFlag's distinction, kept on purpose: a work item's close is a System.State transition
	// whose terminal names vary by process template, and the projected subset carries only System.Tags.
	// The gap is the subset, not the idea, and an operator planning work needs the right fact.
	assert.throws(
		() => parse([{ on: { type: "issue", action: ["closed"] }, run: { kind: "azure", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("azure") && e.message.includes("not yet covered"),
	);
});

test("a close-only pull_request rule loads on the three forges with a close word, gaining number and once", () => {
	for (const [kind, word] of [["github", "closed"], ["gitlab", "close"], ["forgejo", "closed"]]) {
		const [t] = parse([{ on: { type: "pull_request", action: [word], number: 7, once: true }, run: { kind, flow: "deploy" } }]);
		assert.equal(t.on.number, 7, `${kind} must carry the narrowing`);
		assert.equal(t.on.once, true, `${kind} must carry the one-shot`);
		// The ordered key list pins WHERE the pair lands: the trailing conditional spread, after the
		// always-present predicate keys -- and doubles as a no-extra-keys pin (no reviewState here).
		assert.deepEqual(Object.keys(t.on), ["type", "action", "any", "all", "none", "number", "once"], `${kind} must spread the pair after the predicate keys`);
	}
	// An unflagged PR rule grows NEITHER key -- the absence rule again, on the kind where a
	// present-and-undefined slip is likeliest because the pair is conditional there.
	const [plain] = parse([PR_AUTO]);
	assert.equal("number" in plain.on, false);
	assert.equal("once" in plain.on, false);
});

test("mixing the close word with any other action refuses -- one rule cannot gate on two actors", () => {
	// A close rule gates on the CLOSER's write access, every other PR action on the author's
	// association or a collaborator's label; a mixed list would need both gates at once.
	assert.throws(
		() => parse([{ on: { type: "pull_request", action: ["closed", "opened"] }, run: { kind: "github", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("cannot mix"),
	);
	assert.throws(
		() => parse([{ on: { type: "pull_request", action: ["close", "update"] }, run: { kind: "gitlab", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("cannot mix"),
	);
});

test("a label predicate refuses on a close-only PR rule and on every issue rule -- the close route reads no label diff", () => {
	// Accepted-and-ignored is the failure class (validateRepository's posture): the route matches
	// action and number alone, so any/all/none would sit in the file looking configured.
	assert.throws(
		() => parse([{ on: { type: "pull_request", action: ["closed"], any: ["pi:release"] }, run: { kind: "github", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("label predicate"),
	);
	for (const key of ["any", "all", "none"]) {
		assert.throws(
			() => parse([withOn(ISSUE_CLOSE, { [key]: ["pi:release"] })]),
			(e) => isConfigError(e) && e.message.includes("label predicate"),
			`issue with on.${key} must refuse`,
		);
	}
});

test("on.once is strictly boolean, false is CARRIED, true requires on.number, and once+replicas refuse together", () => {
	for (const bad of ["true", 1]) {
		assert.throws(
			() => parse([withOn(ISSUE_ONCE, { once: bad })]),
			(e) => isConfigError(e) && e.message.includes("must be true or false"),
			`once=${JSON.stringify(bad)} must refuse -- a truthy string arming a one-shot is the drift the boolean rule exists for`,
		);
	}
	// false is today's default written down (validateResumeFlag's argument), and it is CARRIED rather
	// than collapsed to absent, so the file and the stored rule keep saying the same thing.
	const [f] = parse([withOn(ISSUE_CLOSE, { once: false })]);
	assert.deepEqual(f.on, { type: "issue", action: ["closed"], once: false });
	// A numberless one-shot is a race: two items closing inside one dedup window coin-flip for it. The
	// refusal must name BOTH fields, or the operator deletes the wrong one.
	assert.throws(
		() => parse([{ on: { type: "issue", action: ["closed"], once: true }, run: { kind: "github", flow: "deploy" } }]),
		(e) => isConfigError(e) && e.message.includes("on.once") && e.message.includes("on.number"),
	);
	// "exactly one run" and "N sandboxes race" contradict on their face, and with N run records the
	// disarm no longer says which one spent the trigger.
	assert.throws(
		() => parse([withRun(ISSUE_ONCE, { replicas: 2 })]),
		(e) => isConfigError(e) && e.message.includes("cannot be combined"),
	);
});

test("on.number must be an integer >= 1, and rides WITHOUT once as a standing narrowing", () => {
	for (const bad of [0, -1, 1.5, "40"]) {
		assert.throws(
			() => parse([withOn(ISSUE_CLOSE, { number: bad })]),
			(e) => isConfigError(e) && e.message.includes("integer >= 1"),
			`number=${JSON.stringify(bad)} must refuse -- the forge's own numbering starts at 1`,
		);
	}
	// Number-without-once is coherent narrowing, on.reviewState's shape: a standing "every close of
	// #40" rule, not a one-shot -- refusing it would weld two orthogonal fields together.
	const [t] = parse([withOn(ISSUE_CLOSE, { number: 40 })]);
	assert.deepEqual(t.on, { type: "issue", action: ["closed"], number: 40 });
});

test("number, once and disarmed each refuse on cron and on the non-close kinds, keeping the two facts apart", () => {
	// The KINDS discipline: one shared validator per field, reached through every normalizer, so a
	// normalizer that forgot a call would pass the rest and fail exactly one. Cron's refusal is a
	// different FACT from the webhook kinds' ("not available" vs "not yet covered") and the messages
	// must keep the difference -- run.resume's doctrine at :514. Each field rides ALONE so its own
	// refusal is the one that fires, not its neighbour's.
	const overlays = [
		["number", { number: 40 }],
		["once", { once: true }],
		["disarmed", { disarmed: { at: "2026-08-27T09:00:00Z" } }],
	];
	const nonClose = [
		{ kind: "label", entry: LABEL },
		{ kind: "comment", entry: COMMENT },
		{ kind: "pull_request", entry: PR_AUTO },
	];
	for (const [field, over] of overlays) {
		assert.throws(
			() => parse([withOn(CRON, over)]),
			(e) => isConfigError(e) && e.message.includes("not available on a cron trigger"),
			`cron must refuse on.${field} as unavailable, not as a coverage gap`,
		);
		for (const { kind, entry } of nonClose) {
			assert.throws(
				() => parse([withOn(entry, over)]),
				(e) => isConfigError(e) && e.message.includes("not yet covered"),
				`${kind} must refuse on.${field} as a gap to close, not a limit`,
			);
		}
	}
});

test("a disarmed one-shot normalizes to the sentinel IN PLACE -- the position is the pin, not just the shape", () => {
	// The lazy revert this must catch is FILTERING: dropping the spent entry re-indexes every later
	// trigger, and triggerIndex attribution -- the join between a run record and the entry that spent
	// itself -- silently points one entry left. So the LABEL rule must still be at [2].
	const result = parse([CRON, DISARMED, LABEL]);
	assert.equal(result.length, 3, "a spent one-shot keeps its slot; deleting it shifts every later entry's index");
	// EXACT: no selectors, no actions, no run.kind, no flow -- unmatchable by construction, so a
	// consumer that forgot to skip it still cannot select it. Any extra key weakens that.
	assert.deepEqual(result[1], { on: { type: "disarmed" }, run: {} });
	assert.equal(result[2].on.type, "label", "the entry AFTER the spent one must keep its own position");
	// jobId is optional: a hand-written disarm has no run record to join to.
	assert.deepEqual(parse([withOn(ISSUE_ONCE, { disarmed: { at: "2026-08-27T09:00:00Z" } })])[0], { on: { type: "disarmed" }, run: {} });
});

test("every malformed on.disarmed is a load refusal, never a silently-still-armed rule", () => {
	// The worker writes this mark; a corrupted write that still loaded as armed would be a one-shot
	// firing again, the exact bug the sentinel exists to make unwritable.
	const cases = [
		[true, /must be an object/],
		[[], /must be an object/],
		[{}, /disarmed\.at must be a non-empty string/],
		[{ at: "" }, /disarmed\.at must be a non-empty string/],
		[{ at: 1 }, /disarmed\.at must be a non-empty string/],
		[{ at: "2026-08-27T09:00:00Z", jobId: "" }, /disarmed\.jobId must be a non-empty string/],
		[{ at: "2026-08-27T09:00:00Z", extra: 1 }, /unsupported key/],
	];
	for (const [bad, needle] of cases) {
		assert.throws(
			() => parse([withOn(ISSUE_ONCE, { disarmed: bad })]),
			(e) => isConfigError(e) && needle.test(e.message),
			`disarmed=${JSON.stringify(bad)} must refuse`,
		);
	}
	// Without once: true there is nothing the mark could record having spent.
	assert.throws(
		() => parse([withOn(ISSUE_CLOSE, { number: 40, disarmed: { at: "2026-08-27T09:00:00Z" } })]),
		(e) => isConfigError(e) && e.message.includes("only meaningful beside"),
	);
	// And on a kind that cannot carry once at all, the refusal says so rather than shape-checking a
	// mark that could never have been written.
	assert.throws(
		() => parse([withOn(LABEL, { disarmed: { at: "2026-08-27T09:00:00Z" } })]),
		(e) => isConfigError(e) && e.message.includes("marks a spent one-shot"),
	);
});

test("a disarmed entry still validates IN FULL -- a malformed run refuses the file before the sentinel wins", () => {
	// The lazy revert: short-circuiting to the sentinel on seeing on.disarmed. writeTriggers'
	// fail-closed contract needs the WHOLE file valid, and the worker's disarm only ever ADDS one key
	// to an entry that already passed -- so a disarmed entry that stopped validating would let a bad
	// hand edit hide behind a spent one-shot.
	const bad = { on: { ...DISARMED.on }, run: { kind: "github", flow: "BAD FLOW" } };
	assert.throws(() => parse([bad]), (e) => isConfigError(e) && /skill-name charset/.test(e.message));
});

test('authoring on.type "disarmed" refuses as an unknown type, and the type message now names "issue"', () => {
	// DISARMED_TYPE is producible only by the validator: ON_TYPES excludes it on purpose, so a
	// hand-written sentinel cannot smuggle in an entry that LOOKS spent and dodges validation.
	assert.throws(
		() => parse([{ on: { type: "disarmed" }, run: {} }]),
		(e) => isConfigError(e) && e.message.includes("on.type must be one of"),
	);
	// The FULL joined type vocabulary, the :399 doctrine: #231 grew it by "issue", and a prefix pin
	// would have stayed green while it grew.
	assert.throws(
		() => parse([{ on: { type: "disarmed" }, run: {} }]),
		(e) => e.message.includes("cron|label|comment|pull_request|issue"),
	);
});

test("run.flow is charset-gated on the webhook kinds, and cron is DELIBERATELY exempt", () => {
	// The colon cases are the load-bearing ones: ":" is the separator in the queue's semantic dedup
	// key, where the command jobs' "cmd:" prefix lives and the close jobs' discriminant sits once
	// close routing lands. The
	// rest could until #231 only ever fail in a paid container (materialize.mjs refuses them at job
	// start, after the budget slot is reserved), so refusing at load turns a paid failure into a free one.
	for (const [kind, entry] of [["label", LABEL], ["comment", COMMENT], ["pull_request", PR_AUTO], ["issue", ISSUE_CLOSE]]) {
		for (const bad of ["closed:deploy", "cmd:x", "Fix", "a b"]) {
			assert.throws(
				() => parse([withRun(entry, { flow: bad })]),
				(e) => isConfigError(e) && /skill-name charset/.test(e.message),
				`${kind} must refuse flow=${JSON.stringify(bad)} before a budget slot can be reserved`,
			);
		}
	}
	// Cron loads the very name the webhook kinds refuse: a local flow resolves inside the operator's
	// own folder by pi itself, and the semantic key does not apply to repeat jobs -- narrowing cron
	// would refuse working deployments this hazard cannot reach.
	const [c] = parse([withRun(CRON, { flow: "Weird:Flow" })]);
	assert.equal(c.run.flow, "Weird:Flow");
});

test("an issue one-shot is orthogonal to the run vocabulary -- each field survives beside it", () => {
	// The :333 shape: arming a one-shot must not cost a trigger its container fields, and none of them
	// may drop the narrowing pair. secrets rides with its profile; replicas is the one deliberate
	// absentee, because once and replicas refuse together above.
	const cases = [
		[{ packages: false }, (r) => assert.equal(r.packages, false)],
		[{ image: "my-python:1.2.0" }, (r) => assert.equal(r.image, "my-python:1.2.0")],
		[{ skillsDir: "/srv/skills" }, (r) => assert.equal(r.skillsDir, "/srv/skills")],
		[{ instructions: "Tests run with pnpm." }, (r) => assert.equal(r.instructions, "Tests run with pnpm.")],
		[{ secrets: { STRIPE_KEY: "op://ci/stripe/api-key" }, secretsProfile: "prod" }, (r) => {
			assert.deepEqual(r.secrets, { STRIPE_KEY: "op://ci/stripe/api-key" });
			assert.equal(r.secretsProfile, "prod");
		}],
		[{ resume: true }, (r) => assert.equal(r.resume, true)],
	];
	for (const [over, check] of cases) {
		const [t] = parse([withRun(ISSUE_ONCE, over)]);
		check(t.run);
		assert.deepEqual(t.on, { type: "issue", action: ["closed"], number: 40, once: true }, `${Object.keys(over).join("+")} must not disturb the on`);
	}
});
