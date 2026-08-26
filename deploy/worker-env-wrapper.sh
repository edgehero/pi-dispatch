#!/bin/sh
# pi-dispatch launcher for daemon managers that have NO EnvironmentFile mechanism. systemd reads
# `.env` for you via `EnvironmentFile=` (see deploy/worker.service); launchd (macOS) has no equivalent --
# a plist's ProgramArguments cannot name a `.env`. This wrapper closes that gap: it sources `./.env`
# from the directory it is STARTED IN, then runs the command it was handed. Its exit-code conversion
# and signal forwarding are exercised under `sh` by worker/test/service.test.mjs.
#
# CONTRACT (issue #96 -- nothing here is guessed from this script's own location any more):
#   - The current directory IS the deployment folder. The daemon manager guarantees it: launchd sets
#     the plist's WorkingDirectory, nssm sets AppDirectory. The old `cd "$(dirname "$0")/.."` self-guess
#     was right only in a repo checkout; under `npm install` this script lives at
#     node_modules/@edgehero/pi-dispatch/deploy/, whose parent is the package -- no `.env` there, ever.
#   - PI_ENV_SETUP, when set, is an absolute path to the OPERATOR's own env-setup script (issue #209,
#     `pi-dispatch service --env-setup`). It is sourced after ./.env, and with it set ./.env becomes
#     optional -- the only case where this wrapper starts without one.
#   - "$@" IS the command, e.g.:  /path/to/node /abs/path/to/src/cli.mjs worker
#     `pi-dispatch service` composes it with absolute paths (the same node that rendered, the worker
#     package's own cli.mjs or the receiver package's start.mjs) and puts it in the unit's
#     ProgramArguments / AppParameters. This wrapper no longer decides WHAT to run -- only the env it
#     runs in and what its exit code means -- so an empty argv is a configuration error, refused below.
#
# It sources ONLY the declared `.env` (see `.env.example`), never the host login shell: the
# container-boundary rules require an explicit, auditable variable set, not whatever the operator's
# profile happens to export. Nothing here contains a credential -- the secrets live in `.env`, which is
# gitignored and read at runtime.
#
# TRAP: inside pi, `ANTHROPIC_OAUTH_TOKEN` silently takes precedence over `ANTHROPIC_API_KEY`. Set exactly
# one in `.env`; this wrapper only ADDS the `.env` vars on top of the current environment, it does not
# clear a stray pre-existing one, so a leaked host `ANTHROPIC_OAUTH_TOKEN` would still win.
#
# One worker per host (DES-CONCURRENCY-3): parallelism is PI_CONCURRENCY inside the single process, not
# multiple daemons. Requires the AOF-enabled Valkey from deploy/docker-compose.yml.

if [ "$#" -eq 0 ]; then
	echo "worker-env-wrapper: no command given -- expected: worker-env-wrapper.sh /path/to/node /path/to/script [args...]; the unit's ProgramArguments/AppParameters carry these (re-render with: pi-dispatch service render)" >&2
	exit 1
fi

# STOP HANDLING IS ARMED HERE, above everything below that can block (issue #221). It closes two windows,
# both of which used to swallow a stop in silence.
#
# Until this line TERM/INT carry their DEFAULT disposition, and the sourcing below can take arbitrarily
# long: PI_ENV_SETUP is an operator's secrets manager, so docs/secrets.md's own worked example makes a
# network round trip inside it. A stop landing there killed this shell where it stood, mid-preparation,
# with nothing anywhere saying the environment had been half-built. That is reachable from this project's
# own CLI, not just from the daemon: `pi-dispatch service stop` on macOS is `launchctl kill SIGTERM` at
# this pid.
#
# The other window is two instructions wide, and is closed by the re-send after `child=$!` below. The
# handler is a FUNCTION rather than a trap string because it is installed twice -- here, and again after
# the sourcing -- and one behaviour spelled out in two places is one behaviour that can drift.
signaled=0
child=
wrapper_on_stop() {
	signaled=1
	# `child` is empty until the fork below has been assigned, and `kill -TERM ""` kills nothing and
	# fails silently, so a stop arriving before then has no pid to reach. It is not lost: the re-send
	# after `child=$!` re-delivers it, and the launch gate refuses to start at all if nothing was
	# started yet.
	[ -n "$child" ] && kill -TERM "$child" 2>/dev/null
	# Never leave a nonzero status behind. `rc=$?` is read immediately after the `wait` this interrupts,
	# and the double wait at the bottom keys on rc >= 128.
	return 0
}
trap wrapper_on_stop TERM INT

# The env-setup seam (issue #209): `pi-dispatch service render|install --env-setup <path>` puts an
# operator-typed path here -- the plist's EnvironmentVariables dict on macOS, nssm's AppEnvironmentExtra
# on Windows -- so a secrets manager can fill this process's environment without anyone hand-editing a
# rendered unit. Captured BEFORE ./.env is sourced, on purpose: the path is UNIT configuration, and a
# `.env` line must never be able to name a script this wrapper then runs.
env_setup="${PI_ENV_SETUP:-}"

if [ -f ./.env ]; then
	set -a; . ./.env; set +a
elif [ -z "$env_setup" ]; then
	echo "worker-env-wrapper: .env not found in $PWD -- this wrapper must be started in the deployment folder (the unit's WorkingDirectory / nssm AppDirectory); it no longer guesses a location from its own path" >&2
	exit 1
else
	# Only a configured seam earns this: the environment demonstrably comes from somewhere else.
	echo "worker-env-wrapper: no .env in $PWD -- the environment comes from $env_setup (PI_ENV_SETUP)" >&2
fi

# AFTER ./.env, deliberately. The manager is the newer source of truth, so a stale key left in the file
# loses instead of silently shadowing the managed one -- the one asymmetry an operator cannot see in a
# log line. It also matches systemd, where EnvironmentFile= is applied before ExecStart runs its setup.
#
# A missing or failing setup exits 1: infrastructure, worth a restart. NEVER 2, which is EXIT_POLICY,
# the determinate refusal the conversion at the bottom deliberately turns into a clean stop. (A setup
# script that calls `exit 2` ITSELF still exits 2 -- sourcing cannot intercept that -- so do not.)
if [ -n "$env_setup" ]; then
	if [ ! -f "$env_setup" ]; then
		echo "worker-env-wrapper: PI_ENV_SETUP=$env_setup does not exist -- re-run \`pi-dispatch service install --env-setup <path>\` with a path that does" >&2
		exit 1
	fi
	# set -a so a bare KEY=value exports, exactly as ./.env above and systemd's EnvironmentFile= do.
	set -a
	if ! . "$env_setup"; then
		echo "worker-env-wrapper: PI_ENV_SETUP script failed ($env_setup): exiting 1 so the service manager retries, never 2" >&2
		exit 1
	fi
	set +a
fi

# RE-ASSERTED after the sourcing, and this is not belt-and-braces. A sourced script runs in THIS shell,
# so a `trap ... TERM` inside one REPLACES the handler above and the drain silently disappears -- a
# manager's cleanup helper does exactly that. One line restores it. What it cannot undo is a script that
# IGNORES TERM (`trap '' TERM`): a signal discarded while it was ignored is already gone, and the child
# forked below would inherit SIG_IGN and be unable to trap TERM at all. That is why docs/secrets.md now
# tells operators not to touch signals in a setup script.
trap wrapper_on_stop TERM INT

# A stop that arrived while the environment was being prepared is honoured by NOT STARTING. Launching now
# would hand the service manager a worker it has already asked to go away: it would reserve a budget slot
# and take a job, and then need a drain nobody is waiting for. Exit 0 because 0 is the only code launchd's
# KeepAlive/SuccessfulExit=false leaves stopped -- the same reason the exit-2 conversion at the bottom
# exists. Not 2, because nothing was refused; not 1, because nothing failed; the manager's own instruction
# was carried out, and this says so rather than exiting mute.
if [ "$signaled" -eq 1 ]; then
	echo "worker-env-wrapper: stopped before the worker started -- a stop signal arrived while the environment was being prepared, so the command was never launched; exiting 0 (nothing to restart)" >&2
	exit 0
fi

# `exec` is deliberately GONE here (it used to hand this shell's pid straight to node): intercepting
# the exit code needs a parent still alive after node exits. launchd's KeepAlive/SuccessfulExit=false
# relaunches ANY nonzero exit -- including EXIT_POLICY (2, worker/src/exit-code.mjs), the determinate
# config/budget refusal that systemd (RestartPreventExitStatus=2) and nssm (AppExit 2 Exit) both
# deliberately never retry. A relaunch loop against a paid provider is a bill, so the conversion at
# the bottom turns exit 2 into the clean exit KeepAlive leaves stopped.
#
# SIGTERM still reaches node without exec: the handler armed at the top forwards TERM/INT to the child,
# and `wait` (unlike a foreground command in sh, which blocks trap delivery) is interruptible by a trapped
# signal, so the forwarding is immediate and node gets its full graceful drain.
"$@" &
child=$!
# THE FORK WINDOW (issue #221). `$!` is only readable in the parent AFTER the fork, so between the two
# lines above a child exists and its pid does not. A stop landing there ran the handler with nothing to
# forward to, set `signaled`, and was then never looked at again -- so this wrapper waited out the
# command's ENTIRE natural lifetime while the service manager believed it had asked it to stop. Re-sending
# once the pid is known costs one `[` on the healthy path and is the whole difference between a graceful
# drain and a hang as long as the job. Issue #207 found this same drop through the test that saw it and
# fixed only the test; #221 is the same window firing through a different one.
[ "$signaled" -eq 1 ] && kill -TERM "$child" 2>/dev/null
wait "$child"
rc=$?
# The double wait is load-bearing: a trapped signal interrupts the FIRST wait early (rc = 128+signum)
# while node is still draining, so a SECOND wait is needed to collect node's real exit code. Guarded
# on both conditions so a normal exit never waits twice -- re-waiting on an already-reaped pid would
# read as 127, clobbering the true code.
if [ "$signaled" -eq 1 ] && [ "$rc" -ge 128 ]; then
	wait "$child"
	rc=$?
fi

if [ "$rc" -eq 2 ]; then
	echo "worker-env-wrapper: policy refusal (exit 2): not restarting; fix the config and start the service again" >&2
	exit 0
fi
exit "$rc"
