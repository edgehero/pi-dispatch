@echo off
REM UNTESTED EXAMPLE -- a starting point for the Windows worker service, not a shipped, verified unit.
REM Adapt it. The Linux/systemd equivalent is deploy/worker.service; the macOS one is
REM deploy/com.pi-dispatch.worker.plist.
REM
REM Registers the pi-dispatch worker as a Windows service via nssm (the Non-Sucking Service Manager).
REM nssm is an operator-downloaded binary (https://nssm.cc) -- it is documented here, NOT vendored into
REM this repo; put nssm.exe on PATH before running this. The service's Application is the `.cmd` wrapper
REM (deploy/worker-env-wrapper.cmd), which loads `.env` at runtime -- so NO secrets are inlined here or
REM passed via AppEnvironmentExtra. `.env` is gitignored; nothing in this file is a credential.
REM
REM Why nssm over Task Scheduler: Task Scheduler stops a task with TerminateProcess (a hard kill), which
REM gives the worker no chance to drain the in-flight job -- it then relies on the queue's boot reaper to
REM recover the orphaned container. nssm's AppStopMethodConsole sends a real Ctrl-C first, which node
REM receives as SIGINT for a graceful drain. Task Scheduler is a weaker fallback, not the recommended
REM path.
REM
REM One worker per host (DES-CONCURRENCY-3): parallelism is PI_CONCURRENCY inside the one process, not
REM multiple services. Requires the AOF-enabled Valkey from deploy/docker-compose.yml.
REM
REM Per-host PLACEHOLDERS: set SERVICE / REPO / LOGDIR below for your host before running.
REM
REM PI_LOGS_DIR (run-history records) and PI_SETTINGS_FILE (the settings overlay) default to
REM %USERPROFILE%\.pi-dispatch, which is DURABLE across a reboot. Both are created and written by the
REM worker at boot, so they must be writable by the service account.
REM
REM SET BOTH EXPLICITLY via `.env` (the wrapper), not a change here. The default is per USER, and a
REM service running as LocalSystem resolves it under the system profile, not yours -- so the worker and
REM your /dispatch panel would read different directories, the run list would show nothing, and caps set
REM from the panel would land where the worker never looks. `pi-dispatch up` writes both into `.env`.
REM Keep PI_LOGS_DIR away from the nssm LOGDIR worker.out log set below: the retention sweep deletes
REM every .log and .json past its window. Both are worker-owned and never belong in the container env
REM allowlist.

setlocal

set "SERVICE=pi-dispatch-worker"
set "REPO=C:\pi-dispatch"
set "LOGDIR=C:\pi-dispatch\logs"

REM Application is the wrapper (loads `.env`), not node directly and not an env dict with real values.
nssm install %SERVICE% "%REPO%\deploy\worker-env-wrapper.cmd"
nssm set %SERVICE% AppDirectory "%REPO%"
nssm set %SERVICE% AppStdout "%LOGDIR%\worker.out.log"
nssm set %SERVICE% AppStderr "%LOGDIR%\worker.err.log"

REM Stop = send Ctrl-C (node SIGINT, graceful drain), wait 15000ms (>= the 5s docker-stop grace) before
REM nssm escalates to a hard kill.
nssm set %SERVICE% AppStopMethodConsole 15000

REM StartLimit analogue: pause 5000ms between restarts so a crash loop does not spin the provider bill
REM (mirrors StartLimitIntervalSec/StartLimitBurst + RestartSec in deploy/worker.service).
nssm set %SERVICE% AppThrottle 5000

REM Restart on a crash by default...
nssm set %SERVICE% AppExit Default Restart
REM ...but exit 2 is EXIT_POLICY: a determinate config/budget refusal, never retried. Do NOT restart it
REM (mirrors RestartPreventExitStatus=2 in deploy/worker.service).
nssm set %SERVICE% AppExit 2 Exit

echo Installed service "%SERVICE%". Start it with:  nssm start %SERVICE%

endlocal
