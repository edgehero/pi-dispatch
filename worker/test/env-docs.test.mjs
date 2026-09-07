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
 *   - It FAILS CLOSED on an unfamiliar idiom: any receiver whose name ends in `env` other than the
 *     three known ones is a fourth way to read the environment, and the test says so instead of
 *     silently shrinking its own scope.
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

/**
 * Strip line and block comments, keeping string and template literals (a name passed to a helper as
 * `positiveInt(env, "PI_DAILY_CAP", 25)` is a read and must survive). Newlines inside a stripped block
 * are kept so reported line numbers stay honest.
 *
 * A regex literal cannot begin `//` or an unescaped `/*` in valid JavaScript, so the two-character
 * lookahead is safe without tracking regex state.
 */
export function stripComments(src) {
	let out = "";
	let state = "code";
	for (let i = 0; i < src.length; ) {
		const c = src[i];
		const d = src[i + 1];
		if (state === "code") {
			if (c === "/" && d === "/") { state = "line"; i += 2; continue; }
			if (c === "/" && d === "*") { state = "block"; i += 2; continue; }
			if (c === '"' || c === "'" || c === "`") state = c;
			out += c; i++; continue;
		}
		if (state === "line") { if (c === "\n") { state = "code"; out += c; } i++; continue; }
		if (state === "block") { if (c === "*" && d === "/") { state = "code"; i += 2; } else { if (c === "\n") out += c; i++; } continue; }
		if (c === "\\") { out += c + (d ?? ""); i += 2; continue; } // an escape cannot close the literal
		if (c === state) state = "code";
		out += c; i++;
	}
	return out;
}

function sourceFiles(dir, acc = []) {
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
	assert.ok(read.size > 90, `the scan found only ${read.size} names, which means it stopped working, not that the code shrank`);
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
			if (/env$/i.test(receiver) && !ENV_RECEIVERS.has(receiver)) offenders.push(`${rel(f)}: ${receiver}`);
		}
	}
	assert.deepEqual(
		[...new Set(offenders)].sort(),
		[],
		"a new environment holder: teach READ_PATTERNS and ENV_RECEIVERS about it, or the scan silently stops covering it",
	);
});
