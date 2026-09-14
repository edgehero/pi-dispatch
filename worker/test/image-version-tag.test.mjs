import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_IMAGE as IMAGE, decideVersionTag, main, releaseTagCommit } from "../../.github/scripts/image-version-tag.mjs";

// Issue #341: image.yml re-pushed the unchanged product version tag on every image/** merge, overwriting a
// released tag with unreleased contents. The decision is pure and the workflow step is a thin main().

const notFound = { code: 1, output: `ERROR: ${IMAGE}:1.11.0: not found` };
const found = { code: 0, output: "Name: ...\nDigest: sha256:abc" };

test("a push that did not change the version never publishes the version tag, and never asks the registry", () => {
	const d = decideVersionTag({ event: "push", versionBefore: "1.10.3", versionNow: "1.10.3", inspect: null });
	assert.equal(d.push, false);
	assert.equal(d.ask, undefined, "no registry call is needed to refuse an unreleased push");
});

test("a version bump publishes only while the tag is absent", () => {
	const base = { event: "push", versionBefore: "1.10.3", versionNow: "1.11.0" };
	assert.equal(decideVersionTag({ ...base, inspect: null }).ask, true);
	assert.equal(decideVersionTag({ ...base, inspect: notFound }).push, true);
	assert.equal(decideVersionTag({ ...base, inspect: found }).push, false, "a tag already on the registry never moves, even for the bump's own re-run");
	assert.equal(decideVersionTag({ ...base, inspect: { code: 1, output: "MANIFEST_UNKNOWN: manifest unknown" } }).push, true);
});

test("an inspect that neither found the tag nor said not-found FAILS the step instead of guessing", () => {
	for (const inspect of [{ code: 1, output: "ERROR: failed to do request: dial tcp: i/o timeout" }, { code: 1, output: "unexpected status: 500" }, { code: 1, output: "" }]) {
		assert.throws(() => decideVersionTag({ event: "push", versionBefore: "1.10.3", versionNow: "1.11.0", inspect }), /refusing to guess/, inspect.output);
	}
});

test("an unknowable previous version is not a release", () => {
	assert.equal(decideVersionTag({ event: "push", versionBefore: null, versionNow: "1.11.0", inspect: notFound }).push, false);
});

test("a manual dispatch publishes only when it explicitly asks, and still only while absent", () => {
	assert.equal(decideVersionTag({ event: "workflow_dispatch", dispatchWantsTag: false, versionBefore: null, versionNow: "1.10.3", inspect: notFound }).push, false);
	assert.equal(decideVersionTag({ event: "workflow_dispatch", dispatchWantsTag: true, versionBefore: null, versionNow: "1.10.3", inspect: notFound }).push, true);
	assert.equal(decideVersionTag({ event: "workflow_dispatch", dispatchWantsTag: true, versionBefore: null, versionNow: "1.10.3", inspect: found }).push, false);
});

test("no current version is an error, not a silent skip", () => {
	assert.throws(() => decideVersionTag({ event: "push", versionBefore: "1", versionNow: "", inspect: null }), /no current version/);
});

function fakeRun(answers, calls) {
	return (cmd, args) => {
		calls.push([cmd, ...args].join(" "));
		for (const [prefix, answer] of answers) if ([cmd, ...args].join(" ").startsWith(prefix)) return answer;
		return { code: 1, output: "" };
	};
}

test("main reads the pushed-over commit's version and asks the registry only for a bump", () => {
	const before = "a".repeat(40);
	const outputs = [];
	const calls = [];
	const d = main({
		env: { EVENT_NAME: "push", BEFORE_SHA: before, VERSION: "1.11.0" },
		run: fakeRun([["git fetch", { code: 0, output: "" }], [`git show ${before}:package.json`, { code: 0, output: '{"version":"1.10.3"}' }], ["docker buildx imagetools inspect", notFound]], calls),
		writeOutput: (l) => outputs.push(l),
		log: () => {},
	});
	assert.equal(d.push, true);
	assert.deepEqual(outputs, ["push=true"]);
	assert.ok(calls.includes(`docker buildx imagetools inspect ${IMAGE}:1.11.0`));

	const calls2 = [];
	const outputs2 = [];
	main({
		env: { EVENT_NAME: "push", BEFORE_SHA: before, VERSION: "1.10.3" },
		run: fakeRun([["git fetch", { code: 0, output: "" }], [`git show ${before}:package.json`, { code: 0, output: '{"version":"1.10.3"}' }]], calls2),
		writeOutput: (l) => outputs2.push(l),
		log: () => {},
	});
	assert.deepEqual(outputs2, ["push=false"]);
	assert.equal(calls2.filter((c) => c.startsWith("docker")).length, 1, "an unreleased push asks the registry once, only to warn about a lost release tag");
});

test("a dispatch asking for the version tag on any commit but the release tag's is REFUSED", () => {
	for (const [answer, sha] of [[lsRemote, "e".repeat(40)], [{ code: 0, output: "" }, TAG_SHA], [{ code: 2, output: "" }, TAG_SHA]]) {
		const outputs = [];
		assert.throws(
			() => main({ env: { EVENT_NAME: "workflow_dispatch", DISPATCH_PUSH_VERSION_TAG: "true", VERSION: "1.10.3", GITHUB_SHA: sha }, run: fakeRun([["git ls-remote", answer], ["docker", notFound]], []), writeOutput: (l) => outputs.push(l), log: () => {} }),
			/must build the commit v1\.10\.3 names/,
		);
		assert.deepEqual(outputs, []);
	}
});

test("releaseTagCommit prefers the peeled commit of an annotated tag", () => {
	assert.equal(releaseTagCommit(lsRemote), TAG_SHA);
	assert.equal(releaseTagCommit({ code: 0, output: `${"d".repeat(40)}\trefs/tags/v1.10.3\n` }), "d".repeat(40));
	assert.equal(releaseTagCommit({ code: 0, output: "" }), null);
	assert.equal(releaseTagCommit({ code: 128, output: `${"d".repeat(40)}\trefs/tags/v1.10.3` }), null);
});

test("an ordinary push warns when the current version's tag is missing from the registry, and never fails for it", () => {
	const before = "a".repeat(40);
	const logs = [];
	const outputs = [];
	main({
		env: { EVENT_NAME: "push", BEFORE_SHA: before, VERSION: "1.10.3" },
		run: fakeRun([["git fetch", { code: 0, output: "" }], [`git show ${before}:package.json`, { code: 0, output: '{"version":"1.10.3"}' }], ["docker buildx imagetools inspect", notFound]], []),
		writeOutput: (l) => outputs.push(l),
		log: (l) => logs.push(l),
	});
	assert.deepEqual(outputs, ["push=false"]);
	assert.ok(logs.some((l) => l.startsWith("::warning::") && l.includes("--ref v1.10.3")), logs.join("\n"));
	const quiet = [];
	main({
		env: { EVENT_NAME: "push", BEFORE_SHA: before, VERSION: "1.10.3" },
		run: fakeRun([["git fetch", { code: 0, output: "" }], [`git show ${before}:package.json`, { code: 0, output: '{"version":"1.10.3"}' }], ["docker buildx imagetools inspect", found]], []),
		writeOutput: () => {},
		log: (l) => quiet.push(l),
	});
	assert.ok(!quiet.some((l) => l.startsWith("::warning::")));
});

test("main treats an all-zero or absent before-sha as not a release", () => {
	for (const env of [{ EVENT_NAME: "push", BEFORE_SHA: "0".repeat(40), VERSION: "1.11.0" }, { EVENT_NAME: "push", VERSION: "1.11.0" }]) {
		const outputs = [];
		main({ env, run: fakeRun([["docker", notFound]], []), writeOutput: (l) => outputs.push(l), log: () => {} });
		assert.deepEqual(outputs, ["push=false"], env.BEFORE_SHA ?? "absent");
	}
});

test("a pushed-over commit that cannot be fetched or read FAILS the step, never silently skips a release's tag", () => {
	const before = "b".repeat(40);
	for (const answers of [[], [["git fetch", { code: 0, output: "" }]], [["git fetch", { code: 0, output: "" }], [`git show ${before}:package.json`, { code: 0, output: "not json" }]]]) {
		const outputs = [];
		assert.throws(
			() => main({ env: { EVENT_NAME: "push", BEFORE_SHA: before, VERSION: "1.11.0" }, run: fakeRun(answers, []), writeOutput: (l) => outputs.push(l), log: () => {} }),
			/could not read the root version at the pushed-over commit/,
		);
		assert.deepEqual(outputs, [], "no output may be written when the step fails");
	}
});

const TAG_SHA = "c".repeat(40);
const lsRemote = { code: 0, output: `${"d".repeat(40)}\trefs/tags/v1.10.3\n${TAG_SHA}\trefs/tags/v1.10.3^{}\n` };

test("main honours a dispatch that asks for the tag ON the release tag's commit, with the workflow's own image name", () => {
	const calls = [];
	const outputs = [];
	const d = main({
		env: { EVENT_NAME: "workflow_dispatch", DISPATCH_PUSH_VERSION_TAG: "true", VERSION: "1.10.3", IMAGE: "ghcr.io/edgehero/pi-dispatch-receiver", GITHUB_SHA: TAG_SHA },
		run: fakeRun([["git ls-remote", lsRemote], ["docker buildx imagetools inspect ghcr.io/edgehero/pi-dispatch-receiver:1.10.3", { code: 1, output: "ERROR: ghcr.io/edgehero/pi-dispatch-receiver:1.10.3: not found" }]], calls),
		writeOutput: (l) => outputs.push(l),
		log: () => {},
	});
	assert.equal(d.push, true);
	assert.deepEqual(outputs, ["push=true"]);
	assert.equal(calls.filter((c) => c.startsWith("docker")).length, 1);
	const outputs2 = [];
	main({ env: { EVENT_NAME: "workflow_dispatch", DISPATCH_PUSH_VERSION_TAG: "", VERSION: "1.10.3" }, run: fakeRun([["docker", notFound]], []), writeOutput: (l) => outputs2.push(l), log: () => {} });
	assert.deepEqual(outputs2, ["push=false"], "an unticked dispatch input renders as an empty string");
});
