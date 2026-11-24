import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SILENT_REFUSALS, attemptComment, refusalNetText } from "../src/refusal-net.mjs";
import { REASONS, explainReason } from "../src/reason-catalog.mjs";
import { CANCELLED_BEFORE_START_COMMENT, MODEL_NOT_ALLOWED_COMMENTS, REFUSAL_COMMENTS, REFUSED_UNEXPLAINED_COMMENT } from "../src/comment-tables.mjs";
import { DUPLICATE_REQUEST_REASON } from "../src/duplicate-notice.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

// The refusal net (issue #969, refusal-net.mjs): a forge job refused before spend that told its item nothing gets the
// reason catalog's sentence. These are the pure rules; refusal-net-pickup.test.mjs drives the real pickup.

const forge = (over = {}) => ({ kind: "github", repo: "acme/site", target: { type: "pull_request", number: 7 }, ...over });
const refused = (reason, over = {}) => ({ outcome: "policy", reason, exitCode: null, turns: null, tokens: null, budgetReserved: false, ...over });

test("the refusal #969 reported gets the sentence the issue asked for, word for word", () => {
	assert.deepEqual(refusalNetText({ data: forge(), result: refused("auth-mixed-billing") }), {
		text: "Stopped before starting: this job's finite model routes mix a bound subscription connection with an unbound API billing route. No container was started and nothing was spent.",
		unexplained: false,
	});
	// The pickup's refusal of the same reason the processor already posts a fixed comment for gets that same comment.
	assert.equal(refusalNetText({ data: forge(), result: refused("auth-route-unbounded") }).text, REFUSAL_COMMENTS["auth-route-unbounded"]);
});

test("every catalog reason outside SILENT_REFUSALS posts its catalog sentence, on every forge", () => {
	for (const kind of FORGE_KINDS) {
		for (const reason of Object.keys(REASONS)) {
			const net = refusalNetText({ data: forge({ kind }), result: refused(reason) });
			if (Object.hasOwn(SILENT_REFUSALS, reason)) {
				assert.equal(net, null, `${kind}/${reason} is silent by decision`);
				continue;
			}
			const expected = reason === "operator-cancel" ? CANCELLED_BEFORE_START_COMMENT : explainReason(reason).sentence;
			assert.deepEqual(net, { text: expected, unexplained: false }, `${kind}/${reason}`);
		}
	}
});

test("a why picks the catalog's variant, as the record's own explanation does", () => {
	assert.equal(refusalNetText({ data: forge(), result: refused("model-not-allowed", { why: "fallback-unlisted" }) }).text, MODEL_NOT_ALLOWED_COMMENTS["fallback-unlisted"]);
	assert.equal(refusalNetText({ data: forge(), result: refused("model-not-allowed", { why: 7 }) }).text, explainReason("model-not-allowed").sentence);
});

test("a token the catalog cannot explain still tells the item, in the fixed fallback, never nothing", () => {
	for (const reason of ["future-policy-gate", "__proto__", "constructor", "toString"]) {
		assert.deepEqual(refusalNetText({ data: forge(), result: refused(reason) }), { text: REFUSED_UNEXPLAINED_COMMENT, unexplained: true }, reason);
	}
	assert.doesNotMatch(REFUSED_UNEXPLAINED_COMMENT, /[\n\r`<>]/);
});

test("only a returned refusal before spend, with nothing posted, on a forge item, reaches the net", () => {
	const ok = { data: forge(), result: refused("settings-overlay-invalid") };
	assert.notEqual(refusalNetText(ok), null);
	for (const [label, args] of [
		["a paid stop", { ...ok, result: refused("cost-cap", { budgetReserved: true }) }],
		["a reservation it cannot judge", { ...ok, result: refused("settings-overlay-invalid", { budgetReserved: null }) }],
		["no reservation field", { ...ok, result: { outcome: "policy", reason: "settings-overlay-invalid" } }],
		["a completion", { ...ok, result: { outcome: "completed", reason: null, budgetReserved: true } }],
		["a park", { ...ok, result: { outcome: "completed", reason: "awaiting-input", budgetReserved: false } }],
		["a failed outcome", { ...ok, result: { outcome: "failed", reason: "recovery-enqueued", budgetReserved: false } }],
		["no reason", { ...ok, result: refused(null) }],
		["an empty reason", { ...ok, result: refused("") }],
		["no result", { ...ok, result: null }],
		["a string result", { ...ok, result: "policy" }],
		["a comment already posted", { ...ok, posted: 1 }],
		["a lost-lock replay", { ...ok, replay: true }],
		["a local job", { ...ok, data: { kind: "local", folder: "/x", task: "t" } }],
		["a cron job (local)", { ...ok, data: { kind: "local", target: { type: "issue", number: 1 } } }],
		["an unknown kind", { ...ok, data: forge({ kind: "svn" }) }],
		["no target", { ...ok, data: forge({ target: undefined }) }],
		["a null target", { ...ok, data: forge({ target: null }) }],
		["an answer draft", { ...ok, data: forge({ answerDraft: { project: "p" } }) }],
		["an answer draft by purpose", { ...ok, data: forge({ purpose: "answer-draft" }) }],
		["a watch", { ...ok, data: forge({ watch: { project: "p" } }) }],
		["a question grouping", { ...ok, data: forge({ questionGrouping: true }) }],
		["no data", { ...ok, data: null }],
	]) {
		assert.equal(refusalNetText(args), null, label);
	}
	assert.equal(refusalNetText(), null, "no arguments");
	assert.equal(refusalNetText({ data: forge(), result: { get outcome() { throw new Error("boom"); } } }), null, "a throwing getter");
});

test("SILENT_REFUSALS: each is a catalog reason with its why, two are the producers' own tokens, and the spec lists exactly these", async () => {
	for (const [reason, why] of Object.entries(SILENT_REFUSALS)) {
		assert.ok(Object.hasOwn(REASONS, reason), `${reason} is a catalog reason`);
		assert.ok(typeof why === "string" && why.length > 40, `${reason} says why`);
	}
	assert.ok(Object.hasOwn(SILENT_REFUSALS, DUPLICATE_REQUEST_REASON));
	// The processor's own token, read from the module that returns it (heavy, so only here).
	const { RECOVERY_SUPERSEDED } = await import("../src/processor.mjs").catch(() => ({}));
	if (RECOVERY_SUPERSEDED !== undefined) assert.ok(Object.hasOwn(SILENT_REFUSALS, RECOVERY_SUPERSEDED));
	// DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK names the list in one passage, from its bold lead to "Outside the net", so a
	// change to either fails here until both move.
	const design = readFileSync(new URL("../../specs/design.md", import.meta.url), "utf8");
	const at = design.indexOf("**Silent by decision**");
	assert.ok(at !== -1 && design.indexOf("**Silent by decision**", at + 1) === -1, "one passage names the silent refusals");
	const passage = design.slice(at, design.indexOf("Outside the net", at));
	const named = [...passage.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]).filter((token) => Object.hasOwn(REASONS, token));
	assert.deepEqual(named.toSorted(), Object.keys(SILENT_REFUSALS).toSorted());
});

test("attemptComment counts the calls made, a rejected post included, and is null without an adapter", async () => {
	const texts = [];
	const said = attemptComment(async (data, text) => { texts.push([data.kind, text]); if (text === "fails") throw new Error("403"); });
	assert.equal(said.posted(), 0);
	await said.comment({ kind: "github" }, "one");
	await assert.rejects(said.comment({ kind: "github" }, "fails"));
	assert.equal(said.posted(), 2, "a failed POST still counts: the net must not post the refusal twice");
	assert.deepEqual(texts, [["github", "one"], ["github", "fails"]]);
	const bare = attemptComment(undefined);
	assert.equal(bare.comment, null);
	assert.equal(bare.posted(), 0);
	// Two attempts never share a count.
	const a = attemptComment(async () => {});
	const b = attemptComment(async () => {});
	await a.comment({}, "x");
	assert.deepEqual([a.posted(), b.posted()], [1, 0]);
});
