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
 * EVERY LOADER IS ASKED, so a key that is blank for one and set for another is not blank: a bare `KEY=`
 * with a later `export KEY=/v.json` is empty under `EnvironmentFile=` and configured under the POSIX
 * wrapper, and calling that "blank" would tell half the operators their configured key is empty. A loader
 * that does not see the key at all does not vote, which is what keeps a cmd-only or systemd-only shape from
 * reading as blank because another loader ignored it.
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
	const hazards = loader === "cmd" ? [] : lines.map((l, i) => [i, lineHazard(l.endsWith("\r") ? l.slice(0, -1) : l)]).filter(([, h]) => h !== "");
	// A SWALLOWING hazard reaches forward into the lines below it: an unclosed quote or a trailing backslash
	// makes the next line part of this value in every shell, so a line under one is not a line at all. Nothing
	// else reaches a specific line -- a stray command can do anything, but it cannot turn `K=""` into a value.
	const swallowsFrom = hazards.find(([, h]) => h === "open-quote" || h === "continuation")?.[0] ?? Infinity;
	// EVERYTHING ELSE takes the vouch off the whole file, in both directions, measured on systemd 252 against
	// /bin/sh, bash, dash and zsh:
	//
	//   K=/a.json      the shells swallow the next line into the open quote; systemd 252 reads `ab'` and
	//   OTHER='a'b'    carries on, so a key BELOW an unbalanced quote is worth two different things
	//   K=/a.json      the shells clear K; systemd ignores the line as an invalid assignment and keeps the
	//   unset K        value, so a key ABOVE a stray command is worth two different things too
	//
	// The cmd wrapper is exempt from all of it: its `for /f` takes one line at a time with no quoting, no
	// continuation and no execution, so no line there can reach across to another.
	const hazardLine = hazards.length > 0 ? hazards[0][0] + 1 : null;
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
		const crBreaks = hadCR && loader !== "cmd";
		const plain = read.plain && !crBreaks && i <= swallowsFrom;
		// The LAST assignment, because every loader takes it: `set -a; . ./.env`, `EnvironmentFile=` and the
		// cmd wrapper's `set` all overwrite as they go.
		found[key] = { value: plain ? read.value : null, plain, vouched: plain && hazards.length === 0, blank: loader !== "cmd" && assignsNothing(rest), line: i + 1, hazardLine };
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
 * How does this line reach past itself, if it does? `""` means it does not.
 *
 *   "open-quote" / "continuation"  it swallows the line BELOW it, so that line is not a line
 *   "runs"                         the shells execute it, and this reader cannot know what it does
 */
function lineHazard(line) {
	// A BOM'd line is a command to the shells and a dropped assignment to systemd (measured), so it is a
	// hazard whatever it looks like. Equivalent to falling through today -- `trim()` strips a BOM, so the
	// line reaches the "runs" branch below anyway -- and kept for the same reason as its twin above.
	if (line.startsWith("\ufeff")) return "runs";
	const m = ASSIGNMENT.exec(line);
	if (!m) {
		const bare = line.trim();
		return bare !== "" && !bare.startsWith("#") ? "runs" : "";
	}
	const tail = openTail(m[3]);
	if (tail !== "") return tail;
	// EXPANSION IS EXECUTION. `$` and a backtick outside single quotes make the line arbitrary code in every
	// shell and a literal to systemd, and the shapes are not all harmless: `OTHER=${NOPE?boom}` and
	// `OTHER=$(kill -9 $$)` END the sourcing shell, so `deploy/worker-env-wrapper.sh` exits before it ever
	// launches the worker and EVERY key in the file is unset -- while this reader was happily vouching for
	// the lines below. A value this reader cannot evaluate is a value it cannot reason past.
	return unquotedExpansion(m[3]) ? "runs" : "";
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
 * The rule is deliberately tiny and does not guess: after a trailing CR and trailing blanks come off, the
 * text is nothing, or one matched empty quote pair, optionally followed by a comment. `K=''`, `K=""`,
 * `K=`, `K=   `, `K="" # tbd` and their CRLF spellings are the whole set. Anything else, `K="" x`
 * included, is a value this cannot vouch for and therefore never calls empty.
 *
 * NOT for the cmd wrapper, which is why the caller passes the loader: `set "K="` UNSETS there, so an empty
 * value is an absent key rather than a blank one, and calling it blank made doctor fail a Windows
 * deployment that starts.
 */
function assignsNothing(rest) {
	return /^(?:''|"")?[ \t]*(?:#[^\n]*)?$/.test(rest.replace(/\r+$/, "").replace(/[ \t]+$/, ""));
}

/** Is there a `$` or a backtick outside SINGLE quotes, where the shells expand and systemd does not? */
function unquotedExpansion(rest) {
	let q = "";
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i];
		if (q === "'") {
			if (c === "'") q = "";
			continue;
		}
		if (q === '"') {
			// Double quotes stop word splitting and globbing, and nothing else: `"$x"` and "`x`" both still run.
			if (c === "\\") i += 1;
			else if (c === '"') q = "";
			else if (c === "$" || c === "`") return true;
			continue;
		}
		if (c === "\\") i += 1;
		else if (c === "'" || c === '"') q = c;
		else if (c === "#" && (i === 0 || rest[i - 1] === " " || rest[i - 1] === "\t")) return false;
		else if (c === "$" || c === "`") return true;
	}
	return false;
}

/**
 * Does this value text leave a quote open, or end in the backslash that makes the next line part of it?
 *
 * A scan rather than a look at the first character, which is what it was and which missed `K='a'b'`: the
 * first quote closes at index 2, the THIRD one opens and never closes, and every shell then reads the next
 * line as more of this value. Comments are honoured because the shells honour them, so the apostrophe in
 * `K=/a.json # it's fine` is not an open quote, and a `#` that is not preceded by whitespace is not a
 * comment (`K=a#b` is one word).
 */
function openTail(rest) {
	let q = "";
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i];
		if (q === "'") {
			if (c === "'") q = "";
			continue;
		}
		if (q === '"') {
			if (c === "\\") i += 1;
			else if (c === '"') q = "";
			continue;
		}
		if (c === "\\") {
			if (i === rest.length - 1) return "continuation";
			i += 1;
			continue;
		}
		if (c === "'" || c === '"') q = c;
		else if (c === "#" && (i === 0 || rest[i - 1] === " " || rest[i - 1] === "\t")) return "";
	}
	return q === "" ? "" : "open-quote";
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
const QUOTED_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

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
 * Does one line of this file reach past itself, and on which line? `null` when none does.
 *
 * Exported because ABSENCE OF A READING IS NOT ABSENCE OF AN ASSIGNMENT, and doctor printed the second when
 * it had the first. A BOM'd line, a `K+=` line, a `declare K=` line and a line the shells simply run all
 * leave this reader with no record for the key, and "no record" was rendered as "the key is unset, so the
 * worker ignores it" -- about files that do set the key.
 */
export function envFileHazard(text, { loader = "systemd" } = {}) {
	if (loader === "cmd") return null;
	const lines = String(text ?? "").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const kind = lineHazard(lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i]);
		if (kind !== "") return { line: i + 1, kind };
	}
	return null;
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
