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

The manager's job stops at the worker process. **The manager's credential** never crosses the container
boundary.

A **value** may, and one thing already does: the provider API key is read on the host and injected as an
environment variable into every job. `run.secrets` (below) is that same shape, made per trigger. The line
this page draws is not "nothing crosses", it is **the thing that can fetch secrets stays on the host**. A
job that holds a resolved Stripe key can spend that key; a job that holds `OP_SERVICE_ACCOUNT_TOKEN` can
read every secret you own. The first is a bounded exposure you chose per trigger. The second is the
unbounded one this page has always refused.

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
hand is the mistake this seam exists to remove. **And nothing that changes what a signal does**: no
`trap`, no backgrounded process. Your script is sourced inside the process the service manager stops, so
a handler you install is a handler that runs instead of the wrapper's, and that costs the worker its
graceful drain. Trap 5 below has the whole of it.

```sh
#!/bin/sh
# /etc/pi-dispatch/setup-env.sh. Readable by the account the unit runs as and writable by nobody
# else: the service manager sources this file at every boot, so whoever can edit it owns the worker.
# `pi-dispatch doctor` warns when that stops being true -- for this file and for the directory it
# sits in, since a world-writable directory means anyone can replace the file whatever its own mode.
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

## Recipe C: one secret, one trigger, resolved before the container starts

Recipes A and B give the WORKER an environment. Every job on the host then shares it. When you want one
trigger to hold a deploy key and no other job to hold it, name the secret in the trigger instead:

```jsonc
{ "on": { "type": "label", "any": ["pi:deploy"] },
  "run": { "kind": "github", "flow": "deploy",
           "secretsProfile": "prod",
           "secrets": { "STRIPE_KEY": "op://ci-vault/stripe/api-key" } } }
```

You declare the resolver once, either in the environment or from the panel:

```sh
# /etc/pi-dispatch/pi-dispatch.env, beside your forge token and your provider key.
PI_SECRET_PROFILES=prod:/opt/pi/resolve-prod.sh,staging:/opt/pi/resolve-staging.sh
```

```sh
#!/bin/sh
# /opt/pi/resolve-prod.sh. Owned by the account the worker runs as and writable by nobody else: whoever
# can edit this file can run code as the worker. `pi-dispatch doctor` warns when that stops being true.
#
# One reference in on $1, one value out on stdout.
#   exit 2  the reference is wrong, absent, or denied. The job refuses and is NOT retried.
#   exit 1  you could not reach your manager. The job retries, which is the whole reason these differ.
exec op read --no-newline "$1"
```

That is the entire integration for 1Password. The offline and Vault spellings are the same one line:

```sh
exec pass show "$1"                                  # pass, gpg-backed, no network at all
exec vault kv get -field="${1##*#}" "${1%%#*}"       # Vault, reference written as secret/data/ci#stripe
exec gcloud secrets versions access latest --secret="$1"
```

**The reference grammar is yours, not this project's.** `op://ci-vault/stripe/api-key` is what a 1Password
operator writes because that is what their resolver understands. pi-dispatch validates the SHAPE of the map
(the keys are environment variable names, the values are non-empty strings) and never the meaning of a
value. Nothing here knows what `op://` is, and that is deliberate: the day you move to Doppler, you rewrite
one script.

### What the job gets, and what it does not

The worker runs your resolver **on the host**, once per reference, **before the container starts**. The
container receives the resolved values as ordinary environment variables, exactly the way it already
receives the provider key. It does not receive `OP_SERVICE_ACCOUNT_TOKEN`, it cannot run `op`, and it cannot
ask for a reference nobody named in the reviewed file.

Because resolution happens before anything spends, a wrong reference costs nothing: no token is minted, no
repository is cloned, no budget slot is reserved. You get a refusal on the issue naming the VARIABLE that
failed, and never the reference, the resolver's path, or a byte of what it printed.

### Four things worth knowing before you wire one

1. **Your exit code decides whether the job retries.** This is the same question this page asks of every
   manager, and here it is load-bearing rather than advisory. Exit 2 means "that reference is wrong" and the
   delivery is refused for good. Exit 1 means "I could not reach my manager" and BullMQ retries it. A
   resolver that exits 1 for everything still works; you simply pay one extra retry on a genuine typo.
2. **`run.secrets` cannot be combined with `run.resume`.** A resumed job replays a transcript kept on host
   disk, and any command the agent ran that echoed a resolved value wrote it into that transcript, which is
   then prefilled into every later job on the same key. The file is refused at load if you write both.
3. **On a `local` (cron) trigger, `/workspace` is your own folder**, bind-mounted read-write with no clone.
   An agent handed a credential often persists it to make its next command simpler, and on a local job that
   `.env` lands in your real repository. Nothing scans for it. `pi-dispatch doctor` warns when a local
   trigger binds secrets; keep those folders out of anything you push.
4. **All three packages must be new enough to carry the field, and they move together.** `run.secrets`
   ships in `@edgehero/pi-dispatch` 1.3.0, `@edgehero/pi-dispatch-admin` 1.3.0 and
   `@edgehero/pi-dispatch-receiver` 1.2.0; that is the floor. The skew that matters is a stale receiver:
   it matches the rule, enqueues the job WITHOUT the secrets, and the worker sees an unarmed job -- the
   container then runs with the variable unset on a clean exit, which is exactly the silent no-op this
   feature is built to refuse. A stale admin fails the other way, visibly, refusing every trigger write
   while the file holds a `run.secrets` entry. Upgrade the receiver in the same `npm install` as the
   worker, before you bind the first secret.

### From the panel

`/dispatch secrets add` asks two questions (a name and the path to the script) and shows you the exact bytes
before writing them. It is operator-typed only: there is no model-callable tool for it, because declaring a
profile means naming a path the worker executes.

For the panel to declare anything at all you must first name the directory those scripts live in:

```sh
PI_SECRET_RESOLVER_ROOTS=/opt/pi
```

Unset is the default and it is fail-closed: the panel can declare nothing, and only `PI_SECRET_PROFILES`
is honoured. The worker re-checks that bound itself, on the real path, every time it resolves. That is not
belt-and-braces: the settings file the panel writes lives under your OS temp directory unless you moved it
with `PI_SETTINGS_FILE`, so a check that lived only in the panel would prove nothing on a shared host.

**Binding a secret to a trigger stays a file edit.** The panel declares managers; `triggers.json` says which
job reaches one. No `dispatch_*` tool has a `secrets` parameter.

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

### 5. A setup script that touches signals takes the drain with it

Your script is **sourced**, not run. It executes inside the very process the service manager stops, and it
owns that process for as long as it takes to answer, which for a secrets manager is a network round trip.
Three things follow, and not one of them shows up in a log line.

**`trap … TERM` in your script replaces the wrapper's.** The wrapper re-asserts its own handler after
sourcing you, so a handler you leave behind is undone. A handler that runs *during* the sourcing is not:
yours ran, the wrapper's did not, and the drain that should have followed did not happen.

**`trap '' TERM` is worse, and part of it cannot be undone.** A signal ignored while it is ignored is
discarded, not queued: the manager reports the stop as delivered and nothing received it. Worse, a
process started from a shell where `TERM` is ignored inherits that, so the worker itself would be unable
to trap `TERM` at all. Re-asserting a real handler before the launch is what restores it.

**A backgrounded process (`… &`) outlives you.** It inherits the unit's stdio, so the manager can be left
waiting on a pipe held by something it does not know exists, and on macOS it is killed without warning
when `ExitTimeOut` expires. If your manager needs a long-lived agent, run it as its own service
(Recipe B), not out of a setup script.

A stop that arrives while your script is still running is handled, and handled by *not starting*: the
wrapper traps `TERM` and `INT` before it sources anything, and if one arrives it exits `0` without ever
launching the worker, saying so:

```
worker-env-wrapper: stopped before the worker started -- a stop signal arrived while the environment was
being prepared, so the command was never launched; exiting 0 (nothing to restart)
```

Exit `0` for the same reason the exit-2 conversion exists: it is the only code launchd's `KeepAlive`
leaves stopped, and relaunching a service the operator just stopped, into the half-built environment your
script had not finished, is not a recovery.

On **Windows** none of this applies, because `worker-env-wrapper.cmd` has no `trap` and cmd has no
equivalent. A stop that lands while your `.cmd` setup is running is whatever nssm's stop does to the
process tree. The asymmetry is named in the file and in `DES-SERVICE-ENV-SETUP-SEAM`, and it is not
closed.

Note that `pi-dispatch doctor` cannot help you here. It never opens the script, by design, so it can say
nothing about what is inside one.

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

## What doctor says about the setup script itself

Once the unit is installed, doctor reads the **script** too. It has to find it first, and the only
record of the path is the unit `service install` wrote -- so doctor reads that unit back: the
`ExecStart` line on systemd, the `EnvironmentVariables` dict on launchd, and `nssm get
AppEnvironmentExtra` on Windows. Only units whose `WorkingDirectory` is *this* deployment count, so a
host running two deployments never hears about its neighbour's. If no installed unit names one,
`PI_ENV_SETUP` in doctor's own environment answers instead, and the line says so rather than blurring
the two.

A healthy deployment gets one line:

```
✓ env-setup script present (/etc/pi-dispatch/setup-env.sh, named by /home/pi/.config/systemd/user/pi-dispatch-worker.service)
```

and a deployment that does not use the seam at all gets nothing -- not one added line. The three ways
it can go wrong each get their own:

```
⚠ the env-setup script at /etc/pi-dispatch/setup-env.sh does not exist (named by …/pi-dispatch-worker.service)
    → restore it, or re-render without --env-setup -- the service manager sources it at every boot, so
      until it is back the unit exits 1 in a restart loop and the worker never starts (docs/secrets.md)

⚠ the env-setup script at /etc/pi-dispatch/setup-env.sh is group/world-writable
    → chmod go-w /etc/pi-dispatch/setup-env.sh -- the service manager sources it at every boot as the
      account that holds the provider key and the forge token, so whoever can edit it owns the worker

⚠ the env-setup script at /etc/pi-dispatch/setup-env.sh is inside a git work tree that does not ignore it
    → move it outside that repo, or ignore it there -- it holds no secret by design, but it holds the
      commands that FETCH them …
```

Three things doctor deliberately does not do. It never **opens** the script: the path is named, the
contents are not read, because what the file holds is the commands that fetch your secrets and echoing
those would publish the map instead of the treasure. It never offers a `--fix` for any of these --
doctor does not `chmod` your file and does not move it out of a repository. And a missing script is a
**warning**, not a failure: it breaks the boot path, not `pi-dispatch worker` typed by hand, so doctor
still exits 0 and so does `up`.

The mode check is `go-w`, not `go-r`, and that asymmetry is the point. The script is *executed*, so
writability is the risk; that it is readable is fine, because by design it holds no secret. Windows has
no mode check at all -- stat modes are synthetic there, so it would warn on every healthy deployment.

`pi-dispatch service status` names the configured script too, as one plain line with no verdict
attached. Use it to answer "is a seam configured, and which file"; use `doctor` to answer "and is it
still safe".

## Other managers

Every one of them is one of **three** shapes on this page: **inject into the process** (Vault Agent's
`env` templating, `doppler run`, `op run`, `sops exec-env`, `aws-vault exec`) or **render a file the
unit already reads** (Vault Agent templates, `sops -d`, the Infisical agent). Both work here, because
the worker only ever reads its environment. The third is **resolve one reference on demand** (`op read`,
`pass show`, `vault kv get -field=`), which is Recipe C: the first two are deployment-wide by construction,
and that one is per trigger.

Ask any of them the same question this page had to ask: **what does it do to my exit code?** A wrapper
that reports its own status instead of the child's turns a policy refusal into a restart loop, and you
will not find out from a log line. Test it with `<your wrapper> -- sh -c 'exit 2'; echo $?` before it
goes in front of a provider account.

Ask a second question while you are there: **what does it do to my signals?** A runner that installs its
own handler, or forwards `TERM` late, or not at all, turns a 30 second graceful drain into a hard kill,
and you will not find that out from a log line either. Run
`<your wrapper> -- sh -c 'trap "echo drained; exit 0" TERM; sleep 30' &` and then `kill -TERM` the
wrapper: you should see `drained`.

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
  ignored; the exit-2 conversion survived the seam; and the `SIGTERM` drain survived it **for a worker
  already running**. What was not measured then, and is now: a stop arriving *while the setup script is
  still running*, which until this release killed the wrapper on `TERM`'s default disposition, and a stop
  arriving in the window between the launch and the wrapper knowing the worker's pid, which was forwarded
  to nothing at all. Both are covered by tests against the shipped file under a real `sh`, and the second
  was reproduced first by widening only that window in a copy of it.

The read-back doctor uses was measured the same way: every rendered unit on all three platforms was fed
straight back through the reader and returned the path that went in, a unit rendered without the flag
read as no seam, and a hand-rewritten `ExecStart` read as no seam rather than as a guess. A group- and a
world-writable script each warned, a world-readable one did not, a world-writable directory warned and a
sticky one did not, and a unit whose `WorkingDirectory` named a different deployment produced no output
at all.

Versions move. The exit-code behaviour in particular is a bug shape that a future release may fix, so
re-run the two-second check above rather than trusting this page forever.
