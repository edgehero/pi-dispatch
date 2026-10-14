import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FORGES, FORGE_KINDS, MINTED_TOKEN_VARS, RECEIVER_ONLY_VARS, RUN_KINDS, forgeSpec, isForgeKind, targetSeparator } from "../src/forges.mjs";
import { forgeDeliveryJobId, deliveryJobId, gitlabDeliveryJobId } from "../src/job-id.mjs";

test("FORGE_KINDS is exactly the table's keys, so nothing can be in one and not the other", () => {
	assert.deepEqual([...FORGE_KINDS], Object.keys(FORGES), "a kind listed but not described, or described but not listed, is the drift this table exists to prevent");
});

test("RUN_KINDS is the forges plus local, and local is NOT a forge -- that difference is the on x run matrix", () => {
	assert.deepEqual([...RUN_KINDS], ["local", ...FORGE_KINDS]);
	assert.equal(isForgeKind("local"), false, "a cron trigger produces a local job, which has no forge to authenticate against at all");
	for (const kind of FORGE_KINDS) assert.equal(isForgeKind(kind), true);
});

test("every forge describes every field, so a half-filled row cannot reach a caller as undefined", () => {
	for (const kind of FORGE_KINDS) {
		const spec = FORGES[kind];
		assert.equal(typeof spec.jobIdPrefix, "string", `${kind}: jobIdPrefix keys the delivery id space`);
		assert.notEqual(spec.jobIdPrefix, "", `${kind}: an empty prefix would merge this forge's id space into another's`);
		assert.equal(typeof spec.deliveryIdName, "string", `${kind}: the name an operator has to go and look at when an id is missing`);
		assert.equal(typeof spec.pullRequestSep, "string", `${kind}: the separator is load-bearing in the dedup key and the run record`);
		assert.ok(Array.isArray(spec.tokenVars) && spec.tokenVars.length > 0, `${kind}: a forge with no token variable would mint into nothing`);
		// hostVars is legitimately empty for a forge with no self-hosted instance concept, so only its SHAPE
		// is pinned -- asserting a member would forbid the honest answer.
		assert.ok(Array.isArray(spec.hostVars) && spec.hostVars.every((n) => typeof n === "string" && n !== ""), `${kind}: hostVars is a list of names, possibly empty`);
		assert.ok(Array.isArray(spec.receiverOnlyVars) && spec.receiverOnlyVars.every((n) => typeof n === "string" && n !== ""), `${kind}: receiverOnlyVars is a list of names, possibly empty`);
	}
});

test("no two forges share a jobId prefix -- a collision would let one forge's delivery suppress another's job", () => {
	const prefixes = FORGE_KINDS.map((kind) => FORGES[kind].jobIdPrefix);
	assert.equal(new Set(prefixes).size, prefixes.length, "REQ-DEDUP-BY-DELIVERY-GUID rests on the id spaces being disjoint");
});

test("MINTED_TOKEN_VARS covers every name any forge's mint can write", () => {
	// The set and the mint are derived from one table entry precisely so this holds. A forge added to the
	// mint but missing here is not refused in PI_FORWARD_ENV, so an operator could forward a long-lived
	// host token under that name into every container of every forge -- CONST-TOKEN-SCOPED-PER-JOB, gone,
	// with no test failing and nothing in a log to say so.
	for (const kind of FORGE_KINDS) {
		for (const name of FORGES[kind].tokenVars) {
			assert.ok(MINTED_TOKEN_VARS.has(name), `${name} is minted for ${kind} but would not be refused in PI_FORWARD_ENV`);
		}
	}
});

test("the pull-request separator is each forge's own notation, and an issue is always #", () => {
	assert.equal(targetSeparator("github", "pull_request"), "#", "GitHub numbers issues and PRs from one sequence, so # names exactly one thing");
	assert.equal(targetSeparator("gitlab", "pull_request"), "!", "GitLab numbers them separately, so issue #5 and merge request !5 must not collide");
	for (const kind of FORGE_KINDS) {
		assert.equal(targetSeparator(kind, "issue"), "#", `${kind}: an issue is # everywhere`);
	}
});

test("targetSeparator is total -- an unknown kind labels rather than throws, because both callers are labels", () => {
	// A run record's `target` and a dedup key are not gates. Failing a paid job over punctuation for a
	// forge the table has not heard of would be a worse answer than a slightly wrong label.
	// Deliberately not the name of a forge that might later be added -- `chained` is a real non-forge job
	// kind, and the rest is junk.
	assert.equal(targetSeparator("chained", "pull_request"), "#");
	assert.equal(targetSeparator(undefined, "pull_request"), "#");
	assert.equal(targetSeparator("", "pull_request"), "#");
});

test("forgeSpec is total and never throws, so the caller owns how loudly an unknown forge fails", () => {
	assert.equal(forgeSpec("nope"), undefined);
	assert.equal(forgeSpec(undefined), undefined);
	assert.equal(forgeSpec(null), undefined);
	assert.equal(forgeSpec(42), undefined);
});

test("forges.mjs imports nothing, so it can never be half of an import cycle", async () => {
	// It is the leaf: triggers.mjs needs it, and the receiver's config needs triggers.mjs. Anything this
	// file reached for would be pulled into both services -- and a cycle here would surface as an
	// undefined export at import time, which is exactly the failure branch.mjs was extracted to end.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/forges.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(source), false, "forges.mjs must stay import-free");
});

test("the named delivery-id helpers are spellings of the general one, not copies of it", () => {
	assert.equal(deliveryJobId("abc"), forgeDeliveryJobId("github", "abc"));
	assert.equal(gitlabDeliveryJobId("abc"), forgeDeliveryJobId("gitlab", "abc"));
	assert.equal(deliveryJobId("abc"), "gh-abc");
	assert.equal(gitlabDeliveryJobId("abc"), "gl-abc");
});

test("a delivery id that is missing or empty refuses, rather than inventing one that would defeat dedup", () => {
	for (const kind of FORGE_KINDS) {
		for (const id of ["", undefined, null, 42]) {
			assert.throws(
				() => forgeDeliveryJobId(kind, id),
				(e) => e.piDispatchConfig === true,
				`${kind}/${JSON.stringify(id)}: a random id would let a redelivery double-spend`,
			);
		}
	}
});

test("an unknown forge names the table it is missing from, because that is the actual repair", () => {
	assert.throws(
		() => forgeDeliveryJobId("chained", "abc"),
		(e) => e.piDispatchConfig === true && /forges\.mjs/.test(e.message),
		"reaching here means a forge was added to the trigger schema and not to the table",
	);
});

/**
 * INT-TRIGGERS-FILE-CONTRACT's vocabulary bolt records this exact defect class one file over: an
 * enumeration that "named github and gitlab and stopped, while four forges shipped". The Scope
 * paragraph is the project's statement of what it services -- issue #281 ratified OQ-015 through
 * it -- so it gets the same derive-and-grep bolt: FORGE_KINDS is the source, the sentence is the
 * restatement, and a new forge cannot ship without touching it. The region bound fails LOUDLY when
 * the heading moves; scanning an empty slice and passing is the vacancy that bolt's doc comment
 * warns about.
 */
test("requirements.md's Scope names every forge this build ships -- the sentence and the table cannot disagree silently again", () => {
	const spec = readFileSync(fileURLToPath(new URL("../../specs/requirements.md", import.meta.url)), "utf8");
	const start = spec.indexOf("## Scope");
	assert.notEqual(start, -1, "the Scope heading is gone from requirements.md");
	const end = spec.indexOf("\n## ", start + 1);
	const region = spec.slice(start, end === -1 ? undefined : end);
	assert.ok(region.length > 200, "the Scope region must be the real paragraph, not an empty slice");
	// The display names are a hand-written map, so an UNMAPPED kind fails loudly rather than skipping
	// silently -- a new forge must add its display name HERE and to the Scope sentence, in one commit.
	const DISPLAY = { github: "GitHub", gitlab: "GitLab", forgejo: "Forgejo", azure: "Azure DevOps" };
	for (const kind of FORGE_KINDS) {
		const name = DISPLAY[kind];
		assert.ok(name, `no display name mapped for forge kind ${JSON.stringify(kind)} -- add it here AND to requirements.md's Scope`);
		assert.ok(region.includes(name), `requirements.md's Scope does not name ${name} -- the tree services what the sentence does not say`);
	}
});

/**
 * The names `tea` actually logs in from, pinned to the tea the job image installs. Measured on 2026-10-14
 * with tea 0.15.0 inside ghcr.io/edgehero/pi-job:4.3.0 against a live Forgejo 14.0.5 (API version
 * "14.0.5+gitea-1.22.0"). The binary's own strings name GITEA_INSTANCE_URL, GITEA_INSTANCE_INSECURE,
 * GITEA_INSTANCE_SSH_HOST, GITEA_TOKEN, GITEA_LOGIN_VIA_ENV, GITEA_SERVER_URL, GITEA_SERVER_TOKEN,
 * GITEA_SERVER_USER, GITEA_SERVER_PASSWORD, GITEA_SERVER_OTP and GITEA_SCOPES, and only one pair worked:
 *
 *   GITEA_INSTANCE_URL=http://host:3700 GITEA_TOKEN=<t> tea issues ls --repo o/r          lists the issues
 *   GITEA_SERVER_URL + GITEA_SERVER_TOKEN (and again with GITEA_LOGIN_VIA_ENV=1)       "Error: no available login"
 *   FORGEJO_HOST + GITEA_SERVER_TOKEN (what every forgejo job carried since be1cc42e)   "Error: no available login"
 *   GITEA_TOKEN alone, inside a clone with an http remote                              "Error: no available login"
 *
 * The GITEA_SERVER_* names are the defaults of `tea login add`'s flags (`--token ... [$GITEA_SERVER_TOKEN]`),
 * which is why GITEA_SERVER_TOKEN stays in the row. The tea pin is part of this test: a different tea may read
 * different names, and this is the line that makes a bump re-measure rather than trust the old answer.
 */
test("a forgejo job carries the exact pair tea 0.15.0 logs in from, and the pin is that tea", () => {
	const dockerfile = readFileSync(fileURLToPath(new URL("../../image/Dockerfile", import.meta.url)), "utf8");
	const pin = dockerfile.match(/^ARG TEA_VERSION=(\S+)$/m);
	assert.ok(pin, "image/Dockerfile no longer pins tea with ARG TEA_VERSION");
	assert.equal(pin[1], "0.15.0", "tea moved: re-measure which variables it logs in from (see this test's comment), then move this pin");
	assert.ok(FORGES.forgejo.tokenVars.includes("GITEA_TOKEN"), "tea 0.15.0 reads its environment login's token from GITEA_TOKEN and nothing else");
	assert.ok(FORGES.forgejo.hostVars.includes("GITEA_INSTANCE_URL"), "tea 0.15.0 reads its environment login's URL from GITEA_INSTANCE_URL and nothing else");
	assert.ok(MINTED_TOKEN_VARS.has("GITEA_TOKEN"), "and so a forwarded host GITEA_TOKEN would shadow the job's token");
});

test("the forgejo lookup token is receiver-only, and is in no set a job's env is written from (OQ-043)", () => {
	assert.ok(RECEIVER_ONLY_VARS.has("FORGEJO_PERMISSION_TOKEN"));
	for (const kind of FORGE_KINDS) {
		for (const name of RECEIVER_ONLY_VARS) {
			assert.equal(FORGES[kind].tokenVars.includes(name), false, `${kind}: ${name} must never be minted into a job`);
			assert.equal(FORGES[kind].hostVars.includes(name), false, `${kind}: ${name} must never be written as a host var`);
		}
	}
});
