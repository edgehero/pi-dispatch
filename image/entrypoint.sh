#!/bin/sh
# Thin by design. The runner owns the outcome, including the exit code that
# INT-RUNNER-EXIT-CODE-PROTOCOL depends on -- adding logic here would put a second
# author on that contract.
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
exec /opt/pi-dispatch/runner-node /app/image/runner/supervise.mjs
