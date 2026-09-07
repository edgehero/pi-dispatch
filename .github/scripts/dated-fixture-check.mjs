/**
 * Flag a test that names an INSTANT and then builds its subject on the DEFAULT clock (issues #284, #293).
 *
 * THE FAILURE THIS EXISTS FOR ARRIVES ON A TREE NOBODY TOUCHED. Such a test passes until the wall clock
 * drifts past the subject's own retention window, then fails in CI against a commit that changed nothing
 * near it. Issue #284 was exactly that, and `main` froze until it was fixed, because `contract-tests` is
 * required and `enforce_admins` is on. The fix is always one property: pass the clock you already named.
 *
 * WHY THIS IS NOT THE OBVIOUS RULE. The rule as first proposed -- a `Date.parse("20...` literal anywhere
 * in a file that also constructs a clock-taking factory without `now` -- was measured against this tree
 * and flagged SEVEN of the ten files carrying a date literal, INCLUDING `run-mirror.test.mjs`, the file
 * issue #284 fixed. Three narrowings bring it to the real ones, and each is here because the naive
 * version was measured wrong rather than because it looked untidy:
 *
 *   1. BLOCK SCOPE, not file scope. `run-mirror.test.mjs` declares one shared `AT` at module scope and
 *      injects it everywhere; file scoping calls the exemplar a violation.
 *   2. ACCEPT `now` SHORTHAND, and skip POSITIONAL clocks. `{ ..., now }` is ES shorthand with no colon,
 *      and fifteen exports in this tree take their clock positionally (`dayKey`, `reserveBudget`,
 *      `readMirroredRuns` and kin), which a by-name rule cannot see at all. Those are out of scope, and
 *      saying so is better than pretending otherwise.
 *   3. MATCH THE PARAMETER NAME, not the parameter LIST. `scanRunRecords({ logsDir, nowMs = Date.now() })`
 *      contains the substring "now" inside its own DEFAULT EXPRESSION; four false positives came from
 *      that alone.
 *
 * HOW IT AVOIDS THE ALLOWLIST ITS SIBLING WARNS ABOUT. `test-count-check.mjs` refuses a grep guard because
 * "an allowlist is a thing that erodes". Two structural answers. The set of clock-taking factories is
 * COMPUTED by walking the source trees for exported functions with a parameter literally named `now` or
 * `nowMs`, so one added tomorrow joins automatically and one that drops its clock leaves automatically:
 * there is nothing to keep in step. And there is NO SUPPRESSION MECHANISM, because passing `now` is
 * always correct and always cheaper than a suppression would be -- an escape hatch here would be more
 * typing than the fix.
 *
 * THIS CHECK AND THE CLOCK-SHIFTED RUN DISAGREE, BY DESIGN, AND NEITHER SUBSUMES THE OTHER. Both were
 * measured. The shifted run catches `worker/test/triggers-file.test.mjs`, which holds NO date literal at
 * all (its fuse was a filesystem mtime compared against `Date.now()`), so no literal-based rule can see
 * it. This check catches a defaulted clock beside a literal even where the subject happens not to read
 * the clock on that path, which the shifted run cannot see because nothing goes red. This one is the fast
 * authoring hint, a second rather than two minutes; the shifted run is the oracle. Delete either and you
 * lose a class.
 *
 * esbuild is used the way `worker/test/env-docs.test.mjs` uses it: as a COMMENT STRIPPER and a
 * does-this-parse oracle, never as a parser -- its API emits code, not a tree. A commented-out fixture
 * must not flag a file, and a file esbuild will not parse is not this check's business.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where tests live, and where the factories they construct are defined. */
const TEST_DIRS = ["image/runner/test", "worker/test", "receiver/test", "admin/test"];
const SRC_DIRS = ["worker/src", "receiver/src", "admin/src", "image/runner/src"];

/** An ISO-ish date literal: what "this test names an instant" looks like in practice. */
const DATE_LITERAL = /["'`](\d{4})-(\d{2})-(\d{2})[T"' `]/;

/** A clock parameter, by NAME, in a destructured options object. Never the default expression. */
const CLOCK_PARAM = /(?:^|[{,\s])(now|nowMs)\s*(?==|,|\}|$)/;

let stripComments = (src) => src;
try {
	const esbuild = await import("esbuild");
	stripComments = (src) => {
		try {
			return esbuild.transformSync(src, { loader: "js", legalComments: "none" }).code;
		} catch {
			return null; // a file esbuild will not parse is not this check's business
		}
	};
} catch {
	// esbuild absent (a worker-only install): fall back to the raw source. Comments may then produce a
	// false positive, which is a worse day than a missed one but not a broken build -- and CI always has it.
}

function listFiles(dirs, suffix) {
	return dirs.flatMap((d) => {
		let names = [];
		try {
			names = readdirSync(d);
		} catch {
			return []; // a workspace that is not present is not a failure
		}
		return names.filter((f) => f.endsWith(suffix)).map((f) => join(d, f));
	});
}

/** Every exported function whose parameter list names a clock. COMPUTED, never listed. */
function clockTakingFactories() {
	const names = new Set();
	for (const file of listFiles(SRC_DIRS, ".mjs").concat(listFiles(SRC_DIRS, ".ts"))) {
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)) {
			const open = m.index + m[0].length - 1;
			let depth = 0;
			let end = open;
			for (; end < src.length; end++) {
				if (src[end] === "(") depth += 1;
				else if (src[end] === ")") {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			if (CLOCK_PARAM.test(src.slice(open + 1, end))) names.add(m[1]);
		}
	}
	return names;
}

/**
 * Split a test file into a MODULE-SCOPE block plus one per top-level `test("...", ...)`.
 *
 * Module scope is its own block and is not optional. Issue #284's actual fuse lived in a module-scope
 * helper -- `const anchored = (opts) => makeRunMirror({ now: () => AT, ...opts })` beside
 * `const AT = Date.parse(...)` -- so a rule that only looked inside test bodies would miss the very
 * defect it was written for, which is the acceptance criterion #293 states. Measured: with module scope
 * omitted, reverting #284's fix leaves this check green.
 */
function testBlocks(src) {
	const lines = src.split("\n");
	const blocks = [];
	let current = { line: 1, title: "<module scope>", body: [] };
	lines.forEach((line, i) => {
		if (/^test\(/.test(line)) {
			blocks.push(current);
			current = { line: i + 1, title: (line.match(/^test\(\s*["'`](.*?)["'`]/) ?? [])[1] ?? "", body: [] };
		}
		current.body.push({ text: line, line: i + 1 });
	});
	blocks.push(current);
	return blocks;
}

const factories = clockTakingFactories();
const findings = [];
let checked = 0;

for (const file of listFiles(TEST_DIRS, ".test.mjs")) {
	const raw = readFileSync(file, "utf8");
	const stripped = stripComments(raw);
	if (stripped === null) continue;
	checked += 1;
	// Line numbers must come from the RAW file, so a finding points where an author can act. esbuild's
	// output is only consulted to decide whether a line survives as code rather than as a comment.
	const live = new Set(stripped.split("\n").map((l) => l.trim()).filter(Boolean));
	for (const block of testBlocks(raw)) {
		const dated = block.body.find((l) => DATE_LITERAL.test(l.text) && live.has(l.text.trim()));
		if (!dated) continue;
		for (const l of block.body) {
			const call = l.text.match(new RegExp(`\\b(${[...factories].join("|")})\\s*\\(\\s*\\{`));
			if (!call || !live.has(l.text.trim())) continue;
			// The call's own argument object: does it hand over a clock?
			const tail = block.body.slice(block.body.indexOf(l), block.body.indexOf(l) + 6).map((x) => x.text).join(" ");
			// The SAME two names the factory scan accepts. Looking for `now` alone here while accepting
			// `nowMs` there made `admin/test/costs.test.mjs` a false positive on a call that does pass its clock.
			if (/[{,\s](?:now|nowMs)\s*[:,}]/.test(tail)) continue;
			findings.push({ file, title: block.title, dateLine: dated.line, callLine: l.line, fn: call[1] });
			break;
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(`dated-fixture-check: ${findings.length} test(s) pair a dated fixture with a default clock\n\n`);
	for (const f of findings) {
		process.stderr.write(`  ${f.file}:${f.callLine}  "${f.title}"\n`);
		process.stderr.write(`      date literal at :${f.dateLine}  ->  ${f.fn}(...) built at :${f.callLine} with \`now\` defaulted\n\n`);
	}
	process.stderr.write(
		"A test that names an instant and then builds its subject on the real Date.now is a fuse: it passes\n" +
			"until the wall clock drifts past that subject's own window, then fails in CI on a tree nobody\n" +
			"touched (issue #284 was a seven day fuse that blocked every merge). Pass the clock you already\n" +
			"named:\n\n      makeThing({ ..., now: () => AT })\n\n" +
			"Do NOT move the fixture date forward, which re-arms the fuse. worker/test/run-mirror.test.mjs is\n" +
			"the worked example: one shared `AT` and an `anchored` helper. The clock-shifted step in\n" +
			"contract-tests is the oracle; this check is the fast answer that fails in a second.\n",
	);
	process.exit(1);
}
process.stdout.write(`dated-fixture-check: ${checked} test files, ${factories.size} clock-taking factories, no dated fixture on a default clock\n`);
