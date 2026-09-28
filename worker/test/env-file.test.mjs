import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { EXEC_ONE_MAX, EXEC_TOTAL_MAX, SYSTEMD_HAZARD_SHAPES, WRAPPER_INTERNAL_KEYS, decodeEnvFile, envFileEditCheck, envFileEditRefusal, envFileValueLines, envFileHazard, envFileWrapperInternal, envFileLoadHazard, envFileSystemdHazard, firstInvalidUtf8, systemdReading, systemdUtf8, envKeyIsBlank, envValueShown, quotedRegions, readEnvAssignments, renderEnvValue, setEnvKey, setEnvKeyIfEmpty, updateEnvFile } from "../src/env-file.mjs";
import { SYSTEMD_259_ENV_BYTES, SYSTEMD_259_ENV_FILES } from "./helpers/systemd-env-259.mjs";
import { readStackKeys } from "../src/podman-stack.mjs";

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
	// A comment's trailing backslash continues nothing, in any shell (issue #447): the line below it is a line.
	"# note\\\nK=/srv/a.json",
	"  # note\\\nK=/srv/a.json",
	// Unless the `#` line is itself reached by a continuation, where it is value and its backslash joins the next.
	"OTHER=a\\\n# b\\\nK=/srv/a.json",
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
		["a trailing comment carrying an apostrophe", "OTHER=/a.json # it's fine\nK=/a.json"],
		["a quoted hash", "OTHER='#not a comment'\nK=/a.json"],
	]) {
		assert.equal(envFileHazard(text, { loader: "shell" }), null, `${name}: reaches past nothing`);
	}
	// A DEFAULT expansion is a hazard since the delta review's `$` allowlist: only `$NAME` and `${NAME}` pass, because a
	// default word can hold `$(`, `$[` or arithmetic, and telling a harmless one apart is the list that allowlist replaced.
	assert.deepEqual(envFileHazard("PI_LOGS_DIR=${HOME:-/tmp}/logs\nK=/a.json", { loader: "shell" }), { line: 1 });
	// systemd 252 accepts `K =/a.json` and sets the key, measured on the rig -- so the hazard here is the
	// SHELLS, which run a command named `K`. The two ends of the file disagree about whether the key is
	// assigned at all, which is exactly what "hazard" means in this reader.
	assert.equal(envFileHazard("K=/a.json\nOTHER=b"), null, "a file of ordinary assignments reaches past nothing");
	assert.equal(envFileHazard("# a note\n\nK=/a.json\n"), null, "and comments and blank lines are not hazards");
	// The cmd wrapper has no hazards at all: `for /f` takes one line at a time, with no quoting, no
	// continuation and no execution, so no line there can reach another.
	assert.equal(envFileHazard("unset K\nOTHER='open", { loader: "cmd" }), null, "no continuation, no multi-line value, no execution");
	// ONE EXCEPTION, kept CAUTIOUSLY (issue #470): `set "%%A=%%B"` is itself quoted, and a `"` in a value was taken
	// to close it. The parser's phase order says FOR variables are substituted after the quotes and operators are
	// parsed, so it cannot, but that is not Microsoft's documentation and nothing here runs cmd, so the line stays
	// unvouched and `renderEnvValue` still refuses to WRITE the character.
	assert.deepEqual(envFileHazard('OTHER=x" & set "K=evil\nK=C:/ok.json', { loader: "cmd" }), { line: 1 }, "a double quote in a value stays the cmd loader's one hazard (cautious, issue #470)");
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
	// win32 -- but they are NOT vouched for: the wrapper's `set "%%A=%%B"` is itself quoted, and whether a `"` in a
	// value survives it is not documented by Microsoft (issue #470). The reading stands and the VOUCH does not, which
	// is the same distinction the POSIX side draws, and it is the one the writer already enforced by
	// refusing to emit the character at all.
	assert.deepEqual(cmd('K="/srv/a.json"'), rec({ value: '"/srv/a.json"', plain: true, vouched: false, hazardLine: 1 }), "a double quote in a value is not vouched for (cautious, issue #470)");
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

// -- issue #447: systemd's own line structure, where this reader cannot model it ---------------------------------

test("quotedRegions: a value that opens with a quote runs to its close, and nothing else is a region (#447)", () => {
	const pem = 'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"\nK=1\n';
	const table = [
		["a PEM in double quotes", pem, [{ open: 1, close: 3 }]],
		["single quotes", "K='a\nb'\n", [{ open: 1, close: 2 }]],
		["an escaped double quote does not close", 'K="a\\"\nb"\n', [{ open: 1, close: 2 }]],
		["a backslash does not escape in single quotes", "K='a\\'\nb'\n", []],
		["never closes: to the end of the file", 'K="a\nb\nc\n', [{ open: 1, close: null }]],
		["`export` and blanks around `=`", ' export K = "a\nb"\n', [{ open: 1, close: 2 }]],
		["two regions, and the lines between are lines", 'A="1\n2"\nB=x\nC=\'3\n4\'\n', [{ open: 1, close: 2 }, { open: 4, close: 5 }]],
		["a quote that closes on its own line is no region", 'K="a" "b"\nK2=\'x\'\n', []],
		["a quote in the middle of a value is no region", 'K=a"b\nL=1\n', []],
		["a comment is no region", '# K="a\nL=1\n', []],
		["a non-identifier key is not modelled here (envFileSystemdHazard's)", 'FOO-BAR="a\nL=1\n"\n', []],
		["a CRLF file", 'K="a\r\nb"\r\nL=1\r\n', [{ open: 1, close: 2 }]],
		["a region closes at its first quote, even one in a key-looking line", 'K="a\nL="b\n"\nM=1\n', [{ open: 1, close: 2 }]],
	];
	for (const [name, text, want] of table) assert.deepEqual(quotedRegions(text), want, name);
});

test("envFileSystemdHazard agrees with systemd 259 on every measured file, and names the line and the shape (#447)", () => {
	// THE ORACLE is the table: what systemd set, measured, beside what this function reports. A row systemd read with
	// the swallowed key UNSET where a line-by-line reading sets it is a hazard; the rest must be null.
	assert.ok(SYSTEMD_259_ENV_FILES.length >= 94 && SYSTEMD_259_ENV_BYTES.length >= 12, "the measured table is intact");
	for (const [name, text, , want] of SYSTEMD_259_ENV_FILES) {
		assert.deepEqual(envFileSystemdHazard(text), want === null ? null : { line: want[0], shape: want[1] }, name);
	}
	// The files systemd refused to LOAD, and the ones it loaded despite a stray byte, from their BYTES.
	for (const [name, hex, systemd, want] of SYSTEMD_259_ENV_BYTES) {
		assert.deepEqual(envFileLoadHazard(Buffer.from(hex, "hex")), want === null ? null : { line: want[0], shape: want[1] }, name);
		assert.equal(want !== null, systemd === null, `${name}: a load hazard exactly where systemd refused the file`);
	}
	// Every shape is in them, as a must-refuse row.
	const shapes = new Set([...SYSTEMD_259_ENV_FILES, ...SYSTEMD_259_ENV_BYTES].filter((r) => r[3] !== null).map((r) => r[3][1]));
	// Too big for the table: the measured row c03 (one value of 131075 bytes; systemd 259 fails the exec with 203/EXEC).
	shapes.add(envFileLoadHazard(Buffer.from(`PI_EGRESS=0\nX=${"h".repeat(131075)}\n`)).shape);
	// The two `shell-` shapes are the sourcing shell's, measured in /bin/sh, bash --posix and dash by their own test.
	assert.deepEqual([...shapes].sort(), Object.keys(SYSTEMD_HAZARD_SHAPES).filter((k) => !k.startsWith("shell-")).sort(), "each shape has a measured row");
	for (const name of ["r-reopen-dq", "r-reopen-dq-space", "r-reopen-sq", "r-reopen-on-close-line", "r-key-dash", "r-key-dot", "r-key-digit", "r-key-space", "r-lone-cr"]) {
		assert.ok(SYSTEMD_259_ENV_FILES.find((r) => r[0] === name)[3] !== null, `${name}, one of the issue's own shapes, is refused`);
	}
});

test("quotedRegions follows systemd's line model: a CR, U+2028 or U+2029 on a value's first line is still that value (#447 gate round 1)", () => {
	// `(.*)$` stopped matching at those three characters, so the value that opens on line 2 was no region and the lines
	// it swallows read as assignments (measured on systemd 259: PI_EGRESS=0 set, the reader said 1).
	for (const name of ["g1-a01-u2028-dq", "g1-a02-midcr-dq", "g1-a03-u2029-sq-backends", "g1-a04-u2028-proxy", "g1-a32-export-u2028"]) {
		const [, text, systemd] = SYSTEMD_259_ENV_FILES.find((r) => r[0] === name);
		assert.deepEqual(quotedRegions(text), [{ open: 2, close: 4 }], name);
		// Line 3 is inside that value, so it is not an assignment: no value is claimed for it (systemd kept line 1's).
		const key = Object.keys(systemd)[0];
		const read = readEnvAssignments(text, [key])[key];
		assert.deepEqual([read.line, read.plain, read.value], [3, false, null], `${name}: line 3 is value, not ${key}`);
	}
});

test("envFileSystemdHazard checks the reader's own region model at every newline, and names any disagreement (#447 gate round 1)", () => {
	// A quote systemd never opens, because the line it is on is the tail of a continuation (the `Y="b` below is VALUE
	// text to systemd), while the reader's region model opens one there: the model and the parser disagree about line 4.
	assert.deepEqual(envFileSystemdHazard('A=1\nX=a\\\nY="b\nK=0\n"\n'), { line: 3, shape: "unmodelled-quote" });
	// The measured row (g1-a22): systemd set PI_EGRESS=0 from line 4, a line-by-line reading would say 1 or refuse.
	assert.deepEqual(SYSTEMD_259_ENV_FILES.find((r) => r[0] === "g1-a22-cont-then-opener")[3], [3, "unmodelled-quote"]);
	// And where the two agree there is nothing to say: the documented PEM, and a CR or U+2028 inside a modelled value.
	for (const text of ['P="-----BEGIN-----\nab\ncd\n-----END-----"\nL=1\n', 'X="a\rb\nc"\nL=1\n', 'X="a\u2028b\nc"\nL=1\n']) assert.equal(envFileSystemdHazard(text), null, JSON.stringify(text));
});

test("envFileLoadHazard: a NUL anywhere, or invalid UTF-8 in what systemd pushes, from the BYTES (#447 gate round 1)", () => {
	const b = (...parts) => Buffer.concat(parts.map((x) => (typeof x === "string" ? Buffer.from(x, "utf8") : Buffer.from(x))));
	assert.deepEqual(envFileLoadHazard(b("A=1\n# c", [0], "\nB=2\n")), { line: 2, shape: "nul" });
	assert.deepEqual(envFileLoadHazard(b("A=1\nX=", [0xff], "\n")), { line: 2, shape: "invalid-utf8" });
	assert.deepEqual(envFileLoadHazard(b("A=1\n", [0xff], "=1\n")), { line: 2, shape: "invalid-utf8" }, "in a key");
	assert.deepEqual(envFileLoadHazard(b('X="a\n', [0xc0, 0xaf], '\n"\n')), { line: 1, shape: "invalid-utf8" }, "an overlong form inside a multi-line value is that value's");
	assert.deepEqual(envFileLoadHazard(b("A=1\nX=", [0xff])), { line: 2, shape: "invalid-utf8" }, "at the end of a file with no final newline");
	assert.deepEqual(envFileLoadHazard(b("A=1\n", [0xff], "=\n")), { line: 2, shape: "invalid-utf8" }, "a key with an empty value is pushed too");
	// systemd never pushes a comment or a line with no `=`, and loads these (measured).
	assert.equal(envFileLoadHazard(b("# c ", [0xff], "\nA=1\n")), null);
	assert.equal(envFileLoadHazard(b("; c ", [0xfe], "\nA=1\n")), null);
	assert.equal(envFileLoadHazard(b("junk ", [0xff], "\nA=1\n")), null);
	assert.equal(envFileLoadHazard(b("X=a�b\n")), null, "a correctly encoded U+FFFD is text");
	// Decoding first loses the evidence, so a string is checked for NUL only.
	assert.equal(envFileLoadHazard("X=a�b\n"), null);
	assert.deepEqual(envFileLoadHazard("A=1\nB=\u0000\n"), { line: 2, shape: "nul" });
	// decodeEnvFile is the one place bytes become text, and only systemd's loader refuses to load.
	assert.deepEqual(decodeEnvFile(b("A=é\n")), { text: "A=é\n", loadHazard: null });
	assert.deepEqual(decodeEnvFile(b("A=", [0xe9], "\n"), { loader: "shell" }).loadHazard, null);
	assert.deepEqual(decodeEnvFile(b("A=", [0xe9], "\n")).loadHazard, { line: 1, shape: "invalid-utf8" });
});

test("the shell reading: a second assignment on one line, and ANSI-C quoting, are hazards (#447 gate round 1)", () => {
	// Measured in bash and sh: `X=a PI_EGRESS=0` sets PI_EGRESS, and `$'a\'b` does not close at `\'`.
	assert.deepEqual(envFileHazard("X=a PI_EGRESS=0\n", { loader: "shell" }), { line: 1 });
	assert.deepEqual(envFileHazard("A=1\nX=$'a\\'b\nK=1\nY=1' #'\n", { loader: "shell" }), { line: 2 });
	// Not inside quotes, not in a comment, not a word that is no assignment, and not for systemd, which reads the
	// whole rest of the line as the value.
	for (const text of ["X='a PI_EGRESS=0'\n", 'X="a PI_EGRESS=0"\n', "X=a # PI_EGRESS=0\n", "X=a\\ PI_EGRESS=0\n", "X='$'\"'\"'x'\n"]) {
		assert.equal(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(text));
	}
	// `"$'x"` is literal text to sh, and is refused anyway since the delta review: outside single quotes the only `$`
	// forms that pass are `$NAME` and `${NAME}`, and deciding which other ones are harmless is what that rule stopped doing.
	assert.deepEqual(envFileHazard('X="$\'x"\n', { loader: "shell" }), { line: 1 });
	assert.equal(envFileHazard("X=a PI_EGRESS=0\n"), null, "systemd: one assignment, X");
});

test("envFileSystemdHazard: the harmless neighbours of each shape pass, the PEM and the corpus included (#447)", () => {
	// After a closing quote any character but a blank, a quote or a backslash puts systemd in VALUE, where a quote is
	// literal (measured: `K="a" # "b"` sets `a# "b"`), so these read line by line in both.
	for (const text of ['K="a"b', 'K=a"b"c', 'K="a" # "b"', 'K="/a.json" # see "notes"', "K='a'b'", 'K="a" "b"', 'K="a\nb" x "c\nL=1', "FOO-BAR=\"x\"\nL=1", "FOO-BAR=x \"y\nL=1", "=\"x\nL=1", "# FOO-BAR=\"x\nL=1", "; FOO-BAR=\"x\nL=1"]) {
		assert.equal(envFileSystemdHazard(text), null, JSON.stringify(text));
	}
	// A CR that is a line ending, one at the very end of the file, and one inside a quoted value are all read alike.
	for (const text of ["K=1\r\nL=2\r\n", "K=1\nL=2\r", 'K="a\rb"\nL=1\n', "K='a\rb'\nL=1\n"]) assert.equal(envFileSystemdHazard(text), null, JSON.stringify(text));
	// A continuation the line scan already sees is modelled (the next line is INSIDE), so it is no hazard; nor is a
	// backslash before CRLF, which systemd does not continue and the reader does, reading LESS rather than more.
	for (const text of ["K=a\\\nL=1", 'K="a"\\\nL=1', "K=a\\\r\nL=1\r\n", "# note\\\nL=1"]) assert.equal(envFileSystemdHazard(text), null, JSON.stringify(text));
	// A comment's trailing backslash continues nothing in systemd 254+ (p-comment-backslash, measured on 259), so the
	// line below it is an ordinary assignment to the systemd reading; one reached BY a continuation is value, and its
	// backslash does join the next line (q-cont-into-hash-line: systemd set K to `a# bPI_BACKENDS=podman`).
	for (const text of ["# note\\\nK=/a.json\n", "  ; note\\\nK=/a.json\n"]) {
		const k = readEnvAssignments(text, ["K"]).K;
		assert.deepEqual([k.value, k.plain, k.vouched], ["/a.json", true, true], JSON.stringify(text));
	}
	assert.equal(readEnvAssignments("O=a\\\n# b\\\nK=/a.json\n", ["K"]).K.plain, false, "a `#` line inside a continuation continues");
	// The shells too (sh, bash, dash and zsh all set K, the E2 corpus rows), and PLAIN so E2 compares them rather than
	// passing them by default. `;` is systemd's comment only: a shell reads that line as a syntax error.
	for (const text of ["# note\\\nK=/a.json\n", "  # note\\\nK=/a.json\n"]) {
		const k = readEnvAssignments(text, ["K"], { loader: "shell" }).K;
		assert.deepEqual([k.value, k.plain, k.vouched], ["/a.json", true, true], `shell: ${JSON.stringify(text)}`);
	}
	assert.equal(readEnvAssignments("O=a\\\n# b\\\nK=/a.json\n", ["K"], { loader: "shell" }).K.plain, false, "shell: a `#` line inside a continuation continues");
	assert.equal(readEnvAssignments("O='a\n# b\\\nK=/a.json\n'\n", ["K"], { loader: "shell" }).K.plain, false, "shell: a `#` line inside a quote is value");
	assert.notEqual(envFileHazard("; note\\\nK=/a.json\n", { loader: "shell" }), null, "shell: a `;` line is not a comment");
	assert.equal(readEnvAssignments("; note\\\nK=/a.json\n", ["K"], { loader: "shell" }).K.plain, false, "shell: so its backslash joins K's line to it");
	// THE CORPUS, every entry, with the lone-CR entry as the one exception: it is the issue's own shape.
	for (const text of ORACLE_CORPUS) {
		const want = text === "K=/srv/a\rb.json" ? { line: 1, shape: "lone-cr" } : null;
		assert.deepEqual(envFileSystemdHazard(text), want, JSON.stringify(text));
	}
});

test("envFileSystemdHazard: the first hazard wins, and a region closed before it moves nothing (#447)", () => {
	assert.deepEqual(envFileSystemdHazard('A="1\n2"\nB=ok\nFOO-BAR="x\nL=1\n"\nX=1\rY=2\n'), { line: 4, shape: "non-identifier-key" });
	assert.deepEqual(envFileSystemdHazard('A="1\n2"\nB=ok\nX=1\rY=2\nFOO-BAR="x\n'), { line: 4, shape: "lone-cr" });
	// A lone CR inside a PEM's quotes is value to both readers; one after the PEM is not.
	assert.equal(envFileSystemdHazard('P="-----BEGIN-----\nab\rcd\n-----END-----"\nL=1\n'), null);
	assert.deepEqual(envFileSystemdHazard('P="-----BEGIN-----\nabcd\n-----END-----"\nL=1\rM=2\n'), { line: 4, shape: "lone-cr" });
	// Lines inside an identifier region are value: a non-identifier line in a PEM body is not a key.
	assert.equal(envFileSystemdHazard('P="a\nFOO-BAR="x\n"\nL=1\n'), null);
	assert.equal(envFileSystemdHazard(null), null);
	assert.equal(envFileSystemdHazard(""), null);
});

test("the systemd reading shares the hazard: envFileHazard reports it, and no key in such a file is vouched (#447)", () => {
	assert.deepEqual(envFileHazard("FOO-BAR=\"x\nK=/a.json\n\"\n"), { line: 1, shape: "non-identifier-key" });
	assert.deepEqual(envFileHazard("X=1\rK=/a.json\n"), { line: 1, shape: "lone-cr" });
	// Only systemd's: the shells read LF lines and carry every quote, and the cmd wrapper reads line by line.
	assert.equal(envFileHazard("X=1\rK=/a.json\n", { loader: "shell" }), null);
	assert.equal(envFileHazard("X=1\rK=/a.json\n", { loader: "cmd" }), null);
	const read = readEnvAssignments('K=/a.json\nN="a" "b\nL=1\n"\n', ["K"]).K;
	assert.equal(read.plain, true, "the line itself is plain");
	assert.equal(read.vouched, false, "and the file is one systemd reads differently, so the value is not vouched");
	assert.equal(read.hazardLine, 2);
});

test("the systemd reading knows a multi-line quoted value: a key line inside one is not an assignment (#447)", () => {
	// Before #447 only the venue reader knew; doctor's systemd reading took this line for PI_PAUSE_WINDOWS_FILE's.
	const text = 'NOTE="see\nK=/inside.json\n"\nM=/after.json\n';
	const k = readEnvAssignments(text, ["K", "M"], { loader: "systemd" });
	assert.equal(k.K.plain, false, "inside the value that opens on line 1");
	assert.equal(k.K.value, null);
	assert.equal(k.K.blank, false);
	assert.deepEqual([k.M.value, k.M.vouched], ["/after.json", true], "the line after the close is a line again");
	assert.equal(readEnvAssignments('NOTE="see\nK=\n"\n', ["K"]).K.blank, false, "an empty-looking line inside a value assigns nothing");
	// The CLOSING line is part of the value too. Measured on systemd 259 (the c-key-on-close-line row): the first quote
	// on line 2 closes NOTE, so NOTE is `see\nK=/x.json"` and K is never set, though line 2 on its own reads as a
	// plain quoted assignment.
	const closing = readEnvAssignments('NOTE="see\nK="/x.json"\n', ["K"]).K;
	assert.deepEqual([closing.plain, closing.value], [false, null], "the line that closes the value");
	// Never closed: to the end of the file.
	assert.equal(readEnvAssignments('NOTE="see\nK=/x.json\n', ["K"]).K.plain, false);
	// The documented PEM, with keys on both sides, reads as it always did.
	const pem = 'A=/a.json\nGITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"\nB=/b.json\n';
	const both = readEnvAssignments(pem, ["A", "B"]);
	assert.deepEqual([both.A.value, both.A.vouched, both.B.value, both.B.vouched], ["/a.json", true, "/b.json", true]);
});

test("updateEnvFile never rewrites bytes it did not mean to: a file that is not UTF-8 is refused and left byte-identical (#447 gate round 1)", () => {
	// Measured through `up` on the round's host: `K=caf<0xE9>` came back as `K=caf<EF BF BD>` after up added its own
	// key, the operator's byte replaced in a line up never meant to touch.
	const dir = tempDir("pi-dispatch-env-latin1-");
	const path = join(dir, ".env");
	const before = Buffer.concat([Buffer.from("PI_EGRESS=0\nK=caf"), Buffer.from([0xe9]), Buffer.from("\nWEBHOOK_SECRET=\n")]);
	writeFileSync(path, before);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "s3cr3t"), /refusing to edit .*\.env: line 2 \(byte 17\) is not valid UTF-8, and rewriting the file would replace those bytes/);
	assert.ok(readFileSync(path).equals(before), "byte-identical after the refused edit");
	assert.equal(existsSync(`${path}.tmp`), false, "and no temporary file was left");
	// Valid UTF-8, a CRLF file and a BOM included, is edited and every other byte survives.
	const ok = Buffer.from("\ufeffK=café\r\nWEBHOOK_SECRET=\r\n", "utf8");
	writeFileSync(path, ok);
	// On Linux: to a sourcing shell the BOM line is a command, which the macOS writer refuses to edit around (round 4).
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "s3cr3t", { platform: "linux" }).changed, true);
	assert.equal(readFileSync(path, "utf8"), "\ufeffK=caf\u00e9\r\nWEBHOOK_SECRET=s3cr3t\r\n");
});

test("firstInvalidUtf8 finds the first byte that does not begin a well-formed sequence (#447 gate round 1)", () => {
	const at = (...bytes) => firstInvalidUtf8(Buffer.from(bytes));
	assert.equal(at(0x41, 0xc3, 0xa9, 0xe2, 0x80, 0xa8, 0xf0, 0x9f, 0x98, 0x80), -1, "ASCII, e-acute, U+2028, an emoji");
	assert.equal(at(0x41, 0xe9, 0x42), 1, "a Latin-1 byte");
	assert.equal(at(0x80), 0, "a stray continuation byte");
	assert.equal(at(0xc0, 0xaf), 0, "an overlong form");
	assert.equal(at(0xed, 0xa0, 0x80), 0, "a surrogate");
	assert.equal(at(0xf4, 0x90, 0x80, 0x80), 0, "past U+10FFFF");
	assert.equal(at(0x41, 0xe2, 0x80), 1, "truncated at the end");
});

test("the writer's own line model is the loaders': blanks are space and tab, and a value runs to LF (#447 gate round 1 audit)", () => {
	// A NBSP-led line is no assignment to any loader (systemd drops it as invalid), so it is not the key's line.
	assert.equal(setEnvKeyIfEmpty("\u00a0WEBHOOK_SECRET=old\n", "WEBHOOK_SECRET", "new"), "\u00a0WEBHOOK_SECRET=old\nWEBHOOK_SECRET=new\n");
	// A set value holding a CR or U+2028 is set: it is not appended over (the operator's value would lose to the new one).
	for (const text of ["WEBHOOK_SECRET=a\rb\n", "WEBHOOK_SECRET=a\u2028b\n", "WEBHOOK_SECRET=\u000c\n"]) {
		assert.equal(setEnvKeyIfEmpty(text, "WEBHOOK_SECRET", "new"), text, JSON.stringify(text));
	}
	assert.equal(setEnvKey("WEBHOOK_SECRET=a\rb\n", "WEBHOOK_SECRET", "new"), "WEBHOOK_SECRET=new\n", "the overwrite finds that line too");
	// A form feed before `#` makes a WORD to every shell, so that line runs rather than being a comment (measured in sh,
	// bash, dash and zsh: `#: command not found`).
	assert.deepEqual(envFileHazard("K=/a.json\n\u000c# note\n", { loader: "shell" }), { line: 2 });
	assert.deepEqual(envFileHazard("K=/a.json\n\u00a0\n", { loader: "shell" }), { line: 2 });
});

test("systemd's UTF-8 rule: well-formed AND no Unicode noncharacter, judged on the value as systemd stores it (#447 gate round 2)", () => {
	const u = (str) => Buffer.from(str, "utf8");
	// Measured on systemd 259: each of these in a value fails the load, and a strict TextDecoder accepts them all.
	for (const cp of [0xfffe, 0xffff, 0xfdd0, 0xfdef, 0x1ffff, 0x10fffe]) assert.equal(systemdUtf8(u(`a${String.fromCodePoint(cp)}b`)), false, cp.toString(16));
	for (const cp of [0xfdcf, 0xfdf0, 0xfffd, 0x80, 0x2028, 0x10fffd]) assert.equal(systemdUtf8(u(`a${String.fromCodePoint(cp)}b`)), true, cp.toString(16));
	const b = (...parts) => Buffer.concat(parts.map((x) => (typeof x === "string" ? Buffer.from(x, "utf8") : Buffer.from(x))));
	assert.deepEqual(envFileLoadHazard(b("A=1\nX=a\uffffb\n")), { line: 2, shape: "invalid-utf8" }, "a noncharacter in a value");
	assert.deepEqual(envFileLoadHazard(b("A=1\nX\uffff=1\n")), { line: 2, shape: "invalid-utf8" }, "in a key");
	assert.equal(envFileLoadHazard(b("A=1\n# \uffff\n\uffff\n")), null, "in a comment, or a line with no `=`, it is never stored");
	// The value AS STORED: an escape can join a sequence the raw bytes split, and a double-quote escape can keep a
	// backslash that splits one (both measured: the first loads, the second does not).
	assert.equal(envFileLoadHazard(b("A=1\nX=", [0xe2], "\\", [0x82, 0x82], "\n")), null, "X=\\xE2\\\\\\x82\\x82");
	assert.equal(envFileLoadHazard(b('A=1\nX="', [0xc3], '""', [0xa9], '"\n')), null, "two quoted halves of one character");
	assert.deepEqual(envFileLoadHazard(b('A=1\nX="', [0xc3], "\\", [0xa9], '"\n')), { line: 2, shape: "invalid-utf8" }, "a kept backslash inside the sequence");
});

test("the shell reading judges the LOGICAL line and refuses a command separator (#447 gate round 2)", () => {
	// Measured in bash: each of these sets the key after the first `=`; systemd reads none of them.
	for (const text of ["X=a\\\n PI_EGRESS=0\n", "X=a\\\n;PI_EGRESS=0\n", "X=a\\\n#;PI_EGRESS=0\n", "A=0\nX=$\\\n'a\\'b\nA=1\nY=1' #'\n", "X=a;PI_EGRESS=0\n", "X=a&&PI_EGRESS=0\n", "X=a|b\n"]) {
		assert.notEqual(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(text));
	}
	// Single-quoted, escaped, or after a comment, a separator is text.
	for (const text of ["X='a;b'\n", "X=a # b;c\n", "X=a\\;b\n"]) assert.equal(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(text));
});

test("the writers never take a line inside a value for the key's, and updateEnvFile reads its result back first (#447 gate round 2)", () => {
	// A `# KEY=` comment inside a quoted value is value: replacing it put the key into NOTE (measured on systemd 259).
	assert.equal(setEnvKeyIfEmpty('NOTE="a\n# PI_BACKENDS=\n"\n', "PI_BACKENDS", "podman"), 'NOTE="a\n# PI_BACKENDS=\n"\nPI_BACKENDS=podman\n');
	assert.equal(setEnvKeyIfEmpty("X=a\\\n# PI_BACKENDS=\n", "PI_BACKENDS", "podman"), "X=a\\\n# PI_BACKENDS=\nPI_BACKENDS=podman\n", "the tail of a continuation too");
	assert.equal(setEnvKey('NOTE="a\nPI_BACKENDS=local\n"\n', "PI_BACKENDS", "podman"), 'NOTE="a\nPI_BACKENDS=local\n"\nPI_BACKENDS=podman\n', "an assignment-looking line inside a value is not the key's");
	// For ANY loader: a mid-value quote carries only in a shell, where line 2 is part of X, so it is skipped too.
	assert.equal(setEnvKeyIfEmpty("X=a'b\n# PI_BACKENDS=\n'\n", "PI_BACKENDS", "podman"), "X=a'b\n# PI_BACKENDS=\n'\nPI_BACKENDS=podman\n");
	// Appending after a file that ends INSIDE something swallows the new line (w01, w02, w13, w14, measured): refused,
	// nothing written, for the platform's own loader.
	const dir = tempDir("pi-dispatch-env-swallow-");
	const path = join(dir, ".env");
	for (const platform of ["linux", "darwin"]) {
		for (const before of ["A=1\nX=a\\\n", "A=1\nX=a\\", 'A=1\nX="abc\n', "A=1\nX='abc\n"]) {
			writeFileSync(path, before);
			assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform }), /refusing to edit .*: (after the edit, .* would (read line \d+ as part of a quoted value or a continuation above it, not as|find no|read something other than what was written for) PI_BACKENDS|after the edit, the wrapper that sources the file would read line \d+, where PI_BACKENDS is written, as part of the command above it|line \d+ has [^.]+|line \d+ is one the wrapper that sources this file reads differently from this command)[^]*\. Nothing was written/, `${platform} ${JSON.stringify(before)}`);
			// macOS names the swallowed line (third regression review nit): `X=a\` at the end, then the appended key.
			if (platform === "darwin" && before === "A=1\nX=a\\\n") assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform }), /^Error: refusing to edit .*: after the edit, the wrapper that sources the file would read line 3, where PI_BACKENDS is written, as part of the command above it, so no command would assign PI_BACKENDS\. Nothing was written$/);
			assert.equal(readFileSync(path, "utf8"), before, "unchanged");
		}
	}
	// On Linux a file systemd splits differently, or will not load, is refused too: the key's line cannot be vouched for.
	writeFileSync(path, "A=1\nX=1\rY=2\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux" }), /line 2 has a carriage return/);
	writeFileSync(path, "A=x\ufffe\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux" }), /line 1 has bytes in a key or value that are not valid UTF-8, or a Unicode noncharacter/);
	// A caller's own condition, checked before the write.
	writeFileSync(path, "A=1\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux", verify: () => "the caller says no" }), /refusing to edit .*: the caller says no\. Nothing was written/);
	assert.equal(readFileSync(path, "utf8"), "A=1\n");
	// And an ordinary edit, a CRLF file on Linux included (systemd strips the CR, and the file keeps its endings), still
	// goes through. On macOS a CRLF file is refused: the wrapper that sources it keeps every CR (round-cap review).
	writeFileSync(path, "A=1\r\nWEBHOOK_SECRET=\r\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "s3cr3t", { platform: "linux" }).changed, true);
	assert.equal(envFileEditRefusal("text is never refused", path), null);
	// An overwrite replaces the FIRST assignment, and a later one still wins for every loader: refused, not reported set.
	writeFileSync(path, "K=a\nK=b\n");
	assert.throws(() => updateEnvFile(path, "K", "new", { platform: "linux", overwrite: true }), /after the edit, systemd's EnvironmentFile= would read something other than what was written for K \(the assignment it takes is on line 2\)/);
	assert.equal(readFileSync(path, "utf8"), "K=a\nK=b\n");
	// The same through the macOS wrapper's reading, which the shell branch of the read-back answers.
	assert.throws(() => updateEnvFile(path, "K", "new", { platform: "darwin", overwrite: true }), /after the edit, the wrapper that sources the file would read K as something other than what was written/);
	assert.equal(readFileSync(path, "utf8"), "K=a\nK=b\n");
});

test("the writer never overwrites a key the service's loader already reads as set (#447 gate round 3)", () => {
	// The diff reviewer's repro: the quote in NOTE carries only in a shell, so the WEBHOOK_SECRET line is set for
	// systemd. Skipping it for "any loader" appended a new random secret, which systemd then took (receiver HMAC broken).
	const repro1 = 'NOTE=see "the docs\nWEBHOOK_SECRET=operator-secret\n';
	assert.equal(setEnvKeyIfEmpty(repro1, "WEBHOOK_SECRET", "new"), repro1, "already set: the input back");
	// And a line the shell reads inside a quote but systemd reads as `WEBHOOK_SECRET =x` (201 fuzz hits).
	const repro2 = 'WEBHOOK_SECRET=\n"\nWEBHOOK_SECRET =x\n';
	assert.equal(setEnvKeyIfEmpty(repro2, "WEBHOOK_SECRET", "new"), repro2);
	// WHERE to write is still "never into a line any loader reads as value": an EMPTY line the shell reads inside NOTE's
	// quote is not filled in place; the key goes at the end, where the read-back judges it.
	assert.equal(setEnvKeyIfEmpty('NOTE=see "the docs\nWEBHOOK_SECRET=\n', "WEBHOOK_SECRET", "new"), 'NOTE=see "the docs\nWEBHOOK_SECRET=\nWEBHOOK_SECRET=new\n');
	const dir = tempDir("pi-dispatch-env-clobber-");
	const path = join(dir, ".env");
	for (const text of [repro1, repro2]) {
		writeFileSync(path, text);
		assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, false, JSON.stringify(text));
		assert.equal(readFileSync(path, "utf8"), text);
	}
	// Where the line scan sees no set line at all but systemd does: a lone CR splits `A=1` from the key. Refused, and
	// since the round-cap review by the lone CR it names, which is checked before any "already set" (a hazard file is
	// never reported as set). The key is still never overwritten either way.
	writeFileSync(path, "A=1\rWEBHOOK_SECRET=old\n");
	assert.equal(systemdReading("A=1\rWEBHOOK_SECRET=old\n", "WEBHOOK_SECRET").value, "old");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /refusing to edit .*: line 1 has a carriage return \(CR\) that is not part of a CRLF line ending.*\. Nothing was written/);
	assert.equal(readFileSync(path, "utf8"), "A=1\rWEBHOOK_SECRET=old\n");
	// An EMPTY assignment is still filled, as ever.
	writeFileSync(path, "WEBHOOK_SECRET=\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, true);
	// setEnvKey's counterpart: a set line some loader reads as value is not rewritten in place; the new line goes at the
	// end, and on Linux systemd reads it (the last assignment); on macOS the shell would swallow it, so it is refused.
	assert.equal(setEnvKey(repro1, "WEBHOOK_SECRET", "new"), `${repro1}WEBHOOK_SECRET=new\n`);
	// Nor does it fall back to a `# KEY=` comment above that line: systemd would then still take the old line below it.
	assert.equal(setEnvKey(`# WEBHOOK_SECRET=\n${repro1}`, "WEBHOOK_SECRET", "new"), `# WEBHOOK_SECRET=\n${repro1}WEBHOOK_SECRET=new\n`);
	writeFileSync(path, repro1);
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux", overwrite: true }).changed, true);
	assert.equal(systemdReading(readFileSync(path, "utf8"), "WEBHOOK_SECRET").value, "new");
	writeFileSync(path, repro1);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin", overwrite: true }), /line 1 is one the wrapper that sources this file reads differently from this command/);
});

test("an environment too large for exec is a load hazard: one KEY=value or the total (#447 gate round 3)", () => {
	// Measured on systemd 259 (gate461-adv r3 c01-c05): `X=` + 131060 bytes runs, + 131075 fails 203/EXEC "Argument
	// list too long"; 24 values of 100 KiB fail and 19 run. The bounds: one KEY=value under 131071 bytes, and a total
	// re-measured in the focus review under `systemd-run --user` on Fedora 44, systemd 259, stack limit 8 MiB (so
	// ARG_MAX 2097152): an .env of 2096288 counted bytes in 21 assignments started, 2096349 failed with 203/EXEC. The
	// bound is 2 MiB less a 64 KiB margin for the argv, systemd's own variables (17, 535 bytes there) and the unit's,
	// counting 8 bytes of pointer per variable. It was 1 MiB, which refused a 1.1 MB file systemd starts.
	assert.equal(EXEC_ONE_MAX, 131071);
	assert.equal(EXEC_TOTAL_MAX, 2031616);
	const one = (n) => `PI_EGRESS=0\nX=${"h".repeat(n - 2)}\n`;
	// Gate round 4, measured (r4 d01-d03): a KEY=value of 131071 bytes runs, of 131072 fails. The kernel's bound counts
	// the NUL, so the longest accepted string is 131071 bytes.
	assert.equal(envFileLoadHazard(one(EXEC_ONE_MAX)), null, "131071 bytes runs");
	assert.deepEqual(envFileLoadHazard(one(EXEC_ONE_MAX + 1)), { line: 2, shape: "exec-too-large", detail: "X=... is 131072 bytes" });
	// Only the environment exec gets: the LAST value of a name (d11: 200 KB reassigned small runs), valid names only.
	assert.equal(envFileLoadHazard(`X=${"h".repeat(200000)}\nX=small\n`), null);
	assert.equal(envFileLoadHazard(`FOO-BAR=${"h".repeat(200000)}\n`), null, "a name systemd drops never reaches exec");
	assert.deepEqual(envFileLoadHazard(Buffer.from(one(200002))), { line: 2, shape: "exec-too-large", detail: "X=... is 200002 bytes" }, "from bytes too");
	const many = (count) => Array.from({ length: count }, (_, i) => `K${i}=${"h".repeat(100000)}`).join("\n") + "\n";
	assert.equal(envFileLoadHazard(many(11)), null, "about 1.1 MB, which systemd starts and the old 1 MiB bound refused");
	assert.equal(envFileLoadHazard(many(20)), null, "about 2.0 MB, under the bound");
	assert.deepEqual(envFileLoadHazard(many(24)), { line: 21, shape: "exec-too-large", detail: "the file's assignments reach 2100263 bytes by this line" });
	// Eight bytes a variable, as the kernel counts a pointer: 130000 tiny ones cross the bound though their text does not.
	const tiny = Array.from({ length: 130000 }, (_, i) => `V${i}=1`).join("\n") + "\n";
	assert.ok(Buffer.byteLength(tiny) < EXEC_TOTAL_MAX, "the text alone is under the bound");
	assert.equal(envFileLoadHazard(tiny)?.shape, "exec-too-large");
	// A reassigned key counts once, as the service gets it once.
	assert.equal(envFileLoadHazard(`K=${"h".repeat(100000)}\n`.repeat(24)), null);
	// The writer's read-back refuses to add a key to a file the service cannot start with (w27, measured 203/EXEC).
	const dir = tempDir("pi-dispatch-env-exec-");
	const path = join(dir, ".env");
	writeFileSync(path, one(200002));
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux" }), /line 2 has more environment than the service can safely be started with: .* \(X=\.\.\. is 200002 bytes\)\. Nothing was written/);
	assert.equal(envFileEditCheck(one(200002), path, "PI_BACKENDS", "podman", { platform: "linux" }) !== null, true, "and the dry run says so first");
});

test("an appended line uses the file's own line ending (#447 gate round 3)", () => {
	assert.equal(setEnvKeyIfEmpty("A=1\r\nB=2\r\n", "K", "v"), "A=1\r\nB=2\r\nK=v\r\n");
	assert.equal(setEnvKeyIfEmpty("A=1\r\nB=2", "K", "v"), "A=1\r\nB=2\r\nK=v\r\n", "and terminates a last line that had none");
	assert.equal(setEnvKeyIfEmpty("A=1\r", "K", "v"), "A=1\r\nK=v\r\n", "a CR at the very end is completed, never doubled into a lone CR");
	assert.equal(setEnvKey("A=1\r\n", "K", "v"), "A=1\r\nK=v\r\n");
	assert.equal(setEnvKeyIfEmpty("A=1\nB=2", "K", "v"), "A=1\nB=2\nK=v\n", "an LF file stays LF");
	assert.equal(setEnvKeyIfEmpty("", "K", "v"), "K=v\n");
});

test("systemdReading is systemd's own stored value: trailing blanks of an unquoted value dropped, a quoted one's kept (#447 gate round 3)", () => {
	// Pinned beside the port (test/helpers/systemd-env-parse.mjs), which the measured table pins to systemd 259.
	const text = 'K=a  \t\nL="b  "  \nM=c\\  \nN=\nexport P=1\nQ =x\n';
	assert.deepEqual(["K", "L", "M", "N", "P", "Q"].map((k) => systemdReading(text, k)?.value), ["a", "b  ", "c ", "", undefined, "x"]);
	assert.equal(systemdReading("K=1\nK=2\n", "K").line, 2, "the last assignment");
});

test("a backslash before CRLF continues nothing, for systemd or a shell, and the writer reads the next line as a line (#447 gate round 4)", () => {
	// The diff reviewer's repro: sh, bash, dash and zsh read `mine` before and a NEW secret after (the backslash quotes
	// only the CR), and systemd measured the same (q-cont-crlf). Taking it for a continuation hid the real line.
	const text = "K=x\\\r\nWEBHOOK_SECRET=mine\r\n";
	for (const loader of ["systemd", "shell"]) assert.deepEqual(envFileValueLines(text, { loader }), [false, false, false], loader);
	assert.equal(envFileHazard(text, { loader: "systemd" }), null);
	// To the shell loader any CRLF file is a hazard since the round-cap review (every value it reads keeps a CR), so the
	// macOS writer refuses to WRITE into one; a key already set is still left alone, below.
	assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: 1, shape: "shell-crlf" });
	const dir = tempDir("pi-dispatch-env-crlf-bs-");
	const path = join(dir, ".env");
	writeFileSync(path, text);
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, false);
	assert.equal(readFileSync(path, "utf8"), text);
	// On macOS the file is CRLF, a shell hazard refused by name before any scan calls the key set (round-cap review).
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /line 1 has a carriage return \(CR\) at its end, a CRLF line ending/);
	assert.equal(readFileSync(path, "utf8"), text);
	// An LF backslash still is one, for both.
	assert.deepEqual(envFileValueLines("K=x\\\nWEBHOOK_SECRET=mine\n", { loader: "shell" }), [false, true, false]);
	// Nor does the shell's logical-line join run across it: ` WEBHOOK_SECRET=abc` below a CRLF backslash is a line, and
	// the file's only hazard is its CRLF on line 1, not a join into line 2.
	assert.deepEqual(envFileHazard("X=a\\\r\n WEBHOOK_SECRET=abc\r\n", { loader: "shell" }), { line: 1, shape: "shell-crlf" });
});

test("on a shell-loaded platform, a file with a shell hazard is not edited: the key may already be set where no line scan sees it (#447 gate round 4)", () => {
	// Measured in sh/bash/dash/zsh (gate461-adv r4): each of these sets WEBHOOK_SECRET=abc, and appending a new secret
	// replaced it for the wrapper that sources the file.
	const dir = tempDir("pi-dispatch-env-shell-hazard-");
	const path = join(dir, ".env");
	for (const text of ["X=1 WEBHOOK_SECRET=abc\n", "X=a\\\n WEBHOOK_SECRET=abc\n", "X=a\\\n;WEBHOOK_SECRET=abc\n"]) {
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /refusing to edit .*: line \d is one the wrapper that sources this file reads differently from this command .* Fix that line first\. Nothing was written/, JSON.stringify(text));
		assert.equal(readFileSync(path, "utf8"), text);
	}
	// n06, a CRLF continuation-looking line: no continuation, but a CRLF file, which the macOS wrapper reads with a CR on
	// every value, so it is refused by name rather than reported set (round-cap review).
	writeFileSync(path, "A=1\r\nX=a\\\r\nWEBHOOK_SECRET=abc\r\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /line 1 has a carriage return \(CR\) at its end, a CRLF line ending/);
	// A file with no shell hazard is edited as ever.
	writeFileSync(path, "A=1\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }).changed, true);
});

test("on Linux, a key only a shell reads as set is refused by name, not reported set (#447 gate round 4)", () => {
	// systemd drops `export WEBHOOK_SECRET=abc` (its key is `export WEBHOOK_SECRET`), so the service has no secret.
	const dir = tempDir("pi-dispatch-env-export-");
	const path = join(dir, ".env");
	writeFileSync(path, "A=1\nexport WEBHOOK_SECRET=abc\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /^Error: refusing to edit .*: WEBHOOK_SECRET is set only for a shell \(line 2: export WEBHOOK_SECRET=\.\.\.\); systemd's EnvironmentFile= ignores that line, so the service has no WEBHOOK_SECRET\. Write it as WEBHOOK_SECRET=\.\.\. on a line of its own\. Nothing was written$/);
	assert.equal(readFileSync(path, "utf8"), "A=1\nexport WEBHOOK_SECRET=abc\n", "and the secret is never echoed");
	// The macOS wrapper sources the file, so there it IS set, and left alone.
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }).changed, false);
	// And a key systemd does read stays "already set" on Linux.
	writeFileSync(path, "WEBHOOK_SECRET =abc\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, false);
});

test("a key line inside a quoted value is not a set key, for either loader: the key is appended and written (#447 gate round 4)", () => {
	// Pins keyAlreadySet's inside-a-value guard and the `all` half of valueLines: every loader reads line 2 as K's value.
	const text = 'K="a\nWEBHOOK_SECRET=inside\n"\n';
	assert.equal(setEnvKeyIfEmpty(text, "WEBHOOK_SECRET", "new"), `${text}WEBHOOK_SECRET=new\n`);
	const dir = tempDir("pi-dispatch-env-inside-");
	const path = join(dir, ".env");
	for (const platform of ["darwin", "linux"]) {
		writeFileSync(path, text);
		assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform }).changed, true, platform);
		assert.equal(readFileSync(path, "utf8"), `${text}WEBHOOK_SECRET=new\n`);
	}
});

/**
 * What a shell IS, probed rather than assumed: "bash3", "bash5" and so on (its BASH_VERSION's major), "dash" (its path
 * resolves to dash), or "other". /bin/sh is bash 3.2 on macOS and dash on the ubuntu CI runner, and two oracle rows
 * written as "/bin/sh" encoded the first while CI ran the second (a `$[` row and the NUL row failed there on every head
 * since 8dc943a). The version matters too, measured: bash 3.2 stops reading a file at a NUL, bash 5.2 (ubuntu 24.04,
 * under --posix) drops the byte and reads on, as dash does. A row measured on one shell is asserted only against a
 * shell of that kind; a row that holds for every POSIX shell stays unconditional, and the module's own assertions
 * never depend on this.
 */
function shellKind(path, flags = []) {
	if (!existsSync(path)) return null;
	const r = spawnSync(path, [...flags, "-c", 'printf %s "${BASH_VERSION-}"'], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
	if (r.stdout !== "") return `bash${r.stdout.split(".")[0]}`;
	let real = path;
	try {
		real = realpathSync(path);
	} catch {
		// keep the path as given
	}
	return /(^|\/)dash$/.test(real) ? "dash" : "other";
}

/** What `/bin/sh` reads for `key` after sourcing `text` the way the macOS wrapper does, or null when there is no /bin/sh. */
function shReads(text, key) {
	if (!existsSync("/bin/sh")) return null;
	const dir = tempDir("pi-dispatch-env-sh-");
	writeFileSync(join(dir, ".env"), text);
	const r = spawnSync("/bin/sh", ["-c", `set -a; . ./.env >/dev/null 2>&1; printf '%s' "\${${key}-__UNSET__}"`], { cwd: dir, encoding: "latin1", timeout: 20_000, killSignal: "SIGKILL" });
	return r.stdout;
}

test("a shell command is judged through its quoted newlines, so a second assignment after a multi-line quote closes is a hazard (#447 final review)", () => {
	// The final reviewer's repros, measured in /bin/sh on macOS: each sets the key on the line the quote closes on (or on
	// the continuation after it), which no line scan sees. The writer appended a new secret over it, and the venue
	// reader answered `{ keys: {} }` about a PI_EGRESS=0 the wrapper sets.
	const clobbered = ['K="y\nK="a\\\nX=a WEBHOOK_SECRET=two\n', 'K="y\n" WEBHOOK_SECRET=two\n', "K='y\n' WEBHOOK_SECRET=two\n"];
	const dir = tempDir("pi-dispatch-env-quote-close-");
	const path = join(dir, ".env");
	for (const text of clobbered) {
		const measured = shReads(text, "WEBHOOK_SECRET");
		if (measured !== null) assert.equal(measured, "two", `the oracle: ${JSON.stringify(text)}`);
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: 1 }, JSON.stringify(text));
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /refusing to edit .*: line 1 is one the wrapper that sources this file reads differently from this command .* Nothing was written/, JSON.stringify(text));
		assert.equal(readFileSync(path, "utf8"), text);
		const venue = text.replace("WEBHOOK_SECRET=two", "PI_EGRESS=0");
		if (measured !== null) assert.equal(shReads(venue, "PI_EGRESS"), "0", `the oracle: ${JSON.stringify(venue)}`);
		assert.match(readStackKeys(venue, { loader: "shell" }).error ?? "", /line 1 is one this command cannot read .* the file names PI_EGRESS/, JSON.stringify(venue));
	}
	// A multi-line quoted value that is ONE assignment is no hazard: the documented key reads, and the line below it is
	// filled in place.
	const pem = 'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIabc+/=\n-----END RSA PRIVATE KEY-----"\nWEBHOOK_SECRET=\n';
	assert.equal(envFileHazard(pem, { loader: "shell" }), null);
	writeFileSync(path, pem);
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }).changed, true);
	assert.equal(readFileSync(path, "utf8"), pem.replace("WEBHOOK_SECRET=\n", "WEBHOOK_SECRET=new\n"));
	// The join carries the blank before a backslash: `X=a \` + `#'` is `X=a #'` to sh, a comment, so the quote never
	// opens and line 3 is a line (sh reads "" before and `new` after).
	const blank = "X=a \\\n#'\nWEBHOOK_SECRET=\n";
	if (shReads(blank, "WEBHOOK_SECRET") !== null) assert.equal(shReads(blank, "WEBHOOK_SECRET"), "", "the oracle");
	assert.deepEqual(envFileValueLines(blank, { loader: "shell" }), [false, true, false, false]);
	assert.equal(envFileHazard(blank, { loader: "shell" }), null);
});

test("a CRLF file: Linux reads back the line systemd takes, and macOS refuses to write into it, naming the fix (#447 final and round-cap reviews)", () => {
	// Two empty lines for one key: the writer fills the FIRST and every loader takes the LAST. On Linux the read-back
	// compares the value of that line and refuses. On macOS the wrapper also keeps each line's CR (/bin/sh reads `\r`
	// here, and `new\r` for a written `new`), so no key written into a CRLF file reads as written: refused before the
	// edit, with the fix, whatever the file holds.
	const dir = tempDir("pi-dispatch-env-crlf-dup-");
	const path = join(dir, ".env");
	const dup = "WEBHOOK_SECRET=\r\nWEBHOOK_SECRET=\r\n";
	if (shReads(dup, "WEBHOOK_SECRET") !== null) assert.equal(shReads(dup, "WEBHOOK_SECRET"), "\r", "the oracle");
	if (shReads("WEBHOOK_SECRET=new\r\n", "WEBHOOK_SECRET") !== null) assert.equal(shReads("WEBHOOK_SECRET=new\r\n", "WEBHOOK_SECRET"), "new\r", "the oracle");
	writeFileSync(path, dup);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /refusing to edit .*: after the edit, systemd's EnvironmentFile= would read something other than what was written for WEBHOOK_SECRET \(the assignment it takes is on line 2\)\. Nothing was written/);
	assert.equal(readFileSync(path, "utf8"), dup);
	const crlf = /^Error: refusing to edit .*: line 1 has a carriage return \(CR\) at its end, a CRLF line ending, which the wrapper that sources this file on macOS keeps: .*\. To fix it, convert the file to LF line endings\. Nothing was written$/;
	for (const [text, key, overwrite] of [[dup, "WEBHOOK_SECRET", false], ["A=1\r\nWEBHOOK_SECRET=\r\n", "WEBHOOK_SECRET", false], ["K=old\r\n", "K", true]]) {
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, key, "new", { platform: "darwin", overwrite }), crlf, JSON.stringify(text));
		assert.equal(readFileSync(path, "utf8"), text);
	}
	// A CRLF line anywhere counts, the last line without its LF included; converted to LF, the same file is written.
	assert.deepEqual(envFileHazard("A=1\nB=2\r", { loader: "shell" }), { line: 2, shape: "shell-crlf" });
	writeFileSync(path, "A=1\nWEBHOOK_SECRET=\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }).changed, true);
	assert.equal(readFileSync(path, "utf8"), "A=1\nWEBHOOK_SECRET=new\n");
	// Linux and Windows read a CRLF file cleanly (systemd and `for /f` strip the CR): no hazard there.
	assert.equal(envFileHazard(dup, { loader: "systemd" }), null);
	assert.equal(envFileHazard(dup, { loader: "cmd" }), null);
});

test("a shell operator inside quotes is text, as sh reads it; command substitution inside double quotes still runs (#447 final review)", () => {
	// Each row measured in /bin/sh on macOS and re-measured here where it exists. The operator check scanned double
	// quotes as if unquoted, so these lines read as hazards, and a multi-line double-quoted value holding a parenthesis
	// with them (the shell command is judged across its quoted newlines).
	const reads = [
		['K="a;b"', "a;b"],
		['K="(x)"', "(x)"],
		['K="a&b<c>d|e"', "a&b<c>d|e"],
		["K='a|b'", "a|b"],
		['K="a\n(b)\nc"', "a\n(b)\nc"],
		// `\"` does not close the quote, so the `;` after it is still inside; `\$(` is a literal `$(`.
		['K="a\\";b"', 'a";b'],
		['K="\\$(id)"', "$(id)"],
	];
	for (const [line, value] of reads) {
		const text = `${line}\nZ=ok\n`;
		const measured = shReads(text, "K");
		if (measured !== null) assert.equal(measured, value, `the oracle: ${JSON.stringify(line)}`);
		assert.equal(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(line));
		assert.equal(readEnvAssignments(text, ["Z"], { loader: "shell" }).Z.vouched, true, JSON.stringify(line));
	}
	// Plain where every loader agrees, so the reading is the value itself.
	assert.equal(readEnvAssignments('K="a;b"\n', ["K"], { loader: "shell" }).K.value, "a;b");
	// Still hazards: command substitution runs inside double quotes, an unquoted `;` ends the assignment, and a `\\`
	// before the closing quote escapes only the backslash, so the `;` after it is unquoted.
	const runs = [
		['K="$(id)"', /^uid=\d+/],
		["K=\"`id`\"", /^uid=\d+/],
		["K=a;b", /^a$/],
		['K="a\\\\";echo hi', /^a\\$/],
		['K="\\\\$(id)"', /^\\uid=\d+/],
	];
	for (const [line, measuredAs] of runs) {
		const text = `${line}\nZ=ok\n`;
		const measured = shReads(text, "K");
		if (measured !== null) assert.match(measured, measuredAs, `the oracle: ${JSON.stringify(line)}`);
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: 1 }, JSON.stringify(line));
	}
});

/** Each POSIX shell here that sources `text` as the macOS wrapper does, with what it reads for K and WEBHOOK_SECRET. */
function shellsRead(text) {
	const dir = tempDir("pi-dispatch-env-shells-");
	writeFileSync(join(dir, ".env"), text);
	return [["/bin/sh"], ["/bin/bash", "--posix"], ["/bin/dash"]]
		.filter(([sh]) => existsSync(sh))
		.map(([sh, ...flags]) => {
			const r = spawnSync(sh, [...flags, "-c", `set -a; . ./.env; printf '%s\\001%s' "\${K-__UNSET__}" "\${WEBHOOK_SECRET-__UNSET__}"`], { cwd: dir, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/h" }, timeout: 20_000, killSignal: "SIGKILL" });
			const [k, secret] = r.stdout.split("\x01");
			return { sh, kind: shellKind(sh, flags), k, secret, failed: r.status !== 0 || r.stderr !== "", stderr: r.stderr };
		});
}

test("outside single quotes only $NAME and ${NAME} pass, and a backslash-newline inside double quotes is removed first, as sh does (#447 delta review)", () => {
	// Every row measured in /bin/sh (bash 3.2), bash --posix and dash on macOS, and re-measured here where each exists.
	// `effect` is what makes the row dangerous in /bin/sh, the wrapper's own shell, asserted only when /bin/sh here is
	// the kind of shell the row was measured on: "posix" rows hold in bash and dash alike, "bash3" rows were measured on
	// bash 3.2, the macOS /bin/sh (dash reads `$[` as text and rejects `${K:...}` as a bad substitution). The hazard
	// verdict is the module's, always.
	const refused = [
		// A backslash-newline inside double quotes is deleted before expansion, so it cannot split a `$(`, `$((` or `${`.
		['K="${x:-$\\\n((WEBHOOK_SECRET=7))}"', 1, "posix", (r) => r.secret === "7"],
		['K="$\\\n(echo ran)"', 1, "posix", (r) => r.k === "ran"],
		// `$[` arithmetic, evaluated by bash 3.2 (dash reads it as text), directly or through a variable's value.
		["K=$[WEBHOOK_SECRET=5]", 1, "bash3", (r) => r.secret === "5"],
		["X='WEBHOOK_SECRET=9'\nK=$[X]", 2, "bash3", (r) => r.secret === "9"],
		["X='a[$(echo ran >&2)]'\nK=$[X]", 2, "bash3", (r) => r.stderr.includes("ran")],
		// Arithmetic inside `${}`: a substring offset and an array subscript.
		["K=abcdef\nK=${K:WEBHOOK_SECRET=2}", 2, "bash3", (r) => r.secret === "2"],
		["K=${a[WEBHOOK_SECRET=5]}", 1, "bash3", (r) => r.secret === "5"],
		// A bad substitution: an error in bash, and it aborts the whole source under dash.
		['K="${}"', 1, "posix", (r) => r.failed],
		['K="${a b}"', 1, "posix", (r) => r.failed],
	];
	for (const [line, at, measuredOn, effect] of refused) {
		const text = `${line}\n`;
		const sh = shellsRead(text).find((r) => r.sh === "/bin/sh");
		if (sh && (measuredOn === "posix" || sh.kind === measuredOn)) assert.ok(effect(sh), `the oracle: ${JSON.stringify(line)} in /bin/sh (${sh.kind}): ${JSON.stringify(sh)}`);
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: at }, JSON.stringify(line));
	}
	// Refused by the RULE rather than for a measured effect: a positional or special parameter, and a `$` before
	// anything but a name or `{NAME}`, or at the end. Harmless ones are among them, and not telling them apart is the rule.
	for (const line of ["K=$1", 'K="$$"', "K=a$", 'K="$ x"', 'K="${HOME:-/tmp}"']) {
		assert.deepEqual(envFileHazard(`${line}\n`, { loader: "shell" }), { line: 1 }, JSON.stringify(line));
	}
	// The writer refuses the delta reviewer's file, and the venue reader its PI_EGRESS twin (sh sets it to 0).
	const dir = tempDir("pi-dispatch-env-dollar-");
	const path = join(dir, ".env");
	const clobber = 'WEBHOOK_SECRET=\nK="${x:-$\\\n((WEBHOOK_SECRET=7))}"\n';
	writeFileSync(path, clobber);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /refusing to edit .*: line 2 is one the wrapper that sources this file reads differently/);
	assert.equal(readFileSync(path, "utf8"), clobber);
	const venue = 'PI_BACKENDS=podman\nK="$\\\n((PI_EGRESS=0))"\n';
	if (existsSync("/bin/sh")) assert.equal(shReads(venue, "PI_EGRESS"), "0", "the oracle");
	assert.match(readStackKeys(venue, { loader: "shell" }).error ?? "", /line 2 is one this command cannot read/);

	// MUST PASS, read identically by every shell: a plain or braced name, a `$(` inside single quotes, an escaped `\$`,
	// an EVEN backslash run before a newline inside double quotes (the newline stays), and the documented PEM.
	const pem = 'K="-----BEGIN RSA PRIVATE KEY-----\nMIIabc+/=\n-----END RSA PRIVATE KEY-----"';
	for (const [line, value] of [
		["K=$HOME/x", "/h/x"],
		['K="${HOME}/x"', "/h/x"],
		["K='$(id)'", "$(id)"],
		['K="\\$(id)"', "$(id)"],
		['K="a\\\\\nb"', "a\\\nb"],
		['K="a\\\\\\\nb"', "a\\b"],
		[pem, pem.slice(3, -1)],
	]) {
		const text = `${line}\n`;
		for (const r of shellsRead(text)) assert.equal(r.k, value, `the oracle: ${JSON.stringify(line)} in ${r.sh}`);
		assert.equal(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(line));
	}
});

test("a word after an unquoted blank is a command or a second assignment, so it is a shell hazard (#447 round-cap review)", () => {
	// Each row measured in /bin/sh, bash --posix and dash on macOS, and re-measured here where each exists; `effect` is
	// what the wrapper's own /bin/sh does with it. Every one was accepted with no hazard.
	const refused = [
		['WEBHOOK_SECRET=\nK= eval "WEBHOOK_SECRET=7"', 2, (r) => r.secret === "7"],
		['WEBHOOK_SECRET=\nK= export "WEBHOOK_SECRET=7"', 2, (r) => r.secret === "7"],
		["WEBHOOK_SECRET=old\nK= unset WEBHOOK_SECRET", 2, (r) => r.secret === "__UNSET__"],
		["K=1 exit 0\nWEBHOOK_SECRET=old", 1, (r) => r.secret !== "old"],
		["K=1 z", 1, (r) => r.failed && r.k === "__UNSET__"],
		['K="a" z', 1, (r) => r.failed && r.k === "__UNSET__"],
		["K=a\tb", 1, (r) => r.failed && r.k === "__UNSET__"],
		['K="a\n" z', 1, (r) => r.failed && r.k === "__UNSET__"],
		["K=a WEBHOOK_SECRET=two", 1, (r) => r.secret === "two"],
	];
	for (const [lines, at, effect] of refused) {
		const text = `${lines}\n`;
		for (const r of shellsRead(text)) if (r.sh === "/bin/sh") assert.ok(effect(r), `the oracle: ${JSON.stringify(lines)} in /bin/sh: ${JSON.stringify(r)}`);
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: at }, JSON.stringify(lines));
	}
	// The writer and the venue reader refuse the reviewer's files (sh sets PI_EGRESS=0 through the eval).
	const dir = tempDir("pi-dispatch-env-cmdword-");
	const path = join(dir, ".env");
	writeFileSync(path, 'WEBHOOK_SECRET=\nK= eval "WEBHOOK_SECRET=7"\n');
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /refusing to edit .*: line 2 is one the wrapper that sources this file reads differently/);
	const venue = 'PI_BACKENDS=podman\nK= eval "PI_EGRESS=0"\n';
	if (existsSync("/bin/sh")) assert.equal(shReads(venue, "PI_EGRESS"), "0", "the oracle");
	assert.match(readStackKeys(venue, { loader: "shell" }).error ?? "", /line 2 is one this command cannot read/);
	// MUST PASS, read identically by every shell: trailing blanks, a comment after a blank, blanks inside quotes, and an
	// escaped blank, which is part of the word.
	for (const [line, value] of [["K=a   ", "a"], ["K=a # c z", "a"], ["K= # note", ""], ['K="a b"', "a b"], ["K='a\tb'", "a\tb"], ["K=a\\ b", "a b"]]) {
		const text = `${line}\n`;
		for (const r of shellsRead(text)) assert.equal(r.k, value, `the oracle: ${JSON.stringify(line)} in ${r.sh}`);
		assert.equal(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(line));
	}
});

test("a NUL is a shell hazard on its line: the macOS /bin/sh stops reading the file there (#447 round-cap review)", () => {
	// Measured: /bin/sh (bash 3.2) reads K=a and never reaches the line below; dash drops the byte and reads on; a NUL
	// inside a quote aborts the source in /bin/sh. So what the service reads depends on a byte nobody sees.
	// Keyed to each shell's kind: bash 3.2 (the macOS /bin/sh) stops at the NUL; dash and bash 5.2 drop the byte and read
	// on (measured on macOS and on ubuntu 24.04, whose /bin/sh is dash). Either way the reading depends on which shell
	// sources the file, which is the hazard.
	const text = "K=a\0b\nWEBHOOK_SECRET=old\n";
	for (const r of shellsRead(text)) {
		if (r.kind === "bash3") assert.deepEqual([r.k, r.secret], ["a", "__UNSET__"], `the oracle in ${r.sh} (bash 3)`);
		else if (r.kind === "dash" || r.kind === "bash5") assert.deepEqual([r.k, r.secret], ["ab", "old"], `the oracle in ${r.sh} (${r.kind})`);
	}
	for (const [t, at] of [[text, 1], ["A=1\nK='a\0b'\n", 2], ["A=1\n# a\0 note\nB=2\n", 2], ["A='x\ny\0z'\n", 2]]) {
		assert.deepEqual(envFileHazard(t, { loader: "shell" }), { line: at, shape: "shell-nul" }, JSON.stringify(t));
	}
	// The macOS writer refuses before it writes, naming the byte.
	const dir = tempDir("pi-dispatch-env-nul-");
	const path = join(dir, ".env");
	writeFileSync(path, "WEBHOOK_SECRET=\nK=a\0b\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /^Error: refusing to edit .*: line 2 has a NUL byte, and the macOS \/bin\/sh stops reading the file there, so no key below it is set\. To fix it, remove the NUL byte\. Nothing was written$/);
	assert.equal(readFileSync(path, "utf8"), "WEBHOOK_SECRET=\nK=a\0b\n");
	// The venue reader names it too, and a CRLF file with its fix.
	assert.match(readStackKeys("PI_BACKENDS=podman\nK=a\0b\n", { loader: "shell" }).error ?? "", /line 2 has a NUL byte, .* remove the NUL byte$/);
	assert.match(readStackKeys("PI_BACKENDS=podman\r\n", { loader: "shell" }).error ?? "", /line 1 has a carriage return \(CR\) at its end, .* convert the file to LF line endings$/);
	// Also where the key is only named mid-line (no line starts with it), which is the shell's own branch.
	assert.match(readStackKeys("K=a\0b PI_EGRESS=0\n", { loader: "shell" }).error ?? "", /line 1 has a NUL byte, .* and the file names PI_EGRESS, .* remove the NUL byte$/);
	// systemd's own NUL rule is its load hazard, unchanged: its line-level reading has no shell shape.
	assert.equal(envFileHazard("K=a\nB=2\n", { loader: "shell" }), null);
	assert.equal(envFileHazard(text, { loader: "systemd" })?.shape, undefined);
});

test("a hazard file is refused by name before any scan calls the key unchanged or already set (#447 round-cap review)", () => {
	// `K=1 exit 0` ends the source before the key, so /bin/sh never reads WEBHOOK_SECRET=old; the line scan found it set
	// and the writer returned "unchanged", which `up` reports as "already set".
	const dir = tempDir("pi-dispatch-env-hazard-first-");
	const path = join(dir, ".env");
	const exits = "K=1 exit 0\nWEBHOOK_SECRET=old\n";
	const sh = shellsRead(exits).find((r) => r.sh === "/bin/sh");
	if (sh) assert.notEqual(sh.secret, "old", "the oracle: /bin/sh never reaches the key");
	for (const [text, at] of [[exits, 1], ["WEBHOOK_SECRET=old\nK= unset WEBHOOK_SECRET\n", 2]]) {
		writeFileSync(path, text);
		for (const overwrite of [false, true]) {
			assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", overwrite ? "old" : "new", { platform: "darwin", overwrite }), new RegExp(`^Error: refusing to edit .*: line ${at} is one the wrapper that sources this file reads differently`), JSON.stringify(text));
		}
		assert.equal(readFileSync(path, "utf8"), text);
	}
	// systemd the same way. A file it will not load, with the key set in it: "unchanged" before, the NUL now.
	writeFileSync(path, "WEBHOOK_SECRET=abc\nK=a\0b\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /^Error: refusing to edit .*: line 2 has a NUL byte, and systemd refuses to load a file with one anywhere in it/);
	// A lone CR that makes systemd read a second assignment the line scan does not see: "already set on line 2" before,
	// the line systemd splits now.
	writeFileSync(path, "WEBHOOK_SECRET=\n\rWEBHOOK_SECRET=abc\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /^Error: refusing to edit .*: line 2 has a carriage return \(CR\) that is not part of a CRLF line ending/);
	// An EDIT is still judged on its result on Linux: overwriting the one line that held the NUL leaves a file systemd
	// loads, and that is written, as before.
	writeFileSync(path, "PI_BACKENDS=a\0b\n");
	assert.equal(updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux", overwrite: true }).changed, true);
	assert.equal(readFileSync(path, "utf8"), "PI_BACKENDS=podman\n");
	// And a clean file with the key set is still simply unchanged.
	writeFileSync(path, "WEBHOOK_SECRET=abc\n");
	for (const platform of ["linux", "darwin", "win32"]) assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform }).changed, false, platform);
});

test("on macOS ANY line ending in a CR is a shell hazard, a comment line included, so KEY=abc<CR> is never written (#447 regression review)", () => {
	// The regression review's repros: exempting a comment line's CR let these through, and the writer wrote the new line
	// in the file's CRLF ending (`appendEol`, or a replaced `# KEY=` line keeping its CR). /bin/sh then reads `abc<CR>`.
	const written = "WEBHOOK_SECRET=abc123\r\n";
	for (const r of shellsRead(written)) assert.equal(r.secret, "abc123\r", `the oracle in ${r.sh}`);
	const dir = tempDir("pi-dispatch-env-cr-any-");
	const path = join(dir, ".env");
	for (const text of ["# pasted from a Windows editor\r\nPI_X=1\n", "# my deployment\r\n# WEBHOOK_SECRET=\r\n", "# note\r\nWEBHOOK_SECRET=abc\n"]) {
		// Named as a COMMENT line's CR (second regression review): the shells read past it, and the refusal is this
		// command's own, which the sentence says rather than describing a value or a line that runs.
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: 1, shape: "shell-crlf-comment" }, JSON.stringify(text));
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "abc123", { platform: "darwin" }), /^Error: refusing to edit .*: line 1 has a carriage return \(CR\) at the end of a comment line, a CRLF line ending: the wrapper that sources this file on macOS would still read the lines below it, but this command refuses CR line endings there, because a key it writes into the file would take the same ending .*\. To fix it, convert the file to LF line endings\. Nothing was written$/, JSON.stringify(text));
		assert.equal(readFileSync(path, "utf8"), text);
	}
	// The other CR shapes, each named on its own line: a line of only a CR runs it as a command (measured), a `#` line
	// inside a quoted value keeps its CR in the value, and an assignment's CR is in its value.
	const bare = shellsRead("\r\nWEBHOOK_SECRET=abc\n").find((r) => r.sh === "/bin/sh");
	if (bare) assert.ok(bare.failed, "the oracle: a lone CR line runs as a command");
	for (const [text, at] of [["\r\nWEBHOOK_SECRET=abc\n", 1], ["A=1\nWEBHOOK_SECRET=abc\r\n", 2], ["K='a\n# x\r\n'\nWEBHOOK_SECRET=abc\n", 2]]) {
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: at, shape: "shell-crlf" }, JSON.stringify(text));
	}
	assert.deepEqual(envFileHazard("A=1\n  # c\\\r\nB=2\n", { loader: "shell" }), { line: 2, shape: "shell-crlf-comment" }, "an indented comment line");
	// The same file converted to LF is written, and reads as written.
	writeFileSync(path, "# my deployment\n# WEBHOOK_SECRET=\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "abc123", { platform: "darwin" }).changed, true);
	assert.equal(readFileSync(path, "utf8"), "# my deployment\nWEBHOOK_SECRET=abc123\n");
	if (existsSync("/bin/sh")) assert.equal(shReads(readFileSync(path, "utf8"), "WEBHOOK_SECRET"), "abc123", "the oracle");
});

test("a later duplicate's inline comment is read the way the shell reads it, and an unreadable one is \"cannot confirm\" (#447 regression review)", () => {
	// Measured in /bin/sh, bash --posix and dash: each of these reads PI_BACKENDS=podman, so an overwrite to podman has
	// nothing to do. Reading the later line whole made it unplain, and the overwrite was refused as "reads something else".
	const dir = tempDir("pi-dispatch-env-dup-comment-");
	const path = join(dir, ".env");
	for (const text of ["PI_BACKENDS=podman\nPI_BACKENDS=podman # c\n", "PI_BACKENDS=podman\nPI_BACKENDS=podman\t# note\n", 'PI_BACKENDS=podman\nPI_BACKENDS="podman" # c\n', "PI_BACKENDS=podman\nexport PI_BACKENDS=podman # c\n", "PI_BACKENDS=podman\nPI_BACKENDS=podman  \n"]) {
		if (existsSync("/bin/sh")) assert.equal(shReads(text, "PI_BACKENDS"), "podman", `the oracle: ${JSON.stringify(text)}`);
		writeFileSync(path, text);
		assert.equal(updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }).changed, false, JSON.stringify(text));
	}
	// Linux keeps refusing the first: systemd reads `podman # c` (no comment after a value there).
	writeFileSync(path, "PI_BACKENDS=podman\nPI_BACKENDS=podman # c\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux", overwrite: true }), /takes the assignment on line 2, which reads something else/);
	// A different word after the comment is still a different value, and one this module cannot read is said so.
	writeFileSync(path, "PI_BACKENDS=podman\nPI_BACKENDS=docker # c\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }), /takes the assignment on line 2, which reads something else\. Remove one of the two lines/);
	// A blank INSIDE quotes is part of the word: `"pod man"` is a different value, read, not an unreadable one.
	writeFileSync(path, 'PI_BACKENDS=podman\nPI_BACKENDS="pod man" # c\n');
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }), /takes the assignment on line 2, which reads something else\. Remove one of the two lines/);
	writeFileSync(path, "PI_BACKENDS=podman\nPI_BACKENDS=$HOME\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }), /^Error: refusing to edit .*: PI_BACKENDS already reads as asked on line 1, but the wrapper that sources the file takes the assignment on line 2, and this command cannot confirm what line 2 reads\. Write it as a plain PI_BACKENDS=value line, or remove one of the two lines\. Nothing was written$/);
	// A fill reads the word too: an empty value with a comment after it is empty to the shell.
	const emptyCommented = "WEBHOOK_SECRET=old\nexport WEBHOOK_SECRET= # later\n";
	if (existsSync("/bin/sh")) assert.equal(shReads(emptyCommented, "WEBHOOK_SECRET"), "", "the oracle");
	writeFileSync(path, emptyCommented);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /takes the assignment on line 2, which is empty, so the service gets an empty WEBHOOK_SECRET/);
	// ONE line read two ways (docs/sandbox.md's own example): a comment after an empty value is the shell's comment, and
	// systemd's value. Named as that line, not as two.
	const oneLine = "PI_SANDBOX_DIR=                 # default <PI_JOBS_DIR>/sandboxes\n";
	if (existsSync("/bin/sh")) assert.equal(shReads(oneLine, "PI_SANDBOX_DIR"), "", "the oracle");
	writeFileSync(path, oneLine);
	assert.throws(() => updateEnvFile(path, "PI_SANDBOX_DIR", "/srv/sandboxes", { platform: "darwin" }), /^Error: refusing to edit .*: PI_SANDBOX_DIR on line 1 looks set to this command, but the wrapper that sources the file reads it as empty, so the service gets an empty PI_SANDBOX_DIR\. Put the value after the =, or remove the text after it\. Nothing was written$/);
});

test("on Windows an empty last assignment gives the service NO key, and the refusal says so (#447 regression review)", () => {
	// deploy/worker-env-wrapper.cmd runs `set "%%A=%%B"`, and `set "K="` UNSETS K (read from the wrapper, as elsewhere in
	// this file). The `export` line is a variable named `export WEBHOOK_SECRET` there, so the POSIX loaders disagree and
	// the key is not blank to them, which is what reaches this sentence.
	const dir = tempDir("pi-dispatch-env-win-empty-");
	const path = join(dir, ".env");
	writeFileSync(path, "WEBHOOK_SECRET=old\nWEBHOOK_SECRET=\nexport WEBHOOK_SECRET=x\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "win32" }), /^Error: refusing to edit .*: WEBHOOK_SECRET looks set on line 1, but the \.cmd wrapper takes the assignment on line 2, which is empty, so the service gets no WEBHOOK_SECRET\. Remove one of the two lines\. Nothing was written$/);
});

test("\"unchanged\" only when the loader reads it so, and a Linux hazard refusal says the fix (#447 focus review)", () => {
	const dir = tempDir("pi-dispatch-env-noop-");
	const path = join(dir, ".env");
	// Linux, a refusal before "unchanged" now carries the shape's fix, as macOS's does.
	writeFileSync(path, "WEBHOOK_SECRET=abc\nK=a\0b\n");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /^Error: refusing to edit .*: line 2 has a NUL byte, .*\. To fix it, remove the NUL byte\. Nothing was written$/);
	// An EMPTY assignment systemd takes, under a later export only a shell reads: not "already set".
	writeFileSync(path, "WEBHOOK_SECRET=\nexport WEBHOOK_SECRET=old\n");
	assert.equal(systemdReading("WEBHOOK_SECRET=\nexport WEBHOOK_SECRET=old\n", "WEBHOOK_SECRET").value, "");
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }), /^Error: refusing to edit .*: WEBHOOK_SECRET is set only for a shell \(line 2: export WEBHOOK_SECRET=\.\.\.\); systemd's EnvironmentFile= ignores that line, so the service has the empty WEBHOOK_SECRET of line 1\. Write it as WEBHOOK_SECRET=\.\.\. on a line of its own, in place of line 1\. Nothing was written$/);
	assert.equal(readFileSync(path, "utf8"), "WEBHOOK_SECRET=\nexport WEBHOOK_SECRET=old\n", "and the value is never echoed");
	// An overwrite whose FIRST line already reads as asked, while every loader takes the second: not "unchanged".
	for (const platform of ["linux", "darwin", "win32"]) {
		writeFileSync(path, "PI_BACKENDS=podman\nPI_BACKENDS=docker\n");
		assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform, overwrite: true }), /refusing to edit .*: PI_BACKENDS already reads as asked on line 1, but .* takes the assignment on line 2, which reads something else\. Remove one of the two lines\. Nothing was written/, platform);
	}
	if (existsSync("/bin/sh")) assert.equal(shReads("PI_BACKENDS=podman\nPI_BACKENDS=docker\n", "PI_BACKENDS"), "docker", "the oracle");
	// macOS, a fill: a set line above an `export` of nothing, which the shell takes and systemd ignores.
	const exportEmpty = "WEBHOOK_SECRET=old\nexport WEBHOOK_SECRET=\n";
	if (existsSync("/bin/sh")) assert.equal(shReads(exportEmpty, "WEBHOOK_SECRET"), "", "the oracle");
	writeFileSync(path, exportEmpty);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /refusing to edit .*: WEBHOOK_SECRET looks set on line 1, but the wrapper that sources the file takes the assignment on line 2, which is empty, so the service gets an empty WEBHOOK_SECRET\. Remove one of the two lines\. Nothing was written/);
	// NOT when every loader reads it blank: that is `up`'s true EMPTY sentence, and the line stays the operator's (#365).
	for (const text of ['WEBHOOK_SECRET=""\n', "WEBHOOK_SECRET=old\nWEBHOOK_SECRET=\n"]) {
		writeFileSync(path, text);
		for (const platform of ["linux", "darwin"]) assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform }).changed, false, `${platform} ${JSON.stringify(text)}`);
	}
	// And the plain cases, unchanged as ever.
	writeFileSync(path, "WEBHOOK_SECRET=abc\nPI_BACKENDS=podman\n");
	for (const platform of ["linux", "darwin", "win32"]) {
		assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform }).changed, false, platform);
		assert.equal(updateEnvFile(path, "PI_BACKENDS", "podman", { platform, overwrite: true }).changed, false, platform);
	}
	// A 1.1 MB file systemd starts is edited on Linux (the old 1 MiB bound refused it).
	const big = Array.from({ length: 11 }, (_, i) => `K${i}=${"h".repeat(100000)}`).join("\n") + "\nWEBHOOK_SECRET=\n";
	writeFileSync(path, big);
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, true);
});

/** What each POSIX shell here reads for `key` after sourcing `text`, and whether the source failed or printed. */
function shellsReadKey(text, key) {
	const dir = tempDir("pi-dispatch-env-shells-key-");
	writeFileSync(join(dir, ".env"), text);
	return [["/bin/sh"], ["/bin/bash", "--posix"], ["/bin/dash"]]
		.filter(([sh]) => existsSync(sh))
		.map(([sh, ...flags]) => {
			const r = spawnSync(sh, [...flags, "-c", `set -a; . ./.env; printf '%s' "\${${key}-__UNSET__}"`], { cwd: dir, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/h" }, timeout: 20_000, killSignal: "SIGKILL" });
			return { sh, value: r.stdout, failed: r.status !== 0 || r.stderr !== "" };
		});
}

test("an escaped word after a blank is a command word; a continuation, an expansion-only fill and a CR comment line are read as the shells read them (#447 second regression review)", () => {
	const dir = tempDir("pi-dispatch-env-regr2-");
	const path = join(dir, ".env");
	// 1. `\z` after a blank is the word `z`, run (and `\#` the word `#`, which aborts the source in dash), in all three
	// shells. Testing the escape before the blank skipped it, and an overwrite said "unchanged" about a line that runs.
	for (const [text, at] of [["PI_BACKENDS=podman\nPI_BACKENDS=podman \\z\n", 2], ["K= \\z\nWEBHOOK_SECRET=old\n", 1], ["export K= \\#\nWEBHOOK_SECRET=old\n", 1]]) {
		for (const r of shellsReadKey(text, "K")) assert.ok(r.failed, `the oracle: ${JSON.stringify(text)} fails in ${r.sh}`);
		assert.deepEqual(envFileHazard(text, { loader: "shell" }), { line: at }, JSON.stringify(text));
	}
	writeFileSync(path, "PI_BACKENDS=podman\nPI_BACKENDS=podman \\z\n");
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }), /line 2 is one the wrapper that sources this file reads differently/);
	// ...while a backslash-NEWLINE after a blank is joined away first, as the shells do: these read `a` and `podman`.
	for (const [text, key, value] of [["K=a \\\n# c\nWEBHOOK_SECRET=old\n", "K", "a"], ["PI_BACKENDS=podman \\\n\nWEBHOOK_SECRET=old\n", "PI_BACKENDS", "podman"]]) {
		for (const r of shellsReadKey(text, key)) assert.equal(r.value, value, `the oracle: ${JSON.stringify(text)} in ${r.sh}`);
		assert.equal(envFileHazard(text, { loader: "shell" }), null, JSON.stringify(text));
	}
	// 3. A continuation is read on its joined line (`podman \` + an empty line or a comment is `podman`; `pod\` + `man`
	// is `podman`), exact against the shells, where the whole line read as unplain refused the edit.
	for (const [text, verdict] of [["PI_BACKENDS=docker\nPI_BACKENDS=podman \\\n\n", true], ["PI_BACKENDS=docker\nPI_BACKENDS=podman \\\n# c\n", true], ["PI_BACKENDS=podman\nPI_BACKENDS=pod\\\nman\n", false]]) {
		for (const r of shellsReadKey(text, "PI_BACKENDS")) assert.equal(r.value, "podman", `the oracle: ${JSON.stringify(text)} in ${r.sh}`);
		writeFileSync(path, text);
		assert.equal(updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }).changed, verdict, JSON.stringify(text));
		for (const r of shellsReadKey(readFileSync(path, "utf8"), "PI_BACKENDS")) assert.equal(r.value, "podman", `and after the edit, in ${r.sh}`);
	}
	// 2. A fill whose value is only an expansion is empty when the variable is unset at load time, which this command
	// cannot see: refused as unconfirmable, not "unchanged". Literal text around one (`$HOME/logs`) is never empty.
	for (const text of ["WEBHOOK_SECRET=$X\n", 'WEBHOOK_SECRET="${X}"\n']) {
		for (const r of shellsReadKey(text, "WEBHOOK_SECRET")) assert.equal(r.value, "", `the oracle: X unset, ${JSON.stringify(text)} in ${r.sh}`);
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /^Error: refusing to edit .*: WEBHOOK_SECRET on line 1 is only an expansion \(\$NAME\), which the wrapper that sources the file fills in when it loads the file and leaves empty if that variable is unset then, so this command cannot confirm what line 1 reads\. Write the value itself there\. Nothing was written$/, JSON.stringify(text));
	}
	for (const [text, key] of [["WEBHOOK_SECRET='$X'\n", "WEBHOOK_SECRET"], ["PI_LOGS_DIR=$HOME/logs\n", "PI_LOGS_DIR"]]) {
		writeFileSync(path, text);
		assert.equal(updateEnvFile(path, key, "/new", { platform: "darwin" }).changed, false, JSON.stringify(text));
	}
	// Linux has no expansion: systemd reads `$X` as those two characters, so it is set, as before.
	writeFileSync(path, "WEBHOOK_SECRET=$X\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, false);
});

test("an edit never leaves a hazard the file did not have; a CRLF comment line is named only when every CR line is one; a command across `export \\` is read (#447 third regression review)", () => {
	const dir = tempDir("pi-dispatch-env-regr3-");
	const path = join(dir, ".env");
	// 1. Replacing the FIRST line of a command that continues left its tail standing as a line, which every shell runs:
	// the key read back as written while the file now ran a command. Refused before anything is written.
	for (const [text, tail, original] of [['PI_BACKENDS=""\\"\\\na\n', "a", '"a'], ["PI_BACKENDS=\\\n=\n", "=", "="], ["export PI_BACKENDS=\\\n\\ \n", "\\ ", " "]]) {
		for (const r of shellsReadKey(text, "PI_BACKENDS")) assert.deepEqual([r.value, r.failed], [original, false], `the oracle: ${JSON.stringify(text)} in ${r.sh}`);
		const naive = `PI_BACKENDS=podman\n${tail}\n`;
		for (const r of shellsReadKey(naive, "PI_BACKENDS")) assert.ok(r.failed, `the oracle: the naive edit ${JSON.stringify(naive)} runs its tail in ${r.sh}`);
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }), /^Error: refusing to edit .*: after the edit, line 2 would be one the wrapper that sources the file reads differently from this command \(a command, a continuation or an open quote the file did not have before; .*\)\. Put the key's line on one line first\. Nothing was written$/, JSON.stringify(text));
		assert.equal(readFileSync(path, "utf8"), text);
		// systemd ignores a line with no `=`, so on Linux the same edit leaves the service reading podman: written.
		assert.equal(updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "linux", overwrite: true }).changed, true, `linux ${JSON.stringify(text)}`);
		assert.equal(systemdReading(readFileSync(path, "utf8"), "PI_BACKENDS").value, "podman");
	}
	// Only a NEW hazard refuses: the cmd wrapper's `"` in a value the file already had stays as it was (a Windows file
	// is not refused wholesale for a line the edit does not touch, as before).
	assert.deepEqual(envFileHazard('X=a"b\n', { loader: "cmd" }), { line: 1 });
	writeFileSync(path, 'X=a"b\n');
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "win32" }).changed, true);
	assert.equal(readFileSync(path, "utf8"), 'X=a"b\nWEBHOOK_SECRET=new\n');
	// Nor when the edit replaces the first of two such lines, leaving the second first (docs/wait-for.md's snippet).
	writeFileSync(path, 'ticket="a"\nout="b"\n');
	assert.equal(updateEnvFile(path, "ticket", "podman", { platform: "win32", overwrite: true }).changed, true);
	assert.equal(readFileSync(path, "utf8"), 'ticket=podman\nout="b"\n');
	// 3a. `export \` above `PI_BACKENDS=podman` is one command to a shell, which sets the key: read as such.
	const exportCont = "PI_BACKENDS=docker\nexport \\\nPI_BACKENDS=podman\n";
	for (const r of shellsReadKey(exportCont, "PI_BACKENDS")) assert.equal(r.value, "podman", `the oracle in ${r.sh}`);
	writeFileSync(path, exportCont);
	assert.equal(updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }).changed, true);
	for (const r of shellsReadKey(readFileSync(path, "utf8"), "PI_BACKENDS")) assert.equal(r.value, "podman", `and after the edit, in ${r.sh}`);
	// A later line this command cannot read is "cannot confirm", not "something other": `''podman` is podman to the shells.
	const unreadable = "PI_BACKENDS=docker\nPI_BACKENDS=''podman\n";
	for (const r of shellsReadKey(unreadable, "PI_BACKENDS")) assert.equal(r.value, "podman", `the oracle in ${r.sh}`);
	writeFileSync(path, unreadable);
	assert.throws(() => updateEnvFile(path, "PI_BACKENDS", "podman", { platform: "darwin", overwrite: true }), /^Error: refusing to edit .*: after the edit, the wrapper that sources the file would take PI_BACKENDS from line 2, and this command cannot confirm what that line reads\. Write it as a plain PI_BACKENDS=value line, or remove it\. Nothing was written$/);
	// 3b. KEPT as a refusal, and literally true: ` ${X}` on a line of its own is a command, which runs whatever X holds
	// when the wrapper loads the file (measured with X='echo ran'), and does nothing only while X is unset.
	const expansionLine = "WEBHOOK_SECRET=~\n ${X}";
	if (existsSync("/bin/sh")) {
		const d = tempDir("pi-dispatch-env-x-");
		writeFileSync(join(d, ".env"), expansionLine);
		const r = spawnSync("/bin/sh", ["-c", "set -a; . ./.env"], { cwd: d, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/h", X: "echo ran" } });
		assert.equal(r.stdout, "ran\n", "the oracle: the line runs X's value");
	}
	writeFileSync(path, expansionLine);
	assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }), /line 2 is one the wrapper that sources this file reads differently from this command \(a second assignment on a line, a continuation, a command\)/);
	// 2. A comment line's CR is named as such only when EVERY CR line is a comment line; otherwise the first other CR
	// line is, since its value reaches the service with the CR.
	const mixed = "# c\r\nWEBHOOK_SECRET=abc\r\n";
	for (const r of shellsReadKey(mixed, "WEBHOOK_SECRET")) assert.equal(r.value, "abc\r", `the oracle in ${r.sh}`);
	assert.deepEqual(envFileHazard(mixed, { loader: "shell" }), { line: 2, shape: "shell-crlf" });
	assert.deepEqual(envFileHazard("# c\r\n\r\nPI_BACKENDS=docker\n", { loader: "shell" }), { line: 2, shape: "shell-crlf" }, "a lone CR line runs");
	assert.deepEqual(envFileHazard("# c\r\n# d\r\nA=1\n", { loader: "shell" }), { line: 1, shape: "shell-crlf-comment" });
	// A comment CR above a real hazard: the hazard is named, not the comment.
	assert.deepEqual(envFileHazard("# c\r\nK=1 z\n", { loader: "shell" }), { line: 2 });
});

// -- issue #470: on Windows the writer judges the file the way deploy/worker-env-wrapper.cmd reads it ---------------------
//
// `for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"`. Nothing here can run cmd.exe, so each
// row is pinned against the wrapper's documented reading (the table at `cmdReading` says which rows are documented and
// which are cautious refusals), never against a measurement. Every refusal leaves the file byte-identical.

/** The win32 writer's verdict on `text`: "W" plus the written text, "U", or the refusal without its path prefix. */
function win32Verdict(text, key, value, overwrite = false) {
	const dir = tempDir("pi-dispatch-env-470-");
	const path = join(dir, ".env");
	writeFileSync(path, text);
	try {
		const { changed } = updateEnvFile(path, key, value, { platform: "win32", overwrite });
		return changed ? `W ${readFileSync(path, "utf8")}` : "U";
	} catch (err) {
		assert.equal(readFileSync(path, "utf8"), text, `a refusal writes nothing: ${JSON.stringify(text)}`);
		return err.message.replace(/^refusing to edit \S+: /, "");
	}
}

test("#470: a line that names the key other than as a plain KEY= line is refused by name on Windows", () => {
	const rows = [
		// The issue's two shapes. `set` ignores case (DOCUMENTED), so `webhook_secret=` removes the key the writer called set.
		["WEBHOOK_SECRET=old\nwebhook_secret=\n", "line 2 sets webhook_secret, which the .cmd wrapper's set reads as WEBHOOK_SECRET, since Windows variable names ignore case. To fix it, write the name as WEBHOOK_SECRET, or remove the line. Nothing was written"],
		// `delims==` replaces the default space and tab (DOCUMENTED), so the indent stays in the name; what set does with
		// it is not documented, so this is a CAUTIOUS refusal.
		["  WEBHOOK_SECRET=old\n", "line 1 spells WEBHOOK_SECRET with a blank, a quote, a CR or a byte-order mark beside the name, which the .cmd wrapper's for /f keeps as part of the name (it splits only on =), so whether that line sets WEBHOOK_SECRET cannot be confirmed. To fix it, write WEBHOOK_SECRET=value at the very start of the line. Nothing was written"],
		["\ufeffWEBHOOK_SECRET=old\n", "line 1 spells WEBHOOK_SECRET with a blank, a quote, a CR or a byte-order mark beside the name, which the .cmd wrapper's for /f keeps as part of the name (it splits only on =), so whether that line sets WEBHOOK_SECRET cannot be confirmed. To fix it, write WEBHOOK_SECRET=value at the very start of the line. Nothing was written"],
		["WEBHOOK_SECRET =old\n", "line 1 has a blank between WEBHOOK_SECRET and the =, which the .cmd wrapper's set keeps in the name, so the variable that line sets is not WEBHOOK_SECRET. To fix it, remove the blank before the =. Nothing was written"],
		["WEBHOOK_SECRET=old\nWEBHOOK_SECRET\n", 'line 2 is WEBHOOK_SECRET with no =, which the .cmd wrapper reads as set "WEBHOOK_SECRET=", removing WEBHOOK_SECRET. To fix it, write WEBHOOK_SECRET=value, or remove the line. Nothing was written'],
		["=WEBHOOK_SECRET=old\n", "line 1 starts with =, which the .cmd wrapper's for /f skips, so that line sets WEBHOOK_SECRET. To fix it, remove the = at the start of the line. Nothing was written"],
		// File-wide, whatever the key: bytes and names whose reading is not documented (CAUTIOUS).
		["A=1\rWEBHOOK_SECRET=x\n", "line 1 has a carriage return (CR) that is not part of a CRLF line ending, and whether the .cmd wrapper's for /f reads it as a line break is not documented. To fix it, remove the CR, or save the file with CRLF (or LF) line endings. Nothing was written"],
		["A=1\0\nWEBHOOK_SECRET=x\n", "line 1 has a NUL byte, and whether the .cmd wrapper's for /f reads past it is not documented. To fix it, remove the NUL byte. Nothing was written"],
		["A=\x1a\nWEBHOOK_SECRET=x\n", "line 1 has a Ctrl-Z byte (0x1A), which cmd may read as the end of the file. To fix it, remove the byte. Nothing was written"],
		["A!B!=1\nWEBHOOK_SECRET=x\n", "line 1 has a ! before its first =, and with delayed expansion on (the registry's DelayedExpansion value) the .cmd wrapper's set can expand that into another variable's name. To fix it, remove the ! from that line. Nothing was written"],
		["/A WEBHOOK_SECRET=5\n", "line 1 starts with /, which the .cmd wrapper's set might read as its /A or /P switch. To fix it, remove the / at the start of that line. Nothing was written"],
		// A caret in a name is an escape cmd removes on a line delayed expansion touches, and the value's `!` is enough:
		// `WEBHOOK_SECRE^T=evil!` sets WEBHOOK_SECRET then (COMMUNITY, the phase model), so it is refused whatever the key.
		["WEBHOOK_SECRET=old\nWEBHOOK_SECRE^T=evil!\n", "line 2 has a ^ before its first =, which cmd removes as an escape on a line delayed expansion touches (one with a !, the value's included), so the .cmd wrapper's set can read that name as another variable's. To fix it, remove the ^ from that line. Nothing was written"],
		// A line with no = is all name to for /f, and the message says so rather than pointing at an = that is not there.
		["WEBHOOK_SECRET=old\nWEBHOOK_SECRE^T\n", "line 2 has a ^ in its name (the whole line, since it has no =), which cmd removes as an escape on a line delayed expansion touches (one with a !, the value's included), so the .cmd wrapper's set can read that name as another variable's. To fix it, remove the ^ from that line. Nothing was written"],
		["WEBHOOK_SECRET=old\nhi!\n", "line 2 has a ! in its name (the whole line, since it has no =), and with delayed expansion on (the registry's DelayedExpansion value) the .cmd wrapper's set can expand that into another variable's name. To fix it, remove the ! from that line. Nothing was written"],
		["WEBHOOK_SECRET=old\ncaf\u00e9\n", "line 2 has a character outside ASCII in its name (the whole line, since it has no =), and how the .cmd wrapper's set folds the case of such a name (`\u0131` to I, `\u017f` to S) is not documented, so which variable that line sets cannot be confirmed. To fix it, spell the name in ASCII, or remove the line. Nothing was written"],
		["A^B=1\nWEBHOOK_SECRET=old\n", "line 1 has a ^ before its first =, which cmd removes as an escape on a line delayed expansion touches (one with a !, the value's included), so the .cmd wrapper's set can read that name as another variable's. To fix it, remove the ^ from that line. Nothing was written"],
		// A name outside ASCII: how set folds its case is not documented, and Unicode folds `ı` to I and `ſ` to S.
		["WEBHOOK_SECRET=old\nWEBHOOK_\u017fECRET=evil\n", "line 2 has a character outside ASCII before its first =, and how the .cmd wrapper's set folds the case of such a name (`\u0131` to I, `\u017f` to S) is not documented, so which variable that line sets cannot be confirmed. To fix it, spell the name in ASCII, or remove the line. Nothing was written"],
		["P\u0131_BACKENDS=docker\nWEBHOOK_SECRET=old\n", "line 1 has a character outside ASCII before its first =, and how the .cmd wrapper's set folds the case of such a name (`\u0131` to I, `\u017f` to S) is not documented, so which variable that line sets cannot be confirmed. To fix it, spell the name in ASCII, or remove the line. Nothing was written"],
		[`A=${"x".repeat(8184)}\nWEBHOOK_SECRET=x\n`, `line 1 is 8186 bytes long, and the .cmd wrapper's set "..." for it would pass cmd's 8191-character command-line limit. To fix it, shorten that value, or move the large content into a file and put its path in the .env. Nothing was written`],
	];
	for (const [text, message] of rows) {
		assert.equal(win32Verdict(text, "WEBHOOK_SECRET", "NEW"), message, JSON.stringify(text).slice(0, 80));
		// Linux and macOS read these files as they always did: none of this reaches them.
		for (const platform of ["linux", "darwin"]) assert.doesNotMatch(envFileEditCheck(text, "/x/.env", "WEBHOOK_SECRET", "NEW", { platform }) ?? "", /\.cmd wrapper/, platform);
	}
	// A line of 8185 bytes is the longest whose `set "..."` fits 8191 characters.
	assert.equal(win32Verdict(`A=${"x".repeat(8183)}\n`, "WEBHOOK_SECRET", "NEW"), `W A=${"x".repeat(8183)}\nWEBHOOK_SECRET=NEW\n`);
	// The overwrite refuses the same shapes: the wizard's `pi_backends=docker` below the line it replaces would win.
	assert.match(win32Verdict("PI_BACKENDS=docker\npi_backends=docker\n", "PI_BACKENDS", "podman", true), /^line 2 sets pi_backends, which the \.cmd wrapper's set reads as PI_BACKENDS/);
});

test("#470: lines the wrapper reads harmlessly for the key are not refused on Windows", () => {
	const rows = [
		// `eol=#` replaces the default `;` (DOCUMENTED), so `;x=1` is a variable named `;x`; a `#` line is skipped; an
		// indented comment is a variable named `  # WEBHOOK_SECRET`, never the key; blank lines assign nothing.
		["\n;x=1\n# WEBHOOK_SECRET=x\n  # WEBHOOK_SECRET=y\nWEBHOOK_SECRET=old\r\n", "U"],
		// Another key's quote, `%` or operators change only that key's value, never another line (COMMUNITY: FOR variables
		// are substituted after the line is parsed for operators and quotes).
		['X=a"b & set "WEBHOOK_SECRET=evil\nY=100%\n', 'W X=a"b & set "WEBHOOK_SECRET=evil\nY=100%\nWEBHOOK_SECRET=NEW\n'],
		// An indented or case-varied line for ANOTHER key is that key's business.
		["  OTHER=1\nother=2\nWEBHOOK_SECRET=old\n", "U"],
		["WEBHOOK_SECRET=a=b\n", "U"],
		// A BOM before another key's name is set aside before the ASCII rule, as the name rules set it aside; a caret or a
		// character outside ASCII in a VALUE is the value's business, and this is not the key's line.
		["\ufeffOTHER=1\nX=a^b\nY=caf\u00e9\nWEBHOOK_SECRET=old\n", "U"],
	];
	for (const [text, verdict] of rows) assert.equal(win32Verdict(text, "WEBHOOK_SECRET", "NEW"), verdict, JSON.stringify(text));
	// `eol=#` skips the whole line (DOCUMENTED), so a `!` in a comment names nothing.
	assert.equal(win32Verdict("# important! read this\nWEBHOOK_SECRET=old\n", "WEBHOOK_SECRET", "NEW"), "U");
	// A CR at the very end of the file is that line's, not a line break: another key's line is left alone, and the
	// append gives it the CRLF ending it lacked.
	assert.equal(win32Verdict("X=1\r", "WEBHOOK_SECRET", "NEW"), "W X=1\r\nWEBHOOK_SECRET=NEW\r\n");
});

test("#470: the value the wrapper takes for the key must be one it carries, before \"unchanged\" or \"already set\"", () => {
	const shapes = [
		["WEBHOOK_SECRET==old", "an = at the start, which for /f drops with the = after the name"],
		['WEBHOOK_SECRET=a"b', "a double quote"],
		["WEBHOOK_SECRET=100%", "a % (cmd's expansion character)"],
		["WEBHOOK_SECRET=a!b!", "a ! (cmd's delayed-expansion character, on whenever the registry's DelayedExpansion value is set)"],
		["WEBHOOK_SECRET=a^b", "a ^ (cmd's escape character)"],
		["WEBHOOK_SECRET=caf\u00e9", "a character outside ASCII, which cmd reads in the console code page rather than as UTF-8"],
		["WEBHOOK_SECRET=a\x07b", "a control character (U+0007)"],
	];
	for (const [line, what] of shapes) {
		const want = `line 1 is the WEBHOOK_SECRET line the .cmd wrapper takes, and its value has ${what}, so what the service reads cannot be confirmed. To fix it, write that value without it, or give the service WEBHOOK_SECRET through its own environment (pi-dispatch service install --env-setup). Nothing was written`;
		assert.equal(win32Verdict(`${line}\n`, "WEBHOOK_SECRET", "NEW"), want, line);
		// An overwrite that replaces the line is judged on its result instead, which is clean.
		assert.equal(win32Verdict(`${line}\n`, "WEBHOOK_SECRET", "NEW", true), "W WEBHOOK_SECRET=NEW\n", `overwrite ${line}`);
	}
	// Only the line the wrapper TAKES: an earlier one is overwritten by it.
	assert.equal(win32Verdict('WEBHOOK_SECRET=a"b\nWEBHOOK_SECRET=old\n', "WEBHOOK_SECRET", "NEW"), "U");
	// A TAB and a trailing blank are carried by the quoted `set` (COMMUNITY), so a line holding them is set as written.
	assert.equal(win32Verdict("WEBHOOK_SECRET=a\tb \n", "WEBHOOK_SECRET", "NEW"), "U");
	// A CR ending the file on the key's line stays in its value, where it is a line break, not a file-wide hazard.
	assert.match(win32Verdict("WEBHOOK_SECRET=old\r", "WEBHOOK_SECRET", "NEW"), /^line 1 is the WEBHOOK_SECRET line the \.cmd wrapper takes, and its value has a line break, so/);
	// The cmd reader does not repeat such a value back either, where it cannot know it (a `"` and a `%` keep the reading
	// the wrapper's own header describes).
	for (const rest of ["=old", "a!b", "a^b", "caf\u00e9", "a\x07b"]) assert.deepEqual([readEnvAssignments(`K=${rest}\n`, ["K"], { loader: "cmd" }).K.plain, readEnvAssignments(`K=${rest}\n`, ["K"], { loader: "cmd" }).K.value], [false, null], rest);
	for (const rest of ["100%", "a & b", "a b ", "a=b"]) assert.equal(readEnvAssignments(`K=${rest}\n`, ["K"], { loader: "cmd" }).K.value, rest, rest);
});

test("#470: a value the wrapper cannot carry is never written on Windows, and one it can is written bare", () => {
	const refused = [
		['a"b', "a double quote"],
		["100%", "a % (cmd's expansion character)"],
		["a!b", "a ! (cmd's delayed-expansion character, on whenever the registry's DelayedExpansion value is set)"],
		["a^b", "a ^ (cmd's escape character)"],
		["C:/Users/Jos\u00e9/app.pem", "a character outside ASCII, which cmd reads in the console code page rather than as UTF-8"],
		["a\nb", "a line break"],
		["a\rb", "a line break"],
		["a\x1bb", "a control character (U+001B)"],
		["a\x7fb", "a control character (U+007F)"],
		["=abc", "an = at the start, which for /f drops with the = after the name"],
	];
	for (const [value, what] of refused) {
		assert.equal(win32Verdict("PI_BACKENDS=docker\n", "PI_BACKENDS", value, true), `cannot write this value into a .env on Windows: it contains ${what}, and the .cmd wrapper (deploy/worker-env-wrapper.cmd) cannot be shown to read that back as written. Choose a value without it, or give the service this key through its own environment (pi-dispatch service install --env-setup)`, JSON.stringify(value));
	}
	// Carried (COMMUNITY: the phase order makes operators and parentheses text; the quoted `set` keeps blanks and tabs).
	for (const value of ["a & b | c < d > e", "(x)", "C:/Program Files/pi/app.pem", "a\tb", "trailing ", "a=b", "x#y;z", "C:\\pi\\x"]) {
		assert.equal(win32Verdict("PI_BACKENDS=docker\n", "PI_BACKENDS", value, true), `W PI_BACKENDS=${value}\n`, JSON.stringify(value));
	}
	// An empty value REMOVES the key there (`set "K="`, DOCUMENTED), so it is never reported written.
	assert.equal(win32Verdict("PI_BACKENDS=docker\n", "PI_BACKENDS", "", true), "after the edit, the .cmd wrapper would take PI_BACKENDS from line 1, which is empty, and an empty value removes PI_BACKENDS there. Nothing was written");
	// A value whose line would pass cmd's command-line limit is refused on the file it would write.
	assert.equal(win32Verdict("PI_BACKENDS=docker\n", "PI_BACKENDS", "x".repeat(8200), true), `after the edit, line 1 is 8212 bytes long, and the .cmd wrapper's set "..." for it would pass cmd's 8191-character command-line limit. To fix it, shorten that value, or move the large content into a file and put its path in the .env. Nothing was written`);
	// The read-back names the line the wrapper takes when the edit leaves a later one for it: a value it cannot carry, a
	// different value, or an empty one.
	assert.equal(win32Verdict('PI_BACKENDS=docker\nPI_BACKENDS=a"b\n', "PI_BACKENDS", "podman", true), "after the edit, the .cmd wrapper would take PI_BACKENDS from line 2, whose value has a double quote, so what the service reads cannot be confirmed. Nothing was written");
	assert.equal(win32Verdict("PI_BACKENDS=docker\nPI_BACKENDS=docker\n", "PI_BACKENDS", "podman", true), "after the edit, the .cmd wrapper would read PI_BACKENDS as something other than what was written (the assignment it takes is on line 2). Nothing was written");
	assert.equal(win32Verdict("WEBHOOK_SECRET=\r\nWEBHOOK_SECRET=\r\n", "WEBHOOK_SECRET", "NEW"), "after the edit, the .cmd wrapper would take WEBHOOK_SECRET from line 2, which is empty, and an empty value removes WEBHOOK_SECRET there. Nothing was written");
	// Linux and macOS render these as they always did.
	assert.equal(renderEnvValue("a!b", { platform: "linux" }), "'a!b'");
	assert.equal(renderEnvValue("C:/Users/Jos\u00e9", { platform: "darwin" }), "'C:/Users/Jos\u00e9'");
});

// -- issue #470 follow-up: a line assigning one of the service wrapper's own variables is named, never trusted ----------

/**
 * Every variable name a service wrapper's CODE touches, comments removed: assigned (`NAME=`, `read NAME`, `export`,
 * `unset`, `${NAME:=...}`, `set NAME=`, `set "NAME=`, `set /a`/`set /p`, `if defined NAME`) or only read (`$NAME`,
 * `${NAME...}`, `%NAME%`, `!NAME!`). Special and positional parameters and FOR variables are not names.
 */
function wrapperVariables(text, kind) {
	const found = new Set();
	const add = (re, s) => {
		for (const m of s.matchAll(re)) found.add(kind === "cmd" ? m[1].toUpperCase() : m[1]);
	};
	const NAME = "([A-Za-z_][A-Za-z0-9_]*)";
	if (kind === "sh") {
		const code = text.split("\n").filter((l) => !/^[ \t]*#/.test(l)).join("\n");
		add(new RegExp(`(?:^|[;&|({ \\t])${NAME}=`, "gm"), code);
		add(new RegExp(`\\$\\{?#?${NAME}`, "g"), code);
		// Inside `$(( ... ))` a bare identifier is a variable too (`$((retries + 1))`), so every name in one is collected.
		for (const m of code.matchAll(/\$\(\(([^]*?)\)\)/g)) add(new RegExp(NAME, "g"), m[1]);
		add(new RegExp(`\\b(?:read(?:[ \\t]+-r)?|export|unset|local|readonly|getopts[ \\t]+\\S+|for)[ \\t]+${NAME}`, "g"), code);
		return found;
	}
	const code = text.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^[ \t]*(?:@?rem\b|::)/i.test(l)).join("\n");
	add(new RegExp(`\\bset[ \\t]+(?:/[aApP][ \\t]+)?"?${NAME}[ \\t]*=`, "gi"), code);
	add(new RegExp(`%${NAME}(?::[^%]*)?%`, "g"), code);
	add(new RegExp(`!${NAME}(?::[^!]*)?!`, "g"), code);
	add(new RegExp(`\\bif[ \\t]+(?:not[ \\t]+)?defined[ \\t]+${NAME}`, "gi"), code);
	return found;
}

test("#470: WRAPPER_INTERNAL_KEYS is every variable each wrapper assigns or reads for itself, read off the wrappers' text", () => {
	const root = join(import.meta.dirname, "..", "..");
	const sh = readFileSync(join(root, "deploy", "worker-env-wrapper.sh"), "utf8");
	const cmd = readFileSync(join(root, "deploy", "worker-env-wrapper.cmd"), "utf8");
	// The ONE exception each, and why it is not the wrapper's own: PWD (sh) and CD (cmd) are read only on the branch
	// where there is no .env at all, so no line of one can reach them.
	const shNames = wrapperVariables(sh, "sh");
	shNames.delete("PWD");
	assert.deepEqual([...shNames].sort(), [...WRAPPER_INTERNAL_KEYS.shell].sort(), "the sh wrapper's own variables");
	const cmdNames = wrapperVariables(cmd, "cmd");
	cmdNames.delete("CD");
	assert.deepEqual([...cmdNames].sort(), [...WRAPPER_INTERNAL_KEYS.cmd].sort(), "the cmd wrapper's own variables");
	// The scanner sees every form it claims to, so a later wrapper line in one of them cannot slip past it.
	for (const [line, name] of [["x=1", "x"], ["read -r y", "y"], [': "${z:=d}"', "z"], ['echo "$w"', "w"], ["echo ${v#a}", "v"], ["export u", "u"], ["a=1; t=2", "t"], [': $((retries + 1)) "${#tag}"', "retries"], [': $((retries + 1)) "${#tag}"', "tag"], ["n=$((a*b))", "b"]]) {
		assert.ok(wrapperVariables(`${line}\n`, "sh").has(name), `sh: ${line}`);
	}
	assert.equal(wrapperVariables("# q=1 $q\n", "sh").size, 0, "an sh comment names nothing");
	for (const [line, name] of [["set q=1", "Q"], ['set "q=1"', "Q"], ["set /a q=1", "Q"], ["set /p q=prompt", "Q"], ["echo %q%", "Q"], ["echo !q!", "Q"], ["echo %q:~1%", "Q"], ["if defined q echo", "Q"], ["if not defined q echo", "Q"]]) {
		assert.ok(wrapperVariables(`${line}\r\n`, "cmd").has(name), `cmd: ${line}`);
	}
	assert.equal(wrapperVariables("REM set q=1 %q%\n:: %r%\nfor %%A in (x) do set \"%%A=%%B\"\n%*\n%~1\n", "cmd").size, 0, "a comment, a FOR variable and the arguments name nothing");
});

test("#470: the reader names a line assigning a wrapper's own variable, for the loader that has that wrapper", () => {
	const shell = (t) => envFileWrapperInternal(t, { loader: "shell" });
	const cmd = (t) => envFileWrapperInternal(t, { loader: "cmd" });
	assert.deepEqual(shell("A=1\nenv_setup=/x.sh\n"), { line: 2, name: "env_setup" });
	assert.deepEqual(shell("export PI_ENV_SETUP=/x.sh\n"), { line: 1, name: "PI_ENV_SETUP" });
	assert.deepEqual(shell("  signaled=1\n"), { line: 1, name: "signaled" });
	assert.equal(shell("ENV_SETUP=/x\nRC=1\n# env_setup=/x\n"), null, "sh is case-sensitive, and a comment is no assignment");
	assert.equal(shell("NOTE='a\nenv_setup=/x.sh\n'\n"), null, "a line inside a quoted value is no assignment");
	assert.deepEqual(cmd("A=1\r\nenv_setup=C:/x.cmd\r\n"), { line: 2, name: "env_setup" }, "set ignores case");
	assert.deepEqual(cmd("ERRORLEVEL=2\n"), { line: 1, name: "ERRORLEVEL" });
	assert.deepEqual(cmd("  Rc =1\n"), { line: 1, name: "Rc" }, "blanks around the name are set aside");
	assert.equal(cmd("#ENV_SETUP=x\nsignaled=1\nchild=2\n"), null, "the cmd wrapper has no signaled or child");
	assert.equal(envFileWrapperInternal("PI_ENV_SETUP=/x.sh\nenv_setup=1\n", { loader: "systemd" }), null, "systemd runs no wrapper");
});

test("#470: the writer refuses a file assigning a wrapper's own variable on macOS and Windows, and Linux is unchanged", () => {
	const dir = tempDir("pi-dispatch-env-470-internal-");
	const path = join(dir, ".env");
	const tail = "a variable the service wrapper keeps for itself (deploy/worker-env-wrapper.sh on macOS, .cmd on Windows) and assigns again after loading this file, so the line has no effect";
	const fix = "To fix it, remove the line (a setup script is named with pi-dispatch service install --env-setup <path>, never in .env). Nothing was written";
	for (const [platform, text, sentence] of [
		["darwin", "WEBHOOK_SECRET=old\nenv_setup=/x.sh\n", `line 2 assigns env_setup, ${tail}. ${fix}`],
		["darwin", "PI_ENV_SETUP=/x.sh\nWEBHOOK_SECRET=\n", `line 1 assigns PI_ENV_SETUP, ${tail}; PI_ENV_SETUP is never honoured from this file. ${fix}`],
		["win32", "WEBHOOK_SECRET=old\r\nEnv_Setup=C:/x.cmd\r\n", `line 2 assigns Env_Setup, ${tail}. ${fix}`],
		["win32", "ERRORLEVEL=0\nWEBHOOK_SECRET=\n", `line 1 assigns ERRORLEVEL, ${tail}. ${fix}`],
	]) {
		writeFileSync(path, text);
		assert.throws(() => updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform }), (err) => err.message === `refusing to edit ${path}: ${sentence}`, `${platform} ${JSON.stringify(text)}`);
		assert.equal(readFileSync(path, "utf8"), text);
	}
	// Linux runs no wrapper: such a line is an ordinary variable of the service's, and the edit is made.
	writeFileSync(path, "env_setup=/x.sh\nPI_ENV_SETUP=/x.sh\nWEBHOOK_SECRET=\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "linux" }).changed, true);
	// A different case is another variable to sh.
	writeFileSync(path, "ENV_SETUP=/x.sh\nWEBHOOK_SECRET=\n");
	assert.equal(updateEnvFile(path, "WEBHOOK_SECRET", "new", { platform: "darwin" }).changed, true);
});
