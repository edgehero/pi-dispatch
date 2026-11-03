The trigger page's **What its jobs get**: what a job of this trigger would start with now, on each host it runs on, and every part of it changed in place. Today the page lists each run field as written, beside the deployment default, and most are changed by hand in the triggers file.

**How a person uses it.**
- **The hosts** come first: one pill per host the trigger runs on, saying whether its jobs get the same there. Here build3's overlay adds git-guard.
- **One row per kind,** each with its control and, under it, what the last run had (#800's record):
  - **Model:** a picker of the catalog's models, the job cap, the allowed models and the fallbacks.
  - **Flow and skills:** a picker of the skills a job can find (the repository's, the overlay's, a staged package's, the skills folder's), with a warning when a repository lacks the flow. The other skills it loads are listed.
  - **Extensions:** a switch per staged package and per overlay extension, saying where each is and what it brings. The repository's own are shown, locked: they are merge-gated content, changed in the repository.
  - **MCP servers:** a switch per server the overlay's `mcp.json` defines, with its transport, host, codemode and the key it uses by name, and which hosts have it.
  - **Tools:** a chip per tool: pi's own, each extension's (named from the last run's record), and each server's.
  - **Image and secrets:** shown, and changed where they are today (the file, the Secrets page).
- **Changes collect** in one bar (*2 changes, not written yet*) with **Preview the change** and **Discard**. TriggerEnvironmentChange draws the preview.

**Panels.** `p-trigger-gets`, `p-trigger-gets-how`, beside TriggerDetail's panels.

**The server provides.**
- **Today:** the trigger's fields and the deployment defaults; each host's staged packages and overlay (the doctor record and Updates' host records); the overlay's MCP servers (Connections); doctor's per-host flow check (`REQ-PER-TRIGGER-SKILLS`); the catalog and each model's first-call bound (Models).
- **From #800:** the last run's record, for what loaded and the names of each extension's tools.
- **New fields, each a narrowing:** `run.excludeExtensions` (staged packages and overlay extensions by name; `"packages": false` stays the all-off switch) and extension tools in the exclusions, checked by the runner against what loaded, so a name that matches nothing refuses the job before its first model call rather than doing nothing.
- **A person-only write** through the trigger edit's planner: the fields that decide what jobs spend or reach (`run.models`, `run.fallbackModels`, `run.mcp`, `run.maxCostUsd`) stay out of every tool's reach.

**Who sees what.** An operator changes it. A viewer sees the rows without controls (TriggerEnvironmentChange). No tool or agent can make the change.

**Why it works this way.**
- **What a job gets, not what the file says.** "packages: load" means different things on different hosts; the card says which.
- **Switches that only narrow, plus pickers from what exists.** Turning something off is always available; turning something on picks from what is staged, defined or in the catalog. New code arrives through Updates, never through a trigger.
- **One preview for every change,** so a widening (an MCP server and its key) and its side effects (a job in line refused as `trigger-skew`) are read before anything is written.
- **The last run under each row,** so a setting and what it did sit together.

**Fixture note.** Trigger 3, its hosts, gh-9575, gh-03a9, gh-77c1 and the model are the fixture. linear and docs are Connections' MCP servers, and pi-lint and pi-test-runner its staged packages. Sample: git-guard in build3's overlay (as on ProjectLoads), the extension tools' names, docs on mini1 only, and the model choices.
