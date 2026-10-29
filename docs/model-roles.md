# Model roles

A model role is a reviewed name such as `planner`, `editor` or `explorer`. Triggers select the name;
the operator maps it to a physical model in `triggers.json`:

```json
{
  "modelRoles": {
    "default": {
      "planner": "anthropic/claude-opus-5-5",
      "editor": "anthropic/claude-sonnet-5-5",
      "explorer": "anthropic/claude-haiku-5-5"
    },
    "shop": {
      "editor": "openai/gpt-6.1"
    }
  },
  "triggers": []
}
```

Replace the example model references with models present in your pinned catalog or operator overlay.
A trigger's `run.model: "role:editor"` resolves at pickup. The worker reads the map again on the next
delivery, so changing the map changes every new job of that role without editing the triggers. A
project's entries override default entries by role; unmentioned default roles remain available.
An explicit `run.provider` must agree with the mapped provider. Prefer leaving it absent for a role
that may move between providers. The main provider uses the normal credential resolution. A child
using another provider still needs that provider's credential explicitly made available through the
deployment's existing forwarding or secret configuration; a role map does not grant extra credentials.

Role names start with a lowercase letter and contain at most 32 lowercase letters, digits, underscores
or dashes. `inherit`, `constructor` and `prototype` are reserved. There are at most 128 map rows,
16 roles per row and 16 models in a job's expanded allowed list. A reference is `provider/model`, with
each half following the normal model/provider identifier limits. Unknown role-object fields and
ambiguous case duplicates refuse. No model-callable tool can write this policy. Unrelated console
trigger edits preserve it.

The worker adds mapped models and role fallbacks to the job's reviewed allowed ceiling. An existing
allowed list still has to authorize a literal main model; declaring unrelated roles does not add an
otherwise unlisted main model. Unknown models, unknown roles, provider conflicts and list overflow
refuse before token minting, cloning and spend reservation. A broken save retains the last validated
map and logs `model_roles_last_good`; a malformed first read refuses, and a transient read failure
without a validated map retries.

## Reviewed fallback models

A role can declare ordered fallback candidates:

```json
{
  "modelRoles": {
    "default": {
      "editor": {
        "model": "provider/primary",
        "fallbackModels": ["provider/secondary"]
      }
    }
  },
  "triggers": []
}
```

Declare fallbacks on the role or the trigger, never both. The existing failover checks select one
physical model before paid work. Its executable allowed list is a singleton, including child calls.
A subagent role mapped to another model is refused locally before its child starts. The role map
cannot widen that selected singleton. A recovery keeps its checkpoint's physical main model and
revalidates current policy; removing the role or excluding that model can refuse recovery.
A chained job resolves its inherited authored `role:` reference against the map at its own pickup.

## Repository agents

With a role map, the worker stages the repository's `.pi/agents/*.md` from the prepared base commit.
These are committed blob contents, never agent-written worktree files or symlink targets. Agent
frontmatter contains a bounded `name`, `description`, optional `tools` and optional `model`:

```markdown
---
name: scout
description: Locate relevant code and tests
tools: [read, grep, find, ls]
model: explorer
---
Find the files relevant to the requested task and explain what they do.
```

A bare role or `role:explorer` resolves through the job's immutable map. `inherit`, or omitting
`model`, uses the parent's current model and thinking level. A literal `provider/model` must be on
the executable allowed list. Explicit role or literal model selection does not inherit thinking.
Malformed definitions refuse before budget reservation. The image must declare `modelRoles` support;
older images are refused before token minting and cloning. The first-party tool is enabled only when
the worker stages role inputs, preserving the existing tool set for deployments without mappings.

The `subagent` tool accepts one of these forms:

```json
{"agent":"scout","task":"Find the worker model gates"}
```

```json
{"tasks":[{"agent":"scout","task":"Find tests"},{"agent":"scout","task":"Find specs"}]}
```

```json
{"chain":[{"agent":"scout","task":"Find code"},{"agent":"scout","task":"Check this result: {previous}"}]}
```

Parallel batches allow at most four tasks; chains allow at most sixteen. The complete batch's agent
names and models are checked before any child starts. A chain stops on a failed result. Children use
the existing parent model policy, token accounting and dollar guards. This does not enable pi's
experimental virtual-model routing or add the inline subagent tool recursively to child sessions.

An unknown agent, unknown role or off-list model returns a named tool error before child startup;
the parent can continue. Raw names remain in tool output and the transcript. Authenticated history
holds the physical model, validated role identity and up to eight refusal rows containing only an
agent-name SHA-256 hash and fixed reason. Run details show the role and refusal count.

Use [model proposals](model-proposals.md) and a capped canary to evaluate a candidate before editing
the reviewed role map. Proposals never adopt a model or change endpoints automatically.
