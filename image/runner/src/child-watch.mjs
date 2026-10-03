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
 *   1. FOLD. foldChildLedgers with the last pass's result as `prev`, retiring the `done` files of processes that are
 *      gone (Linux; the fold has the rule). A ledger directory that cannot be listed (`missing`: the agent removed it)
 *      is made again, mode 0700, when nothing else stands at its path, and counted once as unmetered.
 *   2. DETECT (Linux only: it reads /proc; elsewhere there is no detector). linuxProc() has what a pi process is. A pi
 *      process is UNMETERED when:
 *      - its environment, where it can be read whole, does not carry this job's ledger directory AND the preload in
 *        NODE_OPTIONS: a ledger named after its pid is then not its own (a spawner can write one), whatever it says;
 *      - no ledger names its pid two ticks after it was first seen, if it is still alive then, whether or not it still
 *        looks like a pi process (a title can be changed after the fact);
 *      - it was seen alive and no ledger ever named it: counted at teardown, when this parent first saw it
 *        NO_LEDGER_FINAL_MS or more before;
 *      - its ledger is still `starting` (its meter never installed) after STARTING_CPU_MS of the process's own CPU, or
 *        STARTING_WALL_MS since this parent first saw it; an honest child installs at about 0.3 s of CPU, and was seen
 *        at 0.67 s under load on arm64. Un-counted once it is no longer `starting`. At teardown, a live `starting`
 *        ledger is unmetered only when this parent first saw it STARTING_FINAL_MS or more before: an honest job that
 *        ends while fresh children start must not fail for them.
 *        A `starting` ledger of a DEAD process is done only when it was seen for less than the wall grace, used less
 *        than the CPU grace, and holds zero spend; otherwise it is unmetered. Judged once, when the file is retired.
 *   3. JUDGE. The fold goes to meter.setChildren with `unmetered` and `processes` widened by what the detector found
 *      (the token cap is judged there, on parent plus children). Then, first stop wins:
 *      - under a dollar cap: the parent's settled spend plus every child's settled spend (ledgerSettled: the larger
 *        of its guard's spend and its metered cost) past the cap, or any child `costRefused`, is `cost-cap`;
 *      - under a model list: any child `modelRefused`, or any named child row whose pair is not on the PARENT's list
 *        (a spawner can widen a child's own list), is `model-not-allowed`. A model-less row is not judged here: the
 *        child's own guard judged that call against the list it inherited;
 *      - any unmetered child: one `unmetered_child` line (the first time), then the stop an unmetered child gets:
 *        `cost-cap` under a dollar cap, else `token_budget` under a token cap, else `model-not-allowed` under a list,
 *        with `cause: "unmetered-child"` so the token stop does not log `token_budget_exceeded`. With no policy it
 *        is a floor only, and nothing stops.
 *   4. WRITE (ticks only). SPENT under a dollar cap (spentFile), and STOP with the meter's reason once it has stopped,
 *      rewritten on every tick so a deleted STOP comes back. The parent's own failure to write either is counted once
 *      as unmetered: a child it cannot reach is a child it cannot hold to the cap.
 *
 * TEARDOWN: STOP first (the meter's reason, or `token_budget` when the job ended without a stop: past the final fold no
 * child call could be counted), then the final pass. The directory and its STOP stay: the container ends right after,
 * and a directory removed while a child lives would let an agent that makes it again run that child unbraked. A child
 * call in flight at the STOP shows in the final fold as `unresolved`. The teardown line gains `distinct` and `peak` (pi
 * processes the detector saw, null with no detector) and `unmetered`.
 *
 * The parent's cost guard reads `external()`: every child's ledgerCharge() (settled plus in flight) as of the last
 * fold. The exit line's cost and model counters add the children's (`guardFields`).
 */
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_ENTRIES, RUN_JOB_PATH } from "./child-route.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "./outcome.mjs";
import { foldChildLedgers, SPENT_FILE, spentFile, STOP_FILE, stopFile, writeFileAtomic } from "./usage-meter.mjs";

/**
 * How much CPU a process may use with its ledger still `starting`. An honest child installs its meter at about 0.3 s of
 * CPU (five runs) and reached 0.67 s under load on arm64, so 1 s left too little room; 3 s still catches a meterless
 * child that works (the lab's caught at 2 s and climbing).
 */
export const STARTING_CPU_MS = 3_000;
/** How long, from this parent's first sight, a live ledger may stay `starting`, CPU or not (monotonic). */
export const STARTING_WALL_MS = 60_000;
/**
 * At teardown, how long before it this parent must have first seen a live ledger `starting` for it to count as
 * unmetered: the M5 grace (OQ-011), from the preload's stub to the meter's install. A child that started in the job's
 * last seconds has not had the time an honest one needs, and the job's exit must not fail for it.
 */
export const STARTING_FINAL_MS = 10_000;
/** How many ticks a pi process may live with no ledger before it is unmetered. */
export const NO_LEDGER_TICKS = 2;
/**
 * At teardown, how long before it this parent must have first seen a pi process with no ledger for it to count as
 * unmetered: two ticks. An honest child's preload writes its stub about 13 ms after spawn (M5), so a child seen only
 * in its first moments, by the final pass or by the last tick, must not fail the job.
 */
export const NO_LEDGER_FINAL_MS = 2_000;
/** The command-line titles pi gives itself (setupCli: `pi`; the rpc entries: `pi-rpc`). */
export const PI_TITLES = Object.freeze(["pi", "pi-rpc"]);
/** How much of a command line is read: the markers sit in argv[0] and argv[1]. */
export const CMDLINE_BYTES = 4096;
/** How much of an environment is read when looking for the ledger directory and the preload. */
export const ENVIRON_BYTES = 64 * 1024;
/** The time one tick's /proc scan may take; what is left is scanned on the next tick. */
export const SCAN_BUDGET_MS = 200;
/** The kernel's PF_FORKNOEXEC: forked and not yet exec'd, so still carrying its parent's command line. */
export const PF_FORKNOEXEC = 0x40;
/** The NODE_OPTIONS flag the runner gives its descendants (openChildLedger), for this image's preload. */
export const PRELOAD_FLAG = `--import=${new URL("./child-preload.mjs", import.meta.url).href}`;
/** The cost and model counters the exit line carries and a child ledger adds to (guardFields). */
const GUARD_FIELDS = Object.freeze(["costRefused", "boundExceeded", "longContext", "costUnjudged", "costUnanswered", "modelRefused"]);

/** The fold of a directory with nothing in it: what setChildren gets before the first tick, so the keys are there. */
function emptyFold() {
	return { processes: 0, unmetered: 0, flooded: 0, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0 }, rows: [], spentMicros: 0, inflightMicros: 0, costRefused: 0, modelRefused: 0, boundExceeded: 0, costUnanswered: 0, longContext: 0, costUnjudged: 0, settledMicros: 0, chargeMicros: 0, missing: false, files: new Map(), retired: null };
}

/** Whether a ledger's mark holds any spend at all. */
function spent(high) {
	return Object.values(high.totals).some((value) => value !== 0) || high.spentMicros !== 0 || high.inflightMicros !== 0 || high.rows.size > 0;
}

/**
 * Whether a process with these arguments (from /proc/<pid>/cmdline, split on NUL, empties dropped) is a pi process:
 * argv[0] is one of PI_TITLES, or argv[1], the script position, has one of `basenames` and realpaths (`resolve`) to one
 * of `targets`. No other argument counts: `tail -f run-job.mjs` reads the runner, it does not run it.
 */
export function isPiProcess(argv, { basenames, targets, resolve }) {
	if (!Array.isArray(argv) || argv.length === 0) return false;
	if (PI_TITLES.includes(argv[0])) return true;
	const script = argv[1];
	if (typeof script !== "string" || !basenames.has(basename(script))) return false;
	const real = resolve(script);
	return real !== null && targets.has(real);
}

/** The pinned pi's package root, as this runner resolves it (the copy the preload names too). */
function defaultPackageDir() {
	return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

/**
 * The fields of /proc/<pid>/stat this file reads, from its text: `state`, `flags` and `cpuMs` (utime + stime, in
 * USER_HZ ticks, which Linux fixes at 100 a second). Null when the text is not a stat line.
 */
export function parseStat(text) {
	const close = typeof text === "string" ? text.lastIndexOf(")") : -1;
	if (close === -1) return null;
	const fields = text.slice(close + 2).split(" ");
	const flags = Number(fields[6]);
	const utime = Number(fields[11]);
	const stime = Number(fields[12]);
	if (fields[0] === undefined || !Number.isFinite(flags)) return null;
	return { state: fields[0], flags, cpuMs: Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) * 10 : null };
}

/**
 * The Linux detector's view of /proc, or null off Linux:
 *   - `scan()`: the pids of pi processes (isPiProcess), skipping this one, pid 1 and any process forked and not yet
 *     exec'd (PF_FORKNOEXEC: it still shows its parent's command line, the runner's or a pi child's, for the instant
 *     before it execs a tool). At most CMDLINE_BYTES of each command line are read, and one scan takes at most
 *     SCAN_BUDGET_MS of `now()`: what is left is scanned on the next tick, so no number or size of processes can hold
 *     the runner's event loop.
 *   - `alive(pid)`: the process exists and is not a zombie. `cpuMs(pid)`: its CPU time, or null.
 *   - `environ(pid)`: its start environment as `{ entries, complete }`, `complete` false when the read filled
 *     ENVIRON_BYTES (there may be more); null when it cannot be read (a non-dumpable process, such as a nested runner on
 *     the image's runner-node). The stat line is read BEFORE the command line: PF_FORKNOEXEC only ever goes from set to
 *     clear (at exec), so a fork that execs between the two reads is never taken for its parent.
 * Never throws: a process that vanishes mid-read, or whose files cannot be read, is skipped.
 */
export function linuxProc({
	self = process.pid,
	platform = process.platform,
	packageDir = defaultPackageDir,
	runJob = RUN_JOB_PATH,
	now = () => performance.now(),
	budgetMs = SCAN_BUDGET_MS,
	fs = { readdirSync, openSync, readSync, closeSync, realpathSync },
} = {}) {
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
	/** At most `max` bytes of a file, as latin1. Throws what the fs throws. */
	function head(path, max) {
		return headRead(path, max).text;
	}
	/** `{ text, full }`: at most `max` bytes of a file, and whether the read filled them. */
	function headRead(path, max) {
		const fd = fs.openSync(path, "r");
		try {
			const buffer = Buffer.alloc(max);
			let length = 0;
			while (length < max) {
				const read = fs.readSync(fd, buffer, length, max - length, null);
				if (read === 0) break;
				length += read;
			}
			return { text: buffer.subarray(0, length).toString("latin1"), full: length >= max };
		} finally {
			fs.closeSync(fd);
		}
	}
	function stat(pid) {
		try {
			return parseStat(head(`/proc/${pid}/stat`, 1024));
		} catch {
			return null;
		}
	}
	let queue = [];
	let cursor = 0;
	return {
		scan() {
			const found = [];
			const started = now();
			if (cursor >= queue.length) {
				try {
					queue = fs.readdirSync("/proc").filter((name) => /^[1-9][0-9]*$/.test(String(name)));
				} catch {
					queue = [];
				}
				cursor = 0;
			}
			while (cursor < queue.length) {
				if (now() - started > budgetMs) break;
				const pid = Number(queue[cursor]);
				cursor += 1;
				if (pid === self || pid === 1) continue;
				const fields = stat(pid);
				if (fields === null || (fields.flags & PF_FORKNOEXEC) !== 0) continue;
				let argv;
				try {
					argv = head(`/proc/${pid}/cmdline`, CMDLINE_BYTES).split("\u0000").filter((part) => part !== "");
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
				if (!isPiProcess(argv, { basenames, targets: realTargets(), resolve })) continue;
				found.push(pid);
			}
			return found;
		},
		alive(pid) {
			const fields = stat(pid);
			return fields !== null && fields.state !== "Z" && fields.state !== "X" && fields.state !== "x";
		},
		cpuMs(pid) {
			return stat(pid)?.cpuMs ?? null;
		},
		environ(pid) {
			try {
				const { text, full } = headRead(`/proc/${pid}/environ`, ENVIRON_BYTES);
				return { entries: text.split("\u0000"), complete: !full };
			} catch {
				return null;
			}
		},
	};
}

/**
 * The parent's children hook. `dir` is the ledger directory (null when none could be made: then nothing is folded or
 * written, and the detector alone sees the children). `guard()` returns the parent's policy guard or null (late, because
 * the guard's `external` is this hook's). `now` is a monotonic clock in ms (the wall-time grace off Linux, where a
 * proc with no `cpuMs` is used). Everything that touches the system is injected for the tests.
 * Returns `{ sample, teardown, external, stopped, guardFields, view }`: the two hook methods, the parent cost guard's
 * `external`, `stopped()` for the meter's onStop (writes STOP at once rather than on the next tick), `guardFields()`
 * (the exit line's guard counters plus the children's), and `view()` (the counts).
 */
export function createChildWatch({
	dir,
	meter,
	guard = () => null,
	log = () => {},
	proc = linuxProc(),
	now = () => performance.now(),
	fold = foldChildLedgers,
	foldFs,
	writeFs,
	mkdir = (path) => mkdirSync(path, { mode: 0o700 }),
	lstat = lstatSync,
	preloadFlag = PRELOAD_FLAG,
}) {
	let prev = null;
	let ticks = 0;
	let peak = 0;
	/** pid -> the tick it was first seen alive as a pi process. */
	const seen = new Map();
	/** pid -> when (monotonic) it was first seen alive as a pi process. */
	const seenAt = new Map();
	/** pids seen with no ledger yet, still to be judged. */
	const pending = new Set();
	/** pids of pi processes judged unmetered by the detector. */
	const noLedger = new Set();
	/** pid -> whether its environment carries this job's ledger directory (null: unreadable). */
	const environ = new Map();
	/** ledger name -> `{ first, last, cpu }` while it is `starting` and alive: when this parent first and last
	 *  saw it so (monotonic), and the most CPU its process was seen to have used. */
	const starting = new Map();
	/** ledger names held `starting` past a grace, or dead `starting` judged unmetered. Counted whether tracked or retired. */
	const stuck = new Set();
	let dirLost = false;
	let writeFailed = false;
	let firstWhy = null;
	let warned = false;
	let count = 0;
	// After teardown nothing is written.
	let closed = false;
	const needle = dir === null ? null : `PI_DISPATCH_CHILD_LEDGER=${dir}`;

	/**
	 * Whether a pi process's start environment makes it this job's child: true with both the ledger directory and the
	 * preload in NODE_OPTIONS; false when the whole environment was read and either is missing; null (the ledger rule
	 * alone) when it could not be read, or was cut at ENVIRON_BYTES before both were found.
	 */
	function environVerdict(pid) {
		let env = null;
		try {
			env = proc.environ?.(pid) ?? null;
		} catch {
			env = null;
		}
		if (env === null) return null;
		const hasLedger = env.entries.includes(needle);
		const options = env.entries.find((entry) => entry.startsWith("NODE_OPTIONS="));
		const hasPreload = options !== undefined && options.slice("NODE_OPTIONS=".length).split(/\s+/).includes(preloadFlag);
		if (hasLedger && hasPreload) return true;
		return env.complete ? false : null;
	}

	/** A dead process's `starting` ledger, judged once (its file is retired right after, and its pid never read again). */
	function settleDeadStarting(name, entry) {
		const info = starting.get(name);
		starting.delete(name);
		const seenFor = info ? info.last - info.first : 0;
		const cpu = info?.cpu ?? 0;
		if (spent(entry.high) || seenFor >= STARTING_WALL_MS || cpu >= STARTING_CPU_MS) {
			note("starting", entry.pid);
			stuck.add(name);
		}
	}

	const current = () => prev ?? emptyFold();
	const note = (why, pid = null) => {
		if (firstWhy === null) firstWhy = { why, pid };
	};
	const unmeteredPid = (pid, why) => {
		if (noLedger.has(pid)) return;
		note(why, pid);
		noLedger.add(pid);
		pending.delete(pid);
	};
	/** Every pid a ledger ever named: tracked files and retired ones. */
	const ledgerPids = (view) => new Set([...[...view.files.values()].map((entry) => entry.pid), ...(view.retired?.pids ?? [])]);

	/** The unmetered count: every file the fold or the detector judged, flooded names, and the parent's own losses. */
	function unmeteredCount(view) {
		let total = view.flooded + noLedger.size + (dirLost ? 1 : 0) + (writeFailed ? 1 : 0) + stuck.size;
		for (const [name, entry] of view.files) {
			if (!entry.unmetered) continue;
			note(entry.why, entry.pid);
			if (!stuck.has(name)) total += 1;
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

	const offList = (row) => row.provider !== null && row.model !== null && !meter.allowed.some((entry) => entry.provider === row.provider && entry.model === row.model);

	/** Step 3: the children into the meter, then the stop rules (first stop wins: meter.stop keeps the first). */
	function judge() {
		const view = current();
		count = unmeteredCount(view);
		const ledgered = ledgerPids(view);
		const detected = [...noLedger].filter((pid) => !ledgered.has(pid)).length;
		meter.setChildren({ ...view, processes: view.processes + detected, unmetered: count });
		if (meter.costCap !== null) {
			const own = guard()?.spend?.() ?? { spentMicros: 0 };
			if (own.spentMicros + view.settledMicros > meter.costCap || view.costRefused > 0) meter.stop(COST_CAP);
		}
		if (meter.allowed !== null && (view.modelRefused > 0 || view.rows.some(offList))) meter.stop(MODEL_NOT_ALLOWED);
		if (count > 0) {
			if (!warned) {
				warned = true;
				log("unmetered_child", { why: firstWhy?.why ?? "unknown", pid: firstWhy?.pid ?? null, unmetered: count });
			}
			const reason = unmeteredStop();
			if (reason !== null) meter.stop(reason, { cause: "unmetered-child", unmetered: count });
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
			// Any file of a dead process is retired; a `starting` one is judged first, once.
			const retire = proc === null ? null : (pid, name, entry) => {
				if (proc.alive(pid)) return false;
				if (entry.state === "starting") settleDeadStarting(name, entry);
				return true;
			};
			const next = fold({ dir, prev, retire, ...(foldFs ? { fs: foldFs } : {}) });
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
		const ledgered = ledgerPids(view);
		let live = [];
		try {
			live = proc.scan();
		} catch {
			live = [];
		}
		const liveSet = new Set(live);
		peak = Math.max(peak, live.length);
		for (const pid of live) {
			if (!seen.has(pid)) {
				seen.set(pid, ticks);
				seenAt.set(pid, now());
				if (!ledgered.has(pid)) pending.add(pid);
			}
			if (needle !== null && !noLedger.has(pid)) {
				if (!environ.has(pid)) environ.set(pid, environVerdict(pid));
				if (environ.get(pid) === false) unmeteredPid(pid, "environ");
			}
		}
		for (const pid of pending) {
			if (ledgered.has(pid)) {
				pending.delete(pid);
				continue;
			}
			if (final) {
				// Only one first seen NO_LEDGER_FINAL_MS or more ago: a pid seen just now, or by the last tick in its first
				// milliseconds, may be an honest child whose preload has not written the stub yet (the `starting` rule's
				// shape, a time floor rather than a pass count, part F's review).
				if (now() - seenAt.get(pid) >= NO_LEDGER_FINAL_MS) unmeteredPid(pid, "no-ledger");
				continue;
			}
			// Still alive two ticks on, whether or not it still looks like pi: a title can be changed after the fact.
			if (ticks - seen.get(pid) >= NO_LEDGER_TICKS && (liveSet.has(pid) || proc.alive(pid))) unmeteredPid(pid, "no-ledger");
		}
		for (const [name, entry] of view.files) {
			if (entry.state !== "starting") {
				// Its meter installed after all: judged by its file from here on.
				if (!entry.unmetered) stuck.delete(name);
				starting.delete(name);
				continue;
			}
			if (entry.unmetered || stuck.has(name)) continue;
			// Dead ones were judged at retirement (the fold above); this one lives.
			const at = now();
			const info = starting.get(name) ?? { first: at, last: at, cpu: 0 };
			info.last = at;
			if (typeof proc.cpuMs === "function") info.cpu = Math.max(info.cpu, proc.cpuMs(entry.pid) ?? 0);
			starting.set(name, info);
			const tooLong = info.cpu > STARTING_CPU_MS || at - info.first > STARTING_WALL_MS || (final && at - info.first >= STARTING_FINAL_MS);
			if (tooLong) {
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
			if (!closed) {
				writeStop(meter.state.stopReason ?? TOKEN_BUDGET);
				foldAndDetect({ final: true });
				judge();
				closed = true;
			}
			return { distinct: proc === null ? null : seen.size, peak: proc === null ? null : peak, unmetered: count };
		},
		external() {
			return current().chargeMicros;
		},
		stopped(reason) {
			if (!closed) writeStop(reason);
		},
		/** The guard's exit-line counters, each with the children's added: a child's partial count floors the job too. */
		guardFields(snapshot) {
			const view = current();
			const out = { ...snapshot };
			for (const key of GUARD_FIELDS) if (typeof out[key] === "number") out[key] += view[key] ?? 0;
			return out;
		},
		view: () => ({ unmetered: count, seen: seen.size, peak, dirLost, writeFailed }),
	};
}
