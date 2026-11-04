import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Issue #809: the receiver's comments, specs and docs said a forge sends a delivery answered 503 again. GitHub, GitLab
// and Forgejo never do; Azure DevOps resends a 503 for about 3 minutes, then on probation for about 36 hours
// (receiver/src/receiver.mjs, WHAT A 503 MEANS).
// This scan refuses the shapes that claim took, and the spellings it most plausibly takes next ("the forge
// retries", "GitLab will retry", "GitHub sends it again later"), so it cannot come back in a comment, a test, a
// spec or a doc. It catches those shapes only: a spelling outside them is caught by reading the change, and the
// words around every 503 are written so that a correct sentence ("GitHub does not resend it", "a hand redelivery
// keeps the id", "Azure resends it") matches none of them.

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/**
 * Each claim shape, with sentences it catches (`catches`: the trees carried most of them before issue #809, so
 * none is vacuous) and, where a correct sentence comes close, sentences it must not catch (`spares`).
 */
const CLAIMS = Object.freeze([
	{
		name: "a forge that sends a delivery again on its own",
		re: /\b(?:GitHub|GitLab|Forgejo|the forge) (?:redelivers|resends|keeps retrying|(?:would|will) (?:redeliver|resend))\b/i,
		catches: [
			"503: GitHub redelivers, the GUID jobId coalesces the retry.",
			"answers 503, so GitHub redelivers and the stable `X-GitHub-Delivery` GUID dedups the retry.",
			"indeterminate and answers 503 so the forge redelivers, the GitLab arm's posture.",
			"the caller's catch answers 503, the forge redelivers, replicas 1..k-1 dedup",
			"Forgejo redelivers, and the stable delivery GUID dedups the retry.",
			"the failure mode is \"nothing runs and GitLab keeps retrying\"",
			"the forge would redeliver a handled delivery, a storm bought for a status code",
		],
	},
	{
		name: "a forge's own retries",
		re: /\b(?:GitHub|GitLab|Forgejo)(?:'s)? (?:own |auto-?)?retries\b|\b(?:across|through) its (?:own )?retries\b|\bacross(?:-| a )retry\b/i,
		catches: [
			"a redelivered webhook (GitHub retries on timeout) carries the same GUID",
			"The delivery id is stable across GitLab's own retries",
			"`X-GitHub-Delivery` GUID, which Forgejo emits and keeps stable across its own retries.",
			"which GitLab keeps constant across its retries.",
			"on GitHub when someone redelivers it by hand, on GitLab through its own retries.",
			"a key derived from the payload is not stable across a retry, so it would dedup some redeliveries",
			"So the delivery id is a GUID with the same across-retry stability GitHub's has",
		],
		spares: ["a key derived from the payload is not stable across a resend", "GitLab does not retry a 5xx, and its resend keeps the id"],
	},
	{ name: "an automatic redelivery", re: /\bauto-?redeliver/i, catches: ["GitHub's auto-redelivery is weaker than GitLab's"] },
	{ name: "a retry on timeout", re: /\bretries on timeout\b/i, catches: ["a redelivered webhook (GitHub retries on timeout)"] },
	{
		name: "a redelivery storm or loop",
		re: /\bredelivery (?:storm|loop)\b/i,
		catches: ["still a 2xx (a non-2xx would trigger a redelivery storm for a handled delivery)", "One clear message beats a redelivery loop."],
		spares: ["One clear message beats every delivery failing.", "a redelivery of a steered comment is never enqueued"],
	},
	{ name: "a forge retry of a delivery", re: /\ba forge retry\b/i, catches: ["because a forge retry of a delivery that IS queued deserves the answer \"queued\""] },
	{ name: "a 503 called redeliverable", re: /\(redeliverable\)/i, catches: ["an indeterminate permission lookup is 503 (redeliverable), never 204"] },
	{
		// The passive claim: a failed delivery "is redelivered", with nobody doing it. A clause that says who does it
		// (by hand) or when it would be (unless, once, can be) is the correct sentence, and is spared.
		name: "a failed delivery said to be redelivered, by nobody",
		re: /\b(?:503|5xx|non-2xx|failed|failure|timeout|timed out)\b(?:(?![.;:!?]|\b(?:unless|until|if|once|when|whenever|after|can|could|may|might|must|to|by hand)\b).){0,60}?\b(?:is|are|gets|get) (?:then |automatically |simply )?redelivered\b(?! by hand| manually| by (?:someone|a person|an operator|you))|\b503, redelivered\b/i,
		catches: [
			"a lookup that cannot complete answers 503 and is redelivered rather than silently dropped.",
			"*loudly* for an indeterminate one (503, redelivered), but a gate with a moving part",
			"a delivery that timed out gets redelivered, and the GUID dedups it",
		],
		spares: [
			"a delivery answered 503 is lost unless it is redelivered by hand within 3 days.",
			"the receiver answers 503; the delivery can be redelivered from Recent Deliveries.",
			"a 503 that is redelivered by hand keeps the GUID, so it queues at most once.",
		],
	},
	{
		name: "the forge retries",
		re: /\bthe forge(?:'s)? (?:then |own |auto-?)?retr(?:y|ies|ying)\b/i,
		catches: ["the receiver answers 503 and the forge retries until Valkey is back", "the forge's own retry dedups on the GUID"],
		spares: ["the forge does not retry a delivery answered 503, Azure DevOps excepted", "a retry by the forge is Azure's alone"],
	},
	{
		name: "a forge that will retry",
		re: /\b(?:GitHub|GitLab|Forgejo|the forge)(?: will|'ll| would| should)(?: then| automatically| eventually| later| just)? retry\b/i,
		catches: ["answers 503 so GitHub will retry the delivery", "GitLab will retry it later", "Forgejo would then retry"],
		spares: ["GitLab will not retry it, whatever the answer", "Azure DevOps will retry a 503 up to 8 times over about 3 minutes"],
	},
	{
		name: "a forge that sends it again later",
		re: /\b(?:GitHub|GitLab|Forgejo|the forge)(?: (?:then|simply|just|will|would|automatically|eventually))? sends? (?:it|them|the (?:delivery|deliveries|event|request|webhook)) again later\b/i,
		catches: ["the receiver answers 503 and GitHub sends it again later", "the forge will send the delivery again later"],
		spares: ["Azure DevOps sends it again later, up to 8 times over about 3 minutes", "Forgejo does not send it again on its own", "GitHub never sends it again later"],
	},
]);

/**
 * The trees the claim lived in, and the ones it could move to (the worker's tests, the console's words), plus every
 * Markdown file at the repository root. Each spec file's revision table is skipped: old rows quote the old claims,
 * and stay.
 */
const TREES = Object.freeze(["receiver/src", "receiver/test", "worker/src", "worker/test", "admin/src", "specs", "docs"]);
const TEXT = /\.(?:mjs|js|md)$/;
/** `revision-row-check.mjs`'s header: the LAST such line in a spec file starts its revision table. */
const REVISION_HEADER = /^\|\s*(Date|Version)\s*\|/;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name !== "node_modules" && name !== "fixtures" && name !== "images") walk(path, out);
		} else if (TEXT.test(name) && path !== SELF) out.push(path);
	}
	return out;
}

/** Every Markdown file at the root (README.md, SECURITY.md, AGENTS.md), and each top-level directory's README.md. */
function readmes() {
	const out = readdirSync(REPO).filter((name) => name.endsWith(".md")).map((name) => join(REPO, name));
	for (const name of readdirSync(REPO)) {
		const path = join(REPO, name, "README.md");
		try {
			if (statSync(path).isFile()) out.push(path);
		} catch {}
	}
	return out;
}

/**
 * The lines a claim may hide in, joined into one string so a sentence broken across lines is still one sentence: each
 * line loses its comment or list marker, its `*` emphasis and its backticks, and its whitespace is collapsed. Returns
 * the text and the starting offset of every line, so a finding names the line it starts on.
 */
function joined(lines) {
	let text = "";
	const starts = [];
	for (const line of lines) {
		starts.push(text.length);
		const bare = line.replace(/^\s*(?:\/\/+|\/\*+|\*+\/?|#+|>|[-+] )/, "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
		text += bare + " ";
	}
	return { text, starts };
}

/** Every claim in `source`: `{ line, name, text }`, with `line` 1-based. */
function claimsIn(source, { spec = false } = {}) {
	let lines = source.split("\n");
	if (spec) {
		let start = -1;
		for (let i = 0; i < lines.length; i++) if (REVISION_HEADER.test(lines[i])) start = i;
		if (start !== -1) lines = lines.slice(0, start);
	}
	const { text, starts } = joined(lines);
	const found = [];
	for (const claim of CLAIMS) {
		const re = new RegExp(claim.re.source, "gi");
		for (const m of text.matchAll(re)) {
			let line = 0;
			while (line + 1 < starts.length && starts[line + 1] <= m.index) line++;
			found.push({ line: line + 1, name: claim.name, text: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) });
		}
	}
	return found;
}

test("each claim shape catches its sentences, so none is vacuous, and spares the correct ones beside it", () => {
	for (const claim of CLAIMS) {
		assert.ok(claim.catches.length > 0, claim.name);
		for (const sentence of claim.catches) assert.ok(claimsIn(sentence).some((f) => f.name === claim.name), `${claim.name}: ${sentence}`);
		for (const sentence of claim.spares ?? []) assert.deepEqual(claimsIn(sentence), [], `${claim.name} spares: ${sentence}`);
	}
	// A sentence broken across lines, inside a comment or behind emphasis, is still caught, on the line it starts on.
	assert.deepEqual(claimsIn("intro\nthe receiver answers **503** and\nGitLab redelivers.").map((f) => f.line), [3]);
	assert.deepEqual(claimsIn("\t// 503 so the forge\n\t// redelivers, the GUID dedups").map((f) => f.line), [1]);
	assert.deepEqual(claimsIn(" * across its\n * own retries").map((f) => f.name), ["a forge's own retries"]);
});

test("the correct words around a 503 match no claim shape", () => {
	for (const sentence of [
		"GitHub does not resend a delivery answered 503, and a hand redelivery keeps `X-GitHub-Delivery`.",
		"GitHub never resends it on its own; someone redelivers it by hand within 3 days.",
		"GitLab never resends a 5xx or a timeout, and a Resend Request keeps the `Idempotency-Key`.",
		"Forgejo does not send it again on its own; a replay is a new delivery with a new GUID.",
		"Azure DevOps resends a 503 up to 8 times over about 3 minutes.",
		"GitHub does not automatically redeliver failed deliveries",
		"a resend of a delivery that IS queued (a hand redelivery, or Azure's own resend) deserves the answer",
	]) assert.deepEqual(claimsIn(sentence), [], sentence);
});

test("a spec file's revision table is skipped, and only it: old rows quote the old claim", () => {
	const spec = ["# Spec", "body: the forge redelivers", "", "| Date | Change |", "|---|---|", "| 2026-01-01 | answers 503 so the forge redelivers |"].join("\n");
	assert.deepEqual(claimsIn(spec, { spec: true }).map((f) => f.line), [2]);
	assert.equal(claimsIn(spec).length, 2, "outside specs/ nothing is skipped");
});

test("no source, test, spec or doc says a forge sends a delivery answered 503 again when it does not (issue #809)", () => {
	const files = [...TREES.flatMap((tree) => walk(join(REPO, tree))), ...readmes()];
	assert.ok(files.length > 100, `the scan reads the trees (${files.length} files)`);
	for (const lived of [["receiver", "src", "receiver.mjs"], ["specs", "requirements.md"], ["SECURITY.md"], ["worker", "test", "queue.test.mjs"], ["admin", "src", "console", "panels", "connections.mjs"]]) {
		assert.ok(files.includes(join(REPO, ...lived)), `and the files the claim lived in, or could: ${join(...lived)}`);
	}
	const problems = [];
	for (const file of files) {
		const rel = relative(REPO, file);
		for (const f of claimsIn(readFileSync(file, "utf8"), { spec: rel.startsWith("specs") })) problems.push(`${rel}:${f.line}: ${f.name}: "...${f.text}..."`);
	}
	assert.deepEqual(problems, []);
});
