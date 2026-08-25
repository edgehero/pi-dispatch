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
| The forge credential | `GITHUB_PAT`, or the App trio (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`), or `GITLAB_TOKEN` / `FORGEJO_TOKEN` / `AZURE_TOKEN` |
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

Then a start script, and point the unit's `ExecStart=` at it. Everything else in the unit stays exactly
as `pi-dispatch service render` produced it:

```sh
#!/bin/sh
# /etc/pi-dispatch/start-worker.sh, mode 0755. The absolute paths are the ones `service render`
# computed for this host; take them from the ExecStart line you are replacing.
set -e
export INFISICAL_DISABLE_UPDATE_CHECK=true

# Absolute path to the CLI on purpose: a unit's PATH is whatever the service manager gives it,
# which is not your login shell's. Use wherever your install put the binary.
INFISICAL_TOKEN="$(/usr/local/bin/infisical login --method=universal-auth \
    --client-id "$(cat /etc/pi-dispatch/infisical-client-id)" \
    --client-secret "$(cat /etc/pi-dispatch/infisical-client-secret)" \
    --silent --plain)"
export INFISICAL_TOKEN

eval "$(/usr/local/bin/infisical export --format=dotenv-eval --projectId <project-id> --env=prod)"

exec /usr/bin/node /opt/pi-dispatch/worker/src/cli.mjs worker
```

```ini
# deploy/worker.service: this line only. RestartPreventExitStatus=2 and the rest stay as rendered.
ExecStart=/etc/pi-dispatch/start-worker.sh
```

Four things make that shape the right one, and three of them are not obvious:

- **`exec` is load-bearing.** It replaces the shell with node, so the service manager watches the worker
  itself: its exit code is the worker's, its pid is the worker's, and `SIGTERM` reaches the drain
  directly. Drop the `exec` and a shell sits in the middle reporting its own status instead.
- **A script, not an inline `sh -c`.** systemd does its own `$` substitution inside `Exec` lines, so a
  command substitution written there is a quoting question you have to get right per platform. A file has
  no such rules, is reviewable, and is the same file on macOS.
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

Recipe A's `eval` plus `exec` preserves it: the same child exiting `2` exits `2`.

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

### 4. The App key is a path, not a value

`GITHUB_APP_PRIVATE_KEY_PATH` names a file, and the config loader refuses at startup when that file does
not exist. No amount of environment injection satisfies it. Either render the PEM to disk from your
manager (Recipe B's template shape, mode `0600`) or leave it where `pi-dispatch setup github` put it:
`github-app-<slug>.pem` in the deployment folder, written `0600`. If that folder is a checkout of this
repository, note that `.gitignore` covers `.env` and not `*.pem`, so keep the key somewhere your `git
add` cannot reach it.

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

Versions move. The exit-code behaviour in particular is a bug shape that a future release may fix, so
re-run the two-second check above rather than trusting this page forever.
