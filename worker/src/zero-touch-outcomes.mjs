import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fixHistoryRetentionMs } from "./zero-touch-fixes.mjs";

/**
 * The outcome of a zero touch fix, kept where it does not need Valkey (issue #1072): one small file per fix under the
 * console's logs folder, `<PI_LOGS_DIR>/zero-touch-outcomes/<fixId>.json`, holding `{ v: 1, outcome, at }`.
 *
 * Why it exists. A fix's row is staged `pending` before its change, then committed or refused. When Valkey does not
 * answer that last write, the row stays pending, and the fix store alone cannot tell a change that landed from one that
 * was refused: a settle commits a pending row as soon as its file or trigger shows the change's bytes. A refused change
 * whose bytes are written later (the same change made again, or by hand) then read as a second fix. The console knows
 * the outcome when it writes that mark, so it writes this file first, then the mark, and removes the file once the mark
 * is answered; the fix store's proof (`settleable`) reads it before the bytes. A row with no file keeps the byte rule.
 *
 * The write is `touch-outbox.mjs`'s: a temporary file renamed over the name, so a reader sees a whole file or none, in a
 * folder of mode 0700 with files of 0600. It holds no text: an opaque id, one of two words, a time.
 *
 * REJECTED: the outcome in the fix's own record or a new Valkey key. The fact is needed exactly when Valkey did not
 * answer, and a new key in the record makes an older console's `validFix` drop the row (its keys are a closed set).
 */
export const ZERO_TOUCH_OUTCOMES_DIR = "zero-touch-outcomes";
export const FIX_OUTCOMES = Object.freeze(["applied", "refused"]);
const ID_RE = /^[a-f0-9]{32}$/;
const NAME_RE = /^([a-f0-9]{32})\.json$/;
// The reaper also removes what a write that stopped between its two steps left behind.
const LEFT_RE = /^[a-f0-9]{32}\.json(?:\.tmp)?$/;
// A file is about 60 bytes. Anything larger is not one of these.
const FILE_MAX_BYTES = 256;

/** The file's content, or null for anything that is not exactly the shape this module writes. */
export function parseZeroTouchOutcome(text) {
	let row;
	try { row = JSON.parse(text); } catch { return null; }
	if (!row || typeof row !== "object" || Array.isArray(row)) return null;
	if (Object.keys(row).sort().join() !== "at,outcome,v" || row.v !== 1 || !FIX_OUTCOMES.includes(row.outcome) || !Number.isSafeInteger(row.at) || row.at < 0) return null;
	return row;
}

export function makeZeroTouchOutcomes({ dir, fs = nodeFs, now = Date.now, log = () => {} } = {}) {
	const path = (id) => join(dir, `${id}.json`);
	// A file that is a plain file of its size, read whole; a link or a folder under the name is not an outcome.
	const readFile = (name) => {
		const stat = fs.lstatSync(join(dir, name));
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_MAX_BYTES) return null;
		return parseZeroTouchOutcome(fs.readFileSync(join(dir, name), "utf8"));
	};
	return {
		/**
		 * Writes the outcome, answering whether it did. A failure is logged by its code and answered false: the caller
		 * goes on as before this file existed, and the row keeps the byte rule.
		 */
		record(id, outcome) {
			if (!dir || !ID_RE.test(id ?? "") || !FIX_OUTCOMES.includes(outcome)) return false;
			try {
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
				fs.writeFileSync(`${path(id)}.tmp`, JSON.stringify({ v: 1, outcome, at: now() }), { mode: 0o600 });
				fs.renameSync(`${path(id)}.tmp`, path(id));
				return true;
			} catch (err) {
				log("zero_touch_outcome_unwritten", { cause: typeof err?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "error" });
				return false;
			}
		},
		/** The outcome recorded for one fix, or null: none, or a file that cannot be read as one. */
		read(id) {
			if (!dir || !ID_RE.test(id ?? "")) return null;
			try { return readFile(`${id}.json`)?.outcome ?? null; } catch { return null; }
		},
		/** Never throws: a file already gone is what was asked for. */
		remove(id) {
			if (!dir || !ID_RE.test(id ?? "")) return;
			try { fs.unlinkSync(path(id)); } catch { /* gone, or never written */ }
		},
		/**
		 * Every outcome the folder holds, from one listing: a map of fix id to outcome, and how many files under an
		 * outcome's name could not be read as one. The fix store's proof asks it per row, so a page view reads the folder
		 * once, not a file per row of the history.
		 */
		inspect() {
			const outcomes = new Map();
			let invalid = 0;
			let names;
			try { names = fs.readdirSync(dir); } catch { return { outcomes, invalid }; }
			for (const name of names) {
				const id = NAME_RE.exec(name)?.[1];
				if (!id) continue;
				let row;
				try { row = readFile(name); } catch { row = null; }
				if (row) outcomes.set(id, row.outcome);
				else invalid++;
			}
			if (invalid > 0) log("zero_touch_outcome_unreadable", { files: invalid });
			return { outcomes, invalid };
		},
	};
}

/**
 * The worker's reaper of the folder (issue #1072), in its retention sweep. A file outlives its use only where its row
 * went first: a settle removes the file of every row it settles and of every row that no longer reads pending, so what
 * is left is a file whose row is gone, or whose stage never landed. Such a file is removed once its outcome is older
 * than the fix history's retention (its `at`; the file's last write when it cannot be read), when its row has expired
 * too. Nothing of another name is touched. Never throws.
 */
export function makeZeroTouchOutcomeReaper({ logsDir, retentionDays, fs = nodeFs, log = () => {}, now = () => Date.now() }) {
	const dir = join(logsDir, ZERO_TOUCH_OUTCOMES_DIR);
	const retentionMs = fixHistoryRetentionMs(retentionDays);
	return async function reapZeroTouchOutcomes({ stopped = () => false } = {}) {
		let names;
		try { names = fs.readdirSync(dir); } catch (err) {
			if (err?.code !== "ENOENT") log("zero_touch_outcomes_reaper_skipped", { reason: err?.code ?? "error" });
			return { removed: 0 };
		}
		const cutoff = now() - retentionMs;
		let removed = 0;
		for (const name of names.filter((n) => LEFT_RE.test(n))) {
			await new Promise((resolve) => setImmediate(resolve));
			if (stopped()) break;
			try {
				const stat = fs.lstatSync(join(dir, name));
				if (!stat.isFile()) continue;
				let at = stat.mtimeMs;
				if (!name.endsWith(".tmp") && stat.size <= FILE_MAX_BYTES) at = parseZeroTouchOutcome(fs.readFileSync(join(dir, name), "utf8"))?.at ?? at;
				if (at < cutoff) { fs.unlinkSync(join(dir, name)); removed++; }
			} catch (err) {
				log("zero_touch_outcomes_reaper_skipped", { reason: err?.code ?? "error" });
			}
		}
		if (removed > 0) log("reaped_zero_touch_outcomes", { removed });
		return { removed };
	};
}
