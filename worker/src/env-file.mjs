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
 * Replace a commented line with `KEY=value` while KEEPING the original line, as a comment, above it.
 *
 * `.env.example` documents most keys INLINE (`# PI_LOGS_DIR=   # where per-job status records land`) with
 * indented continuation comments below, and both transforms replace a line whole, so without this an `up`
 * that fills four commented keys silently deletes four lines of the operator's own reference and leaves
 * those continuations dangling under a now-set key.
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
function replacementLines(key, value, bare, wasComment, opts) {
	const rendered = renderEnvValue(value, opts);
	return wasComment ? [bare, `${key}=${rendered}`] : [`${key}=${rendered}`];
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
 * What cmd cannot take is `%` (its expansion character), a `"` (it would close the quoted `set`), and a
 * carriage return or newline. `'` is ordinary there, and is excluded anyway by the shared refusal above,
 * because the same file is read on POSIX by deployments that share it.
 */
const WINDOWS_UNSAFE = /[%"\n\r]/;

export function renderEnvValue(value, { platform = process.platform } = {}) {
	const v = String(value);
	// The Windows loader keeps surrounding quotes as part of the value ("Values MUST be UNQUOTED", its own
	// header), so nothing is ever quoted for it: a value it can take is written bare, and one it cannot is
	// refused rather than dressed in quotes that become part of a path.
	if (platform === "win32") {
		if (WINDOWS_UNSAFE.test(v)) throw new Error(`cannot write this value into a .env on Windows: it contains ${/[%]/.test(v) ? "a % (cmd's expansion character)" : /["]/.test(v) ? 'a double quote' : "a line break"}, and cmd's \`set\` cannot be quoted around it (deploy/worker-env-wrapper.cmd)`);
		return v;
	}
	if (UNQUOTED_SAFE.test(v)) return v;
	if (v.includes("'") || /[\n\r]/.test(v)) throw new Error(`cannot write this value into a .env safely: ${v.includes("'") ? "it contains a single quote" : "it contains a newline"}`);
	return `'${v}'`;
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

export function setEnvKeyIfEmpty(text, key, value, opts) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `export ` is part of the SET shape here, and that is a never-clobber decision rather than dotenv
	// pedantry: the wrapper scripts source this file with `set -a; . ./.env`, where `export KEY=value` is an
	// ordinary assignment the operator made. Without it the key reads as absent, a second assignment is
	// appended, and the shell takes the LAST one -- so filling four "empty" keys would replace four values
	// the operator set, in one pass, with no prompt. `readEnvAssignments` is deliberately stricter about what
	// it will VOUCH for: there, declining to claim a value costs a fuller warning, where missing one HERE
	// costs the value itself.
	const setRe = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=(.*)$`);
	const commentRe = new RegExp(`^\\s*#\\s*(?:export\\s+)?${escaped}\\s*=`);

	const lines = text.split("\n");
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
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		const m = line.match(setRe);
		if (!m) continue;
		if (m[1].trim() !== "") return text;
		if (firstEmpty === -1) firstEmpty = i;
	}
	if (firstEmpty !== -1) return replaceLine(firstEmpty);

	// Pass 2: a commented-out `# KEY=` line (only reachable when no set line exists at all).
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (commentRe.test(line)) return replaceLine(i);
	}

	// Pass 3: no trace of the key — append at the end, on its own line.
	const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
	return `${base}${key}=${renderEnvValue(value, opts)}\n`;
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
	const setRe = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`);
	const commentRe = new RegExp(`^\\s*#\\s*(?:export\\s+)?${escaped}\\s*=`);

	const lines = text.split("\n");
	const replaceLine = (i) => {
		const crlf = lines[i].endsWith("\r") ? "\r" : "";
		const bare = crlf === "" ? lines[i] : lines[i].slice(0, -1);
		lines.splice(i, 1, ...replacementLines(key, value, bare, commentRe.test(bare), opts).map((l) => `${l}${crlf}`));
		return lines.join("\n");
	};

	// Pass 1: the FIRST set line, whatever its value — this is the overwrite discipline. Already
	// exactly `KEY=value` (modulo the CRLF tail) → the input object back, so the wrapper skips the write.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (!setRe.test(line)) continue;
		if (line === `${key}=${renderEnvValue(value, opts)}`) return text;
		return replaceLine(i);
	}

	// Pass 2: a commented-out `# KEY=` line (only reachable when no set line exists at all).
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (commentRe.test(line)) return replaceLine(i);
	}

	// Pass 3: no trace of the key — append at the end, on its own line.
	const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
	return `${base}${key}=${renderEnvValue(value, opts)}\n`;
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
	const text = fs.readFileSync(path, "utf8");
	const next = (overwrite ? setEnvKey : setEnvKeyIfEmpty)(text, key, value, { platform });
	if (next === text) return { changed: false };
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
	//   `$(`, a backtick, `${N?}`   it runs, or ENDS the sourcing shell, and then no key is set at all
	//   an unbalanced `${`          the same: the shells abort on the syntax error
	//
	// A value's ordinary CONTENT is not judged here. `PI_LOGS_DIR=$HOME/logs` changes only its own line's
	// reading, which is what `plain` is for, and treating it as a file-wide hazard hid an EMPTY boot key two
	// lines below it. Nor is anything after a `#` that begins a comment.
	const spans = quoteSpans(bare, loader);
	const hazardLine = spans.hazard;
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
function quoteSpans(bare, loader) {
	const inside = bare.map(() => false);
	if (loader === "cmd") {
		// `for /f` reads one line at a time: no continuation, no multi-line value, no execution. Its only
		// cross-line hazard is a `"`, which closes the wrapper's own `set "%%A=%%B"` and makes the rest of
		// the line command. `renderEnvValue` refuses to WRITE that character for exactly this reason.
		const at = bare.findIndex((l) => (ASSIGNMENT.exec(l)?.[3] ?? "").includes('"'));
		return { inside, hazard: at === -1 ? null : at + 1 };
	}
	// PER LOADER, because the two POSIX loaders do different things with the same file, and one answer for
	// both was wrong for whichever one it was not written for. Measured on systemd 252:
	//
	//   a quote does NOT continue across lines. `OTHER='a'b'` reads as `ab'` and the NEXT line is read as an
	//   ordinary assignment, where every shell swallows it.
	//   a trailing backslash DOES continue, in both.
	//   a line it cannot parse is IGNORED -- `unset K`, `cat <<EOF`, `if false; then`, `OTHER=${NOPE?boom}`
	//   and `OTHER=(` are all inert to systemd, and all of them RUN in a sourcing shell.
	//
	// So the hazards below belong to the shells, and systemd's only cross-line mechanism is the backslash.
	// Judging a linux deployment by the shells' rules is what made an `unset FOO` in a `.env` hide an empty
	// boot key from systemd, which reads that key perfectly well.
	const runsLines = loader === "shell";
	let carry = { q: "", cont: false };
	let openedAt = null;
	let hazard = null;
	for (let i = 0; i < bare.length; i++) {
		const line = bare[i];
		const within = (runsLines && carry.q !== "") || carry.cont;
		inside[i] = within;
		if (!within && hazard === null && runsLines) {
			const t = line.trim();
			const m = ASSIGNMENT.exec(line);
			if (t !== "" && !t.startsWith("#") && (m === null || line.startsWith("\ufeff"))) hazard = i + 1;
			else if (m !== null && runsOrAborts(m[3])) hazard = i + 1;
		}
		const next = scanQuotes(line, runsLines ? carry.q : "");
		if (carry.q === "" && next.q !== "") openedAt = i + 1;
		carry = { q: next.q, cont: next.continuation };
	}
	// A quote the shells never see closed makes the WHOLE source fail, so from the line that opened it
	// nothing can be read. A backslash on the last line is the same for both loaders.
	if (hazard === null && runsLines && carry.q !== "") hazard = openedAt;
	if (hazard === null && carry.cont) hazard = bare.length;
	return { inside, hazard };
}

/**
 * Does this value RUN something, END the shell that is sourcing the file, or fail to parse?
 *
 * Narrow on purpose, and comment-aware, which the first version was not: it scanned the whole value, so an
 * inline comment holding a backtick (`NOTE=x # use `openssl rand``) made a file unreadable that all five
 * loaders read perfectly, and the empty boot key two lines below it went unreported.
 *
 *   `$(...)` and a backtick   command substitution: arbitrary code, arbitrary exit
 *   `${NAME?...}`             the error form: a non-interactive shell EXITS, so `set -a; . ./.env` aborts
 *                             and the wrapper never launches the worker, leaving EVERY key unset
 *   an unbalanced `${`        a syntax error, which aborts the same way. Measured through the real
 *                             `deploy/worker-env-wrapper.sh`: `unexpected EOF while looking for matching }`
 *   `( ) ; & | < >` unquoted  the line stops being an assignment: `OTHER=(` is a syntax error that aborts
 *                             the source, and `OTHER=a; exit 0` ends the wrapper before it launches
 *                             anything. Both leave EVERY key in the file unset
 *
 * `$HOME`, `${HOME}` and `${HOME:-/tmp}` change only their own line's value, which is what `plain` is for.
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
		if (c === "\\") {
			i += 1;
			afterBlank = false;
			continue;
		}
		if (q === "" && c === "#" && afterBlank) return false;
		if (q === "" && (c === "'" || c === '"')) q = c;
		else if (q === '"' && c === '"') q = "";
		else if (c === "`" || c === "(" || c === ")" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">") return true;
		else if (c === "$" && value[i + 1] === "(") return true;
		else if (c === "$" && value[i + 1] === "{") {
			const close = value.indexOf("}", i + 2);
			if (close === -1) return true;
			if (value.slice(i + 2, close).includes("?")) return true;
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
 */
function scanQuotes(text, q0) {
	let q = q0;
	let afterBlank = false;
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
			if (i === text.length - 1) return { q, continuation: true };
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
const UNQUOTED_PLAIN = /^(?!=)(?!.*:=)[A-Za-z0-9_@+:,./-]*$/;

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
 * The first line of this file that this command cannot read, or `null`. Same rule as the reader's.
 *
 * Exported because ABSENCE OF A READING IS NOT ABSENCE OF AN ASSIGNMENT, and doctor printed the second when
 * it had the first: a key with no record at all, in a file with a line like this in it, was reported as
 * "unset, so the worker ignores it". Answered for the cmd loader too, which an earlier version refused to
 * do -- so the one cross-line hazard Windows has was invisible to the caller that needed it.
 */
export function envFileHazard(text, { loader = "systemd" } = {}) {
	const lines = String(text ?? "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	const at = quoteSpans(lines, loader).hazard;
	return at === null ? null : { line: at };
}

function readValue(rest, loader) {
	if (loader === "cmd") {
		// `for /f "delims=="` takes the rest of the line verbatim, so there is no quoting and no comment.
		// An empty value UNSETS the variable there (`set "K="`), read from the wrapper's own source rather
		// than run on Windows.
		// Verbatim, so this loader's reading is never ambiguous: there is no quoting to strip, no comment
		// syntax, and no expansion. It can still DISAGREE with the POSIX loaders, which is why a caller asks
		// the loader its own deployment uses rather than blending them.
		return { plain: true, value: rest };
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
