/**
 * Single-key edits to a dotenv-style file, in two disciplines.
 *
 * `setEnvKeyIfEmpty` exists for `pi-dispatch up`, which fills WEBHOOK_SECRET into a scaffolded .env
 * without asking the operator to hand-run `openssl rand -hex 32`. It is init's contract applied to a
 * single key instead of a whole file: init never overwrites an existing file, and this never
 * overwrites an existing VALUE — a key the operator already set is sacrosanct, because a tool that
 * "helpfully" rotates a live webhook secret breaks every configured forge hook at once, silently.
 *
 * `setEnvKey` is the CONSENTED-overwrite sibling, added for `pi-dispatch setup github` (issue #81),
 * whose whole point is replacing values like GITHUB_AUTH_SOURCE=gh with the App credentials the
 * operator just minted and approved line-by-line. The consent lives at the CALLER, never here.
 *
 * Both return the input text UNCHANGED (byte-identical, same object) when there is nothing to do, so
 * callers can compare identity to know nothing happened.
 *
 * Deliberately dependency-free (node:fs only, and only in the thin wrapper): it must stay importable
 * from any future setup command without dragging worker config or queue deps along.
 */
import { chmodSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Pure transform over .env TEXT: set `key` to `value` only where nothing is set yet.
 *
 *   - `KEY=` (empty value, whitespace-only counts)      → that line becomes `KEY=value`, in place
 *   - no set line, but a commented `# KEY=…` line       → the comment becomes `KEY=value`, in place
 *   - no KEY line at all                                → `KEY=value` appended at the end
 *   - `KEY=something` (any non-empty value, anywhere)   → text returned UNCHANGED
 *
 * Every other byte is preserved: lines are only ever replaced whole, CRLF endings survive on the
 * replaced line, and the untouched remainder is never re-serialized. Ambiguity resolves to "do not
 * touch" — a value like `KEY= # tbd` trims to a non-empty string and therefore counts as set, because
 * the cost of wrongly leaving a key alone (operator sets it by hand) is a fraction of the cost of
 * wrongly overwriting one.
 */
/**
 * Replace a commented line with `KEY=value`, KEEPING the original line above it as a comment when it said
 * anything, and dropping it when it did not.
 *
 * WHAT THE KEEPING IS FOR, restated after issue #392 moved the shipped file's documentation (issue #394):
 * a line being replaced may carry the operator's own note -- `# PI_LOGS_DIR=/old   # the NFS one` -- and
 * both transforms replace a line whole, so without this an `up` that fills four commented keys silently
 * deletes four lines of somebody's reference. That is still true of a hand-written `.env`.
 *
 * It is no longer true of `.env.example`, which now documents each key in comment lines ABOVE it and
 * leaves the key's own line bare (`# PI_LOGS_DIR=`). Keeping THAT line preserved nothing and left every
 * `up` deployment carrying four stubs whose only purpose was to carry text they no longer carry. So a bare
 * commented key -- nothing after the `=` but whitespace -- is dropped, and anything else is kept. The
 * documentation above the key is untouched either way: only the key's own line is ever replaced.
 *
 * The obvious alternative, carrying the inline `# ...` onto the new line, was written first and then
 * REJECTED: `deploy/worker.service` feeds this file to systemd through `EnvironmentFile=`, whose parser
 * recognises a comment only at the start of a line, so `PI_LOGS_DIR=/srv/logs   # where records land`
 * sets that variable to the path PLUS the sentence. On this one key that is the difference between the run
 * history landing in the right directory and the worker creating a directory named after a sentence. The
 * wrapper scripts source the file with shell semantics, where the same line is harmless, so the two
 * consumers disagree and the safe shape is the one both read identically: a value with nothing after it.
 *
 * Only a line that was ALREADY a comment is kept. Replacing a set line means replacing a real value, and
 * copying the old one up as a comment would leave a fragment of what was replaced behind, on the path
 * whose own docblock warns it will happily overwrite a live credential.
 */
/** A commented key that says nothing: `# KEY=`, with only whitespace after the `=` and no inline note. */
const BARE_COMMENTED_KEY = /^[ \t]*#[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=[ \t]*$/;

function replacementLines(key, value, bare, wasComment, opts) {
	const rendered = renderEnvValue(value, opts);
	const keep = wasComment && !BARE_COMMENTED_KEY.test(bare);
	return keep ? [bare, `${key}=${rendered}`] : [`${key}=${rendered}`];
}

/**
 * A value rendered so that BOTH consumers of this file read back exactly what was written.
 *
 * Measured rather than assumed, in `/bin/sh`, `/bin/bash` and `/bin/zsh` through the same
 * `set -a; . ./.env; set +a` the wrapper scripts use:
 *
 *   - bare `KEY=/a b/c.json`   -> the shell splits at the space, the key ends up EMPTY, and the tail is
 *     RUN as a command by the service account. A deployment folder with a space in its name is ordinary
 *     on macOS, which is exactly the platform whose wrapper sources this file.
 *   - bare `KEY=/a #2/c.json`  -> truncated at the `#`, and a path that does not exist is written with a ✓.
 *   - `KEY="/x$HOME/y"`        -> the shell EXPANDS `$HOME`; double quotes are not enough.
 *   - `KEY='/x$HOME/y'`        -> exact, in all three, and systemd's `EnvironmentFile=` parser has a
 *     single-quote state too.
 *
 * So anything outside a conservative unquoted set is single-quoted. A value containing a single quote is
 * REFUSED rather than escaped: the shells want `'\''` and systemd's parser does not understand it, so no
 * one rendering is read identically by both, and inventing one would be the kind of cleverness that ships
 * a path nobody can read back.
 */
const UNQUOTED_SAFE = /^[A-Za-z0-9_@+=:,./-]*$/;

/**
 * cmd's own bare set, derived from `deploy/worker-env-wrapper.cmd` rather than borrowed from the POSIX
 * one, which is a distinction this got wrong once. That loader is
 * `for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"`, the QUOTED `set` form,
 * which preserves spaces exactly. So a space is fine there and `C:\Program Files\...` needs no quoting,
 * while the POSIX predicate would have refused all four keys on the commonest Windows layout there is.
 *
 * What cmd cannot be shown to carry is `cmdValueRefusal`'s list (issue #470): a line break or another control
 * character, a `"`, a `%`, a `!`, a `^`, a character outside ASCII, and an `=` at the start of the value. Each
 * row there says whether it is cmd's documented behaviour or a cautious refusal. `'` is ordinary there.
 */
export function renderEnvValue(value, { platform = process.platform } = {}) {
	const v = String(value);
	// The Windows loader keeps surrounding quotes as part of the value ("Values MUST be UNQUOTED", its own
	// header), so nothing is ever quoted for it: a value it can take is written bare, and one it cannot is
	// refused rather than dressed in quotes that become part of a path.
	if (platform === "win32") {
		const bad = cmdValueRefusal(v);
		if (bad !== null) throw new Error(`cannot write this value into a .env on Windows: it contains ${bad}, and the .cmd wrapper (deploy/worker-env-wrapper.cmd) cannot be shown to read that back as written. Choose a value without it, or give the service this key through its own environment (pi-dispatch service install --env-setup)`);
		return v;
	}
	if (UNQUOTED_SAFE.test(v)) return v;
	if (v.includes("'") || /[\n\r]/.test(v)) throw new Error(`cannot write this value into a .env safely: ${v.includes("'") ? "it contains a single quote" : "it contains a newline"}`);
	return `'${v}'`;
}

/**
 * HOW THE WINDOWS WRAPPER READS THIS FILE, and what the writer refuses there (issue #470). The loader is one line of
 * `deploy/worker-env-wrapper.cmd`, run under a bare `setlocal`:
 *
 *     for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
 *
 * Nobody can run cmd.exe where this is tested, so every row is either DOCUMENTED (Microsoft's `for /?`, `set /?` and
 * `cmd /?` texts), COMMUNITY (the batch parser's phase model and set's quote handling, as the long-standing write-ups
 * of cmd's parser record them, not Microsoft), or CAUTIOUS: behaviour this command cannot confirm, so it is refused by
 * name rather than guessed. A refusal names the line and the character, never the value.
 *
 *   THE LINE (for /f)
 *   `delims==` REPLACES the default space and tab       DOCUMENTED. A name is everything before the first `=`,
 *                                                       its blanks included
 *   `eol=#`: a line whose first character is `#`       DOCUMENTED. Skipped. It replaces the default `;`, so a `;`
 *                                                       line is a variable named `;...`, not a comment
 *   `tokens=1,*`: the value is the rest of the line    DOCUMENTED. `=` inside it survives (base64, API keys)
 *   an empty line                                      skipped, and assigns nothing either way
 *   CRLF                                               COMMUNITY: for /f drops the CR before the LF (relied on
 *                                                       since #447, and CRLF is the platform's own ending)
 *   a CR anywhere else, a NUL, a Ctrl-Z (0x1A)         CAUTIOUS, file-wide: whether for /f ends a line, stops the
 *                                                       file or keeps the byte is not documented, so no line below
 *                                                       can be vouched for
 *   a line whose `set "..."` exceeds 8191 characters   CAUTIOUS, file-wide: 8191 is cmd's documented command-line
 *                                                       limit, and whether it binds after FOR substitution is not
 *
 *   THE NAME (set, for the key being written)
 *   `webhook_secret=` for WEBHOOK_SECRET               DOCUMENTED: Windows variable names ignore case, so the line
 *                                                       assigns (or, empty, removes) the key. REFUSED by name: the
 *                                                       line scan here is case-sensitive, and a Windows line should
 *                                                       spell the key as the service reads it
 *   `WEBHOOK_SECRET` with no `=`                       DOCUMENTED: `set "WEBHOOK_SECRET="` removes the key.
 *                                                       REFUSED by name
 *   `WEBHOOK_SECRET =x` (a blank before the `=`)       COMMUNITY: the name keeps the blank, so the service gets no
 *                                                       WEBHOOK_SECRET. REFUSED by name
 *   `  WEBHOOK_SECRET=x` (indented), a BOM, a `"`       for /f keeps the leading blanks in the name (DOCUMENTED, the
 *   around the name                                    `delims==` row); what `set` makes of them is not, so
 *                                                       CAUTIOUS: REFUSED by name
 *   `=WEBHOOK_SECRET=x` (a leading `=`)                COMMUNITY: for /f skips leading delimiters, so this sets the
 *                                                       key where no line scan sees it. REFUSED by name
 *   a `!` in any name, a name starting with `/`         CAUTIOUS, file-wide: with delayed expansion on (see `!`
 *                                                       below) a name can expand into the key's, and `set` might
 *                                                       read `/A` or `/P` as its switch
 *   `export WEBHOOK_SECRET=x`                          a variable named `export WEBHOOK_SECRET`, so the key is not
 *                                                       set (`noOpMisread` says so)
 *
 *   THE VALUE (the line the wrapper takes for the key, and every value written: `cmdValueRefusal`)
 *   `& | < > ( )`                                      COMMUNITY: FOR variables are substituted AFTER the line is
 *                                                       parsed for operators and quotes, so these are text
 *                                                       (`for %%a in ("a&b") do echo %%~a` prints `a&b`). Carried
 *   a trailing blank                                   COMMUNITY: the quoted `set` keeps it. Carried, as written
 *   `"`                                                COMMUNITY: by the same phase order it cannot end the command,
 *                                                       and `set "..."` keeps the text up to the LAST quote, which
 *                                                       is the wrapper's own. CAUTIOUS all the same: the wrapper's
 *                                                       header forbids quotes, and set's quote rule is not
 *                                                       Microsoft's documentation
 *   `%`                                                COMMUNITY: percent expansion runs before FOR substitution,
 *                                                       so it is text. CAUTIOUS all the same, as it has always been
 *   `!`                                                DOCUMENTED dependence: with delayed expansion on, `!NAME!`
 *                                                       expands and a lone `!` is removed. `cmd /?` documents the
 *                                                       registry's DelayedExpansion value turning it on, and a bare
 *                                                       `setlocal` leaves it as it was. REFUSED
 *   `^`                                                COMMUNITY: an escape only on a line delayed expansion
 *                                                       touches. CAUTIOUS
 *   a character outside ASCII                          CAUTIOUS: for /f decodes the file in the console code page,
 *                                                       not UTF-8, and the wrapper sets none
 *   a control character but TAB                        CAUTIOUS
 *   an `=` at the start of the value (`K==v`)          COMMUNITY: the remainder starts after the run of delimiters,
 *                                                       so the `=` is lost. CAUTIOUS
 *   empty                                              DOCUMENTED: `set "K="` removes K, so the service has no key
 *
 * Linux and macOS never reach any of this: it runs only for the cmd loader (win32).
 */
const CMD_LINE_MAX = 8191;

/** Why a value cannot be shown to reach the service intact through the cmd wrapper, as words, or `null`. */
function cmdValueRefusal(v) {
	if (v.startsWith("=")) return "an = at the start, which for /f drops with the = after the name";
	const c = /[\x00-\x08\x0a-\x1f\x7f"%!^]|[^\x00-\x7f]/u.exec(v)?.[0];
	if (c === undefined) return null;
	if (c === "\n" || c === "\r") return "a line break";
	if (c === '"') return "a double quote";
	if (c === "%") return "a % (cmd's expansion character)";
	if (c === "!") return "a ! (cmd's delayed-expansion character, on whenever the registry's DelayedExpansion value is set)";
	if (c === "^") return "a ^ (cmd's escape character)";
	if (c.codePointAt(0) > 0x7f) return "a character outside ASCII, which cmd reads in the console code page rather than as UTF-8";
	return `a control character (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})`;
}

/**
 * The cmd wrapper's reading of this text for `key` (see the table above): `hazard`, the first line this command
 * cannot vouch for (file-wide, or one that names the key other than as a plain `KEY=` line), as `{ line, what, fix }`;
 * and `taken`, the last plain `KEY=...` line, as `{ line, value }` with the value exactly as the line holds it.
 */
function cmdReading(text, key) {
	const lines = text.split("\n");
	const upper = (s) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());
	const K = upper(key);
	let hazard = null;
	let taken;
	const note = (line, what, fix) => {
		hazard ??= { line, what, fix };
	};
	for (let i = 0; i < lines.length; i++) {
		const last = i === lines.length - 1;
		// The CR of a CRLF ending goes; a CR at the very end of the file stays in the line, where it is a control
		// character in the value if the line is the key's.
		const l = !last && lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		const n = i + 1;
		const inner = last && l.endsWith("\r") ? l.slice(0, -1) : l;
		if (inner.includes("\r")) note(n, "has a carriage return (CR) that is not part of a CRLF line ending, and whether the .cmd wrapper's for /f reads it as a line break is not documented", "remove the CR, or save the file with CRLF (or LF) line endings");
		if (l.includes("\0")) note(n, "has a NUL byte, and whether the .cmd wrapper's for /f reads past it is not documented", "remove the NUL byte");
		if (l.includes("\x1a")) note(n, "has a Ctrl-Z byte (0x1A), which cmd may read as the end of the file", "remove the byte");
		if (Buffer.byteLength(l, "utf8") + 6 > CMD_LINE_MAX) note(n, `is ${Buffer.byteLength(l, "utf8")} bytes long, and the .cmd wrapper's set "..." for it would pass cmd's ${CMD_LINE_MAX}-character command-line limit`, "shorten that value, or move the large content into a file and put its path in the .env");
		const body = l.replace(/^=+/, "");
		if (body === "" || body[0] === "#") continue;
		const eq = body.indexOf("=");
		const name = eq === -1 ? body : body.slice(0, eq);
		if (name.includes("!")) note(n, "has a ! before its first =, and with delayed expansion on (the registry's DelayedExpansion value) the .cmd wrapper's set can expand that into another variable's name", "remove the ! from that line");
		if (/^[ \t"]*\//.test(name)) note(n, "starts with /, which the .cmd wrapper's set might read as its /A or /P switch", "remove the / at the start of that line");
		if (upper(name.replace(/^[ \t\r\ufeff"]+|[ \t\r\ufeff"]+$/g, "")) !== K) continue;
		if (name !== key && upper(name) === K) note(n, `sets ${name}, which the .cmd wrapper's set reads as ${key}, since Windows variable names ignore case`, `write the name as ${key}, or remove the line`);
		else if (/^[A-Za-z0-9_]+[ \t]+$/.test(name)) note(n, `has a blank between ${key} and the =, which the .cmd wrapper's set keeps in the name, so the variable that line sets is not ${key}`, "remove the blank before the =");
		else if (name !== key) note(n, `spells ${key} with a blank, a quote, a CR or a byte-order mark beside the name, which the .cmd wrapper's for /f keeps as part of the name (it splits only on =), so whether that line sets ${key} cannot be confirmed`, `write ${key}=value at the very start of the line`);
		else if (eq === -1) note(n, `is ${key} with no =, which the .cmd wrapper reads as set "${key}=", removing ${key}`, `write ${key}=value, or remove the line`);
		else if (l[0] === "=") note(n, `starts with =, which the .cmd wrapper's for /f skips, so that line sets ${key}`, "remove the = at the start of the line");
		else taken = { line: n, value: body.slice(eq + 1) };
	}
	return { hazard, taken };
}

/** A `cmdReading` hazard as the writer says it: the line, what is there, and the fix. */
function cmdHazardSentence(h) {
	return `line ${h.line} ${h.what}. To fix it, ${h.fix}`;
}

/**
 * Does this text carry a line for `key` whose value is EMPTY for every loader of this file?
 *
 * ONE HELPER because `up` and `doctor` answered it separately and disagreed (issue #365). The reader this
 * replaced returned values only, so a key whose last assignment was empty came back identical to a key the
 * file never mentions, and the one thing both callers need here -- that a LINE EXISTS and its value is
 * blank -- was gone before either of them saw it. Doctor fell through to "is unset, so the worker ignores
 * it" for a file that makes the worker refuse to start, while `up`, reading the same file, said the value
 * is empty. One run, both sentences. `readEnvAssignments` keeps the distinction, and this helper is
 * derived from it rather than deciding the question a second time.
 *
 * WHY BLANK IS NOT UNSET, measured in sh, bash and zsh: `set -a; . ./.env` on a `KEY=` line SETS and
 * EXPORTS `KEY=""` -- it does not leave the key absent. `deploy/worker-env-wrapper.sh` does exactly that,
 * so a blank line reaches the worker as an empty string, `config.mjs` keeps it (`??`, not `||`) for
 * `PI_PAUSE_WINDOWS_FILE` and `PI_SCOPED_LIMITS_FILE`, and the unconditional loader at `start.mjs` throws.
 *
 * BOTH POSIX LOADERS ARE ASKED, so a key that is blank for one and set for another is not blank: a bare
 * `KEY=` with a later `export KEY=/v.json` is empty under `EnvironmentFile=` and configured under the POSIX
 * wrapper, and calling that "blank" would tell half the operators their configured key is empty. A loader
 * that does not see the key at all does not vote, which is what keeps a systemd-only shape from reading as
 * blank because the other loader ignored it. The cmd wrapper is left out for the reason given at the call
 * below, and this header said "EVERY LOADER" for a round while the code asked two of three.
 *
 * `up` IS THE CALLER, and doctor is not: doctor answers the same question per SUBJECT, with the platform's
 * own loader and the vouch beside it, because its answer becomes a refusal rather than a sentence.
 */
export function envKeyIsBlank(text, key) {
	// DERIVED from the reader rather than re-deciding it. The regex pre-check this used to carry existed only
	// because the old reader deleted an empty key, so "no value" and "no line" arrived identical; the reader
	// now returns a record per assignment and the distinction is in it (issue #384).
	// THE TWO POSIX LOADERS, and the omission is deliberate. The cmd wrapper splits on the first `=` and
	// keeps what follows verbatim, so `K=""` is two quote characters to it where systemd and a sourcing shell
	// both read nothing. The CONSEQUENCE is the same either way -- a path named `""` does not exist and the
	// boot refuses on it exactly as an empty one does -- but the word "empty" is only true of the POSIX
	// readings, and this predicate answers a question about emptiness rather than about usability.
	const readings = ["systemd", "shell"].map((loader) => readEnvAssignments(text, [key], { loader })[key]).filter((r) => r !== undefined);
	if (readings.length === 0) return false;
	// `blank`, not `value === ""`, and the difference is every shape this file cannot vouch for. A reading
	// that is not plain carries no value at all, so asking about the value here said "not empty" for a key
	// whose line is visibly empty -- on any CRLF file, and on any file with one stray line in it.
	return readings.every((r) => r.blank);
}

/**
 * Which lines of this `.env` text are part of a value above them for `loader` (inside a multi-line quote or a
 * continuation), as a boolean per LF line. A `#` line there is no comment: to a shell it is part of the joined line, so
 * `X=a\` + `#;PI_EGRESS=0` sets PI_EGRESS (measured in bash, gate round 2).
 */
export function envFileValueLines(text, { loader = "systemd" } = {}) {
	return quoteSpans(String(text ?? "").split("\n"), loader).inside;
}

/**
 * Which of these lines are part of a value above them rather than lines of their own, to ANY loader of the file: inside
 * a multi-line quoted value or a continuation, for systemd or for a sourcing shell (issue #447, gate round 2). The
 * writers never take such a line for the key's, nor a `# KEY=` comment there for a place to write it: replacing a
 * comment inside a quoted value put the key into that value (measured on systemd 259).
 */
function valueLines(lines) {
	const bare = lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	const systemd = quoteSpans(lines, "systemd").inside;
	const shell = quoteSpans(lines, "shell").inside;
	// TWO QUESTIONS, and answering both with "any loader" overwrote an operator's secret (gate round 3). WHERE TO
	// WRITE: never into a line any loader reads as value (`any`). IS THE KEY ALREADY SET: a line counts as set unless
	// EVERY loader reads it as value (`all`), because `NOTE=see "the docs` carries its quote only in a shell, so the
	// WEBHOOK_SECRET line below it is set for systemd, and skipping it appended a new random secret over it.
	return { any: bare.map((_, i) => systemd[i] || shell[i]), all: bare.map((_, i) => systemd[i] && shell[i]) };
}

/** The line ending a line appended to this text gets: CRLF when the file already uses it, LF otherwise (gate round 3). */
function appendEol(text) {
	return /\r\n|\r$/.test(text) ? "\r\n" : "\n";
}

export function setEnvKeyIfEmpty(text, key, value, opts) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `export ` is part of the SET shape here, and that is a never-clobber decision rather than dotenv
	// pedantry: the wrapper scripts source this file with `set -a; . ./.env`, where `export KEY=value` is an
	// ordinary assignment the operator made. Without it the key reads as absent, a second assignment is
	// appended, and the shell takes the LAST one -- so filling four "empty" keys would replace four values
	// the operator set, in one pass, with no prompt. `readEnvAssignments` is deliberately stricter about what
	// it will VOUCH for: there, declining to claim a value costs a fuller warning, where missing one HERE
	// costs the value itself.
	// `[ \t]` and `[^\n]`, never `\s` and `.` (issue #447, gate round 1): `\s` also matches a NBSP, a vertical tab or a
	// form feed, which make the line an assignment no loader takes (systemd drops it as invalid), so this took such a
	// line for the key's and said "already set" about a key nothing sets; `.` stops at a CR, U+2028 or U+2029, so a
	// set value carrying one read as no line at all and a second assignment was appended, clobbering the operator's.
	const setRe = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=([^\\n]*)$`);
	const commentRe = new RegExp(`^[ \\t]*#[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=`);

	const lines = text.split("\n");
	const insideValue = valueLines(lines);
	// Replace a line wholesale, keeping a CRLF file's trailing \r so the file stays one convention, and
	// keeping any inline `# ...` documentation the line carried (see `trailingComment`).
	const replaceLine = (i) => {
		const crlf = lines[i].endsWith("\r") ? "\r" : "";
		const bare = crlf === "" ? lines[i] : lines[i].slice(0, -1);
		lines.splice(i, 1, ...replacementLines(key, value, bare, commentRe.test(bare), opts).map((l) => `${l}${crlf}`));
		return lines.join("\n");
	};

	// Pass 1: set lines. ANY non-empty value anywhere means the key is set — return the input text
	// itself (not a copy) so callers can detect "unchanged" by identity. Otherwise remember the FIRST
	// empty set line; a later commented duplicate must not win over it.
	let firstEmpty = -1;
	for (let i = 0; i < lines.length; i++) {
		if (insideValue.all[i]) continue;
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		const m = line.match(setRe);
		if (!m) continue;
		// Blanks are space and tab, as for every loader here: JS `trim()` also strips a form feed, a NBSP or U+2028, which
		// systemd keeps as the value, so a key set to one read as empty and was overwritten (issue #447, gate round 1).
		if (m[1].replace(/^[ \t]+|[ \t]+$/g, "") !== "") return text;
		if (firstEmpty === -1 && !insideValue.any[i]) firstEmpty = i;
	}
	if (firstEmpty !== -1) return replaceLine(firstEmpty);

	// Pass 2: a commented-out `# KEY=` line (only reachable when no set line exists at all).
	for (let i = 0; i < lines.length; i++) {
		if (insideValue.any[i]) continue;
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (commentRe.test(line)) return replaceLine(i);
	}

	// Pass 3: no trace of the key, so append it at the end, on its own line, in the file's own line ending.
	const eol = appendEol(text);
	const base = text === "" || text.endsWith("\n") ? text : text.endsWith("\r") ? `${text}\n` : `${text}${eol}`;
	return `${base}${key}=${renderEnvValue(value, opts)}${eol}`;
}

/**
 * Pure transform over .env TEXT: set `key` to `value`, REPLACING whatever is there. The overwrite
 * sibling of `setEnvKeyIfEmpty`, with the same line mechanics and the same first-match position rules:
 *
 *   - a set line `KEY=anything` (empty or not, whitespace tolerated)  → becomes `KEY=value`, in place;
 *     the FIRST set line wins over later duplicates and over any commented line
 *   - no set line, but a commented `# KEY=…` line                     → the comment becomes `KEY=value`
 *   - no KEY line at all                                              → `KEY=value` appended at the end
 *   - the first set line is already exactly `KEY=value`               → text returned UNCHANGED
 *     (the input string object itself, so callers detect the no-op by identity, like the sibling)
 *
 * THE CONFIRM GATE LIVES AT THE CALLER. This function is mechanical and will happily replace a live
 * credential; the wizard that calls it shows the exact lines it is about to write and collects an
 * explicit y/N first (github-app-setup.mjs). Nothing in here asks, because a transform that sometimes
 * prompts is untestable and a prompt that sometimes doesn't fire is not a gate. Every other byte is
 * preserved exactly as in the sibling: whole-line replacement only, CRLF survives on the replaced
 * line, the untouched remainder is never re-serialized. A matched line with stray whitespace
 * (`KEY = old`) is normalised to canonical `KEY=value` — it is being rewritten anyway.
 */
export function setEnvKey(text, key, value, opts) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `export ` counts as set here too, for the reason `setEnvKeyIfEmpty` gives.
	const setRe = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=`);
	const commentRe = new RegExp(`^[ \\t]*#[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=`);

	const lines = text.split("\n");
	const insideValue = valueLines(lines);
	let appendOnly = false;
	const replaceLine = (i) => {
		const crlf = lines[i].endsWith("\r") ? "\r" : "";
		const bare = crlf === "" ? lines[i] : lines[i].slice(0, -1);
		lines.splice(i, 1, ...replacementLines(key, value, bare, commentRe.test(bare), opts).map((l) => `${l}${crlf}`));
		return lines.join("\n");
	};

	// Pass 1: the FIRST set line, whatever its value — this is the overwrite discipline. Already
	// exactly `KEY=value` (modulo the CRLF tail) → the input object back, so the wrapper skips the write.
	for (let i = 0; i < lines.length; i++) {
		if (insideValue.all[i]) continue;
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (!setRe.test(line)) continue;
		// A set line some loader reads as value is not a place to write: the new line goes at the end instead, where the
		// read-back in `updateEnvFile` decides whether every reading of it is the value written.
		if (insideValue.any[i]) {
			appendOnly = true;
			break;
		}
		if (line === `${key}=${renderEnvValue(value, opts)}`) return text;
		return replaceLine(i);
	}

	// Pass 2: a commented-out `# KEY=` line (only reachable when no set line exists at all).
	if (!appendOnly) {
		for (let i = 0; i < lines.length; i++) {
			if (insideValue.any[i]) continue;
			const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
			if (commentRe.test(line)) return replaceLine(i);
		}
	}

	// Pass 3: no trace of the key, so append it at the end, on its own line, in the file's own line ending.
	const eol = appendEol(text);
	const base = text === "" || text.endsWith("\n") ? text : text.endsWith("\r") ? `${text}\n` : `${text}${eol}`;
	return `${base}${key}=${renderEnvValue(value, opts)}${eol}`;
}

/**
 * Why this `.env` content cannot be EDITED without changing bytes nobody meant to change, or `null` (issue #447, gate
 * round 1): a file that is not valid UTF-8 decodes with U+FFFD in place of the bad bytes, and writing it back would
 * replace them. Text (a test's seam) has nothing to lose. Exported so a caller about to edit (the setup wizard) can
 * refuse before it runs anything else, under exactly the writer's rule.
 */
export function envFileEditRefusal(content, path) {
	if (typeof content === "string") return null;
	const bad = firstInvalidUtf8(content);
	if (bad === -1) return null;
	let line = 1;
	for (let k = 0; k < bad; k++) if (content[k] === 10) line++;
	return `refusing to edit ${path}: line ${line} (byte ${bad}) is not valid UTF-8, and rewriting the file would replace those bytes. Re-save it as UTF-8, or remove them`;
}

/**
 * Why `next` does not give `key` the value `value` for the platform's loader, or `null`. See `updateEnvFile`.
 *
 * What it asks is whether the written line is SWALLOWED: inside a multi-line quoted value or a continuation for that
 * loader, or (for systemd) in a file systemd splits into lines differently from this module or will not load. The
 * value of the line the loader takes is compared with a clean `KEY=value` line's. For the cmd wrapper a CRLF line's CR
 * is set aside, as its `for /f` strips it; for a sourcing shell it is KEPT, as the shell keeps it, so a CR-ended line
 * never reads as written (on macOS `planEnvEdit` refuses such a file first, and this is the backstop, regression
 * review).
 */
function editedValueRefusal(next, key, value, platform) {
	const loader = loaderFor(platform);
	const where = loaderName(loader);
	if (loader === "systemd") {
		// systemd's OWN reading, from its parser states (`systemdReading`), not the line scan: `KEY =x` below the new line
		// is an assignment to it, and an earlier line-scan read-back missed exactly that (gate round 3).
		const h = envFileLoadHazard(Buffer.from(next, "utf8")) ?? envFileSystemdHazard(next);
		if (h !== null) return systemdHazardSentence(h);
		const want = systemdReading(`${key}=${renderEnvValue(value, { platform })}\n`, key)?.value;
		const got = systemdReading(next, key);
		if (got === undefined || got.value !== want) return `after the edit, ${where} would ${got === undefined ? "find no" : "read something other than what was written for"} ${key}${got === undefined ? "" : ` (the assignment it takes is on line ${got.line})`}`;
		return null;
	}
	// A SHELL is asked by command (third regression review): `export \` above `PI_BACKENDS=podman` is one command,
	// `export PI_BACKENDS=podman`, which sets the key, while a line reading called the second line "part of a
	// continuation" and refused an edit the shells read as written. `lastAssignment` walks the commands the lines
	// start and reads the last one that assigns the key, as the shell takes it.
	if (loader === "shell") {
		const taken = lastAssignment(next, key, loader);
		if (taken === undefined) {
			// Named by its line (third regression review nit): the written line is there, and a command above it
			// swallows it (`PI_BACKENDS=\` at the end of the file, then the appended `WEBHOOK_SECRET=...`).
			const lines = next.split("\n");
			const written = lines.findLastIndex((l) => l.replace(/\r$/, "") === `${key}=${renderEnvValue(value, { platform })}`);
			return written === -1
				? `after the edit, ${where} would find no command that assigns ${key}`
				: `after the edit, ${where} would read line ${written + 1}, where ${key} is written, as part of the command above it, so no command would assign ${key}`;
		}
		const want = readEnvAssignments(`${key}=${renderEnvValue(value, { platform })}\n`, [key], { loader })[key];
		// Unreadable is not DIFFERENT: `PI_BACKENDS=''podman` is `podman` to the shells, and saying the edit would read
		// "something other" was false (third regression review). Said as what it is.
		if (want.plain && !taken.plain) return `after the edit, ${where} would take ${key} from line ${taken.line}, and this command cannot confirm what that line reads. Write it as a plain ${key}=value line, or remove it`;
		if (want.plain && taken.value !== want.value) return `after the edit, ${where} would read ${key} as something other than what was written (the assignment it takes is on line ${taken.line})`;
		return null;
	}
	// The cmd wrapper, by its own reading (issue #470, `cmdReading`): nothing on the edited file it cannot vouch for, and
	// the line it takes for the key holds exactly the value written. An empty one removes the key there, so it is never
	// "written". The line taken is the LAST plain one, with a CRLF line's CR set aside as for /f drops it (the final
	// review of #447: with two empty CRLF lines for the key the first was filled while the loader took the second). This
	// replaced a comparison through `readEnvAssignments`, which read `K==v` as `=v` where for /f reads `v`.
	const { hazard, taken } = cmdReading(next, key);
	if (hazard !== null) return `after the edit, ${cmdHazardSentence(hazard)}`;
	if (taken === undefined) return `after the edit, ${where} would find no ${key} line`;
	const bad = cmdValueRefusal(taken.value);
	if (bad !== null) return `after the edit, ${where} would take ${key} from line ${taken.line}, whose value has ${bad}, so what the service reads cannot be confirmed`;
	if (taken.value === "") return `after the edit, ${where} would take ${key} from line ${taken.line}, which is empty, and an empty value removes ${key} there`;
	if (taken.value !== renderEnvValue(value, { platform })) return `after the edit, ${where} would read ${key} as something other than what was written (the assignment it takes is on line ${taken.line})`;
	return null;
}

/** A systemd hazard as the writer says it: the line and what is there. */
function systemdHazardSentence(h) {
	return `line ${h.line} has ${SYSTEMD_HAZARD_SHAPES[h.shape].what}${h.detail ? ` (${h.detail})` : ""}`;
}

function loaderFor(platform) {
	return platform === "win32" ? "cmd" : platform === "darwin" ? "shell" : "systemd";
}

function loaderName(loader) {
	return loader === "systemd" ? "systemd's EnvironmentFile=" : loader === "shell" ? "the wrapper that sources the file" : "the .cmd wrapper";
}

/**
 * On Linux, a sentence when the line scan finds `key` set but systemd's own reading does not (an `export` line, which
 * systemd drops as an invalid name), naming the line and what to write instead; otherwise `null`.
 *
 * Also when systemd's reading is EMPTY and a LATER `export` line gives the key a value (focus review):
 * `WEBHOOK_SECRET=` above `export WEBHOOK_SECRET=old` is "already set" to the line scan and to a shell, while the
 * service gets an empty WEBHOOK_SECRET. Only a later export line: one above the empty assignment is overridden by it for
 * every loader, which `noOpMisread` says. (Requiring `export` there is an equivalent mutation today, measured: a later
 * plain line with a value is one systemd reads itself, unless a hazard, refused earlier, hides it. It keeps the sentence
 * true: the line named is one only a shell reads.)
 */
function setOnlyForAShell(text, key, platform) {
	if (loaderFor(platform) !== "systemd") return null;
	const reading = systemdReading(text, key);
	if (reading !== undefined && reading.value !== "") return null;
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const setRe = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=([^\\n]*)$`);
	const exportRe = new RegExp(`^[ \\t]*export[ \\t]+${escaped}[ \\t]*=`);
	const lines = text.split("\n");
	for (let i = reading === undefined ? 0 : reading.line; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		const m = line.match(setRe);
		if (m && m[1].replace(/^[ \t]+|[ \t]+$/g, "") !== "" && (reading === undefined || exportRe.test(line))) {
			return `${key} is set only for a shell (line ${i + 1}: ${line.replace(/=.*$/, "=...")}); systemd's EnvironmentFile= ignores that line, so the service has ${reading === undefined ? `no ${key}` : `the empty ${key} of line ${reading.line}`}. Write it as ${key}=... on a line of its own${reading === undefined ? "" : `, in place of line ${reading.line}`}. Nothing was written`;
		}
	}
	return null;
}

/**
 * Why "unchanged" would be FALSE for this text, as a sentence, or `null` (focus review). The line scan's no-op means
 * "some line already sets the key" (fill) or "the first set line is already `KEY=value`" (overwrite); the platform's
 * loader takes the LAST assignment, so `WEBHOOK_SECRET=old` above `WEBHOOK_SECRET=` gives the service an empty key, and
 * `PI_BACKENDS=podman` above `PI_BACKENDS=docker` gives it docker, while the writer said nothing needed doing. Asked
 * of the loader's own reading (systemd's parser on Linux, the last assignment outside a value for a shell or the cmd
 * wrapper). Values are never echoed: the lines are named.
 *
 * NOT for a key every POSIX loader reads as BLANK (`envKeyIsBlank`): that "unchanged" is `up`'s EMPTY sentence, which is
 * true (`KEY=""`, or `KEY=old` above `KEY=`), and the never-clobber rule keeps such a line the operator's (#365).
 */
function noOpMisread(text, key, value, overwrite, platform) {
	if (!overwrite && envKeyIsBlank(text, key)) return null;
	const loader = loaderFor(platform);
	const where = loaderName(loader);
	const rendered = `${key}=${renderEnvValue(value, { platform })}\n`;
	const seen = firstSetLine(text, key, !overwrite);
	const at = seen === null ? "" : ` on line ${seen}`;
	let taken;
	let differs;
	let unconfirmed = false;
	if (loader === "systemd") {
		const r = systemdReading(text, key);
		taken = r?.line;
		differs = r === undefined || (overwrite ? r.value !== systemdReading(rendered, key)?.value : r.value === "");
	} else {
		const r = lastAssignment(text, key, loader);
		taken = r?.line;
		const clean = readEnvAssignments(rendered, [key], { loader })[key];
		// Empty for the cmd wrapper UNSETS the key (`set "K="`), so it is no value either.
		differs = r === undefined || (overwrite ? clean.plain && (!r.plain || r.value !== clean.value) : r.blank || (loader === "cmd" && r.value === ""));
		// A reading this module cannot vouch for is not a DIFFERENT value, only an unknown one: said so (regression review).
		unconfirmed = overwrite && r !== undefined && !r.plain;
		// A fill whose value is nothing but expansions (`WEBHOOK_SECRET=$X`) is empty when those are unset at load time,
		// which the wrapper's environment decides and this command cannot see: "unchanged" would vouch for a value the
		// service may not get (second regression review). Refused as unconfirmable, never as set. One with literal text
		// in it (`PI_LOGS_DIR=$HOME/logs`) is never empty, so it stays set.
		if (!overwrite && r !== undefined && r.expansionOnly) {
			differs = true;
			unconfirmed = true;
		}
	}
	if (!differs) return null;
	if (taken === undefined) return `${key} looks set${at} to this command, but ${where} reads no assignment of it from this file, so the service does not get it. Write it as ${key}=... on a line of its own`;
	if (unconfirmed && !overwrite) return `${key} on line ${taken} is only an expansion ($NAME), which ${where} fills in when it loads the file and leaves empty if that variable is unset then, so this command cannot confirm what line ${taken} reads. Write the value itself there`;
	if (unconfirmed) return `${key} already reads as asked${at}, but ${where} takes the assignment on line ${taken}, and this command cannot confirm what line ${taken} reads. Write it as a plain ${key}=value line, or remove one of the two lines`;
	// The cmd wrapper's `set "K="` UNSETS the key, so there the service gets no key at all, not an empty one.
	const gets = `so the service gets ${loader === "cmd" ? "no" : "an empty"} ${key}`;
	// ONE line, read two ways: `KEY=   # a note` is set to this command's scan and to systemd (which reads the note as
	// the value) and empty to a shell, whose comment it is (regression review, docs/sandbox.md's own example).
	if (!overwrite && seen === taken) return `${key} on line ${taken} looks set to this command, but ${where} reads it as empty, ${gets}. Put the value after the =, or remove the text after it`;
	return overwrite
		? `${key} already reads as asked${at}, but ${where} takes the assignment on line ${taken}, which reads something else. Remove one of the two lines`
		: `${key} looks set${at}, but ${where} takes the assignment on line ${taken}, which is empty, ${gets}. Remove one of the two lines`;
}

/** The first line (1-based) that sets `key` for the line scan, with a non-empty value when `nonEmpty`, or `null`. */
function firstSetLine(text, key, nonEmpty) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const setRe = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=([^\\n]*)$`);
	const lines = text.split("\n");
	const all = valueLines(lines).all;
	for (let i = 0; i < lines.length; i++) {
		if (all[i]) continue;
		const m = lines[i].replace(/\r$/, "").match(setRe);
		if (m && (!nonEmpty || m[1].replace(/^[ \t]+|[ \t]+$/g, "") !== "")) return i + 1;
	}
	return null;
}

/**
 * The last assignment of `key` a shell or the cmd wrapper takes: its line outside any value, read as that loader reads
 * it. For the cmd wrapper, the line alone with its CR set aside (`for /f` strips it). For a shell, the WORD its joined
 * command starts with (`shellCommand`, `shellWord`): on a line with no shell hazard only blanks or a `#` comment may
 * follow that word, so `KEY=podman # c` reads `podman`, and `KEY=podman \` above an empty line reads `podman` too, as
 * sh, bash and dash do (regression reviews). A CR the word runs into stays in it, as the shell keeps it. `expansionOnly`
 * says the word is nothing but `$NAME`/`${NAME}` expansions and quotes, so it is EMPTY whenever those are unset at load
 * time, which this command cannot see.
 */
function lastAssignment(text, key, loader) {
	const lines = text.split("\n");
	const inside = quoteSpans(lines, loader).inside;
	const cr = lines.map((l) => l.endsWith("\r"));
	const bare = lines.map((l, k) => (cr[k] ? l.slice(0, -1) : l));
	for (let i = lines.length - 1; i >= 0; i--) {
		if (inside[i]) continue;
		if (loader !== "shell") {
			const m = ASSIGNMENT.exec(bare[i]);
			if (m === null || m[2] !== key || m[1]) continue;
			const read = readEnvAssignments(`${bare[i]}\n`, [key], { loader })[key];
			return read === undefined ? undefined : { ...read, line: i + 1 };
		}
		// By COMMAND for a shell: the line starts one, and its joined text is what assigns (`export \` + `KEY=v`).
		const { logical, end } = shellCommand(bare, cr, i);
		const m = COMMAND_ASSIGNMENT.exec(logical);
		if (m === null || m[2] !== key) continue;
		const rest = m[3];
		let word = shellWord(rest);
		if (word === rest && cr[end]) word += "\r";
		// A word holding a quoted newline is a multi-line value, which this reads no further than a line: not vouched.
		if (word.includes("\n")) return { value: null, plain: false, vouched: false, blank: false, line: i + 1, expansionOnly: false };
		const read = readEnvAssignments(`${key}=${word}\n`, [key], { loader })[key];
		return { ...read, line: i + 1, expansionOnly: !read.blank && expansionOnly(word) };
	}
	return undefined;
}

/** Whether a shell word is only `$NAME`/`${NAME}` expansions and quotes, so nothing in it is literal text. */
function expansionOnly(word) {
	let q = "";
	for (let i = 0; i < word.length; i++) {
		const c = word[i];
		if (q === "'") {
			if (c === "'") q = "";
			else return false;
		} else if (c === "\\") return false;
		else if (q === '"' && c === '"') q = "";
		else if (q === "" && (c === "'" || c === '"')) q = c;
		else if (c === "$") {
			SIMPLE_EXPANSION.lastIndex = i;
			const m = SIMPLE_EXPANSION.exec(word);
			if (m === null) return false;
			i += m[0].length - 1;
		} else return false;
	}
	return true;
}

/** The text of a shell value up to its first unquoted, unescaped blank (quotes and escapes kept for `readValue`). */
function shellWord(rest) {
	let q = "";
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i];
		if (q === "'") {
			if (c === "'") q = "";
		} else if (c === "\\") i += 1;
		else if (q === '"') {
			if (c === '"') q = "";
		} else if (c === "'" || c === '"') q = c;
		else if (c === " " || c === "\t") return rest.slice(0, i);
	}
	return rest;
}

/**
 * Whether the platform's loader ALREADY reads `key` as set to something non-empty in this text, as a sentence, or
 * `null`. systemd's answer is its own reading (`systemdReading`); the shells' and the cmd wrapper's is the last
 * assignment line that is not inside a value for them.
 */
function keyAlreadySet(text, key, platform) {
	const loader = loaderFor(platform);
	const where = loaderName(loader);
	if (loader === "systemd") {
		const got = systemdReading(text, key);
		return got !== undefined && got.value !== "" ? `${where} already reads ${key} as set on line ${got.line}` : null;
	}
	const got = readEnvAssignments(text, [key], { loader })[key];
	// Blank, or empty under the cmd wrapper, where `set "K="` UNSETS the key: nothing to protect.
	if (got === undefined || got.blank || got.value === "") return null;
	if (quoteSpans(text.split("\n"), loader).inside[got.line - 1]) return null;
	return `${where} already reads ${key} as set on line ${got.line}`;
}

/**
 * The edit `updateEnvFile` would make to this content, WITHOUT writing it: `{ changed: false }`, `{ changed: true, next }`,
 * or `{ error }` with the refusal it would throw. One function for the writer and for a caller that must refuse before
 * it runs anything else (the setup wizard, whose pre-check runs this on the file as it stands, gate round 3), so the
 * two can never apply different rules.
 *
 *   BYTES FIRST (gate round 1): decoding turns a byte that is not UTF-8 (a Latin-1 `\u00e9`, 0xE9) into U+FFFD, and
 *   writing the text back replaced the operator's byte in a line this writer never meant to touch.
 *   NEVER CLOBBER (gate round 3): in fill-if-empty mode a key the platform's loader already reads as non-empty is not
 *   touched, whatever the line scan concluded; the scan once skipped a real WEBHOOK_SECRET line that only a shell
 *   read as part of a quoted value, and appended a new random secret that systemd then took.
 *   READ BACK (gate round 2): the new text must give the key exactly the value a clean `KEY=value` line gives, for the
 *   platform's own loader (systemd's own parser reading on Linux), with nothing in the file that loader reads
 *   differently from this module. Appending after a file ending inside a continuation or an open quote, or replacing
 *   a `# KEY=` comment inside a multi-line value, each left the key unset while the writer reported it written.
 *   `verify` lets a caller add its own condition on the new text.
 */
function planEnvEdit(raw, path, key, value, { overwrite = false, platform = process.platform, verify } = {}) {
	const refusal = envFileEditRefusal(raw, path);
	if (refusal !== null) return { error: refusal };
	const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
	// THE FILE'S HAZARDS FIRST, before any line scan decides the key is already set or needs no edit (round-cap
	// review): `K=1 exit 0` above `WEBHOOK_SECRET=old` ends the source before the key, and the scan below returned
	// "unchanged" for it, so `up` said "already set" about a key the service never gets. A file the platform's loader
	// reads differently from this module is refused by name rather than called unchanged or already set: for a shell,
	// whatever the edit would have been; for systemd, as described below.
	//
	// On a platform whose service loader is a SHELL, a line that shell reads differently from this module can assign the
	// key where no line scan sees it (`X=1 WEBHOOK_SECRET=abc`, a continuation into ` WEBHOOK_SECRET=abc`), so the
	// append would replace the operator's value: any shell hazard refuses the edit (gate round 4, measured in sh,
	// bash, dash and zsh).
	// On Windows, the same rule by the cmd wrapper's own reading (issue #470, `cmdReading`): a line it cannot be shown
	// to read line by line, or one that names the key other than as a plain `KEY=` line (`webhook_secret=`, an indented
	// or blank-suffixed name, a bare `KEY`), refuses the edit by name, whatever the edit would have been.
	if (loaderFor(platform) === "cmd") {
		const h = cmdReading(text, key).hazard;
		if (h !== null) return { error: `refusing to edit ${path}: ${cmdHazardSentence(h)}. Nothing was written` };
	}
	if (loaderFor(platform) === "shell") {
		const h = envFileHazard(text, { loader: "shell" });
		// A NUL or a CRLF file is named, with its fix: the generic sentence below sends an operator looking for a command
		// on a line that has none (round-cap review).
		if (h?.shape !== undefined) return { error: `refusing to edit ${path}: line ${h.line} has ${SYSTEMD_HAZARD_SHAPES[h.shape].what}. To fix it, ${SYSTEMD_HAZARD_SHAPES[h.shape].fix}. Nothing was written` };
		if (h !== null) return { error: `refusing to edit ${path}: line ${h.line} is one the wrapper that sources this file reads differently from this command (a second assignment on a line, a continuation, a command), so whether ${key} is already set there is unknown. Fix that line first. Nothing was written` };
	}
	const next = (overwrite ? setEnvKey : setEnvKeyIfEmpty)(text, key, value, { platform });
	const already = next === text || overwrite ? null : keyAlreadySet(text, key, platform);
	// The cmd wrapper's value, where the answer would be "unchanged" or "already set" (issue #470): the line it takes
	// for the key must hold a value it can be shown to carry, or neither claim is one this command can make.
	if (loaderFor(platform) === "cmd" && (next === text || already !== null)) {
		const t = cmdReading(text, key).taken;
		const bad = t === undefined ? null : cmdValueRefusal(t.value);
		if (bad !== null) return { error: `refusing to edit ${path}: line ${t.line} is the ${key} line the .cmd wrapper takes, and its value has ${bad}, so what the service reads cannot be confirmed. To fix it, write that value without it, or give the service ${key} through its own environment (pi-dispatch service install --env-setup). Nothing was written` };
	}
	// systemd's two, the ones `editedValueRefusal` asks of the edited text: a file it will not load (the key is then set
	// for nobody) or splits into lines differently from this module. Asked of the file AS IT STANDS only where the
	// answer would otherwise be "unchanged" or "already set", which are claims about that file; an edit keeps being
	// judged on its result below, where replacing the one offending line can leave a file systemd reads cleanly. The cmd
	// wrapper's are asked above and below this, by `cmdReading`.
	if (loaderFor(platform) === "systemd" && (next === text || already !== null)) {
		const h = envFileLoadHazard(raw) ?? envFileSystemdHazard(text);
		// With its fix, as the macOS branch says it (focus review): the line alone left an operator to work out the change.
		if (h !== null) return { error: `refusing to edit ${path}: ${systemdHazardSentence(h)}. To fix it, ${SYSTEMD_HAZARD_SHAPES[h.shape].fix}. Nothing was written` };
	}
	if (next === text) {
		// "Already set" by a line systemd IGNORES is not set for the service (gate round 4): `export WEBHOOK_SECRET=abc`
		// is an assignment to a shell and not to systemd's EnvironmentFile=, so up said "left untouched" about a service
		// with no secret. Said, with the line and the fix, rather than reported as set.
		const shellOnly = overwrite ? null : setOnlyForAShell(text, key, platform);
		if (shellOnly !== null) return { error: `refusing to edit ${path}: ${shellOnly}` };
		// And "unchanged" only when the loader READS it so: the scan stops at the first set line, the loader takes the last.
		const misread = noOpMisread(text, key, value, overwrite, platform);
		return misread === null ? { changed: false } : { error: `refusing to edit ${path}: ${misread}. Nothing was written` };
	}
	// A BACKSTOP since the round-cap review: every file that reached this in a fuzz of 300000 per platform also had a
	// hazard, which is now refused by name above, so removing this line is an equivalent mutation today (measured). It
	// stays because the cost of missing a set key is the operator's secret, and a later loosening of a hazard rule must
	// not reopen that.
	if (already !== null) return { error: `refusing to edit ${path}: ${already}, and a key that has a value is never overwritten. Nothing was written` };
	const afterEdit = editedValueRefusal(next, key, value, platform) ?? verify?.(next) ?? null;
	if (afterEdit !== null) return { error: `refusing to edit ${path}: ${afterEdit}. Nothing was written` };
	// THE FILE ABOUT TO BE WRITTEN is judged as the file read was (third regression review): replacing only the first
	// physical line of a command that continues leaves its tail as a line of its own, so `PI_BACKENDS=""\"\` above
	// `a` became `PI_BACKENDS=podman` above `a`, which all three shells RUN, while the key read back as written. Any
	// hazard the platform's loader finds in the new text that the old text did not have refuses the edit, for a fill,
	// an overwrite and an append alike.
	const introduced = newHazard(text, next, loaderFor(platform));
	if (introduced !== null) return { error: `refusing to edit ${path}: after the edit, line ${introduced} would be one ${loaderName(loaderFor(platform))} reads differently from this command (a command, a continuation or an open quote the file did not have before; for example, the line replaced continued onto the next, so its tail would stand as a line of its own). Put the key's line on one line first. Nothing was written` };
	return { changed: true, next };
}

/**
 * The line of a hazard `loader` finds in `next` that it does not find in `text`, or `null`. "Not in `text`" by its
 * shape and by the text of the line, so a hazard the file already had, moved by the edit's line count, is not new.
 */
function newHazard(text, next, loader) {
	// The cmd wrapper's one hazard, a `"` in a value (`quoteSpans`), belongs to its own line, so it is compared as a SET of
	// lines: overwriting the first of two such lines leaves the second first, and that is not new (the corpus's
	// docs/wait-for.md snippet). The line the writer renders never holds a `"` (`renderEnvValue` refuses it there).
	if (loader === "cmd") {
		const quoted = (l) => (ASSIGNMENT.exec(l.replace(/\r$/, ""))?.[3] ?? "").includes('"');
		const had = new Set(text.split("\n").filter(quoted).map((l) => l.replace(/\r$/, "")));
		const lines = next.split("\n");
		for (let i = 0; i < lines.length; i++) if (quoted(lines[i]) && !had.has(lines[i].replace(/\r$/, ""))) return i + 1;
		return null;
	}
	const after = envFileHazard(next, { loader });
	if (after === null) return null;
	const before = envFileHazard(text, { loader });
	if (before !== null && before.shape === after.shape && text.split("\n")[before.line - 1] === next.split("\n")[after.line - 1]) return null;
	return after.line;
}

/** `planEnvEdit`'s refusal for this content, or `null` when the edit would be made (or is not needed). */
export function envFileEditCheck(content, path, key, value, opts = {}) {
	return planEnvEdit(content, path, key, value, opts).error ?? null;
}

/**
 * Read → transform → write back ATOMICALLY (tmp + rename, the same shape as the admin's
 * writeTriggers), so a watcher or a concurrent reader never sees a half-written .env. When the
 * transform is a no-op the file is not touched at all — no tmp, no rename, no mtime churn — and
 * `{ changed: false }` is returned so callers can say so.
 *
 * `overwrite` picks the transform: false (the default, and the only behaviour that existed before
 * issue #81) applies `setEnvKeyIfEmpty`'s never-clobber discipline; true applies `setEnvKey`, for
 * callers that have already shown the operator the exact line and collected consent — the gate is
 * theirs, this wrapper stays mechanical either way.
 *
 * Mode: a .env at 0o600 (an operator who locked their secrets down) stays 0o600 — chmod on the tmp
 * BEFORE the rename, so no window exists where the secret-bearing file is wider than it was. Any
 * other mode is left to the platform default; this helper preserves a hardening choice, it does not
 * impose one.
 */
export function updateEnvFile(path, key, value, deps = {}) {
	// `platform` is derived HERE rather than passed by each caller, which is what the first version got
	// wrong: `up` passed it and `github-app-setup.mjs` did not, so on Windows a PEM path was single-quoted
	// and the cmd wrapper kept the quotes, making the path the worker loads wrong behind a ✓ on the key
	// that decides forge auth. A rendering rule that every writer of this file must remember is a rule one
	// of them will forget.
	const { fs = { readFileSync, writeFileSync, renameSync, statSync, chmodSync, realpathSync }, overwrite = false, platform = process.platform } = deps;
	// Every refusal is `planEnvEdit`'s (bytes first, never clobber, read back), made before anything is written.
	const plan = planEnvEdit(fs.readFileSync(path), path, key, value, { overwrite, platform, verify: deps.verify });
	if (plan.error) throw new Error(plan.error);
	if (!plan.changed) return { changed: false };
	const { next } = plan;
	// Through the SYMLINK, not over it. A deployment whose `.env` points at a shared env file is an
	// ordinary layout, and rename-over-the-link replaces it with a regular file: every later edit to the
	// shared file, a rotated WEBHOOK_SECRET included, silently stops reaching this deployment. Resolving
	// first edits what the operator meant. Optional on the seam because the test fakes do not model links.
	let target = path;
	try {
		target = fs.realpathSync?.(path) ?? path;
	} catch {
		// Not resolvable (a dangling link, a fs without the call): edit the path we were given.
	}
	// OWNERSHIP, before anything is written. `renameSync` makes a new inode owned by whoever runs this, so
	// a root- or `pi`-owned `.env` at 0640 that the service reads through its group comes back owned by the
	// operator: the service account loses read access, and `deploy/worker.service` uses a bare
	// `EnvironmentFile=` (fatal, not `-`), so the unit stops starting. Widening the mode to compensate
	// would publish a file holding WEBHOOK_SECRET. Refusing is the only honest third option, and the caller
	// turns it into a line rather than a stack trace.
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const gid = typeof process.getgid === "function" ? process.getgid() : null;
	if (uid !== null) {
		try {
			const { uid: owner, gid: group } = fs.statSync(target);
			// GID as well as UID, because the layout this protects is a `.env` at 0640 read by the service
			// THROUGH ITS GROUP. With `bob:pi 0640` and the operator in group `pi` the uid matches, the
			// rename still makes a new inode with the writer's primary gid, and the `pi` service loses read
			// access exactly as it would have on a uid mismatch.
			if (typeof owner === "number" && owner !== uid) throw new Error(`refusing to edit ${target}: it is owned by uid ${owner} and this process is uid ${uid}, and rewriting it would hand it to the wrong account`);
			if (typeof group === "number" && gid !== null && group !== gid) throw new Error(`refusing to edit ${target}: its group is gid ${group} and this process is gid ${gid}, and rewriting it would hand it to the wrong group, which is how a 0640 .env stops being readable by the service`);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("refusing to edit")) throw err;
			// Cannot stat: fall through to the write, which will fail on its own terms if it must.
		}
	}
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, next);
	try {
		// The operator's mode, whatever it is, not just 0600. `.env` holds WEBHOOK_SECRET and provider
		// keys, and a rename from a fresh tmp lands at the process umask: 0640 and 0400 both came back
		// 0644, world-readable, on the one file this project says must never reach a scrollback.
		fs.chmodSync(tmp, fs.statSync(target).mode & 0o7777);
	} catch {
		// The file vanished between read and write, or the fs cannot stat: leave the tmp's default
		// mode rather than failing an edit that is otherwise sound.
	}
	fs.renameSync(tmp, target);
	return { changed: true };
}

/**
 * What NAMED keys a `.env` TEXT assigns, as seen by ONE loader, with a record per key rather than a value.
 *
 * Deliberately NOT a dotenv loader, and the distinction is the whole reason this is allowed to exist
 * (issue #357). Nothing in this project loads `.env` into a process environment: `docs/secrets.md` opens
 * with "the worker parses no `.env` file", and `worker/test/service.test.mjs` pins that a `PI_ENV_SETUP`
 * line inside `./.env` is deliberately NOT honoured. This reader exists so `doctor` can decide WHAT TO SAY
 * about a file, never what to configure.
 *
 * THREE LOADERS READ THIS FILE AND THEY DISAGREE (issue #384). `deploy/worker.service` and
 * `deploy/receiver.service` hand it to systemd's `EnvironmentFile=`; `deploy/worker-env-wrapper.sh` sources
 * it with `set -a`; `deploy/worker-env-wrapper.cmd` splits each line on its first `=`. So a reading is only
 * meaningful beside the loader that produced it, which is what `loader` selects.
 *
 * AND THEY DISAGREE ABOUT MORE THAN QUOTING. Measured, systemd 252 against /bin/sh, bash and zsh, the same
 * line in each:
 *
 *   K=a b        systemd "a b"        the shells leave K UNSET (a second word is a command)
 *   K=$HOME/x    systemd "$HOME/x"    the shells expand it
 *   K=~/x        systemd "~/x"        the shells expand it
 *   K=a"b"c      systemd 'a"b"c'      the shells concatenate to "abc"
 *   K=a #b       systemd "a #b"       the shells stop at the comment
 *   K==ls        systemd "=ls"        zsh expands to /bin/ls; sh and bash do not
 *   K=  leading  systemd "leading"    the shells leave K UNSET
 *
 * ZSH IS CHECKED BUT NOT PROMISED, and the distinction is worth stating because the oracle asserts it
 * (issue #396). The grammar is the intersection of what the SERVICE LOADERS read the same way -- systemd's
 * `EnvironmentFile=`, the `/bin/sh` the wrappers source with, and the cmd wrapper on Windows. zsh is none
 * of those: `deploy/worker-env-wrapper.sh` has a `#!/bin/sh` shebang and the launchd wrapper runs `/bin/sh`,
 * which is bash 3.2 in posix mode on macOS. It is driven anyway because a disagreement there is usually a
 * hole in the grammar rather than a fact about zsh.
 *
 * One FAMILY of shapes is the exception, and it is why this paragraph exists rather than a wider refusal.
 * `K=a:=b` and `K==x` are two of them: zsh treats the right-hand side as a command to find, and when it
 * cannot, its `.` builtin ABORTS THE SOURCING at that line and returns 126. The SHELL carries on -- it does
 * not exit, measured -- but every key below that line is never set, while sh, bash and dash read the file
 * through and this reader keeps vouching. Refusing the shapes outright was considered and rejected: it would
 * warn an operator about a line every loader this project actually deploys reads correctly, which is a false
 * alarm bought with nothing. The oracle names the two it carries; the family is wider (`K2=x:=y:=z`,
 * `K2=:=b`, `K2=a:~b`, `K2=~x` and more behave the same way), and naming two is a sample, not a boundary.
 *
 * So this reader does NOT claim a value for every line. It reports `plain: true` only for the shapes where
 * every one of those loaders agrees, and `plain: false` otherwise, with `value: null`. The previous version
 * claimed a value for all of them and its own docblock listed four shapes where it was wrong; the list was
 * longer than four. Narrowing what is claimed is the fix, rather than writing the shell parser that would be
 * needed to claim more, which is a far larger promise than deciding what a warning SAYS.
 *
 * `undefined` for a key means no assignment at all. `{ value: "" }` means an assignment to nothing, which is
 * NOT absence: `config.mjs` reads several keys with `??`, so an empty string survives, and `start.mjs` then
 * refuses to boot on it. That distinction is why this returns records: the old shape deleted an empty key
 * and every caller that asked "is it set" got the wrong answer (issue #365, and issue #384's item 4).
 */
export function readEnvAssignments(text, keys, { loader = "systemd" } = {}) {
	const want = new Set(keys);
	const found = {};
	const raw = String(text ?? "");
	const lines = raw.split("\n");
	// TWO QUESTIONS, and answering them with one flag is what the first version of this got wrong (found in
	// review). "What does this LINE assign?" and "can I vouch that the loader ends up with that?" are not the
	// same question, and doctor asks the first one:
	//
	//   PI_PAUSE_WINDOWS_FILE=""     the key is EMPTY and the worker refuses to start. That is true whatever
	//   unset FOO                    else the file says, and one flag let the stray line below hide it.
	//
	// So `plain` is about the line's own text (plus anything ABOVE it that swallows the line whole), and
	// `vouched` adds the rest of the file. A caller deciding what the key IS uses `plain`; a caller about to
	// print a value uses `vouched`.
	const bare = lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	// ONE QUESTION ABOUT THE FILE: is every line one this command can read at all? It replaced a taxonomy of
	// hazard causes and an expansion detector that three adversarial passes each found wrong in a different
	// place, and a fourth pass then found the first version of THIS wrong in four more. What survived all
	// four is small, and every refusal is syntactic rather than a guess about what a shell does:
	//
	//   inside a multi-line quote   the shells read this line as more of the value above it, so it is not a
	//                               line; when that quote CLOSES, the lines after it are lines again
	//   an unterminated quote       from the line that opened it, nothing below can be read
	//   a trailing backslash        the same, by continuation
	//   not an assignment           the shells RUN it: `unset K`, a heredoc body, a block, a sourced file
	//   a backtick, any `$` but     it runs, evaluates arithmetic (which can assign), or ENDS the sourcing shell;
	//   `$NAME` and `${NAME}`       outside single quotes nothing else is allowed (`runsOrAborts`)
	//   a NUL, a CRLF line          to a sourcing shell only: bash 3.2 stops at the NUL, and every value keeps the CR
	//
	// A value's ordinary CONTENT is not judged here. `PI_LOGS_DIR=$HOME/logs` changes only its own line's
	// reading, which is what `plain` is for, and treating it as a file-wide hazard hid an EMPTY boot key two
	// lines below it. Nor is anything after a `#` that begins a comment.
	const spans = quoteSpans(lines, loader);
	const hazardLine = spans.hazard ?? (loader === "systemd" ? (envFileSystemdHazard(raw)?.line ?? null) : null);
	for (let i = 0; i < lines.length; i++) {
		const hadCR = lines[i].endsWith("\r");
		const line = hadCR ? lines[i].slice(0, -1) : lines[i];
		// A BOM is not whitespace to any loader here. systemd 252 DROPS an assignment whose line carries one
		// (measured, and the journal says so), and the shells read the name as starting with the BOM, so the
		// key is left unset and the line runs as a command. Stripping it and reading on -- which this did, on
		// every line, while marking only the first line unplain -- vouched for a key no loader sets.
		//
		// Belt and braces, and said so rather than left looking load-bearing: `ASSIGNMENT` already refuses
		// this line, because a BOM is neither `[ \t]` nor the start of a name. Removing this check is an
		// EQUIVALENT mutation today (measured), and it is kept so that widening that regex later cannot
		// quietly re-open the hole.
		if (line.startsWith("\ufeff")) continue;
		const m = ASSIGNMENT.exec(line);
		if (!m) continue;
		const [, exported, key, rest] = m;
		// One loader per reading, never a blend. systemd's `EnvironmentFile=` grammar is bare `NAME=VALUE`:
		// an `export` line is not an assignment there and does not cancel one either (measured: the journal
		// says `Ignoring invalid environment assignment`). The wrapper sources the file, so `export` is
		// ordinary. The cmd wrapper splits on the first `=`, which makes `export K` a variable NAME.
		if (exported && loader !== "shell") continue;
		if (!want.has(key)) continue;
		const read = readValue(rest, loader);
		// CR is the cmd wrapper's own line ending, and `for /f` strips it. Holding a CRLF file against the
		// Windows loader disabled every verdict on the platform where CRLF is NATIVE, including for the exact
		// line `setEnvKeyIfEmpty` writes into such a file, which preserves CRLF by contract.
		// A trailing CR belongs to the loaders that KEEP it. systemd 252 strips it (measured) and so does the
		// cmd wrapper's `for /f`, so a CRLF file is ordinary to both; only a sourcing shell reads the CR as
		// part of the value. Holding it against systemd made a CRLF deployment on linux unjudgeable -- no
		// pass, no failure -- on files `up` itself writes that way.
		const crBreaks = hadCR && loader === "shell";
		// A line INSIDE a multi-line quote is part of the value above it in every shell, whatever it looks
		// like, so it is not this key's line at all.
		const plain = read.plain && !crBreaks && !spans.inside[i];
		// The LAST assignment, because every loader takes it: `set -a; . ./.env`, `EnvironmentFile=` and the
		// cmd wrapper's `set` all overwrite as they go.
		// `blank` is the LOOSE answer, on purpose: it asks only what this line assigns, so `up` can tell an
		// operator their `WEBHOOK_SECRET` line is empty even in a file with a stray line somewhere in it.
		// A caller that turns blankness into a REFUSAL asks for `vouched` beside it -- doctor does -- because
		// a hazard can mean the shells never reach this line at all (a heredoc body, an `if false` block) or
		// that one of them clears the key afterwards (`unset K`), and a hard "REFUSES TO START" is the one
		// verdict that must never be reached by inference. A swallowed line is not a line in either sense.
		found[key] = { value: plain ? read.value : null, plain, vouched: plain && hazardLine === null, blank: loader !== "cmd" && !spans.inside[i] && assignsNothing(rest), line: i + 1, hazardLine };
	}
	return found;
}

// The name is followed DIRECTLY by `=`, with no space. NOT because both loaders refuse the line -- systemd
// 252 accepts `K =/a.json` and sets the key, measured on the rig after an earlier comment here claimed it
// rejected the line -- but because the SHELLS run a command named `K` with `=/a.json` as its argument, so
// the two ends of this file disagree about whether the key is assigned at all. Such a line is a hazard
// rather than a lax assignment, which is where `setEnvKeyIfEmpty` deliberately differs: it is looking for a
// line to REWRITE, and it normalises the spacing when it does.
//
// The value runs to the end of the line, `[^\n]` rather than `.`, because JavaScript's `.` also excludes
// CR, U+2028 and U+2029. With `.` a value carrying any of the three matched NOTHING, so the key had no
// record at all and doctor reported it "unset" -- about a key systemd sets to the text before the CR and
// the shells set whole.
const ASSIGNMENT = /^[ \t]*(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=([^\n]*)$/;

/** `ASSIGNMENT` over a shell's whole COMMAND, whose value may hold the newlines of a quote (`quoteSpans`' join). */
const COMMAND_ASSIGNMENT = /^[ \t]*(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=([^]*)$/;

/**
 * Which lines are inside a multi-line quote, and which line (if any) this command cannot read.
 *
 * ONE PASS, because the two questions share a scanner and answering them separately is how the version
 * before this managed to disagree with itself: one scanner was fed the VALUE and the other the whole LINE,
 * and their "a `#` starts a comment" rules differed, so a file could be readable and swallowed at once.
 *
 * A quote CLOSES. That is the half the first simplification threw away: in
 *
 *     OTHER='x
 *     y'
 *     PI_PAUSE_WINDOWS_FILE=/gone.json
 *
 * every loader reads line 3 identically (measured on systemd 252 and in sh, bash, dash and zsh), so calling
 * the whole file unreadable turned a worker that refuses to start into a clean exit 0. Lines 1 and 2 are the
 * span; line 3 is a line.
 */
function quoteSpans(input, loader) {
	// Lines may still carry their CR (a CRLF file): a backslash before CRLF is NOT a continuation, to systemd (its
	// escape eats the CR and the LF ends the line; measured, the q-cont-crlf row) or to a shell (the backslash quotes
	// the CR only). Reading it as one hid a real `WEBHOOK_SECRET=` line below it from the writer on macOS, which then
	// appended a new secret over the operator's (gate round 4). Callers that stripped the CR get the old reading.
	const cr = input.map((l) => l.endsWith("\r"));
	const bare = input.map((l, i) => (cr[i] ? l.slice(0, -1) : l));
	const inside = bare.map(() => false);
	if (loader === "cmd") {
		// `for /f` reads one line at a time: no continuation, no multi-line value, no execution. A `"` in a value is
		// kept as this loader's one hazard, CAUTIOUSLY: the parser's phase order says FOR variables are substituted after
		// the line's quotes and operators are parsed, so it cannot make the rest of the line a command, but that is not
		// Microsoft's documentation and nothing here can run cmd (issue #470; the writer's own rules are `cmdReading`'s).
		const at = bare.findIndex((l) => (ASSIGNMENT.exec(l)?.[3] ?? "").includes('"'));
		return { inside, hazard: at === -1 ? null : at + 1 };
	}
	// PER LOADER, because the two POSIX loaders do different things with the same file, and one answer for
	// both was wrong for whichever one it was not written for. Measured on systemd 252:
	//
	//   a quote opened MID-value does not continue across lines: `OTHER='a'b'` reads as `ab'` and the NEXT line
	//   is read as an ordinary assignment, where every shell swallows it. CORRECTED (issue #430 review round 2):
	//   the earlier wording said no quote continues, and that is wrong for a quote that OPENS the value, which
	//   systemd's own parser continues across newlines until it closes (test-env-file.c, env_file_6). Those
	//   values are `quotedRegions`' job, and since issue #447 their lines are INSIDE for this loader too, so
	//   doctor's systemd reading no longer takes a line inside one for an assignment. The shapes `quotedRegions`
	//   does not model (a reopened quote, a non-identifier key, a lone CR, a continuation this scan misses) are
	//   `envFileSystemdHazard`'s, which makes the file unreadable rather than modelling them.
	//   a trailing backslash DOES continue, in both.
	//   a line it cannot parse is IGNORED -- `unset K`, `cat <<EOF`, `if false; then`, `OTHER=${NOPE?boom}`
	//   and `OTHER=(` are all inert to systemd, and all of them RUN in a sourcing shell.
	//
	// So the hazards below belong to the shells, and systemd's only cross-line mechanism is the backslash.
	// Judging a linux deployment by the shells' rules is what made an `unset FOO` in a `.env` hide an empty
	// boot key from systemd, which reads that key perfectly well.
	const runsLines = loader === "shell";
	// systemd's own multi-line values: every line after the one that opens the value, up to and including the
	// one that closes it, is part of that value (measured on systemd 259, issue #447).
	if (!runsLines) {
		for (const r of quotedRegions(bare.join("\n"))) {
			for (let k = r.open; k < (r.close ?? bare.length); k++) inside[k] = true;
		}
	}
	let carry = { q: "", cont: false };
	let openedAt = null;
	let hazard = null;
	let shape;
	let crComment = null;
	for (let i = 0; i < bare.length; i++) {
		const line = bare[i];
		const within = (runsLines && carry.q !== "") || carry.cont || inside[i];
		inside[i] = within;
		// TWO BYTES the shell reads differently from this module, on any line, inside a value or not (round-cap review,
		// measured on macOS). A NUL: bash 3.2 as /bin/sh stops reading the file at the first one, so nothing after it is
		// set, while dash drops the byte and reads on. A CR ending a line (a CRLF line ending): the wrapper keeps it, so
		// `WEBHOOK_SECRET=abc<CR>` is `abc<CR>` to the service, a line of only a CR runs it as a command, and a key
		// written into such a file would not read as written. Measured: no shipped `.env.example` has one; the fix is to
		// convert the file to LF line endings.
		// ANY such line, a comment line included (regression review). A comment line's CR is harmless to the shells on
		// its own, and exempting it (focus review) let a CRLF file through to the writer, which then wrote the new line
		// with the file's CRLF ending (`appendEol`, and a replaced `# KEY=` line keeps its CR): `KEY=abc<CR>`, read by
		// /bin/sh as `abc<CR>`. One rule for the whole file is the one the writer can keep.
		// A comment line's CR is named as what it is (second regression review): the shells read past it, and the refusal
		// is this command's, because a key written into the file takes its CRLF ending. But only when EVERY CR line is
		// such a comment (third regression review): `# c<CR>` above `WEBHOOK_SECRET=abc<CR>` has a value that reaches the
		// service with its CR, and naming the comment said the shells read the file fine. So a comment line's CR is kept
		// aside and used only if no other hazard turns up; any other CR line is named as itself.
		const commentCr = runsLines && cr[i] && !input[i].includes("\0") && !within && /^[ \t]*#/.test(bare[i]);
		if (commentCr) crComment ??= i + 1;
		else if (hazard === null && runsLines && (input[i].includes("\0") || cr[i])) {
			hazard = i + 1;
			shape = input[i].includes("\0") ? "shell-nul" : "shell-crlf";
		}
		if (!within && hazard === null && runsLines) {
			// The LOGICAL line (gate round 2): a shell removes a backslash-newline before it reads anything, so
			// `X=a\` + ` PI_EGRESS=0` is `X=a PI_EGRESS=0` to it, and judging only the first physical line passed
			// every shape below on a continuation (measured in bash: PI_EGRESS=0 set).
			//
			// And a quoted newline does not end it (final review): `K="y` + `" WEBHOOK_SECRET=two` is ONE command, two
			// assignments, and so is `K="y` + `K="a\` + `X=a WEBHOOK_SECRET=two`, where the continuation follows the line
			// the quote closes on (measured in /bin/sh on macOS: WEBHOOK_SECRET=two, which the writer then appended a new
			// secret over). Joining only from a line outside a quote judged the first line alone, and every later line of
			// the command was inside, so nothing judged the tail. So the command is joined through its quoted newlines and
			// its continuations alike, and judged whole. Not a refusal of every multi-line quote: the documented
			// GITHUB_APP_PRIVATE_KEY="-----BEGIN ...-----" is one assignment, which this judges as sh reads it.
			// Incremental, so a long quoted value is scanned once rather than once per line. The blank carried across a
			// continuation keeps the join's EXTENT exact (`X=a \` + `#'` is a comment, not an open quote); the verdict does
			// not depend on it, since the checks below rescan the whole command and stop at that comment anyway, so dropping
			// it is an equivalent mutation (measured), kept so the joined command is the one sh reads.
			const { logical } = shellCommand(bare, cr, i);
			// Blanks are space and tab: a NBSP or form feed is a WORD to a shell, so a line of one runs (gate round 1 audit).
			const t = logical.replace(/^[ \t]+|[ \t]+$/g, "");
			const m = COMMAND_ASSIGNMENT.exec(logical);
			if (t !== "" && !t.startsWith("#") && (m === null || logical.startsWith("\ufeff"))) hazard = i + 1;
			else if (m !== null && runsOrAborts(m[3])) hazard = i + 1;
		}
		// A COMMENT never continues: `# note\` leaves the next line a line, in systemd 254 and later (measured on 259) and
		// in sh, bash, dash and zsh (the E2 oracle), where reading the backslash as a continuation refused a legitimate
		// `.env` (issue #447). Only a line that STARTS as a comment: a `#` line reached by a continuation, or inside a
		// quote, is value, and its own backslash joins the next. `;` starts a comment for systemd only; to a shell it is
		// a syntax error, which the hazard above already names.
		const comment = !within && (runsLines ? /^[ \t]*#/ : /^[ \t]*[#;]/).test(line);
		const next = comment ? { q: "", continuation: false } : scanQuotes(line, runsLines ? carry.q : "", runsLines && carry.cont ? carry.blank : false);
		if (carry.q === "" && next.q !== "") openedAt = i + 1;
		carry = { q: next.q, cont: next.continuation && !cr[i], blank: next.afterBlank ?? false };
	}
	// A quote the shells never see closed makes the WHOLE source fail, so from the line that opened it
	// nothing can be read. A backslash on the last line is the same for both loaders.
	if (hazard === null && runsLines && carry.q !== "") hazard = openedAt;
	if (hazard === null && carry.cont) hazard = bare.length;
	if (hazard === null && crComment !== null) {
		hazard = crComment;
		shape = "shell-crlf-comment";
	}
	return { inside, hazard, shape };
}

/** The two `$` forms `runsOrAborts` allows, matched at a `$` (sticky): `$NAME` and exactly `${NAME}`. */
const SIMPLE_EXPANSION = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/y;

/**
 * The shell COMMAND that starts on line `i` (0-based), as the shell reads it: joined through its quoted newlines and its
 * backslash-newline continuations, the latter removed (outside quotes, and inside double quotes after an odd run of
 * backslashes), up to the line that ends it. `bare` are the lines without their CR, `cr` whether each had one: a
 * backslash before a CR continues nothing. One function for `quoteSpans`' hazard judgement and the writer's reading of
 * the line a shell takes (`lastAssignment`), so the two cannot join a command differently. `end` is the command's last
 * line.
 */
function shellCommand(bare, cr, i) {
	let end = i;
	let logical = bare[i];
	let s = scanQuotes(bare[i], "");
	for (let k = i + 1; k < bare.length && (s.q !== "" || (s.continuation && !cr[k - 1])); k++) {
		end = k;
		if (s.q === '"' && !cr[k - 1] && /(?:^|[^\\])(?:\\\\)*\\$/.test(bare[k - 1])) {
			// A backslash-newline INSIDE double quotes is removed as well, before any expansion (delta review): an
			// odd run of backslashes before the LF escapes it, so `K="$\` + `(z)"` is `K="$(z)"` to sh and runs z.
			// Keeping the newline split the `$(` across two lines, and the check below saw neither half. The
			// line's quote state is still `"` after the removed pair, which is what scanning on from `s.q` gives.
			// Since `runsOrAborts` allows only `$NAME` and `${NAME}`, a `$` before the backslash is refused either
			// way, and inside double quotes the removal moves no quote, comment or operator, so dropping this
			// branch (or its parity or CR test) is an equivalent mutation (measured). It is kept so the command
			// judged is the one sh reads, and no later widening of that allowlist can reopen the split.
			logical = logical.slice(0, -1) + bare[k];
			s = scanQuotes(bare[k], s.q);
		} else if (s.q !== "") {
			logical = `${logical}\n${bare[k]}`;
			s = scanQuotes(bare[k], s.q);
		} else {
			logical = logical.slice(0, -1) + bare[k];
			s = scanQuotes(bare[k], "", s.afterBlank);
		}
	}
	return { logical, end };
}

/**
 * Does this value RUN something, END the shell that is sourcing the file, or fail to parse?
 *
 * Narrow on purpose, and comment-aware, which the first version was not: it scanned the whole value, so an
 * inline comment holding a backtick (`NOTE=x # use `openssl rand``) made a file unreadable that all five
 * loaders read perfectly, and the empty boot key two lines below it went unreported.
 *
 *   a backtick                command substitution: arbitrary code, arbitrary exit
 *   any `$` but two forms     outside single quotes the ONLY `$` forms allowed are `$NAME` and exactly
 *                             `${NAME}` (NAME is `[A-Za-z_][A-Za-z0-9_]*`). Everything else is a hazard:
 *                             `$(` and `$((`; `$[`, arithmetic the macOS /bin/sh (bash 3.2) evaluates, so
 *                             `K=$[WEBHOOK_SECRET=5]` assigns; `${` with anything but a bare name (`${N?x}`
 *                             EXITS the sourcing shell, `${K:WEBHOOK_SECRET=2}` and `${a[WEBHOOK_SECRET=5]}`
 *                             evaluate arithmetic, `${}` and `${a b}` are a bad substitution that aborts the
 *                             source under dash); a positional or special parameter; and a `$` before
 *                             anything else or at the end
 *   `( ) ; & | < >` unquoted  the line stops being an assignment: `OTHER=(` is a syntax error that aborts
 *                             the source, and `OTHER=a; exit 0` ends the wrapper before it launches
 *                             anything. Both leave EVERY key in the file unset
 *   a word after a blank      unquoted: the value ended at the blank, so the word is a command (`K=1 z`,
 *                             `K= unset WEBHOOK_SECRET`, `K=1 exit 0`) or a second assignment (`X=a PI_EGRESS=0`
 *                             sets PI_EGRESS, measured in bash and sh on Fedora 44, issue #447 gate round 1)
 *
 * `shellSplitsLine`, which judged the second-assignment and `$'` shapes on their own, was removed in the round-cap
 * review: a second `NAME=` after an unquoted blank is a word after a blank, and an unquoted `$'` (ANSI-C quoting,
 * whose `\'` does not close it) is a `$` outside the allowlist, so both are this function's. Measured equivalent
 * on 300000 random shell files before it went.
 *
 * AN ALLOWLIST, not a list of the forms that run (delta review): the list this replaced was one form short at every
 * review (`$[`, arithmetic inside `${}`, a bad substitution). `$NAME` and `${NAME}` only substitute a variable, so
 * they change their own line's value and nothing else, which is what `plain` is for; every other form is refused
 * without deciding what it does. `${HOME:-/tmp}` is refused with them, because its default word can hold any of the
 * above and telling a safe one apart is the list this replaced. An escaped `\$` or `` \` `` is literal, as in sh,
 * and is skipped by the backslash rule below. The caller has already removed every backslash-newline, inside double
 * quotes as well, so an escape cannot split a `$(` across two lines.
 */
function runsOrAborts(value) {
	let q = "";
	let afterBlank = false;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (q === "'") {
			if (c === "'") q = "";
			afterBlank = false;
			continue;
		}
		if (q === "" && c === "#" && afterBlank) return false;
		// A WORD AFTER A BLANK, unquoted: the value ended at the blank, so what follows is a command word, a second
		// assignment, or the start of one (round-cap review, measured in /bin/sh, bash --posix and dash): `K=1 z` and
		// `K="a" z` run z, `K= unset WEBHOOK_SECRET` and `K= eval "WEBHOOK_SECRET=7"` change the key below, `K=1 exit 0`
		// ends the source, and `K=a PI_EGRESS=0` is two assignments. Outside quotes, after a blank, only more blanks, a
		// `#` (a comment, above) or the end of the command may follow.
		//
		// BEFORE the backslash, which is a word too (second regression review): `K=podman \z` runs `z` and `K= \#` runs
		// `#` in all three shells (dash aborts the source on it), and testing the escape first skipped the character it
		// escapes without asking this. A backslash-newline after a blank never reaches here: the caller joins it away
		// first, so `K=a \` + `# c` is `K=a # c` and `K=podman \` + an empty line is `K=podman `, as the shells read them.
		if (q === "" && afterBlank && c !== " " && c !== "\t") return true;
		if (c === "\\") {
			i += 1;
			afterBlank = false;
			continue;
		}
		if (q === "" && (c === "'" || c === '"')) q = c;
		else if (q === '"' && c === '"') q = "";
		else if (c === "`") return true;
		// UNQUOTED only, as the table above says and as sh does: inside double quotes these are ordinary characters, so
		// `K="a;b"` and `K="(x)"` set K to the text (measured in /bin/sh on macOS). Checking them inside double quotes
		// refused such lines, and since the final review joined a command across its quoted newlines, every multi-line
		// double-quoted value holding a parenthesis. A backtick and every `$` form but two still expand inside double
		// quotes, so those stay refused there; a backslash-escaped character (`\"`, `\$`) is skipped above in both
		// states, as sh does.
		else if (q === "" && (c === "(" || c === ")" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">")) return true;
		else if (c === "$") {
			SIMPLE_EXPANSION.lastIndex = i;
			const m = SIMPLE_EXPANSION.exec(value);
			if (m === null) return true;
			i += m[0].length - 1;
		}
		afterBlank = c === " " || c === "\t";
	}
	return false;
}

/**
 * The quote state at the end of this line, given the state it started in, and whether it ends in the
 * backslash that makes the next line part of it.
 *
 * ONE SCANNER for the whole file, which is the lesson of the round that had two: the other one was fed a
 * VALUE where this is fed a LINE, and their comment rules drifted apart, so a file could be judged readable
 * and swallowed at the same time.
 *
 * A `#` after UNESCAPED whitespace ends the line for quoting purposes, because every shell does that:
 * `K=/a.json # it's fine` is an ordinary line and its apostrophe is in a comment. Escaped whitespace does
 * not count -- in `K=a\ #'` the space is part of the value, so the `#` is too, and the quote after it
 * swallows the line below. Nor does a `#` at the very start of a value: `NOTE=#don't edit` is one word.
 *
 * `blank0`, and `afterBlank` on a continuation, carry that state across a backslash-newline, which a shell removes
 * before it reads anything: `X=a \` + `#'` is `X=a #'`, a comment, where scanning the second line afresh opened a quote.
 */
function scanQuotes(text, q0, blank0 = false) {
	let q = q0;
	let afterBlank = blank0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q === "'") {
			if (c === "'") q = "";
			afterBlank = false;
			continue;
		}
		if (q === '"') {
			if (c === "\\") i += 1;
			else if (c === '"') q = "";
			afterBlank = false;
			continue;
		}
		if (c === "\\") {
			if (i === text.length - 1) return { q, continuation: true, afterBlank };
			i += 1;
			afterBlank = false;
			continue;
		}
		if (c === "#" && afterBlank) return { q, continuation: false };
		if (c === "'" || c === '"') q = c;
		afterBlank = c === " " || c === "\t";
	}
	return { q, continuation: false };
}

/**
 * Does this line assign NOTHING, whatever else is uncertain about it?
 *
 * A THIRD question, separate from both `plain` and `vouched`, and it needs to be: `up` asks it to decide
 * whether it may fill a key in, and building it on `plain` regressed `up` against the release it shipped
 * from. On a CRLF `.env`, or one carrying a trailing comment, `WEBHOOK_SECRET=""` stopped reading as empty,
 * so `up` printed "already set -- left untouched" about an EMPTY value for the receiver's HMAC key and
 * wrote no secret at all. The loaders can disagree about a value and still agree there is none.
 *
 * The rule is deliberately tiny and does not guess: after a trailing CR and trailing blanks come off, what
 * is left is a run of empty quote pairs, or nothing at all. `K=`, `K=   `, `K=''`, `K=""` and `K=""''` are
 * the set, with their CRLF spellings -- the last because systemd 252 and all four shells read concatenated
 * empty pairs as empty, measured, even though it sits outside the grammar `plain` claims.
 *
 * `K="" # tbd` is NOT in it, and the version of this docblock that said otherwise was describing a comment
 * arm the rule does not have: no loader of this file treats a trailing `#` as a comment, so systemd hands
 * the service ` # tbd` while the shells see nothing. That is a disagreement, not an empty value.
 *
 * NOT for the cmd wrapper, which is why the caller passes the loader: `set "K="` UNSETS there, so an empty
 * value is an absent key rather than a blank one, and calling it blank made doctor fail a Windows
 * deployment that starts.
 */
function assignsNothing(rest) {
	return /^(?:''|"")*[ \t]*$/.test(rest.replace(/\r+$/, "").replace(/[ \t]+$/, ""));
}

/**
 * The PLAIN grammar: the shapes systemd, the sourcing shells and the cmd wrapper all read the same way.
 * Measured rather than derived, with the corpus and the readings recorded on `readEnvAssignments` above.
 *
 *   empty, `""` and `''`   -> ""
 *   `'...'`                -> the inner text, any character but `'` (non-ASCII and a TAB included, both
 *                             measured on systemd 252 and in the three shells)
 *   `"..."`                -> the inner text, without `"`, `$`, `\`, a backtick or a control character
 *   bare                   -> `[A-Za-z0-9_@+:,./-]*`, not starting `=` and with no `:=`
 *
 * The exclusions each have a measurement behind them. `$`, a backtick and `~` are expanded by the shells and
 * not by systemd. A backslash is an escape to systemd and to the shells, and a literal to the cmd wrapper,
 * so `C:\pi\x` reads as `C:pix` on two of the three. A leading `=` or an embedded `:=` is expanded by zsh
 * alone. Whitespace outside quotes ends the value for the shells and does not for systemd. A `#` after
 * whitespace is a comment to the shells and part of the value to systemd, which is the defect issue #392
 * shipped in the scaffold.
 */
const UNQUOTED_PLAIN = /^(?!=)(?![^\n]*:=)[A-Za-z0-9_@+:,./-]*$/;

/**
 * `plain` has TWO conditions, and the second one is why this exists: every loader must read the value the
 * same way, AND the value must be one doctor can repeat back to an operator. A quoted ESC, a C1 CSI byte,
 * a bidi override or a line separator is read identically by systemd and by all four shells -- so the first
 * condition holds -- and printing it rewrites the operator's terminal, which is the hazard the narrowed
 * claim exists to remove. Both conditions live in the reader, because a caller that has to remember to
 * escape is a caller that will forget: doctor prints this value in three places.
 *
 * The exception is a TAB, measured rather than tolerated: systemd 252 and all four shells keep it byte for
 * byte inside single quotes, and `renderEnvValue` quotes a tab-bearing path rather than refusing it, so
 * excluding tab would make this reader refuse to vouch for a line `up` itself wrote. CR is excluded because
 * a line ending in one is handled above and a lone CR mid-value has no legitimate source.
 *
 * C0 except tab, DEL, C1, the bidi controls and isolates, the zero-width characters, and the line and
 * paragraph separators. NOT "non-ASCII": a path under an accented or CJK home is ordinary, measured
 * identical on all five loaders, and the printable-ASCII-only first draft warned about `up`'s own line.
 */
const QUOTED_CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb]/;

/**
 * The offset of the first byte of `bytes` that does not begin a well-formed UTF-8 sequence (a stray continuation byte,
 * a truncated sequence, an overlong form, a surrogate, or a code point past U+10FFFF), or -1 when it is all valid.
 */
export function firstInvalidUtf8(bytes) {
	for (let i = 0; i < bytes.length; ) {
		const b = bytes[i];
		if (b < 0x80) {
			i += 1;
			continue;
		}
		const [n, lo, hi] = b >= 0xc2 && b <= 0xdf ? [2, 0x80, 0xbf] : b === 0xe0 ? [3, 0xa0, 0xbf] : b === 0xed ? [3, 0x80, 0x9f] : b >= 0xe1 && b <= 0xef ? [3, 0x80, 0xbf] : b === 0xf0 ? [4, 0x90, 0xbf] : b >= 0xf1 && b <= 0xf3 ? [4, 0x80, 0xbf] : b === 0xf4 ? [4, 0x80, 0x8f] : [0, 0, 0];
		if (n === 0 || i + n > bytes.length) return i;
		if (bytes[i + 1] < lo || bytes[i + 1] > hi) return i;
		for (let k = 2; k < n; k++) if (bytes[i + k] < 0x80 || bytes[i + k] > 0xbf) return i;
		i += n;
	}
	return -1;
}

/**
 * A value rendered so an operator can read it and a terminal cannot be rewritten by it.
 *
 * ONE CLASS, one operation, in the module that owns the class. Printable text passes through bare, an
 * accented or CJK path included, because escaping those would make the commonest non-ASCII home directory
 * unreadable in the very line telling its owner what to fix. Anything in the control class is quoted and
 * escaped whole.
 *
 * Needed because `plain` guards only what comes out of the FILE. Doctor also prints what this SHELL sets,
 * and an environment variable is constrained by no grammar at all: `PI_PAUSE_WINDOWS_FILE` holding a raw
 * ESC reached the terminal through the shell branch while the file branch was carefully withholding it.
 */
export function envValueShown(value) {
	const v = String(value ?? "");
	if (!QUOTED_CONTROL.test(v)) return v;
	return JSON.stringify(v).replace(new RegExp(QUOTED_CONTROL.source, "g"), (c) => "\\u" + c.codePointAt(0).toString(16).padStart(4, "0"));
}

/**
 * The multi-line quoted values of this file, as `[{ open, close }]` (1-based lines; `close: null` when the quote never
 * closes and the value runs to the end of the file). systemd's rule, and the shells' for these shapes: a value that
 * OPENS with `"` continues to the next `"` not escaped by a backslash, one opening with `'` to the next `'`; a value
 * closed on its own line is no region. Lines strictly after `open`, up to and including `close`, are part of the value.
 * Issue #430 review round 3 replaced a rule that called every such value unreadable, which refused the documented
 * multi-line GITHUB_APP_PRIVATE_KEY that systemd reads perfectly (measured on systemd 259).
 */
export function quotedRegions(text) {
	const lines = String(text ?? "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	const closeAt = (q, s) => {
		if (q === "'") return s.indexOf("'");
		for (let k = 0; k < s.length; k++) {
			if (s[k] === "\\") k++;
			else if (s[k] === '"') return k;
		}
		return -1;
	};
	const regions = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(["'])([^\n]*)$/.exec(lines[i]);
		if (!m) continue;
		const [, q, rest] = m;
		if (closeAt(q, rest) !== -1) continue;
		let close = null;
		for (let k = i + 1; k < lines.length; k++) {
			if (closeAt(q, lines[k]) !== -1) {
				close = k + 1;
				break;
			}
		}
		regions.push({ open: i + 1, close });
		if (close === null) break;
		i = close - 1; // resume after the value; the loop's i++ lands on the line after `close`
	}
	return regions;
}

/**
 * What each `envFileSystemdHazard` shape is, and what to change, in words an operator can act on. One table so the
 * venue readers' refusal and doctor's warning say the same thing about the same line. The two `shell-` shapes are the
 * sourcing shell's (`envFileHazard` with the shell loader), not systemd's: a systemd service reads both files fine.
 */
export const SYSTEMD_HAZARD_SHAPES = Object.freeze({
	"lone-cr": {
		what: "a carriage return (CR) that is not part of a CRLF line ending, which systemd reads as a line break and this command does not",
		fix: "remove the CR, or save the file with LF (or CRLF) line endings",
	},
	"non-identifier-key": {
		what: "a quoted value under a key that is not a variable name (letters, digits and underscores, not starting with a digit), whose quote does not close on that line, so systemd reads the lines below as part of it",
		fix: "rename the key to a valid variable name, close the quote on the same line, or delete the line",
	},
	"reopened-quote": {
		what: "a second quote right after a value's closing quote that does not close on that line, so systemd reads the lines below as part of the value",
		fix: "remove the second quote, or close it on the same line",
	},
	continuation: {
		what: "a trailing backslash that systemd reads as joining the next line to this value (after a quote in the middle of the value, after a #, or on the line where a multi-line quoted value closes)",
		fix: "remove the trailing backslash, or move the value onto one line",
	},
	"unmodelled-quote": {
		what: "a quoted value whose extent systemd reads differently from this command (a CR, U+2028 or U+2029 inside it, or a quote reached through a continuation), so the lines below it are not what they appear",
		fix: "put that quoted value on one line and remove the unusual character, or end the line before it with no trailing backslash",
	},
	"shell-crlf": {
		what: "a carriage return (CR) at its end, a CRLF line ending, which the wrapper that sources this file on macOS keeps: a value on that line reaches the service with the CR on its end, and a line holding nothing else runs the CR as a command",
		fix: "convert the file to LF line endings",
	},
	"shell-crlf-comment": {
		what: "a carriage return (CR) at the end of a comment line, a CRLF line ending: the wrapper that sources this file on macOS would still read the lines below it, but this command refuses CR line endings there, because a key it writes into the file would take the same ending and reach the service with the CR on its end",
		fix: "convert the file to LF line endings",
	},
	"shell-nul": {
		what: "a NUL byte, and the macOS /bin/sh stops reading the file there, so no key below it is set",
		fix: "remove the NUL byte",
	},
	nul: {
		what: "a NUL byte, and systemd refuses to load a file with one anywhere in it, so the service does not start",
		fix: "remove the NUL byte",
	},
	"exec-too-large": {
		what: "more environment than the service can safely be started with: one KEY=value longer than 131071 bytes fails with \"Argument list too long\", and a total over 2031616 bytes (8 bytes per variable counted) may, because Linux gives a program's arguments and environment together a quarter of its stack limit (2 MiB under systemd's default 8 MiB), less what systemd and the unit add",
		fix: "shorten that value, or move the large content into a file and put its path in the .env",
	},
	"invalid-utf8": {
		what: "bytes in a key or value that are not valid UTF-8, or a Unicode noncharacter (U+FFFE, U+FFFF, U+FDD0 to U+FDEF and the like), and systemd refuses to load such a file, so the service does not start",
		fix: "re-save the file as UTF-8, or remove those bytes",
	},
});

/**
 * The first place in this file where systemd's `EnvironmentFile=` parser reads LINES differently from this module's
 * reader, as `{ line, shape }` (1-based; `shape` a key of `SYSTEMD_HAZARD_SHAPES`), or `null` (issue #447).
 *
 * It walks systemd's own parser states (src/basic/env-file.c: PRE_KEY, KEY, PRE_VALUE, VALUE, the two quoted
 * states, their escapes and COMMENT) rather than listing forms, because a list refused lines that are harmless: after
 * a value's closing quote any character but a blank, a quote or a backslash puts systemd in VALUE, where a quote is
 * literal, so `K="a"b`, `K=a"b"c`, `K="a" # "b"` and `K="/a.json" # see "notes"` all read line by line (measured).
 * Only the transitions this reader does not model are hazards, each measured on systemd 259:
 *
 *   lone-cr              a CR not followed by LF, outside a quoted value. systemd's newline set is "\n\r", so
 *                        `X=1<CR>PI_BACKENDS=podman` sets both keys; this reader splits on LF alone. A CR at the very
 *                        end of the file, or inside a quoted value, is read the same way by both and is not a hazard.
 *   non-identifier-key   systemd's key is everything before the first `=` (the first character excepted: at the
 *                        start of a line even `=` is part of the key), trimmed. Under ANY key, a value that opens with
 *                        a quote continues to its close; systemd drops the assignment afterwards when the key is not a
 *                        valid name, but the lines it swallowed stay swallowed. `quotedRegions` models identifier keys
 *                        (with `export `, which systemd also drops), so only the rest is a hazard, and only when the
 *                        quote does not close on its own line.
 *   reopened-quote       after a closing quote systemd is back in PRE_VALUE, which skips blanks, so a quote after
 *                        optional blanks OPENS again (`K="a" "b` continues onto the next line). A hazard when that
 *                        quote does not close on its line, including on the line where an earlier multi-line value
 *                        closes.
 *   continuation         a backslash before a LF outside quotes joins the next line to the value (VALUE_ESCAPE eats
 *                        the newline). The reader's line scan finds that, except where it takes a mid-value quote
 *                        or a `#` as quoting or a comment, which systemd does not: `K=a"b\`, `K=a # b\` and a `b"\`
 *                        closing a multi-line value all swallow the next line (measured). A hazard only where the
 *                        line scan misses the join. A backslash before CRLF does NOT continue in systemd (the CR is
 *                        eaten, the LF ends the line); the reader treats it as a continuation, which only ever makes
 *                        it read LESS, so it is left alone.
 *
 *   unmodelled-quote     STRUCTURAL, not a form (gate round 1): at every newline, whether systemd is inside a quote
 *                        must equal whether `quotedRegions` puts the next line inside a value. The shape list above
 *                        passed a value whose first line held U+2028, U+2029 or a CR, because `quotedRegions` used
 *                        `.`, which stops there; this comparison is what catches the next such gap.
 *
 * A file with no hazard is one where every line this reader calls a line, systemd calls a line too.
 */
export function envFileSystemdHazard(text) {
	return walkSystemd(String(text ?? "")).hazard;
}

/**
 * systemd's EnvironmentFile= parser over `raw`, one character at a time, as one pass: the first place it reads LINES
 * differently from this reader (`hazard`), and the span of every assignment it PUSHES (`pushed`: `[start, end)` in
 * `raw` plus the line it starts on), which is what systemd checks for valid UTF-8 (`envFileLoadHazard`).
 *
 * THE READER'S OWN MODEL IS CHECKED AT EVERY NEWLINE (issue #447, gate round 1): whether systemd is inside a quote
 * when a line ends must equal whether `quotedRegions` puts the next line inside a value. Any disagreement is a hazard,
 * whatever its cause. The first version compared shapes only, and `quotedRegions` itself missed a value whose first
 * line carried U+2028, U+2029 or a CR (its `.` stopped matching there), so the swallowed lines read as assignments
 * while this function reported nothing (measured on systemd 259: `PI_EGRESS=1` read where systemd set `0`).
 */
function walkSystemd(raw) {
	const bare = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	const readerInside = new Set();
	for (const r of quotedRegions(raw)) for (let n = r.open + 1; n <= (r.close ?? bare.length); n++) readerInside.add(n);
	const IDENTIFIER = /^(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*$/;
	const SHELL_NEED_ESCAPE = '"\\`$';
	const blank = (c) => c === " " || c === "\t";
	let hazard = null;
	const note = (h) => {
		hazard ??= h;
	};
	// What systemd STORES for each assignment it pushes, escapes and quotes processed (trailing blanks are ASCII and
	// left on, which changes no UTF-8 verdict): that, not the raw span, is what it checks for valid UTF-8, so
	// `X="\xC3""\xA9"` loads and `X="\xC3\\\xA9"` does not (both measured on systemd 259, gate round 2).
	const pushed = [];
	let state = "PRE_KEY";
	let line = 1;
	let key = "";
	let value = "";
	let keyLine = 1;
	let closedOnce = false; // a quote of this value has opened and closed, so the next one is a REOPEN
	let pending = null; // the open quote's hazard if a newline arrives inside it; set afresh on every quote that opens
	// Trailing blanks of an UNQUOTED value are not stored (systemd's last_value_whitespace); quoted ones are.
	let trailingBlank = -1;
	const push = (trim = false) => pushed.push({ line: keyLine, key: key.replace(/[ \t]+$/, ""), value: trim && trailingBlank !== -1 ? value.slice(0, trailingBlank) : value });
	for (let p = 0; p < raw.length; p++) {
		const c = raw[p];
		const quoted = state === "SQ" || state === "DQ" || state === "DQ_ESCAPE";
		if (c === "\r" && !quoted && p + 1 < raw.length && raw[p + 1] !== "\n") note({ line, shape: "lone-cr" });
		const newline = c === "\n" || c === "\r";
		if (quoted && c === "\n" && pending) note(pending);
		// The reader's own model, checked at every line end: systemd inside a quote exactly where `quotedRegions` puts
		// the next line inside a value.
		if (c === "\n" && quoted !== readerInside.has(line + 1)) note({ line, shape: "unmodelled-quote" });
		switch (state) {
			case "PRE_KEY":
				if (c === "#" || c === ";") state = "COMMENT";
				else if (!blank(c) && !newline) {
					state = "KEY";
					key = c;
					value = "";
					keyLine = line;
					closedOnce = false;
				}
				break;
			case "KEY":
				if (newline) state = "PRE_KEY";
				else if (c === "=") {
					state = "PRE_VALUE";
					trailingBlank = -1;
				} else key += c;
				break;
			case "PRE_VALUE":
				if (newline) {
					state = "PRE_KEY";
					push();
				} else if (c === "'" || c === '"') {
					state = c === "'" ? "SQ" : "DQ";
					if (closedOnce) pending = { line, shape: "reopened-quote" };
					else if (!IDENTIFIER.test(key.replace(/[ \t]+$/, ""))) pending = { line, shape: "non-identifier-key" };
					else pending = null;
				} else if (c === "\\") state = "VALUE_ESCAPE";
				else if (!blank(c)) {
					state = "VALUE";
					trailingBlank = -1;
					value += c;
				}
				break;
			case "VALUE":
				if (newline) {
					state = "PRE_KEY";
					push(true);
				} else if (c === "\\") {
					state = "VALUE_ESCAPE";
					trailingBlank = -1;
				} else {
					if (!blank(c)) trailingBlank = -1;
					else if (trailingBlank === -1) trailingBlank = value.length;
					value += c;
				}
				break;
			case "VALUE_ESCAPE":
				state = "VALUE";
				if (c === "\n" && !scanQuotes(bare[line - 1], "").continuation) note({ line, shape: "continuation" });
				if (!newline) value += c;
				break;
			case "SQ":
				if (c === "'") {
					state = "PRE_VALUE";
					closedOnce = true;
				} else value += c;
				break;
			case "DQ":
				if (c === '"') {
					state = "PRE_VALUE";
					closedOnce = true;
				} else if (c === "\\") state = "DQ_ESCAPE";
				else value += c;
				break;
			case "DQ_ESCAPE":
				state = "DQ";
				if (SHELL_NEED_ESCAPE.includes(c)) value += c;
				else if (c !== "\n") value += "\\" + c;
				break;
			case "COMMENT":
				if (c === "\\") state = "COMMENT_ESCAPE";
				else if (newline) state = "PRE_KEY";
				break;
			case "COMMENT_ESCAPE":
				// Since systemd 254 a comment's trailing backslash does not carry the comment onto the next line.
				state = newline ? "PRE_KEY" : "COMMENT";
				break;
		}
		if (c === "\n") line++;
	}
	// At the end of the file systemd pushes whatever value is open, quoted or not.
	if (state !== "PRE_KEY" && state !== "KEY" && state !== "COMMENT" && state !== "COMMENT_ESCAPE") push(state === "VALUE");
	return { hazard, pushed };
}

/**
 * Why systemd would REFUSE TO LOAD this file at all, as `{ line, shape }`, or `null` (issue #447, gate round 1). The
 * unit then fails to start with the file's every key, so no reading of it means anything. Measured on systemd 259:
 *
 *   nul            a NUL byte ANYWHERE, a comment included ("Failed to load environment files: Bad message")
 *   invalid-utf8   a key or value systemd pushes that is not valid UTF-8 (a stray byte, an overlong form, a
 *                  surrogate, a 5- or 6-byte form, a truncated sequence) or holds a Unicode noncharacter ("Invalid
 *                  argument"), judged as systemd STORES it, quotes and escapes processed (gate round 2: `X=\xE2\\\x82\x82`
 *                  loads, its escape joining the sequence). In a comment, or on a line with no `=`, systemd never
 *                  pushes it and loads the file; a correctly encoded U+FFFD is ordinary text.
 *
 * `content` is the file's BYTES: decoding first (as `readFileSync(path, "utf8")` does) turns a bad byte into U+FFFD
 * and the evidence is gone. A string (a test's seam) can still be checked for NUL and is otherwise taken as valid.
 * The walk runs over the bytes as latin1, one character per byte, which is exact for systemd's states: every
 * character it acts on is ASCII, and every byte of a multi-byte sequence is 0x80 or above.
 */
export function envFileLoadHazard(content) {
	const isBytes = content instanceof Uint8Array;
	const text = isBytes ? Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("latin1") : String(content ?? "");
	const nul = text.indexOf("\0");
	if (nul !== -1) return { line: lineAt(text, nul), shape: "nul" };
	const { pushed } = walkSystemd(text);
	if (isBytes) {
		for (const a of pushed) {
			if (!systemdUtf8(Buffer.from(a.key, "latin1")) || !systemdUtf8(Buffer.from(a.value, "latin1"))) return { line: a.line, shape: "invalid-utf8" };
		}
	}
	// TOO BIG TO EXEC (gate round 3): the unit then fails at start with "Argument list too long" (203/EXEC). Measured on
	// systemd 259: a KEY=value of 131071 bytes runs and of 131072 does not (Linux caps ONE string at 131072 bytes WITH
	// its NUL; gate round 4 corrected an off-by-one), and 24 values of 100 KiB (2.4 MB in all) fail where 19 (1.9 MB)
	// run. So one KEY=value longer than 131071 bytes is refused, and so is a whole environment past `EXEC_TOTAL_MAX`.
	//
	// THE TOTAL IS NOT A CONSTANT OF systemd (focus review, measured on systemd 259 under `systemd-run --user`, Fedora
	// 44): the kernel gives argv and envp together a quarter of the stack limit, which is 8 MiB by default, so 2097152
	// bytes; a unit's `.env` of 2096288 counted bytes (21 assignments) started and 2096349 failed with 203/EXEC, the
	// 864 between them being systemd's own 17 variables (535 bytes), a pointer (8 bytes) per string and the argv. So
	// the bound counts 8 bytes per variable too and keeps a 64 KiB margin for the argv, what systemd and the unit add,
	// and the stack limit (LimitSTACK=). It was a flat 1 MiB, which refused a 1.1 MB file systemd starts.
	const size = (s) => (isBytes ? s.length : Buffer.byteLength(s, "utf8"));
	// Only what reaches exec counts: the LAST value of each valid name (measured: a 200 KB `X=` reassigned small below runs,
	// and names systemd drops as invalid never reach the service).
	const finalEnv = new Map();
	for (const a of pushed) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.key)) finalEnv.set(a.key, { n: size(a.key) + 1 + size(a.value), line: a.line });
	for (const [key, { n, line }] of finalEnv) if (n > EXEC_ONE_MAX) return { line, shape: "exec-too-large", detail: `${key}=... is ${n} bytes` };
	let total = 0;
	for (const { n, line } of finalEnv.values()) {
		total += n + 1 + 8;
		if (total > EXEC_TOTAL_MAX) return { line, shape: "exec-too-large", detail: `the file's assignments reach ${total} bytes by this line` };
	}
	return null;
}

/**
 * The longest one KEY=value, and the whole-environment bound, `envFileLoadHazard` accepts, in bytes (gate rounds 3, 4;
 * the total re-measured in the focus review): 2 MiB, the measured exec limit under systemd's default stack, less 64 KiB.
 */
export const EXEC_ONE_MAX = 131071;
export const EXEC_TOTAL_MAX = 2 * 1024 * 1024 - 64 * 1024;

/**
 * What systemd STORES for `key` from this `.env` text, as `{ value, line }`, or `undefined` when it assigns none: the
 * last assignment its parser pushes under exactly that name, quotes, escapes and trailing blanks processed. This is
 * systemd's own reading, not the line-level one, so `KEY =x` counts (systemd trims the blank before `=`) and
 * `export KEY=x` does not (that key is `export KEY`, which systemd drops). The writer's never-clobber and read-back
 * checks use it on Linux (gate round 3).
 */
export function systemdReading(text, key) {
	let found;
	for (const a of walkSystemd(String(text ?? "")).pushed) if (a.key === key) found = { value: a.value, line: a.line };
	return found;
}

/**
 * systemd's `utf8_is_valid` over these bytes: well-formed UTF-8 (`firstInvalidUtf8`) AND no Unicode noncharacter, which
 * it rejects too while a strict `TextDecoder` accepts them: U+FDD0 to U+FDEF, and every code point whose low 16 bits
 * are FFFE or FFFF (U+FFFF, U+1FFFE, U+10FFFE and the rest). Measured on systemd 259 (gate round 2): U+FFFE, U+FFFF,
 * U+FDD0, U+FDEF, U+1FFFF and U+10FFFE in a value fail the load, U+FDCF and U+FDF0 do not.
 */
export function systemdUtf8(bytes) {
	if (firstInvalidUtf8(bytes) !== -1) return false;
	for (const ch of Buffer.from(bytes).toString("utf8")) {
		const cp = ch.codePointAt(0);
		if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return false;
	}
	return true;
}

/** The 1-based line of the character at `index`. */
function lineAt(text, index) {
	let n = 1;
	for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) n++;
	return n;
}

/**
 * The text of a `.env` read as BYTES, plus the reason the loader would refuse to load it (`loadHazard`, systemd only).
 * The one place the call sites (`up`, `service install`, the setup wizard, doctor) turn a file into text, so the
 * check `envFileLoadHazard` needs the bytes for is made once rather than by each of them.
 */
export function decodeEnvFile(content, { loader = "systemd" } = {}) {
	const isBytes = content instanceof Uint8Array;
	const text = isBytes ? Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("utf8") : String(content ?? "");
	return { text, loadHazard: loader === "systemd" ? envFileLoadHazard(content) : null };
}

/**
 * The first line of this file that this command cannot read, or `null`. Same rule as the reader's.
 *
 * Exported because ABSENCE OF A READING IS NOT ABSENCE OF AN ASSIGNMENT, and doctor printed the second when
 * it had the first: a key with no record at all, in a file with a line like this in it, was reported as
 * "unset, so the worker ignores it". Answered for the cmd loader too, which an earlier version refused to
 * do -- so the one cross-line hazard Windows has was invisible to the caller that needed it.
 */
export function envFileHazard(text, { loader = "systemd" } = {}) {
	const spans = quoteSpans(String(text ?? "").split("\n"), loader);
	if (spans.hazard !== null) return spans.shape === undefined ? { line: spans.hazard } : { line: spans.hazard, shape: spans.shape };
	// systemd's own line structure, where it differs from this reader's (issue #447). Only for that loader: the
	// shells split on LF and carry every quote, and the cmd wrapper reads one line at a time.
	return loader === "systemd" ? envFileSystemdHazard(text) : null;
}

function readValue(rest, loader) {
	if (loader === "cmd") {
		// `for /f "delims=="` takes the rest of the line verbatim, so there is no quoting and no comment.
		// An empty value UNSETS the variable there (`set "K="`), read from the wrapper's own source rather
		// than run on Windows.
		// Verbatim: there is no quoting to strip and no comment syntax. It can still DISAGREE with the POSIX loaders,
		// which is why a caller asks the loader its own deployment uses rather than blending them.
		// NOT PLAIN where this reading is not the wrapper's (issue #470, the table at `cmdReading`): `K==v` is `v` to
		// for /f, not `=v`; a `!` (and a `^` beside one) depends on the registry's delayed expansion; a character outside
		// ASCII is decoded in the console code page; a control character is not documented at all. A `"` and a `%` keep
		// the reading the wrapper's own header describes (the quote stays unvouched, as the file's hazard); the WRITER is
		// stricter and refuses all of them on the line it takes (`cmdValueRefusal`).
		return rest.startsWith("=") || /[\x00-\x08\x0a-\x1f\x7f!^]|[^\x00-\x7f]/u.test(rest) ? { plain: false, value: null } : { plain: true, value: rest };
	}
	const trimmedEnd = rest.replace(/[ \t]+$/, "");
	if (trimmedEnd === "") return { plain: true, value: "" };
	if (/^[ \t]/.test(trimmedEnd)) return { plain: false, value: null }; // the shells drop it
	const q = trimmedEnd[0];
	if (q === '"' || q === "'") {
		const close = trimmedEnd.indexOf(q, 1);
		if (close !== trimmedEnd.length - 1) return { plain: false, value: null };
		const inner = trimmedEnd.slice(1, -1);
		const bad = q === '"' ? /["$\\`]/ : /'/;
		return { plain: !bad.test(inner) && !QUOTED_CONTROL.test(inner), value: inner };
	}
	if (trimmedEnd.endsWith("\\")) return { plain: false, value: null };
	return { plain: UNQUOTED_PLAIN.test(trimmedEnd), value: trimmedEnd };
}
