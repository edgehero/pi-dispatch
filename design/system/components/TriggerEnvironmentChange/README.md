The preview and Confirm of a change to what a trigger's jobs get, what the card refuses and why, and what a viewer sees.

**How a person uses it.**
- **Preview** shows the triggers file's row as it would be written, and the `version` line a versioned field stamps on the file, then the Confirm:
  - each change in words, never an arrow, a widening said as one (*connect to mcp.example.com, with LINEAR_API_KEY by name*);
  - the jobs it affects: here adding `run.mcp` refuses gh-c9e1, waiting in line, as `trigger-skew`;
  - what the stamp does: *Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's.*
  - that every host's release reads the new fields;
  - what a host without the server does: refuses the job as `mcp-server-unknown`, before it spends. A host with no overlay, or no `mcp.json`, refuses it as `mcp-config-invalid`;
  - where it is written and how it is audited (`trigger-edit`, by the person).
  - **Undo** puts the trigger back as it was.
- **What it refuses, and why:** a server some hosts lack (said on the switch, before the preview), a model that cannot make one call under the cap, a cap above the deployment's, a file that changed since the page opened, a host on an older release, an exclusion that leaves no way to a server (`mcp-excluded`), an extension tool that matches nothing loaded (`exclude-tool-not-loaded`), and what belongs elsewhere.
- **As a viewer sees it:** the same six rows as the operator's, read only.

**Panels.** `p-trigger-gets-preview`, `p-trigger-gets-refuses`, `p-trigger-gets-viewer`.

**The server provides.** The trigger edit's planner and Confirm, widened to the card's fields for a person only. A digest of the file as the page read it is sent back and compared at preview, because the Confirm's own snapshot covers only preview to Confirm, and that is what refuses a stale page. The versions each live host publishes (#761, `INT-HOST-REGISTRY-CONTRACT`), since the first version row must not reach a host older than #761: such a host reads no version and drops a key it does not know, which for a narrowing runs the job wider on a clean record (`DES-STORE-VERSION-WHEN-NEEDED`). Each model's first-call bound, which only doctor computes today.

**Who sees what.** Operators preview and confirm. Viewers see the rows. Tools and agents cannot reach this action.

**Why it works this way.**
- **The boundary stays where it is.** `TOOL_PROOF_FIELDS` exist because which systems a job reaches and what it spends is the operator's to write. A person at the console is the operator; a model's call is not.
- **Refuse what would fail later, now.** A server missing on a host refuses at pickup, for free (`worker/src/processor.mjs`). A package that did not mount and a first call above the cap refuse later, inside the container (`image/runner/run-job.mjs`, `image/runner/src/usage-meter.mjs`). The preview says so first.
- **The cap's refusal says who can move it.** A trigger's `run.maxCostUsd` only lowers the deployment's cap, so "raise the cap" is not something this page can do: the sentence names the deployment's settings. It says *needs at least*, because the bound is a lower one.
- **The plain ring on a widening.** The console's Confirm is plain, paid or destructive (`previewBarHtml`), and it has no ring for a widening: raising a cap is plain today, and deleting a limit is destructive for having no way back. This change has its Undo, so the widening is said in words, with an attention glyph on its line.
- **An extension tool cannot be refused at load.** It registers at container start, so the worker's loader cannot know the name. Refused before its prompt is sent, so the task spends no tokens. An extension that called a model while loading may already have spent, and that stays metered.
- **The stamp is said out loud.** A versioned field raises the version of the whole file, so its reach is wider than the one trigger being changed.

**Fixture note.** Trigger 3, gh-c9e1 (its one job in line, as on TriggerDetail), the hosts and the cap are the fixture. $2.62 is `firstCallFloorMicros` at the pinned pi 1.5.0 for anthropic / claude-opus-5-5: 2,621,440 micro-dollars, 128,000 output tokens at $20 a million and 12,288 tokens of input at $5 a million. The Confirm draws the state where the preview passes, which assumes every host runs a release that reads version 2. Fleet draws them on 4.3.1, where the older-host refusal stands instead. The diff draws each array as three lines, as `JSON.stringify` writes them. Sample: the instructions line's place in the row, and the rest as on TriggerEnvironment.
