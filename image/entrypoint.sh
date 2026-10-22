#!/bin/sh
# Thin by design. The runner owns the outcome, including the exit code that
# INT-RUNNER-EXIT-CODE-PROTOCOL depends on, and writes the exit line; the one other
# author is the supervisor below, which writes a line only when the runner was killed
# before it could (issue #596). Adding logic here would put a third author on that
# contract.
#
# `exec` so the supervisor replaces this shell and receives SIGTERM when the worker
# stops the container at REQ-JOB-TIMEOUT-30M, and forwards it to the runner. Without
# exec, sh would hold the signal, and the exit code the worker reads would be sh's,
# not ours. The supervisor exits with the runner's own code.
#
# Note the container runs with --init, so zombie reaping is handled by docker's init
# rather than by node, which does not reap. Chromium spawns enough processes for that
# to matter against --pids-limit.
#
# LF line endings are enforced by .gitattributes. A CRLF shebang here becomes
# "bad interpreter" inside the container: a confusing error with a boring cause.
set -eu

# The exec-only node (issue #545, image/Dockerfile): the runner holds the exit line's key, and a process started from a
# binary its user cannot read is closed to that user's /proc reads. Plain `node` here would reopen them.
#
# The supervisor (issue #596, image/runner/supervise.mjs) runs first and starts the runner as its child: it passes the
# key on, forwards a stop, exits with the runner's own code, and writes the signed exit line only when the runner was
# KILLED, naming an out-of-memory kill. It holds the key too, so it runs under the same exec-only node.
#
# `--disable-sigusr1` (issue #596's review; the hole dates from #545): a job's tool runs as the same uid, and a SIGUSR1
# (or `process._debugProcess(pid)`) would open this node's inspector on 127.0.0.1:9229, which exists under
# `--network none`, and a heap snapshot from there holds the key. The exec-only node closes /proc, not the inspector:
# that is the process serving its own memory. The supervisor starts the runner with the same flag.
#
# Issue #730: on a venue whose connections are mediated by a broker that must read the caller's memory (OpenShell), the
# worker sets PI_RUNNER_OBSERVABLE=1 and both key holders start from the readable copy instead (image/Dockerfile says
# why, and what protects the key there). Read here, once, from the exec's environment, which the worker alone writes:
# the supervisor picks the runner's node from the same variable, and nothing a tool does later reaches either. Strict:
# unset or empty is the exec-only node, "1" the readable one, anything else a worker defect, refused rather than guessed.
# Issue #730 (review round 1, H1): a readable key holder can be core-dumped (a SIGABRT between the job's own processes),
# and a core would hold the exit-line key. OpenShell's seccomp already refuses prlimit64 on another pid, but the default
# soft limit is not known, so it is set here: `ulimit -c 0` in dash sets the soft AND hard limit, so nothing without
# CAP_SYS_RESOURCE (the sandbox has none) can raise it again; the holders inherit it across exec. On both branches,
# harmless where the node is already unreadable, so one path.
ulimit -c 0
case "${PI_RUNNER_OBSERVABLE:-}" in
"") node=/opt/pi-dispatch/runner-node ;;
1) node=/opt/pi-dispatch/runner-observable ;;
*)
	echo "entrypoint: PI_RUNNER_OBSERVABLE must be 1 or unset" >&2
	exit 2
	;;
esac
exec "$node" --disable-sigusr1 /app/image/runner/supervise.mjs
