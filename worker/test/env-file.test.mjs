import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { envKeyIsBlank, readEnvAssignments, renderEnvValue, setEnvKey, setEnvKeyIfEmpty, updateEnvFile } from "../src/env-file.mjs";

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
		name: "a commented line is uncommented BELOW itself, so its documentation survives",
		text: "A=1\n# WEBHOOK_SECRET=\nB=2\n",
		expected: "A=1\n# WEBHOOK_SECRET=\nWEBHOOK_SECRET=s3cr3t\nB=2\n",
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
		name: "a commented line is uncommented BELOW itself when no set line exists",
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

test("E1: an assignment to nothing is a RECORD, absence is undefined, and the last one wins", () => {
	const text = ["PI_PAUSE_WINDOWS_FILE=/w.json", "WEBHOOK_SECRET=s3cr3t", "# PI_SCOPED_LIMITS_FILE=/commented.json", "PI_LOGS_DIR=", "PI_SETTINGS_FILE=   ", "PI_PAUSE_WINDOWS_FILE=/a-later-duplicate.json"].join("\n");
	const r = readEnvAssignments(text, ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_JOB_IMAGE"]);
	assert.deepEqual(r.PI_PAUSE_WINDOWS_FILE, { value: "/a-later-duplicate.json", plain: true, line: 6 }, "every loader takes the LAST assignment, and the line number is the one an operator has to open");
	assert.equal(r.PI_SCOPED_LIMITS_FILE, undefined, "a commented line is not an assignment");
	assert.equal(r.PI_JOB_IMAGE, undefined, "and neither is a key the file never mentions");
	assert.deepEqual(r.PI_LOGS_DIR, { value: "", plain: true, line: 4 }, "`KEY=` is an assignment to nothing, which is NOT absence");
	assert.deepEqual(r.PI_SETTINGS_FILE, { value: "", plain: true, line: 5 }, "and so is `KEY=   `, which every loader here trims");
	// The four empty shapes are one value, because `set -a; . ./.env` exports all four as "" and systemd
	// 252 reads all four as "" (measured). This is the distinction the old reader threw away by deleting
	// the key, and the reason doctor could not tell a scaffolded-but-blank deployment from an unset one.
	for (const shape of ['K=', 'K=""', "K=''", "K=   "]) assert.deepEqual(readEnvAssignments(shape, ["K"]).K, { value: "", plain: true, line: 1 }, shape);
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
	assert.deepEqual(readEnvAssignments(cleared, ["PI_PAUSE_WINDOWS_FILE"]).PI_PAUSE_WINDOWS_FILE, { value: "/a.json", plain: true, line: 1 }, "systemd never saw the export line, so nothing cancelled");
	assert.deepEqual(readEnvAssignments(cleared, ["PI_PAUSE_WINDOWS_FILE"], { loader: "shell" }).PI_PAUSE_WINDOWS_FILE, { value: "", plain: true, line: 2 }, "the wrapper did, and it is an assignment to nothing");
	// `export K=` alone is a line the shells honour and systemd does not, so the two loaders disagree about
	// whether the key is assigned AT ALL -- which is the whole reason a reading is only meaningful beside
	// the loader that produced it.
	assert.equal(readEnvAssignments("export K=", ["K"]).K, undefined, "systemd: no assignment");
	assert.deepEqual(readEnvAssignments("export K=", ["K"], { loader: "shell" }).K, { value: "", plain: true, line: 1 }, "the wrapper: an assignment to nothing");
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
	// Lines that reach past themselves, above and below.
	"OTHER=\"unclosed\nK=/srv/a.json",
	"OTHER=a\\\nK=/srv/a.json",
	"OTHER='a'b'\nK=/srv/a.json",
	"K=/srv/a.json\nunset K",
	"K=/srv/a.json\nOTHER=\"unclosed",
	"if false; then\nK=/srv/a.json\nfi",
	"unset K\nK=/srv/a.json",
	"echo hi\nK=/srv/a.json",
	// Bytes JavaScript's `\s` would trim and no shell does, and the line endings.
	"K=\u00a0/srv/a.json",
	"K=\u000b/srv/a.json",
	"K=\u000c/srv/a.json",
	"K=/srv/a.json\r",
	"\ufeffK=/srv/a.json",
	"\ufeffOTHER=1\nK=/srv/a.json",
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
	assert.ok(ORACLE_CORPUS.length >= 68, `corpus is ${ORACLE_CORPUS.length} shapes`);
	const childValue = (sh) => {
		const r = spawnSync(sh, ["-c", `set -a; . ${JSON.stringify(file)} >/dev/null 2>&1; printenv K`], { cwd: dir, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
		assert.equal(r.error, undefined, `${sh} did not run`);
		// A non-zero exit is `printenv` saying the child never got K, or the sourcing itself refusing the
		// file (dash exits 2 on an unclosed quote). Both mean the same thing here: no value to compare.
		return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
	};
	let compared = 0;
	for (const text of ORACLE_CORPUS) {
		writeFileSync(file, text);
		const reading = readEnvAssignments(text, ["K"], { loader: "shell" });
		for (const sh of shells) {
			const got = childValue(sh);
			if (reading.K === undefined || !reading.K.plain) continue;
			compared += 1;
			assert.equal(got, reading.K.value, `${sh} on ${JSON.stringify(text)}`);
		}
	}
	// Not vacuous: a grammar that called nothing plain would pass every assertion above.
	assert.ok(compared >= 90, `only ${compared} plain readings were checked against a shell`);
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
	assert.equal(readEnvAssignments("OTHER='a'b'\nK=/srv/a.json", ["K"], { loader: "shell" }).K.plain, false, "a key below an unbalanced quote");
	assert.equal(readEnvAssignments("K=/srv/a.json\nunset K", ["K"], { loader: "shell" }).K.plain, false, "a key above a stray command, which systemd ignores and the shells run");
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
		assert.deepEqual(readEnvAssignments(line, ["K"], { loader: "cmd" }).K, { value: v, plain: true, line: 1 }, line);
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
	// A value this file will not vouch for is never called blank: `K= # tbd` is a comment to the shells,
	// leaving K empty, and the five characters ` # tbd` to systemd.
	assert.equal(envKeyIsBlank("K= # tbd", "K"), false, "not plain is not the same as empty");
});

test("E6: the cmd wrapper is a third loader, and it is read from its own source", () => {
	// `for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"`. It splits on the FIRST
	// `=` and takes the rest of the line verbatim: no quoting, no comment, no expansion, no continuation.
	// Read from `deploy/worker-env-wrapper.cmd`, not run on Windows, and that limit is why the readings
	// below are asserted against the wrapper's grammar rather than against a measurement.
	const cmd = (text, key = "K") => readEnvAssignments(text, [key], { loader: "cmd" }).K;
	assert.deepEqual(cmd("K=/srv/a.json"), { value: "/srv/a.json", plain: true, line: 1 });
	assert.deepEqual(cmd('K="/srv/a.json"'), { value: '"/srv/a.json"', plain: true, line: 1 }, "the quotes are part of the value there, which is why renderEnvValue never writes any for win32");
	assert.deepEqual(cmd("K=/srv/a.json   # note"), { value: "/srv/a.json   # note", plain: true, line: 1 }, "`eol=#` skips a line that STARTS with one, and does nothing to a trailing comment");
	assert.deepEqual(cmd("K=C:\\pi\\x"), { value: "C:\\pi\\x", plain: true, line: 1 }, "a backslash is a literal there and an escape everywhere else");
	assert.deepEqual(cmd("K=/a.json\nK=/b.json"), { value: "/b.json", plain: true, line: 2 }, "the last `set` wins, as everywhere else");
	assert.equal(cmd("export K=/srv/a.json"), undefined, "`delims==` makes the variable NAME `export K`, so this key is never assigned");
	// An empty value UNSETS the variable there (`set \"K=\"`), where the POSIX loaders set it to "". The
	// record still reports the assignment, because a caller asking about cmd needs to know the line exists.
	assert.deepEqual(cmd("K="), { value: "", plain: true, line: 1 });
	// No line can reach another one: the poison rule is a shell property, and a per-line loader has none.
	assert.deepEqual(cmd("OTHER='unclosed\nK=/srv/a.json"), { value: "/srv/a.json", plain: true, line: 2 }, "an unbalanced quote above costs nothing here");
	assert.deepEqual(cmd("K=/srv/a.json\nunset K"), { value: "/srv/a.json", plain: true, line: 1 }, "and neither does a stray line below");
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
	assert.deepEqual(readEnvAssignments(written, ["PI_PAUSE_WINDOWS_FILE"]).PI_PAUSE_WINDOWS_FILE, { value: "/srv/a b #2/pause-windows.json", plain: true, line: 2 });
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
