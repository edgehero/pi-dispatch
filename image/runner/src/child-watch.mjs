/**
 * The parent's side of child metering (issue #500 part E; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): the `children`
 * hook run-job.mjs hands installProcessUsageMeter. On every tick of the meter's re-arm interval (1 s) and once at
 * teardown it folds the children's ledgers into the job's meter, writes the two control files the children read
 * (SPENT, STOP), applies the stop rules on the job's whole spend, and looks for pi processes that report through no
 * ledger at all.
 *
 * No pi import: this file loads only usage-meter.mjs, child-route.mjs and node built-ins.
 *
 * ONE PASS (tick or teardown), in this order:
 *   1. FOLD. foldChildLedgers with the last pass's result as `prev`. A ledger directory that cannot be listed
 *      (`missing`: the agent removed it) is made again, mode 0700, and counted once as unmetered: what was in it is
 *      gone, and children may have written into nothing.
 *   2. DETECT (Linux only: it reads /proc; elsewhere there is no detector). Every process but this one and pid 1 is
 *      checked; a pi process is one whose argv[0] is `pi` or `pi-rpc` (the titles setupCli and the rpc entries set),
 *      or one with an argv element that realpaths to one of the pinned pi's five session entries or to run-job.mjs.
 *      A pi process is UNMETERED when no ledger names its pid two ticks after it was first seen, or at teardown if it
 *      was ever seen alive and no ledger ever named it. A ledger still `starting` more than STARTING_GRACE_MS after
 *      this parent first saw it, while its process lives, is unmetered (its meter never installed); a `starting`
 *      ledger of a DEAD process with zero spend is a child that ended before its meter started, and is done.
 *   3. JUDGE. The fold goes to meter.setChildren with `unmetered` and `processes` widened by what the detector found
 *      (the token cap is judged there, on parent plus children). Then, first stop wins:
 *      - under a dollar cap: the parent's settled spend plus every child's `spentMicros` past the cap, or any child
 *        `costRefused`, is `cost-cap`;
 *      - under a model list: any child `modelRefused`, or any child row whose pair is not on the PARENT's list (a
 *        spawner can widen a child's own list), or a child row with no model at all, is `model-not-allowed`;
 *      - any unmetered child: one `unmetered_child` line (the first time), then the stop an unmetered child gets:
 *        `cost-cap` under a dollar cap, else `token_budget` under a token cap, else `model-not-allowed` under a list.
 *        With no policy it is a floor only, and nothing stops.
 *   4. WRITE (ticks only). SPENT under a dollar cap (spentFile: the parent's spent and in flight plus each ledger's),
 *      and STOP with the meter's reason once it has stopped, rewritten on every tick so a deleted STOP comes back.
 *      The parent's own failure to write either is counted once as unmetered: a child it cannot reach is a child it
 *      cannot hold to the cap.
 *
 * TEARDOWN: STOP first (the meter's reason, or `token_budget` when the job ended without a stop: past the final fold no
 * child call could be counted), then the final pass, then the ledger directory is removed. A child call in flight at
 * the STOP shows in the final fold as `unresolved`. The teardown line gains `distinct` and `peak` (pi processes the
 * detector saw, null with no detector) and `unmetered`.
 *
 * The parent's cost guard reads `external()`: every child's `spentMicros + inflightMicros` as of the last fold.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_ENTRIES, RUN_JOB_PATH } from "./child-route.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "./outcome.mjs";
import { foldChildLedgers, SPENT_FILE, spentFile, STOP_FILE, stopFile, writeFileAtomic } from "./usage-meter.mjs";

/** How long a ledger may stay `starting` while its process lives: from the preload's stub to the meter's install (M5). */
export const STARTING_GRACE_MS = 10_000;
/** How many ticks a pi process may live with no ledger before it is unmetered. */
export const NO_LEDGER_TICKS = 2;
/** The command-line titles pi gives itself (setupCli: `pi`; the rpc entries: `pi-rpc`). */
export const PI_TITLES = Object.freeze(["pi", "pi-rpc"]);

/** The fold of a directory with nothing in it: what setChildren gets before the first tick, so the keys are there. */
function emptyFold() {
	return { processes: 0, unmetered: 0, flooded: 0, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0 }, rows: [], spentMicros: 0, inflightMicros: 0, costRefused: 0, modelRefused: 0, missing: false, files: new Map() };
}

/** Whether a ledger's mark holds any spend at all. */
function spent(high) {
	return Object.values(high.totals).some((value) => value !== 0) || high.spentMicros !== 0 || high.inflightMicros !== 0 || high.rows.size > 0;
}

/**
 * Whether a process with these arguments (from /proc/<pid>/cmdline, split on NUL, empties dropped) is a pi process:
 * argv[0] is one of PI_TITLES, or an element whose basename is one of `basenames` realpaths (`resolve`) to one of
 * `targets`. `resolve(element)` returns a real path or null; a relative element is the caller's to resolve against the
 * process's own working directory.
 */
export function isPiProcess(argv, { basenames, targets, resolve }) {
	if (!Array.isArray(argv) || argv.length === 0) return false;
	if (PI_TITLES.includes(argv[0])) return true;
	for (const element of argv) {
		if (!basenames.has(basename(element))) continue;
		const real = resolve(element);
		if (real !== null && targets.has(real)) return true;
	}
	return false;
}

/** The pinned pi's package root, as this runner resolves it (the copy the preload names too). */
function defaultPackageDir() {
	return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

/**
 * The Linux detector's view of /proc: `scan()` lists the pids of pi processes (this one and pid 1 excluded), `alive(pid)`
 * whether a process exists and is not a zombie. Null off Linux. Never throws: a process that vanishes mid-read, or
 * one whose files cannot be read, is skipped.
 */
export function linuxProc({ self = process.pid, platform = process.platform, packageDir = defaultPackageDir, runJob = RUN_JOB_PATH, fs = { readdirSync, readFileSync, realpathSync } } = {}) {
	if (platform !== "linux") return null;
	let targets = null;
	const basenames = new Set([...PI_ENTRIES.map((entry) => basename(entry.path)), basename(runJob)]);
	function realTargets() {
		if (targets !== null) return targets;
		targets = new Set();
		let root = null;
		try {
			root = packageDir();
		} catch {
			// No pi to resolve: only the titles and run-job.mjs are matched.
		}
		for (const path of [...(root === null ? [] : PI_ENTRIES.map((entry) => join(root, entry.path))), runJob]) {
			try {
				targets.add(fs.realpathSync(path));
			} catch {
				// An entry this pin does not ship cannot be run.
			}
		}
		return targets;
	}
	return {
		scan() {
			const found = [];
			let names;
			try {
				names = fs.readdirSync("/proc");
			} catch {
				return found;
			}
			for (const name of names) {
				if (!/^[1-9][0-9]*$/.test(name)) continue;
				const pid = Number(name);
				if (pid === self || pid === 1) continue;
				let argv;
				try {
					argv = fs.readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\u0000").filter((part) => part !== "");
				} catch {
					continue;
				}
				const resolve = (element) => {
					try {
						return fs.realpathSync(isAbsolute(element) ? element : join(`/proc/${pid}/cwd`, element));
					} catch {
						return null;
					}
				};
				if (isPiProcess(argv, { basenames, targets: realTargets(), resolve })) found.push(pid);
			}
			return found;
		},
		alive(pid) {
			try {
				const stat = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
				const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
				return state !== "Z" && state !== "X" && state !== "x";
			} catch {
				return false;
			}
		},
	};
}

/**
 * The parent's children hook. `dir` is the ledger directory (null when none could be made: then nothing is folded or
 * written, and the detector alone sees the children). `guard()` returns the parent's policy guard or null (late, because
 * the guard's `external` is this hook's). Everything that touches the system is injected for the tests.
 * Returns `{ sample, teardown, external, stopped, view }`: the two hook methods, the parent cost guard's `external`,
 * `stopped()` for the meter's onStop (writes STOP at once rather than on the next tick), and `view()` (the counts).
 */
export function createChildWatch({
	dir,
	meter,
	guard = () => null,
	log = () => {},
	proc = linuxProc(),
	now = () => Date.now(),
	fold = foldChildLedgers,
	foldFs,
	writeFs,
	mkdir = (path) => mkdirSync(path, { mode: 0o700 }),
	lstat = lstatSync,
	remove = (path) => rmSync(path, { recursive: true, force: true }),
}) {
	let prev = null;
	let ticks = 0;
	let peak = 0;
	/** pid -> the tick it was first seen alive, for every pi process the detector ever saw. */
	const seen = new Map();
	/** pids of pi processes no ledger named in time. */
	const noLedger = new Set();
	/** ledger name -> when this parent first saw it `starting`. */
	const startingSince = new Map();
	/** ledger names held `starting` past the grace, or dead `starting` with spend. */
	const stuck = new Set();
	let dirLost = false;
	let writeFailed = false;
	let firstWhy = null;
	let warned = false;
	let count = 0;
	// After teardown nothing is written: the directory is gone, and a write would make it again.
	let closed = false;

	const current = () => prev ?? emptyFold();
	const note = (why, pid = null) => {
		if (firstWhy === null) firstWhy = { why, pid };
	};

	/** The unmetered count: every file the fold or the detector judged, flooded names, and the parent's own losses. */
	function unmeteredCount(view) {
		let total = view.flooded + noLedger.size + (dirLost ? 1 : 0) + (writeFailed ? 1 : 0);
		for (const [name, entry] of view.files) {
			if (entry.unmetered) note(entry.why, entry.pid);
			if (entry.unmetered || stuck.has(name)) total += 1;
		}
		if (view.flooded > 0) note("flooded");
		return total;
	}

	/** The stop an unmetered child gets under the job's policies, or null with none. */
	function unmeteredStop() {
		if (meter.costCap !== null) return COST_CAP;
		if (meter.cap !== null) return TOKEN_BUDGET;
		if (meter.allowed !== null) return MODEL_NOT_ALLOWED;
		return null;
	}

	function offList(row) {
		if (row.provider === null || row.model === null) return true;
		return !meter.allowed.some((entry) => entry.provider === row.provider && entry.model === row.model);
	}

	/** Step 3: the children into the meter, then the stop rules (first stop wins: meter.stop keeps the first). */
	function judge() {
		const view = current();
		count = unmeteredCount(view);
		meter.setChildren({ ...view, processes: view.processes + noLedger.size, unmetered: count });
		if (meter.costCap !== null) {
			const own = guard()?.spend?.() ?? { spentMicros: 0 };
			if (own.spentMicros + view.spentMicros > meter.costCap || view.costRefused > 0) meter.stop(COST_CAP);
		}
		if (meter.allowed !== null && (view.modelRefused > 0 || view.rows.some(offList))) meter.stop(MODEL_NOT_ALLOWED);
		if (count > 0) {
			if (!warned) {
				warned = true;
				log("unmetered_child", { why: firstWhy?.why ?? "unknown", pid: firstWhy?.pid ?? null, unmetered: count });
			}
			const reason = unmeteredStop();
			if (reason !== null) meter.stop(reason, meter.snapshot().total);
		}
	}

	/** One control file, whole. A directory that is gone is made again (and counted lost); any failure is counted. */
	function writeControl(name, text) {
		if (dir === null) return;
		try {
			try {
				writeFileAtomic({ dir, name, text, ...(writeFs ? { fs: writeFs } : {}) });
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				dirLost = true;
				note("missing");
				mkdir(dir);
				writeFileAtomic({ dir, name, text, ...(writeFs ? { fs: writeFs } : {}) });
			}
		} catch {
			if (!writeFailed) note("control-write");
			writeFailed = true;
		}
	}

	function writeStop(reason) {
		writeControl(STOP_FILE, JSON.stringify(stopFile(reason)));
	}

	/** Step 4. */
	function writeControls() {
		const before = writeFailed || dirLost;
		if (meter.costCap !== null) {
			const own = guard()?.spend?.() ?? { spentMicros: 0, inflightMicros: 0 };
			writeControl(SPENT_FILE, JSON.stringify(spentFile(prev, own.spentMicros + own.inflightMicros)));
		}
		if (meter.state.stopReason !== null) writeStop(meter.state.stopReason);
		// A write that failed (or found the directory gone) is judged in this pass, not the next.
		if (!before && (writeFailed || dirLost)) judge();
	}

	/** Steps 1 and 2. */
	function foldAndDetect({ final }) {
		ticks += 1;
		if (dir !== null) {
			const next = fold({ dir, prev, ...(foldFs ? { fs: foldFs } : {}) });
			if (next.missing) {
				if (!dirLost) note("missing");
				dirLost = true;
				try {
					// Only when nothing is there: a path the agent replaced with a file or a link is not made over.
					lstat(dir);
				} catch {
					try {
						mkdir(dir);
					} catch {
						// The control writes then fail too, and are counted.
					}
				}
			}
			prev = next;
		}
		if (proc === null) return;
		const view = current();
		const ledgerPids = new Set([...view.files.values()].map((entry) => entry.pid));
		let live = [];
		try {
			live = proc.scan();
		} catch {
			live = [];
		}
		peak = Math.max(peak, live.length);
		for (const pid of live) {
			if (!seen.has(pid)) seen.set(pid, ticks);
			if (!ledgerPids.has(pid) && ticks - seen.get(pid) >= NO_LEDGER_TICKS && !noLedger.has(pid)) {
				note("no-ledger", pid);
				noLedger.add(pid);
			}
		}
		if (final) {
			for (const pid of seen.keys()) {
				if (!ledgerPids.has(pid) && !noLedger.has(pid)) {
					note("no-ledger", pid);
					noLedger.add(pid);
				}
			}
		}
		for (const [name, entry] of view.files) {
			if (entry.unmetered || entry.state !== "starting" || stuck.has(name)) continue;
			if (!proc.alive(entry.pid)) {
				// Ended before its meter started. With zero spend that is all it did; a `starting` file with spend in it is
				// not one the preload wrote.
				if (spent(entry.high)) {
					note("starting", entry.pid);
					stuck.add(name);
				}
				continue;
			}
			const since = startingSince.get(name) ?? now();
			startingSince.set(name, since);
			if (now() - since > STARTING_GRACE_MS) {
				note("starting", entry.pid);
				stuck.add(name);
			}
		}
	}

	// The keys are on the exit line from the start, zeros until a child reports.
	meter.setChildren(emptyFold());

	return {
		sample() {
			if (closed) return;
			foldAndDetect({ final: false });
			judge();
			writeControls();
		},
		teardown() {
			if (closed) return { distinct: proc === null ? null : seen.size, peak: proc === null ? null : peak, unmetered: count };
			writeStop(meter.state.stopReason ?? TOKEN_BUDGET);
			foldAndDetect({ final: true });
			judge();
			closed = true;
			if (dir !== null) {
				try {
					remove(dir);
				} catch {
					// It goes with the container.
				}
			}
			return { distinct: proc === null ? null : seen.size, peak: proc === null ? null : peak, unmetered: count };
		},
		external() {
			const view = current();
			return view.spentMicros + view.inflightMicros;
		},
		stopped(reason) {
			if (!closed) writeStop(reason);
		},
		view: () => ({ unmetered: count, seen: seen.size, peak, dirLost, writeFailed }),
	};
}
