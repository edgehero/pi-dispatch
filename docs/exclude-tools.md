# Per-trigger exclusions (`run.excludeTools`, `run.excludeExtensionTools`, `run.excludeExtensions`)

Remove named built-in pi tools from one trigger's jobs, enforced by the session rather than asked for
in prompt text. A triage trigger that excludes `bash`, `edit` and `write` produces sessions that
cannot run a shell or modify a file, whatever the prompt says and whatever the issue text asks for.

```jsonc
{ "on": { "type": "comment", "phrase": "@pi" },
  "run": { "kind": "forgejo", "flow": "triage", "excludeTools": ["bash", "powershell", "edit", "write"] } }
```

This is the first enforced in-container permission in pi-dispatch. Everything else the guardrails say
about behaviour is prompt text, and the README discloses exactly that; this field is different because
pi itself applies it: the excluded tools are filtered out of the session's tool registry at
construction, so they are not merely inactive, they are absent. An extension calling
`setActiveTools`, a later refresh, or the model asking nicely cannot bring one back. Every job that
carries exclusions logs a `tools_excluded` line with the tool list read back from the live session,
so the enforcement is visible in the job log, not taken on faith.

A role child (the job's `subagent` tool, [model-roles.md](model-roles.md)) loses the same tools: it runs pi's own
CLI, which reads no job setting, so the runner puts the list on the child's command line, and it beats the agent's
own `tools`. An agent that lists `read` and `bash` gets `read` on a trigger that removes `bash`.

## What you can exclude

The built-in tools of the pinned pi, and nothing else: `read`, `bash`, `powershell`, `edit`, `write`,
`grep`, `find`, `ls`. Any other name refuses when the file loads, and the refusal prints this whole set. That
strictness is not pedantry: pi silently ignores unknown names in its exclusion list, so a misspelled
`"Bash"` would exclude nothing while your file reads as though it did. A field that can be quietly
wrong about a permission is worse than no field, so the loader refuses what pi would ignore.

Since pi 1.0.4, pi's own exclusion list also takes `*` patterns (`mcp__*`). This field takes one kind only,
below; any other pattern is not a built-in tool name, so it is refused like a misspelling. Name each tool.

A trigger that names MCP servers (`run.mcp`, [mcp.md](mcp.md)) may also exclude the tools its job's MCP brings:
`codemode`, `tool_search`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, and one
server's tools as a whole as `mcp__<server>__*` (the server's name with `-` written as `_`, as pi writes it). A
single tool of a server is not excludable here: its name is not known until the server lists it, so a misspelled
one would exclude nothing. Hide it in the overlay instead (`toolExposure`). The pickup refuses a job whose
exclusions take away a server's last way in (`mcp-excluded`), routed as pi routes it: a `direct` tool needs
nothing; a `codemode` or `deferred` tool is reached by whichever discovery tool is active (codemode calls both kinds,
`tool_search` loads both); resources go through `read_mcp_resource`, which reads any server's and is reached the
widest way any of them is. A server is assumed to have resources until it connects, so one with none, whose tools
you exclude, still connects (to no use). So
excluding `codemode` refuses a job whose servers are all codemode-exposed, and not one that also has a deferred
server, whose `tool_search` reaches them all.

One nuance worth knowing: at the pinned version only `read`, `bash`, `edit` and `write` are ACTIVE by
default; `powershell`, `grep`, `find` and `ls` are registered but inactive until something activates them.
Excluding an inactive tool still matters, because the exclusion removes it from the registry, so
nothing in the job can activate it later. A trigger that means "no shell" names `powershell` beside
`bash`. Excluding all eight is legal and yields an agent with no
built-in tools at all (extension tools, where loaded, still work).

Narrowing only. There is no `run.tools` allowlist, deliberately: an allowlist answers "which tools
exist", which is the pinned pi's answer and moves with every version bump, so a bump that added a
tool would silently grant it to every allowlisted trigger. Naming what to take away cannot widen on a
bump. `run.noTools` (pi's other tool switch) is refused by name for the same reason a misspelling is.

## What this does not do

Be precise about the boundary before relying on it:

- **It removes pi tools, not container capabilities.** Excluding `bash` removes the agent's shell
  TOOL; the container still contains a shell, and the isolation flags are unchanged (they were the
  worker's own `docker run` argv all along, see [`docs/job-image.md`](job-image.md)).
- **`run.excludeTools` takes pi's tools and a job's MCP tools, and no other.** Staged packages and a serviced
  repo's own `.pi/extensions` register their tools at container start, so the loader cannot validate
  their names, and free strings here would reopen the silent no-op above. An extension's tools have
  [their own key](#an-extensions-tools-runexcludeextensiontools), whose check is the runner's. A genuinely
  read-only trigger still wants `"packages": false`, or each extension it does not want left out by name,
  and a repo whose own extensions you trust or have reviewed.
- **It is per trigger, not per deployment.** Other triggers' jobs keep the full set.

## An extension's tools (`run.excludeExtensionTools`)

```jsonc
{ "on": { "type": "comment", "phrase": "@pi" },
  "run": { "kind": "github", "flow": "triage", "excludeExtensionTools": ["deploy_preview"] } }
```

Each entry is a tool's exact name: a letter, then letters, digits, `_` or `-`, at most 48 characters, and at most 16 names. No
pattern. The file refuses pi's own tools and a server's, which belong on `run.excludeTools`. It also refuses a tool the job itself
offers (`report_progress`, `await_human_input`, `request_approval`, `subagent` and the rest), because another run field arms those:
to remove another extension's tool of such a name, leave that extension out below.

pi removes these names from the session's tool registry, as it does for `run.excludeTools`. No extension can turn one back on, a
tool registered later stays out, and a name that matched nothing widens nothing. A role child and a chained child get the same
names, whole.

**A name that matched nothing.** A typo here cannot be caught when the file loads, because an extension's tools are known only once
it runs. So after the extensions load the runner asks pi what they registered:

| The job | A name nothing registered |
|---|---|
| Nothing was held back from it: no `"packages": false`, no `run.excludeExtensions`, this host's overlay open, no parent job, and every extension loaded | It stops before its prompt, as `exclude-tool-not-loaded` |
| Anything else: the tool may be in what it did not load, so the name may be right | It runs. The job log says `exclude_tools_unmatched`, and its record names the tool (`loaded.tools.unmatched`) |

Two correct names stop a job too, so read the reason before fixing the spelling. A package that brings the tool and is missing on
this one host stops that host's jobs. A tool an extension registers after it loads stops the job on every host, since the check reads
what was registered when they loaded: the way out is to leave that extension out with `run.excludeExtensions`, which removes it
and turns this check off.

**What a stop costs.** The agent never starts, and the container did. An extension that calls a model while it loads is metered like
any call, and that money is spent. A dollar reservation settles to what the job's exit line reports, down to $0 only when the worker
trusts that line, the job has a cost cap and no call was made; otherwise the reservation stands. The job-count slot stays held. The
forge gets a comment and `PI_ON_FAILURE` fires. It is not retried.

## Leaving an extension out (`run.excludeExtensions`)

```jsonc
{ "on": { "type": "comment", "phrase": "@pi" },
  "run": { "kind": "github", "flow": "triage", "excludeExtensions": ["@acme/deploy-tools", "git-guard"] } }
```

A staged package by its manifest name, or an overlay extension by its file stem or folder name (`git-guard` for
`extensions/git-guard.ts`). The whole file name also works, since that is how a run's record spells it. A name means every extension
of that name, so a package and an overlay entry that share one both go. At most 16 names.

- **A package** is left out of what the worker hands the job, so its extensions, skills, prompts and themes all go, and a flow that
  lived in it reads as found nowhere.
- **An overlay entry** is taken off the list before pi imports anything, so neither its module nor its factory runs.
- **A repository's own `.pi/extensions`** is on neither list and still loads ([global pi overlay](global-pi-overlay.md)). The
  overlay's `skills/` and `prompts/` are not extensions and still load.

**A name not on this host is not a refusal.** Each host has its own overlay and stage and they share this file, so nothing loads for
it there. The run's record says so (`loaded.leftOut.extensionsNotHere`), and `pi-dispatch doctor` warns: a misspelled name keeps
nothing out on a host that has the real one.

Some jobs need what you leave out, and those are refused for free, before anything is reserved. A job on a subscription connection
whose adapter is excluded is refused as `auth-adapter-disabled`, and a package canary of an excluded package as
`package-canary-excluded`.

## What exclusion does not stop

Both of these keys stop what a job loads on its own, not what an agent can reach. An agent with a shell can write
`~/.pi/agent/settings.json`, and a later role child then loads an excluded overlay extension or package, or the repository's
extensions. That is the same boundary `"packages": false` has. A trigger that must keep code away from the agent also removes its
shell.

## Versions and older hosts

A file that uses either key needs `"version": 2`, which every writer stamps and takes away again when nothing needs it, and a job
that carries either is stamped too. A host that reads less waits on every job (`newer-release`) rather than running them wider.
A worker from before issue #761 reads no `version` and drops both keys, so every host runs a release with #761 before a file uses
them, and `pi-dispatch doctor` names one that does not (`fleet.store-versions`). Written by hand with no stamp, the file refuses to
load. An image without the `loadExclusions` capability is refused before any spend (`job-image-load-exclusions-unsupported`), because
its runner would ignore both keys.

## The file, or a person on the trigger's page

Like every `run.*` capability field: no panel key, no AI tool can set or widen it, and a chained
job's request file can neither set nor drop it. A person can change `run.excludeTools` in the file, or with the tool chips on the
[trigger's page](console.md#what-a-triggers-jobs-get), where a tool back on is said as a widening before anything is written. The
other two are the file's. A chained child inherits its parent's exclusions (less the
names of MCP tools in `run.excludeTools`: the child connects no MCP server),
because the dangerous direction here is inverted from the other inherited fields: dropping the
inheritance would hand a read-only parent a child that can edit and run bash.

## The stale-image refusal

The exclusions ride the container environment as `PI_EXCLUDE_TOOLS`, and only a runner built with
this feature reads that variable. An older image would ignore it and run your "read-only" trigger
with every tool you removed, recording a clean exit. So the job image declares the `excludeTools`
capability in its `dev.pi-dispatch.capabilities` label (the shipped image does), and the worker
refuses a job carrying exclusions on an image without it, before any token is minted or budget
reserved: `job-image-exclude-tools-unsupported`, with a comment naming the fix. Rebuild your image
from a current tree and the refusal disappears.

## Reference

| Piece | Value |
|---|---|
| Field | `run.excludeTools`, a non-empty array of built-in pi tool names, any trigger kind (cron included) |
| Known names | `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` (the pinned pi's built-ins) |
| Refused at load | any name outside the known set, an empty array, a duplicate, a non-string member, near-miss spellings of the field itself, `run.tools`, `run.noTools`, `on.excludeTools` |
| Refused pre-spend | `job-image-exclude-tools-unsupported` (image lacks the `excludeTools` capability token); in-container exit 2 on a name the baked pi does not know (version skew, hand-run containers) |
| Observability | `tools_excluded` log line on every flagged job: the requested exclusions and the session's active tool list read back |
| Panel | the trigger drill-in's `excludeTools` row beside `image` (`full pinned tool set` when absent); no panel key, no AI tool |
| Console | a chip per tool on the trigger's page, on meaning not removed, for a person only ([what a trigger's jobs get](console.md#what-a-triggers-jobs-get)) |
| Chaining | inherited from the parent's job data, less MCP tool names; the request file cannot set or drop it |
| Role children | the same list on each child's command line (`--exclude-tools`), which beats an agent's own `tools` |
| Version floor | worker 2.0.0, receiver 2.0.0, admin 2.0.0, plus the 2.0.0 job image (`ghcr.io/edgehero/pi-job:2.0.0`) or one rebuilt from the same tree |
| `run.excludeExtensionTools` | up to 16 exact tool names, any trigger kind but a watch rule; pi's, a server's and the job's own are refused at load; a name that matched nothing stops a job that held nothing back (`exclude-tool-not-loaded`), and is logged and recorded on any other |
| `run.excludeExtensions` | up to 16 names of staged packages (manifest name) or overlay extensions (file stem, whole file name or folder), any trigger kind but a watch rule; a name not on this host is recorded and doctor warns |
| Both, on an older host or image | file and job data at version 2, so an older worker waits (`newer-release`); an older image is refused (`job-image-load-exclusions-unsupported`) |
| Related | [job image](job-image.md), [global pi overlay](global-pi-overlay.md), [workflows](workflows.md) |
