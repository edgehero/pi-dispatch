import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { envFileHazard, envKeyIsBlank, envValueShown, readEnvAssignments, renderEnvValue, setEnvKey, setEnvKeyIfEmpty, updateEnvFile } from "../src/env-file.mjs";

// -- setEnvKeyIfEmpty: pure transform, table-driven over the text shapes it must handle ---------------
//
// `expected: null` means "byte-identical input back" — asserted by identity (===), because the wrapper
// relies on identity to skip the write entirely, and a re-serialized equal COPY would defeat that.

const cases = [
	{
		name: "empty value is filled in place",
		text: "A=1\nWEBHOOK_SECRET=\nB=2\n",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "whitespace around = and a whitespace-only value still count as empty",
		text: "A=1\nWEBHOOK_SECRET =   \nB=2\n",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		// The comment line is KEPT, above the new one (issue #357). `.env.example` documents every key
		// inline with indented continuations below, and filling four commented keys used to delete four
		// lines of the operator's own reference. Carrying the inline `# ...` onto the new line instead was
		// written and rejected: systemd's `EnvironmentFile=` parser only recognises a comment at the start
		// of a line, so it would have set the variable to the value PLUS the sentence.
		// A BARE commented key is DROPPED, not kept (issue #394). Keeping it was for the inline documentation
		// `.env.example` used to carry on the key's own line; issue #392 moved that ABOVE the key, where this
		// transform never touches it, so the kept line became a stub whose only purpose was to carry text it
		// no longer carries -- four of them in every `up` deployment. The two cases below show what keeping is
		// still for: a line that actually says something.
		name: "a BARE commented key is replaced outright, leaving no stub behind",
		text: "A=1\n# WEBHOOK_SECRET=\nB=2\n",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "a commented line without the space after # also counts",
		text: "#WEBHOOK_SECRET=old-note\nB=2\n",
		expected: "#WEBHOOK_SECRET=old-note\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
	},
	{
		name: "an inline comment survives as the line it was, never as a tail on the value",
		text: "# WEBHOOK_SECRET=            # what the receiver verifies deliveries with\n",
		expected: "# WEBHOOK_SECRET=            # what the receiver verifies deliveries with\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "no trace of the key appends at the end",
		text: "A=1\nB=2\n",
		expected: "A=1\nB=2\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "appending to text without a trailing newline first completes the last line",
		text: "A=1",
		expected: "A=1\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "appending to empty text yields just the one line",
		text: "",
		expected: "WEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "an already-set value is NEVER clobbered",
		text: "A=1\nWEBHOOK_SECRET=operator-chose-this\nB=2\n",
		expected: null,
	},
	{
		// The wrapper scripts source this file with `set -a; . ./.env`, so `export KEY=value` is an
		// ordinary assignment the operator made. Reading it as absent would append a second line, and the
		// shell takes the LAST one: the operator's value replaced, with no prompt and a ✓ over it.
		name: "an `export`ed value is a value, and is never clobbered either",
		text: "export WEBHOOK_SECRET=operator-chose-this\n",
		expected: null,
	},
	{
		name: "an `export`ed EMPTY value is still the place the value belongs",
		text: "export WEBHOOK_SECRET=\n",
		expected: "WEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "an empty set line wins over a commented duplicate (the comment stays a comment)",
		text: "# WEBHOOK_SECRET=doc note\nWEBHOOK_SECRET=\n",
		expected: "# WEBHOOK_SECRET=doc note\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "a non-empty set line wins over a later empty one (the key IS set)",
		text: "WEBHOOK_SECRET=real\nWEBHOOK_SECRET=\n",
		expected: null,
	},
	{
		name: "ambiguity resolves to untouched: a value that is only a trailing comment counts as set",
		text: "WEBHOOK_SECRET= # tbd\n",
		expected: null,
	},
	{
		name: "a key that merely prefixes another name does not match it",
		text: "WEBHOOK_SECRET_OLD=x\n",
		expected: "WEBHOOK_SECRET_OLD=x\nWEBHOOK_SECRET=s3cr3t\n",
	},
	{
		name: "CRLF endings survive on the replaced line and everywhere else",
		text: "A=1\r\nWEBHOOK_SECRET=\r\nB=2\r\n",
		expected: "A=1\r\nWEBHOOK_SECRET=s3cr3t\r\nB=2\r\n",
	},
	{
		name: "surrounding comments and blank lines are preserved byte-for-byte",
		text: "# header comment\n\nA=1   \n# trailing note\nWEBHOOK_SECRET=\n\n# footer\n",
		expected: "# header comment\n\nA=1   \n# trailing note\nWEBHOOK_SECRET=s3cr3t\n\n# footer\n",
	},
];

for (const { name, text, expected } of cases) {
	test(`setEnvKeyIfEmpty: ${name}`, () => {
		const result = setEnvKeyIfEmpty(text, "WEBHOOK_SECRET", "s3cr3t");
		if (expected === null) {
			assert.equal(result, text, "unchanged means the INPUT text back, identically");
		} else {
			assert.equal(result, expected);
		}
	});
}

test("setEnvKeyIfEmpty: the unchanged case returns the same string object (identity, not just equality)", () => {
	const text = "WEBHOOK_SECRET=set\n";
	assert.ok(setEnvKeyIfEmpty(text, "WEBHOOK_SECRET", "x") === text);
});

// -- setEnvKey: the consented-overwrite sibling — same line mechanics, opposite value discipline ------
//
// Same table convention: `expected: null` means "byte-identical input back", asserted by identity,
// because the wrapper skips the write on identity exactly as it does for the sibling.

const overwriteCases = [
	{
		name: "an existing set value IS replaced (the whole point of the sibling)",
		text: "A=1\nGITHUB_AUTH_SOURCE=gh\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
	},
	{
		name: "an empty set line is filled in place",
		text: "A=1\nGITHUB_AUTH_SOURCE=\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
	},
	{
		name: "whitespace around = is normalised to the canonical line",
		text: "GITHUB_AUTH_SOURCE = gh\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE=app\n",
	},
	{
		// Same rule as the sibling: a COMMENTED line is kept above the new one, so nothing documented is
		// lost. A SET line is not, and that asymmetry is deliberate on this path -- copying a replaced
		// value up as a comment would leave a fragment of a live credential behind, on the one transform
		// whose docblock warns it will happily replace one.
		// KEPT, because `gh` after the `=` is a value an operator may want back.
		name: "a commented line CARRYING A VALUE is uncommented below itself when no set line exists",
		text: "A=1\n# GITHUB_AUTH_SOURCE=gh\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\n# GITHUB_AUTH_SOURCE=gh\nGITHUB_AUTH_SOURCE=app\nB=2\n",
	},
	{
		name: "a replaced VALUE leaves no fragment of itself behind, not even as a comment",
		text: "GITHUB_APP_PRIVATE_KEY=old-secret   # rotated 2026-01-01\n",
		key: "GITHUB_APP_PRIVATE_KEY",
		expected: "GITHUB_APP_PRIVATE_KEY=app\n",
	},
	{
		name: "no trace of the key appends at the end",
		text: "A=1\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nB=2\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "appending to text without a trailing newline first completes the last line",
		text: "A=1",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "appending to empty text yields just the one line",
		text: "",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "the FIRST set line wins; a later duplicate is left as it was",
		text: "GITHUB_AUTH_SOURCE=gh\nGITHUB_AUTH_SOURCE=pat\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE=app\nGITHUB_AUTH_SOURCE=pat\n",
	},
	{
		name: "a set line wins over a commented duplicate wherever the comment sits (the comment stays a comment)",
		text: "# GITHUB_AUTH_SOURCE=doc note\nGITHUB_AUTH_SOURCE=gh\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "# GITHUB_AUTH_SOURCE=doc note\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "already exactly KEY=value is a no-op (identity)",
		text: "A=1\nGITHUB_AUTH_SOURCE=app\nB=2\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: null,
	},
	{
		name: "a key that merely prefixes another name does not match it",
		text: "GITHUB_AUTH_SOURCE_OLD=x\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "GITHUB_AUTH_SOURCE_OLD=x\nGITHUB_AUTH_SOURCE=app\n",
	},
	{
		name: "CRLF endings survive on the replaced line and everywhere else",
		text: "A=1\r\nGITHUB_AUTH_SOURCE=gh\r\nB=2\r\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "A=1\r\nGITHUB_AUTH_SOURCE=app\r\nB=2\r\n",
	},
	{
		name: "an already-exact line in a CRLF file is still a no-op (the \\r tail is not a difference)",
		text: "GITHUB_AUTH_SOURCE=app\r\nB=2\r\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: null,
	},
	{
		name: "surrounding comments and blank lines are preserved byte-for-byte",
		text: "# header\n\nA=1   \n# note\nGITHUB_AUTH_SOURCE=gh\n\n# footer\n",
		key: "GITHUB_AUTH_SOURCE",
		expected: "# header\n\nA=1   \n# note\nGITHUB_AUTH_SOURCE=app\n\n# footer\n",
	},
];

for (const { name, text, key, expected } of overwriteCases) {
	test(`setEnvKey: ${name}`, () => {
		const result = setEnvKey(text, key, "app");
		if (expected === null) {
			assert.equal(result, text, "unchanged means the INPUT text back, identically");
		} else {
			assert.equal(result, expected);
		}
	});
}

// -- readEnvAssignments: the narrow reader doctor uses, and the only thing here that READS a .env ------
//
// A RECORD per key, not a value: `undefined` means no assignment, `{ value: "" }` means an assignment to
// nothing, and `plain: false` means this file will not say what the value is. The version this replaced
// returned values only, so "no line" and "a line worth nothing" arrived identical and every caller that
// asked "is it set" got the wrong answer on a deployment that refuses to boot (issues #365 and #384).

// The whole record, every time, with the parts a case is not about spelled by this helper rather than left
// out. `plain` is the line's own text, `vouched` adds the rest of the file, and `blank` is the third
// question -- "does this line assign anything at all" -- which `up` asks and which neither of the other two
// answers. A test that asserted only the field it cared about would not have caught the two of them being
// collapsed into one, which is what the review found.
const rec = (o) => ({ value: null, plain: false, vouched: false, blank: false, line: 1, hazardLine: null, ...o });

test("E1: an assignment to nothing is a RECORD, absence is undefined, and the last one wins", () => {
	const text = ["PI_PAUSE_WINDOWS_FILE=/w.json", "WEBHOOK_SECRET=s3cr3t", "# PI_SCOPED_LIMITS_FILE=/commented.json", "PI_LOGS_DIR=", "PI_SETTINGS_FILE=   ", "PI_PAUSE_WINDOWS_FILE=/a-later-duplicate.json"].join("\n");
	const r = readEnvAssignments(text, ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_JOB_IMAGE"]);
	assert.deepEqual(r.PI_PAUSE_WINDOWS_FILE, rec({ value: "/a-later-duplicate.json", plain: true, vouched: true, line: 6 }), "every loader takes the LAST assignment, and the line number is the one an operator has to open");
	assert.equal(r.PI_SCOPED_LIMITS_FILE, undefined, "a commented line is not an assignment");
	assert.equal(r.PI_JOB_IMAGE, undefined, "and neither is a key the file never mentions");
	assert.deepEqual(r.PI_LOGS_DIR, rec({ value: "", plain: true, vouched: true, blank: true, line: 4 }), "`KEY=` is an assignment to nothing, which is NOT absence");
	assert.deepEqual(r.PI_SETTINGS_FILE, rec({ value: "", plain: true, vouched: true, blank: true, line: 5 }), "and so is `KEY=   `, which every loader here trims");
	// The four empty shapes are one value, because `set -a; . ./.env` exports all four as "" and systemd
	// 252 reads all four as "" (measured). This is the distinction the old reader threw away by deleting
	// the key, and the reason doctor could not tell a scaffolded-but-blank deployment from an unset one.
	for (const shape of ['K=', 'K=""', "K=''", "K=   "]) assert.deepEqual(readEnvAssignments(shape, ["K"]).K, rec({ value: "", plain: true, vouched: true, blank: true }), shape);
	// CONCATENATED empty pairs are empty too, measured on systemd 252 and in all four shells -- and they sit
	// OUTSIDE the grammar `plain` claims, which is why `blank` is its own question. Tying the refusal to
	// `vouched` let `K=""''` exit 0 on a deployment that cannot start.
	for (const shape of ["K=\"\"''", "K=''\"\"", "K=\"\"''\"\""]) {
		const r = readEnvAssignments(shape, ["K"]).K;
		assert.equal(r.blank, true, `${shape}: assigns nothing`);
		assert.equal(r.plain, false, `${shape}: and is still outside the grammar this file will repeat back`);
	}
	assert.deepEqual(readEnvAssignments(text, []), {}, "an empty ask reads nothing at all");
	assert.deepEqual(readEnvAssignments("", ["PI_LOGS_DIR"]), {});
	assert.deepEqual(readEnvAssignments(undefined, ["PI_LOGS_DIR"]), {});
});

test("E1: an export line belongs to the loader that reads one, and never to the one that does not", () => {
	// The hybrid this replaced was wrong in the direction that matters. Letting an export line CANCEL a
	// plain one made `KEY=/systemd.json` followed by `export KEY=/wrapper.json` look like a key systemd
	// does not honour, and the advice that follows -- drop the prefix -- would have changed which file the
	// worker loads. systemd's `EnvironmentFile=` grammar is bare `VAR=VALUE`, and an export line is not an
	// assignment there at all: the journal says `Ignoring invalid environment assignment` (measured, 252).
	const both = "PI_PAUSE_WINDOWS_FILE=/systemd.json\nexport PI_PAUSE_WINDOWS_FILE=/wrapper.json";
	assert.equal(readEnvAssignments(both, ["PI_PAUSE_WINDOWS_FILE"]).PI_PAUSE_WINDOWS_FILE.value, "/systemd.json", "what EnvironmentFile= sees");
	assert.equal(readEnvAssignments(both, ["PI_PAUSE_WINDOWS_FILE"], { loader: "shell" }).PI_PAUSE_WINDOWS_FILE.value, "/wrapper.json", "what `set -a; . ./.env` sees");
	const cleared = "PI_PAUSE_WINDOWS_FILE=/a.json\nexport PI_PAUSE_WINDOWS_FILE=";
	assert.deepEqual(readEnvAssignments(cleared, ["PI_PAUSE_WINDOWS_FILE"]).PI_PAUSE_WINDOWS_FILE, rec({ value: "/a.json", plain: true, vouched: true }), "systemd never saw the export line, so nothing cancelled");
	assert.deepEqual(readEnvAssignments(cleared, ["PI_PAUSE_WINDOWS_FILE"], { loader: "shell" }).PI_PAUSE_WINDOWS_FILE, rec({ value: "", plain: true, vouched: true, blank: true, line: 2 }), "the wrapper did, and it is an assignment to nothing");
	// `export K=` alone is a line the shells honour and systemd does not, so the two loaders disagree about
	// whether the key is assigned AT ALL -- which is the whole reason a reading is only meaningful beside
	// the loader that produced it.
	assert.equal(readEnvAssignments("export K=", ["K"]).K, undefined, "systemd: no assignment");
	assert.deepEqual(readEnvAssignments("export K=", ["K"], { loader: "shell" }).K, rec({ value: "", plain: true, vouched: true, blank: true }), "the wrapper: an assignment to nothing");
});

// The corpus. Every entry is a whole .env TEXT that mentions `K`, and E2 reads each one with a real shell.
// It is deliberately longer than the shapes the grammar accepts: a corpus of only plain shapes proves the
// reader right about the cases it already knows, and the holes this found were all in the other half.
const ORACLE_CORPUS = [
	// The empty shapes, and the ordinary ones.
	"K=",
	'K=""',
	"K=''",
	"K=   ",
	"K=/srv/a.json",
	"K=/srv/a.json   ",
	"K=/srv/a.json\t",
	"K=30",
	"K=v1.0.0-rc.1",
	"K=user@host:/path",
	"K=a,b:c+d_e-f./g",
	"K=_underscored",
	// Quoting.
	"K='/srv/a b.json'",
	'K="/srv/ab.json"',
	'K="/srv/a b.json"',
	"K='   '",
	"K='/srv/x # y'",
	'K="/srv/x # y"',
	"K='caf\u00e9/x'",
	"K='/srv/\u65e5\u672c\u8a9e/x'",
	"K='/srv/a\tb/c.json'",
	"K='a\"b'",
	'K="a\'b"',
	'K="a$b"',
	'K="a\\b"',
	'K="a`b`"',
	"K='$HOME/x'",
	// Quoting that is not quoting.
	'K="unclosed',
	"K='unclosed",
	'K="a"b',
	'K=a"b"c',
	'K="a" "b"',
	"K='a'b'",
	'K="a" # "b"',
	"K='/a.json' # it's fine",
	'K="/a.json" # see "notes"',
	// Comments, which the shells honour and systemd keeps in the value.
	"K=/srv/a.json   # note",
	"K=/srv/a.json\t# tab note",
	"K=30        # turns",
	"K=/srv/a#b.json",
	"K=value#",
	"K=#",
	// Whitespace and word splitting.
	"K=/srv/a b.json",
	"K=  leading",
	"K =/a.json",
	"K= ",
	// Expansion, in one shell or another.
	"K=$HOME/x",
	"K=~/x",
	"K==ls",
	"K=a:=b",
	// TWO LINES, because the single-line shapes above are not vouched for and so are never compared: the
	// hole is a line whose sourcing ZSH ABANDONS sitting ABOVE a key the reader does vouch for (issue #396).
	// Measured on this host: sh, bash and dash all give `/good.json`; in zsh the `.` returns 126 at line 1
	// and K is never set, so the child gets nothing.
	"K2=a:=b\nK=/good.json\n",
	"K2==x\nK=/good.json\n",
	"K=$(echo hi)",
	"K=`echo hi`",
	"K=${HOME}",
	"K=*",
	"K=a?b",
	// Backslashes.
	"K=a\\b",
	"K=C:\\pi\\x",
	"K=trailing\\",
	// Operators.
	"K=a;b",
	"K=a|b",
	"K=a&b",
	"K=a>out",
	"K=(a)",
	// Export, duplicates and order.
	"export K=/srv/e.json",
	"export K=",
	"export   K=/srv/spaced.json",
	"K=/srv/a.json\nexport K=/srv/b.json",
	"export K=/srv/b.json\nK=/srv/a.json",
	"K=/srv/a.json\nK=",
	"K=\nK=/srv/a.json",
	"K=/srv/a.json\nOTHER=b",
	// Values that END the sourcing shell, so that nothing below them is ever read: `${x?err}` and a
	// substitution that kills the shell both abort `set -a; . ./.env` before the wrapper launches anything.
	"OTHER=${NOPE?boom}\nK=/srv/a.json",
	"OTHER=${NOPE:?boom}\nK=/srv/a.json",
	"OTHER=$(echo hi)\nK=/srv/a.json",
	"K=$HOME\nOTHER=1",
	// Assignment forms the shells take and this reader does not, which must therefore not be vouched past.
	"K+=/srv/a.json",
	"declare K=/srv/a.json",
	"export export K=/srv/a.json",
	// A BOM anywhere, not only on the first line.
	"OTHER=1\n\ufeffK=/srv/a.json",
	"\ufeffOTHER=1\nK=/srv/a.json",
	// A CR or a line separator INSIDE the value, where JavaScript's `.` stops matching and the key stopped
	// having a record at all.
	"K=/srv/a\rb.json",
	"K='/srv/a\u2028b.json'",
	// Lines that reach past themselves, above and below.
	"OTHER=\"unclosed\nK=/srv/a.json",
	"OTHER=a\\\nK=/srv/a.json",
	"OTHER='a'b'\nK=/srv/a.json",
	"K=/srv/a.json\nunset K",
	"K=/srv/a.json\nOTHER=\"unclosed",
	"if false; then\nK=/srv/a.json\nfi",
	"unset K\nK=/srv/a.json",
	"echo hi\nK=/srv/a.json",
	// Bytes JavaScript's `\s` would trim and no shell does, LEADING and TRAILING. The trailing half was
	// missing, and its absence let a `/\s+$/` in the value trimmer survive the whole suite: with it, a
	// value ending in a form feed reads as though the form feed were not there, and `K=<FF>` reads as an
	// EMPTY value, which is a hard doctor failure on a deployment that starts.
	"K=\u00a0/srv/a.json",
	"K=\u000b/srv/a.json",
	"K=\u000c/srv/a.json",
	"K=/srv/a.json\u00a0",
	"K=/srv/a.json\u000b",
	"K=/srv/a.json\u000c",
	"K=\u000c",
	"K=\u00a0",
	// The same bytes BEFORE the key, where `^[ \t]*` must not become `^\s*`: a line starting with a NBSP or
	// a vertical tab is a COMMAND to every shell, not an assignment, and a reader that skipped it as
	// whitespace would vouch for a key none of them sets.
	"\u00a0K=/srv/a.json",
	"\u000bK=/srv/a.json",
	"\u000cK=/srv/a.json",
	"export\u00a0K=/srv/a.json",
	"K=/srv/a.json\r",
	"\ufeffK=/srv/a.json",
	// Not this key at all.
	"KK=/other.json",
	"# K=/commented.json",
	"#K=/commented.json",
	"\n\n# a note\n\nK=/srv/a.json\n",
];

test("E2: a plain reading is what a real shell hands the child, measured over the whole corpus", () => {
	// THE ORACLE. The grammar's promise is "every loader of this file reads this line the same way", and the
	// only honest way to hold that promise is to run the loaders. systemd was measured separately (252, in a
	// privileged container, recorded at the grammar); this half runs the shells that
	// `deploy/worker-env-wrapper.sh` and the launchd wrapper actually use.
	//
	// `printenv K` in a CHILD, never `${K-UNSET}`: under `set +a` a shell variable exists without being
	// exported, so asking the same shell would pass on a file the service reads as unset. zsh is not a
	// service loader for this project and is asserted anyway, because a disagreement there means the grammar
	// is wider than it claims rather than that zsh is wrong.
	const dir = tempDir("pi-dispatch-env-oracle-");
	const file = join(dir, "probe.env");
	const shells = ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh", "/usr/bin/zsh"].filter((sh) => existsSync(sh));
	assert.ok(shells.length >= 2, `the oracle needs real shells to be an oracle, found ${shells.join(", ") || "none"}`);
	// The shapes whose sourcing zsh abandons, named so the exemption is a list a reader can audit rather than
	// a condition buried in the loop. A SAMPLE of a wider family, deliberately: `K2=x:=y:=z`, `K2=:=b`,
	// `K2=a:~b` and `K2=~x` behave identically and are not carried, because two is enough to hold the rule
	// and every extra one costs a shell spawn per run.
	const ZSH_ABORTS_SOURCING = new Set(["K2=a:=b\nK=/good.json\n", "K2==x\nK=/good.json\n"]);
	assert.ok(ORACLE_CORPUS.length >= 100, `corpus is ${ORACLE_CORPUS.length} shapes, and a floor well under the real count lets the corpus erode without a test noticing`);
	// UNIQUE, because a repeated shape looks like coverage and is not -- and one slipped in, a BOM-on-line-2
	// entry added twice, which the vouched-shape floor then counted twice as well.
	assert.equal(new Set(ORACLE_CORPUS).size, ORACLE_CORPUS.length, "a repeated shape is not a second shape");
	const childValue = (sh) => {
		const r = spawnSync(sh, ["-c", `set -a; . ${JSON.stringify(file)} >/dev/null 2>&1; printenv K`], { cwd: dir, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
		assert.equal(r.error, undefined, `${sh} did not run`);
		// A non-zero exit is `printenv` saying the child never got K, or the sourcing itself refusing the
		// file (dash exits 2 on an unclosed quote). Both mean the same thing here: no value to compare.
		return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
	};
	let compared = 0;
	let vouchedShapes = 0;
	for (const text of ORACLE_CORPUS) {
		writeFileSync(file, text);
		const reading = readEnvAssignments(text, ["K"], { loader: "shell" });
		if (reading.K !== undefined && reading.K.vouched) vouchedShapes += 1;
		for (const sh of shells) {
			const got = childValue(sh);
			// `vouched`, not `plain`, and the difference is the whole point of there being two: `plain` is
			// this LINE's own text, which a shell cannot confirm in isolation, and `vouched` is the claim
			// doctor actually prints -- "the loader ends up with this". Comparing the weaker one made the
			// oracle demand that `K=/a.json` above an `unset K` still reach the child.
			if (reading.K === undefined || !reading.K.vouched) continue;
			// ZSH IS CHECKED BUT NOT PROMISED, and these shapes are where that distinction is spent (issue
			// #396). MEASURED, because a first version of this comment got the mechanism wrong: zsh does NOT
			// exit. It reads `a:=b` as a command to find, fails to find it, and its `.` builtin ABORTS THE
			// SOURCING at that line with 126 -- the shell carries on happily, and every key BELOW the line is
			// simply never set, while sh, bash and dash read the file through. The null below is `printenv`
			// reporting no K, which is what `childValue` turns any non-zero status into, as its own comment
			// above says.
			//
			// The grammar is the intersection of what the SERVICE LOADERS read the same way, and zsh is none
			// of them: the wrapper has a `#!/bin/sh` shebang and the launchd wrapper runs `/bin/sh`. Refusing
			// the shapes outright was rejected in the reader's own docblock -- it would warn about a line
			// every loader this project deploys reads correctly. So the exemption is NAMED, per shape, rather
			// than zsh being quietly dropped from the oracle. The two here are a SAMPLE of a wider family,
			// not its boundary.
			if (ZSH_ABORTS_SOURCING.has(text) && /zsh$/.test(sh)) {
				assert.equal(got, null, `${sh} on ${JSON.stringify(text)}: exempt because zsh's \`.\` aborts the sourcing here, so the key below is never set; if that stopped happening the exemption is the thing that is now wrong`);
				continue;
			}
			compared += 1;
			assert.equal(got, reading.K.value, `${sh} on ${JSON.stringify(text)}`);
		}
	}
	// Not vacuous: a grammar that vouched for nothing would pass every assertion above. Counted in SHAPES
	// rather than in comparisons, because the comparison count scales with how many shells a host happens to
	// have -- a floor in comparisons passes on a four-shell mac and fails on a CI runner with three, which
	// is a test that depends on the machine instead of on the code.
	assert.ok(vouchedShapes >= 36, `only ${vouchedShapes} of ${ORACLE_CORPUS.length} shapes were vouched for, so this oracle is checking almost nothing`);
	const zshCount = shells.filter((sh) => /zsh$/.test(sh)).length;
	assert.equal(compared, vouchedShapes * shells.length - ZSH_ABORTS_SOURCING.size * zshCount, "every vouched shape is checked against every shell that exists here, less the named zsh exemptions");
});

test("E3: what the file says and what systemd says are two different sentences", () => {
	// systemd 252, measured in a privileged container with `EnvironmentFile=` and a unit that dumps `env`.
	// The left column is what systemd gives the service; the right is why the reader still refuses to
	// vouch for the line. A reading is `plain` only where EVERY loader agrees, so systemd being unambiguous
	// is not enough on its own.
	const table = [
		// line                    systemd 252 gives      why it is not plain
		["K=/srv/a.json   # note", "/srv/a.json   # note", "the shells stop at the comment"],
		["K=30        # turns", "30        # turns", "issue #392: the scaffold shipped this shape on five keys"],
		["K=/srv/a b.json", "/srv/a b.json", "the shells split the value and RUN the second word"],
		["K=$HOME/x", "$HOME/x", "the shells expand it"],
		["K=~/x", "~/x", "the shells expand it"],
		["K=a\"b\"c", 'a"b"c', "the shells concatenate to abc"],
		["K=  leading", "leading", "the shells leave K unset"],
		["K=C:\\pi\\x", "C:pix", "a backslash is an escape to both, and a literal to the cmd wrapper"],
		["K=a\"b", 'a"b', "an unbalanced quote reaches into the next line in the shells"],
	];
	for (const [line, , why] of table) {
		const r = readEnvAssignments(line, ["K"]);
		assert.equal(r.K.plain, false, `${line}: ${why}`);
		assert.equal(r.K.value, null, "and a reading that is not plain carries no value to print");
		assert.equal(r.K.line, 1, "the line number is still reported, because that is what the warning names");
	}
	// The measured systemd column is not asserted here, because nothing in this suite runs systemd. It is
	// recorded so the next reader of this file can see WHY these rows are refused rather than guess.
	assert.equal(table.length, 9);
	// `'a'b'` is the shape that killed the first poison rule: the first quote closes, the THIRD opens, and
	// every shell swallows the following line. systemd 252 reads it as `ab'` and carries on, so the two
	// disagree about the line BELOW it as well.
	// BELOW an unbalanced quote the line is not a line at all -- every shell swallows it into the open
	// quote -- so its own reading goes too. ABOVE a stray command the line is exactly what it looks like;
	// what cannot be claimed is where the loader ENDS UP, which is the vouch. Two flags because doctor asks
	// the first question ("is this key empty?") and prints the second.
	// The key's own LINE is exactly what it looks like; what cannot be claimed is where the loader ends up,
	// because the line above it does not close its quote. One flag for the line, one for the file.
	// PER LOADER, because they do different things with the same two lines. `OTHER='a'b'` leaves a quote open
	// for every shell, so the line below is part of that value and is not a line at all; systemd 252 reads
	// `ab'` and then reads the next line as an ordinary assignment (measured on the rig).
	const belowShell = readEnvAssignments("OTHER='a'b'\nK=/srv/a.json", ["K"], { loader: "shell" }).K;
	assert.equal(belowShell.plain, false, "to a sourcing shell this is not a line, it is more of the value above");
	assert.equal(belowShell.hazardLine, 1, "and the line an operator has to open is the one that opened the quote");
	const belowSystemd = readEnvAssignments("OTHER='a'b'\nK=/srv/a.json", ["K"]).K;
	assert.equal(belowSystemd.plain, true, "systemd does not continue a quote across lines, so this IS a line");
	assert.equal(belowSystemd.vouched, true, "and nothing in this file reaches past itself for that loader");
	const above = readEnvAssignments("K=/srv/a.json\nunset K", ["K"], { loader: "shell" }).K;
	assert.equal(above.plain, true, "the line itself is in the form every loader reads the same way");
	assert.equal(above.vouched, false, "but systemd ignores the line below and the shells run it, so where the key ENDS UP is not claimed");
	assert.equal(above.hazardLine, 2, "and the line an operator has to fix is the stray one, not this key's");
});

test("E3b: a value this file cannot SHOW is not plain either, and the renderer is why", () => {
	// `plain` has two conditions, and this is the second one. A quoted ESC, a C1 byte, a bidi override or a
	// line separator is read IDENTICALLY by systemd and by all four shells, so loader agreement alone would
	// vouch for it -- and doctor prints `value` in three places, so vouching for it puts a terminal-rewriting
	// byte in front of an operator. Narrowing this exclusion to NUL alone leaves the whole suite green while
	// a raw ESC reaches the output, which is how it was found.
	for (const [name, line] of [
		["ESC", "K='/a\u001b[31mb'"],
		["C1 CSI", "K='/a\u009bb'"],
		["bidi override", "K='/a\u202enosj.txt'"],
		["zero width", "K='/a\u200bb'"],
		["line separator", "K='/a\u2028b'"],
		["NUL", "K='/a\u0000b'"],
	]) {
		assert.equal(readEnvAssignments(line, ["K"]).K.plain, false, name);
	}
	// And the two that are NOT control bytes, which must stay plain: escaping an accented or CJK home would
	// make the commonest non-ASCII path unreadable in the very line telling its owner what to fix.
	assert.equal(readEnvAssignments("K='/Users/jos\u00e9/x.json'", ["K"]).K.plain, true, "an accented path is ordinary");
	assert.equal(readEnvAssignments("K='/srv/\u65e5\u672c\u8a9e/x.json'", ["K"]).K.plain, true, "and so is a CJK one");
	assert.equal(readEnvAssignments("K='/a\tb'", ["K"]).K.plain, true, "and a TAB, measured identical on systemd 252 and all four shells");
});

test("E3c: envValueShown escapes what a terminal would obey, and nothing else", () => {
	// The file half is guarded by the grammar; this exists for the SHELL half, where doctor prints a value
	// no grammar constrains. An environment variable holding a raw ESC reached the terminal through that
	// branch while the file branch was carefully withholding it.
	assert.equal(envValueShown("/srv/a.json"), "/srv/a.json");
	assert.equal(envValueShown("/Users/jos\u00e9/x"), "/Users/jos\u00e9/x", "an accented path is shown as itself");
	assert.equal(envValueShown("/srv/\u65e5\u672c/x"), "/srv/\u65e5\u672c/x");
	assert.equal(envValueShown("/a\u001b[31mb"), String.raw`"/a\u001b[31mb"`, "an escape sequence is quoted and escaped whole");
	assert.equal(envValueShown("/a\u202enosj.txt"), String.raw`"/a\u202enosj.txt"`, "and so is a right-to-left override");
	assert.match(envValueShown("/a\u0000b"), /^"/, "a quoted value is always quoted, so the quotes say it was transformed");
	// A LINE FEED ON ITS OWN, because that is the one a review found still open twice: the class was written
	// `\x00-\x08\x0b-\x1f`, which steps over `\x0a`, and every test that should have caught it happened to
	// put an ESC in the same string. An unescaped newline in a value doctor prints lets an environment
	// variable FORGE doctor's own output, ✓ lines for the other boot key included.
	assert.equal(envValueShown("a\nb"), String.raw`"a\nb"`, "a newline alone is escaped, with no other control byte to carry it");
	assert.equal(envValueShown("/srv/a.json\n✓ everything is fine").includes("\n"), false, "so no value can add a line to the report");
	for (const v of ["/a\u001bb", "/a\u009bb", "/a\u200bb", "/a\u2028b", "/a\u0085b"]) {
		assert.doesNotMatch(envValueShown(v), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, `no control byte survives: ${JSON.stringify(v)}`);
	}
});

test("E7: a line this reader cannot model is a HAZARD, never a key that is simply absent", () => {
	// The trap this closes: no record and no assignment arrived identical, and doctor printed the second for
	// the first -- "PI_X is unset, the worker ignores it" about files that DO set the key. Every shape below
	// leaves this reader with nothing for K, and every one of them is a file whose loaders may disagree.
	for (const [name, text, line] of [
		["a BOM on a line of its own", "OTHER=1\n\ufeffK=/a.json", 2],
		["a BOM on the first line", "\ufeffK=/a.json", 1],
		["an append assignment", "K+=/a.json", 1],
		["a declare", "declare K=/a.json", 1],
		["a value that ENDS the shell", "OTHER=${NOPE?boom}\nK=/a.json", 1],
		["a substitution", "OTHER=$(echo hi)\nK=/a.json", 1],
		["a backtick", "OTHER=`echo hi`\nK=/a.json", 1],
		["a command", "echo hi\nK=/a.json", 1],
		["a space before the =", "K =/a.json", 1],
		["an unclosed quote", "OTHER='x\nK=/a.json", 1],
		["a heredoc", "cat <<EOF\nK=/a.json\nEOF", 1],
		["an unset below", "K=/a.json\nunset K", 2],
		["a # that is not a comment", "NOTE=#it's\nK=/a.json", 1],
		["an escaped space before a #", "NOTE=a\\ #'\nK=/a.json", 1],
	]) {
		const h = envFileHazard(text, { loader: "shell" });
		assert.notEqual(h, null, `${name}: this file is not one this command can read, and nothing said so`);
		assert.equal(h.line, line, `${name}: the line an operator has to open`);
	}
	// A CONTINUATION THAT IS CONSUMED is not a hazard, it is an absence: `OTHER=x\` swallows the line below
	// it in systemd 252 AND in all four shells, so both loaders agree the key is never assigned. There is
	// nothing to warn about and nothing to claim -- doctor says the key is unset, which is true.
	const eaten = readEnvAssignments("OTHER=x\\\nK=/a.json", ["K"], { loader: "shell" });
	assert.equal(envFileHazard("OTHER=x\\\nK=/a.json", { loader: "shell" }), null, "the loaders agree, so nothing is unreadable");
	assert.equal(eaten.K.plain, false, "and the key's line is not a line: it is the tail of the value above it");
	// A continuation on the LAST line is different: the file ends mid-value, which both loaders notice.
	assert.deepEqual(envFileHazard("K=/a.json\nOTHER=x\\", { loader: "shell" }), { line: 2 }, "a file that ends inside a continuation");

	// ORDINARY LINES STAY ORDINARY, which is the half a blanket rule got wrong: an expansion that can only
	// substitute affects its own value and nothing else, and treating it as a file-wide hazard hid an EMPTY
	// boot key two lines below it.
	for (const [name, text] of [
		["a plain expansion", "PI_LOGS_DIR=$HOME/logs\nK=/a.json"],
		["a braced expansion", "PI_LOGS_DIR=${HOME}/logs\nK=/a.json"],
		["a default expansion", "PI_LOGS_DIR=${HOME:-/tmp}/logs\nK=/a.json"],
		["a trailing comment carrying an apostrophe", "OTHER=/a.json # it's fine\nK=/a.json"],
		["a quoted hash", "OTHER='#not a comment'\nK=/a.json"],
	]) {
		assert.equal(envFileHazard(text, { loader: "shell" }), null, `${name}: reaches past nothing`);
	}
	// systemd 252 accepts `K =/a.json` and sets the key, measured on the rig -- so the hazard here is the
	// SHELLS, which run a command named `K`. The two ends of the file disagree about whether the key is
	// assigned at all, which is exactly what "hazard" means in this reader.
	assert.equal(envFileHazard("K=/a.json\nOTHER=b"), null, "a file of ordinary assignments reaches past nothing");
	assert.equal(envFileHazard("# a note\n\nK=/a.json\n"), null, "and comments and blank lines are not hazards");
	// The cmd wrapper has no hazards at all: `for /f` takes one line at a time, with no quoting, no
	// continuation and no execution, so no line there can reach another.
	assert.equal(envFileHazard("unset K\nOTHER='open", { loader: "cmd" }), null, "no continuation, no multi-line value, no execution");
	// ONE EXCEPTION, and the module already knew it: `set "%%A=%%B"` is itself quoted, so a `"` in any value
	// closes it and the rest of the line becomes command. `renderEnvValue` refuses to WRITE that character
	// for exactly this reason.
	assert.deepEqual(envFileHazard('OTHER=x" & set "K=evil\nK=C:/ok.json', { loader: "cmd" }), { line: 1 }, "a double quote breaks out of the wrapper's own quoting");
});

test("E8: a CR or a line separator inside a value is a value, not an absence", () => {
	// JavaScript's `.` excludes CR, U+2028 and U+2029, so a value carrying one matched NOTHING and the key
	// had no record -- while systemd 252 sets it to the text before the CR and all four shells set it whole.
	// Doctor then called that key unset, on a deployment whose worker refuses to start.
	const cr = readEnvAssignments("K=/srv/a\rb.json", ["K"]);
	assert.notEqual(cr.K, undefined, "the line assigns the key, whatever is in it");
	assert.equal(cr.K.plain, false, "and the loaders disagree about what, so nothing is claimed");
	assert.equal(cr.K.value, null);
	const ls = readEnvAssignments("K='/srv/a\u2028b.json'", ["K"]);
	assert.notEqual(ls.K, undefined);
	assert.equal(ls.K.plain, false, "a line separator is in the control class, so it is not shown either");
});

test("E4: everything the writer writes, the reader reads back exactly", () => {
	// The round trip is the one promise `up` depends on: it writes a path with `renderEnvValue` and doctor
	// reads the same line back. A grammar that refused what the writer produces would warn an operator
	// about a line pi-dispatch wrote itself, which is what a printable-ASCII-only single-quote rule did to
	// the first draft on any home directory with an accent in it.
	const values = ["/srv/pi/pause-windows.json", "/srv/a b/c.json", "/srv/a #2/c.json", "/x$HOME/y", "C:\\pi\\deploy\\logs", "/Users/jos\u00e9/pause-windows.json", "/srv/\u65e5\u672c\u8a9e/x.json", "/srv/a\tb/c.json", "C:/pi/100%/logs", "/srv/tilde~/x.json"];
	for (const v of values) {
		const line = `K=${renderEnvValue(v, { platform: "linux" })}`;
		for (const loader of ["systemd", "shell"]) {
			const r = readEnvAssignments(line, ["K"], { loader });
			assert.equal(r.K.plain, true, `${loader} refuses to vouch for a line up itself writes: ${line}`);
			assert.equal(r.K.value, v, line);
		}
	}
	// And the Windows half, whose writer quotes nothing and whose loader takes the line verbatim.
	for (const v of ["C:/pi/deploy/logs", "C:/Program Files/pi/logs", "C:\\Users\\Bob Smith\\deploy", "C:/pi/a#b/logs"]) {
		const line = `K=${renderEnvValue(v, { platform: "win32" })}`;
		assert.deepEqual(readEnvAssignments(line, ["K"], { loader: "cmd" }).K, rec({ value: v, plain: true, vouched: true }), line);
	}
});

test("E5: envKeyIsBlank is derived from the reader, so it cannot disagree with it", () => {
	// ONE HELPER, because `up` and doctor answered this separately and disagreed (issue #365): doctor said
	// "unset, so the worker ignores it" about a file that makes the worker refuse to start, while `up`,
	// reading the same file, said the value is empty.
	for (const text of ["K=", 'K=""', "K=''", "K=   ", "A=1\nK=\nB=2"]) assert.equal(envKeyIsBlank(text, "K"), true, text);
	for (const text of ["K=/srv/a.json", "K=/srv/a.json\nK=/srv/b.json", "", "A=1", "# K=", "K=/a.json # note"]) assert.equal(envKeyIsBlank(text, "K"), false, text);
	// HALF SET: bare-empty for systemd, a real path for a sourcing shell. Calling that blank would tell half
	// the operators their configured key is empty; calling it set would hide a service that refuses to boot.
	// It is neither, and doctor says which loader sees what instead of collapsing it to one word.
	assert.equal(envKeyIsBlank("K=\nexport K=/w.json", "K"), false, "one loader sees a path, so the file is not blank for every loader");
	// `export K=` alone: the wrapper sets K to "" and systemd never sees the line, so every loader that can
	// see this key sees nothing in it. Blank, and `up` fills the export line in place -- which is the one
	// shape where filling it leaves a systemd deployment still without the key, because systemd ignores an
	// export line before and after the edit. That is the WRITER's rule, pinned at `setEnvKeyIfEmpty`.
	assert.equal(envKeyIsBlank("export K=", "K"), true, "a loader that cannot see the key does not vote, and the one that can sees nothing in it");
	// `K= # tbd` is NOT blank, and calling it blank was measured wrong: `#` is a comment to the shells and
	// ORDINARY TEXT to systemd 252, which hands the service ` # tbd`. So the line assigns nothing to one
	// loader and a five-character value to another, which is a disagreement rather than an empty value --
	// and a hard "REFUSES TO START" about it would be false on the linux half of the deployments.
	assert.equal(envKeyIsBlank("K= # tbd", "K"), false, "no loader of this file treats a trailing # as a comment, so this is not an empty value");
	assert.equal(envKeyIsBlank('K=""#c', "K"), false, "and neither is this: every loader reads the two characters #c");
	assert.equal(envKeyIsBlank('K=""\u0027\u0027', "K"), true, "while repeated empty pairs really are nothing, in all five loaders");
	assert.equal(envKeyIsBlank('K=""\nunset FOO', "K"), true, "one stray line elsewhere does not turn an empty value into a set one");
	assert.equal(envKeyIsBlank('K=""\r\n', "K"), true, "and neither does a Windows line ending");
	assert.equal(envKeyIsBlank('K="" x', "K"), false, "while a value that is not empty is never called empty");
});

test("E6: the cmd wrapper is a third loader, and it is read from its own source", () => {
	// `for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"`. It splits on the FIRST
	// `=` and takes the rest of the line verbatim: no quoting, no comment, no expansion, no continuation.
	// Read from `deploy/worker-env-wrapper.cmd`, not run on Windows, and that limit is why the readings
	// below are asserted against the wrapper's grammar rather than against a measurement.
	const cmd = (text, key = "K") => readEnvAssignments(text, [key], { loader: "cmd" }).K;
	assert.deepEqual(cmd("K=/srv/a.json"), rec({ value: "/srv/a.json", plain: true, vouched: true }));
	// The quotes are part of what `for /f` hands `set` -- which is why `renderEnvValue` writes none for
	// win32 -- but they are NOT safe: the wrapper's `set "%%A=%%B"` is itself quoted, so a `"` in any value
	// closes it and the rest of the line becomes command. The reading stands and the VOUCH does not, which
	// is the same distinction the POSIX side draws, and it is the one the writer already enforced by
	// refusing to emit the character at all.
	assert.deepEqual(cmd('K="/srv/a.json"'), rec({ value: '"/srv/a.json"', plain: true, vouched: false, hazardLine: 1 }), "a double quote breaks out of the wrapper's quoted `set`");
	assert.deepEqual(cmd("K=C:/srv/a.json"), rec({ value: "C:/srv/a.json", plain: true, vouched: true }), "while an ordinary Windows path is vouched for");
	assert.deepEqual(cmd("K=/srv/a.json   # note"), rec({ value: "/srv/a.json   # note", plain: true, vouched: true }), "`eol=#` skips a line that STARTS with one, and does nothing to a trailing comment");
	assert.deepEqual(cmd("K=C:\\pi\\x"), rec({ value: "C:\\pi\\x", plain: true, vouched: true }), "a backslash is a literal there and an escape everywhere else");
	assert.deepEqual(cmd("K=/a.json\nK=/b.json"), rec({ value: "/b.json", plain: true, vouched: true, line: 2 }), "the last `set` wins, as everywhere else");
	assert.equal(cmd("export K=/srv/a.json"), undefined, "`delims==` makes the variable NAME `export K`, so this key is never assigned");
	// An empty value UNSETS the variable there (`set \"K=\"`), where the POSIX loaders set it to "". The
	// record still reports the assignment, because a caller asking about cmd needs to know the line exists.
	assert.deepEqual(cmd("K="), rec({ value: "", plain: true, vouched: true }));
	// No line can reach another one: the poison rule is a shell property, and a per-line loader has none.
	assert.deepEqual(cmd("OTHER='unclosed\nK=/srv/a.json"), rec({ value: "/srv/a.json", plain: true, vouched: true, line: 2 }), "an unbalanced quote above costs nothing here");
	assert.deepEqual(cmd("K=/srv/a.json\nunset K"), rec({ value: "/srv/a.json", plain: true, vouched: true }), "and neither does a line that is not an assignment: there is nothing there to run it");
});

test("renderEnvValue writes what both consumers read back, and refuses what neither can", () => {
	// A deployment folder with a space is ordinary on macOS, whose wrapper sources this file: bare, the
	// shell splits the assignment, the key ends up empty, and the tail RUNS as the service account.
	assert.equal(renderEnvValue("/srv/pi/pause-windows.json", { platform: "linux" }), "/srv/pi/pause-windows.json", "an ordinary path is written bare");
	assert.equal(renderEnvValue("/srv/a b/c.json", { platform: "linux" }), "'/srv/a b/c.json'");
	assert.equal(renderEnvValue("/srv/a #2/c.json", { platform: "linux" }), "'/srv/a #2/c.json'");
	// Single quotes and not double: `"/x$HOME/y"` is EXPANDED by the shell, measured in all three.
	assert.equal(renderEnvValue("/x$HOME/y", { platform: "linux" }), "'/x$HOME/y'");
	assert.throws(() => renderEnvValue("/srv/it's/c.json", { platform: "linux" }), /single quote/, "no rendering is read identically by both consumers, so it is refused rather than escaped");
	assert.throws(() => renderEnvValue("/srv/a\nb", { platform: "linux" }), /newline/);
	// The one character every Windows path contains, and the row that forces the question of WHICH
	// consumer reads the quotes. Bare, all three shells eat the backslashes
	// (`C:\\Users\\op\\logs` comes back `C:Usersoplogs`), so it must be quoted for them.
	assert.equal(renderEnvValue("C:\\pi\\deploy\\logs", { platform: "linux" }), "'C:\\pi\\deploy\\logs'");
	// And `%` is cmd's expansion character, so it is outside the bare set too.
	assert.equal(renderEnvValue("C:/pi/100%/logs", { platform: "linux" }), "'C:/pi/100%/logs'");
});

test("renderEnvValue never quotes for the Windows loader, and its bare set is cmd's own", () => {
	// `deploy/worker-env-wrapper.cmd` keeps surrounding quotes as part of the value, so nothing is ever
	// quoted there. Its bare set is DERIVED from that loader rather than borrowed from the POSIX one,
	// which is what an earlier version got wrong: the loader is the QUOTED `set "%%A=%%B"` form, which
	// preserves spaces exactly, so reusing the POSIX predicate refused all four keys on
	// `C:\Program Files\...` and on any home with a space in it, telling the operator to move the
	// deployment because of a space.
	assert.equal(renderEnvValue("C:/pi/deploy/logs", { platform: "win32" }), "C:/pi/deploy/logs");
	assert.equal(renderEnvValue("C:/Program Files/pi/logs", { platform: "win32" }), "C:/Program Files/pi/logs", "a space is fine for cmd's quoted `set`");
	assert.equal(renderEnvValue("C:\\Users\\Bob Smith\\deploy", { platform: "win32" }), "C:\\Users\\Bob Smith\\deploy", "and so is a backslash: only the POSIX shells eat those");
	assert.equal(renderEnvValue("C:/pi/a#b/logs", { platform: "win32" }), "C:/pi/a#b/logs", "cmd's `eol=#` only skips a line that STARTS with one");
	// What cmd genuinely cannot take.
	assert.throws(() => renderEnvValue("C:/pi/100%/logs", { platform: "win32" }), /expansion character/);
	assert.throws(() => renderEnvValue('C:/pi/a"b/logs', { platform: "win32" }), /double quote/);
	assert.throws(() => renderEnvValue("C:/pi/a\nb", { platform: "win32" }), /line break/);
});

test("a value that needs quoting round-trips through the writer and back out of the reader", () => {
	const written = setEnvKeyIfEmpty("# PI_PAUSE_WINDOWS_FILE=   # quiet hours\n", "PI_PAUSE_WINDOWS_FILE", "/srv/a b #2/pause-windows.json");
	assert.equal(written, "# PI_PAUSE_WINDOWS_FILE=   # quiet hours\nPI_PAUSE_WINDOWS_FILE='/srv/a b #2/pause-windows.json'\n");
	assert.deepEqual(readEnvAssignments(written, ["PI_PAUSE_WINDOWS_FILE"]).PI_PAUSE_WINDOWS_FILE, rec({ value: "/srv/a b #2/pause-windows.json", plain: true, vouched: true, line: 2 }));
});

test("setEnvKey: the already-exact case returns the same string object (identity, not just equality)", () => {
	const text = "GITHUB_AUTH_SOURCE=app\n";
	assert.ok(setEnvKey(text, "GITHUB_AUTH_SOURCE", "app") === text);
});

// -- updateEnvFile: the thin fs wrapper — atomicity (tmp + rename) and mode preservation ---------------

// A recording fake fs over one in-memory file. `ops` captures every call in order so tests can assert
// the write is tmp-then-rename and never a direct write to the destination.
function fakeFs(path, text, mode = 0o644) {
	const files = new Map([[path, text]]);
	const ops = [];
	return {
		files,
		ops,
		fs: {
			readFileSync: (p) => {
				ops.push(["read", p]);
				return files.get(p);
			},
			writeFileSync: (p, data) => {
				ops.push(["write", p, data]);
				files.set(p, data);
			},
			renameSync: (from, to) => {
				ops.push(["rename", from, to]);
				files.set(to, files.get(from));
				files.delete(from);
			},
			statSync: (p) => {
				ops.push(["stat", p]);
				return { mode: 0o100000 | mode };
			},
			chmodSync: (p, m) => {
				ops.push(["chmod", p, m]);
			},
		},
	};
}

test("updateEnvFile: writes the tmp file first, then renames it over the destination", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n");
	const result = updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	assert.deepEqual(result, { changed: true });
	assert.equal(files.get("/deploy/.env"), "WEBHOOK_SECRET=abc123\n");
	const writes = ops.filter(([op]) => op === "write");
	assert.deepEqual(writes, [["write", "/deploy/.env.tmp", "WEBHOOK_SECRET=abc123\n"]], "content lands on the tmp path only");
	assert.ok(
		ops.findIndex(([op]) => op === "write") < ops.findIndex(([op]) => op === "rename"),
		"rename happens after the write",
	);
	assert.deepEqual(ops.at(-1), ["rename", "/deploy/.env.tmp", "/deploy/.env"]);
});

test("updateEnvFile: an already-set key writes NOTHING — no tmp, no rename, no mtime churn", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=keep-me\n");
	const result = updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	assert.deepEqual(result, { changed: false });
	assert.equal(files.get("/deploy/.env"), "WEBHOOK_SECRET=keep-me\n");
	assert.deepEqual(ops, [["read", "/deploy/.env"]], "the file is read once and never touched");
});

test("updateEnvFile: a 0600 .env stays 0600 — chmod on the tmp BEFORE the rename", () => {
	const { fs, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n", 0o600);
	updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	const chmodIdx = ops.findIndex(([op]) => op === "chmod");
	assert.notEqual(chmodIdx, -1, "the tmp is chmodded");
	assert.deepEqual(ops[chmodIdx], ["chmod", "/deploy/.env.tmp", 0o600]);
	assert.ok(chmodIdx < ops.findIndex(([op]) => op === "rename"), "no window where the renamed file is wider than 0600");
});

test("updateEnvFile: EVERY mode is carried onto the tmp, not just 0600", () => {
	// A rename from a fresh tmp lands at the process umask, so a 0640 or 0400 `.env` came back 0644 --
	// world-readable, on the one file this project says must never reach a scrollback. `up` now performs
	// this five times a run rather than once, which is what turned a latent widening into a real one.
	for (const mode of [0o600, 0o640, 0o400, 0o660]) {
		const { fs, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n", mode);
		updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
		const chmodIdx = ops.findIndex(([op]) => op === "chmod");
		assert.deepEqual(ops[chmodIdx], ["chmod", "/deploy/.env.tmp", mode], `mode ${mode.toString(8)}`);
		assert.ok(chmodIdx < ops.findIndex(([op]) => op === "rename"), "and before the rename, so no window is wider");
	}
});

test("updateEnvFile: a file this process does not own is refused, not rewritten under its owner", () => {
	// `renameSync` makes a new inode owned by whoever runs this, so a root- or `pi`-owned `.env` at 0640
	// that the service reads through its group comes back owned by the operator: the service account loses
	// read access, and `deploy/worker.service` uses a bare `EnvironmentFile=` (fatal, not `-`), so the unit
	// stops starting. Widening the mode to compensate would publish a file holding WEBHOOK_SECRET.
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n", 0o640);
	fs.statSync = (p) => {
		ops.push(["stat", p]);
		return { mode: 0o100640, uid: (process.getuid?.() ?? 0) + 1 };
	};
	assert.throws(() => updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs }), /owned by uid .* and this process is uid/);
	assert.equal(files.get("/deploy/.env"), "WEBHOOK_SECRET=\n", "and nothing was written on the way to finding out");
	assert.equal(ops.filter(([op]) => op === "write").length, 0);
});

test("updateEnvFile derives the rendering rule itself, so no writer has to remember it", () => {
	// The first version took `quotable` from each caller. `up` passed it and `github-app-setup.mjs` did
	// not, so on Windows a PEM path was single-quoted and the cmd wrapper kept the quotes: the path the
	// worker loads was wrong, behind a ✓, on the key that decides forge auth. A rendering rule every
	// writer of this file must remember is a rule one of them will forget.
	const win = fakeFs("/d/.env", "GITHUB_APP_PRIVATE_KEY_PATH=\n");
	updateEnvFile("/d/.env", "GITHUB_APP_PRIVATE_KEY_PATH", "C:/pi/app key.pem", { fs: win.fs, platform: "win32" });
	assert.equal(win.files.get("/d/.env"), "GITHUB_APP_PRIVATE_KEY_PATH=C:/pi/app key.pem\n", "bare, because cmd's quoted `set` preserves the space");
	const posix = fakeFs("/d/.env", "GITHUB_APP_PRIVATE_KEY_PATH=\n");
	updateEnvFile("/d/.env", "GITHUB_APP_PRIVATE_KEY_PATH", "/srv/pi/app key.pem", { fs: posix.fs, platform: "linux" });
	assert.equal(posix.files.get("/d/.env"), "GITHUB_APP_PRIVATE_KEY_PATH='/srv/pi/app key.pem'\n", "quoted, because sh would split at the space");
	// And with NOBODY passing it, which is the shape every caller but `up` uses: the default has to be
	// this host's, or a caller that omits it gets another platform's rendering. Compared against the
	// explicit form rather than against a fixed string, so the assertion holds on a Windows runner too.
	const derived = fakeFs("/d/.env", "K=\n");
	updateEnvFile("/d/.env", "K", "/srv/pi/app key.pem", { fs: derived.fs });
	assert.equal(derived.files.get("/d/.env"), `K=${renderEnvValue("/srv/pi/app key.pem", { platform: process.platform })}\n`);
});

test("updateEnvFile: a file whose GROUP is not this process's is refused too", () => {
	// The layout the uid check protects is a `.env` at 0640 read by the service THROUGH ITS GROUP. With
	// `bob:pi 0640` and the operator in group `pi`, the uid matches, the rename still makes a new inode
	// with the writer's primary gid, and the `pi` service loses read access exactly as on a uid mismatch.
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n", 0o640);
	fs.statSync = (p) => {
		ops.push(["stat", p]);
		return { mode: 0o100640, uid: process.getuid?.() ?? 0, gid: (process.getgid?.() ?? 0) + 1 };
	};
	assert.throws(() => updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs }), /its group is gid .* and this process is gid/);
	assert.equal(files.get("/deploy/.env"), "WEBHOOK_SECRET=\n");
	assert.equal(ops.filter(([op]) => op === "write").length, 0);
});

test("updateEnvFile: the DEFAULT fs can resolve a link, or the repair above is dead code", () => {
	// The resolution is an optional call (`fs.realpathSync?.()`), so leaving the method out of a default
	// makes it silently inert. That is exactly what happened: the fix shipped, its test attached the method
	// to its own fake, and the only production caller did not carry it. Driven against a real link here.
	const dir = tempDir("pi-envlink-");
	const shared = join(dir, "shared.env");
	const link = join(dir, ".env");
	writeFileSync(shared, "WEBHOOK_SECRET=\n");
	symlinkSync(shared, link);
	assert.deepEqual(updateEnvFile(link, "WEBHOOK_SECRET", "abc123"), { changed: true });
	assert.ok(lstatSync(link).isSymbolicLink(), "the link survives");
	assert.equal(readFileSync(shared, "utf8"), "WEBHOOK_SECRET=abc123\n", "and what it points at is what changed");
});

test("updateEnvFile: a symlinked .env is edited THROUGH the link, never replaced by one", () => {
	// A deployment whose `.env` points at a shared env file is an ordinary layout. Renaming over the link
	// replaces it with a regular file, and every later edit to the shared file -- a rotated
	// WEBHOOK_SECRET included -- silently stops reaching this deployment.
	// A fake cannot model an inode, so what is asserted is the thing that matters: every write and the
	// rename land on the RESOLVED path, so the link itself is never the rename target.
	const { fs, files, ops } = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n");
	fs.realpathSync = (p) => (p === "/deploy/.env" ? "/shared/pi.env" : p);
	updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs });
	assert.deepEqual(
		ops.filter(([op]) => op !== "read" && op !== "stat"),
		[
			["write", "/shared/pi.env.tmp", "WEBHOOK_SECRET=abc123\n"],
			["chmod", "/shared/pi.env.tmp", 0o644],
			["rename", "/shared/pi.env.tmp", "/shared/pi.env"],
		],
		"the link is read, and everything after it goes to what the link points at",
	);
	assert.ok(
		ops.filter(([op]) => op === "stat").every(([, path]) => path === "/shared/pi.env"),
		"including every stat: the mode and owner that matter are the target's",
	);
	assert.equal(files.get("/shared/pi.env"), "WEBHOOK_SECRET=abc123\n");
	// And a link that cannot be resolved still edits the path it was given, rather than failing an edit
	// that is otherwise sound.
	const dangling = fakeFs("/deploy/.env", "WEBHOOK_SECRET=\n");
	dangling.fs.realpathSync = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	updateEnvFile("/deploy/.env", "WEBHOOK_SECRET", "abc123", { fs: dangling.fs });
	assert.equal(dangling.files.get("/deploy/.env"), "WEBHOOK_SECRET=abc123\n");
});

// -- updateEnvFile { overwrite }: which transform runs is the ONLY difference — atomicity is shared ----

test("updateEnvFile: overwrite:true replaces a set value, still via tmp + rename", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "GITHUB_AUTH_SOURCE=gh\n");
	const result = updateEnvFile("/deploy/.env", "GITHUB_AUTH_SOURCE", "app", { fs, overwrite: true });
	assert.deepEqual(result, { changed: true });
	assert.equal(files.get("/deploy/.env"), "GITHUB_AUTH_SOURCE=app\n");
	assert.deepEqual(ops.filter(([op]) => op === "write"), [["write", "/deploy/.env.tmp", "GITHUB_AUTH_SOURCE=app\n"]], "content lands on the tmp path only");
	assert.deepEqual(ops.at(-1), ["rename", "/deploy/.env.tmp", "/deploy/.env"]);
});

test("updateEnvFile: the default (overwrite absent) keeps the never-clobber discipline", () => {
	const { fs, files } = fakeFs("/deploy/.env", "GITHUB_AUTH_SOURCE=gh\n");
	const result = updateEnvFile("/deploy/.env", "GITHUB_AUTH_SOURCE", "app", { fs });
	assert.deepEqual(result, { changed: false }, "without the explicit overwrite opt-in, a set value stays sacrosanct");
	assert.equal(files.get("/deploy/.env"), "GITHUB_AUTH_SOURCE=gh\n");
});

test("updateEnvFile: overwrite:true onto an already-exact line writes NOTHING (identity short-circuit)", () => {
	const { fs, files, ops } = fakeFs("/deploy/.env", "GITHUB_AUTH_SOURCE=app\n");
	const result = updateEnvFile("/deploy/.env", "GITHUB_AUTH_SOURCE", "app", { fs, overwrite: true });
	assert.deepEqual(result, { changed: false });
	assert.equal(files.get("/deploy/.env"), "GITHUB_AUTH_SOURCE=app\n");
	assert.deepEqual(ops, [["read", "/deploy/.env"]], "the file is read once and never touched");
});

test("a `$HOME` value is not vouched for on either POSIX loader, which is the disagreement the file warns about (#394)", () => {
	// THREE CONSUMERS, TWO ANSWERS, measured for issue #392: systemd 252 reads `$HOME/x` as those literal
	// characters, while a sourcing shell and compose's `env_file` expand it. So the same file puts the jobs
	// in two different places on the two deployments this repo ships, and nothing refuses it.
	//
	// The reader already declines to vouch, because `$` is outside `UNQUOTED_PLAIN`, the READER's bare-value
	// set -- not `UNQUOTED_SAFE`, which is the WRITER's and belongs to `renderEnvValue`. So for the two keys
	// doctor reads, an operator already gets the line named. What the reader cannot do is cover a key it
	// does not read, which is why `.env.example`'s header states the rule for the rest.
	for (const loader of ["systemd", "shell"]) {
		const r = readEnvAssignments("PI_JOBS_DIR=$HOME/jobs\n", ["PI_JOBS_DIR"], { loader });
		assert.equal(r.PI_JOBS_DIR.plain, false, `${loader}: no claim is made about a value the loaders read differently`);
		assert.equal(r.PI_JOBS_DIR.value, null, `${loader}: and no value is offered`);
	}
	// cmd is the odd one out and is right to be: `worker-env-wrapper.cmd` has no expansion here at all, so
	// the literal IS what that loader reads.
	const win = readEnvAssignments("PI_JOBS_DIR=$HOME/jobs\n", ["PI_JOBS_DIR"], { loader: "cmd" });
	assert.equal(win.PI_JOBS_DIR.value, "$HOME/jobs");
	assert.equal(win.PI_JOBS_DIR.plain, true);
});
