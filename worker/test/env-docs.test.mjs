/**
 * The configuration an operator can discover (issue #282, `REQ-DEPLOYMENT-BOOTSTRAP`).
 *
 * `init` copies `.env.example` verbatim into a new deployment, so that file is the whole of what an
 * operator can learn this system accepts. A variable read by the code and absent from it is one nobody
 * can find: the refusal that eventually names it is met as an error rather than as documentation. The
 * rule this file enforces is therefore: every environment variable the three services and the runner
 * read is EITHER a key in `.env.example` (commented out is fine) OR carries `env-internal <NAME>:` at
 * its own read site, saying why it cannot be a key.
 *
 * Why a marker at the read site rather than a list here: a list is a second thing to keep true, and it
 * drifts from the code it describes. `worker/src/reserved-env.mjs` states that rule for the reserved
 * name sets ("imported by the validator beside this one, never copied into it") and it holds for the
 * same reason here. A marker cannot outlive the read it annotates without this file noticing.
 *
 * The scan is source TEXT, deliberately, and its limits are stated rather than hidden:
 *
 *   - It reads code with comments stripped, so a variable a comment merely MENTIONS is not treated as
 *     read. Measured when this landed: exactly two comment lines in the four trees carry an `env.NAME`
 *     form and both names are declared, so stripping changes no verdict today. It is about what the
 *     assertion MEANS, not about a live false positive.
 *   - It runs in ONE direction: a name read and not accounted for fails. The reverse (a key nothing
 *     reads) is NOT asserted, because some names genuinely reach the code by indirection this scan
 *     cannot follow. `env[patVar]` (`worker/src/config.mjs`) resolves `GITHUB_PAT` through a variable,
 *     and provider keys are resolved by pi at runtime through `findEnvKeys`. Asserting the reverse
 *     would fail on a correct tree.
 *   - It FAILS CLOSED on an unfamiliar RECEIVER: any identifier ending in `env` other than the known
 *     ones is a fourth way to read the environment, and the test says so instead of silently shrinking
 *     its own scope. Destructuring the environment is refused for the same reason.
 *   - It does NOT see a read through a NAME ARRAY. `["A","B"].filter((k) => env[k])` at
 *     `worker/src/doctor.mjs:565`, `:595` and `:915` reads real variables this scan cannot attribute.
 *     Every name those three sites touch is covered from another file today, which is why nothing
 *     fails, and that is luck rather than design. It is stated here so the next person meets it as a
 *     known limit rather than as a surprise; closing it needs a parser, not a wider regex.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every tree whose code runs in a deployment. `image/runner` rather than `image/runner/src`, because
// `run-job.mjs` sits beside `src/` and reads the environment too.
const TREES = ["worker/src", "receiver/src", "admin/src", "image/runner"];
const SOURCE_EXTS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts"]);
// admin/ is TypeScript and .mjs together; a `*.mjs` glob would silently drop six names.
const SKIP_DIRS = new Set(["test", "node_modules", "dist"]);

// The receivers an environment read is allowed to have. `process.env.X` presents as `env` too.
const ENV_RECEIVERS = new Set(["env", "hostEnv"]);
// Names that END in "env" and are not one. Empty today, and a maintainer adding a `Env` enum or a
// `containerEnv` map they BUILD rather than read puts it here with the reason, which is the escape hatch
// that lets the check below stay loud instead of being loosened.
const NON_ENV_RECEIVERS = new Map();

// Words after which a `/` opens a regular expression rather than dividing. The character before is not
// enough on its own: `return /x/` ends in a letter and `a / b` ends in a letter too.
const REGEX_PRECEDING_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "case", "do", "else", "yield", "await", "new", "delete", "void", "throw"]);

/**
 * Strip line and block comments, keeping string and template literals (a name passed to a helper as
 * `positiveInt(env, "PI_DAILY_CAP", 25)` is a read and must survive). Newlines inside a stripped block
 * are kept so reported line numbers stay honest.
 *
 * Regular expressions are tracked, and that is not fussiness. A literal like `/^["\']$/` holds a quote,
 * and without regex state that quote opens a phantom string that never closes, so EVERY comment after it
 * in the file survives into the scanned text and every variable a comment merely names reads as a live
 * read. The failure is a red test on a correct tree, and `["\']` is an ordinary idiom, used by this file's
 * own patterns below. The stripper's own behaviour is pinned by tests at the bottom of this file.
 */
export function stripComments(src) {
	let out = "";
	let state = "code";
	let prevChar = ""; // last non-space character emitted in code state
	let word = ""; // and the identifier it belongs to, when it is one
	for (let i = 0; i < src.length; ) {
		const c = src[i];
		const d = src[i + 1];
		if (state === "code") {
			if (c === "/" && d === "/") { state = "line"; i += 2; continue; }
			if (c === "/" && d === "*") { state = "block"; i += 2; continue; }
			if (c === "/" && startsRegex(prevChar, word)) {
				const end = regexEnd(src, i);
				if (end > 0) { out += src.slice(i, end); prevChar = "/"; word = ""; i = end; continue; }
			}
			if (c === '"' || c === "'" || c === "`") state = c;
			out += c;
			if (!/\s/.test(c)) {
				prevChar = c;
				word = /[\w$]/.test(c) ? word + c : "";
			}
			i++; continue;
		}
		if (state === "line") { if (c === "\n") { state = "code"; out += c; } i++; continue; }
		if (state === "block") { if (c === "*" && d === "/") { state = "code"; i += 2; } else { if (c === "\n") out += c; i++; } continue; }
		// A quoted string cannot span a line in JavaScript, so a newline while inside one means the quote
		// that opened it was never a string quote at all. This is the BOUND on the regex heuristic below:
		// `if (a) /["]/.test(b)` opens a regex after `)`, which the heuristic reads as division, and that
		// stray quote would otherwise swallow every comment in the rest of the FILE. Resetting here costs
		// the remainder of one line and cannot cascade. Backticks are excluded: those really do span lines.
		if (c === "\n" && state !== "`") { state = "code"; out += c; i++; continue; }
		if (c === "\\") { out += c + (d ?? ""); i += 2; continue; } // an escape cannot close the literal
		if (c === state) state = "code";
		out += c; i++;
	}
	return out;
}

function startsRegex(prevChar, word) {
	if (prevChar === "") return true; // start of file
	if (/[\w$)\]]/.test(prevChar)) return REGEX_PRECEDING_WORDS.has(word);
	return true; // an operator, a comma, a brace: a value is expected, so this opens one
}

/** Index just past the closing `/` of the literal starting at `i`, or -1 when it does not terminate on
 *  its own line, which means it was a division after all. */
function regexEnd(src, i) {
	let inClass = false;
	for (let j = i + 1; j < src.length; j++) {
		const c = src[j];
		if (c === "\\") { j++; continue; }
		if (c === "\n") return -1;
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return j + 1;
	}
	return -1;
}

export function sourceFiles(dir, acc = []) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (!SKIP_DIRS.has(entry)) sourceFiles(p, acc);
		} else if (SOURCE_EXTS.has(extname(p))) {
			acc.push(p);
		}
	}
	return acc;
}

const allSources = () => TREES.flatMap((t) => sourceFiles(join(REPO_ROOT, t)));
const rel = (f) => f.slice(REPO_ROOT.length + 1);

const READ_PATTERNS = [
	/(?:^|[^\w$.])(?:process\.env|env|hostEnv)\??\.([A-Z][A-Z0-9_]{2,})\b/g, // env.NAME
	/(?:^|[^\w$.])(?:process\.env|env|hostEnv)\??\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g, // env["NAME"]
	/\(\s*(?:process\.env|env|hostEnv)\s*,\s*["']([A-Z][A-Z0-9_]{2,})["']/g, // positiveInt(env, "NAME", 3)
];

/** Every environment variable name read in the deployment trees, mapped to the files reading it. */
export function scanEnvReads(files = allSources()) {
	const found = new Map();
	for (const f of files) {
		const code = stripComments(readFileSync(f, "utf8"));
		for (const re of READ_PATTERNS) {
			re.lastIndex = 0;
			for (let m; (m = re.exec(code)) !== null; ) {
				if (!found.has(m[1])) found.set(m[1], new Set());
				found.get(m[1]).add(rel(f));
			}
		}
	}
	return found;
}

/** Every name marked `env-internal <NAME>[, <NAME>]:` at a read site. Markers ARE comments, so this
 *  reads the raw source rather than the stripped copy. */
export function markedInternal(files = allSources()) {
	const marked = new Map();
	const re = /env-internal\s+([A-Z][A-Z0-9_,\s]*?)\s*:/g;
	for (const f of files) {
		const src = readFileSync(f, "utf8");
		re.lastIndex = 0;
		for (let m; (m = re.exec(src)) !== null; ) {
			for (const name of m[1].split(",").map((n) => n.trim()).filter(Boolean)) {
				if (!marked.has(name)) marked.set(name, new Set());
				marked.get(name).add(rel(f));
			}
		}
	}
	return marked;
}

/** Names `.env.example` declares. Pinned to column 0 to 2 (`NAME=` or `# NAME=`), so continuation
 *  prose such as "Prefer GITHUB_AUTH_SOURCE=app" cannot grant a variable false coverage. */
export function declaredInEnvExample() {
	const txt = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
	const names = new Set();
	for (const line of txt.split("\n")) {
		const m = /^#? ?([A-Z][A-Z0-9_]{2,})=/.exec(line);
		if (m) names.add(m[1]);
	}
	return names;
}

test("every environment variable the code reads is a documented key or is marked internal", () => {
	const read = scanEnvReads();
	const declared = declaredInEnvExample();
	const marked = markedInternal();

	// Per READING FILE, not per name: a marker in one file must not account for a read in another, or
	// deleting the marker beside a read would leave the read covered from somewhere else entirely. This
	// is what "at its own read site" means, and it is the difference between a marker and a list.
	const unaccounted = [];
	for (const [name, files] of read) {
		if (declared.has(name)) continue;
		for (const f of files) {
			if (!marked.get(name)?.has(f)) unaccounted.push(`${name} (read in ${f}, not marked there)`);
		}
	}

	assert.deepEqual(
		unaccounted.sort(),
		[],
		"an operator cannot discover these: add each to .env.example, or mark it `env-internal <NAME>: <why>` beside the read",
	);
});

test("the scan still reaches every tree it claims to cover", () => {
	// A single total was the wrong canary: measured, dropping `receiver/src`, `admin/src` or
	// `image/runner` from the walk still left over 90 names, so three of the four could fall out of the
	// scan (a rename, a moved file, a new SKIP_DIRS entry) with the check green.
	//
	// Iterating TREES was the wrong SECOND canary, and for the more instructive reason: a check derived
	// from the constant is correct at every value of it, so deleting a tree deleted its own assertion.
	// The list is pinned literally first. Adding a deployment tree is meant to be a deliberate edit here.
	assert.deepEqual(TREES, ["worker/src", "receiver/src", "admin/src", "image/runner"], "the scanned trees changed");
	for (const tree of TREES) {
		const names = scanEnvReads(sourceFiles(join(REPO_ROOT, tree)));
		assert.ok(names.size > 0, `${tree} contributed no environment reads at all, so the walk is not reaching it`);
	}
	assert.ok(scanEnvReads().size > 90, "the whole scan collapsed");
});

test("a read shape the scan cannot see is refused rather than missed", () => {
	// `const { PI_A, PI_B } = process.env` is a real read that no pattern here matches, so it would be
	// invisible to BOTH halves of the accounting: not scanned, and therefore never demanding a marker.
	// The repo does not use it today. Refusing it keeps that true, rather than trusting that it stays so.
	const offenders = [];
	for (const f of allSources()) {
		const code = stripComments(readFileSync(f, "utf8"));
		for (const m of code.matchAll(/\{[^{}]*\}\s*=\s*(?:process\.env|env|hostEnv)\b/g)) {
			offenders.push(`${rel(f)}: ${m[0].replace(/\s+/g, " ").slice(0, 60)}`);
		}
	}
	assert.deepEqual(offenders.sort(), [], "destructuring the environment hides the read from this scan: use env.NAME");
});

test("a name is documented or internal, never both", () => {
	// Both would mean the file offers a key the code overwrites or ignores: the believed-on-while-off
	// failure this rule exists to prevent, arrived at from the other side.
	const declared = declaredInEnvExample();
	const both = [...markedInternal().keys()].filter((n) => declared.has(n)).sort();
	assert.deepEqual(both, [], "these are declared in .env.example AND marked internal; pick one");
});

test("an internal marker sits beside a read of the variable it names", () => {
	// A marker outliving its read is a comment describing code that is gone, and it would keep a name
	// accounted for forever. A marker in a file that never reads the name is the same defect, moved.
	const read = scanEnvReads();
	const stale = [];
	for (const [name, files] of markedInternal()) {
		for (const f of files) {
			if (!read.get(name)?.has(f)) stale.push(`${name} (marked in ${f}, which does not read it)`);
		}
	}
	assert.deepEqual(stale.sort(), [], "these markers annotate a read that is not there: move or delete them");
});

test("no fourth way to read the environment slips past the scan", () => {
	// The scan knows `env`, `hostEnv` and `process.env`. A new holder, say `jobEnv.PI_THING`, would be
	// read by the code and invisible here, and the test would keep passing while its scope shrank. So
	// any receiver whose name ends in `env` and is not one of the known ones fails loudly.
	const offenders = [];
	for (const f of allSources()) {
		const code = stripComments(readFileSync(f, "utf8"));
		const re = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\??\.[A-Z][A-Z0-9_]{2,}\b/g;
		for (let m; (m = re.exec(code)) !== null; ) {
			const receiver = m[1];
			if (/env$/i.test(receiver) && !ENV_RECEIVERS.has(receiver) && !NON_ENV_RECEIVERS.has(receiver)) {
				offenders.push(`${rel(f)}: ${receiver}`);
			}
		}
	}
	assert.deepEqual(
		[...new Set(offenders)].sort(),
		[],
		"a new environment holder: teach READ_PATTERNS and ENV_RECEIVERS about it, or the scan silently stops covering it",
	);
});

test("the stripper survives the literal forms that would otherwise fake a read", () => {
	// Each of these leaked before regex state was tracked: a quote inside a regular expression opened a
	// string that never closed, so every comment after it in the file reached the scan and any variable
	// a comment merely named counted as read. The failure mode is a red test on a correct tree, which is
	// worse than a missed name, so it is pinned here rather than argued about in a header.
	const cases = [
		['const re = /^["\']$/;', "a regex holding both quote characters"],
		["const r = /don't/;", "a regex holding an apostrophe"],
		["const r = /`/;", "a regex holding a backtick"],
		["function f() { return /['\"]/; }", "a regex after `return`, which ends in a letter"],
		["const r = /[^\\s/]+\\/[^\\s/]+/;", "a regex with a slash inside a character class"],
		["const n = (a) / b / c;", "division, which must NOT be read as a regex"],
		["const n = total / count;", "division between two identifiers"],
		['const t = `a ${o["K"]} b`;', "a template literal with a quoted key inside its expression"],
		['if (a) /["]/.test(b);', "a regex after `)`, which the heuristic reads as division"],
		['const a = (x) / y + "a/b";', "division on a line that also holds a quoted slash"],
	];
	for (const [code, what] of cases) {
		const out = stripComments(`${code}\n// env.PI_GHOST_NAME\n`);
		assert.ok(!out.includes("PI_GHOST_NAME"), `a comment survived after ${what}: ${JSON.stringify(out)}`);
	}
	// And the other direction: a real read must never be stripped along with the comments.
	const kept = stripComments('const v = env.PI_REAL; // and a trailing note\n');
	assert.ok(kept.includes("env.PI_REAL"), "the stripper ate a real read");
	assert.ok(!kept.includes("trailing note"), "the stripper kept a comment");

	// The two cases above are handled by the line bound rather than by the regex heuristic, so pin the
	// bound itself: a quote the scanner misreads must cost the rest of ONE line and never cascade.
	const bounded = stripComments('const s = "unclosed\nconst v = env.PI_AFTER; // note\n');
	assert.ok(bounded.includes("env.PI_AFTER"), "a mis-read quote swallowed the following lines");
	assert.ok(!bounded.includes("note"), "a mis-read quote stopped comments being stripped after it");

	// A template literal genuinely spans lines and must NOT be reset at the newline.
	const template = stripComments("const t = `one\n// still inside the template\ntwo`;\n// env.PI_TAIL\n");
	assert.ok(template.includes("still inside the template"), "a multiline template was cut at its first newline");
	assert.ok(!template.includes("PI_TAIL"), "the comment after the template survived");
});
