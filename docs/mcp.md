# MCP servers in jobs

pi can call tools on MCP servers. In pi-dispatch a job connects only the servers **you** offer in the overlay and
its trigger names. A repo's own `.pi/mcp.json` is never read for a job, and a server an extension registers is never
connected.

This page covers the overlay file, `import-pi`, `doctor`, naming servers in a trigger (`run.mcp`) and what happens in
the job. The job image must declare the `mcp` capability (this repository's image does); on one that does not, every
job that names a server is refused before it costs anything.

## The overlay file

Servers live in `mcp.json` in the overlay folder (`PI_GLOBAL_PI_DIR`), in pi's own `mcpServers` shape:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search the product documentation",
      "exposure": "codemode"
    },
    "files": {
      "command": "/opt/pi-global/mcp/files-server",
      "args": ["--root", "/workspace"],
      "env": { "FILES_TOKEN": "${FILES_TOKEN}" },
      "description": "Index of the checkout's files",
      "exposure": "deferred"
    }
  }
}
```

`pi-dispatch import-pi` writes this file from your own `~/.pi/agent/mcp.json`. It keeps only the servers a job can
use, prints each one it staged, and names each one it left behind with the reason. The overlay's file follows your
host's: each import replaces it, and with `--no-mcp`, with no `mcp.json` on your host, or with no server a job can
use, the overlay gets none. That includes a file you wrote into the overlay by hand, so either keep your servers in
`~/.pi/agent/mcp.json` or do not run `import-pi` over a hand-written one. If your host file cannot be read (not JSON,
a key written twice), the import leaves the overlay's file as it was and says so. `pi-dispatch doctor` checks the
overlay's file either way.

### What a server may say

- **A name** of lowercase letters and digits, words joined by a single `-`, up to 32 characters. A name holding
  `dispatch` is reserved, and so is `forge`, the worker's own [forge server](#the-forges-own-server).
- **`description`**, required: one line of at most 300 characters, with no control or invisible formatting
  character. pi puts it in the job's prompt, so you write the words the agent reads about the server, not the server.
- **A streamable HTTP server** has `url` and optionally `headers`. **A stdio server** has `command`, and optionally
  `args` and `env`. `type` is optional (`http`, `streamable-http` or `stdio`).
- **`exposure`** and **`toolExposure`**, as in pi: `codemode`, `deferred`, `direct` or `hidden`.
- **`timeout`** in whole seconds (1 to 600) and **`enabled`**.

### Credentials are references

The overlay is mounted into every job's container, so a credential is never written in it. You write a reference,
`${NAME}` with `NAME` in capitals, digits and `_`, and the job fills it in from the variables its trigger already
passes, through `run.secrets` ([secrets.md](secrets.md)) or `PI_FORWARD_ENV`. A reference goes wherever the server
wants its key:

- **a header:** `"Authorization": "Bearer ${DOCS_TOKEN}"`. A header value is `${NAME}`, or one of these schemes and a
  space before it: Bearer, Basic, Token, Bot, ApiKey, Key, Splunk, SSWS, Digest;
- **an env value:** exactly `"${FILES_TOKEN}"`;
- **the url's path or query:** `"https://actions.example.com/mcp/${ZAP_KEY}/sse"`, `"https://h/mcp?api_key=${KEY}"`;
- **an argument:** `["--token=${TOKEN}"]`, `["--header", "Authorization: Bearer ${TOKEN}"]`.

Header values, env values and query values are always references: none of them is ever written in the overlay,
whatever its name, so a constant there that is not a secret also goes through a trigger variable. A url's host is
written as is (the egress check reads it before the job starts), and a url has no fragment, user name or password.
Write the url plainly, as a browser would show it: lowercase scheme and host, `https://` with two slashes, no `:443`.
`doctor` and `import-pi` show the plain form when a url is written another way.

pi itself would run a value starting with `!` as a shell command and expand a bare `$NAME`; pi-dispatch fills in the
references itself, so a secret whose value starts with `!` is sent as text.

### What is written as is

**A literal argument and a literal part of a url's path are written in the overlay as they are**, and every job can
read the overlay. Nothing can tell a key from a file name there: two earlier rules that tried (one for header and env
names, one for flags) refused `--max-tokens 4096` and still let `--api_key=sk-...` through. So put a credential in a
reference, and check what you stage: `import-pi` prints each server it staged.

### Commands

- A stdio `command` is a bare name found on the job image's `PATH`, or an absolute path under `/usr`, `/bin`,
  `/sbin`, `/opt` or `/app`: the image's own folders and the overlay at `/opt/pi-global`. Any other folder is one the
  job can write (`/workspace`, `/tmp`, its home), so install the server in the [job image](job-image.md) or the
  overlay.
- No `command` or argument starts with `~`: pi reads it as the job's home folder.
- A package runner (`npx`, `npm`, `pnpm`, `pnpx`, `yarn`, `bunx`, `bun`, `uvx`, `uv`, `pipx`) is refused unless the
  entry says `"allowPackageRunner": true`. Such a server is downloaded at the start of every job that uses it, at
  whatever version the registry serves, and the job reaches the registry only if you allowlist it.
- These rules read the command, not what it runs: `node` or `python3` with a script path, or a launcher such as `env`
  or `sh`, run whatever their arguments say. That is your choice in your file.

### What else is refused

- `auth` and `oauth`: a job cannot finish a sign-in in a browser, and must not hold pi's `mcp-auth.json`. Give the
  server a token in a header instead.
- `cwd`: a job runs its servers in the checkout.
- The legacy SSE transport. Use the server's streamable HTTP URL.
- Any other key. A key a newer pi adds is refused until pi-dispatch knows what it does in a job.

## Naming servers in a trigger

A trigger opts in by name, with `run.mcp` in `triggers.json`:

```json
{
  "on": { "type": "label", "any": ["docs"] },
  "run": { "kind": "github", "flow": "answer", "mcp": ["docs"], "secrets": { "DOCS_TOKEN": "op://ci/docs/token" } }
}
```

A trigger without `run.mcp` connects no MCP server. Up to 8 names, each from the overlay's file, or `forge` for the
[forge's own server](#the-forges-own-server). Before anything is spent, the worker checks each one and refuses the
job when:

| Reason | Why |
|---|---|
| `mcp-list-invalid` | the list the job carries is not one the loader writes (a service at another version, or a hand-added job) |
| `mcp-config-invalid` | the overlay's `mcp.json` is missing or cannot be read whole (missing is fine when the only name is `forge`) |
| `mcp-server-unknown` | the file does not offer that name, turns it off, or refuses it (`doctor` says why); or `forge` on a job that is not a github or gitlab one |
| `mcp-secret-reserved` | the server references a credential the job is set up to spend with (the key variables of its own provider and of each provider on its model list, or of every provider when it has no list, and every variable the overlay `models.json` references), the forge token, or the egress or runner variables. To hand a server a provider's variable on purpose (`HF_TOKEN` for a Hugging Face server), give the trigger a model list without that provider |
| `mcp-secret-unmapped` | the server references a variable the job will not have: not in `run.secrets`, and not a `PI_FORWARD_ENV` name the worker holds a value for |
| `mcp-egress-unreachable` | with the egress policy on, the proxy would not let the job reach the server (an `http://` url on port 443 included), or `egress-allowlist.conf` cannot be read; for `forge`, its API host is not allowlisted |
| `mcp-package-runner` | with the egress policy on, the registry a package runner fetches from is not allowlisted |
| `mcp-excluded` | the trigger's `run.excludeTools` leaves the server no way in ([exclude-tools.md](exclude-tools.md)) |
| `job-image-mcp-unsupported` | the job image does not declare the `mcp` capability |
| `job-image-forge-mcp-unsupported` | the trigger names `forge` and the job image does not declare the `forgeMcp` capability |
| `trigger-skew` | the trigger names servers but the job arrived without them: the trigger changed after the job was queued, or the receiver is older than the worker |

The comment on the issue names the server and the rule, never a host or a variable; the worker's log has the
detail (`refused_mcp`). A read of the overlay's file or the allowlist that fails in a way that may pass (EIO, for
one) is retried instead. The job gets its servers in `/job/mcp.json`, references and all, never a value.

Upgrade the receiver and the worker together. A receiver older than `run.mcp` drops the field, and the worker then
refuses each such job as `trigger-skew` rather than running it without its servers.

The registry check reads the runner's name only. A server whose own arguments or environment point the runner at
another registry (`--registry`, `--index-url`, `npm_config_registry`) passes it and fails when it starts, before the
prompt: allowlist the registry it really uses.

## In the job

The job loads pi's MCP, codemode and tool_search, as the pi CLI does, and connects exactly the servers in
`/job/mcp.json`, before its prompt:

- **Exposure.** Each server's `exposure` and `toolExposure` work as in pi: `codemode` (the default) reaches the tools
  from a codemode script, `deferred` through `tool_search`, `direct` declares them to the model, `hidden` leaves them
  out. Resources are read through pi's resource tools (`list_mcp_resources`, `list_mcp_resource_templates` and
  `read_mcp_resource`). Each server's `description` becomes its line in the prompt's list of servers. A codemode
  script's `models.classify()` and `models.generateImages()` are on, as in the pi CLI: each is metered with the job,
  held to its model list, and under a cost cap refused when it cannot be bounded (every image call, and a classifier
  with an output price). A refused call stops the whole job, as any model call the cap or the list refuses does, so
  a job under a cap cannot try an image model and carry on. An image model pi's catalog prices at zero is counted
  at zero. `"codemodeModels": false` at the top of the overlay's `mcp.json` turns them off for every job.
- **References.** The job resolves each `${NAME}` once, from its own environment. A value that starts with `!` is
  sent as text, never run.
- **HTTP servers.** Each request goes to the server's own origin, through the egress proxy when it is on. A redirect
  is refused rather than followed, and an HTTP 401 ends the job: a job never signs in.
- **stdio servers.** The server starts in `/workspace` with its own `env` over `PATH`, `HOME`, the locale, the time
  zone, the temp folder, the proxy variables and the job's usage meter (`NODE_OPTIONS`, `PI_DISPATCH_CHILD_LEDGER` and
  `PI_DISPATCH_RUNNER_PID`, so a pi it starts is metered; its `env` may not replace them). It never sees the
  provider's key, and never the forge token unless it is the forge's own server: the pickup refuses an overlay entry
  that names one. It is stopped when the job ends.
- **Nothing else connects.** Not a repository's `.pi/mcp.json`, not a server an extension registers, and not a pi the
  job starts (it gets `--no-mcp`; `pi mcp`, the subcommand, is the one residual, open-questions OQ-011). There is no
  `/mcp` command. An extension that registers `codemode`, `tool_search`, a resource tool, an `mcp__` tool or `/mcp`
  as it loads ends the job before its prompt, and one that registers such a tool later is refused each call to it
  (a guard against a collision, not against a hostile extension, which can rewrite a call as any in-process extension
  can).

The job waits for every server to answer: 15 seconds, or a server's own `timeout` when that is longer, up to 120. A
server counts as answered once pi has listed its tools. It ends before its prompt, on the exit line with:

| Reason | Code | Why |
|---|---|---|
| `mcp-unavailable` | 2 | a server refused: its command did not start, it exited or failed the handshake or the tool list, pi refused an answer, an HTTP error other than 408, 429 or a 5xx other than 501 (401, for example), a redirect, a body over 16 MiB, or its own `timeout` ran out before it answered |
| `mcp-unreachable` | 1 | a server had not answered when the wait ran out (the network, a 5xx or 429 pi kept retrying, a server still starting); retried like any infrastructure failure |
| `mcp-shadowed` | 2 | another extension registers a name only the job's MCP may |
| `mcp-command-missing` | 2 | a stdio server's command is not in the image |
| `mcp-secret-missing` | 2 | a variable the server references is not set in the job |
| `mcp-config-mismatch`, `mcp-config-invalid` | 2 | `/job/mcp.json` is not what the worker writes for this job (a hand-run container, or a worker and image at different versions) |

Each reason with code 2 is the run's reason in its record and in the panel, and pages `PI_ON_FAILURE` as any paid
stop does. The comment on the issue says which rule stopped the job in a fixed sentence that names no server, host or
variable; the worker's log has the server and the cause, on the job's `exit` line. `mcp-config-invalid` is also the
pickup's reason for an overlay file it cannot read; that refusal spends nothing (`budgetReserved: false` in the
record) and pages nobody.

MCP tool results, server instructions and resource text are content the model reads, like an issue's text: treat a
server as you would any input the job did not write. A stdio server runs code inside the job's container with the
secrets its entry names.

## The forge's own server

A github or gitlab trigger can give its job the forge's own MCP server, with the token the job already holds for
`gh` or `glab`. Name `forge` in `run.mcp`, alone or beside overlay servers:

```json
{
  "on": { "type": "label", "any": ["pi"] },
  "run": { "kind": "github", "flow": "fix", "mcp": ["forge", "docs"] }
}
```

`forge` needs no entry in the overlay, and no overlay at all when it is the only name. The worker writes its entry
itself (`forgeMcpServer` in `worker/src/mcp-config.mjs`), so neither a trigger nor the overlay can point it anywhere
else, and an overlay server named `forge` is refused.

| Job | Server | Started as | Token |
|---|---|---|---|
| github | [github-mcp-server](https://github.com/github/github-mcp-server) 2.0.2, GitHub's own | `/usr/local/bin/forge-mcp-github`, which runs `github-mcp-server stdio` with `GITHUB_TOOLSETS=default` and `GITHUB_LOCKDOWN_MODE=1` | `GITHUB_PERSONAL_ACCESS_TOKEN` from the job's `GH_TOKEN` |
| gitlab | [@zereight/mcp-gitlab](https://www.npmjs.com/package/@zereight/mcp-gitlab) 2.1.67 | `/usr/local/bin/forge-mcp-gitlab`, which runs it with `GITLAB_API_URL` set to your `GITLAB_URL` plus `/api/v4` and `GITLAB_DISABLE_VERSION_CHECK=true` | `GITLAB_PERSONAL_ACCESS_TOKEN` from the job's `GITLAB_TOKEN` |

- **Withheld tools.** The image's wrapper withholds each server's dedicated merge and approval tools, so the
  harness does not hand the agent a ready made one (`CONST-MERGE-NEVER-AUTOMATIC`):
  - github: `merge_pull_request`, and `pull_request_review_write`, which can submit an approving review; also
    `assign_copilot_to_issue` and `request_copilot_review`, which start Copilot's own agent or review and would spend
    outside the job's meter;
  - gitlab: `merge_merge_request`, `approve_merge_request`, `unapprove_merge_request` and `approve_deployment`; also
    `discover_tools`, which would turn on toolsets beyond the default ones, and `execute_graphql`, which no
    toolset lists but whose mutations can merge.

  They are left out of every tool list, and a call to one, or to any tool the server did not list, is refused before
  it reaches the server. **This is not a boundary.** GitLab runs quick actions (`/merge`, `/approve`) written in a
  note or a description, and the listed tools post notes and descriptions; the job's `gh` or `glab`, or the server
  started from the job's shell, act with the token's full role. What bounds a merge is the token's role and the
  branch's protection: on GitHub, branch protection ([SECURITY.md](../SECURITY.md)); on GitLab, a token with the
  Developer role (not Maintainer) on a protected branch that only Maintainers may merge, and approval rules the bot
  does not count toward ([gitlab.md](gitlab.md)).
- **No new credential.** The server gets the token the worker minted for this job, and nothing else of the job's:
  not the provider's key, and not the token under its CLI names. It can do no more than the job's `gh` or `glab` can
  do with that token. A GitHub installation token lives one hour, and the server stops with the job anyway.
- **GitHub's toolsets.** `default` is context, repos, issues, pull requests and users. `actions` (workflow runs and
  their triggers) stays off.
- **Lockdown** (GitHub). On a public repository, the server withholds issue, pull request and comment content written
  by someone without push access. It is a filter that lowers the chance of a planted instruction reaching the model,
  not an authorization boundary: the token reads the same things through `gh`, and so can the job.
- **Pinned in the image.** Both servers are baked into the job image at exact versions: github-mcp-server from its
  release tarball checked against a sha256 per architecture, mcp-gitlab with `npm ci` from a lockfile committed in
  `image/forge-mcp/gitlab`, each behind its wrapper in `image/forge-mcp`. The image declares this with the
  `forgeMcp` capability; on an image without it the job is refused before it costs anything
  (`job-image-forge-mcp-unsupported`).
- **Egress.** With the egress policy on, a github job's server needs `api.github.com` in `egress-allowlist.conf`, and
  a gitlab job's needs the host of your `GITLAB_URL` (on port 443, or declared in `model-endpoints.json`). The pickup
  refuses the job (`mcp-egress-unreachable`) otherwise. `GITLAB_URL` must be a plain `http` or `https` URL with no
  user name, password, query, fragment or comma (a trailing `/api/v4` is fine); the pickup refuses `forge` on a gitlab
  job otherwise (`mcp-server-unknown`, the reason in the worker's log). github-mcp-server reads a file's contents from
  `raw.githubusercontent.com`; allowlist it too if the job reads files through the server rather than from its
  checkout.
- **Not on every kind.** A cron trigger is refused at load: a cron job holds no forge token of its own. Forgejo and
  Azure DevOps triggers are refused too, until a forge MCP server for them has been checked the way these two were.
- **Why not GitLab's own endpoint.** GitLab serves MCP itself at `/api/v4/mcp`, but it takes an OAuth token with the
  `mcp` scope, and a project, group or personal access token cannot carry that scope.

What the server's tools return (issue and pull request text, comments, file contents) is content the model reads,
like the issue that started the job. Treat it as untrusted input, as you would any text a stranger can write.

## What doctor checks

- that `mcp.json` reads, and which servers it offers;
- each server it refuses, and why (a job that names it is refused), an overlay server named `forge` among them;
- no `mcp-auth.json` in the overlay (it offers to delete one);
- a server that uses a package runner;
- with the egress policy on, each streamable HTTP server the proxy would not let a job reach. A job reaches a host in
  `egress-allowlist.conf` on port 443, or exactly the host and port of a server declared in `model-endpoints.json`
  ([egress.md](egress.md)). Anything else is refused by the proxy, and so is an allowlisted host that is the proxy's
  own machine (`localhost`, `127.0.0.1`). Doctor reads the allowlist as the proxy does, one host per line. It does
  not look names up, so a name that resolves to the proxy's own machine reads as reachable here and is refused by
  the proxy.
- a server on a host and port declared in `model-endpoints.json` that no overlay model's `baseUrl` uses: doctor proves
  the route to it through the proxy, as for any declared endpoint, and passes it once anything answers there (an
  `https://` server closing the plain request included), without asking it to be a model server (`GET /v1/models`
  answering 200).
