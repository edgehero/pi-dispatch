import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	BUNDLE_SKIPPED_TEXT,
	LIVE_SKIPPED_TEXT,
	NESTED_REASONS,
	PLAN_REASON_TEXT,
	REASONS,
	REASONS_DOC,
	RECOVER_SKIPPED_TEXT,
	SESSION_REASON_TEXT,
	STEER_SKIPPED_TEXT,
	WHY_VARIANTS,
	explainReason,
} from "../src/reason-catalog.mjs";
import * as tables from "../src/comment-tables.mjs";
import { MCP_REFUSAL_COMMENT, mcpRefusalComment } from "../src/mcp-preflight.mjs";
import { OPENSHELL_BIND_LINGERING } from "../src/backends.mjs";
import { BUNDLE_SKIPPED_REASONS, LIVE_SKIPPED_REASONS, PLAN_RECORD_REASONS, RECOVER_SKIPPED_REASONS, SESSION_REASONS, STEER_SKIPPED_REASONS } from "../src/run-history.mjs";
import { recordNestedEnum, recordReasonEnum } from "./helpers/spec-enum.mjs";
import { CONTAINER_EXIT_UNKNOWN, CONTAINER_INFRA_EXIT, WORKER_ERROR } from "../src/record-reason.mjs";

// The reason catalog (issue #710, INT-REASON-CATALOG). Every bolt here is two-way: a reason the record can carry with no
// explanation would render as a bare token, and an explanation for a reason the record cannot carry is a table nobody
// checks, which is how the hand-written tables in this repository have drifted before.

const ENUM = recordReasonEnum();
const DOC = readFileSync(new URL(`../../${REASONS_DOC}`, import.meta.url), "utf8");

/**
 * A reason two or more paths share with DIFFERENT comments, and the record cannot say which one ran (no `why` tells them
 * apart), so the catalog writes a general sentence. Each names the fixed comments its paths post (`posts`), and a
 * templated one by what it is (`templated`): the test holds that there really are two or more, that the catalog's
 * sentence is none of them, and that every enum-keyed table row for the token is among them. Keep this list tight: a
 * reason with ONE fixed comment is derived, never listed here.
 */
const AMBIGUOUS = new Map([
	["model-not-allowed", { posts: [tables.TERMINAL_COMMENTS["model-not-allowed"], tables.MODEL_NOT_ALLOWED_COMMENTS.main], because: "the pickup's refusal of the main model (no why) and the runner's stop" }],
	["mcp-config-invalid", { posts: [tables.TERMINAL_COMMENTS["mcp-config-invalid"], mcpRefusalComment("mcp-config-invalid", null)], because: "the pickup's MCP refusal (an overlay mcp.json it cannot use) and the runner's stop" }],
	["secret-name-reserved", { posts: [tables.BUNDLE_COMMENTS["secret-name-reserved"]], templated: "run.secrets' refusal, a template naming the variable", because: "a bundle's variable and a run.secrets binding" }],
	["operator-cancel", { posts: [tables.TERMINAL_COMMENTS["operator-cancel"], tables.CANCELLED_BEFORE_START_COMMENT], because: "index.mjs records operator-cancel for a cancel before the start too, and posts the before-start comment there" }],
	["awaiting-input", { posts: [tables.PARKED_COMMENT, tables.PARKED_COMMENT_PR, tables.HELD_TAKEN_COMMENT], because: "an issue's park, a pull request's (the reply keeps the comment phrase), and a held reply already taken" }],
	["job-user-unmappable", { posts: Object.values(tables.JOB_USER_COMMENTS), because: "JOB_USER_COMMENTS is keyed by the cause, which the record does not carry" }],
	["envelope-mismatch", { posts: Object.values(tables.ENVELOPE_MISMATCH_COMMENTS), because: "ENVELOPE_MISMATCH_COMMENTS is keyed by the cause (no envelope, or a different one), which the record does not carry" }],
	["podman-conf-widens-job", { posts: Object.values(tables.PODMAN_CONF_COMMENTS), because: "PODMAN_CONF_COMMENTS is keyed by the source and the finding, which the record does not carry" }],
]);

/** Is this export a plain table (an object literal, frozen or not), as opposed to a string, a function or a class? */
const isPlainTable = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The leaf's tables keyed by something OTHER than a run-record reason: a cause or a `why`, never an enum token. Named so
 * a new plain-object export must be classified: either every key is a reason (and the table becomes a catalog source
 * automatically), or it is listed here with the reason it serves and what its keys are. The record carries the reason
 * but not the key, so the reason is AMBIGUOUS and its `posts` name every row, except a row a `why` picks (`whyKeys`),
 * which WHY_VARIANTS must return for that `why`.
 */
const CAUSE_KEYED = new Map([
	["JOB_USER_COMMENTS", { reason: "job-user-unmappable", keys: "the cause (default, runtime-unreadable)" }],
	["MODEL_NOT_ALLOWED_COMMENTS", { reason: "model-not-allowed", keys: "the pre-start path: main (no why) or the why fallback-unlisted", whyKeys: ["fallback-unlisted"] }],
	["ENVELOPE_MISMATCH_COMMENTS", { reason: "envelope-mismatch", keys: "the cause (no-envelope, mismatch)" }],
	["PODMAN_CONF_COMMENTS", { reason: "podman-conf-widens-job", keys: "the source and finding (rootful-*, live-*, widens, unread)" }],
]);

/**
 * A table whose keys COLLIDE with reason tokens but mean something else, so its rows are not those reasons' sentences.
 * Empty today; an entry needs a comment saying what its keys are, and the test holds that it really collides.
 */
const COLLIDING_NOT_REASONS = new Map([]);

/** Every plain-object export of comment-tables.mjs keyed by reason tokens: wherever one has a row, that row IS the catalog's sentence. */
const KEYED = Object.fromEntries(Object.entries(tables).filter(([name, value]) => isPlainTable(value) && !CAUSE_KEYED.has(name) && !COLLIDING_NOT_REASONS.has(name)));

test("the spec enum parses to bare tokens: no leading space, no trailing ..., no duplicate", () => {
	assert.ok(ENUM.length > 100, `${ENUM.length} tokens`);
	assert.equal(ENUM[0], "worker-abort");
	assert.ok(!ENUM.includes("..."));
	for (const token of ENUM) assert.match(token, /^[a-z0-9]+(-[a-z0-9]+)*$/, token);
	assert.equal(new Set(ENUM).size, ENUM.length);
});

test("every reason the record can carry has a catalog entry, and every entry is a reason the record can carry", () => {
	assert.deepEqual(Object.keys(REASONS).sort(), [...ENUM].sort());
	for (const [token, entry] of Object.entries(REASONS)) {
		assert.ok(Object.isFrozen(entry), token);
		assert.deepEqual(Object.keys(entry).sort(), ["anchor", "next", "sentence"], token);
		assert.equal(typeof entry.sentence, "string", token);
		assert.ok(entry.sentence.length > 20, `${token}: a sentence`);
		assert.equal(typeof entry.next, "string", token);
		assert.ok(entry.next.length > 5, `${token}: a next step`);
		assert.equal(entry.anchor, `docs/reasons.md#${token}`);
	}
	assert.ok(Object.isFrozen(REASONS));
});

test("the nested reasons are the spec's nested enums, both ways (INT-RUN-HISTORY-FILE-CONTRACT's record shape)", () => {
	for (const field of ["session.reason", "recoverSkipped", "plan.reason"]) {
		const spec = recordNestedEnum(field);
		assert.ok(spec.length >= 4, `${field}: ${spec.length} tokens`);
		assert.equal(new Set(spec).size, spec.length, `${field}: no token twice`);
		assert.deepEqual(Object.keys(NESTED_REASONS[field]).sort(), [...spec].sort(), field);
	}
});

test("a token twice in any catalog table is a load-time error, never a silent override", async () => {
	const source = readFileSync(new URL("../src/reason-catalog.mjs", import.meta.url), "utf8");
	// The guard itself: tableOf must refuse a repeated token rather than build with Object.fromEntries.
	assert.match(source, /if \(Object\.hasOwn\(out, token\)\) throw new Error/);
	// And the behaviour, once per table: a copy of the module whose rows repeat one of that table's tokens must not load.
	// The first row of each table, by its indentation (ROWS is one tab deep, the nested tables' rows two).
	for (const [label, firstRow, token] of [
		["REASONS", '\n\t["worker-abort", ', "worker-abort"],
		["session.reason", '\n\t\t["resumed", ', "resumed"],
		["recoverSkipped", '\n\t\t["local", ', "local"],
		["plan.reason", '\n\t\t["plan-absent", ', "plan-absent"],
	]) {
		assert.equal(source.split(firstRow).length, 2, `${label}: the first row is found once`);
		const doubled = source.replace(firstRow, `\n${firstRow.slice(1, firstRow.indexOf("["))}["${token}", "A duplicate row for this test.", "x"],${firstRow}`);
		const url = `data:text/javascript;base64,${Buffer.from(doubled.replaceAll('from "./', `from "${new URL("../src/", import.meta.url).href}`)).toString("base64")}`;
		await assert.rejects(import(url), new RegExp(`the token ${token} has two rows`), label);
	}
});

test("the nested reasons, both ways: session.reason, recoverSkipped and plan.reason", () => {
	for (const [table, vocabulary, label] of [
		[SESSION_REASON_TEXT, [...SESSION_REASONS], "session.reason"],
		[RECOVER_SKIPPED_TEXT, [...RECOVER_SKIPPED_REASONS], "recoverSkipped"],
		[PLAN_REASON_TEXT, [...PLAN_RECORD_REASONS], "plan.reason"],
	]) {
		assert.deepEqual(Object.keys(table).sort(), vocabulary.sort(), label);
		assert.equal(NESTED_REASONS[label], table, `${label} is reachable through explainReason's field`);
		for (const [token, entry] of Object.entries(table)) {
			assert.ok(entry.sentence.length > 20 && entry.next.length > 5, `${label} ${token}`);
			assert.match(entry.anchor, /^docs\/reasons\.md#[a-z-]+$/, `${label} ${token}`);
		}
	}
	assert.deepEqual(Object.keys(NESTED_REASONS).sort(), ["plan.reason", "recoverSkipped", "session.reason"]);
});

test("the three skip clauses moved from the admin are their enums, both ways", () => {
	assert.deepEqual(Object.keys(BUNDLE_SKIPPED_TEXT).sort(), [...BUNDLE_SKIPPED_REASONS].sort());
	assert.deepEqual(Object.keys(STEER_SKIPPED_TEXT).sort(), [...STEER_SKIPPED_REASONS].sort());
	assert.deepEqual(Object.keys(LIVE_SKIPPED_TEXT).sort(), [...LIVE_SKIPPED_REASONS].sort());
});

test("every plain-object export of comment-tables.mjs is classified: keyed by reasons, by a cause, or excluded with a reason", () => {
	const plain = Object.entries(tables).filter(([, value]) => isPlainTable(value));
	assert.ok(plain.length >= 10, `${plain.length} tables`);
	for (const [name, table] of plain) {
		const keys = Object.keys(table);
		const reasons = keys.filter((key) => ENUM.includes(key));
		if (COLLIDING_NOT_REASONS.has(name)) {
			assert.ok(reasons.length > 0, `${name} is excluded as colliding with reason tokens, so it must collide`);
			continue;
		}
		if (CAUSE_KEYED.has(name)) {
			assert.deepEqual(reasons, [], `${name} is cause-keyed (${CAUSE_KEYED.get(name).keys}), so no key may be a reason token; if one is, list it in COLLIDING_NOT_REASONS or move it`);
			continue;
		}
		assert.deepEqual(reasons, keys, `${name}: every key a reason token (a catalog source), or classify the table in CAUSE_KEYED`);
	}
	for (const name of [...CAUSE_KEYED.keys(), ...COLLIDING_NOT_REASONS.keys()]) assert.ok(isPlainTable(tables[name]), `${name} is still a table of the leaf`);
	// A cause-keyed table serves a reason the record cannot tell its rows apart for: that reason is AMBIGUOUS, and its
	// `posts` name every row but the ones a `why` picks, so the catalog's general sentence is none of them.
	for (const [name, { reason, keys, whyKeys = [] }] of CAUSE_KEYED) {
		assert.ok(ENUM.includes(reason), `${name} serves ${reason}, a reason`);
		assert.ok(AMBIGUOUS.has(reason), `${name} is keyed by ${keys}, which the record does not carry, so ${reason} is AMBIGUOUS`);
		const { posts } = AMBIGUOUS.get(reason);
		for (const [key, comment] of Object.entries(tables[name])) {
			if (whyKeys.includes(key)) {
				assert.equal(WHY_VARIANTS[reason]?.(key), comment, `${name}.${key} is picked by the why ${key}`);
				assert.ok(!posts.includes(comment), `${name}.${key}: a why row is not among the general sentence's posts`);
				continue;
			}
			assert.ok(posts.includes(comment), `${name}.${key} is among ${reason}'s AMBIGUOUS posts`);
		}
		for (const key of whyKeys) assert.ok(Object.hasOwn(tables[name], key), `${name}.${key} is still a row`);
	}
	assert.ok(Object.keys(KEYED).includes("TERMINAL_COMMENTS") && Object.keys(KEYED).includes("OPENSHELL_REFUSALS"), "the derivation sees the leaf's tables");
});

test("a reason with a fixed comment explains itself with that comment, identical, wherever a table is keyed by it", () => {
	let derived = 0;
	for (const [name, table] of Object.entries(KEYED)) {
		for (const [key, sentence] of Object.entries(table)) {
			if (AMBIGUOUS.has(key)) {
				assert.ok(AMBIGUOUS.get(key).posts.includes(sentence), `${key} (${name}): this row is one of the comments its AMBIGUOUS entry names`);
				continue;
			}
			assert.equal(REASONS[key].sentence, sentence, `${key} is ${name}'s row`);
			derived++;
		}
	}
	// The sources not keyed by the token itself.
	const pairs = [
		["model-unknown", tables.MODEL_UNKNOWN_COMMENT],
		["recovery-host-lost", tables.RECOVERY_HOST_LOST_COMMENT],
		["openshell-bind-sandbox-lingering", OPENSHELL_BIND_LINGERING.comment],
	];
	for (const reason of Object.keys(MCP_REFUSAL_COMMENT)) if (!AMBIGUOUS.has(reason)) pairs.push([reason, mcpRefusalComment(reason, null)]);
	for (const [reason, sentence] of pairs) {
		assert.equal(REASONS[reason].sentence, sentence, reason);
		derived++;
	}
	assert.ok(derived >= 60, `${derived} derived sentences`);
});

test("the reasons for infrastructure exits are failures written here: no table is keyed by them, and none is the generic failure comment", () => {
	// A terminal attempt with one of them posts FAILED_COMMENT (FAILED_COMMENT_BY_REASON has no row for them), so the
	// catalog's sentence says more than the issue was told, and must not pretend to be what the issue was told.
	for (const token of [CONTAINER_INFRA_EXIT, CONTAINER_EXIT_UNKNOWN, WORKER_ERROR]) {
		assert.ok(Object.hasOwn(REASONS, token), token);
		assert.match(REASONS[token].sentence, /^Failed: /, token);
		assert.notEqual(REASONS[token].sentence, tables.FAILED_COMMENT, token);
		for (const [name, table] of Object.entries(KEYED)) assert.ok(!Object.hasOwn(table, token), `${token} is not a key of ${name}`);
	}
});

test("each ambiguous reason really has two or more different comments, and the catalog's sentence is none of them", () => {
	for (const [reason, { posts, templated, because }] of AMBIGUOUS) {
		assert.ok(ENUM.includes(reason), `${reason} is a reason`);
		for (const post of posts) assert.equal(typeof post, "string", `${reason}: each named comment is a fixed string`);
		assert.equal(new Set(posts).size, posts.length, `${reason}: no comment named twice`);
		assert.ok(posts.length + (templated ? 1 : 0) >= 2, `${reason} (${because}): two or more paths, or it is not ambiguous and must be derived`);
		for (const post of posts) assert.notEqual(REASONS[reason].sentence, post, `${reason}: ${because}, so the catalog's sentence is general`);
	}
	assert.equal(AMBIGUOUS.size, 8, "the list stays tight: a new entry is a reviewed decision");
});

test("why picks the comment that was posted, where the table is keyed by it", () => {
	assert.equal(explainReason("model-unknown", { why: "overlay-link" }).sentence, tables.OVERLAY_REFUSED_COMMENT);
	assert.equal(explainReason("model-unknown", { why: "overlay-unparseable" }).sentence, tables.modelUnknownComment("overlay-unparseable"));
	for (const why of ["not-in-catalog", "list-malformed", null, undefined, 7]) assert.equal(explainReason("model-unknown", { why }).sentence, tables.MODEL_UNKNOWN_COMMENT, String(why));
	assert.equal(explainReason("model-not-allowed", { why: "fallback-unlisted" }).sentence, tables.MODEL_NOT_ALLOWED_COMMENTS["fallback-unlisted"]);
	assert.equal(explainReason("model-not-allowed").sentence, REASONS["model-not-allowed"].sentence);
	assert.equal(explainReason("cost-cap", { why: "unboundable" }).sentence, REASONS["cost-cap"].sentence, "a why without a variant keeps the sentence");
	assert.deepEqual(Object.keys(WHY_VARIANTS).sort(), ["model-not-allowed", "model-unknown"]);
});

test("explainReason: a known token, and { known: false } for anything else", () => {
	assert.deepEqual(explainReason("worker-abort"), { known: true, token: "worker-abort", ...REASONS["worker-abort"] });
	for (const token of ["no-such-reason", "", " worker-abort", "WORKER-ABORT", "__proto__", "constructor", "toString", "hasOwnProperty", null, undefined, 42, {}, ["worker-abort"]]) {
		assert.deepEqual(explainReason(token), { known: false }, String(token));
	}
	assert.deepEqual(explainReason("absent", { field: "session.reason" }), { known: true, token: "absent", ...SESSION_REASON_TEXT.absent });
	assert.deepEqual(explainReason("workspace-extensions", { field: "recoverSkipped" }).known, true);
	assert.deepEqual(explainReason("plan-stale", { field: "plan.reason" }).known, true);
	assert.deepEqual(explainReason("absent"), { known: false }, "a nested token is not a top-level reason");
	assert.deepEqual(explainReason("worker-abort", { field: "session.reason" }), { known: false });
	assert.deepEqual(explainReason("absent", { field: "__proto__" }), { known: false });
	assert.deepEqual(explainReason("absent", { field: "bundleSkipped" }), { known: false }, "the skip clauses are not reasons with a next step");
	assert.deepEqual(explainReason("worker-abort", {}).known, true);
});

test("explainReason never throws: any token, any options, null and undefined among them", () => {
	const hostile = Object.defineProperty({}, "why", {
		get() {
			throw new Error("a getter");
		},
	});
	const values = [null, undefined, 0, 42, -1, Number.NaN, true, "", "worker-abort", "__proto__", "constructor", "toString", {}, [], ["worker-abort"], Object.create(null), Symbol("s"), () => "worker-abort", hostile, { field: "__proto__" }, { field: "constructor" }, { field: 7 }, { field: Symbol("f") }, { why: {} }, { why: "overlay-x", field: null }];
	for (const token of values) {
		for (const opts of values) {
			const got = explainReason(token, opts);
			assert.equal(typeof got, "object");
			assert.equal(typeof got.known, "boolean");
		}
	}
	assert.equal(explainReason("worker-abort", null).known, true, "null options read as none");
	assert.equal(explainReason("worker-abort", undefined).known, true);
	assert.equal(explainReason("worker-abort", 5).known, true, "a non-object reads as no options");
	assert.deepEqual(explainReason("model-unknown", hostile), { known: false }, "a throwing getter is contained");
	for (const token of ["__proto__", "constructor", null, undefined, 42, {}]) assert.deepEqual(explainReason(token, null), { known: false }, String(token));
});

test("every sentence, next step and clause is a fixed string: no control byte, no template hole", () => {
	const all = [];
	for (const table of [REASONS, ...Object.values(NESTED_REASONS)]) for (const e of Object.values(table)) all.push(e.sentence, e.next);
	all.push(...Object.values(BUNDLE_SKIPPED_TEXT), ...Object.values(STEER_SKIPPED_TEXT), ...Object.values(LIVE_SKIPPED_TEXT));
	for (const text of all) {
		assert.equal(typeof text, "string");
		assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, text);
		assert.doesNotMatch(text, /\$\{|undefined|null|\[object /, text);
	}
});

test("docs/reasons.md has one ### heading per reason token and no other", () => {
	const headings = [...DOC.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
	assert.deepEqual([...headings].sort(), [...ENUM].sort());
	assert.equal(new Set(headings).size, headings.length, "no token twice");
});

test("docs/reasons.md's nested tables name exactly their enums, under the headings the catalog's anchors point at", () => {
	const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
	const sections = new Map();
	let current = null;
	for (const line of DOC.split("\n")) {
		const h = /^## (.+)$/.exec(line);
		if (h) {
			current = slug(h[1].trim());
			sections.set(current, []);
			continue;
		}
		const row = /^\| `([a-z0-9-]+)` \|/.exec(line);
		if (row && current !== null) sections.get(current).push(row[1]);
	}
	for (const [table, vocabulary] of [
		[SESSION_REASON_TEXT, [...SESSION_REASONS]],
		[RECOVER_SKIPPED_TEXT, [...RECOVER_SKIPPED_REASONS]],
		[PLAN_REASON_TEXT, [...PLAN_RECORD_REASONS]],
	]) {
		const anchors = new Set(Object.values(table).map((e) => e.anchor));
		assert.equal(anchors.size, 1, "one section per nested enum");
		const section = [...anchors][0].slice(`${REASONS_DOC}#`.length);
		assert.ok(sections.has(section), `## heading for #${section}`);
		assert.deepEqual([...sections.get(section)].sort(), vocabulary.sort(), section);
	}
	for (const [section, vocabulary] of [
		["bundle-skipped-reasons", [...BUNDLE_SKIPPED_REASONS]],
		["steering-skipped-reasons", [...STEER_SKIPPED_REASONS]],
		["live-transcript-skipped-reasons", [...LIVE_SKIPPED_REASONS]],
	]) {
		assert.ok(sections.has(section), `## heading for #${section}`);
		assert.deepEqual([...sections.get(section)].sort(), vocabulary.sort(), section);
	}
});

test("docs/reasons.md is plain prose: no em dash, no spaced hyphen as punctuation", () => {
	assert.doesNotMatch(DOC, /—|–/);
	for (const line of DOC.split("\n")) if (!line.startsWith("|")) assert.doesNotMatch(line, / - /, line);
});

test("the processor posts no inline fixed sentence any more: each one is a table's entry", () => {
	// The rule, not the sites: a double-quoted "Refused:", "Stopped:" or "Failed:" literal in the processor is a comment
	// the catalog cannot read. A template (backticks) carries a runtime value and stays at its call site.
	const src = readFileSync(new URL("../src/processor.mjs", import.meta.url), "utf8");
	const code = src
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");
	assert.doesNotMatch(code, /"(Refused|Stopped|Failed)[^"]*"/);
	assert.doesNotMatch(code, /comment\(job, "/);
});
