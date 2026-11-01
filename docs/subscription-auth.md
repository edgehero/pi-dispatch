# Subscription authentication and quota

An explicit subscription connection lets the worker use OpenAI ChatGPT authentication or a supported Claude
community OAuth extension. The owning host handles login and renewal. Jobs receive only a short-lived access
credential that remains valid beyond their deadline; refresh grants stay in a private host store.

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

Version 1 refuses a job whose finite model routes mix subscription-bound and unbound API providers, including
decision roles. A subscription primary also skips an unbound API fallback. Reviewed fallback between OpenAI
and Claude subscription connections is supported when both providers are explicitly bound and every ordinary
model, quota, spend and replay check passes. Each provider still has one active connection; this does not rotate
accounts or change authentication during a running attempt. Use a separate job for unbound API billing.

Run management commands in a terminal on the owning host, with the same deployment environment as the worker:

```sh
pi-dispatch auth status
pi-dispatch auth login chatgpt-main
pi-dispatch auth usage chatgpt-main
pi-dispatch auth logout chatgpt-main
```

Login follows the selected adapter's browser authorization. The browser console does not receive credentials
or perform renewal. Logout disconnects future snapshots and prints `logout.remoteRevocationConfirmed` separately. A false value means remote revocation is unconfirmed, including when an adapter was removed or changed.
Already running jobs retain the access snapshot they received until they finish or it expires.

OpenAI proactive usage lookup is unavailable on this direct Responses integration unless its adapter publishes
a supported typed observation. Known quota failures still supply closed exhaustion/reset evidence; other
percentages remain unknown. `auth usage` reports unsupported or unavailable explicitly, without scraping
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
If the provider declares an earliest refresh time and the existing access token is too short for the job, the
job waits until that instant without a refresh call, uncertain marker or spent queue attempt. The same free
deferral handles quota or owner state that changed during selected preparation.

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

Supported profiles are `pi-anthropic-oauth@0.3.6` and `@gotgenes/pi-anthropic-auth@3.4.3`. These are
operator-selected community extensions, with tested compatibility at their pinned versions. This is not a
claim of vendor endorsement, and trusted extension code still executes inside the existing process boundary.

A Claude connection uses provider `anthropic`, one of those exact adapter identifiers, and the absolute
prepared package `root` and SHA-256 `digest`. The root must be under the global overlay's `packages/` directory.
Declare exactly one selected profile in `pi-packages.json`, for example:

```json
{
  "packages": [
    { "name": "pi-anthropic-oauth", "version": "0.3.6", "dir": "claude-oauth" }
  ]
}
```

```sh
pi-dispatch import-pi --with-packages
```

For either supported exact profile, staging verifies published source bytes, applies the declared compatibility
adaptations and prints `reviewed subscription adapter` followed by the adapter and tree digest. Copy that digest
into the reviewed connection policy. The prepared root in this example is the absolute path to
`pi-global/packages/claude-oauth`. Primary staging overrides its upstream SDK range to exactly
`@anthropic-ai/sdk@0.124.0`. Every runtime dependency is included in the prepared-tree digest. Restaging or
editing the package invalidates its prior digest and requires the policy to be checked again.

The Claude connection row can then be:

```json
{
  "id": "claude-main",
  "provider": "anthropic",
  "adapter": "pi-anthropic-oauth@0.3.6",
  "ownerHost": "worker-one",
  "root": "/absolute/deployment/pi-global/packages/claude-oauth",
  "digest": "replace-with-the-64-character-lowercase-digest-printed-by-staging",
  "quotaWindows": ["five-hour", "seven-day"]
}
```

Put the row in `connections`, bind `"anthropic": "claude-main"`, then run `pi-dispatch auth login claude-main`.
The example digest is a placeholder; the policy accepts only the actual lowercase SHA-256 value. Avoid loading
both Claude profiles or another extension that replaces the same provider.

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
conservatively blocks the connection's application bucket.

A measured Claude HTTP 429 requires a fresh bounded usage observation before another paid admission. The
worker first invalidates cached availability and paid-overage facts across this connection's models. It does
not label an ordinary provider throttle as plan exhaustion. A failed usage read leaves the fresh observation
required, and an older in-flight response cannot clear a newer invalidation.

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
partial, missing or older evidence cannot. Refresh observations on the owner:

```sh
pi-dispatch auth usage claude-main
```

If reset information remains unavailable, a person may authorize one normally budgeted trial:

```sh
pi-dispatch auth trial claude-main
```

The command starts no job and does not clear exhaustion. Candidate inspection consumes nothing. Only selected
admission claims the trial atomically for one durable attempt; another attempt cannot reuse it. A known reset,
newer evidence or stale state prevents the corresponding stale trial grant. The trial bypasses no model,
credential, replay, recovery, count, token or dollar check.

## Paid extra usage

Claude `extra_usage` that is enabled or unknown refuses by default. To authorize paid overage explicitly, put a
positive safe-integer `extraUsageCreditMicros` on that connection and set a per-job dollar cap no larger than
it. For example, `250000` is a conservative model-cost ceiling of 0.25 USD per job, not 250000 provider credits.
Deployment and scoped dollar windows still apply. Authorization never silently changes the bound account.

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
Models shows typed quota windows, observation age, exhausted/unknown state and paid-overage facts. Operator
terminal commands are offered where applicable; viewers receive no credential management controls. Missing
host publication remains unknown. Raw credentials, account/profile identities and provider errors are absent
from both browser and machine projections.

The behavioral contracts are `REQ-SUBSCRIPTION-AUTHENTICATION`, `DES-HOST-OWNED-SUBSCRIPTION-AUTH`,
`INT-AUTH-CONNECTIONS-FILE-CONTRACT`, `INT-SUBSCRIPTION-CREDENTIAL-STORE` and `INT-SUBSCRIPTION-QUOTA-KEY`.
