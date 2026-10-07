/**
 * The run records a size suggestion reads (issue #596, phase 3, DES-SIZE-SUGGESTIONS), read ONCE per doctor run, panel
 * view or insights render and handed to `suggestSize` for every project. Doctor and the admin share this reader, so the
 * bounds below hold on every surface:
 *
 *   - an MTIME PREFILTER: a file the worker last wrote before the window (plus a day for skew) is not opened. A
 *     keep-forever logs directory (`PI_LOG_RETENTION_DAYS=0`) is otherwise read whole on every render;
 *   - a SIZE CAP per file (`SIZING_RECORD_MAX_BYTES`, 256 KiB): a larger file is skipped and COUNTED, never parsed. A
 *     run record is a few KiB; the cap keeps a hand-placed or corrupted giant from costing a render its memory, and
 *     the count says it happened rather than leaving a silent hole;
 *   - the NEWEST `SUGGEST_WINDOW_RUNS` per project are kept (by `endedAt`), since no suggestion reads more.
 *
 * Never throws: an absent directory holds no records; another unreadable one is `unreachable` (doctor reads that as
 * none, the panel says it).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SUGGEST_WINDOW_DAYS, SUGGEST_WINDOW_RUNS } from "./size-suggest.mjs";

/** The largest run record a size suggestion parses: 256 KiB. A larger one is skipped and counted. */
export const SIZING_RECORD_MAX_BYTES = 256 * 1024;
/** How far back a file's mtime may lie and still be opened: the window plus a day of skew. */
export const SIZING_MTIME_DAYS = SUGGEST_WINDOW_DAYS + 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `{ records, skipped, unreachable }`: the parsed records (at most SUGGEST_WINDOW_RUNS per project, newest first by
 * `endedAt`; a record with no string `project` or no readable `endedAt` is dropped, since no suggestion could read it),
 * how many files were skipped for their size, and null or a reason when the directory itself could not be listed.
 * `fs` is `{ readdirSync, statSync, readFileSync }`.
 */
export function readSizingRecords(logsDir, { nowMs, fs = { readdirSync, readFileSync, statSync } } = {}) {
	const since = nowMs - SIZING_MTIME_DAYS * DAY_MS;
	let names;
	try {
		names = fs.readdirSync(logsDir);
	} catch (err) {
		return { records: [], skipped: 0, unreachable: err?.code === "ENOENT" ? null : `logs dir unreadable (${err?.code ?? "read-error"})` };
	}
	const byProject = new Map();
	let skipped = 0;
	for (const name of names) {
		if (typeof name !== "string" || !name.endsWith(".json")) continue;
		try {
			const path = join(logsDir, name);
			const st = fs.statSync(path);
			if (!st.isFile() || st.mtimeMs < since) continue;
			if (st.size > SIZING_RECORD_MAX_BYTES) {
				skipped++;
				continue;
			}
			const buf = fs.readFileSync(path);
			if (buf.length > SIZING_RECORD_MAX_BYTES) {
				skipped++; // it grew between the stat and the read
				continue;
			}
			const record = JSON.parse(buf.toString("utf8"));
			const at = typeof record?.endedAt === "string" ? Date.parse(record.endedAt) : NaN;
			if (typeof record?.project !== "string" || !Number.isFinite(at)) continue;
			if (!byProject.has(record.project)) byProject.set(record.project, []);
			byProject.get(record.project).push({ at, record });
		} catch {
			// unparseable, or reaped between the listing and the read
		}
	}
	const records = [];
	for (const list of byProject.values()) {
		list.sort((a, b) => b.at - a.at);
		for (const { record } of list.slice(0, SUGGEST_WINDOW_RUNS)) records.push(record);
	}
	return { records, skipped, unreachable: null };
}
