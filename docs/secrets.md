# Secrets, and bringing your own manager

You want the provider key and the forge token out of a file on the deployment host and into Vault,
Infisical, Doppler, 1Password or whatever your organisation already runs. Nothing here stops you, and
nothing here has to change to allow it. The reason is one line of code, and everything below follows
from it.


**On more than one machine** ([`multi-host.md`](multi-host.md)): a resolver is an absolute path on one
host's disk, so a trigger binding `run.secrets` can only run where its profile is declared. **The receiver
now routes such a delivery to a host that has the profile**, so it no longer succeeds or fails depending on
which worker happened to pop it.

Routing is a repair, not a licence to diverge. It can only send work to a host that is beating and has
declared a queue of its own, and when nobody declares the profile the job still refuses
`secret-profile-unknown`, which is returned and never retried. Declaring the same profiles and roots on
every host remains the right shape: it needs no routing at all, and it lets any host take the work.

A trigger that binds `run.secrets` without naming a profile uses the profile called `default`, and it is
routed the same way, to a host that has one. A host offers the profiles it would actually use: every one in
`PI_SECRET_PROFILES`, and each one declared through the panel whose resolver is an executable file inside
`PI_SECRET_RESOLVER_ROOTS`. A panel edit reaches the routing within one heartbeat, about 15 seconds. A host
where one name is declared in both places offers no profile at all, because it refuses every job that binds
secrets until one of the two is removed, and `pi-dispatch doctor` names that name.

When you upgrade a deployment that runs on several machines, upgrade every worker before the receiver and the
console. An older worker does not offer a profile declared through the panel, so a newer receiver can stop
routing a job that binds `run.secrets` without naming a profile and also waits on a `run.waitFor` profile to the
one host that serves both, and the job can land on a host that refuses it.

A project secret bundle (Recipe D) is **not** routed: which project a job belongs to is decided on the worker,
from its `projects.json`, and the receiver reads no `projects.json`. Declare every bundle profile, and keep the same
`triggers.json`, on every host that takes the project's jobs. On a multi-host worker a job from the shared queue that
this host cannot serve is handed back and tried again a minute later, so a host that declares the profile can take
it; a single host, or a job on a host's own queue, refuses it as `secret-bundle-profile-unknown` before it spends.
`pi-dispatch doctor` on such a host fails until it declares the profile. One gap remains: a host that declares no
bundle profile AND has no triggers file applies no bundle at all, so a bundled project's job that lands there runs
without its environment. Doctor warns about that shape on a fleet worker with projects.

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
| launchd (macOS), nssm (Windows) | `deploy/worker-env-wrapper.sh`, which SOURCES `./.env`, and `.cmd`, which reads it line by line (`for /f`, splitting on the first `=`) |
| `docker compose --profile receiver` | `env_file: ../.env` |
| a terminal | you |

Put your manager in that slot instead and the worker cannot tell the difference. Two surfaces already
assume you might, which is the closest this project came to documenting it before this page existed:

- `pi-dispatch doctor` reports `.env present` as a **warning**, never a failure, because *"env may be
  supplied by a service manager instead of a file"*.
- `pi-dispatch up` says `no .env here — skipped (set it wherever your env lives)` rather than writing
  one.

**Two readers exist, and it is worth knowing exactly how narrow the first is**, because the sentence
above is the kind that quietly stops being true. `pi-dispatch doctor` reads the `.env` in its own working
directory for **five keys**, `PI_PAUSE_WINDOWS_FILE`, `PI_SCOPED_LIMITS_FILE`, `PI_PROJECTS_FILE`,
`PI_MODEL_ENDPOINTS_FILE` and `PI_ENVELOPE_FILE`. The reason for the first three is that `pi-dispatch up` writes them
there. The fourth names the model endpoints file and the fifth the allocation envelope, and doctor loads the file the
service would read. Writing a line into `.env` configures the **service**, through the
slots in the table above, and configures nothing about a shell you later type `pi-dispatch doctor` into.
Without the read, doctor would warn that those features are off at exactly the deployments that had
just been set up correctly.

The narrowing is the whole of the licence, and each half is load-bearing:

- it reads to decide **what doctor says, and whether doctor fails**, never to configure anything. No value
  read this way reaches a config, an argv, a container environment, or any fix that writes. Since issue #384
  a value does reach one read-only thing: the worker's own loader, opened behind a regular-file guard, to
  answer whether a service started from this folder would start at all;
- it reads only the keys the message itself names, so it cannot grow into "load `.env`";
- a file nobody could open is reported as exactly that, rather than as a key that is unset, because a
  deployment told it is fine when nobody could check is the worse failure. The same holds for a file this
  reader cannot finish: a line your service manager's loader would RUN, or that reaches into the line below
  it, takes the claim off the whole file for that loader, and doctor names the line instead of guessing past
  it. Which lines those are depends on the loader, and systemd refuses far less than a sourcing shell does;
- **doctor is not the worker**. The sentence at the top of this page is about the process that runs jobs,
  and it is still exactly true: `loadConfig` reads the environment, there is still no dotenv dependency,
  and `PI_ENV_SETUP` inside a `./.env` is still deliberately **not** honoured, which the test suite pins.

**A second reader judges the service's own settings** (issues #453, #464 and #471). The service reads every
setting from this file, so a doctor that took them from its own shell judged a deployment that was not running.
doctor now resolves every service key it judges ONCE, by one rule it shares with the `/dispatch` panel
(`worker/src/service-env.mjs`):

- this shell's value where it sets one, because a worker started by hand from this shell runs with it;
- else the `.env`'s, from a line the service's loader reads exactly as written, and said: a `✓ service settings
  read from <path>` line names each key the file supplied (names, never values);
- a key both set differently is a **✗** naming both values, and doctor then judges this shell's. A credential
  (a token, a webhook secret, the App key, a provider key, the PAT) is named without either value, and a URL is
  printed without its credentials. doctor cannot tell which of the two runs, so it fails until they agree;
- a line the loaders read differently (a `$`, a quote, a space) is named with its line number and its value is
  never used.

Some of these values steer what doctor starts or connects to, and each is judged first, the way the worker
judges it: `PI_JOB_IMAGE` by the worker's own default and its `run.image` refusals (a blank, padded or
dash-leading value is named and never handed to docker), `VALKEY_URL` by the owner rule, and a session store
named only in `.env` is offered by `doctor --fix` at the prompt tier instead of created silently. A relative
`PI_TRIGGERS_FILE` is the deployment folder's, as the worker reads it. `PI_ENV_SETUP`, `XDG_DATA_HOME` and
`DOCKER_CONTENT_TRUST` stay this shell's on purpose. The panel reads the same way, from the pointer's deployment
folder only, never from a `.env` in the folder pi was started in (a repository can ship one), and says a
disagreement once as a warning.

**Nothing from `.env` reaches a program doctor starts.** Its podman, docker, gh and every other child run with
the environment of the shell you started doctor in, exactly as before this reader existed. The service's own
CLIs do read their variables from `.env` (`CONTAINERS_CONF` and its siblings, `CONTAINER_HOST`, `DOCKER_HOST`,
`DOCKER_CONFIG`, `GH_CONFIG_DIR`, the gh token and the rest), so for each one the file sets doctor prints a ⚠
naming it (its value only when it is a path): its probes through that CLI describe your shell's view, not the
service's. Where the service's setting decides something doctor judges by READING files, doctor uses the file's
value, in-process: the containers.conf chain check reads the chain `CONTAINERS_CONF`, `CONTAINERS_CONF_OVERRIDE`,
`XDG_CONFIG_HOME` and (for rootful Podman) `HOME` select, as the worker does, and fails on a chain the worker would
refuse. Reading a file runs
no code. A PAT, or the `GITHUB_PAT_VAR` naming it, that only the file holds means the in-image `gh` probe is not
run, and that is said. This is the simple rule the PR settled on after three rounds of rules for handing such
values on safely each had a hole (a link flipped between check and use, a missing path another account created
in time under `/tmp`, a socket held back that should not have been): a program that never sees them has none.

**From a `.env` another account can change, nothing is taken at all.** The file is opened once and judged by that
open file: it must belong to you or root and be writable by nobody else, and its folder, its real folder and
every directory above them likewise (a root-owned sticky directory such as `/tmp` is the one exception, since
there only an entry's owner can move it). Otherwise doctor fails naming the file or directory, its owner, mode
and, for a group-writable one, its group (said as your own group when it has your name, which a umask 002 login
makes: doctor still trusts only a file no group can write), and judges this shell's values alone; the panel says
the same, with the owner's name, and reads none of it. Where a service unit is installed for the folder, doctor
names the service keys only its own shell sets, since the service runs without them.

**What remains is by design: a deployment folder is trusted exactly as far as the service trusts it.** The job
image your own `.env` names is the image doctor's egress canary and in-image probes run, in containers built
with the same pinned flags a job gets, as the service runs it; doctor checks the name against the worker's image
rule first and hands the runtime nothing else from the file.

An overlay MCP server's credentials ([`docs/mcp.md`](mcp.md)) are never in the overlay: each is a `${NAME}`
reference that a trigger maps with `run.secrets` (or that `PI_FORWARD_ENV` forwards), resolved inside the job.
A reference to a credential the job itself spends with, or to the forge token, is refused before the job starts.

## What actually holds a secret

Everything else in `.env.example` is a dial, and dials are fine in plain sight.

| | |
|---|---|
| The provider key | `ANTHROPIC_API_KEY` or your provider's own variable, per pi's table |
| The forge credential | `GITHUB_PAT`, or the App trio (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`), or `GITLAB_TOKEN` / `FORGEJO_TOKEN` / `AZURE_TOKEN`. `GITHUB_PAT_VAR` renames the first of those, for a manager that insists on its own key name |
| The webhook secrets | `WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SECRET`, `FORGEJO_WEBHOOK_SECRET`, `AZURE_WEBHOOK_SECRET` |
| `VALKEY_PASSWORD` | the password of the Valkey pi-dispatch starts (issue #468); `init` writes it, `up` and `service install` add it when missing |
| `VALKEY_URL` | only when it carries a password |

The receiver is its own process with its own unit, and it needs the webhook secret, `VALKEY_URL` and
`VALKEY_PASSWORD` the same way. Everything on this page applies to it unchanged.

`VALKEY_PASSWORD` is a key of its own, never folded into `VALKEY_URL`: doctor prints that URL, the admin's
deployment pointer stores it, and refusals quote it, so a password inside it would travel to all three. A
manager-supplied environment works as for every other key here (the service's clients read it from their
environment first); the file's own copy is read only for a Valkey on this machine's loopback, so a shell whose
`VALKEY_URL` names another host never sends it there. The Valkey itself never receives it on a command line:
see [podman.md](podman.md), step 7, for why and how.

Two notes on names, because both are variables an operator can hold wrongly for a long time. `GITHUB_PAT_VAR`
says which variable the PAT actually lives in (default `GITHUB_PAT`); the name you give is read verbatim and
checked against nothing, so pointing it at a variable holding something else, `GITHUB_APP_PRIVATE_KEY` being
the one worth naming, would send that value to GitHub as if it were a token. And `GITLAB_AUTH_SOURCE`,
`FORGEJO_AUTH_SOURCE` and `AZURE_AUTH_SOURCE` accept exactly one value, `pat`, which is also their default.
They are not unfinished: GitHub has three auth sources and these forges have one each, so the variables exist
so that an operator reasoning by symmetry gets a refusal naming the reason rather than a setting that does
nothing. The refusal is conditional on the forge's own token being set, because the whole block is skipped
when it is not, so `GITLAB_AUTH_SOURCE=app` with no `GITLAB_TOKEN` is the one case where the variable really
is ignored.

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

### Six things worth knowing before you wire one

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
4. **You cannot bind your provider's own credential variable.** The worker writes the provider key into
   the container before it writes your secrets, so a trigger naming
   `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY` for `google`, or whichever variable pi reads for the provider
   the job runs on) would replace the operator's credential with the trigger's, on every job of that
   trigger. It is refused before anything spends, as `secret-name-reserved`, and the refusal names the
   variable. This covers every variable pi reads for that provider whether or not it is set on the host. For
   `anthropic`, the only provider at the pinned pi with more than one, that includes
   `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN`, which pi reads before the API key. The names on your
   `PI_FORWARD_ENV` list are
   reserved the same way, for the same reason. Another provider's *key* variable is fine: an `anthropic` job
   may bind `OPENAI_API_KEY` for a flow that talks to OpenAI itself.
5. **You cannot bind a variable that steers a provider either, whichever provider it belongs to.** The
   refusal above is about whose key pays; this one is about where the request goes. A trigger binding
   `AZURE_OPENAI_BASE_URL` sends the job's provider request to a host of its choosing **with your
   `AZURE_OPENAI_API_KEY` attached**, and `AZURE_OPENAI_RESOURCE_NAME` does the same thing by a different
   route. `AWS_CONTAINER_CREDENTIALS_FULL_URI` makes the AWS SDK fetch credentials from a URL the trigger
   picked, `GOOGLE_APPLICATION_CREDENTIALS` and `AWS_WEB_IDENTITY_TOKEN_FILE` point at credential files,
   and `AWS_BEDROCK_SKIP_AUTH` turns authentication off. These are refused **at load**, so the whole file
   is rejected and `doctor` says so, rather than per delivery.
   `ANTHROPIC_CUSTOM_HEADERS` and `OPENAI_CUSTOM_HEADERS` are refused too: a line in either naming the
   credential header replaces your key with the trigger's (measured at pi 0.99.1).
   `ANTHROPIC_AUTH_TOKEN` stays refused for every trigger, whichever provider the job runs on. So do the
   five variables pi reads for Anthropic workload identity federation when no key is set
   (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`,
   `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`): the organization and workspace decide who pays.
   A job cannot use federation; it gets an API key.
   The list is not maintained by hand: it is extracted from the pinned pi and from every package pi builds
   a client with, and a test compares the two in both directions, so an upgrade that starts reading a new
   variable fails the build. The scan also reads those packages' own dependencies, one level down. That
   adds the Google auth library's names (`GOOGLE_CLOUD_QUOTA_PROJECT`, `CLOUDSDK_CONFIG`, and the
   lowercase `google_application_credentials`, `gcloud_project` and `google_cloud_project`, which it reads
   beside the uppercase ones), the AWS SDK's (`AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, the EC2
   metadata settings, `AWS_USE_FIPS_ENDPOINT`, `AWS_MAX_ATTEMPTS` and the other client settings), the
   Google GenAI SDK's `GOOGLE_GENAI_ACCESS_TOKEN`, pi's Cloudflare `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_GATEWAY_ID`, and a few from small helpers such as `DEBUG`. Names are matched exactly: only a
   lowercase spelling that some pinned package reads is refused.
   pi's own settings are refused too: every `PI_*` variable pi reads, such as `PI_CODING_AGENT_DIR`
   (another agent folder, with another `auth.json`), except the ones pi-dispatch sets itself.
   Four names cannot be extracted, because the code builds the key at runtime
   (`AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, `http_proxy`, `https_proxy` and `ALL_PROXY`); those are listed by
   hand and a test checks they are still unfindable.
   A job that was queued before a name joined this list (or sent by an older receiver) is refused before
   it starts, as `secret-name-reserved`, and the refusal names the variable.
   This list does **not** include another provider's API key. Binding `OPENAI_API_KEY` on an Anthropic
   deployment is still fine, exactly as item 4 says: that is the previous rule and it is unchanged.
   **What it will cost you is carrying AWS or Google cloud credentials on a trigger for a step that has
   nothing to do with your model provider**, such as an S3 push or a `gcloud` call. `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY` and `GOOGLE_APPLICATION_CREDENTIALS` are read by the provider SDKs as provider
   configuration, so they are refused on every deployment now, including one that uses neither Bedrock nor
   Vertex. The set also covers names that are harmless in themselves, such as `AWS_REGION`, `OPENAI_LOG`
   and `DEBUG`.
   Put what you need on `PI_FORWARD_ENV` instead: nothing there refuses these names. It is not a
   like-for-like replacement, and the difference is the point of the refusal, `PI_FORWARD_ENV` is one host
   value for the whole deployment and it is the operator's list rather than the trigger author's.
6. **All three packages must be new enough to carry the field, and they move together.** `run.secrets`
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
belt-and-braces: `PI_SETTINGS_FILE` can put the file the panel writes anywhere, so a check that lived only
in the panel would prove nothing on a shared host.

Before it asks you to confirm, `add` (and the console's form) refuses two things the worker would refuse later: a
name `PI_SECRET_PROFILES` already declares on this deployment (the worker reads a name declared in both places as
ambiguous and then refuses every secrets job), and, when the panel can see `PI_SECRET_RESOLVER_ROOTS` (it reads it
from the deployment's `.env`), a resolver whose real path (symlinks followed) is outside it as written. The roots are compared as you wrote them, as the worker compares them, so on macOS a root written `/tmp/pi` holds nothing under `/private/tmp/pi`; the refusal then says to write the root as its real path. The panel judges this on its own host, which may not be the worker's: a path it cannot resolve there is not refused, and the confirm says the worker checks it where it runs. Set and empty, the
variable refuses every overlay resolver, so `add` says that too. `/dispatch secrets list` and the console's
configuration screen list the profiles `PI_SECRET_PROFILES` declares beside the overlay's, and mark a name in both
as ambiguous.

**Binding a secret to a trigger stays a file edit.** The panel declares managers; `triggers.json` says which
job reaches one. No `dispatch_*` tool has a `secrets` parameter.

**Bundle resolvers** ([Recipe D](#recipe-d-one-environment-for-a-whole-project)) take the same door with
`--bundle`. `/dispatch secrets add --bundle` asks three questions (a name, the path to the script, and the format it
prints, `dotenv` or `json`) and shows you the exact bytes it writes to the overlay's `secretBundles`
(`{ "<name>": { "path": "...", "format": "..." } }`). It refuses a name `PI_SECRET_BUNDLES` already declares on this
deployment: the worker reads a name declared in both places as ambiguous and then refuses every bundled job. It
refuses a resolver outside a visible `PI_SECRET_RESOLVER_ROOTS` too, as `add` does for a profile.
`/dispatch secrets remove --bundle <name>` says what the removal does: nothing when no bundle in `triggers.json` names
it; it resolves the ambiguity when `PI_SECRET_BUNDLES` declares the same name (unless another name is in both places, which keeps every bundled job refused, and it says so); otherwise it names the bundles whose
jobs are refused before they spend once it is gone (or, on a multi-host worker's shared queue, held for a host that
declares it). Any flag but `--bundle` (`--bundles`, `-b`) is refused with the usage line. The console's configuration screen has the same two forms. As
for profiles, there is no model-callable tool for either, and `dispatch_set` refuses the key.

**What the panel and the console show.** Nothing is resolved to draw any of it (`pi-dispatch doctor --secrets` does
that, on the host that runs the jobs), and no reference or value is ever shown:

- `/dispatch secrets list` prints the resolver profiles, the bundle resolvers, and each bundle `triggers.json` binds:
  its project (and whether `projects.json` has it), its profile and whether this deployment declares it (in
  `PI_SECRET_BUNDLES`, in the overlay, in both, which is ambiguous, or not at all). An overlay resolver whose path is
  outside `PI_SECRET_RESOLVER_ROOTS` is shown as one the worker will not run; one inside is shown with
  "doctor --secrets checks it runs", because only the worker's host can follow the real path. When the panel cannot
  see `PI_SECRET_RESOLVER_ROOTS` (it reads it from the deployment's `.env`), it says the roots are not visible rather
  than calling the resolver outside them. When the panel
  cannot see `PI_SECRET_BUNDLES` at all (no deployment pointer, or no such line), it says so rather than "missing".
  Then whether fork reviews get it, its `endpoints` (names and hosts) and the triggers that opt out (a cron trigger
  counts only when its folder is in the bundle's project). `/dispatch triggers` adds the same lines under the
  triggers.
- A trigger's detail in the `/dispatch` panel says where its `run.secrets` values end up, by its venue (its
  `run.backend`, else the first venue in `PI_BACKENDS`): on `local` and `podman` the agent can read them; on the
  OpenShell venues the values with an endpoint are placeholders in the agent and `run.secrets` go to the job's provider.
- The `/dispatch` panel has a **secret bundles** section under the triggers with the same facts and the variable
  names the newest run in view received. A cron trigger whose folder is in a bundled project carries `[bundle <id>]`
  beside `[secrets]`, and a trigger that opts out carries `[no bundle]`; its detail says which bundle its jobs hold.
- The console's configuration screen has a **Secret bundles** panel with the same facts, and its trigger table
  names the bundle (or the opt-out) in the notes.
- A run's detail, in the panel and on the console's run page, says "Variables received: A, B, C (from bundle
  shop)", the names the trigger's own `run.secrets` shadowed, and on an OpenShell venue how many were placeholders
  and how many values; or, for a run that went without its project's bundle, why, in a sentence.
- A project edit the project tools refuse because a bundle names the project shows that sentence in the console's
  project form and in the tool's answer in the panel.
- **No model-callable tool sees a variable name.** `dispatch_runs` returns a record's `bundle` as counts
  (`{ id, received, shadowed, placeholders, plain }`), and `dispatch_status` leaves out `secretProfiles` and
  `secretBundles`. The names stay in your own views above.

## Recipe D: one environment for a whole project

Recipe C grants one field to one trigger, and that is the point of it. When a project simply has an
environment (an API key, a database URL, a feature flag or two) and every job of the project should get it,
naming each field on each trigger turns every new variable into an edit of every trigger. A **secret bundle**
grants the project's environment **once**:

```jsonc
// triggers.json, top level, beside "triggers"
{ "triggers": [ … ],
  "secretBundles": {
    "shop": { "profile": "shop-env", "ref": "shop", "project": "shop" }
  } }
```

`project` is an id from `projects.json` ([projects](projects.md)). Every job whose project is `shop` gets the
bundle, whichever trigger made it: a new trigger or a new repository in the project needs no secrets edit. You
declare the bundle resolver once, with the **format** it prints (or from the panel, [above](#from-the-panel)):

```sh
# /etc/pi-dispatch/pi-dispatch.env
PI_SECRET_BUNDLES=shop-env:/etc/pi-dispatch/resolvers/shop-env.sh:dotenv
```

The worker runs it **once per job start**, on the host, before the container starts, with the bundle's `ref`
as its only argument. It prints the whole environment on stdout, and its exit code means what Recipe C's does:
0 for the environment, 2 for a wrong reference (refused, never retried), anything else for a manager it could
not reach (retried). A variable you add, change or remove at the source reaches the **next** job of the project
with no edit to `triggers.json`, no panel step and no restart.

### The two formats, declared, never guessed

- `dotenv`: strict `NAME=value` lines, the value verbatim to the end of the line. Blank lines and `#` comment
  lines are allowed. Nothing else is: no quotes, no `export `, no spaces around `=`, no `$VAR` expansion, no
  multi-line values. A quoted value is refused (`quoted`) rather than handed to the job with its quotes.
- `json`: one object whose every value is a non-empty string. Use it for PEMs and anything else with a
  newline, a leading quote or a `\r` in it.

**Names a bundle may not carry.** Every name `run.secrets` may not bind (docs above), and also, because a bundle's
contents are not reviewed, the names that change what code runs in the job or how it trusts the network. Each
refuses the job as `secret-name-reserved`, the worker's log naming it; a trigger that genuinely needs one binds it
in its own reviewed `run.secrets`. `NODE_OPTIONS` also carries the job image runner's child-meter preload, and
`npm_config_*` is matched in any case, as npm reads it. A test holds this list to the worker's table:

<!-- bundle-loader-names:start -->
`PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
`GIT_EXEC_PATH`, `GIT_PROXY_COMMAND`, `GIT_TEMPLATE_DIR`, `GIT_SSL_NO_VERIFY`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`,
`GIT_CONFIG*`, `SSH_ASKPASS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`,
`PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `npm_config_*`
<!-- bundle-loader-names:end -->

Either way: at most **64 variables**, at most **256 KiB** of output in all, each value at most 64 KiB, every name
an environment variable name, no name twice, no empty value. Anything else refuses the job before it spends,
and the refusal says which rule (and the worker's log names the variable or the dotenv line, never a value).

### Worked examples

A plain file, no manager at all (`:dotenv`):

```sh
#!/bin/sh
# /etc/pi-dispatch/resolvers/shop-env.sh. Owned by the worker's account, writable by nobody else.
[ -e "/etc/pi-dispatch/bundles/$1.env" ] || exit 2
exec cat "/etc/pi-dispatch/bundles/$1.env"
```

Doppler (`:json`, because an `env` format that quotes its values is refused by the strict `dotenv` grammar, and JSON needs no quoting rules at all):

```sh
exec doppler secrets download --project "$1" --config prd --format json --no-file
```

#### 1Password: a read-only, Environment-scoped service account

A service account reads an Environment with no prompt, which is what an unattended service needs. Once per
project:

1. Turn on the Environments policy in the 1Password admin console (Owner or Administrator).
2. In the desktop app, create the project's Environment (Developer, View Environments, New environment) and add
   its variables, or import the existing `.env`. Copy the Environment's ID.
3. On 1Password.com, create a service account with **read access to that Environment only**. Its access is
   fixed at creation, so one service account per project keeps projects apart, and widening one means a new
   account.
4. Store its token on each worker host in a file the worker's account can read and no job can see, for example
   `/etc/pi-dispatch/op/<project>.token` with mode `0400`. Never in `.env`, `PI_FORWARD_ENV` or the overlay.
5. Declare the resolver below as a bundle profile (`:json`) and bind it with the Environment's ID as `ref`.

The resolver uses the SDK's `getVariables`. Install `@1password/sdk` beside it at an **exact** version, never a
range, the rule this project keeps for every dependency it runs:

```js
#!/usr/bin/env node
// /etc/pi-dispatch/resolvers/op-<project>.mjs <environment id>
// One script, and one bundle profile, per project: each project has its own service account.
// Beside it: package.json with "@1password/sdk": "<exact version>", installed with `npm ci`.
import { readFileSync } from "node:fs";
import { createClient } from "@1password/sdk";
let client;
try {
	const auth = readFileSync("/etc/pi-dispatch/op/<project>.token", "utf8").trim();
	client = await createClient({ auth, integrationName: "pi-dispatch", integrationVersion: "1" });
} catch {
	process.exit(1); // could not reach the manager: retried
}
let vars;
try {
	vars = await client.environments.getVariables(process.argv[2]);
} catch (err) {
	// Exit 2 ONLY for an error you have confirmed means "no such Environment, or no access to it": refused, never
	// retried. Everything else (a rate limit, a network fault, an outage, an error you do not recognise) exits 1 and
	// is retried. <wrong-reference test> is a placeholder: check on your own account what the SDK raises for a wrong
	// Environment ID and for a rate limit, and match the first one alone.
	process.exit(<wrong-reference test> ? 2 : 1);
}
process.stdout.write(JSON.stringify(Object.fromEntries(vars.map((v) => [v.name, v.value]))));
```

`op environment read` prints `NAME=value` lines and would fit `:dotenv`, but it is still a beta command; the
SDK's call is the stable one. A rate-limited read must exit 1 so it retries rather than refusing, which is why the
recipe exits 2 for one recognised error only. This project ran no lab against 1Password: how its SDK reports a wrong
reference apart from an outage is for you to check on your account before you rely on it.

**One resolver call per job start**, never one per variable, and that is what a manager's rate limit counts.
`pi-dispatch doctor` states it whenever a bundle profile is declared. Size the limit for your busiest hour of job
starts across every bundled project.

**1Password's own OpenShell provider integration is declined for this.** It is created in the desktop app with a
human approval per connection, and its access expires after a TTL, after which the placeholders stop resolving
until someone approves again. The local `.env` named pipe and the CLI's desktop-app sign-in are interactive in
the same way. None of those suits a service that starts jobs at 3 a.m. Whether a later OpenShell-side route
(an operator-owned provider, or the gateway's credential driver) can serve unattended jobs is an open question,
recorded with what it would need (`OQ-048` in `specs/open-questions.md`); the resolver seam above already covers the
service-account route, and on an OpenShell venue its values can still be placeholders (below).

### Who gets the bundle, and who does not

- **Every trigger-made job of the project**: its cron jobs (and `pi-dispatch run --trigger`, which fires a cron
  trigger as its schedule would) and its forge jobs, including a console re-run of a trigger's run.
- **Not a chained `/outbox` child, and not a manual run** (`pi-dispatch run <folder>`, `/dispatch run`,
  `dispatch_run`). Your grant was to the triggers you reviewed, not to what a job queues next or what a model
  asks for. The run record says `bundleSkipped: "chained"` or `"manual"`.
- **Not a trigger that opts out** with `"run": { "secretBundle": false }` (`bundleSkipped: "opted-out"`). The
  worker reads that flag from its own triggers file, so no receiver needs to carry it.
- **Not a stranger's pull request.** A job on a pull request whose head is in another repository runs WITHOUT
  the bundle (`bundleSkipped: "fork"`), decided by asking the forge, never the webhook payload. A bundle opts in
  with `"forkReviews": true`; think hard first, because that job reads text a stranger wrote while it holds
  every variable of the project.
  If the forge answers 401, 403 or 404 when asked for the head, the job is treated the same way
  (`bundleSkipped: "head-unverified"`); any other failure retries.
- **Not a `run.resume` trigger.** A job of such a trigger is refused (`secret-bundle-resume`), for the reason
  `run.secrets` cannot sit beside `run.resume`; opt the trigger out instead.
- **Not a trigger a tool wrote.** `dispatch_trigger_add` always writes `"secretBundle": false` on the entry it adds,
  because its task or flow is the model's choice, and no tool can remove the flag or set it. When you mean that
  trigger's jobs to hold the bundle, delete the line by hand in `triggers.json`. For the same reason the project tools
  refuse to change the members of a project a bundle names (or to create one under a bundled id): change the bundle
  first, or edit `projects.json` by hand.

A trigger's own `run.secrets` **win** over a bundle variable of the same name, and the run record names the
shadowed variables. The record also lists, by name, every variable a job received from its bundle
(`bundle: { id, variables, shadowed }`), never a value: since a grant now changes outside review, each run says
exactly what it held.

### On an OpenShell venue: placeholders for the variables you bind to a host

On `openshell` and `openshell-bind` ([backends](backends.md)) the job's own credentials are already placeholders the
gateway swaps for the real value at the hosts the job may reach. A bundle can put its variables on that path too, one
host per variable, with `endpoints`:

```jsonc
"secretBundles": {
  "shop": {
    "profile": "shop-env", "ref": "shop", "project": "shop",
    "endpoints": {
      "STRIPE_KEY":  { "host": "api.stripe.com", "auth": "bearer" },
      "SENTRY_AUTH": { "host": "sentry.io",      "auth": "header:X-Sentry-Token" }
    }
  }
}
```

What the agent sees:

- **A variable `endpoints` names is a placeholder** (`openshell:resolve:env:...`) in the job's environment and in
  `/proc/self/environ`. The gateway swaps in the real value only in an HTTP request to that host (a header, after
  `Bearer `, inside Basic auth, in the path or the query); sent anywhere else it is refused with a 403
  (`credential_endpoint_mismatch`), never forwarded. The worker gives each host its own per-job provider, created
  and deleted with the job's sandbox and swept after a crash.
- **Every other bundle variable is its value**, as on `local` and `podman`. That is the right place for a value the
  agent must use itself (an HMAC key, a PEM, a database URL): a placeholder only works in an HTTP request. A multi-line
  value works. The worker hands these values to the job in a file in the job's own directory (`bundle-env.json`, mode
  0600, removed when the job ends, or, if the worker crashes mid-job, when the next start's salvage or orphan sweep
  removes the job directory), which the job image's runner reads into the agent's environment; they are on no
  command line on this host and not in the OpenShell gateway's log (it logs the start of every exec command, which is
  why the values do not travel there). The job image must declare `bundleEnvFile` ([job-image](job-image.md)); on an
  older image such a job is refused before it spends (`openshell-bundle-image-too-old`).
- **`auth`** says how the value is sent (`bearer`, `basic`, or `header:<Name>`) and is recorded in the gateway's
  provider profile. At OpenShell 0.1.4 it does not change where the swap happens: the agent's own request must carry
  the placeholder where the service expects the key.
- The run record also counts them: `bundle.placeholders` and `bundle.plain`.

What refuses the job, before the sandbox exists and before it spends (the worker's log names the variable and the
host, the comment names neither):

- `openshell-bundle-endpoint-not-allowed`: the host is not exactly a host the job may already reach (an
  `egress-allowlist.conf` line, a `model-endpoints.json` entry, the forge's own). A bundle never widens egress. A host
  admitted only by a wildcard line (`.example.com`) does not count: add the host on a line of its own.
- `openshell-bundle-endpoint-shared`: the host is one the job's own credentials are sent to: the forge's
  (`github.com`, `api.github.com`, `uploads.github.com`, `gitlab.com`, `dev.azure.com`, or your instance's), the model
  provider's (`api.anthropic.com` and the like, for every model the job may call), any `model-endpoints.json` host, or
  an HTTP MCP server the job names. OpenShell binds one provider per host, so the bundle would take the host from them.
- `openshell-bundle-endpoint-unknown`: `endpoints` names a variable the resolver did not print. A typo would otherwise
  hand the real variable to the agent as a value while the file reads as holding it as a placeholder.
- `openshell-bundle-name-taken`: a bundle variable is named like one the sandbox sets itself (`OPENSHELL_*`, its CA
  variables such as `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, the proxy variables, `HOME`, `USER`, `SHELL`, `TERM`,
  `LOGNAME`, `GIT_CONFIG_*`), or under `PI_`, which is pi-dispatch's own.
- `openshell-bundle-unpassable`: what OpenShell 0.1.4 cannot carry as a placeholder: a value in `endpoints` over
  8 KiB, more than 32 `endpoints` variables for one host, or more than 31 hosts.
- `openshell-bundle-image-too-old`: the bundle has variables outside `endpoints` and the job image does not declare
  `bundleEnvFile`. Rebuild the image from a release that does.

One thing to know: **a host in `endpoints` is the bundle's alone for that job.** A forwarded secret or another
`run.secrets` value sent to that host gets the 403 above (the hosts the worker knows the job's own credentials use are
refused up front). A trigger's `run.secrets` value for a name the bundle's `endpoints` declare wins as usual, and is
held as that host's placeholder. Two cases the worker cannot see before the job runs, both refused loudly by
OpenShell (a 403, nothing forwarded): an agent that switches to another model defined in the overlay's `models.json`
whose `baseUrl` is a bundle host, on a trigger with no allowed-model list (set `run.models` or `PI_ALLOWED_MODELS` to
close it), and a stdio MCP server's own HTTP calls to a bundle host carrying a secret.

`endpoints` means nothing on `local` and `podman`: every variable goes in as its value there, and a name `endpoints`
lists that the bundle lacks is not refused.

### The traps of a bundle

1. **The blast radius is the whole bundle.** A prompt injection in an issue or a pull request can exfiltrate
   every variable of the project through the forge, which is always reachable. Redaction bounds an accident;
   it is not a boundary. Keep bundles small and per project, and keep a deploy key that only one trigger should
   hold in that trigger's `run.secrets` instead.
2. **The grant now changes outside review.** A variable added in your manager reaches the next job. The review
   of what a project may hold moves to whoever can write the manager (or the file): give that the care you give
   `triggers.json`.
3. **Fork reviews are off by default**, and `forkReviews: true` turns them on for the whole bundle.
4. **More values in the host argv.** On `local` and `podman` every variable goes into `docker run` / `podman
   run` as `-e NAME=VALUE`, so a bundle widens `OQ-028` by its count: a process on the host that can read
   another's command line sees them while the container starts. On an OpenShell venue none is on a command line: the
   ones `endpoints` names are placeholders, and the rest travel in a file in the job's directory.
5. **A project with folders.** A local job's `/workspace` is your own folder, so a value the agent writes to a
   `.env` there lands in your real repository. `doctor` warns per bundle whose project holds a folder.
6. **Declare the profile on every host that takes the project's jobs.** A bundle profile is a path on one
   machine, and routing does not yet steer a job to a host that declares it. On a multi-host worker a job from the
   shared queue that this host cannot serve is handed back and tried again a minute later, so a host that declares
   the profile can take it; a single host, or a job on a host's own queue, refuses it as
   `secret-bundle-profile-unknown`. Every host also reads which project holds a bundle from its own triggers file
   (`PI_TRIGGERS_FILE`), so keep the same `triggers.json` on every host. While the file does not validate, the
   worker keeps using the last version that did, and a worker that has never read a valid one since it started
   retries a project's jobs until it can. A MISSING file is the same failure on a host that declares a bundle
   profile; on a host that declares none it means no bundles, which is the one way a bundled job can run without
   its environment (doctor warns on a fleet worker with projects and no triggers file).
7. **An MCP server cannot take a bundle variable.** A trigger's MCP servers reference names from its own
   `run.secrets` or `PI_FORWARD_ENV`, and the MCP check runs before the bundle is read, so a server naming a bundle
   variable is refused as `mcp-secret-unmapped`. Bind that one value in the trigger's `run.secrets` instead.
8. **Short values are not redacted.** Redaction of the job's output skips values shorter than 8 characters, as it
   does for every secret: a short value the agent prints stays in the transcript.

`pi-dispatch doctor` lists every bundle with its profile, format and project, fails on a profile this host does
not declare or a project `projects.json` does not hold, and `pi-dispatch doctor --secrets` resolves each bundle
on this host and prints its variable names and their count, never a value.

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
✓ Provider key set (anthropic: ANTHROPIC_API_KEY)
```

That is `pi-dispatch doctor` under Recipe A with no `.env` anywhere on the host. The warning is advisory
by design, the provider key resolved from the injected environment, and every other check behaved
normally. The line names the variable pi will actually read, and only that one: doctor asks pi which
variables the provider uses rather than keeping a list of its own, so it cannot bless a variable pi does
not read (issue #286). If the value it finds is an `ANTHROPIC_OAUTH_TOKEN`, the line is a warning
instead, because a subscription login cannot power an unattended service. An `ANTHROPIC_AUTH_TOKEN` is a
warning too: pi sends it as a bearer token and reads it before `ANTHROPIC_API_KEY`, so while it is set
the API key is ignored, and the line says so. If you also have a `pi login` API key, the line says that
key is not used while the token is set: the worker reads the environment first, while pi on your host
would use the stored key. And a subscription token pasted into `ANTHROPIC_API_KEY` (it starts
`sk-ant-oat`) is a warning too, because pi sends it as a subscription login whatever variable holds it.
Run `doctor` through your
manager once, exactly the way the unit will, before you enable the service.

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
