# Secrets, and bringing your own manager

You want the provider key and the forge token out of a file on the deployment host and into Vault,
Infisical, Doppler, 1Password or whatever your organisation already runs. Nothing here stops you, and
nothing here has to change to allow it. The reason is one line of code, and everything below follows
from it.

## The one fact everything follows from

**The worker parses no `.env` file.** It reads the environment:

```js
// worker/src/config.mjs
export function loadConfig(env = process.env, { fileExists = existsSync } = {}) {
```

There is no dotenv dependency in this repository. `.env` is not a format the worker understands — it is
what something else loads on its behalf:

| Where it runs | What puts `.env` into the environment |
|---|---|
| systemd | `EnvironmentFile=` in `deploy/worker.service` |
| launchd (macOS), nssm (Windows) | `deploy/worker-env-wrapper.sh` / `.cmd`, which source `./.env` |
| `docker compose --profile receiver` | `env_file: ../.env` |
| a terminal | you |

Put your manager in that slot instead and the worker cannot tell the difference. Two surfaces already
assume you might, which is the closest this project came to documenting it before this page existed:

- `pi-dispatch doctor` reports `.env present` as a **warning**, never a failure, because *"env may be
  supplied by a service manager instead of a file"*.
- `pi-dispatch up` says `no .env here — skipped (set it wherever your env lives)` rather than writing
  one.

## What actually holds a secret

Everything else in `.env.example` is a dial, and dials are fine in plain sight.

| | |
|---|---|
| The provider key | `ANTHROPIC_API_KEY` or your provider's own variable, per pi's table |
| The forge credential | `GITHUB_PAT`, or the App trio (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`), or `GITLAB_TOKEN` / `FORGEJO_TOKEN` / `AZURE_TOKEN` |
| The webhook secrets | `WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SECRET`, `FORGEJO_WEBHOOK_SECRET`, `AZURE_WEBHOOK_SECRET` |
| `VALKEY_URL` | only when it carries a password |

The receiver is its own process with its own unit, and it needs the webhook secret and `VALKEY_URL` the
same way. Everything on this page applies to it unchanged.

## The rule that governs all of it

**Your manager's credential is a host credential, and it never goes into a job container.** The container
environment is a closed allowlist (`worker/src/env-allowlist.mjs`), and the only way to widen it is
`PI_FORWARD_ENV`. Do not put `INFISICAL_TOKEN`, `VAULT_TOKEN` or their kin in there. A job container
already holds a provider key and a forge token and the agent can read both (`SECURITY.md`); adding a
credential that can read **every** secret in your project is strictly worse than the trade this project
already discloses, and it converts one bounded exposure into an unbounded one.

The manager's job stops at the worker process. Nothing below crosses the container boundary.

## Recipe A: the service, with your exit code intact

This is the one to use. Infisical is the worked example because it is the one that was measured; the
shape is what matters and every manager has it.

Create a machine identity, give it read access to the project, and put its two credentials in files the
unit's user can read and nobody else can:

```bash
install -d -m 0700 /etc/pi-dispatch                  # root-owned, or owned by the unit's user
umask 077
printf '%s' '<client-id>'     > /etc/pi-dispatch/infisical-client-id
printf '%s' '<client-secret>' > /etc/pi-dispatch/infisical-client-secret
```

Then write a script that sets up the environment, and nothing else. **No `exec`, no node path, no path
to the CLI**: those are what `pi-dispatch service` already computes for your host, and getting them by
hand is the mistake this seam exists to remove.

```sh
#!/bin/sh
# /etc/pi-dispatch/setup-env.sh. Readable by the account the unit runs as and writable by nobody
# else: the service manager sources this file at every boot, so whoever can edit it owns the worker.
export INFISICAL_DISABLE_UPDATE_CHECK=true

# Absolute path to the CLI on purpose: a unit's PATH is whatever the service manager gives it,
# which is not your login shell's. Use wherever your install put the binary.
INFISICAL_TOKEN="$(/usr/local/bin/infisical login --method=universal-auth \
    --client-id "$(cat /etc/pi-dispatch/infisical-client-id)" \
    --client-secret "$(cat /etc/pi-dispatch/infisical-client-secret)" \
    --silent --plain)"
export INFISICAL_TOKEN

eval "$(/usr/local/bin/infisical export --format=dotenv-eval --projectId <project-id> --env=prod)"
```

Then point the renderer at it. That is the whole integration, on all three platforms:

```bash
pi-dispatch service install --env-setup /etc/pi-dispatch/setup-env.sh
pi-dispatch service render  --env-setup /etc/pi-dispatch/setup-env.sh   # to read it first
```

On Linux the rendered `ExecStart` becomes one line, and every part of it is load-bearing:

```ini
ExecStart=/bin/sh -c 'set -a; . "/etc/pi-dispatch/setup-env.sh" || exit 1; set +a; exec "/usr/bin/node" "/opt/pi-dispatch/worker/src/cli.mjs" "worker"'
```

- **`exec` is why the renderer owns this line.** It replaces the shell with node, so the service manager
  watches the worker itself: its exit code is the worker's, its pid is the worker's, and `SIGTERM`
  reaches the drain directly. Drop the `exec` and a shell sits in the middle reporting its own status,
  which is the same defect as the first trap below.
- **`|| exit 1` is the other half.** A setup that fails (expired token, unreachable manager) exits `1`,
  which is infrastructure and worth a restart. It is never `2`, which means a determinate refusal and
  must stay stopped. Your script must not call `exit 2` itself: sourcing cannot intercept that.
- **`set -a` exports a bare `KEY=value`,** exactly as `EnvironmentFile=` does, so a script that just
  `eval`s dotenv output works without adding `export` to every line.
- **`EnvironmentFile=` is untouched, and your setup runs after it.** A stale key left in `.env` loses
  instead of shadowing the managed one, which retires the third trap below for this deployment.

On macOS and Windows there is no `sh -c`: the path rides the unit itself (the plist's
`EnvironmentVariables` dict, `nssm set … AppEnvironmentExtra`) as `PI_ENV_SETUP`, and
`worker-env-wrapper.sh` / `.cmd` sources it after `./.env` with the same rules. Nothing is quoted into a
shell anywhere, and `ProgramArguments` and `AppParameters` are byte-identical to a default render. With
`PI_ENV_SETUP` set, `./.env` becomes optional on those platforms: it is the only case where the wrapper
starts without one.

The path must be absolute and free of characters the unit format would reinterpret (`$` and a quote on
Linux, `<`, `>` and `&` on macOS, `%` on Windows). The renderer refuses the rest by name rather than
rendering something that means a different thing at boot, and it refuses a path that is not there at all.

Two more properties of the recipe, neither obvious:

- **`--format=dotenv-eval` is the export format to use.** It POSIX-quotes every value, so a secret
  holding a quote, a newline or a `$` survives `eval` intact.
- **Nothing is written to disk.** The secrets live in the process environment and nowhere else.

The client secret does appear in the `infisical login` argv for the moment that command runs, which is
readable by anything that can list processes on that host. If that matters to you, let Recipe B's agent
deposit a renewed token into a file and read `INFISICAL_TOKEN` from there instead.

For a terminal or a CI step, where none of the exit-code machinery is watching, the short form is fine:

```bash
export INFISICAL_TOKEN="$(infisical login --method=universal-auth --client-id … --client-secret … --silent --plain)"
infisical run --projectId <project-id> --env=prod -- pi-dispatch doctor
```

**Do not use `infisical run` in a unit file.** See the first trap below; it is the reason this page
leads with `export` and `exec`.

## Recipe B: a rendered file, for launchd and nssm

macOS and Windows do not have `EnvironmentFile=`. Their units run `deploy/worker-env-wrapper.sh` (or
`.cmd`), which sources `./.env` from the deployment folder and **refuses to start without it**. So on
those platforms the file has to exist, and the manager's job is to write it.

The Infisical agent does exactly this, and re-renders when a secret changes:

```yaml
# /etc/pi-dispatch/infisical-agent.yaml
infisical:
  address: "https://app.infisical.com"
auth:
  type: "universal-auth"
  config:
    client-id: "/etc/pi-dispatch/infisical-client-id"
    client-secret: "/etc/pi-dispatch/infisical-client-secret"
templates:
  - source-path: /etc/pi-dispatch/env.tmpl
    destination-path: /opt/pi-dispatch/.env
    config:
      polling-interval: 60s
      execute:
        command: launchctl kickstart -k gui/$(id -u)/com.pi-dispatch.worker
        timeout: 60
```

```gotemplate
{{- with listSecrets "<project-id>" "prod" "/" }}
{{- range . }}
{{ .Key }}={{ .Value }}
{{- end }}
{{- end }}
```

**Create the destination `0600` before you start the agent.** It writes templates with `os.Create`, which
means mode `0666` minus your umask: under the usual `022` that is a **world-readable file holding your
provider key**. Two things fix it, and both were measured: pre-create the file (`install -m 0600
/dev/null /opt/pi-dispatch/.env`), since an existing file keeps its mode, or run the agent under `umask
077`. Do one of them.

This recipe also works on systemd, and it is the better choice there when you want the shipped unit
byte-unchanged: leave `EnvironmentFile=` alone, point the agent at the same path, and let its `execute:`
restart the unit when a secret rotates.

Recipe A and Recipe B are not exclusive on macOS and Windows. `--env-setup` makes `./.env` optional
there; an agent that renders `.env` makes it authoritative. Pick one, because running both means two
sources for the same key, and the setup script is the one that wins.

## The traps

### 1. `infisical run` collapses your exit code, and that one costs money

Measured, against the real CLI: a child that exits `2` makes `infisical run` print `failed to wait for
command termination: exit status 2` and exit **`1`**. A child that exits `3` also becomes `1`. Only `0`
survives.

Exit `2` is this project's policy refusal (`INT-RUNNER-EXIT-CODE-PROTOCOL`): a determinate config or
budget failure that must never be retried. It is exit `2` that `deploy/worker.service`'s
`RestartPreventExitStatus=2` reads, that nssm's `AppExit 2 Exit` reads, and that
`worker-env-wrapper.sh` converts to a clean exit so launchd's `KeepAlive` leaves it stopped. Wrap the
worker in `infisical run` and every one of those sees a crash instead, and restarts a refusal that was
supposed to stay stopped. That is a supervisor loop in front of a paid provider, which is the exact
failure the wrapper gave up its own `exec` to prevent.

`SIGTERM` is forwarded correctly, so the graceful drain still works. It is only the exit code that is
lost, and it is lost silently.

Recipe A preserves it, and does not ask you to get it right: `pi-dispatch service --env-setup` renders
the `exec` itself. Measured under systemd 252 with a stub worker exiting `2`: `ExecMainStatus=2` and
`NRestarts=0`, so `RestartPreventExitStatus=2` saw a real refusal and left it stopped. The same unit
with a setup script that fails reports `ExecMainStatus=1` and restarts, and the worker never runs.

### 2. `export` does not filter reserved names, and `run` does

`infisical run` refuses to inject twelve names (`HOME PATH PS1 PS2 PWD EDITOR XAUTHORITY USER TERM
TERMINFO SHELL MAIL`) and two prefixes (`XDG_`, `LC_`), printing a warning for each. **`infisical export`
emits them verbatim.** Measured: with a secret named `PATH` in the project, `eval "$(infisical export
…)"` replaced the shell's `PATH` and the next binary lookup failed.

That matters more here than in most services, because the worker resolves its tools by name at job time,
not at boot: `docker` (`worker/src/run-container.mjs`), `git` (`worker/src/prepare-github.mjs`) and `gh`.
A clobbered `PATH` starts the worker cleanly and then fails every job.

Keep the folder that feeds the worker free of those names. Recipe A's `exec` uses an absolute node path
for the same reason.

### 3. On macOS and Windows, `.env` wins

`worker-env-wrapper.sh` sources `./.env` **inside** the process it is about to run, which is after your
manager injected anything. Measured: with `FOO` set both in `.env` and in the manager, the child saw the
`.env` value; with the provider key only in the manager, the child saw the manager's.

So a stale key left in `.env` silently shadows the managed one, and it is silent precisely because every
other key still works. On those platforms, either let the manager own the whole file (Recipe B) or keep
`.env` free of anything the manager also holds.

**Unless you use `--env-setup`.** The wrapper sources that script *after* `./.env`, deliberately, so the
manager wins and the stale key loses. That is the one arrangement on macOS and Windows where the two can
disagree safely.

### 4. The App key has two homes, and exactly one at a time

`GITHUB_APP_PRIVATE_KEY` takes the PEM itself, which is what makes App auth reachable for a deployment
with no key file at all. Real newlines and `\n` escapes both work, and it is checked at load, so a
truncated paste refuses at boot instead of failing at the first mint. **Set exactly one of it and
`GITHUB_APP_PRIVATE_KEY_PATH`**: both set is a refusal, not a precedence rule.

**Never list it in `PI_FORWARD_ENV`.** The worker refuses that at load, and the reason is worth knowing:
the App's signing key mints installation tokens for every repository the App is installed on, so putting
it in a job container is strictly worse than the per-job token that container already holds.

If you keep the file instead, `pi-dispatch setup github` leaves it at `github-app-<slug>.pem` in the
deployment folder, mode `0600`. That mode protects it from other users on the host and not at all from a
commit, so this repository's `.gitignore` covers `*.pem` and `pi-dispatch doctor` warns when the key sits
in any git work tree that does not ignore it.

## What doctor says when there is no file

Nothing alarming, and this is worth seeing once before you trust it:

```
⚠ .env present
    → run `pi-dispatch init` to scaffold one (or supply env via your service manager)
✓ Provider key set (anthropic: ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN)
```

That is `pi-dispatch doctor` under Recipe A with no `.env` anywhere on the host. The warning is advisory
by design, the provider key resolved from the injected environment, and every other check behaved
normally. Run `doctor` through your manager once, exactly the way the unit will, before you enable the
service.

## Other managers

Every one of them is one of the two shapes on this page: **inject into the process** (Vault Agent's
`env` templating, `doppler run`, `op run`, `sops exec-env`, `aws-vault exec`) or **render a file the
unit already reads** (Vault Agent templates, `sops -d`, the Infisical agent). Both work here, because
the worker only ever reads its environment.

Ask any of them the same question this page had to ask: **what does it do to my exit code?** A wrapper
that reports its own status instead of the child's turns a policy refusal into a restart loop, and you
will not find out from a log line. Test it with `<your wrapper> -- sh -c 'exit 2'; echo $?` before it
goes in front of a provider account.

The question disappears entirely if you keep the manager inside an `--env-setup` script instead of
wrapping the worker in its runner, because then nothing sits between the service manager and the worker.
That is the shape to prefer, whichever manager you run.

## How this was verified

Everything on this page was run, none of it against a paid completion. The lab was a self-hosted
Infisical (server `v0.162.24`, CLI `v0.43.125`) in throwaway containers, a machine identity with
Universal Auth, and a project holding a fake provider key.

- `infisical run -- sh -c 'exit 2'` exited `1`; `exit 3` exited `1`; `exit 0` exited `0`.
- Recipe A's start script, run as a file, minting a token from the two credential files and `exec`ing
  the child: exit `2` arrived as `2`.
- A secret set on the host as an environment variable **and** in the project arrived with the project's
  value: the manager wins over inherited environment.
- `pi-dispatch doctor` ran under both recipes in a folder with no `.env` and reported the two lines
  quoted above.
- The agent rendered `.env` at mode `644` by default, and at `600` both when the destination was
  pre-created `0600` and when the agent ran under `umask 077`.
- With a `PATH` secret in the project, `infisical run` dropped it with a warning and `infisical export`
  did not.
- `SIGTERM` through `infisical run` reached the child, which ran its own trap before exiting.
- The real `deploy/worker-env-wrapper.sh` was exercised for the precedence and the missing-file refusal.

The `--env-setup` seam was measured separately, under a real systemd (252) in a throwaway container and
under the real `sh` on macOS:

- A rendered unit with the seam: `systemd-analyze verify` clean, and `systemctl show -p ExecStart`
  confirms systemd passes the whole script to `sh -c` as ONE argument.
- The worker exiting `2` under it: `ExecMainStatus=2`, `NRestarts=0`. Exiting `7`: restarts, as before.
- A setup script that fails: `ExecMainStatus=1`, restarts, and the worker never ran.
- Both an `export KEY=…` line and a bare `KEY=value` reached the worker's environment.
- On the wrapper path: the setup script beat a stale `.env` value; a missing `./.env` started instead of
  refusing; a missing or failing setup exited `1`; a `PI_ENV_SETUP=` line planted *inside* `.env` was
  ignored; and both the exit-2 conversion and the `SIGTERM` drain survived the seam.

Versions move. The exit-code behaviour in particular is a bug shape that a future release may fix, so
re-run the two-second check above rather than trusting this page forever.
