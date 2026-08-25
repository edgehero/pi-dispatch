@echo off
REM UNTESTED EXAMPLE -- a starting point for a Windows service, not a shipped, verified unit. Adapt it.
REM
REM pi-dispatch launcher for Windows service managers (nssm; see deploy/nssm-install.cmd). Windows
REM services have no `.env` mechanism, so this wrapper loads `.env` from the current directory itself,
REM then runs the command it was handed. It reads ONLY the declared `.env` (see `.env.example`), never
REM the host user profile: the container-boundary rules require an explicit, auditable variable set.
REM Nothing here contains a credential -- the secrets live in `.env`, which is gitignored and read at
REM runtime.
REM
REM CONTRACT (issue #96 -- mirrors the .sh twin; nothing is guessed from this script's location):
REM   - The current directory IS the deployment folder. nssm's AppDirectory guarantees it, set both by
REM     deploy/nssm-install.cmd and by `pi-dispatch service install`. The old `cd /d "%~dp0.."`
REM     self-guess was right only in a repo checkout; under `npm install` this script lives at
REM     node_modules\@edgehero\pi-dispatch\deploy\, whose parent is the package -- no `.env` there.
REM   - PI_ENV_SETUP, when set, is an absolute path to the OPERATOR's own env-setup .cmd (issue #209,
REM     `pi-dispatch service --env-setup`). It is `call`ed after .env, and with it set .env becomes
REM     optional -- the only case where this wrapper starts without one.
REM   - The arguments ARE the command, e.g.:  C:\path\to\node.exe C:\...\src\cli.mjs worker
REM     `pi-dispatch service install` passes them via nssm AppParameters. This wrapper no longer
REM     decides WHAT to run -- only the env it runs in and what its exit code means -- so an empty
REM     argument list is a configuration error, refused below.
REM
REM TRAP: inside pi, ANTHROPIC_OAUTH_TOKEN silently takes precedence over ANTHROPIC_API_KEY. Set exactly
REM one in `.env`.
REM
REM `.env` FORMAT for this loader: KEY=VALUE, one per line. Values MUST be UNQUOTED -- cmd's `set` keeps
REM surrounding quotes as part of the value. `eol=#` skips `#` comment lines; blank lines are ignored.
REM `tokens=1,* delims==` splits on the FIRST `=` only, so values containing `=` (base64, API keys)
REM survive intact.
REM
REM One worker per host (DES-CONCURRENCY-3): parallelism is PI_CONCURRENCY inside the single process, not
REM multiple services. Requires the AOF-enabled Valkey from deploy/docker-compose.yml.

setlocal

if "%~1"=="" (
  echo worker-env-wrapper: no command given -- expected: worker-env-wrapper.cmd node-path script-path [args...]; re-render with: pi-dispatch service render 1>&2
  exit /b 1
)

REM The env-setup seam (issue #209): `pi-dispatch service render|install --env-setup <path>` sets
REM PI_ENV_SETUP via `nssm set <service> AppEnvironmentExtra`, so a secrets manager can fill this
REM process's environment without anyone hand-editing the service registration. Captured BEFORE .env is
REM loaded, on purpose: the path is SERVICE configuration, and a `.env` line must never be able to name
REM a script this wrapper then runs.
set "ENV_SETUP=%PI_ENV_SETUP%"

if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
) else (
  if not defined ENV_SETUP (
    echo worker-env-wrapper: .env not found in "%CD%" -- this wrapper must be started in the deployment folder, the service's nssm AppDirectory; it no longer guesses a location from its own path 1>&2
    exit /b 1
  )
  echo worker-env-wrapper: no .env in "%CD%" -- the environment comes from "%ENV_SETUP%" ^(PI_ENV_SETUP^) 1>&2
)

REM AFTER .env, deliberately: the manager is the newer source of truth, so a stale key left in the file
REM loses instead of silently shadowing the managed one (mirrors the .sh twin). A missing or failing
REM setup exits 1 -- infrastructure, worth a restart -- and NEVER 2, which is EXIT_POLICY, the
REM determinate refusal `AppExit 2 Exit` and the conversion below both key on.
if defined ENV_SETUP (
  if not exist "%ENV_SETUP%" (
    echo worker-env-wrapper: PI_ENV_SETUP="%ENV_SETUP%" does not exist -- re-run `pi-dispatch service install --env-setup ^<path^>` with a path that does 1>&2
    exit /b 1
  )
  call "%ENV_SETUP%"
  if errorlevel 1 (
    echo worker-env-wrapper: the PI_ENV_SETUP script failed ^("%ENV_SETUP%"^): exiting 1 so the service manager retries, never 2 1>&2
    exit /b 1
  )
)

REM The argv runs verbatim -- absolute node, absolute script, composed by `pi-dispatch service` (see
REM the .sh twin for the whole contract).
%*
set "RC=%ERRORLEVEL%"

REM Exit 2 is EXIT_POLICY (worker\src\exit-code.mjs): a determinate config/budget refusal. nssm's
REM `AppExit 2 Exit` already refuses to restart it, but converting to a clean 0 here keeps ANY service
REM manager pointed at this wrapper from relaunch-looping a refusal into a provider bill (mirrors the
REM .sh twin, which exists for launchd's KeepAlive that cannot exclude a single exit code).
if "%RC%"=="2" (
  echo worker-env-wrapper: policy refusal, exit 2: not restarting; fix the config and start the service again 1>&2
  exit /b 0
)
exit /b %RC%
