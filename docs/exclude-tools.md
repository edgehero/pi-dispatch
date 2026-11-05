# Per-trigger exclusions (`run.excludeTools`, `run.excludeExtensionTools`, `run.excludeExtensions`)

Three keys narrow what one trigger's jobs have. `run.excludeTools` removes named built-in pi tools and a job's MCP tools,
`run.excludeExtensionTools` removes named tools an extension brings, and `run.excludeExtensions` keeps a staged package or an overlay
extension from loading at all. Read [what none of them stops](#what-exclusion-does-not-stop) before relying on one.

`run.excludeTools` is enforced by the session rather than asked for in prompt text. A triage trigger that excludes `bash`, `powershell`,
`edit` and `write` produces sessions that cannot run a shell or modify a file with pi's own tools, whatever the prompt says and whatever the issue text asks for.

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

`run.excludeTools` takes the built-in tools of the pinned pi: `read`, `bash`, `powershell`, `edit`, `write`,
`grep`, `find`, `ls`, and the tools a job's MCP servers bring (below). An extension's tools have
[their own key](#an-extensions-tools-runexcludeextensiontools), and what loads has
[another](#leaving-an-extension-out-runexcludeextensions). Any other name refuses when the file loads, and the refusal prints this whole set. That
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
pattern. The file refuses, ignoring case, the names of pi's own tools and a server's, which `run.excludeTools` removes (a server's beside `run.mcp`), and of tools
pi-dispatch gives some jobs (`report_progress`, `await_human_input`, `request_approval`, `subagent` and the rest). To remove a staged package's or an overlay
extension's tool of such a name, put that package's or extension's name in `run.excludeExtensions`, below.

pi removes these names from the session's tool registry, as it does for `run.excludeTools`. No extension can turn one back on, a
tool registered later stays out, and a name that matched nothing widens nothing. A role child and a chained child get the same
names, whole. This takes the tool and nothing else: the extension that brought it still loads, and its code still runs. To keep
that code from running, [leave the extension out](#leaving-an-extension-out-runexcludeextensions).

**A name no package or overlay extension brought.** A typo here cannot be caught when the file loads, because an extension's tools are known only once
it runs. So after the extensions load the runner compares each name with the tools a staged package or an overlay extension registered.
A repository's own tool of that name does not count, because this file is shared: counting it would stop only the repositories that lack the
tool, with no name to fix. The key still takes that repository's tool out of the session.

| The job | A name no staged package or overlay extension registered |
|---|---|
| Nothing was held back from it: no `"packages": false`, no `run.excludeExtensions`, this host's overlay open, no parent job, and every extension loaded | It stops before its prompt, as `exclude-tool-not-loaded` |
| Anything else: the tool may be in what it did not load, so the name may be right | It runs. The job log says `exclude_tools_unmatched`, and its record names the tool (`loaded.tools.unmatched`) |

A correct name can stop a job too, in four ways, so read the reason before fixing the spelling. A package that brings the tool and is
missing on this one host stops that host's jobs. A tool an extension registers after it loads stops the job on every host, since the check reads
what was registered when they loaded: the way out is to leave that extension out with `run.excludeExtensions`, which removes it
and turns this check off. A name only a repository registers stops every job the first row above describes, on that repository too: take the name off this key. A package canary stops
when its candidate no longer brings the tool, which is what the canary found.

**What a stop costs.** The agent never starts, and the container did. An extension that calls a model while it loads is metered like
any call, and that money is spent. A dollar reservation settles to what the job's exit line reports when the worker trusts that line and the job
has a cost cap: $0 if no call was made, and what the calls cost if the line holds their usage. Otherwise at least the reservation stands. The job-count slot stays held. A
forge job gets a comment, and `PI_ON_FAILURE` fires. It is not retried.

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

`run.excludeExtensions` and `"packages": false` stop what a job loads on its own. `run.excludeExtensionTools` and `run.excludeTools`
take tools out of the session and stop nothing from loading: an extension one of its tools was taken from still loads, and its code still
runs. None of the four keeps code away from an agent that can write or edit files, or run commands, and they have other limits:

- **Such an agent can bring code back.** pi's `write` and `edit` tools take any path, and `~/.pi/agent/` is
  writable in the image (0777, so that a job can run as any uid). So `write` alone, with no shell, reaches `~/.pi/agent/settings.json`
  and `~/.pi/agent/extensions/`. A role child started after that reads both, so it loads an excluded overlay extension or package, or
  the repository's extensions, or runs code the agent wrote there. `edit` alone needs a file that is already there, and a role child's own start creates
  `~/.pi/agent/auth.json`: a key in it that starts with `!` is a command, which the next child runs when it reads that key. Removing `bash` is not enough,
  and neither is removing `bash`, `powershell` and `write`. A trigger that must keep code away from its agent removes the tools that run commands, write files
  and edit them (`bash`, `powershell`, `write`, `edit`), which closes these routes as long as no extension or server the job keeps brings a tool that does the same.
- **An excluded file stays readable.** The overlay is mounted read-only and whole (`/opt/pi-global`), so an excluded extension's or
  package's files are still there for `read` to open.
- **A third-party subagent package's own child keeps everything.** The runner hands these lists only to its own `subagent` tool. A package
  that starts pi by itself passes on none of them, `run.excludeTools` included.
- **A person's re-run of a chained child starts a root job.** Re-run on the console queues the child's folder, flow and task, without its
  parent's `packages`, `run.excludeExtensions`, `run.excludeExtensionTools` or `run.excludeTools`.
- **A role child can end up with no tools.** An agent with `tools: [bash]`, on a trigger that removes `bash`, still starts, and has none.
- **An overlay manifest's entry outside its folder cannot be named.** A root `package.json` in `extensions/` may list `../outside.js`, and
  no name in `run.excludeExtensions` means it: it stays in the job while that manifest lists it.
- **A file directly in `extensions/` with a space in its name cannot be named.** `extensions/my ext.js` loads, and no name in `run.excludeExtensions` reaches it until it is renamed.
- **An extension baked into an image cannot be named.** pi finds one in `~/.pi/agent/extensions` by itself, which is where a derived image would put it. It is on neither
  list, so no name in `run.excludeExtensions` reaches it, and it stays loaded.
- **A kept extension can import an excluded file.** The name takes an entry off the list of what pi loads. It does not stop an `import`, so
  that module still runs.

## Versions and older hosts

A file that uses either key needs `"version": 2`. A writer that reads that version stamps it, and takes it away again when nothing needs it. A
job that carries either is stamped job data version 3 (a canary's stays at 2). Every host needs 5.0.0 or later before a file uses either, and once one does,
no 4.3.1 writer may touch the file ([what a fleet needs](upgrading.md#what-a-fleet-needs-before-a-trigger-leaves-something-out)): it keeps the keys and drops the stamp, as a hand edit can.

| A worker on | A file with either key and `"version": 2`, or a job with either | The same file with no stamp |
|---|---|---|
| A release from before 5.0.0, 4.3.1 among them | It publishes no version, reads the file, drops both keys and runs the job wider than the file says, on a clean record | The same |
| 5.0.0 or later | It runs the job as the file says | It refuses the file: `run.excludeExtensions needs triggers file version 2` |

The trigger's page refuses the change while a live worker reads less or publishes no version, and names it. It reads live workers alone, not receivers or stopped workers. A hand edit is not
stopped, and `pi-dispatch doctor` names such a host (`fleet.store-versions`).

An image without the `loadExclusions` capability is refused before any spend (`job-image-load-exclusions-unsupported`). Its runner would
not honour either key, and where it starts a role child that child gets no `--exclude-tools`, so a job with `run.excludeTools` is refused the same way where its
scope has a role map, even on a trigger that never starts a child. A job with none of that runs on such an image as it did.

## The file, or a person on the trigger's page

Like every `run.*` capability field: no panel key, no AI tool can set or widen it, and a chained
job's request file can neither set nor drop it. A person can change each of the three in the file or on the
[trigger's page](console.md#what-a-triggers-jobs-get): `run.excludeTools` and `run.excludeExtensionTools` with its tool chips, and
`run.excludeExtensions` with a switch per extension. One coming back is said as a widening before anything is written, and a name
every live host answers for and none holds is refused there. A chained child inherits its parent's `run.excludeTools` (less the
names of MCP tools: the child connects no MCP server), `run.excludeExtensions`, `run.excludeExtensionTools` and `"packages": false`,
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
| Console | a chip per tool and a switch per extension on the trigger's page, on meaning not removed or left out, for a person only ([what a trigger's jobs get](console.md#what-a-triggers-jobs-get)) |
| Chaining | inherited from the parent's job data, less MCP tool names; the request file cannot set or drop it; `run.excludeExtensions`, `run.excludeExtensionTools` and `run.packages` are inherited whole |
| Role children | `run.excludeTools` and `run.excludeExtensionTools` on each child's command line (`--exclude-tools`), which beats an agent's own `tools` |
| Version floor | worker 2.0.0, receiver 2.0.0, admin 2.0.0, plus the 2.0.0 job image (`ghcr.io/edgehero/pi-job:2.0.0`) or one rebuilt from the same tree |
| `run.excludeExtensionTools` | up to 16 exact tool names, any trigger kind but a watch rule; pi's, a server's and those of tools pi-dispatch gives some jobs are refused at load; a name no staged package or overlay extension registered stops a job that held nothing back (`exclude-tool-not-loaded`), and is logged and recorded on any other; its extension's code still runs |
| `run.excludeExtensions` | up to 16 names of staged packages (manifest name) or overlay extensions (file stem, whole file name or folder), any trigger kind but a watch rule; a name not on this host is recorded and doctor warns |
| Both, on an older host or image | the file at version 2 and job data at version 3, which 5.0.0 is the first release to read: a worker from before it drops both and runs wider, stamped or not, so every host reads both first; an older image is refused (`job-image-load-exclusions-unsupported`), and so is a job with `run.excludeTools` and a role map |
| Related | [job image](job-image.md), [global pi overlay](global-pi-overlay.md), [workflows](workflows.md) |
