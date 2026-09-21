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
 * The trailing `# ...` of a line being replaced, or `""`. `.env.example` documents most keys INLINE
 * (`# PI_LOGS_DIR=   # where per-job status records land`), and both transforms replace a line whole, so
 * without this an `up` that fills four commented keys silently deletes four lines of the operator's own
 * reference and leaves the indented continuation comments below them dangling under a now-set key.
 *
 * Only a `#` preceded by WHITESPACE counts, which is dotenv's own trailing-comment shape. A `#` with no
 * space in front of it is part of the old value (`#KEY=some#thing`), and that line is being replaced, so
 * turning half of it into a comment would be inventing one.
 */
function trailingComment(afterEquals) {
	return /\s(#.*)$/.exec(afterEquals)?.[1] ?? "";
}

/**
 * `KEY=value` plus the inline comment the replaced line carried, kept at ITS OWN COLUMN where the new text
 * still fits. `.env.example` lines the comments up at a fixed column and a file that keeps half of them
 * lined up and half not reads worse than one that lost them, so short values hold the column and long ones
 * (an absolute path, usually) fall back to a plain gap.
 */
function withKeptComment(key, value, bare) {
	const kept = trailingComment(bare.slice(bare.indexOf("=") + 1));
	if (kept === "") return `${key}=${value}`;
	const head = `${key}=${value}`;
	const column = bare.indexOf(kept);
	return `${head}${" ".repeat(Math.max(3, column - head.length))}${kept}`;
}

export function setEnvKeyIfEmpty(text, key, value) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const setRe = new RegExp(`^\\s*${escaped}\\s*=(.*)$`);
	const commentRe = new RegExp(`^\\s*#\\s*${escaped}\\s*=`);

	const lines = text.split("\n");
	// Replace a line wholesale, keeping a CRLF file's trailing \r so the file stays one convention, and
	// keeping any inline `# ...` documentation the line carried (see `trailingComment`).
	const replaceLine = (i) => {
		const bare = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		lines[i] = `${withKeptComment(key, value, bare)}${lines[i].endsWith("\r") ? "\r" : ""}`;
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
	const setRe = new RegExp(`^\\s*${escaped}\\s*=`);
	const commentRe = new RegExp(`^\\s*#\\s*${escaped}\\s*=`);

	const lines = text.split("\n");
	const replaceLine = (i) => {
		const bare = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
		lines[i] = `${withKeptComment(key, value, bare)}${lines[i].endsWith("\r") ? "\r" : ""}`;
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
 * Same line grammar as the writers above, so a key this can read is a key those can set: a commented line
 * is not a value, a later duplicate does not win over an earlier one, and an empty or whitespace-only value
 * is absent rather than `""`.
 */
export function readEnvKeys(text, keys) {
	const want = new Set(keys);
	const found = {};
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!m) continue;
		const [, key, rest] = m;
		if (!want.has(key) || key in found) continue;
		// The same inline comment the writers above preserve has to come back OFF here, or a caller comparing
		// a path would compare it against the path plus a paragraph. Dotenv's own trailing-comment shape:
		// a `#` preceded by whitespace. A `#` with no space in front of it is part of the value.
		const value = rest.replace(/\s#.*$/, "").trim();
		if (value !== "") found[key] = value;
	}
	return found;
}
