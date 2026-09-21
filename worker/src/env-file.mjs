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
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

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
function replacementLines(key, value, bare, wasComment) {
	return wasComment ? [bare, `${key}=${value}`] : [`${key}=${value}`];
}

export function setEnvKeyIfEmpty(text, key, value) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `export ` is part of the SET shape here, and that is a never-clobber decision rather than dotenv
	// pedantry: the wrapper scripts source this file with `set -a; . ./.env`, where `export KEY=value` is an
	// ordinary assignment the operator made. Without it the key reads as absent, a second assignment is
	// appended, and the shell takes the LAST one -- so filling four "empty" keys would replace four values
	// the operator set, in one pass, with no prompt. The reader is deliberately stricter (see `readEnvKeys`):
	// there, missing a value only costs a fuller warning, where missing one HERE costs the value itself.
	const setRe = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=(.*)$`);
	const commentRe = new RegExp(`^\\s*#\\s*(?:export\\s+)?${escaped}\\s*=`);

	const lines = text.split("\n");
	// Replace a line wholesale, keeping a CRLF file's trailing \r so the file stays one convention, and
	// keeping any inline `# ...` documentation the line carried (see `trailingComment`).
	const replaceLine = (i) => {
		const crlf = lines[i].endsWith("\r") ? "\r" : "";
		const bare = crlf === "" ? lines[i] : lines[i].slice(0, -1);
		lines.splice(i, 1, ...replacementLines(key, value, bare, commentRe.test(bare)).map((l) => `${l}${crlf}`));
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
	return `${base}${key}=${value}\n`;
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
export function setEnvKey(text, key, value) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `export ` counts as set here too, for the reason `setEnvKeyIfEmpty` gives.
	const setRe = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`);
	const commentRe = new RegExp(`^\\s*#\\s*(?:export\\s+)?${escaped}\\s*=`);

	const lines = text.split("\n");
	const replaceLine = (i) => {
		const crlf = lines[i].endsWith("\r") ? "\r" : "";
		const bare = crlf === "" ? lines[i] : lines[i].slice(0, -1);
		lines.splice(i, 1, ...replacementLines(key, value, bare, commentRe.test(bare)).map((l) => `${l}${crlf}`));
		return lines.join("\n");
	};

	// Pass 1: the FIRST set line, whatever its value — this is the overwrite discipline. Already
	// exactly `KEY=value` (modulo the CRLF tail) → the input object back, so the wrapper skips the write.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (!setRe.test(line)) continue;
		if (line === `${key}=${value}`) return text;
		return replaceLine(i);
	}

	// Pass 2: a commented-out `# KEY=` line (only reachable when no set line exists at all).
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		if (commentRe.test(line)) return replaceLine(i);
	}

	// Pass 3: no trace of the key — append at the end, on its own line.
	const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
	return `${base}${key}=${value}\n`;
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
	const { fs = { readFileSync, writeFileSync, renameSync, statSync, chmodSync }, overwrite = false } = deps;
	const text = fs.readFileSync(path, "utf8");
	const next = (overwrite ? setEnvKey : setEnvKeyIfEmpty)(text, key, value);
	if (next === text) return { changed: false };
	const tmp = `${path}.tmp`;
	fs.writeFileSync(tmp, next);
	try {
		if ((fs.statSync(path).mode & 0o777) === 0o600) fs.chmodSync(tmp, 0o600);
	} catch {
		// The file vanished between read and write, or the fs cannot stat: leave the tmp's default
		// mode rather than failing an edit that is otherwise sound.
	}
	fs.renameSync(tmp, path);
	return { changed: true };
}

/**
 * The values of NAMED keys in .env TEXT, as a plain object holding only the keys that are actually set.
 *
 * Deliberately NOT a dotenv loader, and the distinction is the whole reason this is allowed to exist
 * (issue #357). Nothing in this project loads `.env` into a process environment: `docs/secrets.md` opens
 * with "the worker parses no `.env` file", and `worker/test/service.test.mjs` pins that a `PI_ENV_SETUP`
 * line inside `./.env` is deliberately NOT honoured. This reader exists so `doctor` can decide WHAT TO SAY
 * about a file, never what to configure, and the caller passes the exact keys its own message names. It
 * returns strings verbatim; no interpolation, no `export ` prefix, no quote stripping, because every one of
 * those is a loader feature and a loader is what this must not become.
 *
 * A commented line is not a value, and an empty or whitespace-only one is absent rather than `""`. Two
 * rules differ from the writers above, each on purpose. The LAST occurrence wins and an empty one counts,
 * because that is what `set -a; . ./.env` and `EnvironmentFile=` do, and this must report what the service
 * SEES rather than where a value belongs. And `export KEY=` is NOT read, because honouring a shell prefix
 * is a loader feature; missing a value here only costs a fuller warning, which is the safe direction,
 * while missing one in the writers would cost the operator's value itself.
 */
export function readEnvKeys(text, keys) {
	const want = new Set(keys);
	const found = {};
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!m) continue;
		const [, key, rest] = m;
		if (!want.has(key)) continue;
		// An inline comment comes OFF, or a caller comparing a path would compare it against the path plus a
		// paragraph. The rule is the shell's, measured in sh, bash and zsh against every shape in this file:
		// a `#` preceded by whitespace starts a comment, a `#` with nothing in front of it is part of the
		// value, and inside QUOTES neither is true. That last case is why the quote check is here rather
		// than left as a rounding error: a quoted value holding ` #` is legal, the shells keep it whole, and
		// truncating it would report a path this deployment does not use.
		const trimmed = rest.trim();
		const value = /^["']/.test(trimmed) ? trimmed : trimmed.replace(/\s#.*$/, "").trim();
		// The LAST occurrence wins, and an empty one counts as an occurrence, because that is what every
		// actual consumer of this file does: `set -a; . ./.env` and `EnvironmentFile=` both take the last
		// assignment. Taking the first instead would let this report a value the service never sees, and on
		// a file whose earlier line is real and whose later one is empty that turns a warning about a
		// genuinely unconfigured deployment into "nothing to fix". The writers above deliberately differ:
		// the first EMPTY line is where a value belongs, which is a question about where to write rather
		// than about what is in force.
		if (value === "") delete found[key];
		else found[key] = value;
	}
	return found;
}
