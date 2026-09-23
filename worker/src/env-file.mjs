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
	// `.trim()`, not `=== ""`, and the difference is one loader: `K=   ` is empty to systemd and to a sourcing
	// shell, which both drop trailing whitespace, and two spaces to the cmd wrapper, which splits on the first
	// `=` and keeps the rest. Nothing downstream can use two spaces either -- `existsSync("  ")` is false and
	// the boot refuses the same way -- so the question this answers is "does any loader see something usable",
	// and a reading this file cannot vouch for (`plain: false`, `value: null`) is never called blank.
	return readings.every((r) => r.value !== null && r.value.trim() === "");
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
	// A BOM belongs to the first line, and systemd then drops that assignment entirely (measured). Nothing
	// later is affected, so this costs exactly one line rather than the file.
	const bom = raw.startsWith("\ufeff");
	const lines = raw.split("\n");
	// POISON: one line elsewhere in the file can decide what THIS key is worth, so a file carrying one gets no
	// plain reading at all. The whole file, not "every line after it", which is what this rule said first and
	// was measured wrong in both directions (systemd 252 against /bin/sh, bash and dash):
	//
	//   K=/a.json      the shells swallow the next line into the open quote; systemd 252 reads `ab'` and
	//   OTHER='a'b'    carries on, so a key BELOW an unbalanced quote is worth two different things
	//   K=/a.json      the shells clear K; systemd ignores the line as an invalid assignment and keeps the
	//   unset K        value, so a key ABOVE a stray command is worth two different things too
	//
	// A line that is neither blank, a comment, nor an assignment is the same hazard in general form: the
	// shells RUN it, and this reader cannot know what it does. The cmd wrapper is exempt from all of it -- its
	// `for /f` takes one line at a time with no quoting, no continuation and no execution, so no line there
	// can reach across to another.
	const poisoned = loader === "cmd" ? false : lines.some((l) => lineIsHazard(l.endsWith("\r") ? l.slice(0, -1) : l));
	for (let i = 0; i < lines.length; i++) {
		const hadCR = lines[i].endsWith("\r");
		const line = (hadCR ? lines[i].slice(0, -1) : lines[i]).replace(/^\ufeff/, "");
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
		const plain = read.plain && !poisoned && !(i === 0 && bom) && !hadCR;
		// The LAST assignment, because every loader takes it: `set -a; . ./.env`, `EnvironmentFile=` and the
		// cmd wrapper's `set` all overwrite as they go.
		found[key] = { value: plain ? read.value : null, plain, line: i + 1 };
	}
	return found;
}

// The name is followed DIRECTLY by `=`, with no space, because that is the only shape that is an
// assignment at all: `K =/a.json` runs a command named `K` in every shell, and systemd 252 rejects the
// line. Such a line is therefore a hazard rather than a lax assignment, which is where `setEnvKeyIfEmpty`
// deliberately differs -- it is looking for a line to REWRITE, and it normalises the spacing when it does.
const ASSIGNMENT = /^[ \t]*(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Does this line reach past itself, or do something this reader cannot model? */
function lineIsHazard(line) {
	const m = ASSIGNMENT.exec(line.replace(/^\ufeff/, ""));
	if (!m) {
		const bare = line.trim();
		return bare !== "" && !bare.startsWith("#");
	}
	return openTail(m[3]) !== "";
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
 *   `"..."`                -> the inner text, printable ASCII without `"`, `$`, `\` or a backtick
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
 * A control byte inside quotes is NOT plain, with one exception that is measured rather than tolerated: a
 * TAB, which systemd 252 and all three shells keep byte for byte inside single quotes. `renderEnvValue`
 * quotes a tab-bearing path rather than refusing it, so excluding tab here would have made this reader
 * refuse to vouch for a line `up` itself wrote. CR is excluded because a line ending in one is already not
 * plain, and a lone CR mid-value is a display hazard with no legitimate source.
 */
const QUOTED_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

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
