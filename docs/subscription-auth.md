# Subscription authentication and quota

An explicit subscription connection lets the worker use OpenAI ChatGPT authentication or a supported Claude
community OAuth extension. The owning host handles login and renewal. Jobs receive only a short-lived access
credential that remains valid beyond their deadline; refresh grants stay in a private host store. A job's deadline is
30 minutes ahead, and the host moves it on while the job runs, for the same connection only
([job limits](job-limits.md#credentials-that-expire-while-a-job-runs)).

This is opt-in. Without a provider binding, existing environment/API-key behavior stays the same. A binding
continues to own its provider when disconnected or exhausted: it never silently spends an API key, selects
another account or changes the billing route.

## Configure a connection

Create an owned connection-policy file that is not group or other writable, and name it in the worker's
environment:

```sh
PI_AUTH_CONNECTIONS_FILE=/absolute/deployment/auth-connections.json
# Optional. The default is subscription-auth beside PI_SETTINGS_FILE.
PI_AUTH_STORE_DIR=/absolute/private/subscription-auth
```

For OpenAI:

```json
{
  "version": 1,
  "connections": [
    {
      "id": "chatgpt-main",
      "provider": "openai",
      "adapter": "openai-chatgpt",
      "ownerHost": "worker-one",
      "quotaWindows": ["five-hour", "seven-day"]
    }
  ],
  "bindings": { "openai": "chatgpt-main" }
}
```

`ownerHost` is the worker's configured name. There is one active binding per provider. This implementation
supports the direct OpenAI Responses route at `https://api.openai.com/v1`, using the pinned pi 1.4.0
authentication flow. It does not silently substitute legacy `openai-codex`, classifiers or a custom proxy.

One attempt's ordinary model routes, including its root, fallback and internal decision roles, cannot mix
subscription-bound and unbound API providers (`auth-mixed-billing`). Reviewed fallback between OpenAI and Claude
subscription connections is supported when both providers are explicitly bound and ordinary admission passes. Each
provider keeps one active connection; an unavailable subscription never falls back to an API key.

A random pool's candidates may hold both classes. Each draw is one attempt in its own candidate's class: a bound
provider's model, also one whose connection cannot sign in now, is a subscription candidate, and any other model an
API-key one. The first draw passes over a subscription candidate that cannot take the job now (exhausted, signed
out, or allowing less paid extra usage than the job's cap) and may land on an API-key candidate the trigger listed;
once drawn, the class never changes, and a replacement after a subscription limit stays among the subscription
candidates. A pool that mixes the classes on this host needs a positive `run.maxCostUsd` on its trigger and is
otherwise refused as `auth-route-unbounded` before its draw. That cap bounds the API-key draws and the draws on a
connection with paid extra usage, which the runner prices from pi's model catalog and the overlay `models.json` as
they were at the job's start (a model priced at zero there is not bounded). A draw on a connection without paid
extra usage is not counted against it (see [the cost cap](#the-cost-cap-and-the-dollar-windows)); the trigger's
`run.maxSubscriptionUsd`, when set, limits those draws at list price instead, and doctor's line for the pool says which. A connection whose
`extraUsageCreditMicros` is below the job's cap is passed over at every draw (`auth-credit-cap-required`), so a
mixed pool then runs only on its API-key candidates, and doctor warns when a mixed pool's cap is above it. See
[random pools](triggers.md#choosing-randomly-from-a-reviewed-pool).

An ordinary flow can explicitly authorize additional panel calls with `run.auxiliaryModels`. This hand-authored
list contains 1–16 exact `provider/model` references, each also present in the explicit finite `run.models`
allowlist, and requires a positive explicit `run.maxCostUsd`. It permits a panel to use subscription models and
paid API models together. Random selection and fallback keep their authored root candidates; the chosen
attempt carries its root plus every auxiliary model into the existing model and cost guards. After a random draw the
drawn candidate is the attempt's only root, so another candidate of the pool that is also listed in
`run.auxiliaryModels` runs as an auxiliary model of that attempt and never decides its billing class. Extension calls
must use the admitted pi runtime so that every call shares the job's cost cap. Separate CLI processes and
unmetered HTTP requests do not gain subscription admission.

Every declared auxiliary route must pass authentication, model, quota and spend admission before the job
starts. An exhausted Claude auxiliary therefore holds an OpenAI-root job too; the dispatcher does not silently
omit a panel member. API credentials come from the host's configured environment or pi API-key login, or a
declared `run.secrets` value. A project bundle may carry no variable of an auxiliary model's provider, its API key
included: the job is refused as `secret-name-reserved`. The same `run.secrets` value can be the main model's credential when the job's own provider
is an API-key provider ([the provider key as a run secret](secrets.md#the-provider-key-as-a-run-secret)); a
provider bound to a connection here never takes one, and a trigger that binds a bound provider's API-key variable
is refused as `secret-name-reserved`. A subscription token in a declared `ANTHROPIC_API_KEY`, for the main model or
an auxiliary one, is refused as `provider-unconfigured`. The console preserves the field, but its model-callable
tools cannot author this grant. Upgrade workers, receivers and consoles before adding it; see [upgrading](upgrading.md).

Run management commands in a terminal on the owning host, with the same deployment environment as the worker:

```sh
pi-dispatch auth status
pi-dispatch auth login chatgpt-main
pi-dispatch auth usage chatgpt-main
pi-dispatch auth logout chatgpt-main
```

Login follows the selected adapter's browser authorization. The browser console does not receive credentials
or perform renewal. Logout disconnects future snapshots and prints `logout.remoteRevocationConfirmed` separately. A false value means remote revocation is unconfirmed, including when an adapter was removed or changed.
Already running jobs may receive renewed access snapshots for the same connection. A logout or a changed binding
stops further renewal, so such a job ends as `credential-expired` before its last published lease ends.

OpenAI proactive usage lookup is unavailable on this direct Responses integration unless its adapter publishes
a supported typed observation. Known quota failures still supply closed exhaustion/reset evidence; other
percentages remain unknown. A ChatGPT subscription past its plan's usage limit (or a Business workspace's
per-user limit) answers the model call with HTTP 200 and the refusal inside the stream; the runner reads the
refusal's closed code (`subscription_sharing_usage_limit_exceeded`, or
`subscription_sharing_workplace_individual_usage_limit_exceeded`) from that event, never from the sentence pi
prints, so the job is recorded with `providerFailure.kind` `quota-exhausted` and the connection shows exhausted.
ChatGPT's passing outages (`subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable`)
are not a quota and pause nothing. `auth usage` reports unsupported or unavailable explicitly, without scraping
another CLI's diagnostics or claiming that a connected credential has remaining quota.

The host store must be outside the global overlay, job directories, sandbox roots and every local job's
repository folder. A local job mounts its original folder, including untracked files; this also matters when
servicing a home or dotfiles repository that contains the default state directory. Every local job is checked
before token minting and again against its resolved mount source before the budget reservation. A contained
store refuses as `local-folder-holds-subscription-auth`, even for an unbound API job or before the first login
creates the store. Existing and dangling symlink parents are resolved for this check. Its directory is owned
mode 0700 and credential files are owned regular files with mode 0600. Do not copy a connection's refresh
credentials to several independent worker stores: the declared owner serializes renewal and persists rotating
replacements. A refresh with an uncertain result requires reauthentication rather than blindly replaying it.
An unreadable filesystem retries without disconnecting the stored credential. Missing or damaged adapter
metadata refuses until the reviewed adapter is restored or staged again; it does not spend an API key instead.
If the existing access token cannot safely cover startup and the provider declares a future earliest refresh time,
the job waits until that instant without a refresh call, uncertain marker or spent queue attempt. The same free
deferral handles quota or owner state that changed during selected preparation.

## Admission and renewal

On the `local` and `podman` venues, an image with `subscriptionLease`, `idleWatch` and `credentialRefresh` lets the
worker admit a job using the access token that is valid now. The worker requests a lease up to 30 minutes ahead,
shortening it when necessary to end more than 60 seconds before the token expires. More than four minutes of lease
must remain at admission and immediately before the container starts. This lease is the job's local permission to
use the token; it does not change the bearer token's actual expiry at the provider.

The host extends the lease while the job runs, using the existing token until the provider permits renewal.
It never rotates a token before `earliestRefreshAt`. A lease that cannot advance until that instant is an expected
wait, not a failed renewal. A real renewal failure is retried while there is time; if no replacement can be
published, the worker stops the job as `credential-expired` two minutes before the last published lease ends.
The runner keeps checking its own lease and expiry on model requests. See [job limits](job-limits.md#credentials-that-expire-while-a-job-runs).

The short lease requires the worker's renewal path and its read-only credential drop to work. If the drop cannot be
prepared, the container does not start. Renewable access must also fit the existing drop format (8 to 4096 printable
ASCII characters); an incompatible value is refused before startup as `auth-capability-unsupported`. This does not
change the host store's credential format, and a rotated replacement is saved before any delivery refusal.
An older image without the new capability keeps the full deadline plus
six-minute coverage requirement, so it can still wait for renewal even while the token is valid. Update the worker
and job image, rebuilding derived images, to remove that wait ([upgrade order](upgrading.md#the-order)). OpenShell
subscription jobs remain unsupported.

Renewed access values are added to the run's literal secret redaction before publication, including opaque OAuth
tokens without a recognizable prefix. Earlier values stay covered for the rest of the run. Transformed or encoded
copies are outside literal redaction's protection; refresh grants remain only in the host store.

When two jobs share a connection, a refresh by either job can invalidate the other's old access token.
The worker watches for that replacement and sends it to active siblings without extending their leases.
The runner applies it before requests. A Claude request that was already in flight may retry its identical
body once after a 401, but only with a proven newer credential from the same connection. A refusal of the
current credential still stops the job; it does not switch accounts, billing routes or models. Both the
worker and derived job images need the updated implementation. The existing `credentialRefresh` and
`subscriptionLease` capabilities and the drop format remain unchanged.

`credential_watch_unavailable` means prompt notification is unavailable and periodic checks remain.
A delayed or failed credential delivery can still stop a request. After fixing the credential or delivery
problem, start an ordinary new run; a saved draft artifact is not proof that the interrupted job finished.

A remaining authentication hold writes `subscription_auth_hold` to the worker log after the queue accepts the
delay, with only the job id, `why: "subscription-auth"` and the retry instant `until` in epoch milliseconds.
`pi-dispatch status` includes the reason and retry time in `waitingDetails`, with explicit partial/unavailable
indicators when it cannot read everything. A job already past its due time is marked `due`, so an old auth reason
does not claim it is still waiting for renewal. See [status output](service.md#status-output).

## OpenAI Sign in with ChatGPT

An OpenAI API key and Sign in with ChatGPT are separate choices. Use the [API-key guide](provider-keys.md)
for a project API key. For the reviewed host-owned ChatGPT route, first configure the `openai-chatgpt`
connection and explicit `openai` binding shown above. There is no token to retrieve into the browser form.

Run the installed command from the deployment directory, as the account that owns the connection store:

```sh
cd /absolute/deployment
./node_modules/.bin/pi-dispatch auth login chatgpt-main
./node_modules/.bin/pi-dispatch auth status
```

`chatgpt-main` must be the configured connection ID, and its `ownerHost` must match the effective
`PI_WORKER_NAME`. The CLI reads the selected deployment settings from this directory and refuses conflicting
shell/file declarations. Keep `PI_AUTH_CONNECTIONS_FILE`, `PI_AUTH_STORE_DIR`, `PI_SETTINGS_FILE`, worker name
and the deployment's actual `VALKEY_URL`/Valkey credential context consistent with the worker. An unavailable
Valkey or another host's policy is not evidence of a successful login.

`auth` reads and writes the quota rows in Valkey, and each of those commands waits at most 5 seconds. When one meets
a Valkey that is down or stops answering, `auth` ends with one line naming Valkey and what it said (exit 1), never a
stack trace, and asks you to run `pi-dispatch auth status` once Valkey answers. A login sends nothing to Valkey, so after one the
line starts with "the login finished, but": only the status read after it failed. A logout sends nothing to Valkey
either: it still prints its result (exit 0) with the status part unavailable, and the same line, starting with "the
logout finished, but", on stderr. After `auth trial`, the line adds that the grant may or may not have been made only
when the grant's write itself was sent and got no answer, since Valkey may have run it; when Valkey stopped answering
before that write, the grant was not asked for and nothing is said of it.

The worker adapter requests `http://127.0.0.1:1455/auth/callback` and listens on
`127.0.0.1:1455`. When the browser runs on another machine, establish a separate callback tunnel first:

```sh
ssh -L 1455:127.0.0.1:1455 <owner-host>
```

Port 1455 is the provider authorization callback, not the operator console's port. The host terminal may
accept the final callback URL as part of its existing login flow; never paste OAuth tokens, refresh grants or
callback URLs into the browser API-key field. Keep renewal on the declared owner and do not copy its refresh
store to several workers.

**Callback compatibility:** the worker follows pinned pi 1.4.0's upstream direct-auth source and the
[current official registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
`http://127.0.0.1:1455/auth/callback`. Use the exact URI returned by the current login flow; do not substitute
`localhost` or edit callback/state fields. Earlier builds used a different loopback hostname, so update the
worker if its generated authorization still requests `localhost`. This path is source-checked and covered by
callback validation tests; this credential-management page does not itself perform a live authenticated login.

See the official [Sign in with ChatGPT overview](https://developers.openai.com/siwc/token-sharing-open-source)
and [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
for current registration, host identity and remote-host requirements. Their protected credential-transfer
procedure is not a generic instruction to clone this worker's owner-managed refresh store.

## Claude community compatibility

Official Claude Code documents `claude setup-token` as a Claude Code authentication flow. It is not an
Anthropic API-key retrieval command for this form. See [Claude Code authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
The vendor's [current authentication and credential-use restrictions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
distinguish native Claude applications from third-party integrations. Review those restrictions before
choosing a community adapter. The compatibility below records what the pinned packages implement; it is
not a claim that vendor terms permit a particular deployment or that Anthropic endorses the integration.

Supported profiles are `pi-anthropic-oauth@0.3.11`, `pi-anthropic-oauth@0.3.6` and `@gotgenes/pi-anthropic-auth@3.4.3`. These are
operator-selected community extensions, with tested compatibility at their pinned versions. This is not a
claim of vendor endorsement, and trusted extension code still executes inside the existing process boundary.

A Claude connection uses provider `anthropic`, one of those exact adapter identifiers, and the absolute
prepared package `root` and SHA-256 `digest`. The root must be under the global overlay's `packages/` directory.
Declare exactly one selected profile in `pi-packages.json`, for example:

```json
{
  "packages": [
    { "name": "pi-anthropic-oauth", "version": "0.3.11", "dir": "claude-oauth" }
  ]
}
```

```sh
pi-dispatch import-pi --with-packages
```

For each supported exact profile, staging verifies published source bytes, applies the declared compatibility
adaptations and prints `reviewed subscription adapter` followed by the adapter and tree digest. Copy that digest
into the reviewed connection policy. Use the active directory recorded for this package in `pi-global/packages/packages.json`,
including its version and unique suffix. An older prepared directory can still exist without being active. Primary staging overrides its upstream SDK range to exactly
`@anthropic-ai/sdk@0.124.0`. Every runtime dependency is included in the prepared-tree digest. Restaging or
editing the package invalidates its prior digest and requires the policy to be checked again.

The Claude connection row can then be:

```json
{
  "id": "claude-main",
  "provider": "anthropic",
  "adapter": "pi-anthropic-oauth@0.3.11",
  "ownerHost": "worker-one",
  "root": "/absolute/deployment/pi-global/packages/claude-oauth--0.3.11--ACTUAL_SUFFIX",
  "digest": "replace-with-the-64-character-lowercase-digest-printed-by-staging",
  "quotaWindows": ["five-hour", "seven-day"]
}
```

Put the row in `connections`, bind `"anthropic": "claude-main"`, then run `pi-dispatch auth login claude-main`.
The example digest is a placeholder; the policy accepts only the actual lowercase SHA-256 value. Avoid loading
multiple Claude profiles or another extension that replaces the same provider.

The host can identify competing reviewed Claude profiles from the staged manifest without executing them.
It refuses that known conflict as `auth-adapter-conflicting` before quota claims, credential renewal, token mint
or clone. Keep exactly one reviewed Claude profile staged. An arbitrary trusted extension factory can reveal
a conflicting provider registration only when it executes; the runner checks that registration before the
first provider request. The final snapshot validation rechecks the current stage root, digest and known
conflicts. A stage change racing admission prevents container start and retries as infrastructure with the
ordinary reservation refund.

Primary uses its own OAuth lifecycle and transport. Secondary delegates authentication to pi and shapes its
builtin Anthropic transport. The adaptations preserve final-request model/cost checks, failed-response
observation, cancellation and cache accounting. Unadapted packages, altered dependency trees, conflicting
provider overrides and disabled required packages refuse before provider dispatch.

Claude calls through the admitted root runtime and its shared runtime children retain these guards. An
independent legacy `pi-ai` compatibility call to Anthropic is unsupported and refuses before dispatch; only
the root runtime's own internal reentry is accepted. Creating a fresh runtime without the admitted adapter
also refuses. Loading a supported package does not authorize every independent extension call path.

Claude quota/profile observations use the selected community route's bounded usage interface. Missing,
incomplete or unavailable fields stay unknown. The worker does not scrape `/usage` command output or infer a
physical model from a provider display name. An exhausted scoped window without a reviewed model mapping
conservatively blocks the connection's application bucket. The reviewed exception is the exact
modern Fable weekly scope (`weekly_scoped`, group `weekly`, model `{ id: null, display_name: "Fable" }`,
`surface: null`): its exhaustion does not block `anthropic/claude-opus-5-5`. Anthropic documents that
[the separate Fable limit allows switching to another Claude model](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan).
Every model in the job's finite allowlist is checked separately. Unknown scopes, extra scope fields and other
model routes keep the conservative behavior; the connection view still shows Fable exhaustion. Reset times
with up to nine fractional-second digits are retained and rounded up to milliseconds, never released early.

A measured Claude HTTP 429 requires a fresh bounded usage observation before another paid admission. The
worker first invalidates cached availability and paid-overage facts across this connection's models. It does
not label an ordinary provider throttle as plan exhaustion. A failed usage read leaves the fresh observation
required, and an older in-flight response cannot clear a newer invalidation.

When upgrading an existing connection, upgrade both the worker and job image before selecting 0.3.11,
then stage it and update the connection’s adapter, active root and digest together. The credential store
matches the exact adapter identifier: changing the policy alone requires `pi-dispatch auth login claude-main`
before jobs can use it. Existing 0.3.6 and secondary receipts remain valid; they do not require restaging
merely because the worker now supports another profile.

## Quota admission

Five-hour and seven-day monitoring preferences default to both and choose the Models card's display focus.
Available or unknown unselected account windows are omitted from that card. Every known exhausted window
remains visible and mandatory at pickup, including windows outside that focus; scoped and other provider
windows remain visible because they are not independently selectable. The preferences do not authorize
spending against any observed exhausted applicable window. The connection, its private stable account group and application bucket
share evidence across jobs and physical models. Independently linked connections are not automatically
deduplicated as the same vendor account.

Available observations become stale after five minutes. Initial or stale unknown quota can pass ordinary
admission, subject to authentication, paid-overage policy and every other gate. Unknown does not mean remaining
capacity. A known exhausted window blocks through its full observed reset, including a whole week; the separate
six-hour physical model cooldown does not shorten it. All applicable exhausted windows must clear.

An exhausted window without a reset has no guessed timeout. Newer authoritative usage evidence can clear it;
partial, missing or older evidence cannot. When the exhaustion came from a provider's refusal (a ChatGPT usage
limit names no reset), the connection is retested by one job six hours after the newest refusal: `auth status`
shows that instant as `retestAt`. Exactly one pickup across the fleet claims the retest. If it meets the limit
again, the next retest is six hours after that refusal; so it is after a rate limit or any other provider's quota
stop, which settle nothing. If the provider answered it (a verified exit 0, 1 or 2 after at least one call on that
provider returned output, and no quota or rate-limit failure ended it, so an overload or a policy stop later in the
run still counts), the refusal is cleared and every job may use the connection again. If the run provably never
called that provider (a policy stop before its first call, say, and an exit line whose usage rules the provider
out), the retest is given back and the next pickup tries again at once. Otherwise (calls that returned nothing, a
usage record that cannot rule the provider out) the next retest is six hours after it started, and so is it for a
retest whose container never started. Exhaustion read from a usage window (Claude's) and exhaustion with a known
reset are never retested. Refresh observations on the owner:

```sh
pi-dispatch auth usage claude-main
```

If reset information remains unavailable, a person may authorize one normally budgeted trial:

```sh
pi-dispatch auth trial claude-main
```

The command starts no job and does not clear exhaustion; the job that claims the trial clears a provider's
refusal the same way a retest does, once the provider answered it, and a job that never called the provider leaves
the trial for the next pickup. Candidate inspection consumes nothing. Only selected
admission claims the trial atomically for one durable attempt; another attempt cannot use it while that one holds it,
and gets it only when that attempt gave it back unasked. A known reset,
newer evidence or stale state prevents the corresponding stale trial grant. The trial bypasses no model,
credential, replay, recovery, count, token or dollar check.

## Quota reserve

One long job can use the rest of an account's seven-day window and stop every job until it resets. A quota reserve
keeps the top of a Claude window for the work you choose. Set it on the host that owns the connection:

```sh
PI_QUOTA_RESERVE_PERCENT=85
```

It is a whole percent from 1 to 99; unset (the default) is off, and any other value stops the worker at boot. It is
read from the environment only, and only by the owner host, so set it on every host that owns a Claude connection.

When a window the job's Claude model is checked against stands at or above the reserve, only jobs whose trigger sets
`run.quotaReserve: true` start ([triggers](triggers.md#using-the-subscription-quota-reserve)). Every other job waits.
It is not refused: it waits, at no cost, with the reason `subscription-reserve` on the console's waitlists ("The
subscription account is at or above its quota reserve"), and asks again at the window's reset or after five minutes,
whichever is sooner. When a random pool's or a fallback list's choice of model finds every candidate held, the job
asks again after a minute instead (for a random pool, at a reset that comes sooner). The waitlist names a reset: the
latest reset of the windows holding the job, when every one of them has one; or, when a random pool's or a fallback
list's choice found every candidate held, the earliest reset any blocked candidate knows, while the reason stays the
first blocked candidate's. A job of a trigger you mark in the meantime starts at its next ask.

The owner host's worker reads `run.quotaReserve` from its own triggers file (`PI_TRIGGERS_FILE`, else
`./triggers.json` where the worker runs), when the reserve would hold a job. So that host needs the file: where it is
missing, does not load or was written by a newer pi-dispatch, no trigger can use the reserve and every job waits above
it. A job with no trigger never passes the reserve either: an ad hoc `pi-dispatch run` job, a job a run chains through
its outbox, a watch investigation and an answer draft always wait above it.

- A reading counts only with a measured percentage. Usage only grows inside a window until it resets, so a reading at or
  above the reserve counts until its reset even when it is older than five minutes. A reading with no reset time counts
  only while it is fresh; an older one is read again before a job starts.
- Unknown usage never holds a job. Neither does a ChatGPT connection: it publishes no percentages, so the reserve does
  not apply to it.
- A window at 100% is exhausted, and its own wait applies first ([quota admission](#quota-admission)), marked trigger or
  not. The one exception is a connection authorized for [paid extra usage](#paid-extra-usage) whose extra usage is
  enabled: admission lets its jobs past an exhausted window to spend paid credit, and the reserve then holds every
  unmarked job, so only jobs of marked triggers start and spend that credit.
- The windows are the ones admission counts for the job's model: the reviewed Fable weekly scope does not hold an
  `anthropic/claude-opus-5-5` job.
- In a random model pool, the first draw passes over a Claude candidate the reserve holds, as it passes over an
  exhausted one, and may draw another candidate. A job that has already drawn its model waits.
- An auxiliary Claude model the reserve holds holds the whole job, as an exhausted one does.

`pi-dispatch doctor` names the triggers file the worker reads the flag from and how many triggers set it, and warns
when the file cannot be used. It then prints a line for each connection the host owns, comparing its windows with the
reserve. `pi-dispatch auth status` prints the reserve as `reservePercent` on each Claude connection the host owns. The
Models page shows it, marks each window that holds jobs, and says so in the connection's badge and Pickup line. A host
from before this release publishes no reserve and holds no job on one.

## Paid extra usage

Claude `extra_usage` that is enabled or unknown refuses by default. To authorize paid overage explicitly, put a
positive safe-integer `extraUsageCreditMicros` on that connection and set a per-job dollar cap no larger than
it. For example, `250000` is a conservative model-cost ceiling of 0.25 USD per job, not 250000 provider credits.
Deployment and scoped dollar windows still apply. Authorization never silently changes the bound account.

## The cost cap and the dollar windows

A connection without paid extra usage (no `extraUsageCreditMicros`) bills nothing per call, so its calls are
notional: the per-job cost cap (`maxCostUsd`) does not count them, and they leave every dollar window, a
`model:<provider>/<model>` row of `scoped-limits.json` included. The run record still prices them at list price, in
`tokens.cost`, with that part as `tokens.costNotional`, and `notionalProviders` names the providers. What bounds such
a job is the account's quota, checked before the job starts, the job's turn and time limits (`run.maxTurns`,
`run.maxMinutes`) and, when its trigger sets one, a list-price allowance (below). A job whose every model is on such a
connection reserves nothing in the dollar windows and `pi-dispatch doctor` warns when a trigger's own
`run.maxCostUsd` bounds nothing on that host.

**A list-price allowance.** A trigger's `run.maxSubscriptionUsd` limits the list price of a job's notional calls,
on every subscription connection alike, whatever its adapter: the runner checks the `tokens.costNotional` the calls so far settled at
before each subscription call and refuses the call once it is at or above the allowance, which stops the run as
`subscription-allowance`. It holds nothing for a call still running, so the calls in flight when it is reached finish
and count, and a job can end above it by what they cost. It never counts a call that can be billed, which the cap
still bounds. Without it a subscription job has no dollar limit; there is no deployment-wide allowance. A job with one
needs a job image that declares `subscriptionAllowance`, or it is refused before it spends
(`job-image-subscription-allowance-unsupported`). A subscription call whose cost cannot be read stops the run at the
next one; a model priced at zero is not bounded by it. It is a budget at list price for each attempt (a recovery or a
retry starts again at 0, as the cap does), not a share of the account's
quota: the five-hour and seven-day windows are the account's, shared by every job on it. See
[triggers.md](triggers.md#a-subscription-allowance-per-job).

A connection WITH paid extra usage keeps counting every call against the cap and the windows: any of its calls may
be billed, and nothing tells which, so the case in issue #1008 (a long subscription job stopped at the cap over list
prices) can still happen there. Two residuals are known, and in both a call can be billed with no dollar bound,
where before this release it was capped at list price: a ChatGPT connection has no modelled paid overage, so it is
treated as notional, an account with purchased credits included; and a Claude connection is admitted only while extra
usage is known to be off, so if extra usage is turned on at the provider while a job runs, with no
`extraUsageCreditMicros` edit, that job's calls past the quota are billed as extra usage and nothing caps them.

The job image decides whether a call is counted, and it trusts the worker's mark only with the subscription's
adapter admitted and a model list in force, never in a child process. An image from before this release counts every
subscription call against the cap, as before, and a worker from before it never marks a connection, so its jobs count
every call too. See [the upgrade guide](upgrading.md) and [what the cap counts](costs.md#what-the-cap-counts).

Provider `used_credits` and `monthly_limit` retain their own currency and decimal scale; missing units are
unknown. Quota percentages, vendor credit counters, API-equivalent model costs and flat subscription prices
are separate observations. `subscriptions.json` remains analytics-only and changes no authentication or
routing. See [Spend accounting](costs.md) and [model failover](model-failover.md).

## Supported jobs and visibility

Subscription jobs require a finite reviewed `models` list. Community Claude requires its verified staged
package to remain enabled. Compaction and child sessions sharing the admitted root runtime retain its
provider/model/account policy. Separate pi CLI or Node child processes refuse subscription dispatch in this
initial release; they do not inherit attested subscription admission. A fresh runtime without the admitted
adapter also refuses. Unsupported endpoint/API combinations, OpenAI classifier roles, OpenShell
venues and subscription canaries refuse before spending. A resurrected sandbox remains credential-free.
Recovery retains its checkpoint's physical model and rechecks current authentication and policy.

Connections shows the configured owner, selected profile, compatibility, credential state and expiry.
Models shows typed quota windows, observation age, exhausted/unknown state, paid-overage facts and a published
quota reserve. Operator terminal commands are offered where applicable; viewers receive no credential management
controls. Missing host publication remains unknown. Raw credentials, account/profile identities and provider errors are absent
from both browser and machine projections.

The behavioral contracts are `REQ-SUBSCRIPTION-AUTHENTICATION`, `DES-HOST-OWNED-SUBSCRIPTION-AUTH`,
`INT-AUTH-CONNECTIONS-FILE-CONTRACT`, `INT-SUBSCRIPTION-CREDENTIAL-STORE` and `INT-SUBSCRIPTION-QUOTA-KEY`.
