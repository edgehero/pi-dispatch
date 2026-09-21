import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readEnvKeys, renderEnvValue, setEnvKey, setEnvKeyIfEmpty, updateEnvFile } from "../src/env-file.mjs";

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

// -- readEnvKeys: the narrow reader doctor uses, and the only thing here that READS a .env -------------

test("readEnvKeys returns only the keys it was asked for, and only real values", () => {
	const text = ["PI_PAUSE_WINDOWS_FILE=/w.json", "WEBHOOK_SECRET=s3cr3t", "# PI_SCOPED_LIMITS_FILE=/commented.json", "PI_LOGS_DIR=", "PI_SETTINGS_FILE=   ", "export PI_JOB_IMAGE=shell-ism", "PI_PAUSE_WINDOWS_FILE=/a-later-duplicate.json"].join("\n");
	assert.deepEqual(readEnvKeys(text, ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_JOB_IMAGE"]), { PI_PAUSE_WINDOWS_FILE: "/a-later-duplicate.json" }, "a commented line, an empty value, a whitespace value and an `export ` prefix are all absent, and the LAST duplicate wins");
	assert.deepEqual(readEnvKeys(text, []), {}, "and an empty ask reads nothing at all");
	assert.deepEqual(readEnvKeys("", ["PI_LOGS_DIR"]), {});
	assert.deepEqual(readEnvKeys(undefined, ["PI_LOGS_DIR"]), {});
});

test("readEnvKeys agrees with the shell about duplicates, including an empty one that cancels a value", () => {
	// Every actual consumer of this file takes the LAST assignment: `set -a; . ./.env` in the wrapper
	// scripts, and systemd's `EnvironmentFile=`. Reading the first instead would let doctor report a value
	// the service never sees and soften a warning about a deployment that really is unconfigured -- and the
	// shape that produces it is not exotic, since appending to a file that already sets a key is how a
	// duplicate appears in the first place.
	const text = ["PI_PAUSE_WINDOWS_FILE=/srv/real.json", "PI_SCOPED_LIMITS_FILE=/srv/limits.json", "PI_PAUSE_WINDOWS_FILE="].join("\n");
	assert.deepEqual(readEnvKeys(text, ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"]), { PI_SCOPED_LIMITS_FILE: "/srv/limits.json" }, "the later empty line is what the service gets, so the key is absent");
});

test("readEnvKeys models one consumer per call, and an export line never cancels a bare one", () => {
	// The hybrid this replaced was wrong in the direction that matters. Letting an export line CANCEL a
	// plain one made `KEY=/systemd.json` followed by `export KEY=/wrapper.json` look like a key systemd
	// does not honour, and the advice that follows -- drop the prefix -- would have changed which file the
	// worker loads. systemd's `EnvironmentFile=` grammar is bare `VAR=VALUE` (measured on 257.13), so an
	// export line is not an assignment there at all.
	const both = "PI_PAUSE_WINDOWS_FILE=/systemd.json\nexport PI_PAUSE_WINDOWS_FILE=/wrapper.json";
	assert.deepEqual(readEnvKeys(both, ["PI_PAUSE_WINDOWS_FILE"]), { PI_PAUSE_WINDOWS_FILE: "/systemd.json" }, "what EnvironmentFile= sees");
	assert.deepEqual(readEnvKeys(both, ["PI_PAUSE_WINDOWS_FILE"], { acceptExport: true }), { PI_PAUSE_WINDOWS_FILE: "/wrapper.json" }, "what `set -a; . ./.env` sees");
	const cleared = "PI_PAUSE_WINDOWS_FILE=/a.json\nexport PI_PAUSE_WINDOWS_FILE=";
	assert.deepEqual(readEnvKeys(cleared, ["PI_PAUSE_WINDOWS_FILE"]), { PI_PAUSE_WINDOWS_FILE: "/a.json" }, "systemd never saw the export line, so nothing cancelled");
	assert.deepEqual(readEnvKeys(cleared, ["PI_PAUSE_WINDOWS_FILE"], { acceptExport: true }), {}, "the wrapper did, and an empty assignment cancels");
});

test("readEnvKeys strips a trailing comment before deciding a quoted value is empty", () => {
	// `KEY="" # cleared while debugging` kept the two quote characters, read as non-empty, and softened a
	// warning about a deployment where both the shells and systemd see an empty value.
	assert.deepEqual(readEnvKeys('K=""   # cleared while debugging', ["K"]), {});
	assert.deepEqual(readEnvKeys("K='/srv/a b.json'   # a note", ["K"]), { K: "/srv/a b.json" });
	assert.deepEqual(readEnvKeys('K="/srv/x # y"', ["K"]), { K: "/srv/x # y" }, "and a hash INSIDE the quotes is still part of the value");
});

test("readEnvKeys reads a value back exactly as the shell does, quotes and comments included", () => {
	// Measured in sh, bash and zsh against every shape below, and the quoted rows were measured too rather
	// than reasoned about, which is where an earlier version of this table was wrong: it kept the quote
	// characters in the value, which no shell does. One matched surrounding pair comes off, and it comes
	// off BEFORE the empty test, or `KEY=""` reads as set while every consumer sets the key to nothing.
	const text = ["A=/a/path   # some comment", "B=/b/path\t# tab before the hash", "C=/c/pa#th", "D=value#", 'E="/e/path   # not a comment"', "F='/f/path # also not'", 'G=""', "H='   '"].join("\n");
	assert.deepEqual(readEnvKeys(text, ["A", "B", "C", "D", "E", "F", "G", "H"]), {
		A: "/a/path",
		B: "/b/path",
		C: "/c/pa#th",
		D: "value#",
		E: "/e/path   # not a comment",
		F: "/f/path # also not",
		H: "   ",
	});
	assert.ok(!("G" in readEnvKeys(text, ["G"])), "a quoted EMPTY value is empty, and empty is absent");
});

test("renderEnvValue writes what both consumers read back, and refuses what neither can", () => {
	// A deployment folder with a space is ordinary on macOS, whose wrapper sources this file: bare, the
	// shell splits the assignment, the key ends up empty, and the tail RUNS as the service account.
	assert.equal(renderEnvValue("/srv/pi/pause-windows.json"), "/srv/pi/pause-windows.json", "an ordinary path is written bare");
	assert.equal(renderEnvValue("/srv/a b/c.json"), "'/srv/a b/c.json'");
	assert.equal(renderEnvValue("/srv/a #2/c.json"), "'/srv/a #2/c.json'");
	// Single quotes and not double: `"/x$HOME/y"` is EXPANDED by the shell, measured in all three.
	assert.equal(renderEnvValue("/x$HOME/y"), "'/x$HOME/y'");
	assert.throws(() => renderEnvValue("/srv/it's/c.json"), /single quote/, "no rendering is read identically by both consumers, so it is refused rather than escaped");
	assert.throws(() => renderEnvValue("/srv/a\nb"), /newline/);
	// The one character every Windows path contains, and the row that forces the question of WHICH
	// consumer reads the quotes. Bare, all three shells eat the backslashes
	// (`C:\\Users\\op\\logs` comes back `C:Usersoplogs`), so it must be quoted for them.
	assert.equal(renderEnvValue("C:\\pi\\deploy\\logs"), "'C:\\pi\\deploy\\logs'");
	// And `%` is cmd's expansion character, so it is outside the bare set too.
	assert.equal(renderEnvValue("C:/pi/100%/logs"), "'C:/pi/100%/logs'");
});

test("renderEnvValue refuses to quote for the Windows loader, which keeps the quotes", () => {
	// `deploy/worker-env-wrapper.cmd` states this in its own header: "Values MUST be UNQUOTED -- cmd's
	// `set` keeps surrounding quotes as part of the value." A quoted value there is a directory that does
	// not exist, behind a ✓, which is the POSIX defect this rendering exists to prevent, reintroduced on
	// the one platform none of the shell measurements covered.
	assert.equal(renderEnvValue("C:/pi/deploy/logs", { quotable: false }), "C:/pi/deploy/logs", "forward slashes keep a Windows path inside the bare set");
	assert.throws(() => renderEnvValue("C:\\pi\\deploy\\logs", { quotable: false }), /cmd's `set` keeps the quotes/);
	assert.throws(() => renderEnvValue("C:/pi/my deploy/logs", { quotable: false }), /cmd's `set` keeps the quotes/);
});

test("a value that needs quoting round-trips through the writer and back out of the reader", () => {
	const written = setEnvKeyIfEmpty("# PI_PAUSE_WINDOWS_FILE=   # quiet hours\n", "PI_PAUSE_WINDOWS_FILE", "/srv/a b #2/pause-windows.json");
	assert.equal(written, "# PI_PAUSE_WINDOWS_FILE=   # quiet hours\nPI_PAUSE_WINDOWS_FILE='/srv/a b #2/pause-windows.json'\n");
	assert.deepEqual(readEnvKeys(written, ["PI_PAUSE_WINDOWS_FILE"]), { PI_PAUSE_WINDOWS_FILE: "/srv/a b #2/pause-windows.json" });
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
