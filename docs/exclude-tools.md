# Per-trigger tool exclusion (`run.excludeTools`)

Remove named built-in pi tools from one trigger's jobs, enforced by the session rather than asked for
in prompt text. A triage trigger that excludes `bash`, `edit` and `write` produces sessions that
cannot run a shell or modify a file, whatever the prompt says and whatever the issue text asks for.

```jsonc
{ "on": { "type": "comment", "phrase": "@pi" },
  "run": { "kind": "forgejo", "flow": "triage", "excludeTools": ["bash", "edit", "write"] } }
```

This is the first enforced in-container permission in pi-dispatch. Everything else the guardrails say
about behaviour is prompt text, and the README discloses exactly that; this field is different because
pi itself applies it: the excluded tools are filtered out of the session's tool registry at
construction, so they are not merely inactive, they are absent. An extension calling
`setActiveTools`, a later refresh, or the model asking nicely cannot bring one back. Every job that
carries exclusions logs a `tools_excluded` line with the tool list read back from the live session,
so the enforcement is visible in the job log, not taken on faith.

## What you can exclude

The built-in tools of the pinned pi, and nothing else: `read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls`. Any other name refuses when the file loads, and the refusal prints this whole set. That
strictness is not pedantry: pi silently ignores unknown names in its exclusion list, so a misspelled
`"Bash"` would exclude nothing while your file reads as though it did. A field that can be quietly
wrong about a permission is worse than no field, so the loader refuses what pi would ignore.

One nuance worth knowing: at the pinned version only `read`, `bash`, `edit` and `write` are ACTIVE by
default; `grep`, `find` and `ls` are registered but inactive until something activates them.
Excluding an inactive tool still matters, because the exclusion removes it from the registry, so
nothing in the job can activate it later. Excluding all seven is legal and yields an agent with no
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
- **Extension and custom tools are not excludable.** Staged packages and a serviced repo's own
  `.pi/extensions` register their tools at container start, so the loader cannot validate their
  names, and free strings would reopen the silent no-op above. A genuinely read-only trigger
  therefore also wants `"packages": false`, and a repo whose own extensions you trust or have
  reviewed.
- **It is per trigger, not per deployment.** Other triggers' jobs keep the full set.

## File only

Like every `run.*` capability field: no panel key, no AI tool can set or widen it, and a chained
job's request file can neither set nor drop it. A chained child inherits its parent's exclusions,
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
| Known names | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (the pinned pi's built-ins) |
| Refused at load | any name outside the known set, an empty array, a duplicate, a non-string member, near-miss spellings of the field itself, `run.tools`, `run.noTools`, `on.excludeTools` |
| Refused pre-spend | `job-image-exclude-tools-unsupported` (image lacks the `excludeTools` capability token); in-container exit 2 on a name the baked pi does not know (version skew, hand-run containers) |
| Observability | `tools_excluded` log line on every flagged job: the requested exclusions and the session's active tool list read back |
| Panel | the trigger drill-in's `excludeTools` row beside `image` (`full pinned tool set` when absent); no panel key, no AI tool |
| Chaining | inherited from the parent's job data; the request file cannot set or drop it |
| Version floor | unreleased at the time of writing: the first releases after worker 1.10.3 / receiver 1.5.0 / admin 1.10.2, plus a job image rebuilt from the same tree |
| Related | [job image](job-image.md), [global pi overlay](global-pi-overlay.md), [workflows](workflows.md) |
