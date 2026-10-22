import { spawn } from "node:child_process";
import { constants } from "node:os";
import { readCgroupUsage } from "./cgroup-usage.mjs";
import { createExitWriter, drainStdin, EXIT_AUTH_STDIN, EXIT_AUTH_STDIN_FRAMES, EXIT_KEY_PATTERN, writeAllSync } from "./exit-line.mjs";
import { FRAME_FD, readKeyFrame } from "./steer-frames.mjs";

/**
 * The job runner's supervisor (issue #596, INT-RUNNER-EXIT-CODE-PROTOCOL): a small parent between the container's init
 * and the runner, so that a runner the kernel kills still ends on a signed exit line that says why.
 *
 * WHY IT EXISTS. A job killed for memory exits 137, exactly like a SIGKILL from anywhere else, and the worker cannot
 * look afterwards: every job container runs with `--rm`, so its state is gone when `docker run` returns. Docker's `oom`
 * event fires also when only a child was killed and the job went on to exit 0, and Podman (4.9 and 5.8, rootful and
 * rootless) reports no OOM at all (measured in the issue #596 lab). The only process that can see the cgroup's
 * `oom_kill` count at the moment the runner dies is one inside the container that outlives it. This is that process.
 *
 * WHAT IT DOES, and nothing more:
 *   - with `PI_EXIT_AUTH=stdin`, drains stdin (the per-job key, issue #545) FIRST and hands the very same bytes to the
 *     runner on the runner's own stdin, closed at once, so the runner's key handling is byte-for-byte what it was. It
 *     keeps the key, so it is closed to the job's uid on BOTH of the ways a same-uid process could read it: it runs under
 *     the exec-only node (issue #545), which shuts its /proc mem, environ and fd, and it is started with
 *     `--disable-sigusr1` (image/entrypoint.sh), which shuts the Node inspector a SIGUSR1 would otherwise open on
 *     127.0.0.1:9229 (the loopback exists under `--network none`), from where a heap snapshot holds the key. The runner
 *     is started the same way (RUNNER_NODE_FLAGS);
 *   - with `PI_EXIT_AUTH=stdin-frames` (issue #686, a steered job on a venue that copies its files), reads EXACTLY frame
 *     1 of the steer frame channel (steer-frames.mjs `readKeyFrame`: a 4-byte length, then the key's JSON), never a byte
 *     past it, hands those very bytes to the runner on the runner's stdin, closed at once (the key handoff above, in the
 *     same shape), and then FORWARDS every later byte of its own stdin to the runner's fd 3 (FRAME_FD, which says why
 *     not its stdin), unchanged and in order, keeping it open until its own stdin ends. It never parses a message
 *     frame: the runner verifies each under the key, so a bug here can drop or delay a message, never forge one. The
 *     forwarding is a stream pipe, so a runner that reads slowly holds the worker's writes back (the pipe's own
 *     backpressure) rather than this process buffering without bound. A frame 1 that is not a key's is handed on as
 *     read and nothing more is forwarded: the runner reports the same `malformed` it would have, and without a key a
 *     steered run refuses (`steer-no-exit-key`);
 *   - starts the runner through `/bin/sh`, which raises its own `oom_score_adj` to 1000 and then execs the runner, so
 *     the runner and every process it starts are the kernel's first choice and this supervisor (score 0) is left alone.
 *     Raising needs no capability (allowed under `--cap-drop=ALL` and `no-new-privileges`); it is done in the shell
 *     because a process running the exec-only node is not dumpable, so its own `/proc/self/oom_score_adj` is root's
 *     and it could not write it. Measured: without the bump, a second OOM in one cgroup killed even a 1 MB main shell
 *     on Fedora's 6.19 kernel; with it the supervisor survived 15 of 15 OOM kills on three venues;
 *   - forwards SIGTERM, SIGINT and SIGHUP to the runner (the init process delivers a `docker stop` here, not there);
 *   - when the runner EXITS (a code), exits with that code and writes nothing: the runner wrote its own line, or none,
 *     exactly as before;
 *   - when the runner is KILLED (a signal), reads the cgroup counters and writes the exit line itself, signed with the
 *     same key: `code` 128 plus the signal, `reason` `oom-killed` for a SIGKILL while the cgroup's `oom_kill` is above
 *     0 (the counter the job's own cgroup is charged on every venue; `oom` and `max` stay 0 under crun, whose limit sits
 *     on the parent scope), else `terminated` for SIGTERM and `killed` for anything else, then exits with that code.
 *
 * The line carries no tokens: a runner killed mid-run never reported them, and the worker settles such a run at its
 * floor, as it did when no line came at all.
 *
 * Every line it writes carries `by: "supervisor"` inside the signed bytes. The runner may have written its own line before
 * it was killed (a tool can SIGKILL it after its decided line, and the kernel can too); the worker then reads the
 * runner's line and ignores this one (worker/src/run-history.mjs `decisiveExitLine`), so a finished run keeps its own
 * outcome, tokens and usage.
 *
 * `superviseRunner` takes every effect as a seam, for the tests. The image runs it from `image/runner/supervise.mjs`,
 * an entry file that calls it unconditionally: a main-module guard here once read false on a path spelling it did not
 * expect, and node then exited 0 with no output, which the worker records as a completed run.
 */

/** The runner the image's entrypoint supervises, under the exec-only node (issue #545). */
export const RUNNER_NODE = "/opt/pi-dispatch/runner-node";
/**
 * The readable copy of that node (issue #730, image/Dockerfile): on a venue whose connections are mediated by a broker
 * that reads the caller's memory (OpenShell), the worker sets RUNNER_OBSERVABLE_ENV to "1" and the entrypoint starts
 * this supervisor from it, so the runner must start from it too: a nondumpable runner would refuse every connection of
 * its own and of every tool below it. The variable is read from this process's own environment, which the exec set and
 * no tool can change, and the entrypoint has already refused any value but "1" or unset.
 */
export const RUNNER_OBSERVABLE = "/opt/pi-dispatch/runner-observable";
export const RUNNER_OBSERVABLE_ENV = "PI_RUNNER_OBSERVABLE";
/** The node the runner starts from, given the supervisor's environment. */
export function runnerNodeFor(env) {
	return env?.[RUNNER_OBSERVABLE_ENV] === "1" ? RUNNER_OBSERVABLE : RUNNER_NODE;
}
/**
 * The node flags the runner starts with. `--disable-sigusr1` because the runner holds the key too: without it a job's
 * tool (same uid) sends SIGUSR1, or calls `process._debugProcess(pid)`, and the runner opens its inspector on
 * 127.0.0.1:9229, where a heap snapshot carries the key (measured on the issue #596 image: open without the flag, shut
 * with it). The exec-only node does not help there: the inspector is the process serving its own memory. Node 22.14 and
 * later know the flag, and the image's node is pinned (image/Dockerfile).
 */
export const RUNNER_NODE_FLAGS = Object.freeze(["--disable-sigusr1"]);
export const RUNNER_SCRIPT = "/app/image/runner/run-job.mjs";
/** Raise the score, best effort, then become the runner: same pid, so the runner's own pid checks hold. */
export const RAISE_THEN_EXEC = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
/** The signals a stop arrives as, forwarded to the runner. */
export const FORWARDED_SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGHUP"]);
/** The reasons this file writes. `oom-killed` is the one the worker acts on (worker/src/run-history.mjs EXIT_OOM_KILLED). */
export const OOM_KILLED = "oom-killed";
export const TERMINATED = "terminated";
export const KILLED = "killed";
/** The signed marker on every line this file writes, so the worker can tell it from the runner's own. */
export const BY_SUPERVISOR = "supervisor";

/** The exit line's fields for a runner that died of `signal`, given the cgroup counters read at that moment. */
export function deathFields(signal, resources) {
	const signo = constants.signals[signal];
	const code = 128 + (Number.isSafeInteger(signo) ? signo : constants.signals.SIGKILL);
	const oomKills = resources !== null && typeof resources === "object" ? resources.oomKills : null;
	const reason = signal === "SIGKILL" && Number.isSafeInteger(oomKills) && oomKills > 0 ? OOM_KILLED : signal === "SIGTERM" ? TERMINATED : KILLED;
	return { code, reason, signal: typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : null };
}

export function superviseRunner({
	env = process.env,
	command = ["/bin/sh", ["-c", RAISE_THEN_EXEC, runnerNodeFor(env), ...RUNNER_NODE_FLAGS, RUNNER_SCRIPT]],
	spawnFn = spawn,
	drain = drainStdin,
	write = (line) => writeAllSync(1, line),
	exit = (code) => process.exit(code),
	readResources = () => readCgroupUsage(),
	onSignal = (signal, handler) => process.on(signal, handler),
	// Issue #686: frame 1 off fd 0, and the stream of what follows it (this process's stdin, after frame 1). Seams.
	readFrame = readKeyFrame,
	openStdin = () => process.stdin,
} = {}) {
	// env-internal PI_EXIT_AUTH: written by the worker into the job's closed env map. Read, never removed here: the runner
	// reads it to know a key is waiting on ITS stdin, and removes it from its own environment as before.
	const framed = env.PI_EXIT_AUTH === EXIT_AUTH_STDIN_FRAMES;
	const keyed = env.PI_EXIT_AUTH === EXIT_AUTH_STDIN || framed;
	let raw = null;
	let key = null;
	if (framed) {
		let read;
		try {
			read = readFrame();
		} catch {
			read = { key: null, bytes: Buffer.alloc(0) };
		}
		raw = Buffer.isBuffer(read?.bytes) ? read.bytes : Buffer.alloc(0);
		key = typeof read?.key === "string" && EXIT_KEY_PATTERN.test(read.key) ? read.key : null;
	} else if (keyed) {
		try {
			raw = drain();
		} catch {
			// The runner then reads an empty stdin and reports the key `malformed`, as it would have reported `unreadable`.
			raw = "";
		}
		const trimmed = typeof raw === "string" ? raw.trim() : "";
		key = EXIT_KEY_PATTERN.test(trimmed) ? trimmed : null;
	}
	// The counters the verdict was made from, so the line's `resources` and its `reason` come from ONE read.
	let atDeath;
	const writer = createExitWriter({
		key,
		// env-internal PI_JOB_ID: set by the worker on the container, so the exit line can name its job.
		jobId: env.PI_JOB_ID,
		write,
		exit,
		resources: () => (atDeath !== undefined ? atDeath : readResources()),
	});

	let child;
	try {
		// Issue #686: a fourth descriptor, the runner's fd 3, for the message frames, only beside a frame-1 key.
		const streams = framed && key !== null;
		child = spawnFn(command[0], command[1], { stdio: [keyed ? "pipe" : "inherit", "inherit", "inherit", ...(streams ? Array(FRAME_FD - 2).fill("pipe") : [])], env });
	} catch {
		// No runner at all: the infra code, with a line that says nothing more, so the worker retries as it would have.
		writer.writeExit({ code: 1, reason: "runner-not-started", by: BY_SUPERVISOR });
		exit(1);
		return;
	}
	if (framed && key !== null) {
		// Frame 1 on the runner's stdin, closed, exactly as the plain key is; everything after it on fd 3, as it comes. An
		// EPIPE (the runner gone) only ends the forwarding; this process's own exit follows the runner's below.
		child.stdin?.on("error", () => {});
		child.stdin?.end(raw);
		const frames = child.stdio?.[FRAME_FD] ?? null;
		frames?.on?.("error", () => {});
		let src = null;
		try {
			src = openStdin();
		} catch {
			src = null;
		}
		if (src && typeof src.pipe === "function" && frames) {
			src.on?.("error", () => {
				try {
					frames.end();
				} catch {}
			});
			src.pipe(frames);
		} else {
			frames?.end?.();
		}
	} else if (keyed) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(raw ?? "");
	}
	for (const signal of FORWARDED_SIGNALS) {
		onSignal(signal, () => {
			try {
				child.kill(signal);
			} catch {
				// already gone: its exit is handled below
			}
		});
	}
	child.on("error", () => {
		writer.writeExit({ code: 1, reason: "runner-not-started", by: BY_SUPERVISOR });
		exit(1);
	});
	child.on("exit", (code, signal) => {
		if (signal === null || signal === undefined) {
			exit(Number.isSafeInteger(code) ? code : 1);
			return;
		}
		try {
			atDeath = readResources();
		} catch {
			atDeath = null;
		}
		const verdict = deathFields(signal, atDeath);
		writer.writeExit({ code: verdict.code, reason: verdict.reason, ...(verdict.signal ? { signal: verdict.signal } : {}), by: BY_SUPERVISOR });
		exit(verdict.code);
	});
	return child;
}
